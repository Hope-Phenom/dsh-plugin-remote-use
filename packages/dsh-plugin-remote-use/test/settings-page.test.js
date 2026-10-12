/**
 * Tests for the Settings page: its browser-half registration and the Host data route.
 *
 * WHY THE REGISTRATION TEST MATTERS: `dsh-client-modules` runs its `dsh.client` scan
 * synchronously at construction, and a malformed declaration or missing bundle among the
 * loaded entries aggregates into one loud throw that fails the whole fiber. A typo in the
 * slot registration is therefore not a cosmetic bug -- it breaks plugin startup -- and
 * nothing else in this suite would notice.
 *
 * WHY THE RENDER TEST MATTERS: the component runs only in the browser, so a crash there is
 * invisible to every Host-side test and shows the operator a blank page. Rendering it here
 * against a minimal React stub turns "it parses" into "it produces a tree".
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { makeSettingsRoute } from '../lib/index.js'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// browser half: declaration and registration
// ---------------------------------------------------------------------------

test('package.json declares the client half the way dsh-client-modules reads it', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  // `clientExportOf` requires a "./client" export, and the declaration must name "web" or
  // the package is skipped entirely (decl.platform !== "web" -> no client half).
  assert.equal(typeof pkg.exports?.['./client'], 'string', 'exports["./client"] must be present')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  // The route the page fetches and the file it lives in must both exist.
  assert.ok(pkg.exports['./client'].endsWith('client.js'))
})

/**
 * Load lib/client.js against a stub module table, run its `apply`, and return what it
 * registered. `apply` is where registration happens, so a caller that skipped it would see
 * an empty list and draw the wrong conclusion about the plugin.
 */
function loadClient() {
  const source = readFileSync(join(PKG_ROOT, 'lib', 'client.js'), 'utf8')
  let definition
  const sandbox = { __ModuleLoader__: { load: (def) => { definition = def } } }
  // eslint-disable-next-line no-new-func -- the file is a browser bundle, not an ES module
  new Function('window', source)(sandbox)

  assert.ok(definition !== undefined, 'client.js must call window.__ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-plugin-remote-use')

  const react = makeReactStub()
  const moduleExports = definition.factory((name) => {
    if (name === 'react') return react
    throw new Error(`client.js requested unexpected module "${name}"`)
  })

  const registered = []
  const dictionaries = []
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (ns, dicts) => { dictionaries.push({ ns, dicts }) },
    },
    // Cordis runs an effect body immediately, so mirroring that keeps the test honest.
    effect: (fn) => fn(),
    slots: {
      inject: (_slot, fn) => fn(),
      register: (decl, component) => { registered.push({ decl, component }) },
    },
  }
  assert.equal(registered.length, 0, 'nothing may be registered before apply runs')
  moduleExports.apply(ctx)

  return { definition, moduleExports, registered, dictionaries, ctx, react }
}

test('the client registers exactly one settings.section for this plugin', () => {
  const { moduleExports, registered, dictionaries } = loadClient()
  assert.deepEqual(moduleExports.inject, ['slots', 'locale'])
  assert.equal(typeof moduleExports.apply, 'function')
  assert.equal(registered.length, 1, 'exactly one section, or the Settings nav duplicates')

  const { decl, component } = registered[0]
  assert.equal(decl.name, 'settings.section')
  assert.equal(decl.id, 'dsh-plugin-remote-use')
  assert.equal(decl.locale, 'dsh-plugin-remote-use')
  assert.equal(typeof component, 'function')
  // A number is required: the nav orders sections by it.
  assert.equal(typeof decl.order, 'number')

  assert.equal(dictionaries.length, 1, 'the namespace must be registered')
  assert.equal(dictionaries[0].ns, 'dsh-plugin-remote-use')
  assert.ok(dictionaries[0].dicts.zh.nav, 'zh dictionary must carry the nav label')
  assert.ok(dictionaries[0].dicts.en.nav, 'en dictionary must carry the nav label')
})

// ---------------------------------------------------------------------------
// browser half: rendering
// ---------------------------------------------------------------------------

/**
 * Minimal React stand-in: enough for createElement and the hooks the page uses, so the
 * component can be invoked as a plain function and its tree inspected.
 *
 * `useState` supports seeding by hook POSITION. The page loads its snapshot through an
 * async effect, which this stub deliberately does not run -- without a seed the component
 * always renders its empty state and no data-bearing assertion is possible. Seeding the
 * first hook is what lets these tests cover the populated tree at all; hooks are called in
 * a fixed order, so the index is stable.
 */
function makeReactStub() {
  const state = { index: 0, seeds: [] }
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return {
    __state: state,
    createElement,
    useState: (initial) => {
      const index = state.index
      state.index += 1
      const seed = state.seeds[index]
      if (seed !== undefined) return [seed, () => {}]
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
}

/** Walk a stub element tree and collect every string leaf. */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) textOf(child, out)
  }
  return out
}

/** Collect every element whose props.className contains `token`. */
function findByClass(node, token, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) findByClass(child, token, out); return out }
  if (typeof node.props?.className === 'string' && node.props.className.includes(token)) out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) findByClass(child, token, out)
  return out
}

