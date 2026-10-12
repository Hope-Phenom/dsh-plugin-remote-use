# DSH 子 Agent（subagent）委派缝 — 契约调研报告

调研对象：DeepSeek Harness (DSH) Electron 构建（`app.asar`，121,348,951 字节）。
调研方式：只读。解包/扫描产物位于 `.research/asar/dsh/node_modules/@deepseek-ai/`。
本报告所有路径均相对于工作区根 `F:\WorkSpace\dsh-plugin-remote-use\`。

## 证据基础与命名说明

- 每个包同时存在两份产物：
  - `lib/types/*.js` —— 按模块保留的编译产物（有原始注释与 JSDoc，**本报告优先引用**）；
  - `lib/index.js` —— 打包后的整包 rollup，另有一套行号（同一段逻辑行号不同）。
- **类型在 `.js` 里已被擦除**。完整接口声明保存在 Typert Host FaceModel 清单
  `@deepseek-ai/dsh-subagent/lib/typert.host.js`（978 行 JSON，每个类型一个 `"declaration"` 字符串）。
  这是本报告获取 `SubagentProvider`、`SubagentStartRequest`、`SubagentRun` 等的**权威来源**。
- 全库 asar 内容扫描（解析 header + 读所有 <4MB 的 `.js/.md/.yml/.json` 文件，共 10,529 个文件）
  用于 Q8 的存在性判定。

---

## 1. `SubagentProvider` 接口的完整形态

### 结论

`SubagentProvider` 只有 **4 个必填成员**（`name` / `capabilities` / `inheritsParentContext` / `start`）加
2 个可选成员（`agentRouteDefaults` / `prepareContinuable`）。它**没有** `fork`、没有 `sendMessage`、
没有 `resume`、没有 `dispose`。`start()` 返回的 `SubagentRun` 是 `{ id, localAgent, result, dispose }`，
其中 `id` 是 **SessionId**（不是独立 run id），`localAgent` 在进程外 provider 上必须是 `undefined`。
`capabilities` 只有 5 个布尔位，且**没有任何"支持 remote/进程外"的位**。
`prepareContinuable` 的语义是"提供 seed / 预检"，**不是**"由 provider 驱动孩子"。

### 证据

`SubagentProvider`、`SubagentCapabilities`、`SubagentRun`、`SubagentResult`、`SubagentStopReason`：

```js
// .research/asar/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/typert.host.js:758-759
"name": "SubagentProvider",
"declaration": "export interface SubagentProvider {\n    readonly name: string;\n    readonly capabilities: SubagentCapabilities;\n    readonly inheritsParentContext: boolean;\n    readonly agentRouteDefaults?: Readonly<{ provider: string; model: string; }>;\n    start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>;\n    prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>;\n}"
```

```js
// .../dsh-subagent/lib/typert.host.js:706-707
"name": "SubagentCapabilities",
"declaration": "export interface SubagentCapabilities {\n    readonly agentOptions: boolean;\n    readonly outputSchema: boolean;\n    readonly depthLimit: boolean;\n    readonly toolFilter: boolean;\n    readonly persona: boolean;\n}"
```

```js
// .../dsh-subagent/lib/typert.host.js:766-767
"name": "SubagentRun",
"declaration": "export interface SubagentRun {\n    readonly id: SessionId;\n    readonly localAgent: Agent | undefined;\n    readonly result: Promise<SubagentResult>;\n    dispose(): Promise<void>;\n}"
```

```js
// .../dsh-subagent/lib/typert.host.js:762-764
"name": "SubagentResult",
"declaration": "export interface SubagentResult {\n    readonly output: readonly ContentBlock[];\n    readonly structured?: unknown;\n    readonly diagnostic?: string;\n    readonly stopReason: SubagentStopReason;\n}"
```

```js
// .../dsh-subagent/lib/typert.host.js:782-787
"declaration": "export type SubagentStopReason = SubagentStopReasonMap[keyof SubagentStopReasonMap];"
"declaration": "export interface SubagentStopReasonMap {\n    completed: 'completed';\n    aborted: 'aborted';\n    error: 'error';\n    'max-tokens': 'max-tokens';\n    refusal: 'refusal';\n}"
```

`start` 收到的 request 类型（`ResolvedSubagentStartRequest` = `SubagentStartRequest` + `descriptor`）：

```js
// .../dsh-subagent/lib/typert.host.js:610-611
"name": "ResolvedSubagentStartRequest",
"declaration": "export interface ResolvedSubagentStartRequest extends SubagentStartRequest {\n    readonly descriptor: SubagentDescriptorData;\n}"
```

`prepareContinuable` 的入参/出参（出参**只有 seed**）：

```js
// .../dsh-subagent/lib/typert.host.js:334-339
"declaration": "export interface ContinuableCreateRequest {\n    readonly sessionId: SessionId;\n    readonly parent: Agent;\n    readonly signal: AbortSignal;\n}"
"declaration": "export interface ContinuableCreateSpec {\n    readonly seed?: readonly SessionEvent[];\n}"
```

`Agent` / `AgentOptions` / `AgentStatus`（run handle 里 `localAgent` 的类型）：

```js
// .../dsh-subagent/lib/typert.host.js:230-231, 242-243, 246-247
"declaration": "export interface Agent {\n    readonly id: SessionId;\n    readonly options: AgentOptions;\n    readonly session: Session;\n    readonly inbox: Inbox;\n    readonly status: AgentStatus;\n    readonly ctx: Context;\n    cancel(cause: AgentCancelCause, options?: CancelOptions): void;\n    whenIdle(): Promise<void>;\n    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;\n    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;\n    followup(message: UserMessage): void;\n    steer(message: UserMessage): void;\n    inject(message: UserMessage): void;\n}"
"declaration": "export interface AgentOptions {\n    provider?: string;\n    model?: string;\n    reasoningEffort?: ReasoningEffortId;\n    maxTokens?: number;\n    subagentDepth?: number;\n}"
"declaration": "export type AgentStatus = 'idle' | 'running';"
```

`prepareContinuable` 的**语义**（服务侧）：**方法存在即能力**，无条件拒绝没有该方法的 provider：

```js
// .../dsh-subagent/lib/types/index.js:426-433
async prepareContinuable(name, request) {
    const provider = this.expectProvider(name);
    if (provider.prepareContinuable === undefined) {
        throw new SubagentError(`subagent provider "${provider.name}" does not support continuable children `
            + '(no prepareContinuable capability)', 'UNSUPPORTED_CAPABILITY');
    }
    return provider.prepareContinuable(request);
}
```

`start()` 的返回契约由 `observeRun` 包一层：run 本身原样返回，只额外挂 `result` 的终态监听：

```js
// .../dsh-subagent/lib/types/lifecycle.js:56-77
export function observeRun(emit, provider, parent, run) {
    const identity = { runId: SubagentRunId(randomUUID()), provider, id: run.id, local: run.localAgent !== undefined };
    void run.result.then((result) => {
        emit('subagent/end', { ...identity, stopReason: result.stopReason,
            ...result.output.length === 0 ? {} : { lastAssistantMessage: result.output } }, parent);
    }, () => { emit('subagent/end', { ...identity, stopReason: 'error' }, parent); });
    emit('subagent/start', identity, parent);
    return run;
}
```

> 注意 `SubagentRunInfo` / `SubagentRunEndInfo` 这两个事件 payload 类型**没有**出现在
> `typert.host.js` 的 types 列表里（全文只有 4 处引用：`lifecycle.js:5-6` 的注释 + `typert.host.js:905,973`
> 的 event signature）。其形状只能从 `lifecycle.js:56-77` 与 `89-127` 反推：
> `{ runId, provider, id, local }`，end 追加 `stopReason` 与可选 `lastAssistantMessage`。

---

## 2. `start` 的 request 字段清单与服务侧约束

### 结论

`SubagentStartRequest` 共 **9 个字段**：`label?` `prompt` `parent` `signal` `agentOptions?` `outputSchema?`
`maxDepth?` `toolFilter?` `persona?`。服务在调用 `provider.start` **之前**做 4 件事：能力校验、
`maxDepth` 整数校验、`outputSchema` JSON-Schema 校验、descriptor 快照。调用后若
`run.localAgent` 存在，则向父 session 追加 `subagent/catalog` 事实（失败则 dispose 回滚）。
生命周期事件是 `subagent/provider-added` / `subagent/provider-removed` / `subagent/start` / `subagent/end`。
"observation" 不属于 start 路径，而是 **listing 路径**用的 `sessionQuery.observeSession()`。

### 证据

request 字段与内部 `resolved` 形态：

```js
// .../dsh-subagent/lib/typert.host.js:778-780
"name": "SubagentStartRequest",
"declaration": "export interface SubagentStartRequest {\n    readonly label?: string;\n    readonly prompt: ContentBlock[];\n    readonly parent: Agent;\n    readonly signal: AbortSignal;\n    readonly agentOptions?: AgentOptions;\n    readonly outputSchema?: ObjectJsonSchema;\n    readonly maxDepth?: number;\n    readonly toolFilter?: ToolRestriction;\n    readonly persona?: string;\n}"
```

服务方法与全部校验/发布步骤：

```js
// .../dsh-subagent/lib/types/index.js:389-420
async start(name, request) {
    const provider = this.expectProvider(name);
    this.assertCapabilities(provider, request);                       // 能力校验
    assertSubagentMaxDepth(request.maxDepth);                          // 非负安全整数
    if (request.outputSchema !== undefined)
        assertObjectJsonSchema(request.outputSchema);                  // object-rooted schema
    const descriptor = snapshotSubagentDescriptor({
        mode: 'one-shot', provider: name,
        ...request.label !== undefined ? { label: request.label } : {},
    });
    const resolved = { ...request, descriptor };                       // provider 收到 ResolvedSubagentStartRequest
    const run = await provider.start(resolved);
    const child = run.localAgent?.session;
    if (child !== undefined) {
        try {
            establishCatalogChild(request.parent.session, child.header, descriptor);
        } catch (error) {
            void run.result.catch(() => undefined);                    // 目录写失败 → 回滚
            try { await run.dispose(); } catch (cleanupError) { this.ctx.logger.warn(...); }
            throw error;
        }
    }
    return observeRun(this.emitLifecycle, name, request.parent, run);
}
```

能力校验的具体映射（请求字段 → capability 位）：

```js
// .../dsh-subagent/lib/types/index.js:457-470
assertCapabilities(provider, request) {
    const needs = [
        { when: request.agentOptions !== undefined, cap: 'agentOptions' },
        { when: request.outputSchema !== undefined, cap: 'outputSchema' },
        { when: request.maxDepth !== undefined, cap: 'depthLimit' },
        { when: request.toolFilter !== undefined, cap: 'toolFilter' },
        { when: request.persona !== undefined, cap: 'persona' },
    ];
    for (const { when, cap } of needs) {
        if (when && !provider.capabilities[cap]) {
            throw new SubagentError(`subagent provider "${provider.name}" does not support the "${cap}" capability`, 'UNSUPPORTED_CAPABILITY');
        }
    }
}
```

descriptor 快照（版本 3，显式字段白名单，避免 merge-extensible AgentOptions 污染）：

```js
// .../dsh-subagent/lib/types/descriptor.js:30-45
export const SUBAGENT_DESCRIPTOR_VERSION = 3;
const DESCRIPTOR_BASE_KEYS = ['version', 'mode', 'provider', 'label'];
const ONE_SHOT_DESCRIPTOR_KEYS = new Set(DESCRIPTOR_BASE_KEYS);
const CONTINUABLE_DESCRIPTOR_KEYS = new Set([...DESCRIPTOR_BASE_KEYS,
    'agentProvider', 'agentModel', 'agentReasoningEffort', 'persona', 'toolFilter']);
```

`snapshotSubagentDescriptor` 走 `snapshotJsonValue`，非无损 JSON 直接抛：
`.../dsh-subagent/lib/types/descriptor.js:150-174`。

catalog 事实（**只有 in-process 子 Agent 才有**——因为依赖 `run.localAgent`）：

```js
// .../dsh-subagent/lib/types/catalog.js:92-108
export function establishCatalogChild(parent, child, descriptor) {
    parent.append('subagent/catalog', descriptor.mode === 'one-shot'
        ? { version: SUBAGENT_CATALOG_VERSION, childId: child.id, childCreatedAt: child.createdAt,
            mode: descriptor.mode, ...descriptor.label === undefined ? {} : { label: descriptor.label } }
        : { version: SUBAGENT_CATALOG_VERSION, childId: child.id, childCreatedAt: child.createdAt,
            mode: descriptor.mode, label: descriptor.label });
}
```

**生命周期事件名**（全部经 contained emitter 派发，单个 listener 抛错不会影响 peer）：
`subagent/provider-added`、`subagent/provider-removed`、`subagent/start`、`subagent/end`。

```js
// .../dsh-subagent/lib/types/index.js:345-361（registerProvider）
return this.ctx.effect(function* () {
    if (this.providers.has(name)) throw new SubagentError(`a subagent provider named "${name}" is already registered`, 'DUPLICATE_PROVIDER');
    this.providers.set(name, provider);
    yield () => { this.providers.delete(name); this.emitLifecycle('subagent/provider-removed', name); };
    this.ctx.emit('subagent/provider-added', provider);
}.bind(this), 'subagents.registerProvider()');
```

contained emitter 本体：`.../dsh-subagent/lib/types/lifecycle.js:30-47`。

服务方法签名（Typert Host FaceModel，`start` 的公开签名是 `SubagentStartRequest`，descriptor 由服务补）：

```js
// .../dsh-subagent/lib/typert.host.js:218-219
"signature": "async start(name: string, request: SubagentStartRequest): Promise<SubagentRun>"
```

**"observation" 的真实位置**：不是 start 路径，而是 listing 路径 —— `listChildren` 通过
`sessionQuery.observeSession()` 拿到 live-preferred Session observation，读 `subagentCatalog` 投影后释放：

```js
// .../dsh-subagent/lib/types/list-children.js:67-81
export async function listChildren(ctx, parentSessionId, signal) {
    const query = ctx.get('sessionQuery');
    if (query === undefined) throw new SubagentError('listing subagents requires the sessionQuery service (load @deepseek-ai/dsh-session-query)', 'SUBAGENT_CONTROL_QUERY_UNAVAILABLE');
    const parent = __addDisposableResource(env_1, await query.observeSession(parentSessionId, { ...signal === undefined ? {} : { signal } }), false);
    const entries = parent.projections?.values.subagentCatalog;
    if (entries === undefined) throw new SubagentError('listing subagents requires the registered subagentCatalog projection', 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE');
    return entries;
}
```

另外服务自身把两个投影注册到 `sessionProjections`：
`.../dsh-subagent/lib/types/index.js:103-108`（`subagentCatalogProjectionDefinition`、
`subagentTimingProjectionDefinition`、`subagentIdentityProjectionDefinition`）。

**Session 事件**（持久化层，与上面的 lifecycle 事件不同）：
`subagent/descriptor`（`descriptor.js:1-19`）、`subagent/catalog`（`catalog.js:79`）。

请求组装的实际调用点（工具侧如何填这 9 个字段）见 Q3。

---

## 3. `dsh-tool-subagent`：模型可见的工具面与翻译路径

### 结论

`dsh-tool-subagent` 只注册**一个**工具（名字可配，默认 `subagent`；preset 里另有 `subagent_fork`、
`subagent_codex`、`subagent_claude_code` 三个同包不同配置的实例）。它的参数是
`description`(必填) `prompt`(必填) + 可选 `provider`/`model`/`reasoning_effort`（`modelSelectionSettings: true` 时）
+ 可选 `run_in_background`。翻译路径极短：拼 `SubagentStartRequest` → `subagents.start(provider, request)`；
后台一次性走 `ctx.jobs.start({kind:'subagent'})`，后台可续聊走 `subagents.startContinuable()`。
`fork`/`list_agents`/`send_message`/`wait_agent`/`interrupt_agent`/`workflow` **不在本包**，分别在
spawn/fork provider 配置、`dsh-tool-subagent-control`、`dsh-experimental-tool-agent-team`、
`dsh-tool-workflow`。

### 证据

**工具 schema**（参数与输出）：

```js
// .research/asar/dsh/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js:398-430
mounted = { subagentProvider, disposeTool: runtimeCtx.tools.register(defineTool({
    name: toolName,
    description: wording.description + (...) + choiceDescription,
    parameters: {
        description: { type: "string", required: true, description: "A short (3-5 word) description of the delegated task, for display." },
        prompt: { type: "string", required: true, description: wording.promptDescription },
        ...modelSelectionEnabled ? { provider: {...}, model: {...}, reasoning_effort: {...} } : {},
        ...backgroundEnabled ? { run_in_background: { type: "boolean", description: continuable ? "Defaults to true. ..." : "Run as a background job and return its id (collect with job_output, stop with job_kill). Defaults to false." } } : {}
    },
```

输出是三种形态的 oneOf：

```js
// .../dsh-tool-subagent/lib/index.js:431-488
output: {
    schema: { oneOf: [
        { type: "object", additionalProperties: false, properties: { kind: { const: "background" }, jobId: {...} } },
        { type: "object", additionalProperties: false, properties: { kind: { const: "continuable" }, subagentId: {...} } },
        { type: "object", additionalProperties: false, properties: { kind: { const: "foreground" }, runId: {...}, output: { type: "array", items: { type: "json" } } } }
    ] },
    render: (_args, value) => [{ type: "text",
        text: value.kind === "background" ? `started background subagent job ${value.jobId}`
            : value.kind === "continuable" ? `started subagent ${value.subagentId}`
            : outputValueText(value.output) }]
},
```

**tool 调用 → `subagents.start` 的翻译**（request 组装的唯一位置）：

```js
// .../dsh-tool-subagent/lib/index.js:490-520
async execute(args, exec) {
    const parent = exec.agent;
    if (!parent) throw new Error("subagent tool requires a calling agent (exec.agent was undefined)");
    ...
    exec.signal.throwIfAborted();
    const maxDepth = runtimeCtx.subagents.resolveMaxDepth(config.maxDepth);   // 'provider-managed' → undefined
    const request = {
        label: args.description,
        prompt: [{ type: "text", text: args.prompt }],
        parent,
        ...requestedChildAgentOptions !== void 0 ? { agentOptions: requestedChildAgentOptions } : {},
        ...config.persona !== void 0 ? { persona: config.persona } : {},
        ...config.toolFilter !== void 0 ? { toolFilter: config.toolFilter } : {},
        ...maxDepth !== void 0 ? { maxDepth } : {}
    };
```

**前台**：`subagents.start` + `settleForegroundRun`（结果转文本、stopReason 非 completed 抛错）：

```js
// .../dsh-tool-subagent/lib/index.js:557-560
return settleForegroundRun(await runtimeCtx.subagents.start(config.provider, { ...request, signal: exec.signal }));
```

```js
// .../dsh-tool-subagent/lib/index.js:314-331
async function settleForegroundRun(run) {
    const [execution] = await Promise.allSettled([run.result.then((result) => {
        const error = stopReasonError(result);
        if (error !== void 0) throw new Error(withDiagnosticAndPartialText(error, result));
        return { kind: "foreground", runId: run.id, output: result.output };
    })]);
    const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
    ...
}
```

**tool 结果如何回填给父 Agent**：`execute` 返回结构化 value，由 `defineTool` 的 `output.render(_args, value)`
渲染成 `ContentBlock[]`（上引 484-487 行），DSH 的 tool 运行时把它落成 `tool/result` 消息 ——
即 `SessionEventMap['tool/result']`（`.../dsh-subagent/lib/typert.host.js:647`: `'tool/result': { turn; step; message: ToolResultMessage; error?; meta?; }`）。

**`run_in_background` 实现**（两种，取决于 `backgroundMode`）：

```js
// .../dsh-tool-subagent/lib/index.js:521-556
if (resolveDelegationRun(args, { backgroundEnabled, continuable }).runInBackground) {
    if (continuable) return {
        kind: "continuable",
        subagentId: (await runtimeCtx.subagents.startContinuable({
            provider: config.provider, label: args.description, request, signal: exec.signal
        })).childId
    };
    const jobs = runtimeCtx.get("jobs");
    if (jobs === void 0) throw new Error("background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
    return { kind: "background", jobId: jobs.start({
        kind: "subagent", label: args.description, owner: parent.id,
        run: () => {
            const controller = new AbortController();
            return {
                cancel: (reason) => { controller.abort(reason ?? "background subagent task killed"); },
                done: settleStart(runtimeCtx.subagents.start(config.provider, { ...request, signal: controller.signal }), controller.signal)
            };
        }
    }) };
}
```

`settleStart` 把 run 映射到 job outcome（`.../dsh-tool-subagent/lib/index.js:276-285`），底层是
`settleRun`：

```js
// .../dsh-subagent/lib/types/run-settlement.js:53-69
export async function settleRun(run) {
    let outcome;
    try { outcome = runOutcome(await run.result); }
    catch (error) { outcome = { status: 'failed', detail: String(error) }; }
    try { await run.dispose(); }
    catch (error) { const prefix = outcome.detail === undefined ? '' : `${outcome.detail}; `;
        return { status: 'failed', detail: `${prefix}dispose failed: ${String(error)}` }; }
    return outcome;
}
```

**provider 生命周期驱动工具注册**（provider 未装载时工具根本不注册）：

```js
// .../dsh-tool-subagent/lib/index.js:565-575
runtimeCtx.on("subagent/provider-added", (subagentProvider) => {
    if (subagentProvider.name === config.provider && mounted === void 0) mount(subagentProvider);
});
runtimeCtx.on("subagent/provider-removed", (name) => {
    if (name !== config.provider || mounted === void 0) return;
    mounted.disposeTool(); mounted = void 0;
});
const present = runtimeCtx.subagents.getProvider(config.provider);
if (present !== void 0) mount(present);
else runtimeCtx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? "subagent"}" tool will register when it appears`);
```

provider 侧配置校验（`backgroundMode: continuable` 需要 `prepareContinuable`；`maxDepth` 需要 `depthLimit`）：

```js
// .../dsh-tool-subagent/lib/index.js:376-381
const assertSubagentProviderConfiguration = (subagentProvider) => {
    if (ctx.subagents.resolveMaxDepth(config.maxDepth) !== void 0 && !subagentProvider.capabilities.depthLimit) throw new Error(`tool-subagent: provider "${subagentProvider.name}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`);
    if (config.agentOptions !== void 0 && !subagentProvider.capabilities.agentOptions) throw new Error(`tool-subagent: provider "${subagentProvider.name}" does not support child agentOptions`);
    if (modelSelectionCapable && !subagentProvider.capabilities.agentOptions) throw new Error(`tool-subagent: provider "${subagentProvider.name}" does not support child model selection`);
    if (continuable && subagentProvider.prepareContinuable === void 0) throw new Error(`tool-subagent: provider "${subagentProvider.name}" does not support \`backgroundMode: continuable\``);
};
```

**其余工具的实际归属**：

| 模型可见工具 | 归属包 | 证据 |
|---|---|---|
| `subagent` / `subagent_fork` / `subagent_codex` / `subagent_claude_code` | `dsh-tool-subagent`（每 provider 一个实例） | `dsh-base/cordis.patch.yml:370-388`；`dsh-web-app/presets/standard.patch.yml:90-118` |
| `send_message`、`interrupt_agent` | `dsh-tool-subagent-control` | `.../dsh-tool-subagent-control/lib/index.js:22`、`:61` |
| `list_agents` | `dsh-tool-subagent-control/list-agents`（子路径导出） | `.../dsh-tool-subagent-control/lib/types/list-agents.js:44` |
| `job_output`、`job_list`、`job_kill` | `dsh-tool-jobs` | `.../dsh-tool-jobs/lib/index.js:297`、`:347`、`:367` |
| `workflow` | `dsh-tool-workflow`（引擎 `dsh-workflow-ptc`） | `.../dsh-tool-workflow/lib/index.js:268` |
| `spawn_teammate`、`wait_agent`、`team_task_*` | `dsh-experimental-tool-agent-team` | `.../dsh-experimental-tool-agent-team/lib/index.js:243,332,367,402,446,459` |

> 注意：`dsh-experimental-tool-agent-team` 启用时还会**再注册一份** `send_message`/`list_agents`/
> `interrupt_agent`（同名，作用于 Team roster 而非 continuable roster）——
> 见 `.../dsh-experimental-tool-agent-team/lib/index.js:296,323,354`。两者是不同的缝，不要混同。

`interrupt_agent` / `send_message` 的翻译（薄适配层，无自有路由）：

```js
// .../dsh-tool-subagent-control/lib/index.js:51-59, 83-91
async execute(args, exec) {
    const sender = exec.agent;
    if (!sender) throw new Error("send_message requires a calling agent (exec.agent was undefined)");
    const message = [{ type: "text", text: args.message }];
    return { messageId: await ctx.subagents.sendMessage(sender, brandString(args.agent_id), message, { signal: exec.signal }) };
}
// interrupt_agent
ctx.subagents.interrupt(brandString(args.agent_id), { kind: "ancestor", agent: caller });
return Promise.resolve({ accepted: true });
```

**`workflow` 也走同一个缝**（每个 `agent()` 钩子 = 一次 `subagents.start`）：

```js
// .../dsh-workflow-ptc/lib/index.js:325-353
async startChild(request) {
    this.requireActive();
    const callId = ++this.started;
    const run = await this.subagents.start(this.provider, {
        prompt: [{ type: "text", text: request.prompt }],
        parent: this.parent,
        signal: this.controller.signal,
        ...request.schema === void 0 ? {} : { outputSchema: request.schema },
        ...request.provider === void 0 && request.model === void 0 ? {} : { agentOptions: {
            ...request.provider === void 0 ? {} : { provider: request.provider },
            ...request.model === void 0 ? {} : { model: request.model } } }
    });
```

workflow 的 provider 是**静态配置**（`provider: spawn`，`dsh-base/cordis.patch.yml:393-396`），
且只在 `agent()` 里用 `start`（one-shot），**不用 continuable**；
`childResult` 直接读 `run.result` 的 `{ output, stopReason, structured }`
（`.../dsh-workflow-ptc/lib/index.js:355-373`）。

---

## 4. `inheritsParentContext`：fork vs spawn

### 结论

`inheritsParentContext` **只描述"孩子的会话是否被父的已完成轮次 seed"**，与工具/服务/作用域/权限继承无关
（README 与代码注释都明确写了这一点）。fork = `true` + 用 `parent.session.snapshotEvents()` 截到最后一个
`turn/end` 作为 seed；spawn = `false` + 无 seed。两者的 `capabilities` 完全相同（五位全 true），
差别仅在 seed 与工具描述措辞。`inheritsParentContext` 还影响模型可见的 tool description / prompt 描述，
以及"切换 route 会阻止 provider 侧复用继承前缀"的提示。

### 证据

```js
// .research/asar/dsh/node_modules/@deepseek-ai/dsh-subagent-fork-in-process/lib/index.js:23-28, 44-55
function completedTurnPrefix(parent) {
    const events = parent.session.snapshotEvents();
    const lastEnd = events.findLast((e) => e.type === "turn/end");
    if (lastEnd === void 0) return [];
    return events.slice(0, lastEnd.seq + 1);
}
...
    inheritsParentContext = true;
    start(request) {
        const seed = completedTurnPrefix(request.parent);
        return startInProcessRun(request, { ...seed.length > 0 ? { seed } : {} });
    }
    prepareContinuable(request) {
        const seed = completedTurnPrefix(request.parent);
        return Promise.resolve(seed.length > 0 ? { seed } : {});
    }
```

```js
// .research/asar/dsh/node_modules/@deepseek-ai/dsh-subagent-spawn-in-process/lib/index.js:23-39
capabilities = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true };
inheritsParentContext = false;
start(request) { return startInProcessRun(request, {}); }
prepareContinuable() { return Promise.resolve({}); }
```

fork 的 capabilities 与 spawn **逐位相同**（`fork-in-process/lib/index.js:37-43`）。

措辞差异的唯一来源：

```js
// .../dsh-tool-subagent/lib/index.js:333-353
/**
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns ...
 * @param inheritsConversation - whether the child's conversation is seeded
 *   with the parent's completed turns; this says nothing about tool, service,
 *   scope, or authority inheritance.
 */
