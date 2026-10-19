'use strict';
// ============ 权限网关（Policy Gateway）============
// 安全的核心：
// 1. 每个 API 动作注册权限级别 P0-P3，硬编码策略表，LLM 无权决定
// 2. Agent 发起的请求必须携带有效的一次性授权单（approval）
// 3. 授权单与参数「服务端 HMAC 签名」绑定：换金额/收款人即失效，用过即作废
// 4. 全部动作写审计日志，且前后条以哈希链相连，静默篡改一条即被检出
//
// 拦截分层（供产品侧拦截卡展示"被谁拦的"）：
//   数据隔离层 —— 不可信数据在进入指令层之前被拦（见 lib/injection.js）
//   权限层     —— 动作超出 P 级策略，Agent 永久无权（本文件 POLICY）
//   校验层     —— 授权单签名/时效/凭证校验不通过（本文件 confirmAndExecute）

const { signParams, verifyParams, fingerprint, uid, smsCode, yuan, chainHash, auditPayload, canonical } = require('./util');
const { validateParams } = require('./params');
const limits = require('./limits');
const store = require('./store');
const lock = require('./lock');

// 拦截分层（供产品侧拦截卡展示"被谁拦的"）：
//   数据隔离层   —— 不可信数据在进入指令层之前被拦（lib/injection.js）
//   收款人解析层 —— 代称无法可靠落到一个已验证的联系人（lib/contacts.js）
//   权限层       —— 动作超出 P 级策略，Agent 永久无权（POLICY）
//   校验层       —— 授权单签名/时效/凭证校验不通过
const LAYER = { DATA: '数据隔离层', RESOLVE: '收款人解析层', POLICY: '权限层', VERIFY: '校验层' };

// 单张授权单允许的验证失败次数（支付密码与验证码共用计数，防"两种各试几次"绕过）
const MAX_ATTEMPTS = 3;

// ---- 权限级别 ----
// P0 只读查询：登录态即可
// P1 低敏写：一次性确认
// P2 资金操作：支付密码 + 短信验证码 + 确认
// P3 禁止区：Agent 永远无权（仅用户本人在 App 内凭支付密码操作）
const POLICY = {
  'query.balance':        { level: 0, desc: '查询余额' },
  'query.bills':          { level: 0, desc: '查询账单' },
  'query.holdings':       { level: 0, desc: '查询持仓' },
  'query.products':       { level: 0, desc: '查询产品' },
  'scheduled.create':     { level: 1, desc: '创建定时转账' },
  'scheduled.cancel':     { level: 1, desc: '取消定时转账' },
  'aa.create':            { level: 1, desc: '发起 AA 收款' },
  'card.freeze':          { level: 1, desc: '冻结银行卡' },
  'card.unfreeze':        { level: 1, desc: '解冻银行卡' },
  'card.setDefault':      { level: 1, desc: '设置默认卡' },
  'card.add':             { level: 1, desc: '绑卡' },
  'transfer.execute':     { level: 2, desc: '转账' },
  'aa.pay':               { level: 2, desc: 'AA 付款' },
  'wealth.subscribe':     { level: 2, desc: '理财申购' },
  'wealth.redeem':        { level: 2, desc: '理财赎回' },
  'card.remove':          { level: 3, desc: '解绑银行卡（禁止区）' },
  'paypass.change':       { level: 3, desc: '修改支付密码（禁止区）' },
  'phone.unbind':         { level: 3, desc: '解绑手机号（禁止区）' },
  'security.disable':     { level: 3, desc: '关闭安全策略（禁止区）' }
};

const APPROVAL_TTL = 5 * 60 * 1000; // 授权单 5 分钟有效

