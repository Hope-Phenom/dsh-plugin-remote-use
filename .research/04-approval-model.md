# DSH 审批 / 自动审批 / 权限预设 / 沙箱策略 —— 真实语义调研报告

- 目标版本：DSH Desktop `0.2.0-rc.2`（Electron asar）
- 安装目录（只读，未修改）：`C:\Users\you\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
- 本报告所有 `路径:行号` 均指向 asar 内部相对路径 `dsh\node_modules\@deepseek-ai\<pkg>\...`。
  为便于复核，同样的文件已解包到 `F:\WorkSpace\dsh-plugin-remote-use\.research\asar\` 下**完全相同的相对路径**（行号一致，本文引用的是解包副本的实际读取结果）。
- 解包/解码工具（本次新增，均在 `.research\` 内，只读 asar）：
  - `extract-many.mjs`（按正则批量解包）
  - `read-session-log.mjs`（逐 zstd frame 解码会话日志）
  - `scan-approvals.mjs`（全量会话日志扫描 `approval/asked`）
- 现场配置：`C:\Users\you\.dsh\profiles\desktop\package.json`（bundles 含 `@deepseek-ai/dsh-experimental-auto-review`）、
  `C:\Users\you\.dsh\profiles\desktop\cordis.patch.yml`、`C:\Users\you\.dsh\settings.yaml.imported`。

> 术语约定：本文中「放行」= `allowed-once`；「拒绝」= `rejected`；「取消」= `cancelled`；「无审批通道」= `unavailable`。

---

## A. 审批机制本体

### A1. `ctx.approval` 的完整 API

服务类：`ApprovalService`（service key `"approval"`）。

**入口/服务定义**（`dsh-user-approval/lib/index.js:72-90`）：

```js
var ApprovalService = class extends Service {
	config;
	static Config = z.object({ policy: z.union(["ask", "never"]).default("ask") });
	constructor(ctx, config) {
		super(ctx, "approval");
		this.config = config;
		...
```

**方法签名（权威目录）**（`dsh-tool-cordis/lib/types/api-catalog.js:319-343`）：

```js
{ key: 'approval',
  methods: [
    { signature: 'setPolicy(agent: Agent, policy: ApprovalPolicy): void', ... },
    { signature: 'async request(req: ApprovalRequest): Promise<ApprovalOutcome>', ... },
    { signature: 'overrideOf(session: Session): ApprovalPolicy | undefined', ... },
  ] }
```

实现里还有一个**未进目录的公开方法** `effectivePolicy(session)`（`dsh-user-approval/lib/index.js:152-154`）：

```js
	effectivePolicy(session) {
		return this.overrideOf(session) ?? this.config.policy ?? "ask";
	}
```

**数据结构**（`dsh-tool-cordis/lib/types/api-catalog.js:4462-4477`）：

```ts
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
export type ApprovalPolicy  = 'ask' | 'never';
export interface ApprovalRequestEvent {
    readonly agent: Agent;
    readonly toolName: string;
    readonly callId?: ToolCallId;
    readonly reason?: string;
    readonly displayReason?: { readonly en: string; readonly [locale: string]: string };
    readonly signal?: AbortSignal;
}
export interface ApprovalRequest extends ApprovalRequestEvent { readonly agent: Agent; ... }
```

`policy` 的合法取值被硬编码为两个字面量（`dsh-user-approval/lib/index.js:37`）：

```js
const APPROVAL_POLICIES = ["ask", "never"];
```

`setApprovalPolicy(session, policy)` 是唯一的持久化写路径，非法值在写日志前抛错（`dsh-user-approval/lib/index.js:63-66`）：

```js
function setApprovalPolicy(session, policy) {
	if (!APPROVAL_POLICIES.includes(policy)) throw new TypeError("approval policy must be one of \"ask\" or \"never\"");
	session.append("approval/policy", { policy });
}
```

**`request(req)` 的完整语义**（`dsh-user-approval/lib/index.js:128-144`）：

```js
	async request(req) {
		const session = req.agent.session;
		if (!hasOpenTurn(session)) throw new Error("approval.request() outside an open turn: ...");
		const id = ApprovalRequestId(randomUUID());
		session.append("approval/asked", {
			id,
			toolName: req.toolName,
			...req.callId !== void 0 ? { callId: req.callId } : {},
			...req.reason !== void 0 ? { reason: req.reason } : {}
		});
		const outcome = await this.decide(req, session);
		session.append("approval/decided", { id, outcome });
		return outcome;
	}
```

- **必须在 open turn 内调用**，否则在写任何审计事件之前就抛错（`index.js:130`，`hasOpenTurn` 见 `index.js:49-56`）。
- 先写 `approval/asked`，再决策，再写 `approval/decided`；两次 append 都成功才算返回。

**`decide()`：策略先于 answerer，且与 signal 赛跑**（`dsh-user-approval/lib/index.js:172-189`）：

```js
	async decide(req, session) {
		const signal = req.signal;
		if (signal?.aborted) return "cancelled";
		if (this.effectivePolicy(session) === "never") return "rejected";
		const answer = Promise.resolve().then(() => this.ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, () => Promise.resolve("unavailable"))).then((outcome) => OUTCOMES.includes(outcome) ? outcome : "unavailable", () => "unavailable");
		if (signal === void 0) return answer;
		return await new Promise((resolve) => {
			const onAbort = () => { ...; resolve("cancelled"); };
			signal.addEventListener("abort", onAbort, { once: true });
			answer.then((outcome) => { ...; resolve(outcome); });
		});
	}
```

关键点：
1. `never` 策略在**进入 waterfall 之前**就确定性返回 `rejected`（`index.js:175`）——即使有 `prepend` 监听器也无法绕过（README 明说不允许 sibling 顺序当优先级）。
2. waterfall 的**兜底返回 `"unavailable"`**（`index.js:176` 最后一个参数）——无终端 answerer 时 fail closed。
3. answerer 抛异常 → `.then(onFulfilled, () => "unavailable")` 归一化为 `unavailable`；非法返回值也归一化为 `unavailable`。
4. `signal.aborted` → `cancelled`，且**迟到的答案被丢弃**（race 已 resolve）。

**超时行为：没有超时。**
- `dsh-user-approval/lib/index.js` 全文无 `setTimeout`/`deadline`（对 `dsh-user-approval/lib/` 与 `dsh-acp/lib/` 搜 `timeout|setTimeout|deadline|AbortSignal` 只命中 `signal`）。
- 上层 tools 管线也不给 approval 加超时（见 A3 的顺序论证）。
- 实证：本机 `--F-WorkSpace-AokoCSharpFramework--\session-a04a369f-…` 中 `approval/asked` 的 `time`=`1791423240408`，`approval/decided` 的 `time`=`1791423523174`，**相隔 282,766 ms ≈ 4 分 43 秒**，期间没有任何超时触发。

**无人在场时**：由 `ctx.waterfall(..., () => "unavailable")` 决定——若组合中**没有任何** `approval/request` 监听器，结果为 `unavailable`；同理，若监听器存在但不可用（例如 ACP 连接断开导致请求 reject），也是 `unavailable`。消费方对 `unavailable` 的处理是**拒绝**（见 A3）。
但**注意一个例外**：Web/Remote 通道下"无人连接"时不会 fail closed，而是**永久挂起**（证据见 C11-②）。

**答案者的注册方式**（README `dsh-user-approval/README.md:32`）：

> Answerers are `approval/request` waterfall listeners: return an outcome to answer for an owned agent, or call `next()` to delegate. …
> Without a terminal answerer, requests resolve `unavailable` and fail closed; the service itself never prompts a human.

**Scoping**：waterfall 用 `scopeTarget(req.agent, req.agent)`，且 scope 层声明了该事件的 carrier 提取器（`dsh-scope/lib/invariant.js:22`）：

```js
	"approval/request": (args) => args[0]["agent"],
```

即 agent-scoped 的监听器只能收到该 agent 的请求。

**审计对不变式**（`dsh-user-approval/lib/invariant.js:202-214`）：`approval/asked` 必须在 open turn 内、`toolName` 非空、id 不重复；`approval/decided` 必须有配对 `asked`，且 outcome 属封闭词表。

**已知限制（官方自述）**（`dsh-user-approval/README.md:154-157`）：

```
- **Requests are valid only inside an open turn** ...
- **Only one-shot grants exist** — the outcome vocabulary has `allowed-once` but no `allow-always`, remembered rule, revocation, or grant store; session policy is only `ask` / `never`.
- **The request carries no tool arguments** — an answerer sees the tool name, reason, and optional call id; the ACP machine channel requires a call id and delegates requests without one.
- **No built-in answerer** — headless or incompletely composed deployments resolve `unavailable` and fail closed; the service itself never prompts a human.
```

### A2. UI 呈现：只有「允许一次 / 拒绝」

Client 包：`@deepseek-ai/dsh-client-ui-approval`（浏览器侧，注册 DOM slot 与 Remote 监听）。

**两个按钮 + 两个快捷键，仅此而已**（`dsh-client-ui-approval/lib/client.js:119-134`）：

```jsx
(0, react_jsx_runtime.jsx)(Button, { variant: "outline", ... onClick: () => { answer("rejected"); }, children: t("reject") }),
(0, react_jsx_runtime.jsx)(Button, { variant: "primary", ... onClick: () => { answer("allowed-once"); }, children: t("allowOnce") })
```

```js
// dsh-client-ui-approval/lib/client.js:70-80
const keydown = (event) => { ... answer(event.key === "Enter" ? "allowed-once" : "rejected"); };
```

**文案字典**（`dsh-client-ui-approval/lib/client.js:257-271`）：

```js
const zh = { waiting: "等待审批", "detail.aria": "审批详情", escalation: "工具 {toolName} 请求越权执行", reject: "拒绝", allowOnce: "允许一次" };
const en = { waiting: "Waiting for approval", "detail.aria": "Approval details", escalation: "Tool {toolName} requests privileged execution", reject: "Reject", allowOnce: "Allow once" };
```

**明确没有「记住/总是允许/本次会话放行」**（`dsh-client-ui-approval/README.md:36`）：

```
- **The panel exposes transient decisions only** — it supports allow-once and reject; persistent permission policy remains owned by Host-side approval packages.
```

**答案是回灌到 Host waterfall**（`dsh-client-ui-approval/lib/client.js:355-357`，配合 `answerApproval()` 的 `pending.answer(outcome)` / `pending.delegate()`→`next()`，`client.js:284-310`）：

```js
			ctx.remote.$on("approval/request", function(request, next) {
				return answerApproval(ctx, this, request, next, registerPendingInteraction);
			});
```

注意：ACP 的 schema 里存在 `allow_always` / `reject_always` 两种 `kind`（见 C10），但 **DSH 从不填**。

### A3. 一次工具调用的完整链路与拦截点

`dsh-tools` 的顺序调度器把一次调用拆成 `prepare → dispatch → finalize`。核心在 `prepareExecution()`（`dsh-tools/lib/index.js:3214-3274`）：

```js
	async prepareExecution(input, next) {
		const created = this.createExecution(input);
		if (created.kind !== "ready") return next(created);
		const exec = created.exec;
		if (this.callerCancelled(exec)) return next({ kind: "final-result", exec, result: toolAbortedBeforeDispatchResult() });
		try {
			const carrier = scopeTarget(this, exec.agent);
			const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
			const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : { decision: gate, approvalCancelled: false };
			const { decision } = askResolution;
			if (this.callerCancelled(exec) && askResolution.approvalCancelled) return await next({ kind: "post-result", ... });
			if (decision.kind === "cancel") return await next({ kind: "post-result", exec, result: toolAbortedBeforeDispatchResult() });
			const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
			const denialInfo = decision.kind === "deny" ? decision.info : void 0;
			if (denialReason !== void 0) return await next({ kind: "post-result", exec, result: this.materializeFinalResult({
				content: [{ type: "text", text: `Error: ${denialReason}` }],
				isError: true,
				error: { message: denialReason, ...denialInfo === void 0 ? {} : { info: denialInfo } }
			}) });
			...
			return await next({ kind: "dispatch", exec });
```

工具体在 dispatch 阶段经 `tools/execute` waterfall 后执行（`dsh-tools/lib/index.js:3327-3331`）：

```js
	async dispatchScheduledExecution(exec) {
		...
			const result = await this.ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec));
```

管线不变式（`dsh-tools/lib/invariant.js:68-83`）确保 `tools/pre-execute` 只发生一次，且 `tools/execute` 必须在其后。

**完整链路（模型 → 执行/被拒）**

| # | 拦截点 | 位置 | 能力 |
|---|---|---|---|
| 0 | 工具存在性 / 参数 schema 校验 | `dsh-tools` `createExecution` / `validateArgs` | 拒绝（`ToolNotFoundError` / `ToolArgsError`） |
| 1 | `tools/pre-execute` waterfall（可扩展，默认 `{kind:"allow"}`） | `dsh-tools/lib/index.js:3225` | 可 `allow` / `deny` / `ask` / `cancel` |
| 2 | `gate.kind==="ask"` → `serviceAsk()` → `ctx.approval.request()` | `dsh-tools/lib/index.js:3226, 3439-3491` | 走 approval 策略 + answerer |
| 3 | `tools.guard()` 单调守卫（仅在决策为 `allow` 时查） | `dsh-tools/lib/index.js:3241, 2921-2936` | **只能拒绝，不能放行** |
| 4 | `tools/execute` waterfall（含工具超时包装） | `dsh-tools/lib/index.js:3331` | 可替换/包裹执行 |
| 5 | 工具体内部的沙箱强制 + 提权申请（`approveEscalation`） | `dsh-sandbox/lib/index.js:99-123`、`dsh-tool-bash/lib/index.js:641-648` | 直接再调一次 `approval.request()` |
| 6 | `tools/post-execute` waterfall | `dsh-tools/lib/index.js:3503-3504` | `accept` / `block` |

**谁有权最终决定**：`prepareExecution` 本身。规则是单调否决：
- 任何 listener 返回 `deny` → 直接拒绝（后续 listener 不再执行，因为 waterfall 短路）。
- `ask` 被 approval 解析成 `allow` 之后，**才**查 guard；guard 只能给拒绝理由（`dsh-tools/lib/index.js:2921-2926` 注释）：

```js
	* Register a monotonic guard after the extensible `tools/pre-execute`
	* waterfall. ... Any matching guard may deny by
	* returning a reason, while no guard can force-allow a call another guard
	* denied.
```

**`serviceAsk()` 的 outcome → 决策映射**（`dsh-tools/lib/index.js:3439-3491`）：

```js
	async serviceAsk(exec, ask) {
		const approval = this.ctx.get("approval");
		if (approval === void 0) return { decision: { kind: "deny", reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)` }, approvalCancelled: false };
		if (exec.agent === void 0) return { decision: { kind: "deny", reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through` }, approvalCancelled: false };
		const outcome = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, ...ask.reason !== void 0 ? { reason: ask.reason } : {}, ...ask.displayReason !== void 0 ? { displayReason: ask.displayReason } : {}, signal: exec.signal });
		switch (outcome) {
			case "allowed-once": return { decision: { kind: "allow" }, approvalCancelled: false };
			case "rejected":     return { decision: { kind: "deny", reason: `the user rejected tool "${exec.name}"` }, approvalCancelled: false };
			case "cancelled":    return { decision: { kind: "deny", reason: `approval for tool "${exec.name}" was cancelled` }, approvalCancelled: true };
			case "unavailable":  return { decision: { kind: "deny", reason: `tool "${exec.name}" requires approval, but no approval channel is available` }, approvalCancelled: false };
			default: return assertNever(outcome, "ApprovalOutcome");
		}
	}
