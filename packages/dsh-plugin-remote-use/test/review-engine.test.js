// INTERFACES.md 【A】core/review-engine.js —— 单元测试（node --test，无测试框架依赖）
//
// 重点：规则**顺序**本身是被测契约。任何把「档位检查」挪到记忆之后、
// 或把「缓存缺失」挪到档位检查之后的实现，都必须在这里失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  COMMAND_TOOLS,
  OPTION,
  TIER,
  WRITE_TOOLS,
  decideApproval,
  inferRequiredTier,
  memoryKey,
} from '../lib/core/review-engine.js'
import { TaskMemory } from '../lib/core/task-memory.js'

const TASK = 'task-1'

/** @param {Record<string, unknown>} [over] */
function request(over = {}) {
  return { toolCallId: 'call_1', toolName: 'write', rawInput: {}, taskId: TASK, ...over }
}

/** @param {{ memory?: TaskMemory, policy?: Record<string, unknown> }} [over] */
function context(over = {}) {
  return {
    memory: new TaskMemory(TASK),
    policy: { requiredTier: 'workspace-write' },
    ...over,
  }
}

/* ───────────────────────────── 常量契约 ───────────────────────────── */

test('constants: TIER 从窄到宽、OPTION 是 ACP 的两个硬编码 optionId', () => {
  assert.deepEqual([...TIER], ['read-only', 'workspace-write', 'danger-full-access'])
  assert.deepEqual({ ...OPTION }, { ALLOW_ONCE: 'allow-once', REJECT_ONCE: 'reject-once' })
  for (const tool of ['write', 'edit', 'str_replace_editor', 'fs_write']) {
    assert.ok(WRITE_TOOLS.includes(tool), `WRITE_TOOLS 至少含 ${tool}`)
  }
  assert.ok(COMMAND_TOOLS.includes('pwsh'))
  assert.ok(COMMAND_TOOLS.includes('bash'))
})

/* ───────────────────── 规则 1：缓存缺失 → 拒绝 ───────────────────── */

test('[rule 1] rawInput undefined = 缓存缺失 → reject-once / cache-miss / needsHuman=false', () => {
  const decision = decideApproval(request({ rawInput: undefined }), context())

  assert.equal(decision.optionId, 'reject-once')
  assert.equal(decision.source, 'cache-miss')
  assert.equal(decision.needsHuman, false)
  assert.match(decision.reason, /call_1/) // 可审计：指出是哪条 toolCallId
  assert.match(decision.reason, /fail closed/i)
})

test('[rule 1] null / 非对象 rawInput 同样按缓存缺失拒绝（无法判断就拒绝）', () => {
  for (const rawInput of [null, 'garbage', 42, []]) {
    const decision = decideApproval(request({ rawInput }), context())
    assert.equal(decision.source, 'cache-miss', `rawInput=${JSON.stringify(rawInput)}`)
    assert.equal(decision.optionId, 'reject-once')
  }
})

test('[rule 1] 空对象 rawInput ≠ 缓存缺失（缓存里有记录，只是没参数）→ 走到人工/规则 6', () => {
  const decision = decideApproval(request({ rawInput: {} }), context())
  assert.equal(decision.source, 'human')
  assert.equal(decision.needsHuman, true)
})

test('[rule 1] Decision 恰好 4 个字段（契约形状）', () => {
  const decision = decideApproval(request({ rawInput: undefined }), context())
  assert.deepEqual(Object.keys(decision).sort(), ['needsHuman', 'optionId', 'reason', 'source'])
})

/* ───────────────── 规则 2：档位检查（核心安全缺口） ───────────────── */

test('[rule 2] 申请档位宽于所需 → reject-once / tier-check，reason 含 narrow 与所需档位', () => {
  const decision = decideApproval(
    request({ rawInput: { sandbox_permissions: 'workspace-write' } }),
    context({ policy: { requiredTier: 'read-only' } }),
  )

  assert.equal(decision.optionId, 'reject-once')
  assert.equal(decision.source, 'tier-check')
  assert.equal(decision.needsHuman, false)
  assert.match(decision.reason, /narrow/) // 契约：reason 必须含 "narrow"
  assert.match(decision.reason, /read-only/) // 契约：reason 必须含所需档位名
  assert.match(decision.reason, /workspace-write/) // 也说明模型申请了什么
})

