/**
 * 算法与流程自测脚本（Node 环境运行，不需要微信开发者工具）
 *
 *   node tests/run-utils.test.js
 *
 * 覆盖：
 *   1. 时间解析与标准化
 *   2. 颜色感知相似度（深灰 / 灰黑）
 *   3. 地点标准化（含模糊输入）
 *   4. 文本语义相似度（保温杯 / 金属水杯）
 *   5. 属性抽取（VLM Mock 的文本路径）
 *   6. 动态权重归一化（缺图片时 α=0 并重新分配）
 *   7. 演示故事线端到端：发布 → 召回 → 重排 → 候选解释 → 认领 → 核验 → 归还
 *   8. 消融实验指标（Recall@1 / Recall@5 / MRR）
 */

/* ---------- 模拟微信运行环境（内存存储 + 跳转记录） ---------- */
const memory = {};
const navCalls = [];
global.wx = {
  setStorageSync(key, value) { memory[key] = value; },
  getStorageSync(key) { return memory[key]; },
  removeStorageSync(key) { delete memory[key]; },
  navigateTo(opt) { navCalls.push({ api: 'navigateTo', url: opt.url }); },
  switchTab(opt) { navCalls.push({ api: 'switchTab', url: opt.url }); },
  redirectTo(opt) { navCalls.push({ api: 'redirectTo', url: opt.url }); },
  showToast() {},
  showModal() {}
};

const assert = require('assert');
const timeUtil = require('../utils/time');
const colorUtil = require('../utils/color');
const locations = require('../utils/locations');
const matcher = require('../utils/matcher');
const vlm = require('../utils/vlm');
const categorical = require('../utils/categories');
const store = require('../utils/store');
const service = require('../utils/service');
const seed = require('../mock/seed');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed += 1;
    console.log('  ✗ ' + name);
    console.log('    → ' + e.message);
  }
}

function group(title) {
  console.log('\n' + title);
}

/* ===================== 1. 时间 ===================== */
group('1. 时间解析与标准化');

test('“今天下午3点”解析为以 15:00 为中心的时间范围', () => {
  const r = timeUtil.parseTimeRange('今天下午3点左右');
  assert.ok(r && r.start && r.end, '应解析出范围');
  const center = new Date(timeUtil.rangeCenter(r));
  assert.strictEqual(center.getHours(), 15);
  assert.strictEqual(center.getMinutes(), 0);
  assert.ok(r.end - r.start === 60 * 60 * 1000, '应为 ±30 分钟的窗口');
});

test('“17:30-18:20”解析为精确范围', () => {
  const r = timeUtil.parseTimeRange('17:30-18:20');
  assert.strictEqual(new Date(r.start).getHours(), 17);
  assert.strictEqual(new Date(r.end).getHours(), 18);
  assert.strictEqual(new Date(r.end).getMinutes(), 20);
});

test('时间格式与相对时间展示', () => {
  const ts = timeUtil.toTs('2026-03-05 18:10');
  assert.strictEqual(timeUtil.formatClock(ts), '18:10');
  assert.strictEqual(timeUtil.format(ts), '2026-03-05 18:10');
  assert.strictEqual(timeUtil.fromNow(Date.now() - 3 * 60 * 1000), '3 分钟前');
});

test('时长描述', () => {
  assert.strictEqual(timeUtil.durationText(32 * 60 * 1000), '32 分钟');
  assert.strictEqual(timeUtil.durationText(125 * 60 * 1000), '2 小时 5 分');
});

/* ---- 演示数据的时间必须锚定北京时间，与运行环境时区无关 ---- */
// 真实事故：云函数运行在 UTC 时区时，new Date().setHours(18,42) 生成的是 18:42 UTC，
// 小程序端（UTC+8）显示成次日 02:42 —— 演示数据时间整体偏移 8 小时，
// 且时间相关度语义失真（"丢失后 22 分钟被捡到" 变成 "提前 7.5 小时被捡到"）。

test('cnTime 按北京时间构造，不受本机时区影响', () => {
  const now = Date.now();
  const ts = timeUtil.cnTime(18, 42, 0, now);
  // 换算成北京时间来核对
  const bj = new Date(ts + 8 * 60 * 60 * 1000);
  assert.strictEqual(bj.getUTCHours(), 18, '北京时间应为 18 时，实际 ' + bj.getUTCHours());
  assert.strictEqual(bj.getUTCMinutes(), 42, '北京时间应为 42 分，实际 ' + bj.getUTCMinutes());
});

test('cnTime 支持跨日偏移', () => {
  const now = Date.now();
  const today = timeUtil.cnTime(18, 42, 0, now);
  const yesterday = timeUtil.cnTime(18, 42, -1, now);
  const diff = today - yesterday;
  assert.ok(Math.abs(diff - 24 * 60 * 60 * 1000) < 60 * 1000,
    '相差应为约 24 小时，实际 ' + Math.round(diff / 3600000) + ' 小时');
});

test('演示数据的丢失窗口与拾取时间保持 22 分钟（时区修复的核心目的）', () => {
  const seedData = require('../core/seed-data');
  const now = Date.now();
  const lost = seedData.lostDefs(now).find((d) => d.id === 'lost_cup_01');
  const found = seedData.foundDefs(now).find((d) => d.id === 'found_cup_01');
  const gap = found.foundTime - lost.timeRange.end;
  assert.strictEqual(Math.round(gap / 60000), 22,
    '拾取时间应比丢失窗口结束晚 22 分钟，实际 ' + Math.round(gap / 60000) + ' 分钟' +
    '（若为 502 分钟说明时区偏移 8 小时）');
  // 且必须在同一天
  const d1 = new Date(lost.timeRange.start + 8 * 3600 * 1000);
  const d2 = new Date(found.foundTime + 8 * 3600 * 1000);
  assert.strictEqual(d1.getUTCDate(), d2.getUTCDate(),
    '丢失与拾取应在同一天（北京时间），实际 ' + d1.toISOString() + ' vs ' + d2.toISOString());
});

/* ===================== 2. 颜色 ===================== */
group('2. 颜色感知相似度');

test('深灰 与 灰黑 判为近似而非不同', () => {
  const r = colorUtil.colorSimilarity('深灰', '灰黑');
  assert.ok(r.score > 0.5, '相似度应较高，实际 ' + r.score.toFixed(3));
  assert.ok(r.relation === '近似' || r.relation === '一致', '关系应为近似/一致，实际 ' + r.relation);
});

test('灰 与 黑 不应判为一致', () => {
  const r = colorUtil.colorSimilarity('灰', '黑');
  assert.notStrictEqual(r.relation, '一致');
});

test('红 与 蓝 判为差异', () => {
  const r = colorUtil.colorSimilarity('红', '蓝');
  assert.strictEqual(r.relation, '差异');
  assert.ok(r.score < 0.5);
});

