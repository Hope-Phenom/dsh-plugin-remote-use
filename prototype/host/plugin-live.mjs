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
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// DERIVED FROM THE ENVIRONMENT: the literal that used to be here named one developer's profile
// directory, so the harness ran on that machine and nowhere else (the S14/S15 defect again).
const INSTALLED = join(process.env.USERPROFILE ?? homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-plugin-remote-use', 'lib', 'index.js')

/**
 * Isolate the DSH home BEFORE importing the plugin, so `--url` is actually the worker under test.
 *
 * WHY THIS MATTERS, and how it was found: `apply()` merges `defaults < profile patch < settings
 * file`, and `workers` REPLACES. The operator's real settings.json names the reference worker, so
 * once that file exists it OVERRIDES the `workers` array passed in below -- silently. Running
 * `--url ws://127.0.0.1:7397` against a live loopback relay therefore connected to
 * `192.168.1.101:7331` and reported `ETIMEDOUT`, which reads exactly like a product failure and is
 * actually the harness testing a different machine than the one it was told to test.
 *
 * A harness whose subject can be silently replaced is worse than no harness: it reports a
 * confident result about something else. A temp home also keeps this run out of the operator's
 * settings and audit trail.
 */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'plugin-live-home-'))
process.env.DSH_HOME = TEST_HOME
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* best effort */ } })

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
const mounted = {
  providers: [], tools: [], routes: [], sections: [], logs: [], effects: [],
  guards: [], commands: new Map(), listeners: new Map(),
}

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
    // The plugin subscribes to `agent/created` to apply its default-off tool restriction, so
    // a context without `on` cannot mount it at all. Keeping this faithful is the point of
    // this script: it mounts the REAL apply(), and a missing method here is exactly the class
    // of gap that unit tests running against their own fake context cannot see.
    on(event, handler) {
      const list = mounted.listeners.get(event) ?? []
      list.push(handler)
      mounted.listeners.set(event, list)
      return () => {}
    },
    subagents: { registerProvider: (p) => { mounted.providers.push(p); return () => {} } },
    tools: {
      register: (d) => { mounted.tools.push(d); return () => {} },
      guard: (fn) => { mounted.guards.push(fn); return () => {} },
    },
    commands: { register: (d) => { mounted.commands.set(d.name, d); return () => {} } },
    systemPrompt: {
      getSectionOrder: (name) => ({ TEAM_POLICY: 600, TOOL_SUBAGENT: 2800 })[name] ?? 100,
      section: (d) => { mounted.sections.push(d); return () => {} },
    },
    inject: (deps, cb) => cb({
      effect: makeEffectHost(mounted.effects),
      commands: { register: (d) => { mounted.commands.set(d.name, d); return () => {} } },
      tools: {
        register: (d) => { mounted.tools.push(d); return () => {} },
        guard: (fn) => { mounted.guards.push(fn); return () => {} },
      },
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
    // THE GET'S REPORT IS BUDGETED, AND THAT IS THE DESIGN.
    //
    // `snapshot()` probes with `reportBudgetMs` (default 4000 ms) so a page load cannot hang;
    // the definitive answer comes from the explicit `selfcheck` action, which gets
    // `selfcheckBudgetMs` (25000 ms) and `maxAgeMs: 0` -- the same path the settings page's button
    // takes. On a COLD load the first connect spawns the ACP agent (~2 s) and then runs the worker
    // self-check (~3 s), so the budgeted snapshot legitimately has no report yet.
    //
    // Asserting on the budgeted snapshot made a correct design look like a failure. Assert on the
    // explicit probe instead, and say out loud when the snapshot simply had not finished.
    const link = w?.connection
    check('the link actually connected (this is the bug that shipped)', link?.connected === true, JSON.stringify(link))
    check('no connect failures', (link?.connectFailures ?? 1) === 0)
    if (w?.report == null) {
      console.log(`  note: the budgeted snapshot had no report yet (${String(w?.error ?? '')}); asking explicitly, as the page's button does`)
    }

    let report = w?.report ?? null
    {
      const body2 = await new Promise((resolve) => {
        const res2 = { writeHead: () => {}, end: (s) => resolve(String(s)) }
        const payload = JSON.stringify({ action: 'selfcheck', peerId: w?.peerId })
        const req2 = {
          method: 'POST',
          on: (event, handler) => {
            if (event === 'data') handler(Buffer.from(payload))
            if (event === 'end') handler()
            return req2
          },
        }
        Promise.resolve(route.handler(req2, res2)).catch(() => resolve(''))
        setTimeout(() => resolve(''), 60_000)
      })
      try {
        const parsed2 = JSON.parse(body2)
        if (parsed2?.report !== undefined) report = parsed2.report
      } catch { /* keep whatever the snapshot had */ }
    }
    console.log(`  report    : verdict=${report?.verdict} blocking=${report?.blockingFailures} session=${report?.sessionSegment} checks=${report?.checks?.length}`)
    for (const c of report?.checks ?? []) {
      if (c.status !== 'pass') console.log(`    [${c.status.toUpperCase()}] ${c.id} ${c.name} | ${String(c.actual).slice(0, 80)}`)
    }

    // WARNINGS ARE ADVISORY, and this harness has to agree with the product about that.
    //
    // It used to demand `verdict === 'ready'`, which the worker self-check only produces when there
    // are ZERO warnings -- so a worker whose blocking checks all pass, with three advisory notes,
    // read as a harness failure. The product's own gate (`remote-provider`) blocks on
    // `status === 'fail'` and ignores warnings entirely, so the two disagreed and only one was right.
    const verdict = report?.verdict
    check('a readiness report is available', report !== null && report !== undefined, String(verdict))
    check('the self-check is neither blocked nor partial', verdict !== 'blocked' && verdict !== 'partial',
      `${String(verdict)} | failed=${String((report?.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.id).join(','))}`)
    check('no blocking findings', (report?.blockingFailures ?? 1) === 0)
  }
}

