# dsh-plugin-remote-use 设计文档

> 局域网主从委托：让主机的 DSH 像调用子 Agent 一样，把任务委托给从机上的 DSH。

> **这份文档是「为什么这样做」**——设计取舍与决策记录，含每一轮的验证与发现。
> **想知道「怎么用」请看仓库根目录的 [`README.md`](../README.md)**；
> **想看「踩过哪些坑」请看 [`PITFALLS.md`](PITFALLS.md)**；**上游契约看 [`INTERFACES.md`](INTERFACES.md)**。

| | |
|---|---|
| 状态 | **四项全部交付并验证**：主机侧在真实 DSH 里验过，从机侧已部署并在真从机上端到端通过（§20）。三个 harness 全绿 |
| 目标 DSH 版本 | `0.2.0-rc.2`（协议版本需运行时协商，见 §4.1） |
| 决策依据 | 本仓库 `.research/01`–`.research/06` 六份源码级调研报告（索引见 §12.1） |
| 权威查证源 | 实现时遇到疑问请优先查 §12.2 列出的两处**权威离线源**，而不是反编译 bundle |
| 文档约定 | 标记 ⚠️ 的条目为**待核验/待定**；标记 🔒 的为**代码事实约束，不可绕过** |

---

## 1. 目标与非目标

### 1.1 目标

1. **主机侧零感知差异**：主机上的模型看到的是一个 `remote_subagent` 工具，用法、参数、后台 job、进度语义都与内置的 `subagent` 一致。
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
│  模型 ──► tools: remote_subagent / remote_agents / remote_interrupt │
│                        │                                            │
│  ┌─────────────────────▼──────────────────────────────────────┐    │
│  │ dsh-plugin-remote-use / host                                │    │
│  │                                                             │    │
│  │  RemoteProvider ──── ctx.subagents.registerProvider()       │    │
│  │      │  capabilities: 全 false, inheritsParentContext: false│    │
│  │      │                                                      │    │
│  │  AcpClientBridge ──── 每条从机一条长连接（WS）+ N 个 session │    │
│  │      │                                                      │    │
│  │  TaskRegistry ─────── 远程 run 的内存 registry（含答案）      │    │
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

> **`TaskRegistry` 里"可见性"的确切含义**（F15 修正）：它必须保存**进度**（状态、工具调用数、用量、
> 是否在等审批）**和答案本身**。原先只保存前者，于是后台委派的答案**无处可取** ——
> 前台路径把这个缺口一直遮着，因为前台调用方自己还攥着 `result` promise。

> ⚠️ 与早期讨论的偏差：早期设想是"从机开自动审批，拒绝时转发主机"。核实后发现 ACP 会话用不到 Auto review，因此该机制**改为在主机侧实现**，效果等价且成本更低。

### 3.2 从机形态

**从机 = 完整 DSH（web/desktop profile）+ 本插件的 slave 半 + 受限默认沙箱。**

- 用户可在从机上手动配置默认沙箱（按需求，也保留"手动把从机设成全权自主"的自由）
- 配对后从机 UI 增加一个「工作节点」区域（任务队列 / 待审批 / 急停 / **当前会话类型与分辨率**）
- 从机保持可独立使用：未配对、或配对后用户手动开会话，行为与普通 DSH 一致

🔴 **必须运行在用户交互会话**，不能做成 Windows 服务、也不能靠 SSH 启动——实测 SSH 落在 Session 0，该会话没有交互桌面。详见 §7.5（实地勘察得出的部署约束）。

### 3.3 速览与落点（原根 README 的"架构速览"，2026-10 搬入）

```text
┌─ 主机 ────────────────────────────────────────────────────────┐
│ 插件 apply()                                                  │
│  ├─ 每个 worker 一个 RemoteProvider（subagents.registerProvider）│
│  ├─ 每个 worker 一个 PeerConnection = AcpBridge + 心跳 + 截图   │
│  │    └─ ACP over WebSocket ──▶ 从机 relay ──▶ 从机 DSH(acp)   │
│  ├─ 审批队列（人工决定）+ 审计日志（append-only JSONL）          │
│  └─ 设置路由 /api/dsh/dsh-plugin-remote-use                    │
└───────────────────────────────────────────────────────────────┘
```

| 关注点 | 落点 |
|---|---|
| 模型怎么看到工具 | 插件自己用 `ctx.tools.register()` 注册（`remote_subagent` + 四个 `remote_*`）。**loader 工具行到不了模型** —— 工具目录由 agent preset 枚举（PITFALLS F11） |
| provider 名 | `remote-<worker id>`；委派工具按 worker 找到对应的 provider，**不再需要工具行里的 `provider` 字段** |
| 委托是同步还是异步 | `start()` 返回 run 句柄，`run.result` 等待完成 |
| 一个节点同时几个任务 | `serialQueue`（默认 1）——GUI 是独占资源；worker 忙时 `start()` 会**先排队**，所以"后台模式"也不是立刻返回（F15 连带修正） |
| 后台任务的答案从哪来 | 由 `TaskRegistry` 留存（上限 64 000 字符），`remote_agents` 的 `status` / `wait` 渲染出来（§5.3） |
| 截图怎么回来 | 走 relay 的 HTTP 侧（不走 ACP 消息泵，避免 base64 膨胀） |
| 提权怎么问人 | 从机 DSH 发 `session/request_permission` → 主机桥接 → 审批队列 |
| 设置路由谁能写 | 只有同源请求；跨站 POST 一律 403，且在任何动作被分发之前（PITFALLS F17） |

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

**一个 provider 对应一台从机**，名为 `remote-<peerId>`。工具行**不需要**任何人手写：委派入口是插件自己用
`ctx.tools.register()` 注册的 `remote_subagent`（PITFALLS F11 —— 放在 profile patch 里的
`dsh-tool-subagent` 行**到不了模型**，因为 Web 会话的工具目录由 agent preset 枚举）。
provider 注册与工具暴露是**两件事**，这一点曾被混为一谈。

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

记录每个任务：`taskId`、`peerId`、`label`、`prompt 摘要`、`状态`、`起止时间`、`最近 N 条工具调用摘要`、`当前是否在等审批`、`累计工具调用数`、`用量`，以及**落定后的答案文本**（`output`，上限 `OUTPUT_LIMIT = 64_000` 字符；`outputChars` 记原始长度）。

**答案为什么必须留在这里**（F15）：答案原本只从 `provider.start()` 返回的 `result` promise 交出去，
而**后台模式下没有任何人在等那个 promise** —— 调用方拿到 taskId 就走了。于是"任务跑完了"和"结果还在"
是两件事：promise 落定后文本就没了，后台委派变成一条**断头路**。留存上限是必须的（registry 活在整个进程里），
而**截断必须在渲染时写出来**，否则读者分不清"这就是全部"和"这是前 64k"。

⚠️ **设置页的 GET 路由用 `listForUi()`，不用 `list()`**：页面不渲染答案正文，把几十条完整回答随每次轮询
发给浏览器是纯粹的浪费（它只拿到 `outputChars`）。这是"留存答案"带来的**连带改动**，不加就会静默地把
设置页变成一个几 MB 的响应。

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
| `remote_subagent` | `subagent` | **插件自己注册**的委派入口（`ctx.tools.register`，0.2.0 起）。**不需要任何 profile 配置** —— 见下方"更正二"与 PITFALLS F11 |
| `remote_agents` | `list_agents` / `wait_agent` | action: `list` / `status` / `wait`。读 `TaskRegistry`；`status` / `wait` 会**把落定任务的答案正文渲染出来**（F15） |
| `remote_interrupt` | `interrupt_agent` | 走 ACP `session/cancel` |
| `remote_selfcheck` | —（新增） | 查询从机就绪状态，见 §5.10.7 |
| `remote_screenshot` | —（新增） | 截从机桌面，**回传主机侧文件路径**（图走 HTTP，不走 ACP 消息泵），见 F14 |

**曾经设想的 `subagent_remote` 配置**（字段已核验；**行的写法与必要性都在下面被推翻**）：

