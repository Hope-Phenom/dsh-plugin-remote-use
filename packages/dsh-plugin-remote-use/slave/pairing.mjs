/**
 * The pairing string: everything the master needs to reach one worker, in one paste.
 *
 * WHY IT EXISTS: pairing meant typing an address literal and a 40-character bearer
 * token by hand, from a value the operator had to go and read off the other machine. That is
 * slow and gets a character wrong about as often as it is attempted.
 *
 * IT CARRIES A CREDENTIAL. The string contains the worker's token in recoverable form, so it
 * is exactly as sensitive as the token itself -- anyone holding it can drive that worker. Two
 * consequences shape the implementation:
 *
 *   * it is never logged, echoed, or included in an error message;
 *   * the checksum is not decoration. A truncated paste must fail LOUDLY rather than yield a
 *     worker entry that looks plausible and cannot connect, because the failure mode of a
 *     silently-wrong token is an authentication error much later, far from the paste.
 *
 * The format is deliberately versioned (`dshpair1`) so a future change can be told apart from
 * a corrupt one instead of being misread.
 *
 * This module is shared: the relay encodes, the host decodes. It has no dependencies beyond
 * `node:crypto`, so it can be copied to a worker alongside `relay.mjs`.
 */
import { createHash } from 'node:crypto'

/** Marks which format this is, so a corrupt string is distinguishable from an old one. */
export const PAIRING_PREFIX = 'dshpair1'

/** Checksum length in base64url characters. 8 is ~48 bits: ample for catching a typo. */
const CHECKSUM_CHARS = 8

/** Longest pairing string accepted, so a paste of a whole file cannot be chewed through. */
export const MAX_PAIRING_CHARS = 8 * 1024

function checksumOf(body) {
  return createHash('sha256').update(body).digest('base64url').slice(0, CHECKSUM_CHARS)
}

/**
 * @param {{ url?: unknown, token?: unknown, name?: unknown, cwd?: unknown }} worker
 * @returns {string} the pairing string, or an empty string when the input cannot be paired
 */
export function encodePairing(worker) {
  const url = String(worker?.url ?? '').trim()
  const token = String(worker?.token ?? '').trim()
  if (url === '' || token === '') return ''
  const payload = { v: 1, url, token }
  // Optional fields are omitted rather than sent empty, so the string stays short and a
  // missing name is unambiguous.
  const name = String(worker?.name ?? '').trim()
  if (name !== '') payload.name = name
  const cwd = String(worker?.cwd ?? '').trim()
  if (cwd !== '') payload.cwd = cwd

  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${PAIRING_PREFIX}.${body}.${checksumOf(body)}`
}

/**
 * Parse a pairing string pasted by an operator.
 *
 * Lenient about the things a copy-paste gets wrong -- surrounding whitespace, line breaks
 * introduced by a terminal, and the base64url alphabet -- and strict about everything that
 * could produce a wrong worker entry.
 *
 * @param {unknown} text
 * @returns {{ ok: true, worker: { url: string, token: string, name: string, cwd: string } }
 *          | { ok: false, error: string }}
 */
export function decodePairing(text) {
  const fail = (error) => ({ ok: false, error })
  if (typeof text !== 'string') return fail('pairing string must be text')
  if (text.length > MAX_PAIRING_CHARS) return fail(`pairing string is longer than ${MAX_PAIRING_CHARS} characters`)

  // Copy-paste introduces whitespace and terminal wrapping. Only INTERNAL wrapping matters,
  // and base64url has no spaces, so removing all whitespace is safe and fixes the common case.
  const cleaned = text.replace(/\s+/gu, '')
  if (cleaned === '') return fail('pairing string is empty')

  const parts = cleaned.split('.')
  if (parts.length !== 3) return fail(`expected ${PAIRING_PREFIX}.<payload>.<checksum>`)
  const [prefix, body, checksum] = parts
  if (prefix !== PAIRING_PREFIX) return fail(`not a ${PAIRING_PREFIX} string (got "${prefix.slice(0, 24)}")`)
  if (body === '' || checksum === '') return fail('pairing string is incomplete')
  if (checksum !== checksumOf(body)) {
    // The important one: a truncated or mistyped paste must not become a plausible worker.
    return fail('checksum mismatch -- the pairing string was truncated or altered in transit')
  }

  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return fail('payload is not valid JSON')
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return fail('payload must be an object')
  if (payload.v !== 1) return fail(`unsupported pairing version ${JSON.stringify(payload.v)}`)

  const url = typeof payload.url === 'string' ? payload.url.trim() : ''
  if (url === '') return fail('payload carries no url')
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return fail(`url is not a URL: ${url.slice(0, 60)}`)
  }
  // Only the transports the plugin actually speaks. A plain `http://` here would produce a
  // worker that cannot connect, discovered much later.
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return fail(`url must be ws:// or wss://, got ${parsed.protocol}`)
  }
  if (parsed.hostname === '') return fail('url has no host')

  const token = typeof payload.token === 'string' ? payload.token.trim() : ''
  if (token === '') return fail('payload carries no token')

  return {
    ok: true,
    worker: {
      url,
      token,
      name: typeof payload.name === 'string' ? payload.name.trim() : '',
      cwd: typeof payload.cwd === 'string' ? payload.cwd.trim() : '',
    },
  }
}

/**
 * A short, non-secret label for a pairing string, safe to show or log.
 * Reveals only the host and port, which the operator already typed or pasted.
 *
 * @param {string} text
 * @returns {string}
 */
export function describePairing(text) {
  const decoded = decodePairing(text)
  if (decoded.ok !== true) return ''
  try {
    const url = new URL(decoded.worker.url)
    return url.host
  } catch {
    return ''
  }
}

/**
 * Derive a worker id from a pairing string when the operator did not supply one.
 *
 * Pairing is a paste; asking the operator to also invent an id would defeat the point. The
 * worker's own name is the best answer when it has one, and the host otherwise -- never the
 * whole URL, which contains the port and reads badly in a table.
 *
 * The result is restricted to characters that are safe in a filename, because the id becomes
 * part of the screenshot filenames on the host (`<id>-<stamp>.png`) and the pruning pattern
 * assumes the separator is the only punctuation that matters.
 *
 * @param {{ url?: string, name?: string }} worker
 * @returns {string} a non-empty id, or '' when nothing usable can be derived
 */
export function deriveWorkerId(worker) {
  const name = String(worker?.name ?? '').trim()
  let candidate = name
  if (candidate === '') {
    try {
      candidate = new URL(String(worker?.url ?? '')).hostname
    } catch {
      return ''
    }
  }
  const slug = candidate
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
  return slug
}
