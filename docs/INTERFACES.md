# 实现接口契约（v1）

> 本文是并行实现的**唯一接口约定**。各模块的测试与实现必须严格按此签名，不得自行改动。
> 设计依据：[DESIGN.md](DESIGN.md)。协议细节见 DESIGN §13。
> 用法说明见仓库根目录的 [README.md](../README.md)；踩坑与教训见 [PITFALLS.md](PITFALLS.md)。

---

## 目录与职责

```
packages/dsh-plugin-remote-use/
├── package.json                     # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml                 # 插件行注册
├── lib/
│   ├── index.js                     # Host 插件入口：装配全部模块（Lead 负责）
│   ├── core/
│   │   ├── review-engine.js         # 【A】审批决策（纯函数，无 I/O）
│   │   ├── task-memory.js           # 【A】任务内审批记忆（纯，无 I/O）
│   │   └── toolcall-cache.js        # 【A】toolCallId → {toolName, rawInput} 缓存
│   ├── bridge/
│   │   └── acp-bridge.js            # 【B】ACP over WS 客户端（I/O）
│   ├── provider/
│   │   └── remote-provider.js       # 【Lead】SubagentProvider 实现
│   └── tools/
│       └── remote-tools.js          # 【Lead】remote_agents / remote_interrupt / remote_selfcheck
└── test/
    ├── review-engine.test.js        # 【A】
    ├── task-memory.test.js          # 【A】
    ├── toolcall-cache.test.js       # 【A】
    └── acp-bridge.test.js           # 【B】
```

**写入范围严格互斥**：A 只写 `core/**` 与 `test/{review-engine,task-memory,toolcall-cache}.test.js`；B 只写 `bridge/**` 与 `test/acp-bridge.test.js`；Lead 写其余。

---

## 常量（共享，所有模块从此处语义取值）

```js
// 沙箱档位，从窄到宽
export const TIER = /** @type {const} */ (['read-only', 'workspace-write', 'danger-full-access'])
// 审批应答的 optionId（ACP 是硬编码的两个值，DESIGN §2.3）
export const OPTION = { ALLOW_ONCE: 'allow-once', REJECT_ONCE: 'reject-once' }
```

---

## 【A】`core/review-engine.js` —— 审批决策

**这是实测发现的安全缺口（DESIGN §10.0.1）的落点。** 审批请求只带 `toolCallId`，主机必须自己从缓存里取回 `rawInput` 才能判断，尤其是 `sandbox_permissions` 档位。

