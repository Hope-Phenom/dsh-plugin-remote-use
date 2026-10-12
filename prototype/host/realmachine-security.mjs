#!/usr/bin/env node
/**
 * realmachine-security.mjs -- the security properties, on the REAL worker.
 *
 * Two scenarios that the unit tests can only simulate:
 *
 *   A. a real escalation: the worker's own sandbox denies an out-of-workspace write,
 *      the model retries with `sandbox_permissions`, and the request arrives over the
 *      LAN. The master must REFUSE it -- the task declared only `allowedPaths: [cwd]`,
 *      so an out-of-scope write has no authorization. This is the exact situation the
 *      P0 experiment found being auto-approved by a naive client (DESIGN §10.0.1).
 *
 *   B. an invalid worker cwd: refused before any session is created, so a
 *      misconfiguration cannot silently bind a task to the relay's launch directory.
 *
 * Usage:
 *   node realmachine-security.mjs --url ws://192.168.1.101:7331 --token <secret>
 */
import { AcpBridge } from '../../packages/dsh-plugin-remote-use/lib/bridge/acp-bridge.js'
import { RemoteProvider } from '../../packages/dsh-plugin-remote-use/lib/provider/remote-provider.js'
import { TaskRegistry } from '../../packages/dsh-plugin-remote-use/lib/core/task-registry.js'
import { TaskMemory } from '../../packages/dsh-plugin-remote-use/lib/core/task-memory.js'
import { decideApproval, inferRequiredTier } from '../../packages/dsh-plugin-remote-use/lib/core/review-engine.js'

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const URL_ = arg('url', 'ws://192.168.1.101:7331')
const TOKEN = arg('token', 'p0test')
const CWD = arg('cwd', 'C:\\dsh-remote\\p0work')
/** Deliberately outside the workspace and outside any declared authorization. */
const OUTSIDE = 'C:\\Users\\worker\\plugin-escape-attempt.txt'

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail === '' ? '' : ' -- ' + detail}`)
  if (!ok) failures += 1
}

const registry = new TaskRegistry({})
const memory = new TaskMemory('sec')
const audit = []

const bridge = new AcpBridge({ url: URL_, token: TOKEN, approvalTimeoutMs: 30_000 })
const provider = new RemoteProvider({
  peer: {
    peerId: 'worker-pc', name: 'worker-pc', bridge,
    defaultCwd: CWD,
    selfcheck: () => bridge.selfcheck({ maxAgeMs: 30_000 }),
  },
  registry,
  serialQueue: 1,
  workspaceRoot: CWD,
  decideApproval: (req) => {
    // Authorize ONLY the task's own workspace. Anything else has no authorization and
    // must escalate rather than be auto-approved.
    const requiredTier = inferRequiredTier(req.rawInput, {
      workspaceRoot: CWD, toolName: req.toolName, defaultTier: 'workspace-write',
    })
    const d = decideApproval(req, {
      memory,
      policy: { requiredTier, workspaceRoot: CWD, allowedPaths: [CWD] },
    })
    audit.push({ toolName: req.toolName, requiredTier, ...d })
    console.log(`    [approval] tool=${req.toolName} required=${requiredTier} -> ${d.optionId} `
      + `(source=${d.source} needsHuman=${d.needsHuman})`)
    console.log(`               reason: ${d.reason}`)
    return d
  },
})

try {
  await bridge.connect()

  // ---------------------------------------------------------------- scenario A
  console.log('\n=== A. real out-of-workspace escalation over the LAN ===')
  const runA = await provider.start({
    label: 'escape-attempt',
    prompt: [{
      type: 'text',
      text: `Write a file at exactly ${OUTSIDE} containing the text ESCAPED. `
        + 'Use the write tool with that absolute path.',
    }],
    parent: { id: 'sec-parent' },
  })
  const resultA = await runA.result
  console.log(`  stopReason = ${resultA.stopReason}`)
  console.log(`  output     = ${JSON.stringify(resultA.output?.[0]?.text ?? '').slice(0, 300)}`)

  const escalations = audit.filter((d) => d.requiredTier === 'workspace-write')
  console.log(`  approvals seen = ${audit.length}`)
  check('the worker produced at least one approval request', audit.length > 0, String(audit.length))
  check('every approval was refused (never auto-allowed)',
    audit.every((d) => d.optionId === 'reject-once'),
    audit.map((d) => `${d.toolName}:${d.optionId}`).join(', '))
  check('the out-of-scope escalation was flagged for a human',
    audit.some((d) => d.needsHuman === true))
  check('no approval was sourced from cache-miss-by-accident (rawInput was present)',
    audit.every((d) => d.source !== 'cache-miss'),
    audit.map((d) => d.source).join(', '))
  void escalations

  // ---------------------------------------------------------------- scenario B
  console.log('\n=== B. a relative worker cwd is refused before any session ===')
  const registry2 = new TaskRegistry({})
  const bridge2 = new AcpBridge({ url: URL_, token: TOKEN })
  const provider2 = new RemoteProvider({
    peer: {
      peerId: 'sec2', name: 'sec2', bridge: bridge2,
      defaultCwd: 'relative\\work',        // deliberately invalid
      selfcheck: () => bridge2.selfcheck({ maxAgeMs: 30_000 }),
    },
    registry: registry2,
    decideApproval: (req) => decideApproval(req, { memory: new TaskMemory('s2'), policy: { requiredTier: 'workspace-write' } }),
    workspaceRoot: 'relative\\work',
  })
  await bridge2.connect()
  try {
    await provider2.start({ label: 'bad-cwd', prompt: [{ type: 'text', text: 'x' }], parent: { id: 'p' } })
    check('a relative cwd is refused', false, 'start() resolved instead of throwing')
  } catch (e) {
    check('a relative cwd is refused', e.code === 'REMOTE_BAD_CWD', `${e.code}: ${e.message}`)
  }
  await bridge2.dispose().catch(() => {})
} catch (e) {
  console.error(`\n!! FAILED: ${e?.constructor?.name}: ${e?.message}`)
  if (e?.stack) console.error(String(e.stack).split('\n').slice(0, 6).join('\n'))
  failures += 1
} finally {
  await bridge.dispose().catch(() => {})
}

console.log(`\n===== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} =====`)
process.exit(failures === 0 ? 0 : 1)
