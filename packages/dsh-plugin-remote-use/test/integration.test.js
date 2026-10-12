/**
 * Integration tests: the real assembly, not mocks of our own modules.
 *
 *   fake ACP agent  <->  AcpBridge (real)  <->  RemoteProvider (real)
 *                                              |-> TaskRegistry (real)
 *                                              |-> decideApproval (real review-engine)
 *
 * The point of this file is the SECURITY properties, verified end to end:
 * the approval option that actually reaches the worker must be `reject-once` when
 * the master cannot justify an escalation. A permissive stub anywhere in the chain
 * would make these tests fail, which is exactly what we want.
 *
 * See DESIGN §10.0.1 (the finding) and §8.3 (the rules).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as acp from '@agentclientprotocol/sdk'

import { AcpBridge } from '../lib/bridge/acp-bridge.js'
import { RemoteProvider } from '../lib/provider/remote-provider.js'
import { TaskRegistry } from '../lib/core/task-registry.js'
import { TaskMemory } from '../lib/core/task-memory.js'
import { decideApproval } from '../lib/core/review-engine.js'

// ---------------------------------------------------------------------------
// fake worker
// ---------------------------------------------------------------------------

const PERMISSION_OPTIONS = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
]

function memoryPair() {
  const c2a = new TransformStream()
  const a2c = new TransformStream()
  return {
    client: { readable: a2c.readable, writable: c2a.writable },
    agent: { readable: c2a.readable, writable: a2c.writable },
  }
}

/**
 * A fake DSH-over-ACP worker whose prompt behaviour the test controls.
 * @param {{ onPrompt?: (ctx: any, api: any) => Promise<object> }} [opts]
 */
function createFakeWorker(opts = {}) {
  const pair = memoryPair()
  const clientStream = acp.ndJsonStream(pair.client.writable, pair.client.readable)
  const agentStream = acp.ndJsonStream(pair.agent.writable, pair.agent.readable)

  const seen = { newSessions: [], prompts: [], permissionAnswers: [] }
  let n = 0

  const app = acp.agent({ name: 'fake-dsh-acp' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
      agentCapabilities: {
        sessionCapabilities: { close: {}, list: {}, resume: {} },
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: [],
    }))
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      n += 1
      seen.newSessions.push(ctx.params)
      return { sessionId: `sess-${n}`, configOptions: [] }
    })
    .onRequest(acp.methods.agent.session.close, () => ({}))
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      seen.prompts.push(ctx.params)
      if (typeof opts.onPrompt === 'function') return await opts.onPrompt(ctx, api)
      return { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, () => {})

  const connection = app.connect(agentStream)

  const api = {
    clientStream,
    seen,
    sessionId: () => seen.prompts.at(-1)?.sessionId ?? 'sess-1',
    notify(update) {
      return connection.client.notify(acp.methods.client.session.update, { sessionId: api.sessionId(), update })
    },
    /** Mirrors a REAL DSH request: params carry only the tool call id (DESIGN §13.3). */
    askPermission(toolCallId) {
      return connection.client
        .request(acp.methods.client.session.requestPermission, {
          sessionId: api.sessionId(),
          toolCall: { toolCallId },
          options: PERMISSION_OPTIONS,
        })
        .then((res) => {
          seen.permissionAnswers.push(res)
          return res
        })
    },
  }

  return api
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

const CWD = 'C:\\dsh-remote\\p0work'

const GREEN_REPORT = {
  verdict: 'ready', sessionSegment: 'ok', blockingFailures: 0, warnings: 0, unchecked: 0,
  checks: [{ id: 'S8', name: 'input', severity: 'blocking', status: 'pass', expected: 'ok', actual: 'ok' }],
}

/**
 * Wire bridge + provider + registry + real review-engine, exactly as lib/index.js does.
 *
 * `allowedTools` / `allowedPaths` are the task-level authorization the engine's rule 5
 * consults. Without them rule 6 correctly escalates to a human (fail closed), so a test
 * that expects an automatic allow MUST declare what the task is authorized to do.
 *
 * @param {{ onPrompt?: Function, report?: object, requiredTier?: string,
 *           allowedTools?: string[], allowedPaths?: string[] }} [opts]
 */
function assemble(opts = {}) {
  const worker = createFakeWorker({ onPrompt: opts.onPrompt })
  const bridge = new AcpBridge({ stream: worker.clientStream, approvalTimeoutMs: 2000 })
  const registry = new TaskRegistry({})
  const memory = new TaskMemory('t')
  const audit = []

  const provider = new RemoteProvider({
    peer: {
      peerId: 'labpc', name: 'lab-pc', bridge, defaultCwd: CWD,
      selfcheck: async () => opts.report ?? GREEN_REPORT,
    },
    registry,
    serialQueue: 1,
    workspaceRoot: CWD,
    decideApproval: (req) => {
      const d = decideApproval(req, {
        memory,
        policy: {
          requiredTier: opts.requiredTier ?? 'workspace-write',
          workspaceRoot: CWD,
          ...(opts.allowedTools === undefined ? {} : { allowedTools: opts.allowedTools }),
          ...(opts.allowedPaths === undefined ? {} : { allowedPaths: opts.allowedPaths }),
        },
      })
      audit.push(d)
      return d
    },
  })

  return { provider, bridge, registry, worker, memory, audit }
}

