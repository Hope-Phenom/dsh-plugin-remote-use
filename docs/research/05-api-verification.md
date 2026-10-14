# 05 — API 签名逐条核验报告

> 核验对象：`docs/DESIGN.md` 定稿所依赖的全部 API 签名（A/B/C/D/E 共 23 条）。
> 核验环境：DSH 桌面版 `0.2.0-rc.2`（asar `C:\Users\you\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`）。
> 核验日期：会话当日。**全文只读核验，未修改任何 DSH 安装目录内容。**

## 0. 证据路径前缀约定

| 简写 | 展开路径 |
|---|---|
| `ASAR/` | `F:\WorkSpace\dsh-plugin-remote-use\.research\asar\dsh\node_modules\` |
| `SDK/` | `F:\WorkSpace\dsh-plugin-remote-use\.research\sdk\sdk\`（= `node_modules/@agentclientprotocol/sdk@1.4.0`，注意目录多套了一层 `sdk\sdk\`） |
| `ROOT/` | `F:\WorkSpace\dsh-plugin-remote-use\.research\asar-root\node_modules\` |
| `CATALOG` | `ASAR/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js`（609 KB，**生成式全量 Service/Event 签名目录**） |

### 0.1 本次核验发现的两个"金矿"（后续核验请优先用它们）

1. **`CATALOG`**（`dsh-tool-cordis/lib/types/api-catalog.js`）是 typert 生成的**全量 API 目录**：每个 Service 命名空间的方法 `signature`、每个 Event 的监听签名、以及引用到的 TypeScript `declaration` 全文。比反编译 rollup bundle 可靠得多。可直接用 `cordis_inspect_query`（`provider:"Service"/"Event"/"Config"`）在线取同样内容。
2. **`ROOT/@deepseek-ai/cordis/src/*.ts`** 是**真正的 Cordis 4 TypeScript 源码**（不是 bundle）。`ctx.effect/on/inject` 的权威签名在这里。

### 0.2 辅助脚本（本次新建，可复用）

- `.research/verify/typert-dump.mjs` — 从任意 `lib/typert.host.js` 抽取 `"declaration"` 类型声明。
- `.research/verify/show.mjs` — 按类型名查询 dump。
- `.research/verify/catalog.mjs` — 从 `api-catalog.js` 按正则抽取声明。
- `.research/verify/rawlines.mjs` — 打印任意文件行区间。

### 0.3 判定速览（用户列的 23 条 + 附加 E24 = 24 条）

| 条目 | 判定 | 一句话 |
|---|---|---|
| A1 `SubagentProvider` 成员 | ✅ | 6 个成员名称/类型/可选性全对 |
| A2 `SubagentCapabilities` 5 字段 | ✅ | 含 `depthLimit`（≠ 请求侧 `maxDepth`） |
| A3 `SubagentRun`/`Result`/`StopReason` | ✅ | 5 个枚举值：`completed/aborted/error/max-tokens/refusal` |
| A4 `ResolvedSubagentStartRequest` | ✅ | 9 字段无遗漏；服务另注入 `descriptor` |
| A5 `ctx.subagents` 方法清单 | ✅ | 14 个方法；**没有**按 id 查 run 的方法 |
| A6 out-of-process helper | ❌ | 名称对，但 `.../out-of-process` **子路径不存在**；两类 helper 参数形状相反 |
| B7 `dsh-tool-subagent` Config | ❌ | 无 `outputSchema`/`description`；`agentOptions` 是 `reasoningEffort`(camelCase) |
| B8 `ctx.tools.register` | ❌ | `render` 在 `output` 里；无 `presentation`；`guard`/`restrict` 是注册表方法 |
| B9 `ctx.jobs.start` | ❌ | 返回 `JobId` 字符串，**不是句柄**；`run` 是 spec 输入 |
| B10 `send_message`/`interrupt_agent` | ⚠️ | 参数对；但 `interrupt_agent` 对远程 run 是**静默成功**（不报错） |
| C11 `sessionProjections.register` | ❌ | `view` 在 `wire` 里；漏必填 `stateSchema`/`init` |
| C12 `systemPrompt.section` / `agent.inject` | ✅ | 两者形状确认；`inject` 要完整 `UserMessage` 且不唤醒 |
| C13 `getSectionOrder` 常量 | ✅ | 31 个 section 常量 + 3 个 context 常量，全列出 |
| C14 `subagentCatalog` 投影 | ✅ | key=`subagentCatalog`，v3；**不能**重注册，读用 `snapshot` |
| D15 `acp.client(...)` 方法名 | ❌ | 无 `acp` 命名空间；返回 `ClientApp`（9 个 builder 方法）；会话方法在 `connectWith` 的 ctx 上 |
| D16 `createWebSocketStream` | ✅ | 参数名 `options`；5 个字段；subpath `./experimental/ws-client` |
| D17 `AcpServer` | ❌ 构造 / ✅ 返回 | `constructor(options)` 需 `agent`\|`createAgent`\|`createLegacyAgent` 之一 |
| D18 handler 注册 + 权限应答 | ✅（须嵌套） | `{ outcome: { outcome:'selected', optionId } }` |
| D19 `session/new` 字段 | ⚠️ | 字段名对，但 **DSH 直接拒绝 `additionalDirectories`** |
| E20 `webServer.register/registerUpgrade` | ✅ | 返回 disposer；无 `method` 字段；upgrade 无 `kind` |
| E21 `ctx.effect/on/inject` | ✅ | `inject` 返回 Fiber 不是 disposer；`effect` label 是第 2 位置参数 |
| E22 `dsh.bundle.patch`/`dsh.client` | ✅ | 无 schema；`platform` 只认 `"web"` 且需 `exports["./client"]` |
| E23 改 JS 是否要重启 | ✅ 要重启 / ⚠️ | 出厂 `hmr.config.root: []`；"指向插件目录"未获证据 |
| E24 插件 Config 位置/形状 | ✅ | 顶层 YAML **序列**，不是 `plugins:` 映射；`config` 整体替换 |

**统计：✅ 14 条 · ❌ 6 条（A6 / B7 / B8 / B9 / C11 / D15）· ⚠️或混合 4 条（B10 / D17 / D19 / E23）。**
❌ 的 6 条都已给出可直接替换的正确签名，见对应小节。

---

## A. subagent provider 缝

### A1. `SubagentProvider` 成员名称与类型 — ✅ 确认

`ASAR/@deepseek-ai/dsh-subagent/lib/typert.host.js:759`（JSON 单行字符串；`"name"` 键在 `:758`），`CATALOG:7199` 完全一致：

```ts
export interface SubagentProvider {
    readonly name: string;
    readonly capabilities: SubagentCapabilities;
    readonly inheritsParentContext: boolean;
    readonly agentRouteDefaults?: Readonly<{ provider: string; model: string; }>;
    start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>;
    prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>;
}
```

- 6 个成员名称、可选性、类型全部与文档 §2.1 一致。
- `prepareContinuable` 的请求/返回类型：`ContinuableCreateRequest = { sessionId: SessionId; parent: Agent; signal: AbortSignal }`、`ContinuableCreateSpec = { seed?: readonly SessionEvent[] }`（`ASAR/@deepseek-ai/dsh-subagent/lib/types/continuation.js` 附近 + `CATALOG`）。
- ⚠️ **文档行号微瑕**：`docs/DESIGN.md:45` 与 `:611` 引作 "`typert.host.js:758-767`"。该区间覆盖 `SubagentProvider`(759)、`SubagentResult`(763)、`SubagentRun`(767)，但 **不**覆盖同段列的 `SubagentCapabilities`（在 `:707`）。建议改为 `:707-767` 或分别标注。

### A2. `SubagentCapabilities` 5 个字段名 — ✅ 确认

`ASAR/@deepseek-ai/dsh-subagent/lib/typert.host.js:707`、`CATALOG:7155`：

```ts
export interface SubagentCapabilities {
    readonly agentOptions: boolean;
    readonly outputSchema: boolean;
    readonly depthLimit: boolean;
    readonly toolFilter: boolean;
    readonly persona: boolean;
}
```

字段名与文档完全一致。⚠️ 注意第 3 个是 **`depthLimit`**（不是 `depth` / `maxDepth`），而请求侧字段名是 **`maxDepth`** —— 服务在 `ASAR/@deepseek-ai/dsh-subagent/lib/types/index.js:457-470` 做的映射就是 `request.maxDepth !== undefined → cap: 'depthLimit'`。

### A3. `SubagentRun` / `SubagentResult` / `SubagentStopReason` — ✅ 确认

`typert.host.js:767` / `:763` / `:783`，`CATALOG:7207/7203`：

```ts
export interface SubagentRun {
    readonly id: SessionId;
    readonly localAgent: Agent | undefined;
    readonly result: Promise<SubagentResult>;
    dispose(): Promise<void>;
}
export interface SubagentResult {
    readonly output: readonly ContentBlock[];
    readonly structured?: unknown;
    readonly diagnostic?: string;
    readonly stopReason: SubagentStopReason;
}
export type SubagentStopReason = SubagentStopReasonMap[keyof SubagentStopReasonMap];
export interface SubagentStopReasonMap {
    completed: 'completed';
    aborted: 'aborted';
    error: 'error';
    'max-tokens': 'max-tokens';
    refusal: 'refusal';
}
```

**5 个枚举值**：`'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'`。
`SubagentStopReasonMap` 是**可合并扩展的 interface**，所以 `default:` 分支必须按失败处理（`ASAR/@deepseek-ai/dsh-subagent/lib/types/run-settlement.js:42-44` 就是这么做的：`default: return { status:'failed', detail: failureDetail(result) }`），文档 §4.4 的"未知 reason 归失败"与官方语义一致 ✅。

### A4. `ResolvedSubagentStartRequest` 字段清单 — ✅ 确认，无遗漏、无错名

`typert.host.js:779`（`SubagentStartRequest`）+ `:611`（`Resolved`）、`CATALOG:6183`：

```ts
export interface SubagentStartRequest {
    readonly label?: string;
    readonly prompt: ContentBlock[];
    readonly parent: Agent;
    readonly signal: AbortSignal;
    readonly agentOptions?: AgentOptions;
    readonly outputSchema?: ObjectJsonSchema;
    readonly maxDepth?: number;
    readonly toolFilter?: ToolRestriction;
    readonly persona?: string;
}
export interface ResolvedSubagentStartRequest extends SubagentStartRequest {
    readonly descriptor: SubagentDescriptorData;
}
```

9 个字段，文档列的 9 个全部命中，且 `provider.start()` 实际收到的是 **`Resolved...`**，比文档多一个由服务注入的 `descriptor: SubagentDescriptorData`（`ASAR/@deepseek-ai/dsh-subagent/lib/types/index.js:395-401`）。文档 §5.1 的 `start(request)` 若只把请求原样透传，**不能**假定 `request.descriptor` 不存在——它是服务填的，provider 可以读但不应写。
附带：`AgentOptions = { provider?, model?, reasoningEffort?: ReasoningEffortId, maxTokens?, subagentDepth? }`（`typert.host.js:243`）——注意是 **`reasoningEffort`**（camelCase）。

### A5. `ctx.subagents`（`SubagentRuntime`）完整公开方法清单 — ✅ 确认；**没有按 id 查 run 的方法**

权威清单（`CATALOG:7223`，与 `ASAR/@deepseek-ai/dsh-subagent/lib/types/index.js` 类体逐个对应）：

```ts
export class SubagentRuntime extends TypertRemoteService {
    static Config;                                            // { maxDepth: number=1, maxActiveSubagents: number=8 }
    constructor(ctx: Context, private config: Config);
    resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined;
    async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;
    async sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions): Promise<MessageId>;
    interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void;
    async drainContinuableDescendants(parents: readonly Agent[]): Promise<void>;
    async drainContinuableChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void>;
    listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentCatalogEntry[]>;
    listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]>;
    @Remote('prompt') async prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt>;
    @Remote('interruptByParent') interruptByParent(childSessionId: SessionId, parentSessionId: SessionId, mode: 'continuable'): SubagentInterruptReceipt;
    registerProvider(provider: SubagentProvider): () => void;
    getProvider(name: string): SubagentProvider | undefined;
    list(): string[];
    async start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;
}
```

- 服务名是 **`subagents`**（`super(ctx, 'subagents')`，`ASAR/@deepseek-ai/dsh-subagent/lib/types/index.js:88`），所以是 `ctx.subagents` / `ctx.inject(['subagents'], ...)`。
- ❗**关于「按 id 查询一个 run / run 的当前状态」：不存在这样的方法。** 14 个方法里没有 `getRun` / `get` / `byId` / `status`。我在 `CATALOG`（1108 个条目）与 `lib/index.js` 全文（3201 行）搜索 `getRun|byId|runOf|findRun` **均 0 命中**。
- **唯一可用的替代方案有两条**，文档应据此改写 §5.3：
  1. 订阅生命周期事件（见下），从 `subagent/start` 拿到 `{ runId, provider, id, local }`，从 `subagent/end` 拿到 `{ ..., stopReason, lastAssistantMessage? }`（`ASAR/@deepseek-ai/dsh-subagent/lib/types/lifecycle.js:56-77` 与 `:89-127`）。
  2. 进程内 run 可 `ctx.agents.get(id)`（文档 §2.2-C3 已写对）。
- ⭐ **`local` 字段是官方给的"是否进程外"公开判别位**：`local = run.localAgent !== undefined`（`lifecycle.js:61`）。进程外 provider 的 run 会得到 `local: false`。这比文档 §4.4 自造判定规则更可靠，建议采纳。
- ⚠️ `prepareContinuable` **不在** `CATALOG` 的类声明里（被 `@internal` 剔除），但运行时确实存在于原型上。文档若把它当公开 API 用，属于"能用但未承诺"。

### A6. `dsh-subagent/lib/types/out-of-process.js` 的 helper 名称与签名 — ❌ **导入路径错误**；名称全部正确，但参数形状文档未区分

逐个核验（`ASAR/@deepseek-ai/dsh-subagent/lib/types/out-of-process.js`）：

| helper | 行号 | 真实签名 | 判定 |
|---|---|---|---|
| `NO_START_CAPABILITIES` | 49-55 | `Object.freeze({ agentOptions:false, outputSchema:false, depthLimit:false, toolFilter:false, persona:false })` | ✅ |
| `assertPositiveFinite` | 63 | `assertPositiveFinite(prefix, name, value)` — **位置参数** | ✅ 名称 |
| `assertUsableCwd` | 97 | `assertUsableCwd(prefix, label, cwd)` — **位置参数** | ✅ 名称 |
| `validateConfiguredCwd` | 116 | `validateConfiguredCwd(prefix, cwd)` — **位置参数** | ✅ 名称 |
| `resolveChildCwd` | 137 | `resolveChildCwd(prefix, configured, parentCwd)` — **位置参数** | ✅ 名称 |
| `settleRunResult` | 163 | `settleRunResult(parts)` — **对象参数** | ✅ 名称 |
| `subprocessRunHandle` | 203 | `subprocessRunHandle(parts)` — **对象参数** | ✅ 名称 |

**❌ 错误 1（重要）**：不存在 `@deepseek-ai/dsh-subagent/out-of-process` 这个子路径。
`ASAR/@deepseek-ai/dsh-subagent/package.json:16-42` 的 `exports` 键**只有**：
`"."`、`"./internal"`、`"./invariant"`、`"./client"`、`"./typert"`、`"./remote"`、`"./src/*"`、`"./package.json"`。
→ `import ... from '@deepseek-ai/dsh-subagent/out-of-process'` 会直接 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
**正确写法**：从包根导入，因为这些 helper 由 `lib/types/index.js:51` 的 `export * from './out-of-process.js'` 再导出，且 rollup 产物 `lib/index.js` 末尾的导出清单里确实包含它们：

```js
// ASAR/@deepseek-ai/dsh-subagent/lib/index.js 末尾（最后一行）
export { AssistantOutputFold, NO_START_CAPABILITIES, SUBAGENT_DESCRIPTOR_VERSION, SubagentDepthError,
  SubagentError, SubagentRunId, SubagentRuntime, SubagentRuntime as default, appendDelegatedPolicyOverrides,
  applyChildComposition, assertPositiveFinite, assertSubagentMaxDepth, assertUsableCwd,
  captureDelegatedPolicyOverrides, childSessionMeta, delegationDepthOf, finalAssistantOutput,
  foldSubagentDescriptor, parentAgentOptionsForDelegation, resolveChildAgentOptions, resolveChildCwd,
  resolveChildDepth, settleRun, settleRunResult, snapshotSubagentDescriptor, subprocessRunHandle,
  validateConfiguredCwd };
```

```js
import { NO_START_CAPABILITIES, resolveChildCwd, settleRunResult, subprocessRunHandle }
  from '@deepseek-ai/dsh-subagent'   // ✅ 唯一可行写法
```

**❌ 错误 2（文档 §5.1:320 的"复用四个 helper"没写参数形状）** —— 两类 helper 的参数约定完全不同，照抄必然出错：

- **对象参数**：`settleRunResult(parts)`，`parts` 的字段名（`out-of-process.js:163-194` 逐个读取）：
  `attempt(): Promise<SubagentResult>`、`cancelled(): boolean`、`collectOutput(): readonly ContentBlock[]`、`onError?(error, 'error'): void`、`collectDiagnostic?(): string | undefined`、`signal: AbortSignal`、`onAbort: () => void`
  （`finally` 里执行 `parts.signal.removeEventListener('abort', parts.onAbort)`，**这两个字段是必需的**。）
- **对象参数**：`subprocessRunHandle(parts)`，`parts` 字段（`out-of-process.js:203-218`）：
  `id`、`result`、`signal`、`onAbort`、`requestCancel()`、`teardown()`
  返回：`{ id, localAgent: undefined, result, dispose() }` —— 注意 `localAgent` 恒为 `undefined`，这正是 C3 的来源。
- **位置参数**：`assertPositiveFinite(prefix, name, value)`、`assertUsableCwd(prefix, label, cwd)`、`validateConfiguredCwd(prefix, cwd)`、`resolveChildCwd(prefix, configured, parentCwd)`。第一个参数 `prefix` 是**消费方的诊断前缀字符串**（如 `'subagent-acp'`），不是 options 对象。

文档 §2.2-C1 引的 `out-of-process.js:43-55` 与 `types/index.js:457-470` ✅ 准确（43-48 是 JSDoc，49-55 是常量本体）。

---

## B. 工具注册

### B7. `dsh-tool-subagent` 的 `Config` schema — ❌ **`outputSchema` / `description` 不存在；`agentOptions` 子字段名是 camelCase**

权威来源 `ASAR/@deepseek-ai/dsh-tool-subagent/lib/index.js:252-270`（schemastery `z`），并在同一个 bundle 末尾 `:662` 导出：`export { Config, apply, inject, name }`：

```js
const Config = z.object({
  provider: z.string().required(),
  toolName: z.string().default("subagent"),
  modelSelectionSettings: z.boolean().default(false),
  enableRunInBackground: z.boolean().default(true),
  backgroundMode: z.union(["one-shot", "continuable"]).default("one-shot"),
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
  }).default(void 0),
  persona: z.string(),
  toolFilter: z.object({
    allow: z.array(z.string()).default(void 0),
    deny: z.array(z.string()).default(void 0)
  }).default(void 0),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const("provider-managed")])
});
const inject = ["tools", "subagents", "systemPrompt", "sessionProjections"];
```

**❌ 结论（逐条）**

| 文档/常见写法 | 事实 |
|---|---|
| `outputSchema` 是 Config 字段 | **不存在**。Config 里**没有** `outputSchema`，也没有 `description`。 |
| `description` 是 Config 字段 | **不存在**。工具描述由插件内部 `providerWording()` 按 `inheritsParentContext` 生成（`:344-353`）。 |
| `agentOptions.reasoning_effort`（snake_case） | ❌ 配置里是 **`reasoningEffort`**（camelCase）。snake_case 的 `reasoning_effort` 只出现在**模型面工具参数**里，且仅当 `modelSelectionSettings: true`。 |
| `agentOptions` 可以请求 `provider`/`model` | ✅ 可以，但仅在 **`modelSelectionSettings: true`** 时模型能传；配置层的 `agentOptions.provider/model/reasoningEffort/maxTokens` 总是生效。 |
| 如何"禁掉模型请求 agentOptions" | **保持 `modelSelectionSettings: false`（默认）即可。** 此时工具 `parameters` 里根本不生成 `provider`/`model`/`reasoning_effort`（`:412-425` 是条件展开），模型无法请求。⚠️ 但这只关掉"模型面选择"，**配置层的 `agentOptions` 仍然会下发**；对进程外 provider，只要配置里出现 `agentOptions`（非 `undefined`），`assertSubagentProviderConfiguration` 就会抛错（`:378`）。所以**远程行必须连 `agentOptions` 也不配**。 |
| 其它字段 | ✅ `provider`(必填)、`toolName`(默认 `"subagent"`)、`enableRunInBackground`(默认 `true`)、`backgroundMode`(默认 `"one-shot"`)、`persona`、`toolFilter`、`maxDepth` 名称与默认值全部确认。 |
| `maxDepth: 'provider-managed'` | ✅ 合法字面量，且会给远程 provider 放行 `depthLimit` 校验（`:369` + `:377`）。 |

**U1（文档 §11.1）的答案**：`provider` 的注册粒度**可以**做到"每台从机一行 `@deepseek-ai/dsh-tool-subagent`"。官方 base patch 自己就有两行同包不同配置的先例：`ASAR/@deepseek-ai/dsh-base/cordis.patch.yml:370-375`（`id: tool-subagent`, `provider: spawn`, `toolName: subagent`, `backgroundMode: continuable`）与 `:383-388`（`id: tool-subagent-fork`, `provider: fork`, `toolName: subagent_fork`, `backgroundMode: one-shot`）。⚠️ 但**插件不能在运行时新增工具行**——工具行来自 profile 的 `cordis.patch.yml`（顶层 YAML sequence，见 §E24），`ctx.tools.register` 只能注册工具，不能注册"插件行"。**U2 的答案**：必须让用户/安装器写 profile patch。

⚠️ **配置错的后果比"不生效"更重**：`assertSubagentProviderConfiguration`（`:369-386`）在 `ctx.on('subagent/provider-added', ...)` 里**同步抛错**；而 `SubagentRuntime.registerProvider` 用的是 `ctx.emit('subagent/provider-added', provider)`（`ASAR/@deepseek-ai/dsh-subagent/lib/types/index.js:359`）。Cordis 的 `emit` 实现是 `this.dispatch('emit', args).map(cb => cb(...args))`（`ROOT/@deepseek-ai/cordis/src/events.ts:194-196`），**同步异常会原样冒出 `emit`** —— 这正是 `dsh-subagent` 自己的注释所说的语义：*"A throwing added-listener unwinds the yielded rollback, matching the repository's fail-loud registration semantics."*（`types/index.js:357-358`）。即：**远程 provider 注册会连带回滚**。所以"远程行只配 `provider`/`toolName`/`backgroundMode: 'one-shot'`/`maxDepth: 'provider-managed'`"这条约束是硬性的。

**"装好后能否读取 Config"——✅ 能，但入口不是 JS API**

- `Config` **确实被导出**（`lib/index.js:662`），插件加载器读的是 `fiber.runtime.Config`。
- 运行时内省入口是 **`cordis_inspect_query` 工具的 `Config` provider / `listConfigs` 方法**（`ASAR/@deepseek-ai/dsh-tool-cordis/lib/types/providers.js:37`，实现在 `lib/types/config.js:67-92`）：
  - 目录页：`{ entry?, name?, offset?(0), limit?(1..100, 默认 25) }` → `{ entries:[{id,patchId,name,status}], total, nextOffset }`；`status ∈ 'tree'|'inactive'|'absent'|'unsupported'|'schema'`。
  - 单条：`{ entry: <loader entry id> }` → 附 `packageDir` + 投影出的 JSON Schema 2020-12（`$defs` 含 `loaderExpression`）。
  - **前提**：`ctx.get('loader')` 必须存在，否则抛 `'Config inspection requires the Loader that mounted this profile'`（`config.js:68-70`）。
- ❗**重要坑**：只有 **Schemastery** 的 Config 能被投影。`ASAR/@deepseek-ai/dsh-app-boot/lib/index.js:2163-2166` 的 `isNativeConfigSchema` 要求 `Reflect.get(value, Symbol.for("schemastery")) === true`；否则 `config.js:15-16` 返回 `status: 'unsupported'`，且 `dsh-app-boot/lib/index.js:3119-3121` 报 `"Config is not a native Schemastery schema"`。→ **第三方插件若用 `zod` 声明 `Config`，内省/文档投影拿不到 schema**。应 `import z from '@deepseek-ai/schemastery'`（`@deepseek-ai/schemastery` 在安装范围内，可被拦截解析）。
- `dsh-config-editor` 只提供 `ctx.configEditor.configuration()` / 编辑落盘，**不提供**"列出所有插件 Config schema"的能力。

### B8. `ctx.tools.register(...)` 的准确参数形状 — ❌ **形状与文档列的字段不同**

权威声明（`CATALOG:3197-3244` 服务方法 + `CATALOG:7531/7587/7631/7575/7603` 类型）：

```ts
// 服务方法
register(definition: ToolDefinition): () => void;      // ← 返回 disposer
restrict(filter: ToolRestriction): () => void;
guard(guard: ToolGuard): () => void;
get(name: string, scope?: ScopeKey): ToolDefinition | undefined;
schemas(scope?: ScopeKey): ToolSchema[];
presentAs(mode: ToolPresentationMode): () => void;

// 类型
export interface ToolSchema {
    deferLoading?: true;
    name: string;
    description: string;
    parameters: Record<string, unknown>;         // ← 已经是 JSON Schema（不是 DSL）
}
export interface ToolDefinition extends ToolSchema {
    readonly output: ToolOutputDefinition;
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    projectContent?(exec, result): ContentBlock[] | undefined;
    finalizeContent?(exec, result): ContentBlock[] | undefined;
    timeoutMs?: number;
    isConcurrencySafe?(args: unknown): boolean;
    presentCall?(args: unknown): ToolCallView | undefined;
    presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}
export interface ToolOutputDefinition {
    readonly schema: JsonSchemaNode;
    render(args: unknown, value: JsonValue): ContentBlock[];
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;
export interface ToolRestriction { readonly allow?: readonly string[]; readonly deny?: readonly string[]; }
```

逐条对照文档/常见写法：

| 文档写法 | 事实 | 判定 |
|---|---|---|
| `ctx.tools.register(...)` 参数含 `name` | ✅ | ✅ |
| `description` | ✅ 必填（`ToolSchema.description: string`） | ✅ |
| `parameters(JSON Schema)` | ✅ 是 JSON Schema（`Record<string, unknown>`）；但**裸对象也可以直接注册**（`register` 只强校验 `output.schema`，不校验 `parameters` 的具体形态：`ASAR/@deepseek-ai/dsh-tools/lib/types/index.js:459-479`；投影时 `parameters` 被原样透传：`lib/index.js:3039-3049`） | ⚠️ 半对 |
| `execute` | ✅ `execute(args, exec)` | ✅ |
| `render` | ❌ **不是顶层字段**，在 `output.render` 里 | ❌ |
| `presentation` | ❌ **没有这个字段**。UI 呈现是 `presentCall?` / `presentResult?` / `output.presentationMeta?` | ❌ |
| `guard` | ❌ **不是工具定义字段**，是 `ctx.tools.guard(guard)` 注册表方法 | ❌ |
| `restrict` | ❌ **不是工具定义字段**，是 `ctx.tools.restrict(filter)` 注册表方法 | ❌ |
| `output` | ⚠️ **文档没列，但它是强校验必填项**：`register` 会 `throw new TypeError('tool "X" must declare output { schema, render, presentationMeta? }')`（`dsh-tools/lib/types/index.js:462-466`） | ❌ 遗漏 |

**最小真实注册片段（从真实包抄，可直接用）**

首选 `defineTool`（`@deepseek-ai/dsh-tools`，`ASAR/@deepseek-ai/dsh-tools/README.md:34-58`）：

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'read_file',
  description: 'Read a file from disk.',
  parameters: {
    path:   { type: 'string', required: true, description: 'Absolute file path' },
    offset: { type: 'number' },
    limit:  { type: 'number' },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
  },
}))
```

同仓真实用例（含 `output.render`、`isConcurrencySafe`、`exec.agent`）见 `ASAR/@deepseek-ai/dsh-tool-subagent/lib/index.js:173-196` 与 `:398-562`；后台任务工具见 `ASAR/@deepseek-ai/dsh-tool-jobs/lib/index.js:297-360`。

`defineTool` 的 `parameters` 是 **DSL**（`ParameterSchemaSpec`：`{ type, required?, description?, title?, default?, examples?, oneOf?, items?, properties? }`），由 `parameterSchemaSpecToJsonSchema` 编译（`dsh-tools/lib/index.js:802-811`、`:838-850`）。⚠️ 两条硬规则：`required` **只能**写 `true` 或省略（写 `false` 抛 `"required must be true when present"`，`lib/types/schema.js:78-82`）；`oneOf` 与 `type` 互斥（`schema.js:130-133`）。

`restrict` / `guard` 的真实用法（`dsh-tools/lib/types/index.js:488-511` / `:522-524`）：

```js
ctx.tools.restrict({ deny: ['bash'] })      // 只在 agent.ctx 作用域内合法（plain ctx 抛错）
ctx.tools.guard(exec => exec.name === 'pwsh' ? 'remote-use: shell denied' : undefined)
```

### B9. `ctx.jobs` 的 `start()` 签名与返回 — ❌ **返回的是 id 字符串，不是句柄**

权威签名（`CATALOG:1232-1291` abstract 类）：

```ts
abstract class JobRegistry extends Service {
    abstract readonly events: JobEvents;
    abstract start(spec: JobSpec): JobId;                                   // ← 返回 JobId
    abstract list(caller?: SessionId): JobView[];
    abstract get(id: JobId, caller?: SessionId): JobView;
    abstract read(id: JobId, caller?: SessionId): JobRead;
    abstract readAt(id: JobId, from: number, caller?: SessionId): JobOutputRead;
    abstract kill(id: JobId, caller?: SessionId, reason?: string): 'requested' | 'already-finished';
    abstract wait(id: JobId, timeoutMs: number, caller?: SessionId, signal?: AbortSignal): Promise<JobView>;
    abstract remove(id: JobId, caller?: SessionId): void;
    abstract attachController(name: string): () => void;
}
export type JobId = Branded<'JobId'>;
export interface JobSpec {
    kind: JobKind; label: string; owner?: SessionId;
    outputLimitBytes?: number; output?: readonly JobOutputSource[];
    run(job: JobHandle): JobHooks;
}
export interface JobHandle { readonly id: JobId; append(text, options?): void; updateProgress(line: string): void; }
export interface JobHooks  { cancel(reason?: string): void; done: Promise<JobOutcome>; }
export interface JobOutcome { status: 'completed'|'killed'|'failed'; detail?: string; result?: string; }
export interface JobView {
    readonly id; kind; label; owner?; outputLimitBytes?; status; progress?; detail?;
    startedAt; finishedAt?; output: { total; earliest; spillPaths? };
}
```

**文档若写 job 句柄字段 `id` / `run()` / `cancel()` / `done` / `output()` —— ❌ 全错**，正确对应关系是：

| 文档以为在"返回的句柄"上 | 真实位置 |
|---|---|
| `id` | ✅ 返回值就是 `JobId`（`<kind>-N` 字符串），不是对象；要拿 `id` 就直接用返回值 |
| `run()` | ❌ 是 **`JobSpec` 的输入字段**：`run(job: JobHandle): JobHooks` |
| `cancel()` | ❌ 在 `JobHooks` 上，是 `run()` 的**返回值**的成员 |
| `done` | ❌ 同上，`JobHooks.done: Promise<JobOutcome>` |
| `output()` | ❌ 不存在。生产者推送走 `JobHandle.append(text, options?)`；消费者用 `jobs.read(id, caller)` / `readAt(id, from, caller)`；只读投影在 `JobView.output: { total, earliest, spillPaths? }` |

真实调用（`ASAR/@deepseek-ai/dsh-tool-subagent/lib/index.js:534-555`，可直接抄）：

```js
const jobs = runtimeCtx.get('jobs')
if (jobs === undefined) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
return {
  kind: 'background',
  jobId: jobs.start({
    kind: 'subagent',
    label: args.description,
    owner: parent.id,                       // ← 必须是 live Agent 的 session id
    run: () => {
      const controller = new AbortController()
      return {
        cancel: (reason) => { controller.abort(reason ?? 'background subagent task killed') },
        done: settleStart(runtimeCtx.subagents.start(config.provider, { ...request, signal: controller.signal }), controller.signal),
      }
    },
  }),
}
```

实现侧佐证：`ASAR/@deepseek-ai/dsh-jobs-local/lib/index.js:412-492`（`start(spec)`；`:420-422` 生成 `` `${spec.kind}-${count}` ``；`:428-436` 构造 `JobHandle`；`:437` 调 `spec.run(handle)`；`:491 return id`）。服务名是 **`jobs`**（`ASAR/@deepseek-ai/dsh-jobs/lib/types/index.js:60`）。

**"第三方插件能否把自己的远程任务包装成 job，从而白送 `job_output`/`job_kill`"——✅ 能，但四个前提缺一不可：**

1. `@deepseek-ai/dsh-jobs-local` 与 `@deepseek-ai/dsh-tool-jobs` 已挂载 —— ✅ base profile **已经**挂载：`ASAR/@deepseek-ai/dsh-base/cordis.patch.yml:88-89`（`id: jobs` → `dsh-jobs-local`）与 `:275-276`（`id: tool-jobs` → `dsh-tool-jobs`）。
2. 必须有一个 controller 服务该 owner，否则 `start()` 直接抛错：`dsh-jobs-local/lib/index.js:414` `'background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)'`。`dsh-tool-jobs` 的 `apply` 里调 `ctx.jobs.attachController("tool-jobs")`（`ASAR/@deepseek-ai/dsh-tool-jobs/lib/index.js:256`）。
3. **`owner` 必须是 live Agent 的 session id**：`resolveOwner`（`dsh-jobs-local/lib/index.js:527-534`）要求 `ctx.agents.get(session)` 命中，否则 `'session "X" has no live agent (background job owner must be live)'`。
4. 并发上限：`maxConcurrentJobsPerOwner`（默认见 `dsh-jobs-local/lib/index.js:357`），超限抛 `'background job limit reached for this owner'`。

`job_output` / `job_kill` 工具确实按 `caller = exec.agent?.id` 鉴权（`dsh-tool-jobs/lib/index.js:342-343`、`:406-408`），所以 owner 对了就"白送"。

⚠️ **`backgroundMode: 'one-shot'` 并不等于后台**：`resolveDelegationRun`（`dsh-tool-subagent/lib/index.js:355-361`）返回 `{ runInBackground: request.run_in_background ?? options.continuable }`，one-shot 时默认值 **`false`**。所以文档 §5.7:366 应改为"模型显式传 `run_in_background: true` 时才走 `ctx.jobs`；默认是前台等待"。

### B10. `dsh-tool-subagent-control` 的 `send_message` / `interrupt_agent` — ✅ 参数确认；⚠️ 对远程 run 的失败**模式不同**，文档需区分

参数与调用路径（`ASAR/@deepseek-ai/dsh-tool-subagent-control/lib/types/index.js:21-96`，bundle `lib/index.js` 同构）：

| 工具 | 参数 | output | 内部调用 |
|---|---|---|---|
| `send_message` | `agent_id: string`(required)、`message: string`(required) | `{ messageId: string }` | `ctx.subagents.sendMessage(sender, brandString(args.agent_id), message, { signal: exec.signal })`（`:56`） |
| `interrupt_agent` | `agent_id: string`(required) | `{ accepted: boolean }` | `ctx.subagents.interrupt(brandString(args.agent_id), { kind: 'ancestor', agent: caller })`（`:93`） |

两者都要求 `exec.agent`（`throw new Error('... requires a calling agent (exec.agent was undefined)')`，`:52-54` / `:87-89`）。
`send_message` 外面还套了 `markAdjacentAgentSendMessageTool(...)`（`@deepseek-ai/dsh-subagent/internal`，`:3` 导入），这个是内部标记，不影响参数面。

**对 `localAgent === undefined` 的 run（即进程外 run）的实际行为——两条路径不同：**

**(a) `interrupt_agent`：静默 no-op，但返回成功。** 代码证据链：
`ctx.subagents.interrupt(id, {kind:'ancestor',agent})` → `SubagentRuntime.interrupt`（`ASAR/@deepseek-ai/dsh-subagent/lib/types/index.js:188-190`）→ `continuations.interrupt(targetSessionId, authority)`（`lib/types/continuation.js:288-290`）→ `ContinuableActivationRegistry.interrupt`（`lib/types/continuation-activation.js:155-181`）：

```js
155:     interrupt(targetSessionId, authority) {
156:         if (authority.kind === 'ancestor') { /* 只校验 caller 是否 exact live */ }
165:         const activation = this.resident.get(targetSessionId);
166:         if (activation === undefined)
167:             return;                       // ← 进程外 run 不在 resident 表里，静默返回
...
180:         activation.handle.agent.cancel(authority.kind === 'user' ? { kind: 'user' } : { kind: 'parent' }, { keepInbox: true });
```

工具本身无条件 `return Promise.resolve({ accepted: true })`（`:94`）。→ **模型会以为打断了，其实什么都没发生**，而且**没有任何错误可捕获**。文档 §2.2-C4 的"失效"成立，但必须写明是"**静默成功**"，并据此坚持自建 `remote_interrupt`（ACP `session/cancel`）。

**(b) `send_message`：抛 `SubagentError`，code = `NOT_RESUMABLE`。** 证据链：
`continuation.js:193-212` → `sender.session.header.parentSession === targetId` 不成立时走 `deliverToChild` → `deliverFollowup`（`:252-255`）发现无 live activation → `coldResume`（`:338-391`）：

```js
344: observation = await query.observeSession(childId, { signal: options.signal });
348: catch (error) { ... throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error }); }
356: if (descriptor === undefined || descriptor.mode !== 'continuable') {
357:   throw new SubagentError(`subagent "${childId}" has no supported continuation state and cannot be resumed; choose a different target`, 'NOT_RESUMABLE');
```

进程外 run 没有本地 child Session（provider 不创建 Session，`establishCatalogChild` 也不会被调用），所以 `observeSession` 必失败 → `NOT_RESUMABLE`。
⚠️ 而 `interruptByParent`（远程面，`types/index.js:325-337`）虽然也走 Activation，但它对 absent target 也返回 `{ accepted: true }`（`:336`）—— 与本地 `interrupt_agent` 同为静默 no-op。

文档 §2.2-C4 引的 `dsh-subagent/lib/index.js:3130-3132`（catalog 写入条件）✅ 精确：`const child = run.localAgent?.session; if (child !== void 0) try { establishCatalogChild(...) }`。文档 §12.2 引的 `:3076-3087`（registerProvider）与 `:3130-3141`（catalog）✅ 精确；`dsh-tool-subagent/lib/index.js:509-520`（工具→请求翻译）✅ 精确。

---

## C. session / 投影 / 上下文

### C11. `ctx.sessionProjections.register` 的准确 API — ❌ **`view` 不在顶层，且漏了必填的 `stateSchema`/`init`**

权威类型（`CATALOG:5987`）：

```ts
export interface ProjectionDefinition<
    K extends keyof SessionProjectionStateMap,
    S extends SessionProjectionStateMap[K] = SessionProjectionStateMap[K]
> {
    key: K;
    stateSchema: ZodType<S>;
    init(header: SessionHeader, inheritedEventCount: SessionLogOffset): NoInfer<S>;
    apply(state: NoInfer<S>, event: SessionEvent): NoInfer<S>;
    wire?: K extends keyof SessionProjectionMap ? {
        viewSchema: ZodType<SessionProjectionMap[K]>;
        view(state: NoInfer<S>): SessionProjectionMap[K];
    } : never;
    stateVersion: number;
}
```

服务方法（`CATALOG:2087-2140`）：

```ts
register(definition: ...): () => void
onChanged(listener: ProjectionChangeListener): () => void
stateOf<K>(session: Session, key: K): SessionProjectionStateMap[K] | undefined
snapshot(session: Session, keys?: readonly (keyof SessionProjectionMap & string)[]): ProjectionSnapshot
cachedSnapshot(session, keys?): ProjectionSnapshot | undefined
checkpoint(session: Session): ProjectionCheckpoint
restoreFloor(checkpoint): SessionLogOffset | undefined
viewCheckpoint(checkpoint, keys?): Partial<SessionProjectionMap>
restore(checkpoint, events, baseSeq, header, inheritedEventCount): { snapshot, checkpoint }
hydrate(session, checkpoint, events, baseSeq): ProjectionSnapshot
```

**与文档/常见写法的差异：**

| 文档写法 | 事实 |
|---|---|
| 顶层有 `view` | ❌ **没有**。view 在 `wire: { viewSchema, view }` 里。只有 `K` 属于 `SessionProjectionMap` 时才允许出现 `wire`（`CATALOG` 给了两个重载：`wire` 必填版在 `:2092`，**完全无 `wire` 版**在 `:2098`）。 |
| `stateVersion` | ✅ 有，且校验必须是 `Number.isSafeInteger(x) && x >= 0`（`ASAR/@deepseek-ai/dsh-session-projection/lib/types/index.js:81-83`）。 |
| 漏 `stateSchema` | ❌ **必填**（zod）。`restore`/`viewCheckpoint`/`replay` 都用它 parse。 |
| 漏 `init` | ❌ **必填**，签名 `(header, inheritedEventCount) → state`。注意**两个参数**，`inheritedEventCount` 是 fork 前缀长度（`catalog.js:77` 就是用它做 `event.seq < state.inheritedEventCount` 的过滤）。 |
| 「`stateOf()` 读取方式」 | ⚠️ `stateOf(session, key)` 返回的是**折叠状态**（`SessionProjectionStateMap[K]`），**不是** wire view。要拿 view 必须 `snapshot(session, [key]).values[key]`。 |
| `register()` 返回 | ✅ `() => void`。 |

**真实注册示例（三份，任选）**

1. `ASAR/@deepseek-ai/dsh-permission-presets/lib/types/index.js:159-166`（最简洁，且是 Service 构造器里注册）：

```js
ctx.sessionProjections.register({
  key: 'permissions',
  stateVersion: 2,
  stateSchema: permissionStateSchema,
  init: () => ({ ...EMPTY_KNOBS, seeded: false }),
  apply: applyPermissionEvent,
  wire: { viewSchema: selectionSchema, view: state => ({ currentValue: this.derive(state) }) },
});
```

2. `ASAR/@deepseek-ai/dsh-tool-subagent/lib/index.js:199-214`（带 `init` 返回 `null`、`apply` 里解析 event）：

```js
const subagentModelSelectionProjectionDefinition = {
  key: "subagentModelSelectionPolicy",
  stateVersion: 1,
  stateSchema: z$1.array(z$1.object({ provider: z$1.string().min(1), model: z$1.string().min(1) }).strict()).min(1).nullable(),
  init: () => null,
  apply: (policy, event) => {
    if (policy !== null || event.type !== "subagent/model-selection-policy") return policy;
    const { allowedModels } = event.data;
    assertAllowedModelRoutes(allowedModels);
    ...
    return allowedModels;
  }
};
```

3. `ASAR/@deepseek-ai/dsh-subagent/lib/types/projection.js:38-88`（推荐范本：有 `init(header, inheritedEventCount)`、`apply` 全部返回同一引用表示"未变化"、`wire`）。

读取方式（`dsh-tool-subagent/lib/index.js:221-223`）：

```js
function subagentModelSelectionPolicy(projections, session) {
  return projections.stateOf(session, "subagentModelSelectionPolicy")?.map((route) => ({ ...route }));
}
```

### C12. 往模型上下文注入内容的两条路 — ✅ 两条都确认；`agent.inject()` 的细节文档需补齐

**(1) `ctx.systemPrompt.section(section)` — ✅ 存在，形状比 `{name, order, text}` 多两个可选字段**

`CATALOG:7327`（服务）+ `CATALOG:6011`（类型）：

```ts
export class SystemPrompt extends Service {
    static Config: z<Config>;
    section(section: PromptSection): () => void;
    getSectionOrder(name: PromptSectionOrderName): number;
    getContextOrder(name: PromptContextOrderName): number;
    context(context: PromptContext): () => void;
    suppressRuntimeContext(): () => void;
    tools(provider: (context: AssembleContext) => ToolProviderResult): () => void;
    variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void;
    async assemble(context: AssembleContext = {}): Promise<PromptAssembly>;
}
export interface PromptSection {
    readonly name: string;
    readonly order: number;
    readonly text: string | ((context: AssembleContext) => string);
    readonly interpolate?: boolean;      // ← 文档未提
    readonly complete?: boolean;         // ← 文档未提（同一时刻只能有一个 true）
}
```

- `order` 必须是 finite，否则 `throw new TypeError('prompt section "X" order must be a finite number')`（`ASAR/@deepseek-ai/dsh-system-prompt/lib/index.js:241`）。
- **返回 disposer**（`:242` 返回 `this.layers.effect(...)`）；真实用例常常不接（`dsh-tool-subagent/lib/index.js:576-580`、`dsh-tool-jobs/lib/index.js:257-261`），因为它本身已是 effect-scoped。
- `text` 可以是函数，逐次装配求值 —— 适合"当前远程任务列表"这种动态内容。
- 同名 section 在**同一层**内重复注册会抛错（`:190`），scoped 会遮蔽 global。
- `interpolate !== false` 时 `{{variable}}` 会被严格插值，未知变量**抛错**（`:167-169`）；不打算用变量就写 `interpolate: false` 或避免 `{{`。

**(2) `agent.inject(message)` — ✅ 存在，签名是 `UserMessage`，不是字符串**

`ASAR/@deepseek-ai/dsh-subagent/lib/typert.host.js:231`（`Agent` 声明）：

```ts
export interface Agent {
    readonly id: SessionId;
    readonly options: AgentOptions;
    readonly session: Session;
    readonly inbox: Inbox;
    readonly status: AgentStatus;
    readonly ctx: Context;
    cancel(cause: AgentCancelCause, options?: CancelOptions): void;
    whenIdle(): Promise<void>;
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
    followup(message: UserMessage): void;
    steer(message: UserMessage): void;
    inject(message: UserMessage): void;      // ← 签名
}
```

`UserMessage` 是**完整消息**，不能只给 `content`（`typert.host.js` + `CATALOG:7767`）：

```ts
export interface UserMessage extends MessageBase { readonly role: 'user'; }
export interface MessageBase {
    readonly id: MessageId;
    readonly content: readonly ContentBlock[];
    readonly source: MessageSource;
}
```

✅ **必须用 `createUserMessage({ content, source })` 铸 id**，它由 `@deepseek-ai/dsh-llm` 导出（`ASAR/@deepseek-ai/dsh-subagent/lib/types/continuation-messages.js:6`）。真实用例：

```js
// ASAR/@deepseek-ai/dsh-tool-jobs/lib/index.js:272-295
const message = createUserMessage({
  content: [{ type: 'text', text: fitCompletionNotice(event.job) }],
  source: { kind: 'tool-jobs', form: 'notice', summary: completionSummary(event.job) },
})
if (delivery === 'wakeup' && owner.status === 'idle') { owner.followup(message); return }  // 唤醒
owner.inject(message)                                                                     // 不唤醒
```

⚠️ 三个易错点：
1. **`agent.inject()` 不唤醒 agent**：官方实践文档明确 *"`agent.inject()` does not wake it, so injected context can wait in the inbox until other input arrives"*（`ASAR/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:29`）。想让主机模型立刻看到远程任务状态，必须 `agent.followup(message)`（或 `agent.steer`）。
2. `agent.inject()` 记录为 `agent/inbox/spliced` 事件，**进入下一个被接纳的 step**，不是当前 step（`practices.md:18`）。
3. `source` 的 `kind` 必须是已声明的 `MessageSource` 变体，否则类型面不通。

**(3) "per-agent 上下文是否必须在 `agent/created` 里拿 `agent.ctx`" — ✅ 是（官方要求）**

`practices.md:19-20` 原文：

> *"Register per-agent behavior on `agent.ctx`, obtained in an `agent/created` listener, so it is removed when that agent is disposed. Wrap it in one `agent.ctx.effect()` and also keep that disposer, keyed by agent, in your plugin's own effect; unloading the plugin does not dispose `agent.ctx` registrations by itself."*

`agent/created` 的准确签名（`ASAR/@deepseek-ai/dsh-agent/lib/index.js:579-583`，**serial 派发**）：

```js
await this.ctx.serial(entry.carrier, "agent/created", {
    agent: entry.agent,
    source,                                        // 创建来源：fresh | resume | clear | compaction
    ...signal === undefined ? {} : { signal },
});
```

所以监听器是 `ctx.on('agent/created', async ({ agent, source, signal }) => { ... })`（真实用例 `dsh-tool-subagent/lib/index.js:652-654` 用的就是 `({ agent: created }) => ...`）。`Agent.ctx: Context` 是公开字段（`typert.host.js:231`）。
`ctx.on()` 的准确签名（`ROOT/@deepseek-ai/cordis/src/events.ts:97`）：`on(name, listener, options?: boolean | EventOptions): () => boolean`，`EventOptions = { prepend?, global? }`。

### C13. `ctx.systemPrompt.getSectionOrder('...')` 的合法常量名 — ✅ 完整清单

`getSectionOrder(name: PromptSectionOrderName)`，`PromptSectionOrderName = keyof typeof SECTION_ORDERS`（`CATALOG:6015`）。
`SECTION_ORDERS` 在 `ASAR/@deepseek-ai/dsh-system-prompt/lib/index.js:10-43`（**共 31 个键**）：

| 常量 | 值 | | 常量 | 值 |
|---|---|---|---|---|
| `HARNESS_IDENTITY` | -1000 | | `TOOL_JOBS` | 1600 |
| `DEPLOYMENT_PERSONA_PREFIX` | 0 | | `TOOL_PTY` | 1700 |
| `PLAN_POLICY` | 500 | | `TOOL_WEB_SEARCH` | 2000 |
| `TEAM_POLICY` | 600 | | `TOOL_WEB_FETCH` | 2100 |
| `PTC_ONLY` | 800 | | `TOOL_LSP` | 2200 |
| `FILE_REFERENCE` | 900 | | `TOOL_SESSION_QUERY` | 2300 |
| `TOOL_BASH` | 1000 | | `TOOL_GOAL` | 2400 |
| `TOOL_PWSH` | 1010 | | `TOOL_WORKFLOW` | 2600 |
| `TOOL_READ` | 1100 | | `TOOL_RALPH` | 2700 |
| `TOOL_WRITE` | 1200 | | **`TOOL_SUBAGENT`** | **2800** |
| `TOOL_EDIT` | 1300 | | `TOOL_REPORT` | 2900 |
| `TOOL_GLOB` | 1400 | | `TOOL_COMPUTER_USE` | 3000 |
| `TOOL_GREP` | 1500 | | `MCP_SERVERS` | 3100 |
| `TOOLS_SDK` | 5000 | | `DELIVERABLE_FILE_REFERENCES` | 9000 |
| `STRUCTURED_OUTPUT` | 9900 | | `HARNESS_SOURCE` | 10000 |
| `WEB_SURFACE` | 10100 | | `DEPLOYMENT_PERSONA_SUFFIX` | 10200 |

（上表按 `ASAR/@deepseek-ai/dsh-system-prompt/lib/index.js:10-43` 逐行抄录，共 31 键；`TOOL_SUBAGENT = 2800` 与 `TOOL_JOBS = 1600` 已加粗。）

`getContextOrder(name: PromptContextOrderName)`，`CONTEXT_ORDERS` 在 `:44-48`，**仅 3 个键**：
`SANDBOX_POLICY: 110`、`APPROVAL_POLICY: 115`、`SUBAGENT_DELEGATION: 120`。

⚠️ 注意 `getSectionOrder` 对未知名字**不抛错，返回 `undefined`**（`return SECTION_ORDERS[name]`，`:249-251`），而 `section({order: undefined})` 会抛 `TypeError`。真实用例：`ctx.systemPrompt.getSectionOrder("TOOL_SUBAGENT")`（`dsh-tool-subagent/lib/index.js:578`）、`getSectionOrder("TOOL_JOBS")`（`dsh-tool-jobs/lib/index.js:259`）。
**给本设计的建议**：远程任务可见性 section 用 `TOOL_SUBAGENT`（2800）或 `TOOL_JOBS`（1600）的 order，与相邻内容保持一致；不要自造魔数。若要点"运行时上下文"（Sanadbox/审批那一类），用 `ctx.systemPrompt.context()` + `getContextOrder("SUBAGENT_DELEGATION")`（`PromptContext = { name, order, text: string | ((ctx)=>string) }`，`CATALOG:6000`）。

### C14. `subagentCatalog` 投影 — ✅ 注册方式与 key 确认；第三方**读**可行、**注册/注入**需绕

**怎么注册的**：`SubagentRuntime` 的构造器里，通过可选注入挂上去（`ASAR/@deepseek-ai/dsh-subagent/lib/types/index.js:103-108`）：

```js
ctx.inject(['sessionProjections'], (projectionCtx) => {
    const projections = projectionCtx.sessionProjections;
    projections.register(subagentCatalogProjectionDefinition);
    projections.register(subagentTimingProjectionDefinition);
    projections.register(subagentIdentityProjectionDefinition);
});
```

定义本体（`ASAR/@deepseek-ai/dsh-subagent/lib/types/catalog.js:74-85`）：

```js
export const subagentCatalogProjectionDefinition = {
    key: 'subagentCatalog',
    stateSchema,                                        // { inheritedEventCount: int>=0, head?: chunkedList }
    init: (_header, inheritedEventCount) => ({ inheritedEventCount }),
    apply: (state, event) => {
        if (event.type !== 'subagent/catalog' || event.seq < state.inheritedEventCount) return state;
        return { ...state, head: appendChunkedList(state.head, eventDataSchema.parse(event.data)) };
    },
    stateVersion: 3,
    wire: { viewSchema, view: subagentCatalogEntries },
};
```

**key = `'subagentCatalog'`**，`stateVersion = 3`。

**第三方读取的准确方式**（两条，语义不同）：

```js
// (a) 拿 wire view —— 也就是工具/UI 看到的那张直接子表：
//     Array<{ id, createdAt, mode: 'one-shot'|'continuable'|'unknown', label? }>
const rows = ctx.sessionProjections.snapshot(session, ['subagentCatalog']).values.subagentCatalog;
// 或走官方服务方法（本身就是从这张投影读的）：
const rows2 = await ctx.subagents.listChildren(parentSessionId, signal);

// (b) 拿折叠状态 —— { inheritedEventCount, head }，不是表
const state = ctx.sessionProjections.stateOf(session, 'subagentCatalog');
```

⚠️ 常见误写：`stateOf(session, 'subagentCatalog')` **拿不到** `[{id, mode, label}]`（那是 view），只拿到 chunked-list 状态。

**"能否把远程 run 注入这张表"——❌ 不能注册，⚠️ 能追加事件但代价高：**

1. **不能重新 `register` 同名 key**：`SessionProjectionRegistry.register` 对已存在的 key 会比对 `stateVersion`，不一致直接抛 `'session projection key "subagentCatalog" is already registered at stateVersion 3; refusing to share it with stateVersion N'`（`ASAR/@deepseek-ai/dsh-session-projection/lib/types/index.js:91-93`），一致则只是 `refs += 1` **共用同一个单位**（不会变成你自己的折叠）。→ 文档 §3/§5.3 结论（自建 TaskRegistry）✅ 正确。
2. **也不能靠"新键 + 自建表"骗过 UI**：客户端读的 key 由官方投影提供，第三方新键不会出现在 `list_agents` 那张表里。
3. ⚠️ **理论上可以自己 `session.append('subagent/catalog', {...})`**：该事件类型**是**已声明的一等类型（`SessionEventMap['subagent/catalog']: SubagentCatalogEvent`，`typert.host.js` / catalog.js:11-30），所以不违反"不要新增 event type"的禁令。写入形状（`catalog.js:92-108` `establishCatalogChild`）：

```js
parent.append('subagent/catalog', {
  version: 0,                      // union(0,1)
  childId: child.id,
  childCreatedAt: child.createdAt,
  mode: 'one-shot',                // | 'continuable' | 'unknown'(仅 version:1)
  ...(label === undefined ? {} : { label }),
});
```

   但：`child` 必须是**真实存在且被 host 记录的 Session header**（真调用点 `types/index.js:405` 传的是 `run.localAgent.session.header`，且要 `snapshotSubagentDescriptor` 先落 `subagent/descriptor`）。进程外 run 没有本地 Session → 你只能编造 `childId`/`childCreatedAt`，这会污染 parent 的持久日志、且 `subagent/descriptor` 缺失时 `listChildren` 会把该行判为 `unknown`（`ASAR/@deepseek-ai/dsh-subagent/lib/types/list-children.js:142`）。**建议维持文档现有决策：自建 TaskRegistry。**
4. 另注：`subagentCatalogProjectionDefinition` / `establishCatalogChild` / `SUBAGENT_CATALOG_VERSION` **没有**出现在 `package.json` 的 `exports` 里（只有 `.`、`./internal`、`./invariant`、`./client`、`./typert`、`./remote`、`./src/*`），也没有被 `lib/index.js` 再导出（见 A6 的导出清单）→ 顺手复用是拿不到的。

---

## D. ACP（主机当 client）

> 本节由子代理完成，**我已逐条独立复核**（`acp.js` / `ws-stream.js` / `server.js` / `zod.gen.js` / `examples/ws-client.js` 亲自读过）。
> ⚠️ **元事实**：`SDK/dist/*.d.ts` **全部缺失**（`SDK` 下 60 个文件、0 个 `.d.ts`），尽管 `package.json` 声明了它们。因此权威证据是**发布 JS + 生成的 zod schema + JSON Schema**，普通 TS 类型名无法从声明文件引用。

### D15. `acp.client(...)` 返回对象的方法名 — ❌ **错的**（三条错误）

**(a) 不存在 `acp` 命名空间对象。** `SDK/dist/acp.js` 里 `acp =|const acp|namespace acp` 全部 0 命中；`acp` 只是使用方的 import 别名。
**(b) `client` 是顶层命名导出函数，只收一个 options 参数**（`SDK/dist/acp.js:852-854`）：

```js
export function client(options) { return new ClientApp(options); }   // 只读 options.name（:866-869）
```

**(c) 返回的是 `ClientApp`，其全部公开方法是 9 个流式 builder 方法**（`acp.js:863-958`）：

| 方法 | 行 |
|---|---|
| `connect(target)` | 883 |
| `connectWith(target, op)` | 886 |
| `onConnect(handler)` | 896 |
| `onRequest(method, handlerOrParams, handler)` | 900 |
| `onNotification(method, handlerOrParams, handler)` | 910 |
| `request(spec, handler)` | 920 |
| `notification(spec, handler)` | 924 |
| `connectConnection(target)` | 928 |
| `openStreamConnection(stream)` | 951 |

**❌ `initialize` / `newSession` / `prompt` / `cancel` / `loadSession` / `resumeSession` / `listSessions` / `closeSession` / `setSessionConfigOption` / `authenticate` 都不是这个对象的成员。** 它们是**agent 侧请求**，通过 `connectWith(stream, op)` 回调拿到的 `ctx` 发：

```js
const { result } = await acp.client({ name: '...' })
  .onRequest(acp.methods.client.session.requestPermission, ({ params }) => ...)
  .onNotification(acp.methods.client.session.update, ({ params }) => ...)
  .connectWith(stream, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
      const session = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
      return ctx.request(acp.methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: 'text', text: '...' }] })
  })
```

（`SDK/dist/examples/ws-client.js:44-68` 是可直接运行的真实样例；`acp.js:886-889` 证明 `ctx` 就是 `connection.agent`。）

**方法名字典**是常量映射 `acp.methods`（`acp.js:55`；agent 侧会话方法在 `:65-77`，client 侧在 `:93-113`）；`ClientSideConnection`（`acp.js:1437`）**存在但已 `@deprecated`**（`acp.js:1451`：*"Prefer `client({ name }).connectWith(stream, async (ctx) => ...)`"*），其 `constructor(toClient, stream)` 的 `toClient` 是**工厂函数** `(connection) => ClientImpl`，不是 handler 对象（`acp.js:1445-1453`）。
`SessionBuilder`（`:366`）与 `ActiveSession`（`:440`）都**不是** client 侧入口，而是从 `ClientContext.buildSession(...)` / `attachSession(response)` 派生（`acp.js:193-225`）。
`terminalOutput` / `readTextFile` / `writeTextFile` **不在** `ClientSideConnection` 上，它们是 client 侧 handler 名（`acp.js:1106-1116`）。

**给文档的改写建议**：§5.2:329 的 `createWebSocketStream + acp.client(...)` 作为"建立连接"是成立的（`acp` 用 `import * as acp from '@agentclientprotocol/sdk'`），但必须删掉任何"client 对象上有 newSession/prompt"的写法，改成 `connectWith` + `ctx.request(acp.methods.agent.*)`。

### D16. `createWebSocketStream(serverUrl, opts)` — ✅ 确认（参数名是 `options`）

`SDK/dist/ws-stream.js:26`：`export function createWebSocketStream(serverUrl, options = {}) { return new WebSocketStreamTransport(serverUrl, options).stream; }`

**options 全部 5 个字段**（`ws-stream.js:42-47` 是唯一读取处）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `WebSocket` | 无 → 回退 `globalThis.WebSocket`，否则抛 `'createWebSocketStream requires globalThis.WebSocket or options.WebSocket'`（`:251`） | 构造器 |
| `cookies` | `"include"` | 第三方 cookie 策略 |
| `cookieStore` | `new MemoryAcpCookieStore()` | 升级 `Set-Cookie` 存储 |
| `protocols` | 无 | 作为**构造器第二参数**，不是 headers |
| `headers` | 无 | 与 cookie 合并（`:199-210`） |

**❌ 不存在** `timeout` / `reconnect` / `retries` / `origin` / `auth` 等字段。文档 §5.2 要的"指数退避重连"必须自己实现（SDK 只在文档里描述了 `session/load` 的重连流程，`ws-stream.js:20-24`）。

**subpath 键名（逐字）**，`SDK/package.json:41-45`：

```json
"./experimental/ws-client": {
  "types": "./dist/ws-stream.d.ts",
  "import": "./dist/ws-stream.js",
  "default": "./dist/ws-stream.js"
},
```

（`exports` 的全集：`"."`、`"./experimental/v2"`、`"./experimental/http-client"`、`"./experimental/ws-client"`、`"./experimental/server"`、`"./experimental/node"`、`"./schema/schema.json"`、`"./schema/v2/schema.unstable.json"`；`SDK/package.json:25-58`。）
所以文档必须写成 `import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client'`，**不能**从包根导入。

### D17. `AcpServer` — ❌ 构造参数；✅ `prepareWebSocketUpgrade()` 返回形状

**❌ 构造参数不是位置参数，是一个 options 对象**（`SDK/dist/server.js:19-21`）：

```js
export class AcpServer {
    agent; registry = new ConnectionRegistry(); webSocketSessions = new Set();
    constructor(options) { this.agent = resolveAgent(options); }
```

`options` 必须**恰好**包含 `agent` | `createAgent` | `createLegacyAgent` 之一，否则抛 `"AcpServer requires exactly one of agent, createAgent, or createLegacyAgent"`；接受形状是 `{ connect(stream, connectOptions) }`。
另外还有 `async handleRequest(req, options = {})`（`:23-34`，非 POST/GET/DELETE 返回 405）与 `async close()`（`:67-71`）。

**✅ `prepareWebSocketUpgrade(options = {})` 返回恰好 3 个键**（`server.js:36-65`）：

```js
{
  connectionId: string,
  accept: (socket) => { /* 已 settle 则 throw 'ACP WebSocket upgrade has already been settled' */ },
  reject: () => { /* 已 settle 则 no-op；否则 registry.discard(connectionId) */ },
}
```

⚠️ 子代理对全部 `@deepseek-ai/*` 包做了递归 grep：**`AcpServer` / `createWebSocketStream` / `experimental/server` / `experimental/ws-client` 在 DSH 里 0 命中**。DSH 自己的 ACP 是 **stdio 硬编码**：`ASAR/@deepseek-ai/dsh-acp/lib/index.js:1319` `const stream = config.stream ?? ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));`。→ **D16/D17 描述的是 SDK 具备、DSH 未使用的网络能力**，文档 §11.2"experimental/* 稳定性"这条风险是真实且必要的。

### D18. 客户端 handler 的注册方式与 `RequestPermissionResponse` — ✅ 形状确认，**但必须是嵌套**

**注册方式（推荐，非 deprecated）**：用 `acp.methods.*` 常量 + `onRequest`/`onNotification`（`SDK/dist/examples/ws-client.js:44-48`）：

```js
const { initialized, result } = await acp
  .client({ name: 'ws-example-client' })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => client.requestPermission(ctx.params))
  .onNotification(acp.methods.client.session.update, (ctx) => client.sessionUpdate(ctx.params))
  .connectWith(stream, async (ctx) => { ... })
```

⚠️ **handler 收到的不是 params 本身**，而是一个上下文对象（`acp.js:658-672`）：
`{ params, requestId?, signal, agent }` —— 所以是 `({ params }) => ...`。未知方法名会抛 `Unknown ACP request method '<m>'`（`acp.js:906`）。
字面量：`"session/update"`（通知）/ `"session/request_permission"`（请求）（`acp.js:93-97`）。

**`RequestPermissionResponse` 的准确形状 —— ❌ 平铺写法是错的**：

`SDK/dist/schema/zod.gen.js:2737-2761`：

```js
export const zSelectedPermissionOutcome = z.object({ optionId: zPermissionOptionId, _meta: ... });
export const zRequestPermissionOutcome = z.union([
    z.object({ outcome: z.literal("cancelled") }),
    zSelectedPermissionOutcome.and(z.object({ outcome: z.literal("selected") })),
]);
export const zRequestPermissionResponse = z.object({
    outcome: zRequestPermissionOutcome,
    _meta: ...,
});
```

→ 正确线值**嵌套**：

```js
{ outcome: { outcome: "selected", optionId: "<id>" } }
{ outcome: { outcome: "cancelled" } }
```

字面量是 `"selected"` / `"cancelled"`（**双 L**，不是 `"canceled"`）。
`SDK/dist/examples/ws-client.js:6-13` 是真实可用写法；`SDK/schema/schema.json:8029-8062` 用 `"discriminator": {"propertyName": "outcome"}` 佐证。
其它字段：`RequestPermissionRequest = { sessionId, toolCall, options, _meta }`（必填 `sessionId`/`toolCall`/`options`，`zod.gen.js:340-345`）；`PermissionOption = { optionId, name, kind, _meta }`，`kind ∈ "allow_once"|"allow_always"|"reject_once"|"reject_always"`（**snake_case**，`zod.gen.js:318-332`）。

**`session/update` 通知的字段是 `update`（单数）**，判别式在 `update` **内部**（`zod.gen.js:2073-2077`；`ws-client.js:14-16`）：

```js
async sessionUpdate(params) {
    const update = params.update;                       // SessionNotification = { sessionId, update, _meta }
    if (update.sessionUpdate === "agent_message_chunk") { ... }
}
```

`SessionUpdate` 的 15 个判别值（`zod.gen.js:2019-2065`）：`user_message_chunk`、`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`、`plan_update`、`plan_removed`、`available_commands_update`、`current_mode_update`、`config_option_update`、`session_info_update`、`usage_update`、`compaction_update`、`compaction_summary_chunk`。

**旧式 handler 对象（deprecated）**的成员名（`acp.js:1106-1116`）：`requestPermission`、`sessionUpdate`、`writeTextFile?`、`readTextFile?`、`createTerminal?`、`terminalOutput?`、`releaseTerminal?`、`waitForTerminalExit?`、`killTerminal?`、`createElicitation?`、`completeElicitation?`、`extMethod?(method, params)`、`extNotification?(method, params)`；这一形态的 handler 收到的是**params 本身**（与上面的 `ctx.params` 不同！）。

### D19. ACP `session/new` 请求字段 — ✅ 字段名确认；⚠️ **`additionalDirectories` 被 DSH 直接拒绝**

SDK 侧（`SDK/dist/schema/zod.gen.js:2422-2427`）：`{ cwd: string, additionalDirectories?: string[], mcpServers: McpServer[], _meta }`，必填 `["cwd","mcpServers"]`（`SDK/schema/schema.json:6787`）；`cwd` 要求绝对路径（`schema.json:6759`）。`additionalDirectories`/`mcpServers` 带 `x-deserialize-default-on-error` + `x-deserialize-skip-invalid-items`（`schema.json:6768-6778`）→ **SDK 会丢弃非法项而不是报错**。**没有** `sessionId`/`workspace`/`mode`/`model`/`env`/`title`。

DSH 侧强制校验（`ASAR/@deepseek-ai/dsh-acp/lib/index.js:1410-1413`）：

```js
function validateWorkspaceParams(params) {
    if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    if (params.additionalDirectories !== void 0 && params.additionalDirectories !== null
        && params.additionalDirectories.length > 0)
        throw invalidParams("additionalDirectories is not supported");
}
```

→ **❌ 不要承诺 `additionalDirectories` 支持**（空数组/`null`/缺省可以通过）。错误码是 `-32602`（`SDK/dist/jsonrpc.js:1014-1015` + DSH 包装 `dsh-acp/lib/index.js:649-651`）。
`mcpServers` 另在 `resolveMcpConfigs`（`dsh-acp/lib/index.js:221-258`）校验：重复归一化名拒绝；无 `type` 视为 stdio 且 `command` 必须绝对路径（`"mcpServers[i].command must be an absolute path"`）；`type:"http"` 需合法 URL；其它 type → `"mcpServers[i] transport <t> is not supported"`。`_meta` DSH 从不读（grep `_meta` 在 `dsh-acp/lib/index.js` 0 命中）。
`session/resume` 会先走 `validateWorkspaceParams`（`:1210`）再比对 cwd（`:1217` / `:1234-1236`）。

**顺带确认文档 §2.3:98「DSH 只实装 8 个方法」**：`ASAR/@deepseek-ai/dsh-acp/lib/index.js:1320-1323` 的注册链是
`initialize`、`authenticate`、`session/new`、`session/list`、`session/resume`、`session/close`、`session/setConfigOption`、`session/prompt`（8 个请求）+ 通知 `session/cancel`。
→ ✅ **`session/load` 未实装**、`session/resume` 已实装、`session/delete`/`session/fork`/`session/setMode` 未实装。文档 §11.1-U4「ACP 缺 `session/load`，只有 `session/resume`」✅ 正确。

---

## E. 宿主与装配

> 本节由子代理完成；已在 `dsh-host-webserver` / `dsh-api-gateway` / `dsh-client-modules` / `dsh-hmr` / `cordis/src` 上取证。

### E20. `ctx.webServer.register(route)` / `registerUpgrade(route)` — ✅ 确认（两处纠正）

服务名 **`webServer`**（`ASAR/@deepseek-ai/dsh-host-webserver/lib/index.js:158`），**必须**声明注入（`export const inject = ['webServer']` 或 `ctx.inject(['webServer'], cb)`）。

```ts
// CATALOG:3428 / 3434 / 3440（服务方法）
register(route: WebRoute): () => void;
registerUpgrade(route: WebUpgradeRoute): () => void;
registerFallback(handler: WebRoute['handler']): () => void;

// CATALOG:7847 / 7887（类型）
export interface WebRoute {
    kind: WebRouteKind;                    // 'exact' | 'prefix'
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
export interface WebUpgradeRoute {
    path: string;                          // ← 升级路由没有 kind
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
```

- ✅ 返回**disposer，不是 Promise**。
- ❌ **没有 `method` 字段**——handler 自己判 `req.method`。
- ❌ **`match` 不是 route 字段**；`match(pathname)` 是 service 方法。
- 重复 `(kind,path)` / 重复 upgrade path 会抛错。
- 真实用例：`ASAR/@deepseek-ai/dsh-webhook-github/lib/index.js:161-190`（exact + inject 清单）、`dsh-client-connection/lib/index.js:640-656`（prefix）、`dsh-client-hmr/lib/index.js:140-152`（exact + 自判 method）、`dsh-api-gateway/lib/index.js:626-643`（generator effect 里 registerUpgrade）。
- 极简真实写法（`F:\WorkSpace\dsh-plugin-notify\lib\index.js:718-720` + `:627-631`）：

```js
ctx.inject(['webServer'], (child) => {
  child.effect(() => child.webServer.register({ kind: 'exact', path: '/api/dsh/dsh-plugin-notify', handler }), 'dsh-plugin-notify: settings route')
})
```

### E21. `ctx.effect` / `ctx.on` / `ctx.inject` — ✅ 确认（均为 Cordis 4 核心）

权威来源：`ROOT/@deepseek-ai/cordis/src/fiber.ts`、`src/events.ts`、`src/registry.ts`。

```ts
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
effect(execute: () => Effect,     label?: string): AsyncDisposable<Promise<void>>
// Effect = Disposable<T> | Iterable<Disposable<T>> | Promise<Disposable<T>> | AsyncIterable<Disposable<T>>

on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
interface EventOptions { prepend?: boolean; global?: boolean }

inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>
```

- ⚠️ `effect` 的 label 是**第二个位置参数**，不是 options 对象；`execute` 可以是 generator（每个 `yield` 的 disposer 按产出顺序登记）。
- ⚠️ `inject` 返回的是 **Fiber，不是 disposer**；清理来自回调**内部**的 `return () => ...`。真实证据：`F:\WorkSpace\dsh-plugin-notify\lib\index.js:700-705`（`ctx.inject(['sessionTitle'], (child) => { ...; return () => { ... } })`）。
- 真实片段（同上 `:695-721`）：

```js
export function apply(ctx) {
  const state = createState()
  ctx.inject(['sessionTitle'], (child) => { state.sessionTitle = child.sessionTitle; return () => { state.sessionTitle = null } })
  ctx.on('session/event', (session, event) => { handleSessionEvent(state, ctx, session, event) })
  ctx.inject(['webServer'], (child) => { child.effect(() => child.webServer.register(makeRoute(state, ctx)), 'label') })
}
```

官方推荐形态（`ASAR/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:49-54`）：`export function apply(ctx, config) {}` + 可选 `export const inject = [...]` / `export const Config`；或 default export 一个 Service 类。**不要把两种形态混用。**

### E22. `dsh.bundle.patch` 与 `dsh.client` 的语义与取值 — ✅ 确认

- `dsh.bundle.patch`：`string | string[]`，包内相对路径，按顺序应用。`dsh.bundle` 下**没有**其它被读取的子字段。校验器与错误文案：`ASAR/@deepseek-ai/dsh-app-boot/lib/index.js:495-509`（`"dsh.bundle.patch must be a file path or a list of file paths"`）。
- `dsh.client`：`{ platform: string（必填）, inject?: string[], external?: string[], immediately?: boolean }`。
  - **只有字面量 `"web"` 被承认**，其它值导致整个 client 半边被忽略（`ASAR/@deepseek-ai/dsh-client-modules/lib/index.js:714`）。
  - 声明 `dsh.client` **同时必须**有 `exports["./client"]`，否则抛 `"declares dsh.client but exports no \"./client\" bundle"`（`:719`）。校验器 `:52-75`。
  - **两者都没有 Schemastery / JSON-Schema 定义**，是手写校验。
- 真实样本对照：`F:\WorkSpace\dsh-plugin-notify\package.json:25-31`（`bundle.patch`）+ `:48-56`（`client: { platform: "web", inject: [] }`）且 `exports` 有 `"./client"`；`dsh-plugin-code-quality` 只有 `bundle.patch`，无 `./client`。
- Loader patch 方言（行字段 `id`、`name`、`config?`、`disabled?`、`inject?`、`intercept?`、`isolate?`）：`ASAR/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/SKILL.md:10-25`。

### E23. 改插件 JS 是否要重启 — ✅ 宿主半边**要重启**；⚠️ "把 `hmr.config.root` 指向插件源码目录"**未获证据**

- `dsh-hmr` 的 Config（`ASAR/@deepseek-ai/dsh-hmr/lib/index.js:237-247`）：
  `base: z.string()`（可选，baseDir = `config.base || ctx.baseUrl`）、`root: z.array(String).role("table").default(["."])`、`ignored: z.array(String).role("table").default(["**/node_modules","**/.*","cache","data"])`、`debounce: z.natural().role("ms").default(100)`。
- ⚠️ **schema 默认是 `["."]`，但实际出厂值不是**：`ASAR/@deepseek-ai/dsh-base/cordis.patch.yml:27-32` 显式写 `config: { root: [] }`，注释为 *"Profile configuration reloads by default; module roots are opt-in."*（且该行 `disabled: !!js "!ctx.get('profileContext')"`）。全部 asar 内 `*.yml` 均无非空 `root`；`headless` / `acp-app` 直接把 `hmr` 行 `disabled: true`。
  → 文档 §2.5:136 / §11.2:588 说"`hmr.config.root` 默认 `[]`"**在桌面 profile 语境下正确**，但请注明"这是 base patch 的显式赋值，不是 schema 默认值"。
- `root: []` 时 ready 短路（`dsh-hmr/lib/index.js:438-444`），**只**watch 硬编码的 profile 配置文件 `[profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)]` + profile `package.json`（`:353-376`）。→ JS/模块改动**不会**被拾取，需重启。
- 佐证：`host-plugin.md:60`（*"replacing an installed package requires restart to load a fresh JavaScript module generation"*）、`dsh-plugin-notify/README.md:58`、`dsh-plugin-code-quality/README.md:39-40`；机制上 `dsh-plugin-manager/lib/index.js:1799-1803` 在包名已在 profile 依赖里时返回 `"restart-required"`。
- ⚠️ **未确认**"把 root 指向插件源码目录就能热更"：`root` 相对 `baseDir`，chokidar `cwd=realpath(baseDir)`；默认 `ignored` 含 `**/node_modules`，而 profile 安装的插件就在 `<profile>/node_modules` 下（`dsh-app-boot/lib/index.js:477-481`），**必须同时覆盖 `ignored`**；而且被 watch 的文件只有在 Node `internal.loadCache` 里才会重载（`dsh-hmr/lib/index.js:410-413`），否则只发 `hmr/change` 事件。**未找到**任何 shipped 示例/README/test 把插件目录设为 hmr root。→ 建议文档把 §11.2:588 的缓解措施从"把插件源码目录加进 `hmr.config.root`"降级为"待实测；默认按重启处理"。
- ⭐ 另有一条**确实生效、但只管浏览器半边**的免重启路径：`dsh-client-hmr` 按 `pollIntervalMs`（默认 500）轮询每个图行的 client bundle，并通过 `EVENTS_ENDPOINT = "/plugins/events"` 的 SSE 推 `rebuilt` 帧（`ASAR/@deepseek-ai/dsh-client-hmr/lib/index.js:5,9-22`）。**没有 vite**。→ client bundle 改动可热加载，Node 半边仍需重启。

### E24. 第三方插件的 Config 落在哪里 — ✅ 确认；**常见的 `plugins: {...}` 猜测是错的**

- 路径：`$DSH_HOME/profiles/<profile-name>/cordis.patch.yml`，`$DSH_HOME` = 显式设置 > 环境变量 `DSH_HOME` > `~/.dsh`（`ASAR/@deepseek-ai/dsh-home-paths/lib/index.js:11,15,73-76`；`dsh-app-boot/lib/index.js:484-487,524-527`）。本机实测：`C:\Users\you\.dsh\profiles\desktop\cordis.patch.yml` ✅ 存在。
- 形状：**顶层 YAML 序列（数组）**，每行是 `{ id, name?, config?, disabled?, ... }` —— **不是** `plugins: { 'pkg': {...} }` 映射。任何非序列都会被拒：`dsh-config-editor/lib/index.js:96` 抛 `"Profile patch must be a YAML sequence"`；`dsh-plugin-manager/lib/types/patch.js:29-30` 同样拒绝。
- 权威写入方：`dsh-config-editor/lib/index.js:96-110`（`document.add(document.createNode({ id: entry.options.id, name: entry.options.name, config: next }))`）。
- 模板自述：`dsh-app-boot/lib/index.js:558-562` — *"a top-level YAML array of loader patch entries (id-targeted config overrides, disables, and insert lists; `!!js` expressions allowed)."*
- ⚠️ **`config` 是整体替换，从不深合并**（`cordis-composition-reference/SKILL.md:15`；`host-plugin.md:3`）。→ 插件若要加一个字段，用户必须把**该行的完整 config** 抄一遍再改。
- 第二处：home 级 `$DSH_HOME/cordis.patch.yml`（`ASAR/dsh/lib/profile-boot-*.js:110-116`），被 hmr watch（`dsh-hmr/lib/index.js:354`），可覆盖 profile 层。

---

## F. 文档中容易写错的 12 个坑（按"照抄就翻车"排序）

1. **`@deepseek-ai/dsh-subagent/out-of-process` 不存在。** `exports` 里没有这个子路径，`lib/types/out-of-process.js` 是**文件路径**不是 specifier。四个 helper 必须从**包根**导入（`lib/index.js` 末尾导出了它们）。
2. **两类 helper 的参数约定相反。** `settleRunResult(parts)` / `subprocessRunHandle(parts)` 是**对象**参数（字段名见 A6）；`assertPositiveFinite(prefix, name, value)` / `assertUsableCwd(prefix, label, cwd)` / `validateConfiguredCwd(prefix, cwd)` / `resolveChildCwd(prefix, configured, parentCwd)` 是**位置**参数，首参是诊断前缀字符串。
3. **`ctx.subagents` 没有"按 id 查 run"的方法。** 14 个公开方法里没有 `get`/`getRun`/`byId`。要判进程外，用 `run.localAgent === undefined`，或订阅 `subagent/start|end` 拿 `{ runId, provider, id, local }`（`local: false` 就是进程外）。
4. **`dsh-tool-subagent` 的 `Config` 没有 `outputSchema`、没有 `description`；`agentOptions` 里是 `reasoningEffort`（camelCase），`reasoning_effort`（snake_case）只是模型面参数。** 关闭模型面选择 = 保持 `modelSelectionSettings: false`（默认）；但**远程行必须连 `agentOptions` 都不配**，否则方案校验在 `subagent/provider-added` 里同步抛错并回滚 provider 注册。
5. **`ctx.tools.register` 收的是 `ToolDefinition`：`output: { schema, render }` 是强校验必填；`guard`/`restrict` 不是工具字段而是 `ctx.tools.guard()/restrict()`；没有 `presentation` 字段，只有 `presentCall`/`presentResult`/`output.presentationMeta`。**
6. **`ctx.jobs.start()` 返回 `JobId` 字符串，不是句柄。** `run(job: JobHandle): JobHooks` 是 **JobSpec 的输入**；`cancel`/`done` 是 `run()` 的返回值；`JobHandle = { id, append, updateProgress }`；没有 `output()`，读输出用 `jobs.read`/`readAt`。且 `backgroundMode: 'one-shot'` 默认是**前台**，后台需要模型显式传 `run_in_background: true`。
7. **`sessionProjections.register` 的 `view` 在 `wire` 里，且必须给 `stateSchema` + `init(header, inheritedEventCount)`。** `stateOf()` 返回折叠状态（`subagentCatalog` 是 `{inheritedEventCount, head}`），要 wire view 得用 `snapshot(session, [key]).values[key]`；想拿 `[{id,mode,label}]` 就直接用 `ctx.subagents.listChildren()`。
8. **ACP 的 `acp.client(...)` 是流式 builder，不是会话客户端。** `initialize`/`session/new`/`session/prompt`/`session/cancel` 都在 `connectWith(stream, ctx => ...)` 的 `ctx.request(acp.methods.agent.*)` 上；handler 收到的是 `{ params, requestId?, signal, agent }`，要写 `({ params }) => ...`。
9. **`RequestPermissionResponse` 是嵌套的：`{ outcome: { outcome: 'selected', optionId } }` / `{ outcome: { outcome: 'cancelled' } }`**（双 L 的 `cancelled`）。平铺写法过不了 schema。`SessionNotification` 的字段是 `update`（单数），判别式在里面。
10. **`additionalDirectories` 被 DSH 直接拒绝**（`invalidParams`, `-32602`），文档不能把它写成能力。`createWebSocketStream(url, options)` 的 options 只有 `WebSocket`/`cookies`/`cookieStore`/`protocols`/`headers`（没有 timeout/重连），且必须从 `@agentclientprotocol/sdk/experimental/ws-client` 导入。
11. **插件 `Config` 必须是 Schemastery 才能被内省。** `Config.listConfigs` 不是 JS API，而是 `cordis_inspect_query` 工具的 `Config` provider 方法；它要求 `Symbol.for("schemastery") === true`，用 `zod` 声明会得到 `status: "unsupported"`。第三方 Config 的落盘位置是 `$DSH_HOME/profiles/<p>/cordis.patch.yml` 的**顶层序列**条目 `{ id, name, config }`（不是 `plugins:` 映射），且 `config` **整体替换不深合并**。
12. **改插件宿主 JS 默认必须重启。** `dsh-base/cordis.patch.yml:27-32` 显式把 `hmr.config.root` 设为 `[]`（schema 默认其实是 `["."]`，别混），此时只 watch profile 配置文件；浏览器半边有 `dsh-client-hmr` 的 500ms 轮询 + `/plugins/events` SSE 可热加载，Node 半边不行。"把插件目录加进 `hmr.config.root` 就能热更"**未获证据**（默认 `ignored` 含 `**/node_modules`，而 profile 插件就在那里）。

---

## G. 未找到 / 不确定清单（不臆测）

| 项 | 状态 | 搜索过的关键词与路径 |
|---|---|---|
| `SubagentRunInfo` / `SubagentRunEndInfo` 的**类型声明全文** | ⚠️ 未找到声明；但已从运行时实现精确复原字段（`lifecycle.js:56-77` / `:89-127`：`{ runId, provider, id, local }`，end 再加 `stopReason`、`lastMessage?`/`lastAssistantMessage?`）。原因：声明只在 `src/types.ts`，未随包分发（`lifecycle.js:5-6` 自述）。 | `ASAR/@deepseek-ai/dsh-subagent` 全目录 grep `SubagentRunInfo`；`CATALOG` |
| `SessionProjectionMap` / `SessionProjectionStateMap` 的**实际键集合** | ⚠️ `CATALOG:6675/6683` 只给出空 interface（declare-merge 表），键由各包 merge。要枚举必须用 `cordis_inspect_query` 在线查，或逐个包 grep `declare module`。 | `CATALOG`，`dsh-session-projection` |
| `@agentclientprotocol/sdk` 的 `.d.ts` | ❌ **不存在**（`SDK` 60 文件、0 个 `.d.ts`），尽管 `package.json:24,27,32,37,42,47,52` 声明了。TS 类型名（`PermissionOption` 等）只能从 `schema.json` 的 `title` 得到。 | `SDK` 全目录 `-Filter *.d.ts` |
| DSH 是否 import 过 `sdk/experimental/{server,ws-client}` | ❌ **未找到**（0 命中）。DSH 的 ACP 是 stdio-only。 | 全 `@deepseek-ai/*.js` grep `experimental/ws-client\|experimental/server\|createWebSocketStream\|AcpServer` |
| `hmr.config.root` 指向插件目录能否热更 | ⚠️ **未找到任何示例**。见 E23。 | asar 内全部 `*.yml` grep `hmr`/`root:`/`ignored:`；skills 目录 |
| 第三方插件能否在**运行时新增工具行** | ❌ 未找到机制。工具行来自 profile patch；`ctx.tools.register` 只注册工具。 | `dsh-plugin-manager` `lib/types/*`、`dsh-config-editor`、base/desktop patch |
| `MessageSource` 变体清单 | ⚠️ 不完整（`MessageSourceMap` 是 declare-merge 表，表内容随组合变化）。**`dsh-subagent` face 可见的 18 个**：`user`、`model`、`tool`、`system-prompt`、`model-selection`、`user-approval`、`ptc-mode`、`tool-registry`、`user-rpc`、`agent-message`、`subagent-settled`、`skill-invocation`、`cordis-host-runner`、`goal`、`schedule`、`compact-checkpoint`、`session-reference`、`user-question-reply`（`typert.host.js` `MessageSourceMap`）。⚠️ 该清单**不**包含 `kind: 'tool-jobs'`，但 shipped 代码确实这么用（`ASAR/@deepseek-ai/dsh-tool-jobs/lib/index.js:278`，`{ kind:"tool-jobs", form:"notice", summary }`）—— 因为 `createUserMessage` **不做运行时 source 校验**（`ASAR/@deepseek-ai/dsh-llm/lib/index.js:59-64` 只是 `{...input, role:'user'}`）。结论：TS 面受 merge 表约束，运行时任意 `kind` 都能过。 | `CATALOG:5727`，`dsh-subagent` typert dump，`dsh-llm/lib/index.js:55-80` |

---

## H. 一句话结论

`docs/DESIGN.md` 的**事实层（§2）质量很高**：我抽查的 22 处源码行号引用（`out-of-process.js:43-55`、`types/index.js:457-470`、`continuation.js:133-175`、`index.js:3076-3087`、`index.js:3130-3141`、`dsh-tool-subagent/index.js:509-520`、`dsh-acp/index.js:1319` …）**全部精确命中**，§2.1–§2.5 的契约陈述与 `typert.host.js` / `CATALOG` 一致。
**需要改的是 §5–§11 的"怎么写"层**：4 处硬错（A6 导入路径、B8 工具定义字段形状、B9 job 句柄形状、C11 `view` 位置）、3 处语义错（B7 `agentOptions` 字段名与 `outputSchema` 不存在、B10 `interrupt_agent` 是**静默成功**、C12 `agent.inject` 要完整 `UserMessage` 且不唤醒）、以及 D15/D17/D18 三处（已在 §D 给出可直接替换的代码）。按本报告 §F 的 12 条改完即可定稿。
