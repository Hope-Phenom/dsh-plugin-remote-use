/**
 * Arming this machine as a remote worker.
 *
 * WHAT THIS OWNS, and what it deliberately does not. It owns the DECISION to accept remote
 * execution, the credential, and the latch. It does not own the listener: `start`/`stop` are
 * injected, so the state machine is complete and testable before a port is opened, and the
 * listener cannot quietly acquire a policy of its own.
 *
 * THE SIX DECISIONS THIS ENCODES (§16.4):
 *  1. LATCHED. Arming stays until it is explicitly disarmed. There is no timer that quietly
 *     stops accepting connections, because a remote party that is mid-task would experience
 *     that as a failure rather than as a policy.
 *  2. A SPECIFIC LAN INTERFACE. `0.0.0.0` is refused, not merely discouraged -- see
 *     `slave/net-address.mjs`.
 *  3. THE TOKEN IS SHOWN ONCE. `arm()` returns the plaintext exactly once; the status carries
 *     only a mask afterwards. It is persisted so a restart does not invalidate a pairing.
 *  4. REFUSE WHEN THE SANDBOX DOES NOT CONTAIN. Not "warn and continue": a remote execution
 *     surface on an operator's workstation whose confinement is unverified is the thing this
 *     whole project exists to avoid.
 *  5. LOCAL EMERGENCY STOP. `disarm()` never contacts the far end and never waits on it.
 *  6. THE STATUS SAYS WHAT IS OPEN. Address, port, how long, and which credential is in use.
 *
 * WHY THE GATE RUNS THE PROBE SYNCHRONOUSLY AND EVERY TIME: the failure it looks for depends on
 * the LAUNCH CONTEXT (a console-subsystem process allocates a console, a GUI-subsystem one does
 * not), so a result cached from a previous run in a different context would be answering about
 * a different machine.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { assertBindable, candidateAddresses } from '../../slave/net-address.mjs'
import { encodePairing } from '../../slave/pairing.mjs'
import { probeSandbox } from './sandbox-probe.js'

/** Port used when the operator does not name one. Matches the reference worker's relay. */
export const DEFAULT_ARM_PORT = 7331

/** How long a stored token hint is. Enough to recognise a credential, not to use one. */
const HINT_CHARS = 4

/**
 * @param {string} token
 * @returns {string} a mask that reveals only the tail
 */
export function maskToken(token) {
  const value = String(token ?? '')
  if (value === '') return ''
  return `\u2022`.repeat(12) + value.slice(-HINT_CHARS)
}

/** A fresh credential. 32 bytes of CSPRNG output, hex, so it survives YAML and JSON. */
export function generateToken() {
  return randomBytes(32).toString('hex')
}

/**
 * Compare a presented token against the stored one without leaking its length or content
 * through timing. Kept here rather than in the listener so the rule has one home.
 *
 * @param {string} stored
 * @param {string} presented
 * @returns {boolean}
 */
export function tokenMatches(stored, presented) {
  if (typeof stored !== 'string' || stored === '' || typeof presented !== 'string' || presented === '') return false
  // Hash both sides first: `timingSafeEqual` throws on differing lengths, and the length itself
  // is information. Comparing digests makes every comparison the same length.
  const a = createHash('sha256').update(stored).digest()
  const b = createHash('sha256').update(presented).digest()
  return timingSafeEqual(a, b)
}

