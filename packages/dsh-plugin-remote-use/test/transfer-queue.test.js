import { strict as assert } from 'node:assert'
import test from 'node:test'

import { makeTransferQueue } from '../lib/core/transfer-queue.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('transfers to one peer run one at a time, and in the order they were queued', async () => {
  const queue = makeTransferQueue()
  const log = []
  const job = (name, ms) => async () => {
    log.push(`start:${name}`)
    await new Promise((resolve) => setTimeout(resolve, ms))
    log.push(`end:${name}`)
    return name
  }

  // Started in the same tick, so without a lane all three would interleave.
  const all = Promise.all([
    queue.run('w1', job('a', 20)),
    queue.run('w1', job('b', 5)),
    queue.run('w1', job('c', 1)),
  ])
  await all
  assert.deepEqual(log, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
})

test('two peers do not block each other', async () => {
  const queue = makeTransferQueue()
  const order = []
  await Promise.all([
    queue.run('w1', async () => { await new Promise((r) => setTimeout(r, 25)); order.push('w1') }),
    queue.run('w2', async () => { await new Promise((r) => setTimeout(r, 1)); order.push('w2') }),
  ])
  // w2 finished first: a shared lane would have serialised it behind w1's 25 ms.
  assert.deepEqual(order, ['w2', 'w1'])
})

test('a FAILED transfer does not poison the lane', async () => {
  // The reason the stored chain swallows rejections. Without that, the rejected promise stays on the
  // shared chain and the NEXT transfer inherits a failure that has nothing to do with it.
  const queue = makeTransferQueue()
  await assert.rejects(() => queue.run('w1', async () => { throw new Error('disk full') }), /disk full/u)
  assert.equal(await queue.run('w1', async () => 'ok'), 'ok')
  // And the depth went back to zero rather than sticking at 1.
  assert.equal(queue.depth('w1'), 0)
})

test('depth reports queued and running transfers, so a wait can be explained', async () => {
  const queue = makeTransferQueue()
  let release
  const held = queue.run('w1', () => new Promise((resolve) => { release = resolve }))
  await tick()
  assert.equal(queue.depth('w1'), 1)
  const second = queue.run('w1', async () => 'second')
  assert.equal(queue.depth('w1'), 2, 'the queued one counts too')
  assert.equal(queue.depth('w2'), 0, 'another peer has its own lane')
  release('first')
  assert.equal(await held, 'first')
  assert.equal(await second, 'second')
  await tick()
  assert.equal(queue.depth('w1'), 0)
})

test('the caller still receives the job result and its own error', async () => {
  const queue = makeTransferQueue()
  assert.equal(await queue.run('w1', async () => 42), 42)
  const boom = new Error('no such file')
  await assert.rejects(() => queue.run('w1', async () => { throw boom }), (e) => e === boom)
})
