/**
 * 【B】`lib/bridge/acp-bridge.js` 单元测试。
 *
 * 契约：`docs/INTERFACES.md`【B】+ `docs/DESIGN.md` §13.1–13.6 / §8.4。
 *
 * 约束：
 *  - 只用 `node --test` + `node:assert`，不引入测试框架。
 *  - 不依赖真实网络 / 真实 DSH：用 SDK 的 `acp.ndJsonStream` 配一对内存
 *    TransformStream 做假 agent 端（`createFakeAgent`）。
 *  - 为了让 bridge 接受内存流而不是真 WS，使用契约增量 `opts.stream`
 *    （INTERFACES【B】构造函数签名之外的**追加**选项，不改变已有字段语义）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as acp from '@agentclientprotocol/sdk'

import { AcpBridge, DEFAULT_APPROVAL_TIMEOUT_MS, mapStopReason } from '../lib/bridge/acp-bridge.js'

// ACP 硬编码的两个审批档（DESIGN §2.3 / §13.3 第 5 步）。
const PERMISSION_OPTIONS = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
]

/** 一对内存双工流：client 写 → agent 读，agent 写 → client 读。 */
function memoryPair() {
  const clientToAgent = new TransformStream()
  const agentToClient = new TransformStream()
  return {
    client: { readable: agentToClient.readable, writable: clientToAgent.writable },
    agent: { readable: clientToAgent.readable, writable: agentToClient.writable },
  }
}

/**
 * 假 agent 端（ACP agent 侧），行为由 `options.onPrompt` / `onCancel` 定制。
 * 返回句柄里带 `clientStream`（交给 AcpBridge）、`seen`（收到的消息）和收发助手。
 */
function createFakeAgent(options = {}) {
  const pair = memoryPair()
  const clientStream = acp.ndJsonStream(pair.client.writable, pair.client.readable)
  const agentStream = acp.ndJsonStream(pair.agent.writable, pair.agent.readable)

  const seen = { newSessions: [], prompts: [], cancels: [], permissionOutcomes: [] }
  let sessionCounter = 0

  const app = acp
    .agent({ name: 'fake-dsh-acp' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
      agentCapabilities: {
        sessionCapabilities: { close: {}, list: {}, resume: {} },
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: [],
    }))
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      sessionCounter += 1
      seen.newSessions.push(ctx.params)
      return { sessionId: `sess-${sessionCounter}`, configOptions: [] }
    })
    .onRequest(acp.methods.agent.session.close, () => ({}))
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      seen.prompts.push(ctx.params)
      if (typeof options.onPrompt === 'function') {
        return await options.onPrompt(ctx, seen, api)
      }
      return { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      seen.cancels.push(ctx.params)
      options.onCancel?.(ctx, seen, api)
    })

  const connection = app.connect(agentStream)

  const api = {
    clientStream,
    seen,
    /** 发一条 session/update 通知。 */
    notify(update, sessionId) {
      return connection.client.notify(acp.methods.client.session.update, {
        sessionId: sessionId ?? seen.prompts.at(-1)?.sessionId ?? 'sess-1',
        update,
      })
    },
    /** 发 session/request_permission 请求（params 只带 toolCallId，与 DSH 实测一致）。 */
    requestPermission(params) {
      return connection.client.request(acp.methods.client.session.requestPermission, params)
    },
    close() {
      connection.close()
    },
  }
  return api
}

/** 发一段 assistant 文本 chunk。 */
function messageChunk(text) {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
}

/** 发一个 tool_call 通知；`title` 即工具名（DESIGN §13.4）。 */
function toolCall(id, title, rawInput) {
  return { sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'other', status: 'pending', rawInput }
}

// ------------------------------------------------------------------ 1

