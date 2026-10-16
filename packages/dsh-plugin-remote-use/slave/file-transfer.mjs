/**
 * The worker half of DSH's file transfer: path resolution, ranges, hashing and the `.part` dance.
 *
 * Kept in its own module for the same reason `prune-shots.mjs` is -- `relay.mjs` starts listening on
 * a port the moment it is imported, so nothing inside it can be unit-tested. Every decision that can
 * be wrong lives here, where a test can reach it.
 *
 * Node builtins only, like its siblings: this file is copied to a worker next to `relay.mjs` and must
 * not drag anything else along.
 *
 * STREAMING IS NOT A STYLE PREFERENCE HERE. The bytes have no upper bound -- `--max-transfer-bytes`
 * defaults to 8 GiB, and the whole point of the feature is moving files that are too large to be
 * convenient. A single `readFileSync` on a request path therefore turns one 8 GiB copy into 8 GiB of
 * resident memory plus an 8 GiB Buffer concatenation, which on a worker is an out-of-memory kill and
 * a lost transfer. `GET /screenshot` reads a ~9.5 MB PNG into memory and that is precisely the pattern
 * NOT repeated here: every read in this file is a stream, and every hash is fed chunk by chunk.
 *
 * The protocol this implements is frozen in `.research/transfer-protocol.md`; the relay owns the HTTP
 * shape and this module owns the rules.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { open, readdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * The worker's hard ceiling, in bytes.
 *
 * 8 GiB because that is also the master's default: the two defaults agreeing is what keeps a transfer
 * that never touched either flag from failing at the last chunk. This side is the one that matters --
 * a master's budget is a politeness, an operator's disk is not.
 */
export const DEFAULT_MAX_TRANSFER_BYTES = 8 * 1024 * 1024 * 1024

/**
 * Chunk size the master is expected to use, exported so both sides can name one number.
 * 4 MiB balances syscall count against the size of the re-send when a chunk fails.
 */
export const TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024

/** How many directory entries `list` returns when the caller does not say. */
export const DEFAULT_LIST_LIMIT = 1000

/** A commit request is a path plus a 64-character hash; anything near this is not one. */
export const DEFAULT_JSON_BODY_BYTES = 64 * 1024

/** The suffix a transfer lands under before it is allowed to take its real name. */
export const PART_SUFFIX = '.part'

/**
 * Read a byte ceiling, falling back to the default for anything unusable.
 *
 * WHY A NONSENSE VALUE KEEPS THE CEILING rather than removing it: `--max-transfer-bytes 0` reads as
 * "no limit" to the person typing it and as "reject every byte" to the code, and both readings are
 * worse than the default. `prune-shots.mjs` solved the same ambiguity for the shot cache by treating
 * 0 as "no budget" -- that is the safe direction there (the failure mode is disk usage) and the
 * UNSAFE direction here (the failure mode is a full disk on a machine nobody is sitting at). So an
 * unusable value silently means 8 GiB, and the flag cannot be used to remove the ceiling by accident.
 *
 * @param {unknown} raw the flag's value, or a non-number for "not given"
 * @returns {number} a positive byte count
 */
export function maxTransferBytesOf(raw) {
  // Deliberately not `Number(raw)`: `'64'` is not a number anyone clearly meant, and `prune-shots.mjs`
  // refuses `'20'` for the count budget for exactly this reason.
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_TRANSFER_BYTES
}

/**
 * Turn a request's `path` into the absolute path this worker will actually touch.
 *
 * Relative means "relative to the task directory" -- the relay's working directory, the one `/healthz`
 * reports, which is the directory the operator started the relay in. Absolute is used as it stands.
 *
 * THERE IS NO CAGE, deliberately. A relay is not a sandbox: the same token that asks for a file can
 * ask this process to run an arbitrary command through ACP, so refusing `D:\build` would block a real
 * deployment while stopping nothing. What replaces the cage is that the resolved path is ECHOED in
 * every response and every log line, so "which file was that, really" is always answerable.
 *
 * @param {unknown} rawPath
 * @param {string} baseDir the task directory
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
export function resolveTransferPath(rawPath, baseDir) {
  if (typeof rawPath !== 'string') return { ok: false, error: 'path is required' }
  // A whitespace-only path is a truncated request, not a filename: Windows strips trailing spaces in
  // some APIs and the result would be a file nobody asked for.
  if (rawPath.trim() === '') return { ok: false, error: 'path is required' }
  // NUL is the one byte that cannot survive the trip: it must be refused before it reaches the
  // filesystem, where some APIs silently truncate at it and others throw something unhelpful.
  if (rawPath.includes('\0')) return { ok: false, error: 'path contains a NUL byte' }
  const base = typeof baseDir === 'string' && baseDir !== '' ? baseDir : process.cwd()
  // One `resolve` covers both cases: it ignores `base` when the input is absolute and normalises
  // `.`/`..` either way, which is what makes the echoed path the path that is really used.
  return { ok: true, path: resolve(base, rawPath) }
}

/** The temporary name a transfer to `targetPath` lands under. */
export function partPathFor(targetPath) {
  return `${targetPath}${PART_SUFFIX}`
}

