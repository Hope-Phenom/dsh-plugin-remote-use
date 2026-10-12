#!/usr/bin/env node
/**
 * relay.mjs -- SLAVE side of dsh-plugin-remote-use.
 *
 * The relay is the plugin host on the worker. It bridges a WebSocket to a
 * `dsh --profile acp` child process over stdio AND serves the plugin's own RPC
 * methods, so the master can ask questions ACP has no method for:
 *
 *   ws client <--text frames (NDJSON)--> relay --+--> dsh-remote/*   (handled here)
 *                                                +--> everything else --> dsh --profile acp
 *
 * WHY THE RELAY OWNS SELF-CHECK: the readiness report has session-level checks
 * (`S7` unlocked, `S8` live input injection) that only mean anything in an
 * INTERACTIVE session -- in the services session `EnumDisplayDevices` returns nothing
 * and `SendInput` reports 0/3 even though the worker is perfectly healthy
 * (DESIGN §5.10.2.1 constraint B). The relay runs as the credential-owning user in
 * that interactive session, so a PowerShell child of the relay lands in the right
 * session and the report is real.
 *
 * Depends only on `ws` + Node builtins, deliberately: the worker should need the
 * smallest possible dependency surface.
 *
 * Usage:
 *   node relay.mjs --port 7331 --token <secret> --cmd-file <agent-spec.json>
 *                  [--selfcheck-script selfcheck.ps1] [--selfcheck-cache-ms 30000]
 *                  [--screenshot-script screenshot.ps1] [--shot-dir <dir>]
 *                  [--allow-no-auth] [--verbose]
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---------- args ----------
const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const PORT = Number(arg('port', '7331'))
const HOST = arg('host', '0.0.0.0')
const TOKEN = arg('token', '')
const CMD_FILE = arg('cmd-file', '')
const DSH_CMD = arg('dsh', 'dsh --profile acp')
const SELFCHECK_SCRIPT = arg('selfcheck-script', join(HERE, 'selfcheck.ps1'))
const SELFCHECK_CACHE_MS = Number(arg('selfcheck-cache-ms', '30000'))
const ALLOW_NO_AUTH = argv.includes('--allow-no-auth')
const VERBOSE = argv.includes('--verbose')

// ---------- screenshot ----------
const SCREENSHOT_SCRIPT = arg('screenshot-script', join(HERE, 'screenshot.ps1'))
const SHOT_DIR = arg('shot-dir', join(HERE, 'shots'))
/** The capture script writes its geometry report here; it sits next to the script. */
const SCREENSHOT_REPORT = join(dirname(SCREENSHOT_SCRIPT), 'screenshot-report.txt')

/** Plugin RPC namespace. Anything here is handled locally, never forwarded to ACP. */
const PLUGIN_PREFIX = 'dsh-remote/'

/**
 * Load the ACP agent launch spec.
 *
 * Preferred: a JSON file `{command, args, env}`. Spawning an executable with an argv
 * ARRAY avoids every Windows quoting hazard: `cmd.exe /c` loses quotes through the
 * PowerShell->node hand-off, and Node refuses to spawn a `.cmd` without a shell
 * (EINVAL). The spec must point at `<install>\DeepSeek Harness.exe` and replicate what
 * `dsh.cmd` does, rather than launching the shim (DESIGN §13.1).
 */
function loadLaunchSpec() {
  if (CMD_FILE !== '') {
    const raw = readFileSync(CMD_FILE, 'utf8').replace(/^\uFEFF/, '')
    const spec = JSON.parse(raw)
    if (typeof spec?.command !== 'string' || !Array.isArray(spec?.args)) {
      throw new Error(`--cmd-file ${CMD_FILE} must contain {"command":string,"args":string[]}`)
    }
    return { command: spec.command, args: spec.args, env: spec.env ?? {} }
  }
  const parts = (DSH_CMD.match(/"[^"]*"|\S+/g) ?? []).map((s) => s.replace(/^"|"$/g, ''))
  return { command: parts[0], args: parts.slice(1), env: {} }
}

const LAUNCH = loadLaunchSpec()

const log = (...a) => console.log(`[relay ${new Date().toISOString().slice(11, 23)}]`, ...a)
const vlog = (...a) => { if (VERBOSE) log(...a) }

/**
 * Read a text file, tolerating the encoding Windows PowerShell actually produces.
 *
 * `Tee-Object -FilePath` and `Out-File` write UTF-16LE with a BOM in PowerShell 5.1, while
 * `Set-Content -Encoding UTF8` writes UTF-8. A pure-UTF-8 reader silently sees NUL bytes
 * interleaved and every prefix match fails -- that is how the screenshot geometry came back
 * as 0x0 even though the report was correct on disk. Detect instead of assuming.
 *
 * @param {string} path
 * @returns {string} decoded text without a BOM, or '' when unreadable
 */
function readTextFile(path) {
  let buf
  try { buf = readFileSync(path) } catch { return '' }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.subarray(2).toString('utf16le')
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    // UTF-16BE: swap to LE, then decode.
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  let start = 0
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) start = 3
  return buf.subarray(start).toString('utf8')
}

