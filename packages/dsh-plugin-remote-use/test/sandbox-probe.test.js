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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { profileNamesShim, probeSandbox, subsystemOf } from '../lib/core/sandbox-probe.js'

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

test('subsystemOf distinguishes a GUI image from a console one', () => {
  // The distinction is the whole defect, so it is asserted against real binaries on this host.
  const nodeExe = process.execPath
  const subsystem = subsystemOf(nodeExe)
  assert.equal(subsystem, 3, `${nodeExe} should be a console-subsystem image`)
  // A file that does not exist, or is not a PE, must report 0 rather than throw.
  assert.equal(subsystemOf(join(tmpdir(), 'not-a-pe-xyz.exe')), 0)
  assert.equal(subsystemOf(''), 0)
})
