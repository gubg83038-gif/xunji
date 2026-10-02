/**
 * 云数据库访问层（云函数端）
 * ---------------------------------------------------------------
 * 与小程序端 utils/store.js 保持同名方法契约，因此 core/domain、
 * core/matcher 以及业务层代码在两端可用同一套写法。
 *
 * 集合划分（对应方案 10）：
 *   items         失物与拾物统一存储，用 kind 字段区分（便于一次查询跨类型匹配）
 *   matches       候选匹配与五路分数、解释
 *   claims        认领核验
 *   feedbacks     正/负样本反馈
 *   notifications 主动提醒
 *   users         用户
 *   meta          版本与统计
 *
 * 说明：items 统一存储而非拆成 lost/found 两张表，是因为匹配时需要
 * 在同一集合里按 kind 过滤后做候选检索，pgvector 场景下也更贴近
 * 「单表 + 向量索引」的常规做法。
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

const COLLECTIONS = {
  items: 'xj_items',
  matches: 'xj_matches',
  claims: 'xj_claims',
  feedbacks: 'xj_feedbacks',
  notifications: 'xj_notifications',
  users: 'xj_users',
  meta: 'xj_meta'
};

const PAGE_LIMIT = 100; // 云数据库单次 get 上限

function coll(name) {
  return db.collection(COLLECTIONS[name]);
}

/* ===================== 通用查询：分页取全量 ===================== */

/**
 * 是否为「集合不存在」类错误。
 *
 * 为什么必须单独识别：
 *   微信云开发不会在写入前自动建集合。首次启动时集合都还不存在，
 *   如果读取直接抛错，客户端会把它当成「云端不可用」并退回本地演示数据——
 *   用户看到的就是「明明配了云环境，却一直是离线模式」。
 *   而实际上这只是「还没有数据」，应当按空结果处理。
 *
 * 真实报错样例：
 *   errCode: -502005
 *   errMsg: collection.get:fail -502005 database collection not exists
 */
function isCollectionNotExist(err) {
  const code = err && (err.errCode !== undefined ? err.errCode : err.code);
  if (code === -502005) return true;
  const msg = String((err && (err.errMsg || err.message)) || '');
  return /collection.*not.*exist|DATABASE_COLLECTION_NOT_EXIST|-502005/i.test(msg);
}

async function fetchAll(name, where, orderBy) {
  const out = [];
  let skip = 0;
  for (;;) {
    let q = coll(name).where(where || {});
    if (orderBy) q = q.orderBy(orderBy.field, orderBy.direction || 'desc');
    let res;
    try {
      res = await q.skip(skip).limit(PAGE_LIMIT).get();
    } catch (e) {
      // 集合尚未创建 → 视为空数据，而不是让整个请求失败
      if (isCollectionNotExist(e)) return out;
      throw e;
    }
    const list = res.data || [];
    out.push.apply(out, list);
    if (list.length < PAGE_LIMIT) break;
    skip += PAGE_LIMIT;
    if (skip > 5000) break; // 安全上限，避免异常数据导致死循环
  }
  return out;
}

async function findOne(name, where) {
  let res;
  try {
    res = await coll(name).where(where).limit(1).get();
  } catch (e) {
    if (isCollectionNotExist(e)) return null;
    throw e;
  }
  return (res.data && res.data[0]) || null;
}

/** 微信云数据库返回的是 { _id, ... }，这里统一映射成业务 id */
function toEntity(doc) {
  if (!doc) return null;
  const out = Object.assign({}, doc);
  if (out._id && !out.id) out.id = out._id;
  delete out._id;
  return out;
}

/** 写入前统一处理：去掉 _id，保证 id 字段唯一 */
function toDoc(entity) {
  const doc = Object.assign({}, entity);
  delete doc._id;
  return doc;
}

/* ===================== items ===================== */

async function itemsOf(kind) {
  return (await fetchAll('items', kind ? { kind } : {})).map(toEntity);
}

async function getItem(id) {
  return toEntity(await findOne('items', { id }));
}

async function insertItem(item) {
  await coll('items').add({ data: toDoc(item) });
  return item;
}

