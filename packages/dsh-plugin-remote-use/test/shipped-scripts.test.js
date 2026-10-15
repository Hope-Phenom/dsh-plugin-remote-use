/**
 * Guards on the files that ship to a worker.
 *
 * WHY THIS EXISTS: two bugs in a row were found by READING `selfcheck.ps1`, not by running
 * anything --
 *
 *   * S14 and S15 hardcoded one user's profile directory, so on every other machine they reported
 *     "DSH not installed" and "no credentials" while DSH was running and a task had just completed.
 *     Four blocking failures on a machine that worked.
 *   * S18 hardcoded the reference worker's build output, so it warned "missing" everywhere.
 *
 * Both are the same shape: a machine-specific path baked into a script that runs on a different
 * machine. Neither errored. Neither was caught by 431 unit tests, because the scripts that carry
 * them have no tests at all -- PowerShell running on a worker is not reachable from this suite.
 *
 * So this file does not try to execute them. It asserts the one property that made both bugs
 * invisible: that no shipped script names a specific user's profile directory.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { REMOTE_TOOL_NAMES } from '../lib/index.js'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SLAVE = join(PKG_ROOT, 'slave')
/**
 * The shipped worker-profile snippet, named ONCE.
 *
 * Three places have to agree that this file exists -- `package.json` `files`, the deployment
 * script's `$files`, and the required-file list below -- and the point of those three is to catch
 * each other out. Spelling the name once here keeps a rename from silently leaving one of them
 * asserting a file that no longer exists.
 */
const SNIPPET = 'slave/acp-profile-approval.patch.yml'

function listFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else if (statSync(full).isFile()) out.push(full)
  }
  return out
}

/**
 * `C:\Users\<name>\` where `<name>` is a real user name rather than a placeholder.
 *
 * The placeholders are allowed because documentation and tests legitimately use them; what must
 * not appear is a name that belongs to one particular machine.
 */
