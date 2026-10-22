'use strict';
// ============ 银行业务执行器 ============
// 所有资金/卡片动作的唯一执行入口；调用方必须已通过权限网关（一次性授权单或持续性授权）
const store = require('./store');
const { yuan, toCents, maskCard, uid } = require('./util');
const gateway = require('./gateway');
const lock = require('./lock');
const contacts = require('./contacts');
const subscriptions = require('./subscriptions');   // A3
const memory = require('./memory');                 // A6.1
const plans = require('./plans');                   // A6.2–A6.6
const loss = require('./loss');                     // A4.3–A4.5 / C6
const session = require('./session');               // 上下文对象栈

// U-15 收款人名称归一化：全角→半角、去零宽/空格/常见分隔符，再做黑名单匹配。
// 否则「黑 客」「黑客.」「ｈａｃｋｅｒ」都能绕过 includes 精确子串。
function normName(s) {
  let t = String(s == null ? '' : s);
  try { t = t.normalize('NFKC'); } catch (e) { /* 老引擎兜底 */ }
  return t.replace(/[\s\u200b-\u200f•.\-_·]/g, '').toLowerCase();
}

function account(userId) {
  const a = store.get().accounts.find(a => a.userId === userId);
  if (!a) throw new Error('账户不存在');
  return a;
}

// ---- 任务 E：幂等键 + 大额撤销窗口 ----
const LARGE_AMOUNT = 100000;                    // 大额门槛：¥1,000.00（分）
const REVOKE_WINDOW = 2 * 60 * 1000;            // 大额撤销窗口：2 分钟

function revokeWindowSeconds(revocableUntil) {
  if (!revocableUntil) return 0;
  return Math.max(0, Math.ceil((revocableUntil - Date.now()) / 1000));
}

function riskChecks(user, amountCents, toName, opts) {
  const db = store.get();
  const o = opts || {};
  // 收款人黑名单（归一化后匹配，「黑 客」「黑客.」「ｈａｃｋｅｒ」同样命中）
  const nm = normName(toName);
  if ((user.payeeBlacklist || []).some(b => nm.includes(normName(b)))) {
    return { ok: false, message: `收款人「${toName}」命中风控黑名单，交易已拦截（已记录安全日志）` };
  }
  // 通讯录信任态限额（纵深防御）：即使请求绕过了解析层，执行层仍按 trust 卡额度
  if (o.contactId) {
    const c = (db.contacts || []).find(x => x.id === o.contactId && x.userId === user.id);
    if (!c) return { ok: false, message: '收款人不在你的可信通讯录中，交易已拦截' };
    const risk = contacts.checkPayeeRisk(user, c, amountCents);
    if (risk.level === 'block') return { ok: false, message: risk.message };
  }
  // 单笔限额
  if (amountCents > user.limits.single) {
    return { ok: false, message: `单笔金额超出限额（${yuan(user.limits.single)}元），请先在安全中心调整限额` };
  }
  // 单日限额（统计当日已转账）
  const today = new Date().toISOString().slice(0, 10);
  const usedToday = db.transfers
    .filter(t => t.userId === user.id && t.status === 'success' && new Date(t.createdAt).toISOString().slice(0, 10) === today)
    .reduce((s, t) => s + t.amount, 0);
  // 定时任务/AA 有自己的额度控制（持续性授权 quota、AA 份额），不再叠加单日限额，避免两套规则互相打架
  if (!o.skipDailyLimit && usedToday + amountCents > user.limits.daily) {
    return { ok: false, message: `今日累计转账将超出单日限额（${yuan(user.limits.daily)}元），已拦截` };
  }
  return { ok: true };
}

// ---- 并发保护：资金变动的同步临界区 ----
// 「读余额 → 判断够不够 → 扣款 → 写流水」必须作为一个整体完成，中途不能插入别的扣款。
// 本函数内不允许出现 await（一旦出现，事件循环会让并发请求插进来，导致超额/重复扣款）。
// 定时任务走 quota（持续性授权额度）而不是单日限额，避免两套额度规则互相冲突。
function doTransfer(user, params, opts) {
  const o = opts || {};
  const amount = toCents(params.amount);
  if (!amount) return { ok: false, message: '金额无效' };

  // 定时任务：先占并发闸门（同一时刻只允许一个 schedulerTick 在跑），再进同步临界区
  if (o.type === 'scheduled') {
    return lock.mutex('scheduler', () => doTransferInner(user, params, o),
      { busyMessage: '定时任务调度正在执行中，本次跳过（防重复执行）' });
  }
  return lock.sync(() => doTransferInner(user, params, o));
}

