'use strict';
// ============ 会话槽位 + 上下文对象栈 ============
// 解决的问题：
//   1) 「给妈妈转」→ 追问金额 → 用户答「100」→ 系统说「请说完整」。
//      不是模型笨，是上一轮的槽位没人存。这里把「正在填的表单」结构化存下来。
//   2) 「买它」「赎回那个」没法解析，因为只有一个 lastPayee。
//      这里给四类对象各留一个栈顶。
//
// 为什么不用「把对话历史塞给 LLM」：
//   历史会膨胀、会把被拦截的文本再喂回去（注入面），而且不可审计。
//   结构化槽位既能续接，又能在审计里看清「用户到底确认了什么」。
const store = require('./store');

const TTL = 5 * 60 * 1000;   // 5 分钟没继续就作废（与授权单一致，避免旧槽位吞掉后来的新指令）

// ---- 槽位解析：只认「明确的值」，认不出就返回 null，让调用方继续追问 ----
const SLOT_PARSERS = {
  amount: (t) => {
    const s = String(t).trim();
    const m = s.match(/^(\d{1,9}(?:\.\d{1,2})?)\s*(?:元|块|rmb)?$/i);
    if (!m) return null;
    const n = Number(m[1]);
    return n > 0 ? String(n) : null;
  },
  toName: (t) => {
    const s = String(t).trim();
    // 人名不会太长，也不会带动词/疑问词。放宽会把「上个月花了多少钱」当成人名填进槽位。
    if (!/^[\u4e00-\u9fa5A-Za-z]{1,6}$/.test(s)) return null;
    if (/[多少几怎哪吗呢吧啊了吧花钱查买卖转付存余额账单消费推荐理财冻结解冻挂失额度订阅扣费计划惊喜生日转账收款]/.test(s)) return null;
    if (/^(元|块|好|嗯|对|是|不|可以|确认|行|ok)$/i.test(s)) return null;
    return s;
  },
  productName: (t) => {
    const s = String(t).trim();
    return s.length >= 2 && s.length <= 20 ? s : null;
  },
  // 收款人真实姓名（中文/字母，允许中间点，如「欧阳娜娜」）
  realName: (t) => {
    const s = String(t).trim();
    return /^[\u4e00-\u9fa5A-Za-z·]{2,12}$/.test(s) ? s : null;
  },
  // 对方卡号 / 我方卡号：12–19 位数字（允许带空格/横线，自动剥离）
  account: (t) => {
    const s = String(t).replace(/[\s-]/g, '');
    return /^\d{12,19}$/.test(s) ? s : null;
  },
  phone: (t) => {
    const s = String(t).replace(/[\s-]/g, '');
    return /^1\d{10}$/.test(s) ? s : null;
  },
  // 卡号：12–19 位数字（允许夹在「工资卡 6222...」这类一句话里，抽取数字段）
  number: (t) => {
    const m = String(t).match(/(\d{12,19})/);
    return m ? m[1] : null;
  },
  // 卡片名标签（如「工资卡」）
  name: (t) => {
    const s = String(t).trim();
    return /^[\u4e00-\u9fa5A-Za-z]{1,10}$/.test(s) ? s : null;
  }
};

function ensure() {
  const db = store.get();
  if (!db.sessions || typeof db.sessions !== 'object') db.sessions = {};
  if (!db.ctx || typeof db.ctx !== 'object') db.ctx = {};
  return db;
}

function get(userId) {
  const db = ensure();
  const s = db.sessions[userId];
  if (!s) return null;
  if (Date.now() - s.ts > TTL) { delete db.sessions[userId]; return null; }
  return s;
}

function start(userId, action, slots, missing, question) {
  const db = ensure();
  const s = { action, slots: Object.assign({}, slots), missing: missing.slice(), question: question || '', ts: Date.now() };
  db.sessions[userId] = s;
  return s;
}

function update(userId, s) {
  const db = ensure();
  s.ts = Date.now();
  db.sessions[userId] = s;
  return s;
}

function clear(userId) {
  const db = ensure();
  delete db.sessions[userId];
}

