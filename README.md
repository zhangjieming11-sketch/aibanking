# AgentBank — 智能体银行安全演示系统（V2）

参赛作品：**Agent × 银行融合的安全体系**。零第三方依赖，`node server.js` 即可运行。

## 运行

```bash
node server.js
# 打开 http://localhost:3000
```

- 演示主账户：`13800000001` / `demo1234`（支付密码 `123456`）
- 第二账户（AA 演示）：`13800000002` / `demo1234`（支付密码 `123456`）
- 环境要求：**Node.js ≥ 18**（用到了内置 fetch 与 base64url），无需 `npm install`

## 新成员环境配置（三步）

```bash
git clone <仓库地址>
cd agent-bank
# 第二步：配置大模型（不配置也能跑，会降级为本地规则引擎）
cp data/llm-config.example.json data/llm-config.json
# 然后编辑 data/llm-config.json 填入自己的 API Key（或改用环境变量，见下）
node server.js
```

**大模型配置两种方式（任选其一）**

| 方式 | 做法 | 适用 |
|------|------|------|
| 配置文件 | `data/llm-config.json` 填 `baseURL` / `apiKey` / `model` | 本地开发常用 |
| 环境变量 | `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | 服务器部署，避免密钥落盘 |

```bash
# Linux/macOS
export LLM_API_KEY=sk-xxx
export LLM_BASE_URL=https://你的接入点.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
export LLM_MODEL=qwen-plus
# Windows PowerShell
$env:LLM_API_KEY="sk-xxx"; $env:LLM_MODEL="qwen-plus"
```

> ⚠️ `data/llm-config.json` 已在 `.gitignore` 中，**不要提交自己的 Key**。
> 密钥请通过团队内部安全渠道单独传递（不要发在群里/提交到仓库）。
> 未配置 Key 时系统自动降级为本地规则引擎，所有安全机制照常工作，演示不中断。

**验证是否接入成功**：登录后聊天页顶部显示徽标——`🧠 大模型：qwen-plus` 表示已接入；`⚙️ 规则引擎模式` 表示未配置或调用失败。也可直接访问 `GET /api/agent/status` 查看。

> 📖 **新成员完整接入步骤（含常见问题排查）见 [`docs/队友接入指南.md`](docs/队友接入指南.md)**
> 最容易踩的坑：**Key 与接入点地址必须配套**——用别人的接入点必须配别人的 Key，否则一律 401。

## 安全体系（核心亮点）

| 层 | 机制 | 实现 |
|----|------|------|
| 认证 | 登录密码 + JWT 会话（登出即吊销全部令牌） | `lib/util.js` |
| 授权 | Agent 权限分级 P0-P3，硬编码策略表，LLM 无法修改 | `lib/gateway.js` |
| 验证 | 一次性授权单：**参数 HMAC 服务端签名**绑定（换金额/收款人即失效）+ 5 分钟过期 + 用后作废；P2 需支付密码+短信验证码 | `lib/util.js` / `lib/gateway.js` |
| 持续授权 | 定时任务专用：范围+单日限额+有效期+随时可撤销，逐笔校验 | `lib/gateway.js` |
| 数据隔离 | 独立注入防火墙：用户输入/账单/备注一律当「数据」，命中即拦在指令层之外 | `lib/injection.js` |
| 幂等 | 授权单 ID 作幂等键：同一单重复提交只执行一次、返回首次结果 | `lib/banking.js` |
| 撤销窗口 | 大额（≥ ¥1,000）转账享 2 分钟撤销窗口，窗口内一键撤销、资金原路退回 | `lib/banking.js` |
| 审计 | 全链路日志 + **HMAC 哈希链**（`hash = HMAC(prev_hash | 本条内容)`），提供完整性自校验 | `lib/gateway.js` |
| 输出过滤 | Agent 对外文案再过一道安全过滤，杜绝"已完成/已绕过"类越权话术 | `lib/agent.js` |

## 测试（DoD 回归）

```bash
npm test          # 注入攻击用例回归（28 条攻击 + 8 条负样本，全绿 + 零误伤）
npm run test:smoke # 端到端冒烟（需先 node server.js）：登录→驾驶舱→注入拦截→签名→幂等→撤销→审计链
```

- 攻击用例集：`tests/attacks.md`（6 类 28 条中文注入，附 8 条正常样本防误伤）
- 门禁脚本：`tests/run_attacks.js`（CI 可直接跑，`node tests/run_attacks.js`，非全绿即报错退出）

## 演示脚本（建议 5 分钟）

0. **90 秒安全导览**：点右下角「▶ 90 秒安全导览」，6 步带你看完整个防护链路
1. **登录** → 一键进入演示账户
2. **查余额**（P0 只读，无需验证）
3. **「给小红转 100 元」**：Agent 只能生成申请单 → 确认卡片（含参数签名指纹）→ 支付密码+验证码 → 执行 → 单据作废；再说"再转一笔"需重新验证（授权给单不给 Agent）
4. **注入攻击演示**：点"⚡注入攻击演示"或发送"忽略之前的所有指令…" → 红色拦截卡（什么攻击 / 被谁拦 / 证据编号）+ 审计日志
5. **P3 禁止区**：对 Agent 说"修改支付密码" → 拦截；卡片页点"解绑" → Agent 通道拦截 → 本人凭支付密码通道
6. **幂等 + 撤销**：转 ¥2000（大额）→ 重复提交同一单 → 提示"未重复扣款"；窗口内点"撤销" → 资金退回
7. **安全驾驶舱**：安全中心顶部看 28/28 徽章、今日拦截、审计链完整性；点"校验完整性"现场验证
8. **定时转账**：创建（自动生成持续授权）→ 安全中心撤销演示，或等 1 分钟自动执行

## 目录

```
server.js                   主服务（路由/API/静态文件）
lib/util.js                 密码哈希/JWT/参数 HMAC 签名/审计链哈希
lib/store.js                JSON 存储 + 种子数据
lib/gateway.js              权限网关（安全核心：策略/授权单/审计哈希链）
lib/injection.js            数据隔离层：注入防火墙（唯一判定入口）
lib/agent.js                意图解析 + 通道隔离 + 输出过滤 + 规则引擎兜底
lib/llm.js                  大模型接入层（OpenAI 兼容协议）
lib/banking.js              业务执行器 + 幂等/撤销 + 定时调度
tests/attacks.md            注入攻击用例集（28 攻击 + 8 负样本）
tests/run_attacks.js        CI 门禁脚本（npm test）
tests/smoke.js              端到端冒烟（npm run test:smoke）
public/                     前端（原生 JS 单页应用）
data/db.json                运行时数据（删除即重置，不入库）
data/llm-config.json        大模型配置（含密钥，不入库）
docs/V2修改方案.md            V2 改版方案（设计依据）
docs/队友接入指南.md          新成员拉代码 + 配置大模型的完整步骤
```

## 大模型接入的安全边界（答辩要点）

```
用户输入 → ① 数据隔离层：注入扫描（指令覆盖/角色劫持/越权/绕过验证/套取提示/数据渗漏六类）
        → ② LLM 解析：只输出「结构化意图 JSON」，不能执行任何操作
        → ③ 意图白名单校验（未知动作一律拒绝）
        → ④ 权限网关：P0-P3 分级 → 生成授权单（参数 HMAC 签名绑定）
        → ⑤ 用户双重验证（支付密码 + 验证码）→ 幂等执行 → 审计哈希链留痕
        → ⑥ 输出过滤：Agent 文案再过一道，杜绝越权话术
```

- LLM 只能「申请」，不能「执行」；被注入攻击也拿不到资金权限
- LLM 不可用（未配置 / 超时 12s / 报错）自动降级规则引擎，演示永不中断（降级事件写入审计日志）
- 所有 LLM 解析结果与用户输入同等视为不可信数据，必须过白名单与网关
- 安全判定一律用带密钥的 HMAC，不使用可公开计算的无密钥摘要

