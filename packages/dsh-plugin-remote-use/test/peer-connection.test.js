// Tests for the worker connection manager.
//
// REGRESSION CONTEXT: the first shipped version used AcpBridge directly and never called
// connect(), so every path failed with "AcpBridge.callPlugin: not connected" while all
// unit and integration tests passed (they injected already-connected fakes). These tests
// exist so that cannot happen again.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PeerConnection, httpBaseOf, defaultShotDir } from '../lib/bridge/peer-connection.js'

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

// ---------------------------------------------------------------------------
// screenshots
//
// The picture must NOT travel through the ACP pump: it is fetched over the relay's HTTP
// side and written where the HOST can open it, which is what lets the model look at the
// worker's screen rather than only read about it. These tests pin that split.
// ---------------------------------------------------------------------------

test('httpBaseOf maps a websocket URL to its HTTP origin', () => {
  assert.equal(httpBaseOf('ws://192.168.1.101:7331'), 'http://192.168.1.101:7331')
  // The URL parser drops a default port -- correct, and what a request needs.
  assert.equal(httpBaseOf('wss://worker.example:443'), 'https://worker.example')
  assert.equal(httpBaseOf('wss://worker.example'), 'https://worker.example')
  // A path on the websocket URL must not leak into the HTTP origin.
  assert.equal(httpBaseOf('ws://host:7331/some/path'), 'http://host:7331')
  assert.equal(httpBaseOf(''), '')
  assert.equal(httpBaseOf('not a url'), '')
  assert.equal(httpBaseOf(undefined), '')
})

test('defaultShotDir points somewhere the host can read', () => {
  const dir = defaultShotDir()
  assert.equal(typeof dir, 'string')
  assert.ok(dir.length > 0)
  assert.match(dir, /dsh-remote-screenshots$/)
})

/** A fetch double returning a PNG body plus the geometry headers the relay sets. */
function fakeFetch(opts = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    if (opts.throwError !== undefined) throw new Error(opts.throwError)
    if (opts.status !== undefined && opts.status !== 200) {
      return { status: opts.status, headers: new Headers(), text: async () => opts.body ?? '' }
    }
    const body = opts.body ?? Buffer.from([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4])
    const headers = new Headers({
      'x-shot-width': String(opts.width ?? 3000),
      'x-shot-height': String(opts.height ?? 1920),
      'x-shot-displays': String(opts.displays ?? 2),
      'x-shot-ms': String(opts.ms ?? 1400),
      'x-shot-captured-at': opts.capturedAt ?? '2026-10-12T07:44:20.676Z',
    })
    return {
      status: 200,
      headers,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    }
  }
  impl.calls = calls
  return impl
}

function makeShotConnection(fetchImpl, overrides = {}) {
  const { conn } = makeConnection()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-shot-test-'))
  conn.httpBase = overrides.httpBase ?? 'http://worker:7331'
  conn.token = overrides.token ?? 'secret'
  conn.fetchImpl = fetchImpl
  conn.shotDir = overrides.shotDir ?? dir
  return { conn, dir }
}

test('screenshot downloads the PNG, writes it locally, and reports geometry', async () => {
  const fetchImpl = fakeFetch({ width: 3000, height: 1920, displays: 2, ms: 1400 })
  const { conn, dir } = makeShotConnection(fetchImpl)
  const shot = await conn.screenshot()

  assert.equal(shot.width, 3000)
  assert.equal(shot.height, 1920)
  assert.equal(shot.displays, 2)
  assert.equal(shot.elapsedMs, 1400)
  assert.equal(shot.capturedAt, '2026-10-12T07:44:20.676Z')
  assert.ok(shot.localPath.startsWith(dir), `${shot.localPath} should be under ${dir}`)
  assert.match(shot.localPath, /\.png$/)
  assert.ok(existsSync(shot.localPath), 'the PNG must exist on disk')
  assert.ok(shot.bytes > 0)
  rmSync(dir, { recursive: true, force: true })
})

test('screenshot sends the bearer token and asks for a fresh capture by default', async () => {
  const fetchImpl = fakeFetch()
  const { conn, dir } = makeShotConnection(fetchImpl, { token: 'tok123' })
  await conn.screenshot()
  assert.equal(fetchImpl.calls.length, 1)
  assert.match(fetchImpl.calls[0].url, /\/screenshot\?fresh=1$/)
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer tok123')
  rmSync(dir, { recursive: true, force: true })
})

test('screenshot with fresh:false leaves the cache decision to the relay', async () => {
  const fetchImpl = fakeFetch()
  const { conn, dir } = makeShotConnection(fetchImpl)
  await conn.screenshot({ fresh: false })
  assert.match(fetchImpl.calls[0].url, /\/screenshot$/)
  rmSync(dir, { recursive: true, force: true })
})

test('screenshot omits the Authorization header when no token is configured', async () => {
  const fetchImpl = fakeFetch()
  const { conn, dir } = makeShotConnection(fetchImpl, { token: '' })
  await conn.screenshot()
  assert.deepEqual(fetchImpl.calls[0].init.headers, {})
  rmSync(dir, { recursive: true, force: true })
})

test('screenshot surfaces an HTTP failure with its status', async () => {
  const { conn, dir } = makeShotConnection(fakeFetch({ status: 401, body: 'unauthorized' }))
  await assert.rejects(() => conn.screenshot(), /HTTP 401[\s\S]*unauthorized/)
  rmSync(dir, { recursive: true, force: true })
})

test('screenshot reports a transport failure rather than writing a file', async () => {
  const { conn, dir } = makeShotConnection(fakeFetch({ throwError: 'ECONNREFUSED' }))
  await assert.rejects(() => conn.screenshot(), /screenshot request failed[\s\S]*ECONNREFUSED/)
  rmSync(dir, { recursive: true, force: true })
})

test('screenshot refuses when no HTTP base could be derived', async () => {
  const { conn, dir } = makeShotConnection(fakeFetch(), { httpBase: '' })
  await assert.rejects(() => conn.screenshot(), /no HTTP base/)
  rmSync(dir, { recursive: true, force: true })
})

test('screenshot rejects an empty body instead of writing a zero-byte file', async () => {
  const { conn, dir } = makeShotConnection(fakeFetch({ body: Buffer.alloc(0) }))
  await assert.rejects(() => conn.screenshot(), /was empty/)
  rmSync(dir, { recursive: true, force: true })
})

test('screenshot does not require an established ACP session', async () => {
  // The capture path is independent of the WebSocket link, so a worker whose agent is busy
  // (or whose link is down) can still be photographed.
  const fetchImpl = fakeFetch()
  const { conn, dir } = makeShotConnection(fetchImpl)
  assert.equal(conn.connected, false)
  const shot = await conn.screenshot()
  assert.ok(existsSync(shot.localPath))
  assert.equal(fetchImpl.calls.length, 1)
  rmSync(dir, { recursive: true, force: true })
})
