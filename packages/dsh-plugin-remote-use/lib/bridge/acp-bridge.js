/**
 * 【B】ACP over WebSocket 客户端桥。
 *
 * 契约来源：`docs/INTERFACES.md` 的【B】节 + `docs/DESIGN.md` §13.1–13.6 / §8.4。
 * 签名不得改动；本文件只做增量（见文件末尾注释与交付说明）。
 *
 * 三个硬行为（INTERFACES【B】）：
 *  1. 停止原因映射：prompt 的 JSON-RPC reject → 'error'（diagnostic 取其 message，
 *     除非本 turn 收到过本地 cancel() → 'aborted'，见下）；cancelled → 'aborted'；
 *     refusal → 'refusal'；max_tokens → 'max-tokens'；否则 'completed'。
 *  2. 审批超时兜底：approvalTimeoutMs 到点自己回 reject-once，不依赖调用方守约，
 *     且绝不抛错打断 turn（DESIGN §8.4）。
 *  3. 缓存未命中可见：onApproval 收到的 toolName/rawInput 可能是 undefined，照样上报，
 *     决策留给 review-engine，bridge 不做决策。
 *
 * 取消语义（硬行为 1 的补充，Lead 裁决）：
 *  一次 turn 内收到过本地 `cancel()` 后，如果 prompt 以 JSON-RPC reject 结束（不同实现
 *  可能用不同 error code，例如 -32800），映射为 `'aborted'` 而不是 `'error'`，原 message
 *  仍保留在 diagnostic 里。判据是「本 turn 是否收到过本地 cancel()」，**不看 code**；
 *  `remote_interrupt` 依赖这个区分，否则模型会把「我们自己取消的」误当失败去重试。
 *
 * 回调归属（集成缝修正，INTERFACES【B】的增量）：
 *  `startTask({ cwd, prompt, onUpdate, onApproval })` 可按任务覆盖构造级默认回调
 *  （`onUpdate`/`onApproval` 仍在构造函数里可用，是 INTERFACES 原契约）。
 *  两者在每次 startTask 里解析一次并存进当前任务记录，事件与审批分发**只读任务记录**，
 *  绝不跨任务串台；任务结束（含 throw）即随任务记录一起丢弃，下一个任务必定重新解析。
 *  两者都不给时行为不变：没有 onApproval → fail closed 回 reject-once。
 *  注：任务结束后到达的迟到 update 没有归属者，直接丢弃（turn 已结束、TaskResult 已快照）。
 *
 * 已知代价（U6）：每个任务结束都 best-effort 发一次 `session/close`（失败静默），
 *  因此 V1 **没有 session 复用** —— 每任务冷启动约 1–2s。这是有意取舍（不泄漏 session），
 *  不是遗漏；要复用需配合 `session/resume`。
 *
 * 实测事实（DESIGN §13.3–13.5）：
 *  - `session/prompt` 的 result 只有 `{stopReason}`；正文只能从
 *    `session/update` 的 `agent_message_chunk` 累积。
 *  - `tool_call` 的 `title` 就是工具名，`rawInput` 是完整参数。
 *  - `session/request_permission` 的 params 只带 `{sessionId, toolCall:{toolCallId}, options}`。
 */
import * as acp from '@agentclientprotocol/sdk'
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client'
import { WebSocket as WsWebSocket } from 'ws'

/** 默认审批超时（DESIGN §8.4 硬性要求）。 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 90_000

/** ACP 审批应答的 optionId（DESIGN §2.3，ACP 硬编码两个值）。 */
export const OPTION_ALLOW_ONCE = 'allow-once'
export const OPTION_REJECT_ONCE = 'reject-once'

/** 连接名，仅用于 SDK 诊断。 */
const DEFAULT_CLIENT_NAME = 'dsh-plugin-remote-use'

/**
 * 插件自定义 RPC 的命名空间。
 *
 * 从机中继在把帧转发给 `dsh --profile acp` 之前先按这个前缀拦截，所以这些方法
 * **不经过 ACP agent**，也不需要扩 ACP 词汇表。前缀与写入权限一起构成边界：
 * 未知的 `dsh-remote/*` 方法由中继显式回 `-32601`，绝不静默转发
 * （静默转发会让未来的协议新增看起来像 no-op）。
 */
