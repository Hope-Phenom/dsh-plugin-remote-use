/**
 * Guards for the self-check's PowerShell launch path.
 *
 * `relay.mjs` binds a port at module scope and cannot be imported, so this reads the source --
 * the technique `relay-session-mode.test.js` already uses for the same reason.
 *
 * THE DEFECT THESE PIN (measured 2026-11-05, a fresh worker with no PowerShell 7): the fallback
 * after the `pwsh` candidates returned `'pwsh'` again, so `spawn('pwsh')` failed with ENOENT, the
 * script never ran, no `selfcheck.json` was written, and S0 reported
 * `Unexpected end of JSON input` -- a message about the report rather than about the cause.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SLAVE = join(dirname(fileURLToPath(import.meta.url)), '..', 'slave')
const relay = readFileSync(join(SLAVE, 'relay.mjs'), 'utf8')

test('the PowerShell fallback is powershell.exe, because every Windows install has it', () => {
  assert.match(relay, /return 'powershell\.exe'/u)
  // The old fallback returned the same interpreter it had just failed to find.
  assert.doesNotMatch(relay, /return 'pwsh' \/\/ on PATH/u)
})

test('a spawn failure is its own S0, and it names the interpreter it tried', () => {
  assert.match(relay, /name: 'self-check script ran'/u)
  assert.match(relay, /expected: PS_EXE/u)
  assert.match(relay, /self-check spawn error/u)
})

test('a non-JSON report carries the exit code and the script stderr, not just the parse error', () => {
  // "Unexpected end of JSON input" is the answer to a different question; these are the fields
  // that answer "did the script run, and what did it say".
  assert.match(relay, /ps\.stderr\.on\('data'/u)
  assert.match(relay, /stderrTail/u)
})
