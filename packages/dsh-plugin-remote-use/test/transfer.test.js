// Tests for the streaming transfer core.
//
// WHERE THE ASSERTIONS POINT, AND WHY: the two properties this module exists for are "a file is
// never buffered whole" and "the destination path is never half-written", and neither is visible in
// a result object. So the tests read them off the WIRE instead: `bodyIsStream`, one request per
// 4 MiB slice, `content-length` per slice, `offset=` on every URL. A fake channel is what makes that
// observable -- through a real socket the request shapes are gone by the time a test could look.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_TRANSFER_MAX_BYTES,
  TRANSFER_CHUNK_BYTES,
  TransferError,
  abortTransfer,
  createHasher,
  defaultReceiveDir,
  downloadFile,
  listFiles,
  partPathFor,
  statFile,
  transfersDir,
  uploadFile,
} from '../lib/core/transfer.js'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** A temp directory that removes itself when the test ends, so a failing case cannot litter. */
function scratch(t, prefix = 'dsh-xfer-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Deterministic bytes. Pseudo-random rather than a constant, so an offset bug cannot pass by luck. */
function bytes(size) {
  const buf = Buffer.allocUnsafe(size)
  let x = 123456789
  for (let i = 0; i < size; i += 1) {
    x = (1103515245 * x + 12345) & 0x7fffffff
    buf[i] = x & 0xff
  }
  return buf
}

function jsonRes(status, obj) {
  const text = JSON.stringify(obj)
  return {
    status,
    headers: new Headers(),
    async text() { return text },
    async json() { return obj },
  }
}

/**
 * A response whose body is a REAL web stream.
 *
 * Deliberately not a Buffer with an `arrayBuffer()` method: the point of the download tests is that
 * `Readable.fromWeb(res.body)` is fed a stream, and a fake that returns bytes directly would pass
 * even if the production path concatenated everything into one buffer first.
 */
function streamRes(status, buf, headers = {}) {
  return {
    status,
    headers: new Headers(headers),
    body: Readable.toWeb(Readable.from([buf])),
    async text() { return '' },
  }
}

/**
 * A receiver: the worker side of the protocol, small enough to read in one sitting.
 *
 * It is deliberately a real implementation of the `.part` rules rather than a canned script, because
 * the upload tests need to assert on the BYTES the worker ended up holding -- the whole contract is
 * about that file being right, not about the sequence of requests being pretty.
 */
function newReceiver(opts = {}) {
  const state = {
    /** @type {Buffer | null} */
    part: opts.part ?? null,
    /** @type {Buffer | null} */
    target: opts.target ?? null,
    exists: opts.exists === true,
    puts: [],
    gets: [],
    commits: [],
    deletes: [],
    heads: [],
    failNextPut: 0,
    /**
     * Answer the FIRST PUT with a `409` whose `expectedOffset` is this value, whatever the request.
     *
     * A test needs to produce the state the receiver reaches on its own after a lost commit -- it
     * already holds the whole file -- and it cannot get there by replaying successful PUTs, because a
     * previous attempt's slices are exactly what the receiver keeps but the test has no way to install.
     */
    denyFirstPutExpectedOffset: opts.denyFirstPutExpectedOffset,
    deniedPuts: 0,
  }
  const remoteText = opts.remoteText ?? 'remote contents'
  const remoteBuf = Buffer.from(remoteText)
  const remoteHash = opts.remoteSha256 === undefined ? sha256(remoteBuf) : opts.remoteSha256
  const remoteSize = opts.remoteSize === undefined ? remoteBuf.length : opts.remoteSize

  const channel = {
    base: 'http://worker:7331',
    authHeaders: () => (opts.token === undefined ? { authorization: 'Bearer tok' } : opts.token),
    async head(url, init) {
      state.heads.push({ url, headers: init.headers })
      return { status: 200, headers: new Headers({ 'x-file-size': String(remoteSize) }) }
    },
    async put(url, init) {
      const offset = Number(new URL(url).searchParams.get('offset'))
      // Read the request body exactly as the wire would deliver it.
      const chunks = []
      for await (const chunk of init.body) chunks.push(chunk)
      const buf = Buffer.concat(chunks)
      const call = {
        url, offset, length: buf.length,
        contentLength: init.headers['content-length'],
        authorization: init.headers.authorization,
        duplex: init.duplex,
        bodyIsStream: typeof init.body?.pipe === 'function' && Buffer.isBuffer(init.body) === false,
      }
      state.puts.push(call)
      if (state.failNextPut > 0) {
        state.failNextPut -= 1
        return jsonRes(409, { ok: false, error: 'offset mismatch', expectedOffset: state.part === null ? 0 : state.part.length })
      }
      if (state.denyFirstPutExpectedOffset !== undefined && state.deniedPuts === 0) {
        state.deniedPuts += 1
        return jsonRes(409, { ok: false, error: 'offset mismatch', expectedOffset: state.denyFirstPutExpectedOffset })
      }
      const have = state.part === null ? 0 : state.part.length
      if (have !== offset) {
        return jsonRes(409, { ok: false, error: 'offset mismatch', expectedOffset: have })
      }
      state.part = state.part === null ? buf : Buffer.concat([state.part, buf])
      return jsonRes(200, { ok: true, path: '/d/remote.bin', part: '/d/remote.bin.part', offset, received: buf.length, partBytes: state.part.length })
    },
    async post(url, init) {
      const body = JSON.parse(init.body)
      state.commits.push({ url, body, contentType: init.headers['content-type'] })
      if (opts.commitFails === true) return jsonRes(503, { ok: false, error: 'not now' })
      const held = state.part ?? Buffer.alloc(0)
      const actual = sha256(held)
      if (opts.commitMismatch === true || actual !== body.sha256) {
        return jsonRes(400, { ok: false, error: 'sha256 mismatch', expected: body.sha256, actual })
      }
      if (state.exists && body.overwrite !== true) {
        return jsonRes(409, { ok: false, error: 'target exists' })
      }
      state.target = held
      state.part = null
      state.exists = true
      return jsonRes(200, { ok: true, path: '/d/remote.bin', bytes: held.length, sha256: actual, mtime: '2026-10-15T00:00:00.000Z' })
    },
    async get(url) {
      const offset = Number(new URL(url).searchParams.get('offset') ?? 0)
      state.gets.push({ url, offset, authorization: opts.getAuth === undefined ? 'Bearer tok' : opts.getAuth })
      if (opts.shortenRemoteBy !== undefined) {
        // Simulates the remote file being replaced by the checksum used below.
        return streamRes(200, remoteBuf.subarray(0, remoteBuf.length - opts.shortenRemoteBy), {
          'x-file-size': String(remoteSize),
          'x-file-sha256': remoteHash,
        })
      }
      if (offset > remoteBuf.length) {
        return jsonRes(416, { ok: false, error: 'offset beyond the file' })
      }
      const tail = remoteBuf.subarray(offset)
      return streamRes(offset > 0 ? 206 : 200, tail, {
        'x-file-size': String(remoteSize),
        'x-file-sha256': remoteHash,
        'x-file-path': '/abs/remote.bin',
        'x-file-mtime': '2026-10-15T00:00:00.000Z',
      })
    },
    async del(url) {
      state.deletes.push({ url })
      const had = state.part !== null
      state.part = null
      return jsonRes(200, { ok: true, removed: had, part: '/d/remote.bin.part' })
    },
  }
  return { channel, state, remoteBuf, remoteHash, remoteSize }
}

// ---------------------------------------------------------------------------
// module surface
// ---------------------------------------------------------------------------

test('the chunk size is 4 MiB and the default ceiling is the worker-side 8 GiB', () => {
  // Pinned as literals because BOTH ends implement this contract in parallel: a change here that is
  // not a change there is a transfer that dies at 200 MiB with a 413 nobody expected.
  assert.equal(TRANSFER_CHUNK_BYTES, 4 * 1024 * 1024)
  assert.equal(DEFAULT_TRANSFER_MAX_BYTES, 8 * 1024 * 1024 * 1024)
})

test('transfers and the receive directory live under DSH_HOME, not in temp', () => {
  // The screenshot cache is prunable because its files are automatic. A received file is what the
  // operator asked for, so a change that moved it into the temp directory would hand it to every
  // temp cleaner on the machine.
  const env = { DSH_HOME: join('C:', 'dsh-home') }
  assert.equal(transfersDir(env), join('C:', 'dsh-home', 'storages', 'dsh-plugin-remote-use', 'transfers'))
  assert.equal(defaultReceiveDir(env), transfersDir(env))
  assert.match(transfersDir({}), /storages[\\/]dsh-plugin-remote-use[\\/]transfers$/)
})

test('the staging name is a sibling so the rename stays on one filesystem', () => {
  assert.equal(partPathFor(join('tmp', 'a.bin')), join('tmp', 'a.bin.part'))
})

test('createHasher produces the file digest and refuses to be reused', () => {
  const hasher = createHasher()
  hasher.update(Buffer.from('abc'))
  assert.equal(hasher.digest(), sha256(Buffer.from('abc')))
  // Re-digesting a hash silently returns a digest of nothing, which would then be compared against a
  // real one and produce a "hash mismatch" pointing at the wrong place entirely.
  assert.throws(() => hasher.digest(), /already taken/)
})

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------

test('an upload larger than one chunk arrives as SEVERAL 4 MiB PUTs, never one giant body', async (t) => {
  // THE PROPERTY THIS FILE EXISTS FOR. A regression that buffered the file (or set the whole file as
  // one body) would show up as exactly one PUT whose length is the whole file -- so both the count and
  // the per-request length are asserted, not just the final result.
  const dir = scratch(t)
  const src = join(dir, 'big.bin')
  const size = TRANSFER_CHUNK_BYTES * 2 + 4096
  writeFileSync(src, bytes(size))
  const { channel, state } = newReceiver()

  const result = await uploadFile({ peerId: 'labpc', localPath: src, remotePath: 'remote.bin', channel })

  assert.equal(state.puts.length, 3, 'a 2-chunk-plus-4096 file must take three PUTs')
  assert.deepEqual(state.puts.map((p) => p.offset), [0, TRANSFER_CHUNK_BYTES, TRANSFER_CHUNK_BYTES * 2])
  assert.deepEqual(state.puts.map((p) => p.length), [TRANSFER_CHUNK_BYTES, TRANSFER_CHUNK_BYTES, 4096])
  for (const put of state.puts) {
    assert.equal(put.bodyIsStream, true, 'the request body must be a stream, not a Buffer of the slice')
    assert.equal(put.duplex, 'half', 'undici refuses a stream body without duplex')
    assert.equal(put.contentLength, String(put.length), 'content-length is mandatory: a chunked PUT is refused with 411')
    assert.match(put.url, /^http:\/\/worker:7331\/file\?path=remote.bin&offset=\d+$/)
    assert.equal(put.authorization, 'Bearer tok')
  }
  assert.equal(state.target.length, size, 'the worker must end up holding every byte')
  assert.equal(result.size, size)
  assert.equal(result.sha256, sha256(readFileSync(src)), 'the commit must carry the whole-file digest')
  assert.equal(state.commits.length, 1)
  assert.deepEqual(state.commits[0].body, { path: 'remote.bin', sha256: result.sha256, size, overwrite: false })
  assert.equal(state.commits[0].contentType, 'application/json')
})

test('progress fires once per chunk and ends at 100%', async (t) => {
  // The renderer only ever sees these callbacks; a transfer that reports nothing looks hung, and one
  // that reports per byte would flood the tool output.
  const dir = scratch(t)
  const src = join(dir, 'big.bin')
  const size = TRANSFER_CHUNK_BYTES + 10
  writeFileSync(src, bytes(size))
  const { channel } = newReceiver()

  const seen = []
  await uploadFile({
    peerId: 'labpc', localPath: src, remotePath: 'remote.bin', channel,
    onProgress: (p) => seen.push(p),
  })

  const sending = seen.filter((p) => p.phase === 'sending')
  assert.equal(sending.length, 2)
  assert.deepEqual(sending.map((p) => p.offset), [TRANSFER_CHUNK_BYTES, size])
  assert.equal(sending[1].percent, 100)
  assert.ok(seen.some((p) => p.phase === 'committed'), 'the caller must learn the transfer is real, not merely sent')
})

test('a 409 mid-upload re-aligns onto the receiver and finishes the file', async (t) => {
  // REGRESSION CONTEXT: without the re-align the loop retries offset 0 forever (the receiver answers
  // 409 to every PUT), so the failure mode is a hang, not an error.
  const dir = scratch(t)
  const src = join(dir, 'big.bin')
  const size = TRANSFER_CHUNK_BYTES + 1024
  writeFileSync(src, bytes(size))
  const { channel, state } = newReceiver({ part: Buffer.alloc(TRANSFER_CHUNK_BYTES, 7) })

  // The receiver already holds chunk 1 of THIS file, so the opening PUT (offset 0) must be refused.
  state.part = bytes(size).subarray(0, TRANSFER_CHUNK_BYTES)

  const result = await uploadFile({ peerId: 'labpc', localPath: src, remotePath: 'remote.bin', channel })

  assert.equal(state.puts[0].offset, 0)
  assert.equal(state.puts[1].offset, TRANSFER_CHUNK_BYTES, 'the retry must resume where the receiver actually is')
  assert.equal(result.aligned, true)
  assert.equal(result.sha256, sha256(readFileSync(src)), 'the digest must cover the re-read prefix AS WELL as the tail')
  assert.equal(state.target.length, size)
  assert.deepEqual(state.target, readFileSync(src))
})

test('a 409 whose expectedOffset is already the whole file still commits', async (t) => {
  // REGRESSION CONTEXT (found by the real-relay end-to-end test, not by any fake): the receiver holds
  // every byte of the `.part` -- a previous attempt landed them and then died before committing, or its
  // commit was lost. The master retries from 0, the relay answers `409 expectedOffset=<size>`, the
  // handler moves the offset to `size` -- and the loop, whose condition is `offset < size`, exits
  // WITHOUT HASHING ANYTHING. The hasher guard then failed the transfer with "sent 5242880 of 5242880
  // bytes", a message that reads like a wire fault and is not one. The bytes are all there; only the
  // digest for them is missing, and the source file is local.
  const dir = scratch(t)
  const src = join(dir, 'big.bin')
  const payload = bytes(TRANSFER_CHUNK_BYTES + 4096)
  writeFileSync(src, payload)
  // `part: payload` is the whole point of the case: the receiver really does hold every byte, so its
  // `409` is true and the commit that follows has something correct to verify against.
  const { channel, state } = newReceiver({ part: payload, denyFirstPutExpectedOffset: payload.length })

  const result = await uploadFile({ peerId: 'labpc', localPath: src, remotePath: 'remote.bin', channel })

  assert.equal(state.puts.length, 1, 'the re-align must satisfy the receiver, not provoke a re-send of everything')
  assert.equal(state.deniedPuts, 1)
  assert.equal(result.aligned, true)
  assert.equal(result.offset, payload.length)
  assert.equal(state.commits.length, 1)
  // The digest must be the WHOLE file's even though not one byte was sent in this attempt -- computed
  // from the local source, which is the only place those bytes exist on this side.
  assert.equal(state.commits[0].body.sha256, sha256(payload))
  assert.deepEqual(state.target, payload)
})

test('a 409 pointing past the end of the local file is refused, not hashed from a short read', async (t) => {
  // The other half of the same guard: an offset the LOCAL file cannot supply means the receiver is
  // talking about a different file. Re-seeding to it would read past EOF, so this must stay fatal.
  const dir = scratch(t)
  const src = join(dir, 'small.bin')
  writeFileSync(src, bytes(1024))
  const { channel, state } = newReceiver({ denyFirstPutExpectedOffset: 4096 })

  await assert.rejects(
    () => uploadFile({ peerId: 'labpc', localPath: src, remotePath: 'remote.bin', channel }),
    /source file shrank while reading|sent \d+ of 1024 bytes/,
  )
  assert.equal(state.commits.length, 0)
})

test('a 409 that names no offset is reported instead of retried forever', async (t) => {
  const dir = scratch(t)
  const src = join(dir, 'small.bin')
  writeFileSync(src, Buffer.from('hello'))
  const { channel } = newReceiver()
  channel.put = async () => jsonRes(409, { ok: false, error: 'misaligned' })

  await assert.rejects(
    () => uploadFile({ peerId: 'labpc', localPath: src, remotePath: 'remote.bin', channel }),
    /HTTP 409[\s\S]*misaligned/,
  )
})

test('a receiver that never advances is given up on, not looped on', async (t) => {
  // The alignment loop terminates because the receiver's `.part` grows. A receiver that answers the
  // same nonzero offset forever would otherwise hang the tool call with no diagnostic at all.
  const dir = scratch(t)
  const src = join(dir, 'small.bin')
  writeFileSync(src, bytes(64 * 1024))
  const { channel } = newReceiver()
  channel.put = async () => jsonRes(409, { ok: false, error: 'stuck', expectedOffset: 8 })

  await assert.rejects(
    () => uploadFile({ peerId: 'labpc', localPath: src, remotePath: 'remote.bin', channel, chunkBytes: 1024 }),
    /gave up after \d+ requests/,
  )
})

test('a source over transferMaxBytes is refused BEFORE any request is sent', async (t) => {
  // "Early refusal" is the whole value of the host-side ceiling: discovering the limit at 99% costs
  // the operator the transfer, and the receiver's own limit is only reachable by sending bytes.
  const dir = scratch(t)
  const src = join(dir, 'huge.bin')
  writeFileSync(src, Buffer.alloc(0))
  truncateSync(src, 1024 * 1024)

  const { channel, state } = newReceiver()
  await assert.rejects(
    () => uploadFile({ peerId: 'labpc', localPath: src, remotePath: 'remote.bin', channel, maxBytes: 512 * 1024 }),
    /exceeds the 524288-byte limit/,
  )
  assert.equal(state.puts.length, 0, 'nothing may be sent for a file that is already known to be too big')
  assert.equal(state.commits.length, 0)
})

test('a worker that refuses the size says so before the first byte', async (t) => {
  const dir = scratch(t)
  const src = join(dir, 'big.bin')
  writeFileSync(src, bytes(2048))
  const { channel, state } = newReceiver({ remoteSize: 10 * 1024 * 1024 })
  channel.head = async (url) => {
    state.heads.push({ url })
    return { status: 200, headers: new Headers({ 'x-file-size': String(10 * 1024 * 1024) }) }
  }

  await assert.rejects(
    () => uploadFile({ peerId: 'labpc', localPath: src, remotePath: 'remote.bin', channel, maxBytes: 1024 * 1024 }),
    /the worker's copy is 10485760 bytes/,
  )
  assert.equal(state.puts.length, 0)
})

test('a failed commit keeps the staged copy and reports both digests', async (t) => {
  // The receiver's 400 IS the integrity check. Reporting only "HTTP 400" would leave the operator
  // with a failed multi-gigabyte transfer and no idea which side is wrong.
  const dir = scratch(t)
  const src = join(dir, 'small.bin')
  writeFileSync(src, Buffer.from('payload'))
  const { channel } = newReceiver({ commitMismatch: true })

  await assert.rejects(
    () => uploadFile({ peerId: 'labpc', localPath: src, remotePath: 'remote.bin', channel }),
    /failed verification: worker sees sha256 [0-9a-f]{64} for its staged copy, host computed [0-9a-f]{64}/,
  )
})

test('an existing remote target is refused unless overwrite is set', async (t) => {
  const dir = scratch(t)
  const src = join(dir, 'small.bin')
  writeFileSync(src, Buffer.from('payload'))

  const first = newReceiver({ exists: true })
  await assert.rejects(
    () => uploadFile({ peerId: 'labpc', localPath: src, remotePath: 'remote.bin', channel: first.channel }),
    /pass overwrite to replace it/,
  )
  assert.equal(first.state.commits[0].body.overwrite, false)

  const second = newReceiver({ exists: true })
  const result = await uploadFile({ peerId: 'labpc', localPath: src, remotePath: 'remote.bin', channel: second.channel, overwrite: true })
  assert.equal(second.state.commits[0].body.overwrite, true)
  assert.equal(result.commit.bytes, 7)
})

test('a missing local file fails before any request', async (t) => {
  const dir = scratch(t)
  const { channel, state } = newReceiver()
  await assert.rejects(
    () => uploadFile({ peerId: 'labpc', localPath: join(dir, 'nope.bin'), remotePath: 'remote.bin', channel }),
    /cannot read[\s\S]*nope\.bin/,
  )
  assert.equal(state.puts.length, 0)
})

test('a path with a NUL byte is refused locally, as the contract requires of the worker', async (t) => {
  const dir = scratch(t)
  const src = join(dir, 'small.bin')
  writeFileSync(src, Buffer.from('x'))
  const { channel } = newReceiver()
  await assert.rejects(
    () => uploadFile({ peerId: 'labpc', localPath: src, remotePath: 'bad\u0000path', channel }),
    /NUL byte/,
  )
})

test('a filename with a plus sign survives the query string', async (t) => {
  // WHY THIS IS NOT PEDANTRY: `URLSearchParams` encodes a space as `+`, and `+` is a legal filename
  // character. A `+` that decoded as a space would upload to a path nobody asked for -- silently.
  const dir = scratch(t)
  const src = join(dir, 'a+b.bin')
  writeFileSync(src, Buffer.from('plus'))
  const { channel, state } = newReceiver()
  await uploadFile({ peerId: 'labpc', localPath: src, remotePath: 'dir/a+b c.bin', channel })
  const asked = new URL(state.puts[0].url).searchParams.get('path')
  assert.equal(asked, 'dir/a+b c.bin', 'the worker must receive the path the caller meant, plus sign and space apart')
  assert.match(state.puts[0].url, /%20/, 'a space is %20, never a +, which would decode as a literal plus')
})

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

test('a download streams to staging and only then renames into place', async (t) => {
  const dir = scratch(t)
  const dest = join(dir, 'out', 'fetched.bin')
  const { channel, state, remoteBuf, remoteHash } = newReceiver()

  const result = await downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel })

  assert.equal(state.gets.length, 1)
  assert.match(state.gets[0].url, /^http:\/\/worker:7331\/file\?path=remote.bin$/, 'a first attempt asks for no offset')
  assert.equal(state.gets[0].authorization, 'Bearer tok')
  assert.equal(result.sha256, remoteHash)
  assert.equal(result.bytes, remoteBuf.length)
  assert.equal(result.alreadyComplete, false)
  assert.deepEqual(readFileSync(dest), remoteBuf)
  // The staging file is the evidence the bytes were verified before the rename; it must be gone.
  assert.equal(existsSync(partPathFor(dest)), false)
  assert.equal(existsSync(dest), true)
})

