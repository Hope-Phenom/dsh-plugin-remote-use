// Tests for the worker connection manager.
//
// REGRESSION CONTEXT: the first shipped version used AcpBridge directly and never called
// connect(), so every path failed with "AcpBridge.callPlugin: not connected" while all
// unit and integration tests passed (they injected already-connected fakes). These tests
// exist so that cannot happen again.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
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
    /** Liveness probe target. `bridge.pingFails` lets a test kill the link mid-flight. */
    async callPlugin(method, params, o) {
      calls.callPlugin = (calls.callPlugin ?? 0) + 1
      if (bridge.pingFails === true) throw new Error('ACP connection closed')
      if (o?.timeoutMs !== undefined) calls.lastPingTimeoutMs = o.timeoutMs
      return { pong: true, method }
    },
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

// ---------------------------------------------------------------------------
// file transfer
//
// The bytes must NOT travel through the ACP pump: a multi-gigabyte file inside a JSON-RPC result
// would be base64 (a third larger), would have to be held in memory, and would queue every GUI
// control frame behind it on the single relay socket. So the transfers are asserted against the
// relay's HTTP face, with `fetch` doubled -- the same shape as the screenshot tests above.
// ---------------------------------------------------------------------------

/** A fetch double that answers the four file endpoints and records every request. */
function fakeTransferFetch(opts = {}) {
  const calls = []
  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const query = new URL(url)
    let body = null
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
      const chunks = []
      for await (const chunk of init.body) chunks.push(chunk)
      body = Buffer.concat(chunks)
    }
    calls.push({ url, method, headers: init.headers ?? {}, query, body, stringBody: typeof init.body === 'string' ? init.body : null })
    if (opts.throwError !== undefined) throw new Error(opts.throwError)
    if (opts.status !== undefined && opts.status !== 200) {
      return { status: opts.status, headers: new Headers(), async text() { return opts.error ?? 'no' }, async json() { return { ok: false, error: opts.error ?? 'no' } } }
    }
    if (method === 'PUT') return { status: 200, headers: new Headers(), async json() { return { ok: true, offset: 0, received: body?.length ?? 0 } } }
    if (method === 'POST') return { status: 200, headers: new Headers(), async json() { return { ok: true, sha256: 'c'.repeat(64), bytes: 1, mtime: 't' } } }
    if (method === 'DELETE') return { status: 200, headers: new Headers(), async json() { return { ok: true, removed: true, part: '/d/x.part' } } }
    const payload = opts.payload ?? Buffer.from('downloaded')
    return {
      status: 200,
      headers: new Headers({
        'x-file-size': String(payload.length),
        'x-file-sha256': createHash('sha256').update(payload).digest('hex'),
        'x-file-path': '/abs/from-worker.bin',
      }),
      body: Readable.toWeb(Readable.from([payload])),
    }
  }
  impl.calls = calls
  return impl
}

/** A connection wired for HTTP transfers, with a scratch receive directory. */
function makeTransferConnection(fetchImpl, overrides = {}) {
  const { conn, created } = makeConnection()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-xfer-conn-'))
  conn.httpBase = overrides.httpBase ?? 'http://worker:7331'
  conn.token = overrides.token ?? 'secret'
  conn.fetchImpl = fetchImpl
  conn.receiveDir = overrides.receiveDir ?? dir
  conn.transferMaxBytes = overrides.transferMaxBytes ?? 8 * 1024 * 1024 * 1024
  return { conn, created, dir }
}