```

→ **4 个 outcome 中只有 `allowed-once` 放行；其余 3 个都是拒绝，只是理由不同**（便于模型区分「人说不」与「没有审批通道」）。

**谁会产生 `ask`？** 在本机 shipped 组合中只有 auto-review（对 `.research\asar\...\@deepseek-ai` 全量 JS 搜 `kind: "ask"`，唯一命中 `dsh-experimental-auto-review/lib/index.js:436`）。其余 `dsh-tool-jobs` 的 pre-execute 监听器只做旁路记录后 `next()`（`dsh-tool-jobs/lib/index.js:235-239`）。

**沙箱提权不走 `ask` 决策，而是工具体里直接再调一次 `approval.request()`**（`dsh-sandbox/lib/index.js:99-123`）：

```js
async function approveEscalation(request, approval) {
	const { requestedMode: mode, effectiveMode, justification, subject } = request;
	if (mode === effectiveMode) return effectiveMode;                       // 同档：不需要审批
	if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`);
	if (approval.approver === void 0) throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`);
	if (approval.agent === void 0) throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`);
	const outcome = await approval.approver.request({
		agent: approval.agent, toolName: approval.toolName, callId: approval.callId,
		reason: `escalate sandbox to ${mode}: ${justification}`,
		displayReason: { en: `Allow this operation with ${mode} permissions: ${justification}`, zh: `允许本次操作使用 ${mode} 权限：${justification}` },
		...approval.signal ? { signal: approval.signal } : {}
	});
	switch (outcome) {
		case "allowed-once": return mode;
		case "rejected": throw new Error(`the user rejected escalating this ${subject} to "${mode}"; it stays denied, so stop and explain instead of working around it`);
		...
```

阶梯表（`dsh-sandbox/lib/index.js:30-33, 42`）：

```js
const WIDER_MODES = { "read-only": ["workspace-write", "danger-full-access"], "workspace-write": ["danger-full-access"] };
const ESCALATION_TARGETS = ["workspace-write", "danger-full-access"];
```

调用点（`dsh-tool-bash/lib/index.js:641-648`，`dsh-tool-fs` 同构）：

```js
			async execute(args, exec) {
				const standingPolicy = resolveSandboxPolicy(exec);
				validateBashArgs(args, standingPolicy?.mode);
				const approvedMode = args.sandbox_permissions !== void 0 && args.justification !== void 0 ? await approveBashEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy) : void 0;
```

### A4. `@deepseek-ai/dsh-permission-presets`：三个预设控制什么、作用域在哪

**预设 = 一个 (sandbox, approval) 二元组，仅此两项**（`dsh-permission-presets/README.md:134`）：

```
- **Only two mechanism knobs are bundled** — presets select sandbox mode and approval policy; ... an agent/profile choice is not part of `PresetSpec`.
```

**shipped 表（dsh-base 层）**（`dsh-base/cordis.patch.yml:250-262`）：

```yaml
    - id: permission
      name: '@deepseek-ai/dsh-permission-presets'
      config:
        presets:
          read-only:
            sandbox: read-only
            approval: ask
          workspace-write:
            sandbox: workspace-write
            approval: ask
          danger-full-access:
            sandbox: danger-full-access
            approval: never
```

本机 profile 覆盖为同样三项并把默认改成 `danger-full-access`（`C:\Users\you\.dsh\profiles\desktop\cordis.patch.yml:12-25`）：

```yaml
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
    defaultPreset: danger-full-access
```

**三项各自到底控制什么**

| 预设 | `sandbox/mode` | `approval/policy` | 实际效果 |
|---|---|---|---|
| `read-only` | `read-only` | `ask` | 文件沙箱只读（可写根为空）；bash/fs 的越权操作先被沙箱拒绝 → 模型若用 `sandbox_permissions` 重试 → 生成审批请求 |
| `workspace-write` | `workspace-write` | `ask` | 可写 workspace root + `/tmp` + `os.tmpdir()`；更宽操作需审批 |
| `danger-full-access` | `danger-full-access` | `never` | 文件沙箱不限制；**且审批策略为 never ⇒ 任何 approval 请求被确定性拒绝** |

