// Tests for the Lead-owned provider/registry/tools modules.
// These use duck-typed fakes for AcpBridge so they run without a worker or network.
import test from 'node:test'
import assert from 'node:assert/strict'

import { RemoteProvider, blocksToText, assertUsableCwd, GATE_REFUSED } from '../lib/provider/remote-provider.js'
import { TaskRegistry, OUTPUT_LIMIT } from '../lib/core/task-registry.js'
import { NO_START_CAPABILITIES, limitDiagnostic } from '../lib/provider/out-of-process-helpers.js'
import {
  makeRemoteTools, renderSelfcheck, renderTaskDetail, waitForTask, objectSchema,
} from '../lib/tools/remote-tools.js'
import { REMOTE_TOOL_NAMES } from '../lib/index.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const GREEN_REPORT = {
  verdict: 'ready', sessionSegment: 'ok', blockingFailures: 0, warnings: 0, unchecked: 0,
  checks: [
    { id: 'S1', name: 'display', severity: 'blocking', status: 'pass', expected: 'x', actual: 'y' },
    { id: 'S8', name: 'input', severity: 'blocking', status: 'pass', expected: 'ok', actual: 'ok' },
  ],
}

const NO_SESSION_REPORT = {
  verdict: 'partial', sessionSegment: 'unavailable', blockingFailures: 0, warnings: 0, unchecked: 1,
  checks: [
    { id: 'S1', name: 'display', severity: 'blocking', status: 'pass', expected: 'x', actual: 'y' },
    { id: 'S8', name: 'input', severity: 'blocking', status: 'unchecked', expected: 'ok', actual: 'n/a' },
  ],
}

const BROKEN_REPORT = {
  verdict: 'blocked', sessionSegment: 'ok', blockingFailures: 1, warnings: 0, unchecked: 0,
  checks: [
    { id: 'S4', name: 'primary at origin', severity: 'blocking', status: 'fail', expected: 'primary at (0,0)', actual: 'at 0,-1080' },
    { id: 'S8', name: 'input', severity: 'blocking', status: 'pass', expected: 'ok', actual: 'ok' },
  ],
}

/** A fake bridge whose behaviour each test controls. */
function fakeBridge(overrides = {}) {
  const calls = { startTask: 0, cancel: 0, dispose: 0, selfcheck: 0 }
  let release
  const gate = new Promise((r) => { release = r })
  const bridge = {
    calls,
    currentTaskId: '',
    async connect() { return { agentInfo: {}, capabilities: {} } },
    async startTask(req) {
      calls.startTask += 1
      if (overrides.hold !== false) await gate
      if (overrides.throwOnStart === true) throw new Error('bridge exploded')
      req.onUpdate?.({ kind: 'tool_call', tool: { toolCallId: 'c1', toolName: 'write', rawInput: {}, status: 'in_progress' } })
      req.onUpdate?.({ kind: 'usage', usage: { used: 42, size: 100 } })
      if (overrides.onApproval === true) {
        const answer = await req.onApproval({ toolCallId: 'c1', toolName: 'write', rawInput: { file_path: 'x' } })
        if (answer !== 'allow-once' && answer !== 'reject-once') throw new Error('bad optionId: ' + answer)
      }
      return overrides.outcome ?? { stopReason: 'completed', output: 'DONE', toolCalls: [], usage: { used: 42, size: 100 } }
    },
    async cancel() { calls.cancel += 1 },
    async dispose() { calls.dispose += 1 },
    async selfcheck() { calls.selfcheck += 1; return overrides.report ?? GREEN_REPORT },
    release,
  }
  return bridge
}

function makeProvider({ report = GREEN_REPORT, serialQueue = 1, bridgeOverrides = {}, decide } = {}) {
  const bridge = fakeBridge({ report, ...bridgeOverrides })
  bridge.__release = bridge.release
  const registry = new TaskRegistry({})
  const provider = new RemoteProvider({
    peer: {
      peerId: 'labpc', name: 'lab-pc', bridge,
      defaultCwd: 'C:\\dsh-remote\\p0work',
      selfcheck: async () => report,
    },
    registry,
    decideApproval: decide ?? (() => ({ optionId: 'reject-once', source: 'human', reason: 'no human', needsHuman: true })),
    serialQueue,
    workspaceRoot: 'C:\\dsh-remote\\p0work',
  })
  return { provider, bridge, registry }
}

