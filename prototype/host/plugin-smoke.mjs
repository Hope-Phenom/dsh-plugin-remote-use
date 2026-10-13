#!/usr/bin/env node
/**
 * plugin-smoke.mjs -- mount the plugin body against a fake host context.
 *
 * WHY: `dsh --dump-config` composes the loader tree but never MOUNTS it, so the plugin's
 * `apply()` is not exercised. This script runs the real `apply()` with a stand-in ctx and
 * asserts the three things a restart would otherwise be the first to discover:
 *
 *   1. the module loads at all (no unresolvable import)
 *   2. a subagent provider is registered under the expected name
 *   3. the tool rows are registered with the shape DSH requires (output.schema + render)
 *
 * It cannot prove Cordis integration -- only a real boot does that -- but it turns most
 * "the plugin does not load" failures into an offline check.
 *
 * Entry selection: this file lives in prototype/host, so it resolves the plugin by its
 * INSTALLED location (the profile junction) rather than a relative path, which is exactly
 * how the host will load it.
 */
import { pathToFileURL } from 'node:url'

const INSTALLED = 'C:\\Users\\you\\.dsh\\profiles\\desktop\\node_modules\\dsh-plugin-remote-use\\lib\\index.js'
const entryPath = process.argv[2] ?? INSTALLED
// Windows: the ESM loader only accepts file:// URLs for absolute paths.
const entry = pathToFileURL(entryPath).href

const registered = { providers: [], tools: [], effects: [], sections: [], injects: [], guards: [], commands: new Map(), listeners: new Map() }
const logLines = []

/**
 * A ctx just rich enough for the plugin's registrations.
 *
 * `effect()` MUST run its callback immediately, because Cordis does:
 * `Fiber.effect()` ends with `task = this._execute(runner)` (cordis lib/types/fiber.js),
 * i.e. the callback executes synchronously and its return value becomes the disposer.
 * A fake that merely stores the callback would make every registration inside an effect
 * look missing.
 */
function makeCtx() {
  let effectSeq = 0
  const runEffect = (fn, label) => {
    effectSeq += 1
    const name = label ?? `effect#${effectSeq}`
    try {
      const dispose = fn()
      registered.effects.push({ label: name, dispose: typeof dispose === 'function' ? dispose : () => {} })
    } catch (error) {
      registered.effects.push({ label: name, dispose: () => {}, error })
      throw error
    }
    return () => {}
  }
  const ctx = {
    logger: {
      info: (m) => logLines.push(['info', m]),
      warn: (m) => logLines.push(['warn', m]),
      error: (m) => logLines.push(['error', m]),
    },
    effect: runEffect,
    // The plugin subscribes to `agent/created` to apply its default-off tool restriction, so
    // a context without `on` cannot mount it at all. Every harness that mounts the real
    // `apply()` has to grow alongside it -- this was the third to need it, which is the
    // standing cost of testing the real entry point rather than a hand-built assembly.
    on(event, handler) {
      const list = registered.listeners.get(event) ?? []
      list.push(handler)
      registered.listeners.set(event, list)
      return () => {}
    },
    subagents: {
      registerProvider(provider) {
        registered.providers.push(provider)
        return () => {}
      },
    },
    tools: {
      register(def) {
        registered.tools.push(def)
        return () => {}
      },
      guard(fn) {
        registered.guards.push(fn)
        return () => {}
      },
    },
    commands: {
      register(def) {
        registered.commands.set(def.name, def)
        return () => {}
      },
    },
    systemPrompt: {
      // The real order table, for the two names this plugin anchors on.
      getSectionOrder: (name) => ({ TEAM_POLICY: 600, TOOL_SUBAGENT: 2800 })[name] ?? 100,
      section(def) {
        registered.sections.push(def)
        return () => {}
      },
    },
    inject(deps, cb) {
      registered.injects.push(deps)
      // The real loader calls back once the services exist; do the same so a plugin that
      // fails inside its inject callback is caught here too.
      cb(makeInjectedCtx())
    },
  }
  return ctx
}

