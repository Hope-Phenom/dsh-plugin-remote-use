// INTERFACES.md 【A】core/toolcall-cache.js —— 单元测试（node --test，无测试框架依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ToolCallCache } from '../lib/core/toolcall-cache.js'

/** 造一条 tool_call 通知载荷 */
function note(cache, id, over = {}) {
  cache.note(id, { title: 'write', rawInput: { file_path: `C:\\ws\\${id}.txt` }, status: 'pending', ...over })
}

test('note + get: 记录 { toolName, rawInput, status }，title 即工具名', () => {
  const cache = new ToolCallCache()
  cache.note('c1', { title: 'write', rawInput: { file_path: 'C:\\ws\\a.txt' }, status: 'pending' })

  assert.deepEqual(cache.get('c1'), {
    toolName: 'write',
    rawInput: { file_path: 'C:\\ws\\a.txt' },
    status: 'pending',
  })
  assert.equal(cache.size, 1)
  assert.equal(cache.misses, 0)
  assert.equal(cache.evictions, 0)
})

test('note: 未给 status 时用 pending 占位', () => {
  const cache = new ToolCallCache()
  cache.note('c1', { title: 'read', rawInput: {} })
  assert.equal(cache.get('c1').status, 'pending')
})

test('update: 只更新显式给出的字段（status），保留 title / rawInput', () => {
  const cache = new ToolCallCache()
  note(cache, 'c1')
  const before = cache.get('c1')

  cache.update('c1', { status: 'completed' })

  assert.deepEqual(cache.get('c1'), { ...before, status: 'completed' })
  assert.equal(cache.size, 1)
})

test('update: 显式给出 title / rawInput 时才覆盖', () => {
  const cache = new ToolCallCache()
  note(cache, 'c1')

  cache.update('c1', { status: 'failed', title: 'pwsh', rawInput: { command: 'ls' } })

  assert.deepEqual(cache.get('c1'), { toolName: 'pwsh', rawInput: { command: 'ls' }, status: 'failed' })
})

test('note: 兼容 UpdateEvent.tool 的 toolName 字段（bridge 事件用的是 toolName 而非 title）', () => {
  const cache = new ToolCallCache()
  // lib/index.js 把 bridge 的 evt.tool 原样喂给缓存，其形状是 { toolCallId, toolName, rawInput, status }
  cache.note('c1', { toolCallId: 'c1', toolName: 'write', rawInput: { file_path: 'C:\\ws\\a.txt' }, status: 'pending' })
  cache.update('c1', { toolCallId: 'c1', toolName: 'write', status: 'completed' })

  assert.equal(cache.get('c1').toolName, 'write')
  assert.equal(cache.get('c1').status, 'completed')
})

test('update: 未知 toolCallId 会新建记录，且不计入 misses（misses 只统计审批查询 get）', () => {
  const cache = new ToolCallCache()
  cache.update('ghost', { status: 'completed' })

  assert.deepEqual(cache.get('ghost'), { toolName: undefined, rawInput: undefined, status: 'completed' })
  assert.equal(cache.misses, 0)
})

test('note: 重复 note 同一 id 不会用空载荷抹掉已缓存的 title / rawInput', () => {
  const cache = new ToolCallCache()
  note(cache, 'c1')
  cache.note('c1', {})

  assert.equal(cache.get('c1').toolName, 'write')
  assert.deepEqual(cache.get('c1').rawInput, { file_path: 'C:\\ws\\c1.txt' })
})

test('get: 未命中返回 undefined 且 misses +1（档位检查拿不到依据的审计告警位）', () => {
  const cache = new ToolCallCache()
  assert.equal(cache.get('nope'), undefined)
  assert.equal(cache.get('nope'), undefined)
  assert.equal(cache.misses, 2)
  assert.equal(cache.size, 0)
})

test('get: 非字符串 / 空字符串 toolCallId 记为 miss 并返回 undefined', () => {
  const cache = new ToolCallCache()
  assert.equal(cache.get(undefined), undefined)
  assert.equal(cache.get(null), undefined)
  assert.equal(cache.get(42), undefined)
  assert.equal(cache.get(''), undefined)
  assert.equal(cache.misses, 4)
})

test('note / update: 非法 toolCallId 抛 TypeError（调用方 bug 尽早暴露）', () => {
  const cache = new ToolCallCache()
  assert.throws(() => cache.note(undefined, { title: 'write' }), TypeError)
  assert.throws(() => cache.note('', { title: 'write' }), TypeError)
  assert.throws(() => cache.update(7, { status: 'failed' }), TypeError)
  assert.equal(cache.size, 0)
})

test('容量淘汰: 超过 maxEntries 时淘汰最久未使用的记录（LRU）', () => {
  const cache = new ToolCallCache({ maxEntries: 2 })
  note(cache, 'a')
  note(cache, 'b')
  note(cache, 'c')

  assert.equal(cache.size, 2)
  assert.equal(cache.evictions, 1)
  assert.equal(cache.get('a'), undefined) // 最久未使用 → 被淘汰
  assert.ok(cache.get('b'))
  assert.ok(cache.get('c'))
})

test('容量淘汰: get 命中会刷新最近使用顺序', () => {
  const cache = new ToolCallCache({ maxEntries: 2 })
  note(cache, 'a')
  note(cache, 'b')
  cache.get('a') // a 变成最近使用
  note(cache, 'c') // 应淘汰 b 而不是 a

  assert.ok(cache.get('a'))
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.evictions, 1)
})

test('容量淘汰: update 命中同样刷新顺序', () => {
  const cache = new ToolCallCache({ maxEntries: 2 })
  note(cache, 'a')
  note(cache, 'b')
  cache.update('a', { status: 'in_progress' })
  note(cache, 'c')

  assert.ok(cache.get('a'))
  assert.equal(cache.get('b'), undefined)
})

test('容量淘汰: 覆盖已存在的 id 不触发淘汰', () => {
  const cache = new ToolCallCache({ maxEntries: 1 })
  note(cache, 'a')
  note(cache, 'a')

  assert.equal(cache.size, 1)
  assert.equal(cache.evictions, 0)
})

test('容量: 默认 512，非法 maxEntries 回落到默认值', () => {
  assert.equal(new ToolCallCache().maxEntries, 512)
  assert.equal(new ToolCallCache({}).maxEntries, 512)
  assert.equal(new ToolCallCache({ maxEntries: 0 }).maxEntries, 512)
  assert.equal(new ToolCallCache({ maxEntries: -3 }).maxEntries, 512)
  assert.equal(new ToolCallCache({ maxEntries: 4 }).maxEntries, 4)
})

test('clear(): 清空记录，但保留累计的 misses / evictions（审计计数器）', () => {
  const cache = new ToolCallCache({ maxEntries: 1 })
  note(cache, 'a')
  assert.equal(cache.get('nope'), undefined) // misses 1
  note(cache, 'b') // 淘汰 a → evictions 1

  cache.clear()

  assert.equal(cache.size, 0)
  assert.equal(cache.get('b'), undefined) // misses 2
  assert.equal(cache.misses, 2)
  assert.equal(cache.evictions, 1)
})

test('get 返回副本：调用方改动不会污染缓存内部状态', () => {
  const cache = new ToolCallCache()
  note(cache, 'c1')
  const record = cache.get('c1')
  record.status = 'tampered'
  record.rawInput = null

  assert.equal(cache.get('c1').status, 'pending')
  assert.deepEqual(cache.get('c1').rawInput, { file_path: 'C:\\ws\\c1.txt' })
})
