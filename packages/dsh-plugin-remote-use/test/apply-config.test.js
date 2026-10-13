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
  const guards = []
  const commands = new Map()
  const listeners = new Map()
  /** agent -> the deny-filter currently in force for it; absent means lifted. */
  const restrictions = new Map()

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
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    subagents: {
      registerProvider(provider) {
        registered.set(provider.name, provider)
        return () => { registered.delete(provider.name) }
      },
    },
    tools: {
      register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) },
      guard: (fn) => {
        guards.push(fn)
        return () => { const i = guards.indexOf(fn); if (i >= 0) guards.splice(i, 1) }
      },
    },
    commands: {
      register: (definition) => {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
    systemPrompt: {
      section: (s) => { sections.push(s); return () => {} },
      // The real table, for the two names this plugin uses.
      getSectionOrder: (name) => ({ TEAM_POLICY: 600, TOOL_SUBAGENT: 2800 })[name] ?? 0,
      getContextOrder: () => 0,
    },
    inject(_services, cb) {
      cb({
        effect: ctx.effect,
        commands: ctx.commands,
        tools: ctx.tools,
        webServer: { register: (route) => { routes.push(route); return () => {} } },
      })
    },
  }

  /**
   * An agent as the platform presents it. `agent.ctx` is the scope every registration made
   * through it belongs to, which is what makes `tools.restrict()` per-agent — the real
   * implementation refuses a context-global call for exactly that reason.
   */
  function makeAgent(id) {
    const agent = { id: id ?? `agent-${restrictions.size + 1}` }
    agent.ctx = {
      tools: {
        restrict: (filter) => {
          restrictions.set(agent, filter)
          return () => restrictions.delete(agent)
        },
      },
    }
    return agent
  }

  /** Deliver an `agent/created` announcement, as the agent registry's `announce` does. */
  function createAgent(id) {
    const agent = makeAgent(id)
    for (const handler of listeners.get('agent/created') ?? []) handler({ agent, source: 'startup' })
    return agent
  }

  /** Run the global execution guard, if the plugin registered one. */
  function guardReason(exec) {
    for (const guard of guards) {
      const reason = guard(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }

  /** The policy text the given agent would receive right now. */
  function policyFor(agent) {
    const section = sections.find((s) => s.name === 'remote-use:policy')
    if (section === undefined) return undefined
    return typeof section.text === 'function' ? section.text({ agent }) : section.text
  }

  return {
    ctx, registered, tools, sections, routes, logs, disposals,
    guards, commands, restrictions, listeners, createAgent, makeAgent, guardReason, policyFor,
  }
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

// ---------------------------------------------------------------------------
// the route must address the worker the way `apply()` actually publishes it
//
// REPORTED SYMPTOM: pressing the page's "Test link" and "Screenshot" buttons answered
// `peer.ensure is not a function`. The route called connection methods on the worker
// RUNTIME, which carries `selfcheck()` and a `connection`, but not the connection's methods.
//
// A hand-written fake hid this: it had `ensure`/`screenshot`/`connected` directly on the
// peer, so it was MORE capable than the object it stood in for, and the suite passed while
// the button crashed. These tests use the runtime the REAL `apply()` produced, which cannot
// be more capable than itself.
// ---------------------------------------------------------------------------

/** The worker runtime as `apply()` published it, reached through the registered provider. */
function runtimeFor(registered, peerId) {
  return registered.get(`remote-${peerId}`)?.peer
}

test('the published runtime puts the connection methods on `connection`, not on itself', () => {
  const h = makeContext()
  mount(h.ctx, { workers: [worker('w1')] })
  const runtime = runtimeFor(h.registered, 'w1')

  assert.ok(runtime !== undefined, 'the provider must expose the runtime it was given')
  // Both names point at the same connection, which is what the route may rely on.
  assert.equal(runtime.bridge, runtime.connection)
  assert.equal(typeof runtime.connection.ensure, 'function')
  assert.equal(typeof runtime.connection.screenshot, 'function')
  assert.equal(typeof runtime.selfcheck, 'function')
  // The premise of the bug: these are NOT on the runtime.
  assert.equal(runtime.ensure, undefined)
  assert.equal(runtime.screenshot, undefined)
  assert.equal(runtime.connected, undefined)
})

test('ping and screenshot reach the connection instead of throwing a TypeError', async () => {
  const h = makeContext()
  mount(h.ctx, { workers: [worker('w1')] })
  const route = h.routes[0]

  for (const action of ['ping', 'screenshot']) {
    const { status, body } = await post(route, action, { peerId: 'w1' })
    const text = String(body.error ?? '')
    // The worker is unreachable, so a connection error is the expected outcome. What must
    // NOT happen is a TypeError from calling a method on the wrong object.
    assert.equal(/is not a function/u.test(text), false, `${action} addressed the wrong object: ${text}`)
    assert.equal(status === 200 || status === 502, true, `${action} returned ${status}: ${text}`)
    // `ping` goes through the WebSocket and says ETIMEDOUT/ECONNREFUSED; `screenshot` is an
    // HTTP fetch against the relay and says "fetch failed". Either is a connection story.
    assert.equal(body.ok === true || /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|timeout|fetch/iu.test(text), true,
      `${action} failed for an unexpected reason: ${text}`)
  }
})

// ---------------------------------------------------------------------------
// per-session enablement: installing the plugin must not route every session
// through a worker, so the tools are denied inside each session's own scope
// until `/remote-use on` lifts it for that session.
// ---------------------------------------------------------------------------

/** Register the plugin and return everything the enablement tests need. */
function mountWithGate(config = {}) {
  const harness = makeContext()
  mount(harness.ctx, { workers: [worker('w1')], ...config })
  return harness
}

/** Invoke the slash command the way the command service does. */
function runCommand(harness, agent, rawInput = '') {
  const definition = harness.commands.get('remote-use')
  assert.ok(definition !== undefined, 'the /remote-use command must be registered')
  return definition.handler({ commandId: 'c1', agent, rawInput, attachments: [], signal: undefined })
}

test('every new session starts with the remote tools denied', () => {
  const h = mountWithGate()
  // The tools exist globally (the model could see them where not restricted).
  assert.equal(h.tools.size, 4)
  const agent = h.createAgent('a1')
  // ...but this session's scope denies them, so its model never sees them.
  assert.ok(h.restrictions.has(agent))
  assert.deepEqual(h.restrictions.get(agent).deny, ['remote_agents', 'remote_interrupt', 'remote_selfcheck', 'remote_screenshot'])
  // The user's rule: nothing injected until a session opts in.
  assert.equal(h.policyFor(agent), '')
})

test('/remote-use on lifts the restriction and enables the policy for that session only', () => {
  const h = mountWithGate()
  const a1 = h.createAgent('a1')
  const a2 = h.createAgent('a2')

  const result = runCommand(h, a1, 'on')
  assert.equal(result.kind, 'success')
  assert.equal(h.restrictions.has(a1), false, 'the restriction must be lifted')
  assert.ok(h.policyFor(a1).includes('Remote LAN workers'), 'the policy must be injected')
  // The other session is untouched: the switch is per session, not global.
  assert.ok(h.restrictions.has(a2))
  assert.equal(h.policyFor(a2), '')
})

test('/remote-use off puts the restriction back', () => {
  const h = mountWithGate()
  const agent = h.createAgent('a1')
  runCommand(h, agent, 'on')
  assert.equal(h.restrictions.has(agent), false)

  const result = runCommand(h, agent, 'off')
  assert.equal(result.kind, 'success')
  assert.ok(h.restrictions.has(agent), 'the restriction must be re-applied')
  assert.equal(h.policyFor(agent), '')
})

test('/remote-use reports the state, and rejects anything else', () => {
  const h = mountWithGate()
  const agent = h.createAgent('a1')
  assert.match(runCommand(h, agent).text, /is off for this session/)
  assert.match(runCommand(h, agent, 'status').text, /is off/)
  runCommand(h, agent, 'on')
  assert.match(runCommand(h, agent).text, /is on for this session/)
  // Case and surrounding whitespace are the operator's, not a syntax error.
  runCommand(h, agent, '  OFF  ')
  assert.match(runCommand(h, agent).text, /is off/)

  const bad = runCommand(h, agent, 'yes')
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /unknown argument "yes"/)
})

test('the command refuses to guess a session when the invocation carries none', () => {
  const h = mountWithGate()
  const result = runCommand(h, undefined, 'on')
  // Guessing would either enable every session or none, and both are wrong.
  assert.equal(result.kind, 'error')
  assert.match(result.text, /no session/)
})

test('the execution guard is fail-closed: it refuses while off and allows while on', () => {
  const h = mountWithGate()
  const agent = h.createAgent('a1')

  assert.match(h.guardReason({ name: 'remote_agents', agent }), /off for this session/)
  runCommand(h, agent, 'on')
  assert.equal(h.guardReason({ name: 'remote_agents', agent }), undefined, 'an enabled session must be allowed')
  runCommand(h, agent, 'off')
  assert.match(h.guardReason({ name: 'remote_agents', agent }), /off for this session/)
})

test('the guard leaves unrelated tools and unknown sessions alone', () => {
  const h = mountWithGate()
  const agent = h.createAgent('a1')
  // Another plugin's tool must never be affected.
  assert.equal(h.guardReason({ name: 'pwsh', agent }), undefined)
  // An execution with no agent cannot be attributed, so it is refused -- fail-closed.
  assert.match(h.guardReason({ name: 'remote_selfcheck' }), /off for this session/)
})

test('the guard covers an agent that existed before the plugin was applied', () => {
  // The restriction is applied at agent creation, so an agent created before a hot reload
  // would keep the tools visible: the tool list can then be wrong. The guard is global
  // precisely so the CONSEQUENCE is still right.
  const h = mountWithGate()
  const preExisting = { id: 'pre-existing', ctx: { tools: { restrict: () => () => {} } } }
  // No agent/created announcement for it, so no restriction was recorded...
  assert.equal(h.restrictions.has(preExisting), false)
  // ...and yet it cannot execute the tool.
  assert.match(h.guardReason({ name: 'remote_agents', agent: preExisting }), /off for this session/)
})

test('a session that exists when the plugin loads is denied on its next creation', () => {
  const h = mountWithGate()
  const agent = h.createAgent('a1')
  runCommand(h, agent, 'on')
  assert.equal(h.restrictions.has(agent), false)
  // A second mount (as a reload does) must not leave it enabled.
  const reloaded = makeContext()
  mount(reloaded.ctx, { workers: [worker('w1')] })
  const same = reloaded.createAgent('a1')
  assert.ok(reloaded.restrictions.has(same), 'a reloaded plugin starts every session off')
})

test('a failed restriction does not abort startup, and the guard still protects', () => {
  const h = makeContext()
  // An agent whose scope cannot be restricted, e.g. a platform shape this build does not
  // expect. Degrading to "visible but refused" is far better than failing to load.
  h.listeners.set('agent/created', [])
  mount(h.ctx, { workers: [worker('w1')] })
  const broken = { id: 'broken', ctx: { tools: { restrict() { throw new Error('nope') } } } }
  for (const handler of h.listeners.get('agent/created')) handler({ agent: broken })
  assert.ok(h.logs.some(([, m]) => /could not restrict remote tools/.test(m)), 'the failure must be logged')
  assert.match(h.guardReason({ name: 'remote_agents', agent: broken }), /off for this session/)
})

test('setting delegationPolicy to empty keeps the tools gated but injects no policy', () => {
  const h = mountWithGate({ delegationPolicy: '' })
  const agent = h.createAgent('a1')
  runCommand(h, agent, 'on')
  // No section registered at all, so nothing can render.
  assert.equal(h.sections.some((s) => s.name === 'remote-use:policy'), false)
  // The switch still governs execution.
  assert.equal(h.guardReason({ name: 'remote_agents', agent }), undefined)
})
