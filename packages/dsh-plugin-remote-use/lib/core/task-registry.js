/**
 * The host-side registry of remote runs.
 *
 * WHY THIS EXISTS: a remote run has no local child session, so DSH writes no
 * `subagent/catalog` entry for it (DESIGN §2.2 C3). `list_agents` and
 * `listChildren` therefore cannot see remote work at all. This registry is that
 * missing visibility channel: the `remote_agents` tool reads it, and the host
 * injects a summary of it into the model's runtime context so the model does not
 * "forget" what it dispatched.
 *
 * State is in-memory plus an optional JSON snapshot, because a remote run is only
 * meaningful while the process that owns the ACP connection is alive.
 *
 * @module dsh-plugin-remote-use/task-registry
 */

/** Terminal states settle a task; nothing may move it out of them. */
const TERMINAL = new Set(['completed', 'error', 'aborted', 'refusal', 'max-tokens', 'cancelled'])

/**
 * How much of a settled task's answer to keep, in characters.
 *
 * WHY THIS EXISTS AT ALL: without it a background delegation was a dead end — the task ran,
 * the state was visible, and the ANSWER was unreachable, because the registry kept progress
 * metrics and nothing else (PITFALLS F15). A result you cannot read is not a result.
 *
 * WHY IT IS CAPPED: the registry lives for the whole process and holds up to `maxTasks` entries,
 * so retention has to be bounded or a chatty worker grows it without limit. The cap is generous
 * (64k chars is a long report) and truncation is REPORTED rather than silent, so a reader can
 * tell "this is all of it" from "this is the first 64k".
 */
export const OUTPUT_LIMIT = 64_000

/**
 * @typedef {object} RemoteTask
 * @property {string} taskId
 * @property {string} peerId
 * @property {string} label                 short human label from the delegation call
 * @property {string} promptDigest          first N chars of the prompt, for display
 * @property {string} cwd
 * @property {string} state                 queued | running | <terminal>
 * @property {number} startedAt
 * @property {number} [endedAt]
 * @property {string} [stopReason]
 * @property {string} [diagnostic]
 * @property {number} toolCallCount
 * @property {string[]} recentTools         last few tool names, for at-a-glance status
 * @property {boolean} waitingForApproval
 * @property {{used:number,size:number}} [usage]
 * @property {string} [output]              the worker's answer, capped at OUTPUT_LIMIT
 * @property {number} [outputChars]         the answer's full length before capping
 */

/** @returns {string} a short, sortable, unique-enough task id */
function makeTaskId() {
  const t = Date.now().toString(36)
  const r = Math.floor(Math.random() * 0x10000).toString(36).padStart(3, '0')
  return `rtask_${t}_${r}`
}

export class TaskRegistry {
  /** @param {{ maxTasks?: number, snapshotPath?: string, now?: () => number }} [opts] */
  constructor(opts = {}) {
    this.maxTasks = opts.maxTasks ?? 200
    this.snapshotPath = opts.snapshotPath ?? ''
    /** @type {Map<string, RemoteTask>} */
    this.tasks = new Map()
    this.now = opts.now ?? (() => Date.now())
    this.seq = 0
  }

  /**
   * Create a task in the `queued` state.
   * @param {{ peerId: string, label?: string, prompt: string, cwd: string }} input
   * @returns {RemoteTask}
   */
  create(input) {
    this.#evict()
    const task = {
      taskId: makeTaskId(),
      peerId: input.peerId,
      label: input.label ?? '',
      promptDigest: (input.prompt ?? '').slice(0, 160),
      cwd: input.cwd ?? '',
      state: 'queued',
      startedAt: this.now(),
      toolCallCount: 0,
      recentTools: [],
      waitingForApproval: false,
    }
    this.tasks.set(task.taskId, task)
    return task
  }

  /** @param {string} taskId */
  get(taskId) {
    return this.tasks.get(taskId)
  }

  /** Mark a task as actually started (the worker accepted it). */
  markRunning(taskId) {
    const t = this.tasks.get(taskId)
    if (t !== undefined && !TERMINAL.has(t.state)) t.state = 'running'
    return t
  }

  /**
   * Record one observed tool call.
   * @param {string} taskId
   * @param {string} toolName
   */
  noteToolCall(taskId, toolName) {
    const t = this.tasks.get(taskId)
    if (t === undefined) return
    t.toolCallCount += 1
    t.recentTools.push(toolName)
    if (t.recentTools.length > 5) t.recentTools.shift()
  }

