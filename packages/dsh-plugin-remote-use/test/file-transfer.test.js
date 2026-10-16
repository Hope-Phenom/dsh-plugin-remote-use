/**
 * Tests for the worker's file-transfer core (`slave/file-transfer.mjs`).
 *
 * This module is what decides, on someone else's machine, which path gets written, whether a `.part`
 * is allowed to become the real file, and what happens to a resume point when a transfer dies. The
 * relay itself cannot be imported by a test -- it binds a port at module scope and exits without a
 * token -- so the rules are tested HERE, for real, and the few lines that exist only in the relay (the
 * routes, the flag, the RPC names) are asserted against its source as wiring guards at the bottom.
 *
 * Every case below is a behaviour that would be a data-loss bug if it flipped: publishing a file that
 * failed verification, deleting a target when asked to drop a staging file, or answering `200` for a
 * chunk that was never written.
 */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_TRANSFER_BYTES,
  PART_SUFFIX,
  commitPart,
  deletePart,
  listDir,
  maxTransferBytesOf,
  partPathFor,
  putChunk,
  rangeOf,
  readJsonBody,
  resolveTransferPath,
  sha256File,
  statTarget,
} from '../slave/file-transfer.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Async-aware: the module's whole surface is promises, so a sync `finally` would clean up too early. */
async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'file-transfer-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Drive one `PUT` the way the master does: a body stream plus a declared length. */
function put(target, buffer, offset, extra = {}) {
  return putChunk({
    target,
    offset,
    contentLength: buffer.length,
    body: Readable.from([buffer]),
    maxBytes: DEFAULT_MAX_TRANSFER_BYTES,
    ...extra,
  })
}

// ---------------------------------------------------------------------------
// path resolution
// ---------------------------------------------------------------------------

test('a relative path resolves against the task directory', () => {
  withDir((dir) => {
    assert.equal(resolveTransferPath('outbox/report.txt', dir).path, join(dir, 'outbox', 'report.txt'))
    // `.` is the task directory itself, which is what a caller that wants to list it sends.
    assert.equal(resolveTransferPath('.', dir).path, resolve(dir))
  })
})

test('an absolute path is used as it stands, not rebased under the task directory', () => {
  withDir((dir) => {
    const absolute = join(dir, 'elsewhere', 'file.bin')
    const resolved = resolveTransferPath(absolute, join(dir, 'task'))
    assert.equal(resolved.path, absolute)
    assert.equal(resolved.ok, true)
  })
})

test('there is no cage: `..` is resolved, not refused', () => {
  withDir((dir) => {
    // Deliberate. A relay is not a sandbox -- the same token can ask this process to run a command
    // through ACP -- so a fake cage would block real deployments (`D:\build`) while stopping nothing.
    // What replaces it is the echo: the resolved path comes back in every response and log line.
    const resolved = resolveTransferPath('../outside.txt', dir)
    assert.equal(resolved.ok, true)
    assert.equal(resolved.path, resolve(dir, '../outside.txt'))
  })
})

test('an empty, whitespace-only, non-string or NUL path is refused', () => {
  withDir((dir) => {
    for (const bad of ['', '   ', '\t', undefined, null, 42, {}, [], 'a\u0000b', '\u0000']) {
      const resolved = resolveTransferPath(bad, dir)
      assert.equal(resolved.ok, false, `${JSON.stringify(bad)} must be refused`)
      assert.equal(typeof resolved.error, 'string')
    }
    // The two messages are distinguishable, because "you sent nothing" and "you sent a NUL" lead to
    // different fixes on the calling side.
    assert.match(resolveTransferPath('', dir).error, /required/u)
    assert.match(resolveTransferPath('a\u0000b', dir).error, /NUL/u)
  })
})

test('the part path is a sibling of the target, which is what makes the rename atomic', () => {
  const target = join('D:', 'build', 'app.exe')
  assert.equal(partPathFor(target), `${target}${PART_SUFFIX}`)
  assert.equal(dirname(partPathFor(target)), dirname(target))
})

// ---------------------------------------------------------------------------
// the ceiling
// ---------------------------------------------------------------------------

