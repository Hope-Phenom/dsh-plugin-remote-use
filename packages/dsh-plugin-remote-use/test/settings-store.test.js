/**
 * Tests for the settings store.
 *
 * The two things most likely to go quietly wrong here are PRECEDENCE (the operator edits
 * the page and the profile patch silently wins, or vice versa) and TOKEN LEAKAGE (a bearer
 * credential for remote execution reaching the browser). Both are asserted directly.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MANAGED_KEYS,
  mergeSettings,
  maskToken,
  normalizeWorker,
  publicWorker,
  readSettings,
  removeWorker,
  settingsPath,
  upsertWorker,
  writeSettings,
} from '../lib/core/settings-store.js'

function withHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'remote-use-settings-'))
  try {
    return fn({ DSH_HOME: dir }, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const WORKER = {
  id: 'w1',
  name: 'w1',
  url: 'ws://10.0.0.5:7331',
  token: 'super-secret-token-value',
  cwd: 'C:\\work',
  enabled: true,
  serialQueue: 1,
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

test('a token never reaches the page, only a masked hint', () => {
  const view = publicWorker(WORKER)
  assert.equal(view.tokenSet, true)
  // The last four characters are enough to tell two tokens apart; the rest must be gone.
  assert.equal(view.tokenHint.endsWith('alue'), true)
  assert.equal(view.tokenHint.includes('super-secret'), false)
  assert.equal('token' in view, false, 'the raw token must not be a field at all')
  assert.equal(JSON.stringify(view).includes('super-secret'), false)
})

test('masking handles short and empty tokens without revealing them', () => {
  assert.equal(maskToken(''), '')
  assert.equal(maskToken('ab'), '\u2022\u2022')
  assert.equal(maskToken('abcd'), '\u2022\u2022\u2022\u2022')
  assert.equal(maskToken('abcdefgh').endsWith('efgh'), true)
  assert.equal(maskToken('abcdefgh').startsWith('\u2022'), true)
  // No plaintext survives anywhere in the masked form.
  assert.equal(maskToken('abcdefgh').includes('abcd'), false)
})

test('publicWorker reports an absent token without inventing one', () => {
  const view = publicWorker({ ...WORKER, token: '' })
  assert.equal(view.tokenSet, false)
  assert.equal(view.tokenHint, '')
})

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

test('normalizeWorker rejects a worker that cannot connect', () => {
  assert.equal(normalizeWorker(null), undefined)
  assert.equal(normalizeWorker({}), undefined)
  // A url without an id cannot be addressed; an id without a url cannot be reached.
  assert.equal(normalizeWorker({ id: 'w' }), undefined)
  assert.equal(normalizeWorker({ url: 'ws://x' }), undefined)
  assert.equal(normalizeWorker({ id: '  ', url: 'ws://x' }), undefined)
})

test('normalizeWorker defaults the optional fields', () => {
  const w = normalizeWorker({ id: 'w', url: 'ws://x' })
  assert.equal(w.name, 'w', 'name falls back to id')
  assert.equal(w.enabled, true)
  assert.equal(w.serialQueue, 1)
  assert.equal(w.cwd, '')
  assert.equal('token' in w, false, 'an empty token is omitted, not stored as ""')
})

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

test('an absent settings file is not an error', () => {
  withHome((env) => {
    const { settings, error, file } = readSettings(env)
    assert.equal(settings, null, 'null means "fall back to the profile", not "empty"')
    assert.equal(error, '')
    assert.equal(file, join(env.DSH_HOME, 'storages', 'dsh-plugin-remote-use', 'settings.json'))
  })
})

test('settings round-trip through the file', () => {
  withHome((env) => {
    const written = writeSettings({ workers: [WORKER], requiredTier: 'read-only' }, env)
    assert.equal(written.ok, true)
    const { settings, error } = readSettings(env)
    assert.equal(error, '')
    assert.equal(settings.workers.length, 1)
    assert.equal(settings.workers[0].token, 'super-secret-token-value')
    assert.equal(settings.requiredTier, 'read-only')
  })
})

test('unmanaged keys in the file are dropped rather than trusted', () => {
  withHome((env) => {
    writeSettings({ workers: [WORKER], somethingElse: 'sneaky', __proto__: { polluted: true } }, env)
    const { settings } = readSettings(env)
    assert.equal('somethingElse' in settings, false)
    for (const key of Object.keys(settings)) assert.ok(MANAGED_KEYS.includes(key), `unexpected key ${key}`)
  })
})

test('a corrupt settings file is reported and does not throw', () => {
  withHome((env) => {
    const file = settingsPath(env)
    writeSettings({ workers: [WORKER] }, env)
    writeFileSync(file, '{ this is not json', 'utf8')
    const { settings, error } = readSettings(env)
    // Falling back to the profile is the safe behaviour: a corrupt file must not stop the
    // plugin from loading.
    assert.equal(settings, null)
    assert.match(error, /unreadable/)
  })
})

test('the write is atomic, leaving no half-written file on success', () => {
  withHome((env) => {
    writeSettings({ workers: [WORKER] }, env)
    const raw = readFileSync(settingsPath(env), 'utf8')
    assert.doesNotThrow(() => JSON.parse(raw), 'the file on disk must always be valid JSON')
  })
})

// ---------------------------------------------------------------------------
// precedence
// ---------------------------------------------------------------------------

test('with no settings file the profile config is used unchanged', () => {
  const profile = { workers: [{ id: 'from-profile', url: 'ws://p' }], requiredTier: 'workspace-write' }
  const { config, sources } = mergeSettings(profile, null)
  assert.deepEqual(config, profile)
  assert.equal(sources.workers, 'profile')
  assert.equal(sources.requiredTier, 'profile')
})

test('the settings file wins only for the keys it actually contains', () => {
  const profile = { workers: [{ id: 'from-profile', url: 'ws://p' }], requiredTier: 'workspace-write', approvalTimeoutMs: 1000 }
  const { config, sources } = mergeSettings(profile, { workers: [WORKER] })
  assert.equal(config.workers[0].id, 'w1', 'the settings file owns workers')
  assert.equal(sources.workers, 'settings')
  // Untouched keys keep the profile's value AND its provenance.
  assert.equal(config.requiredTier, 'workspace-write')
  assert.equal(sources.requiredTier, 'profile')
  assert.equal(config.approvalTimeoutMs, 1000)
})

test('workers REPLACE rather than merge, so a deletion is expressible', () => {
  const profile = { workers: [{ id: 'a', url: 'ws://a' }, { id: 'b', url: 'ws://b' }] }
  const { config } = mergeSettings(profile, { workers: [{ id: 'a', url: 'ws://a' }] })
  // Merging would make it impossible to remove a worker from the page.
  assert.deepEqual(config.workers.map((w) => w.id), ['a'])
})

// ---------------------------------------------------------------------------
// editing
// ---------------------------------------------------------------------------

test('upsertWorker adds, then updates in place', () => {
  const added = upsertWorker([], { id: 'w1', url: 'ws://a', token: 't1' })
  assert.equal(added.error, '')
  assert.equal(added.workers.length, 1)

  const renamed = upsertWorker(added.workers, { id: 'w1', url: 'ws://a', name: 'Renamed' })
  assert.equal(renamed.error, '')
  assert.equal(renamed.workers.length, 1, 'the same id updates rather than duplicating')
  assert.equal(renamed.workers[0].name, 'Renamed')
})

test('editing without a token keeps the stored one', () => {
  // The page never receives the token, so forcing a re-entry to rename a worker would be
  // both annoying and pointless.
  const list = [{ ...WORKER }]
  const edited = upsertWorker(list, { id: 'w1', url: 'ws://changed', name: 'w1' })
  assert.equal(edited.error, '')
  assert.equal(edited.workers[0].token, 'super-secret-token-value', 'the credential must survive')
  assert.equal(edited.workers[0].url, 'ws://changed')
})

test('a NEW worker without a token is refused', () => {
  // Silently creating a worker that can never authenticate would look like it worked and
  // then fail at dispatch time.
  const { error, workers } = upsertWorker([], { id: 'new', url: 'ws://x' })
  assert.match(error, /needs a token/)
  assert.equal(workers.length, 0)
})

test('an explicit token replaces the stored one', () => {
  const edited = upsertWorker([{ ...WORKER }], { id: 'w1', url: WORKER.url, token: 'brand-new' })
  assert.equal(edited.workers[0].token, 'brand-new')
})

test('upsertWorker rejects an unaddressable worker and changes nothing', () => {
  const list = [{ ...WORKER }]
  const { error, workers } = upsertWorker(list, { id: 'w1' })
  assert.match(error, /id and a url/)
  assert.deepEqual(workers, list)
})

test('removeWorker reports whether anything was removed', () => {
  const list = [{ ...WORKER }, { ...WORKER, id: 'w2' }]
  const first = removeWorker(list, 'w1')
  assert.equal(first.removed, true)
  assert.deepEqual(first.workers.map((w) => w.id), ['w2'])
  const again = removeWorker(first.workers, 'nope')
  assert.equal(again.removed, false)
  assert.equal(again.workers.length, 1)
})