const HARDCODED_PROFILE = /[A-Za-z]:\\Users\\(?!<|%|\$|\{|\*)[A-Za-z0-9._-]+\\/gu
const PLACEHOLDER_USERS = new Set(['dev', 'public', 'default'])

test('no shipped script hardcodes a particular user profile path', () => {
  // `dev` is this development machine's user, and it is allowed as a placeholder in comments and
  // fixtures -- but the SLAVE scripts must derive from the environment, because they run on a
  // worker whose user is someone else's. The `sheng` case is the bug this guards.
  const offenders = []
  for (const file of listFiles(SLAVE)) {
    if (!/\.(ps1|mjs|js|json|yml)$/u.test(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(HARDCODED_PROFILE)) {
      const user = match[0].slice('C:\\Users\\'.length, -1).toLowerCase()
      if (PLACEHOLDER_USERS.has(user)) continue
      // A comment that quotes the bug it fixed is not the bug.
      const lineStart = text.lastIndexOf('\n', match.index) + 1
      const line = text.slice(lineStart, text.indexOf('\n', match.index))
      if (/^\s*(#|\/\/|\*)/u.test(line)) continue
      offenders.push(`${file.slice(PKG_ROOT.length + 1)}: ${line.trim().slice(0, 90)}`)
    }
  }
  assert.deepEqual(offenders, [], `a worker script names a specific user's profile:\n${offenders.join('\n')}`)
})

// ---------------------------------------------------------------------------
// PUBLISHING: what a reader of the tarball can see
//
// The guard above deliberately SKIPS comments ("a comment that quotes the bug it fixed is not the
// bug"). That is the right rule for code, and the wrong rule for a published package: a comment
// ships. Every file in `files` is readable by anyone who runs `npm view dsh-plugin-remote-use`, so
// the author's LAN subnet, machine names and usernames are disclosures even though none of them is
// a credential.
//
// This is not a secret scan -- that is a separate, manual step before the first publish. It is a
// guard against re-introducing the specific literals that were genericised, which is the failure
// mode this project keeps finding: the fix is applied and nothing stops it coming back.
// ---------------------------------------------------------------------------

/** Every file the tarball carries, excluding third-party dependencies. */
function shippedTextFiles() {
  const out = []
  const roots = [join(PKG_ROOT, 'lib'), join(PKG_ROOT, 'locale'), join(PKG_ROOT, 'assets')]
  for (const root of roots) if (existsSync(root)) out.push(...listFiles(root))
  out.push(join(PKG_ROOT, 'cordis.patch.yml'), join(PKG_ROOT, 'package.json'), join(PKG_ROOT, 'README.md'))
  for (const name of readdirSync(SLAVE)) {
    // `yml` is here because a shipped worker-profile snippet is prose, and a comment ships: leaving
    // it out of this allow-list would put a whole class of published bytes beyond the disclosure
    // guard below, which would then stay green while the thing it exists to prevent went out.
    if (/\.(mjs|ps1|yml)$/u.test(name)) out.push(join(SLAVE, name))
  }
  return out.filter((f) => existsSync(f) && statSync(f).isFile())
}

test('no shipped file names this author\'s machines, network or users -- comments included', () => {
  // THE PATTERNS ARE BUILT FROM FRAGMENTS, and that is not obfuscation for its own sake: this file
  // is in git, so spelling the literals here would put them back into the repository that the guard
  // exists to keep them out of. A scanner reading this file must not find them either. The fragments
  // are the smallest pieces that no longer name anything.
  const HOST_PARTS = ['aoko', 'chao']            // the author's machine-name prefix
  const USERS = ['dev', 'sheng']                 // the two profile directories that appeared
  const LAN = [192, 168, 3].join('\\.')          // the author's LAN /24, escaped for a regex
  const FORBIDDEN = [
    { pattern: new RegExp(`${LAN}\\.`, 'gu'), what: 'the author\'s LAN subnet' },
    // The generic CIDRs in `net-address.mjs` (`192.168.0.0/16`) must keep passing: the check is for
    // one machine's address, not for private-range arithmetic.
    { pattern: new RegExp(`${HOST_PARTS.join('-')}-(?:sider|sheng)`, 'giu'), what: 'the author\'s machine name' },
    { pattern: new RegExp(`C:\\\\Users\\\\(?:${USERS.join('|')})\\b`, 'gu'), what: 'a developer\'s profile directory' },
  ]
  const offenders = []
  for (const file of shippedTextFiles()) {
    const text = readFileSync(file, 'utf8')
    for (const { pattern, what } of FORBIDDEN) {
      for (const m of text.matchAll(pattern)) {
        const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index)).trim()
        offenders.push(`${file.slice(PKG_ROOT.length + 1)}: ${what} (${m[0]}) -- ${line.slice(0, 70)}`)
      }
    }
  }
  assert.deepEqual(offenders, [],
    `a published file discloses a machine-specific literal:\n${offenders.join('\n')}`)
})

test('the package carries the licence it declares', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.license, 'MIT', 'package.json must declare the licence')
  const inPackage = join(PKG_ROOT, 'LICENSE')
  assert.ok(existsSync(inPackage), 'npm only picks up a LICENSE inside the package directory')
  // Two copies exist because the repository root needs one too, and npm cannot reach outside the
  // package. A drift between them would put one licence on the repository and another in the
  // tarball, so they are compared rather than assumed.
  const rootLicence = join(PKG_ROOT, '..', '..', 'LICENSE')
  if (existsSync(rootLicence)) {
    assert.equal(readFileSync(inPackage, 'utf8'), readFileSync(rootLicence, 'utf8'),
      'the package LICENSE and the repository LICENSE have drifted apart')
  }
})

