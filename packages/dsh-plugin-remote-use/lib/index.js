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

// NOTE: `@deepseek-ai/schemastery` is deliberately NOT a static import here -- see the
// defensive resolution below for why a missing schema must not abort the module.
import { AcpBridge } from './bridge/acp-bridge.js'
import { PeerConnection, httpBaseOf } from './bridge/peer-connection.js'
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
 * Resolve `@deepseek-ai/schemastery` defensively.
 *
 * WHY THIS IS NOT A STATIC IMPORT: the host is expected to intercept `@deepseek-ai/*`
 * for third-party plugins (that is why `dsh-cost-meter` can list `@deepseek-ai/dsh-credentials`
 * as a peer dependency). But this plugin is linked into the profile, and Node resolves
 * modules through the package's REAL path — `profiles/node_modules/@deepseek-ai/schemastery`
 * is not necessarily on that path, and on this machine it is one of the 482 dangling
 * junctions left by an old npm install. A failed static import would abort the whole
 * module, so the plugin would not load at all.
 *
 * Falling back to a plain object costs only the Settings-page form: dsh-app-boot marks a
 * non-Schemastery `Config` as `unsupported`, and configuration still arrives from the
 * patch layer, which is where worker entries are written anyway.
 */
const SCHEMA_UNAVAILABLE = 'SCHEMA_UNAVAILABLE'
let Schema = null
try {
  Schema = (await import('@deepseek-ai/schemastery')).default ?? null
} catch (error) {
  console.warn(`[remote-use] @deepseek-ai/schemastery not importable (${error instanceof Error ? error.message : String(error)}); `
    + 'falling back to a plain Config object. Workers must be configured through the profile patch layer, '
    + 'and the Settings page will not render a form for this plugin.')
}

/** The default worker shape, shared by the schema and the fallback. */
const WORKER_DEFAULTS = {
  name: '',
  token: '',
  enabled: true,
  serialQueue: 1,
}

/**
 * Plugin configuration.
 *
 * A worker entry needs the relay's address and shared secret. `cwd` is the worker-side
 * absolute path a task runs in — it must exist on the worker and is also what the
 * sandbox scopes writes to.
 */
export const Config = Schema !== null
  ? Schema.object({
    workers: Schema.array(Schema.object({
      id: Schema.string().required(),
      name: Schema.string().default(''),
      url: Schema.string().required(),
      token: Schema.string().default(''),
      cwd: Schema.string().required(),
      enabled: Schema.boolean().default(true),
      /** Per-worker serial concurrency. GUI is an exclusive resource: 1. */
      serialQueue: Schema.number().default(1),
    })).default([]),
    approvalTimeoutMs: Schema.number().default(90_000),
    /** Tier a task needs unless the delegation narrows it. */
    requiredTier: Schema.string().default('workspace-write'),
    /** Prefix a remote tool's name; one row per worker uses `<toolPrefix>` + worker id. */
    toolPrefix: Schema.string().default('subagent_remote'),
    injectTaskSummary: Schema.boolean().default(true),
  })
  : {
    // Rendered as "unsupported" in the Settings page; `normalizeConfig` applies the very
    // same defaults, so behaviour is identical for a patch-configured install.
    [SCHEMA_UNAVAILABLE]: true,
    workers: [],
    approvalTimeoutMs: 90_000,
    requiredTier: 'workspace-write',
    toolPrefix: 'subagent_remote',
    injectTaskSummary: true,
    _defaults: WORKER_DEFAULTS,
  }

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

    // The connection is LAZY: nothing connects until something needs the worker. An
    // eager connect at load time would fail whenever the worker is off or still booting,
    // and there is no useful moment to retry from. PeerConnection owns the bridge's
    // lifecycle so a dead link is rebuilt rather than reused.
    const connection = new PeerConnection({
      peerId,
      log: (level, message) => log[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](message),
      // Binary payloads (screenshots) come from the relay's HTTP side, not through the ACP
      // message pump. Derived from the same URL so there is one thing to configure.
      httpBase: httpBaseOf(worker.url),
      token: worker.token,
      createBridge: () => new AcpBridge({
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
      }),
    })

    const workerRuntime = {
      peerId,
      name: worker.name === '' ? peerId : worker.name,
      // The provider and the tools only use startTask/cancel/selfcheck/dispose/connected,
      // all of which PeerConnection implements, so they cannot tell it is not a bridge.
      bridge: connection,
      connection,
      defaultCwd: worker.cwd,
      /**
       * Ask the worker for a fresh readiness report. Falls back to a synthesised
       * "unreachable" report so the gate refuses instead of letting dispatch through.
       */
      async selfcheck() {
        try {
          return await connection.selfcheck()
        } catch (error) {
          // `sessionSegment` is about the WORKER'S SESSION, not about reachability. Saying
          // 'unavailable' here made the dispatch gate report "nobody is logged in" whenever
          // the relay was merely down -- a wrong diagnosis that sends the operator to check
          // the login state instead of the link. 'unknown' is honest: the check never ran,
          // so the blocking S0 failure below is what should decide the gate.
          return {
            verdict: 'blocked',
            sessionSegment: 'unknown',
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
      ctx.effect(() => () => { void connection.dispose() }, 'remote-use: connection teardown')
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
          // Surface the LINK state separately from the readiness report. Without it a
          // "not connected" failure looks like a worker fault, which is how the missing
          // connect() stayed invisible until a real profile load.
          connection: peer.connection?.stats,
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