```js
/**
 * @typedef {object} ApprovalRequest
 * @property {string} toolCallId
 * @property {string} toolName              // 来自 tool_call 缓存的 title
 * @property {unknown} rawInput             // 来自 tool_call 缓存的完整参数；undefined = 缓存缺失
 * @property {string} taskId
 */

/**
 * @typedef {object} Decision
 * @property {'allow-once'|'reject-once'} optionId
 * @property {'memory'|'policy'|'human'|'cache-miss'|'tier-check'} source
 * @property {string} reason                // 人类可读，进审计；被拒时会作为 diagnostic 反馈
 * @property {boolean} needsHuman           // true 表示规则引擎无法决定，需要上报
 */

/**
 * 决策。**必须满足以下顺序与规则**（顺序本身是被测契约）：
 *
 *  1. rawInput === undefined（缓存缺失） → 直接 reject-once，source='cache-miss'。
 *     绝不可默认放行（DESIGN §5.2 / §8.3）。
 *
 *  2. 档位检查（DESIGN §8.3）：
 *     从 rawInput.sandbox_permissions 取出申请档位（可能不存在 = 不申请提权）。
 *     - 不存在            → 与档位检查无关，继续后续规则。
 *     - 申请档位 === 'danger-full-access' → needsHuman=true（**必须人工确认**，规则不得自动放行）。
 *     - 申请档位 宽于 requiredTier → reject-once, source='tier-check'，
 *       reason 必须包含 "narrow" 与所需档位名，便于模型改用窄档重试。
 *     - 申请档位 窄于或等于 requiredTier → 继续后续规则。
 *
 *  3. 任务内拒绝记忆命中 → reject-once, source='memory'（同类不再问）。
 *
 *  4. 任务内批准记忆命中 → allow-once, source='memory'。
 *
 *  5. 任务级授权范围命中（taskAuth.allowedPaths / allowedTools） → allow-once, source='policy'。
 *
 *  6. 其余 → needsHuman=true, source='human'（缺省 optionId 为 reject-once，
 *     调用方在人工批准后覆盖）。
 *
 * @param {ApprovalRequest} req
 * @param {object} ctx
 * @param {TaskMemory} ctx.memory
 * @param {{ requiredTier: string, allowedTools?: string[], allowedPaths?: string[] }} ctx.policy
 * @returns {Decision}
 */
export function decideApproval(req, ctx) { /* ... */ }

/**
 * 从 rawInput 推断「本次操作实际需要的最小档位」。
 * 规则（保守，宁可判宽）：
 *   - rawInput 为空对象/无路径信息   → policy.requiredTier（交给调用方给的默认）
 *   - 涉及文件路径且路径在 workspaceRoot 之外 → 'workspace-write'
 *   - 涉及文件路径且路径在 workspaceRoot 之内 → 'read-only'（写操作仍需 workspace-write，
 *     因此以 operation 是否为写类决定：由 toolName ∈ WRITE_TOOLS 判定）
 *   - 命令类工具（pwsh/bash）        → 'workspace-write'
 * @param {unknown} rawInput
 * @param {{ workspaceRoot?: string, writeTools?: string[], defaultTier: string }} opts
 * @returns {string} 档位名
 */
export function inferRequiredTier(rawInput, opts) { /* ... */ }
```

**`WRITE_TOOLS`** 至少含：`write`、`edit`、`str_replace_editor`、`fs_write`。

**记忆键（`memoryKey(req)`，导出以便测试与审计）**：
- 写类工具 → `write:<目录前缀>`（取 `rawInput.file_path` / `path` 的父目录）
- 命令类工具 → `exec:<命令首词>`（`rawInput.command` 的第一个 token）
- 其余 → `tool:<toolName>`

---

## 【A】`core/task-memory.js` —— 任务内审批记忆

**范围严格限定在单任务内**（DESIGN §8.3）。任务结束必须 `dispose()`。

```js
export class TaskMemory {
  constructor(taskId) {}

  /** 记下本次批准（单次，用完即弃不适用——见 noteApprove 的语义） */
  noteApprove(key, { scope = 'task' } = {}) {}   // scope: 'task' | 'once'
  noteReject(key) {}

  /** 查询：'allowed' | 'rejected' | 'unknown' */
  lookup(key) {}

  /** 消耗一次 'once' 批准；返回 true 表示这次放行已用掉 */
  consumeOnce(key) {}

  snapshot() {}   // { taskId, approvals: string[], rejections: string[], once: string[] }
  dispose() {}    // 清空并标记失效；之后 lookup 恒 'unknown'
}
```

---

## 【A】`core/toolcall-cache.js` —— `toolCallId` 缓存

**这是档位检查的唯一数据来源**（DESIGN §10.0.1）。有容量上限并把淘汰记为可观测事实。

```js
export class ToolCallCache {
  /** @param {{ maxEntries?: number }} [opts] 默认 512 */
  constructor(opts) {}

  /** 从 ACP 的 tool_call 通知记录。title 即工具名。 */
  note(toolCallId, { title, rawInput, status }) {}

  /** 从 tool_call_update 更新 status/patch（不覆盖 title/rawInput，除非显式给出）。 */
  update(toolCallId, { status, title, rawInput }) {}

  /** @returns {{ toolName: string, rawInput: unknown, status: string } | undefined} */
  get(toolCallId) {}

  /** 缓存未命中计数（用于审计告警：命中率低意味着审批无法判断） */
  get misses() {}
  get size() {}
  clear() {}
}
```

---

## 【B】`bridge/acp-bridge.js` —— ACP over WebSocket 客户端

