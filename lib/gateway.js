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
const store = require('./store');

const LAYER = { DATA: '数据隔离层', POLICY: '权限层', VERIFY: '校验层' };

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
  // 保留最近 1000 条（链内仍自洽：最早一条的 prev_hash 指向已被裁剪的前驱）
  if (db.auditLogs.length > 2000) db.auditLogs = db.auditLogs.slice(-1000);
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
function createApproval(user, actor, action, params) {
  const db = store.get();
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

  // 授权单参数走服务端 HMAC 签名（密钥只在服务端，客户端/LLM 无法自行伪造）
  const sig = signParams(action, params);
  const approval = {
    id: uid(), userId: user.id, actor, action,
    actionDesc: policy.desc, level: policy.level,
    params, paramSig: sig, fingerprint: fingerprint(sig),
    status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + APPROVAL_TTL,
    confirmedAt: null, usedAt: null
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
function confirmAndExecute(user, approvalId, cred) {
  const db = store.get();
  const ap = db.approvals.find(a => a.id === approvalId);
  if (!ap) return { ok: false, message: '授权单不存在' };
  if (ap.userId !== user.id) {
    const log = audit(user.id, 'gateway', ap.action, {}, 'REJECTED', '越权访问他人授权单', LAYER.VERIFY);
    return blocked(LAYER.VERIFY, '无权操作该授权单（已记录安全日志）', log);
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

  // ② 校验层：P2 双重验证 —— 支付密码 + 短信验证码
  if (ap.level >= 2) {
    if (!cred || !cred.payPassword || !cred.smsCode) return { ok: false, message: '需要支付密码和短信验证码' };
    if (!user.payPasswordHash || !require('./util').verifyPassword(cred.payPassword, user.payPasswordHash)) {
      const log = audit(user.id, 'user', ap.action, {}, 'REJECTED', '支付密码错误', LAYER.VERIFY);
      return blocked(LAYER.VERIFY, '支付密码错误（已记录安全日志）', log);
    }
    const sms = db.smsCodes.filter(s => s.approvalId === ap.id && s.expiresAt > Date.now()).pop();
    if (!sms || sms.code !== String(cred.smsCode).trim()) {
      const log = audit(user.id, 'user', ap.action, {}, 'REJECTED', '短信验证码错误', LAYER.VERIFY);
      return blocked(LAYER.VERIFY, '短信验证码错误或已过期', log);
    }
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
  } else {
    ap.status = 'failed';
  }
  store.save();
  return { ...result, fingerprint: ap.fingerprint };
}

// ---- Agent 工具调用统一入口（每个调用独立过闸）----
function agentCall(user, action, params) {
  const policy = POLICY[action];
  if (!policy) {
    const log = audit(user.id, 'gateway', action, params, 'BLOCKED', '未注册的 Agent 工具（白名单外动作）', LAYER.POLICY);
    return blocked(LAYER.POLICY, '未注册的操作', log);
  }
  return createApproval(user, 'agent', action, params);
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
