// ============ 启动引导：全局工具 + 状态（独立文件，便于启用严格 CSP）============
// 这些内容原本内联在 index.html 里。CSP 的 `script-src 'self'` 会拒绝内联脚本，
// 一旦内联会导致 `$ is not defined` → 整个页面白屏。拆成外部文件是最干净的做法。
const $ = sel => document.querySelector(sel);
const app = $('#app');

// 兼容受限环境（内嵌预览/iframe 可能禁用 localStorage），自动降级为内存存储
const LS = {
  mem: {},
  get(k) { try { return localStorage.getItem(k); } catch (e) { return this.mem[k] || null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { this.mem[k] = v; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { delete this.mem[k]; } }
};

const S = {  // 全局状态
  token: LS.get('ab_token') || '',
  user: null, tab: 'home',
  chat: [],            // {role:'user'|'bot'|'blocked', text}
  sms: [],             // 演示短信
  collapsed: false,
  pendingPayee: null   // 待确认的收款人候选（歧义/谐音时使用）
};

function toast(text, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function api(path, method, body) {
  // 只用 X-Token 传令牌：平台网关会注入自己的 Authorization 头，可能覆盖用户令牌
  const headers = { 'Content-Type': 'application/json' };
  if (S.token) headers['X-Token'] = S.token;
  const res = await fetch(path, { method: method || 'GET', headers, body: method ? JSON.stringify(body || {}) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { S.token = ''; LS.del('ab_token'); render(); }
  return data;
}

const yuan = c => (c == null ? '--' : '¥' + (c / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtT = t => new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function refreshSMS() { api('/api/security/overview').then(d => { if (d.ok) { S.sms = d.smsInbox; renderSMS(); } }); }

// 全局错误兜底：出错时页面顶部给出提示，而不是无响应
window.addEventListener('error', e => {
  const t = document.querySelector('.toast-wrap');
  if (t) { const d = document.createElement('div'); d.className = 'toast err'; d.textContent = '脚本错误：' + (e.message || '未知'); t.appendChild(d); }
});
