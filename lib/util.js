'use strict';
const crypto = require('crypto');

const SECRET = 'agent-bank-demo-secret-key-2026';

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

// 授权单参数指纹：授权只对"这一张单子"有效，参数变一个字 hash 就对不上
function paramHash(action, params) {
  return crypto.createHash('sha256').update(action + '|' + JSON.stringify(params)).digest('hex');
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

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, paramHash, uid, smsCode, yuan, toCents, maskPhone, maskCard };
