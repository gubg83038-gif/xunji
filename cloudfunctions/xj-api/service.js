/**
 * 业务服务层（云函数端）
 * ---------------------------------------------------------------
 * 与小程序端 utils/service.js 是同一套流程逻辑，差别只有两点：
 *   1. 存储换成云数据库（./store.js）
 *   2. 向量改为云端预计算并落库（发布时算一次，检索时直接用）
 *
 * 完整闭环与方案 4 一致：
 *   发布 → 结构化 → 召回 → 时空重排 → 候选解释 → 主动提醒
 *        → 认领 → 隐藏特征核验 → 双方确认 → 归还 → 反馈
 */

const store = require('./store');
const domain = require('./core/domain');
const matcher = require('./core/matcher');
const ops = require('./core/matching-ops');
const vlm = require('./core/vlm');
const aiEmbed = require('./core/ai/embed');
const timeUtil = require('./core/time');
const locations = require('./core/locations');
const categorical = require('./core/categories');
const colorUtil = require('./core/color');
const chat = require('./core/chat');
const seedData = require('./core/seed-data');

const { LOST_STATUS, FOUND_STATUS, MATCH_STATUS, CLAIM_STATUS, statusInfo } = domain;

/** 用户昵称缓存，避免同一请求内反复查库 */
let userNameCache = null;
let seq = 0;

/** 生成业务主键（云数据库 _id 与业务 id 分离，便于迁移到 pgvector/PostgreSQL） */
function uid(prefix) {
  seq += 1;
  return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + seq.toString(36) +
    Math.floor(Math.random() * 1296).toString(36);
}

async function userName(userId) {
  if (!userNameCache) {
    const list = await store.users();
    userNameCache = {};
    list.forEach((u) => { userNameCache[u.id] = u.nickName; });
  }
  return userNameCache[userId] || '同学';
}

async function view(item) {
  return domain.itemView(item, { userName: (id) => (userNameCache && userNameCache[id]) || '同学' });
}

async function viewItem(item) {
  if (!userNameCache) await userName('');
  return domain.itemView(item, { userName: (id) => userNameCache[id] || '同学' });
}

/**
 * 客户端实体文档：用于把云端数据同步到小程序端镜像。
 *
 * 为什么不能只发 itemView（展示视图）：
 *   真实事故——详细对比页显示 48% 而不是 82%。
 *   原因是客户端镜像由「展示视图」重建，而展示视图**不含计算所需的原始字段**：
 *     · 没有 embeddings        → 视觉相似度判为不可用（0%，权重 32%）
 *     · timeRange 被写成 null  → 时间相关度「未参与」（权重 8%）
 *     · foundTime 用了 createdAt → 时间差算错
 *     · location.area 丢失      → 分区判断失效
 *   于是客户端本地重算的分数与云端权威结果不一致。
 *
 * 所以同步给客户端的必须是**可用于计算的实体**，而不是美化后的视图。
 *
 * 安全处理：隐藏特征（认领核验问题）只回传给物品所有者本人，
 *   其他人只拿到数量——否则任何人抓包就能看到核验答案。
 *
 *   ⚠ 这里必须用两个不同的身份，这是之前「隐藏特征可被抓包读到」的根因：
 *     · personaId：展示身份，决定 itemView 的「我的/他人」文案，
 *       演示要切身份，所以允许客户端声明；
 *     · ownerId：隐私身份，决定 privateFeatures 能不能下发，
 *       **只认服务端身份**，客户端传什么都不影响。
 *     不传 ownerId 时退回 personaId（保持旧调用方的行为，但新代码一律显式传）。
 *
 * @param {object} item 云端实体
 * @param {string} viewerId 展示身份（persona）
 * @param {string} [ownerId] 服务端身份，用于隐私裁剪；缺省时等于 viewerId
 */
function toClientEntity(item, viewerId, ownerId) {
  if (!item) return null;
  const identity = ownerId === undefined || ownerId === null ? viewerId : ownerId;
  const isOwner = !!identity && item.userId === identity;
  const privateFeatures = isOwner ? (item.privateFeatures || []) : [];
  return {
    id: item.id,
    kind: item.kind,
    userId: item.userId,
    title: item.title || '',
    category: (item.attributes || {}).category || '',
    description: item.description || '',
    image: item.image || '',
    images: item.images || [],
    imageDescription: item.imageDescription || '',
    attributesModel: item.attributesModel || 'local',
    attributeSources: item.attributeSources || {},
    attributeConfidence: item.attributeConfidence || {},
    /** 计算用：向量。缺了它视觉相似度会整体失效 */
    embeddings: item.embeddings || null,
    /** 原始属性（视图里的 attributes 是同一份，但这里保证不经过裁剪） */
    attributes: item.attributes || {},
    /** 计算用：原始位置对象（含 area / lat / lng / 地点名） */
    location: item.location || null,
    locationText: (item.location && item.location.name) || '',
    /** 计算用：丢失时间范围。之前被写成 null，导致时间维度整体失效 */
    timeRange: item.timeRange || null,
    /** 拾物发现时间 */
    foundTime: item.foundTime || 0,
    createdAt: item.createdAt || 0,
    updatedAt: item.updatedAt || 0,
    status: item.status,
    statusHistory: item.statusHistory || [],
    /** 只给自己人，其他人只给数量 */
    privateFeatures,
    privateCount: (item.privateFeatures || []).length,
    views: item.views || 0,
    matchCount: item.matchCount || 0
  };
}

/* ===================== 发布 ===================== */

/**
 * 发布失物 / 拾物
 * @param {object} input 见 utils/service.publish
 * @param {object} extras { aiResult } 由 xj-ai 返回的真实 AI 结果（可选）
 */
async function publish(input, extras) {
  const data = input || {};
  const ex = extras || {};
  const kind = data.kind === 'found' ? 'found' : 'lost';
  const now = Date.now();

  // 1) 结构化属性：本地兜底 + 真实 AI 结果合并
  //    小程序端若已调用 xj-ai 得到结果，会通过 data.aiResult 传入，避免重复计费
  const local = vlm.extractAttributes({
    image: data.image || '',
    description: data.description || '',
    type: kind
  });
  const aiSource = ex.aiResult || data.aiResult || null;
  const ai = aiSource ? vlm.mergeAiResult(local, aiSource) : local;
  const attributes = Object.assign({}, ai.attributes, data.attributes || {});
  if (data.attributes && data.attributes.category) attributes.category = data.attributes.category;

  // 2) 构造实体（地点标准化、时间标准化、状态初始化都在 domain 里）
  const item = domain.buildItem({
    id: data.id || uid('item'),
    kind,
    userId: data.userId,
    title: data.title,
    image: data.image || '',
    images: data.images || [],
    description: data.description || '',
    imageDescription: data.imageDescription || (aiSource && aiSource.description) || '',
    category: attributes.category,
    attributes,
    attributeSources: Object.assign({}, ai.sources, data.attributeSources || {}),
    attributeConfidence: Object.assign({}, ai.confidence, data.attributeConfidence || {}),
    attributesModel: data.attributesModel || (aiSource ? (aiSource.model || 'deepseek') : 'local'),
    locationId: data.locationId,
    locationText: data.locationText,
    location: data.location,
    timeRange: kind === 'lost' ? (data.timeRange || null) : null,
    foundTime: data.foundTime,
    privateFeatures: data.privateFeatures || [],
    publicDescription: data.publicDescription || data.description || '',
    status: data.status,
    identityId: data.identityId || '',
    createdAt: data.createdAt || now
  }, { now });

  // 3) 向量：云端统一预计算（文本 + 图像语义描述）
  item.embeddings = aiEmbed.buildItemVectors(item);

  await store.insertItem(item);

  // 4) 立即执行一次增量匹配
  const matchResult = kind === 'lost'
    ? await runMatchForLost(item)
    : await runMatchForFound(item);

  return {
    item,
    itemView: await viewItem(item),
    auto: { attributes: ai.attributes, sources: ai.sources, confidence: ai.confidence, notes: ai.notes },
    matchCount: matchResult.created,
    top: matchResult.top
  };
}

