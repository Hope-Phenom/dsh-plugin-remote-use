/**
 * Tests for the audit log.
 *
 * Two properties matter and they pull against each other: the trail must survive (append
 * only, readable after a restart), and it must never be able to veto the operation it is
 * observing. Both are asserted directly.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('a missing file is the normal starting state', () => {
  withHome((env) => {
    assert.equal(existsSync(auditPath(env)), false)
    const log = new AuditLog({ env })
    assert.equal(log.size, 0)
    assert.equal(log.lastError, '')
    assert.deepEqual(log.tail(), [])
  })
})