export class WorkerArming {
  /**
   * @param {object} deps
   * @param {() => Record<string, any>} deps.interfaces  `os.networkInterfaces()` in production
   * @param {(state: object) => void} [deps.persist]     write the armed state so it survives a restart
   * @param {(bindAddress: string, port: number, token: string) => void} [deps.start]
   * @param {() => void} [deps.stop]
   * @param {() => { ok: boolean, reason: string, checks?: object[] }} [deps.probe] sandbox gate
   * @param {() => number} [deps.now]
   * @param {() => string} [deps.mint]
   * @param {{ info?: Function, warn?: Function }} [deps.log]
   * @param {object} [deps.stored]  the persisted state, if any
   */
  constructor(deps = {}) {
    this.interfaces = deps.interfaces ?? (() => ({}))
    this.persist = deps.persist ?? (() => {})
    this.start = deps.start ?? (() => {})
    this.stop = deps.stop ?? (() => {})
    this.probe = deps.probe ?? (() => probeSandbox())
    this.now = deps.now ?? (() => Date.now())
    this.mint = deps.mint ?? generateToken
    const log = deps.log ?? {}
    this.log = { info: log.info ?? (() => {}), warn: log.warn ?? (() => {}) }

    const stored = deps.stored ?? {}
    this.armed = false
    this.bindAddress = ''
    this.port = DEFAULT_ARM_PORT
    this.token = ''
    this.armedAt = 0
    this.lastError = ''
    this.lastProbe = { ok: false, reason: 'not checked yet' }

    // The token is restored, NOT regenerated: decision 3 persists it so a restart does not
    // invalidate a pairing the operator has already distributed. Regenerating here would be the
    // quiet way to break every paired master on reboot.
    if (stored !== null && typeof stored === 'object' && typeof stored.token === 'string' && stored.token !== '') {
      this.token = stored.token
    }
    if (typeof stored?.bindAddress === 'string') this.bindAddress = stored.bindAddress
    if (Number.isFinite(stored?.port)) this.port = Number(stored.port)
    if (stored?.armed === true && this.token !== '' && this.bindAddress !== '') {
      this.armed = true
      this.armedAt = Number.isFinite(stored.armedAt) ? Number(stored.armedAt) : this.now()
      try {
        this.start(this.bindAddress, this.port, this.token)
        this.log.info(`worker role restored: listening on ${this.bindAddress}:${this.port}`)
      } catch (error) {
        // A failed rebind must NOT leave the object claiming to be armed: the operator would see
        // "accepting remote execution" while nothing is listening.
        this.armed = false
        this.lastError = `could not restore the listener: ${error instanceof Error ? error.message : String(error)}`
        this.log.warn(this.lastError)
      }
    }
  }

  /** What the page shows. Never includes the token, only its mask. */
  status() {
    return {
      armed: this.armed,
      bindAddress: this.bindAddress,
      port: this.port,
      tokenSet: this.token !== '',
      tokenHint: maskToken(this.token),
      armedAt: this.armedAt,
      uptimeMs: this.armed && this.armedAt > 0 ? Math.max(0, this.now() - this.armedAt) : 0,
      lastError: this.lastError,
      // Every interface, including the ones that must not be chosen, so the page can explain
      // rather than silently omit.
      interfaces: candidateAddresses(this.interfaces()),
      probe: { ok: this.lastProbe.ok, reason: this.lastProbe.reason },
    }
  }

  /**
   * Can this machine be armed at all, and is the requested address usable?
   *
   * Runs the sandbox probe EVERY time: the answer depends on the launch context, so a cached
   * one is an answer about a different context.
   *
   * @param {{ bindAddress?: string, port?: number }} [request]
   * @returns {{ ok: boolean, blockers: string[], probe: object }}
   */
  preflight(request = {}) {
    const blockers = []
    this.lastProbe = this.probe()
    if (this.lastProbe.ok !== true) {
      blockers.push(`the sandbox does not contain this machine: ${this.lastProbe.reason}`)
    }
    const address = request.bindAddress ?? this.bindAddress
    const bindable = assertBindable(address, this.interfaces())
    if (!bindable.ok) blockers.push(bindable.error)
    const port = Number(request.port ?? this.port ?? DEFAULT_ARM_PORT)
    if (!Number.isInteger(port) || port < 1 || port > 65535) blockers.push(`port must be 1..65535, got ${port}`)
    return { ok: blockers.length === 0, blockers, probe: this.lastProbe }
  }

