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

import { apply, REMOTE_TOOL_NAMES } from '../lib/index.js'
import { acpLaunchSpec } from '../lib/core/self-acp-spec.js'
import { encodePairing } from '../slave/pairing.mjs'
import { settingsPath } from '../lib/core/settings-store.js'
import { MANAGED_KEYS } from '../lib/core/settings-store.js'

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
    //
    // Compared against `REMOTE_TOOL_NAMES` rather than a literal list. The invariant that matters is
    // "the registered set equals the set the session gate knows about": a tool registered but missing
    // from `REMOTE_TOOL_NAMES` would stay visible AND usable in a session that never ran
    // `/remote-use on`. A literal can only restate today's names, and (PITFALLS D11) a literal naming
    // the thing under test goes stale the moment the thing changes.
    assert.deepEqual([...tools.keys()].sort(), [...REMOTE_TOOL_NAMES].sort())
  })
})

test('the tools are registered even when no worker is configured', async () => {
  await withEnv(async () => {
    const { ctx, tools, registered } = makeContext()
    mount(ctx, { workers: [] })
    assert.equal(registered.size, 0)
    // Starting with none and adding one from the page must still leave the session with tools.
    assert.equal(tools.size, REMOTE_TOOL_NAMES.length)
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
    const { body } = await post(routes[0], 'worker.save', {
      // `worker.save` REPLACES the row, so a page that omits the task directory would wipe it --
      // which the route now refuses (see the cwd tests below). The real form always sends it.
      worker: { id: 'w1', url: worker('w1').url, name: 'Renamed', cwd: worker('w1').cwd },
    })
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

// ---------------------------------------------------------------------------
// keeping shots, and the delegation policy the page can now edit
// ---------------------------------------------------------------------------

test('the page can read and write keepShots', async () => {
  await withEnv(async () => {
    const h = mountWithGate()
    const before = await get(h.routes[0])
    assert.equal(typeof before.body.settings.keepShots, 'number')

    const saved = await post(h.routes[0], 'settings.save', { settings: { keepShots: 3 } })
    assert.equal(saved.body.ok, true)
    assert.equal(saved.body.settings.keepShots, 3)

    // It must survive the round trip through the settings file, which is the only reason to
    // have a page control at all. A key the page can save but the store drops would look like
    // it worked once and then reverted.
    const after = await get(h.routes[0])
    assert.equal(after.body.settings.keepShots, 3)
  })
})

test('keepShots may be NEGATIVE, which is how an operator disables pruning', async () => {
  await withEnv(async () => {
    const h = mountWithGate()
    const saved = await post(h.routes[0], 'settings.save', { settings: { keepShots: -1 } })
    assert.equal(saved.body.settings.keepShots, -1)
  })
})

test('the page can read and write shotCacheBytes, and it survives the round trip', async () => {
  // The byte ceiling sits beside `keepShots` as the other half of the disk bound, and it was added
  // to FOUR places at once -- the schema, the save route, `MANAGED_KEYS` and `currentSettings()`. That
  // is the shape that has silently reverted twice in this plugin's history (see the audit-retention
  // note below): saving works, the value is written to disk, and the next read shows the default. The
  // generic guard at the bottom of this file checks the whole exposed set; this pins the key itself so
  // a failure names it, and the explicit `MANAGED_KEYS` assertion keeps that dependency visible.
  assert.ok(MANAGED_KEYS.includes('shotCacheBytes'), 'an unmanaged key saves once and then reverts')
  await withEnv(async () => {
    const h = mountWithGate()
    const before = await get(h.routes[0])
    assert.equal(typeof before.body.settings.shotCacheBytes, 'number', 'the page must be able to render it at all')

    const saved = await post(h.routes[0], 'settings.save', { settings: { shotCacheBytes: 512 * 1024 * 1024 } })
    assert.equal(saved.body.ok, true)
    assert.equal(saved.body.settings.shotCacheBytes, 512 * 1024 * 1024)

    const after = await get(h.routes[0])
    assert.equal(after.body.settings.shotCacheBytes, 512 * 1024 * 1024, 'it must persist, not read back as the default')
  })
})

test('shotCacheBytes of 0 means "no byte ceiling", and clearing it back to 0 must stick', async () => {
  await withEnv(async () => {
    const h = mountWithGate()
    // Save a real ceiling FIRST. Setting 0 on a clean store would prove nothing: the shipped default
    // is already 0, so a falsy check (`if (incoming.shotCacheBytes)`) would pass that version of the
    // test and still be wrong. The regression being guarded is the transition BACK to 0, where a
    // falsy guard keeps the old ceiling -- so the operator's "no limit" silently keeps pruning.
    await post(h.routes[0], 'settings.save', { settings: { shotCacheBytes: 4096 } })
    assert.equal((await get(h.routes[0])).body.settings.shotCacheBytes, 4096)

    const saved = await post(h.routes[0], 'settings.save', { settings: { shotCacheBytes: 0 } })
    assert.equal(saved.body.settings.shotCacheBytes, 0)
    // Through the file, which is the only reason a page control exists.
    assert.equal((await get(h.routes[0])).body.settings.shotCacheBytes, 0, '0 is a value, not "absent"')
  })
})

test('a NEGATIVE shotCacheBytes survives, because it is the documented "no ceiling" spelling', async () => {
  // `keepShots` reads negative as "disable pruning"; the byte budget reads 0 AND negative as "no
  // byte budget" (see `pruneShots`). The value must round-trip as itself rather than being clamped:
  // a store that rewrote -1 to 0 would look identical on the page while silently replacing what the
  // operator typed, and the same clamp in the other direction would create a floor that deletes.
  await withEnv(async () => {
    const h = mountWithGate()
    const saved = await post(h.routes[0], 'settings.save', { settings: { shotCacheBytes: -1 } })
    assert.equal(saved.body.settings.shotCacheBytes, -1)
    assert.equal((await get(h.routes[0])).body.settings.shotCacheBytes, -1)
  })
})

test('a non-numeric shotCacheBytes is ignored, and does not corrupt the settings saved beside it', async () => {
  // The route takes a raw NUMBER of bytes; the page parses `512MB` before it sends. A string that
  // slips in must not reach the file as `NaN` and must not take the rest of the payload with it --
  // the form saves several keys in one request, so dropping all of them would read as the page
  // losing edits. The stored ceiling is left exactly as it was.
  await withEnv(async () => {
    const h = mountWithGate()
    await post(h.routes[0], 'settings.save', { settings: { shotCacheBytes: 4096 } })

    const saved = await post(h.routes[0], 'settings.save', { settings: { shotCacheBytes: '512MB', keepShots: 7 } })
    assert.equal(saved.body.ok, true)
    assert.equal(saved.body.settings.keepShots, 7, 'the usable key beside it must still be applied')
    assert.equal(saved.body.settings.shotCacheBytes, 4096, 'the unusable value must leave the stored one alone')
    assert.equal((await get(h.routes[0])).body.settings.shotCacheBytes, 4096)
  })
})

// ---------------------------------------------------------------------------
// the session mode this machine arms its own remote sessions with
// ---------------------------------------------------------------------------

test('EVERY setting the page exposes is one the store manages', async () => {
  // THE GENERIC GUARD FOR THE SILENT-REVERT CLASS. A page-editable setting has to be registered in
  // four places -- the schema, the save route, `MANAGED_KEYS`, and `currentSettings()` -- and each
  // omission fails the same quiet way: it saves, then reads back as undefined, and the page shows
  // the default again. Both the code comments warning about this were written after being bitten.
  //
  // Per-key round-trip tests only cover the keys someone remembered to write one for; this covers
  // the set. It would have caught `auditMaxBytes`/`auditKeepFiles` (shipped broken) and the omission
  // that prompted it, because `publicSettings` lists every exposed key even when its value is
  // undefined -- which is exactly how the omission presents.
  await withEnv(async () => {
    const h = mountWithGate()
    // Computed on every read and never stored, so they are not settings and cannot "revert". Naming
    // them is deliberate: a new derived field has to be added here, which is the moment to ask
    // whether it really is derived or is a setting someone forgot to register.
    const DERIVED = new Set(['sessionsEnabled', 'enableCommand'])
    const exposed = Object.keys((await get(h.routes[0])).body.settings)
      .filter((key) => !DERIVED.has(key))
    const unmanaged = exposed.filter((key) => !MANAGED_KEYS.includes(key))
    assert.deepEqual(unmanaged, [],
      `these are exposed on the page but not managed by the store, so they would silently revert: ${unmanaged.join(', ')}`)
    // And the reverse direction, so a managed key the projection forgot cannot hide: `publicSettings`
    // must actually surface everything the store will persist.
    const hidden = MANAGED_KEYS.filter((key) => !exposed.includes(key))
    assert.deepEqual(hidden, [],
      `these are persisted but never exposed, so the page cannot show what it is doing: ${hidden.join(', ')}`)
  })
})

test('the audit retention settings round-trip, because they did NOT before', async () => {
  // Kept as an explicit regression: these were the two keys that shipped in 0.2.12 exposed, savable,
  // and completely revertable.
  await withEnv(async () => {
    const h = mountWithGate()
    const saved = await post(h.routes[0], 'settings.save', { settings: { auditMaxBytes: 4096, auditKeepFiles: 2 } })
    assert.equal(saved.body.ok, true)
    assert.equal(saved.body.settings.auditMaxBytes, 4096)
    assert.equal(saved.body.settings.auditKeepFiles, 2)
    const after = await get(h.routes[0])
    assert.equal(after.body.settings.auditMaxBytes, 4096, 'it must survive the read-back, not revert')
    assert.equal(after.body.settings.auditKeepFiles, 2)
  })
})

test('the session mode DEFAULTS to full access', async () => {
  // The default is the security-relevant part, so it is pinned rather than left to the schema
  // declaration. It is deliberate: a GUI process failing under a restricted token fails SILENTLY
  // (success return, no denial, only a desktop dialog), so it cannot be surfaced as an approval and
  // must not be left to a per-call judgement. See PITFALLS F21/F33 and the schema's own note.
  await withEnv(async () => {
    const h = mountWithGate()
    const initial = await get(h.routes[0])
    assert.equal(initial.body.settings.workerSessionMode, 'danger-full-access')
  })
})

test('the session mode round-trips, and a confined worker is still expressible', async () => {
  await withEnv(async () => {
    const h = mountWithGate()
    const saved = await post(h.routes[0], 'settings.save', { settings: { workerSessionMode: 'workspace-write' } })
    assert.equal(saved.body.ok, true)
    assert.equal(saved.body.settings.workerSessionMode, 'workspace-write')
    // Through the settings file, or the page would look like it worked and then revert.
    assert.equal((await get(h.routes[0])).body.settings.workerSessionMode, 'workspace-write')
  })
})

test('an UNKNOWN session mode is STORED, not silently coerced to the default', async () => {
  // Coercing would be the dangerous direction: the default is the unrestricted mode, so a typo would
  // quietly grant the widest access. It is refused where it is used instead -- when the launch spec
  // is built -- so arming fails loudly and nothing is deployed.
  await withEnv(async () => {
    const h = mountWithGate()
    const saved = await post(h.routes[0], 'settings.save', { settings: { workerSessionMode: 'yolo' } })
    assert.equal(saved.body.settings.workerSessionMode, 'yolo')
    assert.throws(() => acpLaunchSpec({ installDir: 'C:\\x', permissionMode: 'yolo' }),
      /not a sandbox mode DSH understands/u)
  })
})

test('the delegation policy round-trips, and an EMPTY one survives', async () => {
  await withEnv(async () => {
    const h = mountWithGate()
    // A default is present without any configuration.
    const before = await get(h.routes[0])
    assert.ok(String(before.body.settings.delegationPolicy).length > 0)

    // An empty string means "inject nothing" -- a real choice, and the one a `??` or `||`
    // check would silently replace with the default.
    const cleared = await post(h.routes[0], 'settings.save', { settings: { delegationPolicy: '' } })
    assert.equal(cleared.body.ok, true)
    assert.equal(cleared.body.settings.delegationPolicy, '')
    const after = await get(h.routes[0])
    assert.equal(after.body.settings.delegationPolicy, '', 'the cleared policy must persist')

    // And a custom one comes back verbatim.
    const custom = await post(h.routes[0], 'settings.save', { settings: { delegationPolicy: 'CUSTOM POLICY TEXT' } })
    assert.equal(custom.body.settings.delegationPolicy, 'CUSTOM POLICY TEXT')
  })
})

test('the page is told how many sessions have remote work on, and by which command', async () => {
  await withEnv(async () => {
    const h = mountWithGate()
    const before = await get(h.routes[0])
    assert.equal(before.body.settings.sessionsEnabled, 0, 'the default is OFF, per session')
    assert.match(String(before.body.settings.enableCommand), /^\/remote-use on$/)

    // The count lives in apply()'s scope while the route is a separate function, so it has to
    // be injected as a getter -- reading it directly threw a ReferenceError that the route
    // turned into a 502 on every page load.
    runCommand(h, h.createAgent('a1'), 'on')

    const after = await get(h.routes[0])
    assert.equal(after.body.settings.sessionsEnabled, 1)
  })
})

// ---------------------------------------------------------------------------
// pairing from a pasted string
//
// The string carries a bearer token, so the refusals matter more than the happy path: a bad
// paste must be rejected outright rather than producing a worker that looks right and cannot
// connect.
// ---------------------------------------------------------------------------

test('worker.pair fills url, token and name from one paste', async () => {
  await withEnv(async () => {
    const h = mountWithGate()
    const pairing = encodePairing({
      url: 'ws://192.168.1.101:7331', token: 'tok-secret-value', name: 'worker-pc', cwd: 'C:\\dsh-remote\\p0work',
    })
    const { status, body } = await post(h.routes[0], 'worker.pair', { pairing })
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.ok, true)

    const added = body.settings.workers.find((w) => w.url === 'ws://192.168.1.101:7331')
    assert.ok(added !== undefined, 'the worker must be configured')
    assert.equal(added.tokenSet, true)
    // The TASK DIRECTORY comes from the paste too. That is the whole point of putting it in the
    // string: only the worker can know a path on the worker, so the operator must not have to
    // retype it. Without this assertion, a paste that silently dropped `cwd` would still pass --
    // and would produce a worker that cannot accept a task (F16).
    assert.equal(added.cwd, 'C:\\dsh-remote\\p0work')
    // The token itself must never travel back to the browser.
    assert.equal('token' in added, false)
    assert.equal(JSON.stringify(body).includes('tok-secret-value'), false)
  })
})

test('a corrupt pairing string is refused, and nothing is configured', async () => {
  await withEnv(async () => {
    const h = mountWithGate()
    const good = encodePairing({ url: 'ws://h:1', token: 't' })
    for (const bad of [good.slice(0, good.length - 5), 'nonsense', '', `${good}x`]) {
      const { status, body } = await post(h.routes[0], 'worker.pair', { pairing: bad })
      assert.equal(status, 400, `${JSON.stringify(bad).slice(0, 30)} must be refused`)
      assert.equal(body.ok, false)
      // The refusal must not leak the token it was given.
      assert.equal(String(body.error).includes('tok'), false)
    }
    const after = await get(h.routes[0])
    // `mountWithGate` already configures w1, so the assertion is that nothing was ADDED: a
    // refused paste must not leave a half-configured worker behind.
    assert.deepEqual(after.body.settings.workers.map((w) => w.id), ['w1'], 'a refused paste must change nothing')
  })
})

test('the pairing action never carries the token into the log', async () => {
  await withEnv(async () => {
    const h = mountWithGate()
    const pairing = encodePairing({
      url: 'ws://192.168.1.101:7331', token: 'tok-secret-value', name: 'w', cwd: 'C:\\work',
    })
    await post(h.routes[0], 'worker.pair', { pairing })
    const logged = h.logs.map(([, message]) => String(message)).join('\n')
    assert.equal(logged.includes('tok-secret-value'), false, 'the token must not be logged')
    assert.match(logged, /192\.168\.1\.101:7331/, 'the host may be logged, for the audit line')
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
// F16: a worker with no usable TASK DIRECTORY must be refused where it is configured
//
// The directory is a path on the worker, so the master cannot invent one. Pairing used to accept
// a string that carried none, save the worker, and let the mistake surface as
// `[REMOTE_BAD_CWD]` on the first delegation -- on a different screen, days later. These pin the
// three places that now stop it: the paste, the form, and the page's own view of a worker.
// ---------------------------------------------------------------------------

test('a pairing string with no task directory is refused, and says how to supply one', async () => {
  await withEnv(async () => {
    const h = mountWithGate()
    const pairing = encodePairing({ url: 'ws://192.168.1.5:7331', token: 'tok-x', name: 'pc' })
    const { status, body } = await post(h.routes[0], 'worker.pair', { pairing })
    assert.equal(status, 400)
    assert.equal(body.ok, false)
    assert.match(body.error, /task directory/)
    assert.match(body.error, /absolute path/)
    // Refused means NOTHING was written -- not a half-configured worker to clean up by hand.
    const after = await get(h.routes[0])
    assert.deepEqual(after.body.settings.workers.map((w) => w.id), ['w1'])
    assert.equal(String(body.error).includes('tok-x'), false, 'the refusal must not echo the token')
  })
})

test('a pairing string with no task directory is accepted when the operator supplies one', async () => {
  await withEnv(async () => {
    const h = mountWithGate()
    const pairing = encodePairing({ url: 'ws://192.168.1.6:7331', token: 'tok-y', name: 'pc' })
    const { status, body } = await post(h.routes[0], 'worker.pair', { pairing, cwd: 'C:\\typed\\dir' })
    assert.equal(status, 200, JSON.stringify(body))
    const added = body.settings.workers.find((w) => w.url === 'ws://192.168.1.6:7331')
    assert.equal(added.cwd, 'C:\\typed\\dir')
  })
})

test('a relative task directory from a pairing string is refused', async () => {
  await withEnv(async () => {
    const h = mountWithGate()
    const pairing = encodePairing({ url: 'ws://192.168.1.7:7331', token: 'tok-z', cwd: 'relative\\dir' })
    const { status, body } = await post(h.routes[0], 'worker.pair', { pairing })
    assert.equal(status, 400)
    assert.match(body.error, /absolute/)
  })
})

test('saving a worker with no task directory is refused rather than silently taking it offline', async () => {
  await withEnv(async () => {
    const { ctx, routes } = makeContext()
    mount(ctx, { workers: [worker('w1')] })
    // This is the shape a partial API caller sends: no `cwd` at all. `upsertWorker` REPLACES the
    // row, so accepting it would blank a working directory without anyone asking.
    const { status, body } = await post(routes[0], 'worker.save', { worker: { id: 'w1', url: worker('w1').url, name: 'x' } })
    assert.equal(status, 400)
    assert.match(body.error, /cwd is empty/)
    const after = await get(routes[0])
    assert.equal(after.body.settings.workers[0].cwd, 'C:\\work', 'the stored directory must survive')
  })
})

test('GET reports a worker whose configuration cannot dispatch, next to its health', async () => {
  await withEnv(async () => {
    const { ctx, routes } = makeContext()
    // Shaped like a worker paired before the fix: connected, healthy-looking, and unable to accept
    // a single task. The page has to be able to say so without waiting for a delegation to fail.
    mount(ctx, { workers: [worker('w1', { cwd: '' })] })
    const { body } = await get(routes[0])
    assert.match(String(body.workers[0].configProblem), /cwd is empty/)
  })
})

// ---------------------------------------------------------------------------
// the worker role: refusing to arm is the property that matters
//
// The success path is covered in test/worker-arming.test.js with an injected probe. What is
// asserted here is the REFUSAL, through the real route and the real probe: this harness's
// DSH_HOME is a temp directory with no acp profile, so the sandbox gate cannot pass, and arming
// must be refused rather than granted.
// ---------------------------------------------------------------------------

test('the page can read the worker role, and it never carries the token', async () => {
  await withEnv(async () => {
    const h = mountWithGate()
    const { status, body } = await get(h.routes[0])
    assert.equal(status, 200)
    const role = body.settings.workerRole
    assert.ok(role !== null && typeof role === 'object', 'the page must be able to report the state on load')
    assert.equal(role.armed, false, 'the default is off')
    assert.equal(role.tokenSet, false)
    assert.equal('token' in role, false, 'the raw credential must never be part of the settings payload')
    // The interface list is what the page offers as a choice, and it includes everything so the
    // page can explain why a virtual adapter is not recommended.
    assert.equal(Array.isArray(role.interfaces), true)
  })
})

test('ARMING IS REFUSED when the sandbox does not contain this machine', async () => {
  await withEnv(async () => {
    const h = mountWithGate()
    // Any address will do: the sandbox blocker is the one under test, and it is checked before
    // anything starts. This harness has no acp profile, so the probe cannot pass.
    const { status, body } = await post(h.routes[0], 'worker.arm', { bindAddress: '127.0.0.1' })
    assert.equal(status, 409, `expected a refusal, got ${status} ${JSON.stringify(body)}`)
    assert.equal(body.ok, false)
    assert.match(String(body.error), /sandbox/u, 'the refusal must name the sandbox, not blame the address')
    assert.equal(Array.isArray(body.blockers), true)

    // And nothing was armed.
    const after = await get(h.routes[0])
    assert.equal(after.body.settings.workerRole.armed, false)
  })
})

test('disarming is safe when nothing was armed', async () => {
  await withEnv(async () => {
    const h = mountWithGate()
    const { status, body } = await post(h.routes[0], 'worker.disarm', {})
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.workerRole.armed, false)
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
  assert.equal(h.tools.size, REMOTE_TOOL_NAMES.length)
  const agent = h.createAgent('a1')
  // ...but this session's scope denies them, so its model never sees them.
  assert.ok(h.restrictions.has(agent))
  assert.deepEqual(h.restrictions.get(agent).deny, [...REMOTE_TOOL_NAMES])
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

test('setting delegationPolicy to empty keeps the tools gated but injects no policy', async () => {
  // Wrapped in `withEnv` because this test asserts an EMPTY policy takes effect, and the
  // settings file outranks the profile config. Any earlier test that saved settings leaves a
  // file behind, and its `delegationPolicy` (the default) would override the empty one passed
  // here -- so the test would pass or fail depending on what ran before it.
  await withEnv(async () => {
    const h = mountWithGate({ delegationPolicy: '' })
    const agent = h.createAgent('a1')
    runCommand(h, agent, 'on')
    // No section registered at all, so nothing can render.
    assert.equal(h.sections.some((s) => s.name === 'remote-use:policy'), false)
    // The switch still governs execution.
    assert.equal(h.guardReason({ name: 'remote_agents', agent }), undefined)
  })
})
