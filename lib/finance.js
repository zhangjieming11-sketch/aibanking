'use strict';
// ============ 智能财务管理 · 消费分析层 ============
// 纯函数、只读、可单测：不落盘、不碰资金、不调用任何写接口。
// 唯一数据来源是 db.bills（支出流水），与「收入 / 余额」严格隔离——
// 拿支出数字回答「工资多少」是答非所问，这里也只统计支出。
const store = require('./store');
const { yuan } = require('./util');
const subscriptions = require('./subscriptions');   // A3 · 订阅/自动扣费（严谨识别，供订阅建议复用）

// 把任意周期的订阅金额折算成「每月」
function toMonthly(sub) {
  const c = sub.cycle;
  if (c === 'yearly') return Math.round(sub.amount / 12);
  if (c === 'quarterly') return Math.round(sub.amount / 3);
  if (c === 'weekly') return Math.round(sub.amount * 4);
  return sub.amount; // monthly
}

// 取「有数据的近 N 个月」（YYYY-MM，升序）。
// 演示种子账单是历史月份（2026-07/08/09），当前月可能为空——
// 分析必须落在真实有数据的区间，否则页面一片空白。
// 排除「转账」类：资金划转不是消费，混入会污染占比与趋势。
function recentMonthsWithData(userId, months) {
  const db = store.get();
  const set = new Set(
    (db.bills || [])
      .filter(b => b.userId === userId && b.source !== 'deposit' && b.category !== '转账')
      .map(b => b.date.slice(0, 7))
  );
  return Array.from(set).sort().reverse().slice(0, Math.max(1, months || 3)).reverse();
}

function analyzeSpending(userId, months) {
  const db = store.get();
  const range = recentMonthsWithData(userId, months || 3);
  if (!range.length) {
    return { ok: true, empty: true, range: [], total: 0, avgMonthly: 0, months: 0,
      categories: [], monthly: [], topMerchants: [], anomalies: [], subscriptions: [], advice: [], summary: '近几个月暂无可分析的账单数据。' };
  }

  const bills = (db.bills || [])
    .filter(b => b.userId === userId && b.source !== 'deposit' && b.category !== '转账' && range.includes(b.date.slice(0, 7)));

  const cats = {};          // 分类 -> 金额
  const catMonth = {};      // 分类 -> { month: 金额 }
  const monthsAgg = {};     // month -> { total, byCat }
  const merchants = {};     // 商户 -> { amount, count, months:Set }
  for (const b of bills) {
    const m = b.date.slice(0, 7);
    cats[b.category] = (cats[b.category] || 0) + b.amount;
    (catMonth[b.category] = catMonth[b.category] || {})[m] = (catMonth[b.category][m] || 0) + b.amount;
    monthsAgg[m] = monthsAgg[m] || { total: 0, byCat: {} };
    monthsAgg[m].total += b.amount;
    monthsAgg[m].byCat[b.category] = (monthsAgg[m].byCat[b.category] || 0) + b.amount;
    const me = merchants[b.merchant] = merchants[b.merchant] || { amount: 0, count: 0, months: new Set() };
    me.amount += b.amount; me.count += 1; me.months.add(m);
  }

  const total = bills.reduce((s, b) => s + b.amount, 0);
  const avgMonthly = Math.round(total / range.length);
  const totalCat = total || 1;

  const last = range[range.length - 1];
  const prev = range[range.length - 2];
  const categories = Object.entries(cats).map(([name, amount]) => {
    const cur = catMonth[name][last] || 0;
    const pre = prev ? (catMonth[name][prev] || 0) : 0;
    // 仅当相邻两月都有该类消费才算环比；任一为空（如最新月无此类）置 null，避免 -100% 误导
    const momPct = (pre && cur) ? Math.round((cur - pre) / pre * 100) : null;
    return { name, amount, pct: Math.round(amount / totalCat * 1000) / 10, momPct };
  }).sort((a, b) => b.amount - a.amount);

  const monthly = range.map(m => ({
    month: m, total: monthsAgg[m].total,
    byCategory: Object.entries(monthsAgg[m].byCat)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount)
  }));

  const topMerchants = Object.entries(merchants)
    .map(([name, me]) => ({ name, amount: me.amount, count: me.count }))
    .sort((a, b) => b.amount - a.amount).slice(0, 5);

  // 异常大额：金额 > max(区间均值 * 3, ¥500)，与账单页 anomaly 规则同源
  const avg = bills.length ? total / bills.length : 0;
  const anomalies = bills
    .filter(b => b.amount > Math.max(avg * 3, 50000))
    .map(b => ({ id: b.id, date: b.date, merchant: b.merchant, amount: b.amount }));

  // 订阅 / 自动扣费：直接复用 A3 的严谨识别（同商户 + 同金额 ±1% + 周期判定，
  // 且排除电商/外卖等周期性消费），比从随机账单硬推断可信得多，也与现有订阅功能联动。
  const subs = subscriptions.listFor(userId).filter(s => s.status === 'active');
  const subsMonthly = subs.reduce((s, x) => s + toMonthly(x), 0);
  const subscriptionsOut = subs.map(s => ({
    merchant: s.merchant, amount: s.amount, cycleLabel: s.cycleLabel,
    monthlyCents: toMonthly(s), nextChargeAt: s.nextChargeAt, duplicateCount: s.duplicateCount || 0
  })).sort((a, b) => b.monthlyCents - a.monthlyCents);

  const advice = buildAdvice({ categories, total, avgMonthly, anomalies, subs, subsMonthly, months: range.length });

  const summary =
    `近 ${range.length} 个月（${range[0]} ~ ${last}）共支出 ¥${yuan(total)}，月均 ¥${yuan(avgMonthly)}。` +
    (categories.length ? `支出前三类：${categories.slice(0, 3).map(c => `${c.name} ¥${yuan(c.amount)}（${c.pct}%）`).join('、')}。` : '') +
    (advice.length ? `建议：${advice[0].text}` : '');

  return { ok: true, empty: false, range, total, avgMonthly, months: range.length,
    categories, monthly, topMerchants, anomalies, subscriptions: subscriptionsOut, advice, summary };
}

