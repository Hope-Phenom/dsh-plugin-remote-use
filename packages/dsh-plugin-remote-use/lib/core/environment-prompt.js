/**
 * Build the "fix this worker's environment" prompt the operator can hand to the worker's own DSH
 * session.
 *
 * WHY IT IS GENERATED HERE AND NOT SHIPPED AS A STATIC BLOCK: the useful parts are FACTS of this
 * machine -- the selfcheck script's path, DSH_HOME, the armed task directory, and the last report.
 * A prompt with a placeholder path is the documentation that already failed (same rule as the
 * sandbox-mediator prescription).
 *
 * The long-form instructions live in `lib/tools/selfcheck-fix-prompt.md` (shipped), so the wording
 * can be edited without touching code; this module only prepends what is machine-specific.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @returns {string} absolute path of the shipped prompt body */
export function promptTemplatePath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'selfcheck-fix-prompt.md')
}

/**
 * One line per non-passing check, with its own `fix` text -- that is what makes the prompt
 * actionable instead of a generic checklist.
 *
 * @param {object | null} report
 * @param {string} [reason] why there is no report
 * @returns {string[]}
 */
export function formatReportSummary(report, reason = '') {
  if (report === null || report === undefined) {
    return [`- 自检没有产生报告：${reason === '' ? '未知原因' : reason}`]
  }
  const checks = Array.isArray(report.checks) ? report.checks : []
  const lines = [
    `- verdict: ${String(report.verdict ?? 'unknown')} | blocking=${Number(report.blockingFailures ?? 0)} warn=${Number(report.warnings ?? 0)} unchecked=${Number(report.unchecked ?? 0)}`,
  ]
  for (const check of checks) {
    if (String(check.status ?? '') === 'pass') continue
    const actual = String(check.actual ?? '').slice(0, 200)
    const fix = String(check.fix ?? '').slice(0, 200)
    lines.push(`- ${String(check.id ?? '?')} ${String(check.status ?? '?')}: ${actual}${fix === '' ? '' : ` (fix: ${fix})`}`)
  }
  return lines
}

/**
 * @param {object} opts
 * @param {object | null} [opts.report]
 * @param {string} [opts.reason]
 * @param {{ scriptPath?: string, home?: string, taskCwd?: string, pluginDir?: string }} [opts.facts]
 * @returns {{ text: string, scriptPath: string }}
 */
export function buildEnvironmentPrompt(opts = {}) {
  const facts = opts.facts ?? {}
  let body = ''
  try {
    body = readFileSync(promptTemplatePath(), 'utf8')
  } catch { /* the facts + report are still useful without the long form */ }
  const factsBlock = [
    '# 本机事实（插件自动填写，直接照做即可）',
    '',
    `- 插件目录：${String(facts.pluginDir ?? '')}`,
    `- 自检脚本：${String(facts.scriptPath ?? '')}`,
    `- DSH home：${String(facts.home ?? '')}`,
    `- 任务目录：${String(facts.taskCwd ?? '') === '' ? '(未设置)' : String(facts.taskCwd)}`,
    '',
    '## 最近一次自检',
    ...formatReportSummary(opts.report ?? null, String(opts.reason ?? '')),
    '',
    '---',
    '',
    body === '' ? '(提示词正文缺失：按上面报告的 fix 字段逐项处理，然后复跑 selfcheck.ps1。)' : body,
  ]
  return { text: factsBlock.join('\n'), scriptPath: String(facts.scriptPath ?? '') }
}