依赖 `@agentclientprotocol/sdk` + `ws`。**不得引入其他依赖。**

```js
export class AcpBridge {
  /**
   * @param {object} opts
   * @param {string} opts.url                  // ws://host:port
   * @param {string} [opts.token]              // Bearer
   * @param {number} [opts.approvalTimeoutMs]  // 默认 90_000（DESIGN §8.4）
   * @param {(evt: UpdateEvent) => void} [opts.onUpdate]        // 构造级默认
   * @param {(req: ApprovalAsk) => Promise<'allow-once'|'reject-once'>} [opts.onApproval]  // 构造级默认
   *        **必须有超时兜底**：bridge 自身在 approvalTimeoutMs 后强制回 reject-once，
   *        不依赖调用方守约（DESIGN §8.4：无现成超时机制）。
   *        两者都未提供时必须 fail closed（回 reject-once），绝不默认放行。
   */
  constructor(opts) {}

  /** 建立连接 + initialize。@returns {Promise<{agentInfo:object, capabilities:object}>} */
  async connect() {}

  /**
   * 新建 session 并发送 prompt，**阻塞到 turn 结束**。
   *
   * ⚠️ 回调按「每次调用」解析（见下方契约修正说明）：
   *    onUpdate  = 入参.onUpdate  ?? 构造级 onUpdate
   *    onApproval = 入参.onApproval ?? 构造级 onApproval
   * 每条 bridge 是长连接、可服务多个任务，所以归属必须落在**当前任务**上；
   * 任务结束后必须清掉已解析的回调，防止串台。
   *
   * @param {{ cwd: string, prompt: string,
   *           onUpdate?: (evt: UpdateEvent) => void,
   *           onApproval?: (req: ApprovalAsk) => Promise<'allow-once'|'reject-once'> }} req
   * @returns {Promise<TaskResult>}
   */
  async startTask(req) {}

  /** 上层取消：对当前 session 发 session/cancel（不等待 quiescence）。 */
  async cancel() {}

  /** 关闭 WS 与所有 session。幂等。 */
  async dispose() {}
}
```

```js
/** @typedef {object} UpdateEvent
 *  @property {'message'|'thought'|'tool_call'|'tool_call_update'|'usage'|'config'|'other'} kind
 *  @property {string} [text]          // message/thought
 *  @property {{toolCallId:string, toolName:string, rawInput:unknown, status:string}} [tool]
 *  @property {{used:number,size:number}} [usage]
 */

/** @typedef {object} ApprovalAsk
 *  @property {string} toolCallId
 *  @property {string|undefined} toolName    // 从 ToolCallCache 取；undefined = 未命中
 *  @property {unknown} rawInput             // 同上
 */

/** @typedef {object} TaskResult
 *  @property {'completed'|'error'|'aborted'|'refusal'|'max-tokens'} stopReason
 *  @property {string} output                // 从 agent_message_chunk 累积（result 无 output 字段）
 *  @property {string} [diagnostic]          // JSON-RPC error 的 message
 *  @property {Array<{toolCallId,toolName,status}>} toolCalls
 *  @property {{used:number,size:number}|undefined} usage
 */
```

### B 必须实现的三个硬行为

1. **停止原因映射**（DESIGN §13.5）：prompt 的 JSON-RPC **reject** → `error`（diagnostic 取其 message）；`cancelled` → `aborted`；`refusal` → `refusal`；`max_tokens` → `max-tokens`；否则 `completed`。**不要只看 stopReason**（`blocked`/`error` 都被 DSH 映射成 `end_turn`）。
   - ⚠️ **例外（集成后发现）**：若本 turn 收到过本地 `cancel()`，则 prompt 以 JSON-RPC error 结束时映射为 **`aborted`**，不是 `error`。判据只看「我们是否发过 cancel」，**不看 error code**（不同实现可能用不同 code）；原 message 仍保留在 diagnostic 里。否则主机自己取消的任务会被报成失败，模型可能据此错误重试。
