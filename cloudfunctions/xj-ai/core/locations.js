/**
 * 校园地点标准化库
 * ---------------------------------------------------------------
 * 数据实体在 core/campus-data.js（江南大学蠡湖校区，GCJ-02 坐标），
 * 本文件负责「把用户自由输入的文字归一化到标准地点」，并做空间计算。
 *
 * 设计要点（对应方案 8.2 与 15「地点精度问题」风险应对）：
 * 1. 校园场景不追求高精度 GPS，而是把建筑、食堂、道路、桥等离散地点
 *    映射为「区域中心点 + 别名」，既保证空间可计算，也避免暴露精确位置；
 * 2. 用户输入采用三级归一化策略：完全命中别名 → 包含式匹配 → 关键词兜底；
 * 3. 每个地点带 verified 标记：false 表示坐标是按相对位置估算的，
 *    需要用「校准地点坐标」工具重新取点。
 */

const campus = require('./campus-data');

const META = campus.META;
const AREAS = campus.AREAS;
const LOCATIONS = campus.LOCATIONS;

const LOCATION_MAP = {};
LOCATIONS.forEach((loc) => { LOCATION_MAP[loc.id] = loc; });

const CATE_LABEL = {
  learning: '图书馆',
  teaching: '教学楼馆',
  food: '食堂餐饮',
  dorm: '宿舍区',
  sport: '运动场所',
  public: '公共服务',
  gate: '校门出入口',
  scenic: '景观桥梁',
  road: '道路通行'
};

/** 未识别输入时的兜底地点（校区中心，时空权重会被自然降低） */
const UNKNOWN_LOCATION = {
  id: 'unknown',
  name: '校园内（待确认）',
  area: 'area_center',
  cate: 'public',
  lat: META.center.lat,
  lng: META.center.lng,
  aliases: [],
  verified: false,
  fallback: true
};

function list() {
  return LOCATIONS.slice();
}

function getById(id) {
  return LOCATION_MAP[id] || null;
}

function getByName(name) {
  if (!name) return null;
  return LOCATIONS.find((loc) => loc.name === name || (loc.aliases || []).indexOf(name) >= 0) || null;
}

function cateOf(id) {
  const loc = LOCATION_MAP[id];
  return loc ? loc.cate : 'public';
}

/** 尚未校准坐标的地点（用于提示用户去补点） */
function unverified() {
  return LOCATIONS.filter((loc) => loc.verified === false);
}

/**
 * 把用户自由输入的地点文字归一化为标准地点。
 * @param {string} raw 用户输入
 * @returns {{location: object, matched: boolean, matchedBy: string}}
 */
function normalize(raw) {
  const text = String(raw || '').trim();
  if (!text) return { location: UNKNOWN_LOCATION, matched: false, matchedBy: 'empty' };

  // 1) 完全命中名称或别名（最长优先，避免「图书馆」抢走更具体的地点名）
  const exact = LOCATIONS
    .filter((loc) => loc.name === text || (loc.aliases || []).indexOf(text) >= 0)
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (exact) return { location: exact, matched: true, matchedBy: 'exact' };

  // 2) 输入包含地点名/别名（同样最长优先）
  const contains = LOCATIONS
    .filter((loc) => {
      if (text.indexOf(loc.name) >= 0) return true;
      return (loc.aliases || []).some((a) => text.indexOf(a) >= 0);
    })
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (contains) return { location: contains, matched: true, matchedBy: 'contains' };

  // 3) 关键词兜底：食堂 / 教学楼 / 宿舍 等类别词 + 方位词
  const keywordRules = [
    { kw: ['图书馆', '自习', '阅览', '书库'], ids: ['lib'] },
    { kw: ['食堂', '餐厅', '吃饭', '打饭', '餐'], cate: 'food' },
    { kw: ['教学楼', '教室', '上课', '考试'], ids: ['teach1', 'teach2'] },
    { kw: ['宿舍', '寝室', '公寓', '回宿舍'], ids: ['dorm_north', 'dorm_south'] },
    { kw: ['学院', '实验室', '实验楼'], cate: 'teaching' },
    { kw: ['球场', '篮球', '网球', '足球', '操场', '跑道', '运动', '健身', '游泳'], cate: 'sport' },
    { kw: ['快递', '驿站', '取件', '包裹'], ids: ['express'] },
    { kw: ['超市', '便利店', '买东西', '购物'], ids: ['market'] },
    { kw: ['医院', '医务', '看病', '买药'], ids: ['hospital'] },
    { kw: ['银行', '取钱', 'atm'], ids: ['bank_icbc'] },
    { kw: ['桥'], cate: 'scenic' },
    { kw: ['湖', '亭', '花园', '樱花'], cate: 'scenic' },
    { kw: ['路', '道', '大道'], cate: 'road' },
    { kw: ['门', '校门', '门口'], cate: 'gate' }
  ];

  for (let i = 0; i < keywordRules.length; i += 1) {
    const rule = keywordRules[i];
    if (!rule.kw.some((k) => text.toLowerCase().indexOf(k) >= 0)) continue;

    let near = null;
    if (rule.ids) {
      near = getById(rule.ids[0]);
      // 南北区方位词优先
      if (rule.ids.length > 1) {
        if (text.indexOf('南') >= 0) near = getById(rule.ids[1]) || near;
        if (text.indexOf('北') >= 0) near = getById(rule.ids[0]) || near;
      }
    } else if (rule.cate) {
      near = LOCATIONS.filter((loc) => loc.cate === rule.cate && loc.verified)[0] ||
        LOCATIONS.filter((loc) => loc.cate === rule.cate)[0];
    }
    if (near) {
      return {
        location: Object.assign({}, near, { matchedByKeyword: true }),
        matched: false,
        matchedBy: 'keyword:' + (rule.cate || rule.ids[0])
      };
    }
  }

  return { location: Object.assign({}, UNKNOWN_LOCATION, { name: text }), matched: false, matchedBy: 'none' };
}

