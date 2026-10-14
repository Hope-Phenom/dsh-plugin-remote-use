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
import { decodePairing } from '../slave/pairing.mjs'

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

test('RE-ARMING ROTATES THE CREDENTIAL, so the old pairing stops working', () => {
  // Decision 3 is "generated WHEN ENABLED". A credential that survived an explicit stop is one
  // the operator has no reason to believe is still valid, and the previous pairing would still
  // open this machine.
  //
  // This is the test that was missing: the code read `this.token === '' ? mint() : this.token`,
  // so a disarm-then-arm reused the old credential while the comment above it promised the
  // opposite. Nothing failed, because nothing asserted it.
  let n = 0
  const { arming } = makeArming({ mint: () => `token-${++n}` })
  const first = arming.arm({ bindAddress: '192.168.1.100' })
  assert.equal(first.token, 'token-1')
  assert.equal(arming.accepts('token-1'), true)

  arming.disarm()
  const second = arming.arm({ bindAddress: '192.168.1.100' })
  assert.equal(second.token, 'token-2', 're-arming must mint a new credential')
  assert.equal(arming.accepts('token-2'), true)
  assert.equal(arming.accepts('token-1'), false, 'the old pairing must no longer open this machine')
  // ...and the pairing string it produced carries the new one.
  const fresh = arming.pairingString()
  assert.equal(typeof fresh, 'string')
  assert.equal(fresh.includes('token-1'), false)
})

test('A RESTART does not rotate: the persisted credential comes back', () => {
  // The counterpart to the test above, and the reason the two cases had to be told apart. A
  // restart is not the operator saying "stop", and regenerating here would break every pairing
  // that had already been distributed.
  const { arming, calls } = makeArming({ mint: () => 'minted-on-arm' })
  arming.arm({ bindAddress: '192.168.1.100' })
  const saved = calls.persisted.at(-1)

  let minted = 0
  const restarted = makeArming({ stored: saved, mint: () => { minted += 1; return 'should-not-be-used' } })
  assert.equal(restarted.arming.status().armed, true, 'it comes back armed')
  assert.equal(restarted.calls.start[0].token, 'minted-on-arm', 'the SAME credential, not a fresh one')
  assert.equal(minted, 0, 'restoring must not mint anything')
})

test('disarm({ forget }) still has a distinct meaning: the secret leaves storage', () => {
  // Rotation makes `forget` unnecessary for invalidating a pairing, but it still matters for an
  // operator who wants the credential off disk -- after a restart there would be nothing to
  // restore.
  const { arming, calls } = makeArming()
  arming.arm({ bindAddress: '192.168.1.100' })
  arming.disarm()
  assert.equal(calls.persisted.at(-1).token !== '', true, 'a plain stop keeps it for the restart case')
  arming.disarm({ forget: true })
  assert.equal(calls.persisted.at(-1).token, '', 'forget erases it')
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

// ---------------------------------------------------------------------------
// F16: the task directory is the WORKER'S to state, because only it can know one
//
// The master cannot guess an absolute path on another machine. Pairing without one used to
// produce a worker that could not accept a task at all, and the master only found out on its
// first delegation. The directory therefore travels inside the pairing string.
// ---------------------------------------------------------------------------

test('the pairing string carries the task directory, so the master need not guess it', () => {
  const { arming } = makeArming()
  const result = arming.arm({ bindAddress: '192.168.1.100', taskCwd: 'C:\\dsh-remote\\work' })
  assert.equal(result.ok, true, result.error)
  const decoded = decodePairing(result.pairing)
  assert.equal(decoded.ok, true, decoded.error)
  assert.equal(decoded.worker.cwd, 'C:\\dsh-remote\\work')
  assert.equal(decoded.worker.url, `ws://192.168.1.100:${DEFAULT_ARM_PORT}`)
  assert.equal(arming.status().taskCwd, 'C:\\dsh-remote\\work')
})

test('a RELATIVE task directory is refused at arming, not advertised as if it worked', () => {
  const { arming, calls } = makeArming()
  const result = arming.arm({ bindAddress: '192.168.1.100', taskCwd: 'work\\sub' })
  assert.equal(result.ok, false)
  assert.match(result.error, /absolute path/)
  assert.equal(arming.status().armed, false, 'nothing may be opened on a bad configuration')
  assert.deepEqual(calls.start, [])
})

test('a BLANK task directory is allowed, but the string then carries none', () => {
  // Deliberately not a blocker: arming is about accepting remote execution, and a worker whose
  // directory the operator has not decided yet is still a worker the master can be told about.
  // What must never happen is a string that LOOKS complete and is not.
  const { arming } = makeArming()
  const result = arming.arm({ bindAddress: '192.168.1.100', taskCwd: '   ' })
  assert.equal(result.ok, true, result.error)
  const decoded = decodePairing(result.pairing)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.worker.cwd, '', 'an empty field is omitted rather than sent empty')
})

test('the task directory survives a restart, so a restore does not lose the master-facing path', () => {
  const { arming, calls } = makeArming()
  arming.arm({ bindAddress: '192.168.1.100', taskCwd: 'C:\\work' })
  assert.equal(calls.persisted.at(-1).taskCwd, 'C:\\work', 'it must be written, not only held in memory')

  const restarted = makeArming({ stored: calls.persisted.at(-1) })
  assert.equal(restarted.arming.status().taskCwd, 'C:\\work')
  // Decoded, not substring-matched: the string is base64url, so a literal path never appears in it.
  const reissued = decodePairing(restarted.arming.pairingString())
  assert.equal(reissued.ok, true, reissued.error)
  assert.equal(reissued.worker.cwd, 'C:\\work', 'a restored worker re-issues the same directory')
})

test('preflight reports a relative task directory as a blocker before anything is armed', () => {
  const { arming } = makeArming()
  const pre = arming.preflight({ bindAddress: '192.168.1.100', taskCwd: 'relative' })
  assert.equal(pre.ok, false)
  assert.equal(pre.blockers.some((b) => /absolute path/.test(b)), true)
  // The page renders blockers as the reason the arm button is disabled, so an empty one is fine.
  assert.equal(arming.preflight({ bindAddress: '192.168.1.100', taskCwd: '' }).ok, true)
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
