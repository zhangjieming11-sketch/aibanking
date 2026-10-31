'use strict';
// JSON 文件存储：参赛演示用，零依赖、可持久化、重启不丢数据
const fs = require('fs');
const path = require('path');
const { hashPassword, chainHash, auditPayload } = require('./util');
const contacts = require('./contacts');

// 数据目录可用 BANK_DATA_DIR 覆盖：测试用独立目录，不污染演示数据
const DATA_DIR = process.env.BANK_DATA_DIR
  ? path.resolve(process.env.BANK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let db = null;
let saveTimer = null;

// 确定性伪随机数（mulberry32）：演示账单可复现，避免 Math.random 抖动导致
// 每次重置后「可行性诊断」结论忽左忽右（一次 tight 一次 infeasible）。按 userId 取不同种子。
function rnd(seed) {
  let s = seed >>> 0;
  return function () {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function seedBills(userId) {
  // 生成近 6 个月演示账单（2026-05 ~ 10），含少量异常大额消费供"异常标红"演示。
  // 量级经校准：月支出中位数约 ¥13,000–14,000，使「明年3月云南旅行 ¥15,000/4个月」诊断结论
  // 稳定落在「可行，但很紧」（而非「不可行」或「宽裕」），且订阅占比始终是小头（R<20%）。
  const rand = rnd(20261000 + userId);
  const cats = [
    { name: '餐饮', merchants: ['美团外卖', '麦当劳', '海底捞', '瑞幸咖啡', '全家便利店'], min: 27, max: 270 },
    { name: '交通', merchants: ['滴滴出行', '地铁乘车码', '高德打车'], min: 9, max: 90 },
    { name: '购物', merchants: ['京东商城', '淘宝', '天猫超市'], min: 90, max: 720 },
    { name: '居住', merchants: ['物业费', '电费充值', '水费'], min: 90, max: 480 },
    { name: '娱乐', merchants: ['猫眼电影', '网易云音乐', 'Steam'], min: 36, max: 340 },
  ];
  const bills = [];
  let id = 1;
  for (const month of [5, 6, 7, 8, 9, 10]) {
    const days = new Date(2026, month, 0).getDate();
    for (let day = 1; day <= days; day++) {
      const count = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < count; i++) {
        const c = cats[Math.floor(rand() * cats.length)];
        const m = c.merchants[Math.floor(rand() * c.merchants.length)];
        let amount = Math.round((c.min + rand() * (c.max - c.min)) * 100);
        bills.push({
          id: 'b' + (id++), userId,
          date: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          merchant: m, category: c.name, amount,
          source: 'seed', note: ''
        });
      }
    }
  }
  // 两条异常大额（用于"异常消费标红"演示）
  bills.push({ id: 'b9998', userId, date: '2026-09-18', merchant: '某奢侈品电商', category: '购物', amount: 880000, source: 'seed', note: '异常大额' });
  bills.push({ id: 'b9999', userId, date: '2026-09-25', merchant: '境外网站扣款', category: '购物', amount: 660000, source: 'seed', note: '异常大额' });
  return bills;
}

// 订阅商户画像（N2 扣款溯源的数据源）：
// billingType: fixed 固定计费（可进 N1 涨价检测）/ usage 按量计费（价格波动属正常，跳过）
const MERCHANT_PROFILES = {
  '云视视频会员': { legalName: '云视网络科技有限公司', channel: '快捷支付 · 银联', signAt: '2026-03-12', agreementEntry: '云视视频App → 我的 → 订阅管理', category: 'video', billingType: 'fixed' },
  '悦听音乐': { legalName: '悦听文化传媒有限公司', channel: '免密支付 · 微信', signAt: '2026-01-05', agreementEntry: '悦听音乐App → 设置 → 会员中心', category: 'music', billingType: 'fixed' },
  '云盘存储 Pro': { legalName: '云储科技（深圳）有限公司', channel: '快捷支付 · 银联', signAt: '2026-02-20', agreementEntry: '云盘App → 账户 → 自动续费管理', category: 'cloud', billingType: 'fixed' },
  '健身会员': { legalName: '跃动健身管理有限公司', channel: '免密支付 · 支付宝', signAt: '2026-05-30', agreementEntry: '跃动健身App → 我的 → 会员与自动续费', category: 'sports', billingType: 'fixed' },
  '阅读会员': { legalName: '墨阅数字阅读科技有限公司', channel: '免密支付 · 微信', signAt: '2026-05-12', agreementEntry: '墨阅App → 我的 → 会员自动续费', category: 'reading', billingType: 'fixed' }
};

// 订阅扣费历史（N1 涨价检测的数据源）：落进 bills，让 detectFor / detectPriceHike 有真实轨迹可依。
// 云视视频会员：前 3 期 ¥9.9，后 5 期 ¥39（涨幅 294%，命中「续费刺客」）；
// 悦听音乐 / 云盘存储 Pro：全程稳定（负样本，不应误报）。
function seedSubscriptionBills(userId) {
  const DAY = 86400000;
  const today = new Date();
  const iso = d => new Date(today.getTime() - d * DAY).toISOString().slice(0, 10);
  const trail = (merchant, points) => points.map((p, i) => ({
    id: 'sb' + userId + '_' + merchant.replace(/\s/g, '').slice(0, 4) + '_' + i,
    userId, date: iso(p.daysAgo), merchant, category: '订阅', amount: p.amount, source: 'subscription', note: ''
  }));
  const out = [];
  const yunshi = [];
  for (let i = 0; i < 8; i++) yunshi.push({ daysAgo: 12 + 30 * (7 - i), amount: i < 3 ? 990 : 3900 });
  out.push(...trail('云视视频会员', yunshi));
  const yuet = []; for (let i = 0; i < 6; i++) yuet.push({ daysAgo: 12 + 30 * (5 - i), amount: 1500 });
  out.push(...trail('悦听音乐', yuet));
  const yp = []; for (let i = 0; i < 6; i++) yp.push({ daysAgo: 12 + 30 * (5 - i), amount: 900 });
  out.push(...trail('云盘存储 Pro', yp));
  // 健身会员：最后一次扣费在 28 天前 → nextChargeAt ≈ 2 天后，用于 N3「到期前 T-3 提醒」演示
  const gym = []; for (let i = 0; i < 4; i++) gym.push({ daysAgo: 28 + 30 * (3 - i), amount: 9900 });
  out.push(...trail('健身会员', gym));
  // 阅读会员：首月 ¥1 → 后续 ¥19.9，用于 N5「免费试用转付费预警」演示（不是续费刺客）
  const read = [{ daysAgo: 162, amount: 100 }];
  for (let i = 0; i < 5; i++) read.push({ daysAgo: 12 + 30 * (4 - i), amount: 1990 });
  out.push(...trail('阅读会员', read));
  return out;
}

// 收入种子：近 6 个月每月 1 号工资入账 ¥18,000（source=deposit，供消费规划现金流引擎取数）。
// 只统计为「收入」，不参与支出占比（账单页与订阅识别都按支出口径）。
function seedIncome(userId) {
  const today = new Date();
  const out = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    // 用本地年月日（不用 toISOString，避免 UTC 偏移把 10-01 落成 09-30）
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({
      id: 'inc' + userId + '_' + i, userId, date,
      merchant: '工资入账', category: '工资', amount: 1800000, source: 'deposit', note: ''
    });
  }
  return out;
}

function seed() {
  const now = Date.now();
  return {
    nextUserId: 3,
    users: [
      {
        id: 1, phone: '13800000001', name: '小明', riskLevel: 'C3', isDemo: true,
        passwordHash: hashPassword('demo1234'), payPasswordHash: hashPassword('123456'),
        tokenVersion: 1, createdAt: now,
        limits: { single: 5000000, daily: 20000000 }, // 单笔 5万 / 单日 20万（分）
        payeeBlacklist: ['黑客', 'hacker']
      },
      {
        id: 2, phone: '13800000002', name: '小红', riskLevel: 'C2', isDemo: true,
        passwordHash: hashPassword('demo1234'), payPasswordHash: hashPassword('123456'),
        tokenVersion: 1, createdAt: now,
        limits: { single: 5000000, daily: 20000000 },
        payeeBlacklist: ['黑客', 'hacker']
      }
    ],
    accounts: [
      { userId: 1, balance: 1285600 }, // ¥12,856.00
      { userId: 2, balance: 654300 }   // ¥6,543.00
    ],
    cards: [
      { id: 'c1', userId: 1, name: '工资卡', number: '6222020200112233445', frozen: false, isDefault: true },
      { id: 'c2', userId: 1, name: '日常卡', number: '6222600011009988776', frozen: false, isDefault: false },
      { id: 'c3', userId: 2, name: '储蓄卡', number: '6222800055667788990', frozen: false, isDefault: true }
    ],
    transfers: [],
    scheduled: [],   // 定时转账任务
    aaGroups: [],    // AA 转账
    bills: [...seedBills(1), ...seedBills(2), ...seedSubscriptionBills(1), ...seedSubscriptionBills(2), ...seedIncome(1), ...seedIncome(2)],
    merchantProfiles: MERCHANT_PROFILES,
    products: [
      { id: 'p1', name: '现金宝·零钱理财', type: '货币基金', risk: 'R1', rate: 2.1, minCents: 100, term: 'T+0 随时可取' },
      { id: 'p2', name: '安鑫定期 90 天', type: '定期理财', risk: 'R2', rate: 2.8, minCents: 100000, term: '90 天锁定期' },
      { id: 'p3', name: '稳利债券基金', type: '债券基金', risk: 'R2', rate: 3.4, minCents: 1000, term: '开放申赎' },
      { id: 'p4', name: '平衡混合基金', type: '混合基金', risk: 'R3', rate: 5.2, minCents: 10000, term: '开放申赎' },
      { id: 'p5', name: '成长股票基金', type: '股票基金', risk: 'R4', rate: 8.1, minCents: 10000, term: '开放申赎' },
      { id: 'p6', name: '全球配置 FOF', type: 'FOF', risk: 'R4', rate: 7.2, minCents: 50000, term: '开放申赎' },
      { id: 'p7', name: '高收益增强组合', type: '组合策略', risk: 'R5', rate: 10.5, minCents: 100000, term: '开放申赎' }
    ],
    holdings: [
      { id: 'h1', userId: 1, productId: 'p1', amount: 500000, at: now - 30 * 86400000 }
    ],
    riskAnswers: [],
    // 收款人可信通讯录（语义绕过防御）：演示账户预置四种路径：正常/混淆/拒绝/低限额
    contacts: [...contacts.seedFor(1), ...contacts.seedFor(2)],
    approvals: [],       // 一次性授权单
    standingAuths: [],   // 持续性授权（定时任务）
    smsCodes: [],        // 演示短信（页面直接展示，不真实发送）
    auditLogs: [],       // 审计日志（每条含 prev_hash / hash，构成哈希链）
    auditChainHead: null,// 审计链当前链尾哈希（下一条的 prev_hash）
    idempotency: {},     // 幂等键 → { transferId, at }，重复提交同一授权单只执行一次
    nextIds: { transfer: 1, approval: 1, aa: 1, holding: 2, audit: 1, standing: 1 }
  };
}

// 老库结构升级：补齐新增字段，避免历史 db.json 启动即报错
function migrate(d) {
  if (!Array.isArray(d.auditLogs)) d.auditLogs = [];
  // 历史日志没有哈希链 → 按现有顺序重算一遍，保证审计链从一开始就完整可校验
  if (d.auditLogs.some(l => !l.hash)) {
    let prev = null;
    for (const l of d.auditLogs) {
      l.prev_hash = prev || 'GENESIS';
      l.hash = chainHash(prev, auditPayload(l));
      prev = l.hash;
    }
    d.auditChainHead = prev;
  }
  if (typeof d.auditChainHead === 'undefined') {
    const last = d.auditLogs[d.auditLogs.length - 1];
    d.auditChainHead = (last && last.hash) || null;
  }
  if (!d.idempotency || typeof d.idempotency !== 'object') d.idempotency = {};
  if (!d.nextIds) d.nextIds = { transfer: 1, approval: 1, aa: 1, holding: 2, audit: 1, standing: 1 };
  if (!Array.isArray(d.standingAuths)) d.standingAuths = [];
  if (!Array.isArray(d.approvals)) d.approvals = [];
  if (!Array.isArray(d.transfers)) d.transfers = [];
  // 老库没有通讯录 → 给每个已有用户补一份种子（否则升级后转账全部解析失败）
  if (!Array.isArray(d.contacts)) d.contacts = [];
  if (!d.contacts.length && Array.isArray(d.users)) {
    for (const u of d.users) d.contacts.push(...contacts.seedFor(u.id));
  }
  // A3 / A6 新增集合（老库升级时补齐，避免代码到处判空）
  if (!Array.isArray(d.subscriptions)) d.subscriptions = [];
  if (!Array.isArray(d.memories)) d.memories = [];
  if (!Array.isArray(d.plans)) d.plans = [];
  if (!Array.isArray(d.calendar)) d.calendar = [];
  if (!Array.isArray(d.orders)) d.orders = [];
  if (!Array.isArray(d.notifications)) d.notifications = [];
  if (!Array.isArray(d.disputes)) d.disputes = [];
  if (!d.virtualClocks || typeof d.virtualClocks !== 'object') d.virtualClocks = {};
  // 会话槽位 / 上下文对象栈（内存态，但也落盘，便于跨请求续接）
  if (!d.sessions || typeof d.sessions !== 'object') d.sessions = {};
  if (!d.ctx || typeof d.ctx !== 'object') d.ctx = {};
  // 演示账号没有订阅数据时补种（仅演示账号，不污染新注册用户）
  if (!d.subscriptions.length && Array.isArray(d.users)) {
    const subs = require('./subscriptions');
    for (const u of d.users.filter(x => x.phone === '13800000001' || x.phone === '13800000002')) {
      d.subscriptions.push(...subs.seedFor(u.id));
    }
  }
  // 订阅商户画像（N2 扣款溯源）：老库没有则补默认画像
  if (!d.merchantProfiles || typeof d.merchantProfiles !== 'object') d.merchantProfiles = MERCHANT_PROFILES;
  // 订阅扣费历史（N1 涨价检测需要价格轨迹）：按商户确保演示账户的历史齐全，缺哪个补哪个
  if (!Array.isArray(d.bills)) d.bills = [];
  if (Array.isArray(d.users)) {
    const NEED = ['云视视频会员', '悦听音乐', '云盘存储 Pro', '健身会员', '阅读会员'];
    for (const u of d.users.filter(x => x.phone === '13800000001' || x.phone === '13800000002')) {
      const has = m => d.bills.some(b => b.userId === u.id && b.merchant === m && b.source === 'subscription');
      if (!NEED.every(has)) {
        d.bills.push(...seedSubscriptionBills(u.id).filter(b => !has(b.merchant)));
      }
    }
  }
  // 收入种子（消费规划现金流引擎需要）：演示账户缺工资入账则补种
  if (Array.isArray(d.users)) {
    for (const u of d.users.filter(x => x.phone === '13800000001' || x.phone === '13800000002')) {
      if (!d.bills.some(b => b.userId === u.id && b.source === 'deposit' && b.category === '工资')) {
        d.bills.push(...seedIncome(u.id));
      }
    }
  }
  // v6：老库没有 isDemo 字段 → 按种子手机号回填（与订阅补种同源判定）
  if (Array.isArray(d.users)) {
    for (const u of d.users) {
      if (typeof u.isDemo === 'undefined') {
        u.isDemo = (u.phone === '13800000001' || u.phone === '13800000002');
      }
    }
  }
  return d;
}

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = migrate(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
      return db;
    } catch (e) { /* 损坏则重建 */ }
  }
  db = migrate(seed()); // 全新安装同样要过迁移：否则演示账号没有订阅（A3 全场景失效）
  save();
  return db;
}

function save() {
  // 防抖落盘 + 临时文件原子替换，避免写坏
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 100);
}

function get() {
  if (!db) load();
  return db;
}

function reset() { // 演示重置（危险操作，仅本人可调用）
  // 必须走一遍 migrate：seed() 不含订阅/计划等集合，这些是由 migrate 按演示账号补种的。
  // 只 db = seed() 会让「重置后」的演示账号丢失订阅（A3 全场景直接失效），必须重启才恢复。
  db = migrate(seed());
  save();
}

module.exports = { load, get, save, reset };
