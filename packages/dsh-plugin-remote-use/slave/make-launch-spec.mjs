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
//                                   [--settings-file <file>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

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
//
// NO --permission-mode MEANS "USE THE MACHINE'S CONFIGURED MODE", not "leave it unset": a
// hand-managed relay and the plugin's settings page both write this one value, and letting the
// manual path default to nothing is how a spec can silently keep an old mode after the setting was
// changed. The flag still wins when given, so an explicit deployment stays reproducible.
const PERMISSION_FLAG = arg('permission-mode', '')
let PERMISSION_MODE = PERMISSION_FLAG
let PERMISSION_MODE_SOURCE = PERMISSION_FLAG === '' ? 'none' : '--permission-mode'

// ---------------------------------------------------------------------------
// GATE: refuse a mode this worker's profile cannot compose (PITFALLS F34).
//
// This is the point where a spec is WRITTEN, so it is the point where a bad mode must be refused --
// whether it came from --permission-mode or from the settings file. The plugin also knows the mode,
// but arming fails at spec-build time; letting a typo through here would start a child whose
// dsh-base rejects the value at load.
//
// Blocks on a KNOWN-BAD combination, and only warns when the profile cannot be read: refusing on
// "unknown" would make a legitimate worker undeployable, while staying silent about "unknown" would
// let the operator read silence as approval. The two cases are therefore reported differently.
// ---------------------------------------------------------------------------
const DSH_HOME = arg('dsh-home', process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'))
const SETTINGS_FILE = arg('settings-file', join(DSH_HOME, 'storages', 'dsh-plugin-remote-use', 'settings.json'))
// Read once: the mode and the model both live in this file, and reading it twice invites the two
// values coming from different generations of it.
let SETTINGS = {}
try {
  SETTINGS = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, ''))
} catch {
  // Missing settings file is the normal case for a hand-managed worker that never opened the
  // plugin's page. A corrupt one is caught by the mode gate if it produced no usable value.
  SETTINGS = {}
}
if (PERMISSION_MODE === '') {
  const fromSettings = SETTINGS !== null && typeof SETTINGS === 'object' ? SETTINGS.workerSessionMode : undefined
  if (typeof fromSettings === 'string' && fromSettings !== '') {
    PERMISSION_MODE = fromSettings
    PERMISSION_MODE_SOURCE = `settings: ${SETTINGS_FILE}`
  }
}
/**
 * The worker model, as `provider/model`. Empty means "leave the profile's acp row alone".
 *
 * It is applied as an OVERLAY passed with `--patch`, not by editing the profile: the plugin does
 * not own `cordis.patch.yml`. The overlay is applied after the profile layer, so it wins.
 */
const WORKER_MODEL = SETTINGS !== null && typeof SETTINGS === 'object' && typeof SETTINGS.workerModel === 'string'
  ? SETTINGS.workerModel.trim()
  : ''
let modelPatch = ''
if (WORKER_MODEL !== '') {
  const slash = WORKER_MODEL.indexOf('/')
  const provider = slash > 0 ? WORKER_MODEL.slice(0, slash).trim() : ''
  const model = slash > 0 ? WORKER_MODEL.slice(slash + 1).trim() : ''
  if (provider === '' || model === '' || /[\r\n]/.test(WORKER_MODEL) || /\s/.test(model)) {
    console.error(`[make-launch-spec] REFUSING: workerModel "${WORKER_MODEL}" is not "provider/model"`)
    console.error('Nothing was written. Fix the setting, then run this again.')
    process.exit(3)
  }
  modelPatch = join(DSH_HOME, 'storages', 'dsh-plugin-remote-use', 'acp-model-overlay.yml')
  const overlay = [
    '# --- dsh-plugin-remote-use managed: worker model (generated from this machine\'s "workerModel" setting) ---',
    '- id: acp',
    "  name: '@deepseek-ai/dsh-acp'",
    '  config:',
    `    provider: ${JSON.stringify(provider)}`,
    `    model: ${JSON.stringify(model)}`,
    '# --- end dsh-plugin-remote-use managed: worker model ---',
    '',
  ].join('\n')
  try {
    mkdirSync(dirname(modelPatch), { recursive: true })
    writeFileSync(modelPatch, overlay, 'utf8')
  } catch (error) {
    console.error(`[make-launch-spec] REFUSING: cannot write the model overlay ${modelPatch}: ${error.message}`)
    console.error('Nothing was written. Fix DSH_HOME or permissions, then run this again.')
    process.exit(3)
  }
}
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
  if (profileText === undefined) {
    // "Could not verify" is not "verified fine", and the operator still needs to know what to check
    // by hand when this script cannot read the profile (an unusual DSH_HOME, for instance).
    console.error(`                 expected the profile patch at ${PROFILE_PATH}`)
    console.error('                 if it pins the approval policy, apply slave/acp-profile-approval.patch.yml')
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
  // `--patch` is applied AFTER the profile layer: that is how the model setting wins without
  // editing the operator's `cordis.patch.yml`.
  args: ['--expose-internals', cli, '--profile', PROFILE, ...(modelPatch === '' ? [] : ['--patch', modelPatch])],
  env: {
    ELECTRON_RUN_AS_NODE: '1',
    ...(PERMISSION_MODE === '' ? {} : { DSH_PERMISSION_MODE: PERMISSION_MODE }),
  },
  _note: 'replicates dsh.cmd with an argv array; never launch the .cmd shim from Node on Windows',
  _installDir: installDir,
  _permissionMode: PERMISSION_MODE === '' ? '(inherited)' : PERMISSION_MODE,
  _permissionModeSource: PERMISSION_MODE_SOURCE,
  _workerModel: WORKER_MODEL === '' ? '(inherit profile)' : WORKER_MODEL,
  _modelOverlay: modelPatch,
}

writeFileSync(OUT, JSON.stringify(spec, null, 2), 'utf8')
console.log(`wrote ${resolve(OUT)}`)
console.log(`mode: ${spec._permissionMode}${PERMISSION_MODE_SOURCE === 'none' ? '' : ` (from ${PERMISSION_MODE_SOURCE})`}`)
console.log(JSON.stringify(spec, null, 2))
