/**
 * Tests for the settings route's `cache` action: the screenshot-cache controls the page grew.
 *
 * WHY THIS FILE EXISTS: `lib/core/shot-gc.js` is unit-tested for the pruning RULES
 * (test/shot-gc.test.js) and the worker half is tested where it lives
 * (test/relay-shotcache.test.js). Neither covers the seam in between -- the route that decides
 * WHICH directory, against WHICH budget, on WHICH side -- and that seam is exactly where this
 * feature's two failure modes live:
 *
 *   * an absent `maxBytes` must fall back to the SAVED ceiling, because the danger of reading it
 *     as 0 is not "it deletes too much" but "the operator's ceiling is silently ignored";
 *   * the worker side must treat "this relay does not know that RPC" as a MISSING REPORT rather
 *     than as a broken link, or a perfectly healthy worker is shown as broken.
 *
 * EVERY directory here is a fresh `mkdtempSync`. The host's real cache lives in the system temp
 * directory shared with everything else, so a test that pruned or cleared it would delete the
 * operator's own captures -- a far worse outcome than the bug it would be guarding.
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { makeSettingsRoute } from '../lib/index.js'
import { PeerConnection } from '../lib/bridge/peer-connection.js'
import { TaskRegistry } from '../lib/core/task-registry.js'

/** A throwaway cache directory. `await`s the body so cleanup cannot race the assertions. */
async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ru-cache-route-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Create `count` captures for `peerId`, oldest first, one second apart, `size` bytes each. */
function seed(dir, peerId, count, size = 1024) {
  const base = Date.parse('2026-10-13T00:00:00.000Z')
  for (let n = 0; n < count; n += 1) {
    const stamp = new Date(base + n * 1000).toISOString().replace(/[:.]/gu, '-')
    const path = join(dir, `${peerId}-${stamp}.png`)
    writeFileSync(path, Buffer.alloc(size, n))
    const when = (base + n * 1000) / 1000
    utimesSync(path, when, when)
  }
}

/**
 * Count one worker's CAPTURES in `dir`, by the same shape the plugin writes.
 *
 * Not `name.startsWith(peerId + '-')`: one of the foreign files below is deliberately called
 * `w1-notastamp.png`, so a prefix test would count something this plugin never wrote and quietly
 * make the assertion about the wrong set.
 */
function captureCount(dir, peerId) {
  const pattern = new RegExp(`^${peerId}-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z\\.png$`, 'u')
  return readdirSync(dir).filter((name) => pattern.test(name)).length
}

/**
 * A worker runtime whose CONNECTION is the real `PeerConnection`.
 *
 * Deliberately not a hand-written stub: the route's host branch calls three methods on the
 * connection and reads their result shapes, and a stub implements only the ones its author
 * remembered -- which is how "the route called a method the real object does not have" shipped
 * once already (see the note above the ping tests in settings-page.test.js). A real connection
 * pointed at a temp directory also means the numbers under test are produced by the shipping
 * code rather than restated in the test.
 */
function hostPeer(peerId, shotDir, opts = {}) {
  const connection = new PeerConnection({
    peerId,
    shotDir,
    keepShots: opts.keepShots ?? 20,
    shotCacheBytes: opts.shotCacheBytes ?? 0,
    heartbeatMs: 0,
    // The host branch is local directory work. A connect attempt here would make "clear the
    // cache" depend on the worker being awake, so this throws to make that visible if it happens.
    createBridge: () => { throw new Error('the cache route must not connect for a local scan') },
  })
  return { peerId, name: peerId, defaultCwd: 'C:\\work', connection, bridge: connection }
}

/** A real connection carrying a fake, already-established bridge. */
function connectedConnection(peerId, shotDir, callPlugin) {
  const connection = new PeerConnection({
    peerId,
    shotDir,
    heartbeatMs: 0,
    createBridge: () => { throw new Error('unused: the bridge is installed directly') },
  })
  connection.bridge = { connected: true, callPlugin, dispose: async () => {} }
  return connection
}

