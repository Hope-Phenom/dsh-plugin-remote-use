// INTERFACES.md 【A】core/task-memory.js —— 单元测试（node --test，无测试框架依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TaskMemory } from '../lib/core/task-memory.js'

test('noteApprove 默认 scope=task: lookup=allowed 且任务内持续有效', () => {
  const memory = new TaskMemory('task-1')
  memory.noteApprove('write:C:\\ws')

  assert.equal(memory.lookup('write:C:\\ws'), 'allowed')
  assert.equal(memory.consumeOnce('write:C:\\ws'), false) // task 作用域不会被消耗
  assert.equal(memory.lookup('write:C:\\ws'), 'allowed')
  assert.deepEqual(memory.snapshot(), {
    taskId: 'task-1',
    approvals: ['write:C:\\ws'],
    rejections: [],
    once: [],
  })
})

test('noteApprove scope=task 显式指定时同样是任务级授权', () => {
  const memory = new TaskMemory('task-1')
  memory.noteApprove('exec:git', { scope: 'task' })

  assert.equal(memory.lookup('exec:git'), 'allowed')
  assert.equal(memory.consumeOnce('exec:git'), false)
  assert.deepEqual(memory.snapshot().once, [])
})

test('noteApprove scope=once: lookup=allowed，但 consumeOnce 只放行一次', () => {
  const memory = new TaskMemory('task-1')
  memory.noteApprove('write:C:\\ws', { scope: 'once' })

  assert.equal(memory.lookup('write:C:\\ws'), 'allowed')
  assert.equal(memory.consumeOnce('write:C:\\ws'), true) // 这次放行已用掉
  assert.equal(memory.lookup('write:C:\\ws'), 'unknown') // 用掉即失效
  assert.equal(memory.consumeOnce('write:C:\\ws'), false)
  assert.deepEqual(memory.snapshot().once, [])
})

test('noteApprove: 未识别的 scope 按 once 处理（fail closed，不静默放大授权）', () => {
  const memory = new TaskMemory('task-1')
  memory.noteApprove('write:C:\\ws', /** @type {any} */ ({ scope: 'forever' }))

  assert.deepEqual(memory.snapshot().once, ['write:C:\\ws'])
  assert.deepEqual(memory.snapshot().approvals, [])
})

test('noteApprove: 已是 task 级授权时再记 once 不生效（不降级）', () => {
  const memory = new TaskMemory('task-1')
  memory.noteApprove('write:C:\\ws')
  memory.noteApprove('write:C:\\ws', { scope: 'once' })

  assert.deepEqual(memory.snapshot().once, [])
  assert.equal(memory.consumeOnce('write:C:\\ws'), false)
  assert.equal(memory.lookup('write:C:\\ws'), 'allowed')
})

test('noteApprove: once → task 升级会从 once 移出', () => {
  const memory = new TaskMemory('task-1')
  memory.noteApprove('write:C:\\ws', { scope: 'once' })
  memory.noteApprove('write:C:\\ws')

  const snapshot = memory.snapshot()
  assert.deepEqual(snapshot.once, [])
  assert.deepEqual(snapshot.approvals, ['write:C:\\ws'])
})

test('noteReject: lookup=rejected，且被拒绝后不再询问', () => {
  const memory = new TaskMemory('task-1')
  memory.noteReject('write:C:\\ws')

  assert.equal(memory.lookup('write:C:\\ws'), 'rejected')
  assert.deepEqual(memory.snapshot(), {
    taskId: 'task-1',
    approvals: [],
    rejections: ['write:C:\\ws'],
    once: [],
  })
})

test('noteReject 优先于 noteApprove（拒绝覆盖批准，fail closed）', () => {
  const memory = new TaskMemory('task-1')
  memory.noteApprove('write:C:\\ws')
  memory.noteReject('write:C:\\ws')

  assert.equal(memory.lookup('write:C:\\ws'), 'rejected')
  assert.equal(memory.consumeOnce('write:C:\\ws'), false)
  assert.equal(memory.lookup('write:C:\\ws'), 'rejected')
})