// ---------------------------------------------------------------------------
// 2. A real delegation through the mounted provider
// ---------------------------------------------------------------------------
console.log('\n=== 2. delegation through the mounted provider ===')
// DERIVED from the plugin, not hardcoded. This said "=== 4" and kept passing until 0.2.0 added
// the fifth tool (`remote_subagent`), at which point the harness reported a failure that had
// nothing to do with the worker under test. Same shape as PITFALLS D11, one layer further out.
const EXPECTED_TOOLS = Array.isArray(mod.REMOTE_TOOL_NAMES) ? [...mod.REMOTE_TOOL_NAMES] : []
check('exactly the tools the plugin names are registered',
  EXPECTED_TOOLS.length > 0
  && mounted.tools.length === EXPECTED_TOOLS.length
  && EXPECTED_TOOLS.every((n) => mounted.tools.some((t) => t.name === n)),
  `expected=${EXPECTED_TOOLS.join(',')} registered=${mounted.tools.map((t) => t.name).join(',')}`)

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

// ---------------------------------------------------------------------------
// 2a. A BACKGROUND delegation's answer, collected through the mounted TOOLS
//
// F15: the answer existed only inside the provider's `result` promise, and background mode is
// defined by nobody awaiting that promise -- so the task ran, the state was visible, and the
// ANSWER was unreachable. An offline test cannot catch this if it awaits `result` itself, which
// is exactly what every test did; this drives the real tools against the real worker instead.
// ---------------------------------------------------------------------------
console.log('\n=== 2a. background delegation, answer read back through remote_agents ===')

const subagentTool = mounted.tools.find((t) => t.name === 'remote_subagent')
const agentsTool = mounted.tools.find((t) => t.name === 'remote_agents')
check('remote_subagent is registered (the delegation entry point)', subagentTool !== undefined)
check('remote_agents is registered', agentsTool !== undefined)

if (subagentTool !== undefined && agentsTool !== undefined) {
  // A token the worker cannot guess: finding it in the status output proves the text travelled
  // back from the worker, rather than being something this script already had in hand.
  const marker = `BGMARK-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`
  const delegated = String(await subagentTool.execute({
    prompt: `Reply with exactly this token and nothing else: ${marker}`,
    description: 'plugin-live background probe',
    run_in_background: true,
  }, {}))
  console.log('  ' + delegated.split('\n').join('\n  '))
  const taskId = /taskId: (\S+)/u.exec(delegated)?.[1]
  check('the background call returned a task id', taskId !== undefined)

  if (taskId !== undefined) {
    const SETTLED = /state\s+: (completed|error|aborted|refusal|max-tokens|cancelled)/u
    let statusText = ''
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      statusText = String(await agentsTool.execute({ action: 'status', taskId }, {}))
      if (SETTLED.test(statusText)) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    console.log('  ' + statusText.split('\n').slice(0, 10).join('\n  '))
    check('status reports the task settled', SETTLED.test(statusText))
    // SCOPE THE SEARCH TO THE OUTPUT SECTION. The first version of this check searched the whole
    // status text for the marker -- and the status text ECHOES THE PROMPT, which contains the
    // marker. So it passed whether or not any answer came back: the check could not tell "the
    // answer arrived" from "the question was repeated". (The same shape as PITFALLS A5.)
    const outputSection = /^--- output[^\n]*---\n([\s\S]*)$/mu.exec(statusText)?.[1] ?? ''
    check('the status output has an answer section', outputSection !== '', `heading=${/^--- output[^\n]*---/mu.exec(statusText)?.[0] ?? 'none'}`)
    check('THE ANSWER IS READABLE through remote_agents status', outputSection.includes(marker),
      `answer section was ${JSON.stringify(outputSection.slice(0, 120))}`)
    // Read a second time: this must be RETENTION, not a one-shot echo at settle time.
    const reread = String(await agentsTool.execute({ action: 'status', taskId }, {}))
    const rereadSection = /^--- output[^\n]*---\n([\s\S]*)$/mu.exec(reread)?.[1] ?? ''
    check('and the answer is retained, not consumed by the first read', rereadSection.includes(marker))
  }
}

