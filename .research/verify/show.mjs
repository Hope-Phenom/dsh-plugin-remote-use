// Print selected type declarations from a *.types.txt dump.
// Usage: node show.mjs <dumpFile> <TypeName> [TypeName...]
import { readFileSync } from 'node:fs';
const [, , dumpFile, ...names] = process.argv;
const txt = readFileSync(dumpFile, 'utf8');
const blocks = txt.split(/^\/\/ ===== /m).slice(1);
const map = new Map();
for (const b of blocks) {
  const nl = b.indexOf('\n');
  map.set(b.slice(0, nl).trim(), b.slice(nl + 1).trim());
}
if (names.length === 0) { for (const k of map.keys()) console.log(k); process.exit(0); }
for (const n of names) {
  if (map.has(n)) { console.log('// ===== ' + n + '\n' + map.get(n) + '\n'); }
  else {
    const hits = [...map.keys()].filter(k => k.toLowerCase().includes(n.toLowerCase()));
    console.log('// !!! NOT FOUND: ' + n + ' (similar: ' + hits.join(', ') + ')');
  }
}