test('正常一轮：output 从 agent_message_chunk 累积，toolCalls/usage/onUpdate 完整', async () => {
  const events = []
  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      const sessionId = ctx.params.sessionId
      await api.notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'plan' } }, sessionId)
      await api.notify(messageChunk('Hello, '), sessionId)
      await api.notify(toolCall('call_1', 'write', { file_path: 'C:\\work\\a.txt' }), sessionId)
      await api.notify(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'written' } }],
        },
        sessionId,
      )
      await api.notify({ sessionUpdate: 'usage_update', used: 120, size: 1000 }, sessionId)
      await api.notify(messageChunk('world!'), sessionId)
      return { stopReason: 'end_turn' }
    },
  })

  const bridge = new AcpBridge({ stream: agent.clientStream, onUpdate: (evt) => events.push(evt) })
  const info = await bridge.connect()
  assert.equal(info.agentInfo.name, 'deepseek-harness-acp')
  assert.ok(info.capabilities.sessionCapabilities, 'capabilities 取自 agentCapabilities')
  assert.equal(bridge.connected, true)

  const result = await bridge.startTask({ cwd: 'C:\\work', prompt: 'say hi' })

  assert.equal(result.stopReason, 'completed')
  assert.equal(result.output, 'Hello, world!', '正文只能从 chunk 累积（prompt result 无 output）')
  assert.deepEqual(result.usage, { used: 120, size: 1000 })
  assert.deepEqual(result.toolCalls, [{ toolCallId: 'call_1', toolName: 'write', status: 'completed' }])
  assert.equal(result.diagnostic, undefined)

  assert.equal(agent.seen.newSessions[0].cwd, 'C:\\work')
  assert.equal(agent.seen.prompts[0].prompt[0].type, 'text')
  assert.equal(agent.seen.prompts[0].prompt[0].text, 'say hi')

  assert.deepEqual(
    events.map((evt) => evt.kind),
    ['thought', 'message', 'tool_call', 'tool_call_update', 'usage', 'message'],
  )
  assert.deepEqual(events[2].tool, {
    toolCallId: 'call_1',
    toolName: 'write',
    rawInput: { file_path: 'C:\\work\\a.txt' },
    status: 'pending',
  })
  // tool_call_update 必须继承 tool_call 那次的 toolName/rawInput（Provider 依赖这一点；
  // 实测 DSH 的 tool_call_update 不带 rawInput，缓存必须补上而不是丢成 undefined）。
  assert.deepEqual(events[3].tool, {
    toolCallId: 'call_1',
    toolName: 'write',
    rawInput: { file_path: 'C:\\work\\a.txt' },
    status: 'completed',
  })

  await bridge.dispose()
})

// ------------------------------------------------------------------ 2

test('prompt 返回 JSON-RPC error(-32603) → stopReason=error 且 diagnostic 有内容', async () => {
  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      await api.notify(messageChunk('partial'), ctx.params.sessionId)
      throw new acp.RequestError(-32603, 'Internal error: turn failed: llm-deepseek: no API key')
    },
  })

  const bridge = new AcpBridge({ stream: agent.clientStream })
  await bridge.connect()
  const result = await bridge.startTask({ cwd: 'C:\\work', prompt: 'do it' })

  // DSH 把 blocked/error 都映射成 end_turn，所以失败检测必须靠传输层 reject。
  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic, /no API key/)
  assert.equal(result.output, 'partial', '报错前已到达的 chunk 仍要保留')
  await bridge.dispose()
})

// ------------------------------------------------------------------ 3

test("stopReason:'cancelled' → 'aborted'", async () => {
  const agent = createFakeAgent({ onPrompt: async () => ({ stopReason: 'cancelled' }) })
  const bridge = new AcpBridge({ stream: agent.clientStream })
  await bridge.connect()
  const result = await bridge.startTask({ cwd: 'C:\\work', prompt: 'go' })
  assert.equal(result.stopReason, 'aborted')
  await bridge.dispose()
})

test("stopReason:'refusal'/'max_tokens' → 'refusal'/'max-tokens'（映射表）", () => {
  assert.equal(mapStopReason('end_turn'), 'completed')
  assert.equal(mapStopReason('max_turn_requests'), 'completed')
  assert.equal(mapStopReason('max_tokens'), 'max-tokens')
  assert.equal(mapStopReason('refusal'), 'refusal')
  assert.equal(mapStopReason('cancelled'), 'aborted')
  assert.equal(mapStopReason(undefined), 'completed')
})

