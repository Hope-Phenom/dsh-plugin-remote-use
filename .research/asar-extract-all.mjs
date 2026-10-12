// Batch-extract asar entries matching a regex into a target root dir.
// Usage: node asar-extract-all.mjs <regex> [outRoot] [stripPrefix]
import fs from 'node:fs';
import path from 'node:path';

const ASAR = 'C:\\Users\\you\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar';

function readHeader(asar) {
  const fd = fs.openSync(asar, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonSize = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonSize);
  fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
  fs.closeSync(fd);
  return { header: JSON.parse(jsonBuf.toString('utf8')), dataOffset: 16 + jsonSize };
}
function walk(node, prefix, out) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (val.files) walk(val, p, out);
    else out.push({ path: p, size: val.size, offset: val.offset, unpacked: val.unpacked });
  }
}

const re = new RegExp(process.argv[2]);
const outRoot = process.argv[3] || 'F:\\WorkSpace\\dsh-plugin-remote-use\\.research\\asar';
const strip = process.argv[4] || '';

const { header, dataOffset } = readHeader(ASAR);
const entries = [];
walk(header, '', entries);
const hit = entries.filter((e) => re.test(e.path) && !e.unpacked);
console.error(`matched ${hit.length} entries`);

const fd = fs.openSync(ASAR, 'r');
let n = 0, bytes = 0;
for (const e of hit) {
  const rel = strip && e.path.startsWith(strip) ? e.path.slice(strip.length) : e.path;
  const dest = path.join(outRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = Buffer.alloc(e.size);
  if (e.size > 0) fs.readSync(fd, buf, 0, e.size, dataOffset + Number(e.offset));
  fs.writeFileSync(dest, buf);
  n++; bytes += e.size;
}
fs.closeSync(fd);
console.log(`extracted ${n} files, ${(bytes / 1048576).toFixed(1)} MB -> ${outRoot}`);
