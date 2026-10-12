/**
 * Model-facing tools for remote work.
 *
 * WHY THESE EXIST (DESIGN §2.2 C3/C4):
 *   - A remote run has no local child session, so `list_agents` and `wait_agent`
 *     cannot see it, and `send_message`/`interrupt_agent` are dead for it (they go
 *     through an Activation the remote run does not have). The official control
 *     tools therefore give the model no way to observe or stop remote work.
 *   - These three tools close that gap. They are the reason a remote delegation
 *     feels like a subagent rather than a fire-and-forget RPC.
 *
 * Deliberately NOT provided: `remote_send_message`. The subagent provider seam
 * cannot support continuable children (C2), so there is nothing to continue.
 *
 * @module dsh-plugin-remote-use/remote-tools
 */

/**
 * One tool definition, shaped per DSH's verified registration contract:
 * `output` is REQUIRED and holds `render`; `parameters` is loose JSON Schema.
 *
 * @typedef {object} ToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} parameters
 * @property {{ schema: unknown, render: (args: unknown, result: unknown) => unknown[] }} output
 * @property {(args: any, exec: { signal?: AbortSignal }) => Promise<unknown>} execute
 * @property {string} [group]
 */

/**
 * Build the remote-control tool set.
 *
 * @param {object} deps
 * @param {import('./task-registry.js').TaskRegistry} deps.registry
 * @param {Map<string, {peerId:string, name:string, bridge:any, selfcheck:() => Promise<object>, defaultCwd:string}>} deps.peers
 * @returns {ToolDefinition[]}
 */
export function makeRemoteTools(deps) {
  const { registry, peers } = deps

  /** @type {ToolDefinition} */
  const remoteAgents = {
    name: 'remote_agents',
    group: 'remote',
    description:
      'Inspect work delegated to paired LAN workers. A remote task has no local child session, '
      + 'so it never appears in `list_agents` — use this instead.\n'
      + 'action="list": every paired worker and its in-flight tasks.\n'
      + 'action="status": one task by taskId (state, elapsed, tool calls, whether it is waiting for approval).\n'
      + 'action="wait": block until a task settles, then report its outcome.\n'
      + 'Remote tasks cannot be continued: there is no `remote_send_message`. Delegate a fresh task instead.',
    parameters: {
      action: { type: 'string', required: true, description: 'list | status | wait' },
      taskId: { type: 'string', description: 'Required for status and wait.' },
      peerId: { type: 'string', description: 'Optional filter for list.' },
      timeoutMs: { type: 'number', description: 'For wait: give up after this many ms (default 120000).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: String(result ?? '') }],
    },
    async execute(args, exec) {
      const action = String(args?.action ?? '')
      if (action === 'list') return renderPeerList(peers, registry, args?.peerId)
      if (action === 'status') {
        if (typeof args?.taskId !== 'string') return 'remote_agents status: taskId is required'
        return renderTaskDetail(registry.get(args.taskId))
      }
      if (action === 'wait') {
        if (typeof args?.taskId !== 'string') return 'remote_agents wait: taskId is required'
        return await waitForTask(registry, args.taskId, Number(args?.timeoutMs ?? 120_000), exec?.signal)
      }
      return `remote_agents: unknown action "${action}" (expected list | status | wait)`
    },
  }

  /** @type {ToolDefinition} */
  const remoteInterrupt = {
    name: 'remote_interrupt',
    group: 'remote',
    description:
      'Stop a task running on a paired LAN worker. `interrupt_agent` does not work for remote tasks '
      + '(they have no local Activation), so use this instead. Cancellation is cooperative and not '
      + 'instant: the worker must reach a quiescent point before the task settles as aborted.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'The remote task to stop.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: String(result ?? '') }],
    },
    async execute(args) {
      const task = registry.get(String(args?.taskId ?? ''))
      if (task === undefined) return `remote_interrupt: no such task "${args?.taskId}"`
      const peer = peers.get(task.peerId)
      if (peer === undefined) return `remote_interrupt: worker "${task.peerId}" is not connected`
      try {
        await peer.bridge.cancel()
        return `remote_interrupt: cancellation sent for ${task.taskId} (worker ${task.peerId}). `
          + 'It settles as aborted once the worker reaches a quiescent point.'
      } catch (error) {
        return `remote_interrupt: failed to cancel ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }

  /** @type {ToolDefinition} */
  const remoteSelfcheck = {
    name: 'remote_selfcheck',
    group: 'remote',
    description:
      'Ask a paired LAN worker whether it is currently able to run GUI tasks. Use this after a '
      + 'delegation is refused, or before delegating something that needs the desktop.\n'
      + 'Blocking findings (`S1`-`S8`, `S9`, `S12`, `S14`, `S15`) prevent dispatch. '
      + '`no-interactive-session` means the worker is healthy but nobody is logged in on it — that is an '
      + 'operational state, not a fault, and it cannot be fixed from here.',
    parameters: {
      peerId: { type: 'string', description: 'Worker to check. Omit to check every paired worker.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: String(result ?? '') }],
    },
    async execute(args) {
      const wanted = typeof args?.peerId === 'string' && args.peerId !== ''
        ? [peers.get(args.peerId)].filter(Boolean)
        : [...peers.values()]
      if (wanted.length === 0) return 'remote_selfcheck: no paired workers'
      const out = []
      for (const peer of wanted) {
        try {
          out.push(renderSelfcheck(peer.name, await peer.selfcheck()))
        } catch (error) {
          out.push(`${peer.name}: self-check failed to run: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return out.join('\n\n')
    },
  }

  return [remoteAgents, remoteInterrupt, remoteSelfcheck]
}

