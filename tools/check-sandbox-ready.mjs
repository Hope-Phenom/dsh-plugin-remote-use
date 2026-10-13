/**
 * check-sandbox-ready.mjs -- can THIS machine's Windows sandbox confine a command?
 *
 * WHY A SCRIPT RATHER THAN A DOCUMENTED PROCEDURE: §16 refuses to arm a machine as a remote
 * worker until its sandbox demonstrably works. A gate needs a check that runs, not a paragraph
 * that is believed. This is that check, for the host and for a worker alike.
 *
 * THE TRAP IT EXISTS TO AVOID. The Windows rung builds its mediator from `process.execPath`.
 * That is `DeepSeek Harness.exe`, a GUI-subsystem image, and the failure that follows --
 * 0xC0000142 on the worker, `GetStdHandle failed ... null stdin handle` on the host -- depends
 * on whether the process has a CONSOLE, not on the subsystem alone. Measured here:
 *
 *   launched from a terminal (console present)   -> works, even from the GUI image
 *   launched by a scheduled task (no console)    -> the restricted child dies
 *
 * So a check run from a terminal would report READY on a machine whose worker role is broken.
 * This script therefore reports the launch context it observed alongside the verdict, and says
 * plainly when the verdict only covers the interactive case.
 *
 * Exit codes: 0 READY, 1 NOT READY, 2 the check could not run (missing pieces).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const MEDIATOR = argOf('mediator', 'C:\\dsh-sandbox-mediator')
const WORKSPACE = argOf('workspace', join(tmpdir(), 'dsh-sandbox-readiness-ws'))
const TEMP_ROOT = join(tmpdir(), 'dsh-sandbox-readiness-tmp')

const RUNNER = join(MEDIATOR, 'node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'runner.js')
const SHIM = join(MEDIATOR, 'shim.mjs')

/**
 * The shell the probe payload runs in.
 *
 * NOT `cmd` with a `>` redirect: the quoting does not survive being passed as argv, so the
 * command fails with "The filename, directory name, or volume label syntax is incorrect"
 * whatever the sandbox does. PowerShell is asked to write the file itself instead, and to say
 * whether it was refused -- so the check distinguishes a refusal from an unrelated failure.
 */
const SHELL = existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  : 'powershell.exe'

const line = (s) => process.stdout.write(`${s}\n`)

/** PE subsystem: 2 is GUI (Windows never auto-allocates a console), 3 is console. */
function subsystemOf(file) {
  try {
    const buf = readFileSync(file)
    const peOffset = buf.readUInt32LE(0x3C)
    return buf.readUInt16LE(peOffset + 0x5C)
  } catch {
    return 0
  }
}



// ---------------------------------------------------------------------------

/**
 * Run a command through the path DSH ACTUALLY USES.
 *
 * That path is the configured `runnerCommand`: `node.exe <shim.mjs>` fed the bubblewrap
 * profile. Probing the raw runner instead would answer a different question -- and it answered
 * it in a misleading direction: the raw runner invoked as `node.exe` works in a no-console
 * launch, while DSH's own default (the GUI-subsystem image) does not. Checking anything other
 * than the configured path would report READY on a machine whose real sandbox is broken.
 *
 * @param {{ readOnly?: boolean }} opts
 * @param {string[]} command the payload
 */
function runConfined(opts, command) {
  const profile = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (opts.readOnly !== true) profile.push('--tmpfs', '/tmp', '--bind', WORKSPACE, WORKSPACE)
  const args = [SHIM, ...profile, '--', ...command]
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000 })
  return { code: run.status, stdout: String(run.stdout ?? ''), stderr: String(run.stderr ?? ''), error: run.error?.message ?? '' }
}

/**
 * Does the DSH profile actually NAME this shim as the sandbox runner?
 *
 * WHY THIS IS PART OF THE CHECK. Everything below runs the shim directly, so it proves the
 * shim works -- NOT that DSH will use it. If the profile config is missing, DSH falls back to
 * `process.execPath` (the GUI image) and the sandbox breaks in a no-console launch, while a
 * check that only exercised the shim would happily report READY. Reading the config is what
 * turns "the mediator works" into "the sandbox DSH will use works".
 *
 * A structural scan rather than a YAML parse: this file is a deployed tool, not a library, and
 * the shape it looks for is six lines long. It reports what it found so a miss is visible.
 */