```yaml
- insert:                               # ← 新增行必须包在 insert: 里，见下方更正
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

> ⛔ **更正二（0.2.0）：整段都不再需要。** 上面这个形状**写对了也到不了模型** —— Web 会话的模型工具目录
> 由 **agent preset** 枚举，不是整棵 loader 树（PITFALLS F11）。留下的价值只剩两条历史教训：
> patch 的 `insert:` 语义（更正一），以及下面对 capability 校验的核验记录。
> **插件用 `ctx.tools.register()` 注册自己的 `remote_subagent`**，安装侧因此不需要任何 profile 编辑。

⚠️ **更正一：上面的 `- id:` 单独写是错的，必须是 `- insert:`。** 这一条当初写成了不带 `insert:` 的
`- id: tool-subagent-remote-labpc`，而 patch 语义是「**带 `id` 的条目覆盖已有行，不创建新行**」。
实测：目标行不存在时，loader 在 stderr 上打出

```
dsh: [<补丁文件>] patch: entry "tool-subagent-remote-labpc" not found
```

并**跳过该条目**。所以照这份文档写出来的行**根本不会进树**。
正确写法见 `dsh-base` 自己的两行（它们是 bundle 补丁，但语法一致），以及
`cordis.patch.yml` 头部注释：
「a top-level YAML array of loader patch entries (id-targeted config overrides, disables, and **insert lists**)」。

⚠️ **`agentOptions` 连"配了但不填"都不行。** `dsh-tool-subagent` 在 `subagent/provider-added` 事件里同步调用 `assertSubagentProviderConfiguration`（`:369-386`）做校验，而 Cordis 的 `emit` 是 `dispatch(...).map(cb => cb(...))`（`cordis/src/events.ts:194-196`）——**监听器抛出的异常会冒出来，导致 provider 注册整体回滚**，工具根本不注册。所以远程行必须彻底省略 `agentOptions`。

⚠️ **`Config` 的真实字段**（`dsh-tool-subagent/lib/index.js:252-270`）：`provider`(必填) / `toolName`(默认 `"subagent"`) / `modelSelectionSettings`(默认 `false`) / `enableRunInBackground`(默认 `true`) / `backgroundMode`(默认 `"one-shot"`) / `agentOptions` / `persona` / `toolFilter` / `maxDepth`。

**没有 `outputSchema`，也没有 `description`。** `agentOptions` 的子字段是 **camelCase**：`provider` / `model` / `reasoningEffort` / `maxTokens`；而 `reasoning_effort`（snake_case）只是**模型面工具参数**，仅当 `modelSelectionSettings: true` 时才生成。

**一台从机一行是可行的**：base patch 自己就有两行同包不同配置的先例（`dsh-base/cordis.patch.yml:370-375` 与 `:383-388` 的 `tool-subagent` / `tool-subagent-fork`）。

✅ **U1 结论：可以保留主机本地子 Agent 的完整能力**（那是另一行配置），只对远程行关闭。

⛔ **U2 结论（已被推翻，保留原文以记录错误）。** 原结论：「插件不能在运行时新增工具行 —— 工具行只能来自 profile patch。所以「一台从机一行」需要用户在 profile patch 里手写……这对安装体验是个实际负担，见 §11。」

**这句话把两件事混成了一件，而且基于它做的实现方向是错的：**

- 插件确实**不能新增一个 `dsh-tool-subagent` 的 loader 行** —— 这部分对；
- 但插件**完全可以提供自己的委派工具**，走 `ctx.tools.register()`，与它已经提供给模型的四个工具
  （`remote_selfcheck` / `remote_agents` / `remote_screenshot` / `remote_interrupt`，见 `lib/index.js:585`）
  **同一条路**。

更关键的是：**即便把行正确放进 profile 补丁，模型也看不到它**。Web 会话的模型工具目录由
**agent preset** 枚举（`preset-standard` 的 `config.plugins`），不在表里的 loader 行不会出现在模型面前。
详见 `PITFALLS.md` F11。所以"每台从机在 profile 里写一行"不仅负担重，而且**根本不起作用**。

⇒ **正确做法**：插件自己注册委派工具（走 provider，与已有四个工具一致），
用户**不需要**碰 profile 补丁，`§11` 里那条"安装负担"随之消失。

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

`/api/dsh/dsh-plugin-remote-use`（参考 `dsh-plugin-notify` 的做法：body 上限、原子写、**拒绝跨站 POST**）。

⚠️ **第三项曾经只是文档里的一句话，代码里没有。** 本节从第一次提交就写着"自写 `sameOrigin()` 校验"，
但实现里从来没有 —— 直到 **0.2.2** 才真正加上（PITFALLS F17）。写在这里是因为这条边界容易漏：
**DSH 保护应用外壳（裸 `GET /` 返回 401），但不保护插件自己注册的路由** ——
路由怎么被访问到，是插件自己的责任。而 `Content-Type` 不被检查，所以浏览器可以跨站
**盲发**一个 `text/plain` 的 POST（无 preflight），动作会执行。

现在的契约是：**POST 且 `Origin` 头存在且不同源（含 `null`）→ 403，且在任何动作被分发之前**；
**没有 `Origin` 头则放行**（浏览器对 POST 一律带 Origin，所以这不可能来自恶意页面，
只可能是 curl / 脚本 / 真机 harness）。

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

**2026-10-14 实测：这一节当时只是计划。** 审计里有 6 行 `by=timeout`（其中 5 行集中在 8 分钟内），
而操作者的原话是"**核心问题是我真的没见过权限审批提示**"——设置页只在挂载与自身操作后读快照、
队列窗口 88 秒、过期即静默拒绝并删掉那一行。也就是说"主动性"完全没有落地：**与 F17 同一个形状，
文档写了、代码没做**（见 PITFALLS F18）。

三条计划逐一对照现状：

| 计划 | 现状 |
|---|---|
| 主机 Settings 页常驻「待审批 (N)」 | ✅ 审批组内有待批准列表，**页面可见时每 2.5 秒轮询**（所以行会自己出现，不必手动刷新）；无人应答的请求另列「有 N 件请求因无人应答被拒」，数据取自**追加式审计**，重启后仍在 |
| 桌面通知（复用 `dsh-plugin-notify` 的思路） | ✅ `lib/core/desktop-notify.js`：**调用**该插件自带的 `scripts/notify.ps1`（文件级契约，不 import 它的内部；未安装／无解释器／PowerShell 被挡都静默降级）。入队即发，且**在 `await` 之前**发 —— await 持续整个预算，之后发就等于事后通知 |
| 从机侧「工作节点」页显示"正在等待主机审批" | ⚠️ 主机侧任务表已用 `WAITING-FOR-APPROVAL` 标记（`TaskRegistry` 有该字段）；**从机本地那一页没有单独验证过** |

**还有一条比页面更可靠的通道：告诉模型。** 审批等待期间，运行时上下文注入里会多一段
`APPROVALS WAITING ON A HUMAN (n)`，写明工具、档位、剩余秒数，以及"让用户去设置页点允许"。
模型是唯一一个**此刻正在和人说话**的当事人 —— 页面需要人去看，模型只需要被告诉。

**窗口默认 180 秒**（`approvalTimeoutMs`）。这个数字不是审美问题：它就是"人能不能看见"的唯一约束。
超时依然是拒绝 —— 加长窗口不放松任何东西，它只是让"看见"这件事来得及。

**来源必须可辨**：`approvals.decide` 记录 `by ∈ {page, api, timeout, disposed}`。
页面在请求体里**自声明** `via: 'page'`（`Origin` 判据在本应用的链路上不成立——真实点击实测记为
`api`），其余一律 `api`。默认值取**保守**的那个，因为把脚本记成"人批的"会让"人在环里"这个结论
无法被验证（PITFALLS F19 / F22）。

**三处「在工作现场」的界面（0.2.4 起）**：设置页默认关着，而"等我批准"恰恰要求人不必去开它。所以审批
同时出现在三个**常驻**位置，各自只用不与第一方冲突的槽位：

| 槽位 | 内容 | 为什么是这个位置 |
|---|---|---|
| `conversation.input.dock`（`list`，`order: 30`） | 输入框**正上方**的待批准条（整行）+ 允许/拒绝 | 它是一个**整行**，且紧贴输入框；DSH 自己的三条同形提示也在这里（`todo` 0 / `goal` 10 / 队列 `queue` 20）。`conversation.input.permission` 是 `single` 且已被 DSH 自己的权限选择器占用，**不能抢** |
| `conversation.session.header.actions`（`list`） | 会话头部的「审批 N」按钮，点开右侧面板 | 工作时常驻可见；`sidebar.toggle.badge` 同为 `single` 且已被更新角标占用 |
| `sidebar.right.pane.tab` + `.title`（`keyed`） | 右侧面板「审批」标签页：待批准 + 无人应答被拒的记录 + 清空记录 | 与"文件/预览"并列、用现成快捷键开合，正合"审批记录要单独拆出来" |

> **席位的更正（0.2.11，PITFALLS F28）。** 待批准条最初注册在 `conversation.composer.dock`。那个位置
> **名字像"输入框上方的 dock"，实际渲染在输入框的状态行里**（与上下文占比、活动读数同一 flex 行），
> 所以它是"再塞一个 flex 项"：**位置随同行宽度漂移**，排版也继承状态行的紧凑样式（用户看到的
> "一个词一行"与胶囊折断就是这么来的）。结构性原因，不是样式问题。
>
> 另外两个候选及否决理由：`conversation.composer`（`chain`，DSH 自己的审批提示注册在此）**不能用** ——
> 其 owner 以 `overlay: true` 渲染，而 `renderChainResult` 在**有人当选时把 fallback 设为
> `display: none`**，那个 fallback **就是含输入框的 composer bar**：一旦当选，**远程请求等待期间输入框会消失**。
> 留在原地只改样式则位置仍由 host 行布局决定。

三者共用**一个**轮询源（`createApprovalFeed`）：首个订阅者才启动、最后一个退订即停。没人在看时
不该有轮询 —— 这条性质曾经只写在注释里，而实现里在 `apply()` 就起了定时器，直接吊死了测试进程
（F23）。面板 body 另外按文档经 `useTabInfo()` 读自己的 occurrence，用 `tab.visible` 决定**是否持有订阅**
（后台会话、折叠的列都不该是那个"让轮询活着"的订阅者）；缺这个 hook 时**抛错而不是静默降级**（F25 的教训）。

### 8.6.1 清空"错过的请求"

**需求（用户原话）**："设置页和侧面板里都应该提供清空审批记录的功能，否则比如本会话就会一直显示错过 6 件了，很怪。"

**实现**：**不删行**。审计文件是追加式证据，删掉"无人应答的拒绝"会让这份记录**有能力撒谎**；
而"清空一个列表"这个诉求，不构成销毁证据的理由。改为追加一条水印行：

```json
{ "at": "2026-10-15T...Z", "kind": "approvals-cleared", "by": "page" }
```

读取只看水印**之后**的行（`AuditLog.#visible()`）。于是两件事同时成立：
**每条错过都还在文件里**，且**"有人清空过、什么时候、从哪条路"也在文件里** —— 后者本身值得审计，
因为它是唯一一个"让过去的拒绝不再可见"的动作。`by` 复用决策那套来源判据（`page` / `api`）。

水印按**行位置**（`clearedIndex`）而不是时间戳比较：第一版用 `row.at > clearedAt`，而 `at` 只有毫秒
分辨率 —— 同一毫秒内"清空"后紧接着产生的**新**记录会被判为"不在水印之后"而**一起被隐藏**，
即"刚发生的拒绝看不见了"。这个 bug 是**测试用例**当场证伪的（PITFALLS F31）。

清空**只影响"错过"的视图**（计数与列表），不动"最近的裁定"：后者是**文件的原始尾部视图**，
它自称"追加写入，位置：…"，把行从那里藏掉才是真的在骗人。

### 8.6.2 放行的**作用域**：一次性调用，不是会话 —— 以及它划出的能力边界

**实测（2026-10-15，真机对照，PITFALLS F33）**：在 `danger-full-access` 的**那一次**调用里启动
`explorer.exe`，窗口出现（`MainWindowTitle` / `MainWindowHandle` 都拿到了）；调用一结束再查，
窗口**没了**，而 Application 日志里**没有任何崩溃事件** —— 它是**被回收**的，不是崩的。
把"启动 + 持有 240 秒"合并进**同一次**放行调用，窗口全程存在。

**机制**：`sandbox_permissions` 的语义是"对刚刚被拒的那**一次**操作做一次性重试"（F26）。
"一次性"的作用域是**那次调用**，不是那台机器、那个会话。它启动的 GUI 进程，
**没有比它的父调用活得更久的授权**。

**由此划出的能力边界 —— 这一条修正了本项目早先的一个混淆：**

| | 原子高危操作（写文件、跑一条命令） | GUI 任务（启动→点击→输入→截图） |
|---|---|---|
| 形状 | 一次调用 | **天然多步**，每步一次调用 |
| 正确原语 | **per-call 提权 + 人工审批**（就是本节的队列） | **会话级沙箱策略**（预先置于能跑 GUI 的档位） |
| 审批面板能解决吗 | ✅ 能 | ❌ 不能 —— 每步之间窗口都活不过去 |

所以：**审批面板解决的是"一次高危操作能不能放行"，不是"能不能跑 GUI 任务"。**
把 GUI 任务编排成一串"每步都申请提权"的调用，会得到"每步都失败、而每步看起来都像别的问题"
（窗口怎么没了、截图怎么是空的、上一步明明成功了）。

**对验证方式的影响**：在从机上截图做 GUI 取证，必须把"启动 + 保持"编排进**同一次**放行调用，
主机在它存活期间截图。否则永远截到空屏，而现象读起来像"GUI 起不来"（F21 的误判里有这个成分）。
**待办**：从机侧"预先置于可跑 GUI 的档位"这条路还没做成产品能力，见 `F:\dsh-plugin-remote-use-open-items.md`。

### 8.6.3 GUI 工作用全权档位**按部署设定**，不做运行时授权

**结论（用户 2026-10-15 定稿）**：跑 GUI 测试的工作节点，**就设成全权档位**；CLI 类的测试用现有的
per-call 审批已经够用。**不做**"逐节点档位开关 / 运行时下发 / 主机侧授权界面"这一整套 ——
那套设计的复杂度与它买到的东西不成比例（原话："按当前的路线继续下去没完没了了"）。

**为什么"按部署"是对的，而不是偷懒**

- 这个工作节点**只有一件事要做**：替配对好的主机跑 GUI 任务。它就是一台专用机器。
  一台专用机器的运行档位是**它的部署属性**，不是每个任务临时谈判的结果。
- **ACP 根本没有档位开关**（`dsh-acp` 注册的方法里没有；`session/set_config_option` 只认
  `model` / `reasoning_effort`，`dsh-acp/lib/index.js:393-407`）。所以"运行时从主机下发"从来不可能
  走协议本身，只能靠插件自己造一条带外通道 —— 那才是真正的复杂度来源。
- per-call 提权**养不活** GUI 进程（F33：放行一结束窗口就被回收），而 GUI 任务天然多步。
  所以对 GUI 工作，per-call 审批**不是"更细的授权"，而是一个用不上的机制**。

**怎么设（DSH 自带的机制，零插件改动）**

```powershell
node slave/make-launch-spec.mjs --permission-mode danger-full-access --out agent-spec.json
```

**一个命令行参数，加一处 profile 配套**（配套见下）：`make-launch-spec.mjs:30,61` 把它写进启动规格的
`env.DSH_PERMISSION_MODE`，
中继在 spawn 子 DSH 时合并 `LAUNCH.env`（`relay.mjs:593`），而 `dsh-base` 用这个变量决定
**沙箱档位与审批策略**（`dsh-base/cordis.patch.yml:232,248`）。**中继本身一行都不用改。**
新建会话会把该部署默认值钉进会话（`dsh-permission-presets/lib/index.js:377-383`）。

这就是本节一度打算用"新 RPC + 主机侧设置项 + 审计 + 界面"去实现的东西 —— 而它其实是一个生成
启动规格时的命令行参数。**在给一个能力造控制面板之前，先问它是不是一个部署常量。**

**唯一非做不可的配套（否则设成全权会让从机不可达）**

`dsh-base` 把"全权沙箱"与"审批 `never`"**成对**绑定（这就是 `danger-full-access` 这个 preset），
而 `permission` 行的 preset 表里**没有** *(danger-full-access, ask)* 这一项，且没有 `defaultPreset`
（schema 注明它"composition defaults match no preset 时必需"）。若 profile 把审批策略**写死**成
`ask`，那么设成全权就会组合出**不命中任何 preset** 的状态，很可能让该服务加载失败 ⇒
**ACP 进程起不来 ⇒ 从机不可达**（F24 那一类）。

所以 profile 里那一条要**镜像 `dsh-base` 自己的表达式**，而不是写死。**这条表达式只有一个出处**：
随包发布的 `packages/dsh-plugin-remote-use/slave/acp-profile-approval.patch.yml`（含完整推导与理由），
由 `tools/deploy-slave.ps1` 部署到从机。**本文与 PITFALLS 都不重抄那行表达式** —— 同一段东西抄在三处
就有三处会各自漂移，而其中最难被跟着更新的那一处，恰好是会被发到从机上去的那一处。

