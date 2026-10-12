import fs from 'node:fs';
const root = 'F:\\WorkSpace\\dsh-plugin-remote-use\\.research\\sdk\\sdk\\schema';

function refsIn(node, out = new Set(), seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) { for (const x of node) refsIn(x, out, seen); return out; }
  if (typeof node.$ref === 'string') out.add(node.$ref.split('/').pop());
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref') continue;
    refsIn(v, out, seen);
  }
  return out;
}

const UNIONS = {
  'schema.json': ['ClientRequest', 'ClientResponse', 'ClientNotification', 'AgentRequest', 'AgentResponse', 'AgentNotification'],
  'v2/schema.unstable.json': ['ClientRequest', 'ClientResponse', 'ClientNotification', 'AgentRequest', 'AgentResponse', 'AgentNotification'],
};

for (const [f, u] of Object.entries(UNIONS)) {
  const j = JSON.parse(fs.readFileSync(`${root}/${f}`, 'utf8'));
  const defs = j.$defs;
  console.log('='.repeat(78));
  console.log('FILE', f);
  for (const name of u) {
    const d = defs[name];
    if (!d) { console.log(`  ${name}: MISSING`); continue; }
    // only direct anyOf members' allOf refs
    const members = new Set();
    const collect = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(collect);
      if (n.title && n.allOf) n.allOf.forEach((a) => { if (a.$ref) members.add(a.$ref.split('/').pop()); });
      if (n.anyOf) n.anyOf.forEach(collect);
      if (n.allOf) n.allOf.forEach(collect);
    };
    collect(d);
    const list = [...members].map((m) => `${defs[m]?.['x-method'] || '?'} (${m})`).sort();
    console.log(`  ${name} [${list.length}]:`);
    for (const l of list) console.log(`      ${l}`);
  }
}
