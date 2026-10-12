# 03 — ACP over WebSocket 作为「远程子 Agent」通道的可行性判定

- 调研者：teammate `acp-feasibility`
- 目标版本：DeepSeek Harness Desktop `0.2.0-rc.2`（Electron asar）
- 只读范围：`C:\Users\you\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（未修改）
- 新增解包产物：`F:\WorkSpace\dsh-plugin-remote-use\.research\sdk\`（`@agentclientprotocol/sdk@1.4.0` 全量 60 个文件，来自 asar 内 `dsh/node_modules/@agentclientprotocol/`）
- 扫描脚本：`.research/acp-schema-scan.mjs`、`acp-methods2.mjs`、`acp-unions2.mjs`、`acp-variants2.mjs`、`acp-defs.mjs`、`acp-raw.mjs`

---

## 0. 结论速览（先看这段）

| 判定项 | 结论 |
|---|---|
| ACP 能否承载「远程子 Agent」的基本回路（建会话 / 发提示 / 收更新 / 取消 / 关会话） | **能**，且服务端已随桌面版发货（`dsh --profile acp`），客户端 SDK 已随包发货且带 WS/HTTP transport |
| DSH 的 `dsh-acp` 有网络 transport 吗 | **没有，只有 stdio**。`dsh-acp` 硬编码 `ndJsonStream(process.stdout, process.stdin)`，无可注入的第二 transport |
| 需要改 DSH 才能跑 WS 吗 | **不需要**。最省事做法是在从机跑一个几十行的 WS↔子进程 stdio 中继，每连接拉起一个 `dsh --profile acp` |
| ACP 协议本身够用吗 | **够做 v1，但投影很粗**：协议有 `session/update` 流（文本块 / 工具调用生命周期 / plan / usage），DSH 实际只发其中 6 种（文本块 + 工具调用生命周期 + `config_option_update` + `usage_update`，**不发 plan/commands/modes**）；且**没有 token 级增量**，DSH 侧只从「已提交的 durable 事件」投影 |
| 最致命的语义缺口 | ①无鉴权（裸协议）；②远程工具的每一次调用**不会**进入主机 session 日志/子 Agent catalog；③`toolCall.kind` 恒为 `other`、`rawOutput` 永不被 DSH 填充；④无 `session/load` / modes / plans / commands / terminals / client fs；⑤prompt 内容块跨进程转换有损 |
| 最终推荐 | **v1 用「WS↔stdio 中继 + ACP v1 客户端」**（零 DSH 改动，最快可用）；**若要求真实流式与主机侧完整可观测性，则走自研 JSON-RPC（镜像 `session/event` 原生事件流）**，ACP 无法通过协议补丁弥补这一点 |

---

## A. `dsh-acp` 服务端能力

### A1. 如何启动 / 入口 / transport

**入口是 profile，不是子命令；transport 只有 stdio。**

- `dsh acp` 是 `dsh --profile acp` 的缩写：`asar/@deepseek-ai/dsh/lib/bin.js:129`
  ```js
  const expanded = first !== void 0 && !first.startsWith("-") && first !== "plugin" ? ["--profile", ...argv] : argv;
  ```
- profile 模板注册：`asar/@deepseek-ai/dsh-app-boot/lib/index.js:529-535`
  ```js
  const PROFILE_TEMPLATES = {
      acp:   { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"] },
      web:   { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] },
      headless: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] },
      sdk:   { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"] },
      "sdk-minimal": { bundles: ["@deepseek-ai/dsh-sdk-minimal"] }
  };
  ```
- `dsh-acp-app` 的命令行与生命周期：`asar/@deepseek-ai/dsh-acp-app/lib/index.js:20-38`
  ```js
  return new Command().name("dsh --profile acp")
    .description("Serve automation clients over Agent Client Protocol stdio.")
  ...
  program.action(() => { exitOnStdinEnd(ctx, "acp-app.stdin"); ctx.provide(ACP_APP_STARTUP_SERVICE, { accepted: true }); });
  ```
  → **stdin EOF 即退出**，因此进程生命周期天然被 stdio 牵着走。
- transport 硬编码（**唯一**一处）：`asar/@deepseek-ai/dsh-acp/lib/index.js:1319`
  ```js
  const stream = config.stream ?? ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  ```
  `config.stream` 只是测试注入点：`Config` schema 只声明 `provider`/`model`/`sessionListPageSize`（`lib/index.js:1063-1067`），生产 YAML 无法写入它。
- 整个 asar 内**未找到**任何 ACP 的 socket / WebSocket / HTTP transport 绑定：grep 关键词 `createWebSocketStream|AcpServer|server-sse|http-stream` 在 `@deepseek-ai/**` 下 0 命中（`@agentclientprotocol/sdk` 自身的实现除外）。
- 参考：`asar/@deepseek-ai/dsh-acp/README.md:55` — "`pnpm dsh --profile acp` starts the shipped stdio server."

> 注意区分：`dsh-acp/lib/index.js:213-248` 里的 `transport: "stdio" / "streamable-http"` 是 **MCP server 声明**的 transport，与 ACP transport 无关。

### A2. 实装了哪些 ACP 方法

服务端注册表（唯一权威处）：`asar/@deepseek-ai/dsh-acp/lib/index.js:1320-1323`
```js
const connection = agent({ name: "deepseek-harness-acp" })
  .onRequest(methods.agent.initialize, ...)
  .onRequest(methods.agent.authenticate, ...)
  .onRequest(methods.agent.session.new, ...)
  .onRequest(methods.agent.session.list, ...)
  .onRequest(methods.agent.session.resume, ...)
  .onRequest(methods.agent.session.close, ...)
  .onRequest(methods.agent.session.setConfigOption, ...)
  .onRequest(methods.agent.session.prompt, ...)
  .onNotification(methods.agent.session.cancel, ...)
  .connect(stream);
```

| ACP 方法 | DSH 侧 | 证据 |
|---|---|---|
| `initialize` | ✅ 实现（**忽略请求参数**，不回检客户端 protocolVersion） | `index.js:1141-1163`（签名 `async initialize(_params)`） |
| `authenticate` | ✅ 空实现，直接 resolve | `index.js:1165-1167` |
| `session/new` | ✅ | `index.js:1168-1207` |
| `session/list` | ✅（keyset 分页，默认 100） | `index.js:1256-1285`、`1046` |
| `session/resume` | ✅ | `index.js:1208-1255` |
| `session/close` | ✅ | `index.js:1296-1308` |
| `session/set_config_option` | ✅（model / reasoning_effort） | `index.js:1286-1295` |
| `session/prompt` | ✅（每 session 同时只允许 1 个 in-flight） | `index.js:1309-1312`、`796-798` |
| `session/cancel`（通知） | ✅ | `index.js:1313-1316` |
| `session/update`（**作为 agent 发出**） | ✅ | `index.js:1095-1102`（`await conn.notify(methods.client.session.update, notification)`） |
| `session/request_permission`（**作为 agent 发出**） | ✅ | `index.js:1116-1139`（挂在 `ctx.on("approval/request")`） |
| `session/load` | ❌ | 无注册；README `:76`/`:172` 明确 unsupported |
| `session/set_mode` | ❌ | 无注册；README `:76` "modes" unsupported |
| `session/delete` / `session/fork` | ❌ | 无注册；README `:76` |
| `providers/list|set|disable`、`logout`、`nes/*`、`document/*`、`mcp/*` | ❌ | 无注册 |
| `fs/read_text_file`、`fs/write_text_file`（agent→client 请求） | ❌ 从不调用 | 全文件 grep `fs.readTextFile|fs.writeTextFile` 0 命中 |
| `terminal/create|output|wait_for_exit|kill|release` | ❌ 从不调用 | grep `terminal\.` 0 命中（工具执行走 DSH 本地 bash/pwsh） |
| `elicitation/create` | ❌ 从不调用 | grep 0 命中 |
| `$/cancel_request`（协议级硬取消） | ❌ 未注册 handler；由 SDK `Connection` 内部自动处理 | `sdk/dist/jsonrpc.js:851-864` |

**关键含义**：DSH 当 ACP 服务端时，主机侧客户端**只需要实现 2 个方法**——`session/update`（通知）与 `session/request_permission`（请求）。fs/terminal/elicitation 全部不需要（也不应该）实现。

README 权威确认：`asar/@deepseek-ai/dsh-acp/README.md:76`
> "Unsupported surfaces are omitted or rejected: `session/load`, deletion, fork, additional directories, SSE or ACP-transport MCP, modes, commands, plans, terminals, client filesystem operations, and elicitation."

### A3. workspace / cwd 来源

**由客户端在 `session/new` 时指定（必须绝对路径），不是进程 cwd。**

- `asar/@deepseek-ai/dsh-acp/lib/index.js:1168-1182`
  ```js
  async newSession(params, signal) {
      assertOpen();
      validateWorkspaceParams(params);
      const sessionId = brandString(randomUUID());
      ... AcpSession.create(ctx, { sessionId, cwd: params.cwd, mcpServers: params.mcpServers, ... })
  ```
- 校验：`lib/index.js:1410-1413`
  ```js
  function validateWorkspaceParams(params) {
      if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`);
      if (params.additionalDirectories !== void 0 && params.additionalDirectories !== null && params.additionalDirectories.length > 0)
          throw invalidParams("additionalDirectories is not supported");
  }
  ```
- cwd 落进 session header：`lib/index.js:695-704`（`meta: { cwd: options.cwd }`）。
- `session/resume` 要求 cwd 与持久化 header **物理同目录**：`lib/index.js:1217`、`1415-1423`（`realpath` 比较，失败回退 `resolve` 字符串比较）。
- ACP schema：`sdk/schema/schema.json:6754`（`NewSessionRequest`，`required: ["cwd","mcpServers"]`，`cwd` 注释 "Must be an absolute path"）。

**对远程场景的直接后果**：`cwd` 是**从机视角**的路径。主机 `SubagentStartRequest` 的 parent session cwd（`dsh-subagent/lib/types/out-of-process.js:137-144` 的 `resolveChildCwd`）在从机上通常不存在 → 主机侧 provider 必须提供独立的远程 cwd 配置/路径映射，不能直接透传。

### A4. 并发 session

**一个连接支持多个并发 session，彼此独立。** 但一个进程只有一个连接（stdio）。

- 会话表：`asar/@deepseek-ai/dsh-acp/lib/index.js:1077`
  ```js
  const sessions = /* @__PURE__ */ new Map();
  ```
- `newSession` 每次生成新 `randomUUID()` 并 `sessions.set(sessionId, record)`，无数量上限、无 1:1 约束：`lib/index.js:1171`、`1192`。
- 并发限制是**每 session 一个 prompt**，而非每连接：
  `lib/index.js:796-798`
  ```js
  async prompt(params, imageEnabled, requestSignal) {
      this.assertActive();
      if (this.inflight !== void 0) throw invalidParams$1("a prompt is already in flight for this session");
  ```
- README 权威确认：`asar/@deepseek-ai/dsh-acp/README.md:60` — "One connection can run several sessions at once, each independent."
- SDK 的 WS 服务端同样按 `sessionId` 分路：`sdk/dist/ws-server.js:198-232`（`trackInboundRoutes` → `connection.ensureSession(route.session)`）、`sdk/dist/protocol.js:7-30`（`SESSION_SCOPED_METHODS`）。

**实际架构含义**：一条 WS 连接 → 一个从机 `dsh --profile acp` 进程 → N 个并发子 Agent 会话。这正是主机侧该采用的形状（长连接复用，避免每次委派冷启动 DSH）。

### A5. 协议版本

**ACP v1（`PROTOCOL_VERSION = 1`）。**

- `sdk/dist/schema/index.js:51`：`export const PROTOCOL_VERSION = 1;`
- `dsh-acp` 回包直接用它，且**不校验**客户端请求的版本：
  `asar/@deepseek-ai/dsh-acp/lib/index.js:1141-1148`
  ```js
  async initialize(_params) {
      imagePromptEnabled = await supportsAcpImagePrompts(ctx, config.provider, config.model);
      return { protocolVersion: PROTOCOL_VERSION, agentInfo: {...}, ... };
  ```
- 未走 v2 unstable 入口（`@agentclientprotocol/sdk/experimental/v2` 未被 `dsh-acp` import）。
- 因此 WS 服务端不会启用 JSON-RPC batch：`sdk/dist/ws-server.js:125-127`（只有协商到 version 2 才 `enableBatches()`）。

---

## B. ACP 协议本身够不够用

数据来源（只提取结构，不整段贴）：
- v1：`.research/sdk/sdk/schema/schema.json`（8879 行，`$defs` 265 个，`anyOf` → `Agent`/`Client`）
- v2 unstable：`.research/sdk/sdk/schema/v2/schema.unstable.json`（同样 265 个 `$defs`）
- 每个方法的判别信息在 `$defs.<X>.x-method` 与 `.x-side`（`x-side` = **接收/实现方**）

### B6. 完整方法 / 通知清单

> 方向约定：`x-side: "agent"` = 由**服务端（Agent）实现**，即 **客户端→服务端**；`x-side: "client"` = 由**客户端实现**，即 **服务端→客户端**；`x-side: "both"` = 双向。

#### B6.1 客户端 → 服务端（ClientRequest，20 个）

| 方法 | v1 schema $defs | 请求/通知 | 稳定性 |
|---|---|---|---|
| `initialize` | `InitializeRequest` (`schema.json:6210`) | request | stable |
| `authenticate` | `AuthenticateRequest` | request | stable |
| `logout` | `LogoutRequest` | request | stable |
| `session/new` | `NewSessionRequest` (`schema.json:6754`) | request | stable |
| `session/load` | `LoadSessionRequest` | request | stable |
| `session/resume` | `ResumeSessionRequest` | request | stable |
| `session/list` | `ListSessionsRequest` | request | stable |
| `session/prompt` | `PromptRequest` | request | stable |
| `session/set_mode` | `SetSessionModeRequest` | request | stable |
| `session/set_config_option` | `SetSessionConfigOptionRequest` | request | stable |
| `session/close` | `CloseSessionRequest` | request | stable |
| `session/delete` | `DeleteSessionRequest` | request | stable |
| `session/fork` | `ForkSessionRequest` | request | **UNSTABLE** |
| `providers/list` | `ListProvidersRequest` | request | **UNSTABLE** |
| `providers/set` | `SetProviderRequest` | request | **UNSTABLE** |
| `providers/disable` | `DisableProviderRequest` | request | **UNSTABLE** |
| `nes/start` | `StartNesRequest` | request | stable（内联建议，DSH 不实现） |
| `nes/suggest` | `SuggestNesRequest` | request | stable |
| `nes/close` | `CloseNesRequest` | request | stable |
| `mcp/message` | `MessageMcpRequest` | request | **UNSTABLE**，x-side=both |

#### B6.2 客户端 → 服务端（ClientNotification，9 个，无响应）

| 方法 | v1 schema $defs | 稳定性 |
|---|---|---|
| `session/cancel` | `CancelNotification` (`schema.json:8522`) | stable |
| `nes/accept` | `AcceptNesNotification` | stable |
| `nes/reject` | `RejectNesNotification` | stable |
| `document/didOpen` | `DidOpenDocumentNotification` | stable |
| `document/didChange` | `DidChangeDocumentNotification` | stable |
| `document/didClose` | `DidCloseDocumentNotification` | stable |
| `document/didSave` | `DidSaveDocumentNotification` | stable |
| `document/didFocus` | `DidFocusDocumentNotification` | stable |
| `mcp/message` | `MessageMcpNotification` | **UNSTABLE**，both |

#### B6.3 服务端 → 客户端（AgentRequest，12 个）

| 方法 | v1 schema $defs | 说明 |
|---|---|---|
| `session/request_permission` | `RequestPermissionRequest` (`schema.json:369`) | **DSH 会调用** |
| `fs/read_text_file` | `ReadTextFileRequest` | 仅当客户端声明 `fs.readTextFile` 能力 |
| `fs/write_text_file` | `WriteTextFileRequest` | 同上 |
| `terminal/create` | `CreateTerminalRequest` | 需要客户端 `terminal: true` |
| `terminal/output` | `TerminalOutputRequest` | |
| `terminal/wait_for_exit` | `WaitForTerminalExitRequest` | |
| `terminal/kill` | `KillTerminalRequest` | |
| `terminal/release` | `ReleaseTerminalRequest` | |
| `elicitation/create` | `CreateElicitationRequest` | |
| `mcp/connect` | `ConnectMcpRequest` | **UNSTABLE** |
| `mcp/disconnect` | `DisconnectMcpRequest` | **UNSTABLE** |
| `mcp/message` | `MessageMcpRequest` | **UNSTABLE**，both |

#### B6.4 服务端 → 客户端（AgentNotification，3 个）

| 方法 | v1 schema $defs | 说明 |
|---|---|---|
| `session/update` | `SessionNotification` (`schema.json:4946`) | **DSH 唯一的流式通道** |
| `elicitation/complete` | `CompleteElicitationNotification` | |
| `mcp/message` | `MessageMcpNotification` | **UNSTABLE** |

#### B6.5 协议级

| 方法 | v1 schema $defs | 说明 |
|---|---|---|
| `$/cancel_request` | `CancelRequestNotification`（`x-side: "protocol"`） | 与 `session/cancel` **不同**：SDK 收到后直接 abort 该 in-flight 请求的 signal 并让响应以 `-32800` 结束（`sdk/dist/jsonrpc.js:851-864`） |

#### B6.6 v2 unstable 的差异（重要）

- v2 `$defs` 仍然 265 个，但**删掉**了 `fs/read_text_file`、`fs/write_text_file`、全部 `terminal/*`、`session/set_mode`、`session/load`。
  - 验证：`.research/sdk/sdk/schema/v2/schema.unstable.json` 中 `"x-method": "fs/` 与 `"x-method": "terminal/` 各 0 命中。
- v2 重命名：`session/cancel`→`CancelSessionNotification`，`session/update`→`UpdateSessionNotification`，`authenticate`/`logout`→`auth/login`/`auth/logout`。
- 结论：**v2 更不适合**作为远程子 Agent 通道（v1 的 fs/terminal 能力至少还留了扩展位）。

SDK 侧常量清单（同一份，可直接 import）：`sdk/dist/schema/index.js:2-50`
```js
export const AGENT_METHODS = { initialize, authenticate, providers_list, ..., session_prompt: "session/prompt", session_cancel: "session/cancel", document_did_focus: "document/didFocus" };
export const CLIENT_METHODS = { session_request_permission, session_update, fs_write_text_file, fs_read_text_file, terminal_create, ..., elicitation_complete };
export const PROTOCOL_METHODS = { cancel_request: "$/cancel_request" };
```

### B7. 实时可观测性 与 取消

#### B7.1 实时可观测性：**协议支持，但 DSH 的投影很粗**

**通道**：服务端→客户端的 `session/update` 通知（`SessionNotification`），payload：
```jsonc
{ "sessionId": "...", "update": { "sessionUpdate": "<variant>", ... } }
```
（`sdk/schema/schema.json:4946`；变体联合 `SessionUpdate` 在 `schema.json:4977`）

`SessionUpdate` 全部 15 个变体（`schema.json:4977` 起，逐个 `oneOf` 分支）：

| 变体 | 引用类型 | 稳定性 |
|---|---|---|
| `user_message_chunk` | `ContentChunk` | stable |
| `agent_message_chunk` | `ContentChunk` | stable |
| `agent_thought_chunk` | `ContentChunk` | stable |
| `tool_call` | `ToolCall` (`schema.json:5262`) | stable |
| `tool_call_update` | `ToolCallUpdate` (`schema.json:407`) | stable |
| `plan` | `Plan` (`schema.json:5409`) | stable |
| `plan_update` | `PlanUpdate` | **UNSTABLE** |
| `plan_removed` | `PlanRemoved` | **UNSTABLE** |
| `available_commands_update` | `AvailableCommandsUpdate` | stable |
| `current_mode_update` | `CurrentModeUpdate` | stable |
| `config_option_update` | `ConfigOptionUpdate` | stable |
| `session_info_update` | `SessionInfoUpdate` | stable |
| `usage_update` | `UsageUpdate` | stable |
| `compaction_update` | `CompactionUpdate` | **UNSTABLE** |
| `compaction_summary_chunk` | `CompactionSummaryChunk` | **UNSTABLE** |

**assistant 文本增量**：`agent_message_chunk`，payload 结构
```
ContentChunk = { content: ContentBlock, messageId?: MessageId, _meta? }
ContentBlock = text | image | audio | resource_link | resource
```
推理增量用 `agent_thought_chunk`（同结构）。

**每一次工具调用**：`tool_call` + `tool_call_update`，结构如下（`schema.json:5262` / `:407`）

```
ToolCall        = { toolCallId, title, name?, kind?, status?, content?, locations?, rawInput?, rawOutput?, _meta? }   required: [toolCallId, title]
ToolCallUpdate  = { toolCallId, kind?, status?, title?, name?, content?, locations?, rawInput?, rawOutput?, _meta? } required: [toolCallId]
ToolCallStatus  = pending | in_progress | completed | failed        (schema.json:547)
ToolKind        = read | edit | delete | move | search | execute | think | fetch | switch_mode | other   (schema.json:492)
ToolCallContent = content(ContentBlock) | diff(Diff) | terminal(Terminal)
```

**但 DSH 实际发出的内容远粗于 schema 允许**（`asar/@deepseek-ai/dsh-acp/lib/index.js`）：

1. **没有 token 级增量。** 所有 update 都从**已提交的 durable session 事件**投影：
   `lib/index.js:878-909`
   ```js
   onSessionEvent(session, event) {
     if (event.type === "assistant/message") { ... for (const update of await assistantUpdates(this.ctx, session, event)) await this.notify({ sessionId, update }); }
     else if (event.type === "tool/call") { ... this.notify({ sessionId, update: toolCallUpdate(event) }) }
     else if (event.type === "tool/result") { ... this.notify({ sessionId, update: await toolResultUpdate(this.ctx, event) }) }
   }
   ```
   `assistantUpdates` 逐 block 产出**整条**已提交消息，而不是 delta：`lib/index.js:562-586`
   ```js
   for (const block of event.data.message.content) {
     if (block.type === "reasoning") { updates.push({ sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: block.text } }); continue; }
     const content = await assistantBlockToAcp(ctx, block);
     if (content !== void 0) updates.push({ sessionUpdate: "agent_message_chunk", messageId, content });
   }
   ```
   README 权威确认：`asar/@deepseek-ai/dsh-acp/README.md:92` — "raw provider deltas, retry attempts, DSH presentation data, and unsupported content stay off the wire."
2. **`kind` 恒为 `"other"`，`title` 就是 DSH 工具名**：`lib/index.js:592-601`
   ```js
   return { sessionUpdate: "tool_call", toolCallId: event.data.callId, title: event.data.name, kind: "other", status: "in_progress", rawInput: parseToolArguments(event.data.arguments) };
   ```
   → 客户端拿不到 `read`/`edit`/`execute` 分类，也拿不到 `locations`。
3. **`rawOutput` 永不被填充**；结果只能从 `tool_call_update.content` 的文本块里还原：`lib/index.js:608-624`
   ```js
   return { sessionUpdate: "tool_call_update", toolCallId: message.toolCallId, status: message.isError === true ? "failed" : "completed", content };
   ```
4. 成功/失败**有**明确表达：`status: "failed" | "completed"`（`:621`）。
5. 工具参数：`rawInput = JSON.parse(event.data.arguments)`，JSON 解析失败则原样返回字符串（`:638-644`）。
6. DSH **不发** `plan` / `available_commands_update` / `current_mode_update` / `session_info_update`；只额外发 `config_option_update`（`:774-779`）和 `usage_update`（`:626-636`）。

**判定**：实时可观测性「够用但不流式」——你能拿到每一次工具调用的名字/参数/成功失败，和整条 assistant 消息；**拿不到逐 token 输出**。若主机 UI 期望与本地子 Agent 同等的 token 流式体验，ACP 补不上。

#### B7.2 取消：双层语义

**(a) `session/cancel`（软取消，应用层，DSH 支持）**

schema 语义原文（`sdk/schema/schema.json:8423`，位于 `ClientNotification` 联合 `:8407` 内；另见 SDK 文档注释 `sdk/dist/acp.js:1191-1193`）：
> "Upon receiving this notification, the Agent SHOULD: Stop all language model requests as soon as possible; Abort all tool call invocations in progress; Send any pending `session/update` notifications; Respond to the original `session/prompt` request with `StopReason::Cancelled`."

DSH 的实现（`asar/@deepseek-ai/dsh-acp/lib/index.js`）：
- `lib/index.js:1313-1316`
  ```js
  cancel(params) { sessions.get(brandString(params.sessionId))?.cancel(); return Promise.resolve(); }
  ```
- `lib/index.js:867-872`：有 in-flight prompt 就取消 prompt，否则取消 autonomous work（`this.agent.cancel({kind:"user"})`）。
- `lib/index.js:990-997`：置 `cancelRequested`，abort 准入控制器，并 `agent.cancel()`。
- **响应速度不是即时的**：结算必须等 quiescence —— `lib/index.js:998-1013`
  ```js
  await inflight.admissionDone;
  if (inflight.messageQueued) { await this.agent.whenIdle(); await this.outputTail; }
  ...
  if (inflight.cancelRequested) { inflight.resolve("cancelled"); return; }
  ```
  即「当前 turn 完全停下 + 所有已排队 update 发完」才回 `stopReason: "cancelled"`。
- 「unknown session id 是 no-op」（README `:72`）。

**(b) `$/cancel_request`（协议级硬取消，DSH ≠ 处理，SDK 自动处理）**
`sdk/dist/jsonrpc.js:851-864`
```js
handleProtocolNotification(message) {
    if (message.method !== CANCEL_REQUEST_METHOD) return;      // "$/cancel_request"
    const requestId = cancelRequestId(message.params);
    const controller = this.incomingRequests.get(requestId);
    if (!controller || controller.signal.aborted) return;
    controller.abort(RequestError.requestCancelled({ requestId }));   // → 响应以 -32800 结束
}
```
DSH 的 prompt handler 会因此收到 abort signal 并走 `cancelPrompt("ACP prompt request cancelled")`（`lib/index.js:818-823`）。

**判定**：取消可行，但**不是瞬时的**，且 `session/cancel` 与 `$/cancel_request` 是两条不同路径（前者回 `cancelled` stopReason，后者回 JSON-RPC `-32800`）。主机侧建议两者都用：`session/cancel` 求语义正确，`$/cancel_request` + 本地超时兜底防挂。

### B8. `stopReason` 枚举 与 错误表达

**`stopReason` 枚举（`sdk/schema/schema.json:4340`，`PromptResponse.stopReason` required，`:4305`）**

| 值 | 语义 |
|---|---|
| `end_turn` | 正常结束 |
| `max_tokens` | 触达 token 上限 |
| `max_turn_requests` | 触达 turn 内 agent 请求上限 |
| `refusal` | agent 拒绝继续 |
| `cancelled` | 客户端 `session/cancel`，**MUST** 返回此值 |

**DSH 的映射（`asar/@deepseek-ai/dsh-acp/lib/index.js:539-551`）**

| DSH `TurnEndReason.kind` | ACP `stopReason` |
|---|---|
| `completed` | `end_turn` |
| `max-tokens` | `max_tokens` |
| `aborted` | `end_turn` |
| `interrupted` | `cancelled` |
| `blocked` / `error` | `end_turn` |
| default（可扩展） | `end_turn` |

⚠️ **这是个真坑**：DSH 把 `blocked` 和 `error` 也都映射成 `end_turn`（成功）。主机侧不能把 `end_turn` 无条件当成功。

**错误表达（JSON-RPC error）**
- 错误码枚举：`sdk/schema/schema.json:4818`（`ErrorCode`）= `-32700` parse / `-32600` invalid request / `-32601` method not found / `-32602` invalid params / `-32603` internal / `-32800` request cancelled / `-32000` auth required / `-32002` resource not found。
- SDK 侧构造器与文本：`sdk/dist/jsonrpc.js:975-1062`（`RequestError.parseError/invalidRequest/methodNotFound/invalidParams/internalError/requestCancelled/authRequired/resourceNotFound`）。
- DSH 实际使用：`invalidParams`(-32602) 与 `internalError`(-32603) 两种（`lib/index.js:1056-1062`）。
- 部分错误确实会导致 `session/prompt` **请求本身 reject**（不是回 stopReason）：`lib/index.js:1014-1025`
  ```js
  if (inflight.outputError !== void 0) { inflight.reject(internalError$1(`assistant output delivery failed: ...`)); return; }
  if (inflight.agentError !== void 0) { inflight.reject(internalError$1(`turn failed: ...`)); return; }
  const end = inflight.endReason;
  if (end === void 0) inflight.resolve("cancelled");
  else if (end.kind === "error") inflight.reject(internalError$1(`turn failed: ${end.error.message}`));
  else inflight.resolve(turnEndToStopReason(end));
  ```

**判定**：错误可分三类——①请求级 JSON-RPC error（可判定，含 `-32602`/`-32603`）；②`stopReason: cancelled`；③其余一律 `end_turn`（**信息丢失**，需要靠「无输出」启发式或额外的 `usage_update` 判断）。

### B9. 客户端需要实现的能力（主机侧 ACP client 的工作量）

**ACP 定义的客户端能力（`ClientCapabilities`，`sdk/schema/schema.json:6264`）**

```
ClientCapabilities = {
  fs?:           { readTextFile?: bool, writeTextFile?: bool },      // FileSystemCapabilities (schema.json:6364)
  terminal?:     bool,
  session?:      ClientSessionCapabilities | null,
  plan?:         PlanCapabilities | null,
  auth?:         AuthCapabilities,
  elicitation?:  ElicitationCapabilities | null,
  nes?:          ClientNesCapabilities | null,
  positionEncodings?: PositionEncodingKind[],
  _meta?
}
```

**DSH 当 ACP 服务端时实际期望客户端实现什么**（这是关键，且意外地少）：

| 期望 | DSH 是否依赖 | 证据 |
|---|---|---|
| `session/update` 通知处理器 | ✅ **必须**（否则所有流式信息丢失） | `lib/index.js:1095-1102` |
| `session/request_permission` 请求处理器 | ✅ **必须**（否则 approval 无法结算） | `lib/index.js:1116-1139` |
| `fs/read_text_file` / `fs/write_text_file` | ❌ 从不调用 | grep 0 命中 |
| `terminal/create|output|wait_for_exit|kill|release` | ❌ 从不调用 | grep 0 命中 |
| `elicitation/create` | ❌ 从不调用 | grep 0 命中 |
| `clientCapabilities` 内容 | ❌ **完全被忽略**（`initialize(_params)`） | `lib/index.js:1141`（参数名前缀 `_`） |
| `mcp/connect|message|disconnect` | ❌（MCP 由 DSH 侧自行 mount） | `lib/index.js:216-300`（`mountAcpMcpServers`，stdio/HTTP MCP 声明校验）、`:700-703`（会话建立时挂载） |

`session/request_permission` 的 payload 由 DSH 硬编码为两个选项（`lib/index.js:1121-1138`）：
```js
const params = { sessionId, toolCall: { toolCallId: callId },
  options: [ { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
             { optionId: "reject-once", name: "Reject",    kind: "reject_once" } ] };
return conn.request(methods.client.session.requestPermission, params)
  .then(({ outcome }) => outcome.outcome === "cancelled" ? "cancelled" : (outcome.optionId === "allow-once" ? "allowed-once" : "rejected"));
```

**工作量结论**：主机侧 ACP client 的**协议面**非常小（2 个 handler），官方示例就是完整参照实现：
`.research/sdk/sdk/dist/examples/ws-client.js:5-22`
```js
class WebSocketExampleClient {
    async requestPermission(params) { return { outcome: { outcome: "selected", optionId: params.options[0]?.optionId ?? "allow" } }; }
    async sessionUpdate(params) {
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk") { process.stdout.write(update.content.type === "text" ? update.content.text : ""); return; }
        console.log(`[${update.sessionUpdate}]`);
    }
}
```
真正的成本在 **provider 侧的语义适配**（见 D14/D15），不在 ACP client 本身。

### B10. 鉴权 / 配对

**协议里没有任何内建认证机制（token / 密钥 / 握手证明）。** 已确认：

1. `InitializeRequest`（`sdk/schema/schema.json:6210`）字段仅：`protocolVersion`(required)、`clientCapabilities`、`clientInfo`、`_meta`。**没有 credential 字段**。
2. `InitializeResponse`（`schema.json:2525`）字段：`protocolVersion`、`agentCapabilities`、`authMethods`、`agentInfo`、`_meta`。
3. `AuthMethod`（`schema.json:3380`）只有两种，都**不是**协议内凭据：
   - `AuthMethodTerminal`：客户端**另起一个交互式终端进程**跑 agent 程序做登录（"A zero exit status signals success"）。
   - `AuthMethodAgent`：agent 自己通过 `authenticate` 方法处理。
4. DSH 明确声明**不需要认证**：`asar/@deepseek-ai/dsh-acp/lib/index.js:1162` → `authMethods: []`，`authenticate` 空实现（`:1165-1167`）；README `:65` — "Immediate success; the server requires no authentication."
5. SDK 的网络 transport 把认证**完全推给外层**：`createWebSocketStream(url, { headers })`（`sdk/dist/ws-stream.js:26-48`）、`createHttpStream(url, { headers, cookies })`（`sdk/dist/http-stream.js:19-44`）。示例里 `Authorization: Bearer example-token` 只是自定义 header（`sdk/dist/examples/ws-client.js:24-26`），协议不解读它。
6. `-32000 authentication required` 错误码存在（`schema.json:4818`），但那是 agent 拒绝服务的表达，不构成认证方案。

**判定**：**确认无内建认证**。任何部署必须自己在 transport 层补（token header / mTLS / SSH 隧道），并且——注意 DSH 桌面版自己都拒绝 `--host 0.0.0.0`（`asar/@deepseek-ai/dsh-web-app/lib/startup.js:40`，见 C13）——威胁模型是「远程代码执行」。

---

## C. 网络 transport 可行性

### C11. SDK 的 WS / HTTP transport：导出什么、怎么用

先纠正一处前提：**包里没有 `dist/ws-client.js`**（asar 内 60 个文件逐条核对）。`./experimental/ws-client` 指向的是 `dist/ws-stream.js`。同理 `ws-server.js` 也**不是** package export 入口，只能通过 `server.js` 的 `AcpServer` 使用。

（asar 内该包全部 60 个入口经 `asar-tool.mjs sizes agentclientprotocol` 枚举确认。）

#### C11.1 客户端：`createWebSocketStream` — 入口 `@agentclientprotocol/sdk/experimental/ws-client`

`dist/ws-stream.js:26-28`
```js
export function createWebSocketStream(serverUrl, options = {}) {
    return new WebSocketStreamTransport(serverUrl, options).stream;
}
```
- 返回 `{ readable: ReadableStream, writable: WritableStream }`（`dist/ws-stream.js:77-95`），直接喂给 `ndJsonStream` 风格的 ACP connection。
- `options`：`{ WebSocket?: ctor, protocols?, headers?, cookies?: "include"|..., cookieStore? }`（`dist/ws-stream.js:42-48`）。
  - Node 下需传 `WebSocket` 构造器，或依赖 `globalThis.WebSocket`（`dist/ws-stream.js:244-252`）。Node 24 有内置 WebSocket；asar 内也 vendored 了 `ws@8.x`（`dsh/node_modules/ws/`）。
- 收发都是 **JSON 文本帧**：`sendMessage` 用 `JSON.stringify`（`:110`），收到后 `JSON.parse`（`:129`）；非法 JSON 回 `-32700`（`:132`）。
- 断线语义（重要）：**v1 重连 = 新建 transport 连接**，不复放在途消息；重连后需 `initialize` → 确认 `agentCapabilities.loadSession` → `session/load`（`dist/ws-stream.js:20-25` 注释）。**DSH 不实现 `session/load`**（见 A2），所以 DSH 场景下 ACP 层的「重连续期」不可用，只能重开会话或改用 `session/resume`（DSH 特有扩展，需自己处理）。

#### C11.2 客户端：`createHttpStream` — 入口 `@agentclientprotocol/sdk/experimental/http-client`

`dist/http-stream.js:19-21`（Streamable HTTP：POST 发消息 + SSE GET 收消息），`options`：`{ fetch?, headers?, cookies?, cookieStore? }`（`:39-45`）。不支持 JSON-RPC batch（`:67-69`）。

#### C11.3 服务端：`AcpServer` — 入口 `@agentclientprotocol/sdk/experimental/server`

`dist/server.js:15-71`
```js
export class AcpServer {
    constructor(options)     // options: { agent } | { createAgent } | { createLegacyAgent }  —— 三者恰一
    async handleRequest(req, options = {})   // Streamable HTTP: POST / GET(SSE) / DELETE
    prepareWebSocketUpgrade(options = {})    // → { connectionId, accept(socket), reject() }
    async close()
}
```
- `dist/server.js:36-65`：`prepareWebSocketUpgrade()` 先 `registry.createPendingConnection(agent)`，`accept(socket)` 时调 `handleWebSocketConnection(socket, { registry, agent, connection })`。
- HTTP 路由契约（`dist/server.js:72-145`）：`POST` 且无 `Acp-Connection-Id` header → 必须是 `initialize`，成功响应带 `Acp-Connection-Id`（`:164-166`）；后续 `POST` 必须带该 header（`:97-99`），失败 `400/404/202`；`GET` 需 `Accept: text/event-stream` 且带 `Acp-Connection-Id`（`:110-135`）；`DELETE` 断开（`:136-145`）。
- 协议头常量：`Acp-Connection-Id`、`Acp-Session-Id`（`dist/protocol.js:3-4`）。
- WS 首帧必须是 `initialize` 请求（含 id），否则 `1002` 关闭（`dist/ws-server.js:103-113`）；协商到 v2 才允许 batch（`:125-127`）；同一连接重复 `initialize` → `-32600`（`:180-193`）。

#### C11.4 服务端：Node 适配器 — 入口 `@agentclientprotocol/sdk/experimental/node`

`dist/node-adapter.js:3-48`
```js
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
export function createNodeHttpHandler(server, options = {}) { ... }              // → (req,res) => void
export function createNodeWebSocketUpgradeHandler(server, webSocketServer) { ... } // → (req,socket,head) => void，自动把 Acp-Connection-Id 塞进 101 响应头
```
`dist/node-adapter.js:22` 会把 `Acp-Connection-Id: <connectionId>` 追加到 upgrade 响应头。

#### C11.5 内部实现（不可直接 import）

`dist/ws-server.js:5-9`
```js
export function handleWebSocketConnection(socket, options) { const session = new WebSocketServerSession(socket, options); session.start(); return session; }
```
依赖 `options.registry`（内部 `ConnectionRegistry`）与 `options.agent`；`package.json#exports` **没有** `./dist/ws-server.js`（只有 6 个具名 subpath），因此**不能**从包外 deep-import。要用它就必须用 `AcpServer`。

#### C11.6 最小可用示例（官方，`ws-client` 示例，逐字）

`.research/sdk/sdk/dist/examples/ws-client.js:32-68`
```js
const cookieStore = new MemoryAcpCookieStore();
function connect() {
  return { stream: createWebSocketStream(serverUrl, { WebSocket: WebSocket, headers: authHeaders, cookieStore }) };
}
const { stream } = connect();
const { initialized, result } = await acp
  .client({ name: "ws-example-client" })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => client.requestPermission(ctx.params))
  .onNotification(acp.methods.client.session.update, (ctx) => client.sessionUpdate(ctx.params))
  .connectWith(stream, async (ctx) => {
      const initialized = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const session = await ctx.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
      const result = await ctx.request(acp.methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: "text", text: "Hello over WebSocket" }] });
      return { initialized, result };
  });
```
→ 共 ~35 行就打通「WS → initialize → session/new → prompt → 收 update」。

服务端最小用法（把 `AcpServer` 挂到任何 `http.Server`，以 `ws` 为例）：
```js
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createNodeHttpHandler, createNodeWebSocketUpgradeHandler } from "@agentclientprotocol/sdk/experimental/node";
import { WebSocketServer } from "ws";

const acpServer = new AcpServer({ agent: myAgent });          // myAgent: { connect(stream) {...} }
const wss = new WebSocketServer({ noServer: true });
httpServer.on("request", createNodeHttpHandler(acpServer));
httpServer.on("upgrade", createNodeWebSocketUpgradeHandler(acpServer, wss));
```

### C12. 这些 transport 是稳定 API 还是 experimental

**全部是 experimental 子路径入口。** 证据：`.research/sdk/sdk/package.json:25-58`

| subpath | 实际文件 | 稳定性 |
|---|---|---|
| `.` | `dist/acp.js` | **stable**（`PROTOCOL_VERSION = 1`，v1 stream surface） |
| `./experimental/v2` | `dist/v2/acp.js` | experimental（v2 unstable schema） |
| `./experimental/http-client` | `dist/http-stream.js` | **experimental** |
| `./experimental/ws-client` | `dist/ws-stream.js` | **experimental** |
| `./experimental/server` | `dist/server.js` | **experimental** |
| `./experimental/node` | `dist/node-adapter.js` | **experimental** |
| `./schema/schema.json`、`./schema/v2/schema.unstable.json` | schema | 数据文件 |

`package.json:36-55` 明确为这 4 个 transport 入口打上 `./experimental/` 前缀。**含义**：`ndJsonStream` + schema 是稳定面；WS/HTTP/Server 是「可用但随时可能改签名」，需要在集成处隔离一层 adapter。

另注：该包 `types` 指向 `dist/acp.d.ts`（`package.json:24`），但 asar 里**没有 `dist/**/*.d.ts`**（60 个文件里 0 个 `.d.ts`）。asar 打包裁掉了类型声明，因此本报告的类型全部从 `.js`（含 JSDoc）与 `schema.json` 反推。

### C13. 如果 `dsh-acp` 只能 stdio：把它接到 WebSocket 的最省事做法

#### 事实基线

- `dsh-acp` 的 transport 是硬编码单流：`asar/@deepseek-ai/dsh-acp/lib/index.js:1319`；`apply()` 只创建一个 connection（`:1320-1324`）。
- 想把它改成 WS，需要同时解决两件事：(a) 可注入 transport；(b) **每连接一个 connection**。
  (b) 是结构性障碍：`AcpServer.prepareWebSocketUpgrade()` 需要能对每个升级请求调用 `agent` 工厂创建新 connection（`sdk/dist/server.js:36-56`），而 `dsh-acp` 的 `apply` 在插件激活时就固定了一个 stream/connection。
- `config.stream` 也不可从 YAML 注入（`Config` schema 未声明该字段，`lib/index.js:1063-1067`）。
- 从机侧 DSH 无需任何改动即可提供完整 ACP 服务端：`dsh --profile acp`。

#### 方案对比

| 方案 | 改动面 | 工作量 | 评价 |
|---|---|---|---|
| **① 从机 WS↔stdio 中继（推荐）** | 只写一个新进程，零 DSH 改动 | ~80–150 行 Node | 复用已发货、已测试的 `dsh --profile acp`；一条 WS 连接复用 N 个 session；可在中继上加 token/TLS |
| ② 从机写 DSH 插件：`webserver.registerUpgrade('/acp')` + `AcpServer` | 需要**复刻** `dsh-acp` 的内部实现（因为它的 `apply` 不可注入 transport，且不支持多 connection） | 数百行 + 跟随上游维护 | 不推荐：等于 fork 一个上游包 |
| ③ 主机当 ACP server、从机当 ACP client | 需要从机实现一个 ACP **客户端**，DSH 没有 | 不现实 | 方向错误 |
| ④ 不走 ACP：从机 `dsh --profile sdk`(`dsh-sdk-jsonrpc-server`) + 中继 | 从机零 DSH 改动，主机要自研客户端与协议 | 中 | 事件更保真（`session.event` 全量 durable 事实），但 `dsh-sdk-client` 不在 asar 里，且 prompt 语义是「立即返回 `{messageId}`」而非「阻塞到 turn 结束」 |

#### 推荐：方案 ①

**从机（remote worker）** 跑一个极小中继：
1. `ws` 监听（或主动外连到主机，规避 NAT）。
2. 每个 WS 连接（经 token 校验后）`spawn("dsh", ["--profile", "acp"], { cwd: <workspace>, stdio: "pipe" })`。
3. WS 文本帧 ↔ 子进程 stdout/stdin 的**按行 NDJSON** 转发（`dsh-acp` 用的正是 `ndJsonStream`，即 newline-delimited JSON）。
4. 子进程退出 → 关闭 WS；WS 关闭 → `child.kill()`。
5. 在中继上加认证（`Authorization: Bearer <token>`）+ 网络加密（TLS 或 SSH 隧道 / WireGuard），因为协议本身零鉴权（B10）而这条通道等价于远程代码执行。

**主机（host）** 只需要：
```js
acp.client({ name: "dsh-remote-subagent" })
   .onNotification(acp.methods.client.session.update, ...)
   .onRequest(acp.methods.client.session.requestPermission, ...)
   .connectWith(createWebSocketStream(wsUrl, { headers: { Authorization: `Bearer ${token}` } }), op);
```

**理由（逐条）**
1. **零 DSH 改动**：`dsh acp` 是已发货的受支持入口（`dsh-app-boot/lib/index.js:530`、`dsh-acp/README.md:55`）。
2. **协议版本一致**：双方都是 ACP v1（`PROTOCOL_VERSION = 1`），SDK 直接对上。
3. **连接复用**：一条 WS = 一个从机 DSH 进程 = N 个并发 session（A4），可以避免「每次委派都冷启动一次 DSH」。
4. **可插认证**：认证由中继负责，不需要触碰协议。
5. **可降级**：中继是独立进程，失败不影响从机其他用途；也方便后续把 transport 换成 SSH 直连。

**必须注意的代价**
- 每个 WS 连接一次完整 Cordis/Dsh 启动（冷启动延迟；可通过主机侧长连接复用规避）。
- 从机需要独立的 `DSH_HOME` 初始化（`dsh --profile acp` 首次会从模板初始化 profile，`dsh-app-boot/lib/index.js:857`）与**独立的模型凭据**。
- 从机的 ACP `initialize` 返回 `authMethods: []`，不要指望协议层鉴权。
- 上游曾有 `dsh-subagent-acp` 这个「in-repo ACP 客户端 provider」，但**不在桌面版 asar 内**（`asar-tool.mjs list "subagent-acp|subagent-dsh-sdk|subagent-codex|subagent-claude"` → 0 命中），所以主机侧 provider 要自己写。
- 但它的**骨架可以白送**：`asar/@deepseek-ai/dsh-subagent/lib/types/out-of-process.js` 就是给这种进程外 provider 准备的公共零件（`NO_START_CAPABILITIES`、`assertPositiveFinite`、`resolveChildCwd`、`settleRunResult`、`subprocessRunHandle`），JSDoc 里还直接写了示例前缀 `subagent-acp`（`:59`）。

---

## D. 落地判定

### D14. 「WS ACP client + 包成 SubagentProvider」的总工作量 与 主要风险

#### 契约基线（来自 asar，非推测）

`.research/asar/@deepseek-ai/dsh-subagent/lib/typert.host.js:759-787`
```ts
export interface SubagentProvider {
    readonly name: string;
    readonly capabilities: SubagentCapabilities;
    readonly inheritsParentContext: boolean;
    readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>;
    start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>;
    prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>;
}
export interface SubagentRun { readonly id: SessionId; readonly localAgent: Agent | undefined; readonly result: Promise<SubagentResult>; dispose(): Promise<void>; }
export interface SubagentResult { readonly output: readonly ContentBlock[]; readonly structured?: unknown; readonly diagnostic?: string; readonly stopReason: SubagentStopReason; }
export type SubagentStopReasonMap = { completed:'completed'; aborted:'aborted'; error:'error'; 'max-tokens':'max-tokens'; refusal:'refusal' };
export interface SubagentStartRequest { label?; prompt: ContentBlock[]; parent: Agent; signal: AbortSignal; agentOptions?; outputSchema?; maxDepth?; toolFilter?; persona?; }
export interface SubagentCapabilities { agentOptions: boolean; outputSchema: boolean; depthLimit: boolean; toolFilter: boolean; persona: boolean; }
```
（`SubagentRunInfo/EndInfo` 的 `SubagentRunEndInfo` 见下方 D15。）

进程外 provider 的能力广告基线：`.research/asar/@deepseek-ai/dsh-subagent/lib/types/out-of-process.js:49-55`
```js
export const NO_START_CAPABILITIES = Object.freeze({ agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false });
```

#### 工作量分解

| 部件 | 估算 | 依据 / 复用 |
|---|---|---|
| WS transport | **≈0** | 直接 `createWebSocketStream`（`sdk/dist/ws-stream.js:26`） |
| ACP client 主体 | **40–80 行** | 只需 2 个 handler；有官方 35 行完整示例（`sdk/dist/examples/ws-client.js:32-68`） |
| session 路由（一个连接 N 个 run） | **60–120 行** | 按 `sessionId` 分发 `session/update`；每 session 一个 prompt 槽（DSH 保证串行：`dsh-acp/lib/index.js:796-798`） |
| prompt 内容块转换（DSH→ACP） | **60–150 行，且有损** | DSH `ContentBlockMap = {text, reasoning, image, file, 'tool-call', 'tool-addition', 'tool-removal'}`（`dsh-llm/lib/typert.host.js:273`）vs ACP `{text,image,audio,resource_link,resource}`；`dsh-acp` 只接受 text/resource_link/image，**audio 与 resource 直接 `invalidParams`**（`dsh-acp/lib/index.js:107-118`） |
| 输出聚合（update → `SubagentResult.output`） | **40–80 行** | 累积 `agent_message_chunk`；`toolCallId` 去重 `tool_call`/`tool_call_update` |
| stopReason 映射（ACP→seam） | **20–40 行，且有信息损失** | `end_turn/max_tokens/max_turn_requests/refusal/cancelled` → `completed/max-tokens/error/refusal/aborted`；但 DSH 把 `error`/`blocked` 也发成 `end_turn`（`dsh-acp/lib/index.js:539-551`） |
| 取消 & dispose | **40–80 行** | abort signal → `session/cancel` + 本地超时；`dispose()` → `session/close`（`dsh-acp/lib/index.js:1296-1308`）；建议用 `settleRunResult`/`subprocessRunHandle`/`assertPositiveFinite`（`out-of-process.js:63-218`） |
| 远程 cwd 解析 | **20–40 行** | 必须自配（`resolveChildCwd` 是本地路径语义，`out-of-process.js:137-144`） |
| 从机 WS↔stdio 中继（方案 C13①） | **80–150 行** | 含 token 校验、子进程生命周期、NDJSON 转发 |
| 打包/装载到主机 profile | 另计 | 主机侧要作为插件装进 profile（`dsh plugin --profile <name> add ...`） |
| **合计（v1，one-shot，不含 continuable）** | **≈ 350–700 行 + 中继 150 行** | |
| `prepareContinuable`（续期子 Agent） | **额外 200–400 行** | 无 `session/load`，只能用 DSH 特有 `session/resume`；childId/descriptor 持久化语义复杂（`typert.host.js:335-351`）。**建议 v1 不做**——不做就等于 `SubagentRuntime.prepareContinuable` 抛 `UNSUPPORTED_CAPABILITY`（`dsh-subagent/lib/index.js:3149-3153`），这是**明确的、可接受的**降级 |

#### 主要风险点（按严重度）

1. **零鉴权 + 零授权 = 远程代码执行面**。协议无认证（B10），DSH 桌面版自己都禁止 `--host 0.0.0.0`：
   `asar/@deepseek-ai/dsh-web-app/lib/startup.js:40`
   ```js
   if (options.host === "0.0.0.0") program.error("error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead");
   ```
   而 `dsh-host-webserver` 的 host 只接受 `127.0.0.1` / `0.0.0.0`（`asar/@deepseek-ai/dsh-host-webserver/lib/index.js:142`），`register()`/`registerUpgrade()` **无任何鉴权/CORS/CSRF**（README `:45`）。方案 ① 的认证必须自己做。
2. **无 token 级流式**（B7.1）。主机 UI 若期望与本地子 Agent 同样细腻的增量，协议补不上。
3. **远程工具调用不进主机 session 日志 / 子 Agent catalog**（见 D15 第 1 条）。
4. **错误语义丢失**：`blocked`/`error` → `end_turn`（B8）。主机 provider 需要额外启发式（无输出 / `usage_update` / 请求 reject）才能区分「成功但空」与「失败」。
5. **路径不可移植**：`cwd` 是绝对路径且从机有独立文件系统（A3）。
6. **冷启动成本**：每个 WS 连接 = 一次完整 DSH 进程启动。必须做连接复用，否则每次委派都是数秒级延迟。
7. **credential/配置分裂**：从机需要自己的模型凭据与 profile（`dsh-acp/lib/index.js:1063-1067` 的 `provider`/`model` 来自从机 profile 配置，如 `dsh-acp-app/cordis.patch.yml:19-21` 的 `deepseek-official`/`deepseek-v4-flash`）。
8. **experimental 面**：WS/HTTP/Server 三个 transport 都是 `./experimental/*`（C12），签名可能变。
9. **`session/load` 缺失** → ACP v1 的官方重连流程（`sdk/dist/ws-stream.js:20-25` 注释）不可用；断线即丢在途 turn（v1 明确不重放）。
10. **approval 会打到主机**：`ctx.on("approval/request")` 会把从机的审批请求发回主机客户端（`dsh-acp/lib/index.js:1116-1139`）。若主机客户端不答，从机 turn 会卡住。若主机无人值守，需要策略化自动应答（例如全 `allow-once`，但那是**降低**从机安全性）。

#### 与「自研 JSON-RPC over HTTP+SSE」的优劣

| 维度 | ACP over WS（方案 ①） | 自研 JSON-RPC over HTTP+SSE |
|---|---|---|
| 从机改动 | **零**（用发货的 `dsh --profile acp`） | 需要写并装载一个从机 DSH 插件（`webserver.register` + 自定义事件投影） |
| 从机启动成本 | 已有 profile，一条命令 | 需要维护插件包 + profile patch |
| 协议/版本 | 标准化 ACP v1，任何 ACP 客户端可复用；`@agentclientprotocol/sdk` 已含 WS/HTTP/SSE/cookie/reconnect | 自己定义、自己版本化 |
| 事件保真度 | **低**：整条消息、kind=other、无 rawOutput、无 plan/commands/modes、无 delta | **高**：可直接镜像 `session.event` 全量 durable 事实（`dsh-sdk-jsonrpc-server/README.md:48` 就是这么做的） |
| 与主机 session/catalog 集成 | 只能给 `subagent/start|end` 生命周期（`localAgent: undefined`） | 同样受限（进程外），但可自定义事件类型让主机侧额外渲染 |
| 工具/权限语义 | ACP `session/request_permission`（只有 allow-once/reject-once）+ `tool_call` 生命周期 | 可原样传递 DSH 的 approval 语义与工具卡数据 |
| 认证 | 必须自建（协议无） | 可一并设计（route registry 就在手边） |
| 工作量 | 小（客户端侧） | 大（客户端 + 服务端 + 协议 + 版本化） |
| 生态/可替换性 | 强（Zed / 任何 ACP 客户端） | 弱 |
| 未来维护 | 依赖 `experimental/*` 稳定性 | 完全自控 |

**裁决**：
- **要「尽快可用 + 通用」** → ACP over WS（方案 ①）。这是唯一能做到「从机零改动」的路。
- **要「真实流式 + 完整主机可观测性」** → 自研。ACP 的缺口（尤其无 delta、无 rawOutput、无 catalog 注入）**不是实现问题，是协议投影的设计选择**（`dsh-acp/README.md:92` 明说 raw provider deltas 不上线），补不上。
- 折中：**v1 用 ACP 打通，同时把 provider 的传输层抽象成一个接口**，将来换成自研 `session.event` 中继时只替换底下那层。

### D15. 协议补不上的语义缺口 与 绕法

先给出确切边界（`dsh-subagent/lib/index.js:3129-3142`）：
```js
const run = await provider.start(resolved);
const child = run.localAgent?.session;
if (child !== undefined) try { establishCatalogChild(request.parent.session, child.header, descriptor); } catch ...
return observeRun(this.emitLifecycle, name, request.parent, run);
```
进程外 provider 的 `localAgent === undefined`（`SubagentRun.localAgent: Agent | undefined`，`out-of-process.js:203-218` 的 `subprocessRunHandle` 直接写死 `localAgent: undefined`），所以**不会** `establishCatalogChild`——远程子 Agent 不会出现在主机 session 的子 Agent catalog 里。

主机侧唯一能看到的是生命周期边（`dsh-subagent/lib/types/lifecycle.js:56-77`）：
```js
const identity = { runId: SubagentRunId(randomUUID()), provider, id: run.id, local: run.localAgent !== undefined };
emit('subagent/start', identity, parent);
void run.result.then((result) => emit('subagent/end', { ...identity, stopReason: result.stopReason, ...(result.output.length === 0 ? {} : { lastAssistantMessage: result.output }) }, parent), () => emit('subagent/end', { ...identity, stopReason: 'error' }, parent));
```

#### 缺口清单与绕法

| # | 缺口 | 为什么协议补不上 | 实现时要怎么绕 |
|---|---|---|---|
| 1 | **远程工具调用不注入主机 session 日志 / 子 Agent catalog** | `establishCatalogChild` 只在 `run.localAgent !== undefined` 时执行（`dsh-subagent/lib/index.js:3130-3141`）；远程 run 无本地 Agent | 只能靠 `subagent/start|end` 边 + `lastAssistantMessage`；若要更丰富，得在主机侧自建一条旁路（例如 provider 自己往 `ctx` 里额外 emit 自定义事件，或把远程工具摘要拼进 `SubagentResult.diagnostic`）。**真正的解法是自研事件通道**，不是 ACP |
| 2 | **无法复用主机 session / 上下文** | ACP 的 `session/new` 只接受 `cwd`/`mcpServers`/`additionalDirectories`；没有「以某主机 session 为父」的概念 | `inheritsParentContext` 必须设为 `false`；prompt 里自行带上需要的上下文（受内容块转换损失，见 #4） |
| 3 | **`label` / `depth` / `toolFilter` / `persona` / `agentOptions` / `outputSchema` 无对应** | 这些是 DSH seam 概念，ACP 没有；`SubagentRuntime.assertCapabilities` 会在 `start` 前直接 reject（`dsh-subagent/lib/index.js:3173-3197`） | 用 `NO_START_CAPABILITIES`（`out-of-process.js:49-55`）如实声明全部 `false`，让 seam 在调用前就拒绝，而不是接受了再静默丢弃。`label` 只能留在主机侧 descriptor（`snapshotSubagentDescriptor`，`index.js:3120-3124`）。模型选择只能通过 provider 的 `agentRouteDefaults` 或从机 profile/`session/set_config_option` 配置 |
| 4 | **prompt 内容块有损** | DSH `ContentBlockMap = {text, reasoning, image, file, 'tool-call', 'tool-addition', 'tool-removal'}`（`dsh-llm/lib/typert.host.js:273`）vs ACP `{text,image,audio,resource_link,resource}`；且 `dsh-acp` 对 `audio`/`resource` 直接 `invalidParams`（`dsh-acp/lib/index.js:114-117`），`image` 还要求从机存在「精确路由 + 支持 image modality」否则拒绝（`:105-118`、`78-88`） | 只传 `text`（+ 必要时 `resource_link`）；`file` 降级为文本路径；`image` 需要读主机附件存储转 canonical base64，并接受「从机可能拒绝」。**必须在主机侧做显式白名单 + 失败诊断**，不要静默丢弃 |
| 5 | **无 token 级增量** | `dsh-acp` 只从已提交事件投影（`dsh-acp/lib/index.js:878-909`、`README.md:92`） | 无法绕过。主机 UI 只能按「commit 边界」刷新。若必须要 delta，只能自研通道 |
| 6 | **工具类型/位置/结构化结果丢失** | `kind` 恒 `"other"`，`locations` 不填，`rawOutput` 不填（`dsh-acp/lib/index.js:592-624`） | 从 `rawInput`（真实参数 JSON）+ `toolCallUpdate.content` 文本自行推断；或把 `title`（DSH 工具名）做主机侧映射表 |
| 7 | **无 `session/load` / modes / plans / commands / terminals / elicitation** | 从机不注册（A2、`README.md:76`） | 不做这些功能；`plan` 类 UI 空着 |
| 8 | **错误不可分辨** | `blocked`/`error` → `end_turn`（`dsh-acp/lib/index.js:545-546`） | 组合判定：`session/prompt` 是否 reject（`-32603` 表示 turn/output 失败）、`stopReason`、`result.output` 是否为空、`usage_update`。**必须显式写测试**覆盖「假 end_turn」 |
| 9 | **无续期子 Agent（continuable）** | 需要 `prepareContinuable`，且 ACP v1 无 `session/load` | v1 不做（provider 不实现该可选方法 → seam 抛 `UNSUPPORTED_CAPABILITY`，`dsh-subagent/lib/index.js:3149-3153`）。若要做，只能用从机 DSH 特有的 `session/resume`（`dsh-acp/lib/index.js:1208-1255`）自行维持 childId 映射 |
| 10 | **无鉴权/配对** | 协议内没有（B10） | 中继层做：bearer token（每从机一密）、TLS 或 SSH/WireGuard 隧道、来源 IP 白名单、连接数上限、命令白名单（可选）。**绝不能把裸 WS 端口暴露到不可信网络** |
| 11 | **路径不可移植** | `cwd` 必须绝对且从机本地（A3） | provider 暴露 `cwd` 配置（对齐 `validateConfiguredCwd`，`out-of-process.js:116-123`），或维护主机↔从机路径映射表；不要透传 host cwd |
| 12 | **approval 反向打到主机，可能挂死** | `ctx.on("approval/request")` → `conn.request(session/request_permission)`（`dsh-acp/lib/index.js:1116-1139`），主机不答则从机 turn 无法结算 | 主机客户端**必须**实现 `session/request_permission`（哪怕是自动 `allow-once`/`reject-once` 策略），并对该请求加超时 |

---

## 附录 A：未找到 / 未证实的项

| 事项 | 状态 | 搜过的关键词与路径 |
|---|---|---|
| `dsh-acp` 的 socket / WS / HTTP transport | **未找到（判定为不存在）** | grep `createWebSocketStream`、`AcpServer`、`server-sse`、`http-stream`、`WebSocket`、`registerUpgrade` in `asar/@deepseek-ai/**`；`asar/@deepseek-ai/dsh-acp/lib/index.js` 全文 |
| `dsh acp` 作为独立子命令 | **未找到（是 profile 缩写）** | `asar/@deepseek-ai/dsh/lib/bin.js`（commander 只注册 `plugin` 子命令，`:115-127`）、`dsh-app-boot/lib/index.js:529` |
| `dsh-subagent-acp` / `dsh-subagent-dsh-sdk` / `dsh-subagent-codex` / `dsh-subagent-claude-code` 包体 | **未找到** | `asar-tool.mjs list "subagent-acp\|subagent-dsh-sdk\|subagent-codex\|subagent-claude"` → 0 / 12967（与 Lead 前置结论一致） |
| `@agentclientprotocol/sdk` 的 `dist/**/*.d.ts` | **未找到**（asar 未打包类型声明） | `asar-tool.mjs sizes "agentclientprotocol"` → 60 files, 0 `.d.ts` |
| `dist/ws-client.js` | **未找到**（前提有误；`./experimental/ws-client` 指向 `dist/ws-stream.js`） | 同上 60 文件全枚举；`sdk/package.json:41-45` |
| `dsh-sdk-client`（SDK JSON-RPC 的官方客户端） | **未找到** | `asar/@deepseek-ai/` 目录枚举；`asar-tool.mjs list "dsh-sdk-client"` → 0 |
| ACP 内建认证 token / 密钥 / 配对 | **未找到（确认没有）** | `schema.json` `$defs.InitializeRequest` / `InitializeResponse` / `AuthMethod*`；`dsh-acp/lib/index.js:1141-1167`；`sdk/dist/ws-stream.js`、`http-stream.js` 的 `options` |
| DSH 上的 ACP v2 使用 | **未找到** | `dsh-acp/lib/index.js` 无 `experimental/v2` import；`PROTOCOL_VERSION = 1` |

## 附录 B：复现命令

```powershell
# 1) 解包 ACP SDK（只读 asar）
cd F:\WorkSpace\dsh-plugin-remote-use\.research
node asar-extract-all.mjs "node_modules/@agentclientprotocol/" "F:\WorkSpace\dsh-plugin-remote-use\.research\sdk" "dsh/node_modules/@agentclientprotocol/"

# 2) 方法/通知全清单（按 x-side 分类）
node acp-methods2.mjs

# 3) 各联合类型（ClientRequest/AgentRequest/... 成员）
node acp-unions2.mjs

# 4) 联合变体（SessionUpdate / StopReason / ToolKind / ContentBlock ...）
node acp-variants2.mjs schema.json SessionUpdate ToolKind ToolCallContent ContentBlock AuthMethod ErrorCode

# 5) 单定义字段与类型
node acp-defs.mjs schema.json ClientCapabilities AgentCapabilities NewSessionRequest ToolCall ToolCallUpdate PromptResponse

# 6) 原始定义
node acp-raw.mjs schema.json StopReason SessionUpdate
```