async function connect(harness) {
  await harness.bridge.connect()
  return harness
}

const REQ = { label: 'demo', prompt: [{ type: 'text', text: 'do the thing' }], parent: { id: 'p' } }

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

test('integration: a tool-using task completes and everything is observable', async () => {
  const h = await connect(assemble({
    onPrompt: async (_ctx, api) => {
      api.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working...' } })
      api.notify({
        sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'write', kind: 'other', status: 'in_progress',
        rawInput: { file_path: `${CWD}\\out.txt`, content: 'hi' },
      })
      api.notify({
        sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Created file' } }],
      })
      api.notify({ sessionUpdate: 'usage_update', used: 1234, size: 1_000_000 })
      api.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DONE' } })
      return { stopReason: 'end_turn' }
    },
  }))

  const run = await h.provider.start(REQ)
  const result = await run.result

  assert.equal(result.stopReason, 'completed')
  assert.equal(result.output[0].text, 'working...DONE', 'assistant text accumulates from chunks only')
  const task = h.registry.get(run.id)
  assert.equal(task.state, 'completed')
  assert.equal(task.toolCallCount, 1)
  assert.deepEqual(task.recentTools, ['write'])
  assert.deepEqual(task.usage, { used: 1234, size: 1_000_000 })
  assert.equal(h.worker.seen.permissionAnswers.length, 0, 'an in-workspace write needs no approval')
  await h.bridge.dispose()
})

// ---------------------------------------------------------------------------
// SECURITY: the two properties the P0 experiment exposed (DESIGN §10.0.1)
// ---------------------------------------------------------------------------

test('SECURITY: an approval whose tool call was never observed is REJECTED, not allowed', async () => {
  // The worker asks for permission without ever announcing the tool call -- exactly
  // what a hostile or buggy peer would do. The master has no rawInput, so it cannot
  // judge the request and must refuse.
  let answer = null
  const h = await connect(assemble({
    onPrompt: async (_ctx, api) => {
      answer = await api.askPermission('call_unknown')
      return { stopReason: 'end_turn' }
    },
  }))

  const run = await h.provider.start(REQ)
  await run.result

  assert.notEqual(answer, null, 'the worker must have received an answer')
  assert.equal(answer.outcome.outcome, 'selected')
  assert.equal(answer.outcome.optionId, 'reject-once', 'a cache miss must never be auto-allowed')
  assert.equal(h.audit.at(-1).source, 'cache-miss')
  await h.bridge.dispose()
})

test('SECURITY: an over-broad escalation is REJECTED and flagged for a human', async () => {
  // Reproduces the P0 observation: the task only needs to touch one out-of-workspace
  // path, but the model asks for danger-full-access (unrestricted filesystem).
  let answer = null
  const h = await connect(assemble({
    onPrompt: async (_ctx, api) => {
      api.notify({
        sessionUpdate: 'tool_call', toolCallId: 'call_esc', title: 'write', kind: 'other', status: 'in_progress',
        rawInput: {
          file_path: 'C:\\Users\\someone\\out.txt',
          content: 'x',
          sandbox_permissions: 'danger-full-access',
          justification: 'needs to write outside the workspace',
        },
      })
      answer = await api.askPermission('call_esc')
      return { stopReason: 'end_turn' }
    },
  }))

  const run = await h.provider.start(REQ)
  await run.result

  assert.equal(answer.outcome.optionId, 'reject-once', 'danger-full-access must not be auto-allowed')
  const decision = h.audit.at(-1)
  assert.equal(decision.source, 'tier-check')
  assert.equal(decision.needsHuman, true, 'the unrestricted tier must be escalated to a human')
  await h.bridge.dispose()
})

test('SECURITY: a narrower-than-needed escalation is allowed once, and recorded as such', async () => {
  let answer = null
  const h = await connect(assemble({
    requiredTier: 'workspace-write',
    // The task-level authorization the engine's rule 5 consults. Without it the engine
    // correctly escalates to a human (fail closed) rather than auto-allowing -- which is
    // the behaviour this test would otherwise be asserting against.
    allowedTools: ['write'],
    onPrompt: async (_ctx, api) => {
      api.notify({
        sessionUpdate: 'tool_call', toolCallId: 'call_ok', title: 'write', kind: 'other', status: 'in_progress',
        rawInput: { file_path: `${CWD}\\out.txt`, content: 'x', sandbox_permissions: 'workspace-write' },
      })
      answer = await api.askPermission('call_ok')
      return { stopReason: 'end_turn' }
    },
  }))

  const run = await h.provider.start(REQ)
  await run.result

  assert.equal(answer.outcome.optionId, 'allow-once')
  assert.equal(h.audit.at(-1).source, 'policy', 'an in-scope call is allowed by task-level authorization')
  assert.equal(h.audit.at(-1).needsHuman, false)
  await h.bridge.dispose()
})