function doTransferInner(user, params, o) {
  const db = store.get();
  const amount = toCents(params.amount);

  // —— 幂等：同一个授权单（幂等键）重复提交，只执行一次，绝不重复扣款 ——
  const key = o.idempotencyKey;
  if (key && db.idempotency && db.idempotency[key]) {
    const prev = db.transfers.find(t => t.id === db.idempotency[key].transferId);
    gateway.audit(user.id, 'gateway', 'transfer.execute', { idempotencyKey: String(key).slice(0, 12) }, 'OK',
      `命中幂等键：该授权单已执行过，本次未重复扣款，直接返回首次结果（转账 ${prev ? prev.id : '-'}）`);
    return {
      ok: true, deduped: true,
      message: `该笔转账已执行过，系统未重复扣款（幂等保护）：¥${yuan(prev ? prev.amount : amount)} → ${prev ? prev.toName : params.toName}`,
      transferId: prev ? prev.id : null,
      revocableUntil: prev ? prev.revocableUntil : null,
      revokeWindowSec: prev ? revokeWindowSeconds(prev.revocableUntil) : 0
    };
  }

  // 定时任务：额度由持续性授权（quota）单独控制，不叠加用户单日限额
  const chk = riskChecks(user, amount, params.toName, { skipDailyLimit: o.type === 'scheduled', contactId: params.contactId });
  if (!chk.ok) {
    gateway.audit(user.id, 'risk-engine', 'transfer.execute', params, 'BLOCKED', chk.message);
    return { ok: false, message: chk.message };
  }
  const acc = account(user.id);
  const defCard = db.cards.find(c => c.userId === user.id && c.isDefault);
  if (defCard && defCard.frozen) return { ok: false, message: `默认卡「${defCard.name}」已冻结，请先解冻（安全中心/卡片页）` };
  if (acc.balance < amount) return { ok: false, message: `余额不足（当前余额 ¥${yuan(acc.balance)}）` };
  acc.balance -= amount;
  const now = Date.now();
  // 大额转账给用户留 2 分钟反悔窗口：窗口内可一键撤销、资金原路退回
  const revocableUntil = amount >= LARGE_AMOUNT ? now + REVOKE_WINDOW : null;
  const t = {
    id: 't' + (db.nextIds.transfer++), userId: user.id,
    toName: params.toName || '(未填写)', toAccount: params.toAccount || '',
    amount, type: o.type || 'normal', note: params.note || '',
    status: 'success', createdAt: now, executedBy: o.executedBy || 'user',
    revocableUntil, revoked: false
  };
  db.transfers.push(t);
  // 通讯录往来记录：转账成功后累加，供"累计 N 笔"身份卡展示（也是新联系人风控的解封条件）
  if (params.contactId) {
    const c = (db.contacts || []).find(x => x.id === params.contactId && x.userId === user.id);
    if (c) {
      c.transferCount = (c.transferCount || 0) + 1;
      c.lastTransferAt = now;
      if (!c.firstTransferAt) c.firstTransferAt = now;
    }
  }
  if (key) {
    db.idempotency[key] = { transferId: t.id, at: now };
    // 幂等键只保留最近 500 条，避免演示库无限膨胀
    const keys = Object.keys(db.idempotency);
    if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete db.idempotency[k];
  }
  gateway.audit(user.id, 'gateway', 'transfer.execute', { ...params, amountCents: amount }, 'OK',
    `${o.executedBy === 'scheduler' ? '定时任务(持续授权)自动' : ''}转账 ¥${yuan(amount)} 给 ${params.toName}`
    + (revocableUntil ? `；大额转账，已开启 ${REVOKE_WINDOW / 60000} 分钟撤销窗口` : ''));
  // 记账（转账也是一笔支出账单）
  db.bills.push({ id: 'b' + uid().slice(0, 8), userId: user.id, date: new Date().toISOString().slice(0, 10),
    merchant: `转账→${params.toName}`, category: '转账', amount, source: 'transfer', note: t.type, transferId: t.id });
  return {
    ok: true,
    message: `转账成功：¥${yuan(amount)} → ${params.toName}（当前余额 ¥${yuan(acc.balance)}）`
      + (revocableUntil ? `\n大额转账已开启 2 分钟撤销窗口，可在回执卡中一键撤销。` : ''),
    transferId: t.id, revocableUntil, revokeWindowSec: revokeWindowSeconds(revocableUntil)
  };
}

