'use strict';
// ============ 消费规划 · 门禁（现金流准确性 + R 门槛 + 合规红线）============
// 覆盖 R2 方案 §3.3 的量级门槛与合规红线用例，双向机制：
//   ① validateFunding / validateCompliance：纯函数，确定性断言
//   ② assess / execPlan：受控数据下的 R 门槛 + 合规红线 + 数据不足诚实回答
const path = require('path');
process.env.BANK_DATA_DIR = path.join(__dirname, '..', 'data_planning_test');
const store = require('../lib/store');
const planning = require('../lib/planning');

const DAY = 86400000;
const USER = 88888;
const iso = d => new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
const isoAhead = d => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

// ---- 受控用户：6 个月现金流（收入 ¥18000/月，支出 ¥13000/月 → 月可支配 ¥5000）----
function setupUser(subsMonthly) {
  const db = store.get();
  db.users = [{
    id: USER, phone: '13800008888', name: '测试用户', riskLevel: 'C3', isDemo: false,
    passwordHash: 'x', payPasswordHash: 'x', tokenVersion: 1, createdAt: Date.now(),
    limits: { single: 5000000, daily: 20000000 }, payeeBlacklist: []
  }];
  db.accounts = [{ userId: USER, balance: 0 }];
  db.bills = [];
  db.subscriptions = [];
  db.merchantProfiles = Object.assign({}, db.merchantProfiles || {});
  const today = new Date();
  // 6 个月收入 + 支出：支出拆成 3 笔（每笔 ≤¥5000，避免被现金流引擎当异常大额排除），
  // 商户逐月变化，避免被订阅识别 detectFor 误判为周期扣费。
  for (let i = 0; i < 6; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    db.bills.push({ id: 'inc' + i, userId: USER, date: ymd, merchant: '工资', category: '工资', amount: 1800000, source: 'deposit', note: '' });
    db.bills.push({ id: 'e1_' + i, userId: USER, date: ymd, merchant: '餐饮' + i, category: '餐饮', amount: 400000, source: 'seed', note: '' });
    db.bills.push({ id: 'e2_' + i, userId: USER, date: ymd, merchant: '购物' + i, category: '购物', amount: 450000, source: 'seed', note: '' });
    db.bills.push({ id: 'e3_' + i, userId: USER, date: ymd, merchant: '居住' + i, category: '居住', amount: 450000, source: 'seed', note: '' });
  }
  if (subsMonthly > 0) {
    db.subscriptions = [{
      id: 'sub_test', userId: USER, merchant: '测试订阅', amount: subsMonthly, cycle: 'monthly', cycleLabel: '每月',
      lastChargedAt: iso(3), nextChargeAt: isoAhead(27), chargedCount: 6, totalCents: subsMonthly * 6,
      origin: 'test', duplicate: null, duplicateCount: 0, status: 'active'
    }];
  }
  return db.users[0];
}

console.log('== 1. 纯函数：R 门槛（validateFunding）==');
assert('R<20% 且 fundingSources 含 subscription_saving → 拒绝',
  planning.validateFunding([{ type: 'subscription_saving', amount: 1 }], false).ok === false);
assert('R<20% 且 fundingSources 不含 subscription_saving → 放行',
  planning.validateFunding([{ type: 'auto_transfer', amount: 1 }], false).ok === true);
assert('R≥20%（qualified）且含 subscription_saving → 放行',
  planning.validateFunding([{ type: 'subscription_saving', amount: 1 }], true).ok === true);
assert('拒绝原因标注为 R_THRESHOLD',
  planning.validateFunding([{ type: 'subscription_saving' }], false).reason === 'R_THRESHOLD');

console.log('== 2. 纯函数：合规红线（validateCompliance）==');
assert('目标 <180 天 + R2 → 拒绝',
  planning.validateCompliance(90, 'R2').ok === false);
assert('目标 <180 天 + R3 → 拒绝',
  planning.validateCompliance(90, 'R3').ok === false);
assert('目标 <180 天 + R1 → 放行',
  planning.validateCompliance(90, 'R1').ok === true);
