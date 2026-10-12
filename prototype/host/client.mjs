#!/usr/bin/env node
/**
 * client.mjs -- P0 prototype, MASTER side.
 *
 * Drives a remote DSH over the ACP-over-WebSocket path:
 *   master  --ws-->  relay (slave)  --stdio-->  dsh --profile acp
 *
 * Usage:
 *   node client.mjs --url ws://192.168.1.101:7331 --token <secret> \
 *                   --cwd C:\some\dir --prompt "say hello and stop"
 *
 * Prints a timeline of session/update notifications so we can judge how usable
 * the ACP projection actually is for the remote-subagent use case.
 */
import { WebSocket } from 'ws'
import * as acp from '@agentclientprotocol/sdk'
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client'

// ---------- args ----------
const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const URL_ = arg('url', 'ws://127.0.0.1:7331')
const TOKEN = arg('token', '')
const CWD = arg('cwd', process.cwd())
const PROMPT = arg('prompt', 'Reply with exactly: PONG. Then stop.')
const TIMEOUT_MS = Number(arg('timeout', '180000'))

const t0 = Date.now()
const t = () => `+${String(Date.now() - t0).padStart(6)}ms`
const say = (...a) => console.log(`${t()}`, ...a)

// ---------- stats ----------
const stats = {
  updates: 0,
  byKind: {},
  toolCalls: new Map(),   // toolCallId -> { title, rawInput, status }
  permissionRequests: 0,
  assistantChars: 0,
}

// ---------- client handlers ----------
const handlers = {
  // session/request_permission: a REAL decision point. For P0 we auto-approve
  // once and record it loudly, because a hanging approval is the failure mode
  // we most need to see.
  async requestPermission(params) {
    stats.permissionRequests += 1
    const optionId = params.options?.[0]?.optionId ?? 'allow-once'
    say(`[PERMISSION] request #${stats.permissionRequests}`)
    say(`             sessionId   = ${params.sessionId}`)
    say(`             toolCall    = ${JSON.stringify(params.toolCall)}`)
    say(`             options     = ${JSON.stringify(params.options)}`)
    say(`             => answering optionId=${optionId}`)
    return { outcome: { outcome: 'selected', optionId } }
  },

  async sessionUpdate(params) {
    const u = params?.update
    if (!u || typeof u !== 'object') { say('[update] <malformed>'); return }
    const kind = u.sessionUpdate
    stats.updates += 1
    stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1

    switch (kind) {
      case 'agent_message_chunk': {
        const text = u.content?.type === 'text' ? u.content.text : ''
        stats.assistantChars += text.length
        process.stdout.write(text)
        return
      }
      case 'agent_thought_chunk': {
        const text = u.content?.type === 'text' ? u.content.text : ''
        say(`[thought] ${JSON.stringify(text.slice(0, 120))}`)
        return
      }
      case 'tool_call': {
        const rec = { title: u.title, rawInput: u.rawInput, status: u.status, kind: u.kind }
        stats.toolCalls.set(u.toolCallId, rec)
        say(`[tool_call] id=${u.toolCallId} kind=${u.kind} status=${u.status}`)
        say(`            title=${JSON.stringify(u.title)}`)
        say(`            rawInput=${JSON.stringify(u.rawInput)?.slice(0, 300) ?? 'undefined'}`)
        say(`            rawOutput=${JSON.stringify(u.rawOutput)?.slice(0, 120) ?? 'undefined'}  locations=${JSON.stringify(u.locations) ?? 'undefined'}`)
        return
      }
      case 'tool_call_update': {
        const prev = stats.toolCalls.get(u.toolCallId)
        if (prev) { prev.status = u.status ?? prev.status }
        say(`[tool_call_update] id=${u.toolCallId} status=${u.status} title=${JSON.stringify(u.title ?? prev?.title)}`)
        const content = u.content
        if (Array.isArray(content)) {
          for (const c of content.slice(0, 3)) {
            const txt = c?.type === 'content' ? c.content?.text : c?.type === 'text' ? c.text : JSON.stringify(c)
            say(`            content: ${String(txt).slice(0, 260)}`)
          }
        } else if (content !== undefined) {
          say(`            content: ${JSON.stringify(content).slice(0, 260)}`)
        }
        return
      }
      case 'usage_update':
        say(`[usage] ${JSON.stringify(u)}`)
        return
      case 'config_option_update':
        say(`[config_option_update] ${JSON.stringify(u).slice(0, 300)}`)
        return
      default:
        say(`[${kind}] ${JSON.stringify(u).slice(0, 300)}`)
    }
  },
}

// ---------- run ----------
const timeout = setTimeout(() => {
  say(`!! TIMEOUT after ${TIMEOUT_MS}ms -- aborting`)
  process.exit(3)
}, TIMEOUT_MS)

let stream
try {
  say(`connecting ${URL_}  cwd=${CWD}`)
  const headers = TOKEN === '' ? {} : { Authorization: `Bearer ${TOKEN}` }
  stream = createWebSocketStream(URL_, { WebSocket, headers })

  const outcome = await acp
    .client({ name: 'dsh-remote-p0' })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => handlers.requestPermission(ctx.params))
    .onNotification(acp.methods.client.session.update, (ctx) => handlers.sessionUpdate(ctx.params))
    .connectWith(stream, async (ctx) => {
      say('connected; sending initialize')

      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      say(`initialize OK: agent=${init.agentInfo?.name}@${init.agentInfo?.version} proto=${init.protocolVersion}`)
      say(`  sessionCapabilities=${JSON.stringify(init.agentCapabilities?.sessionCapabilities)}`)
      say(`  promptCapabilities =${JSON.stringify(init.agentCapabilities?.promptCapabilities)}`)

      const session = await ctx.request(acp.methods.agent.session.new, { cwd: CWD, mcpServers: [] })
      say(`session/new OK: sessionId=${session.sessionId}`)

      say(`\n--- prompt sent ---`)
      const result = await ctx.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: PROMPT }],
      })
      say(`\n--- prompt returned ---`)

      // best-effort close (DSH does not implement session/load but does implement close)
      try {
        await ctx.request(acp.methods.agent.session.close, { sessionId: session.sessionId })
        say('session/close OK')
      } catch (e) { say(`session/close failed (non-fatal): ${e.message}`) }

      return { init, session, result }
    })

  const { result } = outcome
  say(`\n================ RESULT ================`)
  say(`stopReason   = ${JSON.stringify(result.stopReason)}`)
  say(`output blocks= ${Array.isArray(result.output) ? result.output.length : typeof result.output}`)
  if (Array.isArray(result.output)) {
    for (const b of result.output) say(`   [${b?.type}] ${String(b?.text ?? JSON.stringify(b)).slice(0, 400)}`)
  }
  say(`================ STATS ================`)
  say(`updates=${stats.updates} byKind=${JSON.stringify(stats.byKind)}`)
  say(`assistantChars=${stats.assistantChars}`)
  say(`toolCalls=${stats.toolCalls.size} permissionRequests=${stats.permissionRequests}`)
  say(`VERDICT: ${result.stopReason === 'end_turn' ? 'prompt completed (end_turn)' : 'NON-STANDARD stopReason'}`)
} catch (e) {
  say(`\n!! ERROR: ${e?.constructor?.name}: ${e?.message}`)
  if (e?.stack) say(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
  try { await stream?.writable?.close() } catch {}
  setTimeout(() => process.exit(process.exitCode ?? 0), 200)
}
