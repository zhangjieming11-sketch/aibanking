'use strict';
// ============ A3 · 订阅 / 代扣管理 ============
// 设计原则：
// 1) 订阅不是独立录入的数据，而是**从账单里识别出来的**——用户不记账，系统替他记。
// 2) 取消是 P1 动作（不涉资金外流），但必须给「影响提示」：下次扣费日、已扣总额、关联卡片。
// 3) 重复扣费判定只做「同商户 + 同金额 + 一个周期内出现两次」，宁可漏报不可误报。
const store = require('./store');
const { yuan, uid } = require('./util');

const CYCLE_DAYS = { weekly: 7, monthly: 30, quarterly: 90, yearly: 365 };
const CYCLE_LABEL = { weekly: '每周', monthly: '每月', quarterly: '每季', yearly: '每年' };
const DAY = 86400000;
// 周期性消费 ≠ 订阅：电商/外卖/商超会高频且金额接近，但那是买东西，不是自动扣费。
// 不靠这个排除，账单里「每周买一次淘宝」会被误判成周订阅，演示时会很荒谬。
const NOT_SUBSCRIPTION = /(淘宝|天猫|京东|拼多多|美团|饿了么|超市|便利店|菜场|菜市场|加油站|滴滴|打车)/;

function dayOf(s) {
  const t = Date.parse(String(s || '') + 'T00:00:00');
  return Number.isNaN(t) ? null : t;
}

function cycleOf(gapDays) {
  if (gapDays >= 5 && gapDays <= 9) return 'weekly';
  if (gapDays >= 25 && gapDays <= 35) return 'monthly';
  if (gapDays >= 80 && gapDays <= 100) return 'quarterly';
  if (gapDays >= 350 && gapDays <= 380) return 'yearly';
  return null;
}

// ---- 从账单识别周期扣费（A3.1 / A3.3 的数据来源）----
function detectFor(userId) {
  const db = store.get();
  const bills = (db.bills || []).filter(b => b.userId === userId && b.amount > 0 && b.source !== 'deposit');
  const byMerchant = new Map();
  for (const b of bills) {
    const key = String(b.merchant || '').trim();
    if (!key) continue;
    if (!byMerchant.has(key)) byMerchant.set(key, []);
    byMerchant.get(key).push(b);
  }

  const out = [];
  for (const [merchant, list] of byMerchant) {
    if (list.length < 2) continue;
    if (NOT_SUBSCRIPTION.test(merchant)) continue;   // 周期性消费，不是订阅
    const sorted = list.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    // 金额一致性：以最后一笔为基准，允许 ±1%（订阅价通常固定；放宽会误收零散消费）
    const base = sorted[sorted.length - 1].amount;
    const same = sorted.filter(b => Math.abs(b.amount - base) <= Math.max(1, base * 0.01));
    if (same.length < 2) continue;

    const gaps = [];
    for (let i = 1; i < same.length; i++) {
      const a = dayOf(same[i - 1].date), b = dayOf(same[i].date);
      if (a == null || b == null) continue;
      gaps.push(Math.round((b - a) / DAY));
    }
    // 取众数所在区间
    const counts = {};
    for (const g of gaps) {
      const c = cycleOf(g);
      if (c) counts[c] = (counts[c] || 0) + 1;
    }
    const cycle = Object.keys(counts).sort((x, y) => counts[y] - counts[x])[0];
    if (!cycle) continue;
    // 至少两段间隔都落在同一周期区间，才足以判定「规律扣费」；单段间隔偶然性太大
    if (counts[cycle] < 2) continue;

    const last = same[same.length - 1];
    const lastT = dayOf(last.date);
    const nextT = lastT + CYCLE_DAYS[cycle] * DAY;
    // 已经超过一个完整周期没再扣费 → 大概率是用户已取消或商户停止扣款，不再列为活跃订阅
    if (nextT < Date.now() - 7 * DAY) continue;
    const duplicates = [];
    // 重复扣费：同周期内出现两笔（间隔 < 周期的一半），视为同一周期被扣两次
    for (let i = 1; i < same.length; i++) {
      const a = dayOf(same[i - 1].date), b = dayOf(same[i].date);
      if (a == null || b == null) continue;
      if ((b - a) / DAY < CYCLE_DAYS[cycle] / 2) {
        duplicates.push({ date: same[i].date, amount: same[i].amount, billId: same[i].id, prevDate: same[i - 1].date });
      }
    }

    out.push({
      id: 'det_' + Buffer.from(merchant).toString('hex').slice(0, 10),
      userId, merchant,
      amount: base,
      cycle,
      cycleLabel: CYCLE_LABEL[cycle],
      lastChargedAt: last.date,
      nextChargeAt: new Date(nextT).toISOString().slice(0, 10),
      chargedCount: same.length,
      totalCents: same.reduce((s, b) => s + b.amount, 0),
      origin: 'detected',
      duplicate: duplicates[0] || null,
      duplicateCount: duplicates.length,
      status: 'active'
    });
  }
  return out;
}