沙箱模式的语义文本（`dsh-sandbox-policy/lib/index.js:72-83`）：

```js
		case "read-only": return "Current DSH file policy: read-only. ...";
		case "workspace-write": return `Current DSH file policy: workspace-write. ... ${JSON.stringify(policy.workspaceRoot)}. ...`;
		case "danger-full-access": return "Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.";
```

`workspace-write` 的可写根推导（`dsh-sandbox/lib/index.js:166-173`）：

```js
function writableRoots(policy) {
	if (policy.mode !== "workspace-write") return [];
	return [...new Set([ policy.workspaceRoot, "/tmp", tmpdir() ].map(canonicalPath))];
}
```

**作用域：会话级（写 session log 事件）+ 进程级（预设表 / 目录 / 默认值）**

- **进程级**：`presets` 表、`defaultPreset`、`catalog()`（`dsh-permission-presets/lib/index.js:138-159, 245-251`）。
- **会话级**：一次切换写 3 个会话事件（`dsh-permission-presets/lib/index.js:349-361`）：

```js
		apply(session, name, setApproval) {
			const spec = this.resolve(name);
			if (name === "auto") this.autoAdmit?.();
			const current = this.current(session);
			const knobs = this.permissionState(session);
			const updateKnobs = () => {
				if (spec.sandbox !== (knobs.sandbox ?? this.ctx.shell.sandboxMode)) setSandboxMode(session, spec.sandbox);
				if (spec.approval !== (knobs.approval ?? this.ctx.approval.config.policy ?? "ask")) setApproval(spec.approval);
			};
			if (current !== name) session.append("permission/preset", { preset: name });
			updateKnobs();
		}
```

- **读侧**：`current(session)` 由会话投影 `permissions` 折叠（`dsh-permission-presets/lib/index.js:188-201, 291-306`）：

```js
		current(session) { return this.derive(this.permissionState(session)); }
		derive(state) {
			const sandbox = state.sandbox ?? this.ctx.shell.sandboxMode;
			const approval = state.approval ?? this.ctx.approval.config.policy ?? "ask";
			const matches = (spec) => spec.sandbox === sandbox && spec.approval === approval;
			if (state.preset !== null) {
				const spec = this.specOf(state.preset);
				if (spec !== void 0 && matches(spec)) return state.preset;
				if (state.preset === "auto" && spec?.sandbox === sandbox && approval === "never") return AUTO_PRESET;
			}
			for (const [name, spec] of Object.entries(this.presets)) if (matches(spec)) return name;
			return CUSTOM_PRESET;
		}
```

- **新会话固定（pin）**：会话创建时写齐三个事实（`dsh-permission-presets/lib/index.js:370-389`）：

```js
		pinInitialPermission(session) {
			const state = this.permissionState(session);
			const { preset, sandbox, approval, seeded } = state;
			if (preset === "auto") { if (this.autoAdmit === void 0) throw new Error("permission: cannot restore preset \"auto\" without its active integration"); this.autoAdmit(); }
			if (preset === null && sandbox === null && approval === null && !seeded) {
				const name = this.defaultPreset;
				const spec = this.resolve(name);
				session.append("permission/preset", { preset: name });
				setSandboxMode(session, spec.sandbox);
				setApprovalPolicy(session, spec.approval);
				return;
			}
			...
```

- **`/permission` 命令（会话级切换入口）**（`dsh-permission-presets/lib/index.js:206-231`）：

```js
				commandCtx.commands.register({
					definitionId: CommandDefinitionId("@deepseek-ai/dsh-permission-presets"),
					name: "permission",
					description: "Switch the permission preset (sandbox mode + approval policy)",
					input: { hint: "<preset>" },
					handler: ({ agent, rawInput }) => { ... this.apply(agent.session, name, (policy) => { this.ctx.approval.setPolicy(agent, policy); }); ... }
```

- **默认预设只影响未来会话**（`dsh-permission-presets/README.md:64`）：`A resumed seed ... preserves its effective permission`。

**实证**（真实会话日志，见文末解码方法）`C:\Users\you\.dsh\sessions\--F-WorkSpace-dsh-plugin-remote-use--\session-03d7fd49-c7ba-41dc-8475-3b90a93a7f47\session.v4.jsonl.zstd`，前三个事件：

```json
{"type":"permission/preset","seq":0,"data":{"preset":"danger-full-access"}}
{"type":"sandbox/mode","seq":1,"data":{"mode":"danger-full-access"}}
{"type":"approval/policy","seq":2,"data":{"policy":"never"}}
```

---

## B. 自动审批（`@deepseek-ai/dsh-experimental-auto-review`）——重点

本机 profile **已启用**该 bundle（`C:\Users\you\.dsh\profiles\desktop\package.json:18`），它通过自己的 patch 插入一行（`dsh-experimental-auto-review/cordis.patch.yml:1-3`）：

```yaml
- insert:
    - id: auto-review
      name: '@deepseek-ai/dsh-experimental-auto-review'
```

### B5. 真实工作方式

**(a) 它是一个独立的 LLM 审查调用；用当前会话请求头的 provider/model；每次工具调用一次。**

输入五段（固定策略 + 4 段数据），模型温度 0（`dsh-experimental-auto-review/lib/index.js:399-416`）：

```js
async function classifyRisk(ctx, agent, exec, signal) {
	const snapshot = snapshotAutoReview(agent, exec);
	const options = deepFreeze({
		provider: snapshot.provider,
		model: snapshot.model,
		system: REVIEW_POLICY,
		messages: [{ role: "user", content: [{ type: "text", text: reviewUserText(snapshot) }] }],
		temperature: 0,
		signal
	});
	return readDecision(ctx.llm.stream(options));
}
```

路由取自最新请求头（`dsh-experimental-auto-review/lib/index.js:219, 312-314`）：

```js
	if (header === void 0 || header.config.provider.length === 0 || header.config.model.length === 0) throw new Error("auto-review: no complete request-header route is available");
	...
	return deepFreeze({ provider: header.config.provider, model: header.config.model, cwd, projectInstructions, history, action });
```

成本（官方自述，`dsh-experimental-auto-review/README.md:91`）：

```
One additional model request per supported call, without caching, retries, truncation, compaction, or a separate small output budget. An oversized request fails the call with the provider error.
```

即：**每个受支持的工具调用多 1 次主模型请求**（含每个已启动的 PTC 内部调用），无缓存、无独立输出预算。

**(b) 判定分级与动作**：只有 6 种合法输出，`low+allow` / `medium+allow` / `medium+deny[+reason]` / `high+deny[+reason]`（`dsh-experimental-auto-review/lib/index.js:23-30`，来自 `REVIEW_POLICY` 常量）：

```
Return exactly one JSON object and no other text. An allow object has exactly two members, risk and decision, and never has reason. The only valid shapes are:
{"risk":"low","decision":"allow"}
{"risk":"medium","decision":"allow"}
{"risk":"medium","decision":"deny"}
{"risk":"medium","decision":"deny","reason":"..."}
{"risk":"high","decision":"deny"}
{"risk":"high","decision":"deny","reason":"..."}
Never return low with deny, high with allow, or a reason with allow.
```

分级定义（`dsh-experimental-auto-review/lib/index.js:32-35`）：

```
- low: ordinary project-local reads and writes, analysis, formatting, linting, tests, builds, non-destructive Git operations, and exact cleanup of an object ... created in this same session. Low must be allowed without additional explicit authorization.
- medium: irreversible deletion of pre-existing objects or state, force push or history rewrite, production reads, writes or deployments, non-sensitive external writes or sends, and permission, security-control, privilege or system changes. Medium may be allowed only when a current human or direct-parent instruction explicitly authorizes the action, exact target and necessary scope, with no unresolved conflict.
- high: sensitive information exfiltration across a trust boundary, including sending credentials, secrets or private data to an external or untrusted destination, ... High must always be denied, even when a human or parent explicitly requests the exact action.
```

严格解析器（`dsh-experimental-auto-review/lib/index.js:353-375`）：

```js
function parseDecision(text) {
	const value = JSON.parse(text);
	...
	if (keys.length === 2 && decision === "allow" && (risk === "low" || risk === "medium")) return { risk, decision };
	if (keys.length === 2 && decision === "deny" && (risk === "medium" || risk === "high")) return { risk, decision };
	if (decision === "deny" && (risk === "medium" || risk === "high") && keys.length === 3 && Object.hasOwn(record, "reason") && typeof record["reason"] === "string") return { risk, decision, reason: record["reason"] };
	throw new Error("auto-review: reviewer output does not match the risk/decision protocol");
}
```

解析失败/流异常 → `failed(exec, error)`，即**以技术错误拒绝执行**（`dsh-experimental-auto-review/lib/index.js:377-397, 448-454`）：

```js
function failed(exec, error) {
	const message = error instanceof Error ? error.message : String(error);
	return { kind: "deny", reason: `Auto review of tool "${exec.name}" failed; its body was not executed: ${message}` };
}
```

**(c) 判定输入 / 记录位置**

五段输入的构造在 `snapshotAutoReview()`（`dsh-experimental-auto-review/lib/index.js:214-320`），渲染为（`:322-333`）：

```js
function reviewUserText(snapshot) {
	return [ "ENVIRONMENT", json({ cwd: snapshot.cwd }),
	         "PROJECT_INSTRUCTIONS", json(snapshot.projectInstructions),
	         "FILTERED_HISTORY", json(snapshot.history),
	         "PENDING_ACTION", json(snapshot.action) ].join("\n\n");
}
```

