// probe-turn.mjs -- run ONE turn against a chosen profile and read back the effective file policy.
//
// WHY: PITFALLS F34's failure is a service that does not load (`permission-presets`). Whether a TURN
// still runs in that state cannot be answered by `initialize` (the app boots fine) and cannot be
// answered by `session/new` (a session is created fine) -- only by sending a prompt and seeing the
// agent loop complete. This probe does exactly that, and nothing else.
//
// The prompt is deliberately self-reporting: it asks the agent to quote the policy line from its own
// runtime context, so the ANSWER is the evidence that the requested mode actually took effect. That
// avoids needing the session log (which is written lazily) and avoids asking the agent to DO anything
// unconfined, which matters because the whole point is to test a mode that removes confinement.
//
// It writes under a unique cwd so the session lands in a directory of its own; the caller deletes it.
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
const PROMPT = argOf('prompt', 'Quote verbatim the single line from your runtime context that starts with "Current DSH file policy:". Reply with that line and nothing else.')
const MODE = process.env.DSH_PERMISSION_MODE ?? '(unset)'
const exe = join(INSTALL, 'DeepSeek Harness.exe')
const cli = [INSTALL, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'].join('\\')

const cwd = mkdtempSync(join(tmpdir(), 'ru-turn-probe-'))
console.log(`mode    : ${MODE}`)
console.log(`profile : ${PROFILE}`)

const child = spawn(exe, ['--expose-internals', cli, '--profile', PROFILE], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

let stderr = ''
let buffer = ''
let text = ''
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
    if (msg.method === 'session/update') {
      const update = msg.params?.update ?? {}
      if (typeof update.content?.text === 'string') text += update.content.text
      continue
    }
    const resolve = pending.get(msg.id)
    if (resolve !== undefined) { pending.delete(msg.id); resolve(msg) }
  }
})
child.stderr.on('data', (d) => { stderr += d.toString('utf8') })

const policyLines = (sessionId) => {
  const root = join(DSH_HOME, 'sessions')
  const out = []
  if (!existsSync(root)) return out
  for (const bucket of readdirSync(root)) {
    const dir = join(root, bucket, `session-${sessionId}`)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('session.v4.jsonl')) continue
      try {
        const raw = readFileSync(join(dir, name))
        const body = name.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
        for (const row of body.split('\n')) {
          if (/DSH file policy|permission\/preset|sandbox\/mode/iu.test(row)) out.push(row.slice(0, 260))
        }
      } catch { /* not readable; the reply is the primary evidence anyway */ }
    }
  }
  return out
}

const finish = (code) => {
  try { child.kill() } catch { /* gone */ }
  if (stderr.trim() !== '') {
    console.log('stderr:')
    for (const line of stderr.trim().split('\n').slice(0, 20)) console.log(`  ${line}`)
  } else {
    console.log('stderr: (clean)')
  }
  console.log(`RESULT: ${code}`)
  process.exit(code)
}

setTimeout(() => { console.log('TIMEOUT'); finish(2) }, 180_000)

const init = await send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
if (init.error !== undefined) { console.log(`initialize FAILED: ${JSON.stringify(init.error)}`); finish(2) }
console.log('initialize OK')

const created = await send(2, 'session/new', { cwd, mcpServers: [] })
if (created.error !== undefined) { console.log(`session/new FAILED: ${JSON.stringify(created.error).slice(0, 300)}`); finish(3) }
const sessionId = created.result?.sessionId ?? ''
console.log(`session/new OK  sessionId=${sessionId}`)

const turn = await send(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: PROMPT }] })
if (turn.error !== undefined) {
  console.log(`session/prompt FAILED: ${JSON.stringify(turn.error).slice(0, 400)}`)
  finish(4)
}
console.log(`session/prompt OK  stopReason=${turn.result?.stopReason ?? '?'}`)
console.log('--- agent text ---')
console.log(text.trim() === '' ? '(no text)' : text.trim().slice(0, 600))

const logged = policyLines(sessionId)
console.log('--- policy lines in the session log ---')
console.log(logged.length === 0 ? '(none found)' : logged.join('\n'))
console.log(`PROBE_CWD=${cwd}`)
finish(0)