function makeCacheRoute(peers, settings = {}) {
  return makeSettingsRoute({
    peers,
    registry: new TaskRegistry({}),
    cache: { size: 0, misses: 0 },
    // The route reads the SAVED ceiling through this getter; the default in the real build is
    // `apply()`'s live config, which is the settings file merged over the profile patch.
    currentSettings: () => ({ workers: [], ...settings }),
  })
}

/** POST one cache request the way the page does, and return the parsed reply. */
async function postCache(route, payload) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.destroy = () => {}
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {} },
    end(chunk) { this.body = chunk ?? '' },
  }
  queueMicrotask(() => {
    req.emit('data', Buffer.from(JSON.stringify({ action: 'cache', ...payload })))
    req.emit('end')
  })
  await route.handler(req, res)
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

// ---------------------------------------------------------------------------
// the host side: the copies this machine wrote, in one shared directory
// ---------------------------------------------------------------------------

test('host prune deletes the OLDEST captures down to the byte budget and reports what it freed', async () => {
  await withDir(async (dir) => {
    seed(dir, 'w1', 5, 1024)
    seed(dir, 'w2', 3, 1024)
    const route = makeCacheRoute(new Map([['w1', hostPeer('w1', dir)], ['w2', hostPeer('w2', dir)]]))

    const { status, body } = await postCache(route, { peerId: 'w1', scope: 'host', op: 'prune', maxBytes: 3 * 1024 })

    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.ok, true)
    assert.equal(body.scope, 'host')
    assert.equal(body.cleared, false)
    assert.equal(body.result.removed, 2)
    assert.equal(body.result.freedBytes, 2 * 1024, 'the page shows this number as reclaimed space')
    assert.equal(body.result.bytes, 3 * 1024)
    // The reply also carries a fresh scan, which is what the page renders. If the two disagreed,
    // the page would show a figure the directory does not have.
    assert.equal(body.hostCache.bytes, 3 * 1024)
    assert.equal(body.hostCache.files, 3)
    assert.equal(captureCount(dir, 'w1'), 3)
    // The directory is SHARED between workers, so this is the assertion that matters most: one
    // worker's budget must never be spent on another worker's captures.
    assert.equal(captureCount(dir, 'w2'), 3)
  })
})

test('host clear removes every capture for that worker and leaves another worker alone', async () => {
  await withDir(async (dir) => {
    seed(dir, 'w1', 3, 1000)
    seed(dir, 'w2', 2, 1000)
    // Files this plugin did not write live in the same temp directory. They must survive a button
    // called "clear cache" -- the pattern, not the directory, is what makes that safe.
    const foreign = ['notes.txt', 'w1-notastamp.png', 'screenshot.png']
    for (const name of foreign) writeFileSync(join(dir, name), 'keep me')
    const route = makeCacheRoute(new Map([['w1', hostPeer('w1', dir)], ['w2', hostPeer('w2', dir)]]))

    const { status, body } = await postCache(route, { peerId: 'w1', scope: 'host', op: 'clear' })

    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.cleared, true)
    assert.equal(body.result.removed, 3)
    assert.equal(captureCount(dir, 'w1'), 0)
    assert.equal(captureCount(dir, 'w2'), 2, 'w2 must be untouched')
    for (const name of foreign) assert.equal(readdirSync(dir).includes(name), true, `${name} must survive`)
  })
})

// ---------------------------------------------------------------------------
// the budget the request carries, and what its absence means
// ---------------------------------------------------------------------------