// ---- 任务 E：大额撤销（窗口内资金原路退回）----
// 并发保护（U-33）：并发撤销同一笔时，第一个把 revoked 置 true，第二个读到的是「已撤销」，
// 因此只会退一次钱。整段同样不可插入 await。
function revokeTransfer(user, transferId) {
  return lock.sync(() => revokeTransferInner(user, transferId));
}

function revokeTransferInner(user, transferId) {
  const db = store.get();
  const t = db.transfers.find(x => x.id === transferId && x.userId === user.id);
  if (!t) return { ok: false, message: '转账记录不存在' };
  if (t.revoked) return { ok: false, message: '该笔转账已撤销过' };
  if (t.revoking) return { ok: false, message: '该笔转账正在撤销处理中，请勿重复提交（未发生重复退款）' };
  t.revoking = true;              // 状态前置：后来者读到的不是「未撤销」
  if (!t.revocableUntil) { t.revoking = false; return { ok: false, message: '该笔为小额转账，即时到账、不提供撤销' }; }
  if (Date.now() > t.revocableUntil) { t.revoking = false; return { ok: false, message: '已超过 2 分钟撤销窗口，无法撤销' }; }
  const acc = account(user.id);
  acc.balance += t.amount;
  t.revoked = true; t.status = 'revoked'; t.revokedAt = Date.now(); t.revoking = false;
  // 撤销后同步冲销该笔产生的支出账单
  db.bills = db.bills.filter(b => b.transferId !== t.id);
  gateway.audit(user.id, 'user', 'transfer.revoke', { transferId: t.id, amountCents: t.amount }, 'OK',
    `用户在撤销窗口内撤销大额转账 ¥${yuan(t.amount)} → ${t.toName}，资金已原路退回余额`);
  store.save();
  return { ok: true, message: `已撤销：¥${yuan(t.amount)} → ${t.toName}，资金已退回（当前余额 ¥${yuan(acc.balance)}）`, amount: t.amount };
}

