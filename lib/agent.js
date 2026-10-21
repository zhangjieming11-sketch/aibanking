'use strict';
// ============ Agent：意图解析 + 注入防护 ============
// 说明：参赛演示采用规则意图解析（稳定、离线、可复现）。
// 若比赛允许外接 LLM：LLM 只负责「生成结构化意图 JSON」，意图仍必须经过权限网关——
// 架构不变，LLM 换成 API 调用即可。

const store = require('./store');
const gateway = require('./gateway');
const injection = require('./injection');
const contacts = require('./contacts');
const memory = require('./memory');
const subscriptions = require('./subscriptions');
const loss = require('./loss');
const session = require('./session');
const banking = require('./banking');
const { yuan } = require('./util');

// ---- 数据隔离层：注入防火墙统一入口（见 lib/injection.js）----
// 用户输入、账单文本、转账备注、收款人名……都先过这里。
// 外部数据永远只是「数据」，绝不会被当成「指令」送进 Agent 指令层。
function scanInjection(text) {
  return injection.scan(text).hits;
}

// 把任意外部数据打上「不可信」标签：进入指令层之前必须显式标记来源，
// 只有带 trusted=true 的内容才允许参与意图解析。
function tagUntrusted(value, source) {
  return { __untrusted: true, source: source || 'external', value: String(value == null ? '' : value) };
}