test('a download resumes from the bytes already staged, with offset=', async (t) => {
  // REGRESSION CONTEXT: without the resume, every dropped link re-sends the whole file from zero.
  const dir = scratch(t)
  const dest = join(dir, 'out', 'fetched.bin')
  mkdirSync(join(dir, 'out'), { recursive: true })
  const { channel, state, remoteBuf } = newReceiver()
  const half = Math.floor(remoteBuf.length / 2)
  writeFileSync(partPathFor(dest), remoteBuf.subarray(0, half))

  const result = await downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel })

  assert.equal(state.gets[0].offset, half)
  assert.match(state.gets[0].url, new RegExp(`&offset=${half}$`))
  assert.equal(result.resumedFrom, half)
  assert.equal(result.size, remoteBuf.length, 'the size reported must be the whole file, not the tail')
  assert.deepEqual(readFileSync(dest), remoteBuf)
})

test('a completed staging file is verified and renamed without touching the network', async (t) => {
  const dir = scratch(t)
  const dest = join(dir, 'out', 'fetched.bin')
  const { channel, state, remoteBuf, remoteHash } = newReceiver()
  mkdirSync(join(dir, 'out'), { recursive: true })
  writeFileSync(partPathFor(dest), remoteBuf)

  const result = await downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel })

  assert.equal(result.alreadyComplete, true)
  assert.equal(result.sha256, remoteHash)
  assert.deepEqual(readFileSync(dest), remoteBuf)
  assert.equal(state.gets.length, 1, 'the probe GET must not have pulled the body')
})

