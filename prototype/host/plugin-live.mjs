#!/usr/bin/env node
/**
 * plugin-live.mjs -- the plugin AS MOUNTED, against the REAL worker.
 *
 * This is the combination the other checks each missed a half of:
 *
 *   plugin-smoke.mjs  mounts apply() but never touches a worker.
 *   realmachine.mjs   touches a real worker but builds its own bridge, pre-connected.
 *
 * Between them, two bugs shipped: tools whose parameter schema had no root type, and a
 * bridge that was never connected. Both are invisible to either half. This script closes
 * the gap: it runs the REAL apply() from the INSTALLED location, takes the provider it
 * registers, and drives the real relay with it.
 *
 * Usage:
 *   node plugin-live.mjs --url ws://192.168.1.101:7331 --token <secret> --cwd C:\dsh-remote\p0work
 */
import { pathToFileURL } from 'node:url'

const INSTALLED = 'C:\\Users\\you\\.dsh\\profiles\\desktop\\node_modules\\dsh-plugin-remote-use\\lib\\index.js'

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const PORT = Number(arg('port', '7331'))
const HOST = arg('host', '192.168.1.101')
const URL_ = arg('url', `ws://${HOST}:${PORT}`)
const TOKEN = arg('token', '')
const CWD = arg('cwd', 'C:\\dsh-remote\\p0work')
const PROMPT = arg('prompt',
  'Create a file named plugin-live-proof.txt in the current working directory containing exactly LIVE_OK, '
  + 'then read it back and report the exact content.')
const entry = pathToFileURL(arg('entry', INSTALLED)).href

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail === '' ? '' : ' -- ' + detail}`)
  if (!ok) failures += 1
}

// ---------------------------------------------------------------------------
// Mount the plugin exactly as the host does
// ---------------------------------------------------------------------------
const mounted = { providers: [], tools: [], routes: [], sections: [], logs: [], effects: [] }

function makeEffectHost(target) {
  let n = 0
  return (fn, label) => {
    n += 1
    const name = label ?? `effect#${n}`
    try {
      const dispose = fn()
      target.push({ label: name, dispose: typeof dispose === 'function' ? dispose : () => {} })
    } catch (error) {
      target.push({ label: name, dispose: () => {}, error })
      throw error
    }
    return () => {}
  }
}

function makeCtx() {
  return {
    logger: {
      info: (m) => mounted.logs.push(['info', m]),
      warn: (m) => mounted.logs.push(['warn', m]),
      error: (m) => mounted.logs.push(['error', m]),
    },
    effect: makeEffectHost(mounted.effects),
    subagents: { registerProvider: (p) => { mounted.providers.push(p); return () => {} } },
    tools: { register: (d) => { mounted.tools.push(d); return () => {} } },
    systemPrompt: { getSectionOrder: () => 100, section: (d) => { mounted.sections.push(d); return () => {} } },
    inject: (deps, cb) => cb({
      effect: makeEffectHost(mounted.effects),
      webServer: { register: (r) => { mounted.routes.push(r); return () => {} } },
    }),
  }
}

console.log(`entry : ${entry}`)
console.log(`worker: ${URL_}\n`)

const mod = await import(entry)

// Rebuild the settings route so its liveness can be checked too: createWorkerRuntime is
// not exported, so the route is exercised through the injected webServer registration.
mod.apply(makeCtx(), {
  workers: [{
    id: 'worker-pc',
    name: 'worker-pc',
    url: URL_,
    token: TOKEN,
    cwd: CWD,
    enabled: true,
    serialQueue: 1,
  }],
  approvalTimeoutMs: 90_000,
  requiredTier: 'workspace-write',
  toolPrefix: 'subagent_remote',
  injectTaskSummary: true,
})

