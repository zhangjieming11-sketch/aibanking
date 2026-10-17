'use strict';
// ============ 并发竞态回归测试（U-19 / U-33）============
// 用法：先 node server.js，再 node tests/run_race.js
//
// 为什么单独一个脚本：
//   smoke.js 是「顺序跑一遍主流程」，会天然避开竞态；竞态必须在同一时刻打出多个请求
//   才可能复现。本脚本每个用例都用 Promise.all 并发提交，并断言「只成功一次」。
//
// 每个用例独立开一个临时账户（phone 139xxxx + 随机后缀），互不干扰、可重复跑。

const BASE = process.env.BANK_BASE || 'http://localhost:3000';

function mkClient() {
  let token = '';
  return {
    get token() { return token; },
    async call(path, method, body, tk) {
      const res = await fetch(BASE + path, {
        method: method || 'GET',
        headers: { 'Content-Type': 'application/json', ...((tk === undefined ? token : tk) ? { 'X-Token': tk === undefined ? token : tk } : {}) },
        body: method === 'POST' ? JSON.stringify(body || {}) : undefined
      });
      let j; try { j = await res.json(); } catch (e) { j = { ok: false, message: 'not json' }; }
      return j;
    },
    async login(phone, password) {
      const r = await this.call('/api/auth/login', 'POST', { phone, password });
      if (r.token) token = r.token;
      return r;
    }
  };
}

let pass = 0, fail = 0;
const lines = [];
function check(name, ok, detail) {
  if (ok) { pass++; lines.push(`  ✅ ${name}${detail ? '   ' + detail : ''}`); }
  else { fail++; lines.push(`  ❌ ${name}${detail ? '   ' + detail : ''}`); }
}

// ---- 造一个干净的测试账户 ----
async function makeAccount(tag) {
  const c = mkClient();
  const phone = '139' + String(Date.now()).slice(-6) + String(Math.floor(Math.random() * 90) + 10);
  const reg = await c.call('/api/auth/register', 'POST', { phone, password: 'race1234', name: '并发测试' + tag });
  if (!reg.ok) throw new Error('注册失败：' + (reg.message || ''));
  await c.login(phone, 'race1234');
  // 新用户默认无支付密码：设置一个
  await c.call('/api/security/paypass', 'POST', { payPassword: '123456' });
  return { c, phone };
}

async function balance(c) {
  const o = await c.call('/api/overview');
  return o.balance;
}

async function latestSms(c) {
  const s = await c.call('/api/security/overview');
  return (s.smsInbox && s.smsInbox[0] && s.smsInbox[0].code) || null;
}

