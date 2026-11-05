// workspace-integrity.mjs -- clear the stale Low mandatory label a full-access workspace inherits.
//
// WHY THIS IS NEEDED, measured on a real Windows worker (2026-10-19):
//
// DSH's `workspace-write` sandbox does not only lower the child token to Low integrity
// (S-1-16-4096). It also writes an inheritable Low mandatory label onto the workspace directory and
// its temp root. Anything copied into that tree inherits the label -- and Windows launches an image
// carrying a Low label at Low integrity even when the parent token is High. The result is a GUI
// application that cannot write `%LOCALAPPDATA%` (Medium) while the agent shell around it can:
//
//   pwsh (agent shell)                                  -> High
//   Start-Process C:\Windows\System32\whoami.exe        -> High
//   copy of whoami.exe under the workspace              -> Low
//
// The label outlives the session that added it, so switching the worker to `danger-full-access`
// does not undo it: the stale label keeps downgrading every app in the workspace. Under full access
// the confinement has been deliberately turned off, so the Low label is not protecting anything --
// it is a leftover, and it actively breaks the GUI workflow that full access exists to enable.
//
// THE REPAIR IS DELIBERATELY NARROW:
//   * only on Windows;
//   * only when the effective mode is `danger-full-access` (a workspace-write worker MUST keep its
//     Low label -- that label is what confines it);
//   * only for an explicit task directory (`--task-dir`), or when `--repair-integrity` asks for the
//     relay's inherited cwd;
//   * never for a drive root, the Windows/Program Files/ProgramData trees, or the user profile root.
//
// `icacls /T` is recursive because changing only the top directory leaves nested directories and
// the executables already inside them at Low (measured: a parent relabel updates a direct child but
// not a file two levels down). It is idempotent and only runs once per relay start.

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, parse, resolve } from 'node:path'

/** Every environment variable that names a directory this module must never relabel. */
const PROTECTED_ROOTS = ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData']

/** Case-insensitive comparison form for a Windows path, without a trailing separator. */
export function normalizePath(path) {
  if (typeof path !== 'string' || path.trim() === '') return ''
  return resolve(path).replace(/[\\/]+$/u, '').toLowerCase()
}

/**
 * Whether `path` is a system location whose mandatory label must not be touched.
 *
 * A worker whose relay inherited `C:\Windows\System32` as its cwd (a scheduled task with no
 * explicit working directory) would otherwise have its whole System32 tree relabeled on startup.
 * That is far worse than the problem being fixed, so the guard errs toward refusing.
 *
 * @param {string} path
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isProtectedWorkspace(path, env = process.env) {
  const target = normalizePath(path)
  if (target === '') return true
  // A drive root ("c:\\") or a UNC share root is not a workspace.
  if (target === normalizePath(parse(resolve(path)).root)) return true
  for (const name of PROTECTED_ROOTS) {
    const base = env[name]
    if (typeof base !== 'string' || base.trim() === '') continue
    const root = normalizePath(base)
    if (target === root || target.startsWith(`${root}\\`)) return true
  }
  // The user profile root itself is not a workspace either; `C:\Users\<name>\work` is fine.
  const profile = env.USERPROFILE
  if (typeof profile === 'string' && profile.trim() !== '' && target === normalizePath(profile)) return true
  return false
}

/**
 * Relabel one workspace tree from Low to Medium, when full access makes that the correct state.
 *
 * @param {object} [deps]
 * @param {string} [deps.mode]        the EFFECTIVE session mode the relay will spawn
 * @param {string} [deps.dir]         the task directory
 * @param {boolean} [deps.declared]   true when `--task-dir` named it explicitly
 * @param {boolean} [deps.force]      `--repair-integrity`: allow the inherited cwd too
 * @param {number} [deps.timeoutMs]   bound on the recursive pass
 * @param {(file: string, args: string[], opts: object) => object} [deps.spawn] injected for tests
 * @returns {{ applied: boolean, skipped: boolean, reason: string, error: string,
 *             dir: string, durationMs: number, timedOut: boolean }}
 */
export function repairWorkspaceIntegrity(deps = {}) {
  const started = Date.now()
  const result = (fields) => ({
    applied: false,
    skipped: true,
    reason: '',
    error: '',
    dir: '',
    durationMs: Date.now() - started,
    timedOut: false,
    ...fields,
  })

  if (process.platform !== 'win32') return result({ reason: 'mandatory labels are a Windows concept' })

  const mode = String(deps.mode ?? '')
  if (mode !== 'danger-full-access') {
    return result({ reason: `effective mode is ${mode === '' ? 'not set' : mode}; a confined workspace must keep its Low label` })
  }

  const dir = typeof deps.dir === 'string' ? deps.dir.trim() : ''
  if (dir === '') return result({ reason: 'no task directory to repair' })
  if (deps.declared !== true && deps.force !== true) {
    return result({ reason: 'the task directory was inherited, not named with --task-dir (pass --repair-integrity to allow it)' })
  }
  if (!existsSync(dir)) return result({ reason: `task directory does not exist: ${dir}` })
  try {
    if (!statSync(dir).isDirectory()) return result({ reason: `task directory is not a directory: ${dir}` })
  } catch (error) {
    return result({ reason: `cannot inspect ${dir}: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (isProtectedWorkspace(dir)) {
    return result({ reason: `refusing to relabel a protected system location: ${dir}` })
  }

  const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
  const executable = existsSync(icacls) ? icacls : 'icacls.exe'
  const args = [dir, '/setintegritylevel', '(OI)(CI)Medium', '/T', '/C', '/Q']
  const run = (deps.spawn ?? spawnSync)(executable, args, {
    encoding: 'utf8',
    timeout: deps.timeoutMs ?? 60_000,
    windowsHide: true,
  })

  const timedOut = run?.error?.code === 'ETIMEDOUT'
  if (run?.error !== undefined && run.error !== null && !timedOut) {
    return result({
      dir,
      reason: 'icacls could not run',
      error: run.error instanceof Error ? run.error.message : String(run.error),
      timedOut,
    })
  }
  if (!timedOut && run?.status !== 0) {
    return result({
      dir,
      reason: 'icacls refused',
      error: String(run?.stderr ?? '').trim().slice(0, 400) || `exit ${String(run?.status)}`,
      timedOut,
    })
  }

  return result({
    applied: true,
    skipped: false,
    dir,
    timedOut,
    reason: timedOut
      ? 'the recursive relabel hit its time limit; part of the tree may still be Low'
      : 'workspace relabeled to Medium because this session runs at danger-full-access',
  })
}
