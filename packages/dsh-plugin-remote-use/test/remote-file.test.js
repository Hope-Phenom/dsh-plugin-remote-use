import { strict as assert } from 'node:assert'
import test from 'node:test'

import { makeRemoteTools } from '../lib/tools/remote-tools.js'
import { TaskRegistry } from '../lib/core/task-registry.js'

/**
 * A worker whose connection records every call, so the tool can be tested without a socket.
 * Each method returns the shape the real `PeerConnection` returns.
 */
function fakeWorker(overrides = {}) {
  const calls = []
  const connection = {
    async sendFile(opts) {
      calls.push({ method: 'sendFile', opts })
      if (typeof opts.onProgress === 'function') {
        opts.onProgress({ sent: 4, total: 8 })
        opts.onProgress({ sent: 8, total: 8 })
      }
      return { path: `/tasks/${opts.remotePath}`, bytes: 8, sha256: 'ab'.repeat(32), ms: 12 }
    },
    async fetchFile(opts) {
      calls.push({ method: 'fetchFile', opts })
      return { path: `/tasks/${opts.remotePath}`, localPath: opts.localPath ?? 'C:\\x\\transfers\\a.bin', bytes: 16, sha256: 'cd'.repeat(32), ms: 20 }
    },
    async statFile(path) {
      calls.push({ method: 'statFile', path })
      return overrides.stat ?? { path: `/tasks/${path}`, exists: true, isDir: false, size: 99, mtime: '2026-10-15T00:00:00.000Z' }
    },
    async listFiles(path) {
      calls.push({ method: 'listFiles', path })
      return overrides.list ?? {
        path: `/tasks/${path}`,
        entries: [{ name: 'a.txt', isDir: false, size: 3, mtime: 'm1' }, { name: 'sub', isDir: true, size: 0, mtime: 'm2' }],
        truncated: false,
      }
    },
  }
  return {
    calls,
    peer: { peerId: 'w1', name: 'worker-one', connection, defaultCwd: '/tasks' },
  }
}

function mount(worker, deps = {}) {
  const peers = new Map([[worker.peer.peerId, worker.peer]])
  const tools = makeRemoteTools({ registry: new TaskRegistry({}), peers, ...deps })
  const tool = tools.find((t) => t.name === 'remote_file')
  assert.ok(tool !== undefined, 'remote_file must be registered')
  return tool
}

test('send uploads the file and reports the path, size, hash and duration', async () => {
  const w = fakeWorker()
  const tool = mount(w)
  const out = await tool.execute({ action: 'send', localPath: 'C:\\build\\app.zip', remotePath: 'in/app.zip' })
  assert.match(out, /Uploaded to worker-one/u)
  assert.match(out, /in\/app\.zip|app\.zip/u)
  assert.match(out, /8 bytes/u)
  assert.match(out, /sha256: abab/u)
  assert.equal(w.calls.length, 1)
  assert.equal(w.calls[0].opts.localPath, 'C:\\build\\app.zip')
  assert.equal(w.calls[0].opts.remotePath, 'in/app.zip')
})

test('an existing destination is NOT overwritten unless asked', async () => {
  // The default is the whole point: a silent overwrite is a data-loss failure with no error in it.
  const w = fakeWorker()
  const tool = mount(w)
  await tool.execute({ action: 'send', localPath: 'C:\\a', remotePath: 'b' })
  assert.equal(w.calls[0].opts.overwrite, false, 'omitted overwrite must mean false')
  await tool.execute({ action: 'send', localPath: 'C:\\a', remotePath: 'b', overwrite: true })
  assert.equal(w.calls[1].opts.overwrite, true)
})

test('fetch reports the local path it wrote, since that is what the caller needs next', async () => {
  const w = fakeWorker()
  const tool = mount(w)
  const out = await tool.execute({ action: 'fetch', remotePath: 'out/report.pdf' })
  assert.match(out, /Downloaded from worker-one/u)
  assert.match(out, /Local file: C:\\x\\transfers\\a\.bin/u)
  assert.match(out, /read_image/u, 'an image fetch should point at the reader')
  // No localPath given: the connection picks the transfer directory.
  assert.equal(w.calls[0].opts.destPath, undefined)
})