// ---- 业务执行器（由网关在授权确认后调用）----
function execute(user, action, params, opts) {
  const db = store.get();
  const o = opts || {};
  switch (action) {
    case 'transfer.execute':
      return doTransfer(user, params, { idempotencyKey: o.idempotencyKey, executedBy: user._actor || 'user' });

    case 'scheduled.create': {
      const amount = toCents(params.amount);
      if (!amount) return { ok: false, message: '金额无效' };
      const chk = riskChecks(user, amount, params.toName);
      if (!chk.ok) { gateway.audit(user.id, 'risk-engine', action, params, 'BLOCKED', chk.message); return { ok: false, message: chk.message }; }
      // 创建持续性授权：范围=该任务，单日限额=单次金额，有效期90天，随时可撤销
      const auth = gateway.createStandingAuth(user.id, 'scheduled.execute',
        { transferId: 'pending', toName: params.toName }, amount, 90);
      const task = {
        id: 'sd' + (db.nextIds.transfer++), userId: user.id,
        toName: params.toName || '', amount,
        freq: params.freq || 'once',           // once | daily | weekly | monthly
        nextRun: params.nextRun || (Date.now() + 60 * 1000), // 演示默认 1 分钟后执行
        standingAuthId: auth.id, status: 'active', note: params.note || '',
        createdAt: Date.now()
      };
      auth.scope.transferId = task.id;
      db.scheduled.push(task);
      gateway.audit(user.id, 'gateway', action, params, 'OK', `创建定时转账：每${ {once:'次',daily:'日',weekly:'周',monthly:'月'}[task.freq] || '次'}向 ${task.toName} 转 ¥${yuan(amount)}，同时生成可撤销的持续性授权（限额 ¥${yuan(amount)}/日，90天有效）`);
      return { ok: true, message: `定时转账已创建：向 ${task.toName} 转 ¥${yuan(amount)}，首笔将于演示 1 分钟后自动执行（持续性授权：单日限额 ¥${yuan(amount)}，90 天有效，可在安全中心随时撤销）`, taskId: task.id };
    }

    case 'scheduled.cancel': {
      const task = db.scheduled.find(t => t.id === params.taskId && t.userId === user.id);
      if (!task) return { ok: false, message: '定时任务不存在' };
      task.status = 'cancelled';
      const auth = db.standingAuths.find(a => a.id === task.standingAuthId);
      if (auth) auth.revoked = true;
      gateway.audit(user.id, 'gateway', action, params, 'OK', `取消定时转账 ${task.id} 并撤销其持续性授权`);
      return { ok: true, message: '定时任务已取消，对应持续性授权已同步撤销' };
    }

    case 'aa.create': {
      const total = toCents(params.total);
      if (!total) return { ok: false, message: '金额无效' };
      const parts = (params.participants || '').split(/[,，、\s]+/).filter(Boolean);
      if (parts.length < 1) return { ok: false, message: '请填写参与人' };
      const all = [user.name, ...parts];
      const share = Math.ceil(total / all.length);
      const g = {
        id: 'aa' + (db.nextIds.aa++), creatorId: user.id, creatorName: user.name,
        title: params.title || 'AA 聚会', totalAmount: total,
        participants: all.map(n => ({ name: n, share, paid: false, transferId: null })),
        status: 'collecting', createdAt: Date.now()
      };
      db.aaGroups.push(g);
      gateway.audit(user.id, 'gateway', action, params, 'OK', `发起 AA「${g.title}」总额 ¥${yuan(total)}，${all.length} 人均摊 ¥${yuan(share)}（每人独立验证支付自己的份额）`);
      return { ok: true, message: `AA「${g.title}」已发起：总额 ¥${yuan(total)}，${all.length} 人均摊，每人 ¥${yuan(share)}。各参与人需各自验证支付自己的份额。`, groupId: g.id };
    }

    case 'aa.pay': {
      const g = db.aaGroups.find(g => g.id === params.groupId);
      if (!g) return { ok: false, message: 'AA 活动不存在' };
      const p = g.participants.find(p => p.name === params.payerName);
      if (!p) return { ok: false, message: '你不是该活动的参与人' };
      if (p.paid) return { ok: false, message: '你的份额已支付' };
      // 每个人只对自己的资金有权限：付款人是当前登录用户，收款人是发起人
      const r = doTransfer(user, { toName: g.creatorName, amount: (p.share / 100), note: `AA:${g.title}` }, { type: 'aa', executedBy: user._actor || 'user', idempotencyKey: o.idempotencyKey ? o.idempotencyKey + ':aa' : undefined });
      if (!r.ok) return r;
      p.paid = true; p.transferId = r.transferId;
      if (g.participants.every(p => p.paid)) g.status = 'settled';
      gateway.audit(user.id, 'gateway', action, params, 'OK', `${user.name} 支付 AA「${g.title}」份额 ¥${yuan(p.share)}（独立验证）`);
      return { ok: true, message: `你已支付「${g.title}」份额 ¥${yuan(p.share)}。${g.status === 'settled' ? '全部到账，活动结算完成！' : '等待其他参与人支付。'}` };
    }

    case 'wealth.subscribe': {
      const prod = db.products.find(p => p.id === params.productId);
      if (!prod) return { ok: false, message: '产品不存在' };
      const amount = toCents(params.amount);
      if (!amount || amount < prod.minCents) return { ok: false, message: `申购失败：最低申购金额 ¥${yuan(prod.minCents)}` };
      // 适当性管理：风险等级匹配校验（金融合规亮点）
      const userLevel = Number((user.riskLevel || 'C1').slice(1));
      const prodLevel = Number(prod.risk.slice(1));
      if (prodLevel > userLevel) {
        gateway.audit(user.id, 'gateway', action, params, 'BLOCKED', `适当性拦截：${user.riskLevel} 用户申购 ${prod.risk} 产品「${prod.name}」`);
        return { ok: false, message: `适当性拦截：你的风险等级为 ${user.riskLevel}，产品「${prod.name}」风险等级为 ${prod.risk}，高于你的承受等级，禁止申购（可先在理财页重新完成风险测评）` };
      }
      const acc = account(user.id);
      if (acc.balance < amount) return { ok: false, message: `余额不足（当前 ¥${yuan(acc.balance)}）` };
      acc.balance -= amount;
      const h = { id: 'h' + (db.nextIds.holding++), userId: user.id, productId: prod.id, amount, at: Date.now() };
      db.holdings.push(h);
      gateway.audit(user.id, 'gateway', action, params, 'OK', `申购「${prod.name}」¥${yuan(amount)}（${user.riskLevel} → ${prod.risk} 适当性校验通过）`);
      return { ok: true, message: `申购成功：「${prod.name}」¥${yuan(amount)}（七日年化参考 ${prod.rate}%）`, holdingId: h.id };
    }

    case 'wealth.redeem': {
      const h = db.holdings.find(h => h.id === params.holdingId && h.userId === user.id);
      if (!h) return { ok: false, message: '持仓不存在' };
      const prod = db.products.find(p => p.id === h.productId);
      // A5.5 部分赎回：redeemCents 由意图层按比例/金额算好，这里只做**上限校验**。
      // 关键：部分赎回不能凭「用户说了个数字」就相信它小于持仓 —— 参数来自 LLM 时同样可能被篡改，
      // 所以这里重新夹紧一次，超出即拒绝（不做静默截断，避免"我以为赎了 500 其实全赎了"）。
      const partialCents = Number(params.redeemCents || 0);
      const isPartial = !!params.partial || (partialCents > 0 && partialCents < h.amount);
      if (partialCents < 0) return { ok: false, message: '赎回金额必须为正数' };
      if (partialCents >= h.amount) return { ok: false, message: `赎回金额超出持仓本金（持仓 ¥${yuan(h.amount)}），请改小或选择全额赎回` };
      const principal = isPartial ? partialCents : h.amount;
      const days = (Date.now() - h.at) / 86400000;
      const gain = Math.round(principal * (prod.rate / 100) * (days / 365));
      const acc = account(user.id);
      acc.balance += principal + gain;
      if (isPartial) {
        // 剩余持仓原样保留（本金减少，持有起始时间不变 —— 已产生的收益不重算）
        h.amount -= principal;
        gateway.audit(user.id, 'gateway', action, params, 'OK',
          `部分赎回「${prod.name}」本金 ¥${yuan(principal)} + 收益 ¥${yuan(gain)}，剩余持仓 ¥${yuan(h.amount)}`);
        return {
          ok: true,
          message: `部分赎回成功：「${prod.name}」赎回本金 ¥${yuan(principal)}，估算收益 +¥${yuan(gain)}（T+0 到账）；剩余持仓 ¥${yuan(h.amount)}`,
          partial: true, remainingCents: h.amount
        };
      }
      db.holdings = db.holdings.filter(x => x.id !== h.id);
      gateway.audit(user.id, 'gateway', action, params, 'OK', `赎回「${prod.name}」本金 ¥${yuan(h.amount)} + 收益 ¥${yuan(gain)}`);
      return { ok: true, message: `赎回成功：「${prod.name}」本金 ¥${yuan(h.amount)}，持有 ${Math.floor(days)} 天，估算收益 +¥${yuan(gain)}（T+0 到账）` };
    }

    // ================= A4.3–A4.5 / C6 · 挂失链路 =================
    case 'card.reportLoss': {
      const r = loss.execute(user.id, params.cardId, { migrateToCardId: params.migrateToCardId });
      if (!r.ok) return r;
      gateway.audit(user.id, 'user', action, { cardId: params.cardId, migrateToCardId: params.migrateToCardId }, 'OK',
        `挂失「${r.receipt.cardName}」；已完成：${r.receipt.done.join('；')}`);
      return { ok: true, message: r.message, lossReceipt: r.receipt };
    }

    case 'card.freeze': {
      const c = db.cards.find(c => c.id === params.cardId && c.userId === user.id);
      if (!c) return { ok: false, message: '卡片不存在' };
      c.frozen = true;
      gateway.audit(user.id, 'gateway', action, params, 'OK', `冻结卡片「${c.name}」${maskCard(c.number)}`);
      return { ok: true, message: `卡片「${c.name}」${maskCard(c.number)} 已冻结，涉及该卡的资金操作将被拦截` };
    }
    case 'card.unfreeze': {
      const c = db.cards.find(c => c.id === params.cardId && c.userId === user.id);
      if (!c) return { ok: false, message: '卡片不存在' };
      c.frozen = false;
      gateway.audit(user.id, 'gateway', action, params, 'OK', `解冻卡片「${c.name}」`);
      return { ok: true, message: `卡片「${c.name}」已解冻` };
    }
    case 'card.setDefault': {
      const c = db.cards.find(c => c.id === params.cardId && c.userId === user.id);
      if (!c) return { ok: false, message: '卡片不存在' };
      db.cards.filter(x => x.userId === user.id).forEach(x => x.isDefault = false);
      c.isDefault = true;
      gateway.audit(user.id, 'gateway', action, params, 'OK', `设置默认卡为「${c.name}」`);
      return { ok: true, message: `默认卡已设置为「${c.name}」${maskCard(c.number)}` };
    }
    case 'card.add': {
      if (!params.name || !/^\d{12,19}$/.test(String(params.number || '').replace(/\s/g, ''))) return { ok: false, message: '卡号格式无效' };
      const c = { id: 'c' + uid().slice(0, 6), userId: user.id, name: params.name, number: String(params.number).replace(/\s/g, ''), frozen: false, isDefault: false };
      db.cards.push(c);
      gateway.audit(user.id, 'gateway', action, params, 'OK', `绑定新卡「${c.name}」${maskCard(c.number)}`);
      return { ok: true, message: `绑卡成功：「${c.name}」${maskCard(c.number)}` };
    }

    // ================= A3 · 订阅 / 代扣 =================
    case 'query.subscriptions': {
      const list = subscriptions.listFor(user.id);
      const dup = list.filter(s => s.duplicateCount > 0);
      // 记住第一项，供「取消它」解析
      if (list.length) session.setObject(user.id, 'subscription', { id: list[0].id, merchant: list[0].merchant, amount: list[0].amount });
      gateway.audit(user.id, 'agent', action, {}, 'OK',
        `扫描订阅 ${list.length} 项，命中疑似重复扣费 ${dup.length} 项`);
      return {
        ok: true, kind: 'subscriptions', list,
        message: `共 ${list.length} 项自动扣费${dup.length ? `，其中 ${dup.length} 项疑似重复扣费` : ''}`
      };
    }

    case 'subscription.cancel': {
      const all = subscriptions.listFor(user.id);
      const hit = all.find(s => s.id === params.subscriptionId || s.merchant === params.subscriptionId);
      if (!hit) return { ok: false, message: '未找到该订阅' };
      if (hit.status === 'cancelled') return { ok: false, message: `「${hit.merchant}」已经取消了` };
      const r = subscriptions.cancel(user.id, hit.id);
      if (!r.ok) return r;
      // A3.4 串联钩子：把省下的钱接到理财（只给建议，不自动申购）
      const hook = subscriptions.savingHook(hit);
      gateway.audit(user.id, 'user', action, { subscriptionId: hit.id, merchant: hit.merchant }, 'OK',
        `取消订阅「${hit.merchant}」（${hit.cycleLabel} ¥${yuan(hit.amount)}），下次扣费日 ${hit.nextChargeAt} 起不再扣款`);
      return {
        ok: true,
        message: `已取消「${hit.merchant}」，下次扣费（${hit.nextChargeAt}）起不再扣款。${hook.suggestion}`,
        cancelled: { merchant: hit.merchant, nextChargeAt: hit.nextChargeAt, amount: hit.amount },
        saving: hook
      };
    }

    case 'subscription.report': {
      const r = subscriptions.reportDuplicate(user.id, params.subscriptionId, params.note);
      if (!r.ok) return r;
      gateway.audit(user.id, 'user', action, { subscriptionId: r.dispute.subscriptionId, merchant: r.dispute.merchant },
        'OK', `受理重复扣费申诉：${r.dispute.merchant} × ${r.dispute.count} 次，金额 ¥${yuan(r.dispute.amount * r.dispute.count)}`);
      return { ok: true, message: r.message, dispute: r.dispute };
    }

    // ================= A6 · 记忆 / 跨场景链路 =================
    case 'memory.write': {
      const r = memory.write(user.id, params.key, params.value, { source: 'user' });
      if (!r.ok) return r;
      gateway.audit(user.id, 'user', action, { key: r.key }, 'OK',
        `写入长期记忆「${r.label}」=${r.value}${r.updated ? `（原值 ${r.before}）` : ''}`);
      return {
        ok: true, message: r.updated ? `${r.label}已更新为 ${r.value}` : `记住了：${r.label}是 ${r.value}`,
        key: r.key, label: r.label, value: r.value, updated: !!r.updated
      };
    }

    case 'memory.query': {
      const r = memory.read(user.id, params.key);
      if (!r.found) {
        // 零幻觉：没记录就明确说没有，不推测、不举例
        return { ok: true, found: false, message: `我还没有记住你的${r.label}。你可以说「记住我的${r.label}是 10月28日」。`, label: r.label };
      }
      gateway.audit(user.id, 'agent', action, { key: r.key }, 'OK', `读取长期记忆「${r.label}」`);
      return { ok: true, found: true, message: `你之前告诉我：${r.label}是 ${r.value}`, label: r.label, value: r.value };
    }

    case 'plan.create': {
      const r = plans.create(user.id, {
        eventDate: params.eventDate,
        amount: toCents(params.amount) || 20000,
        item: params.item || '生日蛋糕',
        title: params.title || '生日惊喜'
      });
      if (!r.ok) return r;
      const p = r.plan;
      session.setObject(user.id, 'plan', { id: p.id, title: p.title });   // 供「撤销那个」解析
      // 记忆与日历两步不涉及资金，已包含在这张 P1 授权的范围内，建计划时直接执行；
      // 锁资（escrow）必须另走 P2 双因子，因此留给人确认。
      const mem = memory.read(user.id, 'family.birthday.spouse');
      if (mem.found && mem.value === p.eventDate) {
        plans.advance(user.id, p.id, 'memory', { skip: true, detail: `已记住「${mem.label}」=${mem.value}` });
      } else if (p.eventDate) {
        plans.advance(user.id, p.id, 'memory', { value: p.eventDate, label: '生日' });
      }
      plans.advance(user.id, p.id, 'calendar');
      gateway.audit(user.id, 'agent', action, { planId: p.id, eventDate: p.eventDate, amount: p.amount }, 'OK',
        `创建跨场景计划「${p.title}」：目标日期 ${p.eventDate || '未定'}，预算 ¥${yuan(p.amount)}`);
      return { ok: true, plan: plans.publicView(p), message: `已创建「${p.title}」计划（${p.eventDate || '日期待定'}），需要锁定 ¥${yuan(p.amount)} 预算` };
    }

    case 'escrow.hold': {
      const plan = plans.find(user.id, params.planId);
      if (!plan) return { ok: false, message: '未找到该计划' };
      if (plan.escrow && plan.escrow.status === 'held') {
        return { ok: true, message: '该计划的预算已经预留，无需重复锁定', duplicated: true, plan: plans.publicView(plan) };
      }
      const amount = toCents(params.amount);
      if (!amount || amount <= 0) return { ok: false, message: '预留金额无效' };
      const acc = account(user.id);
      const available = acc.balance - (acc.escrowCents || 0);
      if (available < amount) return { ok: false, message: `可用余额不足（可用 ¥${yuan(Math.max(0, available))}）` };
      acc.escrowCents = (acc.escrowCents || 0) + amount;
      const r = plans.afterEscrowHeld(user.id, plan.id, amount, o.idempotencyKey || null);
      gateway.audit(user.id, 'user', action, { planId: plan.id, amount }, 'OK',
        `为「${plan.title}」预留 ¥${yuan(amount)}，可用余额 ${yuan(available - amount)}（可随时撤销）`);
      return { ok: true, message: `已预留 ¥${yuan(amount)}，解锁前不会被动用`, plan: plans.publicView(r.plan || plan) };
    }

    case 'plan.adjust': {
      const plan = plans.find(user.id, params.planId);
      if (!plan) return { ok: false, message: '未找到该计划' };
      if (plan.status === 'reverted') return { ok: false, message: '该计划已回滚，不能调整' };
      if (params.step === 'escrow') {
        return { ok: false, message: '锁资是资金安全的前置步骤，不能跳过或后置——否则会出现「先下单后付钱」的空转' };
      }
      const st = plans.stepOf(plan, params.step);
      if (!st) return { ok: false, message: '该计划没有这一步' };
      if (params.op === 'skip') {
        if (st.status === 'done') return { ok: false, message: `「${st.label}」已完成，无法跳过` };
        plans.mark(plan, params.step, 'skipped', '按你的要求跳过');
      } else if (params.op === 'first') {
        const i = plan.steps.findIndex(s => s.key === params.step);
        if (i > 0) { const [s] = plan.steps.splice(i, 1); plan.steps.unshift(s); }
      }
      gateway.audit(user.id, 'user', action, { planId: plan.id, step: params.step, op: params.op }, 'OK',
        `调整计划「${plan.title}」：${params.op === 'skip' ? '跳过' : '提前'}「${st.label}」`);
      return {
        ok: true,
        message: params.op === 'skip' ? `已跳过「${st.label}」` : `已把「${st.label}」调整到最前`,
        plan: plans.publicView(plan)
      };
    }

    case 'plan.rollback': {
      const r = plans.rollback(user.id, params.planId, params.reason);
      if (!r.ok) return r;
      gateway.audit(user.id, 'user', action, { planId: params.planId, undone: r.undone }, 'OK',
        `回滚计划，撤销节点：${(r.undone || []).join('、') || '无'}，资金已释放`);
      return { ok: true, message: r.message, plan: plans.publicView(r.plan), undone: r.undone };
    }

    case 'demo.clock': {
      const days = Number(params.days || 0);
      const r = days ? plans.advanceDays(days) : plans.resetClock();
      gateway.audit(user.id, 'user', action, { days }, 'OK',
        days ? `演示时钟推进 ${days} 天（虚拟当前 ${r.virtualNow.slice(0, 10)}）` : '演示时钟已重置');
      return { ok: true, message: days ? `演示时间已推进 ${days} 天，当前虚拟日期 ${r.virtualNow.slice(0, 10)}` : '演示时间已重置为真实时间', clock: r };
    }

    case 'demo.clock': {
      const days = Number(params.days || 0);
      const r = days ? plans.advanceDays(user.id, days) : plans.resetClock(user.id);
      gateway.audit(user.id, 'user', action, { days }, 'OK',
        days ? `演示时钟推进 ${days} 天（虚拟当前 ${r.virtualNow.slice(0, 10)}）` : '演示时钟已重置');
      return { ok: true, message: days ? `演示时间已推进 ${days} 天，当前虚拟日期 ${r.virtualNow.slice(0, 10)}` : '演示时间已重置为真实时间', clock: r };
    }

    default:
      return { ok: false, message: '未实现的操作: ' + action };
  }
}

