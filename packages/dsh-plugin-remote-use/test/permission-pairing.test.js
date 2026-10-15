/**
 * The deployment gate: can this worker's profile compose the mode we are about to request?
 *
 * WHY THIS IS TESTED AT ALL: the failure it prevents is a worker that becomes UNREACHABLE, and the
 * only reason anyone knows to look is PITFALLS F34 -- a piece of prose. A gate that silently stops
 * gating is indistinguishable from having no gate, and the whole point of putting it in
 * `make-launch-spec.mjs` was that nothing else in the system knows the deployment mode.
 *
 * The end-to-end cases run the REAL script against a temp DSH_HOME, because the interesting part is
 * whether it refuses and what it says, not whether a helper returns a boolean.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { PRESETS, SANDBOX_MODES, approvalPolicyFor, checkPairing, pinnedApprovalPolicy } from '../slave/permission-pairing.mjs'

const SLAVE = join(dirname(fileURLToPath(import.meta.url)), '..', 'slave')
const SCRIPT = join(SLAVE, 'make-launch-spec.mjs')

/** A profile patch shaped like the real one, with the approval row spelled as given. */
const profileWith = (policyLine) => `
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
  config:
    runnerCommand:
      - "C:\\\\Program Files\\\\nodejs\\\\node.exe"
      - "C:\\\\dsh-sandbox-mediator\\\\shim.mjs"
    runnerFailureSignatures:
      - "windows-acl-run: "
${policyLine}
`

const PINNED_ASK = profileWith(`- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: ask`)

const DERIVED = profileWith(`- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: !!js (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'`)

test('DSH\'s preset table is transcribed, not invented, and every mode the plugin can request appears in it', () => {
  // If DSH changes this table the gate is reading a stale world. Pinning the transcription here
  // means the change has to be acknowledged rather than absorbed silently.
  assert.deepEqual(PRESETS, [
    { name: 'read-only', sandbox: 'read-only', approval: 'ask' },
    { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
    { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
  ])
  for (const mode of SANDBOX_MODES) {
    assert.ok(PRESETS.some((p) => p.sandbox === mode), `no preset covers ${mode}`)
  }
  // The pairing dsh-base applies is itself one of the presets -- that identity is why a profile that
  // agrees with dsh-base can never compose an unknown combination.
  for (const mode of SANDBOX_MODES) {
    assert.ok(PRESETS.some((p) => p.sandbox === mode && p.approval === approvalPolicyFor(mode)),
      `dsh-base's own pairing for ${mode} is not a preset: the two halves of the composition disagree`)
  }
})

test('a pinned approval policy is detected, and a derived one is not mistaken for it', () => {
  assert.deepEqual(pinnedApprovalPolicy(PINNED_ASK), { kind: 'literal', value: 'ask' })
  assert.equal(pinnedApprovalPolicy(DERIVED).kind, 'derived')
  assert.equal(pinnedApprovalPolicy(profileWith('')).kind, 'absent')
  // A COMMENT quoting the fix is not the fix -- the same trap the plugin's own guard records.
  assert.equal(pinnedApprovalPolicy(`# policy: never\n- id: approval\n  config:\n    policy: ask`).value, 'ask')
  // And the variable in a nearby row must not be read as the approval row's own expression.
  assert.equal(pinnedApprovalPolicy(`${profileWith('')}\n- id: other\n  config:\n    x: !!js process.env.DSH_PERMISSION_MODE`).kind, 'absent')
})

test('the unpreset combination WARNS with the measured consequence, and never blocks', () => {
  const verdict = checkPairing({ mode: 'danger-full-access', profileText: PINNED_ASK, profilePath: 'P' })
  // NOT a block, and that is a measured decision rather than a lenient one: with this exact
  // mismatch the app starts, a session is created and a TURN completes, with the agent's own
  // runtime context reporting the requested mode as effective. Blocking would refuse a
  // configuration that demonstrably works.
  assert.equal(verdict.ok, true, 'a combination that has been measured to work must not be refused')
  assert.equal(verdict.severity, 'warn')
  assert.match(verdict.reason, /in NO configured preset/u)
  assert.match(verdict.reason, /acp-profile-approval\.patch\.yml/u, 'it must name the file that removes it')
  assert.match(verdict.reason, /MEASURED: the sandbox mode still applies and a turn still runs/u,
    'the warning must state the measured consequence, not the predicted one')
  // The claim the measurement disproved must not creep back in.
  assert.doesNotMatch(verdict.reason, /unreachable|did not activate/u,
    'the unreachable/failed-entry framing was replaced by what was measured')
})

test('every mode paired with the policy that profile will produce is judged by the table', () => {
  // `ok` means "not refused"; the nuance lives in `severity`, because the measured consequence of an
  // unpreset combination is a degraded entry rather than a broken worker.
  const verdictOf = (mode, profileText) => checkPairing({ mode, profileText })
  // A literal `ask` is silent for the two modes dsh-base pairs with `ask`, and warns for the third.
  assert.equal(verdictOf('workspace-write', PINNED_ASK).severity, 'ok')
  assert.equal(verdictOf('read-only', PINNED_ASK).severity, 'ok')
  assert.equal(verdictOf('danger-full-access', PINNED_ASK).severity, 'warn')
  // ...and the mirror image: a literal `never` is silent for full access and warns for the others.
  const pinnedNever = profileWith(`- id: approval
  config:
    policy: never`)
  assert.equal(verdictOf('danger-full-access', pinnedNever).severity, 'ok')
  assert.equal(verdictOf('workspace-write', pinnedNever).severity, 'warn')
  // Only an unknown mode is ever a refusal, because dsh-base will not load it at all.
  assert.equal(verdictOf('yolo', DERIVED).severity, 'block')
  // The recommended form agrees with dsh-base, so it is correct for every mode.
  for (const mode of SANDBOX_MODES) {
    assert.equal(checkPairing({ mode, profileText: DERIVED }).ok, true, `${mode} must pass with the derived form`)
  }
})

test('an unknown mode is blocked, because dsh-base rejects it at load', () => {
  const verdict = checkPairing({ mode: 'yolo', profileText: DERIVED })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.severity, 'block')
  assert.match(verdict.reason, /not a sandbox mode DSH understands/u)
})

test('an unreadable profile WARNS and does not block', () => {
  // Refusing on "cannot verify" would make a legitimate worker undeployable, and staying silent
  // would let the operator read silence as approval. Neither is acceptable, so it says which it is.
  const verdict = checkPairing({ mode: 'danger-full-access', profileText: undefined, profilePath: 'C:\\nope' })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.severity, 'warn')
  assert.match(verdict.reason, /NOT verified/u)
  assert.match(verdict.reason, /C:\\nope/u)
})