// 尝试把一句话填进「第一个缺失槽位」；填不上返回 null
function tryFill(userId, text) {
  const s = get(userId);
  if (!s || !s.missing.length) return null;
  const slot = s.missing[0];
  const parser = SLOT_PARSERS[slot];
  if (!parser) return null;
  const v = parser(text);
  if (v == null) return null;
  s.slots[slot] = v;
  s.missing = s.missing.filter(x => x !== slot);
  update(userId, s);
  return s;
}

// ---- 上下文对象栈 ----
function setObject(userId, kind, obj) {
  const db = ensure();
  const c = db.ctx[userId] || {};
  c[kind] = Object.assign({ at: Date.now() }, obj);
  c.lastKind = kind;
  c.lastAt = Date.now();
  db.ctx[userId] = c;
  return c[kind];
}

function getObject(userId, kind) {
  const db = ensure();
  const c = db.ctx[userId];
  if (!c) return null;
  const o = c[kind];
  if (!o) return null;
  // 对象也要过期，避免「半小时前说的那个」被误指
  if (Date.now() - (o.at || 0) > TTL) return null;
  return o;
}

function lastKind(userId) {
  const db = ensure();
  const c = db.ctx[userId];
  if (!c || !c.lastKind) return null;
  if (Date.now() - (c.lastAt || 0) > TTL) return null;
  return c.lastKind;
}

// 「它 / 这个 / 那个」：返回最近一次被提到的对象
const PRONOUN = /(它|这个|那个|这只|那只|这款|那款|就它|就这个|就那个|刚才那个|刚才那只)/;

function isPronoun(text) {
  return PRONOUN.test(String(text || ''));
}

function recent(userId) {
  const kind = lastKind(userId);
  if (!kind) return null;
  const obj = getObject(userId, kind);
  if (!obj) return null;
  return { kind, obj };
}

// 根据第一个缺失槽位生成追问句（调用方不用各写一份）
function questionFor(s) {
  if (!s || !s.missing || !s.missing.length) return '';
  const slot = s.missing[0];
  const name = s.slots && s.slots.toName;
  if (slot === 'toName') return '要转给谁？';
  if (slot === 'amount') return name ? `要给「${name}」转多少？` : '要转多少？';
  if (slot === 'total') return 'AA 总共多少钱？';
  if (slot === 'productName') return '想买哪一只？';
  if (slot === 'realName') return '对方的真实姓名？';
  if (slot === 'account') return '对方的银行卡号（12–19 位数字）？';
  if (slot === 'phone') return '对方的手机号（11 位）？';
  if (slot === 'name') return '给这张卡起个名字（如「工资卡」）？';
  if (slot === 'number') return '卡号是多少（12–19 位数字）？';
  return '还差一项信息，能补充一下吗？';
}

// ---- 候选选择（同名歧义 / 多候选）：用户必须自己指认是哪一位 ----
// 存的是**候选对象快照**而非候选列表本身：TTL 短、用户选完即清，
// 且选中的 contactId 仍要回到通讯录重新取当前 trust —— 快照只用来回答「第几位是谁」，
// 不能当授权依据。
function setCandidates(userId, kind, candidates, slots) {
  const db = ensure();
  const c = db.ctx[userId] || {};
  c.candidates = { kind, list: candidates, slots: slots || {}, at: Date.now() };
  db.ctx[userId] = c;
  return c.candidates;
}

function getCandidates(userId) {
  const db = ensure();
  const c = db.ctx[userId];
  if (!c || !c.candidates) return null;
  if (Date.now() - (c.candidates.at || 0) > TTL) { delete c.candidates; return null; }
  return c.candidates;
}

function clearCandidates(userId) {
  const db = ensure();
  const c = db.ctx[userId];
  if (c) delete c.candidates;
}

// 「第 2 位 / 第二个 / 2」都认；返回 0-based 下标，认不出返回 -1
function parsePick(text) {
  const s = String(text == null ? '' : text).trim();
  const m = s.match(/^(?:转给|就|选|要)?\s*第?\s*([1-9])\s*(?:位|个|号)?$/)
    || s.match(/(?:转给|就|选|要)\s*第?\s*([1-9])\s*(?:位|个|号)/);
  if (!m) return -1;
  return Number(m[1]) - 1;
}

module.exports = {
  TTL, get, start, update, clear, tryFill, questionFor,
  setObject, getObject, lastKind, recent, isPronoun, PRONOUN,
  setCandidates, getCandidates, clearCandidates, parsePick
};
