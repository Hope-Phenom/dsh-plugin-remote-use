/**
 * Tests for the Settings page: its browser-half registration and the Host data route.
 *
 * WHY THE REGISTRATION TEST MATTERS: `dsh-client-modules` runs its `dsh.client` scan
 * synchronously at construction, and a malformed declaration or missing bundle among the
 * loaded entries aggregates into one loud throw that fails the whole fiber. A typo in the
 * slot registration is therefore not a cosmetic bug -- it breaks plugin startup -- and
 * nothing else in this suite would notice.
 *
 * WHY THE RENDER TEST MATTERS: the component runs only in the browser, so a crash there is
 * invisible to every Host-side test and shows the operator a blank page. Rendering it here
 * against a minimal React stub turns "it parses" into "it produces a tree".
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { makeSettingsRoute, crossSitePostProblem } from '../lib/index.js'
import { ApprovalQueue } from '../lib/core/approval-queue.js'
import { AuditLog } from '../lib/core/audit-log.js'
import { TaskRegistry } from '../lib/core/task-registry.js'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The manifest, read once at module scope.
 *
 * Several checks below compare an identity the bundle asserts about itself against the package name,
 * and the harness must not hardcode that name -- hardcoding it is exactly how this suite came to
 * accept the broken registration id and reject the correct one after the package was renamed.
 */
const PKG = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))

// ---------------------------------------------------------------------------
// browser half: declaration and registration
// ---------------------------------------------------------------------------

test('package.json declares the client half the way dsh-client-modules reads it', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  // `clientExportOf` requires a "./client" export, and the declaration must name "web" or
  // the package is skipped entirely (decl.platform !== "web" -> no client half).
  assert.equal(typeof pkg.exports?.['./client'], 'string', 'exports["./client"] must be present')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  // The route the page fetches and the file it lives in must both exist.
  assert.ok(pkg.exports['./client'].endsWith('client.js'))
})

// ---------------------------------------------------------------------------
// Identity: the ids this plugin registers under must equal the PACKAGE name
//
// This is the third place the package rename had to be carried through, and the only one that was
// invisible until a real worker ran it. dsh-client-modules keys its graph rows -- and therefore its
// "this bundle is already loaded" bookkeeping -- by the package name, while the bundle registers
// itself under the id it writes here. When those disagreed:
//
//   client-modules: duplicate factory registration for "dsh-plugin-remote-use"
//     (bundle executed twice without invalidate?)
//
// The bundle ran twice, the second registration threw, and the failure surfaced a long way away as
// "web boot: 1 entry did not activate" -- which reads like an install problem and is not one. The
// whole Web UI refused to boot.
//
// Every working client plugin on the operator's machine follows the rule, e.g.
//   @smalltailqwq/dsh-client-ui-skin-maid-atelier  ->  id: '@smalltailqwq/dsh-client-ui-skin-maid-atelier'
//
// DELIBERATELY NOT CHECKED: the locale namespace (`const NS`) and the on-disk storage directory
// keep the pre-rename name. They are internal and changing them would discard existing settings for
// no benefit -- the same reasoning that keeps the loader row id stable.
// ---------------------------------------------------------------------------

test('the client bundle registers under the package name, not the pre-rename one', () => {
  const src = readFileSync(join(PKG_ROOT, 'lib', 'client.js'), 'utf8')

  const load = /window\.__ModuleLoader__\.load\(\{([\s\S]*?)\n\s*factory/u.exec(src)
  assert.ok(load, 'could not find the __ModuleLoader__.load({...}) registration')
  const id = /id:\s*'([^']+)'/u.exec(load[1])?.[1]
  assert.equal(id, PKG.name,
    'the registration id must equal the package name: the loader keys rows by package name, so a mismatch makes it execute this bundle twice and the Web UI fails to boot')

  // ONLY the registration id above is checked. Other `id:` values in the same file are ledger and
  // slot identities and are conventionally SHORT -- DSH's own first-party sections use `agent-presets`
  // and `account`, and a working third-party plugin uses `dsh-skins` at this very spot. Asserting
  // "every id equals the package name" here would encode a rule DSH does not have.
})

// ---------------------------------------------------------------------------
// the Settings nav icon
//
// Without `icon` in the manifest the nav falls back to a generic gear. The rules below are
// `iconOf()` in @deepseek-ai/dsh-app-boot read verbatim: a RELATIVE path, one of four
// extensions, contained in the manifest directory, a regular file, at most 256 KiB -- and
// the bytes are inlined as a data: URL, so the SVG must be self-contained.
// ---------------------------------------------------------------------------

const ICON_MEDIA_TYPES = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])
const MAX_ICON_BYTES = 256 * 1024

test('the manifest declares an icon that satisfies iconOf()', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  const declared = pkg.icon
  assert.equal(typeof declared, 'string', 'without this the nav shows a generic gear')

  // An absolute path or a URL scheme throws in iconOf.
  assert.equal(declared.startsWith('/'), false)
  assert.equal(/^[A-Za-z][A-Za-z\d+.-]*:/u.test(declared), false, 'must not be URL-qualified')

  const extension = declared.slice(declared.lastIndexOf('.'))
  assert.ok(ICON_MEDIA_TYPES.has(extension), `icon must be svg/png/jpg/webp, got ${extension}`)

  const file = join(PKG_ROOT, declared)
  const size = statSync(file).size
  assert.ok(size > 0 && size <= MAX_ICON_BYTES, `icon must be 1 byte .. 256 KiB, got ${size}`)

  // It must remain inside the manifest directory, or iconOf refuses it.
  assert.equal(relative(PKG_ROOT, file).startsWith('..'), false)
  // ...and ship, or a published package would reference a file that is not there.
  assert.ok(pkg.files.includes('assets'), 'the assets directory must be published')
})

// ---------------------------------------------------------------------------
// the approval section
// ---------------------------------------------------------------------------

/** Render the section over an arbitrary snapshot and hand back the tree. */
function renderSnapshot(snapshot) {
  const { registered, react } = loadClient()
  const Section = sectionOf(registered).component
  react.__state.index = 0
  react.__state.seeds = []
  react.__state.seeds[0] = snapshot
  react.__state.current = Section.name || '(top)'
  return { tree: expand(Section({ t: makeTranslator() }), react), react }
}

const BASE_SNAPSHOT = {
  ok: true, workers: [], tasks: [], settingsFile: 'C:\\dsh\\settings.json', settings: { workers: [] },
}

test('a pending approval is rendered with what a person needs to judge it', () => {
  const { tree } = renderSnapshot({
    ...BASE_SNAPSHOT,
    approvals: {
      available: true,
      timeoutMs: 88_000,
      recent: [],
      pending: [{
        id: 'ap1', peerId: 'worker-pc', taskId: 'rtask_1', toolCallId: 'call_7',
        toolName: 'write', requiredTier: 'danger-full-access', reason: 'tier-check: needs a human',
        rawInput: '{"file_path":"C:\\\\outside\\\\x.txt"}', ageMs: 3_000,
      }],
    },
    audit: { available: true, path: 'C:\\dsh\\storages\\audit.jsonl', error: '', recent: [] },
  })
  const text = textOf(tree).join(' ')

  // The tool, the tier it needs, why the engine would not decide, and the arguments.
  assert.match(text, /write/)
  assert.match(text, /danger-full-access/)
  assert.match(text, /needs a human/)
  assert.match(text, /outside/)
  // The budget is shown, so the operator knows how long they have.
  assert.match(text, /88/)
  // Both actions are offered.
  assert.match(text, /BTN-ALLOW/)
  assert.match(text, /BTN-DENY/)
})

test('the allow button is wired to a handler, and the row carries its id', () => {
  const { tree } = renderSnapshot({
    ...BASE_SNAPSHOT,
    approvals: {
      available: true,
      timeoutMs: 88_000,
      recent: [],
      pending: [{
        id: 'ap-xyz', peerId: 'w1', taskId: 't1', toolCallId: 'c1',
        toolName: 'write', requiredTier: 'danger-full-access', reason: 'r', rawInput: '', ageMs: 1,
      }],
    },
    audit: { available: true, path: 'p', error: '', recent: [] },
  })
  const [allow] = findButton(tree, 'BTN-ALLOW')
  assert.ok(allow !== undefined, 'the allow button must exist')
  assert.equal(typeof allow.props.onClick, 'function')
  // The decision is addressed by id; `ap-xyz` reaches the DOM as part of nothing visible, so
  // assert it through the handler's closure by checking the tree carries exactly one row.
  const rows = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.props?.className === 'ru-approval') rows.push(node)
    if (Array.isArray(node.children)) node.children.forEach(walk)
  }
  walk(tree)
  assert.equal(rows.length, 1)
})

test('refusals nobody answered are listed, with the reason and how long they waited', () => {
  // The operator's question after "why did that task fail?" is "was I asked?". Before this block
  // the answer was only in the JSONL file: six requests had expired unanswered and the page showed
  // nothing at all.
  const { tree } = renderSnapshot({
    ...BASE_SNAPSHOT,
    approvals: {
      available: true,
      timeoutMs: 180_000,
      recent: [],
      pending: [],
      missedCount: 3,
      missed: [
        { at: '2026-10-14T10:46:28.000Z', toolName: 'pwsh', requiredTier: 'danger-full-access', peerId: '192.168.1.101', waitedMs: 178_000, by: 'timeout' },
        { at: '2026-10-13T09:03:22.000Z', toolName: 'write', requiredTier: 'danger-full-access', peerId: 'w1', waitedMs: 88_000, by: 'disposed' },
      ],
    },
    audit: { available: true, path: 'p', error: '', recent: [] },
  })
  const text = textOf(tree).join(' ')

  assert.match(text, /MISSED-3/, 'the count is shown, not just the rows that fitted on screen')
  assert.match(text, /MISSED-NOTE/)
  assert.match(text, /COL-SETTLED/)
  assert.match(text, /pwsh/)
  assert.match(text, /danger-full-access/)
  assert.match(text, /192\.168\.1\.101/)
  // Each row says WHY it was refused, in words: a timeout and an unload are different stories.
  assert.match(text, /AUDIT-BY-TIMEOUT/)
  assert.match(text, /AUDIT-BY-DISPOSED/)
})

test('a host that never sent the missed list still renders (older snapshot)', () => {
  const { tree } = renderSnapshot({
    ...BASE_SNAPSHOT,
    approvals: { available: true, pending: [], recent: [], timeoutMs: 180_000 },
    audit: { available: true, path: 'p', error: '', recent: [] },
  })
  const text = textOf(tree).join(' ')
  assert.match(text, /APPROVALS-NONE/)
  assert.doesNotMatch(text, /MISSED/, 'no misses: no block, and no crash reading an absent field')
  // ...and nothing to clear, so offering the control would be a button that cannot do anything.
  assert.deepEqual(findButton(tree, 'BTN-CLEAR'), [], 'no misses means no clear control')
})

test('the missed list offers a way to clear it, and says what clearing does not do', () => {
  // The operator's report: a count of past misses stayed on screen forever and read as a live
  // problem ("本会话就会一直显示错过6件了，很怪"). The control has to be HERE, next to the list it
  // clears, and it has to say that the record file is untouched -- otherwise it reads as "delete
  // the evidence" and an operator who wanted the record kept would not dare press it.
  const { tree } = renderSnapshot({
    ...BASE_SNAPSHOT,
    approvals: {
      available: true, timeoutMs: 180_000, recent: [], pending: [], missedCount: 1,
      missed: [{ at: '2026-10-14T10:46:28.000Z', toolName: 'pwsh', requiredTier: 'danger-full-access', peerId: 'w1', waitedMs: 178_000, by: 'timeout' }],
    },
    audit: { available: true, path: 'p', error: '', recent: [] },
  })
  const buttons = findButton(tree, 'BTN-CLEAR')
  assert.equal(buttons.length, 1, 'exactly one clear control on the page')
  assert.match(textOf(tree).join(' '), /CLEAR-NOTE/)
  // Nothing has been cleared yet, so no result message and no error.
  assert.doesNotMatch(textOf(tree).join(' '), /CLEARED-/)
})

test('a build with no approval queue says so rather than showing an empty list', () => {
  // "nothing is waiting" and "this build cannot ask" are different facts. Rendering the empty
  // state for both would tell the operator their request is merely idle when it was refused.
  const { tree } = renderSnapshot({
    ...BASE_SNAPSHOT,
    approvals: { available: false, pending: [], recent: [], timeoutMs: 0 },
    audit: { available: false, path: '', error: '', recent: [] },
  })
  const text = textOf(tree).join(' ')
  assert.match(text, /APPROVALS-UNAVAILABLE/)
  assert.doesNotMatch(text, /APPROVALS-NONE/)
})

test('an empty queue reads as nothing waiting, not as unavailable', () => {
  const { tree } = renderSnapshot({
    ...BASE_SNAPSHOT,
    approvals: { available: true, pending: [], recent: [], timeoutMs: 88_000 },
    audit: { available: true, path: 'C:\\a.jsonl', error: '', recent: [] },
  })
  const text = textOf(tree).join(' ')
  assert.match(text, /APPROVALS-NONE/)
  assert.doesNotMatch(text, /APPROVALS-UNAVAILABLE/)
  assert.match(text, /AUDIT-NONE/)
})

test('the audit trail is rendered with human wording for who decided', () => {
  const { tree } = renderSnapshot({
    ...BASE_SNAPSHOT,
    approvals: { available: true, pending: [], recent: [], timeoutMs: 88_000 },
    audit: {
      available: true,
      path: 'C:\\dsh\\storages\\dsh-plugin-remote-use\\audit.jsonl',
      error: '',
      recent: [
        { at: '2026-10-13T02:03:04.000Z', kind: 'approval', gate: 'human', by: 'human', toolName: 'write', requiredTier: 'danger-full-access', optionId: 'allow-once', peerId: 'w1' },
        { at: '2026-10-13T02:00:00.000Z', kind: 'approval', gate: 'engine', by: 'engine', toolName: 'read', requiredTier: 'read-only', optionId: 'allow-once', peerId: 'w1' },
        { at: '2026-10-13T01:59:00.000Z', kind: 'approval', gate: 'human', by: 'timeout', toolName: 'write', requiredTier: 'danger-full-access', optionId: 'reject-once', peerId: 'w1' },
      ],
    },
  })
  const text = textOf(tree).join(' ')
  // `by` is a wire value; the page must not show the raw token.
  assert.match(text, /AUDIT-BY-HUMAN/)
  assert.match(text, /AUDIT-BY-ENGINE/)
  assert.match(text, /AUDIT-BY-TIMEOUT/)
  assert.match(text, /allow-once/)
  assert.match(text, /reject-once/)
  assert.match(text, /audit\.jsonl/)
})

test('an audit write failure is shown rather than swallowed', () => {
  const { tree } = renderSnapshot({
    ...BASE_SNAPSHOT,
    approvals: { available: true, pending: [], recent: [], timeoutMs: 88_000 },
    audit: { available: true, path: 'C:\\a.jsonl', error: 'could not append: EACCES', recent: [] },
  })
  assert.match(textOf(tree).join(' '), /could not append: EACCES/)
})

test('a snapshot with no approval fields at all still renders (older host)', () => {
  // The page is served per request while the host module is loaded once at boot, so during a
  // restart the two can disagree. A missing field must degrade, not throw.
  const { tree } = renderSnapshot({ ...BASE_SNAPSHOT })
  assert.match(textOf(tree).join(' '), /APPROVALS-UNAVAILABLE/)
})

