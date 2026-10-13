/**
 * Tests for the approval queue.
 *
 * This is the piece that turns "needs a human" into "waits for a human". Everything about it
 * is a security property: it may never allow without an explicit decision, it may never lose
 * a request, and it may never leave one pending past its budget.
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { ApprovalQueue, QUEUE_LEAD_MS } from '../lib/core/approval-queue.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeQueue(opts = {}) {
  const settled = []
  const queue = new ApprovalQueue({ timeoutMs: 50, onSettle: (o) => settled.push(o), ...opts })
  return { queue, settled }
}

const ASK = {
  peerId: 'worker-pc',
  taskId: 'rtask_1',
  toolCallId: 'call_7',
  toolName: 'write',
  requiredTier: 'danger-full-access',
  reason: 'tier-check: danger-full-access needs a human',
  source: 'tier-check',
  rawInput: { file_path: 'C:\\outside\\x.txt' },
}

test('a request stays pending until a human decides, then resolves with the option', async () => {
  const { queue, settled } = makeQueue()
  const answer = queue.request(ASK)
  const [entry] = queue.list()
  assert.ok(entry !== undefined, 'the request must be visible to the page')
  assert.equal(entry.toolName, 'write')
  assert.equal(entry.requiredTier, 'danger-full-access')
  assert.equal(queue.pendingCount, 1)

  const result = queue.decide(entry.id, 'allow')
  assert.equal(result.ok, true)
  assert.equal(result.optionId, 'allow-once')
  assert.equal(await answer, 'allow-once')
  assert.equal(queue.pendingCount, 0)
  assert.equal(settled.length, 1)
  assert.equal(settled[0].by, 'human')
})

test('an explicit denial resolves as reject-once and is recorded as a human decision', async () => {
  const { queue, settled } = makeQueue()
  const answer = queue.request(ASK)
  queue.decide(queue.list()[0].id, 'deny')
  assert.equal(await answer, 'reject-once')
  assert.equal(settled[0].optionId, 'reject-once')
  assert.equal(settled[0].by, 'human')
})

test('NOBODY answering means refusal -- the queue never allows on its own', async () => {
  const { queue, settled } = makeQueue({ timeoutMs: 30 })
  const answer = queue.request(ASK)
  assert.equal(await answer, 'reject-once')
  assert.equal(queue.pendingCount, 0)
  assert.equal(settled[0].by, 'timeout')
  assert.equal(settled[0].optionId, 'reject-once')
})

test('dispose refuses everything still waiting, so a plugin unload cannot strand a request', async () => {
  const { queue, settled } = makeQueue()
  const a = queue.request(ASK)
  const b = queue.request({ ...ASK, toolCallId: 'call_8' })
  queue.dispose()
  assert.equal(await a, 'reject-once')
  assert.equal(await b, 'reject-once')
  assert.equal(queue.pendingCount, 0)
  assert.deepEqual(settled.map((s) => s.by), ['disposed', 'disposed'])
})

test('a disposed queue refuses new requests instead of accepting one nobody can answer', async () => {
  const { queue } = makeQueue()
  queue.dispose()
  assert.equal(await queue.request(ASK), 'reject-once')
  assert.equal(queue.pendingCount, 0)
})

test('deciding an unknown or already-settled id reports failure rather than pretending', async () => {
  const { queue } = makeQueue()
  assert.equal(queue.decide('nope', 'allow').ok, false)
  assert.match(queue.decide('nope', 'allow').error, /no pending approval/)

  const answer = queue.request(ASK)
  const id = queue.list()[0].id
  assert.equal(queue.decide(id, 'allow').ok, true)
  await answer
  // A second click on a stale row must not "succeed".
  const again = queue.decide(id, 'allow')
  assert.equal(again.ok, false)
  assert.match(again.error, /no pending approval/)
})

test('an invalid decision is rejected rather than coerced', () => {
  const { queue } = makeQueue()
  queue.request(ASK)
  const id = queue.list()[0].id
  for (const bad of ['yes', 'ALLOW', '', undefined, null, true, 1]) {
    const result = queue.decide(id, bad)
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must not be accepted`)
  }
  // ...and the entry is still there, untouched.
  assert.equal(queue.pendingCount, 1)
})

test('the page view carries no resolver and a bounded payload', () => {
  const { queue } = makeQueue()
  queue.request({ ...ASK, rawInput: { blob: 'x'.repeat(5000) } })
  const [entry] = queue.list()
  assert.equal('resolve' in entry, false, 'a resolver must never leave the queue')
  assert.equal('timer' in entry, false)
  assert.ok(entry.rawInput.length <= 401, `rawInput must be truncated, got ${entry.rawInput.length}`)
  assert.ok(entry.rawInput.endsWith('…'))
  // JSON-visible too, since the route serialises this.
  assert.equal(JSON.stringify(entry).includes('x'.repeat(500)), false)
})

test('list() is ordered oldest first so the page shows the longest wait on top', async () => {
  const { queue } = makeQueue({ timeoutMs: 5000 })
  queue.request({ ...ASK, toolCallId: 'first' })
  await sleep(5)
  queue.request({ ...ASK, toolCallId: 'second' })
  assert.deepEqual(queue.list().map((e) => e.toolCallId), ['first', 'second'])
  assert.ok(queue.list()[1].ageMs <= queue.list()[0].ageMs)
  queue.dispose()
})

test('the settle hook runs once per entry and cannot break the approval it observes', async () => {
  let calls = 0
  const { queue } = makeQueue({
    onSettle: () => { calls += 1; throw new Error('the audit log is on fire') },
  })
  const answer = queue.request(ASK)
  queue.decide(queue.list()[0].id, 'allow')
  // A logging failure must not change the decision, or an audit bug becomes an outage.
  assert.equal(await answer, 'allow-once')
  assert.equal(calls, 1)
})

test('recent() reports settled outcomes newest first, with how long each waited', async () => {
  const { queue } = makeQueue({ timeoutMs: 5000 })
  const first = queue.request({ ...ASK, toolCallId: 'a' })
  queue.decide(queue.list()[0].id, 'deny')
  await first
  const second = queue.request({ ...ASK, toolCallId: 'b' })
  queue.decide(queue.list()[0].id, 'allow')
  await second

  const recent = queue.recent()
  assert.deepEqual(recent.map((r) => r.toolCallId), ['b', 'a'])
  assert.deepEqual(recent.map((r) => r.optionId), ['allow-once', 'reject-once'])
  assert.equal(typeof recent[0].waitedMs, 'number')
})

test('the budget is shorter than the bridge timeout, or the queue would keep a ghost entry', () => {
  // The bridge races the callback against its own approvalTimeoutMs. If the queue's budget
  // were the longer of the two, the bridge would settle first and the entry would linger in
  // the page as something a human could click but nothing would act on.
  assert.ok(QUEUE_LEAD_MS > 0)
})

test('many concurrent requests stay independent', async () => {
  const { queue } = makeQueue({ timeoutMs: 5000 })
  const answers = [1, 2, 3].map((n) => queue.request({ ...ASK, toolCallId: `c${n}` }))
  assert.equal(queue.pendingCount, 3)
  const ids = queue.list().map((e) => e.id)
  queue.decide(ids[1], 'allow')
  queue.decide(ids[0], 'deny')
  queue.decide(ids[2], 'allow')
  assert.deepEqual(await Promise.all(answers), ['reject-once', 'allow-once', 'allow-once'])
})
