// Read-only: locate the Win32 message-injection / GUI-test harness invented in an
// earlier session. Session logs are multi-frame concatenated zstd.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'C:\\Users\\you\\.dsh\\sessions';
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

// High-signal Win32 input / injection vocabulary.
const TERMS = [
  'WM_LBUTTONDOWN', 'WM_LBUTTONUP', 'WM_MOUSEMOVE', 'WM_KEYDOWN', 'WM_CHAR',
  'PostMessage', 'SendMessageA', 'SendMessageW', 'mouse_event', 'SetCursorPos',
  'FindWindow', 'EnumWindows', 'EnumChildWindows', 'GetWindowRect',
  'MAKELPARAM', 'lParam', 'InjectDll', 'CreateRemoteThread', 'SetWindowsHookEx',
  'WriteProcessMemory', 'VirtualAllocEx', 'LoadLibraryA',
  '注入器', '消息注入', '点击注入', '发送鼠标', 'GUI 自动', 'GUI自动',
];
const re = new RegExp(TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');

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
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, end))); } catch { /* part of previous frame */ }
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
const scored = [];
for (const file of files) {
  let text;
  try { text = decode(file); } catch { continue; }
  const counts = {};
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) counts[m[0]] = (counts[m[0]] ?? 0) + 1;
  const keys = Object.keys(counts);
  // Require the distinctive Win32 input-message vocabulary, not generic lParam hits.
  const strong = keys.filter((k) => /WM_LBUTTON|PostMessage|SendMessage[AW]|mouse_event|CreateRemoteThread|SetWindowsHookEx|WriteProcessMemory|注入器|消息注入|发送鼠标/.test(k));
  if (strong.length >= 2) {
    scored.push({ file, total: keys.reduce((a, k) => a + counts[k], 0), strong, counts });
  }
}

scored.sort((a, b) => b.strong.length - a.strong.length || b.total - a.total);
console.log(`candidate sessions: ${scored.length}\n`);
for (const s of scored.slice(0, 15)) {
  console.log('===== ' + s.file.replace(ROOT, ''));
  console.log('  strong: ' + s.strong.join(', '));
  console.log('  counts: ' + JSON.stringify(s.counts));
}
