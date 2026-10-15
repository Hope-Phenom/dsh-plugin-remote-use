/**
 * Append-only audit trail for approvals.
 *
 * WHY IT EXISTS: the page can show what is pending, but "who approved what, and when" has to
 * outlive the process. Without it an approval is indistinguishable from a rule the engine
 * applied silently, which is exactly the question an operator asks after the fact.
 *
 * WHY ITS OWN FILE RATHER THAN THE SETTINGS FILE: the settings file is rewritten whole on
 * every save. An audit trail must be APPEND-ONLY -- a rewrite is a chance to lose the very
 * record you are trying to keep.
 *
 * WHY IT NEVER THROWS: it observes the approval path. A full disk or a locked file must not
 * turn into a failed approval, so every failure is reported through `lastError` and the
 * caller carries on. That is a deliberate trade: an audit trail that can veto an operation
 * is worse than one that reports it could not write.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveDshHome } from './settings-store.js'

/** How many bytes of the tail the page reads. Enough for a screenful, cheap to read. */
const TAIL_BYTES = 256 * 1024

/** Rows kept in memory for the page, newest last. */
const MEMORY_LIMIT = 200

/**
 * Rotate the live file once it reaches this size.
 *
 * WHY A CAP AT ALL: the trail is append-only and, until 0.2.12, unbounded -- it grew for as long as
 * the plugin was installed. An append-only file has no natural stopping point, so "nobody noticed"
 * is exactly what unbounded growth looks like. At the measured ~670 bytes per row this is roughly
 * 12,000 rows, i.e. years of ordinary use: a cap that bounds the worst case without costing an
 * operator anything they would miss.
 */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** Rotated files kept beside the live one. The oldest beyond this is deleted -- see `#prune`. */
const DEFAULT_KEEP_FILES = 5

/** `audit.<stamp>.jsonl`, i.e. an archive rather than the live `audit.jsonl`. */
const ARCHIVE_RE = /^audit\..+\.jsonl$/

/**
 * The `by` values that mean "nobody decided this".
 *
 * `timeout` is the queue's own budget expiring; `disposed` is the plugin unloading with the
 * request still open; `no-answerer` is the engine finding no one who could answer. All three
 * are refusals the operator had no chance to see at the moment they happened.
 */
const MISSED_BY = new Set(['timeout', 'disposed', 'no-answerer'])

/**
 * The row that moves the operator-facing view's starting point.
 *
 * WHY A WATERMARK AND NOT A DELETE: this file is the evidence trail for "who approved what".
 * Erasing the misses would make the trail lie about what happened, and the operator's own request
 * to clear a list is not a reason to destroy a record of an unattended refusal. Appending a row
 * keeps both facts -- every miss, and the fact that the view was cleared, when, and by which route.
 */
const CLEARED_KIND = 'approvals-cleared'

/** @param {Record<string, string | undefined>} [env] */
export function auditPath(env = process.env) {
  return join(resolveDshHome(env), 'storages', 'dsh-plugin-remote-use', 'audit.jsonl')
}

export class AuditLog {
  /**
   * @param {object} [opts]
   * @param {Record<string, string | undefined>} [opts.env]
   * @param {() => number} [opts.now]
   * @param {(level: 'warn', message: string) => void} [opts.log]
   */
  constructor(opts = {}) {
    const env = opts.env ?? process.env
    this.file = auditPath(env)
    this.now = opts.now ?? (() => Date.now())
    this.log = opts.log ?? (() => {})
    /** Rotate the live file at this size. <= 0 disables rotation (keep everything). */
    this.maxBytes = Number.isFinite(opts.maxBytes) ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES
    /** How many archives to keep. < 0 keeps every archive. */
    this.keepFiles = Number.isFinite(opts.keepFiles) ? Number(opts.keepFiles) : DEFAULT_KEEP_FILES
    /** @type {object[]} newest last */
    this.rows = []
    this.lastError = ''
    /**
     * WHERE THE VISIBLE VIEW STARTS: the index of the newest clear watermark in `rows`, or -1 when
     * no clear has happened (everything visible).
     *
     * BY POSITION, NOT BY TIMESTAMP. The first implementation compared ISO timestamps, and the test
     * for "a miss recorded after the clear is shown again" failed: `at` has millisecond resolution,
     * so a row written in the same millisecond as the watermark compared as `<=` and vanished. Index
     * order is the file's real order, exact at any speed.
     */
    this.clearedIndex = -1
    /** The watermark's timestamp, for display only. */
    this.clearedAt = ''
    /** Who cleared it, so a rotation can carry the watermark forward without inventing an actor. */
    this.clearedBy = ''
    this.#loadTail()
  }

