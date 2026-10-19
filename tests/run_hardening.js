'use strict';
/**
 * 安全加固回归（v2.1 + 语义绕过防御）
 * 用法：node tests/run_hardening.js
 *
 * 覆盖：
 *   U-01  登录爆破限速（第 6 次 429）
 *   U-16/17 验证码·支付密码 3 次锁单（第 4 次提示已作废）
 *   U-28/29 非法金额不建单（负数/0/字母/科学计数/超大）
 *   U-36  安全响应头（X-Frame-Options / CSP / nosniff）
 *   U-14  上传超限 413
 *   语义绕过 未登记拒绝 / 待验证限 ¥50 / 已登记放行
 *   通讯录   添加恒为 pending → 验证码回填 → verified
 */
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3210);
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, evidence) {
  if (cond) { pass++; console.log(`  ✅ ${name}` + (evidence ? `   ${evidence}` : '')); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}` + (evidence ? `   ${evidence}` : '')); }
}

async function req(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Token'] = token;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (e) { /* 空响应 */ }
  return { status: res.status, data, headers: res.headers };
}

async function login(phone, password) {
  const r = await req('POST', '/api/auth/login', { phone, password });
  return r.data && r.data.token ? r.data.token : null;
}

async function waitReady(ms) {
  const deadline = Date.now() + (ms || 15000);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/');
      if (res.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: 'ignore'
  });

  const cleanup = () => { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } };
  process.on('exit', cleanup);

  const ready = await waitReady();
  if (!ready) { console.error('服务未能启动，请检查端口占用'); cleanup(); process.exit(1); }

  const stamp = String(Date.now()).slice(-6);
  const pad8 = n => String(n).padStart(8, '0').slice(-8);
  const demoPhone = '13800000001';
  const floodPhone = '139' + pad8(stamp);        // 用于登录爆破测试（11 位，且不占用真实账号）
  const tmpPhone = '138' + pad8(Number(stamp) + 1); // 用于锁单测试的临时账户

  console.log('\nAgentBank · 安全加固回归');
  console.log('─'.repeat(60));

  // ---------- U-36 安全响应头 ----------
  console.log('\n[U-36] 安全响应头');
  const home = await fetch(BASE + '/');
  ok('X-Frame-Options: DENY', home.headers.get('x-frame-options') === 'DENY');
  ok('X-Content-Type-Options: nosniff', home.headers.get('x-content-type-options') === 'nosniff');
  ok('CSP 含 frame-ancestors none', /frame-ancestors 'none'/.test(home.headers.get('content-security-policy') || ''));
  ok('首页不含内联脚本（CSP 可全开）', !/<script>[\s\S]{0,20}[^<]/.test(await (await fetch(BASE + '/')).text()));

  // ---------- U-01 登录限速 ----------
  console.log('\n[U-01] 登录爆破限速（账号维度）');
  const codes = [];
  for (let i = 0; i < 6; i++) {
    const r = await req('POST', '/api/auth/login', { phone: floodPhone, password: 'wrong-pass-' + i });
    codes.push(r.status);
  }
  ok('前 5 次 401、第 6 次 429', codes.slice(0, 5).every(c => c === 401) && codes[5] === 429, codes.join(' '));
  // 折中策略：锁定期内密码正确仍放行（防止攻击者锁死他人账号）
  const demoToken = await login(demoPhone, 'demo1234');
  ok('演示账户登录正常（未被误锁）', !!demoToken);
  if (!demoToken) { cleanup(); process.exit(1); }

  // ---------- U-28/29 参数校验 ----------
  console.log('\n[U-28/29] 授权单参数校验');
  const badAmounts = ['-100', '0', 'abc', '1e5', '1.0000001', '999999999999'];
  for (const a of badAmounts) {
    const r = await req('POST', '/api/ops/request', { action: 'transfer.execute', params: { toName: '小红', amount: a } }, demoToken);
    ok(`金额 ${a} 被拦截`, r.status === 403 && r.data.ok === false, r.data.message || '');
  }
  const good = await req('POST', '/api/ops/request', { action: 'transfer.execute', params: { toName: '小红', amount: '100' } }, demoToken);
  ok('正常金额 100 仍可建单', good.status === 200 && good.data.ok === true);

  // ---------- 语义绕过：收款人解析层 ----------
  console.log('\n[语义绕过] 收款人解析层');
  const unknown = await req('POST', '/api/ops/request', { action: 'transfer.execute', params: { toName: '阿姨', amount: '5000' } }, demoToken);
  ok('未登记「阿姨」被拒绝', unknown.status === 403 && /收款人/.test(JSON.stringify(unknown.data)), '层=' + (unknown.data.layer || ''));

  const pendingBig = await req('POST', '/api/ops/request', { action: 'transfer.execute', params: { toName: '同事小李', amount: '500' } }, demoToken);
  ok('待验证联系人转 ¥500 被拦截', pendingBig.status === 403);

  const pendingSmall = await req('POST', '/api/ops/request', { action: 'transfer.execute', params: { toName: '同事小李', amount: '50' } }, demoToken);
  ok('待验证联系人转 ¥50 放行（应急额度）', pendingSmall.status === 200 && pendingSmall.data.ok === true);

  const verified = await req('POST', '/api/ops/request', { action: 'transfer.execute', params: { toName: '妈妈', amount: '100' } }, demoToken);
  const vp = verified.data.approval && verified.data.approval.params;
  ok('已验证「妈妈」放行且身份注入', verified.status === 200 && vp && vp.toName === '张桂芳' && !!vp.toAccount, vp ? `账号 ${vp.toAccount}` : '');

  // ---------- U-16/17 三次锁单 ----------
  console.log('\n[U-16/17] 凭证试错锁单');
  await req('POST', '/api/auth/register', { phone: tmpPhone, name: '限速测试', password: 'test1234' });
  const tmpToken = await login(tmpPhone, 'test1234');
  if (tmpToken) {
    await req('POST', '/api/security/paypass', { payPassword: '123456' }, tmpToken);
    const ap = await req('POST', '/api/ops/request', { action: 'wealth.subscribe', params: { productId: 'p1', amount: '100' } }, tmpToken);
    const apId = ap.data.approval && ap.data.approval.id;
    ok('成功创建 P2 授权单', !!apId);

    if (apId) {
      const msgs = [];
      for (let i = 1; i <= 4; i++) {
        const r = await req('POST', '/api/approvals/' + apId + '/confirm',
          { payPassword: '123456', smsCode: '00000' + i }, tmpToken);
        msgs.push((r.data && r.data.message) || '');
      }
      ok('第 1–2 次提示剩余次数', /还可尝试/.test(msgs[0]) || /还可尝试/.test(msgs[1]), msgs[0]);
      ok('第 3 次达上限并作废单据', /已达上限/.test(msgs[2]) || /作废/.test(msgs[2]), msgs[2]);
      ok('第 4 次直接拒绝（状态 locked）', /locked|不可重复/.test(msgs[3]), msgs[3]);
    }
  } else {
    ok('临时账户登录成功', false);
  }

  // ---------- U-14 上传上限 ----------
  console.log('\n[U-14] 上传内容上限');
  const big = 'x'.repeat(1024 * 1024 + 10);
  const up = await req('POST', '/api/bills/upload', { content: big }, demoToken);
  ok('超过 1MB 返回 413', up.status === 413, up.data.message || '');

  // ---------- 通讯录准入流程 ----------
  console.log('\n[通讯录] 添加 → 待验证 → 回填验证码 → 已验证');
  const acct = '6222' + stamp + '00000';
  const alias = '赵经理' + stamp;
  const added = await req('POST', '/api/contacts', {
    realName: '赵敏' + stamp, aliases: alias, account: acct.slice(0, 19), phone: '137' + stamp + '00'
  }, demoToken);
  ok('新增联系人恒为 pending', added.status === 200 && added.data.contact && added.data.contact.trust === 'pending');

  const cid = added.data.contact && added.data.contact.id;
  if (cid) {
    const blockBig = await req('POST', '/api/ops/request', { action: 'transfer.execute', params: { toName: alias, amount: '200' } }, demoToken);
    ok('未验证前大额被拦截', blockBig.status === 403);

    const started = await req('POST', '/api/contacts/' + cid + '/verify/start', {}, demoToken);
    ok('发起验证成功', started.status === 200);

    const ov = await req('GET', '/api/security/overview', null, demoToken);
    const inbox = (ov.data && ov.data.smsInbox) || [];
    const rec = inbox.filter(s => s.contactId === cid).pop();
    ok('短信面板收到验证码', !!rec);

    if (rec) {
      const done = await req('POST', '/api/contacts/' + cid + '/verify/confirm', { code: rec.code }, demoToken);
      ok('回填验证码后转为 verified', done.status === 200 && done.data.contact && done.data.contact.trust === 'verified');
      const after = await req('POST', '/api/ops/request', { action: 'transfer.execute', params: { toName: alias, amount: '200' } }, demoToken);
      ok('验证后大额恢复', after.status === 200);
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail) { console.log('失败项：\n - ' + failures.join('\n - ')); }
  console.log(fail ? '结论：存在未通过项，需修复。' : '结论：安全加固项全部通过 ✅');

  cleanup();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