/**
 * A byte offset, from a URL query value or from a caller.
 *
 * The shape is checked rather than coerced, and that is not pedantry: `Number([])` is 0, `Number(true)`
 * is 1 and `Number(' ')` is 0, so a coerced offset turns "that is not a byte position" into "resume
 * from the beginning" -- a silent restart of a multi-gigabyte transfer instead of a 400.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, offset: number } | { ok: false, error: string }}
 */
function offsetOf(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, offset: 0 }
  const error = { ok: false, error: `offset must be a non-negative integer (got ${JSON.stringify(raw)})` }
  if (typeof raw === 'string') {
    // Only digits: `'1e3'` and `'0x10'` are not offsets anyone typed on purpose.
    if (!/^[0-9]+$/u.test(raw)) return error
    return { ok: true, offset: Number(raw) }
  }
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return { ok: true, offset: raw }
  return error
}

/**
 * Decide what a `GET /file` for a `size`-byte file at `offset` must answer.
 *
 * The empty-file case is the one worth stating: `offset=0` on a 0-byte file is `200` with an empty
 * body, not `416`. The protocol says "offset >= size -> 416", which read literally would make an
 * empty file undownloadable -- and an empty file is a perfectly ordinary thing to transfer.
 *
 * @param {number} size
 * @param {unknown} offset raw query value; absent/'' means 0
 * @returns {{ ok: true, status: 200 | 206, offset: number, length: number, contentRange?: string }
 *          | { ok: false, status: 400 | 416, error: string }}
 */
export function rangeOf(size, offset = 0) {
  const total = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0
  const start = offsetOf(offset)
  // A fractional or negative offset is a caller bug; 416 would say "past the end", which is a
  // different and misleading answer.
  if (!start.ok) return { ok: false, status: 400, error: start.error }
  if (start.offset === 0) return { ok: true, status: 200, offset: 0, length: total }
  if (start.offset >= total) {
    return { ok: false, status: 416, error: `offset ${start.offset} is at or past the end of a ${total}-byte file` }
  }
  return {
    ok: true,
    status: 206,
    offset: start.offset,
    length: total - start.offset,
    // The protocol's exact shape, inclusive last byte.
    contentRange: `bytes ${start.offset}-${total - 1}/${total}`,
  }
}

/**
 * Hash a file in one streaming pass.
 *
 * The size comes back with the hash because `commit` has to compare both and a second `stat` on a
 * file that is being written would be a race for no gain.
 *
 * @param {string} path
 * @returns {Promise<{ sha256: string, bytes: number }>}
 */
export async function sha256File(path) {
  const hash = createHash('sha256')
  let bytes = 0
  // `for await` pulls one chunk at a time and lets the stream apply backpressure, which is the whole
  // difference between this and `readFileSync`: resident memory stays at one chunk, whatever the file.
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { sha256: hash.digest('hex'), bytes }
}

