/**
 * Host half of dsh-plugin-remote-use.
 *
 * Assembles the pieces that let the master drive a paired LAN worker as if it were
 * a subagent:
 *
 *   model --> tool `subagent_remote`  (a normal `dsh-tool-subagent` row)
 *               --> RemoteProvider    (implements DSH's SubagentProvider seam)
 *                     --> AcpBridge   (ACP over WebSocket)
 *                           --> worker relay --> worker `dsh --profile acp`
 *
 * NOTHING IN DSH IS MODIFIED: the seam is the published `ctx.subagents` provider
 * registry, and the control tools are ordinary `ctx.tools` registrations.
 *
 * CONFIG MUST BE SCHEMASTERY, NOT ZOD: dsh-app-boot only recognises a Config whose
 * schema carries `Symbol.for("schemastery") === true`; a zod schema makes the
 * package report `status: "unsupported"` to `Config.listConfigs`, so the Settings
 * page cannot render its form (DESIGN §12.2).
 *
 * @module dsh-plugin-remote-use
 */

import z from '@deepseek-ai/schemastery'
import { AcpBridge } from './bridge/acp-bridge.js'
import { TaskRegistry } from './core/task-registry.js'
import { ToolCallCache } from './core/toolcall-cache.js'
import { TaskMemory } from './core/task-memory.js'
import { decideApproval, inferRequiredTier } from './core/review-engine.js'
import { RemoteProvider } from './provider/remote-provider.js'
import { limitDiagnostic, verifyAgainstUpstream } from './provider/out-of-process-helpers.js'
import { makeRemoteTools } from './tools/remote-tools.js'

export const name = 'dsh-plugin-remote-use'

/** Optional services: stay inert in profiles that lack them. */
export const inject = ['subagents', 'tools', 'systemPrompt']

/**
 * Plugin configuration.
 *
 * A worker entry needs the relay's address and shared secret. `cwd` is the worker-side
 * absolute path a task runs in — it must exist on the worker and is also what the
 * sandbox scopes writes to.
 */
export const Config = z.object({
  workers: z.array(z.object({
    id: z.string().required(),
    name: z.string().default(''),
    url: z.string().required(),
    token: z.string().default(''),
    cwd: z.string().required(),
    enabled: z.boolean().default(true),
    /** Per-worker serial concurrency. GUI is an exclusive resource: 1. */
    serialQueue: z.number().default(1),
  })).default([]),
  approvalTimeoutMs: z.number().default(90_000),
  /** Tier a task needs unless the delegation narrows it. */
  requiredTier: z.string().default('workspace-write'),
  /** Prefix a remote tool's name; one row per worker uses `<toolPrefix>` + worker id. */
  toolPrefix: z.string().default('subagent_remote'),
  injectTaskSummary: z.boolean().default(true),
})

