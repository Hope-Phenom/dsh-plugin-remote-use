/**
 * Tests for local address selection.
 *
 * The interesting cases are all the ones where a plausible-looking answer is wrong: a virtual
 * adapter that is a real IPv4 address, an address that is not on this machine at all, and the
 * all-interfaces bind that must be refused rather than defaulted against.
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { addressScore, assertBindable, bestAddress, candidateAddresses, ipv4Value, isPrivateIpv4 } from '../slave/net-address.mjs'

/** The development host's real interface set, which is what exposed the first-IPv4 bug. */
const DEV_HOST = {
  'vEthernet (Default Switch)': [{ address: '172.20.0.1', family: 'IPv4', internal: false }],
  'vEthernet (WSL (Hyper-V firewall))': [{ address: '172.30.80.1', family: 'IPv4', internal: false }],
  '以太网': [{ address: '192.168.1.100', family: 'IPv4', internal: false }],
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
}

test('the real LAN address wins over the virtual switches', () => {
  // This is the exact set that produced `ws://172.20.0.1:7331` -- a Hyper-V switch no peer can
  // reach -- when the first non-internal IPv4 was taken.
  assert.equal(bestAddress(DEV_HOST), '192.168.1.100')
})

test('virtual adapters are listed but never chosen', () => {
  const all = candidateAddresses(DEV_HOST)
  const names = all.map((c) => c.name)
  assert.ok(names.some((n) => n.includes('Default Switch')), 'they are listed, so a UI can explain why')
  const picked = bestAddress(DEV_HOST)
  assert.equal(picked === '172.20.0.1' || picked === '172.30.80.1', false)
})

test('loopback and other internal addresses are never candidates', () => {
  const all = candidateAddresses({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] })
  assert.deepEqual(all, [])
  assert.equal(bestAddress({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }), '')
})

test('IPv6 and malformed entries are ignored', () => {
  const mixed = {
    eth: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.1.5', family: 'IPv4', internal: false },
      { address: 'not-an-ip', family: 'IPv4', internal: false },
      { address: '999.1.1.1', family: 'IPv4', internal: false },
    ],
  }
  assert.deepEqual(candidateAddresses(mixed).map((c) => c.address), ['192.168.1.5'])
})

test('the private ranges outrank anything else, in the documented order', () => {
  assert.ok(addressScore('192.168.1.1', 'eth') > addressScore('10.0.0.1', 'eth'))
  assert.ok(addressScore('10.0.0.1', 'eth') > addressScore('172.16.0.1', 'eth'))
  assert.ok(addressScore('172.16.0.1', 'eth') > addressScore('169.254.1.1', 'eth'))
  assert.ok(addressScore('169.254.1.1', 'eth') > 0, 'link-local is a real answer when nothing else exists')
  assert.ok(addressScore('8.8.8.8', 'eth') > 0)
})

test('a virtual interface name disqualifies even a private address', () => {
  assert.equal(addressScore('192.168.1.5', 'vEthernet (Default Switch)'), -1)
  assert.equal(addressScore('192.168.1.5', 'Docker0'), -1)
  assert.equal(addressScore('192.168.1.5', 'Tailscale'), -1)
  // ...but an ordinary adapter name does not.
  assert.equal(addressScore('192.168.1.5', 'Ethernet'), 40)
})

test('candidate order is stable, not filesystem dependent', () => {
  const a = candidateAddresses({ z: [{ address: '192.168.9.1', family: 'IPv4', internal: false }], a: [{ address: '192.168.1.1', family: 'IPv4', internal: false }] })
  assert.deepEqual(a.map((c) => c.address), ['192.168.1.1', '192.168.9.1'])
})

test('BINDING EVERY INTERFACE IS REFUSED, not merely defaulted against', () => {
  // The decision was "bind a specific LAN interface, and do not offer a one-click
  // all-interfaces option". A rule that only lives in a dropdown is a rule the next caller
  // ignores, so the check is here.
  for (const wildcard of ['0.0.0.0', '::', '*', ' 0.0.0.0 ']) {
    const result = assertBindable(wildcard, DEV_HOST)
    assert.equal(result.ok, false, `${JSON.stringify(wildcard)} must be refused`)
    assert.match(result.error, /every interface/)
  }
})

test('loopback is allowed, because it is an explicit choice and useful as a test mode', () => {
  const result = assertBindable('127.0.0.1', DEV_HOST)
  assert.equal(result.ok, true)
})

test('an address that is not on this machine is refused, with the reason', () => {
  const result = assertBindable('192.168.1.101', DEV_HOST)
  assert.equal(result.ok, false)
  assert.match(result.error, /not an address of this machine/)
})

test('a listed address is accepted, including one a virtual adapter holds', () => {
  // Refusing to CHOOSE a virtual adapter is not the same as refusing to let the operator name
  // one: they may know something the heuristic does not.
  assert.equal(assertBindable('192.168.1.100', DEV_HOST).ok, true)
  assert.equal(assertBindable('172.20.0.1', DEV_HOST).ok, true)
})

test('empty and malformed binds are reported, never guessed', () => {
  assert.match(assertBindable('', DEV_HOST).error, /no bind address/)
  assert.match(assertBindable('   ', DEV_HOST).error, /no bind address/)
  assert.match(assertBindable('192.168.1', DEV_HOST).error, /not an IPv4 address/)
  assert.match(assertBindable(undefined, DEV_HOST).error, /no bind address/)
})

test('ipv4Value orders addresses numerically, not lexically', () => {
  assert.ok(ipv4Value('192.168.1.9') < ipv4Value('192.168.1.10'), 'the classic lexical trap')
  assert.equal(ipv4Value('0.0.0.0'), 0)
  assert.equal(ipv4Value('255.255.255.255'), 4294967295)
  for (const bad of ['1.2.3', '1.2.3.4.5', 'a.b.c.d', '1.2.3.256', '1.2.3.-1', '']) {
    assert.equal(ipv4Value(bad), -1, `${bad} must be rejected`)
  }
})

test('isPrivateIpv4 matches the ranges a peer can reach', () => {
  for (const yes of ['192.168.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.254']) {
    assert.equal(isPrivateIpv4(yes), true, yes)
  }
  for (const no of ['172.32.0.1', '172.15.0.1', '8.8.8.8', '169.254.1.1']) {
    assert.equal(isPrivateIpv4(no), false, no)
  }
})