test('[rule 2] policy.requiredTier 是权威的「最小所需档位」，不因 rawInput 里的路径而改变', () => {
  // 说明：契约把 inferRequiredTier 单独导出，由调用方（知道 workspaceRoot 的那一层）
  // 先算出 requiredTier 再传进 policy；引擎自己不猜。
  const decision = decideApproval(
    request({ rawInput: { sandbox_permissions: 'workspace-write', file_path: 'C:\\ws\\a.txt' } }),
    context({ policy: { requiredTier: 'read-only' } }),
  )

  assert.equal(decision.source, 'tier-check')
})

test('[rule 2] 申请档位刚好等于所需 → 不触发档位检查，继续后续规则', () => {
  const decision = decideApproval(
    request({ rawInput: { sandbox_permissions: 'workspace-write' } }),
    context({ policy: { requiredTier: 'workspace-write' } }),
  )

  assert.equal(decision.source, 'human') // 无记忆、无任务级授权 → 规则 6
})

test('[rule 2] 申请档位窄于所需 → 不拒绝，继续后续规则', () => {
  const decision = decideApproval(
    request({ rawInput: { sandbox_permissions: 'read-only' } }),
    context({ policy: { requiredTier: 'workspace-write' } }),
  )

  assert.equal(decision.source, 'human')
})

test('[rule 2] 未申请提权（没有 sandbox_permissions）→ 与档位检查无关', () => {
  const decision = decideApproval(
    request({ rawInput: { file_path: 'C:\\ws\\a.txt' } }),
    context({ policy: { requiredTier: 'read-only' } }),
  )

  assert.equal(decision.source, 'human')
})

test('[rule 2] danger-full-access 必须人工确认：needsHuman=true，规则不得自动放行', () => {
  const decision = decideApproval(
    request({ rawInput: { sandbox_permissions: 'danger-full-access' } }),
    context({ policy: { requiredTier: 'workspace-write' } }),
  )

  assert.equal(decision.needsHuman, true)
  assert.equal(decision.optionId, 'reject-once') // 缺省拒绝，人工批准后由调用方覆盖
  assert.match(decision.reason, /danger-full-access/)
  assert.match(decision.reason, /human confirmation/i)
  assert.match(decision.reason, /workspace-write/) // 指引模型改用窄档重试
})

test('[rule 2] danger-full-access + 任务级授权 + 批准记忆 → 仍然上报人工（§10.0.1 缺口）', () => {
  const memory = new TaskMemory(TASK)
  const payload = {
    toolCallId: 'call_danger',
    toolName: 'write',
    rawInput: { sandbox_permissions: 'danger-full-access', file_path: 'C:\\ws\\a.txt' },
    taskId: TASK,
  }
  memory.noteApprove(memoryKey(payload)) // 记忆里明明批准过这个 key

  const decision = decideApproval(payload, {
    memory,
    policy: { requiredTier: 'workspace-write', allowedTools: ['write'], allowedPaths: ['C:\\ws'] },
  })

  assert.equal(decision.optionId, 'reject-once')
  assert.equal(decision.needsHuman, true)
  assert.equal(decision.source, 'tier-check')
})

test('[rule 2] danger-full-access 之外，未知档位字符串也一律拒绝（无法比较 → fail closed）', () => {
  const decision = decideApproval(
    request({ rawInput: { sandbox_permissions: 'yolo-everything' } }),
    context({ policy: { requiredTier: 'workspace-write' } }),
  )

  assert.equal(decision.optionId, 'reject-once')
  assert.equal(decision.source, 'tier-check')
  assert.equal(decision.needsHuman, false)
  assert.match(decision.reason, /yolo-everything/)
})

test('[rule 2] 兼容 camelCase 别名 sandboxPermissions，两者同时出现时取更宽者', () => {
  const camel = decideApproval(
    request({ rawInput: { sandboxPermissions: 'danger-full-access' } }),
    context(),
  )
  assert.equal(camel.needsHuman, true)

  const both = decideApproval(
    request({ rawInput: { sandbox_permissions: 'read-only', sandboxPermissions: 'danger-full-access' } }),
    context(),
  )
  assert.equal(both.needsHuman, true)
  assert.match(both.reason, /danger-full-access/)
})