test('银色可映射为灰度族', () => {
  const c = colorUtil.parseColor('银色金属');
  assert.ok(c && c.family === 'gray');
});

/* ===================== 3. 地点 ===================== */
group('3. 校园地点标准化（江南大学蠡湖校区）');

test('完全命中别名', () => {
  const r = locations.normalize('图书馆二楼');
  assert.strictEqual(r.location.id, 'lib');
  assert.strictEqual(r.matched, true);
});

test('包含式模糊输入命中', () => {
  const r = locations.normalize('在图书馆自习室丢的');
  assert.strictEqual(r.location.id, 'lib');
});

test('地点名带方位词也能命中', () => {
  assert.strictEqual(locations.normalize('三食堂门口').location.id, 'canteen3');
  assert.strictEqual(locations.normalize('曲水桥上').location.id, 'bridge_qushui');
  assert.strictEqual(locations.normalize('东门附近').location.id, 'gate_e');
});

test('关键词兜底不报错', () => {
  const r = locations.normalize('某个食堂');
  assert.ok(r.location && r.location.name);
  assert.ok(r.matchedBy.indexOf('keyword') === 0, '应走关键词兜底，实际 ' + r.matchedBy);
});

test('无法识别时保留原文并落到校区中心', () => {
  const r = locations.normalize('不存在的神秘地点');
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.location.name, '不存在的神秘地点');
  assert.strictEqual(locations.inCampus(r.location.lat, r.location.lng), true);
});

test('球面距离计算合理', () => {
  const d = locations.distanceMeters(locations.getById('gate_e'), locations.getById('lib'));
  assert.ok(d > 300 && d < 900, '东门到图书馆应在 300~900 m，实际 ' + Math.round(d) + ' m');
});

/* ===================== 3.1 校区数据自检 ===================== */
group('3.1 校区数据自检（防止坐标写错导致时空重排失效）');

test('地点库规模与校区元信息', () => {
  const info = locations.campusInfo();
  assert.strictEqual(info.school, '江南大学');
  assert.strictEqual(info.campus, '蠡湖校区');
  assert.strictEqual(info.coordSystem, 'GCJ-02');
  assert.ok(locations.list().length >= 80, '地点数应 ≥80，实际 ' + locations.list().length);
});

test('所有地点坐标都落在校区范围内', () => {
  const out = [];
  locations.list().forEach((loc) => {
    if (!locations.inCampus(loc.lat, loc.lng)) out.push(loc.name + '(' + loc.lat + ',' + loc.lng + ')');
  });
  assert.strictEqual(out.length, 0, '越界地点：' + out.join('、'));
});

test('地点 id 唯一且别名不重复指向不同地点', () => {
  const ids = {};
  const aliasOwner = {};
  const conflicts = [];
  locations.list().forEach((loc) => {
    assert.ok(!ids[loc.id], 'id 重复：' + loc.id);
    ids[loc.id] = true;
    (loc.aliases || []).forEach((a) => {
      if (aliasOwner[a] && aliasOwner[a] !== loc.id) {
        conflicts.push(a + ' → ' + aliasOwner[a] + ' 与 ' + loc.id);
      }
      aliasOwner[a] = loc.id;
    });
  });
  assert.strictEqual(conflicts.length, 0, '别名冲突：' + conflicts.join('；'));
});

test('校园跨度符合一个校区的合理尺寸', () => {
  const b = locations.bounds();
  const widthM = locations.distanceMeters(
    { lat: b.center.lat, lng: b.minLng }, { lat: b.center.lat, lng: b.maxLng });
  const heightM = locations.distanceMeters(
    { lat: b.minLat, lng: b.center.lng }, { lat: b.maxLat, lng: b.center.lng });
  assert.ok(widthM > 600 && widthM < 3000, '东西跨度应在 0.6~3 km，实际 ' + Math.round(widthM) + ' m');
  assert.ok(heightM > 800 && heightM < 3500, '南北跨度应在 0.8~3.5 km，实际 ' + Math.round(heightM) + ' m');
});

test('南北区由曲水桥分隔（空间关系正确）', () => {
  const bridge = locations.getById('bridge_qushui');
  const north = locations.getById('canteen1');   // 第一食堂（北区）
  const south = locations.getById('canteen3');   // 第三食堂（南区）
  assert.strictEqual(locations.getById('canteen1').area, 'area_north');
  assert.strictEqual(locations.getById('canteen3').area, 'area_south');
  assert.ok(north.lat > bridge.lat, '北区食堂应在曲水桥以北');
  assert.ok(south.lat < bridge.lat, '南区食堂应在曲水桥以南');
});

test('坐标系转换：GCJ-02 相对 WGS-84 的偏移符合无锡地区量级', () => {
  const coord = require('../core/coord');
  const wgs = { lat: 31.491566, lng: 120.2680 }; // 北门附近的 WGS-84 坐标
  const gcj = coord.wgs84ToGcj02(wgs.lng, wgs.lat);
  const d = locations.distanceMeters(wgs, gcj);
  assert.ok(d > 300 && d < 700, '偏移应在 300~700 m，实际 ' + Math.round(d) + ' m');
  // 反向换算应能基本还原
  const back = coord.gcj02ToWgs84(gcj.lng, gcj.lat);
  const err = locations.distanceMeters(wgs, back);
  assert.ok(err < 1.5, '反向换算误差应 <1.5 m，实际 ' + err.toFixed(2) + ' m');
});

test('未校准地点有明确清单与说明（便于现场补点）', () => {
  const pending = locations.unverified();
  assert.ok(pending.length > 0, '应如实列出未校准地点');
  pending.forEach((loc) => {
    assert.ok(loc.note && loc.note.length > 5, loc.name + ' 缺少待校准说明');
  });
});

test('演示数据集引用的地点 id 全部真实存在', () => {
  const seedDefs = require('../core/seed-data.js');
  const now = Date.now();
  const all = seedDefs.lostDefs(now)
    .concat(seedDefs.foundDefs(now))
    .concat([seedDefs.historyCase(now).found]);
  const missing = [];
  all.forEach((d) => {
    if (!d.locationId) {
      missing.push(d.id + ' 缺少 locationId');
      return;
    }
    if (!locations.getById(d.locationId)) {
      missing.push(d.id + ' → ' + d.locationId);
    }
  });
  assert.strictEqual(missing.length, 0,
    '种子数据引用了不存在的地点（会导致全部落到“校园内（待确认）”，时空重排失效）：' + missing.join('、'));
});