/**
 * Expand function components the way React would.
 *
 * `createElement` only builds an element; without this step a component passed as `type`
 * (WorkerCard) is never invoked and its content never reaches the tree -- which silently
 * made a "worker row renders" assertion fail while the inline task table passed.
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }))
  return { ...node, children: (node.children ?? []).map(expand) }
}

function renderWith(workers, tasks = []) {
  const { registered, react } = loadClient()
  const Section = registered[0].component
  // A stand-in translator: the real dictionary is registered on the Host-bound locale
  // service, so the page is rendered here against stable sentinels instead.
  const t = (key, values) => {
    const template = { title: 'TITLE', description: 'DESC', roleNote: 'ROLE-NOTE', noWorkers: 'NO-WORKERS', nav: 'NAV' }[key] ?? key
    return values === undefined ? template : String(template).replace(/\{(\w+)\}/g, (w, k) => (k in values ? values[k] : w))
  }
  // Seed the component's first useState (its snapshot) so the populated tree is rendered.
  react.__state.index = 0
  react.__state.seeds = [{ ok: true, workers, tasks }]
  return expand(Section({ t }))
}

test('the section renders its heading and the honest role note without a worker list', () => {
  const tree = renderWith([])
  const text = textOf(tree).join(' ')
  assert.match(text, /TITLE/)
  assert.match(text, /DESC/)
  // The page must not pretend a role switch exists; it states the current role instead.
  assert.match(text, /ROLE-NOTE/)
  assert.match(text, /NO-WORKERS/)
})

test('the section renders a worker row with its readiness verdict', () => {
  const tree = renderWith([{
    peerId: 'worker-pc',
    name: 'worker-pc',
    cwd: 'C:\\dsh-remote\\p0work',
    error: '',
    activeTasks: 2,
    report: {
      worker: 'WORKER-PC',
      sessionSegment: 'ok',
      verdict: 'ready',
      blockingFailures: 0,
      warnings: 0,
      unchecked: 0,
      cachedAgeMs: 12,
      checks: [
        { id: 'S1', name: 'display adapter attached', severity: 'blocking', status: 'pass', actual: '4 adapters', fix: 'x' },
        { id: 'S7', name: 'session unlocked', severity: 'blocking', status: 'fail', actual: 'Locked', fix: 'unlock it' },
      ],
    },
    connection: { connected: true, connects: 3, bridge: { approvals: 2 }, heartbeatFailures: 1 },
  }])
  const text = textOf(tree).join(' ')
  assert.match(text, /worker-pc/)
  assert.match(text, /C:\\dsh-remote\\p0work/)
  assert.match(text, /WORKER-PC/)
  assert.match(text, /2/, 'active task count must appear')
  // Only the failing check is listed until the operator expands, so the fix text is present
  // while the passing check's name is not.
  assert.match(text, /unlock it/)
  assert.doesNotMatch(text, /display adapter attached/)
})

test('the section renders a task row and marks an active one', () => {
  const tree = renderWith([], [{
    taskId: 'rtask_1',
    peerId: 'worker-pc',
    state: 'running',
    toolCallCount: 4,
    recentTools: ['pwsh'],
    startedAt: 1700000000000,
  }])
  const text = textOf(tree).join(' ')
  assert.match(text, /rtask_1/)
  assert.match(text, /running/)
  assert.match(text, /pwsh/)
})

test('a malformed worker row does not crash the render', () => {
  // The route is the only producer today, but a page that throws on an unexpected shape
  // shows the operator a blank Settings tab with no clue. Degrade instead.
  const tree = renderWith([{ peerId: 'p', report: null, connection: undefined }])
  const text = textOf(tree).join(' ')
  assert.match(text, /p/)
})

// ---------------------------------------------------------------------------
// host half: the data route
// ---------------------------------------------------------------------------

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {} },
    end(chunk) { this.body = chunk ?? '' },
  }
}

/** A request that emits `body` then ends, like a real JSON POST. */
function fakeReq(method, body) {
  const req = new EventEmitter()
  req.method = method
  req.destroy = () => {}
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

function makePeer(overrides = {}) {
  return {
    peerId: 'w1',
    name: 'w1',
    defaultCwd: 'C:\\work',
    connected: true,
    connection: { stats: { connected: true, connects: 1 } },
    selfcheckCalls: [],
    async selfcheck(opts) { this.selfcheckCalls.push(opts); return { verdict: 'ready', blockingFailures: 0, checks: [] } },
    async screenshot() { return { localPath: 'C:\\tmp\\shot.png', width: 1920, height: 1080 } },
    async ensure() {},
    bridge: { async cancel() {} },
    ...overrides,
  }
}

function makeRegistry(active = []) {
  return {
    list: () => active,
    active: () => active,
    activeCountForPeer: (peerId) => active.filter((t) => t.peerId === peerId).length,
  }
}

async function callRoute(route, method, body, deps) {
  const res = fakeRes()
  await route.handler(fakeReq(method, body), res)
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

function makeRoute({ peers, active } = {}) {
  const map = peers ?? new Map([['w1', makePeer()]])
  return {
    route: makeSettingsRoute({ peers: map, registry: makeRegistry(active ?? []), cache: { size: 3, misses: 1 } }),
    peers: map,
  }
}

test('GET reports every worker, its report and the link state', async () => {
  const { route } = makeRoute()
  const { status, body } = await callRoute(route, 'GET')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.workers.length, 1)
  assert.equal(body.workers[0].peerId, 'w1')
  assert.equal(body.workers[0].report.verdict, 'ready')
  // The link state is reported SEPARATELY: conflating it with the readiness report is what
  // once made a missing connect() look like a worker fault.
  assert.equal(body.workers[0].connection.connected, true)
  assert.deepEqual(body.toolCallCache, { size: 3, misses: 1 })
})

test('GET survives a worker that cannot be reached', async () => {
  const peers = new Map([['w1', makePeer({ async selfcheck() { throw new Error('ACP connection closed') } })]])
  const { route } = makeRoute({ peers })
  const { status, body } = await callRoute(route, 'GET')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.workers[0].report, null)
  assert.match(body.workers[0].error, /connection closed/)
})