// 输出侧过滤：Agent 的对外文案在返回前再过一遍，防止任何"已完成/已绕过"类越权话术漏出。
// 注意：只判定「宣称操作已完成/已绕过」这类确定语气，避免误伤正常说明文案（如"绕过验证类攻击已被拦截"）。
const OUTPUT_BLOCKLIST = [
  /已(经)?(直接)?(转账|扣款|支付|划转|汇款)(成功|完成|到账)/,
  /(已|成功)(绕过|跳过|关闭|解除了?|取消了?)(了)?(安全|验证|风控|密码|校验|限制|防护)/,
  /(无需|不用|不必)输入?(验证码|支付密码|短信验证码|密码)?(就|即可|就能|已)/,
  /已经?(解绑|关闭)(了)?(手机|安全策略|验证方式)/
];
function filterOutput(text) {
  const t = String(text == null ? '' : text);
  const hit = OUTPUT_BLOCKLIST.find(re => re.test(t));
  if (hit) return { ok: false, text: '系统已按安全策略处理本次请求（输出内容被安全过滤层拦截）。' };
  return { ok: true, text: t };
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

// ---- C4 指代消解：把「他 / 她 / 刚才那个」落到本次会话最近用过的收款人 ----
// 只在本会话内有效（lastPayee 按用户存），跨会话不猜，避免张冠李戴。
const PRONOUN = /^(他|她|它|这个人|那个人|刚才那个|刚才那位|还是他|还是她|同上|老样子)$/;
function derefPayee(userId, name) {
  const s = String(name == null ? '' : name).trim();
  if (!PRONOUN.test(s)) return { name: s, deref: false };
  const db = store.get();
  const last = (db.lastPayee || {})[userId];
  if (!last) return { name: s, deref: false, reason: 'no-context' };
  const c = (db.contacts || []).find(x => x.id === last.contactId && x.userId === userId);
  if (!c) return { name: s, deref: false, reason: 'contact-gone' };
  const alias = (Array.isArray(c.aliases) && c.aliases[0]) || c.realName;
  return { name: alias, deref: true, from: alias, realName: c.realName };
}

function rememberPayee(userId, contact) {
  const db = store.get();
  if (!db.lastPayee) db.lastPayee = {};
  const alias = (Array.isArray(contact.aliases) && contact.aliases[0]) || contact.realName;
  db.lastPayee[userId] = { alias, contactId: contact.id, at: Date.now() };
}

// ---- C2 / C5 余额不足时的自主出路 ----
// 不直接报「余额不足」，而是算出差额并给出可执行的替代方案；最多反思 2 次，之后建议人工。
function balanceAdvice(user, amount, params) {
  const db = store.get();
  const amt = Math.round(Number(String(amount == null ? '' : amount).replace(/[,，\s]/g, '')) * 100);
  if (!Number.isFinite(amt) || amt <= 0) return null;
  const acc = db.accounts.find(a => a.userId === user.id);
  if (!acc) return null;
  const available = acc.balance - (acc.escrowCents || 0);
  if (available >= amt) return null;

  const gap = amt - available;
  const holdings = db.holdings.filter(h => h.userId === user.id);
  const holdTotal = holdings.reduce((s, h) => s + h.amount, 0);
  if (!db.reflect) db.reflect = {};
  db.reflect[user.id] = (db.reflect[user.id] || 0) + 1;
  const round = db.reflect[user.id];

  const base = Object.assign({}, params || {});
  const options = [];
  if (holdTotal > 0) {
    const h = holdings.slice().sort((a, b) => b.amount - a.amount)[0];
    options.push({
      key: 'redeem', label: `赎回理财 ${yuan(h.amount)} 补足`,
      note: h.amount >= gap ? '赎回后余额足够，可继续转账' : '仍差一点，需再配合其他方式',
      ops: { action: 'wealth.redeem', params: { holdingId: h.id } }
    });
  }
  options.push({
    key: 'reduce', label: `改成 ${yuan(available)}（当前可用上限）`,
    note: '金额降到可用余额以内，立即到账',
    ops: { action: 'transfer.execute', params: Object.assign({}, base, { amount: String(available / 100) }) }
  });
  options.push({
    key: 'split', label: `预约明天转 ${yuan(gap)}`,
    note: '先转可用部分，缺口明天自动执行',
    ops: {
      action: 'scheduled.create',
      params: Object.assign({}, base, { amount: String(gap / 100), freq: 'once', nextRun: Date.now() + 86400000 })
    }
  });

  const overLimit = round > 2;
  return {
    available, amount: amt, gap, round,
    overLimit,
    options: overLimit ? [] : options,
    text: overLimit
      ? `我试了几种办法，缺口 ¥${yuan(gap)} 仍然补不上（已尝试 ${round - 1} 次）。建议先向账户转入资金，或到网点咨询。`
      : `可用余额 ¥${yuan(available)}，这笔需要 ¥${yuan(amt)}，还差 ¥${yuan(gap)}。\n`
        + `我不建议直接失败，这里有三个可行做法：\n`
        + options.map((o, i) => `${i + 1}. ${o.label}——${o.note}`).join('\n')
        + `\n\n选一个我帮你办（资金动作仍需你本人验证）。`
  };
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

  // ================= 代词引用（对象栈）=================
  // 「买它 / 取消它 / 赎回那个」——只在短句里生效，长句可能含别的意图。
  if (session.isPronoun(t) && t.length <= 14) {
    const rec = session.recent(user.id);
    if (/(买|申购|买入)/.test(t)) {
      const p = session.getObject(user.id, 'product');
      return p
        ? { action: 'wealth.subscribe', params: { productId: p.id, amount: '1000' } }
        : { action: 'chat.small', params: { reply: '想买哪一只？先说「推荐一下理财」，我再帮你买。' } };
    }
    if (/(取消|撤销|退订|关掉|不办了)/.test(t)) {
      if (rec && rec.kind === 'subscription') return { action: 'subscription.cancel', params: { subscriptionId: rec.obj.id } };
      if (rec && rec.kind === 'plan') return { action: 'plan.rollback', params: { planId: rec.obj.id } };
      return { action: 'chat.small', params: { reply: '要取消的是哪一项？说具体名称更稳妥，比如「取消云盘存储 Pro」。' } };
    }
    if (/(赎回|取出|卖掉)/.test(t)) {
      const p = session.getObject(user.id, 'product');
      const db0 = store.get();
      const h = p ? db0.holdings.find(x => x.userId === user.id && x.productId === p.id) : null;
      return h
        ? { action: 'wealth.redeem', params: { holdingId: h.id } }
        : { action: 'chat.small', params: { reply: '你没有这只产品的持仓，先买入之后才能赎回。' } };
    }
  }

  // ================= A4.3–A4.5 / C6 · 挂失与调额 =================
  if (/(卡|卡片|银行卡).{0,8}(丢了|不见了|丢失|遗失|被偷|被盗|被刷)|挂失/.test(t)) {
    return { action: 'loss.report', params: {} };
  }
  if (/(额度|限额).{0,8}(提|调高|增加|升|涨)|提额/.test(t)) {
    return { action: 'query.limit', params: {} };
  }

  // ================= A6 · 记忆与跨场景（特征词强，优先于通用规则）=================
  if (/(记住|记一下|帮我记|别忘了|记下)/.test(t) && /(生日|纪念日|口味|喜欢喝|理财目标)/.test(t)) {
    const key = memory.guessKey(t);
    return { action: 'memory.write', params: key ? { key, value: memory.extractValue(t) || '' } : {} };
  }
  if (/(生日|纪念日).{0,6}(是几号|是哪天|多少号|什么时候)|(你还)?记得我.{0,8}(生日|纪念日|喜欢)/.test(t)) {
    const key = memory.guessKey(t) || 'family.birthday.spouse';
    return { action: 'memory.query', params: { key } };
  }
  // 撤销必须排在创建之前：否则「撤销生日惊喜」会先被「生日惊喜」命中，变成再建一个计划
  if (/(撤销|取消|回滚|不办了).{0,8}(计划|惊喜|安排|生日)/.test(t)) {
    return { action: 'plan.rollback', params: {} };
  }
  // C1 计划可重规划：跳过某步 / 把某步提前
  if (/(跳过|不用|别|取消).{0,6}(提醒|日历|通知)/.test(t)) {
    const step = /通知/.test(t) ? 'notify' : 'calendar';
    return { action: 'plan.adjust', params: { step, op: 'skip' } };
  }
  if (/(先|优先|提前).{0,6}(锁资|预留|锁钱|付款)/.test(t)) {
    return { action: 'plan.adjust', params: { step: 'escrow', op: 'first' } };
  }
  if (/(生日惊喜|准备.{0,6}生日|生日.{0,4}(安排|准备|惊喜|礼物))/.test(t)) {
    return { action: 'plan.create', params: { eventDate: memory.extractValue(t) || '', amount: String(parseAmount(t) || '200') } };
  }

  // ================= A3 · 订阅 / 代扣 =================
  if (/(取消|关闭|停掉|退订|关掉)/.test(t)
      && (/(订阅|会员|自动扣费|续费|代扣)/.test(t) || subscriptions.listFor(user.id).some(s => t.includes(s.merchant)))) {
    return { action: 'subscription.cancel', params: {} };
  }
  if (/(申诉|投诉|重复扣费|多扣了|扣了两次)/.test(t)) {
    return { action: 'subscription.report', params: {} };
  }
  if (/(有哪些|查一下|查查|看看|我的).{0,6}(自动扣费|订阅|代扣|续费)|自动扣费|订阅管理|续费管理/.test(t)) {
    return { action: 'query.subscriptions', params: {} };
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
    // 「换卡」场景：从话术里抽出新账号，交由收款人解析层按待验证处理
    const acct = (t.match(/(62\d{11,17})/) || [])[1] || null;
    let payee = parsePayee(t);
    if (!payee) {
      const m = t.match(/(我妈|我父|我爸|我哥|我姐|老婆|老公|妈妈|爸爸|家人|儿子|女儿)(?:刚|最近)?(?:换|新)(?:了)?(?:卡|号|账号)/);
      if (m) payee = m[1].replace(/^我/, '');
    }
    return { action: 'transfer.execute', params: { toName: payee, amount: parseAmount(t), toAccount: acct } };
  }

  return null;
}

// ---- 主入口：处理一条用户消息 ----
// 通道：注入扫描 → （已配置时）LLM 意图解析 → 权限网关；LLM 不可用自动降级规则引擎
async function handleChatInner(user, text) {
  const db = store.get();
  const t = String(text).trim();

  // ① 数据隔离层：LLM 之前先过闸（无论哪条通道都必须先过）。
  //    命中即为「不可信数据试图越界成指令」，直接拦在指令层之外。
  const scanned = injection.scan(t);
  if (!scanned.clean) {
    const attackType = injection.describe(scanned.hits);
    const evidence = scanned.hits.map(h => h.id).join(',');
    const log = gateway.audit(user.id, 'gateway', 'injection.scan', { text: t.slice(0, 60) }, 'INJECTED_BLOCKED',
      `检测到【${attackType}】，证据规则 ${evidence}；输入被数据隔离层拦截，未进入 Agent 指令层`);
    return {
      type: 'blocked', blocked: true, layer: gateway.LAYER.DATA,
      attackType, evidence, ref: '#' + log.ref, auditId: log.id,
      text: `⚠️ 检测到提示词注入攻击：【${attackType}】。你的输入被「数据隔离层」拦截，从未传递给 Agent —— 外部文本永远只是数据，不会被当成指令执行。本次攻击已写入安全审计（证据编号 #${log.ref}）。`
    };
  }

  // ①.2 会话槽位：上一轮在追问某个字段时，先把这句话当成「补充值」而不是新指令。
  //     这一步让「给妈妈转」→「100」能接上，不用整句重说。
  const pendSlot = session.get(user.id);
  if (pendSlot && pendSlot.missing && pendSlot.missing.length) {
    // 先看这句本身是不是一个完整的新指令：是的话就放弃填槽，走新指令。
    // 否则「转账」建立的槽位会把后面所有短句（比如「冻结工资卡」）都吞成收款人。
    const own = parseIntent(user, t);
    if (own && own.action && own.action !== pendSlot.action && own.action !== 'chat.small') {
      session.clear(user.id);
    } else {
      const filled = session.tryFill(user.id, t);
      if (filled) {
        if (filled.missing.length) {
          return {
            type: 'answer',
            text: session.questionFor(filled) + '\n（直接回一句就行）',
            sessionPending: true
          };
        }
        session.clear(user.id);
        const r2 = executeIntent(user, t, { action: filled.action, params: Object.assign({}, filled.slots) }, 'session');
        if (r2) return r2;
      }
    }
  }

  // ①.5 C3 中断恢复：已有未确认单据时，新的「操作类」意图先问一句再执行。
  //      查询类不打断——问个余额还要被弹窗拦，体验会很烦。
  const pend = (db.approvals || []).filter(a => a.userId === user.id && a.status === 'pending' && a.expiresAt > Date.now());
  if (pend.length) {
    const ni = parseIntent(user, t);
    const OP = /^(transfer\.|scheduled\.|aa\.|wealth\.(subscribe|redeem)|card\.(freeze|unfreeze|reportLoss)|subscription\.|plan\.(create|rollback|adjust)|escrow\.)/;
    const lastAp = pend[pend.length - 1];
    // C3 的做法是「压栈 + 提示」，不是「阻断」。
    // 早期版本一旦有未确认单据就直接拦住新意图，结果连办别的事都被挡（体验伤害大，
    // 也把连续操作的验收用例全部拦住）。现在改为：照常执行，由外层在回复末尾附一句提醒，
    // 用户说「继续」可回到原单据 —— 上下文没丢，操作也没被打断。
    if (ni && OP.test(ni.action)) {
      if (!db.interrupted) db.interrupted = {};
      const prev = db.interrupted[user.id];
      const same = prev && prev.pendingId === lastAp.id;
      if (!same) {
        db.interrupted[user.id] = {
          action: ni.action, text: t, at: Date.now(),
          pendingId: lastAp.id, pendingDesc: lastAp.actionDesc
        };
      }
    }
  }
  if (/^(继续|接着|先处理|回去|回到)/.test(t) && db.interrupted && db.interrupted[user.id]) {
    const it = db.interrupted[user.id];
    const ap = (db.approvals || []).find(a => a.id === it.pendingId);
    if (ap && ap.status === 'pending' && ap.expiresAt > Date.now()) {
      return { type: 'answer', text: `好的，回到「${ap.actionDesc}」。请在上方的确认卡片完成验证；卡片若已滚出视野，把原话再说一次我重建一张。` };
    }
    delete db.interrupted[user.id];
    return { type: 'answer', text: '那张单据已经失效了，重新说一次需求，我帮你重建。' };
  }

  // ② 强特征意图优先（A3/A6）：这些句式与动作是一一映射，规则比模型更可靠；
  //    且模型尚未见过这些新动作，交给它只会退化成闲聊。其余意图仍走 LLM。
  const A3A6_ACTIONS = new Set([
    'query.subscriptions', 'subscription.cancel', 'subscription.report',
    'memory.write', 'memory.query', 'plan.create', 'plan.rollback',
    'loss.report', 'query.limit', 'plan.adjust'
  ]);
  const ruleIntent = parseIntent(user, t);
  // 代词短句（买它 / 取消它）必须走规则：模型没见过上下文对象栈
  if (ruleIntent && (A3A6_ACTIONS.has(ruleIntent.action) || session.isPronoun(t))) {
    const r = executeIntent(user, t, ruleIntent, 'rules');
    if (r) return r;
  }

  // ③ LLM 通道（大模型只负责理解语言、生成意图，输出仍过网关校验）
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

  // ④ 规则引擎通道（原逻辑，同时是 LLM 的降级兜底）
  if (/(你好|hi|hello|在吗)/i.test(t)) {
    return { type: 'answer', text: `你好，${user.name}！我是你的银行智能助手。我可以：查余额、查账单、转账（需你验证）、定时转账、发起 AA、推荐和申购理财、冻结卡片。\n试试说："查一下余额"、"给小红转 100 元"。` };
  }
  if (/(余额|还剩多少钱|多少钱|账户|存款)/.test(t) && !/(转|付)/.test(t)) {
    const acc = db.accounts.find(a => a.userId === user.id);
    gateway.audit(user.id, 'agent', 'query.balance', {}, 'OK', 'Agent 查询余额（P0 只读，脱敏返回）');
    return { type: 'answer', text: `你的当前余额为 ¥${yuan(acc.balance)}（P0 只读操作，无需验证，自动脱敏显示）。` };
  }
  if (/(账单|消费|花了|支出|月账单)/.test(t)) {
    return monthlyBillAnswer(user, normalizeMonth(null, t));
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
  // 规则通道也必须走 executeIntent：缺参追问（会话槽位）与参数补全都在那里。
  // 早先这里直接 dispatchIntent，导致「给妈妈转」被丢给网关做参数校验，而不是追问金额。
  return executeIntent(user, t, intent, 'rules') || dispatchIntent(user, intent);
}

// ---- 意图白名单（LLM 输出只允许是这里的动作，其余一律拒绝）----
const INTENT_WHITELIST = new Set([
  'query.balance', 'query.bills', 'query.holdings', 'recommend.wealth', 'chat.small',
  'transfer.execute', 'scheduled.create', 'aa.create', 'wealth.subscribe', 'wealth.redeem',
  'card.freeze', 'card.unfreeze',
  'paypass.change', 'phone.unbind', 'security.disable', 'card.remove',
  // A3 · 订阅 / 代扣
  'query.subscriptions', 'subscription.cancel', 'subscription.report',
  // A6 · 记忆与跨场景链路
  'memory.write', 'memory.query', 'plan.create', 'plan.rollback',
  // A4.3–A4.5 / C6 · 挂失与调额
  'loss.report', 'query.limit',
  // C1 · 计划重规划
  'plan.adjust'
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
    // 收入类问题：账单模块只统计支出。拿支出数字回答「我工资多少」就是答非所问。
    if (/(工资|收入|到账|进账|入账|发了多少)/.test(t)) {
      return {
        type: 'answer',
        text: '账单只统计支出，不包含工资等收入。收入明细可以在「转账记录」里看入账，或等我接入流水后按笔核对。'
      };
    }
    // 带地点/商户条件的支出查询：查得到就给数字，查不到就明说没有，绝不拿整体账单糊弄
    const mq = t.match(/(?:在|去|上次去|上次在)([\u4e00-\u9fa5]{2,8}?)(?:花|消费|吃|买|玩|住)/);
    if (mq) {
      const kw = mq[1];
      const dbq = store.get();
      const hit = (dbq.bills || []).filter(b => b.userId === user.id && String(b.merchant || '').includes(kw));
      if (!hit.length) {
        return {
          type: 'answer',
          text: `账单里没有「${kw}」相关的消费记录。可能是没刷这张卡，或者商户名不含这个关键词——我不会把整体账单当成它的数字报给你。`
        };
      }
      const sum = hit.reduce((s, b) => s + b.amount, 0);
      return {
        type: 'answer',
        text: `与「${kw}」相关的消费共 ${hit.length} 笔，合计 ¥${yuan(sum)}。\n${hit.slice(-5).map(b => `· ${b.date} ${b.merchant} ¥${yuan(b.amount)}`).join('\n')}`
      };
    }
    return monthlyBillAnswer(user, normalizeMonth(params.month, t));
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

  // ================= A4.3–A4.5 / C6 · 挂失影响评估（先评估，再确认，最后 OTP）=================
  if (intent.action === 'loss.report') {
    const a = loss.assess(user.id, params.cardId);
    if (!a.ok) return { type: 'answer', text: a.message };
    return { type: 'answer', text: lossAnswer(a), loss: a };
  }
  if (intent.action === 'query.limit') {
    const lim = user.limits || {};
    return {
      type: 'answer',
      text: `提额需要人工审核，我不能直接调高你的限额。\n\n当前限额：单笔 ¥${yuan(lim.single || 0)} · 单日 ¥${yuan(lim.daily || 0)}\n\n可见的替代做法：\n· 分多笔转出（每笔不超过单笔限额）\n· 到「安全中心 → 交易限额」本人调整（属高危操作，Agent 永久无权）\n· 到网点提交提额申请`,
      limit: { single: lim.single || 0, daily: lim.daily || 0 }
    };
  }

  // ================= A3 · 订阅扫描（P0 只读，直接返回列表卡）=================
  if (intent.action === 'query.subscriptions') {
    const r = banking.execute(user, 'query.subscriptions', {});
    if (!r.ok) return { type: 'answer', text: r.message };
    return { type: 'answer', text: subscriptionAnswer(r.list), subscriptions: r.list };
  }

  // ================= A3 · 取消 / 申诉（P1，需确认）=================
  if (intent.action === 'subscription.cancel' || intent.action === 'subscription.report') {
    if (!params.subscriptionId) {
      const all = subscriptions.listFor(user.id);
      const named = all.find(s => String(t).includes(s.merchant));
      if (named) {
        params.subscriptionId = named.id;
      } else if (intent.action === 'subscription.report') {
        // 申诉：直接锁定「有重复扣费的那一项」，不让用户自己再挑一遍
        const dups = all.filter(s => s.duplicateCount > 0);
        if (!dups.length) {
          return { type: 'answer', text: '我扫描了最近的扣费记录，没有发现重复扣费。如果确实被多扣了，可以说「取消 + 商户名」先停掉自动续费，再联系客服核实。' };
        }
        if (dups.length === 1) params.subscriptionId = dups[0].id;
        else {
          return {
            type: 'answer',
            text: `检测到 ${dups.length} 项疑似重复扣费，要申诉哪一项？\n${dups.map(s => `· ${s.merchant}（多扣 ${s.duplicateCount} 次，¥${yuan(s.amount)}）`).join('\n')}`,
            subscriptions: dups
          };
        }
      } else {
        const list = all.filter(s => s.status !== 'cancelled');
        if (list.length === 1) params.subscriptionId = list[0].id;
        else {
          const lines = list.map(s => `· ${s.merchant}（${s.cycleLabel} ¥${yuan(s.amount)}）${s.duplicateCount ? ' ⚠️ 疑似重复扣费' : ''}`).join('\n');
          return {
            type: 'answer',
            text: `你有 ${list.length} 项自动扣费，要取消哪一项？\n${lines}\n\n直接说「取消云盘存储 Pro」即可。`,
            subscriptions: list
          };
        }
      }
    }
    intent.params = params;
    return dispatchIntent(user, intent);
  }

  // ================= A6 · 记忆（写 P1 确认 / 查只读）=================
  if (intent.action === 'memory.write' || intent.action === 'memory.query') {
    const key = params.key || memory.guessKey(t);
    if (!key) {
      return {
        type: 'answer',
        text: '你想让我记住哪一类信息？目前支持：爱人生日、孩子生日、父母生日、纪念日、蛋糕口味、常喝饮品、理财目标。\n例如：「记住我爱人生日 10月28日」。'
      };
    }
    if (intent.action === 'memory.query') {
      const r = banking.execute(user, 'memory.query', { key });
      return {
        type: 'answer', text: r.message,
        memory: { key, label: r.label, value: r.value || null, found: !!r.found }
      };
    }
    const label = (memory.SCHEMA[key] || {}).label || '该信息';
    const value = params.value || memory.extractValue(t);
    if (!value) {
      return { type: 'answer', text: `请告诉我${label}，例如「记住我的${label}是 10月28日」。` };
    }
    const chk = memory.validate(key, value);
    if (!chk.ok) return { type: 'answer', text: chk.message };
    params.key = key;
    params.value = chk.value;
    intent.params = params;
    return dispatchIntent(user, intent);
  }

  // ================= A6 · 生日惊喜链路（P1 建计划，锁资另走 P2）=================
  if (intent.action === 'plan.create') {
    if (!params.eventDate) {
      // 优先用已记住的生日；没有就追问，不猜日期
      const m = memory.read(user.id, 'family.birthday.spouse');
      if (m.found) params.eventDate = m.value;
    }
    if (!params.eventDate) {
      return {
        type: 'answer',
        text: '可以。为了不搞错日期，先告诉我生日是哪天：\n· 「记住我爱人生日 10月28日」，再说「帮我准备生日惊喜」\n· 或者直接说「10月28日帮我准备生日惊喜」'
      };
    }
    if (!params.amount) params.amount = '200';
    if (!params.item) params.item = '生日蛋糕';
    if (!params.title) params.title = '生日惊喜';
    intent.params = params;
    return dispatchIntent(user, intent);
  }

  if (intent.action === 'plan.adjust') {
    if (!params.planId) {
      const list = (store.get().plans || []).filter(p => p.userId === user.id && p.status !== 'reverted');
      if (!list.length) return { type: 'answer', text: '你现在没有可调整的计划。' };
      params.planId = list[list.length - 1].id;
    }
    intent.params = params;
    return dispatchIntent(user, intent);
  }

  if (intent.action === 'plan.rollback') {
    if (!params.planId) {
      const list = (store.get().plans || []).filter(p => p.userId === user.id && p.status !== 'reverted');
      if (list.length === 1) params.planId = list[0].id;
      else if (!list.length) return { type: 'answer', text: '你现在没有待执行的计划。' };
      else {
        return {
          type: 'answer',
          text: `你有 ${list.length} 个计划，要撤销哪一个？\n${list.map((p, i) => `${i + 1}. ${p.title}（${p.eventDate || '未定'}）`).join('\n')}\n\n直接说计划名称即可。`
        };
      }
    }
    intent.params = params;
    return dispatchIntent(user, intent);
  }

  // 操作类：参数补全 → 权限网关
  // LLM 可能漏掉「换卡」话术里的新账号，或把代称解析成缺失值 —— 这里用语规则补齐/兜底，
  // 保证「LLM 通道」与「规则引擎通道」在收款人解析上走同一条防线。
  if (intent.action === 'transfer.execute' || intent.action === 'scheduled.create') {
    const raw = String(t || '');
    const acct = (raw.match(/(62\d{11,17})/) || [])[1];
    if (acct && !params.toAccount) params.toAccount = acct;
    if (!params.toName) params.toName = parsePayee(raw);
  }
  const amtNum = Number(String(params.amount == null ? '' : params.amount).replace(/[,，\s]/g, ''));
  if ((intent.action === 'transfer.execute' || intent.action === 'scheduled.create') && (!params.toName || !(amtNum > 0))) {
    const missing = [];
    if (!params.toName) missing.push('toName');
    if (!(amtNum > 0)) missing.push('amount');   // "0" / "" / null 都算缺失
    const s = session.start(user.id, intent.action, params, missing);
    return {
      type: 'answer',
      text: '请补充一下——' + session.questionFor(s) + '\n（直接回一句就行，比如「100」）',
      sessionPending: true
    };
  }
  if (intent.action === 'aa.create' && !params.total) {
    const s = session.start(user.id, 'aa.create', params, ['total']);
    return {
      type: 'answer',
      text: '请补充一下——' + session.questionFor(s) + '\n（直接回一个数字，比如「300」）',
      sessionPending: true
    };
  }
  return dispatchIntent(user, intent);
}

// ---- 收款人解析层：把「代称字符串」落到一个可信联系人 ----
// 这是语义绕过防御的核心入口（见 lib/contacts.js）。
// 原则：歧义才打断，无歧义不打扰。取不到就停下来问，绝不猜测。
function amountToCents(v) {
  const n = Number(String(v == null ? '' : v).replace(/[,，\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function resolvePayeeGate(user, intent) {
  const params = Object.assign({}, intent.params || {});

  // C4 指代消解：先尝试把「他 / 她 / 刚才那个」换成上一笔用过的联系人。
  // 注意：这里只换名字，最终仍要过通讯录三态校验 —— 指代不能绕过信任判定。
  const dr = derefPayee(user.id, params.toName);
  if (dr.deref) {
    params.toName = dr.name;
    params.__derefFrom = dr.from;
    gateway.audit(user.id, 'agent', intent.action, { from: '代词', to: dr.name }, 'OK',
      `指代消解：把「他/她」解析为此前用过的收款人「${dr.realName || dr.name}」`);
  }

  const r = contacts.resolvePayee(user.id, params.toName);

  // ① 通讯录查无此人 —— 直接拒绝 + 给出出路
  if (r.status === 'unknown') {
    const log = gateway.audit(user.id, 'gateway', intent.action, { toName: String(params.toName || '') }, 'BLOCKED',
      `收款人解析失败：通讯录中无「${params.toName}」，拒绝猜测（语义绕过防御）`, gateway.LAYER.RESOLVE);
    return {
      stop: true,
      reply: {
        type: 'blocked', blocked: true, layer: gateway.LAYER.RESOLVE,
        attackType: '收款人无法解析', evidence: '#' + log.ref, ref: '#' + log.ref, auditId: log.id,
        text: `🔍 通讯录里没有「${params.toName}」，我不会猜测收款人。\n\n为了你的资金安全，请先添加并验证这位联系人，或从通讯录里选一位。\n（这次尝试已记入审计 ${'#' + log.ref}）`,
        actions: [{ label: '➕ 添加为新联系人', action: 'contact.add' }, { label: '📖 从通讯录选择', action: 'contact.pick' }]
      }
    };
  }

  // ② 多位候选人 —— 必须用户点选，绝不自动挑
  if (r.status === 'ambiguous') {
    const list = r.candidates.map(c => `· ${c.realName}｜${c.displayAlias}｜${c.account}${c.trust === 'verified' ? '｜✅ 已验证' : '｜🔶 未验证'}`).join('\n');
    return {
      stop: true,
      reply: {
        type: 'payee_confirm', layer: gateway.LAYER.RESOLVE,
        candidates: r.candidates, warning: r.warning,
        text: `🤔 ${r.warning}：\n${list}\n\n请告诉我要转给哪一位（例如"转给第 1 位"）。`
      }
    };
  }

  // ③ 名称相近 —— 即使只有一个候选，也必须用户确认一次（谐音社工的最后一道人工防线）
  if (r.status === 'similar') {
    const c = r.candidates[0];
    return {
      stop: true,
      reply: {
        type: 'payee_confirm', layer: gateway.LAYER.RESOLVE,
        candidates: r.candidates, warning: r.warning,
        text: `⚠️ 名称相近提醒\n\n通讯录里没有「${r.input}」，但找到一位相似的联系人：\n· ${c.realName}（代称「${c.displayAlias}」）\n· 账号 ${c.account}｜手机 ${c.phone}\n· ${c.trust === 'verified' ? '✅ 已验证' : '🔶 未验证'}｜累计 ${c.transferCount} 笔\n\n${r.warning}\n请确认是不是同一个人；如果是，请用通讯录里的代称重新发起（例如"给${c.displayAlias}转…"）。`
      }
    };
  }

  // ④ 「换卡」场景：账号与已验证账号不一致 → 新账号按 pending 处理，不覆盖原账号
  let contact = r.contact;
  let trust = contact.trust;
  let switchNote = null;
  const inputAccount = String(params.toAccount || '').replace(/\s/g, '');
  if (inputAccount && inputAccount !== contact.account) {
    const db = store.get();
    let alt = (db.contacts || []).find(x => x.userId === user.id && x.account === inputAccount);
    if (!alt) {
      alt = {
        id: 'ct' + require('./util').uid().slice(0, 8), userId: user.id,
        realName: contact.realName, account: inputAccount, phone: contact.phone,
        aliases: [contact.aliases[0] + '的新账号'], trust: 'pending',
        verifyMethod: null, verifiedAt: null, verifiedBy: null,
        createdAt: Date.now(), createdBy: 'system', transferCount: 0,
        firstTransferAt: null, lastTransferAt: null, note: '换卡流程自动登记', recentAddedRisk: false
      };
      db.contacts = db.contacts || [];
      db.contacts.push(alt);
      store.save();
    }
    contact = alt; trust = 'pending';
    switchNote = '（该账号与你通讯录里的账号不一致，已按新账号处理）';
  }

  // ⑤ 三态限额：待验证联系人单笔 ≤ ¥50
  const amountCents = amountToCents(params.amount);
  const risk = contacts.checkPayeeRisk(user, contact, amountCents);
  if (risk.level === 'block') {
    const log = gateway.audit(user.id, 'gateway', intent.action, { toName: params.toName, contactId: contact.id }, 'BLOCKED',
      risk.message, gateway.LAYER.RESOLVE);
    return {
      stop: true,
      reply: {
        type: 'blocked', blocked: true, layer: gateway.LAYER.RESOLVE,
        attackType: '收款人未验证（限额保护）', evidence: '#' + log.ref, ref: '#' + log.ref, auditId: log.id,
        text: `🔶 ${risk.message}\n\n如需转大额，请先完成该联系人的验证（安全中心 → 通讯录 → 去验证）。\n⚠️ 提醒：家人"换卡"是诈骗高发场景，建议通过电话或当面核实后再操作。`,
        actions: [{ label: '📲 去验证', action: 'contact.verify' }]
      }
    };
  }

  // ⑥ 通过：把真实身份注入参数（trust 进入 HMAC 签名范围，篡改即失效）
  // 注意：不要在这里做金额数值化 —— 否则 `1e5` 会被悄悄转成 100000，
  // 绕过 params.js 的格式校验。金额规范化统一交给 validateParams。
  const payeeParams = contacts.toPayeeParams(contact, trust);
  Object.assign(params, payeeParams);
  rememberPayee(user.id, contact);   // 供下一次「转给他」解析
  session.setObject(user.id, 'payee', {
    alias: (Array.isArray(contact.aliases) && contact.aliases[0]) || contact.realName,
    contactId: contact.id, realName: contact.realName
  });
  return {
    stop: false,
    params,
    opts: {
      requireAck: risk.level === 'needAck',
      warning: [switchNote, r.warning, risk.level === 'warn' ? risk.message : null].filter(Boolean).join(' ') || null,
      payee: contacts.publicView(contact)
    }
  };
}

// ---- 操作类意图统一过网关 ----
function dispatchIntent(user, intent) {
  const params = intent.params || {};

  // 收款人解析层：转账 / 定时转账必须先落到可信联系人
  let opts = null;
  let finalParams = params;
  if (intent.action === 'transfer.execute' || intent.action === 'scheduled.create') {
    const gate = resolvePayeeGate(user, intent);
    if (gate.stop) return gate.reply;
    finalParams = gate.params;
    opts = gate.opts;
  }

  // C2 / C5：转账前先算余额。不足时不是「报错」，而是给出可执行的替代方案
  if (intent.action === 'transfer.execute') {
    const adv = balanceAdvice(user, finalParams.amount, finalParams);
    if (adv) return { type: 'answer', text: adv.text, balanceAdvice: adv };
  }

  // 未设置支付密码：在建单**之前**就告知并给设置入口。
  // 安全语义不变（不设密码仍然 fail closed），只是把「到确认页才失败」提前成「现在就能设」。
  const pol2 = gateway.POLICY[intent.action];
  if (pol2 && pol2.level >= 2 && !user.payPasswordHash) {
    return {
      type: 'answer',
      needPayPass: true,
      pendingAction: intent.action,
      text: '这一步需要支付密码，但你还没设置。\n\n'
        + '支付密码是 6 位数字，只在转账、申购这类资金确认时使用；它和登录密码不是一回事，我也碰不到它。\n\n'
        + '设好之后，这笔操作重新说一次就能继续。'
    };
  }

  const res = gateway.agentCall(user, intent.action, finalParams, opts);

  if (res.blocked) {
    return {
      type: 'blocked', blocked: true, layer: res.layer, attackType: '越权操作（策略/校验拦截）',
      evidence: res.ref || '', ref: res.ref, auditId: res.auditId,
      text: '🛡️ ' + res.message + (res.ref ? `（证据编号 ${res.ref}）` : '')
    };
  }
  if (res.free) {
    // P0 直接执行（当前无 P0 写操作，兜底）
    return { type: 'answer', text: '该操作为只读操作，已直接执行。' };
  }
  const ap = res.approval;
  return {
    type: 'approval',
    text: `好的，我已生成操作申请单（${ap.actionDesc}）。根据权限网关策略，该操作为 P${ap.level} 级${ap.level >= 2 ? '（资金类，需支付密码 + 短信验证码双重验证）' : '（低敏操作，需一次性确认）'}。请在下方确认卡片中核对操作摘要后验证执行。\n⚠️ 我只能"申请"，无权直接动用你的资金。`,
    approval: { id: ap.id, action: ap.action, actionDesc: ap.actionDesc, level: ap.level, params: ap.params, expiresAt: ap.expiresAt, needSms: ap.level >= 2, fingerprint: ap.fingerprint, payee: ap.payee || null, warning: ap.warning || null, requireAck: !!ap.requireAck },
    smsHint: res.sms ? `【演示短信】验证码已发送至 ${res.sms.phone.slice(0, 3)}****${res.sms.phone.slice(-4)}（演示环境验证码直接显示在右下角短信面板）` : null
  };
}

// ---- 时间指代归一化（A2.5 / A2.3）----
// 大模型常把「上个月」解析成训练语料里的年份（实测给出 2023-09），这就是年份幻觉。
// 以服务端当前时间为唯一真相：相对指代直接按自然语言算；绝对月份只接受
// 最近 24 个月以内的值，越界（未来 / 过旧）一律收敛回上个月。
function fmtMonth(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function shiftMonth(now, delta) {
  return fmtMonth(new Date(now.getFullYear(), now.getMonth() + delta, 1));
}
function normalizeMonth(raw, text) {
  const now = new Date();
  const t = String(text || '');
  // 相对指代优先，避免模型自作主张
  if (/上上(个)?月|前个?月/.test(t)) return shiftMonth(now, -2);
  if (/上个?月/.test(t)) return shiftMonth(now, -1);
  if (/这个?月|本月|当月/.test(t)) return shiftMonth(now, 0);
  const m = String(raw || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return shiftMonth(now, -1);
  const cand = Number(m[1]) * 12 + (Number(m[2]) - 1);
  const cur = now.getFullYear() * 12 + now.getMonth();
  if (cand > cur || cand < cur - 23) return shiftMonth(now, -1); // 未来或过旧 → 视为幻觉
  return raw;
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

// ---- A4.3–A4.5 · 挂失影响评估的文本版（列表由前端卡片渲染）----
function lossAnswer(a) {
  const sub = a.affected.subscriptions || [];
  const sch = a.affected.scheduled || [];
  const sus = a.affected.suspicious || [];
  const lines = [
    `卡片：${a.card.name} ${a.card.number}`,
    sub.length ? `自动扣费 ${sub.length} 项（${sub.map(s => s.merchant).join('、')}）将随卡停扣` : '自动扣费：无',
    sch.length ? `定时转账 ${sch.length} 个将被暂停` : '定时转账：无',
    sus.length ? `⚠️ 近 7 天有 ${sus.length} 笔可疑交易` : '近 7 天未发现可疑交易'
  ];
  const spare = a.spareCards && a.spareCards.length
    ? `可把自动扣费迁移到「${a.spareCards[0].name}」${a.spareCards[0].number}。`
    : '你没有备用卡，挂失后代扣会暂时停扣。';
  return `⚠️ 挂失不可撤销，请先确认影响：\n${lines.map(l => '· ' + l).join('\n')}\n\n`
    + `挂失后该卡立即冻结，需约 3 个工作日补卡。${spare}\n\n`
    + `确认挂失需要支付密码 + 短信验证码（P2 双重验证），点下方按钮继续。`;
}

// ---- A3 · 订阅列表回答（列表卡由前端渲染，文本做兜底）----
function subscriptionAnswer(list) {
  const active = (list || []).filter(s => s.status !== 'cancelled');
  if (!active.length) return '没有检测到自动扣费。如果刚上传过账单，可以说「我有哪些自动扣费」再扫一次。';
  const dup = active.filter(s => s.duplicateCount > 0);
  const monthly = active.reduce((s, x) => s + (x.cycle === 'yearly' ? Math.round(x.amount / 12)
    : x.cycle === 'quarterly' ? Math.round(x.amount / 3)
    : x.cycle === 'weekly' ? x.amount * 4 : x.amount), 0);
  const lines = active.map(s =>
    `· ${s.merchant}｜${s.cycleLabel} ¥${yuan(s.amount)}｜下次扣费 ${s.nextChargeAt}${s.duplicateCount ? '｜⚠️ 疑似重复扣费' : ''}`
  ).join('\n');
  let text = `你共有 ${active.length} 项自动扣费，每月合计约 ¥${yuan(monthly)}：\n${lines}`;
  if (dup.length) {
    text += `\n\n⚠️ 其中 ${dup.length} 项疑似重复扣费（同一周期内被扣两次）：${dup.map(d => d.merchant).join('、')}。`
      + `\n可以说「申诉重复扣费」，我会提交退款申请。`;
  }
  text += '\n\n要取消哪一项，直接说「取消 + 名称」。';
  return text;
}

// ---- 理财推荐（可解释）----
function recommendAnswer(user) {
  const db = store.get();
  if (!user.riskLevel) {
    // 不再把用户踢去「理财」页，而是在会话里直接给 3 道题（A5.2 + 体验流畅性）
    return {
      type: 'answer',
      needsAssess: true,
      text: '先做一次风险测评——3 道题，30 秒。答完直接出结果，不用跳到别的页面。',
      assessCard: {
        questions: [
          { key: 'horizon', q: '这笔钱大概多久不用？', options: [{ v: 1, t: '随时可能用' }, { v: 2, t: '半年内不用' }, { v: 4, t: '三年以上不用' }] },
          { key: 'drawdown', q: '如果一个月跌了 5%，你会？', options: [{ v: 1, t: '立刻赎回' }, { v: 3, t: '先观察' }, { v: 5, t: '继续持有甚至加仓' }] },
          { key: 'goal', q: '你更看重哪一点？', options: [{ v: 1, t: '保本最重要' }, { v: 3, t: '稳健增值' }, { v: 5, t: '追求更高收益' }] }
        ]
      }
    };
  }
  const level = Number(user.riskLevel.slice(1));
  const acc = db.accounts.find(a => a.userId === user.id);
  // 简单结余估算：余额中超出 3000 元应急金额的部分视为可投结余
  const surplus = Math.max(0, acc.balance - 300000);
  const pool = db.products.filter(p => Number(p.risk.slice(1)) <= level).sort((a, b) => b.rate - a.rate);
  const pick = pool[0] || db.products[0];
  const conservative = db.products.find(p => p.risk === 'R1') || pick;
  const third = pool.find(p => p.id !== pick.id && p.id !== conservative.id);

  // A5.2 对比卡：至少两只并列，含风险等级 / 年化 / 期限 / 起投
  const list = [pick, conservative, third].filter(Boolean)
    .filter((p, i, arr) => arr.findIndex(x => x.id === p.id) === i)
    .slice(0, 3)
    .map(p => ({
      id: p.id, name: p.name, type: p.type, risk: p.risk, rate: p.rate, term: p.term, minCents: p.minCents,
      recommended: p.id === pick.id,
      reason: p.id === pick.id ? '与你风险等级最匹配、收益最优'
        : p.risk === 'R1' ? '随时可取，适合放零钱'
          : '同等级下的另一种期限选择'
    }));

  gateway.audit(user.id, 'agent', 'query.products', { recommend: pick.id }, 'OK',
    `Agent 推荐理财（基于 ${user.riskLevel} 风险等级 + 结余 ¥${yuan(surplus)}）`);

  // 记住被推荐的这只，供「买它」解析
  session.setObject(user.id, 'product', { id: pick.id, name: pick.name, rate: pick.rate, risk: pick.risk });

  return {
    type: 'answer',
    products: list,
    compare: list.length >= 2,
    text: `按你的风险等级 ${user.riskLevel}、可投结余约 ¥${yuan(surplus)}（已预留 ¥3,000 应急），挑了 ${list.length} 只做个对比：\n`
      + list.map(p => `· ${p.name}｜${p.risk}｜参考年化 ${p.rate}%｜${p.term}${p.recommended ? '｜✅ 推荐' : ''}`).join('\n')
      + `\n\n推荐理由：在你能承受的风险范围内选收益最优的，另一只是同等级下的期限备选。`
      + `\n想买哪只说「买 1000 元 ${pick.name}」即可（P2 验证）。`
  };
}

// ---- 主入口（对外）：先走内核，再对输出做最后一道安全过滤 ----
async function handleChat(user, text) {
  const r = await handleChatInner(user, text);
  // C3 附言：只在**操作类**回复里提醒还有别的未确认单据。
  // 查询（查账单/余额）不打扰——不然每句问答尾巴都挂一条，比不提醒更烦。
  if (r && !r.blocked && typeof r.text === 'string') {
    const ni = parseIntent(user, text);
    const isOp = ni && /^(transfer\.|scheduled\.|aa\.|wealth\.(subscribe|redeem)|card\.|subscription\.|plan\.|escrow\.|memory\.write)/.test(ni.action);
    if (isOp) {
      const db = store.get();
      const curId = r.approval && r.approval.id;
      const pend = (db.approvals || []).filter(a =>
        a.userId === user.id && a.status === 'pending' && a.expiresAt > Date.now() && a.id !== curId);
      if (pend.length) {
        const p = pend[pend.length - 1];
        const mins = Math.max(1, Math.ceil((p.expiresAt - Date.now()) / 60000));
        r.text += `\n\n（另有 1 张「${p.actionDesc}」待确认，${mins} 分钟后过期；说「继续」可以回去处理）`;
      }
    }
  }
  if (r && typeof r.text === 'string' && !r.blocked) {
    const f = filterOutput(r.text);
    if (!f.ok) {
      gateway.audit(user.id, 'gateway', 'output.filter', {}, 'BLOCKED',
        'Agent 输出命中越权话术特征，已被输出过滤层替换', gateway.LAYER.DATA);
      return { type: 'blocked', layer: gateway.LAYER.DATA, attackType: '越权话术输出', text: f.text };
    }
  }
  return r;
}

// ---- 恶意账单注入检测（上传账单时调用）----
// 账单文本是不可信外部数据：先按「数据隔离层」扫描，命中的整行剔除，只保留纯数据入库。
function sanitizeBillText(content) {
  const r = injection.sanitize(content);
  return { cleaned: r.cleaned, hitCount: r.hitCount, hits: r.hits, attackType: injection.describe(r.hits) };
}

module.exports = { handleChat, scanInjection, sanitizeBillText, parseIntent, filterOutput, tagUntrusted, resolvePayeeGate };
