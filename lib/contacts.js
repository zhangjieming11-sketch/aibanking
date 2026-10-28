'use strict';
// ============ 收款人可信通讯录（语义绕过防御）============
// 解决的问题：转账参数里的 `toName` 原本是一个「没有根基的字符串」——
// 它不指向任何真实的人，没人验证过，甚至可以是攻击者塞进来的内容。
// Agent 说"我转给妈妈了"，可"妈妈"是谁？账号多少？用户无从核对。
//
// 本模块把「收款人」从一个字符串升级为三态对象：
//   verified  用户亲手添加 + 完成验证  → 正常限额，身份全透明
//   pending   历史沉淀 / 刚添加未验证  → 单笔 ≤ ¥50，红色警示
//   unknown   通讯录查无此人            → 直接拒绝 + 引导添加，绝不猜测
//
// 铁律：`verifiedBy` 恒为 'user'。验证是 P3 级权限，Agent 永远不能把联系人标记为已验证。

const { uid, smsCode, maskPhone, maskCard } = require('./util');

// ---------- 文本归一化：先拆掉常见绕过手法 ----------
const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

function normalize(s) {
  let t = String(s == null ? '' : s);
  try { t = t.normalize('NFKC'); } catch (e) { /* 老引擎兜底 */ }
  return t
    .replace(ZERO_WIDTH, '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[·•.\-_、，,。;；:：!！?？'"“”‘’()（）\[\]【】]/g, '')
    .toLowerCase();
}

// ---------- 编辑距离（零依赖）----------
function levenshtein(a, b) {
  const s = String(a), t = String(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[t.length];
}

// ---------- 高频同音字表：覆盖编辑距离抓不到的"读音相同" ----------
// 演示场景不需要覆盖全部汉字：亲属称谓 + 百家姓前 20 + 常见名字用字，足以覆盖演示用例。
// 这体现的是设计思路，不是覆盖率的完备性（答辩时主动说明边界）。
const HOMOPHONES = {
  '妈': ['馬', '麻', '玛', '蚂', '马'],
  '爸': ['巴', '把', '芭', '吧'],
  '爷': ['耶', '椰'],
  '奶': ['乃', '奈'],
  '哥': ['歌', '戈'],
  '姐': ['借', '解'],
  '叔': ['书', '舒', '输'],
  '姨': ['依', '衣', '医'],
  '张': ['章', '彰', '樟'],
  '李': ['里', '理', '莉', '丽'],
  '王': ['汪', '亡', '旺'],
  '刘': ['流', '留', '柳'],
  '陈': ['晨', '辰', '沉'],
  '杨': ['阳', '洋', '扬'],
  '赵': ['照', '兆'],
  '黄': ['皇', '煌'],
  '周': ['州', '洲', '舟'],
  '吴': ['无', '吾', '伍'],
  '徐': ['许', '旭'],
  '孙': ['荪', '苏'],
  '马': ['妈', '碼'],
  '朱': ['珠', '诸', '竹'],
  '胡': ['湖', '虎', '乎'],
  '林': ['琳', '霖', '临'],
  '郭': ['国', '果'],
  '红': ['虹', '洪', '宏', '鸿'],
  '强': ['墙', '蔷', '腔'],
  '伟': ['玮', '纬', '苇'],
  '芳': ['方', '芬', '房'],
  '明': ['鸣', '铭', '名'],
  '小': ['晓', '筱', '肖'],
  '梅': ['美', '玫', '媒'],
  '刚': ['钢', '岗', '纲'],
  '静': ['净', '敬', '靖'],
  '丽': ['利', '莉', '力']
};

// 两个名字是否"读音相近"：长度相同，且逐字相同或互为同音字
function homophoneMatch(a, b) {
  const s = String(a), t = String(b);
  if (s.length !== t.length || !s.length) return false;
  let diff = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === t[i]) continue;
    const set = HOMOPHONES[s[i]];
    if (set && set.includes(t[i])) { diff++; continue; }
    const set2 = HOMOPHONES[t[i]];
    if (set2 && set2.includes(s[i])) { diff++; continue; }
    return false;
  }
  return diff > 0;
}

