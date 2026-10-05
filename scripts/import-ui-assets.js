/**
 * 导入并优化 UI 素材
 * ---------------------------------------------------------------
 * 用法：node scripts/import-ui-assets.js <素材目录>
 *   例如：node scripts/import-ui-assets.js "C:\\path\\to\\ui原型图"
 *
 * 为什么需要这一步：
 *   设计稿给的原始素材太大——吉祥物单张 1254×1254 / 900KB，
 *   三张就 2.7MB。小程序主包上限 2MB，直接放进去会超限。
 *
 * 这个脚本做三件事：
 *   1. 按用途缩放到目标尺寸（吉祥物显示宽度约 240px，1x 即可）
 *   2. 把 PNG 重新编码为调色板 PNG（颜色少、体积小），零依赖
 *   3. 输出到 static/ui/，并打印每张的体积
 *
 * 不引入任何图像库——自己解析 PNG + 调色板量化 + 重编码。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'static', 'ui');

/* ===================== PNG 解码（8bit RGB/RGBA，无隔行）===================== */

function readPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG：' + file);

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行 PNG：' + file);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'PLTE') {
      // 输入也可能是调色板 PNG，暂不支持，报错更明确
      throw new Error('输入为调色板 PNG，本脚本只处理 8bit RGB/RGBA：' + file);
    }
    pos += 12 + len;
  }

  if (bitDepth !== 8) throw new Error('只支持 8bit：' + file);
  const channels = colorType === 6 ? 4 : (colorType === 2 ? 3 : 0);
  if (!channels) throw new Error('只支持 RGB/RGBA：' + file + '（colorType=' + colorType + '）');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(width * height * 4);

  // 逐行反过滤
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let src = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[src];
    src += 1;
    raw.copy(cur, 0, src, src + stride);
    src += stride;

    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = cur[i];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        v = (v + pred) & 0xff;
      }
      cur[i] = v;
    }

    // 写入 RGBA
    for (let x = 0; x < width; x += 1) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      px[di] = cur[si];
      px[di + 1] = cur[si + 1];
      px[di + 2] = cur[si + 2];
      px[di + 3] = channels === 4 ? cur[si + 3] : 255;
    }

    cur.copy(prev);
  }

  return { width, height, px };
}

/* ===================== 双线性缩放 ===================== */

function resize(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const fy = (y + 0.5) * sh / dh - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(sh - 1, y0 + 1));
    const wy = Math.max(0, Math.min(1, fy - y0));

    for (let x = 0; x < dw; x += 1) {
      const fx = (x + 0.5) * sw / dw - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
      const x1 = Math.max(0, Math.min(sw - 1, x0 + 1));
      const wx = Math.max(0, Math.min(1, fx - x0));

      const i00 = (y0 * sw + x0) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const di = (y * dw + x) * 4;

      for (let k = 0; k < 4; k += 1) {
        const top = src[i00 + k] * (1 - wx) + src[i10 + k] * wx;
        const bot = src[i01 + k] * (1 - wx) + src[i11 + k] * wx;
        out[di + k] = Math.round(top * (1 - wy) + bot * wy);
      }
    }
  }
  return out;
}

/* ===================== 调色板量化 + PNG 编码 ===================== */

/** 用 4bit/通道（4096 色）分桶统计，取出现最多的 255 色 */
function buildPalette(px, maxColors) {
  const hist = new Map();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 8) continue; // 全透明像素不参与
    // 5bit/通道（32768 桶）
    const key = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  const sorted = Array.from(hist.entries()).sort((a, b) => b[1] - a[1]).slice(0, maxColors - 1);
  const palette = sorted.map(([key]) => {
    const r = ((key >> 10) & 31) << 3;
    const g = ((key >> 5) & 31) << 3;
    const b = (key & 31) << 3;
    return [r | (r >> 5), g | (g >> 5), b | (b >> 5)];
  });
  return palette;
}

/** 找最近的调色板颜色（加权 RGB 距离，近似感知） */
function nearest(palette, r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const p = palette[i];
    const dr = r - p[0];
    const dg = g - p[1];
    const db = b - p[2];
    const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function crc32(buf) {
  const t = crc32.t || (crc32.t = (() => {
    const a = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      a[n] = c;
    }
    return a;
  })());
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, c]);
}

/** RGBA → PNG（颜色类型 6，直存）
 *
 * 为什么不用调色板压缩：
 *   试过 8bit 调色板 + tRNS，结果吉祥物出现大片黑色色块。
 *   根因是「把索引 0 留给透明」与量化冲突——不透明像素也会被映射到索引 0，
 *   于是深色区域被强制成透明，露出黑底。
 *   而且这些素材有大面积柔和渐变，本身就不适合调色板量化（会出色带）。
 *
 *   RGBA 直存虽然大一些，但质量无损；配合 PNG 的 filter 选择与最高压缩，
 *   体积仍在可接受范围。
 */