const REQ = { label: 'demo', prompt: [{ type: 'text', text: 'do the thing' }], parent: { id: 'p' } }

// ---------------------------------------------------------------------------
// hard constraints (DESIGN §2.2)
// ---------------------------------------------------------------------------

test('capabilities are all false (C1) and parent context is not inherited (C6)', () => {
  const { provider } = makeProvider()
  for (const [k, v] of Object.entries(provider.capabilities)) {
    assert.equal(v, false, `capability ${k} must be false`)
  }
  assert.deepEqual(Object.keys(provider.capabilities).sort(), Object.keys(NO_START_CAPABILITIES).sort())
  assert.equal(provider.inheritsParentContext, false)
})

test('no prepareContinuable is exposed (C2)', () => {
  const { provider } = makeProvider()
  assert.equal(provider.prepareContinuable, undefined)
})

test('published run keeps localAgent undefined (C3)', async () => {
  const { provider, bridge } = makeProvider({ bridgeOverrides: { hold: false } })
  const run = await provider.start(REQ)
  assert.equal(run.localAgent, undefined)
  bridge.__release()
  await run.result
})

// ---------------------------------------------------------------------------
// the dispatch gate
// ---------------------------------------------------------------------------

test('gate refuses dispatch when a blocking check fails, and publishes no run', async () => {
  const { provider, bridge } = makeProvider({ report: BROKEN_REPORT })
  await assert.rejects(() => provider.start(REQ), (err) => {
    assert.equal(err.code, GATE_REFUSED)
    assert.match(err.message, /S4/)
    assert.equal(err.details.reason, 'selfcheck-failed')
    return true
  })
  assert.equal(bridge.calls.startTask, 0, 'the bridge must not be touched when the gate refuses')
})

test('gate distinguishes "no interactive session" from "worker broken"', async () => {
  const { provider } = makeProvider({ report: NO_SESSION_REPORT })
  await assert.rejects(() => provider.start(REQ), (err) => {
    assert.equal(err.code, GATE_REFUSED)
    assert.equal(err.details.reason, 'no-interactive-session')
    assert.match(err.message, /logged in/)
    return true
  })
})

test('REGRESSION: an unreachable worker is NOT reported as "nobody is logged in"', async () => {
  // The unreachable fallback once set sessionSegment: 'unavailable', so the gate claimed
  // the worker had no interactive session whenever the relay was merely down. That is a
  // wrong diagnosis -- it sends the operator to check the login state instead of the link.
  const unreachable = {
    verdict: 'blocked',
    sessionSegment: 'unknown',
    blockingFailures: 1,
    warnings: 0,
    unchecked: 0,
    checks: [{
      id: 'S0', name: 'worker reachable', severity: 'blocking', status: 'fail',
      expected: 'relay responds', actual: 'connect ECONNREFUSED', fix: 'check the relay',
    }],
  }
  const { provider } = makeProvider({ report: unreachable })
  await assert.rejects(() => provider.start(REQ), (err) => {
    assert.equal(err.code, GATE_REFUSED)
    assert.equal(err.details.reason, 'selfcheck-failed', 'must be a reachability failure, not a session one')
    assert.match(err.message, /S0/)
    assert.match(err.message, /ECONNREFUSED/)
    assert.doesNotMatch(err.message, /logged in/, 'must not blame the login state')
    return true
  })
})

test('gate refuses when the worker is unreachable', async () => {
  const bridge = fakeBridge()
  bridge.selfcheck = async () => ({ verdict: 'blocked', sessionSegment: 'unavailable', blockingFailures: 1, warnings: 0, unchecked: 0, checks: [{ id: 'S0', name: 'reachable', severity: 'blocking', status: 'fail', expected: 'x', actual: 'y' }] })
  const registry = new TaskRegistry({})
  const provider = new RemoteProvider({
    peer: { peerId: 'p', name: 'p', bridge, defaultCwd: 'C:\\x', selfcheck: () => bridge.selfcheck() },
    registry, decideApproval: () => ({ optionId: 'reject-once' }),
  })
  await assert.rejects(() => provider.start(REQ), (err) => err.code === GATE_REFUSED)
})

