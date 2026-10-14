/**
 * The worker-role listener, as a supervised child process.
 *
 * WHY IT SUPERVISES `slave/relay.mjs` RATHER THAN REIMPLEMENTING IT: the relay already speaks
 * the worker's whole surface -- the `dsh-remote/*` RPCs, the ACP pump, `/screenshot`, `/healthz`,
 * screenshot retention, pairing-string generation -- and it is validated end to end against the
 * reference worker. A second implementation inside the plugin would be a second thing to keep
 * correct, and the two would drift exactly where it matters (authentication, the permission
 * bridge, cancellation).
 *
 * WHY IT KEEPS NO POLICY: which address, which port, which token, and whether arming is allowed
 * at all belong to `worker-arming.js`. This class starts what it is told and reports what
 * happened, so the security decisions have one home.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** How much of the relay's output is kept for diagnosis. Enough to see a crash, not a log file. */
const OUTPUT_LIMIT = 8 * 1024

const HERE = dirname(fileURLToPath(import.meta.url))

/** `slave/` ships next to `lib/`, so the relay is addressed relative to this module. */
export function relayPath() {
  return join(HERE, '..', '..', 'slave', 'relay.mjs')
}

export class RelaySupervisor {
  /**
   * @param {object} deps
   * @param {(file: string, args: string[], opts: object) => object} [deps.spawn] injected for tests
   * @param {() => object} [deps.launchSpec] the ACP agent spec to hand the relay
   * @param {string} [deps.relay] override the relay path
   * @param {{ info?: Function, warn?: Function, error?: Function }} [deps.log]
   * @param {() => number} [deps.now]
   */
  constructor(deps = {}) {
    this.spawn = deps.spawn ?? spawn
    this.launchSpec = deps.launchSpec ?? (() => ({ ok: false, error: 'no launch spec resolver injected' }))
    this.relay = deps.relay ?? relayPath()
    // The ACP spec file goes in the system temp directory: it carries an argv env, not a secret,
    // and it must not be written next to the operator's plugin install.
    this.tempDir = deps.tempDir ?? join(tmpdir(), 'dsh-plugin-remote-use')
    // How many captures the worker keeps. Read at start time rather than captured once, so a
    // change on the settings page applies to the next arming instead of the next DSH restart.
    this.keepShots = deps.keepShots ?? (() => 20)
    // A per-installation directory under the OS temp root, NOT the package. A capture is a
    // transient full-resolution PNG that is pruned on a budget, so temp is where it belongs;
    // what matters is that it is outside the plugin.
    this.shotDir = deps.shotDir ?? join(tmpdir(), 'dsh-plugin-remote-use', 'shots')
    this.specFile = ''
    const log = deps.log ?? {}
    this.log = { info: log.info ?? (() => {}), warn: log.warn ?? (() => {}), error: log.error ?? (() => {}) }
    this.now = deps.now ?? (() => Date.now())

    this.child = undefined
    this.pid = 0
    this.startedAt = 0
    this.bind = ''
    this.port = 0
    this.output = ''
    this.lastError = ''
    this.exited = undefined
  }

  /** True while a listener is believed to be running. */
  get running() {
    return this.child !== undefined && this.exited === undefined
  }

