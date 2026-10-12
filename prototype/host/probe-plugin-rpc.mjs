// probe-plugin-rpc.mjs -- can the ACP SDK send a non-ACP method name over the wire?
// This decides how the bridge must expose plugin RPC.
import { WebSocket } from 'ws'
import * as acp from '@agentclientprotocol/sdk'
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client'

const URL_ = process.argv[2] ?? 'ws://192.168.1.101:7331'
const TOKEN = process.argv[3] ?? 'p0test'

console.log('acp.methods.agent.initialize =', JSON.stringify(acp.methods.agent.initialize))
console.log('acp.methods.client.session.update =', JSON.stringify(acp.methods.client.session.update))

const stream = createWebSocketStream(URL_, { WebSocket, headers: { Authorization: `Bearer ${TOKEN}` } })

try {
  await acp.client({ name: 'plugin-rpc-probe' }).connectWith(stream, async (ctx) => {
    console.log('\n--- initialize (sanity) ---')
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
    })
    console.log('agent =', init.agentInfo?.name)

    console.log('\n--- dsh-remote/ping via ctx.request ---')
    try {
      const pong = await ctx.request('dsh-remote/ping', {})
      console.log('OK:', JSON.stringify(pong))
    } catch (e) {
      console.log('FAILED:', e.constructor.name, e.message)
    }

    console.log('\n--- dsh-remote/selfcheck via ctx.request ---')
    try {
      const rep = await ctx.request('dsh-remote/selfcheck', { maxAgeMs: 0 })
      console.log(`OK: verdict=${rep.verdict} blocking=${rep.blockingFailures} sessionSegment=${rep.sessionSegment} session=${rep.sessionId} interactive=${rep.interactive}`)
      for (const c of rep.checks ?? []) {
        const mark = c.status === 'pass' ? 'OK  ' : c.status === 'fail' ? 'FAIL' : c.status === 'warn' ? 'WARN' : '??  '
        console.log(`   [${mark}] ${c.id} ${c.name} | ${c.actual}`)
      }
    } catch (e) {
      console.log('FAILED:', e.constructor.name, e.message)
    }
  })
} catch (e) {
  console.error('connection error:', e.message)
  process.exitCode = 1
} finally {
  try { await stream.writable.close() } catch { /* ignore */ }
  setTimeout(() => process.exit(process.exitCode ?? 0), 200)
}
