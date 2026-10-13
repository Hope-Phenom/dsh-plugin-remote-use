/**
 * Tests for the pairing string.
 *
 * The string carries a bearer token, so the interesting cases are all about failing safely:
 * a truncated paste, a tampered one, a wrong transport, or a payload shape that would produce
 * a worker entry which looks fine and cannot connect. Each of those is asserted to be
 * REJECTED rather than coerced.
 */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { MAX_PAIRING_CHARS, PAIRING_PREFIX, decodePairing, describePairing, encodePairing } from '../slave/pairing.mjs'

const WORKER = { url: 'ws://192.168.1.101:7331', token: 'tok-abcdefghijklmnop', name: 'worker-pc', cwd: 'C:\\dsh-remote\\p0work' }

test('a pairing string round-trips', () => {
  const text = encodePairing(WORKER)
  assert.match(text, new RegExp(`^${PAIRING_PREFIX}\\.`))
  const decoded = decodePairing(text)
  assert.equal(decoded.ok, true)
  assert.deepEqual(decoded.worker, WORKER)
})

test('optional fields are omitted rather than sent empty', () => {
  const text = encodePairing({ url: WORKER.url, token: WORKER.token })
  assert.equal(decodePairing(text).worker.name, '')
  assert.equal(decodePairing(text).worker.cwd, '')
  // A bare url+token must produce a SHORTER string than one carrying both extras.
  assert.ok(text.length < encodePairing(WORKER).length)
})

test('a worker with no url or no token cannot be encoded', () => {
  // Returning '' rather than a string that decodes to a half-configured worker.
  assert.equal(encodePairing({ url: '', token: 'x' }), '')
  assert.equal(encodePairing({ url: 'ws://h:1', token: '' }), '')
  assert.equal(encodePairing({}), '')
  assert.equal(encodePairing(undefined), '')
})

test('a TRUNCATED paste is rejected instead of yielding a plausible worker', () => {
  // The whole point of the checksum. A silently-wrong token surfaces much later as an
  // authentication failure, nowhere near the paste that caused it.
  const text = encodePairing(WORKER)
  const decoded = decodePairing(text.slice(0, text.length - 6))
  assert.equal(decoded.ok, false)
  assert.match(decoded.error, /checksum|incomplete/)
})

test('a TAMPERED payload is rejected', () => {
  const text = encodePairing(WORKER)
  const [, body, checksum] = text.split('.')
  // Flip one character of the payload, leaving the checksum alone.
  const flipped = body.slice(0, 5) + (body[5] === 'A' ? 'B' : 'A') + body.slice(6)
  const decoded = decodePairing(`${PAIRING_PREFIX}.${flipped}.${checksum}`)
  assert.equal(decoded.ok, false)
  assert.match(decoded.error, /checksum mismatch/)
})

test('copy-paste whitespace and terminal wrapping are tolerated', () => {
  const text = encodePairing(WORKER)
  const wrapped = `${text.slice(0, 20)}\n  ${text.slice(20, 40)}\r\n${text.slice(40)}\n`
  assert.equal(decodePairing(wrapped).ok, true)
  assert.equal(decodePairing(`  ${text}  `).ok, true)
})

test('the wrong prefix, or none, is reported rather than guessed at', () => {
  const text = encodePairing(WORKER)
  const [, body, checksum] = text.split('.')
  assert.match(decodePairing(`dshpair2.${body}.${checksum}`).error, /not a dshpair1 string/)
  assert.match(decodePairing(body).error, /expected dshpair1/)
  assert.match(decodePairing('').error, /empty/)
  assert.match(decodePairing(null).error, /must be text/)
  assert.match(decodePairing(12345).error, /must be text/)
})

/**
 * Build a pairing string with a VALID checksum around an arbitrary payload. Without this, a
 * test of the version branch would only prove the checksum works.
 */
function forge(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const checksum = createHash('sha256').update(body).digest('base64url').slice(0, 8)
  return `${PAIRING_PREFIX}.${body}.${checksum}`
}

test('an unsupported version is named, so a future format is not mistaken for corruption', () => {
  const decoded = decodePairing(forge({ v: 2, url: 'ws://h:1', token: 't' }))
  assert.equal(decoded.ok, false)
  assert.match(decoded.error, /unsupported pairing version/)
  // A missing or non-numeric version is the same story.
  assert.match(decodePairing(forge({ url: 'ws://h:1', token: 't' })).error, /unsupported pairing version/)
})

test('a payload that is not an object, or lacks url/token, is rejected on its merits', () => {
  // Forged checksums, so these reach the shape checks rather than stopping at the sum.
  assert.match(decodePairing(forge([1, 2, 3])).error, /must be an object/)
  assert.match(decodePairing(forge(null)).error, /must be an object/)
  assert.match(decodePairing(forge({ v: 1, token: 't' })).error, /no url/)
  assert.match(decodePairing(forge({ v: 1, url: 'ws://h:1' })).error, /no token/)
  assert.match(decodePairing(forge({ v: 1, url: 'ws://h:1', token: '   ' })).error, /no token/)
})