assert('目标 ≥180 天 + R2 → 放行（不受短期红线约束）',
  planning.validateCompliance(200, 'R2').ok === true);

console.log('== 3. 量级门槛（assess.subSaving.qualified）==');
// 可省 ¥190/月，期限 5 个月
setupUser(19000);
{
  // 目标 ¥3000 → R = 190*5/3000 = 31.7% → qualified
  const r = planning.assess({ id: USER }, { category: 'other', targetDate: isoAhead(150), targetAmount: 300000 });
  assert('目标 ¥3000 / 5个月 / 可省 ¥190 → R≈31.7% 进资金来源（qualified=true）', r.subSaving.qualified === true);
  // 目标 ¥1800 → R = 52.8% → qualified
  const r2 = planning.assess({ id: USER }, { category: 'other', targetDate: isoAhead(150), targetAmount: 180000 });
  assert('目标 ¥1800 / 5个月 / 可省 ¥190 → R≈52.8% 可作主要来源（qualified=true）', r2.subSaving.qualified === true);
  // 目标 ¥13500 → R = 7.0% → 不进资金来源
  const r3 = planning.assess({ id: USER }, { category: 'other', targetDate: isoAhead(150), targetAmount: 1350000 });
  assert('目标 ¥13500 / 5个月 / 可省 ¥190 → R≈7.0% 不进（qualified=false）', r3.subSaving.qualified === false);
  assert('R<20% 时 levers 不含「取消订阅」杠杆', !(r3.levers || []).some(l => l.type === 'subscription'));
}

console.log('== 4. execPlan：合规红线 + 步骤生成 ==');
setupUser(19000);
{
  // <180 天 + 默认（R1）→ 允许，linkedProductId 固定 R1
  const ok = planning.execPlan({ id: USER }, { category: 'other', targetDate: isoAhead(90), targetAmount: 300000 });
  assert('execPlan 目标 <180 天 → linkedProductId = p1（R1）', ok.ok && ok.plan.linkedProductId === 'p1');
  // <180 天 + 请求 R2 → 建单层拒绝
  const rej = planning.execPlan({ id: USER }, { category: 'other', targetDate: isoAhead(90), targetAmount: 300000, riskLevel: 'R2' });
  assert('execPlan 目标 <180 天 + 请求 R2 → 建单层拒绝（COMPLIANCE_TERM）', rej.ok === false && rej.reason === 'COMPLIANCE_TERM');
  // R<20% → steps 不含 cancel_subs
  const big = planning.execPlan({ id: USER }, { category: 'other', targetDate: isoAhead(150), targetAmount: 1350000 });
  assert('R<20% → steps 不含 cancel_subs', big.ok && !(big.plan.steps || []).some(s => s.key === 'cancel_subs'));
  // R≥20% → steps 含 cancel_subs
  const small = planning.execPlan({ id: USER }, { category: 'other', targetDate: isoAhead(150), targetAmount: 300000 });
  assert('R≥20% → steps 含 cancel_subs', small.ok && (small.plan.steps || []).some(s => s.key === 'cancel_subs'));
}

console.log('== 5. 现金流准确性 + 数据不足诚实回答 ==');
{
  const r = planning.assess({ id: USER }, { category: 'other', targetDate: isoAhead(150), targetAmount: 300000 });
  assert('月可支配 = 收入中位数 − 支出中位数（¥5000）', r.cashflow.capacityMedian === 500000);
  assert('带最差月份口径', typeof r.cashflow.capacityWorst === 'number');
  assert('带口径标注 method=median_6m', r.cashflow.method === 'median_6m');
  // 数据不足：只留 2 个月（每月 4 笔：1 收入 + 3 支出）
  const db = store.get();
  db.bills = db.bills.slice(0, 8);
  const insuff = planning.assess({ id: USER }, { category: 'other', targetDate: isoAhead(150), targetAmount: 300000 });
  assert('现金流不足（<3 个月）→ insufficient=true，不编造', insuff.insufficient === true);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 消费规划门禁：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
