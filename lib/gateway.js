'use strict';
// ============ 权限网关（Policy Gateway）============
// 安全的核心：
// 1. 每个 API 动作注册权限级别 P0-P3，硬编码策略表，LLM 无权决定
// 2. Agent 发起的请求必须携带有效的一次性授权单（approval）
// 3. 授权单与参数指纹绑定：换金额/收款人即失效，用过即作废
// 4. 全部动作写审计日志

const { paramHash, uid, smsCode, yuan } = require('./util');
const store = require('./store');

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

// ---- 审计 ----
function audit(userId, actor, action, detail, result, note) {
  const db = store.get();
  db.auditLogs.push({
    id: db.nextIds.audit++, t: Date.now(), userId, actor, action, detail, result, note: note || ''
  });
  if (db.auditLogs.length > 2000) db.auditLogs = db.auditLogs.slice(-1000);
  store.save();
}

// ---- 创建授权单（Agent 或用户发起）----
function createApproval(user, actor, action, params) {
  const db = store.get();
  const policy = POLICY[action];
  if (!policy) throw new Error('未知操作: ' + action);

  // P3 禁止区：Agent 发起直接拦截，写入审计
  if (policy.level === 3 && actor === 'agent') {
    audit(user.id, 'gateway', action, params, 'BLOCKED',
      `Agent 尝试执行 P3 禁止操作「${policy.desc}」，已被权限网关拦截`);
    return { blocked: true, message: `该操作属于安全禁止区（${policy.desc}），Agent 无权执行。如确需操作，请在「卡片/安全中心」页面本人验证后操作。此次尝试已记录安全日志。` };
  }

  // P0 只读：无需授权单
  if (policy.level === 0) return { free: true };

  const approval = {
    id: uid(), userId: user.id, actor, action,
    actionDesc: policy.desc, level: policy.level,
    params, paramHash: paramHash(action, params),
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
  audit(user.id, actor, action, params, 'CREATED', actor === 'agent' ? 'Agent 发起操作，等待用户确认' : '用户发起操作，等待确认');
  store.save();
  return { approval, sms };
}

// ---- 用户确认授权单并执行 ----
function confirmAndExecute(user, approvalId, cred) {
  const db = store.get();
  const ap = db.approvals.find(a => a.id === approvalId);
  if (!ap) return { ok: false, message: '授权单不存在' };
  if (ap.userId !== user.id) {
    audit(user.id, 'gateway', ap.action, {}, 'REJECTED', '越权访问他人授权单');
    return { ok: false, message: '无权操作该授权单（已记录安全日志）' };
  }
  if (ap.status !== 'pending') return { ok: false, message: `授权单状态为 ${ap.status}，不可重复使用` };
  if (ap.expiresAt < Date.now()) { ap.status = 'expired'; store.save(); return { ok: false, message: '授权单已过期（5 分钟有效期），请重新发起' }; }

  // P2：双重验证 —— 支付密码 + 短信验证码
  if (ap.level >= 2) {
    if (!cred || !cred.payPassword || !cred.smsCode) return { ok: false, message: '需要支付密码和短信验证码' };
    if (!user.payPasswordHash || !require('./util').verifyPassword(cred.payPassword, user.payPasswordHash)) {
      audit(user.id, 'user', ap.action, {}, 'REJECTED', '支付密码错误');
      return { ok: false, message: '支付密码错误（已记录安全日志）' };
    }
    const sms = db.smsCodes.filter(s => s.approvalId === ap.id && s.expiresAt > Date.now()).pop();
    if (!sms || sms.code !== String(cred.smsCode).trim()) {
      audit(user.id, 'user', ap.action, {}, 'REJECTED', '短信验证码错误');
      return { ok: false, message: '短信验证码错误或已过期' };
    }
  }

  ap.status = 'approved';
  ap.confirmedAt = Date.now();
  audit(user.id, 'user', ap.action, ap.params, 'APPROVED', ap.level >= 2 ? '用户已通过支付密码+短信验证码确认' : '用户已确认');

  // 网关逐笔放行：执行前再次校验参数指纹（防篡改）
  if (paramHash(ap.action, ap.params) !== ap.paramHash) {
    ap.status = 'tampered';
    audit(user.id, 'gateway', ap.action, ap.params, 'BLOCKED', '参数指纹不一致，疑似篡改，已拦截');
    store.save();
    return { ok: false, message: '操作参数与授权时不一致，已拦截并记录安全日志' };
  }

  // 转交业务执行器
  const banking = require('./banking');
  const result = banking.execute(user, ap.action, ap.params);
  if (result.ok) {
    ap.status = 'used'; ap.usedAt = Date.now();
  } else {
    ap.status = 'failed';
  }
  store.save();
  return result;
}

// ---- Agent 工具调用统一入口（每个调用独立过闸）----
function agentCall(user, action, params) {
  const policy = POLICY[action];
  if (!policy) { audit(user.id, 'gateway', action, params, 'BLOCKED', '未注册的 Agent 工具'); return { blocked: true, message: '未注册的操作' }; }
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

module.exports = { POLICY, audit, createApproval, confirmAndExecute, agentCall, createStandingAuth, checkStandingAuth, listPolicy };