export const PLUGIN_RPC_PREFIX = 'dsh-remote/'

/** 插件 RPC 的默认超时。自检单独放宽，见下。 */
const DEFAULT_PLUGIN_RPC_TIMEOUT_MS = 15_000

/** 自检要跑 PowerShell 并做 P/Invoke 探测（实测约 1.5–2.5s），给更宽的预算。 */
const DEFAULT_SELFCHECK_TIMEOUT_MS = 60_000

/**
 * 停止原因映射（硬行为 1）。
 *
 * 注意：DSH 把 `blocked`/`error` 都映射成 `end_turn`（DESIGN §13.5），
 * 所以失败判定必须靠传输层 —— prompt 的 JSON-RPC reject 由 {@link AcpBridge.startTask}
 * 映射成 `'error'`，不经过本函数。
 *
 * @param {unknown} stopReason ACP `stopReason`
 * @returns {'completed'|'error'|'aborted'|'refusal'|'max-tokens'}
 */
export function mapStopReason(stopReason) {
  switch (stopReason) {
    case 'cancelled':
      return 'aborted'
    case 'refusal':
      return 'refusal'
    case 'max_tokens':
      return 'max-tokens'
    // end_turn / max_turn_requests / 未知 / 缺失 → completed（INTERFACES 明文「否则」）
    default:
      return 'completed'
  }
}

/**
 * bridge 内部最小版 toolCall 缓存（等价物）。
 *
 * 刻意不 import `lib/core/toolcall-cache.js`（并行实现，写入范围互斥）。
 * 只服务两件事：审批时的 `toolName`/`rawInput` 回填，以及 TaskResult.toolCalls 清单。
 */
export class BridgeToolCallCache {
  /** @type {Map<string, {toolCallId: string, toolName: string|undefined, rawInput: unknown, status: string|undefined}>} */
  #entries = new Map()
  #misses = 0
  #evictions = 0
  #maxEntries

  /** @param {{ maxEntries?: number }} [opts] */
  constructor(opts = {}) {
    const maxEntries = opts?.maxEntries ?? 512
    this.#maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 512
  }

  /**
   * 记录 `tool_call` 通知。`title` 即工具名（DESIGN §13.4）。
   * 同 id 重复 note 时以本次给出的字段为准，缺省字段保留旧值。
   */
  note(toolCallId, { title, rawInput, status } = {}) {
    this.#merge(toolCallId, { title, rawInput, status })
  }

  /** 记录 `tool_call_update`；不覆盖未显式给出的字段。 */
  update(toolCallId, { status, title, rawInput } = {}) {
    this.#merge(toolCallId, { title, rawInput, status })
  }

  /** @returns {{ toolCallId: string, toolName: string|undefined, rawInput: unknown, status: string|undefined }|undefined} */
  get(toolCallId) {
    return this.#entries.get(toolCallId)
  }

  /** 审批时缓存未命中的次数（审计用：命中率低 = 无法判断档位）。 */
  miss() {
    this.#misses += 1
  }

  get misses() {
    return this.#misses
  }

  get evictions() {
    return this.#evictions
  }

  get size() {
    return this.#entries.size
  }

  /** 按首次出现顺序返回全部条目。 */
  values() {
    return [...this.#entries.values()]
  }

  clear() {
    this.#entries.clear()
  }

  #merge(toolCallId, patch) {
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
      return
    }
    const prev = this.#entries.get(toolCallId)
    const entry = {
      toolCallId,
      toolName: patch.title ?? prev?.toolName,
      rawInput: patch.rawInput === undefined ? prev?.rawInput : patch.rawInput,
      status: patch.status ?? prev?.status,
    }
    // 保持「首次出现」顺序：重复 id 走 set 不改变 Map 的插入顺序。
    this.#entries.set(toolCallId, entry)
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) {
        break
      }
      this.#entries.delete(oldest.value)
      this.#evictions += 1
    }
  }
}