// ---------------------------------------------------------------------------
// plugin RPC: dsh-remote/selfcheck
// ---------------------------------------------------------------------------

/** @type {{ at: number, report: object } | undefined} */
let selfcheckCache

/**
 * Run the readiness script and return its JSON report.
 *
 * The report is cached because `S8` genuinely moves the mouse: re-running it before
 * every delegation would fight the task being dispatched. A caller passes
 * `maxAgeMs: 0` to force a fresh run (the settings page does this).
 *
 * @param {number} maxAgeMs
 * @returns {Promise<object>}
 */
async function runSelfCheck(maxAgeMs) {
  const now = Date.now()
  if (selfcheckCache !== undefined && maxAgeMs > 0 && now - selfcheckCache.at <= maxAgeMs) {
    return { ...selfcheckCache.report, fresh: false, cachedAgeMs: now - selfcheckCache.at }
  }

  let exists = false
  try { exists = statSync(SELFCHECK_SCRIPT).isFile() } catch { exists = false }
  const degraded = (check) => ({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verdict: 'blocked',
    sessionSegment: 'unavailable',
    blockingFailures: 1,
    warnings: 0,
    unchecked: 0,
    checks: [check],
    fresh: true,
  })
  if (!exists) {
    return degraded({
      id: 'S0', name: 'self-check script present', severity: 'blocking', status: 'fail',
      expected: SELFCHECK_SCRIPT, actual: 'missing',
      fix: 'deploy selfcheck.ps1 next to relay.mjs, or pass --selfcheck-script',
    })
  }

  const run = await new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const ps = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SELFCHECK_SCRIPT],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('pwsh', ['-NoProfile', '-File', SELFCHECK_SCRIPT],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    ps.stdout.on('data', (d) => { out += d.toString('utf8') })
    ps.on('error', (e) => resolve({ error: e.message, out }))
    ps.on('exit', (code) => resolve({ code, out }))
    setTimeout(() => { try { ps.kill() } catch { /* already gone */ } }, 60_000)
  })

  // The script writes selfcheck.json next to itself; prefer that over stdout, which
  // also carries the human-readable twin.
  const jsonPath = join(dirname(SELFCHECK_SCRIPT), 'selfcheck.json')
  let parsed
  try {
    parsed = JSON.parse(readTextFile(jsonPath).replace(/^\uFEFF/, ''))
  } catch (e) {
    return degraded({
      id: 'S0', name: 'self-check produced a report', severity: 'blocking', status: 'fail',
      expected: jsonPath, actual: String(e.message).slice(0, 200),
      fix: `run ${SELFCHECK_SCRIPT} by hand to see the failure`,
    })
  }
  if (run.error !== undefined) log(`self-check spawn error: ${run.error}`)

  selfcheckCache = { at: Date.now(), report: parsed }
  return { ...parsed, fresh: true, cachedAgeMs: 0 }
}

/**
 * Handle a plugin RPC locally.
 * @returns {Promise<object|null>} a JSON-RPC response, or null to forward to ACP
 */
