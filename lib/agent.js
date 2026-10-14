'use strict';
// ============ Agent：意图解析 + 注入防护 ============
// 说明：参赛演示采用规则意图解析（稳定、离线、可复现）。
// 若比赛允许外接 LLM：LLM 只负责「生成结构化意图 JSON」，意图仍必须经过权限网关——
// 架构不变，LLM 换成 API 调用即可。

const store = require('./store');
const gateway = require('./gateway');
const { yuan } = require('./util');

// 提示词注入特征（用户输入/账单文本均先过此检测）
const INJECTION_PATTERNS = [
  /忽略(以上|之前|前面|上述)?(的)?(所有|全部)?(指令|规则|限制|约束|设定)/i,
  /ignore (all )?previous (instructions|rules)/i,
  /你现在是(一个)?(没有任何限制|不受限制|无限制|开发者模式|越狱)/i,
  /(进入|开启)(开发者|越狱|无限制)模式/i,
  /(系统|管理员)(提示|指令)[:：]/i,
  /绕过(安全|验证|权限|风控)/i,
  /(disable|bypass).*(security|verification|guardrail)/i,
  /(假装|扮演)(你是)?(没有限制的|不受控的)/i
];

function scanInjection(text) {
  const hits = INJECTION_PATTERNS.filter(p => p.test(text)).map(p => p.source.slice(0, 30));
  return hits;
}

function parseAmount(text) {
  const m = text.match(/(\d+(?:\.\d{1,2})?)\s*(元|块钱?|块)/) || text.match(/(?:转|付|缴|交|申购|存入)(\d+(?:\.\d{1,2})?)/);
  return m ? m[1] : null;
}

function parsePayee(text) {
  let m = text.match(/给([\u4e00-\u9fa5A-Za-z0-9_]{1,10}?)(?:转|付|打钱|转钱|转账)/);
  if (m) return m[1];
  m = text.match(/(?:转账|转钱|打钱|付款)给([\u4e00-\u9fa5A-Za-z0-9_]{1,10})/);
  if (m) return m[1];
  return null;
}

// ---- 意图解析：返回 {action, params, reply} ----
function parseIntent(user, text) {
  const t = String(text).trim();

  // P3 禁止区意图（演示"Agent 不能做什么"）
  if (/(修改|更改|改)(支付)?密码/.test(t)) return { action: 'paypass.change', params: {} };
  if (/解绑(手机|手机号)/.test(t)) return { action: 'phone.unbind', params: {} };
  if (/(关闭|取消|停用)(安全|验证|防护)/.test(t)) return { action: 'security.disable', params: {} };
  if (/(删除|解绑|解掉)(储蓄)?卡|解绑银行卡/.test(t) && !/冻结/.test(t)) {
    const db = store.get();
    const card = db.cards.find(c => c.userId === user.id && (t.includes(c.name)));
    return { action: 'card.remove', params: card ? { cardId: card.id } : {} };
  }

  // 定时转账
  if (/(定时|自动|定期).*(转|存)|(每周|每月|每天|每日).*转/.test(t)) {
    return { action: 'scheduled.create', params: { toName: parsePayee(t) || '家人', amount: parseAmount(t), freq: /每月/.test(t) ? 'monthly' : /每周/.test(t) ? 'weekly' : /每天|每日/.test(t) ? 'daily' : 'once' } };
  }

  // AA 转账
  if (/(AA|aa|拼单|均摊|平摊|AA制)/.test(t)) {
    const total = parseAmount(t) || '';
    const m = t.match(/(?:和|跟|与)([\u4e00-\u9fa5A-Za-z0-9_、，, ]{1,30}?)(?:一起|AA|拼单|均摊|平摊|吃饭|聚餐)/);
    const parts = m ? m[1] : '';
    return { action: 'aa.create', params: { title: t.match(/「(.+?)」/)?.[1] || (t.includes('饭') || t.includes('餐') ? '聚餐AA' : 'AA活动'), total, participants: parts } };
  }

  // 理财
  if (/(赎回|取出|卖掉)/.test(t) && /(理财|基金|持仓|产品)/.test(t)) {
    const db = store.get();
    const h = db.holdings.find(h => h.userId === user.id);
    return { action: 'wealth.redeem', params: h ? { holdingId: h.id } : {} };
  }
  if (/(申购|购买|买入|买点|存入).*(理财|基金|产品)|买理财/.test(t)) {
    const db = store.get();
    // 金额
    const amount = parseAmount(t) || '1000';
    // 按名字或风险匹配产品
    let prod = db.products.find(p => t.includes(p.name));
    if (!prod) {
      const userLevel = Number((user.riskLevel || 'C1').slice(1));
      const m = t.match(/R(\d)/); if (m) prod = db.products.find(p => p.risk === 'R' + m[1]);
      if (!prod) prod = db.products.filter(p => Number(p.risk.slice(1)) <= userLevel).sort((a, b) => b.rate - a.rate)[0];
    }
    return { action: 'wealth.subscribe', params: { productId: prod ? prod.id : 'p1', amount } };
  }

  // 卡片
  if (/冻结.*(卡|卡片)/.test(t) || /(卡|卡片).*冻结/.test(t)) {
    const db = store.get();
    const card = db.cards.find(c => c.userId === user.id && t.includes(c.name)) || db.cards.find(c => c.userId === user.id);
    return { action: 'card.freeze', params: card ? { cardId: card.id } : {} };
  }
  if (/解冻.*(卡|卡片)/.test(t) || /(卡|卡片).*解冻/.test(t)) {
    const db = store.get();
    const card = db.cards.find(c => c.userId === user.id && t.includes(c.name)) || db.cards.find(c => c.userId === user.id);
    return { action: 'card.unfreeze', params: card ? { cardId: card.id } : {} };
  }

  // 转账（普通）
  if (/(转账|转钱|打钱|转给|转\d|给.+转)/.test(t)) {
    return { action: 'transfer.execute', params: { toName: parsePayee(t), amount: parseAmount(t) } };
  }

  return null;
}