// ---- 审计（哈希链）----
// 每条记录 prev_hash（上一条的 hash）与 hash（本条内容的 HMAC），
// 篡改任意一条后，后续所有 hash 都对不上，完整性校验立刻报错。
function audit(userId, actor, action, detail, result, note, layer) {
  const db = store.get();
  const log = {
    id: db.nextIds.audit++,
    ref: 'A' + String(db.nextIds.audit - 1).padStart(4, '0'),
    t: Date.now(), userId, actor, action, detail, result,
    note: note || '', layer: layer || null,
    prev_hash: db.auditChainHead || 'GENESIS'
  };
  log.hash = chainHash(log.prev_hash === 'GENESIS' ? null : log.prev_hash, auditPayload(log));
  db.auditLogs.push(log);
  db.auditChainHead = log.hash;
  // U-41 分级保留：审计日志不能被"用常规事件刷爆"的方式挤掉安全关键事件。
  // 超限时关键事件（拦截/篡改/注入/暂停）优先全留，常规事件只留最近 800 条。
  // 裁剪后链内仍自洽：最早保留的一条 prev_hash 指向已被裁剪的前驱，verifyAuditChain 允许这种情况。
  if (db.auditLogs.length > 2000) {
    const CRITICAL = new Set(['INJECTED_BLOCKED', 'BLOCKED', 'tampered', 'PAUSED']);
    const critical = db.auditLogs.filter(l => CRITICAL.has(l.result)).slice(-1200);
    const normal = db.auditLogs.filter(l => !CRITICAL.has(l.result)).slice(-800);
    db.auditLogs = critical.concat(normal).sort((a, b) => a.id - b.id);
  }
  store.save();
  return log;
}

// ---- 审计链完整性自校验 ----
function verifyAuditChain() {
  const db = store.get();
  const logs = db.auditLogs;
  let broken = null;
  for (let i = 0; i < logs.length; i++) {
    const l = logs[i];
    // ① 逐条重算 hash：内容被改 → 对不上
    const expect = chainHash(l.prev_hash === 'GENESIS' ? null : l.prev_hash, auditPayload(l));
    if (expect !== l.hash) { broken = { ref: l.ref, id: l.id, reason: '条目内容与哈希不符（疑似篡改）' }; break; }
    // ② 链式衔接：本条 prev_hash 必须等于上一条 hash
    if (i > 0 && l.prev_hash !== logs[i - 1].hash) { broken = { ref: l.ref, id: l.id, reason: '与前一条的链接断裂' }; break; }
  }
  return {
    ok: !broken,
    count: logs.length,
    head: db.auditChainHead,
    brokenAt: broken
  };
}

// ---- 统计：今日拦截次数（供安全驾驶舱）----
function blockedTodayCount(userId) {
  const db = store.get();
  const today = new Date().toISOString().slice(0, 10);
  const BLOCKED = ['BLOCKED', 'INJECTED_BLOCKED', 'REJECTED', 'tampered', 'PAUSED'];
  return db.auditLogs.filter(l =>
    l.userId === userId &&
    BLOCKED.includes(l.result) &&
    new Date(l.t).toISOString().slice(0, 10) === today
  ).length;
}

// ---- 统一的拦截返回（带「拦截层 + 审计编号」）----
function blocked(layer, message, log) {
  return { ok: false, blocked: true, layer, message, ref: log ? '#' + log.ref : null, auditId: log ? log.id : null };
}

