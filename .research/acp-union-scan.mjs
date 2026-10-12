import fs from 'node:fs';
const root = 'F:\\WorkSpace\\dsh-plugin-remote-use\\.research\\sdk\\sdk\\schema';
const j = JSON.parse(fs.readFileSync(`${root}/schema.json`, 'utf8'));
const defs = j.$defs;
for (const n of ['AgentRequest', 'AgentResponse', 'AgentNotification', 'ClientRequest', 'ClientResponse', 'ClientNotification', 'ProtocolVersion']) {
  const d = defs[n];
  console.log('###', n, '->', JSON.stringify(d).slice(0, 1500));
  console.log();
}
