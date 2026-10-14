/**
 * Best-effort desktop notification: "an approval is waiting for you".
 *
 * WHY THIS EXISTS: the approval queue holds a worker still until a person answers, and measured
 * on 2026-10-14 the operator had never seen a single prompt -- six requests expired unanswered
 * while the only sign of them was a row on a settings page nobody had open. The page now polls,
 * and the model is told in its runtime context, but both of those need the operator to be LOOKING
 * at the harness. A notification is what reaches someone who is not.
 *
 * WHY IT REUSES @hope_phenom/dsh-plugin-notify RATHER THAN ROLLING ITS OWN: that plugin already
 * carries the platform plumbing (Shell_NotifyIcon balloon, WinRT toast fallback, python/custom
 * channels) and its own settings. Importing its CODE would couple us to its internals and its
 * version; invoking its bundled script is a file-level contract that survives it being updated,
 * and disappears cleanly when the plugin is not installed.
 *
 * WHY IT CANNOT BREAK ANYTHING: every failure path returns false. A missing plugin, a missing
 * interpreter, a policy that blocks PowerShell -- none of them may turn into a failed approval,
 * because this runs on the approval path. Failures are logged once per kind, not per request.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** The sibling plugin whose bundled notifier we borrow. */
export const NOTIFY_PACKAGE = '@hope_phenom/dsh-plugin-notify'

/** Interpreters tried in order. `pwsh` first, because the bundled script prefers it. */
const DEFAULT_INTERPRETERS = ['pwsh', 'powershell']

/** How long a notification child may live before we stop caring about it. */
const DEFAULT_TIMEOUT_MS = 8_000

/**
 * Absolute path of the sibling plugin's bundled notifier, or '' when it is not installed.
 *
 * Resolution walks up from THIS module, so it finds the copy installed beside us in the same
 * profile's `node_modules`. A bare `import` of the package would instead require a declared
 * dependency, which would make an optional integration mandatory.
 *
 * @param {object} [opts]
 * @param {(id: string) => string} [opts.resolve] module resolver, injectable for tests
 * @param {(path: string) => boolean} [opts.exists] existence check, injectable for tests
 * @returns {string}
 */
export function resolveNotifyScript(opts = {}) {
  const exists = opts.exists ?? existsSync
  let resolve = opts.resolve
  if (resolve === undefined) {
    try {
      const require = createRequire(import.meta.url)
      resolve = (id) => require.resolve(id)
    } catch {
      return ''
    }
  }
  try {
    const manifest = resolve(`${NOTIFY_PACKAGE}/package.json`)
    const script = join(dirname(manifest), 'scripts', 'notify.ps1')
    return exists(script) ? script : ''
  } catch {
    // Not installed, or its exports map hides the manifest: a silent no-op by design.
    return ''
  }
}

/**
 * Fire one notification and forget about it.
 *
 * Never throws and never awaits the child: the caller is holding an approval request open, and a
 * notification must not add latency to it. Success means "handed to an interpreter", not
 * "displayed" -- the bundled script reports display failures on its own stderr, which we discard.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {string} [opts.script] notifier path; resolved on demand when omitted
 * @param {string[]} [opts.interpreters]
 * @param {(level: string, message: string) => void} [opts.log]
 * @param {typeof spawn} [opts.spawnFn] injectable so tests never launch a process
 * @returns {boolean} whether an interpreter was started
 */
export function notifyDesktop(opts) {
  // The plugin's logger is an OBJECT with `.info`/`.warn` (see `index.js`), so this module accepts
  // the same shape rather than inventing a second convention. A missing logger is a no-op.
  const { info, warn } = methods(opts?.log)
  const spawnFn = opts?.spawnFn ?? spawn
  const script = typeof opts?.script === 'string' && opts.script !== '' ? opts.script : resolveNotifyScript(opts)
  if (script === '') return false

  const interpreters = Array.isArray(opts?.interpreters) && opts.interpreters.length > 0
    ? opts.interpreters
    : DEFAULT_INTERPRETERS
  const timeoutMs = Number.isFinite(opts?.timeoutMs) ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS
  const argv = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-Title', String(opts?.title ?? 'DSH'),
    '-Message', String(opts?.message ?? ''),
    // `Kind`/`Event` are the sibling plugin's own vocabulary; `approval-waiting` is not one of
    // its turn-end events, so its message templates fall through to the literal text we pass.
    '-Kind', 'approval',
    '-Event', 'approval-waiting',
    '-DurationMs', '10000',
  ]

  /**
   * A missing interpreter reports ENOENT through the `error` EVENT, not through `spawn`, so the
   * fallback cannot be a `for` loop with a flag: by the time the event fires the loop is long
   * gone. Each attempt hands the next interpreter to the event handler instead.
   */
  const attempt = (index) => {
    if (index >= interpreters.length) return false
    const interpreter = interpreters[index]
    let child
    try {
      child = spawnFn(interpreter, argv, { stdio: 'ignore', windowsHide: true })
    } catch (error) {
      warn(`desktop notification via ${interpreter} could not start: ${describe(error)}`)
      return attempt(index + 1)
    }

    let settled = false
    const timer = timeoutMs > 0
      ? setTimeout(() => { settled = true; kill(child) }, timeoutMs)
      : undefined
    if (typeof timer?.unref === 'function') timer.unref()
    const finish = () => { settled = true; if (timer !== undefined) clearTimeout(timer) }

    if (typeof child?.once === 'function') {
      child.once('error', (error) => {
        if (settled) return
        finish()
        warn(`desktop notification via ${interpreter} failed: ${describe(error)}`)
        attempt(index + 1)
      })
      child.once('exit', finish)
    }
    if (typeof child?.unref === 'function') child.unref()

    info(`approval notification handed to ${interpreter} (${script})`)
    return true
  }

  return attempt(0)
}

/** @param {unknown} child */
function kill(child) {
  try {
    child?.kill()
  } catch { /* already gone */ }
}

/** @param {unknown} error */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Pull `info`/`warn` off a logger object, tolerating a missing or partial one.
 * @param {unknown} log
 */
function methods(log) {
  const source = log !== null && typeof log === 'object' ? log : {}
  return {
    info: typeof source.info === 'function' ? source.info.bind(source) : () => {},
    warn: typeof source.warn === 'function' ? source.warn.bind(source) : () => {},
  }
}

export { DEFAULT_INTERPRETERS, DEFAULT_TIMEOUT_MS, methods as loggerMethods }
