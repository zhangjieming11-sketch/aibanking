'use strict';
// ============ A6.2–A6.6 · 跨场景联动（多步链路 + 虚拟时钟 + 逐节点回滚）============
// 设计原则：
// 1) 链路是**确定性状态机**，不是让模型自由编排。模型只负责识别「用户要做生日惊喜」，
//    有哪几步、什么顺序、每步做什么都写死在这里 —— 这是可控性的来源。
// 2) 每个写节点都有反操作（下单→取消、锁资→解锁、日历→删除），因此「全程可撤销」是结构性的，
//    不是靠事后补一个撤销按钮。
// 3) 虚拟时钟**按用户隔离**，且只影响 plan 的时间判断，不替换全局 Date.now()，
//    避免污染资金、审计、限速等真实时间语义。
const store = require('./store');
const { yuan, uid } = require('./util');

const DAY = 86400000;

const STEPS = [
  { key: 'memory', label: '写入记忆', write: true },
  { key: 'calendar', label: '创建提醒', write: true },
  { key: 'escrow', label: '锁定资金', write: true, money: true },
  { key: 'order', label: '预约下单', write: true },
  { key: 'notify', label: '发送通知', write: true },
  { key: 'receipt', label: '生成回执', write: false }
];

// ---- 按用户隔离的虚拟时钟 ----
function clock(userId) {
  const db = store.get();
  const m = (db.virtualClocks || {})[userId];
  return (m && m.offsetMs) || 0;
}
function now(userId) { return Date.now() + clock(userId); }
function setClock(userId, offsetMs) {
  const db = store.get();
  if (!db.virtualClocks) db.virtualClocks = {};
  const v = { offsetMs, updatedAt: Date.now() };
  db.virtualClocks[userId] = v;
  return { ok: true, offsetMs, offsetDays: Math.round(offsetMs / DAY), virtualNow: new Date(Date.now() + offsetMs).toISOString() };
}
function advanceDays(userId, days) {
  return setClock(userId, clock(userId) + Number(days || 0) * DAY);
}
function resetClock(userId) { return setClock(userId, 0); }

// MM-DD → 绝对时间戳（按当前年份取）。
// 不做「若已过则明年」的跨年滚动：演示场景里「记住生日 10-28 → 准备惊喜 → 推进虚拟时钟」，
// eventAt 固化在 create 时，一旦被推到明年，虚拟时钟推进 10 天也到不了「生日前 3 天」，A6.3 主动提醒永不触发。
function eventTs(mmdd, base) {
  const m = String(mmdd || '').match(/^(\d{2})-(\d{2})$/);
  if (!m) return null;
  const b = new Date(base || Date.now());
  return new Date(b.getFullYear(), Number(m[1]) - 1, Number(m[2]), 9, 0, 0).getTime();
}

function emptySteps() {
  return STEPS.map(s => ({ key: s.key, label: s.label, status: 'pending', at: null, detail: '' }));
}

// 旅行预算默认拆解（确定性比例，演示用）：交通 / 住宿 / 餐饮 / 门票娱乐 / 购物其他
function defaultTripBudget(totalCents) {
  const parts = [
    { cat: '交通', ratio: 0.30 },
    { cat: '住宿', ratio: 0.35 },
    { cat: '餐饮', ratio: 0.20 },
    { cat: '门票/娱乐', ratio: 0.10 },
    { cat: '购物/其他', ratio: 0.05 }
  ];
  return parts.map(p => ({ cat: p.cat, amountCents: Math.round(totalCents * p.ratio) }));
}

function create(userId, opts) {
  const db = store.get();
  const o = opts || {};
  if (!db.plans) db.plans = [];
  // 消费规划用「目标日期」（YYYY-MM-DD），生日/普通计划用 MM-DD；两者归一化到 eventAt。
  const ts = o.targetDate
    ? Date.parse(String(o.targetDate) + 'T00:00:00')
    : eventTs(o.eventDate, now(userId));
  const type = o.type || 'birthday';
  const plan = {
    id: 'pl' + uid().slice(0, 8),
    userId,
    type,
    title: o.title || (type === 'trip' ? '旅行规划' : type === 'goal' ? '攒钱目标' : '生日惊喜'),
    eventDate: o.eventDate || null,
    targetDate: o.targetDate || null,
    eventAt: ts,
    amount: o.amount || 20000,
    item: o.item || (type === 'trip' ? '旅行预订' : type === 'goal' ? '目标储蓄' : '生日蛋糕'),
    destination: o.destination || null,
    durationDays: o.durationDays ? Number(o.durationDays) : null,
    goal: o.goal || null,
    planning: o.planning || null,   // 消费规划诊断快照（feasibility/fundingSources/subSavingQualified/linkedProductId/steps）
    budget: Array.isArray(o.budget) ? o.budget : (type === 'trip' ? defaultTripBudget(o.amount || 20000) : null),
    steps: emptySteps(),
    escrow: { status: 'none', amount: 0, approvalId: null, heldAt: null },
    status: 'draft',
    proactiveSent: false,
    createdAt: now(userId),
    updatedAt: now(userId)
  };
  db.plans.push(plan);
  return { ok: true, plan };
}

