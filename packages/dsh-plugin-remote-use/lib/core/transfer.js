/**
 * Streaming file transfer between the host and a worker's relay.
 *
 * WHY HTTP AND NOT THE RPC CHANNEL: the control frames that keep a pairing alive ride the relay's
 * WebSocket, and that socket is a single `message` handler shared with the ACP conversation pump
 * (`relay.mjs`). A multi-hundred-megabyte file pushed through it would queue every GUI control
 * frame behind the bytes, and `ws` would first try to hold the payload in memory (its default
 * `maxPayload` is 100 MiB, and exceeding it closes the socket with 1009). Bytes therefore go over
 * the relay's HTTP side -- same origin, same token -- which is exactly why `screenshot()` was moved
 * there. This module is the file-sized version of that decision.
 *
 * WHY THE CORE TAKES A TRANSFER CHANNEL RATHER THAN A LIVE SOCKET: everything here is driven by
 * plain callbacks (`get` / `put` / `head` / `rpc`) instead of a bridge or a `PeerConnection`. That
 * is not decoration: it is what lets the tests drive a full 12 MiB upload through a fake channel and
 * ASSERT that it arrived as three 4 MiB requests. The property that matters most in this file --
 * "a file is never buffered whole, on either side" -- cannot be observed through a live socket
 * without pulling the very ceiling into the test that the ceiling is supposed to prevent.
 *
 * THE TWO INVARIANTS EVERY PATH PRESERVES:
 *
 *   1. NEVER A WHOLE FILE IN MEMORY. Uploads are sliced into `TRANSFER_CHUNK_BYTES`-sized ranges of
 *      the local file and each range is handed to `fetch` AS A `ReadStream` (`duplex: 'half'`), so
 *      neither end ever holds more than a socket buffer of it; the running sha256 is computed over
 *      those same slices, in the same pass, so the digest costs no extra read. Downloads go
 *      `Readable.fromWeb(res.body)` -> an open file handle. Progress is therefore per slice, which
 *      is also why it can be rendered live.
 *   2. THE DESTINATION PATH IS NEVER HALF-WRITTEN. Both directions stage into `<name>.part`, verify
 *      the whole-file sha256, and only then rename. A crash, a full disk or a dropped link can
 *      leave a `.part` (that is the resume point and the whole point of keeping it) but never a
 *      plausible-looking file at the real name.
 *
 * @module dsh-plugin-remote-use/transfer
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, rmSync, statSync, truncateSync, writeSync } from 'node:fs'
import { Readable } from 'node:stream'
import { basename, dirname, join } from 'node:path'

import { resolveDshHome } from './settings-store.js'

/**
 * Slice size for the upload loop, per the frozen contract (4 MiB).
 *
 * WHY NOT SMALLER: every slice is one HTTP request, and each request costs a round trip plus a
 * receiver-side `fsync`-cheap append. A LAN round trip is sub-millisecond, but a 4 KiB slice would
 * mean a quarter of a million requests for one 1 GiB file and a progress callback per request;
 * 4 MiB keeps the request count in the hundreds while staying far below any proxy's patience.
 */
export const TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024

/**
 * Host-side refusal ceiling, when the caller configures nothing.
 *
 * WHY A DEFAULT AT ALL: an unbounded transfer is a way to fill the host's disk by accident. 8 GiB
 * matches the worker's own hard `--max-transfer-bytes` default, so the two ends agree without
 * either being told.
 */
export const DEFAULT_TRANSFER_MAX_BYTES = 8 * 1024 * 1024 * 1024

/**
 * Per-request wall-clock budget.
 *
 * WHY PER REQUEST AND NOT PER TRANSFER: a timeout on the whole transfer would abort a 6 GiB copy
 * that is making perfect progress on a slow link. What has to be bounded is the gap -- a request
 * that has stopped moving -- so the budget is applied per chunk and per stream, and a healthy
 * transfer may legitimately run for hours.
 */
export const DEFAULT_TRANSFER_REQUEST_TIMEOUT_MS = 5 * 60_000

/**
 * How many HTTP round trips one chunk may cost before the alignment loop gives up.
 *
 * WHY THIS EXISTS: the misalignment loop (`409` -> re-align -> retry the same chunk) terminates only
 * because the receiver's `.part` grows. If a buggy or hostile receiver answers every `PUT` with the
 * SAME `expectedOffset`, the loop would spin forever and the caller would see a hang rather than a
 * failure. Measured risk is low, but "cannot happen" is not the same as "cannot loop", and a bounded
 * number of attempts turns a hang into a named error.
 */
const MAX_ALIGN_ATTEMPTS = 5

/** Status codes this module gives names to, so the branches that act on them read as intent. */
const FILE_EXISTS = 409
const OFFSET_MISMATCH = 409
const TOO_LARGE = 413
const RANGE_NOT_SATISFIABLE = 416

/**
 * Diagnostic ceiling for error bodies. A worker's error body is JSON with a sentence in it; the
 * screenshot path already uses 200 and there is no reason for a transfer error to carry more.
 */
const ERROR_BODY_CHARS = 200

/**
 * An error whose `status` a caller may branch on, plus any structured fields the endpoint returned
 * (notably `expectedOffset` from a `409`, which is what lets the upload re-align instead of guessing).
 */
export class TransferError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, detail?: object | null }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'TransferError'
    this.status = Number.isFinite(opts.status) ? Number(opts.status) : 0
    this.detail = opts.detail ?? null
  }
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/**
 * Where the host keeps files pulled from workers.
 *
 * WHY NOT THE SCREENSHOT DIRECTORY: the screenshots live in the system temp directory because they
 * are automatic byproducts that may be pruned without anyone noticing. A received file is a
 * DELIBERATE product -- the operator asked for it -- so it belongs beside the plugin's other state,
 * and it is never pruned automatically (see `docs/DESIGN.md`).
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function transfersDir(env = process.env) {
  return join(resolveDshHome(env), 'storages', 'dsh-plugin-remote-use', 'transfers')
}

/**
 * The directory downloads land in. Created on demand, never pruned here.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function defaultReceiveDir(env = process.env) {
  return transfersDir(env)
}

/** The staging name for a destination. Always a sibling, so the rename is on one filesystem. */
export function partPathFor(path) {
  return `${path}.part`
}

