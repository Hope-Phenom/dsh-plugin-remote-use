// Print raw line ranges of dsh-tool-cordis api-catalog.js
// Usage: node rawlines.mjs <file> <fromLine> <toLine>
import { readFileSync } from 'node:fs';
const [, , file, from, to] = process.argv;
const lines = readFileSync(file, 'utf8').split(/\r?\n/);
for (let i = Number(from) - 1; i < Number(to) && i < lines.length; i++) {
  let l = lines[i];
  if (l.length > 400) l = l.slice(0, 400) + ' …';
  console.log(`${i + 1}: ${l}`);
}