- `ENVIRONMENT` = 只有 `cwd`。
- `PROJECT_INSTRUCTIONS` = 来自 `source.kind === "agent-instructions"` 的用户消息（`:94-96, 257-265`）。
- `FILTERED_HISTORY` = 保留的表面历史，每条被赋予来源角色（`human-instruction` / `direct-parent-instruction` / `constraint` / `checkpoint` / `fact`，`:119-134`）；主 agent 的 `system/message`、assistant 文本与推理、tool result 都被排除（README `:60`）。
- `PENDING_ACTION` = `{mode, name, description, parameters, arguments}`（native：`:180-193`；PTC 内部：`:195-207`）。

**判定结果的记录位置**：
- **风险等级、审查提示词、推理、原始响应都不落盘**（`dsh-experimental-auto-review/README.md:101`）：

```
The raw optional reason is durable structured error detail for users, never main-model content. Risk, reviewer prompt, reasoning, and raw response are not persisted.
```

- 最终拒绝落成工具错误（`dsh-experimental-auto-review/lib/index.js:16-18, 418-428`）：

```js
const AUTO_REVIEW_DENIED_ERROR_NAME = "AutoReviewDeniedError";
const AUTO_REVIEW_DENIED_CODE = "AUTO_REVIEW_DENIED";
function denied(exec, reason) {
	return { kind: "deny", reason: `Auto review rejected tool "${exec.name}"; its body was not executed`,
	         info: { name: AUTO_REVIEW_DENIED_ERROR_NAME, code: AUTO_REVIEW_DENIED_CODE, ...reason === void 0 ? {} : { reason } } };
}
```

该 `info` 会经 `dsh-tools/lib/index.js:3242-3256` → `dsh-agent-loop/lib/index.js:697-702` 写入 `tool/result` 事件：

```js
	session.append("tool/result", { turn, step, message,
		...result.error?.info ? { error: result.error.info } : {},
		...result.meta !== void 0 ? { meta: result.meta } : {} }, ...);
```

→ 审计记录形如 `{"type":"tool/result", "data":{"error":{"name":"AutoReviewDeniedError","code":"AUTO_REVIEW_DENIED","reason":"..."}}}`。
- 走「上交人类」分支时，记录为标准的 `approval/asked` + `approval/decided`（理由带 `Auto review denied tool "<name>"[ : reason]`，`dsh-experimental-auto-review/lib/index.js:433-446`）：

```js
function askUser(exec, reason) {
	const denial = `Auto review denied tool "${exec.name}"`;
	return { kind: "ask",
		reason: reason === void 0 ? denial : `${denial}: ${reason}`,
		displayReason: reason === void 0 ? { en: "Auto review denied this call.", zh: "Auto review 拒绝了此调用。" }
		                              : { en: `Auto review denied this call: ${reason}`, zh: `Auto review 拒绝了此调用：${reason}` } };
}
```

**(d) 与 preset / sandbox / approval 的关系：叠加（AND），不是替代 approval。**

监听器只在「当前预设 = auto」时生效，并且 auto 只是**另一个预设**（`dsh-experimental-auto-review/lib/index.js:461-489`）：

```js
	ctx.effect(function* () {
		yield ctx.on("tools/pre-execute", async (exec, next) => {
			const agent = exec.agent;
			if (agent === void 0 || exec.parent === void 0 && exec.name === RUN_CODE_NAME) return next();
			if (permissionPresets.current(agent.session) !== AUTO_PRESET) return next();
			if (!accepting || lifecycle.signal.aborted) return { kind: "cancel" };
			...
			const review = await classifyRisk(ctx, agent, exec, AbortSignal.any([exec.signal, lifecycle.signal])).then(...);
			if (isAborted(lifecycle.signal)) return { kind: "cancel" };
			if (!review.ok) return failed(exec, review.error);
			const { decision } = review;
			if (decision.decision === "deny" && ctx.approval.overrideOf(agent.session) === "never") return denied(exec, decision.reason);
			const downstream = await next();
			if (isAborted(lifecycle.signal)) return { kind: "cancel" };
			if (decision.decision === "allow" || downstream.kind !== "allow") return downstream;
			return askUser(exec, decision.reason);
		}, { prepend: true });
		yield permissionPresets.registerAuto(() => { if (!accepting) throw new Error("auto-review: integration is closing"); });
		...
```

Auto 预设的固定组合是 **`sandbox: danger-full-access` + `approval: ask`**（`dsh-permission-presets/lib/index.js:51-61`）：

```js
const AUTO_PRESET = "auto";
const AUTO_PRESET_SPEC = { sandbox: "danger-full-access", approval: "ask" };
```

所以关系是：
- `permission/preset = auto` 决定「**是否有** LLM 审查这一步」（沙箱值走 danger-full-access，即审查通过就直接全权执行，不再有沙箱兜底）。
- `approval/policy`（会话覆盖）决定「审查拒绝后是**上交人类**还是**最终拒绝**」。
- 与 `sandbox/mode` 是**并列**的：auto 只是把沙箱设为 danger-full-access；它**不提供文件沙箱**（`dsh-experimental-auto-review/README.md:116`）：

```
- Auto provides no file sandbox. The outer `run_code` transport and direct Node effects inside a PTC program do not pass through inner-tool review.
```

- **`run_code` 外层传输被显式豁免**（`lib/index.js:464`：`exec.parent === void 0 && exec.name === RUN_CODE_NAME` 直接 `next()`）；PTC 内部调用**逐个**审查（`README.md:46`）。

### B6. 【关键】自动审批拒绝之后会发生什么

**分两种情况，由 `ctx.approval.overrideOf(agent.session)` 决定——注意它读的是「会话的显式覆盖」，不是配置默认值。**

`dsh-experimental-auto-review/lib/index.js:480-484`：

```js
				if (decision.decision === "deny" && ctx.approval.overrideOf(agent.session) === "never") return denied(exec, decision.reason);
				const downstream = await next();
				if (isAborted(lifecycle.signal)) return { kind: "cancel" };
				if (decision.decision === "allow" || downstream.kind !== "allow") return downstream;
				return askUser(exec, decision.reason);
```

| 会话 `approval/policy` 覆盖 | 审查结论 | 结果 |
|---|---|---|
| `never` | `deny` | **最终拒绝**（`denied()`，落 `AutoReviewDeniedError` / `AUTO_REVIEW_DENIED`），**不上交人类，不转入 approval 通道** |
| `ask` | `deny` | 先跑 `next()`（后续 pre-execute + guard）；若下游允许 → **转为 `{kind:"ask"}`，即上报人类审批**；若下游本身 deny/cancel → 以下游为准 |
| 任意 | `allow` | 直接放行（审查通过 = 立即全权执行，无人再确认） |
| 任意 | 审查自身失败/输出不合法 | `failed()` → 拒绝执行（**不会**上交人类） |

**要点：`high` 风险并不是「绝对不可越过」。** `REVIEW_POLICY` 在**提示词层面**要求 high 永远拒绝（`lib/index.js:35`），但**代码层面**只有在会话覆盖为 `never` 时才是最终拒绝；覆盖为 `ask` 时，high 的 deny 同样会被转成一次人类审批，人类可以 `allowed-once` 放行。**没有「自动审批不确定就上交」的独立路径**——「上交」只是 deny + `ask` 策略的默认结果。

**实证（真实审计日志！）**：`C:\Users\you\.dsh\sessions\--F-WorkSpace-AokoCSharpFramework--\session-a04a369f-b0a3-4b13-8f69-0d8dfa558c71\session.v4.jsonl.zstd`

```
{"type":"permission/preset","seq":0,...,"data":{"preset":"danger-full-access"}}
{"type":"approval/policy","seq":2,...,"data":{"policy":"never"}}
{"type":"permission/preset","seq":4,...,"data":{"preset":"auto"}}          ← 用户切到 Auto
{"type":"approval/policy","seq":5,...,"data":{"policy":"ask"}}            ← Auto 把审批策略设为 ask
{"type":"approval/asked","seq":79,...,"data":{"id":"91751b80-...","toolName":"write","callId":"call_00_zQdEjt3wMnirAG3YyjRy1223",
   "reason":"Auto review denied tool \"write\": This write persists the FTP credentials in plaintext inside a repo-local script (...)  ... "}}
{"type":"approval/decided","seq":80,...,"data":{"id":"91751b80-...","outcome":"allowed-once"}}   ← 人类覆盖了自动审查的拒绝
{"type":"permission/preset","seq":92,...,"data":{"preset":"danger-full-access"}}                 ← 用户切回 Full access
{"type":"approval/policy","seq":93,...,"data":{"policy":"never"}}
```

同一日志的统计：`tool/call` 569 次，`approval/asked` 仅 1 次，`approval/decided` 1 次。

**另有确切证据说明 `never` 下的最终拒绝形态**（`dsh-experimental-auto-review/README.md:101`）：

```
A final denial message is `Auto review rejected tool "<name>"; its body was not executed`. A reviewer failure message is `Auto review of tool "<name>" failed; its body was not executed: <error>`.
```

**子 Agent 的自动审查拒绝是最终的**（`dsh-experimental-auto-review/README.md:46`）：

```
A delegated in-process child pins the `never` policy, so its denials are final.
```

原因见 C9：子会话被 pin 了 `approval/policy: never`，因此 `overrideOf(child.session) === "never"`。

### B7. 自动审批能否被配置成「只在某个作用域内自动放行」

**不能。它没有任何配置项。**

- 模块导出与入口（`dsh-experimental-auto-review/lib/index.js:507-508`；`apply(ctx)` **不接收 config**，`:456`）：

```js
function apply(ctx) {
	const permissionPresets = ctx.permissionPresets;
	...
export { apply, inject, name };
```

- 包内不存在 `Config` / schema（`get_goal` 无关；`dsh-experimental-auto-review/lib/index.js` 全文无 `Config`、无 `z.`）；`package.json` 里也没有 `dsh.config`。
- 策略是**编译期常量** `REVIEW_POLICY`（`lib/index.js:20-41`），`name` 为 `"experimental-auto-review"`（`:43`），`inject` 为固定服务表（`:45-51`）。
- 官方限制（`dsh-experimental-auto-review/README.md:117`）：