test('an unusable --max-transfer-bytes keeps the default ceiling instead of removing it', () => {
  // `0` reads as "no limit" to the person typing it and as "reject every byte" to the code. Removing
  // the ceiling here would be the unsafe direction: the disk is on a machine nobody is sitting at.
  for (const bad of [undefined, null, 0, -1, NaN, Infinity, -Infinity, '64', '']) {
    assert.equal(maxTransferBytesOf(bad), DEFAULT_MAX_TRANSFER_BYTES, `${String(bad)} must not remove the ceiling`)
  }
  assert.equal(maxTransferBytesOf(1024), 1024)
  assert.equal(maxTransferBytesOf(1024.7), 1024, 'a fractional byte count is not a byte count')
  assert.equal(DEFAULT_MAX_TRANSFER_BYTES, 8 * 1024 * 1024 * 1024)
})

// ---------------------------------------------------------------------------
// range maths
// ---------------------------------------------------------------------------

test('offset 0 and an absent offset both mean the whole file, with 200', () => {
  for (const offset of [undefined, null, '', 0, '0']) {
    const range = rangeOf(100, offset)
    assert.equal(range.ok, true, `offset=${String(offset)}`)
    assert.equal(range.status, 200)
    assert.equal(range.offset, 0)
    assert.equal(range.length, 100)
    assert.equal(range.contentRange, undefined, '200 carries no content-range')
  }
})

test('an offset inside the file answers 206 with the tail and an inclusive content-range', () => {
  const range = rangeOf(100, 30)
  assert.equal(range.status, 206)
  assert.equal(range.offset, 30)
  assert.equal(range.length, 70, 'content-length is the length of THIS body, not the file')
  assert.equal(range.contentRange, 'bytes 30-99/100')
  // One byte from the end: the arithmetic that catches an off-by-one in the range header.
  assert.equal(rangeOf(100, 99).contentRange, 'bytes 99-99/100')
  assert.equal(rangeOf(100, 99).length, 1)
})

test('an offset at or past the end is 416, and an empty file at offset 0 is still 200', () => {
  for (const [size, offset] of [[100, 100], [100, 101], [100, 1e9], [0, 1], [0, 5]]) {
    const range = rangeOf(size, offset)
    assert.equal(range.ok, false, `size=${size} offset=${offset}`)
    assert.equal(range.status, 416)
  }
  // The literal reading of "offset >= size -> 416" would make an empty file undownloadable, which is
  // a real file an operator may well have just created.
  const empty = rangeOf(0, 0)
  assert.equal(empty.status, 200)
  assert.equal(empty.length, 0)
})

test('a negative, fractional or non-numeric offset is a 400, not a 416', () => {
  // 416 says "you asked for a position past the end", which is a different and misleading answer to
  // a caller that sent a value that is not a byte position at all. `[]` and `true` are in the list
  // because coercing them would make them 0 and 1, i.e. a silent restart from the beginning.
  for (const bad of [-1, 1.5, 'abc', ' ', '1e3', {}, [], true]) {
    const range = rangeOf(100, bad)
    assert.equal(range.ok, false, `${JSON.stringify(bad)}`)
    assert.equal(range.status, 400, `${JSON.stringify(bad)}`)
  }
})

// ---------------------------------------------------------------------------
// hashing
// ---------------------------------------------------------------------------

test('sha256File matches a one-shot digest over a file larger than one stream chunk', async () => {
  await withDir(async (dir) => {
    // Big enough to arrive as many chunks, which is the case a hand-rolled reader gets wrong by
    // forgetting that a chunk boundary and the file end are different events.
    const bytes = Buffer.alloc(1024 * 1024 + 7, 0x5A)
    const path = join(dir, 'big.bin')
    writeFileSync(path, bytes)
    const result = await sha256File(path)
    assert.equal(result.sha256, sha256Of(bytes))
    assert.equal(result.bytes, bytes.length)
  })
})

test('an empty file hashes to the digest of no bytes rather than throwing', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'empty.bin')
    writeFileSync(path, Buffer.alloc(0))
    assert.deepEqual(await sha256File(path), { sha256: sha256Of(Buffer.alloc(0)), bytes: 0 })
  })
})

test('a missing file rejects instead of hashing nothing', async () => {
  await withDir(async (dir) => {
    await assert.rejects(() => sha256File(join(dir, 'nope.bin')), /ENOENT/u)
  })
})

// ---------------------------------------------------------------------------
// PUT: staging a chunk
// ---------------------------------------------------------------------------