// ---- 种子：演示账号预置订阅（带一条重复扣费，供 A3.3 演示）----
function seedFor(userId) {
  const today = new Date();
  const iso = d => new Date(today.getTime() - d * DAY).toISOString().slice(0, 10);
  const next = d => new Date(today.getTime() + d * DAY).toISOString().slice(0, 10);
  return [
    { id: 'sub_' + uid().slice(0, 6), userId, merchant: '云视视频会员', amount: 2500, cycle: 'monthly', cycleLabel: '每月',
      lastChargedAt: iso(12), nextChargeAt: next(18), chargedCount: 6, totalCents: 15000,
      origin: 'demo', duplicate: null, duplicateCount: 0, status: 'active' },
    { id: 'sub_' + uid().slice(0, 6), userId, merchant: '悦听音乐', amount: 1500, cycle: 'monthly', cycleLabel: '每月',
      lastChargedAt: iso(3), nextChargeAt: next(27), chargedCount: 11, totalCents: 16500,
      origin: 'demo', duplicate: null, duplicateCount: 0, status: 'active' },
    // 这条刻意带重复扣费：本月被扣了两次，用于 A3.3 的规则命中与申诉
    { id: 'sub_' + uid().slice(0, 6), userId, merchant: '云盘存储 Pro', amount: 900, cycle: 'monthly', cycleLabel: '每月',
      lastChargedAt: iso(2), nextChargeAt: next(28), chargedCount: 8, totalCents: 8100,
      origin: 'demo',
      duplicate: { date: iso(2), amount: 900, prevDate: iso(4), billId: null },
      duplicateCount: 1, status: 'active' }
  ];
}

// ---- 列表：种子 + 检测结果合并（同商户取检测到的最新扣费日）----
function listFor(userId) {
  const db = store.get();
  const seeded = (db.subscriptions || []).filter(s => s.userId === userId);
  const detected = detectFor(userId);
  const byMerchant = new Map();
  for (const s of seeded) byMerchant.set(s.merchant, Object.assign({}, s));
  for (const d of detected) {
    const old = byMerchant.get(d.merchant);
    if (!old) { byMerchant.set(d.merchant, d); continue; }
    // 有真实账单就覆盖金额与日期，但保留种子里的 duplicate（可能来自构造数据）
    byMerchant.set(d.merchant, Object.assign({}, old, {
      amount: d.amount, lastChargedAt: d.lastChargedAt, nextChargeAt: d.nextChargeAt,
      chargedCount: d.chargedCount, totalCents: d.totalCents,
      duplicate: old.duplicate || d.duplicate,
      duplicateCount: Math.max(old.duplicateCount || 0, d.duplicateCount)
    }));
  }
  const profiles = db.merchantProfiles || {};
  return [...byMerchant.values()]
    .sort((a, b) => (b.duplicateCount || 0) - (a.duplicateCount || 0))
    .map(s => Object.assign({}, s, { profile: profiles[s.merchant] || null }));
}

// ---- A3.2 取消前的影响提示 ----
function cancelImpact(sub) {
  const lines = [
    `下次扣费：${sub.nextChargeAt}（${sub.cycleLabel} ¥${yuan(sub.amount)}）`,
    `已累计扣费：¥${yuan(sub.totalCents)}（${sub.chargedCount} 次）`,
    '取消后：不再自动扣费，已生效的会员权益通常保留至本期结束'
  ];
  if (sub.duplicateCount) {
    lines.push(`⚠️ 检测到 ${sub.duplicateCount} 次疑似重复扣费，可在取消后一并申诉退还`);
  }
  return {
    merchant: sub.merchant,
    amount: sub.amount,
    nextChargeAt: sub.nextChargeAt,
    totalCents: sub.totalCents,
    chargedCount: sub.chargedCount,
    duplicateCount: sub.duplicateCount || 0,
    lines
  };
}

