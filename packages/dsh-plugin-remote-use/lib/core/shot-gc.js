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
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Default number of screenshots kept per worker. */
export const DEFAULT_KEEP_SHOTS = 20

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
 * Delete all but the newest `keep` screenshots belonging to one worker.
 *
 * @param {string} dir
 * @param {string} peerId
 * @param {number} keep how many to retain; a non-finite or negative value disables pruning
 * @returns {{ ok: boolean, removed: number, kept: number, freedBytes: number, error: string }}
 */
export function pruneShots(dir, peerId, keep) {
  const nothing = { ok: true, removed: 0, kept: 0, freedBytes: 0, error: '' }
  if (typeof dir !== 'string' || dir === '') {
    return { ...nothing, ok: false, error: 'pruneShots: no directory given' }
  }
  // A non-finite or negative budget means "do not prune", not "delete everything". Treating a
  // missing configuration as 0 would silently destroy the operator's screenshots.
  if (!Number.isFinite(keep) || keep < 0) return nothing

  let names
  try {
    names = readdirSync(dir)
  } catch (error) {
    // A directory that does not exist yet is the normal first-run case, not a failure.
    if (error?.code === 'ENOENT') return nothing
    return { ...nothing, ok: false, error: `pruneShots: cannot list ${dir}: ${error.message}` }
  }

  const pattern = shotPattern(peerId)
  const candidates = []
  for (const name of names) {
    if (!pattern.test(name)) continue
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      if (stat.isFile()) candidates.push({ path, name, mtimeMs: stat.mtimeMs, size: stat.size })
    } catch { /* vanished between listing and stat; nothing to do */ }
  }

  // Newest first. The name breaks ties: the stamp is ISO, so it sorts correctly, and a
  // filesystem with coarse timestamps can hand out identical mtimes.
  candidates.sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.name.localeCompare(a.name))

  const doomed = candidates.slice(Math.max(0, Math.floor(keep)))
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

  return {
    ok: firstError === '',
    removed,
    kept: candidates.length - removed,
    freedBytes,
    error: firstError,
  }
}