/** `stat`, with "not there" told apart from "cannot be asked". */
async function statOrNull(path) {
  try {
    return await stat(path)
  } catch (error) {
    // ENOENT is an answer. EACCES is not: reporting a permission-denied file as "missing" is how a
    // transfer silently retries forever against a path the process may never read.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
}

/**
 * What `dsh-remote/stat` reports about a path.
 *
 * @param {string} targetPath already resolved and absolute
 * @param {{ hash?: boolean }} [opts] `hash: true` also computes the sha256 (expensive, opt-in)
 * @returns {Promise<{ exists: boolean, isDir: boolean, size: number, mtime: string | null, sha256?: string }>}
 */
export async function statTarget(targetPath, opts = {}) {
  const info = await statOrNull(targetPath)
  // `mtime: null` rather than '' for a path that is not there: both are falsy, but `null` says "this
  // field has no value" instead of "this file has an empty timestamp".
  if (info === null) return { exists: false, isDir: false, size: 0, mtime: null }
  const isDir = info.isDirectory()
  const out = { exists: true, isDir, size: isDir ? 0 : info.size, mtime: info.mtime.toISOString() }
  // Not computed unless asked for: hashing reads every byte of the file, and `stat` is the call a
  // master makes before it decides whether to transfer anything at all.
  if (opts.hash === true && !isDir) out.sha256 = (await sha256File(targetPath)).sha256
  return out
}

/**
 * List a directory.
 *
 * SORTED BY NAME, because the alternative is whatever order the filesystem hands back -- which
 * differs between NTFS and ReFS and between two runs, so two `list` calls that returned the same
 * entries would look like different answers. The master can re-sort; it cannot recover determinism.
 *
 * @param {string} targetPath
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{ ok: true, entries: object[], truncated: boolean } | { ok: false, status: number, error: string }>}
 */
export async function listDir(targetPath, opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit >= 0 ? Math.floor(opts.limit) : DEFAULT_LIST_LIMIT
  let dirents
  try {
    dirents = await readdir(targetPath, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return { ok: false, status: 404, error: `${targetPath} is not a directory` }
    }
    throw error
  }
  dirents.sort((a, b) => a.name.localeCompare(b.name))

  const entries = []
  let truncated = false
  for (const dirent of dirents) {
    if (entries.length >= limit) { truncated = true; break }
    try {
      // `stat` rather than the dirent's own flags: a symlink to a directory is a directory for every
      // purpose the master has, and the dirent would call it a symlink.
      const info = await stat(join(targetPath, dirent.name))
      const isDir = info.isDirectory()
      entries.push({
        name: dirent.name,
        isDir,
        size: isDir ? 0 : info.size,
        mtime: info.mtime.toISOString(),
      })
    } catch { /* vanished between listing and stat: an entry that no longer exists is not an entry */ }
  }
  return { ok: true, entries, truncated }
}

/** The `{ ok, status, json }` shape every rule below answers with, so the relay can just write it. */
function refusal(status, json) {
  return { ok: false, status, json }
}

/**
 * Append one chunk of an upload to `<target>.part`.
 *
 * THE ORDER OF THE CHECKS IS THE POINT, and the two interesting ones are both refusals:
 *
 *   * `413` BEFORE `409`: a chunk that would push the file over the ceiling is fatal to the whole
 *     transfer, while an offset mismatch is merely the master being out of step. Answering `409`
 *     first would make the master re-align, re-send, and only then be told the transfer cannot
 *     finish -- after moving gigabytes that were never going to be accepted.
 *   * `409` carries `expectedOffset`, which is the size of `.part` as it stands. That is the number
 *     the master needs to resume from, and it is the ONLY correct one: after an interrupted chunk the
 *     part file is neither the old size nor the requested offset.
 *
 * An interrupted body keeps `.part` on purpose. Those bytes are the resume point; deleting them would
 * turn a dropped connection into a transfer that restarts from zero.
 *
 * @param {{ target: string, offset?: unknown, contentLength?: unknown, body: AsyncIterable<Buffer>,
 *           maxBytes?: number }} options
 * @returns {Promise<{ ok: boolean, status: number, json: object, aborted?: boolean, received?: number }>}
 */
export async function putChunk(options) {
  const { target, body } = options
  const maxBytes = maxTransferBytesOf(options.maxBytes)
  const part = partPathFor(target)

  const start = offsetOf(options.offset ?? 0)
  // Non-integer offsets are caller bugs, and the difference matters: 409 would tell a master to
  // resume at a position it never asked for.
  if (!start.ok) return refusal(400, { ok: false, error: start.error })

  // 411 rather than 400: the protocol makes the differing header the identifying feature of "this
  // request cannot be handled", and a chunked PUT has no length to check against the ceiling before
  // the bytes arrive -- which is the same reason a proxy has to reject it. `null` and `''` are
  // refused as well as `undefined`: `Number(null)` is 0, which would otherwise read as a legal
  // zero-length chunk and let an unbounded body through.
  const declared = options.contentLength
  const length = declared === undefined || declared === null || declared === ''
    ? NaN
    : Number(declared)
  if (!Number.isFinite(length) || length < 0) {
    return refusal(411, { ok: false, error: 'PUT /file requires a content-length; a chunked upload cannot be bounded before it is written' })
  }
  if (start.offset + length > maxBytes) {
    return refusal(413, {
      ok: false,
      error: `this chunk would make the file ${start.offset + length} bytes, over the ${maxBytes}-byte ceiling (--max-transfer-bytes)`,
      limit: maxBytes,
    })
  }

  const partInfo = await statOrNull(part)
  const partBytes = partInfo === null ? 0 : partInfo.size
  if (partBytes !== start.offset) {
    return refusal(409, {
      ok: false,
      error: `.part is ${partBytes} bytes but this chunk starts at ${start.offset}`,
      expectedOffset: partBytes,
    })
  }

  // Create-if-missing without truncating: `'a'` extends nothing and destroys nothing, and a second
  // PUT to the same path must never silently discard the first chunk.
  // A missing PARENT is the caller's mistake, not the server's: answering 500 tells the master the
  // worker broke, and a 5xx invites a retry of a condition that will never change. 409 names the
  // directory instead, which is the actionable half.
  //
  // Deliberately NOT creating it: the destination FILE is named by the caller, its directory is not,
  // and silently materialising `D:\build` is not a side effect a file transfer should take on itself.
  const parentDir = await statOrNull(dirname(part))
  if (parentDir === null || !parentDir.isDirectory()) {
    return refusal(409, {
      ok: false,
      error: `the directory ${dirname(part)} does not exist on the worker; create it there first, or send into a directory that already exists`,
    })
  }

  const created = await open(part, 'a')
  await created.close()

  let received = 0
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      callback(null, chunk)
    },
  })
  try {
    // `start: start.offset` means the write goes exactly where the master asked, not wherever the file
    // happens to end -- the two are equal here because of the check above, and saying so explicitly
    // is what keeps them equal if that check ever moves.
    await pipeline(body, counter, createWriteStream(part, { flags: 'r+', start: start.offset }))
  } catch (error) {
    // The client is gone or the disk refused. Either way this is not a 200, but `.part` stays.
    return {
      ok: false,
      status: 499, // nginx's "client closed request"; the client that would read it is gone
      aborted: true,
      received,
      json: {
        ok: false,
        error: `upload interrupted after ${received} bytes: ${error.message}`,
        part,
        offset: start.offset,
        partBytes: start.offset + received,
      },
    }
  }

  return {
    ok: true,
    status: 200,
    received,
    json: { ok: true, path: target, part, offset: start.offset, received, partBytes: start.offset + received },
  }
}

