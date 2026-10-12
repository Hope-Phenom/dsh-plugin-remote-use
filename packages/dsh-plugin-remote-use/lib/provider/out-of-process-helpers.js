/**
 * Local mirror of the out-of-process helper vocabulary from
 * `@deepseek-ai/dsh-subagent` (its `lib/types/out-of-process.js`).
 *
 * WHY A MIRROR: the plugin must stay unit-testable without a live DSH, and this
 * constant is a frozen contract that cannot drift meaningfully. To keep the mirror
 * honest rather than a guess, `verifyAgainstUpstream()` compares it with the real
 * package when that package is importable, and the plugin calls it at load.
 *
 * The upstream values are authoritative; if DSH ever changes the capability set,
 * verification fails loudly instead of silently advertising a capability we cannot
 * honor (DESIGN §2.2 C1).
 *
 * @module dsh-plugin-remote-use/out-of-process-helpers
 */

/**
 * The capability advertisement of an out-of-process backend: NONE.
 *
 * A child in another process cannot honor parent-enforced start features
 * (`agentOptions` / `outputSchema` / `maxDepth` / `toolFilter` / `persona`), so the
 * subagent service rejects a request needing any of them BEFORE `start` runs. This
 * must never be widened without implementing the corresponding enforcement.
 */
export const NO_START_CAPABILITIES = Object.freeze({
  agentOptions: false,
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
})

/**
 * Maximum UTF-8 size a provider-authored diagnostic may have upstream.
 * Kept here so our diagnostics are shaped like the ones DSH produces.
 */
export const MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4096

/**
 * Compare the local mirror with the real package.
 * @returns {Promise<{ok: boolean, reason?: string, upstream?: object}>}
 */
export async function verifyAgainstUpstream() {
  let upstream
  try {
    upstream = await import('@deepseek-ai/dsh-subagent')
  } catch (error) {
    // Not importable in a bare unit-test environment; that is expected and not a fault.
    return { ok: true, reason: `upstream not importable here: ${error instanceof Error ? error.message : String(error)}` }
  }
  const real = upstream?.NO_START_CAPABILITIES
  if (real === undefined) return { ok: true, reason: 'upstream no longer exports NO_START_CAPABILITIES' }
  const keys = new Set([...Object.keys(real), ...Object.keys(NO_START_CAPABILITIES)])
  for (const k of keys) {
    if (real[k] !== NO_START_CAPABILITIES[k]) {
      return { ok: false, reason: `capability "${k}" differs: upstream=${real[k]} local=${NO_START_CAPABILITIES[k]}`, upstream: real }
    }
  }
  return { ok: true, upstream: real }
}

/**
 * Truncate a diagnostic to the upstream byte limit without splitting a UTF-8
 * sequence, mirroring how DSH limits provider-authored detail.
 * @param {string} text
 * @returns {string}
 */
export function limitDiagnostic(text) {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= MAX_SUBAGENT_DIAGNOSTIC_BYTES) return text
  const suffix = '\n[diagnostic truncated]'
  const suffixBytes = new TextEncoder().encode(suffix).byteLength
  let cut = MAX_SUBAGENT_DIAGNOSTIC_BYTES - suffixBytes
  while (cut > 0 && (bytes[cut] & 0b1100_0000) === 0b1000_0000) cut -= 1
  return new TextDecoder().decode(bytes.subarray(0, cut)) + suffix
}