  /** Point the view at whatever the newest watermark in memory says (-1 = none). */
  #adoptWatermark() {
    let index = -1
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.rows[i]?.kind === CLEARED_KIND) { index = i; break }
    }
    this.clearedIndex = index
    this.clearedAt = index === -1 || typeof this.rows[index]?.at !== 'string' ? '' : this.rows[index].at
    this.clearedBy = index === -1 ? '' : String(this.rows[index]?.by ?? '')
  }

  /** Read recent rows so the page has history across a restart. */
  #loadTail() {
    if (!existsSync(this.file)) return
    try {
      const size = statSync(this.file).size
      const start = Math.max(0, size - TAIL_BYTES)
      // A partial first line is expected when reading a tail; JSON.parse drops it below.
      const text = readFileSync(this.file, 'utf8').slice(start)
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          const row = JSON.parse(line)
          if (row !== null && typeof row === 'object') this.rows.push(row)
        } catch { /* a torn or partial line is skipped, never fatal */ }
      }
      if (this.rows.length > MEMORY_LIMIT) this.rows.splice(0, this.rows.length - MEMORY_LIMIT)
      this.#adoptWatermark()
    } catch (error) {
      this.lastError = `could not read ${this.file}: ${error instanceof Error ? error.message : String(error)}`
      this.log('warn', this.lastError)
    }
  }

  /**
   * Append one row. Never throws.
   * @param {object} row
   * @returns {boolean} whether it reached the disk
   */
  record(row) {
    // Before writing, not after: the point of the cap is that the file never exceeds it.
    this.#rotateIfNeeded()
    const entry = { at: new Date(this.now()).toISOString(), ...row }
    this.rows.push(entry)
    if (this.rows.length > MEMORY_LIMIT) {
      const dropped = this.rows.length - MEMORY_LIMIT
      this.rows.splice(0, dropped)
      // Keep the watermark pointing at its OWN row after a trim. Dropping the watermark's row means
      // every row before it went too, so everything left is after the clear: -1 (all visible) is
      // then the correct answer, not a stale index into a shifted array.
      this.clearedIndex = Math.max(-1, this.clearedIndex - dropped)
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8')
      this.lastError = ''
      return true
    } catch (error) {
      this.lastError = `could not append to ${this.file}: ${error instanceof Error ? error.message : String(error)}`
      this.log('warn', this.lastError)
      return false
    }
  }

  /** Recent rows, newest first. */
  tail(limit = 30) {
    return this.rows.slice(-Math.max(0, limit)).reverse()
  }

  /** Bytes on disk for the live file, 0 when it does not exist yet. */
  get bytes() {
    try {
      return statSync(this.file).size
    } catch {
      return 0
    }
  }

  /** The rotated archives beside the live file, oldest first. */
  archives() {
    try {
      return readdirSync(dirname(this.file))
        .filter((name) => ARCHIVE_RE.test(name))
        .map((name) => {
          let size = 0
          try { size = statSync(join(dirname(this.file), name)).size } catch { /* raced away */ }
          return { name, bytes: size }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return []
    }
  }

  /**
   * Rotate before the live file would exceed the cap.
   *
   * ROTATE, NEVER TRUNCATE. Truncating the live file is the one operation this class must not do:
   * the whole reason the trail is its own append-only file is that a rewrite is a chance to lose the
   * record you are trying to keep (see the header). Renaming keeps every byte written so far intact
   * and gives the next write a fresh file to append to.
   */
  #rotateIfNeeded() {
    if (!(this.maxBytes > 0)) return
    let size = 0
    try { size = statSync(this.file).size } catch { return }  // no file yet: nothing to rotate
    if (size < this.maxBytes) return
    this.#rotate()
  }

  #rotate() {
    const dir = dirname(this.file)
    // Sortable and second-resolution; a second rotation inside the same second takes a suffix
    // rather than overwriting an archive it just created.
    const stamp = new Date(this.now()).toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-')
    let target = join(dir, `audit.${stamp}.jsonl`)
    for (let n = 1; existsSync(target); n += 1) target = join(dir, `audit.${stamp}.${n}.jsonl`)
    try {
      renameSync(this.file, target)
    } catch (error) {
      // Unrotated is the safe failure: the trail keeps growing instead of losing rows.
      this.lastError = `could not rotate ${this.file}: ${error instanceof Error ? error.message : String(error)}`
      this.log('warn', this.lastError)
      return
    }

    // CARRY THE WATERMARK INTO THE NEW FILE. The clear watermark lives as a ROW, and rotation moves
    // the row it lives in to the archive -- which `#loadTail` does not read. Without this, every
    // restart after a rotation would resurrect the misses the operator had cleared.
    if (this.clearedIndex >= 0) {
      const carried = { at: this.clearedAt, kind: CLEARED_KIND, by: this.clearedBy, carried: true }
      try {
        appendFileSync(this.file, `${JSON.stringify(carried)}\n`, 'utf8')
      } catch (error) {
        this.lastError = `could not carry the clear watermark into ${this.file}: ${error instanceof Error ? error.message : String(error)}`
        this.log('warn', this.lastError)
      }
    }
    this.#prune()
  }

  /** Delete the oldest archives beyond `keepFiles`. THE ONLY DESTRUCTIVE ACT IN THIS FILE. */
  #prune() {
    if (this.keepFiles < 0) return
    const archives = this.archives()
    const excess = archives.length - this.keepFiles
    if (excess <= 0) return
    for (const archive of archives.slice(0, excess)) {
      try {
        unlinkSync(join(dirname(this.file), archive.name))
        // Reported rather than silent: removing evidence is worth a line in the operator's log,
        // even when it is the retention rule doing exactly what it was configured to do.
        this.log('warn', `audit retention removed the oldest archive: ${archive.name}`)
      } catch (error) {
        this.lastError = `could not remove ${archive.name}: ${error instanceof Error ? error.message : String(error)}`
        this.log('warn', this.lastError)
      }
    }
  }

  /**
   * Approvals that expired with nobody answering -- the ones the operator never saw.
   *
   * WHY THIS IS NOT JUST `tail()` FILTERED IN THE PAGE: six such rows sat in the live trail on
   * 2026-10-14 (five of them inside eight minutes) and the operator had never seen a single
   * prompt. A refusal that leaves no trace the page can surface is indistinguishable from the
   * plugin being broken, so the misses get their own accessor instead of hiding among the rows
   * that were decided.
   *
   * `disposed` counts as missed: the request was still waiting when the plugin unloaded, so no
   * person ever answered it either. The page labels the two differently.
   *
   * @param {number} [limit] how many to return, newest first
   */
  missed(limit = 20) {
    return this.missedAll().slice(0, Math.max(0, limit))
  }

  /** Every miss still in the operator-facing view, newest first. */
  missedAll() {
    return this.#visible()
      .filter((row) => row?.kind === 'approval' && MISSED_BY.has(String(row.by ?? '')))
      .reverse()
  }

  get missedCount() {
    return this.#visible().reduce((n, row) => (row?.kind === 'approval' && MISSED_BY.has(String(row.by ?? '')) ? n + 1 : n), 0)
  }

  /**
   * Rows at or after the last clear watermark -- what the operator-facing views show.
   */
  #visible() {
    return this.rows.slice(this.clearedIndex + 1)
  }

  /**
   * Move the view's starting point past everything recorded so far.
   *
   * NOTHING IS DELETED -- see `CLEARED_KIND`. The caller gets the number of misses the views will
   * stop showing, so the page can say what it did instead of looking like it did nothing.
   *
   * @param {string} [by] provenance of the click ('page' for a person, 'api' otherwise)
   * @returns {number} misses the views stop showing
   */
  clear(by = 'api') {
    const cleared = this.missedCount
    this.record({ kind: CLEARED_KIND, by })
    this.clearedIndex = this.rows.length - 1
    this.clearedAt = typeof this.rows[this.clearedIndex]?.at === 'string' ? this.rows[this.clearedIndex].at : ''
    this.clearedBy = String(by)
    return cleared
  }

  get size() {
    return this.rows.length
  }
}