test('a download whose digest does not match never appears at the destination', async (t) => {
  // THE ATOMICITY PROPERTY. A corrupted transfer must leave the operator with a `.part` and an error,
  // never with a plausible file that is silently wrong.
  const dir = scratch(t)
  const dest = join(dir, 'out', 'fetched.bin')
  const { channel } = newReceiver({ remoteSha256: 'f'.repeat(64) })

  await assert.rejects(
    () => downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel }),
    /failed verification/,
  )
  assert.equal(existsSync(dest), false, 'the destination path must not exist at all')
  assert.equal(existsSync(partPathFor(dest)), true, 'the staged bytes are the resume point and must be kept')
})

test('a corrupt staging file is discarded and the download still succeeds', async (t) => {
  // A staging file whose tail is not the remote's: the digest is the only thing that can tell, and it
  // must win over the size agreement -- otherwise a wrong file would be renamed into place just
  // because it happened to be the right LENGTH.
  const dir = scratch(t)
  const dest = join(dir, 'out', 'fetched.bin')
  const longRemote = Buffer.from('abcdefghij' + 'K'.repeat(40))
  const { channel, state, remoteHash } = newReceiver({ remoteText: longRemote.toString('utf8') })
  mkdirSync(join(dir, 'out'), { recursive: true })
  writeFileSync(partPathFor(dest), Buffer.concat([longRemote.subarray(0, 10), Buffer.alloc(8, 0xff)]))

  const result = await downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel })

  assert.ok(state.gets.length >= 2, 'a wrong staging file must be re-pulled, not accepted')
  assert.equal(state.gets[0].offset, 18, 'the first attempt resumes from what was on disk')
  assert.ok(state.gets[1].offset <= 18, 'the retry must not ask for more than was staged')
  assert.equal(result.sha256, remoteHash)
  assert.deepEqual(readFileSync(dest), longRemote)
})

