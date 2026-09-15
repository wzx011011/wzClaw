// 生成应用/托盘图标（纯 node，无外部依赖）：256/32/16 三档圆角方块 + 中心点
// PNG 手工编码：IHDR + IDAT(zlib) + IEND
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixelAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y, size);
      const o = row + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 圆角方块：底色 #2ea56f，边缘 #1d6b48，中心画一个白色圆点（“信号”意象）
function pixel(x, y, size) {
  const r0 = size * 0.16;
  const inCorner =
    (x < r0 && y < r0 && Math.hypot(x - r0, y - r0) > r0) ||
    (x > size - r0 && y < r0 && Math.hypot(x - (size - r0), y - r0) > r0) ||
    (x < r0 && y > size - r0 && Math.hypot(x - r0, y - (size - r0)) > r0) ||
    (x > size - r0 && y > size - r0 &&
      Math.hypot(x - (size - r0), y - (size - r0)) > r0);
  if (inCorner) return [0, 0, 0, 0];
  const d = Math.hypot(x - size / 2, y - size / 2);
  if (d < size * 0.14) return [255, 255, 255, 255]; // 中心白点
  if (d < size * 0.22) return [232, 240, 235, 255]; // 光环
  if (x < 2 || y < 2 || x > size - 3 || y > size - 3) return [29, 107, 72, 255];
  return [46, 165, 111, 255];
}

const out = path.join(__dirname, 'assets');
fs.mkdirSync(out, { recursive: true });
for (const size of [256, 32, 16]) {
  fs.writeFileSync(path.join(out, `icon-${size}.png`), png(size, pixel));
}
console.log('icons written');
