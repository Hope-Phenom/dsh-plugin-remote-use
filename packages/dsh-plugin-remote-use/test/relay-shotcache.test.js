/**
 * Tests for the relay's BYTE budget and shot-cache report.
 *
 * `slave-prune.test.js` covers the count budget, which is what ships today. This file covers the
 * half that is new and that the operator sees through the settings page: a ceiling in BYTES, the
 * usage numbers that ride on a heartbeat, and the explicit "clear the cache" action.
 *
 * The byte pass is the dangerous one. A count budget that is misread keeps too many files; a
 * byte ceiling that is misread can delete the whole directory -- and the value every unconfigured
 * install has is `0`, which read literally means "keep nothing". That case gets first-class tests
 * here rather than a comment claiming the code handles it.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { DEFAULT_KEEP_SHOTS, RELAY_SHOT_PATTERN, pruneShots, shotUsage } from '../slave/prune-shots.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-shotcache-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const BASE = Date.parse('2026-10-13T00:00:00.000Z')

/** Create relay-style captures of the given sizes, oldest first, one second apart. */
function seedSized(dir, sizes) {
  const names = []
  for (const [n, size] of sizes.entries()) {
    const name = `shot-${BASE + n * 1000}-${n + 1}.png`
    writeFileSync(join(dir, name), Buffer.alloc(size, n))
    utimesSync(join(dir, name), (BASE + n * 1000) / 1000, (BASE + n * 1000) / 1000)
    names.push(name)
  }
  return names
}

/** Uniform captures, which is what these usually are (measured ~9.5 MB each on a real worker). */
function seed(dir, count, size) {
  return seedSized(dir, Array.from({ length: count }, () => size))
}

function bytesOf(dir) {
  return readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)
}

// ---------------------------------------------------------------------------
// The dangerous reading of a missing budget
// ---------------------------------------------------------------------------

test('an absent, zero, negative or nonsense byte ceiling never deletes anything', () => {
  withDir((dir) => {
    // Every value an un-updated master or an unconfigured flag can produce. `0` is the shipped
    // default of `--keep-shot-bytes`, so reading it as "keep 0 bytes" would wipe a worker's
    // cache on the first capture after an upgrade -- with the count budget still at 20 and
    // everyone believing pruning was off.
    for (const maxBytes of [undefined, 0, -1, -1024, NaN, Infinity, -Infinity, '64', null, {}]) {
      for (const name of readdirSync(dir)) rmSync(join(dir, name))
      seed(dir, 5, 10)
      const result = pruneShots(dir, 100, RELAY_SHOT_PATTERN, { maxBytes })
      assert.equal(result.removed, 0, `maxBytes=${String(maxBytes)}`)
      assert.equal(result.freedBytes, 0, `maxBytes=${String(maxBytes)}`)
      assert.equal(result.overBudgetBytes, 0, `maxBytes=${String(maxBytes)}`)
      assert.equal(readdirSync(dir).length, 5, `maxBytes=${String(maxBytes)} must not delete`)
    }
  })
})

test('the byte budget is independent of the count budget, which still applies at 0', () => {
  withDir((dir) => {
    seed(dir, 4, 10)
    // `maxBytes: 0` disables the BYTE pass; `keep: 0` is the count pass saying "keep none". They
    // are separate settings, and "no byte budget" must not quietly turn into "no pruning at all".
    const result = pruneShots(dir, 0, RELAY_SHOT_PATTERN, { maxBytes: 0 })
    assert.equal(result.removed, 4)
    assert.equal(readdirSync(dir).length, 0)
  })
})

// ---------------------------------------------------------------------------
// The byte pass itself
// ---------------------------------------------------------------------------

test('a byte ceiling prunes oldest-first until the directory fits, and reports what it freed', () => {
  withDir((dir) => {
    const names = seed(dir, 5, 10) // 50 bytes, count budget wide enough not to interfere
    const result = pruneShots(dir, 10, RELAY_SHOT_PATTERN, { maxBytes: 25 })
    // 50 -> 40 -> 30 -> 20: the three OLDEST go and the two newest survive.
    assert.equal(result.removed, 3)
    assert.equal(result.kept, 2)
    assert.equal(result.freedBytes, 30)
    assert.equal(result.overBudgetBytes, 0)
    assert.equal(bytesOf(dir), 20)
    assert.deepEqual(readdirSync(dir).sort(), [names[3], names[4]].sort())
  })
})

