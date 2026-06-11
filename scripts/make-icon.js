// Generates media/icon.png (256×256 marketplace icon) with zero native or
// external dependencies: pixels are composed in JS (supersampled 4× for
// anti-aliasing) and encoded as a minimal PNG via node:zlib.
//
// Design: deep-indigo→cyan diagonal gradient on a rounded square; a 2×2 grid
// of white tiles (the SharePoint "site grid") with an AI spark (astroid star)
// at the upper right. Re-run `node scripts/make-icon.js` to regenerate.
"use strict";
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const SIZE = 256;
const SS = 4; // supersampling factor
const BIG = SIZE * SS;

// --- scene ------------------------------------------------------------
const TOP = [30, 58, 138]; // indigo-900
const BOT = [8, 145, 178]; // cyan-600
const WHITE = [255, 255, 255];

function roundedRectSDF(px, py, cx, cy, hw, hh, r) {
  const dx = Math.max(Math.abs(px - cx) - (hw - r), 0);
  const dy = Math.max(Math.abs(py - cy) - (hh - r), 0);
  return Math.hypot(dx, dy) - r;
}

function insideAstroid(px, py, cx, cy, r) {
  const dx = Math.abs(px - cx) / r;
  const dy = Math.abs(py - cy) / r;
  return Math.pow(dx, 2 / 3) + Math.pow(dy, 2 / 3) <= 1;
}

// Geometry in 256-space, scaled up by SS at sample time.
const TILES = [
  { x: 76, y: 148, s: 44 },
  { x: 130, y: 148, s: 44 },
  { x: 76, y: 202, s: 44 },
  { x: 130, y: 202, s: 44 },
];
const SPARK = { x: 178, y: 86, r: 50 };
const SPARK2 = { x: 215, y: 142, r: 16 };

function samplePixel(bx, by) {
  // bx/by in BIG-space; convert to 256-space coords.
  const x = bx / SS;
  const y = by / SS;

  // Background rounded square.
  const bg = roundedRectSDF(x, y, 128, 128, 120, 120, 52);
  if (bg > 0) return [0, 0, 0, 0];

  // Diagonal gradient.
  const t = Math.min(1, Math.max(0, (x + y) / 512));
  let r = TOP[0] + (BOT[0] - TOP[0]) * t;
  let g = TOP[1] + (BOT[1] - TOP[1]) * t;
  let b = TOP[2] + (BOT[2] - TOP[2]) * t;

  // Soft inner highlight (top-left sheen).
  const sheen = Math.max(0, 1 - Math.hypot(x - 70, y - 60) / 230) * 0.10;
  r += (255 - r) * sheen;
  g += (255 - g) * sheen;
  b += (255 - b) * sheen;

  // Tiles (one slightly translucent for depth).
  for (let i = 0; i < TILES.length; i++) {
    const tdef = TILES[i];
    const half = tdef.s / 2;
    const d = roundedRectSDF(x, y, tdef.x, tdef.y, half, half, 9);
    if (d <= 0) {
      const a = i === 1 ? 0.66 : i === 2 ? 0.82 : 0.95;
      r = r + (WHITE[0] - r) * a;
      g = g + (WHITE[1] - g) * a;
      b = b + (WHITE[2] - b) * a;
    }
  }

  // Sparks.
  if (insideAstroid(x, y, SPARK.x, SPARK.y, SPARK.r)) {
    r = 255; g = 255; b = 255;
  }
  if (insideAstroid(x, y, SPARK2.x, SPARK2.y, SPARK2.r)) {
    r = 255; g = 255; b = 255;
  }

  return [r, g, b, 255];
}

// --- render with box-filter downsample ---------------------------------
function render() {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = samplePixel(x * SS + sx + 0.5, y * SS + sy + 0.5);
          r += pr * (pa / 255); g += pg * (pa / 255); b += pb * (pa / 255); a += pa;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const idx = (y * SIZE + x) * 4;
      const unpremul = alpha > 0 ? 255 / alpha : 0;
      out[idx] = Math.round(Math.min(255, (r / n) * unpremul));
      out[idx + 1] = Math.round(Math.min(255, (g / n) * unpremul));
      out[idx + 2] = Math.round(Math.min(255, (b / n) * unpremul));
      out[idx + 3] = Math.round(alpha);
    }
  }
  return out;
}

// --- minimal PNG encoder ------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const target = path.join(__dirname, "..", "media", "icon.png");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, encodePng(render()));
console.log(`wrote ${target}`);
