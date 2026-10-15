/**
 * Tests for resolving this machine's own ACP launch spec.
 *
 * The hazard this guards is entirely about quoting. The install directory contains a space, and
 * building a command line out of it has already produced
 * `Cannot find module 'C:\Users\you\AppData\Local\Programs\DeepSeek'` -- an error that names the
 * module system while the real fault is a missing quote. So the assertions are about the ARRAY:
 * the path must survive as exactly one element.
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { acpLaunchSpec, installCandidates, resolveAcpLaunchSpec } from '../lib/core/self-acp-spec.js'

const INSTALL = 'C:\\Users\\you\\AppData\\Local\\Programs\\DeepSeek Harness'

test('the install path stays one argv element, not several', () => {
  const spec = acpLaunchSpec({ installDir: INSTALL })
  assert.equal(spec.command, `${INSTALL}\\DeepSeek Harness.exe`)
  // The .exe path is one element and contains the space intact.
  assert.equal(spec.command.includes('DeepSeek Harness.exe'), true)
  assert.equal(spec.args.filter((a) => a.includes('Programs\\DeepSeek')).length, 1)
  assert.equal(spec.args.some((a) => a === 'DeepSeek'), false, 'never split on the space')
})

test('the argv replicates the dsh.cmd shim, and never launches the .cmd', () => {
  const spec = acpLaunchSpec({ installDir: INSTALL })
  assert.equal(spec.args[0], '--expose-internals')
  assert.match(spec.args[1], /app\.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js$/u)
  assert.deepEqual(spec.args.slice(2), ['--profile', 'acp'])
  // Node refuses to spawn a `.cmd` without a shell, and `cmd /c` loses quotes on this path.
  assert.equal(spec.command.endsWith('.exe'), true)
  assert.equal(spec.command.endsWith('.cmd'), false)
})

test('ELECTRON_RUN_AS_NODE is set, because the executable is an Electron app', () => {
  const spec = acpLaunchSpec({ installDir: INSTALL })
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1')
})

test('the permission mode is passed to the CHILD only when asked for', () => {
  // dsh-base reads it from the environment, so an inherited value would silently decide the
  // child's sandbox and approval policy.
  assert.equal('DSH_PERMISSION_MODE' in acpLaunchSpec({ installDir: INSTALL }).env, false)
  assert.equal(acpLaunchSpec({ installDir: INSTALL, permissionMode: 'workspace-write' }).env.DSH_PERMISSION_MODE, 'workspace-write')
  assert.equal('DSH_PERMISSION_MODE' in acpLaunchSpec({ installDir: INSTALL, permissionMode: '' }).env, false)
})

test('a trailing separator on the install directory is normalised away', () => {
  for (const withSlash of [`${INSTALL}\\`, `${INSTALL}/`]) {
    assert.equal(acpLaunchSpec({ installDir: withSlash }).command, `${INSTALL}\\DeepSeek Harness.exe`)
  }
})

test('a profile name that could escape the profiles directory is refused', () => {
  // The value reaches an argv, but it also names a directory; `..\..\desktop` would run a
  // different profile than intended.
  for (const bad of ['..\\desktop', '../../desktop', 'a/b', 'a\\b', '', 'has space']) {
    assert.throws(() => acpLaunchSpec({ installDir: INSTALL, profile: bad }), /profile/u, `"${bad}" must be refused`)
  }
  assert.equal(acpLaunchSpec({ installDir: INSTALL, profile: 'acp' }).args[3], 'acp')
  assert.equal(acpLaunchSpec({ installDir: INSTALL, profile: 'my-profile.2' }).args[3], 'my-profile.2')
})

test('no install directory is an error, not an empty command', () => {
  assert.throws(() => acpLaunchSpec({}), /no install directory/u)
  assert.throws(() => acpLaunchSpec({ installDir: '' }), /no install directory/u)
})

test('install candidates are ordered, and env-derived ones come first', () => {
  const candidates = installCandidates({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })
  assert.equal(candidates[0], 'C:\\Users\\x\\AppData\\Local\\Programs\\DeepSeek Harness')
  assert.equal(candidates.some((c) => c.includes('Program Files')), true)
  // An explicit override wins.
  assert.equal(installCandidates({ DSH_INSTALL_DIR: 'D:\\dsh', LOCALAPPDATA: 'C:\\l' })[0], 'D:\\dsh')
  // No LOCALAPPDATA must not produce the string "undefined".
  const noLocal = installCandidates({})
  assert.equal(noLocal.some((c) => c.includes('undefined')), false)
})

test('resolveAcpLaunchSpec picks the first existing install and reports the ones it tried', () => {
  const missing = resolveAcpLaunchSpec({ env: {}, exists: () => false })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /could not find/u)
  assert.ok(missing.tried.length > 0, 'the caller needs to see where it looked')

  const found = resolveAcpLaunchSpec({
    // Must be the prefix that actually produces INSTALL, or the test asserts about a path it
    // never offered.
    env: { LOCALAPPDATA: 'C:\\Users\\you\\AppData\\Local' },
    exists: (p) => p === `${INSTALL}\\DeepSeek Harness.exe`,
  })
  assert.equal(found.ok, true, found.error)
  assert.equal(found.installDir, INSTALL)
  assert.equal(found.spec.command, `${INSTALL}\\DeepSeek Harness.exe`)
})

test('an explicit install directory is tried before the environment', () => {
  const explicit = 'D:\\other\\DeepSeek Harness'
  const resolved = resolveAcpLaunchSpec({
    installDir: explicit,
    env: { LOCALAPPDATA: 'C:\\l' },
    exists: (p) => p === `${explicit}\\DeepSeek Harness.exe`,
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.installDir, explicit)
})

test('an UNKNOWN permission mode is refused, never passed through', () => {
  // `dsh-base` validates the value at load and rejects the whole sandbox-policy row, so a typo would
  // start a worker whose session has NO resolved policy -- much harder to notice than a failed arm.
  // And it must not be coerced either: the caller's default is the UNRESTRICTED mode, so a silent
  // fallback would convert a typo into the widest possible access.
  for (const bad of ['yolo', 'full-access', 'danger_full_access', 'DANGER-FULL-ACCESS']) {
    assert.throws(() => acpLaunchSpec({ installDir: INSTALL, permissionMode: bad }),
      /not a sandbox mode DSH understands/u, `"${bad}" must be refused`)
  }
  assert.equal(acpLaunchSpec({ installDir: INSTALL, permissionMode: 'danger-full-access' }).env.DSH_PERMISSION_MODE, 'danger-full-access')
  assert.equal(acpLaunchSpec({ installDir: INSTALL, permissionMode: 'read-only' }).env.DSH_PERMISSION_MODE, 'read-only')
})

test('the mode is the ONLY thing the caller can put in the child environment', () => {
  // The env is handed to another process verbatim; an arbitrary pass-through here would be a way to
  // set any variable in the worker's agent. Pinned so adding a second knob is a deliberate act.
  assert.deepEqual(Object.keys(acpLaunchSpec({ installDir: INSTALL, permissionMode: 'workspace-write' }).env).sort(),
    ['DSH_PERMISSION_MODE', 'ELECTRON_RUN_AS_NODE'])
})

test('a bad profile is reported as a resolution failure, not thrown through', () => {
  const resolved = resolveAcpLaunchSpec({
    profile: '../escape',
    env: {},
    exists: () => true,
  })
  assert.equal(resolved.ok, false)
  assert.match(resolved.error, /profile/u)
})