/**
 * Plugin body.
 *
 * Every registration goes through `ctx.effect`/`ctx.on` so disabling the plugin
 * releases all of it, including the subagent providers and the tool rows.
 *
 * @param {object} ctx
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  const log = makeLogger(ctx)
  const cfg = normalizeConfig(config)
  const registry = new TaskRegistry({})

  // A single shared cache keyed by `${workerId}:${toolCallId}`; approvals arrive with
  // only a tool call id, so this is the ONLY source of a tool's name and arguments
  // (DESIGN §10.0.1).
  const cache = new ToolCallCache({ maxEntries: 1024 })
  /** @type {Map<string, TaskMemory>} */
  const memories = new Map()
  /** @type {Map<string, object>} */
  const peers = new Map()

  // Validate our frozen capability mirror against the live package. A mismatch means
  // DSH changed the contract and our advertisement is no longer honest.
  void verifyAgainstUpstream().then((r) => {
    if (!r.ok) {
      log.error('capability mirror does not match @deepseek-ai/dsh-subagent: ' + (r.reason ?? 'unknown')
        + ' -- refusing to advertise capabilities until this is reconciled')
    } else if (r.reason !== undefined) {
      log.info('capability mirror not verified: ' + r.reason)
    }
  })

  // ---- per-worker wiring -------------------------------------------------
  for (const worker of cfg.workers) {
    if (!worker.enabled) continue
    const peerId = worker.id
    const bridge = new AcpBridge({
      url: worker.url,
      token: worker.token,
      approvalTimeoutMs: cfg.approvalTimeoutMs,
      // Explicit mapping rather than passing the event payload straight through: the
      // cache's contract keys off `title` (which IS the tool name in DSH), and a shape
      // mismatch here would silently cache `toolName: undefined`, which in turn makes
      // `allowedTools` never match and leaves the audit trail without a tool name.
      onUpdate: (evt) => {
        if (evt.tool === undefined) return
        const entry = { title: evt.tool.toolName, rawInput: evt.tool.rawInput, status: evt.tool.status }
        if (evt.kind === 'tool_call') cache.note(evt.tool.toolCallId, entry)
        else if (evt.kind === 'tool_call_update') cache.update(evt.tool.toolCallId, entry)
      },
      // Constructor-level fallback. `RemoteProvider` passes a per-task decider to
      // `startTask`, and that one wins when present; this keeps the bridge honest if
      // some other caller uses it without one (fail closed either way).
      onApproval: makeApprovalDecider({ cfg, worker, memories, log }),
    })

    const workerRuntime = {
      peerId,
      name: worker.name === '' ? peerId : worker.name,
      bridge,
      defaultCwd: worker.cwd,
      /**
       * Ask the worker for a fresh readiness report. Falls back to a synthesised
       * "unreachable" report so the gate refuses instead of letting dispatch through.
       */
      async selfcheck() {
        try {
          return await bridge.selfcheck()
        } catch (error) {
          return {
            verdict: 'blocked',
            sessionSegment: 'unavailable',
            blockingFailures: 1,
            warnings: 0,
            unchecked: 0,
            checks: [{
              id: 'S0', name: 'worker reachable', severity: 'blocking', status: 'fail',
              expected: 'relay responds', actual: limitDiagnostic(error instanceof Error ? error.message : String(error)),
              fix: 'check the worker is powered on, the relay is running, and the token matches',
            }],
          }
        }
      },
    }
    peers.set(peerId, workerRuntime)

    ctx.effect(() => {
      const decider = makeApprovalDecider({ cfg, worker, memories, log })
      const provider = new RemoteProvider({
        peer: workerRuntime,
        registry,
        decideApproval: decider,
        serialQueue: worker.serialQueue,
        workspaceRoot: worker.cwd,
      })
      const disposeProvider = ctx.subagents.registerProvider(provider)
      log.info(`registered subagent provider "${provider.name}" -> ${worker.url}`)
      ctx.effect(() => () => { void bridge.dispose() }, 'remote-use: bridge teardown')
      return () => {
        disposeProvider()
        for (const m of memories.values()) m.dispose()
        memories.clear()
        log.info(`unregistered subagent provider "${provider.name}"`)
      }
    }, `remote-use: provider ${peerId}`)
  }

  // ---- model-facing tools ------------------------------------------------
  if (peers.size > 0) {
    for (const def of makeRemoteTools({ registry, peers })) {
      ctx.effect(() => ctx.tools.register(def), `remote-use: tool ${def.name}`)
    }
  }

  // ---- runtime context: stop the model from forgetting remote work --------
  if (cfg.injectTaskSummary) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'remote-use:in-flight',
      order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
      text: () => registry.summary(),
    }), 'remote-use: task summary section')
  }

  // ---- settings data route (readiness panel + on-demand self-check) ------
  ctx.inject(['webServer'], (child) => {
    child.effect(() => child.webServer.register(makeSettingsRoute({ peers, registry, cache })),
      'remote-use: settings route')
  })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** @param {object} ctx */
function makeLogger(ctx) {
  const emit = (level, message) => {
    const target = ctx?.logger?.[level]
    if (typeof target === 'function') target.call(ctx.logger, message)
    else if (level === 'error' || level === 'warn') console.warn(`[remote-use] ${message}`)
    else console.log(`[remote-use] ${message}`)
  }
  return {
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
  }
}

