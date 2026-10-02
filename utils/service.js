/**
 * 业务服务层
 * ---------------------------------------------------------------
 * 把「发布 → 结构化 → 召回 → 时空重排 → 候选解释 → 主动提醒 → 认领 → 核验 → 双方确认 → 归还 → 反馈」
 * 完整闭环（方案 4）封装成对页面友好的方法。
 */

const store = require('./store');
const matcher = require('./matcher');
const vlm = require('./vlm');
const timeUtil = require('./time');
const locations = require('./locations');
const categorical = require('./categories');
const colorUtil = require('./color');
const domain = require('../core/domain');

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

/* ===================== 计算缓存 =====================
 * 排序打分是纯函数：数据没变时结果完全一致。
 * 这里用 store 的变更事件做失效 + 短 TTL 兜底，避免页面反复进出时重复计算。
 */

const RANK_CACHE = {};
const RANK_TTL = 15000;
let rankDirty = true;

store.on(() => { rankDirty = true; });

function rankCacheGet(key) {
  const hit = RANK_CACHE[key];
  if (!rankDirty && hit && Date.now() - hit.at < RANK_TTL) return hit.value;
  return null;
}

function rankCacheSet(key, value) {
  if (rankDirty) {
    Object.keys(RANK_CACHE).forEach((k) => { delete RANK_CACHE[k]; });
    rankDirty = false;
  }
  RANK_CACHE[key] = { at: Date.now(), value };
  return value;
}

/* ===================== 视图模型 ===================== */

/**
 * 物品视图模型。
 *
 * 这里**不再自己实现一遍**，而是委托给 core/domain.js：
 * 之前 utils/service.js 与 core/domain.js 各有一份 itemView，
 * 两处逻辑几乎相同但并不完全同步——加了新字段（例如 hasImage）只改一边，
 * 就会出现「云端对、本地错」或反过来的诡异问题。
 *
 * 唯一需要注入的差异是用户名解析：小程序端从 store 取，云函数端从数据库缓存取。
 */
function itemView(item) {
  return domain.itemView(item, {
    userName: (userId) => store.user(userId).nickName
  });
}