test('a staging file longer than the remote one is replaced, not resumed forever', async (t) => {
  // `offset >= size` on the receiver is a 416. Retrying that offset is an infinite loop, so the stale
  // staging file has to go; the test pins that the download still SUCCEEDS afterwards.
  const dir = scratch(t)
  const dest = join(dir, 'out', 'fetched.bin')
  const { channel, state, remoteBuf } = newReceiver()
  mkdirSync(join(dir, 'out'), { recursive: true })
  writeFileSync(partPathFor(dest), Buffer.concat([remoteBuf, Buffer.from('stale extra bytes')]))

  const result = await downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel })

  assert.ok(state.gets.length >= 2)
  assert.equal(state.gets[1].offset, 0, 'the retry after a stale staging file must start from zero')
  assert.equal(result.size, remoteBuf.length)
  assert.deepEqual(readFileSync(dest), remoteBuf)
})

test('an existing destination is refused unless overwrite is set', async (t) => {
  const dir = scratch(t)
  const dest = join(dir, 'fetched.bin')
  writeFileSync(dest, 'do not lose me')
  const { channel, state } = newReceiver()

  await assert.rejects(
    () => downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel }),
    /already exists \(pass overwrite to replace it\)/,
  )
  assert.equal(state.gets.length, 0, 'a refused download must cost no request')
  assert.equal(readFileSync(dest, 'utf8'), 'do not lose me')
})

