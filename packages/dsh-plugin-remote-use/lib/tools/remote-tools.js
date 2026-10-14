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
 *   - `remote_subagent` (added later, PITFALLS F11) is the delegation entry point itself.
 *     It has to live here rather than in a profile patch's `dsh-tool-subagent` row, because a
 *     Web session's tool catalog comes from the agent preset, not the loader tree.
 *
 * Deliberately NOT provided: `remote_send_message`. The subagent provider seam
 * cannot support continuable children (C2), so there is nothing to continue.
 *
 * @module dsh-plugin-remote-use/remote-tools
 */

import { blocksToText } from '../provider/remote-provider.js'

/**
 * Build an object-rooted JSON Schema from a field map.
 *
 * WHY THIS IS HAND-ROLLED INSTEAD OF USING `defineTool`:
 *
 * `defineTool` from `@deepseek-ai/dsh-tools` exists to perform exactly this conversion
 * (`const parameters = parameterSchemaSpecToJsonSchema(options.parameters)`), but a
 * third-party plugin cannot rely on importing `@deepseek-ai/*` here: the profile's
 * `node_modules/@deepseek-ai/...` entries are dangling junctions left by an old npm
 * install, and Node resolves a linked package through its real path, so the import
 * fails. Confirmed empirically — `@deepseek-ai/schemastery` is not importable either.
 *
 * `ctx.tools.register()` does NOT convert parameters; it validates only `output` and
 * stores the definition verbatim. So registering the author shorthand unconverted hands
 * the model a schema with no root type, and EVERY call fails with:
 *
 *   Invalid schema for function 'remote_agents':
 *   schema must be a JSON Schema of 'type: "object"', got 'type: null'.
 *
 * The mapping mirrors `parameterSchemaSpecToJsonSchema`: a field's `required: true`
 * moves its NAME into the root `required` array and is stripped from the property (it is
 * not a JSON Schema property keyword). `required` is omitted entirely when empty, exactly
 * as the official converter does.
 *
 * @param {Record<string, { required?: boolean, [k: string]: unknown }>} fields
 * @returns {{ type: 'object', properties: Record<string, unknown>, required?: string[] }}
 */
export function objectSchema(fields) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(fields ?? {})) {
    const { required: isRequired, ...rest } = spec ?? {}
    properties[name] = rest
    if (isRequired === true) required.push(name)
  }
  return required.length === 0
    ? { type: 'object', properties }
    : { type: 'object', properties, required }
}

