/**
 * Tests for the arming state machine.
 *
 * Everything here is a security property from §16.4, so each decision gets its own test and its
 * own refusal case: the gate must refuse rather than warn, the latch must not slip, the token
 * must be shown once, and the local stop must work when the far end is the problem.
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { DEFAULT_ARM_PORT, WorkerArming, generateToken, maskToken, tokenMatches } from '../lib/core/worker-arming.js'

const INTERFACES = {
  'vEthernet (Default Switch)': [{ address: '172.20.0.1', family: 'IPv4', internal: false }],
  '以太网': [{ address: '192.168.1.100', family: 'IPv4', internal: false }],
}

/** An arming instance with everything injected, plus the calls it made. */
function makeArming(overrides = {}) {
  const calls = { start: [], stop: 0, persisted: [] }
  const arming = new WorkerArming({
    interfaces: () => INTERFACES,
    probe: () => ({ ok: true, reason: '' }),
    start: (bind, port, token) => calls.start.push({ bind, port, token }),
    stop: () => { calls.stop += 1 },
    persist: (state) => calls.persisted.push({ ...state }),
    mint: () => 'minted-token-value',
    now: () => 1_000_000,
    ...overrides,
  })
  return { arming, calls }
}

test('a healthy machine arms on a named LAN address and latches', () => {
  const { arming, calls } = makeArming()
  assert.equal(arming.status().armed, false, 'the default is off')

  const result = arming.arm({ bindAddress: '192.168.1.100' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.token, 'minted-token-value', 'the plaintext comes back exactly once')
  assert.equal(arming.status().armed, true)
  assert.deepEqual(calls.start, [{ bind: '192.168.1.100', port: DEFAULT_ARM_PORT, token: 'minted-token-value' }])
})

test('BINDING EVERY INTERFACE IS REFUSED, not defaulted against', () => {
  // Decision 2. A rule that only lives in a dropdown is a rule the next caller ignores.
  for (const wildcard of ['0.0.0.0', '::', '*']) {
    const { arming, calls } = makeArming()
    const result = arming.arm({ bindAddress: wildcard })
    assert.equal(result.ok, false, `${wildcard} must be refused`)
    assert.match(result.error, /every interface/)
    assert.equal(arming.status().armed, false)
    assert.deepEqual(calls.start, [], 'nothing may be started')
  }
})

test('an address that is not on this machine is refused', () => {
  const { arming } = makeArming()
  const result = arming.arm({ bindAddress: '192.168.1.101' })
  assert.equal(result.ok, false)
  assert.match(result.error, /not an address of this machine/)
})

test('A BROKEN SANDBOX REFUSES ARMING, and does not merely warn', () => {
  // Decision 4, the one that makes this feature safe to have at all.
  const { arming, calls } = makeArming({ probe: () => ({ ok: false, reason: 'the mediator is not materialized' }) })
  const result = arming.arm({ bindAddress: '192.168.1.100' })
  assert.equal(result.ok, false)
  assert.match(result.error, /sandbox does not contain/)
  assert.match(result.error, /not materialized/)
  assert.equal(arming.status().armed, false)
  assert.deepEqual(calls.start, [])
})

test('the sandbox gate is re-run on every arm, because the answer depends on the launch context', () => {
  let probes = 0
  const { arming } = makeArming({ probe: () => { probes += 1; return { ok: true, reason: '' } } })
  arming.arm({ bindAddress: '192.168.1.100' })
  arming.disarm()
  arming.arm({ bindAddress: '192.168.1.100' })
  assert.equal(probes, 2, 'a cached verdict would be an answer about a different context')
})

test('an invalid port is refused before anything starts', () => {
  for (const port of [0, -1, 65_536, 1.5, Number.NaN]) {
    const { arming, calls } = makeArming()
    const result = arming.arm({ bindAddress: '192.168.1.100', port })
    assert.equal(result.ok, false, `port ${port} must be refused`)
    assert.match(result.error, /port must be/)
    assert.deepEqual(calls.start, [])
  }
})

test('the status NEVER carries the token, only a mask', () => {
  const { arming } = makeArming({ mint: () => 'abcdefghijklmnopqrstuvwxyz0123456789' })
  arming.arm({ bindAddress: '192.168.1.100' })
  const status = arming.status()
  assert.equal(status.tokenSet, true)
  assert.equal(JSON.stringify(status).includes('abcdefghijklmnopqrstuvwxyz0123456789'), false)
  assert.equal(status.tokenHint.endsWith('6789'), true, 'the hint shows the tail so it can be recognised')
  assert.equal(status.tokenHint.includes('abcdef'), false)
})

test('the latch holds until an explicit disarm', () => {
  // Decision 1: there is no timer that quietly stops accepting connections.
  const { arming } = makeArming()
  arming.arm({ bindAddress: '192.168.1.100' })
  assert.equal(arming.status().armed, true)
  assert.equal(arming.status().armed, true, 'reading the state twice does not disarm it')
  assert.equal(arming.disarm().wasArmed, true)
  assert.equal(arming.status().armed, false)
})

test('arming again while armed is refused, and does NOT rotate the credential', () => {
  // A second arm would be the quiet way to invalidate a pairing the operator already sent out.
  const { arming, calls } = makeArming()
  arming.arm({ bindAddress: '192.168.1.100' })
  const again = arming.arm({ bindAddress: '192.168.1.100' })
  assert.equal(again.ok, false)
  assert.match(again.error, /already armed/)
  assert.equal(calls.start.length, 1)
})

test('the local stop happens even when the listener throws', () => {
  // Decision 5: the switch must work when the far end -- or the listener itself -- is the
  // problem, and the object must not keep claiming to be armed.
  const { arming } = makeArming({ stop: () => { throw new Error('the socket is wedged') } })
  arming.arm({ bindAddress: '192.168.1.100' })
  const result = arming.disarm()
  assert.equal(arming.status().armed, false, 'the state must not say armed')
  assert.match(arming.status().lastError, /did not stop cleanly/)
  assert.equal(result.ok, false, 'and the operator is told the socket may still be open')
})

test('a listener that fails to start leaves the machine disarmed', () => {
  const { arming } = makeArming({ start: () => { throw new Error('EADDRINUSE') } })
  const result = arming.arm({ bindAddress: '192.168.1.100' })
  assert.equal(result.ok, false)
  assert.match(result.error, /EADDRINUSE/)
  assert.equal(arming.status().armed, false, 'never claim to accept remote execution when nothing listens')
})

test('the armed state is persisted, and the token survives a restart', () => {
  // Decision 3: a restart must not invalidate a pairing that has already been distributed.
  const { arming, calls } = makeArming({ mint: () => 'persisted-token' })
  arming.arm({ bindAddress: '192.168.1.100' })
  const saved = calls.persisted.at(-1)
  assert.equal(saved.armed, true)
  assert.equal(saved.token, 'persisted-token')

  const restarted = makeArming({ stored: saved })
  assert.equal(restarted.arming.status().armed, true, 'it comes back armed')
  assert.equal(restarted.arming.status().bindAddress, '192.168.1.100')
  assert.deepEqual(restarted.calls.start, [{ bind: '192.168.1.100', port: DEFAULT_ARM_PORT, token: 'persisted-token' }])
})

test('a restart whose listener cannot rebind does NOT claim to be armed', () => {
  const stored = { armed: true, bindAddress: '192.168.1.100', port: 7331, token: 't', armedAt: 1 }
  const { arming } = makeArming({ stored, start: () => { throw new Error('EADDRINUSE') } })
  assert.equal(arming.status().armed, false)
  assert.match(arming.status().lastError, /could not restore the listener/)
})

test('A RESTORE RE-RUNS THE SANDBOX GATE, and refuses when it no longer passes', () => {
  // The sandbox is the mediator wired into the acp profile, and the mediator is materialized out
  // of the DSH bundle -- so a DSH upgrade invalidates it, and so does deleting the directory.
  // Skipping the gate here would let a machine armed last week go on accepting remote execution
  // after its confinement broke, which is exactly what decision 4 exists to prevent.
  const stored = { armed: true, bindAddress: '192.168.1.100', port: 7331, token: 'kept-token', armedAt: 1 }
  let probes = 0
  const { arming, calls } = makeArming({
    stored,
    probe: () => { probes += 1; return { ok: false, reason: 'the mediator drives the previous runner' } },
  })
  assert.equal(probes, 1, 'the gate must actually run')
  assert.equal(arming.status().armed, false, 'it must NOT come back armed')
  assert.equal(calls.start.length, 0, 'and nothing may be listening')
  assert.match(arming.status().lastError, /sandbox no longer contains/)
  // The credential is KEPT: the refusal is about confinement, not about revoking the pairing.
  // Throwing it away would make the operator re-pair after fixing the mediator.
  assert.equal(arming.status().tokenSet, true)
})

test('a DISARMED stored state costs no probe at boot', () => {
  // The gate is only paid for by a machine that believes it is accepting remote execution.
  let probes = 0
  const { arming } = makeArming({ stored: { armed: false, bindAddress: '', port: 7331, token: 't', armedAt: 0 }, probe: () => { probes += 1; return { ok: true, reason: '' } } })
  assert.equal(probes, 0, 'a disarmed machine must not pay for a probe on every DSH start')
  assert.equal(arming.status().armed, false)
})

test('disarm keeps the credential for a restart unless asked to forget it', () => {
  const { arming, calls } = makeArming()
  arming.arm({ bindAddress: '192.168.1.100' })
  arming.disarm()
  assert.equal(arming.status().tokenSet, true, 'the token is kept so a restart restores the pairing')
  assert.equal(calls.persisted.at(-1).armed, false)

  arming.disarm({ forget: true })
  assert.equal(arming.status().tokenSet, false)
  assert.equal(calls.persisted.at(-1).token, '')
})

test('the status lists every interface, including the ones that must not be chosen', () => {
  const { arming } = makeArming()
  const status = arming.status()
  assert.equal(status.interfaces.some((i) => i.address === '192.168.1.100'), true)
  // The virtual switch is listed so the page can EXPLAIN why it is not offered, rather than
  // silently omitting it and leaving the operator to wonder.
  assert.equal(status.interfaces.some((i) => i.address === '172.20.0.1'), true)
  assert.equal(status.interfaces[0].address, '192.168.1.100', 'best first')
})

test('accepts() only answers while armed, and compares in constant time', () => {
  const { arming } = makeArming({ mint: () => 'the-token' })
  assert.equal(arming.accepts('the-token'), false, 'nothing is accepted while disarmed')
  arming.arm({ bindAddress: '192.168.1.100' })
  assert.equal(arming.accepts('the-token'), true)
  assert.equal(arming.accepts('the-toke'), false)
  assert.equal(arming.accepts('the-tokenx'), false)
  assert.equal(arming.accepts(''), false)
  assert.equal(arming.accepts(undefined), false)
  // A prefix of a different length must not trip timingSafeEqual's length check.
  assert.equal(arming.accepts('x'.repeat(10_000)), false)
})

test('tokenMatches rejects empties and non-strings without throwing', () => {
  assert.equal(tokenMatches('a', 'a'), true)
  assert.equal(tokenMatches('a', 'b'), false)
  assert.equal(tokenMatches('', ''), false)
  assert.equal(tokenMatches('a', ''), false)
  assert.equal(tokenMatches(undefined, 'a'), false)
  assert.equal(tokenMatches('a', null), false)
  // Differing lengths must not throw, which is why both sides are hashed first.
  assert.equal(tokenMatches('short', 'a-much-longer-value'), false)
})

test('generateToken is unpredictable, long, and unique', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i += 1) {
    const token = generateToken()
    assert.match(token, /^[0-9a-f]{64}$/u, 'hex so it survives YAML and JSON unchanged')
    seen.add(token)
  }
  assert.equal(seen.size, 200)
})

test('maskToken reveals a short tail and nothing else', () => {
  assert.equal(maskToken(''), '')
  assert.equal(maskToken(undefined), '')
  const mask = maskToken('0123456789abcdef')
  assert.equal(mask.endsWith('cdef'), true)
  assert.equal(mask.includes('0123456789ab'), false)
  // A very short token must not be revealed in full by the mask.
  assert.equal(maskToken('ab').length > 2, true)
})