test('overwrite replaces the destination in one step and keeps the old bytes until then', async (t) => {
  const dir = scratch(t)
  const dest = join(dir, 'fetched.bin')
  writeFileSync(dest, 'old contents')
  const { channel, remoteBuf } = newReceiver()

  await downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel, overwrite: true })

  assert.deepEqual(readFileSync(dest), remoteBuf)
  assert.equal(existsSync(partPathFor(dest)), false)
})

test('a download over transferMaxBytes is refused before the body is consumed', async (t) => {
  const dir = scratch(t)
  const dest = join(dir, 'fetched.bin')
  const { channel } = newReceiver()
  await assert.rejects(
    () => downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel, maxBytes: 4 }),
    /exceeds the 4-byte limit/,
  )
  assert.equal(existsSync(dest), false)
  assert.equal(existsSync(partPathFor(dest)), false)
})

test('an interrupted body is reported with the staged byte count, and the .part survives', async (t) => {
  const dir = scratch(t)
  const dest = join(dir, 'fetched.bin')
  const { channel } = newReceiver()
  // The body dies BEFORE the first chunk arrives -- what a socket reset at the start of a resume looks
  // like. The count in the message must be the bytes actually written, because it is what the operator
  // (and the next attempt's `offset`) will treat as the resume point. The advertised size matches the
  // remote so the failure comes from the body, not from a length disagreement.
  channel.get = async () => ({
    status: 200,
    headers: new Headers({ 'x-file-size': '3', 'x-file-sha256': 'a'.repeat(64) }),
    body: new ReadableStream({
      start(controller) {
        controller.error(new Error('ECONNRESET'))
      },
    }),
  })

  await assert.rejects(
    () => downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel }),
    /download failed after 0 bytes[\s\S]*ECONNRESET/,
  )
  assert.equal(existsSync(dest), false, 'no file may appear at the destination')
  assert.equal(statSync(partPathFor(dest)).size, 0, 'the staging file is the resume point and must remain')
})

