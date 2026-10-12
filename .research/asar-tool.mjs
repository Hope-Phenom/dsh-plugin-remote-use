// Read-only asar inspection/extraction tool.
// Usage:
//   node asar-tool.mjs list [regex]        -> list entry paths (filtered by regex)
//   node asar-tool.mjs extract <asarPath> <outFile>  -> extract single file
//   node asar-tool.mjs sizes [regex]       -> list with sizes
import fs from 'node:fs';
import path from 'node:path';

const ASAR = 'C:\\Users\\you\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar';

function readHeader(asar) {
  const fd = fs.openSync(asar, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  // pickle: [0]=4 uint32 size, [4]=4 headerSizePicklePayload, [8]=4 headerStringSize, [12]=4 headerJsonSize
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

const cmd = process.argv[2];
const { header, dataOffset } = readHeader(ASAR);
const entries = [];
walk(header, '', entries);

if (cmd === 'list' || cmd === 'sizes') {
  const re = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
  const hit = entries.filter((e) => !re || re.test(e.path));
  hit.sort((a, b) => a.path.localeCompare(b.path));
  for (const e of hit) {
    console.log(cmd === 'sizes' ? `${String(e.size).padStart(10)}  ${e.path}` : e.path);
  }
  console.log(`# total ${hit.length} / ${entries.length}`);
} else if (cmd === 'extract') {
  const target = process.argv[3];
  // exact path or suffix match
  let ent = entries.find((e) => e.path === target);
  if (!ent) {
    const cands = entries.filter((e) => e.path.endsWith(target) || e.path.includes(target));
    if (cands.length !== 1) {
      console.error('ambiguous/none:', cands.slice(0, 20).map((c) => c.path));
      process.exit(2);
    }
    ent = cands[0];
  }
  const outFile = process.argv[4];
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const fd = fs.openSync(ASAR, 'r');
  const buf = Buffer.alloc(ent.size);
  fs.readSync(fd, buf, 0, ent.size, dataOffset + Number(ent.offset));
  fs.closeSync(fd);
  fs.writeFileSync(outFile, buf);
  console.log(`extracted ${ent.path} (${ent.size} bytes) -> ${outFile}`);
  void dataOffset;
} else {
  console.log('commands: list|sizes|extract');
}