/**
 * ACP over WebSocket 客户端。
 *
 * @typedef {object} UpdateEvent
 * @property {'message'|'thought'|'tool_call'|'tool_call_update'|'usage'|'config'|'other'} kind
 * @property {string} [text]
 * @property {{toolCallId: string, toolName: string|undefined, rawInput: unknown, status: string}} [tool]
 * @property {{used: number, size: number}} [usage]
 *
 * @typedef {object} ApprovalAsk
 * @property {string} toolCallId
 * @property {string|undefined} toolName
 * @property {unknown} rawInput
 *
 * @typedef {object} TaskCallbacks
 * @property {(evt: UpdateEvent) => void} [onUpdate]
 * @property {(req: ApprovalAsk) => Promise<'allow-once'|'reject-once'>} [onApproval]
 *
 * @typedef {object} TaskResult
 * @property {'completed'|'error'|'aborted'|'refusal'|'max-tokens'} stopReason
 * @property {string} output
 * @property {string} [diagnostic]
 * @property {Array<{toolCallId: string, toolName: string|undefined, status: string}>} toolCalls
 * @property {{used: number, size: number}|undefined} usage
 */
export class AcpBridge {
  #url
  #token
  #approvalTimeoutMs
  /** 构造级默认回调（INTERFACES 原契约）；可被 startTask 的 per-call 回调覆盖。 */
  #defaultOnUpdate
  #defaultOnApproval
  #streamOption
  #streamFactory
  #WebSocketCtor

