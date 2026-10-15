/**
 * Connection manager for one worker.
 *
 * WHY THIS EXISTS: `AcpBridge` is a passive client -- it does nothing until `connect()`
 * is called, and `startTask()` / `callPlugin()` throw "not connected" otherwise. The
 * first shipped version of this plugin built a bridge and used it directly, so EVERY path
 * (self-check and dispatch alike) failed with `AcpBridge.callPlugin: not connected`. The
 * unit and integration tests missed it because they injected bridges that were already
 * connected; only a real profile load exposed it.
 *
 * This manager OWNS the bridge lifecycle instead of wrapping a long-lived instance, which
 * is what makes recovery real:
 *
 *   - lazy: the worker may be off or still booting when the host starts, so connecting at
 *     load time would be both pointless and fatal (one failure would strand the plugin);
 *   - single-flight: two concurrent delegations must not race into two connects;
 *   - self-healing: a transport failure DISPOSES the bridge rather than merely flagging it,
 *     because `AcpBridge` has no way to re-arm itself -- `connect()` on a live instance
 *     throws "already connected". Dropping it lets the next call build a fresh one.
 *
 * The surface matches what the provider already expects (`startTask` / `cancel` /
 * `selfcheck` / `dispose` / `connected` / `stats`), so the provider cannot tell the
 * difference between a manager and a raw bridge.
 *
 * @module dsh-plugin-remote-use/peer-connection
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { DEFAULT_KEEP_SHOTS, DEFAULT_SHOT_CACHE_BYTES, clearShots, pruneShots, scanShotUsage } from '../core/shot-gc.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Where downloaded worker screenshots land. The host's image reader must be able to open it. */
export function defaultShotDir() {
  return join(tmpdir(), 'dsh-remote-screenshots')
}

/**
 * Liveness probe interval.
 *
 * WHY A HEARTBEAT: `AcpBridge` does not watch its socket, and the relay closes it on
 * restart, so `connected` keeps reporting true over a dead link. Without a probe the first
 * call after any worker restart fails -- measured, and the failure surfaced as the
 * misleading "nobody is logged in" before that was fixed. A cheap periodic ping turns a
 * silent death into a prompt reconnect.
 */
const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000

/**
 * Turn a WebSocket URL into its HTTP counterpart on the same relay:
 * `ws://h:p` -> `http://h:p`, `wss://h:p` -> `https://h:p`.
 * @param {string} wsUrl
 * @returns {string} '' when the URL is unusable
 */
export function httpBaseOf(wsUrl) {
  if (typeof wsUrl !== 'string' || wsUrl === '') return ''
  try {
    const u = new URL(wsUrl)
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    return `${u.protocol}//${u.host}`
  } catch {
    return ''
  }
}

