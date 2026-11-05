/**
 * The workspace-integrity repair, and the mandatory-label behavior it exists for.
 *
 * WHY THERE IS A REAL PROCESS HERE: the defect is not "a function returned false". It is that
 * Windows launches an image carrying a Low mandatory label at Low integrity even when the parent
 * token is High -- so the only honest test is to label a directory, launch a copied signed binary,
 * repair the tree, and launch the same binary again. Everything else in this file exercises the
 * guards that keep the repair away from system directories.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isProtectedWorkspace, normalizePath, repairWorkspaceIntegrity } from '../slave/workspace-integrity.mjs'

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ru-workspace-integrity-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a system directory is never relabeled, but a user workspace is', () => {
  const env = {
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramData: 'C:\\ProgramData',
    USERPROFILE: 'C:\\Users\\someone',
  }
  for (const path of ['C:\\Windows', 'C:\\Windows\\System32', 'C:\\Program Files\\App', 'C:\\ProgramData\\x']) {
    assert.equal(isProtectedWorkspace(path, env), true, path)
  }
  // The profile ROOT is not a workspace, but a directory under it is.
  assert.equal(isProtectedWorkspace('C:\\Users\\someone', env), true)
  assert.equal(isProtectedWorkspace('C:\\Users\\someone\\work', env), false)
  assert.equal(isProtectedWorkspace('E:\\WorkSpace\\dsh-remote', env), false)
  // A drive root is not a workspace either.
  assert.equal(isProtectedWorkspace('E:\\', env), true)
  // Empty and non-strings are refused rather than guessed at.
  assert.equal(isProtectedWorkspace('', env), true)
  assert.equal(isProtectedWorkspace(undefined, env), true)
})

test('normalizePath is case-insensitive and drops a trailing separator', () => {
  assert.equal(normalizePath('E:\\WorkSpace\\App\\'), 'e:\\workspace\\app')
  assert.equal(normalizePath(''), '')
})

test('the repair does nothing unless the effective mode is full access', () => {
  const calls = []
  const spawn = (...args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' } }
  for (const mode of ['workspace-write', 'read-only', '', 'yolo']) {
    const result = repairWorkspaceIntegrity({ mode, dir: 'E:\\work', declared: true, spawn })
    assert.equal(result.applied, false, `mode ${mode} must not be repaired`)
    assert.equal(result.skipped, true)
    assert.match(result.reason, /confined|not set|Low label/u)
  }
  assert.deepEqual(calls, [], 'a confined workspace must keep its Low label')
})

test('the repair needs an explicit task directory unless forced', () => {
  const calls = []
  const spawn = (...args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' } }
  const inherited = repairWorkspaceIntegrity({ mode: 'danger-full-access', dir: 'E:\\work', declared: false, spawn })
  assert.equal(inherited.applied, false)
  assert.match(inherited.reason, /--task-dir/u)

  // `--repair-integrity` is the explicit opt-in for an inherited cwd. It still goes through the
  // protected-path guard, so this unit test uses a real directory.
  withDir((dir) => {
    const forced = repairWorkspaceIntegrity({ mode: 'danger-full-access', dir, declared: false, force: true, spawn })
    assert.equal(forced.applied, true, forced.error)
    assert.equal(calls.length, 1)
  })
})

test('the repair never runs for a protected path, even when forced', () => {
  const calls = []
  const spawn = (...args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' } }
  const result = repairWorkspaceIntegrity({
    mode: 'danger-full-access',
    dir: 'C:\\Windows\\System32',
    declared: true,
    force: true,
    spawn,
  })
  assert.equal(result.applied, false)
  assert.match(result.reason, /protected system location/u)
  assert.deepEqual(calls, [])
})

test('the repair builds the recursive relabel command and reports a refusal', () => {
  withDir((dir) => {
    const calls = []
    const spawn = (file, args) => {
      calls.push({ file, args })
      return { status: 0, stdout: '', stderr: '' }
    }
    const ok = repairWorkspaceIntegrity({ mode: 'danger-full-access', dir, declared: true, spawn })
    assert.equal(ok.applied, true, ok.error)
    assert.equal(ok.skipped, false)
    assert.equal(calls.length, 1)
    const { args } = calls[0]
    assert.equal(args[0], dir)
    assert.deepEqual(args.slice(1), ['/setintegritylevel', '(OI)(CI)Medium', '/T', '/C', '/Q'],
      'without /T a nested executable stays Low (measured)')

    const failed = repairWorkspaceIntegrity({
      mode: 'danger-full-access',
      dir,
      declared: true,
      spawn: () => ({ status: 5, stdout: '', stderr: 'access denied' }),
    })
    assert.equal(failed.applied, false)
    assert.match(failed.error, /access denied/u)
  })
})

test('the repair times out instead of hanging the relay forever', () => {
  withDir((dir) => {
    const result = repairWorkspaceIntegrity({
      mode: 'danger-full-access',
      dir,
      declared: true,
      spawn: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }),
    })
    assert.equal(result.applied, true, 'the command did start; what matters is that it was bounded')
    assert.equal(result.timedOut, true)
    assert.match(result.reason, /time limit/u)
  })
})

// ---------------------------------------------------------------------------
// The behavior the repair exists for, measured with the same mechanism as the self-check
// ---------------------------------------------------------------------------

function whoamiWithGroups(exe) {
  const run = spawnSync(exe, ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8' })
  return String(run.stdout ?? '')
}

test('a Low-labelled workspace downgrades a copied executable, and the repair restores it', { skip: process.platform !== 'win32' }, () => {
  withDir((dir) => {
    const setLabel = (level) => spawnSync('icacls.exe', [dir, '/setintegritylevel', `(OI)(CI)${level}`, '/T', '/C', '/Q'], { encoding: 'utf8' })
    const low = setLabel('Low')
    assert.equal(low.status, 0, String(low.stderr))

    const whoami = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe')
    const probe = join(dir, 'whoami.exe')
    copyFileSync(whoami, probe)
    const before = whoamiWithGroups(probe)
    assert.match(before, /S-1-16-4096/u, 'the copy must start Low: this is the defect being fixed')

    const result = repairWorkspaceIntegrity({ mode: 'danger-full-access', dir, declared: true })
    assert.equal(result.applied, true, result.error)

    const after = whoamiWithGroups(probe)
    assert.doesNotMatch(after, /S-1-16-4096/u, 'the existing executable must be relabeled too, not only the directory')
    assert.match(after, /S-1-16-(8192|12288|16384)/u, 'and must launch at Medium or above')
    assert.equal(existsSync(probe), true)
  })
})
