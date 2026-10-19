'use strict';
// ============ 统一限速器（U-01 / U-16 / U-17 / U-30）============
// 三种场景共用一套内存计数：登录爆破、支付凭证试错、风险测评刷等级。
// 进程内计数，重启即清空 —— 演示系统足够；生产环境应换成 Redis（见 docs/安全加固方案_v2.1.md）。
//
// 设计要点：
//   1. 计数窗口 + 锁定窗口分离：窗口内失败达上限 → 锁定一段时间
//   2. 锁定期内即使密码正确也先被拦（防"边锁边试"），由调用方决定是否放行
//   3. 提供 remaining()，让前端可以提示"还可尝试 N 次"

const RULES = {
  // 账号登录：10 分钟内连续失败 5 次 → 锁 5 分钟
  login:        { max: 5, windowMs: 10 * 60 * 1000, lockMs: 5 * 60 * 1000 },
  // 同一 IP 登录：10 分钟内失败 15 次 → 锁 10 分钟（比账号阈值宽，避免误伤共用出口）
  loginIp:      { max: 15, windowMs: 10 * 60 * 1000, lockMs: 10 * 60 * 1000 },
  // 支付凭证（支付密码 + 验证码共用）：10 分钟内失败 5 次 → 冻结 15 分钟
  pay:          { max: 5, windowMs: 10 * 60 * 1000, lockMs: 15 * 60 * 1000 },
  // 风险测评：24 小时内最多 3 次
  assess:       { max: 3, windowMs: 24 * 60 * 60 * 1000, lockMs: 24 * 60 * 60 * 1000 }
};

const buckets = new Map();
const MAX_KEYS = 5000;

function ruleOf(kind) {
  return RULES[kind] || { max: 10, windowMs: 60 * 1000, lockMs: 60 * 1000 };
}

function keyOf(kind, key) {
  return kind + ':' + String(key == null ? 'unknown' : key);
}

function prune() {
  if (buckets.size <= MAX_KEYS) return;
  const t = Date.now();
  for (const [k, rec] of buckets) {
    if ((!rec.lockedUntil || rec.lockedUntil <= t) && t - rec.firstAt > ruleOf(k.split(':')[0]).windowMs) buckets.delete(k);
  }
  // 仍然超量则按最旧淘汰
  if (buckets.size > MAX_KEYS) {
    const keys = Array.from(buckets.keys()).slice(0, buckets.size - MAX_KEYS);
    for (const k of keys) buckets.delete(k);
  }
}

// 检查是否被锁：{ ok, retryAfter }  retryAfter 单位秒
function guard(kind, key) {
  const rec = buckets.get(keyOf(kind, key));
  if (!rec) return { ok: true, remaining: ruleOf(kind).max };
  const t = Date.now();
  if (rec.lockedUntil && rec.lockedUntil > t) {
    return { ok: false, locked: true, retryAfter: Math.ceil((rec.lockedUntil - t) / 1000) };
  }
  if (rec.lockedUntil && rec.lockedUntil <= t) {
    buckets.delete(keyOf(kind, key));
    return { ok: true, remaining: ruleOf(kind).max };
  }
  if (t - rec.firstAt > ruleOf(kind).windowMs) {
    buckets.delete(keyOf(kind, key));
    return { ok: true, remaining: ruleOf(kind).max };
  }
  return { ok: true, remaining: Math.max(0, ruleOf(kind).max - rec.count) };
}

// 记录一次失败：{ count, locked, remaining, retryAfter }
function fail(kind, key) {
  const rule = ruleOf(kind);
  const k = keyOf(kind, key);
  const t = Date.now();
  let rec = buckets.get(k);
  if (!rec || t - rec.firstAt > rule.windowMs) rec = { count: 0, firstAt: t, lockedUntil: 0 };
  rec.count++;
  let locked = false;
  if (rec.count >= rule.max) {
    rec.lockedUntil = t + rule.lockMs;
    locked = true;
  }
  buckets.set(k, rec);
  prune();
  return {
    count: rec.count,
    locked,
    remaining: Math.max(0, rule.max - rec.count),
    retryAfter: locked ? Math.ceil(rule.lockMs / 1000) : 0
  };
}

function reset(kind, key) {
  buckets.delete(keyOf(kind, key));
}

// 当前计数（风险测评这类"按窗口累计次数"的场景直接读它）
function countOf(kind, key) {
  const rec = buckets.get(keyOf(kind, key));
  if (!rec) return 0;
  if (Date.now() - rec.firstAt > ruleOf(kind).windowMs) { buckets.delete(keyOf(kind, key)); return 0; }
  return rec.count;
}

function stats() {
  const out = {};
  for (const [k, rec] of buckets) {
    const kind = k.split(':')[0];
    out[kind] = (out[kind] || 0) + 1;
  }
  return { keys: buckets.size, byKind: out };
}

function resetAll() {
  buckets.clear();
}

module.exports = { RULES, guard, fail, reset, countOf, stats, resetAll };
