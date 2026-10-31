'use strict';
// ============ N1 涨价检测 · 双向门禁 ============
// 只测命中率会把产品逼成噪音制造机：正样本（真涨价）全命中 + 负样本（正常波动）全放行，
// 两者同时达标才算过（沿用 run_attacks.js 的 70+25 双向机制）。
const path = require('path');
process.env.BANK_DATA_DIR = path.join(__dirname, '..', 'data_price_hike_test');
const store = require('../lib/store');
const subs = require('../lib/subscriptions');

const DAY = 86400000;
const today = new Date();
const iso = d => new Date(today.getTime() - d * DAY).toISOString().slice(0, 10);
const USER = 99999;

// amounts 从旧到新，间隔约 30 天
function trail(merchant, amounts) {
  return amounts.map((amt, i) => ({
    id: 't' + merchant.replace(/\W/g, '') + i, userId: USER,
    date: iso((amounts.length - i) * 30),
    merchant, category: '订阅', amount: amt, source: 'subscription', note: ''
  }));
}

const db = store.get();
db.bills = [];
db.merchantProfiles = Object.assign({}, db.merchantProfiles || {}, {
  '云存储按量A': { billingType: 'usage' },
  '话费按量B': { billingType: 'usage' }
});

const positives = [];
const negatives = [];

// 正样本 15：真涨价（前 3 笔低价，后 5 笔高价，涨幅 150%）
for (let i = 0; i < 15; i++) {
  const m = '涨价商户' + i;
  const base = 1000 + i * 50;
  const cur = Math.round(base * 2.5);
  db.bills.push(...trail(m, [base, base, base, cur, cur, cur, cur, cur]));
  positives.push(m);
}
// 负样本 5：稳定价格
for (let i = 0; i < 5; i++) { const m = '稳定商户' + i; db.bills.push(...trail(m, [1000, 1000, 1000, 1000, 1000, 1000])); negatives.push(m); }
// 负样本 3：小幅调价 12%（< 20%）
for (let i = 0; i < 3; i++) { const m = '小幅调价' + i; db.bills.push(...trail(m, [2500, 2500, 2500, 2800, 2800, 2800, 2800, 2800])); negatives.push(m); }
// 负样本 2：按量计费（usage，价格波动正常）
for (const m of ['云存储按量A', '话费按量B']) { db.bills.push(...trail(m, [900, 900, 900, 1800, 1800, 1800, 1800, 1800])); negatives.push(m); }
// 负样本 2：电商大促（NOT_SUBSCRIPTION 排除）
for (const m of ['淘宝旗舰店', '京东商城']) { db.bills.push(...trail(m, [5000, 5000, 5000, 800, 800, 800, 800, 800])); negatives.push(m); }
// 负样本 3：试用转付费（首月 ¥1 → 正价 ¥25，归 N5 不归 N1）
for (let i = 0; i < 3; i++) { const m = '试用转付费' + i; db.bills.push(...trail(m, [100, 2500, 2500, 2500, 2500, 2500, 2500, 2500])); negatives.push(m); }

const hikes = subs.detectPriceHike(USER);
const hitSet = new Set(hikes.map(h => h.merchant));

const posMiss = positives.filter(m => !hitSet.has(m));
const negFalse = negatives.filter(m => hitSet.has(m));

console.log(`正样本（真涨价）：${positives.length} 命中 ${positives.length - posMiss.length} 漏检 ${posMiss.length}`);
console.log(`负样本（正常波动）：${negatives.length} 放行 ${negatives.length - negFalse.length} 误报 ${negFalse.length}`);
if (posMiss.length) console.log('  漏检：', posMiss.join('、'));
if (negFalse.length) console.log('  误报：', negFalse.join('、'));

const ok = posMiss.length === 0 && negFalse.length === 0;
console.log(ok ? '✅ 涨价检测双向门禁通过' : '❌ 门禁未通过');
process.exit(ok ? 0 : 1);
