/**
 * check-sandbox-ready.mjs -- can THIS machine's Windows sandbox confine a command?
 *
 * A THIN CLI over `lib/core/sandbox-probe.js`. The probe lives in the package because the
 * plugin's arming gate needs the same answer, and two implementations of "does the sandbox
 * work" would drift -- invisibly, until a machine was armed on the strength of the wrong one.
 *
 * WHY A CHECK RATHER THAN A DOCUMENTED PROCEDURE: §16 refuses to arm a machine as a remote
 * worker until its sandbox demonstrably works. A gate needs a check that runs, not a paragraph
 * that is believed.
 *
 * THE TRAP IT EXISTS TO AVOID. The Windows rung builds its mediator from `process.execPath`.
 * That is `DeepSeek Harness.exe`, a GUI-subsystem image, and what follows depends on whether the
 * process has a CONSOLE, not on the subsystem alone -- measured:
 *
 *   launched from a terminal (console present)   -> works, even from the GUI image
 *   launched by a scheduled task (no console)    -> the restricted child dies
 *
 * Exit codes: 0 READY, 1 NOT READY, 2 the check could not run (mediator not materialized).
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE = resolve(HERE, '..', 'packages', 'dsh-plugin-remote-use', 'lib', 'core', 'sandbox-probe.js')

if (!existsSync(PROBE)) {
  process.stdout.write(`cannot find the probe at ${PROBE}\n`)
  process.exit(2)
}

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

// A Windows path is not a URL: dynamic import requires the file:// scheme.
const { probeSandbox, subsystemOf } = await import(pathToFileURL(PROBE).href)

const mediator = argOf('mediator', 'C:\\dsh-sandbox-mediator')
const profile = argOf('profile', join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'))
const workspace = argOf('workspace', undefined)

const line = (s) => process.stdout.write(`${s}\n`)
const subsystem = subsystemOf(process.execPath)

line('sandbox readiness')
line(`  interpreter   : ${process.execPath}`)
line(`  subsystem     : ${subsystem}${subsystem === 2 ? '  (GUI -- never allocates a console)' : subsystem === 3 ? '  (console -- allocates one if the parent had none)' : ''}`)
line(`  mediator      : ${mediator}`)
line(`  shim          : ${existsSync(join(mediator, 'shim.mjs')) ? 'present' : 'MISSING'}`)
line(`  profile       : ${profile}`)
line('')

const result = probeSandbox(workspace === undefined ? { mediator, profile } : { mediator, profile, workspace })

line('through the configured runnerCommand (node + shim):')
for (const check of result.checks) {
  line(`  [${check.ok ? 'PASS' : 'FAIL'}] ${check.name}${check.detail === '' ? '' : ` -- ${check.detail}`}`)
}
line('')
line(`  config        : ${result.config.ok ? 'names this shim' : `NOT WIRED -- ${result.config.reason}`}`)
line('')

const materialised = result.checks.some((c) => c.name === 'the mediator is materialized' && !c.ok)

if (result.ok) {
  const passed = result.checks.filter((c) => c.ok).length
  line(`VERDICT: READY -- ${passed}/${result.checks.length} checks, and the profile names this shim.`)
  line('  DSH will use this mediator, and it confines in this launch context.')
  process.exit(0)
}

if (!materialised && result.checks.every((c) => c.ok)) {
  // The mediator works; DSH will not use it. This is the difference between "the sandbox is
  // fixed" and "the sandbox is fixed AND actually in force", and reporting READY here would hide
  // exactly the half that matters.
  line(`VERDICT: NOT READY -- the mediator confines (${result.checks.length}/${result.checks.length}) but the profile does not name it.`)
  line(`  ${result.config.reason}`)
  line('  DSH would fall back to its own mediator, which fails when DSH has no console.')
  process.exit(1)
}

line(`VERDICT: NOT READY -- ${result.reason}`)
line('  Do not arm this machine as a worker: workspace-write would not confine anything.')
process.exit(materialised ? 2 : 1)
