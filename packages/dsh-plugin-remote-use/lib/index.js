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
import {
  mergeSettings,
  publicWorker,
  readSettings,
  removeWorker as removeWorkerFromList,
  upsertWorker,
  writeSettings,
} from './core/settings-store.js'
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
 * Tools this plugin owns — the exact set the per-session gate acts on.
 *
 * Listed literally rather than derived from `makeRemoteTools()` so the gate cannot silently
 * widen if that function ever grows a tool: a new tool would appear in the list only after
 * someone adds it here, and until then the guard would refuse it (fail-closed).
 */
export const REMOTE_TOOL_NAMES = Object.freeze([
  'remote_agents',
  'remote_interrupt',
  'remote_selfcheck',
  'remote_screenshot',
])

/** The slash command that switches remote work on and off for one session. */
export const ENABLE_COMMAND = 'remote-use'

/**
 * Injected only while a session has remote work switched ON.
 *
 * WHY THIS EXISTS AT ALL: enabling the plugin registers the delegation tools, but nothing in
 * DSH tells the parent agent *when* delegating is appropriate -- the tool description is
 * generic ("delegate a self-contained task to a subagent"), and DSH's own
 * `SUBAGENT_DELEGATION` context is addressed to the CHILD, not to the delegating agent.
 * Without a policy the model has no way to know that this worker is for GUI verification and
 * not a second development machine.
 *
 * Placed at TEAM_POLICY order so the rule is read BEFORE the tool guidance it qualifies,
 * which is the same placement rationale `dsh-tools` gives for its PTC-only statement.
 */