test('sendFile chunks the file over HTTP with the bearer token, and never connects', async () => {
  const fetchImpl = fakeTransferFetch()
  const { conn, created, dir } = makeTransferConnection(fetchImpl)
  const src = join(dir, 'big.bin')
  const size = 4 * 1024 * 1024 * 2 + 512
  writeFileSync(src, Buffer.alloc(size, 7))

  assert.equal(conn.connected, false)
  const result = await conn.sendFile({ localPath: src, remotePath: 'remote.bin' })

  // TWO chunks plus the tail must be two-plus PUTs: one body holding the whole file is the exact
  // regression this pins, and it is invisible in the result object.
  const puts = fetchImpl.calls.filter((c) => c.method === 'PUT')
  assert.equal(puts.length, 3)
  assert.deepEqual(puts.map((p) => Number(p.query.searchParams.get('offset'))), [0, 4194304, 8388608])
  assert.deepEqual(puts.map((p) => p.headers['content-length']), ['4194304', '4194304', '512'])
  assert.deepEqual(puts.map((p) => p.body.length), [4194304, 4194304, 512], 'each request carries only its own slice')
  assert.equal(puts[0].headers.authorization, 'Bearer secret')
  assert.equal(result.peerId, 'labpc')
  assert.equal(result.size, size)

  const commit = fetchImpl.calls.filter((c) => c.method === 'POST')
  assert.equal(commit.length, 1)
  assert.match(commit[0].url, /\/file\/commit$/)
  assert.equal(commit[0].headers['content-type'], 'application/json')
  assert.equal(JSON.parse(commit[0].stringBody).size, size)

  assert.equal(created.length, 0, 'an upload must not require an ACP session')
  assert.equal(conn.connected, false)
  rmSync(dir, { recursive: true, force: true })
})