// ------------------------------------------------------------------ 4

test('cancel() 发出 session/cancel，turn 以 cancelled 结束 → aborted', async () => {
  let unblock
  const gate = new Promise((resolve) => {
    unblock = resolve
  })
  let signalStarted
  const started = new Promise((resolve) => {
    signalStarted = resolve
  })

  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      await api.notify(messageChunk('working'), ctx.params.sessionId)
      signalStarted()
      await gate
      return { stopReason: 'cancelled' }
    },
    onCancel: () => unblock(),
  })

  const bridge = new AcpBridge({ stream: agent.clientStream })
  await bridge.connect()
  const task = bridge.startTask({ cwd: 'C:\\work', prompt: 'long job' })
  await started
  assert.equal(bridge.sessionId, agent.seen.prompts[0].sessionId)

  await bridge.cancel()
  const result = await task

  assert.equal(result.stopReason, 'aborted')
  assert.equal(result.output, 'working')
  assert.equal(agent.seen.cancels.length, 1)
  assert.equal(agent.seen.cancels[0].sessionId, agent.seen.prompts[0].sessionId)
  await bridge.dispose()
})

// --------------------------------- 4b（Lead 裁决：已发 cancel + JSON-RPC reject → aborted）

test('本 turn 收到过 cancel() 时，prompt 以 JSON-RPC error(-32800) 结束 → aborted（diagnostic 保留）', async () => {
  let unblock
  const gate = new Promise((resolve) => {
    unblock = resolve
  })
  let signalStarted
  const started = new Promise((resolve) => {
    signalStarted = resolve
  })

  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      await api.notify(messageChunk('working'), ctx.params.sessionId)
      signalStarted()
      await gate
      // 对端以 JSON-RPC error 结束这个 prompt；判定只看「我们是否发过 cancel」，不看 code
      throw new acp.RequestError(-32800, 'Request cancelled: session/cancel received')
    },
    onCancel: () => unblock(),
  })

  const bridge = new AcpBridge({ stream: agent.clientStream })
  await bridge.connect()
  const task = bridge.startTask({ cwd: 'C:\\work', prompt: 'long job' })
  await started
  await bridge.cancel()
  const result = await task

  assert.equal(result.stopReason, 'aborted', '自己取消的 turn 不得报成 error（否则模型会当成失败重试）')
  assert.match(result.diagnostic, /Request cancelled/, '原 JSON-RPC message 仍要留在 diagnostic 里供审计')
  assert.equal(result.output, 'working')
  assert.equal(agent.seen.cancels.length, 1)
  await bridge.dispose()
})

test('未发 cancel() 时同一 code(-32800) 的 prompt error → 仍是 error（不把真失败误判成取消）', async () => {
  const agent = createFakeAgent({
    onPrompt: async () => {
      throw new acp.RequestError(-32800, 'Request cancelled by peer for unrelated reason')
    },
  })

  const bridge = new AcpBridge({ stream: agent.clientStream })
  await bridge.connect()
  const result = await bridge.startTask({ cwd: 'C:\\work', prompt: 'go' })

  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic, /unrelated reason/)
  await bridge.dispose()
})

test('取消标志不泄漏到下一个任务（同一 bridge：turn1 取消→aborted，turn2 同 code 失败→error）', async () => {
  let unblockFirst
  const firstGate = new Promise((resolve) => {
    unblockFirst = resolve
  })
  let signalFirstStarted
  const firstStarted = new Promise((resolve) => {
    signalFirstStarted = resolve
  })

  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      if (seen.prompts.length === 1) {
        await api.notify(messageChunk('first'), ctx.params.sessionId)
        signalFirstStarted()
        await firstGate
        throw new acp.RequestError(-32800, 'cancelled turn 1')
      }
      throw new acp.RequestError(-32800, 'genuine failure turn 2')
    },
    onCancel: () => unblockFirst(),
  })

  const bridge = new AcpBridge({ stream: agent.clientStream })
  await bridge.connect()

  const first = bridge.startTask({ cwd: 'C:\\work', prompt: 'turn 1' })
  await firstStarted
  await bridge.cancel()
  const firstResult = await first
  assert.equal(firstResult.stopReason, 'aborted')

  const secondResult = await bridge.startTask({ cwd: 'C:\\work', prompt: 'turn 2' })
  assert.equal(secondResult.stopReason, 'error', 'turn2 没收到 cancel，标志必须已在 turn 边界清零')
  assert.match(secondResult.diagnostic, /genuine failure turn 2/)
  assert.equal(agent.seen.prompts.length, 2)
  await bridge.dispose()
})

