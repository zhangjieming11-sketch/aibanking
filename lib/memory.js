'use strict';
// ============ A6.1 · 强 schema 长期记忆 ============
// 为什么不用自由文本记忆：LLM 一旦能自由写入「用户说他喜欢 X」，
// 下次就会自己编一条出来。这里只允许**白名单 key + 校验过的值**，
// 写入即落库，读取即原文，没有推理空间 —— 这是「零幻觉」的实现方式，不是靠提示词。
const store = require('./store');
const { uid } = require('./util');

const SCHEMA = {
  'family.birthday.spouse': { label: '爱人生日', type: 'date' },
  'family.birthday.child': { label: '孩子生日', type: 'date' },
  'family.birthday.parent': { label: '父母生日', type: 'date' },
  'family.anniversary': { label: '结婚纪念日', type: 'date' },
  'preference.cake': { label: '蛋糕口味', type: 'text', maxLen: 20 },
  'preference.drink': { label: '常喝饮品', type: 'text', maxLen: 20 },
  'finance.goal': { label: '理财目标', type: 'text', maxLen: 30 }
};

const ALIAS = [
  [/(爱人|老婆|老公|媳妇|先生|太太).{0,4}生日/, 'family.birthday.spouse'],
  [/(孩子|儿子|女儿|宝宝).{0,4}生日/, 'family.birthday.child'],
  [/(父母|爸妈|爸爸|妈妈|父亲|母亲).{0,4}生日/, 'family.birthday.parent'],
  [/(结婚|纪念日)/, 'family.anniversary'],
  [/(蛋糕).{0,4}(口味|喜欢|爱)/, 'preference.cake'],
  [/(喝|饮品|咖啡|茶)/, 'preference.drink'],
  [/(理财目标|攒钱|存钱).{0,4}(为了|目标)/, 'finance.goal']
];

// 只接受 MM-DD / MM月DD日 / YYYY-MM-DD，其余一律拒绝（不做「猜一个最近的日期」）
function normalizeDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return pad(m[2]) + '-' + pad(m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (m) return pad(m[1]) + '-' + pad(m[2]);
  m = s.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?$/);
  if (m) return pad(m[1]) + '-' + pad(m[2]);
  return null;
}

function pad(n) {
  const v = Number(n);
  if (!(v >= 1 && v <= 12) && v !== 0) return String(n);
  return String(v).padStart(2, '0');
}

function validate(key, rawValue) {
  const def = SCHEMA[key];
  if (!def) return { ok: false, message: `不支持记住「${key}」这类信息（仅支持：${Object.values(SCHEMA).map(d => d.label).join('、')}）` };
  if (def.type === 'date') {
    const v = normalizeDate(rawValue);
    if (!v) return { ok: false, message: `${def.label}格式不正确，请用「10月28日」或「10-28」这样的写法` };
    const [mm, dd] = v.split('-').map(Number);
    if (!(mm >= 1 && mm <= 12) || !(dd >= 1 && dd <= 31)) return { ok: false, message: `${def.label}不是有效日期` };
    return { ok: true, value: v };
  }
  const v = String(rawValue == null ? '' : rawValue).trim();
  if (!v) return { ok: false, message: `${def.label}不能为空` };
  if (v.length > (def.maxLen || 20)) return { ok: false, message: `${def.label}太长了，请控制在 ${def.maxLen} 个字以内` };
  return { ok: true, value: v };
}

function write(userId, key, rawValue, opts) {
  const db = store.get();
  const chk = validate(key, rawValue);
  if (!chk.ok) return chk;
  if (!db.memories) db.memories = [];
  const now = Date.now();
  const exists = db.memories.find(m => m.userId === userId && m.key === key);
  if (exists) {
    const before = exists.value;
    exists.value = chk.value;
    exists.updatedAt = now;
    return { ok: true, key, value: chk.value, label: SCHEMA[key].label, updated: true, before, source: (opts && opts.source) || 'user' };
  }
  const rec = { id: 'mm' + uid().slice(0, 8), userId, key, value: chk.value, createdAt: now, updatedAt: now, source: (opts && opts.source) || 'user' };
  db.memories.push(rec);
  return { ok: true, key, value: chk.value, label: SCHEMA[key].label, updated: false, id: rec.id, source: rec.source };
}

function read(userId, key) {
  const db = store.get();
  const m = (db.memories || []).find(x => x.userId === userId && x.key === key);
  if (!m) return { found: false, key, label: (SCHEMA[key] || {}).label || key };
  return { found: true, key, label: SCHEMA[key].label, value: m.value, updatedAt: m.updatedAt, id: m.id };
}

function listFor(userId) {
  const db = store.get();
  return (db.memories || []).filter(m => m.userId === userId)
    .map(m => ({ key: m.key, label: (SCHEMA[m.key] || {}).label || m.key, value: m.value, updatedAt: m.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// 从自然语言里认 key；认不出就返回 null，由调用方追问，绝不猜
function guessKey(text) {
  const t = String(text || '');
  for (const [re, key] of ALIAS) if (re.test(t)) return key;
  return null;
}

// 从一句话里抽出「要记的值」（日期优先）
function extractValue(text) {
  const t = String(text || '');
  const d = t.match(/(\d{1,2})\s*[月.\-/]\s*(\d{1,2})\s*[日号]?/);
  if (d) return pad(d[1]) + '-' + pad(d[2]);
  return null;
}

function remove(userId, key) {
  const db = store.get();
  const i = (db.memories || []).findIndex(m => m.userId === userId && m.key === key);
  if (i < 0) return { ok: false, message: '没有这条记忆' };
  const [m] = db.memories.splice(i, 1);
  return { ok: true, key, label: (SCHEMA[key] || {}).label, value: m.value };
}

module.exports = { SCHEMA, ALIAS, normalizeDate, validate, write, read, listFor, guessKey, extractValue, remove };
