#!/usr/bin/env node
/**
 * probe-heartbeat.mjs -- does a relay restart still break the next call?
 *
 * REGRESSION CONTEXT: `AcpBridge` does not watch its socket, and the relay closes it on
 * restart, so `connected` kept reporting true over a dead link and the FIRST call after a
 * worker restart failed. (On the real worker it surfaced as the misleading "nobody is
 * logged in" message.) The heartbeat should notice the death between calls, so every
 * self-check below must succeed on its first attempt.
 *
 * Run this as a background job, restart the relay from elsewhere while it watches, then
 * read the output.
 *
 * Usage: node probe-heartbeat.mjs --url ws://host:7331 --token <secret> [--seconds 70] [--every 3000]
 */
import { PeerConnection, httpBaseOf } from '../../packages/dsh-plugin-remote-use/lib/bridge/peer-connection.js'
import { AcpBridge } from '../../packages/dsh-plugin-remote-use/lib/bridge/acp-bridge.js'

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const URL_ = arg('url', 'ws://192.168.1.101:7331')
const TOKEN = arg('token', '')
const SECONDS = Number(arg('seconds', '70'))
const EVERY = Number(arg('every', '3000'))
const HEARTBEAT = Number(arg('heartbeat', '3000'))

const log = []
const say = (s) => {
  const line = `+${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s  ${s}`
  log.push(line)
  console.log(line)
}
const t0 = Date.now()

const conn = new PeerConnection({
  peerId: 'heartbeat-probe',
  httpBase: httpBaseOf(URL_),
  token: TOKEN,
  heartbeatMs: HEARTBEAT,
  heartbeatTimeoutMs: 2000,
  log: (level, message) => say(`  [${level}] ${message}`),
  createBridge: () => new AcpBridge({ url: URL_, token: TOKEN, approvalTimeoutMs: 30_000 }),
})

let checks = 0
let failures = 0
let failuresAfterDrop = 0
let sawDrop = false
let connectsAtStart = 0

// First check: establishes the link.
{
  const r = await conn.selfcheck({ maxAgeMs: 30_000 }).catch((e) => ({ error: e.message }))
  connectsAtStart = conn.connects
  if (r.error !== undefined) { failures += 1; say(`check#1 FAILED: ${r.error}`) } else { checks += 1; say(`check#1 ok verdict=${r.verdict}`) }
}

say(`watching for ${SECONDS}s, selfcheck every ${EVERY}ms, heartbeat ${HEARTBEAT}ms`)
say('>>> restart the relay now if you have not already <<<')

const deadline = Date.now() + SECONDS * 1000
let n = 1
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, EVERY))
  n += 1
  const before = conn.connects
  const r = await conn.selfcheck({ maxAgeMs: 30_000 }).catch((e) => ({ error: e.message }))
  const reconnected = conn.connects > before

  if (conn.heartbeatFailures > 0 && !sawDrop) {
    sawDrop = true
    say(`--- the link dropped and the heartbeat noticed (heartbeatFailures=${conn.heartbeatFailures}) ---`)
  }

  if (r.error !== undefined) {
    failures += 1
    if (sawDrop) failuresAfterDrop += 1
    say(`check#${n} FAILED: ${r.error}`)
  } else {
    checks += 1
    say(`check#${n} ok verdict=${r.verdict} connected=${conn.connected} connects=${conn.connects}` +
      ` heartbeats=${conn.heartbeats} hbFailures=${conn.heartbeatFailures}` +
      (reconnected ? '  <-- RECONNECTED cleanly' : ''))
  }
}

console.log('\n===== summary =====')
console.log(`selfchecks: ${checks} ok, ${failures} failed`)
console.log(`heartbeat failures: ${conn.heartbeatFailures}; total connects: ${conn.connects} (was ${connectsAtStart})`)
console.log(`link dropped during the run: ${sawDrop}`)
if (sawDrop) {
  console.log(`failed checks AFTER the drop was noticed: ${failuresAfterDrop}`)
  console.log(failuresAfterDrop === 0
    ? 'PASS: the heartbeat absorbed the restart -- no user-visible failure.'
    : `FAIL: ${failuresAfterDrop} check(s) still failed after the drop.`)
} else {
  console.log('INCONCLUSIVE: the relay never went away, so nothing was exercised.')
}

await conn.dispose()
process.exit(0)