// ------------------------------------------------------------------ 5

test('审批：onApproval 的被调用，且命中缓存时带上 toolName/rawInput，返回值回给 agent', async () => {
  const rawInput = { file_path: 'C:\\work\\a.txt', sandbox_permissions: 'danger-full-access' }
  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      const sessionId = ctx.params.sessionId
      await api.notify(toolCall('call_7', 'write', rawInput), sessionId)
      seen.permissionOutcomes.push(
        await api.requestPermission({
          sessionId,
          toolCall: { toolCallId: 'call_7' },
          options: PERMISSION_OPTIONS,
        }),
      )
      return { stopReason: 'end_turn' }
    },
  })

  const asks = []
  const bridge = new AcpBridge({
    stream: agent.clientStream,
    onApproval: async (ask) => {
      asks.push(ask)
      return 'allow-once'
    },
  })
  await bridge.connect()
  const result = await bridge.startTask({ cwd: 'C:\\work', prompt: 'write a file' })

  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(asks, [{ toolCallId: 'call_7', toolName: 'write', rawInput }])
  assert.deepEqual(agent.seen.permissionOutcomes[0], {
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  })
  assert.equal(bridge.stats.approvals, 1)
  assert.equal(bridge.stats.approvalTimeouts, 0)
  await bridge.dispose()
})

// ------------------------------------------------------------------ 6

test('审批超时：onApproval 永不 settle 时，bridge 自己回 reject-once 且不打断 turn', async () => {
  let asked = 0
  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      const sessionId = ctx.params.sessionId
      await api.notify(toolCall('call_t', 'pwsh', { command: 'rm -rf /' }), sessionId)
      seen.permissionOutcomes.push(
        await api.requestPermission({
          sessionId,
          toolCall: { toolCallId: 'call_t' },
          options: PERMISSION_OPTIONS,
        }),
      )
      await api.notify(messageChunk('rejected, continuing'), sessionId)
      return { stopReason: 'end_turn' }
    },
  })

  const bridge = new AcpBridge({
    stream: agent.clientStream,
    approvalTimeoutMs: 50,
    onApproval: () => {
      asked += 1
      return new Promise(() => {}) // 永不 resolve：模拟 DSH 侧无审批超时（DESIGN §8.4）
    },
  })
  await bridge.connect()
  const result = await bridge.startTask({ cwd: 'C:\\work', prompt: 'danger' })

  assert.equal(asked, 1)
  assert.deepEqual(agent.seen.permissionOutcomes[0], {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  })
  assert.equal(result.stopReason, 'completed', '超时不得抛错打断 turn')
  assert.equal(result.output, 'rejected, continuing')
  assert.equal(bridge.stats.approvalTimeouts, 1)
  await bridge.dispose()
})

test('审批：onApproval reject/抛错也回 reject-once，不打断 turn', async () => {
  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      const sessionId = ctx.params.sessionId
      seen.permissionOutcomes.push(
        await api.requestPermission({
          sessionId,
          toolCall: { toolCallId: 'call_x' },
          options: PERMISSION_OPTIONS,
        }),
      )
      return { stopReason: 'end_turn' }
    },
  })

  const bridge = new AcpBridge({
    stream: agent.clientStream,
    approvalTimeoutMs: 5000,
    onApproval: () => {
      throw new Error('review-engine exploded')
    },
  })
  await bridge.connect()
  const result = await bridge.startTask({ cwd: 'C:\\work', prompt: 'go' })

  assert.deepEqual(agent.seen.permissionOutcomes[0], {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  })
  assert.equal(result.stopReason, 'completed')
  assert.equal(bridge.stats.approvalErrors, 1)
  assert.equal(bridge.stats.approvalTimeouts, 0)
  await bridge.dispose()
})

