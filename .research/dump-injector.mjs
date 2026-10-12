// Read-only: dump the excerpts around Win32 input-simulation vocabulary from one session log.
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const file = process.argv[2];
const limit = Number(process.argv[3] ?? 40);
const window = Number(process.argv[4] ?? 700);

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

const text = decode(file);
// Unescape the JSON-encoded log so code fences become readable.
let pretty = text;
try {
  pretty = text.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t');
} catch { /* keep raw */ }

const re = /mouse_event|SetCursorPos|PostMessage|WM_LBUTTONDOWN|WM_LBUTTONUP|EnumChildWindows|EnumWindows|GetWindowRect|MAKELPARAM|FindWindow|CreateRemoteThread|SetWindowsHookEx|WriteProcessMemory|VirtualAllocEx|注入器|消息注入|发送鼠标|InjectDll|SendMessageA|SendMessageW/g;
const seen = new Set();
let m;
let n = 0;
while ((m = re.exec(pretty)) !== null && n < limit) {
  const start = Math.max(0, m.index - 400);
  const end = Math.min(pretty.length, m.index + window);
  const chunk = pretty.slice(start, end);
  const key = chunk.slice(0, 160);
  if (seen.has(key)) continue;
  seen.add(key);
  n += 1;
  console.log('\n────────── #' + n + '  [' + m[0] + '] @' + m.index + ' ──────────');
  console.log(chunk.replace(/\u0000/g, ''));
}
console.log(`\n(printed ${n} excerpts; decoded length ${pretty.length})`);
