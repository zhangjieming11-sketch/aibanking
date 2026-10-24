'use strict';
// ============ 前端契约校验（零依赖，纯静态）============
// 解决的问题：后端返回 `candidates` 而前端只渲染 `text` 时，页面看起来"正常"，
// 但用户根本没有可点的候选 —— 这类字段漏接只能靠人眼发现，回归脚本抓不到。
// 这里把「后端可能返回的载荷字段」与「前端是否消费」做一次对照，缺口直接报错。
//
// 只做字段级契约，不解析 HTML 语义：目的是防止"新增卡片类型忘了接前端"。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, ev) {
  if (cond) { pass++; console.log(`  ✓ ${name}　${ev || ''}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}　${ev || ''}`); }
}

const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const agent = fs.readFileSync(path.join(root, 'lib/agent.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

// 后端会附带在聊天回复上的结构化载荷（新增一种卡片时必须同步前端）
const CARDS = [
  { field: 'approval', label: '授权单', fn: 'renderApprovalCard' },
  { field: 'candidates', label: '同名候选卡', fn: 'renderPayeeCandidates' },
  { field: 'subscriptions', label: '订阅列表卡', fn: 'renderSubscriptionsCard' },
  { field: 'plan', label: '计划卡', fn: 'renderPlanCard' },
  { field: 'loss', label: '挂失评估卡', fn: 'renderLossCard' },
  { field: 'assessCard', label: '风险测评卡', fn: 'renderAssessCard' },
  { field: 'products', label: '产品对比卡', fn: 'renderProductsCard' }
];

console.log('\n═══ 卡片字段：后端产出 → 前端消费 ═══');
for (const c of CARDS) {
  const backendHas = c.field === 'approval' ? /approval:/.test(agent) : true;
  // 后端产出：agent.js 里出现过该字段的返回，或 server.js 透传
  const produced = new RegExp(`\\b${c.field}\\b`).test(agent) || new RegExp(`\\b${c.field}\\b`).test(server);
  const renderer = new RegExp(`function ${c.fn}\\s*\\(`).test(app);
  const dispatched = new RegExp(`m\\.${c.field}\\s*\\?`).test(app);
  const savedInStream = new RegExp(`${c.field}: result\\.`).test(app);
  const savedInJson = new RegExp(`${c.field}: r\\.`).test(app);
  ok(`${c.label}（${c.field}）渲染函数存在`, renderer, c.fn);
  ok(`${c.label} 分派已接线`, dispatched);
  ok(`${c.label} 两条接收路径都保存`, savedInStream && savedInJson,
    `stream=${savedInStream} json=${savedInJson}`);
  if (!produced) console.log(`    （提示：后端未直接出现 ${c.field} 字段，可能由其他模块注入）`);
}

console.log('\n═══ 安全约束：前端不得出现内联脚本 ═══');
const pub = fs.readdirSync(path.join(root, 'public')).filter(f => /\.(js|html)$/.test(f));
let inline = 0, pseudo = 0;
for (const f of pub) {
  const s = fs.readFileSync(path.join(root, 'public', f), 'utf8');
  inline += (s.match(/\son[a-z]+\s*=\s*["']/g) || []).length;
  pseudo += (s.match(/javascript:/g) || []).length;
}
ok('无内联事件属性（CSP script-src self 下会被拦）', inline === 0, `${pub.length} 个文件，命中 ${inline}`);
ok('无 javascript: 伪协议', pseudo === 0, `命中 ${pseudo}`);

console.log('\n═══ 白名单：前端动作必须都有实现 ═══');
const acts = [...app.matchAll(/data-act="([a-zA-Z0-9_]+)"/g)].map(m => m[1]);
const uniq = [...new Set(acts)];
// 注册形式有三种：`name: (el, a) => ...`、`name: el => ...`、`name: async () => ...`（漏掉 async 会误报）
const missing = uniq.filter(a => !new RegExp(`\\b${a}:\\s*(async\\s*)?(\\(|[a-zA-Z_$]+\\s*=>)`).test(app));
ok('data-act 全部在 ACTIONS 中注册', missing.length === 0, missing.length ? '缺失：' + missing.join(',') : `${uniq.length} 个动作`);

console.log('\n' + '─'.repeat(50));
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail) { console.log('失败项：' + fails.join('、')); process.exit(1); }
console.log('结论：前后端字段契约一致，无内联脚本残留 ✅');
