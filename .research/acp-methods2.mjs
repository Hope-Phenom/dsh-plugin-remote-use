import fs from 'node:fs';
const root = 'F:\\WorkSpace\\dsh-plugin-remote-use\\.research\\sdk\\sdk\\schema';

for (const f of ['schema.json', 'v2/schema.unstable.json']) {
  const j = JSON.parse(fs.readFileSync(`${root}/${f}`, 'utf8'));
  const defs = j.$defs;
  const rows = [];
  for (const [name, def] of Object.entries(defs)) {
    if (def && def['x-method']) rows.push({ name, method: def['x-method'], side: def['x-side'], unstable: /UNSTABLE/.test(def.description || '') });
  }
  rows.sort((a, b) => a.method.localeCompare(b.method));
  console.log('='.repeat(78));
  console.log('FILE', f, '| defs with x-method:', rows.length);
  const bySide = {};
  for (const r of rows) (bySide[r.side] ||= []).push(r);
  for (const [side, list] of Object.entries(bySide)) {
    console.log(`--- x-side=${side} (${list.length})`);
    for (const r of list) console.log(`    ${r.method.padEnd(34)} ${r.name}${r.unstable ? '   [UNSTABLE]' : ''}`);
  }
}