  /**
   * Start the listener. Throws on anything that would leave the caller believing a port is open
   * when it is not -- `WorkerArming` turns a throw into a refusal to arm.
   *
   * @param {string} bindAddress
   * @param {number} port
   * @param {string} token
   */
  start(bindAddress, port, token) {
    if (this.running) throw new Error(`the listener is already running on ${this.bind}:${this.port}`)
    if (!existsSync(this.relay)) throw new Error(`the relay is missing at ${this.relay}`)

    const spec = this.launchSpec()
    if (spec?.ok !== true) throw new Error(`cannot launch this machine's ACP agent: ${spec?.error ?? 'unknown'}`)

    // The relay is handed the ACP agent as a SPEC FILE, not as a command line. That is the
    // relay's own designed path (`--cmd-file`) and it exists for the same reason this module
    // builds an argv array: the install directory contains a space, and every attempt to pass
    // it as a string has been split somewhere along the way -- once already, as
    // `Cannot find module 'C:\Users\<user>\AppData\Local\Programs\DeepSeek'`.
    const specFile = join(this.tempDir, `acp-spec-${process.pid}-${port}.json`)
    try {
      mkdirSync(this.tempDir, { recursive: true })
      writeFileSync(specFile, JSON.stringify({
        command: spec.spec.command,
        args: spec.spec.args,
        env: spec.spec.env,
      }), 'utf8')
    } catch (error) {
      throw new Error(`could not write the ACP launch spec: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.specFile = specFile

    const args = [
      this.relay,
      '--host', bindAddress,
      '--port', String(port),
      '--token', token,
      '--advertise-host', bindAddress,
      '--cmd-file', specFile,
      // The plugin starts the relay from inside its own directory, so the relay must not write
      // its pairing file next to itself: an installed plugin would modify its installation, and
      // on a link: install that is the operator's source checkout. The master gets the pairing
      // string from the RPC instead. Caught by running the supervised listener and looking at
      // the repository.
      '--pairing-file', '',
      // A capture is a full-resolution PNG (~9.5 MB measured). Without this the worker kept
      // every one of them, and the page's setting would only govern the HOST side -- the
      // larger of the two accumulations would be the one the operator could not control.
      '--keep-shots', String(this.keepShots()),
      // Where the captures go. WITHOUT THIS the relay uses `join(HERE, 'shots')` -- HERE being the
      // relay script's own directory, i.e. the plugin's INSTALLATION. On a `link:` install that is
      // the operator's source checkout, and on a real install it is a directory the plugin has no
      // business growing. Same defect as the `--pairing-file` one above, found the same way -- by
      // running the supervised listener and looking at the tree -- because the capture path had
      // never actually been exercised on this machine until it was.
      '--shot-dir', this.shotDir,
    ]

    const child = this.spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...spec.spec.env },
    })

    this.child = child
    this.pid = child.pid ?? 0
    this.startedAt = this.now()
    this.bind = bindAddress
    this.port = port
    this.output = ''
    this.lastError = ''
    this.exited = undefined

    const collect = (chunk) => {
      this.output += String(chunk)
      if (this.output.length > OUTPUT_LIMIT) this.output = this.output.slice(-OUTPUT_LIMIT)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('exit', (code, signal) => {
      this.exited = { code, signal, at: this.now() }
      // Report it: a listener that died is the difference between "armed" and "reachable", and
      // the page must not keep claiming the first while the second is false.
      if (code !== 0 && code !== null) this.log.warn(`the worker listener exited with code ${code}`)
      this.child = undefined
    })

    this.log.info(`worker listener started on ${bindAddress}:${port} (pid ${this.pid})`)
    return { pid: this.pid }
  }

  /** Stop the listener. Idempotent, and never throws. */
  stop() {
    const child = this.child
    this.child = undefined
    if (child === undefined) {
      this.#discardSpec()
      this.pid = 0
      return { stopped: false }
    }
    try {
      child.kill()
    } catch (error) {
      this.lastError = `could not stop the listener: ${error instanceof Error ? error.message : String(error)}`
      this.log.warn(this.lastError)
    }
    this.#discardSpec()
    this.pid = 0
    return { stopped: true }
  }

  /** What the page shows. */
  status() {
    return {
      running: this.running,
      pid: this.pid,
      bindAddress: this.bind,
      port: this.port,
      startedAt: this.startedAt,
      uptimeMs: this.running && this.startedAt > 0 ? Math.max(0, this.now() - this.startedAt) : 0,
      exited: this.exited ?? null,
      lastError: this.lastError,
      // The tail only: enough to see why it died, not a log relay.
      output: this.output.slice(-2000),
    }
  }

  /** The spec file is transient: leaving it behind would accumulate one per start. */
  #discardSpec() {
    if (this.specFile === '') return
    const file = this.specFile
    this.specFile = ''
    try {
      rmSync(file, { force: true })
    } catch { /* best effort: a leftover spec file is untidy, not dangerous */ }
  }
}