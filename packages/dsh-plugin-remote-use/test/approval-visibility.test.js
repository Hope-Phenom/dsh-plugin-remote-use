/**
 * Tests for approval VISIBILITY: the desktop notification, the model-facing notice, and the
 * origin label on a decision.
 *
 * WHY THIS FILE EXISTS: the queue, the timeout and the page all worked, and the operator still
 * never saw a single prompt -- six requests expired unanswered because the only sign of them was a
 * settings page that never refreshed itself. So "can a person find out?" is now a contract with
 * its own tests, not an emergent property of the pieces.
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { approvalNotice, announceApproval, requestProvenance } from '../lib/index.js'
import { notifyDesktop, resolveNotifyScript, NOTIFY_PACKAGE } from '../lib/core/desktop-notify.js'

// ---------------------------------------------------------------- the notifier path

test('the sibling notifier is found beside this plugin, and its absence is a silent no-op', () => {
  const manifest = 'C:\\profile\\node_modules\\@hope_phenom\\dsh-plugin-notify\\package.json'
  const found = resolveNotifyScript({
    resolve: (id) => {
      assert.equal(id, `${NOTIFY_PACKAGE}/package.json`, 'the manifest is what resolves')
      return manifest
    },
    exists: () => true,
  })
  assert.equal(found, 'C:\\profile\\node_modules\\@hope_phenom\\dsh-plugin-notify\\scripts\\notify.ps1')

  // Not installed: resolution throws, and that must not be an error anybody sees.
  assert.equal(resolveNotifyScript({ resolve: () => { throw new Error('MODULE_NOT_FOUND') } }), '')
  // Installed but the bundled script is missing: same answer, no exception.
  assert.equal(resolveNotifyScript({ resolve: () => manifest, exists: () => false }), '')
})

test('notifyDesktop hands the notification to the bundled script and never waits for it', () => {
  const calls = []
  const child = new EventEmitter()
  child.unref = () => { calls.push('unref') }
  child.kill = () => {}
  const sent = notifyDesktop({
    title: 'T',
    message: 'M',
    script: 'C:\\x\\notify.ps1',
    log: {},
    spawnFn: (exe, argv, opts) => {
      calls.push({ exe, argv, opts })
      return child
    },
  })
  assert.equal(sent, true)
  const call = calls.find((c) => typeof c === 'object')
  assert.equal(call.exe, 'pwsh')
  assert.deepEqual(call.argv.slice(0, 5), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\x\\notify.ps1'])
  assert.ok(call.argv.includes('-Title') && call.argv.includes('T'))
  assert.ok(call.argv.includes('-Message') && call.argv.includes('M'))
  assert.equal(call.opts.stdio, 'ignore', 'the child must not be able to write to our streams')
  assert.ok(calls.includes('unref'), 'a notification must never hold the process open')
})

test('a missing interpreter falls through to the next one', () => {
  const tried = []
  const child = new EventEmitter()
  child.unref = () => {}
  child.kill = () => {}
  const sent = notifyDesktop({
    title: 'T',
    message: 'M',
    script: 's.ps1',
    log: {},
    spawnFn: (exe) => {
      tried.push(exe)
      if (exe === 'pwsh') throw new Error('ENOENT')
      return child
    },
  })
  assert.equal(sent, true)
  assert.deepEqual(tried, ['pwsh', 'powershell'])
})

test('an interpreter that dies asynchronously also falls through', () => {
  // ENOENT arrives on the `error` EVENT, not from spawn(). A `for` loop cannot see it, which is
  // exactly the shape of bug this test exists to catch.
  const tried = []
  const children = []
  const sent = notifyDesktop({
    title: 'T',
    message: 'M',
    script: 's.ps1',
    log: {},
    spawnFn: (exe) => {
      tried.push(exe)
      const child = new EventEmitter()
      child.unref = () => {}
      child.kill = () => {}
      children.push(child)
      return child
    },
  })
  assert.equal(sent, true)
  children[0].emit('error', new Error('spawn pwsh ENOENT'))
  assert.deepEqual(tried, ['pwsh', 'powershell'], 'the failure must trigger the retry')
})

test('notifyDesktop returns false rather than throwing when there is nowhere to send it', () => {
  assert.equal(notifyDesktop({ title: 'T', message: 'M', resolve: () => { throw new Error('nope') } }), false)
  assert.equal(notifyDesktop({ title: 'T', message: 'M', script: 's.ps1', spawnFn: () => { throw new Error('boom') }, log: {} }), false)
})

// ---------------------------------------------------------------- the model-facing notice

test('the model is told which request is waiting, and how long is left', () => {
  const notice = approvalNotice([
    { toolName: 'pwsh', requiredTier: 'danger-full-access', taskId: 'rtask_a', peerId: '192.168.1.101', ageMs: 20_000 },
  ], 180_000)
  assert.match(notice, /APPROVALS WAITING ON A HUMAN \(1\)/)
  assert.match(notice, /pwsh needs danger-full-access for rtask_a/)
  assert.match(notice, /192\.168\.1\.101/)
  assert.match(notice, /~160s/, 'the remaining budget is what makes the notice urgent')
  assert.match(notice, /Settings -> Remote use/, 'the notice has to say what to DO')
})

test('the notice is empty when nothing waits, and clamps a stale entry at zero', () => {
  assert.equal(approvalNotice([], 180_000), '')
  assert.equal(approvalNotice(undefined, 180_000), '')
  const stale = approvalNotice([{ toolName: 'write', requiredTier: 'x', ageMs: 999_999 }], 180_000)
  assert.match(stale, /~0s/, 'a request past its budget must not report negative time')
  const unknownBudget = approvalNotice([{ toolName: 'write', requiredTier: 'x', ageMs: 0 }], undefined)
  assert.match(unknownBudget, /~0s/)
})

test('the notice counts every waiting request, not just the first', () => {
  const notice = approvalNotice([
    { toolName: 'write', requiredTier: 'danger-full-access', ageMs: 0 },
    { toolName: 'pwsh', requiredTier: 'danger-full-access', ageMs: 0 },
  ], 180_000)
  assert.match(notice, /\(2\)/)
  assert.match(notice, /- write needs/)
  assert.match(notice, /- pwsh needs/)
})

// ---------------------------------------------------------------- announcing it to the operator

function queueStub(rows, timeoutMs = 180_000) {
  return { list: () => rows, timeoutMs }
}

test('an approval is announced once, with what a person needs to decide', () => {
  const seen = []
  const ok = announceApproval({
    queue: queueStub([{ toolName: 'pwsh', requiredTier: 'danger-full-access', peerId: 'w1', taskId: 't1', ageMs: 5_000 }]),
    log: {},
    notify: (opts) => { seen.push(opts); return true },
  })
  assert.equal(ok, true)
  assert.equal(seen.length, 1)
  assert.match(seen[0].message, /pwsh/)
  assert.match(seen[0].message, /danger-full-access/)
  assert.match(seen[0].message, /175 秒|175/, 'it says how long the person has')
  assert.match(seen[0].title, /批准/)
})

test('announcing never propagates a failure: it runs on the approval path', () => {
  const logged = []
  // The plugin's logger shape: an object. A partial or missing one must not become the failure.
  const log = { info: () => {}, warn: (message) => logged.push(`warn:${message}`) }
  // A notifier that throws...
  assert.equal(announceApproval({ queue: queueStub([{ toolName: 'write', requiredTier: 'x' }]), log, notify: () => { throw new Error('boom') } }), false)
  assert.ok(logged.some((line) => line.startsWith('warn:')), 'the failure is reported, not swallowed silently')
  // ...one that declines, a queue that throws, a logger that is not an object, and an empty queue.
  assert.equal(announceApproval({ queue: queueStub([{ toolName: 'write', requiredTier: 'x' }]), log, notify: () => false }), false)
  assert.equal(announceApproval({ queue: { list: () => { throw new Error('nope') }, timeoutMs: 1 }, log, notify: () => true }), false)
  assert.equal(announceApproval({ queue: queueStub([{ toolName: 'write', requiredTier: 'x' }]), log: undefined, notify: () => { throw new Error('boom') } }), false)
  assert.equal(announceApproval({ queue: queueStub([]), log, notify: () => true }), false)
})

// ---------------------------------------------------------------- who decided

test('a browser request is a page; anything else is an API call', () => {
  assert.equal(requestProvenance({ headers: { origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' } }), 'page')
  assert.equal(requestProvenance({ headers: { host: '127.0.0.1:19387' } }), 'api', 'no Origin: a script')
  assert.equal(requestProvenance({ headers: { origin: 'null' } }), 'api', 'an opaque origin is not a page')
  assert.equal(requestProvenance({ headers: { origin: '   ' } }), 'api')
  assert.equal(requestProvenance(undefined), 'api')
  assert.equal(requestProvenance({}), 'api')
})
