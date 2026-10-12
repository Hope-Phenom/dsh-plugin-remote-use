#!/usr/bin/env node
/**
 * realmachine.mjs -- REAL end-to-end check: the plugin's own modules against the REAL worker.
 *
 * Everything here is the production code path -- no fake ACP agent, no stubs:
 *
 *   RemoteProvider (lib/provider)  -> real SubagentProvider implementation
 *   AcpBridge      (lib/bridge)    -> real ACP-over-WebSocket client
 *   decideApproval (lib/core)      -> real review engine
 *   TaskRegistry   (lib/core)      -> real visibility channel
 *
 * What it proves that the unit/integration tests cannot:
 *   - the worker's relay answers `dsh-remote/selfcheck` over the LAN
 *   - the dispatch gate reads that report and lets a green worker through
 *   - a real task runs on the worker, its tool calls are observed, and it settles
 *
 * Usage:
 *   node realmachine.mjs --url ws://192.168.1.101:7331 --token <secret> --cwd C:\dsh-remote\p0work
 */
import { AcpBridge } from '../../packages/dsh-plugin-remote-use/lib/bridge/acp-bridge.js'
import { RemoteProvider } from '../../packages/dsh-plugin-remote-use/lib/provider/remote-provider.js'
import { TaskRegistry } from '../../packages/dsh-plugin-remote-use/lib/core/task-registry.js'
import { TaskMemory } from '../../packages/dsh-plugin-remote-use/lib/core/task-memory.js'
import { decideApproval, inferRequiredTier } from '../../packages/dsh-plugin-remote-use/lib/core/review-engine.js'

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const URL_ = arg('url', 'ws://192.168.1.101:7331')
const TOKEN = arg('token', 'p0test')
const CWD = arg('cwd', 'C:\\dsh-remote\\p0work')
const PROMPT = arg('prompt',
  'Create a file named plugin-proof.txt in the current working directory containing exactly the text MADE_BY_PLUGIN. '
  + 'Then read it back and report the exact content.')

const t0 = Date.now()
const t = () => `+${String(Date.now() - t0).padStart(6)}ms`
const say = (...a) => console.log(t(), ...a)

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail === '' ? '' : ' -- ' + detail}`)
  if (!ok) failures += 1
}

// ---------------------------------------------------------------------------
// 1. bridge + real self-check over the LAN
// ---------------------------------------------------------------------------
const bridge = new AcpBridge({ url: URL_, token: TOKEN, approvalTimeoutMs: 90_000 })
const registry = new TaskRegistry({})
const memory = new TaskMemory('realmachine')
const audit = []

const provider = new RemoteProvider({
  peer: {
    peerId: 'worker-pc',
    name: 'worker-pc',
    bridge,
    defaultCwd: CWD,
    selfcheck: () => bridge.selfcheck({ maxAgeMs: 0 }),
  },
  registry,
  serialQueue: 1,
  workspaceRoot: CWD,
  decideApproval: (req) => {
    // The production wiring: required tier is derived PER APPROVAL from the actual call
    // (DESIGN §8.3), not taken from a fixed config value.
    const requiredTier = inferRequiredTier(req.rawInput, {
      workspaceRoot: CWD, toolName: req.toolName, defaultTier: 'workspace-write',
    })
    const d = decideApproval(req, {
      memory,
      policy: { requiredTier, workspaceRoot: CWD, allowedPaths: [CWD] },
    })
    audit.push({ ...d, requiredTier, toolName: req.toolName })
    return d
  },
})

try {
  say(`connecting ${URL_}`)
  const init = await bridge.connect()
  say(`connected: agent=${init.agentInfo?.name}@${init.agentInfo?.version}`)

  console.log('\n=== 1. dsh-remote/selfcheck over the LAN ===')
  const report = await bridge.selfcheck({ maxAgeMs: 0 })
  console.log(`  verdict=${report.verdict} blocking=${report.blockingFailures} warn=${report.warnings} `
    + `sessionSegment=${report.sessionSegment} session=${report.sessionId} interactive=${report.interactive}`)
  for (const c of report.checks ?? []) {
    const mark = c.status === 'pass' ? 'OK  ' : c.status === 'fail' ? 'FAIL' : c.status === 'warn' ? 'WARN' : '??  '
    console.log(`    [${mark}] ${c.id} ${c.name} | ${c.actual}`)
  }
  check('self-check returns a verdict', typeof report.verdict === 'string', report.verdict)
  check('worker reports an interactive session', report.sessionSegment === 'ok', String(report.sessionSegment))
  check('S8 live input injection passed', (report.checks ?? []).find((c) => c.id === 'S8')?.status === 'pass')
  check('no blocking failures', (report.blockingFailures ?? 1) === 0, String(report.blockingFailures))

  // -------------------------------------------------------------------------
  // 2. dispatch through the REAL provider (exercises the gate)
  // -------------------------------------------------------------------------
  console.log('\n=== 2. dispatch through RemoteProvider ===')
  say(`provider name = ${provider.name}`)
  check('provider advertises no capabilities (C1)', Object.values(provider.capabilities).every((v) => v === false))
  check('provider does not inherit parent context (C6)', provider.inheritsParentContext === false)
  check('provider exposes no prepareContinuable (C2)', provider.prepareContinuable === undefined)

  const run = await provider.start({
    label: 'realmachine',
    prompt: [{ type: 'text', text: PROMPT }],
    parent: { id: 'realmachine-parent' },
  })
  check('run keeps localAgent undefined (C3)', run.localAgent === undefined)
  say(`taskId = ${run.id}`)

  const result = await run.result

  console.log('\n=== 3. result ===')
  console.log(`  stopReason = ${result.stopReason}`)
  console.log(`  output     = ${JSON.stringify(result.output?.[0]?.text ?? '').slice(0, 400)}`)
  if (result.diagnostic !== undefined) console.log(`  diagnostic = ${result.diagnostic}`)
  check('task completed', result.stopReason === 'completed', result.stopReason)
  check('assistant output was collected', (result.output?.[0]?.text ?? '').length > 0)

  console.log('\n=== 4. TaskRegistry (the C3 visibility patch) ===')
  const task = registry.get(run.id)
  console.log(`  state=${task.state} toolCalls=${task.toolCallCount} recent=[${task.recentTools.join(', ')}] usage=${JSON.stringify(task.usage)}`)
  check('registry settled the task', task.state === 'completed', task.state)
  check('tool calls were observed', task.toolCallCount > 0, String(task.toolCallCount))
  check('tool names are populated (not undefined)', task.recentTools.every((n) => typeof n === 'string' && n !== ''))

  console.log('\n=== 5. approval decisions ===')
  if (audit.length === 0) console.log('  (none this run: an in-workspace write needs no escalation)')
  for (const d of audit) {
    console.log(`  tool=${d.toolName} required=${d.requiredTier} -> ${d.optionId} (source=${d.source} needsHuman=${d.needsHuman})`)
  }
  check('no approval was auto-allowed beyond policy', audit.every((d) => d.optionId !== 'allow-once' || d.source === 'policy' || d.source === 'memory'))

  console.log('\n=== 6. bridge stats ===')
  console.log('  ' + JSON.stringify(bridge.stats))
} catch (e) {
  console.error(`\n!! FAILED: ${e?.constructor?.name}: ${e?.message}`)
  if (e?.stack) console.error(String(e.stack).split('\n').slice(0, 6).join('\n'))
  failures += 1
} finally {
  await bridge.dispose().catch(() => {})
}

console.log(`\n===== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} =====`)
process.exit(failures === 0 ? 0 : 1)