function similar(a, b) {
  const s = normalize(a), t = normalize(b);
  if (!s || !t) return false;
  if (s === t) return false;
  if (homophoneMatch(s, t)) return true;
  const d = levenshtein(s, t);
  const maxLen = Math.max(s.length, t.length);
  // 单字替换/增删算相近；长名字允许 1 个编辑距离
  return d <= 1 && maxLen >= 2;
}

// ---------- 存储访问（延迟 require，避免与 store 循环依赖）----------
function db() { return require('./store').get(); }

function allOf(userId) {
  return (db().contacts || []).filter(c => c.userId === userId);
}

function findById(userId, id) {
  return allOf(userId).find(c => c.id === id) || null;
}

// ---------- 种子数据（演示用）----------
// 覆盖四种演示路径：正常 / 混淆警示 / 拒绝 / 低限额
const SEED = [
  {
    realName: '张桂芳', account: '6222020200112233445', phone: '13800001111',
    aliases: ['妈妈', '妈', '老妈', '母亲'], trust: 'verified',
    verifyMethod: 'sms_backfill', daysAgo: 68, transferCount: 12
  },
  {
    realName: '李梅', account: '6222020200112256789', phone: '13800002222',
    aliases: ['妈玛'], trust: 'verified',
    verifyMethod: 'sms_backfill', daysAgo: 40, transferCount: 1
  },
  {
    realName: '王强', account: '6222020200112277889', phone: '13800003333',
    aliases: ['房东', '王房东'], trust: 'verified',
    verifyMethod: 'sms_backfill', daysAgo: 120, transferCount: 8
  },
  {
    realName: '小红', account: '6222800055667788990', phone: '13800000002',
    aliases: ['小红'], trust: 'verified',
    verifyMethod: 'sms_backfill', daysAgo: 200, transferCount: 20
  },
  {
    realName: '李强', account: '6222020200112299001', phone: '13800004444',
    aliases: ['同事小李', '小李'], trust: 'pending',
    verifyMethod: null, daysAgo: 3, transferCount: 2
  }
];

function seedFor(userId) {
  const now = Date.now();
  return SEED.map(s => ({
    id: 'ct' + uid().slice(0, 8),
    userId,
    realName: s.realName,
    account: s.account,
    phone: s.phone,
    aliases: s.aliases.slice(),
    trust: s.trust,
    verifyMethod: s.verifyMethod,
    verifiedAt: s.trust === 'verified' ? now - s.daysAgo * 86400000 : null,
    verifiedBy: s.trust === 'verified' ? 'user' : null,
    createdAt: now - s.daysAgo * 86400000,
    createdBy: s.daysAgo > 10 ? 'system' : 'user',
    transferCount: s.transferCount,
    firstTransferAt: now - s.daysAgo * 86400000,
    lastTransferAt: now - Math.min(s.daysAgo, 5) * 86400000,
    note: '',
    recentAddedRisk: false
  }));
}

// ---------- 对外展示（脱敏）----------
// 尾号只在**多候选人**时用于区分「到底哪一位」——此时用户必须自己辨认，
// 给 4 位尾号不额外泄露信息（他已拥有这些联系人的完整账号）。
// 单人场景不返回尾号，展示仍走 account 脱敏串。
function publicView(c, opts) {
  if (!c) return null;
  const revealTail = !!(opts && opts.revealTail);
  return {
    id: c.id,
    realName: c.realName,
    account: maskCard(c.account),
    accountTail: revealTail ? String(c.account).slice(-4) : null,
    phone: maskPhone(c.phone),
    aliases: c.aliases,
    displayAlias: c.aliases[0],
    trust: c.trust,
    verifyMethod: c.verifyMethod,
    verifiedAt: c.verifiedAt,
    createdAt: c.createdAt,
    transferCount: c.transferCount,
    lastTransferAt: c.lastTransferAt,
    note: c.note,
    recentAddedRisk: !!c.recentAddedRisk
  };
}