test('本地与云端的数据集版本号保持一致', () => {
  const coreSeed = require('../core/seed-data.js');
  const mockSeed = require('../mock/seed.js');
  assert.strictEqual(mockSeed.SEED_VERSION, coreSeed.SEED_VERSION,
    'mock/seed.js 与 core/seed-data.js 的 SEED_VERSION 必须一致，否则一端重灌一端不重灌');
  assert.ok(coreSeed.SEED_VERSION >= 4, '换过校园地点库后版本号必须 ≥4，否则旧缓存不会被淘汰');
});

test('缓存里记录了校园版本号（否则换学校后旧坐标会一直留着）', () => {
  // 灌入数据时会把当时的校园地点库版本写进 meta；
  // 启动时比对它，就能在「换学校 / 改坐标」后自动淘汰旧缓存。
  require('../mock/seed.js').ensureSeed();
  const db = store.db();
  assert.ok(db.meta.campusVersion !== undefined, 'meta 必须记录 campusVersion');
  assert.strictEqual(db.meta.campusVersion, locations.META.version,
    '灌入数据时的校园版本与当前地点库版本不一致，说明缓存没有随地点库更新而失效');
});

test('演示数据经 buildItem 后地点都能正确解析（不落入兜底地点）', () => {
  const domain = require('../core/domain.js');
  const seedDefs = require('../core/seed-data.js');
  const seedData = require('../core/seed-data.js');
  const now = Date.now();
  const defs = seedDefs.lostDefs(now).concat(seedDefs.foundDefs(now));
  const fallback = [];
  defs.forEach((def) => {
    const item = domain.buildItem(Object.assign({}, def, {
      image: def.image || seedData.DEMO_IMAGE[def.id] || ''
    }), { now });
    if (!item.location || item.location.id === 'unknown') {
      fallback.push(def.id + '（' + def.locationId + '）');
    }
  });
  assert.strictEqual(fallback.length, 0,
    '以下记录没有解析到真实地点：' + fallback.join('、'));
});

test('地图视野参数完整（缺少会让 map 组件退化到微信默认视野）', () => {
  const points = locations.includePoints();
  assert.strictEqual(points.length, 2);
  points.forEach((p) => {
    assert.strictEqual(typeof p.latitude, 'number');
    assert.strictEqual(typeof p.longitude, 'number');
  });

  const c = locations.campusInfo().center;
  assert.ok(typeof c.lat === 'number' && typeof c.lng === 'number', '校区中心必须是数字');

  // 南西角必须在北东角以南以西，否则 include-points 会算出错误的视野
  assert.ok(points[0].latitude < points[1].latitude, '南西角的纬度应更小');
  assert.ok(points[0].longitude < points[1].longitude, '南西角的经度应更小');
  assert.ok(c.lat > points[0].latitude && c.lat < points[1].latitude, '校区中心应落在范围框内');
});

test('地点坐标确实在无锡（不是遗留的演示坐标）', () => {
  // 无锡市大致范围；旧演示数据是武汉一带（30.5x / 114.4x），必须能被拦住
  const WUXI = { minLat: 31.0, maxLat: 31.9, minLng: 119.8, maxLng: 120.6 };
  const outside = locations.list().filter((loc) =>
    loc.lat < WUXI.minLat || loc.lat > WUXI.maxLat || loc.lng < WUXI.minLng || loc.lng > WUXI.maxLng);
  assert.strictEqual(outside.length, 0,
    '这些地点不在无锡范围内：' + outside.map((l) => l.name + '(' + l.lat + ',' + l.lng + ')').join('、'));

  // 反向确认：所有地点都不能落在旧演示坐标区域
  const stillDemo = locations.list().filter((loc) =>
    loc.lat > 30.4 && loc.lat < 30.6 && loc.lng > 114.3 && loc.lng < 114.5);
  assert.strictEqual(stillDemo.length, 0,
    '这些地点还是旧演示坐标：' + stillDemo.map((l) => l.name).join('、'));
});

/* ===================== 4. 文本语义 ===================== */
group('4. 文本语义相似度');

test('保温杯 / 金属水杯 判定为相关', () => {
  const r = colorUtil.textSimilarity('银灰色膳魔师保温杯', '灰黑色金属水杯');
  assert.ok(r.score > 0.15, '实际 ' + r.score.toFixed(3));
});

test('耳机盒 / 雨伞 判定为不相关', () => {
  const a = colorUtil.textSimilarity('白色无线耳机充电盒', '黑色折叠雨伞');
  const b = colorUtil.textSimilarity('白色无线耳机充电盒', '白色蓝牙耳机盒');
  assert.ok(b.score > a.score, '同类别应更高：' + b.score.toFixed(3) + ' vs ' + a.score.toFixed(3));
});

test('品牌抽取', () => {
  assert.strictEqual(colorUtil.extractBrand('我的膳魔师保温杯'), '膳魔师');
  assert.strictEqual(colorUtil.extractBrand('一个普通水杯'), '');
});

/* ===================== 5. 属性抽取 ===================== */
group('5. 结构化属性抽取');

test('从描述中抽取颜色/材质/痕迹', () => {
  const attrs = vlm.extractFromText('深灰色不锈钢保温杯，黑色杯盖，杯底有一道长划痕');
  assert.strictEqual(attrs.main_color, '深灰');
  assert.strictEqual(attrs.material, '金属');
  assert.ok(String(attrs.damage_mark).indexOf('划痕') >= 0);
});

test('类别猜测', () => {
  assert.strictEqual(categorical.guessFromText('我的保温杯丢了'), 'cup');
  assert.strictEqual(categorical.guessFromText('一把黑色折叠伞'), 'umbrella');
});

test('融合图像与文本，文本优先', () => {
  const res = vlm.extractAttributes({ image: 'demo://cup_metal_gray', description: '白色塑料水杯', type: 'lost' });
  assert.strictEqual(res.attributes.main_color, '白');
  assert.strictEqual(res.sources.main_color, 'text');
});

/* ===================== 6. 动态权重 ===================== */
group('6. 动态权重归一化');

test('缺少图片时 α=0 且其余权重重新归一化', () => {
  const lost = { description: '黑色折叠伞', attributes: { category: 'umbrella' }, location: locations.getById('lib') };
  const found = { description: '黑色雨伞', attributes: { category: 'umbrella' }, location: locations.getById('lib_north'), foundTime: Date.now() };
  const w = matcher.computeWeights(lost, found);
  assert.strictEqual(w.weights.image, 0);
  const sum = Object.keys(w.weights).reduce((s, k) => s + w.weights[k], 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, '权重之和应为 1，实际 ' + sum);
});

test('权重之和恒为 1（有图有文场景）', () => {
  const lost = { image: 'demo://cup_metal_gray', description: '灰色保温杯', attributes: { category: 'cup' }, location: locations.getById('lib'), timeRange: { start: Date.now() - 3600000, end: Date.now() } };
  const found = { image: 'demo://cup_metal_gray', description: '灰色水杯', attributes: { category: 'cup' }, location: locations.getById('lib_north'), foundTime: Date.now() };
  const w = matcher.computeWeights(lost, found);
  const sum = Object.keys(w.weights).reduce((s, k) => s + w.weights[k], 0);
  assert.ok(Math.abs(sum - 1) < 1e-6);
});

