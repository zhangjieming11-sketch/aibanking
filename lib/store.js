'use strict';
// JSON 文件存储：参赛演示用，零依赖、可持久化、重启不丢数据
const fs = require('fs');
const path = require('path');
const { hashPassword, chainHash, auditPayload } = require('./util');
const contacts = require('./contacts');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let db = null;
let saveTimer = null;

function seedBills(userId) {
  // 生成近 3 个月演示账单（2026-07 / 08 / 09），含少量异常大额消费供"异常标红"演示
  const cats = [
    { name: '餐饮', merchants: ['美团外卖', '麦当劳', '海底捞', '瑞幸咖啡', '全家便利店'], min: 15, max: 180 },
    { name: '交通', merchants: ['滴滴出行', '地铁乘车码', '高德打车'], min: 4, max: 60 },
    { name: '购物', merchants: ['京东商城', '淘宝', '天猫超市'], min: 50, max: 600 },
    { name: '居住', merchants: ['物业费', '电费充值', '水费'], min: 60, max: 300 },
    { name: '娱乐', merchants: ['猫眼电影', '网易云音乐', 'Steam'], min: 20, max: 200 },
  ];
  const bills = [];
  let id = 1;
  for (const month of [7, 8, 9]) {
    const days = new Date(2026, month, 0).getDate();
    for (let day = 1; day <= days; day++) {
      const count = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        const c = cats[Math.floor(Math.random() * cats.length)];
        const m = c.merchants[Math.floor(Math.random() * c.merchants.length)];
        let amount = Math.round((c.min + Math.random() * (c.max - c.min)) * 100);
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

function seed() {
  const now = Date.now();
  return {
    nextUserId: 3,
    users: [
      {
        id: 1, phone: '13800000001', name: '小明', riskLevel: 'C3',
        passwordHash: hashPassword('demo1234'), payPasswordHash: hashPassword('123456'),
        tokenVersion: 1, createdAt: now,
        limits: { single: 5000000, daily: 20000000 }, // 单笔 5万 / 单日 20万（分）
        payeeBlacklist: ['黑客', 'hacker']
      },
      {
        id: 2, phone: '13800000002', name: '小红', riskLevel: 'C2',
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
    bills: [...seedBills(1), ...seedBills(2)],
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
  db = seed();
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
  db = seed();
  save();
}

module.exports = { load, get, save, reset };
