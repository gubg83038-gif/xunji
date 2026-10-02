/**
 * 数据持久层（本地镜像 + 云端提交）
 * ---------------------------------------------------------------
 * 方案 10 定义了 LostItem / FoundItem / Match / Claim / Feedback / Location 六类实体。
 *
 * 本文件有两种运行模式，由 core/config.js 的 cloud.enabled 决定：
 *
 *  1) 本地模式（默认，离线演示）
 *     全部数据存在 wx.setStorageSync，首次启动由 mock/seed.js 灌入演示数据。
 *
 *  2) 云端模式（cloud.enabled = true 且填写 envId）
 *     读：启动时从云数据库拉一份快照到内存镜像，页面保持同步读取（体验与离线一致）；
 *     写：先更新镜像（界面立即响应），同时通过云函数 xj-api 提交到云数据库。
 *     这样既保留了小程序端即时交互，又让数据真正落在云端、可跨设备共享。
 *
 * 两种模式对上层（service / 页面）的接口完全一致。
 */

const config = require('../core/config');
const STORAGE_KEY = 'xunji.db.v1';
const MIRROR_KEY = 'xunji.mirror.v1';
const CLOUD_CACHE_KEY = 'xunji.cloudcache.v1';
const MUTATION_EVENT = 'db:changed';

/* ---------------- 存储适配（兼容小程序 / Node 测试环境） ---------------- */

const memory = {};

function hasWx() {
  return typeof wx !== 'undefined' && wx && typeof wx.setStorageSync === 'function';
}

function readRaw() {
  try {
    if (hasWx()) return wx.getStorageSync(STORAGE_KEY) || null;
    return memory[STORAGE_KEY] || null;
  } catch (e) {
    return null;
  }
}

function writeRaw(db) {
  try {
    if (hasWx()) wx.setStorageSync(STORAGE_KEY, db);
    else memory[STORAGE_KEY] = db;
  } catch (e) {
    // 存储超限时降级为内存态，保证演示不中断
    memory[STORAGE_KEY] = db;
  }
}

/* ---------------- 默认结构 ---------------- */

function emptyDb() {
  return {
    version: 1,
    seeded: false,
    users: [],
    lostItems: [],
    foundItems: [],
    matches: [],
    claims: [],
    feedbacks: [],
    notifications: [],
    meta: {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      matchRuns: 0,
      avgMatchMs: 0,
      /**
       * 灌入数据时使用的校园地点库版本。
       * 换学校 / 改坐标后必须让旧缓存失效，否则记录里会留着旧坐标，
       * 地图与时空重排都会失真（升级后表现为“地图飘到别的学校”）。
       * 由 mock/seed.js 在灌入时写入并在启动时比对。
       */
      campusVersion: 0
    }
  };
}

let cache = null;

function init() {
  if (!cache) {
    cache = readRaw();
    if (!cache || !cache.version) cache = emptyDb();
    // 结构兜底，避免旧数据缺字段
    const base = emptyDb();
    Object.keys(base).forEach((k) => {
      if (cache[k] === undefined) cache[k] = base[k];
    });
    cache.meta = Object.assign({}, base.meta, cache.meta || {});
  }
  return cache;
}

function db() {
  return init();
}

function persist(options) {
  const opts = options || {};
  cache.meta.updatedAt = Date.now();
  writeRaw(cache);
  if (!opts.silent) emit();
  return cache;
}

function reset(seedFn) {
  cache = emptyDb();
  if (typeof seedFn === 'function') seedFn(cache);
  cache.seeded = true;
  writeRaw(cache);
  emit();
  return cache;
}

/* ---------------- 云端镜像与提交 ---------------- */

let cloudState = {
  loading: false,
  loaded: false,
  lastSync: 0,
  error: ''
};

function isCloud() {
  try {
    return require('./api').isCloud();
  } catch (e) {
    return false;
  }
}

