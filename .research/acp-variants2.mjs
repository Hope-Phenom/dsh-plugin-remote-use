import fs from 'node:fs';
const root = 'F:\\WorkSpace\\dsh-plugin-remote-use\\.research\\sdk\\sdk\\schema';
const which = process.argv[2];
const j = JSON.parse(fs.readFileSync(`${root}/${which}`, 'utf8'));
const defs = j.$defs;

function variants(d) {
  // returns list of {key, ref, desc, extra}
  const out = [];
  const u = d.oneOf || d.anyOf || [];
  for (const m of u) {
    if (m.const !== undefined) { out.push({ key: m.const, desc: (m.description || '').split('\n')[0] }); continue; }
    const props = m.properties || {};
    const disc = props.sessionUpdate || props.type || props.status || props.outcome || props.kind || props.role;
    const ref = (m.allOf || []).find((a) => a.$ref)?.$ref?.split('/').pop();
    out.push({ key: disc?.const ?? disc?.enum?.join('|') ?? '(?)', ref, desc: (m.description || '').split('\n')[0].slice(0, 90) });
  }
  return out;
}

for (const n of process.argv.slice(3)) {
  const d = defs[n];
  console.log('### ' + n + '  [' + ((d.oneOf || d.anyOf || []).length) + ' variants]');
  if (!d) { console.log('  MISSING\n'); continue; }
  for (const v of variants(d)) console.log(`    ${String(v.key).padEnd(30)} ref=${String(v.ref || '-').padEnd(28)} ${v.desc}`);
  console.log();
}