test('the package is publishable and carries a README for its npm page', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  assert.notEqual(pkg.private, true, '`private: true` silently blocks npm publish')
  assert.ok(typeof pkg.homepage === 'string' && pkg.homepage.startsWith('http'), 'npm shows homepage')
  assert.ok(pkg.bugs && typeof pkg.bugs.url === 'string', 'npm shows a bugs link')
  // npm renders the README FROM THE PACKAGE DIRECTORY: the repository README is outside it, so
  // without this file the package page says "no README" no matter how good the root one is.
  const readme = join(PKG_ROOT, 'README.md')
  assert.ok(existsSync(readme), 'the package needs its own README for its npm page')
  assert.ok(readFileSync(readme, 'utf8').length > 400, 'a placeholder README is worse than none')
})

test('both package READMEs document every tool the plugin ships', () => {
  // WHY THIS EXISTS: the npm-facing READMEs listed the four OBSERVATION tools and not
  // `remote_subagent` -- the delegation entry point, i.e. the one tool the page exists to
  // advertise. Every test passed, because nothing compared the README against the tool set, and
  // the omission was invisible to anyone who already knew how the plugin works. It is the same
  // shape as PITFALLS D11: a document that hardcodes a list nothing checks.
  //
  // Compared against `REMOTE_TOOL_NAMES`, so adding a tool fails this until the docs name it.
  const names = [...REMOTE_TOOL_NAMES]
  assert.ok(names.length > 0, 'REMOTE_TOOL_NAMES must not be empty, or this guard proves nothing')
  for (const file of ['README.md', 'README.zh.md']) {
    const text = readFileSync(join(PKG_ROOT, file), 'utf8')
    const missing = names.filter((name) => !text.includes(name))
    assert.deepEqual(missing, [], `${file} does not mention: ${missing.join(', ')}`)
  }
})

test('the worker self-check derives its install and credential paths from the environment', () => {  // Named explicitly rather than left to the scan above, so the intent survives a refactor of the
  // regex. These are the two checks that produced false blocking failures.
  const script = readFileSync(join(SLAVE, 'selfcheck.ps1'), 'utf8')
  assert.match(script, /Join-Path \$env:LOCALAPPDATA/u, 'S14 must use the current account install')
  assert.match(script, /Join-Path \$env:USERPROFILE/u, 'S15 must use the current account profile')
  // And the report must say WHERE it looked, so "signed out" is distinguishable from "looked in
  // the wrong place" -- the distinction that made the original failure hard to read.
  assert.match(script, /candidate locations|locations, including/u, 'S14/S15 must report how many places were tried')
})

test('the self-check works under a SYSTEM scheduled task, not only interactively', () => {
  // THE REGRESSION THIS GUARDS. Deriving the paths from `$env:LOCALAPPDATA` is correct for an
  // interactive run and WRONG for this script's other mode: a boot check under a SYSTEM scheduled
  // task, where `$env:LOCALAPPDATA` points at C:\Windows\system32\config\systemprofile. The first
  // fix did exactly that -- replacing a check that was right on one machine with one that was
  // wrong on all of them in that mode.
  //
  // Verified by running the script with those variables pointed at the systemprofile and watching
  // S14/S15 stay green. Here the mechanism is asserted, so a future simplification fails loudly.
  const script = readFileSync(join(SLAVE, 'selfcheck.ps1'), 'utf8')
  assert.match(script, /Get-Process -Name 'DeepSeek Harness'/u,
    'S14 must take the location from a RUNNING DSH, whatever account the script runs as')
  assert.match(script, /Get-ChildItem \$root -Directory/u,
    'S14/S15 must also scan every user profile, which is what a SYSTEM run cannot see about itself')
  assert.match(script, /SystemDrive/u, 'the profile scan must be rooted on the system drive, not a literal')
})