// ---- A3.4 串联钩子：取消后把省下的钱接到理财 ----
function savingHook(sub) {
  const monthly = sub.cycle === 'yearly' ? Math.round(sub.amount / 12)
    : sub.cycle === 'quarterly' ? Math.round(sub.amount / 3)
    : sub.cycle === 'weekly' ? Math.round(sub.amount * 4) : sub.amount;
  return {
    monthlyCents: monthly,
    yearlyCents: monthly * 12,
    suggestion: `取消后每月可省 ¥${yuan(monthly)}，一年 ¥${yuan(monthly * 12)}。`
      + `可以把这笔钱放进「灵活宝」（R1，随时可取），要不要我帮你申购？`,
    action: 'wealth.subscribe',
    prefilled: { productId: 'p1', amount: String(monthly / 100) }
  };
}

function cancel(userId, id) {
  const db = store.get();
  const s = (db.subscriptions || []).find(x => x.id === id && x.userId === userId);
  if (s) { s.status = 'cancelled'; s.cancelledAt = Date.now(); return { ok: true, sub: s, persisted: true }; }
  // 检测出来的订阅没有持久化记录，取消时落库为一条 cancelled 记录
  const all = listFor(userId);
  const hit = all.find(x => x.id === id || x.merchant === id);
  if (!hit) return { ok: false, message: '未找到该订阅' };
  const rec = Object.assign({}, hit, { status: 'cancelled', cancelledAt: Date.now() });
  if (!db.subscriptions) db.subscriptions = [];
  db.subscriptions.push(rec);
  return { ok: true, sub: rec, persisted: false };
}

function reportDuplicate(userId, id, note) {
  const db = store.get();
  const all = listFor(userId);
  const hit = all.find(x => x.id === id || x.merchant === id);
  if (!hit) return { ok: false, message: '未找到该订阅' };
  if (!hit.duplicateCount) return { ok: false, message: `「${hit.merchant}」未检测到重复扣费` };
  if (!db.disputes) db.disputes = [];
  const d = {
    id: 'dp' + uid().slice(0, 8), userId, subscriptionId: hit.id, merchant: hit.merchant,
    amount: hit.amount, count: hit.duplicateCount, note: note || '',
    status: 'processing', createdAt: Date.now(),
    evidence: hit.duplicate
  };
  db.disputes.push(d);
  return { ok: true, dispute: d, message: `已受理对「${hit.merchant}」的重复扣费申诉，预计 3 个工作日内原路退还 ¥${yuan(hit.amount * hit.duplicateCount)}` };
}

