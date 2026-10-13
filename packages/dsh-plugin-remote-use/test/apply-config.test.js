/**
 * Integration tests for `apply()` itself: the real assembly, mounted against a fake Cordis
 * context.
 *
 * WHY THIS FILE EXISTS: every other test either mocks our own modules or assembles the
 * pieces by hand. Twice this session a shipped bug survived that gap -- a plugin that never
 * called `bridge.connect()`, and tools registered with an unconvertible schema -- because
 * nothing exercised the real `apply()`. Live re-pairing adds a third such seam: the settings
 * page can now tear a worker down at runtime, and nothing else would notice if that tore
 * down the wrong one.
 *
 * The fake context reproduces the two Cordis behaviours this plugin depends on:
 *   * `effect(fn)` runs `fn` immediately and returns a DISPOSER (`Fiber.effect` builds a
 *     wrapper function and returns it). Getting this wrong would make every teardown
 *     assertion below vacuous.
 *   * `inject([...], cb)` runs the callback with the requested services available.
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { settingsPath } from '../lib/core/settings-store.js'

// ---------------------------------------------------------------------------
// fake Cordis context
// ---------------------------------------------------------------------------

function makeContext() {
  const registered = new Map()
  const tools = new Map()
  const sections = []
  const routes = []
  const logs = []
  const disposals = []

  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    // Faithful to Cordis: runs the body at once, returns a disposer.
    effect(fn) {
      const cleanup = fn()
      let done = false
      const dispose = () => {
        if (done) return
        done = true
        disposals.push(typeof cleanup === 'function' ? cleanup() : undefined)
      }
      return dispose
    },
    on() { return () => {} },
    subagents: {
      registerProvider(provider) {
        registered.set(provider.name, provider)
        return () => { registered.delete(provider.name) }
      },
    },
    tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } },
    systemPrompt: {
      section: (s) => { sections.push(s); return () => {} },
      getSectionOrder: () => 100,
    },
    inject(_services, cb) {
      cb({
        effect: ctx.effect,
        webServer: { register: (route) => { routes.push(route); return () => {} } },
      })
    },
  }

  return { ctx, registered, tools, sections, routes, logs, disposals }
}

/**
 * A single temp DSH home for the WHOLE file, installed at module load and never restored.
 *
 * WHY NOT per-test save/restore: an earlier version did exactly that, and one test called
 * the helper WITHOUT awaiting it -- so the `finally` put the real `C:\Users\you\.dsh` back
 * while an async save was still in flight, and the suite wrote a fixture worker
 * (`ws://10.0.0.1:7331`) into the operator's real settings file. On the next restart that
 * file takes precedence over the profile patch, so the suite would have silently replaced
 * the real worker list.
 *
 * Never restoring means no async timing can reach the real home. This is a test harness
 * writing to a user directory; it has to be structurally impossible, not merely correct.
 */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'remote-use-apply-'))
process.env.DSH_HOME = TEST_HOME
process.on('exit', () => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* best effort */ }
})

/** Start a test from a clean settings file, within the temp home. */
async function withEnv(fn) {
  rmSync(join(TEST_HOME, 'storages', 'dsh-plugin-remote-use', 'settings.json'), { force: true })
  return await fn(TEST_HOME)
}

/** Mount the plugin with probe budgets small enough that an unreachable worker is cheap. */
function mount(ctx, config = {}) {
  apply(ctx, { reportBudgetMs: 30, selfcheckBudgetMs: 30, ...config })
}

test('the suite is isolated from the real DSH home', () => {
  // A guard on the guard: if this ever fails, every other test in the file is suspect.
  assert.equal(process.env.DSH_HOME, TEST_HOME)
  assert.ok(TEST_HOME.startsWith(tmpdir()), 'the harness must only ever write under the temp dir')
  assert.equal(settingsPath().startsWith(TEST_HOME), true)
})

function worker(id, overrides = {}) {
  return {
    id,
    name: id,
    url: `ws://10.0.0.${id === 'w1' ? 1 : 2}:7331`,
    token: `token-${id}`,
    cwd: 'C:\\work',
    enabled: true,
    serialQueue: 1,
    ...overrides,
  }
}

/** POST one action at the settings route and return the parsed reply. */
async function post(route, action, payload) {
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
    req.emit('data', Buffer.from(JSON.stringify({ action, ...(payload ?? {}) })))
    req.emit('end')
  })
  await route.handler(req, res)
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

