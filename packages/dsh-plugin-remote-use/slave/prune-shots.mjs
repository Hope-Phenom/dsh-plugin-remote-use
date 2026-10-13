/**
 * Screenshot housekeeping for the relay.
 *
 * Kept in its own module rather than inline because the relay is a long-lived script with no
 * test harness of its own: extracting this is what makes the deletion rules testable. It has
 * NO dependencies beyond `node:fs` and `node:path` so it can be copied to a worker alongside
 * `relay.mjs` without dragging anything else along.
 *
 * TWO RULES, BOTH LOAD-BEARING:
 *
 *  1. Only delete files matching the caller's pattern. The directory is normally ours, but
 *     `--shot-dir` is configurable, and a mistyped path must not turn into deleted user data.
 *
 *  2. Never throw. This runs inside the capture path; failing to delete an old file must not
 *     fail the capture that just succeeded.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param {string} dir
 * @param {number} keep newest N to retain; non-finite or negative disables pruning
 * @param {RegExp} pattern which filenames this caller is allowed to delete
 * @returns {{ removed: number, kept: number, freedBytes: number }}
 */
export function pruneShots(dir, keep, pattern) {
  const nothing = { removed: 0, kept: 0, freedBytes: 0 }
  if (typeof dir !== 'string' || dir === '') return nothing
  // A non-finite or negative budget means "do not prune", never "delete everything". The
  // dangerous reading of a missing setting is 0.
  if (!Number.isFinite(keep) || keep < 0) return nothing
  if (!(pattern instanceof RegExp)) return nothing

  let names
  try {
    names = readdirSync(dir)
  } catch {
    // No directory yet is the normal first-run state.
    return nothing
  }

  const files = []
  for (const name of names) {
    if (!pattern.test(name)) continue
    try {
      const stat = statSync(join(dir, name))
      if (stat.isFile()) files.push({ name, mtimeMs: stat.mtimeMs, size: stat.size })
    } catch { /* vanished between listing and stat */ }
  }

  // Newest first. The name breaks ties: these are captured in sequence, and a filesystem with
  // coarse timestamps can hand out identical mtimes.
  files.sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.name.localeCompare(a.name))

  let removed = 0
  let freedBytes = 0
  for (const file of files.slice(Math.max(0, Math.floor(keep)))) {
    try {
      unlinkSync(join(dir, file.name))
      removed += 1
      freedBytes += file.size
    } catch { /* locked or already gone; the next capture tries again */ }
  }
  return { removed, kept: files.length - removed, freedBytes }
}

/** The names this relay writes: `shot-<epoch ms>-<sequence>.png`. */
export const RELAY_SHOT_PATTERN = /^shot-\d+-\d+\.png$/

/** Retry prunes to keep while the relay is still starting up. */
export const DEFAULT_KEEP_SHOTS = 20