test('the target-app check is configurable and says which state it is in', () => {
  // Unconfigured is not the same as missing, and a check that warns on every machine teaches the
  // operator to stop reading the warnings.
  const script = readFileSync(join(SLAVE, 'selfcheck.ps1'), 'utf8')
  assert.match(script, /DSH_SELFCHECK_APP/u, 'S18 must be configurable from the environment')
  assert.match(script, /\[string\]\$App = ''/u, 'S18 must be configurable by parameter')
  assert.match(script, /not configured/u, 'unconfigured must be reported as such')
  assert.match(script, /missing at: /u, 'a configured-but-absent app must name the path')
})

test('the published tarball does not carry this machine\'s generated artifacts', () => {
  // RUNS THE REAL PACKER rather than inspecting `files`. The first two attempts at this were both
  // wrong in a way inspection would not have caught:
  //
  //   * `.gitignore` does not govern `npm pack` for a directory listed in `files`.
  //   * `.npmignore` does not either -- npm's documented rule is that entries included by `files`
  //     CANNOT be excluded by either file.
  //
  // So `slave/selfcheck.json` -- a report naming the machine that produced it, its displays, GPU
  // and session id -- shipped in the tarball until `files` was changed to enumerate `slave/*.mjs`
  // and `slave/*.ps1` instead of the whole directory. Only the packer can say whether that holds.
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PKG_ROOT, encoding: 'utf8', timeout: 120_000, shell: true,
  })
  assert.equal(packed.status, 0, `npm pack failed: ${String(packed.stderr).slice(0, 300)}`)
  let report
  try {
    report = JSON.parse(String(packed.stdout))
  } catch {
    assert.fail(`npm pack --json produced no parseable output: ${String(packed.stdout).slice(0, 200)}`)
  }
  const paths = (report?.[0]?.files ?? []).map((f) => f.path)

  assert.ok(paths.length > 0, 'the packer reported no files at all')
  // The pieces a worker actually needs must be there -- otherwise this test would "pass" by
  // shipping nothing. The profile snippet is on this list because it is the file that keeps a
  // session-mode grant from making the worker unreachable (F34), and `files` enumerates by
  // extension: a new extension silently ships nothing, and only this list notices.
  for (const required of [
    'slave/relay.mjs', 'slave/selfcheck.ps1', 'slave/screenshot.ps1',
    SNIPPET, 'lib/index.js', 'lib/client.js',
  ]) {
    assert.ok(paths.includes(required), `${required} is missing from the tarball`)
  }
  // ...and nothing that is about THIS machine may be.
  const forbidden = paths.filter((p) => /selfcheck\.(json|txt)$|screenshot-report\.txt$|pairing\.txt$|slave\/shots\//u.test(p))
  assert.deepEqual(forbidden, [], `the tarball carries generated artifacts: ${forbidden.join(', ')}`)
})

test('files enumerates the slave scripts instead of whitelisting the whole directory', () => {
  // The mechanism behind the test above, asserted directly so a future edit that reverts to
  // `"slave"` fails here with a clear reason instead of only in the packer.
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  const files = pkg.files ?? []
  assert.equal(files.includes('slave'), false,
    'a bare "slave" entry whitelists everything under it, and npm cannot then exclude the generated reports')
  assert.ok(files.some((f) => f.startsWith('slave/')), 'the slave scripts must still ship')
})

