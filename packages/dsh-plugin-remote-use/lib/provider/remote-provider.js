/**
 * The remote delegation provider.
 *
 * This is the piece that makes "call another machine like a subagent" true: it
 * implements DSH's `SubagentProvider` seam, so the model sees a normal delegation
 * tool and the service routes the request here. Nothing in DSH is modified.
 *
 * HARD CONSTRAINTS (DESIGN §2.2 — these are code facts, not choices):
 *   C1  `capabilities` must be all false. The service validates the request against
 *       them BEFORE `start()` and rejects anything it cannot honor, so advertising a
 *       capability we do not implement would fail loudly at dispatch.
 *   C2  No `prepareContinuable`. A continuable child is always materialized by the
 *       LOCAL `ctx.agents.create/resume`, so an out-of-process provider cannot
 *       support it. The tool row must therefore use `backgroundMode: one-shot`.
 *   C3  `run.localAgent` must stay `undefined` -> no `subagent/catalog` entry ->
 *       remote runs are invisible to `list_agents`. `TaskRegistry` compensates.
 *   C6  `inheritsParentContext` must be false: the worker cannot see our session.
 *
 * @module dsh-plugin-remote-use/remote-provider
 */

import { NO_START_CAPABILITIES } from './out-of-process-helpers.js'

/** Delegation is refused with this code when the worker's self-check is not green. */
export const GATE_REFUSED = 'REMOTE_WORKER_NOT_READY'

/**
 * @typedef {object} PeerRuntime
 * @property {string} peerId
 * @property {string} name
 * @property {import('../bridge/acp-bridge.js').AcpBridge} bridge
 * @property {() => Promise<object>} selfcheck     returns the gate report
 * @property {string} defaultCwd
 */

export class RemoteProvider {
  /**
   * @param {object} opts
   * @param {PeerRuntime} opts.peer
   * @param {import('../core/task-registry.js').TaskRegistry} opts.registry
   * @param {(req: object) => Promise<{optionId:string, source:string, reason:string, needsHuman:boolean}>} opts.decideApproval
   *        Bound review-engine decision function. MUST implement the cache-miss and
   *        tier-check rules; passing a permissive stub here is the vulnerability
   *        found in DESIGN §10.0.1.
   * @param {number} [opts.serialQueue]  max concurrent tasks per peer (DESIGN §7.3: 1)
   * @param {string} [opts.workspaceRoot]  used by the tier check
   */
  constructor(opts) {
    this.name = `remote-${opts.peer.peerId}`
    /** C1: never advertise what an out-of-process worker cannot honor. */
    this.capabilities = { ...NO_START_CAPABILITIES }
    /** C6: the worker has no access to the delegating session. */
    this.inheritsParentContext = false

    this.peer = opts.peer
    this.registry = opts.registry
    this.decideApproval = opts.decideApproval
    this.serialQueue = opts.serialQueue ?? 1
    this.workspaceRoot = opts.workspaceRoot ?? ''
    /** @type {Array<() => void>} */
    this.waiters = []
    this.running = 0
  }

