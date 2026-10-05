/**
 * 生成 tabBar 图标 PNG
 * ---------------------------------------------------------------
 * 用法：node scripts/gen-tab-icons.js
 *
 * 为什么用脚本生成而不是找素材：
 *   微信 tabBar 不支持字体图标，**必须是 PNG 图片文件**。
 *   我又不能画图，所以这里用「矢量形状 + 光栅化」直接生成 PNG——
 *   纯 Node（zlib + 手写 PNG 编码），不引入任何依赖。
 *
 * 生成结果：
 *   static/tabbar/home.png / home-on.png
 *   static/tabbar/match.png / match-on.png     （放大镜，匹配=检索）
 *   static/tabbar/map.png / map-on.png         （定位针）
 *   static/tabbar/mine.png / mine-on.png       （人像）
 *
 * 规格：81×81 像素（微信推荐尺寸），4 倍超采样后缩小以获得抗锯齿边缘。
 * 换设计时改下面的 PATHS / 颜色即可，不用动别处。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'static', 'tabbar');

/** 输出尺寸（微信推荐 81×81） */
const SIZE = 81;
/** 超采样倍数：先按 4 倍画，再平均缩小，得到平滑边缘 */
const SS = 4;

/** 未选中 / 选中颜色（与 app.json 的 color / selectedColor 一致） */
const COLOR_OFF = [0x98, 0xa2, 0xb3];
const COLOR_ON = [0x2e, 0x6b, 0xe6];

/* ===================== 几何工具 ===================== */

/** 点是否在矩形内 */
function inRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** 点到线段的距离 */
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 点是否在「胶囊」线段内（带圆角端点） */
function inCapsule(x, y, seg) {
  return distToSeg(x, y, seg.x1, seg.y1, seg.x2, seg.y2) <= seg.w / 2;
}

/** 点是否在圆环内（外圆 - 内圆） */
function inRing(x, y, c) {
  const d = Math.hypot(x - c.cx, y - c.cy);
  return d <= c.r && d >= (c.r - c.w);
}

/** 点是否在实心圆内 */
function inCircle(x, y, c) {
  return Math.hypot(x - c.cx, y - c.cy) <= c.r;
}

/**
 * 坐标统一用 0—1 的相对空间描述，再乘上实际像素尺寸，
 * 这样改 SIZE 时图形不变形。
 */
function hit(shape, u, v) {
  switch (shape.type) {
    case 'rect': return inRect(u * 100, v * 100, shape);
    case 'capsule': return inCapsule(u * 100, v * 100, shape);
    case 'ring': return inRing(u * 100, v * 100, shape);
    case 'circle': return inCircle(u * 100, v * 100, shape);
    default: return false;
  }
}

/* ===================== 4 个图标的形状定义 ===================== */
/* 所有坐标在 0—100 的相对空间里，便于等比缩放与调形 */

const ICONS = {
  /** 首页：屋顶 + 屋身（屋顶用两段粗胶囊拼成人字） */
  home: {
    label: '首页',
    shapes: [
      { type: 'capsule', x1: 22, y1: 46, x2: 50, y2: 22, w: 13 },
      { type: 'capsule', x1: 50, y1: 22, x2: 78, y2: 46, w: 13 },
      { type: 'rect', x: 28, y: 45, w: 44, h: 33 },
      // 门洞（挖空用 subtract 处理）
      { type: 'rect', x: 43, y: 58, w: 14, h: 20, subtract: true }
    ]
  },

  /** 匹配：放大镜（检索语义，与本项目「多模态检索」一致） */
  match: {
    label: '匹配',
    shapes: [
      { type: 'ring', cx: 44, cy: 43, r: 25, w: 11 },
      { type: 'capsule', x1: 62, y1: 61, x2: 80, y2: 79, w: 12 }
    ]
  },

  /**
   * 地图：定位针
   * 上部圆 + 内孔（内孔圆心偏上，让下方形成实心针尖），再补一段向下收窄的柄。
   */
  map: {
    label: '地图',
    shapes: [
      { type: 'circle', cx: 50, cy: 42, r: 27 },
      { type: 'circle', cx: 50, cy: 36, r: 11, subtract: true },
      { type: 'capsule', x1: 50, y1: 66, x2: 50, y2: 84, w: 12 }
    ]
  },

  /**
   * 我的：人像剪影
   * 头部用实心圆、肩部用宽胶囊。
   * 试过「空心头环 + 细横线」，读起来像圆圈加横线而不是人；
   * 实心剪影是这类图标最通用的画法，辨识度最高。
   */
  mine: {
    label: '我的',
    shapes: [
      { type: 'circle', cx: 50, cy: 33, r: 17 },
      { type: 'capsule', x1: 22, y1: 84, x2: 78, y2: 84, w: 30 }
    ]
  }
};

/* ===================== 光栅化 ===================== */

/**
 * 把形状集合渲染成 RGBA 像素（含超采样抗锯齿）
 * @param {object} icon ICONS 里的一项
 * @param {number[]} color [r,g,b]
 * @returns {Buffer} RGBA 数据，长度 SIZE*SIZE*4
 */
function rasterize(icon, color) {
  const big = SIZE * SS;
  // 覆盖度累积缓冲（超采样时每个子像素贡献 1）
  const cov = new Float32Array(SIZE * SIZE);

  for (let by = 0; by < big; by += 1) {
    const v = (by + 0.5) / big;
    for (let bx = 0; bx < big; bx += 1) {
      const u = (bx + 0.5) / big;

      let on = false;
      for (let i = 0; i < icon.shapes.length; i += 1) {
        const s = icon.shapes[i];
        if (hit(s, u, v)) {
          if (s.subtract) { on = false; break; }
          on = true;
        }
      }
      if (!on) continue;

      // 归入目标像素
      const px = Math.floor(bx / SS);
      const py = Math.floor(by / SS);
      cov[py * SIZE + px] += 1;
    }
  }

  const maxCov = SS * SS;
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    const a = Math.min(1, cov[i] / maxCov);
    out[i * 4 + 0] = color[0];
    out[i * 4 + 1] = color[1];
    out[i * 4 + 2] = color[2];
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

/* ===================== 最小 PNG 编码器 ===================== */

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA 像素 → PNG Buffer */
function encodePng(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // 每行前加一个 filter 字节（0 = None）
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ===================== 主流程 ===================== */

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

let count = 0;
Object.keys(ICONS).forEach((key) => {
  const icon = ICONS[key];
  [
    { suffix: '', color: COLOR_OFF, name: '未选中' },
    { suffix: '-on', color: COLOR_ON, name: '选中' }
  ].forEach((variant) => {
    const rgba = rasterize(icon, variant.color);
    const png = encodePng(rgba, SIZE, SIZE);
    const file = path.join(OUT_DIR, key + variant.suffix + '.png');
    fs.writeFileSync(file, png);
    count += 1;
    console.log('  ' + (key + variant.suffix + '.png').padEnd(16) +
      icon.label + '（' + variant.name + '）  ' + png.length + ' 字节');
  });
});

console.log('');
console.log('已生成 ' + count + ' 个图标 → static/tabbar/');
console.log('尺寸 ' + SIZE + '×' + SIZE + '，' + SS + ' 倍超采样抗锯齿');