test('a green report lets dispatch through', async () => {
  const { provider, bridge } = makeProvider({ bridgeOverrides: { hold: false } })
  const run = await provider.start(REQ)
  assert.equal(bridge.calls.startTask, 1)
  bridge.__release()
  const result = await run.result
  assert.equal(result.stopReason, 'completed')
})

// ---------------------------------------------------------------------------
// result settlement
// ---------------------------------------------------------------------------

test('result never rejects, even when the bridge throws', async () => {
  const { provider, registry } = makeProvider({ bridgeOverrides: { hold: false, throwOnStart: true } })
  const run = await provider.start(REQ)
  const result = await run.result
  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic, /bridge exploded/)
  const task = registry.get(run.id)
  assert.equal(task.state, 'error')
})

test('stopReason translates to a task state and is recorded', async () => {
  const { provider, registry } = makeProvider({
    bridgeOverrides: { hold: false, outcome: { stopReason: 'refusal', output: 'no', toolCalls: [], usage: undefined } },
  })
  const run = await provider.start(REQ)
  await run.result
  assert.equal(registry.get(run.id).state, 'refusal')
})

test('tool calls and usage observed during the run land in the registry', async () => {
  const { provider, registry } = makeProvider({ bridgeOverrides: { hold: false } })
  const run = await provider.start(REQ)
  await run.result
  const task = registry.get(run.id)
  assert.equal(task.toolCallCount, 1)
  assert.deepEqual(task.recentTools, ['write'])
  assert.deepEqual(task.usage, { used: 42, size: 100 })
})

test('the settled answer is retained in the registry, not only returned through the result promise', async () => {
  const { provider, registry } = makeProvider({ bridgeOverrides: { hold: false } })
  const run = await provider.start(REQ)
  await run.result
  const task = registry.get(run.id)
  assert.equal(task.output, 'DONE')
  assert.equal(task.outputChars, 4)
})

// ---------------------------------------------------------------------------
// REGRESSION F15: a background delegation's answer must be readable
//
// The delegation path is asymmetric on purpose -- background mode returns a task id and keeps
// working -- and that is what made this broken: nobody is left awaiting the provider's result
// promise, so if the answer is not retained, it does not exist anywhere. The task ran, the state
// was visible, and the ANSWER was unreachable, which made background delegation a dead end.
// Nothing offline caught it, because every test either awaited `result` itself or only ever
// looked at state. These go through the real provider, the real registry and the real tools.
// ---------------------------------------------------------------------------

test('REGRESSION F15: a background delegation\'s answer comes back through remote_agents', async () => {
  const MARKER = 'MARKER-42ff'
  const { provider, registry } = makeProvider({
    bridgeOverrides: { hold: false, outcome: { stopReason: 'completed', output: `worker says ${MARKER}`, toolCalls: [] } },
  })
  const peers = new Map([['labpc', { peerId: 'labpc', name: 'lab-pc', provider }]])
  const tools = makeRemoteTools({ registry, peers })
  const subagent = tools.find((t) => t.name === 'remote_subagent')
  const agents = tools.find((t) => t.name === 'remote_agents')

  const delegated = String(await subagent.execute({ prompt: 'probe', run_in_background: true }))
  const taskId = /taskId: (\S+)/u.exec(delegated)?.[1]
  assert.ok(taskId !== undefined, `the background reply must name the task: ${delegated}`)

  // `wait` and `status` are the two ways back to the answer, and both must carry it.
  const waited = String(await agents.execute({ action: 'wait', taskId, timeoutMs: 2000 }))
  assert.match(waited, new RegExp(MARKER))
  const status = String(await agents.execute({ action: 'status', taskId }))
  assert.match(status, new RegExp(MARKER))
  // Retained, not merely echoed: the registry is the channel, so a second read still has it.
  assert.match(String(await agents.execute({ action: 'status', taskId })), new RegExp(MARKER))
})

