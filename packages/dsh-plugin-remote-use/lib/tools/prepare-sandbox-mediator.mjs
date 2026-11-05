#!/usr/bin/env node
/**
 * prepare-sandbox-mediator.mjs -- the one command the worker-side sandbox gate prescribes.
 *
 * WHO RUNS THIS, AND WHY IT IS NOT AUTOMATIC. The settings page diagnoses what is missing and
 * prints this script's invocation with every path filled in (lib/core/sandbox-diagnosis.js). It
 * does NOT run it: materializing a mediator writes ~1300 files to a machine path and (when the
 * profile is not wired yet) appends a row to `%DSH_HOME%\profiles\acp\cordis.patch.yml`, which is
 * the OPERATOR's file, not the plugin's own state. A page visit must not do that on its own; a
 * person or an agent they point at the printed command can. The probe is still the thing that
 * decides whether arming is allowed.
 *
 * WHAT IT DOES, IN ORDER
 *   1. read the profile; if it already names a shim, that directory is the target (the profile is
 *      the source of truth -- see sandbox-probe.js), so the operator's existing wiring is honored
 *      and nothing is rewritten;
 *   2. materialize the mediator there if `shim.mjs` + the runner closure are missing. The closure
 *      is read OUT of the running installation's `app.asar`, because plain node.exe cannot read
 *      inside it: this script re-runs itself under `DeepSeek Harness.exe` with
 *      `ELECTRON_RUN_AS_NODE=1` for that step;
 *   3. drop the shipped `mediator-shim.mjs` in as `shim.mjs` (the console-subsystem mediator that
 *      translates bwrap arguments -- see that file's header);
 *   4. ONLY when the profile has no `sandbox` entry at all, append one naming this node.exe and
 *      this shim. An existing entry is never rewritten: a second entry for the same id would be a
 *      merge nobody can predict from reading the file;
 *   5. run the six-check probe and report. Exit code: 0 ready, 1 not ready, 2 could not run.
 *
 * IDEMPOTENT. A second run over a healthy machine touches no files (`--dry-run` proves it).
 *
 * USAGE
 *   node prepare-sandbox-mediator.mjs [--dsh-home <dir>] [--profile acp]
 *                                    [--install <dir>] [--target <dir>] [--dry-run]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspectSandbox } from '../core/sandbox-diagnosis.js'
import { probeSandbox } from '../core/sandbox-probe.js'
import { resolveDshHome } from '../core/settings-store.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHIM_SOURCE = join(HERE, 'mediator-shim.mjs')
const SELF = fileURLToPath(import.meta.url)

/** Packages the runner needs at run time. A hand-written list was tried and failed twice. */
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

/** The managed block this script appends when the profile has no `sandbox` row at all. */
export const MANAGED_HEADER = '# --- dsh-plugin-remote-use managed (auto-generated; delete this block to let the plugin prescribe again) ---'
export const MANAGED_FOOTER = '# --- end dsh-plugin-remote-use managed ---'

/**
 * @param {{ nodeExe: string, shim: string }} opts
 * @returns {string} a YAML list of one `sandbox` entry
 */
export function sandboxEntry({ nodeExe, shim }) {
  const quoted = (p) => String(p).replace(/\\/gu, '\\\\')
  return [
    MANAGED_HEADER,
    '# The Windows sandbox build its mediator from `process.execPath`, which is',
    '# "DeepSeek Harness.exe" -- a GUI-subsystem image. Windows never allocates a console to one,',
    '# so the restricted child dies during DLL initialization and EVERY command fails silently.',
    '# node.exe is a console-subsystem image, and shim.mjs translates bwrap arguments to the',
    '# Windows runner. Re-run prepare-sandbox-mediator.mjs if the mediator directory is removed.',
    '- id: sandbox',
    "  name: '@deepseek-ai/dsh-sandbox-local'",
    '  config:',
    '    runnerCommand:',
    `      - "${quoted(nodeExe)}"`,
    `      - "${quoted(shim)}"`,
    '    runnerFailureSignatures:',
    '      - "windows-acl-run: "',
    MANAGED_FOOTER,
  ].join('\n')
}

