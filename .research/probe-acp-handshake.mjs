// probe-acp-handshake.mjs -- start this machine's ACP agent and complete one initialize.
//
// WHY: "the process exited 0 with empty stderr" does not prove a profile loaded -- it also
// describes a process that started and immediately found nothing to do. The only statement
// worth making about an ACP profile is that it ANSWERS as an ACP agent, so this sends a real
// `initialize` and reads the reply.
//
// It also pins down the exact spawn contract the worker-role listener needs: the argv, the
// ELECTRON_RUN_AS_NODE environment, and the NDJSON framing.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const INSTALL = argOf('install', 'C:\\Users\\you\\AppData\\Local\\Programs\\DeepSeek Harness')
const PROFILE = argOf('profile', 'acp')
const exe = join(INSTALL, 'DeepSeek Harness.exe')
const cli = [INSTALL, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'].join('\\')

console.log(`exe     : ${exe}  (exists: ${existsSync(exe)})`)
console.log(`profile : ${PROFILE}`)
console.log(`cli     : inside app.asar -- fs cannot see it, Electron can`)
console.log('')

const child = spawn(exe, ['--expose-internals', cli, '--profile', PROFILE], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

let stdout = ''
let stderr = ''
let answered = false
const timer = setTimeout(() => {
  console.log(answered ? '' : 'TIMEOUT: no reply to initialize within 45s')
  finish(answered ? 0 : 1)
}, 45_000)

function finish(code) {
  clearTimeout(timer)
  try { child.kill() } catch { /* already gone */ }
  if (stderr.trim() !== '') {
    console.log('stderr:')
    for (const line of stderr.trim().split('\n').slice(0, 20)) console.log(`  ${line}`)
  }
  process.exit(code)
}

child.stdout.on('data', (d) => {
  stdout += d.toString('utf8')
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id !== 1) continue
    answered = true
    if (msg.error !== undefined) {
      console.log(`initialize FAILED: ${JSON.stringify(msg.error).slice(0, 300)}`)
      finish(1)
      return
    }
    const result = msg.result ?? {}
    console.log('initialize OK')
    console.log(`  protocolVersion : ${JSON.stringify(result.protocolVersion)}`)
    console.log(`  agentInfo       : ${JSON.stringify(result.agentInfo ?? result.agent ?? null).slice(0, 160)}`)
    console.log(`  capabilities    : ${JSON.stringify(result.agentCapabilities ?? result.capabilities ?? {}).slice(0, 200)}`)
    finish(0)
  }
})
child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
child.on('error', (error) => {
  console.log(`could not spawn: ${error.message}`)
  finish(1)
})
child.on('exit', (code) => {
  if (!answered) {
    console.log(`the agent exited (code ${code}) without answering initialize`)
    finish(1)
  }
})

child.stdin.write(`${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: {} },
})}\n`)