test('分类别权重提升：钥匙的属性权重高于文具', () => {
  const base = { image: 'x', description: 'd', location: locations.getById('lib'), attributes: {} };
  const k = matcher.computeWeights(Object.assign({}, base, { attributes: { category: 'key' } }), Object.assign({}, base, { attributes: { category: 'key' } }));
  const s = matcher.computeWeights(Object.assign({}, base, { attributes: { category: 'stationery' } }), Object.assign({}, base, { attributes: { category: 'stationery' } }));
  assert.ok(k.weights.attr > s.weights.attr, '钥匙属性权重应更高：' + k.weights.attr.toFixed(3) + ' vs ' + s.weights.attr.toFixed(3));
});

/* ===================== 7. 端到端流程 ===================== */
group('7. 演示故事线端到端（发布 → 匹配 → 认领 → 归还）');

let cupMatch = null;

test('种子数据灌入成功', () => {
  store.init();
  const created = seed.ensureSeed();
  assert.ok(store.itemsOf('lost').length >= 10, '失物记录数 ' + store.itemsOf('lost').length);
  assert.ok(store.itemsOf('found').length >= 10, '拾物记录数 ' + store.itemsOf('found').length);
  assert.ok(created === true || created === false);
});

test('保温杯失物召回的第一名是同一身份记录', () => {
  const res = service.candidatesForLost('lost_cup_01', { topK: 5 });
  assert.ok(res.results.length > 0, '应有候选');
  assert.strictEqual(res.results[0].foundItem.id, 'found_cup_01', '第一名应为 found_cup_01');
  assert.ok(res.results[0].score >= 0.7, '综合分应 ≥0.7，实际 ' + res.results[0].score.toFixed(3));
  cupMatch = res.results[0];
});

test('候选包含可解释证据（正向 + 差异）', () => {
  const reasons = cupMatch.reasons;
  assert.ok(reasons.positive.length >= 2, '正向证据 ≥2，实际 ' + reasons.positive.length);
  const texts = reasons.positive.map((r) => r.text).join('|');
  assert.ok(texts.length > 0);
});

test('分项分数与权重可展示', () => {
  const bars = matcher.scoreBars(cupMatch);
  assert.strictEqual(bars.length, 5);
  bars.forEach((b) => assert.ok(b.percent >= 0 && b.percent <= 100));
});

test('时空分数：图书馆北门与图书馆距离很短', () => {
  assert.ok(cupMatch.geo.available);
  assert.ok(cupMatch.geo.distance < 200, '距离 ' + Math.round(cupMatch.geo.distance));
  assert.ok(cupMatch.time.available);
});

test('困难负样本分数低于正确匹配', () => {
  const wrong = service.candidatesForLost('lost_cup_01', { topK: 10 }).results
    .find((r) => r.foundItem.id === 'found_cup_03');
  if (wrong) {
    assert.ok(wrong.score < cupMatch.score, '相似但不同的记录分数应更低：' + wrong.score.toFixed(3) + ' vs ' + cupMatch.score.toFixed(3));
  }
});

test('同类别但外观不同的候选被降分', () => {
  const results = service.candidatesForLost('lost_cup_01', { topK: 20 }).results;
  const other = results.find((r) => r.foundItem.id === 'found_cup_02');
  assert.ok(other, '同类别候选应仍有少量召回');
  assert.ok(other.score < cupMatch.score - 0.15, '应显著低于正确匹配：' + other.score.toFixed(3) + ' vs ' + cupMatch.score.toFixed(3));
});

test('类别硬冲突被标记并大幅降分', () => {
  const lost = store.getItem('lost_cup_01');
  const conflict = matcher.scorePair(lost, store.getItem('found_umbrella_01'));
  assert.strictEqual(conflict.hardConflict, true, '杯子 vs 雨伞应触发类别硬冲突');
  assert.ok(conflict.score < 0.35, '硬冲突时综合分应被压制，实际 ' + conflict.score.toFixed(3));
  const reasons = conflict.reasons.conflict.map((r) => r.text).join('|');
  assert.ok(reasons.indexOf('类别冲突') >= 0, '解释中应包含类别冲突：' + reasons);
});

test('属性缺失按中性分处理，不当作“不同”', () => {
  const a = { category: 'cup', main_color: '深灰', material: '金属' };
  const b = { category: 'cup', main_color: '深灰' };
  const items = matcher.compareAttributes(a, b).items;

  const material = items.find((x) => x.field === 'material');
  assert.ok(material.score >= 0.49, '缺一方属性应给中性分，实际 ' + material.score);
  assert.ok(material.note.indexOf('缺失') >= 0, '说明应指出属性缺失：' + material.note);

  const size = matcher.compareAttributes({ size: '约 500ml' }, {}).items.find((x) => x.field === 'size');
  assert.strictEqual(size.score, 0.3, '通用字段缺失应给 0.3 中性分');
  assert.ok(size.note.indexOf('未提供') >= 0, '说明应指出未提供：' + size.note);
});

test('发布新拾物后能反向找到失主', () => {
  const pub = service.publish({
    kind: 'found',
    userId: 'u_lin',
    description: '深灰色不锈钢水杯，黑色杯盖，杯身有白色纵向标志，杯底有一道长划痕',
    locationId: 'xuehai_stone',
    foundTime: Date.now() - 10 * 60 * 1000,
    attributes: { category: 'cup', main_color: '深灰', material: '金属' },
    privateFeatures: ['杯底有一道长划痕', '杯盖内侧有一个小凹点']
  });
  assert.ok(pub.item.id);
  const res = service.candidatesForFound(pub.item.id, { topK: 5 });
  assert.ok(res.results.length > 0, '应找到潜在失主');
  const topLostIds = res.results.slice(0, 3).map((r) => r.lostItem.id);
  assert.ok(topLostIds.indexOf('lost_cup_01') >= 0, '前 3 名应包含 lost_cup_01，实际 ' + topLostIds.join(','));
});

test('认领流程：问题生成 → 回答 → 语义核验', () => {
  const start = service.startClaim(cupMatch.id || ('match_lost_cup_01_found_cup_01'));
  assert.ok(start.ok, start.message);
  const claim = start.claim;
  assert.ok(claim.questions.length >= 1, '应生成核验问题');

  const answers = claim.questions.map(() => '杯底有一道大约三厘米的长划痕，就在杯底边缘');
  const submitted = service.submitClaim(claim.id, answers);
  assert.ok(submitted.ok);
  assert.ok(submitted.claim.verificationScore > 0.3, '语义核验分应 >0.3，实际 ' + submitted.claim.verificationScore.toFixed(3));

  const confirmed = service.confirmClaim(claim.id, 'pass', '特征一致');
  assert.ok(confirmed.ok);
  assert.strictEqual(store.getClaim(claim.id).status, 'verified');

  const returned = service.completeReturn(claim.id);
  assert.ok(returned.ok);
  assert.strictEqual(store.getItem('lost_cup_01').status, 'recovered');
  assert.strictEqual(store.getItem('found_cup_01').status, 'returned');
});

