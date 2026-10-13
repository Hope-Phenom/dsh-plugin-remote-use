/**
 * Does this machine's Windows sandbox actually confine a command?
 *
 * WHY THIS LIVES IN THE PACKAGE rather than in the tool that first needed it: the arming gate
 * (§16, "refuse to arm until the sandbox works") and `tools/check-sandbox-ready.mjs` must give
 * the same answer. Two implementations of "does the sandbox work" would drift, and the drift
 * would be invisible until a machine was armed on the strength of the wrong one.
 *
 * WHY IT IS BEHAVIOURAL. A configuration check -- "the profile names a mediator" -- is
 * necessary but not sufficient: a mediator that is named and broken passes it. The failure that
 * motivated all of this depends on the LAUNCH CONTEXT (a console-subsystem process allocates or
 * inherits a console; a GUI-subsystem one does not), so the only reliable answer comes from
 * running a command through the configured path and watching what happens.
 *
 * WHAT IT DOES NOT PROVE: that DSH will use this mediator. `probeSandbox` reports the config
 * finding separately for exactly that reason, and the caller is expected to refuse on either.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** PE subsystem: 2 is GUI (never allocates a console), 3 is console (allocates one). */
export function subsystemOf(file) {
  try {
    const buf = readFileSync(file)
    const peOffset = buf.readUInt32LE(0x3C)
    return buf.readUInt16LE(peOffset + 0x5C)
  } catch {
    return 0
  }
}

/**
 * Does the DSH profile name this shim as the sandbox runner?
 *
 * A structural scan rather than a YAML parse: the deployment has no YAML dependency on this
 * path, and the shape it looks for is six lines long. It reports what it found so a miss is
 * visible rather than inferred.
 *
 * @param {string} profilePath
 * @param {string} shimPath
 * @returns {{ ok: boolean, reason: string }}
 */