// ---- 创建授权单（Agent 或用户发起）----
// 资源型动作的「默认对象」回填。
// LLM 往往只给动作、不给具体资源 ID（例如「冻结我的卡」不会说出卡 ID）。
// 建单前用本人默认卡片 / 最大持仓补全，使授权单直接绑定具体资源：
// 既保住 U-28/29 的必填校验（不是放宽 schema），又让 HMAC 参数指纹覆盖到资源 ID，
// 比原来「执行时再找一张卡」更安全。一个都没有时不补，由 schema 如实报缺参。
function fillResourceDefaults(user, action, params) {
  const p = params || {};
  const db = store.get();
  // 注意用真值判断：LLM 常返回 {"cardId": ""} 这种「字段在、值为空」的形状，
  // 只判 null/undefined 会让空串漏过默认值回填。显式传了具体 ID 则不覆盖，
  // 非法 ID 仍交由 schema / 执行层拒绝。
  if (!p.cardId && /^card\.(freeze|unfreeze|setDefault|remove)$/.test(action)) {
    const cards = db.cards.filter(c => c.userId === user.id);
    if (cards.length) p.cardId = (cards.find(c => c.isDefault) || cards[0]).id;
  }
  if (!p.holdingId && action === 'wealth.redeem') {
    const hs = db.holdings.filter(h => h.userId === user.id);
    if (hs.length) p.holdingId = hs.slice().sort((a, b) => b.amount - a.amount)[0].id;
  }
  return p;
}

function createApproval(user, actor, action, params, opts) {
  const db = store.get();
  const o = opts || {};
  const policy = POLICY[action];
  if (!policy) {
    const log = audit(user.id, 'gateway', action || 'unknown', params, 'BLOCKED', '动作不在权限策略表中，一律拒绝（白名单外动作）', LAYER.POLICY);
    return blocked(LAYER.POLICY, '未注册的操作（不在权限白名单内）', log);
  }

  // P3 禁止区：Agent 发起直接拦截，写入审计
  if (policy.level === 3 && actor === 'agent') {
    const log = audit(user.id, 'gateway', action, params, 'BLOCKED',
      `Agent 尝试执行 P3 禁止操作「${policy.desc}」，已被权限网关拦截`, LAYER.POLICY);
    return blocked(LAYER.POLICY,
      `该操作属于安全禁止区（${policy.desc}），Agent 永久无权执行。如确需操作，请在「卡片 / 安全中心」页面本人验证后操作。此次尝试已记录安全日志。`, log);
  }

  // P0 只读：无需授权单
  if (policy.level === 0) return { ok: true, free: true };

  // U-28/29 参数 schema 校验：建单前拦截非法金额/缺失必填项，
  // 避免「-100 / abc / 1e5 / 999999999999」生成垃圾授权单并触发无意义短信。
  params = fillResourceDefaults(user, action, params || {});
  const vErr = validateParams(action, params);
  if (vErr) {
    const log = audit(user.id, 'gateway', action, params || {}, 'BLOCKED', `参数校验失败：${vErr}`, LAYER.VERIFY);
    return blocked(LAYER.VERIFY, `操作参数不合法：${vErr}`, log);
  }

  // 收款人解析层的最后一道闸：转账/定时转账必须携带通讯录联系人 ID。
  // 这样即使有人绕过 Agent 直接调授权单接口，也无法凭空捏造一个收款人。
  if ((action === 'transfer.execute' || action === 'scheduled.create') && !params.contactId) {
    const log = audit(user.id, 'gateway', action, params || {}, 'BLOCKED',
      '转账请求缺少可信收款人（contactId），拒绝建单', LAYER.RESOLVE);
    return blocked(LAYER.RESOLVE, '收款人必须来自你的可信通讯录：请先添加并验证联系人，或从通讯录中选择', log);
  }

  // 授权单参数走服务端 HMAC 签名（密钥只在服务端，客户端/LLM 无法自行伪造）
  const sig = signParams(action, params);
  const approval = {
    id: uid(), userId: user.id, actor, action,
    actionDesc: policy.desc, level: policy.level,
    params, paramSig: sig, fingerprint: fingerprint(sig),
    status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + APPROVAL_TTL,
    confirmedAt: null, usedAt: null,
    attemptCount: 0, lastAttemptAt: null,     // U-16/17：本单累计验证失败次数
    requireAck: !!o.requireAck,               // 锁 3：新增联系人首次大额需二次确认
    warning: o.warning || null,               // 待验证收款人的红色警示（展示用，不进签名）
    payee: o.payee || null                    // 收款人身份卡（展示用，不进签名）
  };
  db.approvals.push(approval);
  if (db.approvals.length > 500) db.approvals = db.approvals.slice(-300);

  // P2 需要短信验证码（演示环境：验证码直接显示在页面"演示短信"面板，不真实发送）
  let sms = null;
  if (policy.level >= 2) {
    sms = { phone: user.phone, code: smsCode(), purpose: policy.desc, expiresAt: Date.now() + 5 * 60 * 1000 };
    db.smsCodes.push({ ...sms, approvalId: approval.id });
    if (db.smsCodes.length > 100) db.smsCodes = db.smsCodes.slice(-50);
  }
  audit(user.id, actor, action, params, 'CREATED',
    actor === 'agent' ? 'Agent 发起操作，等待用户确认' : '用户发起操作，等待确认');
  store.save();
  return { ok: true, approval, sms };
}