test('renderTaskDetail is explicit about a settled task that produced no text', async () => {
  const registry = new TaskRegistry({})
  const t = registry.create({ peerId: 'p', prompt: 'x', cwd: 'c' })
  registry.settle(t.taskId, { state: 'completed', stopReason: 'completed' })
  assert.match(renderTaskDetail(registry.get(t.taskId)), /produced no text/)

  const u = registry.create({ peerId: 'p', prompt: 'x', cwd: 'c' })
  registry.settle(u.taskId, { state: 'error', stopReason: 'error' })
  assert.match(renderTaskDetail(registry.get(u.taskId)), /output\s+: \(none\)/)
})

test('a running task reports no output section at all', () => {
  const registry = new TaskRegistry({})
  const t = registry.create({ peerId: 'p', prompt: 'x', cwd: 'c' })
  const detail = renderTaskDetail(t)
  assert.doesNotMatch(detail, /--- output ---/)
  assert.doesNotMatch(detail, /produced no text/)
})

test('a long answer is capped for retention and the cap is reported, not silent', () => {
  const registry = new TaskRegistry({})
  const t = registry.create({ peerId: 'p', prompt: 'x', cwd: 'c' })
  const total = OUTPUT_LIMIT + 5_000
  registry.settle(t.taskId, { state: 'completed', stopReason: 'completed', output: 'x'.repeat(total) })
  const task = registry.get(t.taskId)
  assert.equal(task.output.length, OUTPUT_LIMIT, 'retention must be bounded')
  assert.equal(task.outputChars, total, 'the full length must still be known')
  assert.match(renderTaskDetail(task), new RegExp(`first ${OUTPUT_LIMIT} of ${total} chars`))
})

test('listForUi carries the progress fields but not the answer text', () => {
  const registry = new TaskRegistry({})
  const t = registry.create({ peerId: 'p', prompt: 'x', cwd: 'c' })
  registry.settle(t.taskId, { state: 'completed', stopReason: 'completed', output: 'secret answer' })
  const [row] = registry.listForUi(50)
  assert.equal(row.output, undefined, 'the page must not receive megabytes of answer text')
  assert.equal(row.outputChars, 'secret answer'.length)
  // The fields the page renders must survive the projection.
  for (const key of ['taskId', 'peerId', 'state', 'startedAt', 'toolCallCount', 'recentTools', 'waitingForApproval']) {
    assert.ok(key in row, `listForUi must keep ${key}`)
  }
})

// ---------------------------------------------------------------------------
// serial queue + disposal
// ---------------------------------------------------------------------------

test('one worker runs one task at a time (serial queue)', async () => {
  const { provider, bridge } = makeProvider({ serialQueue: 1, bridgeOverrides: { hold: false } })
  // Measure concurrency INSIDE startTask. Awaiting both starts would not observe
  // the wait, because start() itself blocks on the queue until a slot is free.
  let inFlight = 0
  let maxInFlight = 0
  let started = 0
  bridge.startTask = async function () {
    started += 1
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 25))
    inFlight -= 1
    return { stopReason: 'completed', output: '', toolCalls: [] }
  }
  const runA = await provider.start(REQ)
  const runB = await provider.start(REQ)
  await Promise.all([runA.result, runB.result])
  assert.equal(started, 2)
  assert.equal(maxInFlight, 1, 'a serial worker must never overlap two tasks')
})

test('serialQueue > 1 allows that many concurrent tasks', async () => {
  const { provider, bridge } = makeProvider({ serialQueue: 2, bridgeOverrides: { hold: false } })
  let inFlight = 0
  let maxInFlight = 0
  bridge.startTask = async function () {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 25))
    inFlight -= 1
    return { stopReason: 'completed', output: '', toolCalls: [] }
  }
  const runs = await Promise.all([provider.start(REQ), provider.start(REQ)])
  await Promise.all(runs.map((r) => r.result))
  assert.equal(maxInFlight, 2)
})

test('dispose is idempotent and cancels the worker run exactly once', async () => {
  const { provider, bridge } = makeProvider({ bridgeOverrides: { hold: true } })
  const run = await provider.start(REQ)
  await run.dispose()
  await run.dispose()
  assert.equal(bridge.calls.cancel, 1, 'cancel must be sent exactly once')
})

