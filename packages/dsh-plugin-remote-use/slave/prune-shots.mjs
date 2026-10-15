/**
 * Screenshot housekeeping for the relay.
 *
 * Kept in its own module rather than inline because the relay is a long-lived script with no
 * test harness of its own: extracting this is what makes the deletion rules testable. It has
 * NO dependencies beyond `node:fs` and `node:path` so it can be copied to a worker alongside
 * `relay.mjs` without dragging anything else along.
 *
 * THREE RULES, ALL LOAD-BEARING:
 *
 *  1. Only delete files matching the caller's pattern. The directory is normally ours, but
 *     `--shot-dir` is configurable, and a mistyped path must not turn into deleted user data.
 *
 *  2. Never throw. This runs inside the capture path; failing to delete an old file must not
 *     fail the capture that just succeeded.
 *
 *  3. A byte ceiling that is missing, zero or nonsense means "no byte ceiling" -- never "delete
 *     everything". See the note on `opts.maxBytes` below: zero is the value an unconfigured
 *     install has, so reading it literally would wipe the cache on the first capture after an
 *     upgrade.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param {string} dir
 * @param {number} keep newest N to retain; non-finite or negative disables the count pass
 * @param {RegExp} pattern which filenames this caller is allowed to delete
 * @param {{ maxBytes?: number }} [opts] byte ceiling for the matching files
 * @returns {{ removed: number, kept: number, freedBytes: number, overBudgetBytes: number }}
 */
export function pruneShots(dir, keep, pattern, opts = {}) {
  // The result shape is CONSTANT across every call, including the three-argument one. An earlier
  // revision gated `overBudgetBytes` on `arguments.length` to keep a strict shape assertion in the
  // tests passing; that was the wrong trade. A return type that depends on how many arguments the
  // caller passed is a trap for the next caller -- `opts` has a default, so the fourth argument
  // already looks optional -- and the assertion it protected was testing the shape rather than the
  // behaviour. The test now checks the fields it cares about and this always reports all four.
  const nothing = { removed: 0, kept: 0, freedBytes: 0, overBudgetBytes: 0 }
  if (typeof dir !== 'string' || dir === '') return nothing
  // A non-finite or negative budget means "do not prune", never "delete everything". The
  // dangerous reading of a missing setting is 0.
  if (!Number.isFinite(keep) || keep < 0) return nothing
  if (!(pattern instanceof RegExp)) return nothing

  // The byte ceiling follows the same rule as the count budget, and for the same reason:
  // `--keep-shot-bytes` is absent on every install that has not opted in, so it arrives as 0 --
  // and a ceiling of 0 read literally means "keep nothing", i.e. delete the whole directory on
  // the first capture after an upgrade. So <= 0, non-finite and non-numeric all mean "no byte
  // budget", and the raw value is tested rather than coerced: `'64'` is not a number the caller
  // clearly meant, and the count budget already refuses `'20'` for exactly this reason.
  const maxBytes = Number.isFinite(opts?.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : 0

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

  // Pass 1: the count budget, which keeps the head of the sorted list. A file whose unlink failed
  // is still on disk, so it stays a candidate for pass 2 and is still counted as "kept".
  const keepCount = Math.max(0, Math.floor(keep))
  const surviving = []
  let removed = 0
  let freedBytes = 0
  for (const [index, file] of files.entries()) {
    if (index < keepCount) { surviving.push(file); continue }
    try {
      unlinkSync(join(dir, file.name))
      removed += 1
      freedBytes += file.size
    } catch { surviving.push(file) } // locked or already gone; the next capture tries again
  }

  // Pass 2: the byte ceiling, oldest first, so it only ever eats into what pass 1 was willing to
  // keep. The loop stops at one file: the newest capture is the one the master is about to read,
  // and deleting it would break the very download this housekeeping runs next to. A single file
  // over the ceiling therefore survives and the overage is reported instead -- a directory that
  // is one capture too large beats a screenshot that cannot be fetched.
  let overBudgetBytes = 0
  if (maxBytes > 0) {
    let total = surviving.reduce((sum, file) => sum + file.size, 0)
    for (let last = surviving.length; total > maxBytes && last > 1; last -= 1) {
      const victim = surviving[last - 1]
      try {
        unlinkSync(join(dir, victim.name))
        removed += 1
        freedBytes += victim.size
        total -= victim.size
      } catch { /* locked: it stays, and its bytes still count against the ceiling */ }
    }
    overBudgetBytes = Math.max(0, total - maxBytes)
  }

  const kept = files.length - removed
  return { removed, kept, freedBytes, overBudgetBytes }
}

/**
 * How much the matching files in `dir` occupy right now.
 *
 * WHY THIS IS SEPARATE FROM `pruneShots`: this is the reporting half of the pair, and the master
 * asks for it on a liveness ping -- so it must be cheap. It never reads file CONTENTS (one
 * `readdirSync` plus one `statSync` per matching name), which is what keeps a directory scan
 * acceptable next to a heartbeat.
 *
 * @param {string} dir
 * @param {RegExp} pattern
 * @returns {{ files: number, bytes: number, newestAt: number, oldestAt: number }}
 */
export function shotUsage(dir, pattern) {
  const empty = { files: 0, bytes: 0, newestAt: 0, oldestAt: 0 }
  if (typeof dir !== 'string' || dir === '') return empty
  if (!(pattern instanceof RegExp)) return empty

  let names
  try {
    names = readdirSync(dir)
  } catch {
    // A directory that is missing, or that this process may not read, has nothing to report.
    // Neither is an error: a first run has no directory yet.
    return empty
  }

  let files = 0
  let bytes = 0
  let newestAt = 0
  let oldestAt = 0
  for (const name of names) {
    if (!pattern.test(name)) continue
    try {
      const stat = statSync(join(dir, name))
      // A DIRECTORY named like a capture is skipped rather than counted: nothing wrote it here,
      // and `pruneShots` will not delete it either, so counting it would report bytes the cache
      // can never reclaim.
      if (!stat.isFile()) continue
      if (files === 0) {
        newestAt = stat.mtimeMs
        oldestAt = stat.mtimeMs
      } else {
        if (stat.mtimeMs > newestAt) newestAt = stat.mtimeMs
        if (stat.mtimeMs < oldestAt) oldestAt = stat.mtimeMs
      }
      files += 1
      bytes += stat.size
    } catch { /* vanished between listing and stat */ }
  }
  return { files, bytes, newestAt, oldestAt }
}

/** The names this relay writes: `shot-<epoch ms>-<sequence>.png`. */
export const RELAY_SHOT_PATTERN = /^shot-\d+-\d+\.png$/

/** Retry prunes to keep while the relay is still starting up. */
export const DEFAULT_KEEP_SHOTS = 20
