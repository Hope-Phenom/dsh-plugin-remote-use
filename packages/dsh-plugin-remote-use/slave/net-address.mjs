/**
 * Choosing which local address to advertise, and which ones may be bound.
 *
 * WHY THIS IS ITS OWN MODULE: two callers need the same answer -- the relay, to put an address
 * in a pairing string, and the plugin's arming path, to offer a list of interfaces and to
 * refuse a bind that is not one of them. Two copies of "which address is the real LAN one"
 * would drift, and the failure mode is a pairing string or a listener that is well-formed and
 * unreachable.
 *
 * THE MEASUREMENT THAT SHAPED IT: a Windows machine with Hyper-V, WSL, Docker or VirtualBox
 * installed has several non-internal IPv4 addresses, enumerated in no useful order. Taking the
 * FIRST one produced `172.20.0.1` on the development host -- a Hyper-V switch no peer can
 * reach. So candidates are scored rather than filtered, and interfaces whose names give them
 * away as virtual are rejected outright.
 *
 * It is a heuristic, which is why an explicit override exists at every call site.
 */

/**
 * Interface names that are virtual adapters, with the switch that owns them.
 * Rejected outright rather than down-ranked: an operator who wants one can still name it
 * explicitly, but nothing should ever pick it by accident.
 */
const VIRTUAL_ADAPTER = /(hyper-v|vethernet|wsl|docker|vmware|virtualbox|vbox|loopback|tailscale|zerotier|tap|tun|npcap|bluetooth)/iu

/** `a.b.c.d` -> a number, or -1 when it is not a dotted quad. */
export function ipv4Value(address) {
  const parts = String(address).split('.')
  if (parts.length !== 4) return -1
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return -1
    const n = Number(part)
    if (n > 255) return -1
    value = (value * 256) + n
  }
  return value
}

/** True for the private ranges a LAN peer can normally reach. */
export function isPrivateIpv4(address) {
  return address.startsWith('192.168.')
    || address.startsWith('10.')
    || /^172\.(1[6-9]|2\d|3[01])\./u.test(address)
}

/**
 * How good an address is to advertise or bind. Higher wins; `-1` means never choose it.
 *
 * Private ranges beat anything else because a peer on the LAN can reach them, and the classic
 * `192.168.0.0/16` beats `10/8` beats the `172.16/12` block -- where container and switch
 * addresses usually land. Link-local (`169.254.`) scores lowest but is not rejected: it is a
 * real answer when nothing else is configured, and saying so beats offering nothing.
 */
export function addressScore(address, name) {
  if (VIRTUAL_ADAPTER.test(String(name))) return -1
  const value = ipv4Value(address)
  if (value < 0) return -1
  if (address === '127.0.0.1' || address.startsWith('127.')) return -1
  if (address.startsWith('192.168.')) return 40
  if (address.startsWith('10.')) return 30
  if (/^172\.(1[6-9]|2\d|3[01])\./u.test(address)) return 20
  if (address.startsWith('169.254.')) return 1
  return 10
}

/**
 * Every IPv4 address this machine could plausibly be reached on.
 *
 * @param {Record<string, Array<{address: string, family: string, internal: boolean}>>} interfaces
 *        as `os.networkInterfaces()` returns it -- injected so this is testable off-machine
 * @returns {Array<{ address: string, name: string, score: number, private: boolean, virtual: boolean }>}
 *          best first; virtual adapters are included but scored -1, so a UI can explain why
 *          they are not offered
 */
export function candidateAddresses(interfaces) {
  const out = []
  for (const [name, list] of Object.entries(interfaces ?? {})) {
    for (const info of list ?? []) {
      if (info?.family !== 'IPv4' || info.internal === true) continue
      const address = String(info.address ?? '')
      // A malformed entry is not an address at all, so it is dropped. A VIRTUAL adapter is a
      // real address that merely should not be chosen by default, so it stays in the list with
      // a negative score -- that is what lets a UI say why it is not offered.
      if (ipv4Value(address) < 0) continue
      const virtual = VIRTUAL_ADAPTER.test(name)
      out.push({
        address,
        name,
        score: addressScore(address, name),
        private: isPrivateIpv4(address),
        virtual,
      })
    }
  }
  // Best score first, then the lower address, so the order is stable across calls.
  return out.sort((a, b) => (b.score - a.score) || (ipv4Value(a.address) - ipv4Value(b.address)))
}

/**
 * The best address to advertise, or '' when there is none.
 * @param {Record<string, any>} interfaces
 * @returns {string}
 */
export function bestAddress(interfaces) {
  const [first] = candidateAddresses(interfaces)
  return first === undefined || first.score <= 0 ? '' : first.address
}

/**
 * May `address` be bound as the worker listener?
 *
 * `0.0.0.0` is REFUSED, not merely defaulted against. The decision was "bind a specific LAN
 * interface, and do not offer a one-click all-interfaces option", and a rule that only lives in
 * a dropdown is a rule the next caller ignores.
 *
 * @param {string} address
 * @param {Record<string, any>} interfaces
 * @returns {{ ok: boolean, error: string }}
 */
export function assertBindable(address, interfaces) {
  const value = String(address ?? '').trim()
  if (value === '') return { ok: false, error: 'no bind address given' }
  if (value === '0.0.0.0' || value === '::' || value === '*') {
    return { ok: false, error: 'binding every interface is not offered; name the LAN address to listen on' }
  }
  if (value === '127.0.0.1' || value.startsWith('127.')) {
    // Allowed, but only as an explicit choice: a loopback listener cannot be reached by a peer,
    // so it is a test mode rather than a pairing.
    return { ok: true, error: '' }
  }
  if (ipv4Value(value) < 0) return { ok: false, error: `not an IPv4 address: ${value}` }
  const known = candidateAddresses(interfaces).find((c) => c.address === value)
  if (known === undefined) {
    return { ok: false, error: `${value} is not an address of this machine (choose one of the listed interfaces)` }
  }
  return { ok: true, error: '' }
}