/* ===================== 匹配 ===================== */

async function runMatchForLost(lostItem, options) {
  const opts = options || {};
  const founds = await store.itemsOf('found');
  const t0 = Date.now();
  const ranked = matcher.rankCandidates(lostItem, founds, {
    topK: opts.topK || 20,
    recallSize: opts.recallSize || 50
  });
  const elapsed = Date.now() - t0;

  let created = 0;
  const persisted = [];
  const existing = await store.matchesOfLost(lostItem.id);
  const existingIds = {};
  existing.forEach((m) => { existingIds[m.foundId] = m; });

  for (let i = 0; i < ranked.results.length; i += 1) {
    const r = ranked.results[i];
    if (r.score < 0.32) continue;
    const existed = !!existingIds[r.foundItem.id];
    const scored = {
      id: 'match_' + lostItem.id + '__' + r.foundItem.id,
      lostId: lostItem.id,
      foundId: r.foundItem.id,
      score: Number(r.score.toFixed(4)),
      scores: r.scores,
      weights: r.weights,
      contributions: r.contributions,
      available: r.available,
      attrItems: r.attrItems,
      geo: r.geo,
      time: r.time,
      text: r.text,
      image: r.image,
      reasons: r.reasons,
      threshold: r.threshold,
      passed: r.passed,
      hardConflict: r.hardConflict,
      updatedAt: Date.now()
    };
    const payload = existed
      ? scored
      : Object.assign({ status: 'new', userStatus: 'new', createdAt: Date.now() }, scored);
    const match = await store.upsertMatch(payload);
    if (!existed) created += 1;
    persisted.push(match);
  }

  persisted.sort((a, b) => b.score - a.score);
  await store.updateItem(lostItem.id, {
    matchCount: persisted.length,
    status: lostItem.status === 'searching' && persisted.some((m) => m.passed) ? 'candidate_found' : lostItem.status
  });

  // 主动提醒：超过阈值的新候选生成通知
  const strong = persisted.filter((m) => m.passed && m.status === 'new').slice(0, 3);
  const existingNtf = await store.notifications(lostItem.userId);
  const ntfMatchIds = {};
  existingNtf.forEach((n) => { if (n.matchId) ntfMatchIds[n.matchId] = true; });
  for (let i = 0; i < strong.length; i += 1) {
    const m = strong[i];
    if (ntfMatchIds[m.id]) continue;
    const found = await store.getItem(m.foundId);
    if (!found) continue;
    const fv = await viewItem(found);
    await store.insertNotification({
      id: 'ntf_' + m.id,
      userId: lostItem.userId,
      type: 'new_match',
      matchId: m.id,
      lostId: m.lostId,
      foundId: m.foundId,
      title: '发现新的高相似候选',
      body: '「' + fv.title + '」在 ' + fv.locationName + ' 被发现，综合匹配度 ' + Math.round(m.score * 100) + '%',
      read: false,
      createdAt: Date.now()
    });
  }

  return {
    created,
    total: persisted.length,
    top: persisted[0] ? await matchView(persisted[0]) : null,
    elapsed,
    candidates: ranked.candidates
  };
}

async function runMatchForFound(foundItem, options) {
  const opts = options || {};
  const losts = await store.itemsOf('lost');
  const ranked = matcher.rankOwners(foundItem, losts, { topK: opts.topK || 20 });

  let created = 0;
  const persisted = [];
  const existing = await store.matchesOfFound(foundItem.id);
  const existingIds = {};
  existing.forEach((m) => { existingIds[m.lostId] = m; });

  for (let i = 0; i < ranked.results.length; i += 1) {
    const r = ranked.results[i];
    if (r.score < 0.32) continue;
    const existed = !!existingIds[r.lostItem.id];
    const scored = {
      id: 'match_' + r.lostItem.id + '__' + foundItem.id,
      lostId: r.lostItem.id,
      foundId: foundItem.id,
      score: Number(r.score.toFixed(4)),
      scores: r.scores,
      weights: r.weights,
      contributions: r.contributions,
      available: r.available,
      attrItems: r.attrItems,
      geo: r.geo,
      time: r.time,
      text: r.text,
      image: r.image,
      reasons: r.reasons,
      threshold: r.threshold,
      passed: r.passed,
      hardConflict: r.hardConflict,
      updatedAt: Date.now()
    };
    const payload = existed
      ? scored
      : Object.assign({ status: 'new', userStatus: 'new', createdAt: Date.now() }, scored);
    const match = await store.upsertMatch(payload);
    if (!existed) created += 1;
    persisted.push(match);

    if (!existed && r.passed) {
      await store.insertNotification({
        id: 'ntf_' + match.id,
        userId: r.lostItem.userId,
        type: 'new_match',
        matchId: match.id,
        lostId: match.lostId,
        foundId: match.foundId,
        title: '有人捡到了相似物品',
        body: '你寻找中的「' + (r.lostItem.title || '物品') + '」出现新的候选，综合匹配度 ' + Math.round(r.score * 100) + '%',
        read: false,
        createdAt: Date.now()
      });
    }
  }

  await store.updateItem(foundItem.id, { matchCount: persisted.length });
  persisted.sort((a, b) => b.score - a.score);
  return { created, total: persisted.length, top: persisted[0] ? await matchView(persisted[0]) : null };
}

/** 增量匹配：新记录入库后与所有未完成记录再匹配一次 */
async function incrementalMatch() {
  const losts = (await store.itemsOf('lost')).filter((i) => i.status !== 'recovered' && i.status !== 'closed');
  const founds = (await store.itemsOf('found')).filter((i) => i.status !== 'returned' && i.status !== 'closed');
  let created = 0;
  for (let i = 0; i < losts.length; i += 1) {
    const r = await runMatchForLost(losts[i], { topK: 8 });
    created += r.created;
  }
  for (let j = 0; j < founds.length; j += 1) {
    await runMatchForFound(founds[j], { topK: 8 });
  }
  return { created, losts: losts.length, founds: founds.length };
}

/**
 * 分块匹配：一次只处理 chunk 条失物，返回进度。
 *
 * 为什么需要：
 *   微信云开发的云函数**默认超时只有 3 秒**。
 *   完整匹配是「17 条失物 × (读候选 + 打分 + 多次写入)」，
 *   在真实云数据库上远超 3 秒，必然报 -504003。
 *   因此必须让它可中断、可续跑——每次只做一小块，调用方拿 next 继续。
 *
 * @param {number} offset 从第几条开始
 * @param {number} chunk  本次处理多少条
 */
async function matchLostChunk(offset, chunk) {
  const all = (await store.itemsOf('lost'))
    .filter((i) => i.status !== 'recovered' && i.status !== 'closed')
    .sort((a, b) => String(a.id).localeCompare(String(b.id))); // 稳定顺序，保证游标可靠

  const start = Math.max(0, offset || 0);
  const size = Math.max(1, chunk || 6);
  const slice = all.slice(start, start + size);

  let created = 0;
  for (let i = 0; i < slice.length; i += 1) {
    const r = await runMatchForLost(slice[i], { topK: 8 });
    created += r.created;
  }

  const next = start + slice.length;
  return {
    processed: slice.length,
    created,
    total: all.length,
    nextOffset: next < all.length ? next : null
  };
}