// ---------------------------------------------------------------------------
// 2b. The screenshot tool, through the mounted tool set
// ---------------------------------------------------------------------------
console.log('\n=== 2b. remote_screenshot through the mounted tool set ===')
const shotTool = mounted.tools.find((t) => t.name === 'remote_screenshot')
check('remote_screenshot is registered', shotTool !== undefined)
if (shotTool !== undefined) {
  const text = String(await shotTool.execute({}, {}))
  console.log('  ' + text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n  '))
  check('the tool reported a file path', /File: .+\.png/.test(text))
  check('the tool tells the model to call read_image', /read_image/.test(text))
  const m = /File: (.+\.png)/.exec(text)
  if (m !== null) {
    const { existsSync, statSync } = await import('node:fs')
    check('the PNG exists on the host', existsSync(m[1]), m[1])
    if (existsSync(m[1])) {
      const size = statSync(m[1]).size
      console.log(`  saved: ${m[1]} (${size} bytes)`)
      check('the PNG is a real image (not empty)', size > 10_000, `${size} bytes`)
      check('it has a PNG signature', (await import('node:fs')).readFileSync(m[1]).subarray(0, 4).toString('hex') === '89504e47')
    }
  }
}

// ---------------------------------------------------------------------------
// 2b. Per-session enablement: installing the plugin must not route every
//     session through a worker.
// ---------------------------------------------------------------------------
console.log('\n=== 2d. per-session enablement (default off) ===')

const makeLiveAgent = (id) => {
  const agent = { id }
  const denied = new Set()
  agent.ctx = {
    tools: {
      restrict: (filter) => {
        for (const name of filter.deny ?? []) denied.add(name)
        return () => { for (const name of filter.deny ?? []) denied.delete(name) }
      },
    },
  }
  agent.__denied = denied
  return agent
}
/** Deliver `agent/created` as the registry's serial announce does. */
const createLiveAgent = (id) => {
  const agent = makeLiveAgent(id)
  for (const handler of mounted.listeners.get('agent/created') ?? []) handler({ agent, source: 'startup' })
  return agent
}
/** The first denial from the plugin's global execution guard, if any. */
const guardReason = (exec) => {
  for (const guard of mounted.guards) {
    const reason = guard(exec)
    if (reason !== undefined) return reason
  }
  return undefined
}
/** The delegation policy the given session would receive right now. */
const policyTextFor = (agent) => {
  const section = mounted.sections.find((s) => s.name === 'remote-use:policy')
  if (section === undefined) return undefined
  return typeof section.text === 'function' ? section.text({ agent }) : section.text
}

check('the /remote-use command is registered', mounted.commands.has('remote-use'))
check('a global execution guard is registered', mounted.guards.length > 0, `got ${mounted.guards.length}`)

const agentA = createLiveAgent('live-a')
const agentB = createLiveAgent('live-b')
// `EXPECTED_TOOLS.length`, not a literal. These three checks said "=== 4" and went stale the moment
// 0.2.0 added the fifth tool, so the harness reported three failures that were about its own
// hardcoded count. PITFALLS D11, in the one file the package's test suite does not cover.
check('a new session has the remote tools denied', agentA.__denied.size === EXPECTED_TOOLS.length,
  `denied ${agentA.__denied.size} of ${EXPECTED_TOOLS.length}`)
check('the policy section renders empty while off', policyTextFor(agentA) === '', JSON.stringify(policyTextFor(agentA)))
check('the guard refuses a remote tool while off',
  /off for this session/.test(String(guardReason({ name: 'remote_agents', agent: agentA }) ?? '')),
  'expected a refusal')
check('the guard leaves other tools alone', guardReason({ name: 'pwsh', agent: agentA }) === undefined)

const command = mounted.commands.get('remote-use')
const onResult = command.handler({ commandId: 'live-1', agent: agentA, rawInput: 'on', attachments: [] })
check('/remote-use on succeeds', onResult.kind === 'success', JSON.stringify(onResult))
check('an enabled session is no longer denied', agentA.__denied.size === 0, `denied ${agentA.__denied.size}`)
check('the tool is allowed once enabled', guardReason({ name: 'remote_agents', agent: agentA }) === undefined)
check('the policy is injected once enabled',
  /Remote LAN workers/.test(String(policyTextFor(agentA) ?? '')), 'expected the policy text')

// The switch is PER SESSION: turning one on must not turn the other on.
check('the other session stays off', agentB.__denied.size === EXPECTED_TOOLS.length
  && /off for this session/.test(String(guardReason({ name: 'remote_agents', agent: agentB }) ?? '')),
  `denied ${agentB.__denied.size} of ${EXPECTED_TOOLS.length}`)

const offResult = command.handler({ commandId: 'live-2', agent: agentA, rawInput: 'off', attachments: [] })
check('/remote-use off succeeds', offResult.kind === 'success')
check('the restriction comes back',
  agentA.__denied.size === EXPECTED_TOOLS.length
  && /off for this session/.test(String(guardReason({ name: 'remote_agents', agent: agentA }) ?? '')),
  `denied ${agentA.__denied.size} of ${EXPECTED_TOOLS.length}`)

// ---------------------------------------------------------------------------
// 2c. Human approval, end to end, against the real worker
//
// This is the only check that proves the FEATURE rather than its parts: an escalation the
// review engine refuses to justify must land in the page's queue, and approving it there must
// let the worker finish something it would otherwise have been refused. Everything else --
// route shape, queue semantics, audit rows -- is unit-tested, and four earlier bugs in this
// project were all "the parts pass but the assembly never runs".
//
// A SKIP is reported honestly rather than counted as a pass: whether the worker's agent
// chooses to ask for a wider tier is up to the model, so a run where it simply stays inside
// its workspace proves nothing either way.
// ---------------------------------------------------------------------------
console.log('\n=== 2c. human approval against the real worker ===')

/** Invoke the mounted settings route the way the web server does. */
const callRoute = async (method, payload) => {
  const route = mounted.routes[0]
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const req = {
    method,
    on: (event, handler) => {
      if (event === 'data' && body !== '') handler(Buffer.from(body))
      if (event === 'end') handler()
      return req
    },
  }
  const text = await new Promise((resolve) => {
    route.handler(req, { writeHead: () => {}, end: (s) => resolve(String(s)) })
  })
  return JSON.parse(text)
}

// The switch is per session, and section 2b left this one OFF at the end.
command.handler({ commandId: 'live-3', agent: agentA, rawInput: 'on', attachments: [] })
check('the session is enabled again for the approval probe', agentA.__denied.size === 0)

const APPROVAL_PROMPT = [
  '用 pwsh 工具把文本 approved-once 写入文件 C:\\dsh-remote\\approval-probe.txt。',
  '该路径在当前工作目录之外，如果沙箱拒绝，请直接申请更高权限继续，不要改写到别处。',
  '完成后只回复 DONE。',
].join(' ')

const approvalRun = await provider.start({
  label: 'plugin-live-approval',
  prompt: [{ type: 'text', text: APPROVAL_PROMPT }],
  parent: { id: 'plugin-live-approval-parent' },
})

let approved = 0
let sawPending = 0
const deadline = Date.now() + 60_000
while (Date.now() < deadline) {
  const snapshot = await callRoute('GET')
  const pending = snapshot?.approvals?.pending ?? []
  if (pending.length > 0) {
    sawPending = pending.length
    console.log(`  queued: tool=${pending[0].toolName} tier=${pending[0].requiredTier} reason=${String(pending[0].reason).slice(0, 70)}`)
    const decided = await callRoute('POST', { action: 'approvals.decide', id: pending[0].id, decision: 'allow' })
    check('the route accepted the approval', decided.ok === true && decided.optionId === 'allow-once', JSON.stringify(decided))
    approved += 1
    continue
  }
  // Stop once the task settles and nothing is queued.
  const settled = await Promise.race([
    approvalRun.result.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 1_500)),
  ])
  if (settled && approved > 0) break
  if (settled) break
  await new Promise((r) => setTimeout(r, 500))
}