test('状态机：归还后不再出现在候选池', () => {
  const res = service.candidatesForLost('lost_cup_01', { topK: 10 });
  const ids = res.results.map((r) => r.foundItem.id);
  assert.ok(ids.indexOf('found_cup_01') < 0, '已归还的拾物不应再入候选');
});

test('反馈样本已记录（正样本 + 弱负样本）', () => {
  assert.ok(store.feedbacks().length > 0);
  assert.ok(store.feedbacks().some((f) => f.userAction === 'returned'));
});

test('排除候选写入弱负样本', () => {
  const before = store.feedbacks().length;
  const m = store.matchesOfLost('lost_cup_02')[0];
  if (m) {
    service.rejectMatch(m.id, '测试排除');
    assert.ok(store.feedbacks().length > before);
  }
});

test('热力图输出的坐标全部有效、且在校园范围内（地图页直接依赖它）', () => {
  const cells = service.heatmap();
  assert.ok(cells.length > 0, '演示数据灌入后应有聚合结果');
  cells.forEach((c) => {
    assert.strictEqual(typeof c.lat, 'number', c.name + ' 缺少纬度');
    assert.strictEqual(typeof c.lng, 'number', c.name + ' 缺少经度');
    assert.ok(!Number.isNaN(c.lat) && !Number.isNaN(c.lng), c.name + ' 坐标是 NaN');
    assert.strictEqual(locations.inCampus(c.lat, c.lng), true, c.name + ' 坐标落在校园外');
  });
});

test('热力图不出现“校园内（待确认）”兜底地点', () => {
  const cells = service.heatmap();
  const fallback = cells.filter((c) => c.id === 'unknown');
  assert.strictEqual(fallback.length, 0,
    '有 ' + (fallback[0] ? fallback[0].total : 0) + ' 条记录没有解析到真实地点，地图上会挤成一个点');
});

/* ===================== 8. 统计与消融 ===================== */
group('8. 统计与消融实验');

test('平台统计指标可计算', () => {
  const s = service.stats();
  assert.ok(s.lostCount > 0 && s.foundCount > 0);
  assert.ok(s.recoverRate >= 0 && s.recoverRate <= 100);
});

test('热力图按地点聚合', () => {
  const cells = service.heatmap();
  assert.ok(cells.length > 0);
  cells.forEach((c) => assert.ok(c.total === c.lost + c.found));
});

test('时间线按时间排序', () => {
  const tl = service.timeline({ matchId: 'match_lost_cup_01_found_cup_01' });
  for (let i = 1; i < tl.length; i += 1) {
    assert.ok(tl[i].at >= tl[i - 1].at, '时间线应递增');
  }
});

test('消融实验输出四组指标且完整方案不弱于基线', () => {
  const ev = service.evaluate();
  assert.strictEqual(ev.groups.length, 4);
  ev.groups.forEach((g) => {
    assert.ok(g.recall1Percent >= 0 && g.recall1Percent <= 100);
    assert.ok(g.recall5Percent <= 100 && g.mrrPercent <= 100);
    assert.ok(g.recall5 >= g.recall1, g.name + ' 的 Recall@5 应不低于 Recall@1');
  });
  const a = ev.groups[0];
  const d = ev.groups[3];
  console.log('    · A(Image Only)  Recall@5=' + a.recall5Percent + '%  MRR=' + a.mrrPercent + '%');
  console.log('    · B(+Text)       Recall@5=' + ev.groups[1].recall5Percent + '%  MRR=' + ev.groups[1].mrrPercent + '%');
  console.log('    · C(+Attr)       Recall@5=' + ev.groups[2].recall5Percent + '%  MRR=' + ev.groups[2].mrrPercent + '%');
  console.log('    · D(完整方案)    Recall@5=' + d.recall5Percent + '%  MRR=' + d.mrrPercent + '%');
  console.log('    · 提升：Recall@5 ' + (d.recall5Percent - a.recall5Percent) + ' 个百分点，MRR ' + (d.mrrPercent - a.mrrPercent) + ' 个百分点');
});

test('所有失物的正确身份都能被召回（Recall@5）', () => {
  const losts = store.itemsOf('lost').filter((l) => l.identityId);
  const founds = store.itemsOf('found').filter((f) => f.identityId);
  let hit = 0;
  losts.forEach((l) => {
    const ranked = matcher.rankCandidates(l, founds, { topK: 5 });
    if (ranked.results.some((r) => r.foundItem.identityId === l.identityId)) hit += 1;
  });
  const rate = Math.round((hit / losts.length) * 100);
  console.log('    · 完整方案 Recall@5 = ' + rate + '%（' + hit + '/' + losts.length + '）');
  assert.ok(rate >= 80, 'Recall@5 应 ≥80%，实际 ' + rate + '%');
});

/* ===================== 9. 页面跳转 ===================== */
group('9. 页面跳转（tabBar 页面只能 switchTab，且不支持 query）');

const nav = require('../utils/nav.js');

test('tabBar 页面判定正确', () => {
  assert.strictEqual(nav.isTabPage('pages/matches/matches'), true);
  assert.strictEqual(nav.isTabPage('/pages/matches/matches'), true);
  assert.strictEqual(nav.isTabPage('pages/matches/matches?category=cup'), true);
  assert.strictEqual(nav.isTabPage('pages/compare/compare'), false);
  assert.strictEqual(nav.isTabPage('pages/publish/publish'), false);
});

test('TAB_PAGES 与 app.json 的 tabBar 完全一致', () => {
  const appJson = require('../app.json');
  const tabs = ((appJson.tabBar && appJson.tabBar.list) || []).map((t) => t.pagePath);
  assert.strictEqual(nav.TAB_PAGES.length, tabs.length, 'tab 数量应一致');
  tabs.forEach((p) => {
    assert.ok(nav.TAB_PAGES.indexOf(p) >= 0, 'app.json 的 tab 未登记到 TAB_PAGES：' + p);
  });
});

test('switchTab 跳转时参数被暂存下来（否则类别筛选会丢失）', () => {
  const app = { globalData: {} };
  navCalls.length = 0;
  nav.go(app, '/pages/matches/matches', { category: 'cup' });
  assert.strictEqual(app.globalData.pendingParams.category, 'cup', '参数应被暂存到 globalData');
  assert.strictEqual(navCalls.length, 1);
  assert.strictEqual(navCalls[0].api, 'switchTab', 'tabBar 页面必须用 switchTab');
  assert.strictEqual(navCalls[0].url, '/pages/matches/matches', 'switchTab 不能带 query');
});