test('selfcheck forces a fresh probe rather than reusing the cached report', async () => {
  const { route, peers } = makeRoute()
  const { status, body } = await callRoute(route, 'POST', JSON.stringify({ action: 'selfcheck', peerId: 'w1' }))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.report.verdict, 'ready')
  // maxAgeMs 0 is the whole point: "can it run right now" cannot be answered by a cache.
  assert.deepEqual(peers.get('w1').selfcheckCalls, [{ maxAgeMs: 0 }])
})

test('screenshot returns the saved path and geometry', async () => {
  const { route } = makeRoute()
  const { status, body } = await callRoute(route, 'POST', JSON.stringify({ action: 'screenshot', peerId: 'w1' }))
  assert.equal(status, 200)
  assert.equal(body.screenshot.width, 1920)
  assert.match(body.screenshot.localPath, /shot\.png$/)
})

test('interrupt cancels every in-flight task and reports per-task failures', async () => {
  const cancelled = []
  const peers = new Map([
    ['w1', makePeer({ bridge: { async cancel() { cancelled.push('w1') } } })],
    ['w2', makePeer({ peerId: 'w2', bridge: { async cancel() { throw new Error('link down') } } })],
  ])
  const active = [
    { taskId: 't1', peerId: 'w1', state: 'running' },
    { taskId: 't2', peerId: 'w2', state: 'running' },
    { taskId: 't3', peerId: 'gone', state: 'running' },
  ]
  const { route } = makeRoute({ peers, active })
  const { status, body } = await callRoute(route, 'POST', JSON.stringify({ action: 'interrupt' }))
  assert.equal(status, 200)
  assert.deepEqual(body.cancelled, ['t1'])
  assert.equal(body.failures.length, 2)
  assert.equal(body.considered, 3)
  assert.deepEqual(cancelled, ['w1'], 'a failed cancel must not stop the others')
})

test('interrupt with a peerId narrows the stop to that worker', async () => {
  const cancelled = []
  const peers = new Map([
    ['w1', makePeer({ bridge: { async cancel() { cancelled.push('w1') } } })],
    ['w2', makePeer({ peerId: 'w2', bridge: { async cancel() { cancelled.push('w2') } } })],
  ])
  const active = [
    { taskId: 't1', peerId: 'w1', state: 'running' },
    { taskId: 't2', peerId: 'w2', state: 'running' },
  ]
  const { route } = makeRoute({ peers, active })
  const { body } = await callRoute(route, 'POST', JSON.stringify({ action: 'interrupt', peerId: 'w2' }))
  assert.deepEqual(body.cancelled, ['t2'])
  assert.deepEqual(cancelled, ['w2'])
})

test('the route rejects an unknown action, a bad method and an unknown worker', async () => {
  const { route } = makeRoute()
  assert.equal((await callRoute(route, 'POST', JSON.stringify({ action: 'nope' }))).status, 400)
  assert.equal((await callRoute(route, 'POST', JSON.stringify({ action: 'selfcheck', peerId: 'ghost' }))).status, 404)
  assert.equal((await callRoute(route, 'DELETE')).status, 405)
  assert.equal((await callRoute(route, 'POST', 'not json')).status, 400)
})

test('a worker failure inside an action is reported, not thrown', async () => {
  const peers = new Map([['w1', makePeer({ async selfcheck() { throw new Error('worker exploded') } })]])
  const { route } = makeRoute({ peers })
  const { status, body } = await callRoute(route, 'POST', JSON.stringify({ action: 'selfcheck', peerId: 'w1' }))
  // A thrown handler would leave the page with a bare 500 and nothing to display.
  assert.equal(status, 502)
  assert.equal(body.ok, false)
  assert.match(body.error, /worker exploded/)
})

test('the response is never cached', async () => {
  const { route } = makeRoute()
  const res = fakeRes()
  await route.handler(fakeReq('GET'), res)
  // A cached availability answer is worse than no answer.
  assert.match(res.headers['cache-control'], /no-store/)
})