// ---------------------------------------------------------------------------
// the real script
// ---------------------------------------------------------------------------

function runScript(args, { profile }) {
  const dir = mkdtempSync(join(tmpdir(), 'ru-launch-spec-'))
  try {
    const home = join(dir, 'home')
    mkdirSync(join(home, 'profiles', 'acp'), { recursive: true })
    if (profile !== undefined) writeFileSync(join(home, 'profiles', 'acp', 'cordis.patch.yml'), profile, 'utf8')
    const out = join(dir, 'agent-spec.json')
    // `spawnSync`, not `execFileSync`: the latter hands back stdout only and THROWS on a non-zero
    // exit, so a successful run's stderr is silently unavailable -- which made the warning case
    // below read as "no warning" while the script was warning correctly.
    const proc = spawnSync(process.execPath, [SCRIPT, '--install', process.cwd(), '--out', out, '--dsh-home', home, ...args], {
      encoding: 'utf8', timeout: 60_000,
    })
    const result = {
      status: proc.status ?? 1,
      stdout: String(proc.stdout ?? ''),
      stderr: String(proc.stderr ?? ''),
      out,
    }
    try { result.spec = JSON.parse(readFileSync(out, 'utf8')) } catch { result.spec = undefined }
    return result
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the script WARNS but still writes the spec for the unpreset combination', () => {
  // The measurement decides this: a full-access worker with a profile pinned to `ask` runs, so the
  // gate must not stand between the operator and a working deployment. It says what will happen.
  const run = runScript(['--permission-mode', 'danger-full-access'], { profile: PINNED_ASK })
  assert.equal(run.status, 0, `the gate refused a configuration measured to work: ${run.stderr}`)
  assert.match(run.stderr, /WARNING/u)
  assert.match(run.stderr, /in NO configured preset/u)
  assert.match(run.stderr, /acp-profile-approval\.patch\.yml/u, 'the warning names the fix')
  assert.equal(run.spec?.env?.DSH_PERMISSION_MODE, 'danger-full-access', 'and the spec is written')
})

test('the script is silent when the profile carries the companion', () => {
  const run = runScript(['--permission-mode', 'danger-full-access'], { profile: DERIVED })
  assert.equal(run.status, 0, `expected success, got: ${run.stderr}`)
  assert.equal(run.spec.env.DSH_PERMISSION_MODE, 'danger-full-access')
  assert.equal(run.stderr, '', 'nothing to warn about')
})

test('the script still works for the mode it has always used, with the profile unchanged', () => {
  // The overwhelmingly common case: a workspace-write worker whose profile pins `ask`. The gate
  // must not turn a working deployment into a refused one.
  const run = runScript(['--permission-mode', 'workspace-write'], { profile: PINNED_ASK })
  assert.equal(run.status, 0, `the gate broke the default deployment: ${run.stderr}`)
  assert.equal(run.spec.env.DSH_PERMISSION_MODE, 'workspace-write')

  // ...and with no mode requested at all, which is the older invocation.
  const none = runScript([], { profile: PINNED_ASK })
  assert.equal(none.status, 0)
  assert.equal('DSH_PERMISSION_MODE' in none.spec.env, false)
})

test('a typo in --permission-mode is refused before it can reach dsh-base', () => {
  const run = runScript(['--permission-mode', 'yolo'], { profile: DERIVED })
  assert.equal(run.status, 3)
  assert.match(run.stderr, /not a sandbox mode DSH understands/u)
  assert.equal(run.spec, undefined)
})

test('a missing profile warns on stderr but still writes the spec', () => {
  const run = runScript(['--permission-mode', 'danger-full-access'], { profile: undefined })
  assert.equal(run.status, 0)
  assert.match(run.stderr, /WARNING/u)
  assert.match(run.stderr, /NOT verified/u)
  // The warning names the fix, because this is the path an operator on an unusual DSH_HOME takes.
  assert.match(run.stderr, /acp-profile-approval\.patch\.yml/u)
  assert.equal(run.spec.env.DSH_PERMISSION_MODE, 'danger-full-access')
})
