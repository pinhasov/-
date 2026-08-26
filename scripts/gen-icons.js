'use strict';
/**
 * יצירת אייקוני האפליקציה (PWA) ללא תלויות חיצוניות – כתיבת PNG ישירות.
 * הרצה: npm run icons
 */

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** אייקון: רקע בגוון שזוף-סגלגל עם פרח בגוון שמנת וניצוץ זהב */
function drawIcon(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const plum = [109, 58, 78];
  const rose = [196, 115, 141];
  const cream = [255, 250, 246];
  const gold = [201, 162, 39];
  const c = size / 2;
  const scale = maskable ? 0.62 : 0.78;      // שוליים בטוחים לאייקון מסכה
  const radius = size * 0.22;

  const petals = [];
  const petalR = size * 0.135 * (scale / 0.78);
  const orbit = size * 0.155 * (scale / 0.78);
  for (let i = 0; i < 5; i++) {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    petals.push([c + Math.cos(ang) * orbit, c + Math.sin(ang) * orbit]);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let color = mix(plum, rose, (x / size) * 0.5 + (y / size) * 0.5);
      let alpha = 255;

      // פינות מעוגלות (למעט אייקון מסכה שממלא את כל הריבוע)
      if (!maskable) {
        const dx = Math.max(radius - x, x - (size - radius), 0);
        const dy = Math.max(radius - y, y - (size - radius), 0);
        if (dx > 0 && dy > 0 && Math.hypot(dx, dy) > radius) alpha = 0;
      }

      for (const [px0, py0] of petals) {
        if (Math.hypot(x - px0, y - py0) <= petalR) color = cream;
      }
      if (Math.hypot(x - c, y - c) <= size * 0.075) color = gold;

      px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2]; px[i + 3] = alpha;
    }
  }
  return encodePNG(size, size, px);
}

function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = [
    ['icon-192.png', drawIcon(192)],
    ['icon-512.png', drawIcon(512)],
    ['icon-maskable-512.png', drawIcon(512, { maskable: true })],
    ['favicon-32.png', drawIcon(32)],
  ];
  for (const [name, buf] of files) {
    fs.writeFileSync(path.join(OUT_DIR, name), buf);
    console.log(`נוצר: public/icons/${name} (${buf.length} בתים)`);
  }
}

if (require.main === module) run();
module.exports = { encodePNG, drawIcon };