export const DEFAULT_DELEGATION_POLICY = [
  '## Remote LAN workers (enabled for this session)',
  '',
  'A paired worker is available. It exists for GUI verification and testing on a second',
  'machine, because GUI automation takes over the mouse, keyboard and focus of whichever',
  'machine runs it.',
  '',
  '- Do all code editing, file changes, builds, dependency installs and repository work HERE.',
  '- Delegate ONLY what needs a real desktop: launching and driving the target application,',
  '  confirming what the interface shows, reproducing something that only happens on a real',
  '  display.',
  '- Do NOT develop on a worker. It cannot see this workspace, so anything written there does',
  '  not come back.',
  '',
  'Call remote_selfcheck before delegating (a worker that fails its readiness check is',
  'refused by the dispatch gate). Use remote_agents to watch progress, remote_screenshot to',
  'look at the worker screen, and remote_interrupt to stop a task.',
].join('\n')

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
    /** Liveness probe interval per worker, in ms. 0 disables it. */
    heartbeatMs: Schema.number().default(15000),
    /**
     * How long a page load may spend probing readiness before it answers without a report.
     * Raise it for a slow link; the page renders immediately either way.
     */
    reportBudgetMs: Schema.number().default(4000),
    /** How long the page's explicit "re-check now" may spend. */
    selfcheckBudgetMs: Schema.number().default(25000),
    /**
     * The division-of-labour policy injected while a session has remote work switched on.
     * Empty string disables the injection entirely (the tools are still gated).
     */
    delegationPolicy: Schema.string().default(DEFAULT_DELEGATION_POLICY),
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
    heartbeatMs: 15_000,
    reportBudgetMs: 4_000,
    selfcheckBudgetMs: 25_000,
    delegationPolicy: DEFAULT_DELEGATION_POLICY,
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
  // The settings file is the page's storage and takes precedence over the profile patch for
  // the keys it contains. Absent (the usual case) it changes nothing.
  const stored = readSettings()
  if (stored.error !== '') log.warn(`settings file ignored: ${stored.error}`)
  const merged = mergeSettings(normalizeConfig(config), stored.settings)
  let cfg = merged.config
  if (stored.settings !== null) {
    log.info(`settings file applies: ${Object.entries(merged.sources).filter(([, s]) => s === 'settings').map(([k]) => k).join(', ') || 'nothing'}`)
  }
  const registry = new TaskRegistry({})

  // A single shared cache keyed by `${workerId}:${toolCallId}`; approvals arrive with
  // only a tool call id, so this is the ONLY source of a tool's name and arguments
  // (DESIGN §10.0.1).
  const cache = new ToolCallCache({ maxEntries: 1024 })
  /** @type {Map<string, object>} */
  const peers = new Map()
  /**
   * Per-worker teardown, so the page can re-pair without a restart.
   *
   * `ctx.effect` returns its own disposer, so wiring can be undone on demand rather than
   * only when the fiber dies. Before this existed, changing a worker meant editing YAML and
   * restarting DSH -- which is exactly the friction the settings page is meant to remove.
   * @type {Map<string, () => unknown>}
   */
  const unwire = new Map()

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
  /**
   * Bring one worker online: build its connection, publish its runtime, and register its
   * subagent provider. Undone by the disposer recorded in `unwire`.
   */
  function wire(worker) {
    const peerId = worker.id
    /**
     * Task memory is PER WORKER, not shared.
     *
     * It used to be one map keyed by taskId whose teardown did `memories.clear()`. That was
     * harmless only because a worker was never removed at runtime; with live re-pairing it
     * would wipe every OTHER worker's approval memory, making the review engine forget
     * decisions it had already made. Per-worker ownership removes the footgun structurally.
     * @type {Map<string, TaskMemory>}
     */
    const memories = new Map()

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
      // Probe the link periodically so a relay restart is noticed between calls instead of
      // failing the next one. 0 disables probing.
      heartbeatMs: cfg.heartbeatMs,
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
      // Echoed back so `reconfigure` can tell whether a live worker still matches its
      // configuration. `PeerConnection` captures these at construction, so a change to any
      // of them requires tearing the connection down rather than mutating it.
      url: worker.url,
      token: worker.token,
      cwd: worker.cwd,
      serialQueue: worker.serialQueue,
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

    // The provider is captured per worker, but `decideApproval` closes over the LIVE `cfg`,
    // so a settings change that alters `requiredTier` takes effect on the next decision
    // without re-wiring anything.
    const dispose = ctx.effect(() => {
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
        // Only THIS worker's memory: see the note on `memories` in `wire`.
        for (const m of memories.values()) m.dispose()
        memories.clear()
        log.info(`unregistered subagent provider "${provider.name}"`)
      }
    }, `remote-use: provider ${peerId}`)

    unwire.set(peerId, dispose)
  }

  /** Take one worker offline: dispose its provider, its memory, and its connection. */
  function unwireWorker(peerId) {
    const dispose = unwire.get(peerId)
    unwire.delete(peerId)
    peers.delete(peerId)
    if (dispose === undefined) return false
    dispose()
    return true
  }

  /**
   * Make the live wiring match `workers`.
   *
   * Diffed by id, and a worker whose connection details changed is torn down and rebuilt:
   * `PeerConnection` captures its url, token and httpBase at construction, so editing any
   * of them cannot be applied to a running instance.
   *
   * @param {object[]} workers the desired list
   * @returns {{ added: string[], removed: string[], changed: string[] }}
   */
  function reconfigure(workers) {
    const desired = new Map()
    for (const worker of workers) {
      if (worker?.enabled === false) continue
      if (typeof worker?.id === 'string' && worker.id !== '') desired.set(worker.id, worker)
    }

    const removed = []
    for (const peerId of [...unwire.keys()]) {
      if (!desired.has(peerId)) { unwireWorker(peerId); removed.push(peerId) }
    }

    const added = []
    const changed = []
    for (const [peerId, worker] of desired) {
      const existing = peers.get(peerId)
      if (existing === undefined) {
        wire(worker)
        added.push(peerId)
        continue
      }
      // Compare the fields `PeerConnection` and `RemoteProvider` captured at construction.
      const differs = existing.url !== worker.url
        || existing.token !== worker.token
        || existing.cwd !== worker.cwd
        || existing.serialQueue !== worker.serialQueue
        || existing.name !== worker.name
      if (differs) {
        unwireWorker(peerId)
        wire(worker)
        changed.push(peerId)
      }
    }
    return { added, removed, changed }
  }

  // Bring up whatever the merged configuration asks for.
  reconfigure(cfg.workers)

  // ---- page-facing configuration control ---------------------------------
  //
  // Everything the Settings page may change, plus the persistence and live-apply that make
  // a change take effect without editing YAML and restarting DSH.

  /** The live configuration's managed subset, i.e. exactly what gets persisted. */
  function currentSettings() {
    return {
      workers: cfg.workers.map((w) => ({ ...w })),
      requiredTier: cfg.requiredTier,
      approvalTimeoutMs: cfg.approvalTimeoutMs,
      heartbeatMs: cfg.heartbeatMs,
    }
  }

  /** The policy fields a running approval decider captured at construction. */
  function policyStamp(settings) {
    return `${settings.requiredTier}|${settings.approvalTimeoutMs}|${settings.heartbeatMs}`
  }

  /**
   * Persist a full settings object and make the live wiring match it.
   *
   * A change to the approval policy or the heartbeat interval REBUILDS every worker, because
   * both are captured when a provider or connection is constructed. Rebuilding also discards
   * remembered approvals, which is the behaviour we want: a decision made under the old
   * policy must not silently carry into the new one.
   *
   * @returns {{ ok: boolean, error?: string, added?: string[], removed?: string[], changed?: string[], rebuilt?: boolean }}
   */
  function persistSettings(settings) {
    const normalized = normalizeConfig(settings)
    const written = writeSettings(normalized)
    if (!written.ok) return { ok: false, error: `could not write ${written.file}: ${written.error}` }

    const before = policyStamp(cfg)
    cfg = mergeSettings(cfg, normalized).config

    if (policyStamp(cfg) !== before) {
      for (const peerId of [...unwire.keys()]) unwireWorker(peerId)
      const diff = reconfigure(cfg.workers)
      log.info(`settings saved: policy changed, rebuilt every worker (${diff.added.length} added, ${diff.removed.length} removed)`)
      return { ok: true, ...diff, rebuilt: true }
    }

    const diff = reconfigure(cfg.workers)
    log.info(`settings saved: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} rebuilt`)
    return { ok: true, ...diff, rebuilt: false }
  }

  // ---- model-facing tools ------------------------------------------------
  // The tools are registered UNCONDITIONALLY. They used to be skipped when there were no
  // workers, which was fine while the worker list was fixed at load time -- but the page can
  // now add the first worker at runtime, and a session that started with none would then have
  // no tools to drive it with.
  for (const def of makeRemoteTools({ registry, peers })) {
    ctx.effect(() => ctx.tools.register(def), `remote-use: tool ${def.name}`)
  }

  // ---- per-session enablement (default OFF) ------------------------------
  //
  // Installing the plugin must not route every session through a worker. The tools exist
  // globally, but each session starts with them ANDDENIED in its own scope; `/remote-use on`
  // lifts that for the session that asked.
  //
  // WHY THE RESTRICTION IS PER-AGENT AND NOT GLOBAL: `tools.restrict()` refuses a
  // context-global call outright -- "a context-global restriction would mask every agent".
  // So the only correct shape is to deny inside each agent's own scope, which also means the
  // restriction is disposed with the agent rather than leaking across sessions.
  /** Agents the operator switched on. ABSENT means off, which is the default. */
  const enabledAgents = new Set()
  /** agent -> the disposer that lifts its restriction. Present means "currently denied". */
  const restrictions = new Map()

  /** Hide the remote tools from one session's model. Idempotent. */
  function denyFor(agent) {
    if (agent === undefined || restrictions.has(agent)) return
    try {
      // `agent.ctx` scopes the effect, so the restriction lives and dies with the agent.
      restrictions.set(agent, agent.ctx.tools.restrict({ deny: [...REMOTE_TOOL_NAMES] }))
    } catch (error) {
      // Never let this abort plugin startup. The guard below is the backstop that still
      // refuses execution, so a failed restriction degrades to "visible but unusable"
      // rather than to "silently allowed".
      log.warn(`could not restrict remote tools for one session (${error instanceof Error ? error.message : String(error)}); the execution guard still applies`)
    }
  }

  /** Show them again for one session. */
  function allowFor(agent) {
    const lift = restrictions.get(agent)
    restrictions.delete(agent)
    if (typeof lift === 'function') lift()
  }

  ctx.on('agent/created', ({ agent } = {}) => {
    if (agent === undefined) return
    if (!enabledAgents.has(agent)) denyFor(agent)
  })

  // FAIL-CLOSED BACKSTOP.
  //
  // The restriction above is applied when an agent is created, so an agent that already
  // existed when this plugin was applied -- a hot reload, or a config change -- would keep
  // the tools visible. `dsh-tools` exposes no way to enumerate live agents, so that case
  // cannot be closed by iterating. A plain-context guard applies to EVERY agent instead, and
  // refuses execution unless the session is switched on. The tool list can then be wrong
  // without the consequence being wrong.
  ctx.effect(() => ctx.tools.guard((exec) => {
    if (!REMOTE_TOOL_NAMES.includes(exec?.name)) return undefined
    const agent = exec?.agent
    if (agent !== undefined && enabledAgents.has(agent)) return undefined
    return `remote-use is off for this session: run /${ENABLE_COMMAND} on to route work to a LAN worker.`
  }), 'remote-use: enablement guard')

  // ---- the switch itself -------------------------------------------------
  ctx.inject(['commands'], (child) => {
    const handler = (invocation) => {
      const agent = invocation?.agent
      const argument = String(invocation?.rawInput ?? '').trim().toLowerCase()

      if (argument === '' || argument === 'status') {
        const state = agent !== undefined && enabledAgents.has(agent) ? 'on' : 'off'
        return {
          kind: 'success',
          text: `remote-use is ${state} for this session.`
            + (state === 'off'
              ? ` Nothing routes to a worker and the remote tools are hidden. Use /${ENABLE_COMMAND} on to enable them here.`
              : ' Work needing a real desktop is delegated; code, builds and repository work stay here.'),
        }
      }
      if (agent === undefined) {
        return { kind: 'error', text: `/${ENABLE_COMMAND}: this invocation carries no session, so the switch cannot be scoped to it.` }
      }
      if (argument === 'on') {
        enabledAgents.add(agent)
        allowFor(agent)
        return {
          kind: 'success',
          text: `remote-use is on for this session. The remote tools are available and the delegation policy is in effect;`
            + ` code, builds and repository work still belong here. /${ENABLE_COMMAND} off reverts.`,
        }
      }
      if (argument === 'off') {
        enabledAgents.delete(agent)
        denyFor(agent)
        return {
          kind: 'success',
          text: `remote-use is off for this session. The remote tools are hidden and any further call is refused.`,
        }
      }
      return { kind: 'error', text: `/${ENABLE_COMMAND}: unknown argument "${argument}". Use \`on\`, \`off\` or \`status\`.` }
    }

    child.effect(() => child.commands.register({
      name: ENABLE_COMMAND,
      description: 'Route GUI verification and testing to a paired LAN worker for THIS session (default off)',
      input: { hint: 'on | off | status' },
      handler,
    }), `remote-use: /${ENABLE_COMMAND} command`)
  })

  // ---- the policy, only while switched on --------------------------------
  //
  // Order places the rule BEFORE the tool guidance it qualifies, matching the rationale
  // dsh-tools gives for its own PTC-only statement. Rendering '' outside `on` means the
  // section is absent rather than empty when the session has not opted in.
  if (cfg.delegationPolicy !== '') {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'remote-use:policy',
      order: ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: (context) => {
        const agent = context?.agent ?? context?.scope
        return agent !== undefined && enabledAgents.has(agent) ? cfg.delegationPolicy : ''
      },
    }), 'remote-use: delegation policy section')
  }

  // ---- runtime context: stop the model from forgetting remote work --------
  if (cfg.injectTaskSummary) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'remote-use:in-flight',
      order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
      text: () => registry.summary(),
    }), 'remote-use: task summary section')
  }

  // ---- settings data route (availability, diagnostics, pairing) ----------
  ctx.inject(['webServer'], (child) => {
    child.effect(() => child.webServer.register(makeSettingsRoute({
      peers,
      registry,
      cache,
      currentSettings,
      persistSettings,
      settingsPath: stored.file,
      reportBudgetMs: cfg.reportBudgetMs,
      selfcheckBudgetMs: cfg.selfcheckBudgetMs,
    })), 'remote-use: settings route')
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
    heartbeatMs: Number.isFinite(config?.heartbeatMs) ? Math.max(0, Number(config.heartbeatMs)) : 15_000,
    reportBudgetMs: Number.isFinite(config?.reportBudgetMs) ? Math.max(1, Number(config.reportBudgetMs)) : 4_000,
    selfcheckBudgetMs: Number.isFinite(config?.selfcheckBudgetMs) ? Math.max(1, Number(config.selfcheckBudgetMs)) : 25_000,
    // `undefined` means "not configured" and takes the default; an explicit empty string is
    // the operator switching the injection OFF, which must survive. `??` would be wrong here
    // in the other direction; the check is deliberately about the type.
    delegationPolicy: typeof config?.delegationPolicy === 'string' ? config.delegationPolicy : DEFAULT_DELEGATION_POLICY,
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

/** Largest POST body the Settings page may send. It only carries a small action object. */
const SETTINGS_MAX_BODY = 16 * 1024

/**
 * Readiness budget for a page load.
 *
 * MEASURED PROBLEM: `selfcheck()` connects first, and against an unreachable worker that
 * costs a full TCP connect timeout (~20 s). A page load must not pay that: for the whole
 * time the request was in flight the browser showed its initial state, which read as
 * "nothing is configured" even though the worker list plainly had one entry. Link state is
 * knowable immediately, so it is returned regardless and a missing report is reported as
 * missing rather than as an absence of workers.
 */
const REPORT_BUDGET_MS = 4_000

/** An explicit "re-check now" may take longer: the operator asked for it and is waiting. */
const SELFCHECK_BUDGET_MS = 25_000

/** Sentinel distinguishing "the probe did not finish" from a legitimate `undefined`. */
const TIMED_OUT = Symbol('timed-out')

/**
 * Await `promise`, but give up after `budgetMs`.
 *
 * The underlying probe is NOT cancelled -- a pending TCP connect cannot be. Its rejection is
 * swallowed so a late failure cannot surface as an unhandled rejection; the connection's own
 * `lastError` still records it for the next read.
 */
async function within(promise, budgetMs) {
  let timer
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), budgetMs)
    if (typeof timer?.unref === 'function') timer.unref()
  })
  promise.catch(() => {})
  try {
    return await Promise.race([promise, expiry])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run a readiness probe under a budget.
 * @param {object} peer
 * @param {number} budgetMs
 * @param {{ maxAgeMs?: number, timeoutMs?: number }} [opts] passed through to `selfcheck`
 * @returns {Promise<{ report: object | null, error: string }>}
 */
async function probeWithin(peer, budgetMs, opts) {
  const raced = await within(peer.selfcheck(opts), budgetMs)
  if (raced === TIMED_OUT) {
    return { report: null, error: `readiness probe did not finish within ${budgetMs} ms` }
  }
  return { report: raced, error: '' }
}

/** Read and parse a JSON request body without letting a huge one exhaust memory. */
function readJsonBody(req, limit = SETTINGS_MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`request body exceeds ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  })
}

/**
 * The Settings page's data route.
 *
 * GET  reports worker reachability, the readiness report, and the in-flight task list.
 * POST performs the page's actions (`selfcheck`, `screenshot`, `interrupt`, `ping`).
 *
 * Every failure is returned as `{ ok: false, error }` with a 4xx/5xx status rather than
 * thrown: the browser half renders the message, and an unhandled rejection here would show
 * the page a bare 500 with nothing to display.
 *
 * @param {{ peers: Map<string, any>, registry: TaskRegistry, cache: ToolCallCache,
 *           currentSettings?: () => object, persistSettings?: (s: object) => object,
 *           settingsPath?: string, reportBudgetMs?: number, selfcheckBudgetMs?: number }} deps
 */
export function makeSettingsRoute(deps) {
  const { peers, registry, cache } = deps
  const currentSettings = deps.currentSettings ?? (() => ({ workers: [] }))
  const persistSettings = deps.persistSettings ?? (() => ({ ok: false, error: 'this build cannot persist settings' }))
  const settingsFile = deps.settingsPath ?? ''
  // Injectable so a test can drive the timeout path without waiting the production budget.
  const reportBudgetMs = Number.isFinite(deps.reportBudgetMs) ? Number(deps.reportBudgetMs) : REPORT_BUDGET_MS
  const selfcheckBudgetMs = Number.isFinite(deps.selfcheckBudgetMs) ? Number(deps.selfcheckBudgetMs) : SELFCHECK_BUDGET_MS

  /**
   * The managed configuration as the PAGE sees it: every worker present, tokens replaced by
   * `tokenSet`/`tokenHint`. The page must be able to render the form without ever holding a
   * bearer credential for remote execution.
   */
  const publicSettings = () => {
    const settings = currentSettings()
    return {
      workers: (Array.isArray(settings.workers) ? settings.workers : []).map(publicWorker),
      requiredTier: settings.requiredTier,
      approvalTimeoutMs: settings.approvalTimeoutMs,
      heartbeatMs: settings.heartbeatMs,
    }
  }

  return {
    kind: 'exact',
    path: '/api/dsh/dsh-plugin-remote-use',
    async handler(req, res) {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }

      /** Collect one row per configured worker, including its link state and readiness. */
      const snapshot = async () => {
        const workers = []
        for (const peer of peers.values()) {
          let report = null
          let error = ''
          try {
            const probed = await probeWithin(peer, reportBudgetMs)
            report = probed.report
            error = probed.error
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
          }
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
        return {
          ok: true,
          workers,
          tasks: registry.list().slice(0, 50),
          toolCallCache: { size: cache.size, misses: cache.misses },
          // The vocabulary the page needs to render its own controls, without any secret.
          settings: publicSettings(),
          settingsFile,
        }
      }

      if (req.method === 'GET') return send(200, await snapshot())
      if (req.method !== 'POST') return send(405, { ok: false, error: 'method-not-allowed' })

      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        return send(400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      const action = String(body?.action ?? '')

      /** Resolve one peer by id, or reply with a 404 the page can show. */
      const peerOr = (peerId) => {
        const peer = peers.get(String(peerId ?? ''))
        if (peer === undefined) {
          send(404, { ok: false, error: `no such worker "${peerId}"` })
          return undefined
        }
        return peer
      }

      try {
        switch (action) {
          case 'selfcheck': {
            // `maxAgeMs: 0` forces a fresh probe. The page's whole point is to answer
            // "can it run right now", and a cached report cannot answer that.
            const peer = peerOr(body?.peerId)
            if (peer === undefined) return
            // A longer budget than a page load: this is an explicit request and the
            // operator is watching it, so a connect attempt is allowed to finish.
            const probed = await probeWithin(peer, selfcheckBudgetMs, { maxAgeMs: 0 })
            if (probed.report === null && probed.error !== '') {
              return send(504, { ok: false, error: probed.error, peerId: peer.peerId })
            }
            return send(200, { ok: true, peerId: peer.peerId, report: probed.report })
          }

          case 'screenshot': {
            const peer = peerOr(body?.peerId)
            if (peer === undefined) return
            // The capture path is independent of the ACP link, so it still works when the
            // worker's agent is busy -- which is exactly when a screenshot is most wanted.
            const shot = await peer.screenshot({ fresh: true })
            return send(200, { ok: true, peerId: peer.peerId, screenshot: shot })
          }

          case 'ping': {
            const peer = peerOr(body?.peerId)
            if (peer === undefined) return
            await peer.ensure()
            return send(200, { ok: true, peerId: peer.peerId, connected: peer.connected })
          }

          case 'interrupt': {
            // Emergency stop. `peerId` narrows it to one worker; omitting it stops every
            // in-flight task, which is the button a page needs when something has gone
            // wrong and the user does not want to reason about which worker is which.
            const only = body?.peerId === undefined ? undefined : String(body.peerId)
            const active = registry.active()
            const cancelled = []
            const failures = []
            for (const task of active) {
              if (only !== undefined && task.peerId !== only) continue
              const peer = peers.get(task.peerId)
              if (peer === undefined) {
                failures.push({ taskId: task.taskId, error: `worker "${task.peerId}" is not connected` })
                continue
              }
              try {
                await peer.bridge.cancel()
                cancelled.push(task.taskId)
              } catch (error) {
                failures.push({ taskId: task.taskId, error: error instanceof Error ? error.message : String(error) })
              }
            }
            return send(200, { ok: true, cancelled, failures, considered: active.length })
          }

          case 'worker.save': {
            // Upsert one worker. An absent/blank token means "keep the stored one": the page
            // never receives tokens, so requiring re-entry to rename a worker would be both
            // annoying and pointless.
            const edited = upsertWorker(currentSettings().workers, body?.worker)
            if (edited.error !== '') return send(400, { ok: false, error: edited.error })
            const applied = persistSettings({ ...currentSettings(), workers: edited.workers })
            if (applied.ok !== true) return send(500, { ok: false, error: applied.error })
            return send(200, { ok: true, applied, settings: publicSettings() })
          }

          case 'worker.remove': {
            const { workers, removed } = removeWorkerFromList(currentSettings().workers, String(body?.peerId ?? ''))
            if (!removed) return send(404, { ok: false, error: `no such worker "${body?.peerId}"` })
            const applied = persistSettings({ ...currentSettings(), workers })
            if (applied.ok !== true) return send(500, { ok: false, error: applied.error })
            return send(200, { ok: true, applied, settings: publicSettings() })
          }

          case 'settings.save': {
            // Only the managed, non-worker keys. Workers go through `worker.save` so a token
            // can never be dropped by a form that did not carry one.
            const incoming = body?.settings ?? {}
            const next = { ...currentSettings() }
            if (incoming.requiredTier !== undefined) next.requiredTier = String(incoming.requiredTier)
            if (Number.isFinite(incoming.approvalTimeoutMs)) next.approvalTimeoutMs = Number(incoming.approvalTimeoutMs)
            if (Number.isFinite(incoming.heartbeatMs)) next.heartbeatMs = Number(incoming.heartbeatMs)
            const applied = persistSettings(next)
            if (applied.ok !== true) return send(500, { ok: false, error: applied.error })
            return send(200, { ok: true, applied, settings: publicSettings() })
          }

          default:
            return send(400, { ok: false, error: `unknown action "${action}"` })
        }      } catch (error) {
        return send(502, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}