/**
 * One tool definition, shaped per DSH's verified registration contract:
 * `output` is REQUIRED and holds `render`; `parameters` must already be a COMPLETE
 * JSON Schema (see objectSchema above) because nothing downstream converts it.
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
      + 'action="status": one task by taskId — state, elapsed, tool calls, whether it is waiting for '
      + 'approval, and, once the task has settled, the full answer text it produced.\n'
      + 'action="wait": block until a task settles, then report its outcome (same detail as status).\n'
      + 'This is how a background delegation\'s answer is collected: `remote_subagent` returns only a '
      + 'task id, and the text arrives here after the task settles.\n'
      + 'Remote tasks cannot be continued: there is no `remote_send_message`. Delegate a fresh task instead.',
    parameters: objectSchema({
      action: { type: 'string', required: true, description: 'list | status | wait' },
      taskId: { type: 'string', description: 'Required for status and wait.' },
      peerId: { type: 'string', description: 'Optional filter for list.' },
      timeoutMs: { type: 'number', description: 'For wait: give up after this many ms (default 120000).' },
    }),
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
    parameters: objectSchema({
      taskId: { type: 'string', required: true, description: 'The remote task to stop.' },
    }),
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
    parameters: objectSchema({
      peerId: { type: 'string', description: 'Worker to check. Omit to check every paired worker.' },
    }),
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

  /**
   * Capture the worker's desktop.
   *
   * The return value is a path, not the picture: the model reaches the image with its own
   * `read_image` on that path. That split is deliberate -- the picture never has to travel
   * through the ACP message pump, which exists for small control frames, and it works even
   * though the worker's own model may be unable to inspect images.
   */
  const remoteScreenshot = {
    name: 'remote_screenshot',
    group: 'remote',
    description:
      'Capture the screen of a paired LAN worker and save it locally.\n'
      + 'IMPORTANT: the tool returns a FILE PATH, not the picture. Call `read_image` on that path '
      + 'to actually look at the worker\'s screen; without that step you have only a filename.\n'
      + 'Use this to see what a GUI task did, to debug a failed visual assertion, or before '
      + 'deciding whether a task that needs the desktop is worth delegating.\n'
      + 'The capture covers the whole virtual desktop, so on a multi-monitor worker the frame '
      + 'includes every display plus any uncovered area (which renders black). The worker-side '
      + 'console is hidden by the relay so it does not appear in the frame.',
    parameters: objectSchema({
      peerId: { type: 'string', description: 'Worker to capture. Omit when only one worker is paired.' },
      fresh: {
        type: 'boolean',
        description: 'Force a new capture. Defaults to true; pass false to reuse the relay\'s last frame.',
      },
    }),
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: String(result ?? '') }],
    },
    async execute(args) {
      const wanted = typeof args?.peerId === 'string' && args.peerId !== ''
        ? peers.get(args.peerId)
        : [...peers.values()][0]
      if (wanted === undefined) {
        return typeof args?.peerId === 'string' && args.peerId !== ''
          ? `remote_screenshot: no worker with peerId "${args.peerId}"`
          : 'remote_screenshot: no paired workers'
      }
      if (wanted.connection?.screenshot === undefined) {
        return `remote_screenshot: worker "${wanted.peerId}" has no screenshot channel`
      }
      try {
        const shot = await wanted.connection.screenshot({ fresh: args?.fresh !== false })
        const lines = [
          `Captured ${wanted.name} at ${shot.capturedAt || 'now'} in ${shot.elapsedMs}ms.`,
          `File: ${shot.localPath}`,
        ]
        if (shot.width > 0) lines.push(`Virtual desktop: ${shot.width}x${shot.height} across ${shot.displays} display(s).`)
        lines.push(`Size: ${shot.bytes} bytes.`)
        lines.push('')
        lines.push(`Next: call read_image with file_path "${shot.localPath}" to see it.`)
        return lines.join('\n')
      } catch (error) {
        return `remote_screenshot failed for "${wanted.peerId}": ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }

  /**
   * Delegate a task to a paired worker.
   *
   * WHY THE PLUGIN PROVIDES THIS ITSELF (PITFALLS F11):
   *
   * The obvious design is a `dsh-tool-subagent` loader row in the profile patch, one per worker,
   * with `provider: remote-<id>`. That is what DESIGN.md originally specified, and it does compose
   * correctly -- `dsh --dump-config` shows the row in the tree. **The model still never sees it.**
   *
   * A Web session's model-facing tool catalog is enumerated by the AGENT PRESET, not by the loader
   * tree: `preset-standard.plugins` lists the tool rows that agent gets, and it lists its own four
   * `dsh-tool-subagent` rows (`subagent`, `subagent_fork`, `subagent_codex`, `subagent_claude_code`)
   * -- not ours. A row outside that list mounts nothing for the agent.
   *
   * Registering through `ctx.tools.register()` is the other route, and the tools package documents it
   * as sufficient: "registering a tool is enough to make it visible -- the registry automatically
   * feeds its schema into system-prompt assembly". The plugin's other four tools already work that
   * way, which is the empirical proof.
   *
   * So this tool exists to close the gap, and it costs almost nothing: `RemoteProvider.start()`
   * already owns the readiness gate, the serial queue, the TaskRegistry entry and result settling,
   * and `remote_agents` already reads that registry. This file only builds the request and renders
   * the answer.
   */
  const remoteSubagent = {
    name: 'remote_subagent',
    group: 'remote',
    description:
      'Delegate a task to a paired LAN worker and drive it like a subagent.\n'
      + 'Use this instead of `subagent` when the work needs a real desktop on ANOTHER machine: GUI '
      + 'automation, launching and driving an application, confirming what an interface shows. Do all '
      + 'code editing, builds and repository work HERE; delegate only what needs that desktop.\n'
      + 'The worker cannot see this workspace, so anything written there does not come back.\n'
      + 'The worker must pass its readiness check first; a worker that fails is refused rather than '
      + 'half-run, so call `remote_selfcheck` if a delegation is refused.\n'
      + 'Set `run_in_background: true` to keep working instead of waiting for the answer; read it '
      + 'afterwards with `remote_agents action="status"`, and stop the task with `remote_interrupt`.\n'
      + 'One worker runs one task at a time, because the desktop is exclusive. A worker that is already '
      + 'busy does NOT accept this call straight away: even in background mode the call first waits for '
      + 'its turn in that worker\'s queue, so it can take as long as the task ahead of it. Check '
      + '`remote_agents action="list"` before delegating to a busy worker.\n'
      + 'A remote task CANNOT be continued: there is no `remote_send_message`. Delegate a fresh task '
      + 'instead of trying to reply to one.',
    parameters: objectSchema({
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task for the worker.' },
      description: { type: 'string', description: 'Short label for this delegation, shown in remote_agents.' },
      peerId: { type: 'string', description: 'Worker to use. Omit when only one is paired.' },
      run_in_background: {
        type: 'boolean',
        description: 'Do not wait for the answer. The call still performs the readiness check and waits '
          + 'for the worker\'s queue slot before returning a task id. Defaults to false (foreground).',
      },
    }),
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: String(result ?? '') }],
    },
    async execute(args) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt === '') return 'remote_subagent: prompt is required'

      const wanted = typeof args?.peerId === 'string' && args.peerId !== ''
        ? peers.get(args.peerId)
        : [...peers.values()][0]
      if (wanted === undefined) {
        return typeof args?.peerId === 'string' && args.peerId !== ''
          ? `remote_subagent: no worker with peerId "${args.peerId}"`
          : 'remote_subagent: no paired workers. Pair one in the plugin settings page.'
      }
      if (wanted.provider === undefined) {
        // The provider is attached when the worker is wired. Absent means wiring has not finished
        // (or this worker was just reconfigured), not that the worker is unusable.
        return `remote_subagent: worker "${wanted.peerId}" is not ready to accept a delegation yet; check Settings -> Remote work nodes.`
      }

      const label = typeof args?.description === 'string' ? args.description : ''
      let run
      try {
        run = await wanted.provider.start({ prompt, label })
      } catch (error) {
        const code = error?.code === undefined ? '' : ` [${error.code}]`
        return `remote_subagent: delegation to "${wanted.peerId}" was refused${code}: ${error instanceof Error ? error.message : String(error)}`
      }

      if (args?.run_in_background === true) {
        return [
          `Delegated to ${wanted.name} in the background.`,
          `taskId: ${run.id}`,
          '',
          `Read the answer once it settles: remote_agents action="status" taskId="${run.id}"`,
          `Or block for it: remote_agents action="wait" taskId="${run.id}"`,
          `Stop it with remote_interrupt taskId="${run.id}".`,
          'This task cannot be continued once it settles; delegate a fresh one.',
        ].join('\n')
      }

      // Foreground: the provider's result never rejects -- a rejected promise after publication
      // would strand the caller's bookkeeping -- so a failure arrives as stopReason/diagnostic.
      const settled = await run.result
      const text = blocksToText(settled?.output).trim()
      const lines = [`Remote task ${run.id} on ${wanted.name}: ${settled?.stopReason ?? 'unknown'}`]
      if (settled?.diagnostic !== undefined && settled.diagnostic !== '') {
        lines.push(`diagnostic: ${settled.diagnostic}`)
      }
      lines.push('')
      lines.push(text === '' ? '(the worker produced no text)' : text)
      return lines.join('\n')
    },
  }

  return [remoteAgents, remoteInterrupt, remoteSelfcheck, remoteScreenshot, remoteSubagent]
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
  lines.push(...renderOutputSection(task))
  return lines.join('\n')
}

/**
 * The answer a settled task produced, as a labelled section.
 *
 * WHY THIS IS THE POINT OF THE TOOL: a background delegation used to report only progress
 * metrics, so its answer was unreachable and the delegation was a dead end (PITFALLS F15).
 * The section is explicit about which of the three situations it is in — an answer, a
 * truncated answer, or no answer at all — because a bare blank after the header reads as a
 * rendering bug rather than as "the worker said nothing".
 *
 * @param {import('./task-registry.js').RemoteTask} task
 * @returns {string[]}
 */
function renderOutputSection(task) {
  if (!isSettled(task.state)) return []
  if (typeof task.output !== 'string' || task.output === '') {
    // A running task has no answer yet; a settled one with nothing to say must say so.
    return ['', task.state === 'completed' ? 'output      : (the worker produced no text)' : 'output      : (none)']
  }
  const total = task.outputChars ?? task.output.length
  const truncated = total > task.output.length
  const heading = truncated
    ? `--- output (first ${task.output.length} of ${total} chars) ---`
    : '--- output ---'
  return ['', heading, task.output]
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
