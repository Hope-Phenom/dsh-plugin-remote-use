// Structural scan of ACP schemas (no big dumps).
import fs from 'node:fs';

const root = 'F:\\WorkSpace\\dsh-plugin-remote-use\\.research\\sdk\\sdk\\schema';
const files = ['schema.json', 'v2/schema.unstable.json'];

for (const f of files) {
  const j = JSON.parse(fs.readFileSync(`${root}/${f}`, 'utf8'));
  console.log('='.repeat(70));
  console.log('FILE', f);
  console.log('  top keys:', Object.keys(j).join(', '));
  console.log('  title:', j.title);
  const defs = j.$defs || {};
  const names = Object.keys(defs);
  console.log('  $defs count:', names.length);
  console.log('  anyOf:', JSON.stringify(j.anyOf).slice(0, 900));
  const req = names.filter((n) => /^(Request|Notification|Response)$/.test(n) || /Protocol/.test(n));
  console.log('  protocol-ish defs:', names.filter((n) => /Protocol/i.test(n)).join(', '));
}
