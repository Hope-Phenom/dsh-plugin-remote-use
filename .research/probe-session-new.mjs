// probe-session-new.mjs -- does a session actually get created under this DSH_PERMISSION_MODE?
//
// WHY THIS EXISTS AND NOT probe-acp-handshake.mjs: `initialize` answered fine even for the
// combination PITFALLS F34 calls unsafe, because the preset is pinned when a SESSION is created,
// not when the app boots. So the only measurement that can settle F34 is: create a session, and
// read what the session log says was pinned.
//
// It writes under a UNIQUE cwd so the session lands in a directory of its own, which the caller can
// delete wholesale -- the probe does not clean up after itself, because deciding what is safe to
// remove belongs to whoever read the output.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const INSTALL = argOf('install', '')
const PROFILE = argOf('profile', 'acp')
const DSH_HOME = argOf('dsh-home', join(process.env.USERPROFILE ?? '', '.dsh'))
const MODE = process.env.DSH_PERMISSION_MODE ?? '(unset)'
const exe = join(INSTALL, 'DeepSeek Harness.exe')
const cli = [INSTALL, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'].join('\\')

const cwd = mkdtempSync(join(tmpdir(), 'ru-session-probe-'))
console.log(`mode    : ${MODE}`)
console.log(`cwd     : ${cwd}`)

const child = spawn(exe, ['--expose-internals', cli, '--profile', PROFILE], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

let stderr = ''
let buffer = ''
const pending = new Map()
const send = (id, method, params) => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve) => pending.set(id, resolve))
}

child.stdout.on('data', (d) => {
  buffer += d.toString('utf8')
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).replace(/\r$/, '')
    buffer = buffer.slice(nl + 1)
    if (line.trim() === '') continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const resolve = pending.get(msg.id)
    if (resolve !== undefined) { pending.delete(msg.id); resolve(msg) }
  }
})
child.stderr.on('data', (d) => { stderr += d.toString('utf8') })

const finish = (code) => {
  try { child.kill() } catch { /* gone */ }
  if (stderr.trim() !== '') {
    console.log('stderr:')
    for (const line of stderr.trim().split('\n').slice(0, 25)) console.log(`  ${line}`)
  }
  console.log(`RESULT: ${code}`)
  process.exit(code)
}

setTimeout(() => { console.log('TIMEOUT'); finish(2) }, 90_000)

const init = await send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
if (init.error !== undefined) { console.log(`initialize FAILED: ${JSON.stringify(init.error)}`); finish(2) }
console.log('initialize OK')

const created = await send(2, 'session/new', { cwd, mcpServers: [] })
if (created.error !== undefined) {
  console.log(`session/new FAILED: ${JSON.stringify(created.error).slice(0, 400)}`)
  finish(3)
}
const sessionId = created.result?.sessionId ?? ''
console.log(`session/new OK  sessionId=${sessionId}`)

// The session log is the evidence, and it is found by SESSION ID rather than by guessing how the
// cwd is sanitised into a directory name: `sessions/<sanitised-cwd>/session-<id>/`.
const root = join(DSH_HOME, 'sessions')
let found = 'no session directory'
if (existsSync(root)) {
  for (const bucket of readdirSync(root)) {
    const dir = join(root, bucket, `session-${sessionId}`)
    if (!existsSync(dir)) continue
    found = `dir=${dir}`
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('session.v4.jsonl')) continue
      const file = join(dir, name)
      try {
        const raw = readFileSync(file)
        const text = name.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
        for (const row of text.split('\n')) {
          if (row.trim() === '') continue
          // The effective policy is stated in the runtime context the agent loop records, and the
          // preset pin is its own event -- between them they say what mode this session really got.
          if (/DSH file policy|sandbox\/mode|permission\/preset/iu.test(row)) console.log(`  LOG: ${row.slice(0, 320)}`)
        }
      } catch (error) {
        console.log(`  could not read ${name}: ${error.message}`)
      }
    }
  }
}
console.log(found)
console.log(`PROBE_CWD=${cwd}`)
console.log(`SESSION_ID=${sessionId}`)
finish(0)
