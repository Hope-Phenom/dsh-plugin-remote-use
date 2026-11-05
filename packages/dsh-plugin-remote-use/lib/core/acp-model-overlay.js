/**
 * The worker's ACP session model, applied as a plugin-owned `--patch` overlay at launch.
 *
 * WHY A MODEL PIN AT ALL: `dsh-acp`'s `initialize` advertises `promptCapabilities.image` from the
 * CONFIGURED route (`supportsAcpImagePrompts(ctx, provider, model)`), and a wrong or missing id
 * turns image prompts off silently -- also breaking `read_image` inside the worker's own agent
 * (DESIGN 14.1). The capability cannot be switched per session afterwards: the flag is fixed for
 * the connection, so the value has to be in the launch configuration.
 *
 * WHY AN OVERLAY AND NOT A PROFILE EDIT: the plugin's rule is that the operator's profile belongs
 * to the operator (see the sandbox-mediator work). `--patch` is applied AFTER the profile layer, so
 * this file wins without touching `cordis.patch.yml`; clearing the setting simply stops passing
 * it. The trade-off is that the value is not visible in a bare `--dump-config` -- it only appears
 * when the same overlay is passed, which is what the plugin does at launch. The setting itself is
 * shown on the worker's settings page, and the master can see the effect in `initialize`.
 *
 * The file is a YAML LIST of loader patch entries, like every other patch layer.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveDshHome } from './settings-store.js'

/** Name under the plugin's storage directory. */
export const MODEL_OVERLAY_FILENAME = 'acp-model-overlay.yml'

export const MODEL_OVERLAY_HEADER = '# --- dsh-plugin-remote-use managed: worker model (generated from this machine\'s "workerModel" setting) ---'
export const MODEL_OVERLAY_FOOTER = '# --- end dsh-plugin-remote-use managed: worker model ---'

/** @param {string} [home] */
export function workerModelOverlayPath(home = resolveDshHome()) {
  return join(home, 'storages', 'dsh-plugin-remote-use', MODEL_OVERLAY_FILENAME)
}

/**
 * Parse the `workerModel` setting, which is `provider/model`.
 *
 * The FIRST slash separates provider from model: model ids may legitimately contain slashes
 * (Hugging-Face-style ids), provider ids do not. Newlines are refused because this value becomes
 * a YAML scalar; whitespace inside the model is refused for the same reason.
 *
 * @param {string} [value]
 * @returns {{ ok: boolean, provider: string, model: string, reason: string }}
 */
export function parseWorkerModel(value) {
  const text = String(value ?? '').trim()
  if (text === '') return { ok: true, provider: '', model: '', reason: '' }
  if (/[\r\n]/u.test(text)) return { ok: false, provider: '', model: '', reason: 'must be a single line' }
  const slash = text.indexOf('/')
  if (slash <= 0) return { ok: false, provider: '', model: '', reason: 'expected "provider/model"' }
  const provider = text.slice(0, slash).trim()
  const model = text.slice(slash + 1).trim()
  if (!/^[A-Za-z0-9._-]+$/u.test(provider)) {
    return { ok: false, provider: '', model: '', reason: 'the provider id has unexpected characters' }
  }
  if (model === '' || /\s/u.test(model)) {
    return { ok: false, provider: '', model: '', reason: 'the model id is empty or contains whitespace' }
  }
  return { ok: true, provider, model, reason: '' }
}

/**
 * The overlay text for one model. JSON string quoting is valid YAML and survives every id.
 *
 * @param {{ provider: string, model: string }} opts
 * @returns {string}
 */
export function renderWorkerModelOverlay({ provider, model }) {
  return [
    MODEL_OVERLAY_HEADER,
    '- id: acp',
    "  name: '@deepseek-ai/dsh-acp'",
    '  config:',
    `    provider: ${JSON.stringify(provider)}`,
    `    model: ${JSON.stringify(model)}`,
    MODEL_OVERLAY_FOOTER,
    '',
  ].join('\n')
}

/**
 * Write (or remove) the overlay for the configured value.
 *
 * EMPTY REMOVES IT: an operator who clears the setting must not leave a stale file that someone
 * later passes by hand, and an overlay that is not passed is harmless but confusing.
 *
 * NO BOM, and only written when the content actually changes: the file is tiny, but rewriting it
 * on every launch would still make its mtime meaningless for "what did the last arm use".
 *
 * @param {{ home?: string, value?: string }} [opts]
 * @returns {{ ok: boolean, path: string, written: boolean, reason: string }}
 */
export function writeWorkerModelOverlay(opts = {}) {
  const home = opts.home ?? resolveDshHome()
  const parsed = parseWorkerModel(opts.value)
  if (parsed.ok !== true) return { ok: false, path: '', written: false, reason: parsed.reason }
  const file = workerModelOverlayPath(home)
  if (parsed.provider === '') {
    if (existsSync(file)) {
      try {
        rmSync(file, { force: true })
      } catch (error) {
        return { ok: false, path: '', written: false, reason: `could not remove ${file}: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    return { ok: true, path: '', written: false, reason: '' }
  }
  const text = renderWorkerModelOverlay(parsed)
  let previous = ''
  try {
    if (existsSync(file)) previous = readFileSync(file, 'utf8')
  } catch { /* unreadable -> rewrite */ }
  if (previous === text) return { ok: true, path: file, written: false, reason: '' }
  try {
    mkdirSync(join(home, 'storages', 'dsh-plugin-remote-use'), { recursive: true })
    writeFileSync(file, text, 'utf8')
  } catch (error) {
    return { ok: false, path: '', written: false, reason: `could not write ${file}: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, path: file, written: true, reason: '' }
}
