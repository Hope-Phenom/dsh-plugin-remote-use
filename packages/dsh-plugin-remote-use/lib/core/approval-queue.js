/**
 * A holding area for approvals the review engine refuses to decide on its own.
 *
 * WHY IT EXISTS: `decideApproval` marks `danger-full-access` (and anything else it cannot
 * justify) as `needsHuman`. Until now that meant an immediate refusal, so a task that
 * genuinely needed a wider scope could never be completed -- there was no way to say yes.
 * This queue turns "needs a human" into "waits for a human, then times out as a refusal".
 *
 * FAIL CLOSED IS THE DEFAULT, NOT AN AFTERTHOUGHT:
 *   * an entry that nobody answers settles as `reject-once` when its budget expires;
 *   * `dispose()` settles everything still pending as `reject-once`, so a plugin unload
 *     cannot leave a request hanging until the bridge's own timeout;
 *   * an unknown or already-settled id is not decidable, and `decide()` reports that
 *     instead of silently succeeding.
 *
 * The budget is deliberately SHORTER than the bridge's `approvalTimeoutMs`: the bridge also
 * races the callback against its own timer, and if that fires first the queue would keep a
 * ghost entry that no human can ever act on. Settling here first means the recorded outcome
 * is always the one the worker actually received.
 */

/** How much earlier than the bridge's timeout this queue gives up. */
export const QUEUE_LEAD_MS = 2_000

/** Settled entries kept for the page's "recent decisions" list. */
const HISTORY_LIMIT = 50

/** How much of a tool call's arguments the page shows. Enough to judge, short of a dump. */
const RAW_INPUT_LIMIT = 400

/** One entry as the PAGE sees it: no resolver, no unbounded payload. */
function publicEntry(entry) {
  return {
    id: entry.id,
    peerId: entry.peerId,
    taskId: entry.taskId,
    toolCallId: entry.toolCallId,
    toolName: entry.toolName,
    requiredTier: entry.requiredTier,
    reason: entry.reason,
    source: entry.source,
    createdAt: entry.createdAt,
    ageMs: entry.ageMs,
    rawInput: entry.rawInput,
  }
}

/** Truncate a tool call's arguments so the page cannot be handed an unbounded blob. */
function summarizeRawInput(rawInput) {
  if (rawInput === undefined || rawInput === null) return ''
  let text
  try {
    text = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput)
  } catch {
    return '(unserialisable)'
  }
  if (text === undefined) return ''
  return text.length > RAW_INPUT_LIMIT ? `${text.slice(0, RAW_INPUT_LIMIT)}…` : text
}

export class ApprovalQueue {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now]
   * @param {number} [opts.timeoutMs] how long one request may wait before it is refused
   * @param {(entry: object) => void} [opts.onSettle] audit hook; called once per entry
   */
  constructor(opts = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(1, Number(opts.timeoutMs)) : 80_000
    this.onSettle = typeof opts.onSettle === 'function' ? opts.onSettle : () => {}
    this.disposed = false
    this.seq = 0
    /** @type {Map<string, object>} entries still waiting, holding their resolvers */
    this.pending = new Map()
    /** @type {object[]} settled outcomes, newest last */
    this.history = []
  }

  /** Entries the page may act on. */
  list() {
    const now = this.now()
    return [...this.pending.values()]
      .map((entry) => publicEntry({ ...entry, ageMs: Math.max(0, now - entry.createdAt) }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Settled outcomes, newest first. */
  recent(limit = 20) {
    return this.history.slice(-Math.max(0, limit)).reverse()
  }

  get pendingCount() {
    return this.pending.size
  }

  /**
   * Hold one approval request open.
   *
   * @param {{ peerId: string, taskId?: string, toolCallId?: string, toolName?: string,
   *           rawInput?: unknown, requiredTier?: string, reason?: string, source?: string }} input
   * @returns {Promise<'allow-once'|'reject-once'>} the option a human chose, or a refusal
   */
  request(input) {
    if (this.disposed) return Promise.resolve('reject-once')

    this.seq += 1
    const id = `ap${this.seq}-${this.now().toString(36)}`
    const entry = {
      id,
      peerId: String(input?.peerId ?? ''),
      taskId: String(input?.taskId ?? ''),
      toolCallId: String(input?.toolCallId ?? ''),
      toolName: String(input?.toolName ?? ''),
      requiredTier: String(input?.requiredTier ?? ''),
      reason: String(input?.reason ?? ''),
      source: String(input?.source ?? ''),
      rawInput: summarizeRawInput(input?.rawInput),
      createdAt: this.now(),
      timer: undefined,
      resolve: undefined,
      settled: false,
    }

    const promise = new Promise((resolve) => {
      entry.resolve = resolve
      entry.timer = setTimeout(() => {
        this.#settle(id, 'reject-once', 'timeout')
      }, this.timeoutMs)
      // Never hold the process open for a request nobody may answer.
      if (typeof entry.timer?.unref === 'function') entry.timer.unref()
    })

    this.pending.set(id, entry)
    return promise
  }

  /**
   * Apply a human decision.
   * @param {string} id
   * @param {'allow'|'deny'} decision
   * @returns {{ ok: boolean, error?: string, optionId?: string }}
   */
  decide(id, decision) {
    if (decision !== 'allow' && decision !== 'deny') {
      return { ok: false, error: `decision must be "allow" or "deny", got ${JSON.stringify(decision)}` }
    }
    if (!this.pending.has(id)) {
      // Not "silently fine": the page is showing a stale entry, or one that timed out
      // between render and click.
      return { ok: false, error: `no pending approval "${id}" (it may have timed out)` }
    }
    const optionId = decision === 'allow' ? 'allow-once' : 'reject-once'
    this.#settle(id, optionId, 'human')
    return { ok: true, optionId }
  }

  /** Settle one entry exactly once, resolve its promise, and audit the outcome. */
  #settle(id, optionId, by) {
    const entry = this.pending.get(id)
    if (entry === undefined || entry.settled) return
    entry.settled = true
    this.pending.delete(id)
    clearTimeout(entry.timer)

    const settledAt = this.now()
    const outcome = {
      id: entry.id,
      peerId: entry.peerId,
      taskId: entry.taskId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      requiredTier: entry.requiredTier,
      source: entry.source,
      reason: entry.reason,
      optionId,
      by,
      createdAt: entry.createdAt,
      settledAt,
      waitedMs: Math.max(0, settledAt - entry.createdAt),
    }
    this.history.push(outcome)
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT)

    // The audit hook must never break the approval path it is observing.
    try {
      this.onSettle(outcome)
    } catch { /* audited elsewhere; a logging failure must not change the decision */ }

    entry.resolve(optionId)
  }

  /** Refuse everything still waiting. Idempotent. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const id of [...this.pending.keys()]) this.#settle(id, 'reject-once', 'disposed')
  }
}
