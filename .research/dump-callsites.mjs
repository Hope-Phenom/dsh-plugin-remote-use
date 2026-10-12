// Read-only: dump every mouse_event / SetCursorPos / PostMessage call site with context,
// plus any doc-ish lines mentioning the harness, from one session log.
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const file = process.argv[2];
const want = process.argv[3] ?? 'mouse_event|SetCursorPos';
const limit = Number(process.argv[4] ?? 25);

function frameOffsets(buf) {
  const out = [0];
  for (let i = 1; i + 4 <= buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) out.push(i);
  }
  return out;
}

function decode(p) {
  const buf = fs.readFileSync(p);
  const offsets = frameOffsets(buf);
  const parts = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, end))); } catch { /* skip */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

const raw = decode(file);
const pretty = raw.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t');

// Collapse the JSON-per-line duplication: keep only chunks that look like source lines.
const re = new RegExp(want, 'g');
const seen = new Set();
let m;
let n = 0;
while ((m = re.exec(pretty)) !== null && n < limit) {
  const start = Math.max(0, m.index - 900);
  const end = Math.min(pretty.length, m.index + 500);
  const chunk = pretty.slice(start, end);
  const key = chunk.replace(/\s+/g, ' ').slice(0, 200);
  if (seen.has(key)) continue;
  // Skip the repeated {"number":N,"text":"..."} echo form of the same content.
  if (/"number":\d+,"text":/.test(chunk.slice(0, 200)) && seen.size > 3) continue;
  seen.add(key);
  n += 1;
  console.log('\n══════════ #' + n + ' [' + m[0] + '] ══════════');
  console.log(chunk.replace(/\u0000/g, ''));
}
console.log(`\n(printed ${n}; decoded ${pretty.length} chars)`);
