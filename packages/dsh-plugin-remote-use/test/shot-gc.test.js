/**
 * Tests for screenshot housekeeping.
 *
 * The two properties worth guarding are the ones that make pruning safe to call on every
 * capture: it must never throw, and it must never delete a file this plugin did not write.
 * The rest of the host's temp directory belongs to other software.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_KEEP_SHOTS, pruneShots, shotPattern } from '../lib/core/shot-gc.js'

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'remote-use-shots-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Create `count` screenshots for `peerId`, oldest first, one second apart. */
function seed(dir, peerId, count, size = 10) {
  const base = Date.parse('2026-10-13T00:00:00.000Z')
  const names = []
  for (let n = 0; n < count; n += 1) {
    const stamp = new Date(base + n * 1000).toISOString().replace(/[:.]/gu, '-')
    const name = `${peerId}-${stamp}.png`
    const path = join(dir, name)
    writeFileSync(path, Buffer.alloc(size, n))
    const when = (base + n * 1000) / 1000
    utimesSync(path, when, when)
    names.push(name)
  }
  return names
}

test('the newest N are kept and the rest removed', () => {
  withDir((dir) => {
    seed(dir, 'w1', 5)
    const result = pruneShots(dir, 'w1', 2)
    assert.equal(result.ok, true)
    assert.equal(result.removed, 3)
    assert.equal(result.kept, 2)
    const left = readdirSync(dir).sort()
    assert.equal(left.length, 2)
    // The survivors are the two newest by stamp.
    assert.equal(left[0], 'w1-2026-10-13T00-00-03-000Z.png')
    assert.equal(left[1], 'w1-2026-10-13T00-00-04-000Z.png')
  })
})

test('the freed byte count is reported, so the saving is observable', () => {
  withDir((dir) => {
    seed(dir, 'w1', 4, 1024)
    const result = pruneShots(dir, 'w1', 1)
    assert.equal(result.removed, 3)
    assert.equal(result.freedBytes, 3 * 1024)
  })
})

test('another worker\'s screenshots are never touched', () => {
  withDir((dir) => {
    seed(dir, 'w1', 5)
    seed(dir, 'w2', 5)
    const result = pruneShots(dir, 'w1', 1)
    assert.equal(result.removed, 4)
    // w2 keeps all five.
    assert.equal(readdirSync(dir).filter((n) => n.startsWith('w2-')).length, 5)
    assert.equal(readdirSync(dir).filter((n) => n.startsWith('w1-')).length, 1)
  })
})

test('a peer id that is a PREFIX of another does not collide', () => {
  // `w1` and `w12` are both plausible ids, and without the separator in the pattern
  // pruning `w1` would delete `w12`'s captures.
  withDir((dir) => {
    seed(dir, 'w12', 3)
    seed(dir, 'w1', 3)
    pruneShots(dir, 'w1', 1)
    assert.equal(readdirSync(dir).filter((n) => n.startsWith('w12-')).length, 3, 'w12 must be untouched')
    assert.equal(readdirSync(dir).filter((n) => n.startsWith('w1-')).length, 1)
  })
})

test('files this plugin did not write are left alone', () => {
  // The host's screenshot directory lives under the system temp directory, which is shared
  // with everything else on the machine.
  withDir((dir) => {
    seed(dir, 'w1', 3)
    const foreign = [
      'notes.txt', 'important.docx', 'w1-report.pdf', 'w1-notastamp.png',
      'unrelated-w1-2026-10-13T00-00-00-000Z.png', 'screenshot.png', 'w1.png',
    ]
    for (const name of foreign) writeFileSync(join(dir, name), 'keep me')
    pruneShots(dir, 'w1', 0)
    for (const name of foreign) {
      assert.equal(readdirSync(dir).includes(name), true, `${name} must survive`)
    }
  })
})

test('subdirectories that merely match the pattern are not deleted', () => {
  withDir((dir) => {
    const name = 'w1-2026-10-13T00-00-00-000Z.png'
    mkdirSync(join(dir, name))
    const result = pruneShots(dir, 'w1', 0)
    assert.equal(result.removed, 0)
    assert.equal(result.ok, true, 'a directory is skipped, not an error')
    assert.equal(readdirSync(dir).includes(name), true)
  })
})

test('a NON-FINITE or negative budget disables pruning rather than deleting everything', () => {
  // The dangerous reading of a missing setting is 0, which would wipe the operator's
  // screenshots the first time a config key was misspelled.
  withDir((dir) => {
    for (const keep of [undefined, NaN, Infinity, -1, '20']) {
      seed(dir, 'w1', 3)
      const result = pruneShots(dir, 'w1', keep)
      assert.equal(result.removed, 0, `keep=${String(keep)} must not prune`)
      assert.equal(readdirSync(dir).length, 3)
    }
  })
})

test('keep = 0 deletes them all, because that is what was asked for', () => {
  withDir((dir) => {
    seed(dir, 'w1', 3)
    const result = pruneShots(dir, 'w1', 0)
    assert.equal(result.removed, 3)
    assert.equal(readdirSync(dir).length, 0)
  })
})

test('a missing directory is the normal first-run case, not a failure', () => {
  const result = pruneShots(join(tmpdir(), 'remote-use-does-not-exist-xyz'), 'w1', 5)
  assert.equal(result.ok, true)
  assert.equal(result.removed, 0)
  assert.equal(result.error, '')
})

test('a directory that cannot be listed is REPORTED, never thrown', () => {
  // Pruning runs inside the screenshot path; a failure here must not fail the capture.
  const result = pruneShots('', 'w1', 5)
  assert.equal(result.ok, false)
  assert.match(result.error, /no directory/)
  assert.equal(result.removed, 0)
})

test('pruning is idempotent and keeps the same survivors on a second pass', () => {
  withDir((dir) => {
    seed(dir, 'w1', 5)
    pruneShots(dir, 'w1', 2)
    const before = readdirSync(dir).sort()
    const again = pruneShots(dir, 'w1', 2)
    assert.equal(again.removed, 0)
    assert.deepEqual(readdirSync(dir).sort(), before)
  })
})

test('the supplied default is a real number, and the pattern is anchored', () => {
  assert.equal(Number.isFinite(DEFAULT_KEEP_SHOTS), true)
  assert.ok(DEFAULT_KEEP_SHOTS > 0)
  const pattern = shotPattern('w1')
  assert.equal(pattern.test('w1-2026-10-13T00-00-00-000Z.png'), true)
  assert.equal(pattern.test('w12-2026-10-13T00-00-00-000Z.png'), false)
  assert.equal(pattern.test('xw1-2026-10-13T00-00-00-000Z.png'), false)
  assert.equal(pattern.test('w1-2026-10-13T00-00-00-000Z.png.exe'), false)
  // A peer id containing regex metacharacters must be escaped, not interpreted.
  assert.equal(shotPattern('a.b').test('a.b-2026-10-13T00-00-00-000Z.png'), true)
  assert.equal(shotPattern('a.b').test('axb-2026-10-13T00-00-00-000Z.png'), false)
})

test('the mtime, not the name, decides what is newest', () => {
  // Names come from the clock at capture time, but a file can be copied or touched. Sorting
  // by name alone would then keep the wrong ones.
  withDir((dir) => {
    const names = seed(dir, 'w1', 3)
    // Make the OLDEST file the most recently modified.
    const now = Date.now() / 1000
    utimesSync(join(dir, names[0]), now, now)
    pruneShots(dir, 'w1', 1)
    assert.deepEqual(readdirSync(dir), [names[0]], 'the freshly touched file survives')
    void statSync(join(dir, names[0]))
  })
})