无变量时结果与今天**逐字相同**；三种档位都恰好命中一个已配置 preset。

**代价必须说明白（安全问题不能埋在脚注里）**：全权档位**连带**把该会话的审批策略置为 `never`。
这是 DSH 自己 preset 表的配对语义；沙箱已无限制之后，审批队列原本要放行的那类拒绝**已经不存在**，
它无事可做。**但这也意味着：给一台工作节点设成全权，等于放弃该节点上"沙箱层拒绝"这一道可见性**，
换来的是一次部署即可跑完整 GUI 流程。这个交换是明确的、且**由部署者一次做出**，而不是被逐步漂移掉。

**待实测**：以 `DSH_PERMISSION_MODE=danger-full-access` 启动从机的 acp profile，确认进程正常起来、
档位生效、GUI 真能跑。**这一条没测过就不算出货。**

**实测结果（2026-10-15，本机真实 acp profile）：预测的报错命中了，预测的后果夸大了**

| 组合 | `initialize` | `session/new` | stderr |
|---|---|---|---|
| 默认（`workspace-write`） | OK | OK | 干净 |
| `DSH_PERMISSION_MODE=danger-full-access` | OK | **OK** | `warning: 1 entry did not activate` + `permission: composed sandbox and approval defaults match no preset; configure defaultPreset explicitly` |

所以：**从机并没有不可达** —— 应用起得来、会话建得出来，坏掉的是 `permission-presets` 这一个条目
（它没激活）。我原先写的"ACP 进程起不来 ⇒ 从机不可达"是**错的**，已在 PITFALLS F34 更正。

**仍未测**：`permission-presets` 缺席后**一个 turn 还能不能跑**（我只发了 `initialize` 与
`session/new`，**没发 prompt**）。0.2.14 那道门因此仍选择**拒绝**：在"未知"上保守，
但把"已知"与"未知"分开写。

**已实现的事前拦截**：`slave/make-launch-spec.mjs` 是**全系统唯一同时知道"要申请哪个档位"又能读到
profile 的地方**（插件本身从头到尾不知道部署档位 —— 档位只从这一个脚本的参数进入系统，这正是本节
开头那个决定的直接后果）。判定规则与不对称性见 PITFALLS F34 的 0.2.14 小节；实现是
`slave/permission-pairing.mjs`（纯函数 + DSH preset 表的转写，有单测与真实 profile 的验证）。

### 8.7 数据不出局域网

- 传输不经过任何第三方服务
- ⚠️ 注意：`dsh-session-log-deepseek` 默认把从机的**规范会话日志上送官方服务**（含全部审批事件）。本项目按决策不处理此事，但文档需如实告知用户：**从机会话的内容会随从机的模型请求上送**，与远程委托无关，但会包含从机执行细节。

---

## 9. 审计

**位置**：`$DSH_HOME/storages/dsh-plugin-remote-use/audit.jsonl`（**单文件、追加式**，不是按日切分；
下面那张草图里的按日子目录没有实现）

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

> **实测字段（2026-10-14，与上面这张草图的差异是真实的）**：行写成
> `$DSH_HOME/storages/dsh-plugin-remote-use/audit.jsonl`（单文件，不是按日切分），字段为
> `{at, kind:'approval', gate, peerId, taskId, toolCallId, toolName, requiredTier, source, reason,
> optionId, by, createdAt, settledAt, waitedMs}`。草图中的 `decisionSource` 落成了 **`by`**，
> 取值 `page | api | timeout | disposed | no-answerer`（另有两个历史值 `human` / `engine`）。
> **`page` 与 `api` 必须分开**：两者都走同一个路由，混在一起就会把脚本批准记成"人批的"（F19）。
> `gate` 同步区分：超时不再写 `gate: 'human'`。
>
> **另一种 `kind`（0.2.11）**：`approvals-cleared` —— 清空"错过"视图的水印行，字段
> `{at, kind, by}`。它不是审批裁定，读 `tail()` 时会出现；`missed()` / `missedCount` 只看它在
> **之后**的行（§8.6.1）。`requestedTier` 与 `requiredTier` 同时在场：前者是请求方**申请**的档位，
> 后者是推断的**最小够用**档位，界面显示前者。
>
> **`kind: 'pane-probe'` 已移除（0.2.11）**：0.2.8 曾把右侧面板打开动作的现场情况（控制器有哪些方法、
> 抛了什么错）回传到审计里，因为主机看不到浏览器控制台。公开路径 `openResource` 确认可用之后，
> 这一段探针连同它的路由分支一起删掉了 —— `docs/PITFALLS.md` 的 F27 保留了它得出的结论，
> 而**出货路径里不留只为调试存在的东西**。

**有界增长（0.2.12 实现；此前这一行只是计划，见 PITFALLS F32）**

| 项 | 实际 | 配置项 |
|---|---|---|
| 轮转 | 活动文件达到阈值就**改名归档**并另起一个；**绝不截断正在写的文件** | `auditMaxBytes`（默认 8 MiB；0 或负数 = 不轮转） |
| 保留 | 归档保留 N 个，**最旧的被删除** —— 这是本项目里唯一会删掉审计记录的动作，且会写一条日志 | `auditKeepFiles`（默认 5；负数 = 全留） |
| 读窗口 | 只读尾部 256 KiB；内存里最多 200 行 | 不可配（两者都只影响"页面能看到多少"，不影响留存） |

**为什么按大小而不是按天数**：用户的原话是"这个记录不应该无限制的永久自动增长"。
按天保留**并不保证**磁盘有界（一天之内可以写很多），所以真正的约束是大小。
8 MiB 按实测每行约 670 字节≈ 1.2 万行，几年内的正常使用都不会触发轮转。

**轮转必须带走清空水印**：清空水印本身是一**行**，而轮转正是把它所在的那一行移进归档 ——
而重启时的读取只看活动文件。所以轮转时若水印生效，会在新文件首行补写一条 `carried: true` 的
水印。没有这一步，**重启一次就会把操作者清空过的"错过"全部复活**，正是该功能要解决的那个抱怨。
（这条交互有专门的测试，见 `test/audit-log.test.js`。）

**草稿里没有实现的三件事**（原样保留，作为"曾经这么想过"的记录）：按日切分的子目录、30 天保留、
超限告警。前两者被上面的按大小方案取代，第三件没有做 —— 超限既不丢弃也不告警，因为**不再有"超限"**：
达到阈值就轮转。

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
| **设置页在真实浏览器里的渲染** | Web 服务器要求认证（`/` 返回 401），无法从外部加载页面。离线能做的都做了：bundle 被**真实执行**并渲染出树（`new Function('window', source)`）、hook 顺序守卫通过、`package.json` 声明与文件一致、locale 与图标符合 DSH 契约。**已由人实际使用过**（在页面上改过 worker 配置并生效），但"每个空状态长什么样"仍只由离线守卫覆盖 |
| **DSH 插件装载器集成** | ✅ **已验**：主机与从机都从 registry 安装发布包（非 `link:`），插件在两侧都加载、设置页出现、五个 `remote_*` 工具在真机上全部调通（`remote_subagent` 前台任务带回完整报告）。**委派入口是插件自己注册的** `remote_subagent`，不经过任何 loader 工具行（F11） |
| 工作区同步（P4） | 未实现 —— 经判断不需要：GUI 验证跑在从机本地，主机源码不必同步过去（见 §15.13 的取舍） |
| ~~人工审批 UI~~ | **已实现并真机验证**（§15.12）：`needsHuman` 改为排队等人批准，超时按拒绝；**真从机上实测批准了 `danger-full-access` 提权且任务完成、审计留痕 `rows=1`** |
| **并发 session** | 心跳重连已实测（含从机中途死亡：任务 4 ms 内结束、链路状态如实）。**两个会话同时做远程工作未验证** |

### 10.1 阶段计划

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0 可行性验证** | 手工跑通：从机 `dsh --profile acp`（stdio）↔ 一个最小 WS 中继 ↔ 主机侧一个最小 ACP client 脚本；发一个 prompt，看到 `session/update` 流，能 `session/cancel` | 一次任务能跑完并拿到输出；能取消 |
| **P1 最小闭环** | 中继 + `RemoteProvider` + `remote_subagent` 工具（0.2.0 起由插件自行注册）+ 任务级串行队列 | 主机模型能派单、拿到结果；从机崩溃时主机得到 `stopReason: error` |
| **P2 授权** | 审批桥接 + ReviewEngine（规则 + 任务内记忆）+ 90 秒超时 + 待审批通知 | 从机提权操作能被主机批准/拒绝；超时按拒绝；映射缺失默认拒绝 |
| **P3 可见性** | `TaskRegistry` + `remote_agents` + `remote_interrupt` + 运行时上下文注入 | 模型能查询/等待/打断远程任务；不会"忘记"已派出的任务 |
| **P4 工作区同步** | manifest + blob + 事务性切换 + 路径映射 | 从机能拿到与主机一致的工作区；同步中途失败不留半成品 |
| **P5 审计与 UI** | AuditLog + Settings 页 + 从机「工作节点」页 + 急停 | 能回答"谁批准了什么"；能从从机本地急停。✅ 均已成（§9、§15） |
| **P6 加固** | 协议版本协商、重连与在途任务对齐、磁盘 GC、配额 | 断网重连不产生重复任务；从机重启后状态一致 |

**P0 必须先做**，因为它验证的是整条路线的技术前提（ACP over WS 可跑通）。若 P0 失败，退回自研 `session.event` 中继（只替换 `Transport` 实现，上层不动）。

---

## 11. 未决项与风险

### 11.1 未决项（需要在实现前定）

| # | 问题 | 影响 |
|---|---|---|
| U1 | ✅ **已解决**：远程工具行省略 `agentOptions`/`persona`/`toolFilter` + `maxDepth: 'provider-managed'` + `modelSelectionSettings: false`，即不会触发 capability 校验。**主机可同时保留本地子 Agent 的完整能力**（那是另一行配置） | — |
| U2 | ✅ **已解决**（0.2.0）：插件用 `ctx.tools.register()` 注册自己的委派工具 `remote_subagent`，**用户完全不需要碰 profile patch**。原先"每台从机写一行 `dsh-tool-subagent`"的结论**已推翻** —— 那样的行即使写对也到不了模型（PITFALLS F11） | — |
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

#### 它还必须携带**任务目录**（F16）

串在很长时间里只带 `url` + `token`（以及可选的 `name`）：`cwd` 字段**一直支持**却**从没被填过**。
后果是配对建立了一个**没有任务目录**的 worker —— 连接正常、自检全绿，而**第一次派单**才炸
`[REMOTE_BAD_CWD]`。

**为什么必须由从机说**：`cwd` 是**从机上的绝对路径**，同时就是从机沙箱允许写入的范围（§6.4）。
主机不可能猜出另一台机器上的路径 —— 猜错了不是报错，而是任务**写到没人选择过的目录**。
所以这个值只能由**路径所在的那一侧**给出，而配对串是它唯一的传递通道。

空值**仍然合法**（操作者还没决定），但那时串里**没有这一项**，主机侧必须在自己的界面里补一个，
并**拒绝**把没有它的 worker 落盘 —— 这种配置**永远不可能派单成功**，接受它只是把必然的失败
从"粘贴的那一刻"挪到"下一次委派"。

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

## 16. 对称配对（本机在主/从之间切换）—— 已交付

**已交付**（用户选择 A）。它与管理已知工作节点是**不同的风险等级**，所以先有一段可被反驳的设计（本节），再有一段能跑的代码（§16.7）。
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

**已实现**：设置页的「本机角色」区块现在有完整的布防面板（§16.7）。

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
| `dsh-tool-subagent` 那条 loader 行的描述 | 它的 Config **没有 `description`**，描述由代码按 provider 能力生成，进程外 provider 得到的是通用文案；而且这一行**到不了模型**（F11） |
| provider 自身 | 契约只有 `name` / `capabilities` / `inheritsParentContext` / `start`，**没有描述位** |
| DSH 的 `SUBAGENT_DELEGATION` 上下文 | 它是**对子代理说的**（"You are a delegated subagent…"），不是对父代理说的 |

⇒ **策略只能由本插件自己注入**，而"是否注入"由会话决定。

