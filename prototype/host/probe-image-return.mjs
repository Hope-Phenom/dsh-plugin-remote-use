#!/usr/bin/env node
/**
 * probe-image-return.mjs -- does DSH actually emit an IMAGE content block back to us?
 *
 * The ACP schema says a tool result may carry standard content blocks "text, images".
 * That is a protocol capability, not a behaviour: `promptCapabilities.image: false` in
 * DSH's initialize response is about images we SEND, so it says nothing about this
 * direction.
 *
 * Uses the raw SDK rather than our bridge, deliberately: the bridge's tool view does not
 * expose a tool result's `content`, and a probe should observe the wire, not our model of
 * it. This way the answer is about DSH, not about our code.
 *
 * The prompt asks the worker's agent to read a known 240x120 PNG (red / green / blue bars
 * with a black circle). If an `image` block with a base64 payload arrives, the direct
 * "master sees the worker's screen" path is possible; if the result is text-only, the
 * bytes must travel through our own channel.
 */
import { WebSocket } from 'ws'
import * as acp from '@agentclientprotocol/sdk'
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client'

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const URL_ = arg('url', 'ws://192.168.1.101:7331')
const TOKEN = arg('token', '')
const CWD = arg('cwd', 'C:\\dsh-remote\\p0work')
const TARGET = arg('target', 'C:\\dsh-remote\\p0work\\image-probe.png')

/** Raw updates, as they arrived on the wire. */
const updates = []
const agentText = []

const stream = createWebSocketStream(URL_, { WebSocket, headers: { Authorization: `Bearer ${TOKEN}` } })

await acp.client({ name: 'image-probe' })
  .onNotification(acp.methods.client.session.update, (ctx) => {
    updates.push(ctx.params.update)
  })
  .onRequest(acp.methods.client.session.requestPermission, () => ({
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  }))
  .connectWith(stream, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
    })
    const session = await ctx.request(acp.methods.agent.session.new, { cwd: CWD, mcpServers: [] })

    const result = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{
        type: 'text',
        text: `Use the read tool to read the image file at exactly ${TARGET} . `
          + 'Then state precisely which colors appear in it from left to right, and whether any shape is present. '
          + 'Answer in one short line.',
      }],
    })

    console.log('=== prompt result ===')
    console.log(JSON.stringify(result))

    let images = 0
    let inspected = 0

    console.log('\n=== tool_call / tool_call_update content blocks (raw) ===')
    for (const u of updates) {
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
        agentText.push(u.content.text)
      }
      if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') continue
      const blocks = Array.isArray(u.content) ? u.content : (u.content === undefined ? [] : [u.content])
      if (blocks.length === 0 && u.sessionUpdate === 'tool_call') {
        console.log(`[tool_call] ${u.title} rawInput=${JSON.stringify(u.rawInput)?.slice(0, 140)}`)
      }
      for (const b of blocks) {
        inspected += 1
        const inner = b?.content ?? b
        console.log(`[${u.sessionUpdate}] ${u.title ?? ''} wrapper.type=${JSON.stringify(b?.type)} `
          + `inner.type=${JSON.stringify(inner?.type)} keys=${JSON.stringify(Object.keys(b ?? {}))}`)
        if (inner?.type === 'image' || b?.type === 'image') {
          images += 1
          const data = inner?.data ?? b?.data ?? ''
          console.log(`   >>> IMAGE BLOCK mimeType=${inner?.mimeType ?? b?.mimeType} base64Len=${String(data).length}`)
          console.log(`   >>> leading bytes: ${String(data).slice(0, 48)}`)
        } else if (inner?.type === 'text' || b?.type === 'text') {
          const text = inner?.text ?? b?.text ?? ''
          console.log(`   text: ${JSON.stringify(String(text).slice(0, 260))}`)
        }
      }
    }

    console.log('\n=== assistant text (agent_message_chunk only) ===')
    console.log(JSON.stringify(agentText.join('')).slice(0, 700))

    console.log('\n=== verdict ===')
    console.log(`content blocks inspected: ${inspected}`)
    if (images > 0) {
      console.log(`RESULT: DSH DOES emit image content blocks (${images}).`)
      console.log('  -> the direct path is viable: the master can receive the worker screen as an image.')
    } else {
      console.log('RESULT: no image content block observed; the tool result came back as text only.')
      console.log('  -> the bytes must travel through our own channel (a relay endpoint),')
      console.log('     and the model reaches them via a local file + read_image.')
    }
  })

try { await stream.writable.close() } catch { /* already closed */ }
setTimeout(() => process.exit(0), 300)