```
- Model classification can be wrong. There are no deterministic tool exemptions, persistent grants, configurable policy, or retry layer.
```

唯一"作用域"是：
- **会话级**：预设 `current(session) === "auto"` 才生效（`lib/index.js:465`）。
- **工具级豁免（硬编码）**：native 调用与已启动的 PTC 内部调用审查；外层 `run_code` 及无 agent 的调用豁免（`lib/index.js:464`）。
- **子会话级**：in-process 子会话继承 `auto` 身份但 pin `never`（见 C9）。

### B8. 自动审批的审计记录

有，但只有两类落盘，且**不含风险等级/提示词/原始响应**：

1. **走人类审批的**：`approval/asked`（`reason` 内含 `Auto review denied tool "<name>": <reviewer reason>`）+ `approval/decided`。见 B6 实证。
2. **最终拒绝的**：`tool/result` 事件的 `data.error = {name:"AutoReviewDeniedError", code:"AUTO_REVIEW_DENIED", reason?: "<reviewer reason>"}`（`lib/index.js:418-428` → `dsh-tools/lib/index.js:3242-3256` → `dsh-agent-loop/lib/index.js:697-702`）。
3. **审查放行的**：**没有任何专门记录**——只留一条普通的 `tool/call` + `tool/result`，无法事后区分「审查放行」与「未审查」。
4. UI 侧：拒绝以普通工具卡片显示（`README.md:48`）：

```
A final denial uses the ordinary tool card. The collapsed row identifies Auto review; expanded output states that the body did not execute and displays the optional reason.
```

**没有任何「它批准/拒绝过什么」的专用审计视图或表。**

---

## C. 与远程 / 子 Agent 的关系

### C9. `dsh-subagent`：in-process 子 Agent 的审批默认处理

**实现证据**（`dsh-subagent/lib/index.js:535-541`）：

```js
function captureDelegatedPolicyOverrides(parent) {
	const preset = parent.ctx.get("permissionPresets")?.current(parent.session);
	return {
		permissionPreset: preset === "auto" || preset === "danger-full-access" ? preset : void 0,
		sandboxMode: parent.ctx.get("sandboxPolicy")?.overrideOf(parent.session),
		approvalPolicy: parent.ctx.get("approval") === void 0 ? void 0 : "never"
	};
}
```

注释明确（`dsh-subagent/lib/index.js:524-534`）：

```
* Capture the permission state to seed into one delegation. ... Auto and Full access identities are
* inherited only through the in-process DSH path ... Only the parent session's explicit sandbox override
* is captured — never deployment defaults or one-shot grants — and the approval
* policy is pinned to `'never'` regardless of the parent's own policy.
```

**写入子会话日志**（`dsh-subagent/lib/index.js:552-562`）：

```js
function appendDelegatedPolicyOverrides(childSession, overrides) {
	if (overrides.sandboxMode !== void 0) childSession.append("sandbox/mode", { mode: overrides.sandboxMode, source: "delegation" });
	if (overrides.approvalPolicy !== void 0) childSession.append("approval/policy", { policy: overrides.approvalPolicy, source: "delegation" });
	if (overrides.permissionPreset !== void 0) childSession.append("permission/preset", { preset: overrides.permissionPreset });
}
```

（同源副本：`dsh-subagent/lib/types/child-agent.js:185-212`。）

**结论**：
- 子 Agent 的 `permission/preset` 只在父为 `auto` 或 `danger-full-access` 时被显式继承（否则用基线的推断默认）。
- 子 Agent 的 `sandbox/mode` 只继承**父的显式覆盖**（部署默认不继承）。
- 子 Agent 的 `approval/policy` **无论父是什么，一律 pin 成 `never`** ⇒ 子 Agent 侧任何 approval 请求都会被**确定性拒绝**，**永远不会弹给人类**；auto-review 拒绝在子会话里也是最终的。
- 官方说明（`dsh-subagent` README 未直接给，但 auto-review README `:118` 与 `:46` 复述了同一事实）：

```
- In-process Auto children review their own calls. Out-of-process children retain their native permission systems after the parent delegation call is allowed.
```

```
A delegated in-process child pins the `never` policy, so its denials are final.
```

**对远程从机的意义**：in-process 子 Agent 是天然「无审批」的；但代价是**它没有任何可用的审批通道**——需要审批的操作会直接被拒（fail closed），而不是被上交。**出进程子 Agent（ACP）不受此 pin 影响**（见 C10/C11）。

### C10. `dsh-acp` 的 `session/request_permission`：带了什么字段

**DSH 实际发送的请求**（`dsh-acp/lib/index.js:1116-1139`）：

```js
	ctx.on("approval/request", (request, next) => {
		const record = ownedRecord(request.agent);
		if (record === void 0 || request.callId === void 0) return next();
		const callId = request.callId;
		return record.drainUpdates().then(() => {
			const params = {
				sessionId: record.agent.session.id,
				toolCall: { toolCallId: callId },
				options: [{
					optionId: "allow-once",
					name: "Allow once",
					kind: "allow_once"
				}, {
					optionId: "reject-once",
					name: "Reject",
					kind: "reject_once"
				}]
			};
			return conn.request(methods.client.session.requestPermission, params);
		}).then(({ outcome }) => {
			if (outcome.outcome === "cancelled") return "cancelled";
			return outcome.optionId === "allow-once" ? "allowed-once" : "rejected";
		});
	});
```

**ACP schema（完整结构）**（`@agentclientprotocol/sdk/schema/schema.json`，`$defs`）：

`RequestPermissionRequest`（`required: [sessionId, toolCall, options]`，`x-method: session/request_permission`）：

```json
{ "type":"object",
  "properties": {
    "sessionId": { "$ref": "#/$defs/SessionId" },
    "toolCall":  { "$ref": "#/$defs/ToolCallUpdate" },
    "options":   { "type":"array", "items": { "$ref": "#/$defs/PermissionOption" } },
    "_meta":     { "type":["object","null"], "additionalProperties": true }
  },
  "required": ["sessionId","toolCall","options"] }
```

`PermissionOption`（`required: [optionId, name, kind]`）：

```json
{ "optionId": { "$ref": "#/$defs/PermissionOptionId" },   // string
  "name":     { "type": "string" },
  "kind":     { "$ref": "#/$defs/PermissionOptionKind" },
  "_meta":    { ... } }
```

`PermissionOptionKind`（四值枚举，`oneOf` const）：

```json
[ {"const":"allow_once"}, {"const":"allow_always"}, {"const":"reject_once"}, {"const":"reject_always"} ]
```

`RequestPermissionResponse`（`required: [outcome]`）：

```json
{ "outcome": { "$ref": "#/$defs/RequestPermissionOutcome" }, "_meta": {...} }
```

`RequestPermissionOutcome`（discriminator `outcome`）：
- `{"outcome":"cancelled"}` — 文档明确：客户端收到 `session/cancel` 时 **MUST** 对所有 pending 的 `session/request_permission` 回这个 outcome。
- `{"outcome":"selected", "optionId":"<PermissionOptionId>"}`（`SelectedPermissionOutcome`，`required: [optionId]`）。

**DSH 实际填了哪些字段**：
- `sessionId` ✅
- `toolCall` = **只有** `{ toolCallId }`；**没有 `title`、没有 `rawInput`、没有 `content`、没有 `status`**。
- `options` = 两个固定选项，`kind` 只用 `allow_once` / `reject_once`（**不用** `allow_always` / `reject_always`）。
- **`reason` / `displayReason` / 工具名 / 参数 都不在审批请求里**（对比 `dsh-user-approval` 的 `ApprovalRequestEvent` 字段）。这是 README 承认的约束（`dsh-user-approval/README.md:156`）：`The request carries no tool arguments`。

**客户端（主机）能知道多少**：只能靠 `toolCallId` 去关联**之前的** `session/update` 通知。DSH 会为每次工具调用先推一条 generic tool_call（`dsh-acp/lib/index.js:592-601`）：

```js
function toolCallUpdate(event) {
	return {
		sessionUpdate: "tool_call",
		toolCallId: event.data.callId,
		title: event.data.name,          // ← 工具名在这里
		kind: "other",
		status: "in_progress",
		rawInput: parseToolArguments(event.data.arguments)   // ← 参数在这里
	};
}
```

发出时机（`dsh-acp/lib/index.js:893-900`，由 `tool/call` 会话事件驱动）：

```js
			} else if (event.type === "tool/call") {
				const previous = this.outputTail;
				this.outputTail = previous.then(() => this.notify({ sessionId: this.agent.session.id, update: toolCallUpdate(event) })).catch(...);
```

并且审批请求前会**先排空更新队列**（`record.drainUpdates()`，`dsh-acp/lib/index.js:1120`），保证主机在收到请求前已看到对应 tool_call。

→ 主机能做决策的信息 = `sessionId` + `toolCallId` + （自己缓存/关联的）`title`（工具名）+ `rawInput`（原始参数）。**拿不到 DSH 侧的原因文本**（例如 auto-review 的 reviewer reason、沙箱提权的 justification）——那些只在 DSH 端 `approval/asked` 里。

**无 callId 时**：`dsh-acp/lib/index.js:1118` `if (record === void 0 || request.callId === void 0) return next();` → 委派给后续 answerer（通常是 Remote/Web 通道或无人应答 → `unavailable`）。

**ACP 的 `Config` 不含任何权限项**（`dsh-acp/lib/index.js:1063-1067`）：

```js
const Config = Schema.object({
	provider: Schema.string(),
	model: Schema.string(),
	sessionListPageSize: Schema.natural().min(1).default(DEFAULT_SESSION_LIST_PAGE_SIZE)
});
```

