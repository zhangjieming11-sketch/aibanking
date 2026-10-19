'use strict';
// ============ 授权单参数校验（U-28 / U-29）============
// 为什么需要：`createApproval` 原本拿到 params 就直接签名建档，
// 于是 `-100`、`0`、`abc`、`1e5`、`999999999999` 都能生成 P2 授权单并触发短信。
// 虽然执行层 toCents() 会兜底拦下，但已经造成：垃圾单据堆积、无意义短信、审计污染。
//
// 这里只做「格式合理性」校验，不做额度风控 —— 额度属于执行层（user.limits），
// 两件事职责分离，演示时提示才不会打架。

// 按 action 定义字段规则（与 gateway.POLICY 同级维护，安全决策不经过 LLM）
const PARAM_RULES = {
  'transfer.execute': { amount: 'money', toName: 'name' },
  'scheduled.create': { amount: 'money', toName: 'name', freq: 'enum:once,daily,weekly,monthly' },
  'aa.create': { total: 'money', participants: 'text', title: 'text' },
  'aa.pay': { groupId: 'id', payerName: 'text' },
  'wealth.subscribe': { amount: 'money', productId: 'id' },
  'wealth.redeem': { holdingId: 'id' },
  'card.freeze': { cardId: 'id' },
  'card.unfreeze': { cardId: 'id' },
  'card.setDefault': { cardId: 'id' },
  'card.add': { name: 'name', number: 'cardno' },
  'card.remove': { cardId: 'id' },
  'scheduled.cancel': { taskId: 'id' }
};

const MAX_AMOUNT = 500000; // 格式上限（元）：单笔合理性，不是风控限额

const VALIDATORS = {
  money: (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s.replace(/[,，\s]/g, ''))) {
      // 明确拒绝科学计数法、负数、字母、多余小数位
      if (/^-/.test(s)) return '金额必须为正数';
      if (/[eE]/.test(s)) return '金额格式非法（不支持科学计数法）';
      if (s === '' || s === '0' || s === '0.00') return '金额必须大于 0';
      if (/^\d+\.\d{3,}$/.test(s)) return '金额最多两位小数';
      return '金额必须为数字';
    }
    const n = Number(s.replace(/[,，\s]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return '金额必须为正数';
    if (n > MAX_AMOUNT) return '金额超出合理上限（单笔 50 万元）';
    return null;
  },
  name: (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '收款人名称不能为空';
    if (s.length > 50) return '收款人名称过长（上限 50 字）';
    if (/[\u0000-\u001f]/.test(s)) return '收款人名称含非法字符';
    return null;
  },
  text: (v) => (String(v == null ? '' : v).length > 200 ? '文本过长（上限 200 字）' : null),
  id: (v) => (/^[\w-]{1,64}$/.test(String(v == null ? '' : v)) ? null : 'ID 格式非法'),
  cardno: (v) => (/^\d{12,19}$/.test(String(v == null ? '' : v).replace(/\s/g, '')) ? null : '卡号格式非法（12–19 位数字）')
};

// 返回 null 表示通过；返回字符串表示不通过原因
function validateParams(action, params) {
  const rules = PARAM_RULES[action];
  if (!rules) return null; // 未定义规则的动作不做额外校验（仍受 POLICY 白名单约束）
  const p = params || {};

  for (const [key, rule] of Object.entries(rules)) {
    if (rule.startsWith('enum:')) {
      const allowed = rule.slice(5).split(',');
      if (p[key] !== undefined && p[key] !== '' && !allowed.includes(String(p[key]))) {
        return `参数 ${key} 取值非法（可选：${allowed.join(' / ')}）`;
      }
      continue;
    }
    const fn = VALIDATORS[rule];
    if (!fn) continue;
    // 必填：金额、收款人/总额、以及所有 id 类（缺失即无意义单据）
    const required = ['amount', 'toName', 'total', 'productId', 'holdingId', 'cardId', 'groupId', 'taskId'].includes(key);
    if (p[key] === undefined || p[key] === null || p[key] === '') {
      if (required) return `缺少必要参数：${key}`;
      continue;
    }
    const err = fn(p[key]);
    if (err) return err;
  }

  // 金额规范化：`100.` / `0100` 统一成 "100"；已限制两位小数，不会静默截断
  if (rules.amount && p.amount !== undefined && p.amount !== null && p.amount !== '') {
    const n = Number(String(p.amount).replace(/[,，\s]/g, ''));
    if (Number.isFinite(n)) p.amount = String(Math.round(n * 100) / 100);
  }
  if (rules.total && p.total !== undefined && p.total !== null && p.total !== '') {
    const n = Number(String(p.total).replace(/[,，\s]/g, ''));
    if (Number.isFinite(n)) p.total = String(Math.round(n * 100) / 100);
  }
  return null;
}

module.exports = { validateParams, PARAM_RULES, VALIDATORS, MAX_AMOUNT };
