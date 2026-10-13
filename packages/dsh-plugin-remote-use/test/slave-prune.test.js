/**
 * Tests for the RELAY's screenshot housekeeping.
 *
 * The relay runs on the worker, where a mistake means deleted data on someone else's machine
 * and no easy way to see what happened. So the two safety rules get first-class tests here
 * rather than being trusted because the code "looks obvious".
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_KEEP_SHOTS, RELAY_SHOT_PATTERN, pruneShots } from '../slave/prune-shots.mjs'

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-shots-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Create relay-style captures, oldest first, one second apart. */
function seed(dir, count, size = 8) {
  const base = Date.parse('2026-10-13T00:00:00.000Z')
  const names = []
  for (let n = 0; n < count; n += 1) {
    const name = `shot-${base + n * 1000}-${n + 1}.png`
    writeFileSync(join(dir, name), Buffer.alloc(size, n))
    utimesSync(join(dir, name), (base + n * 1000) / 1000, (base + n * 1000) / 1000)
    names.push(name)
  }
  return names
}

test('the newest N survive and the rest are removed', () => {
  withDir((dir) => {
    const names = seed(dir, 5)
    const result = pruneShots(dir, 2, RELAY_SHOT_PATTERN)
    assert.equal(result.removed, 3)
    assert.equal(result.freedBytes, 3 * 8)
    assert.deepEqual(readdirSync(dir).sort(), [names[3], names[4]].sort())
  })
})

test('files the relay did not write are never deleted', () => {
  withDir((dir) => {
    seed(dir, 3)
    const foreign = ['screenshot-report.txt', 'notes.md', 'shot.png', 'shot-1.png', 'shot-1-2.png.bak', 'worker-pc-2026-10-13T00-00-00-000Z.png']
    for (const name of foreign) writeFileSync(join(dir, name), 'keep')
    pruneShots(dir, 0, RELAY_SHOT_PATTERN)
    for (const name of foreign) {
      assert.equal(readdirSync(dir).includes(name), true, `${name} must survive`)
    }
  })
})

test('a non-finite or negative budget disables pruning instead of wiping the directory', () => {
  withDir((dir) => {
    for (const keep of [undefined, NaN, Infinity, -1, '20']) {
      seed(dir, 3)
      assert.equal(pruneShots(dir, keep, RELAY_SHOT_PATTERN).removed, 0, `keep=${String(keep)}`)
      assert.equal(readdirSync(dir).length, 3)
      for (const name of readdirSync(dir)) rmSync(join(dir, name))
    }
  })
})

test('a missing directory is the first-run case, and an unusable call is a no-op', () => {
  assert.deepEqual(pruneShots(join(tmpdir(), 'relay-shots-none-xyz'), 5, RELAY_SHOT_PATTERN), { removed: 0, kept: 0, freedBytes: 0 })
  // A bad pattern must not fall back to deleting everything.
  withDir((dir) => {
    seed(dir, 3)
    assert.equal(pruneShots(dir, 0, undefined).removed, 0)
    assert.equal(pruneShots(dir, 0, 'shot').removed, 0)
    assert.equal(readdirSync(dir).length, 3)
  })
})

test('the pattern matches exactly the names the relay generates', () => {
  // Pinned to `captureScreenshot`'s `shot-${Date.now()}-${++shotSeq}.png`.
  assert.equal(RELAY_SHOT_PATTERN.test('shot-1791853665933-1.png'), true)
  assert.equal(RELAY_SHOT_PATTERN.test('shot-1-1.png'), true)
  assert.equal(RELAY_SHOT_PATTERN.test('shot-1-1.png.exe'), false)
  assert.equal(RELAY_SHOT_PATTERN.test('xshot-1-1.png'), false)
  assert.equal(RELAY_SHOT_PATTERN.test('shot--1.png'), false)
  assert.equal(RELAY_SHOT_PATTERN.test('shot-1-a.png'), false)
})

test('subdirectories are skipped, not deleted', () => {
  withDir((dir) => {
    const name = 'shot-1000-1.png'
    mkdirSync(join(dir, name))
    const result = pruneShots(dir, 0, RELAY_SHOT_PATTERN)
    assert.equal(result.removed, 0)
    assert.equal(readdirSync(dir).includes(name), true)
  })
})

test('the newest is decided by mtime, with the sequence number breaking ties', () => {
  withDir((dir) => {
    const names = seed(dir, 3)
    // Same mtime for all three: only the sequence number can order them then.
    const when = Date.parse('2026-10-13T00:00:00.000Z') / 1000
    for (const name of names) utimesSync(join(dir, name), when, when)
    pruneShots(dir, 1, RELAY_SHOT_PATTERN)
    assert.deepEqual(readdirSync(dir), [names[2]], 'the highest sequence number wins the tie')
  })
})

test('the exported default is usable', () => {
  assert.equal(Number.isInteger(DEFAULT_KEEP_SHOTS), true)
  assert.ok(DEFAULT_KEEP_SHOTS > 0)
})
