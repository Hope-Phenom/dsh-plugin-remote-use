/**
 * sandbox-mediator-shim.mjs -- run the Windows ACL sandbox runner from a console-subsystem
 * mediator.
 *
 * THE PROBLEM
 *   `dsh-sandbox-local`'s default mediator is `process.execPath`, which in this deployment is
 *   `DeepSeek Harness.exe` -- a GUI-subsystem image. Windows never auto-allocates a console
 *   to a GUI-subsystem image, so the WRITE_RESTRICTED child the runner creates has no console
 *   to inherit and dies during DLL initialization with 0xC0000142 (STATUS_DLL_INIT_FAILED).
 *   Every shell command fails, with no output at all.
 *
 *   Measured on this machine, same runner and args, only the interpreter varied (8/8 valid):
 *     node.exe (console subsystem)          4/4 exit 0, child produced its output
 *     DeepSeek Harness.exe (GUI subsystem)  4/4 exit 0xC0000142, no output
 *
 * WHY A SHIM AND NOT `runnerCommand` POINTED AT THE RUNNER DIRECTLY
 *   `sandbox-local.confine()` prepends `bwrapProfileArgs(policy)` to a configured
 *   `runnerCommand` unconditionally -- a bubblewrap dialect (`--ro-bind`, `--bind`,
 *   `--tmpfs`, ...) that the Windows runner rejects with
 *   `windows-acl-run: unknown argument: --ro-bind`. `runnerCommand` is the "operator
 *   asserts this is a bwrap-compatible runner" path, not a way to swap the win32 rung.
 *
 *   So the shim is named as the runner and translates the two dialects. Being launched as
 *   `node.exe` is the whole point: a console-subsystem image is auto-allocated a console,
 *   which is what the restricted child needs.
 *
 * CONTRACT
 *   in : <bwrap profile args> -- <command argv...>
 *   out: spawns `node.exe <windows-acl runner> --workspace .. --temp .. --mode .. -- <argv>`
 *        with the shim's own stdio inherited, and mirrors the exit code.
 *
 * LIMITATIONS -- deliberate and stated rather than hidden:
 *   * `--bind <root>` is emitted ONLY in workspace-write mode, so in read-only mode the
 *     workspace root is not on the command line. The shim then falls back to
 *     DSH_SANDBOX_WORKSPACE, then to the current directory. Read-only issues no workspace
 *     write grant, so the value only needs to name an existing directory.
 *   * `--unshare-pid` and `--die-with-parent` have no Windows equivalent and are dropped.
 *     Process containment comes from the runner's own job object.
 *   * A bubblewrap argument this shim does not recognise is a HARD ERROR, never ignored:
 *     silently dropping a confinement argument would weaken the sandbox without saying so.
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNNER = process.env.DSH_SANDBOX_RUNNER
  ?? join(HERE, 'node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'runner.js')

function die(message) {
  // The runner's own failure signature prefix, so dsh-sandbox-local's
  // `runnerFailureSignatures` match catches this and reports it as a sandbox failure
  // rather than as an opaque non-zero exit.
  process.stderr.write(`windows-acl-run: shim: ${message}\n`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const sep = argv.indexOf('--')
if (sep < 0) die('missing "--" separator')
const profile = argv.slice(0, sep)
const command = argv.slice(sep + 1)
if (command.length === 0) die('no command after "--"')

if (!existsSync(RUNNER)) die(`runner not found at ${RUNNER}`)

// ---- translate the bubblewrap dialect -------------------------------------
let mode = 'read-only'
let workspace = ''
let temp = ''
const dropped = []

for (let i = 0; i < profile.length; i += 1) {
  const a = profile[i]
  const next = () => {
    const v = profile[i + 1]
    if (v === undefined) die(`missing value after ${a}`)
    i += 1
    return v
  }
  switch (a) {
    case '--ro-bind': {
      // `--ro-bind <src> <dest>`: read-only bind. The Windows rung is always
      // read-everything, so this is represented by the mode, not by path grants.
      next(); next()
      break
    }
    case '--bind': {
      // `--bind <src> <dest>`: writable bind -- the workspace, and the only place the
      // workspace root appears on the command line.
      const src = next()
      next()
      mode = 'workspace-write'
      workspace = src
      break
    }
    case '--tmpfs': {
      // bwrapProfileArgs hardcodes the Linux path `/tmp`, which does not exist here. Take
      // the value only when it names a real directory; otherwise fall back to the platform
      // temp. This one IS a silent substitution, so it is recorded on stderr for anyone
      // debugging with DSH_SANDBOX_SHIM_DEBUG=1 -- it never affects what is writable,
      // because the runner grants its own private temp child under whatever root it gets.
      const value = next()
      if (existsSync(value)) temp = value
      else if (process.env.DSH_SANDBOX_SHIM_DEBUG === '1') {
        process.stderr.write(`windows-acl-shim-debug: ignoring tmpfs ${value} (absent on this platform); using ${tmpdir()}\n`)
      }
      break
    }
    case '--dev':
    case '--proc': {
      next()
      break
    }
    case '--unshare-pid':
    case '--die-with-parent': {
      dropped.push(a)
      break
    }
    default:
      die(`unrecognised profile argument "${a}"`)
  }
}

if (workspace === '') {
  // Read-only mode carries no --bind, so the workspace root is not on the command line.
  // The workspace grant is inert in read-only, so any stable existing directory satisfies
  // the runner's argument contract. `process.cwd()` is NOT used: it depends on whoever
  // launched the mediator (an SSH session put it at C:\Users\worker, which then appeared to
  // contain the temp directory). The mediator's own directory is deterministic.
  workspace = process.env.DSH_SANDBOX_WORKSPACE ?? HERE
}
if (temp === '') temp = tmpdir()

for (const p of [workspace, temp]) {
  try {
    if (!statSync(p).isDirectory()) die(`not a directory: ${p}`)
  } catch {
    die(`does not exist: ${p}`)
  }
}
// The runner refuses a temp root inside the workspace; keep that invariant explicit here so
// the failure names the shim's translation rather than surfacing as an opaque runner error.
//
// The comparison is BOUNDARY-AWARE: a plain prefix test made C:\Users\worker appear to
// contain C:\Users\worker\AppData\Local\Temp, which is a different relationship from
// containment by path segment.
function containsPath(parent, child) {
  const norm = (p) => p.replace(/[\\/]+$/, '').toLowerCase()
  const a = norm(parent)
  const b = norm(child)
  if (a === b) return true
  const sep = a.endsWith('\\') || a.endsWith('/') ? '' : (a.includes('\\') ? '\\' : '/')
  return b.startsWith(a + sep)
}
if (containsPath(workspace, temp)) {
  die(`temp root ${temp} is inside the workspace ${workspace}`)
}

const runnerArgs = [
  RUNNER,
  '--workspace', workspace,
  '--temp', temp,
  '--mode', mode,
  '--',
  ...command,
]

// `process.execPath` is node.exe for this shim, i.e. a console-subsystem image -- which is
// exactly the property that makes the restricted child work. stdio is inherited so DSH
// still receives the command's output through the pipes it set up.
const child = spawn(process.execPath, runnerArgs, { stdio: 'inherit', windowsHide: false })

child.on('error', (error) => die(`could not spawn runner: ${error.message}`))
child.on('exit', (code, signal) => {
  if (signal !== null) process.exit(1)
  process.exit(code ?? 1)
})
