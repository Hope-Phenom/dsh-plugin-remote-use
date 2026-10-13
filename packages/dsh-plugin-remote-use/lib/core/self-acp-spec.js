/**
 * How to launch THIS machine's own ACP agent.
 *
 * WHY AN ARGV ARRAY AND NOT A COMMAND LINE: two quoting hazards sit on this path, and both have
 * already cost time in this project.
 *
 *   * The install directory contains a space (`...\Programs\DeepSeek Harness`). Building a
 *     command line and handing it to `Start-Process -ArgumentList` split it, and node reported
 *     `Cannot find module 'C:\Users\you\AppData\Local\Programs\DeepSeek'` -- an error that points
 *     at the module system while the actual fault is a missing quote.
 *   * `dsh.cmd` is a shim, and Node refuses to spawn a `.cmd` without a shell (EINVAL); asking
 *     `cmd /c` to run it loses quotes through the PowerShell -> node hand-off.
 *
 * So the shim is replicated exactly, as an array, and `dsh.cmd` is never launched.
 *
 * WHY cli.js IS NOT CHECKED FOR EXISTENCE: it lives INSIDE `app.asar`, which Electron can read
 * and the filesystem API cannot. An existence test would report false and reject a perfectly
 * good install. Only the executable is tested; the argv path is constructed.
 */

import { existsSync } from 'node:fs'

/** Where DSH installs by default on Windows, best candidate first. */
export function installCandidates(env = process.env) {
  return [
    env.DSH_INSTALL_DIR,
    env.LOCALAPPDATA === undefined ? undefined : `${env.LOCALAPPDATA}\\Programs\\DeepSeek Harness`,
    'C:\\Program Files\\DeepSeek Harness',
    'C:\\Program Files (x86)\\DeepSeek Harness',
  ].filter((p) => typeof p === 'string' && p !== '')
}

/**
 * The argv and environment for one ACP agent process.
 *
 * @param {object} opts
 * @param {string} opts.installDir
 * @param {string} [opts.profile]  the DSH profile the worker runs under
 * @param {string} [opts.permissionMode]  overrides the sandbox/approval preset for the child
 * @returns {{ command: string, args: string[], env: Record<string, string> }}
 */
export function acpLaunchSpec(opts) {
  const installDir = String(opts.installDir ?? '').replace(/[\\/]+$/u, '')
  if (installDir === '') throw new Error('acpLaunchSpec: no install directory')
  const profile = String(opts.profile ?? 'acp')
  if (!/^[\w.-]+$/u.test(profile)) throw new Error(`acpLaunchSpec: profile "${profile}" is not a plain profile name`)
  return {
    command: `${installDir}\\DeepSeek Harness.exe`,
    args: [
      '--expose-internals',
      `${installDir}\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js`,
      '--profile',
      profile,
    ],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ...(typeof opts.permissionMode === 'string' && opts.permissionMode !== ''
        ? { DSH_PERMISSION_MODE: opts.permissionMode }
        : {}),
    },
  }
}

/**
 * Resolve the spec against a real machine.
 *
 * @param {object} [deps]
 * @param {(path: string) => boolean} [deps.exists]
 * @param {Record<string, string | undefined>} [deps.env]
 * @param {string} [deps.installDir] explicit override, tried first
 * @returns {{ ok: true, spec: object, installDir: string } | { ok: false, error: string, tried: string[] }}
 */
export function resolveAcpLaunchSpec(deps = {}) {
  const exists = deps.exists ?? existsSync
  const env = deps.env ?? process.env
  const candidates = [deps.installDir, ...installCandidates(env)].filter((p) => typeof p === 'string' && p !== '')
  for (const candidate of candidates) {
    if (!exists(`${candidate}\\DeepSeek Harness.exe`)) continue
    try {
      const spec = acpLaunchSpec({ installDir: candidate, profile: deps.profile, permissionMode: deps.permissionMode })
      return { ok: true, spec, installDir: candidate }
    } catch (error) {
      return { ok: false, error: error.message, tried: candidates }
    }
  }
  return {
    ok: false,
    error: 'could not find "DeepSeek Harness.exe"; pass the install directory explicitly',
    tried: candidates,
  }
}
