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

  get size() {
    return this.rows.length
  }
}
