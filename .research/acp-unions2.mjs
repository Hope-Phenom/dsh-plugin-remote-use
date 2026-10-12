import fs from 'node:fs';
const root = 'F:\\WorkSpace\\dsh-plugin-remote-use\\.research\\sdk\\sdk\\schema';

function refsIn(node, out = new Set(), seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) { for (const x of node) refsIn(x, out, seen); return out; }
  if (typeof node.$ref === 'string') out.add(node.$ref.split('/').pop());
  for (const [k, v] of Object.entries(node)) { if (k === '$ref') continue; refsIn(v, out, seen); }
  return out;
}

for (const f of ['schema.json', 'v2/schema.unstable.json']) {
  const j = JSON.parse(fs.readFileSync(`${root}/${f}`, 'utf8'));
  const defs = j.$defs;
  console.log('='.repeat(78));
  console.log('FILE', f);
  for (const name of ['ClientRequest', 'ClientResponse', 'ClientNotification', 'AgentRequest', 'AgentResponse', 'AgentNotification']) {
    const refs = [...refsIn(defs[name])].filter((r) => defs[r] && defs[r]['x-method']);
    const list = refs.map((m) => ({ method: defs[m]['x-method'], side: defs[m]['x-side'], name: m }))
      .sort((a, b) => a.method.localeCompare(b.method));
    console.log(`  ${name} [${list.length}]:`);
    for (const l of list) console.log(`      ${l.method.padEnd(30)} ${l.name.padEnd(34)} side=${l.side}`);
  }
}