test('sendFile refuses a source over transferMaxBytes without issuing a request', async () => {
  // The host ceiling is checked before anything is sent, so a refusal costs no bytes -- and the
  // fetch double makes "no request" checkable rather than merely claimed.
  const fetchImpl = fakeTransferFetch()
  const { conn, dir } = makeTransferConnection(fetchImpl, { transferMaxBytes: 10 })
  const src = join(dir, 'big.bin')
  writeFileSync(src, Buffer.alloc(4096))

  await assert.rejects(() => conn.sendFile({ localPath: src, remotePath: 'remote.bin' }), /exceeds the 10-byte limit/)
  assert.equal(fetchImpl.calls.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('fetchFile streams into the receive directory and stages before the final name', async () => {
  const payload = Buffer.from('the worker sent this')
  const fetchImpl = fakeTransferFetch({ payload })
  const { conn, dir } = makeTransferConnection(fetchImpl)

  const result = await conn.fetchFile({ remotePath: 'C:\\work\\report.txt' })

  assert.equal(result.localPath.startsWith(dir), true, `${result.localPath} should be under ${dir}`)
  assert.match(result.localPath, /labpc-[\dTZ-]+-report\.txt$/, 'the peer id and a stamp make two pulls of one path two files')
  assert.deepEqual(readFileSync(result.localPath), payload)
  assert.equal(existsSync(`${result.localPath}.part`), false, 'the staging file must not survive a success')
  assert.equal(result.receiveDir, dir)
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer secret')
  rmSync(dir, { recursive: true, force: true })
})

test('fetchFile hashes the body and refuses to rename a mismatched download', async () => {
  const fetchImpl = fakeTransferFetch({ payload: Buffer.from('real bytes') })
  const { conn, dir } = makeTransferConnection(fetchImpl)
  const dest = join(dir, 'exact.bin')
  // The response is doctored so the digest cannot match: the download must fail and leave nothing
  // plausible at the destination, because a wrong file with the right name is silent data corruption.
  const original = fetchImpl
  conn.fetchImpl = async (url, init) => {
    const res = await original(url, init)
    if (res.body !== undefined) res.headers.set('x-file-sha256', 'f'.repeat(64))
    return res
  }

  await assert.rejects(() => conn.fetchFile({ remotePath: 'remote.bin', destPath: dest }), /failed verification/)
  assert.equal(existsSync(dest), false)
  rmSync(dir, { recursive: true, force: true })
})

test('fetchFile carries the peer id into a transport failure', async () => {
  const fetchImpl = fakeTransferFetch({ throwError: 'ECONNREFUSED' })
  const { conn, dir } = makeTransferConnection(fetchImpl)
  await assert.rejects(
    () => conn.fetchFile({ remotePath: 'remote.bin', destPath: join(dir, 'x.bin') }),
    /worker "labpc" GET \/file[\s\S]*ECONNREFUSED/,
  )
  rmSync(dir, { recursive: true, force: true })
})

test('both HTTP transfer directions refuse when no HTTP base could be derived', async () => {
  const fetchImpl = fakeTransferFetch()
  const { conn, dir } = makeTransferConnection(fetchImpl, { httpBase: '' })
  const src = join(dir, 'a.bin')
  writeFileSync(src, Buffer.from('x'))
  await assert.rejects(() => conn.sendFile({ localPath: src, remotePath: 'r.bin' }), /no HTTP base/)
  await assert.rejects(() => conn.fetchFile({ remotePath: 'r.bin' }), /no HTTP base/)
  await assert.rejects(() => conn.abortTransfer({ remotePath: 'r.bin' }), /no HTTP base/)
  assert.equal(fetchImpl.calls.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('abortTransfer asks the relay to delete only the staging file', async () => {
  const fetchImpl = fakeTransferFetch()
  const { conn, dir } = makeTransferConnection(fetchImpl)
  const result = await conn.abortTransfer({ remotePath: 'remote.bin' })
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].method, 'DELETE')
  assert.equal(fetchImpl.calls[0].query.searchParams.get('path'), 'remote.bin')
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer secret')
  assert.equal(result.removed, true)
  assert.equal(result.peerId, 'labpc')
  // No DELETE may ever name the target itself: cancelling must be unable to destroy a file.
  assert.equal(fetchImpl.calls[0].query.searchParams.get('path').endsWith('.part'), false)
  rmSync(dir, { recursive: true, force: true })
})

test('statFile and listFiles ask the worker over the RPC channel, connecting first', async () => {
  const { conn, created } = makeConnection()
  const seen = []
  let connects = 0
  conn.createBridge = () => {
    const bridge = fakeBridge()
    const inner = bridge.connect
    bridge.connect = async () => { connects += 1; return await inner() }
    bridge.callPlugin = async (method, params, o) => {
      seen.push({ method, params, o })
      if (method === 'dsh-remote/stat') return { ok: true, path: params.path, exists: true, isDir: false, size: 99, mtime: 'T' }
      return { ok: true, path: params.path, entries: [{ name: 'a', isDir: false, size: 3, mtime: 'T' }], truncated: false }
    }
    return bridge
  }

  const stat = await conn.statFile('C:\\work\\a.bin', { timeoutMs: 5000 })
  const list = await conn.listFiles('C:\\work', { limit: 10 })

  assert.equal(connects, 1, 'the RPC path needs a session, unlike the HTTP one')
  assert.equal(conn.connected, true)
  assert.equal(stat.size, 99)
  assert.equal(list.entries[0].name, 'a')
  assert.deepEqual(seen, [
    { method: 'dsh-remote/stat', params: { path: 'C:\\work\\a.bin' }, o: { timeoutMs: 5000 } },
    { method: 'dsh-remote/list', params: { path: 'C:\\work', limit: 10 }, o: {} },
  ])
})

test('a worker that does not know the stat RPC keeps the link: an older relay is not a dead one', async () => {
  // REGRESSION SHAPE: tearing the link down here would turn "this worker predates the feature" into a
  // reconnect loop, so the same reading `workerShotCache` makes must hold on this path too.
  const { conn, created } = makeConnection()
  await conn.startTask({ cwd: 'c', prompt: 'a' })
  created[0].callPlugin = async () => { throw new Error('unknown plugin method: dsh-remote/stat (-32601)') }

  await assert.rejects(() => conn.statFile('C:\\x'), /-32601/)
  assert.equal(conn.connected, true, 'the link is healthy; only the capability is missing')
  assert.equal(created[0].calls.dispose, 0)
})

test('a transfer RPC over a dead link drops it so the next call reconnects', async () => {
  const { conn, created } = makeConnection()
  await conn.startTask({ cwd: 'c', prompt: 'a' })
  created[0].callPlugin = async () => { throw new Error('ACP connection closed') }

  await assert.rejects(() => conn.listFiles('C:\\x'), /connection closed/)
  assert.equal(conn.connected, false)
  assert.equal(created[0].calls.dispose, 1)
})

// ---------------------------------------------------------------------------
// liveness heartbeat
//
// REGRESSION CONTEXT: AcpBridge does not watch its socket, and the relay closes it on
// restart, so `connected` kept reporting true over a dead link. The first call after any
// worker restart therefore failed -- measured on the real worker, where it surfaced as the
// misleading "nobody is logged in" message. The heartbeat turns that silent death into a
// prompt reconnect.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeHeartbeatConnection(bridgeOpts = {}, connOpts = {}) {
  const { conn, created, logs } = makeConnection(bridgeOpts)
  conn.heartbeatMs = connOpts.heartbeatMs ?? 20
  conn.heartbeatTimeoutMs = connOpts.heartbeatTimeoutMs ?? 200
  return { conn, created, logs }
}

test('the heartbeat probes the relay while a link is alive', async () => {
  const { conn, created } = makeHeartbeatConnection()
  await conn.startTask({ cwd: 'c', prompt: 'a' })
  await sleep(80)
  assert.ok((created[0].calls.callPlugin ?? 0) >= 1, 'the link must be probed')
  assert.ok(conn.heartbeats >= 1, 'successful probes must be counted')
  assert.ok(conn.lastHeartbeatAt > 0)
  assert.equal(conn.heartbeatFailures, 0)
  await conn.dispose()
})

test('a failed heartbeat discards the link so the next call reconnects', async () => {
  const { conn, created, logs } = makeHeartbeatConnection()
  await conn.startTask({ cwd: 'c', prompt: 'a' })
  assert.equal(conn.connected, true)

  // The worker goes away: probes start failing.
  created[0].pingFails = true
  await sleep(90)

  assert.equal(conn.connected, false, 'the dead link must not keep reporting connected')
  assert.ok(conn.heartbeatFailures >= 1)
  assert.equal(created[0].calls.dispose, 1, 'the dead bridge must be disposed')
  assert.ok(logs.some(([, m]) => /heartbeat failed/.test(m)), 'the drop must be logged')

  // The next call must build a fresh bridge and succeed WITHOUT a user-visible failure --
  // that is the whole point of probing between calls.
  const result = await conn.startTask({ cwd: 'c', prompt: 'b' })
  assert.equal(result.stopReason, 'completed')
  assert.equal(created.length, 2, 'a fresh bridge must have been created')
  await conn.dispose()
})

test('the heartbeat stops on dispose and does not leak a timer', async () => {
  const { conn, created } = makeHeartbeatConnection()
  await conn.startTask({ cwd: 'c', prompt: 'a' })
  await sleep(50)
  const before = created[0].calls.callPlugin ?? 0
  await conn.dispose()
  await sleep(80)
  assert.equal(created[0].calls.callPlugin ?? 0, before, 'no probe may run after dispose')
  assert.equal(conn.heartbeatTimer, undefined)
})

test('heartbeatMs 0 disables probing entirely', async () => {
  const { conn, created } = makeHeartbeatConnection({}, { heartbeatMs: 0 })
  await conn.startTask({ cwd: 'c', prompt: 'a' })
  await sleep(60)
  assert.equal(created[0].calls.callPlugin ?? 0, 0)
  assert.equal(conn.heartbeats, 0)
  await conn.dispose()
})

test('the heartbeat does not run while disconnected', async () => {
  const { conn, created } = makeHeartbeatConnection()
  // Never connected: nothing to probe.
  await sleep(60)
  assert.equal(created.length, 0, 'no bridge should be built just to probe')
  await conn.dispose()
})

test('the heartbeat reports its interval and counters', async () => {
  const { conn } = makeHeartbeatConnection({}, { heartbeatMs: 25 })
  assert.equal(conn.stats.heartbeatMs, 25)
  await conn.startTask({ cwd: 'c', prompt: 'a' })
  await sleep(60)
  const s = conn.stats
  assert.ok(s.heartbeats >= 1)
  assert.equal(s.heartbeatFailures, 0)
  assert.ok(s.lastHeartbeatAt > 0)
  await conn.dispose()
})