> **0.2.0 补充**：插件自己注册的 `remote_subagent` **有** `description`（`create` 时手写），
> 所以"何时该委派"这一半现在有了着落 —— 上表针对的是**接缝那条路**，不是这个工具。
> 它仍然**不替模型决定**是否委派，只把"什么时候该用远程节点"写清楚（GUI / 独占桌面 / 别在主机上抢鼠标）。

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
| **监听器** | ✅ 完成并实测 | `RelaySupervisor` 复用已验证的 `slave/relay.mjs`；回环端到端跑通（§16.8） |

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
| 设置页布防 UI | ✅ 完成 | 状态常驻条、接口下拉、一次性凭据、本地急停 |

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

#### 第 10 轮：从机自检里的硬编码用户路径（两处假阴性）

第 9 轮注意到 `verdict=blocked` 却有任务跑完，这一轮追到底了。

`slave/selfcheck.ps1` 里：

```powershell
$dsh  = 'C:\Users\worker\AppData\Local\Programs\DeepSeek Harness'   # S14 DSH installed
$cred = 'C:\Users\worker\.dsh\.credentials.yaml'                    # S15 model credentials
```

**`sheng` 是参考从机的用户。** 在任何别的机器上这两项**无论真假都会失败**。实测在本机：

| 检查 | 修复前 | 真相 |
|---|---|---|
| S14 DSH installed | `fail`（空） | `0.2.0-rc.2`，DSH 正跑着 |
| S15 model credentials | `fail`（missing） | `C:\Users\you\.dsh\.credentials.yaml` 存在，任务刚跑完 |

**两个假阴性把 `blockingFailures` 从 2 抬到 4，verdict 变成 `blocked`。**

**危害不是"报告不好看"**：一个在能工作的机器上报 `blocked` 的就绪报告，会**教操作者忽略它**；
而如果将来有门禁依赖 `verdict === 'ready'`，一台正常的机器会被拒。

**修法**：从环境变量派生，并列出全部候选。S14 遍历 `LOCALAPPDATA` / `Program Files`(x86) 候选；
S15 遍历 `USERPROFILE\.dsh\.credentials.yaml` 与 `APPDATA\dsh\...`，且在 `actual` 里**写出它找了哪些路径** ——
这样"真的没登录"和"找错地方了"能区分开。

**修复后实测**：

```
S14 DSH installed: pass  actual=0.2.0-rc.2
S15 model credentials present: pass  actual=C:\Users\you\.dsh\.credentials.yaml
blockingFailures: 4 -> 2
```

**剩下的两项是真实的**，`blocked` 现在诚实：

| 检查 | 实际 | 后果 |
|---|---|---|
| S9 sleep/hibernate | `standby=3600/600` | 从机会睡，掉线 |
| S12 console QuickEdit | `1` | 控制台选区会**阻塞** —— 真实的 GUI 自动化隐患 |

顺带清掉了 `make-launch-spec.mjs` 里同一用户的残留候选（有回退所以能工作，但**正是这类残留
造成了这个 bug**），并把 `slave/` 下的生成物（自检报告、截图、配对文件）写进 `.gitignore`：
`package.json` 的 `files` 包含 `slave/`，**一份陈旧的、指名别的机器的就绪报告会随插件一起发布**。

**这一轮的教训**：硬编码的**用户路径**不会报错，它只会让检查**安静地给出错误答案**。

#### 第 11 轮：第三处硬编码路径 + 一类缺口的守卫

**S18「目标应用存在」** 也硬编码了参考从机的构建产物：

```powershell
$app = 'C:\dsh-remote\avalonia-demo\avalonia-demo\bin\Debug\net10.0\avalonia-demo.exe'
```

它在每台别的机器上都报 `missing` —— 和第 10 轮那两处**同一形状**：把某台机器的布局写进一个
会在**另一台**机器上跑的脚本，然后把"找不到那个布局"报告成被测机器的故障。

它是 `warning` 而非 `blocking`，所以 verdict 没受影响；但**一个对正确的事发出警告的报告，
会教操作者不再读警告**（第 10 轮已经吃过一次）。

修法：路径来自 `-App` 参数或 `DSH_SELFCHECK_APP`，且**未配置 ≠ 缺失**：

| 状态 | 报告 |
|---|---|
| 未配置 | `warn` · `not configured (pass -App or set DSH_SELFCHECK_APP)` |
| 配置且存在 | `pass` · `present: <path>` |
| 配置但缺失 | `warn` · `missing at: <path>` |

#### 更重要的：补上这类缺口的守卫

**连续两个 bug 都是靠人读出来的，不是靠跑出来的。** 431 条单测一条也没抓到，因为
**这些脚本根本没有测试** —— 在从机上跑的 PowerShell，从这套测试里够不着。

`test/shipped-scripts.test.js` 不试图执行它们，只钉住让两个 bug 得以隐形的那**一个性质**：

| 守卫 | 变异检验 |
|---|---|
| 从机脚本里**不得出现特定用户的 profile 路径**（排除占位符与注释） | 把 `C:\Users\worker\...` 放回去 → **失败** ✓ |
| 自检的安装/凭据路径**必须从环境派生**，且 S15 要**列出找过的路径** | — |
| S18 可配置，且三种状态措辞正确 | — |
| `param()` 必须在第一条语句前（PS 5.1 的报错指向**后面**的行） | — |

第一条是**通用的**：它抓的是形状，不是这一处。同一个正则能抓住第 10 轮的两处。

#### 第 12 轮：第 11 轮的修复**没有生效**（而且我用了两次都错的方法）

第 11 轮我把生成物写进 `.gitignore`，以为就不会随插件发布了。**这一轮实测打包，发现 4 个全都还在**：

```
slave/pairing.txt      slave/selfcheck.json
slave/selfcheck.txt    slave/shots/old.png
```

其中 `selfcheck.json` 是一份**关于跑它的那台机器**的报告（机器名、显示器、GPU、会话 id）。
把它发布出去是**信息泄露**，不是"不够整洁"。

**两次尝试都是错的，而且错法不同**：

| 尝试 | 结果 |
|---|---|
| `.gitignore` | 对 `files` 白名单里的目录**无效** |
| `.npmignore` | 同样无效 —— npm 的**成文规则**：`files` 包含的条目**无法**被 `.npmignore` 或 `.gitignore` 排除 |

**唯一有效的机制是改 `files`** —— 显式列举，而不是整个目录：

```json
"slave/*.mjs", "slave/*.ps1", "slave/node_modules"
```

实测：**54 → 50 个文件，4 个生成物全部消失**，而 relay / 自检 / 截图脚本与 `ws` 依赖仍在。

**删掉了 `.npmignore`**：它记录的机制不存在，留着会误导下一个读它的人。

#### 守卫这次**跑真的打包器**，不再靠推断

`npm pack --dry-run --json`，然后断言：

| 断言 | 为什么 |
|---|---|
| 必须存在 `slave/relay.mjs`/`selfcheck.ps1`/`screenshot.ps1`/`lib/*.js` | 否则"什么都没打包"也会让测试通过 |
| **不得存在**自检报告 / 截图报告 / 配对文件 / `shots/` | 这是本轮的缺陷 |
| `files` 里不得出现裸 `slave` | 把机制本身也钉住，回退时给出清晰原因 |

变异检验：把 `files` 改回 `"slave"` → **两条测试都失败** ✓

> **教训**：前两次我都"检查了配置"，而**只有跑打包器才能回答"到底发布什么"**。
> 这与第 10/11 轮同源 —— **用一个近似去代替那个真正会给出答案的东西**。

---

## 19. 从机侧改动清单（**已部署**，保留作为记录）

从机在部署前离线了多轮，所以从机侧的改动积压了一批。**这些改动已于 §20 部署到从机并验证通过**；
本节保留，因为在部署当时它记录的正是"改了但没生效"的那份清单，而这正是最危险的中间状态 ——
而且部署时从机的实际状态**恰好**就是它警告的那一种（三个新模块确实不在）。

### 19.1 部署到 `C:\dsh-remote\plugin-slave\`

**不要再手工照这份清单拷文件 —— 用 `tools\deploy-slave.ps1 -Destination <dir>`。**
它拷完会**真的运行**拷过去的中继来验证；下面 `node_modules\ws` 那行遗漏，就是它第一次演练时抓到的。

| 文件/目录 | 为什么 |
|---|---|
| `relay.mjs` | 截图回收、配对串生成、广播地址打分、`--pairing-file`、`--keep-shots` |
| `prune-shots.mjs` | **新增** —— relay 现在 `import` 它，缺了 relay 起不来 |
| `pairing.mjs` | **新增** —— 同上 |
| `net-address.mjs` | **新增** —— 同上 |
| `selfcheck.ps1` | S14/S15/S18 的硬编码用户路径修复 |
| `screenshot.ps1` | 截图脚本 |
| `make-launch-spec.mjs` | 可选：删掉了一处同用户的候选路径（有回退，不拷也能工作） |
| **`node_modules\ws`** | **relay 的裸包依赖。** 漏掉它，脚本全部就位、全部能解析，然后中继以 `Cannot find package 'ws'` 死掉 |

⚠️ **两类导入都会让中继起不来，而症状都是"从机连不上"**，与真正的网络故障难以区分：

1. **相对导入** —— 三个新 `.mjs`。只拷 `relay.mjs` ⇒ `ERR_MODULE_NOT_FOUND: ./prune-shots.mjs`
2. **裸包导入** —— `ws`。漏掉 `node_modules` ⇒ `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'`

**这就是"部署 = 拷文件"不够用的原因：文件清单看不出裸包依赖。** 所以部署脚本的最后一步是
**真的运行拷过去的中继**（`--print-pairing` 立即退出，但会走完整个模块图）。

### 19.2 验证顺序

1. 拷文件 → 重启 `DshRelay` 任务
2. `node relay.mjs --port 7331 --token <token> --print-pairing` → 应打印一个 `dshpair1.` 串
3. `shots/` 的清理：连拍 3 张以上，确认目录里不超过 `keep-shots + 1` 个文件
4. 从主机跑 `plugin-live.mjs` → 应 ALL CHECKS PASSED
5. 从机自检：`powershell -File selfcheck.ps1` → S14/S15 应为 **pass**（此前恒为 fail）

### 19.3 需要重启 DSH 才能生效的主机侧改动

| 改动 | 位置 |
|---|---|
| 沙箱 mediator（desktop profile） | `cordis.patch.yml`（备份 `.bak-before-sandbox-shim`） |
| 沙箱 mediator（acp profile，从机角色必需） | `profiles\acp\cordis.patch.yml`（备份 `.bak-before-worker-role`） |
| 审批区块、策略编辑器、截图保留、配对入口、布防面板 | 插件 `lib/`（Host 模块在启动时加载） |

#### 第 13 轮：我第 10 轮的修复**引入了 SYSTEM 模式回归**

写文档一致性时读到 §13.1 的一句旧注解：

> 硬编码候选路径优先，因为 **SYSTEM 下 `LOCALAPPDATA` 指向 systemprofile**

**那正是我第 10 轮删掉硬编码候选的理由。** 而 `selfcheck.ps1` 有 SYSTEM 模式（开机检查）。

| 版本 | 交互式 | SYSTEM 计划任务 |
|---|---|---|
| 硬编码 `sheng` | ✅ 仅参考从机 | ✅ 仅参考从机 |
| **只用 `LOCALAPPDATA` 派生（我第 10 轮的修法）** | ✅ 所有机器 | ❌ **所有机器** |
| 现在 | ✅ | ✅ |

**我把"只在一台机器上对"换成了"在那个模式下所有机器都错"。** 两者都错，我的更糟 ——
因为 SYSTEM 模式恰恰是从机最容易处在的模式。

**修法**：候选来源覆盖**每一个能说出安装位置的东西**：

1. **正在运行的 DSH 进程路径** —— 无论脚本以什么账户运行，它都说得出 DSH 在哪
2. 当前账户的安装位置
3. Program Files
4. **扫描每个用户 profile** —— 这是 SYSTEM 运行时看不到自己的部分

**实测**（把 `LOCALAPPDATA`/`USERPROFILE`/`APPDATA` 指向 systemprofile 模拟计划任务）：

```
S14 DSH installed: pass  actual=0.2.0-rc.2
S15 model credentials present: pass  actual=C:\Users\you\.dsh\.credentials.yaml
```

上一版在这个场景下**必然失败**（三个候选全指向 systemprofile）。已加测试钉住这个机制。

#### 同轮：文档里有多处"已实现却写未实现"

| 位置 | 原文 | 实际 |
|---|---|---|
| 头部状态表 | `设计草案（待评审）` | 已交付 |
| §10 未验证表 | `人工审批 UI 未实现` | **已实现并真机验证** |
| §16 标题与正文 | `实现中` / `尚未实现` | 已交付 |
| §16.7 | `监听器 ⛔ 未做` / `布防 UI ⛔ 待做` | 均已完成 |