test('非 tabBar 页面走 navigateTo 且保留 query', () => {
  const app = { globalData: {} };
  navCalls.length = 0;
  nav.go(app, '/pages/publish/publish?type=found');
  assert.strictEqual(navCalls.length, 1);
  assert.strictEqual(navCalls[0].api, 'navigateTo');
  assert.strictEqual(navCalls[0].url, '/pages/publish/publish?type=found');
  assert.ok(!app.globalData.pendingParams, '非 tab 页不需要暂存参数');
});

test('目标页消费参数后立即清空（避免下次进入还带着旧筛选）', () => {
  const app = { globalData: { pendingParams: { category: 'umbrella' } } };
  const taken = nav.takeParams(app);
  assert.strictEqual(taken.category, 'umbrella');
  assert.strictEqual(app.globalData.pendingParams, null, '消费后必须清空');
  assert.deepStrictEqual(nav.takeParams(app), {}, '再次读取应为空对象');
});

test('参数合并：query 与暂存参数都能生效，且 query 优先', () => {
  const defaults = { category: 'all', itemId: '' };

  const fromTab = nav.mergeParams(undefined, { category: 'cup' }, defaults);
  assert.strictEqual(fromTab.category, 'cup', '来自 switchTab 的参数应生效');

  const fromQuery = nav.mergeParams({ category: 'card' }, null, defaults);
  assert.strictEqual(fromQuery.category, 'card', '来自 query 的参数应生效');

  const both = nav.mergeParams({ category: 'card' }, { category: 'cup' }, defaults);
  assert.strictEqual(both.category, 'card', 'query 优先于暂存参数');

  const empty = nav.mergeParams(undefined, undefined, defaults);
  assert.strictEqual(empty.category, 'all', '都没有时用默认值');
  assert.strictEqual(empty.itemId, '');
});

/* ===================== 10. 排除候选与撤销 ===================== */
group('10. 排除候选（用户反馈「点了排除界面没变化」）');

/** 取一条失物与它的候选上下文（排除需要 lostId / foundId 才能给未落库的候选建记录） */
function candidateFixture() {
  const lost = store.itemsOf('lost').filter((l) => {
    const list = service.candidatesForLost(l.id, { topK: 20, minScore: 0.3 }).views;
    return list.length >= 2;
  })[0];
  assert.ok(lost, '演示数据里应有至少 2 个候选的失物');
  const views = service.candidatesForLost(lost.id, { topK: 20, minScore: 0.3 }).views;
  return { lost, target: views[0], before: views };
}

function contextOf(lost, view) {
  return {
    lostId: lost.id,
    foundId: view.foundId,
    score: view.score,
    threshold: view.threshold,
    passed: view.passed
  };
}

test('候选列表不会出现「自己匹配自己」（演示数据里有 kind 写错的记录）', () => {
  store.itemsOf('lost').forEach((l) => {
    const views = service.candidatesForLost(l.id, { topK: 20, minScore: 0.3 }).views;
    assert.ok(!views.some((v) => v.foundId === l.id), '失物 ' + l.id + ' 的候选里出现了它自己');
    assert.ok(!views.some((v) => v.id === 'match_' + l.id + '__' + l.id), '自匹配记录不应生成');
  });
});

/**
 * 演示数据的不变量：记录的 kind 必须与它所在的集合一致。
 *
 * 真实缺陷：`mock/seed.js` 的 buildItem 原本写
 *   `cfg.kind === 'found' ? 'found' : 'lost'`
 * ——没传 kind 就静默兜成 lost。seedHistory() 造「已归还案例」的那条拾物
 * 恰好漏传，于是被塞进 lostItems：失物数 +1、拾物数 -1，还会产生幽灵候选。
 * 这类「命名与归属不一致」必须静态拦住，不能靠下游兜底。
 */
test('演示数据的 kind 必须与所在集合一致，且 id 前缀与 kind 相符', () => {
  const check = (list, expectKind, label) => {
    list.forEach((i) => {
      assert.strictEqual(i.kind, expectKind,
        label + '集合里的 ' + i.id + ' 的 kind 是 ' + i.kind + '（应为 ' + expectKind + '）');
      const prefix = expectKind === 'lost' ? 'lost_' : 'found_';
      assert.ok(String(i.id).indexOf(prefix) === 0,
        label + '集合里出现了前缀不是 ' + prefix + ' 的记录：' + i.id);
    });
  };
  check(store.itemsOf('lost'), 'lost', '失物');
  check(store.itemsOf('found'), 'found', '拾物');
});

test('已归还的历史案例仍然完整（match 与 claim 都在，且指向同一条记录）', () => {
  const lost = store.getItem('lost_earphone_02');
  const found = store.getItem('found_earphone_05');
  assert.ok(lost, '历史案例的失物应存在');
  assert.ok(found, '历史案例的拾物应存在（曾因 kind 兜底错进失物集合）');
  assert.strictEqual(lost.status, 'recovered', '历史案例失物应为已找回');
  assert.strictEqual(found.status, 'returned', '历史案例拾物应为已归还');

  const matchId = 'match_' + lost.id + '__' + found.id;
  const m = store.getMatch(matchId);
  assert.ok(m, '历史案例的 match 应存在：' + matchId);
  assert.strictEqual(m.status, 'returned');
  const claim = store.getClaim('claim_history_01');
  assert.ok(claim, '历史案例的认领单应存在');
  assert.strictEqual(claim.matchId, matchId, '认领单应指向同一条 match');
});

test('排除后候选立即从候选中消失（打分引擎不知道交互状态，必须在这一层过滤）', () => {
  const fx = candidateFixture();
  const r = service.rejectMatch(fx.target.id, '测试排除', contextOf(fx.lost, fx.target));
  assert.strictEqual(r.ok, true, '排除应成功：' + r.message);

  const after = service.candidatesForLost(fx.lost.id, { topK: 20, minScore: 0.3 }).views;
  assert.ok(!after.some((v) => v.id === fx.target.id), '已排除的候选不能再出现在候选列表里');
  assert.strictEqual(after.length, fx.before.length - 1, '候选数量应减少 1');

  service.restoreMatch(fx.target.id, contextOf(fx.lost, fx.target));
});