function find(userId, planId) {
  const db = store.get();
  const list = (db.plans || []).filter(p => p.userId === userId);
  return planId ? list.find(p => p.id === planId) : list;
}

function stepOf(plan, key) {
  return (plan.steps || []).find(s => s.key === key);
}

function mark(plan, key, status, detail) {
  const s = stepOf(plan, key);
  if (!s) return null;
  s.status = status;
  s.at = now(plan.userId);
  if (detail != null) s.detail = String(detail).slice(0, 200);
  plan.updatedAt = now(plan.userId);
  return s;
}

function addNotification(userId, opts) {
  const db = store.get();
  if (!db.notifications) db.notifications = [];
  const n = Object.assign({
    id: 'nt' + uid().slice(0, 8), userId, read: false, revoked: false, at: now(userId)
  }, opts);
  db.notifications.push(n);
  return n;
}

// 执行单个非资金节点；资金节点（escrow）必须由网关授权单触发，这里拒绝直接调用
function advance(userId, planId, key, payload) {
  const db = store.get();
  const plan = find(userId, planId);
  if (!plan) return { ok: false, message: '未找到该计划' };
  const def = STEPS.find(s => s.key === key);
  if (!def) return { ok: false, message: '未知步骤' };
  if (def.money) return { ok: false, message: '锁定资金必须通过授权单确认，不能直接执行' };

  if (key === 'memory') {
    const p = payload || {};
    if (p.skip) { mark(plan, key, 'skipped', '用户已有记忆，跳过'); return { ok: true, plan }; }
    mark(plan, key, 'done', p.detail || `已记住 ${p.label || '生日'}：${p.value || ''}`);
  } else if (key === 'calendar') {
    if (!plan.eventAt) { mark(plan, key, 'skipped', '未设置具体日期'); return { ok: true, plan }; }
    if (!db.calendar) db.calendar = [];
    const at = plan.eventAt - 3 * DAY;
    db.calendar.push({ id: 'cal' + uid().slice(0, 8), userId, planId: plan.id, title: `${plan.title}提醒`, at, createdAt: now(userId) });
    mark(plan, key, 'done', `已创建提醒：${new Date(at).toISOString().slice(0, 10)}（提前 3 天）`);
  } else if (key === 'order') {
    if (!db.orders) db.orders = [];
    db.orders.push({
      id: 'od' + uid().slice(0, 8), userId, planId: plan.id,
      item: plan.item, amount: plan.amount, status: 'reserved',
      deliverAt: plan.eventAt, createdAt: now(userId)
    });
    mark(plan, key, 'done', `已预约「${plan.item}」¥${yuan(plan.amount)}，计划 ${new Date(plan.eventAt || now(userId)).toISOString().slice(0, 10)} 送达`);
  } else if (key === 'notify') {
    addNotification(userId, {
      kind: 'plan', title: `${plan.title}已安排`,
      body: `${new Date(plan.eventAt || now(userId)).toISOString().slice(0, 10)} 前 3 天会提醒你，已预留资金 ¥${yuan(plan.escrow.amount || 0)}。`,
      planId: plan.id
    });
    mark(plan, key, 'done', '已发送站内通知与短信提醒');
  } else if (key === 'receipt') {
    mark(plan, key, 'done', `回执：${plan.item} · ¥${yuan(plan.amount)} · 送达 ${new Date(plan.eventAt || now(userId)).toISOString().slice(0, 10)}`);
    // 回执只代表「已安排」，不代表「已完成」：计划继续保持 running，等事件日到达再提醒
  }
  return { ok: true, plan };
}

// 锁定资金成功后由执行层回调，自动跑完剩余非资金节点
function afterEscrowHeld(userId, planId, amountCents, approvalId) {
  const plan = find(userId, planId);
  if (!plan) return { ok: false, message: '未找到该计划' };
  plan.escrow = { status: 'held', amount: amountCents, approvalId, heldAt: now(userId) };
  mark(plan, 'escrow', 'done', `已从可用余额中预留 ¥${yuan(amountCents)}（可随时撤销）`);
  plan.status = 'running';
  for (const s of ['order', 'notify', 'receipt']) {
    const st = stepOf(plan, s);
    if (st && st.status === 'pending') advance(userId, planId, s);
  }
  return { ok: true, plan };
}