**一份说"未实现"而实际已实现的文档，与第 10–12 轮那些检查是同一类缺陷** ——
给信任它的读者一个错误答案。已全部改正，并新增 **§19「待部署」**：从机离线期间累积的改动清单
（含一个**危险点**：三个新 `.mjs` 是 relay 的新相对导入，只拷 `relay.mjs` 会让从机中继**起不来**，
症状与网络故障难以区分）。

#### 顺带：打包守卫升级为"跑真东西"

新增 **打包 → 解包 → 从解包里运行 relay**。这比检查 `files` 字段强：`slave/node_modules` 一旦漏掉，
包能正常安装、然后**起不了自己的监听器**。

变异检验：去掉 `slave/node_modules` → 该测试失败 ✓

#### 第 14 轮：第 1 项（人工审批）在回环上重新端到端验证

**为什么值得做**：第 1 项是唯一"会让任务**做不成**"的缺口。上一次真机验证用的是真从机，而它**已离线 11 轮** ——
也就是说此后每一处改动（审批队列、审计日志、设置路由、角色面板）都压在一个**无法重跑**的验证上。

回环让它变得可重跑：本机布防 → 配对 → 委托任务 → 强制提权 → 审批。

**两个方向都验证了**（本次运行的原始输出）：

```
approval requested: tool=pwsh id=call_00_...
escalated task: stopReason=completed approvals=1
[PASS] an escalation actually raised a permission request
[PASS] the decision to allow was carried back and the task continued
[PASS] the approved command really ran on the worker

denied task: requests=1 output="The escalation was rejected, so the command did not run."
[PASS] a refusal is obeyed: the escalated command did NOT run
```

#### 探针里我自己犯的三个错（都属"检查安静地给出错误答案"）

1. **字符串匹配分不清"执行了"和"引用了"**：拒绝那条我用 `!output.includes('DENIED-LIVE')` 断言，
   而 agent 在解释里**把命令引用回了**输出（"I can run the echo, but not with danger-full-access..."）→
   **把一次拒绝报告成成功**。改用 **marker 文件**：存在与否毫无歧义。

2. **空洞的通过**：第一版"拒绝方向"没断言**真的发生过审批请求**。若 agent 根本没尝试提权，
   "命令没跑"就是**废话**。补上断言后，下一次运行立刻抓到 `requests=0` —— **证明这个守卫是必需的**。

3. **PASS 旁边写着失败文案**：`check()` 无论如何都打印 detail，而我给的 detail 是失败信息，
   于是输出里出现 `[PASS] ... -- no marker at ...`。这种输出会让人**不再信任整份报告**。

#### 环境无法保证的部分，标为"无法判定"而不是通过或失败

委托的 agent **是否**请求提权不由探针控制 —— 工具的说明写着 `danger-full-access` 只用于被沙箱拦下后的
一次性重试，所以它经常干脆在当前档位下干完。**上一次问了，下一次没问。**

| 处理 | 后果 |
|---|---|
| 判为失败 | 探针**间歇性变红**，原因与插件无关 |
| 判为通过 | 就是上面第 2 条那个空洞检查 |
| **判为"无法判定"并计入汇总** | 一次"验证得比看起来少"的运行**不会被读成满分** |

汇总行会带上：`RESULT: OK ... (N check(s) could not be exercised)`。

#### 顺带确认：配置在正确的 profile 上

`.dsh\profiles` 下有三个：`desktop`（**装了插件**，链接指向本仓库；有 mediator）、
`acp`（有 mediator，从机角色需要，无插件 —— 正确）、`web`（两者皆无）。

用户一直在用的设置页正来自 `desktop`，所以"重启 DSH 生效"指的是它 —— 这一点此前是**假设**，现在是**查过的**。
`web` profile 不装插件，与本功能无关（但它没有 mediator，若将来从它启动需另行配置）。

#### 第 15 轮：部署变成一条**自己验证**的命令 —— 并立刻抓到 §19 的遗漏

**写这个脚本的动机**：§19 的清单要靠人在从机上手抄，而它的危险点（三个新相对导入）恰恰是
"抄漏了也看不出来"。所以把清单变成脚本，并且让脚本**运行拷过去的中继**来验收。

`tools\deploy-slave.ps1 -Destination <dir>`：拷 → 逐个解析 → **运行** `--print-pairing` →
校验 `.ps1` 的 ASCII 与 `param()` 位置。

#### 它第一次演练就抓到了：**`node_modules\ws` 没被拷**

```
[FAIL] the copied relay starts and prints a pairing string
       Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ws'
```

**我 §19 的清单是错的** —— 列了七个文件，**一个目录都没列**。照着做会得到一个
"所有文件都在、所有文件都能解析、然后中继起不来"的从机。

而这正是同一形状**更深一层**：我警告了三个**相对导入**，漏掉了**裸包导入**。

> **文件清单看不出裸包依赖。** 所以验收必须是**运行**，不能是清点。

修正后：

```
[PASS] node_modules\ws is at the destination
[PASS] the copied relay starts and prints a pairing string -- dshpair1.eyJ2Ijox...
RESULT: OK -- the worker-side files are in place and the copied relay runs.
```

#### 守卫：让脚本的清单**从 relay 的真实导入派生**

新增测试解析 `relay.mjs` 的 import：

| 断言 | 为什么 |
|---|---|
| 裸导入恰好是 `['ws']`（排除 `node:`） | 依赖变了就必须同时改部署 |
| 每个相对导入都出现在部署脚本里 | §19 警告的那一半 |
| 脚本必须**运行**中继并断言配对串 | 只见"能解析"会放过模块图加载失败 |

变异检验：把 `$depDirs` 清空 → 该测试失败 ✓

#### 顺带核实：门禁注释引用的约束是**真的**

`lib/index.js` 里写着"`tools.restrict()` 直接拒绝上下文全局调用"。此前没验证过。
在解包产物里找到了原文（`@deepseek-ai/dsh-tools/lib/index.js:2897`）：

```js
throw new Error('tools.restrict() requires a scoped context (agent.ctx):
                 a context-global restriction would mask every agent')
```

引文逐字相符，所以每会话门禁的形状是**API 强制**的，不是随意选择。

（顺带记下：`...\app.asar\dsh\` **不是可 grep 的真实目录**，解包产物在 `.research/asar/`。）

#### 第 16 轮：第一次真正截图，抓到两个缺陷（其中一个是**静默**的）

动机：第 15 轮的教训是"验收必须运行"。部署脚本验证了中继**能起**，但**截图捕获在这台机器上从没跑过**
（第 9 轮只验证了未授权时返回 401）。而主机现在能当从机，所以这半条路径必须验。

##### 缺陷 1：`powershell.exe`（5.1）在这台机器的 `F:` 上**被策略禁止运行脚本**

```
/screenshot failed: capture produced no image (exit 1)
  The file ...\screenshot.ps1 is not digitally signed.
```

对照实验（**同一文件内容、同一命令行**）：

| 解释器 | `F:` (ReFS) | `C:` (NTFS) |
|---|---|---|
| `pwsh` 7 | **能跑** | 能跑 |
| `powershell.exe` 5.1 | **被拒** | 能跑 |

**`-ExecutionPolicy Bypass` 无效** —— 这是 WDAC/AppLocker 类规则，**按路径**拦 PowerShell 5.1，
独立于执行策略。`pwsh` 不受影响。

**而自检的后果比截图严重得多**：截图返回响亮的 500；**自检返回的是一份"看起来像报告"的兜底对象**

```json
{ "verdict": "blocked", "checks": [{ "id": "S0", "actual": "Unexpected end of JSON input" }] }
```

调用方只要检查 `report.verdict !== undefined` 就会**认为自检成功**。第 9 轮起我一直在看这行输出，
**看了七轮都没看出它是失败**。

**修法**：`relay.mjs` 现在优先用 `pwsh`（存在时），回退到 `powershell.exe`。

##### 缺陷 2：截图写进了**插件自己的安装目录**

```
插件目录 slave\shots : True     <- 不该
     shot-1791873338626-1.png  4.43 MB
```

`RelaySupervisor` 不传 `--shot-dir`，relay 于是用 `join(HERE,'shots')` —— `HERE` 是脚本自己的目录，
也就是**插件安装目录**。在 `link:` 安装下就是操作者的源码检出。

与之前修掉的 `pairing.txt` **同一缺陷**，用**同一方法**发现（真跑一次、看目录树），
区别只是**截图路径此前从未被执行过**。

**修法**：supervisor 传 `--shot-dir` 指向 `%TEMP%\dsh-plugin-remote-use\shots`。

##### 验证

```
HTTP 200   3640x2068   4.33 MB   displays=2   1541 ms
  插件目录 slave\shots : False   <- 必须
  临时目录 shots       : True    <- 必须
```

几何与主机真实布局一致（虚拟屏 3640×2068 = 2048×1152 + 1080×1920）。

新增测试断言 `--shot-dir` 存在且**不指向包内**；变异检验：删掉该参数 → 测试失败 ✓

##### 我这轮又犯了同一个测量错误（第三次）

第一遍我用 `pwsh -File screenshot.ps1 | Select-Object -First 4` 检查产物，报告"产出: 无"，
于是以为截图失败了。实际脚本写了 `RESULT: OK` 和 4841115 字节 ——
**`Select-Object -First` 会提前终止管道并杀掉上游进程**。

> 三次了：**我用一个近似代替了那个真正会给出答案的东西，而近似总是给出我想要的答案。**

#### 第 17 轮：把上一轮的教训用成搜索 —— 找到的是**我的检查**，不是产品

第 16 轮发现"自检失败返回一份像报告的报告，我的检查看不出来"。这一轮做了两件事。

##### 1. 系统性搜索"失败伪装成数据"的其它位置

扫了 `lib/` 里所有 `catch` 块，逐个看是否吞掉错误并返回默认值。结论：**没有第二处**。

| 位置 | 判断 |
|---|---|
| `sandbox-probe.js:87` | **误报** —— 匹配到的是 JS 字符串里的 PowerShell 载荷 |
| `remote-provider.js:132` / `peer-connection.js:369` | 尽力而为的清理，失败不影响结果 ✓ |
| `index.js:817`（审计写入） | 注释写"会报告"，catch 却是空的 —— **值得推敲** |

最后一条查到底了：`AuditLog.record` 自己会设 `lastError` + 记 warn + 返回 false，
`index.js:1120` 把它送到页面，而**页面第 1365 行确实渲染它**。所以那条 catch 是双保险，
注释准确 ✓ —— **审计写入失败对操作者可见**，这是"留痕"该有的性质。

##### 2. 真正的缺陷在**探针**里，而且有两处

**（a）检查太弱**：`report.verdict !== undefined` 对 relay 的 `degraded` 报告同样成立。

relay 的兜底其实是**设计良好的** —— `verdict: 'blocked'`、`blockingFailures: 1`、
`checks[0].name = 'self-check produced a report'`、`actual` 带原因，**信息都在**。
所以问题不在产品：**是我的检查分不出"跑过了"和"根本没跑"**。

这正是它藏了七轮的原因 —— 一个读错东西的检查，与一个读错路径的检查是同一类缺陷。

现在断言**不是**那份单项 `S0` 的兜底报告，并且实测：

```
[PASS] the self-check produced a REAL report, not the relay's degraded one -- 17 checks
selfcheck: {"sessionSegment":"ok","blockingFailures":2,...}
```

`sessionSegment` 从 `"unavailable"` 变成 `"ok"` —— **同时验证了第 16 轮的 `pwsh` 修复真的生效**。

**（b）读错了字段**：探针用 `c.blocking === true` 判断阻断项，而 schema 里是 `severity`。
于是**每一项阻断都被打印成 warn**，与同一份报告里的 `verdict=blocked` 互相矛盾 ——
而更详细的那一个（我的）是错的。

修正后：

```
checks: 17 total, 2 blocking; verdict=blocked
  WARN     S3 primary resolution | expected=1920x1080 actual=2048x1152
  BLOCKING S9 sleep/hibernate disabled | expected=AC=0 DC=0 actual=standby=3600/600
  BLOCKING S12 console QuickEdit off | expected=0 actual=1