test('the byte pass takes the OLDEST file, not the largest one', () => {
  withDir((dir) => {
    // Deliberately unsorted sizes: if the pass reached for the biggest file it would drop the
    // 50-byte middle capture and keep the 5-byte oldest one. Oldest-first is what makes the
    // survivors contiguous -- a sequence of recent screenshots rather than a scattered few.
    const names = seedSized(dir, [5, 50, 5])
    const result = pruneShots(dir, 10, RELAY_SHOT_PATTERN, { maxBytes: 55 })
    assert.equal(result.removed, 1)
    assert.equal(result.freedBytes, 5)
    const left = readdirSync(dir)
    assert.equal(left.includes(names[0]), false, 'the oldest file must be the one that goes')
    assert.deepEqual(left.sort(), [names[1], names[2]].sort())
  })
})

test('a ceiling that already covers the directory deletes nothing', () => {
  withDir((dir) => {
    seed(dir, 4, 10)
    // Exactly at the ceiling counts as within budget: "delete until at or below maxBytes", not
    // "until strictly below".
    for (const maxBytes of [40, 41, 1000]) {
      const result = pruneShots(dir, 10, RELAY_SHOT_PATTERN, { maxBytes })
      assert.equal(result.removed, 0, `maxBytes=${maxBytes}`)
      assert.equal(result.overBudgetBytes, 0, `maxBytes=${maxBytes}`)
      assert.equal(readdirSync(dir).length, 4, `maxBytes=${maxBytes}`)
    }
  })
})

test('the newest capture survives even when it alone is over the ceiling, and the overage is reported', () => {
  withDir((dir) => {
    const names = seed(dir, 3, 10)
    const result = pruneShots(dir, 10, RELAY_SHOT_PATTERN, { maxBytes: 4 })
    // 30 -> 20 -> 10, and then the pass stops at the last file. THE MASTER IS ABOUT TO DOWNLOAD
    // THAT FILE: `GET /screenshot?fresh=1` captures and reads it immediately, so deleting it to
    // satisfy a byte ceiling would break the very operation the housekeeping runs alongside. One
    // capture over budget is the recoverable failure; an unreadable screenshot is not.
    assert.equal(result.removed, 2)
    assert.equal(result.kept, 1)
    assert.equal(result.freedBytes, 20)
    assert.equal(result.overBudgetBytes, 6, 'the surviving file is still 6 bytes over the ceiling')
    assert.deepEqual(readdirSync(dir), [names[2]])
  })
})

test('the count budget runs first, and both budgets together behave sanely', () => {
  withDir((dir) => {
    const names = seed(dir, 6, 10) // 60 bytes
    const trimmed = pruneShots(dir, 3, RELAY_SHOT_PATTERN, { maxBytes: 25 })
    // Count pass: 3 oldest go (30 bytes) leaving 30. Byte pass: the oldest SURVIVOR goes, leaving
    // 20 <= 25. The two passes share one result, so `freedBytes` is everything both reclaimed.
    assert.equal(trimmed.removed, 4)
    assert.equal(trimmed.kept, 2)
    assert.equal(trimmed.freedBytes, 40)
    assert.equal(trimmed.overBudgetBytes, 0)
    assert.deepEqual(readdirSync(dir).sort(), [names[4], names[5]].sort())
  })

  withDir((dir) => {
    seed(dir, 6, 10)
    // A ceiling the count budget already satisfies must not add a single deletion.
    const countOnly = pruneShots(dir, 2, RELAY_SHOT_PATTERN, { maxBytes: 1000 })
    assert.equal(countOnly.removed, 4)
    assert.equal(countOnly.kept, 2)
    assert.equal(countOnly.freedBytes, 40)
    assert.equal(countOnly.overBudgetBytes, 0)
  })
})

// ---------------------------------------------------------------------------
// Pattern safety: the rule that protects a mistyped --shot-dir
// ---------------------------------------------------------------------------

