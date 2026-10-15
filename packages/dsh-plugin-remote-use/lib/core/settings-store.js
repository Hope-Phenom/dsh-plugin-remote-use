/**
 * Settings storage for dsh-plugin-remote-use.
 *
 * WHY A SECOND CONFIG SOURCE: the worker list otherwise lives only in the profile patch
 * (`cordis.patch.yml`), which means every pairing change is a hand edit of YAML plus a
 * restart. The page needs to write somewhere, and the profile patch is the wrong target:
 * it is user-maintained prose with comments and hand formatting that a programmatic write
 * would destroy. A settings file beside the plugin's other state is the same shape the
 * sibling notification plugin uses.
 *
 * PRECEDENCE -- deliberate and stated, because "I changed it and nothing happened" is the
 * failure this kind of split always produces:
 *
 *   defaults  <  profile patch  <  settings file
 *
 * The settings file wins, and only for the keys it actually contains. It is absent until
 * the operator saves something, so an install that never opens the page behaves exactly as
 * before. `mergeSettings` reports which source won per key so the page can say so.
 *
 * TOKENS: never handed to the browser. The page receives `tokenSet` and a masked hint and
 * can only WRITE a token. A worker token is a bearer credential for remote execution;
 * sending it to a web page -- where it lands in devtools, memory, and any screenshot of the
 * screen -- is a cost with no benefit, since the page never needs to display it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Keys the settings page owns and may write. Anything else in the file is ignored. */
export const MANAGED_KEYS = [
  'workers',
  'approvalTimeoutMs',
  'requiredTier',
  'heartbeatMs',
  // Added along with the page controls for them. A key the page can SAVE but that is not
  // managed here would be dropped on the next read -- the quiet way a setting seems to work
  // once and then reverts.
  'keepShots',
  // The byte ceiling that sits beside `keepShots`. Added here in the same change that added the
  // control, because the note below records what happens when it is not: the key round-trips
  // through disk and then reverts on the next read.
  'shotCacheBytes',
  // Added with the audit-retention controls. These were LEFT OUT here when they shipped, so both
  // silently reverted: saved to disk, dropped by the merge, and shown as the default again on the
  // next read. Found 2026-10-15 while adding the third of them, by a guard that now checks the whole
  // exposed set at once instead of relying on one round-trip test per key.
  'auditMaxBytes',
  'auditKeepFiles',
  // The sandbox mode this machine arms its own remote sessions with.
  'workerSessionMode',
  'delegationPolicy',
  // The worker role: whether this machine accepts remote execution, on which interface, and
  // the credential a paired master presents. It holds a secret, so anything that renders it
  // for the page must go through the mask (see core/worker-arming.js).
  'workerRole',
]

/** Fields of one worker the page may write. */
export const WORKER_KEYS = ['id', 'name', 'url', 'token', 'cwd', 'enabled', 'serialQueue']

/**
 * Root of this installation's state.
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** @param {Record<string, string | undefined>} [env] */
export function settingsPath(env = process.env) {
  return join(resolveDshHome(env), 'storages', 'dsh-plugin-remote-use', 'settings.json')
}

/** Keep the last few characters so an operator can tell two tokens apart without seeing either. */
export function maskToken(token) {
  if (typeof token !== 'string' || token === '') return ''
  if (token.length <= 4) return '\u2022'.repeat(token.length)
  return `${'\u2022'.repeat(Math.min(12, token.length - 4))}${token.slice(-4)}`
}

/** A worker as the PAGE sees it: no token, only whether one is set and a masked hint. */
export function publicWorker(worker) {
  const token = typeof worker?.token === 'string' ? worker.token : ''
  return {
    id: String(worker?.id ?? ''),
    name: String(worker?.name ?? ''),
    url: String(worker?.url ?? ''),
    cwd: String(worker?.cwd ?? ''),
    enabled: worker?.enabled !== false,
    serialQueue: Number.isFinite(worker?.serialQueue) ? Number(worker.serialQueue) : 1,
    tokenSet: token !== '',
    tokenHint: maskToken(token),
  }
}

