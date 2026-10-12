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
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

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

// Hard-coded profile paths first: under a SYSTEM scheduled task LOCALAPPDATA points at
// C:\Windows\system32\config\systemprofile, so environment-derived candidates miss.
const CANDIDATES = [
  arg('install', ''),
  'C:\\Users\\worker\\AppData\\Local\\Programs\\DeepSeek Harness',
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