test('[rule 2] policy.requiredTier 缺失/非法时不抛错，用 inferRequiredTier 兜底', () => {
  const decision = decideApproval(
    request({ rawInput: { sandbox_permissions: 'workspace-write' } }),
    context({ policy: {} }),
  )

  assert.equal(decision.source, 'human') // 兜底档位 = workspace-write → 申请刚好
})

/* ──────────────────── 规则 3 / 4：任务内记忆 ──────────────────── */

test('[rule 3] 任务内拒绝记忆命中 → reject-once / memory', () => {
  const memory = new TaskMemory(TASK)
  const payload = request({ rawInput: { file_path: 'C:\\ws\\a.txt' } })
  memory.noteReject(memoryKey(payload))

  const decision = decideApproval(payload, context({ memory }))

  assert.equal(decision.optionId, 'reject-once')
  assert.equal(decision.source, 'memory')
  assert.equal(decision.needsHuman, false)
  assert.match(decision.reason, /write:C:\\ws/)
})

test('[rule 4] 任务内批准记忆（scope=task）命中 → allow-once / memory，且本任务内持续有效', () => {
  const memory = new TaskMemory(TASK)
  const payload = request({ rawInput: { file_path: 'C:\\ws\\a.txt' } })
  memory.noteApprove(memoryKey(payload))

  const first = decideApproval(payload, context({ memory }))
  const second = decideApproval(payload, context({ memory }))

  for (const decision of [first, second]) {
    assert.equal(decision.optionId, 'allow-once')
    assert.equal(decision.source, 'memory')
    assert.equal(decision.needsHuman, false)
  }
  assert.match(first.reason, /task-scope/i)
})

test('[rule 4] scope=once 的批准只放行一次，用掉后回落到人工', () => {
  const memory = new TaskMemory(TASK)
  const payload = request({ rawInput: { file_path: 'C:\\ws\\a.txt' } })
  const key = memoryKey(payload)
  memory.noteApprove(key, { scope: 'once' })

  const first = decideApproval(payload, context({ memory }))
  assert.equal(first.optionId, 'allow-once')
  assert.equal(first.source, 'memory')
  assert.match(first.reason, /once-scope/i)
  assert.deepEqual(memory.snapshot().once, []) // 一次性批准已被消耗

  const second = decideApproval(payload, context({ memory }))
  assert.equal(second.source, 'human')
  assert.equal(second.needsHuman, true)
})

test('[rule 3] 拒绝记忆优先于批准记忆（同一 key 被拒绝过就是拒绝）', () => {
  const memory = new TaskMemory(TASK)
  const payload = request({ rawInput: { file_path: 'C:\\ws\\a.txt' } })
  const key = memoryKey(payload)
  memory.noteApprove(key)
  memory.noteReject(key)

  const decision = decideApproval(payload, context({ memory }))

  assert.equal(decision.optionId, 'reject-once')
  assert.equal(decision.source, 'memory')
})

test('[rule 3/4] dispose() 后记忆失效 → 不再自动放行/拒绝，回落到人工', () => {
  const memory = new TaskMemory(TASK)
  const payload = request({ rawInput: { file_path: 'C:\\ws\\a.txt' } })
  const key = memoryKey(payload)
  memory.noteApprove(key)
  memory.noteReject('write:C:\\other')
  memory.dispose()

  const approved = decideApproval(payload, context({ memory }))
  assert.equal(approved.source, 'human')
  assert.equal(approved.needsHuman, true)

  const rejected = decideApproval(
    request({ rawInput: { file_path: 'C:\\other\\a.txt' } }),
    context({ memory }),
  )
  assert.equal(rejected.source, 'human')
})

/* ───────────────────── 规则 5：任务级授权范围 ───────────────────── */

test('[rule 5] allowedTools 命中 → allow-once / policy', () => {
  const decision = decideApproval(
    request({ toolName: 'pwsh', rawInput: { command: 'git status' } }),
    context({ policy: { requiredTier: 'workspace-write', allowedTools: ['pwsh', 'read'] } }),
  )

  assert.equal(decision.optionId, 'allow-once')
  assert.equal(decision.source, 'policy')
  assert.equal(decision.needsHuman, false)
  assert.match(decision.reason, /allowedTools/)
})