function list(userId) {
  return allOf(userId)
    .slice()
    .sort((a, b) => (a.trust === b.trust ? b.transferCount - a.transferCount : a.trust === 'verified' ? -1 : 1))
    .map(publicView);
}

// ---------- 三态限额 ----------
const PENDING_SINGLE_LIMIT = 5000; // ¥50.00（分）
const RECENT_RISK_MS = 24 * 3600 * 1000;
const RECENT_RISK_AMOUNT = 100000; // ¥1,000.00（分）

function limitFor(trust, userLimits) {
  if (trust === 'pending') return { single: PENDING_SINGLE_LIMIT, daily: PENDING_SINGLE_LIMIT };
  return { single: userLimits.single, daily: userLimits.daily };
}

// ---------- 易混淆检测：本次收款人与通讯录里其他人是否"同音不同字" ----------
// 只用同音判定（强信号）：编辑距离 1 会把「小红 / 小李」这类正常不同的人也算进来，
// 造成每次都弹警示，反而训练用户忽略提醒。同音字才是社工混淆的真实形态。
function findSimilar(userId, contact) {
  if (!contact) return [];
  const names = [contact.realName, ...(contact.aliases || [])].map(normalize).filter(Boolean);
  return allOf(userId)
    .filter(c => c.id !== contact.id)
    .filter(c => {
      const other = [c.realName, ...(c.aliases || [])].map(normalize).filter(Boolean);
      return other.some(o => names.some(n => n !== o && homophoneMatch(n, o)));
    })
    .map(publicView);
}

// ---------- 核心：代称解析 ----------
// 返回 { status, contact, candidates, warning }
//   status: verified | pending | similar | ambiguous | unknown
//
// A1.3 同名歧义说明：以「姓名 / 代称」为索引时，本函数天然可能命中多个联系人，
// 此时一律返回 ambiguous，由调用方（lib/agent.js #resolvePayeeGate）出候选选择卡，
// 绝不自动挑第一个。候选按尾号 / 备注 / 手机号三者区分，选择后回写 `pickIndex`。
// 反过来，以「账号 / 手机号」为索引时必须唯一 —— 命中多个说明通讯录被重复登记，
// 同样不猜，交给用户清理（见 lib/agent.js #resolvePayeeByIdentity）。
function publicCandidate(c) {
  return publicView(c, { revealTail: true });
}

function resolvePayee(userId, rawAlias) {
  return resolvePayeeInner(userId, rawAlias, { allowIdentity: true });
}

// 显式按账号 / 手机号找人：必须唯一，命中多位即视为通讯录冲突
function resolveByIdentity(userId, identity) {
  const id = String(identity == null ? '' : identity).replace(/\s/g, '');
  const r = resolvePayeeInner(userId, id, { allowIdentity: true, identityOnly: true });
  return r;
}

