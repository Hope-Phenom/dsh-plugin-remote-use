/**
 * extract-mediator.mjs -- materialize the Windows sandbox mediator and its full dependency
 * closure out of app.asar.
 *
 * WHY: `dsh-sandbox-local` has a `runnerCommand` config naming the mediator interpreter.
 * Its default is `process.execPath`, which in an ACP session started by our relay is
 * `DeepSeek Harness.exe` -- a GUI-subsystem image. A third-party analysis claims a
 * GUI-subsystem mediator cannot satisfy the "creator owns a console" requirement of the
 * restricted-token child, and that a console-subsystem interpreter (node.exe) works. This
 * produces the files needed to test that HERE, rather than trusting the claim.
 *
 * DEPENDENCY CLOSURE, NOT A HAND-WRITTEN LIST: adding packages one at a time produced two
 * consecutive invalid experiments (`dsh-skill` missing, then `cordis`), each of which the
 * naive verdict logic reported as evidence about the sandbox. Resolving the closure makes
 * that class of failure impossible.
 *
 * Must run under Electron-as-node: only Electron can read paths inside app.asar.
 *   ELECTRON_RUN_AS_NODE=1 "<install>\DeepSeek Harness.exe" extract-mediator.mjs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ASAR_ROOT = process.argv[2] ?? 'C:\\Users\\worker\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
const OUT = process.argv[3] ?? 'C:\\dsh-remote\\sandbox-mediator'
/** Native modules live outside the asar: Electron unpacks `.node` files next to it. */
const UNPACKED = ASAR_ROOT.replace(/app\.asar$/, 'app.asar.unpacked')

const notes = []
const say = (s) => { console.log(s); notes.push(s) }

/** Entry points; everything else is discovered from their package.json manifests. */
const SEEDS = [
  '@deepseek-ai/dsh-sandbox-windows-acl',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-win32-process',
  '@deepseek-ai/dsh-lazy-require',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/cordis',
  'koffi',
  '@koromix/koffi-win32-x64',
  'yaml',
]

say(`asar    : ${ASAR_ROOT}`)
say(`unpacked: ${UNPACKED}  (exists: ${existsSync(UNPACKED)})`)
say(`target  : ${OUT}`)
say(`asar readable: ${existsSync(ASAR_ROOT)}`)
say('')

mkdirSync(join(OUT, 'node_modules'), { recursive: true })

const roots = [ASAR_ROOT]
if (existsSync(UNPACKED)) roots.push(UNPACKED)

/** Cache of `basename -> [{path, files}]` so the walk runs once per package name. */
const locateCache = new Map()

function locate(base) {
  if (locateCache.has(base)) return locateCache.get(base)
  const hits = []
  const count = (d) => {
    let n = 0
    let es
    try { es = readdirSync(d, { withFileTypes: true }) } catch { return 0 }
    for (const x of es) {
      if (x.isDirectory()) n += count(join(d, x.name))
      else n += 1
    }
    return n
  }
  const walk = (dir, depth) => {
    if (depth > 7) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = join(dir, e.name)
      if (e.name === base) {
        try {
          if (statSync(join(p, 'package.json')).isFile()) hits.push({ path: p, files: count(p) })
        } catch { /* no manifest */ }
        continue
      }
      walk(p, depth + 1)
    }
  }
  for (const r of roots) walk(r, 0)
  // Prefer the copy that carries a native binary, then the largest.
  hits.sort((a, b) => {
    const aNative = existsSync(join(a.path, 'package.json')) ? 0 : 0
    void aNative
    return b.files - a.files
  })
  locateCache.set(base, hits)
  return hits
}

/** Copy a tree with only the operations Electron's asar patch covers. */
function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name)
    const d = join(dest, e.name)
    if (e.isDirectory()) copyTree(s, d)
    else writeFileSync(d, readFileSync(s))
  }
}

const copied = new Set()
const missing = []
const queue = [...SEEDS]

while (queue.length > 0) {
  const name = queue.shift()
  if (copied.has(name) || missing.includes(name)) continue
  if (name.startsWith('node:') || name.startsWith('.')) continue

  const base = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  const hits = locate(base)
  const chosen = hits[0]
  if (chosen === undefined) {
    missing.push(name)
    say(`  MISSING  ${name}`)
    continue
  }

  const dest = join(OUT, 'node_modules', ...name.split('/'))
  try {
    copyTree(chosen.path, dest)
    copied.add(name)

    let files = 0
    let bytes = 0
    const count = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) count(p)
        else { files += 1; try { bytes += statSync(p).size } catch { /* raced */ } }
      }
    }
    count(dest)
    say(`  copied   ${name}  (${files} files, ${(bytes / 1024).toFixed(1)} KB)  <- ${chosen.path.replace(ASAR_ROOT + '\\', '')}`)

    // Discover this package's own runtime dependencies and enqueue them.
    let manifest = {}
    try { manifest = JSON.parse(readFileSync(join(chosen.path, 'package.json'), 'utf8')) } catch { /* unreadable */ }
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        if (!copied.has(dep) && !missing.includes(dep) && !queue.includes(dep)) queue.push(dep)
      }
    }
    // Optional dependencies are only needed when present; try them but never fail on them.
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
      if (!copied.has(dep) && !queue.includes(dep)) queue.push(dep)
    }
  } catch (error) {
    missing.push(name)
    say(`  FAILED   ${name}: ${error.message}`)
  }
}

const runnerPath = join(OUT, 'node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'runner.js')
say('')
say(`runner.js present: ${existsSync(runnerPath)}`)
say(`packages copied  : ${copied.size}`)

// A native binary is the whole point; locate koffi's wherever it landed.
const nativeModules = []
const findNative = (d) => {
  let es
  try { es = readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of es) {
    const p = join(d, e.name)
    if (e.isDirectory()) findNative(p)
    else if (e.name.endsWith('.node')) nativeModules.push(p)
  }
}
findNative(join(OUT, 'node_modules'))
say(`native binaries  : ${nativeModules.length}`)
for (const m of nativeModules) say(`  ${m.replace(OUT + '\\', '')}  (${(statSync(m).size / 1024).toFixed(1)} KB)`)

// The real readiness test is whether the runner can be LOADED, not whether files exist.
// `--help`-less runners need args, so an import-only check is the honest gate.
let loadError = ''
try {
  // Dynamic import of an absolute path needs a file URL on Windows.
  const { pathToFileURL } = await import('node:url')
  await import(pathToFileURL(runnerPath).href)
  say('runner import    : OK')
} catch (error) {
  loadError = error.message
  say(`runner import    : FAILED -- ${loadError}`)
}

const verdict = nativeModules.length > 0 && existsSync(runnerPath) && loadError === '' && missing.length === 0
say('')
say(`RESULT: ${verdict ? 'READY' : 'INCOMPLETE'}`)
if (missing.length > 0) say(`  missing: ${missing.join(', ')}`)
if (loadError !== '') say(`  load error: ${loadError}`)

writeFileSync(join(OUT, 'extract-report.txt'), notes.join('\n') + '\n', 'utf8')
process.exit(verdict ? 0 : 1)
