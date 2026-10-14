#!/usr/bin/env node
/**
 * Check every relative link and image in the tracked Markdown, so a file that moved does not leave
 * a silent 404 behind.
 *
 * WHY THIS EXISTS: the documentation is the deliverable here, and it is full of cross-references --
 * `docs/PITFALLS.md` from the README, `../README.md` from the docs index, anchors from one pitfall
 * to another. `git mv` fixes the file, not the links pointing at it, and a broken link is invisible
 * until a reader clicks it.
 *
 * It also validates ABSOLUTE GitHub URLs that point at THIS repository: those are the ones the npm
 * package READMEs use (npm readers cannot follow a relative path into the repo), and they break the
 * same way when a directory is renamed.
 *
 * Usage: node .research/check-doc-links.mjs
 * Exit 0 = every link resolves.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = process.cwd()
const SELF = 'https://github.com/Hope-Phenom/dsh-plugin-remote-use'

// TRACKED **AND** untracked-but-not-ignored. `git ls-files` alone misses a file that has just been
// written and not yet added -- which is exactly the file whose links are newest and least reviewed.
// The first version used `git ls-files` and reported "ALL LINKS RESOLVE" without ever reading the two
// documents it had just been written alongside (found by mutation: breaking a link in that file
// changed nothing).
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], { encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter((s) => s !== '' && !s.includes('node_modules') && !s.startsWith('.research/asar'))
  .sort()

let broken = 0
let checked = 0

for (const file of files) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  const dir = dirname(join(ROOT, file))
  const lines = text.split(/\r?\n/)

  // FENCED CODE IS NOT OUR LINK. The research notes quote upstream DSH READMEs verbatim, inside
  // ```md fences, provenance comments and all -- including their own relative links and one literal
  // `](...)` placeholder. Checking those reports five broken links that were never ours to fix, and
  // a checker that always cries wolf is a checker nobody reads.
  let inFence = false

  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/u.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return

    // INLINE CODE IS NOT OUR LINK EITHER: `[runClientConnectHandlers](connection)` is JSDoc notation
    // quoted inside backticks, not a markdown link. Strip the spans first -- a link whose TEXT is
    // backticked keeps its target, because only the span disappears.
    const scannable = line.replace(/`[^`]*`/gu, '')

    for (const m of scannable.matchAll(/\]\(([^)\s]+)\)/gu)) {
      const target = m[1]
      if (/^(https?:|mailto:|#)/u.test(target)) {
        // Absolute URLs into this repo must still point at something that exists.
        if (target.startsWith(SELF)) {
          const path = target.slice(SELF.length).replace(/^\/blob\/(master|main)\//u, '').split('#')[0]
          if (path !== '' && !path.startsWith('?')) {
            checked += 1
            if (!existsSync(join(ROOT, path))) {
              broken += 1
              console.log(`  BROKEN  ${file}:${i + 1}  ${target}  (no such path: ${path})`)
            }
          }
        }
        continue
      }
      const path = target.split('#')[0]
      if (path === '') continue
      checked += 1
      const abs = resolve(dir, path)
      if (!existsSync(abs)) {
        broken += 1
        console.log(`  BROKEN  ${file}:${i + 1}  ${target}  (resolved to ${relative(ROOT, abs)})`)
      }
    }
  })
}

console.log(`\nchecked ${checked} links in ${files.length} tracked Markdown files`)
console.log(broken === 0 ? '===== ALL LINKS RESOLVE =====' : `===== ${broken} BROKEN LINK(S) =====`)
process.exit(broken === 0 ? 0 : 1)
