// make-launch-spec.mjs -- generate the ACP agent launch spec for THIS machine.
//
// We deliberately do NOT launch `dsh.cmd`. That shim is:
//     set "ELECTRON_RUN_AS_NODE=1"
//     "<install>\DeepSeek Harness.exe" --expose-internals "<install>\resources\app.asar\
//         dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
// and we replicate it exactly with an argv ARRAY, which avoids every Windows quoting
// hazard: `cmd.exe /c` loses quotes through the PowerShell -> node hand-off, and Node
// refuses to spawn a `.cmd` without a shell (EINVAL).
//
// NOTE: the cli.js path lives INSIDE app.asar, so ordinary fs existence checks report
// false -- Electron can read it, the filesystem API cannot. We therefore only test the
// .exe and let the argv path be constructed.
//
// Usage: node make-launch-spec.mjs [--install <dir>] [--profile acp] [--out <file>]
//                                   [--permission-mode <mode>] [--dsh-home <dir>]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { checkPairing } from './permission-pairing.mjs'

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const PROFILE = arg('profile', 'acp')
const OUT = arg('out', 'agent-spec.json')
// Permission mode is read by dsh-base's sandbox-policy/approval rows from the
// environment, so it must be set in the CHILD's env to make experiments deterministic.
// 'workspace-write' => sandbox denies out-of-workspace writes and approval policy is 'ask',
//                      which is exactly the path that produces session/request_permission.
const PERMISSION_MODE = arg('permission-mode', '')

// ---------------------------------------------------------------------------
// GATE: refuse a mode this worker's profile cannot compose (PITFALLS F34).
//
// This script is the ONLY place that knows which mode is being requested, so it is the only place
// a gate can stand -- the plugin never learns the deployment mode at all. The check is here rather
// than in the plugin on purpose: a check somewhere else would need new config to carry the mode
// there, and that mechanism is exactly what this design does not have.
//
// Blocks on a KNOWN-BAD combination, and only warns when the profile cannot be read: refusing on
// "unknown" would make a legitimate worker undeployable, while staying silent about "unknown" would
// let the operator read silence as approval. The two cases are therefore reported differently.
// ---------------------------------------------------------------------------
const DSH_HOME = arg('dsh-home', process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'))
const PROFILE_PATH = join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')
let profileText
try {
  profileText = readFileSync(PROFILE_PATH, 'utf8')
} catch {
  profileText = undefined
}

const pairing = checkPairing({ mode: PERMISSION_MODE, profileText, profilePath: PROFILE_PATH })
if (pairing.severity === 'block') {
  console.error(`[make-launch-spec] REFUSING to generate this spec: --permission-mode ${PERMISSION_MODE}`)
  console.error('')
  console.error(pairing.reason)
  console.error('')
  console.error('Nothing was written. Fix the profile, then run this again.')
  process.exit(3)
}
if (pairing.severity === 'warn') {
  console.error(`[make-launch-spec] WARNING: ${pairing.reason}`)
  console.error(`                 expected the profile patch at ${PROFILE_PATH}`)
  if (PERMISSION_MODE === 'danger-full-access') {
    console.error('                 A full-access worker also needs the approval row from')
    console.error('                 slave/acp-profile-approval.patch.yml, or its ACP process may not start.')
  }
}

// Hard-coded profile paths first: under a SYSTEM scheduled task LOCALAPPDATA points at
// C:\Windows\system32\config\systemprofile, so environment-derived candidates miss.
const CANDIDATES = [
  arg('install', ''),
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'),
  'C:\\Program Files\\DeepSeek Harness',
].filter((p) => typeof p === 'string' && p !== '')

let installDir = null
for (const c of CANDIDATES) {
  if (existsSync(join(c, 'DeepSeek Harness.exe'))) { installDir = c; break }
}
if (installDir === null) {
  console.error('[make-launch-spec] could not find "DeepSeek Harness.exe". Tried:')
  for (const c of CANDIDATES) console.error('  ' + c)
  process.exit(2)
}

const exe = join(installDir, 'DeepSeek Harness.exe')
const cli = [
  installDir, 'resources', 'app.asar', 'dsh', 'node_modules',
  '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js',
].join('\\')

const spec = {
  command: exe,
  args: ['--expose-internals', cli, '--profile', PROFILE],
  env: {
    ELECTRON_RUN_AS_NODE: '1',
    ...(PERMISSION_MODE === '' ? {} : { DSH_PERMISSION_MODE: PERMISSION_MODE }),
  },
  _note: 'replicates dsh.cmd with an argv array; never launch the .cmd shim from Node on Windows',
  _installDir: installDir,
  _permissionMode: PERMISSION_MODE === '' ? '(inherited)' : PERMISSION_MODE,
}

writeFileSync(OUT, JSON.stringify(spec, null, 2), 'utf8')
console.log(`wrote ${resolve(OUT)}`)
console.log(JSON.stringify(spec, null, 2))
