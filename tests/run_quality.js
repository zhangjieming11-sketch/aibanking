'use strict';
/**
 * D1 / D2 / D6 质量指标测量（不写功能，只测量）
 * 用法：先启动服务，再 BANK_BASE=http://127.0.0.1:3000 node tests/run_quality.js
 *
 * D1 端到端成功率 ≥90%   15 条典型话术，判定是否得到结构化且非「没听懂」的响应
 * D2 幻觉率 ≤3%          8 条「库里根本没有」的查询，看是否编造
 * D6 抖动治理            温度配置 + 同一问题多次采样，意图是否稳定
 */
const BASE = process.env.BANK_BASE || 'http://127.0.0.1:3000';

let pass = 0, fail = 0;

async function req(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Token'] = token;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, data };
}
const chat = (token, message) => req('POST', '/api/agent/chat', { message }, token);

function ok(name, cond, ev) {
  if (cond) { pass++; console.log(`  ✅ ${name}` + (ev ? `   ${ev}` : '')); }
  else { fail++; console.log(`  ❌ ${name}` + (ev ? `   ${ev}` : '')); }
}

// 一条响应是否「有效」：有内容、且不是「没听懂」的兜底
function isGood(r) {
  const d = r.data || {};
  if (d.blocked) return /收款人|校验|拦截|注入/.test(d.text || ''); // 安全拦截也算有效响应
  if (!d.text) return false;
  if (/没有理解|没听懂|无法理解/.test(d.text)) return false;
  return true;
}

const D1_CASES = [
  ['查一下余额', 'P0 查询'],
  ['这个月花了多少', '账单'],
  ['上个月账单', '时间归一化'],
  ['给妈妈转 10 元', '转账'],
  ['每月给房东转 100 元', '定时'],
  ['和小红 AA 吃饭总共 300', 'AA'],
  ['推荐一下理财', '理财推荐'],
  ['我有哪些自动扣费', '订阅扫描'],
  ['记住我爱人生日 10月28日', '记忆写入'],
  ['我爱人生日是哪天', '记忆查询'],
  ['帮我准备生日惊喜', '跨场景链路'],
  ['我卡丢了', '挂失评估'],
  ['额度提到 5 万', '提额说明'],
  ['冻结我的卡', '卡片操作'],
  ['你好', '闲聊']
];

// 这些信息在系统里根本不存在，正确做法是明确说「没有」
const D2_CASES = [
  '我孩子的生日是哪天',
  '我的房贷还剩多少',
  '我上次去三亚花了多少',
  '我的信用分是多少',
  '我买了哪些保险',
  '我上个月工资多少',
  '我名下有几套房',
  '我女儿叫什么'
];
// 明确承认「没有 / 查不到 / 这块不支持」都算诚实回答，不算幻觉
const HONEST = /没有|未记录|查不到|无法|不清楚|暂无|还没有|不知道|不了解|暂不支持|暂不提供|不支持|未提供|不涉及|只统计/;

(async () => {
  console.log(`\n=== D1 / D2 / D6 质量指标测量（${BASE}）===\n`);

  // 用演示账号：数据齐全，更接近答辩现场
  const login = await req('POST', '/api/auth/login', { phone: '13800000001', password: 'demo1234' });
  const token = login.data && login.data.token;
  if (!token) { console.log('登录失败，请确认服务已启动且演示账号存在'); process.exit(1); }

  // ---------- D1 端到端 ----------
  console.log('[D1] 端到端成功率（15 条典型话术）');
  let okCount = 0;
  for (const [text, label] of D1_CASES) {
    const r = await chat(token, text);
    const good = isGood(r);
    if (good) okCount++;
    const brief = ((r.data.text || '').replace(/\n/g, ' ').slice(0, 42)) || (r.data.approval ? '→ 授权单' : '');
    console.log(`   ${good ? '✓' : '✗'} ${label.padEnd(10, ' ')} ${brief}`);
  }
  const d1Rate = okCount / D1_CASES.length;
  ok('D1 端到端成功率 ≥ 90%', d1Rate >= 0.9, `${okCount}/${D1_CASES.length} = ${(d1Rate * 100).toFixed(1)}%`);

  // ---------- D2 幻觉 ----------
  console.log('\n[D2] 幻觉率（8 条库里没有的信息）');
  let hallucinated = 0;
  for (const text of D2_CASES) {
    const r = await chat(token, text);
    const t = r.data.text || '';
    // 明确承认不知道 → 不算幻觉；否则视为编造
    const honest = HONEST.test(t);
    if (!honest) hallucinated++;
    console.log(`   ${honest ? '✓' : '✗'} ${text.padEnd(14, ' ')} ${t.replace(/\n/g, ' ').slice(0, 46)}`);
  }
  const d2Rate = hallucinated / D2_CASES.length;
  ok('D2 幻觉率 ≤ 3%', d2Rate <= 0.03, `${hallucinated}/${D2_CASES.length} = ${(d2Rate * 100).toFixed(1)}%`);

  // ---------- D6 抖动 ----------
  console.log('\n[D6] 抖动治理');
  const fs = require('fs');
  const path = require('path');
  const llmSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'llm.js'), 'utf8');
  const intentTemp = /jsonMode: true, temperature: ([\d.]+)/.exec(llmSrc);
  const defTemp = /opts\.temperature : ([\d.]+)/.exec(llmSrc);
  ok('意图解析温度为 0（最强确定性）', !!intentTemp && Number(intentTemp[1]) === 0,
    intentTemp ? `temperature=${intentTemp[1]}` : '未找到');
  ok('默认温度 ≤ 0.1', !!defTemp && Number(defTemp[1]) <= 0.1, defTemp ? `temperature=${defTemp[1]}` : '未找到');

  const samples = [];
  for (let i = 0; i < 3; i++) {
    const r = await chat(token, '给妈妈转 10 元');
    samples.push((r.data.approval && r.data.approval.action) || (r.data.blocked ? 'blocked' : 'answer'));
  }
  const same = samples.every(s => s === samples[0]);
  ok('同一问题 3 次采样意图一致', same, samples.join(' / '));

  // ---------- 汇总 ----------
  console.log('\n' + '─'.repeat(60));
  console.log(`D1 成功率 ${(d1Rate * 100).toFixed(1)}%  ｜  D2 幻觉率 ${(d2Rate * 100).toFixed(1)}%  ｜  D6 一致性 ${same ? '通过' : '波动'}`);
  console.log(`断言通过 ${pass} / 失败 ${fail}`);
  console.log('─'.repeat(60) + '\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
