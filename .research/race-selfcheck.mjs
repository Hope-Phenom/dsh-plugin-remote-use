// race-selfcheck.mjs -- call the relay's self-check twice AT THE SAME TIME.
//
// THE HYPOTHESIS: `runSelfCheck` has no in-flight guard, while `captureScreenshot` does
// (`if (capturing !== undefined) return await capturing`). `selfcheck.ps1` deletes its report at
// the start and writes it at the end, so two concurrent invocations race on one shared file and a
// reader can see a partial one -- which surfaces as `Unexpected end of JSON input`, i.e. exactly
// the `S0` degradation seen from `plugin-live` and never from a single-call probe.
import { AcpBridge } from '../packages/dsh-plugin-remote-use/lib/bridge/acp-bridge.js'

const url = process.argv[2]
const token = process.argv[3]
const N = Number(process.argv[4] ?? '2')

const bridge = new AcpBridge({ url, token, approvalTimeoutMs: 10_000 })
await bridge.connect()
try {
  const started = Date.now()
  const reports = await Promise.all(
    Array.from({ length: N }, () => bridge.selfcheck({ timeoutMs: 90_000 })),
  )
  process.stdout.write(`\n${N} concurrent calls took ${Date.now() - started} ms\n\n`)
  for (const [i, r] of reports.entries()) {
    const degraded = Array.isArray(r?.checks) && r.checks.length === 1 && r.checks[0]?.id === 'S0'
    process.stdout.write(
      `  call ${i}: verdict=${r?.verdict} checks=${r?.checks?.length} degraded=${degraded}`
      + `${degraded ? ` | ${String(r?.checks?.[0]?.actual ?? '').slice(0, 70)}` : ''}\n`,
    )
  }
  const bad = reports.filter((r) => Array.isArray(r?.checks) && r.checks.length === 1 && r.checks[0]?.id === 'S0')
  process.stdout.write(`\nRESULT: ${bad.length === 0 ? 'all calls returned a real report' : `${bad.length}/${N} DEGRADED -- the calls raced`}\n`)
  process.exitCode = bad.length === 0 ? 0 : 1
} finally {
  try { await bridge.dispose() } catch { /* best effort */ }
}
