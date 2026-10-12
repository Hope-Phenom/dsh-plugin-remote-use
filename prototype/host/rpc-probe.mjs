#!/usr/bin/env node
/**
 * rpc-probe.mjs -- call the relay's plugin RPC methods without involving ACP.
 *
 * Verifies the `dsh-remote/*` namespace is answered by the relay itself and that
 * unknown plugin methods fail loudly instead of being forwarded.
 *
 * Usage: node rpc-probe.mjs --url ws://host:port --token <secret>
 */
import { WebSocket } from 'ws'

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const URL_ = arg('url', 'ws://127.0.0.1:7331')
const TOKEN = arg('token', '')

const headers = TOKEN === '' ? {} : { Authorization: `Bearer ${TOKEN}` }
const ws = new WebSocket(URL_, { headers })

let nextId = 1
const pending = new Map()

function call(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`)) }, 90_000)
  })
}

ws.on('message', (data) => {
  let msg
  try { msg = JSON.parse(data.toString('utf8')) } catch { return }
  if (msg.id === undefined) return
  const entry = pending.get(msg.id)
  if (entry === undefined) return
  pending.delete(msg.id)
  if (msg.error !== undefined) entry.resolve({ __error: msg.error })
  else entry.resolve(msg.result)
})

ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1) })

ws.on('open', async () => {
  try {
    console.log('--- dsh-remote/ping ---')
    console.log(JSON.stringify(await call('dsh-remote/ping', {}), null, 2))

    console.log('\n--- dsh-remote/unknown (must fail loudly, not be forwarded) ---')
    const unknown = await call('dsh-remote/does-not-exist', {})
    console.log(JSON.stringify(unknown, null, 2))
    if (unknown?.__error?.code !== -32601) {
      console.error('FAIL: expected -32601 for an unknown plugin method')
      process.exitCode = 1
    }

    console.log('\n--- dsh-remote/selfcheck (fresh) ---')
    const t0 = Date.now()
    const report = await call('dsh-remote/selfcheck', { maxAgeMs: 0 })
    console.log(`took ${Date.now() - t0}ms`)
    if (report?.__error !== undefined) {
      console.log('ERROR:', JSON.stringify(report.__error))
    } else {
      console.log(`verdict=${report.verdict} blocking=${report.blockingFailures} warn=${report.warnings} unchecked=${report.unchecked} fresh=${report.fresh}`)
      console.log(`sessionSegment=${report.sessionSegment} session=${report.sessionId} interactive=${report.interactive}`)
      for (const c of report.checks ?? []) {
        const mark = c.status === 'pass' ? 'OK  ' : c.status === 'fail' ? 'FAIL' : c.status === 'warn' ? 'WARN' : '??  '
        console.log(`  [${mark}] ${c.id} ${c.name} | ${c.actual}`)
      }
    }

    console.log('\n--- dsh-remote/selfcheck (cached) ---')
    const cached = await call('dsh-remote/selfcheck', { maxAgeMs: 30_000 })
    console.log(`fresh=${cached.fresh} cachedAgeMs=${cached.cachedAgeMs}`)
  } catch (e) {
    console.error('FAIL:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