test('approval decisions are forwarded to the bridge verbatim', async () => {
  let seenAsk = null
  const { provider } = makeProvider({
    bridgeOverrides: { hold: false, onApproval: true },
    decide: (ask) => { seenAsk = ask; return { optionId: 'allow-once', source: 'policy', reason: 'in scope', needsHuman: false } },
  })
  const run = await provider.start(REQ)
  await run.result
  assert.notEqual(seenAsk, null)
  assert.equal(seenAsk.toolCallId, 'c1')
  assert.equal(seenAsk.toolName, 'write')
})

test('a decision returning reject-once reaches the bridge without being coerced to allow', async () => {
  const { provider } = makeProvider({
    bridgeOverrides: { hold: false, onApproval: true },
    decide: () => ({ optionId: 'reject-once', source: 'cache-miss', reason: 'no rawInput', needsHuman: false }),
  })
  const run = await provider.start(REQ)
  const result = await run.result
  assert.equal(result.stopReason, 'completed', 'a rejection of one call must not fail the whole task')
})

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

test('registry settles once: a late event cannot reopen a finished task', () => {
  const reg = new TaskRegistry({})
  const t = reg.create({ peerId: 'p', prompt: 'x', cwd: 'c' })
  reg.settle(t.taskId, { state: 'completed', stopReason: 'completed' })
  reg.settle(t.taskId, { state: 'error', stopReason: 'error' })
  assert.equal(reg.get(t.taskId).state, 'completed')
})

test('registry summary only lists in-flight work', () => {
  const reg = new TaskRegistry({})
  const a = reg.create({ peerId: 'p', prompt: 'a', cwd: 'c' })
  const b = reg.create({ peerId: 'p', prompt: 'b', cwd: 'c' })
  reg.settle(a.taskId, { state: 'completed' })
  const s = reg.summary()
  assert.match(s, new RegExp(b.taskId))
  assert.doesNotMatch(s, new RegExp(a.taskId))
})

test('registry summary is empty when nothing is in flight', () => {
  const reg = new TaskRegistry({})
  const t = reg.create({ peerId: 'p', prompt: 'x', cwd: 'c' })
  reg.settle(t.taskId, { state: 'completed' })
  assert.equal(reg.summary(), '')
})

test('activeCountForPeer drives the per-worker concurrency view', () => {
  const reg = new TaskRegistry({})
  reg.create({ peerId: 'p1', prompt: 'a', cwd: 'c' })
  reg.create({ peerId: 'p2', prompt: 'b', cwd: 'c' })
  assert.equal(reg.activeCountForPeer('p1'), 1)
  assert.equal(reg.activeCountForPeer('p2'), 1)
  assert.equal(reg.activeCountForPeer('p3'), 0)
})

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

test('tools are registered under the documented names and all declare output.render', () => {
  const registry = new TaskRegistry({})
  const peers = new Map()
  const tools = makeRemoteTools({ registry, peers })
  // Set equality with `REMOTE_TOOL_NAMES`, not a literal list (PITFALLS D11). The invariant that
  // matters is that every tool the registry exposes is also a name the SESSION GATE covers: a tool
  // registered without being listed there stays visible and callable in a session that never ran
  // `/remote-use on`.
  assert.deepEqual(tools.map((t) => t.name).sort(), [...REMOTE_TOOL_NAMES].sort())
  for (const t of tools) {
    assert.equal(typeof t.output?.schema, 'object', `${t.name} must declare output.schema`)
    assert.equal(typeof t.output?.render, 'function', `${t.name} must declare output.render`)
    assert.equal(typeof t.execute, 'function')
  }
})

test('there is no remote_send_message: the seam cannot continue a remote child (C2)', () => {
  const tools = makeRemoteTools({ registry: new TaskRegistry({}), peers: new Map() })
  assert.equal(tools.some((t) => t.name === 'remote_send_message'), false)
})

