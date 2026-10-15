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

import {
  DEFAULT_KEEP_SHOTS,
  DEFAULT_SHOT_CACHE_BYTES,
  clearShots,
  formatBytes,
  parseBytes,
  pruneShots,
  scanShotUsage,
  shotPattern,
} from '../lib/core/shot-gc.js'

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

// ---------------------------------------------------------------------------
// The byte budget.
//
// WHY THESE CASES: the count budget existed and the directory still reached 218 MB, because a
// count bounds the NUMBER of files and not the disk they occupy. Every case below is about the
// one property that makes a byte budget safe to apply automatically: it must never delete
// anything the operator did not ask to lose.
// ---------------------------------------------------------------------------

test('a byte ceiling removes the OLDEST until the survivors fit', () => {
  withDir((dir) => {
    // Five files of 1 KiB each; a 3 KiB ceiling must leave the three newest.
    const names = seed(dir, 'w1', 5, 1024)
    const result = pruneShots(dir, 'w1', 10, { maxBytes: 3 * 1024 })
    assert.equal(result.ok, true)
    assert.equal(result.removed, 2)
    assert.equal(result.kept, 3)
    assert.equal(result.freedBytes, 2 * 1024)
    assert.equal(result.bytes, 3 * 1024)
    assert.equal(result.overBudgetBytes, 0)
    const left = readdirSync(dir).sort()
    assert.deepEqual(left, [names[2], names[3], names[4]].sort())
  })
})

test('a zero, negative or non-finite byte budget deletes NOTHING', () => {
  // The same trap as the count budget: the dangerous reading of "not configured" is 0, which
  // would wipe every capture the first time a key was misspelled.
  //
  // The count budget is explicitly DISABLED here (`keep: Infinity`), which is the only way to
  // attribute the outcome to the byte budget: a real count of 10 over a 4-file seed would itself
  // be a valid budget and would delete one file, making an isolated claim about bytes meaningless.
  for (const maxBytes of [0, -1, NaN, Infinity, '4096']) {
    withDir((dir) => {
      seed(dir, 'w1', 4, 1024)
      const result = pruneShots(dir, 'w1', Infinity, { maxBytes })
      assert.equal(result.removed, 0, `maxBytes=${String(maxBytes)} must not prune`)
      assert.equal(readdirSync(dir).length, 4)
    })
  }
})

test('an invalid COUNT budget still lets the byte budget do its job', () => {
  // The two budgets are independent: a negative count means "keep every file by count", not
  // "disable the whole function". Otherwise setting one budget would silently switch the other off.
  withDir((dir) => {
    seed(dir, 'w1', 4, 1024)
    const result = pruneShots(dir, 'w1', -1, { maxBytes: 2 * 1024 })
    assert.equal(result.kept, 2)
    assert.equal(result.bytes, 2 * 1024)
  })
})

test('a zero byte budget with a REAL count budget deletes nothing', () => {
  // THE REGRESSION THIS EXISTS FOR. The byte pass originally tested only `running > maxBytes`
  // without checking that a byte budget was actually set. With no ceiling, `maxBytes` is 0 and
  // every non-empty directory is "over" 0, so "no ceiling" deleted everything except the newest
  // capture -- the exact opposite of what 0 means.
  //
  // The earlier tests passed `keep: Infinity`, which returns at the no-budget guard before the
  // byte loop and so never exercised this path. The combination that matters is a REAL count
  // budget (which the page always has, since the default is 20) alongside no byte ceiling.
  withDir((dir) => {
    seed(dir, 'w1', 4, 1024)
    const result = pruneShots(dir, 'w1', 20, { maxBytes: 0 })
    assert.equal(result.removed, 0, 'a zero ceiling must not be read as "delete everything"')
    assert.equal(result.kept, 4)
    assert.equal(readdirSync(dir).length, 4)
    assert.equal(result.overBudgetBytes, 0, 'with no ceiling there is no overage to report')
  })
})

