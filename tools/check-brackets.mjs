// check-brackets.mjs -- locate an unbalanced bracket in a file with no build step.
//
// WHY THIS EXISTS: `lib/client.js` is a browser module loaded as-is -- no bundler, no linter,
// so nothing catches a bracket mistake until DSH tries to load the page. `node --check`
// reports only the FIRST unexpected token, which for a long nested `h(...)` tree is usually
// far from the actual mistake: a single extra `)` on line 552 surfaced as an error on line
// 553 after the parser had already given up, and hand-counting parentheses across an 800-line
// render tree was slower and less reliable than this scan.
//
// It prints the running bracket depth per line, so the line where the depth goes somewhere
// impossible is the one to look at.
//
// Usage: node check-brackets.mjs <file> [fromLine] [toLine]
import { readFileSync } from 'node:fs'

const [, , file, from = '1', to = '0'] = process.argv
if (file === undefined) {
  console.error('usage: node check-brackets.mjs <file> [fromLine] [toLine]')
  process.exit(2)
}

const lines = readFileSync(file, 'utf8').split('\n')
const first = Number(from)
const last = Number(to) > 0 ? Number(to) : lines.length

let depth = 0
let quote = null
let template = false
let escaped = false
let blockComment = false
let negative = -1

for (let n = 0; n < lines.length; n += 1) {
  const line = lines[n]
  const before = depth
  let lineComment = false

  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    const prev = line[i - 1]
    if (lineComment) break
    if (blockComment) { if (prev === '*' && c === '/') blockComment = false; continue }
    if (quote !== null) {
      if (escaped) { escaped = false; continue }
      if (c === '\\') { escaped = true; continue }
      if (c === quote) quote = null
      continue
    }
    if (template) {
      if (escaped) { escaped = false; continue }
      if (c === '\\') { escaped = true; continue }
      if (c === '`') template = false
      continue
    }
    if (c === '/' && line[i + 1] === '/') { lineComment = true; break }
    if (c === '/' && line[i + 1] === '*') { blockComment = true; i += 1; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '`') { template = true; continue }
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1
      if (depth < 0 && negative < 0) negative = n + 1
    }
  }

  if (n + 1 >= first && n + 1 <= last) {
    const flag = depth < 0 ? '  <-- went negative' : ''
    console.log(`${String(n + 1).padStart(5)}  ${String(before).padStart(4)} -> ${String(depth).padStart(4)}  ${line.slice(0, 100)}${flag}`)
  }
}

console.log('')
console.log(`final depth: ${depth}${depth === 0 ? '  (balanced)' : '  <-- UNBALANCED'}`)
if (negative > 0) console.log(`first negative depth at line ${negative}`)
process.exit(depth === 0 && negative < 0 ? 0 : 1)
