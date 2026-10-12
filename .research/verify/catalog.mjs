// Extract declaration/name/signature entries from dsh-tool-cordis api-catalog.js
// Usage: node catalog.mjs <api-catalog.js> [regexFilter...]
import { readFileSync } from 'node:fs';
const file = process.argv[2];
const filters = process.argv.slice(3).map(s => new RegExp(s, 'i'));
const src = readFileSync(file, 'utf8');
const lines = src.split(/\r?\n/);

// entries look like: { name: 'X', declaration: '...' } or { key: 'x', signature: '...' } etc.
const out = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  const m = /^\s*(name|key|signature|declaration):\s*(['"])([\s\S]*)\2,?\s*$/.exec(l);
  if (!m) continue;
  out.push({ line: i + 1, field: m[1], value: m[3].replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"') });
}
const groups = [];
let cur = null;
for (const e of out) {
  if (e.field === 'name' || e.field === 'key') { cur = { label: e.value, line: e.line, sig: null, decl: null }; groups.push(cur); }
  else if (cur) { if (e.field === 'signature') cur.sig = e.value; if (e.field === 'declaration') cur.decl = e.value; }
}
const want = (g) => filters.length === 0 || filters.some(f => f.test(g.label) || (g.decl && f.test(g.decl)) || (g.sig && f.test(g.sig)));
for (const g of groups.filter(want)) {
  console.log(`### ${g.label}   (catalog line ${g.line})`);
  if (g.sig) console.log('SIG: ' + g.sig);
  if (g.decl) console.log(g.decl);
  console.log('');
}
console.error(`[catalog] parsed ${groups.length} entries, matched ${groups.filter(want).length}`);