/**
 * @param {Map<string, any>} peers
 * @param {import('./task-registry.js').TaskRegistry} registry
 * @param {string} [peerId]
 */
export function renderPeerList(peers, registry, peerId) {
  if (peers.size === 0) return 'No paired LAN workers. Pair one in the plugin settings page.'
  const lines = []
  for (const peer of peers.values()) {
    if (peerId !== undefined && peer.peerId !== peerId) continue
    const tasks = registry.listByPeer(peer.peerId)
    const active = tasks.filter((t) => !isSettled(t.state))
    lines.push(`${peer.name} (${peer.peerId})  active=${active.length} total=${tasks.length}  cwd=${peer.defaultCwd}`)
    for (const t of tasks.slice(0, 10)) {
      lines.push('  ' + renderTaskLine(t))
    }
    if (tasks.length > 10) lines.push(`  ... and ${tasks.length - 10} more`)
  }
  return lines.length === 0 ? `No worker with peerId "${peerId}".` : lines.join('\n')
}

/** @param {import('./task-registry.js').RemoteTask | undefined} task */
export function renderTaskDetail(task) {
  if (task === undefined) return 'No such remote task. Use remote_agents action="list" to see task ids.'
  const lines = [
    `taskId      : ${task.taskId}`,
    `worker      : ${task.peerId}`,
    `state       : ${task.state}${isSettled(task.state) ? '' : ' (running)'}`,
    `label       : ${task.label || '(none)'}`,
    `cwd         : ${task.cwd}`,
    `elapsed     : ${Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000)}s`,
    `tool calls  : ${task.toolCallCount}${task.recentTools.length === 0 ? '' : ` (recent: ${task.recentTools.join(', ')})`}`,
  ]
  if (task.waitingForApproval) lines.push('waiting     : for approval on the master')
  if (task.stopReason !== undefined) lines.push(`stopReason  : ${task.stopReason}`)
  if (task.diagnostic !== undefined) lines.push(`diagnostic  : ${task.diagnostic}`)
  if (task.usage !== undefined) lines.push(`tokens used : ${task.usage.used}`)
  if (task.promptDigest !== '') lines.push(`prompt      : ${task.promptDigest}${task.promptDigest.length >= 160 ? '…' : ''}`)
  return lines.join('\n')
}

/**
 * Block until a task settles.
 * @param {import('./task-registry.js').TaskRegistry} registry
 * @param {string} taskId
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 */
export async function waitForTask(registry, taskId, timeoutMs, signal) {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    const task = registry.get(taskId)
    if (task === undefined) return `remote_agents wait: no such task "${taskId}"`
    if (isSettled(task.state)) {
      return `Remote task settled.\n${renderTaskDetail(task)}`
    }
    if (Date.now() >= deadline) {
      return `remote_agents wait: timed out after ${timeoutMs}ms; the task is still ${task.state}.\n${renderTaskDetail(task)}`
    }
    if (signal?.aborted === true) return `remote_agents wait: aborted by caller.\n${renderTaskDetail(task)}`
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** @param {string} peerName */
export function renderSelfcheck(peerName, report) {
  if (report === null || report === undefined) return `${peerName}: no self-check report`
  const checks = Array.isArray(report.checks) ? report.checks : []
  const bad = checks.filter((c) => c.status === 'fail' || c.status === 'warn')
  const head = `${peerName}: verdict=${report.verdict ?? '?'} blocking=${report.blockingFailures ?? '?'} warn=${report.warnings ?? '?'} unchecked=${report.unchecked ?? '?'}`
  const lines = [head]

  // The missing-session note must ALWAYS print -- it is the difference between
  // "the worker is broken" and "nobody is logged in", which are fixed by different
  // people. Reporting it only when a check also fails would hide the common case.
  if (report.sessionSegment === 'unavailable') {
    lines.push('  NOTE: no interactive session on the worker -- someone must be logged in on it,')
    lines.push('        with the desktop unlocked, before GUI tasks can run. This is not a fault.')
  }

  if (bad.length === 0) {
    if (report.unchecked > 0 && report.sessionSegment !== 'unavailable') {
      lines.push(`  ${report.unchecked} check(s) could not run in the worker's current session.`)
    }
    return lines.join('\n')
  }
  for (const c of bad) {
    lines.push(`  [${c.status.toUpperCase()}] ${c.id} ${c.name}`)
    lines.push(`        expected: ${c.expected}`)
    lines.push(`        actual  : ${c.actual}`)
    if (typeof c.fix === 'string' && c.fix !== '' && c.fix !== '-') lines.push(`        fix     : ${c.fix}`)
  }
  return lines.join('\n')
}

function isSettled(state) {
  return state === 'completed' || state === 'error' || state === 'aborted'
    || state === 'refusal' || state === 'max-tokens' || state === 'cancelled'
}

/** @param {import('./task-registry.js').RemoteTask} t */
function renderTaskLine(t) {
  const age = Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 1000)
  const wait = t.waitingForApproval ? ' [awaiting approval]' : ''
  return `${t.taskId}  ${t.state}  ${age}s  tools=${t.toolCallCount}${wait}  ${t.label || t.promptDigest.slice(0, 40)}`
}
