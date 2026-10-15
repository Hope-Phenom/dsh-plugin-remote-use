/**
 * Tests for the audit log.
 *
 * Two properties matter and they pull against each other: the trail must survive (append
 * only, readable after a restart), and it must never be able to veto the operation it is
 * observing. Both are asserted directly.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AuditLog, auditPath } from '../lib/core/audit-log.js'

function withHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'remote-use-audit-'))
  try {
    return fn({ DSH_HOME: dir }, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const ROW = { kind: 'approval', peerId: 'w1', toolName: 'write', optionId: 'reject-once', by: 'human' }

test('rows are appended and read back', () => {
  withHome((env) => {
    const log = new AuditLog({ env })
    assert.equal(log.record(ROW), true)
    assert.equal(log.record({ ...ROW, optionId: 'allow-once' }), true)

    const text = readFileSync(auditPath(env), 'utf8')
    const lines = text.trim().split('\n')
    assert.equal(lines.length, 2, 'each record is one line')
    const first = JSON.parse(lines[0])
    assert.equal(first.optionId, 'reject-once')
    assert.equal(first.peerId, 'w1')
    // Every row is stamped, so the trail answers "when" without the caller remembering to.
    assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/)
  })
})

test('the file is APPEND-ONLY: a later write never rewrites what is already there', () => {
  withHome((env) => {
    const first = new AuditLog({ env })
    first.record({ ...ROW, note: 'before restart' })
    const sizeAfterFirst = readFileSync(auditPath(env), 'utf8').length

    // A second process, as a restart would be.
    const second = new AuditLog({ env })
    assert.equal(second.size, 1, 'the tail is loaded so history survives a restart')
    second.record({ ...ROW, note: 'after restart' })

    const text = readFileSync(auditPath(env), 'utf8')
    assert.ok(text.length > sizeAfterFirst, 'the file only grew')
    assert.match(text, /before restart/)
    assert.match(text, /after restart/)
    assert.deepEqual(second.tail().map((r) => r.note), ['after restart', 'before restart'])
  })
})

test('a torn or corrupt line is skipped, never fatal', () => {
  withHome((env) => {
    const file = auditPath(env)
    const log = new AuditLog({ env })
    log.record(ROW)
    // A partially-written line, as a crash mid-append would leave.
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"kind":"approval","trunc\n`, 'utf8')

    const reopened = new AuditLog({ env })
    assert.equal(reopened.size, 1, 'the intact row survives and the torn one is dropped')
    assert.equal(reopened.lastError, '', 'a dropped line is not an error')
  })
})

test('an unwritable file is REPORTED, never thrown -- an audit trail must not veto an approval', () => {
  withHome((env, dir) => {
    // Make the parent path a FILE, so both the mkdir and the append fail.
    writeFileSync(join(dir, 'storages'), 'not a directory', 'utf8')

    const log = new AuditLog({ env })
    const ok = log.record(ROW)
    assert.equal(ok, false, 'the caller is told it did not reach the disk')
    assert.match(log.lastError, /could not append/)
    // The row is still visible in memory, so the page can show what just happened.
    assert.equal(log.size, 1)
    assert.deepEqual(log.tail().map((r) => r.optionId), ['reject-once'])
  })
})

test('tail() returns the newest rows first', () => {
  withHome((env) => {
    const log = new AuditLog({ env })
    for (let n = 1; n <= 5; n += 1) log.record({ ...ROW, n })
    assert.deepEqual(log.tail(3).map((r) => r.n), [5, 4, 3])
    assert.deepEqual(log.tail().map((r) => r.n), [5, 4, 3, 2, 1])
  })
})

test('the in-memory window is bounded so a long run cannot grow without limit', () => {
  withHome((env) => {
    const log = new AuditLog({ env })
    for (let n = 0; n < 260; n += 1) log.record({ ...ROW, n })
    assert.ok(log.size <= 200, `memory window must be capped, got ${log.size}`)
    // ...while the FILE keeps everything.
    const lines = readFileSync(auditPath(env), 'utf8').trim().split('\n')
    assert.equal(lines.length, 260, 'the trail on disk is complete')
  })
})

test('missed() surfaces the refusals nobody answered, and only those', () => {
  // The whole point: six `by=timeout` rows sat in the live trail and the operator had never seen a
  // prompt. A miss has to be findable after the fact, separately from what was decided.
  withHome((env) => {
    const log = new AuditLog({ env })
    log.record({ ...ROW, by: 'timeout', n: 1 })
    log.record({ ...ROW, by: 'page', n: 2, optionId: 'allow-once' })
    log.record({ ...ROW, by: 'api', n: 3, optionId: 'allow-once' })
    log.record({ ...ROW, by: 'disposed', n: 4 })
    log.record({ ...ROW, by: 'no-answerer', n: 5 })
    log.record({ ...ROW, by: 'engine', n: 6, optionId: 'allow-once' })
    log.record({ kind: 'other', by: 'timeout', n: 7 })

    assert.deepEqual(log.missed().map((r) => r.n), [5, 4, 1], 'newest first, only the unanswered')
    assert.deepEqual(log.missed(2).map((r) => r.n), [5, 4], 'the limit keeps the newest')
    assert.equal(log.missedCount, 3, 'the count is over every miss in memory, not just the page size')
  })
})

test('a miss survives a restart, because the page must be able to report what it missed', () => {
  withHome((env) => {
    const first = new AuditLog({ env })
    first.record({ ...ROW, by: 'timeout', n: 1 })
    const reopened = new AuditLog({ env })
    assert.deepEqual(reopened.missed().map((r) => r.n), [1])
    assert.equal(reopened.missedCount, 1)
  })
})

test('a trail with nothing missed reports zero, not undefined', () => {
  withHome((env) => {
    const log = new AuditLog({ env })
    assert.deepEqual(log.missed(), [])
    assert.equal(log.missedCount, 0)
    log.record({ ...ROW, by: 'page' })
    assert.equal(log.missedCount, 0, 'a decided request is not a miss')
  })
})

test('a missing file is the normal starting state', () => {
  withHome((env) => {
    assert.equal(existsSync(auditPath(env)), false)
    const log = new AuditLog({ env })
    assert.equal(log.size, 0)
    assert.equal(log.lastError, '')
    assert.deepEqual(log.tail(), [])
  })
})

// ---------------------------------------------------------------------------
// clearing the missed list
//
// The operator asked for this because a count of past misses stayed on screen forever and read as
// a live problem. The tempting implementation -- delete the rows -- turns the evidence trail into
// something that can be made to say whatever the last person to click wanted, so the tests below
// pin BOTH halves of the chosen design: the views reset, and the file does not lose anything.
// ---------------------------------------------------------------------------

test('clear() empties the miss views and REMOVES NOTHING from the trail', () => {
  withHome((env, dir) => {
    const log = new AuditLog({ env })
    log.record({ ...ROW, by: 'timeout', n: 1 })
    log.record({ ...ROW, by: 'page', n: 2, optionId: 'allow-once' })
    log.record({ ...ROW, by: 'disposed', n: 3 })
    assert.equal(log.missedCount, 2)

    assert.equal(log.clear('page'), 2, 'the caller learns how many it stopped showing')
    assert.deepEqual(log.missed(), [], 'the view is empty')
    assert.equal(log.missedCount, 0)

    // The half that matters most: every original row is still on disk, untouched.
    const lines = readFileSync(join(dir, 'storages', 'dsh-plugin-remote-use', 'audit.jsonl'), 'utf8')
      .split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
    assert.deepEqual(lines.map((r) => r.n ?? null), [1, 2, 3, null], 'the three rows survive plus the watermark')
    const watermark = lines[3]
    assert.equal(watermark.kind, 'approvals-cleared')
    assert.equal(watermark.by, 'page', 'the clear itself is attributed to whoever clicked')
    assert.equal(log.tail(1)[0].kind, 'approvals-cleared', 'and it is visible in the raw trail view')
  })
})

test('a miss that arrives AFTER the clear is shown again', () => {
  // The watermark is a starting point, not a mute switch: the operator cleared what they had seen,
  // and a request that expires next week is a new fact they must not be shielded from.
  withHome((env) => {
    const log = new AuditLog({ env })
    log.record({ ...ROW, by: 'timeout', n: 1 })
    log.clear('api')
    log.record({ ...ROW, by: 'timeout', n: 2 })
    assert.deepEqual(log.missed().map((r) => r.n), [2])
    assert.equal(log.missedCount, 1)
  })
})

test('the cleared state survives a restart, so the count does not come back', () => {
  // Without this the list would reappear on every DSH restart, which is exactly the "it never goes
  // away" complaint the clear exists to answer.
  withHome((env) => {
    const first = new AuditLog({ env })
    first.record({ ...ROW, by: 'timeout', n: 1 })
    first.record({ ...ROW, by: 'timeout', n: 2 })
    first.clear('page')

    const reopened = new AuditLog({ env })
    assert.equal(reopened.clearedAt, first.clearedAt, 'the watermark is read back from the file')
    assert.equal(reopened.missedCount, 0)
    assert.deepEqual(reopened.missed(), [])
  })
})

test('clearing with nothing missed is harmless and still records the action', () => {
  withHome((env) => {
    const log = new AuditLog({ env })
    assert.equal(log.clear('page'), 0)
    assert.equal(log.missedCount, 0)
    assert.equal(log.size, 1)
  })
})

test('clearing does not touch what was DECIDED, only what was missed', () => {
  withHome((env) => {
    const log = new AuditLog({ env })
    log.record({ ...ROW, by: 'page', n: 1, optionId: 'allow-once' })
    log.record({ ...ROW, by: 'timeout', n: 2 })
    assert.equal(log.clear('page'), 1)
    assert.equal(log.missedCount, 0)
    assert.equal(log.tail(2)[0].kind, 'approvals-cleared')
    assert.equal(log.size, 3, 'a decided row and the cleared miss are both still in memory and on disk')
  })
})

test('the watermark keeps pointing at its own row when the in-memory window is trimmed', () => {
  // The watermark is an INDEX, so the bounded window's trim has to shift it. Getting this wrong is
  // silent: the count would be taken from the wrong starting point and would drift as the window
  // moved, which is worse than being obviously broken. 200 rows is MEMORY_LIMIT.
  withHome((env) => {
    const log = new AuditLog({ env })
    for (let i = 0; i < 190; i += 1) log.record({ ...ROW, by: 'timeout', n: i })
    assert.equal(log.missedCount, 190)
    log.clear('page')
    assert.equal(log.missedCount, 0)

    // Push the watermark's own row out of the window, then add one fresh miss.
    for (let i = 0; i < 260; i += 1) log.record({ ...ROW, by: 'api', n: 1000 + i })
    assert.ok(log.size <= 200, 'the window stays bounded')
    log.record({ ...ROW, by: 'timeout', n: 9999 })
    assert.deepEqual(log.missed().map((r) => r.n), [9999], 'only the miss after the clear counts')
    assert.equal(log.missedCount, 1)
  })
})

// ---------------------------------------------------------------------------
// bounded growth: rotation and retention
//
// The trail is append-only, which means it had NO upper bound at all: it grew for as long as the
// plugin was installed. DESIGN.md had claimed a rotation policy for months while the code had none,
// so these tests exist to keep the claim and the behaviour from drifting apart again.
// ---------------------------------------------------------------------------

const archivesIn = (dir) =>
  readdirSync(join(dir, 'storages', 'dsh-plugin-remote-use'))
    .filter((name) => /^audit\..+\.jsonl$/.test(name)).sort()

test('the live file ROTATES at the cap instead of growing past it', () => {
  withHome((env, dir) => {
    // Small enough to trip after a handful of rows.
    const log = new AuditLog({ env, now: () => Date.parse('2026-10-15T03:00:00.000Z'), maxBytes: 600 })
    for (let i = 0; i < 40; i += 1) log.record({ ...ROW, by: 'api', n: i, pad: 'x'.repeat(80) })

    const archives = archivesIn(dir)
    assert.ok(archives.length > 0, 'crossing the cap produces an archive')
    assert.ok(log.bytes <= 600 + 400, `the live file stays near the cap (saw ${log.bytes})`)
    // NOTHING WAS TRUNCATED: every row written is still on disk across the live file + archives.
    const log2 = new AuditLog({ env })
    const total = archivesIn(dir).length
    assert.ok(total > 0)
    assert.equal(log2.archives().length, total)
  })
})

test('rotation NEVER loses a row: the archive is the old file, byte for byte', () => {
  withHome((env, dir) => {
    const log = new AuditLog({ env, now: () => Date.parse('2026-10-15T03:00:00.000Z'), maxBytes: 600, keepFiles: -1 })
    const written = []
    for (let i = 0; i < 30; i += 1) {
      const row = { ...ROW, by: 'api', n: i }
      log.record(row)
      written.push(i)
    }
    // Read every file in the directory back and collect the `n` values: the union must be complete.
    const seen = []
    for (const name of ['audit.jsonl', ...archivesIn(dir)]) {
      const text = readFileSync(join(dir, 'storages', 'dsh-plugin-remote-use', name), 'utf8')
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        const row = JSON.parse(line)
        if (row.kind === 'approval') seen.push(row.n)
      }
    }
    assert.deepEqual(seen.sort((a, b) => a - b), written, 'every row is in exactly one file')
  })
})

test('retention deletes only the OLDEST archives, and keeps the configured count', () => {
  withHome((env, dir) => {
    // 1 archive kept, and rotation is forced by a tiny cap so several archives appear.
    const log = new AuditLog({ env, now: () => Date.parse('2026-10-15T03:00:00.000Z'), maxBytes: 200, keepFiles: 1 })
    for (let i = 0; i < 60; i += 1) log.record({ ...ROW, by: 'api', n: i, pad: 'y'.repeat(60) })
    const archives = archivesIn(dir)
    assert.equal(archives.length, 1, `exactly one archive is kept (saw ${archives.join(', ')})`)
    // The survivor is the NEWEST, not an arbitrary one: names sort by timestamp.
    assert.ok(log.bytes <= 200 + 400, 'and the live file is the newest of them')
  })
})

test('A CLEAR SURVIVES ROTATION: the watermark is carried into the new file', () => {
  // This is the interaction that would have shipped silently. The watermark is a ROW; rotation moves
  // the row it lives in into an archive, and the restart read (`#loadTail`) only looks at the live
  // file. Without carrying it, every restart after a rotation would resurrect the misses the
  // operator had already cleared -- i.e. the exact complaint the clear feature exists to answer.
  withHome((env, dir) => {
    const log = new AuditLog({ env, now: () => Date.parse('2026-10-15T03:00:00.000Z'), maxBytes: 700, keepFiles: -1 })
    log.record({ ...ROW, by: 'timeout', n: 1 })
    log.clear('page')
    assert.equal(log.missedCount, 0)

    // Force several rotations so the watermark's own row is definitely archived.
    for (let i = 0; i < 40; i += 1) log.record({ ...ROW, by: 'api', n: 100 + i, pad: 'z'.repeat(60) })
    assert.ok(archivesIn(dir).length > 0, 'rotation actually happened')
    const live = readFileSync(join(dir, 'storages', 'dsh-plugin-remote-use', 'audit.jsonl'), 'utf8')
    assert.match(live, /approvals-cleared/, 'the watermark is present in the live file')
    assert.match(live, /"carried":true/, 'and it is marked as carried')

    const reopened = new AuditLog({ env })
    assert.equal(reopened.missedCount, 0, 'a restart after a rotation does NOT resurrect the misses')
    assert.deepEqual(reopened.missed(), [])
  })
})

test('rotation can be switched off, and then nothing is ever moved or deleted', () => {
  withHome((env, dir) => {
    const log = new AuditLog({ env, now: () => Date.parse('2026-10-15T03:00:00.000Z'), maxBytes: 0, keepFiles: 0 })
    for (let i = 0; i < 40; i += 1) log.record({ ...ROW, by: 'api', n: i, pad: 'q'.repeat(80) })
    assert.deepEqual(archivesIn(dir), [], 'no archive is created when rotation is off')
    assert.ok(log.bytes > 600, 'and the live file is allowed to grow past what would have been the cap')
  })
})

test('a rotation failure is REPORTED, never thrown into the approval path', () => {
  // Same contract as every other write here: an audit trail must not be able to veto an approval.
  withHome((env) => {
    const log = new AuditLog({ env, now: () => Date.parse('2026-10-15T03:00:00.000Z'), maxBytes: 1 })
    // maxBytes: 1 means EVERY write wants to rotate; the first has no file yet, so it writes, and
    // the second must handle the rotate. Whichever way the filesystem goes, record() must not throw.
    assert.equal(log.record({ ...ROW, by: 'api', n: 1 }), true)
    assert.equal(log.record({ ...ROW, by: 'api', n: 2 }), true)
  })
})
