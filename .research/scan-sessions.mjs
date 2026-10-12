// Read-only: scan decompressed session logs for approval audit events.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'C:\\Users\\you\\.dsh\\sessions';
const needles = process.argv.slice(2);
if (needles.length === 0) needles.push('approval/asked', 'approval/decided', 'approval/policy', 'permission/preset', 'sandbox/mode');

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

let files = 0;
const hits = [];
for (const file of walk(ROOT)) {
  const lower = file.toLowerCase();
  if (!lower.endsWith('.jsonl') && !lower.endsWith('.jsonl.zstd')) continue;
  let text;
  try {
    const buf = fs.readFileSync(file);
    text = lower.endsWith('.zstd') ? zlib.zstdDecompressSync(buf).toString('utf8') : buf.toString('utf8');
  } catch { continue; }
  files++;
  const counts = {};
  for (const n of needles) {
    const c = text.split(n).length - 1;
    if (c > 0) counts[n] = c;
  }
  if (Object.keys(counts).length > 0) hits.push({ file, counts });
}
console.log(`scanned ${files} session logs`);
for (const h of hits) console.log(JSON.stringify(h));