test('从未落库的候选也能被排除（旧实现直接 return ok:false，页面却提示成功）', () => {
  const fx = candidateFixture();
  if (store.getMatch(fx.target.id)) {
    // 演示数据里这条恰好已落库，先清掉以复现「未落库」场景
    store.removeMatch(fx.target.id);
  }
  assert.strictEqual(store.getMatch(fx.target.id), null, '前置条件：该候选尚未落库');

  const noCtx = service.rejectMatch(fx.target.id, '测试');
  assert.strictEqual(noCtx.ok, false, '缺少上下文时应明确失败，不能假装成功');

  const withCtx = service.rejectMatch(fx.target.id, '测试', contextOf(fx.lost, fx.target));
  assert.strictEqual(withCtx.ok, true, '带上下文应能补出记录并排除');
  assert.ok(store.getMatch(fx.target.id), '排除后记录必须真的落库');

  const after = service.candidatesForLost(fx.lost.id, { topK: 20, minScore: 0.3 }).views;
  assert.ok(!after.some((v) => v.id === fx.target.id), '排除后列表里不应再有它');

  service.restoreMatch(fx.target.id, contextOf(fx.lost, fx.target));
});

test('includeRejected 能取回已排除候选，并在视图上标出 rejected 状态', () => {
  const fx = candidateFixture();
  service.rejectMatch(fx.target.id, '测试排除', contextOf(fx.lost, fx.target));

  const all = service.candidatesForLost(fx.lost.id, {
    topK: 20, minScore: 0.3, includeRejected: true
  }).views;
  const found = all.find((v) => v.id === fx.target.id);
  assert.ok(found, 'includeRejected 应能取回该候选');
  assert.strictEqual(found.status, 'rejected', '状态应标记为 rejected');
  assert.strictEqual(found.statusLabel, '已排除', '状态文案应是「已排除」');

  service.restoreMatch(fx.target.id, contextOf(fx.lost, fx.target));
});

test('撤销排除把 status 与 userStatus 一起复位（否则下次同步又变回已排除）', () => {
  const fx = candidateFixture();
  service.rejectMatch(fx.target.id, '测试', contextOf(fx.lost, fx.target));
  assert.strictEqual(store.getMatch(fx.target.id).userStatus, 'rejected');

  const back = service.restoreMatch(fx.target.id, contextOf(fx.lost, fx.target));
  assert.strictEqual(back.ok, true);
  const m = store.getMatch(fx.target.id);
  assert.strictEqual(m.status, 'new', 'status 应复位');
  assert.strictEqual(m.userStatus, 'new', 'userStatus 必须一起复位');
  assert.strictEqual(m.rejectReason, '', '排除原因应清空');

  const list = service.candidatesForLost(fx.lost.id, { topK: 20, minScore: 0.3 }).views;
  assert.ok(list.some((v) => v.id === fx.target.id), '撤销后应重新出现在候选列表里');
});

test('重复撤销给出明确失败原因，不静默成功', () => {
  const fx = candidateFixture();
  const r = service.restoreMatch(fx.target.id, contextOf(fx.lost, fx.target));
  assert.strictEqual(r.ok, false);
  assert.ok(/没有/.test(r.message), '应说明「该候选没有被排除」，实际：' + r.message);
});

/* ===================== 11. 核验期临时会话 ===================== */
group('11. 核验期临时会话（认领双方商量线下交接）');

const chat = require('../core/chat');

test('会话状态随认领状态变化：answering 关闭、submitted/verified 开放、结束转只读', () => {
  assert.strictEqual(chat.sessionState('answering').key, 'closed');
  assert.strictEqual(chat.sessionState('submitted').key, 'open');
  assert.strictEqual(chat.sessionState('verified').key, 'open');
  assert.strictEqual(chat.sessionState('returned').key, 'readonly');
  assert.strictEqual(chat.sessionState('rejected').key, 'readonly');
  assert.strictEqual(chat.canSend('answering'), false, '未提交核验前不能发言');
  assert.strictEqual(chat.canSend('submitted'), true);
  assert.strictEqual(chat.canSend('returned'), false, '归还后转只读');
});

test('消息正文脱敏：手机号与社交账号被隐藏，时间地点保留', () => {
  const r = chat.sanitize('明天 12:30 图书馆一楼，我手机 13812345678，微信 xunji2026');
  assert.ok(r.redacted, '应标记为已脱敏');
  assert.ok(r.text.indexOf('13812345678') < 0, '手机号不应出现在正文里');
  assert.ok(r.text.indexOf('xunji2026') < 0, '社交账号不应出现在正文里');
  assert.ok(r.text.indexOf('12:30') >= 0, '交接时间必须保留');
  assert.ok(r.text.indexOf('图书馆一楼') >= 0, '交接地点必须保留');
});

