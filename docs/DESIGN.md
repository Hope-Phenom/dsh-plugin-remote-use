# dsh-plugin-remote-use 设计文档

> 局域网主从委托：让主机的 DSH 像调用子 Agent 一样，把任务委托给从机上的 DSH。

| | |
|---|---|
| 状态 | 设计草案（待评审） |
| 目标 DSH 版本 | `0.2.0-rc.2`（协议版本需运行时协商，见 §4.1） |
| 决策依据 | 本仓库 `.research/01`–`.research/06` 六份源码级调研报告（索引见 §12.1） |
| 权威查证源 | 实现时遇到疑问请优先查 §12.2 列出的两处**权威离线源**，而不是反编译 bundle |
| 文档约定 | 标记 ⚠️ 的条目为**待核验/待定**；标记 🔒 的为**代码事实约束，不可绕过** |

---

## 1. 目标与非目标

### 1.1 目标

1. **主机侧零感知差异**：主机上的模型看到的是一个 `subagent_remote` 工具，用法、参数、后台 job、进度语义都与内置的 `subagent` 一致。
2. **从机侧保持完整 DSH**：从机本身就是一台可独立工作的 DSH 机器。配对后它**额外**获得"接受委托"的能力，而不是被降级为遥控终端。
3. **统一规划点**：人类只在主机上做规划和决策。从机上的会话全部是委派产生的一次性工作会话，不面向人类规划。
4. **GUI 独占资源安全**：一台从机同一时刻只跑一个任务（V1 全串行），避免两个 GUI 任务互相踩。
5. **可审计**：每一次委托、每一次审批决策（含自动放行）都留下主机侧独立审计记录。

### 1.2 非目标（V1 明确不做）

| 不做 | 原因 |
|---|---|
| 多主机连接同一从机 | 产品决策：单主多从 |
| 远程子 Agent 的**多轮续聊**（continuable） | 🔒 `SubagentProvider` 缝不支持进程外 continuable，见 §2.2 |
| 局域网自动发现（mDNS/zeroconf） | 🔒 DSH 全仓无任何发现协议依赖；手工配对反而更安全 |
| 跨从机的分布式调度/负载均衡 | 主机模型通过 `remote_agents` 自己决定派给谁；V1 不做自动放置 |
| 把远程工具调用写进主机会话日志 | 🔒 进程外 run 无本地 agent，无法进入主机的 `subagentCatalog`；用插件自己的可见性通道替代 |
| 跨任务持久化授权记忆 | 安全取舍：自动化测试重复性极强，跨任务记忆会静默放大授权范围 |

---

## 2. 关键约束（源码事实，设计的地基）

这一节是全文的根据。**任何与本节冲突的设计都必须改设计，而不是改本节。**

### 2.1 🔒 子 Agent provider 缝

DSH 的子 Agent 委派是一个**具名 provider 注册表**（`ctx.subagents.registerProvider`）。DSH 自己只注册两个进程内 provider（`spawn` / `fork`）。上游规划了 `dsh-subagent-acp` / `-dsh-sdk` / `-codex` / `-claude-code` 四个进程外 provider，但**包体不在桌面版 asar 中**。

provider 契约（`dsh-subagent/lib/typert.host.js:758-767`）：

```ts
interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}

interface SubagentCapabilities {
  readonly agentOptions: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}

interface SubagentRun {
  readonly id: SessionId
  readonly localAgent: Agent | undefined
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
}

interface SubagentResult {
  readonly output: readonly ContentBlock[]
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly stopReason: SubagentStopReason
}
```

### 2.2 🔒 进程外 provider 的六条硬约束

| # | 约束 | 证据 | 对本设计的影响 |
|---|---|---|---|
| C1 | `capabilities` 必须 5 位全 false | `dsh-subagent/lib/types/out-of-process.js:43-55`；服务在 `start` 前逐字段校验（`types/index.js:457-470`） | 请求带 `agentOptions`/`outputSchema`/`maxDepth`/`toolFilter`/`persona` 会被**拒绝**，不是忽略 |
| C2 | 不能支持 continuable | `prepareContinuable` 只能返回 seed；孩子始终由本地 `ctx.agents.create/resume` 物化（`continuation.js:133-175`）；README `:188` 要求 "Activation ownership contract" | 工具行必须 `backgroundMode: one-shot`；模型无法与远程子 Agent 多轮对话 |
| C3 | `run.localAgent` 必须 `undefined` | `dsh-subagent/lib/index.js:3130-3132` 只在 `localAgent` 存在时写 `subagent/catalog` | 远程 run 不进 `list_agents`；必须自建可见性通道 |
| C4 | `interrupt_agent` / `send_message` 对远程 run 失效 | 二者走 Activation，进程外 run 无本地 Activation | 需要自建 `remote_interrupt` 工具；取消走 ACP `session/cancel` |
| C5 | provider 接口无 `resume` / `sendMessage` | §2.1 契约 | 远程任务模型 = 一次性任务 |
| C6 | `inheritsParentContext` 必须 `false` | 远端拿不到父的本地 session events | 远程子 Agent 永远零父上下文（无 fork 语义） |

### 2.3 🔒 ACP 侧事实

| 事实 | 证据 |
|---|---|
| `dsh acp` ≡ `dsh --profile acp`，profile = `[dsh-base, dsh-acp-app]` | `dsh/lib/bin.js:129`；`dsh-app-boot/lib/index.js:530` |
| transport **硬编码 stdio**，无注入点 | `dsh-acp/lib/index.js:1319` |
| **一个连接支持 N 个并发 session** | `dsh-acp/lib/index.js:1077` |
| DSH 只实装 8 个方法；**从不调用** `fs/*`、`terminal/*`、`elicitation/*` | `dsh-acp/lib/index.js:1320-1323` |
| `session/new` 的 `cwd` **由客户端指定，必须绝对路径** | `dsh-acp/lib/index.js:1168-1182` |
| 用 ACP **v1**；v2 unstable 删掉了全部 `fs/*` 与 `terminal/*` | `sdk/dist/schema/index.js:51`；v2 schema |
| 协议内**无任何认证机制** | `InitializeRequest` 无凭据字段；DSH 返 `authMethods: []` |
| 审批只有 `allow-once` / `reject-once` 两个选项，且**只传 `toolCallId`** | `dsh-acp/lib/index.js:1121-1134` |
| 审批**无超时**；工具自身 `timeoutMs` **不覆盖审批阶段** | `dsh-tools/lib/index.js:3225-3226` vs `dsh-tool-call-timeout-policy/lib/index.js:116` |
| 主机不答 = 从机 turn **无限挂起** | JSON-RPC 层无超时（`sdk/dist/jsonrpc.js:544-581`）；实证 282.8 秒无超时 |
| **ACP 创建的会话拿不到 Auto review** | `dsh-permission-presets/README.zh.md:137`（Auto 不能成为默认值、不进 settings schema）+ `:64`（settings 只接受配置预设）+ ACP 无 `session/set_mode` |
| DSH 把 `blocked`/`error` 都映射成 `stopReason: end_turn` | `dsh-acp/lib/index.js:539-551` |
| 无 token 级流式，`session/update` 从已提交 durable 事件投影 | `dsh-acp/README` `:92` |

### 2.4 🔒 授权模型事实

| 事实 | 证据 |
|---|---|
| DSH **没有**授权库 / `allow-always` / 记忆授权 | `dsh-user-approval/README.md:155` |
| `approval: never` 的语义是**自动拒绝**，不是自动放行 | `dsh-user-approval/lib/index.js:175` |
| 沙箱 `mode === effectiveMode` 时直接免审批 → **不产生** `approval/request` | `dsh-sandbox/lib/index.js:101` |
| 只设 `never` 但沙箱仍受限 → 越权操作直接失败，文案误导为"用户拒绝" | `dsh-sandbox/lib/index.js:118` |
| `approval/request` 是 **agent-scoped** waterfall | `dsh-api-catalog` `:3851-3858`；`dsh-acp/lib/index.js:1116-1119` |
| Auto review 的 deny 在 `ask` 策略下**可被人类覆盖**（含 high） | `dsh-experimental-auto-review/lib/index.js:480-484`；实证日志 |
| Auto review 是**每调用一次模型请求**，无缓存/重试 | `dsh-experimental-auto-review/README.zh.md:87,91` |
| Auto review 只在 Web profile 层；headless 无 | `dsh-experimental-auto-review/README.zh.md:115` |
| 放行行为**无留痕**（无法区分"审查放行"与"未审查"） | `04-approval-model.md` §四 |

### 2.5 🔒 宿主机与网络事实

| 事实 | 证据 |
|---|---|
| CLI 拒绝 `--host 0.0.0.0` | `dsh-web-app/lib/startup.js:40` |
| `host` schema 只允许 `127.0.0.1` / `0.0.0.0` | `dsh-host-webserver` README |
| webserver **无鉴权 / 无 CORS / 无 CSRF / 无 body 限制** | 全仓 `access-control-allow` 0 命中 |
| `dsh-client-connection` 的栅栏**只管 `/api`**；插件自注册路由不受保护 | `dsh-client-connection/lib/index.js:205-219` |
| 第三方插件**可以** import `@deepseek-ai/*`（运行时拦截层） | `dsh-app-boot/lib/index.js:1459-1466, 1641-1697` |
| junction/symlink 进 profile 的插件需在 `peerDependencies` 声明该名字 | `dsh-app-boot/lib/index.js:1471-1497` |
| 无任何 mDNS/zeroconf/SSDP 依赖 | 12967 个 asar 条目 0 命中 |
| `ws@8.22.0` 随包分发（`dsh-api-gateway` 的依赖） | `dsh-api-gateway/package.json:54` |
| `@agentclientprotocol/sdk@1.4.0` 随包分发，含 WS/HTTP/SSE transport | `sdk/package.json:25-58` |
| 改插件 JS 代码**必须重启**（`hmr.config.root` 默认 `[]`） | `dsh-base/cordis.patch.yml:27-32` |
| 多帧 zstd 会话日志，`zstdDecompressSync` 只解第一帧 | `04-approval-model.md` |
| `dsh-session-log-deepseek` **默认把规范会话日志上送官方服务** | `dsh-session-log-deepseek/README.md:11,34-40`（本项目不处理，但审计不能依赖 session log） |

---

## 3. 架构总览