// ---------------------------------------------------------------------------
// REGRESSION: the model-facing parameter schema
//
// These exist because the first shipped version registered the author shorthand
// (`{ action: { type: 'string', required: true } }`) without the conversion that
// `defineTool` performs. `ctx.tools.register()` stores `parameters` verbatim and
// validates only `output`, so the model received a schema with no root type and EVERY
// call failed with:
//
//   Invalid schema for function 'remote_agents':
//   schema must be a JSON Schema of 'type: "object"', got 'type: null'.
//
// Every unit test passed while the plugin was unusable. Asserting the shape here is the
// only thing that catches that offline.
// ---------------------------------------------------------------------------

test('REGRESSION: every tool declares an object-rooted JSON Schema for parameters', () => {
  const tools = makeRemoteTools({ registry: new TaskRegistry({}), peers: new Map() })
  for (const t of tools) {
    assert.equal(t.parameters?.type, 'object',
      `${t.name}: parameters.type must be "object", got ${JSON.stringify(t.parameters?.type)}`)
    assert.equal(typeof t.parameters.properties, 'object', `${t.name}: properties must be present`)
    assert.ok(!Array.isArray(t.parameters.properties), `${t.name}: properties must be a map`)
  }
})

test('REGRESSION: `required: true` becomes a root required entry, not a property keyword', () => {
  const tools = makeRemoteTools({ registry: new TaskRegistry({}), peers: new Map() })
  for (const t of tools) {
    for (const [name, prop] of Object.entries(t.parameters.properties)) {
      assert.equal(prop.required, undefined,
        `${t.name}.${name}: "required" is not a JSON Schema property keyword and must be stripped`)
    }
    const declared = t.parameters.required ?? []
    assert.ok(Array.isArray(declared), `${t.name}: required must be an array when present`)
    for (const r of declared) {
      assert.ok(r in t.parameters.properties, `${t.name}: required names "${r}", not a declared property`)
    }
  }
})

test('REGRESSION: required fields are exactly the intended ones', () => {
  const tools = makeRemoteTools({ registry: new TaskRegistry({}), peers: new Map() })
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.parameters]))
  assert.deepEqual(byName.remote_agents.required, ['action'])
  assert.deepEqual(byName.remote_interrupt.required, ['taskId'])
  assert.deepEqual(Object.keys(byName.remote_agents.properties), ['action', 'taskId', 'peerId', 'timeoutMs'])
  // remote_selfcheck takes no required argument: it checks every worker by default.
  assert.equal(byName.remote_selfcheck.required, undefined)
  assert.deepEqual(Object.keys(byName.remote_selfcheck.properties), ['peerId'])
})

test('REGRESSION: parameters survive a JSON round-trip as the model transport requires', () => {
  const tools = makeRemoteTools({ registry: new TaskRegistry({}), peers: new Map() })
  for (const t of tools) {
    assert.deepEqual(JSON.parse(JSON.stringify(t.parameters)), t.parameters,
      `${t.name}: parameters must be plain JSON`)
  }
})