/** One worker, normalized. Returns undefined when it lacks the fields a connection needs. */
export function normalizeWorker(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (id === '' || url === '') return undefined
  const worker = {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id,
    url,
    cwd: typeof raw.cwd === 'string' ? raw.cwd.trim() : '',
    enabled: raw.enabled !== false,
    serialQueue: Number.isFinite(raw.serialQueue) && Number(raw.serialQueue) >= 1 ? Math.floor(Number(raw.serialQueue)) : 1,
  }
  // A token may legitimately be absent (an unauthenticated relay), so only carry it when
  // it is a non-empty string. `undefined` means "leave whatever the profile had".
  if (typeof raw.token === 'string' && raw.token !== '') worker.token = raw.token
  return worker
}

/**
 * Read the settings file.
 * @returns {{ settings: object | null, file: string, error: string }}
 *   `settings: null` means the file does not exist, which is NOT an error: it is the state
 *   every install starts in, and the caller falls back to the profile patch.
 */
export function readSettings(env = process.env) {
  const file = settingsPath(env)
  if (!existsSync(file)) return { settings: null, file, error: '' }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') {
      return { settings: null, file, error: 'settings file is not a JSON object' }
    }
    const settings = {}
    for (const key of MANAGED_KEYS) {
      if (parsed[key] !== undefined) settings[key] = parsed[key]
    }
    if (Array.isArray(settings.workers)) {
      settings.workers = settings.workers.map(normalizeWorker).filter((w) => w !== undefined)
    }
    return { settings, file, error: '' }
  } catch (error) {
    // A corrupt file must not stop the plugin from loading. Report it and fall back.
    return { settings: null, file, error: `settings file is unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Write the settings file atomically (temp file + rename) so a crash mid-write cannot leave
 * a half-written file that then fails to parse on the next start.
 * @returns {{ ok: boolean, file: string, error: string }}
 */
export function writeSettings(settings, env = process.env) {
  const file = settingsPath(env)
  try {
    mkdirSync(dirname(file), { recursive: true })
    const payload = {}
    for (const key of MANAGED_KEYS) {
      if (settings?.[key] !== undefined) payload[key] = settings[key]
    }
    const temp = `${file}.tmp`
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
    return { ok: true, file, error: '' }
  } catch (error) {
    return { ok: false, file, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Merge the settings file over the profile configuration.
 *
 * @param {object} profileConfig the Cordis config (already normalized)
 * @param {object | null} settings the settings file contents, or null when absent
 * @returns {{ config: object, sources: Record<string, 'profile' | 'settings'> }}
 */
export function mergeSettings(profileConfig, settings) {
  const config = { ...profileConfig }
  const sources = {}
  for (const key of MANAGED_KEYS) sources[key] = 'profile'
  if (settings === null || settings === undefined) return { config, sources }

  for (const key of MANAGED_KEYS) {
    if (settings[key] === undefined) continue
    // `workers` REPLACES rather than appends. Merging two lists would make a deletion in the
    // page impossible to express, and a half-applied list is worse than an explicit swap.
    config[key] = settings[key]
    sources[key] = 'settings'
  }
  return { config, sources }
}

/**
 * Apply a page-supplied worker edit onto the current list.
 *
 * A blank/omitted token means "keep the existing one": the page never receives the token, so
 * requiring it on every save would force the operator to re-enter a credential to rename a
 * worker.
 *
 * @param {object[]} workers current list (may contain tokens)
 * @param {object} edit page-supplied worker
 * @returns {{ workers: object[], error: string }}
 */
export function upsertWorker(workers, edit) {
  const list = Array.isArray(workers) ? [...workers] : []
  const candidate = normalizeWorker(edit)
  if (candidate === undefined) return { workers: list, error: 'a worker needs at least an id and a url' }

  const index = list.findIndex((w) => w?.id === candidate.id)
  if (edit?.token === undefined || edit?.token === null || edit?.token === '') {
    if (index >= 0 && typeof list[index].token === 'string') candidate.token = list[index].token
    else if (index < 0) return { workers: list, error: `worker "${candidate.id}" is new, so it needs a token` }
  }

  if (index >= 0) list[index] = candidate
  else list.push(candidate)
  return { workers: list, error: '' }
}

/** Remove a worker by id. @returns {{ workers: object[], removed: boolean }} */
export function removeWorker(workers, id) {
  const list = Array.isArray(workers) ? [...workers] : []
  const next = list.filter((w) => w?.id !== id)
  return { workers: next, removed: next.length !== list.length }
}