  /** ClientConnectionHandle（SDK 私有类型，只用公开的 close/signal/closed/agent） */
  #handle
  /** @type {any} ClientContext */
  #ctx
  #toolCalls = new BridgeToolCallCache()
  #task
  #activeSessionId
  /**
   * 本 turn 是否收到过本地 `cancel()`。
   * 只由 `cancel()` 置位、只作用于当前 turn：`startTask` 占位时清零，任务结束/teardown 再清零。
   * @type {boolean}
   */
  #cancelRequested = false
  #disposed = false
  #connected = false
  #initResult
  #pendingTimers = new Set()
  #stats = {
    approvals: 0,
    approvalTimeouts: 0,
    approvalErrors: 0,
    toolCallMisses: 0,
    updates: 0,
  }

  /**
   * @param {object} opts
   * @param {string} [opts.url]                  ws://host:port
   * @param {string} [opts.token]                Bearer
   * @param {number} [opts.approvalTimeoutMs]    默认 90_000
   * @param {(evt: UpdateEvent) => void} [opts.onUpdate]
   *        构造级默认回调；可被 `startTask({ onUpdate })` 按任务覆盖
   * @param {(req: ApprovalAsk) => Promise<'allow-once'|'reject-once'>} [opts.onApproval]
   *        构造级默认回调；可被 `startTask({ onApproval })` 按任务覆盖
   * @param {{readable: ReadableStream, writable: WritableStream}} [opts.stream]
   *        增量：注入已建好的 ACP stream（测试用内存流；生产可不传）
   * @param {() => any} [opts.streamFactory]
   *        增量：每次 connect() 调用一次，返回 stream（或 Promise<stream>）
   * @param {typeof WsWebSocket} [opts.WebSocket]
   *        增量：覆盖 WS 构造器（默认 `ws` 的 WebSocket）
   */
  constructor(opts = {}) {
    if (opts === null || typeof opts !== 'object') {
      throw new TypeError('AcpBridge: opts must be an object')
    }
    const {
      url,
      token,
      approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
      onUpdate,
      onApproval,
      stream,
      streamFactory,
      WebSocket,
    } = opts

    if (stream === undefined && streamFactory === undefined) {
      if (typeof url !== 'string' || url.length === 0) {
        throw new TypeError(
          'AcpBridge: opts.url (ws://host:port) is required unless opts.stream/opts.streamFactory is given',
        )
      }
    }
    if (typeof approvalTimeoutMs !== 'number' || !Number.isFinite(approvalTimeoutMs) || approvalTimeoutMs < 0) {
      throw new TypeError('AcpBridge: opts.approvalTimeoutMs must be a finite number >= 0')
    }
    if (onUpdate !== undefined && typeof onUpdate !== 'function') {
      throw new TypeError('AcpBridge: opts.onUpdate must be a function')
    }
    if (onApproval !== undefined && typeof onApproval !== 'function') {
      throw new TypeError('AcpBridge: opts.onApproval must be a function')
    }
    if (token !== undefined && typeof token !== 'string') {
      throw new TypeError('AcpBridge: opts.token must be a string')
    }

    this.#url = url
    this.#token = token
    this.#approvalTimeoutMs = approvalTimeoutMs
    this.#defaultOnUpdate = onUpdate
    this.#defaultOnApproval = onApproval
    this.#streamOption = stream
    this.#streamFactory = streamFactory
    this.#WebSocketCtor = WebSocket ?? WsWebSocket
  }

  /** 是否已完成 initialize。 */
  get connected() {
    return this.#connected
  }

  /** initialize 的原始 result（诊断用）。 */
  get initResult() {
    return this.#initResult
  }

  /** 当前 session id（无任务时为 undefined）。 */
  get sessionId() {
    return this.#activeSessionId
  }

  /** 本桥内的 toolCall 缓存（只读观察，含 misses/evictions/size）。 */
  get toolCalls() {
    return this.#toolCalls
  }

  /** 可观测计数（审计 / §8.6 通知用）。 */
  get stats() {
    return { ...this.#stats, toolCallMisses: this.#toolCalls.misses }
  }

  /**
   * 调用插件自定义 RPC（`dsh-remote/*`）。
   *
   * 这些方法由从机中继**本地**处理，不经过 ACP agent —— 中继在把帧转发给
   * `dsh --profile acp` 之前先拦截 `dsh-remote/` 前缀。SDK 的 `request()` 只把
   * method 当字符串发出去，不校验它是否属于 ACP 词汇表（已实测），所以不需要
   * 额外的传输层。
   *
   * @param {string} method  必须以 `dsh-remote/` 开头
   * @param {object} [params]
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<unknown>}
   */
  async callPlugin(method, params = {}, opts = {}) {
    if (this.#disposed || !this.#ctx) {
      throw new Error('AcpBridge.callPlugin: not connected')
    }
    if (typeof method !== 'string' || !method.startsWith(PLUGIN_RPC_PREFIX)) {
      throw new Error(`AcpBridge.callPlugin: method must start with "${PLUGIN_RPC_PREFIX}", got ${String(method)}`)
    }
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(1, Number(opts.timeoutMs)) : DEFAULT_PLUGIN_RPC_TIMEOUT_MS
    return await this.#withTimeout(
      this.#ctx.request(method, params),
      timeoutMs,
      `plugin RPC "${method}" did not answer within ${timeoutMs}ms`,
    )
  }

  /**
   * 向从机索取就绪报告（派单门禁与配置页共用）。
   *
   * `maxAgeMs: 0` 强制重跑；默认取中继的缓存（`S8` 会真的移动鼠标，不能每单都跑）。
   * @param {{ maxAgeMs?: number, timeoutMs?: number }} [opts]
   * @returns {Promise<object>}
   */
  async selfcheck(opts = {}) {
    const params = Number.isFinite(opts.maxAgeMs) ? { maxAgeMs: Number(opts.maxAgeMs) } : {}
    return await this.callPlugin(
      `${PLUGIN_RPC_PREFIX}selfcheck`,
      params,
      // 自检要跑 PowerShell 并做 P/Invoke 探测，比普通 RPC 慢；给它更宽的预算。
      { timeoutMs: opts.timeoutMs ?? DEFAULT_SELFCHECK_TIMEOUT_MS },
    )
  }

  /**
   * `Promise.race` 形式的超时包装：只有被包裹的操作自身无法取消（SDK request 不接
   * signal），所以超时后原 promise 仍会挂着，但已经不再影响调用方。
   * @template T
   * @param {Promise<T>} promise
   * @param {number} timeoutMs
   * @param {string} message
   * @returns {Promise<T>}
   */
  #withTimeout(promise, timeoutMs, message) {
    let timer
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
  }

  /**
   * 建立连接 + initialize。
   * @returns {Promise<{agentInfo: object, capabilities: object}>}
   */
  async connect() {
    if (this.#disposed) {
      throw new Error('AcpBridge.connect: bridge is disposed')
    }
    if (this.#ctx) {
      throw new Error('AcpBridge.connect: already connected')
    }

    const stream = await this.#resolveStream()
    const app = acp
      .client({ name: DEFAULT_CLIENT_NAME })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.#handlePermissionRequest(ctx.params),
      )
      .onNotification(acp.methods.client.session.update, (ctx) => this.#handleSessionUpdate(ctx.params))

    // 用 connect()（而非 connectWith）保持长连接：connectWith 会在 op 返回后关闭连接，
    // 而本桥的一次连接要跨多个 startTask。
    const handle = app.connect(stream)
    this.#handle = handle
    this.#ctx = handle.agent

    try {
      const result = await this.#ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      this.#initResult = result
      this.#connected = true
      return {
        agentInfo: result?.agentInfo ?? {},
        capabilities: result?.agentCapabilities ?? {},
      }
    } catch (error) {
      await this.#teardown()
      throw error
    }
  }

  /**
   * 新建 session 并发送 prompt，阻塞到 turn 结束。
   *
   * 前置失败（未连接 / session/new 失败）会 throw；prompt 阶段的 JSON-RPC error
   * 会被映射成 `{ stopReason: 'error', diagnostic }` 而不是 throw（硬行为 1）。
   *
   * 回调按任务解析（INTERFACES【B】的增量）：`req.onUpdate` / `req.onApproval` 覆盖
   * 构造级默认值；两者都不给时行为与只传构造级回调完全一致（无 onApproval → fail closed）。
   * 解析结果存进 `#task`，本 turn 的所有事件/审批都从那里取，绝不跨任务串台。
   *
   * @param {{ cwd: string, prompt: string } & TaskCallbacks} req
   * @returns {Promise<TaskResult>}
   */
  async startTask(req) {
    this.#assertConnected('startTask')
    if (this.#task) {
      throw new Error('AcpBridge.startTask: a task is already in progress on this bridge')
    }
    const cwd = req?.cwd
    const promptText = req?.prompt
    const perCallOnUpdate = req?.onUpdate
    const perCallOnApproval = req?.onApproval
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new TypeError('AcpBridge.startTask: req.cwd must be a non-empty path string')
    }
    if (typeof promptText !== 'string') {
      throw new TypeError('AcpBridge.startTask: req.prompt must be a string')
    }
    if (perCallOnUpdate !== undefined && typeof perCallOnUpdate !== 'function') {
      throw new TypeError('AcpBridge.startTask: req.onUpdate must be a function')
    }
    if (perCallOnApproval !== undefined && typeof perCallOnApproval !== 'function') {
      throw new TypeError('AcpBridge.startTask: req.onApproval must be a function')
    }

    // 每个任务独立解析一次：显式入参 > 构造默认（undefined 的 per-call 不算覆盖）。
    const emitUpdate = perCallOnUpdate ?? this.#defaultOnUpdate
    const askApproval = perCallOnApproval ?? this.#defaultOnApproval

    // 先占位再发 session/new：让单任务守卫是同步的（并发 startTask 会立刻被拒）。
    // 注意：清 cancel 标志必须在并发守卫**之后**，否则第二个 startTask 会清掉在跑那个 turn 的取消状态。
    /**
     * @type {{
     *   sessionId: string|undefined,
     *   output: string,
     *   toolCallIds: string[],
     *   usage: {used:number,size:number}|undefined,
     *   emitUpdate: ((evt: UpdateEvent) => void)|undefined,
     *   askApproval: ((req: ApprovalAsk) => Promise<'allow-once'|'reject-once'>)|undefined,
     * }}
     */
    const task = { sessionId: undefined, output: '', toolCallIds: [], usage: undefined, emitUpdate, askApproval }
    this.#task = task
    this.#cancelRequested = false
    let sessionId
    try {
      const created = await this.#ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
      sessionId = created?.sessionId
      task.sessionId = sessionId
      this.#activeSessionId = sessionId

      try {
        const response = await this.#ctx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: promptText }],
        })
        await drain()
        return {
          stopReason: mapStopReason(response?.stopReason),
          output: task.output,
          toolCalls: this.#toolCallsOf(task),
          usage: task.usage,
        }
      } catch (error) {
        await drain()
        // 本地取消后对端以 JSON-RPC error 结束 → 'aborted'（不看 code，只看我们是否发过 cancel）。
        // 未发 cancel 时维持 'error'，避免把真失败误判成取消。
        const cancelled = this.#cancelRequested
        return {
          stopReason: cancelled ? 'aborted' : 'error',
          diagnostic: errorMessage(error),
          output: task.output,
          toolCalls: this.#toolCallsOf(task),
          usage: task.usage,
        }
      }
    } finally {
      this.#task = undefined
      this.#activeSessionId = undefined
      this.#cancelRequested = false
      if (sessionId !== undefined) {
        await this.#closeSession(sessionId)
      }
    }
  }

  /**
   * 上层取消：对当前 session 发 `session/cancel`（不等待 quiescence）。
   * 未连接 / 无进行中任务时是 no-op（此时不置取消标志，避免污染下一个 turn）。
   */
  async cancel() {
    if (this.#disposed || !this.#ctx) {
      return
    }
    const sessionId = this.#activeSessionId
    if (sessionId === undefined) {
      return
    }
    // 置位在 notify 之前：即使 notify 本身失败，也算「我们发过取消意图」，
    // 后续 prompt 以 error 结束时仍按 'aborted' 上报。
    this.#cancelRequested = true
    await this.#ctx.notify(acp.methods.agent.session.cancel, { sessionId })
  }

  /** 关闭 WS 与所有 session。幂等。 */
  async dispose() {
    if (this.#disposed) {
      return
    }
    this.#disposed = true
    await this.#teardown()
  }

  // ---------------------------------------------------------------- 内部

  async #resolveStream() {
    if (this.#streamOption !== undefined) {
      if (!isStream(this.#streamOption)) {
        throw new TypeError('AcpBridge: opts.stream must be an ACP Stream ({ readable, writable })')
      }
      return this.#streamOption
    }
    if (this.#streamFactory !== undefined) {
      const stream = await this.#streamFactory()
      if (!isStream(stream)) {
        throw new TypeError('AcpBridge: opts.streamFactory must return an ACP Stream ({ readable, writable })')
      }
      return stream
    }
    return createWebSocketStream(this.#url, {
      WebSocket: this.#WebSocketCtor,
      ...(this.#token ? { headers: { Authorization: `Bearer ${this.#token}` } } : {}),
    })
  }

  #assertConnected(op) {
    if (this.#disposed) {
      throw new Error(`AcpBridge.${op}: bridge is disposed`)
    }
    if (!this.#ctx) {
      throw new Error(`AcpBridge.${op}: not connected; call connect() first`)
    }
  }

  async #teardown() {
    for (const timer of this.#pendingTimers) {
      clearTimeout(timer)
    }
    this.#pendingTimers.clear()

    const handle = this.#handle
    this.#handle = undefined
    this.#ctx = undefined
    this.#connected = false
    this.#task = undefined
    this.#activeSessionId = undefined
    this.#cancelRequested = false
    this.#toolCalls.clear()

    if (handle) {
      try {
        handle.close()
      } catch {
        // 关闭失败不影响 dispose 幂等语义。
      }
    }
  }

  async #closeSession(sessionId) {
    if (sessionId === undefined || !this.#ctx) {
      return
    }
    try {
      // session/close 是可选能力（DESIGN §13.3 第 6 步）：best-effort，失败不影响结果。
      await this.#ctx.request(acp.methods.agent.session.close, { sessionId })
    } catch {
      // ignore
    }
  }

  /** @returns {Array<{toolCallId: string, toolName: string|undefined, status: string}>} */
  #toolCallsOf(task) {
    return task.toolCallIds.map((toolCallId) => {
      const entry = this.#toolCalls.get(toolCallId)
      return {
        toolCallId,
        toolName: entry?.toolName,
        status: entry?.status ?? 'unknown',
      }
    })
  }

  /**
   * `session/update` 通知（DESIGN §13.4 的 6 种变体 + 未知一律 'other'）。
   */
  #handleSessionUpdate(params) {
    if (params === null || typeof params !== 'object') {
      return
    }
    const { sessionId, update } = params
    if (update === null || typeof update !== 'object') {
      return
    }
    const task = this.#task
    if (task && sessionId !== undefined && task.sessionId !== undefined && sessionId !== task.sessionId) {
      return
    }
    this.#stats.updates += 1

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textOf(update.content)
        if (text) {
          if (task) {
            task.output += text
          }
          this.#emit({ kind: 'message', text })
        }
        return
      }
      case 'agent_thought_chunk': {
        const text = textOf(update.content)
        if (text) {
          this.#emit({ kind: 'thought', text })
        }
        return
      }
      case 'tool_call': {
        const id = update.toolCallId
        this.#toolCalls.note(id, {
          title: update.title ?? update.name,
          rawInput: update.rawInput,
          status: update.status,
        })
        this.#trackToolCall(task, id)
        this.#emit({ kind: 'tool_call', tool: this.#toolView(id, update) })
        return
      }
      case 'tool_call_update': {
        const id = update.toolCallId
        this.#toolCalls.update(id, {
          title: update.title ?? update.name,
          rawInput: update.rawInput,
          status: update.status,
        })
        this.#trackToolCall(task, id)
        this.#emit({ kind: 'tool_call_update', tool: this.#toolView(id, update) })
        return
      }
      case 'usage_update': {
        const usage = { used: toNumber(update.used), size: toNumber(update.size) }
        if (task) {
          task.usage = usage
        }
        this.#emit({ kind: 'usage', usage })
        return
      }
      case 'config_option_update': {
        this.#emit({ kind: 'config' })
        return
      }
      default: {
        this.#emit({ kind: 'other' })
        return
      }
    }
  }

  #trackToolCall(task, toolCallId) {
    if (!task || typeof toolCallId !== 'string' || toolCallId.length === 0) {
      return
    }
    if (!task.toolCallIds.includes(toolCallId)) {
      task.toolCallIds.push(toolCallId)
    }
  }

  #toolView(toolCallId, update) {
    const cached = this.#toolCalls.get(toolCallId)
    return {
      toolCallId,
      toolName: cached?.toolName ?? update?.title ?? update?.name,
      rawInput: cached?.rawInput ?? update?.rawInput,
      status: cached?.status ?? update?.status ?? 'unknown',
    }
  }

  /**
   * 事件只分发给**当前任务**解析出来的回调（`#task.emitUpdate`）。
   *
   * 没有进行中任务时没有归属者，事件直接丢弃：turn 已结束（TaskResult 已快照），
   * 迟到的 update 不属于任何任务，绝不能落到别的任务的回调上。
   */
  #emit(event) {
    const emitUpdate = this.#task?.emitUpdate
    if (typeof emitUpdate !== 'function') {
      return
    }
    try {
      emitUpdate(event)
    } catch {
      // onUpdate 抛错不得打断 turn。
    }
  }

  /**
   * `session/request_permission`（硬行为 2 + 3）。
   *
   * params 只带 toolCallId（DESIGN §13.3 第 5 步），所以 toolName/rawInput 只能从
   * toolCall 缓存回填；未命中就照样上报 undefined，由 review-engine 拒绝。
   */
  async #handlePermissionRequest(params) {
    const options = Array.isArray(params?.options) ? params.options : []
    const toolCallId = params?.toolCall?.toolCallId
    const cached = typeof toolCallId === 'string' ? this.#toolCalls.get(toolCallId) : undefined
    if (typeof toolCallId === 'string' && cached === undefined) {
      this.#toolCalls.miss()
    }

    /** @type {ApprovalAsk} */
    const ask = {
      toolCallId,
      toolName: cached?.toolName,
      rawInput: cached?.rawInput,
    }
    const rejectOptionId = pickRejectOptionId(options)

    // 只认当前任务解析出来的决策者（per-call 覆盖构造默认）。
    const askApproval = this.#task?.askApproval
    let answered
    if (typeof askApproval !== 'function') {
      // 没有决策者时 fail closed，绝不默认放行（DESIGN §5.2 / §8.3）。
      answered = rejectOptionId
    } else {
      this.#stats.approvals += 1
      answered = await this.#askApprovalWithTimeout(askApproval, ask, rejectOptionId)
    }

    const optionId = normalizeSelected(answered, options, rejectOptionId)
    return { outcome: { outcome: 'selected', optionId } }
  }

  /**
   * 硬行为 2：超时/异常一律回落到 reject-once，且绝不抛错打断 turn。
   * @param {(req: ApprovalAsk) => Promise<'allow-once'|'reject-once'>} askApproval 本任务解析出的决策者
   * @returns {Promise<string>} 最终 optionId
   */
  async #askApprovalWithTimeout(askApproval, ask, fallbackOptionId) {
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        this.#stats.approvalTimeouts += 1
        resolve(fallbackOptionId)
      }, this.#approvalTimeoutMs)
      this.#pendingTimers.add(timer)
    })

    const answered = Promise.resolve()
      .then(() => askApproval(ask))
      .then(
        (optionId) => optionId,
        () => {
          this.#stats.approvalErrors += 1
          return fallbackOptionId
        },
      )

    try {
      return await Promise.race([answered, timeout])
    } finally {
      clearTimeout(timer)
      this.#pendingTimers.delete(timer)
    }
  }
}