```
┌─ 主机 (Lead) ─────────────────────────────────────────────────────┐
│  模型 ──► tools: subagent_remote / remote_agents / remote_interrupt │
│                        │                                            │
│  ┌─────────────────────▼──────────────────────────────────────┐    │
│  │ dsh-plugin-remote-use / host                                │    │
│  │                                                             │    │
│  │  RemoteProvider ──── ctx.subagents.registerProvider()       │    │
│  │      │  capabilities: 全 false, inheritsParentContext: false│    │
│  │      │                                                      │    │
│  │  AcpClientBridge ──── 每条从机一条长连接（WS）+ N 个 session │    │
│  │      │                                                      │    │
│  │  TaskRegistry ─────── 远程 run 的内存 registry（可见性源）    │    │
│  │      │                                                      │    │
│  │  ReviewEngine ─────── 纯规则引擎：审批决策 + 任务内记忆        │    │
│  │      │                                                      │    │
│  │  AuditLog ─────────── 独立 JSONL 审计                        │    │
│  │      │                                                      │    │
│  │  PairingService ───── 配对、长期密钥、从机 allowlist          │    │
│  │      │                                                      │    │
│  │  SettingsRoute ────── /api/dsh/dsh-plugin-remote-use         │    │
│  └─────────────────────┬──────────────────────────────────────┘    │
│                        │  WebSocket（插件自建监听，自带 Bearer 鉴权）│
└────────────────────────┼───────────────────────────────────────────┘
                         │  局域网
┌────────────────────────▼───────────────────────────────────────────┐
│ 从机 (Worker) — 完整 DSH 实例（web profile），受限沙箱               │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ dsh-plugin-remote-use / slave                                 │  │
│  │   WsRelay：WS ↔ stdio 桥 + Bearer 鉴权 + 心跳                  │  │
│  │   TaskQueue：从机级串行队列 + 单主机配对锁                       │  │
│  │   Spawner：每 WS 连接拉起一个 `dsh --profile acp` 子进程        │  │
│  │   KillSwitch：本地急停                                         │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                          │ stdio (NDJSON JSON-RPC)                  │
│                 dsh --profile acp 子进程                            │
│                  （受限沙箱 → 提权 → approval/request）              │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.1 为什么从机不需要装"审查"插件

因为 **ACP 创建的会话拿不到 Auto review**（§2.3），从机上没有可用的自动审查。而"审查智能放哪里"这个问题的答案恰好是**主机**：

- 从机沙箱保持**受限**（`workspace-write`）→ 越权操作必然产生 `approval/request` → 桥接到主机
- 主机侧插件就是那个审查者：规则引擎判定 + 任务内记忆 + 人工兜底

这样做的三个好处：

1. **职责内聚**：决策、记忆、审计、可见性全在主机侧，一个地方改策略。
2. **不需要从机 Auto review**：省掉从机 token 翻倍（每次调用一次模型请求）的代价。
3. **不产生误导文案**：受限沙箱的拒绝是**刻意的、正常的**，正是审批请求的触发源，不是异常。

> ⚠️ 与早期讨论的偏差：早期设想是"从机开自动审批，拒绝时转发主机"。核实后发现 ACP 会话用不到 Auto review，因此该机制**改为在主机侧实现**，效果等价且成本更低。

### 3.2 从机形态

**从机 = 完整 DSH（web/desktop profile）+ 本插件的 slave 半 + 受限默认沙箱。**

- 用户可在从机上手动配置默认沙箱（按需求，也保留"手动把从机设成全权自主"的自由）
- 配对后从机 UI 增加一个「工作节点」区域（任务队列 / 待审批 / 急停 / **当前会话类型与分辨率**）
- 从机保持可独立使用：未配对、或配对后用户手动开会话，行为与普通 DSH 一致

🔴 **必须运行在用户交互会话**，不能做成 Windows 服务、也不能靠 SSH 启动——实测 SSH 落在 Session 0，该会话没有交互桌面。详见 §7.5（实地勘察得出的部署约束）。

---

## 4. 协议

### 4.1 分层

| 层 | 内容 | 谁实现 |
|---|---|---|
| L1 传输 | WebSocket（`ws@8`），JSON 文本帧 | 插件自建监听 |
| L2 配对鉴权 | 握手：协议版本协商 + 从机身份 + Bearer/HMAC | 插件双侧 |
| L3 会话控制 | ACP v1（`initialize` / `session/new` / `session/prompt` / `session/cancel` / `session/request_permission` / `session/update`） | `@agentclientprotocol/sdk` |
| L4 工作区同步 | 独立于 ACP 的 manifest/blob 协议 | 插件双侧 |

**版本协商**：L2 握手首帧必须交换 `protocolVersion`（本插件协议版本）、DSH 版本、插件版本、ACP 版本。任一不匹配 → **拒绝连接并给出明确诊断**，不做降级尝试。

**关键设计原则**：L3 的 ACP 类型**不得泄漏到 provider 以上**。`RemoteProvider` 只与一个 `Transport` 接口对话；后续若要换成自研全量事件中继（补齐 ACP 的有损投影），只替换 `Transport` 实现。

### 4.2 握手序列

```
从机                                         主机
 │                                             │
 │  ← WebSocket 连接 (wss:// 或 ws://)          │
 │                                             │
 │  ── hello ──────────────────────────────►   │
 │     { proto, dshVersion, pluginVersion,     │
 │       acpVersion, workerId, workerName,     │
 │       capabilities: {...}, nonce }          │
 │                                             │
 │  ◄──── hello-ack ────────────────────────   │
 │     { proto, masterId, masterName,          │
 │       accepted: true,                       │
 │       sessionKey, hmac(hello) }             │
 │                                             │
 │  ── auth ───────────────────────────────►   │
 │     { hmac(sessionKey + nonce) }            │
 │                                             │
 │  ◄──── ready ────────────────────────────   │
 │     { }                                     │
 │                                             │
 │  ══ 此后：ACP JSON-RPC 帧 + 心跳 ping/pong ══│
```

**拒绝情形**：`proto` / `dshVersion` 不匹配、主机不在从机 allowlist、从机已被其他主机配对（§7 单主约束）、鉴权失败 → 发送 `reject { reason }` 后关闭连接。

### 4.2.1 插件扩展方法

配对通道上除 ACP 帧外，还有插件自己的方法（同层 JSON-RPC，**不进 ACP 命名空间**）：

| 方法 | 方向 | 用途 |
|---|---|---|
| `dsh-remote/hello` | 从机 → 主机 | 已由 §4.2 握手承载 |
| `dsh-remote/ping` / `pong` | 双向 | 心跳与在线检测 |
| **`dsh-remote/selfcheck`** | 主机 → 从机 | **按需自检**（§5.10.4）；派单门禁 T1 与配置页 T2 共用 |
| `dsh-remote/abort` | 主机 → 从机 | 急停（§7.4） |
| `dsh-remote/blob/*` | 双向 | 工作区同步（走独立 HTTP 通道，见 §6.6，不在 WS 上） |

**命名约定**：所有插件方法用 `dsh-remote/` 前缀，避免与 ACP 的 `session/*`、`fs/*`、`terminal/*` 冲突。未知方法必须返回 JSON-RPC `-32601`，**不能静默忽略**（否则未来协议升级会变成静默降级）。

### 4.3 配对（人工，带外）

配对**不是**网络自动完成的，必须人工在两端确认：

1. 主机生成一次性配对码（6 位数字 + 短指纹），显示在主机 Settings 页
2. 用户在从机的「工作节点」页输入主机地址 + 配对码
3. 从机向主机发起配对握手，**主机侧弹确认**（显示从机名、指纹、请求来源 IP）
4. 双方确认后交换长期密钥（主机持有 `peerKey`，从机持有 `masterKey`）
5. 密钥落盘：主机 `$DSH_HOME/storages/dsh-plugin-remote-use/peers.json`（权限收紧）；从机 `$DSH_HOME/storages/dsh-plugin-remote-use/master.json`

**安全性质**：TOFU 但**不是**"自发现即信任"。IP 不作为身份；身份是长期密钥的指纹。

### 4.4 ACP 使用方式

主机对每个从机维持**一条长连接**，在其上开**多个并发 session**（一台从机的任务串行化由从机侧队列保证，不由连接数保证）。

| 主机动作 | ACP 调用 |
|---|---|
| 建立任务 | `session/new { cwd: <从机绝对路径>, mcpServers: [] }` |
| 下发任务 | `session/prompt { sessionId, prompt: [<文本>] }` |
| 取消任务 | `session/cancel { sessionId }` |
| 接收进度 | 订阅 `session/update` 通知（`agent_message_chunk` / `tool_call` / `tool_call_update` / `usage_update`） |
| 审批 | 应答 `session/request_permission`（见 §8） |
| 收尾 | `session/close { sessionId }` |

**成败判定**（因为 ACP 把 `blocked`/`error` 都映射成 `end_turn`，见 §2.3）：

**主判据**：`subagent/start` / `subagent/end` 生命周期事件里的 **`local`** 字段 —— 这是**官方给的进程外判别位**，比自己从 ACP 的 `stopReason` 反推可靠得多。

**辅助判据**（当 ACP 的 stopReason 不可分辨时）：

```
if (prompt rejected)                 → stopReason = 'error'   (diagnostic = -32603 详情)
else if (stopReason === 'cancelled') → stopReason = 'aborted'
else if (stopReason === 'refusal')   → stopReason = 'refusal'
else if (output 为空 && 期间发生过 tool 失败) → stopReason = 'error'
else                                 → stopReason = 'completed'
```

⚠️ 这条辅助规则仍需实测校准（见 §11 未决项 U5）。

**`session/new` 的字段注意**：DSH **直接拒绝** `additionalDirectories`（`dsh-acp/lib/index.js:1410-1413` 抛 `invalidParams`，码 `-32602`）。不要把它当能力用。有效字段是 `cwd`（绝对路径）与 `mcpServers`。

---

## 5. 主机侧模块

### 5.1 `RemoteProvider`

```js
class RemoteProvider {
  name = `remote-${peerId}`
  capabilities = { agentOptions: false, outputSchema: false, depthLimit: false,
                   toolFilter: false, persona: false }        // 🔒 C1
  inheritsParentContext = false                                // 🔒 C6

  async start(request) {
    // 1. 检查从机在线 + 队列可用，否则 fail fast
    // 2. 确保工作区已同步（§6）
    // 3. ACP session/new（cwd = 从机的绝对路径）
    // 4. 注册到 TaskRegistry
    // 5. 异步发 session/prompt，返回 run handle
    return {
      id: sessionId,
      localAgent: undefined,                                   // 🔒 C3
      result: this.#runToResult(...),                          // 永不 reject
      dispose: this.#idempotentDispose(...),
    }
  }
  // 不实现 prepareContinuable                                     🔒 C2
}
```

复用 `@deepseek-ai/dsh-subagent` 导出的四个 helper。⚠️ **注意子路径不存在**——`package.json` 的 exports 没有 `./out-of-process`，这些 helper 是从包根再导出的：

```js
import { NO_START_CAPABILITIES, resolveChildCwd, settleRunResult, subprocessRunHandle }
  from '@deepseek-ai/dsh-subagent'          // ✅ 唯一可行写法
```

⚠️ **两类 helper 的参数形状相反**，不要照抄错：

| helper | 形状 | 字段 |
|---|---|---|
| `settleRunResult(parts)` | **对象参数** | `attempt()` / `cancelled()` / `collectOutput()` / `onError?(e,'error')` / `collectDiagnostic?()` / `signal` / `onAbort` |
| `subprocessRunHandle(parts)` | **对象参数** | `id` / `result` / `signal` / `onAbort` / `requestCancel()` / `teardown()` |
| `assertPositiveFinite(prefix, name, value)` | **位置参数** | 首参是诊断前缀字符串 |
| `assertUsableCwd(prefix, label, cwd)` | **位置参数** | 同上 |
| `validateConfiguredCwd(prefix, cwd)` | **位置参数** | 同上 |
| `resolveChildCwd(prefix, configured, parentCwd)` | **位置参数** | 同上 |

**进程外 run 的判别位**：`ctx.subagents` **没有**「按 id 查 run」的方法。判断一个 run 是本地还是进程外，用 `subagent/start` / `subagent/end` 生命周期事件里的 **`local`** 字段——这是官方给的判别位，比自造规则可靠。

**一个 provider 对应一台从机**，名为 `remote-<peerId>`。工具行由用户/插件在 profile patch 里为一台从机加一行，或由插件动态注册（⚠️ 见 §11 未决项）。

### 5.2 `AcpClientBridge`

职责：

- 建立/维护到每台从机的 WS 长连接；断线指数退避重连
- 用 `@agentclientprotocol/sdk` 的 `createWebSocketStream` + `client(...)` 建 ACP client
- 实现两个必需 handler：`session/update`（→ 转发给 TaskRegistry + 事件流）和 `session/request_permission`（→ ReviewEngine）
- 维护 `toolCallId → { toolName, rawInput }` 缓存（因为审批请求只带 `toolCallId`，🔒 §2.3）
- 心跳与在线状态

⚠️ **SDK API 与直觉不符，容易写错**：

| 容易写错 | 事实 |
|---|---|
| `acp.client(...)` | ❌ **不存在 `acp` 命名空间对象**（`acp` 只是 import 别名）。`client(options)` 是**顶层函数**，只读 `options.name`（`SDK/dist/acp.js:852-854`） |
| 在返回对象上直接调 `initialize` / `newSession` / `prompt` | ❌ 返回的是 `ClientApp`，公开方法**只有 9 个 builder**：`connect` / `connectWith` / `onConnect` / `onRequest` / `onNotification` / `request` / `notification` / `connectConnection` / `openStreamConnection` |
| agent 侧方法怎么发 | ✅ 经 `connectWith(stream, ctx => ctx.request(acp.methods.agent.session.new))` 等 |
| 用 `ClientSideConnection` | ⚠️ 存在但**已 `@deprecated`**（`acp.js:1451`） |

可运行样板：`SDK/dist/examples/ws-client.js:44-68`。

⚠️ **`ClientSideConnection` / `AcpServer` / `createWebSocketStream` / `experimental/*` 在全部 `@deepseek-ai/*` 里 0 命中** —— DSH 自己的 ACP 是 stdio 硬编码，**没有任何现成的网络用法可抄**。集成处必须隔离一层 adapter。

**缓存缺失的处理**：审批请求到达时若 `toolCallId` 查不到对应 `tool_call`，**默认拒绝**并把情况记进审计。绝不默认放行。

⚠️ **ACP v1 的重连不重放**：单向 `session/update` 通知是相互隔离的 best-effort 投递，重连后不会补发（`ws-stream.js:20-24`）。所以断线期间的工具调用事件**永久丢失**，`TaskRegistry` 只能记录「有一段时间没收到事件」。需要可靠恢复的状态必须自己提供查询或游标。

### 5.3 `TaskRegistry`

远程 run 的**唯一事实来源**（内存为主 + 落盘快照）。

记录每个任务：`taskId`、`peerId`、`acpSessionId`、`label`、`prompt 摘要`、`状态`、`起止时间`、`最近 N 条工具调用摘要`、`当前是否在等审批`、`累计工具调用数`。

**这是 C3 缺口的补丁**：远程 run 不进主机 `subagentCatalog`，所以插件自己维护一份，供 `remote_agents` 工具和运行时上下文使用。

⚠️ **绝对不能去重注册 `subagentCatalog` 投影**：`stateVersion` 冲突会抛错。自建一份是**唯一可行**的做法（这一点已被核验确认）。

⚠️ 若要给 Client 暴露投影视图，`ctx.sessionProjections.register` 的形状是（核验自 `dsh-permission-presets/lib/types/index.js:159-166`、`dsh-subagent/lib/types/projection.js:38-88`）：

```js
ctx.sessionProjections.register({
  key: 'remoteTasks',
  stateVersion: 1,
  stateSchema: <zod schema>,               // ⚠️ 必填
  init: (header, inheritedEventCount) => …, // ⚠️ 必填，两个参数
  apply: (state, event) => …,               // 纯函数、同步；忽略的事件必须返回同一引用
  wire: {                                   // ⚠️ view 在 wire 里，不在顶层
    viewSchema: <zod schema>,
    view: (state) => …,
  },
})
```

⚠️ `stateOf(session, key)` 返回的是**折叠状态**，不是 wire view；要 view 得用 `snapshot(session, [key]).values[key]`。

### 5.4 `ReviewEngine`（纯规则引擎）

见 §8。V1 不调模型。

### 5.5 `AuditLog`

见 §9。

### 5.6 `PairingService`

见 §4.3。额外职责：从机 allowlist、密钥轮换、解除配对。

### 5.7 工具面

| 工具 | 对应官方工具 | 说明 |
|---|---|---|
| `subagent_remote` | `subagent` | 由 `dsh-tool-subagent` 的一行配置提供，见下方配置清单 |
| `remote_agents` | `list_agents` / `wait_agent` | action: `list` / `status` / `wait`。读 `TaskRegistry` |
| `remote_interrupt` | `interrupt_agent` | 走 ACP `session/cancel` |
| `remote_selfcheck` | —（新增） | 查询从机就绪状态，见 §5.10.7 |

**`subagent_remote` 的精确配置**（已核验）：

```yaml
- id: tool-subagent-remote-labpc
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: remote-labpc
    toolName: subagent_remote
    backgroundMode: one-shot        # 🔒 C2：不能是 continuable
    maxDepth: provider-managed      # 🔒 必须，否则 depthLimit 校验失败
    # 以下三项必须"连键都不出现"，否则 provider 注册整体回滚（见下）：
    # agentOptions / persona / toolFilter
    modelSelectionSettings: false   # 默认值；保持 false 即模型无法请求 provider/model
```

⚠️ **`agentOptions` 连"配了但不填"都不行。** `dsh-tool-subagent` 在 `subagent/provider-added` 事件里同步调用 `assertSubagentProviderConfiguration`（`:369-386`）做校验，而 Cordis 的 `emit` 是 `dispatch(...).map(cb => cb(...))`（`cordis/src/events.ts:194-196`）——**监听器抛出的异常会冒出来，导致 provider 注册整体回滚**，工具根本不注册。所以远程行必须彻底省略 `agentOptions`。

⚠️ **`Config` 的真实字段**（`dsh-tool-subagent/lib/index.js:252-270`）：`provider`(必填) / `toolName`(默认 `"subagent"`) / `modelSelectionSettings`(默认 `false`) / `enableRunInBackground`(默认 `true`) / `backgroundMode`(默认 `"one-shot"`) / `agentOptions` / `persona` / `toolFilter` / `maxDepth`。

**没有 `outputSchema`，也没有 `description`。** `agentOptions` 的子字段是 **camelCase**：`provider` / `model` / `reasoningEffort` / `maxTokens`；而 `reasoning_effort`（snake_case）只是**模型面工具参数**，仅当 `modelSelectionSettings: true` 时才生成。

**一台从机一行是可行的**：base patch 自己就有两行同包不同配置的先例（`dsh-base/cordis.patch.yml:370-375` 与 `:383-388` 的 `tool-subagent` / `tool-subagent-fork`）。

✅ **U1 结论：可以保留主机本地子 Agent 的完整能力**（那是另一行配置），只对远程行关闭。

⚠️ **U2 结论：插件不能在运行时新增工具行** —— 工具行只能来自 profile patch。所以「一台从机一行」需要用户在 profile patch 里手写，或由插件在安装时写入（需要审批）。这对安装体验是个实际负担，见 §11。

推导依据：`assertCapabilities` 是**按字段是否存在**逐项校验（`dsh-subagent/lib/index.js:3173-3194`），request 里的 `agentOptions` / `persona` / `toolFilter` 只在 `config` 提供了对应值时才被填入（`dsh-tool-subagent/lib/index.js:509-520`），而 `maxDepth` 只在数值配置时才是数字（`maxDepth: 'provider-managed'` 使其为 `undefined`）。

**后台语义修正**：`backgroundMode: 'one-shot'` 时 `run_in_background` **默认为 `false`（前台等待）**，后台执行需要模型显式传 `run_in_background: true`（`dsh-tool-subagent/lib/index.js:355-361`）。

**不加 `remote_send_message`**：provider 缝不支持 continuable，没有落点。工具描述里要明确写出这一点，否则模型会反复尝试续聊。

（后台委派走 `ctx.jobs`，见本节末。）

**自定义工具注册**（`remote_agents` / `remote_interrupt` 用）——核验自 `dsh-tool-subagent/lib/index.js:173-196`：

```js
ctx.tools.register(defineTool({
  name: 'remote_agents',
  description: '...',
  parameters: {                        // JSON Schema（松散，register 只强校验 output.schema）
    action: { type: 'string', required: true, description: 'list | status | wait' },
    taskId: { type: 'string', description: '...' },
  },
  output: {                            // ⚠️ output 是必填，缺失会抛 TypeError
    schema: { type: 'string' },        // 强校验
    render: (_args, result) => [{ type: 'text', text: result }],
    // presentationMeta?: ...
  },
  execute(args, exec) {
    return myImplementation(args, exec.signal)   // exec 提供 signal
  },
}))
```

⚠️ **`ctx.tools.register` 的字段形状容易写错**：

| 容易写错 | 事实 |
|---|---|
| 顶层 `render` | ❌ 在 **`output.render`** 里 |
| `presentation` | ❌ 无此字段；只有 `presentCall` / `presentResult` / `output.presentationMeta` |
| 工具字段 `guard` / `restrict` | ❌ 它们是 **`ctx.tools.guard()` / `ctx.tools.restrict()` 注册表方法**，不是工具字段 |
| 省略 `output` | ❌ **强校验必填**：`throw new TypeError('tool "X" must declare output { schema, render, presentationMeta? }')` |
| `parameters` 必须是完整 JSON Schema | ⚠️ 实际是 `Record<string, unknown>`，裸对象也能注册 |

⚠️ DSL 两条硬规则：**`required` 只能写 `true` 或省略**；**`oneOf` 与 `type` 互斥**。

**把远程任务包装成 job**（白送 `job_output` / `job_kill`）：

```js
const jobId = ctx.jobs.start({          // 返回 JobId 字符串（形如 "subagent-3"），不是句柄
  kind: 'subagent',
  label: args.description,
  owner: parent.session.id,             // ⚠️ 必须是 live Agent 的 session id
  run: (job) => ({                      // run(job: JobHandle) → JobHooks
    cancel: (reason) => { /* ... */ },
    done: doTheWork(job),               // 写入用 job.append(text, options?)
  }),
})
```

⚠️ **job 句柄的 API 与直觉相反**：`ctx.jobs.start(spec)` 返回的是 **id 字符串**；`run()` 是 **`JobSpec` 的输入字段**（不是句柄方法）；`cancel()` / `done` 在 `run()` 返回的 `JobHooks` 上；**没有 `output()`** —— 写入用 `JobHandle.append(text, options?)`，读用 `ctx.jobs.read/readAt`，投影是 `JobView.output: { total, earliest, spillPaths? }`。

✅ 可行性确认：`dsh-base/cordis.patch.yml:88-89` 与 `:275-276` 已挂载 `jobs-local` + `tool-jobs`；注意并发上限与 `owner` 必须是 live Agent 的 session id（`dsh-jobs-local/lib/index.js:527-534`）。

### 5.8 模型侧可见性

两条通道并用：

1. **`remote_agents` 工具**（模型主动查询）
2. **运行时上下文注入**：把「当前在跑的远程任务 + 状态」送进主机模型的上下文，解决"模型失忆"。

两条注入路径（已核验）：

| 路径 | 形状 | 用途 |
|---|---|---|
| `ctx.systemPrompt.section({ name, order, text })` | 静态段落，`order` 取分节常量 | 稳定的策略说明 |
| `agent.inject()` | per-agent 上下文，在 **`agent/created`** 监听里拿 `agent.ctx` 注册 | 动态任务清单 |

⚠️ **`agent.inject()` 的坑**：
- 它**不会唤醒** agent（`agent.followup()` 才会）——注入的上下文会等在 inbox 里直到别的输入到来。所以「任务状态变化时主动告知模型」需要额外机制，不能只靠 inject。
- 消息必须用 `createUserMessage` 构造。
- `agent/created` 是 **serial 事件**（不是 waterfall），payload 是 `{ agent, source, signal? }`。
- 在 `agent.ctx` 上注册的东西要**同时**保存在插件自己的 effect 里 —— 卸载插件不会自动 dispose `agent.ctx` 上的注册。

分节常量：本设计用 `TOOL_SUBAGENT = 2800`（共 31 个 section 常量 + 3 个 context 常量，全量清单见 `.research/05-api-verification.md`）。

### 5.9 Settings 页

`/api/dsh/dsh-plugin-remote-use`（参考 `dsh-plugin-notify` 的做法：自写 `sameOrigin()` 校验、body 上限、原子写）。

内容：从机列表与在线状态 / 配对与解除 / 每台从机的默认审查规则 / 审计查看（最近 N 条 + 统计）/ 急停入口 / **启动自检（见 §5.10）**。

### 5.10 启动自检与「从机就绪」面板

> **这是配置页的一等公民，不是附属信息。** GUI 自动化测试有多个**静默失败**的前提条件：它们不满足时测试不会报错，而是**点错位置、或者假死**。所以必须在派单前把每一项都显式检查并呈现。

#### 5.10.1 自检项清单（每项：状态 + 期望值 + 实测值 + 修复指引）

| # | 检查项 | 期望 | 不满足的后果 | 严重度 |
|---|---|---|---|---|
| **S1** | **显示设备存在** | 至少一个 `ATTACHED_TO_DESKTOP` 的适配器；**虚拟显示器（IDD）优先** | 无显示设备 → 会话失去渲染上下文，`SendInput` 全部失效 | 🔴 阻断 |
| **S2** | **不是 `WinDisc` 兜底设备** | 显示适配器名不是系统兜底；`WmiMonitorID` 有该设备的 EDID 条目 | 兜底设备分辨率锁死 1024×768，坐标不可信 | 🔴 阻断 |
| **S3** | **屏幕分辨率** | 与主机约定值一致（当前约定 **1920×1080**） | 尺寸敏感型断言不可比；坐标可能算错 | 🟡 警告 |
| **S4** | **主显示器与坐标原点** | 虚拟屏为 `primary` 且位于 **(0,0)** | **原点漂移 → 测试静默点偏**（最危险的失败模式） | 🔴 阻断 |
| **S5** | **DPI 缩放** | 固定值（当前 **1.00**） | 坐标换算错误 | 🔴 阻断 |
| **S6** | **会话类型** | `console`（绑定物理控制台） | `rdp-tcp` 且客户端断开 → 桌面不渲染 | 🔴 阻断 |
| **S7** | **未锁屏** | `OpenInputDesktop` 返回 `Default`（非 `Winlogon`） | 锁屏 → `SendInput` 失效 | 🔴 阻断 |
| **S8** | **`SendInput` / `SetCursorPos` 实测可用** | `SetCursorPos` 返回 true 且光标真实移动 | 一切的根前提 | 🔴 阻断 |
| **S9** | **禁止睡眠** | `STANDBYIDLE` 与 `HIBERNATEIDLE` 对应电源档均为 `0`（从不） | 睡眠冻结会话（比锁屏更致命） | 🔴 阻断 |
| **S10** | **屏保关闭** | `ScreenSaveActive = 0` | 屏保触发 → 桌面停止渲染 | 🟡 警告 |
| **S11** | **无自动锁屏策略** | `InactivityTimeoutSecs` 未设置 | 定时锁屏 → 长任务中途失效 | 🟡 警告 |
| **S12** | **QuickEdit 关闭** | `HKCU\Console` 的 `QuickEdit`/`InsertMode` = 0 | **点击落到控制台 → 控制台冻结 → 连带 `AttachThreadInput` 卡住 → 测试假死** | 🔴 阻断 |
| **S13** | **执行器无可见控制台** | 任务以 hidden/无控制台方式运行 | 同 S12；极端情况下点击会打到执行器自己的窗口 | 🟡 警告 |
| **S14** | **DSH 版本与插件版本** | 与主机协商一致 | 协议不匹配 | 🔴 阻断 |
| **S15** | **模型凭据可用** | `$DSH_HOME/.credentials.yaml` 存在且可用 | 从机无法独立工作 | 🔴 阻断 |
| **S16** | **磁盘空间** | ≥ 工作区 3 倍（见 §6.8） | 同步中途失败 | 🟡 警告 |
| **S17** | **GPU 型号 / 驱动版本** | 上报给主机（不设期望值） | 性能类判据不可跨机比较 | ℹ️ 信息 |
| **S18** | **被测应用存在** | 构建产物路径可解析 | 任务无法开始 | 🟡 警告 |

#### 5.10.2 设计要点

1. **自检必须能在无人登录时运行**（计划任务 + SYSTEM 或 Interactive），结果落盘成 JSON，主机侧读取并渲染。
2. **S8 是唯一"活体"检查**：它必须真的移动光标再读回（`SetCursorPos` + `GetCursorPos` 比对）。**只检查 API 是否存在是没有意义的**——实测证明会话存在、桌面对象可打开、`SendInput` 仍然返回 0/3。
3. **S4 必须检查原点**，不能只检查 primary 标志。实测踩过：虚拟屏是主屏但在 `0,-1080`，坐标原点仍在物理屏上。
4. **自检结果要区分「未检查」与「检查通过」**。从机离线时不能把面板显示成全绿。
5. **每项都要给可执行的修复动作**（不只是红色的叉）——例如 S9 给出 `powercfg` 命令、S4 给出设置主屏的调用、S12 给出注册表路径。
6. **自检项应可配置**：不同从机的期望分辨率/DPI 可能不同（见 §7.7 的主从硬件差异），期望值放进插件 Config 而非硬编码。
7. **派单前门禁**：`RemoteProvider.start()` 之前应检查 S1–S9、S12、S14、S15；任一 🔴 不满足则**直接拒绝派单并返回具体原因**，而不是让任务跑起来再失败。

#### 5.10.2.1 🔴 三个实测踩出来的实现约束（必须遵守）

**约束 A：从机侧脚本必须是纯 ASCII（或显式写 BOM）**

Windows PowerShell 5.1 把**无 BOM 的文件按 ANSI/GBK 读**。脚本里的中文字符串会被误解析，把字符串引号吃掉，导致**整个脚本语法错误、一行都不执行**。

实测症状极具误导性：计划任务返回 `lastResult=0`（"成功"），但**没有任何输出文件**。解析错误发生在执行之前，所以任务"成功"地什么都没做。

`verify-criteria.ps1` 的头部早有这条注释：
```
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less files as ANSI).
```
**插件生成/写入从机侧脚本时，必须强制 ASCII 或写 UTF-8 BOM。** 自检脚本自身也要在启动时校验 `ParseFile` 无错误。

**约束 B：显示类检查必须在交互会话里跑，session 0 会给出假阴性**

实测对照（同一台机器、同一时刻）：

| 检查项 | 在 SYSTEM / session 0 | 在交互会话（session 1） |
|---|---|---|
| `EnumDisplayDevices` | **返回空** | 4 个适配器，含 VDD `\\.\DISPLAY10` |
| `.NET Screen.AllScreens` | **只有 `WinDisc 1024x768`** | `DISPLAY10 1920x1080 primary` + `DISPLAY1` |
| 结论 | **假阴性** | 真实 |

我根据 session 0 的结果做了多轮错误推断（以为是 XML 改动、以为是驱动没启动、还让用户白登录了一次），实际**重启后一切自动恢复正常**。

⇒ **自检必须分两段**：SYSTEM 段（开机）只做系统层检查（S9/S12/S14/S15/S16/S17/S18）；**S1/S2/S3/S4/S5/S7/S8 必须由交互会话段（登录时 + 按需）执行**。JSON 里用 `unchecked` 明确标注，绝不能在 session 0 下报 `fail`。

**约束 C：SYSTEM 的 `HKCU` 不是用户的 `HKCU`**

以 SYSTEM 身份改 `HKCU:\Control Panel\Desktop` 只影响 SYSTEM 的配置单元。实测：SYSTEM 段把 `ScreenSaveActive` 设成 0 后，用户的仍然是 1。

⇒ 涉及用户级设置（`HKCU\Console`、`HKCU\Control Panel\Desktop`）的自检与修复**必须在用户会话里执行**，或显式操作 `HKU\<SID>\...`。

#### 5.10.3 按需自检：两个触发点

自检**不能只在开机/登录时跑**。它必须能从主机侧主动触发，且有两个明确的触发场景：

| 触发点 | 谁触发 | 时机 | 目的 |
|---|---|---|---|
| **T1 派单前门禁** | 主机（自动） | **每次 `RemoteProvider.start()` 之前** | 从机不满足条件时**拒绝派单**，而不是让任务跑起来再失败 |
| **T2 配置页查看** | 用户（手动） | 在 DSH 插件配置页打开/点「重新自检」 | 人工排查「为什么这台从机不能用」 |

两个触发点共用同一条 RPC，只是**新鲜度要求**不同（见 5.10.5 缓存）。

#### 5.10.4 协议扩展：`dsh-remote/selfcheck`

自检走**配对 WS 上的插件扩展方法**，与 ACP 的 JSON-RPC 同层但不进 ACP 命名空间（ACP SDK 的 `ClientApp` 暴露了 `request`/`notification`，可直接发自定义方法）。

```jsonc
// 请求
{ "method": "dsh-remote/selfcheck",
  "params": { "includeSessionChecks": true,   // false = 只做系统段（可在无交互会话时跑）
              "maxAgeMs": 30000 } }            // 从机可返回缓存结果，超过此年龄则重跑