// ---- 用户确认授权单并执行 ----
// 并发保护（U-19）：整个「校验 → 执行 → 改状态」放在同一把按授权单 ID 命名的锁里。
// 两个并发请求打同一张单时，只有第一个能进临界区，第二个直接收到「处理中」，
// 不会出现两边都读到 status='pending' 而重复执行的「双花」。
async function confirmAndExecute(user, approvalId, cred) {
  return lock.mutex('approval:' + approvalId,
    () => confirmAndExecuteLocked(user, approvalId, cred),
    { busyMessage: '该授权单正在处理中，请勿重复提交（并发保护已生效，未发生重复扣款）' });
}

function confirmAndExecuteLocked(user, approvalId, cred) {
  const db = store.get();
  const ap = db.approvals.find(a => a.id === approvalId);
  if (!ap) return { ok: false, message: '授权单不存在' };
  if (ap.userId !== user.id) {
    const log = audit(user.id, 'gateway', ap.action, {}, 'REJECTED', '越权访问他人授权单', LAYER.VERIFY);
    return blocked(LAYER.VERIFY, '无权操作该授权单（已记录安全日志）', log);
  }
  // 前置：正在处理中（并发保护的可见状态，正常单请求流程不会看到）
  if (ap.status === 'processing') {
    audit(user.id, 'gateway', ap.action, ap.params, 'REJECTED',
      '授权单已处于 processing 状态，并发重复提交被拒绝（未重复扣款）', LAYER.VERIFY);
    return { ok: false, busy: true, message: '该授权单正在处理中，请勿重复提交（未发生重复扣款）' };
  }
  if (ap.status === 'used') {
    // 任务 E 幂等：同一授权单重复提交 → 命中原幂等键，返回首次结果，绝不重复扣款
    const rec = db.idempotency && db.idempotency[ap.id];
    if (rec) {
      const banking = require('./banking');
      const r = banking.execute(user, ap.action, ap.params, { idempotencyKey: ap.id });
      audit(user.id, 'gateway', ap.action, ap.params, 'REJECTED',
        '同一授权单重复提交：幂等键命中，未重复执行，返回首次结果（一次性授权已作废）', LAYER.VERIFY);
      return { ...r, fingerprint: ap.fingerprint, idempotent: true };
    }
  }
  if (ap.status !== 'pending') {
    audit(user.id, 'gateway', ap.action, ap.params, 'REJECTED',
      `授权单状态为 ${ap.status}，重复提交已被拒绝（同一授权单只执行一次）`, LAYER.VERIFY);
    return { ok: false, message: `授权单状态为 ${ap.status}，不可重复使用（一次性授权：用后即废）` };
  }
  if (ap.expiresAt < Date.now()) {
    ap.status = 'expired'; store.save();
    const log = audit(user.id, 'gateway', ap.action, ap.params, 'REJECTED', '授权单已过 5 分钟有效期', LAYER.VERIFY);
    return blocked(LAYER.VERIFY, '授权单已过期（5 分钟有效期），请重新发起', log);
  }

  // U-16/17 用户级累计限速：防止「不断新建授权单」绕过单张单据的失败次数上限
  const payGuard = limits.guard('pay', user.id);
  if (!payGuard.ok) {
    const log = audit(user.id, 'gateway', ap.action, {}, 'BLOCKED',
      `支付验证失败次数过多，用户资金操作已临时冻结（还需 ${payGuard.retryAfter} 秒）`, LAYER.VERIFY);
    return blocked(LAYER.VERIFY, `支付验证失败次数过多，请 ${payGuard.retryAfter} 秒后再试`, log);
  }

  // ⚠️ 临界区开始：状态前置为 processing。从这里到写回终态，中途任何并发请求
  //    读到的都是 processing 而不是 pending，无法再通过下面的状态检查。
  ap.status = 'processing';

  // ① 校验层：先验授权单签名（参数指纹）。签名不合法 → 立刻拦截，连验证码都不用问。
  //    这一步挡住的就是「用户看到的金额」与「实际执行的金额」被中途改写的情形。
  const sigOk = verifyParams(ap.action, ap.params, ap.paramSig);
  if (!sigOk) {
    ap.status = 'tampered';
    const log = audit(user.id, 'gateway', ap.action, ap.params, 'BLOCKED',
      `授权单参数签名校验失败：当前参数与签发的授权单不一致（指纹 ${fingerprint(ap.paramSig)}），疑似篡改，已拦截`, LAYER.VERIFY);
    store.save();
    return blocked(LAYER.VERIFY, '操作参数与授权单不一致（签名校验失败），已拦截并记录安全日志', log);
  }

  // U-11 参数比对（受控演示路径）：确认接口默认不信任任何客户端参数，
  // 但如果客户端回传了 params，就与授权单做一次规范化比对 —— 不一致即判定篡改。
  // 这条路径的存在本身就是为了证明「改金额再确认」会被拦住。
  if (cred && cred.params && typeof cred.params === 'object' && Object.keys(cred.params).length) {
    if (canonical(cred.params) !== canonical(ap.params)) {
      ap.status = 'tampered';
      const log = audit(user.id, 'gateway', ap.action, {}, 'BLOCKED',
        `确认参数与授权单不一致（授权单指纹 ${ap.fingerprint}），疑似篡改，已拦截`, LAYER.VERIFY);
      store.save();
      return blocked(LAYER.VERIFY, '操作参数与授权单不一致（疑似篡改），已拦截并记录安全日志', log);
    }
  }

  // 锁 3：新增联系人 24h 内首次大额 → 强制二次确认（用户必须显式勾选）
  if (ap.requireAck && !(cred && cred.acknowledgeRisk)) {
    ap.status = 'pending';
    store.save();
    return { ok: false, needAck: true, message: '该笔是新添加联系人的首次大额转账，请先勾选「我已电话核实收款人身份」再确认' };
  }

  // ② 校验层：P2 双重验证 —— 支付密码 + 短信验证码（共用失败计数）
  if (ap.level >= 2) {
    if (!cred || !cred.payPassword || !cred.smsCode) {
      ap.status = 'pending';              // 缺凭证不算失败，退回待确认，用户可补填
      store.save();
      return { ok: false, message: '需要支付密码和短信验证码' };
    }

    // 统一失败出口：累加计数 → 达上限锁单作废，并同步扣用户级配额
    const failAttempt = (reason) => {
      ap.attemptCount = (ap.attemptCount || 0) + 1;
      ap.lastAttemptAt = Date.now();
      const exceeded = ap.attemptCount >= MAX_ATTEMPTS;
      limits.fail('pay', user.id);
      ap.status = exceeded ? 'locked' : 'pending';   // 锁单：整张单据立即作废，必须重新发起
      const log = audit(user.id, 'user', ap.action, {}, 'REJECTED',
        exceeded
          ? `${reason}（第 ${ap.attemptCount} 次，已达上限，授权单作废）`
          : `${reason}（第 ${ap.attemptCount}/${MAX_ATTEMPTS} 次）`,
        LAYER.VERIFY);
      store.save();
      return blocked(LAYER.VERIFY,
        exceeded
          ? `${reason}；验证失败次数已达上限（${MAX_ATTEMPTS} 次），该授权单已作废，请重新发起操作`
          : `${reason}，还可尝试 ${MAX_ATTEMPTS - ap.attemptCount} 次`,
        log);
    };

    if (!user.payPasswordHash || !require('./util').verifyPassword(cred.payPassword, user.payPasswordHash)) {
      return failAttempt('支付密码错误');
    }
    const sms = db.smsCodes.filter(s => s.approvalId === ap.id && s.expiresAt > Date.now() && !s.usedAt).pop();
    if (!sms || sms.code !== String(cred.smsCode).trim()) {
      return failAttempt('短信验证码错误或已过期');
    }
    sms.usedAt = Date.now();              // 验证码一次性，成功即消费，防复用
  }

  ap.status = 'approved';
  ap.confirmedAt = Date.now();
  audit(user.id, 'user', ap.action, ap.params, 'APPROVED',
    ap.level >= 2 ? `用户已通过支付密码+短信验证码确认（授权单 ${ap.id.slice(0, 8)}，指纹 ${ap.fingerprint}）` : '用户已确认');

  // ③ 转交业务执行器；以授权单 ID 作为幂等键 —— 同一张单重复提交只会执行一次
  const banking = require('./banking');
  const result = banking.execute(user, ap.action, ap.params, { idempotencyKey: ap.id });
  if (result.ok) {
    ap.status = 'used'; ap.usedAt = Date.now();
  } else if (result.busy) {
    ap.status = 'pending';   // 业务层并发拒绝（非失败），交回待确认，用户可重试
  } else {
    ap.status = 'failed';
  }
  store.save();
  return { ...result, fingerprint: ap.fingerprint };
}