// ------------------------------------------------------------------ 7

test('审批缓存未命中：照样上报，toolName/rawInput 为 undefined，由决策层拒绝', async () => {
  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      // 刻意不发 tool_call：模拟缓存缺失（DESIGN §5.2 / §8.3 的安全缺口）
      const sessionId = ctx.params.sessionId
      seen.permissionOutcomes.push(
        await api.requestPermission({
          sessionId,
          toolCall: { toolCallId: 'call_ghost' },
          options: PERMISSION_OPTIONS,
        }),
      )
      return { stopReason: 'end_turn' }
    },
  })

  const asks = []
  const bridge = new AcpBridge({
    stream: agent.clientStream,
    onApproval: async (ask) => {
      asks.push(ask)
      return 'reject-once'
    },
  })
  await bridge.connect()
  const result = await bridge.startTask({ cwd: 'C:\\work', prompt: 'go' })

  assert.equal(asks.length, 1, '缓存未命中仍必须调用 onApproval')
  assert.deepEqual(asks[0], { toolCallId: 'call_ghost', toolName: undefined, rawInput: undefined })
  assert.deepEqual(agent.seen.permissionOutcomes[0], {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  })
  assert.equal(bridge.stats.toolCallMisses, 1)
  assert.equal(result.stopReason, 'completed')
  await bridge.dispose()
})

test('没有 onApproval 时 fail closed：回 reject-once（绝不默认放行）', async () => {
  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      const sessionId = ctx.params.sessionId
      seen.permissionOutcomes.push(
        await api.requestPermission({
          sessionId,
          toolCall: { toolCallId: 'call_none' },
          options: PERMISSION_OPTIONS,
        }),
      )
      return { stopReason: 'end_turn' }
    },
  })

  const bridge = new AcpBridge({ stream: agent.clientStream })
  await bridge.connect()
  const result = await bridge.startTask({ cwd: 'C:\\work', prompt: 'go' })
  assert.deepEqual(agent.seen.permissionOutcomes[0], {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  })
  assert.equal(result.stopReason, 'completed')
  await bridge.dispose()
})

// ------------------------------------------------------------------ 8

test('并发守卫：同一 bridge 上第二个 startTask 被拒（单任务槽）', async () => {
  let unblock
  const gate = new Promise((resolve) => {
    unblock = resolve
  })
  let signalStarted
  const started = new Promise((resolve) => {
    signalStarted = resolve
  })

  const agent = createFakeAgent({
    onPrompt: async () => {
      signalStarted()
      await gate
      return { stopReason: 'end_turn' }
    },
  })

  const bridge = new AcpBridge({ stream: agent.clientStream })
  await bridge.connect()
  const first = bridge.startTask({ cwd: 'C:\\work', prompt: 'one' })
  await started
  await assert.rejects(() => bridge.startTask({ cwd: 'C:\\work', prompt: 'two' }), /already in progress/)
  unblock()

  const result = await first
  assert.equal(result.stopReason, 'completed')
  assert.equal(agent.seen.prompts.length, 1)
  await bridge.dispose()
})

test('增量：opts.streamFactory 每次 connect() 调用一次；未建模变体归 other；只出现 update 的 toolCall 也进清单', async () => {
  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      const sessionId = ctx.params.sessionId
      // 只有 tool_call_update（没有前置 tool_call）：仍要出现在 TaskResult.toolCalls
      await api.notify(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_u',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
        },
        sessionId,
      )
      // 非实测 6 变体之外的通知（如 plan）→ kind 'other'，不得让 bridge 崩
      await api.notify({ sessionUpdate: 'plan', entries: [] }, sessionId)
      return { stopReason: 'end_turn' }
    },
  })

  let factoryCalls = 0
  const events = []
  const bridge = new AcpBridge({
    streamFactory: () => {
      factoryCalls += 1
      return agent.clientStream
    },
    onUpdate: (evt) => events.push(evt),
  })
  await bridge.connect()
  const result = await bridge.startTask({ cwd: 'C:\\work', prompt: 'go' })

  assert.equal(factoryCalls, 1)
  assert.deepEqual(result.toolCalls, [{ toolCallId: 'call_u', toolName: undefined, status: 'completed' }])
  assert.ok(
    events.some((evt) => evt.kind === 'other'),
    'plan 等未建模变体应归为 other',
  )
  assert.equal(result.stopReason, 'completed')
  await bridge.dispose()
})