test('a foreign file is never counted towards the ceiling, and never deleted by it', () => {
  withDir((dir) => {
    const names = seed(dir, 2, 10) // 20 matching bytes
    // A file far larger than the ceiling that the relay did not write. If the byte pass summed
    // the directory instead of the MATCHING files, this would send it deleting both captures;
    // if it deleted by size, this is the file it would reach for.
    writeFileSync(join(dir, 'notes.md'), Buffer.alloc(4096, 7))
    const result = pruneShots(dir, 10, RELAY_SHOT_PATTERN, { maxBytes: 15 })
    assert.equal(result.removed, 1, 'only one matching capture needed to go')
    assert.equal(result.freedBytes, 10)
    assert.equal(result.overBudgetBytes, 0)
    const left = readdirSync(dir)
    assert.equal(left.includes('notes.md'), true, 'the foreign file must survive')
    assert.deepEqual(left.filter((n) => n !== 'notes.md'), [names[1]])
  })
})

test('a subdirectory that looks like a capture is skipped by both passes', () => {
  withDir((dir) => {
    mkdirSync(join(dir, 'shot-1000-1.png'))
    seed(dir, 2, 10)
    // Counted as a directory entry, it would contribute 0 bytes and still be a delete candidate.
    const usage = shotUsage(dir, RELAY_SHOT_PATTERN)
    assert.equal(usage.files, 2)
    assert.equal(usage.bytes, 20)
    const result = pruneShots(dir, 10, RELAY_SHOT_PATTERN, { maxBytes: 5 })
    assert.equal(readdirSync(dir).includes('shot-1000-1.png'), true)
  })
})

// ---------------------------------------------------------------------------
// shotUsage: the report the master reads on a heartbeat
// ---------------------------------------------------------------------------

test('shotUsage sums only the matching files, and gives their mtime range', () => {
  withDir((dir) => {
    seed(dir, 3, 10)
    writeFileSync(join(dir, 'screenshot-report.txt'), Buffer.alloc(500, 1))
    const usage = shotUsage(dir, RELAY_SHOT_PATTERN)
    assert.equal(usage.files, 3, 'only files the relay wrote count')
    assert.equal(usage.bytes, 30)
    // The range is what tells the master how fast a worker is filling: three captures one second
    // apart is a different situation from three spread over a week.
    assert.ok(Math.abs(usage.oldestAt - BASE) < 1000, `oldestAt=${usage.oldestAt}`)
    assert.ok(Math.abs(usage.newestAt - (BASE + 2000)) < 1000, `newestAt=${usage.newestAt}`)
    assert.ok(usage.newestAt > usage.oldestAt)
  })
})

test('shotUsage reports zeros for a directory that is missing or unusable', () => {
  // The first run of a relay has no shots directory at all, and the master asks for usage
  // before the first capture. "Empty" is the honest answer; an exception would fail a heartbeat.
  const empty = { files: 0, bytes: 0, newestAt: 0, oldestAt: 0 }
  assert.deepEqual(shotUsage(join(tmpdir(), 'relay-shotcache-none-xyz'), RELAY_SHOT_PATTERN), empty)
  assert.deepEqual(shotUsage('', RELAY_SHOT_PATTERN), empty)
  assert.deepEqual(shotUsage(undefined, RELAY_SHOT_PATTERN), empty)
  assert.deepEqual(shotUsage(tmpdir(), undefined), empty)
  withDir((dir) => {
    // A file, not a directory: readdir fails, and that must not throw either.
    const file = join(dir, 'not-a-dir')
    writeFileSync(file, 'x')
    assert.deepEqual(shotUsage(file, RELAY_SHOT_PATTERN), empty)
  })
})

test('an empty directory is zero usage rather than a missing one', () => {
  withDir((dir) => {
    assert.deepEqual(shotUsage(dir, RELAY_SHOT_PATTERN), { files: 0, bytes: 0, newestAt: 0, oldestAt: 0 })
  })
})

// ---------------------------------------------------------------------------
// Result shape: the three-argument call is a shipped contract
// ---------------------------------------------------------------------------

