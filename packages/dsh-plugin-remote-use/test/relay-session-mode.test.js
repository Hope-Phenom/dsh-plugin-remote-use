/**
 * Wiring guards for the session-mode and workspace-integrity reporting.
 *
 * `slave/relay.mjs` cannot be imported by a test: it binds a port at module scope and exits without
 * a token. The functions it uses are tested directly (`permission-pairing.test.js`,
 * `workspace-integrity.test.js`); this file asserts the few lines that only exist in the relay and
 * the scripts -- the flags, the wiring, and the fields the master renders. These are guards against
 * a refactor quietly disconnecting a tested function from the process that needs it.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SLAVE = join(PKG_ROOT, 'slave')

const relay = readFileSync(join(SLAVE, 'relay.mjs'), 'utf8')
const selfcheck = readFileSync(join(SLAVE, 'selfcheck.ps1'), 'utf8')
const makeSpec = readFileSync(join(SLAVE, 'make-launch-spec.mjs'), 'utf8')
const index = readFileSync(join(PKG_ROOT, 'lib', 'index.js'), 'utf8')

test('the relay reads the machine\'s settings file and compares it with its own spec', () => {
  assert.match(relay, /--settings-file/u, 'the settings path must be overridable for a custom DSH_HOME')
  assert.match(relay, /settingsText: readSettingsText\(\)/u,
    'the comparison must read the settings file, not only the spec')
  assert.match(relay, /sessionModeMismatch: consistency\.mismatch/u,
    'the mismatch must be part of the report')
  assert.match(relay, /configuredSessionMode: consistency\.configured/u)
  // Read on EVERY selfcheck, not captured at startup: the page can save while the relay runs, and a
  // mismatch that only appears after a restart is the failure this exists to end.
  const selfcheckCase = relay.slice(relay.indexOf('case `${PLUGIN_PREFIX}selfcheck`'), relay.indexOf('case `${PLUGIN_PREFIX}pairing`'))
  assert.match(selfcheckCase, /sessionModeSnapshot\(\)/u, 'the self-check must re-read the settings file')
  assert.match(selfcheckCase, /withSessionModeCheck\(/u, 'the S19 row must be appended to the report')
  // And it must be loud at startup too, for a hand-managed relay nobody opens a page for.
  assert.match(relay, /STARTUP_MODE\.consistency\.mismatch/u)
  assert.match(relay, /does not match the/u)
})

test('the relay passes the task directory to the self-check so S20 measures the real workspace', () => {
  assert.match(relay, /selfcheckArgs\.push\('-Workspace', DECLARED_TASK_DIR\)/u,
    'the workspace probe must receive the ARMED task directory')
})

test('the relay repairs a stale Low label only through the guarded module', () => {
  assert.match(relay, /import \{ repairWorkspaceIntegrity \} from '\.\/workspace-integrity\.mjs'/u)
  assert.match(relay, /repairWorkspaceIntegrity\(\{/u)
  assert.match(relay, /mode: EFFECTIVE_MODE/u, 'the repair must use the EFFECTIVE mode, not the configured one')
  assert.match(relay, /declared: DECLARED_TASK_DIR !== null/u, 'an inherited cwd must not be relabeled by default')
  assert.match(relay, /--no-integrity-repair/u, 'the repair must be opt-out')
  assert.match(relay, /--repair-integrity/u)
  assert.match(relay, /integrityRepair: INTEGRITY_REPAIR/u, 'the report must say what the repair did')
})

test('the self-check probes launch integrity and carries the raw readings', () => {
  assert.match(selfcheck, /\[string\]\$Workspace = ''/u, 'S20 needs the task directory')
  assert.match(selfcheck, /integrity-probe\.ps1/u)
  assert.match(selfcheck, /Add-Check 'S20' 'workspace launch integrity'/u)
  assert.match(selfcheck, /workspace = \$Workspace/u, 'the report must say which directory was measured')
  assert.match(selfcheck, /integrity = \$integrity/u, 'the report must carry the workspace/temp/self readings')
  // It is a warning: a GUI failure is real, but it does not make the machine unreachable.
  assert.match(selfcheck, /Add-Check 'S20'[^\n]*'warning'/u)
})

test('make-launch-spec follows the saved setting when no flag is given', () => {
  assert.match(makeSpec, /--settings-file/u)
  assert.match(makeSpec, /workerSessionMode/u)
  assert.match(makeSpec, /PERMISSION_MODE_SOURCE = `settings: \$\{SETTINGS_FILE\}`/u)
  assert.match(makeSpec, /_permissionModeSource: PERMISSION_MODE_SOURCE/u,
    'the spec must record where its mode came from, so "why is it workspace-write" is answerable')
})

test('the worker role reports the listener status next to the arming status', () => {
  const arming = readFileSync(join(PKG_ROOT, 'lib', 'core', 'worker-arming.js'), 'utf8')
  assert.match(arming, /this\.listenerStatus = deps\.listenerStatus/u)
  assert.match(arming, /listener: this\.listenerStatus\(\)/u)
  const supervisor = readFileSync(join(PKG_ROOT, 'lib', 'core', 'relay-supervisor.js'), 'utf8')
  assert.match(supervisor, /sessionMode: this\.sessionMode/u)
  assert.match(supervisor, /sessionModeFrom: this\.sessionModeFrom/u)
})

test('the task directory is an explicit start argument, never a closure over `arming`', () => {
  // A restore calls `start()` while `apply()` is still constructing `arming`. A `taskDir` closure
  // that read `arming.taskCwd` therefore threw "Cannot access 'arming' before initialization",
  // and every restore of an armed worker failed. The state machine owns the value and passes it.
  assert.doesNotMatch(index, /taskDir:\s*\(\)\s*=>\s*arming\.taskCwd/u,
    'a closure over the not-yet-initialized arming binding is the restore TDZ bug')
  assert.match(index, /start: \(bindAddress, port, token, taskCwd\) => supervisor\.start\(bindAddress, port, token, taskCwd\)/u)
  const supervisor = readFileSync(join(PKG_ROOT, 'lib', 'core', 'relay-supervisor.js'), 'utf8')
  assert.match(supervisor, /start\(bindAddress, port, token, taskCwd\)/u)
  assert.match(supervisor, /taskCwd === undefined \? String\(this\.taskDir\(\) \?\? ''\)/u)
})