export class PeerConnection {
  /**
   * @param {object} opts
   * @param {string} opts.peerId
   * @param {() => object} opts.createBridge  builds a fresh, unconnected bridge
   * @param {(level: 'info'|'warn'|'error', message: string) => void} [opts.log]
   * @param {() => number} [opts.now]
   * @param {string} [opts.httpBase]   relay HTTP origin, for binary endpoints
   * @param {string} [opts.token]      bearer for those endpoints
   * @param {string} [opts.shotDir]    where downloaded screenshots are written
   * @param {number} [opts.shotCacheBytes] byte ceiling for those downloads; <= 0 disables it
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {number} [opts.heartbeatMs] liveness probe interval; 0 disables it
   * @param {number} [opts.heartbeatTimeoutMs]
   */
  constructor(opts) {
    this.peerId = opts.peerId
    this.createBridge = opts.createBridge
    this.log = opts.log ?? (() => {})
    this.now = opts.now ?? (() => Date.now())
    this.httpBase = opts.httpBase ?? ''
    this.token = opts.token ?? ''
    this.shotDir = opts.shotDir ?? defaultShotDir()
    /** How many of this worker's screenshots to keep on disk. See core/shot-gc.js. */
    this.keepShots = Number.isFinite(opts.keepShots) ? Number(opts.keepShots) : DEFAULT_KEEP_SHOTS
    /**
     * Byte ceiling for this worker's HOST-side downloads. <= 0 (the default) means the count
     * budget is the only bound, which is what an install upgrading into this feature expects: a
     * byte budget that appeared on its own would start deleting captures nobody agreed to lose.
     */
    this.shotCacheBytes = Number.isFinite(opts.shotCacheBytes)
      ? Number(opts.shotCacheBytes)
      : DEFAULT_SHOT_CACHE_BYTES
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.heartbeatMs = Number.isFinite(opts.heartbeatMs) ? Math.max(0, Number(opts.heartbeatMs)) : DEFAULT_HEARTBEAT_MS
    this.heartbeatTimeoutMs = Number.isFinite(opts.heartbeatTimeoutMs)
      ? Math.max(1, Number(opts.heartbeatTimeoutMs))
      : DEFAULT_HEARTBEAT_TIMEOUT_MS

    /** @type {object | undefined} */
    this.bridge = undefined
    /** @type {Promise<void> | undefined} in-flight connect, shared by concurrent callers */
    this.connecting = undefined
    this.connects = 0
    this.connectFailures = 0
    this.lastError = ''
    this.lastConnectedAt = 0
    this.disposed = false

    /** @type {ReturnType<typeof setInterval> | undefined} */
    this.heartbeatTimer = undefined
    this.heartbeatBeating = false
    this.heartbeats = 0
    this.heartbeatFailures = 0
    this.lastHeartbeatAt = 0
  }

  /** True when a bridge exists and reports an established session. */
  get connected() {
    return this.bridge !== undefined && this.bridge.connected === true
  }

  /** Observable counters for the settings route and the audit trail. */
  get stats() {
    return {
      peerId: this.peerId,
      connected: this.connected,
      connects: this.connects,
      connectFailures: this.connectFailures,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
      heartbeatMs: this.heartbeatMs,
      heartbeats: this.heartbeats,
      heartbeatFailures: this.heartbeatFailures,
      lastHeartbeatAt: this.lastHeartbeatAt,
      ...(this.bridge?.stats !== undefined && this.bridge.stats !== null ? { bridge: this.bridge.stats } : {}),
    }
  }

  /**
   * Ensure an established connection.
   *
   * A failure clears the shared promise so the NEXT call retries; without that, one
   * transient error (worker still booting) would pin the rejection for every later call.
   *
   * @returns {Promise<void>}
   */
  async ensure() {
    if (this.disposed) throw new Error(`PeerConnection(${this.peerId}): disposed`)
    if (this.connected) return

    if (this.connecting === undefined) {
      this.connecting = (async () => {
        // Build a bridge here rather than in the constructor: a previous attempt may have
        // been discarded, and `connect()` cannot be retried on a used instance.
        if (this.bridge === undefined) this.bridge = this.createBridge()
        this.connects += 1
        this.log('info', `connecting to worker "${this.peerId}" (attempt ${this.connects})`)
        await this.bridge.connect()
        this.lastConnectedAt = this.now()
        this.lastError = ''
        this.log('info', `connected to worker "${this.peerId}"`)
        this.#startHeartbeat()
      })().catch((error) => {
        this.connectFailures += 1
        this.lastError = error instanceof Error ? error.message : String(error)
        this.log('warn', `worker "${this.peerId}" connect failed: ${this.lastError}`)
        throw error
      }).finally(() => {
        // Always clear: on success the `connected` flag takes over, on failure the next
        // caller must be free to start a fresh attempt.
        this.connecting = undefined
      })
    }
    return await this.connecting
  }

  /**
   * Ask the worker for a readiness report, connecting first.
   * @param {{ maxAgeMs?: number, timeoutMs?: number }} [opts]
   */
  async selfcheck(opts = {}) {
    await this.ensure()
    if (typeof this.bridge?.selfcheck !== 'function') {
      throw new Error(`PeerConnection(${this.peerId}): bridge does not implement selfcheck`)
    }
    try {
      return await this.bridge.selfcheck(opts)
    } catch (error) {
      await this.#invalidateIfTransportError(error)
      throw error
    }
  }