test('SECURITY: no task-level authorization means an escalation goes to a human, not through', async () => {
  // The mirror of the test above: same request, but the task declared nothing it is
  // authorized to do. Rule 6 must escalate rather than invent an approval.
  let answer = null
  const h = await connect(assemble({
    requiredTier: 'workspace-write',
    onPrompt: async (_ctx, api) => {
      api.notify({
        sessionUpdate: 'tool_call', toolCallId: 'call_noauth', title: 'write', kind: 'other', status: 'in_progress',
        rawInput: { file_path: `${CWD}\\out.txt`, content: 'x', sandbox_permissions: 'workspace-write' },
      })
      answer = await api.askPermission('call_noauth')
      return { stopReason: 'end_turn' }
    },
  }))

  const run = await h.provider.start(REQ)
  await run.result

  assert.equal(answer.outcome.optionId, 'reject-once', 'unjustified escalation must not be auto-allowed')
  const decision = h.audit.at(-1)
  assert.equal(decision.needsHuman, true)
  await h.bridge.dispose()
})

test('SECURITY: no handler and no decision path still fails closed', async () => {
  // Guard against a future refactor that drops the approval wiring entirely: with no
  // decision function the bridge must answer reject-once rather than let the turn hang.
  const worker = createFakeWorker({
    onPrompt: async (_ctx, api) => {
      await api.askPermission('call_x')
      return { stopReason: 'end_turn' }
    },
  })
  const bridge = new AcpBridge({ stream: worker.clientStream, approvalTimeoutMs: 500 })
  await bridge.connect()
  const result = await bridge.startTask({ cwd: CWD, prompt: 'p' })
  assert.equal(result.stopReason, 'completed')
  assert.equal(worker.seen.permissionAnswers[0].outcome.optionId, 'reject-once')
  await bridge.dispose()
})

// ---------------------------------------------------------------------------
// gate: refusal must happen before any work reaches the worker
// ---------------------------------------------------------------------------

test('integration: a blocked self-check refuses dispatch without creating a session', async () => {
  const blocked = {
    verdict: 'blocked', sessionSegment: 'ok', blockingFailures: 1, warnings: 0, unchecked: 0,
    checks: [{ id: 'S4', name: 'primary at origin', severity: 'blocking', status: 'fail', expected: '(0,0)', actual: '0,-1080' }],
  }
  const h = await connect(assemble({ report: blocked }))
  await assert.rejects(() => h.provider.start(REQ), /S4/)
  assert.equal(h.worker.seen.newSessions.length, 0, 'no session may be created when the gate refuses')
  await h.bridge.dispose()
})

test('integration: a missing interactive session refuses dispatch with its own reason', async () => {
  const noSession = {
    verdict: 'partial', sessionSegment: 'unavailable', blockingFailures: 0, warnings: 0, unchecked: 1,
    checks: [{ id: 'S8', name: 'input', severity: 'blocking', status: 'unchecked', expected: 'ok', actual: 'n/a' }],
  }
  const h = await connect(assemble({ report: noSession }))
  await assert.rejects(() => h.provider.start(REQ), (err) => {
    assert.equal(err.details.reason, 'no-interactive-session')
    return true
  })
  assert.equal(h.worker.seen.newSessions.length, 0)
  await h.bridge.dispose()
})

// ---------------------------------------------------------------------------
// cancellation observed end to end
// ---------------------------------------------------------------------------

test('integration: cancelling a run settles the task as aborted, not failed', async () => {
  let release
  const held = new Promise((r) => { release = r })
  const h = await connect(assemble({
    onPrompt: async (_ctx, api) => {
      api.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'starting' } })
      await held
      return { stopReason: 'cancelled' }
    },
  }))

  const run = await h.provider.start(REQ)
  await run.dispose()          // sends session/cancel
  release()
  const result = await run.result
  assert.equal(result.stopReason, 'aborted')
  assert.equal(h.registry.get(run.id).state, 'aborted')
  await h.bridge.dispose()
})

// ---------------------------------------------------------------------------
// worker failure must not leave a phantom task
// ---------------------------------------------------------------------------

test('integration: a failed turn settles the registry instead of leaving it running', async () => {
  const h = await connect(assemble({
    // Mirror DSH's real failure shape: the detail lives IN the JSON-RPC message
    // (observed: code -32603, message "Internal error: turn failed: llm-deepseek:
    // no API key for provider route ..."). A plain Error would have its message
    // replaced by the SDK's standard text for -32603.
    onPrompt: async () => {
      throw new acp.RequestError(-32603, 'Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"')
    },
  }))
  const run = await h.provider.start(REQ)
  const result = await run.result
  assert.equal(result.stopReason, 'error')
  const task = h.registry.get(run.id)
  assert.equal(task.state, 'error', 'a phantom "running" entry would make remote_agents lie')
  assert.match(task.diagnostic ?? '', /no API key/)
  await h.bridge.dispose()
})
