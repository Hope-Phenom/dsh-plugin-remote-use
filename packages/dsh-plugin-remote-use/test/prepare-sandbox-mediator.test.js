/**
 * Tests for the shipped fixer's decisions that can be checked without a real app.asar.
 *
 * The extraction itself is verified live (it reads the running installation's archive and the
 * probe then executes a confined command through the result); faking that here would test the
 * fake. What IS tested here is the part that can silently do the wrong thing on a real machine:
 * which text is appended to an operator's profile, when the profile must NOT be touched, and that
 * `--dry-run` really writes nothing.
 */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  MANAGED_FOOTER,
  MANAGED_HEADER,
  appendEntry,
  hasSandboxEntry,
  main,
  sandboxEntry,
  stripEmptyListMarker,
} from '../lib/tools/prepare-sandbox-mediator.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RESEARCH_SHIM = join(PKG_ROOT, '..', '..', '.research', 'sandbox-mediator-shim.mjs')

const INSTALL = 'C:\\Program Files\\DeepSeek Harness'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const SHIM = 'C:\\dsh-sandbox-mediator\\shim.mjs'

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'prepare-mediator-'))
  try {
    return fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function profileFile(home) {
  return join(home, 'profiles', 'acp', 'cordis.patch.yml')
}

function writeProfile(home, text) {
  const file = profileFile(home)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
  return file
}

const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

test('the shipped shim is byte-identical to the research copy, which stays as the repro', () => {
  // Two copies is one more than the number of places this file can live. The .research copy is what
  // the deployment notes and the original investigation point at; this one is what ships and what
  // prepare-sandbox-mediator.mjs installs. A drift between them would mean "the documented shim"
  // and "the installed shim" are different programs.
  if (!existsSync(RESEARCH_SHIM)) return               // a published package has no .research/
  assert.equal(
    readFileSync(join(PKG_ROOT, 'lib', 'tools', 'mediator-shim.mjs'), 'utf8'),
    readFileSync(RESEARCH_SHIM, 'utf8'),
  )
})

test('a shipped profile template (`[]`) is not left in front of the appended block', () => {
  // DSH initialises a profile with a patch file whose whole content is `[]` -- an EMPTY LIST is a
  // complete YAML document. Appending after it produces a SECOND document with no `---`, which the
  // ACP child rejects while the structural probe is happy (PITFALLS F45, measured 2026-11-05).
  const entry = sandboxEntry({ nodeExe: NODE, shim: SHIM })
  const plain = appendEntry('[]\n', entry)
  assert.doesNotMatch(plain, /^\s*\[\]\s*$/mu, 'the empty-list marker must be gone')
  assert.ok(plain.startsWith(MANAGED_HEADER))

  const commented = appendEntry('# Your patch layer for this dsh profile\n[]\n', entry)
  assert.ok(commented.startsWith('# Your patch layer for this dsh profile'), 'the template comments survive')
  assert.doesNotMatch(commented, /^\s*\[\]\s*$/mu)
  // And the result is one list, not "array then entries": the entry follows the comments directly.
  assert.match(commented, /# Your patch layer for this dsh profile\n\n# --- dsh-plugin-remote-use managed/u)
})

test('stripEmptyListMarker removes only a standalone marker, and says whether it did', () => {
  assert.deepEqual(stripEmptyListMarker('[]\n'), { text: '', removed: true })
  assert.deepEqual(stripEmptyListMarker('packages:\n  - .\n'), { text: 'packages:\n  - .\n', removed: false })
  const mixed = stripEmptyListMarker('# c\n[]\n- id: sandbox\n')
  assert.equal(mixed.removed, true)
  assert.doesNotMatch(mixed.text, /^\s*\[\]\s*$/mu)
  assert.match(mixed.text, /- id: sandbox/u)
  // An inline empty value is not a standalone marker and must be left alone.
  const inline = stripEmptyListMarker('someKey: []\n')
  assert.equal(inline.removed, false)
})

test('the managed entry names BOTH halves of the mediator, with the failure signature', () => {
  const entry = sandboxEntry({ nodeExe: NODE, shim: SHIM })
  assert.match(entry, /- id: sandbox/u)
  assert.match(entry, /dsh-sandbox-local/u)
  // Backslashes are escaped for YAML double quotes; a single-backslash path is read correctly by
  // the structural scan and by sandbox-local, but writing it that way by hand is how one of the
  // earlier profiles ended up pointing at a nonexistent directory.
  assert.ok(entry.includes('"C:\\\\Program Files\\\\nodejs\\\\node.exe"'), entry)
  assert.ok(entry.includes('"C:\\\\dsh-sandbox-mediator\\\\shim.mjs"'), entry)
  assert.match(entry, /runnerFailureSignatures/u)
  assert.match(entry, /windows-acl-run: /u)
  assert.ok(entry.startsWith(MANAGED_HEADER), 'the block must be identifiable as managed')
  assert.ok(entry.endsWith(MANAGED_FOOTER))
})

test('an existing sandbox row is detected, and a COMMENTED one is not', () => {
  assert.equal(hasSandboxEntry('- id: sandbox\n  name: x\n'), true)
  assert.equal(hasSandboxEntry('# - id: sandbox\n- id: other\n'), false)
  assert.equal(hasSandboxEntry(''), false)
})

test('appending preserves the file, and leaves exactly one blank line before the block', () => {
  const entry = sandboxEntry({ nodeExe: NODE, shim: SHIM })
  assert.equal(appendEntry('', entry), `${entry}\n`)
  assert.equal(appendEntry('- id: acp\n', entry), `- id: acp\n\n${entry}\n`)
  // Trailing blank lines in the operator's file are normalised, not doubled.
  assert.equal(appendEntry('- id: acp\n\n\n', entry), `- id: acp\n\n${entry}\n`)
  // No BOM: a BOM here would make the profile unreadable (the project has hit that twice).
  assert.equal(appendEntry('', entry).charCodeAt(0), MANAGED_HEADER.charCodeAt(0))
})

test('--dry-run reports what it would do and writes NOTHING', () => {
  withHome((home) => {
    const lines = []
    const code = main(
      ['--dsh-home', home, '--profile', 'acp', '--install', INSTALL, '--dry-run'],
      {
        // Only the interpreter path "exists": there is no mediator here, which is the point.
        exists: (p) => /node\.exe$/iu.test(p),
        subsystem: () => 3,
        say: (line) => lines.push(line),
      },
    )
    assert.equal(code, 0)
    assert.equal(existsSync(join(home, 'sandbox-mediator')), false, 'no mediator directory')
    assert.equal(existsSync(profileFile(home)), false, 'no profile written')
    const text = lines.join('\n')
    assert.match(text, /would materialize/u)
    assert.match(text, /would append the managed sandbox block/u)
    assert.match(text, /dry run: nothing was written/u)
  })
})

test('a profile that already names a mediator is NEVER rewritten', () => {
  withHome((home) => {
    const before = [
      '- id: sandbox',
      "  name: '@deepseek-ai/dsh-sandbox-local'",
      '  config:',
      '    runnerCommand:',
      '      - "C:\\\\Program Files\\\\nodejs\\\\node.exe"',
      '      - "C:\\\\custom\\\\shim.mjs"',
      '    runnerFailureSignatures:',
      '      - "windows-acl-run: "',
    ].join('\n')
    const file = writeProfile(home, before)
    const digest = hash(file)
    const lines = []
    const code = main(
      ['--dsh-home', home, '--profile', 'acp', '--install', INSTALL, '--dry-run'],
      { exists: (p) => /node\.exe$/iu.test(p), subsystem: () => 3, say: (line) => lines.push(line) },
    )
    assert.equal(code, 0)
    assert.equal(hash(file), digest, 'the operator\'s wiring is the source of truth')
    assert.match(lines.join('\n'), /already names this shim/u)
  })
})

test('a sandbox row the script cannot use is refused, not doubled', () => {
  // Two entries for the same loader id are a merge nobody can predict from reading the file, so a
  // half-wired block is reported and left alone; the operator fixes that one.
  withHome((home) => {
    const file = writeProfile(home, [
      '- id: sandbox',
      "  name: '@deepseek-ai/dsh-sandbox-local'",
      '  config:',
      '    probeTimeoutMs: 5000',
    ].join('\n'))
    const digest = hash(file)
    const lines = []
    const code = main(
      ['--dsh-home', home, '--profile', 'acp', '--install', INSTALL, '--dry-run'],
      { exists: (p) => /node\.exe$/iu.test(p), subsystem: () => 3, say: (line) => lines.push(line) },
    )
    assert.equal(code, 1)
    assert.equal(hash(file), digest)
    assert.match(lines.join('\n'), /will not rewrite/u)
  })
})

test('a profile name that is a path is refused before anything is touched', () => {
  withHome((home) => {
    const lines = []
    const code = main(['--dsh-home', home, '--profile', '../acp', '--dry-run'], { say: (line) => lines.push(line) })
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /refusing profile name/u)
    assert.equal(existsSync(join(home, 'profiles')), false)
  })
})