async function updateItem(id, patch) {
  const clean = toDoc(patch);
  delete clean.id;
  await coll('items').where({ id }).update({ data: Object.assign(clean, { updatedAt: Date.now() }) });
  return getItem(id);
}

async function removeItem(id) {
  await coll('items').where({ id }).remove();
  await coll('matches').where(_.or([{ lostId: id }, { foundId: id }])).remove();
  await coll('claims').where(_.or([{ lostId: id }, { foundId: id }])).remove();
  return true;
}

async function itemsByUser(userId, kind) {
  const where = { userId };
  if (kind) where.kind = kind;
  const list = (await fetchAll('items', where, { field: 'createdAt', direction: 'desc' })).map(toEntity);
  return list;
}

async function countItems(kind) {
  try {
    const res = await coll('items').where(kind ? { kind } : {}).count();
    return res.total || 0;
  } catch (e) {
    // 集合尚未创建 → 视为 0，而不是让诊断/统计整体失败
    if (isCollectionNotExist(e)) return 0;
    throw e;
  }
}

/**
 * 取样一条物品记录（只需 1 次查询）。
 *
 * 用途：seed 之前判断「库里已有数据是否可用」——
 *   例如旧版本代码灌入的记录没有 embeddings 字段，
 *   这时必须淘汰重灌，否则界面会算出错误的匹配分。
 */
async function sampleItem() {
  const list = await fetchAll('items', {}, { field: 'createdAt', direction: 'desc' });
  return list.length ? toEntity(list[0]) : null;
}

/* ===================== matches ===================== */

async function matchesOfLost(lostId) {
  return (await fetchAll('matches', { lostId }, { field: 'score', direction: 'desc' })).map(toEntity);
}

async function matchesOfFound(foundId) {
  return (await fetchAll('matches', { foundId }, { field: 'score', direction: 'desc' })).map(toEntity);
}

async function allMatches() {
  return (await fetchAll('matches', {})).map(toEntity);
}

async function getMatch(id) {
  return toEntity(await findOne('matches', { id }));
}

async function upsertMatch(match) {
  const exist = await findOne('matches', { lostId: match.lostId, foundId: match.foundId });
  if (exist) {
    const patch = toDoc(match);
    delete patch.id;
    // 保留用户已产生的交互状态
    delete patch.status;
    delete patch.userStatus;
    delete patch.createdAt;
    await coll('matches').doc(exist._id).update({ data: Object.assign(patch, { updatedAt: Date.now() }) });
    return Object.assign(toEntity(exist), patch);
  }
  await coll('matches').add({ data: toDoc(match) });
  return match;
}

async function updateMatch(id, patch) {
  const clean = toDoc(patch);
  delete clean.id;
  await coll('matches').where({ id }).update({ data: Object.assign(clean, { updatedAt: Date.now() }) });
  return getMatch(id);
}

async function removeMatch(id) {
  await coll('matches').where({ id }).remove();
  return true;
}

/* ===================== claims ===================== */

async function claimsOfLost(lostId) {
  return (await fetchAll('claims', { lostId })).map(toEntity);
}

async function getClaim(id) {
  return toEntity(await findOne('claims', { id }));
}

async function claimByMatch(matchId) {
  return toEntity(await findOne('claims', { matchId }));
}

async function insertClaim(claim) {
  await coll('claims').add({ data: toDoc(claim) });
  return claim;
}

async function updateClaim(id, patch) {
  const clean = toDoc(patch);
  delete clean.id;
  await coll('claims').where({ id }).update({ data: Object.assign(clean, { updatedAt: Date.now() }) });
  return getClaim(id);
}

async function claimsForUser(userId) {
  return (await fetchAll('claims', _.or([{ claimantId: userId }, { keeperId: userId }]), { field: 'createdAt', direction: 'desc' })).map(toEntity);
}

/* ===================== feedbacks ===================== */

async function insertFeedback(fb) {
  await coll('feedbacks').add({ data: toDoc(fb) });
  return fb;
}

async function allFeedbacks() {
  return (await fetchAll('feedbacks', {})).map(toEntity);
}

/* ===================== notifications ===================== */