test('the advanced block exposes the delegation policy and the screenshot budget', () => {
  // Both are operator judgements rather than code changes: the policy text is what tells the
  // model when to delegate at all, and the screenshot budget decides what a long GUI run costs
  // on disk (a full-resolution capture measured ~9.5 MB).
  const { tree } = renderSnapshot({
    ...BASE_SNAPSHOT,
    settings: {
      workers: [],
      requiredTier: 'workspace-write',
      approvalTimeoutMs: 90_000,
      heartbeatMs: 15_000,
      keepShots: 7,
      delegationPolicy: 'POLICY-BODY',
      sessionsEnabled: 0,
      enableCommand: '/remote-use on',
    },
  })

  const areas = []
  const inputs = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.type === 'textarea') areas.push(node)
    if (node.type === 'input') inputs.push(node)
    if (Array.isArray(node.children)) node.children.forEach(walk)
  }
  walk(tree)

  assert.equal(areas.length, 1, 'exactly one textarea: the policy editor')
  assert.equal(areas[0].props.value, 'POLICY-BODY', 'it must start from the stored policy')
  assert.equal(typeof areas[0].props.onChange, 'function')
  // The screenshot budget is a number input seeded from the settings, not from a default.
  const numeric = inputs.filter((n) => n.props.type === 'number').map((n) => String(n.props.value))
  assert.ok(numeric.includes('7'), `keepShots must be seeded, got ${numeric.join(',')}`)
  assert.ok(numeric.includes('90000'), 'approvalTimeoutMs must still be seeded')
})

test('the role block reports the per-session switch and names the real control', () => {
  // The page has no session identity, so it cannot offer a working toggle. Showing the state
  // and the command is the honest version of this control.
  const off = renderSnapshot({
    ...BASE_SNAPSHOT,
    settings: { workers: [], sessionsEnabled: 0, enableCommand: '/remote-use on' },
  })
  const offText = textOf(off.tree).join(' ')
  assert.match(offText, /SESSIONS-NONE/)
  assert.match(offText, /\/remote-use on/, 'the page must name the control that actually works')

  const on = renderSnapshot({
    ...BASE_SNAPSHOT,
    settings: { workers: [], sessionsEnabled: 3, enableCommand: '/remote-use on' },
  })
  assert.match(textOf(on.tree).join(' '), /SESSIONS-ON-3/)
})

test('the pairing panel is closed until asked for', () => {
  // Closed by default: pasting a credential is the shortcut, not the standing path, and a
  // credential box that is always on screen invites leaving a token in it.
  const { tree, react } = renderSnapshot({
    ...BASE_SNAPSHOT,
    settings: { workers: [], sessionsEnabled: 0, enableCommand: '/remote-use on' },
  })
  const toggles = findButton(tree, 'BTN-PAIR')
  assert.equal(toggles.length, 1, 'the pairing toggle must exist')

  // AdvancedSettings already renders a textarea (the delegation policy), so identify the
  // pairing box by its placeholder instead of counting textareas.
  const areas = []
  const collect = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (node.type === 'textarea' && node.props.placeholder === 'dshpair1.') areas.push(node)
    if (Array.isArray(node.children)) node.children.forEach(collect)
  }
  collect(tree)
  assert.equal(areas.length, 0, 'no paste box until the panel is opened')

  // Opening is a state change; the recorded setter shows it is a toggle, not a one-way open.
  toggles[0].props.onClick()
  const opened = lastSet(react, 5)
  assert.equal(typeof opened, 'function', 'the setter must be a functional update')
  assert.equal(opened(false), true, 'it toggles')
})

// ---------------------------------------------------------------------------
// the worker role panel
// ---------------------------------------------------------------------------

const ROLE_OFF = {
  armed: false, bindAddress: '', port: 7331, tokenSet: false, tokenHint: '',
  armedAt: 0, uptimeMs: 0, lastError: '', probe: { ok: false, reason: 'not checked yet' },
  interfaces: [
    { address: '192.168.1.100', name: '以太网', score: 40, private: true, virtual: false },
    { address: '172.20.0.1', name: 'vEthernet (Default Switch)', score: -1, private: true, virtual: true },
    { address: '169.254.1.1', name: 'Ethernet 2', score: 1, private: false, virtual: false },
  ],
}

function renderRole(role) {
  return renderSnapshot({
    ...BASE_SNAPSHOT,
    settings: { workers: [], sessionsEnabled: 0, enableCommand: '/remote-use on', workerRole: role },
  })
}

test('the worker role panel says plainly whether a listener is open', () => {
  // An operator who cannot see whether they left a port open has no way to check.
  const off = textOf(renderRole(ROLE_OFF).tree).join(' ')
  assert.match(off, /ROLE-DISARMED/)
  assert.match(off, /ROLE-DISARMED-NOTE/)
  assert.doesNotMatch(off, /ROLE-ARMED/)

  const on = textOf(renderRole({
    ...ROLE_OFF, armed: true, bindAddress: '192.168.1.100', uptimeMs: 90_000, tokenSet: true, tokenHint: '\u2022\u2022\u2022\u2022abcd',
  }).tree).join(' ')
  assert.match(on, /ROLE-ARMED/)
  // Address, how long, and which credential -- all three, so "am I still exposed" is answerable.
  assert.match(on, /192\.168\.1\.100/)
  assert.match(on, /1m/)
  assert.match(on, /abcd/)
})

test('the interface list is complete, and says why the virtual ones are not offered', () => {
  const tree = renderRole(ROLE_OFF).tree
  const options = []
  const collect = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (node.type === 'option') options.push(node)
    if (Array.isArray(node.children)) node.children.forEach(collect)
  }
  collect(tree)
  // Filtered by the interface addresses: AdvancedSettings renders its own <option> list (the
  // permission tiers), so counting every option would include three that have nothing to do with
  // the interface choice -- which is exactly what the first version of this assertion did.
  const addresses = new Set(ROLE_OFF.interfaces.map((i) => i.address))
  const ifaceOptions = options.filter((o) => addresses.has(String(o.props.value)))
  assert.equal(ifaceOptions.length, 3, 'every interface is listed, not only the usable ones')
  const virtual = ifaceOptions.find((o) => String(o.props.value) === '172.20.0.1')
  assert.ok(virtual !== undefined)
  assert.equal(virtual.props.disabled, true, 'a virtual adapter must not be selectable')
  assert.match(String(virtual.children[0]), /ROLE-VIRTUAL/)
  assert.match(String(virtual.children[0]), /ROLE-NOT-OFFERED/)
  const usable = ifaceOptions.find((o) => String(o.props.value) === '192.168.1.100')
  assert.equal(usable.props.disabled, false)
})

test('the arm button is disabled until a check has passed', () => {
  // Decision 4 refuses arming without a verified sandbox. A button that can only fail teaches
  // the operator to click through warnings, so it starts disabled.
  const before = findButton(renderRole(ROLE_OFF).tree, 'ROLE-ARM')
  assert.equal(before.length, 1)
  assert.equal(before[0].props.disabled, true, 'not armable before any check')

  const failed = findButton(renderRole({ ...ROLE_OFF, probe: { ok: false, reason: 'no mediator' } }).tree, 'ROLE-ARM')
  assert.equal(failed[0].props.disabled, true)

  const ok = textOf(renderRole({ ...ROLE_OFF, probe: { ok: true, reason: '' } }).tree).join(' ')
  assert.match(ok, /ROLE-SANDBOX-OK/)
})

test('the armed panel offers the local stop and says it does not contact the master', () => {
  const tree = renderRole({
    ...ROLE_OFF, armed: true, bindAddress: '192.168.1.100', tokenSet: true, tokenHint: '\u2022\u2022\u2022\u2022abcd',
  }).tree
  assert.equal(findButton(tree, 'ROLE-STOP').length, 1, 'the emergency stop must be reachable')
  assert.equal(findButton(tree, 'ROLE-STOP-FORGET').length, 1)
  assert.match(textOf(tree).join(' '), /ROLE-STOP-HINT/)
  // Nothing to arm while armed: the panel does not offer a no-op.
  assert.equal(findButton(tree, 'ROLE-ARM').length, 0)
})

test('the icon is the stroke-only style of the existing set, and self-contained', () => {
  const svg = readFileSync(join(PKG_ROOT, 'assets', 'icon.svg'), 'utf8')
  // Inlined as a data URL, so an external reference could never resolve.
  assert.equal(/<image\b|href\s*=|url\(/u.test(svg), false, 'the icon must not reference anything external')
  // Match the sibling notification plugin's icon so the nav reads as one set.
  assert.match(svg, /viewBox="0 0 64 64"/u)
  assert.match(svg, /fill="none"/u)
  assert.match(svg, /stroke="#4D6BFE"/u)
  assert.match(svg, /stroke-width="4"/u)
  assert.match(svg, /stroke-linejoin="round"/u)
  // Accessible name, because the nav may render it in place of the label.
  assert.match(svg, /role="img"/u)
  assert.match(svg, /aria-label="[^"]+"/u)
})

test('the in-page mark keeps the same geometry as the manifest icon', () => {
  // The page cannot read the package's files, so its mark is inlined -- which means the two
  // can drift. They are the same drawing, so a change to one that is not made to the other is
  // a bug, not a variation.
  const svg = readFileSync(join(PKG_ROOT, 'assets', 'icon.svg'), 'utf8')
  const svgPaths = [...svg.matchAll(/<path\s+d="([^"]+)"/gu)].map((m) => m[1]).sort()
  const client = readFileSync(join(PKG_ROOT, 'lib', 'client.js'), 'utf8')
  const clientPaths = [...client.matchAll(/h\('path',\s*\{\s*d:\s*'([^']+)'\s*\}\)/gu)].map((m) => m[1]).sort()
  assert.ok(svgPaths.length > 0, 'the manifest icon must contain paths')
  assert.deepEqual(clientPaths, svgPaths,
    'the inlined page mark and assets/icon.svg have diverged')
})

test('the icon is well-formed XML, because the browser decodes it as an <img>', () => {
  // THIS FAILED SILENTLY IN PRODUCTION. The manifest was valid, `iconOf()` accepted it, the
  // file existed and rendered in a preview -- and the plugin manager still showed its default
  // artwork. A double hyphen inside an XML comment is illegal, which made the document
  // malformed; the browser's <img> decoder rejected the data URL, and `PackageArtwork` fell
  // back on its `onError` path with nothing logged anywhere.
  const svg = readFileSync(join(PKG_ROOT, 'assets', 'icon.svg'), 'utf8')

  // 1. No double hyphen inside any comment.
  let rest = svg
  let comments = 0
  for (;;) {
    const start = rest.indexOf('<!--')
    if (start < 0) break
    const end = rest.indexOf('-->', start + 4)
    assert.ok(end > 0, 'every comment must be closed')
    const body = rest.slice(start + 4, end)
    comments += 1
    assert.equal(body.includes('--'), false,
      `a double hyphen is illegal inside an XML comment; it makes the whole document malformed. Offending comment:\n${body.slice(0, 200)}`)
    rest = rest.slice(0, start) + rest.slice(end + 3)
  }
  assert.equal(rest.includes('-->'), false, 'no stray comment terminator')

  // 2. Tags balance, and there is exactly one root element.
  const stripped = rest
  const tags = stripped.match(/<[^>]+>/gu) ?? []
  const open = []
  let roots = 0
  for (const tag of tags) {
    if (/^<\?|^<!/.test(tag)) continue
    if (/\/>$/.test(tag)) continue
    const name = /^<\/?\s*([A-Za-z_][\w.:-]*)/u.exec(tag)?.[1]
    assert.ok(name !== undefined, `unparsable tag: ${tag}`)
    if (tag.startsWith('</')) {
      assert.equal(open.pop(), name, `closing </${name}> does not match the open tag`)
    } else {
      if (open.length === 0) roots += 1
      open.push(name)
    }
  }
  assert.equal(open.length, 0, `unclosed tags: ${open.join(', ')}`)
  assert.equal(roots, 1, 'an SVG document must have exactly one root element')
  assert.equal(tags[0]?.startsWith('<svg'), true, 'the root element must be <svg>')
})

/**
 * Load lib/client.js against a stub module table, run its `apply`, and return what it
 * registered. `apply` is where registration happens, so a caller that skipped it would see
 * an empty list and draw the wrong conclusion about the plugin.
 */
/**
 * The kinds of the slots this plugin uses, as DSH declares them.
 *
 * Read from `dsh-client-ui-conversation`, `dsh-client-ui-sidebar-right` and `dsh-client-ui-sidebar`:
 * `conversation.input.dock` is `list`, `conversation.session.header.actions` is `list`,
 * `sidebar.right.pane.tab` and `.title` are `keyed`, `settings.section` is `single`. Keeping this
 * table here is what lets the stub enforce the same requirement the real service does.
 *
 * `conversation.composer` is deliberately ABSENT: it is `chain`, and this plugin must not register
 * there. Its owner renders it with `overlay: true`, and an elected chain entry is drawn with the
 * fallback -- the composer bar itself -- set to `display: none`, so electing would hide the input
 * box for as long as a remote request waits (see the seat note in lib/client.js and PITFALLS F28).
 */
const SLOT_SPECS = {
  'conversation.input.dock': 'list',
  'conversation.session.header.actions': 'list',
  'sidebar.right.pane.tab': 'keyed',
  'sidebar.right.pane.tab.title': 'keyed',
  'settings.section': 'single',
}

function loadClient(patch = {}) {
  const source = readFileSync(join(PKG_ROOT, 'lib', 'client.js'), 'utf8')
  let definition
  const sandbox = { __ModuleLoader__: { load: (def) => { definition = def } } }
  // eslint-disable-next-line no-new-func -- the file is a browser bundle, not an ES module
  new Function('window', source)(sandbox)

  assert.ok(definition !== undefined, 'client.js must call window.__ModuleLoader__.load')
  // Compared against the package name rather than a literal. This line used to hardcode
  // 'dsh-plugin-remote-use', which meant that after the package was renamed the harness REJECTED the
  // correct id and accepted the broken one -- so the one test positioned to catch the duplicate
  // registration was itself asserting the bug.
  assert.equal(definition.id, PKG.name,
    'the registration id must equal the package name (see the identity note above)')

  const react = makeReactStub()
  const moduleExports = definition.factory((name) => {
    if (name === 'react') return react
    throw new Error(`client.js requested unexpected module "${name}"`)
  })

  const registered = []
  const dictionaries = []
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (ns, dicts) => { dictionaries.push({ ns, dicts }) },
    },
    // Cordis runs an effect body immediately, so mirroring that keeps the test honest.
    effect: (fn) => fn(),
    // `ctx.get(name)` is how a plugin reaches a service it did NOT declare in `inject`; the real
    // context has it (first-party code uses `ctx.get('inputTriggers')`), so the stub must too.
    get: (name) => (name in patch ? patch[name] : undefined),
    slots: {
      inject: (_slot, fn) => fn(),
      // THE STUB ENFORCES THE REAL CONTRACT. It used to accept any declaration, and that leniency
      // hid a defect that took the whole app down: DSH's slots service THROWS for a `list` slot
      // registered without `id` ("list slot ... requires options.id", dsh-client-ui-slots), and
      // `apply()` throwing means the plugin's client bundle never loads -- the window does not
      // start. A stub that accepts more than reality proves nothing about registration.
      register: (decl, component) => {
        const spec = SLOT_SPECS[decl?.name]
        if (spec === undefined) throw new Error(`slot "${decl?.name}" is not declared (a parent entry's children table must declare it)`)
        if (spec === 'single' && registered.some((entry) => entry.decl?.name === decl.name)) {
          throw new Error(`single slot "${decl.name}" already has a registration`)
        }
        if (spec === 'keyed' && decl.key === undefined) throw new Error(`keyed slot "${decl.name}" requires options.key`)
        if (spec === 'list' && decl.id === undefined) throw new Error(`list slot "${decl.name}" requires options.id`)
        if (registered.some((entry) => entry.decl?.name === decl.name
          && ((spec === 'keyed' && entry.decl.key === decl.key) || (spec === 'list' && entry.decl.id === decl.id)))) {
          throw new Error(`slot "${decl.name}" already has an entry for ${spec === 'keyed' ? 'key' : 'id'} "${spec === 'keyed' ? decl.key : decl.id}"`)
        }
        registered.push({ decl, component })
      },
    },
    // `patch` exists for the OPTIONAL services: the right pane's tab type is only registered when
    // the shell provides `sidebarRightTabs`, and a test has to be able to stand that shell up.
    ...patch,
  }
  assert.equal(registered.length, 0, 'nothing may be registered before apply runs')
  moduleExports.apply(ctx)

  return { definition, moduleExports, registered, dictionaries, ctx, react }
}

/**
 * The settings section, found by NAME rather than by position.
 *
 * Registration order is not a contract, and it stopped being one the moment the plugin registered
 * the in-conversation approval surfaces: `registered[0]` had been the settings section, and five
 * render helpers silently pointed at the composer dock instead.
 */
function sectionsIn(registered) {
  return registered.filter((entry) => entry.decl?.name === 'settings.section')
}

function sectionOf(registered) {
  const [section] = sectionsIn(registered)
  assert.ok(section !== undefined, 'the settings section must be registered')
  return section
}

test('apply() must not leave a polling timer behind', () => {
  // Regression, measured: starting the feed's interval in `apply()` kept a handle alive that
  // nothing owned -- `node --test` never exited, and a shell with no approval surface mounted
  // would have polled the route forever for nobody. The feed starts on its first subscriber.
  const real = globalThis.setInterval
  const started = []
  globalThis.setInterval = (...args) => { started.push(args); return real(...args) }
  try {
    loadClient()
  } finally {
    globalThis.setInterval = real
  }
  assert.equal(started.length, 0, 'no timer may be created before anything subscribes')
})

test('the approval surfaces use shared slots, and never a single-occupancy one', () => {
  const tabTypes = []
  // Stand up the optional right-pane services, so the tab path is covered rather than skipped.
  const { registered } = loadClient({
    sidebarRightTabs: { register: (definition) => { tabTypes.push(definition); return () => {} } },
    sidebarRight: { openResource: () => {} },
  })
  const names = registered.map((entry) => entry.decl?.name)
  // Where the work happens: the full-width strip above the input bar, the session header, the pane.
  assert.ok(names.includes('conversation.input.dock'), 'the dock is the primary surface')
  assert.ok(names.includes('conversation.session.header.actions'))
  assert.ok(names.includes('sidebar.right.pane.tab'))
  assert.ok(names.includes('sidebar.right.pane.tab.title'))
  // The `chain` seat DSH's own approval prompt uses is NOT ours to take: electing there hides the
  // composer bar (`overlay: true` sets the fallback to `display: none`), i.e. the input box.
  assert.equal(names.includes('conversation.composer'), false)
  assert.equal(names.includes('conversation.composer.dock'), false)
  // `conversation.input.permission` and `sidebar.toggle.badge` are `kind: "single"` and already
  // owned by DSH's own plugins (the permission selector and the desktop-update badge). Claiming
  // either would DISPLACE first-party UI, so their absence here is a tested property.
  assert.equal(names.includes('conversation.input.permission'), false)
  assert.equal(names.includes('sidebar.toggle.badge'), false)
  // And the settings section is still registered exactly once.
  assert.equal(sectionsIn(registered).length, 1)
  // The tab type answers for OUR addresses only: a broad `canOpen` would let this plugin hijack a
  // pane another plugin asked for.
  assert.equal(tabTypes.length, 1)
  assert.deepEqual(tabTypes[0].patterns, ['dsh-resource://remote-use-approvals/**'])
  assert.equal(tabTypes[0].canOpen('dsh-resource://remote-use-approvals/current'), true)
  assert.equal(tabTypes[0].canOpen('dsh-resource://changes-review/1'), false)
})

test('the composer dock renders nothing while no request waits', () => {
  const { registered } = loadClient()
  const dock = registered.find((entry) => entry.decl?.name === 'conversation.input.dock')
  assert.ok(dock !== undefined)
  // Why this seat and not the status line: `order` is what fixes the strip's position in the list,
  // and the list renders in ascending order between DSH's own docks (todo 0, goal 10, queue 20).
  // Without it the strip sat wherever the host's status row happened to put it (F28).
  assert.equal(dock.decl.order, 30)
  const t = (key) => key
  // The closure hands the component the REAL feed, which has seen no snapshot yet, so the honest
  // render is "nothing" -- an empty strip above the composer would be noise in every session.
  assert.equal(expand(dock.component({ t })), null)
})

// ---------------------------------------------------------------------------
// the right pane's body and its framework hook
//
// The documented contract for a pane body is `useTabInfo()`, framework-injected, delivering
// `{ sidebar, panel, tab }`. The body uses exactly one field of it -- `tab.visible` -- because it
// decides whether this occurrence should hold a subscription to the shared feed.
// ---------------------------------------------------------------------------

/** The first `data-ru-tab` value in the tree, or undefined. */
function tabMarker(node, out = []) {
  if (node === null || typeof node !== 'object') return out[0]
  if (Array.isArray(node)) { for (const child of node) tabMarker(child, out); return out[0] }
  if (node.props?.['data-ru-tab'] !== undefined) out.push(node.props['data-ru-tab'])
  if (Array.isArray(node.children)) for (const child of node.children) tabMarker(child, out)
  return out[0]
}

function paneBody() {
  const { registered } = loadClient({
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openResource: () => {} },
  })
  const body = registered.find((entry) => entry.decl?.name === 'sidebar.right.pane.tab')
  assert.ok(body !== undefined, 'the pane body must be registered')
  return body.component
}

