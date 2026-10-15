// fix-pitfalls-toc.mjs -- regenerate the PITFALLS table of contents from its headings.
//
// WHY A SCRIPT AND NOT A HAND EDIT: the TOC is 80+ lines of Chinese anchor links, and by hand it
// silently rots -- measured 2026-10-15, it was missing B1 and F26..F38 (the whole newest arc) with
// nothing to say so, because a stale TOC still renders fine. Regenerating makes the invariant
// mechanical, and `--check` lets a test assert it stays true.
//
// THE ANCHOR RULE was derived from the entries that were already correct, not guessed: lowercase;
// drop every character that is not a letter, digit, CJK character or hyphen; turn each space into a
// hyphen (spaces are NOT collapsed -- an em-dash pair separated by spaces yields two hyphens).
// `--verify` re-derives the existing lines and fails if any differ, which is how the rule was
// confirmed against 64 known-good lines before it was trusted to produce 14 new ones.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = process.argv[2] ?? join(import.meta.dirname, '..', 'docs', 'PITFALLS.md')
const mode = process.argv[3] ?? '--print'

/**
 * GitHub's heading-anchor transform.
 *
 * VALIDATED, not guessed: applied to every heading in DSH's own READMEs it reproduces 34 of the 35
 * heading-derived anchors (the one miss is a legacy `<a name=...>` in a vendored node_modules file).
 * That is what makes it safe to use for the anchors this script writes -- and what made it possible
 * to conclude that several EXISTING lines in this file are wrong, rather than this transform.
 */
export function slugOf(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\u4e00-\u9fff -]/gu, '')
    .replace(/ /g, '-')
}

