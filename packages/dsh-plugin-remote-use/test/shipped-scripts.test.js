/**
 * Guards on the files that ship to a worker.
 *
 * WHY THIS EXISTS: two bugs in a row were found by READING `selfcheck.ps1`, not by running
 * anything --
 *
 *   * S14 and S15 hardcoded `C:\Users\worker\...`, so on every other machine they reported "DSH not
 *     installed" and "no credentials" while DSH was running and a task had just completed. Four
 *     blocking failures on a machine that worked.
 *   * S18 hardcoded the reference worker's build output, so it warned "missing" everywhere.
 *
 * Both are the same shape: a machine-specific path baked into a script that runs on a different
 * machine. Neither errored. Neither was caught by 431 unit tests, because the scripts that carry
 * them have no tests at all -- PowerShell running on a worker is not reachable from this suite.
 *
 * So this file does not try to execute them. It asserts the one property that made both bugs
 * invisible: that no shipped script names a specific user's profile directory.
 */
import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SLAVE = join(PKG_ROOT, 'slave')

function listFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else if (statSync(full).isFile()) out.push(full)
  }
  return out
}

/**
 * `C:\Users\<name>\` where `<name>` is a real user name rather than a placeholder.
 *
 * The placeholders are allowed because documentation and tests legitimately use them; what must
 * not appear is a name that belongs to one particular machine.
 */
const HARDCODED_PROFILE = /[A-Za-z]:\\Users\\(?!<|%|\$|\{|\*)[A-Za-z0-9._-]+\\/gu
const PLACEHOLDER_USERS = new Set(['dev', 'public', 'default'])

test('no shipped script hardcodes a particular user profile path', () => {
  // `dev` is this development machine's user, and it is allowed as a placeholder in comments and
  // fixtures -- but the SLAVE scripts must derive from the environment, because they run on a
  // worker whose user is someone else's. The `sheng` case is the bug this guards.
  const offenders = []
  for (const file of listFiles(SLAVE)) {
    if (!/\.(ps1|mjs|js|json)$/u.test(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(HARDCODED_PROFILE)) {
      const user = match[0].slice('C:\\Users\\'.length, -1).toLowerCase()
      if (PLACEHOLDER_USERS.has(user)) continue
      // A comment that quotes the bug it fixed is not the bug.
      const lineStart = text.lastIndexOf('\n', match.index) + 1
      const line = text.slice(lineStart, text.indexOf('\n', match.index))
      if (/^\s*(#|\/\/|\*)/u.test(line)) continue
      offenders.push(`${file.slice(PKG_ROOT.length + 1)}: ${line.trim().slice(0, 90)}`)
    }
  }
  assert.deepEqual(offenders, [], `a worker script names a specific user's profile:\n${offenders.join('\n')}`)
})

test('the worker self-check derives its install and credential paths from the environment', () => {
  // Named explicitly rather than left to the scan above, so the intent survives a refactor of the
  // regex. These are the two checks that produced false blocking failures.
  const script = readFileSync(join(SLAVE, 'selfcheck.ps1'), 'utf8')
  assert.match(script, /Join-Path \$env:LOCALAPPDATA/u, 'S14 must derive the install directory')
  assert.match(script, /Join-Path \$env:USERPROFILE/u, 'S15 must derive the credentials path')
  // And the report must say WHERE it looked, so "signed out" is distinguishable from "looked in
  // the wrong place" -- the distinction that made the original failure hard to read.
  assert.match(script, /missing in:/u, 'S15 must list the paths it tried')
})

test('the target-app check is configurable and says which state it is in', () => {
  // Unconfigured is not the same as missing, and a check that warns on every machine teaches the
  // operator to stop reading the warnings.
  const script = readFileSync(join(SLAVE, 'selfcheck.ps1'), 'utf8')
  assert.match(script, /DSH_SELFCHECK_APP/u, 'S18 must be configurable from the environment')
  assert.match(script, /\[string\]\$App = ''/u, 'S18 must be configurable by parameter')
  assert.match(script, /not configured/u, 'unconfigured must be reported as such')
  assert.match(script, /missing at: /u, 'a configured-but-absent app must name the path')
})

test('param() is the first statement in the scripts that take parameters', () => {
  // PowerShell rejects `param()` after any executable statement, and PS 5.1 reports it as a
  // confusing "invalid assignment operator" at the lines that FOLLOW. The deploy gate catches it
  // too, but only when someone runs the gate.
  for (const name of ['selfcheck.ps1']) {
    const text = readFileSync(join(SLAVE, name), 'utf8')
    const paramAt = text.indexOf('param(')
    if (paramAt < 0) continue
    const before = text.slice(0, paramAt)
    for (const [index, line] of before.split('\n').entries()) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      assert.fail(`${name}: param() must precede every statement; line ${index + 1} is "${trimmed.slice(0, 60)}"`)
    }
  }
})