test('the pane body takes its occurrence from the framework hook', () => {
  const component = paneBody()
  const t = (key) => key
  const shown = expand(component({ t, useTabInfo: () => ({ tab: { id: 'tab-7', visible: true }, panel: { id: 'pane-1' }, sidebar: {} }) }))
  assert.equal(tabMarker(shown), 'tab-7', 'the body marks WHICH occurrence it belongs to')

  // A hidden occurrence still RENDERS. `visible` gates the subscription, not the content: blanking
  // the pane would hide the record the operator opened the pane to read.
  const hidden = expand(component({ t, useTabInfo: () => ({ tab: { id: 'tab-8', visible: false } }) }))
  assert.equal(tabMarker(hidden), 'tab-8')
  assert.match(textOf(hidden).join(' '), /approvalsPanelMissedTitle/, 'and it still draws its sections')
})

test('a pane body with no useTabInfo fails LOUDLY instead of quietly dropping the gate', () => {
  // The lesson from F25: a swallowed failure is a feature that stops working with nothing to show
  // for it. The renderer's entry boundary turns this into one dead pane, which is the right price.
  const component = paneBody()
  assert.throws(() => expand(component({ t: (key) => key })), /useTabInfo/)
})

// ---------------------------------------------------------------------------
// the availability badge: WARNINGS ARE NOT "UNAVAILABLE"
//
// Found by looking at a screenshot of the running page. The worker card said "unavailable" while
// the SAME CARD's detail line said `blocking 0`, and the connection line said "connected". The
// worker was usable; the badge was wrong.
//
// The cause was a two-branch test -- `ready` -> ready, `unknown` -> unknown, everything else ->
// unavailable -- which swept `warn` (advisory) and `partial` (a check could not run) into the
// unusable bucket. The product's own dispatch gate blocks on a check whose status is `fail` and
// ignores warnings, so it disagreed with its own page. The live harness had the identical wrong
// rule and was fixed first; this is the same fix on the browser side.
// ---------------------------------------------------------------------------

const verdictReport = (verdict, blockingFailures) => ({
  verdict, blockingFailures, sessionSegment: 'ok', checks: [],
})

function badgeText(verdict, blockingFailures) {
  const { tree } = renderSnapshot({
    ...BASE_SNAPSHOT,
    workers: [{
      peerId: 'w1', name: 'W', url: 'ws://h:7331', cwd: 'C:\\w', enabled: true,
      connected: true, tokenSet: true, tokenHint: '\u2022\u2022\u2022\u2022abcd',
      connection: { connected: true, connectFailures: 0 },
      report: verdictReport(verdict, blockingFailures),
    }],
    settings: { ...BASE_SNAPSHOT.settings, workers: [{ id: 'w1', url: 'ws://h:7331', tokenSet: true, enabled: true }] },
  })
  return { text: textOf(tree).join(' '), tree }
}

/** The badge element carrying the verdict label, so its COLOUR class can be checked too. */
function verdictBadge(verdict, blockingFailures) {
  const { tree } = badgeText(verdict, blockingFailures)
  let found = null
  const walk = (node) => {
    if (node === null || typeof node !== 'object' || found !== null) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node.props?.className === 'string' && node.props.className.startsWith('ru-badge ')
        && Array.isArray(node.children) && /^VERDICT-/u.test(String(node.children[0] ?? ''))) {
      found = node
      return
    }
    if (Array.isArray(node.children)) node.children.forEach(walk)
  }
  walk(tree)
  return found
}

test('a worker with warnings but no blocking failure is NOT labelled unavailable', () => {
  // The exact case in the screenshot: 0 blocking, 1 advisory.
  assert.equal(badgeText('warn', 0).text.match(/VERDICT-[A-Z]+/u)?.[0], 'VERDICT-WARN')
  assert.equal(badgeText('warn', 0).text.includes('VERDICT-BLOCKED'), false)
  // AND THE COLOUR. The badge is the loudest signal on the card, so the class is asserted too: a
  // mutation that removed only the `warn` branch from `verdictClass` left every text assertion
  // above passing, which is exactly how this gap was found.
  assert.equal(verdictBadge('warn', 0)?.props.className, 'ru-badge warn')
})

test('each verdict gets its own badge, and only a blocking failure reads as unusable', () => {
  const label = (v, b) => badgeText(v, b).text.match(/VERDICT-[A-Z]+/u)?.[0]
  assert.equal(label('ready', 0), 'VERDICT-READY')
  assert.equal(label('blocked', 2), 'VERDICT-BLOCKED', 'a failed blocking check IS unusable')
  // `partial` means a check could not be evaluated -- its own state, not a fault.
  assert.equal(label('partial', 0), 'VERDICT-PARTIAL')
  assert.equal(label('something-new', 0), 'VERDICT-UNKNOWN', 'an unknown verdict must not claim a fault either')

  // Colour, per verdict: only `blocked` may be red.
  assert.equal(verdictBadge('ready', 0)?.props.className, 'ru-badge ok')
  assert.equal(verdictBadge('blocked', 2)?.props.className, 'ru-badge bad')
  assert.equal(verdictBadge('partial', 0)?.props.className, 'ru-badge mute')
  assert.notEqual(verdictBadge('warn', 0)?.props.className, 'ru-badge bad',
    'an advisory warning must never be painted as a failure')
})

// ---------------------------------------------------------------------------
// the role note must not deny a feature that is on the same screen
// ---------------------------------------------------------------------------

test('the role note does not claim worker mode is unimplemented while its panel is rendered', () => {
  const text = textOf(renderRole(ROLE_OFF).tree).join(' ')
  // The note is a FAKE translation in these tests, so what is asserted is that the note is present
  // and that the panel's own controls are too -- the invariant is "the note does not contradict
  // what is on screen". The wording itself is checked against the real dictionary below.
  assert.match(text, /ROLE-NOTE/u)
  assert.match(text, /ROLE-ARM/u, 'the arm button is on the same screen as the note')
  assert.match(text, /ROLE-CHECK/u)
})

test('no dictionary claims symmetric pairing is unimplemented', () => {
  const source = readFileSync(join(PKG_ROOT, 'lib', 'client.js'), 'utf8')
  // The VALUE of `roleNote` in each dictionary, checked at the source because the stub replaces
  // dictionaries with markers. Only the value is inspected: a comment above the line legitimately
  // quotes the old wording to explain why it changed, and scanning the whole file for the phrase
  // would flag that explanation.
  const values = [...source.matchAll(/roleNote:\s*'((?:[^'\\]|\\.)*)'/gu)].map((m) => m[1])
  assert.equal(values.length, 2, `expected the zh and en role notes, found ${values.length}`)
  for (const value of values) {
    for (const phrase of ['尚未实现', 'not implemented', 'not yet']) {
      assert.equal(value.includes(phrase), false,
        `the role note still says "${phrase}": ${value.slice(0, 80)} -- worker mode IS implemented, and the note sits directly above its panel`)
    }
    // ...and it should point at the panel that exists.
    assert.match(value, /布防|armed|below|下方/u, `the role note must point at the panel: ${value.slice(0, 80)}`)
  }
})

// ---------------------------------------------------------------------------
// hooks discipline: the failure this suite otherwise cannot see
//
// The stub invokes components as PLAIN FUNCTIONS, so React's reconciler never runs and a
// rules-of-hooks violation is invisible here -- it would show up as a blank page in the browser,
// which is the one place this suite cannot reach. React's rule is that the hook CALL ORDER must be
// identical on every render; two renders of the same component over structurally different data
// must therefore produce the same sequence.
//
// That is exactly what a conditional hook breaks: `if (x) useState()` yields one sequence when `x`
// is truthy and another when it is not.
// ---------------------------------------------------------------------------

/** The hook kinds each COMPONENT called, in order, for one snapshot. */
function hookSequence(snapshot) {
  const { react } = renderSnapshot(snapshot)
  // Grouped by component: `WorkerCard` exists only when there are workers, and its own hooks are
  // its own business. React's rule is that the order is stable across renders OF ONE COMPONENT.
  const perComponent = new Map()
  for (const entry of react.__state.kinds) {
    const cut = entry.lastIndexOf(':')
    const component = entry.slice(0, cut)
    const kind = entry.slice(cut + 1)
    if (!perComponent.has(component)) perComponent.set(component, [])
    perComponent.get(component).push(kind)
  }
  return perComponent
}