test('a body that dies mid-stream reports the bytes it had written and keeps the .part', async (t) => {
  // A socket that resets instead of finishing the body. The message must name the byte count and the
  // staging file must survive, because that count is the resume point the next attempt starts from.
  const dir = scratch(t)
  const dest = join(dir, 'fetched.bin')
  const { channel } = newReceiver()
  channel.get = async () => ({
    status: 200,
    headers: new Headers({ 'x-file-size': '3', 'x-file-sha256': 'a'.repeat(64) }),
    body: new ReadableStream({
      pull(controller) {
        controller.enqueue(Buffer.from('abc'))
        controller.error(new Error('ECONNRESET'))
      },
    }),
  })

  await assert.rejects(
    () => downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel }),
    /download failed after \d+ bytes[\s\S]*ECONNRESET/,
  )
  assert.equal(existsSync(dest), false, 'no file may appear at the destination')
  assert.equal(existsSync(partPathFor(dest)), true, 'the staging file is the resume point and must remain')
})

test('a response with no body is an error, not a zero-byte file', async (t) => {
  const dir = scratch(t)
  const dest = join(dir, 'fetched.bin')
  const { channel } = newReceiver()
  channel.get = async () => ({ status: 200, headers: new Headers({ 'x-file-size': '10' }) })
  await assert.rejects(
    () => downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel }),
    /with no body/,
  )
  assert.equal(existsSync(dest), false)
})

