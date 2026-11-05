/**
 * The environment fix prompt must carry THIS machine's facts and the last report -- a prompt with
 * placeholder paths is the documentation that already failed (same rule as the mediator
 * prescription).
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { buildEnvironmentPrompt, formatReportSummary, promptTemplatePath } from '../lib/core/environment-prompt.js'

const FACTS = {
  scriptPath: 'C:\\Users\\dev\\.dsh\\profiles\\desktop\\node_modules\\@hope_phenom\\dsh-plugin-remote-use\\slave\\selfcheck.ps1',
  home: 'C:\\Users\\dev\\.dsh',
  taskCwd: 'D:\\DSH_HOME',
  pluginDir: 'C:\\Users\\dev\\.dsh\\profiles\\desktop\\node_modules\\@hope_phenom\\dsh-plugin-remote-use',
}

test('the prompt carries the machine facts and the report summary', () => {
  const report = {
    verdict: 'blocked',
    blockingFailures: 2,
    warnings: 1,
    unchecked: 0,
    checks: [
      { id: 'S1', status: 'fail', actual: '0 adapters', fix: 'install VDD' },
      { id: 'S2', status: 'fail', actual: 'WinDisc', fix: 'enable VDD' },
      { id: 'S10', status: 'warn', actual: '1', fix: 'ScreenSaveActive=0' },
      { id: 'S5', status: 'pass' },
    ],
  }
  const prompt = buildEnvironmentPrompt({ report, facts: FACTS })
  assert.equal(prompt.scriptPath, FACTS.scriptPath)
  assert.ok(prompt.text.includes(FACTS.scriptPath), 'the selfcheck path must be filled in')
  assert.ok(prompt.text.includes(FACTS.home), 'the DSH home must be filled in')
  assert.ok(prompt.text.includes(FACTS.taskCwd), 'the task directory must be filled in')
  assert.match(prompt.text, /verdict: blocked \| blocking=2 warn=1/mu)
  assert.match(prompt.text, /S1 fail: 0 adapters \(fix: install VDD\)/u)
  assert.match(prompt.text, /S10 warn/u)
  // Passing checks are not repeated as work items.
  assert.doesNotMatch(prompt.text, /S5 pass/u)
  // The long-form body is included, not replaced.
  assert.ok(prompt.text.includes('第 0 步'), 'the shipped prompt body must be appended')
})

test('a missing report is stated as such, with its reason', () => {
  const prompt = buildEnvironmentPrompt({ report: null, reason: 'powershell.exe not found', facts: FACTS })
  assert.match(prompt.text, /自检没有产生报告：powershell\.exe not found/u)
})

test('the summary keeps every non-passing check, including unchecked ones', () => {
  const lines = formatReportSummary({
    verdict: 'warn',
    blockingFailures: 0,
    warnings: 0,
    unchecked: 2,
    checks: [
      { id: 'S7', status: 'unchecked', actual: 'n/a in system session' },
      { id: 'S8', status: 'pass' },
    ],
  })
  assert.ok(lines.some((line) => /S7 unchecked/u.test(line)))
  assert.ok(!lines.some((line) => /S8/u.test(line)))
})

test('the shipped template exists', () => {
  assert.ok(promptTemplatePath().endsWith('selfcheck-fix-prompt.md'))
})
