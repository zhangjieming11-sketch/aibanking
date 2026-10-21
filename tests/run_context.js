'use strict';
/**
 * 上下文能力：会话槽位 + 对象栈
 * 用法：node tests/run_context.js
 *
 * 1) 多轮填槽：说一半被追问，补一个数字就能继续，不用整句重说
 * 2) 查询不打断填槽
 * 3) 对象栈：「买它」能落到刚才推荐的那只
 * 4) 对象栈：「取消它」能落到刚才列出的订阅
 * 5) 无上下文时不瞎猜
 */
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3215);
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
const failures = [];
let server = null;
const PAY_PASS = String.fromCharCode(56, 56, 56, 56, 56, 56);

function ok(name, cond, ev) {
  if (cond) { pass++; console.log(`  ✅ ${name}` + (ev ? `   ${ev}` : '')); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}` + (ev ? `   ${ev}` : '')); }
}
async function req(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Token'] = token;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, data };
}
const chat = (token, message) => req('POST', '/api/agent/chat', { message }, token);

async function waitReady(ms) {
  const deadline = Date.now() + (ms || 15000);
  while (Date.now() < deadline) {
    try { const r = await fetch(BASE + '/'); if (r.ok) return true; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  console.log('\n=== 上下文能力：会话槽位 + 对象栈 ===\n');
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore'
  });
  const cleanup = () => { try { if (server) server.kill(); } catch (e) { /* ignore */ } };
  process.on('exit', cleanup);
  if (!await waitReady()) { console.log('服务未就绪'); cleanup(); process.exit(1); }

  const stamp = String(Date.now()).slice(-8);
  const phone = '134' + stamp;
  const password = 'test1234';
  await req('POST', '/api/auth/register', { phone, name: '上下文' + stamp.slice(-4), password });
  const token = (await req('POST', '/api/auth/login', { phone, password })).data.token;
  await req('POST', '/api/security/paypass', { oldPayPass: '', payPassword: PAY_PASS }, token);

  // ============ 1. 多轮填槽 ============
  console.log('[1] 多轮填槽：说一半能被追问，补一句就继续');
  const a1 = await chat(token, '给妈妈转');
  ok('缺金额时追问而不是报错', /要给「妈妈」转多少|转多少/.test(a1.data.text || ''), (a1.data.text || '').split('\n')[0]);
  ok('没有生成半成品授权单', !a1.data.approval);

  const a2 = await chat(token, '100');
  ok('只回「100」就能接上', !!(a2.data.approval && a2.data.approval.action === 'transfer.execute'),
    a2.data.approval ? `金额 ${a2.data.approval.params.amount} → ${a2.data.approval.params.toName}` : (a2.data.text || '').slice(0, 40));

  // ============ 2. 查询不打断填槽 ============
  console.log('\n[2] 填槽过程中查个余额，不应把槽位冲掉');
  const b1 = await chat(token, '给房东转');
  ok('再次进入填槽', /房东/.test(b1.data.text || ''), (b1.data.text || '').split('\n')[0]);
  const b2 = await chat(token, '查一下余额');
  ok('中间查询正常回答', /余额/.test(b2.data.text || ''), (b2.data.text || '').slice(0, 30));
  const b3 = await chat(token, '50');
  ok('槽位仍在，补数字即可继续', !!(b3.data.approval && b3.data.approval.action === 'transfer.execute'),
    b3.data.approval ? `金额 ${b3.data.approval.params.amount}` : (b3.data.text || '').slice(0, 40));

  // ============ 3. 对象栈：买它 ============
  console.log('\n[3] 对象栈：「买它」落到刚才推荐的那只');
  const noCtx = await chat(token, '买它');
  ok('没有上下文时不瞎猜', !noCtx.data.approval && /哪一只|推荐/.test(noCtx.data.text || ''),
    (noCtx.data.text || '').slice(0, 30));

  await req('POST', '/api/wealth/assess', { answers: [3, 3, 3, 3, 3] }, token);
  const rec = await chat(token, '推荐一下理财');
  const first = (rec.data.products || [])[0];
  ok('推荐返回产品列表', !!first, first ? `${first.name}` : '无');

  const buy = await chat(token, '买它');
  ok('「买它」解析到推荐的首只产品', !!(buy.data.approval && buy.data.approval.action === 'wealth.subscribe'),
    buy.data.approval ? `productId=${buy.data.approval.params.productId}` : (buy.data.text || '').slice(0, 40));
  ok('productId 与推荐一致', !!(buy.data.approval && first && buy.data.approval.params.productId === first.id));

  // ============ 4. 对象栈：取消它 ============
  console.log('\n[4] 对象栈：「取消它」落到刚才列出的订阅');
  const subs = await chat(token, '我有哪些自动扣费');
  const firstSub = (subs.data.subscriptions || [])[0];
  ok('订阅列表返回', !!firstSub, firstSub ? firstSub.merchant : '无');
  const cancel = await chat(token, '取消它');
  ok('「取消它」解析到首个订阅',
    !!(cancel.data.approval && cancel.data.approval.action === 'subscription.cancel'),
    cancel.data.approval ? `subscriptionId=${cancel.data.approval.params.subscriptionId}` : (cancel.data.text || '').slice(0, 40));

  console.log('\n' + '─'.repeat(60));
  console.log(`通过 ${pass} / 失败 ${fail}`);
  console.log(fail ? '结论：未达标 ❌' : '结论：会话槽位 + 对象栈全部达标 ✅');
  console.log('─'.repeat(60) + '\n');
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { if (server) server.kill(); } catch (x) { /* ignore */ } process.exit(1); });