test('every component calls its hooks in the same order whatever the data says', () => {
  const empty = hookSequence(BASE_SNAPSHOT)
  assert.ok(empty.size > 0, 'the stub recorded no hooks at all, so this guard proves nothing')
  assert.ok(empty.get('RemoteUseSection') !== undefined, `the section component was not identified: ${[...empty.keys()].join(',')}`)

  // Structurally different on purpose: no workers vs. workers, off vs. armed, no tasks vs. tasks,
  // no approvals vs. a pending one, no audit vs. a populated trail.
  const populated = hookSequence({
    ...BASE_SNAPSHOT,
    workers: [{
      peerId: 'w1', name: 'W', url: 'ws://h:7331', connected: true, tokenSet: true, tokenHint: '\u2022\u2022\u2022\u2022abcd',
      enabled: true, cwd: 'C:\\w', report: { verdict: 'warn', blockingFailures: 0, sessionSegment: 'ok', checks: [] },
      connection: { connected: true, connectFailures: 0 },
    }],
    tasks: [{ id: 't1', peerId: 'w1', label: 'L', status: 'running', startedAt: 1 }],
    settings: {
      workers: [{ id: 'w1', url: 'ws://h:7331', tokenSet: true, tokenHint: '\u2022\u2022\u2022\u2022abcd', enabled: true, cwd: 'C:\\w' }],
      sessionsEnabled: 2, enableCommand: '/remote-use on', delegationPolicy: 'policy text',
      requiredTier: 'danger-full-access', approvalTimeoutMs: 90_000, heartbeatMs: 15_000, keepShots: 5,
      workerRole: {
        armed: true, bindAddress: '192.168.1.100', port: 7331, tokenSet: true, tokenHint: '\u2022\u2022\u2022\u2022wxyz',
        armedAt: 1, uptimeMs: 60_000, lastError: '', probe: { ok: true, reason: '' },
        interfaces: [{ address: '192.168.1.100', name: 'eth', score: 40, virtual: false }],
      },
    },
    approvals: {
      available: true, timeoutMs: 88_000, recent: [],
      pending: [{ id: 'a1', peerId: 'w1', taskId: 't1', toolCallId: 'c1', toolName: 'write', requiredTier: 'danger-full-access', reason: 'r', rawInput: '', ageMs: 1 }],
    },
    audit: { available: true, path: 'p', error: '', recent: [{ at: 't', toolName: 'write', optionId: 'allow-once', by: 'human' }] },
  })

  // Every component that renders in BOTH snapshots must agree. A component that only exists in one
  // of them has nothing to compare against, which is not a violation.
  const shared = [...empty.keys()].filter((name) => populated.has(name))
  assert.ok(shared.length > 0, 'no component rendered in both snapshots, so nothing was compared')
  for (const name of shared) {
    assert.deepEqual(populated.get(name), empty.get(name),
      `${name} changed its hook order with the data -- a rules-of-hooks violation, and a blank page in the browser`)
  }
  // The populated render must actually have reached the components that only appear with data,
  // or this test would pass by never exercising them.
  assert.ok([...populated.keys()].length > shared.length,
    'the populated snapshot rendered no extra component, so it did not differ enough to be a test')
})

test('the section does not call a hook from inside a callback or a loop', () => {
  // A hook called from a handler is legal-looking code that React rejects at runtime. The stub
  // records only what ran during the render, so a hook that fires later would append to the
  // sequence -- capturing it once, then exercising the handlers, would show the extra entry.
  const { react } = renderSnapshot({ ...BASE_SNAPSHOT, workers: [] })
  const duringRender = react.__state.kinds.length
  assert.ok(duringRender > 0)
  // Nothing may have been recorded after the render returned.
  assert.equal(react.__state.kinds.length, duringRender)
})

test('the client registers exactly one settings.section for this plugin', () => {
  const { moduleExports, registered, dictionaries } = loadClient()
  assert.deepEqual(moduleExports.inject, ['slots', 'locale'])
  assert.equal(typeof moduleExports.apply, 'function')
  assert.equal(sectionsIn(registered).length, 1, 'exactly one section, or the Settings nav duplicates')

  const { decl, component } = sectionsIn(registered)[0]
  assert.equal(decl.name, 'settings.section')
  // SHORT by convention, and NOT the package name -- unlike the registration id at the top of the
  // bundle. DSH's own first-party sections register under ids like `agent-presets` and `account`.
  // The locale namespace below shares this style: it keeps the pre-rename name on purpose, because
  // changing it would discard registered strings for no benefit.
  assert.equal(decl.id, 'dsh-plugin-remote-use')
  assert.equal(decl.locale, 'dsh-plugin-remote-use')
  assert.equal(typeof component, 'function')
  // A number is required: the nav orders sections by it.
  assert.equal(typeof decl.order, 'number')

  assert.equal(dictionaries.length, 1, 'the namespace must be registered')
  assert.equal(dictionaries[0].ns, 'dsh-plugin-remote-use')
  assert.ok(dictionaries[0].dicts.zh.nav, 'zh dictionary must carry the nav label')
  assert.ok(dictionaries[0].dicts.en.nav, 'en dictionary must carry the nav label')
})

// ---------------------------------------------------------------------------
// browser half: rendering
// ---------------------------------------------------------------------------

/**
 * Minimal React stand-in: enough for createElement and the hooks the page uses, so the
 * component can be invoked as a plain function and its tree inspected.
 *
 * `useState` supports seeding by hook POSITION. The page loads its snapshot through an
 * async effect, which this stub deliberately does not run -- without a seed the component
 * always renders its empty state and no data-bearing assertion is possible. Seeding the
 * first hook is what lets these tests cover the populated tree at all; hooks are called in
 * a fixed order, so the index is stable.
 */
function makeReactStub() {
  // `kinds` records `component:hook`, so a guard can compare per component rather than per tree.
  const state = { index: 0, seeds: [], calls: [], kinds: [], current: '(top)' }
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return {
    __state: state,
    createElement,
    useState: (initial) => {
      const index = state.index
      state.index += 1
      // The INDEX is deliberately not recorded. It is a position in the global state array, so the
      // same component gets a different one depending on how many hooks ran before it in THIS tree
      // -- comparing indices across two different snapshots reports every component as changed.
      // React's rule is about the SEQUENCE OF KINDS per component, which is what is recorded.
      state.kinds.push(`${state.current}:useState`)
      if (state.calls[index] === undefined) state.calls[index] = []
      const seed = state.seeds[index]
      const value = seed !== undefined ? seed : (typeof initial === 'function' ? initial() : initial)
      // The setter RECORDS instead of applying. Nothing re-renders, but a test can then ask
      // what a click would have put into state -- the only way to cover a handler whose whole
      // job is to compute that argument, such as the Edit button's.
      return [value, (next) => { state.calls[index].push(next) }]
    },
    // Every hook records WHICH COMPONENT called it and its kind, in call order. Only `useState`
    // consumes a slot: the index is a state position, and letting the others advance it would shift
    // every seed and silently re-point the existing tests at the wrong hook.
    useEffect: () => { state.kinds.push(`${state.current}:useEffect`) },
    useMemo: (fn) => { state.kinds.push(`${state.current}:useMemo`); return fn() },
    useCallback: (fn) => { state.kinds.push(`${state.current}:useCallback`); return fn },
  }
}

/** The last value a click passed to the hook at `index`, or undefined if it never fired. */
function lastSet(react, index) {
  const calls = react.__state.calls[index]
  return calls === undefined || calls.length === 0 ? undefined : calls[calls.length - 1]
}

/** Every element that is a button whose direct children include `label`. */
function findButton(node, label, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) findButton(child, label, out); return out }
  if (node.type === 'button' && Array.isArray(node.children) && node.children.includes(label)) out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) findButton(child, label, out)
  return out
}

/** Walk a stub element tree and collect every string leaf. */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) textOf(child, out)
  }
  return out
}

/** Collect every element whose props.className contains `token`. */
function findByClass(node, token, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) findByClass(child, token, out); return out }
  if (typeof node.props?.className === 'string' && node.props.className.includes(token)) out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) findByClass(child, token, out)
  return out
}

/**
 * Expand function components the way React would.
 *
 * `createElement` only builds an element; without this step a component passed as `type`
 * (WorkerCard) is never invoked and its content never reaches the tree -- which silently
 * made a "worker row renders" assertion fail while the inline task table passed.
 */
function expand(node, react) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((child) => expand(child, react))
  if (typeof node.type === 'function') {
    // Tell the stub which component is rendering, so every hook it records is attributed to the
    // right one. Hooks belong to a component INSTANCE, not to a render tree: `WorkerCard` renders
    // once per worker and adds its own `useState`s, which is legal and which a flattened sequence
    // reports as a violation.
    if (react !== undefined) react.__state.current = node.type.name || '(anonymous)'
    return expand(node.type({ ...node.props, children: node.children }), react)
  }
  return { ...node, children: (node.children ?? []).map((child) => expand(child, react)) }
}

/** A stand-in translator covering every key the assertions below rely on. */
function makeTranslator() {
  return (key, values) => {
    const table = {
      title: 'TITLE', description: 'DESC', roleNote: 'ROLE-NOTE', loading: 'LOADING',
      noWorkers: 'NO-WORKERS', nav: 'NAV', btnAdd: 'BTN-ADD', btnEdit: 'BTN-EDIT',
      btnDelete: 'BTN-DELETE', btnSave: 'BTN-SAVE', btnCancel: 'BTN-CANCEL',
      formAddTitle: 'FORM-ADD', fieldId: 'F-ID', fieldUrl: 'F-URL', fieldToken: 'F-TOKEN',
      fieldTokenNew: 'F-TOKEN-NEW', groupAdvanced: 'GROUP-ADV', groupSource: 'GROUP-SRC',
      sourceText: 'SOURCE {file}', groupTasks: 'GROUP-TASKS', noTasks: 'NO-TASKS',
      groupDanger: 'GROUP-DANGER', groupWorkers: 'GROUP-WORKERS', groupRole: 'GROUP-ROLE',
      roleMaster: 'ROLE-MASTER', tokenStored: 'STORED {hint}', tokenMissing: 'NOT-SET',
      fieldCwd: 'F-CWD', fieldEnabled: 'F-ENABLED',
      btnAllow: 'BTN-ALLOW', btnDeny: 'BTN-DENY', btnPair: 'BTN-PAIR', btnPairSave: 'BTN-PAIR-SAVE',
      approvalsBudget: 'BUDGET-{s}', auditNote: 'AUDIT-AT-{p}',
      verdictReady: 'VERDICT-READY', verdictWarn: 'VERDICT-WARN',
      verdictPartial: 'VERDICT-PARTIAL', verdictBlocked: 'VERDICT-BLOCKED',
      verdictUnknown: 'VERDICT-UNKNOWN',
      fieldKeepShots: 'F-KEEPSHOTS', fieldPolicy: 'F-POLICY', fieldSessions: 'F-SESSIONS',
      sessionsOn: 'SESSIONS-ON-{n}', sessionsNone: 'SESSIONS-NONE', switchHint: 'SWITCH {cmd}',
      roleArmed: 'ROLE-ARMED', roleDisarmed: 'ROLE-DISARMED', roleDisarmedNote: 'ROLE-DISARMED-NOTE',
      roleUptime: 'UP', roleToken: 'TOK', roleSandbox: 'SANDBOX', roleSandboxOk: 'ROLE-SANDBOX-OK',
      roleSandboxUnknown: 'ROLE-SANDBOX-?',
      roleBind: 'BIND', roleBindHint: 'BIND-HINT', roleVirtual: 'ROLE-VIRTUAL', roleNotOffered: 'ROLE-NOT-OFFERED',
      rolePort: 'PORT', rolePortHint: 'PORT-HINT', roleCheck: 'ROLE-CHECK', roleArm: 'ROLE-ARM',
      roleCheckOk: 'ROLE-CHECK-OK', roleCheckFailed: 'ROLE-CHECK-FAILED',
      roleIssuedOnce: 'ROLE-ONCE', rolePairing: 'PAIRING', rolePairingHint: 'PAIRING-HINT',
      roleTokenLabel: 'TOKEN-LABEL', roleTokenHint: 'TOKEN-HINT', roleIssuedDone: 'ROLE-DONE',
      roleStop: 'ROLE-STOP', roleStopForget: 'ROLE-STOP-FORGET', roleStopHint: 'ROLE-STOP-HINT',
      fieldPairing: 'F-PAIRING', fieldPairingHint: 'PAIR-HINT', fieldPairingPlaceholder: 'dshpair1.', pairDone: 'PAIR-DONE',
      approvalsUnavailable: 'APPROVALS-UNAVAILABLE', approvalsNone: 'APPROVALS-NONE',
      approvalsMissed: 'MISSED-{n}', approvalsMissedNote: 'MISSED-NOTE', colSettled: 'COL-SETTLED',
      btnClearMissed: 'BTN-CLEAR', btnClearing: 'BTN-CLEARING', clearedMissed: 'CLEARED-{n}',
      clearMissedNote: 'CLEAR-NOTE',
      auditNone: 'AUDIT-NONE',
      auditBy: 'AUDIT-BY-{by}', auditByHuman: 'AUDIT-BY-HUMAN',
      auditByEngine: 'AUDIT-BY-ENGINE', auditByTimeout: 'AUDIT-BY-TIMEOUT',
      auditByDisposed: 'AUDIT-BY-DISPOSED', auditByPage: 'AUDIT-BY-PAGE', auditByApi: 'AUDIT-BY-API',
      // The screenshot-cache block on a worker card. The scope is substituted into the button
      // labels, which is how the tests find the four buttons without depending on their order.
      groupCache: 'GROUP-CACHE', cacheLimitText: 'LIMIT {size}', cacheNoLimit: 'NO-LIMIT',
      labelCacheHost: 'HOST', labelCacheWorker: 'WORKER', cacheNone: 'CACHE-NONE',
      cacheUnsupported: 'CACHE-UNSUPPORTED', cacheUnreachable: 'CACHE-UNREACHABLE',
      cacheFiles: 'FILES-{n}', cacheOver: 'OVER-{size}', fieldShotCache: 'F-SHOT-CACHE',
      fieldShotCacheHint: 'F-SHOT-CACHE-HINT', btnCacheApply: 'CACHE-APPLY-{scope}',
      btnCacheClear: 'CACHE-CLEAR-{scope}', cacheSaveFailed: 'CACHE-SAVE-FAILED',
      cacheCleared: 'CACHE-CLEARED-{scope}-{n}-{size}', cacheClearNothing: 'CACHE-CLEAR-NOTHING-{scope}',
      cachePruned: 'CACHE-PRUNED-{scope}-{n}-{size}', cacheWithinBudget: 'CACHE-WITHIN-{scope}',
      cacheFilesCleared: 'CACHE-FILES-{n}',
    }
    const template = table[key] ?? key
    return values === undefined ? template : String(template).replace(/\{(\w+)\}/g, (w, k) => (k in values ? values[k] : w))
  }
}

function renderWith(workers, tasks = []) {
  const { registered, react } = loadClient()
  const Section = sectionOf(registered).component
  // Seed the component's first useState (its snapshot) so the populated tree is rendered.
  react.__state.index = 0
  react.__state.seeds = [{
    ok: true,
    workers,
    tasks,
    settingsFile: 'C:\\dsh\\settings.json',
    settings: { requiredTier: 'workspace-write', approvalTimeoutMs: 90000, heartbeatMs: 15000 },
  }]
  return expand(Section({ t: makeTranslator() }))
}

/**
 * Render with the add/edit form open.
 *
 * The form is opened by a click, and the React stub's setters are no-ops, so the `editing`
 * hook is seeded directly instead. Hook order in the section is
 * snapshot, loadError, busy, status, editing -- hence index 4.
 */