test('a first chunk lands in .part and reports where the transfer now stands', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'file.bin')
    const first = Buffer.from('hello ')
    const result = await put(target, first, 0)
    assert.equal(result.ok, true)
    assert.equal(result.status, 200)
    assert.equal(result.json.path, target)
    assert.equal(result.json.part, partPathFor(target))
    assert.equal(result.json.offset, 0)
    assert.equal(result.json.received, first.length)
    assert.equal(result.json.partBytes, first.length)
    // The real name must NOT exist yet: that is the entire reason for the staging file.
    assert.equal(statSync(partPathFor(target)).size, first.length)
    assert.throws(() => statSync(target), /ENOENT/u)
  })
})

test('a second chunk appends at the offset the first one ended at', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'file.bin')
    const first = Buffer.from('hello ')
    const second = Buffer.from('world')
    await put(target, first, 0)
    const result = await put(target, second, first.length)
    assert.equal(result.json.offset, first.length)
    assert.equal(result.json.received, second.length)
    assert.equal(result.json.partBytes, first.length + second.length)
    assert.equal(readFileSync(partPathFor(target), 'utf8'), 'hello world')
  })
})

test('a chunk at the wrong offset is 409 with the offset the part actually holds', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'file.bin')
    await put(target, Buffer.from('12345678'), 0)
    const stray = Buffer.from('XX')
    const result = await put(target, stray, 3)
    assert.equal(result.ok, false)
    assert.equal(result.status, 409)
    // This number is the whole point of the 409: it is what lets the master resume instead of
    // restarting, and it is neither the old size nor the requested offset.
    assert.equal(result.json.expectedOffset, 8)
    assert.equal(readFileSync(partPathFor(target), 'utf8'), '12345678', 'a refused chunk must write nothing')
  })
})

test('the same offset twice is refused rather than silently overwriting the staged bytes', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'file.bin')
    await put(target, Buffer.from('aaaa'), 0)
    // offset 0 against an 8-byte part is the shape of a retried first chunk. Accepting it would
    // rewrite the prefix and leave a file whose two halves came from different attempts.
    const result = await put(target, Buffer.from('bbbb'), 0)
    assert.equal(result.status, 409)
    assert.equal(result.json.expectedOffset, 4)
    assert.equal(readFileSync(partPathFor(target), 'utf8'), 'aaaa')
  })
})

test('a PUT without a content-length is 411 and writes nothing', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'file.bin')
    for (const contentLength of [undefined, null, 'chunked', 'abc', NaN]) {
      const result = await putChunk({
        target, offset: 0, contentLength, body: Readable.from([Buffer.from('x')]),
        maxBytes: DEFAULT_MAX_TRANSFER_BYTES,
      })
      assert.equal(result.status, 411, `contentLength=${String(contentLength)}`)
    }
    assert.throws(() => statSync(partPathFor(target)), /ENOENT/u, 'a refused PUT must leave no trace')
  })
})

test('a chunk that would cross the ceiling is 413 before anything is written', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'file.bin')
    const result = await put(target, Buffer.alloc(11), 0, { maxBytes: 10 })
    assert.equal(result.status, 413)
    assert.equal(result.json.limit, 10)
    assert.throws(() => statSync(partPathFor(target)), /ENOENT/u)
  })
})

test('the ceiling counts the whole file, so a resume cannot walk past it either', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'file.bin')
    await put(target, Buffer.alloc(8), 0, { maxBytes: 10 })
    // 8 + 5 > 10 even though this chunk is only 5 bytes. Checking the chunk alone would let any
    // number of 10-byte chunks through.
    const result = await put(target, Buffer.alloc(5), 8, { maxBytes: 10 })
    assert.equal(result.status, 413)
    assert.equal(statSync(partPathFor(target)).size, 8)
  })
})

test('an interrupted chunk keeps .part, because those bytes are the resume point', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'file.bin')
    const first = Buffer.from('partial-bytes')
    const body = new Readable({ read() { /* pushed below, never ended */ } })
    body.push(first)
    // A real disconnect, with enough delay for the write to reach the disk before the error lands --
    // the same order of events a dropped TCP connection produces.
    setTimeout(() => body.destroy(new Error('client went away')), 50)

    const result = await putChunk({
      target, offset: 0, contentLength: 1000, body, maxBytes: DEFAULT_MAX_TRANSFER_BYTES,
    })
    assert.equal(result.ok, false)
    assert.equal(result.aborted, true)
    assert.match(result.json.error, /client went away/u)
    assert.equal(statSync(partPathFor(target)).size, first.length)
    assert.throws(() => statSync(target), /ENOENT/u)
  })
})