test('the byte pass never runs when no ceiling is set, whatever the count budget', () => {
  // Same defect, swept across the count budgets an operator can actually configure -- including
  // the negative "keep every capture" value and a small positive one that must still be honoured.
  for (const keep of [0, 1, 20, 100, -1, Infinity]) {
    withDir((dir) => {
      seed(dir, 'w1', 4, 1024)
      const result = pruneShots(dir, 'w1', keep, { maxBytes: 0 })
      const expectedKept = Number.isFinite(keep) && keep >= 0 ? Math.min(keep, 4) : 4
      assert.equal(result.kept, expectedKept, `keep=${String(keep)}: only the count budget may act`)
      assert.equal(readdirSync(dir).length, expectedKept)
    })
  }
})

test('the byte budget is inert when no opts are passed at all', () => {
  // The three-argument call is the shipped call site on the worker side and in older code paths;
  // its behaviour must not change just because a fourth parameter grew a default. The count is
  // disabled so that ANY removal would have to have come from the byte budget.
  withDir((dir) => {
    seed(dir, 'w1', 4, 1024)
    const result = pruneShots(dir, 'w1', Infinity)
    assert.equal(result.removed, 0)
    assert.equal(result.overBudgetBytes, 0)
  })
})

test('the NEWEST capture survives even when it alone exceeds the budget', () => {
  // This is the case that makes the feature safe to run automatically inside the capture path:
  // the newest file is the one the host is usually about to download, and deleting it would
  // leave the screenshot tool reporting success with nothing on disk to show. The overshoot is
  // reported rather than hidden, so the page can say the directory is over budget.
  withDir((dir) => {
    const names = seed(dir, 'w1', 3, 1024)
    const result = pruneShots(dir, 'w1', 10, { maxBytes: 10 })
    assert.equal(result.kept, 1, 'exactly the newest is left')
    assert.equal(result.removed, 2)
    assert.deepEqual(readdirSync(dir), [names[2]])
    assert.equal(result.overBudgetBytes, 1024 - 10, 'the overshoot is reported, not swallowed')
  })
})

test('the count budget and the byte budget both apply, and the first one to bite wins', () => {
  withDir((dir) => {
    seed(dir, 'w1', 6, 1024)
    // The count allows 5, the byte ceiling allows 2. The byte ceiling is the binding constraint.
    const result = pruneShots(dir, 'w1', 5, { maxBytes: 2 * 1024 })
    assert.equal(result.kept, 2)
    assert.equal(readdirSync(dir).length, 2)
  })
  withDir((dir) => {
    seed(dir, 'w1', 6, 1024)
    // The count allows 2, the byte ceiling allows far more. The count is the binding constraint.
    const result = pruneShots(dir, 'w1', 2, { maxBytes: 100 * 1024 })
    assert.equal(result.kept, 2)
    assert.equal(result.overBudgetBytes, 0)
  })
})

test('the byte budget does not reach across workers', () => {
  withDir((dir) => {
    seed(dir, 'w1', 4, 1024)
    seed(dir, 'w2', 4, 1024)
    const result = pruneShots(dir, 'w1', 10, { maxBytes: 1024 })
    assert.equal(result.kept, 1, 'only w1 was measured against the ceiling')
    assert.equal(readdirSync(dir).filter((n) => n.startsWith('w2-')).length, 4)
  })
})

test('a file the byte pass could not delete is not reported as freed', () => {
  // `freedBytes` is shown to the operator as reclaimed space. Counting a file that is still on
  // disk would make the page repeat a number that is not true, which is worse than silence.
  withDir((dir) => {
    seed(dir, 'w1', 2, 1024)
    // A matching NAME that is a directory cannot be unlinked; the stat in the listing excludes it,
    // so this asserts the accounting stays consistent rather than that deletion fails.
    mkdirSync(join(dir, 'w1-2026-10-13T00-00-09-000Z.png'))
    const result = pruneShots(dir, 'w1', 10, { maxBytes: 1024 })
    assert.equal(result.bytes + result.freedBytes, 2 * 1024, 'survivors + freed must account for every FILE')
  })
})

// ---------------------------------------------------------------------------
// Reporting and clearing.
// ---------------------------------------------------------------------------