// ------------------------------------------------------------------ helpers

function isStream(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.readable === 'object' &&
    value.readable !== null &&
    typeof value.writable === 'object' &&
    value.writable !== null
  )
}

/** 从 content block（实测 `{type:'text',text}`）取文本，容错 null/非文本。 */
function textOf(content) {
  if (content === null || typeof content !== 'object') {
    return undefined
  }
  return typeof content.text === 'string' ? content.text : undefined
}

function toNumber(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 从 options 里挑「拒绝」用的 optionId（ACP：任何非 allow-once 的都算拒绝）。
 * 实测 DSH 只给 allow-once / reject-once，但按 kind 兜底。
 */
function pickRejectOptionId(options) {
  for (const option of options) {
    if (option?.optionId === OPTION_REJECT_ONCE) {
      return OPTION_REJECT_ONCE
    }
  }
  for (const option of options) {
    if (typeof option?.kind === 'string' && option.kind.startsWith('reject')) {
      return option.optionId
    }
  }
  for (const option of options) {
    if (option?.optionId !== OPTION_ALLOW_ONCE && typeof option?.optionId === 'string') {
      return option.optionId
    }
  }
  return OPTION_REJECT_ONCE
}

/** 只接受 allow-once；其余（含 undefined/异常值）一律回落到拒绝。 */
function normalizeSelected(answered, options, rejectOptionId) {
  if (answered === OPTION_ALLOW_ONCE && options.some((option) => option?.optionId === OPTION_ALLOW_ONCE)) {
    return OPTION_ALLOW_ONCE
  }
  return rejectOptionId
}

function errorMessage(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) {
    return error.message
  }
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}

/**
 * 让传输层的 `session/update` 通知处理先于结果快照跑完。
 *
 * 一次 prompt 里，通知与 prompt response 走在同一条有序流上，SDK 的 receive 循环
 * 对通知是「启动即返回」的（`jsonrpc.js` 的 `receive()` 不 await 通知处理）。
 * 因此这里让出一个宏任务，保证所有已到达通知的 handler 主体（同步累加 output /
 * 写 toolCall 缓存）都已执行，再快照 TaskResult，避免拿到半截 output。
 */
function drain() {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}