  /**
   * Accept remote execution. Returns the plaintext token EXACTLY ONCE.
   *
   * @param {{ bindAddress: string, port?: number }} request
   * @returns {{ ok: boolean, token?: string, error?: string, blockers?: string[] }}
   */
  arm(request) {
    if (this.armed) {
      // Not an error worth hiding: the page may be showing a stale state, and re-minting a token
      // here would break a pairing the operator has already distributed.
      return { ok: false, error: `already armed on ${this.bindAddress}:${this.port}` }
    }
    const pre = this.preflight(request)
    if (!pre.ok) return { ok: false, error: pre.blockers[0], blockers: pre.blockers }

    const bindAddress = String(request.bindAddress).trim()
    const port = Number(request.port ?? DEFAULT_ARM_PORT)

    // A NEW token each time it is armed from disarmed: disarming is the operator saying "stop",
    // and a credential that survived that would be a credential they did not expect to still
    // work. The stored one is only reused across a RESTART, which is a different event.
    const token = this.token === '' ? this.mint() : this.token

    try {
      this.start(bindAddress, port, token)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = `could not start the listener: ${message}`
      return { ok: false, error: this.lastError }
    }

    this.armed = true
    this.bindAddress = bindAddress
    this.port = port
    this.token = token
    this.armedAt = this.now()
    this.lastError = ''
    this.#persist()
    this.log.info(`worker role armed on ${bindAddress}:${port}`)
    // Both forms, ONCE. The caller shows them and keeps neither; every later read of the status
    // carries only the mask.
    return { ok: true, token, pairing: this.pairingString() }
  }

  /**
   * Stop accepting remote execution. Decision 5: local, immediate, and never dependent on the
   * far end -- this is the switch that must work when the remote party is misbehaving.
   *
   * The token is KEPT in storage so a restart restores the same pairing; it is cleared in
   * memory so the running process cannot accept it again.
   *
   * @param {{ forget?: boolean }} [opts] `forget` also invalidates the credential
   */
  disarm(opts = {}) {
    const wasArmed = this.armed
    this.armed = false
    this.armedAt = 0
    try {
      this.stop()
    } catch (error) {
      // Report but do not re-arm: a listener that failed to stop must not leave the object
      // claiming to be safe, and the operator needs to know which it is.
      this.lastError = `the listener did not stop cleanly: ${error instanceof Error ? error.message : String(error)}`
      this.log.warn(this.lastError)
    }
    if (opts.forget === true) this.token = ''
    this.#persist()
    if (wasArmed) this.log.info(`worker role disarmed (${opts.forget === true ? 'credential discarded' : 'credential kept'})`)
    return { ok: this.lastError === '', wasArmed }
  }

  /**
   * The pairing string for the credential in force, or '' when disarmed.
   *
   * Returned alongside the token at arm time and never again. The string carries the credential
   * in recoverable form, so treating it as re-readable would undo decision 3 -- the point of
   * "shown once" is that the secret is not sitting in a page that can be screenshotted or left
   * open. Re-issuing is a deliberate act: `disarm({ forget: true })` then `arm()`.
   */
  pairingString() {
    if (!this.armed || this.token === '') return ''
    return encodePairing({ url: `ws://${this.bindAddress}:${this.port}`, token: this.token })
  }

  /** Whether a presented credential is the one in force. */
  accepts(presented) {
    if (!this.armed) return false
    return tokenMatches(this.token, presented)
  }

  #persist() {
    try {
      this.persist({
        armed: this.armed,
        bindAddress: this.bindAddress,
        port: this.port,
        token: this.token,
        armedAt: this.armedAt,
      })
    } catch (error) {
      this.lastError = `could not persist the worker role: ${error instanceof Error ? error.message : String(error)}`
      this.log.warn(this.lastError)
    }
  }
}