test('fetch passes an explicit destination under the name the connection expects', async () => {
  // `destPath`, not `localPath`. The connection ignores an unknown key rather than complaining, so
  // getting this wrong means the file lands in the default directory while the tool reports success
  // -- a silent misreport, not an error.
  const w = fakeWorker()
  const tool = mount(w)
  await tool.execute({ action: 'fetch', remotePath: 'out/report.pdf', localPath: 'D:\\keep\\r.pdf' })
  assert.equal(w.calls[0].opts.destPath, 'D:\\keep\\r.pdf')
  assert.equal('localPath' in w.calls[0].opts, false, 'the old key must not linger')
})

test('stat and list answer from metadata', async () => {
  const w = fakeWorker()
  const tool = mount(w)
  const stat = await tool.execute({ action: 'stat', remotePath: 'a.txt' })
  assert.match(stat, /is a file/u)
  assert.match(stat, /Size: 99 bytes/u)

  const list = await tool.execute({ action: 'list', remotePath: '.' })
  assert.match(list, /2 entries/u)
  assert.match(list, /- {2,}3\s+m1\s+a\.txt/u, 'a file row carries size and mtime')
  assert.match(list, /d {2,}0\s+m2\s+sub/u, 'a directory row is marked d')
})

test('a missing remote path is reported as not existing, not as an error', async () => {
  const w = fakeWorker({ stat: { path: '/tasks/nope', exists: false, isDir: false, size: 0, mtime: '' } })
  const tool = mount(w)
  assert.match(await tool.execute({ action: 'stat', remotePath: 'nope' }), /does not exist/u)
})

test('bad input is answered with what was wrong, and never reaches the worker', async () => {
  const w = fakeWorker()
  const tool = mount(w)
  assert.match(await tool.execute({ action: 'send', remotePath: 'x' }), /send needs localPath/u)
  assert.match(await tool.execute({ action: 'fetch' }), /needs remotePath/u)
  assert.match(await tool.execute({ action: 'stat' }), /stat needs remotePath/u)
  assert.match(await tool.execute({ action: 'teleport', remotePath: 'x' }), /unknown action/u)
  assert.equal(w.calls.length, 0, 'none of these should have touched the worker')
})

test('an unknown worker is named in the failure', async () => {
  const w = fakeWorker()
  const tool = mount(w)
  assert.match(await tool.execute({ action: 'stat', remotePath: 'a', peerId: 'nope' }), /no worker with peerId "nope"/u)
})

test('no paired workers is a clear answer, not a throw', async () => {
  const tools = makeRemoteTools({ registry: new TaskRegistry({}), peers: new Map() })
  const tool = tools.find((t) => t.name === 'remote_file')
  assert.match(await tool.execute({ action: 'send', localPath: 'a', remotePath: 'b' }), /no paired workers/u)
})

test('the size and chunk ceilings reach the connection', async () => {
  const w = fakeWorker()
  const tool = mount(w, { transfer: { maxBytes: 1024, chunkBytes: 256 } })
  await tool.execute({ action: 'send', localPath: 'C:\\a', remotePath: 'b' })
  assert.equal(w.calls[0].opts.maxBytes, 1024)
  assert.equal(w.calls[0].opts.chunkBytes, 256)
})

test('a cancelled tool call passes the abort signal down to the transfer', async () => {
  const w = fakeWorker()
  const tool = mount(w)
  const controller = new AbortController()
  await tool.execute({ action: 'send', localPath: 'C:\\a', remotePath: 'b' }, { signal: controller.signal })
  assert.equal(w.calls[0].opts.signal, controller.signal)
})

test('two transfers to one worker are serialised, and the wait is reported', async () => {
  const calls = []
  let release
  const connection = {
    async sendFile(opts) {
      calls.push(`start:${opts.remotePath}`)
      if (opts.remotePath === 'first') await new Promise((resolve) => { release = resolve })
      calls.push(`end:${opts.remotePath}`)
      return { path: opts.remotePath, bytes: 1, sha256: 'x', ms: 1 }
    },
    async statFile() { return { exists: true, isDir: false, size: 0, mtime: '' } },
    async listFiles() { return { path: '.', entries: [], truncated: false } },
  }
  const peers = new Map([['w1', { peerId: 'w1', name: 'w', connection, defaultCwd: '/t' }]])
  const tool = makeRemoteTools({ registry: new TaskRegistry({}), peers }).find((t) => t.name === 'remote_file')

  const first = tool.execute({ action: 'send', localPath: 'a', remotePath: 'first' })
  await new Promise((resolve) => setImmediate(resolve))
  const second = tool.execute({ action: 'send', localPath: 'a', remotePath: 'second' })
  await new Promise((resolve) => setImmediate(resolve))
  // The second must not have started while the first is in flight.
  assert.deepEqual(calls, ['start:first'])
  release()
  const secondOut = await second
  await first
  assert.deepEqual(calls, ['start:first', 'end:first', 'start:second', 'end:second'])
  assert.match(secondOut, /waited behind 1 transfer/u)
})