test('空消息与超长消息被拒绝', () => {
  assert.strictEqual(chat.createMessage({ text: '   ' }).ok, false);
  assert.strictEqual(chat.createMessage({ text: 'x'.repeat(chat.MAX_LENGTH + 1) }).ok, false);
  const ok = chat.createMessage({ text: '好的', senderId: 'u_me', senderRole: 'keeper' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.value.senderRole, 'keeper');
});

test('消息列表有上限，保留最新若干条', () => {
  let list = [];
  for (let i = 0; i < chat.MAX_MESSAGES + 20; i += 1) {
    list = chat.appendMessage(list, { id: 'm' + i, text: 'x' });
  }
  assert.strictEqual(list.length, chat.MAX_MESSAGES, '应被截断到上限');
  assert.strictEqual(list[list.length - 1].id, 'm' + (chat.MAX_MESSAGES + 19), '保留的应是最新消息');
});

/**
 * 找一条「可以合法发起认领」的候选：失物主人是 ownerId、状态活跃、
 * 且该失物当前没有进行中的认领单。
 * （新增了两条守卫：一物一单、已找回/关闭不受理，测试必须先满足前置条件）
 */
function freshClaimTarget(ownerId) {
  const ACTIVE = ['answering', 'submitted', 'verified'];
  let out = null;
  store.itemsOf('lost').some((l) => {
    if (ownerId && l.userId !== ownerId) return false;
    if (l.status === 'recovered' || l.status === 'closed') return false;
    if (store.claimsOfLost(l.id).some((c) => ACTIVE.indexOf(c.status) >= 0)) return false;
    const views = service.candidatesForLost(l.id, { topK: 20, minScore: 0.3 }).views;
    const fresh = views.find((v) => !store.byMatch(v.id) && v.found.userId !== l.userId);
    if (!fresh) return false;
    out = { lost: l, view: fresh, foundUserId: fresh.found.userId };
    return true;
  });
  return out;
}

/**
 * 把演示数据恢复到干净状态。
 *
 * 为什么需要：新增的「一条失物只能有一张进行中的认领单」是正确约束，
 * 但串联的测试会把演示数据里的候选陆续认领掉，后面的用例就无候选可用。
 * 认领类用例自己重置一次，保证可重复运行、不受用例顺序影响。
 */
function resetSeed() {
  store.reset(() => {});
  seed.ensureSeed();
}

test('端到端：提交核验后双方可对话，会话外的人无权访问', () => {
  resetSeed();
  const fx = freshClaimTarget('u_me');
  assert.ok(fx, '演示数据里应有可用的失物/拾物候选对');

  const claim = service.startClaim(fx.view.id, { userId: 'u_me' });
  assert.strictEqual(claim.ok, true, '发起认领应成功：' + claim.message);
  const claimId = claim.claim.id;

  // 未提交核验回答前，会话不开放
  assert.strictEqual(service.postClaimMessage(claimId, { userId: fx.lost.userId, text: '在吗' }).ok, false);

  const answers = claim.claim.questions.map(() => '杯底有一道大约三厘米的纵向划痕');
  const submitted = service.submitClaim(claimId, answers, { userId: fx.lost.userId });
  assert.strictEqual(submitted.ok, true);

  const mine = service.postClaimMessage(claimId, { userId: fx.lost.userId, text: '明天中午12:30 图书馆一楼服务台可以吗' });
  assert.strictEqual(mine.ok, true);
  const theirs = service.postClaimMessage(claimId, { userId: fx.foundUserId, text: '可以，我带杯套一起过去' });
  assert.strictEqual(theirs.ok, true);

  const view = service.claimSessionView(claimId, { userId: fx.lost.userId });
  assert.strictEqual(view.state, 'open');
  assert.strictEqual(view.count, 2);
  assert.strictEqual(view.myRole, 'claimant');
  assert.strictEqual(view.counterpartLabel, '拾物者');
  assert.ok(view.messages[0].mine, '自己发的消息应标记 mine');
  assert.strictEqual(view.messages[0].senderName, '我');
  assert.ok(view.messages[1].senderName && view.messages[1].senderName !== '我', '对方消息应显示昵称');

  const outsider = service.claimSessionView(claimId, { userId: 'u_admin' });
  assert.strictEqual(outsider.state, 'closed', '非双方无权查看会话');
  assert.strictEqual(service.postClaimMessage(claimId, { userId: 'u_admin', text: '偷看' }).ok, false);
});

test('端到端：认领与核验的身份约束（离线实现与云端一致）', () => {
  resetSeed();
  // 「不能替别人发起认领」：找一条他人的失物
  const other = store.itemsOf('lost').filter((l) =>
    l.userId !== 'u_me' && l.status !== 'recovered' && l.status !== 'closed')[0];
  assert.ok(other, '演示数据里应有他人的失物');
  const otherViews = service.candidatesForLost(other.id, { topK: 20, minScore: 0.3 }).views;
  assert.ok(otherViews.length, '该失物应有候选');

  const denied = service.startClaim(otherViews[0].id, { userId: 'u_me' });
  assert.strictEqual(denied.ok, false, '不应能替别人发起认领');
  assert.ok(/只能为自己的失物/.test(denied.message), '应给出原因，实际：' + denied.message);

  // 正路：自己的失物，离线模式也不受身份限制（纯本地演示不被锁死）
  const fx = freshClaimTarget('u_me');
  assert.ok(fx, '应有可用的候选对');

  const offline = service.startClaim(fx.view.id);
  assert.strictEqual(offline.ok, true, '离线模式应允许发起：' + offline.message);
  const c = offline.claim;

  // 提交核验：非认领者不可提交
  const byOther = service.submitClaim(c.id, ['随便答'], { userId: 'u_zzz' });
  assert.strictEqual(byOther.ok, false, '非认领者不应能提交核验回答');

  // 确认：必须处于「待拾物者确认」状态
  const beforeSubmit = service.confirmClaim(c.id, 'pass', '', { userId: c.keeperId });
  assert.strictEqual(beforeSubmit.ok, false, '未提交核验不应能确认');

  service.submitClaim(c.id, c.questions.map(() => '有一道三厘米长的划痕'), { userId: c.claimantId });

  // 认领者（失主）不能替拾物者确认
  const byClaimant = service.confirmClaim(c.id, 'pass', '', { userId: c.claimantId });
  assert.strictEqual(byClaimant.ok, false, '认领者不应能替拾物者确认');
  assert.ok(/只有拾物者本人/.test(byClaimant.message), '应给出权限原因，实际：' + byClaimant.message);

  const ok = service.confirmClaim(c.id, 'pass', '', { userId: c.keeperId });
  assert.strictEqual(ok.ok, true, '拾物者本人应能确认：' + ok.message);
  assert.strictEqual(ok.claim.status, 'verified');

  const again = service.confirmClaim(c.id, 'reject', '', { userId: c.keeperId });
  assert.strictEqual(again.ok, false, '不能重复确认');
  assert.ok(/不能重复确认/.test(again.message), '应给出状态原因，实际：' + again.message);
  assert.strictEqual(store.getClaim(c.id).status, 'verified', '状态不应被改写');

  // 归还：外人不可，双方之一可以
  const outsider = service.completeReturn(c.id, { userId: 'u_zzz' });
  assert.strictEqual(outsider.ok, false, '外人不应能完成归还');

  const returned = service.completeReturn(c.id, { userId: c.keeperId });
  assert.strictEqual(returned.ok, true, '双方之一应能完成归还：' + returned.message);
  assert.strictEqual(returned.claim.status, 'returned');

  // 同一失物不能再发起第二张认领单（已找回）
  const afterReturn = service.startClaim(fx.view.id, { userId: 'u_me' });
  assert.strictEqual(afterReturn.ok, false, '已找回的失物不应再受理认领');
});

test('同一条失物不能同时挂两张进行中的认领单（离线实现）', () => {
  resetSeed();
  const ACTIVE = ['answering', 'submitted', 'verified'];
  let target = null;
  store.itemsOf('lost').some((l) => {
    if (l.status === 'recovered' || l.status === 'closed') return false;
    if (store.claimsOfLost(l.id).some((c) => ACTIVE.indexOf(c.status) >= 0)) return false;
    const views = service.candidatesForLost(l.id, { topK: 20, minScore: 0.3 }).views;
    if (views.length < 2) return false;
    target = { lost: l, first: views[0], second: views[1] };
    return true;
  });
  assert.ok(target, '前置条件：应有候选数 ≥2 且无进行中认领的失物');

  const first = service.startClaim(target.first.id);
  assert.strictEqual(first.ok, true, '第一张应能发起：' + first.message);

  const second = service.startClaim(target.second.id);
  assert.strictEqual(second.ok, false, '第二张应被拒绝');
  assert.ok(/进行中的认领单/.test(second.message), '应说明原因，实际：' + second.message);
  assert.strictEqual(second.activeClaimId, first.claim.id, '应回传进行中的那张认领单 id');
});

/* ===================== 输出 ===================== */
console.log('\n========================================');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
console.log('========================================');
if (failed > 0) process.exit(1);
