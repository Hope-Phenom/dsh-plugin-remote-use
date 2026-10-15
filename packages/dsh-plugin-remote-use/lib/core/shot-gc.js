/**
 * Screenshot housekeeping.
 *
 * WHY THIS EXISTS: every capture leaves a file behind, and a worker screenshot is a
 * full-resolution PNG -- measured at ~9.5 MB each on the reference worker. A session that
 * uses screenshots to drive GUI verification produces them steadily, and nothing ever removed
 * them: the worker's shot directory had reached 56.9 MB across six captures before this was
 * written, and the host's download directory grows the same way.
 *
 * TWO RULES SHAPE THE DESIGN:
 *
 *  1. NEVER THROW. Pruning runs as part of taking a screenshot. A full disk or a locked file
 *     must not turn a successful capture into a failed one, so every failure is reported in
 *     the result and the caller carries on. The failure mode this avoids -- "I cannot show you
 *     the screen because I could not delete an old file" -- is strictly worse than the disk
 *     usage it prevents.
 *
 *  2. ONLY TOUCH WHAT THIS PLUGIN WROTE. The host's screenshot directory sits in the system
 *     temp directory, which is shared with everything else on the machine. Deleting "some old
 *     files" there would be destructive, so a file is only a candidate when its name matches
 *     the pattern this plugin generates for that worker.
 *
 * WHY THERE IS ALSO A BYTE BUDGET: a COUNT budget does not bound disk usage, it only bounds the
 * number of files. That is a real distinction and it bit this plugin: the count was 20, so the
 * budget was believed to be "20 captures", while the directory had reached 218 MB -- and on a
 * machine whose captures are larger, or whose operator raised the count, the count says nothing
 * about whether the disk is filling. Byte usage is what the operator actually cares about, so it
 * is both reported (see `scanShotUsage`) and enforced (see `pruneShots`'s `maxBytes`).
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Default number of screenshots kept per worker. */
export const DEFAULT_KEEP_SHOTS = 20

/**
 * Default byte ceiling for one worker's screenshots on the HOST, when the setting is absent.
 *
 * 0 means "no byte budget", which is the shipped default on purpose: the count budget already
 * bounds ordinary use, and an install that upgrades into a byte budget would start deleting
 * captures the operator never agreed to lose. An operator who wants a hard ceiling sets one.
 */
export const DEFAULT_SHOT_CACHE_BYTES = 0

/**
 * One megabyte, for parsing and rendering the operator-facing budget strings.
 *
 * Binary, not decimal: operators compare this number against what Explorer shows, and Explorer
 * reports MiB while calling it MB. Using 1e6 here would make the page disagree with the folder
 * it is describing by ~5%, which reads as a bug in the accounting.
 */
export const BYTES_PER_MB = 1024 * 1024

/**
 * Render a byte count the way the settings page shows it.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < BYTES_PER_MB) return `${(n / 1024).toFixed(1)} KB`
  if (n < BYTES_PER_MB * 1024) return `${(n / BYTES_PER_MB).toFixed(1)} MB`
  return `${(n / (BYTES_PER_MB * 1024)).toFixed(2)} GB`
}

/**
 * Parse an operator-entered budget. Accepts a bare number of BYTES, or a number with a unit
 * suffix (`512MB`, `1.5 GB`, `0`).
 *
 * WHY A PARSER AND NOT JUST A NUMBER FIELD: the unit an operator thinks in is MB, and a field
 * that silently wants bytes invites an off-by-a-million typo that then either deletes nothing or
 * deletes everything. Returns undefined for anything unparseable, so the caller can refuse the
 * save rather than apply a guess.
 *
 * @param {unknown} raw
 * @returns {number | undefined} bytes, or undefined when unusable
 */
export function parseBytes(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.floor(raw) : undefined
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text === '') return undefined
  // A signed value is meaningful (negative disables), so the sign is captured rather than rejected.
  const m = /^(-?\d+(?:\.\d+)?)\s*(b|kb|mb|gb|kib|mib|gib)?$/iu.exec(text)
  if (m === null) return undefined
  const value = Number(m[1])
  if (!Number.isFinite(value)) return undefined
  const unit = (m[2] ?? '').toLowerCase()
  const scale = unit === '' || unit === 'b'
    ? 1
    : unit === 'kb' || unit === 'kib'
      ? 1024
      : unit === 'mb' || unit === 'mib'
        ? BYTES_PER_MB
        : BYTES_PER_MB * 1024
  return Math.floor(value * scale)
}

/**
 * Files this plugin writes look like `<peerId>-<ISO stamp with : and . replaced>.png`.
 * The trailing hyphen matters: without it a worker named `w1` would also match `w12`'s files.
 * @param {string} peerId
 * @returns {RegExp}
 */
export function shotPattern(peerId) {
  const escaped = String(peerId).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`^${escaped}-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z\\.png$`, 'u')
}

