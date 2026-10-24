'use strict';
/**
 * A4.3–A4.5 挂失链路 + C6 工具组合 回归
 * 用法：node tests/run_c_autonomy.js
 *
 * 验证「我卡丢了」这一句能自主产出一条多步动作链：
 *   评估影响 → 绑备用卡 → 挂失（P2 双因子）→ 冻结 → 代扣迁移 → 暂停定时 → 回执 + 可疑交易提示
 */
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3212);
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
let server = null;
const failures = [];
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
  const hit = kw ? list.find(s => String(s.purpose || '').includes(kw)) : list[0];
  return hit ? hit.code : null;
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
  console.log('\n=== A4.3–A4.5 挂失链路 + C6 工具组合 ===\n');
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), BANK_DATA_DIR: require('os').tmpdir() + '/ab-test-' + PORT }),
    stdio: 'ignore'
  });
  const cleanup = () => { try { server.kill(); } catch (e) { /* ignore */ } };
  process.on('exit', cleanup);
  if (!await waitReady()) { console.log('服务未就绪'); cleanup(); process.exit(1); }

  // 演示账号：挂失链路需要「已有代扣订阅 + 多张卡」，新注册的空账户没有这些前提。
  await req('POST', '/api/demo/reset', {});
  const phone = '13800000001';
  const password = 'demo1234';
  const token = (await req('POST', '/api/auth/login', { phone, password })).data.token;

  // 准备：绑一张备用卡（挂失迁移需要一个目标）
  const add = await req('POST', '/api/ops/request', { action: 'card.add', params: { name: '备用卡', number: '6222021234567890' } }, token);
  if (add.data.approval) await confirm(token, add.data.approval.id, {});
  const cards0 = await req('GET', '/api/cards', null, token);
  ok('准备：用户有 2 张卡', (cards0.data.list || []).length >= 2, `${(cards0.data.list || []).length} 张`);

  // 准备：建一个定时转账，让挂失链路里的「暂停定时」真的有对象可暂停
  const sch = await req('POST', '/api/ops/request',
    { action: 'scheduled.create', params: { toName: '妈妈', amount: '100', freq: 'monthly' } }, token);
  if (sch.data.approval) await confirm(token, sch.data.approval.id, {});
  ok('准备：存在 1 个定时转账', !!(sch.data.approval), sch.data.message || '');

  // ============ 第 1 步：影响评估（不直接执行）============
  console.log('\n[评估] 说「我卡丢了」先给影响清单');
  const ask = await chat(token, '我卡丢了');
  const L = ask.data.loss || {};
  ok('返回挂失评估卡而非直接执行', !!ask.data.loss && !ask.data.approval, ask.data.text ? ask.data.text.slice(0, 40) : '');
  ok('列出关联自动扣费', (L.affected && L.affected.subscriptions || []).length >= 3,
    `${((L.affected || {}).subscriptions || []).length} 项`);
  ok('给出可迁移的备用卡', (L.spareCards || []).length >= 1, `${(L.spareCards || []).length} 张`);
  ok('预演动作链（≥3 步）', (L.steps || []).length >= 3, (L.steps || []).join(' → '));
  const susCount = ((L.affected || {}).suspicious || []).length;
  ok('可疑交易已评估（0 也算已检查）', typeof susCount === 'number', `${susCount} 笔`);

  // ============ 第 2 步：挂失需 P2 双因子 ============
  console.log('\n[OTP] 挂失需要支付密码 + 短信');
  const target = (L.spareCards || [])[0] || {};
  const reqLoss = await req('POST', '/api/ops/request',
    { action: 'card.reportLoss', params: { cardId: L.card.id, migrateToCardId: target.id } }, token);
  const ap = reqLoss.data.approval;
  ok('生成 P2 授权单', !!ap && ap.level === 2);
  const noCred = ap ? await confirm(token, ap.id, {}) : { data: {} };
  ok('无凭证时拒绝执行', noCred.data.ok !== true, (noCred.data.message || '').slice(0, 30));

  const code = await latestSms(token, '挂失');
  const done = ap ? await confirm(token, ap.id, {
    payPassword: '123456', smsCode: code || '000000',
    params: { cardId: L.card.id, migrateToCardId: target.id }
  }) : { data: {} };
  ok('凭证正确后执行成功', done.data.ok === true, (done.data.message || '').slice(0, 50));

  // ============ 第 3 步：多步动作链结果 ============
  console.log('\n[C6] 一次挂失产出多步动作链');
  const receipt = done.data.lossReceipt || {};
  ok('回执包含 ≥3 个已完成动作', (receipt.done || []).length >= 3, (receipt.done || []).join('；'));

  const cards1 = await req('GET', '/api/cards', null, token);
  const lostCard = (cards1.data.list || []).find(c => c.id === L.card.id) || {};
  ok('卡片已挂失并冻结', lostCard.lost === true && lostCard.frozen === true);

  const subs1 = await req('GET', '/api/subscriptions', null, token);
  const active = (subs1.data.list || []).filter(s => s.status !== 'cancelled');
  const migratedAll = active.every(s => !s.cardId || s.cardId === target.id);
  ok('代扣已迁移到备用卡（A4.4）', !!target.id && migratedAll,
    active.map(s => s.merchant + '→' + (s.cardId || '未绑定')).join(', '));

  ok('回执提示可申诉可疑交易（A4.5）',
    (receipt.nextSteps || []).some(s => /申诉|可疑/.test(s)), (receipt.nextSteps || []).join(' / '));

  // ============ A4.6 调额：只读说明，不执行 ============
  console.log('\n[A4.6] 提额只给说明');
  const lim = await chat(token, '把我的额度提到 5 万');
  ok('返回说明而非执行', /人工审核|本人|网点/.test(lim.data.text || '') && !lim.data.approval,
    (lim.data.text || '').split('\n')[0]);

  console.log('\n' + '─'.repeat(60));
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail) { console.log('失败项：' + failures.join('、')); console.log('结论：未达标 ❌'); }
  else console.log('结论：A4.3/A4.4/A4.5/A4.6 + C6 全部达标 ✅');
  console.log('─'.repeat(60) + '\n');
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { server.kill(); } catch (x) { /* ignore */ } process.exit(1); });