  /**
   * Run one task on the worker, connecting first. Per-call callbacks pass through
   * unchanged; the bridge resolves them per task.
   * @param {object} req
   */
  async startTask(req) {
    await this.ensure()
    try {
      return await this.bridge.startTask(req)
    } catch (error) {
      await this.#invalidateIfTransportError(error)
      throw error
    }
  }

  /** Cancel the worker's current run. Never throws for a missing connection. */
  async cancel() {    if (!this.connected) {
      // Nothing to cancel on a link that was never established: do not connect purely to
      // deliver a cancel.
      this.log('warn', `cancel for "${this.peerId}" ignored: not connected`)
      return
    }
    try {
      await this.bridge.cancel()
    } catch (error) {
      await this.#invalidateIfTransportError(error)
      this.log('warn', `cancel on "${this.peerId}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Capture the worker's desktop and save the PNG locally.
   *
   * WHY HTTP AND NOT THE RPC: the relay exposes both, but the bytes must not travel as
   * base64 inside a JSON-RPC result -- that inflates a multi-megabyte PNG by a third and
   * would have to pass through the ACP message pump, which exists for small control
   * frames. The RPC returns metadata; `GET /screenshot` returns the image. One download
   * gives both (geometry is in the response headers), so no RPC round trip is needed.
   *
   * The file is written where the HOST's image reader can open it, which is what lets the
   * model actually look at the worker's screen rather than only read about it.
   *
   * @param {{ fresh?: boolean, timeoutMs?: number }} [opts]
   * @returns {Promise<{ localPath: string, width: number, height: number, bytes: number,
   *                     displays: number, capturedAt: string, elapsedMs: number }>}
   */
  async screenshot(opts = {}) {
    if (this.httpBase === '') {
      throw new Error(`PeerConnection(${this.peerId}): no HTTP base derived from the worker URL`)
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('PeerConnection: no fetch implementation available')
    }

    const url = `${this.httpBase}/screenshot${opts.fresh === false ? '' : '?fresh=1'}`
    const controller = new AbortController()
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : 60_000
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    let res
    try {
      res = await this.fetchImpl(url, {
        headers: this.token === '' ? {} : { authorization: `Bearer ${this.token}` },
        signal: controller.signal,
      })
    } catch (error) {
      throw new Error(`worker "${this.peerId}" screenshot request failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }

    if (res.status !== 200) {
      let detail = ''
      try { detail = String(await res.text()).slice(0, 200) } catch { /* body may be empty */ }
      throw new Error(`worker "${this.peerId}" screenshot returned HTTP ${res.status}${detail === '' ? '' : `: ${detail}`}`)
    }

    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) throw new Error(`worker "${this.peerId}" screenshot was empty`)

    mkdirSync(this.shotDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const localPath = join(this.shotDir, `${this.peerId}-${stamp}.png`)
    writeFileSync(localPath, buf)

    // Housekeeping. A worker screenshot is a full-resolution PNG (~9.5 MB measured), so an
    // afternoon of GUI verification fills a disk. This runs AFTER the file is safely written
    // and never throws: failing to delete an older capture must not fail this one. The outcome
    // is reported so the page can show that space was reclaimed.
    const pruned = pruneShots(this.shotDir, this.peerId, this.keepShots, { maxBytes: this.shotCacheBytes })

    const num = (name) => {
      const v = Number(res.headers.get(name))
      return Number.isFinite(v) ? v : 0
    }
    return {
      localPath,
      width: num('x-shot-width'),
      height: num('x-shot-height'),
      bytes: buf.length,
      displays: num('x-shot-displays'),
      capturedAt: res.headers.get('x-shot-captured-at') ?? '',
      elapsedMs: num('x-shot-ms'),
      // Reported rather than silent: an operator who wonders where the disk went should be
      // able to see that the plugin is reclaiming its own files, and how many it kept.
      pruned,
    }
  }

  /**
   * What this worker's screenshots occupy on the HOST, plus what the budget says it should.
   *
   * Kept separate from the relay call below because the two answer different questions: this one
   * describes the copies the page and the model actually read, and the relay's describes the
   * copies sitting on the worker. Both are worth showing -- an operator clearing 218 MB of host
   * cache and finding the worker still full would rightly call the button a lie.
   *
   * @param {{ maxBytes?: number }} [opts]
   */
  hostShotCache(opts = {}) {
    const usage = scanShotUsage(this.shotDir, this.peerId)
    return {
      ...usage,
      dir: this.shotDir,
      keep: this.keepShots,
      maxBytes: Number.isFinite(opts.maxBytes) ? Number(opts.maxBytes) : this.shotCacheBytes,
    }
  }

  /** Apply the budgets now and report what was reclaimed. Never throws. */
  pruneHostShotCache(opts = {}) {
    const maxBytes = Number.isFinite(opts.maxBytes) ? Number(opts.maxBytes) : this.shotCacheBytes
    const pruned = pruneShots(this.shotDir, this.peerId, this.keepShots, { maxBytes })
    return { ...pruned, dir: this.shotDir, maxBytes }
  }

  /** Delete this worker's host-side downloads. Never throws. */
  clearHostShotCache() {
    const cleared = clearShots(this.shotDir, this.peerId)
    return { ...cleared, dir: this.shotDir }
  }

  /**
   * Whether the worker's relay can answer the cache RPC at all.
   *
   * WHY A GETTER RATHER THAN LETTING THE CALLER TEST THE METHOD: the same fact -- "this worker
   * cannot report its cache" -- has to be read the same way by the page's snapshot and by the
   * page's Clear button. When the two decided differently (the snapshot treated it as an optional
   * capability and reported `null`, while the action path called the method blindly and turned the
   * TypeError into a 502) a worker whose relay predates this feature looked healthy on load and
   * broken when the operator clicked. One question, one answer.
   *
   * A relay that is older than this feature is a HEALTHY worker with a missing report, not a
   * failure: the link works, the captures work, only the enquiry is unavailable.
   */
  get supportsWorkerShotCache() {
    return this.connected && typeof this.bridge?.callPlugin === 'function'
  }

  /**
   * Ask the worker what ITS screenshot directory occupies, and optionally make it clean up.
   *
   * WHY IT GOES OVER THE RELAY RATHER THAN HTTP: the numbers are a handful of integers and they
   * ride the JSON-RPC channel the plugin already owns, so this needs no new endpoint, no new
   * authorization path, and no second thing to keep authenticated.
   *
   * A worker running a relay older than this feature answers "unknown method" -- which is NOT an
   * error worth showing as a failure, because the link is fine and only the report is missing.
   * The two cases are distinguished by `supported`, so the page can say "the worker does not
   * report its cache" instead of reddening a healthy card. `ensure()` is deliberately skipped for
   * the report path by the caller so a page load never waits on a connect it did not need.
   *
   * @param {{ maxBytes?: number, prune?: boolean, clear?: boolean }} [opts]
   * @returns {Promise<{ supported: boolean, error: string, files: number, bytes: number,
   *                     newestAt: number, oldestAt: number, keep: number, maxBytes: number,
   *                     dir: string, pruned: object | null }>}
   */
  async workerShotCache(opts = {}) {
    const unsupported = {
      supported: false, error: '', files: 0, bytes: 0, newestAt: 0, oldestAt: 0,
      keep: 0, maxBytes: 0, dir: '', pruned: null,
    }
    if (!this.connected || typeof this.bridge?.callPlugin !== 'function') {
      return { ...unsupported, error: 'not connected' }
    }
    const params = {}
    if (Number.isFinite(opts.maxBytes)) params.maxBytes = Number(opts.maxBytes)
    if (opts.prune === true) params.prune = true
    if (opts.clear === true) params.clear = true
    try {
      const result = await this.bridge.callPlugin('dsh-remote/shotcache', params)
      return {
        supported: true,
        error: '',
        files: Number(result?.files ?? 0),
        bytes: Number(result?.bytes ?? 0),
        newestAt: Number(result?.newestAt ?? 0),
        oldestAt: Number(result?.oldestAt ?? 0),
        keep: Number(result?.keepShots ?? 0),
        maxBytes: Number(result?.maxBytes ?? 0),
        dir: String(result?.dir ?? ''),
        pruned: result?.pruned ?? null,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // -32601 is JSON-RPC "method not found": an older worker, not a broken one.
      const unknownMethod = /-32601|unknown plugin method|method not found/i.test(message)
      // An unknown method is a property of the worker, not of the link, so the link is kept.
      if (!unknownMethod) await this.#invalidateIfTransportError(error)
      return { ...unsupported, error: unknownMethod ? '' : message }
    }
  }

  /** Tear down the connection. Idempotent. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.#stopHeartbeat()
    const bridge = this.bridge
    this.bridge = undefined
    if (bridge === undefined) return
    try {
      await bridge.dispose()
    } catch (error) {
      this.log('warn', `dispose of "${this.peerId}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // -------------------------------------------------------------------------
  // liveness
  // -------------------------------------------------------------------------

  /**
   * Probe the link periodically so a socket that died silently is noticed BETWEEN calls
   * rather than by a user-facing failure.
   *
   * The relay answers `dsh-remote/ping` from its own event loop, so this costs the worker's
   * agent nothing and gives a definitive alive/dead answer.
   */
  #startHeartbeat() {
    this.#stopHeartbeat()
    if (this.heartbeatMs <= 0 || this.disposed) return
    this.heartbeatTimer = setInterval(() => { void this.#beat() }, this.heartbeatMs)
    // Never hold the process open just for a liveness probe.
    if (typeof this.heartbeatTimer?.unref === 'function') this.heartbeatTimer.unref()
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  async #beat() {
    if (this.disposed || !this.connected || this.heartbeatBeating) return
    if (typeof this.bridge?.callPlugin !== 'function') return
    this.heartbeatBeating = true
    try {
      await this.bridge.callPlugin('dsh-remote/ping', {}, { timeoutMs: this.heartbeatTimeoutMs })
      this.heartbeats += 1
      this.lastHeartbeatAt = this.now()
    } catch (error) {
      this.heartbeatFailures += 1
      const message = error instanceof Error ? error.message : String(error)
      this.log('warn', `worker "${this.peerId}" heartbeat failed (${message}); treating the link as dead`)
      // A failed liveness probe IS evidence the link is gone, so this deliberately does not
      // go through the message-matching in #invalidateIfTransportError.
      await this.#discardLink()
    } finally {
      this.heartbeatBeating = false
    }
  }

  /** Throw away the current bridge so the next `ensure()` builds a fresh one. */
  async #discardLink() {
    this.#stopHeartbeat()
    const dead = this.bridge
    this.bridge = undefined
    if (dead === undefined) return
    try { await dead.dispose() } catch { /* the socket is already gone */ }
  }

  /**
   * Drop a connection that is no longer usable, so the next `ensure()` rebuilds it.
   *
   * Only transport-level failures count. A JSON-RPC error from a healthy session (a
   * failing tool, a refused approval) must NOT tear the link down, or one bad task would
   * force a reconnect on every subsequent call.
   */
  async #invalidateIfTransportError(error) {
    if (!this.connected) return
    const message = error instanceof Error ? error.message : String(error)
    const transportish = /not connected|connection closed|EPIPE|ECONNRESET|ECONNREFUSED|ECONNABORTED|socket|websocket|network|hang ?up/i.test(message)
    if (!transportish) return

    this.log('warn', `worker "${this.peerId}" link is no longer usable (${message}); discarding it so the next call reconnects`)
    await this.#discardLink()
  }
}
