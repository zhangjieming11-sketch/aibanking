'use strict';
// ============ 端到端冒烟测试（需服务已在 localhost:3000 运行）============
// 覆盖 DoD 关键路径：登录 → 安全驾驶舱 → 注入拦截 → 授权单签名 → 幂等 → 撤销 → 审计链校验
// 用法：先 node server.js，再 node tests/smoke.js
const BASE = process.env.BANK_BASE || 'http://localhost:3000';
let token = '';
async function call(path, method, body) {
  const res = await fetch(BASE + path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Token': token } : {}) },
    body: method ? JSON.stringify(body || {}) : undefined
  });
  return res.json();
}
(async () => {
  const login = await call('/api/auth/login', 'POST', { phone: '13800000001', password: 'demo1234' });
  token = login.token;
  console.log('1) 登录:', login.ok ? 'OK' : 'FAIL');

  const ck = await call('/api/security/cockpit');
  console.log('2) 驾驶舱:', JSON.stringify({ attack: ck.attackPass + '/' + ck.attackTotal, blockedToday: ck.blockedToday, chainOk: ck.chainOk, chainCount: ck.chainCount, window: ck.revokeWindowSec, large: ck.largeThreshold }));

  const atk = await call('/api/attack/test', 'POST');
  console.log('3) 注入攻击:', atk.result.type, '| 层=' + atk.result.layer, '| 类型=' + atk.result.attackType, '| 证据=' + atk.result.ref);

  // 大额转账 ¥2000（≥ ¥1000，触发撤销窗口）
  const ap = await call('/api/ops/request', 'POST', { action: 'transfer.execute', params: { toName: '小红', amount: '2000' } });
  console.log('4) 生成授权单:', ap.ok && ap.approval ? ('P' + ap.approval.level + ' 指纹=' + ap.approval.fingerprint) : JSON.stringify(ap));

  const sms = (await call('/api/security/overview')).smsInbox[0];
  const conf = await call('/api/approvals/' + ap.approval.id + '/confirm', 'POST', { payPassword: '123456', smsCode: sms.code });
  console.log('5) 确认执行:', conf.ok, '|', (conf.message || '').replace(/\n/g, ' '), '| 撤销窗口=' + conf.revokeWindowSec + 's | id=' + conf.transferId);

  // 幂等：同一授权单再提交 → 返回首次结果，不重复扣款
  const again = await call('/api/approvals/' + ap.approval.id + '/confirm', 'POST', { payPassword: '123456', smsCode: sms.code });
  console.log('6) 重复提交(幂等):', again.message || again.ok);

  // 撤销：窗口内资金原路退回
  if (conf.transferId) {
    const rev = await call('/api/transfers/' + conf.transferId + '/revoke', 'POST');
    console.log('7) 撤销大额:', rev.ok, '|', rev.message);
  }

  const v = await call('/api/security/audit/verify');
  console.log('8) 审计链校验:', v.ok ? ('完整 ' + v.count + ' 条') : ('断裂 ' + JSON.stringify(v.brokenAt)));

  const ck2 = await call('/api/security/cockpit');
  console.log('9) 驾驶舱(执行后): 今日拦截=' + ck2.blockedToday + ' 审计数=' + ck2.auditCount + ' 链完整=' + ck2.chainOk);
})().catch(e => { console.error('ERR', e); process.exit(1); });