`inject` 也只要 `agents/llm/sessionPersistence/sessions`（`dsh-acp/lib/index.js:1049-1054`）。**ACP 桥不写任何 approval/preset/sandbox 值**（对 `dsh-acp/lib/` 搜 `permission|approval|preset|sandbox` 只有两处：文档 `:1041` 与监听器 `:1116`）。

### C11. 【关键】主机不回答 `session/request_permission` 会怎样

**答案：DSH 侧既没有超时也不会自动拒绝，工具调用会一直挂起；只有三种情况能解除挂起。**

**① JSON-RPC 层没有超时。** `dsh-acp` 调用 `conn.request(methods.client.session.requestPermission, params)` **没有传 `options.cancellationSignal`，也没有 deadline**（`dsh-acp/lib/index.js:1134`）。SDK 的 `prepareRequest` 只登记 pending，无定时器（`@agentclientprotocol/sdk/dist/jsonrpc.js:544-581`）：

```js
    prepareRequest(method, params, mapResponse, options = {}) {
        const id = this.nextRequestId++;
        let cancel = () => { };
        const response = new Promise((resolve, reject) => {
            const pendingResponse = { resolve: ..., reject };
            cancel = () => { ...; pendingResponse.cleanup?.(); void this.sendCancelRequest(id).catch(() => { }); };
            options.cancellationSignal?.addEventListener("abort", cancel, { once: true });
            pendingResponse.cleanup = () => { options.cancellationSignal?.removeEventListener("abort", cancel); };
            this.pendingResponses.set(id, pendingResponse);
        });
```

只有连接关闭才会 reject（`@agentclientprotocol/sdk/dist/jsonrpc.js:585-601`）：

```js
    close(error) {
        ...
        for (const pendingResponse of this.pendingResponses.values()) { pendingResponse.cleanup?.(); pendingResponse.reject(closeError); }
        this.pendingResponses.clear();
        ...
```

**② DSH 侧也无超时，且审批等待不在任何工具超时之内。** 顺序证明：`tools/pre-execute`（含 approval）在 `prepareExecution` 内完成（`dsh-tools/lib/index.js:3225-3226`），而工具超时包装器 `dsh-tool-call-timeout-policy` 挂在 `tools/execute`（`dsh-tool-call-timeout-policy/lib/index.js:116`）：

```js
	ctx.on("tools/execute", async (exec, next) => {
		const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs;
		if (timeoutMs === void 0) return next();
		const d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT);
```

而 `tools/execute` 在 `dispatchScheduledExecution`（`dsh-tools/lib/index.js:3331`）里，**晚于** approval。管线不变式也确认（`dsh-tools/lib/invariant.js:76`）：`tools/execute must follow tools/pre-execute`。

因此工具自己的 `timeoutMs`（如 pwsh `300000`）**不会**解救挂起的审批等待。

**③ 三种解除路径**

| 触发 | 路径 | 结果 |
|---|---|---|
| 主机回答 `selected: allow-once` | `dsh-acp/lib/index.js:1137` | `allowed-once` → 放行 |
| 主机回答 `selected: reject-once` | 同上 | `rejected` → 拒绝（"the user rejected tool ..."） |
| 主机回答 `{"outcome":"cancelled"}`（协议要求 `session/cancel` 时必须回） | `dsh-acp/lib/index.js:1136` | `cancelled` → 拒绝（"approval for tool ... was cancelled"） |
| 连接关闭 / ACP 桥 dispose | `jsonrpc.js:591-593` reject → `dsh-user-approval/lib/index.js:176` 的 reject 分支 | `unavailable` → 拒绝（"no approval channel is available"） |
| **prompt 被取消**（`session/cancel` → `agent.cancel({kind:"user"})`） | `dsh-acp/lib/index.js:1313-1314, 868-871` → `dsh-agent-loop/lib/index.js:815-821` abort 阶段 signal → `exec.signal` 中止 → `dsh-user-approval/lib/index.js:174,178-188` | `cancelled` → 拒绝 |

`exec.signal` 就是该 step/turn 的 abort signal（`dsh-agent-loop/lib/index.js:506-518`）：

```js
async function executeToolCalls(ctx, turn, step, toolCalls, signal, acceptContext) {
	...
		exec: { callId: block.id, name: block.name, arguments: parseArguments(block.arguments), agent, signal }
```

而 `cancel()` 会 abort 当前 phase（`dsh-agent-loop/lib/index.js:815-821`）：

```js
	cancel(cause, options = {}) {
		if (!options.keepInbox) { this.inbox.clear(); if (this.phase.kind !== "idle") this.phase.wakeRequested = false; }
		if (this.phase.kind !== "idle") this.phase.abort.abort(cause);
	}
```

**实证（无超时）**：Aoko 会话中 `approval/asked`(1791423240408) → `approval/decided`(1791423523174)，相隔 **282.8 秒**；期间 DSH 没有触发任何超时或自动拒绝。

**④ 结论**
- 「不回答」= **挂起**（既不是超时也不是自动拒绝），直到 ACP 连接关闭、prompt 被取消，或有人回答。
- 挂起期间该工具调用阻塞其所在 step 的调度（`runGroup` 的 in-flight 集合），进而阻塞整个 prompt turn 的推进。
- 唯一会「自动变成拒绝」的场景是**连接断开**：此时 outcome 是 `unavailable`（不是 `rejected`），理由是 `no approval channel is available`。
- **给远程模型的直接建议**：从机侧必须有能力**避免**产生 approval 请求（C12），或在主机侧实现**必须回答**的契约（`session/cancel` 时按协议回 `cancelled`），否则一次网络抖动/客户端实现缺陷 = 该任务永久卡死。

**⑤ 附加风险：Web/Remote 通道在「无客户端连接」时不 fail closed，而是永久挂起。**
`dsh-api-remotes` 把 `approval/request` 注册为 **waterfall 转发事件**（`dsh-api-remotes/lib/index.js:17-25`）：

```js
const API_REMOTE_FORWARDED_EVENTS = [
	{ event: "agent-preset/selected", mode: "emit" },
	{ event: "approval/request", mode: "waterfall" },
	...
```

Host 侧监听器把请求推进队列（`dsh-api-remotes/lib/index.js:147-157`），Gateway 再分发（`dsh-api-gateway/lib/index.js:855-902`）：

```js
			this.pendingRemoteEvents.set(id, pending);
			for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
			if ([...signals].some((signal) => signal.aborted)) abort();
			else for (const client of this.remoteEventClients.values()) this.deliverRemoteEvent(pending, client);
```

**没有客户端时 `deliveries` 为空，没有任何分支去 `settleRemoteEvent(...{kind:"next"})`** → `dsh-api-remotes` 的 `forwardWaterfall`（`lib/index.js:214-232`）永不 settle → `ctx.approval.request()` 永不返回。
`hasLiveClient()` 存在（`dsh-api-gateway/lib/index.js:663-666`）但**只被 `dsh-cordis-host-runner` 的 inspect 查询使用**（`dsh-cordis-host-runner/lib/index.js:836`），审批路径不查它。
（同样地，`removeRemoteEventClient`（`:923-927`）在客户端中途断开时也不 settle 已投递的 pending 事件。）

### C12. 【关键】能否让从机在**不触发 `session/request_permission`** 的情况下完成一个任务

**可以，而且只有一条正路：让环境里根本不产生 `ask`/审批请求。**

先澄清一个致命误解：**`approval: never` 本身不是「自动放行」，而是「自动拒绝」**（`dsh-user-approval/lib/index.js:175`）：

```js
		if (this.effectivePolicy(session) === "never") return "rejected";
```

所以「免审批」= **不产生审批请求**，不是「有求必应」。DSH **全系统不存在任何 `allow-always` / 记忆规则 / 授权库**（`dsh-user-approval/README.md:155`）。

**免审批的充分条件**：`sandbox/mode = danger-full-access`。理由：
- bash/pwsh 与 fs 工具的提权申请只在「请求模式 ≠ 生效模式」时发生（`dsh-sandbox/lib/index.js:101`：`if (mode === effectiveMode) return effectiveMode;`）；`WIDER_MODES` 只有 `read-only→{workspace-write,danger-full-access}` 和 `workspace-write→{danger-full-access}`（`dsh-sandbox/lib/index.js:30-33`），**`danger-full-access` 之上没有更宽档**，因此不可能产生提权审批。
- 沙箱为 danger-full-access 时文件操作不再被拒，模型也就没有理由带 `sandbox_permissions` 重试。
- 除 auto-review 外，shipped 组合中**没有任何插件会返回 `{kind:"ask"}`**（全量 grep `kind: "ask"` 仅命中 auto-review，见 A3）。

**实证**：`C:\Users\you\.dsh\sessions\--F-WorkSpace-dsh-plugin-remote-use--\session-03d7fd49-…\session.v4.jsonl.zstd`：342 行事件、**63 次 `tool/call`、0 次 `approval/asked`**，头三个事实为 `permission/preset=danger-full-access` / `sandbox/mode=danger-full-access` / `approval/policy=never`。

**配置入口清单（全部已验证）**