function makeInjectedCtx() {
  return {
    effect: (fn, label) => {
      try {
        const dispose = fn()
        registered.effects.push({ label: label ?? 'injected-effect', dispose: typeof dispose === 'function' ? dispose : () => {} })
      } catch (error) {
        registered.effects.push({ label: label ?? 'injected-effect', dispose: () => {}, error })
        throw error
      }
      return () => {}
    },
    // The plugin's `ctx.inject([...], child => ...)` registrations land on THIS context, so
    // it needs whatever services the injected callbacks touch -- currently `commands` for the
    // /remote-use switch and `webServer` for the settings route.
    commands: {
      register(def) {
        registered.commands.set(def.name, def)
        return () => {}
      },
    },
    tools: {
      register(def) {
        registered.tools.push(def)
        return () => {}
      },
      guard(fn) {
        registered.guards.push(fn)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        registered.injects.push(['route:' + String(route?.path)])
        return () => {}
      },
    },
  }
}

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail === '' ? '' : ' -- ' + detail}`)
  if (!ok) failures += 1
}

console.log(`entry: ${entry}\n`)

let mod
try {
  mod = await import(entry)
  check('module loads', true)
} catch (error) {
  check('module loads', false, `${error?.constructor?.name}: ${error?.message}`)
  console.log('\nFAILED to load -- nothing else can be checked.')
  process.exit(1)
}

check('exports name', typeof mod.name === 'string', String(mod.name))
check('exports inject', Array.isArray(mod.inject), JSON.stringify(mod.inject))
check('exports Config', mod.Config !== undefined && mod.Config !== null)
check('exports apply()', typeof mod.apply === 'function')
if (mod.Config?.SCHEMA_UNAVAILABLE === true) {
  console.log('  NOTE  Config fell back to a plain object (schemastery not importable here)')
}

// ---- mount ---------------------------------------------------------------
const WORKER = {
  id: 'worker-pc',
  name: 'worker-pc',
  url: 'ws://192.168.1.101:7331',
  token: 'smoke-token',
  cwd: 'C:\\dsh-remote\\p0work',
  enabled: true,
  serialQueue: 1,
}

try {
  mod.apply(makeCtx(), {
    workers: [WORKER],
    approvalTimeoutMs: 90_000,
    requiredTier: 'workspace-write',
    toolPrefix: 'subagent_remote',
    injectTaskSummary: true,
  })
  check('apply() runs without throwing', true)
} catch (error) {
  check('apply() runs without throwing', false, `${error?.constructor?.name}: ${error?.message}`)
  if (error?.stack) console.log(String(error.stack).split('\n').slice(0, 8).join('\n'))
}

console.log('')
check('registered exactly one provider per worker', registered.providers.length === 1, `got ${registered.providers.length}`)

const provider = registered.providers[0]
if (provider !== undefined) {
  check('provider name is remote-<worker id>', provider.name === 'remote-worker-pc', provider.name)
  check('capabilities are all false (C1)', Object.values(provider.capabilities ?? {}).every((v) => v === false),
    JSON.stringify(provider.capabilities))
  check('inheritsParentContext is false (C6)', provider.inheritsParentContext === false)
  check('no prepareContinuable (C2)', provider.prepareContinuable === undefined)
  check('start() is a function', typeof provider.start === 'function')
}

const names = registered.tools.map((t) => t.name).sort()
console.log(`  INFO  tools registered: ${JSON.stringify(names)}`)
check('registered the four remote tools',
  names.join(',') === 'remote_agents,remote_interrupt,remote_screenshot,remote_selfcheck', names.join(','))
check('every tool declares output.schema + render',
  registered.tools.every((t) => t.output?.schema !== undefined && typeof t.output?.render === 'function'))
check('no remote_send_message (C2)', !names.includes('remote_send_message'))

// The model transport requires an object-rooted parameter schema, and
// `ctx.tools.register()` stores `parameters` verbatim (it validates only `output`). A
// shorthand map left unconverted therefore makes EVERY call fail at the model with
// 'schema must be a JSON Schema of type: "object", got type: null'. This is the check
// that catches that class of bug on the load path instead of in production.
for (const t of registered.tools) {
  check(`${t.name}: parameters are an object-rooted JSON Schema`,
    t.parameters?.type === 'object' && typeof t.parameters?.properties === 'object',
    `type=${JSON.stringify(t.parameters?.type)} keys=${JSON.stringify(Object.keys(t.parameters ?? {}))}`)
  const stray = Object.entries(t.parameters?.properties ?? {})
    .filter(([, p]) => p?.required !== undefined).map(([n]) => n)
  check(`${t.name}: no property keeps a "required" keyword`, stray.length === 0, stray.join(','))
}

// Asserted BY NAME rather than by count: a count breaks every time a section is added, and
// says nothing about which one went missing. Two are expected now -- the delegation policy
// (empty until a session switches remote work on) and the in-flight task summary.
const sectionNames = registered.sections.map((s) => s.name).sort()
check('registered both prompt sections',
  sectionNames.join(',') === 'remote-use:in-flight,remote-use:policy',
  sectionNames.join(',') || '(none)')
check('the delegation policy renders empty while no session has opted in',
  registered.sections.find((s) => s.name === 'remote-use:policy')?.text?.({ agent: { id: 'smoke' } }) === '')
check('the gate is installed: a command and an execution guard',
  registered.commands.has('remote-use') && registered.guards.length > 0,
  `commands=${[...registered.commands.keys()].join(',') || '(none)'} guards=${registered.guards.length}`)
check('injected into webServer for the settings route',
  registered.injects.some((d) => Array.isArray(d) && d.includes('webServer')))

// ---- effects must have run during apply() (Cordis runs them immediately) ---
console.log('')
const failedEffects = registered.effects.filter((e) => e.error !== undefined)
check('every effect ran without throwing', failedEffects.length === 0,
  failedEffects.map((e) => `${e.label}: ${e.error?.message}`).join('; ') || `${registered.effects.length} effects`)
check('effects are disposable', registered.effects.every((e) => typeof e.dispose === 'function'))

// ---- disposers must be safe to call (plugin disable path) -----------------
let disposeRun = 0
for (const e of registered.effects) {
  try { e.dispose(); disposeRun += 1 } catch (error) {
    check(`disposer for "${e.label}" runs`, false, error?.message)
  }
}
check('all disposers run without throwing', disposeRun === registered.effects.length,
  `${disposeRun}/${registered.effects.length}`)

// ---- logs ----------------------------------------------------------------
const warnings = logLines.filter(([lvl]) => lvl === 'warn' || lvl === 'error')
if (warnings.length > 0) {
  console.log('\n  host log (warn/error):')
  for (const [lvl, m] of warnings) console.log(`    [${lvl}] ${String(m).slice(0, 200)}`)
}

console.log(`\n===== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} =====`)
process.exit(failures === 0 ? 0 : 1)
