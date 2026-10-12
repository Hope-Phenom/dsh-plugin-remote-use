import fs from 'node:fs';
const root = 'F:\\WorkSpace\\dsh-plugin-remote-use\\.research\\sdk\\sdk\\schema';

function methodOf(def) {
  // find nested method const anywhere shallow
  const stack = [def];
  const seen = new Set();
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object' || seen.has(n)) continue;
    seen.add(n);
    if (Array.isArray(n)) { for (const x of n) stack.push(x); continue; }
    if (n.properties && n.properties.method && n.properties.method.const !== undefined) return n.properties.method.const;
    if (n.properties && n.properties.method && n.properties.method.enum) return n.properties.method.enum.join('|');
    for (const v of Object.values(n)) stack.push(v);
  }
  return null;
}

for (const f of ['schema.json', 'v2/schema.unstable.json']) {
  const j = JSON.parse(fs.readFileSync(`${root}/${f}`, 'utf8'));
  const defs = j.$defs;
  const out = [];
  for (const [name, def] of Object.entries(defs)) {
    const m = methodOf(def);
    if (m) out.push([m, name, def.title || '']);
  }
  out.sort((a, b) => a[0].localeCompare(b[0]));
  console.log('='.repeat(70));
  console.log('FILE', f, 'methods found:', out.length);
  for (const [m, name, title] of out) console.log(`  ${m.padEnd(28)} ${name}`);
}
