'use strict';
// ============ A4.3–A4.5 / C6 · 挂失链路 ============
// 一次「我卡丢了」需要 Agent 自主完成一串动作，而不是只返回一句「请去卡片页挂失」：
//   选卡 → 影响评估（代扣 / 定时转账 / 可疑交易）→ 双重确认 → OTP → 冻结 → 代扣迁移 → 回执
//
// 安全设计：
// 1) 挂失本身是 P2（资金安全相关），必须支付密码 + 短信，不能因为"急"就跳过；
// 2) 代扣迁移是**用户勾选**的，不自动搬——把钱从一张卡挪到另一张卡，用户必须知情；
// 3) 可疑交易只提示、不自动申诉（申诉是法律动作，必须本人发起）。
const store = require('./store');
const { yuan, maskCard, uid } = require('./util');

const DAY = 86400000;

function getCard(userId, cardId) {
  const db = store.get();
  const cards = db.cards.filter(c => c.userId === userId);
  if (!cardId) return cards.find(c => c.isDefault && !c.lost) || cards.find(c => !c.lost) || null;
  return cards.find(c => c.id === cardId) || null;
}

// 影响评估：挂失前必须先告诉用户「会牵连什么」
function assess(userId, cardId) {
  const db = store.get();
  const card = getCard(userId, cardId);
  if (!card) return { ok: false, message: '没有找到可挂失的卡片' };
  if (card.lost) return { ok: false, message: `「${card.name}」已经挂失过了` };

  const subs = (db.subscriptions || []).filter(s => s.userId === userId && s.status !== 'cancelled');
  const tasks = (db.scheduled || []).filter(t => t.userId === userId && t.status === 'active');

  // 可疑交易：近 7 天、金额显著高于该用户近期均值（3 倍），或收款人未在通讯录
  const recent = (db.transfers || []).filter(t => t.userId === userId && t.createdAt > Date.now() - 7 * DAY);
  const avg = recent.length ? recent.reduce((s, t) => s + t.amount, 0) / recent.length : 0;
  const suspicious = recent.filter(t => (avg && t.amount > avg * 3) || !t.contactId)
    .map(t => ({ id: t.id, amount: t.amount, toName: t.toName, at: t.createdAt, reason: !t.contactId ? '收款人未在可信通讯录' : '金额显著高于近期均值' }));

  // 可迁移的备用卡
  const spare = db.cards.filter(c => c.userId === userId && c.id !== card.id && !c.lost && !c.frozen);

  return {
    ok: true,
    card: { id: card.id, name: card.name, number: maskCard(card.number), frozen: !!card.frozen },
    affected: {
      subscriptions: subs.map(s => ({ id: s.id, merchant: s.merchant, amount: s.amount, cycleLabel: s.cycleLabel, nextChargeAt: s.nextChargeAt })),
      scheduled: tasks.map(t => ({ id: t.id, toName: t.toName, amount: t.amount, freq: t.freq })),
      suspicious
    },
    spareCards: spare.map(c => ({ id: c.id, name: c.name, number: maskCard(c.number) })),
    steps: [
      '冻结该卡，停止一切资金操作',
      subs.length ? `把 ${subs.length} 项自动扣费迁移到备用卡（可选）` : '当前没有自动扣费需要迁移',
      tasks.length ? `暂停 ${tasks.length} 个定时转账` : '当前没有定时转账',
      '生成挂失回执，附可疑交易清单'
    ]
  };
}

// 执行挂失（网关确认后调用）
function execute(userId, cardId, opts) {
  const db = store.get();
  const o = opts || {};
  const card = getCard(userId, cardId);
  if (!card) return { ok: false, message: '卡片不存在' };
  if (card.lost) return { ok: true, message: `「${card.name}」已处于挂失状态`, duplicated: true };

  const before = assess(userId, card.id);
  const done = [];

  card.lost = true;
  card.lostAt = Date.now();
  card.frozen = true;
  done.push(`已挂失并冻结「${card.name}」${maskCard(card.number)}`);

  // 代扣迁移：只在用户勾选了目标卡时执行
  let migrated = 0;
  if (o.migrateToCardId) {
    const target = db.cards.find(c => c.id === o.migrateToCardId && c.userId === userId && !c.lost && !c.frozen);
    if (target) {
      (db.subscriptions || []).filter(s => s.userId === userId && s.status !== 'cancelled')
        .forEach(s => { s.cardId = target.id; migrated++; });
      if (migrated) done.push(`已把 ${migrated} 项自动扣费迁移到「${target.name}」${maskCard(target.number)}`);
    }
  }

  // 定时转账：挂失卡关联的任务一律暂停（演示里没有卡绑定，按用户维度处理，宁可多暂停）
  let paused = 0;
  (db.scheduled || []).filter(t => t.userId === userId && t.status === 'active')
    .forEach(t => { t.status = 'paused'; t.pausedBy = 'card.loss'; paused++; });
  if (paused) done.push(`已暂停 ${paused} 个定时转账，可在「转账」页恢复`);

  const suspicious = before.ok ? before.affected.suspicious : [];
  const receipt = {
    id: 'ls' + uid().slice(0, 8),
    userId, cardId: card.id, cardName: card.name,
    at: Date.now(), done, migrated, paused,
    suspicious, migrateToCardId: o.migrateToCardId || null
  };
  if (!db.lossReceipts) db.lossReceipts = [];
  db.lossReceipts.push(receipt);

  return {
    ok: true,
    message: `挂失完成。${done.join('；')}。`,
    receipt: {
      id: receipt.id,
      cardName: receipt.cardName,
      done,
      migrated,
      paused,
      suspicious: suspicious.length,
      nextSteps: [
        '3 个工作日内到网点或线上申请补卡',
        suspicious.length ? `有 ${suspicious.length} 笔可疑交易，建议立即申诉` : '近 7 天未发现可疑交易',
        '如已确认盗刷，可同时报警并申请争议处理'
      ]
    }
  };
}

function listReceipts(userId) {
  const db = store.get();
  return (db.lossReceipts || []).filter(r => r.userId === userId).slice(-5).reverse();
}

module.exports = { getCard, assess, execute, listReceipts };