test('the PACKED tarball can actually run the worker relay', () => {
  // THE STRONGEST FORM OF THE PACKAGING CHECK, and what the two earlier attempts were
  // substituting for: pack it, extract it, and RUN the relay out of the extraction.
  //
  // Listing what `files` ought to contain is an approximation -- and it was wrong twice. The relay
  // imports `ws` from `slave/node_modules`, and `files` now enumerates `slave/*.mjs`,
  // `slave/*.ps1` and `slave/node_modules` separately: drop the third and a published plugin
  // installs cleanly and then cannot start its own listener. Only running it from the packed copy
  // catches that.
  const dir = mkdtempSync(join(tmpdir(), 'remote-use-pack-'))
  try {
    const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', dir], {
      cwd: PKG_ROOT, encoding: 'utf8', timeout: 120_000, shell: true,
    })
    assert.equal(packed.status, 0, `npm pack failed: ${String(packed.stderr).slice(0, 300)}`)
    const filename = JSON.parse(String(packed.stdout))?.[0]?.filename
    assert.equal(typeof filename, 'string', 'the packer did not report a filename')

    const extract = spawnSync('tar', ['-xzf', join(dir, filename), '-C', dir], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(extract.status, 0, `extracting the tarball failed: ${String(extract.stderr).slice(0, 200)}`)

    const relay = join(dir, 'package', 'slave', 'relay.mjs')
    assert.equal(existsSync(relay), true, 'the relay is missing from the packed tarball')

    // `--print-pairing` exits immediately, and that is enough: it exercises the relay's module
    // graph (including `ws`), its argument parsing and its pairing encoder.
    const run = spawnSync(process.execPath, [relay, '--port', '7395', '--token', 'packed-probe-token', '--print-pairing'], {
      encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(run.status, 0, `the packed relay failed to run: ${String(run.stderr).slice(0, 300)}`)
    assert.match(String(run.stdout), /^dshpair1\./u, 'the packed relay could not produce a pairing string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the worker profile snippet keeps the preset pairing coherent, and reaches the worker', () => {
  // PITFALLS F34: `dsh-base` pairs the full-access sandbox with approval `never`, and the
  // `permission` row's preset table has no entry for (danger-full-access, ask) while its
  // `defaultPreset` is unset. A profile patch that hard-codes `policy: ask` therefore composes a
  // combination that matches NO preset -- which can stop that service loading, so the ACP process
  // never comes up and the worker is simply gone. The snippet's whole job is not to do that.
  //
  // Read the BODY, not the file: the snippet's comments quote the `policy: ask` form it replaces, so
  // the raw text matches whatever the real entry happens to say -- the same mistake the sibling
  // guard records for `cordis.patch.yml`.
  const body = patchBody(join(SLAVE, 'acp-profile-approval.patch.yml'))

  // ONE assertion over the real entry, and deliberately not three. It has to MIRROR dsh-base's
  // expression rather than pin a value, and this regex rejects the broken forms too (`policy: ask`,
  // a pinned `never`); a second assertion after a failing first never runs, so splitting it would
  // buy nothing while making the failure message depend on assertion order.
  assert.match(body,
    /^[ \t]*policy:[ \t]*!!js[^\n]*DSH_PERMISSION_MODE[^\n]*danger-full-access[^\n]*'never'[^\n]*'ask'/mu,
    'the approval policy must be derived from the same variable the mode is, reproducing dsh-base\'s pairing')

  // ...and the expression must be QUOTED, which is a different property from having the right tokens.
  //
  // MEASURED 2026-10-15: the unquoted form shipped, and it is not valid YAML -- the ternary contains
  // ": " before 'ask', so YAML parsed it as a MAPPING and Cordis rejected it with
  // `$.policy expected "ask" | "never" but got {"[object Object]":"ask"}`. The assertion above passed
  // the whole time, because checking a token sequence says nothing about whether YAML will accept it.
  // So this checks the quoting, and the comment above records why it is not cosmetic.
  const js = /^[ \t]*policy:[ \t]*!!js[ \t]+(.+)$/mu.exec(body)
  assert.ok(js !== null, 'the approval entry has no !!js policy line')
  const scalar = js[1].trim()
  assert.ok((scalar.startsWith('"') && scalar.endsWith('"')) || (scalar.startsWith("'") && scalar.endsWith("'")),
    `the !!js expression must be quoted or YAML reads its ": " as a mapping -- got: ${scalar}`)
  assert.equal(scalar.includes('": "') || scalar.includes("': '"), false, 'a bare ": " before a quote would still split the scalar')

  // And it has to reach the worker. That it SHIPS is proved against the real tarball by the packer
  // test above; what no other test covers is the deployment script, which copies by explicit name.
  const deploy = readFileSync(join(PKG_ROOT, '..', '..', 'tools', 'deploy-slave.ps1'), 'utf8')
  assert.ok(deploy.includes(SNIPPET.split('/')[1]),
    'the deployment script copies by explicit name, so the snippet must be listed in its $files')
})

test('the deployment script copies everything the relay imports, and proves it runs', () => {
  // THE DEPLOYMENT IS THE ONE THING THAT CANNOT BE TESTED FROM HERE -- the worker is another
  // machine. So the check is on the script: it must derive its file list from what the relay
  // ACTUALLY imports, rather than from a list someone maintained by hand.
  //
  // It was maintained by hand, and it was wrong: DESIGN section 19 listed every script and no
  // `node_modules`, so a deployment would have produced a worker whose relay died with
  // `Cannot find package 'ws'` -- after every file was present and every file parsed. The script's
  // own rehearsal caught it only because its last step RUNS the copied relay.
  const script = readFileSync(join(PKG_ROOT, '..', '..', 'tools', 'deploy-slave.ps1'), 'utf8')
  const relay = readFileSync(join(SLAVE, 'relay.mjs'), 'utf8')

  // Every BARE import (not `node:` and not relative) has to be provided by the deployment.
  const bare = [...relay.matchAll(/^import .* from '([^'.][^']*)'/gmu)]
    .map((m) => m[1])
    .filter((spec) => !spec.startsWith('node:'))
  assert.deepEqual(bare, ['ws'], `the relay's bare imports changed: ${bare.join(', ')}; update the deployment`)
  for (const pkg of bare) {
    assert.match(script, new RegExp(`node_modules`, 'u'), 'the deployment must carry node_modules')
    assert.ok(script.includes(`'ws'`) || script.includes('ws\\package.json'),
      `the deployment does not verify that ${pkg} is present`)
  }

  // Every RELATIVE import has to be copied too -- the other half of the same failure.
  //
  // Over EVERY deployed script, not just the relay: `make-launch-spec.mjs` now imports a sibling
  // (`permission-pairing.mjs`), and a check that only read the relay would have let that module fail
  // to deploy -- producing a worker where the spec generator dies with ERR_MODULE_NOT_FOUND at the
  // exact moment someone is trying to set the worker up.
  const scripts = readdirSync(SLAVE).filter((name) => name.endsWith('.mjs'))
  assert.ok(scripts.length >= 5, `expected the deployed mjs scripts, got ${scripts.join(', ')}`)
  const relative = []
  for (const name of scripts) {
    const text = readFileSync(join(SLAVE, name), 'utf8')
    for (const match of text.matchAll(/^import .* from '\.\/([^']+)'/gmu)) relative.push(`${name}->${match[1]}`)
  }
  assert.ok(relative.some((r) => r.startsWith('relay.mjs->')), 'the relay still has its relative imports')
  for (const pair of relative) {
    const dep = pair.slice(pair.indexOf('->') + 2)
    assert.ok(script.includes(`'${dep}'`), `${pair}: imported by a deployed script but not copied by the deployment`)
  }

  // And it must not declare success without running the result. A parse check passes on a module
  // graph that cannot load.
  assert.match(script, /--print-pairing/u, 'the deployment must RUN the copied relay, not just parse it')
  assert.match(script, /ERR_MODULE_NOT_FOUND|dshpair1/u, 'the run check must assert the relay produced a pairing string')
})

// ---------------------------------------------------------------------------
// S4: what it blocks, and what it must NOT block
//
// This one has been wrong in BOTH directions, so the guard pins the reasoning rather than a slogan.
//
//   * Originally it checked only the origin, while DESIGN worded it as "the virtual screen is
//     primary AND at (0,0)". That looked like a missing half and was "fixed" -- and the fix made a
//     real deployment unusable, because Windows 11 draws the LOGON UI on the PRIMARY display only:
//     with the virtual display primary, the login screen renders on a display with no physical
//     output and the operator's monitor stays black.
//   * So the origin is what blocks (an offset origin silently shifts every coordinate), and whether
//     the primary is the virtual display is REPORTED, not enforced.
//
// A guard cannot encode "this is the right trade-off", but it can stop the enforced half from
// creeping back in without someone deliberately changing this comment too.
// ---------------------------------------------------------------------------

test('the display check blocks on the origin, and merely reports whether the primary is virtual', () => {
  const text = readFileSync(join(SLAVE, 'selfcheck.ps1'), 'utf8')
  const from = text.indexOf('# S4')
  const s4 = text.slice(from, text.indexOf('# S5'))
  assert.ok(from >= 0 && s4.length > 0, 'S4 is missing from the self-check')
  // Blocks on the origin...
  assert.match(s4, /Bounds\.X -eq 0/u, 'S4 must require the origin')
  // ...and reports the virtual-ness without gating on it.
  assert.match(s4, /primaryIsVirtual/u, 'S4 must report whether the primary is the virtual display')
  assert.equal(/\$okOrigin -and \$primaryIsVirtual/u.test(s4), false,
    'S4 must NOT block on the primary being virtual: that puts the login screen on a display nobody can see')
  const call = text.slice(text.indexOf("Add-Check 'S4'"))
  assert.match(call.slice(0, 220), /\$okOrigin\)/u, 'the S4 verdict must be decided by the origin alone')
})

// ---------------------------------------------------------------------------
// The bundled patch: `name` is a MODULE SPECIFIER, `id` is a row identity
//
// Renaming the package to `@hope_phenom/dsh-plugin-remote-use` silently broke the plugin on a real
// worker. The plugin manager still listed it -- it reads package.json -- and the toggle still moved,
// but the Settings section never appeared. The cause was one line:
//
//     - insert:
//         - id: dsh-plugin-remote-use
//           name: dsh-plugin-remote-use        <-- the loader imports THIS
//
// The two fields held the same string while the package was unscoped, so nothing forced anyone to
// notice that only one of them is the module name. The loader tried to import the old bare name,
// found nothing under it, and the server half never loaded.
//
// The two guards below pull in OPPOSITE directions on purpose: `name` must follow the package name,
// and `id` must not -- it is the row identity that profiles already point at, so "fixing" it to match
// would break every installed profile instead.
// ---------------------------------------------------------------------------

/**
 * A loader patch file with its comments removed.
 *
 * The comments deliberately quote the broken forms (the comment about the disproved per-worker tool
 * row names `dsh-tool-subagent`; the worker profile snippet quotes the `policy: ask` it replaces),
 * so scanning the raw text finds those instead of the real entries. The first version of these
 * guards did exactly that and failed for the wrong reason.
 *
 * Takes the file so every patch-shaped artifact can use it: a second copy of this filter is how one
 * of them ends up scanning the wrong thing.
 */
function patchBody(file = join(PKG_ROOT, 'cordis.patch.yml')) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n')
}

test('the bundled patch imports this package by its real name, scope included', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  const body = patchBody()
  const names = [...body.matchAll(/^[ \t]*(?:-[ \t]+)?name:[ \t]*'?([^'\s]+)'?[ \t]*$/gmu)].map((m) => m[1])
  assert.ok(names.length > 0, 'the bundled patch has no `name:` at all')
  assert.ok(names.includes(pkg.name),
    `the patch must import "${pkg.name}" but imports ${JSON.stringify(names)} -- a bare name that is not in node_modules cannot resolve, so the plugin never loads`)
})

test('the bundled patch row id stays stable, because profiles point at it', () => {
  const body = patchBody()
  const insertAt = body.indexOf('- insert:')
  assert.ok(insertAt >= 0, 'the bundled patch has no insert entry')
  const id = /^[ \t]*(?:-[ \t]+)?id:[ \t]*'?([^'\s]+)'?[ \t]*$/mu.exec(body.slice(insertAt))?.[1]
  assert.equal(id, 'dsh-plugin-remote-use',
    'the row id is what existing profile patches override; changing it silently un-configures every installed master')
})

