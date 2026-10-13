// ask-selfcheck.mjs -- print exactly what the relay's self-check RPC answers, S0 included.
//
// Written because two harnesses disagreed about the same relay: `plugin-live` saw the degraded
// `S0` report while a probe saw a full 17-check one. The difference could not be seen from either
// harness's summary, and "a check that reports the wrong thing" has been this project's most
// expensive failure mode.
import { AcpBridge } from '../packages/dsh-plugin-remote-use/lib/bridge/acp-bridge.js'

const url = process.argv[2]
const token = process.argv[3]
if (url === undefined || token === undefined) {
  process.stderr.write('usage: node ask-selfcheck.mjs <ws-url> <token>\n')
  process.exit(2)
}

const bridge = new AcpBridge({ url, token, approvalTimeoutMs: 10_000 })
try {
  await bridge.connect()
  const report = await bridge.selfcheck({ timeoutMs: 60_000 })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} catch (error) {
  process.stdout.write(`FAILED: ${String(error?.message ?? error)}\n`)
} finally {
  try { await bridge.dispose() } catch { /* best effort */ }
}