// ---- Agent 工具调用统一入口（每个调用独立过闸）----
function agentCall(user, action, params, opts) {
  const policy = POLICY[action];
  if (!policy) {
    const log = audit(user.id, 'gateway', action, params, 'BLOCKED', '未注册的 Agent 工具（白名单外动作）', LAYER.POLICY);
    return blocked(LAYER.POLICY, '未注册的操作', log);
  }
  return createApproval(user, 'agent', action, params, opts);
}

// ---- 持续性授权（定时转账）----
function createStandingAuth(userId, action, scope, dailyLimitCents, days) {
  const db = store.get();
  const auth = {
    id: 'sa' + (db.nextIds.standing++), userId, action, scope,
    dailyLimitCents, usedTodayCents: 0, usedDate: new Date().toISOString().slice(0, 10),
    createdAt: Date.now(), expiresAt: Date.now() + days * 86400000, revoked: false
  };
  db.standingAuths.push(auth);
  store.save();
  return auth;
}

function checkStandingAuth(auth, amountCents) {
  if (!auth || auth.revoked) return { ok: false, reason: '授权已被用户撤销' };
  if (auth.expiresAt < Date.now()) return { ok: false, reason: '授权已过有效期' };
  const today = new Date().toISOString().slice(0, 10);
  if (auth.usedDate !== today) { auth.usedDate = today; auth.usedTodayCents = 0; }
  if (auth.usedTodayCents + amountCents > auth.dailyLimitCents) {
    return { ok: false, reason: `超出单日限额（${yuan(auth.dailyLimitCents)}元），需用户重新授权` };
  }
  return { ok: true };
}

function listPolicy() {
  return Object.entries(POLICY).map(([action, p]) => ({ action, level: p.level, desc: p.desc }));
}

module.exports = {
  LAYER, POLICY, audit, blocked, verifyAuditChain, blockedTodayCount,
  createApproval, confirmAndExecute, agentCall, createStandingAuth, checkStandingAuth, listPolicy
};
