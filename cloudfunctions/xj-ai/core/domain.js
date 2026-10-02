/**
 * 云函数共享的实体构造与视图转换
 * ---------------------------------------------------------------
 * 这份代码同时被小程序端（utils/）与云函数端（cloudfunctions/）使用，
 * 保证「本地演示」与「云端运行」的数据结构完全一致，切换后端不会出现字段漂移。
 */

const categories = require('./categories');
const colorUtil = require('./color');
const timeUtil = require('./time');
const locations = require('./locations');
const imageSpec = require('./image-spec');
const aiEmbed = require('./ai/embed');

/* ===================== 状态机（方案 6.7） ===================== */

const LOST_STATUS = {
  searching: { label: '寻找中', cls: 'searching' },
  candidate_found: { label: '发现候选', cls: 'candidate' },
  verifying: { label: '核验中', cls: 'verifying' },
  waiting_handover: { label: '待交接', cls: 'handover' },
  recovered: { label: '已归还', cls: 'recovered' },
  closed: { label: '已关闭', cls: 'closed' }
};

const FOUND_STATUS = {
  available: { label: '待认领', cls: 'available' },
  reserved: { label: '已锁定', cls: 'reserved' },
  returned: { label: '已归还', cls: 'returned' },
  closed: { label: '已关闭', cls: 'closed' }
};

const MATCH_STATUS = {
  new: { label: '新候选', cls: 'candidate' },
  viewed: { label: '已查看', cls: 'searching' },
  rejected: { label: '已排除', cls: 'closed' },
  claimed: { label: '认领中', cls: 'verifying' },
  verified: { label: '核验通过', cls: 'handover' },
  failed: { label: '核验未通过', cls: 'failed' },
  returned: { label: '已归还', cls: 'recovered' }
};

const CLAIM_STATUS = {
  answering: { label: '待回答', cls: 'candidate' },
  submitted: { label: '待拾物者确认', cls: 'verifying' },
  verified: { label: '核验通过', cls: 'handover' },
  rejected: { label: '核验未通过', cls: 'failed' },
  returned: { label: '已归还', cls: 'recovered' }
};

function statusInfo(map, key) {
  return map[key] || { label: key || '未知', cls: 'closed' };
}

/* ===================== 实体构造 ===================== */

/**
 * 用发布/种子数据构造一条标准记录
 * @param {object} cfg 见 utils/service.publish 的入参
 * @param {object} opts { now, locationResolver }
 */
function buildItem(cfg, opts) {
  const c = cfg || {};
  const options = opts || {};
  const now = options.now || Date.now();
  const kind = c.kind === 'found' ? 'found' : 'lost';

  // 地点标准化：允许调用方注入地点库（云端与小程序端地点库版本一致）
  const loc = options.locationResolver || defaultLocationResolver;
  let location = c.location || null;
  if (!location && c.locationId) location = loc.getById(c.locationId);
  if (!location && c.locationText) location = loc.normalize(c.locationText).location;
  if (!location) location = loc.UNKNOWN_LOCATION || loc.getById('unknown') || {
    id: 'unknown', name: '校园内（待确认）', area: 'area_center', cate: 'public', lat: 0, lng: 0
  };

  const attributes = Object.assign({ category: c.category || 'other' }, c.attributes || {});
  const image = c.image || '';
  const description = c.description || '';

  const item = {
    id: c.id || '',
    kind,
    userId: c.userId || '',
    title: c.title || '',
    image,
    images: c.images || (image ? [image] : []),
    description,
    imageDescription: c.imageDescription || '',
    location,
    locationMatched: c.locationMatched !== false,
    locationText: c.locationText || location.name,
    timeRange: kind === 'lost' ? (c.timeRange || null) : null,
    foundTime: kind === 'found' ? (c.foundTime || now) : 0,
    attributes,
    attributeSources: c.attributeSources || {},
    attributeConfidence: c.attributeConfidence || {},
    attributesModel: c.attributesModel || 'local',
    privateFeatures: (c.privateFeatures || []).filter(Boolean),
    publicDescription: c.publicDescription || description,
    status: c.status || (kind === 'lost' ? 'searching' : 'available'),
    identityId: c.identityId || '',
    createdAt: c.createdAt || now,
    updatedAt: c.updatedAt || now,
    views: c.views || 0,
    matchCount: c.matchCount || 0
  };

  item.embeddings = c.embeddings || aiEmbed.buildItemVectors(item);
  return item;
}