test('[rule 5] allowedTools 是精确匹配（大小写不同不算命中）', () => {
  const decision = decideApproval(
    request({ toolName: 'PWSh', rawInput: { command: 'git status' } }),
    context({ policy: { requiredTier: 'workspace-write', allowedTools: ['pwsh'] } }),
  )

  assert.equal(decision.source, 'human')
})

test('[rule 5] allowedPaths 命中（路径在该目录之内）→ allow-once / policy', () => {
  const decision = decideApproval(
    request({ rawInput: { file_path: 'C:\\ws\\sub\\a.txt' } }),
    context({ policy: { requiredTier: 'workspace-write', allowedPaths: ['C:\\ws'] } }),
  )

  assert.equal(decision.optionId, 'allow-once')
  assert.equal(decision.source, 'policy')
  assert.match(decision.reason, /allowedPaths/)
})

test('[rule 5] allowedPaths 不命中（路径在目录之外）→ 不授权', () => {
  const decision = decideApproval(
    request({ rawInput: { file_path: 'C:\\other\\a.txt' } }),
    context({ policy: { requiredTier: 'workspace-write', allowedPaths: ['C:\\ws'] } }),
  )

  assert.equal(decision.source, 'human')
})

test('[rule 5] allowedPaths 前缀不会被相邻目录骗过（C:\\ws 不含 C:\\wsevil）', () => {
  const decision = decideApproval(
    request({ rawInput: { file_path: 'C:\\wsevil\\a.txt' } }),
    context({ policy: { requiredTier: 'workspace-write', allowedPaths: ['C:\\ws'] } }),
  )

  assert.equal(decision.source, 'human')
})

test('[rule 5] 相对路径：给了 workspaceRoot 才算得出（否则 fail closed 上报人工）', () => {
  const withoutRoot = decideApproval(
    request({ rawInput: { file_path: 'a.txt' } }),
    context({ policy: { requiredTier: 'workspace-write', allowedPaths: ['C:\\ws'] } }),
  )
  assert.equal(withoutRoot.source, 'human')

  const withRoot = decideApproval(
    request({ rawInput: { file_path: 'a.txt' } }),
    context({ policy: { requiredTier: 'workspace-write', allowedPaths: ['C:\\ws'], workspaceRoot: 'C:\\ws' } }),
  )
  assert.equal(withRoot.source, 'policy')
})

test('[rule 5] POSIX 路径同样按前缀包含判断', () => {
  const inside = decideApproval(
    request({ rawInput: { file_path: '/srv/ws/sub/a.txt' } }),
    context({ policy: { requiredTier: 'workspace-write', allowedPaths: ['/srv/ws'] } }),
  )
  assert.equal(inside.source, 'policy')

  const outside = decideApproval(
    request({ rawInput: { file_path: '/srv/other/a.txt' } }),
    context({ policy: { requiredTier: 'workspace-write', allowedPaths: ['/srv/ws'] } }),
  )
  assert.equal(outside.source, 'human')
})

/* ───────────────────────── 规则 6：上报人工 ───────────────────────── */

test('[rule 6] 无任何规则命中 → needsHuman=true / source=human / 缺省 reject-once', () => {
  const decision = decideApproval(
    request({ rawInput: { file_path: 'C:\\ws\\a.txt' } }),
    context(),
  )

  assert.equal(decision.optionId, 'reject-once')
  assert.equal(decision.source, 'human')
  assert.equal(decision.needsHuman, true)
  assert.match(decision.reason, /write:C:\\ws/)
})

/* ─────────────────── 规则顺序（顺序本身是被测契约） ─────────────────── */

test('[order] 缓存缺失优先于一切：即使拒绝记忆里已有对应 key', () => {
  const memory = new TaskMemory(TASK)
  const withInput = request({ rawInput: { file_path: 'C:\\ws\\a.txt' } })
  memory.noteReject(memoryKey(withInput)) // 'write:C:\ws'

  // 先证明这条记忆确实有效
  assert.equal(decideApproval(withInput, context({ memory })).source, 'memory')
  // 缓存缺失时必须是 cache-miss，而不是 memory
  const decision = decideApproval(request({ rawInput: undefined }), context({ memory }))
  assert.equal(decision.source, 'cache-miss')
  assert.equal(decision.optionId, 'reject-once')
})