test('an upload can be resumed after the interruption and then committed', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'report.txt')
    const whole = Buffer.from('the quick brown fox jumps over the lazy dog')
    await put(target, whole.subarray(0, 20), 0)

    // Exactly what the master does with the 409 it gets: re-align on `expectedOffset` and continue.
    const stray = await put(target, whole.subarray(20), 10)
    assert.equal(stray.json.expectedOffset, 20)
    await put(target, whole.subarray(20), stray.json.expectedOffset)

    const committed = await commitPart({ target, sha256: sha256Of(whole), size: whole.length })
    assert.equal(committed.ok, true)
    assert.equal(readFileSync(target, 'utf8'), whole.toString('utf8'))
    assert.throws(() => statSync(partPathFor(target)), /ENOENT/u)
  })
})

// ---------------------------------------------------------------------------
// commit: the only step that can publish a file
// ---------------------------------------------------------------------------

test('a verified part is fsynced, renamed onto the target and reported', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'out.bin')
    const bytes = Buffer.from('verified bytes')
    writeFileSync(partPathFor(target), bytes)

    const result = await commitPart({ target, sha256: sha256Of(bytes), size: bytes.length })
    assert.equal(result.ok, true)
    assert.equal(result.status, 200)
    assert.equal(result.json.path, target)
    assert.equal(result.json.bytes, bytes.length)
    assert.equal(result.json.sha256, sha256Of(bytes))
    assert.equal(Number.isFinite(Date.parse(result.json.mtime)), true, 'mtime must be an ISO timestamp')
    assert.equal(readFileSync(target, 'utf8'), bytes.toString('utf8'))
    assert.throws(() => statSync(partPathFor(target)), /ENOENT/u, 'the staging name must be gone')
  })
})

test('the digest is recomputed from the disk, so a caller cannot vouch for bytes it never sent', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'out.bin')
    writeFileSync(partPathFor(target), Buffer.from('what actually arrived'))
    const result = await commitPart({
      target,
      sha256: sha256Of(Buffer.from('what the master intended to send')),
      size: 26,
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 400)
    // `expected` is what the request claimed and `actual` is what this disk holds. Both are needed:
    // the difference IS the diagnosis.
    assert.equal(result.json.expected, sha256Of(Buffer.from('what the master intended to send')))
    assert.equal(result.json.actual, sha256Of(Buffer.from('what actually arrived')))
    // Keeping the part is what makes the retry a resume rather than a re-upload.
    assert.equal(readFileSync(partPathFor(target), 'utf8'), 'what actually arrived')
    assert.throws(() => statSync(target), /ENOENT/u, 'a failed verification must never publish')
  })
})

test('a short part is reported with both sizes, because truncation is the usual cause', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'out.bin')
    writeFileSync(partPathFor(target), Buffer.alloc(10))
    const result = await commitPart({ target, sha256: sha256Of(Buffer.alloc(20)), size: 20 })
    assert.equal(result.status, 400)
    assert.match(result.json.error, /20 bytes, .* holds 10/u)
  })
})

test('a size that disagrees while the digest agrees is refused', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'out.bin')
    const bytes = Buffer.from('12345678')
    writeFileSync(partPathFor(target), bytes)
    const result = await commitPart({ target, sha256: sha256Of(bytes), size: 99 })
    assert.equal(result.status, 400)
    assert.equal(result.json.expected, 99)
    assert.equal(result.json.actual, 8)
    assert.throws(() => statSync(target), /ENOENT/u)
  })
})

test('a commit without a sha256 is refused: it is the only evidence there is', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'out.bin')
    writeFileSync(partPathFor(target), Buffer.from('x'))
    for (const sha256 of [undefined, null, '', '   ', 42]) {
      const result = await commitPart({ target, sha256, size: 1 })
      assert.equal(result.status, 400, `sha256=${String(sha256)}`)
    }
    assert.equal(statSync(partPathFor(target)).size, 1, 'nothing may be published on a malformed request')
  })
})