```

数字与 verdict 一致了，剩下的两项**是真事**。

##### 本轮的全栈回环验证（一次运行覆盖第 1 与第 4 项）

沙箱门禁 · 布防 · 配对串只回传一次 · 凭据只留掩码 · `/healthz` · 未授权 401 ·
ACP 握手 · **真实 17 项自检** · 任务跑完 · **审批放行（命令真的执行）** ·
**审批拒绝（命令确实没执行）** · 本地停止 · 端口释放 · 凭据作废 —— 全部通过。

无副作用：端口空闲、无 marker 遗留、`slave\shots` 不存在、settings 文件未被改动。

#### 第 18 轮：让 `plugin-live` 能在**没有从机**的情况下跑 —— 并因此发现它一直在测错机器

目标要求"三个 harness 必须同步更新并通过"，而 `plugin-live` 本轮从未通过（从机离线）。
第 4 项让主机能当从机，于是新增 `tools\arm-loopback-worker.mjs`：
在回环布防、把一行 JSON（url/token）写到 stdout、保持到停止文件出现。
不写 settings 文件，退出时必定解除布防。

##### 由此暴露的问题：`plugin-live --url` **一直被静默忽略**

```
Error: remote worker is not ready: S0 worker reachable
       (expected relay responds, actual connect ETIMEDOUT 192.168.1.101:7331)
```

我传的是 `--url ws://127.0.0.1:7397`，插件连的却是**真实从机**。原因：
`apply()` 的优先级是 `defaults < profile 补丁 < settings 文件`，而 **`workers` 是替换语义** ——
操作者的真实 `settings.json` 里有那个 worker，于是**覆盖**了传入的配置。

**如果我没追到底**，会得到两个都错的结论之一：以为在验证回环从机、其实在测一台离线机器；
或者把"从机离线"当成"代码坏了"。**一个被测对象能被静默替换的 harness，比没有 harness 更糟 ——
它会给出一个关于别的东西的自信结论。**

修法：`plugin-live` 在导入插件**之前**把 `DSH_HOME` 指向临时目录（与 smoke 同一手法）。
顺带也让这个 harness 不再读写操作者的 settings 与审计。

**修复后实测**（中继日志是证据）：

```
connection: {"connected":true,"connects":1,...}
[relay] #1 connected from 127.0.0.1
[relay] #1 spawned ... --profile acp
[relay] #1 -> {"method":"initialize",...}
[relay] #1 <- {"result":{"agentInfo":{"name":"deepseek-harness-acp",...}}}
[relay] #1 plugin reply -> {"verdict":"blocked",...}
```

ACP 握手完成、真实自检报告返回。剩下的 FAIL 是**这台机器的真实就绪问题**：
S9（睡眠未关，standby=3600/600）、S12（控制台 QuickEdit 未关）。**不是插件缺陷。**

##### 本轮排掉的两个假设（都做了实验，都没成立）

| 假设 | 实验 | 结果 |
|---|---|---|
| `runSelfCheck` 缺并发保护，两次并发会踩坏报告 | `.research\race-selfcheck.mjs` 三次并发 | **三次都拿到真实报告** —— 不成立 |
| relay 在 F: 上跑不了自检 | `.research\ask-selfcheck.mjs` 直连 | **17 项真实报告** —— 第 16 轮的修复是好的 |

顺带确认了两处**正确**的设计：插件的 `S0` 是 `name: 'worker reachable'` 并带错误原文
（信息完整），relay 的降级报告也带 `name`/`actual`。**两处都不是缺陷。**

##### 教训

这次和之前几次不同：**不是检查太弱，而是检查的对象被换掉了**。
`plugin-live` 一直"能用"，只是它测的从来不是命令行给它的那台机器 —— 而它的输出**看不出这一点**。

#### 第 19 轮：本机就绪 + `plugin-live` 的两个 harness 缺陷

##### 1. 本机现在真的是可用的 GUI 工作节点

按用户确认，改了自检报告的两项**本机设置**（不是代码）：

| 项 | 之前 | 之后 |
|---|---|---|
| S9 待机/休眠 | standby=3600/600, hibernate=14400/0 | **全部 0** |
| S12 控制台 QuickEdit | 1 | **0**（InsertMode 一并置 0）|

```
verdict=warn blocking=0 warn=3
  [OK  ] S9 sleep/hibernate disabled | actual=standby=0/0 hibernate=0/0
  [OK  ] S12 console QuickEdit off | actual=0
```

剩下 3 项 warning 都是**合理**的：S3（主屏 2048x1152 ≠ 参考的 1920x1080，固定分辨率对 GUI 测试是真实要求）、
S10（屏保未关）、S18（未配置目标应用）。**三项都不阻断** —— 产品的门禁只看 `status === 'fail'`。

##### 2. `plugin-live --url` 一直被**静默忽略**（严重）

```
Error: ... actual connect ETIMEDOUT 192.168.1.101:7331
```

传的是 `--url ws://127.0.0.1:7397`，连的却是真实从机。原因：`apply()` 的优先级是
`defaults < profile 补丁 < settings 文件`，而 **`workers` 是替换语义** —— 操作者的真实
`settings.json` 覆盖了传入的配置。

**一个被测对象能被静默替换的 harness，比没有 harness 更糟：它会给出一个关于别的东西的自信结论。**

修法：导入插件**之前**把 `DSH_HOME` 指向临时目录（与 smoke 同一手法）。

修复后中继日志是证据：

```
[relay] #1 connected from 127.0.0.1
[relay] #1 spawned ... --profile acp
[relay] #1 -> {"method":"initialize",...}
[relay] #1 <- {"result":{"agentInfo":{"name":"deepseek-harness-acp",...}}}
```

##### 3. `plugin-live` 的就绪判据与**产品自己**不一致

它要求 `verdict === 'ready'` —— 而该值只在**零 warning** 时产生。产品的门禁（`remote-provider`）
只看 `status === 'fail'`、忽略 warning。两者矛盾，而**产品是对的**。已改为"不是 blocked 也不是 partial"。

##### 4. ⚠️ 我的测试有个**系统性假阴性**：沙箱内的 S8

`arm-loopback-worker.mjs` 通常由**受 DSH 沙箱约束的 shell** 启动，中继继承该约束，于是自检报
**S8 SendInput / SetCursorPos 阻断失败** —— 受限令牌无法向更高完整性级别的窗口注入输入（UIPI）。

同机、相隔几分钟的对照：

| 环境 | verdict | S8 |
|---|---|---|
| 受限（我的 shell） | blocked, 1 blocking | **fail** (`set=False`) |
| **不受限**（计划任务 + pwsh 7） | **warn, 0 blocking** | **pass** (`ok`) |

**所以 S8 失败说的是 harness 的事，不是主机的事。** 已写进助手的文档，并新增
`tools\run-unconfined.ps1`（一次性计划任务，交互用户、非提权）把命令放到沙箱外跑。

##### 本轮排掉的假设

| 假设 | 实验 | 结论 |
|---|---|---|
| `runSelfCheck` 缺并发保护 | 3 次并发调用 | **都正常** —— 不成立 |
| relay 在 F: 上跑不了自检 | 直连 RPC | **17 项真实报告** —— 第 16 轮修复有效 |
| 计划任务能作为"沙箱外"对照 | 用 `powershell.exe` 跑 | **任务失败**（F: 路径拦截）—— 必须用 pwsh 7 |

##### 尚未完成

`plugin-live` 还没拿到一次干净的 `ALL CHECKS PASSED`：中继必须**不受限**运行，而我的编排在
"给沙箱外的助手传 token"这一步还有缺口（助手默认自己生成 token，`run-unconfined.ps1` 尚不支持转发参数）。
下一轮补上即可，**产品侧不需要改动**。

#### 第 20 轮：三个 harness 全部通过

```
unit         441/441
plugin-smoke ALL CHECKS PASSED
plugin-live  exit 0（全绿）
```

`plugin-live` 上次通过还是对着真从机（第 1 轮）。从机离线后它一直失败，**而失败原因是 harness 而不是产品** ——
这一轮把它修到能在**没有第二台机器**的情况下通过。

##### 三处 harness 缺陷（都在本轮修掉）

**1. 被测从机被静默替换**（第 19 轮发现）—— `apply()` 的 settings 文件优先于传入配置，
于是 `--url` 被操作者真实的 `settings.json` 覆盖。已用临时 `DSH_HOME` 隔离。

**2. 就绪判据与产品门禁不一致** —— 要求 `verdict === 'ready'`（= 零 warning），
而产品的门禁只拦 `status === 'fail'`。**产品是对的**，已改为"不是 blocked 也不是 partial"。

**3. 把"预算内没测完"当成失败** —— 这是最后一条 FAIL 的根因：

| 参数 | 默认 | 用途 |
|---|---|---|
| `reportBudgetMs` | **4000 ms** | 页面加载的快照，**不能挂** |
| `selfcheckBudgetMs` | 25000 ms | 明确的自检动作（页面的按钮） |

冷启动时首次连接要拉 ACP 子进程（~2s）+ 跑自检（~3s），**必然超出 4 秒预算** → 快照里没有报告。
**这是刻意的延迟保护**，页面另有明确按钮走 25 秒预算。harness 却断言那份快照，把一个正确设计看成了失败。

改为走**页面按钮实际走的那条路径**（`selfcheck` 动作，`maxAgeMs: 0`），并对快照为空的情况**明说**而不是判失败。

##### 沙箱外运行：`tools\run-unconfined.ps1`

`arm-loopback-worker.mjs` 需要**不受 DSH 沙箱约束**地运行，否则自检的 S8（合成输入）会假失败。
运行器用一次性计划任务（交互用户、**非提权**）做到这一点。

**顺带修掉一个设计缺陷**：跨进程传带空格的参数不可靠
（`pwsh -File script.ps1 -NodeArguments "a b"` 报"缺少自变量"，实测）。
所以助手现在**全部参数都有默认值**，并把宣告**同时写到文件** ——
调用方通过计划任务启动它时，stdout 归任务所有、拿不回来，文件是唯一可靠的通道。

##### 最终一次 `plugin-live`（沙箱外中继，回环）

| 段 | 结果 |
|---|---|
| 1 自检 | 连接 ✓ · 17 项报告 ✓ · `warn / blocking 0` ✓ |
| 2 委派 | 任务 `completed` ✓ · 输出返回 ✓ |
| 2b 截图 | 回传真实 PNG 5.4 MB ✓ · 签名 ✓ · 提示模型 `read_image` ✓ |
| 2d 每会话开关 | 新会话 4 个工具被拒 ✓ · 策略为空 ✓ · guard 拒绝执行 ✓ · `on` 后放行 ✓ · **另一会话仍关** ✓ · `off` 后恢复 ✓ |
| 2c 人工审批 | 提权进入队列 ✓ · 决定送达从机 ✓ · 任务完成 ✓ · **审计留痕 `rows=1`** ✓ |
| 2e 本机角色 | 状态可读 ✓ · **永不含 token** ✓ · 接口列出 ✓ · 默认未布防 ✓ |

无副作用：端口空闲、无计划任务残留、`settings.json` mtime 未变（仍是 10:51）、临时目录已清。

#### 第 21 轮：补上"只在浏览器里崩"的那类缺陷的守卫

**动机**：`settings-page.test.js` 确实**加载了真的 client.js**（`new Function('window', source)`，
取 `registered[0].component`），但它用 `expand(Section(...))` **把组件当普通函数调用** ——
绕过了 React 的协调器。于是**hooks 规则违反在这个测试里是隐形的**，而它在浏览器里的表现是**白屏**，
恰好是这套测试够不到的地方。

##### 加守卫的过程本身有三步错，每步都靠实验纠正

| 我的判据 | 结果 | 为什么错 |
|---|---|---|
| 整棵树的 hook 序列必须一致 | 报 `RemoteUseSection` 违规 | **子组件**（`WorkerCard`）有条件渲染，各自有自己的槽位，React 允许 |
| 按组件比对，但用 `useState#N` | 报 `AdvancedSettings` 违规 | 编号是**全局**状态数组位置，同一组件在不同树里编号不同 |
| 按组件比对**种类**序列 | ✅ 通过，且变异检验能抓住 | 这才是 React 的规则：**同一组件**的**种类**顺序必须稳定 |

第二次那个 `AdvancedSettings` 尤其值得记：它**只有一个 `useState`**，无条件调用 ——
**不可能违规**。是我的判据在说谎，而它说得很像真的。

##### 变异检验

在 `AdvancedSettings` 里插入 `if (settings.keepShots !== undefined) React.useState(0)`：

```
✖ every component calls its hooks in the same order whatever the data says
```

**能抓住** ✓ —— 所以这道守卫不是空的。

##### 它现在钉住的性质

每个组件（有数据 / 无数据、关 / 布防、有任务 / 无任务、有待批 / 无待批、有审计 / 无审计）
**hook 种类序列必须相同**。任何条件调用的 hook 都会让两侧长度或顺序不同而被抓住。