test('[order] 档位检查优先于拒绝记忆：同时命中也必须是 tier-check', () => {
  const memory = new TaskMemory(TASK)
  const payload = request({
    rawInput: { sandbox_permissions: 'workspace-write', file_path: 'C:\\other\\a.txt' },
  })
  memory.noteReject(memoryKey(payload)) // 拒绝记忆确实命中

  const decision = decideApproval(payload, context({ memory, policy: { requiredTier: 'read-only' } }))

  assert.equal(decision.source, 'tier-check')
  assert.equal(decision.optionId, 'reject-once')
})

test('[order] 档位检查优先于任务级授权：allowedPaths 命中也不能放行过宽申请', () => {
  const decision = decideApproval(
    request({ rawInput: { sandbox_permissions: 'workspace-write', file_path: 'C:\\ws\\a.txt' } }),
    context({ policy: { requiredTier: 'read-only', allowedPaths: ['C:\\ws'] } }),
  )

  assert.equal(decision.source, 'tier-check')
  assert.equal(decision.optionId, 'reject-once')
})

test('[order] 拒绝记忆优先于批准记忆（同 key 冲突时拒绝胜出）', () => {
  const memory = new TaskMemory(TASK)
  const payload = request({ rawInput: { file_path: 'C:\\ws\\a.txt' } })
  const key = memoryKey(payload)
  memory.noteReject(key)
  memory.noteApprove(key, { scope: 'once' })

  const decision = decideApproval(payload, context({ memory }))

  assert.equal(decision.source, 'memory')
  assert.equal(decision.optionId, 'reject-once')
})

test('[order] 记忆优先于任务级授权：拒绝记忆 > allowedTools 放行', () => {
  const memory = new TaskMemory(TASK)
  const payload = request({ toolName: 'read', rawInput: { file_path: 'C:\\ws\\a.txt' } })
  memory.noteReject(memoryKey(payload)) // 'tool:read'

  const decision = decideApproval(
    payload,
    context({ memory, policy: { requiredTier: 'workspace-write', allowedTools: ['read'] } }),
  )

  assert.equal(decision.source, 'memory')
  assert.equal(decision.optionId, 'reject-once')
})

test('[order] 记忆优先于任务级授权：批准记忆命中时 source=memory（不是 policy）', () => {
  const memory = new TaskMemory(TASK)
  const payload = request({ toolName: 'read', rawInput: { file_path: 'C:\\ws\\a.txt' } })
  memory.noteApprove(memoryKey(payload))

  const decision = decideApproval(
    payload,
    context({ memory, policy: { requiredTier: 'workspace-write', allowedTools: ['read'] } }),
  )

  assert.equal(decision.source, 'memory')
  assert.equal(decision.optionId, 'allow-once')
})

/* ───────────────────── 健壮性：垃圾输入不抛错 ───────────────────── */

test('[robustness] 缺失 req / ctx / memory 时不抛错，且退化为人工或缓存缺失', () => {
  assert.doesNotThrow(() => decideApproval(undefined, undefined))
  assert.doesNotThrow(() => decideApproval(null, null))
  assert.doesNotThrow(() => decideApproval(request(), undefined))
  assert.doesNotThrow(() => decideApproval(request(), { policy: undefined, memory: undefined }))
  assert.doesNotThrow(() => decideApproval(request({ rawInput: { sandbox_permissions: 5 } }), context()))

  assert.equal(decideApproval(undefined, undefined).source, 'cache-miss')
  assert.equal(decideApproval(request(), { memory: undefined, policy: {} }).source, 'human')
})

test('[robustness] 非字符串 sandbox_permissions / 空串按「未申请提权」处理', () => {
  for (const value of [5, null, '', '   ', {}, []]) {
    const decision = decideApproval(
      request({ rawInput: { sandbox_permissions: value } }),
      context({ policy: { requiredTier: 'read-only' } }),
    )
    assert.equal(decision.source, 'human', `sandbox_permissions=${JSON.stringify(value)}`)
  }
})

test('[robustness] 任何情况下 optionId 只会是 allow-once / reject-once', () => {
  const cases = [
    [request({ rawInput: undefined }), context()],
    [request({ rawInput: { sandbox_permissions: 'danger-full-access' } }), context()],
    [request({ rawInput: { sandbox_permissions: 'workspace-write' } }), context({ policy: { requiredTier: 'read-only' } })],
    [request(), context()],
  ]
  for (const [req, ctx] of cases) {
    const decision = decideApproval(req, ctx)
    assert.ok(['allow-once', 'reject-once'].includes(decision.optionId))
    assert.equal(typeof decision.reason, 'string')
    assert.ok(decision.reason.length > 20)
    assert.equal(typeof decision.needsHuman, 'boolean')
  }
})