// ---- 定时任务调度（持续性授权逐笔校验）----
// 并发保护（U-19 的另一面）：若两次 tick 同时跑，同一个任务会被执行两次。
// 整个 tick 用 'scheduler' 闸门互斥，并给每个任务标记 running 状态，
// 确保「同一任务同一时刻只执行一次」。
function schedulerTick(force) {
  return lock.mutex('scheduler-tick', () => schedulerTickInner(force),
    { busyMessage: '调度器正在执行中，本次 tick 已跳过（防重复执行）' });
}

async function schedulerTickInner(force) {
  const db = store.get();
  const fired = [];
  for (const task of db.scheduled) {
    if (task.status !== 'active' || (!force && task.nextRun > Date.now())) continue;
    if (task.running) { fired.push({ taskId: task.id, ok: false, reason: '上一次执行尚未结束，本次跳过' }); continue; }
    task.running = true;
    try {
      const user = db.users.find(u => u.id === task.userId);
      const auth = db.standingAuths.find(a => a.id === task.standingAuthId);
      const chk = gateway.checkStandingAuth(auth, task.amount);
      if (!chk.ok) {
        task.status = 'paused';
        gateway.audit(task.userId, 'scheduler', 'scheduled.execute', { taskId: task.id }, 'PAUSED', `定时转账暂停：${chk.reason}（等待用户处理）`);
        fired.push({ taskId: task.id, ok: false, reason: chk.reason });
        continue;
      }
      // 模拟用户身份执行（executedBy=scheduler 标记）
      user._actor = 'scheduler';
      // scheduled 类型走异步互斥锁分支，必须 await，否则 r 是 Promise、r.ok 恒为 undefined
      const r = await doTransfer(user, { toName: task.toName, amount: task.amount / 100, note: '定时转账' }, { type: 'scheduled', executedBy: 'scheduler' });
      user._actor = undefined;
      auth.usedTodayCents += task.amount;
      if (r.ok) {
        fired.push({ taskId: task.id, ok: true, message: r.message });
        // 计算下一次
        if (task.freq === 'once') {
          task.status = 'done';
        } else if (force) {
          // 手动触发（演示用）：无论频率，执行后一律把下次执行时间推到未来，
          // 否则 nextRun 仍停在过去，下一次 tick 会再次命中同一任务 → 重复扣款。
          const step = task.freq === 'daily' ? 86400000 : task.freq === 'weekly' ? 7 * 86400000 : 30 * 86400000;
          task.nextRun = Date.now() + step;
        } else if (task.freq === 'daily') task.nextRun += 86400000;
        else if (task.freq === 'weekly') task.nextRun += 7 * 86400000;
        else if (task.freq === 'monthly') task.nextRun += 30 * 86400000;
      } else {
        task.status = 'paused';
        fired.push({ taskId: task.id, ok: false, reason: r.message });
      }
    } finally {
      task.running = false;
    }
  }
  store.save();
  return fired;
}

module.exports = { execute, schedulerTick, account, doTransfer, revokeTransfer, revokeWindowSeconds, LARGE_AMOUNT, REVOKE_WINDOW };
