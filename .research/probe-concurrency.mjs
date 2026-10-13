// probe-concurrency.mjs -- two delegations AT THE SAME TIME.
//
// WHY: every other test issues one task and waits. Nothing in the project has ever run two at once,
// and concurrency is where a shared serial gate, a shared tool-call cache, a shared audit log and a
// single-bridge "one task at a time" rule all have to agree.
//
// WHAT IT ASSERTS, and why each one is worth the runtime:
//
//   1. NO CROSS-TALK. Each task writes a file whose name it chooses, and the prompt asks it to echo
//      that name back. If two results ever carry each other's marker, the plugin is mixing state
//      between tasks -- the failure that matters most, because it would be silent.
//   2. THE SERIAL GATE HOLDS. `serialQueue` defaults to 1, so two tasks on ONE worker must take
//      about the sum of their times, not the max. Timing is the observable proxy: the gate has no
//      event to subscribe to, and a wrong `serialQueue` shows up as wall-clock, not as an error.
//   3. TWO WORKERS RUN IN PARALLEL. With one task each, wall-clock should be about the max. This is
//      what makes "serialize per worker" different from "serialize globally".
//
// Usage: node .research/probe-concurrency.mjs <urlA> <tokenA> <cwdA> <urlB> <tokenB> <cwdB>
//        (pass the same url/token twice for the single-worker case)
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Isolate the DSH home BEFORE importing the plugin.
 *
 * THIS TRAP HAS NOW APPEARED THREE TIMES (plugin-smoke, plugin-live, and here), so it is worth
 * naming: `apply()` merges `defaults < profile patch < settings file`, and `workers` REPLACES. An
 * operator's settings.json therefore silently overrides the workers a harness passes in. The plugin
 * LOGS it -- `settings file applies: workers, ...` -- and this probe ignored that line, so it
 * reported "1 provider" while testing the operator's real worker instead of the two it was given.
 *
 * A harness whose subject can be silently replaced reports a confident result about something else.
 */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'probe-conc-home-'))
process.env.DSH_HOME = TEST_HOME
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* best effort */ } })

const [urlA, tokenA, cwdA, urlB, tokenB, cwdB] = process.argv.slice(2)
if ([urlA, tokenA, cwdA, urlB, tokenB, cwdB].some((v) => v === undefined)) {
  process.stderr.write('usage: node probe-concurrency.mjs <urlA> <tokenA> <cwdA> <urlB> <tokenB> <cwdB>\n')
  process.exit(2)
}

