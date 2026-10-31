'use strict';
// ============ 消费规划 · 诊断层（plan.assess，P0 只读）============
// 价值不在「帮用户存钱」，在「告诉用户行不行、要改什么、什么不是瓶颈」。
// 四条纪律（R2 修订）：
//   ① 现金流必须服务端算，绝不让 LLM 估金额（中位数 + 最差月 + 口径）
//   ② 金额标来源：system_estimate（参考区间，非报价）vs user_confirmed（用户确认）
//   ③ 合规红线：目标 <180 天只允许 R1，禁收益承诺
//   ④ 量级门槛：订阅节省占目标比例 R≥20% 才允许作为资金来源，否则只陈述事实、不暗示
const store = require('./store');
const subscriptions = require('./subscriptions');
const { yuan } = require('./util');

const DAY = 86400000;

function median(arr) {
  if (!arr || !arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// 品类参考价表（诚实区间，非报价）：单位 分
const CATEGORY_REF = {
  travel: { label: '旅行', ranges: { default: [1200000, 1500000] } },   // ¥12,000–15,000（对标日本行）
  purchase: { label: '大额购物', ranges: { default: [500000, 1000000] } },
  education: { label: '教育', ranges: { default: [300000, 800000] } },
  medical: { label: '医疗', ranges: { default: [200000, 600000] } },
  other: { label: '其他', ranges: { default: [100000, 500000] } }
};

// 现金流引擎：近 N 个月按月聚合收入/支出，中位数 + 最差月 + 口径
function cashflow(userId, months = 6) {
  const db = store.get();
  const bills = (db.bills || []).filter(b => b.userId === userId);
  const byMonth = {};
  for (const b of bills) {
    const m = String(b.date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) continue;
    byMonth[m] = byMonth[m] || { inc: 0, exp: 0 };
    if (b.source === 'deposit') byMonth[m].inc += b.amount;
    else if (b.amount <= 500000) byMonth[m].exp += b.amount; // 排除单笔异常大额（一次性购买，非常规现金流）
  }
  const keys = Object.keys(byMonth).sort().slice(-months);
  const inc = keys.map(m => byMonth[m].inc);
  const exp = keys.map(m => byMonth[m].exp);
  const cap = keys.map(m => byMonth[m].inc - byMonth[m].exp);
  if (keys.length < 3) return { ok: false, insufficient: true, sampleMonths: keys.length };
  return {
    ok: true, sampleMonths: keys.length, method: 'median_' + keys.length + 'm',
    incomeMedian: median(inc), expenseMedian: median(exp),
    capacityMedian: median(cap), capacityWorst: Math.min(...cap),
    monthly: keys.map((m, i) => ({ month: m, income: inc[i], expense: exp[i], capacity: cap[i] }))
  };
}

// 支出结构透视（月均，订阅单独一类且如实标占比，不特殊高亮）
function expenseStructure(userId, months = 6) {
  const db = store.get();
  const bills = (db.bills || []).filter(b => b.userId === userId && b.source !== 'deposit' && b.amount <= 500000);
  const keys = [...new Set(bills.map(b => b.date.slice(0, 7)))].sort().slice(-months);
  const cats = {};
  for (const b of bills) {
    if (!keys.includes(b.date.slice(0, 7))) continue;
    const c = b.category || '其他';
    cats[c] = (cats[c] || 0) + b.amount;
  }
  const total = Object.values(cats).reduce((s, v) => s + v, 0) || 1;
  const m = Math.max(1, keys.length);
  return Object.entries(cats).map(([name, amount]) => ({
    category: name, monthly: Math.round(amount / m), ratio: Math.round(amount / total * 1000) / 1000
  })).sort((a, b) => b.monthly - a.monthly);
}

// 诊断主入口
function assess(user, opts) {
  const o = opts || {};
  const now = Date.now();
  const category = o.category || 'other';
  const targetDate = o.targetDate || null;
  const targetAmount = (o.targetAmount && Number(o.targetAmount) > 0) ? Number(o.targetAmount) : null; // 分

  const cf = cashflow(user.id, 6);
  if (!cf.ok) {
    return { ok: true, insufficient: true, text: '你的现金流数据不足（近 3 个月收支记录不够），暂时无法测算可行性。可以先在首页「存入」或产生一些消费记录，再让我规划。' };
  }

  // 金额来源：用户确认优先，否则给参考区间（非报价）
  let amountSource = 'user_confirmed';
  let estimateRange = null;
  if (!targetAmount) {
    amountSource = 'system_estimate';
    estimateRange = (CATEGORY_REF[category] || CATEGORY_REF.other).ranges.default;
  }

  const targetTs = targetDate ? Date.parse(String(targetDate) + 'T00:00:00') : null;
  const daysLeft = targetTs ? Math.round((targetTs - now) / DAY) : null;
  const monthsLeft = (daysLeft != null && daysLeft > 0) ? Math.max(1, Math.round(daysLeft / 30)) : 6;

  // 订阅节省（月）与量级门槛
  const subs = subscriptions.listFor(user.id).filter(s => s.status !== 'cancelled');
  const subMonthly = subs.reduce((s, x) => s + (x.cycle === 'yearly' ? Math.round(x.amount / 12)
    : x.cycle === 'quarterly' ? Math.round(x.amount / 3)
    : x.cycle === 'weekly' ? x.amount * 4 : x.amount), 0);

  const structure = expenseStructure(user.id, 6);

  // 可行性（含 10% 缓冲）
  let monthlyNeed = null, feasibility = 'ok';
  if (targetAmount) {
    monthlyNeed = Math.round(targetAmount / monthsLeft * 1.1);
    feasibility = monthlyNeed > cf.capacityMedian * 1.2 ? 'infeasible'
      : monthlyNeed > cf.capacityMedian * 0.7 ? 'tight' : 'ok';
  }

  // 量级门槛 R = (订阅月省 × 剩余月数) / 目标金额
  const subSavingRatio = targetAmount ? (subMonthly * monthsLeft / targetAmount) : 0;
  const subSavingQualified = targetAmount ? subSavingRatio >= 0.20 : false;

  // 杠杆（按真实效力排序：时间 > 目标规模 > 支出结构 > 订阅；订阅排最后且标占比）
  const levers = [];
  if (targetAmount && targetTs) {
    const extendedTs = targetTs + 4 * 30 * DAY;
    const extendedLeft = monthsLeft + 4;
    levers.push({
      type: 'extend_timeline', label: '推迟目标日期', to: new Date(extendedTs).toISOString().slice(0, 10),
      monthlyNeedAfter: Math.round(targetAmount / extendedLeft * 1.1), cost: 'zero',
      desc: `推迟到 ${new Date(extendedTs).toISOString().slice(0, 10)}（${extendedLeft} 个月），每月只需 ¥${yuan(Math.round(targetAmount / extendedLeft * 1.1))}，零成本，最有效`
    });
  }
  if (targetAmount) {
    const reduced = Math.round(targetAmount * 0.8);
    levers.push({
      type: 'reduce_target', label: '缩减目标规模', to: reduced,
      monthlyNeedAfter: Math.round(reduced / monthsLeft * 1.1), cost: 'scope',
      desc: `目标降到 ¥${yuan(reduced)}，每月需 ¥${yuan(Math.round(reduced / monthsLeft * 1.1))}`
    });
  }
  const topCats = structure.filter(s => s.category !== '订阅').slice(0, 2).map(s => s.category);
  if (topCats.length) {
    const cutGain = Math.round(topCats.reduce((s, c) => s + (structure.find(x => x.category === c) || { monthly: 0 }).monthly, 0) * 0.15);
    levers.push({
      type: 'cut_expense', label: '压缩支出结构', categories: topCats, cutRatio: 0.15, monthlyGain: cutGain, cost: 'effort',
      desc: `压缩「${topCats.join('、')}」15%，每月多出 ¥${yuan(cutGain)}`
    });
  }
  if (subSavingQualified) {
    levers.push({
      type: 'subscription', label: '取消订阅', monthlyGain: subMonthly, ratio: subSavingRatio, cost: 'cancel',
      desc: `取消订阅每月可省 ¥${yuan(subMonthly)}（占目标 ${Math.round(subSavingRatio * 100)}%）`
    });
  }

  // 资金来源（受 R 门槛约束：subSavingQualified=false 时不得出现 subscription_saving）
  const fundingSources = [
    { type: 'auto_transfer', amount: monthlyNeed || 0, standingAuthId: null },
    { type: 'existing_balance', amount: 0 }
  ];

  // 合规红线：目标 <180 天只允许 R1（p1 = 现金宝·零钱理财）
  const linkedProductId = (daysLeft != null && daysLeft < 180) ? 'p1' : null;

  return {
    ok: true, category, targetDate, targetAmount, amountSource, estimateRange,
    monthsLeft, monthlyNeed, feasibility, daysLeft,
    cashflow: cf,
    expenseStructure: structure,
    subSaving: { monthlyCents: subMonthly, ratio: subSavingRatio, qualified: subSavingQualified },
    levers, fundingSources, linkedProductId,
    text: buildAssessText({
      category, targetDate, targetAmount, estimateRange, amountSource,
      monthsLeft, monthlyNeed, feasibility, cf, structure,
      subMonthly, subSavingRatio, subSavingQualified, levers
    })
  };
}

// 诚实诊断文案（带口径、带不确定性、不暗示省小钱达大目标）
function buildAssessText(a) {
  const catLabel = (CATEGORY_REF[a.category] || CATEGORY_REF.other).label;
  const lines = [];
  const targetDesc = a.targetAmount
    ? `${catLabel}目标 ¥${yuan(a.targetAmount)}`
    : `${catLabel}（目标金额待确认）`;
  lines.push(`${catLabel}规划：${a.targetDate || '待定日期'}${a.targetAmount ? ` · ${targetDesc}` : ''}`);
  if (a.estimateRange && a.amountSource === 'system_estimate') {
    lines.push(`参考区间 ¥${yuan(a.estimateRange[0])}–${yuan(a.estimateRange[1])}（可修改，非报价）。告诉我一个目标金额，我再测算可行性。`);
  }

  lines.push(`\n你现在的现金流（基于近 ${a.cf.sampleMonths} 个月实际收支，中位数口径）：`);
  lines.push(`  月收入中位数 ¥${yuan(a.cf.incomeMedian)}`);
  lines.push(`  月支出中位数 ¥${yuan(a.cf.expenseMedian)}`);
  lines.push(`  月可支配 ¥${yuan(a.cf.capacityMedian)}（最差的月份只有 ¥${yuan(a.cf.capacityWorst)}）`);

  if (a.targetAmount) {
    lines.push(`\n从现在到目标还有 ${a.monthsLeft} 个月 → 每月需存 ¥${yuan(a.monthlyNeed)}（含 10% 缓冲）`);
    const verdict = a.feasibility === 'ok' ? '可行' : a.feasibility === 'tight' ? '可行，但很紧' : '不可行';
    lines.push(`结论：${verdict}${a.feasibility === 'tight' ? ` —— 这 ${a.monthsLeft} 个月你的月可支配只剩 ¥${yuan(Math.max(0, a.cf.capacityMedian - a.monthlyNeed))}` : ''}`);
  }

  if (a.structure.length) {
    lines.push(`\n你的支出结构（月均）：`);
    lines.push('  ' + a.structure.map(s => `${s.category} ¥${yuan(s.monthly)} (${Math.round(s.ratio * 100)}%)`).join(' · '));
  }

  if (a.levers.length) {
    lines.push(`\n三个真正能改变结论的杠杆（按效力排序）：`);
    a.levers.slice(0, 3).forEach((l, i) => { lines.push(`  ${i + 1}. ${l.desc}`); });
  }

  // 量级门槛的诚实表达：订阅只陈述事实，不暗示它能达成目标
  const subRatioPct = Math.round(a.subSavingRatio * 100);
  if (a.subMonthly > 0) {
    if (a.subSavingQualified) {
      lines.push(`\n你的订阅每月 ¥${yuan(a.subMonthly)}，占本目标 ${subRatioPct}%，可作为资金来源之一。`);
    } else {
      lines.push(`\n订阅只占你月支出的小头（每月 ¥${yuan(a.subMonthly)}，占本目标约 ${subRatioPct}%），砍光也解决不了这个目标——它不是你真正的瓶颈。`);
    }
  }

  return lines.join('\n');
}

// ============ 执行层 · 建单校验（R 门槛 + 合规红线）============
// 这些是「建单层」闸门：任何把诊断落地成可执行计划的入口，都必须先过这两道校验。
// 与诊断层分离，保证校验逻辑可独立单测（tests/run_planning.js）。

// 纪律④ / §2.3.2 量级门槛：R<20% 时 fundingSources 里【不得】出现 subscription_saving。
function validateFunding(fundingSources, subSavingQualified) {
  const list = Array.isArray(fundingSources) ? fundingSources : [];
  const hasSub = list.some(s => s && s.type === 'subscription_saving');
  if (hasSub && !subSavingQualified) {
    return { ok: false, reason: 'R_THRESHOLD', message: '订阅节省占目标不足 20%，不得作为资金来源（省小钱不达大目标）' };
  }
  return { ok: true };
}

// 纪律③ / §2.5③ 合规红线：目标 <180 天只允许 R1，R2+ 建单层直接拒绝（不进网关）。
function validateCompliance(daysLeft, riskLevel) {
  if (daysLeft != null && daysLeft < 180) {
    if (riskLevel && String(riskLevel).toUpperCase() !== 'R1') {
      return { ok: false, reason: 'COMPLIANCE_TERM', message: '目标日期距今不足 180 天，规划期资金只做 R1 流动性管理，不可配置 R2+ 产品' };
    }
  }
  return { ok: true };
}

// §2.4 steps：auto_transfer 恒有；cancel_subs 仅在 R≥20% 时出现（省小钱不进入执行链路）。
function buildSteps(assessResult) {
  const steps = [
    { key: 'auto_transfer', action: 'scheduled.create', label: '按月自动转入', status: 'pending' }
  ];
  if (assessResult && assessResult.subSaving && assessResult.subSaving.qualified) {
    steps.push({ key: 'cancel_subs', action: 'subscription.cancel', label: '取消订阅（覆盖部分资金）', status: 'pending' });
  }
  return steps;
}

// 把诊断结果固化为「可执行计划规格」：重新测算 → 过 R 门槛与合规红线 → 产出资金安排与步骤。
// 不落库（落库由 plans.create 走 P1 授权完成），这里只负责「算得对不对、能不能建」。
function execPlan(user, opts) {
  const o = opts || {};
  const a = assess(user, { category: o.category, targetDate: o.targetDate, targetAmount: o.targetAmount });
  if (a.insufficient) return { ok: false, reason: 'INSUFFICIENT', message: a.text };

  const daysLeft = a.daysLeft;
  const riskLevel = o.riskLevel || null;
  const comp = validateCompliance(daysLeft, riskLevel);
  if (!comp.ok) return { ok: false, reason: comp.reason, message: comp.message };

  // 资金来源：仅 auto_transfer（subscription_saving 只有在 R≥20% 时才可能加入，且由 validateFunding 把关）
  const fundingSources = [
    { type: 'auto_transfer', amount: a.monthlyNeed || 0, standingAuthId: null },
    { type: 'existing_balance', amount: 0 }
  ];
  const fv = validateFunding(fundingSources, a.subSaving.qualified);
  if (!fv.ok) return { ok: false, reason: fv.reason, message: fv.message };

  return {
    ok: true,
    plan: {
      title: o.title || ((CATEGORY_REF[a.category] || CATEGORY_REF.other).label + '规划'),
      category: a.category,
      targetAmount: a.targetAmount,
      targetDate: a.targetDate,
      amountSource: a.amountSource,
      estimateRange: a.estimateRange,
      monthsLeft: a.monthsLeft,
      monthlyNeed: a.monthlyNeed,
      feasibility: a.feasibility,
      linkedProductId: a.linkedProductId,   // <180 天固定 'p1'（R1）
      fundingSources,
      subSaving: a.subSaving,
      steps: buildSteps(a)
    }
  };
}

module.exports = { assess, cashflow, expenseStructure, validateFunding, validateCompliance, buildSteps, execPlan };
