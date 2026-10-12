import fs from 'node:fs';
const root = 'F:\\WorkSpace\\dsh-plugin-remote-use\\.research\\sdk\\sdk\\schema';
const which = process.argv[2];
const j = JSON.parse(fs.readFileSync(`${root}/${which}`, 'utf8'));
for (const n of process.argv.slice(3)) {
  console.log('### ' + n);
  console.log(JSON.stringify(j.$defs[n], null, 1).slice(0, Number(process.env.MAXLEN || 4000)));
  console.log();
}