/** Create a directory and everything above it. Extracted so both directions say it the same way. */
function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

// ---------------------------------------------------------------------------
// request plumbing
// ---------------------------------------------------------------------------

/** Normalize a caller-supplied channel so an HTTP error can never be reported for the wrong peer. */
function peerLabel(peerId) {
  return peerId === undefined || peerId === null || String(peerId) === '' ? 'unknown' : String(peerId)
}

/**
 * Run an injected channel, stamping the peer into the failure.
 *
 * WHY THE STAMP IS MANDATORY: the host talks to several workers and every one of them speaks the
 * same protocol on the same paths. "fetch failed" with no peer id is unactionable; the screenshot
 * path learned this and prefixes every error with `worker "<id>"`.
 */
async function request(fn, peerId, what) {
  try {
    return await fn()
  } catch (error) {
    throw new TransferError(`worker "${peerLabel(peerId)}" ${what} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** A JSON body of an error response, when there is one. Never throws: a body may be missing. */
async function readErrorDetail(res) {
  try {
    const text = await res.text()
    try {
      const parsed = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object') return parsed
    } catch { /* not JSON: the text is still the best detail available */ }
    return text === '' ? null : text.slice(0, ERROR_BODY_CHARS)
  } catch {
    return null
  }
}

/** Render a detail for a human. Accepts the two shapes `readErrorDetail` may return. */
function detailText(detail) {
  if (detail === null || detail === undefined) return ''
  if (typeof detail === 'string') return detail
  const message = detail.error ?? detail.message
  return typeof message === 'string' ? message : JSON.stringify(detail).slice(0, ERROR_BODY_CHARS)
}

/**
 * `409`/`400` responses carry the server's own `error` string; lifting it out of the JSON matters
 * because otherwise a misalignment is reported as the bare status and the operator cannot tell it
 * apart from a missing file or a rejected token.
 */
function httpError(peerId, verb, status, detail) {
  const text = detailText(detail)
  return new TransferError(
    `worker "${peerLabel(peerId)}" ${verb} returned HTTP ${status}${text === '' ? '' : `: ${text}`}`,
    { status, detail },
  )
}

/** The offset a `409` asked for, or NaN when the response did not name one. */
function expectedOffsetOf(detail) {
  const value = Number(detail?.expectedOffset)
  return Number.isFinite(value) && value >= 0 ? value : NaN
}

/**
 * Encode one query value.
 *
 * WHY NOT `URLSearchParams`: it encodes a space as `+`, and a path is not a form field -- `+` is a
 * legal filename character, so `a+b.txt` would come back as `a b.txt` on the worker. `encodeURIComponent`
 * is the top-level `set` of the same table without the form encoding.
 */
function queryValue(value) {
  return encodeURIComponent(String(value))
}

/** A short, peer-scoped label for a transfer, used in the error text the operator reads. */
function describe(direction, peerId, from, to) {
  return direction === 'upload'
    ? `upload to worker "${peerLabel(peerId)}" (${from} -> ${to})`
    : `download from worker "${peerLabel(peerId)}" (${to} <- ${from})`
}

// ---------------------------------------------------------------------------
// hashing
// ---------------------------------------------------------------------------

/** Cheap commit-then-digest handle, so a hasher can never be reused after it has produced a value. */
export function createHasher() {
  const hash = createHash('sha256')
  let taken = false
  return {
    update(chunk) { hash.update(chunk) },
    digest() {
      if (taken) throw new Error('createHasher: digest() was already taken')
      taken = true
      return hash.digest('hex')
    },
  }
}

/** sha256 of an existing file, read once in slices. Used to trust a resume point. */
function hashFileSync(path, chunk = TRANSFER_CHUNK_BYTES) {
  const hasher = createHasher()
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(chunk)
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      hasher.update(buf.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return hasher.digest()
}

/** sha256 of a buffer or string. The commit comparison is the only caller. */
function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * WHERE TWO DIGESTS FIRST DISAGREE, as a character index (2 hex characters per byte).
 *
 * ⚠️ THIS IS A PROGRESS MARKER, NOT A LOCALIZATION. A hash diffuses: changing ONE byte near the end
 * changes the FIRST character with probability 15/16, so in practice `divergeAtByte` is almost always
 * 0 and a download that fails verification is re-pulled from the start. The comparison is kept because
 * it costs nothing and is correct when it does bite (two files that share a long prefix, e.g. a remote
 * that only had bytes APPENDED, produce a late divergence), but nothing may depend on it localizing
 * damage -- the honest description of a digest mismatch is "this content is not that file".
 */
function digestDivergence(expected, actual) {
  const n = Math.min(expected.length, actual.length)
  for (let i = 0; i < n; i += 1) {
    if (expected[i] !== actual[i]) return i
  }
  return n
}

/** Replace a staged file with a fresh one of exactly `size` bytes (0 truncates). */
function resetPart(path, size) {
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, 'w')
  try {
    if (size > 0) truncateSync(fd, size)
  } finally {
    closeSync(fd)
  }
}

/**
 * Write one buffer at an absolute offset, looping over short writes.
 *
 * `writeSync` is documented to return the number of bytes written and may return fewer than asked
 * (a signal, a nearly-full disk edge). Treating the return value as "all of it" is how a file ends
 * up silently short, and a short file would then fail the commit check at the far end with a hash
 * mismatch that points nowhere near the real bug.
 */
function writeAll(fd, chunk, position) {
  let written = 0
  while (written < chunk.length) {
    written += writeSync(fd, chunk, written, chunk.length - written, position + written)
  }
}

/**
 * Digest + copy a prefix of a file without reading it twice, so the upload hash and the upload bytes
 * are literally the same pass over disk. See `uploadFile` for why the prefix needs re-hashing at all.
 */
function seedPrefix(hasher, path, bytes, chunk = TRANSFER_CHUNK_BYTES) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(Math.min(chunk, Math.max(1, bytes)))
    let read = 0
    while (read < bytes) {
      const want = Math.min(buf.length, bytes - read)
      const n = readSync(fd, buf, 0, want, read)
      if (n <= 0) throw new TransferError(`source file shrank while reading ${path} (${read} of ${bytes} bytes)`)
      hasher.update(buf.subarray(0, n))
      read += n
    }
  } finally {
    closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------

/**
 * Open the slice that will be a request body, with the cleanup a failed request needs.
 *
 * WHY THE STREAM MUST BE TORN DOWN BY HAND: when the receiver answers `409` (or anything else) without
 * draining the body, `fetch` rejects and the read stream we handed it is left open and unread. An
 * abandoned `ReadStream` keeps its file descriptor and fires an `error` on some later tick -- and the
 * listenerless version of that error is an uncaught exception, i.e. the process dies from a bad
 * response to one chunk. `.destroy()` releases the descriptor and is idempotent, so calling it on a
 * fully-consumed stream is a no-op the success path does not have to think about.
 */
function openSlice(path, offset, length) {
  const stream = createReadStream(path, { start: offset, end: offset + length - 1 })
  stream.on('error', () => { /* the failure is reported by the request, not by a second handler */ })
  return {
    stream,
    release() {
      if (!stream.destroyed) stream.destroy()
    },
  }
}

/**
 * Push one slice as a `PUT`, as a STREAM rather than a buffer.
 *
 * WHY A STREAM BODY: the whole constraint this module exists for is not holding the file in memory.
 * A `Buffer` of one 4 MiB slice would technically satisfy the contract's chunking, but it would also
 * make the memory ceiling a function of the slice size, and the next person to raise
 * `TRANSFER_CHUNK_BYTES` would raise the ceiling with it. `duplex: 'half'` is what tells `fetch`
 * that the body is a stream it may write out and not expect a response on; without it, undici
 * refuses a stream body outright.
 *
 * @returns {Promise<{ status: number, body: object | null }>}
 */
async function putChunk(channel, peerId, remotePath, offset, length, bodyPath, timeoutMs, signal) {
  const url = `${channel.base}/file?path=${queryValue(remotePath)}&offset=${offset}`
  const timeout = armTimeout(timeoutMs, signal)
  const slice = openSlice(bodyPath, offset, length)
  let res
  try {
    res = await request(() => channel.put(url, {
      method: 'PUT',
      // content-length is mandatory per the contract: a chunked PUT is refused with 411, because
      // without a declared length the receiver cannot tell a complete slice from a truncated one.
      headers: { ...channel.authHeaders(), 'content-length': String(length) },
      body: slice.stream,
      duplex: 'half',
      signal: timeout.signal,
    }), peerId, `PUT /file (offset ${offset})`)
  } catch (error) {
    slice.release()
    throw error
  } finally {
    timeout.disarm()
  }
  if (res.status === 200) {
    // The JSON body is advisory only; the loop never trusts it over the commit check.
    let body = null
    try { body = await res.json() } catch { /* a 200 with an unreadable body still moved the bytes */ }
    slice.release()
    return { status: 200, body }
  }
  slice.release()
  const detail = await readErrorDetail(res)
  if (res.status === OFFSET_MISMATCH) return { status: res.status, body: detail }
  throw httpError(peerId, `PUT /file (offset ${offset})`, res.status, detail)
}

/**
 * Upload a local file and leave it at `remotePath` on the worker.
 *
 * THE ORDER IS THE PROOF: bytes first, name second. Every slice lands in `<remote>.part`; only after
 * the receiver has recomputed the whole-file sha256 of that `.part` and found it equal to the digest
 * computed here DURING THE SAME READ does the receiver rename it. Either side can therefore crash at
 * any instant without leaving a plausible file at the real name.
 *
 * @param {object} opts
 * @param {string} opts.peerId
 * @param {string} opts.localPath                  file to read
 * @param {string} opts.remotePath                 path ON THE WORKER (relative = task directory)
 * @param {object} opts.channel
 * @param {string} opts.channel.base
 * @param {() => Record<string, string>} opts.channel.authHeaders
 * @param {(url: string, init: object) => Promise<object>} opts.channel.put
 * @param {(url: string, init: object) => Promise<object>} [opts.channel.head] cheap pre-flight probe
 * @param {boolean} [opts.overwrite]               false/absent refuses an existing remote target
 * @param {number} [opts.maxBytes]                 host-side ceiling; refuse BEFORE any request
 * @param {number} [opts.timeoutMs]                per-request budget
 * @param {AbortSignal} [opts.signal]
 * @param {(p: { direction: string, peerId: string, path: string, offset: number, bytes: number,
 *              total: number, percent: number, attempts: number, phase: string }) => void} [opts.onProgress]
 * @returns {Promise<{ ok: true, direction: 'upload', peerId: string, localPath: string,
 *                     remotePath: string, size: number, sha256: string, bytes: number, offset: number,
 *                     attempts: number, aligned: boolean, commit: object | null, elapsedMs: number }>}
 */
export async function uploadFile(opts) {
  const started = Date.now()
  const peerId = opts.peerId
  const localPath = String(opts.localPath ?? '')
  const remotePath = String(opts.remotePath ?? '')
  const channel = opts.channel
  if (channel === undefined || channel === null || typeof channel.put !== 'function') {
    throw new TransferError(`upload to worker "${peerLabel(peerId)}": a transfer channel with put() is required`)
  }
  assertUsablePath(localPath, 'local')
  assertUsablePath(remotePath, 'remote')

  let size
  try {
    size = statSync(localPath).size
  } catch (error) {
    throw new TransferError(`upload to worker "${peerLabel(peerId)}": cannot read ${localPath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  // PRE-FLIGHT, BEFORE ANY REQUEST. Finding out at 99% that the far end will refuse a 9 GiB file
  // costs the operator the whole upload; the same answer is available from two numbers on disk, and
  // the worker enforces its own ceiling anyway (defence in depth: this end cannot know a token
  // someone else holds).
  const maxBytes = Number.isFinite(opts.maxBytes) ? Number(opts.maxBytes) : DEFAULT_TRANSFER_MAX_BYTES
  if (maxBytes > 0 && size > maxBytes) {
    throw new TransferError(
      describe('upload', peerId, localPath, remotePath) + ` refused: ${size} bytes exceeds the ${maxBytes}-byte limit`,
      { status: TOO_LARGE },
    )
  }
  await probeRemoteSize(channel, peerId, remotePath, maxBytes)

  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}
  const chunkBytes = Number.isFinite(opts.chunkBytes) && Number(opts.chunkBytes) > 0
    ? Math.floor(Number(opts.chunkBytes))
    : TRANSFER_CHUNK_BYTES

  let offset = 0
  let attempts = 0
  let aligned = false
  const maxAttempts = Math.ceil(size / chunkBytes) + MAX_ALIGN_ATTEMPTS

  /**
   * The hash covers the bytes the WORKER will hold, and nothing else.
   *
   * It is seeded from the bytes the receiver already has, then extended by every slice we send. On a
   * fresh transfer the seed is empty, so the digest is exactly one pass over the file and no second
   * read is needed to compute it. Re-seeding happens only when a `409` proves the receiver is ahead
   * of us (a previous transfer died after landing slices), and that re-read is the price of being
   * able to CONTINUE: restarting would re-send gigabytes purely to justify a hash.
   *
   * `seededFor` is what keeps this honest. The digest is only the file's digest while the hasher has
   * consumed exactly the prefix `[0, offset)`; if a resync moves the offset to a prefix the hasher
   * has not seen, the numbers would silently describe different byte ranges and the commit endpoint
   * would reject a transfer that actually succeeded. Rebuilding in one place removes that class.
   */
  let hasher = createHasher()
  let seededFor = 0
  const reseedTo = (target) => {
    const fresh = createHasher()
    if (target > 0) seedPrefix(fresh, localPath, target)
    hasher = fresh
    seededFor = target
  }

  const buf = Buffer.allocUnsafe(chunkBytes)
  const fd = openSync(localPath, 'r')
  try {
    while (offset < size) {
      if (opts.signal?.aborted === true) throw new TransferError(`${describe('upload', peerId, localPath, remotePath)} aborted at offset ${offset}`)
      const want = Math.min(chunkBytes, size - offset)
      const got = readSync(fd, buf, 0, want, offset)
      if (got <= 0) throw new TransferError(`${describe('upload', peerId, localPath, remotePath)}: source file shrank at offset ${offset}`)
      const slice = buf.subarray(0, got)

      attempts += 1
      if (attempts > maxAttempts) {
        throw new TransferError(`${describe('upload', peerId, localPath, remotePath)}: gave up after ${attempts} requests without making progress past offset ${offset}`)
      }

      const res = await putChunk(channel, peerId, remotePath, offset, got, localPath, requestTimeout(opts), opts.signal)
      if (res.status === OFFSET_MISMATCH) {
        const expected = expectedOffsetOf(res.body)
        if (!Number.isFinite(expected)) {
          throw httpError(peerId, `PUT /file (offset ${offset})`, OFFSET_MISMATCH, res.body)
        }
        // Re-align onto what the receiver ACTUALLY holds. `expected === 0` is the ordinary case -- a
        // fresh upload whose slice was refused -- and needs only an empty hasher.
        aligned = true
        offset = expected
        seededFor = -1
        continue
      }

      if (seededFor !== offset) reseedTo(offset)
      hasher.update(slice)
      seededFor = offset + got
      offset += got
      onProgress(progress('upload', peerId, remotePath, offset, size, attempts, 'sending'))
    }
  } finally {
    closeSync(fd)
  }

  /**
   * ⚠️ THE RE-ALIGN CAN LAND EXACTLY ON `size`, SO THE GUARD MUST FINISH THE HASH RATHER THAN REFUSE.
   *
   * A `409` whose `expectedOffset` is already the whole file is a real state, not a corner invented by
   * a test: the receiver holds every byte of `<remote>.part` (a previous attempt landed them all and
   * then died before the commit, or its commit was lost), the master retries from 0, and the relay
   * answers `409 expectedOffset=<size>`. The `409` handler sets `offset = size` and `seededFor = -1`,
   * the loop condition `offset < size` is then FALSE, and the loop exits without ever hashing a byte.
   *
   * This used to be a hard failure -- "sent 5242880 of 5242880 bytes", which reads like a wire fault
   * and is not one. There is nothing to recover on the wire: the SOURCE file is local and intact, so
   * the digest of the range `[0, offset)` is always available by re-reading it. That re-read is the
   * whole cost of accepting the re-align, and it is bounded by the offset, not by the transfer.
   *
   * WHY FINISHING HERE CANNOT MASK A WRONG FILE: `offset !== size` is still fatal (the loop only stops
   * when it has sent everything), and the digest this produces is checked by the receiver against the
   * `<remote>.part` it actually holds. A hasher that described the wrong range therefore fails LOUDLY
   * at commit -- it cannot turn into a file that is quietly wrong.
   */
  if (offset !== size) {
    throw new TransferError(`${describe('upload', peerId, localPath, remotePath)}: sent ${offset} of ${size} bytes`)
  }
  if (seededFor !== size) reseedTo(size)

  // The commit response is the only body a caller needs in memory -- a fixed single-digit number of
  // bytes, read after every file byte has left, not the file.
  const commit = await commitUpload(channel, peerId, remotePath, hasher.digest(), size, opts)
  onProgress(progress('upload', peerId, remotePath, size, size, attempts, 'committed'))
  return {
    ok: true,
    direction: 'upload',
    peerId: peerLabel(peerId),
    localPath,
    remotePath,
    size,
    sha256: commit?.sha256 ?? '',
    bytes: size,
    offset,
    attempts,
    aligned,
    commit,
    elapsedMs: Date.now() - started,
  }
}

/**
 * A cheap "will the far end take this?" probe.
 *
 * WHY HEAD AND NOT NOTHING: the host ceiling and the worker ceiling can disagree (a token someone
 * else holds, a worker configured tighter). `HEAD /file` answers the worker's view of the size for
 * the price of one round trip, so a refusal arrives before the first byte. It is best-effort: a
 * relay older than the endpoint, or one that answers with no length, must not block a transfer that
 * would have worked.
 */
async function probeRemoteSize(channel, peerId, remotePath, maxBytes) {
  if (typeof channel.head !== 'function') return
  let res
  try {
    res = await channel.head(`${channel.base}/file?path=${queryValue(remotePath)}`, { headers: channel.authHeaders() })
  } catch {
    return
  }
  if (res === null || res === undefined) return
  if (res.status === 413) {
    throw new TransferError(`${describe('upload', peerId, '', remotePath)} refused by the worker: too large`, { status: TOO_LARGE })
  }
  const remoteSize = Number(res.headers?.get?.('x-file-size'))
  if (Number.isFinite(remoteSize) && maxBytes > 0 && remoteSize > maxBytes) {
    throw new TransferError(`${describe('upload', peerId, '', remotePath)} refused: the worker's copy is ${remoteSize} bytes, over the ${maxBytes}-byte limit`, { status: TOO_LARGE })
  }
}

/**
 * `POST /file/commit`: hand over the digest and the size and let the receiver verify its own `.part`.
 *
 * This is the single point at which a transfer becomes real. Nothing before it can produce a file at
 * the destination name, so a mismatch here is a normal, recoverable outcome -- it is reported with
 * both digests and the `.part` is left where it is.
 */
async function commitUpload(channel, peerId, remotePath, sha256, size, opts) {
  if (typeof channel.post !== 'function') {
    throw new TransferError(`upload to worker "${peerLabel(peerId)}": a transfer channel with post() is required to commit`)
  }
  const body = JSON.stringify({ path: remotePath, sha256, size, overwrite: opts.overwrite === true })
  const timeout = armTimeout(requestTimeout(opts), opts.signal)
  let res
  try {
    res = await request(() => channel.post(`${channel.base}/file/commit`, {
      method: 'POST',
      headers: { ...channel.authHeaders(), 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      body,
      signal: timeout.signal,
    }), peerId, 'POST /file/commit')
  } finally {
    timeout.disarm()
  }
  let detail = null
  try { detail = await res.json() } catch { /* handled below per status */ }
  if (res.status !== 200) {
    const err = httpError(peerId, 'POST /file/commit', res.status, detail)
    if (res.status === FILE_EXISTS) {
      throw new TransferError(`${describe('upload', peerId, '', remotePath)} refused: the target exists on the worker (pass overwrite to replace it)`, { status: FILE_EXISTS, detail })
    }
    // A 400 here is the integrity check failing. Saying which digest the receiver computed is what
    // makes it debuggable at all -- the two values differ, and the difference IS the diagnosis.
    if (err.status === 400) {
      const expected = typeof detail?.expected === 'string' ? detail.expected : sha256
      const actual = typeof detail?.actual === 'string' ? detail.actual : ''
      throw new TransferError(`${describe('upload', peerId, '', remotePath)} failed verification: worker sees sha256 ${actual || '(unknown)'} for its staged copy, host computed ${expected}`, { status: 400, detail })
    }
    throw err
  }
  return detail
}

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

/**
 * Pull a file from the worker by streaming its body straight to disk.
 *
 * WHY THE BODY IS CONSUMED AS AN ASYNC ITERATOR AND NOT VIA `pipeline()`: `pipeline` is the tidier
 * construct when the destination is a path, but this destination is a handle that must stay open
 * across a resume (closing it per attempt would turn a resume into a truncate). Iterating gives the
 * same backpressure -- nothing is read until the previous slice has been written -- while keeping one
 * handle, and the digest is folded into the same loop rather than a second pass over the bytes.
 *
 * @param {object} opts
 * @param {string} opts.peerId
 * @param {string} opts.remotePath
 * @param {string} opts.destPath            final local path; written only by an atomic rename
 * @param {object} opts.channel
 * @param {string} opts.channel.base
 * @param {() => Record<string, string>} opts.channel.authHeaders
 * @param {(url: string, init: object) => Promise<object>} opts.channel.get
 * @param {boolean} [opts.overwrite]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.onProgress]
 * @returns {Promise<{ ok: true, direction: 'download', peerId: string, remotePath: string,
 *                     localPath: string, size: number, sha256: string, bytes: number,
 *                     resumedFrom: number, alreadyComplete: boolean, remote: object,
 *                     replacedNonAtomically: boolean, warnings: string[], elapsedMs: number }>}
 */
export async function downloadFile(opts) {
  const started = Date.now()
  const peerId = opts.peerId
  const remotePath = String(opts.remotePath ?? '')
  const destPath = String(opts.destPath ?? '')
  const channel = opts.channel
  if (channel === undefined || channel === null || typeof channel.get !== 'function') {
    throw new TransferError(`download from worker "${peerLabel(peerId)}": a transfer channel with get() is required`)
  }
  assertUsablePath(remotePath, 'remote')
  assertUsablePath(destPath, 'local')

  const maxBytes = Number.isFinite(opts.maxBytes) ? Number(opts.maxBytes) : DEFAULT_TRANSFER_MAX_BYTES
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}
  const partPath = opts.partPath === undefined ? partPathFor(destPath) : String(opts.partPath)
  const state = pathState(destPath)

  if (existsSync(destPath) && opts.overwrite !== true) {
    // Refusing is the data-safe default: a silent overwrite is the failure class this whole option
    // exists for. Reported with the path so the caller can retry deliberately.
    throw new TransferError(`${describe('download', peerId, remotePath, destPath)} refused: ${destPath} already exists (pass overwrite to replace it)`, { status: FILE_EXISTS })
  }
  ensureDir(dirname(destPath))

  let attempts = 0
  let restarted = 0
  let staleDropped = false
  for (;;) {
    attempts += 1
    const startOffset = existsSync(partPath) ? statSync(partPath).size : 0

    let res
    try {
      res = await getFile(channel, peerId, remotePath, startOffset, opts)
    } catch (error) {
      /**
       * 416 is the receiver saying our resume point is past the end of the remote file, which happens
       * when something OUTSIDE this transfer shrank or replaced the file. Retrying that offset is a
       * guaranteed infinite loop and resuming is impossible, so the stale staging file is dropped and
       * the pull starts over -- once. A second 416 means the remote is moving faster than we can read
       * it, and saying so is more useful than another attempt.
       */
      if (error?.status !== RANGE_NOT_SATISFIABLE || staleDropped) throw error
      staleDropped = true
      rmSync(partPath, { force: true })
      continue
    }
    const remote = readRemoteMeta(res)
    if (maxBytes > 0 && remote.size > maxBytes) {
      throw new TransferError(`${describe('download', peerId, remotePath, destPath)} refused: ${remote.size} bytes exceeds the ${maxBytes}-byte limit`, { status: TOO_LARGE })
    }

    if (startOffset >= remote.size && remote.size > 0) {
      // The staging file is at least as long as the remote claims to be: either a previous attempt
      // finished the bytes, or the remote got SHORTER since. The digest decides, and re-hashing a
      // local file is far cheaper than re-downloading one.
      const localHash = hashFileSync(partPath)
      if (localHash === remote.sha256) {
        truncateSync(partPath, remote.size)
        finishDownload(partPath, destPath, state)
        onProgress(progress('download', peerId, remotePath, remote.size, remote.size, attempts, 'renamed'))
        return {
          ok: true, direction: 'download', peerId: peerLabel(peerId), remotePath, localPath: destPath,
          size: remote.size, sha256: remote.sha256, bytes: remote.size, resumedFrom: startOffset,
          alreadyComplete: true, remote, replacedNonAtomically: state.replacedNonAtomically,
          warnings: state.warnings, elapsedMs: Date.now() - started,
        }
      }
      // The bytes on disk are not this file. Keeping a staging file we already know to be wrong
      // would make every following attempt fail the same way.
      rmSync(partPath, { force: true })
      continue
    }

    const hasher = createHasher()
    if (startOffset > 0) {
      // Seed from what is already on disk so the digest covers the whole file, not just this tail.
      seedPrefix(hasher, partPath, startOffset)
    }
    let seen = startOffset
    const fd = openSync(partPath, 'a')
    try {
      await streamBody(res, fd, peerId, (chunk) => {
        // One pass, two products: the digest of the whole file and the live progress figure. Reading
        // the staged prefix again purely to hash it would double the cost of every resume.
        hasher.update(chunk)
        seen += chunk.length
        onProgress(progress('download', peerId, remotePath, Math.min(remote.size || seen, seen), remote.size, attempts, 'receiving'))
      }, opts)
    } finally {
      closeSync(fd)
    }

    const have = statSync(partPath).size
    if (have !== remote.size) {
      throw new TransferError(`${describe('download', peerId, remotePath, destPath)}: received ${have} of ${remote.size} bytes, staged copy kept at ${partPath} for resume`)
    }

    const actual = hasher.digest()
    if (remote.sha256 === '' || actual === remote.sha256) {
      // An empty `x-file-sha256` means the worker could not tell us; the size is then the only
      // evidence there is, and pretending otherwise would refuse every download from an older relay.
      finishDownload(partPath, destPath, state)
      onProgress(progress('download', peerId, remotePath, remote.size, remote.size, attempts, 'renamed'))
      return {
        ok: true, direction: 'download', peerId: peerLabel(peerId), remotePath, localPath: destPath,
        size: remote.size, sha256: actual, bytes: actual === remote.sha256 ? remote.size : have,
        resumedFrom: startOffset, alreadyComplete: false, remote,
        replacedNonAtomically: state.replacedNonAtomically, warnings: state.warnings,
        elapsedMs: Date.now() - started,
      }
    }

    if (restarted >= 1) {
      // Two attempts have disagreed with the advertised digest. Repeating the download cannot fix a
      // remote that is changing underneath us, so it is reported instead of retried forever.
      throw new TransferError(`${describe('download', peerId, remotePath, destPath)} failed verification after restart: host computed sha256 ${actual}, worker advertised ${remote.sha256} (staged copy kept at ${partPath})`, { status: 400 })
    }
    restarted += 1

    // Keeping the longest prefix the two digests agree on costs one comparison and sometimes saves a
    // whole re-send (see `digestDivergence`); it must never be relied on to localize the damage.
    const divergeAtByte = Math.floor(digestDivergence(remote.sha256, actual) / 2)
    if (divergeAtByte >= 1) {
      truncateSync(partPath, Math.min(divergeAtByte, statSync(partPath).size))
      continue
    }
    rmSync(partPath, { force: true })
  }
}

/**
 * The post-transfer state of one destination file, with a warning channel for the rare cases.
 *
 * WHY A LITTLE STATE OBJECT AND NOT A MODULE-LEVEL ARRAY: the one fact worth reporting about a rename
 * is "it still cost more than an atomic rename", and that fact belongs to ONE transfer. A shared
 * buffer would have to be drained by whichever call happened to run next, which is how a warning ends
 * up attached to the wrong file -- or to none.
 */
function pathState(path) {
  return {
    path,
    /** True for the whole transfer after a non-atomic replace was needed once. */
    replacedNonAtomically: false,
    /** @type {string[]} */
    warnings: [],
    note(message) {
      this.warnings.push(message)
    },
  }
}

/**
 * Move the verified staging file into place.
 *
 * WHY THE UNLINK IS A FALLBACK AND NOT THE PATH: `rename` is atomic, unlink-then-rename is not -- it
 * has a window in which the destination does not exist at all. On every platform this plugin targets,
 * a rename over an existing file succeeds (POSIX `rename(2)`, Windows via `MoveFileEx` with replace),
 * so the fallback should never run; it exists because a filesystem that refuses to replace (a share,
 * an antivirus holding a handle) must degrade to "worked, with a brief gap" rather than "failed".
 * Every fallback is recorded, so a silent degradation cannot hide. See also the header's invariant 2.
 */
function replaceFile(from, to, state) {
  try {
    renameSync(from, to)
    return true
  } catch (error) {
    const code = error?.code
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') {
      throw new TransferError(`cannot move ${from} into place at ${to}: ${error instanceof Error ? error.message : String(error)}`)
    }
    state.replacedNonAtomically = true
    state.note(`had to replace ${to} in two steps (${code}); the destination path was briefly absent`)
  }
  try {
    rmSync(to, { force: true })
    renameSync(from, to)
    return true
  } catch (error) {
    throw new TransferError(`cannot move ${from} into place at ${to}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Atomic-move the staged file into place, carrying the destination's state so a non-atomic fallback
 * reaches the caller instead of vanishing. `overwrite` is not consulted: the rename replaces whatever
 * is at the destination in one step, and the refusal for an existing file happens BEFORE any bytes are
 * staged, so a refused download costs nothing.
 */
function finishDownload(partPath, destPath, state) {
  replaceFile(partPath, destPath, state)
}

/** Everything the response headers say about the remote file, normalized and typed. */
function readRemoteMeta(res) {
  const header = (name) => {
    const value = res?.headers?.get?.(name)
    return value === undefined || value === null ? '' : String(value)
  }
  const size = Number(header('x-file-size'))
  return {
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    sha256: header('x-file-sha256').toLowerCase(),
    // The worker echoes the RESOLVED absolute path; keeping it is what makes the audit row say where
    // the bytes really went rather than where we guessed.
    path: header('x-file-path'),
    mtime: header('x-file-mtime'),
    offset: Number(header('x-file-offset')) || 0,
  }
}

/**
 * One `GET /file`, with the two statuses that mean "your resume point is stale" handled where they
 * occur rather than by the caller.
 *
 * WHY 416 GETS ITS OWN PATH: `offset >= size` on the receiver means the staging file is LONGER than
 * the remote. Something outside this transfer shrank the remote file. Resuming is impossible and
 * retrying the same offset is a guaranteed infinite loop, so the stale staging file is dropped and
 * the download starts over -- once, loudly, because it costs a full re-send the operator may want to
 * know about.
 */
async function getFile(channel, peerId, remotePath, offset, opts) {
  const suffix = offset > 0 ? `&offset=${offset}` : ''
  const url = `${channel.base}/file?path=${queryValue(remotePath)}${suffix}`
  const timeout = armTimeout(requestTimeout(opts), opts.signal)
  let res
  try {
    res = await request(() => channel.get(url, {
      headers: channel.authHeaders(),
      signal: timeout.signal,
    }), peerId, `GET /file (offset ${offset})`)
  } finally {
    timeout.disarm()
  }
  if (res.status === 200 || res.status === 206) return res
  const detail = await readErrorDetail(res)
  throw httpError(peerId, `GET /file (offset ${offset})`, res.status, detail)
}

/**
 * Stream a response body into an already-open, already-positioned file handle.
 *
 * The handle stays open across a resume precisely so a retry can continue at the byte it reached;
 * reopening it per attempt is what would make a resume silently start over.
 */
async function streamBody(res, fd, peerId, onChunk, opts) {
  const body = res.body
  if (body === null || body === undefined) {
    throw new TransferError(`worker "${peerLabel(peerId)}" returned HTTP ${res.status} with no body`)
  }
  let written = 0
  try {
    const stream = Readable.fromWeb(body)
    for await (const chunk of stream) {
      if (opts.signal?.aborted === true) {
        stream.destroy()
        throw new TransferError(`worker "${peerLabel(peerId)}" download aborted after ${written} bytes`)
      }
      writeAll(fd, chunk, null)
      written += chunk.length
      onChunk(chunk)
    }
  } catch (error) {
    if (error instanceof TransferError) throw error
    // The staged bytes are deliberately NOT removed: they are the resume point the next attempt
    // starts from, and deleting them would turn an interrupted link into a full re-transfer.
    throw new TransferError(`worker "${peerLabel(peerId)}" download failed after ${written} bytes: ${error instanceof Error ? error.message : String(error)}`)
  }
  return written
}

// ---------------------------------------------------------------------------
// small RPC helpers
// ---------------------------------------------------------------------------

/**
 * The transport options of an RPC call, separated from the call's own arguments.
 *
 * WHY THEY MUST NOT BE FORWARDED TOGETHER: `listFiles` takes a `limit` and the channel takes a
 * `timeoutMs`. Passing the caller's whole options object as the transport options hands `limit` to the
 * bridge, which is one typo away from a real argument (or a real timeout) travelling in the wrong
 * field. The split is stated here once so both helpers cannot disagree about it.
 */
function rpcOptions(opts) {
  return Number.isFinite(opts?.timeoutMs) ? { timeoutMs: Number(opts.timeoutMs) } : {}
}

/**
 * `statFile` -- "does this exist, how big is it, is it a directory" over the WS channel.
 *
 * WHY THE RPC AND NOT `HEAD /file`: existence and kind are a handful of bytes, and the JSON-RPC
 * channel is already authenticated and already connected. `HEAD` is kept for the pre-flight size
 * check, where the headers are the point.
 *
 * @param {{ rpc: (method: string, params: object, opts?: object) => Promise<object> }} client
 * @param {string} path
 * @returns {Promise<{ ok: boolean, path: string, exists: boolean, isDir: boolean, size: number, mtime: string, sha256: string }>}
 */
export async function statFile(client, path, opts = {}) {
  if (typeof path !== 'string' || path === '' || path.includes('\u0000')) {
    throw new TransferError('stat requires a non-empty path with no NUL bytes')
  }
  if (client === undefined || typeof client.rpc !== 'function') {
    throw new TransferError('stat requires a connection to the worker (not connected)')
  }
  const result = await client.rpc('dsh-remote/stat', { path }, rpcOptions(opts))
  return {
    ok: result?.ok !== false,
    path: String(result?.path ?? path),
    exists: result?.exists === true,
    isDir: result?.isDir === true,
    // A directory has no meaningful size, and reporting a filesystem block count as one reads as a
    // real number the caller then compares against a budget.
    size: result?.isDir === true ? 0 : (Number(result?.size) || 0),
    mtime: typeof result?.mtime === 'string' ? result.mtime : '',
    sha256: typeof result?.sha256 === 'string' ? result.sha256 : '',
  }
}

/**
 * `listFiles` -- one directory's entries, over the same channel.
 *
 * @param {{ rpc: Function }} client
 * @param {string} path
 * @param {{ limit?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, path: string, entries: Array<{name: string, isDir: boolean, size: number, mtime: string}>, truncated: boolean }>}
 */
export async function listFiles(client, path, opts = {}) {
  if (typeof path !== 'string' || path === '' || path.includes('\u0000')) {
    throw new TransferError('list requires a non-empty path with no NUL bytes')
  }
  if (client === undefined || typeof client.rpc !== 'function') {
    throw new TransferError('list requires a connection to the worker (not connected)')
  }
  const params = { path }
  if (Number.isFinite(opts.limit)) params.limit = Math.max(0, Math.floor(Number(opts.limit)))
  const result = await client.rpc('dsh-remote/list', params, rpcOptions(opts))
  const entries = Array.isArray(result?.entries) ? result.entries : []
  return {
    ok: result?.ok !== false,
    path: String(result?.path ?? path),
    entries: entries.map((entry) => ({
      name: String(entry?.name ?? ''),
      isDir: entry?.isDir === true,
      size: entry?.isDir === true ? 0 : (Number(entry?.size) || 0),
      mtime: typeof entry?.mtime === 'string' ? entry.mtime : '',
    })),
    truncated: result?.truncated === true,
  }
}

/**
 * Give up on a transfer by removing the WORKER's staging file.
 *
 * WHY THIS CANNOT TOUCH THE TARGET: the contract says `DELETE /file` removes `<path>.part` and
 * nothing else. That is what makes "cancel" safe to offer at all -- the worst outcome of giving up
 * is losing resume progress, never a file.
 *
 * @param {object} opts
 * @param {string} opts.peerId
 * @param {string} opts.remotePath
 * @param {object} opts.channel
 * @returns {Promise<{ ok: boolean, removed: boolean, part: string }>}
 */
export async function abortTransfer(opts) {
  const peerId = opts.peerId
  const remotePath = String(opts.remotePath ?? '')
  const channel = opts.channel
  assertUsablePath(remotePath, 'remote')
  if (channel === undefined || typeof channel.del !== 'function') {
    throw new TransferError(`abort on worker "${peerLabel(peerId)}": a transfer channel with del() is required`)
  }
  const timeout = armTimeout(requestTimeout(opts), opts.signal)
  let res
  try {
    res = await request(() => channel.del(`${channel.base}/file?path=${queryValue(remotePath)}`, {
      method: 'DELETE',
      headers: channel.authHeaders(),
      signal: timeout.signal,
    }), peerId, 'DELETE /file')
  } finally {
    timeout.disarm()
  }
  if (res.status !== 200) throw httpError(peerId, 'DELETE /file', res.status, await readErrorDetail(res))
  let body = null
  try { body = await res.json() } catch { /* a 200 with no body still removed nothing or something */ }
  return { ok: true, removed: body?.removed === true, part: String(body?.part ?? partPathFor(remotePath)) }
}

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------

/** The contract's 400 cases, checked here so no request is spent on a path the worker must reject. */
function assertUsablePath(value, which) {
  if (typeof value !== 'string' || value === '') {
    throw new TransferError(`${which} path is required`)
  }
  if (value.includes('\u0000')) {
    throw new TransferError(`${which} path contains a NUL byte`)
  }
}

function requestTimeout(opts) {
  return Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : DEFAULT_TRANSFER_REQUEST_TIMEOUT_MS
}

/** One progress shape for both directions, so the renderer has one thing to understand. */
function progress(direction, peerId, path, offset, total, attempts, phase) {
  const size = Number.isFinite(total) ? total : 0
  return {
    direction,
    peerId: peerLabel(peerId),
    path,
    offset,
    bytes: offset,
    total: size,
    percent: size > 0 ? Math.min(100, Math.round((offset / size) * 1000) / 10) : 0,
    attempts,
    phase,
  }
}

/**
 * Combine the caller's cancellation with a wall-clock budget.
 *
 * WHY BOTH: `AbortSignal.any` in principle, but Node 20 support for it arrived late and a plugin
 * that only works on the newest runtime is a support burden. Two listeners plus a timer is four
 * lines and behaves identically. `unref` matters: a pending transfer must not keep the host process
 * alive after the operator quits DSH.
 */
function armTimeout(timeoutMs, outer) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new TransferError(`transfer request exceeded ${timeoutMs} ms`)), Math.max(1, timeoutMs))
  if (typeof timer.unref === 'function') timer.unref()
  const relay = () => controller.abort(outer?.reason)
  if (outer !== undefined && outer !== null) {
    if (outer.aborted === true) controller.abort(outer.reason)
    else outer.addEventListener('abort', relay, { once: true })
  }
  return {
    signal: controller.signal,
    disarm() {
      clearTimeout(timer)
      outer?.removeEventListener?.('abort', relay)
    },
  }
}

/** Re-exported so a caller that needs one file's digest does not have to reimplement it. */
export { sha256Of }