function resolvePayeeInner(userId, rawAlias, opts) {
  const o = opts || {};
  const input = String(rawAlias == null ? '' : rawAlias).trim();
  // 口语里常说「我妈」「我老婆」，去掉前缀「我/我的」再匹配（只在解析时做，不改原始展示）
  const alias = normalize(input).replace(/^我(的)?/, '');
  if (!alias) return { status: 'unknown', input, candidates: [], warning: '收款人为空' };

  const contacts = allOf(userId);
  if (!contacts.length) {
    return { status: 'unknown', input, candidates: [], warning: '你还没有添加过任何联系人' };
  }

  // ① 身份优先：完整手机号 / 完整银行卡号
  //    顺序很重要 —— 账号是**唯一标识**，同一手机号被两位联系人登记时，
  //    按「谁的名字」去挑人就是猜测，所以这里命中多位直接报冲突。
  const isPhone = /^1\d{10}$/.test(alias);
  const isAcct = /^\d{12,19}$/.test(alias);
  if (isPhone || isAcct) {
    const byIdentity = contacts.filter(c => (isPhone ? String(c.phone) === alias : String(c.account) === alias));
    if (byIdentity.length === 1) {
      const c = byIdentity[0];
      const confusable = findSimilar(userId, c);
      const isPending = c.trust === 'pending';
      return {
        status: isPending ? 'pending' : (c.trust === 'verified' ? 'verified' : 'unknown'),
        contact: c, matchedBy: isPhone ? 'phone' : 'account', candidates: [], confusable,
        warning: confusable.length
          ? `注意：你的通讯录里还有一位「${confusable[0].displayAlias}」（${confusable[0].realName} ${confusable[0].account}），与本次收款人名称高度相似，请仔细核对账号。`
          : (isPending ? `「${c.realName}」尚未验证，单笔最多转 ¥50.00。` : null)
      };
    }
    if (byIdentity.length > 1) {
      return {
        status: 'ambiguous', input, matchedBy: 'identity-conflict',
        candidates: byIdentity.map(publicCandidate),
        warning: `这个${isPhone ? '手机号' : '账号'}在通讯录里登记了 ${byIdentity.length} 位联系人，请先确认是哪一位（或去安全中心清理重复联系人）`
      };
    }
    // 账号查无此人 —— 不落到姓名模糊匹配（"6222…" 去比名字只会比出噪声）
    return {
      status: 'unknown', input, matchedBy: isPhone ? 'phone' : 'account', candidates: [],
      warning: `通讯录里没有登记过 ${input}`
    };
  }
  if (o.identityOnly) {
    return { status: 'unknown', input, candidates: [], warning: `「${input}」不是有效的账号/手机号` };
  }

  // ② 精确匹配：代称 / 真实姓名
  const exact = contacts.filter(c => {
    if (normalize(c.realName) === alias) return true;
    return (c.aliases || []).some(a => normalize(a) === alias);
  });

  if (exact.length === 1) {
    const c = exact[0];
    // 易混淆标注：即使解析成功，也要把"通讯录里还有一个同音的人"这个事实摆出来
    const confusable = findSimilar(userId, c);
    const isPending = c.trust === 'pending';
    return {
      status: isPending ? 'pending' : (c.trust === 'verified' ? 'verified' : 'unknown'),
      contact: c, matchedBy: 'exact', candidates: [], confusable,
      warning: confusable.length
        ? `注意：你的通讯录里还有一位「${confusable[0].displayAlias}」（${confusable[0].realName} ${confusable[0].account}），与本次收款人名称高度相似，请仔细核对账号。`
        : (isPending ? `「${c.realName}」尚未验证，单笔最多转 ¥50.00。` : null)
    };
  }
  if (exact.length > 1) {
    return { status: 'ambiguous', input, matchedBy: 'exact', candidates: exact.map(publicCandidate), warning: `通讯录里有 ${exact.length} 位「${input}」，请确认是哪一位` };
  }

  // ③ 模糊匹配：编辑距离 ≤ 1 / 同音字
  const fuzzy = contacts.filter(c => [c.realName, ...(c.aliases || [])].some(n => similar(n, input)));
  if (fuzzy.length === 1) {
    return {
      status: 'similar', input, contact: fuzzy[0],
      candidates: [publicView(fuzzy[0])],
      warning: `通讯录里没有「${input}」，但找到一位名称相近的联系人「${fuzzy[0].realName}」，请确认是不是同一个人`
    };
  }
  if (fuzzy.length > 1) {
    return { status: 'ambiguous', input, matchedBy: 'fuzzy', candidates: fuzzy.map(publicCandidate), warning: `「${input}」可能指 ${fuzzy.length} 位联系人，请确认` };
  }

  // ④ 查无此人 —— 绝不猜测
  return { status: 'unknown', input, candidates: [], warning: `通讯录里没有「${input}」，我不会猜测收款人` };
}