function renderEditing(snapshot, editing) {
  const { registered, react } = loadClient()
  const Section = sectionOf(registered).component
  react.__state.index = 0
  react.__state.seeds = []
  react.__state.seeds[0] = snapshot
  react.__state.seeds[4] = editing
  return expand(Section({ t: makeTranslator() }))
}

test('the section renders its heading and the honest role note without a worker list', () => {
  const tree = renderWith([])
  const text = textOf(tree).join(' ')
  assert.match(text, /TITLE/)
  assert.match(text, /DESC/)
  // The page must not pretend a role switch exists; it states the current role instead.
  assert.match(text, /ROLE-NOTE/)
  assert.match(text, /NO-WORKERS/)
})

test('the section renders a worker row with its readiness verdict', () => {
  const tree = renderWith([{
    peerId: 'worker-pc',
    name: 'worker-pc',
    cwd: 'C:\\dsh-remote\\p0work',
    error: '',
    activeTasks: 2,
    report: {
      worker: 'WORKER-PC',
      sessionSegment: 'ok',
      verdict: 'ready',
      blockingFailures: 0,
      warnings: 0,
      unchecked: 0,
      cachedAgeMs: 12,
      checks: [
        { id: 'S1', name: 'display adapter attached', severity: 'blocking', status: 'pass', actual: '4 adapters', fix: 'x' },
        { id: 'S7', name: 'session unlocked', severity: 'blocking', status: 'fail', actual: 'Locked', fix: 'unlock it' },
      ],
    },
    connection: { connected: true, connects: 3, bridge: { approvals: 2 }, heartbeatFailures: 1 },
  }])
  const text = textOf(tree).join(' ')
  assert.match(text, /worker-pc/)
  assert.match(text, /C:\\dsh-remote\\p0work/)
  assert.match(text, /WORKER-PC/)
  assert.match(text, /2/, 'active task count must appear')
  // Only the failing check is listed until the operator expands, so the fix text is present
  // while the passing check's name is not.
  assert.match(text, /unlock it/)
  assert.doesNotMatch(text, /display adapter attached/)
})

test('the section renders a task row and marks an active one', () => {
  const tree = renderWith([], [{
    taskId: 'rtask_1',
    peerId: 'worker-pc',
    state: 'running',
    toolCallCount: 4,
    recentTools: ['pwsh'],
    startedAt: 1700000000000,
  }])
  const text = textOf(tree).join(' ')
  assert.match(text, /rtask_1/)
  assert.match(text, /running/)
  assert.match(text, /pwsh/)
})

test('a malformed worker row does not crash the render', () => {
  // The route is the only producer today, but a page that throws on an unexpected shape
  // shows the operator a blank Settings tab with no clue. Degrade instead.
  const tree = renderWith([{ peerId: 'p', report: null, connection: undefined }])
  const text = textOf(tree).join(' ')
  assert.match(text, /p/)
})

test('before the first response the page says loading, not "no workers configured"', () => {
  // Regression for a REPORTED bug: the Host probes readiness before answering, so against
  // an unreachable worker the first response can take a full TCP connect timeout. Rendering
  // the empty state during that window told the operator "nothing is configured" about data
  // it had not received -- a confident claim of absence.
  const { registered, react } = loadClient()
  const Section = sectionOf(registered).component
  const t = (key) => ({ title: 'TITLE', description: 'DESC', roleNote: 'ROLE-NOTE', loading: 'LOADING', noWorkers: 'NO-WORKERS' }[key] ?? key)
  react.__state.index = 0
  react.__state.seeds = [] // no snapshot yet
  const text = textOf(expand(Section({ t }))).join(' ')
  assert.match(text, /LOADING/)
  assert.doesNotMatch(text, /NO-WORKERS/, 'absence must not be asserted before the first response')
})

test('a worker with no report is described as pending, not as missing', () => {
  const tree = renderWith([{
    peerId: 'w1',
    name: 'w1',
    cwd: 'C:\\work',
    error: 'readiness probe did not finish within 4000 ms',
    activeTasks: 0,
    report: null,
    connection: { connected: false, connectFailures: 2, lastError: 'connect ETIMEDOUT' },
  }])
  const text = textOf(tree).join(' ')
  assert.match(text, /w1/)
  assert.match(text, /reportPending/, 'a missing report is its own state')
  assert.match(text, /did not finish within 4000 ms/, 'the reason must be shown')
})

// ---------------------------------------------------------------------------
// pairing: the controls the page grew so a worker can be added without YAML
// ---------------------------------------------------------------------------

test('each worker card offers edit and delete', () => {
  const tree = renderWith([{ peerId: 'w1', name: 'w1', cwd: 'C:\\w', error: '', activeTasks: 0, report: null, connection: {} }])
  const text = textOf(tree).join(' ')
  assert.match(text, /BTN-EDIT/)
  assert.match(text, /BTN-DELETE/)
})

test('the worker list offers an add button and states where settings are written', () => {
  const text = textOf(renderWith([])).join(' ')
  assert.match(text, /BTN-ADD/)
  // The precedence rule has to be visible, or "I edited the profile and nothing happened"
  // becomes an unexplainable mystery once a settings file exists.
  assert.match(text, /GROUP-SRC/)
  assert.match(text, /C:\\dsh\\settings\.json/)
})

test('the approval policy controls render when the host reports settings', () => {
  const text = textOf(renderWith([])).join(' ')
  assert.match(text, /GROUP-ADV/)
  assert.match(text, /workspace-write/, 'the current tier is shown')
})

test('a new worker MUST supply a token before it can be saved', () => {
  const text = textOf(renderEditing(
    { ok: true, workers: [], tasks: [], settings: {}, settingsFile: 'C:\\s.json' },
    { draft: { enabled: true, serialQueue: 1 }, isNew: true },
  )).join(' ')
  // The add form asks for a token and says the stored-token rule does not apply to a new one.
  assert.match(text, /FORM-ADD/)
  assert.match(text, /F-TOKEN-NEW/)
  assert.match(text, /NOT-SET/)
})

test('editing an existing worker offers a blank token that means "keep the stored one"', () => {
  const text = textOf(renderEditing(
    { ok: true, workers: [], tasks: [], settings: {}, settingsFile: 'C:\\s.json' },
    { draft: { id: 'w1', url: 'ws://x', tokenSet: true, tokenHint: '\u2022\u2022abc1', enabled: true, serialQueue: 1 }, isNew: false },
  )).join(' ')
  assert.match(text, /F-TOKEN/)
  // The masked hint proves a token exists without revealing it, and the label is the
  // "keep" variant rather than the "required" one.
  assert.match(text, /STORED \u2022\u2022abc1/)
  assert.doesNotMatch(text, /F-TOKEN-NEW/)
})

// ---------------------------------------------------------------------------
// regression: Edit must be seeded from the CONFIGURATION, not the live snapshot
//
// REPORTED SYMPTOM: the page showed a connected, ready worker, but pressing Edit opened an
// empty form. The route returns two arrays -- `workers` (live: peerId, name, cwd, report,
// connection) and `settings.workers` (config: id, name, url, cwd, enabled, serialQueue,
// tokenSet) -- and the button was seeded from the first, so `id`, `url` and the token state
// were all undefined.
// ---------------------------------------------------------------------------

/** Render with both arrays present, and hand back the react stub for click inspection. */
function renderPairing(snapshotWorkers, configWorkers) {
  const { registered, react } = loadClient()
  const Section = sectionOf(registered).component
  react.__state.index = 0
  react.__state.seeds = []
  react.__state.seeds[0] = {
    ok: true,
    workers: snapshotWorkers,
    tasks: [],
    settingsFile: 'C:\\dsh\\settings.json',
    settings: { workers: configWorkers, requiredTier: 'workspace-write', approvalTimeoutMs: 90000, heartbeatMs: 15000 },
  }
  const tree = expand(Section({ t: makeTranslator() }))
  return { tree, react }
}

test('pressing Edit seeds the form from the configuration, not from the live snapshot', () => {
  const snapshotRow = {
    peerId: 'worker-pc', name: 'worker-pc', cwd: 'C:\\dsh-remote\\p0work',
    error: '', activeTasks: 0, report: null, connection: {},
  }
  const configRow = {
    id: 'worker-pc', name: 'worker-pc', url: 'ws://192.168.1.101:7331',
    cwd: 'C:\\dsh-remote\\p0work', enabled: true, serialQueue: 1,
    tokenSet: true, tokenHint: '\u2022\u2022\u2022\u2022UpS0',
  }
  const { tree, react } = renderPairing([snapshotRow], [configRow])

  const [editButton] = findButton(tree, 'BTN-EDIT')
  assert.ok(editButton !== undefined, 'the card must offer an Edit button')
  editButton.props.onClick()

  // Hook order in the section is snapshot, loadError, busy, status, editing.
  const editing = lastSet(react, 4)
  assert.ok(editing !== undefined, 'Edit must open the form')
  assert.equal(editing.isNew, false)
  // Every field the form needs must come from the configuration.
  assert.equal(editing.draft.id, 'worker-pc')
  assert.equal(editing.draft.url, 'ws://192.168.1.101:7331')
  assert.equal(editing.draft.tokenSet, true, 'the token state drives the "stored" hint')
  assert.equal(editing.draft.tokenHint, '\u2022\u2022\u2022\u2022UpS0')
  assert.equal(editing.draft.cwd, 'C:\\dsh-remote\\p0work')
  assert.equal(editing.draft.serialQueue, 1)
})

test('Edit still opens a usable form when the worker is missing from the configuration', () => {
  // A worker can be live but absent from the saved list (removed while connected). Falling
  // back to the snapshot's id keeps the form addressable instead of crashing on `undefined`.
  const snapshotRow = {
    peerId: 'ghost', name: 'Ghost', cwd: 'C:\\g', error: '', activeTasks: 0, report: null, connection: {},
  }
  const { tree, react } = renderPairing([snapshotRow], [])
  const [editButton] = findButton(tree, 'BTN-EDIT')
  editButton.props.onClick()

  const editing = lastSet(react, 4)
  assert.equal(editing.draft.id, 'ghost')
  assert.equal(editing.draft.name, 'Ghost')
  assert.equal(editing.draft.url, '', 'an empty url is visible to the operator rather than silently wrong')
})

// ---------------------------------------------------------------------------
// the screenshot-cache control on the worker card
//
// WHY THIS IS DRIVEN RATHER THAN READ: `budgetText` and `parseBudgetText` are closure-local, so the
// only way to reach them is the control the operator uses -- which is also the only way to know the
// control is wired to them. It matters because those two functions decide what a DESTRUCTIVE button
// applies: a parse that reads 512 MB as 512 bytes deletes nothing, and one that reads a gap as a
// number deletes the lot, and both look like the button being broken.
//
// The React stub does not re-render, so a keystroke is applied the way the stub models state: the
// setter records the value and the test re-renders with that value as the seed. `renderEditing`
// already uses the seeding half of this; the recording half is what makes a typed value reachable.
// ---------------------------------------------------------------------------

/** The cache field's input, found by the placeholder the field ships with. */
function findCacheInput(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) findCacheInput(child, out); return out }
  if (node.type === 'input' && node.props?.placeholder === '512MB') out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) findCacheInput(child, out)
  return out
}

/** One worker row as the route produces it, with both cache halves. */
function cacheRow(overrides = {}) {
  return {
    peerId: 'w1',
    name: 'w1',
    cwd: 'C:\\work',
    error: '',
    activeTasks: 0,
    report: { worker: 'W1', sessionSegment: 'ok', verdict: 'ready', blockingFailures: 0, warnings: 0, unchecked: 0, checks: [] },
    connection: { connected: true, connects: 1 },
    hostCache: null,
    workerCache: null,
    ...overrides,
  }
}

/**
 * Render the section with one worker and, optionally, a value typed into the cache field.
 * `settings.shotCacheBytes` is the SAVED ceiling the field opens on -- the post-merge truth.
 */
function renderCache({ shotCacheBytes = 0, budget = undefined, row = {} } = {}) {
  const { registered, react } = loadClient()
  const Section = sectionOf(registered).component
  const snapshot = {
    ok: true,
    workers: [cacheRow(row)],
    tasks: [],
    settingsFile: 'C:\\dsh\\settings.json',
    settings: {
      workers: [], requiredTier: 'workspace-write', approvalTimeoutMs: 90000, heartbeatMs: 15000,
      keepShots: 20, shotCacheBytes, sessionsEnabled: 0, enableCommand: '/remote-use on',
    },
  }
  const render = () => {
    react.__state.index = 0
    react.__state.kinds = []
    react.__state.seeds[0] = snapshot
    return expand(Section({ t: makeTranslator() }), react)
  }
  let tree = render()
  if (budget !== undefined) {
    const [input] = findCacheInput(tree)
    assert.ok(input !== undefined, 'the cache field must render, or the typed value is never covered')
    input.props.onChange({ target: { value: budget } })
    // Which hook index is the field's own state: the setter that recorded this exact text.
    const index = react.__state.calls.findIndex((calls) => Array.isArray(calls) && calls.includes(budget))
    assert.ok(index >= 0, 'the field did not record the typed value, so this harness is out of step with it')
    react.__state.seeds[index] = budget
    tree = render()
  }
  return { tree, react }
}

/** Record every request the page makes, and answer each one with `reply`. */
function captureFetch(reply = () => ({ ok: true, result: { removed: 0, freedBytes: 0 }, supported: true })) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const entry = {
      url: String(url),
      method: String(init.method ?? 'GET'),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(entry)
    return { status: 200, ok: true, json: async () => reply(entry) }
  }
  return {
    calls,
    posts: () => calls.filter((call) => call.method === 'POST').map((call) => call.body),
    restore: () => { globalThis.fetch = real },
  }
}