test('noteReject 作废待用的一次性批准', () => {
  const memory = new TaskMemory('task-1')
  memory.noteApprove('write:C:\\ws', { scope: 'once' })
  memory.noteReject('write:C:\\ws')

  assert.deepEqual(memory.snapshot().once, [])
  assert.equal(memory.consumeOnce('write:C:\\ws'), false)
  assert.equal(memory.lookup('write:C:\\ws'), 'rejected')
})

test('lookup: 未知 key 返回 unknown；非法 key 不抛错', () => {
  const memory = new TaskMemory('task-1')
  assert.equal(memory.lookup('write:C:\\other'), 'unknown')
  assert.equal(memory.lookup(''), 'unknown')
  assert.equal(memory.lookup(undefined), 'unknown')
  assert.equal(memory.lookup(42), 'unknown')
  assert.equal(memory.consumeOnce(undefined), false)
})

test('noteApprove / noteReject: 非法 key 抛 TypeError（写入路径不静默吞掉 bug）', () => {
  const memory = new TaskMemory('task-1')
  assert.throws(() => memory.noteApprove(''), TypeError)
  assert.throws(() => memory.noteApprove(undefined), TypeError)
  assert.throws(() => memory.noteReject(null), TypeError)
  assert.deepEqual(memory.snapshot().approvals, [])
})

test('snapshot: 每次返回新对象与新数组，调用方改动不影响内部状态', () => {
  const memory = new TaskMemory('task-1')
  memory.noteApprove('write:C:\\ws')
  const snapshot = memory.snapshot()
  snapshot.approvals.push('exec:rm')
  snapshot.taskId = 'hacked'

  assert.deepEqual(memory.snapshot(), {
    taskId: 'task-1',
    approvals: ['write:C:\\ws'],
    rejections: [],
    once: [],
  })
})

test('constructor: 非字符串 taskId 按空串处理，不抛错', () => {
  assert.equal(new TaskMemory(undefined).snapshot().taskId, '')
  assert.equal(new TaskMemory(123).snapshot().taskId, '')
  assert.equal(new TaskMemory('t-9').snapshot().taskId, 't-9')
  assert.equal(new TaskMemory('t-9').disposed, false)
})

test('dispose(): 之后 lookup 恒 unknown（任务级 / 拒绝 / 一次性批准全部失效）', () => {
  const memory = new TaskMemory('task-1')
  memory.noteApprove('write:C:\\ws')
  memory.noteApprove('exec:git', { scope: 'once' })
  memory.noteReject('exec:rm')

  memory.dispose()

  assert.equal(memory.disposed, true)
  assert.equal(memory.lookup('write:C:\\ws'), 'unknown')
  assert.equal(memory.lookup('exec:git'), 'unknown')
  assert.equal(memory.lookup('exec:rm'), 'unknown')
  assert.equal(memory.consumeOnce('exec:git'), false)
  assert.deepEqual(memory.snapshot(), { taskId: 'task-1', approvals: [], rejections: [], once: [] })
})

test('dispose(): 之后再 noteApprove / noteReject 是 no-op（已销毁的记忆不得复活授权）', () => {
  const memory = new TaskMemory('task-1')
  memory.dispose()
  memory.noteApprove('write:C:\\ws')
  memory.noteReject('exec:rm')

  assert.equal(memory.lookup('write:C:\\ws'), 'unknown')
  assert.equal(memory.lookup('exec:rm'), 'unknown')
  assert.deepEqual(memory.snapshot(), { taskId: 'task-1', approvals: [], rejections: [], once: [] })
})

test('dispose(): 幂等', () => {
  const memory = new TaskMemory('task-1')
  memory.noteApprove('write:C:\\ws')
  memory.dispose()
  memory.dispose()

  assert.equal(memory.lookup('write:C:\\ws'), 'unknown')
})

test('记忆范围限定在单任务内：不同 TaskMemory 互不影响', () => {
  const one = new TaskMemory('task-1')
  const two = new TaskMemory('task-2')
  one.noteApprove('write:C:\\ws')
  one.noteReject('exec:rm')

  assert.equal(two.lookup('write:C:\\ws'), 'unknown')
  assert.equal(two.lookup('exec:rm'), 'unknown')
  assert.deepEqual(two.snapshot(), { taskId: 'task-2', approvals: [], rejections: [], once: [] })
})
