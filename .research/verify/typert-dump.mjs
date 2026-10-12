// Dump TYPERT FaceModel declarations from a generated typert.host.js file (regex based).
// Usage: node typert-dump.mjs <path-to-typert.host.js> [outDir]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const file = process.argv[2];
if (!file) { console.error('usage: node typert-dump.mjs <typert.host.js> [outDir]'); process.exit(1); }
const src = readFileSync(file, 'utf8');
const start = src.indexOf('TYPERT = {');
const end = src.lastIndexOf('\n}');
const body = src.slice(start, end);

const pkgMatch = /package:\s*'([^']+)'/.exec(body) || /package:\s*"([^"]+)"/.exec(body);
const pkg = pkgMatch ? pkgMatch[1] : basename(dirname(dirname(file)));
const slug = pkg.replace('@deepseek-ai/', '');
const outDir = process.argv[3] || join(process.cwd(), 'typert-dumps');
mkdirSync(outDir, { recursive: true });

function unescapeJson(s) {
  return JSON.parse('"' + s + '"');
}

// types: { "name": "X", ... "declaration": "..." }
const types = [];
const typeRe = /"name":\s*"([^"]+)",\s*(?:"declaration":\s*"((?:[^"\\]|\\.)*)")/g;
let m;
while ((m = typeRe.exec(body)) !== null) {
  types.push({ name: m[1], declaration: unescapeJson(m[2]) });
}
// also declaration-then-name order
const typeRe2 = /"declaration":\s*"((?:[^"\\]|\\.)*)",\s*"name":\s*"([^"]+)"/g;
while ((m = typeRe2.exec(body)) !== null) {
  types.push({ name: m[2], declaration: unescapeJson(m[1]) });
}
const seen = new Set();
const uniq = types.filter(t => (seen.has(t.name) ? false : (seen.add(t.name), true)));
writeFileSync(join(outDir, slug + '.types.txt'), uniq.map(t => `// ===== ${t.name}\n${t.declaration}\n`).join('\n'), 'utf8');

// services (methods with signature)
const svcOut = [];
const svcRe = /"service":\s*"([^"]+)"/g;
while ((m = svcRe.exec(body)) !== null) svcOut.push(m[1]);
const methodsOut = [];
const methRe = /"kind":\s*"method",\s*"name":\s*"([^"]+)",\s*"signature":\s*"((?:[^"\\]|\\.)*)",\s*"summary":\s*"((?:[^"\\]|\\.)*)"/g;
while ((m = methRe.exec(body)) !== null) methodsOut.push({ name: m[1], signature: unescapeJson(m[2]), summary: unescapeJson(m[3]) });
writeFileSync(join(outDir, slug + '.methods.json'), JSON.stringify(methodsOut, null, 2), 'utf8');

// events
const evOut = [];
const evRe = /\{\s*"jsDoc":\s*"(?:[^"\\]|\\.)*",\s*"name":\s*"([^"]+)",\s*"mode":\s*"([^"]+)",\s*"signature":\s*"((?:[^"\\]|\\.)*)"/g;
while ((m = evRe.exec(body)) !== null) evOut.push({ name: m[1], mode: m[2], signature: unescapeJson(m[3]) });
writeFileSync(join(outDir, slug + '.events.json'), JSON.stringify(evOut, null, 2), 'utf8');

// raw is also useful
writeFileSync(join(outDir, slug + '.raw.json.txt'), body, 'utf8');

console.log(JSON.stringify({ package: pkg, outDir, types: uniq.length, methods: methodsOut.length, events: evOut.length, services: [...new Set(svcOut)] }, null, 2));
