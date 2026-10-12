// Tests for the worker connection manager.
//
// REGRESSION CONTEXT: the first shipped version used AcpBridge directly and never called
// connect(), so every path failed with "AcpBridge.callPlugin: not connected" while all
// unit and integration tests passed (they injected already-connected fakes). These tests
// exist so that cannot happen again.
import test from 'node:test'
import assert from 'node:assert/strict'

import { PeerConnection } from '../lib/bridge/peer-connection.js'

/** A bridge double whose connected state and failures the test controls. */
function fakeBridge(opts = {}) {
  const calls = { connect: 0, startTask: 0, cancel: 0, selfcheck: 0, dispose: 0 }
  const bridge = {
    calls,
    connected: false,
    stats: { approvals: 0, updates: 0 },
    async connect() {
      calls.connect += 1
      if (opts.connectDelayMs !== undefined) await new Promise((r) => setTimeout(r, opts.connectDelayMs))
      if (opts.connectFailsTimes !== undefined && calls.connect <= opts.connectFailsTimes) {
        throw new Error(opts.connectError ?? 'connect ECONNREFUSED 127.0.0.1:7331')
      }
      bridge.connected = true
      return { agentInfo: { name: 'fake' }, capabilities: {} }
    },
    async startTask(req) {
      calls.startTask += 1
      if (opts.startTaskError !== undefined) throw new Error(opts.startTaskError)
      return { stopReason: 'completed', output: 'ok', toolCalls: [] }
    },
    async cancel() { calls.cancel += 1; if (opts.cancelError !== undefined) throw new Error(opts.cancelError) },
    async selfcheck(o) {
      calls.selfcheck += 1
      if (opts.selfcheckError !== undefined) throw new Error(opts.selfcheckError)
      return { verdict: 'ready', checks: [] }
    },
    async dispose() { calls.dispose += 1; bridge.connected = false },
  }
  return bridge
}

function makeConnection(bridgeOpts = {}) {
  const created = []
  const logs = []
  const conn = new PeerConnection({
    peerId: 'labpc',
    log: (level, message) => logs.push([level, message]),
    createBridge: () => {
      const b = fakeBridge(typeof bridgeOpts === 'function' ? bridgeOpts() : bridgeOpts)
      created.push(b)
      return b
    },
  })
  return { conn, created, logs }
}

// ---------------------------------------------------------------------------
// laziness
// ---------------------------------------------------------------------------

test('constructing a connection does not touch the worker', () => {
  const { conn, created } = makeConnection()
  assert.equal(created.length, 0, 'no bridge may be built until something needs the worker')
  assert.equal(conn.connected, false)
})

test('selfcheck connects first, then asks the worker', async () => {
  const { conn, created } = makeConnection()
  const report = await conn.selfcheck({ maxAgeMs: 0 })
  assert.equal(report.verdict, 'ready')
  assert.equal(created.length, 1)
  assert.equal(created[0].calls.connect, 1, 'the bridge must be connected before it is used')
  assert.equal(created[0].calls.selfcheck, 1)
  assert.equal(conn.connected, true)
})

test('startTask connects first', async () => {
  const { conn, created } = makeConnection()
  const result = await conn.startTask({ cwd: 'C:\\w', prompt: 'p' })
  assert.equal(result.stopReason, 'completed')
  assert.equal(created[0].calls.connect, 1)
  assert.equal(created[0].calls.startTask, 1)
})

// ---------------------------------------------------------------------------
// single-flight + reuse
// ---------------------------------------------------------------------------

test('a second call reuses the established connection instead of reconnecting', async () => {
  const { conn, created } = makeConnection()
  await conn.startTask({ cwd: 'c', prompt: 'a' })
  await conn.startTask({ cwd: 'c', prompt: 'b' })
  assert.equal(created.length, 1, 'the bridge must be reused')
  assert.equal(created[0].calls.connect, 1, 'connect must happen once')
  assert.equal(created[0].calls.startTask, 2)
})

test('concurrent ensure() calls share a single connect attempt', async () => {
  const { conn, created } = makeConnection({ connectDelayMs: 30 })
  await Promise.all([
    conn.startTask({ cwd: 'c', prompt: 'a' }),
    conn.startTask({ cwd: 'c', prompt: 'b' }),
    conn.selfcheck(),
  ])
  assert.equal(created.length, 1)
  assert.equal(created[0].calls.connect, 1, 'three callers must produce exactly one connect')
})

// ---------------------------------------------------------------------------
// recovery
// ---------------------------------------------------------------------------