test('dispose() 幂等，且 dispose 后 startTask/connect 拒绝', async () => {
  const agent = createFakeAgent({})
  const bridge = new AcpBridge({ stream: agent.clientStream })
  await bridge.connect()
  assert.equal(bridge.connected, true)

  await bridge.dispose()
  await bridge.dispose()
  await bridge.dispose()
  assert.equal(bridge.connected, false)

  await assert.rejects(() => bridge.startTask({ cwd: 'C:\\work', prompt: 'x' }), /disposed/)
  await assert.rejects(() => bridge.connect(), /disposed/)
  await bridge.cancel() // 幂等：已 dispose 时是 no-op

  // 从未 connect 过的桥，dispose 也必须安全且幂等
  const idle = new AcpBridge({ url: 'ws://127.0.0.1:1' })
  await idle.dispose()
  await idle.dispose()
  assert.equal(idle.connected, false)

  agent.close()
})

test('未 connect 时 startTask 拒绝；cancel 无任务时是 no-op', async () => {
  const bridge = new AcpBridge({ url: 'ws://127.0.0.1:1' })
  await assert.rejects(() => bridge.startTask({ cwd: 'C:\\work', prompt: 'x' }), /not connected/)
  await bridge.cancel()
  await bridge.dispose()
})

test('构造函数校验：没有 url/stream 时抛错；approvalTimeoutMs 非法时抛错', () => {
  assert.throws(() => new AcpBridge({}), /opts\.url/)
  assert.throws(() => new AcpBridge({ approvalTimeoutMs: -1, url: 'ws://x' }), /approvalTimeoutMs/)
  const bridge = new AcpBridge({ url: 'ws://x' })
  assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, 90_000)
})

// ------------------------- 9 per-call 回调（集成缝修正：一条 bridge 服务多个任务）

test('per-call onUpdate 生效（tool_call/tool_call_update/usage），且构造级 onUpdate 不被调用', async () => {
  const constructorEvents = []
  const callEvents = []
  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      const sessionId = ctx.params.sessionId
      await api.notify(toolCall('call_p', 'write', { file_path: 'C:\\work\\p.txt' }), sessionId)
      await api.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'call_p', status: 'completed' }, sessionId)
      await api.notify({ sessionUpdate: 'usage_update', used: 7, size: 100 }, sessionId)
      return { stopReason: 'end_turn' }
    },
  })

  const bridge = new AcpBridge({
    stream: agent.clientStream,
    onUpdate: (evt) => constructorEvents.push(evt),
  })
  await bridge.connect()
  const result = await bridge.startTask({
    cwd: 'C:\\work',
    prompt: 'go',
    onUpdate: (evt) => callEvents.push(evt),
  })

  assert.deepEqual(
    callEvents.map((evt) => evt.kind),
    ['tool_call', 'tool_call_update', 'usage'],
  )
  assert.deepEqual(constructorEvents, [], 'per-call onUpdate 存在时构造级 onUpdate 不得被调用')
  assert.deepEqual(callEvents[0].tool, {
    toolCallId: 'call_p',
    toolName: 'write',
    rawInput: { file_path: 'C:\\work\\p.txt' },
    status: 'pending',
  })
  assert.deepEqual(result.toolCalls, [{ toolCallId: 'call_p', toolName: 'write', status: 'completed' }])
  await bridge.dispose()
})