const approvalResult = await approvalRun.result
console.log(`  stopReason = ${approvalResult.stopReason}`)
console.log(`  output     = ${JSON.stringify(approvalResult.output?.[0]?.text ?? '').slice(0, 200)}`)

if (sawPending === 0) {
  console.log('  SKIP: the worker never asked for a wider tier, so there was nothing to approve.')
} else {
  check('an escalation reached the approval queue', sawPending > 0)
  check('a human decision was delivered to the worker', approved > 0)
  check('the task finished rather than being refused by the engine',
    approvalResult.stopReason === 'completed', String(approvalResult.stopReason))
  // The audit trail must show the human decision, which is what makes it auditable later.
  const after = await callRoute('GET')
  const humanRows = (after?.audit?.recent ?? []).filter((r) => r.by === 'human')
  check('the trail records who decided', humanRows.length > 0, `rows=${(after?.audit?.recent ?? []).length}`)
  console.log(`  audit: ${(after?.audit?.recent ?? []).slice(0, 3).map((r) => `${r.toolName}:${r.optionId}:${r.by}`).join(', ')}`)
}

// ---------------------------------------------------------------------------
// 2e. The worker role: this machine's ability to BE a worker
//
// NOTHING HERE ARMS ANYTHING. This runs against the operator's real DSH home, where the acp
// profile exists and the sandbox gate PASSES -- so a successful `worker.arm` would open a real
// listener on the LAN from inside a test. The safe and still meaningful checks are the ones that
// cannot start anything: the status shape, and a refusal that happens before any start.
// ---------------------------------------------------------------------------
console.log('\n=== 2e. worker role (nothing is armed here) ===')