/** 分块匹配：一次只处理 chunk 条拾物 */
async function matchFoundChunk(offset, chunk) {
  const all = (await store.itemsOf('found'))
    .filter((i) => i.status !== 'returned' && i.status !== 'closed')
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const start = Math.max(0, offset || 0);
  const size = Math.max(1, chunk || 6);
  const slice = all.slice(start, start + size);

  for (let i = 0; i < slice.length; i += 1) {
    await runMatchForFound(slice[i], { topK: 8 });
  }

  const next = start + slice.length;
  return {
    processed: slice.length,
    total: all.length,
    nextOffset: next < all.length ? next : null
  };
}

/* ===================== 视图 ===================== */

async function matchView(match, options) {
  const opts = options || {};
  const lost = await store.getItem(match.lostId);
  const found = await store.getItem(match.foundId);
  if (!lost || !found) return null;

  const reasons = match.reasons || { positive: [], conflict: [], uncertain: [] };
  const st = statusInfo(MATCH_STATUS, match.status);
  const lostView = await viewItem(lost);
  const foundView = await viewItem(found);

  return {
    id: match.id,
    lostId: match.lostId,
    foundId: match.foundId,
    score: match.score,
    percent: Math.round(match.score * 100),
    threshold: match.threshold,
    passed: match.passed,
    lost: lostView,
    found: foundView,
    counterpart: opts.from === 'found' ? lostView : foundView,
    reasons,
    reasonTexts: reasons.positive.map((r) => r.text),
    conflictTexts: reasons.conflict.map((r) => r.text),
    uncertainTexts: reasons.uncertain.map((r) => r.text),
    geoText: match.geo && match.geo.available ? '距离最后丢失地点' + match.geo.distanceText : '地点信息不足',
    timeText: match.time && match.time.available
      ? (match.time.inRange ? '拾取时间落在丢失时间范围内' : '时间相差' + match.time.deltaText)
      : '时间信息不足',
    status: match.status,
    statusLabel: st.label,
    statusClass: st.cls,
    createdAt: match.createdAt,
    createdText: timeUtil.fromNow(match.createdAt),
    userStatus: match.userStatus || 'new',
    scoreBars: matcher.scoreBars(match)
  };
}

async function candidatesForLost(lostId, options) {
  const opts = options || {};
  const lost = await store.getItem(lostId);
  if (!lost) return { views: [], results: [], candidates: 0 };
  /**
   * 已闭环的失物不再产出候选（物品找回了还看到「可能匹配」没有意义，
   * 而且容易误操作）。拾物侧同样过滤已归还 / 已关闭的记录。
   */
  if (lost.status === 'recovered' || lost.status === 'closed') {
    return { views: [], results: [], candidates: 0 };
  }
  const founds = (await store.itemsOf('found'))
    .filter((f) => f.status !== 'returned' && f.status !== 'closed');
  const ranked = matcher.rankCandidates(lost, founds, { topK: opts.topK || 20 });
  const existing = await store.matchesOfLost(lostId);
  const map = {};
  existing.forEach((m) => { map[m.foundId] = m; });

  const views = [];
  for (let i = 0; i < ranked.results.length; i += 1) {
    const r = ranked.results[i];
    if (r.score < (opts.minScore || 0.3)) continue;
    // 同 id 自匹配必须剔除（演示数据里存在 kind 写错、被放进 lost 集合的 found_* 记录）
    if (r.foundItem.id === lostId) continue;
    const m = map[r.foundItem.id];
    // 与服务端一致地遵守「已排除」状态：除非显式要求，否则不再返回该候选
    if (!opts.includeRejected && m && (m.status === 'rejected' || m.userStatus === 'rejected')) continue;
    const merged = Object.assign({}, m || {
      id: 'match_' + lostId + '__' + r.foundItem.id,
      status: 'new',
      userStatus: 'new',
      createdAt: Date.now()
    }, r, {
      id: m ? m.id : 'match_' + lostId + '__' + r.foundItem.id,
      status: m ? m.status : 'new',
      userStatus: m ? (m.userStatus || 'new') : 'new'
    });
    const v = await matchView(merged, { from: 'lost' });
    if (v) views.push(v);
  }
  return { results: ranked.results, views, candidates: ranked.candidates, elapsed: ranked.elapsed };
}

async function candidatesForFound(foundId, options) {
  const opts = options || {};
  const found = await store.getItem(foundId);
  if (!found) return { views: [], results: [], candidates: 0 };
  // 已归还 / 已关闭的拾物不再产出候选（理由同 candidatesForLost）
  if (found.status === 'returned' || found.status === 'closed') {
    return { views: [], results: [], candidates: 0 };
  }
  const losts = (await store.itemsOf('lost'))
    .filter((l) => l.status !== 'recovered' && l.status !== 'closed');
  const ranked = matcher.rankOwners(found, losts, { topK: opts.topK || 20 });
  const existing = await store.matchesOfFound(foundId);
  const map = {};
  existing.forEach((m) => { map[m.lostId] = m; });

  const views = [];
  for (let i = 0; i < ranked.results.length; i += 1) {
    const r = ranked.results[i];
    if (r.score < (opts.minScore || 0.3)) continue;
    // 对称地剔除自匹配
    if (r.lostItem.id === foundId) continue;
    const m = map[r.lostItem.id];
    if (!opts.includeRejected && m && (m.status === 'rejected' || m.userStatus === 'rejected')) continue;
    const merged = Object.assign({}, m || {
      id: 'match_' + r.lostItem.id + '__' + foundId,
      status: 'new',
      userStatus: 'new',
      createdAt: Date.now()
    }, r, {
      id: m ? m.id : 'match_' + r.lostItem.id + '__' + foundId,
      status: m ? m.status : 'new',
      userStatus: m ? (m.userStatus || 'new') : 'new'
    });
    const v = await matchView(merged, { from: 'found' });
    if (v) views.push(v);
  }
  return { results: ranked.results, views, candidates: ranked.candidates };
}

/** 全局候选流（匹配页与首页使用） */
async function allCandidateViews(options) {
  const opts = options || {};
  const losts = (await store.itemsOf('lost')).filter((i) => {
    if (opts.mineOnly && opts.userId && i.userId !== opts.userId) return false;
    return i.status !== 'recovered' && i.status !== 'closed';
  });
  const collected = [];
  for (let i = 0; i < losts.length; i += 1) {
    const res = await candidatesForLost(losts[i].id, { topK: 12, minScore: opts.minScore || 0.3 });
    res.views.forEach((v) => collected.push(v));
  }
  const byId = {};
  collected.forEach((v) => {
    if (!byId[v.id] || byId[v.id].score < v.score) byId[v.id] = v;
  });
  let list = Object.keys(byId).map((k) => byId[k]);
  if (opts.category && opts.category !== 'all') {
    list = list.filter((v) => (v.found.attributes || {}).category === opts.category);
  }
  list.sort((a, b) => b.score - a.score);
  return list;
}