test('an upper-case digest is accepted: hex case is not a property of the bytes', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'out.bin')
    const bytes = Buffer.from('case')
    writeFileSync(partPathFor(target), bytes)
    const result = await commitPart({ target, sha256: sha256Of(bytes).toUpperCase(), size: bytes.length })
    assert.equal(result.ok, true)
  })
})

test('a commit with no staged part is 404 and names the path it looked at', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'never-uploaded.bin')
    const result = await commitPart({ target, sha256: sha256Of(Buffer.alloc(0)), size: 0 })
    assert.equal(result.status, 404)
    assert.equal(result.json.part, partPathFor(target))
    assert.throws(() => statSync(target), /ENOENT/u)
  })
})

test('an existing target is refused without overwrite, and the staged part survives the refusal', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'existing.txt')
    writeFileSync(target, 'the original')
    const bytes = Buffer.from('the replacement')
    writeFileSync(partPathFor(target), bytes)

    const result = await commitPart({ target, sha256: sha256Of(bytes), size: bytes.length })
    assert.equal(result.ok, false)
    assert.equal(result.status, 409)
    // Silently overwriting is the data-loss class this refusal exists for.
    assert.equal(readFileSync(target, 'utf8'), 'the original')
    assert.equal(readFileSync(partPathFor(target), 'utf8'), 'the replacement')
  })
})

test('overwrite: true replaces an existing target', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'existing.txt')
    writeFileSync(target, 'the original')
    const bytes = Buffer.from('the replacement')
    writeFileSync(partPathFor(target), bytes)

    const result = await commitPart({ target, sha256: sha256Of(bytes), size: bytes.length, overwrite: true })
    assert.equal(result.ok, true)
    assert.equal(readFileSync(target, 'utf8'), 'the replacement')
    assert.throws(() => statSync(partPathFor(target)), /ENOENT/u)
  })
})

test('a directory at the target path is 409 whatever overwrite says', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'a-directory')
    mkdirSync(target)
    const bytes = Buffer.from('x')
    writeFileSync(partPathFor(target), bytes)
    const result = await commitPart({ target, sha256: sha256Of(bytes), size: 1, overwrite: true })
    assert.equal(result.status, 409)
    assert.equal(statSync(target).isDirectory(), true)
  })
})

test('a failed commit can be retried with the corrected digest', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'retry.bin')
    const bytes = Buffer.from('retry me')
    writeFileSync(partPathFor(target), bytes)
    assert.equal((await commitPart({ target, sha256: sha256Of(Buffer.from('wrong')) })).status, 400)
    // Nothing was thrown away by the first failure.
    assert.equal((await commitPart({ target, sha256: sha256Of(bytes), size: bytes.length })).ok, true)
    assert.equal(readFileSync(target, 'utf8'), 'retry me')
  })
})

// ---------------------------------------------------------------------------
// DELETE: staging only
// ---------------------------------------------------------------------------

test('DELETE removes the .part and never the target', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'keep-me.txt')
    writeFileSync(target, 'published')
    writeFileSync(partPathFor(target), 'half a transfer')

    const result = await deletePart(target)
    assert.equal(result.status, 200)
    assert.equal(result.json.removed, true)
    assert.equal(result.json.part, partPathFor(target))
    assert.throws(() => statSync(partPathFor(target)), /ENOENT/u)
    // The one guarantee that makes "cancel" safe to offer at all.
    assert.equal(readFileSync(target, 'utf8'), 'published')
  })
})

test('DELETE with nothing staged is a success that says so', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'nothing.txt')
    writeFileSync(target, 'published')
    const result = await deletePart(target)
    assert.equal(result.ok, true)
    assert.equal(result.json.removed, false)
    assert.equal(readFileSync(target, 'utf8'), 'published')
  })
})

// ---------------------------------------------------------------------------
// stat and list
// ---------------------------------------------------------------------------