/** 两点球面距离（米），Haversine */
function distanceMeters(a, b) {
  if (!a || !b) return 0;
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function distanceText(meters) {
  if (!meters && meters !== 0) return '未知距离';
  if (meters < 30) return '几乎同一位置';
  if (meters < 1000) return '约 ' + Math.round(meters / 10) * 10 + ' m';
  return '约 ' + (meters / 1000).toFixed(1) + ' km';
}

function areaName(areaId) {
  const hit = AREAS.find((a) => a.id === areaId);
  return hit ? hit.name : META.campus;
}

function cateLabel(cate) {
  return CATE_LABEL[cate] || '校园地点';
}

/** 地图页用的边界与中心点：优先使用 campus-data 中声明的真实范围 */
function bounds() {
  if (META.bounds) {
    return {
      minLat: META.bounds.minLat,
      maxLat: META.bounds.maxLat,
      minLng: META.bounds.minLng,
      maxLng: META.bounds.maxLng,
      center: { lat: META.center.lat, lng: META.center.lng }
    };
  }
  const lats = LOCATIONS.map((l) => l.lat);
  const lngs = LOCATIONS.map((l) => l.lng);
  const minLat = Math.min.apply(null, lats);
  const maxLat = Math.max.apply(null, lats);
  const minLng = Math.min.apply(null, lngs);
  const maxLng = Math.max.apply(null, lngs);
  const pad = 0.0012;
  return {
    minLat: minLat - pad,
    maxLat: maxLat + pad,
    minLng: minLng - pad,
    maxLng: maxLng + pad,
    center: { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 }
  };
}

function areas() {
  return AREAS.slice();
}

/** 校园元信息（学校名、地址、坐标系、数据来源），用于关于页与答辩材料 */
function campusInfo() {
  return Object.assign({}, META, {
    locationCount: LOCATIONS.length,
    unverifiedCount: unverified().length
  });
}

/** 坐标是否落在校园范围内 */
function inCampus(lat, lng) {
  const b = META.bounds;
  if (!b) return true;
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

/** 给定坐标，找最近的校园地点（用于地图拾取后自动命名） */
function nearest(lat, lng, limit) {
  const target = { lat, lng };
  return LOCATIONS
    .map((loc) => ({ location: loc, distance: distanceMeters(target, loc) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit || 3)
    .map((x) => Object.assign({}, x.location, {
      distance: Math.round(x.distance),
      distanceText: distanceText(x.distance)
    }));
}

/** 供小程序 map 组件的 include-points 使用 */
function includePoints() {
  const b = bounds();
  return [
    { latitude: b.minLat, longitude: b.minLng },
    { latitude: b.maxLat, longitude: b.maxLng }
  ];
}

module.exports = {
  META,
  AREAS,
  LOCATIONS,
  UNKNOWN_LOCATION,
  list,
  getById,
  getByName,
  cateOf,
  unverified,
  normalize,
  distanceMeters,
  distanceText,
  areaName,
  cateLabel,
  bounds,
  includePoints,
  areas,
  campusInfo,
  inCampus,
  nearest
};