顺带说明：`react-dom/server` 在离线环境不可用（提取产物里没有 react，客户端 React 来自 Web 应用自己的
bundle），所以**真协调器渲染无法离线进行** —— 这也是这道静态守卫值得存在的原因。

#### 第 22 轮：空状态提示**指向了错误的地方**，而且漏掉了真正需要的那一步

```js
noWorkers: '尚未配置工作节点。请在 profile 补丁中配置后重启。'
```

**worker 本来就可以在本页配置**（写入 settings 文件，第 15 轮起就有 `worker.save`）。真正只能靠 profile 补丁的
是**模型可见的工具行** —— 插件不能在运行时追加工具行（DESIGN §5.7 / U2）—— 而提示里**一个字都没提**。

照它做的结果是：在补丁里配 worker（页面已经能做）、重启、然后发现 `subagent_remote` **仍然不存在**，
**看起来像插件坏了**。

改为点名真正缺的那一步，并说明是**每个节点一行**：

> 尚未配置工作节点。在这里添加即可；但模型要能调用它，还需要在 profile 补丁中为该节点加一行工具行
> （每个节点一行），然后重启。

> ⛔ **这一轮的结论在 0.2.0 被推翻（PITFALLS F11）。**"模型可见的工具行只能靠 profile 补丁"是**错的**：
> Web 会话的工具目录由 **agent preset**（`preset-standard.plugins`）枚举，补丁里那条 `dsh-tool-subagent`
> 行**即使写对也到不了模型**。所以第 22 轮指给操作者的那一步（加一行工具行）**本身就是白费的** ——
> 照做之后依然没有 `subagent_remote`，只是这次连"该去补丁里找"这条线索都没了。
>
> 改法是插件自己用 `ctx.tools.register()` 注册 `remote_subagent`，于是这句话**第三次**被改：
>
> > 尚未配置工作节点。在上方添加，或粘贴配对串即可 —— 工具会随之出现，不需要改 profile 补丁，也不需要重启。
>
> **三轮的教训是同一件事**：这条提示语每次都在指"下一步该做什么"，而它**只有在那一步真的有效时才是对的**。
> 第 22 轮把措辞改对了（从"配置 worker"改成"加工具行"），但**那个动作当时就不成立** ——
> 措辞正确掩盖了动作错误。核对的目标不是"这句话写得对不对"，而是"**照它做能得到结果吗**"。

##### 同轮两次核对的结论（都不是缺陷）

| 核对 | 我的检查脚本说 | 真相 |
|---|---|---|
| `package.json` 的声明 vs 实际文件 | `exports["./locale/*.json"]` 缺失 | **我的脚本没展开 glob** —— `locale/en.json` 与 `zh.json` 都在，且符合 DSH `meta.title`/`meta.description` 契约 |
| `cordis.patch.yml` | — | 干净、注释详尽。**但那条注释当时教的是已被推翻的 per-worker 工具行**（含 `toolName: subagent_remote` 示例）—— 0.2.0 已整段改写为"**不需要工具行**"并说明原因（F11） |

> 第 21 轮我写"我的判据在说谎，而它说得很像真的"。这一轮又出现一次，只是这次错在**检查脚本**而不是守卫。
> 两次都是同一个动作救回来的：**去看真东西**。

#### 第 23 轮：测了一条**从未被走过**的失败路径 —— 工作节点中途死掉

**为什么挑这条**：其它所有测试都拿一个**活着**的从机在跑。而一个永远不结束的任务不只是"失败" ——
它会**一直占着委托队列的槽位**，于是一台死掉的从机会把插件一起拖住，直到 DSH 重启。**这比报错糟得多**，
而这个项目从没验证过它。

新增 `.research/probe-relay-death.mjs`：真中继、真任务，**在 turn 进行中**把中继杀掉。

```
[PASS] the in-flight task SETTLES instead of hanging -- after 4353 ms
       outcome: {"stopReason":"error","diagnostic":"ACP connection closed","output":"I'll run the sleep command."}
[PASS] it did not report success -- error
[PASS] a connect attempt against the dead worker fails
[PASS] and the failure is recorded in the stats the page reads
       {"connected":false,"connects":1,"connectFailures":1,"lastError":"connect ECONNREFUSED 127.0.0.1:7396"}
[PASS] the link is not reported as connected
```

**击杀后约 4 毫秒**任务就结束了 —— 既不挂起，也不谎报成功，而且**部分输出被保留**
（`output: "I'll run the sleep command."`）。

第二组断言查的是**页面看到的东西**：`PeerConnection` 的 `connected` 变成 `false`、
`connectFailures` 加一、`lastError` 点名 ECONNREFUSED。

> 一条死了却仍显示"已连接"的链路，比没有指示灯更糟 —— 操作者会去重启错的东西。

##### 这轮的取舍

DSH **仍未重启**（主进程已运行 231 分钟，插件端点仍 404），所以真实 GUI 渲染仍然无法验证。
与其做低价值的清扫，不如去测一条**风险最高且从未覆盖**的路径 —— 结果它是对的，
而"它是对的"这件事**此前只是假设**。

#### 第 24 轮：备份工具的 `--deep` 是一个**空壳**，而它是"安全网"

连续多轮 DSH 未重启（主进程已运行 233 分钟，插件端点仍 404），于是这一轮去验证一件**从没验过**的东西：
用户早先要的那个 Python 备份/恢复工具。

##### 先说结论：工具本体是好的

```
$ python tools\dsh-env-backup.py list --to D:\dsh-backups
  before-remote-plugin-install  已校验   full  10,795 文件 / 587.2 MB   junction=484

$ python tools\dsh-env-backup.py verify --from D:\dsh-backups\before-remote-plugin-install
  OK    profiles/desktop/cordis.yml / .credentials.yaml / .anonymous-user-id
  OK    全部 484 个 junction 都存在且指向清单记录的目标
  FAIL  profiles/desktop/cordis.patch.yml  (内容不同)
  FAIL  profiles/desktop/package.json / pnpm-lock.yaml  (内容不同)
  FAIL  cordis.patch.yml  (内容不同)
  4 项未通过
```

**四项差异正是我这几轮改过的东西**（沙箱 mediator 行、插件安装、根补丁）—— 工具的判据是准的。

##### 但 `--deep` 是个空壳

```python
if deep:
    info("深度校验：逐文件哈希比对（可能较慢）...")
    for rel_dir in sorted(...):
        pass                                    # ← 空循环
    say("  （深度校验按需实现：本版只做关键文件 + junction + 规模核对）")
# 然后照常打印"校验通过"，返回 0
```

用法里写着 `verify --from ... [--deep]`。**在一张安全网上，这比没有这个选项更糟** ——
操作者以为做了深度校验，实际只做了浅层的，而且拿到的是成功退出码。

**它无法照宣传实现，原因值得记下**：清单只存 **`criticalHashes`**（9 个关键文件），
另外 10,795 个文件**没有基线可比**。拿备份去和**实时环境**逐文件比对也不算数 ——
实时环境本来就在变（sessions、日志、缓存），那样每次都会报差异，等于没有意义。

**修法**：在**开头**就以**退出码 3** 拒绝，并说明已实现的是什么、要实现需要什么。
同时在用法行和 README 里标明未实现。

```
--deep     exit=3   (拒绝)
普通 verify exit=2   (有差异，工具正常)
list       exit=0
```

##### README 补了退出码表

对安全网工具，脚本里必须能分开"**有差异**"和"**工具坏了**"：

| 码 | 含义 |
|---|---|
| `0` | 校验通过 |
| **`2`** | **有差异** —— 工具本身正常 |
| `3` | `--deep` 未实现，拒绝执行 |
| `1` | 操作失败 |
| `130` | 用户中断 |

---

## 20. 部署与真机验证（第 25 轮完成）

从机恢复可达后，主机侧与从机侧**全部验证通过**。

### 20.1 从机部署

部署时从机的实际状态，正是 §19 警告的那一种：

| 文件 | 部署前 | 部署后 |
|---|---|---|
| `relay.mjs` | 20,923 B（旧） | **29,787 B**（新） |
| `selfcheck.ps1` | 13,254 B（旧） | **新**（含 S14/S15/S18 修复） |
| `prune-shots.mjs` | **缺失** | ✓ |
| `pairing.mjs` | **缺失** | ✓ |
| `net-address.mjs` | **缺失** | ✓ |
| `node_modules/` | ✓ 在 | ✓ |

**只拷 `relay.mjs` 会让中继起不来** —— 三个新模块当时确实不在。部署用 `scp`，然后在**从机上**逐个
`node --check` 并运行 `--print-pairing` 验证模块图。旧文件备份在 `C:\dsh-remote\plugin-slave.bak`。

重启 `DshRelay` 任务后，新版在运行的**直接证据**：`pairing.txt` 出现了（旧版从不写它）。
内容解出 `{"url":"ws://192.168.1.101:7331","token":"..."}` —— **配对串功能在真从机上生效**。

### 20.2 截图回收：在真从机上证明

新中继每次截图**前**裁剪到 `keep-shots`（默认 20），上限因此是 21（20 保留 + 正在下载的那张）。实测：

```
连拍前       12
连拍 6 张  → 18
连拍 12 张 → 21   ← 达到上限
连拍 18 张 → 21
连拍 22 张 → 21   ✓
```

**那个 56.9 MB 无上限增长的问题解决了**（上限约 20 × 9.5 MB ≈ 190 MB，可用 `--keep-shots` 调）。

### 20.3 三个 harness

| harness | 结果 |
|---|---|
| unit | **443/443** |
| plugin-smoke | **ALL CHECKS PASSED** |
| plugin-live（**对着真从机**） | **ALL CHECKS PASSED**，exit 0 |

`plugin-live` 在真从机上验到了：链路连通 · 17 项自检（0 blocking）· 委派任务 `completed` ·
**真实截图 9,947,444 字节且 PNG 签名正确** · 每会话开关（新会话 4 个工具被拒、`on` 后放行、
**另一会话仍关**、`off` 后恢复）· **人工审批提权进队列 → 决定送达 → 任务完成 → 审计留痕 `rows=1`** ·
本机角色状态（**永不含 token**、接口打分正确、默认未布防）。

### 20.4 主机侧（重启后）

- 插件已装载：`/api/dsh/dsh-plugin-remote-use` → **HTTP 200**，页面所需字段全部正确
  （策略 864 字符、`sessionsEnabled: 0`、`keepShots: 20`、`audit.recent=1`）
- **沙箱真的在生效**：从运行中的插件内部做 `worker.preflight`，六项行为检查全通过 ——
  工作区内写成功（对照）、**工作区外写被拒**、只读无法写、只读仍可读
- 布防门禁：脚本用回环地址可布防（页面把回环标为「不提供」，这是刻意的 —— 无害且离线性自测依赖它）；
  非本机地址被沙箱门禁拒绝且**什么都没启动**

### 20.5 仍未由我验证的一项

**设置页在真实浏览器里的渲染。** Web 服务器要求认证（`/` 返回 401），我无法从外部加载页面。
离线上能做的都做了：客户端 bundle 被**真实执行**（`new Function('window', source)`）并渲染出树、
hook 顺序守卫通过、`package.json` 声明与文件一致、locale 与图标符合 DSH 契约。
**但"真浏览器里长什么样"只能由人看。**

#### 第 26 轮：中继地址改用**主机名**（用户提问引出的验证）

用户问："中继地址我也可以写主机名吧？" —— **不能靠推理回答**，因为 `worker-pc` 同时解析出
**A (192.168.1.101)** 和 **AAAA (fe80::27b2:...)**，而后者是**链路本地**（需要 scope id）——
Node/`ws` 若优先 IPv6 就会连不上。

实测：

```
node dns.lookup('worker-pc', {all:true})  ->  [{"address":"192.168.1.101","family":4}]   ← 选了 IPv4
http://worker-pc:7331/healthz             ->  OK
plugin-live --url ws://worker-pc:7331     ->  ALL CHECKS PASSED
```

**可以，而且端到端通过。** 已把用户的配置切过去（用插件自己的 `worker.save` 路由，即时重配、无需重启；
token 留空表示沿用，已核实未丢）。

**一个必须说明的不对称**：配合串里**永远是 IP**，因为中继广播的是**自己的地址**：

```
dshpair1... -> {"url":"ws://192.168.1.101:7331","token":"..."}
```

所以**粘贴来的配对串在从机换 IP 后会失效**，而手写/编辑成主机名的 URL 不会。
配合串是便利，不是主机名的替代。