async function get(route) {
  const req = new EventEmitter()
  req.method = 'GET'
  req.destroy = () => {}
  const res = {
    statusCode: 0, headers: {}, body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {} },
    end(chunk) { this.body = chunk ?? '' },
  }
  req.emit('end')
  await route.handler(req, res)
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

// ---------------------------------------------------------------------------
// initial wiring
// ---------------------------------------------------------------------------

test('apply() wires one provider per enabled worker and mounts the settings route', async () => {
  await withEnv(async () => {
    const { ctx, registered, routes, tools } = makeContext()
    mount(ctx, { workers: [worker('w1'), worker('w2'), worker('w3', { enabled: false })] })

    assert.equal(registered.size, 2, 'enabled workers only')
    assert.ok([...registered.keys()].some((n) => n.includes('w1')))
    assert.ok([...registered.keys()].some((n) => n.includes('w2')))
    assert.equal(routes.length, 1, 'the settings route must be mounted')
    // The tools are registered even for a config that happens to have none, because the page
    // can add the first worker at runtime.
    assert.deepEqual([...tools.keys()].sort(), ['remote_agents', 'remote_interrupt', 'remote_screenshot', 'remote_selfcheck'])
  })
})

test('the tools are registered even when no worker is configured', async () => {
  await withEnv(async () => {
    const { ctx, tools, registered } = makeContext()
    mount(ctx, { workers: [] })
    assert.equal(registered.size, 0)
    // Starting with none and adding one from the page must still leave the session with tools.
    assert.equal(tools.size, 4)
  })
})

test('a settings file overrides the profile config on load', async () => {
  await withEnv(async () => {
    const first = makeContext()
    mount(first.ctx, { workers: [worker('w1')] })
    // Save a worker so a settings file exists that the profile does not know about.
    const saved = await post(first.routes[0], 'worker.save', { worker: worker('added-from-page') })
    assert.equal(saved.body.ok, true)

    // Remount against a profile naming a DIFFERENT worker entirely. The settings file wins,
    // so the profile's worker must not appear -- that is what precedence means here.
    const second = makeContext()
    mount(second.ctx, { workers: [worker('only-in-profile')] })
    const names = [...second.registered.keys()].join(' ')
    assert.ok(names.includes('w1'), 'the saved list must be used')
    assert.ok(names.includes('added-from-page'), 'the saved worker must be wired')
    assert.equal(names.includes('only-in-profile'), false, 'the profile list must be ignored once saved')
  })
})

// ---------------------------------------------------------------------------
// live re-pairing
// ---------------------------------------------------------------------------

test('worker.remove takes down exactly one provider', async () => {
  await withEnv(async () => {
    const { ctx, registered, routes } = makeContext()
    mount(ctx, { workers: [worker('w1'), worker('w2')] })
    assert.equal(registered.size, 2)
    const survivorBefore = registered.get([...registered.keys()].find((n) => n.includes('w2')))

    const { status, body } = await post(routes[0], 'worker.remove', { peerId: 'w1' })
    assert.equal(status, 200)
    assert.deepEqual(body.applied.removed, ['w1'])

    assert.equal(registered.size, 1, 'only w1 may be unregistered')
    const survivor = registered.get([...registered.keys()][0])
    assert.ok([...registered.keys()][0].includes('w2'))
    // The same provider INSTANCE must survive: a re-registration would mean w2 was rebuilt,
    // which would also have discarded its remembered approvals.
    assert.equal(survivor, survivorBefore, 'the untouched worker must not be rebuilt')
  })
})

test('worker.save adds a worker and wires it without a restart', async () => {
  await withEnv(async () => {
    const { ctx, registered, routes } = makeContext()
    mount(ctx, { workers: [worker('w1')] })
    assert.equal(registered.size, 1)

    const { status, body } = await post(routes[0], 'worker.save', { worker: worker('w2') })
    assert.equal(status, 200)
    assert.deepEqual(body.applied.added, ['w2'])
    assert.equal(registered.size, 2, 'the new worker must be live immediately')
  })
})

test('changing a worker url rebuilds only that worker', async () => {
  await withEnv(async () => {
    const { ctx, registered, routes } = makeContext()
    mount(ctx, { workers: [worker('w1'), worker('w2')] })
    const before = new Map(registered)
    const w2Before = [...before.entries()].find(([n]) => n.includes('w2'))[1]

    const { status, body } = await post(routes[0], 'worker.save', { worker: worker('w1', { url: 'ws://10.9.9.9:7331' }) })
    assert.equal(status, 200)
    assert.deepEqual(body.applied.changed, ['w1'], 'only the edited worker is rebuilt')
    assert.equal(registered.size, 2)
    const w2After = [...registered.entries()].find(([n]) => n.includes('w2'))[1]
    assert.equal(w2After, w2Before, 'an unrelated worker must not be disturbed')
  })
})