/** Does the profile already contain a sandbox row (wired or not)? */
export function hasSandboxEntry(text) {
  return /(?:^|\n)\s*-\s*id:\s*sandbox\s*(?:\n|$)/u.test(String(text ?? ''))
}

/**
 * Remove a standalone `[]` line.
 *
 * DSH's profile template IS the empty flow array: `[]` is a complete YAML document, and appending
 * entries after it produces TWO documents with no `---` separator. The ACP child then refuses the
 * whole profile ("end of the stream or a document separator is expected") while the arming probe,
 * which reads the file structurally, is happy. Measured 2026-11-05: the worker armed, and every
 * ACP connection afterwards closed -- the master saw only `S0 worker reachable: fail` (PITFALLS F45).
 *
 * A file that is ONLY `[]` is valid and is left alone by the caller.
 *
 * @param {string} text
 * @returns {{ text: string, removed: boolean }}
 */
export function stripEmptyListMarker(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const kept = lines.filter((line) => !/^[ \t]*\[\][ \t]*$/u.test(line))
  return { text: kept.join('\n'), removed: kept.length !== lines.length }
}

/**
 * Ask the REAL consumer whether this profile parses.
 *
 * `--dump-config` composes the profile (including this overlay) and exits non-zero on a parse or
 * schema error. It is the same loader the ACP child uses, which is the point: the arming probe
 * cannot answer this question, and a profile that parses in one place and not the other is how a
 * worker arms and then cannot serve a single connection.
 *
 * @param {{ installDir: string, profile: string }} opts
 * @returns {{ ok: boolean, detail: string }}
 */
