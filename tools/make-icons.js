// アイコン画像を作る（node tools/make-icons.js）
// - icons/key-up.png, key-down.png: キー調整の矢印（元画像 013/014.png を濃い緑に塗り替え）
// - icons/icon-192.png, icon-512.png, apple-touch-icon.png: アプリのアイコン（黄緑地に紫の音符）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC_DIR = 'C:/Users/hyobo/AI_app/アイコンpng';
const OUT_DIR = path.join(__dirname, '..', 'icons');
const ARROW_RGB = [0x36, 0x53, 0x14]; // --green-800
const BG_RGB = [0xD9, 0xF9, 0x9D]; // --green-300
const NOTE_RGB = [0x7C, 0x3A, 0xED]; // --purple-600

const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** 8bit の RGBA / RGB / グレー画像を RGBA に展開する */
function decodePng(buf) {
  let off = 8;
  let width, height, bitDepth, colorType;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('unsupported bit depth ' + bitDepth);
  const bpp = { 6: 4, 2: 3, 4: 2, 0: 1 }[colorType];
  if (!bpp) throw new Error('unsupported color type ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      const v = [cur, cur + a, cur + b, cur + ((a + b) >> 1), cur + paeth(a, b, c)][ft];
      if (v === undefined) throw new Error('unknown filter ' + ft);
      px[y * stride + x] = v & 0xFF;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * bpp;
    const g = px[s];
    rgba[i * 4] = bpp >= 3 ? px[s] : g;
    rgba[i * 4 + 1] = bpp >= 3 ? px[s + 1] : g;
    rgba[i * 4 + 2] = bpp >= 3 ? px[s + 2] : g;
    rgba[i * 4 + 3] = bpp === 4 ? px[s + 3] : bpp === 2 ? px[s + 1] : 255;
  }
  return { width, height, rgba };
}

function recolor(file, rgb) {
  const img = decodePng(fs.readFileSync(path.join(SRC_DIR, file)));
  for (let i = 0; i < img.width * img.height; i++) {
    img.rgba[i * 4] = rgb[0];
    img.rgba[i * 4 + 1] = rgb[1];
    img.rgba[i * 4 + 2] = rgb[2];
  }
  return encodePng(img.width, img.height, img.rgba);
}

// ---- アプリアイコン（音符2つを梁でつないだ形）。座標は 0〜1 の正方形で考える ----
function inEllipse(x, y, cx, cy, rx, ry, rot) {
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const dx = x - cx, dy = y - cy;
  const u = (dx * cos + dy * sin) / rx;
  const v = (-dx * sin + dy * cos) / ry;
  return u * u + v * v <= 1;
}

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inNote(x, y) {
  const rot = -0.4;
  return (
    inEllipse(x, y, 0.365, 0.665, 0.105, 0.078, rot) ||
    inEllipse(x, y, 0.655, 0.605, 0.105, 0.078, rot) ||
    inPolygon(x, y, [[0.432, 0.33], [0.468, 0.33], [0.468, 0.66], [0.432, 0.66]]) ||
    inPolygon(x, y, [[0.722, 0.27], [0.758, 0.27], [0.758, 0.60], [0.722, 0.60]]) ||
    inPolygon(x, y, [[0.432, 0.30], [0.758, 0.24], [0.758, 0.33], [0.432, 0.39]])
  );
}

function appIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // アンチエイリアス用に1ピクセルを4x4で判定
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inNote((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)) hit++;
        }
      }
      const t = hit / (SS * SS);
      const o = (py * size + px) * 4;
      for (let k = 0; k < 3; k++) rgba[o + k] = Math.round(BG_RGB[k] * (1 - t) + NOTE_RGB[k] * t);
      rgba[o + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'key-up.png'), recolor('013.png', ARROW_RGB));
fs.writeFileSync(path.join(OUT_DIR, 'key-down.png'), recolor('014.png', ARROW_RGB));
fs.writeFileSync(path.join(OUT_DIR, 'icon-192.png'), appIcon(192));
fs.writeFileSync(path.join(OUT_DIR, 'icon-512.png'), appIcon(512));
fs.writeFileSync(path.join(OUT_DIR, 'apple-touch-icon.png'), appIcon(180));

// 書き出した画像を読み戻して、壊れていないか確認する
for (const f of fs.readdirSync(OUT_DIR)) {
  const img = decodePng(fs.readFileSync(path.join(OUT_DIR, f)));
  console.log(f, img.width + 'x' + img.height);
}