2. **审批超时兜底**：`approvalTimeoutMs` 到点必须自己回 `reject-once`，且不得抛错打断 turn。
3. **缓存缺失可见**：`onApproval` 收到的 `toolName`/`rawInput` 为 `undefined` 时**照样上报**，由 review-engine 决定拒绝——bridge 不做决策。

### 契约修正记录（集成测试发现）

| 修正 | 原因 |
|---|---|
| `startTask` 接受 per-call `onUpdate`/`onApproval`，构造级作为默认 | 一条 bridge 是**长连接、服务多个任务**；回调必须能归属到当前任务。原先只在构造函数给，导致 Provider 无法把事件归到具体任务（实测：`toolCallCount` 恒为 0、审批走不到 review-engine） |
| `cancel()` 后的 prompt error → `aborted` | `remote_interrupt` 依赖这个区分；否则主机自己取消的任务被报成失败，模型会重试 |

---

## 测试要求

- 用 `node --test`（内置），**不引入测试框架依赖**。
- A：纯函数/纯类，覆盖每条规则与**规则顺序**（顺序写错要能让测试失败）。
- B：**不得依赖真实网络或真实 DSH**。用 SDK 的 `ndJsonStream` 配一对内存流做假 agent 端，覆盖：正常完成、prompt 报错、取消、**审批超时**、**审批缓存未命中**。

---

## 集成后确认的契约细节（实现时照此）

### 🔴 `ctx.tools.register()` **不会转换** `parameters` —— 必须是完整 JSON Schema

这是插件第一次装机时踩到的坑，代价是**插件完全不可用**：

```
Invalid schema for function 'remote_agents':
schema must be a JSON Schema of 'type: "object"', got 'type: null'.
```

**事实**（读 `dsh-tools/lib/index.js`）：

| 环节 | 行为 |
|---|---|
| `defineTool(options)` | `const parameters = parameterSchemaSpecToJsonSchema(options.parameters)` —— **这里**把作者简写编译成真实 JSON Schema |
| `ctx.tools.register(definition)` | **只校验 `output`**（`assertSupportedJsonSchema(output.schema)` + `output.render` 必须存在）与 `timeoutMs`，然后 `layer.tools.insert(name, definition)` —— **`parameters` 原样存储，完全不碰** |

⇒ 所以如果像下面这样写，模型收到的是一个**没有根类型**的 schema：

```js
// ❌ 作者简写未经转换就注册 —— 每个调用都会失败
ctx.tools.register({ name, parameters: { action: { type: 'string', required: true } }, output, execute })

// ✅ 用 defineTool（第一方插件的写法）
ctx.tools.register(defineTool({ name, parameters: {...}, output, execute }))

// ✅ 或者自己生成完整 JSON Schema（第三方插件更稳，见下）
ctx.tools.register({ name, parameters: objectSchema({...}), output, execute })
```

**为什么第三方插件不该依赖 `defineTool`**：它来自 `@deepseek-ai/dsh-tools`，而本机实测
`@deepseek-ai/*` 在插件里**解析不到**（profile 的 `node_modules/@deepseek-ai/...` 是旧 npm 安装留下的
悬空 junction，Node 又按真实路径解析）。既然 import 不可靠，就在自己这边做转换。

**转换规则**（镜像 `parameterSchemaSpecToJsonSchema`）：

```js
{ type: 'object', properties: <字段去掉 required 关键字>, ...(required.length ? { required: [...] } : {}) }
```

⚠️ **`required: true` 是作者简写、不是 JSON Schema 关键字** —— 必须提到根的 `required` 数组里，
并且**从属性上删掉**；留着它同样是非法 schema。`required` 为空时整个键应省略。

⚠️ 这个坑**所有单测都能通过而插件完全不可用**，因为 `register` 不校验 `parameters`。
必须有一条**断言 schema 形状**的测试，以及装载路径上的同类检查（见 `plugin-smoke.mjs`）。

### 路由只看 `needsHuman`，不看 `source`