export function profileNamesShim(profilePath, shimPath) {
  if (typeof profilePath !== 'string' || profilePath === '' || !existsSync(profilePath)) {
    return { ok: false, reason: `no profile patch at ${profilePath}` }
  }
  let text
  try {
    text = readFileSync(profilePath, 'utf8')
  } catch (error) {
    return { ok: false, reason: `cannot read ${profilePath}: ${error.message}` }
  }
  const entry = /-\s*id:\s*sandbox\b[\s\S]{0,600}?runnerCommand:([\s\S]{0,400}?)(?=\n\S|\n-|$)/u.exec(text)
  if (entry === null) return { ok: false, reason: 'the profile has no sandbox entry with a runnerCommand' }
  const normalised = entry[1].replace(/\\\\/gu, '\\').replace(/["']/gu, '')
  if (!normalised.includes('shim.mjs')) return { ok: false, reason: 'runnerCommand does not name a shim.mjs' }
  // The exact path matters: a stale mediator from a previous install would still look right by
  // filename while driving an old runner.
  if (!normalised.includes(shimPath)) {
    return { ok: false, reason: `runnerCommand names a different shim than ${shimPath}` }
  }
  if (!/runnerFailureSignatures/u.test(text)) {
    return { ok: false, reason: 'runnerCommand is set without runnerFailureSignatures, which sandbox-local rejects' }
  }
  return { ok: true, reason: '' }
}

/** The Windows shell the probe payload runs in, preferring the newer one. */
function shellPath() {
  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  return existsSync(pwsh) ? pwsh : 'powershell.exe'
}

/**
 * The payload writes the file ITSELF rather than relying on a shell redirect.
 *
 * A `cmd /c echo x > "path"` probe was tried first and reported "The filename, directory name,
 * or volume label syntax is incorrect" -- the quoting does not survive being passed as argv, so
 * the command failed for a reason unrelated to the sandbox. Worse, the outside-write check then
 * "passed" for that same bogus reason, because it saw a non-zero exit and no file and concluded
 * the sandbox had refused. A probe that fails for the wrong reason is worse than no probe: it
 * reports the answer you were hoping for.
 */
function writePayload(path) {
  return `try { Set-Content -LiteralPath ${JSON.stringify(path)} -Value probe-ok -ErrorAction Stop; Write-Output wrote-ok } catch { Write-Output ("refused: " + $_.Exception.Message); exit 9 }`
}

/**
 * Run one command through the configured mediator path.
 *
 * The path is the configured `runnerCommand`: `node.exe <shim.mjs>` fed the bubblewrap profile.
 * Probing the raw runner instead answers a different question, and answered it in a misleading
 * direction: the raw runner invoked as `node.exe` works in a no-console launch, while DSH's own
 * default (the GUI-subsystem image) does not.
 */
function runConfined(deps, opts, command) {
  const profile = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (opts.readOnly !== true) profile.push('--tmpfs', '/tmp', '--bind', opts.workspace, opts.workspace)
  const run = deps.spawn(process.execPath, [deps.shim, ...profile, '--', ...command], {
    encoding: 'utf8', timeout: opts.timeoutMs ?? 30_000,
  })
  return { code: run.status, stdout: String(run.stdout ?? ''), stderr: String(run.stderr ?? ''), error: run.error?.message ?? '' }
}

/**
 * Probe the sandbox through the path DSH is configured to use.
 *
 * @param {object} [deps]
 * @param {string} [deps.mediator]   where the shim and runner were materialized
 * @param {string} [deps.profile]    the DSH profile patch to read
 * @param {(file: string, args: string[], opts: object) => object} [deps.spawn] injected for tests
 * @param {string} [deps.workspace]  the workspace to grant; a temp directory by default
 * @returns {{ ok: boolean, checks: Array<{name: string, ok: boolean, detail: string}>,
 *             config: { ok: boolean, reason: string }, reason: string }}
 */
export function probeSandbox(deps = {}) {
  const mediator = deps.mediator ?? 'C:\\dsh-sandbox-mediator'
  const profile = deps.profile ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
  const injectedSpawn = deps.spawn
  const spawn = injectedSpawn ?? ((file, args, opts) => spawnSync(file, args, opts))
  const shim = join(mediator, 'shim.mjs')
  const runner = join(mediator, 'node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'runner.js')
  const workspace = deps.workspace ?? join(tmpdir(), 'dsh-sandbox-probe-ws')
  const tempRoot = join(tmpdir(), 'dsh-sandbox-probe-tmp')

  const checks = []
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail })

  const config = profileNamesShim(profile, shim)
  if (!existsSync(shim) || !existsSync(runner)) {
    add('the mediator is materialized', false, `shim=${existsSync(shim)} runner=${existsSync(runner)}`)
    return { ok: false, checks, config, reason: 'the sandbox mediator is not materialized' }
  }
  add('the mediator is materialized', true)

  rmSync(workspace, { recursive: true, force: true })
  rmSync(tempRoot, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(tempRoot, { recursive: true })

  const payload = [shellPath(), '-NoProfile', '-NonInteractive', '-Command']
  const confined = (opts, command) => runConfined({ shim, spawn }, { workspace, ...opts }, command)

  try {
    const alive = confined({}, [...payload, 'Write-Output sandbox-probe-alive'])
    add('the mediator can execute a command at all', alive.code === 0 && alive.stdout.includes('sandbox-probe-alive'),
      `exit=${alive.code} ${alive.stderr.trim().slice(0, 120)}`)

    const inside = join(workspace, 'inside.txt')
    rmSync(inside, { force: true })
    const insideRun = confined({}, [...payload, writePayload(inside)])
    add('a write INSIDE the workspace succeeds (the control)',
      existsSync(inside) && insideRun.stdout.includes('wrote-ok'),
      `exit=${insideRun.code} exists=${existsSync(inside)}`)

    const outside = join(dirname(tempRoot), 'dsh-sandbox-probe-outside.txt')
    rmSync(outside, { force: true })
    const outsideRun = confined({}, [...payload, writePayload(outside)])
    // Require BOTH: a reported refusal (not an unrelated failure) AND no file.
    add('a write OUTSIDE the workspace is refused',
      !existsSync(outside) && outsideRun.stdout.includes('refused:'),
      existsSync(outside) ? 'the file EXISTS: workspace-write is not confining anything' : `exit=${outsideRun.code}`)

    const readOnlyWrite = join(workspace, 'readonly.txt')
    rmSync(readOnlyWrite, { force: true })
    const readOnlyRun = confined({ readOnly: true }, [...payload, writePayload(readOnlyWrite)])
    add('read-only cannot write the workspace either',
      !existsSync(readOnlyWrite) && readOnlyRun.stdout.includes('refused:'),
      existsSync(readOnlyWrite) ? 'read-only wrote the workspace: the tiers are not distinct' : `exit=${readOnlyRun.code}`)

    const readOnlyRead = confined({ readOnly: true }, [...payload, 'Write-Output read-only-alive'])
    add('read-only can still read',
      readOnlyRead.code === 0 && readOnlyRead.stdout.includes('read-only-alive'), `exit=${readOnlyRead.code}`)

    // Clean up BEFORE the verdict so a failure cannot leave probe files behind.
    rmSync(workspace, { recursive: true, force: true })
    rmSync(tempRoot, { recursive: true, force: true })
    rmSync(outside, { force: true })

    const failed = checks.filter((c) => !c.ok)
    if (failed.length > 0) return { ok: false, checks, config, reason: `the sandbox did not confine: ${failed[0].name}` }
    if (!config.ok) return { ok: false, checks, config, reason: `the mediator works but DSH will not use it: ${config.reason}` }
    return { ok: true, checks, config, reason: '' }
  } catch (error) {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(tempRoot, { recursive: true, force: true })
    add('the probe ran to completion', false, error instanceof Error ? error.message : String(error))
    return { ok: false, checks, config, reason: `the probe could not complete: ${error instanceof Error ? error.message : String(error)}` }
  }
}
