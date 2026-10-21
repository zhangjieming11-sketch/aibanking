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
  return '还差一项信息，能补充一下吗？';
}

module.exports = {
  TTL, get, start, update, clear, tryFill, questionFor,
  setObject, getObject, lastKind, recent, isPronoun, PRONOUN
};
