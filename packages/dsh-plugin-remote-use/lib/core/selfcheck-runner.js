/**
 * Run the WORKER's own readiness self-check (`slave/selfcheck.ps1`) from the plugin host.
 *
 * WHY THE WORKER RUNS IT, RATHER THAN THE MASTER: the checks are about THIS machine's session,
 * display and input (S1-S12). The master can only see the report the worker sends; running the
 * script here means the "先检查" result reflects the same interactive session the relay will use,
 * and the worker can hand back a fix prompt without a round trip.
 *
 * WHY NOT ON EVERY PAGE LOAD, AND WHY NOT AS AN ARMING GATE: `S8` moves the mouse for real, and
 * the session checks depend on somebody being logged in and unlocked -- an OPERATIONAL state that
 * can legitimately change after arming. So this runs on an explicit check and is ADVISORY; the
 * master's dispatch gate stays the hard gate.
 */
import { spawn as spawnChild } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The PowerShell to run the helper scripts with.
 *
 * `pwsh` (7) is preferred because Windows PowerShell 5.1 is blocked by a PATH-based rule on some
 * volumes (see the relay's note). The FALLBACK MUST BE `powershell.exe`: returning `'pwsh'` when it
 * was not found is the F46 defect -- the process failed to spawn and the missing report was then
 * reported as a JSON parse error.
 *
 * @param {object} [deps] injectable for tests
 * @returns {string}
 */
export function resolvePowerShell(deps = {}) {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return 'pwsh'
  const stat = deps.stat ?? statSync
  const programFiles = deps.programFiles ?? process.env.ProgramFiles ?? 'C:\\Program Files'
  const localAppData = deps.localAppData ?? process.env.LOCALAPPDATA ?? ''
  const candidates = [
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    localAppData === '' ? '' : join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
  ].filter((candidate) => candidate !== '')
  for (const candidate of candidates) {
    try {
      const info = stat(candidate)
      // A Store execution alias is a 0-byte reparse point; spawning it opens the Store.
      if (info.isFile() && info.size > 0) return candidate
    } catch { /* not there */ }
  }
  return 'powershell.exe'
}

/**
 * The subset of a report the page needs: the verdict, the counts, and the checks that are not OK.
 *
 * @param {object} report parsed `selfcheck.json`
 * @returns {{ verdict: string, blockingFailures: number, warnings: number, unchecked: number,
 *             generatedAt: string, checks: object[] }}
 */
export function summarizeReport(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  return {
    verdict: String(report?.verdict ?? 'unknown'),
    blockingFailures: Number(report?.blockingFailures ?? 0),
    warnings: Number(report?.warnings ?? 0),
    unchecked: Number(report?.unchecked ?? 0),
    generatedAt: String(report?.generatedAt ?? ''),
    // Everything, not only the failures: the page can then explain "S7 unchecked" as its own
    // state instead of leaving it out and looking like it passed.
    checks,
  }
}

/**
 * Run the script and parse the JSON it writes next to itself.
 *
 * The script writes `selfcheck.json` in its own directory (the relay reads it the same way), so
 * stdout -- which also carries the human-readable twin -- is not the source of truth.
 *
 * @param {object} opts
 * @param {string} opts.scriptPath
 * @param {string} [opts.workspace]  task directory handed to `-Workspace`
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.powershell]
 * @param {Function} [opts.spawn] injected for tests
 * @returns {Promise<{ ok: boolean, reason: string, report: object | null }>}
 */
export async function runSelfcheck(opts = {}) {
  const scriptPath = String(opts.scriptPath ?? '')
  if (scriptPath === '' || !existsSync(scriptPath)) {
    return { ok: false, reason: `selfcheck script not found at ${scriptPath || '(empty path)'}`, report: null }
  }
  const powershell = opts.powershell ?? resolvePowerShell()
  const workspace = String(opts.workspace ?? '').trim()
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
  if (workspace !== '') args.push('-Workspace', workspace)
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : 60_000
  const spawn = opts.spawn ?? spawnChild

  const run = await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }
    let child
    try {
      child = spawn(powershell, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ error: error instanceof Error ? error.message : String(error), stdout, stderr })
      return
    }
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => finish({ error: error instanceof Error ? error.message : String(error), stdout, stderr }))
    child.on('close', (code) => finish({ code, stdout, stderr }))
    timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish({ error: `timed out after ${timeoutMs}ms`, stdout, stderr })
    }, timeoutMs)
  })

  if (run.error !== undefined) {
    return { ok: false, reason: `could not run ${powershell}: ${run.error}`, report: null }
  }

  const jsonPath = join(dirname(scriptPath), 'selfcheck.json')
  let text = ''
  try {
    text = readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/u, '')
  } catch (error) {
    const tail = String(run.stderr ?? '').trim().split(/\r?\n/u).slice(-2).join(' / ')
    return {
      ok: false,
      reason: `the self-check produced no report at ${jsonPath} (exit ${run.code ?? '?'})${tail === '' ? '' : `: ${tail}`}`,
      report: null,
    }
  }
  try {
    return { ok: true, reason: '', report: JSON.parse(text) }
  } catch (error) {
    const tail = String(run.stderr ?? '').trim().split(/\r?\n/u).slice(-2).join(' / ')
    return {
      ok: false,
      reason: `the self-check report is not valid JSON (exit ${run.code ?? '?'}): ${error instanceof Error ? error.message : String(error)}${tail === '' ? '' : ` -- ${tail}`}`,
      report: null,
    }
  }
}