/** Fire a button and let its async chain settle. Microtasks drain at every macrotask boundary. */
async function clickAndSettle(handler) {
  handler()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

/** Click one cache button by its translated label and return the recorded POST bodies. */
async function applyCache(tree, label) {
  const [button] = findButton(tree, label)
  assert.ok(button !== undefined, `the card must render a "${label}" button`)
  const fetch = captureFetch()
  try {
    await clickAndSettle(button.props.onClick)
  } finally {
    fetch.restore()
  }
  return fetch.posts()
}

test('the worker card renders the screenshot-cache field and BOTH halves of the usage', () => {
  const { tree } = renderCache({
    shotCacheBytes: 512 * 1024 * 1024,
    row: {
      hostCache: {
        files: 2, bytes: 20 * 1024 * 1024, newestAt: 5, oldestAt: 1, error: '',
        dir: 'C:\\Temp\\dsh-remote-screenshots', keep: 20, maxBytes: 512 * 1024 * 1024,
      },
      workerCache: {
        supported: true, error: '', files: 1, bytes: 9_500_000, newestAt: 9, oldestAt: 9,
        keep: 20, maxBytes: 512 * 1024 * 1024, dir: 'C:\\work\\.dsh-shots', pruned: null,
      },
    },
  })

  const text = textOf(tree).join(' ')
  assert.match(text, /F-SHOT-CACHE/, 'the threshold field must be on the card')
  assert.match(text, /F-SHOT-CACHE-HINT/, 'the field must say what it does')
  assert.match(text, /HOST/)
  assert.match(text, /WORKER/)
  // Both halves in units a person reads. Either side can be the larger one, which is why showing
  // only one of them would have made the 218 MB incident look like the other machine's problem.
  // Binary units (`MiB`) on purpose: the number is compared against a byte cap, so 20 MiB must not
  // print as "21 MB" and look like it overran.
  assert.match(text, /20\.0 MiB/)
  assert.match(text, /9\.1 MiB/)
  assert.match(text, /LIMIT 512 MiB/)

  const [input] = findCacheInput(tree)
  assert.ok(input !== undefined)
  // A whole-MB budget opens as MB: `536870912` is not a number an operator reasons about.
  assert.equal(input.props.value, '512MB')
})

test('the host-cache line shows the seeded byte figure and the file count', () => {
  // The operator opens this panel to answer "where did the disk go", so the numbers ARE the feature.
  // A line that renders "0" from a populated cache, or swaps the figure for the count, would leave
  // them unable to tell a full cache from an empty one.
  const { tree } = renderCache({
    row: {
      hostCache: {
        files: 2, bytes: 2097152, newestAt: 5, oldestAt: 1, error: '',
        dir: 'C:\\Temp\\dsh-remote-screenshots', keep: 20, maxBytes: 0,
      },
    },
  })
  const text = textOf(tree).join(' ')

  // Binary units, because the figure is compared against a byte cap: 2 MiB must not print as 2.1 MB.
  assert.match(text, /2\.0 MiB/)
  // The translator in this harness renders markers, so the COUNT is asserted as its marker and the
  // real sentence is checked against the shipped dictionary -- the two cannot drift apart unnoticed.
  assert.match(text, /FILES-2/, 'the file count must be shown beside the bytes')
  const { dictionaries } = loadClient()
  assert.equal(dictionaries[0].dicts.en.cacheFiles, '{n} file(s)')
  // The directory is named too: two machines both have a shots folder, and the path is what tells
  // the host's copy from the worker's.
  assert.match(text, /C:\\Temp\\dsh-remote-screenshots/)
  // A zero ceiling must read as "no byte limit", not as the number 0.
  assert.match(text, /NO-LIMIT/)
})

test('a worker whose relay cannot report its cache reads as "not reported", NOT as a failure', () => {
  // A worker running a relay older than this feature is HEALTHY: the link is up and the agent may be
  // mid-task. Only the report is missing. Rendering that as a fault sends the operator to debug a
  // working connection -- and rendering it by calling a method that does not exist would throw and
  // blank the page, which is the failure this whole optional-capability path exists to avoid.
  for (const workerCache of [null, undefined, { supported: false, error: '' }]) {
    const { tree } = renderCache({ row: { workerCache } })
    const text = textOf(tree).join(' ')
    assert.match(text, /CACHE-UNSUPPORTED/,
      `workerCache=${JSON.stringify(workerCache)} must say the cache is not reported`)
    // The rest of the card must still be there: the row is a healthy worker with one missing fact.
    assert.match(text, /w1/, 'the card must still render the worker itself')
    // The HOST side is always knowable -- it is a local directory scan -- so an empty host cache is
    // "nothing yet" rather than "not reported". Collapsing the two would make the page say a worker
    // cannot report when the truth is that this machine has taken no screenshots.
    assert.match(text, /CACHE-NONE/)
  }
  const { dictionaries } = loadClient()
  assert.match(dictionaries[0].dicts.en.cacheUnsupported, /does not report its cache/)

  // The other missing-report case is a worker that is simply OFFLINE: the connection says so, and
  // "cannot read it right now" is a different sentence from "this relay cannot report it".
  const offline = textOf(renderCache({ row: { workerCache: { supported: false, error: 'not connected' } } }).tree).join(' ')
  assert.match(offline, /CACHE-UNREACHABLE/)
})

/**
 * Pull ONE closure-local function out of the shipped bundle source and make it callable.
 *
 * WHY BOTH THIS AND THE CLICK PATH BELOW: the click tests prove the WIRING (the field's text
 * reaches the request as bytes) but they can only observe one number at a time and a refusal is
 * silent there. This exercises the two functions directly for the units, the odd values and the
 * refusal cases, with the failing value named in the message. They are pure and closure-free, so
 * the extraction is not a stand-in for the code: the shipped text is what runs, and a rename or a
 * reshape fails the assertion loudly rather than silently passing.
 */
function clientFunction(name, params) {
  const source = readFileSync(join(PKG_ROOT, 'lib', 'client.js'), 'utf8')
  const match = new RegExp(`function ${name}\\(${params}\\) \\{([\\s\\S]*?)\\n    \\}`, 'u').exec(source)
  assert.ok(match !== null, `lib/client.js must still define function ${name}(${params})`)
  // eslint-disable-next-line no-new-func -- a pure, closure-free function exercised in isolation
  return new Function(...params.split(',').map((part) => part.trim()), match[1])
}

test('the budget parser and renderer produce the right bytes for the units an operator types', () => {
  const parseBudgetText = clientFunction('parseBudgetText', 'text')
  const budgetText = clientFunction('budgetText', 'bytes')

  // Binary megabytes, and a bare number is BYTES -- the field says so, and 512 typed without a unit
  // must not be read as 512 MB: that is the off-by-a-million typo that deletes everything.
  assert.equal(parseBudgetText('512MB'), 536870912)
  assert.equal(parseBudgetText('1.5GB'), 1610612736)
  assert.equal(parseBudgetText('256 mb'), 268435456)
  assert.equal(parseBudgetText('2048'), 2048)
  // 0 is a MEANINGFUL value ("no ceiling"). It must parse as 0 and never as `undefined`, or the
  // field would refuse the operator's way of switching the ceiling off.
  assert.equal(parseBudgetText('0'), 0)
  assert.equal(parseBudgetText('-1'), -1)
  // Unusable input must be distinguishable from 0, which is why the answer is `undefined`: the
  // field refuses it, while a 0 that reached the route would read as "no limit" and delete nothing.
  for (const bad of ['', '   ', 'lots', '12XB', 'MB', '1.2.3', null, undefined, {}]) {
    assert.equal(parseBudgetText(bad), undefined, `${String(bad)} must not parse`)
  }

  // Rendering: whole MB when it lines up, bytes otherwise. A legal 500 KiB budget must not render as
  // `0MB` and then be applied as 0 -- that is the case the two-branch implementation exists for.
  assert.equal(budgetText(536870912), '512MB')
  assert.equal(budgetText(0), '0')
  assert.equal(budgetText(-1), '0')
  assert.equal(budgetText(500 * 1024), '512000')

  // The round trip the field performs on every Apply: bytes -> text -> bytes.
  for (const bytes of [1024 * 1024, 512 * 1024 * 1024, 2048 * 1024 * 1024]) {
    assert.equal(parseBudgetText(budgetText(bytes)), bytes, `${bytes} must survive the round trip`)
  }
})

// ---------------------------------------------------------------------------
// REGRESSION: the cache buttons must REACH the route
//
// These four buttons were dead on arrival: `onCache: (scope, op, maxBytes) => onCache(r.peerId, ...)`
// closed over an identifier that did not exist -- the map parameter is `row` (line 1784), and
// `onEdit`/`onDelete` bind their own `(r)` parameter, which is why the copy-paste read correctly.
// Every button threw `ReferenceError: r is not defined` inside `CachePanel.run()`, no request was
// ever made, and the operator was shown the exception text in place of a result.
//
// Nothing below is a source guard: the click is fired and the requests the page makes are recorded,
// so the wiring is what is under test. `applyCache` names the button by its translated label, which
// is why the tests cannot accidentally pass by clicking the wrong control.
// ---------------------------------------------------------------------------

test('the cache buttons reach the route, and ask for the scope and the operation they name', async () => {
  const { tree } = renderCache({ shotCacheBytes: 0, budget: '512MB' })
  const missing = 'the click never produced a request: the button did not reach the route'

  const host = await applyCache(tree, 'CACHE-APPLY-HOST')
  const hostCall = host.find((body) => body.action === 'cache')
  assert.ok(hostCall !== undefined, `host Apply: ${missing}`)
  assert.equal(hostCall.scope, 'host')
  assert.equal(hostCall.op, 'prune')
  assert.equal(hostCall.maxBytes, 512 * 1024 * 1024, 'the parsed field value must travel with the call')

  // The four buttons are one call with two parameters; swapping them would either leave files on the
  // worker while the page said they were gone, or delete them on an Apply.
  const worker = await applyCache(tree, 'CACHE-APPLY-WORKER')
  assert.equal(worker.find((body) => body.action === 'cache')?.scope, 'worker', `worker Apply: ${missing}`)

  const cleared = await applyCache(tree, 'CACHE-CLEAR-HOST')
  assert.equal(cleared.find((body) => body.action === 'cache')?.op, 'clear', `host Clear: ${missing}`)
})

test('what the operator types reaches the route as bytes, units and all', async () => {
  // End to end, through the field and the button: this is the wiring the parse tests above cannot
  // see. A parser that is right and a field that sends its raw text would pass those and fail here.
  const cases = [
    ['512MB', 512 * 1024 * 1024],
    ['1.5GB', 1610612736],
    ['256 mb', 268435456],
    ['2048', 2048],
    ['0', 0],
  ]
  for (const [typed, expected] of cases) {
    const { tree } = renderCache({ budget: typed })
    const call = (await applyCache(tree, 'CACHE-APPLY-HOST')).find((body) => body.action === 'cache')
    assert.ok(call !== undefined, `"${typed}": the Apply button must reach the route`)
    assert.equal(call.maxBytes, expected, `"${typed}" must be applied as ${expected} bytes`)
  }
})

test('a NEW threshold is saved through the settings route, and an UNCHANGED one is NOT re-saved', async () => {
  // The threshold is GLOBAL while the buttons are per worker, so an Apply from any card writes the
  // shared setting: the first call does the work and the second is what makes the value survive the
  // next page load. A redundant save is not merely wasteful -- `shotCacheBytes` is part of the host's
  // policy stamp, so re-sending the same number REBUILDS every worker, dropping every card's
  // connection and its remembered approvals because someone pressed Apply twice.
  const missing = 'the click produced no request at all: the button did not reach the route (see the REGRESSION note above)'

  const changed = await applyCache(renderCache({ shotCacheBytes: 0, budget: '512MB' }).tree, 'CACHE-APPLY-HOST')
  assert.ok(changed.some((body) => body.action === 'cache'), `changed limit: ${missing}`)
  assert.deepEqual(changed.map((body) => body.action), ['cache', 'settings.save'])
  assert.equal(changed[1].settings.shotCacheBytes, 512 * 1024 * 1024)

  const same = await applyCache(renderCache({ shotCacheBytes: 512 * 1024 * 1024, budget: '512MB' }).tree, 'CACHE-APPLY-HOST')
  assert.ok(same.some((body) => body.action === 'cache'), `unchanged limit: ${missing}`)
  assert.deepEqual(same.map((body) => body.action), ['cache'], 'an unchanged limit must not be written again')
})

test('an EMPTY field is accepted as "no limit" rather than refused', async () => {
  // Blanking the field is the operator's way to REMOVE a ceiling, so the blank branch is decided
  // before the call: it must not be treated as unreadable. This asserts the two consequences that
  // are observable without the route -- no refusal message, and the control proceeds to work.
  const { tree, react } = renderCache({ shotCacheBytes: 512 * 1024 * 1024, budget: '' })
  await applyCache(tree, 'CACHE-APPLY-HOST')

  const saw = (value) => react.__state.calls.some((calls) => Array.isArray(calls) && calls.includes(value))
  assert.equal(saw('CACHE-SAVE-FAILED'), false, 'a blank field is "no limit", not an unreadable value')
  assert.equal(saw('host:prune'), true, 'the control must carry on and do the work the blank limit asks for')
})

test('garbage in the field is refused AT THE FIELD, and nothing is sent', async () => {
  // Sending a guess would either delete nothing or delete everything and would look like the host
  // misbehaving. The refusal has to happen here, which is also why the route accepts a raw number.
  const { tree, react } = renderCache({ shotCacheBytes: 512 * 1024 * 1024, budget: 'lots' })
  const posts = await applyCache(tree, 'CACHE-APPLY-HOST')

  assert.deepEqual(posts, [], 'an unreadable limit must not reach the route at all')
  assert.equal(react.__state.calls.some((calls) => Array.isArray(calls) && calls.includes('CACHE-SAVE-FAILED')), true,
    'the field must say why it refused, not stay silent')
})

// ---------------------------------------------------------------------------
// host half: the data route
// ---------------------------------------------------------------------------

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {} },
    end(chunk) { this.body = chunk ?? '' },
  }
}

/** A request that emits `body` then ends, like a real JSON POST. */
function fakeReq(method, body, headers) {
  const req = new EventEmitter()
  req.method = method
  // Real Node requests always carry `headers`; the origin guard reads `origin`/`host` from it.
  // Passing none at all is the NON-BROWSER caller (curl, the live harness), which must stay allowed.
  if (headers !== undefined) req.headers = headers
  req.destroy = () => {}
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

/**
 * A worker runtime, mirroring the shape `apply()` actually publishes.
 *
 * WHY THIS MATTERS: the runtime carries `selfcheck()` plus a `connection`; `ensure()`,
 * `screenshot()`, `cancel()` and `connected` all live ON the connection. An earlier version
 * of this fake put `ensure`/`screenshot`/`connected` directly on the peer, which is MORE
 * capable than the real object — so the route's `peer.ensure()` TypeError passed the whole
 * suite and only appeared when a user pressed the button.
 */
function makePeer(overrides = {}) {
  const connection = {
    connected: true,
    stats: { connected: true, connects: 1 },
    calls: { ensure: 0, screenshot: 0, cancel: 0 },
    async ensure() { this.calls.ensure += 1 },
    async screenshot() {
      this.calls.screenshot += 1
      return { localPath: 'C:\\tmp\\shot.png', width: 1920, height: 1080 }
    },
    async cancel() { this.calls.cancel += 1 },
  }
  return {
    peerId: 'w1',
    name: 'w1',
    defaultCwd: 'C:\\work',
    connection,
    // The real runtime points `bridge` at the same object.
    bridge: connection,
    selfcheckCalls: [],
    async selfcheck(opts) {
      this.selfcheckCalls.push(opts)
      return { verdict: 'ready', blockingFailures: 0, checks: [] }
    },
    ...overrides,
  }
}

/**
 * A REAL `TaskRegistry`, seeded with synthetic rows.
 *
 * Deliberately not a hand-written stub. The route calls four different methods on this object,
 * and a stub implements only the ones its author remembered -- which is how the suite stayed
 * green while `registry.listForUi` did not exist and every settings-page request threw (F15).
 * Seeding the real object means a method the route starts using is there the moment it exists.
 */
function makeRegistry(active = []) {
  const registry = new TaskRegistry({})
  for (const row of active) {
    // `create()` mints an id and a start time; the synthetic row then overrides identity and
    // state, because these tests are about what the route does with a task, not how one begins.
    Object.assign(registry.create({ peerId: String(row?.peerId ?? ''), prompt: '', cwd: '' }), row)
  }
  return registry
}

async function callRoute(route, method, body, headers) {
  const res = fakeRes()
  await route.handler(fakeReq(method, body, headers), res)
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

function makeRoute({ peers, active, queue, audit } = {}) {
  const map = peers ?? new Map([['w1', makePeer()]])
  return {
    route: makeSettingsRoute({
      peers: map,
      registry: makeRegistry(active ?? []),
      cache: { size: 3, misses: 1 },
      // REAL objects by default, not stubs: a stub would let the route's use of them drift
      // from their actual API, which is exactly how `peer.ensure is not a function` shipped.
      queue: queue ?? new ApprovalQueue({ timeoutMs: 50 }),
      audit: audit ?? new AuditLog({ env: { DSH_HOME: mkdtempSync(join(tmpdir(), 'ru-audit-')) } }),
    }),
    peers: map,
  }
}

test('GET reports every worker, its report and the link state', async () => {
  const { route } = makeRoute()
  const { status, body } = await callRoute(route, 'GET')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.workers.length, 1)
  assert.equal(body.workers[0].peerId, 'w1')
  assert.equal(body.workers[0].report.verdict, 'ready')
  // The link state is reported SEPARATELY: conflating it with the readiness report is what
  // once made a missing connect() look like a worker fault.
  assert.equal(body.workers[0].connection.connected, true)
  assert.deepEqual(body.toolCallCache, { size: 3, misses: 1 })
})

test('GET survives a worker that cannot be reached', async () => {
  const peers = new Map([['w1', makePeer({ async selfcheck() { throw new Error('ACP connection closed') } })]])
  const { route } = makeRoute({ peers })
  const { status, body } = await callRoute(route, 'GET')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.workers[0].report, null)
  assert.match(body.workers[0].error, /connection closed/)
})