  /** @param {string} taskId */
  setWaitingForApproval(taskId, waiting) {
    const t = this.tasks.get(taskId)
    if (t !== undefined) t.waitingForApproval = waiting === true
  }

  /** @param {string} taskId */
  setUsage(taskId, usage) {
    const t = this.tasks.get(taskId)
    if (t !== undefined && usage !== undefined) t.usage = usage
  }

  /**
   * Settle a task. The first settlement wins — a late ACP event must not reopen
   * a finished task.
   *
   * `final.output` is the worker's answer text. It is the ONLY thing that makes a background
   * delegation useful after the fact, so it is retained here rather than only being handed
   * back through the provider's result promise (which a background caller has already
   * stopped awaiting).
   *
   * @param {string} taskId
   * @param {{ state: string, stopReason?: string, diagnostic?: string, output?: string }} final
   */
  settle(taskId, final) {
    const t = this.tasks.get(taskId)
    if (t === undefined) return t
    if (TERMINAL.has(t.state)) return t
    t.state = TERMINAL.has(final.state) ? final.state : 'error'
    t.stopReason = final.stopReason ?? t.state
    if (final.diagnostic !== undefined) t.diagnostic = final.diagnostic
    if (typeof final.output === 'string' && final.output !== '') {
      t.output = final.output.length > OUTPUT_LIMIT ? final.output.slice(0, OUTPUT_LIMIT) : final.output
      t.outputChars = final.output.length
    }
    t.endedAt = this.now()
    t.waitingForApproval = false
    return t
  }

  /** @returns {RemoteTask[]} newest first */
  list() {
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  /**
   * Tasks as the settings page needs them: state and progress, WITHOUT the answer text.
   *
   * The page polls its route on a timer and renders a five-column table. Sending every retained
   * answer with every poll would put megabytes on the wire for data nothing draws, so the bulky
   * field is dropped here rather than at the route (which would have to know the field's name).
   * The model still reads answers through `remote_agents`, straight off the registry.
   *
   * @param {number} [limit]  how many tasks to return, newest first
   * @returns {object[]}
   */
  listForUi(limit = 50) {
    return this.list().slice(0, limit).map((t) => ({
      taskId: t.taskId,
      peerId: t.peerId,
      label: t.label,
      promptDigest: t.promptDigest,
      cwd: t.cwd,
      state: t.state,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      stopReason: t.stopReason,
      diagnostic: t.diagnostic,
      toolCallCount: t.toolCallCount,
      recentTools: t.recentTools,
      waitingForApproval: t.waitingForApproval,
      usage: t.usage,
      // Not the answer itself, but its size: the page can say "this run produced something"
      // without shipping it.
      outputChars: t.outputChars,
    }))
  }

  /** @param {string} [peerId] */
  listByPeer(peerId) {
    return this.list().filter((t) => peerId === undefined || t.peerId === peerId)
  }

  /** Running or queued tasks — what the model needs to remember. */
  active() {
    return this.list().filter((t) => !TERMINAL.has(t.state))
  }

  /** @returns {number} count of active tasks for a peer (used for the serial queue) */
  activeCountForPeer(peerId) {
    return this.active().filter((t) => t.peerId === peerId).length
  }

  /**
   * A compact multi-line summary for runtime-context injection. Returns '' when
   * there is nothing to report, so callers can skip injecting an empty section.
   */
  summary() {
    const act = this.active()
    if (act.length === 0) return ''
    const lines = act.map((t) => {
      const age = Math.round((this.now() - t.startedAt) / 1000)
      const tools = t.recentTools.length === 0 ? '' : ` tools=[${t.recentTools.join(',')}]`
      const wait = t.waitingForApproval ? ' WAITING-FOR-APPROVAL' : ''
      return `- ${t.taskId} peer=${t.peerId} state=${t.state} ${age}s tools=${t.toolCallCount}${tools}${wait}${t.label === '' ? '' : ` label="${t.label}"`}`
    })
    return [`Remote tasks in flight (${act.length}):`, ...lines].join('\n')
  }

  /** Drop the oldest settled tasks once the cap is exceeded. */
  #evict() {
    if (this.tasks.size < this.maxTasks) return
    const settled = this.list().filter((t) => TERMINAL.has(t.state)).reverse()
    while (this.tasks.size >= this.maxTasks && settled.length > 0) {
      const victim = settled.shift()
      if (victim !== undefined) this.tasks.delete(victim.taskId)
    }
  }
}