async function notifications(userId) {
  const where = userId ? _.or([{ userId }, { userId: '' }]) : {};
  return (await fetchAll('notifications', where, { field: 'createdAt', direction: 'desc' })).map(toEntity);
}

async function insertNotification(n) {
  await coll('notifications').add({ data: toDoc(n) });
  return n;
}

async function markAllRead(userId) {
  await coll('notifications').where(_.or([{ userId }, { userId: '' }])).update({ data: { read: true } });
  return true;
}

async function unreadCount(userId) {
  const res = await coll('notifications').where(_.and([_.or([{ userId }, { userId: '' }]), { read: false }])).count();
  return res.total || 0;
}

/* ===================== users ===================== */

async function users() {
  return (await fetchAll('users', {})).map(toEntity);
}

async function user(id) {
  const u = toEntity(await findOne('users', { id }));
  return u || { id, nickName: '同学', role: 'user', credit: 100 };
}

/** 首次调用时自动建立演示用户 */
async function ensureUsers(demoUsers) {
  const count = await coll('users').count();
  if ((count.total || 0) > 0) return false;
  for (let i = 0; i < demoUsers.length; i += 1) {
    await coll('users').add({ data: toDoc(demoUsers[i]) });
  }
  return true;
}

/* ===================== meta ===================== */

async function getMeta() {
  return toEntity(await findOne('meta', { key: 'system' })) || null;
}

async function setMeta(patch) {
  const exist = await findOne('meta', { key: 'system' });
  if (exist) {
    await coll('meta').doc(exist._id).update({ data: Object.assign(toDoc(patch), { updatedAt: Date.now() }) });
  } else {
    await coll('meta').add({ data: Object.assign({ key: 'system' }, toDoc(patch)) });
  }
  return getMeta();
}

/* ===================== 初始化与清理 ===================== */

/** 创建集合（幂等）。云开发不会在写入前自动建集合，因此首次部署必须调用一次。 */
async function ensureCollections() {
  const created = [];
  const names = Object.keys(COLLECTIONS);
  for (let i = 0; i < names.length; i += 1) {
    const name = COLLECTIONS[names[i]];
    try {
      await db.createCollection(name);
      created.push(name);
    } catch (e) {
      // -501001 / ResourceExists 表示已存在，属正常情况
      if (!/exist|already|-501001/i.test(e.message || '')) {
        // 其它错误向上抛出，便于定位权限或环境问题
        if (!/collection.*not.*exist|DATABASE_COLLECTION_NOT_EXIST/i.test(e.message || '')) throw e;
      }
    }
  }
  return created;
}

/** 清空演示数据（保留 users 与 meta 结构） */
async function clearData(options) {
  const opts = options || {};
  const targets = opts.keepUsers ? ['items', 'matches', 'claims', 'feedbacks', 'notifications'] : ['items', 'matches', 'claims', 'feedbacks', 'notifications', 'users'];
  for (let i = 0; i < targets.length; i += 1) {
    const name = COLLECTIONS[targets[i]];
    // 云数据库没有 truncate，循环删除直至为空
    for (;;) {
      const res = await db.collection(name).limit(PAGE_LIMIT).get();
      const list = res.data || [];
      if (!list.length) break;
      for (let j = 0; j < list.length; j += 1) {
        await db.collection(name).doc(list[j]._id).remove();
      }
      if (list.length < PAGE_LIMIT) break;
    }
  }
  return targets;
}

module.exports = {
  cloud,
  db,
  _,
  $,
  COLLECTIONS,
  isCollectionNotExist,
  fetchAll,
  findOne,
  toEntity,
  toDoc,
  itemsOf,
  getItem,
  insertItem,
  updateItem,
  removeItem,
  itemsByUser,
  countItems,
  sampleItem,
  matchesOfLost,
  matchesOfFound,
  allMatches,
  getMatch,
  upsertMatch,
  updateMatch,
  removeMatch,
  claimsOfLost,
  getClaim,
  claimByMatch,
  insertClaim,
  updateClaim,
  claimsForUser,
  insertFeedback,
  allFeedbacks,
  notifications,
  insertNotification,
  markAllRead,
  unreadCount,
  users,
  user,
  ensureUsers,
  getMeta,
  setMeta,
  ensureCollections,
  clearData
};