test('per-call onApproval 生效，且构造级 onApproval 不被调用', async () => {
  const constructorAsks = []
  const callAsks = []
  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      const sessionId = ctx.params.sessionId
      await api.notify(toolCall('call_a', 'pwsh', { command: 'echo hi' }), sessionId)
      seen.permissionOutcomes.push(
        await api.requestPermission({
          sessionId,
          toolCall: { toolCallId: 'call_a' },
          options: PERMISSION_OPTIONS,
        }),
      )
      return { stopReason: 'end_turn' }
    },
  })

  const bridge = new AcpBridge({
    stream: agent.clientStream,
    onApproval: async (ask) => {
      constructorAsks.push(ask)
      return 'reject-once'
    },
  })
  await bridge.connect()
  const result = await bridge.startTask({
    cwd: 'C:\\work',
    prompt: 'go',
    onApproval: async (ask) => {
      callAsks.push(ask)
      return 'allow-once'
    },
  })

  assert.deepEqual(callAsks, [{ toolCallId: 'call_a', toolName: 'pwsh', rawInput: { command: 'echo hi' } }])
  assert.deepEqual(constructorAsks, [], 'per-call onApproval 存在时构造级 onApproval 不得被调用')
  assert.deepEqual(agent.seen.permissionOutcomes[0], {
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  })
  assert.equal(result.stopReason, 'completed')
  await bridge.dispose()
})

test('两个连续任务各带不同 per-call 回调：事件与审批不串台', async () => {
  const events1 = []
  const events2 = []
  const asks1 = []
  const asks2 = []

  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      const turn = seen.prompts.length
      const sessionId = ctx.params.sessionId
      await api.notify(toolCall(`call_${turn}`, turn === 1 ? 'write' : 'pwsh', { turn }), sessionId)
      seen.permissionOutcomes.push(
        await api.requestPermission({
          sessionId,
          toolCall: { toolCallId: `call_${turn}` },
          options: PERMISSION_OPTIONS,
        }),
      )
      await api.notify({ sessionUpdate: 'usage_update', used: turn, size: 10 * turn }, sessionId)
      return { stopReason: 'end_turn' }
    },
  })

  const bridge = new AcpBridge({ stream: agent.clientStream })
  await bridge.connect()

  const first = await bridge.startTask({
    cwd: 'C:\\work',
    prompt: 'turn 1',
    onUpdate: (evt) => events1.push(evt),
    onApproval: async (ask) => {
      asks1.push(ask)
      return 'allow-once'
    },
  })
  const second = await bridge.startTask({
    cwd: 'C:\\work',
    prompt: 'turn 2',
    onUpdate: (evt) => events2.push(evt),
    onApproval: async (ask) => {
      asks2.push(ask)
      return 'reject-once'
    },
  })

  assert.deepEqual(
    events1.map((evt) => evt.tool?.toolCallId ?? evt.kind),
    ['call_1', 'usage'],
  )
  assert.deepEqual(
    events2.map((evt) => evt.tool?.toolCallId ?? evt.kind),
    ['call_2', 'usage'],
  )
  assert.deepEqual(
    asks1.map((ask) => ask.toolName),
    ['write'],
    '任务1 的审批只进回调1',
  )
  assert.deepEqual(
    asks2.map((ask) => ask.toolName),
    ['pwsh'],
    '任务2 的审批只进回调2',
  )
  assert.deepEqual(agent.seen.permissionOutcomes.map((o) => o.outcome.optionId), ['allow-once', 'reject-once'])
  assert.deepEqual(first.usage, { used: 1, size: 10 })
  assert.deepEqual(second.usage, { used: 2, size: 20 })
  await bridge.dispose()
})