test('statTarget describes a file without hashing it unless asked', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'file.bin')
    const bytes = Buffer.from('stat me')
    writeFileSync(path, bytes)

    const plain = await statTarget(path)
    assert.equal(plain.exists, true)
    assert.equal(plain.isDir, false)
    assert.equal(plain.size, bytes.length)
    assert.equal(Number.isFinite(Date.parse(plain.mtime)), true)
    // Absent, not null: hashing reads every byte, and `stat` is what the master asks before it
    // decides whether to transfer anything at all.
    assert.equal('sha256' in plain, false)

    const hashed = await statTarget(path, { hash: true })
    assert.equal(hashed.sha256, sha256Of(bytes))
  })
})

test('statTarget reports a missing path as an answer, not an error', async () => {
  await withDir(async (dir) => {
    const missing = await statTarget(join(dir, 'nope.bin'))
    assert.deepEqual(missing, { exists: false, isDir: false, size: 0, mtime: null })
    // A directory has no meaningful size; reporting a block count would read as a real number the
    // caller then compares against a byte budget.
    mkdirSync(join(dir, 'sub'))
    const sub = await statTarget(join(dir, 'sub'), { hash: true })
    assert.deepEqual(sub, { exists: true, isDir: true, size: 0, mtime: sub.mtime })
    assert.equal('sha256' in sub, false, 'a directory must not be hashed')
    // A file used as a directory component is ENOTDIR, which is also "not there" rather than a throw.
    assert.equal((await statTarget(join(dir, 'file.bin', 'child'))).exists, false)
  })
})

test('listDir returns sorted entries with kind, size and mtime', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'b.txt'), 'bb')
    writeFileSync(join(dir, 'a.txt'), 'a')
    mkdirSync(join(dir, 'c-dir'))

    const listed = await listDir(dir)
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.entries.map((e) => e.name), ['a.txt', 'b.txt', 'c-dir'])
    assert.deepEqual(listed.entries.map((e) => e.isDir), [false, false, true])
    assert.deepEqual(listed.entries.map((e) => e.size), [1, 2, 0])
    for (const entry of listed.entries) assert.equal(Number.isFinite(Date.parse(entry.mtime)), true)
    assert.equal(listed.truncated, false)
  })
})

test('a limit truncates the listing and says that it did', async () => {
  await withDir((dir) => {
    for (const name of ['d', 'c', 'b', 'a']) writeFileSync(join(dir, name), 'x')
    return (async () => {
      const limited = await listDir(dir, { limit: 2 })
      assert.deepEqual(limited.entries.map((e) => e.name), ['a', 'b'], 'sorted before truncating')
      assert.equal(limited.truncated, true)
      // A limit of 0 is a caller asking "just tell me whether anything is in there" -- and `truncated`
      // is the answer, not an empty directory.
      const none = await listDir(dir, { limit: 0 })
      assert.deepEqual(none.entries, [])
      assert.equal(none.truncated, true)
      const all = await listDir(dir, { limit: 99 })
      assert.equal(all.entries.length, 4)
      assert.equal(all.truncated, false)
      assert.equal(DEFAULT_LIST_LIMIT, 1000)
    })()
  })
})

test('listing something that is not a directory is refused rather than reported as empty', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'a-file.txt'), 'x')
    const missing = await listDir(join(dir, 'no-such-dir'))
    assert.equal(missing.ok, false)
    assert.equal(missing.status, 404)
    // "There is nothing there" and "that is a file" lead an operator to opposite conclusions.
    const notADir = await listDir(join(dir, 'a-file.txt'))
    assert.equal(notADir.ok, false)
    assert.equal(notADir.status, 404)
  })
})

// ---------------------------------------------------------------------------
// JSON bodies
// ---------------------------------------------------------------------------

test('readJsonBody reassembles a body split across chunks', async () => {
  // Three chunks with a JSON string split mid-token: a reader that parsed per chunk would fail here
  // and nowhere else, and a real socket splits a body wherever it likes.
  const body = Readable.from([
    Buffer.from('{"path":"a'),
    Buffer.from('.txt","si'),
    Buffer.from('ze":3}'),
  ])
  const parsed = await readJsonBody(body)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.value, { path: 'a.txt', size: 3 })
})

test('a body that is not a JSON object is a 400', async () => {
  for (const [text, why] of [['not json', 'unparseable'], ['[1,2]', 'an array'], ['42', 'a scalar'], ['null', 'null'], ['', 'empty'], ['   ', 'blank']]) {
    const parsed = await readJsonBody(Readable.from([Buffer.from(text)]))
    assert.equal(parsed.ok, false, why)
    assert.equal(parsed.status, 400, why)
    assert.equal(typeof parsed.json.error, 'string')
  }
})