/** 对比页数据 */
async function compareDetail(matchId, options) {
  const opts = options || {};
  let match = matchId ? await store.getMatch(matchId) : null;
  let lost;
  let found;

  if (match) {
    lost = await store.getItem(match.lostId);
    found = await store.getItem(match.foundId);
  } else if (opts.lostId && opts.foundId) {
    lost = await store.getItem(opts.lostId);
    found = await store.getItem(opts.foundId);
  }
  if (!lost || !found) return null;

  const detail = matcher.scorePair(lost, found);
  const merged = Object.assign({}, match || {
    id: 'match_' + lost.id + '__' + found.id,
    lostId: lost.id,
    foundId: found.id,
    status: 'new',
    userStatus: 'new',
    createdAt: Date.now()
  }, detail, { id: match ? match.id : 'match_' + lost.id + '__' + found.id });

  const view = await matchView(merged, opts);
  return Object.assign({
    detail,
    bars: matcher.scoreBars(detail),
    explanation: matcher.explain(detail, lost, found),
    advice: matcher.advise(merged),
    attrRows: ops.buildAttrRows(detail.attrItems),
    weightsText: ops.weightText(detail)
  }, view);
}

/* ===================== 认领核验 ===================== */

/**
 * 管理权限名单（可以操作任何人的记录）。
 *
 * ⚠ 只放真正的管理员，**不要**把演示主账号 u_me 放进来：
 *   u_me 是演示数据里大部分记录的所有者，一旦它拥有管理权限，
 *   「只能改自己的记录」这条规则就会被静默绕过，安全性等于没有。
 *   初始化类权限（system.* / seed.demo）另有名单，见 index.js 的 INIT_IDS。
 */
const ADMIN_IDS = ['u_admin'];

function isAdmin(userId) {
  return ADMIN_IDS.indexOf(userId) >= 0;
}

/** 进行中的认领状态：这些状态下不允许对同一条失物再开新单 */
const ACTIVE_CLAIM_STATUS = ['answering', 'submitted', 'verified'];

/**
 * 解析候选的 matchId。
 *
 * ⚠ 真实缺陷：候选列表是**读时重算**的，大多数候选从来没有落过库，
 *   ID 是按 `match_<lostId>_<foundId>` 约定现造的合成 id。
 *   旧实现直接 `store.getMatch(matchId)`，拿不到就回「候选不存在」——
 *   也就是说「从候选卡片直接点发起认领」在这条路径上是走不通的。
 *
 * ⚠ 还有一个坑：**物品 id 里本来就可能含下划线**
 *   （演示数据如 `found_cup_01`，真实发布生成的如 `item_mv0wosyq_1rl`）。
 *   用「按 `_` 切分猜」的方法去还原合成 id 是不可靠的。
 *   因此 parseSyntheticMatchId 统一改成按 `__`（双下划线）分隔，
 *   同时保留对旧格式的逐个下划线回溯，兼容历史数据。
 */
function parseSyntheticMatchId(matchId) {
  const id = String(matchId || '');
  const PREFIX = 'match_';
  if (id.indexOf(PREFIX) !== 0) return null;
  const body = id.slice(PREFIX.length);

  const cuts = [];
  const delim = body.indexOf('__');
  if (delim > 0) cuts.push(delim);
  // 兼容旧格式（单下划线拼接）：逐个下划线位置回溯
  for (let i = 1; i < body.length - 1; i += 1) {
    if (body[i] === '_' && cuts.indexOf(i) < 0) cuts.push(i);
  }
  return { body, cuts };
}

async function resolveMatch(matchId) {
  const existed = await store.getMatch(matchId);
  if (existed) return existed;

  const parsed = parseSyntheticMatchId(matchId);
  if (!parsed) return null;

  for (let k = 0; k < parsed.cuts.length; k += 1) {
    const i = parsed.cuts[k];
    const lostId = parsed.body.slice(0, i);
    const foundId = parsed.body.slice(i + 1).replace(/^_/, '');
    if (!lostId || !foundId) continue;
    const lost = await store.getItem(lostId);
    const found = await store.getItem(foundId);
    if (!lost || !found || lost.kind !== 'lost' || found.kind !== 'found') continue;

    const rec = await store.upsertMatch({
      id: matchId,
      lostId,
      foundId,
      status: 'new',
      userStatus: 'new',
      createdAt: Date.now()
    });
    if (!rec) return null;

    /**
     * ⚠ upsertMatch 按 (lostId, foundId) 去重：
     *   若这一对已有记录（旧版本用的 id 约定不同），它会**沿用原有记录的 id**
     *   并把传入 id 丢掉。此时如果调用方继续用「传入的 matchId」去
     *   updateMatch / claimByMatch，就会影响 0 行 / 查不到东西——
     *   这正是「认领单存在但它的 matchId 指向一个不存在的 match」的来源。
     *
     *   这里把 id 归一到调用方使用的那套约定，保证
     *     resolveMatch(x).id === x
     *   同时把已经挂在旧 id 上的认领单一并迁移，避免历史认领单被孤立。
     */
    if (rec.id !== matchId) {
      // 走显式的改名路径：updateMatch 会剥掉 id（主键保护），改不动
      await store.renameMatchId(rec.id, matchId);
      rec.id = matchId;
    }
    return rec;
  }
  return null;
}

/**
 * 发起认领。
 *
 * 三道校验（都是之前缺的）：
 *   1. 只有失物主人能为自己的失物发起认领——claimantId 取自 lost.userId，
 *      不校验就等于允许任何人替别人发起；
 *   2. 失物已经找回 / 关闭时不再接受新认领；
 *   3. 同一条失物只允许存在一张「进行中」的认领单，避免一件物品挂多张单、
 *      归还一张后其余仍停在 claimed，物品状态与 match 状态互相矛盾。
 *
 * @param {string} matchId
 * @param {{userId?:string}} [options] 调用方身份；不传时跳过身份校验（内部/脚本调用）
 */