// ---- 主入口：处理一条用户消息 ----
// 通道：注入扫描 → （已配置时）LLM 意图解析 → 权限网关；LLM 不可用自动降级规则引擎
async function handleChat(user, text) {
  const db = store.get();
  const t = String(text).trim();

  // ① 注入检测：LLM 之前先过闸（无论哪条通道都必须先过）
  const hits = scanInjection(t);
  if (hits.length) {
    gateway.audit(user.id, 'gateway', 'injection.scan', { text: t.slice(0, 60) }, 'INJECTED_BLOCKED',
      `检测到 ${hits.length} 处提示词注入特征，已拦截（输入未进入 Agent 指令层）`);
    return { type: 'blocked', text: '⚠️ 检测到提示词注入攻击：你的输入中包含"覆盖系统指令"类内容，已被安全网关拦截，未传递给 Agent。本次攻击已记录安全日志，可在安全中心查看。' };
  }

  // ② LLM 通道（大模型只负责理解语言、生成意图，输出仍过网关校验）
  const llm = require('./llm');
  if (llm.isConfigured()) {
    try {
      const acc = db.accounts.find(a => a.userId === user.id);
      const intent = await llm.parseIntentLLM(t, {
        userName: user.name, balance: yuan(acc.balance), riskLevel: user.riskLevel
      });
      const r = executeIntent(user, t, intent, 'llm');
      if (r) return r;
      // 意图不明确 → 继续走规则引擎兜底
    } catch (e) {
      gateway.audit(user.id, 'gateway', 'llm.fallback', { error: String(e).slice(0, 80) }, 'OK',
        '大模型通道异常，自动降级为本地规则引擎（演示不中断）');
    }
  }

  // ③ 规则引擎通道（原逻辑，同时是 LLM 的降级兜底）
  if (/(你好|hi|hello|在吗)/i.test(t)) {
    return { type: 'answer', text: `你好，${user.name}！我是你的银行智能助手。我可以：查余额、查账单、转账（需你验证）、定时转账、发起 AA、推荐和申购理财、冻结卡片。\n试试说："查一下余额"、"给小红转 100 元"。` };
  }
  if (/(余额|还剩多少钱|多少钱|账户|存款)/.test(t) && !/(转|付)/.test(t)) {
    const acc = db.accounts.find(a => a.userId === user.id);
    gateway.audit(user.id, 'agent', 'query.balance', {}, 'OK', 'Agent 查询余额（P0 只读，脱敏返回）');
    return { type: 'answer', text: `你的当前余额为 ¥${yuan(acc.balance)}（P0 只读操作，无需验证，自动脱敏显示）。` };
  }
  if (/(账单|消费|花了|支出|月账单)/.test(t)) {
    const month = new Date(Date.now() - 26 * 86400000).toISOString().slice(0, 7);
    return monthlyBillAnswer(user, month);
  }
  if (/(推荐|买什么)(理财|产品|基金)?|(理财|产品)推荐/.test(t)) {
    return recommendAnswer(user);
  }
  if (/(持仓|我买的|我的理财)/.test(t)) {
    const hs = db.holdings.filter(h => h.userId === user.id);
    if (!hs.length) return { type: 'answer', text: '你当前暂无理财持仓。可以对我说"推荐一下理财"。' };
    const lines = hs.map(h => { const p = db.products.find(p => p.id === h.productId); return `· ${p.name}（${p.risk}）：¥${yuan(h.amount)}`; });
    return { type: 'answer', text: `当前持仓：\n${lines.join('\n')}\n赎回请说"赎回理财"（P2 资金操作，需验证）。` };
  }

  // ④ 操作意图 → 过权限网关
  const intent = parseIntent(user, t);
  if (!intent) {
    return { type: 'answer', text: '我还没有理解你的意思 😥 我目前支持：查余额/账单、转账、定时转账、AA 收款、理财推荐与申赎、卡片冻结。例如："给小红转 200 元"。' };
  }
  return dispatchIntent(user, intent);
}