test('only ws:// and wss:// are accepted', () => {
  // A plain http:// would produce a worker that cannot connect, discovered much later.
  for (const bad of ['http://192.168.1.101:7331', 'ftp://x', 'file:///c:/x', 'not-a-url', 'ws://']) {
    const text = encodePairing({ url: bad, token: 't' })
    if (text === '') continue
    const decoded = decodePairing(text)
    assert.equal(decoded.ok, false, `${bad} must be rejected`)
  }
  assert.equal(decodePairing(encodePairing({ url: 'wss://example.com:443', token: 't' })).ok, true)
})

test('an oversized paste is refused before it is parsed', () => {
  const huge = `${PAIRING_PREFIX}.${'A'.repeat(MAX_PAIRING_CHARS)}.${'B'.repeat(8)}`
  const decoded = decodePairing(huge)
  assert.equal(decoded.ok, false)
  assert.match(decoded.error, /longer than/)
})

test('describePairing reveals the host and port only, never the token', () => {
  const text = encodePairing(WORKER)
  const described = describePairing(text)
  assert.equal(described, '192.168.1.101:7331')
  assert.equal(described.includes(WORKER.token), false)
  // ...and nothing at all when the string is unusable.
  assert.equal(describePairing('nonsense'), '')
  assert.equal(describePairing(''), '')
})

test('the token never appears in an error message', () => {
  // These strings get logged and shown in the page.
  const secret = 'super-secret-token-value'
  const text = encodePairing({ url: 'ws://h:1', token: secret })
  const truncated = decodePairing(text.slice(0, text.length - 4))
  assert.equal(truncated.ok, false)
  assert.equal(String(truncated.error).includes(secret), false)
  const wrongPrefix = decodePairing(`nope.${text.split('.')[1]}.${text.split('.')[2]}`)
  assert.equal(String(wrongPrefix.error).includes(secret), false)
})

// ---------------------------------------------------------------------------
// cross-boundary: the relay ENCODES in its own process, the host DECODES here
//
// Nothing else in the suite runs the relay's encoder. A format that drifted on one side would
// otherwise only be discovered by an operator whose paste did not work.
// ---------------------------------------------------------------------------

const SLAVE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'slave')

test("the relay's own output decodes with the host's decoder", () => {
  const out = execFileSync(process.execPath, [
    join(SLAVE_DIR, 'relay.mjs'),
    '--port', '7399',
    '--token', 'tok-cross-boundary-value',
    '--advertise-host', '192.168.1.101',
    '--pairing-name', 'worker-pc',
    '--print-pairing',
  ], { encoding: 'utf8', timeout: 30_000 }).trim()

  const decoded = decodePairing(out)
  assert.equal(decoded.ok, true, `the relay produced something the host cannot read: ${decoded.error}`)
  assert.equal(decoded.worker.url, 'ws://192.168.1.101:7399')
  assert.equal(decoded.worker.token, 'tok-cross-boundary-value')
  assert.equal(decoded.worker.name, 'worker-pc')
  // Recoverable by design, but not readable at a glance: an operator may paste this into a
  // ticket or a chat while debugging.
  assert.equal(out.includes('tok-cross-boundary-value'), false)
})

test('the relay REFUSES to build a pairing string for an unauthenticated worker', () => {
  // Emitting one here would pair a master to a relay that accepts anybody.
  const run = spawnSync(process.execPath, [join(SLAVE_DIR, 'relay.mjs'), '--port', '7399', '--print-pairing'], {
    encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(run.status, 2, 'it must exit non-zero')
  assert.match(run.stderr, /no --token/)
  assert.equal(run.stdout.trim(), '', 'it must not print anything usable')
})

test('the relay advertises an ordinary LAN address, not a virtual adapter', () => {
  // Measured on the development host: it carries `vEthernet (Default Switch) 172.20.0.1` and
  // `vEthernet (WSL) 172.30.80.1` alongside the real Ethernet. Taking the FIRST non-internal
  // IPv4 produced a well-formed pairing string pointing at a switch no peer can reach.
  const out = execFileSync(process.execPath, [
    join(SLAVE_DIR, 'relay.mjs'), '--port', '7399', '--token', 't', '--print-pairing',
  ], { encoding: 'utf8', timeout: 30_000 }).trim()
  const decoded = decodePairing(out)
  assert.equal(decoded.ok, true)
  const host = new URL(decoded.worker.url).hostname
  assert.equal(/^(172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/u.test(host), false,
    `advertised a virtual or link-local address: ${host}`)
})
