// probe-worker-role-live.mjs -- drive a task through THIS machine's own worker role.
//
// WHY THIS EXISTS: every other proof about the worker role is about a PART -- the listener binds,
// the ACP agent answers `initialize`, the sandbox confines, the state machine refuses when it
// should. None of that shows a TASK can be driven through it, and "the parts pass but the
// assembly never runs" is the failure this project has hit five times.
//
// IT RUNS ON LOOPBACK. This is a wiring check, not a pairing; a check that briefly opened a LAN
// port would be a worse thing to leave behind if it failed halfway.
//
// IT DOES NOT WRITE THE SETTINGS FILE: `persist` is a no-op here. The arming state's own
// persistence is covered by unit tests, and a probe has no business modifying the operator's
// configuration. It still DISARMS before exiting, so no listener is left running.
import { networkInterfaces } from 'node:os'

import { AcpBridge } from '../packages/dsh-plugin-remote-use/lib/bridge/acp-bridge.js'
import { RelaySupervisor } from '../packages/dsh-plugin-remote-use/lib/core/relay-supervisor.js'
import { WorkerArming } from '../packages/dsh-plugin-remote-use/lib/core/worker-arming.js'
import { probeSandbox } from '../packages/dsh-plugin-remote-use/lib/core/sandbox-probe.js'
import { resolveAcpLaunchSpec } from '../packages/dsh-plugin-remote-use/lib/core/self-acp-spec.js'

const PORT = Number(process.argv[2] ?? 7396)
// NOT a hard-coded credential. `arm()` mints a fresh one on every arming (decision 3, "generated
// when enabled"), so the probe must use the value it was handed. Passing a constant produced a 401
// from a listener that was working correctly -- the rotation doing exactly its job.
const ACP_PROFILE = `${process.env.USERPROFILE}\\.dsh\\profiles\\acp\\cordis.patch.yml`

const line = (s) => process.stdout.write(`${s}\n`)
let failures = 0
const check = (label, pass, detail = '') => {
  line(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` -- ${detail}`}`)
  if (!pass) failures += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const spec = resolveAcpLaunchSpec({ profile: 'acp' })
line(`install  : ${spec.ok ? spec.installDir : `NOT FOUND -- ${spec.error}`}`)
if (!spec.ok) process.exit(2)

const supervisor = new RelaySupervisor({ launchSpec: () => spec, keepShots: () => 3 })
const arming = new WorkerArming({
  interfaces: () => networkInterfaces(),
  // The REAL gate against the REAL acp profile. If this machine's confinement is broken the
  // probe refuses, and then this script proves nothing -- which is the correct outcome.
  probe: () => probeSandbox({ profile: ACP_PROFILE }),
  start: (bind, port, token) => supervisor.start(bind, port, token),
  stop: () => supervisor.stop(),
  persist: () => {}, // deliberately not touching the operator's settings file
  stored: {},
})

const pre = arming.preflight({ bindAddress: '127.0.0.1', port: PORT })
line(`preflight: ok=${pre.ok} ${JSON.stringify(pre.blockers)}`)
check('the sandbox gate passes on this machine', pre.ok === true, String(pre.probe?.reason ?? ''))

const armed = arming.arm({ bindAddress: '127.0.0.1', port: PORT })
check('arming succeeds on loopback', armed.ok === true, String(armed.error ?? ''))
if (armed.ok !== true) { supervisor.stop(); process.exit(1) }
check('a pairing string came back exactly once',
  typeof armed.pairing === 'string' && armed.pairing.startsWith('dshpair1.'))
const workerToken = String(armed.token ?? '')
check('a fresh credential was minted for this arming', workerToken !== '' && workerToken.length >= 32)
check('the status carries only a mask, never the credential',
  !JSON.stringify(arming.status()).includes(workerToken)
  && arming.status().tokenHint.endsWith(workerToken.slice(-4)))

// The listener needs a moment to bind and to start the ACP agent behind it.
let health = ''
for (let i = 0; i < 20; i += 1) {
  await sleep(500)
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(2_000) })
    health = await res.text()
    if (res.ok) break
  } catch { /* not up yet */ }
}
check('the listener answers /healthz', health.includes('"ok":true'), health.slice(0, 90))

// A wrong credential must be refused. The relay's own token check is what makes the pairing
// string a credential rather than a label.
let refused = false
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/screenshot`, { signal: AbortSignal.timeout(5_000) })
  refused = res.status === 401
} catch { /* recorded below */ }
check('an unauthenticated request is refused with 401', refused)

// THE DECISIVE PART: the master's own protocol, against this machine's own worker role.
const bridge = new AcpBridge({ url: `ws://127.0.0.1:${PORT}`, token: workerToken, approvalTimeoutMs: 30_000 })
let report = null
try {
  await bridge.connect()
  check('the master protocol connected and completed the ACP handshake', true)
  report = await bridge.selfcheck({ timeoutMs: 60_000 })
} catch (error) {
  check('the master protocol connected and completed the ACP handshake', false, String(error?.message ?? error))
}

line(`  selfcheck: ${JSON.stringify(report).slice(0, 200)}`)
check('a worker self-check ran through the listener (the ACP agent answered)',
  report !== null && report.verdict !== undefined, String(report?.error ?? report?.verdict ?? ''))

// What the verdict actually rests on. The reference worker reports `ready`; this machine reported
// `blocked` with four failures WHILE A TASK STILL COMPLETED. A readiness report that does not
// predict the thing it is named after is worth looking at, not averaging away, so the failing
// checks are printed in full.
if (Array.isArray(report?.checks)) {
  const blocking = report.checks.filter((c) => c?.blocking === true)
  line(`  checks: ${report.checks.length} total, ${blocking.length} blocking; verdict=${report.verdict}`)
  for (const c of report.checks) {
    const failed = c?.blocking === true || c?.status === 'fail' || c?.ok === false
    if (!failed) continue
    line(`    ${c?.blocking === true ? 'BLOCKING' : 'warn    '} ${String(c?.id ?? c?.name ?? '?')} | expected=${String(c?.expected ?? '').slice(0, 40)} actual=${String(c?.actual ?? c?.detail ?? '').slice(0, 70)}`)
  }
}

// And a real prompt, which is the thing the feature exists for.
let result = null
try {
  result = await bridge.startTask({ cwd: process.cwd(), prompt: 'Reply with exactly: DONE' })
} catch (error) {
  result = { stopReason: 'error', diagnostic: String(error?.message ?? error) }
}
line(`  task: stopReason=${result?.stopReason} output=${JSON.stringify(result?.output?.[0]?.text ?? '').slice(0, 90)}`)
check('a task ran to completion on this machine acting as its own worker',
  result?.stopReason === 'completed', String(result?.stopReason ?? '') + ' ' + String(result?.diagnostic ?? '').slice(0, 120))

try { await bridge.dispose() } catch { /* best effort */ }

// Never leave a listener running.
const stopped = arming.disarm({ forget: true })
check('the local stop ran', stopped.wasArmed === true)
await sleep(800)
let released = false
try {
  await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1_500) })
} catch { released = true }
check('the port was released', released)
check('the credential was discarded in memory', arming.status().tokenSet === false)

line('')
line(failures === 0 ? 'RESULT: OK -- this machine works as its own worker.' : `RESULT: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