function providerWording(inheritsConversation) {
    if (inheritsConversation) return {
        description: "Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn). ...",
        promptDescription: "The task for the subagent. It already sees this conversation's completed turns, so build on them freely and state only what is new."
    };
    return { description: "Delegate a self-contained task to a subagent (a separate agent that works in its own context) ...", ... };
}
```

```js
// .../dsh-tool-subagent/lib/index.js:395（choiceDescription 尾部）
+ (subagentProvider.inheritsParentContext ? " Changing the route can prevent provider-side reuse of the inherited conversation prefix." : "");
```

README 对 fork 的定义（"seed 到最后一个 turn/end，当前工具轮不完整无法重放"）：
`.../dsh-subagent-fork-in-process/README.md`（对应源码注释 `fork-in-process/lib/index.js:4-10`）。

---

## 5. `startInProcessRun` 做了什么 / 哪些可复用

### 结论

`startInProcessRun(request, options)` = **本地建 Agent + 驱动一轮 + 读结果 + 静默拆除**。
它 100% 依赖宿主内部能力：`parent.ctx.agents.create()`、`childCtx.tools.register/systemPrompt/guard`、
`child.followup/whenIdle/cancel`、`child.session.snapshotEvents()`、`SessionLogOffset`、`foldConsumedWork`。
因此对**进程外 provider 作者完全不可复用**——进程外没有本地 `Agent`/`Session`/`ctx.tools`。
唯一可复用的是同一包里的**契约级 helper**（`toStopReason` 的映射语义、`SubagentResult` 形状约定），
以及 `dsh-subagent` 自己导出的 `out-of-process.js` 那一组（见 Q6）。

### 证据

```js
// .research/asar/dsh/node_modules/@deepseek-ai/dsh-subagent-in-process-driver/lib/index.js:161-190
async function startInProcessRun(request, options) {
    assertSubagentMaxDepth(request.maxDepth);
    if (request.signal.aborted) throw prePublicationAbort();
    const parent = request.parent;
    const childDepth = resolveChildDepth(parent, request.maxDepth);
    const childId = brandString(randomUUID());
    const seed = options.seed;
    const activationBoundary = SessionLogOffset(seed?.length ?? 0);
    const inherited = captureDelegatedPolicyOverrides(parent);
    let structured;
    const setup = (childCtx, child) => {
        appendDelegatedPolicyOverrides(child.session, inherited);
        applyChildComposition(childCtx, parent, { persona: request.persona, toolFilter: request.toolFilter });
        if (request.outputSchema !== void 0) structured = attachStructuredRuntime(childCtx, request.outputSchema);
        attachDescriptorAppend(childCtx, request.descriptor);
    };
    return drivePublishedRun(await parent.ctx.agents.create({          // ← 本地 Agent 工厂
        sessionId: childId, parentAgent: parent,
        meta: childSessionMeta(parent, childDepth, seed !== void 0),
        ...seed !== void 0 ? { seed } : {},
        ...seed === void 0 ? {} : { inheritedEventCount: activationBoundary },
        agentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),
        signal: request.signal, setup
    }), request.signal, request.prompt, childId, activationBoundary, structured);
}
```

run handle 的构造与 "result 不 reject" 的实现：

```js
// .../dsh-subagent-in-process-driver/lib/index.js:195-229
function drivePublishedRun(handle, signal, prompt, childId, boundary, structured) {
    const child = handle.agent;
    const flags = { cancelled: false };
    const onAbort = () => { flags.cancelled = true; child.cancel({ kind: "parent" }); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const result = (async () => {
        try {
            if (!flags.cancelled) {
                child.followup(createUserMessage({ content: prompt, source: { kind: "user" } }));
                await child.whenIdle();
            }
            return readResult(child, boundary, flags.cancelled, structured ? { captured: structured.captured() } : void 0);
        } finally { signal.removeEventListener("abort", onAbort); }
    })();
    return {
        id: childId, localAgent: child, result,
        async dispose() {
            signal.removeEventListener("abort", onAbort);
            flags.cancelled = true;
            const disposal = (await Promise.allSettled([handle.dispose(), result]))[0];
            if (disposal.status === "rejected") throw disposal.reason;
        }
    };
}
```

结果收集（读 child 自己的 session 后缀，排除 fork seed；`cancelled && recorded !== 'completed'` → `aborted`）：

```js
// .../dsh-subagent-in-process-driver/lib/index.js:231-252
function readResult(child, boundary, cancelled, structured) {
    const own = child.session.snapshotEvents(boundary);
    const lastEnd = foldConsumedWork(own).end;
    const output = finalAssistantOutput(own) ?? [];
    const recorded = toStopReason(lastEnd?.data.reason);
    const stopReason = cancelled && recorded !== "completed" ? "aborted" : recorded;
    if (structured !== void 0) {
        if (structured.captured !== void 0) return { output, structured: structured.captured.value, stopReason };
        if (stopReason === "completed") return { output, stopReason: cancelled ? "aborted" : "error" };
    }
    return { output, stopReason };
}
```

tag → stopReason 映射（**这是语义上可复用的部分**）：

```js
// .../dsh-subagent-in-process-driver/lib/index.js:125-133
function toStopReason(reason) {
    switch (reason?.kind) {
        case "completed": return "completed";
        case "max-tokens": return "max-tokens";
        case "aborted": return "aborted";
        case "blocked": return "refusal";
        default: return "error";
    }
}
```

descriptor 追加时机（在子 Agent 第一个 step 的 `enter` 决策后才 append，保证落在初始 turn 内）：

```js
// .../dsh-subagent-in-process-driver/lib/index.js:139-149
function attachDescriptorAppend(childCtx, descriptor) {
    let appended = false;
    childCtx.on("agent/pre-step", async ({ agent }, next) => {
        const decision = await next();
        if (!appended && decision.kind === "enter") { appended = true; agent.session.append("subagent/descriptor", descriptor); }
        return decision;
    });
}
```

**可复用 vs 不可复用**（对照 driver README `.../dsh-subagent-in-process-driver/README.md:32,36,40,64`）：

| 项 | 进程外 provider 可否复用 | 原因 |
|---|---|---|
| `toStopReason` 语义（turn reason → `SubagentStopReason`） | ✅ 概念可复用 | 纯映射表，无需本地对象 |
| `readResult` / `finalAssistantOutput` / `foldConsumedWork` | ❌ | 需要本地 `child.session` 事件日志 |
| `drivePublishedRun` | ❌ | 需要 `child.followup/whenIdle/cancel` |
| `attachStructuredRuntime`（`structured_output` 工具） | ❌ | 需要 `childCtx.tools.register/systemPrompt.section/tools.guard/on('tools/result')` |
| `attachDescriptorAppend` | ❌ | 需要 `childCtx.on('agent/pre-step')` + `agent.session.append` |
| `parent.ctx.agents.create()` | ❌ | 宿主进程内的 Agent 工厂 |
| `captureDelegatedPolicyOverrides` / `applyChildComposition` / `childSessionMeta` | ❌ | 全部写本地 session / 本地 scope |
| `structured_output` 的**契约**（工具名 + 指令文本 + `{recorded:true}` 应答） | ✅ 可作为自己 runtime 的参考 | 常量在 `index.js:21,27,55-79` |

`structured` 的契约常量（若远程 runtime 想对齐模型体验可直接照抄名称与指令）：

```js
// .../dsh-subagent-in-process-driver/lib/index.js:21,27,52
const STRUCTURED_OUTPUT_TOOL = "structured_output";
const STRUCTURED_OUTPUT_INSTRUCTION = `When you have your final answer, you MUST report it by calling the \`${STRUCTURED_OUTPUT_TOOL}\` tool with arguments matching its parameter schema exactly. Do not finish with a plain text answer: only the tool call counts as your result.`;
description: "Report your final structured result. Call this exactly once, when your answer is complete; the arguments must match this tool's parameter schema exactly.",
```

---

## 6. 进程外 provider 必须自己实现什么；continuable 是否可能

### 结论

进程外 provider 必须自己实现：**进程/传输机制**（spawn、stdio 帧、env scrub、teardown ladder、
托管进程范围回收）＋ **结果结算**（`result` 永不 reject）＋ **run handle 发布**。
`dsh-subagent` 已经把这三块里"契约相关"的部分抽成 `out-of-process.js` 的 4 个 hook 直接复用：

- `NO_START_CAPABILITIES` —— 强制 5 位全 false，使请求在 `start` 前被服务拒绝；
- `settleRunResult(parts)` —— 把 attempt 的 resolve/reject 归一成 `SubagentResult`，取消优先；
- `subprocessRunHandle(parts)` —— 发布 `{id, localAgent: undefined, result, dispose}`，`dispose` 幂等；
- `resolveChildCwd(prefix, configured, parentCwd)` —— cwd 解析（配置覆盖 → 父 session workspace）。

另有 `assertPositiveFinite` / `assertUsableCwd` / `validateConfiguredCwd` / 4KB diagnostic 截断。
**进程机制本身不属于这个缝**，属于 `dsh-subprocess`（README `.../dsh-subprocess/README.md:32`：
"the bash executors, the LSP host, the PTY shell backend, **or an out-of-process subagent backend**"）。

**continuable（可续聊）子 Agent 不可能由进程外 provider 支持** —— 这**不是**能力位问题，而是架构问题：
`prepareContinuable` 只能返回 `seed`，孩子仍由**本地** `ctx.agents.create/resume` 物化，
Activation/Inbox/驱动循环全部是进程内对象；冷恢复明确写了
"**no subagent provider is dispatched**"。README 的措辞是
"remote providers need an Activation ownership contract before they can support continuable children"。

### 证据

**复用 hook 1：能力广告 = 全 false**

```js
// .research/asar/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/types/out-of-process.js:43-55
/**
 * The capability advertisement of an out-of-process backend: NONE. A child in
 * another process cannot honor parent-enforced start features
 * (`agentOptions`/`outputSchema`/`maxDepth`/`toolFilter`/`persona`), so the service rejects a
 * request needing any of them before `start` runs — never accepted-then-ignored.
 */
export const NO_START_CAPABILITIES = Object.freeze({
    agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false,
});
```

**复用 hook 2：结果结算（`result` 永不 reject）**

```js
// .../dsh-subagent/lib/types/out-of-process.js:163-194
export async function settleRunResult(parts) {
    try {
        const result = await parts.attempt();
        return parts.cancelled() ? { output: parts.collectOutput(), stopReason: 'aborted' }
                                 : normalizeSubagentDiagnostic(result);
    } catch (error) {
        if (parts.cancelled()) return { output: parts.collectOutput(), stopReason: 'aborted' };
        try { parts.onError?.(toError(error), 'error'); } catch { /* sink cannot reject the run result */ }
        const collected = parts.collectDiagnostic?.();
        const diagnostic = collected === undefined ? undefined : limitSubagentDiagnostic(collected);
        return { output: parts.collectOutput(), ...diagnostic === undefined ? {} : { diagnostic }, stopReason: 'error' };
    } finally { parts.signal.removeEventListener('abort', parts.onAbort); }
}
```

diagnostic 上限 4096 字节且不切断 UTF-8 序列（`out-of-process.js:16-42`）。

**复用 hook 3：run handle 发布**

```js
// .../dsh-subagent/lib/types/out-of-process.js:195-218
/**
 * Publish the seam run handle for an out-of-process child. `dispose()` is
 * idempotent (one memoized teardown): it removes the abort listener, settles
 * local cancellation — there is no assumption the child cooperates — and then
 * awaits the backend's teardown to actual exit.
 * @returns the seam run handle (`localAgent` is `undefined` for remote runs).
 */
export function subprocessRunHandle(parts) {
    let disposal;
    return {
        id: parts.id,
        localAgent: undefined,
        result: parts.result,
        dispose() {
            if (disposal !== undefined) return disposal;
            parts.signal.removeEventListener('abort', parts.onAbort);
            parts.requestCancel();
            disposal = parts.teardown();
            return disposal;
        },
    };
}
```

**复用 hook 4：cwd 解析**

```js
// .../dsh-subagent/lib/types/out-of-process.js:137-144
export function resolveChildCwd(prefix, configured, parentCwd) {
    if (configured !== undefined) return configured;
    if (parentCwd === undefined) {
        throw new Error(`${prefix}: no working directory for the child — configure \`cwd\` or delegate from a parent session that has one`);
    }
    return assertUsableCwd(prefix, 'parent session cwd', parentCwd);
}
```

辅助校验：`assertPositiveFinite`（`:63-67`）、`assertUsableCwd`（`:97-105`，`isAbsolute` + 目录存在 +
`X_OK` 可进入）、`validateConfiguredCwd`（`:116-123`，拒绝空串、相对路径按启动目录解析）。

**必须自己实现**（缝刻意不提供）：进程 spawn / env scrub（`dsh-subprocess` 的 `scrubbedParentEnv`，
`.../dsh-subprocess/lib/index.js:32,50-56`；或用 `stdio.control: 'pipe'` 的控制通道，
`.../dsh-subprocess/README.md:66`）、协议帧、teardown ladder
（`.../dsh-subprocess/README.md:151`："each out-of-process consumer encodes its child's cooperation shape itself
(the ACP backend's stdin-EOF-first ladder is the in-repo template)"）、模型输出 → `ContentBlock[]` 的转换、
`diagnostic` 生成、`structured` 提取（若想支持 outputSchema，**但 capability 位必须谎报 true 才可能**——
而这也意味着父进程无法强制它）。

**continuable 的架构性阻断**——`prepareContinuable` 只交 seed，孩子由本地物化：

```js
// .../dsh-subagent/lib/types/continuation.js:133-175（startContinuable 内）
const prepared = await this.host.prepareContinuable(spec.provider, { sessionId: childId, parent, signal: spec.signal });
spec.signal.throwIfAborted();
...
const activation = await this.activations.materialize({
    childId, provider: spec.provider, parent,
    create: { seed, meta: childSessionMeta(parent, childDepth, prepared.seed !== undefined),
              inheritedEventCount, delegatedPolicies, descriptor },
    agentOptions, composition: { persona: request.persona, toolFilter: request.toolFilter }, signal: spec.signal,
});
```

```js
// .../dsh-subagent/lib/types/continuation-activation.js:450-467
const handle = create === undefined
    ? await this.ownerCtx.agents.resume({ resumeSessionId: childId, parentAgent: parent, agentOptions: inputs.agentOptions, signal: inputs.signal, setup })
    : await this.ownerCtx.agents.create({ sessionId: childId, parentAgent: parent, meta: create.meta,
        ...(create.seed === undefined ? {} : { seed: create.seed }), inheritedEventCount: create.inheritedEventCount,
        agentOptions: inputs.agentOptions, signal: inputs.signal, setup });
```

冷恢复**不再派发 provider**：

```js
// .../dsh-subagent/lib/types/continuation.js:334-337
/**
 * Cold-resume a persisted child and submit the waiting turn. The descriptor
 * supplies every reconstruction input; no subagent provider is dispatched.
 */
async coldResume(parent, childId, content, options) {
```

README 的明示限制（关键词命中）：

```md
<!-- .research/asar/dsh/node_modules/@deepseek-ai/dsh-subagent/README.md:188 -->
- **ACP children remain one-shot and are not trace-enumerable** — an ACP run has no local child
  session in the parent's session corpus, and remote providers need an Activation ownership
  contract before they can support continuable children.
```

```md
<!-- .../dsh-subagent/README.md:137 -->
- [Out-of-process ACP backend](../subagent-acp/README.md) — children with their own runtime over the Agent Client Protocol.
```

```md
<!-- .../dsh-subagent/README.md:51 -->
One-shot and external-provider runs are outside this limit. Pool inheritance does not cross a one-shot parent; ...
```
（即 `maxActiveSubagents` 只管进程内 continuable，进程外 run 不受限——因为它们不产生 Activation。）

```md
<!-- .../dsh-subagent/README.md:193 -->
- **Process-local residency** — the Activation inbox and ownership graph do not coordinate two harness
  processes; concurrent access to one persistence store needs a durable mailbox and cross-process lease protocol.
```

```md
<!-- .../dsh-subagent/README.md:206-207（Dev Note，非权威） -->
- **Cross-process continuation** — a durable mailbox and lease protocol would let two harness processes share one persistence store.
- **Continuable ACP children** — requires persisting the remote session id and a per-child continuation advertisement.
```

```md
<!-- .../dsh-subagent/README.md:107（one-shot flow，权限系统说明） -->
... DSH SDK also advertises `agentOptions` but runs a separate child runtime, so it does not inherit Auto;
ACP, Codex, and Claude Code likewise retain their own permission systems after the parent delegation call passes review.
```

工具侧的硬约束（provider 若无 `prepareContinuable`，`backgroundMode: continuable` 直接拒绝装载）：
`.../dsh-tool-subagent/lib/index.js:380`。

`prepareContinuable` 的方法-即-能力语义：`.../dsh-subagent/lib/types/index.js:426-433`（见 Q1）。

> **对本项目（远程/LAN 对等机）的直接含义**：把 LAN 对等机做成 provider，只能拿到 **one-shot** 语义，
> 且必须挂 `NO_START_CAPABILITIES`（否则 `agentOptions`/`persona`/`toolFilter`/`maxDepth`/`outputSchema`
> 请求会在 `start` 前被拒）。`backgroundMode: continuable` 必须留在 `one-shot`，
> 否则 `dsh-tool-subagent` 装载即抛错。若必须支持续聊，缝需要改造成
> "Activation ownership contract"（本地 Activation 与远端 session 的租约），这正是 README 列为
> deferred work 的部分。

---

## 7. `dsh-tool-subagent-control` 的 `list_agents` 契约（roster 来源）

### 结论

`list_agents` 在**独立子路径导出** `@deepseek-ai/dsh-tool-subagent-control/list-agents` 里，
`inject = ['tools','subagents','agents']`。它**不读任何内存 roster**：roster 来源是
`ctx.subagents.listChildren(parent.id)` / `listDescendants(parent.id)`（→ `sessionQuery.observeSession()`
+ 父 session 的 `subagentCatalog` 投影），再用 `ctx.agents.get(id)?.status === 'running'` 判活。
one-shot 子会被 `project()` 过滤掉（模型永远看不见它们；但 descendant 遍历仍然穿过它们）。
根 `dsh-tool-subagent-control` 本身只注册 `send_message` + `interrupt_agent`。

### 证据

```js
// .research/asar/dsh/node_modules/@deepseek-ai/dsh-tool-subagent-control/lib/types/list-agents.js:11-12, 44-57
export const name = 'tool-subagent-list-agents';
export const inject = ['tools', 'subagents', 'agents'];
...
ctx.tools.register(defineTool({
    name: 'list_agents',
    description: 'List subagents you started, with their ids, labels, and status. '
        + 'running means it is working; inactive means it is not currently working. '
        + 'You will be notified when a subagent finishes; there is no need to keep checking its status. '
        + 'Use send_message to continue the conversation.',
    parameters: {
        scope: { type: 'string', enum: ['children', 'descendants'],
            description: 'children (default) lists direct children, which accept send_message in any status. '
                + 'descendants lists the whole tree below you with each entry\'s parent session id and depth; entries deeper than 1 accept only interrupt_agent.' },
    },
```

roster 读取点（children / descendants 两条）：

```js
// .../dsh-tool-subagent-control/lib/types/list-agents.js:109-133
async execute(args, exec) {
    const parent = exec.agent;
    if (!parent) throw new Error('list_agents requires a calling agent (exec.agent was undefined)');
    const request = resolveListAgentsRequest(args);
    switch (request.scope) {
        case 'children': {
            const entries = await ctx.subagents.listChildren(parent.id, exec.signal);
            return entries.map(entry => project(ctx.agents, entry)).filter(entry => entry !== undefined);
        }
        case 'descendants': {
            const entries = await ctx.subagents.listDescendants(parent.id, exec.signal);
            return entries.map(entry => project(ctx.agents, entry, entry)).filter(entry => entry !== undefined);
        }
        default: return assertNever(request.scope, 'list_agents scope');
    }
}
```

活性判定 + one-shot 过滤（**roster 不含 one-shot**）：

```js
// .../dsh-tool-subagent-control/lib/types/list-agents.js:17-38
function statusOf(agents, id) { return agents.get(id)?.status === 'running' ? 'running' : 'inactive'; }
function project(agents, entry, position) {
    const at = position === undefined ? {} : { parent: position.parentId, depth: position.depth };
    if ('kind' in entry && entry.kind === 'diagnostic') return { kind: 'diagnostic', id: entry.id, reason: entry.reason, ...at };
    // One-shot children cannot be continued by send_message, so the model
    // never selects them; discovery still traversed them for descendants.
    if (entry.mode !== 'continuable') return undefined;
    return { kind: 'child', id: entry.id, label: entry.label, status: statusOf(agents, entry.id), ...at };
}
```

底层 roster（父 session 的 `subagentCatalog` 投影，不加载/恢复任何 Agent）：
`.../dsh-subagent/lib/types/list-children.js:67-90`（见 Q2）
与 `.../dsh-subagent/lib/typert.host.js:169-172`：

```js
"signature": "listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentCatalogEntry[]>"
```

根控制包只注册两个工具：

```js
// .../dsh-tool-subagent-control/lib/index.js:6-16
/**
 * The globally named `send_message` and `interrupt_agent` tools: thin
 * model-facing adapters over `ctx.subagents.sendMessage()` and
 * `ctx.subagents.interrupt()`. They perform no lifecycle routing of their own —
 * residency, cold resume, and interrupt authorization belong to the subagent
 * service — ...
 */
const name = "tool-subagent-control";
const inject = ["tools", "subagents"];
```

装配证据：`dsh-base/cordis.patch.yml:364-368`（两个独立 loader 行）。

---

## 8. DSH 里是否已存在远程/跨进程 subagent provider 实装

### 结论

**在本 Electron 构建的 asar 里不存在。** 只装了两个 in-process provider（`spawn`、`fork`）。
但在**上游仓库的源码清单**里，缝明确规划了 4 个进程外/远程 provider：
`dsh-subagent-acp`、`dsh-subagent-claude-code`、`dsh-subagent-codex`、`dsh-subagent-dsh-sdk`。
它们出现在随包分发的生成文档 `dsh-agent-preset/.../packages.md` 与多个 README 的交叉引用里，
但**包体不在 asar 中**（header JSON 与全文扫描双重证实）。
默认装配里 `codex`/`claude-code` 的 tool 行存在但 `disabled: true`（且 provider 缺失 → 即使启用也只会打印
"not registered yet" 而不注册工具）。`dsh-acp` 是 **ACP 服务端**（DSH 被自动化客户端驱动），
不是 subagent provider；其 README 明确说客户端是 `dsh-subagent-acp`（仓库内，未分发）。

### 证据

**（a）asar 内实际存在的 subagent 相关包**（header JSON 包名过滤）：

```
dsh-client-ui-settings-subagent
dsh-client-ui-subagent
dsh-subagent
dsh-subagent-fork-in-process
dsh-subagent-in-process-driver
dsh-subagent-spawn-in-process
dsh-tool-subagent
dsh-tool-subagent-control
```

**（b）`ctx.subagents.registerProvider(...)` 的调用方只有两处**（全库内容扫描，10,529 个 packed 文件）：

```
dsh-subagent-spawn-in-process/lib/index.js:42  ctx.subagents.registerProvider(new SpawnInProcessProvider(config.providerName));
dsh-subagent-fork-in-process/lib/index.js:58   ctx.subagents.registerProvider(new ForkInProcessProvider(config.providerName));
```

（其余 30+ 个 `registerProvider` 命中属于 `ctx.skills.registerProvider`（`dsh-skill*`）、
`dsh-typert-registry`、`dsh-skill-badge/office/filesystem`、`@earendil-works/pi-ai` bedrock —— 与本缝无关。）

**（c）`subagent-acp` 在 asar 中的全部出现位置**（内容扫描）：

```
dsh-acp/README.md: 12, 55, 124
dsh-acp/README.zh.md
dsh-agent-preset/skills/cordis-composition-reference/references/packages.md:435
dsh-sandbox/README.md:183
dsh-subagent/README.md:137；dsh-subagent/README.zh.md
dsh-subagent/lib/types/out-of-process.js:59（JS 注释里的示例前缀 `subagent-acp`）
```

**均为文档/注释引用，无实现文件**（asar header 中 `subagent-acp` 字符串 index = -1，即不存在同名目录）。

**（d）上游仓库规划的全部 subagent provider**（随包分发的生成清单）：

```md
<!-- dsh-agent-preset/skills/cordis-composition-reference/references/packages.md:430-442 -->
## subagent

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-subagent` | yes | Abstract subagent seam (ctx.subagents): named-provider registry for delegating to child agents |
| `@deepseek-ai/dsh-subagent-acp` | yes | Out-of-process ACP subagent backend: drives a child agent in a spawned subprocess over the Agent Client Protocol |
| `@deepseek-ai/dsh-subagent-claude-code` | yes | One-shot Claude Code subagent provider over the official Agent SDK |
| `@deepseek-ai/dsh-subagent-codex` | yes | One-shot Codex subagent provider over the official app-server protocol |
| `@deepseek-ai/dsh-subagent-dsh-sdk` | yes | Out-of-process SDK subagent backend: drives a child DeepSeek Harness runtime subprocess over stdio JSON-RPC through the TypeScript SDK client |
| `@deepseek-ai/dsh-subagent-fork-in-process` | yes | In-process fork subagent backend: runs a child agent seeded with a prefix of the parent's log |
| `@deepseek-ai/dsh-subagent-spawn-in-process` | yes | In-process spawn subagent backend: runs a fresh child agent on ctx.agents |
| `@deepseek-ai/dsh-tool-subagent` | yes | Model-facing subagent delegation tool over the ctx.subagents seam |
| `@deepseek-ai/dsh-tool-subagent-control` | no | Globally named send_message, interrupt_agent, and list_agents tools over ctx.subagents continuations |
```

（该表 "Config" 列只表示该 loader 行是否接受 `config`，不代表是否分发。文件头
`packages.md:5`："Every package below exports a Cordis plugin that a bundle patch can name in a Loader row."）

**（e）`dsh-acp` 是服务端，不是 provider；客户端是未分发的 `dsh-subagent-acp`**：

```md
<!-- dsh-acp/README.md:12 -->
Run `pnpm dsh --profile acp` to start the server; use `dsh-subagent-acp` as the repository client.
```
```md
<!-- dsh-acp/README.md:55 -->
[`@deepseek-ai/dsh-subagent-acp`](../../subagent/subagent-acp/README.md) starts the same profile for out-of-process delegation.
```
```md
<!-- dsh-acp/README.md:124 -->
- [dsh-subagent-acp](../../subagent/subagent-acp/README.md) — the out-of-process ACP client that spawns and drives this server.
```

`dsh-acp` 的 Config 里没有 `providerName`/`capabilities` 之类 provider 形态字段，只有
`provider`/`model`/`sessionListPageSize`（`dsh-acp/README.md:45-49`），其 `inject`/`apply` 也未见
`registerProvider`（见 (b) 的扫描结果）。

**（f）已分发的默认装配只挂 spawn + fork**：

```yaml
# dsh-base/cordis.patch.yml:349-360
- id: subagent
  name: '@deepseek-ai/dsh-subagent'
- id: subagent-spawn-in-process
  name: '@deepseek-ai/dsh-subagent-spawn-in-process'
  config: { providerName: spawn }
- id: subagent-fork-in-process
  name: '@deepseek-ai/dsh-subagent-fork-in-process'
  config: { providerName: fork }
```

```yaml
# dsh-web-app/presets/standard.patch.yml:103-118（codex / claude-code 行被禁用）
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config: { provider: codex, toolName: subagent_codex, backgroundMode: one-shot, maxDepth: provider-managed }
- id: tool-subagent-claude-code
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config: { provider: claude-code, toolName: subagent_claude_code, backgroundMode: one-shot, maxDepth: provider-managed }
```

（`dsh-web-app/presets/ptc.patch.yml:103-118` 与 `dsh-base/cordis.patch.yml:383-388` 同构。）

**（g）sandbox 侧也把 `subagent-acp` 当"未决定的未来消费者"**：

```md
<!-- dsh-sandbox/README.md:183 -->
The [sandbox decision](...) lists deferred phases — an optional `subagent-acp` consumer that confines
child agents (unconfined default) and environment-coherent capability group examples.
```

---

## 9. 由以上证据导出的可行性判断（派生结论，非新增证据）

1. **可以**新增一个 `SubagentProvider`（`ctx.subagents.registerProvider`）指向 LAN 对等机，
   无需改 `dsh-subagent` 本体：接口只有 4 个必填成员，注册是 effect-scoped、HMR 安全
   （`types/index.js:345-361`）。
2. **必须**把 `capabilities` 设为全 false（用 `NO_START_CAPABILITIES`），否则任何带
   `agentOptions`/`persona`/`toolFilter`/`maxDepth`/`outputSchema` 的请求会在 `start` 前被
   `assertCapabilities` 拒绝（`types/index.js:457-470`）。同时 `run.localAgent` 必须为 `undefined`
   → 父 session **不会**有 `subagent/catalog` 事实 → `list_agents`/`listChildren` 看不到它
   （`types/index.js:402-418` + `list-agents.js:29-30`）。
3. **必须**把 `inheritsParentContext` 设为 `false`（远程对等机拿不到父的本地 session 事件；
   声明 `true` 只会让模型看到错误的 prompt 指引，`tool-subagent/lib/index.js:344-353`）。
4. **不能**提供 `prepareContinuable`，因此 `backgroundMode` 必须保持 `one-shot`
   （`tool-subagent/lib/index.js:380`）；`dsh-tool-subagent` 的后台路径会走
   `ctx.jobs.start({kind:'subagent'})`（`tool-subagent/lib/index.js:536-555`），这条可用。
5. `run_in_background`/`job_output`/`job_kill` 与 `workflow` 工具**自动可用**（它们只依赖
   `subagents.start`，见 `dsh-workflow-ptc/lib/index.js:328`）——但 workflow 的 provider 是
   静态配置 `provider: spawn`，若想让 workflow 打到远程对等机需另加一行
   `@deepseek-ai/dsh-tool-workflow` 或改 `workflow-ptc` 的 `provider` 配置
   （`dsh-base/cordis.patch.yml:393-396`）。
6. `interrupt_agent`/`send_message` 对远程 one-shot run **无效**：`interrupt` 走的是
   Activation registry（`continuation.js:288-290`），one-shot run 没有 Activation；
   `send_message` 要求 direct continuable child。取消远程 run 只能靠
   `run.dispose()` / `request.signal`。

### 未找到的内容（明确声明）

- 未找到 `dsh-subagent-acp` / `dsh-subagent-codex` / `dsh-subagent-claude-code` /
  `dsh-subagent-dsh-sdk` 的任何实现文件（asar header 无同名目录；全文扫描仅命中文档/注释）。
  搜索关键词：`subagent-acp`、`dsh-subagent-acp`、`codex`、`claude-code`、`remote`、`peer`、`lan`、`ssh`。
- 未找到 `SubagentRunInfo` / `SubagentRunEndInfo` 的类型声明（`typert.host.js` types 列表里没有；
  仅 4 处引用，形状需从 `lifecycle.js` 反推，见 Q1 注）。
- 未找到 `ctx.subagents` 的任何跨进程/远端传输实现（`typert.remote-client.js` 只把
  `subagents.prompt` 与 `subagents.interruptByParent` 两个方法暴露给 Typert Remote 客户端，
  **provider 注册不在 wire 上**）。
