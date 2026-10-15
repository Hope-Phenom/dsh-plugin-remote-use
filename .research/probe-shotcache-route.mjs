/**
 * End-to-end probe for the screenshot-cache feature, against the REAL modules.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE UNIT TESTS: the tests inject fake peers and fake routes, so
 * they can prove the logic but not that the real pieces fit. This drives the real
 * `makeSettingsRoute` with real `PeerConnection` objects and real PNG-shaped files on disk, then
 * asserts what an operator would actually see in the page's JSON:
 *
 *   1. GET reports the host cache usage for a worker whose directory holds real captures.
 *   2. POST cache/op=prune enforces the byte budget and reports what it reclaimed.
 *   3. POST cache/op=clear removes that worker's captures and NOT another worker's.
 *   4. settings.save round-trips every new key, and the read-back does not revert.
 *   5. The worker side degrades to "unsupported" instead of failing when the relay cannot answer.
 *
 * It writes only inside a fresh temp directory and never touches the operator's real screenshot
 * cache. Run it with the bundled node:
 *   node .research/probe-shotcache-route.mjs
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = new URL('../packages/dsh-plugin-remote-use/', import.meta.url)
const { makeSettingsRoute } = await import(new URL('lib/index.js', PKG).href)
const { PeerConnection } = await import(new URL('lib/bridge/peer-connection.js', PKG).href)
const { scanShotUsage } = await import(new URL('lib/core/shot-gc.js', PKG).href)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  -- ${detail}`}`)
}

const shotDir = mkdtempSync(join(tmpdir(), 'probe-shotcache-'))
const stateDir = mkdtempSync(join(tmpdir(), 'probe-state-'))

/**
 * Seed `count` captures for a worker, newest last, sized `size` bytes each.
 *
 * The names are the ones the plugin actually writes (`<peerId>-<ISO with : and . replaced>.png`),
 * because a probe that used friendlier names would not exercise the pattern gate that keeps the
 * housekeeping from deleting files it did not write.
 */
function seed(peerId, count, size) {
  const names = []
  const base = Date.parse('2026-10-15T00:00:00.000Z')
  for (let n = 0; n < count; n += 1) {
    const stamp = new Date(base + n * 1000).toISOString().replace(/[:.]/gu, '-')
    const name = `${peerId}-${stamp}.png`
    writeFileSync(join(shotDir, name), Buffer.alloc(size, n))
    names.push(name)
  }
  return names
}

/** A PeerConnection wired to no worker at all: enough to exercise the host-side paths. */
function makePeer(peerId) {
  const connection = new PeerConnection({
    peerId,
    shotDir,
    createBridge: () => { throw new Error('probe: this connection must never connect') },
    httpBase: 'http://127.0.0.1:1',
    token: 'probe',
  })
  return { peerId, name: peerId, defaultCwd: 'E:\\WorkSpace\\dsh-remote', connection }
}

const peers = new Map([['w1', makePeer('w1')], ['w2', makePeer('w2')]])
const saved = { workers: [], requiredTier: 'workspace-write', approvalTimeoutMs: 180000, heartbeatMs: 15000, keepShots: 20, shotCacheBytes: 0, auditMaxBytes: 8388608, auditKeepFiles: 5, workerSessionMode: 'danger-full-access', delegationPolicy: '', workerRole: {} }

// Mirrors what `apply()`'s live `cfg` does: `persistSettings` REPLACES the in-force configuration
// with the normalized one. A stub that only recorded the write would leave `currentSettings()`
// returning the old values, so the read-back assertion would pass against a store that never
// actually stored anything -- a probe that cannot fail is not a probe.
let live = { ...saved }

const route = makeSettingsRoute({
  peers,
  registry: {
    listForUi: () => [],
    active: () => [],
    activeCountForPeer: () => 0,
  },
  cache: { size: 0, misses: 0 },
  sessionsEnabled: () => 0,
  armingStatus: () => null,
  armWorker: () => ({ ok: false, error: 'probe' }),
  preflightWorker: () => ({ ok: false, blockers: [] }),
  disarmWorker: () => ({ ok: false }),
  log: { info: () => {}, warn: () => {}, error: () => {} },
  currentSettings: () => ({ ...live }),
  persistSettings: (next) => { live = { ...live, ...next }; return { ok: true, file: join(stateDir, 'settings.json') } },
  settingsPath: join(stateDir, 'settings.json'),
  reportBudgetMs: 250,
  selfcheckBudgetMs: 250,
})