`Decision.source` 是**审计分类**，不是调用方分流的依据。特别是 `danger-full-access`
的申请会被分类为 `tier-check`（因为那是规则 2 明确判定的），但它**同样需要人工**。
调用方必须写 `if (decision.needsHuman) ...`；写成 `if (decision.source === 'human')`
会在某天把最高档提权静默变成自动放行。

### `requiredTier` 必须按每次审批推导，不能取固定配置值

`decideApproval` 把 `policy.requiredTier` 当**权威**值（它拿不到 workspaceRoot 的语义）。
所以**调用方**每轮都要算：

```js
const requiredTier = inferRequiredTier(ask.rawInput, {
  workspaceRoot: worker.cwd, toolName: ask.toolName, defaultTier: cfg.requiredTier,
})
```

若图省事传一个固定 `cfg.requiredTier`：`danger-full-access` 仍会被拦住（安全缺口堵住），
但**「读操作申请 workspace-write」这类过度申请会漏检** —— 档位检查就失去意义了。

### `UpdateEvent.tool` 的字段与继承

| 事件 | `tool.toolName` | `tool.rawInput` | `tool.status` |
|---|---|---|---|
| `tool_call` | ✅ 来自 `title` | ✅ 本次通知的完整参数 | DSH 给了就用，缺省 `'unknown'` |
| `tool_call_update` | ✅ 从 `tool_call` 缓存**继承** | ✅ **不丢**，从缓存继承；仅当 update 显式带了才覆盖 | 本次通知的值 |

⇒ **Provider/缓存侧以 `tool_call` 那次为准**是对的；`tool_call_update` 只保证不丢事实。

⚠️ 喂给 `ToolCallCache` 时必须**显式映射**：`{ title: evt.tool.toolName, rawInput: evt.tool.rawInput, status: evt.tool.status }`。
直接把 `evt.tool` 传进去会把 `toolName` 静默缓存成 `undefined`（因为缓存契约的键是 `title`），
后果是 `allowedTools` 永不命中、审计里工具名为空。

### 常量单一来源

`TIER` / `OPTION` 由 `core/review-engine.js` 导出，是唯一来源。
`bridge/acp-bridge.js` 目前自带 `OPTION_ALLOW_ONCE` / `OPTION_REJECT_ONCE`（值一致）——
这是**同一常量两处定义**，将来改 ACP optionId 会漏改。实现时应让 bridge 从 `core` 取值。

### 已知边界（策略级，不是内核级）

这几条是**有意接受**的限制，不是缺陷，但必须在审计与文档里讲清楚，避免被当成强保证：

| 边界 | 说明 |
|---|---|
| **路径包含判断是纯文本的** | 不解析 symlink/junction、不处理 Windows 8.3 短名。`C:\ws\link -> D:\secret` 这种**链接逃逸挡不住**（解析需要 I/O，而该模块契约要求无 I/O）。真正的边界仍然是**从机沙箱**，本模块只是策略层 |
| **`memoryKey` 对路径风格敏感** | 保留模型原样写法（审计可读）。模型把 `C:\ws\a.txt` 换成 `C:/ws/a.txt` 重试会得到**两个不同的键**，"本任务内同类不再问"会失效一次。可通过规范化 `memoryKey` 输出修复（1 行 + 测试） |
| **`ToolCallCache.misses` 只统计 `get()` 未命中** | 即"审批查询失败"，正对"命中率低意味着审批无法判断"这个告警目的。`update()` 打到未知 id 不计 miss 且会新建记录（丢弃比丢失事实更糟） |
| **`allowedTools` 大小写敏感，工具分类忽略大小写** | 授权名单必须精确；启发式分类可以宽容 |
| **命令类工具里的路径不解析** | 不猜 shell 参数 |

### `dispose()` 与取消的语义区分

`dispose()` 是**链路拆除**，不是用户取消。所以「`cancel()` 后立刻 `dispose()`，随后 prompt 以 connection-closed reject」
会报 `stopReason: 'error'`（链路失败），而**不是** `'aborted'`。这是刻意的：
把链路失败报成"用户取消"会让运维漏掉真实的连接问题。
