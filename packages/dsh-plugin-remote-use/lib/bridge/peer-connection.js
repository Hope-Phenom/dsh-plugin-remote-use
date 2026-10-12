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

export class PeerConnection {
  /**
   * @param {object} opts
   * @param {string} opts.peerId
   * @param {() => object} opts.createBridge  builds a fresh, unconnected bridge
   * @param {(level: 'info'|'warn'|'error', message: string) => void} [opts.log]
   * @param {() => number} [opts.now]
   */
  constructor(opts) {
    this.peerId = opts.peerId
    this.createBridge = opts.createBridge
    this.log = opts.log ?? (() => {})
    this.now = opts.now ?? (() => Date.now())

    /** @type {object | undefined} */
    this.bridge = undefined
    /** @type {Promise<void> | undefined} in-flight connect, shared by concurrent callers */
    this.connecting = undefined
    this.connects = 0
    this.connectFailures = 0
    this.lastError = ''
    this.lastConnectedAt = 0
    this.disposed = false
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
  async cancel() {
    if (!this.connected) {
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

  /** Tear down the connection. Idempotent. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    const bridge = this.bridge
    this.bridge = undefined
    if (bridge === undefined) return
    try {
      await bridge.dispose()
    } catch (error) {
      this.log('warn', `dispose of "${this.peerId}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
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
    const dead = this.bridge
    this.bridge = undefined
    try { await dead?.dispose() } catch { /* the socket is already gone */ }
  }
}
