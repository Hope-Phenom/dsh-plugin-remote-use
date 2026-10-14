#!/usr/bin/env node
/**
 * Mount the REAL settings route in a REAL HTTP server and probe it like a browser would.
 *
 * WHY THIS EXISTS, given there are already route tests: those hand the handler a fake request
 * object with whatever header keys the test author typed. Node's `IncomingMessage` LOWERCASES
 * every incoming header name, and the origin guard reads `req.headers.origin` / `req.headers.host`
 * / `req.headers['sec-fetch-site']`. A guard that only works against a hand-built object is a guard
 * that does nothing on the wire -- so this drives it through a socket.
 *
 * It also exercises the case the whole fix is about: a CROSS-SITE `text/plain` POST, which is what a
 * browser can send without a CORS preflight, and which the route parses as JSON regardless of
 * Content-Type.
 *
 * Usage:
 *   node .research/probe-route-origin.mjs [entry.js]
 * Default entry is the package source; point it at an installed copy to test a release.
 */
import { createServer } from 'node:http'
import { request } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const entry = process.argv[2] ?? join(HERE, '..', 'packages', 'dsh-plugin-remote-use', 'lib', 'index.js')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail === '' ? '' : ` -- ${detail}`}`)
  if (!ok) failures += 1
}

const mod = await import(pathToFileURL(entry).href)
if (typeof mod.makeSettingsRoute !== 'function') {
  console.error(`entry has no makeSettingsRoute: ${entry}`)
  process.exit(2)
}
console.log(`entry : ${entry}`)

// The paths under test (method, origin guard, unknown action) need none of these, but the GET probe
// does walk the snapshot, so hand it the same minimal shape the route tests use.
const { TaskRegistry } = await import(
  pathToFileURL(join(HERE, '..', 'packages', 'dsh-plugin-remote-use', 'lib', 'core', 'task-registry.js')).href
)
const route = mod.makeSettingsRoute({
  peers: new Map(),
  registry: new TaskRegistry({}),
  cache: { size: 0, misses: 0 },
})
const server = createServer((req, res) => { void route.handler(req, res) })

/** One raw request, with headers we choose. No fetch(): it refuses to send `Origin` at all. */
function send(port, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path: route.path, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const self = `http://127.0.0.1:${port}`
console.log(`route : ${self}${route.path}\n`)
const HOST = `127.0.0.1:${port}`
const NOOP = JSON.stringify({ action: '__probe_does_nothing__' })

// 1. Reachability, and the shape a NON-BROWSER caller has (no Origin at all).
const plain = await send(port, 'POST', { host: HOST, 'content-type': 'application/json' }, NOOP)
check('a non-browser POST reaches the handler', plain.status === 400 && /unknown action/u.test(plain.text),
  `status=${plain.status}`)

// 2. The attack: a cross-site simple request. text/plain => no preflight in a browser.
const hostile = await send(port, 'POST', {
  host: HOST, origin: 'http://evil.example', 'content-type': 'text/plain',
}, NOOP)
check('a cross-site text/plain POST is refused', hostile.status === 403, `status=${hostile.status} ${hostile.text.slice(0, 80)}`)
check('and the refusal says why', /cross-site/u.test(hostile.text), hostile.text.slice(0, 120))

// 3. An opaque origin: a sandboxed iframe or a redirected POST has nothing to compare.
const opaque = await send(port, 'POST', { host: HOST, origin: 'null', 'content-type': 'text/plain' }, NOOP)
check('an opaque (null) origin is refused', opaque.status === 403, `status=${opaque.status}`)

// 4. A browser that declares the relationship outright.
const declared = await send(port, 'POST', {
  host: HOST, origin: self, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json',
}, NOOP)
check('Sec-Fetch-Site: cross-site is refused even when Origin looks right', declared.status === 403,
  `status=${declared.status}`)

// 5. This server's own page: must go through, or the guard is a wall instead of a gate.
const own = await send(port, 'POST', {
  host: HOST, origin: self, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
}, NOOP)
check('the page this server serves is allowed', own.status === 400 && /unknown action/u.test(own.text),
  `status=${own.status}`)

// 6. The alias the operator may have used in the address bar.
const viaLocalhost = await send(port, 'POST', {
  host: `localhost:${port}`, origin: `http://localhost:${port}`, 'content-type': 'application/json',
}, NOOP)
check('localhost and 127.0.0.1 are both accepted, matched against Host', viaLocalhost.status === 400,
  `status=${viaLocalhost.status}`)

// 7. Reads: no gate, because no response carries Access-Control-Allow-Origin.
const read = await send(port, 'GET', { host: HOST, origin: 'http://evil.example' })
check('a cross-site GET is still served (it cannot be read by a page anyway)', read.status === 200,
  `status=${read.status}`)

server.close()
console.log(`\n===== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} =====`)
process.exit(failures === 0 ? 0 : 1)