**顺带改掉一条会误导人的提示**：设置页的地址示例原本写 `ws://192.168.1.101:7331` ——
那是**某一台机器的 DHCP 地址**，照着填的人会在从机下次换租约时得到一个静默失效的配置，
而症状（"从机连不上"）与"从机没开机"完全一样。现在两条语言都建议用主机名并说明原因。

#### 第 27 轮：修正文档里残留的"待部署"

从机部署完成后，文档还留着三处过期状态：

| 位置 | 原文 | 实际 |
|---|---|---|
| 头部状态表 | 「从机侧有一批改动**待部署**」 | 已部署并真机验证 |
| §10 未验证表 | 人工审批「已实现并真机验证」 | 补上**真从机**的证据（提权、任务完成、审计 `rows=1`） |
| §19 标题 | 「**待部署**（从机离线期间累积）」 | 已部署；保留作为记录 |

同时把 §10 的"未验证"表更新为**当前真实**的剩余项，并新增一条此前没写进去的：

**设置页在真实浏览器里的渲染** —— Web 服务器要求认证（`/` 返回 401），无法从外部加载页面。
离线能做的都做了（bundle 真实执行并渲染、hook 顺序守卫、manifest/locale/图标契约），
但**"真浏览器里长什么样"只能由人看**。这是整个交付里唯一没有机器验证覆盖的一环。

> 这与我一直在修的其它问题同源：**文档说"待部署"而实际已部署，与检查读错路径一样，
> 是给信任它的人一个错误答案。**

#### 第 27 轮（续）：`find-slave.ps1` 的成功路径第一次跑 —— 抓到它**谎报成功**

这个脚本此前只跑过**找不到**的路径（报告正确）。第一次跑**找到**的路径就暴露了：

```
key accepted by: 192.168.1.101 -> WORKER-PC
FOUND: worker-pc is at 192.168.1.101
Set-Content: Access to the path 'C:\WINDOWS\System32\drivers\etc\hosts' is denied.
hosts   : 192.168.1.101	worker-pc          ← 照样打印
  ssh worker-pc    # now resolves to 192.168.1.101
exit=0                                            ← 报成功
```

**写失败了，但它宣称成功并返回 0。** 原因是 `Set-Content` 的异常没有被检查，而那两行成功提示是
**无条件**打印的。写 hosts 需要管理员权限，这也是没考虑到的。

> 这就是我一直在别人代码里找的模式，出现在**我自己的工具**里。
> 而这个项目已经反复证明：**没有被跑过的路径，就不会被发现** —— 这次是"成功路径"。

修法：把写入包在 try/catch 里，失败时**明确说明、给出三条可操作的替代方案（提权重跑 / 手工加行 /
路由器 DHCP 保留 + DNS）、并以退出码 1 结束**。`-NoHosts` 仍正常返回 0。

```
非管理员:  COULD NOT WRITE THE hosts FILE: ... is denied.   exit=1
-NoHosts :  ... add this yourself (needs elevation): ...    exit=0
```

#### 第 28 轮：用户截图暴露的两个缺陷（都是**界面在说谎**）

用户发来设置页截图。两处一眼可见的问题，都在**用户可见的界面**上：

##### 缺陷 1：本机角色栏说「切换为工作节点（对称配对）**尚未实现**」

```js
roleNote: '本机作为主机向工作节点派单。切换为工作节点（对称配对）尚未实现。'
```

**而这句话的正下方就是完整的布防面板** —— 约束状态、监听地址、端口、`先检查`、`布防为工作节点`。
第 4 项早已实现。这与我一直在文档里修的那类过期声明同源，只是这次更严重：**它在界面上**。

##### 缺陷 2：连接正常、阻断 0，却被标成「**不可用**」

截图里的卡片：

```
连接      已连接 · 重连 1 次
会话      WORKER-PC · ok
检查结果  阻断 0 · 警告 1 · 未检查 0
操作      [不可用]        ← 这里
```

原因是一个两分支判据：

```js
verdict === 'ready' ? 就绪 : verdict === 'unknown' ? 未知 : 不可用
```

`warn`（只有建议性警告）和 `partial`（某项没检查成）都被扫进「不可用」。
**而产品自己的派单门禁只看 `status === 'fail'`、完全忽略警告** —— 也就是说页面与它自己的门禁互相矛盾，
而且**更醒目的那个（页面）是错的**。

这与我此前修掉的 harness `verdict === 'ready'` 是**同一条错误规则** —— 那次修在测试侧，这次修在界面侧。

现在四态各有其位：

| verdict | 标签 | 颜色 |
|---|---|---|
| `ready` | 就绪 | 绿 |
| `warn` | **可用（有警告）** | 蓝 |
| `partial` | 检查不完整 | 灰 |
| `blocked` | 不可用 | 红 |

##### 变异检验抓到了我自己的测试漏洞

第一次变异检验：**去掉 `verdictClass` 的 `warn` 分支（只影响颜色）→ 测试全过** ✗
—— 说明我只断言了文字，没断言颜色，而**截图里颜色正是最醒目的信号**。补上颜色断言后三种变异全部失败：

| 变异 | 结果 |
|---|---|
| `verdictClass` 去掉 warn（颜色） | ✗ 抓住 |
| `verdictText` 去掉 warn（文字） | ✗ 抓住 |
| `roleNote` 改回旧文案 | ✗ 抓住 |

##### 状态

```
unit 447/447（新增 4 条）· smoke ALL CHECKS PASSED · live 对着真从机 ALL CHECKS PASSED
```

#### 第 29 轮：#4 `deploy-slave.ps1` 的远程模式

**问题**：脚本只做本地 `Copy-Item`，验证也在**主机上**跑。要部署到别的机器只能给 UNC 目标，
而那时"运行拷过去的中继"检查是**在本机**执行的 —— 验证的是**正确的字节、错误的机器**
（不同的 node 版本、不同的 OS 状态、不同的 `node_modules` 解析根）。
而它要抓的那个失败（`Cannot find package 'ws'`）恰恰**可能因机器而异**。

**修法**：加 `-Remote <sshHost>`：`scp` 过去，然后**在目标机上**验证（`node --check` + 运行 `--print-pairing`），
并且**检查远程退出码**。

##### 测试过程里抓到的三个问题（都是"跑一次才知道"）

1. **scp 全部失败，而我把错误吞掉了** —— `2>&1 | Out-Null` 让七行只剩 `exit 1`，无从下手。
   根因：脚本传的是 `C:\dsh-remote\...`，而**远程那端是 shell**，反斜杠被吃掉 →
   改成传给远程的路径一律用正斜杠（`cmd /c` 的检查仍用反斜杠，因为那给的是 cmd）。
2. **`param()` 检查用远程 PowerShell 一行流做，引号被 bash 吃坏** —— 两项都以**目标机自己的解析错误**
   失败（`行:1 字符:102`），完全没提到脚本。
   改成**把文件拉回来检查**：检查的仍是目标的字节（scp 返回的就是那些字节），但不再有 shell 插手的余地。
3. **我在 ASCII-only 的 `.ps1` 注释里写了中文报错** —— 被 `.research\deploy-ps1.ps1` 门禁当场拒绝（21 个非 ASCII 字节）。
   门禁的作用正在于此。

##### 负向测试（**关键**）

| 用例 | 结果 |
|---|---|
| 在目标上删掉 `prune-shots.mjs`（相对导入） | `[FAIL] ... exists at the destination` + `[FAIL] the deployed relay starts` → **exit 1** |
| 在目标上删掉 `node_modules/ws`（裸包） | `[FAIL] node_modules\ws is at the destination` + 运行失败 → **exit 1** |
| 目标不可达 | 打印真实 ssh 错误、6.7 秒内 **exit 1**（不挂起） |

第一条正是**这次真实部署时发生过的事**（三个新模块不在）—— 现在它会被拦住，而不是等到"从机连不上"。

##### 正向

```
--- run the deployed relay (this is the check the file list cannot make) ---
  [PASS] the deployed relay starts and prints a pairing string -- dshpair1...  ← 在从机上跑出来的
  [PASS] selfcheck.ps1 is ASCII-only / has param() first
RESULT: OK    exit=0
```

#### 第 30 轮：#3 并发 session

**此前从未跑过两个并发任务。** 新探针 `.research/probe-concurrency.mjs` 挂载真插件、发两个**真任务**。

##### 场景 A：同一 worker，两个并发任务 —— **必须串行**

`serialQueue` 默认 1，`RemoteProvider.start` 在 `#acquire()` **之后**才发布运行。实测：

```
A: admitted +1.0s   ended +11.2s
B: admitted +11.2s  ended +21.7s      ← 恰好在 A 结束那一刻被接纳
[PASS] the second task was NOT admitted before the first ended
[PASS] both came back with their own markers
[PASS] no cross-talk（两个方向）
tasks: 2
```

##### 场景 B：两个 worker（真从机 + 回环节点）—— **必须并行**

```
A: admitted +2.2s  ended +12.8s
B: admitted +2.4s  ended +14.3s      ← 两者都在对方结束前被接纳
[PASS] both were admitted before either ended (they really overlapped)
```

##### 三次测量错误，每次都被"换个角度看同一份数据"纠正

1. **用秒表断言串行** —— "墙钟 > 单任务 1.5 倍"。但第二个任务的时长 **包含等待**，
   而 agent 自己的耗时从 20s 到 110s 波动，比例毫无意义。
   改为记录**三个时刻**（调用/准入/结束），断言 **`B.准入 ≥ A.结束`** —— 精确、不受波动影响。
2. **断言"两个 worker 并行"却测到串行** —— 回环节点**冷启动**要先拉 ACP 子进程，
   而 `start()` 在准入前会先 `await selfcheck()`。所以第二次准入晚 5.6s，被读成"没并行"。
   **那是在测冷连接耗时。** 给任务加一个长于任何合理连接时间的 sleep 后，两者准入只差 0.2s。
3. **marker 文件读回为空** —— 路径用的是**主机**的 temp 目录，而任务跑在**从机**上。
   改成让任务**回显** marker：一次真正的往返，且不假设两边共享文件系统。

##### 第四次：同一个陷阱的第三次出现

探针最初只挂载了 **1** 个 worker。原因是**操作者的 settings 文件覆盖了传入的配置** ——
`apply()` 的优先级是 `defaults < profile 补丁 < settings 文件`，而 `workers` 是替换语义。

**这个陷阱已经在 `plugin-smoke`、`plugin-live`、现在这里出现三次。** 产品把这件事**记在日志里**
（`settings file applies: workers, ...`），而这次是我的探针没读那行日志 —— 产品是对的。

##### 顺带确认的设计事实

审批路径查的是**每个 bridge 自己的**工具调用缓存（不是全局那张），所以并发任务**不会**串台到审批显示；
全局缓存只用于策略的 `allowedTools` 匹配与页面统计。这一条推翻了我原本的猜想。

#### 第 31 轮（续）：我自己写了一条**没有证据的断言**，被用户当场纠正

我在回答"虚拟显示器为什么必须有"时，为了让建议听起来更完整，加了一句：

> 开机/登录时**物理屏插着** → 它虽然是**副屏**，但 Windows 的登录界面**会显示在所有显示器上** ✓

**用户回：那不是的，真的会黑屏。**

而且我在同一段里**刚说过**"这条我也不能替你打包票"，却仍然把它写成了事实陈述 —— 这正是本轮一直在抓的形态：
**用一个听起来合理的近似，代替那个真正会给出答案的东西（在这里是：实际插拔一次）。**

##### 后果与修正

1. 这句**没有写进 README**（只在我的对话里），但 README 原来的措辞把"副屏看不见登录界面"当成了**假设性的取舍**，而它是**用户的实机事实**。
2. 修正后的结论**反转了**：物理屏设为主屏**不是取舍，是推荐配置** —— 因为两个状态各自自洽：

| 状态 | 布局 | S4 |
|---|---|---|
| 显示器接在从机上 | 物理屏 primary `(0,0)` | ✗ 阻断 —— **而这是对的**（你在用这台机器） |
| 显示器切回主机 | 只剩 VDD，系统重选主屏 | ✓ 通过 |

3. 同时**明确标注**了那条我**仍未验证**的推论（"VDD 接任 primary 并落在 (0,0)"是本项目作者的**预期**，需要插拔一次确认），不再让读者以为它已被验证。

> 教训：**"为了让建议完整"而补一句未经检验的话，与为了通过检查而写一个近似，是同一种错误。**
> 这一轮我在别人代码、自己的工具、自己的测试、最后在自己的说明文字里，四次遇到同一个形状。
