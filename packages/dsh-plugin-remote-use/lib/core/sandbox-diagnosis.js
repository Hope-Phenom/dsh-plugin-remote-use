/**
 * What this machine is missing before it can be armed as a worker -- and the exact fix.
 *
 * WHY THIS IS READ-ONLY, AND WHY THAT IS THE WHOLE DESIGN.
 *
 * The arming gate refuses a machine whose sandbox cannot be proven. Proving it needs a
 * `sandbox` entry in the ACP profile that names a materialized mediator; neither is something
 * DSH ships, and the profile is created lazily, so a factory-fresh worker has neither. The
 * previous answer was a paragraph of documentation, and it rotted silently: measured
 * 2026-11-04 on the development machine, BOTH mediator directories were gone while the page
 * kept saying nothing at all, because the probe only runs when somebody clicks "check".
 *
 * The tempting fix is to materialize the mediator and write the profile from the gate. That
 * would let a page visit mutate the operator's environment -- writing outside the plugin's own
 * state (`%DSH_HOME%\profiles\acp`, a mediator directory at a machine path), which is the kind
 * of silent action this plugin spends most of its comments avoiding. Worse, it would take over
 * "which DSH build is this mediator for", a question this plugin cannot answer better than the
 * probe can.
 *
 * So the gate stays a gate, and this module answers a different question: WHAT EXACTLY IS
 * MISSING, AND WHAT IS THE ONE COMMAND THAT FIXES IT. The command is executed by a person or by
 * an agent they point at it (`lib/tools/prepare-sandbox-mediator.mjs`), and the probe below is
 * still what decides whether arming is allowed. Nothing here writes, spawns, or caches.
 */
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { installCandidates } from './self-acp-spec.js'
import { shimNamedByProfile, subsystemOf } from './sandbox-probe.js'
import { resolveDshHome } from './settings-store.js'

/** Profile the worker role launches (`dsh --profile acp`). */
export const WORKER_PROFILE = 'acp'

/** Where the mediator goes when the profile does not already name one. */
export const DEFAULT_MEDIATOR_LEAF = 'sandbox-mediator'

/** @param {string} home */
export function acpProfilePath(home) {
  return join(home, 'profiles', WORKER_PROFILE, 'cordis.patch.yml')
}

/** The shipped fixer, addressed absolutely so a prompt can be pasted anywhere. */
export function prepareScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'prepare-sandbox-mediator.mjs')
}

/**
 * The DSH installation this process belongs to.
 *
 * `process.execPath` is tried FIRST because it is the one fact that cannot be stale: the running
 * host IS the installation the worker will spawn. The environment candidates are the fallback for
 * a process started some other way (a test runner, `node tools/...`).
 */
export function resolveInstallDir(deps = {}) {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const execPath = deps.execPath ?? process.execPath
  const exe = 'DeepSeek Harness.exe'
  const fromExec = typeof execPath === 'string' && basename(execPath).toLowerCase() === exe.toLowerCase()
    ? dirname(execPath)
    : ''
  const candidates = [fromExec, env.DSH_INSTALL_DIR, ...installCandidates(env)]
  const seen = new Set()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (exists(join(candidate, exe))) return candidate
  }
  return ''
}

/**
 * A CONSOLE-subsystem node.exe, which is the entire point of the mediator.
 *
 * A GUI-subsystem image (`DeepSeek Harness.exe`, PE subsystem 2) never gets a console, and the
 * restricted child it creates dies during DLL initialization -- every shell command fails with no
 * output. So a candidate whose PE subsystem is not 3 is skipped rather than used: picking it would
 * reproduce the defect while looking configured.
 */