/* ─────────────────────────── inferRequiredTier ─────────────────────────── */

test('inferRequiredTier: 空/无路径无命令 → 调用方给的 defaultTier', () => {
  assert.equal(inferRequiredTier(undefined, { defaultTier: 'workspace-write' }), 'workspace-write')
  assert.equal(inferRequiredTier({}, { defaultTier: 'read-only' }), 'read-only')
  assert.equal(inferRequiredTier({ file_path: '' }, { defaultTier: 'read-only' }), 'read-only')
  assert.equal(inferRequiredTier({}, {}), 'workspace-write') // 无效 defaultTier → 兜底档
})

test('inferRequiredTier: 命令类工具 → workspace-write', () => {
  assert.equal(inferRequiredTier({ command: 'pwsh -c "ls"' }, { defaultTier: 'read-only' }), 'workspace-write')
  assert.equal(inferRequiredTier({ command: 'git status' }, { toolName: 'pwsh', defaultTier: 'read-only' }), 'workspace-write')
  assert.equal(inferRequiredTier({ command: 'git status' }, { toolName: 'bash', defaultTier: 'read-only' }), 'workspace-write')
})

test('inferRequiredTier: 路径在 workspaceRoot 之内 + 读类工具 → read-only', () => {
  assert.equal(
    inferRequiredTier({ file_path: 'C:\\ws\\a.txt' }, { workspaceRoot: 'C:\\ws', toolName: 'read', defaultTier: 'workspace-write' }),
    'read-only',
  )
  assert.equal(
    inferRequiredTier({ path: '/srv/ws/a.txt' }, { workspaceRoot: '/srv/ws', defaultTier: 'workspace-write' }),
    'read-only',
  )
  // Windows 路径大小写不敏感：c:\WS 仍视为在同一工作区内
  assert.equal(
    inferRequiredTier({ file_path: 'c:\\WS\\a.txt' }, { workspaceRoot: 'C:\\ws', defaultTier: 'read-only' }),
    'read-only',
  )
})

test('inferRequiredTier: 路径在 workspaceRoot 之内 + 写类工具 → workspace-write', () => {
  assert.equal(
    inferRequiredTier({ file_path: 'C:\\ws\\a.txt' }, { workspaceRoot: 'C:\\ws', toolName: 'write', defaultTier: 'read-only' }),
    'workspace-write',
  )
  // 工具名缺失时看参数形状（content = 写），宁可判宽
  assert.equal(
    inferRequiredTier({ file_path: 'C:\\ws\\a.txt', content: 'hi' }, { workspaceRoot: 'C:\\ws', defaultTier: 'read-only' }),
    'workspace-write',
  )
})

test('inferRequiredTier: 路径在 workspaceRoot 之外 → workspace-write（§8.3 关键规则）', () => {
  assert.equal(
    inferRequiredTier({ file_path: 'C:\\other\\a.txt' }, { workspaceRoot: 'C:\\ws', toolName: 'read', defaultTier: 'read-only' }),
    'workspace-write',
  )
  assert.equal(
    inferRequiredTier({ file_path: 'C:\\ws\\..\\other\\a.txt' }, { workspaceRoot: 'C:\\ws', defaultTier: 'read-only' }),
    'workspace-write',
  )
})

test('inferRequiredTier: 相对路径按 workspaceRoot 解析；没有绝对 workspaceRoot 时回落到 defaultTier', () => {
  assert.equal(
    inferRequiredTier({ file_path: 'a.txt' }, { workspaceRoot: 'C:\\ws', defaultTier: 'workspace-write' }),
    'read-only',
  )
  assert.equal(
    inferRequiredTier({ file_path: 'C:\\ws\\a.txt' }, { defaultTier: 'read-only' }),
    'read-only',
  )
  assert.equal(
    inferRequiredTier({ file_path: '..\\a.txt' }, { workspaceRoot: 'C:\\ws', defaultTier: 'read-only' }),
    'workspace-write',
  )
})