test('a download reports the peer id in every failure, since the host has many workers', async (t) => {
  const dir = scratch(t)
  const dest = join(dir, 'fetched.bin')
  const { channel } = newReceiver()
  channel.get = async () => { throw new Error('fetch failed') }
  await assert.rejects(
    () => downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel }),
    /worker "labpc" GET \/file \(offset 0\) failed: fetch failed/,
  )
})

test('an empty x-file-sha256 falls back to the size check instead of refusing everything', async (t) => {
  // A relay older than this feature does not set the digest. Refusing would make the whole download
  // path look broken against a worker that is perfectly healthy.
  const dir = scratch(t)
  const dest = join(dir, 'fetched.bin')
  const { channel, remoteBuf } = newReceiver({ remoteSha256: '' })
  const result = await downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel })
  assert.deepEqual(readFileSync(dest), remoteBuf)
  assert.equal(result.sha256, sha256(remoteBuf), 'the host reports what it actually computed')
})

test('a transfer error carries its status so a caller can branch on it', async (t) => {
  const dir = scratch(t)
  const dest = join(dir, 'fetched.bin')
  const { channel } = newReceiver()
  channel.get = async () => jsonRes(401, { ok: false, error: 'unauthorized' })
  await assert.rejects(
    () => downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel }),
    (error) => {
      assert.ok(error instanceof TransferError)
      assert.equal(error.status, 401)
      assert.match(error.message, /HTTP 401[\s\S]*unauthorized/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

/** An RPC double that records the method and params, the way the worker's relay would receive them. */
function fakeRpc(result, opts = {}) {
  const calls = []
  return {
    calls,
    async rpc(method, params, rpcOpts) {
      calls.push({ method, params, rpcOpts })
      if (opts.throwError !== undefined) throw new Error(opts.throwError)
      return result
    },
  }
}

test('statFile asks the worker and normalizes a sparse answer', async () => {
  const client = fakeRpc({ ok: true, path: '/abs/a.bin', exists: true, isDir: false, size: 42, mtime: '2026-10-15T00:00:00.000Z' })
  const stat = await statFile(client, '/abs/a.bin', { timeoutMs: 1234 })
  assert.deepEqual(client.calls[0], { method: 'dsh-remote/stat', params: { path: '/abs/a.bin' }, rpcOpts: { timeoutMs: 1234 } })
  assert.equal(stat.exists, true)
  assert.equal(stat.size, 42)
  // The hash is expensive on the worker and is NOT requested by default: a stat that silently hashed
  // a 6 GiB file would make the cheap probe the most costly call in the plugin.
  assert.equal(stat.sha256, '')
})

test('statFile never reports a directory size as a file size', async () => {
  const client = fakeRpc({ ok: true, exists: true, isDir: true, size: 4096 })
  const stat = await statFile(client, 'C:\\task')
  assert.equal(stat.isDir, true)
  assert.equal(stat.size, 0, 'a block count is not a file size and must not be compared against a budget')
})

test('statFile and listFiles refuse an unusable path without asking the worker', async () => {
  const client = fakeRpc({})
  await assert.rejects(() => statFile(client, ''), /non-empty path/)
  await assert.rejects(() => statFile(client, 'a\u0000b'), /NUL byte/)
  await assert.rejects(() => listFiles(client, ''), /non-empty path/)
  assert.equal(client.calls.length, 0)
})

test('listFiles forwards the limit and normalizes entries', async () => {
  const client = fakeRpc({
    ok: true,
    path: '/work',
    entries: [{ name: 'a.bin', isDir: false, size: 12, mtime: 't1' }, { name: 'sub', isDir: true, size: 4096 }],
    truncated: true,
  })
  const list = await listFiles(client, '/work', { limit: 50, timeoutMs: 900 })
  assert.deepEqual(client.calls[0].params, { path: '/work', limit: 50 })
  // The call's own argument and the transport's budget must travel in their own fields: a `limit`
  // handed to the bridge as a timeout (or the reverse) is the silent version of a wrong answer.
  assert.deepEqual(client.calls[0].rpcOpts, { timeoutMs: 900 })
  assert.equal(list.truncated, true)
  assert.deepEqual(list.entries, [
    { name: 'a.bin', isDir: false, size: 12, mtime: 't1' },
    { name: 'sub', isDir: true, size: 0, mtime: '' },
  ])
})

test('a transfer RPC without a connection says so instead of crashing somewhere else', async () => {
  await assert.rejects(() => statFile(undefined, '/x'), /not connected/)
  await assert.rejects(() => listFiles({}, '/x'), /not connected/)
})

// ---------------------------------------------------------------------------
// abort
// ---------------------------------------------------------------------------

test('abortTransfer deletes only the staging file', async (t) => {
  const { channel, state } = newReceiver({ part: Buffer.from('half') })
  const result = await abortTransfer({ peerId: 'labpc', remotePath: 'remote.bin', channel })
  assert.equal(result.removed, true)
  assert.equal(result.part, '/d/remote.bin.part')
  assert.match(state.deletes[0].url, /^http:\/\/worker:7331\/file\?path=remote.bin$/)
  assert.equal(state.puts.length + state.commits.length, 0, 'aborting a transfer must touch nothing else')
})

test('aborting a transfer that was never staged reports removed:false', async (t) => {
  const { channel } = newReceiver()
  const result = await abortTransfer({ peerId: 'labpc', remotePath: 'remote.bin', channel })
  assert.equal(result.removed, false)
})

test('abortTransfer surfaces a refusal rather than pretending it worked', async (t) => {
  const { channel } = newReceiver()
  channel.del = async () => jsonRes(401, { ok: false, error: 'unauthorized' })
  await assert.rejects(
    () => abortTransfer({ peerId: 'labpc', remotePath: 'remote.bin', channel }),
    /HTTP 401[\s\S]*unauthorized/,
  )
})

// ---------------------------------------------------------------------------
// header integrity
// ---------------------------------------------------------------------------

test('the download result keeps the worker-resolved path and mtime for the audit row', async (t) => {
  // The audit trail has to say where the bytes really went. Guessing from the request would record
  // the relative path the caller used, which is not the path the file has on the worker.
  const dir = scratch(t)
  const dest = join(dir, 'fetched.bin')
  const { channel, remoteBuf } = newReceiver()
  const result = await downloadFile({ peerId: 'labpc', remotePath: 'remote.bin', destPath: dest, channel })
  assert.equal(result.remote.path, '/abs/remote.bin')
  assert.equal(result.remote.mtime, '2026-10-15T00:00:00.000Z')
  assert.equal(statSync(dest).size, remoteBuf.length)
})