// 按账号 / 手机号判定信任态（新账号流程用）
function trustLevelOf(userId, accountOrPhone) {
  const t = String(accountOrPhone || '').replace(/\s/g, '');
  if (!t) return { trust: 'unknown', contact: null };
  const c = allOf(userId).find(x => x.account === t || String(x.phone) === t);
  if (!c) return { trust: 'unknown', contact: null };
  return { trust: c.trust, contact: c };
}

// ---------- 准入：添加 / 验证 / 删除 ----------
// 铁律：新增联系人恒为 pending。Agent 无法调用（contact.* 不进 POLICY 白名单）。
function addContact(userId, payload) {
  const p = payload || {};
  const realName = String(p.realName || '').trim();
  const account = String(p.account || '').replace(/\s/g, '');
  const phone = String(p.phone || '').replace(/\s/g, '');
  const aliases = (Array.isArray(p.aliases) ? p.aliases : String(p.aliases || '').split(/[,，、\s]+/))
    .map(s => String(s).trim()).filter(Boolean).slice(0, 6);

  if (!realName) return { ok: false, message: '请填写真实姓名' };
  if (realName.length > 50) return { ok: false, message: '姓名过长' };
  if (!/^\d{12,19}$/.test(account)) return { ok: false, message: '账号格式非法（12–19 位数字）' };
  if (!/^1\d{10}$/.test(phone)) return { ok: false, message: '手机号格式非法' };
  if (!aliases.length) return { ok: false, message: '请至少填写一个代称（如"妈妈"）' };

  const d = db();
  if (allOf(userId).some(c => c.account === account)) return { ok: false, message: '该账号已在通讯录中' };

  const c = {
    id: 'ct' + uid().slice(0, 8),
    userId,
    realName, account, phone, aliases,
    trust: 'pending',              // 恒为 pending：验证必须由用户完成
    verifyMethod: null,
    verifiedAt: null,
    verifiedBy: null,              // 恒为 'user'，Agent 永不出现
    createdAt: Date.now(),
    createdBy: 'user',
    transferCount: 0,
    firstTransferAt: null,
    lastTransferAt: null,
    note: String(p.note || '').slice(0, 100),
    recentAddedRisk: false,
    pendingCode: null,
    pendingCodeAt: null
  };
  d.contacts = d.contacts || [];
  d.contacts.push(c);
  require('./store').save();
  return { ok: true, contact: publicView(c), message: `已添加「${c.aliases[0]}」（${c.realName}）。该联系人尚未验证，单笔最多转 ¥50.00；完成验证后可提高限额。` };
}

// 发起验证：发一个 6 位码（演示环境直接展示在短信面板）
function startVerify(userId, contactId) {
  const c = findById(userId, contactId);
  if (!c) return { ok: false, message: '联系人不存在' };
  if (c.trust === 'verified') return { ok: false, message: '该联系人已完成验证' };
  const d = db();
  const code = smsCode();
  c.pendingCode = code;
  c.pendingCodeAt = Date.now();
  d.smsCodes.push({
    phone: c.phone, code, purpose: `联系人验证·${c.realName}`,
    contactId: c.id, userId,           // userId 标记归属：验证码发到对方手机，但要能在本人的演示面板里看到
    expiresAt: Date.now() + 5 * 60 * 1000
  });
  if (d.smsCodes.length > 100) d.smsCodes = d.smsCodes.slice(-50);
  require('./gateway').audit(userId, 'user', 'contact.verify.start', { contactId: c.id }, 'OK',
    `向「${c.realName}」的手机号 ${maskPhone(c.phone)} 发送联系人验证码（验证动作只能由用户本人发起）`);
  require('./store').save();
  return {
    ok: true,
    message: `验证码已发送至 ${maskPhone(c.phone)}。请向你本人核实后回填（演示环境验证码已自动展开在页面短信面板）。`,
    hint: '真实环境中验证码只发到对方手机，用户需向对方索取——这个"索取"动作本身就是一次人工核实。'
  };
}

