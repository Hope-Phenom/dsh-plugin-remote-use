/**
 * Tests for the read-only sandbox diagnosis and the prescription it renders.
 *
 * The behavioural half (does the mediator actually confine) belongs to sandbox-probe.js and is
 * proven by running it; what is tested here is that the page can tell an operator WHICH of the
 * three layers is missing and hand them a command with every path already filled in. Getting that
 * wrong is not a cosmetic failure: it is the difference between a five-minute fix and the
 * three-layer riddle that this module replaced.
 *
 * The strongest assertion in this file is that the diagnosis writes NOTHING. It runs on every page
 * load, so a single accidental `mkdir` here would mutate the operator's machine on a page view.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { buildPrescription, inspectSandbox, prepareScriptPath } from '../lib/core/sandbox-diagnosis.js'

const INSTALL = 'C:\\Program Files\\DeepSeek Harness'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'

/** A fake home, cleaned up whatever the test does. */
function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'sandbox-diagnosis-'))
  try {
    return fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** Write an ACP profile patch that names `shim`, with the fields the probe requires. */
function wireProfile(home, shim, { signatures = true } = {}) {
  const file = join(home, 'profiles', 'acp', 'cordis.patch.yml')
  mkdirSync(dirname(file), { recursive: true })
  const quoted = (p) => p.replace(/\\/gu, '\\\\')
  writeFileSync(file, [
    '- id: sandbox',
    "  name: '@deepseek-ai/dsh-sandbox-local'",
    '  config:',
    '    runnerCommand:',
    `      - "${quoted(NODE)}"`,
    `      - "${quoted(shim)}"`,
    ...(signatures ? ['    runnerFailureSignatures:', '      - "windows-acl-run: "'] : []),
  ].join('\n'), 'utf8')
  return file
}

/** Create a structurally complete mediator at `dir` (contents never executed by this test). */
function materialize(dir) {
  mkdirSync(dirname(join(dir, 'shim.mjs')), { recursive: true })
  writeFileSync(join(dir, 'shim.mjs'), '// shim\n', 'utf8')
  const runnerDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib')
  mkdirSync(runnerDir, { recursive: true })
  writeFileSync(join(runnerDir, 'runner.js'), '// runner\n', 'utf8')
}

test('a factory-fresh machine is diagnosed as unwired, and the prescription names every path', () => {
  withHome((home) => {
    const diagnosis = inspectSandbox({ home, installDir: INSTALL, nodeExe: NODE, platform: 'win32' })
    assert.equal(diagnosis.state, 'unwired')
    assert.equal(diagnosis.ready, false)
    assert.equal(diagnosis.mediatorDir, join(home, 'sandbox-mediator'))

    const prescription = buildPrescription(diagnosis)
    // The script is shipped in the package, so the command works on a machine with only the plugin.
    assert.match(prescription.command, /prepare-sandbox-mediator\.mjs/u)
    assert.ok(prescription.command.includes(prepareScriptPath()))
    // Every fact is FILLED IN. A prompt with a placeholder path is the documentation that failed.
    assert.ok(prescription.text.includes(home), 'the DSH home must appear')
    assert.ok(prescription.text.includes(diagnosis.profilePath), 'the profile path must appear')
    assert.ok(prescription.text.includes(INSTALL), 'the installation directory must appear')
    assert.match(prescription.text, /--profile acp/u)
    assert.match(prescription.text, /点「先检查」/u)
  })
})

test('a profile naming a mediator that is not there is "missing", and points at THAT directory', () => {
  withHome((home) => {
    const elsewhere = join(home, 'custom-mediator', 'shim.mjs')
    wireProfile(home, elsewhere)
    const diagnosis = inspectSandbox({ home, installDir: INSTALL, nodeExe: NODE, platform: 'win32' })
    assert.equal(diagnosis.state, 'missing')
    // The operator's wiring is the source of truth: the prescription must not send them to the
    // default directory, which would materialize a second mediator the profile never names.
    assert.equal(diagnosis.mediatorDir, dirname(elsewhere))
    assert.match(buildPrescription(diagnosis).command, /--dsh-home/u)
  })
})

test('a materialized mediator named by the profile is ready', () => {
  withHome((home) => {
    const dir = join(home, 'mediator')
    materialize(dir)
    wireProfile(home, join(dir, 'shim.mjs'))
    const diagnosis = inspectSandbox({ home, installDir: INSTALL, nodeExe: NODE, platform: 'win32' })
    assert.equal(diagnosis.state, 'ready')
    assert.equal(diagnosis.ready, true)
    assert.equal(diagnosis.reason, '')
  })
})

test('a wired-looking profile without runnerFailureSignatures is unwired, not ready', () => {
  // sandbox-local rejects that combination at construction, so "the files exist" alone would arm a
  // machine whose sandbox never loads.
  withHome((home) => {
    const dir = join(home, 'mediator')
    materialize(dir)
    wireProfile(home, join(dir, 'shim.mjs'), { signatures: false })
    const diagnosis = inspectSandbox({ home, installDir: INSTALL, nodeExe: NODE, platform: 'win32' })
    assert.equal(diagnosis.state, 'unwired')
    assert.match(diagnosis.reason, /runnerFailureSignatures/u)
  })
})

test('an unsupported host says so instead of prescribing a Windows directory', () => {
  withHome((home) => {
    const foreign = inspectSandbox({ home, installDir: INSTALL, nodeExe: NODE, platform: 'linux' })
    assert.equal(foreign.state, 'unsupported')
    assert.match(foreign.reason, /Windows/u)

    const noInstall = inspectSandbox({ home, installDir: '', nodeExe: '', platform: 'win32' })
    assert.equal(noInstall.state, 'unsupported')
    assert.match(noInstall.reason, /DeepSeek Harness/u)
  })
})

test('the diagnosis is READ-ONLY: a page load must not create anything', () => {
  withHome((home) => {
    const before = readdirSync(home)
    inspectSandbox({ home, installDir: INSTALL, nodeExe: NODE, platform: 'win32' })
    buildPrescription(inspectSandbox({ home, installDir: INSTALL, nodeExe: NODE, platform: 'win32' }))
    assert.deepEqual(readdirSync(home), before)
    assert.equal(existsSync(join(home, 'sandbox-mediator')), false, 'no mediator directory may be created')
    assert.equal(existsSync(join(home, 'profiles')), false, 'no profile may be created')
  })
})
