/**
 * Which bracket is unclosed, and where did it open?
 *
 * WHY THIS EXISTS: `node --check` reports the line where the parser GAVE UP, which is usually far
 * from the line that is actually wrong -- and a run of `)))))))` cannot be counted by eye. This
 * walks the file with a small state machine that skips strings, template literals and comments, so
 * a `(` inside a message can never skew the answer, and prints the openings that were never closed.
 *
 * Usage: node .research/js-balance.mjs <file.js>
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node .research/js-balance.mjs <file.js>')
  process.exit(2)
}

const src = readFileSync(file, 'utf8')
/** @type {{ ch: string, line: number }[]} */
const stack = []
const problems = []
let line = 1
let i = 0
/** @type {null | "'" | '"' | '`' | '//' | '/*'} */
let quoted = null

const PAIRS = { ')': '(', ']': '[', '}': '{' }
/** Marker pushed for a template's `${`, so its `}` returns to template mode, not to code. */
const SUBSTITUTION = '$'

while (i < src.length) {
  const ch = src[i]
  const next = src[i + 1]

  if (ch === '\n') {
    line += 1
    if (quoted === '//') quoted = null
    i += 1
    continue
  }

  if (quoted === '//') { i += 1; continue }
  if (quoted === '/*') {
    if (ch === '*' && next === '/') { quoted = null; i += 2; continue }
    i += 1
    continue
  }
  if (quoted !== null) {
    if (ch === '\\') { i += 2; continue }
    // `${ ... }` inside a template: re-enter code, remembering to come back on its `}`.
    if (quoted === '`' && ch === '$' && next === '{') { stack.push({ ch: SUBSTITUTION, line }); quoted = null; i += 2; continue }
    if (ch === quoted) { quoted = null; i += 1; continue }
    i += 1
    continue
  }

  if (ch === "'" || ch === '"' || ch === '`') { quoted = ch; i += 1; continue }
  if (ch === '/' && next === '/') { quoted = '//'; i += 2; continue }
  if (ch === '/' && next === '*') { quoted = '/*'; i += 2; continue }

  if (ch === '(' || ch === '[' || ch === '{') { stack.push({ ch, line }); i += 1; continue }
  if (ch === ')' || ch === ']' || ch === '}') {
    const open = stack.pop()
    if (open === undefined) problems.push(`line ${line}: '${ch}' closes nothing`)
    else if (open.ch === SUBSTITUTION) {
      // The `}` that ends a `${...}`: back into the template, not a bracket mismatch.
      if (ch !== '}') problems.push(`line ${line}: '${ch}' closes a template substitution opened on line ${open.line}`)
      else quoted = '`'
    } else if (open.ch !== PAIRS[ch]) {
      problems.push(`line ${line}: '${ch}' closes '${open.ch}' opened on line ${open.line}`)
    }
    i += 1
    continue
  }
  i += 1
}

console.log(`file      : ${file}`)
console.log(`unclosed  : ${stack.length}`)
for (const open of stack.slice(-12)) console.log(`  '${open.ch}' opened on line ${open.line}`)
for (const problem of problems.slice(0, 12)) console.log(`  ${problem}`)
if (stack.length === 0 && problems.length === 0) console.log('BALANCED')
process.exit(stack.length === 0 && problems.length === 0 ? 0 : 1)