/** Fill defaults by hand so unit tests can call this without the schema runtime. */
export function normalizeConfig(config) {
  const workers = Array.isArray(config?.workers) ? config.workers : []
  return {
    workers: workers.map((w) => ({
      id: String(w.id ?? ''),
      name: String(w.name ?? ''),
      url: String(w.url ?? ''),
      token: String(w.token ?? ''),
      cwd: String(w.cwd ?? ''),
      enabled: w.enabled !== false,
      serialQueue: Number.isFinite(w.serialQueue) ? Math.max(1, Number(w.serialQueue)) : 1,
    })),
    approvalTimeoutMs: Number.isFinite(config?.approvalTimeoutMs) ? Number(config.approvalTimeoutMs) : 90_000,
    requiredTier: String(config?.requiredTier ?? 'workspace-write'),
    toolPrefix: String(config?.toolPrefix ?? 'subagent_remote'),
    injectTaskSummary: config?.injectTaskSummary !== false,
  }
}

/**
 * Build the approval decider used by both the provider (per task) and the bridge
 * (constructor-level fallback).
 *
 * ⚠️ `requiredTier` is derived PER APPROVAL, not taken from config once. Using a
 * fixed tier would still stop `danger-full-access`, but it would miss the quieter
 * failure mode: a read-only operation asking for `workspace-write`. Deriving it from
 * the actual call (tool name + target path vs the worker's cwd) is what makes the
 * tier check mean what DESIGN §8.3 says it means.
 *
 * ROUTING RULE: branch on `decision.needsHuman`, never on `source === 'human'`.
 * `source` is an audit classification; a `danger-full-access` request is classified
 * `tier-check` but still needs a human, so keying off `source` would silently start
 * auto-approving it one day.
 *
 * @param {{ cfg: object, worker: object, memories: Map<string, any>, log: object }} deps
 * @returns {(ask: { taskId?: string, toolCallId: string, toolName?: string, rawInput?: unknown }) => { optionId: string, source: string, reason: string, needsHuman: boolean }}
 */
export function makeApprovalDecider(deps) {
  const { cfg, worker, memories, log } = deps
  return function decide(ask) {
    const taskId = typeof ask?.taskId === 'string' && ask.taskId !== '' ? ask.taskId : 'unattributed'
    let memory = memories.get(taskId)
    if (memory === undefined) {
      memory = new TaskMemory(taskId)
      memories.set(taskId, memory)
    }

    const requiredTier = inferRequiredTier(ask?.rawInput, {
      workspaceRoot: worker.cwd,
      toolName: ask?.toolName,
      defaultTier: cfg.requiredTier,
    })

    const decision = decideApproval(
      { taskId, toolCallId: ask?.toolCallId, toolName: ask?.toolName, rawInput: ask?.rawInput },
      { memory, policy: { requiredTier, workspaceRoot: worker.cwd } },
    )

    const humans = decision.needsHuman ? ' [NEEDS HUMAN]' : ''
    log.info(`approval ${String(ask?.toolCallId)} tool=${String(ask?.toolName)} `
      + `required=${requiredTier} -> ${decision.optionId} (source=${decision.source})${humans} ${decision.reason}`)

    // Until a human UI is wired, `needsHuman` requests fall through to refusal. The
    // optionId is already reject-once in that case, so this is fail-closed by
    // construction -- never an implicit allow.
    return decision
  }
}

/**
 * The Settings page's data route. Read-only in this first cut: it reports worker
 * reachability, the readiness report, and the in-flight task list.
 * @param {{ peers: Map<string, any>, registry: TaskRegistry, cache: ToolCallCache }} deps
 */
export function makeSettingsRoute(deps) {
  const { peers, registry, cache } = deps
  return {
    kind: 'exact',
    path: '/api/dsh/dsh-plugin-remote-use',
    async handler(req, res) {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      if (req.method !== 'GET' && req.method !== 'POST') return send(405, { ok: false, error: 'method-not-allowed' })
      const workers = []
      for (const peer of peers.values()) {
        let report = null
        let error = ''
        try { report = await peer.selfcheck() } catch (e) { error = e instanceof Error ? e.message : String(e) }
        workers.push({
          peerId: peer.peerId,
          name: peer.name,
          cwd: peer.defaultCwd,
          report,
          error,
          activeTasks: registry.activeCountForPeer(peer.peerId),
        })
      }
      return send(200, {
        ok: true,
        workers,
        tasks: registry.list().slice(0, 50),
        toolCallCache: { size: cache.size, misses: cache.misses },
      })
    },
  }
}