/**
 * Verify a completed `.part` and give it its real name.
 *
 * The hash is recomputed HERE, over the bytes that are actually on the disk, rather than trusted from
 * the upload. That recomputation is the only evidence in the protocol that the file that arrived is
 * the file that was sent -- a master's own hash proves what it meant to send, not what this disk
 * received.
 *
 * A mismatch keeps `.part`. That is not tidiness: the same bytes are the resume point for a retry, and
 * deleting them would make every failed hash a full re-upload.
 *
 * @param {{ target: string, sha256?: unknown, size?: unknown, overwrite?: boolean }} options
 * @returns {Promise<{ ok: boolean, status: number, json: object }>}
 */
export async function commitPart(options) {
  const { target } = options
  const part = partPathFor(target)

  const wanted = typeof options.sha256 === 'string' ? options.sha256.trim().toLowerCase() : ''
  if (wanted === '') {
    return refusal(400, { ok: false, error: 'sha256 is required: without it there is no evidence that the bytes on disk are the requested file' })
  }
  const wantedSize = Number.isFinite(options.size) ? Number(options.size) : undefined

  const partInfo = await statOrNull(part)
  if (partInfo === null || !partInfo.isFile()) {
    // 404, not 400: the request is well-formed, the thing it refers to is not there. A commit is
    // always the last step of an upload, so this is nearly always "the transfer never completed".
    return refusal(404, { ok: false, error: `no ${PART_SUFFIX} file to commit at ${part}`, part })
  }

  const actual = await sha256File(part)
  // The HASH is checked first and is what `expected`/`actual` carry, because that is the comparison
  // the protocol calls "the only evidence the file is the one that was sent". The size, when the
  // request gave one, rides along in the message: a truncated `.part` is the common cause of a
  // mismatched digest, and "sha256 differs" alone sends the reader hunting for corruption that is
  // not there.
  if (actual.sha256 !== wanted) {
    const sizeNote = wantedSize !== undefined && wantedSize !== actual.bytes
      ? ` (the request says ${wantedSize} bytes, ${part} holds ${actual.bytes})`
      : ''
    return refusal(400, {
      ok: false,
      error: `sha256 mismatch${sizeNote}; the partial file is unchanged and can be retried`,
      expected: wanted,
      actual: actual.sha256,
    })
  }
  // Reached only when the digests agree, which two different lengths cannot do -- so this is a guard
  // against that assumption rather than a live path. It costs one comparison that has already been
  // paid for, and it keeps `size` meaning what a caller who sends it expects it to mean.
  if (wantedSize !== undefined && actual.bytes !== wantedSize) {
    return refusal(400, {
      ok: false,
      error: `size mismatch: the request says ${wantedSize} bytes, ${part} holds ${actual.bytes}`,
      expected: wantedSize,
      actual: actual.bytes,
    })
  }

  const existing = await statOrNull(target)
  if (existing !== null) {
    // A directory can never be the target of a rename, whatever `overwrite` says.
    if (existing.isDirectory()) {
      return refusal(409, { ok: false, error: `${target} is a directory`, path: target })
    }
    if (options.overwrite !== true) {
      return refusal(409, {
        ok: false,
        error: `${target} already exists; send overwrite: true to replace it`,
        path: target,
      })
    }
  }

  // fsync BEFORE the rename. Without it a crash between the rename and the writeback leaves the
  // correct name on a file whose contents are still in the page cache -- the one state the `.part`
  // scheme exists to make impossible.
  const handle = await open(part, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  // Atomic on both platforms (libuv asks Windows for MOVEFILE_REPLACE_EXISTING), and the check above
  // is the last thing before it: this relay is the only writer of these paths by contract, and a
  // rename is the only way to publish a complete file under its real name.
  await rename(part, target)

  const published = await stat(target)
  return {
    ok: true,
    status: 200,
    json: { ok: true, path: target, bytes: published.size, sha256: wanted, mtime: published.mtime.toISOString() },
  }
}

/**
 * Remove a transfer's `.part` and nothing else.
 *
 * THE TARGET IS NEVER TOUCHED. This is the master saying "I am abandoning this transfer", and a
 * cleanup that could reach the finished file would turn an abandoned upload into deleted data -- the
 * exact failure the `.part` scheme exists to prevent. `removed: false` is a success: the master wants
 * the part gone, and it is gone.
 *
 * @param {string} target
 * @returns {Promise<{ ok: true, status: 200, json: object }>}
 */
export async function deletePart(target) {
  const part = partPathFor(target)
  try {
    await unlink(part)
    return { ok: true, status: 200, json: { ok: true, removed: true, part } }
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, status: 200, json: { ok: true, removed: false, part } }
    throw error
  }
}

