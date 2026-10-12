// Read-only: search every zstd session log for GUI-automation / injection terms.
// Session logs are multi-frame concatenated zstd, and Node's decoder stops at the
// first frame, so walk frames by locating each zstd magic and validating decode.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'C:\\Users\\you\\.dsh\\sessions';
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const PATTERN = process.argv[2] ?? 'Inject|注入|SendInput|PostMessage|mouse_event|FlaUI|Squish|pywinauto|UI Automation|AutoIt|自动化测试';
const re = new RegExp(PATTERN, 'gi');

function frameOffsets(buf) {
  const out = [0];
  for (let i = 1; i + 4 <= buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) out.push(i);
  }
  return out;
}

function decode(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 4 || buf[0] !== MAGIC[0] || buf[1] !== MAGIC[1]) return buf.toString('utf8');
  const offsets = frameOffsets(buf);
  const parts = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, end))); } catch { /* boundary belongs to previous frame */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/session\.v\d+\.jsonl(\.zstd)?$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
console.error(`files=${files.length}`);
const results = [];
for (const file of files) {
  let text;
  try { text = decode(file); } catch { continue; }
  re.lastIndex = 0;
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ term: m[0], ctx: text.slice(Math.max(0, m.index - 220), m.index + 300).replace(/\s+/g, ' ') });
    if (matches.length >= 4) break;
  }
  if (matches.length) results.push({ file, size: text.length, matches });
}

results.sort((a, b) => b.matches.length - a.matches.length);
console.log(`hit files: ${results.length}`);
for (const r of results.slice(0, 25)) {
  console.log('\n===== ' + r.file.replace(ROOT, '') + `  (decoded ${r.size} chars)`);
  for (const m of r.matches) console.log('  [' + m.term + '] ' + m.ctx);
}
