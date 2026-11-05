/**
 * Tests for the worker-model overlay.
 *
 * The value decides `promptCapabilities.image` for the worker's ACP connection (DESIGN 14.1), and a
 * wrong id turns image prompts off SILENTLY -- so the parser's refusals are the interesting part,
 * not just the happy path.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MODEL_OVERLAY_FOOTER,
  MODEL_OVERLAY_HEADER,
  parseWorkerModel,
  renderWorkerModelOverlay,
  workerModelOverlayPath,
  writeWorkerModelOverlay,
} from '../lib/core/acp-model-overlay.js'

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'model-overlay-'))
  try {
    return fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('the setting is provider/model, and empty means "inherit the profile"', () => {
  assert.deepEqual(parseWorkerModel(''), { ok: true, provider: '', model: '', reason: '' })
  assert.deepEqual(parseWorkerModel(undefined), { ok: true, provider: '', model: '', reason: '' })
  assert.deepEqual(parseWorkerModel('deepseek-official/deepseek-flash'),
    { ok: true, provider: 'deepseek-official', model: 'deepseek-flash', reason: '' })
  // Only the FIRST slash separates: model ids may contain slashes, provider ids do not.
  assert.deepEqual(parseWorkerModel('meta/llama-3.1/8b'),
    { ok: true, provider: 'meta', model: 'llama-3.1/8b', reason: '' })
})

test('malformed values are refused instead of being stored', () => {
  for (const bad of ['deepseek-flash', '/deepseek-flash', 'deepseek-official/', 'a b/c', 'a/b c', 'a\nb/c', 'pr@vider/model']) {
    const parsed = parseWorkerModel(bad)
    assert.equal(parsed.ok, false, `${JSON.stringify(bad)} must be refused`)
    assert.notEqual(parsed.reason, '')
  }
})

test('the overlay is a patch LIST that overrides only the acp row', () => {
  const text = renderWorkerModelOverlay({ provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.ok(text.startsWith(MODEL_OVERLAY_HEADER))
  assert.ok(text.trimEnd().endsWith(MODEL_OVERLAY_FOOTER))
  assert.match(text, /^- id: acp$/mu)
  assert.match(text, /name: '@deepseek-ai\/dsh-acp'/u)
  assert.match(text, /provider: "deepseek-official"/u)
  assert.match(text, /model: "deepseek-flash"/u)
  // No BOM: this file is read by the same YAML loader that has been broken by one before.
  assert.notEqual(text.charCodeAt(0), 0xFEFF)
})

test('writing is idempotent, and an empty value REMOVES the overlay', () => {
  withHome((home) => {
    const file = workerModelOverlayPath(home)
    const first = writeWorkerModelOverlay({ home, value: 'deepseek-official/deepseek-flash' })
    assert.equal(first.ok, true)
    assert.equal(first.written, true)
    assert.equal(first.path, file)
    assert.ok(existsSync(file))
    assert.equal(readFileSync(file, 'utf8'), renderWorkerModelOverlay({ provider: 'deepseek-official', model: 'deepseek-flash' }))

    const again = writeWorkerModelOverlay({ home, value: 'deepseek-official/deepseek-flash' })
    assert.equal(again.written, false, 'an unchanged value must not rewrite the file')

    // Invalid values are refused and leave the previous file alone.
    const bad = writeWorkerModelOverlay({ home, value: 'no-slash' })
    assert.equal(bad.ok, false)
    assert.equal(existsSync(file), true)

    const cleared = writeWorkerModelOverlay({ home, value: '' })
    assert.equal(cleared.ok, true)
    assert.equal(cleared.path, '')
    assert.equal(existsSync(file), false, 'clearing the setting must not leave a stale overlay')
  })
})