function completeVerify(userId, contactId, code) {
  const c = findById(userId, contactId);
  if (!c) return { ok: false, message: '联系人不存在' };
  if (c.trust === 'verified') return { ok: false, message: '该联系人已完成验证' };
  const d = db();
  const rec = d.smsCodes
    .filter(s => s.contactId === c.id && s.expiresAt > Date.now() && !s.usedAt)
    .pop();
  if (!rec) return { ok: false, message: '验证码已过期，请重新发送' };
  if (String(rec.code) !== String(code || '').trim()) {
    require('./gateway').audit(userId, 'user', 'contact.verify', { contactId: c.id }, 'REJECTED',
      `联系人「${c.realName}」验证码错误`, '校验层');
    return { ok: false, message: '验证码错误' };
  }
  rec.usedAt = Date.now();
  c.trust = 'verified';
  c.verifyMethod = 'sms_backfill';
  c.verifiedAt = Date.now();
  c.verifiedBy = 'user'; // 恒为 user：Agent 永远不能把联系人标记为已验证
  c.pendingCode = null;
  require('./gateway').audit(userId, 'user', 'contact.verify', { contactId: c.id }, 'OK',
    `联系人「${c.realName}」完成短信回填验证（verifiedBy=user，Agent 无此权限），限额已恢复`);
  require('./store').save();
  return { ok: true, contact: publicView(c), message: `「${c.realName}」已验证通过，转账限额已恢复为你的常规限额。` };
}

function removeContact(userId, contactId) {
  const d = db();
  const c = findById(userId, contactId);
  if (!c) return { ok: false, message: '联系人不存在' };
  d.contacts = d.contacts.filter(x => x.id !== contactId);
  require('./gateway').audit(userId, 'user', 'contact.remove', { contactId }, 'OK', `删除联系人「${c.realName}」`);
  require('./store').save();
  return { ok: true, message: `已删除联系人「${c.realName}」` };
}

// ---------- 风控：新联系人 / 待验证限额 ----------
// 返回 { level: 'ok'|'warn'|'needAck'|'block', message }
function checkPayeeRisk(user, contact, amountCents) {
  if (!contact) return { level: 'block', message: '收款人不在可信通讯录中' };
  if (contact.trust === 'pending') {
    if (amountCents > PENDING_SINGLE_LIMIT) {
      return {
        level: 'block',
        message: `「${contact.realName}」尚未完成验证，为保护你的资金，向未验证联系人单笔最多转 ¥50.00（本次 ¥${(amountCents / 100).toFixed(2)}）。完成验证后可提高限额。`
      };
    }
    return { level: 'warn', message: `该收款人尚未验证，本次已按 ¥50 应急额度放行。完成验证后可提高限额。` };
  }
  // 锁 3：刚添加（< 24h）且从未转账过的联系人，首次大额走二次确认
  const fresh = contact.createdAt && Date.now() - contact.createdAt < RECENT_RISK_MS && !contact.transferCount;
  if (fresh && amountCents > RECENT_RISK_AMOUNT) {
    return {
      level: 'needAck',
      message: `「${contact.realName}」是你 24 小时内新添加的联系人，本次为首次大额转账。请再次确认你没有被人引导操作。`
    };
  }
  return { level: 'ok', message: null };
}

// 解析成功后把真实身份注入授权单参数（trust 会进 HMAC 签名，篡改即失效）
function toPayeeParams(contact, payeeStatus) {
  return {
    toName: contact.realName,
    toAlias: (contact.aliases && contact.aliases[0]) || contact.realName,
    toAccount: maskCard(contact.account),
    toPhone: maskPhone(contact.phone),
    contactId: contact.id,
    trust: contact.trust
  };
}

module.exports = {
  normalize, levenshtein, similar, homophoneMatch,
  seedFor, publicView, publicCandidate, list, resolvePayee, resolveByIdentity, trustLevelOf, findSimilar,
  limitFor, checkPayeeRisk, toPayeeParams,
  addContact, startVerify, completeVerify, removeContact, findById,
  PENDING_SINGLE_LIMIT, RECENT_RISK_MS, RECENT_RISK_AMOUNT, HOMOPHONES
};
