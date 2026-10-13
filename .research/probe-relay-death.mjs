// probe-relay-death.mjs -- what happens when the worker dies MID-TASK.
//
// WHY THIS SPECIFIC PATH: every other test drives a worker that is up. A task that never settles
// does not merely fail -- it holds the delegation queue, so a dead worker takes the plugin down
// with it until DSH restarts. That is a worse outcome than an error, and nothing in this project
// has ever exercised it.
//
// It uses a REAL relay on loopback (started by tools/arm-loopback-worker.mjs) and kills it while a
// turn is in flight, then asks two questions:
//
//   1. does the in-flight task SETTLE, or does it hang?
//   2. does the NEXT call reconnect on its own, or stay dead?
//
// Usage: node .research/probe-relay-death.mjs <ws-url> <token> <relay-pid>
import { execFileSync } from 'node:child_process'

import { AcpBridge } from '../packages/dsh-plugin-remote-use/lib/bridge/acp-bridge.js'

const [url, token, pidArg] = process.argv.slice(2)
if (url === undefined || token === undefined || pidArg === undefined) {
  process.stderr.write('usage: node probe-relay-death.mjs <ws-url> <token> <relay-pid>\n')
  process.exit(2)
}
const pid = Number(pidArg)

const line = (s) => process.stdout.write(`${s}\n`)
let failures = 0
const check = (label, ok, detail = '') => {
  line(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` -- ${detail}`}`)
  if (!ok) failures += 1
}
const kill = (signal) => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(pid, signal ?? 'SIGKILL')
  } catch { /* already gone */ }
}

const bridge = new AcpBridge({ url, token, approvalTimeoutMs: 10_000 })
await bridge.connect()
check('connected to the worker', true)

// A turn that cannot finish quickly, so the kill lands inside it rather than before it starts.
const prompt = 'Run the shell command `Start-Sleep -Seconds 60` using the pwsh tool, then say DONE.'
const startedAt = Date.now()
const pending = bridge.startTask({ cwd: process.cwd(), prompt })
  .then((result) => ({ settled: true, result }))
  .catch((error) => ({ settled: true, error: String(error?.message ?? error) }))

line('  task started; killing the worker in 4s')
await new Promise((r) => setTimeout(r, 4_000))
kill()
line(`  worker killed at +${Date.now() - startedAt} ms`)

// `settled: false` here is the failure that matters: the promise never resolving means the
// delegation queue never releases its slot.
const outcome = await Promise.race([
  pending,
  new Promise((r) => setTimeout(() => r({ settled: false }), 75_000)),
])
const waited = Date.now() - startedAt

check('the in-flight task SETTLES instead of hanging', outcome.settled === true, `after ${waited} ms`)
line(`  outcome: ${JSON.stringify(outcome.result ?? outcome.error ?? '(never settled)').slice(0, 180)}`)
check('it did not report success', outcome.result?.stopReason !== 'completed',
  String(outcome.result?.stopReason ?? ''))
check('it did not take longer than the bridge is willing to wait', waited < 75_000, `${waited} ms`)

try { await bridge.dispose() } catch { /* the socket is gone */ }

// THE BOOKKEEPING MUST MATCH REALITY. The settings page shows `connection.connected`, so a link
// that died but still reports connected is worse than no indicator at all: the operator restarts
// the wrong thing. `PeerConnection` is what the plugin actually uses, so this drives THAT.
const { PeerConnection } = await import('../packages/dsh-plugin-remote-use/lib/bridge/peer-connection.js')
let peer = null
try {
  peer = new PeerConnection({
    peerId: 'death-probe',
    token,
    httpBase: url.replace(/^ws/, 'http'),
    heartbeatMs: 0,
    createBridge: () => new AcpBridge({ url, token, approvalTimeoutMs: 5_000 }),
  })
  // The relay is dead, so this must fail -- and the failure has to be RECORDED, or the page shows
  // a healthy worker.
  let threw = false
  try { await peer.ensure() } catch { threw = true }
  const stats = peer.stats ?? peer.connection?.stats ?? {}
  check('a connect attempt against the dead worker fails', threw === true)
  check('and the failure is recorded in the stats the page reads',
    (stats.connectFailures ?? 0) >= 1, JSON.stringify(stats).slice(0, 160))
  check('the link is not reported as connected', stats.connected !== true, JSON.stringify({ connected: stats.connected }))
} catch (error) {
  check('the PeerConnection path is exercisable', false, String(error?.message ?? error).slice(0, 160))
} finally {
  try { await peer?.dispose() } catch { /* best effort */ }
}

line('')
line(failures === 0 ? 'RESULT: OK -- a dying worker fails the task instead of wedging the queue.' : `RESULT: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