/** 候选匹配视图：把打分细节翻译成候选卡字段（方案 6.3） */
function matchView(match, options) {
  const opts = options || {};
  const lost = store.getItem(match.lostId);
  const found = store.getItem(match.foundId);
  if (!lost || !found) return null;

  const reasons = match.reasons || { positive: [], conflict: [], uncertain: [] };
  const st = statusInfo(MATCH_STATUS, match.status);

  return {
    id: match.id,
    lostId: match.lostId,
    foundId: match.foundId,
    score: match.score,
    percent: Math.round(match.score * 100),
    threshold: match.threshold,
    passed: match.passed,
    lost: itemView(lost),
    found: itemView(found),
    counterpart: opts.from === 'found' ? itemView(lost) : itemView(found),
    reasons,
    reasonTexts: reasons.positive.map((r) => r.text),
    conflictTexts: reasons.conflict.map((r) => r.text),
    uncertainTexts: reasons.uncertain.map((r) => r.text),
    geoText: match.geo && match.geo.available
      ? '距离最后丢失地点' + match.geo.distanceText
      : '地点信息不足',
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

/* ===================== 发布 ===================== */

/**
 * 发布失物 / 拾物记录
 * @param {object} input
 *   kind: 'lost' | 'found'
 *   image/images, description, locationText, locationId, timeText/dateTime,
 *   privateFeatures: [string], userId, title
 */
function publish(input) {
  const data = input || {};
  const kind = data.kind === 'found' ? 'found' : 'lost';
  const now = Date.now();

  // 1) 地点标准化
  let location = null;
  let locationMatched = true;
  if (data.locationId) {
    location = locations.getById(data.locationId);
  }
  if (!location && data.locationText) {
    const norm = locations.normalize(data.locationText);
    location = norm.location;
    locationMatched = norm.matched;
  }
  if (!location) {
    location = locations.UNKNOWN_LOCATION;
    locationMatched = false;
  }

  // 2) 时间标准化
  let timeRange = null;
  let foundTime = 0;
  if (kind === 'lost') {
    if (data.timeStart) {
      timeRange = {
        start: data.timeStart,
        end: data.timeEnd || data.timeStart + 60 * timeUtil.MIN,
        text: data.timeStart && data.timeEnd
          ? timeUtil.format(data.timeStart) + ' — ' + timeUtil.formatClock(data.timeEnd)
          : '约 ' + timeUtil.format(data.timeStart)
      };
    } else if (data.timeText) {
      timeRange = timeUtil.parseTimeRange(data.timeText);
      if (!timeRange) timeRange = { start: now - timeUtil.HOUR, end: now, text: data.timeText };
    } else {
      timeRange = { start: now - timeUtil.HOUR, end: now, text: '约 ' + timeUtil.formatClock(now - 30 * timeUtil.MIN) };
    }
  } else {
    foundTime = data.foundTime || (data.timeText ? (timeUtil.parseTimeRange(data.timeText) || {}).start : 0) || now;
  }

  // 3) AI 结构化（用户确认后的属性优先）
  const image = data.image || (data.images && data.images[0]) || '';
  const auto = vlm.extractAttributes({
    image,
    description: data.description || '',
    type: kind
  });
  const attributes = Object.assign({}, auto.attributes, data.attributes || {});
  if (attributes.category === 'other' && data.attributes && data.attributes.category) {
    attributes.category = data.attributes.category;
  }

  const item = {
    id: store.uid(kind === 'lost' ? 'lost' : 'found'),
    kind,
    userId: data.userId || 'u_me',
    title: data.title || '',
    image,
    images: data.images || (image ? [image] : []),
    description: data.description || '',
    location,
    locationMatched,
    locationText: data.locationText || location.name,
    timeRange,
    foundTime,
    attributes,
    attributeSources: Object.assign({}, auto.sources, data.attributeSources || {}),
    privateFeatures: (data.privateFeatures || []).filter(Boolean),
    publicDescription: data.publicDescription || data.description || '',
    status: kind === 'lost' ? 'searching' : 'available',
    embeddings: {
      image: image ? vlm.embed('image', image) : null,
      text: vlm.embed('text', [data.description || '', categorical.nameOf(attributes.category), attributes.brand || '', attributes.main_color || ''].join(' '))
    },
    identityId: data.identityId || '',
    createdAt: now,
    updatedAt: now,
    views: 0,
    matchCount: 0
  };

  store.insertItem(item);

  // 4) 立即执行一次增量匹配（对应上线后“后台持续匹配”）
  const searchResult = kind === 'lost' ? runMatchForLost(item) : runMatchForFound(item);

  store.persist();

  return {
    item,
    itemView: itemView(item),
    auto: Object.assign({}, auto, { attributes }),
    locationMatched,
    matchCount: searchResult.created,
    top: searchResult.top
  };
}

/* ===================== 匹配 ===================== */

/**
 * 对一条失物执行匹配：召回 → 重排 → 落库 → 生成通知
 */
function runMatchForLost(lostItem, options) {
  const opts = options || {};
  const founds = store.itemsOf('found');
  const t0 = Date.now();
  const ranked = matcher.rankCandidates(lostItem, founds, { topK: opts.topK || 20, recallSize: 50 });
  const elapsed = Date.now() - t0;

  let created = 0;
  const persisted = [];
  ranked.results.forEach((r) => {
    if (r.score < 0.32) return; // 低于此分数不落库，避免候选列表噪音
    const existed = store.matchesOfLost(lostItem.id).some((m) => m.foundId === r.foundItem.id);
    const scored = {
      id: 'match_' + lostItem.id + '_' + r.foundItem.id,
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
    // 新建的候选需要状态与创建时间；已存在的候选只刷新分数，保留用户交互状态
    const payload = existed
      ? scored
      : Object.assign({
        status: 'new',
        userStatus: 'new',
        createdAt: Date.now()
      }, scored);
    const match = store.upsertMatch(payload);
    if (!existed) created += 1;
    persisted.push(match);
  });

  persisted.sort((a, b) => b.score - a.score);
  store.updateItem(lostItem.id, {
    matchCount: persisted.length,
    status: lostItem.status === 'searching' && persisted.some((m) => m.passed) ? 'candidate_found' : lostItem.status
  });
  store.bumpMatchRun(elapsed);

  // 主动提醒：高于阈值的候选生成通知（方案 6.5）
  const strong = persisted.filter((m) => m.passed && m.status === 'new');
  strong.slice(0, 3).forEach((m) => {
    const found = store.getItem(m.foundId);
    if (!found) return;
    const dup = store.notifications(lostItem.userId).some((n) => n.matchId === m.id);
    if (dup) return;
    store.insertNotification({
      id: store.uid('ntf'),
      userId: lostItem.userId,
      type: 'new_match',
      matchId: m.id,
      lostId: m.lostId,
      foundId: m.foundId,
      title: '发现新的高相似候选',
      body: '「' + itemView(found).title + '」在 ' + itemView(found).locationName + ' 被发现，综合匹配度 ' + Math.round(m.score * 100) + '%',
      read: false,
      createdAt: Date.now()
    });
  });

  return { created, total: persisted.length, top: persisted[0] ? matchView(persisted[0]) : null, elapsed, candidates: ranked.candidates };
}

/** 对一条拾物执行反向匹配：找潜在失主 */
function runMatchForFound(foundItem, options) {
  const opts = options || {};
  const losts = store.itemsOf('lost');
  const ranked = matcher.rankOwners(foundItem, losts, { topK: opts.topK || 20 });

  let created = 0;
  const persisted = [];
  ranked.results.forEach((r) => {
    if (r.score < 0.32) return;
    const existed = store.matchesOfFound(foundItem.id).some((m) => m.lostId === r.lostItem.id);
    const scored = {
      id: 'match_' + r.lostItem.id + '_' + foundItem.id,
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
    const match = store.upsertMatch(existed
      ? scored
      : Object.assign({ status: 'new', userStatus: 'new', createdAt: Date.now() }, scored));
    if (!existed) created += 1;
    persisted.push(match);

    // 失主还没查看过这条候选 → 推送提醒
    if (!existed && r.passed) {
      store.insertNotification({
        id: store.uid('ntf'),
        userId: r.lostItem.userId,
        type: 'new_match',
        matchId: match.id,
        lostId: match.lostId,
        foundId: match.foundId,
        title: '有人捡到了相似物品',
        body: '你寻找中的「' + itemView(r.lostItem).title + '」出现新的候选，综合匹配度 ' + Math.round(r.score * 100) + '%',
        read: false,
        createdAt: Date.now()
      });
    }
  });

  store.updateItem(foundItem.id, {
    matchCount: persisted.length
  });

  persisted.sort((a, b) => b.score - a.score);
  return { created, total: persisted.length, top: persisted[0] ? matchView(persisted[0]) : null };
}

/** 增量匹配：把新记录与所有未完成记录再匹配一次（模拟后台任务） */
function incrementalMatch() {
  const losts = store.itemsOf('lost').filter((i) => i.status !== 'recovered' && i.status !== 'closed');
  const founds = store.itemsOf('found').filter((i) => i.status !== 'returned' && i.status !== 'closed');
  let created = 0;
  losts.forEach((l) => { created += runMatchForLost(l, { topK: 8 }).created; });
  founds.forEach((f) => { runMatchForFound(f, { topK: 8 }); });
  store.persist();
  return { created, losts: losts.length, founds: founds.length };
}

/** 查询某条失物的候选列表（读时重算，保证分数与当前权重一致） */
function candidatesForLost(lostId, options) {
  const opts = options || {};
  const cacheKey = 'lost:' + lostId + ':' + (opts.topK || 20) + ':' + (opts.minScore || 0.3);
  const cached = rankCacheGet(cacheKey);
  if (cached) return cached;

  const lost = store.getItem(lostId);
  if (!lost) return { results: [], views: [] };
  const founds = store.itemsOf('found');
  const ranked = matcher.rankCandidates(lost, founds, { topK: opts.topK || 20 });

  const views = ranked.results
    .filter((r) => r.score >= (opts.minScore || 0.3))
    .map((r) => {
      const match = store.matchesOfLost(lostId).find((m) => m.foundId === r.foundItem.id);
      const merged = Object.assign({}, match || {
        id: 'match_' + lostId + '_' + r.foundItem.id,
        lostId,
        foundId: r.foundItem.id,
        status: 'new',
        userStatus: 'new',
        createdAt: Date.now()
      }, r, {
        id: match ? match.id : 'match_' + lostId + '_' + r.foundItem.id,
        status: match ? match.status : 'new',
        userStatus: match ? (match.userStatus || 'new') : 'new'
      });
      return matchView(merged, { from: 'lost' });
    })
    .filter(Boolean);

  return rankCacheSet(cacheKey, { results: ranked.results, views, candidates: ranked.candidates, elapsed: ranked.elapsed });
}

/** 查询某条拾物的潜在失主 */
function candidatesForFound(foundId, options) {
  const opts = options || {};
  const cacheKey = 'found:' + foundId + ':' + (opts.topK || 20) + ':' + (opts.minScore || 0.3);
  const cached = rankCacheGet(cacheKey);
  if (cached) return cached;

  const found = store.getItem(foundId);
  if (!found) return { results: [], views: [] };
  const losts = store.itemsOf('lost');
  const ranked = matcher.rankOwners(found, losts, { topK: opts.topK || 20 });
  const views = ranked.results
    .filter((r) => r.score >= (opts.minScore || 0.3))
    .map((r) => {
      const match = store.matchesOfFound(foundId).find((m) => m.lostId === r.lostItem.id);
      const merged = Object.assign({}, match || {
        id: 'match_' + r.lostItem.id + '_' + foundId,
        lostId: r.lostItem.id,
        foundId,
        status: 'new',
        userStatus: 'new',
        createdAt: Date.now()
      }, r, {
        id: match ? match.id : 'match_' + r.lostItem.id + '_' + foundId,
        status: match ? match.status : 'new',
        userStatus: match ? (match.userStatus || 'new') : 'new'
      });
      return matchView(merged, { from: 'found' });
    })
    .filter(Boolean);
  return rankCacheSet(cacheKey, { results: ranked.results, views, candidates: ranked.candidates });
}

/** 全局候选流（匹配 Tab） */
function allCandidateViews(options) {
  const opts = options || {};
  const userId = opts.userId;
  const losts = store.itemsOf('lost').filter((i) => {
    if (opts.mineOnly && userId && i.userId !== userId) return false;
    return i.status !== 'recovered' && i.status !== 'closed';
  });

  const collected = [];
  losts.forEach((l) => {
    const res = candidatesForLost(l.id, { topK: 12, minScore: opts.minScore || 0.3 });
    res.views.forEach((v) => collected.push(v));
  });

  // 去重（同一 match id 只保留最高分）
  const byId = {};
  collected.forEach((v) => {
    if (!byId[v.id] || byId[v.id].score < v.score) byId[v.id] = v;
  });
  let list = Object.keys(byId).map((k) => byId[k]);
  if (opts.status && opts.status !== 'all') {
    list = list.filter((v) => (opts.status === 'passed' ? v.passed : v.status === opts.status));
  }
  if (opts.keyword) {
    const kw = String(opts.keyword);
    list = list.filter((v) =>
      (v.found.title + v.found.description + v.found.locationName).indexOf(kw) >= 0 ||
      (v.lost.title + v.lost.description).indexOf(kw) >= 0);
  }
  if (opts.category && opts.category !== 'all') {
    list = list.filter((v) => (v.found.attributes || {}).category === opts.category);
  }
  list.sort((a, b) => b.score - a.score);
  return list;
}

/** 某条记录的匹配详情（对比页数据） */
function compareDetail(matchId, options) {
  const opts = options || {};
  const match = store.getMatch(matchId);
  if (match) {
    const lost = store.getItem(match.lostId);
    const found = store.getItem(match.foundId);
    if (!lost || !found) return null;
    const detail = matcher.scorePair(lost, found);
    const merged = Object.assign({}, match, detail, { id: match.id, status: match.status });
    return Object.assign({
      detail,
      bars: matcher.scoreBars(detail),
      explanation: matcher.explain(detail, lost, found),
      advice: matcher.advise(merged),
      attrRows: buildAttrRows(detail.attrItems),
      weightsText: weightText(detail)
    }, matchView(merged, opts));
  }

  // 未落库的临时对比（直接给 lostId/foundId）
  if (opts.lostId && opts.foundId) {
    const lost = store.getItem(opts.lostId);
    const found = store.getItem(opts.foundId);
    if (!lost || !found) return null;
    const detail = matcher.scorePair(lost, found);
    const pseudo = {
      id: 'match_' + opts.lostId + '_' + opts.foundId,
      lostId: opts.lostId,
      foundId: opts.foundId,
      status: 'new',
      userStatus: 'new',
      createdAt: Date.now()
    };
    return Object.assign({
      detail,
      bars: matcher.scoreBars(detail),
      explanation: matcher.explain(detail, lost, found),
      advice: matcher.advise(detail),
      attrRows: buildAttrRows(detail.attrItems),
      weightsText: weightText(detail)
    }, matchView(Object.assign(pseudo, detail), opts));
  }
  return null;
}

function buildAttrRows(attrItems) {
  return (attrItems || []).map((it) => {
    let judgement = '近似';
    let cls = 'warn';
    if (it.score >= 0.9) { judgement = '一致'; cls = 'success'; }
    else if (it.score <= 0.4) { judgement = '不一致'; cls = 'danger'; }
    if (it.a === '未提供' || it.b === '未提供') { judgement = '信息不全'; cls = 'gray'; }
    return {
      field: it.field,
      label: it.label,
      a: it.a,
      b: it.b,
      score: it.score,
      percent: Math.round(it.score * 100),
      note: it.note,
      judgement,
      cls
    };
  });
}

function weightText(detail) {
  const names = { image: '图像α', attr: '属性β', text: '文字γ', geo: '地点δ', time: '时间ε' };
  return Object.keys(names)
    .filter((k) => (detail.weights[k] || 0) > 0.001)
    .map((k) => names[k] + '=' + detail.weights[k].toFixed(2))
    .join('  ');
}

/* ===================== 认领核验（方案 6.6 / 9.2） ===================== */

/** 生成核验问题：把私有特征转成问题 */
function buildQuestions(foundItem) {
  const features = foundItem.privateFeatures || [];
  const cate = categorical.get((foundItem.attributes || {}).category);
  const questions = features.map((f, idx) => ({
    id: 'q' + (idx + 1),
    feature: f,
    question: toQuestion(f),
    hint: '请描述具体特征，越具体越好（系统仅用于核验，不会公开展示）'
  }));
  if (!questions.length) {
    // 拾物者未填写私有特征时，用类别默认问题兜底
    cate.privateFeatures.slice(0, 2).forEach((f, idx) => {
      questions.push({ id: 'q' + (idx + 1), feature: f, question: toQuestion(f), hint: '由类别常识生成的问题，供拾物者参考核对' });
    });
  }
  return questions.slice(0, 3);
}

function toQuestion(feature) {
  const f = String(feature);
  if (f.indexOf('划痕') >= 0 || f.indexOf('磨损') >= 0 || f.indexOf('破损') >= 0 || f.indexOf('污渍') >= 0) {
    return '这件物品上有什么明显的使用痕迹？大概在什么位置？';
  }
  if (f.indexOf('贴纸') >= 0 || f.indexOf('贴画') >= 0)
    return '物品上是否有贴纸或贴画？图案和位置是怎样的？';
  if (f.indexOf('刻字') >= 0 || f.indexOf('姓名') >= 0 || f.indexOf('标签') >= 0)
    return '物品上是否有刻字、姓名贴或标签？内容是什么？';
  if (f.indexOf('挂件') >= 0 || f.indexOf('挂饰') >= 0 || f.indexOf('钥匙扣') >= 0)
    return '物品上挂了什么挂件或装饰？形状、颜色如何？';
  if (f.indexOf('包内') >= 0 || f.indexOf('口袋') >= 0)
    return '里面当时装了哪些东西？请列举两三样。';
  if (f.indexOf('伞柄') >= 0)
    return '伞柄是什么材质、什么形状？有没有特殊纹路？';
  if (f.indexOf('伞套') >= 0)
    return '伞套还在吗？是什么样子的？';
  if (f.indexOf('序列号') >= 0 || f.indexOf('编号') >= 0)
    return '如果记得，请提供设备序列号或编号的后几位（选填）';
  if (f.indexOf('保护壳') >= 0 || f.indexOf('卡套') >= 0 || f.indexOf('镜盒') >= 0)
    return '保护壳/外套是什么样式、什么图案？';
  if (f.indexOf('几把') >= 0 || f.indexOf('钥匙') >= 0)
    return '一共有几把钥匙？分别是什么用途？';
  if (f.indexOf('颜色') >= 0)
    return '这个部位的颜色是什么？';
  if (f.indexOf('照片') >= 0)
    return '证件上的照片有什么特征（仅用于人工核对，不会公开）？';
  return '请描述「' + f + '」的具体情况';
}

/**
 * 语义核验：把认领者的回答与拾物者记录的私有特征做语义比对。
 * 真实系统可用 LLM/embedding 做语义打分；此处用关键词重叠 + 长度可用性给出辅助分。
 */
function verifyAnswer(answer, feature) {
  const a = String(answer || '').trim();
  if (!a) return { score: 0, reason: '未作答' };
  if (a.length < 2) return { score: 0.1, reason: '回答过短，无法判断' };

  const ts = colorUtil.textSimilarity(a, String(feature));
  const kw = ['划痕', '贴纸', '刻字', '姓名', '挂件', '钥匙扣', '破损', '掉漆', '污渍', '序列号', '贴画', '标签', '图案', '颜色', '杯底', '内侧', '包内', '保护壳', '伞柄', '伞套'];
  const hitFeatureKw = kw.filter((k) => String(feature).indexOf(k) >= 0 && a.indexOf(k) >= 0);

  let score = ts.score * 0.75 + Math.min(0.25, hitFeatureKw.length * 0.12);
  // 回答太笼统（如“就是有划痕”）不给高分
  if (a.length < 6) score *= 0.7;
  score = matcher.clamp01(score);
  let reason;
  if (score >= 0.6) reason = '回答与记录的私有特征语义高度一致';
  else if (score >= 0.32) reason = '回答与私有特征部分吻合，需要人工确认';
  else reason = '回答与私有特征匹配度低';
  return { score, reason, keywords: hitFeatureKw };
}

/** 发起认领 */
function startClaim(matchId) {
  const match = store.getMatch(matchId);
  if (!match) return { ok: false, message: '候选不存在' };
  const found = store.getItem(match.foundId);
  const lost = store.getItem(match.lostId);
  if (!found || !lost) return { ok: false, message: '记录不存在' };
  if (match.status === 'rejected') return { ok: false, message: '该候选已被排除' };

  let claim = store.byMatch(matchId);
  if (!claim) {
    claim = store.insertClaim({
      id: store.uid('claim'),
      matchId,
      lostId: match.lostId,
      foundId: match.foundId,
      claimantId: lost.userId,
      keeperId: found.userId,
      questions: buildQuestions(found),
      answers: [],
      verificationScore: 0,
      status: 'answering',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }
  store.updateMatch(matchId, { status: 'claimed', userStatus: 'claimed' });
  store.updateItem(lost.id, { status: 'verifying' });
  store.updateItem(found.id, { status: found.status === 'available' ? 'reserved' : found.status });
  store.persist();

  return { ok: true, claim, claimView: claimView(claim) };
}

/** 提交核验回答 */
function submitClaim(claimId, answers) {
  const claim = store.getClaim(claimId);
  if (!claim) return { ok: false, message: '认领单不存在' };
  const list = claim.questions.map((q, idx) => {
    const answer = (answers && answers[idx]) || '';
    const result = verifyAnswer(answer, q.feature);
    return {
      questionId: q.id,
      question: q.question,
      feature: q.feature,
      answer,
      score: result.score,
      reason: result.reason,
      keywords: result.keywords || []
    };
  });
  const valid = list.filter((x) => x.answer);
  const avg = valid.length ? valid.reduce((s, x) => s + x.score, 0) / valid.length : 0;
  const score = Number(avg.toFixed(4));

  store.updateClaim(claimId, {
    answers: list,
    verificationScore: score,
    status: 'submitted',
    submittedAt: Date.now()
  });
  store.updateMatch(claim.matchId, { status: 'claimed' });
  store.insertNotification({
    id: store.uid('ntf'),
    userId: claim.keeperId,
    type: 'claim_submitted',
    matchId: claim.matchId,
    title: '有人发起了认领，请核对隐藏特征',
    body: '系统语义核验辅助分 ' + Math.round(score * 100) + '%，请结合线下特征确认是否为其所有',
    read: false,
    createdAt: Date.now()
  });
  store.persist();
  return { ok: true, claim, claimView: claimView(claim) };
}

/** 拾物者确认 / 拒绝 */
function confirmClaim(claimId, action, remark) {
  const claim = store.getClaim(claimId);
  if (!claim) return { ok: false, message: '认领单不存在' };
  const isPass = action === 'pass';
  const lost = store.getItem(claim.lostId);
  const found = store.getItem(claim.foundId);

  store.updateClaim(claimId, {
    status: isPass ? 'verified' : 'rejected',
    confirmedAt: Date.now(),
    remark: remark || ''
  });
  store.updateMatch(claim.matchId, { status: isPass ? 'verified' : 'failed' });
  if (lost) store.updateItem(lost.id, { status: isPass ? 'waiting_handover' : 'candidate_found' });
  if (found) store.updateItem(found.id, { status: isPass ? 'reserved' : 'available' });

  store.insertFeedback({
    id: store.uid('fb'),
    matchId: claim.matchId,
    lostId: claim.lostId,
    foundId: claim.foundId,
    userAction: isPass ? 'claim_confirmed' : 'claim_rejected',
    confirmed: !!isPass,
    verificationScore: claim.verificationScore,
    timestamp: Date.now()
  });

  store.insertNotification({
    id: store.uid('ntf'),
    userId: claim.claimantId,
    type: isPass ? 'claim_passed' : 'claim_failed',
    matchId: claim.matchId,
    title: isPass ? '核验通过，请与拾物者约定交接' : '核验未通过',
    body: isPass ? '对方确认了隐藏特征，请尽快完成线下交接并确认归还' : '对方认为特征不匹配，本次认领已结束',
    read: false,
    createdAt: Date.now()
  });

  if (!isPass) {
    // 失败样本作为弱负样本保留（方案 6.7 反馈机制）
    store.insertFeedback({
      id: store.uid('fb'),
      matchId: claim.matchId,
      userAction: 'negative_sample',
      confirmed: false,
      timestamp: Date.now()
    });
  }

  store.persist();
  return { ok: true, claim, claimView: claimView(claim) };
}

/** 完成归还（状态闭环） */
function completeReturn(claimId) {
  const claim = store.getClaim(claimId);
  if (!claim) return { ok: false, message: '认领单不存在' };
  store.updateClaim(claimId, { status: 'returned', returnedAt: Date.now() });
  store.updateMatch(claim.matchId, { status: 'returned' });
  const lost = store.getItem(claim.lostId);
  const found = store.getItem(claim.foundId);
  if (lost) store.updateItem(lost.id, { status: 'recovered' });
  if (found) store.updateItem(found.id, { status: 'returned' });
  store.insertFeedback({
    id: store.uid('fb'),
    matchId: claim.matchId,
    lostId: claim.lostId,
    foundId: claim.foundId,
    userAction: 'returned',
    confirmed: true,
    timestamp: Date.now()
  });
  store.insertNotification({
    id: store.uid('ntf'),
    userId: claim.keeperId,
    type: 'returned',
    matchId: claim.matchId,
    title: '物品已归还，感谢你',
    body: '「' + (lost ? itemView(lost).title : '物品') + '」已完成归还，本次匹配闭环结束',
    read: false,
    createdAt: Date.now()
  });
  store.persist();
  return { ok: true, claim, claimView: claimView(claim) };
}

/** 排除候选（弱负样本） */
function rejectMatch(matchId, reason) {
  const match = store.getMatch(matchId);
  if (!match) return { ok: false };
  store.updateMatch(matchId, { status: 'rejected', userStatus: 'rejected', rejectReason: reason || '' });
  store.insertFeedback({
    id: store.uid('fb'),
    matchId,
    lostId: match.lostId,
    foundId: match.foundId,
    userAction: 'rejected',
    confirmed: false,
    reason: reason || '',
    timestamp: Date.now()
  });
  store.persist();
  return { ok: true };
}

function claimView(claim) {
  if (!claim) return null;
  const lost = store.getItem(claim.lostId);
  const found = store.getItem(claim.foundId);
  const st = statusInfo(CLAIM_STATUS, claim.status);
  const match = store.getMatch(claim.matchId);
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
    lost: itemView(lost),
    found: itemView(found),
    lostId: claim.lostId,
    foundId: claim.foundId,
    claimantId: claim.claimantId,
    keeperId: claim.keeperId,
    matchScore: match ? match.score : 0,
    createdAt: claim.createdAt,
    createdText: timeUtil.fromNow(claim.createdAt),
    canAnswer: claim.status === 'answering',
    canConfirm: claim.status === 'submitted',
    privateFeatures: (found && found.privateFeatures) || []
  };
}

function claimDetail(claimId) {
  return claimView(store.getClaim(claimId));
}

function claimOfMatch(matchId) {
  return claimView(store.byMatch(matchId));
}

/* ===================== 统计与可视化数据 ===================== */

function stats() {
  const d = store.db();
  const losts = d.lostItems;
  const founds = d.foundItems;
  const matches = d.matches;
  const passed = matches.filter((m) => m.passed);
  const recovered = losts.filter((l) => l.status === 'recovered').length;
  const totalLost = losts.length || 1;
  const pairTotal = losts.length * founds.length || 1;

  return {
    lostCount: losts.length,
    foundCount: founds.length,
    matchCount: matches.length,
    strongMatchCount: passed.length,
    claimCount: d.claims.length,
    returnedCount: recovered,
    recoverRate: Math.round((recovered / totalLost) * 100),
    avgTopScore: matches.length
      ? Math.round((matches.reduce((s, m) => s + m.score, 0) / matches.length) * 100)
      : 0,
    avgMatchMs: d.meta.avgMatchMs,
    matchRuns: d.meta.matchRuns,
    searchingCount: losts.filter((l) => l.status === 'searching' || l.status === 'candidate_found').length,
    verifyingCount: losts.filter((l) => l.status === 'verifying').length,
    handoverCount: losts.filter((l) => l.status === 'waiting_handover').length,
    dataDensity: Math.round((matches.length / pairTotal) * 100)
  };
}

/** 类别分布（管理看板 / 首页） */
function categoryDistribution() {
  const counts = {};
  store.allItems().forEach((it) => {
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

/**
 * 地点热力数据：按标准地点聚合失物 + 拾物数量（方案 6.8）
 * 出于隐私考虑，只到建筑/区域级，不展示精确坐标。
 */
function heatmap(options) {
  const opts = options || {};
  const cells = {};
  store.allItems().forEach((it) => {
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
        lat: it.location ? it.location.lat : locations.UNKNOWN_LOCATION.lat,
        lng: it.location ? it.location.lng : locations.UNKNOWN_LOCATION.lng,
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

/** 时间线：某条匹配或某条记录的关键事件（方案 6.8） */
function timeline(options) {
  const opts = options || {};
  const events = [];

  if (opts.lostId) {
    const lost = store.getItem(opts.lostId);
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
    const found = store.getItem(opts.foundId);
    if (found) {
      events.push({
        at: found.foundTime,
        type: 'found',
        label: '拾到物品',
        desc: found.location.name
      });
      events.push({
        at: found.createdAt,
        type: 'found_publish',
        label: '发布拾物记录',
        desc: '已保留 ' + (found.privateFeatures || []).length + ' 项隐藏核验特征'
      });
    }
  }
  if (opts.matchId) {
    const match = store.getMatch(opts.matchId);
    if (match) {
      events.push({ at: match.createdAt, type: 'match', label: '生成候选匹配', desc: '综合匹配度 ' + Math.round(match.score * 100) + '%' });
      const claim = store.byMatch(match.id);
      if (claim) {
        events.push({ at: claim.createdAt, type: 'claim', label: '发起认领', desc: claim.questions.length + ' 个隐藏特征问题' });
        if (claim.submittedAt) events.push({ at: claim.submittedAt, type: 'verify', label: '提交核验回答', desc: '辅助分 ' + Math.round(claim.verificationScore * 100) + '%' });
        if (claim.confirmedAt) events.push({ at: claim.confirmedAt, type: 'confirm', label: claim.status === 'rejected' ? '核验未通过' : '拾物者确认', desc: claim.remark || '' });
        if (claim.returnedAt) events.push({ at: claim.returnedAt, type: 'returned', label: '完成归还', desc: '匹配闭环结束' });
      }
    }
  }
  events.sort((a, b) => (a.at || 0) - (b.at || 0));
  return events.map((e) => Object.assign({}, e, { timeText: timeUtil.format(e.at), relative: timeUtil.fromNow(e.at) }));
}

/* ===================== 消融实验（方案 12.4） ===================== */

/**
 * 用当前数据集中带 identityId（同一真实物品）的样本做评测。
 * 真实系统应使用自建测试集 + 困难负样本；此处复用种子数据的身份标注，
 * 保证「同一物品的不同照片/不同描述」被视为同一身份，避免数据泄漏。
 */
function evaluate(options) {
  const opts = options || {};
  const losts = store.itemsOf('lost').filter((l) => l.identityId);
  const founds = store.itemsOf('found').filter((f) => f.identityId);
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
      // 低于最小分的候选对用户没有展示价值，不计入排序位次
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
    note: '指标基于内置演示数据集的 identityId 身份标注计算，仅用于验证流程与相对趋势'
  };
}

/* ===================== 通知 ===================== */

function notificationViews(userId) {
  return store.notifications(userId).map((n) => {
    const match = n.matchId ? store.getMatch(n.matchId) : null;
    const lost = n.lostId ? store.getItem(n.lostId) : null;
    const found = n.foundId ? store.getItem(n.foundId) : null;
    return Object.assign({}, n, {
      timeText: timeUtil.fromNow(n.createdAt),
      scorePercent: match ? Math.round(match.score * 100) : 0,
      lostView: itemView(lost),
      foundView: itemView(found),
      canClaim: !!(match && match.status !== 'rejected' && lost && lost.userId === (userId || 'u_me'))
    });
  });
}

/* ===================== 我的 ===================== */

function myLostItems(userId) {
  return store.itemsByUser(userId, 'lost').map(itemView);
}

function myFoundItems(userId) {
  return store.itemsByUser(userId, 'found').map(itemView);
}

function myClaims(userId) {
  return store.claims()
    .filter((c) => c.claimantId === userId || c.keeperId === userId)
    .map(claimView)
    .filter(Boolean);
}

/* ===================== 异步写操作（云端优先，本地兜底） =====================
 *
 * 设计说明：
 *   云端模式下，匹配与核验的权威计算发生在云函数里（xj-api），
 *   客户端不应该再本地跑一遍同样的流程，否则会造成重复落库与两份不一致的分数。
 *   因此所有「会改变数据」的动作都收敛到下面这组 async 方法：
 *     云端可用 → 调用云函数，然后用最新快照刷新本地镜像
 *     云端不可用 → 直接调用同名的本地同步实现（离线演示完全不受影响）
 *
 *   页面统一调用这些 async 方法即可，不需要关心当前是哪种模式。
 */

const CONFIG = require('../core/config');

function cloudOn() {
  try {
    return require('./api').isCloud();
  } catch (e) {
    return false;
  }
}

/** 从云端刷新镜像（写操作后调用） */
async function syncFromCloud() {
  if (!cloudOn()) return false;
  return store.refreshFromCloud();
}

/**
 * 发布记录（云端优先）
 * @returns {Promise<{item, matchCount, locationMatched, auto, mode}>}
 */
async function publishAsync(payload) {
  if (cloudOn()) {
    try {
      const api = require('./api');
      // 已经有 AI 结果的（页面调用过 xj-ai）直接带上，避免云端重复调用模型
      const data = await api.callApi('item.publish', payload);
      await syncFromCloud();
      const item = store.getItem(data.item && data.item.id) || data.item;
      return {
        mode: 'cloud',
        item,
        itemView: data.itemView,
        auto: data.auto,
        matchCount: data.matchCount || 0,
        top: data.top,
        locationMatched: true
      };
    } catch (e) {
      console.error('[寻迹] 云端发布失败，降级本地发布：', e.message);
      if (typeof wx !== 'undefined' && wx.showToast) {
        wx.showToast({ title: '云端发布失败，已保存到本机', icon: 'none', duration: 2500 });
      }
    }
  }
  const local = publish(payload);
  return Object.assign({ mode: 'local' }, local);
}

/** 发起认领（云端优先） */
async function startClaimAsync(matchId) {
  if (cloudOn()) {
    try {
      const api = require('./api');
      const data = await api.callApi('claim.start', { matchId });
      await syncFromCloud();
      return { mode: 'cloud', ok: true, claim: data.claim, claimView: data.claim };
    } catch (e) {
      console.error('[寻迹] 云端认领失败，降级本地：', e.message);
    }
  }
  const local = startClaim(matchId);
  return Object.assign({ mode: 'local' }, local);
}

/** 提交核验回答（云端优先） */
async function submitClaimAsync(claimId, answers) {
  if (cloudOn()) {
    try {
      const api = require('./api');
      const data = await api.callApi('claim.submit', { claimId, answers });
      await syncFromCloud();
      return { mode: 'cloud', ok: true, claim: data.claim, claimView: data.claim };
    } catch (e) {
      console.error('[寻迹] 云端提交核验失败，降级本地：', e.message);
    }
  }
  const local = submitClaim(claimId, answers);
  return Object.assign({ mode: 'local' }, local);
}

/** 拾物者确认 / 拒绝（云端优先） */
async function confirmClaimAsync(claimId, action, remark) {
  if (cloudOn()) {
    try {
      const api = require('./api');
      const data = await api.callApi('claim.confirm', { claimId, action, remark });
      await syncFromCloud();
      return { mode: 'cloud', ok: true, claim: data.claim, claimView: data.claim };
    } catch (e) {
      console.error('[寻迹] 云端确认失败，降级本地：', e.message);
    }
  }
  const local = confirmClaim(claimId, action, remark);
  return Object.assign({ mode: 'local' }, local);
}

/** 完成归还（云端优先） */
async function completeReturnAsync(claimId) {
  if (cloudOn()) {
    try {
      const api = require('./api');
      const data = await api.callApi('claim.return', { claimId });
      await syncFromCloud();
      return { mode: 'cloud', ok: true, claim: data.claim, claimView: data.claim };
    } catch (e) {
      console.error('[寻迹] 云端归还失败，降级本地：', e.message);
    }
  }
  const local = completeReturn(claimId);
  return Object.assign({ mode: 'local' }, local);
}

/** 排除候选（云端优先） */
async function rejectMatchAsync(matchId, reason) {
  if (cloudOn()) {
    try {
      const api = require('./api');
      await api.callApi('match.reject', { matchId, reason });
      await syncFromCloud();
      return { mode: 'cloud', ok: true };
    } catch (e) {
      console.error('[寻迹] 云端排除失败，降级本地：', e.message);
    }
  }
  const local = rejectMatch(matchId, reason);
  return Object.assign({ mode: 'local' }, local);
}

/** 重新执行增量匹配（云端优先） */
async function rerunMatchAsync() {
  if (cloudOn()) {
    try {
      const api = require('./api');
      const data = await api.callApi('match.rerun', {});
      await syncFromCloud();
      return Object.assign({ mode: 'cloud' }, data);
    } catch (e) {
      console.error('[寻迹] 云端重匹配失败，降级本地：', e.message);
    }
  }
  return Object.assign({ mode: 'local' }, incrementalMatch());
}

/**
 * 启动时初始化数据：
 *   云端模式 → 拉取快照（含缓存秒开）
 *   本地模式 → 确保演示数据已灌入
 */
async function bootstrap() {
  if (cloudOn()) {
    const ok = await store.initCloud();
    if (ok) return { mode: 'cloud', synced: true };
    // 云端不可用时退回本地演示数据，保证页面不空白
    require('../mock/seed').ensureSeed();
    return { mode: 'cloud', synced: false, fallback: 'local-seed' };
  }
  store.init();
  require('../mock/seed').ensureSeed();
  return { mode: 'local', synced: true };
}

/** 当前运行模式与同步状态（用于设置页/看板展示） */
function runtimeStatus() {
  return {
    mode: cloudOn() ? 'cloud' : 'local',
    cloudEnabled: !!(CONFIG.cloud && CONFIG.cloud.enabled),
    envId: (CONFIG.cloud && CONFIG.cloud.envId) || '',
    aiProvider: CONFIG.ai.provider,
    store: store.cloudStatus()
  };
}

module.exports = {
  LOST_STATUS,
  FOUND_STATUS,
  MATCH_STATUS,
  CLAIM_STATUS,
  statusInfo,
  itemView,
  matchView,
  claimView,
  publish,
  publishAsync,
  startClaimAsync,
  submitClaimAsync,
  confirmClaimAsync,
  completeReturnAsync,
  rejectMatchAsync,
  rerunMatchAsync,
  bootstrap,
  syncFromCloud,
  runtimeStatus,
  runMatchForLost,
  runMatchForFound,
  incrementalMatch,
  candidatesForLost,
  candidatesForFound,
  allCandidateViews,
  compareDetail,
  buildQuestions,
  verifyAnswer,
  startClaim,
  submitClaim,
  confirmClaim,
  completeReturn,
  rejectMatch,
  claimDetail,
  claimOfMatch,
  stats,
  categoryDistribution,
  heatmap,
  timeline,
  evaluate,
  notificationViews,
  myLostItems,
  myFoundItems,
  myClaims,
  weightText,
  buildAttrRows
};