test('a request with NO maxBytes falls back to the SAVED ceiling, not to 0', async () => {
  await withDir(async (dir) => {
    seed(dir, 'w1', 5, 1024)
    // The count budget is 20, so it cannot delete anything here: every removal below is the byte
    // budget's doing, which is what makes the fallback attributable.
    const route = makeCacheRoute(new Map([['w1', hostPeer('w1', dir)]]), { shotCacheBytes: 2 * 1024 })

    const { status, body } = await postCache(route, { peerId: 'w1', scope: 'host', op: 'prune' })

    assert.equal(status, 200, JSON.stringify(body))
    // Falling back to 0 would NOT delete everything -- 0 means "no byte budget" -- so the failure
    // this guards is quiet: the button would report success having deleted nothing, while the
    // ceiling the operator configured a moment ago was ignored.
    assert.equal(body.result.removed, 3)
    assert.equal(body.result.kept, 2)
    assert.equal(body.result.maxBytes, 2 * 1024, 'the ceiling it applied must be the saved one')
    assert.equal(captureCount(dir, 'w1'), 2)
  })
})

test('an explicit maxBytes of 0 means "no ceiling", and it OVERRIDES the saved setting', async () => {
  await withDir(async (dir) => {
    seed(dir, 'w1', 4, 1024)
    // A saved ceiling that WOULD bite. This is what separates "0 means no budget" from "0 means
    // the field was blank, use the setting": with the setting in force three files would go.
    const route = makeCacheRoute(new Map([['w1', hostPeer('w1', dir)]]), { shotCacheBytes: 1024 })

    const { status, body } = await postCache(route, { peerId: 'w1', scope: 'host', op: 'prune', maxBytes: 0 })

    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.result.maxBytes, 0)
    assert.equal(body.result.removed, 0, 'an explicit "no ceiling" must delete nothing')
    assert.equal(body.result.overBudgetBytes, 0)
    assert.equal(captureCount(dir, 'w1'), 4)
  })
})

test('an ABSENT or unrecognised scope acts on the host side rather than doing nothing', async () => {
  // Pins the implemented default instead of assuming it: `scope` is only ever `worker` when it is
  // that exact string, so a typo (or an older caller that sends no scope at all) resolves to the
  // local directory. Asserting it here means a later change to that default has to be deliberate.
  await withDir(async (dir) => {
    seed(dir, 'w1', 4, 1024)
    const route = makeCacheRoute(new Map([['w1', hostPeer('w1', dir)]]))

    const { status, body } = await postCache(route, { peerId: 'w1', op: 'prune', maxBytes: 2 * 1024 })

    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.scope, 'host')
    assert.equal(body.result.removed, 2)
  })
})

// ---------------------------------------------------------------------------
// the worker side: a report that may legitimately be missing
// ---------------------------------------------------------------------------

test('a worker whose relay PREDATES the RPC is reported as unsupported, not as a failure', async () => {
  await withDir(async (dir) => {
    const connection = connectedConnection('w1', dir, async () => {
      // The exact shape an older relay answers, and the exact string the connection matches on.
      throw new Error('unknown plugin method "dsh-remote/shotcache" (-32601)')
    })
    const route = makeCacheRoute(new Map([['w1', { peerId: 'w1', name: 'w1', defaultCwd: 'C:\\work', connection, bridge: connection }]]))

    const { status, body } = await postCache(route, { peerId: 'w1', scope: 'worker', op: 'prune', maxBytes: 1024 })

    // 200, not 502: the link is healthy and only the REPORT is missing. Treating it as an error
    // sends the operator to debug a working connection.
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.ok, true)
    // Two different facts, two fields: the HOST half of the reply is always readable (it is this
    // machine's own directory), while the WORKER half is what an older relay cannot answer.
    assert.equal(body.supported, true, 'this machine can always describe its own disk')
    assert.equal(body.workerSupported, false)
    assert.equal(body.workerCache.supported, false)
    assert.equal(body.workerCache.error, '', 'a missing capability is not an error message')
    // The link must survive: an unknown method is a property of the worker, not of the socket.
    assert.equal(connection.connected, true, 'the connection must not be discarded for an unknown method')
  })
})