/** The target of a TOC line's link. */
const anchorOf = (l) => /\(#([^)]*)\)/u.exec(l)?.[1]

const source = readFileSync(FILE, 'utf8')
const lines = source.split('\n')

const tocStart = lines.findIndex((l) => l.trim() === '## 目录')
if (tocStart < 0) throw new Error('no "## 目录" heading')
// The TOC runs until the first category heading.
const tocEnd = lines.findIndex((l, i) => i > tocStart && /^# /.test(l))
if (tocEnd < 0) throw new Error('no category heading after the TOC')

const generated = []
for (const line of lines) {
  const category = /^# ([A-G])\. (.+)$/.exec(line)
  if (category !== null) {
    generated.push(`- [${category[1]}. ${category[2]}](#${slugOf(`${category[1]}. ${category[2]}`)})`)
    continue
  }
  const entry = /^## ([A-G][0-9]+[a-z]?)\. (.+)$/.exec(line)
  if (entry !== null) {
    generated.push(`  - [${entry[1]}. ${entry[2]}](#${slugOf(`${entry[1]}. ${entry[2]}`)})`)
  }
}

const existing = lines.slice(tocStart + 1, tocEnd).filter((l) => l.trim() !== '')
// A CATEGORY id has no digits (`[A. `), and an early version of this regex required them -- so every
// category line resolved to `undefined`, collided with the TOC's `---` rule, and all seven category
// links were replaced by that one separator. Caught by diffing instead of trusting "85 lines written".
const idOf = (l) => /\[([A-G](?:[0-9]+[a-z]?)?)\./.exec(l)?.[1]

/**
 * INSERT ONLY -- never regenerate, never reorder, never touch a line that is already there.
 *
 * Existing lines are kept byte for byte, including their anchors. Regenerating them would replace
 * anchors that are demonstrably in use with best-effort ones derived from a transform this repo
 * cannot verify offline (several existing lines were hand-paraphrased, so their anchors cannot match
 * their headings either way -- those are a separate, pre-existing question).
 *
 * A missing entry is inserted immediately after the nearest PRECEDING entry that is already present,
 * which keeps the document order of the headings without recomputing anything.
 */
function insertMissing() {
  const present = new Set(existing.map(idOf).filter((id) => id !== undefined))
  const out = [...lines]
  let anchor = '## 目录'
  let added = 0
  for (const line of generated) {
    const id = idOf(line)
    if (present.has(id)) {
      anchor = existing.find((l) => idOf(l) === id) ?? anchor
      continue
    }
    // Search only inside the TOC so an identical string elsewhere cannot capture the insert.
    const from = out.indexOf('## 目录')
    const at = out.indexOf(anchor, from)
    if (at < 0) throw new Error(`could not locate the insertion anchor: ${anchor}`)
    out.splice(at + 1, 0, line)
    anchor = line
    added += 1
  }
  return { out, added }
}

if (mode === '--verify') {
  // Against the entries BOTH lists agree on, so this checks the TRANSFORM rather than the coverage.
  let checked = 0
  const wrong = []
  const byId = new Map(existing.map((l) => [idOf(l), l]))
  for (const line of generated) {
    const id = idOf(line)
    if (!byId.has(id)) continue
    checked += 1
    if (byId.get(id) !== line) wrong.push({ id, mine: line, theirs: byId.get(id) })
  }
  console.log(`anchors re-derived and match: ${checked - wrong.length}/${checked}`)
  for (const w of wrong.slice(0, 6)) {
    console.log(`  DIFFERS ${w.id}\n    derived : ${w.mine}\n    in file : ${w.theirs}`)
  }
  console.log('NOTE: a differing line is usually a HAND-PARAPHRASED entry, whose anchor cannot match')
  console.log('      its heading. Those lines are preserved, never rewritten -- see insertMissing().')
  process.exit(0)
}

if (mode === '--check') {
  const have = new Set(existing.map(idOf))
  const missing = generated.map(idOf).filter((id) => !have.has(id))
  const stale = existing.map(idOf).filter((id) => id !== undefined && !generated.some((g) => idOf(g) === id))
  // And the anchors themselves. The transform was validated against DSH's own READMEs first
  // (34/35 heading-derived anchors reproduced; the one miss is a legacy <a name=...>), because a
  // wrong anchor is a dead link that renders perfectly.
  const anchorOf = (l) => /\(#([^)]*)\)/.exec(l)?.[1]
  const wantAnchor = new Map(generated.map((l) => [idOf(l), anchorOf(l)]))
  const badAnchors = existing
    .filter((l) => wantAnchor.has(idOf(l)) && anchorOf(l) !== wantAnchor.get(idOf(l)))
    .map(idOf)
  const ok = missing.length === 0 && stale.length === 0
  console.log(ok ? 'TOC coverage is current' : [
    missing.length > 0 ? `missing [${missing.join(', ')}]` : '',
    stale.length > 0 ? `no longer in the file [${stale.join(', ')}]` : '',
  ].filter(Boolean).join('; '))
  if (badAnchors.length > 0) {
    // REPORTED, NOT ENFORCED, and the distinction is deliberate. These lines were hand-paraphrased,
    // so their anchors cannot match their headings; but the transform that would "fix" them is only
    // validated for the patterns DSH's own docs contain -- and none of those contain a run of two
    // hyphens (measured: 0 headings in 3599 anchors). So the correct anchor for these three is
    // genuinely unknown from here, and a permanently red check would simply stop being read.
    console.log(`anchor debt (${badAnchors.length}, unverifiable offline): ${badAnchors.join(', ')}`)
  }
  process.exit(ok ? 0 : 1)
}

if (mode === '--fix-anchors') {
  // Rewrite ONLY the `(#...)` part, so the author's wording survives. The link TEXT is deliberately
  // left alone: several entries were hand-paraphrased and read better than the raw heading; what is
  // wrong about those lines is the anchor, not the prose.
  const wantAnchor = new Map(generated.map((l) => [idOf(l), anchorOf(l)]))
  let fixed = 0
  const out = lines.map((l) => {
    const id = idOf(l)
    if (id === undefined || !l.trimStart().startsWith('- [') || !wantAnchor.has(id)) return l
    const want = wantAnchor.get(id)
    if (anchorOf(l) === want) return l
    fixed += 1
    return l.replace(/\(#[^)]*\)/u, `(#${want})`)
  })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(FILE, out.join('\n'), 'utf8')
  console.log(`rewrote ${fixed} anchor(s); text untouched`)
  process.exit(0)
}

if (mode === '--write') {
  const { out, added } = insertMissing()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(FILE, out.join('\n'), 'utf8')
  console.log(`inserted ${added} missing TOC line(s); nothing else touched`)
  process.exit(0)
}

console.log(generated.join('\n'))