/** 把服务端返回的视图对象还原成实体结构（保证页面读到的字段一致） */
/**
 * 把云端同步下来的记录还原成本地实体。
 *
 * ⚠ 真实事故（详细对比页显示 48% 而不是 82%）：
 *   之前这个函数把云端数据当「展示视图」处理，丢掉了匹配引擎需要的字段：
 *     · timeRange  被写死为 null  → 时间相关度「未参与」，丢 8% 权重
 *     · foundTime  用了 createdAt   → 时间差算错
 *     · location.area 丢失          → 分区判断失效
 *     · 完全没有 embeddings         → 视觉相似度判为不可用，丢 32% 权重
 *   结果客户端本地重算的分数与云端权威结果不一致。
 *
 * 现在云端 item.list 默认返回「实体文档」（含上述全部字段），
 * 这里如实还原，不再用展示字段替代计算字段。
 * 同时兼容旧的「视图」格式（没有 embeddings / timeRange 时按视图处理）。
 */
function viewToEntity(v, kind) {
  if (!v) return null;
  const k = kind || v.kind;
  const isEntity = v.format === 'entity' || v.embeddings !== undefined ||
    v.timeRange !== undefined || (v.location && v.location.id);

  if (isEntity) {
    return {
      id: v.id,
      kind: k,
      userId: v.userId,
      title: v.title || '',
      category: v.category || (v.attributes || {}).category || '',
      image: v.image || '',
      images: v.images || (v.image ? [v.image] : []),
      description: v.description || '',
      imageDescription: v.imageDescription || '',
      // 计算所需的原始字段，一律如实保留
      embeddings: v.embeddings || null,
      attributes: v.attributes || {},
      location: v.location || null,
      locationText: v.locationText || (v.location && v.location.name) || '',
      locationMatched: !!(v.location && v.location.id),
      timeRange: v.timeRange || null,
      timeText: v.timeRange && v.timeRange.text ? v.timeRange.text : '',
      foundTime: v.foundTime || 0,
      privateFeatures: v.privateFeatures || [],
      privateCount: v.privateCount || 0,
      status: v.status,
      statusHistory: v.statusHistory || [],
      createdAt: v.createdAt || 0,
      updatedAt: v.updatedAt || 0,
      matchCount: v.matchCount || 0,
      views: v.views || 0,
      _fromCloud: true
    };
  }

  // 兼容旧的展示视图格式（字段不全，仅用于降级展示）
  return {
    id: v.id,
    kind: k,
    userId: v.userId,
    title: v.title,
    image: v.image,
    images: v.images || [],
    description: v.description,
    imageDescription: v.imageDescription || '',
    location: { id: '', name: v.locationName, area: '', lat: v.lat, lng: v.lng },
    locationText: v.locationName,
    locationMatched: true,
    timeRange: v.timeRange || null,
    timeText: v.timeText,
    foundTime: v.foundTime || (k === 'found' ? v.createdAt : 0),
    attributes: v.attributes || {},
    privateFeatures: v.privateFeatures || [],
    privateCount: v.privateCount || 0,
    status: v.status,
    createdAt: v.createdAt,
    matchCount: v.matchCount || 0,
    views: v.views || 0,
    _fromCloud: true
  };
}

function applySnapshot(snap) {
  if (!snap) return cache;
  const next = emptyDb();
  const items = snap.items || [];
  items.forEach((v) => {
    const entity = viewToEntity(v);
    if (!entity) return;
    if (entity.kind === 'lost') next.lostItems.push(entity);
    else next.foundItems.push(entity);
  });
  next.matches = snap.matches || [];
  next.claims = snap.claims || [];
  next.notifications = snap.notifications || [];
  next.users = snap.users || [];
  next.seeded = true;
  next.meta = Object.assign({}, cache ? cache.meta : {}, {
    updatedAt: Date.now(),
    cloudSynced: true
  });
  cache = next;
  writeRaw(cache);
  emit({ at: Date.now(), source: 'cloud' });
  return cache;
}

function readCloudCache() {
  try {
    if (hasWx()) return wx.getStorageSync(CLOUD_CACHE_KEY) || null;
    return memory[CLOUD_CACHE_KEY] || null;
  } catch (e) {
    return null;
  }
}