// A6.3 主动触发：到点只发「建议卡」，绝不静默改用户资产
function tick(userId) {
  const db = store.get();
  const out = [];
  for (const plan of (db.plans || []).filter(p => p.userId === userId && p.status === 'running')) {
    if (plan.proactiveSent || !plan.eventAt) continue;
    if (now(userId) < plan.eventAt - 3 * DAY) continue;
    plan.proactiveSent = true;
    plan.status = 'reminded';
    const n = addNotification(userId, {
      kind: 'proactive', title: `${plan.title}还有 3 天`,
      body: `已为你预留 ¥${yuan(plan.escrow.amount || 0)}。需要我确认下单「${plan.item}」吗？`,
      planId: plan.id, needsConfirm: true
    });
    out.push({ planId: plan.id, notification: n });
  }
  return out;
}

// A6.5 逐节点回滚（逆序）
function rollback(userId, planId, reason) {
  const db = store.get();
  const plan = find(userId, planId);
  if (!plan) return { ok: false, message: '未找到该计划' };
  if (plan.status === 'reverted') return { ok: false, message: '该计划已经回滚过了' };
  const undone = [];

  for (const st of plan.steps.slice().reverse()) {
    if (st.status !== 'done') continue;
    if (st.key === 'receipt' || st.key === 'notify') {
      (db.notifications || []).filter(n => n.planId === plan.id && !n.revoked).forEach(n => { n.revoked = true; });
      mark(plan, st.key, 'reverted', '已撤销通知');
      undone.push(st.key);
    } else if (st.key === 'order') {
      (db.orders || []).filter(o => o.planId === plan.id && o.status === 'reserved').forEach(o => { o.status = 'cancelled'; o.cancelledAt = now(userId); });
      mark(plan, st.key, 'reverted', '已取消预约下单');
      undone.push(st.key);
    } else if (st.key === 'calendar') {
      db.calendar = (db.calendar || []).filter(c => c.planId !== plan.id);
      mark(plan, st.key, 'reverted', '已删除日历提醒');
      undone.push(st.key);
    } else if (st.key === 'escrow') {
      const r = releaseEscrow(userId, plan);
      if (r.ok) { mark(plan, st.key, 'reverted', `已释放预留资金 ¥${yuan(r.amount)}`); undone.push(st.key); }
    } else if (st.key === 'memory') {
      // 记忆属于用户信息，回滚计划不删除记忆（用户可单独删），只标注
      mark(plan, st.key, 'kept', '记忆保留（如不需可单独删除）');
    }
  }

  plan.status = 'reverted';
  plan.rollbackReason = reason || '';
  plan.updatedAt = now(userId);
  return {
    ok: true, plan, undone,
    message: undone.length ? `已回滚 ${undone.length} 个节点，预留资金已释放` : '该计划没有可回滚的节点'
  };
}

function releaseEscrow(userId, plan) {
  const db = store.get();
  if (!plan.escrow || plan.escrow.status !== 'held') return { ok: false, message: '没有已锁定的资金' };
  const acc = db.accounts.find(a => a.userId === userId);
  if (!acc) return { ok: false, message: '账户不存在' };
  const amount = plan.escrow.amount || 0;
  acc.escrowCents = Math.max(0, (acc.escrowCents || 0) - amount);
  plan.escrow.status = 'released';
  plan.escrow.releasedAt = now(userId);
  return { ok: true, amount };
}

// 处理付款（真正从余额扣走预留资金）
function settleEscrow(userId, plan) {
  const db = store.get();
  if (!plan.escrow || plan.escrow.status !== 'held') return { ok: false, message: '没有可结算的预留资金' };
  const acc = db.accounts.find(a => a.userId === userId);
  if (!acc) return { ok: false, message: '账户不存在' };
  const amount = plan.escrow.amount || 0;
  if (acc.balance < amount) return { ok: false, message: '余额不足，无法结算' };
  acc.escrowCents = Math.max(0, (acc.escrowCents || 0) - amount);
  acc.balance -= amount;
  plan.escrow.status = 'settled';
  plan.escrow.settledAt = now(userId);
  return { ok: true, amount };
}

function publicView(plan) {
  return {
    id: plan.id, title: plan.title, type: plan.type,
    eventDate: plan.eventDate,
    targetDate: plan.targetDate || null,
    eventAt: plan.eventAt ? new Date(plan.eventAt).toISOString().slice(0, 10) : null,
    amount: plan.amount,
    item: plan.item,
    destination: plan.destination || null,
    durationDays: plan.durationDays || null,
    goal: plan.goal || null,
    budget: plan.budget || null,
    planning: plan.planning || null,
    status: plan.status,
    steps: plan.steps,
    escrow: plan.escrow,
    progress: `${plan.steps.filter(s => s.status === 'done' || s.status === 'skipped').length}/${plan.steps.length}`
  };
}

module.exports = {
  STEPS, clock, now, setClock, advanceDays, resetClock, eventTs,
  create, find, advance, afterEscrowHeld, rollback, releaseEscrow, settleEscrow,
  tick, addNotification, publicView, stepOf, mark
};
