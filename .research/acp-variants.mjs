import fs from 'node:fs';
const root = 'F:\\WorkSpace\\dsh-plugin-remote-use\\.research\\sdk\\sdk\\schema';
const which = process.argv[2] || 'schema.json';
const j = JSON.parse(fs.readFileSync(`${root}/${which}`, 'utf8'));
const defs = j.$defs;

function variants(d, acc = [], depth = 0) {
  if (!d || typeof d !== 'object' || depth > 4) return acc;
  if (Array.isArray(d)) { for (const x of d) variants(x, acc, depth); return acc; }
  if (d.title && (d.allOf || d.enum || d.type) && !/^(Result|Error)$/.test(d.title)) {
    acc.push({ title: d.title, ref: d.allOf?.find((a) => a.$ref)?.$ref?.split('/').pop(), desc: (d.description || '').split('\n')[0].slice(0, 100) });
  }
  if (d.allOf) for (const x of d.allOf) variants(x, acc, depth + 1);
  if (d.anyOf) for (const x of d.anyOf) variants(x, acc, depth + 1);
  if (d.oneOf) for (const x of d.oneOf) variants(x, acc, depth + 1);
  if (d.items) variants(d.items, acc, depth + 1);
  return acc;
}

for (const name of process.argv.slice(3)) {
  const d = defs[name];
  console.log('### ' + name + (d ? '' : ' -- MISSING'));
  if (!d) continue;
  if (d.enum) { console.log('  ENUM: ' + JSON.stringify(d.enum)); console.log(); continue; }
  const v = variants(d);
  const uniq = [];
  const seen = new Set();
  for (const x of v) { const k = x.title; if (seen.has(k)) continue; seen.add(k); uniq.push(x); }
  for (const x of uniq) console.log(`    ${(x.title || '?').padEnd(34)} ref=${(x.ref || '-').padEnd(32)} ${x.desc}`);
  console.log(`  [${uniq.length} variants]`);
  console.log();
}