function writeCloudCache(snap) {
  try {
    if (hasWx()) wx.setStorageSync(CLOUD_CACHE_KEY, snap);
    else memory[CLOUD_CACHE_KEY] = snap;
  } catch (e) { /* 忽略缓存写入失败 */ }
}

/**
 * 立即从云端刷新镜像（页面 onShow 与写操作后调用）
 * @returns {Promise<boolean>}
 */
async function refreshFromCloud() {
  if (!isCloud()) return false;
  if (cloudState.loading) return false;
  cloudState.loading = true;
  try {
    const api = require('./api');
    const snap = await api.fetchSnapshot(config.cloud.userId || 'u_me');
    writeCloudCache(snap);
    applySnapshot(snap);
    cloudState.loaded = true;
    cloudState.lastSync = Date.now();
    cloudState.error = '';
    return true;
  } catch (e) {
    cloudState.error = e.message || '同步失败';
    console.error('[寻迹] 云端同步失败：', cloudState.error);
    return false;
  } finally {
    cloudState.loading = false;
  }
}

/**
 * 启动时初始化镜像：
 *   1. 先用缓存快照渲染（秒开，避免白屏）
 *   2. 再向云端请求最新数据并覆盖
 */
async function initCloud() {
  if (!isCloud()) return false;
  const cached = readCloudCache();
  if (cached) applySnapshot(cached);
  else init();
  return refreshFromCloud();
}

/** 写操作提交到云端（异步，不阻塞界面；失败只记录并提示） */
function dispatchToCloud(action, payload, fallbackLocal) {
  if (!isCloud()) {
    if (typeof fallbackLocal === 'function') fallbackLocal();
    return;
  }
  try {
    const api = require('./api');
    api.callApi(action, payload).then((data) => {
      dispatchState.pending -= 1;
      dispatchState.lastOk = Date.now();
      if (typeof fallbackLocal === 'function') fallbackLocal(data);
      // 有实际写入后延迟刷新镜像，保证后续读到的分数与云端一致
      scheduleRefresh();
    }).catch((e) => {
      dispatchState.pending -= 1;
      dispatchState.lastError = e.message || '提交失败';
      console.error('[寻迹] 云端提交 ' + action + ' 失败：', dispatchState.lastError);
      if (typeof wx !== 'undefined' && wx.showToast) {
        wx.showToast({ title: '云端提交失败，数据仅保存在本机', icon: 'none', duration: 2500 });
      }
    });
  } catch (e) {
    console.error('[寻迹] 云端提交异常：', e);
  }
}

const dispatchState = { pending: 0, lastOk: 0, lastError: '' };
let refreshTimer = null;

function scheduleRefresh(delay) {
  if (!isCloud()) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshFromCloud();
  }, delay === undefined ? 600 : delay);
}

/** 等待所有在途的云端写操作完成（关键流程如发布后可调用） */
async function flushCloud() {
  if (!isCloud()) return true;
  const start = Date.now();
  while (dispatchState.pending > 0 && Date.now() - start < 8000) {
    await new Promise((r) => setTimeout(r, 120));
  }
  return dispatchState.pending === 0;
}

function cloudStatus() {
  return {
    mode: isCloud() ? 'cloud' : 'local',
    loaded: cloudState.loaded,
    lastSync: cloudState.lastSync,
    pending: dispatchState.pending,
    lastError: dispatchState.lastError || cloudState.error
  };
}

/* ---------------- 变更事件 ---------------- */

const listeners = [];