test('usage counts only this worker\'s files and sums their bytes', () => {
  withDir((dir) => {
    seed(dir, 'w1', 3, 1000)
    seed(dir, 'w2', 2, 500)
    writeFileSync(join(dir, 'notes.txt'), 'x'.repeat(9999))
    const usage = scanShotUsage(dir, 'w1')
    assert.equal(usage.files, 3)
    assert.equal(usage.bytes, 3000, 'a foreign file of any size is not counted')
    assert.equal(usage.error, '')
    assert.ok(usage.newestAt > 0 && usage.oldestAt > 0)
    assert.ok(usage.newestAt >= usage.oldestAt)
  })
})

test('usage of a missing directory is zeroes, not an error', () => {
  // This runs on every page load and on a liveness probe. A directory that does not exist yet is
  // the normal first-run state, and a failure here would show a red card for a healthy worker.
  const usage = scanShotUsage(join(tmpdir(), 'remote-use-absent-xyz'), 'w1')
  assert.deepEqual(usage, { files: 0, bytes: 0, newestAt: 0, oldestAt: 0, error: '' })
  assert.deepEqual(scanShotUsage('', 'w1'), { files: 0, bytes: 0, newestAt: 0, oldestAt: 0, error: '' })
})

test('clearing one worker leaves every other worker and every foreign file alone', () => {
  withDir((dir) => {
    seed(dir, 'w1', 3, 1000)
    seed(dir, 'w2', 2, 1000)
    const foreign = ['notes.txt', 'w1-notastamp.png', 'screenshot.png']
    for (const name of foreign) writeFileSync(join(dir, name), 'keep me')
    const result = clearShots(dir, 'w1')
    assert.equal(result.ok, true)
    assert.equal(result.removed, 3)
    assert.equal(result.freedBytes, 3000)
    assert.equal(readdirSync(dir).filter((n) => n.startsWith('w2-')).length, 2)
    for (const name of foreign) assert.equal(readdirSync(dir).includes(name), true, `${name} must survive`)
  })
})

test('clearing with no worker clears every worker\'s captures but nothing else', () => {
  withDir((dir) => {
    seed(dir, 'w1', 2, 1000)
    seed(dir, 'w2', 3, 1000)
    const foreign = ['notes.txt', 'report.pdf', 'screenshot.png']
    for (const name of foreign) writeFileSync(join(dir, name), 'keep me')
    const result = clearShots(dir)
    assert.equal(result.removed, 5)
    assert.equal(result.bytes, 0)
    for (const name of foreign) assert.equal(readdirSync(dir).includes(name), true, `${name} must survive`)
  })
})

test('clearing a missing directory is the first-run case, not a failure', () => {
  const result = clearShots(join(tmpdir(), 'remote-use-absent-xyz'), 'w1')
  assert.equal(result.ok, true)
  assert.equal(result.removed, 0)
  assert.equal(result.error, '')
})

test('a byte budget parses with a unit, because nobody types bytes', () => {
  // The page's field accepts "512MB"; a parser that silently wanted a raw byte count would turn
  // an operator's 512 MB into 512 bytes -- which either deletes nothing or nearly everything.
  assert.equal(parseBytes('512MB'), 512 * 1024 * 1024)
  assert.equal(parseBytes('1.5GB'), Math.floor(1.5 * 1024 * 1024 * 1024))
  assert.equal(parseBytes('2048'), 2048)
  assert.equal(parseBytes('0'), 0)
  assert.equal(parseBytes('-1'), -1)
  assert.equal(parseBytes(4096), 4096)
  assert.equal(parseBytes(' 256 mb '), 256 * 1024 * 1024)
  // Unparseable input must be distinguishable from zero: 0 is a real choice ("no limit").
  for (const bad of ['', '   ', 'lots', '12XB', 'MB', null, undefined, {}]) {
    assert.equal(parseBytes(bad), undefined, `${String(bad)} must not parse`)
  }
})

test('a byte count renders with the unit the operator configured in', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(8 * 1024 * 1024), '8.0 MB')
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.00 GB')
})

test('the shipped byte default is "no ceiling"', () => {
  // Stated as a test because it is a policy, not an implementation detail: an install that
  // upgrades into a byte ceiling would start deleting captures nobody agreed to lose.
  assert.equal(DEFAULT_SHOT_CACHE_BYTES, 0)
})
