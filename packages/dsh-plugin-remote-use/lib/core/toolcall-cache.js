/**
 * `toolCallId` → `{ toolName, rawInput, status }` 缓存（INTERFACES.md 【A】）。
 *
 * 纯内存、无依赖、无 I/O。
 *
 * 为什么这是必需品（DESIGN §10.0.1 实测）：ACP 的 `session/request_permission`
 * **只带 `toolCallId`**，不带工具名、参数，也不带申请的沙箱档位。主机的档位检查
 * （`review-engine`）只能从 `tool_call` / `tool_call_update` 通知里提前缓存下来的
 * `rawInput.sandbox_permissions` 取值。缓存未命中 → 审批无法判断 → 必须拒绝。
 *
 * 因此本类把两件事做成**可观测事实**：未命中计数 `misses` 与淘汰计数 `evictions`。
 */

/** 默认容量上限（INTERFACES.md 规定默认 512）。 */
const DEFAULT_MAX_ENTRIES = 512

/** 通知里没带 status 时的占位值（ACP 的初始状态即 pending）。 */
const DEFAULT_STATUS = 'pending'

/**
 * @typedef {object} ToolCallRecord
 * @property {string | undefined} toolName 来自 `tool_call` 通知的 `title`
 * @property {unknown} rawInput            完整参数（档位检查的唯一数据来源）
 * @property {string} status               `pending` | `in_progress` | `completed` | `failed` | 未知名
 */

/**
 * `toolCallId` 缓存。容量满时按 LRU（最久未使用）淘汰。
 *
 * 最近使用顺序：`note()` / `update()` 写入的记录移到队尾；`get()` 命中也把记录移到队尾。
 * 理由是一次审批往往发生在 `tool_call` 之后的若干个 `tool_call_update` 之后。
 */
export class ToolCallCache {
  /** @type {Map<string, ToolCallRecord>} */
  #entries

  /** @type {number} */
  #maxEntries

  /** @type {number} */
  #misses

  /** @type {number} */
  #evictions

  /**
   * @param {{ maxEntries?: number }} [opts] 容量上限，默认 512；非正整数按默认处理
   */
  constructor(opts) {
    const max = isPlainObject(opts) ? opts.maxEntries : undefined
    this.#maxEntries = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_ENTRIES
    this.#entries = new Map()
    this.#misses = 0
    this.#evictions = 0
  }

  /**
   * 容量上限（只读，便于审计/配置页展示）。
   * @returns {number}
   */
  get maxEntries() {
    return this.#maxEntries
  }

  /**
   * 累计未命中次数：`get()` 查不到记录（含非法 `toolCallId`）就 +1。
   * 这是审计告警位——命中率低意味着审批决策拿不到判断依据。**不因 `clear()` 归零**。
   * @returns {number}
   */
  get misses() {
    return this.#misses
  }

  /**
   * 当前记录条数。
   * @returns {number}
   */
  get size() {
    return this.#entries.size
  }

  /**
   * 累计因容量上限淘汰的条数（「把淘汰记为可观测事实」）。**不因 `clear()` 归零**。
   * @returns {number}
   */
  get evictions() {
    return this.#evictions
  }

  /**
   * 从 ACP 的 `tool_call` 通知记录一条：`title` 即工具名。
   *
   * 重复 `note` 同一个 id 时按「只覆盖显式给出的字段」合并，避免空通知把已有
   * `title` / `rawInput` 抹掉（那会让后续档位检查失效）。
   *
   * 兼容性别名：同时接受 `toolName`（INTERFACES【B】的 `UpdateEvent.tool` 用的就是
   * 这个名字，见 `bridge/acp-bridge.js` 的 `#toolView`）。契约字段是 `title`，
   * 两者任一有效即可，避免调用方传错字段名时**静默**丢掉工具名。
   *
   * @param {string} toolCallId 非空字符串，否则抛 `TypeError`（调用方 bug，尽早暴露）
   * @param {{ title?: string, toolName?: string, rawInput?: unknown, status?: string }} [patch]
   * @returns {void}
   */
  note(toolCallId, patch = {}) {
    const id = requireId(toolCallId, 'note')
    this.#merge(id, patch)
  }

  /**
   * 从 `tool_call_update` 更新 `status` / 补丁：**不覆盖** `title` / `rawInput`，
   * 除非本次显式给出。未知 `toolCallId` 时按同样的合并语义新建一条记录
   * （丢弃比丢失事实更糟；即使只有 status，`rawInput` 仍为 `undefined`，
   * 审批侧照样按缓存缺失拒绝）。
   *
   * 注意：`update()` 未命中**不计入** `misses`——`misses` 只统计审批查询（`get`）失败。
   *
   * @param {string} toolCallId 非空字符串，否则抛 `TypeError`
   * @param {{ status?: string, title?: string, toolName?: string, rawInput?: unknown }} [patch]
   * @returns {void}
   */
  update(toolCallId, patch = {}) {
    const id = requireId(toolCallId, 'update')
    this.#merge(id, patch)
  }

  /**
   * 读取缓存。**命中会把记录移到 LRU 队尾**。返回副本，调用方改动不影响缓存内部。
   *
   * @param {unknown} toolCallId
   * @returns {ToolCallRecord | undefined} 未命中返回 `undefined`（同时 `misses` +1）
   */
  get(toolCallId) {
    if (typeof toolCallId !== 'string' || toolCallId === '') {
      this.#misses += 1
      return undefined
    }
    const record = this.#entries.get(toolCallId)
    if (record === undefined) {
      this.#misses += 1
      return undefined
    }
    this.#entries.delete(toolCallId)
    this.#entries.set(toolCallId, record)
    return { ...record }
  }

  /**
   * 清空全部记录。**不**重置 `misses` / `evictions`（审计计数器是累计的）。
   * @returns {void}
   */
  clear() {
    this.#entries.clear()
  }

  /**
   * 合并写入 + 维持 LRU 与容量上限。
   * @param {string} id
   * @param {{ title?: string, toolName?: string, rawInput?: unknown, status?: string }} patch
   * @returns {void}
   */
  #merge(id, patch) {
    const safe = isPlainObject(patch) ? patch : {}
    const existing = this.#entries.get(id)
    const name = [safe.title, safe.toolName].find(
      (value) => typeof value === 'string' && value.trim() !== '',
    )
    /** @type {ToolCallRecord} */
    const record = {
      toolName: name ?? existing?.toolName,
      rawInput: safe.rawInput !== undefined ? safe.rawInput : existing?.rawInput,
      status:
        typeof safe.status === 'string' && safe.status.trim() !== ''
          ? safe.status
          : (existing?.status ?? DEFAULT_STATUS),
    }
    if (existing !== undefined) this.#entries.delete(id)
    this.#entries.set(id, record)
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) break
      this.#entries.delete(oldest.value)
      this.#evictions += 1
    }
  }
}

/**
 * 校验 `toolCallId`。
 * @param {unknown} toolCallId
 * @param {string} method
 * @returns {string}
 */
function requireId(toolCallId, method) {
  if (typeof toolCallId !== 'string' || toolCallId === '') {
    throw new TypeError(`ToolCallCache.${method}(): toolCallId must be a non-empty string`)
  }
  return toolCallId
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
