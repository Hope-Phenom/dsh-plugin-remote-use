/**
 * Tests for the worker-side environment check runner.
 *
 * The interesting cases are the FAILURE shapes: a missing `pwsh` must fall back to
 * `powershell.exe` (F46 -- the relay's fallback once returned the interpreter it had just failed to
 * find), and a missing/broken report must produce a reason, never a fabricated pass.
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolvePowerShell, runSelfcheck, summarizeReport } from '../lib/core/selfcheck-runner.js'

/** A stand-in for a spawned child that emits stdout/close on the next tick. */
function fakeChild({ stdout = '', code = 0 } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  queueMicrotask(() => {
    if (stdout !== '') child.stdout.emit('data', stdout)
    child.emit('close', code)
  })
  return child
}

async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'selfcheck-runner-'))
  try {
    // AWAIT: the callbacks are async, and deleting the directory before they finish is how the
    // first version of this helper made every case fail with ENOENT.
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('without PowerShell 7 the fallback is powershell.exe, not pwsh again', () => {
  // F46: returning 'pwsh' after failing to find it makes spawn fail and the missing report read
  // as "Unexpected end of JSON input".
  const stat = () => { throw new Error('ENOENT') }
  assert.equal(resolvePowerShell({ platform: 'win32', stat }), 'powershell.exe')
})

test('a real pwsh image is preferred, a 0-byte Store alias is not', () => {
  const stat = (path) => {
    if (path.endsWith('PowerShell\\7\\pwsh.exe')) return { isFile: () => true, size: 300_000 }
    return { isFile: () => true, size: 0 }
  }
  assert.equal(resolvePowerShell({ platform: 'win32', stat }), 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')

  const onlyAlias = (path) => {
    if (path.endsWith('WindowsApps\\pwsh.exe')) return { isFile: () => true, size: 0 }
    throw new Error('ENOENT')
  }
  assert.equal(resolvePowerShell({ platform: 'win32', stat: onlyAlias }), 'powershell.exe')
})

test('a missing script is reported as such, not as a failed check', async () => {
  const result = await runSelfcheck({ scriptPath: join(tmpdir(), 'no-such-selfcheck.ps1') })
  assert.equal(result.ok, false)
  assert.match(result.reason, /not found/u)
  assert.equal(result.report, null)
})

test('a report written next to the script is parsed and summarized', async () => {
  await withDir(async (dir) => {
    const script = join(dir, 'selfcheck.ps1')
    writeFileSync(script, '# fake\n', 'utf8')
    writeFileSync(join(dir, 'selfcheck.json'), JSON.stringify({
      verdict: 'blocked',
      blockingFailures: 1,
      warnings: 1,
      unchecked: 0,
      generatedAt: 't',
      checks: [
        { id: 'S1', status: 'fail', actual: '0 adapters', fix: 'install VDD' },
        { id: 'S2', status: 'warn', actual: 'WinDisc' },
        { id: 'S5', status: 'pass' },
      ],
    }), 'utf8')
    const result = await runSelfcheck({ scriptPath: script, spawn: () => fakeChild() })
    assert.equal(result.ok, true)
    assert.equal(result.report.verdict, 'blocked')

    const summary = summarizeReport(result.report)
    assert.equal(summary.verdict, 'blocked')
    assert.equal(summary.blockingFailures, 1)
    assert.equal(summary.warnings, 1)
    assert.deepEqual(summary.checks.map((c) => c.id), ['S1', 'S2', 'S5'])
  })
})

test('a report that is missing or not JSON says so instead of returning a fake pass', async () => {
  await withDir(async (dir) => {
    const script = join(dir, 'selfcheck.ps1')
    writeFileSync(script, '# fake\n', 'utf8')

    const missing = await runSelfcheck({ scriptPath: script, spawn: () => fakeChild({ code: 1 }) })
    assert.equal(missing.ok, false)
    assert.match(missing.reason, /no report/u)

    writeFileSync(join(dir, 'selfcheck.json'), '{ not json', 'utf8')
    const broken = await runSelfcheck({ scriptPath: script, spawn: () => fakeChild({ code: 0 }) })
    assert.equal(broken.ok, false)
    assert.match(broken.reason, /not valid JSON/u)
  })
})
