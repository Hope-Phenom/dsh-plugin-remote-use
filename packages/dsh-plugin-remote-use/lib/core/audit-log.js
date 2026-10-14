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
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveDshHome } from './settings-store.js'

/** How many bytes of the tail the page reads. Enough for a screenful, cheap to read. */
const TAIL_BYTES = 256 * 1024

/** Rows kept in memory for the page, newest last. */
const MEMORY_LIMIT = 200

/**
 * The `by` values that mean "nobody decided this".
 *
 * `timeout` is the queue's own budget expiring; `disposed` is the plugin unloading with the
 * request still open; `no-answerer` is the engine finding no one who could answer. All three
 * are refusals the operator had no chance to see at the moment they happened.
 */
const MISSED_BY = new Set(['timeout', 'disposed', 'no-answerer'])

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
    /** @type {object[]} newest last */
    this.rows = []
    this.lastError = ''
    this.#loadTail()
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
    const entry = { at: new Date(this.now()).toISOString(), ...row }
    this.rows.push(entry)
    if (this.rows.length > MEMORY_LIMIT) this.rows.splice(0, this.rows.length - MEMORY_LIMIT)
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

  /** Every miss still in memory, newest first. */
  missedAll() {
    return this.rows
      .filter((row) => row?.kind === 'approval' && MISSED_BY.has(String(row.by ?? '')))
      .reverse()
  }

  get missedCount() {
    return this.rows.reduce((n, row) => (row?.kind === 'approval' && MISSED_BY.has(String(row.by ?? '')) ? n + 1 : n), 0)
  }

  get size() {
    return this.rows.length
  }
}