// 响应
{ "schemaVersion": 1,
  "generatedAt": "2026-10-12T11:52:00.000Z",
  "fresh": true,                    // false = 返回的是过期缓存（从机忙 / session 段不可用）
  "sessionSegment": "ok",           // ok | unavailable | unchecked
  "worker": "WORKER-PC",
  "sessionId": 1,
  "interactive": true,
  "verdict": "ready",               // ready | warn | blocked | partial
  "blockingFailures": 0, "warnings": 0, "unchecked": 0,
  "checks": [ { "id": "S4", "name": "...", "severity": "blocking",
                "status": "pass", "expected": "...", "actual": "...", "fix": "..." } ] }
```

**为什么不用 ACP 的方法**：自检是插件概念，ACP 没有对应方法；且 ACP 的 `session/*` 都要求已建立的 session，而派单前门禁**必须在 `session/new` 之前**执行。

#### 5.10.5 缓存与新鲜度

| 调用方 | `maxAgeMs` | 理由 |
|---|---|---|
| T1 派单门禁 | **30000**（可配） | 连续派多个任务时避免每次重跑（S8 会移动光标、S9 要调 `powercfg`） |
| T2 配置页打开 | **0**（强制重跑） | 用户要的是当下状态 |
| T2 配置页轮询（离线检测） | 不适用 | 从机离线时用配对通道的心跳，不要重跑自检 |

⚠️ **S8 有副作用**（它真的移动光标）。所以：
- 缓存是必需的，不能每个任务都跑
- **从机正在执行任务时，S8 应跳过并返回 `unchecked`**（光标正被任务使用），避免与任务抢光标

#### 5.10.6 两段式与派单门禁契约

**关键**：session 0 只能查系统层（§5.10.2.1 约束 B）。所以自检天然分两段，门禁也分两段：

```
从机侧：
  系统段  S9 S12 S14 S15 S16 S17 S18   ← SYSTEM 或任意会话都可跑
  会话段  S1 S2 S3 S4 S5 S6 S7 S8 S10 S11  ← 必须交互会话；S8 是活体检查
```

| 段 | 谁跑 | 何时 |
|---|---|---|
| 系统段 | 从机计划任务（AtStartup, SYSTEM）+ RPC 时补齐 | 开机 + 每次 RPC |
| 会话段 | 从机计划任务（AtLogon, Interactive）+ RPC 时补齐 | 登录 + 每次 RPC |

**门禁规则**：

```
if (系统段 有 blocking fail)                    → 拒绝，返回具体项 + fix
else if (会话段 unavailable：无交互会话/锁屏)    → 拒绝，reason = 'no-interactive-session'
                                                  （不是从机的错，是没人登录；UI 要给出明确指引）
else if (会话段 有 blocking fail)                → 拒绝，返回具体项
else if (verdict === 'warn' 或 有 unchecked)     → 放行，但把 warning 注入模型上下文
else                                            → 放行
```

⚠️ **`no-interactive-session` 必须与「从机坏了」区分开**：前者是运维状态（等人登录），后者是故障。UI 文案和模型可见的 diagnostic 都要区分，否则用户会去排查错误的方向。

#### 5.10.7 模型可见性：`remote_selfcheck` 工具

除了自动门禁，模型也应能主动查询。新增第四个工具（与 `remote_agents` / `remote_interrupt` 并列）：

| 工具 | 参数 | 返回 |
|---|---|---|
| `remote_selfcheck` | `peerId?`、`includeSessionChecks?` | 该从机的自检报告（紧凑文本：verdict + 失败项 + fix） |

用途：模型在派单失败后能自己看到原因（"从机需要有人登录" / "分辨率不对"），而不是反复重试。

#### 5.10.8 面板呈现

- 顶部一行总结：`就绪` / `N 项阻断` / `从机离线`
- 每项一行：图标 + 名称 + 期望 + 实测 + 修复指引（可折叠）
- **从机的历史自检结果**要保留（用于回答"它是什么时候变坏的"）
- 主导航上给阻断项一个醒目计数（不满足时任务根本发不出去，用户需要立刻知道）

---

## 6. 工作区同步

> 完整设计见 `.research/06-workspace-sync-design.md`（1453 行）。本节是定稿摘要。

### 6.1 方案：一份 manifest，两种内容来源

**git 树管 git 能覆盖的文件；sha256 CAS 管被 `.gitignore` 忽略的夹具/驱动/二进制。从机无 git 时全量退化为 CAS。**

关键技术复用：**不要自研「不碰仓库拿完整工作树快照」**。DSH 已实现该技法（`dsh-workspace-changes/lib/types/git.js:83-129`）：私有 `GIT_INDEX_FILE` + `GIT_OBJECT_DIRECTORY` + `GIT_ALTERNATE_OBJECT_DIRECTORIES`，只跑 `git add --all --ignore-errors` → `write-tree`。语义（`:97-102`）：得到完整工作树（**含 untracked 与 modified，不含 ignored**），且仓库的 index / object store / work tree / refs **保持不变**。

四个关键问题的答案：

| 问题 | 答案 |
|---|---|
| 主机工作区**脏** | 天然覆盖。快照即内容，不需要 commit |
| untracked 新文件 | 覆盖（`--all`）；被 ignore 的走 CAS 层 |
| 非 git 项目 | `locateGitWorkspace` 返回 `null` → 纯 CAS 降级 |
| `.git` 是否传 | **默认不传**。理由：体积、`.git/config` 可能内嵌 token、从机 `git status` 会给出误导结论。需要 git 语义时用 bundle 传一个合成提交 |

### 6.2 manifest 格式（节选）

```jsonc
{
  "manifestVersion": 1, "syncId": "sy_01JQ…", "taskId": "t_01JQ…", "peerId": "peer_02",
  "root": { "hostCanonicalPath": "F:\\WorkSpace\\proj",
            "targetCanonicalPath": "F:\\WorkSpace\\proj",
            "pathMode": "identical",            // identical | mapped
            "volume": "F:", "requiresFreeBytes": 4026531840 },
  "layers": {
    "git": { "available": true, "snapshotTree": "9f1c0e…", "baseTree": "71b0aa…|null",
             "transport": "bundle",
             "bundle": { "bytes": 184320512, "sha256": "5d41c0…" },
             "trackedCount": 8123, "excludes": [".dsh-remote", "node_modules"] },
    "cas": { "count": 214, "bytes": 3221225472, "entries": [
      { "p": "drivers/chromedriver.exe", "s": 16777216, "m": 1739340000123,
        "h": "sha256:9d2f…", "x": true } ] }
  },
  "dirs": ["drivers", "fixtures/models"], "emptyDirs": ["test-results/artifacts"],
  "totals": { "files": 8337, "bytes": 3405545984 },
  "delete": { "mode": "mirror", "paths": [] },
  "rehydrate": [ { "kind": "npm", "lockfile": "package-lock.json",
                   "lockfileSha256": "sha256:…" } ],
  "policy": { "overwriteExisting": "replace-managed-only", "chunkBytes": 8388608,
              "maxFileBytes": 2147483648, "allowSymlinks": false, "preserveMtime": true },
  "manifestDigest": "sha256:0011aa…"
}
```

- `h` 用 `sha256:<hex>`，与 DSH 既有 canonical id 形式对齐（`dsh-attachment-local/lib/index.js:275`）
- **方向：主机先推 manifest → 从机回 `{have, need, extra}`**。冷启动省一次往返；且从机能在落任何字节前完成路径/安全/配额校验
- `m`（mtime）**只作宿主机本机哈希缓存的键，永不作跨机器内容判据**

### 6.3 同步状态机

```
Idle → Preflight → Planning → Transferring → Verifying → Materializing → Rehydrating → Committed
         │            │           │  ↑                                            │
         │            │           │  └── Suspended（断网；staging/uploads.json 保留，重连续传）
         └────────────┴───────────┴──────────────→ Rejected / Aborted → Cleaning → Garbage
```

| 状态 | 离开条件 |
|---|---|
| `Preflight` | 能力 + 路径 + 配额全通过 → `Planning`；否则 → `Rejected`（**不发 `session/new`**） |
| `Planning` | 从机 `accepted: true` → `Transferring` |
| `Transferring` | 全部 need blob `complete` → `Verifying`；网络错 → `Suspended`；取消 → `Aborted` |
| `Verifying` | 逐文件 digest + bundle fetch 全过 → `Materializing`；任一不符 → `Rejected`（**不重试**） |
| `Materializing` | 切换成功 → `Rehydrating`；失败 → `Rejected`（用 journal 回滚） |
| `Rehydrating` | 依赖重建成功 → `Committed`；失败 → `Rejected` + 回滚 |
| `Committed` | **事务提交点**。目标路径完整自洽 + `state.json` 已写 ⇒ **此时才发 ACP `session/new`** |

- **幂等键 `(peerId, targetCanonicalPath, manifestDigest)`**。从机 `state.json` 命中同 digest ⇒ 直跳 `Committed`，零传输
- 切换靠 `journal.json`（`phase: staged → old-moved → new-in-place → state-written`）做崩溃恢复
- 默认 **`per-task` 全新目录**策略（单次 rename，最干净）；`sticky` 增量作可选

### 6.4 🔒 路径身份是功能正确性，不是美观问题

`dsh-workspace/lib/types/paths.js:33-35` 明写：**「uniqueness is string equality of canonicalized paths」**；durable id 是 `randomUUID()`（`types/index.js:433`）⇒ **DSH 没有任何跨机器路径的 join key。**

路径不一致的具体失败：

| 失败 | 证据 |
|---|---|
| session 被踢出 workspace 成员 | `dsh-workspace/lib/index.js:872-890, 900-909` |
| `session/resume` 直接失败 `session cwd does not match` | `dsh-acp/lib/index.js:1217`（且本版本 ACP 无 `session/load`，无法绕） |
| 沙箱写权限只覆盖 `session.header.cwd` | `dsh-sandbox-policy/lib/index.js:141-147` |

⚠️ **实测否证了「用 junction / subst 顶上」这个直觉**：`X:\proj`（subst）与 junction 在 `realpath.native` 和 `fs/promises.realpath` 下**都解析到真实底层路径** ⇒ 它们**破坏**身份而不是修复它。

⇒ **唯一身份保持的映射方式：从机上存在同盘符、同路径的真实目录。**

### 6.5 🔒 (mtime, size) 不能作跨机器内容判据 —— 会静默跑旧夹具

FAT32 的 2 秒粒度、DST、解压工具重写 mtime、`git checkout` 把 mtime 设为当前时间——这些让「从机 mtime 更新」成为常态。据此跳过传输 = 从机上是**内容陈旧但看起来正常**的夹具 ⇒ **旧夹具里没有新断言，GUI 测试直接假绿**（最坏结果）。

防呆：**跨机器只认 sha256**；`(size, mtime)` 仅用于宿主机本机的哈希缓存；提供 `verify` 命令强制全量重算。

### 6.6 🔒 传输通道：blob 不能走 ACP 的 WebSocket

`@agentclientprotocol/sdk` 的 WS transport **只处理文本帧**（`sdk/dist/ws-stream.js:6-9, 110`），二进制帧在 `ws-utils.js:24-39` 被解为 `undefined` → `:119-124` **静默丢弃（不报错）**。叠加无背压、base64 放大 4/3、JSON-RPC buffered 上限 300 MiB（`dsh-client-connection/lib/index.js:25`）。

⇒ **在配对中继上另开 HTTP/1.1 通道**：

```
PUT  /dsh-remote/v1/blob?digest=sha256:…&offset=…   (application/octet-stream, 8 MiB 块)
GET  /dsh-remote/v1/blob/status?digest=…             (续传)
     complete 时服务端重算 sha256 校验
```

认证必须自己做（ACP 协议无鉴权）。这个形态正是 DSH 自己上传文件的形态（`dsh-client-file-upload/lib/index.js:171-176` 的 `requestBody: "streaming"` + `http-route.js:57-72` 的 `requestBodyChunks`）。

### 6.7 🔒 从机的中继必须是 standalone 监听器

**`acp` profile 里没有 `dsh-host-webserver`**（`dsh-acp-app` 只含 `dsh-acp`；webserver 只在 `dsh-web-app`/`desktop` 里）。因此从机侧的 relay 必须**自带 HTTP + WS 监听器**，不能写成「注册一条 webServer 路由的 DSH 插件」。

这与 §7.1 一致，也再次说明认证、body 上限、超时都必须自己实现。

### 6.8 Windows 替换工作区既不原子也不廉价

| 事实 | 后果 |
|---|---|
| 不能 rename 覆盖非空目录 | 必须两次 rename + journal 恢复，存在窗口期 |
| 文件被 chromedriver/杀毒/索引器持有 → `EACCES/EBUSY/EPERM` | DSH 唯一的重试逻辑是 `dsh-atomic-write:17-44`（8 次、20→200ms ≈ 1.1s，**对杀毒扫描远远不够**）；`dsh-fs-local` 的替换路径**完全不重试**（`:531-561`） |
| 磁盘峰值 ≈ **3 倍工作区**（staging + old + blobs） | staging **必须与目标同卷** |

⇒ 空间预检、提交后立即删 old、标记-清除 GC —— **三件缺一不可**。

### 6.9 其他约束

- **排除清单**必须默认包含 `.git`、`node_modules`、`.credentials.yaml`、`.env`、测试产物、DSH 自身状态、本插件目录、锁文件、重解析点。配置优先级：CLI > 工作区 `.dsh-remote-sync.yaml` > 插件配置 > 默认，并提供 `remove:` 逃生门
- **🔒 git bundle 物化必须强制 `core.autocrlf=false`**，否则落盘行尾与 manifest digest 不符（由调研报告附录 B 升级为设计约束）
- **`ctx.attachments` 是 DSH 唯一现成的 GB 级 sha256 流式 CAS**（有背压、`link` 去重、崩溃安全），**但 DSH 永不回收 attachment**（`dsh-attachment/lib/types/index.js:17-18`，全库无 GC 实现）⇒ **默认自建**（照抄算法），`attachments` 作可选后端
- **`dsh-atomic-write` 可直接复用**：`writeFileAtomic`（Windows EACCES/EBUSY/EPERM 重试）+ `withFileLock`（PID 死锁接管）。注意它**不做 fsync**（`:56`），暂存文件要自己 `handle.sync()`

---

## 7. 从机侧模块

### 7.1 `WsRelay`

- **standalone 监听器**：自带 HTTP + WebSocket server，**不经 `webServer`**（原因见 §6.7：ACP 相关 profile 无 webserver；且 webServer 本身无鉴权、CLI 又禁止 `0.0.0.0`）
- 自带：Bearer 鉴权、握手校验、心跳、消息大小上限
- **blob 上传通道**（§6.6）挂在同一个 HTTP server 上，但走独立的 `/dsh-remote/v1/blob` 路由
- **从机级串行队列**：WS 上的任务按 FIFO 执行；GUI 独占（§7.3）
- 单主机锁：已被配对时拒绝其他主机的握手

### 7.2 `Spawner`

- 每条 WS 连接拉起一个 `dsh --profile acp` 子进程
- stdio ↔ WS 帧桥接
- 子进程退出 → 结算该连接上所有在途任务为 `error`
- 从机重启后清理孤儿进程与半成品工作区

### 7.3 串行化（GUI 独占）

**V1 决策：一台从机同一时刻只跑一个任务。**

理由：GUI 是独占资源（一个鼠标一个屏幕）；判定"这个任务不碰 GUI"的收益远小于判错的代价。串行的代价只是慢，并行的代价是测试结果不可信。

主机侧 provider 在派单前检查从机空闲，否则排队（并在 `remote_agents` 里如实显示"排队中"）。

⚠️ 队列持久化（从机重启后是否恢复排队任务）见 §11。

### 7.4 `KillSwitch`

本地急停，三种作用域（Settings 页可见）：

| 作用域 | 行为 |
|---|---|
| 停当前任务 | ACP `session/cancel`，任务结算为 `aborted` |
| 停队列 | 清空排队任务，当前任务不动 |
| 断开配对 | 关闭 WS + 清除 masterKey，回到未配对 |

急停**不回滚**已经完成的文件操作（GUI 操作本身就不可回滚）。急停事件写本地审计。

### 7.4.1 `SelfCheckService`（按需自检的执行端）

对应 §5.10 的设计，运行在从机上：

| 职责 | 说明 |
|---|---|
| 实现 `dsh-remote/selfcheck` | 收 `{ includeSessionChecks, maxAgeMs }`，返回 §5.10.4 的报告 |
| 两段式执行 | 系统段可在任意会话跑；**会话段必须在自己所在的交互会话里跑** |
| 缓存 | 存最近一次报告 + `generatedAt`；`maxAgeMs` 内直接返回（标记 `fresh: false` 时说明是命中缓存） |
| **S8 冲突规避** | **从机正在执行 GUI 任务时跳过 S8**，返回 `unchecked` —— 否则自检会与任务抢光标，把任务打断 |
| 开机/登录预热 | `DshSelfCheckBoot` / `DshSelfCheckLogon` 计划任务先把报告写到磁盘，RPC 据此返回（避免每次 RPC 都跑 S8） |
| 落盘 | `$SLAVE_ROOT/selfcheck.json`（插件读这个，不必每次 RPC） |

⚠️ **样例脚本的局限**：我在从机上实现的是**可运行的样例**（`slave-selfcheck.ps1`），它只在开机/登录触发并落盘，**没有实现 RPC 服务端、缓存、S8 冲突规避**。这三点是插件实现时必须补的。

⚠️ **脚本格式**：从机侧脚本必须**纯 ASCII 或写 UTF-8 BOM**（§5.10.2.1 约束 A）。样例是纯 ASCII，并在交付前用 `Parser::ParseFile` 校验过。

### 7.5 🔴 从机部署约束（来自实地勘察）

对实测机器 `worker-pc` 的勘察见 `.research/07-slave-recon.md`。以下三条由实测得出，**升级为设计约束**：

| # | 约束 | 原因 |
|---|---|---|
| D1 | 🔴 **中继必须运行在用户交互会话，不能做成 Windows 服务、也不能靠 SSH 启动** | SSH 命令落在 **Session 0**（services 会话），该会话**没有交互桌面**。从中继启动的任何 GUI 操作都会失败。DSH Desktop 应用本体运行在用户的 RDP 会话（实测 Session 2） |
| D2 | ⚠️ **从机必须固定会话形态与分辨率，并上报主机** | 实测同一台机器：物理控制台 `1920×1080`，RDP 会话 `2560×1440`。同一个 GUI 测试在两种会话下看到的布局不同。另外**断开 RDP 会锁屏**，锁屏下截图通常黑屏、UI 不可交互 |
| D3 | 🔴 **协议版本协商是必需品** | 实测两机均为 `0.2.0-rc.2`（当前一致），但都是 `channel: nightly` 且**独立更新** → 版本随时可能漂移 |

**工作节点页必须显示**：当前会话类型（RDP / 控制台）、会话 ID、分辨率、锁屏状态。否则「为什么测试在这台机器上失败了」会变成一个查不出来的问题。

### 7.6 GUI 测试的实际机制（源码级确认）

完整证据见 `.research/08-gui-mechanism-actual.md`。来源是实际实现，**不是推测**。

**三级机制**（`libvlc3-bridge\avalonia-demo\tools\verify-criteria.ps1`）：

| 层 | 实现 |
|---|---|
| 注入 | **`SetCursorPos` + `SendInput(MOUSEEVENTF_MOVE/LEFTDOWN/LEFTUP)`** —— 系统级合成输入，**真实光标会移动** |
| 判据 | **`WindowFromPoint(point)` → 窗口类**（硬判据），与 Qt 侧的尺子一致 |
| 前台 | **`AttachThreadInput`（与当前前台线程 + 目标线程共享输入队列）+ `SetForegroundWindow`**，否则点击静默丢失 |

配套：`SetProcessDpiAwarenessContext(-4)`（PerMonitorV2，坐标正确性依赖它）、点击前用 `WindowFromPoint`+`GetAncestor` 校验光标下是自己的窗口、点击循环重试、脚本结束恢复光标位置。

#### 🔴 `PostMessage` 是被**刻意否定**的

`verify-criteria.ps1:10-13` 的原文：

> `PostMessage` delivers straight to the target window procedure and therefore **bypasses the z-order / hit-testing** that the whole airspace question is about. It happily "clicks" a button that is **completely covered**, which is exactly the wrong answer here.

对一个研究**空域遮挡**的测试，这个区别就是被测对象本身：`PostMessage` 会点中被完全遮住的按钮 → **假绿**；`SendInput` 走 z-order 命中测试 → 遮住就点不到 → 正确。

#### 为什么这个需求是必然的

| 项 | 事实 |
|---|---|
| 移动真实光标 | ✅ `SetCursorPos` |
| 抢前台 | ✅ `AttachThreadInput` + `SetForegroundWindow` |
| 与用户抢鼠标 | ✅ 必然发生 |
| 脚本自己也知道 | 注释明写 *"this script moves the mouse cursor; it restores the original position afterwards"* |

⇒ **「避免与本人抢占计算机交互」不是优化诉求，而是这套测试方式的直接后果。** 把它放到从机上，是唯一能同时保住「测试保真度」和「主机可用性」的办法。

⚠️ **同时纠正本设计早期的两处判断**：
1. 我曾写「发 `PostMessage` 点击」——**错**，实际是 `SendInput`。
2. 我曾分析「Qt/Avalonia 控件不是独立 HWND，所以只能发消息+坐标」——**部分对但不是重点**。真正的重点是**命中测试**：`SendInput` 必须走 OS 的 z-order 判定，这正是空域测试要验的东西。

### 7.7 🔴 从机 GUI 运行的硬约束（由实际机制推导）

| # | 约束 | 原因 |
|---|---|---|
| D1′ | **注入进程必须与目标应用在同一交互会话**。从机的 DSH（内含本插件与测试脚本）必须跑在用户会话（实测 Session 2），**不能靠 SSH 启动**（SSH 落在 Session 0） | `SendInput` 是会话作用域的；`AttachThreadInput` **不能跨会话** |
| D2′ | **会话必须已登录、未锁屏、且非断开的 RDP** | 断开的 RDP 会话窗口不可见；锁屏停止渲染。两者都使 `SendInput` 路径失效 |
| D3′ | **会话类型 + 分辨率 + DPI 缩放必须固定并上报** | 坐标正确性依赖 DPI 感知与屏幕几何。主机 1920×1080 / 从机 RDP 2560×1440，坐标**不可直接搬** |
| D4′ | **测试期间从机不能有别人用鼠标** | `SendInput` 移动真实光标、抢前台；真实用户一动就打断测试 |
| D5′ | **从机上不能有安全软件阻断合成输入** | 部分 EDR/杀软拦截 `SendInput`；这也是 `mouse_event` 被判"flaky"的原因之一 |

#### 架构分叉：通用黑盒 vs 应用内适配（值得实现前评估）

`dvd-mouse-inject.md` 记录了另一条注入通路：**应用内 API 注入**（`var_SetChecked(vout, "mouse-moved"/"mouse-clicked", …)` → libvlc 内部 → `dvdnav_mouse_*`）。它**完全在进程内**，不移动光标、不抢前台、可后台运行。

| | 通用黑盒（`SendInput`） | 应用内适配（每个 app 加测试命令通道） |
|---|---|---|
| 适配成本 | 零适配 | 每个被测应用一次性适配 |
| 会话必须解锁 | ❌ 必须 | ✅ 不需要 |
| 与用户抢鼠标 | ❌ 会抢 | ✅ 不抢 |
| GUI 可并发 | ❌ 独占 | ✅ 可并发 |
| 能验空域/遮挡 | ✅ 能（这正是它的价值） | ⚠️ 取决于适配层是否模拟真实命中测试 |

⇒ **这是本项目最值得先评估的架构分叉。** 若被测应用都能暴露一个测试命令通道，§7.3 的「一台从机同时只跑一个任务」和 D2′/D4′ 两条硬约束**全部消失**。

#### 现有测试矩阵：只有一个脚本需要搬

| 脚本 | 用真实输入 |
|---|---|
| **`verify-criteria.ps1`** | ✅ **唯一**做点击的验收脚本 |
| `capture-demo.ps1` / `verify-drag.ps1` / `verify-perf.ps1` / `verify-resize.ps1` / `verify-soak.ps1` | ❌ 只抓屏 / `SetWindowPos` 驱动 / 纯测量 |

#### ✅ 已实测通过：从机可完整跑通 GUI 验收

在从机 `worker-pc` 上实跑 `verify-criteria.ps1`，**两个场景全绿**：

| Scenario | ClassOk | ExpectClick | Clicked | Pass | ChildHwnds | LuidMatch |
|---|---|---|---|---|---|---|
| A-normal | True | True | **True** | ✅ | 0 | True |
| B-control-group | True | False | **False** | ✅ | 1 | True |

`PASS: A the probe takes the click; B a native child window covers it and the click never arrives`

⇒ **空域遮挡判据在从机上完整复现**：`WindowFromPoint` 的 z-order 判定正确、`SendInput` 点击真的到达 Avalonia 控件、被原生子窗口覆盖时点击正确不到达、`PrintWindow` 截图可用、Intel 核显上 GPU 互操作成立（`LuidMatch=True`、`fault=0`）。

**部署量**：30.6 MB / 40 文件（纯托管 + SkiaSharp，**不需要 VLC SDK、不需要测试 ISO**）。

#### 🔴 执行这套测试的三个硬前提（缺一不可）

| # | 前提 | 验证方式 |
|---|---|---|
| 1 | 执行进程在**交互会话**（Session 2），**不能是 SSH** | SSH 落 Session 0 → `SendInput` 返回 0/3 |
| 2 | 该会话的桌面**被显示设备真正附着** | RDP 客户端断开后会话仍显示 `Active`，但 `SetCursorPos` 失败、`SendInput` 0/3 |
| 3 | 用 **`tscon <id> /dest:console`** 把会话移交控制台（SYSTEM 身份执行） | 移交后 `SendInput` 立刻 3/3、光标真实可移 |

#### 从机侧执行器必须用 `Start-Transcript`

⚠️ 实测踩坑：用 `schtasks` 调脚本并把输出 `*>&1 | Out-File` 重定向，**只得到 scenario 头就结束**（`lastTaskResult=1`）。改用 **`Start-Transcript`** 后一次通过。从机侧执行器应统一用 transcript，不要用管道重定向。

#### ⚠️ 主从硬件差异（影响测试可比性）

| 项 | 主机 | 从机 |
|---|---|---|
| GPU | **NVIDIA RTX 3050** | **Intel UHD Graphics 730** |
| 桌面 | 2048×1152 + 1080×1920（双屏） | 1024×768（`WinDisc`，显示器未开） |
| DPI 缩放 | — | 1.00 |

**结构类判据（空域/遮挡）不受影响**，但**性能类判据不可跨机比较**（核显 vs 独显），渲染后端相关判据也可能不同。

⇒ **从机上报的能力清单必须包含 GPU 型号 + 驱动版本 + 桌面分辨率 + DPI 缩放**，主机据此决定派哪类任务（见 §5.3 的 `TaskRegistry` 与 §7.7 的能力上报）。

### 7.8 ✅ 从机无人值守配置（已实测通过）

从机 `worker-pc` 的完整配置，**重启后全部自动保持，无需人工干预**。

#### 系统层

| 组件 | 配置 | 验证 |
|---|---|---|
| 虚拟显示器 | **Virtual-Display-Driver (VDD) 25.7.26**，MIT，SignPath 签名 | 重启后自动出现 `\\.\DISPLAY10` |
| 显示器身份 | EDID `MTT1337` / "VDD by MTT" | 非 `WinDisc` 兜底 |
| 分辨率 | **1920×1080@60**（主屏，原点 `0,0`） | 重启后布局被 Windows 记住 |
| 睡眠/休眠 | `STANDBYIDLE`/`HIBERNATEIDLE` **AC=0 DC=0** | S9 |
| 屏保 | `HKCU\Control Panel\Desktop\ScreenSaveActive=0` | S10（**必须写用户配置单元**，见 §5.10.2.1 约束 C） |
| 自动锁屏策略 | 未设置 | S11 |

#### 会话层

| 项 | 状态 |
|---|---|
| 会话 | `console`，绑定物理控制台 |
| 锁屏 | `OpenInputDesktop` = `Default`（未锁） |
| RDP | **不需要**（VDD 让物理显示器可随时给主机用） |
| 物理显示器 | 可随时切走；KVM 保持 EDID 时 Windows 仍认为设备存在 |

#### 开机自检任务（两个）

```
DshSelfCheckBoot   AtStartup +30s, SYSTEM       -> slave-selfcheck.ps1
DshSelfCheckLogon  AtLogOn  +45s, Interactive   -> slave-selfcheck.ps1（提供 S7/S8）
```

输出：`C:\dsh-remote\selfcheck.json`（结构化，供插件配置页读取）+ `selfcheck.txt`（人读）。

实测结果：`verdict=ready blocking=0 warn=0 unchecked=0`，S1–S18 全部 OK（含 S8 活体检查 = ok）。

#### 从机侧执行器的硬要求

| # | 要求 | 原因 |
|---|---|---|
| 1 | 脚本**纯 ASCII** 或写 UTF-8 BOM | §5.10.2.1 约束 A |
| 2 | 显示类检查**只在交互会话**执行 | §5.10.2.1 约束 B |
| 3 | 用户级注册表**在用户会话**改 | §5.10.2.1 约束 C |
| 4 | 用 **`Start-Transcript`**，不要管道重定向 | §7.6 |
| 5 | 不创建可见控制台 | 结合 S12 避免点击冻结执行器 |

#### ⚠️ 运维注意事项

- **VDD 与大版本 GPU/芯片组驱动更新冲突**：可能导致开机黑屏（虚拟屏被排到物理屏前面）。更新前先卸载 VDD。**SSH 是逃生通道**，任何显示相关变更前先确认 SSH 可用。
- **`vdd_settings.xml` 的 `logging`/`debuglogging` 必须保持 `false`**：debug 日志能生成上千行。
- **改 XML 后需重启设备或系统**才生效。
- **显示布局（主屏、原点）由 Windows 持久化**（`CDS_UPDATEREGISTRY`），不依赖 XML 顺序。但布局漂移的症状是**测试静默点偏**——所以 S4 是阻断级检查。
- **`x86` 目录里装的是 x64 驱动**（本项目命名不规范）；`VDD Control.exe` 是 x64 的 portable 应用。**`winget install` 只装控制程序，不装驱动**——必须运行 VDC 点 Install。

---

## 8. 安全模型与审批

### 8.1 信任边界

```
人类(主机) ──信任──► 主机 DSH ──半信任──► 从机 DSH ──受限──► 从机操作系统
                                    ↑
                       唯一防线：主机的 ReviewEngine
```

从机的受限沙箱是**第二道**（操作系统层），不是第一道。

### 8.2 审批流程

```
从机工具调用 → 沙箱拒绝提权 → approval/request → ACP session/request_permission
                                                        │
主机 AcpClientBridge ──► toolCallId 查缓存 ──► 得到 { toolName, rawInput }
                                                        │
                              ┌─────────────────────────▼──────────────────┐
                              │ ReviewEngine                                │
                              │  1. 命中任务内记忆？        → 自动 allow-once │
                              │  2. 命中拒绝记忆？          → 自动 reject    │
                              │  3. 命中任务级授权范围？     → 自动 allow-once │
                              │  4. 其余                    → 上报人类        │
                              └─────────────────────────┬──────────────────┘
                                                        │
                                        人类决策 ──► / 90 秒超时 ──► reject
```

### 8.3 ReviewEngine 规则粒度（V1）

| 维度 | 默认 |
|---|---|
| 记忆范围 | **单任务内**（任务结束即失效；不跨任务、不跨会话） |
| 记忆键 | `工具名 + 目标形状`：写类按**目录前缀**，命令类按**命令前缀**，其余按工具名 |
| 任务级授权范围 | 派单时由主机的任务描述声明（可选）；从机的 `cwd` 天然构成写类操作的默认范围 |
| 人类可选项 | 批准一次 / **本任务内批准此类** / 拒绝（拒绝后本任务内同类不再问） |
| 超时 | **90 秒**，可配。超时 → 按拒绝处理 |
| 映射缺失 | `toolCallId` 查不到 `tool_call` → **默认拒绝** + 审计告警 |
| **档位检查** | 🔴 **必需**：从缓存的 `rawInput` 取 `sandbox_permissions`，与本次操作**实际需要的最小档位**比较；**申请宽于所需则拒绝**，并在 diagnostic 指明"请用最窄的够用档位重试" |
| **`danger-full-access` 申请** | 🔴 **必须人工确认**，规则不得自动放行（它是无限制档） |

**为什么默认单任务内**：自动化测试重复性极强，跨任务记忆会让"上周批准过写这个目录"静默变成永久授权。

**🔴 档位检查的必要性（已实测）**：见 §10.0.1。实验证明两点：
1. **模型会过度申请**——一次「写单个文件到工作区外」被拒后，模型申请的是 `danger-full-access`（最高档），而不是够用的窄档；
2. **主机的审批请求看不到申请内容**——`session/request_permission` 只带 `toolCallId`。

⇒ 若不做档位检查并无条件放行，**第一次越权申请即可获得全文件系统权限**。档位信息只能从 §5.2 的 `tool_call` 缓存里取。

**档位比较表**（宽窄序）：`read-only` < `workspace-write` < `danger-full-access`。写单个文件到工作区外时，够用的最小档是 **`workspace-write`**（会话 `cwd` 之外另需显式路径授权），**不是** `danger-full-access`。

### 8.4 超时是硬性要求

🔒 调研确认：JSON-RPC 层无超时、DSH 侧无审批超时、**工具自身 `timeoutMs` 不覆盖审批阶段**、无客户端连接时远端通道不 fail closed（实证有一次审批等了 282.8 秒）。**插件必须自己实现超时**，否则一次网络抖动 = 从机任务永久挂死。

超时后必须显式回 `{ outcome: 'selected', optionId: 'reject-once' }`，让从机的 `approval/request` waterfall 得到确定的 `'rejected'`，而不是留着 promise 挂住。

### 8.5 high 风险的呈现

按决策：**允许转发**（保留人类终审权），但主机 UI 必须：

- 对 high 类理由做**强视觉区分**，不与普通审批同形
- 要求**二次确认**才能批准

理由：实证显示有人批准过标记为"明文凭据外泄"的 write 操作。人类有能力覆盖，所以呈现必须足够刺眼。

### 8.6 待审批的主动通知

因为从机 turn 是**挂着**的（不是失败、不是超时），必须主动通知，否则任务静默卡死。

- 主机 Settings 页顶部常驻「待审批 (N)」区域
- 桌面通知（可复用 `dsh-plugin-notify` 的思路）
- 从机侧「工作节点」页同步显示"正在等待主机审批"

### 8.7 数据不出局域网

- 传输不经过任何第三方服务
- ⚠️ 注意：`dsh-session-log-deepseek` 默认把从机的**规范会话日志上送官方服务**（含全部审批事件）。本项目按决策不处理此事，但文档需如实告知用户：**从机会话的内容会随从机的模型请求上送**，与远程委托无关，但会包含从机执行细节。

---

## 9. 审计

**位置**：`$DSH_HOME/storages/dsh-plugin-remote-use/audit/<yyyy-mm-dd>.jsonl`

**记录**（任务开始/结束各一行，每次审批决策一行）：

```json
{
  "ts": "2026-10-08T12:34:56.789Z",
  "kind": "task-start | task-end | approval",
  "peerId": "peer-7f3a",
  "peerName": "lab-pc",
  "taskId": "task-01J...",
  "sessionId": "session-...",
  "toolName": "pwsh",
  "argsDigest": "sha256:...",
  "decision": "allow-once | allow-task | reject | timeout",
  "decisionSource": "memory | human | policy",
  "risk": "low | medium | high | unknown",
  "reason": "Auto review denied: ...",
  "elapsedMs": 1234
}
```

两个刻意选择：

1. **参数存摘要不存原文**：审批参数常带凭据、token、路径；审计日志自身变成泄露源是常见翻车方式。需要完整参数时按 `taskId` 回看会话日志。
2. **`decisionSource` 必须记**：DSH 原生 auto-review 的放行行为**无留痕**；插件自己记这个字段，才能回答"这条是规则自动放的、还是我亲手批的"。

**保留**：默认 30 天，可配。**轮转**：单文件 64MB。**配额**：总大小上限，超限告警而非静默丢弃。

---

## 10. 分阶段实施

### 10.0 ✅ P0 可行性验证：已通过

**主机（`F:\WorkSpace\dsh-plugin-remote-use\prototype`）跨局域网驱动从机 DSH，完整跑通。**

```
主机 client.mjs ──ws://192.168.1.101:7331──> 从机 relay.mjs ──stdio──> 从机 dsh --profile acp
```

实测时间线（真实工具调用任务）：

| 阶段 | 耗时 | 结果 |
|---|---|---|
| WS 连接 | 22 ms | ✅ |
| `initialize` | 979 ms | `agent=deepseek-harness-acp@0.0.1 proto=1` |
| `session/new` | 1010 ms | `sessionId=0b4d0ebc-...` |
| 第一个 `tool_call` | 1954 ms | `title="write"`，`rawInput` 完整 |
| `tool_call_update` | 1959 ms | `status=completed`，结果在 `content` |
| 第二个 `tool_call` | 2887 ms | `title="read"` |
| `stopReason` | 3838 ms | `end_turn` |

**从机上验证**：`C:\dsh-remote\p0work\remote-proof.txt` 真实存在（20 字节，内容 `MADE_BY_REMOTE_AGENT`）。

**结论**：ACP-over-WebSocket 这条路线的技术前提**成立**，可观测性足够（工具名、参数、成败、结果都有）。

#### 🔴 P0 踩出来的 4 个实现坑（必须写进实现）

**坑 1：不能从 Node spawn `dsh.cmd`**

| 尝试 | 结果 |
|---|---|
| `spawn('cmd.exe', ['/d','/s','/c', '"C:\\...\\DeepSeek Harness\\...\\dsh.cmd" --profile acp'])` | ❌ **引号被 Node 转义成字面量** → cmd 看到 `\"C:\...` → 路径被空格拆开 |
| `spawn('C:\\...\\dsh.cmd', ['--profile','acp'])`（无 shell） | ❌ **`EINVAL`**（Node 拒绝无 shell 执行 `.cmd`） |
| 用 8.3 短路径绕开空格 | ⚠️ 可行但脆弱（依赖短名生成，跨卷不确定） |

✅ **正确解法：复刻 shim，用 argv 数组直接 spawn**。`dsh.cmd` 的内容就是：
```bat
set "ELECTRON_RUN_AS_NODE=1"
"<install>\DeepSeek Harness.exe" --expose-internals "<install>\resources\app.asar\dsh\
  node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
```
所以启动规格应当是 **`{ command: "<install>\\DeepSeek Harness.exe", args: ["--expose-internals", "<asar cli.js>", "--profile", "acp"], env: { ELECTRON_RUN_AS_NODE: "1" } }`**。**没有 shell、没有引号、没有 DEP0190**。

⚠️ **`cli.js` 在 `app.asar` 内**，`fs.existsSync` 对它返回 **false**，但 Electron 能读。**校验启动规格时不要检查 cli.js 是否存在**，只检查 `.exe`。

⚠️ **`$env:LOCALAPPDATA` 在 SYSTEM 会话下指向 `C:\Windows\system32\config\systemprofile`**，所以自动定位安装目录会失败。**启动规格必须显式落盘**（我们用了 `agent-spec.json`），不要依赖环境变量推导。

**坑 2：中继必须以「拥有凭据的用户」身份运行**

以 SYSTEM 运行时 ACP 层全通，但 `session/prompt` 立刻失败：
```
Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official";
store DEEPSEEK_API_KEY through the credentials service, or export DEEPSEEK_API_KEY
```
因为凭据在 `C:\Users\worker\.dsh\.credentials.yaml`，SYSTEM 读不到。

⇒ **中继任务的 principal 必须是 `LogonType Interactive` + 该用户**，不能是 SYSTEM。这与 §7.5 D1′（中继必须在用户会话里）**独立地指向同一结论**——D1′ 是 GUI 需要，这条是凭据需要。

**坑 3：`shell: true` 触发 DEP0190**

`spawn(cmd, args, { shell: true })` 会警告"args are not escaped, only concatenated"。用 argv 数组方案后此问题自动消失。**这也顺带消除了一个真实的命令注入面。**

**坑 4：`session/prompt` 的返回值不含输出文本**

`result.output` 恒为 `undefined`；`result` 只有 `{ stopReason }`。**assistant 文本必须从 `session/update` 的 `agent_message_chunk` 累积**。`usage_update` 提供 token 用量（可用于从机成本上报）。

#### P0 产出的可复用资产

| 文件 | 作用 |
|---|---|
| `prototype/relay/relay.mjs` | 从机侧 WS↔stdio 中继（Bearer 鉴权 + NDJSON 转发 + 生命周期） |
| `prototype/relay/make-launch-spec.mjs` | 在从机上生成 ACP 启动规格（自动定位安装目录） |
| `prototype/host/client.mjs` | 主机侧 ACP client（流式时间线 + 工具调用观测 + 审批应答） |
| `prototype/host/smoke.mjs` | SDK 导入自检 |

⚠️ 这些是**验证原型**，不是插件代码：没有缓存、没有自检 RPC、没有任务队列、没有审批记忆。

### 10.0.1 ✅ 审批桥接实验：已通过，并暴露一个真实安全缺口

**实验设计**：把从机会话的沙箱设为 `workspace-write`（`DSH_PERMISSION_MODE`），让模型**越出会话工作区**写文件，观察审批请求是否到达主机、主机应答是否有效。

**完整链路（实测）**：

```
[cwd = C:\dsh-remote\p0work]
① [tool_call] title="write" rawInput={"file_path":"C:\\Users\\worker\\p0-approval-test.txt", ...}
② [tool_call_update] status=failed
     Error: [sandbox: file access denied under workspace-write mode]
     [sandbox: escalation available — retry this exact operation once with sandbox_permissions ...]
③ [tool_call] title="write"
     rawInput={..., "sandbox_permissions":"danger-full-access", "justification":"The requested file ... is outside the session workspace ..."}
④ [PERMISSION] request #1                                    ← 跨局域网到达主机
     sessionId = e3598423-...
     toolCall  = {"toolCallId":"call_00_2ErT5SAT4p7ayojP3o8x8480"}
     options   = [allow-once, reject-once]
     => answering allow-once
⑤ [tool_call_update] status=completed → 文件创建成功
⑥ 从机验证：C:\Users\worker\p0-approval-test.txt 存在，内容 APPROVAL_OK
```

✅ **审批桥接成立**：越权 → 沙箱拒绝 → 模型提权重试 → 审批请求跨机到达主机 → 主机应答 → 操作放行。

#### 🔴 但这个实验暴露了一个必须处理的设计缺口

**① 模型会过度申请权限。**

被拒的操作只是「写一个文件到 `C:\Users\worker\`」，而模型申请的是 **`danger-full-access`（最高档）**，不是刚好够用的档位。**申请宽度由模型决定**。

**② 主机的应答是盲目的。**

审批请求实际只携带：
```json
{ "sessionId": "...", "toolCall": { "toolCallId": "call_00_2ErT5..." } }
```
**没有工具名、没有参数、没有 `sandbox_permissions`、没有 `justification`。**

⇒ **后果**：若主机像本原型一样无条件 `allow-once`，那么**第一次越权申请就能拿到全文件系统权限**。模型自选申请宽度，主机却看不到它申请了什么。

#### 对设计的净影响（实证确认了原有设计，并补强一条规则）

| 设计条目 | 实验结论 |
|---|---|
| §5.2「维护 `toolCallId → {toolName, rawInput}` 缓存」 | ✅ **不是优化，是必需品**——主机必须从 `tool_call` 事件里捡回 `sandbox_permissions` 与 `justification`，否则无从判断 |
| §5.2「映射缺失时默认拒绝」 | ✅ **完全正确**——拿不到 `rawInput` 就没有判断依据，必须拒绝 |
| §8.3 ReviewEngine | 🔴 **需补一条硬规则**（见下） |
| 任务级授权优于逐条审批 | ✅ 实证支持：逐条审批时模型会过度申请、主机难判断；任务级声明（"本任务需要写 X 目录"）语义清晰得多 |

**🔴 新增规则（写入 §8.3）**：

> 主机批准前必须做**档位检查**：从缓存的 `rawInput` 取出 `sandbox_permissions`，与**本次操作实际需要的最小档位**比较。**申请档位宽于所需时不得直接批准**——应以 `reject-once` 回绝，并在 diagnostic 里指明"请用最窄的够用档位重试"。
>
> 特别地：**`danger-full-access` 的申请必须要求人工确认**（不能由规则自动放行），因为它是无限制档。

#### 实验环境备注

- 触发条件：会话 `cwd` 的沙箱为 `workspace-write`，操作越过该边界
- 沙箱拒绝的 diagnostic 本身**就指示了模型提权**（`escalation available — retry ... with sandbox_permissions`），所以**这个路径会被模型稳定地走到**，不是罕见情况
- `DSH_PERMISSION_MODE` 通过子进程 env 生效（`dsh-base/cordis.patch.yml:232,248`），已在 `make-launch-spec.mjs` 的 `--permission-mode` 参数里暴露

### 10.0.2 ✅ 插件真机端到端验证：已通过

**在真实从机上跑插件的生产代码路径**（非假 agent、非 stub）：`RemoteProvider` + `AcpBridge` + `decideApproval` + `TaskRegistry` 全部是 `lib/` 里的真实模块。

```
主机 (F:) ──ws://192.168.1.101:7331──> 从机 relay（含 dsh-remote/selfcheck RPC）──> 从机 dsh --profile acp
```

**场景 1：正常任务**

| 检查 | 结果 |
|---|---|
| `dsh-remote/selfcheck` 跨局域网 | ✅ `verdict=ready`，**17/17 全绿** |
| `S8` 活体输入注入 | ✅ `ok` |
| provider 三条硬约束 | ✅ capabilities 全 false / 不继承父上下文 / 无 `prepareContinuable` |
| `run.localAgent` | ✅ `undefined`（C3） |
| 门禁放行 | ✅ |
| 任务完成 | ✅ `stopReason=completed` |
| assistant 输出 | ✅ 从 chunk 累积，含文件内容回读 |
| **工具调用可见** | ✅ `toolCalls=2 recent=[write, read]`，名字已填充 |
| token 用量 | ✅ `usage={used:6392,size:1000000}` |
| 从机侧落地 | ✅ `plugin-proof.txt` 内容 `MADE_BY_PLUGIN` |

**场景 2：真实提权被正确拒绝（P0 发现的漏洞，现在有防御）**

```
[approval] tool=write required=workspace-write -> reject-once (source=tier-check needsHuman=true)
  reason: Requested sandbox tier "danger-full-access" is the unrestricted tier: it always
          requires explicit human confirmation on the host and must never be auto-approved
          by a rule. If this operation only needs the narrowest sufficient tier, retry with
          "workspace-write" instead.
```

链路（从机 relay 日志为证）：
```
← session/update   tool_call  (write, 越出工作区)
← session/request_permission  {toolCall:{toolCallId:...}}
→ {"outcome":{"outcome":"selected","optionId":"reject-once"}}
```

| 检查 | 结果 |
|---|---|
| 产生真实审批请求 | ✅ 1 次 |
| **每一个审批都被拒绝，无一被自动放行** | ✅ `write:reject-once` |
| 越界提权被标记需人工 | ✅ `needsHuman=true` |
| 未误判为缓存缺失 | ✅ `source=tier-check`（`rawInput` 存在） |
| **越界文件未被创建** | ✅ `Test-Path = False` |

**场景 3：配置错误早失败**

| 检查 | 结果 |
|---|---|
| 相对路径 cwd 被拒绝 | ✅ `REMOTE_BAD_CWD`，且**在创建 session 之前** |

#### 真机验证补齐的两个实现缺口

| 缺口 | 说明 |
|---|---|
| **bridge 缺插件 RPC** | 原实现只有 ACP 方法，`index.js` 调用的 `bridge.selfcheck()` 不存在。已补 `callPlugin(method, params)` + `selfcheck(opts)`：实测 SDK 的 `ctx.request()` **只把 method 当字符串发出**，不校验是否属于 ACP 词汇表，所以 `dsh-remote/*` 不需要额外传输层 |
| **脚本输出路径与中继读取路径不一致** | 自检脚本写死 `C:\dsh-remote\selfcheck.json`，中继读「脚本旁」。已改为脚本相对自身 `$PSScriptRoot`，使两者可整体搬移 |

另外自检脚本原先**不输出 `sessionSegment`**，门禁就只能看到 blocking 失败、无法区分「无人登录」与「从机坏了」。已补该字段（`interactive ? 'ok' : 'unavailable'`）。

#### 真机验证仍未覆盖

| 未验证 | 说明 |
|---|---|
| **DSH 插件装载器集成** | 真机测试用的是真实模块 + 独立脚本，**没有经过 `plugin_manager install_bundle`**。工具行（`subagent_remote`）与 provider 注册的装载路径未验 |
| 工作区同步（P4） | 未实现 |
| 人工审批 UI | 未实现（`needsHuman` 当前一律 fail closed 拒绝） |
| 断线重连 / 并发 session | 未验证 |

### 10.1 阶段计划

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0 可行性验证** | 手工跑通：从机 `dsh --profile acp`（stdio）↔ 一个最小 WS 中继 ↔ 主机侧一个最小 ACP client 脚本；发一个 prompt，看到 `session/update` 流，能 `session/cancel` | 一次任务能跑完并拿到输出；能取消 |
| **P1 最小闭环** | 中继 + `RemoteProvider` + `subagent_remote` 工具 + 任务级串行队列 | 主机模型能派单、拿到结果；从机崩溃时主机得到 `stopReason: error` |
| **P2 授权** | 审批桥接 + ReviewEngine（规则 + 任务内记忆）+ 90 秒超时 + 待审批通知 | 从机提权操作能被主机批准/拒绝；超时按拒绝；映射缺失默认拒绝 |
| **P3 可见性** | `TaskRegistry` + `remote_agents` + `remote_interrupt` + 运行时上下文注入 | 模型能查询/等待/打断远程任务；不会"忘记"已派出的任务 |
| **P4 工作区同步** | manifest + blob + 事务性切换 + 路径映射 | 从机能拿到与主机一致的工作区；同步中途失败不留半成品 |
| **P5 审计与 UI** | AuditLog + Settings 页 + 从机「工作节点」页 + 急停 | 能回答"谁批准了什么"；能从从机本地急停 | ⚠️ Settings 页已做（§15）；AuditLog 未做 || **P6 加固** | 协议版本协商、重连与在途任务对齐、磁盘 GC、配额 | 断网重连不产生重复任务；从机重启后状态一致 |

**P0 必须先做**，因为它验证的是整条路线的技术前提（ACP over WS 可跑通）。若 P0 失败，退回自研 `session.event` 中继（只替换 `Transport` 实现，上层不动）。

---

## 11. 未决项与风险

### 11.1 未决项（需要在实现前定）

| # | 问题 | 影响 |
|---|---|---|
| U1 | ✅ **已解决**：远程工具行省略 `agentOptions`/`persona`/`toolFilter` + `maxDepth: 'provider-managed'` + `modelSelectionSettings: false`，即不会触发 capability 校验。**主机可同时保留本地子 Agent 的完整能力**（那是另一行配置） | — |
| U2 | ✅ **已解决**：插件可用 `ctx.tools.register(defineTool({...}))` 注册自定义工具（§5.7）；但 **`subagent_remote` 这一行是否要用户手改 profile patch** 仍未定 | 安装体验 |
| U3 | ⚠️ 从机侧任务队列是否持久化（从机重启后是否恢复排队任务） | 崩溃恢复语义 |
| U4 | ⚠️ 主机重连后如何与从机上在途任务对齐（ACP 缺 `session/load`，只有 `session/resume`） | 断网恢复 |
| U5 | ⚠️ 成败判定规则（§4.4）需实测校准 | 状态显示准确性 |
| U6 | ⚠️ 冷启动成本：每任务是否复用同一条 WS 连接与 ACP session 池 | 延迟 |
| U7 | `remote_agents` 的 `wait` 语义边界（超时、多个任务） | 工具契约 |
| U8 | 从机上是否有"用户手动会话"与"委派会话"并发的冲突处理 | 资源竞争 |
| U9 | ⚠️ 从机是否允许 `sticky` 增量同步（复用同一目录）还是强制 `per-task` 全新目录 | 同步速度 vs 隔离性 |
| U10 | ⚠️ git bundle 的生成与物化细节（`core.autocrlf=false` 已定为约束，但 bundle 失败时的 CAS 降级路径需明确） | 同步可靠性 |
| U11 | ✅ **已解决（已实测）**：`tscon <id> /dest:console`（SYSTEM 身份）把会话移交物理控制台。移交前 `SendInput` 0/3，移交后 **3/3**，且断开 RDP 不再影响。见 §7.7 |
| U12 | ✅ **已解决**：GUI 机制 = `SetCursorPos` + `SendInput` + `WindowFromPoint`。**不需要浏览器/driver/Node** |
| U12′ | ✅ **已端到端验证**：从机实跑 `verify-criteria.ps1` 两场景全绿（见 §7.6）。通用黑盒路子成立，**应用内适配作为可选优化**而非必需 |
| U13 | ✅ **已解决**：不需要 Node |
| U14 | ✅ **已解决**：`python` 是真实解释器（`C:\Python315`，3.15.0） |
| U15 | ✅ x64 与主机一致，无风险 |
| U16 | ⚠️ 被测应用版本是否必须与主机严格一致？（仅当走应用内 API 注入时才严格；`SendInput` 黑盒路子不敏感） |
| U17 | ✅ 实测从机**无**安全软件阻断 `SendInput`（`try 1` 即成功） |
| U18 | ✅ **已解决**：从机改用 **VDD 虚拟显示器，1920×1080@60，主屏在 (0,0)**。重启后自动保持（见 §7.8） |
| U19 | ✅ **已解决**：不再依赖物理显示器。VDD 独立工作，物理显示器可随时给主机用 |
| U20 | ✅ **已解决**：屏保已关（用户配置单元）、睡眠 AC/DC 均为 0、无自动锁屏策略 |
| U21 | ✅ **已决定**：**不配自动登录**。人工开机 + 登录是当前可接受的运维形态（安全优先）。门禁需把「无交互会话」作为独立状态 `no-interactive-session` 呈现，而不是当作故障（见 §5.10.6） |
| U22 | ⚠️ VDD 与 GPU 驱动更新的冲突预案（README 警告可能开机黑屏）——需写入运维文档 |
| U23 | ⚠️ 自检缓存 TTL 的默认值（当前建议 30s）需按实际派单频率校准 |
| U24 | ⚠️ 从机正在执行任务时 S8 跳过（返回 `unchecked`）——需确认是否会影响 T1 门禁判定 |

### 11.2 风险清单

| 级别 | 风险 | 缓解 |
|---|---|---|
| 高 | **零鉴权协议暴露 RCE 面**。ACP 协议无认证，webserver 无鉴权 | 插件自建监听 + Bearer/HMAC + 可选 TLS；从机只接受已配对主机 |
| 高 | **主机成为从机的单点故障**：不答审批 → 从机 turn 永久挂死 | 90 秒超时兜底（§8.4）；此条无现成保护 |
| 高 | **从机被全权放开**（用户手动配 `danger-full-access`）→ 无任何审批、无审查 | 文档明确警告；Settings 页对全权从机显式标注 |
| 中 | ACP 投影有损（无 token 级流式、`kind` 恒为 `other`、`rawOutput` 不填） | 接受；传输层抽象成接口，必要时换自研中继 |
| 中 | 成败不可分辨（`blocked`/`error` → `end_turn`） | §4.4 的判定规则 + 实测校准 |
| 中 | `experimental/*` API 稳定性（SDK 的网络 transport 全在实验入口下） | 集成处隔离一层 adapter |
| 中 | 路径不可移植导致静默失败 | 强制路径一致性（§6） |
| 中 | Windows 防火墙阻断非 loopback 监听（弹 Defender 对话框，取消即静默不可达） | Settings 页给出诊断与指引 |
| 中 | 改插件 JS 必须重启（`hmr.config.root` 被 base patch 显式设为 `[]`；schema 默认其实是 `["."]`） | ⚠️ **缓解措施降级为"待实测"**：把 `hmr.config.root` 指向插件源码目录**未找到任何示例**，且默认 `ignored` 含 `**/node_modules`，而 profile 插件正好在那里。浏览器半边确实可热更（`dsh-client-hmr` 500ms 轮询 + `/plugins/events` SSE） |
| 低 | 从机 token 消耗不可见 | 从机上报用量，主机展示 |
| 低 | 同步把磁盘写满 | 配额 + GC |

---

## 12. 附录

### 12.1 调研报告索引

| 文件 | 内容 |
|---|---|
| `.research/01-subagent-seam.md` | 子 Agent provider 缝契约（权威来源：`lib/typert.host.js`） |
| `.research/02-plugin-and-transport.md` | 插件装配机制、webserver、Typert Remote、传输选型 |
| `.research/03-acp-feasibility.md` | ACP 方法与通知全清单、网络 transport API、可行性裁决 |
| `.research/04-approval-model.md` | 审批/自动审批/权限预设语义、审计面 |
| `.research/05-api-verification.md` | 本文档依赖的全部 API 签名核验 |
| `.research/06-workspace-sync-design.md` | 工作区同步与文件传输设计 |
| `.research/07-slave-recon.md` | **从机 `worker-pc` 实地勘察**：SSH 通道、DSH 版本、会话拓扑、工具链 |
| `.research/08-gui-mechanism-actual.md` | **GUI 测试实际机制（源码级确认）**：`SendInput` 而非 PostMessage、五条从机硬约束、架构分叉 |

### 12.2 权威离线查证源

反编译 bundle 不是最可靠的来源。核验过程中确认两个**权威离线源**，后续实现遇到疑问优先查这两处：

| 源 | 位置 | 价值 |
|---|---|---|
| **全量 Service / Event 签名目录** | `dsh-tool-cordis/lib/types/api-catalog.js`（609 KB） | 等价于 `cordis_inspect_query` 的离线版。查任何 `ctx.*` 服务方法与事件签名 |
| **Cordis 4 真实 TypeScript 源码** | `asar-root/node_modules/@deepseek-ai/cordis/src/*.ts` | 查生命周期、`emit`/`waterfall`/`serial` 的准确语义 |
| **Typert Host FaceModel 类型声明** | 各包 `lib/typert.host.js` | 类型被擦除后唯一的完整接口声明来源 |

⚠️ `Config` 的内省入口**不是 JS API**：是 `cordis_inspect_query` 工具的 `Config` provider / `listConfigs`，要求 `ctx.get('loader')` 存在，且**插件必须用 Schemastery 声明 Config**（`dsh-app-boot/lib/index.js:2163-2166` 要求 `Symbol.for("schemastery") === true`）——**用 zod 声明 Config 会得到 `status: "unsupported"`**。

⚠️ SDK 的 `.d.ts` **全部缺失**，ACP 侧类型只能从 `.js` + JSDoc + `schema.json` 反推。

### 12.3 关键源码位置速查

| 主题 | 位置 |
|---|---|
| **全量 Service/Event 目录** | `dsh-tool-cordis/lib/types/api-catalog.js` |
| **Cordis 4 TS 源码** | `asar-root/node_modules/@deepseek-ai/cordis/src/*.ts` |
| provider 契约 | `dsh-subagent/lib/typert.host.js:758-767` |
| 进程外 helper | `dsh-subagent/lib/types/out-of-process.js`（**从包根 import**） |
| provider 注册 | `dsh-subagent/lib/index.js:3076-3087` |
| 能力逐项校验 | `dsh-subagent/lib/index.js:3173-3194` |
| catalog 写入条件 | `dsh-subagent/lib/index.js:3130-3141` |
| `dsh-tool-subagent` Config | `dsh-tool-subagent/lib/index.js:252-270` |
| 工具 → provider 翻译 | `dsh-tool-subagent/lib/index.js:509-520` |
| provider 配置校验（会回滚注册） | `dsh-tool-subagent/lib/index.js:369-386` |
| 工具注册范例 | `dsh-tool-subagent/lib/index.js:173-196`、`dsh-tool-jobs/lib/index.js:297-360` |
| 投影注册范例 | `dsh-permission-presets/lib/types/index.js:159-166`、`dsh-subagent/lib/types/projection.js:38-88` |
| job start / run | `dsh-jobs-local/lib/index.js:527-534` |
| ACP 审批桥 | `dsh-acp/lib/index.js:1116-1139` |
| ACP stdio 硬编码 | `dsh-acp/lib/index.js:1319` |
| ACP stopReason 映射 | `dsh-acp/lib/index.js:539-551` |
| ACP 拒绝 additionalDirectories | `dsh-acp/lib/index.js:1410-1413` |
| SDK client builder | `SDK/dist/acp.js:852-854`、`SDK/dist/examples/ws-client.js:44-68` |
| WS 只处理文本帧 | `SDK/dist/ws-stream.js:6-9, 110`、`ws-utils.js:24-39` |
| Auto review 决策 | `dsh-experimental-auto-review/lib/index.js:480-484` |
| 免审批条件 | `dsh-sandbox/lib/index.js:101` |
| Cordis emit 语义 | `cordis/src/events.ts:194-196` |
| webserver route | `dsh-host-webserver/lib/index.js:139-226` |
| 插件 import 拦截 | `dsh-app-boot/lib/index.js:1459-1497` |

---

## 13. 附录 B：P0 原型接口契约

> P0（§10.0）验证通过后固化的接口契约。**实现插件时直接参照这一节**，不必重读原型代码。
> 可运行原型：`prototype/relay/{relay.mjs,make-launch-spec.mjs}`、`prototype/host/{client.mjs,smoke.mjs}`。

### 13.1 ACP 启动规格（`agent-spec.json`）

**复刻 `dsh.cmd`，用 argv 数组直接 spawn。** 绝不从 Node spawn `.cmd`（§10.0 坑 1）。

```jsonc
{
  "command": "<install>\\DeepSeek Harness.exe",
  "args": ["--expose-internals",
           "<install>\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js",
           "--profile", "acp"],
  "env": { "ELECTRON_RUN_AS_NODE": "1", "DSH_PERMISSION_MODE": "<optional>" }
}
```

| 要点 | 说明 |
|---|---|
| `command` | **Electron 可执行文件**，不是 `dsh.cmd` |
| `cli.js` 路径 | 在 `app.asar` **内**；`fs.existsSync` 返回 false，但 Electron 能读 ⇒ **不要用存在性校验它** |
| `env.ELECTRON_RUN_AS_NODE` | 必须 `"1"`，否则 Electron 会尝试开窗口 |
| `env.DSH_PERMISSION_MODE` | 可选；`read-only` / `workspace-write` / `danger-full-access`。**决定这个会话是否会产生审批请求** |
| 生成 | `make-launch-spec.mjs`（自动定位安装目录，硬编码候选路径优先，因为 SYSTEM 下 `LOCALAPPDATA` 指向 systemprofile） |

### 13.2 中继（slave 侧）

| 项 | 规格 |
|---|---|
| 监听 | `0.0.0.0:<port>`（默认 7331），**必须自建 HTTP server**（`acp` profile 无 `dsh-host-webserver`） |
| 鉴权 | `Authorization: Bearer <token>` 或 `?token=`，`timingSafeEqual` 比较；**无 token 时拒绝启动**（除非 `--allow-no-auth`） |
| 健康检查 | `GET /healthz` → `{ ok, dsh, auth }` |
| 一连接 | **一子进程**；WS 或子进程任一结束都双向拆除 |
| 帧格式 | **NDJSON 文本帧**。二进制帧必须显式丢弃并告警（ACP WS transport 会**静默丢弃**二进制，见 §6.6） |
| 拆分 | 按 `\n` 切行，只转发完整行（子进程 stdout 可能半行到达） |
| 运行身份 | 🔴 **拥有 DSH 凭据的用户**（`LogonType Interactive`），**不是 SYSTEM**（§10.0 坑 2） |

### 13.3 ACP 消息流（主机驱动一次任务）

```jsonc
// 1) initialize
→ {"jsonrpc":"2.0","id":N,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
← {"result":{"protocolVersion":1,"agentInfo":{"name":"deepseek-harness-acp","version":"0.0.1"},
             "agentCapabilities":{"sessionCapabilities":{"close":{},"list":{},"resume":{}},
                                  "promptCapabilities":{"image":false,"audio":false,"embeddedContext":false}},
             "authMethods":[]}}

// 2) session/new   (cwd 必须绝对路径；additionalDirectories 会被 DSH 拒绝 -32602)
→ {"method":"session/new","params":{"cwd":"<abs>","mcpServers":[]}}
← {"result":{"sessionId":"...", "configOptions":[...]}}

// 3) session/prompt   (阻塞直到 turn 结束)
→ {"method":"session/prompt","params":{"sessionId":"...","prompt":[{"type":"text","text":"..."}]}}
← {"result":{"stopReason":"end_turn"}}        // ⚠️ 无 output 字段

// 4) 流式：服务端 →客户端通知
← {"method":"session/update","params":{"sessionId":"...","update":{...}}}

// 5) 审批：服务端 →客户端请求（客户端必须应答，否则从机 turn 永久挂起）
← {"method":"session/request_permission","id":M,"params":{
     "sessionId":"...",
     "toolCall":{"toolCallId":"..."},                      // 🔴 只有 id！无工具名/参数/档位
     "options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},
                {"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}}
→ {"id":M,"result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}
//  「拒绝」= 任何非 allow-once 的 optionId；取消 = {"outcome":{"outcome":"cancelled"}}

// 6) session/close（可选，DSH 支持）
→ {"method":"session/close","params":{"sessionId":"..."}}
```

### 13.4 `session/update` 变体（DSH 实际发出的 6 种）

| `sessionUpdate` | 载荷 | 实测要点 |
|---|---|---|
| `agent_message_chunk` | `content:{type:'text',text}` | **assistant 正文只能从这里累积**（`prompt` 的 result 无 output） |
| `agent_thought_chunk` | `content:{type:'text',text}` | reasoning |
| `tool_call` | `toolCallId,title,kind,status,rawInput,rawOutput?,locations?` | **`title` = 工具名**；`rawInput` = 完整参数 JSON；`kind` 恒 `"other"`；**`rawOutput`/`locations` 恒 undefined** |
| `tool_call_update` | `toolCallId,status,content?` | `status ∈ pending\|in_progress\|completed\|failed`；**结果在 `content` 文本块里** |
| `usage_update` | `used,size` | token 用量 → 从机成本上报 |
| `config_option_update` | `configOptions` | 模型选择变化 |

**`toolCallId → {title, rawInput, status}` 缓存是必需品**（§8.3 档位检查的唯一数据来源）。

### 13.5 停止原因与失败判定

`stopReason ∈ {end_turn, max_tokens, max_turn_requests, refusal, cancelled}`。

⚠️ DSH 把 `blocked`/`error` **都映射成 `end_turn`**（`dsh-acp/lib/index.js:539-551`）。**失败检测必须用传输层**：`session/prompt` 的 JSON-RPC **error** 才是真失败，例如：

```json
{"id":N,"error":{"code":-32603,"message":"Internal error: turn failed: llm-deepseek: no API key ..."}}
```

⇒ 主机的 `stopReason` 映射：**prompt reject → `error`**；`cancelled` → `aborted`；`refusal` → `refusal`；否则 `completed`。

### 13.6 启动规格与凭据的实测约束（汇总）

| # | 约束 | 出处 |
|---|---|---|
| 1 | 不 spawn `.cmd`，spawn Electron + argv 数组 | §10.0 坑 1 |
| 2 | 中继以拥有凭据的用户身份运行 | §10.0 坑 2 |
| 3 | 启动规格显式落盘，不靠 env 推导安装目录 | §10.0 坑 1 |
| 4 | `result.output` 不存在，输出从 chunk 累积 | §10.0 坑 4 |
| 5 | 审批请求只带 `toolCallId` → 必须自建 `rawInput` 缓存 | §10.0.1 |
| 6 | 档位检查：申请宽于所需则拒绝；`danger-full-access` 必须人工确认 | §8.3 |
| 7 | 无审批应答 → 从机 turn 永久挂起 → 主机必须实现超时 | §8.4 |

---

## 14. 部署后发现的三个上游缺陷与由此产生的安全态势

前三节都是本插件自身的问题；这一节是**在真实从机上部署后，发现 DSH 本身的三处缺陷**，以及它们如何改变了本设计的实际安全边界。

### 14.1 🔴 `dsh-acp-app` 的模型 id 写错，导致图片能力被静默关闭

```yaml
# dsh-acp-app/cordis.patch.yml —— dsh --profile acp 用的就是它
- id: acp
  name: '@deepseek-ai/dsh-acp'
  config:
    provider: deepseek-official
    model: deepseek-v4-flash      # ← 目录里没有这个 id

# dsh-llm-deepseek 的模型目录
{ id: "deepseek-flash", name: "DeepSeek-V41-Flash", inputModalities: ["text", "image"] }

# dsh-base 的同一项是正确的
      config:
        model: deepseek-flash
```

**一个错字同时关掉三件事**（都实测确认）：

| 后果 | 证据 |
|---|---|
| `initialize` 报 `promptCapabilities.image: false` | `supportsAcpImagePrompts()` 解析同一 id 失败 → **主机无法向从机发图** |
| 从机 `read_image` 全部失败 | `read_image` 报 `model "deepseek-v4-flash" does not declare image input` |
| 上下文窗口 / 推理档位元数据缺失 | `resolveModelInfo` 拿不到 |

**修法**：从机 `profiles/acp/cordis.patch.yml` 覆盖 `acp` 行的 model 为 `deepseek-flash`。修好后从机立刻能读图——实测它能准确描述一张探针图（"red/green/blue 三条竖带 + 绿带中央黑圆"）。

**为什么对本项目关键**：从机的**视觉验证能力**是 GUI 测试的核心。这个 bug 让它完全不可用。

⚠️ **一个方法论教训**：我最初据此得出"直接走 ACP 图片路径不可行"的结论并写进了文档。**那是错的**——真实原因是 id 不匹配。教训是：**当错误信息给出一个具体的技术理由时，要去验证那条理由的**前提**，而不是接受它**。

### 14.2 🔴 Windows 沙箱让从机完全没有可用 shell

```
dsh-sandbox-local:  PLATFORM_CHAINS.win32 = ["windows-acl"]     ← 只有一个候选
                    STATIC_ENFORCEMENT["windows-acl"] = "partial"
```

注释明说：**"the product never probes"**（单一候选的链不做探测，直接选用）。而那个 runner：

> creates the **WRITE_RESTRICTED** token ... spawns the wrapped argv under it

**在这台机器上，任何经该路径创建的进程都在初始化阶段死掉**：

```
whoami            → (no output)  exit 3221225794 = 0xC0000142 STATUS_DLL_INIT_FAILED
echo shell-works  → (no output)  同上
```

**排除清单**（逐项实测，不是推断）：

| 猜测 | 结论 | 依据 |
|---|---|---|
| 执行策略未放开 | ❌ | `LocalMachine=RemoteSigned`；且 `0xC0000142` 是进程初始化失败，**根本没走到检查策略**。若真是策略问题会看到"未数字签名"报错 |
| 杀软（火绒 HIPS）拦截 | ❌ | **边跑边截图 19 帧**，全程无弹窗 |
| pwsh 安装损坏 | ❌ | 在交互会话里连续 12 次全部成功（277–358ms） |
| 工作目录错误 | ❌ | 修好 `process.cwd()`（原为 `C:\Windows\System32`）后仍失败 |
| **Windows 沙箱** | ✅ | `DSH_PERMISSION_MODE=danger-full-access` 绕过沙箱后立刻正常 |

**采用的处理**：**已修好**，见 §14.3。

### 14.3 ✅ 沙箱已修好，边界已恢复（并实测验证）

#### 根因：mediator 是 GUI 子系统镜像，拿不到控制台

`dsh-sandbox-local` 用 **`process.execPath`** 作为 mediator 解释器。在本部署里那是
**`DeepSeek Harness.exe`（GUI 子系统）**，而 **Windows 从不为 GUI 子系统镜像自动分配控制台**。
于是 runner 创建的 `WRITE_RESTRICTED` 子进程**没有任何控制台可继承**，在 DLL 初始化阶段就死掉
——`0xC0000142`，零输出。**每一条 shell 命令都失败。**

#### 实测证据（本机，runner 从 asar 提取，同参数，只换解释器；8/8 有效运行）

| mediator | read-only + `cmd /c exit 0` | workspace-write + `pwsh` |
|---|---|---|
| **`node.exe`（控制台子系统）** | ✅ exit 0 | ✅ exit 0，子进程输出正常 |
| **`DeepSeek Harness.exe`（GUI 子系统）** | 🔴 `0xC0000142` | 🔴 `0xC0000142` |

#### 修法：`runnerCommand` 指向一个翻译 shim

**不能**直接把 `runnerCommand` 指向 windows-acl runner —— `confine()` 会**无条件**给它前置
`bwrapProfileArgs(policy)`（bubblewrap 方言：`--ro-bind`/`--bind`/`--tmpfs`），runner 会以
`windows-acl-run: unknown argument: --ro-bind` 拒绝。`runnerCommand` 是"运维断言这是 bwrap 兼容
runner"的路径，**不是**替换 win32 rung 的开关。

因此 `shim.mjs` 被命名为 runner 并负责翻译两个方言。**它被 `node.exe` 启动正是关键** ——
控制台子系统镜像会被自动分配控制台，而那正是受限子进程需要的。shim 再以 `node.exe`
启动真正的 runner，使用 runner 自己的 argv 契约。

两个文件都不能放在 `app.asar` 里：普通 `node.exe` 没有 asar 支持。所以由
`extract-mediator.mjs`（**必须在 Electron-as-node 下运行**，因为只有 Electron 能读 asar 内部）
把 runner 及其**依赖闭包**落盘到真实目录。

⚠️ 注意 `fs.cpSync` **不能**从 asar 拷贝（即使 `readdirSync`/`statSync` 在同一路径上成功，
它仍报 `ENOENT ... not found in <asar>`）；必须用 `readFile`+`writeFile` 手工递归。
而 koffi 的原生库在**独立包** `@koromix/koffi-win32-x64` 里，位于 **`app.asar.unpacked`**
（Electron 会把 `.node` 解包到 asar 之外）。

#### 修好后的实测结果

```
whoami           → ERROR: Access is denied.  exit 1     ← 受限令牌拒绝（沙箱真实生效的证据）
echo shell-works → shell-works                exit 0     ← 命令能跑
Get-Location     → C:\dsh-remote\p0work       exit 0

工作区内写入 sandbox-inside.txt        → ✅ 成功
工作区外写入 C:\Users\worker\...txt     → 🔴 [sandbox: file access denied under workspace-write mode]
```

#### 完整闭环（P0 漏洞的最终闭合）

| 步骤 | 实测结果 |
|---|---|
| 1. 沙箱拒绝越界写入 | ✅ |
| 2. agent 提权重试 `danger-full-access`（与 P0 时同样的过度申请） | ✅ |
| 3. 审批请求跨局域网抵达主机 | ✅ 主机 `bridge.approvals = 1` |
| 4. **审阅引擎拒绝**（§8.3 档位检查） | ✅ `rejected` |
| 5. 文件未创建、agent 停止（fail-closed） | ✅ 从机 `outside-absent` / `escalation-absent` |

⇒ **§7.5「真正的边界是从机沙箱」这条设计前提现已成立。** 而且 P0 里被无脑客户端自动放行的
那个越权申请，现在**被沙箱逼成审批请求、再被档位检查拒绝**——两层防御都真实存在。

**已知争议点**（外部报告未复现，仅是分析）：`AllocConsole()` 在 runner 内调用也能修好，
那是更干净的上游修法（shim 是变通）。上游 `deepseek-ai/deepseek-harness` 关闭了 issue、
不接受外部 PR，文档渠道是 GitHub Discussions。

### 14.3.2 同一缺陷在**主机**上的复现 —— 关键在于"有没有控制台"

第 4 项（对称配对 / 角色配置）的前提是"**本机沙箱可用**"。为此复查了主机，结论比预想的细分：

#### 事实一：主机是同一个 DSH 构建，`process.execPath` 同样是 GUI 子系统

```
DeepSeek Harness.exe   PE subsystem = 2  (GUI，Windows 不自动分配控制台)
node.exe               PE subsystem = 3  (Console)
```

#### 事实二：**从有控制台的进程启动时，缺陷不复现**（这是我第一次测错的地方）

我最初直接用 `cmd /c` 起 `DeepSeek Harness.exe` 跑 runner，**成功了**。原因不是缺陷不存在，
而是**运行我的 pwsh 自己有控制台**（实测 `GetConsoleWindow() != 0`），控制台被一路继承下去。

> **教训**：缺陷不是"GUI 子系统"这一个属性决定的，而是"**该进程有没有控制台**"。
> 只看子系统就下结论，会得到一个**方向相反**的判断。

#### 事实三：用真实上下文（计划任务，无控制台）**复现了**

同一 runner、同一参数、**同样无控制台**，只有解释器不同：

| 解释器 | 结果 |
|---|---|
| `DeepSeek Harness.exe` (GUI) | **exit 127** · `windows-acl-run: GetStdHandle failed (Win32 0): null stdin handle` |
| `node.exe` (Console) | **exit 0** · `node-child-alive` |

**症状与从机不同**（这里是 `null stdin handle`，从机是 `0xC0000142`），**根因相同**：进程没有控制台，
标准句柄拿不到。

#### 结论：主机**交互式**沙箱是好的，**服务式**沙箱会坏

| 主机的角色 | 启动方式 | 沙箱 |
|---|---|---|
| 交互式主机（现在） | 用户从桌面/终端启动，**有控制台** | ✅ 可用 |
| **作为从机**（第 4 项要走的路） | 计划任务启动，**无控制台** | ❌ **会坏** |

所以主机这一侧的 shim 是**针对"主机作为从机"这一角色的真实修复**，不是预防性配置。

#### 主机侧的部署物

```
C:\dsh-sandbox-mediator\          1304 文件 / 13.3 MB
  shim.mjs                        与从机同一份（.research/sandbox-mediator-shim.mjs）
  node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js
  node_modules\@koromix\koffi-win32-x64\...\koffi.node
  ...
```

由 `.research/extract-mediator.mjs` 在 **Electron-as-node** 下物化（`node.exe` 读不了 app.asar）。
**DSH 升级后必须重跑**，否则这个 mediator 驱动的是上一版的 runner。

配置写在 `C:\Users\you\.dsh\profiles\desktop\cordis.patch.yml`（原文件已备份为
`.bak-before-sandbox-shim`），**需要重启 DSH 才生效**。

#### 两个验证脚本（都可参数化，主机与从机共用同一份）

| 脚本 | 断言 |
|---|---|
| `validate-shim.ps1` | shim 的**方言翻译**：workspace-write / read-only 两种 bwrap 形态都能跑；未知 flag 与缺失 `--` **必须硬失败**（4/4） |
| `validate-sandbox-confinement.ps1` | shim **真的在限制**：工作区内可写、工作区外被拒且无残留、read-only 连工作区也不可写、read-only 仍可读（5/5） |

> **一个我写错又被自己抓到的探针**：最初用 `whoami` **失败**当作"受限令牌生效"的判据。
> 但 Windows 的 rung 造的是 `WRITE_RESTRICTED`，**只限制写**——读自己的进程身份照样成功。
> 实测 `whoami` 返回了 `host-pc\dev`，而**限制是正常工作的**。这个探针会把健康的沙箱
> 报成坏的。从机那次 `whoami` 失败，应该是**只读模式**（`--ro-bind / /` 连读也限制）的症状。
> 真正的判据是"工作区外写入被拒且无残留"。

### 14.3.1 若沙箱再次不可用时的降级路径
`danger-full-access` 仍然可用，但**必须知道代价**（这是实测，不是推测）：沙箱关闭后
**审批链路整条失效**——因为触发点是"沙箱拒绝 → 提权 → 审批请求"：

```
实测：danger-full-access 下写入 C:\Users\worker\approval-probe.txt → 成功
      无审批提示、无沙箱拒绝标记
```

即使把 `approval.policy` 钉成 `ask` 也一样，因为**没有沙箱拒绝就没有 escalation**。
此时安全模型退化为：门禁 ✅ / 档位检查 ❌ 不触发 / 审批桥 ❌ 不触发 / **prompt 是唯一实际边界**。

### 14.4 部署期暴露的插件自身缺陷（已修）

| 缺陷 | 后果 | 状态 |
|---|---|---|
| 工具 `parameters` 用作者简写直接注册 | **4 个工具全部不可用**（`type: null`）——`ctx.tools.register` 不转换 `parameters` | 已修 + 变异测试 |
| 从未调用 `bridge.connect()` | **自检与派单整条路径不通** | 已修 + 15 条测试 |
| 兜底报告写 `sessionSegment: 'unavailable'` | **从机不可达被误报为"没人登录"** | 已修 + 回归测试 |
| 中继启动器未设工作目录 | ACP 的 `process.cwd()` 是 System32，而沙箱 `workspaceRoot: process.cwd()` | 已修 |
| relay 重启后首次调用必失败 | bridge 无心跳，死 socket 要等一次失败才发现 | **已知未修**（第二次调用自愈） |

**共性教训**：前两条都是**测试覆盖的接缝**漏掉的——单测用预先连好的假 bridge、冒烟测试只挂载不连从机、真机测试自己建桥。补上 `plugin-live.mjs`（已安装位置 + 真实 `apply()` + 真实从机）后，这两个 bug 都跑不掉。

---

## 15. Settings 页（P5 第一步）

### 15.1 为什么这样接

DSH 里第三方插件挂设置页的契约（从同机另一个插件 `dsh-plugin-notify` 的工作实现读出，非猜测）：

```jsonc
// package.json —— 两处缺一不可
"exports": { "./client": "./lib/client.js" },
"dsh": { "client": { "platform": "web" } }
```

```js
// lib/client.js —— 纯模块工厂，无构建步骤，React 取自浏览器模块表
window.__ModuleLoader__.load({
  id: '<包 id>',
  factory(require) {
    const React = require('react'); const h = React.createElement
    const inject = ['slots', 'locale']
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: '<插件 id>', order: 45,
        label: () => t('nav'), locale: NS,
      }, Section))
    }
    return { inject, apply }
  },
})
```

`dsh-client-modules` 从**已装载的 Loader 条目**里扫描 `dsh.client`，bundle 服务在
`/plugins/<entry.id>/client.js`（`PLUGIN_ROUTE = "/plugins"`，`kind: "prefix"`）。

⚠️ **声明写错会让 fiber 响亮失败**：该扫描在服务构造时同步执行，"a malformed declaration
or missing bundle … aggregates into one loud throw (FAILED fiber)"。所以这不是装饰性配置。

### 15.2 页面内容（本轮范围）

| 区块 | 数据来源 |
|---|---|
| **可用状态** | 每个工作节点一张卡：verdict 徽标、`sessionSegment`、连接态与重连/审批/心跳失败计数、检查计数 |
| **检查明细** | 默认只列**非 pass** 项（失败是运维打开此页的原因），可展开全部 |
| **诊断** | 每节点：重新自检（`maxAgeMs: 0`，强制新鲜）、截图、连接测试 |
| **任务** | `registry.list()`，活动态用橙色点标记，等待审批单独标注 |
| **急停** | 打断所有在途任务；每任务独立捕获失败，一个失败不会中断其余 |

**host 侧**：`GET` 返回快照；`POST` 执行 `selfcheck` / `screenshot` / `interrupt` / `ping`。
每个失败都返回 `{ ok: false, error }` 而非抛出 —— 抛出去只会让页面拿到一个没有内容的 500。

### 15.3 本机角色：**只显示，不提供开关**

「本机在主/从之间切换（对称配对）」是**选定方向**，但它是与"管理已知工作节点"不同的风险等级：
让本机可被远程驱动需要自己的安全论证。因此本页**只陈述当前角色**，不放一个点了没用的控件 ——
一个死的开关比没有开关更糟。

### 15.4 ⚠️ 未验证的部分（必须说清）

**本轮只验证到"DSh 之外"的边界**，因为 `dsh-client-modules` 的包元数据**永久缓存**：

```js
resolveMeta(loaderName, baseUrl) {
  const cached = this.pkgMeta.get(sourceKey);
  if (cached !== void 0) return cached;     // 命中即返回
```

`pkgMeta` 在全文件中**从不被清除**。本插件的 `package.json` 在 DSH 启动时被扫描过，当时还没有
`dsh.client`，于是 `null` 被永久缓存 ⇒ **必须重启 DSH 才能发现客户端半边**。

已验证（204/204 测试，`test/settings-page.test.js` 15 条）：

| 已验证 | 方式 |
|---|---|
| `package.json` 声明符合 `parseDshClient` 要求 | 读真实 manifest 断言 |
| 客户端工厂可加载、`inject`/`apply` 形状正确 | 用桩 `window.__ModuleLoader__` 跑真实文件 |
| 恰好注册一个 `settings.section`，id/order/locale 正确 | 断言注册调用 |
| 中英词典均被注册 | 断言 `locale.register` |
| **组件能渲染出树**（含工作节点行、任务行、畸形数据不崩） | 最小 React 桩 + 组件展开 |
| 路由 GET/POST 各动作、错误路径、`no-store` | 假 req/res |

**未验证**：DSH 真的把该 bundle 服务在 `/plugins/dsh-plugin-remote-use/client.js`，以及设置页真的出现。
这一步**必须重启 DSH**，且因 `/plugins` 前缀需浏览器认证（令牌只由 `dsh web` 打印，不落盘），
只能由人在界面上确认。

### 15.5 测试桩踩到的两个坑（同类错误第三次出现）

| 坑 | 症状 | 原因 |
|---|---|---|
| `loadClient()` 不调 `apply()` | 4 条渲染测试全挂 | 注册发生在 `apply` 里，不调就得到空注册表 |
| `createElement` 不调用函数组件 | "工作节点行渲染"失败，而内联任务表通过 | `h(WorkerCard)` 只是建元素；组件从未执行 |

第二个尤其值得记：**它表现为"某个用例失败、相邻用例通过"**，很容易被误读成"数据问题"而不是"测试桩缺了一步"。

### 15.6 首次真机使用暴露的缺陷（已修，需下次重启生效）

设置页确实出现了（客户端注册契约成立），但工作节点列表显示**「尚未配置工作节点」**——而路由
明明返回 1 个 worker。真实原因：

```
GET → peer.selfcheck() → ensure() → TCP connect 到不可达主机
    → 等完整的连接超时（实测 21.1 秒）
```

这 21 秒里浏览器渲染的是 `snapshot === null` 的**初始态**，而初始态被写成了「尚未配置工作节点」。

⇒ **把"还不知道"自信地报成"没有"。** 与 §14.4 是同一类错误，只是换了一层。

**修了两处**：

| 层 | 修法 |
|---|---|
| 客户端 | 三态区分：`snapshot === null` → 「正在读取…」；已加载且为空 → 「尚未配置」；有节点 → 卡片。另加：单个 worker 无报告时显示「就绪报告未在限时内取得」而非空白 |
| Host | 页面加载的就绪探测加 **4 秒预算**（`REPORT_BUDGET_MS`），超时则 `report: null` + 明确原因；连接状态**不受预算影响**立即返回。显式「重新自检」用更长的 25 秒预算（用户按了按钮且在等） |

**关键设计点**：链接状态**立即可知**，就绪报告不是。原实现把两者绑在一起，让一次页面加载
为一个 TCP 超时买单。

**验证**：`test/settings-page.test.js` 增至 20 条，含 3 条针对性回归（探测挂起时 GET 仍返回 worker 行、
显式自检预算更长、超时作为超时而非故障上报）。

⚠️ **生效仍需重启 DSH**：`lib/index.js` 在启动时被 import，cordis 的热重载只覆盖配置变更。
**客户端 `lib/client.js` 与 Host `lib/index.js` 的生效时机不同**——这一差异本身值得记住。

### 15.7 配对管理：配置可写，且**保存即生效**

首次真机使用后补上：工作节点原先只能在 profile 补丁里手改 YAML，每次改动都要重启。

#### 配置来源与优先级

```
defaults  <  profile 补丁  <  设置文件
```

设置文件：`$DSH_HOME/storages/dsh-plugin-remote-use/settings.json`，**只对它实际包含的键生效**。
**不存在时行为与从前完全一致**（所以从未打开过本页的安装不受影响）。

| 决定 | 理由 |
|---|---|
| **不回写 profile 补丁** | 那是用户手写的带注释 YAML，程序化写入会毁掉排版 |
| **`workers` 是替换而非合并** | 合并会让"从页面删除一个节点"无法表达 |
| **只在首次保存时才创建文件** | 读取不产生副作用；保存时把当前生效值整体写入，不会丢东西 |

#### token 绝不回传浏览器

页面只拿到 `tokenSet` 与掩码提示（如 `••••••UpS0`），只能**写**不能读。
worker token 是远程执行的凭据；把它发到网页会落进 devtools、内存、以及任何一张屏幕截图里，
而页面**根本不需要显示它**。空白 token 字段的语义是"保持原值"——这也让重命名节点不必重输凭据。

#### 保存即生效（无需重启）

`ctx.effect` **返回自己的 disposer**，所以接线可以按需撤销，而不是只能等 fiber 销毁。
`reconfigure()` 按 `peerId` 差量：新增接线、移除解开、连接参数变化则重建。
`PeerConnection` 在构造时就捕获 url/token/httpBase，所以改了就必须重建而不能原地改。

**审批策略或心跳变化会重建全部节点**，因为运行中的 approval decider 在构造时解构了 `cfg`。
重建同时丢弃已记住的审批——这是**想要**的行为：在旧策略下做出的决定不应静默延续到新策略。

#### 顺带修掉的一个潜伏 bug

`memories` 原先是一张按 `taskId` 键的**共享**表，而每个 worker 的清理执行 `memories.clear()`。
在"运行时永不摘下 worker"的前提下这无害；一旦支持动态重配，它就会**清空其他所有 worker 的审批记忆**，
让审阅引擎忘掉已经做过的决定。改为**每个 worker 独享一张表**，让这个错误在结构上不可能发生。

#### 验证

`test/settings-store.test.js`（19 条）覆盖优先级、掩码、原子写入、增删改；
`test/apply-config.test.js`（13 条）**真正调用 `apply()`**（配一个仿真 Cordis context），
覆盖差量重配、策略重建、以及"任何响应都不得含 token"。

⚠️ 这个集成测试是补上**测试接缝**的第三次尝试：此前两次交付的 bug（从未调用 `connect()`、
工具 schema 不可转换）都是因为没有任何东西跑真实的 `apply()`。

### 15.8 ⚠️ 测试写进了操作者的真实目录（已修，事故已清理）

给 `apply()` 写集成测试时，测试用 `withEnv` 保存/恢复 `process.env.DSH_HOME`：

```js
function withEnv(fn) {                    // 错误版本
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = tempDir
  try { return fn(tempDir) }              // ← 没有 await
  finally { process.env.DSH_HOME = previous; rmSync(tempDir) }
}
```

有一个测试是同步调用它的，于是 `finally` 在异步 `worker.save` **还在飞行时**就把 `DSH_HOME`
恢复成了真实的 `C:\Users\you\.dsh` ⇒ **测试夹具被写进了操作者的真实设置文件**：

```json
{ "workers": [{ "id": "w1", "url": "ws://10.0.0.1:7331", "token": "token-w1" }] }
```

**危害不是"测试脏了数据"，而是下次重启时设置文件优先于 profile 补丁** —— 那台真实的从机
会从配置里消失，而现象是"从机不见了"，与测试毫无关联。

**当时只看到 `generated asynchronous activity after the test ended` 这条警告**，把 `withEnv`
改成 `await` 就消失了 —— 但文件已经写下。**警告消失 ≠ 副作用消失。**

**修法不是"记得 await"，而是让它在结构上不可能**：整个文件在**模块加载时**把 `DSH_HOME`
指向一个临时目录并**永不恢复**，`withEnv` 只负责清理设置文件。这样任何异步时序都无法到达真实主目录。
另加一条守卫测试，断言 `DSH_HOME` 确实在临时目录下。

**教训**：测试装置是**会写用户目录的代码**，必须按这个标准要求它。

### 15.9 设置页图标

原先导航里是**默认齿轮**（`package.json` 没有 `icon` 字段）。契约在 `dsh-app-boot` 的 `readPluginMeta`/`iconOf`：

| 要求 | 说明 |
|---|---|
| **相对路径** | 绝对路径或带 scheme 一律抛错 |
| 扩展名 | `.svg` / `.png` / `.jpg` / `.jpeg` / `.webp` |
| **必须在包目录内** | `realpath` 后不允许逃出 manifest 目录 |
| 大小 | ≤ 256 KiB |
| 消费方式 | **读取并以 base64 内联为 `data:` URL** ⇒ 图标必须自包含，不能引用外部资源 |

**契约说明**：图标集是**纯描边**（`fill="none"`），而 Win98 那种前后遮挡靠的是**不透明填充**。
但设置页有深色与浅色两套主题，写死背景色会在另一套下露出色块。

⇒ **改为几何上断开被遮挡的路径**：后面那台只画可见部分 —— 路径从前面那台的边缘穿过它的点
`(42,30)` 开始，绕过顶部，到 `(28,22)` 前面那台盖住它的地方结束。
**没有东西被遮住，因为被遮住的部分根本没画。**

#### 造型：前后叠放，各带底座（**没有连线**）

初版在左下画了一根直角折线（"网络线"）。**评审后删掉了**：它在 17px 下读起来不是连接，
而是一根**没有来由的尾巴**；而且它把构图往左下拽，去掉后整体回到视口中心（描边后 x 8..56、
y 8..54，中心正好 `(32,31)`）。两台各自的底座已经足够说明"这是两台电脑"。

后面那台的底座必须**偏右**（`x=48`，而它屏幕中心在 `x=41`）—— 居中的话会被前面那台完全盖住，
等于没画。

#### 方法：小尺寸可读性必须按**真实 1x 像素**判断

这一条值得单独记。判断图标在 17px 下能否辨认，靠"按比例推"是**不可靠的**：

| 做法 | 结果 |
|---|---|
| 看 64px 渲染 | 四个候选**都好看**，无法区分 |
| 看 32px | 差异仍然不明显 |
| **无头 Edge 以 `device-scale-factor=1` 渲染 17px，再用 Pillow 最近邻放大 8 倍** | **一眼看出**并排方案糊成两个小团、叠放方案清晰、某候选的左下折线成了噪点 |

具体命令：`msedge --headless --force-device-scale-factor=1 --screenshot=... <html>`，
然后 `Image.resize(..., Image.NEAREST)`。

⚠️ 注意**不要**用 `--force-device-scale-factor=8` 去看小图标：那会让浏览器以 136px 矢量渲染再缩小显示，
得到的是"理想情况"而非用户实际看到的像素。

### 15.10 图标"明明对却不显示"——三个层次，前两层的结论都曾经是错的

首次真机使用后：**设置导航图标没变**。

#### 第一层：设置导航的图标**不是插件提供的**（⇒ 改不了）

`dsh-client-ui-settings-general` 的 `navIcon(id)` 是一张**写死的表**：

```js
if (id === 'account')           return IconUserOutline       // 通用设置
if (id === 'models')            return IconDataOutline        // 模型
if (id === 'agent-presets')     return IconAgentPreset        // Agent 预设
if (id === 'plugins')           return IconPersonalization    // 内置插件
if (id === 'archived-sessions') return IconArchive
return IconSettingsOutline                                    // ← 其余全部是齿轮
```

而 `settings.section` 的行只带 `{ id, order, label }` —— **没有 icon 字段**。
⇒ **第三方插件无法自定义设置导航的图标**，`package.json` 的 `icon` 在那里根本不被读取。

> ⚠️ 我一开始断言"通知插件有铃铛，所以 manifest 驱动导航"——**那是错的**。
> 我把自己的预览图当成了用户的实际界面。实际截图里 **费用/通知/远程工作节点/皮肤管理全是同一个齿轮**。

#### 第二层：图标确实被消费，但在**插件管理**页

`dsh-client-ui-plugin-manager`（「已安装 N」那个页面）：

```js
icon: jsx(PackageArtwork, { src: pkg.meta?.icon }, pkg.meta?.icon)
```

`dsh-plugin-manager` 通过 `readPluginMeta` 读取它。**这里才是 manifest 图标真正出现的地方。**

#### 第三层：**真正的 bug —— SVG 注释里的双横线**

修好前两层认知后，插件管理页里我的图标**仍是默认星形**，而旁边的通知插件（铃铛）正常。

排查记录（每一步排除一个假设）：

| 假设 | 结论 |
|---|---|
| 路径/扩展名/体积不合规 | ❌ 用 DSH 的 `iconOf()` 逐条复现 → **ACCEPTED** |
| 解析器不对（`createRequire` vs ESM） | ❌ 改用 `import.meta.resolve` → 仍 **ACCEPTED** |
| junction 安装导致路径问题 | ❌ 同目录的 `dsh-plugin-code-quality` **也是 junction 且正常** |
| `readPluginMeta` 抛错 | ❌ 标题来自我的 `locale/zh.json` 且**显示正确**，说明它成功了 |

于是转向客户端：`PackageArtwork` 有**两条**回落路径 —— `src === undefined`，
**或 `<img>` 的 `onError`**。⇒ 说明是**浏览器解码失败**。直接测：

```
DECODE-FAILED (my-new, 2296 bytes)      ← 我的
LOADED-OK     (notify-ref, 402 bytes)   ← 通知插件
```

根因：**我的 SVG 注释里有 3 处 `--`**，而 **XML 规范禁止注释内出现双横线** ⇒
文档不是良构 XML ⇒ 浏览器 `<img>` 解码器拒绝 ⇒ `PackageArtwork` 静默回落到默认图。
通知插件的 SVG **完全没有注释**，所以没事。

**这个 bug 全程静默**：文件存在、DSH 校验通过、预览渲染正常、没有任何日志。

#### 教训：两个"权威"被混为一谈

| 谁 | 检查什么 |
|---|---|
| `dsh-app-boot` 的 `iconOf()` | 路径、扩展名、体积 —— **不解析文件**，畸形 SVG 照样通过 |
| **浏览器**的 `<img>` 解码器 | 文档是否良构 |

`icon-check.mjs` 原本只复现前者，于是给出**错误的安全结论**。现在它也检查注释里的双横线，
并在输出里明确写出这两者的区别。

#### 加的三条测试（都做过变异检验）

| 测试 | 变异检验 |
|---|---|
| SVG 必须良构（注释无双横线、标签配平、单一根元素） | 放回一个双横线 → **失败** ✓ |
| 页内图标与 `assets/icon.svg` 的路径必须一致 | 改一条路径 → **失败** ✓ |
| manifest 声明满足 `iconOf()` 全部规则 | — |

因为页面读不到包内文件，页内图标只能内联 —— 所以必须有那条"不许漂移"的断言。

### 15.11 假对象比真对象**能力更强**（第四次测试接缝失效）

首次真机使用后：点「连接检测」「截图」报 **`peer.ensure is not a function`**。

#### 根因：调用者搞错了接收者

`peers` 里存的是 **`workerRuntime`**，它只提供 `selfcheck()` 和 `connection`；
`ensure()` / `screenshot()` / `connected` 都在 **`connection`（即 `PeerConnection`）** 上。

```js
// 路由里（错）
await peer.ensure()
await peer.screenshot({ fresh: true })
// 模型工具里（对，remote-tools.js:227）
await wanted.connection.screenshot({ fresh: args?.fresh !== false })
```

**同一个功能，模型那条路是对的，页面按钮那条路是错的。**

#### 为什么测试没抓到：**假对象比它替代的东西更强**

```js
// 测试里的假 peer（错）
return {
  peerId, name, defaultCwd,
  connected: true,          // ← 真实 runtime 没有
  async ensure() {},        // ← 真实 runtime 没有
  async screenshot() {...}, // ← 真实 runtime 没有
  ...
}
```

它把连接方法**直接放到了 peer 上**，所以 `peer.ensure()` 在测试里成功、在真实里崩溃。
**假对象只有在"不比真对象更强"时才有鉴别力** —— 一个更宽容的替身会让整张网失效。

而且 `ping` **当时根本没有测试** —— 变异检验（把路由改回错误写法）只让 screenshot 那条失败。

#### 修法：让假对象**镜像真实形状**，并加一条撒不了谎的测试

| 层 | 做法 |
|---|---|
| 单元测试的假 peer | 把 `ensure`/`screenshot`/`cancel`/`connected` 全部移到 `connection` 上，`bridge` 指向同一对象 —— 与真实 runtime 一致 |
| **集成测试**（`apply-config.test.js`） | **驱动真实 `apply()` 产出的 runtime**：先从 `provider.peer` 取出真实 runtime，断言 `connection.ensure` 存在而 **`runtime.ensure === undefined`**（把 bug 的前提写成断言），再用路由打 `ping`/`screenshot`，断言**错误里不得出现 "is not a function"** |

集成测试通过 `provider.peer` 拿到 runtime —— provider 持有真实对象，这条路径**结构上不可能比真实更强**。

#### 附带发现

`screenshot` 走 **HTTP fetch**（报 `fetch failed`），`ping` 走 **WebSocket**（报 `ETIMEDOUT`）——
两者的错误文案不同，断言必须同时接受。这是测试跑出来的，不是猜的。

#### 同类问题的累计清单

| # | bug | 为什么测试没抓到 |
|---|---|---|
| 1 | provider 从未调用 `bridge.connect()` | 单测用**预先连好**的假 bridge |
| 2 | 工具 schema 不可转换（`type: null`） | 冒烟只挂载、不触碰工具 |
| 3 | 编辑表单取自错误数组 | 假数据两个数组长得一样 |
| 4 | **`peer.ensure is not a function`** | **假对象方法比真对象多** |

**共同点：替身比被替身者更宽容。** 三次是靠真机发现的，一次是靠真机验证脚本。

### 15.12 人工审批与审计日志（P5 剩余项）

#### 修掉的功能缺口：`needsHuman` 曾经**只能失败**

规则 6 的设计原文是"上报人工（缺省 `optionId` 为 `reject-once`，**人工批准后由调用方覆盖**）" ——
但那个"调用方"从没被写出来。代码里的注释是诚实的：

```js
// Until a human UI is wired, `needsHuman` requests fall through to refusal.
```

后果：`danger-full-access` 提权**一律被拒，且没有任何批准途径**。从机的 GUI 测试若需要写工作区之外
（日志、配置、安装目录），**永远做不成**。fail-closed 不是漏洞，但是一个真正做不成事的缺口。

#### 设计要点

| 决定 | 理由 |
|---|---|
| 队列与审计是**插件级**，不是每 worker 一个 | 等一个人的请求不属于某个 worker；审计按 worker 重建就不叫 trail |
| 队列超时**比 bridge 自身的超时更短**（提前 2s） | bridge 也在 race 它自己的 `approvalTimeoutMs`；若队列更慢，bridge 先拒绝，页面就留下一行**永远点不动的幽灵记录** |
| 超时 = 拒绝 | 这让"放行"永远是一个**明确动作**，而不是默认结果 |
| 审计**独立文件、追加写入** | 设置文件每次保存都整体重写；审计被重写就等于有机会丢掉你正想留的记录 |
| 审计**永不抛错** | 它只是观察者。一个能否决审批的审计，比一个报告"写不进去"的审计更糟 |
| 没有队列时返回 `available:false` | "没人在等"和"这个构建问不了人"是两件不同的事 |
| 点已失效的行 → **409** | 页面可能正展示一行已超时的记录；报成功会让"过期点击"看起来像"刚批准" |

#### 顺带修掉的接线 bug：`allow-once` 在构造函数级路径上不可达

```js
// AcpBridge.normalizeSelected
if (answered === OPTION_ALLOW_ONCE && ...) return OPTION_ALLOW_ONCE
return rejectOptionId                     // ← 否则一律拒绝
```

它拿**字符串**比较，而 `makeApprovalDecider` 返回的是**对象**
`{optionId, source, reason, needsHuman}`。对象永远不等于字符串 ⇒ **这条路径静默拒绝一切**。

provider 那条路是对的（它自己解包 `.optionId`），所以端到端测试全绿 —— 只有**构造函数级默认**
（"某个别的调用方直接用 bridge"）是坏的。fail-closed，不是安全问题，但 `allow-once` 在那条路上
是**死代码**。

修法：新增 `asBridgeOption(decider)` 适配器，并把结果**规范化**为两个 ACP optionId 之一，
以后决策对象变形也塞不进别的东西。

**测试策略（两层，缺一不可）**：

| 层 | 作用 |
|---|---|
| 行为测试（真 bridge + 假 agent） | 同一个测试里先跑**未适配**的 decider（必须得到 `reject-once`），再跑适配后的（必须 `allow-once`）—— 把 bug 本身写成断言 |
| **源码级接线守卫** | 行为测试证明不了 `index.js` **用了**适配器（那个默认回调在 `PeerConnection` 里惰性构造，运行时测不到）。这是"没有运行时路径可达的接线 bug"，源码断言是诚实的选项，回退会立刻失败 |

#### 契约来源

`AcpBridge` 从类型上已经支持异步：`onApproval: (req) => Promise<'allow-once'|'reject-once'>`，
且 provider 是 `await this.decideApproval(...)`。所以"挂住等人批"**不需要改 bridge**，
只要把 decider 变 async 并接上队列。

### 15.13 截图回收（两侧）+ 设置页暴露开关与策略

#### 为什么现在做

实测：从机 `shots/` 已 **6 个文件 / 56.9 MB**，单张 **~9.5 MB**，**从无清理**。
一轮 GUI 验证几十张就是几百 MB，且主机侧同样只增不减。

#### 两侧各自清理，而不是主机去删从机的文件

| 侧 | 做法 |
|---|---|
| 从机 | relay 每次拍摄**之前**先按 `--keep-shots`（默认 20）裁剪自己的 `shots/` |
| 主机 | `PeerConnection` 每次下载**之后**按 `keepShots`（默认 20）裁剪自己的目录 |

**为什么"拍之前"而不是"拍之后"**：`GET /screenshot?fresh=1` 是**先拍再读**（`readFileSync(shot.path)`）。
若在拍之后裁剪，`keep-shots 0` 会把主机正要下载的那张删掉。先裁则新文件尚不存在，**结构上不可能被删**。
代价是目录里最多有 `KEEP_SHOTS + 1` 个文件。

**为什么让从机自己清理**：不需要新增协议面，而且主机不在时它照样工作。

#### 两条安全规则（都有测试）

1. **永不抛错**：清理跑在截图路径里。"能删掉旧文件但拍不了照"严格劣于"多占点磁盘"。
2. **只删自己写的文件**：主机目录在系统临时目录里，与其他软件共享；从机 `--shot-dir` 可配置。
   所以按**文件名模式**判定，且模式带分隔符 —— 否则给 `w1` 清理会顺手删掉 `w12` 的截图。

#### 测试策略：把规则抽成可测模块

从机 relay 是长驻脚本、自身没有测试脚手架，所以裁剪规则抽到 `slave/prune-shots.mjs`
（只依赖 `node:fs`/`node:path`，可随 relay 一起拷到从机）。主机侧同理在 `core/shot-gc.js`。
两边各有独立测试，覆盖：前缀碰撞、外来文件、非有限/负数预算、缺失目录、子目录、mtime 排序。

#### 顺带抓到的真 bug：`currentSettings()` 漏字段

页面能**保存**某个键，而 `currentSettings()`（`apply()` 里那个）不列出它 —— 值写进了文件，
页面读回来却是 `undefined`，于是回落到默认值。**表现是"设置生效一次，然后自己变回去"。**

这次是 `delegationPolicy` 中招，被往返测试抓住。修法是把 `delegationPolicy` 补进
`currentSettings()`，并把 `keepShots` 加进 `policyStamp()` —— 后者决定改配置是否**重建** worker：
`PeerConnection` 只在构造时读 `heartbeatMs` / `keepShots`，漏掉就等于"页面接受了编辑但重启前不生效"。

#### 页面为什么不做会话开关的按钮

会话开关是**按会话**的，而这个页面**没有会话身份**。所以它只**报告状态**
（"当前有 N 个会话启用"）并**指出真正的控件**（`/remote-use on`），而不是摆一个按不动的开关。

### 15.14 配对串

#### 要解决的问题

配对意味着**手抄** `ws://192.168.1.101:7331` 和一个 40 字符的 bearer token，而那个值还要跑到另一台机器上去读。
又慢又容易错。

#### 格式：`dshpair1.<base64url(payload)>.<checksum8>`

**它携带凭据**：串里含可还原的 token，所以它**就是 token**。两个后果：

| 后果 | 做法 |
|---|---|
| 绝不能进日志/回显/错误信息 | 错误只描述结构问题；日志只记 `describePairing()` 给出的 **host:port** |
| 截断必须**响亮地失败** | 加校验和。静默的错误 token 会在很久之后以认证失败的形式出现，离粘贴点很远 |

**版本前缀 `dshpair1` 是为了把"格式变了"和"串坏了"区分开** —— 否则未来的改动会被误读成损坏。

#### 两侧共用一份实现

编码在从机（`slave/pairing.mjs`，随 relay 一起拷过去），解码在主机（`lib/index.js` 直接 import 同一文件）。
**同一个文件**，所以两侧不可能对格式产生分歧。这需要把 `slave` 加进 `package.json` 的 `files`。

#### 从机怎么产出

- `--print-pairing`：打印一行然后退出（人在从机旁边时最方便）
- 启动时写 `pairing.txt`（权限 0600），**每次启动都重写** —— 否则轮换 token 后会留下一个
  带**旧** token 的串，而它的失败长得像网络问题
- 无 `--token` 时**拒绝生成**并以 2 退出：否则会生成一个把主机配到"谁都能连"的从机的串

#### 广播地址凭什么挑

`--host 0.0.0.0` 是"到处监听"，不是能拨的地址。原本取"第一个非内部 IPv4"，
在开发机上选中了 **Hyper-V 的 `172.20.0.1`** —— 串完全合法且**毫无用处**。

现在按打分挑：跳过接口名像虚拟网卡的（`vEthernet`/`WSL`/`Docker`/…），
`192.168.` > `10.` > `172.16-31.`，最后回落 loopback。仍然只是启发式，所以有
`--advertise-host` 覆盖，且**选择会被记录**。

#### 测试

| 层 | 覆盖 |
|---|---|
| 单元 | 往返、截断/篡改被拒、空白容错、前缀/版本/形状/协议校验、超长拒绝、错误信息不含 token |
| **跨边界** | **真的 spawn relay**，用**主机的解码器**读它的输出 —— 这是唯一能证明两侧一致的测试 |
| 契约 | 无 token 时必须非零退出且不打印可用内容 |
| 启发式 | 广播地址不得是虚拟网卡/链路本地/loopback（本机实测能抓到跑偏） |

---

## 16. 对称配对（本机在主/从之间切换）—— 六问已定，实现中

**方向已定**（用户选择 A），但**尚未实现**，因为它与"管理已知工作节点"是**不同的风险等级**。
本节先把要打开的东西和必须决定的问题写清楚，再动代码。

### 16.1 启用它究竟打开什么

| 打开的东西 | 说明 |
|---|---|
| **一个监听端口** | 本机开始接受来自网络的 ACP 连接 |
| **远程执行能力** | 连上并持有 token 的一方可以在**本机**执行命令 |
| **约束取决于沙箱** | 而本机的沙箱状态见 §14.2——同一台机器，同一个 mediator 缺陷 |

⚠️ 关键：**这与"向一台专用测试机派单"完全不同。** 那台机器是牺牲品；本机是操作者的工作环境。

### 16.2 现状与目标的差距

现在 worker 侧是**独立部署**（`relay.mjs` + ACP 子进程 + schtasks 自启），**不是插件**。
对称配对要求插件自身能当 worker —— 也就是把中继搬进插件，并让它按需启停。

### 16.3 一个已知的硬前提（不是猜测）

本机的 ACP 子进程由谁启动，其 `process.execPath` 就是谁 —— 若由本机 DSH 启动，同样是
**GUI 子系统镜像**，§14.2 的 `0xC0000142` 会原样复现。

⇒ **"本机当 worker"要么先复用我们已建的 mediator shim**（`extract-mediator.mjs` +
`sandbox-mediator-shim.mjs`），**要么只能跑在 `danger-full-access` 下**。

这不是可以绕开的细节：它决定"启用对称配对"是否等于"在工作站上开一个无约束的远程执行口"。

### 16.4 六个问题的当前状态

| # | 问题 | 状态 | 裁决 / 备选 |
|---|---|---|---|
| 1 | **布防模型** | ✅ 已定 | **布防保持到手动关闭**（关 = 显式动作，不自动撤防） |
| 2 | **绑定地址** | ✅ 已定 | **指定 LAN 接口**（页面列出可选接口供选择）；**不提供 `0.0.0.0` 一键选项** |
| 3 | **token 生命周期** | ✅ 已定 | **启用时生成，明文只回传一次，之后只留掩码**；写入 settings 文件以便重启后保持 |
| 4 | **沙箱不可用时是否允许启用** | ✅ 已定 | **直接拒绝启用，直到沙箱可用**（不做"我知道它不受约束"的确认绕过） |
| 5 | **本地急停** | ✅ 设计已定 | 必须有一个**不依赖远端配合**就能关闭的开关 |
| 6 | **启用前页面必须显示什么** | ✅ 设计已定 | 端口、可达范围、当前约束状态、如何关闭 |

**第 4 项的前提已经达成并实测**（§14.3.2）：主机作为从机时受"无控制台"影响，mediator 已装好，
`validate-sandbox-confinement.ps1` 实测 **5/5**。所以"拒绝启用直到沙箱可用"这条现在**可以被满足**，
而不是永远拒绝。

**六问已全部有答案**，可以开工。

### 16.5 我建议的安全属性（供讨论）

1. **默认关闭，且绝不隐式开启** —— 与"不自动登录"的既有偏好一致
2. **沙箱不可用时拒绝启用**，除非操作者显式确认；把"这会不受约束"写在确认里，而不是埋在文档里
3. **绑定默认只到具体 LAN 接口**，不提供 `0.0.0.0` 的一键选项
4. **token 生成后只显示一次**，之后只留掩码；提供轮换与吊销
5. **本地急停始终可用**，且**不经过远端**（远端行为异常时仍能关掉）
6. **页面顶部常驻一条状态**："本机正在接受远程驱动" + 对端 + 已运行时长

### 16.6 为什么先写设计而不是先写代码

本轮已交付的配对管理是**纯管理面**：它只影响已知的、由操作者配置的工作节点。
对称配对则**新增一个网络可达的执行面**。这两者的"写错了会怎样"完全不对称，
所以它值得先有一段可以被反驳的文字，而不是先有一段能跑的代码。

**未实现即当前状态**：设置页只**陈述**本机角色为"主机"，不放一个点了没用的开关（§15.3）。

**为什么下一张表把 2 和 3 单独标出来**：绑定地址决定**谁能连**，token 分发决定**谁能拿到凭据**。
其余四项是"怎么用"，这两项是"谁能进来" —— 后者才是新增网络执行面的实质风险。

---

## 17. 会话级启用开关：默认 off

### 17.1 要解决的问题

装了插件不等于"每一次工作都应该走从机"。期望的分工是**代码与开发在主机、只有 GUI 验证在从机**，
而这件事**不能靠"插件装了就一直注入一条策略"来表达**。

而且 DSH 里**没有任何地方告诉父代理"何时该委派"**：

| 位置 | 为什么不行 |
|---|---|
| 派单工具 `subagent_remote` 的描述 | `dsh-tool-subagent` 的 Config **没有 `description`**，描述由代码按 provider 能力生成，进程外 provider 得到的是通用文案 |
| provider 自身 | 契约只有 `name` / `capabilities` / `inheritsParentContext` / `start`，**没有描述位** |
| DSH 的 `SUBAGENT_DELEGATION` 上下文 | 它是**对子代理说的**（"You are a delegated subagent…"），不是对父代理说的 |

⇒ **策略只能由本插件自己注入**，而"是否注入"由会话决定。

### 17.2 交互

```
/remote-use           显示本会话当前状态
/remote-use on        本会话启用：注入分工策略，放开远程工具
/remote-use off       本会话关闭（默认）
```

**默认 off**：新会话不注入任何策略，远程工具在该会话内**不可见**。
**不跨重启保持**：模式是进程内的，重启后回到 off。

### 17.3 实现：三件东西，缺一不可

#### (1) 按会话遮蔽工具

```js
ctx.on('agent/created', ({ agent }) => {
  if (!enabledAgents.has(agent)) agent.ctx.tools.restrict({ deny: REMOTE_TOOL_NAMES })
})
```

⚠️ **不能全局遮蔽**：`tools.restrict()` 自己会拒绝 ——
*"a context-global restriction would mask every agent — deny the tool for the intended agent instead"*。
所以唯一正确的形状是在**每个 agent 自己的作用域**里拒绝，这也让限制随 agent 一起销毁、不跨会话泄漏。

`/remote-use on` 调用该限制的 disposer 解除它。

#### (2) 全局执行守卫（fail-closed 兜底）

```js
ctx.tools.guard((exec) => {
  if (!REMOTE_TOOL_NAMES.includes(exec.name)) return undefined
  return enabledAgents.has(exec.agent) ? undefined : 'remote-use is off for this session: ...'
})
```

**为什么必须有它**：(1) 是在 **agent 创建时**施加的，而 `dsh-agent` **没有列举存活 agent 的 API** ——
所以"插件被应用时已经存在的 agent"（热重载、配置变更）会保留可见的工具，**工具列表可以是错的**。
全局守卫让**后果仍然正确**：名单错了，执行照样被拒。

#### (3) 按会话条件注入策略

```js
ctx.systemPrompt.section({
  name: 'remote-use:policy',
  order: ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),
  text: (context) => enabledAgents.has(context.agent) ? cfg.delegationPolicy : '',
})
```

`context.agent` 来自 `assembleContextFor(agent)`，所以**同一个 agent 对象**既标识命令作用域、
也标识提示词作用域 —— 两侧天然一致。

**order 放在 `TEAM_POLICY`**：`dsh-tools` 给它的 PTC-only 声明写过理由 ——
*"Its order places the rule before that guidance rather than after it"*。
策略要**先于**它所限定的工具说明被读到。

### 17.4 策略文案（可配置，默认如下）

`delegationPolicy` 配置项。核心三句：

- 代码修改、文件编辑、构建、依赖安装、仓库操作**在本机**
- **只**委派需要真实桌面的：启动并驱动目标程序、确认界面显示、复现只在真实显示器上出现的现象
- **不要**在从机上开发 —— 它看不到本工作区，写在那边的不会回来

设为**空串**则完全不注入（工具门禁仍然生效）。

### 17.5 ⚠️ 强制力的真实边界

| 层 | 强制力 |
|---|---|
| 本会话工具被遮蔽 | **硬**：模型看不到这些工具 |
| 全局执行守卫 | **硬**：即使可见也拒绝执行 |
| 结构性兜底 | **硬**：从机看不到主机工作区、从机沙箱只许写自己的 `cwd` |

⇒ 现在 `off` 是**真的 off**（用户明确选择了"硬 off"）。最坏情况仍是白跑一趟，不会污染仓库。

### 17.6 一个维护代价

`apply()` 依赖的平台面变大了（`ctx.on` / `tools.guard` / `commands` / `agent.ctx.tools.restrict`），
**每一个挂载真实 `apply()` 的 harness 都必须同步更新**。本轮为此改了三处：
`test/apply-config.test.js`（仿真 ctx）、`plugin-smoke.mjs`、`plugin-live.mjs`。

`plugin-live.mjs` 与 `plugin-smoke.mjs` **响亮报错**（`ctx.on is not a function`）而不是静默通过 ——
这正是它们存在的意义：**单测用自己的假 ctx，覆盖不到"真实 apply() 需要的平台面"**。

另外 `plugin-smoke.mjs` 里那条 `sections.length === 1` 的断言改成了**按名字断言** ——
按数量会在每次新增区块时失效，而且说不清是哪一个丢了。

### 16.7 实现进度（第 3 轮）

| 层 | 状态 | 位置 |
|---|---|---|
| 接口选择 / 绑定校验 | ✅ 完成并测试 | `slave/net-address.mjs`（relay 与插件**共用**，避免漂移） |
| 沙箱探测 | ✅ 完成并实测 6/6 | `lib/core/sandbox-probe.js`（插件门禁与 `tools/check-sandbox-ready.mjs` **共用**） |
| 布防状态机 / token 生命周期 / 门禁 | ✅ 完成并测试 19 条 | `lib/core/worker-arming.js` |
| **监听器** | ⛔ 未做 | 通过注入的 `start`/`stop` 接入 |

**`WorkerArming` 刻意不拥有监听器**：`start`/`stop` 是注入的，所以状态机在开端口之前就完整可测，
而监听器也无法悄悄长出自己的一套策略。

#### 六个裁决在代码里的落点

| 裁决 | 落点 |
|---|---|
| 1 布防保持到手动关闭 | `arm()` 之后只有 `disarm()` 会改状态；没有任何定时器 |
| 2 指定 LAN 接口，不给 `0.0.0.0` | `assertBindable()` **拒绝**通配地址，而不是"默认避开" |
| 3 token 只显示一次 | `arm()` 返回明文**恰好一次**；`status()` 只有掩码。落盘以便重启保持配对 |
| 4 沙箱不可用则拒绝 | `preflight()` **每次都跑探测**（结论依赖启动上下文，缓存等于在回答另一台机器） |
| 5 本地急停 | `disarm()` 不联系远端、不等待远端；监听器抛错也照样停 |
| 6 状态说明开了什么 | 地址、端口、已运行时长、凭据掩码、**接口全列表**（含不该选的那些，以便解释） |

#### 已做的变异检验

把门禁从"阻断"改成"只警告" → `A BROKEN SANDBOX REFUSES ARMING` 失败 ✓

#### 一个反复出现的工具陷阱

用 `$out = foreach (...) { ... }; Set-Content -Value $out -NoNewline` 做行级改写，会把**整个文件压成一行**
（数组被无分隔符拼接）。这与之前 `-replace` + `Set-Content` 造成内容重复是同一条教训：
**行级改写不要用字符串拼接，用能保住结构的方式**。本次已改用 `edit`。

#### 第 5 轮：接入 apply() 与路由

| 项 | 状态 |
|---|---|
| `workerRole` 纳入 settings 的托管键 | ✅ |
| `apply()` 创建 `RelaySupervisor` + `WorkerArming` | ✅ |
| 路由动作 `worker.arm` / `worker.disarm` | ✅ |
| GET 暴露角色状态（**只有掩码，永不含 token**） | ✅ |
| 设置页布防 UI | ⛔ 待做 |

**两条测试接缝的补充**：

1. **门禁的拒绝路径是真路由 + 真探测测的**：测试 harness 的临时 `DSH_HOME` 里没有 acp profile，
   所以 `worker.arm` 必然被拒 —— 断言 409 且错误信息**指向沙箱而不是地址**。
   成功路径在 `worker-arming.test.js` 里用注入的探测覆盖。
   变异检验：把 `probe` 恒为 ok → 该测试失败 ✓（也据此发现 spawn 的监听器会挂住测试进程）

2. **共享 harness 的状态泄漏**：`withEnv` 只在测试**开始**删除 settings 文件，而
   `delegationPolicy: ''` 那条测试是同步的、没包 `withEnv` —— 它读到前面测试留下的文件，
   于是**通过与否取决于谁先跑**。已把它包进 `withEnv`，让它声明自己需要干净状态。

**一处必须记下的操作失误**：清理残留进程时用了 `'relay\.mjs|acp'` 这个**过宽的过滤**，
误杀了两个 **JetBrains Rider 的 ACP agent**（与本项目无关）。清理过滤器必须匹配**具体路径**，
不能匹配"看起来相关"的关键词。已改为只匹配 `dsh-plugin-remote-use\slave\relay.mjs` 与本机
acp profile 的 cli.js。

#### 第 6 轮：布防 UI

设置页的「本机角色」区块现在包含完整的布防面板：

| 要求（§16.4 第 6 条） | 落点 |
|---|---|
| 端口 | 数字输入，默认 7331 |
| 可达范围 | 接口下拉，**列出全部**（含不该选的那些），并说明为何不推荐 |
| 当前约束状态 | 沙箱探测结论徽章 |
| 如何关闭 | 常驻「立即停止」/「停止并作废凭据」，并注明**不联系主机** |

**两处刻意的设计**：

1. **布防按钮在检查通过前是禁用的**。第 4 条裁决会在沙箱不成立时拒绝布防；一个"点了只能失败"的
   按钮只会教会操作者忽略警告。所以先"检查"，通过了才允许布防。
2. **凭据只在布防后显示一次**，面板上写明这一点。之后每次渲染读的都是状态里的掩码。
   重新签发 = 先停止再布防，是一个**明确动作**。

**测试里我自己的一个错误假设**：断言"选项恰好 3 个"，但 `AdvancedSettings` 的档位下拉也有
`<option>`，总数其实是 6。已改为按接口地址过滤 —— 这类"数数量"的断言在页面变大后必然失效。

变异检验：把布防按钮的 `disabled` 条件去掉 → 对应用例失败 ✓

#### 第 7 轮：三个 harness 同步

**smoke 原本跑在操作者的真实 `.dsh` 上** —— 它没设 `DSH_HOME`。加了审计/布防的路由检查之后这变成了
真危险：真实 acp profile 存在、沙箱门禁会**通过**，于是 smoke 里的 `worker.arm` 会**在操作者机器上
开一个监听器**。

已给 smoke 加临时 `DSH_HOME`（并在退出时清理）。副作用是：临时 home 里没有 acp profile，所以
**门禁必然拒绝** —— 这既安全，又正好是值得断言的性质。

新增的 smoke 检查：

| 检查 | 为什么 |
|---|---|
| GET 报告审批队列与审计日志 | 二者是新增的唯一数据面 |
| **审计路径在临时 home 下** | 直接验证隔离本身，而不是相信它 |
| 角色状态**永不含 token** | 不变式，每次都要钉 |
| **布防被拒且错误指向沙箱** | 第 4 条裁决在装配层面的证据 |
| 被拒后什么都没布防 | "拒绝了"和"没发生"是两件事 |

**live 加了一节 2e，但刻意什么都不布防**：它跑在真实 home 上，门禁会通过，成功的 `worker.arm`
会真的开端口。所以只断言**不可能启动任何东西**的路径：状态形状、接口预选不是虚拟网卡、
`worker.preflight` 的沙箱结论、以及**本机没有的地址**被拒（在启动前就返回）。

**核实过**：这一轮没有启动任何监听器（7331/7397 空闲、无 relay 进程），真实 `settings.json`
的 mtime 仍是 192 分钟前（你保存页面时写的），没有被测试改动。

#### 第 8 轮：两处审出来的真缺陷

**1. 恢复布防时没有重跑沙箱门禁**（安全相关）

settings 里存着 `armed: true` 时，`apply()` 会**直接起监听器**。但沙箱不是插件的属性 —— 它是
acp profile 里接的 mediator，而 mediator 是从 DSH 包里**物化出来**的。所以：

- **DSH 升级会让它失效**（shim 会去驱动上一版的 runner）
- 删掉那个目录也一样

不重跑门禁的后果：**上周布防的机器，在约束已经失效之后继续接受远程执行** —— 正是第 4 条裁决要防的事。

现在恢复时重跑探测，不通过就**不恢复**、不监听，并说明原因。凭据**保留**（拒绝的是约束，不是配对；
丢掉它会让操作者在修好 mediator 之后还要重新配对）。

**只在存的是 `armed: true` 时才探测** —— 未布防（默认）的机器在每次 DSH 启动时不付这个开销。
这一条也有测试。

**2. `keepShots` 没传给从机角色的 relay**

页面上的设置只管了**主机侧**，而从机侧才是更大的那份累积（每张 ~9.5 MB、原本永不清理）。
现在按**启动时**读取，所以改了设置在下一次布防生效，而不是要等 DSH 重启。两条测试分别覆盖
"传下去了"和"是启动时读的"。

两处都做了变异检验（回退修复 → 对应用例失败）。

#### 第 9 轮：两处修正 + 一个之前从未验证过的整体claim

**修正 1：token 轮换 —— 注释与代码互相矛盾**

```js
// A NEW token each time it is armed from disarmed ...
const token = this.token === '' ? this.mint() : this.token   // ← 实际是复用
```

实测：停止后再次布防得到**同一个凭据**，旧配对串**仍然有效**。而 Q3 的裁决是"**启用时生成**"。

**代码错了，注释是对的。** 现在 `arm()` 总是生成新凭据；持久化的那个只服务于**重启**这一个事件。
两个场景在 settings 文件里长得一模一样（`armed: false` + 有 token），所以只有 arm 这条路径能区分它们。

`disarm({ forget })` 因此有了不同的含义：不再是为了让配对失效，而是**把密钥从磁盘上抹掉**。

新增三条测试：轮换、**重启不轮换**（对照）、`forget` 的独立含义。变异检验：改回复用 → 轮换测试失败 ✓

**修正 2（同轮）：`worker.disarm` 路由在停止失败时仍报 `ok: true` 且 `error: ''`**

现在按实际结果报告。

**整体claim：主机能当它自己的从机 —— 现在验证过了**

之前验证的都是**零件**：监听器能起、ACP 能握手、沙箱能限制、状态机能拒绝。**没有一样能证明一个任务能走通**，
而"零件都对、装配从不运行"是这个项目已经踩过五次的坑。

`probe-worker-role-live.mjs` 走**回环**（不暴露局域网），用真实门禁 + 真实监听器 + 真实 ACP agent：
布防 → 配对串 → `/healthz` → 无凭据被 401 拒 → **主机自己的协议完成握手** → **一个任务跑完** → 本地停止 → 端口释放。

```
RESULT: OK -- this machine works as its own worker.
```

**它不写 settings 文件**（`persist` 是 no-op），核实过哈希未变。

**一个值得注意的观察**：从机的 self-check 报 `verdict: blocked`（4 项 blocking），
但任务照样跑完了。那是**从机本地的就绪检查**（显示器/窗口站等），不是远程路径的问题 ——
说明"就绪报告"和"能不能跑任务"是两件事，页面上不应把前者当作后者的门禁。

**探针里我自己的一个 bug，恰好证明了修正 1 生效**：我传了一个硬编码凭据去连，得到 401 ——
因为 `arm()` 现在生成的是新凭据。**监听器正确地拒绝了错误的凭据。**
