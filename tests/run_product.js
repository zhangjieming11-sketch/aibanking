'use strict';
/**
 * 支付密码入口 + 理财内联（体验项 / A5.2 对比卡）
 * 用法：node tests/run_product.js
 */
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3214);
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
  console.log('\n=== 支付密码入口 + 理财内联 ===\n');
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore'
  });
  const cleanup = () => { try { if (server) server.kill(); } catch (e) { /* ignore */ } };
  process.on('exit', cleanup);
  if (!await waitReady()) { console.log('服务未就绪'); cleanup(); process.exit(1); }

  const stamp = String(Date.now()).slice(-8);
  const phone = '135' + stamp;
  const password = 'test1234';
  await req('POST', '/api/auth/register', { phone, name: '体验' + stamp.slice(-4), password });
  const token = (await req('POST', '/api/auth/login', { phone, password })).data.token;

  // ============ 支付密码：动作前置引导 ============
  console.log('[支付密码] 未设置时不应等到确认页才失败');
  const me0 = await req('GET', '/api/me', null, token);
  ok('新用户 hasPayPass=false（前端据此显示提示条）', me0.data.user && me0.data.user.hasPayPass === false);

  const t1 = await chat(token, '给妈妈转 10 元');
  ok('发起资金动作时直接提示设置密码', t1.data.needPayPass === true, (t1.data.text || '').split('\n')[0]);
  ok('没有生成无效授权单', !t1.data.approval);
  ok('说明里讲清「6 位数字 + 与登录不同 + 助手碰不到」',
    /6 位/.test(t1.data.text || '') && /登录密码/.test(t1.data.text || '') && /碰不到/.test(t1.data.text || ''));

  const sp = await req('POST', '/api/security/paypass', { oldPayPass: '', payPassword: PAY_PASS }, token);
  ok('可就地设置支付密码', sp.data.ok === true);
  const me1 = await req('GET', '/api/me', null, token);
  ok('设置后 hasPayPass=true（提示条消失）', me1.data.user && me1.data.user.hasPayPass === true);

  const t2 = await chat(token, '给妈妈转 10 元');
  ok('重说一次即可继续办理', !!(t2.data.approval && t2.data.approval.action === 'transfer.execute'),
    t2.data.approval ? `P${t2.data.approval.level}` : (t2.data.text || '').slice(0, 30));

  // ============ 理财：未测评时内联测评 ============
  console.log('\n[理财] 未测评时在会话内给题，而不是踢回理财页');
  const r1 = await chat(token, '推荐一下理财');
  ok('返回内联测评卡而非「请前往理财页」', r1.data.needsAssess === true && !!r1.data.assessCard,
    (r1.data.text || '').slice(0, 30));
  ok('测评卡有 3 道题、每题 3 个选项',
    ((r1.data.assessCard || {}).questions || []).length === 3
      && ((r1.data.assessCard || {}).questions || []).every(q => (q.options || []).length === 3));
  ok('文案里不再出现「请先在理财页」', !/请先在.理财.页/.test(r1.data.text || ''));

  const as = await req('POST', '/api/wealth/assess', { answers: [3, 3, 3, 3, 3] }, token);
  ok('答完可直接提交测评', as.data.ok === true && !!as.data.level, `等级 ${as.data.level}`);

  const r2 = await chat(token, '推荐一下理财');
  const prods = r2.data.products || [];
  ok('测评后返回产品列表（不再拦截）', prods.length >= 2, `${prods.length} 只`);
  ok('A5.2 对比卡字段完整（风险/年化/期限/起投）',
    prods.every(p => p.risk && p.rate != null && p.term && p.minCents != null),
    prods.map(p => `${p.name} ${p.risk} ${p.rate}% ${p.term}`).join(' | '));
  ok('标出推荐项与理由', prods.some(p => p.recommended && p.reason));
  ok('对比标记为真（compare）', r2.data.compare === true);

  const buy = await req('POST', '/api/ops/request',
    { action: 'wealth.subscribe', params: { productId: prods[0].id, amount: '1000' } }, token);
  ok('产品卡可直接下单（P2 授权单）', !!(buy.data.approval && buy.data.approval.level === 2));

  console.log('\n' + '─'.repeat(60));
  console.log(`通过 ${pass} / 失败 ${fail}`);
  console.log(fail ? '结论：未达标 ❌' : '结论：支付密码入口 + 理财内联全部达标 ✅');
  console.log('─'.repeat(60) + '\n');
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { if (server) server.kill(); } catch (x) { /* ignore */ } process.exit(1); });