export function resolveNodeExe(deps = {}) {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const subsystem = deps.subsystem ?? subsystemOf
  const execPath = deps.execPath ?? process.execPath
  const installDir = deps.installDir ?? ''
  const candidates = []
  if (typeof env.DSH_NODE_EXE === 'string' && env.DSH_NODE_EXE !== '') candidates.push(env.DSH_NODE_EXE)
  if (installDir !== '') {
    candidates.push(join(installDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'))
  }
  candidates.push(join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'))
  if (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA !== '') {
    candidates.push(join(env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'))
  }
  if (typeof execPath === 'string' && /^node(?:\.exe)?$/iu.test(basename(execPath))) candidates.push(execPath)
  for (const dir of String(env.PATH ?? env.Path ?? '').split(';')) {
    const trimmed = dir.trim()
    if (trimmed !== '') candidates.push(join(trimmed, 'node.exe'))
  }
  const seen = new Set()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (!exists(candidate)) continue
    if (subsystem(candidate) !== 3) continue
    return candidate
  }
  return ''
}

/**
 * Read-only answer to "is the sandbox mediator ready on this machine, and if not, why".
 *
 * `ready` means MATERIALIZED, not PROVEN: the profile names a shim that exists next to a runner.
 * Whether it actually confines is `probeSandbox`'s question, and the two must stay separate --
 * conflating them is how "the files are there" would read as "the sandbox works".
 *
 * States:
 *   ready        -- materialized and named by the profile; the probe still has the final say
 *   missing      -- the profile names a mediator (or the default path is in use) and it is absent
 *   unwired      -- the mediator may exist, but the profile does not name a usable sandbox runner
 *   unsupported  -- this host/platform/installation cannot have one (nothing to prescribe but the reason)
 *
 * @param {object} [deps]
 * @param {Record<string, string | undefined>} [deps.env]
 * @param {string} [deps.home]       DSH home; defaults to DSH_HOME or ~/.dsh
 * @param {string} [deps.profilePath]
 * @param {string} [deps.installDir]
 * @param {string} [deps.nodeExe]
 * @param {string} [deps.platform]
 * @param {(path: string) => boolean} [deps.exists]
 * @param {(path: string) => number} [deps.subsystem]
 * @returns {{ state: string, ready: boolean, reason: string, home: string, profilePath: string,
 *             profileNamesShim: boolean, profileReason: string, mediatorDir: string, shim: string,
 *             runner: string, nodeExe: string, installDir: string, platform: string }}
 */
export function inspectSandbox(deps = {}) {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const platform = deps.platform ?? process.platform
  const home = deps.home ?? resolveDshHome(env)
  const profilePath = deps.profilePath ?? acpProfilePath(home)
  const installDir = deps.installDir ?? resolveInstallDir({ env, exists, execPath: deps.execPath })
  const nodeExe = deps.nodeExe ?? resolveNodeExe({
    env, exists, execPath: deps.execPath, installDir, subsystem: deps.subsystem,
  })
  const named = deps.named ?? shimNamedByProfile(profilePath)
  const namedShim = named.ok === true ? String(named.shim ?? '') : ''
  const mediatorDir = namedShim !== '' ? dirname(namedShim) : join(home, DEFAULT_MEDIATOR_LEAF)
  const shim = namedShim !== '' ? namedShim : join(mediatorDir, 'shim.mjs')
  const runner = join(mediatorDir, 'node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'runner.js')
  const materialized = exists(shim) && exists(runner)

  let state = 'ready'
  let reason = ''
  if (platform !== 'win32') {
    state = 'unsupported'
    reason = `the sandbox mediator is a Windows mechanism and this host is ${platform}`
  } else if (installDir === '') {
    state = 'unsupported'
    reason = 'could not find "DeepSeek Harness.exe"; pass --install with the installation directory'
  } else if (nodeExe === '') {
    state = 'unsupported'
    reason = 'could not find a console-subsystem node.exe (the mediator interpreter); pass DSH_NODE_EXE or install Node'
  } else if (named.ok !== true) {
    state = 'unwired'
    reason = `the ACP profile does not name a usable sandbox runner: ${String(named.reason ?? '')}`
  } else if (!materialized) {
    state = 'missing'
    reason = `the profile names ${shim}, but it is not materialized there (shim=${exists(shim)} runner=${exists(runner)})`
  }

  return {
    state,
    ready: state === 'ready',
    reason,
    home,
    profilePath,
    profileNamesShim: named.ok === true,
    profileReason: String(named.reason ?? ''),
    mediatorDir,
    shim,
    runner,
    nodeExe,
    installDir,
    platform,
  }
}

/**
 * The fix, as one command plus the text an operator (or an agent) needs to run it correctly.
 *
 * The command is quoting-safe for PowerShell, which is the shell this project's own tooling uses;
 * the note says what to drop for CMD. Every path is filled in from THIS machine, because a prompt
 * with a placeholder path is the documentation that already failed.
 *
 * @param {ReturnType<typeof inspectSandbox>} diagnosis
 * @param {{ scriptPath?: string, shell?: 'pwsh' | 'cmd' }} [deps]
 * @returns {{ command: string, text: string }}
 */
export function buildPrescription(diagnosis, deps = {}) {
  const script = deps.scriptPath ?? prepareScriptPath()
  const shell = deps.shell ?? 'pwsh'
  const args = [
    `"${script}"`,
    `--dsh-home "${diagnosis.home}"`,
    `--profile ${WORKER_PROFILE}`,
    ...(diagnosis.installDir === '' ? [] : [`--install "${diagnosis.installDir}"`]),
  ]
  const command = shell === 'cmd'
    ? `"${diagnosis.nodeExe || 'node'}" ${args.join(' ')}`
    : `& "${diagnosis.nodeExe || 'node'}" ${args.join(' ')}`

  const lines = [
    '这台机器要当远程工作节点，但沙箱 mediator 还没就绪：',
    `  ${diagnosis.reason}`,
    '',
    '请在这台机器上执行下面这一条命令（也可以把这段文字连同命令交给本机的 DSH 会话，让它去做）：',
    '',
    command,
    '',
    '它只做三件事：① 从本机 app.asar 物化沙箱 mediator；② 必要时往该 profile 的 cordis.patch.yml 追加 sandbox 行（已有可用条目就不动）；③ 跑一次六项沙箱校验。',
    '',
    '本机事实：',
    `- DSH home : ${diagnosis.home}`,
    `- profile  : ${diagnosis.profilePath}`,
    `- mediator : ${diagnosis.mediatorDir}`,
    `- node.exe : ${diagnosis.nodeExe === '' ? '(未找到)' : diagnosis.nodeExe}`,
    '',
    '注意：',
    '- 命令必须在这台机器上运行，不是在主机上。',
    '- DSH 自己的沙箱会拦工作区外的写入；命令被拦时，请改在终端里运行，或在全权会话里运行。',
    '- 可重复执行：已就绪时它不会改动任何文件。',
    '',
    '跑完回到 设置 → 远程工作节点 → 本机角色，点「先检查」，六项都应通过。',
  ]
  return { command, text: lines.join('\n') }
}

/**
 * The report the settings page renders.
 *
 * `prescription` is returned even when `ready` is true: the probe can still fail for a reason the
 * file checks cannot see (a corrupted runner, a policy change), and in that case the same command
 * is the right next step. The page decides when to show it.
 *
 * @param {object} [deps]
 */
export function diagnoseSandbox(deps = {}) {
  const diagnosis = inspectSandbox(deps)
  return { ...diagnosis, prescription: buildPrescription(diagnosis, deps) }
}
