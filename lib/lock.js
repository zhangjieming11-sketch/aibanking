'use strict';
// ============ 并发控制：内存互斥锁 ============
// 解决的攻击：U-19「授权单并发双花」、U-33「并发撤销重复退款」
//
// 为什么需要它：
//   Node 是单线程，但「读 → 判断 → 写」之间只要有一次 await，事件循环就会切去处理别的请求。
//   原来 confirmAndExecute 是同步函数、调用方 await 了它，整个「检查状态 → 扣款 → 改状态」
//   在同一轮事件循环里跑完，所以天然安全；但一旦临界区里出现 await（例如以后加异步的
//   支付密码校验、外部风控查询），两个并发请求就会同时通过 status==='pending' 检查，
//   导致同一张授权单扣两次钱。本模块把这种「隐式安全」变成「显式保证」。
//
// 三层保护（从内到外，逐层加强）：
//   ① 幂等键      —— 同一个授权单 ID 只执行一次（banking.doTransfer）
//   ② 状态前置    —— 临界区第一件事就把 pending 改成 processing，后来者读到的已不是 pending
//   ③ 互斥锁      —— 本模块，保证同一时刻只有一个请求在临界区内
//
// 生产环境提醒：进程内锁只能防「单实例并发」。多实例部署必须换成
//   数据库行锁（SELECT ... FOR UPDATE）或 Redis 分布式锁，否则两把锁各在各的进程里，等于没锁。

// ---- 同步临界区 ----
// 用于「纯内存计算 + 无需 await」的代码段。JS 单线程下同步执行不可被打断，
// 因此这里不需要真的加锁，只做「不可重入」检查：若在临界区内又调用 sync()，说明代码写错了，
// 直接抛错，而不是悄悄产生嵌套副作用。
let inSync = false;
function sync(fn) {
  if (inSync) throw new Error('LOCK_REENTRANT: 临界区内不允许再次进入同步临界区');
  inSync = true;
  try {
    return fn();
  } finally {
    inSync = false;
  }
}

// ---- 异步互斥锁 ----
// 用于临界区内含 await 的代码段。同一把锁同一时刻只允许一个持有者；
// 后来的请求默认「立即失败」而不是排队等待 —— 对资金操作来说，
// 让用户看到「该操作正在处理中，请勿重复提交」比让他等 3 秒再扣一次钱安全得多。
const held = new Map();   // name -> { since, token }

async function mutex(name, fn, opts) {
  const o = opts || {};
  const key = String(name);
  const prev = held.get(key);
  if (prev) {
    return {
      ok: false,
      busy: true,
      message: o.busyMessage || '该操作正在处理中，请勿重复提交（并发保护已生效）',
      holderSince: prev.since
    };
  }
  const token = Symbol(key);
  held.set(key, { since: Date.now(), token });
  try {
    return await fn();
  } finally {
    const cur = held.get(key);
    if (cur && cur.token === token) held.delete(key); // 只释放自己持有的锁
  }
}

// ---- 观测（供安全驾驶舱展示「并发保护已生效」）----
function stats() {
  return { holding: held.size, names: [...held.keys()] };
}

module.exports = { sync, mutex, stats };