// ---- N1 涨价检测（续费刺客）：同商户历史扣费序列，涨幅 >20% 且当前价出现 ≥2 次 → 告警 ----
// 告警必须能自证：返回价格轨迹 priceTrail，前端据此画出「¥9.9 → ¥39」的完整证据链。
function median(arr) {
  if (!arr || !arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function detectPriceHike(userId) {
  const db = store.get();
  const profiles = db.merchantProfiles || {};
  const bills = (db.bills || []).filter(b => b.userId === userId && b.amount > 0 && b.source !== 'deposit');
  const byM = new Map();
  for (const b of bills) {
    const k = String(b.merchant || '').trim();
    if (!k || NOT_SUBSCRIPTION.test(k)) continue;
    if (!byM.has(k)) byM.set(k, []);
    byM.get(k).push(b);
  }
  const out = [];
  for (const [m, list] of byM) {
    const p = profiles[m];
    if (p && p.billingType === 'usage') continue; // 按量计费：价格波动正常，跳过
    const sorted = list.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (sorted.length < 2) continue;
    const n = Math.min(3, sorted.length - 1);
    const baseline = median(sorted.slice(0, n).map(x => x.amount)); // 中位数抗促销拉偏
    const current = sorted[sorted.length - 1].amount;
    if (baseline <= 0) continue;
    const hikeRatio = (current - baseline) / baseline;
    const curCount = sorted.filter(x => x.amount === current).length;
    // 低价起步 = 「首月 ¥1 / ¥9.9 试用」，转正价属正常商业行为（归 N5 试用转付费预警），不是续费刺客
    const isTrialStyle = sorted[0].amount < baseline * 0.5;
    if (isTrialStyle) continue;
    if (hikeRatio > 0.20 && curCount >= 2) { // 涨幅>20% 且当前价出现≥2次（排除一次性调价）
      out.push({
        merchant: m, baseline, current,
        hikeRatio: Math.round(hikeRatio * 100) / 100,
        hikePct: Math.round(hikeRatio * 100),
        priceTrail: sorted.map(x => ({ date: x.date, amount: x.amount })),
        firstChargeAt: sorted[0].date,
        profile: p || null
      });
    }
  }
  return out;
}

// ---- N2 扣款溯源：给「这笔是什么」一个能自证的答案 ----
function trace(userId, merchant) {
  const db = store.get();
  const p = (db.merchantProfiles || {})[merchant] || null;
  const bills = (db.bills || []).filter(b => b.userId === userId && String(b.merchant || '').trim() === merchant && b.amount > 0);
  const sorted = bills.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return {
    merchant,
    legalName: (p && p.legalName) || merchant,
    channel: (p && p.channel) || '待补充',
    signAt: (p && p.signAt) || (sorted[0] ? sorted[0].date : null),
    agreementEntry: (p && p.agreementEntry) || '请在商户 App 内「订阅管理 / 自动续费」中查看取消入口',
    category: (p && p.category) || 'other',
    billingType: (p && p.billingType) || 'fixed',
    firstChargeAt: sorted[0] ? sorted[0].date : null,
    chargeCount: sorted.length,
    totalCents: sorted.reduce((s, b) => s + b.amount, 0)
  };
}

// ---- N4 年化合计：月均订阅额 × 12 ----
function annualized(userId) {
  const active = listFor(userId).filter(s => s.status !== 'cancelled');
  const monthly = active.reduce((s, x) => s + (x.cycle === 'yearly' ? Math.round(x.amount / 12)
    : x.cycle === 'quarterly' ? Math.round(x.amount / 3)
    : x.cycle === 'weekly' ? x.amount * 4 : x.amount), 0);
  return { activeCount: active.length, monthlyCents: monthly, yearlyCents: monthly * 12 };
}

// ---- N3 到期前提醒：未来 days 天内将扣费的活跃订阅 ----
function upcomingCharges(userId, days = 3) {
  const limit = Date.now() + days * DAY;
  return listFor(userId)
    .filter(s => s.status === 'active')
    .filter(s => { const t = dayOf(s.nextChargeAt); return t != null && t <= limit && t >= Date.now(); })
    .sort((a, b) => dayOf(a.nextChargeAt) - dayOf(b.nextChargeAt));
}

// ---- N5 免费试用转付费预警：首月低价起步，后续统一正价 ----
function trialRisk(userId) {
  const db = store.get();
  const bills = (db.bills || []).filter(b => b.userId === userId && b.amount > 0 && b.source !== 'deposit');
  const byM = new Map();
  for (const b of bills) {
    const k = String(b.merchant || '').trim();
    if (!k || NOT_SUBSCRIPTION.test(k)) continue;
    if (!byM.has(k)) byM.set(k, []);
    byM.get(k).push(b);
  }
  const out = [];
  for (const [m, list] of byM) {
    const sorted = list.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (sorted.length < 3) continue;
    const first = sorted[0].amount;
    const rest = sorted.slice(1);
    const regular = rest[rest.length - 1].amount;
    // 首笔显著低价（不足正价一半），且后续金额统一 → 「试用转付费」高风险
    if (first < regular * 0.5 && rest.every(x => x.amount === regular)) {
      out.push({
        merchant: m, firstCharge: first, regularCharge: regular,
        firstChargeAt: sorted[0].date, switchAt: rest[0].date,
        profile: (db.merchantProfiles || {})[m] || null
      });
    }
  }
  return out;
}

// ---- N1 申诉涨价差价（P1）：照抄 reportDuplicate 的结构，写入 disputes ----
function reportHike(userId, merchant, note) {
  const db = store.get();
  const hike = detectPriceHike(userId).find(h => h.merchant === merchant);
  if (!hike) return { ok: false, message: `「${merchant}」未检测到涨价` };
  if (!db.disputes) db.disputes = [];
  const d = {
    id: 'dh' + uid().slice(0, 8), userId, subscriptionId: hike.merchant, merchant: hike.merchant,
    amount: hike.current, baseline: hike.baseline, hikePct: hike.hikePct, note: note || '',
    status: 'processing', createdAt: Date.now(), type: 'price_hike',
    evidence: hike.priceTrail
  };
  db.disputes.push(d);
  return { ok: true, dispute: d, message: `已受理对「${merchant}」的涨价申诉（涨幅 ${hike.hikePct}%），将核对价格轨迹后退还差价。` };
}

module.exports = {
  detectFor, seedFor, listFor, cancelImpact, savingHook, cancel, reportDuplicate,
  detectPriceHike, trace, annualized, upcomingCharges, trialRisk, reportHike,
  CYCLE_DAYS, CYCLE_LABEL
};
