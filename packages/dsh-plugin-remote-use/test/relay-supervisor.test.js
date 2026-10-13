/**
 * Tests for the relay supervisor.
 *
 * The spawn is injected, so these assert the CONTRACT rather than a running relay: which argv is
 * built, what the spec file contains, and what happens when a listener dies. The parts that
 * touch the filesystem are real, because the spec file is the mechanism that keeps the install
 * path from being split on its space -- and a test that faked it would not notice it breaking.
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RelaySupervisor, relayPath } from '../lib/core/relay-supervisor.js'

/** A spawn stand-in that records its call and behaves like a live child. */
function makeSpawn() {
  const calls = []
  const children = []
  const spawn = (file, args, opts) => {
    const child = new EventEmitter()
    child.pid = 4242
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => { child.killed = true; return true }
    calls.push({ file, args, opts, child })
    children.push(child)
    return child
  }
  return { spawn, calls, children }
}

const GOOD_SPEC = {
  ok: true,
  installDir: 'C:\\Users\\you\\AppData\\Local\\Programs\\DeepSeek Harness',
  spec: {
    command: 'C:\\Users\\you\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe',
    args: ['--expose-internals', 'C:\\...\\cli.js', '--profile', 'acp'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  },
}

function makeSupervisor(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-supervisor-'))
  const { spawn, calls, children } = makeSpawn()
  const supervisor = new RelaySupervisor({
    spawn,
    relay: relayPath(),
    launchSpec: () => GOOD_SPEC,
    tempDir: dir,
    now: () => 1_000_000,
    ...overrides,
  })
  return { supervisor, calls, children, dir }
}

test('start builds an argv that never carries the install path as a string', () => {
  const { supervisor, calls, dir } = makeSupervisor()
  try {
    const { pid } = supervisor.start('192.168.1.100', 7331, 'tok')
    assert.equal(pid, 4242)
    const call = calls[0]
    assert.equal(call.file, process.execPath, 'the relay runs under node, not the GUI image')
    const args = call.args
    assert.equal(args[0], relayPath())
    const value = (flag) => args[args.indexOf(flag) + 1]
    assert.equal(value('--host'), '192.168.1.100')
    assert.equal(value('--port'), '7331')
    assert.equal(value('--token'), 'tok')
    // The binding decision is the operator's; advertising anything else would put an address in
    // the pairing string that does not match where the listener actually is.
    assert.equal(value('--advertise-host'), '192.168.1.100')
  } finally {
    supervisor.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the relay is told NOT to write a pairing file beside itself', () => {
  // Found by running the supervised listener for real and then looking at the repository: the
  // relay's default is `join(HERE, 'pairing.txt')`, and when the plugin spawns it HERE is the
  // plugin's own `slave/` directory. An installed plugin would therefore modify its own
  // installation -- and on a `link:` install, the operator's source checkout. The master gets
  // the pairing string over the authenticated RPC instead.
  const { supervisor, calls, dir } = makeSupervisor()
  try {
    supervisor.start('192.168.1.100', 7331, 'tok')
    const args = calls[0].args
    assert.equal(args.includes('--pairing-file'), true)
    assert.equal(args[args.indexOf('--pairing-file') + 1], '', 'an empty value disables the write')
  } finally {
    supervisor.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the ACP agent is handed over as a spec FILE, not a command line', () => {
  // The install path contains a space, and passing it as a string has already produced
  // `Cannot find module '...\Programs\DeepSeek'`.
  const { supervisor, calls, dir } = makeSupervisor()
  try {
    supervisor.start('192.168.1.100', 7331, 'tok')
    const args = calls[0].args
    const specFile = args[args.indexOf('--cmd-file') + 1]
    assert.equal(typeof specFile, 'string')
    assert.equal(calls[0].args.some((a) => a.includes('DeepSeek Harness.exe')), false,
      'the executable path must not appear on the relay command line at all')

    const written = JSON.parse(readFileSync(specFile, 'utf8'))
    assert.deepEqual(written, {
      command: GOOD_SPEC.spec.command,
      args: GOOD_SPEC.spec.args,
      env: GOOD_SPEC.spec.env,
    })
    // The relay passes this env to the agent, so missing it means a GUI image with no node mode.
    assert.equal(written.env.ELECTRON_RUN_AS_NODE, '1')
  } finally {
    supervisor.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the spec file is removed on stop, so repeated arming does not accumulate files', () => {
  const { supervisor, calls, dir } = makeSupervisor()
  try {
    supervisor.start('192.168.1.100', 7331, 'tok')
    const specFile = calls[0].args[calls[0].args.indexOf('--cmd-file') + 1]
    assert.equal(existsSync(specFile), true)
    supervisor.stop()
    assert.equal(existsSync(specFile), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the spec file is removed even when the listener was never running', () => {
  const { supervisor, dir } = makeSupervisor()
  try {
    supervisor.stop()
    assert.equal(supervisor.status().running, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing relay is an error the caller can turn into a refusal', () => {
  const { supervisor, dir } = makeSupervisor({ relay: join(tmpdir(), 'no-such-relay-xyz.mjs') })
  try {
    assert.throws(() => supervisor.start('192.168.1.100', 7331, 'tok'), /relay is missing/u)
    assert.equal(supervisor.status().running, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed launch-spec resolution is reported, not started blind', () => {
  const { supervisor, dir } = makeSupervisor({ launchSpec: () => ({ ok: false, error: 'no install found' }) })
  try {
    assert.throws(() => supervisor.start('192.168.1.100', 7331, 'tok'), /no install found/u)
    assert.equal(supervisor.status().running, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('starting twice is refused rather than leaking a second listener', () => {
  const { supervisor, calls, dir } = makeSupervisor()
  try {
    supervisor.start('192.168.1.100', 7331, 'tok')
    assert.throws(() => supervisor.start('192.168.1.100', 7331, 'tok'), /already running/u)
    assert.equal(calls.length, 1)
  } finally {
    supervisor.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a listener that dies is no longer reported as running', () => {
  // The page must not keep claiming "armed" while nothing is listening.
  const { supervisor, children, dir } = makeSupervisor()
  try {
    supervisor.start('192.168.1.100', 7331, 'tok')
    assert.equal(supervisor.status().running, true)
    children[0].emit('exit', 1, null)
    const status = supervisor.status()
    assert.equal(status.running, false)
    assert.deepEqual(status.exited, { code: 1, signal: null, at: 1_000_000 })
  } finally {
    supervisor.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the output tail is kept for diagnosis and bounded', () => {
  const { supervisor, children, dir } = makeSupervisor()
  try {
    supervisor.start('192.168.1.100', 7331, 'tok')
    children[0].stderr.emit('data', 'listening on 192.168.1.100:7331\n')
    children[0].stderr.emit('data', 'x'.repeat(20_000))
    const status = supervisor.status()
    assert.equal(status.output.includes('listening on'), false, 'the oldest output is dropped, not the newest')
    assert.ok(status.output.length <= 2_000, `the reported tail must be bounded, got ${status.output.length}`)
  } finally {
    supervisor.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stop is idempotent and kills the child it started', () => {
  const { supervisor, children, dir } = makeSupervisor()
  try {
    supervisor.start('192.168.1.100', 7331, 'tok')
    assert.equal(supervisor.stop().stopped, true)
    assert.equal(children[0].killed, true)
    assert.equal(supervisor.stop().stopped, false)
    assert.equal(supervisor.status().running, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a kill that throws is reported and does not leave the object claiming to run', () => {
  const { supervisor, children, dir } = makeSupervisor()
  try {
    supervisor.start('192.168.1.100', 7331, 'tok')
    children[0].kill = () => { throw new Error('the process is wedged') }
    const result = supervisor.stop()
    assert.equal(supervisor.status().running, false)
    assert.match(supervisor.status().lastError, /could not stop/u)
    assert.equal(result.stopped, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('status reports the bind and how long it has been up', () => {
  const { supervisor, calls, dir } = makeSupervisor()
  try {
    supervisor.start('192.168.1.100', 7331, 'tok')
    const status = supervisor.status()
    assert.equal(status.bindAddress, '192.168.1.100')
    assert.equal(status.port, 7331)
    assert.equal(status.pid, 4242)
    assert.equal(status.uptimeMs, 0, 'the injected clock does not advance')
    void calls
  } finally {
    supervisor.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
