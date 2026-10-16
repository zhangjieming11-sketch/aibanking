'use strict';
// ============ 注入攻击用例回归门禁 ============
// 用法：
//   node tests/run_attacks.js          人读报告，全绿 exit 0，有漏网/误伤 exit 1
//   node tests/run_attacks.js --json   机器可读（供 /api/security/dashboard 调用）
//
// 零依赖：直接 require ../lib/injection.js，不启动服务、不碰数据库。

const fs = require('fs');
const path = require('path');
const injection = require('../lib/injection');

const MD_FILE = path.join(__dirname, 'attacks.md');

/** 解析 attacks.md：用例行格式为 `- A1 | 攻击文本` */
function loadCases() {
  const md = fs.readFileSync(MD_FILE, 'utf8');
  const attacks = [];
  const negatives = [];
  const sections = {};
  for (const line of md.split(/\r?\n/)) {
    const sec = line.match(/^##\s*([A-F])\.\s*(.+?)\s*（/);
    if (sec) { sections[sec[1]] = sec[2]; continue; }
    const m = line.match(/^-\s*([A-FN]\d+)\s*\|\s*(.+?)\s*$/);
    if (!m) continue;
    const item = { id: m[1], text: m[2] };
    if (m[1][0] === 'N') negatives.push(item); else attacks.push(item);
  }
  return { attacks, negatives, sections };
}

/** 跑一遍全部用例 */
function run() {
  const { attacks, negatives, sections } = loadCases();

  const results = attacks.map(c => {
    const r = injection.scan(c.text);
    return {
      id: c.id, text: c.text,
      blocked: !r.clean,
      categories: [...new Set(r.hits.map(h => h.category))],
      ruleIds: r.hits.map(h => h.id)
    };
  });

  const negResults = negatives.map(c => {
    const r = injection.scan(c.text);
    return { id: c.id, text: c.text, clean: r.clean, ruleIds: r.hits.map(h => h.id) };
  });

  const passed = results.filter(r => r.blocked).length;
  const missed = results.filter(r => !r.blocked);
  const falsePositives = negResults.filter(n => !n.clean);
  const res = {
    total: attacks.length,
    passed,
    missedCount: missed.length,
    missed,
    negativeTotal: negatives.length,
    falsePositiveCount: falsePositives.length,
    falsePositives,
    sections,
    results,
    negatives: negResults
  };
  res.ok = res.missedCount === 0 && res.falsePositiveCount === 0;
  return res;
}

function printReport(res) {
  const line = '─'.repeat(58);
  console.log('');
  console.log('  AgentBank · 数据隔离层 · 注入攻击用例回归');
  console.log('  ' + line);

  const byLetter = {};
  for (const r of res.results) {
    const k = r.id[0];
    (byLetter[k] = byLetter[k] || []).push(r);
  }
  for (const k of Object.keys(byLetter).sort()) {
    const list = byLetter[k];
    const okN = list.filter(r => r.blocked).length;
    const flag = okN === list.length ? '✓' : '✗';
    const title = res.sections[k] || ('分类 ' + k);
    console.log(`  ${flag} ${k}. ${title.padEnd(18, '　')} ${okN}/${list.length}`);
    for (const r of list) {
      if (!r.blocked) console.log(`      ↳ 漏网 ${r.id}: ${r.text}`);
    }
  }

  console.log('  ' + line);
  console.log(`  用例通过：${res.passed}/${res.total}${res.missedCount === 0 ? '  全绿 ✅' : `  漏网 ${res.missedCount} 条 ❌`}`);
  console.log(`  负样本放行：${res.negativeTotal - res.falsePositiveCount}/${res.negativeTotal}${res.falsePositiveCount === 0 ? '  无误伤 ✅' : `  误伤 ${res.falsePositiveCount} 条 ❌`}`);
  for (const f of res.falsePositives) console.log(`      ↳ 误伤 ${f.id}: ${f.text}（命中规则 ${f.ruleIds.join(',')}）`);
  console.log('  ' + line);
  console.log(res.ok ? '  结论：数据隔离层通过门禁，可发布。' : '  结论：未通过门禁，禁止发布。');
  console.log('');
}

if (require.main === module) {
  try {
    const res = run();
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify({ ok: res.ok, total: res.total, passed: res.passed, missedCount: res.missedCount, falsePositiveCount: res.falsePositiveCount }));
    } else {
      printReport(res);
    }
    process.exit(res.ok ? 0 : 1);
  } catch (e) {
    console.error('用例脚本执行失败：' + e.message);
    process.exit(2);
  }
}

module.exports = { run, loadCases };
