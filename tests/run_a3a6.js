'use strict';
/**
 * A3 订阅/代扣 + A6 跨场景联动 回归
 * 用法：node tests/run_a3a6.js
 *
 * 覆盖全部 10 个评分项（A3.1–A3.4、A6.1–A6.6），全部走真实 HTTP + 授权单闭环。
 * 用新注册账号跑，不污染演示账号。
 */
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3211);
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
  return { status: res.status, data };
}

const chat = (token, message) => req('POST', '/api/agent/chat', { message }, token);

async function confirm(token, id, body) {
  return req('POST', '/api/approvals/' + id + '/confirm', body || {}, token);
}

async function latestSms(token, kw) {
  const r = await req('GET', '/api/security/overview', null, token);
  const list = (r.data && r.data.smsInbox) || [];
  const hit = kw ? list.find(s => String(s.purpose || '').includes(kw)) : list[0];
  return hit ? hit.code : null;
}

async function waitReady(ms) {
  const deadline = Date.now() + (ms || 15000);
  while (Date.now() < deadline) {
    try { const res = await fetch(BASE + '/'); if (res.ok) return true; } catch (e) { /* not ready */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  console.log('\n=== A3 订阅/代扣 + A6 跨场景联动 回归 ===\n');
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore'
  });
  const cleanup = () => { try { server.kill(); } catch (e) { /* ignore */ } };
  process.on('exit', cleanup);

  if (!await waitReady()) { console.log('服务未就绪'); cleanup(); process.exit(1); }

  // ---- 准备：新账号（隔离演示数据）----
  const stamp = String(Date.now()).slice(-8);
  const phone = '139' + stamp;
  const password = 'test1234';
  await req('POST', '/api/auth/register', { phone, name: '测试' + stamp.slice(-4), password });
  let token = (await req('POST', '/api/auth/login', { phone, password })).data.token;
  // 新用户无支付密码 → 资金动作 fail closed；这里补设，才能测 P2 锁资
  await req('POST', '/api/security/paypass', { oldPayPass: '', payPassword: '123456' }, token);
  ok('准备：新账号注册、设支付密码、预置演示订阅', !!token);

  // ================= A3.1 订阅扫描 =================
  console.log('\n[A3.1] 订阅扫描');
  const scan = await chat(token, '我有哪些自动扣费');
  const subs = scan.data.subscriptions || [];
  ok('返回订阅列表卡', Array.isArray(subs) && subs.length > 0, `共 ${subs.length} 项`);
  ok('列表含周期与下次扣费日', subs.length > 0 && !!subs[0].cycleLabel && !!subs[0].nextChargeAt,
    subs[0] ? `${subs[0].merchant}｜${subs[0].cycleLabel}｜${subs[0].nextChargeAt}` : '');

  // 构造一组周期扣费账单，验证识别链路（A3.3 的「构造周期扣费账单」）
  const up = await req('POST', '/api/bills/upload', {
    content: '2026-08-20,网飞会员,39.00,娱乐\n2026-09-20,网飞会员,39.00,娱乐\n2026-10-20,网飞会员,39.00,娱乐'
  }, token);
  const scan2 = await req('GET', '/api/subscriptions', null, token);
  const detected = (scan2.data.list || []).find(s => s.merchant === '网飞会员');
  ok('从构造账单识别出周期扣费', !!detected && detected.cycle === 'monthly' && detected.origin === 'detected',
    detected ? `${detected.merchant}｜${detected.cycleLabel}｜导入${up.data.imported}笔｜下次${detected.nextChargeAt}` : '未识别');
  ok('非订阅消费不被误判（淘宝/外卖）', !(scan2.data.list || []).some(s => /淘宝|美团|饿了么/.test(s.merchant)),
    `共 ${(scan2.data.list || []).length} 项`);

  // ================= A3.3 重复扣费检测 =================
  console.log('\n[A3.3] 重复扣费检测');
  const dup = subs.find(s => s.duplicateCount > 0);
  ok('规则命中疑似重复扣费', !!dup, dup ? `${dup.merchant} × ${dup.duplicateCount}` : '未命中');
  const rep = await chat(token, '申诉重复扣费');
  ok('申诉生成授权单', !!(rep.data.approval && rep.data.approval.action === 'subscription.report'));
  let repRes = { data: {} };
  if (rep.data.approval) repRes = await confirm(token, rep.data.approval.id, {});
  ok('申诉受理并进入处理中', repRes.data.ok === true && (repRes.data.dispute || {}).status === 'processing',
    repRes.data.message || '');

  // ================= A3.2 取消 + 影响提示 =================
  console.log('\n[A3.2] 取消订阅 + 影响提示');
  const cancel = await chat(token, '取消云盘存储 Pro');
  const cAp = cancel.data.approval;
  ok('取消生成授权单（P1）', !!cAp && cAp.action === 'subscription.cancel' && cAp.level === 1);
  const cRes = cAp ? await confirm(token, cAp.id, {}) : { data: {} };
  ok('取消成功且提示下次扣费日', cRes.data.ok === true && /不再扣款/.test(cRes.data.message || ''),
    (cRes.data.message || '').slice(0, 60));

  // ================= A3.4 串联钩子 =================
  console.log('\n[A3.4] 取消成功后衔接理财');
  const saving = cRes.data.saving || {};
  ok('给出资金去向建议（衔接 S5）', saving.action === 'wealth.subscribe' && /灵活宝/.test(saving.suggestion || ''),
    `每月省 ¥${((saving.monthlyCents || 0) / 100).toFixed(2)}`);

  // ================= A6.1 记忆写入/查询 =================
  console.log('\n[A6.1] 记忆写入与查询');
  const memW = await chat(token, '记住我爱人生日 10月28日');
  const mAp = memW.data.approval;
  ok('写入生成 P1 授权单', !!mAp && mAp.action === 'memory.write');
  ok('强 schema 解析出 key 与值', !!mAp && mAp.params.key === 'family.birthday.spouse' && mAp.params.value === '10-28',
    mAp ? JSON.stringify(mAp.params) : '');
  if (mAp) await confirm(token, mAp.id, {});
  const memQ = await chat(token, '我爱人生日是哪天');
  ok('查询返回已存值（零幻觉）', /10-28/.test(memQ.data.text || ''), (memQ.data.text || '').slice(0, 50));
  const memQ2 = await chat(token, '我孩子生日是哪天');
  ok('未存信息明确说没有，不推测', /还没有记住|没有记录/.test(memQ2.data.text || ''), (memQ2.data.text || '').slice(0, 50));

  // ================= A6.2 多步链路 =================
  console.log('\n[A6.2] 生日惊喜多步链路');
  const t0 = Date.now();
  const planC = await chat(token, '帮我准备生日惊喜');
  const pAp = planC.data.approval;
  ok('创建计划生成授权单', !!pAp && pAp.action === 'plan.create');
  ok('自动带上已记住的日期', !!pAp && pAp.params.eventDate === '10-28', pAp ? pAp.params.eventDate : '');
  const pRes = pAp ? await confirm(token, pAp.id, {}) : { data: {} };
  const plan = pRes.data.plan || {};
  ok('计划建立且记忆/日历两步已完成', pRes.data.ok === true && !!plan.id,
    plan.steps ? plan.steps.filter(s => s.status === 'done' || s.status === 'skipped').map(s => s.label).join('→') : '');

  const esc = await req('POST', '/api/ops/request',
    { action: 'escrow.hold', params: { planId: plan.id, amount: '200' } }, token);
  const eAp = esc.data.approval;
  ok('锁定预算需 P2 授权单', !!eAp && eAp.level === 2 && eAp.needSms !== false);
  let eRes = { data: {} };
  if (eAp) {
    const code = await latestSms(token, '预留');
    eRes = await confirm(token, eAp.id, { payPassword: '123456', smsCode: code || '000000', params: { planId: plan.id, amount: '200' } });
  }
  ok('锁资成功', eRes.data.ok === true, (eRes.data.message || '').slice(0, 50));

  const plans1 = await req('GET', '/api/plans', null, token);
  const p1 = (plans1.data.list || [])[0] || {};
  ok('六步链路全部推进', p1.progress === '6/6', `进度 ${p1.progress}｜${(p1.steps || []).map(s => s.label + ':' + s.status).join(' ')}`);
  ok('全程耗时在 120 秒内（A6.6）', (Date.now() - t0) < 120000, `${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ================= A6.3 主动触发 =================
  console.log('\n[A6.3] 虚拟时钟推进 + 主动建议');
  const clk = await req('POST', '/api/demo/clock', { days: 10 }, token);
  ok('虚拟时钟推进生效', (clk.data.clock || {}).offsetDays === 10, (clk.data.message || ''));
  const notes = await req('GET', '/api/notifications', null, token);
  const proactive = (notes.data.list || []).find(n => n.kind === 'proactive');
  ok('到点主动发建议卡（不静默执行）', !!proactive || notes.data.fired > 0,
    proactive ? proactive.title : `fired=${notes.data.fired}`);

  // ================= A6.4 跨会话续接 =================
  console.log('\n[A6.4] 跨会话续接');
  const token2 = (await req('POST', '/api/auth/login', { phone, password })).data.token;
  const plans2 = await req('GET', '/api/plans', null, token2);
  const p2 = (plans2.data.list || []).find(x => x.id === plan.id);
  ok('新会话仍能续接未完成计划', !!p2 && ['running', 'reminded'].includes(p2.status) && p2.eventDate === '10-28',
    p2 ? `status=${p2.status} 进度=${p2.progress} 日期=${p2.eventDate}` : '未找到');

  // ================= A6.5 全程可撤销 =================
  console.log('\n[A6.5] 逐节点回滚');
  const rb = await chat(token2, '撤销生日惊喜');
  const rAp = rb.data.approval;
  ok('撤销生成授权单', !!rAp && rAp.action === 'plan.rollback');
  const rRes = rAp ? await confirm(token2, rAp.id, {}) : { data: {} };
  ok('回滚说明释放了资金', /释放|回滚/.test(rRes.data.message || ''), (rRes.data.message || '').slice(0, 50));
  const undone = rRes.data.undone || [];
  ok('至少回滚了 3 个写节点', undone.length >= 3, undone.join('、'));
  const plans3 = await req('GET', '/api/plans', null, token2);
  const p3 = (plans3.data.list || []).find(x => x.id === plan.id);
  ok('计划状态转为已回滚', !!p3 && p3.status === 'reverted', p3 ? p3.status : '');
  const acc = await req('GET', '/api/overview', null, token2);
  ok('预留资金已释放（可用=余额）', (acc.data.escrowCents === 0), `escrow=${acc.data.escrowCents}`);

  console.log('\n' + '─'.repeat(60));
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail) { console.log('失败项：' + failures.join('、')); console.log('结论：A3/A6 未达标 ❌'); }
  else console.log('结论：A3 四项 + A6 六项全部达标 ✅');
  console.log('─'.repeat(60) + '\n');

  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