test('the three-argument call reports the same numbers and the same shape as the four-argument one', () => {
  withDir((dir) => {
    seed(dir, 3, 10)
    // The shape is CONSTANT, including for the three-argument call. An earlier revision gated
    // `overBudgetBytes` on `arguments.length` to keep this test's original whole-object deepEqual
    // green; that made the return type depend on how the function was called, which is a trap for
    // every later caller (`opts` has a default, so the fourth argument reads as optional). The
    // numbers are what matter here, so they are asserted field by field and the shape is asserted
    // once, for both arities.
    const three = pruneShots(dir, 1, RELAY_SHOT_PATTERN)
    assert.equal(three.removed, 2)
    assert.equal(three.kept, 1)
    assert.equal(three.freedBytes, 20)
    assert.deepEqual(Object.keys(three).sort(), ['freedBytes', 'kept', 'overBudgetBytes', 'removed'])

    const withOpts = pruneShots(dir, 1, RELAY_SHOT_PATTERN, {})
    assert.deepEqual(Object.keys(withOpts).sort(), Object.keys(three).sort())
    assert.equal(withOpts.overBudgetBytes, 0, 'no byte budget was asked for, so there is no overage')
  })
})

// ---------------------------------------------------------------------------
// The relay's wiring
//
// `slave/relay.mjs` CANNOT be imported by a test: it starts listening on a port at module scope
// (and exits outright without --token). Binding a port in a unit test is worse than the gap it
// would close, so the rules above are tested for real against `prune-shots.mjs`, and the few
// lines that only exist in the relay -- the flag, the RPC name, the two opt-in flags -- are
// asserted against its source. These are wiring guards, not behaviour tests.
// ---------------------------------------------------------------------------

test('the relay exposes the byte budget flag, the RPC and the clear action', () => {
  const relay = readFileSync(join(PKG_ROOT, 'slave', 'relay.mjs'), 'utf8')

  // The flag, read the same way as `--keep-shots`, and defaulting to "no byte budget" so that a
  // master which knows nothing about it changes nothing on an existing worker.
  assert.match(relay, /const KEEP_SHOT_BYTES = Number\(arg\('keep-shot-bytes', '0'\)\)/u,
    'the relay must read --keep-shot-bytes, defaulting to no budget')
  assert.match(relay, /\[--keep-shots <n>\] \[--keep-shot-bytes <n>\]/u,
    'the Usage block must list the new flag next to --keep-shots')
  assert.match(relay, /pruneShots\(SHOT_DIR, KEEP_SHOTS, RELAY_SHOT_PATTERN, \{ maxBytes \}\)/u,
    'the capture path must pass the byte budget through to pruneShots')

  // The RPC is built from the prefix constant, so a rename cannot leave a hardcoded method name
  // behind that the master would then fail to call.
  assert.match(relay, /case `\$\{PLUGIN_PREFIX\}shotcache`: \{/u,
    'dsh-remote/shotcache must be handled locally')
  assert.match(relay, /pruned = pruneOldShots\(maxBytes\)/u, 'prune: true must enforce the budget')
  assert.match(relay, /pruned = clearShots\(\)/u, 'clear: true must go through the clear path')
  assert.match(relay, /pruneShots\(SHOT_DIR, 0, RELAY_SHOT_PATTERN, \{\}\)/u,
    'clear must reuse the one pattern-safe, never-throwing deletion path')
})

test('a heartbeat stays I/O-free unless the master asks for the cache', () => {
  const relay = readFileSync(join(PKG_ROOT, 'slave', 'relay.mjs'), 'utf8')
  const ping = relay.slice(relay.indexOf('case `${PLUGIN_PREFIX}ping`'), relay.indexOf('case `${PLUGIN_PREFIX}selfcheck`'))
  assert.ok(ping.length > 0, 'the ping case must still exist')
  // The master pings every 15 s. Scanning the shot directory on each of those is wasted work, so
  // the scan is behind an explicit opt-in -- and the plain reply keeps the three fields it has
  // always had, which is what stops a version skew from turning a heartbeat into an error.
  assert.match(ping, /msg\.params\?\.cache === true/u, 'the cache scan must be opt-in')
  assert.match(ping, /pong: true,\s*at: new Date\(\)\.toISOString\(\),\s*pid: process\.pid,/u,
    'the un-opted-in reply must be unchanged')
})

test('the exported defaults are still usable', () => {
  assert.equal(Number.isInteger(DEFAULT_KEEP_SHOTS), true)
  assert.ok(DEFAULT_KEEP_SHOTS > 0)
})
