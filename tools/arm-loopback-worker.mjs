#!/usr/bin/env node
/**
 * arm-loopback-worker.mjs -- arm THIS machine as its own worker, on loopback, and hold.
 *
 * WHY: `plugin-live.mjs` is the only harness that exercises the real protocol against a real
 * worker, and it needs a worker to point at. The reference worker is a second machine that is
 * often powered off, which meant the live harness could not be run at all -- and a harness nobody
 * can run stops being a check.
 *
 * Since the plugin can now act as a worker itself (DESIGN section 16), the second machine is
 * optional: arm on 127.0.0.1 and point the live harness at it. Nothing is exposed beyond loopback.
 *
 * It deliberately does NOT write the settings file (`persist` is a no-op) and it always disarms on
 * exit, including on SIGINT, so a crashed run cannot leave a listener behind or a stored `armed`
 * for the next DSH start to restore.
 *
 * ⚠️ KNOWN FALSE NEGATIVE WHEN STARTED FROM INSIDE THE DSH SANDBOX.
 *
 * This helper is normally launched by an agent's shell, which DSH confines. The relay inherits that
 * confinement, and the worker self-check then reports `S8 SendInput / SetCursorPos live` as a
 * BLOCKING failure -- `SetCursorPos` returns false, because a restricted token cannot inject input
 * into a higher-integrity foreground window (UIPI).
 *
 * Measured both ways on the same machine, minutes apart:
 *
 *   confined   (this shell)                    -> verdict=blocked, S8 fail  (set=False)
 *   unconfined (scheduled task, pwsh 7)        -> verdict=warn,    S8 pass  (ok)
 *
 * So S8 failing here says something about the HARNESS, not about the host. A worker started the way
 * a real worker is started -- a scheduled task -- passes. Use `--unconfined-hint` (or read this
 * comment) before chasing it as a host problem; `<tools>\run-unconfined.ps1` does the scheduled-task
 * dance for you.
 *
 * Usage:
 *   node tools/arm-loopback-worker.mjs --port 7398 --stop-file <path>
 *   # prints one JSON line on stdout when it is ready: {"url":"ws://127.0.0.1:7398","token":"..."}
 *   # then keeps running until the stop file appears, SIGINT/SIGTERM, or --hold-ms expires.
 *
 * THE STOP SIGNAL IS A FILE, NOT STDIN. The first version watched `process.stdin` for `end`, on the
 * theory that the driver closing it is a portable "please stop". It is not: a background process
 * started without a terminal gets an already-closed stdin, so `end` fired immediately and the
 * helper disarmed itself the moment it announced it was ready. The live harness then connected to
 * nothing and reported a dead link -- a harness failure that looked exactly like a product failure.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import { RelaySupervisor } from '../packages/dsh-plugin-remote-use/lib/core/relay-supervisor.js'
import { WorkerArming } from '../packages/dsh-plugin-remote-use/lib/core/worker-arming.js'
import { probeSandbox } from '../packages/dsh-plugin-remote-use/lib/core/sandbox-probe.js'
import { resolveAcpLaunchSpec } from '../packages/dsh-plugin-remote-use/lib/core/self-acp-spec.js'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

// Everything has a DEFAULT, and the announcement goes to a FILE as well as stdout.
//
// WHY THE DEFAULTS MATTER: the useful case is starting this through a scheduled task, to get the
// relay out of the DSH sandbox (`tools/run-unconfined.ps1`). Passing a space-separated argument
// string across that boundary does not survive -- `pwsh -File script.ps1 -NodeArguments "a b"` binds
// the value as a missing argument, which was measured. A helper that needs no arguments has nothing
// to lose in transit, and the announcement file means the caller can still learn the minted token.
const STATE_DIR = join(tmpdir(), 'dsh-plugin-remote-use')
const PORT = Number(arg('port', '7398'))
const PROFILE = arg('profile', `${process.env.USERPROFILE}\\.dsh\\profiles\\acp\\cordis.patch.yml`)
const HOLD_MS = Number(arg('hold-ms', String(15 * 60 * 1000)))
const ANNOUNCE_FILE = arg('announce-file', join(STATE_DIR, 'arm-announce.json'))
const STOP_FILE = arg('stop-file', join(STATE_DIR, 'arm-stop.signal'))
const TOKEN = arg('token', `loopback-${process.pid}-${Math.floor(Date.now() / 1000)}`)

const log = (m) => process.stderr.write(`[arm-loopback] ${m}\n`)
const die = (code, m) => { log(m); process.exit(code) }

const spec = resolveAcpLaunchSpec({ profile: 'acp' })
if (spec.ok !== true) die(2, `cannot resolve the acp launch spec: ${spec.error}`)
log(`install: ${spec.installDir}`)

const supervisor = new RelaySupervisor({ launchSpec: () => spec, keepShots: () => 5 })
const arming = new WorkerArming({
  interfaces: () => networkInterfaces(),
  probe: () => probeSandbox({ profile: PROFILE }),
  start: (bind, port, token) => supervisor.start(bind, port, token),
  stop: () => supervisor.stop(),
  persist: () => {}, // a harness must not touch the operator's settings file
  mint: () => TOKEN,
  stored: {},
})

const pre = arming.preflight({ bindAddress: '127.0.0.1', port: PORT })
if (pre.ok !== true) die(1, `the sandbox gate refused: ${JSON.stringify(pre.blockers)}`)

const armed = arming.arm({ bindAddress: '127.0.0.1', port: PORT })
if (armed.ok !== true) die(1, `arming failed: ${armed.error}`)

// Wait for the listener to answer before announcing readiness -- a harness that connects on the
// strength of an announcement must not race the bind.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let up = false
for (let i = 0; i < 30; i += 1) {
  await sleep(300)
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1500) })
    if (res.ok) { up = true; break }
  } catch { /* not yet */ }
}
if (!up) { arming.disarm({ forget: true }); die(1, 'the listener never answered /healthz') }

// The ONE line the driver parses, on stdout AND in the file. stdout is for a caller that started us
// directly; the file is for a caller that started us through a scheduled task, where stdout belongs
// to the task and never comes back.
const announcement = JSON.stringify({ url: `ws://127.0.0.1:${PORT}`, token: TOKEN, port: PORT, pairing: armed.pairing, pid: process.pid })
try {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(ANNOUNCE_FILE, `${announcement}\n`, 'utf8')
} catch (error) {
  log(`WARNING: could not write the announcement file (${error.message}); a caller that started us indirectly cannot learn the token`)
}
process.stdout.write(`${announcement}\n`)
log(`armed on 127.0.0.1:${PORT}; holding up to ${Math.round(HOLD_MS / 1000)}s`)
log(`announcement: ${ANNOUNCE_FILE}`)

let stopping = false
const shutdown = (why) => {
  if (stopping) return
  stopping = true
  log(`stopping (${why})`)
  try { arming.disarm({ forget: true }) } catch { /* best effort */ }
  log(`armed=${arming.status().armed} tokenSet=${arming.status().tokenSet}`)
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
// Polled rather than watched: a watch on a file that does not exist yet has to be re-armed after
// every event, and the polling interval is far below the cost of a run.
try { rmSync(STOP_FILE, { force: true }) } catch { /* fine */ }
{
  const timer = setInterval(() => { if (existsSync(STOP_FILE)) shutdown('stop file') }, 400)
  timer.unref?.()
}
setTimeout(() => shutdown('hold budget expired'), HOLD_MS)