async function startClaim(matchId, options) {
  const opts = options || {};
  const match = await resolveMatch(matchId);
  if (!match) return { ok: false, message: '候选不存在' };
  const found = await store.getItem(match.foundId);
  const lost = await store.getItem(match.lostId);
  if (!found || !lost) return { ok: false, message: '记录不存在' };
  if (match.status === 'rejected') return { ok: false, message: '该候选已被排除' };

  const userId = opts.userId || '';
  if (userId && !isAdmin(userId) && lost.userId !== userId) {
    return { ok: false, message: '只能为自己的失物发起认领' };
  }
  if (lost.status === 'recovered' || lost.status === 'closed') {
    return { ok: false, message: '该失物已找回或已关闭，不再接受新的认领' };
  }

  /**
   * 用**归一后的** match.id 作为认领单的 key：
   *   resolveMatch 保证返回记录的 id 就是请求里用的那个，但显式写成 match.id
   *   可以避免以后有人改 resolveMatch 时这里悄悄失配。
   */
  const keyMatchId = match.id || matchId;
  const existing = await store.claimByMatch(keyMatchId);
  if (!existing) {
    const siblings = await store.claimsOfLost(match.lostId);
    const active = siblings.filter((c) => ACTIVE_CLAIM_STATUS.indexOf(c.status) >= 0);
    if (active.length) {
      return {
        ok: false,
        message: '该失物已有一张进行中的认领单（' + active[0].id + '），请先完成或结束它',
        activeClaimId: active[0].id
      };
    }
  }

  let claim = existing;
  if (!claim) {
    claim = {
      id: 'claim_' + keyMatchId,
      matchId: keyMatchId,
      lostId: match.lostId,
      foundId: match.foundId,
      claimantId: lost.userId,
      keeperId: found.userId,
      questions: ops.buildQuestions(found),
      answers: [],
      verificationScore: 0,
      status: 'answering',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await store.insertClaim(claim);
  }
  await store.updateMatch(keyMatchId, { status: 'claimed', userStatus: 'claimed' });
  await store.updateItem(lost.id, { status: 'verifying' });
  if (found.status === 'available') await store.updateItem(found.id, { status: 'reserved' });
  return { ok: true, claim, claimView: await claimView(claim) };
}

/**
 * 提交核验回答：只有认领者（失主）本人可以作答。
 */
async function submitClaim(claimId, answers, options) {
  const opts = options || {};
  const claim = await store.getClaim(claimId);
  if (!claim) return { ok: false, message: '认领单不存在' };
  const userId = opts.userId || '';
  if (userId && !isAdmin(userId) && claim.claimantId !== userId) {
    return { ok: false, message: '只有发起认领的失主可以提交核验回答' };
  }
  /**
   * 状态守卫：startClaim 对同一候选是幂等的（已存在就返回旧认领单），
   * 因此可能拿到已归还 / 已拒绝的历史单。不校验就会把已闭环的认领单
   * 重新激活回 submitted。
   */
  if (claim.status !== 'answering') {
    const st = statusInfo(CLAIM_STATUS, claim.status);
    return { ok: false, message: '该认领单当前状态为「' + st.label + '」，不能重复提交核验回答' };
  }
  const result = ops.verifyAll(claim.questions, answers);
  await store.updateClaim(claimId, {
    answers: result.list,
    verificationScore: result.score,
    status: 'submitted',
    submittedAt: Date.now()
  });
  await store.updateMatch(claim.matchId, { status: 'claimed' });
  await store.insertNotification({
    id: 'ntf_claim_' + claimId,
    userId: claim.keeperId,
    type: 'claim_submitted',
    matchId: claim.matchId,
    title: '有人发起了认领，请核对隐藏特征',
    body: '系统语义核验辅助分 ' + Math.round(result.score * 100) + '%，请结合线下特征确认是否为其所有',
    read: false,
    createdAt: Date.now()
  });
  const updated = await store.getClaim(claimId);
  return { ok: true, claim: updated, claimView: await claimView(updated) };
}

/**
 * 拾物者确认 / 拒绝。
 *
 * 两道校验（都是之前缺的）：
 *   1. 只有拾物者本人能确认——否则任何人都能替物主「通过」一次认领；
 *   2. 只有「待拾物者确认」状态可以确认——否则已通过的认领单会被再改成
 *      「未通过」（重复写 feedback、把已归还的流程反复改写）。
 */
async function confirmClaim(claimId, action, remark, options) {
  const opts = options || {};
  const claim = await store.getClaim(claimId);
  if (!claim) return { ok: false, message: '认领单不存在' };

  const userId = opts.userId || '';
  if (userId && !isAdmin(userId) && claim.keeperId !== userId) {
    return { ok: false, message: '只有拾物者本人可以确认或拒绝该认领' };
  }
  if (claim.status !== 'submitted') {
    const st = statusInfo(CLAIM_STATUS, claim.status);
    return { ok: false, message: '该认领单当前状态为「' + st.label + '」，不能重复确认' };
  }
  if (action !== 'pass' && action !== 'reject') {
    return { ok: false, message: 'action 只能是 pass 或 reject' };
  }

  const isPass = action === 'pass';
  const lost = await store.getItem(claim.lostId);
  const found = await store.getItem(claim.foundId);

  await store.updateClaim(claimId, {
    status: isPass ? 'verified' : 'rejected',
    confirmedAt: Date.now(),
    remark: remark || ''
  });
  await store.updateMatch(claim.matchId, { status: isPass ? 'verified' : 'failed' });
  if (lost) await store.updateItem(lost.id, { status: isPass ? 'waiting_handover' : 'candidate_found' });
  if (found) await store.updateItem(found.id, { status: isPass ? 'reserved' : 'available' });

  await store.insertFeedback({
    id: 'fb_' + claimId + '_' + Date.now(),
    matchId: claim.matchId,
    lostId: claim.lostId,
    foundId: claim.foundId,
    userAction: isPass ? 'claim_confirmed' : 'claim_rejected',
    confirmed: !!isPass,
    verificationScore: claim.verificationScore,
    timestamp: Date.now()
  });

  await store.insertNotification({
    id: 'ntf_result_' + claimId,
    userId: claim.claimantId,
    type: isPass ? 'claim_passed' : 'claim_failed',
    matchId: claim.matchId,
    title: isPass ? '核验通过，请与拾物者约定交接' : '核验未通过',
    body: isPass ? '对方确认了隐藏特征，请尽快完成线下交接并确认归还' : '对方认为特征不匹配，本次认领已结束',
    read: false,
    createdAt: Date.now()
  });

  const updated = await store.getClaim(claimId);
  return { ok: true, claim: updated, claimView: await claimView(updated) };
}

/**
 * 完成归还。
 *
 * 校验：只有本次认领的双方可以确认归还（线下交接完成后的收尾动作），
 * 且只有「核验已通过（待交接）」状态可以完成——否则能对一张刚提交、
 * 尚未确认的认领单直接置为已归还，跳过拾物者确认这一环。
 */
async function completeReturn(claimId, options) {
  const opts = options || {};
  const claim = await store.getClaim(claimId);
  if (!claim) return { ok: false, message: '认领单不存在' };

  const userId = opts.userId || '';
  if (userId && !isAdmin(userId) && claim.claimantId !== userId && claim.keeperId !== userId) {
    return { ok: false, message: '只有本次认领的双方可以确认归还' };
  }
  if (claim.status !== 'verified') {
    const st = statusInfo(CLAIM_STATUS, claim.status);
    return { ok: false, message: '该认领单当前状态为「' + st.label + '」，需先完成核验确认' };
  }

  await store.updateClaim(claimId, { status: 'returned', returnedAt: Date.now() });
  await store.updateMatch(claim.matchId, { status: 'returned' });
  const lost = await store.getItem(claim.lostId);
  const found = await store.getItem(claim.foundId);
  if (lost) await store.updateItem(lost.id, { status: 'recovered' });
  if (found) await store.updateItem(found.id, { status: 'returned' });

  await store.insertFeedback({
    id: 'fb_' + claimId + '_returned',
    matchId: claim.matchId,
    lostId: claim.lostId,
    foundId: claim.foundId,
    userAction: 'returned',
    confirmed: true,
    timestamp: Date.now()
  });
  await store.insertNotification({
    id: 'ntf_returned_' + claimId,
    userId: claim.keeperId,
    type: 'returned',
    matchId: claim.matchId,
    title: '物品已归还，感谢你',
    body: '本次匹配闭环结束，正样本已写入反馈集',
    read: false,
    createdAt: Date.now()
  });
  const updated = await store.getClaim(claimId);
  return { ok: true, claim: updated, claimView: await claimView(updated) };
}

/**
 * 排除候选（弱负样本）。
 *
 * 与客户端 utils/service.js 同源的问题：候选列表是读时重算的，
 * 大多数候选从未落库，直接 updateMatch 会静默失败（返回 ok:false 但页面
 * 照样提示成功）。这里按候选列表的命名约定补一条记录，保证排除真的生效。
 */
async function rejectMatch(matchId, reason, context) {
  let match = await store.getMatch(matchId);
  if (!match) {
    const ctx = context || {};
    if (!ctx.lostId || !ctx.foundId) {
      return { ok: false, message: '候选尚未落库，缺少记录信息，无法排除' };
    }
    /**
     * ⚠ upsertMatch 按 (lostId, foundId) 去重：
     *   如果这一对记录其实已经存在（只是调用方拿到的 matchId 与库里的 id 不一致），
     *   它会沿用**原有记录的 id**。因此后续更新必须用 upsert 的返回值里的 id，
     *   否则 updateMatch 会按一个库里不存在的 id 更新，静默影响 0 行 —— 这正是
     *   「点了排除，界面没有任何变化」在云端模式的成因。
     */
    match = await store.upsertMatch({
      id: matchId,
      lostId: ctx.lostId,
      foundId: ctx.foundId,
      score: ctx.score || 0,
      threshold: ctx.threshold || 0,
      passed: !!ctx.passed,
      createdAt: Date.now(),
      userStatus: 'new'
    });
    if (!match) return { ok: false, message: '候选记录创建失败' };
  }
  const targetId = match.id || matchId;
  await store.updateMatch(targetId, { status: 'rejected', userStatus: 'rejected', rejectReason: reason || '' });
  await store.insertFeedback({
    id: 'fb_reject_' + targetId + '_' + Date.now(),
    matchId: targetId,
    lostId: match.lostId,
    foundId: match.foundId,
    userAction: 'rejected',
    confirmed: false,
    reason: reason || '',
    timestamp: Date.now()
  });
  return { ok: true, matchId: targetId };
}

/** 撤销排除：把候选放回列表（status 与 userStatus 必须一起复位） */
async function restoreMatch(matchId, context) {
  const match = await store.getMatch(matchId);
  if (!match) {
    const ctx = context || {};
    if (!ctx.lostId || !ctx.foundId) return { ok: false, message: '候选不存在' };
    // 与 rejectMatch 对称：同样要用 upsert 返回的记录 id 去更新
    const created = await store.upsertMatch({
      id: matchId,
      lostId: ctx.lostId,
      foundId: ctx.foundId,
      status: 'new',
      userStatus: 'new',
      createdAt: Date.now()
    });
    if (created && created.id && created.id !== matchId) {
      await store.updateMatch(created.id, { status: 'new', userStatus: 'new' });
    }
    return { ok: true };
  }
  if (match.status !== 'rejected' && match.userStatus !== 'rejected') {
    return { ok: false, message: '该候选没有被排除' };
  }
  await store.updateMatch(matchId, { status: 'new', userStatus: 'new', rejectReason: '' });
  return { ok: true };
}

async function claimView(claim) {
  if (!claim) return null;
  const lost = await store.getItem(claim.lostId);
  const found = await store.getItem(claim.foundId);
  const st = statusInfo(CLAIM_STATUS, claim.status);
  const match = await store.getMatch(claim.matchId);
  return {
    id: claim.id,
    matchId: claim.matchId,
    status: claim.status,
    statusLabel: st.label,
    statusClass: st.cls,
    questions: claim.questions,
    answers: claim.answers || [],
    verificationScore: claim.verificationScore || 0,
    verificationPercent: Math.round((claim.verificationScore || 0) * 100),
    lost: await viewItem(lost),
    found: await viewItem(found),
    lostId: claim.lostId,
    foundId: claim.foundId,
    claimantId: claim.claimantId,
    keeperId: claim.keeperId,
    matchScore: match ? match.score : 0,
    createdAt: claim.createdAt,
    createdText: timeUtil.fromNow(claim.createdAt),
    canAnswer: claim.status === 'answering',
    canConfirm: claim.status === 'submitted',
    privateFeatures: (found && found.privateFeatures) || [],
    /* 临时会话摘要：列表页显示「N 条消息」，详情页再取完整会话 */
    messageCount: (claim.messages || []).length,
    sessionState: chat.sessionState(claim.status).key
  };
}

/* ===================== 核验期临时会话 =====================
 *
 * 与客户端 utils/service.js 同源，规则写在 core/chat.js：
 *   · answering 阶段不开放（防止认领者用会话套取隐藏特征）；
 *   · 只有 claimantId / keeperId 能读写；
 *   · 归还 / 拒绝后转只读；
 *   · 手机号、社交账号在写入前脱敏。
 */

async function roleOf(claim, userId) {
  if (!claim) return '';
  if (claim.claimantId === userId) return 'claimant';
  if (claim.keeperId === userId) return 'keeper';
  return '';
}

async function claimSessionView(claimId, options) {
  const opts = options || {};
  const claim = await store.getClaim(claimId);
  if (!claim) return null;
  const userId = opts.userId || '';
  if (!(await roleOf(claim, userId))) {
    return {
      state: 'closed',
      stateLabel: '无权访问',
      stateDesc: '只有本次认领的失主与拾物者可以查看会话',
      canSend: false,
      messages: [],
      hasMessages: false,
      count: 0
    };
  }
  /*
   * chat.sessionView 是纯函数（同步），昵称解析必须是同步的，
   * 所以先把用户表一次性读进内存再查表。
   * 用户量在这个场景下很小（演示环境是固定的几个账号），不构成性能问题。
   */
  const roster = {};
  const users = await store.users();
  users.forEach((u) => { roster[u.id] = u.nickName || '同学'; });
  return chat.sessionView(claim, {
    userId,
    nameOf: (id) => roster[id] || '同学'
  });
}

async function postClaimMessage(claimId, input) {
  const data = input || {};
  const userId = data.userId || '';
  const claim = await store.getClaim(claimId);
  if (!claim) return { ok: false, message: '认领单不存在' };

  const role = await roleOf(claim, userId);
  if (!role) return { ok: false, message: '只有本次认领的双方可以发送消息' };
  if (!chat.canSend(claim.status)) {
    const st = chat.sessionState(claim.status);
    return {
      ok: false,
      message: st.key === 'closed' ? '提交核验回答后才能开启会话' : '本次认领已结束，会话不再接受新消息'
    };
  }

  const created = chat.createMessage({
    claimId,
    senderId: userId,
    senderRole: role,
    text: data.text,
    uid: store.uid
  });
  if (!created.ok) return created;

  const messages = chat.appendMessage(claim.messages, created.value);
  await store.updateClaim(claimId, { messages });

  // 通知对方，避免只能靠反复刷新页面发现新消息
  const counterpartId = role === 'keeper' ? claim.claimantId : claim.keeperId;
  await store.insertNotification({
    id: 'ntf_msg_' + created.value.id,
    userId: counterpartId,
    type: 'claim_message',
    matchId: claim.matchId,
    title: '认领会话有新消息',
    body: '对方在核验会话里留言：' + created.value.text.slice(0, 40),
    read: false,
    createdAt: Date.now()
  });

  return {
    ok: true,
    message: created.value,
    session: await claimSessionView(claimId, { userId })
  };
}

/* ===================== 统计与实验 ===================== */

async function stats() {
  const items = await store.fetchAll('items', {});
  const matches = await store.allMatches();
  const claims = await store.fetchAll('claims', {});
  const losts = items.filter((i) => i.kind === 'lost');
  const founds = items.filter((i) => i.kind === 'found');
  const passed = matches.filter((m) => m.passed);
  const recovered = losts.filter((l) => l.status === 'recovered').length;
  const totalLost = losts.length || 1;
  const pairTotal = losts.length * founds.length || 1;
  const meta = (await store.getMeta()) || {};

  return {
    lostCount: losts.length,
    foundCount: founds.length,
    matchCount: matches.length,
    strongMatchCount: passed.length,
    claimCount: claims.length,
    returnedCount: recovered,
    recoverRate: Math.round((recovered / totalLost) * 100),
    avgTopScore: matches.length ? Math.round((matches.reduce((s, m) => s + m.score, 0) / matches.length) * 100) : 0,
    avgMatchMs: meta.avgMatchMs || 0,
    matchRuns: meta.matchRuns || 0,
    searchingCount: losts.filter((l) => l.status === 'searching' || l.status === 'candidate_found').length,
    verifyingCount: losts.filter((l) => l.status === 'verifying').length,
    handoverCount: losts.filter((l) => l.status === 'waiting_handover').length,
    dataDensity: Math.round((matches.length / pairTotal) * 100)
  };
}

async function categoryDistribution() {
  const items = await store.fetchAll('items', {});
  const counts = {};
  items.forEach((it) => {
    const c = (it.attributes || {}).category || 'other';
    counts[c] = (counts[c] || 0) + 1;
  });
  const list = Object.keys(counts).map((k) => ({
    key: k,
    name: categorical.nameOf(k),
    icon: categorical.iconOf(k),
    count: counts[k]
  }));
  list.sort((a, b) => b.count - a.count);
  return list;
}

async function heatmap(options) {
  const opts = options || {};
  const items = await store.fetchAll('items', {});
  const cells = {};
  items.forEach((it) => {
    if (opts.category && opts.category !== 'all' && (it.attributes || {}).category !== opts.category) return;
    if (opts.kind && opts.kind !== 'all' && it.kind !== opts.kind) return;
    if (opts.since && it.createdAt < opts.since) return;
    const lid = (it.location && it.location.id) || 'unknown';
    if (!cells[lid]) {
      cells[lid] = {
        id: lid,
        name: (it.location && it.location.name) || '未知地点',
        area: (it.location && it.location.area) || 'area_center',
        areaName: locations.areaName((it.location && it.location.area) || 'area_center'),
        lat: it.location ? it.location.lat : 0,
        lng: it.location ? it.location.lng : 0,
        lost: 0,
        found: 0,
        total: 0
      };
    }
    if (it.kind === 'lost') cells[lid].lost += 1;
    else cells[lid].found += 1;
    cells[lid].total += 1;
  });
  const list = Object.keys(cells).map((k) => cells[k]).sort((a, b) => b.total - a.total);
  const max = list.length ? list[0].total : 1;
  list.forEach((c) => { c.level = Math.max(1, Math.ceil((c.total / max) * 4)); });
  return list;
}

async function timeline(options) {
  const opts = options || {};
  const events = [];

  if (opts.lostId) {
    const lost = await store.getItem(opts.lostId);
    if (lost) {
      events.push({
        at: lost.createdAt,
        type: 'lost_publish',
        label: '发布失物记录',
        desc: lost.location.name + ' · ' + timeUtil.rangeText(lost.timeRange)
      });
    }
  }
  if (opts.foundId) {
    const found = await store.getItem(opts.foundId);
    if (found) {
      events.push({ at: found.foundTime, type: 'found', label: '拾到物品', desc: found.location.name });
      events.push({
        at: found.createdAt,
        type: 'found_publish',
        label: '发布拾物记录',
        desc: '已保留 ' + (found.privateFeatures || []).length + ' 项隐藏核验特征'
      });
    }
  }
  if (opts.matchId) {
    const match = await store.getMatch(opts.matchId);
    if (match) {
      events.push({ at: match.createdAt, type: 'match', label: '生成候选匹配', desc: '综合匹配度 ' + Math.round(match.score * 100) + '%' });
      const claim = await store.claimByMatch(match.id);
      if (claim) {
        events.push({ at: claim.createdAt, type: 'claim', label: '发起认领', desc: claim.questions.length + ' 个隐藏特征问题' });
        if (claim.submittedAt) events.push({ at: claim.submittedAt, type: 'verify', label: '提交核验回答', desc: '辅助分 ' + Math.round(claim.verificationScore * 100) + '%' });
        if (claim.confirmedAt) events.push({ at: claim.confirmedAt, type: 'confirm', label: claim.status === 'rejected' ? '核验未通过' : '拾物者确认', desc: claim.remark || '' });
        if (claim.returnedAt) events.push({ at: claim.returnedAt, type: 'returned', label: '完成归还', desc: '匹配闭环结束' });
      }
    }
  }
  events.sort((a, b) => (a.at || 0) - (b.at || 0));
  return events.map((e) => Object.assign({}, e, {
    timeText: timeUtil.format(e.at),
    relative: timeUtil.fromNow(e.at)
  }));
}

/** 消融实验：使用带 identityId 的身份标注作为 ground truth */
async function evaluate() {
  const losts = (await store.itemsOf('lost')).filter((l) => l.identityId);
  const founds = (await store.itemsOf('found')).filter((f) => f.identityId);
  if (!losts.length || !founds.length) {
    return { groups: [], note: '数据集中缺少带身份标注的样本，无法计算指标' };
  }
  const groups = matcher.ABLATION_GROUPS.map((group) => {
    let recall1 = 0;
    let recall5 = 0;
    let mrr = 0;
    let totalMs = 0;
    let n = 0;
    losts.forEach((l) => {
      const t0 = Date.now();
      const ranked = matcher.rankCandidates(l, founds, { topK: 10, modes: group.modes });
      totalMs += Date.now() - t0;
      const results = ranked.results.filter((r) => r.score > 0.15);
      const idx = results.findIndex((r) => r.foundItem.identityId === l.identityId);
      n += 1;
      if (idx === 0) recall1 += 1;
      if (idx >= 0 && idx < 5) recall5 += 1;
      if (idx >= 0) mrr += 1 / (idx + 1);
    });
    return {
      key: group.key,
      name: group.name,
      desc: group.desc,
      modes: group.modes,
      sampleCount: n,
      recall1: n ? recall1 / n : 0,
      recall5: n ? recall5 / n : 0,
      mrr: n ? mrr / n : 0,
      avgMs: n ? Math.round(totalMs / n) : 0,
      recall1Percent: n ? Math.round((recall1 / n) * 100) : 0,
      recall5Percent: n ? Math.round((recall5 / n) * 100) : 0,
      mrrPercent: n ? Math.round((mrr / n) * 100) : 0
    };
  });
  const baseline = groups[0];
  const full = groups[groups.length - 1];
  return {
    groups,
    sampleCount: losts.length,
    foundCount: founds.length,
    improvement: {
      recall5: full.recall5Percent - baseline.recall5Percent,
      mrr: full.mrrPercent - baseline.mrrPercent,
      recall1: full.recall1Percent - baseline.recall1Percent
    },
    note: '指标基于数据集中的 identityId 身份标注计算：同一真实物品的不同照片/描述视为同一身份，' +
      '并包含外观接近的困难负样本。'
  };
}

async function notificationViews(userId) {
  const list = await store.notifications(userId);
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const n = list[i];
    const match = n.matchId ? await store.getMatch(n.matchId) : null;
    const lost = n.lostId ? await store.getItem(n.lostId) : null;
    const found = n.foundId ? await store.getItem(n.foundId) : null;
    out.push(Object.assign({}, n, {
      timeText: timeUtil.fromNow(n.createdAt),
      scorePercent: match ? Math.round(match.score * 100) : 0,
      lostView: lost ? await viewItem(lost) : null,
      foundView: found ? await viewItem(found) : null,
      canClaim: !!(match && match.status !== 'rejected' && lost && lost.userId === (userId || 'u_me'))
    }));
  }
  return out;
}