test('the worker side asks for a prune or a clear, and reports the numbers the relay gave', async () => {
  await withDir(async (dir) => {
    const seen = []
    const connection = connectedConnection('w1', dir, async (method, params) => {
      seen.push({ method, params })
      return { files: 2, bytes: 2048, newestAt: 5, oldestAt: 1, keepShots: 20, maxBytes: 1024, dir: 'C:\\w\\shots', pruned: { removed: 1 } }
    })
    const route = makeCacheRoute(new Map([['w1', { peerId: 'w1', name: 'w1', defaultCwd: 'C:\\work', connection, bridge: connection }]]))

    const pruned = await postCache(route, { peerId: 'w1', scope: 'worker', op: 'prune', maxBytes: 1024 })
    assert.equal(pruned.status, 200, JSON.stringify(pruned.body))
    assert.equal(pruned.body.supported, true)
    // The relay's report is passed through: the page shows the worker's OWN directory, which is the
    // half an operator cannot see from here.
    assert.equal(pruned.body.workerCache.files, 2)
    assert.equal(pruned.body.workerCache.dir, 'C:\\w\\shots')

    const cleared = await postCache(route, { peerId: 'w1', scope: 'worker', op: 'clear' })
    assert.equal(cleared.status, 200)

    assert.deepEqual(seen.map((s) => s.method), ['dsh-remote/shotcache', 'dsh-remote/shotcache'])
    // The two operations must not be swapped: sending `prune` for a Clear would leave files behind
    // while the page said they were gone, and sending `clear` for an Apply would delete everything.
    assert.deepEqual(seen[0].params, { maxBytes: 1024, prune: true })
    // The budget travels with a Clear too (the saved setting is 0 here): the relay is told what the
    // ceiling is regardless, so the report it returns can say whether anything is still over it.
    assert.deepEqual(seen[1].params, { maxBytes: 0, clear: true })
  })
})

test('a connection without workerShotCache is reported as "cannot report", not as a failure', async () => {
  await withDir(async (dir) => {
    // A connection built before this feature existed -- or a stub. It has no `workerShotCache`
    // method and no `supportsWorkerShotCache` getter, so it cannot report its cache.
    //
    // THE CONTRACT THIS PINS: "this worker cannot report its cache" is a PROPERTY OF THE WORKER,
    // not a link failure, so it must not be dressed up as one. An earlier revision called the
    // method unconditionally, which threw a TypeError that the route's catch turned into a 502 --
    // and a 502 reads as "the worker side broke", sending the operator to debug a healthy link.
    // The snapshot path had already decided the same absence was merely "no report"; the two now
    // agree, and both get it from `supportsWorkerShotCache`.
    const connection = { connected: true, stats: { connected: true } }
    const route = makeCacheRoute(new Map([['w1', { peerId: 'w1', name: 'w1', defaultCwd: 'C:\\work', connection, bridge: connection }]]))

    const { status, body } = await postCache(route, { peerId: 'w1', scope: 'worker', op: 'prune' })

    assert.equal(status, 200, 'a missing optional capability is not an error status')
    assert.equal(body.ok, true)
    assert.equal(body.supported, true, 'the HOST half is always readable: it is this machine\'s own directory')
    assert.equal(body.workerSupported, false, 'the WORKER half is what cannot report')
    assert.equal(body.workerCache.files, 0)
    assert.equal(body.workerCache.error, '', 'an absent capability is not an error message')
  })
})

test('an unknown peerId is still a 404 for the cache action', async () => {
  await withDir(async (dir) => {
    seed(dir, 'w1', 2, 1024)
    const route = makeCacheRoute(new Map([['w1', hostPeer('w1', dir)]]))

    const { status, body } = await postCache(route, { peerId: 'ghost', scope: 'host', op: 'clear' })

    assert.equal(status, 404)
    assert.match(String(body.error), /no such worker/)
    // A refused request must do NO work: the real worker's captures are still there.
    assert.equal(captureCount(dir, 'w1'), 2)
  })
})
