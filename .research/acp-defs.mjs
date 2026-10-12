import fs from 'node:fs';
const root = 'F:\\WorkSpace\\dsh-plugin-remote-use\\.research\\sdk\\sdk\\schema';
const which = process.argv[2] || 'schema.json';
const j = JSON.parse(fs.readFileSync(`${root}/${which}`, 'utf8'));
const defs = j.$defs;

function brief(d, depth = 0, maxDepth = 3) {
  if (!d || typeof d !== 'object') return String(d);
  if (d.$ref) return '$' + d.$ref.split('/').pop();
  if (d.anyOf) return '(' + d.anyOf.map((x) => brief(x, depth + 1, maxDepth)).join(' | ') + ')';
  if (d.allOf) return '&' + d.allOf.map((x) => brief(x, depth + 1, maxDepth)).join('&');
  const t = d.type;
  if (t === 'array') return `Array<${brief(d.items, depth + 1, maxDepth)}>`;
  if (t === 'object' || d.properties) {
    if (!d.properties) return 'object(open)';
    if (depth >= maxDepth) return 'object{...}';
    return '{' + Object.entries(d.properties).map(([k, v]) => `${k}: ${brief(v, depth + 1, maxDepth)}`).join(', ') + '}';
  }
  if (d.enum) return `enum[${d.enum.map((x) => JSON.stringify(x)).join(',')}]`;
  if (d.const !== undefined) return `const(${JSON.stringify(d.const)})`;
  if (Array.isArray(t)) return t.join('|');
  return t || 'any';
}

const targets = process.argv.slice(3);
for (const name of targets) {
  const d = defs[name];
  console.log('### ' + name + (d ? '' : ' -- MISSING'));
  if (!d) continue;
  if (d.description) console.log('  desc: ' + String(d.description).split('\n')[0].slice(0, 160));
  if (d.enum) console.log('  ENUM: ' + JSON.stringify(d.enum));
  if (d.anyOf && depth0IsUnion(d)) {
    console.log('  UNION: ' + d.anyOf.map((x) => (x.enum ? JSON.stringify(x.enum) : brief(x))).join(' | '));
  }
  if (d.properties) {
    console.log('  required: ' + JSON.stringify(d.required));
    for (const [k, v] of Object.entries(d.properties)) {
      console.log(`    ${k.padEnd(22)} ${brief(v)}`);
    }
  }
  console.log();
}
function depth0IsUnion(d) {
  return d.anyOf && d.anyOf.some((x) => x.enum || x.const !== undefined || x.type);
}