test('inferRequiredTier: 工具名是写类判定的权威（read 不会因为带 content 就变写）', () => {
  assert.equal(
    inferRequiredTier({ file_path: 'C:\\ws\\a.txt', content: 'x' }, { workspaceRoot: 'C:\\ws', toolName: 'read', defaultTier: 'read-only' }),
    'read-only',
  )
  assert.equal(
    inferRequiredTier({ file_path: 'C:\\ws\\a.txt' }, { workspaceRoot: 'C:\\ws', toolName: 'fs_write', defaultTier: 'read-only' }),
    'workspace-write',
  )
})

test('inferRequiredTier: 只返回合法档位名', () => {
  const samples = [
    [undefined, { defaultTier: 'workspace-write' }],
    [{ command: 'ls' }, { defaultTier: 'read-only' }],
    [{ file_path: 'C:\\ws\\a.txt' }, { workspaceRoot: 'C:\\ws', defaultTier: 'read-only' }],
    [{ file_path: 'C:\\o\\a.txt' }, { workspaceRoot: 'C:\\ws', defaultTier: 'read-only' }],
  ]
  for (const [rawInput, opts] of samples) {
    assert.ok(TIER.includes(inferRequiredTier(rawInput, opts)))
  }
})

/* ───────────────────────────── memoryKey ───────────────────────────── */

test('memoryKey: 写类工具 → write:<父目录>（file_path 与 path 都支持）', () => {
  assert.equal(memoryKey({ toolName: 'write', rawInput: { file_path: 'F:\\WorkSpace\\proj\\a.txt' } }), 'write:F:\\WorkSpace\\proj')
  assert.equal(memoryKey({ toolName: 'edit', rawInput: { path: 'C:/ws/sub/b.txt' } }), 'write:C:/ws/sub')
  assert.equal(memoryKey({ toolName: 'str_replace_editor', rawInput: { file_path: '/srv/ws/a.txt' } }), 'write:/srv/ws')
  assert.equal(memoryKey({ toolName: 'fs_write', rawInput: { file_path: 'C:\\ws\\sub\\' } }), 'write:C:\\ws')
  assert.equal(memoryKey({ toolName: 'write', rawInput: { file_path: 'a.txt' } }), 'write:.')
  assert.equal(memoryKey({ toolName: 'write', rawInput: { file_path: '/a.txt' } }), 'write:/')
})

test('memoryKey: 命令类工具 → exec:<命令首词>', () => {
  assert.equal(memoryKey({ toolName: 'pwsh', rawInput: { command: '  git   status --short' } }), 'exec:git')
  assert.equal(memoryKey({ toolName: 'bash', rawInput: { command: 'npm run build' } }), 'exec:npm')
  assert.equal(memoryKey({ toolName: 'pwsh', rawInput: { command: '' } }), 'tool:pwsh') // 无首词 → 退化
})

test('memoryKey: 其余工具 → tool:<toolName>', () => {
  assert.equal(memoryKey({ toolName: 'read', rawInput: { file_path: 'C:\\ws\\a.txt' } }), 'tool:read')
  assert.equal(memoryKey({ toolName: 'write', rawInput: {} }), 'tool:write') // 写类但没给路径 → 退化
  assert.equal(memoryKey({}), 'tool:unknown')
  assert.equal(memoryKey(undefined), 'tool:unknown')
})

test('memoryKey: 同目录同键、不同目录不同键（同类不再问的前提）', () => {
  const one = memoryKey({ toolName: 'write', rawInput: { file_path: 'C:\\ws\\a.txt' } })
  const two = memoryKey({ toolName: 'write', rawInput: { file_path: 'C:\\ws\\b.txt' } })
  const other = memoryKey({ toolName: 'write', rawInput: { file_path: 'C:\\other\\b.txt' } })

  assert.equal(one, two)
  assert.notEqual(one, other)
})

test('memoryKey: 工具名忽略大小写分类（键里保留原始工具名）', () => {
  assert.equal(memoryKey({ toolName: 'WRITE', rawInput: { file_path: 'C:\\ws\\a.txt' } }), 'write:C:\\ws')
  assert.equal(memoryKey({ toolName: 'Read', rawInput: { file_path: 'C:\\ws\\a.txt' } }), 'tool:Read')
})