test('an oversized body is refused while it is arriving, not after', async () => {
  const big = JSON.stringify({ path: 'x'.repeat(5000) })
  const parsed = await readJsonBody(Readable.from([Buffer.from(big)]), { limitBytes: 1024 })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.status, 413)
  assert.equal(parsed.json.limit, 1024)
})

// ---------------------------------------------------------------------------
// The relay's wiring
//
// `slave/relay.mjs` starts listening on a port at module scope, so it cannot be imported here. The
// rules above are tested for real; what is asserted below is only that the relay actually calls them
// and exposes them under the names the master uses.
// ---------------------------------------------------------------------------

test('the relay imports the transfer core and exposes the endpoints and RPCs', () => {
  const relay = readFileSync(join(PKG_ROOT, 'slave', 'relay.mjs'), 'utf8')

  assert.match(relay, /from '\.\/file-transfer\.mjs'/u, 'the relay must import the transfer core')

  // The flag, in the Usage block and read with the same `arg()` helper as every other option.
  assert.match(relay, /\[--max-transfer-bytes <n>\]/u, 'the Usage block must list the new flag')
  assert.match(relay, /maxTransferBytesOf\(Number\(arg\('max-transfer-bytes'/u,
    'the relay must read --max-transfer-bytes through the bounded reader')

  // The four endpoints, by path, plus the two RPCs built from the prefix constant so a rename cannot
  // leave a hardcoded method name behind that the master then fails to call.
  assert.match(relay, /url\.pathname === '\/file'/u, '/file must be routed')
  assert.match(relay, /url\.pathname === '\/file\/commit'/u, '/file/commit must be routed')
  assert.match(relay, /case `\$\{PLUGIN_PREFIX\}stat`: \{/u, 'dsh-remote/stat must be handled locally')
  assert.match(relay, /case `\$\{PLUGIN_PREFIX\}list`: \{/u, 'dsh-remote/list must be handled locally')

  // The write path is a stream and a hash, never a buffer: the two calls that would each have to be
  // undone to satisfy the module's own rule, asserted where they are used rather than in the module.
  assert.match(relay, /commitPart\(/u, 'the commit route must call the verified rename')
  assert.match(relay, /putChunk\(/u, 'the PUT route must call the staging writer')
  assert.match(relay, /sha256File\(resolved\.path\)/u, 'the download route must hash the file it serves')
  assert.match(relay, /createReadStream\(resolved\.path/u, 'the download route must stream the body')
})

test('the deployment manifest carries the new sibling module', () => {
  // The worker gets its files by explicit name, so a module the relay imports but the deployment does
  // not copy produces a relay that dies with ERR_MODULE_NOT_FOUND -- a symptom indistinguishable
  // from "the worker is unreachable".
  const deploy = readFileSync(join(PKG_ROOT, '..', '..', 'tools', 'deploy-slave.ps1'), 'utf8')
  assert.ok(deploy.includes("'file-transfer.mjs'"), 'file-transfer.mjs must be in the deployment $files list')
})

test('the transfer core never reads a whole file into memory', () => {
  // The constraint this module exists under, asserted as the absence of the calls that would break
  // it. `/screenshot` does `readFileSync` on a ~9.5 MB PNG and that is explicitly NOT acceptable
  // here: an 8 GiB transfer would be 8 GiB of resident memory plus a concatenation, which is an
  // out-of-memory kill on a worker nobody is watching.
  const source = readFileSync(join(PKG_ROOT, 'slave', 'file-transfer.mjs'), 'utf8')
    // Comments legitimately NAME the forbidden call (the module header explains why it is not used),
    // so the guard reads the code, the same way the patch guards read bodies rather than files.
    .split('\n')
    .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/u.test(line))
    .join('\n')
  for (const forbidden of ['readFileSync', 'readFile(', 'readFileSync(', 'Buffer.concat']) {
    assert.equal(source.includes(forbidden), false, `${forbidden} would make the memory ceiling a function of the file size`)
  }
  assert.match(source, /createReadStream/u, 'hashing must stream')
  assert.match(source, /for await \(const chunk of createReadStream/u, 'the hash must be fed chunk by chunk')
})