check('apply() registered a provider', mounted.providers.length === 1, `got ${mounted.providers.length}`)
const provider = mounted.providers[0]
if (provider === undefined) {
  console.log('\nno provider to drive -- stopping')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 1. The plugin's own self-check path (this is what the settings route calls)
// ---------------------------------------------------------------------------
console.log('=== 1. self-check through the mounted plugin (lazy connect) ===')
const route = mounted.routes[0]
check('a settings route was registered', route !== undefined && typeof route.handler === 'function')

if (route !== undefined) {
  const body = await new Promise((resolve, reject) => {
    const chunks = []
    const res = {
      writeHead: () => {},
      end: (s) => { chunks.push(s); resolve(chunks.join('')) },
    }
    const req = { method: 'GET' }
    Promise.resolve(route.handler(req, res)).catch(reject)
    setTimeout(() => reject(new Error('settings route timed out')), 120_000)
  }).catch((e) => `ERROR:${e.message}`)

  if (typeof body === 'string' && body.startsWith('ERROR:')) {
    check('settings route answered', false, body)
  } else {
    const parsed = JSON.parse(body)
    const w = parsed.workers?.[0]
    console.log(`  connection: ${JSON.stringify(w?.connection)}`)
    console.log(`  report    : verdict=${w?.report?.verdict} blocking=${w?.report?.blockingFailures} session=${w?.report?.sessionSegment}`)
    for (const c of w?.report?.checks ?? []) {
      const mark = c.status === 'pass' ? 'OK  ' : c.status === 'fail' ? 'FAIL' : c.status === 'warn' ? 'WARN' : '??  '
      console.log(`    [${mark}] ${c.id} ${c.name} | ${String(c.actual).slice(0, 90)}`)
    }
    check('the link actually connected (this is the bug that shipped)', w?.connection?.connected === true,
      JSON.stringify(w?.connection))
    check('no connect failures', (w?.connection?.connectFailures ?? 1) === 0)
    check('self-check reports ready', w?.report?.verdict === 'ready', String(w?.report?.verdict))
    check('no blocking findings', (w?.report?.blockingFailures ?? 1) === 0)
  }
}

// ---------------------------------------------------------------------------
// 2. A real delegation through the mounted provider
// ---------------------------------------------------------------------------
console.log('\n=== 2. delegation through the mounted provider ===')
const registry = mounted.tools.length // just to prove tools exist below
check('the three remote tools are registered', mounted.tools.length === 3, `got ${mounted.tools.length}`)

const t0 = Date.now()
const run = await provider.start({
  label: 'plugin-live',
  prompt: [{ type: 'text', text: PROMPT }],
  parent: { id: 'plugin-live-parent' },
})
check('start() resolved (the gate let it through)', typeof run?.id === 'string', String(run?.id))
console.log(`  taskId = ${run.id}`)
const result = await run.result
console.log(`  stopReason = ${result.stopReason}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
console.log(`  output     = ${JSON.stringify(result.output?.[0]?.text ?? '').slice(0, 260)}`)
if (result.diagnostic !== undefined) console.log(`  diagnostic = ${result.diagnostic}`)
check('the delegated task completed', result.stopReason === 'completed', String(result.stopReason))
check('assistant output came back', (result.output?.[0]?.text ?? '').length > 0)
void registry

// ---------------------------------------------------------------------------
// 3. Teardown
// ---------------------------------------------------------------------------
console.log('\n=== 3. teardown ===')
let disposed = 0
for (const e of mounted.effects) {
  try { e.dispose(); disposed += 1 } catch (error) {
    check(`disposer "${e.label}" runs`, false, error?.message)
  }
}
check('every disposer ran', disposed === mounted.effects.length, `${disposed}/${mounted.effects.length}`)

const warnings = mounted.logs.filter(([l]) => l === 'warn' || l === 'error')
if (warnings.length > 0) {
  console.log('\n  host log (warn/error):')
  for (const [l, m] of warnings) console.log(`    [${l}] ${String(m).slice(0, 180)}`)
}

console.log(`\n===== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} =====`)
process.exit(failures === 0 ? 0 : 1)