  /**
   * Establish a remote child. Fulfils only after the worker has accepted the task,
   * so the caller always owns a live run or nothing (the seam's publication rule).
   *
   * @param {object} request  DSH's ResolvedSubagentStartRequest
   * @returns {Promise<{id:string, localAgent:undefined, result:Promise<object>, dispose:() => Promise<void>}>}
   */
  async start(request) {
    const prompt = blocksToText(request.prompt)
    const label = request.label ?? ''
    const cwd = this.peer.defaultCwd

    // Fail early on a bad cwd. DSH's ACP server rejects a non-absolute `cwd` with
    // -32602, and the error surfaces as an opaque turn failure -- better to say what
    // is wrong here, before a session is even created.
    const cwdProblem = assertUsableCwd(cwd)
    if (cwdProblem !== '') {
      const err = new Error(`remote worker "${this.peer.peerId}": ${cwdProblem}`)
      err.code = 'REMOTE_BAD_CWD'
      throw err
    }

    // ---- gate: refuse rather than fail halfway (DESIGN §5.10.6) -------------
    const report = await this.peer.selfcheck()
    const gate = this.#evaluateGate(report)
    if (gate.blocked) {
      // A refusal must surface as a rejected start, so no run is published.
      const err = new Error(gate.message)
      err.code = GATE_REFUSED
      err.details = gate.details
      throw err
    }

    // ---- serial queue: GUI is an exclusive resource (DESIGN §7.3) -----------
    await this.#acquire()

    const task = this.registry.create({ peerId: this.peer.peerId, label, prompt, cwd })
    this.registry.markRunning(task.taskId)

    let disposed = false
    const release = () => { if (!disposed) { disposed = true; this.#release() } }

    // The run's result must NEVER reject: a rejected promise after publication
    // would strand the caller's foreground/background bookkeeping. The catch also
    // settles the registry -- otherwise a bridge failure would leave a phantom
    // "running" task that `remote_agents` keeps reporting forever.
    const result = this.#runTask(task, { prompt, cwd })
      .catch((error) => {
        const diagnostic = error instanceof Error ? error.message : String(error)
        this.registry.settle(task.taskId, { state: 'error', stopReason: 'error', diagnostic })
        return {
          output: [{ type: 'text', text: '' }],
          stopReason: 'error',
          diagnostic,
        }
      })
      .finally(release)

    return {
      id: task.taskId,
      localAgent: undefined,          // C3
      result,
      dispose: async () => {
        // Idempotent as a WHOLE: a second dispose must neither release the queue
        // slot again nor send a second cancel to the worker.
        if (disposed) return
        release()
        try { await this.peer.bridge.cancel() } catch { /* cancellation is best effort */ }
      },
    }
  }

  // NOTE: intentionally no `prepareContinuable` (C2).

  /**
   * Drive the task to a `SubagentResult`.
   * @param {import('../core/task-registry.js').RemoteTask} task
   * @param {{ prompt: string, cwd: string }} input
   */
  async #runTask(task, input) {
    const outcome = await this.peer.bridge.startTask({
      cwd: input.cwd,
      prompt: input.prompt,
      onUpdate: (evt) => {
        if (evt.kind === 'tool_call' && evt.tool !== undefined) {
          this.registry.noteToolCall(task.taskId, evt.tool.toolName ?? '?')
        }
        if (evt.kind === 'usage' && evt.usage !== undefined) {
          this.registry.setUsage(task.taskId, evt.usage)
        }
      },
      onApproval: async (ask) => {
        this.registry.setWaitingForApproval(task.taskId, true)
        try {
          const decision = await this.decideApproval({
            taskId: task.taskId,
            toolCallId: ask.toolCallId,
            toolName: ask.toolName,
            rawInput: ask.rawInput,
          })
          return decision.optionId
        } finally {
          this.registry.setWaitingForApproval(task.taskId, false)
        }
      },
    })

    const state = outcome.stopReason === 'completed' ? 'completed' : outcome.stopReason
    this.registry.settle(task.taskId, {
      state,
      stopReason: outcome.stopReason,
      diagnostic: outcome.diagnostic,
    })

    return {
      output: [{ type: 'text', text: outcome.output ?? '' }],
      ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
      stopReason: outcome.stopReason,
    }
  }

  /**
   * Turn a self-check report into a dispatch decision.
   *
   * `no-interactive-session` is NOT a fault: the worker is healthy but nobody is
   * logged in. The two must produce different diagnostics or operators chase the
   * wrong problem (DESIGN §5.10.6).
   * @param {object} report
   */
  #evaluateGate(report) {
    if (report === null || report === undefined) {
      return { blocked: true, message: 'remote worker did not return a self-check report', details: {} }
    }
    const checks = Array.isArray(report.checks) ? report.checks : []
    const failed = checks.filter((c) => c.severity === 'blocking' && c.status === 'fail')

    const sessionMissing = report.sessionSegment === 'unavailable'
      || checks.some((c) => c.id === 'S8' && c.status === 'unchecked')

    if (sessionMissing) {
      return {
        blocked: true,
        message: 'remote worker has no interactive session: someone must be logged in on it '
          + '(the desktop must be unlocked for input injection to work)',
        details: { reason: 'no-interactive-session', checks: failed.map((c) => c.id) },
      }
    }
    if (failed.length > 0) {
      return {
        blocked: true,
        message: `remote worker is not ready: ${failed.map((c) => `${c.id} ${c.name} (expected ${c.expected}, actual ${c.actual})`).join('; ')}`,
        details: { reason: 'selfcheck-failed', checks: failed.map((c) => c.id) },
      }
    }
    return { blocked: false, message: '', details: {} }
  }

  /** FIFO gate so one worker runs one task at a time. */
  async #acquire() {
    if (this.running < this.serialQueue) { this.running += 1; return }
    await new Promise((resolve) => this.waiters.push(resolve))
    this.running += 1
  }

  #release() {
    this.running = Math.max(0, this.running - 1)
    const next = this.waiters.shift()
    if (next !== undefined) next()
  }
}

/**
 * Flatten DSH content blocks to plain text for the ACP prompt.
 * @param {unknown} blocks
 * @returns {string}
 */
export function blocksToText(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((b) => (b !== null && typeof b === 'object' && typeof (/** @type {any} */ (b).text) === 'string'
      ? /** @type {any} */ (b).text
      : ''))
    .filter((s) => s !== '')
    .join('\n')
}

/**
 * Report why a worker cwd is unusable, or '' when it is fine.
 *
 * The cwd is the worker-side absolute path a task runs in AND the sandbox scope for
 * its writes, so a relative path or an empty value silently binds the task to the
 * relay process's launch directory instead (DESIGN §6.4).
 * @param {string} cwd
 * @returns {string} a human-readable problem, or '' when usable
 */
export function assertUsableCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return 'worker cwd is empty -- set `cwd` to an absolute path that exists on the worker'
  }
  const isWindowsAbs = /^[a-zA-Z]:[\\/]/.test(cwd)
  const isPosixAbs = cwd.startsWith('/')
  if (!isWindowsAbs && !isPosixAbs) {
    return `worker cwd must be an absolute path, got "${cwd}" (a relative path would bind tasks to the relay's launch directory)`
  }
  return ''
}