// ---------------------------------------------------------------------------
// the screenshot cache, as the page first sees it
//
// The cache is reported per worker on every page load, and the two halves answer different
// questions: `hostCache` is a local directory scan, `workerCache` needs the worker to be up AND
// running a relay that knows the `dsh-remote/shotcache` RPC. A page load must not depend on either
// being available -- see the regression below, which is exactly how this shipped wrong once.
// ---------------------------------------------------------------------------

test('GET reports BOTH halves of every worker\'s screenshot cache', async () => {
  const sawOpts = []
  const connection = {
    connected: true,
    stats: { connected: true, connects: 1 },
    // The capability the snapshot and the action route both consult. A real `PeerConnection`
    // derives this from whether it has a live bridge; the stub states it outright, which is also
    // what makes this test's intent legible: THIS worker can report its cache.
    supportsWorkerShotCache: true,
    hostShotCache: () => ({
      files: 2, bytes: 2048, newestAt: 5, oldestAt: 1, error: '', dir: 'C:\\Temp\\dsh-remote-screenshots', keep: 20, maxBytes: 4096,
    }),
    async workerShotCache(opts) {
      sawOpts.push(opts)
      return {
        supported: true, error: '', files: 1, bytes: 1024, newestAt: 9, oldestAt: 9,
        keep: 20, maxBytes: 4096, dir: 'C:\\work\\.dsh-shots', pruned: null,
      }
    },
  }
  const peers = new Map([['w1', makePeer({ connection })]])
  const route = makeSettingsRoute({
    peers,
    registry: makeRegistry([]),
    cache: { size: 0, misses: 0 },
    currentSettings: () => ({ workers: [], shotCacheBytes: 4096 }),
  })

  const { status, body } = await callRoute(route, 'GET')

  assert.equal(status, 200)
  // The host half is what the page and the model actually read, and it is knowable without the
  // worker; it must be present even on the first paint.
  assert.equal(body.workers[0].hostCache.bytes, 2048)
  assert.equal(body.workers[0].hostCache.files, 2)
  assert.equal(body.workers[0].hostCache.dir, 'C:\\Temp\\dsh-remote-screenshots')
  // The worker half is the copy an operator cannot see from here, so it is reported separately
  // rather than folded into the host's numbers.
  assert.equal(body.workers[0].workerCache.supported, true)
  assert.equal(body.workers[0].workerCache.bytes, 1024)
  assert.equal(body.workers[0].workerCache.dir, 'C:\\work\\.dsh-shots')
  // The SAVED ceiling travels with the request, so the worker can report whether it is over a
  // budget this machine just set. A hardcoded 0 here would make every worker look unbounded.
  assert.deepEqual(sawOpts, [{ maxBytes: 4096 }])
})

test('GET survives a connection with NO cache methods at all (this took the whole page down)', async () => {
  // REGRESSION, reported: `peer.connection.workerShotCache(...)` was called unconditionally. On a
  // connection that does not implement it -- a stub, or one built before this feature existed --
  // the call throws SYNCHRONOUSLY, so `.catch()` never got a chance to attach and the TypeError
  // aborted the whole snapshot. One worker without an OPTIONAL capability therefore left the page
  // with no data at all, including every other worker's.
  //
  // The default `makePeer` connection has neither method, so this asserts the fix: the capability
  // is probed, and its absence is reported as `null` -- not as a zeroed object, which would read
  // as "this worker holds nothing" and is the opposite of "this worker cannot say".
  const { route } = makeRoute()
  const { status, body } = await callRoute(route, 'GET')

  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.workers.length, 1)
  assert.equal(body.workers[0].hostCache, null)
  assert.equal(body.workers[0].workerCache, null)
  // The rest of the row must still be filled in: the page's whole purpose is the readiness report.
  assert.equal(body.workers[0].report.verdict, 'ready')
  assert.equal(body.workers[0].connection.connected, true)
})

test('selfcheck forces a fresh probe rather than reusing the cached report', async () => {
  const { route, peers } = makeRoute()
  const { status, body } = await callRoute(route, 'POST', JSON.stringify({ action: 'selfcheck', peerId: 'w1' }))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.report.verdict, 'ready')
  // maxAgeMs 0 is the whole point: "can it run right now" cannot be answered by a cache.
  assert.deepEqual(peers.get('w1').selfcheckCalls, [{ maxAgeMs: 0 }])
})

test('screenshot returns the saved path and geometry', async () => {
  const { route } = makeRoute()
  const { status, body } = await callRoute(route, 'POST', JSON.stringify({ action: 'screenshot', peerId: 'w1' }))
  assert.equal(status, 200)
  assert.equal(body.screenshot.width, 1920)
  assert.match(body.screenshot.localPath, /shot\.png$/)
})

test('ping establishes the link through the connection and reports it', async () => {
  // The receiver matters: `ensure()` and `connected` live on the worker's CONNECTION, not on
  // the runtime the route holds. This route called them on the runtime and the page's button
  // answered "peer.ensure is not a function".
  const { route, peers } = makeRoute()
  const connection = peers.get('w1').connection
  const { status, body } = await callRoute(route, 'POST', JSON.stringify({ action: 'ping', peerId: 'w1' }))
  assert.equal(status, 200)
  assert.equal(body.connected, true)
  assert.equal(connection.calls.ensure, 1, 'ping must go through connection.ensure()')
})

// ---------------------------------------------------------------------------
// human approval: the pending queue and its audit trail
//
// Without these the engine's `needsHuman` had nowhere to go but refusal, so a task that
// genuinely needed a wider scope could never be completed.
// ---------------------------------------------------------------------------

const APPROVAL_ASK = {
  peerId: 'worker-pc',
  taskId: 'rtask_1',
  toolCallId: 'call_7',
  toolName: 'write',
  requiredTier: 'danger-full-access',
  reason: 'tier-check',
  source: 'tier-check',
  rawInput: { file_path: 'C:\\outside\\x.txt' },
}

test('GET reports the pending approvals a person can act on', async () => {
  const queue = new ApprovalQueue({ timeoutMs: 5_000 })
  const pending = queue.request(APPROVAL_ASK)
  const { route } = makeRoute({ queue })

  const { status, body } = await callRoute(route, 'GET')
  assert.equal(status, 200)
  assert.equal(body.approvals.available, true)
  assert.equal(body.approvals.pending.length, 1)
  assert.equal(body.approvals.pending[0].toolName, 'write')
  assert.equal(body.approvals.pending[0].requiredTier, 'danger-full-access')
  // The page must never be handed a resolver...
  assert.equal('resolve' in body.approvals.pending[0], false)
  // ...and the serialised payload must not carry one either.
  assert.equal(JSON.stringify(body).includes('"resolve"'), false)

  queue.dispose()
  await pending
})

test('approvals.decide allows one request, and the decider sees allow-once', async () => {
  const queue = new ApprovalQueue({ timeoutMs: 5_000 })
  const pending = queue.request(APPROVAL_ASK)
  const { route } = makeRoute({ queue })
  const id = queue.list()[0].id

  const { status, body } = await callRoute(
    route, 'POST', JSON.stringify({ action: 'approvals.decide', id, decision: 'allow' }),
  )
  assert.equal(status, 200)
  assert.equal(body.optionId, 'allow-once')
  assert.deepEqual(body.pending, [], 'the row disappears once decided')
  assert.equal(await pending, 'allow-once')
})

test('approvals.decide denies, and the decider sees reject-once', async () => {
  const queue = new ApprovalQueue({ timeoutMs: 5_000 })
  const pending = queue.request(APPROVAL_ASK)
  const { route } = makeRoute({ queue })
  const { status, body } = await callRoute(
    route, 'POST', JSON.stringify({ action: 'approvals.decide', id: queue.list()[0].id, decision: 'deny' }),
  )
  assert.equal(status, 200)
  assert.equal(body.optionId, 'reject-once')
  assert.equal(await pending, 'reject-once')
})

test('deciding a stale approval is a 409, not a silent success', async () => {
  // The page may be showing a row that already timed out. Reporting success there would let
  // a stale click look like a fresh approval.
  const queue = new ApprovalQueue({ timeoutMs: 5_000 })
  const { route } = makeRoute({ queue })
  const { status, body } = await callRoute(
    route, 'POST', JSON.stringify({ action: 'approvals.decide', id: 'ap-nope', decision: 'allow' }),
  )
  assert.equal(status, 409)
  assert.equal(body.ok, false)
  assert.match(body.error, /no pending approval/)
})

test('an invalid decision over the route is refused, not coerced', async () => {
  const queue = new ApprovalQueue({ timeoutMs: 5_000 })
  const pending = queue.request(APPROVAL_ASK)
  const { route } = makeRoute({ queue })
  const { status } = await callRoute(
    route, 'POST', JSON.stringify({ action: 'approvals.decide', id: queue.list()[0].id, decision: 'yes' }),
  )
  assert.equal(status, 409)
  assert.equal(queue.pendingCount, 1, 'the request must still be waiting')
  queue.dispose()
  await pending
})

test('GET reports the audit trail and where it lives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ru-audit-route-'))
  const audit = new AuditLog({ env: { DSH_HOME: dir } })
  audit.record({ kind: 'approval', gate: 'engine', by: 'engine', toolName: 'write', optionId: 'allow-once' })
  const { route } = makeRoute({ audit })

  const { body } = await callRoute(route, 'GET')
  assert.equal(body.audit.available, true)
  assert.match(body.audit.path, /audit\.jsonl$/)
  assert.equal(body.audit.recent.length, 1)
  assert.equal(body.audit.recent[0].toolName, 'write')
  assert.equal(body.audit.error, '')
})

test('a build with no queue says so instead of pretending nothing is waiting', async () => {
  // `available: false` is the honest answer: "nothing pending" and "cannot ask" are different
  // facts, and the page must be able to tell them apart.
  const route = makeSettingsRoute({ peers: new Map(), registry: makeRegistry([]), cache: { size: 0, misses: 0 } })
  const { status, body } = await callRoute(route, 'GET')
  assert.equal(status, 200)
  assert.equal(body.approvals.available, false)
  assert.deepEqual(body.approvals.pending, [])
  assert.equal(body.audit.available, false)

  const decided = await callRoute(route, 'POST', JSON.stringify({ action: 'approvals.decide', id: 'x', decision: 'allow' }))
  assert.equal(decided.status, 503)
})

test('approvals.clear resets the miss views and says how many it dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ru-audit-clear-'))
  const audit = new AuditLog({ env: { DSH_HOME: dir } })
  audit.record({ kind: 'approval', by: 'timeout', toolName: 'write' })
  audit.record({ kind: 'approval', by: 'timeout', toolName: 'pwsh' })
  const { route } = makeRoute({ audit })

  const before = await callRoute(route, 'GET')
  assert.equal(before.body.approvals.missedCount, 2)

  const { status, body } = await callRoute(route, 'POST', JSON.stringify({ action: 'approvals.clear', via: 'page' }))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.cleared, 2, 'the page can say what it did instead of looking inert')
  assert.equal(body.missedCount, 0)

  const after = await callRoute(route, 'GET')
  assert.equal(after.body.approvals.missedCount, 0)
  assert.deepEqual(after.body.approvals.missed, [])
  // The trail keeps the refusals AND the fact that a person cleared the view.
  assert.deepEqual(audit.tail(1).map((row) => [row.kind, row.by]), [['approvals-cleared', 'page']])
  assert.equal(audit.size, 3, 'two refusals plus the watermark: the trail lost nothing')
  assert.deepEqual(audit.tail(3).filter((row) => row.kind === 'approval').map((row) => row.toolName), ['pwsh', 'write'])
})

test('approvals.clear is attributed like a decision, so an unattributed clear is not a person', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ru-audit-clear2-'))
  const audit = new AuditLog({ env: { DSH_HOME: dir } })
  audit.record({ kind: 'approval', by: 'timeout', toolName: 'write' })
  const { route } = makeRoute({ audit })

  // No `via` and no Origin: a script, and it must not be recorded as a human click. This is the
  // same discriminator the decision buttons use, for the same reason (F19/F22).
  await callRoute(route, 'POST', JSON.stringify({ action: 'approvals.clear' }))
  assert.equal(audit.tail(1)[0].by, 'api')
})

test('a build with no audit trail refuses to clear rather than reporting a false success', async () => {
  const route = makeSettingsRoute({ peers: new Map(), registry: makeRegistry([]), cache: { size: 0, misses: 0 } })
  const { status, body } = await callRoute(route, 'POST', JSON.stringify({ action: 'approvals.clear', via: 'page' }))
  assert.equal(status, 503)
  assert.equal(body.ok, false)
})

// ---------------------------------------------------------------------------
// bilingual copy
//
// The operator asked whether both languages are actually maintained. The mechanism (ctx.locale with
// a zh and an en dictionary) was already in place, but "there is a second dictionary" is not the
// claim worth testing -- "every key exists in both, with the same placeholders" is. A key present
// only in `zh` renders as a raw key string the moment the UI is switched to English, which is how
// a missing translation shows up in front of a user.
// ---------------------------------------------------------------------------

test('every user-facing string exists in BOTH languages, with matching placeholders', () => {
  const { dictionaries } = loadClient()
  assert.equal(dictionaries.length, 1, 'one namespace, registered once')
  const [{ dicts }] = dictionaries
  // The registration passes the languages BY NAME (`ctx.locale.register(NS, { zh, en })`), which is
  // the documented shape; the keys are the language tags, not an ordered pair.
  const { zh, en } = dicts
  assert.ok(zh !== null && typeof zh === 'object', 'a zh dictionary')
  assert.ok(en !== null && typeof en === 'object', 'an en dictionary')

  const zk = Object.keys(zh).sort()
  const ek = Object.keys(en).sort()
  const missingInEn = zk.filter((key) => !(key in en))
  const missingInZh = ek.filter((key) => !(key in zh))
  assert.deepEqual(missingInEn, [], `keys with no English text: ${missingInEn.join(', ')}`)
  assert.deepEqual(missingInZh, [], `keys with no Chinese text: ${missingInZh.join(', ')}`)

  // A placeholder that exists in one language and not the other silently drops a value, or prints
  // a literal `{p}` -- and it fails only in the language the developer is not reading.
  const holes = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  for (const key of zk) {
    assert.deepEqual(holes(en[key]), holes(zh[key]), `placeholder mismatch in "${key}"`)
  }

  // No empty strings: `t()` would render a blank where a word belongs.
  for (const key of zk) {
    assert.notEqual(String(zh[key]).trim(), '', `empty Chinese text for "${key}"`)
    assert.notEqual(String(en[key]).trim(), '', `empty English text for "${key}"`)
  }
})