function on(cb) {
  if (typeof cb === 'function') listeners.push(cb);
  return function off() {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function emit(payload) {
  const info = payload || { at: Date.now() };
  listeners.slice().forEach((cb) => {
    try { cb(info); } catch (e) { /* 单个监听器异常不影响其他 */ }
  });
}

/* ---------------- 通用工具 ---------------- */

let seq = 0;
function uid(prefix) {
  seq += 1;
  return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + seq.toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

function clone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

function findBy(list, predicate) {
  for (let i = 0; i < list.length; i += 1) {
    if (predicate(list[i])) return list[i];
  }
  return null;
}

/* ---------------- 用户 ---------------- */

const DEMO_USERS = [
  { id: 'u_me', nickName: '我', avatar: '', role: 'user', credit: 100, college: '计算机学院' },
  { id: 'u_lin', nickName: '林同学', avatar: '', role: 'user', credit: 98, college: '外语学院' },
  { id: 'u_chen', nickName: '陈同学', avatar: '', role: 'user', credit: 96, college: '机械学院' },
  { id: 'u_wang', nickName: '王同学', avatar: '', role: 'user', credit: 95, college: '数理学院' },
  { id: 'u_zhao', nickName: '赵同学', avatar: '', role: 'user', credit: 99, college: '设计学院' },
  { id: 'u_admin', nickName: '平台管理员', avatar: '', role: 'admin', credit: 100, college: '学工处' }
];

function users() {
  if (!db().users.length) db().users = clone(DEMO_USERS);
  return db().users;
}

function user(id) {
  return findBy(users(), (u) => u.id === id) || users()[0];
}

/* ---------------- 物品记录 ---------------- */

function allItems() {
  return db().lostItems.concat(db().foundItems);
}

function itemsOf(kind) {
  return kind === 'lost' ? db().lostItems : db().foundItems;
}

function getItem(id) {
  const d = db();
  return findBy(d.lostItems, (x) => x.id === id) || findBy(d.foundItems, (x) => x.id === id);
}

function insertItem(item) {
  const d = db();
  const list = item.kind === 'lost' ? d.lostItems : d.foundItems;
  list.unshift(item);
  // 云端模式：同时提交到云数据库（异步，不阻塞界面）
  dispatchToCloud('item.publish', item, (data) => {
    // 云端确认写入后打标记，后续 item.update 才发请求
    item._cloudSynced = true;
    if (data && data.item && data.item.id && !item.id) item.id = data.item.id;
  });
  return item;
}

function updateItem(id, patch) {
  const item = getItem(id);
  if (!item) return null;
  Object.assign(item, patch, { updatedAt: Date.now() });
  /**
   * 只对「云库里确实存在的记录」发更新请求。
   *
   * 背景：本地镜像里可能残留云库没有的记录（例如本地模式灌的演示数据）。
   * service 层的状态流转会把这些记录也一并更新，
   * 发到云端会得到 NOT_FOUND —— 云端已改为返回「已忽略」不再报错，
   * 但完全不必发这一趟请求。
   *
   * 判定依据 _fromCloud / _cloudSynced：前者表示来自云端快照，
   * 后者表示本地发布后已被云端确认写入。
   */
  const cloudBacked = !!(item._fromCloud || item._cloudSynced);
  if (cloudBacked) {
    dispatchToCloud('item.update', { id, patch });
  }
  return item;
}

function removeItem(id) {
  const d = db();
  const before = d.lostItems.length + d.foundItems.length;
  d.lostItems = d.lostItems.filter((x) => x.id !== id);
  d.foundItems = d.foundItems.filter((x) => x.id !== id);
  d.matches = d.matches.filter((m) => m.lostId !== id && m.foundId !== id);
  d.claims = d.claims.filter((c) => c.lostId !== id && c.foundId !== id);
  const changed = before !== d.lostItems.length + d.foundItems.length;
  if (changed) dispatchToCloud('item.remove', { id });
  return changed;
}

function itemsByUser(userId, kind) {
  const list = kind ? itemsOf(kind) : allItems();
  return list.filter((x) => x.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
}

/* ---------------- 匹配 ---------------- */

function matches() {
  return db().matches;
}

function matchesOfLost(lostId) {
  return db().matches.filter((m) => m.lostId === lostId).sort((a, b) => b.score - a.score);
}

function matchesOfFound(foundId) {
  return db().matches.filter((m) => m.foundId === foundId).sort((a, b) => b.score - a.score);
}

function getMatch(id) {
  return findBy(db().matches, (m) => m.id === id);
}

function upsertMatch(match) {
  const d = db();
  const exist = findBy(d.matches, (m) => m.lostId === match.lostId && m.foundId === match.foundId);
  if (exist) {
    // 保留用户已产生的交互状态（已查看/已排除/已认领）
    Object.assign(exist, match, { id: exist.id, userStatus: exist.userStatus || match.userStatus || 'new' });
    return exist;
  }
  d.matches.push(match);
  return match;
}

function updateMatch(id, patch) {
  const m = getMatch(id);
  if (!m) return null;
  Object.assign(m, patch, { updatedAt: Date.now() });
  // 云端模式下匹配结果由服务端权威计算，本地不重复提交 match 明细
  return m;
}

function removeMatch(id) {
  const d = db();
  const m = getMatch(id);
  if (!m) return null;
  d.matches = d.matches.filter((x) => x.id !== id);
  emit();
  return m;
}

/* ---------------- 认领 ---------------- */

function claims() {
  return db().claims;
}

function claimsOfLost(lostId) {
  return db().claims.filter((c) => c.lostId === lostId);
}

function getClaim(id) {
  return findBy(db().claims, (c) => c.id === id);
}

function byMatch(matchId) {
  return findBy(db().claims, (c) => c.matchId === matchId);
}

function insertClaim(claim) {
  db().claims.unshift(claim);
  dispatchToCloud('claim.start', { matchId: claim.matchId });
  return claim;
}

function updateClaim(id, patch) {
  const c = getClaim(id);
  if (!c) return null;
  Object.assign(c, patch, { updatedAt: Date.now() });
  // 认领状态变更统一由 service 层的语义化动作提交（claim.submit / confirm / return），
  // 这里不再重复提交，避免同一个动作写两次。
  return c;
}

/* ---------------- 反馈 ---------------- */

function feedbacks() {
  return db().feedbacks;
}

function insertFeedback(fb) {
  db().feedbacks.push(fb);
  return fb;
}

function feedbackOfMatch(matchId) {
  return db().feedbacks.filter((f) => f.matchId === matchId);
}

/* ---------------- 通知 ---------------- */

function notifications(userId) {
  const list = db().notifications;
  const filtered = userId ? list.filter((n) => !n.userId || n.userId === userId) : list;
  return filtered.sort((a, b) => b.createdAt - a.createdAt);
}

function unreadCount(userId) {
  return notifications(userId).filter((n) => !n.read).length;
}

function insertNotification(n) {
  db().notifications.unshift(n);
  return n;
}

function markAllRead(userId) {
  db().notifications.forEach((n) => {
    if (!n.userId || n.userId === userId) n.read = true;
  });
  persist();
  dispatchToCloud('notify.read', { userId });
}

/* ---------------- 元信息 ---------------- */

function meta() {
  return db().meta;
}

/** 更新元信息（内部使用 store.db()，避免持有过期引用） */
function patchMeta(patch) {
  Object.assign(db().meta, patch || {});
  return db().meta;
}

function bumpMatchRun(elapsed) {
  const m = db().meta;
  m.matchRuns += 1;
  m.avgMatchMs = m.avgMatchMs ? Math.round((m.avgMatchMs * (m.matchRuns - 1) + elapsed) / m.matchRuns) : elapsed;
  return m;
}

module.exports = {
  STORAGE_KEY,
  MIRROR_KEY,
  CLOUD_CACHE_KEY,
  MUTATION_EVENT,
  init,
  db,
  persist,
  reset,
  on,
  emit,
  uid,
  clone,
  /* ---- 云端模式 ---- */
  isCloud,
  initCloud,
  refreshFromCloud,
  scheduleRefresh,
  flushCloud,
  cloudStatus,
  dispatchToCloud,
  /* ---- 实体 ---- */
  DEMO_USERS,
  users,
  user,
  allItems,
  itemsOf,
  getItem,
  insertItem,
  updateItem,
  removeItem,
  itemsByUser,
  matches,
  matchesOfLost,
  matchesOfFound,
  getMatch,
  upsertMatch,
  updateMatch,
  removeMatch,
  claims,
  claimsOfLost,
  getClaim,
  byMatch,
  insertClaim,
  updateClaim,
  feedbacks,
  insertFeedback,
  feedbackOfMatch,
  notifications,
  unreadCount,
  insertNotification,
  markAllRead,
  meta,
  patchMeta,
  bumpMatchRun
};