test('an unanswered remote check is reported as unverified, never as a failed one', () => {
  // `ssh` reserves exit 255 for its OWN failures. Treating that as the remote command's answer is
  // how a transient name-resolution blip reported every file as missing while all of them were
  // present and the relay was running out of that directory.
  const text = readFileSync('../../tools/deploy-slave.ps1', 'utf8')
  assert.match(text, /-ne 255/u, 'the deploy script must tell ssh failures apart from remote answers')
  assert.match(text, /'unknown'/u, 'a check that could not be asked must be its own outcome')
  assert.match(text, /\[SKIP\]/u, 'and must print as SKIP rather than FAIL')
  assert.match(text, /exit 3/u, 'and must end with its own exit code, distinct from success and failure')
})

// ---------------------------------------------------------------------------
// Every hard peer dependency of a runtime dependency must be declared here
//
// The plugin failed to load on a real worker with:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod'
//     imported from ...\@agentclientprotocol\sdk\dist\schema-deserialize.js
//
// The SDK lists `zod` under peerDependencies. A peer dependency is the CONSUMER's obligation, and
// this package never declared it -- so it was never installed. The reason development never noticed
// is the whole point of this guard:
//
//   * npm 7+ INSTALLS peer dependencies automatically, so `zod` appeared in node_modules by accident
//     and everything worked.
//   * pnpm does NOT. Its layout is strict, so the import failed on the worker.
//
// "Works on my machine" was literally that: a package manager difference. Optional peers are
// excluded (`peerDependenciesMeta`), which is what keeps `ws`'s optional `bufferutil` and
// `utf-8-validate` from being demanded here.
// ---------------------------------------------------------------------------