async function myLostItems(userId) {
  const list = await store.itemsByUser(userId, 'lost');
  const out = [];
  for (let i = 0; i < list.length; i += 1) out.push(await viewItem(list[i]));
  return out;
}

async function myFoundItems(userId) {
  const list = await store.itemsByUser(userId, 'found');
  const out = [];
  for (let i = 0; i < list.length; i += 1) out.push(await viewItem(list[i]));
  return out;
}

async function myClaims(userId) {
  const list = await store.claimsForUser(userId);
  const out = [];
  for (let i = 0; i < list.length; i += 1) out.push(await claimView(list[i]));
  return out;
}

/* ===================== 演示数据灌入 ===================== */

/**
 * 把内置演示数据集写入云数据库。
 * @param {object} options { reset: 是否先清空 }
 */
async function seedDemo(options) {
  const opts = options || {};
  await store.ensureCollections();

  if (opts.reset) {
    await store.clearData({ keepUsers: false });
  } else {
    const count = await store.countItems();
    if (count > 0) {
      /**
       * 库里有数据 ≠ 数据可用。
       *
       * 真实事故：云端曾用「还没有向量持久化」的旧版本代码灌过一次数据，
       * 那些记录没有 embeddings 字段。之后界面显示：
       *   视觉相似度 0%、综合分 48%（而不是 82%）
       * 因为 vlm.imageSimilarity() 找不到向量就判为「不可用」。
       *
       * 而单纯的「指纹比对」修不好这个问题——旧数据里根本没写过指纹，
       * undefined !== fingerprint 判为 false，于是永远跳过、旧数据永远留着。
       *
       * 所以这里**直接抽样检查数据本身**：随便取一条记录，看它有没有 embeddings。
       * 这比比对指纹更可靠，而且只需 1 次查询。
       */
      const probe = await store.sampleItem();
      const missingEmbeddings = probe && probe.image && !probe.embeddings;
      if (missingEmbeddings) {
        await store.clearData({ keepUsers: false });
        const recheck = await store.countItems();
        if (recheck > 0) {
          return {
            skipped: true,
            message: '旧数据缺少向量字段且清空失败，请手动传 reset: true'
          };
        }
        // 继续往下走，重新灌入
      } else {
        return {
          skipped: true,
          message: '数据库中已有 ' + count + ' 条记录，未重复灌入（如需重置请传 reset: true）'
        };
      }
    }
  }

  await store.ensureUsers(seedData.DEMO_USERS);
  userNameCache = null;

  const now = Date.now();
  const lostDefs = seedData.lostDefs(now);
  const foundDefs = seedData.foundDefs(now);
  const history = seedData.historyCase(now);

  const mk = (def, kind) => {
    const item = domain.buildItem(Object.assign({}, def, {
      kind,
      image: def.image || seedData.DEMO_IMAGE[def.id] || '',
      category: def.category,
      attributes: def.attributes || {}
    }), { now });
    item.image = item.image ? 'demo://' + String(item.image).replace('demo://', '') : '';
    item.embeddings = aiEmbed.buildItemVectors(item);
    return item;
  };

  const losts = lostDefs.map((d) => mk(d, 'lost')).sort((a, b) => a.createdAt - b.createdAt);
  const founds = foundDefs.map((d) => mk(d, 'found')).sort((a, b) => a.createdAt - b.createdAt);

  for (let i = 0; i < losts.length; i += 1) await store.insertItem(losts[i]);
  for (let j = 0; j < founds.length; j += 1) await store.insertItem(founds[j]);

  // 历史闭环案例
  const historyFound = mk(history.found, 'found');
  await store.insertItem(historyFound);
  const lostItem = losts.find((x) => x.id === history.lostId);
  if (lostItem) {
    const matchId = 'match_' + lostItem.id + '__' + historyFound.id;
    await store.upsertMatch({
      id: matchId,
      lostId: lostItem.id,
      foundId: historyFound.id,
      score: 0.93,
      scores: { image: 0.9, attr: 0.95, text: 0.92, geo: 0.97, time: 0.9 },
      weights: { image: 0.3, attr: 0.28, text: 0.22, geo: 0.12, time: 0.08 },
      contributions: { image: 0.27, attr: 0.266, text: 0.202, geo: 0.116, time: 0.072 },
      available: { image: true, attr: true, text: true, geo: true, time: true },
      reasons: {
        positive: [{ key: 'attr:main_color', text: '主色一致（黑）', weight: 0.5, score: 1 }],
        conflict: [],
        uncertain: []
      },
      geo: { score: 0.97, available: true, distance: 40, distanceText: '约 40 m' },
      time: { score: 0.9, available: true, delta: 20 * 60 * 1000, deltaText: '20 分钟', inRange: true },
      threshold: 0.72,
      passed: true,
      hardConflict: false,
      status: 'returned',
      userStatus: 'claimed',
      createdAt: historyFound.createdAt
    });
    const questions = ops.buildQuestions(historyFound);
    const answers = questions.map((q, i) => ({
      questionId: q.id,
      question: q.question,
      feature: q.feature,
      answer: history.claim.answers[i] || '',
      score: 0.66,
      reason: '历史演示数据'
    }));
    await store.insertClaim({
      id: 'claim_history_01',
      matchId,
      lostId: lostItem.id,
      foundId: historyFound.id,
      claimantId: lostItem.userId,
      keeperId: historyFound.userId,
      questions,
      answers,
      verificationScore: history.claim.verificationScore,
      status: 'returned',
      createdAt: historyFound.createdAt + 15 * 60 * 1000,
      submittedAt: historyFound.createdAt + 20 * 60 * 1000,
      confirmedAt: historyFound.createdAt + 45 * 60 * 1000,
      returnedAt: historyFound.createdAt + 75 * 60 * 1000
    });
    await store.updateItem(lostItem.id, { status: 'recovered' });
    await store.updateItem(historyFound.id, { status: 'returned' });
    await store.insertFeedback({
      id: 'fb_history_01',
      matchId,
      lostId: lostItem.id,
      foundId: historyFound.id,
      userAction: 'returned',
      confirmed: true,
      timestamp: historyFound.createdAt + 75 * 60 * 1000
    });
  }

  // 全量匹配一次，让首页/匹配页打开即有内容
  const t0 = Date.now();
  for (let i = 0; i < losts.length; i += 1) await runMatchForLost(losts[i], { topK: 12 });
  for (let j = 0; j < founds.length; j += 1) await runMatchForFound(founds[j], { topK: 8 });

  await store.setMeta({
    seedVersion: seedData.SEED_VERSION,
    avgMatchMs: Date.now() - t0,
    matchRuns: 1,
    seededAt: Date.now()
  });

  return {
    skipped: false,
    lostCount: losts.length,
    foundCount: founds.length + 1,
    elapsed: Date.now() - t0
  };
}

module.exports = {
  LOST_STATUS,
  FOUND_STATUS,
  MATCH_STATUS,
  CLAIM_STATUS,
  publish,
  runMatchForLost,
  runMatchForFound,
  incrementalMatch,
  matchLostChunk,
  matchFoundChunk,
  matchView,
  candidatesForLost,
  candidatesForFound,
  allCandidateViews,
  compareDetail,
  startClaim,
  submitClaim,
  confirmClaim,
  completeReturn,
  rejectMatch,
  restoreMatch,
  claimView,
  claimSessionView,
  postClaimMessage,
  stats,
  categoryDistribution,
  heatmap,
  timeline,
  evaluate,
  notificationViews,
  myLostItems,
  myFoundItems,
  myClaims,
  seedDemo,
  viewItem,
  toClientEntity
};
