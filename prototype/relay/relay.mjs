#!/usr/bin/env node
/**
 * relay.mjs -- P0 prototype, SLAVE side.
 *
 * Bridges a WebSocket connection to a `dsh --profile acp` child process over stdio.
 * Deliberately depends on nothing but `ws` + Node builtins: the slave should need the
 * smallest possible dependency surface.
 *
 *   ws client  <--text frames (NDJSON)-->  relay  <--stdio NDJSON-->  dsh --profile acp
 *
 * Auth: Bearer token (or ?token=) compared with timingSafeEqual.
 * One WebSocket connection owns exactly one child process; closing either tears down both.
 *
 * Usage:
 *   node relay.mjs --port 7331 --token <secret> [--dsh "dsh --profile acp"] [--allow-no-auth]
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'

// ---------- args ----------
const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const PORT = Number(arg('port', '7331'))
const HOST = arg('host', '0.0.0.0')
const TOKEN = arg('token', '')

// How to launch the ACP agent.
//
// Preferred: --cmd-file pointing at a JSON file `{ "command": "...", "args": [...],
// "env": {...} }`. Spawning an executable with an argv ARRAY avoids every Windows
// quoting hazard: cmd.exe /c loses quotes through the PowerShell -> node hand-off, and
// Node refuses to spawn a .cmd without a shell (EINVAL).
//
// Simplest robust target: do NOT launch the `dsh.cmd` shim. It only sets
// ELECTRON_RUN_AS_NODE=1 and runs `<install>/DeepSeek Harness.exe --expose-internals
// <install>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`.
// Launching that executable directly with an args array sidesteps the shim entirely.
const CMD_FILE = arg('cmd-file', '')
const DSH_CMD = arg('dsh', 'dsh --profile acp')
const ALLOW_NO_AUTH = argv.includes('--allow-no-auth')
const VERBOSE = argv.includes('--verbose')

function loadLaunchSpec() {
  if (CMD_FILE !== '') {
    const raw = readFileSync(CMD_FILE, 'utf8').replace(/^\uFEFF/, '')
    const spec = JSON.parse(raw)
    if (typeof spec?.command !== 'string' || !Array.isArray(spec?.args)) {
      throw new Error(`--cmd-file ${CMD_FILE} must contain {"command":string,"args":string[]}`)
    }
    return { command: spec.command, args: spec.args, env: spec.env ?? {} }
  }
  // Fallback: string form. Only safe when the path has no spaces.
  const parts = (DSH_CMD.match(/"[^"]*"|\S+/g) ?? []).map((s) => s.replace(/^"|"$/g, ''))
  return { command: parts[0], args: parts.slice(1), env: {} }
}

const LAUNCH = loadLaunchSpec()

if (TOKEN === '' && !ALLOW_NO_AUTH) {
  console.error('[relay] refusing to start: no --token given (pass --allow-no-auth to override)')
  process.exit(2)
}

const log = (...a) => console.log(`[relay ${new Date().toISOString().slice(11, 23)}]`, ...a)
const vlog = (...a) => { if (VERBOSE) log(...a) }

// ---------- auth ----------
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

// ---------- http + ws ----------
const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, dsh: DSH_CMD, auth: TOKEN !== '' }))
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
  const peer = req.socket.remoteAddress
  log(`#${id} connected from ${peer}`)

  // spawn the ACP agent. On Windows `dsh` is a .cmd shim, so invoke cmd.exe explicitly
  // (shell:true would concatenate args unescaped -- Node DEP0190) and quote the path,
  // because the default install path contains a space ("DeepSeek Harness").
  // Spawn the ACP agent from the pre-loaded launch spec: an executable plus an argv
  // ARRAY, so no shell and no quoting is involved.
  const child = spawn(LAUNCH.command, LAUNCH.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...LAUNCH.env },
  })
  log(`#${id} spawned pid=${child.pid}: ${LAUNCH.command} ${LAUNCH.args.join(' ')}`)

  let stdoutBuf = ''
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8')
    // ACP over stdio is NDJSON; forward complete lines only.
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
    log(`#${id} shutdown: ${why}`)
    try { child.stdin.end() } catch {}
    setTimeout(() => { try { child.kill() } catch {} }, 500)
    try { ws.close() } catch {}
  }

  child.on('exit', (code, sig) => { log(`#${id} child exited code=${code} sig=${sig}`); shutdown('child exit') })
  child.on('error', (e) => { log(`#${id} child error: ${e.message}`); shutdown('child error') })

  ws.on('message', (data, isBinary) => {
    if (isBinary) { log(`#${id} WARNING: binary frame dropped (ACP is text-only)`); return }
    const text = data.toString('utf8')
    const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '')
    for (const line of lines) {
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
  if (TOKEN === '') log('WARNING: auth disabled')
})
