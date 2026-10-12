import fs from 'node:fs';
const root = 'F:\\WorkSpace\\dsh-plugin-remote-use\\.research\\sdk\\sdk\\schema';
const j = JSON.parse(fs.readFileSync(`${root}/schema.json`, 'utf8'));
const defs = j.$defs;
for (const n of ['NewSessionRequest', 'PromptRequest', 'CancelNotification', 'SessionNotification', 'InitializeRequest']) {
  console.log('###', n);
  console.log(JSON.stringify(defs[n], null, 1).slice(0, 2500));
  console.log();
}