test('a failed connect is retried by the next call rather than pinned', async () => {
  // Fails once, then succeeds: the classic "worker was still booting" case.
  const { conn, created } = makeConnection({ connectFailsTimes: 1 })
  await assert.rejects(() => conn.startTask({ cwd: 'c', prompt: 'a' }), /ECONNREFUSED/)
  assert.equal(conn.connected, false)

  const result = await conn.startTask({ cwd: 'c', prompt: 'b' })
  assert.equal(result.stopReason, 'completed', 'the retry must succeed')
  assert.equal(conn.connectFailures, 1)
  assert.equal(conn.connects, 2)
})

test('a transport failure discards the link so the next call rebuilds it', async () => {
  let phase = 0
  const { conn, created } = makeConnection(() => {
    phase += 1
    return phase === 1 ? {} : {}
  })
  await conn.startTask({ cwd: 'c', prompt: 'a' })

  // Make the live bridge fail with a transport error, then drop it.
  created[0].startTask = async () => { throw new Error('ACP connection closed') }
  await assert.rejects(() => conn.startTask({ cwd: 'c', prompt: 'b' }), /connection closed/)
  assert.equal(created[0].calls.dispose, 1, 'the dead bridge must be disposed')

  // The next call must build a FRESH bridge (AcpBridge cannot reconnect on a used one).
  const result = await conn.startTask({ cwd: 'c', prompt: 'c' })
  assert.equal(result.stopReason, 'completed')
  assert.equal(created.length, 2, 'a new bridge must have been created')
  assert.equal(created[1].calls.connect, 1)
})

test('a non-transport error does NOT tear the connection down', async () => {
  const { conn, created } = makeConnection()
  created.length = 0
  await conn.startTask({ cwd: 'c', prompt: 'a' })
  const bridge = created[0]

  // A JSON-RPC error from a healthy session -- one bad task must not force a reconnect.
  bridge.startTask = async () => { throw new Error('Internal error: turn failed: no API key') }
  await assert.rejects(() => conn.startTask({ cwd: 'c', prompt: 'b' }), /no API key/)

  assert.equal(created.length, 1, 'the bridge must be kept')
  assert.equal(bridge.calls.dispose, 0, 'a task failure is not a link failure')
  assert.equal(conn.connected, true)
})

test('cancel on a never-connected peer is a no-op, not a connect', async () => {
  const { conn, created } = makeConnection()
  await conn.cancel()
  assert.equal(created.length, 0, 'cancelling must not connect')
})

test('cancel after connect reaches the worker', async () => {
  const { conn, created } = makeConnection()
  await conn.startTask({ cwd: 'c', prompt: 'a' })
  await conn.cancel()
  assert.equal(created[0].calls.cancel, 1)
})

// ---------------------------------------------------------------------------
// observability + teardown
// ---------------------------------------------------------------------------

test('stats expose the link state the readiness report cannot show', async () => {
  const { conn } = makeConnection()
  const before = conn.stats
  assert.equal(before.connected, false)
  assert.equal(before.connects, 0)

  await conn.startTask({ cwd: 'c', prompt: 'a' })
  const after = conn.stats
  assert.equal(after.connected, true)
  assert.equal(after.connects, 1)
  assert.equal(after.connectFailures, 0)
  assert.equal(after.lastError, '')
  assert.ok(after.lastConnectedAt > 0)
  assert.equal(after.bridge.updates, 0)
})

test('a connect failure is recorded in stats for diagnosis', async () => {
  const { conn } = makeConnection({ connectFailsTimes: 1 })
  await assert.rejects(() => conn.startTask({ cwd: 'c', prompt: 'a' }))
  const s = conn.stats
  assert.equal(s.connectFailures, 1)
  assert.match(s.lastError, /ECONNREFUSED/)
  assert.equal(s.connected, false)
})

test('dispose is idempotent and makes later calls fail loudly', async () => {
  const { conn, created } = makeConnection()
  await conn.startTask({ cwd: 'c', prompt: 'a' })
  await conn.dispose()
  await conn.dispose()
  assert.equal(created[0].calls.dispose, 1, 'the bridge must be disposed exactly once')
  await assert.rejects(() => conn.startTask({ cwd: 'c', prompt: 'b' }), /disposed/)
})

test('dispose before any connect is safe', async () => {
  const { conn, created } = makeConnection()
  await conn.dispose()
  assert.equal(created.length, 0)
  assert.equal(conn.connected, false)
})

test('every connect and failure is logged, so a silent dead link is impossible', async () => {
  const { conn, logs } = makeConnection({ connectFailsTimes: 1 })
  await assert.rejects(() => conn.startTask({ cwd: 'c', prompt: 'a' }))
  await conn.startTask({ cwd: 'c', prompt: 'b' })
  const text = logs.map(([l, m]) => `${l}:${m}`).join('\n')
  assert.match(text, /connecting to worker "labpc"/)
  assert.match(text, /connect failed/)
  assert.match(text, /connected to worker "labpc"/)
})