// 预算 / 省钱建议：确定性规则，基于占比、异常与真实订阅，不引入任何外部模型
function buildAdvice({ categories, total, avgMonthly, anomalies, subs, subsMonthly, months }) {
  const a = [];
  const food = categories.find(c => c.name === '餐饮');
  const ent = categories.find(c => c.name === '娱乐');
  if (food && food.pct > 30) {
    a.push({ level: 'warn', text: `餐饮支出占比 ${food.pct}%，略高于 30% 的舒适线。若压到 30% 以内，每月约可省 ¥${yuan(Math.max(0, Math.round(food.amount - total * 0.3)))}。` });
  } else if (food) {
    a.push({ level: 'good', text: `餐饮占比 ${food.pct}%，结构合理，继续保持。` });
  }
  if (ent && ent.pct > 15) {
    a.push({ level: 'tip', text: `娱乐支出占 ${ent.pct}%，可结合月度预算适度管控，避免月底吃紧。` });
  }
  if (subs && subs.length) {
    a.push({ level: 'tip', text: `你有 ${subs.length} 项自动扣费，每月约 ¥${yuan(subsMonthly)}（如「${subs[0].merchant}」¥${yuan(toMonthly(subs[0]))}/${subs[0].cycleLabel.replace('每', '')}）。建议核对是否仍需，取消闲置订阅能直接回血现金流；取消后还能一键转入零钱理财。` });
  }
  if (anomalies.length) {
    a.push({ level: 'warn', text: `发现 ${anomalies.length} 笔异常大额消费，建议核实是否为本人操作，必要时可冻结对应卡片。` });
  }
  if (!a.length) {
    a.push({ level: 'good', text: '近期消费结构均衡，未见明显异常。继续保持～' });
  }
  a.push({ level: 'tip', text: `参考月均支出 ¥${yuan(avgMonthly)}，可据此设定月度预算上限，余钱可放入零钱理财（T+0 随时可取）赚取收益。` });
  return a;
}

module.exports = { analyzeSpending, recentMonthsWithData };
