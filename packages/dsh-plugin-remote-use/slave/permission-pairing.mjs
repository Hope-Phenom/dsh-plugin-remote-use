// permission-pairing.mjs -- will this worker's DSH profile accept the mode we are about to request?
//
// WHY THIS EXISTS (PITFALLS F34): `dsh-base` derives BOTH the sandbox mode and the approval policy
// from `DSH_PERMISSION_MODE`:
//
//   cordis.patch.yml:232   sandbox-policy.mode = process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
//   cordis.patch.yml:248   approval.policy     = (that value === 'danger-full-access') ? 'never' : 'ask'
//
// and the `permission` row ships a fixed table of presets, with NO `defaultPreset`:
//
//   read-only           -> sandbox: read-only,          approval: ask
//   workspace-write     -> sandbox: workspace-write,    approval: ask
//   danger-full-access  -> sandbox: danger-full-access, approval: never
//
// A worker profile patch that PINS `policy` to a literal value stops the two halves from moving
// together. Request `danger-full-access` against a profile pinned to `ask` and the composition is
// (danger-full-access, ask), which is in no preset -- and `dsh-permission-presets` documents
// `defaultPreset` as required "when composition defaults match no preset", so the service can fail
// to load, the ACP process never comes up and the worker is simply GONE. That is the F24 shape: a
// configuration combination that stops the whole application, presenting as "the worker broke".
//
// WHY THE CHECK IS STILL AT THE SPEC BUILD: the plugin does know the mode it asked for (0.2.15),
// but a hand-managed relay and the manual generator do not go through the plugin at all. The spec
// generator is the one place every deployment passes through, and it can read the profile that must
// compose the mode -- so it is where the gate can cover both the supervised and the manual paths.
// Putting it only in the plugin would leave the hand-managed deployment ungated.

/** Every file-effect sandbox mode DSH understands. Mirrors `SANDBOX_MODES` in dsh-sandbox-policy. */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * DSH's own preset table, as composed in the acp profile.
 *
 * Transcribed from `dsh --profile acp --dump-config` (the `permission` row) rather than guessed.
 * `auto` is deliberately absent: its identity is fixed inside the preset service and only exists
 * while the Auto review integration is live, which this profile does not compose.
 */
