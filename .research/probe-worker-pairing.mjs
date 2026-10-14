#!/usr/bin/env node
/**
 * Run ON A WORKER: prove what this machine's pairing string actually carries.
 *
 * WHY THIS HAS TO RUN THERE: "the pairing string carries the task directory" is a claim about the
 * code and the stored state ON THE WORKER. Everything on the master side can be satisfied by an
 * operator who simply typed the path into the pairing card's fallback box, so the master's state
 * cannot tell the two apart. This instantiates the INSTALLED `WorkerArming` with the machine's own
 * stored role and inspects that the string it issues contains `cwd`.
 *
 * IT NEVER PRINTS THE CREDENTIAL. The pairing string contains the token in recoverable form, so the
 * output reports only: file hashes, the non-secret role fields, and the DECODED FIELD NAMES of the
 * string (plus its `cwd` value). It also self-checks that the token is absent from everything it
 * printed.
 *
 * The listener is never touched: `start`/`stop`/`probe`/`persist` are all injected as no-ops, so
 * instantiating the state machine cannot open, close or rewrite anything.
 *
 * Usage (on the worker):  node probe-worker-pairing.mjs
 * Exit code 0 = the string carries the directory; 1 = it does not.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PKG = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'node_modules',
  '@hope_phenom', 'dsh-plugin-remote-use')
const SETTINGS = join(process.env.USERPROFILE ?? '', '.dsh', 'storages', 'dsh-plugin-remote-use', 'settings.json')

const { WorkerArming } = await import(new URL(`file:///${PKG.replace(/\\/gu, '/')}/lib/core/worker-arming.js`).href)
const { decodePairing } = await import(new URL(`file:///${PKG.replace(/\\/gu, '/')}/slave/pairing.mjs`).href)

const out = {}

// 1. Which code is this? Hashes, so the master can compare against its own checkout.
out.version = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version
out.hashes = {}
for (const rel of ['lib/index.js', 'lib/client.js', 'lib/core/worker-arming.js', 'lib/core/task-cwd.js', 'slave/pairing.mjs']) {
  try {
    out.hashes[rel] = createHash('sha256').update(readFileSync(join(PKG, rel))).digest('hex')
  } catch {
    out.hashes[rel] = 'MISSING'
  }
}

// 2. The stored worker role. The token is read (it has to be, to build the string) and never printed.
const settings = JSON.parse(readFileSync(SETTINGS, 'utf8'))
const role = settings.workerRole ?? {}
out.role = {
  armed: role.armed === true,
  bindAddress: String(role.bindAddress ?? ''),
  port: Number(role.port ?? 0),
  taskCwd: String(role.taskCwd ?? ''),
  tokenLength: String(role.token ?? '').length,
}

// 3. Instantiate the INSTALLED state machine against that stored role, with everything injected.
const arming = new WorkerArming({
  interfaces: () => ({}),
  probe: () => ({ ok: true, reason: 'probe injected by probe-worker-pairing.mjs' }),
  start: () => ({ pid: 0 }),
  stop: () => ({ stopped: false }),
  persist: () => {},
  mint: () => 'not-used',
  stored: { ...role, armed: true },
})
out.status = { armed: arming.status().armed, taskCwd: String(arming.status().taskCwd ?? '') }

// 4. The pairing string this machine would hand out, inspected by DECODING it AND by reading the
//    payload's own keys.
//
//    WHY BOTH, AND WHY THE KEYS ARE THE REAL DISCRIMINATOR: `decodePairing` always returns all four
//    fields, filling `cwd` with `''` when the payload does not carry one. So a decoded `cwd === ''`
//    cannot tell "the field was omitted" from "the field was sent empty" -- only the payload's KEY
//    SET can. The first version of this probe reported the decoded field list and would have called
//    an empty payload a success.
function payloadKeys(pairing) {
  const parts = String(pairing).split('.')
  if (parts.length !== 3) return null
  try {
    return Object.keys(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

const pairing = arming.pairingString()
const decoded = decodePairing(pairing)
out.pairing = {
  length: pairing.length,
  decodes: decoded.ok === true,
  payloadKeys: payloadKeys(pairing),
  decodedCwd: decoded.ok === true ? String(decoded.worker.cwd ?? '') : '',
  decodedUrl: decoded.ok === true ? String(decoded.worker.url ?? '') : '',
}

// NEGATIVE CONTROL, on this machine, with this machine's real credential: the same state machine
// given an empty task directory must produce a payload WITHOUT the key. Without this, "the string
// carries cwd" could just be "the encoder always writes cwd".
const blank = new WorkerArming({
  interfaces: () => ({}),
  probe: () => ({ ok: true, reason: 'injected' }),
  start: () => ({ pid: 0 }),
  stop: () => ({ stopped: false }),
  persist: () => {},
  mint: () => 'not-used',
  stored: { ...role, armed: true, taskCwd: '' },
})
out.control = { taskCwd: '', payloadKeys: payloadKeys(blank.pairingString()) }

const u = out.pairing
out.verdict = decoded.ok === true
  && Array.isArray(u.payloadKeys) && u.payloadKeys.includes('cwd')
  && u.decodedCwd === out.role.taskCwd
  && out.role.taskCwd !== ''
  && Array.isArray(out.control.payloadKeys) && !out.control.payloadKeys.includes('cwd')
  ? 'the pairing string CARRIES the task directory (and omits it when empty)'
  : 'the pairing string does NOT carry the task directory (or the control did not omit it)'

const text = JSON.stringify(out, null, 2)
// Self-check before printing: the credential must not be anywhere in what we are about to emit.
const leaked = String(role.token ?? '') !== '' && text.includes(String(role.token))
console.log(text)
console.log(`token present in this output: ${leaked}`)
console.log(`verdict: ${out.verdict}`)
process.exit(out.verdict.startsWith('the pairing string CARRIES') && !leaked ? 0 : 1)
