// probe-supervisor-live.mjs -- start the worker listener for real, prove it answers, stop it.
//
// WHY: the unit tests inject `spawn`, so they prove the argv is built correctly and nothing more.
// The claims that matter here -- that this machine's ACP agent can be launched behind the relay,
// that the relay binds where it was told, and that stop actually releases the port -- only exist
// when a process really runs.
//
// It binds LOOPBACK deliberately. This probe is not a pairing; it is a wiring check, and a check
// that briefly opened a LAN port would be a worse thing to leave running if it failed halfway.
import { RelaySupervisor } from '../packages/dsh-plugin-remote-use/lib/core/relay-supervisor.js'
import { resolveAcpLaunchSpec } from '../packages/dsh-plugin-remote-use/lib/core/self-acp-spec.js'

const PORT = Number(process.argv[2] ?? 7398)
const TOKEN = 'probe-token-not-a-secret'

const spec = resolveAcpLaunchSpec({})
console.log(`install   : ${spec.ok ? spec.installDir : `NOT FOUND -- ${spec.error}`}`)
if (!spec.ok) process.exit(2)

const supervisor = new RelaySupervisor({ launchSpec: () => spec })
console.log('starting the listener on 127.0.0.1 ...')
const { pid } = supervisor.start('127.0.0.1', PORT, TOKEN)
console.log(`pid       : ${pid}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let healthy = false

// The relay needs a moment to bind and to start the ACP agent behind it.
for (let attempt = 1; attempt <= 20 && !healthy; attempt += 1) {
  await sleep(500)
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(2_000) })
    const body = await res.text()
    console.log(`healthz   : HTTP ${res.status} ${body.slice(0, 120)}`)
    healthy = res.ok
  } catch (error) {
    if (attempt === 20) console.log(`healthz   : never answered (${error.message})`)
  }
}

// The relay must refuse an unauthenticated plugin RPC, or the token is decorative.
let guarded = false
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/screenshot`, { signal: AbortSignal.timeout(5_000) })
  guarded = res.status === 401
  console.log(`auth      : GET /screenshot without a token -> HTTP ${res.status}${guarded ? ' (refused)' : ' (ACCEPTED -- the token is decorative)'}`)
} catch (error) {
  console.log(`auth      : request failed (${error.message})`)
}

const status = supervisor.status()
console.log(`status    : running=${status.running} bind=${status.bindAddress}:${status.port} pid=${status.pid}`)
if (status.output.trim() !== '') {
  console.log('relay output:')
  for (const line of status.output.trim().split('\n').slice(0, 8)) console.log(`  ${line}`)
}

supervisor.stop()
await sleep(800)

// The port must actually be released: a listener that outlives stop() would keep accepting
// remote execution after the operator disarmed.
let released = false
try {
  await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1_500) })
} catch {
  released = true
}
console.log(`after stop: ${released ? 'the port is released' : 'STILL ANSWERING -- stop() did not release it'}`)

const ok = healthy && guarded && released
console.log('')
console.log(ok ? 'RESULT: OK -- the listener starts, answers, guards, and stops.' : 'RESULT: FAILED')
process.exit(ok ? 0 : 1)