/**
 * List this worker's screenshots in `dir`, newest first.
 *
 * Shared by pruning, reporting and clearing so the three can never disagree about which files
 * count as "ours" -- the definition of that set is the whole safety property here, and two
 * copies of it would drift.
 *
 * @param {string} dir
 * @param {string} peerId
 * @returns {{ files: Array<{path: string, name: string, mtimeMs: number, size: number}>, error: string }}
 */
function listShots(dir, peerId) {
  let names
  try {
    names = readdirSync(dir)
  } catch (error) {
    // A directory that does not exist yet is the normal first-run case, not a failure.
    if (error?.code === 'ENOENT') return { files: [], error: '' }
    return { files: [], error: `cannot list ${dir}: ${error.message}` }
  }

  const pattern = shotPattern(peerId)
  const files = []
  for (const name of names) {
    if (!pattern.test(name)) continue
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      if (stat.isFile()) files.push({ path, name, mtimeMs: stat.mtimeMs, size: stat.size })
    } catch { /* vanished between listing and stat; nothing to do */ }
  }

  // Newest first. The name breaks ties: the stamp is ISO, so it sorts correctly, and a
  // filesystem with coarse timestamps can hand out identical mtimes.
  files.sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.name.localeCompare(a.name))
  return { files, error: '' }
}

/**
 * What one worker's screenshots occupy on disk.
 *
 * WHY THIS EXISTS: the count budget was the only thing that was bounded, and it was invisible.
 * An operator whose temp directory had reached 218 MB had no way to see that from the page, and
 * "a limit nobody can see is indistinguishable from no limit" applies doubly to usage.
 *
 * Never throws: this is called on a page load and on a liveness probe, neither of which may fail
 * because a directory was locked.
 *
 * @param {string} dir
 * @param {string} peerId
 * @returns {{ files: number, bytes: number, newestAt: number, oldestAt: number, error: string }}
 */
export function scanShotUsage(dir, peerId) {
  const empty = { files: 0, bytes: 0, newestAt: 0, oldestAt: 0, error: '' }
  if (typeof dir !== 'string' || dir === '' || peerId === undefined || peerId === null || String(peerId) === '') {
    return empty
  }
  const { files, error } = listShots(dir, String(peerId))
  if (error !== '') return { ...empty, error }
  let bytes = 0
  // `listShots` sorts newest first, so the extremes are the ends of the list rather than a scan.
  for (const file of files) bytes += file.size
  return {
    files: files.length,
    bytes,
    newestAt: files.length === 0 ? 0 : files[0].mtimeMs,
    oldestAt: files.length === 0 ? 0 : files[files.length - 1].mtimeMs,
    error: '',
  }
}

/**
 * Delete all but the newest `keep` screenshots belonging to one worker, then, if `opts.maxBytes`
 * is a positive budget, delete oldest-first until the survivors fit inside it.
 *
 * @param {string} dir
 * @param {string} peerId
 * @param {number} keep how many to retain; a non-finite or negative value disables pruning
 * @param {{ maxBytes?: number, keepNewest?: boolean }} [opts]
 *   `maxBytes`: byte ceiling for the survivors; non-finite, negative or 0 means no byte budget.
 *   `keepNewest` (default true): never delete the newest capture in the byte pass even if it
 *   alone exceeds the budget -- see the note in the body.
 * @returns {{ ok: boolean, removed: number, kept: number, freedBytes: number,
 *             overBudgetBytes: number, bytes: number, error: string }}
 */