export function validateProfile(opts) {
  const exe = join(opts.installDir, 'DeepSeek Harness.exe')
  const cli = join(opts.installDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  const run = spawnSync(exe, ['--expose-internals', cli, '--profile', opts.profile, '--dump-config'], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  if (run.error !== undefined) return { ok: false, detail: run.error.message }
  if (run.status !== 0) {
    return { ok: false, detail: String(run.stderr ?? '').trim().split(/\r?\n/u).slice(-4).join(' / ') }
  }
  return { ok: true, detail: '' }
}

/**
 * Append the managed block, preserving the file's own text byte for byte.
 *
 * NO BOM: a BOM written here would be the third time this project made a YAML file unreadable
 * (PITFALLS E8). `writeFileSync` with 'utf8' writes none.
 *
 * @param {string} text
 * @param {string} entry
 * @returns {string}
 */
export function appendEntry(text, entry) {
  // `[]` is the profile template's EMPTY LIST -- the patch list itself. Appending after it makes a
  // second YAML document; see stripEmptyListMarker.
  const { text: stripped } = stripEmptyListMarker(text)
  const base = stripped.replace(/\s+$/u, '')
  if (base === '') return `${entry}\n`
  return `${base}\n\n${entry}\n`
}

/** @param {string} file */
function readText(file) {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// extraction from app.asar
// ---------------------------------------------------------------------------

/**
 * Copy the runner's dependency closure out of `app.asar`.
 *
 * WHY A CLOSURE AND NOT A LIST: adding packages one at a time produced two consecutive invalid
 * experiments, each reported as evidence about the sandbox. Resolving `dependencies` from each
 * copied manifest makes that class of failure impossible.
 *
 * MUST RUN WHERE `fs` CAN READ app.asar -- i.e. under Electron. That is ensured by the caller.
 *
 * @param {string} asarRoot
 * @param {string} outDir
 * @returns {{ ok: boolean, copied: number, missing: string[], natives: number }}
 */
export function extractAsar(asarRoot, outDir) {
  const unpacked = asarRoot.replace(/app\.asar$/u, 'app.asar.unpacked')
  const roots = [asarRoot]
  if (existsSync(unpacked)) roots.push(unpacked)
  mkdirSync(join(outDir, 'node_modules'), { recursive: true })

  const locateCache = new Map()
  /** @param {string} base */
  const locate = (base) => {
    if (locateCache.has(base)) return locateCache.get(base)
    const hits = []
    const count = (dir) => {
      let n = 0
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
      for (const entry of entries) {
        if (entry.isDirectory()) n += count(join(dir, entry.name))
        else n += 1
      }
      return n
    }
    const walk = (dir, depth) => {
      if (depth > 7) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const p = join(dir, entry.name)
        if (entry.name === base) {
          try {
            if (statSync(join(p, 'package.json')).isFile()) hits.push({ path: p, files: count(p) })
          } catch { /* no manifest */ }
          continue
        }
        walk(p, depth + 1)
      }
    }
    for (const root of roots) walk(root, 0)
    hits.sort((a, b) => b.files - a.files)
    locateCache.set(base, hits)
    return hits
  }

  const copyTree = (src, dest) => {
    mkdirSync(dest, { recursive: true })
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const s = join(src, entry.name)
      const d = join(dest, entry.name)
      if (entry.isDirectory()) copyTree(s, d)
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
    const chosen = locate(base)[0]
    if (chosen === undefined) {
      missing.push(name)
      process.stdout.write(`  MISSING  ${name}\n`)
      continue
    }
    const dest = join(outDir, 'node_modules', ...name.split('/'))
    try {
      copyTree(chosen.path, dest)
      copied.add(name)
    } catch (error) {
      missing.push(name)
      process.stdout.write(`  FAILED   ${name}: ${error instanceof Error ? error.message : String(error)}\n`)
      continue
    }
    let manifest = {}
    try { manifest = JSON.parse(readFileSync(join(chosen.path, 'package.json'), 'utf8')) } catch { /* unreadable */ }
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        if (!copied.has(dep) && !missing.includes(dep) && !queue.includes(dep)) queue.push(dep)
      }
    }
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
      if (!copied.has(dep) && !queue.includes(dep)) queue.push(dep)
    }
  }

  const natives = []
  const findNative = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) findNative(p)
      else if (entry.name.endsWith('.node')) natives.push(p)
    }
  }
  findNative(join(outDir, 'node_modules'))

  const runner = join(outDir, 'node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'runner.js')
  // `missing` includes optional dependencies for OTHER platforms, which is normal and must not fail
  // the run: koffi lists every OS/arch variant as optional, and only this machine's is present.
  // Only a seed that is absent is a real failure -- the seeds are the entry points this mediator
  // cannot start without.
  const missingRequired = missing.filter((name) => SEEDS.includes(name))
  return {
    ok: existsSync(runner) && natives.length > 0 && missingRequired.length === 0,
    copied: copied.size,
    missing,
    missingRequired,
    natives: natives.length,
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function argOf(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

/**
 * @param {string[]} [argv]
 * @param {object} [deps]  injectable for tests: env, exists, spawn, probe, write
 */
export function main(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const say = deps.say ?? ((line) => process.stdout.write(`${line}\n`))
  const dryRun = argv.includes('--dry-run')

  // The internal mode: only reachable when this file re-runs itself under Electron.
  const extractIndex = argv.indexOf('--extract-asar')
  if (extractIndex >= 0) {
    const asarRoot = argv[extractIndex + 1] ?? ''
    const outDir = argv[extractIndex + 2] ?? ''
    if (asarRoot === '' || outDir === '') {
      say('--extract-asar needs <app.asar> <outDir>')
      return 2
    }
    say(`extracting into ${outDir}`)
    const result = extractAsar(asarRoot, outDir)
    say(`copied ${result.copied} packages, ${result.natives} native binaries`
      + (result.missingRequired.length > 0 ? `, MISSING REQUIRED: ${result.missingRequired.join(', ')}` : '')
      + (result.missing.length > result.missingRequired.length
        ? `, absent optional (other platforms): ${result.missing.length - result.missingRequired.length}`
        : ''))
    return result.ok ? 0 : 1
  }

  const profile = argOf(argv, 'profile', 'acp')
  if (!/^[\w.-]+$/u.test(profile)) {
    say(`refusing profile name ${JSON.stringify(profile)}: expected a plain profile name`)
    return 2
  }
  const installArg = argOf(argv, 'install', undefined)
  const targetArg = argOf(argv, 'target', undefined)

  const home = argOf(argv, 'dsh-home', undefined) ?? resolveDshHome(env)
  const profilePath = join(home, 'profiles', profile, 'cordis.patch.yml')

  // REPAIR BEFORE DIAGNOSING: the `[]` + entries shape is invalid YAML, and leaving it in place
  // would make the diagnosis report "unwired" (the guard in sandbox-probe.js) and this script
  // refuse to touch a file that it is the one able to fix.
  let profileText = readText(profilePath)
  const marker = profileText === undefined ? { text: undefined, removed: false } : stripEmptyListMarker(profileText)
  if (marker.removed && /(?:^|\n)[ \t]*-[ \t]/u.test(String(profileText))) {
    if (dryRun) {
      say('  profile    : would remove the invalid `[]` marker (two YAML documents -> the ACP child refuses to start)')
    } else {
      try { writeFileSync(`${profilePath}.bak-bracefix-${Date.now()}`, String(profileText), 'utf8') } catch { /* best effort */ }
      writeFileSync(profilePath, marker.text, 'utf8')
      profileText = marker.text
      say('  profile    : removed the invalid `[]` line (two YAML documents -> the ACP child refused to start)')
    }
  }

  const diagnosis = inspectSandbox({
    env,
    home,
    profilePath,
    installDir: installArg === undefined ? undefined : installArg,
    exists,
    // Injected so a test can describe a machine without a real PE image to inspect.
    subsystem: deps.subsystem,
  })

  say('sandbox mediator preparation')
  say(`  dsh home   : ${diagnosis.home}`)
  say(`  profile    : ${profilePath}`)
  say(`  install    : ${diagnosis.installDir === '' ? '(not found)' : diagnosis.installDir}`)
  say(`  node.exe   : ${diagnosis.nodeExe === '' ? '(not found)' : diagnosis.nodeExe}`)
  say(`  state now  : ${diagnosis.state}${diagnosis.reason === '' ? '' : ` -- ${diagnosis.reason}`}`)
  say('')

  if (diagnosis.platform !== 'win32') {
    say('this platform has no Windows sandbox mediator to prepare')
    return 2
  }
  if (diagnosis.installDir === '' || diagnosis.nodeExe === '') {
    say('cannot prepare: the installation or a console-subsystem node.exe was not found')
    say('pass --install <dir> and/or set DSH_NODE_EXE to a node.exe')
    return 2
  }

  // 1. target = what the profile already names (the profile is the source of truth).
  const alreadyHasEntry = profileText !== undefined && hasSandboxEntry(profileText)
  const target = diagnosis.profileNamesShim
    ? diagnosis.mediatorDir
    : (targetArg ?? join(diagnosis.home, 'sandbox-mediator'))
  say(`  target     : ${target}`)

  if (diagnosis.profileNamesShim && targetArg !== undefined && targetArg.toLowerCase() !== target.toLowerCase()) {
    say(`  note       : ignoring --target; the profile already names ${diagnosis.shim}`)
  }
  if (!diagnosis.profileNamesShim && alreadyHasEntry) {
    say('')
    say('the profile already has a `sandbox` entry this script will not rewrite:')
    say(`  ${diagnosis.profileReason}`)
    say('fix or remove that block by hand, then run this again')
    return 1
  }

  // 2. materialize the runner closure if it is not there.
  const shim = join(target, 'shim.mjs')
  const runner = join(target, 'node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'runner.js')
  const haveRunner = exists(runner)
  const haveShim = exists(shim)
  let materialized = haveRunner && haveShim
  if (materialized) {
    say('  mediator   : already materialized -- leaving it alone')
  } else if (dryRun) {
    say(`  mediator   : ${haveRunner ? 'shim.mjs is missing' : 'MISSING'} (would materialize from app.asar)`)
  } else if (haveRunner) {
    // A previous run that stopped after extraction, or someone deleted the shim. Re-installing the
    // shipped shim is cheap and cannot regress the runner, so there is no reason to re-extract here.
    writeFileSync(shim, readFileSync(SHIM_SOURCE))
    materialized = true
    say(`  shim       : installed at ${shim} (the runner was already present)`)
  } else {
    const asarRoot = join(diagnosis.installDir, 'resources', 'app.asar')
    if (!exists(asarRoot)) {
      say(`cannot prepare: ${asarRoot} does not exist`)
      return 2
    }
    mkdirSync(target, { recursive: true })
    const spawn = deps.spawn ?? spawnSync
    const exe = join(diagnosis.installDir, 'DeepSeek Harness.exe')
    say(`  extracting : ${relative(diagnosis.installDir, asarRoot)} -> ${target}`)
    // Re-run THIS file under Electron so `fs` can read app.asar. stdio is inherited: the
    // operator sees the package-by-package trace, and a failure is visible where it happened.
    const run = spawn(exe, [SELF, '--extract-asar', asarRoot, target], {
      stdio: 'inherit',
      windowsHide: true,
      timeout: 300_000,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    })
    if (run.error !== undefined || (run.status ?? 1) !== 0) {
      say(`  extraction failed (${run.error?.message ?? `exit ${run.status}`})`)
      return 2
    }
    if (!exists(runner)) {
      say(`  extraction finished but ${runner} is missing`)
      return 2
    }
    writeFileSync(shim, readFileSync(SHIM_SOURCE))
    materialized = true
    say(`  shim       : ${shim}`)
    say(`  runner     : ${runner}`)
    try {
      writeFileSync(join(target, 'mediator.json'), JSON.stringify({
        preparedAt: new Date().toISOString(),
        installDir: diagnosis.installDir,
        asar: asarRoot,
        nodeExe: diagnosis.nodeExe,
        shim,
        preparedBy: 'prepare-sandbox-mediator.mjs',
      }, null, 2), 'utf8')
    } catch { /* provenance is a convenience, not a requirement */ }
  }

  // 3. wire the profile ONLY when it has no sandbox row at all.
  if (!diagnosis.profileNamesShim && !alreadyHasEntry) {
    const entry = sandboxEntry({ nodeExe: diagnosis.nodeExe, shim })
    if (dryRun) {
      say('  profile    : would append the managed sandbox block')
    } else {
      mkdirSync(dirname(profilePath), { recursive: true })
      const before = readText(profilePath)
      if (before !== undefined) {
        try {
          writeFileSync(`${profilePath}.bak-sandbox-${Date.now()}`, before, 'utf8')
        } catch { /* a backup is best effort; refusing to write over it is not */ }
      }
      writeFileSync(profilePath, appendEntry(before ?? '', entry), 'utf8')
      say(`  profile    : appended the managed sandbox block to ${profilePath}`)
    }
  } else if (diagnosis.profileNamesShim) {
    say('  profile    : already names this shim -- not rewritten')
  }

  if (dryRun) {
    say('')
    say('dry run: nothing was written')
    return 0
  }

  // 3b. PROVE THE PROFILE PARSES, with the loader the ACP child actually uses.
  //
  // The sandbox probe below cannot answer this: it reads the file structurally, so a profile with
  // two YAML documents passes it and fails at ACP startup (PITFALLS F45). `--dump-config` is the
  // real consumer, it exits non-zero on a parse error, and it costs about a second.
  const validation = validateProfile({ installDir: diagnosis.installDir, profile })
  if (!validation.ok) {
    say('')
    say(`the profile does not parse: ${validation.detail}`)
    say('the ACP child would refuse to start; do not arm this machine until this is fixed')
    return 1
  }
  say('  profile    : parses (--dump-config OK)')

  // 4. verify with the same probe the gate uses. Nothing less than that counts.
  say('')
  say('verifying with the arming gate\'s own probe:')
  const probe = deps.probe ?? ((opts) => probeSandbox(opts))
  const result = probe({ profile: profilePath })
  for (const check of result.checks ?? []) {
    say(`  [${check.ok ? 'PASS' : 'FAIL'}] ${check.name}${check.detail === '' ? '' : ` -- ${check.detail}`}`)
  }
  say('')
  if (result.ok === true) {
    say('RESULT: READY -- arm this machine from 设置 → 远程工作节点 → 本机角色')
    return 0
  }
  say(`RESULT: NOT READY -- ${result.reason}`)
  return 1
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(SELF).toLowerCase() === resolve(process.argv[1]).toLowerCase()
if (invokedDirectly) process.exit(main())