test('list and stat do NOT queue behind a transfer in flight', async () => {
  // They are metadata reads. Making an operator wait for a 2 GiB copy just to `list` a directory
  // would be the same mistake as putting transfers on the GUI slot.
  let release
  const connection = {
    async sendFile() { await new Promise((resolve) => { release = resolve }); return { path: 'p', bytes: 1, sha256: 'x', ms: 1 } },
    async statFile(path) { return { path, exists: true, isDir: false, size: 1, mtime: 'm' } },
    async listFiles() { return { path: '.', entries: [], truncated: false } },
  }
  const peers = new Map([['w1', { peerId: 'w1', name: 'w', connection, defaultCwd: '/t' }]])
  const tool = makeRemoteTools({ registry: new TaskRegistry({}), peers }).find((t) => t.name === 'remote_file')

  const transfer = tool.execute({ action: 'send', localPath: 'a', remotePath: 'big' })
  await new Promise((resolve) => setImmediate(resolve))
  const stat = await tool.execute({ action: 'stat', remotePath: 'a.txt' })
  assert.match(stat, /is a file/u, 'stat answered while the transfer was still running')
  release()
  await transfer
})

test('every transfer is written to the audit trail, with what moved and how big it was', async () => {
  const w = fakeWorker()
  const rows = []
  const tool = mount(w, { audit: { record: (row) => rows.push(row) } })
  await tool.execute({ action: 'send', localPath: 'C:\\a.bin', remotePath: 'in/a.bin', overwrite: true })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'transfer')
  assert.equal(rows[0].direction, 'send')
  assert.equal(rows[0].peer, 'w1')
  assert.equal(rows[0].localPath, 'C:\\a.bin')
  assert.equal(rows[0].bytes, 8)
  assert.equal(rows[0].sha256, 'ab'.repeat(32))
  assert.equal(rows[0].overwrite, true)

  await tool.execute({ action: 'fetch', remotePath: 'out/b.bin' })
  assert.equal(rows[1].direction, 'fetch')
  assert.equal(rows[1].localPath, 'C:\\x\\transfers\\a.bin', 'a fetch records where it landed')
})

test('a FAILED transfer is reported and recorded as nothing, not as a success', async () => {
  const rows = []
  const connection = {
    async sendFile() { throw new Error('worker "w1" PUT /file returned HTTP 409') },
    async statFile() { return { exists: true, isDir: false, size: 0, mtime: '' } },
    async listFiles() { return { path: '.', entries: [], truncated: false } },
  }
  const peers = new Map([['w1', { peerId: 'w1', name: 'w', connection, defaultCwd: '/t' }]])
  const tool = makeRemoteTools({ registry: new TaskRegistry({}), peers, audit: { record: (r) => rows.push(r) } })
    .find((t) => t.name === 'remote_file')
  const out = await tool.execute({ action: 'send', localPath: 'a', remotePath: 'b' })
  assert.match(out, /remote_file send failed/u)
  assert.match(out, /HTTP 409/u, 'the worker\'s own reason survives to the caller')
  assert.equal(rows.length, 0, 'nothing moved, so there is nothing to record')
})

test('a connection without the transfer surface says so instead of throwing', async () => {
  const peers = new Map([['w1', { peerId: 'w1', name: 'w', connection: {}, defaultCwd: '/t' }]])
  const tool = makeRemoteTools({ registry: new TaskRegistry({}), peers }).find((t) => t.name === 'remote_file')
  const out = await tool.execute({ action: 'send', localPath: 'a', remotePath: 'b' })
  assert.match(out, /failed/u)
})
