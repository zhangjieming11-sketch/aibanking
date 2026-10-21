/* ==========================================================================
 * 交付形态回归（E6 / E8 / E9）
 * --------------------------------------------------------------------------
 * E6 黄金轨迹预录 —— 必须是真的静态数据、断网可回放、覆盖核心场景
 * E8 提交材料   —— 视频脚本 / 技术文档 / PPT 大纲 三件齐备且内容非空
 * E9 投屏演示模式 —— 状态、样式、入口、URL 参数四件事都在
 *
 * 运行：node tests/run_delivery.js
 * ========================================================================== */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.TEST_PORT || 3230;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function get(urlPath) {
  return new Promise(resolve => {
    const req = http.get(BASE + urlPath, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // 用空 LLM 配置启动，确保被测的是服务本身而非模型
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), LLM_API_KEY: '', LLM_BASE_URL: '' }),
    stdio: 'ignore'
  });

  try {
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const r = await get('/');
      if (r.status === 200) { ready = true; break; }
      await sleep(300);
    }
    if (!ready) throw new Error('服务未能在 9 秒内就绪');

    // ================= E9 投屏演示模式 =================
    console.log('\n[E9] 投屏演示模式');

    const boot = read('public/boot.js');
    ok('boot.js 定义 projection 状态', /projection:\s*LS\.get\('ab_proj'\)/.test(boot));
    ok('支持 ?proj=1 直接进入', /\[\?&\]proj=1/.test(boot));
    ok('首帧即应用 class，无闪跳', /document\.body\.classList\.add\('projection'\)/.test(boot));

    const appSrc = read('public/app.js');
    ok('有切换函数 toggleProjection', /function toggleProjection\(\)/.test(appSrc));
    ok('toggleProjection 已注册到白名单', /^\s*toggleProjection:\s*\(\)\s*=>\s*toggleProjection\(\)/m.test(appSrc));
    ok('侧栏有演示模式按钮', /data-act="toggleProjection"/.test(appSrc));

    const css = read('public/style.css');
    ok('CSS 含 body.projection 规则', /body\.projection/.test(css));
    ok('提供了等比放大（zoom）', /@supports \(zoom: 1\.2\)[\s\S]{0,200}zoom:\s*1\.3/.test(css));
    ok('不支持 zoom 时有字号退化方案', /@supports not \(zoom: 1\.2\)/.test(css));
    ok('对比度增强：纯白底 + 加深次要文字', /body\.projection\s*\{\s*background:\s*#fff/.test(css) && /body\.projection \.muted/.test(css));

    // ================= E6 黄金轨迹 =================
    console.log('\n[E6] 黄金轨迹预录');

    const traceRes = await get('/traces.js');
    ok('GET /traces.js 可访问', traceRes.status === 200, `HTTP ${traceRes.status}`);

    let traces = null;
    try {
      const sandbox = { window: {} };
      vm.runInNewContext(traceRes.body, sandbox, { timeout: 2000 });
      traces = sandbox.window.TRACES;
    } catch (e) {
      ok('traces.js 可被解析', false, e.message);
    }
    ok('traces.js 可被解析为数组', Array.isArray(traces), traces ? `${traces.length} 条` : '');
    ok('轨迹数量 ≥ 6（E6 门槛）', Array.isArray(traces) && traces.length >= 6, traces ? `${traces.length} 条` : '');

    if (Array.isArray(traces)) {
      const bad = traces.filter(t =>
        !t.id || !t.title || !t.pattern || !t.covers || !t.why ||
        !Array.isArray(t.steps) || t.steps.length < 3);
      ok('每条都含 标题/模式/覆盖项/设计意图/≥3 步', bad.length === 0,
        bad.length ? '缺项：' + bad.map(t => t.id || '?').join(',') : `${traces.length} 条全部合规`);

      const ids = traces.map(t => t.id);
      ok('轨迹 id 唯一', new Set(ids).size === ids.length);

      const hasUser = traces.every(t => t.steps.some(s => s.role === 'user'));
      const hasBot = traces.every(t => t.steps.some(s => s.role === 'bot'));
      ok('每条都同时含用户发言与助手回复', hasUser && hasBot);

      const blockedCount = traces.reduce((n, t) => n + t.steps.filter(s => s.blocked).length, 0);
      ok('预录中包含真实拦截场景（不美化）', blockedCount >= 4, `${blockedCount} 处拦截`);

      const deep = traces.map(t => t.steps.length);
      ok('总步数足够撑起演示', deep.reduce((a, b) => a + b, 0) >= 40, `共 ${deep.reduce((a, b) => a + b, 0)} 步`);
    }

    // 断网可回放：文件内不得有任何网络调用
    const traceSrc = read('public/traces.js');
    ok('轨迹文件不含 fetch / XMLHttpRequest（断网可用）',
      !/\bfetch\s*\(/.test(traceSrc) && !/XMLHttpRequest/.test(traceSrc));

    ok('app.js 有 renderTraces 渲染函数', /function renderTraces\(\)/.test(appSrc));
    ok('页面分发已接入 traces', /S\.tab === 'traces'/.test(appSrc));
    ok('导航含「黄金轨迹」入口', /id: 'traces'/.test(appSrc));
    ok('index.html 加载 traces.js', /src="\/traces\.js"/.test(read('public/index.html')));

    // ================= E8 提交材料 =================
    console.log('\n[E8] 提交材料');

    const files = [
      ['docs/提交材料/演示视频脚本.md', '演示视频脚本'],
      ['docs/提交材料/技术方案文档.md', '技术方案文档'],
      ['docs/提交材料/答辩PPT大纲.md', '答辩PPT大纲']
    ];
    for (const [p, name] of files) {
      const full = path.join(ROOT, p);
      const exists = fs.existsSync(full);
      const size = exists ? fs.statSync(full).size : 0;
      ok(`${name} 存在且非空`, exists && size > 4000, exists ? `${size} 字节` : '缺失');
    }

    const video = read('docs/提交材料/演示视频脚本.md');
    ok('视频脚本含时间轴分镜', /00:00/.test(video) && /04:45/.test(video));
    ok('视频脚本含录制前准备清单', /录制前准备/.test(video));
    ok('视频脚本含翻车点规避', /翻车/.test(video));
    ok('视频脚本覆盖同音混淆 / 篡改指纹 / 注入拦截',
      /同音/.test(video) && /篡改/.test(video) && /注入/.test(video));

    const tech = read('docs/提交材料/技术方案文档.md');
    ok('技术文档含架构分层说明', /系统架构/.test(tech) && /网关层/.test(tech));
    ok('技术文档含五道防线', /防线一/.test(tech) && /防线五/.test(tech));
    ok('技术文档引用真实实测数据', /70\/70/.test(tech) && /37 PASS/.test(tech));
    ok('技术文档含已知限制（不掩饰）', /已知限制/.test(tech) && /无障碍/.test(tech));
    ok('技术文档说明工程取舍与代价', /工程取舍/.test(tech) && /代价/.test(tech));

    const ppt = read('docs/提交材料/答辩PPT大纲.md');
    const pages = (ppt.match(/^## P\d+/gm) || []).length;
    ok('PPT 大纲页数 ≥ 15', pages >= 15, `${pages} 页`);
    ok('PPT 大纲含 Q&A 预演', /Q&A 预演/.test(ppt));
    ok('PPT 大纲澄清 P3 不是能力不足', /P3/.test(ppt) && /产品结论/.test(ppt));

  } finally {
    try { server.kill(); } catch (e) { /* ignore */ }
  }

  console.log('\n──────────────────────────────');
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail === 0) console.log('结论：E6 / E8 / E9 交付形态全部达标 ✅');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('运行异常：', e.message);
  process.exit(1);
});
