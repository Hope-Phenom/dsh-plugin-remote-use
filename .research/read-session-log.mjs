// Read-only: decode a multi-frame concatenated zstd session log.
// Node's sync/stream zstd decoders stop at the first frame, so walk frames by
// locating each zstd magic and validating that decompression succeeds.
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function frameOffsets(buf) {
  const out = [0];
  for (let i = 1; i + 4 <= buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      out.push(i);
    }
  }
  return out;
}

const file = process.argv[2];
const wantTypes = (process.argv[3] ?? 'approval/asked,approval/decided,approval/policy,permission/preset,sandbox/mode').split(',');
const raw = process.argv[4] === 'raw';

const buf = fs.readFileSync(file);
const offsets = frameOffsets(buf);
const parts = [];
for (let i = 0; i < offsets.length; i += 1) {
  const start = offsets[i];
  const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
  try {
    parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)));
  } catch {
    /* not a real frame boundary; its bytes belong to the previous frame */
  }
}
const text = Buffer.concat(parts).toString('utf8');
const lines = text.split('\n').filter((l) => l.length > 0);
const types = {};
const matched = [];
for (const line of lines) {
  let obj;
  try { obj = JSON.parse(line); } catch { continue; }
  const t = obj.type ?? '<header>';
  types[t] = (types[t] ?? 0) + 1;
  if (wantTypes.includes(t)) matched.push(line);
}
console.log('FRAMES', offsets.length, 'PARTIAL_OK', parts.length, 'LINES', lines.length);
console.log('TYPES', JSON.stringify(types));
console.log('MATCHED', matched.length);
for (const m of matched.slice(0, raw ? 100 : 3)) console.log(m.slice(0, 700));
