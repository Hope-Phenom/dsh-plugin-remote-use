/**
 * 任务内审批记忆（INTERFACES.md 【A】；DESIGN §8.3）。
 *
 * 纯内存、无依赖、无 I/O。
 *
 * **范围严格限定在单任务内**：跨任务记忆会让「上周批准过写这个目录」静默变成永久授权
 * （DESIGN §8.3「为什么默认单任务内」）。任务结束必须 `dispose()`；`dispose()` 之后
 * `lookup()` 恒为 `'unknown'`，且 `noteApprove()` / `noteReject()` 变成 no-op——
 * 已销毁的记忆绝不能复活授权。
 *
 * 三种状态互不覆盖，查询时**拒绝优先**（fail closed）：
 *   - `noteReject(key)`  → `lookup` = `'rejected'`（即使同一 key 也有批准）
 *   - `noteApprove(key, { scope: 'task' })` → `'allowed'`，任务内持续有效
 *   - `noteApprove(key, { scope: 'once' })` → `'allowed'`，由 `consumeOnce()` 用掉一次
 */

/**
 * 单任务审批记忆。
 */
export class TaskMemory {
  /** @type {string} */
  #taskId

  /** @type {Set<string>} */
  #approvals

  /** @type {Set<string>} */
  #rejections

  /** @type {Set<string>} */
  #once

  /** @type {boolean} */
  #disposed

  /**
   * @param {string} taskId 任务标识（非字符串按 `''` 处理，不抛错）
   */
  constructor(taskId) {
    this.#taskId = typeof taskId === 'string' ? taskId : ''
    this.#approvals = new Set()
    this.#rejections = new Set()
    this.#once = new Set()
    this.#disposed = false
  }

  /**
   * 是否已 `dispose()`（只读，便于审计/测试）。
   * @returns {boolean}
   */
  get disposed() {
    return this.#disposed
  }

  /**
   * 记下本次批准。
   *
   * `scope: 'task'`（默认）＝ 本任务内该类永久有效；`scope: 'once'` ＝ 只放行一次，
   * 由 `consumeOnce()` 消耗。**未识别的 scope 按 `'once'` 处理**（fail closed：宁可
   * 只放行一次，也不让一个拼错的 scope 静默放大成任务级授权）。
   *
   * 已是任务级批准的 key 再记 `'once'` 不生效（任务级已覆盖，无需降级）。
   *
   * @param {string} key 非空字符串（来自 `review-engine.memoryKey`），否则抛 `TypeError`
   * @param {{ scope?: 'task' | 'once' }} [opts]
   * @returns {void}
   */
  noteApprove(key, { scope = 'task' } = {}) {
    const k = requireKey(key, 'noteApprove')
    if (this.#disposed) return
    if (scope === 'task') {
      this.#approvals.add(k)
      this.#once.delete(k)
      return
    }
    if (!this.#approvals.has(k)) this.#once.add(k)
  }

  /**
   * 记下本次拒绝。同一 key 在本任务内不再询问（规则引擎会直接拒绝）。
   * 拒绝会作废该 key 待用的一次性批准；已记录的任务级批准保留在快照里，
   * 但查询时被拒绝覆盖（`lookup` 恒返回 `'rejected'`）。
   *
   * @param {string} key 非空字符串，否则抛 `TypeError`
   * @returns {void}
   */
  noteReject(key) {
    const k = requireKey(key, 'noteReject')
    if (this.#disposed) return
    this.#rejections.add(k)
    this.#once.delete(k)
  }

  /**
   * 查询 key 的记忆状态。查询路径**永不抛错**（决策路径不能因为坏输入挂住审批）。
   *
   * @param {unknown} key
   * @returns {'allowed' | 'rejected' | 'unknown'} 已 `dispose()` 或 key 非法时恒为 `'unknown'`
   */
  lookup(key) {
    if (this.#disposed) return 'unknown'
    if (typeof key !== 'string' || key === '') return 'unknown'
    if (this.#rejections.has(key)) return 'rejected'
    if (this.#approvals.has(key)) return 'allowed'
    if (this.#once.has(key)) return 'allowed'
    return 'unknown'
  }

  /**
   * 消耗一次 `'once'` 批准；返回 `true` 表示这次放行已用掉。
   *
   * `'task'` 作用域的批准不会被消耗（返回 `false`，`lookup` 仍为 `'allowed'`）。
   * 若该 key 同时被拒绝，批准作废且返回 `false`（拒绝优先）。
   *
   * @param {unknown} key
   * @returns {boolean} key 非法、已 `dispose()`、无 `'once'` 批准、或被拒绝时为 `false`
   */
  consumeOnce(key) {
    if (this.#disposed) return false
    if (typeof key !== 'string' || key === '') return false
    if (!this.#once.has(key)) return false
    this.#once.delete(key)
    return !this.#rejections.has(key)
  }

  /**
   * 快照（每次返回新对象与新数组，调用方改动不影响内部状态）。
   * @returns {{ taskId: string, approvals: string[], rejections: string[], once: string[] }}
   */
  snapshot() {
    return {
      taskId: this.#taskId,
      approvals: [...this.#approvals],
      rejections: [...this.#rejections],
      once: [...this.#once],
    }
  }

  /**
   * 清空并标记失效。之后 `lookup()` 恒 `'unknown'`，`noteApprove` / `noteReject` 为 no-op，
   * `consumeOnce()` 恒 `false`。幂等。
   * @returns {void}
   */
  dispose() {
    this.#approvals.clear()
    this.#rejections.clear()
    this.#once.clear()
    this.#disposed = true
  }
}

/**
 * 校验记忆键（只用于**写入**路径；查询路径不抛错）。
 * @param {unknown} key
 * @param {string} method
 * @returns {string}
 */
function requireKey(key, method) {
  if (typeof key !== 'string' || key === '') {
    throw new TypeError(`TaskMemory.${method}(): key must be a non-empty string`)
  }
  return key
}