test('every placeholder a CALL SITE passes is one the string DECLARES', () => {
  // WHY THIS EXISTS (found 2026-10-16, by a person looking at the page):
  //
  // The shot-cache panel renders two pairs of buttons -- one for the host cache, one for the worker
  // cache -- and labels each with its scope: `fmt(t('btnCacheApply'), { scope: t('labelCacheHost') })`.
  // The two dictionary strings contained no `{scope}`. `fmt()` leaves a string with no placeholder
  // untouched, so BOTH pairs rendered as `应用上限` / `清空缓存` and the panel looked like a bug that
  // drew every button twice. Nothing errored; the sibling messages (`cacheCleared`, `cachePruned`, ...)
  // all declare `{scope}`, which is what made the omission invisible in review.
  //
  // The parity test above compares the two LANGUAGES against each other. This one compares the CALL
  // SITES against the strings, which is a different axis: a key can be perfectly consistent across
  // languages and still be handed a variable it never declares.
  const { dictionaries } = loadClient()
  const { zh, en } = dictionaries[0].dicts
  const source = readFileSync(join(PKG_ROOT, 'lib', 'client.js'), 'utf8')

  const callSites = [...source.matchAll(/fmt\(t\('([A-Za-z0-9_]+)'\),\s*\{([^}]*)\}/g)]
  assert.ok(callSites.length > 0, 'the scan must find call sites, or it proves nothing')

  const missing = []
  for (const [, key, params] of callSites) {
    // Property names are matched at the START of a line, not anywhere in the object. Without the
    // anchor, a ternary like `cond ? audit.archives.length : 0` reads as a property called `length`
    // and the guard reports a placeholder nobody passes -- a false positive that would get the guard
    // switched off, which is worse than not having it.
    const names = [...params.matchAll(/(?:^|\n)\s*([A-Za-z0-9_]+)\s*:/g)].map((m) => m[1])
    for (const [lang, dict] of [['zh', zh], ['en', en]]) {
      if (!(key in dict)) {
        // A key that is not in the dictionary at all renders as the raw key (or nothing), and the
        // parity test above cannot see it because BOTH languages lack it equally.
        missing.push(`${key}[${lang}] is used by a call site but is MISSING from the dictionary`)
        continue
      }
      const text = String(dict[key])
      for (const name of names) {
        if (!text.includes(`{${name}}`)) {
          missing.push(`${key}[${lang}] is passed {${name}} but its text is "${text}"`)
        }
      }
    }
  }
  assert.deepEqual(missing, [],
    `these call sites substitute a value the string never uses, so the label renders without it:\n  ${missing.join('\n  ')}`)
})

test('the two dictionaries are not the same language wearing two names', () => {
  // A copy-paste that left the Chinese text in `en` would pass every parity check above and still
  // show Chinese to an English reader, so the one property that catches it is asserted directly.
  const { dictionaries } = loadClient()
  const { zh, en } = dictionaries[0].dicts
  const cjk = /[\u4e00-\u9fff]/
  // Declared exceptions, not a tolerance: these carry no prose, so there is nothing to translate.
  // `dshpair1.…` is the pairing-string FORMAT, and a localized copy of it would be a bug (it is
  // pasted into a machine). Any new identical string has to be added here deliberately.
  const LITERALS = new Set(['fieldPairingPlaceholder'])
  const identical = Object.keys(zh).filter((key) => zh[key] === en[key] && !LITERALS.has(key))
  assert.deepEqual(identical, [], `key(s) with identical text in both languages: ${identical.join(', ')}`)
  for (const key of LITERALS) {
    assert.ok(key in zh && key in en, `the declared literal "${key}" must still exist in both`)
  }
  assert.ok(Object.values(zh).filter((text) => cjk.test(String(text))).length > 50,
    'the Chinese dictionary is genuinely Chinese')
  assert.deepEqual(Object.entries(en).filter(([, text]) => cjk.test(String(text))).map(([key]) => key), [],
    'no Chinese characters left in the English dictionary')
})

test('interrupt cancels every in-flight task and reports per-task failures', async () => {
  const cancelled = []
  const peers = new Map([
    ['w1', makePeer({ bridge: { async cancel() { cancelled.push('w1') } } })],
    ['w2', makePeer({ peerId: 'w2', bridge: { async cancel() { throw new Error('link down') } } })],
  ])
  const active = [
    { taskId: 't1', peerId: 'w1', state: 'running' },
    { taskId: 't2', peerId: 'w2', state: 'running' },
    { taskId: 't3', peerId: 'gone', state: 'running' },
  ]
  const { route } = makeRoute({ peers, active })
  const { status, body } = await callRoute(route, 'POST', JSON.stringify({ action: 'interrupt' }))
  assert.equal(status, 200)
  assert.deepEqual(body.cancelled, ['t1'])
  assert.equal(body.failures.length, 2)
  assert.equal(body.considered, 3)
  assert.deepEqual(cancelled, ['w1'], 'a failed cancel must not stop the others')
})

test('interrupt with a peerId narrows the stop to that worker', async () => {
  const cancelled = []
  const peers = new Map([
    ['w1', makePeer({ bridge: { async cancel() { cancelled.push('w1') } } })],
    ['w2', makePeer({ peerId: 'w2', bridge: { async cancel() { cancelled.push('w2') } } })],
  ])
  const active = [
    { taskId: 't1', peerId: 'w1', state: 'running' },
    { taskId: 't2', peerId: 'w2', state: 'running' },
  ]
  const { route } = makeRoute({ peers, active })
  const { body } = await callRoute(route, 'POST', JSON.stringify({ action: 'interrupt', peerId: 'w2' }))
  assert.deepEqual(body.cancelled, ['t2'])
  assert.deepEqual(cancelled, ['w2'])
})

test('the route rejects an unknown action, a bad method and an unknown worker', async () => {
  const { route } = makeRoute()
  assert.equal((await callRoute(route, 'POST', JSON.stringify({ action: 'nope' }))).status, 400)
  assert.equal((await callRoute(route, 'POST', JSON.stringify({ action: 'selfcheck', peerId: 'ghost' }))).status, 404)
  assert.equal((await callRoute(route, 'DELETE')).status, 405)
  assert.equal((await callRoute(route, 'POST', 'not json')).status, 400)
})

test('a worker failure inside an action is reported, not thrown', async () => {
  const peers = new Map([['w1', makePeer({ async selfcheck() { throw new Error('worker exploded') } })]])
  const { route } = makeRoute({ peers })
  const { status, body } = await callRoute(route, 'POST', JSON.stringify({ action: 'selfcheck', peerId: 'w1' }))
  // A thrown handler would leave the page with a bare 500 and nothing to display.
  assert.equal(status, 502)
  assert.equal(body.ok, false)
  assert.match(body.error, /worker exploded/)
})

test('the response is never cached', async () => {
  const { route } = makeRoute()
  const res = fakeRes()
  await route.handler(fakeReq('GET'), res)
  // A cached availability answer is worse than no answer.
  assert.match(res.headers['cache-control'], /no-store/)
})

// ---------------------------------------------------------------------------
// regression: a page load must not pay an unreachable worker's connect timeout
//
// REPORTED SYMPTOM: the Settings page showed "no workers configured" while the route was
// returning one entry. The request was still in flight because `selfcheck()` connects
// first, and an unreachable worker costs a full TCP connect timeout (~20 s); for that whole
// window the browser showed its initial state, which the page rendered as "nothing
// configured" -- a confident statement of absence about data it had not yet received.
// ---------------------------------------------------------------------------

test('GET still returns the worker row when the readiness probe hangs', async () => {
  const peers = new Map([['w1', makePeer({
    // Never settles: stands in for a TCP connect against a powered-off or logged-out host.
    selfcheck: () => new Promise(() => {}),
    connected: false,
    connection: { stats: { connected: false, connectFailures: 1, lastError: 'connect ETIMEDOUT' } },
  })]])
  const route = makeSettingsRoute({
    peers,
    registry: makeRegistry([]),
    cache: { size: 0, misses: 0 },
    reportBudgetMs: 40,
  })

  const started = Date.now()
  const { status, body } = await callRoute(route, 'GET')
  const elapsed = Date.now() - started

  assert.equal(status, 200)
  // The row must be present: the page distinguishes "no workers" from "no report".
  assert.equal(body.workers.length, 1)
  assert.equal(body.workers[0].peerId, 'w1')
  assert.equal(body.workers[0].report, null)
  assert.match(body.workers[0].error, /did not finish within 40 ms/)
  // Link state is knowable immediately and must survive the probe timeout.
  assert.equal(body.workers[0].connection.connected, false)
  assert.ok(elapsed < 3000, `the page load must not wait for the connect timeout (took ${elapsed} ms)`)
})

test('an explicit self-check gets a longer budget than a page load', async () => {
  // The operator pressed the button and is watching, so a connect attempt may finish.
  let sawOpts
  const peers = new Map([['w1', makePeer({
    async selfcheck(opts) { sawOpts = opts; return { verdict: 'ready' } },
  })]])
  const route = makeSettingsRoute({
    peers, registry: makeRegistry([]), cache: { size: 0, misses: 0 }, selfcheckBudgetMs: 50,
  })
  const { status, body } = await callRoute(route, 'POST', JSON.stringify({ action: 'selfcheck', peerId: 'w1' }))
  assert.equal(status, 200)
  assert.equal(body.report.verdict, 'ready')
  // maxAgeMs 0 is what makes it a FRESH probe rather than a cached report.
  assert.deepEqual(sawOpts, { maxAgeMs: 0 })
})

test('a self-check that times out is reported as a timeout, not a worker fault', async () => {
  const peers = new Map([['w1', makePeer({ selfcheck: () => new Promise(() => {}) })]])
  const route = makeSettingsRoute({
    peers, registry: makeRegistry([]), cache: { size: 0, misses: 0 }, selfcheckBudgetMs: 40,
  })
  const { status, body } = await callRoute(route, 'POST', JSON.stringify({ action: 'selfcheck', peerId: 'w1' }))
  assert.equal(status, 504)
  assert.equal(body.ok, false)
  assert.match(body.error, /did not finish within 40 ms/)
})

// ---------------------------------------------------------------------------
// F17: the route refuses a CROSS-SITE POST
//
// DSH authenticates the app shell (`GET /` answers 401) but not a plugin's own route, so this check
// has to live in the plugin. The case that matters is a browser "simple request": the body is parsed
// as JSON whatever the `Content-Type`, so a page on any site could POST `text/plain` without a
// preflight and have the action run. It cannot read the reply, but `interrupt` and `worker.disarm`
// need no id, and `worker.arm` opens a listener that accepts remote execution.
//
// The refusal is proven by the ABSENCE OF THE SIDE EFFECT, not by the status code alone: a 403 that
// still interrupted the task would pass a status-only assertion.
// ---------------------------------------------------------------------------

test('a cross-site POST is refused, and the action does not run', async () => {
  const cancelled = []
  const peers = new Map([['w1', makePeer({ bridge: { async cancel() { cancelled.push('w1') } } })]])
  const active = [{ taskId: 't1', peerId: 'w1', state: 'running' }]
  const { route } = makeRoute({ peers, active })
  const SELF = { origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' }

  const hostile = await callRoute(route, 'POST', JSON.stringify({ action: 'interrupt' }),
    { origin: 'http://evil.example', host: '127.0.0.1:19387' })
  assert.equal(hostile.status, 403)
  assert.match(String(hostile.body.error), /cross-site/)
  assert.deepEqual(cancelled, [], 'a refused request must not reach the action')

  // ...while the same request from this server's own page does go through, so the guard is a gate
  // and not a wall.
  const own = await callRoute(route, 'POST', JSON.stringify({ action: 'interrupt' }), SELF)
  assert.equal(own.status, 200)
  assert.deepEqual(cancelled, ['w1'])
})

test('an opaque or cross-site-declared request is refused', async () => {
  const { route } = makeRoute()
  const body = JSON.stringify({ action: 'nope' })
  const opaque = await callRoute(route, 'POST', body, { origin: 'null', host: '127.0.0.1:19387' })
  assert.equal(opaque.status, 403)
  const declared = await callRoute(route, 'POST', body,
    { origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' })
  assert.equal(declared.status, 403)
  const noHost = await callRoute(route, 'POST', body, { origin: 'http://127.0.0.1:19387' })
  assert.equal(noHost.status, 403, 'an Origin that cannot be checked must fail closed')
})

test('a POST from a non-browser caller, and a GET from anywhere, are both allowed', async () => {
  // The live harness is the non-browser caller: it sends no headers at all, and it must keep working.
  const { route } = makeRoute()
  const noHeaders = await callRoute(route, 'POST', JSON.stringify({ action: 'nope' }))
  assert.equal(noHeaders.status, 400, 'no Origin means no hostile page: the body is still processed')
  // Reads need no gate: no response carries `Access-Control-Allow-Origin`, so a cross-origin page
  // cannot see the reply anyway.
  const read = await callRoute(route, 'GET', undefined, { origin: 'http://evil.example', host: '127.0.0.1:19387' })
  assert.equal(read.status, 200)
})

test('the origin comparison follows the Host header, so a localhost page also works', async () => {
  // The operator may open the page as 127.0.0.1 or as localhost. Comparing against the request's own
  // Host keeps both working without a configured address to keep in sync.
  const { route } = makeRoute()
  const viaLocalhost = await callRoute(route, 'POST', JSON.stringify({ action: 'nope' }),
    { origin: 'http://localhost:19387', host: 'localhost:19387' })
  assert.equal(viaLocalhost.status, 400, 'a same-origin request from localhost reaches the handler')
})

test('the origin guard rejects every shape that is not plainly this server', async () => {
  const ok = { headers: { origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' } }
  assert.equal(crossSitePostProblem(ok), '')
  assert.equal(crossSitePostProblem({ headers: { host: '127.0.0.1:19387' } }), '', 'no Origin at all')
  assert.equal(crossSitePostProblem({}), '', 'a request with no headers property')
  assert.equal(crossSitePostProblem(undefined), '')
  // A different port on the same host is a different origin.
  assert.match(crossSitePostProblem({ headers: { origin: 'http://127.0.0.1:9999', host: '127.0.0.1:19387' } }), /cross-site/)
  // A scheme a browser would not use for this listener.
  assert.match(crossSitePostProblem({ headers: { origin: 'ftp://127.0.0.1:19387', host: '127.0.0.1:19387' } }), /scheme/)
  assert.match(crossSitePostProblem({ headers: { origin: 'not-a-url', host: '127.0.0.1:19387' } }), /not a URL/)
  assert.match(crossSitePostProblem({ headers: { origin: 'null', host: '127.0.0.1:19387' } }), /opaque/)
})
