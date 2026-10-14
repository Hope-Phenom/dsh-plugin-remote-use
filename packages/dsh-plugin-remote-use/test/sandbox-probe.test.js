/**
 * Tests for the sandbox probe's decision logic.
 *
 * The behavioural half (does a confined command actually run) is verified live by
 * `tools/check-sandbox-ready.mjs`: it spawns real processes and touches the filesystem, so
 * faking it here would test the fake. What IS tested here is the part that decides the verdict
 * from what was found -- which is where a wrong answer would let a machine be armed on a
 * broken sandbox.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { profileNamesShim, probeSandbox, shimNamedByProfile, subsystemOf } from '../lib/core/sandbox-probe.js'

const SHIM = 'C:\\dsh-sandbox-mediator\\shim.mjs'

function withProfile(text, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-probe-'))
  const file = join(dir, 'cordis.patch.yml')
  try {
    if (text !== undefined) writeFileSync(file, text, 'utf8')
    return fn(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const GOOD_ENTRY = [
  '# a comment',
  '- id: sandbox',
  "  name: '@deepseek-ai/dsh-sandbox-local'",
  '  config:',
  '    runnerCommand:',
  '      - "C:\\\\Program Files\\\\nodejs\\\\node.exe"',
  `      - "${SHIM.replace(/\\/gu, '\\\\')}"`,
  '    runnerFailureSignatures:',
  '      - "windows-acl-run: "',
].join('\n')

test('a profile naming this shim is accepted', () => {
  withProfile(GOOD_ENTRY, (file) => {
    const result = profileNamesShim(file, SHIM)
    assert.equal(result.ok, true, result.reason)
  })
})

test('a profile with no sandbox entry at all is refused with the reason', () => {
  withProfile('- id: permission\n  name: x\n', (file) => {
    const result = profileNamesShim(file, SHIM)
    assert.equal(result.ok, false)
    assert.match(result.reason, /no sandbox entry/)
  })
})

test('a sandbox entry with no runnerCommand is refused', () => {
  withProfile("- id: sandbox\n  name: '@deepseek-ai/dsh-sandbox-local'\n  config:\n    probeTimeoutMs: 5000\n", (file) => {
    const result = profileNamesShim(file, SHIM)
    assert.equal(result.ok, false)
    assert.match(result.reason, /no sandbox entry with a runnerCommand/)
  })
})

test('a runnerCommand pointing somewhere else is refused', () => {
  // A stale mediator from a previous install would still look right by filename.
  const elsewhere = GOOD_ENTRY.replace('dsh-sandbox-mediator', 'dsh-old-mediator')
  withProfile(elsewhere, (file) => {
    const result = profileNamesShim(file, SHIM)
    assert.equal(result.ok, false)
    assert.match(result.reason, /different shim/)
  })
})

test('a runnerCommand naming neither a shim is refused', () => {
  const noShim = GOOD_ENTRY.replace(/.*shim\.mjs.*\n/u, '      - "C:\\\\other\\\\runner.exe"\n')
  withProfile(noShim, (file) => {
    const result = profileNamesShim(file, SHIM)
    assert.equal(result.ok, false)
    assert.match(result.reason, /does not name a shim/)
  })
})

test('runnerCommand without runnerFailureSignatures is refused', () => {
  // sandbox-local REJECTS that combination at construction, so a "wired" profile without it
  // would fail to load the plugin at all rather than fall back.
  const noSignatures = GOOD_ENTRY.replace(/    runnerFailureSignatures:[\s\S]*$/u, '')
  withProfile(noSignatures, (file) => {
    const result = profileNamesShim(file, SHIM)
    assert.equal(result.ok, false)
    assert.match(result.reason, /runnerFailureSignatures/)
  })
})

test('a missing or unreadable profile is reported, not thrown', () => {
  assert.match(profileNamesShim('', SHIM).reason, /no profile patch/)
  assert.match(profileNamesShim(join(tmpdir(), 'definitely-not-here-xyz.yml'), SHIM).reason, /no profile patch/)
  assert.match(profileNamesShim(undefined, SHIM).reason, /no profile patch/)
})

test('the probe reports a missing mediator instead of concluding anything', () => {
  // The important part: it must NOT return ok:true just because it could not check.
  const result = probeSandbox({ mediator: join(tmpdir(), 'no-such-mediator-xyz') })
  assert.equal(result.ok, false)
  assert.match(result.reason, /not materialized/)
  assert.equal(result.checks.some((c) => c.name === 'the mediator is materialized' && !c.ok), true)
})

// ---------------------------------------------------------------------------
// The profile is the SOURCE OF TRUTH for where the mediator lives
//
// This is the defect these tests exist for. probeSandbox used to require the hardcoded default:
//
//     const mediator = deps.mediator ?? 'C:\\dsh-sandbox-mediator'
//     ... if (!normalised.includes(shimPath)) -> 'runnerCommand names a different shim than ...'
//
// A worker whose mediator had been materialized to C:\dsh-remote\sandbox-mediator -- and whose acp
// profile correctly pointed there, and through which confined commands ran perfectly -- was refused
// with "the mediator works but DSH will not use it". Arming was impossible on a machine that was
// configured correctly.
//
// The safety concern the old check was reaching for ("a stale mediator would still look right by
// filename") is answered by the BEHAVIOURAL checks, which run a real command through whatever the
// profile names. A location check cannot answer it, and it rejects valid deployments.
// ---------------------------------------------------------------------------

const ELSEWHERE = 'C:\\dsh-remote\\sandbox-mediator\\shim.mjs'

// The same shape as GOOD_ENTRY, but with the mediator materialized somewhere the plugin does not
// hardcode -- which is how the real worker was set up.
const GOOD_ENTRY_ELSEWHERE = [
  '# a comment',
  '- id: sandbox',
  "  name: '@deepseek-ai/dsh-sandbox-local'",
  '  config:',
  '    runnerCommand:',
  '      - "C:\\\\Program Files\\\\nodejs\\\\node.exe"',
  '      - "C:\\\\dsh-remote\\\\sandbox-mediator\\\\shim.mjs"',
  '    runnerFailureSignatures:',
  '      - "windows-acl-run: "',
].join('\n')

test('a non-default mediator location named by the profile is read back correctly', () => {
  withProfile(GOOD_ENTRY_ELSEWHERE, (file) => {
    const named = shimNamedByProfile(file)
    assert.equal(named.ok, true, named.reason)
    assert.equal(named.shim, ELSEWHERE)
  })
})

test('the probe accepts a mediator at a non-default location when the profile names it', () => {
  // No deps.mediator: the profile alone must decide, which is exactly what used to fail.
  withProfile(GOOD_ENTRY_ELSEWHERE, (file) => {
    const result = probeSandbox({ profile: file, workspace: join(tmpdir(), 'sandbox-probe-nondefault') })
    assert.equal(result.config.ok, true, `config should accept the profile's own choice: ${result.config.reason}`)
    // It is not materialized at that path in this test, and the refusal must SAY SO and name the
    // path, so an operator can act on it. "unknown location" is the failure being replaced.
    assert.match(result.reason, /dsh-remote/u)
  })
})

test('the shim actually EXERCISED is the one the profile names, not the default', () => {
  // The strongest form of this guard, and the one that catches a regression: assert on the argv the
  // probe hands to spawn. Asserting on `config` alone is not enough -- config is derived from the
  // profile independently of which mediator gets used, so a regression that re-hardcoded the path
  // would leave config.ok true and still exercise the wrong shim.
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-nondefault-'))
  try {
    // A fake but structurally complete mediator, so the probe gets past "is it materialized".
    writeFileSync(join(dir, 'shim.mjs'), '// fake shim\n', 'utf8')
    const runnerDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib')
    mkdirSync(runnerDir, { recursive: true })
    writeFileSync(join(runnerDir, 'runner.js'), '// fake runner\n', 'utf8')

    const named = join(dir, 'shim.mjs')
    const entry = [
      '- id: sandbox',
      "  name: '@deepseek-ai/dsh-sandbox-local'",
      '  config:',
      '    runnerCommand:',
      `      - "${named.replace(/\\/gu, '\\\\')}"`,
      '    runnerFailureSignatures:',
      '      - "windows-acl-run: "',
    ].join('\n')

    withProfile(entry, (profileFile) => {
      const spawned = []
      const result = probeSandbox({
        profile: profileFile,
        workspace: join(tmpdir(), 'sandbox-probe-spawn-args'),
        spawn: (exe, args) => {
          spawned.push(args[0])
          // Answer like a healthy run, so the probe walks every check instead of bailing out.
          return { status: 0, stdout: 'sandbox-probe-alive wrote-ok read-only-alive refused: nope' }
        },
      })
      assert.ok(spawned.length > 0, 'the probe must actually run something')
      for (const shim of spawned) {
        assert.equal(shim, named, 'every confined command must go through the shim the profile names')
      }
      // And it must NOT be the hardcoded default, which is what the defect did.
      assert.equal(spawned.some((s) => s.includes('dsh-sandbox-mediator')), false)
      assert.equal(typeof result.ok, 'boolean')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a profile naming no sandbox entry says what to add, not just that something is missing', () => {
  withProfile('- id: permission\n  name: x\n', (file) => {
    const named = shimNamedByProfile(file)
    assert.equal(named.ok, false)
    assert.match(named.reason, /no sandbox entry/)
    assert.match(named.reason, /id: sandbox/u, 'the reason must say what to add')
  })
})

test('subsystemOf distinguishes a GUI image from a console one', () => {
  // The distinction is the whole defect, so it is asserted against real binaries on this host.
  const nodeExe = process.execPath
  const subsystem = subsystemOf(nodeExe)
  assert.equal(subsystem, 3, `${nodeExe} should be a console-subsystem image`)
  // A file that does not exist, or is not a PE, must report 0 rather than throw.
  assert.equal(subsystemOf(join(tmpdir(), 'not-a-pe-xyz.exe')), 0)
  assert.equal(subsystemOf(''), 0)
})
