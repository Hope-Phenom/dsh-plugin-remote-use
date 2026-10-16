// End-to-end file transfer: the MASTER's transfer layer against a REAL relay over real HTTP.
//
// WHY THIS FILE EXISTS: both halves were tested without a socket. `test/file-transfer.test.js`
// exercises the relay's pure helpers against fake streams; `test/transfer.test.js` drives the
// master's chunking against a fake `channel`. Neither would notice a disagreement between them --
// a header the master never reads, a status the relay never returns, a query the relay decodes
// differently than the master encodes it. That gap is exactly where the `+`-in-a-filename bug lived,
// and it is why this test spawns the actual `slave/relay.mjs` and talks to it with the actual
// `PeerConnection`.
//
// WHAT IT DELIBERATELY DOES NOT COVER, AND WHY THAT IS A REAL GAP: the `stat`/`list` RPCs. They need
// a WebSocket, and the relay spawns the ACP agent the moment one connects. This file therefore covers
// the HTTP half only, and the RPC routing in `relay.mjs` is exercised by nothing but the relay's own
// unit tests -- which test the pure helpers, not the routing.
//
// It is coverable, and this note exists so the next person does not repeat the wrong reason: start the
// relay with a stub `--cmd-file` (e.g. `{"command": <node>, "args": ["-e", "process.stdin.resume()"]}`)
// so the connection brings up a trivial child instead of a real DSH, then drive `statFile`/`listFiles`
// through `PeerConnection` with a `createBridge` that opens the real WebSocket.
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { PeerConnection } from '../lib/bridge/peer-connection.js'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const RELAY = join(PKG, 'slave', 'relay.mjs')
const TOKEN = 'e2e-transfer-token'

/** 5 MiB with the default 4 MiB chunk: two PUTs, so the chunked path is genuinely exercised. */
const FIVE_MIB = 5 * 1024 * 1024
/** Over the relay's 6 MiB ceiling, and it only goes over on the SECOND chunk. */
const SEVEN_MIB = 7 * 1024 * 1024
const RELAY_CEILING = 6 * 1024 * 1024

/** A port the OS just handed out and took back. The race is a few microseconds wide. */
async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** Not compressible and not all-zero, so a truncated or offset-shifted write is visible. */
function payload(size) {
  const buf = Buffer.allocUnsafe(size)
  let x = 0x2545f491
  for (let i = 0; i < size; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    buf[i] = (x >>> 16) & 0xff
  }
  return buf
}