const roleSnapshot = await callRoute('GET')
const role = roleSnapshot?.settings?.workerRole
check('GET reports the worker role', role !== undefined && typeof role === 'object')
check('the worker role never carries the token', role !== undefined && !('token' in role),
  Object.keys(role ?? {}).join(','))
check('the worker role lists the local interfaces', Array.isArray(role?.interfaces) && role.interfaces.length > 0,
  `${role?.interfaces?.length ?? 0} interfaces`)
check('the default is disarmed', role?.armed === false)
// The interface the page would preselect must not be a virtual adapter -- that was the bug the
// shared scorer exists to prevent.
const preselect = (role?.interfaces ?? []).find((i) => i.score > 0)
console.log(`  would offer: ${preselect?.address ?? '(none)'}  (${preselect?.name ?? ''})`)
check('a usable interface is offered, and it is not a virtual adapter',
  preselect !== undefined && preselect.virtual !== true, JSON.stringify(preselect))

// The preflight runs the real sandbox gate against this machine's acp profile. It starts
// nothing, so it is safe, and it is the one check that says whether this host could be a worker
// at all.
const pre = await callRoute('POST', { action: 'worker.preflight', bindAddress: preselect?.address, port: 7397 })
console.log(`  preflight: ok=${pre.ok} blockers=${JSON.stringify(pre.blockers)}`)
check('preflight answers without arming', typeof pre.ok === 'boolean' && Array.isArray(pre.blockers))
check('the sandbox gate is reported', pre.probe !== undefined && typeof pre.probe.ok === 'boolean',
  JSON.stringify(pre.probe))

// WHAT THIS CHECK IS FOR: arming must be REFUSED, and refused BEFORE anything starts.
//
// It used to demand a specific reason -- "that address is not on this machine" -- which made it fail
// for a reason unrelated to the behaviour under test. This harness isolates `DSH_HOME` (added so the
// operator's settings file cannot silently replace the worker being tested), and the isolated home
// has no acp profile, so the SANDBOX gate is the one that fires first. Both refusals are correct;
// only one was being accepted.
//
// So the reason is REPORTED rather than asserted on, and the two properties that actually matter --
// refused, and nothing started -- are what the checks require.
const badAddress = await callRoute('POST', { action: 'worker.arm', bindAddress: '203.0.113.7' })
console.log(`  arm refusal: ${String(badAddress.error).slice(0, 150)}`)
check('arming is REFUSED before anything starts', badAddress.ok === false, String(badAddress.error).slice(0, 120))
check('and a real gate refused it, not a crash',
  /sandbox|not an address of this machine/u.test(String(badAddress.error)),
  String(badAddress.error).slice(0, 120))
const stillOff = await callRoute('GET')
check('and nothing was armed by it', stillOff?.settings?.workerRole?.armed === false)

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
