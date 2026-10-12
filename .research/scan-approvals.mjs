// Read-only: scan every session log for approval audit events.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'C:\\Users\\you\\.dsh\\sessions';
const NEEDLE = process.argv[2] ?? 'approval/asked';
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function offsetsOf(buf) {
  const out = [0];
  for (let i = 1; i + 4 <= buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) out.push(i);
  }
  return out;
}

let files = 0;
let hits = 0;
for (const file of walk(ROOT)) {
  const lower = file.toLowerCase();
  if (!lower.endsWith('.jsonl') && !lower.endsWith('.jsonl.zstd')) continue;
  let buf;
  try { buf = fs.readFileSync(file); } catch { continue; }
  files += 1;
  if (!lower.endsWith('.zstd')) {
    if (buf.includes(NEEDLE)) { console.log('HIT', file); hits += 1; }
    continue;
  }
  const offs = offsetsOf(buf);
  let found = 0;
  for (let i = 0; i < offs.length; i += 1) {
    const start = offs[i];
    const end = i + 1 < offs.length ? offs[i + 1] : buf.length;
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'); } catch { continue; }
    const c = text.split(NEEDLE).length - 1;
    if (c > 0) {
      found += c;
      console.log('HIT', file, 'frame', start, 'count', c);
      if (process.env.SHOW) for (const line of text.split('\n')) if (line.includes(NEEDLE)) console.log('   ', line.slice(0, 500));
    }
  }
  if (found > 0) hits += 1;
}
console.log(`scanned ${files} logs; ${hits} with ${NEEDLE}`);