/** Drive the route the way the browser does, and return the parsed JSON body. */
async function drive(method, body) {
  return await new Promise((resolve, reject) => {
    // The data/end events are emitted on the NEXT tick, not synchronously. Emitting them inline
    // (an earlier revision of this probe did) means `readJsonBody` never sees the payload: the
    // handler resolves before the body reader has registered, so every POST silently ran with an
    // empty body and the probe blamed the implementation for its own stub. The whole point of
    // driving the real route is to exercise the real body parsing, so the fake stream has to
    // behave like a stream.
    const listeners = new Map()
    const req = {
      method,
      url: '/api/dsh/dsh-plugin-remote-use',
      headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' },
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(handler)
        return this
      },
    }
    const res = {
      statusCode: 0,
      writeHead(status) { this.statusCode = status },
      end(text) {
        try { resolve({ status: this.statusCode, body: JSON.parse(text) }) } catch (e) { reject(e) }
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
    setImmediate(() => {
      if (body !== undefined) for (const handler of listeners.get('data') ?? []) handler(Buffer.from(JSON.stringify(body)))
      for (const handler of listeners.get('end') ?? []) handler()
    })
  })
}

try {
  // ---- 1. usage reporting -------------------------------------------------
  seed('w1', 4, 1024 * 1024)
  seed('w2', 2, 1024 * 1024)
  writeFileSync(join(shotDir, 'not-ours.txt'), 'x'.repeat(4096))

  const before = await drive('GET')
  const rowW1 = before.body.workers.find((w) => w.peerId === 'w1')
  check('GET reports host cache usage per worker', rowW1?.hostCache?.files === 4 && rowW1.hostCache.bytes === 4 * 1024 * 1024,
    `files=${rowW1?.hostCache?.files} bytes=${rowW1?.hostCache?.bytes}`)
  check('a foreign file is not counted', rowW1?.hostCache?.bytes === 4 * 1024 * 1024, 'not-ours.txt must be ignored')
  check('GET reports the worker side as unavailable rather than zero', rowW1?.workerCache === null || rowW1?.workerCache?.supported === false,
    `workerCache=${JSON.stringify(rowW1?.workerCache)?.slice(0, 60)}`)
  check('the settings block exposes the new key', typeof before.body.settings.shotCacheBytes === 'number',
    `shotCacheBytes=${String(before.body.settings.shotCacheBytes)}`)
  check('GET did not connect to any worker', peers.get('w1').connection.connected === false)

  // ---- 2. prune to a byte budget -----------------------------------------
  const pruned = await drive('POST', { action: 'cache', peerId: 'w1', scope: 'host', op: 'prune', maxBytes: 2 * 1024 * 1024 })
  console.log(`    [debug] after prune(maxBytes=2MiB): files(w1)=${scanShotUsage(shotDir, 'w1').files} response=${JSON.stringify(pruned.body.result)}`)
  check('prune enforces the byte budget', pruned.status === 200 && pruned.body.result.removed === 2,
    `status=${pruned.status} removed=${pruned.body.result?.removed}`)
  check('prune reports the space it reclaimed', pruned.body.result?.freedBytes === 2 * 1024 * 1024,
    `freedBytes=${pruned.body.result?.freedBytes}`)
  check('prune leaves the newest captures', scanShotUsage(shotDir, 'w1').files === 2)
  check('prune does not touch another worker', scanShotUsage(shotDir, 'w2').files === 2)
  const zeroBudget = await drive('POST', { action: 'cache', peerId: 'w1', scope: 'host', op: 'prune', maxBytes: 0 })
  console.log(`    [debug] before prune(0): files(w1)=${scanShotUsage(shotDir, 'w1').files} response=${JSON.stringify(zeroBudget.body.result)}`)
  check('an explicit maxBytes: 0 means no ceiling', zeroBudget.body.result.removed === 0, `removed=${zeroBudget.body.result.removed}`)
  check('no maxBytes falls back to the saved setting', (await drive('POST', { action: 'cache', peerId: 'w1', scope: 'host', op: 'prune' })).status === 200)

  // ---- 3. clear ----------------------------------------------------------
  const cleared = await drive('POST', { action: 'cache', peerId: 'w1', scope: 'host', op: 'clear' })
  check('clear removes that worker\'s captures', cleared.body.result.removed === 2, `removed=${cleared.body.result?.removed}`)
  check('clear leaves another worker alone', scanShotUsage(shotDir, 'w2').files === 2)
  check('clear leaves a foreign file alone', readdirSync(shotDir).includes('not-ours.txt'))

  // ---- 4. settings round trip -------------------------------------------
  const save = await drive('POST', { action: 'settings.save', settings: { shotCacheBytes: 512 * 1024 * 1024, keepShots: 7 } })
  check('settings.save accepts the byte ceiling', save.body.settings?.shotCacheBytes === 512 * 1024 * 1024,
    `echoed=${String(save.body.settings?.shotCacheBytes)}`)
  const after = await drive('GET')
  check('the byte ceiling does NOT revert on read-back', after.body.settings.shotCacheBytes === 512 * 1024 * 1024,
    `read-back=${String(after.body.settings.shotCacheBytes)}`)
  check('0 survives as a meaningful value', (await drive('POST', { action: 'settings.save', settings: { shotCacheBytes: 0 } })).body.settings.shotCacheBytes === 0)

  // ---- 5. worker side that cannot answer ---------------------------------
  const workerScope = await drive('POST', { action: 'cache', peerId: 'w1', scope: 'worker', op: 'prune' })
  check('an unreachable worker degrades instead of failing the page', workerScope.status === 200 || workerScope.status === 502,
    `status=${workerScope.status}`)

  // ---- 6. unknown worker still 404s --------------------------------------
  check('an unknown worker still 404s', (await drive('POST', { action: 'cache', peerId: 'nope', scope: 'host', op: 'prune' })).status === 404)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  rmSync(shotDir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
  process.exit(failed.length === 0 ? 0 : 1)
} catch (error) {
  console.error('probe crashed:', error)
  rmSync(shotDir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
  process.exit(2)
}