test('objectSchema mirrors the official converter', () => {
  // Root type + properties map; `required` present only when non-empty.
  assert.deepEqual(objectSchema({ a: { type: 'string' } }),
    { type: 'object', properties: { a: { type: 'string' } } })
  assert.deepEqual(objectSchema({ a: { type: 'string', required: true }, b: { type: 'number' } }),
    { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'] })
  // No fields is still a valid object schema, never an empty shorthand.
  assert.deepEqual(objectSchema({}), { type: 'object', properties: {} })
  assert.deepEqual(objectSchema(undefined), { type: 'object', properties: {} })
  // Descriptions survive.
  assert.deepEqual(objectSchema({ a: { type: 'string', description: 'd' } }).properties.a,
    { type: 'string', description: 'd' })
  // Multiple required fields keep declaration order.
  assert.deepEqual(objectSchema({ a: { type: 'string', required: true }, b: { type: 'string', required: true } }).required,
    ['a', 'b'])
})

test('remote_agents rejects an unknown action instead of guessing', async () => {
  const tools = makeRemoteTools({ registry: new TaskRegistry({}), peers: new Map() })
  const agents = tools.find((t) => t.name === 'remote_agents')
  assert.match(String(await agents.execute({ action: 'nonsense' })), /unknown action/)
})

test('remote_agents list reports every peer and its in-flight tasks', async () => {
  const registry = new TaskRegistry({})
  const bridge = fakeBridge({ hold: false })
  const peers = new Map([['labpc', { peerId: 'labpc', name: 'lab-pc', bridge, defaultCwd: 'C:\\w', selfcheck: async () => GREEN_REPORT }]])
  registry.create({ peerId: 'labpc', label: 'demo', prompt: 'p', cwd: 'C:\\w' })
  const tools = makeRemoteTools({ registry, peers })
  const out = String(await tools.find((t) => t.name === 'remote_agents').execute({ action: 'list' }))
  assert.match(out, /lab-pc \(labpc\)/)
  assert.match(out, /active=1/)
})

test('remote_agents wait returns immediately for a settled task and times out otherwise', async () => {
  const registry = new TaskRegistry({})
  const t = registry.create({ peerId: 'p', prompt: 'x', cwd: 'c' })
  registry.settle(t.taskId, { state: 'completed', stopReason: 'completed' })
  const done = await waitForTask(registry, t.taskId, 1000)
  assert.match(done, /settled/)

  const u = registry.create({ peerId: 'p', prompt: 'y', cwd: 'c' })
  const timedOut = await waitForTask(registry, u.taskId, 10)
  assert.match(timedOut, /timed out/)
})

// ---------------------------------------------------------------------------
// remote_subagent: the delegation entry point the plugin provides itself
//
// It exists because a Web session's tool catalog comes from the AGENT PRESET, not the loader tree
// (PITFALLS F11), so a profile-patch `dsh-tool-subagent` row never reaches the model. Registering
// through `ctx.tools` is the route that works, and these tests pin the tool's contract:
//   - it delegates through the worker's EXISTING provider (same gate, same queue, same registry)
//   - foreground returns the worker's answer; background returns a task id and does not block
//   - every failure mode is a readable message, never a throw
// ---------------------------------------------------------------------------

/** A provider stand-in that records the request and answers on demand. */
function fakeProvider({ result, reject } = {}) {
  return {
    starts: [],
    async start(request) {
      this.starts.push(request)
      if (reject !== undefined) throw reject
      return { id: 'task-1', localAgent: undefined, result: Promise.resolve(result), dispose: async () => {} }
    },
  }
}

const settled = (text, extra = {}) => ({ output: [{ type: 'text', text }], stopReason: 'completed', ...extra })

test('remote_subagent delegates through the worker provider in the foreground', async () => {
  const registry = new TaskRegistry({})
  const provider = fakeProvider({ result: settled('worker says: notepad is open') })
  const peers = new Map([['labpc', { peerId: 'labpc', name: 'lab-pc', provider }]])
  const tool = makeRemoteTools({ registry, peers }).find((t) => t.name === 'remote_subagent')

  const out = String(await tool.execute({ prompt: 'open notepad', description: 'gui check' }))
  // It must go through the provider -- that is what carries the gate, the serial queue and the
  // TaskRegistry entry. A tool that called the bridge directly would bypass all three.
  assert.equal(provider.starts.length, 1)
  assert.equal(provider.starts[0].prompt, 'open notepad')
  assert.equal(provider.starts[0].label, 'gui check')
  assert.match(out, /notepad is open/)
  assert.match(out, /completed/)
})

test('remote_subagent in the background returns a task id without waiting', async () => {
  const registry = new TaskRegistry({})
  // A result that never settles: if the tool waited, this test would hang.
  const provider = { starts: [], async start() { return { id: 'bg-7', result: new Promise(() => {}), dispose: async () => {} } } }
  const peers = new Map([['labpc', { peerId: 'labpc', name: 'lab-pc', provider }]])
  const tool = makeRemoteTools({ registry, peers }).find((t) => t.name === 'remote_subagent')

  const out = String(await tool.execute({ prompt: 'long job', run_in_background: true }))
  assert.match(out, /bg-7/)
  assert.match(out, /remote_agents/)
  assert.match(out, /cannot be continued/)
})

test('remote_subagent reports every failure mode instead of throwing', async () => {
  const registry = new TaskRegistry({})
  const tool = (peers) => makeRemoteTools({ registry, peers }).find((t) => t.name === 'remote_subagent')

  assert.match(String(await tool(new Map()).execute({ prompt: 'x' })), /no paired workers/)
  assert.match(String(await tool(new Map()).execute({ prompt: '   ' })), /prompt is required/)
  assert.match(
    String(await tool(new Map([['p', { peerId: 'p', name: 'n' }]])).execute({ prompt: 'x' })),
    /not ready to accept a delegation/,
  )
  // A refusal from the gate must arrive as the provider's own message plus its code, not as a
  // rejected tool call: the model needs to read WHY it was refused.
  const refused = Object.assign(new Error('REMOTE_WORKER_NOT_READY: S4 primary at (0,0)'), { code: 'REMOTE_WORKER_NOT_READY' })
  const peers = new Map([['p', { peerId: 'p', name: 'n', provider: fakeProvider({ reject: refused }) }]])
  const out = String(await tool(peers).execute({ prompt: 'x' }))
  assert.match(out, /refused/)
  assert.match(out, /REMOTE_WORKER_NOT_READY/)
  assert.match(out, /S4/)
})

test('remote_interrupt refuses a task whose worker is not connected', async () => {
  const registry = new TaskRegistry({})
  const t = registry.create({ peerId: 'gone', prompt: 'x', cwd: 'c' })
  const tools = makeRemoteTools({ registry, peers: new Map() })
  const out = String(await tools.find((t2) => t2.name === 'remote_interrupt').execute({ taskId: t.taskId }))
  assert.match(out, /not connected/)
})

test('remote_selfcheck renders failures with expected/actual and the fix', () => {
  const out = renderSelfcheck('lab-pc', BROKEN_REPORT)
  assert.match(out, /verdict=blocked/)
  assert.match(out, /S4/)
  assert.match(out, /expected: primary at \(0,0\)/)
  assert.match(out, /actual  : at 0,-1080/)
})

test('remote_selfcheck calls out a missing interactive session explicitly', () => {
  const out = renderSelfcheck('lab-pc', NO_SESSION_REPORT)
  assert.match(out, /interactive session/)
})

test('renderTaskDetail flags a task waiting for approval', () => {
  const registry = new TaskRegistry({})
  const t = registry.create({ peerId: 'p', prompt: 'x', cwd: 'c' })
  registry.setWaitingForApproval(t.taskId, true)
  assert.match(renderTaskDetail(t), /waiting/)
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test('blocksToText flattens content blocks and ignores non-text ones', () => {
  assert.equal(blocksToText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(blocksToText('plain'), 'plain')
  assert.equal(blocksToText(undefined), '')
})

test('limitDiagnostic truncates at the upstream byte budget', () => {
  const long = 'x'.repeat(10_000)
  const out = limitDiagnostic(long)
  assert.ok(new TextEncoder().encode(out).byteLength <= 4096)
  assert.match(out, /truncated/)
  assert.equal(limitDiagnostic('short'), 'short')
})

test('assertUsableCwd accepts absolute paths and rejects the rest', () => {
  assert.equal(assertUsableCwd('C:\\dsh-remote\\p0work'), '')
  assert.equal(assertUsableCwd('C:/dsh-remote/p0work'), '')
  assert.equal(assertUsableCwd('/home/worker/work'), '')
  assert.match(assertUsableCwd(''), /empty/)
  assert.match(assertUsableCwd('   '), /empty/)
  assert.match(assertUsableCwd('relative\\path'), /absolute/)
  assert.match(assertUsableCwd('.\\work'), /absolute/)
  assert.match(assertUsableCwd(undefined), /empty/)
})

test('a bad worker cwd is refused before any session is created', async () => {
  const { provider, bridge } = makeProvider()
  provider.peer.defaultCwd = 'relative\\work'
  await assert.rejects(() => provider.start(REQ), (err) => {
    assert.equal(err.code, 'REMOTE_BAD_CWD')
    assert.match(err.message, /absolute/)
    return true
  })
  assert.equal(bridge.calls.startTask, 0)
})