/**
 * Read and parse a small JSON request body, with a ceiling.
 *
 * Buffered on purpose, and the ceiling is why: the bodies this serves are a path and a hash, so
 * keeping one in memory is free, while an unbounded one is a way for anything holding the token to
 * make the relay allocate until it dies. The limit is checked as the body arrives, not afterwards --
 * a `content-length` check alone would trust a header.
 *
 * @param {AsyncIterable<Buffer>} body
 * @param {{ limitBytes?: number }} [opts]
 * @returns {Promise<{ ok: true, value: object } | { ok: false, status: number, json: object }>}
 */
export async function readJsonBody(body, opts = {}) {
  const limit = Number.isFinite(opts.limitBytes) && opts.limitBytes > 0 ? Math.floor(opts.limitBytes) : DEFAULT_JSON_BODY_BYTES
  let text = ''
  let bytes = 0
  for await (const chunk of body) {
    bytes += chunk.length
    if (bytes > limit) {
      return refusal(413, { ok: false, error: `request body is larger than ${limit} bytes`, limit })
    }
    text += chunk.toString('utf8')
  }
  if (text.trim() === '') return refusal(400, { ok: false, error: 'a JSON body is required' })

  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    return refusal(400, { ok: false, error: `body is not valid JSON: ${error.message}` })
  }
  // An array or a bare scalar parses fine and then has no `.path`, which would surface as a confusing
  // "path is required" instead of "that is not a request object".
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return refusal(400, { ok: false, error: 'body must be a JSON object' })
  }
  return { ok: true, value }
}
