// Extract all files whose asar path matches any of the given regexes.
// Usage: node extract-many.mjs <outRoot> <regex1> [regex2 ...]
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

const outRoot = process.argv[2];
const regexes = process.argv.slice(3).map((r) => new RegExp(r, 'i'));

const { header, dataOffset } = readHeader(ASAR);
const entries = [];
walk(header, '', entries);

const hit = entries.filter((e) => regexes.some((re) => re.test(e.path)));
const fd = fs.openSync(ASAR, 'r');
let n = 0;
for (const ent of hit) {
  if (ent.unpacked) {
    console.log('SKIP(unpacked) ' + ent.path);
    continue;
  }
  const outFile = path.join(outRoot, ent.path);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const buf = Buffer.alloc(ent.size);
  fs.readSync(fd, buf, 0, ent.size, dataOffset + Number(ent.offset));
  fs.writeFileSync(outFile, buf);
  n++;
}
fs.closeSync(fd);
console.log(`extracted ${n} / matched ${hit.length}`);
