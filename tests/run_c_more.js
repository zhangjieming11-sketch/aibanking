'use strict';
/**
 * C1 / C2 / C3 / C4 / C5 回归
 * 用法：node tests/run_c_more.js
 *
 * C1 计划可重规划   ｜ C2 失败反思 ｜ C3 中断恢复 ｜ C4 指代消解 ｜ C5 条件分支编排
 */
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3213);
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
const failures = [];
let server = null;
const PAY_PASS = String.fromCharCode(56,56,56,56,56,56);

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
const confirm = (token, id, body) => req('POST', '/api/approvals/' + id + '/confirm', body || {}, token);

async function latestSms(token, kw) {
  const r = await req('GET', '/api/security/overview', null, token);
  const list = (r.data && r.data.smsInbox) || [];
  const hit = kw ? list.find(x => String(x.purpose || '').includes(kw)) : list[0];
  return hit ? hit.code : null;
}
async function confirmP2(token, ap, kw) {
  const code = await latestSms(token, kw || '转账');
  return confirm(token, ap.id, { payPassword: PAY_PASS, smsCode: code || '000000', params: ap.params });
}

async function waitReady(ms) {
  const deadline = Date.now() + (ms || 15000);
  while (Date.now() < deadline) {
    try { const r = await fetch(BASE + '/'); if (r.ok) return true; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  console.log('\n=== C1 / C2 / C3 / C4 / C5 自主性回归 ===\n');
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), BANK_DATA_DIR: require('os').tmpdir() + '/ab-test-' + PORT }),
    stdio: 'ignore'
  });
  const cleanup = () => { try { if (server) server.kill(); } catch (e) { /* ignore */ } };
  process.on('exit', cleanup);
  if (!await waitReady()) { console.log('服务未就绪'); cleanup(); process.exit(1); }

  // 演示账号：注册即空账户后，新账号没有联系人也没有余额，C1–C5 的「转账/调拨」全部无法成立。
  await req('POST', '/api/demo/reset', {});
  const phone = '13800000001';
  const password = 'demo1234';
  const token = (await req('POST', '/api/auth/login', { phone, password })).data.token;

  // ================= C4 指代消解 =================
  console.log('\n[C4] 指代消解');
  const t1 = await chat(token, '给妈妈转 10 元');
  ok('首次转账走通讯录解析', !!(t1.data.approval && t1.data.approval.action === 'transfer.execute'),
    t1.data.approval ? JSON.stringify(t1.data.approval.params.toName) : (t1.data.text || '').slice(0, 30));
  if (t1.data.approval) await confirmP2(token, t1.data.approval);

  const t2 = await chat(token, '给他转 10 元');
  const p2 = t2.data.approval && t2.data.approval.params ? t2.data.approval.params : {};
  ok('「他」解析为此前用过的收款人', !!t2.data.approval && (p2.toName === '妈妈' || p2.toAlias === '妈妈'),
    `toName=${p2.toName || '-'} toAlias=${p2.toAlias || '-'}`);
  if (t2.data.approval) await confirmP2(token, t2.data.approval);

  // ================= C1 计划可重规划 =================
  console.log('\n[C1] 计划先行 + 可重规划');
  const mem = await chat(token, '记住我爱人生日 10月28日');
  if (mem.data.approval) await confirm(token, mem.data.approval.id, {});
  const pc = await chat(token, '帮我准备生日惊喜');
  if (pc.data.approval) await confirm(token, pc.data.approval.id, {});
  const plans0 = await req('GET', '/api/plans', null, token);
  const plan0 = (plans0.data.list || [])[0] || {};
  ok('计划先行，步骤可见（DAG 列表）', (plan0.steps || []).length === 6,
    (plan0.steps || []).map(s => s.label + ':' + s.status).join(' '));

  const skip = await chat(token, '不用发通知了');
  const skipAp = skip.data.approval;
  ok('重规划生成授权单', !!skipAp && skipAp.action === 'plan.adjust', skipAp ? JSON.stringify(skipAp.params) : '');
  let skipRes = { data: {} };
  if (skipAp) skipRes = await confirm(token, skipAp.id, {});
  const notifyStep = ((skipRes.data.plan || {}).steps || []).find(s => s.key === 'notify') || {};
  ok('通知步骤已按用户意愿跳过', notifyStep.status === 'skipped', `notify=${notifyStep.status}`);

  const guard = await chat(token, '先锁资再建提醒');
  const gAp = guard.data.approval;
  let gRes = { data: {} };
  if (gAp) gRes = await confirm(token, gAp.id, {});
  ok('锁资不可被后置（守住资金前置约束）',
    /不能跳过或后置/.test(gRes.data.message || (guard.data.text || '')), (gRes.data.message || '').slice(0, 40));

  // ================= C2 / C5 余额不足的自主出路 =================
  console.log('\n[C2 / C5] 余额不足时不直接失败');
  // 准备：先买一笔理财，这样「赎回补足」分支才有对象可选
  await req('POST', '/api/wealth/assess', { answers: [3, 3, 3, 3, 3] }, token);
  const prods = await req('GET', '/api/wealth/products', null, token);
  const prod = (prods.data.list || []).find(x => Number(String(x.risk).slice(1)) <= 3) || (prods.data.list || [])[0];
  const buy = prod ? await req('POST', '/api/ops/request',
    { action: 'wealth.subscribe', params: { productId: prod.id, amount: '1000' } }, token) : { data: {} };
  if (buy.data.approval) await confirmP2(token, buy.data.approval, '申购');
  const poor = await chat(token, '给妈妈转 490000 元');
  const adv = poor.data.balanceAdvice || {};
  ok('识别差额并给替代方案', !!poor.data.balanceAdvice && (adv.options || []).length >= 3,
    `可用 ¥${((adv.available || 0) / 100).toFixed(2)} 缺口 ¥${((adv.gap || 0) / 100).toFixed(2)}`);
  const keys = (adv.options || []).map(o => o.key);
  ok('给出「调拨 / 降额 / 预约」三类分支', ['redeem', 'reduce', 'split'].every(k => keys.includes(k)),
    (adv.options || []).map(o => o.label).join(' | '));
  ok('未生成无效授权单', !poor.data.approval);

  const redeemOpt = (adv.options || []).find(o => o.key === 'redeem');
  const doRedeem = redeemOpt
    ? await req('POST', '/api/ops/request', redeemOpt.ops, token)
    : { data: {} };
  ok('可一键执行「赎回补足」分支', !!(doRedeem.data.approval && doRedeem.data.approval.action === 'wealth.redeem'),
    doRedeem.data.message || (doRedeem.data.approval ? '已生成赎回授权单' : ''));
  // 把这张赎回单确认掉，避免遗留 pending 干扰后面的中断用例
  if (doRedeem.data.approval) await confirmP2(token, doRedeem.data.approval, '赎回');

  // ================= C3 中断恢复 =================
  console.log('\n[C3] 未完成任务的中断恢复');
  const pending = await chat(token, '给房东转 10 元');
  ok('先建一张待确认单据', !!(pending.data.approval && pending.data.approval.action === 'transfer.execute'));
  const intr = await chat(token, '再给房东转 20 元');
  ok('再次发起同类操作时提示未完成单据', /另有 1 张|待确认/.test(intr.data.text || ''),
    (intr.data.text || '').split('\n').find(l => /另有|待确认/.test(l)) || (intr.data.text || '').slice(0, 40));
  ok('新操作照常执行（不阻断）', !!intr.data.approval && intr.data.approval.action === 'transfer.execute',
    intr.data.approval ? '已生成第 2 张转账单' : '未生成');

  // 跨业务操作也不应被拦
  const cross = await chat(token, '冻结我的卡');
  ok('跨业务操作不被误拦', !!cross.data.approval || /冻结/.test(cross.data.text || ''),
    cross.data.approval ? '已生成冻结授权单' : (cross.data.text || '').slice(0, 30));

  const goOn = await chat(token, '继续');
  ok('说「继续」能回到原单据', /确认卡片|回到/.test(goOn.data.text || ''), (goOn.data.text || '').slice(0, 40));

  console.log('\n' + '─'.repeat(60));
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail) { console.log('失败项：' + failures.join('、')); console.log('结论：未达标 ❌'); }
  else console.log('结论：C1/C2/C3/C4/C5 全部达标 ✅');
  console.log('─'.repeat(60) + '\n');
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { if (server) server.kill(); } catch (x) { /* ignore */ } process.exit(1); });
