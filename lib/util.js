'use strict';
const crypto = require('crypto');

const SECRET = 'agent-bank-demo-secret-key-2026';

// 授权单签名密钥：只存在于服务端进程，随代码部署，任何人（含 LLM、任何客户端）都拿不到。
// 授权单里只存签名结果，不存密钥——即使数据库被读走，也无法为篡改后的参数补出新签名。
const SIGN_KEY = process.env.APPROVAL_SIGN_KEY || 'agent-bank-approval-hmac-key-v2-2026';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return salt + ':' + h;
}

function verifyPassword(pw, stored) {
  try {
    const [salt, h] = String(stored).split(':');
    const h2 = crypto.scryptSync(String(pw), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(h2, 'hex'));
  } catch (e) { return false; }
}

// 轻量 JWT（HMAC-SHA256），仅用于登录态，不代表任何资金权限
function signToken(payload) {
  payload.exp = Date.now() + 2 * 3600 * 1000;
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyToken(token) {
  try {
    const [body, sig] = String(token).split('.');
    const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
    if (sig !== expect) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}

// ============ 授权单参数签名（HMAC-SHA256）============
// 安全判定必须用带密钥的 HMAC，而不是无密钥的裸 hash：
//   · 裸 hash 是「可公开计算」的——攻击者拿到参数就能自己算出同样的哈希，进而伪造出一致的指纹；
//   · HMAC 的密钥只在服务端，攻击者无法为篡改后的参数生成合法签名。
// 因此本文件不再向安全判定暴露任何无密钥摘要。

// 参数规范化：字段排序 + null 统一，保证同一业务参数序列化结果稳定可复现
function canonical(params) {
  const o = params || {};
  const keys = Object.keys(o).sort();
  const norm = {};
  for (const k of keys) norm[k] = o[k] === undefined || o[k] === null ? '' : String(o[k]);
  return JSON.stringify(norm);
}

// 对「动作 + 参数」做服务端 HMAC 签名
function signParams(action, params) {
  return crypto.createHmac('sha256', SIGN_KEY)
    .update(String(action) + '|' + canonical(params))
    .digest('hex');
}

// 恒定时间比对，防时序侧信道
function verifyParams(action, params, sig) {
  const expect = signParams(action, params);
  const a = Buffer.from(String(sig || ''), 'utf8');
  const b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

// 人眼可核对的授权单指纹（由服务端签名派生）：展示为 7F3A·9C21
function fingerprint(sig) {
  const s = String(sig || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (s.length < 8) return '--------';
  return s.slice(0, 4) + '·' + s.slice(4, 8);
}

// 审计链哈希：hash = HMAC(prev_hash | 本条内容)，把审计日志串成不可静默篡改的链
function chainHash(prevHash, payload) {
  return crypto.createHmac('sha256', SIGN_KEY)
    .update(String(prevHash || 'GENESIS') + '|' + String(payload))
    .digest('hex');
}

// 审计条目的规范化载荷：任一字段被改动，重算出的 hash 都会对不上
function auditPayload(log) {
  const l = log || {};
  return [l.id, l.t, l.userId, l.actor, l.action, l.result, l.note || ''].join('|');
}

function uid() {
  return crypto.randomUUID();
}

function smsCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function yuan(cents) {
  return (cents / 100).toFixed(2);
}

function toCents(str) {
  const n = parseFloat(String(str).replace(/[,，\s]/g, ''));
  if (isNaN(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function maskPhone(phone) {
  return String(phone).replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
}

function maskCard(no) {
  const s = String(no).replace(/\s/g, '');
  return s.length >= 8 ? s.slice(0, 4) + ' **** ' + s.slice(-4) : '****';
}

module.exports = {
  hashPassword, verifyPassword, signToken, verifyToken,
  signParams, verifyParams, fingerprint, chainHash, auditPayload, canonical,
  uid, smsCode, yuan, toCents, maskPhone, maskCard
};
