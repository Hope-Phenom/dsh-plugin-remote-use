// icon-check.mjs -- reproduce @deepseek-ai/dsh-app-boot's `readPluginMeta()` faithfully
// enough to tell "DSH accepts this manifest" from "DSH throws on it".
//
// The first version of this script used `createRequire().resolve()` and reported ACCEPTED
// while the plugin's icon was visibly NOT rendered. DSH does not use createRequire: it goes
// through `ModuleLoader.fromInternal().resolveSync()` -- Node's ESM resolver -- and it also
// reads the whole locale directory before it ever touches the icon. Both differences matter.
//
// RESOLUTION BASE: a plugin is resolved from the PROFILE directory, not from wherever this
// file lives. `import.meta.resolve()` uses the calling module's location, so the caller must
// place this script inside the profile directory (see tools/README or the invocation in the
// design notes). The header prints the base it is actually using so a wrong placement is
// visible rather than silently misleading.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const specifier = process.argv[2] ?? 'dsh-plugin-remote-use'

const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
const MAX_ICON_BYTES = 256 * 1024
const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
])

const say = (s) => console.log(s)
say(`specifier  : ${specifier}`)
say(`resolve base: ${import.meta.url}`)
say('')

function resolveAsDsh(spec) {
  return fileURLToPath(import.meta.resolve(spec))
}

// --- readPluginMeta, step by step -------------------------------------------
try {
  const englishPath = resolveAsDsh(`${specifier}/locale/en.json`)
  say(`locale/en.json -> ${englishPath}`)

  // dictionariesOf(): EVERY .json in that directory is resolved and validated, so a bad
  // filename or an unexported file fails the whole metadata read -- before the icon.
  const dictionaries = new Map()
  for (const entry of readdirSync(dirname(englishPath), { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue
    const resource = `${specifier}/locale/${entry.name}`
    const language = entry.name.slice(0, -5)
    if (!LANGUAGE_ID.test(language)) throw new Error(`${resource} must use a language id as its filename`)
    const file = resolveAsDsh(resource)
    if (dirname(file) !== dirname(englishPath)) throw new Error(`${resource}: must share the English locale directory`)
    dictionaries.set(language.toLowerCase(), file)
  }
  say(`locale dictionaries: ${[...dictionaries.keys()].join(', ')}`)

  const manifestPath = resolveAsDsh(`${specifier}/package.json`)
  say(`package.json    -> ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  say(`icon declared   -> ${JSON.stringify(manifest.icon)}\n`)

  if (manifest.icon === undefined) {
    say('RESULT: no icon declared -> the inventory falls back to a built-in glyph.')
    process.exit(0)
  }

  // iconOf()
  const icon = manifest.icon
  if (isAbsolute(icon) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon)) throw new Error('icon must be a relative file path')
  const mediaType = ICON_MEDIA_TYPES.get(extname(icon).toLowerCase())
  if (mediaType === undefined) throw new Error('icon must be SVG, PNG, JPEG, or WebP')
  const directory = realpathSync(dirname(manifestPath))
  const file = realpathSync(resolve(directory, icon))
  const local = relative(directory, file)
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('icon must remain inside its manifest directory')
  const stat = statSync(file)
  if (!stat.isFile()) throw new Error('icon must be a regular file')
  if (stat.size > MAX_ICON_BYTES) throw new Error(`icon exceeds 256 KiB`)
  const bytes = readFileSync(file)
  say(`resolved        -> ${file}`)
  say(`mediaType       -> ${mediaType}`)
  say(`bytes           -> ${bytes.length}`)

  // WELL-FORMEDNESS, which iconOf() does NOT check and which failed silently in production:
  // a double hyphen inside an XML comment is illegal, and a malformed SVG is rejected by the
  // browser's <img> decoder. The plugin manager then falls back to its default artwork with
  // nothing logged. DSH reads the bytes; only the browser can say whether they decode.
  const text = bytes.toString('utf8')
  if (mediaType === 'image/svg+xml') {
    let rest = text
    for (;;) {
      const start = rest.indexOf('<!--')
      if (start < 0) break
      const end = rest.indexOf('-->', start + 4)
      if (end < 0) throw new Error('an XML comment is never closed')
      const body = rest.slice(start + 4, end)
      if (body.includes('--')) {
        throw new Error('an XML comment contains a double hyphen, which is ILLEGAL: '
          + `the document is malformed and the browser will refuse to decode it. Near: ${JSON.stringify(body.slice(0, 120))}`)
      }
      rest = rest.slice(0, start) + rest.slice(end + 3)
    }
    say('xml comments    -> well formed (no double hyphen)')
  }

  say(`data URL        -> data:${mediaType};base64,${bytes.toString('base64').slice(0, 24)}...`)
  say('')
  say('RESULT: readPluginMeta would ACCEPT this icon, and the XML is well formed.')
  say('        A manifest-level check cannot prove the BROWSER decodes it; if the plugin')
  say('        manager still shows default artwork, load the data URL in an <img> and watch')
  say('        for its error event.')
} catch (error) {
  say('')
  say(`RESULT: this icon would NOT work -> ${error.message}`)
  say('')
  say('  Two different authorities are involved, and conflating them is what hid this bug:')
  say('    * dsh-app-boot\'s iconOf() reads the bytes and checks path, extension and size.')
  say('      It does NOT parse the file, so a malformed SVG passes it happily.')
  say('    * the BROWSER decodes the data URL in an <img>. A malformed document fails there,')
  say('      and dsh-client-ui-plugin-manager\'s PackageArtwork falls back to its default')
  say('      artwork on the error event, logging nothing.')
  process.exit(1)
}