export function pruneShots(dir, peerId, keep, opts = {}) {
  const nothing = { ok: true, removed: 0, kept: 0, freedBytes: 0, overBudgetBytes: 0, bytes: 0, error: '' }
  if (typeof dir !== 'string' || dir === '') {
    return { ...nothing, ok: false, error: 'pruneShots: no directory given' }
  }
  const hasCountBudget = Number.isFinite(keep) && keep >= 0
  const maxBytes = Number(opts?.maxBytes)
  // Same rule as the count budget, for the same reason: a missing or zero budget means "do not
  // prune", never "delete everything". The dangerous reading of an absent setting is 0.
  const hasByteBudget = Number.isFinite(maxBytes) && maxBytes > 0
  // "No budget at all" is a no-op, but it is NOT an empty cache. Reporting `kept: 0` here would
  // tell the page that a directory holding forty captures contains none -- two different facts
  // (nothing was pruned / nothing is there) collapsed into one number, and the wrong one. The
  // directory is listed so the count is real; a listing failure still reports zeroes.
  if (!hasCountBudget && !hasByteBudget) {
    const idle = listShots(dir, peerId)
    if (idle.error !== '') return nothing
    let idleBytes = 0
    for (const file of idle.files) idleBytes += file.size
    return { ...nothing, kept: idle.files.length, bytes: idleBytes }
  }

  const { files, error } = listShots(dir, peerId)
  if (error !== '') return { ...nothing, ok: false, error: `pruneShots: ${error}` }

  // The count pass first: it is a whole-file decision the operator stated explicitly, and it is
  // cheaper to reason about than a running total.
  const survivors = hasCountBudget ? files.slice(0, Math.max(0, Math.floor(keep))) : [...files]
  const doomed = hasCountBudget ? files.slice(Math.max(0, Math.floor(keep))) : []

  // The byte pass. `keepNewest` exists because the newest capture is the one the host is usually
  // about to read: deleting it to satisfy a byte ceiling would break the download that produced
  // it, and the master would be left with a screenshot tool that reports success and has no file.
  // So the byte pass may leave the directory over budget by exactly one capture, and it SAYS SO
  // through `overBudgetBytes` rather than silently overshooting.
  //
  // ⚠️ THE `hasByteBudget` TEST IS LOAD-BEARING AND WAS ONCE MISSING. The loop originally read
  // `running > maxBytes` alone. With no byte budget, `maxBytes` is 0, and EVERY non-empty
  // directory is "over" 0 -- so asking for "no ceiling" deleted everything except the newest
  // capture, which is the exact opposite of what a 0 budget means. It survived the unit tests
  // because those passed `keep: Infinity`, which returns at the no-budget guard above and never
  // reaches this loop; the end-to-end probe caught it. A budget of 0 must mean "do not run this
  // pass at all", so the flag is checked here as well as at the guard.
  const keepNewest = opts?.keepNewest !== false
  let running = 0
  for (const file of survivors) running += file.size
  for (let i = survivors.length - 1; hasByteBudget && i >= 0 && running > maxBytes; i -= 1) {
    if (keepNewest && i === 0) break
    doomed.push(survivors[i])
    running -= survivors[i].size
    survivors.splice(i, 1)
  }

  let removed = 0
  let freedBytes = 0
  let firstError = ''
  for (const file of doomed) {
    try {
      unlinkSync(file.path)
      removed += 1
      freedBytes += file.size
    } catch (error) {
      if (firstError === '') firstError = `cannot delete ${file.name}: ${error.message}`
    }
  }

  // Bytes are re-derived from the survivors rather than from the running total: a file whose
  // unlink failed is still on disk, and reporting it as freed would be a lie the page repeats.
  let bytes = 0
  for (const file of survivors) bytes += file.size

  return {
    ok: firstError === '',
    removed,
    kept: survivors.length,
    freedBytes,
    overBudgetBytes: hasByteBudget ? Math.max(0, bytes - maxBytes) : 0,
    bytes,
    error: firstError,
  }
}

/**
 * Delete every screenshot belonging to one worker, or every screenshot for every worker when
 * `peerId` is empty.
 *
 * WHY THIS IS SEPARATE FROM `pruneShots`: "keep the newest N" and "clear this cache" are
 * different operator intentions, and expressing the second as `keep: 0` would silently change
 * meaning the moment someone redefines 0 as "unset". The page has an explicit Clear button, so
 * the code gets an explicit function for it.
 *
 * @param {string} dir
 * @param {string} [peerId] worker to clear; empty/undefined clears every worker's captures
 * @returns {{ ok: boolean, removed: number, freedBytes: number, bytes: number, error: string }}
 */
export function clearShots(dir, peerId = '') {
  const nothing = { ok: true, removed: 0, freedBytes: 0, bytes: 0, error: '' }
  if (typeof dir !== 'string' || dir === '') {
    return { ...nothing, ok: false, error: 'clearShots: no directory given' }
  }
  let names
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return nothing
    return { ...nothing, ok: false, error: `clearShots: cannot list ${dir}: ${error.message}` }
  }

  // An empty peer id means "every worker", which is how the page offers one button per directory
  // rather than one deletion path per worker. The pattern still gates what may be removed: with
  // no peer id the accepted shape is any `<peerId>-<stamp>.png`, and a foreign file still fails it.
  const pattern = String(peerId ?? '') === ''
    ? /^[^-]+(?:-[^-]+)*-\d{4}-\d{2}-\d{2}T[\d-]+Z\.png$/u
    : shotPattern(String(peerId))

  let removed = 0
  let freedBytes = 0
  let bytes = 0
  let firstError = ''
  for (const name of names) {
    const path = join(dir, name)
    let stat
    try {
      stat = statSync(path)
    } catch { continue }
    if (!stat.isFile()) continue
    if (!pattern.test(name)) continue
    bytes += stat.size
    try {
      unlinkSync(path)
      removed += 1
      freedBytes += stat.size
    } catch (error) {
      if (firstError === '') firstError = `cannot delete ${name}: ${error.message}`
    }
  }
  return { ok: firstError === '', removed, freedBytes, bytes: bytes - freedBytes, error: firstError }
}