(async () => {
  console.log('');
  console.log('  AgentBank · 并发竞态回归（U-19 双花 / U-33 重复退款）');
  console.log('  ' + '─'.repeat(58));

  // ============================================================
  // 用例 1：同一授权单并发确认 10 次 → 只允许扣款一次
  // ============================================================
  try {
    const { c } = await makeAccount('A');
    const before = await balance(c);
    const ap = await c.call('/api/ops/request', 'POST', { action: 'transfer.execute', params: { toName: '小红', amount: '300' } });
    if (!ap.ok || !ap.approval) throw new Error('授权单创建失败：' + JSON.stringify(ap));
    const sms = await latestSms(c);

    // 10 个请求在同一 tick 内全部打出（不 await 中间结果）
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      c.call('/api/approvals/' + ap.approval.id + '/confirm', 'POST', { payPassword: '123456', smsCode: sms })
    ));
    const success = results.filter(r => r.ok && !r.idempotent && !r.deduped);
    const deduped = results.filter(r => r.deduped || r.idempotent);
    const busy = results.filter(r => r.busy);
    const after = await balance(c);
    const deducted = before - after;

    check('U-19 并发确认 10 次：真实扣款次数 = 1',
      success.length === 1,
      `真实执行 ${success.length} 次 / 幂等返回 ${deduped.length} / 并发拒绝 ${busy.length}`);
    check('U-19 并发确认 10 次：余额只扣一次 300 元',
      deducted === 30000,
      `实际扣款 ¥${(deducted / 100).toFixed(2)}`);
  } catch (e) { check('U-19 并发确认', false, '异常：' + e.message); }

  // ============================================================
  // 用例 2：同一笔大额转账并发撤销 10 次 → 只允许退款一次
  // ============================================================
  try {
    const { c } = await makeAccount('B');
    const ap = await c.call('/api/ops/request', 'POST', { action: 'transfer.execute', params: { toName: '小红', amount: '2000' } });
    const sms = await latestSms(c);
    const conf = await c.call('/api/approvals/' + ap.approval.id + '/confirm', 'POST', { payPassword: '123456', smsCode: sms });
    if (!conf.ok || !conf.transferId) throw new Error('前置转账失败：' + JSON.stringify(conf));
    const mid = await balance(c);

    const revs = await Promise.all(Array.from({ length: 10 }, () =>
      c.call('/api/transfers/' + conf.transferId + '/revoke', 'POST')
    ));
    const okRev = revs.filter(r => r.ok);
    const after = await balance(c);

    check('U-33 并发撤销 10 次：成功退款次数 = 1',
      okRev.length === 1,
      `成功 ${okRev.length} 次`);
    check('U-33 并发撤销 10 次：余额只回补一次 2000 元',
      after - mid === 200000,
      `实际回补 ¥${((after - mid) / 100).toFixed(2)}`);
  } catch (e) { check('U-33 并发撤销', false, '异常：' + e.message); }

  // ============================================================
  // 用例 3：并发触发调度器 → 同一笔定时任务只执行一次
  // ============================================================
  try {
    const { c } = await makeAccount('C');
    const before = await balance(c);
    const sd = await c.call('/api/ops/request', 'POST', { action: 'scheduled.create', params: { toName: '小红', amount: '100', freq: 'once' } });
    const sms = await latestSms(c);
    const conf = await c.call('/api/approvals/' + (sd.approval && sd.approval.id) + '/confirm', 'POST', { payPassword: '123456', smsCode: sms });
    if (!conf.ok) throw new Error('定时任务创建失败：' + JSON.stringify(conf));

    const ticks = await Promise.all(Array.from({ length: 8 }, () => c.call('/api/scheduler/tick', 'POST')));
    const fired = ticks.reduce((s, t) => s + ((t.fired || []).filter(x => x.ok).length), 0);
    const after = await balance(c);

    check('并发调度 8 次：定时任务只执行 1 次',
      fired === 1 && before - after === 10000,
      `执行 ${fired} 次，扣款 ¥${((before - after) / 100).toFixed(2)}`);
  } catch (e) { check('并发调度', false, '异常：' + e.message); }

  // ============================================================
  // 用例 4：并发确认 × 并发撤销混打 → 总额守恒（不因顺序错乱多退/少退）
  // ============================================================
  try {
    const { c } = await makeAccount('D');
    const before = await balance(c);
    const ap = await c.call('/api/ops/request', 'POST', { action: 'transfer.execute', params: { toName: '小红', amount: '1500' } });
    const sms = await latestSms(c);
    const conf = await c.call('/api/approvals/' + ap.approval.id + '/confirm', 'POST', { payPassword: '123456', smsCode: sms });
    if (!conf.ok) throw new Error('前置转账失败');

    // 同一笔同时发起多路撤销 + 对已用授权单的重复确认
    await Promise.all([
      ...Array.from({ length: 5 }, () => c.call('/api/transfers/' + conf.transferId + '/revoke', 'POST')),
      ...Array.from({ length: 5 }, () => c.call('/api/approvals/' + ap.approval.id + '/confirm', 'POST', { payPassword: '123456', smsCode: sms }))
    ]);
    const after = await balance(c);
    const diff = before - after;
    // 合法结果只有两种：撤销成功 → 净额 0；撤销失败 → 净额 1500
    check('U-19+U-33 混打：资金总额守恒（无非预期增减）',
      diff === 0 || diff === 150000,
      `净变动 ¥${(diff / 100).toFixed(2)}`);
  } catch (e) { check('混打资金守恒', false, '异常：' + e.message); }

  console.log(lines.join('\n'));
  console.log('  ' + '─'.repeat(58));
  console.log(`  通过 ${pass} / 失败 ${fail}`);
  console.log(fail === 0 ? '  结论：并发竞态已收敛，无重复扣款/重复退款。' : '  结论：存在竞态，禁止发布。');
  console.log('');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试脚本异常：' + e.message); process.exit(2); });