| 层级 | 入口 | 文件:行 | 说明 |
|---|---|---|---|
| 环变量 | `DSH_PERMISSION_MODE` | `dsh-base/cordis.patch.yml:232`、`:248` | 同时决定沙箱默认与 approval 默认 |
| 进程默认 | `sandbox-policy.mode` 行 | `dsh-base/cordis.patch.yml:229-233` | `mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'` |
| 进程默认 | `approval.policy` 行 | `dsh-base/cordis.patch.yml:245-248` | `policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"` |
| 进程默认 | `permission.presets` / `defaultPreset` | `dsh-base/cordis.patch.yml:250-262`；本机 `C:\Users\you\.dsh\profiles\desktop\cordis.patch.yml:12-25` | 预设表 + 新会话默认 |
| Settings（未来会话） | `permission.defaultPreset` | `C:\Users\you\.dsh\settings.yaml.imported:12-13` | `permission: { defaultPreset: danger-full-access }`，只影响**新建**会话 |
| 会话级（命令） | `/permission <preset>` | `dsh-permission-presets/lib/index.js:206-231` | 写 `permission/preset` + 两个 knob 事件 |
| 会话级（UI） | composer / `/permission` 选择器 | `dsh-client-ui-permission-presets/README.md:32` | Web 侧；`auto` 另需实验性风险确认 |
| 会话级（编程） | `permissionPresets.set(session, name)` | `dsh-permission-presets/lib/index.js:344-348`；调用样例 `dsh-webhook/lib/index.js:156,182` | webhook 创建的会话即用此路径显式设定 preset |
| 会话级（原始写） | `setApprovalPolicy(session,'never')` / `setSandboxMode(session,mode)` | `dsh-user-approval/lib/index.js:63-66`；`dsh-sandbox-policy/lib/index.js:40-42` | 直接 append `approval/policy` / `sandbox/mode` |
| 子 Agent | 自动 pin | `dsh-subagent/lib/index.js:535-541, 552-562` | 子会话 `approval/policy = never`、沙箱继承父的显式覆盖 |

**推荐的从机免审批配置（按优先级）**
1. 启动环境变量：`DSH_PERMISSION_MODE=danger-full-access`（对任意 profile 生效，包括 `acp`，因为它 layer 在 `dsh-base` 之上：`dsh-acp-app/cordis.patch.yml` 未覆盖 `sandbox-policy`/`approval`/`permission` 三行）。
2. 或在从机 profile 的 `cordis.patch.yml` 里把 `permission` 行的 `defaultPreset` 写成 `danger-full-access`（本机 desktop profile 就是这么做的）。
3. **不要**启用 `@deepseek-ai/dsh-experimental-auto-review`（否则会重新引入 `ask`）。
4. 若必须保留沙箱限制（workspace-write），则**必然存在**提权审批的可能：此时应在主机侧实现「自动回答策略」而不是「不回答」。

**两个反例（不构成免审批）**
- 只把 `approval` 设成 `never` 而沙箱仍是 `workspace-write`：越权操作会**直接失败**，且模型看到的是误导性文案 `the user rejected escalating this command to "..."`（`dsh-sandbox/lib/index.js:118`），实际没有人被问过。
- 只把沙箱设成 `danger-full-access` 但 auto-review 在跑：`auto-review` 会把预设改成 `auto`（= danger-full-access + `ask`），审查拒绝时**会再次产生 `ask`**（B6 实证）。

### C13. 【关键】能否把审批请求转发到自定义地方（不是 ACP client）

**能。有三条现成通道，都是 waterfall `approval/request` 监听器。**

**① Host 侧 Cordis 插件直接订阅（最直接）**
事件协议（`dsh-tool-cordis/lib/types/api-catalog.js:3851-3858`）：

```js
    {
        name: 'approval/request',
        mode: 'waterfall',
        signature: '\'approval/request\'( this: Scoped<Agent>, req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>, ): Promise<ApprovalOutcome>',
        summary: 'Ask composed answerers for one decision.',
        description: '... Return an outcome to claim the request or call `next()` to delegate. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.',
        parameters: [{ name: 'req', description: 'pending approval request.' }],
    },
```

现成范例即 `dsh-acp` 自己的实现（`dsh-acp/lib/index.js:1116-1139`），返回一个 `ApprovalOutcome` 字符串即可认领该请求。
**注意约束**：这是**同步/进程内** waterfall，是「waterfall 而不是策略优先级机制」——只要某个 listener 返回非 `next()` 的合法 outcome，请求就被它认领；返回非法值会被归一化成 `unavailable`（`dsh-user-approval/lib/index.js:176`）。

**② Remote Event 通道（把审批转发到任意远程前端）**
`approval/request` 已被加入 Host→Client 转发白名单（`dsh-api-remotes/lib/index.js:17-25`，`mode: "waterfall"`），客户端侧以 `ctx.remote.$on("approval/request", handler)` 参与（`dsh-client-ui-approval/lib/client.js:355-357` 是官方参考实现）。
**这是「让局域网远程从机的审批到某个自定义前端」最正规的入口**——不需要是 ACP client，只要是能连上 Gateway 的 Remote 客户端即可。
但请务必注意 C11⑤ 的缺口：**无客户端连接时不会 fail closed，而是永久挂起**；自定义前端必须保证「有连接必应答」，并处理 `{type:"cancel", eventId}` 帧（`dsh-api-gateway/lib/index.js:943-947`）。

**③ ACP 通道**（`session/request_permission`），即 C10。

**没有的**：没有任何配置级 / HTTP webhook 级的审批转发入口（`dsh-webhook` 只把外部事件转成**入站**会话，见 `dsh-webhook/lib/index.js:148-198`）。搜过的关键词：`approval` × `webhook|hook|http|forward`，以及 `dsh-webhook/lib/**`。相关的 `dsh-hook-protocol` / `dsh-hooks-claude-code` / `dsh-hooks-codex` 未在本次范围内发现 approval 相关钩子（未解包深入，标为"未确认"）。

---

## D. 审计面

### D14. 「谁批准了什么」的现成审计面

**① 会话日志事件（权威、持久、逐条）**
- `approval/asked`：`{id, toolName, callId?, reason?}`
- `approval/decided`：`{id, outcome}`
- `approval/policy`：`{policy, source?}`（`source:'delegation'` 表示子 Agent pin）
- `permission/preset`：`{preset}`
- `sandbox/mode`：`{mode, source?}`

写路径：`dsh-user-approval/lib/index.js:132-142`；`dsh-user-approval/lib/index.js:63-66`；`dsh-permission-presets/lib/index.js:359`；`dsh-sandbox-policy/lib/index.js:40-42`。
事件类型声明（`SessionEventMap`，`dsh-permission-presets/lib/typert.host.js:483` 的字符串化声明）包含：

```
    'sandbox/mode': { mode: SandboxMode; source?: 'delegation'; };
    'approval/asked': { id: ApprovalRequestId; toolName: string; callId?: ToolCallId; reason?: string; };
    'approval/decided': { id: ApprovalRequestId; outcome: ApprovalOutcome; };
    'approval/policy': { policy: ApprovalPolicy; source?: 'delegation'; };
```

不变式会在回放时校验配对与词表（`dsh-user-approval/lib/invariant.js:202-214`）：evidence `approval/asked appended outside any open turn` / `approval/decided has no matching approval/asked for id ...` / `carries unknown outcome ...`。

**② 落盘位置（真实文件）**
`dsh-base/cordis.patch.yml:130-133`：

```yaml
    - id: session-persistence-jsonl
      name: '@deepseek-ai/dsh-session-persistence-jsonl'
      config:
        root: !!js dshHomePath('sessions')
```

目录布局（`dsh-session-persistence-jsonl/lib/index.js:902-916`）：`<root>/<projectKey>/<encoded sessionId>/<generation 文件名>`，本机实际为
`C:\Users\you\.dsh\sessions\--F-WorkSpace-dsh-plugin-remote-use--\<sessionId>\session.v4.jsonl.zstd`。
默认 `compression` 未在 base 中设置（`Config` 见 `dsh-session-persistence-jsonl/lib/index.js:2374-2376`），本机产物是 `.jsonl.zstd`；`sdk-minimal` 显式用 `compression: none`（`dsh-sdk-minimal/cordis.patch.yml:154-158`）。
**读取注意（实操坑）**：文件是**多 zstd frame 拼接**，Node 的 `zstdDecompressSync` / `createZstdDecompress` **只解第一帧**（本机上单个文件 209 帧、`decompressSync` 只返回 216 字节）；必须逐帧解（见 `.research\read-session-log.mjs`）。

**③ 导出给人类**
`dsh-session-log-export`：Session Header 的 `Download session log` 与 `/export` 斜杠命令产出 `dsh-session-<id>.zip`（含子会话与附件）——`dsh-session-log-export/README.md:11`。
**没有专门的「审批审计页面/表格」。** `dsh-client-ui-approval` 只做即时决策，`dsh-client-ui-settings-session-log` 只是上传开关。

**④ 上传到官方 DeepSeek API（重要安全事实）**
`dsh-session-log-deepseek` 会把**规范会话日志**（即包含上述全部 approval 事件）作为请求字段 `dsh_session_log` 随模型请求上送（`dsh-session-log-deepseek/README.md:11, 34-40`）：

```
Incremental canonical session-log upload for official DeepSeek LLM API requests. This function plugin ... owns the `dsh_session_log` request field ...
| `enabled` | `true` | Send the `dsh_session_log` contribution. ... |
```
`dsh-base/cordis.patch.yml:43-44` 默认挂载该行（未 disabled），Web 开关名为 “Upload Session Log when using the official model API”。
→ **对「从机被远程指挥」的合规影响：审批审计（含 toolName、callId、reason）默认会随模型请求出网。**

**⑤ OTel：默认不含审批事件**
`dsh-base/cordis.patch.yml:191-218`：

```yaml
    # OTel releases a Session-log prefix only after explicit user feedback, ...
    - id: session-telemetry-otel
      name: '@deepseek-ai/dsh-session-telemetry-otel'
      config:
        mode: !!js process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'
```

`dsh-session-telemetry-otel` 只对 feedback 事件做捕获（`dsh-session-telemetry-otel/lib/index.js:29-34, 164-166`，`isFeedback()` 白名单只有 `feedback/*` 类型）。`dsh-host-product-telemetry-otel` 只发显式提交的产品事件（`dsh-host-product-telemetry-otel/README.md:11`：`Mounting the plugin collects nothing automatically`）。
→ **DSH 没有为 approval 事件提供 OTel 导出**（除非改 `DSH_TELEMETRY_MODE`，而该模式仍是 feedback 白名单语义）。搜过的关键词：`approval` × `dsh-session-telemetry-otel`、`dsh-otel`、`dsh-host-product-telemetry-otel` → 0 命中。