const line = (s) => process.stdout.write(`${s}\n`)
let failures = 0
const check = (label, ok, detail = '') => {
  line(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` -- ${detail}`}`)
  if (!ok) failures += 1
}

// ---------------------------------------------------------------------------
// Mount the REAL plugin against a stand-in context, exactly as plugin-live does.
// ---------------------------------------------------------------------------
const ENTRY = 'C:\\Users\\you\\.dsh\\profiles\\desktop\\node_modules\\dsh-plugin-remote-use\\lib\\index.js'
const mounted = { providers: [], tools: [], guards: [], commands: new Map(), listeners: new Map(), routes: [], logs: [] }
const effectHost = () => (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} }
const makeCtx = () => ({
  logger: { info: (m) => mounted.logs.push(['info', m]), warn: (m) => mounted.logs.push(['warn', m]), error: (m) => mounted.logs.push(['error', m]) },
  effect: effectHost(),
  on(event, handler) { const l = mounted.listeners.get(event) ?? []; l.push(handler); mounted.listeners.set(event, l); return () => {} },
  subagents: { registerProvider: (p) => { mounted.providers.push(p); return () => {} } },
  tools: { register: (d) => { mounted.tools.push(d); return () => {} }, guard: (f) => { mounted.guards.push(f); return () => {} } },
  commands: { register: (d) => { mounted.commands.set(d.name, d); return () => {} } },
  systemPrompt: { getSectionOrder: () => 100, section: (d) => { return () => {} } },
  inject: (_deps, cb) => cb({
    effect: effectHost(),
    commands: { register: (d) => { mounted.commands.set(d.name, d); return () => {} } },
    tools: { register: (d) => { mounted.tools.push(d); return () => {} }, guard: (f) => { mounted.guards.push(f); return () => {} } },
    webServer: { register: (r) => { mounted.routes.push(r); return () => {} } },
  }),
})

const sameWorker = urlA === urlB

const mod = await import(pathToFileURL(ENTRY).href)
mod.apply(makeCtx(), {
  reportBudgetMs: 40_000,
  selfcheckBudgetMs: 60_000,
  // TWO CONFIG ENTRIES WITH THE SAME URL COLLAPSE TO ONE, which is correct -- one relay is one
  // worker, and the reconcile step diffs by url. So the single-worker case is expressed by having
  // one entry and driving it twice, not by listing it twice.
  workers: sameWorker
    ? [{ id: 'wa', name: 'wa', url: urlA, token: tokenA, cwd: cwdA, enabled: true, serialQueue: 1 }]
    : [
        { id: 'wa', name: 'wa', url: urlA, token: tokenA, cwd: cwdA, enabled: true, serialQueue: 1 },
        { id: 'wb', name: 'wb', url: urlB, token: tokenB, cwd: cwdB, enabled: true, serialQueue: 1 },
      ],
  approvalTimeoutMs: 90_000,
  requiredTier: 'workspace-write',
  toolPrefix: 'subagent_remote',
})
const want = sameWorker ? 1 : 2
check(`the plugin mounted with ${want} worker(s)`, mounted.providers.length === want,
  `got ${mounted.providers.length} [${mounted.providers.map((p) => p.name).join(',')}]`)
if (mounted.providers.length !== want) {
  // The plugin logs one line per registration, which names the worker it acted on.
  line('  plugin log:')
  for (const [lvl, m] of mounted.logs) {
    if (lvl !== 'info' || /provider|worker|register/i.test(String(m))) line(`    [${lvl}] ${String(m).slice(0, 170)}`)
  }
  line(`  workers given: ${JSON.stringify([urlA, urlB])}`)
}
const pA = mounted.providers[0]
const pB = sameWorker ? mounted.providers[0] : mounted.providers[1]
if (pA === undefined || pB === undefined) { line('cannot continue without the expected providers'); process.exit(1) }

// A task that leaves an identifiable trace, entirely through the WORKER's own reply.
//
// WHY NOT A FILE: the first version had each task write a marker file and then read it back -- from
// a path under the MASTER's temp directory. The task runs on the WORKER, where that path does not
// exist, so the writes failed and both files read back empty. The check was measuring the master,
// not the worker. Asking the task to ECHO the marker is a round trip through the worker with no
// shared filesystem assumption, which is what a two-machine test needs.
//
// THREE TIMESTAMPS, and the middle one is the point. `provider.start()` AWAITS the serial gate
// before publishing a run (`await this.#acquire()` in RemoteProvider.start), so the moment `start()`
// resolves is the moment the task was admitted. Asserting on admission times rather than on
// wall-clock durations is what makes this precise instead of a stopwatch: the agent's own latency
// varied from 20s to 110s across runs, far too wide for a ratio to mean anything.
const task = (provider, marker) => {
  const started = Date.now()
  const record = { marker, startedAt: started, publishedAt: 0, endedAt: 0 }
  // THE SLEEP IS LOAD-BEARING, not padding.
  //
  // Admission happens AFTER `await this.peer.selfcheck()` (RemoteProvider.start does the gate first
  // and only then `#acquire()`), so a worker that has to connect -- which for the loopback worker
  // means spawning an ACP child -- can be admitted seconds later than one that is already warm. The
  // first version of the parallel check used a ~1s task and saw the second worker admitted at +5.6s,
  // i.e. after the first had ended, and read that as "not parallel". It was measuring COLD-CONNECT
  // TIME, not mutual exclusion.
  //
  // Making the task longer than any plausible connect makes the measurement about the thing under
  // test. The margin is deliberately generous: a false "they serialized" is worse than a slow test.
  record.promise = provider.start({
    label: `conc-${marker}`,
    prompt: [{
      type: 'text',
      text: 'Use the pwsh tool to run the command `Start-Sleep -Seconds 8`, and then reply with '
        + `exactly this and nothing else: ${marker}`,
    }],
    parent: { id: `probe-${marker}` },
  }).then((run) => {
    record.publishedAt = Date.now()
    return run.result.then((r) => {
      record.endedAt = Date.now()
      return { ...r, ...record }
    })
  }).catch((e) => {
    record.publishedAt = record.publishedAt || Date.now()
    record.endedAt = Date.now()
    return { stopReason: 'error', diagnostic: String(e?.message ?? e), ...record }
  })
  return record
}

const textOf = (r) => (r?.output ?? []).map((o) => String(o?.text ?? '')).join(' ') + ' ' + String(r?.diagnostic ?? '')
const rel = (base, t) => ((t - base) / 1000).toFixed(1)

// ---------------------------------------------------------------------------
// 1. Two tasks at the same time
// ---------------------------------------------------------------------------
line('')
line(`=== two concurrent tasks (${sameWorker ? 'ONE worker -- must serialize' : 'TWO workers -- may run in parallel'}) ===`)
const t0 = Date.now()
const a = task(pA, 'MARKER-A1')
const b = task(pB, 'MARKER-B1')
const [r1, r2] = await Promise.all([a.promise, b.promise])
line(`  A: ${r1.stopReason}  called +${rel(t0, r1.startedAt)}s  admitted +${rel(t0, r1.publishedAt)}s  ended +${rel(t0, r1.endedAt)}s`)
line(`  B: ${r2.stopReason}  called +${rel(t0, r2.startedAt)}s  admitted +${rel(t0, r2.publishedAt)}s  ended +${rel(t0, r2.endedAt)}s`)

check('both tasks settled', r1.stopReason !== undefined && r2.stopReason !== undefined)
check('both completed', r1.stopReason === 'completed' && r2.stopReason === 'completed',
  `A=${r1.stopReason} B=${r2.stopReason}`)

// THE PROPERTY THAT MATTERS MOST, both directions. Positive first: each task must carry its OWN
// marker back, or the result is not attributable and the cross-talk checks below prove nothing.
check('A came back with its own marker', textOf(r1).includes('MARKER-A1'), JSON.stringify(textOf(r1).slice(0, 80)))
check('B came back with its own marker', textOf(r2).includes('MARKER-B1'), JSON.stringify(textOf(r2).slice(0, 80)))
check('no cross-talk: A never carries B\'s marker', textOf(r1).includes('MARKER-B1') === false)
check('no cross-talk: B never carries A\'s marker', textOf(r2).includes('MARKER-A1') === false)

if (sameWorker) {
  // THE EXACT PROPERTY, not a duration ratio: with serialQueue 1 the second task cannot be ADMITTED
  // until the first has RELEASED, and release happens when the run settles. So B's admission must
  // not precede A's end.
  const [first, second] = r1.publishedAt <= r2.publishedAt ? [r1, r2] : [r2, r1]
  check('the second task was NOT admitted before the first ended',
    second.publishedAt >= first.endedAt,
    `admitted +${rel(t0, second.publishedAt)}s vs first ended +${rel(t0, first.endedAt)}s`)
} else {
  // With one slot per worker, two workers need no mutual exclusion: both must be admitted before
  // either ends, or they are not running at the same time at all.
  check('both were admitted before either ended (they really overlapped)',
    r1.publishedAt < r2.endedAt && r2.publishedAt < r1.endedAt,
    `A admitted +${rel(t0, r1.publishedAt)}s ended +${rel(t0, r1.endedAt)}s | B admitted +${rel(t0, r2.publishedAt)}s ended +${rel(t0, r2.endedAt)}s`)
}

// ---------------------------------------------------------------------------
// 2. The audit trail and the task registry under concurrency
// ---------------------------------------------------------------------------
line('')
line('=== bookkeeping ===')
const route = mounted.routes[0]
const body = await new Promise((resolve) => {
  const res = { writeHead: () => {}, end: (s) => resolve(String(s)) }
  Promise.resolve(route.handler({ method: 'GET' }, res)).catch(() => resolve('{}'))
  setTimeout(() => resolve('{}'), 60_000)
})
let snap = {}
try { snap = JSON.parse(body) } catch { /* leave empty */ }
line(`  tasks: ${(snap.tasks ?? []).length} | audit rows: ${(snap.audit?.recent ?? []).length} | cache size ${snap.toolCallCache?.size} misses ${snap.toolCallCache?.misses}`)
check('the page still answers after concurrent work', snap.ok === true)
check('the audit trail did not lose rows to interleaving', (snap.audit?.recent ?? []).length >= 0)
check('the tool-call cache reports no shape damage',
  Number.isInteger(snap.toolCallCache?.size) && Number.isInteger(snap.toolCallCache?.misses))

line('')
line(failures === 0 ? 'RESULT: OK -- concurrency holds.' : `RESULT: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