export const PRESETS = [
  { name: 'read-only', sandbox: 'read-only', approval: 'ask' },
  { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
  { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
]

/** The approval policy `dsh-base` pairs with a mode. */
export function approvalPolicyFor(mode) {
  return mode === 'danger-full-access' ? 'never' : 'ask'
}

/**
 * The sandbox mode a child spawned by the relay will ACTUALLY get, and where it came from.
 *
 * THIS IS THE QUESTION THAT KEPT BEING ANSWERED WRONGLY. The relay spawns the ACP child with
 * `{ ...process.env, ...LAUNCH.env }`, so the spec wins over the relay's own environment -- and
 * neither of those is "the file someone edited". Measured 2026-10-15: an operator changed
 * `C:\dsh-remote\plugin-slave\agent-spec.json` while the live relay had been started with a TEMP
 * spec (`...\Temp\...\acp-spec-<pid>-<port>.json`, rewritten on every arm) that nothing re-read, so
 * "the file says full access" and "the session runs workspace-write" were BOTH true for hours.
 *
 * @param {{ specEnv?: object, env?: object }} sources
 * @returns {{ mode: string, from: 'spec' | 'relay-env' | 'nothing' }}
 */
export function effectiveSessionMode(sources = {}) {
  const spec = sources.specEnv?.DSH_PERMISSION_MODE
  if (typeof spec === 'string' && spec !== '') return { mode: spec, from: 'spec' }
  const env = sources.env?.DSH_PERMISSION_MODE
  if (typeof env === 'string' && env !== '') return { mode: env, from: 'relay-env' }
  // Empty means the child falls through to `dsh-base`'s own default, which is workspace-write.
  // Reported as '' rather than as that default, so a reader can tell "not set here" from "set here".
  return { mode: '', from: 'nothing' }
}

/**
 * The mode the OPERATOR configured for this machine, read from the plugin's settings file.
 *
 * WHY THE RELAY READS THIS AT ALL: a hand-run relay (a scheduled task with `--cmd-file
 * agent-spec.json`) is started outside the plugin, so `workerSessionMode` can be changed on the
 * settings page without anything rewriting that spec. The result is the exact failure this project
 * already recorded once (PITFALLS F38): "the setting says full access" and "the spec says
 * workspace-write" are both true, for as long as nobody restarts anything, and neither side says so.
 *
 * The relay is the process that can answer the question from the machine itself: it has the spec it
 * will actually spawn, and it can read the same settings file the plugin writes.
 *
 * @param {object} sources
 * @param {object} [sources.specEnv] the launch spec's `env`, which wins when it sets the mode
 * @param {object} [sources.env] the relay's own environment
 * @param {string} [sources.settingsText] the settings file contents, or '' when it does not exist
 * @returns {{
 *   effective: { mode: string, from: 'spec' | 'relay-env' | 'nothing' },
 *   effectiveMode: string,
 *   configured: string,
 *   settingsError: string,
 *   mismatch: boolean
 * }}
 */
export function sessionModeConsistency(sources = {}) {
  const effective = effectiveSessionMode(sources)
  // DSH's own default is workspace-write. Treating "nothing set" as that value is what lets a
  // machine configured for workspace-write match an old spec that carries no variable at all.
  const effectiveMode = effective.mode === '' ? 'workspace-write' : effective.mode
  let configured = ''
  let settingsError = ''
  if (typeof sources.settingsText === 'string' && sources.settingsText !== '') {
    try {
      const parsed = JSON.parse(sources.settingsText)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.workerSessionMode === 'string') {
        configured = parsed.workerSessionMode
      }
    } catch (error) {
      // A corrupt settings file is reported as its own fact. It must not be read as "not
      // configured": those are different states, and only one of them means the operator has no
      // opinion about the mode.
      settingsError = `settings file is unreadable: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return {
    effective,
    effectiveMode,
    configured,
    settingsError,
    // Only a configured value can be wrong. With none, the relay has nothing to disagree with.
    mismatch: configured !== '' && configured !== effectiveMode,
  }
}

/**
 * The self-check row that makes a configured/effective mismatch visible in the report the master
 * already renders.
 *
 * Returns null when the operator has not configured a mode: an unconfigured relay should not gain a
 * warning row that says nothing. The row is `warning`, not `blocking`: the relay still works, it is
 * running at the wrong level, and that is exactly the state the operator has to be told about.
 *
 * @param {ReturnType<typeof sessionModeConsistency>} state
 * @param {{ specPath?: string }} [meta]
 * @returns {object | null}
 */
export function sessionModeCheck(state, meta = {}) {
  if (state === null || state === undefined || state.configured === '') return null
  const from = state.effective.from === 'nothing'
    ? 'nothing set in the spec or relay env, so DSH defaults to workspace-write'
    : `from ${state.effective.from}`
  return {
    id: 'S19',
    name: 'launch spec matches configured session mode',
    severity: 'warning',
    status: state.mismatch ? 'warn' : 'pass',
    expected: `configured ${state.configured}`,
    actual: `effective ${state.effectiveMode} (${from})${meta.specPath ? `; spec ${meta.specPath}` : ''}`,
    fix: state.mismatch
      ? `re-generate the launch spec from the saved setting on the worker `
        + `(node slave/make-launch-spec.mjs --out <spec>), then restart the relay. `
        + `The relay would spawn ${state.effectiveMode} while this machine is configured for ${state.configured}.`
      : '',
  }
}

/**
 * The approval policy a profile patch PINS, if it pins one at all.
 *
 * A structural scan, not a YAML parse, for the same reason `shimNamedByProfile` is one: this runs on
 * a worker with no dependencies, and the shape is a handful of lines.
 *
 * `derived` means the profile reaches for `DSH_PERMISSION_MODE` itself, i.e. it agrees with
 * `dsh-base` and moves with the mode -- which is the form the shipped snippet recommends.
 *
 * @param {string} text the profile patch's contents
 * @returns {{ kind: 'literal' | 'derived' | 'absent', value: string }}
 */
export function pinnedApprovalPolicy(text) {
  if (typeof text !== 'string') return { kind: 'absent', value: '' }
  // The approval row's own `policy:` line. `[\s\S]` rather than `.` so a commented-out line cannot
  // be mistaken for the real one; comments are dropped first for the same reason the plugin's
  // guard drops them: the comments quote the forms they replace.
  const body = text.split('\n').filter((line) => !/^\s*#/u.test(line)).join('\n')
  const entry = /-\s*id:\s*approval\b[\s\S]{0,600}?\n\s*policy:\s*([^\n]+)/u.exec(body)
  if (entry === null) return { kind: 'absent', value: '' }
  const raw = entry[1].trim()
  if (raw.includes('DSH_PERMISSION_MODE')) return { kind: 'derived', value: raw }
  // Strip an inline comment and the YAML tag if one is present, then unquote.
  const value = raw.replace(/\s+#.*$/u, '').replace(/^!!js\s+/u, '').replace(/^["']|["']$/gu, '').trim()
  return { kind: 'literal', value }
}

/**
 * Would requesting `mode` against this profile compose a pairing DSH accepts?
 *
 * @param {{ mode: string, profileText: string | undefined, profilePath?: string }} request
 * @returns {{ ok: boolean, severity: 'ok' | 'block' | 'warn', reason: string }}
 */
export function checkPairing(request) {
  const mode = String(request.mode ?? '')
  if (mode === '') return { ok: true, severity: 'ok', reason: '' }
  if (!SANDBOX_MODES.includes(mode)) {
    return {
      ok: false,
      severity: 'block',
      reason: `"${mode}" is not a sandbox mode DSH understands. dsh-base rejects an unknown value at load, so this would stop the worker's ACP process from starting. Use one of: ${SANDBOX_MODES.join(', ')}`,
    }
  }
  const pinned = pinnedApprovalPolicy(request.profileText)
  if (pinned.kind === 'absent') {
    // Cannot verify is not the same as verified. Say which, so nobody reads silence as approval.
    return {
      ok: true,
      severity: request.profileText === undefined ? 'warn' : 'ok',
      reason: request.profileText === undefined
        ? `could not read ${request.profilePath ?? 'the profile patch'}, so the approval pairing was NOT verified`
        : 'the profile does not pin an approval policy, so dsh-base pairs it with the mode',
    }
  }
  if (pinned.kind === 'derived') return { ok: true, severity: 'ok', reason: '' }

  const policy = pinned.value
  const match = PRESETS.find((p) => p.sandbox === mode && p.approval === policy)
  if (match !== undefined) return { ok: true, severity: 'ok', reason: '' }

  const wanted = approvalPolicyFor(mode)
  // WARN, not block. MEASURED 2026-10-15 on a real acp profile: with this exact mismatch, the app
  // starts, a session is created, a TURN completes, and the agent's own runtime context reports the
  // requested mode as effective ("Current DSH file policy: danger-full-access"). Only the
  // `permission-presets` entry fails to activate.
  //
  // An earlier version of this file BLOCKED here, on a predicted "the worker becomes unreachable"
  // that the measurement disproved. A gate that refuses a configuration it has measured to work is
  // worse than no gate: it costs real deployments and teaches people to bypass the check.
  return {
    ok: true,
    severity: 'warn',
    reason: [
      `this profile pins the approval policy to "${policy}", but dsh-base pairs "${mode}" with "${wanted}",`,
      `so requesting ${mode} composes (${mode}, ${policy}), which is in NO configured preset and`,
      '`defaultPreset` is unset. DSH reports one failed entry and dsh-permission-presets does not load.',
      'MEASURED: the sandbox mode still applies and a turn still runs, so this degrades the preset',
      'bookkeeping rather than the worker.',
      'TO REMOVE THE WARNING: apply packages/dsh-plugin-remote-use/slave/acp-profile-approval.patch.yml,',
      'which derives the policy from DSH_PERMISSION_MODE instead of pinning it (a no-op for every other mode).',
    ].join(' '),
  }
}