test('startTask 不带回调时回落到构造级回调（onUpdate + onApproval 都是）', async () => {
  const constructorEvents = []
  const constructorAsks = []
  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      const sessionId = ctx.params.sessionId
      await api.notify(toolCall('call_fb', 'write', { file_path: 'C:\\work\\f.txt' }), sessionId)
      await api.notify(messageChunk('hi'), sessionId)
      seen.permissionOutcomes.push(
        await api.requestPermission({
          sessionId,
          toolCall: { toolCallId: 'call_fb' },
          options: PERMISSION_OPTIONS,
        }),
      )
      return { stopReason: 'end_turn' }
    },
  })

  const bridge = new AcpBridge({
    stream: agent.clientStream,
    onUpdate: (evt) => constructorEvents.push(evt),
    onApproval: async (ask) => {
      constructorAsks.push(ask)
      return 'allow-once'
    },
  })
  await bridge.connect()
  const result = await bridge.startTask({ cwd: 'C:\\work', prompt: 'go' })

  assert.deepEqual(
    constructorEvents.map((evt) => evt.kind),
    ['tool_call', 'message'],
    '无 per-call 回调 → 落到构造级 onUpdate',
  )
  assert.deepEqual(constructorAsks, [{ toolCallId: 'call_fb', toolName: 'write', rawInput: { file_path: 'C:\\work\\f.txt' } }])
  assert.deepEqual(agent.seen.permissionOutcomes[0], {
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  })
  assert.equal(result.stopReason, 'completed')
  await bridge.dispose()
})

test('per-call 与构造级都没有 onApproval → fail closed 回 reject-once（且 per-call onUpdate 仍工作）', async () => {
  const events = []
  const agent = createFakeAgent({
    onPrompt: async (ctx, seen, api) => {
      const sessionId = ctx.params.sessionId
      await api.notify(toolCall('call_none2', 'write', { file_path: 'C:\\work\\n.txt' }), sessionId)
      seen.permissionOutcomes.push(
        await api.requestPermission({
          sessionId,
          toolCall: { toolCallId: 'call_none2' },
          options: PERMISSION_OPTIONS,
        }),
      )
      return { stopReason: 'end_turn' }
    },
  })

  const bridge = new AcpBridge({ stream: agent.clientStream }) // 构造级 onApproval 也不给
  await bridge.connect()
  const result = await bridge.startTask({
    cwd: 'C:\\work',
    prompt: 'go',
    onUpdate: (evt) => events.push(evt),
  })

  assert.deepEqual(agent.seen.permissionOutcomes[0], {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  })
  assert.equal(result.stopReason, 'completed', 'fail closed 不得打断 turn')
  assert.deepEqual(
    events.map((evt) => evt.kind),
    ['tool_call'],
  )
  await bridge.dispose()
})

test('per-call onUpdate 事件只在任务内分发：任务结束后到达的 update 不落到任何回调', async () => {
  const events = []
  let lateUpdate
  let agentApi
  const agent = createFakeAgent({
    onPrompt: async (ctx) => {
      // 保存 sessionId，turn 结束后再补发一条迟到 update
      lateUpdate = () => agentApi.notify(messageChunk('late'), ctx.params.sessionId)
      return { stopReason: 'end_turn' }
    },
  })
  agentApi = agent

  const bridge = new AcpBridge({ stream: agent.clientStream, onUpdate: (evt) => events.push(evt) })
  await bridge.connect()
  await bridge.startTask({ cwd: 'C:\\work', prompt: 'go', onUpdate: (evt) => events.push(evt) })
  assert.deepEqual(events, [])

  await lateUpdate()
  // 让传输层跑完
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(events, [], 'turn 已结束，迟到 update 无归属者，必须丢弃（不得落到下一个任务的回调）')
  await bridge.dispose()
})

test('startTask 的 per-call 回调类型非法时抛 TypeError（在创建 session 之前）', async () => {
  const agent = createFakeAgent({})
  const bridge = new AcpBridge({ stream: agent.clientStream })
  await bridge.connect()
  await assert.rejects(
    () => bridge.startTask({ cwd: 'C:\\work', prompt: 'go', onUpdate: 'not-a-function' }),
    /req\.onUpdate must be a function/,
  )
  await assert.rejects(
    () => bridge.startTask({ cwd: 'C:\\work', prompt: 'go', onApproval: 42 }),
    /req\.onApproval must be a function/,
  )
  assert.equal(agent.seen.newSessions.length, 0, '参数非法时不得创建 session')
  await bridge.dispose()
})