// ---- 意图白名单（LLM 输出只允许是这里的动作，其余一律拒绝）----
const INTENT_WHITELIST = new Set([
  'query.balance', 'query.bills', 'query.holdings', 'recommend.wealth', 'chat.small',
  'transfer.execute', 'scheduled.create', 'aa.create', 'wealth.subscribe', 'wealth.redeem',
  'card.freeze', 'card.unfreeze',
  'paypass.change', 'phone.unbind', 'security.disable', 'card.remove'
]);

// ---- 统一意图执行（LLM 与规则引擎共用；LLM 输出视为不可信数据，先过白名单校验）----
function executeIntent(user, t, intent, source) {
  if (!intent || !INTENT_WHITELIST.has(intent.action)) return null; // 未知动作 → 降级规则引擎
  const params = intent.params || {};
  gateway.audit(user.id, source === 'llm' ? 'llm' : 'agent', 'intent.parse',
    { action: intent.action }, 'OK', `${source === 'llm' ? '大模型' : '规则引擎'}解析意图：${intent.action}（输出已过白名单校验）`);

  // 查询类（P0 只读）
  if (intent.action === 'query.balance') {
    const acc = store.get().accounts.find(a => a.userId === user.id);
    return { type: 'answer', text: `你的当前余额为 ¥${yuan(acc.balance)}（P0 只读操作，无需验证，自动脱敏显示）。` };
  }
  if (intent.action === 'query.bills') {
    const month = params.month && /^\d{4}-\d{2}$/.test(params.month) ? params.month
      : new Date(Date.now() - 26 * 86400000).toISOString().slice(0, 7);
    return monthlyBillAnswer(user, month);
  }
  if (intent.action === 'query.holdings') {
    const hs = store.get().holdings.filter(h => h.userId === user.id);
    if (!hs.length) return { type: 'answer', text: '你当前暂无理财持仓。可以对我说"推荐一下理财"。' };
    const lines = hs.map(h => { const p = store.get().products.find(p => p.id === h.productId); return `· ${p.name}（${p.risk}）：¥${yuan(h.amount)}`; });
    return { type: 'answer', text: `当前持仓：\n${lines.join('\n')}\n赎回请说"赎回理财"（P2 资金操作，需验证）。` };
  }
  if (intent.action === 'recommend.wealth') return recommendAnswer(user);
  if (intent.action === 'chat.small') {
    const reply = String(params.reply || '我还没有理解你的意思。我支持：查余额/账单、转账、定时转账、AA、理财推荐与申赎。').slice(0, 160);
    return { type: 'answer', text: reply };
  }

  // 操作类：参数补全 → 权限网关
  if ((intent.action === 'transfer.execute' || intent.action === 'scheduled.create') && (!params.amount || !params.toName)) {
    return { type: 'answer', text: '请把信息说完整，例如："给小红转 100 元" 或 "每月 15 号自动给房东转 2000 元"。' };
  }
  if (intent.action === 'aa.create' && !params.total) {
    return { type: 'answer', text: '请说明总金额，例如："和小红、小李 AA 吃饭，总共 300 元"。' };
  }
  return dispatchIntent(user, intent);
}

