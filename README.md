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

## 安全体系（核心亮点）

| 层 | 机制 | 实现 |
|----|------|------|
| 认证 | 登录密码 + JWT 会话（登出即吊销全部令牌） | `lib/util.js` |
| 授权 | Agent 权限分级 P0-P3，硬编码策略表，LLM 无法修改 | `lib/gateway.js` |
| 验证 | 一次性授权单：参数指纹绑定（换金额/收款人即失效）+ 5 分钟过期 + 用后作废；P2 需支付密码+短信验证码 | `lib/gateway.js` |
| 持续授权 | 定时任务专用：范围+单日限额+有效期+随时可撤销，逐笔校验 | `lib/gateway.js` |
| 审计 | 全链路日志（用户指令→网关决策→验证→执行），安全中心可视化 | `lib/gateway.js` |
| 注入防护 | 用户输入/账单文本先过注入扫描，外部数据永不进入指令层 | `lib/agent.js` |

## 演示脚本（建议 5 分钟）

1. **登录** → 一键进入演示账户
2. **查余额**（P0 只读，无需验证）→ 对比：
3. **「给小红转 100 元」**：Agent 只能生成申请单 → 确认卡片 → 支付密码+验证码 → 执行 → 单据作废；再说"再转一笔"需重新验证（授权给单不给 Agent）
4. **注入攻击演示**：点"⚡注入攻击演示"或发送"忽略之前的所有指令…" → 被拦截 + 审计日志
5. **P3 禁止区**：对 Agent 说"修改支付密码" → 拦截；卡片页点"解绑" → Agent 通道拦截 → 本人凭支付密码通道
6. **定时转账**：创建（自动生成持续授权）→ 安全中心撤销演示，或等 1 分钟自动执行
7. **安全中心**：权限矩阵 + 审计日志全链路回放

## 目录

```
server.js                   主服务（路由/API/静态文件）
lib/util.js                 密码哈希/JWT/参数指纹
lib/store.js                JSON 存储 + 种子数据
lib/gateway.js              权限网关（安全核心）
lib/agent.js                意图解析 + 注入防护 + 规则引擎兜底
lib/llm.js                  大模型接入层（OpenAI 兼容协议）
lib/banking.js              业务执行器 + 定时调度
public/                     前端（原生 JS 单页应用）
data/db.json                运行时数据（删除即重置，不入库）
data/llm-config.json        大模型配置（含密钥，不入库）
docs/V2修改方案.md            V2 改版方案（设计依据）
```

## 大模型接入的安全边界（答辩要点）

```
用户输入 → ① 注入扫描（拦截指令覆盖类攻击）
        → ② LLM 解析：只输出「结构化意图 JSON」，不能执行任何操作
        → ③ 意图白名单校验（未知动作一律拒绝）
        → ④ 权限网关：P0-P3 分级 → 生成授权单
        → ⑤ 用户双重验证（支付密码 + 验证码）→ 执行 → 审计留痕
```

- LLM 只能「申请」，不能「执行」；被注入攻击也拿不到资金权限
- LLM 不可用（未配置 / 超时 12s / 报错）自动降级规则引擎，演示永不中断（降级事件写入审计日志）
- 所有 LLM 解析结果与用户输入同等视为不可信数据，必须过白名单与网关