**⑥ 工具结果里的拒绝详情**
最终拒绝（auto-review / 沙箱提权失败 / guard）会落 `tool/result.data.error = {name, code, reason?}`（`dsh-agent-loop/lib/index.js:697-702`）。auto-review 的 code 是 `AUTO_REVIEW_DENIED`（`dsh-experimental-auto-review/lib/index.js:16-18`）。**只有拒绝有留痕，放行没有。**

### 未找到 / 已搜索未命中的清单

| 项 | 搜寻范围 | 结论 |
|---|---|---|
| `allow-always` / 记住决定 / 会话级放行 / 授权库 | `dsh-user-approval/**`、`dsh-client-ui-approval/**`、ACP `PermissionOptionKind` | **未找到**（README 明确排除） |
| 审批超时 | `timeout|setTimeout|deadline|AbortSignal` in `dsh-user-approval/lib/`、`dsh-acp/lib/`、`@agentclientprotocol/sdk/dist/` | **未找到**（只有 signal 竞速） |
| auto-review 的 Config schema | `dsh-experimental-auto-review/**` 全文件搜 `Config`、`z.` | **未找到**（`apply(ctx)` 无 config 参数） |
| `DSH_PERMISSION_MODE` 在 JS 中的定义 | 全量 `@deepseek-ai/**/*.js` 搜 `process\.env\.DSH_` | **未找到**；它只存在于 YAML 配置表达式（`dsh-base/cordis.patch.yml:232,248`） |
| approval 事件的 OTel 导出 | `dsh-session-telemetry-otel`、`dsh-otel`、`dsh-host-product-telemetry-otel` | **未找到**（`FEEDBACK_ONLY`） |
| 审批专用审计 UI / 历史列表 | `dsh-client-ui-approval`、`dsh-client-ui-settings-session-log`、`dsh-client-ui-settings-*` | **未找到** |
| 配置级 / HTTP 审批转发 hook | `dsh-webhook/**`、`dsh-hook-protocol`、`dsh-hooks-*` | **未找到**（webhook 只有入站） |
| 「自动审批不确定 → 上交」独立路径 | `dsh-experimental-auto-review/lib/index.js` 全读 | **不存在**；「上交」= deny + `ask` 覆盖 |

---

## 直接回答四个关键问题（摘要）

### 1. 自动审批的分级与拒绝后行为
- 分级只有 `low` / `medium` / `high`，合法组合 6 种：`low+allow`、`medium+allow`、`medium+deny[+reason]`、`high+deny[+reason]`；`low+deny`、`high+allow`、`allow` 带 reason 都是**非法输出 → 该次调用直接失败且不执行**。
- 审查者 = **当前会话请求头里的同一个 provider/model**，`temperature: 0`，每个受支持调用**多一次模型请求**（无缓存、无重试、无独立输出预算）。`run_code` 外层豁免，PTC 内部调用逐个审查。
- **拒绝后行为取决于会话的 `approval/policy` 显式覆盖**（`ctx.approval.overrideOf`，不是配置默认值）：
  - `never` → **最终拒绝**，落 `tool/result.error = {name:"AutoReviewDeniedError", code:"AUTO_REVIEW_DENIED", reason?}`，不上交人类。
  - `ask` → 先跑后续 pre-execute 与 guard；若下游允许，**转成一次人类审批**（`approval/asked` + `approval/decided`），人类可以 `allowed-once` **覆盖**掉自动审查的拒绝（已在本机日志中实证，human 放行了一次被 auto-review 以「明文凭据外泄」为由拒绝的 write）。
  - 审查技术上失败（流错误/JSON 不合法）→ 直接拒绝执行，**不会**上交人类。
- **`high` 并非绝对不可越过**：提示词要求永远拒绝，但代码只在会话覆盖为 `never` 时才最终拒绝。
- **没有「不确定就上交」的独立路径**；上交只是 deny 在 `ask` 策略下的默认结果。子 Agent 场景被 pin `never`，所以子 Agent 的自动审查拒绝是最终的。

### 2. ACP 审批请求的字段与不回答的后果
- 实际发送：`{ sessionId, toolCall: { toolCallId }, options: [{optionId:"allow-once",name:"Allow once",kind:"allow_once"},{optionId:"reject-once",name:"Reject",kind:"reject_once"}] }`。
- **不带工具名、不带参数、不带 reason/displayReason**；schema 允许 `title`/`rawInput`/`content`，但 DSH 只填 `toolCallId`（`dsh-acp/lib/index.js:1123`）。工具名与参数只能靠此前 `session/update` 的 `tool_call` 通知（`title` + `rawInput`）关联。
- 响应：`{outcome:{outcome:"cancelled"}}` 或 `{outcome:{outcome:"selected", optionId:"..."}}`；`optionId` 非 `allow-once` 一律映射为 `rejected`（包括未知 optionId）。
- schema 里存在 `allow_always`/`reject_always`，**DSH 从不使用**（即 ACP 通道也没有「总是允许」）。
- **不回答 = 挂起**：JSON-RPC 与 DSH 两侧都没有审批超时，工具自身的 `timeoutMs` 也不覆盖审批阶段（审批在 `tools/pre-execute`，超时在之后的 `tools/execute`）。已实测一次审批等待 282 秒且无超时。解除挂起只有：主机回答 / 连接关闭（→ `unavailable`，拒绝）/ prompt 被取消（→ `cancelled`，拒绝）。
- **额外风险**：Web/Remote 转发通道在「没有任何客户端连接」时**不会 fail closed**，请求永久挂起（`dsh-api-gateway/lib/index.js:898` 没有 zero-client 兜底，`hasLiveClient()` 不被审批路径使用）。

### 3. 从机能否预配置为免审批
- **能，但语义是「不产生审批请求」，不是「自动放行」。** DSH 全系统没有 `allow-always`/记忆授权/授权库；`approval: never` 的含义是**自动拒绝**。
- 充分条件：**`sandbox/mode = danger-full-access`**（越权阶梯之上没有更宽档 → 不可能产生提权审批；文件沙箱不再拒绝 → 模型没有理由带 `sandbox_permissions` 重试）。除 auto-review 外，shipped 组合无任何产生 `{kind:"ask"}` 的插件。
- 配置入口：`DSH_PERMISSION_MODE=danger-full-access`（`dsh-base/cordis.patch.yml:232,248`，同时决定沙箱与审批默认，对 `acp` profile 同样有效）> profile `cordis.patch.yml` 的 `permission.defaultPreset` / `sandbox-policy.mode` / `approval.policy` 行 > `settings.yaml: permission.defaultPreset`（仅影响未来会话）> 会话级 `/permission <preset>`、Web 选择器、`permissionPresets.set(session,name)`、`setApprovalPolicy(session,'never')`。子 Agent 自动获得 `approval/policy = never`。
- 不要启用 `dsh-experimental-auto-review`，否则审查拒绝会重新产生 `ask`。
- 若必须保留 `workspace-write` 沙箱，则提权审批**不可避免**，此时应在主机侧实现「自动应答」而不是「沉默」。

### 4. 审计面在哪
- **权威审计 = 会话日志事件**：`approval/asked` `{id,toolName,callId?,reason?}`、`approval/decided` `{id,outcome}`、`approval/policy`、`permission/preset`、`sandbox/mode`；另有拒绝详情在 `tool/result.data.error`。
- **落盘**：`$DSH_HOME/sessions/<projectKey>/<sessionId>/session.v<N>.jsonl[.zstd]`（本机 `C:\Users\you\.dsh\sessions\...`；多 zstd frame 拼接，标准 zstd 库只解一帧）。
- **导出**：`/export` 或 Session Header → Download session log（ZIP，含子会话）。
- **出网风险**：`dsh-session-log-deepseek` 默认把包含这些事件的完整会话日志作为 `dsh_session_log` 随官方模型请求上送（Web 设置项可关）。
- **OTel 默认不含审批事件**（`FEEDBACK_ONLY`）。
- **没有专用审计 UI/报表**；auto-review 的风险等级、审查提示词、推理与原始响应**不落盘**，放行行为也无留痕。

---

## 附：本报告可复现的关键命令

```powershell
# 批量解包（只读 asar）
node F:\WorkSpace\dsh-plugin-remote-use\.research\extract-many.mjs `
  F:\WorkSpace\dsh-plugin-remote-use\.research\asar `
  "node_modules/@deepseek-ai/[^/]+/(lib|dist)/.*\.js$"

# 逐 zstd frame 读取会话日志并汇总事件类型 / 打印匹配事件
node F:\WorkSpace\dsh-plugin-remote-use\.research\read-session-log.mjs `
  "C:\Users\you\.dsh\sessions\--F-WorkSpace-AokoCSharpFramework--\session-a04a369f-b0a3-4b13-8f69-0d8dfa558c71\session.v4.jsonl.zstd" `
  "approval/asked,approval/decided,approval/policy,permission/preset,sandbox/mode" raw

# 全量扫描所有会话日志中的审批事件
node F:\WorkSpace\dsh-plugin-remote-use\.research\scan-approvals.mjs "approval/asked"
```

扫描结果（`C:\Users\you\.dsh\sessions` 下全部 **427** 个 `.jsonl` / `.jsonl.zstd` 文件）：
真正的 `approval/asked` 事件只出现在 **2 个会话**里，均已在 B6 / C11 引用
（另有 1 个会话命中字符串，但那是本会话自己的工具输出里包含 `approval/asked` 字样，不是事件——即本次调研会话）。
这本身就是「本机 profile 的 `danger-full-access` + `never` 默认确实让审批请求近乎消失」的旁证。