test('a worker sent with enabled:false is taken down but kept in the settings', async () => {
  await withEnv(async () => {
    const { ctx, registered, routes } = makeContext()
    mount(ctx, { workers: [worker('w1'), worker('w2')] })

    const { body } = await post(routes[0], 'worker.save', { worker: worker('w2', { enabled: false }) })
    assert.equal(registered.size, 1, 'a disabled worker must not stay registered')
    assert.deepEqual(body.applied.removed, ['w2'])

    // It is disabled, not deleted: the page must still be able to re-enable it.
    const view = await get(routes[0])
    assert.deepEqual(view.body.settings.workers.map((w) => w.id).sort(), ['w1', 'w2'])
    assert.equal(view.body.settings.workers.find((w) => w.id === 'w2').enabled, false)
  })
})

// ---------------------------------------------------------------------------
// approval policy
// ---------------------------------------------------------------------------

test('changing the approval policy rebuilds every worker', async () => {
  await withEnv(async () => {
    const { ctx, registered, routes, logs } = makeContext()
    mount(ctx, { workers: [worker('w1'), worker('w2')] })
    const before = new Map(registered)

    const { status, body } = await post(routes[0], 'settings.save', { settings: { requiredTier: 'danger-full-access' } })
    assert.equal(status, 200)
    assert.equal(body.applied.rebuilt, true)
    assert.equal(registered.size, 2)
    // A running provider captured the old tier, so it must be replaced rather than mutated.
    for (const [name, provider] of registered) assert.notEqual(provider, before.get(name))
    assert.ok(logs.some(([, m]) => /policy changed/.test(m)))
  })
})

test('saving an unchanged policy does not rebuild anything', async () => {
  await withEnv(async () => {
    const { ctx, registered, routes } = makeContext()
    mount(ctx, { workers: [worker('w1')] })
    const before = [...registered.values()][0]

    const { body } = await post(routes[0], 'settings.save', { settings: { requiredTier: 'workspace-write' } })
    assert.equal(body.applied.rebuilt, false)
    assert.equal([...registered.values()][0], before, 'an unchanged policy must not churn the connection')
  })
})

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

test('no route reply ever contains a worker token', async () => {
  await withEnv(async () => {
    const { ctx, routes } = makeContext()
    mount(ctx, { workers: [worker('w1')] })
    const route = routes[0]

    const replies = [
      await get(route),
      await post(route, 'worker.save', { worker: worker('w1', { name: 'renamed' }) }),
      await post(route, 'settings.save', { settings: { requiredTier: 'read-only' } }),
    ]
    for (const { body } of replies) {
      const text = JSON.stringify(body)
      assert.equal(text.includes('token-w1'), false, 'a bearer credential must never leave the host')
      assert.equal(/"(token)"/.test(text), false, 'not even the raw field name')
    }
    // ...while still telling the page that a token IS set, and which one.
    const view = await get(route)
    assert.equal(view.body.settings.workers[0].tokenSet, true)
    assert.equal(view.body.settings.workers[0].tokenHint.endsWith('w1'), true)
  })
})

test('renaming a worker keeps its stored token', async () => {
  await withEnv(async () => {
    const { ctx, routes } = makeContext()
    mount(ctx, { workers: [worker('w1')] })
    const { body } = await post(routes[0], 'worker.save', { worker: { id: 'w1', url: worker('w1').url, name: 'Renamed' } })
    assert.equal(body.ok, true)
    assert.equal(body.settings.workers[0].name, 'Renamed')
    // The token survived even though the page had no way to send it.
    assert.equal(body.settings.workers[0].tokenSet, true)
  })
})

test('a new worker without a token is refused rather than silently broken', async () => {
  await withEnv(async () => {
    const { ctx, routes } = makeContext()
    mount(ctx, { workers: [worker('w1')] })
    const { status, body } = await post(routes[0], 'worker.save', { worker: { id: 'new', url: 'ws://10.0.0.9:7331' } })
    assert.equal(status, 400)
    assert.match(body.error, /needs a token/)
  })
})

test('removing an unknown worker is a 404, not a silent success', async () => {
  await withEnv(async () => {
    const { ctx, routes } = makeContext()
    mount(ctx, { workers: [worker('w1')] })
    const { status } = await post(routes[0], 'worker.remove', { peerId: 'ghost' })
    assert.equal(status, 404)
  })
})