function encodeRgbaPng(px, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 逐行选 filter：分别试 None/Sub/Up/Average/Paeth，取绝对值和最小的
  const bpp = 4;
  const stride = width * bpp;
  const body = Buffer.alloc(height * (stride + 1));
  const prevLine = Buffer.alloc(stride);
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride),
    Buffer.alloc(stride), Buffer.alloc(stride)];

  for (let y = 0; y < height; y += 1) {
    const line = px.slice(y * stride, (y + 1) * stride);
    let best = 0;
    let bestScore = Infinity;

    for (let f = 0; f < 5; f += 1) {
      const out = cand[f];
      let score = 0;
      for (let i = 0; i < stride; i += 1) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prevLine[i];
        const c = i >= bpp ? prevLine[i - bpp] : 0;
        let v;
        if (f === 0) v = line[i];
        else if (f === 1) v = (line[i] - a) & 0xff;
        else if (f === 2) v = (line[i] - b) & 0xff;
        else if (f === 3) v = (line[i] - ((a + b) >> 1)) & 0xff;
        else {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          v = (line[i] - pred) & 0xff;
        }
        out[i] = v;
        // 有符号字节的绝对值和——filter 选择的常用启发式
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }

    const rowStart = y * (stride + 1);
    body[rowStart] = best;
    cand[best].copy(body, rowStart + 1);
    line.copy(prevLine);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(body, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ===================== 导入清单 ===================== */

/**
 * 每项：源文件、输出名、目标尺寸、调色板颜色数
 * 尺寸按实际显示需求定——吉祥物在卡片里显示宽度约 200~260rpx（≈100~130px），
 * 给 2 倍余量即可，不必保留 1254px。
 */
const MANIFEST = [
  // 吉祥物（首页两张卡 + 空状态 + 认领页）
  { src: '7.png', out: 'mascot-lost.png', w: 260, h: 260, colors: 128 },
  { src: '10.png', out: 'mascot-found.png', w: 260, h: 260, colors: 128 },
  { src: '6.png', out: 'mascot-alert.png', w: 260, h: 260, colors: 128 },
  { src: '4.png', out: 'mascot-think.png', w: 260, h: 260, colors: 128 },

  // 3D 图标（图层-2 ~ 图层-7）
  { src: '图层-2.png', out: 'ic-camera.png', w: 96, h: 96, colors: 96 },
  { src: '图层-3.png', out: 'ic-gear.png', w: 64, h: 64, colors: 64 },
  { src: '图层-4.png', out: 'ic-envelope.png', w: 64, h: 64, colors: 64 },
  { src: '图层-5.png', out: 'ic-search.png', w: 96, h: 96, colors: 96 },
  { src: '图层-6.png', out: 'ic-map.png', w: 96, h: 96, colors: 96 },
  { src: '图层-7.png', out: 'ic-mailbox.png', w: 64, h: 64, colors: 64 }
];

/* ===================== 主流程 ===================== */

const srcDir = process.argv[2];
if (!srcDir || !fs.existsSync(srcDir)) {
  console.error('用法：node scripts/import-ui-assets.js <素材目录>');
  console.error('例如：node scripts/import-ui-assets.js "C:\\path\\to\\ui原型图"');
  process.exit(1);
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

let total = 0;
let missing = 0;

MANIFEST.forEach((item) => {
  const srcFile = path.join(srcDir, item.src);
  if (!fs.existsSync(srcFile)) {
    console.log('  ! 缺少源文件：' + item.src);
    missing += 1;
    return;
  }

  const img = readPng(srcFile);
  const small = resize(img.px, img.width, img.height, item.w, item.h);
  const png = encodeRgbaPng(small, item.w, item.h);

  const outFile = path.join(OUT_DIR, item.out);
  fs.writeFileSync(outFile, png);
  total += png.length;

  const srcKb = Math.round(fs.statSync(srcFile).size / 1024);
  console.log('  ' + item.out.padEnd(20) +
    item.w + '×' + item.h + '  ' +
    String(srcKb).padStart(4) + 'KB → ' +
    String(Math.round(png.length / 1024)).padStart(3) + 'KB');
});

console.log('');
console.log('输出目录：static/ui/');
console.log('合计体积：' + Math.round(total / 1024) + ' KB' +
  (missing ? '（跳过 ' + missing + ' 个缺失源文件）' : ''));
console.log('');
console.log('主包上限 2MB，这些素材占 ' + (total / 1024 / 1024 * 100).toFixed(1) + '%');