test('every non-optional peer dependency of our runtime dependencies is declared', () => {
  const mine = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  const declared = new Set([...Object.keys(mine.dependencies ?? {}), ...Object.keys(mine.peerDependencies ?? {})])
  const problems = []
  let inspected = 0
  for (const dep of Object.keys(mine.dependencies ?? {})) {
    const manifest = join(PKG_ROOT, 'node_modules', dep, 'package.json')
    if (!existsSync(manifest)) {
      problems.push(`${dep} is declared but not installed -- run npm install before the tests`)
      continue
    }
    inspected += 1
    const j = JSON.parse(readFileSync(manifest, 'utf8'))
    const meta = j.peerDependenciesMeta ?? {}
    for (const peer of Object.keys(j.peerDependencies ?? {})) {
      if (meta[peer]?.optional === true) continue
      if (!declared.has(peer)) problems.push(`${dep} requires peer "${peer}", which this package does not declare`)
    }
  }
  assert.ok(inspected > 0, 'no dependency manifests could be read; the check would be vacuous')
  assert.deepEqual(problems, [],
    `an undeclared peer will be installed by npm and NOT by pnpm, so this only breaks for users:\n${problems.join('\n')}`)
})

test('param() is the first statement in the scripts that take parameters', () => {  // PowerShell rejects `param()` after any executable statement, and PS 5.1 reports it as a
  // confusing "invalid assignment operator" at the lines that FOLLOW. The deploy gate catches it
  // too, but only when someone runs the gate.
  for (const name of ['selfcheck.ps1']) {
    const text = readFileSync(join(SLAVE, name), 'utf8')
    const paramAt = text.indexOf('param(')
    if (paramAt < 0) continue
    const before = text.slice(0, paramAt)
    for (const [index, line] of before.split('\n').entries()) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      assert.fail(`${name}: param() must precede every statement; line ${index + 1} is "${trimmed.slice(0, 60)}"`)
    }
  }
})