/** 默认地点解析器（使用内置校园地点库） */
const defaultLocationResolver = {
  getById: (id) => locations.getById(id),
  normalize: (text) => locations.normalize(text),
  UNKNOWN_LOCATION: locations.UNKNOWN_LOCATION
};

/* ===================== 视图模型 ===================== */

function itemView(item, deps) {
  if (!item) return null;
  const d = deps || {};
  const userName = d.userName || (() => '同学');
  const stMap = item.kind === 'lost' ? LOST_STATUS : FOUND_STATUS;
  const st = statusInfo(stMap, item.status);
  const attr = item.attributes || {};
  const tags = [];
  if (attr.brand) tags.push(attr.brand);
  colorUtil.colorTags(attr).forEach((c) => tags.push(c));
  if (attr.material) tags.push(attr.material);
  (attr.features || []).forEach((f) => tags.push(f));

  return {
    id: item.id,
    kind: item.kind,
    typeLabel: item.kind === 'lost' ? '失物' : '拾物',
    title: item.title || (attr.brand ? attr.brand : '') + categories.nameOf(attr.category),
    icon: categories.iconOf(attr.category),
    categoryName: categories.nameOf(attr.category),
    description: item.description || '',
    imageDescription: item.imageDescription || '',
    image: item.image || '',
    /**
     * 是否可以真的交给 <image src> 渲染。
     *
     * 为什么需要这个字段：
     *   `demo://xxx` 是「演示图库标识」，只用于属性提取与向量计算，
     *   不是可渲染的图片资源。若把它传给 <image src>，微信会按相对路径去找
     *   本地文件（报 500：Failed to load local image resource
     *   /components/item-card/demo://stationery_black）。
     *
     *   之前各页面靠 `image.indexOf('demo://') !== 0` 各自判断，
     *   item-card 组件漏了这个判断，于是演示数据一进候选卡就报错。
     *   现在统一在视图模型里算好，页面直接用它。
     */
    hasImage: !!(item.image && String(item.image).indexOf('demo://') !== 0),
    images: item.images || (item.image ? [item.image] : []),
    locationName: (item.location && item.location.name) || '地点待确认',
    lat: item.location ? item.location.lat : null,
    lng: item.location ? item.location.lng : null,
    areaName: item.location ? locations.areaName(item.location.area) : '',
    timeText: item.kind === 'lost'
      ? timeUtil.rangeText(item.timeRange)
      : timeUtil.format(item.foundTime),
    timeRelative: item.kind === 'lost'
      ? timeUtil.fromNow(item.createdAt)
      : timeUtil.fromNow(item.foundTime),
    createdAt: item.createdAt,
    createdText: timeUtil.fromNow(item.createdAt),
    status: item.status,
    statusLabel: st.label,
    statusClass: st.cls,
    userId: item.userId,
    ownerName: userName(item.userId),
    attributes: attr,
    tags: tags.slice(0, 5),
    hasPrivate: !!(item.privateFeatures && item.privateFeatures.length),
    privateCount: (item.privateFeatures || []).length,
    views: item.views || 0,
    matchCount: item.matchCount || 0
  };
}

module.exports = {
  LOST_STATUS,
  FOUND_STATUS,
  MATCH_STATUS,
  CLAIM_STATUS,
  statusInfo,
  buildItem,
  defaultLocationResolver,
  itemView
};