function profileNamesShim(profilePath, shimPath) {
  if (!existsSync(profilePath)) return { ok: false, reason: `no profile patch at ${profilePath}` }
  let text
  try {
    text = readFileSync(profilePath, 'utf8')
  } catch (error) {
    return { ok: false, reason: `cannot read ${profilePath}: ${error.message}` }
  }
  const entry = /-\s*id:\s*sandbox\b[\s\S]{0,600}?runnerCommand:([\s\S]{0,400}?)(?=\n\S|\n-|$)/u.exec(text)
  if (entry === null) return { ok: false, reason: 'the profile has no sandbox entry with a runnerCommand' }
  const block = entry[1]
  if (!block.includes('shim.mjs')) return { ok: false, reason: 'runnerCommand does not name a shim.mjs' }
  // The exact path matters: a stale mediator from a previous install would still look right by
  // filename while driving an old runner.
  const normalised = block.replace(/\\\\/gu, '\\').replace(/["']/gu, '')
  if (!normalised.includes(shimPath)) {
    return { ok: false, reason: `runnerCommand names a different shim than ${shimPath}` }
  }
  if (!/runnerFailureSignatures/u.test(text)) {
    return { ok: false, reason: 'runnerCommand is set without runnerFailureSignatures, which sandbox-local rejects' }
  }
  return { ok: true, reason: '' }
}

line('sandbox readiness')
line(`  interpreter   : ${process.execPath}`)
const subsystem = subsystemOf(process.execPath)
line(`  subsystem     : ${subsystem}${subsystem === 2 ? '  (GUI -- never allocates a console)' : subsystem === 3 ? '  (console -- allocates one if the parent had none)' : ''}`)
line(`  mediator      : ${MEDIATOR}`)
line(`  shim          : ${existsSync(SHIM) ? 'present' : 'MISSING'}`)
line(`  runner        : ${existsSync(RUNNER) ? 'present' : 'MISSING'}`)

// A WRONG probe, removed rather than fixed: asking a CHILD PowerShell for GetConsoleWindow()
// measures the child, and PowerShell is a console-subsystem image that allocates a console of
// its own -- so it answered "present" even under a scheduled task, and the note it produced
// told the operator the opposite of the truth. The mechanism is that a console-subsystem
// process allocates or inherits a console while a GUI-subsystem one does not, so the only
// meaningful question is whether the CONFIGURED path works here, which is what follows.
const profilePath = argOf('profile', join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'))
const config = profileNamesShim(profilePath, SHIM)
line(`  profile       : ${profilePath}`)
line(`  config        : ${config.ok ? 'names this shim' : `NOT WIRED -- ${config.reason}`}`)
line('')

if (!existsSync(RUNNER) || !existsSync(SHIM)) {
  line('VERDICT: cannot run -- the mediator is not fully materialized.')
  line('  Run:  ELECTRON_RUN_AS_NODE=1 "<install>\\DeepSeek Harness.exe" .research/extract-mediator.mjs "<asar>" "' + MEDIATOR + '"')
  process.exit(2)
}

rmSync(WORKSPACE, { recursive: true, force: true })
rmSync(TEMP_ROOT, { recursive: true, force: true })
mkdirSync(WORKSPACE, { recursive: true })
mkdirSync(TEMP_ROOT, { recursive: true })

const results = []
const check = (label, ok, detail) => {
  results.push(ok)
  line(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` -- ${detail}`}`)
}

line('through the configured runnerCommand (node + shim):')
const alive = runConfined({}, [SHELL, '-NoProfile', '-NonInteractive', '-Command', 'Write-Output sandbox-probe-alive'])
check('the mediator can execute a command at all', alive.code === 0 && alive.stdout.includes('sandbox-probe-alive'),
  `exit=${alive.code} ${alive.stderr.trim().slice(0, 120)}`)

// The payload writes the file ITSELF rather than relying on a shell redirect.
//
// A `cmd /c echo x > "path"` probe was tried first and produced "The filename, directory name,
// or volume label syntax is incorrect" -- the quoting does not survive being passed as argv,
// so the command failed for a reason unrelated to the sandbox. Worse, the OUTSIDE check then
// "passed" for that same bogus reason: it saw a non-zero exit and no file, and concluded the
// sandbox had refused. A probe that fails for the wrong reason is worse than no probe, because
// it reports the answer you were hoping for.
const writePayload = (path) => `try { Set-Content -LiteralPath ${JSON.stringify(path)} -Value probe-ok -ErrorAction Stop; Write-Output wrote-ok } catch { Write-Output ("refused: " + $_.Exception.Message); exit 9 }`

const inside = join(WORKSPACE, 'inside.txt')
rmSync(inside, { force: true })
const insideRun = runConfined({}, [SHELL, '-NoProfile', '-NonInteractive', '-Command', writePayload(inside)])
check('a write INSIDE the workspace succeeds (the control)',
  existsSync(inside) && insideRun.stdout.includes('wrote-ok'),
  `exit=${insideRun.code} exists=${existsSync(inside)} ${insideRun.stdout.trim().slice(0, 80)}`)

// A path outside BOTH the workspace and the runner's own temp grant. Writing into the temp
// root would be ALLOWED (it is the runner's private temp capability) and would make this check
// pass while proving nothing.
const trulyOutside = join(dirname(TEMP_ROOT), 'dsh-sandbox-readiness-outside.txt')
rmSync(trulyOutside, { force: true })
const outsideRun = runConfined({}, [SHELL, '-NoProfile', '-NonInteractive', '-Command', writePayload(trulyOutside)])
// Require BOTH: the payload reported a REFUSAL (not some other failure) and no file appeared.
check('a write OUTSIDE the workspace is refused',
  !existsSync(trulyOutside) && outsideRun.stdout.includes('refused:'),
  existsSync(trulyOutside)
    ? 'the file EXISTS: workspace-write is not confining anything'
    : `exit=${outsideRun.code} ${outsideRun.stdout.trim().slice(0, 90)}`)

line('')
line('read-only:')
const readOnlyInside = join(WORKSPACE, 'readonly.txt')
rmSync(readOnlyInside, { force: true })
const readOnlyRun = runConfined({ readOnly: true }, [SHELL, '-NoProfile', '-NonInteractive', '-Command', writePayload(readOnlyInside)])
check('the workspace is NOT writable either',
  !existsSync(readOnlyInside) && readOnlyRun.stdout.includes('refused:'),
  existsSync(readOnlyInside)
    ? 'read-only wrote into the workspace: the tiers are not distinct'
    : `exit=${readOnlyRun.code} ${readOnlyRun.stdout.trim().slice(0, 90)}`)

const readOnlyRead = runConfined({ readOnly: true }, [SHELL, '-NoProfile', '-NonInteractive', '-Command', 'Write-Output read-only-alive'])
check('reads still work (a sandbox that permits nothing is not a sandbox)',
  readOnlyRead.code === 0 && readOnlyRead.stdout.includes('read-only-alive'), `exit=${readOnlyRead.code}`)

rmSync(WORKSPACE, { recursive: true, force: true })
rmSync(TEMP_ROOT, { recursive: true, force: true })
rmSync(trulyOutside, { force: true })

line('')
const passed = results.filter(Boolean).length
if (passed === results.length && config.ok) {
  line(`VERDICT: READY -- ${passed}/${results.length} checks, and the profile names this shim.`)
  line('  DSH will use this mediator, and it confines in this launch context.')
  process.exit(0)
}
if (passed === results.length) {
  // The mediator works; DSH will not use it. This is the difference between "the sandbox is
  // fixed" and "the sandbox is fixed AND actually in force", and reporting READY here would
  // hide exactly the half that matters.
  line(`VERDICT: NOT READY -- the mediator confines (${passed}/${results.length}) but the profile does not name it.`)
  line(`  ${config.reason}`)
  line('  DSH would fall back to its own mediator, which fails when DSH has no console.')
  process.exit(1)
}
line(`VERDICT: NOT READY -- ${passed}/${results.length} checks passed.`)
line('  Do not arm this machine as a worker: workspace-write would not confine anything.')
process.exit(1)
