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
// WHY THE CHECK IS HERE AND NOT IN THE PLUGIN: the plugin never knows the deployment mode -- it
// enters the system only through `make-launch-spec.mjs --permission-mode`, which is run by hand on
// the worker. That script is the only place that both knows the mode and can read the profile, so
// it is the only place a gate can actually stand. Putting one anywhere else would need new config
// to carry the mode there, which is the mechanism this design deliberately does not have.

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
  return {
    ok: false,
    severity: 'block',
    reason: [
      `this profile pins the approval policy to "${policy}", but dsh-base pairs "${mode}" with "${wanted}" --`,
      `so requesting ${mode} would compose (${mode}, ${policy}), which is in NO configured preset,`,
      'and `defaultPreset` is unset, which dsh-permission-presets requires when the defaults match no preset.',
      'The ACP process can then fail to start and the worker becomes unreachable.',
      '',
      'FIX: apply packages/dsh-plugin-remote-use/slave/acp-profile-approval.patch.yml to this profile,',
      'which derives the policy from DSH_PERMISSION_MODE instead of pinning it (a no-op for every other mode).',
    ].join(' '),
  }
}