async function startRelay(taskDir, shotDir, token = TOKEN) {
  const port = await freePort()
  const child = spawn(process.execPath, [
    RELAY,
    '--port', String(port),
    '--token', token,
    '--max-transfer-bytes', String(RELAY_CEILING),
    // Keep every write out of the package directory: a test must not litter the thing it tests.
    '--shot-dir', shotDir,
    '--pairing-file', '',
  ], { cwd: taskDir, stdio: ['ignore', 'pipe', 'pipe'] })

  let stderr = ''
  child.stderr.on('data', (d) => { stderr += String(d) })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 15_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`relay exited early (${child.exitCode}): ${stderr}`)
    try {
      const res = await fetch(`${base}/healthz`, { headers: { authorization: `Bearer ${token}` } })
      if (res.status === 200) break
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`relay never became ready: ${stderr}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { child, base, port }
}

function partsIn(dir) {
  return readdirSync(dir).filter((n) => n.endsWith('.part'))
}

test('the chunk size reaches the wire, from the connection default AND from a per-call override', async (t) => {
  // The shape this guards against: `transferChunkBytes` configured, plumbed into the config object,
  // documented -- and dropped between the connection and the core, so every transfer silently used
  // the built-in 4 MiB. Nothing else would notice, because the file still arrives correctly.
  //
  // The only external evidence of how much travelled per request is the progress callback, so the
  // count of those events IS the assertion. A 200 KiB file is one request at 1 MiB and four at 64 KiB.
  const root = mkdtempSync(join(tmpdir(), 'transfer-chunk-'))
  const taskDir = join(root, 'task')
  const shotDir = join(root, 'shots')
  const receiveDir = join(root, 'received')
  for (const d of [taskDir, shotDir, receiveDir]) mkdirSync(d, { recursive: true })

  const { child, base } = await startRelay(taskDir, shotDir)
  t.after(async () => {
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
    rmSync(root, { recursive: true, force: true })
  })

  const buf = payload(200 * 1024)
  const local = join(root, 'chunked.bin')
  writeFileSync(local, buf)

  // (a) the CONNECTION's own setting, with no per-call override.
  const small = []
  const connA = new PeerConnection({
    peerId: 'chunk-a', httpBase: base, token: TOKEN, receiveDir, transferChunkBytes: 64 * 1024,
  })
  await connA.sendFile({ localPath: local, remotePath: 'a.bin', onProgress: (p) => small.push(p) })
  assert.equal(sha256(readFileSync(join(taskDir, 'a.bin'))), sha256(buf))
  assert.ok(small.length >= 4,
    `64 KiB chunks over 200 KiB must report several requests, saw ${small.length}`)

  // (b) a per-call override must win over that default.
  const big = []
  await connA.sendFile({
    localPath: local, remotePath: 'b.bin', chunkBytes: 1024 * 1024, onProgress: (p) => big.push(p),
  })
  assert.equal(sha256(readFileSync(join(taskDir, 'b.bin'))), sha256(buf))
  assert.ok(big.length < small.length,
    `1 MiB chunks must need fewer requests than 64 KiB ones (${big.length} vs ${small.length})`)
  assert.equal(big.length, 2, 'one request plus the commit, for a file smaller than one chunk')
})

test('a real relay: upload, verify, download, refuse to overwrite, and hold the ceiling', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'transfer-e2e-'))
  const taskDir = join(root, 'task')
  const shotDir = join(root, 'shots')
  const receiveDir = join(root, 'received')
  for (const d of [taskDir, shotDir, receiveDir]) mkdirSync(d, { recursive: true })

  const { child, base } = await startRelay(taskDir, shotDir)
  t.after(async () => {
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
    rmSync(root, { recursive: true, force: true })
  })

  const conn = new PeerConnection({ peerId: 'e2e', httpBase: base, token: TOKEN, receiveDir })

  const big = payload(FIVE_MIB)
  const bigLocal = join(root, 'big.bin')
  writeFileSync(bigLocal, big)

  // ---- upload -------------------------------------------------------------------------------
  const sent = await conn.sendFile({ localPath: bigLocal, remotePath: 'big.bin' })
  const landed = join(taskDir, 'big.bin')
  assert.equal(existsSync(landed), true, 'the file must exist on the worker at the resolved path')
  assert.equal(statSync(landed).size, FIVE_MIB)
  assert.equal(sha256(readFileSync(landed)), sha256(big), 'the bytes must survive the transfer')
  assert.equal(Number(sent.bytes), FIVE_MIB)
  assert.deepEqual(partsIn(taskDir), [], 'a committed transfer leaves no .part behind')

  // ---- HEAD is a cheap probe, and must stay one ------------------------------------------------
  // The digest is a response HEADER, so producing it means reading the whole file. A HEAD exists to
  // avoid exactly that, so a plain HEAD reports the size and leaves the digest out; `hash=1` asks for
  // it explicitly. Asserting on the header's presence (not on elapsed time) keeps this deterministic.
  const headRes = await fetch(`${base}/file?path=big.bin`, {
    method: 'HEAD', headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(headRes.status, 200)
  assert.equal(headRes.headers.get('x-file-size'), String(FIVE_MIB), 'the probe must still report the size')
  assert.equal(headRes.headers.get('x-file-sha256'), null,
    'a plain HEAD must not read the whole file just to fill a header nobody asked for')
  const hashedRes = await fetch(`${base}/file?path=big.bin&hash=1`, {
    method: 'HEAD', headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(hashedRes.headers.get('x-file-sha256'), sha256(big), 'hash=1 asks for the digest')

  // ---- download -----------------------------------------------------------------------------
  const dest = join(receiveDir, 'got.bin')
  const got = await conn.fetchFile({ remotePath: 'big.bin', destPath: dest })
  assert.equal(sha256(readFileSync(dest)), sha256(big), 'the pulled bytes must match the pushed ones')
  assert.equal(Number(got.bytes), FIVE_MIB)
  assert.equal(existsSync(`${dest}.part`), false, 'the staging file must be renamed away, not left')

  // ---- overwrite is opt-in ------------------------------------------------------------------
  // The destination exists, so the default must refuse: a silent replace is data loss with no error
  // in it, and the relay is the last place that can stop it.
  await assert.rejects(
    () => conn.sendFile({ localPath: bigLocal, remotePath: 'big.bin' }),
    (error) => /exist|overwrite/iu.test(error.message),
    'a second upload without overwrite must be refused',
  )
  const again = await conn.sendFile({ localPath: bigLocal, remotePath: 'big.bin', overwrite: true })
  assert.equal(Number(again.bytes), FIVE_MIB, 'with overwrite it must go through')

  // ---- the relay's hard ceiling -------------------------------------------------------------
  // 7 MiB against a 6 MiB relay ceiling. The first 4 MiB chunk is accepted and the second is
  // refused, so this also proves the ceiling is enforced MID-transfer rather than only up front.
  const tooBig = join(root, 'too-big.bin')
  writeFileSync(tooBig, payload(SEVEN_MIB))
  await assert.rejects(
    () => conn.sendFile({ localPath: tooBig, remotePath: 'too-big.bin' }),
    (error) => /413|ceiling|too large|max-transfer/iu.test(error.message),
    `an over-ceiling transfer must name the ceiling, got: ${String(tooBig)}`,
  )
  assert.equal(existsSync(join(taskDir, 'too-big.bin')), false,
    'nothing may appear at the destination when the transfer was refused')
  assert.deepEqual(partsIn(taskDir), ['too-big.bin.part'],
    'the partial file must SURVIVE the refusal -- that is the resume point')

  // ---- the token is actually checked --------------------------------------------------------
  const stranger = new PeerConnection({ peerId: 'stranger', httpBase: base, token: 'not-the-token', receiveDir })
  await assert.rejects(
    () => stranger.fetchFile({ remotePath: 'big.bin', destPath: join(receiveDir, 'nope.bin') }),
    (error) => /401|unauthor/iu.test(error.message),
    'a wrong token must be refused, not served',
  )
  assert.equal(existsSync(join(receiveDir, 'nope.bin')), false)
})