async function handleLocalRpc(msg) {
  const id = msg.id
  const reply = (result) => ({ jsonrpc: '2.0', id, result })
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

  switch (msg.method) {
    case `${PLUGIN_PREFIX}ping`:
      return reply({ pong: true, at: new Date().toISOString(), pid: process.pid })

    case `${PLUGIN_PREFIX}selfcheck`: {
      const maxAgeMs = Number.isFinite(msg.params?.maxAgeMs) ? Number(msg.params.maxAgeMs) : SELFCHECK_CACHE_MS
      try {
        return reply(await runSelfCheck(maxAgeMs))
      } catch (e) {
        return fail(-32603, `self-check failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    case `${PLUGIN_PREFIX}screenshot`: {
      try {
        const shot = await captureScreenshot()
        // Metadata only. The bytes come back over GET /screenshot: base64 in a JSON-RPC
        // result would inflate a multi-megabyte PNG by a third and would have to travel
        // through the ACP message pump, which exists for small control frames.
        return reply({
          ok: true,
          width: shot.width,
          height: shot.height,
          bytes: shot.bytes,
          displays: shot.displays,
          capturedAt: shot.capturedAt,
          path: shot.path,
          downloadPath: '/screenshot',
        })
      } catch (e) {
        return fail(-32603, `screenshot failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    default:
      // Unknown dsh-remote/* method: answer explicitly, never silently forward. A
      // silent forward would make a future protocol addition look like a no-op.
      return fail(-32601, `unknown plugin method "${msg.method}"`)
  }
}

// ---------------------------------------------------------------------------
// screenshot capture
// ---------------------------------------------------------------------------

let shotSeq = 0
/** Single-flight: two captures must not race on the same report file or output path. */
let capturing

/**
 * Capture the worker desktop with the sidecar script.
 *
 * MUST run in the interactive session -- in session 0 there is no desktop and the capture
 * is empty (the same false negative the display checks have). The relay runs as the
 * logged-in user, so a child process inherits the right session; that is precisely why
 * the relay owns this rather than an SSH-invoked helper.
 *
 * @returns {Promise<{path:string,width:number,height:number,bytes:number,displays:string[],capturedAt:string}>}
 */
async function captureScreenshot() {
  if (capturing !== undefined) return await capturing
  capturing = (async () => {
    try { statSync(SCREENSHOT_SCRIPT) } catch {
      throw new Error(`screenshot script not found at ${SCREENSHOT_SCRIPT}; pass --screenshot-script`)
    }
    try { mkdirSync(SHOT_DIR, { recursive: true }) } catch { /* exists */ }
    const out = join(SHOT_DIR, `shot-${Date.now()}-${++shotSeq}.png`)

    const run = await new Promise((resolve) => {
      const isWin = process.platform === 'win32'
      // `-WindowStyle Hidden` is not cosmetic: a visible console is captured into the
      // frame AND can take focus, corrupting exactly the GUI measurements a screenshot
      // exists to support. An earlier capture of this worker had the script's own
      // PowerShell window in it.
      const args = isWin
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', SCREENSHOT_SCRIPT, '-Out', out]
        : ['-NoProfile', '-File', SCREENSHOT_SCRIPT, '-Out', out]
      const ps = spawn(isWin ? 'powershell.exe' : 'pwsh', args, {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let text = ''
      ps.stdout.on('data', (d) => { text += d.toString('utf8') })
      ps.stderr.on('data', (d) => { text += d.toString('utf8') })
      ps.on('error', (e) => resolve({ error: e.message, text }))
      ps.on('exit', (code) => resolve({ code, text }))
      setTimeout(() => { try { ps.kill() } catch { /* gone */ } }, 60_000)
    })

    if (run.error !== undefined) throw new Error(`could not run capture: ${run.error}`)
    let stat
    try { stat = statSync(out) } catch { stat = undefined }
    if (stat === undefined || stat.size === 0) {
      throw new Error(`capture produced no image (exit ${run.code}); output: ${String(run.text).trim().slice(-300)}`)
    }

    // Geometry, because a screenshot is only interpretable next to it. readTextFile rather
    // than a plain utf8 read: see the note on that helper.
    const report = readTextFile(SCREENSHOT_REPORT)
    const lines = report.split(/\r?\n/)
    const displays = lines.filter((l) => l.startsWith('screen '))
    const m = /w=(\d+)\s+h=(\d+)/.exec(lines.find((l) => l.startsWith('virtualscreen ')) ?? '')

    return {
      path: out,
      width: m ? Number(m[1]) : 0,
      height: m ? Number(m[2]) : 0,
      bytes: stat.size,
      displays,
      capturedAt: new Date().toISOString(),
    }
  })().finally(() => { capturing = undefined })
  return await capturing
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------
function tokenOk(provided) {
  if (TOKEN === '') return true
  if (typeof provided !== 'string' || provided === '') return false
  const a = Buffer.from(provided)
  const b = Buffer.from(TOKEN)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function bearerOf(req) {
  const h = req.headers['authorization']
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim()
  try { return new URL(req.url, 'http://x').searchParams.get('token') ?? '' } catch { return '' }
}

if (TOKEN === '' && !ALLOW_NO_AUTH) {
  console.error('[relay] refusing to start: no --token given (pass --allow-no-auth to override)')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// http + ws
// ---------------------------------------------------------------------------

/** Last capture, reused by /screenshot so an RPC followed by a download is one capture. */
let lastShot

const server = createServer((req, res) => {
  const url = (() => { try { return new URL(req.url, 'http://x') } catch { return undefined } })()

  if (url !== undefined && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      agent: LAUNCH.command,
      auth: TOKEN !== '',
      pluginRpc: [`${PLUGIN_PREFIX}ping`, `${PLUGIN_PREFIX}selfcheck`, `${PLUGIN_PREFIX}screenshot`],
      http: ['/healthz', '/screenshot'],
    }))
    return
  }

  // The PNG comes back here rather than inside the RPC result: base64 would inflate a
  // multi-megabyte frame by a third and would have to pass through the ACP pump, which
  // is there for small control messages.
  if (url !== undefined && url.pathname === '/screenshot') {
    if (!tokenOk(bearerOf(req))) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
      return
    }
    const fresh = url.searchParams.get('fresh') === '1'
    const started = Date.now()
    ;(async () => {
      let shot = lastShot
      if (fresh || shot === undefined) shot = lastShot = await captureScreenshot()
      const body = readFileSync(shot.path)
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(body.length),
        'cache-control': 'no-store',
        // Headers rather than a JSON envelope so the response IS the image, which makes
        // it usable with any HTTP client (and with a browser).
        'x-shot-width': String(shot.width),
        'x-shot-height': String(shot.height),
        'x-shot-bytes': String(shot.bytes),
        'x-shot-captured-at': shot.capturedAt,
        'x-shot-displays': String(shot.displays.length),
        'x-shot-ms': String(Date.now() - started),
      })
      res.end(body)
    })().catch((error) => {
      log(`/screenshot failed: ${error.message}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: error.message }))
      } else {
        try { res.end() } catch { /* already sent */ }
      }
    })
    return
  }

  res.writeHead(404); res.end('not found')
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  if (!tokenOk(bearerOf(req))) {
    log('rejected: bad token from', req.socket.remoteAddress)
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

let connSeq = 0

wss.on('connection', (ws, req) => {
  const id = ++connSeq
  log(`#${id} connected from ${req.socket.remoteAddress}`)

  const child = spawn(LAUNCH.command, LAUNCH.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...LAUNCH.env },
  })
  log(`#${id} spawned pid=${child.pid}: ${LAUNCH.command} ${LAUNCH.args.join(' ')}`)

  let childAlive = true
  let stdoutBuf = ''
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8')
    let nl
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).replace(/\r$/, '')
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (line.trim() === '') continue
      if (ws.readyState === ws.OPEN) { ws.send(line); vlog(`#${id} <- ${line.slice(0, 160)}`) }
    }
  })
  child.stderr.on('data', (c) => log(`#${id} [stderr] ${c.toString('utf8').trim().slice(0, 400)}`))

  let closed = false
  const shutdown = (why) => {
    if (closed) return
    closed = true
    childAlive = false
    log(`#${id} shutdown: ${why}`)
    try { child.stdin.end() } catch { /* already closed */ }
    setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 500)
    try { ws.close() } catch { /* already closed */ }
  }

  child.on('exit', (code, sig) => { log(`#${id} child exited code=${code} sig=${sig}`); shutdown('child exit') })
  child.on('error', (e) => { log(`#${id} child error: ${e.message}`); shutdown('child error') })

  ws.on('message', (data, isBinary) => {
    // ACP's WebSocket transport is text-only; the SDK would silently drop a binary
    // frame, so make it loud here instead (DESIGN §6.6).
    if (isBinary) { log(`#${id} WARNING: binary frame dropped (ACP is text-only)`); return }
    const text = data.toString('utf8')
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/\r$/, '')
      if (line.trim() === '') continue

      let msg
      try { msg = JSON.parse(line) } catch {
        log(`#${id} dropping unparseable frame: ${line.slice(0, 120)}`)
        continue
      }

      if (typeof msg.method === 'string' && msg.method.startsWith(PLUGIN_PREFIX)) {
        if (msg.id === undefined) { vlog(`#${id} plugin notification ${msg.method}`); continue }
        void handleLocalRpc(msg).then((response) => {
          if (response !== null && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(response))
            vlog(`#${id} plugin reply -> ${JSON.stringify(response).slice(0, 200)}`)
          }
        })
        continue
      }

      if (!childAlive) { log(`#${id} dropping ACP frame: child is gone`); continue }
      try { child.stdin.write(line + '\n'); vlog(`#${id} -> ${line.slice(0, 160)}`) }
      catch (e) { log(`#${id} write to child failed: ${e.message}`); shutdown('write failed'); return }
    }
  })

  ws.on('close', () => shutdown('ws closed'))
  ws.on('error', (e) => { log(`#${id} ws error: ${e.message}`); shutdown('ws error') })
})

server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT}  (health: GET /healthz)`)
  log(`agent: ${LAUNCH.command}`)
  log(`       ${LAUNCH.args.join(' ')}`)
  log(`self-check script: ${SELFCHECK_SCRIPT} (cache ${SELFCHECK_CACHE_MS}ms)`)
  if (TOKEN === '') log('WARNING: auth disabled')
})
