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
 * Which shim does the DSH profile name as the sandbox runner?
 *
 * THE PROFILE IS THE SOURCE OF TRUTH, and this function exists because treating a hardcoded default
 * as the requirement was a real defect: a worker whose mediator had been materialized somewhere else
 * -- and whose acp profile correctly pointed at it -- was refused with
 *
 *   the mediator works but DSH will not use it: runnerCommand names a different shim than
 *   C:\dsh-sandbox-mediator\shim.mjs
 *
 * even though running a command through that very shim worked. The deployment location is not the
 * plugin's business; what matters is that the profile names a shim and that the shim confines.
 *
 * A structural scan rather than a YAML parse: the deployment has no YAML dependency on this path, and
 * the shape it looks for is six lines long.
 *
 * @param {string} profilePath
 * @returns {{ ok: boolean, shim: string, reason: string }}
 */
export function shimNamedByProfile(profilePath) {
  if (typeof profilePath !== 'string' || profilePath === '' || !existsSync(profilePath)) {
    return { ok: false, shim: '', interpreter: '', reason: `no profile patch at ${profilePath}` }
  }
  let text
  try {
    text = readFileSync(profilePath, 'utf8')
  } catch (error) {
    return { ok: false, shim: '', interpreter: '', reason: `cannot read ${profilePath}: ${error.message}` }
  }
  // A file that carries an empty flow array AND list entries is INVALID YAML for this consumer:
  // `[]` is a complete document, so anything appended after it starts a second document without a
  // `---` separator, and the ACP child dies with "end of the stream or a document separator is
  // expected". Measured 2026-11-05: the probe passed (it reads the file structurally), the machine
  // armed, and every ACP connection then closed -- the master reported only `S0 worker reachable:
  // fail`. DSH's shipped profile template IS `[]`, so this happens the first time an entry is
  // appended to a fresh profile. Detected here because this is the one place that reads the file
  // on the arming path; leaving it to the ACP child is too late (arming would already be allowed).
  if (/(?:^|\n)[ \t]*\[\][ \t]*(?:\n|$)/u.test(text) && /(?:^|\n)[ \t]*-[ \t]/u.test(text)) {
    return {
      ok: false,
      shim: '',
      interpreter: '',
      reason: 'the profile contains an empty list marker `[]` AND entries, which is invalid YAML (two documents) -- the ACP child refuses to start; remove the `[]` line, or run prepare-sandbox-mediator.mjs, which repairs it',
    }
  }
  const entry = /-\s*id:\s*sandbox\b[\s\S]{0,600}?runnerCommand:([\s\S]{0,400}?)(?=\n\S|\n-|$)/u.exec(text)
  if (entry === null) {
    // Actionable on purpose: this message is what an operator sees when arming is refused, and the
    // sandbox case previously said only that something did not match.
    return {
      ok: false,
      shim: '',
      interpreter: '',
      reason: `the profile has no sandbox entry with a runnerCommand -- add "- id: sandbox" with a runnerCommand naming a console-subsystem mediator and runnerFailureSignatures (see README, Windows sandbox)`,
    }
  }
  const normalised = entry[1].replace(/\\\\/gu, '\\').replace(/["']/gu, '')
  const match = /([A-Za-z]:\\[^\r\n"']*shim\.mjs)/u.exec(normalised)
  if (match === null) {
    return { ok: false, shim: '', interpreter: '', reason: 'runnerCommand does not name a shim.mjs' }
  }
  if (!/runnerFailureSignatures/u.test(text)) {
    return {
      ok: false,
      shim: '',
      interpreter: '',
      reason: 'runnerCommand is set without runnerFailureSignatures, which sandbox-local rejects at construction -- add the runner\'s error prefix, e.g. "windows-acl-run: "',
    }
  }
  // The INTERPRETER the profile names, i.e. the first runnerCommand element when it is a node.exe.
  // The probe runs the shim through it rather than through `process.execPath`: on a GUI-subsystem
  // host (the DSH desktop app) that executable cannot host the restricted child, so probing it
  // would answer a question about the HOST while the profile configures a different one -- and the
  // answer could be "refuse" on a machine DSH would have run correctly (see probeSandbox).
  const interpreter = /([A-Za-z]:\\[^\r\n"']*node\.exe)/iu.exec(normalised)?.[1] ?? ''
  return { ok: true, shim: match[1], interpreter, reason: '' }
}

/**
 * Does the DSH profile name THIS shim as the sandbox runner?
 *
 * Kept as its own primitive because "the profile names exactly this path" is a useful question --
 * for tests, and for a caller that wants to assert a specific wiring. It is deliberately NOT how
 * probeSandbox decides which shim to exercise: there the profile's own answer wins.
 *
 * @param {string} profilePath
 * @param {string} shimPath
 * @returns {{ ok: boolean, reason: string }}
 */
export function profileNamesShim(profilePath, shimPath) {
  const named = shimNamedByProfile(profilePath)
  if (!named.ok) return { ok: false, reason: named.reason }
  // The exact path matters here: a stale mediator from a previous install would still look right by
  // filename while driving an old runner.
  if (!named.shim.includes(shimPath)) {
    return { ok: false, reason: `runnerCommand names a different shim than ${shimPath}` }
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
  const run = deps.spawn(deps.interpreter, [deps.shim, ...profile, '--', ...command], {
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
  const profile = deps.profile ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
  const injectedSpawn = deps.spawn
  const spawn = injectedSpawn ?? ((file, args, opts) => spawnSync(file, args, opts))

  // WHICH SHIM IS EXERCISED, in precedence order:
  //
  //   1. deps.mediator  -- an explicit override. Tests and diagnostics use it to point at a known
  //                        location regardless of what the profile says.
  //   2. the PROFILE     -- ★ the source of truth. This is the fix: the plugin used to require the
  //                        hardcoded default, so a perfectly working mediator materialized anywhere
  //                        else was refused. See shimNamedByProfile's note.
  //   3. the default     -- only when the profile names nothing, so the failure is reported against
  //                        the location an operator would have been told to use.
  const named = shimNamedByProfile(profile)
  const defaultMediator = 'C:\\dsh-sandbox-mediator'
  const mediator = deps.mediator ?? (named.ok ? dirname(named.shim) : defaultMediator)
  const shim = join(mediator, 'shim.mjs')
  const runner = join(mediator, 'node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'runner.js')
  // WHICH EXECUTABLE RUNS THE SHIM: the one the profile names.
  //
  // This used to be `process.execPath` unconditionally, which answered a question about the HOST
  // (a GUI-subsystem desktop process, which may have no console) while the profile configured a
  // console-subsystem node.exe. The two can disagree, and the disagreement always goes the same
  // way: a machine DSH would have sandboxed correctly is refused. An explicit `deps.mediator`
  // (tests, diagnostics) keeps the old behaviour, because there is no profile to read.
  const interpreterFromProfile = deps.mediator === undefined && named.ok === true && named.interpreter !== ''
  const interpreter = interpreterFromProfile ? named.interpreter : process.execPath
  const workspace = deps.workspace ?? join(tmpdir(), 'dsh-sandbox-probe-ws')
  const tempRoot = join(tmpdir(), 'dsh-sandbox-probe-tmp')

  const checks = []
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail })

  // `config` answers "does the profile name a usable shim", and it now names the one it found, so a
  // refusal can say which file to fix instead of only that something did not match.
  const config = deps.mediator === undefined
    ? { ok: named.ok, reason: named.reason }
    : profileNamesShim(profile, shim)

  if (!existsSync(shim) || !existsSync(runner)) {
    add('the mediator is materialized', false,
      `shim=${existsSync(shim)} runner=${existsSync(runner)} at ${mediator}`)
    return {
      ok: false,
      checks,
      config,
      reason: config.ok
        ? `the profile names ${shim} but it is not materialized there`
        : `the sandbox mediator is not materialized: ${config.reason}`,
    }
  }
  add('the mediator is materialized', true)

  // A named interpreter that is not installed is its own failure, not a reason to fall back:
  // `dsh-sandbox-local` would spawn it too, so the run would fail on the worker side as well --
  // just with no output, which is the symptom this whole file exists to make visible.
  if (!existsSync(interpreter)) {
    add('the mediator interpreter exists', false,
      `runnerCommand names ${interpreter}, which is not present on this machine`)
    return {
      ok: false,
      checks,
      config,
      reason: 'the mediator interpreter is missing: runnerCommand must name a console-subsystem node.exe',
    }
  }
  add('the mediator interpreter exists', true,
    interpreterFromProfile
      ? interpreter
      : deps.mediator === undefined
        ? 'process.execPath (the profile names no interpreter)'
        : "process.execPath (an explicit mediator was given, so the profile's interpreter is not used)")

  rmSync(workspace, { recursive: true, force: true })
  rmSync(tempRoot, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(tempRoot, { recursive: true })

  const payload = [shellPath(), '-NoProfile', '-NonInteractive', '-Command']
  const confined = (opts, command) => runConfined({ shim, spawn, interpreter }, { workspace, ...opts }, command)

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