// ---- 操作类意图统一过网关 ----
function dispatchIntent(user, intent) {
  const params = intent.params || {};

  const res = gateway.agentCall(user, intent.action, params);

  if (res.blocked) {
    return { type: 'blocked', text: '🛡️ ' + res.message };
  }
  if (res.free) {
    // P0 直接执行（当前无 P0 写操作，兜底）
    return { type: 'answer', text: '该操作为只读操作，已直接执行。' };
  }
  const ap = res.approval;
  return {
    type: 'approval',
    text: `好的，我已生成操作申请单（${ap.actionDesc}）。根据权限网关策略，该操作为 P${ap.level} 级${ap.level >= 2 ? '（资金类，需支付密码 + 短信验证码双重验证）' : '（低敏操作，需一次性确认）'}。请在下方确认卡片中核对操作摘要后验证执行。\n⚠️ 我只能"申请"，无权直接动用你的资金。`,
    approval: { id: ap.id, action: ap.action, actionDesc: ap.actionDesc, level: ap.level, params: ap.params, expiresAt: ap.expiresAt, needSms: ap.level >= 2 },
    smsHint: res.sms ? `【演示短信】验证码已发送至 ${res.sms.phone.slice(0, 3)}****${res.sms.phone.slice(-4)}（演示环境验证码直接显示在右下角短信面板）` : null
  };
}

// ---- 月度账单回答 ----
function monthlyBillAnswer(user, month) {
  const db = store.get();
  const bills = db.bills.filter(b => b.userId === user.id && b.date.startsWith(month));
  if (!bills.length) return { type: 'answer', text: `${month} 暂无账单记录。可在「账单」页上传 CSV 账单。` };
  const total = bills.reduce((s, b) => s + b.amount, 0);
  const byCat = {};
  bills.forEach(b => { byCat[b.category] = (byCat[b.category] || 0) + b.amount; });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([c, v]) => `${c} ¥${yuan(v)}`).join('、');
  gateway.audit(user.id, 'agent', 'query.bills', { month }, 'OK', 'Agent 查询月度账单（P0 只读）');
  return { type: 'answer', text: `${month} 账单：共 ${bills.length} 笔，总支出 ¥${yuan(total)}。\n支出前三位：${cats}。\n详细分类与趋势图请看「账单」页。` };
}

// ---- 理财推荐（可解释）----
function recommendAnswer(user) {
  const db = store.get();
  if (!user.riskLevel) return { type: 'answer', text: '请先在「理财」页完成风险测评，我再为你推荐匹配的产品。' };
  const level = Number(user.riskLevel.slice(1));
  const acc = db.accounts.find(a => a.userId === user.id);
  // 简单结余估算：余额中超出 3000 元应急金额的部分视为可投结余
  const surplus = Math.max(0, acc.balance - 300000);
  const pool = db.products.filter(p => Number(p.risk.slice(1)) <= level);
  const pick = pool.sort((a, b) => b.rate - a.rate)[0];
  const conservative = db.products.find(p => p.risk === 'R1');
  gateway.audit(user.id, 'agent', 'query.products', { recommend: pick.id }, 'OK', `Agent 推荐理财（基于 ${user.riskLevel} 风险等级 + 结余 ¥${yuan(surplus)}）`);
  return { type: 'answer', text: `基于你的情况：风险等级 ${user.riskLevel}、可投结余约 ¥${yuan(surplus)}（已预留 ¥3,000.00 应急资金），推荐：\n· ${pick.name}（${pick.risk}，参考年化 ${pick.rate}%）— 与你的风险等级匹配，收益弹性较好\n· ${conservative.name}（R1，参考年化 ${conservative.rate}%）— 灵活零钱管理，可随时赎回\n\n推荐理由：在你能承受的风险范围内选择收益最优的产品。申购请说"买 1000 元 ${pick.name}"（P2 验证）。` };
}

// ---- 恶意账单注入检测（上传账单时调用）----
function sanitizeBillText(content) {
  const hits = scanInjection(content);
  // 去除指令样文本，只保留数据
  const cleaned = content.split('\n').filter(line => !scanInjection(line).length).join('\n');
  return { cleaned, hitCount: hits.length, hits };
}

module.exports = { handleChat, scanInjection, sanitizeBillText, parseIntent };
