/**
 * 多模态匹配打分引擎
 * ------------------------------------------------------------------
 * 严格对应方案第 7、8、9 章：
 *
 *   S = α·S_image + β·S_attr + γ·S_text + δ·S_geo + ε·S_time
 *
 * 1. 五路分项分数各自独立计算，可单独展示（支撑“可解释匹配”）；
 * 2. α~ε 不是写死的常数：根据用户实际输入的可模态进行归一化
 *    （没有图片 α=0，其余项按比例重新分配；类别个性特征强则提高 β）；
 * 3. 时空只做加权重排，不做硬过滤（方案 8.3）；
 * 4. 支持消融实验：只用 Image / Image+Text / +Attr / 完整方案（方案 12.4）。
 */

const timeUtil = require('./time');
const locations = require('./locations');
const colorUtil = require('./color');
const categorical = require('./categories');
const vlm = require('./vlm');

/* ===================== 配置 ===================== */

/** 基础权重（可用用户输入完整度动态调整，方案 7.6） */
const BASE_WEIGHTS = {
  image: 0.30,
  attr: 0.28,
  text: 0.22,
  geo: 0.12,
  time: 0.08
};

/** 属性字段权重与类别冲突惩罚 */
const ATTR_CONFIG = {
  category: { weight: 1.0, penalty: 0.70, label: '类别', hard: true },
  brand: { weight: 0.52, penalty: 0.18, label: '品牌' },
  main_color: { weight: 0.44, penalty: 0.12, label: '主色' },
  secondary_color: { weight: 0.16, penalty: 0.05, label: '辅色' },
  material: { weight: 0.34, penalty: 0.14, label: '材质' },
  shape: { weight: 0.20, penalty: 0.06, label: '形状' },
  size: { weight: 0.14, penalty: 0.04, label: '尺寸' },
  logo_text: { weight: 0.34, penalty: 0.06, label: 'Logo/标识' },
  pattern: { weight: 0.18, penalty: 0.05, label: '图案' },
  sticker: { weight: 0.26, penalty: 0.04, label: '贴纸' },
  damage_mark: { weight: 0.32, penalty: 0.04, label: '磨损痕迹' },
  accessory: { weight: 0.24, penalty: 0.05, label: '附属物' },
  features: { weight: 0.42, penalty: 0.06, label: '显著特征' }
};

const ATTR_FIELDS = Object.keys(ATTR_CONFIG);

/** 消融实验分组（方案 12.4） */
const ABLATION_GROUPS = [
  { key: 'A', name: 'A · Image Only', modes: ['image'], desc: '建立单图像检索基线' },
  { key: 'B', name: 'B · Image + Text', modes: ['image', 'text'], desc: '验证文字信息贡献' },
  { key: 'C', name: 'C · Image + Text + Attr', modes: ['image', 'text', 'attr'], desc: '验证结构化属性贡献' },
  { key: 'D', name: 'D · 完整方案（+Time+Geo）', modes: ['image', 'text', 'attr', 'time', 'geo'], desc: '验证完整方案' }
];

function clamp01(n) {
  if (Number.isNaN(n) || n === null || n === undefined) return 0;
  return Math.min(1, Math.max(0, n));
}

/* ===================== 1) 属性一致度 S_attr ===================== */

function attrItem(field, label, aValue, bValue, score, note, hard) {
  return {
    field,
    label,
    a: aValue === undefined || aValue === null || aValue === '' ? '未提供' : aValue,
    b: bValue === undefined || bValue === null || bValue === '' ? '未提供' : bValue,
    score: clamp01(score),
    note: note || '',
    hard: !!hard
  };
}

function compareAttributes(attrA, attrB) {
  const a = attrA || {};
  const b = attrB || {};
  const items = [];
  let weightSum = 0;
  let scoreSum = 0;
  let penaltySum = 0;
  let hardConflict = false;

  ATTR_FIELDS.forEach((field) => {
    const conf = ATTR_CONFIG[field];
    const av = a[field];
    const bv = b[field];
    const hasA = av !== undefined && av !== null && av !== '' && !(Array.isArray(av) && !av.length);
    const hasB = bv !== undefined && bv !== null && bv !== '' && !(Array.isArray(bv) && !bv.length);
    if (!hasA && !hasB) return;

    let score;
    let note = '';

    if (field === 'category') {
      if (!hasA || !hasB) {
        score = 0.5;
        note = '一方类别缺失';
      } else if (av === bv) {
        score = 1;
        note = '均为' + categorical.nameOf(av);
      } else {
        score = 0;
        note = categorical.nameOf(av) + ' ≠ ' + categorical.nameOf(bv);
        hardConflict = true;
      }
    } else if (field === 'main_color' || field === 'secondary_color') {
      const cs = colorUtil.colorSimilarity(av, bv);
      score = cs.score;
      note = cs.detail;
    } else if (field === 'material') {
      if (!hasA || !hasB) { score = 0.5; note = '一方材质缺失'; }
      else if (av === bv) { score = 1; note = '均为' + av; }
      else if (av === '金属' && bv === '金属') { score = 1; note = '均为金属'; }
      else {
        const ts = colorUtil.textSimilarity(av, bv);
        score = ts.score > 0.2 ? Math.max(0.55, ts.score) : 0.3;
        note = score >= 0.55 ? av + ' 与 ' + bv + ' 接近' : av + ' 与 ' + bv + ' 不同';
      }
    } else if (field === 'features') {
      const listA = Array.isArray(av) ? av : [av];
      const listB = Array.isArray(bv) ? bv : [bv];
      const hit = listA.filter((x) => listB.indexOf(x) >= 0);
      score = hit.length ? Math.min(1, 0.65 + hit.length * 0.2) : 0;
      note = hit.length ? '共同显著特征：' + hit.join('、') : '未发现共同显著特征';
    } else if (field === 'logo_text') {
      if (av === bv) { score = 1; note = '描述一致'; }
      else {
        const ts = colorUtil.textSimilarity(av, bv);
        score = ts.score >= 0.3 ? Math.max(0.7, ts.score) : 0.45;
        note = score >= 0.7 ? '标识描述高度相似' : '标识描述存在差异';
      }
    } else if (field === 'damage_mark') {
      const avHas = String(av).indexOf('有') >= 0 || String(av).indexOf('划') >= 0 || String(av).indexOf('损') >= 0;
      const bvHas = String(bv).indexOf('有') >= 0 || String(bv).indexOf('划') >= 0 || String(bv).indexOf('损') >= 0;
      if (avHas === bvHas && avHas) {
        const ts = colorUtil.textSimilarity(av, bv);
        score = ts.score >= 0.3 ? Math.max(0.8, ts.score) : 0.72;
        note = score >= 0.8 ? '均记录了同类痕迹' : '都提到痕迹，细节描述不同';
      } else if (!avHas && !bvHas) {
        score = 0.6; note = '双方均未记录明显痕迹';
      } else {
        score = 0.3; note = '一方记录了痕迹，另一方未提及（可能未注意）';
      }
    } else {
      // 一方未提供该属性时不当作“不同”，而是中性分（避免“少填字段反而更吃亏”）
      if (!hasA || !hasB) {
        score = 0.3;
        note = '一方未提供该属性，不作正负判断';
      } else if (av === bv) {
        score = 1;
        note = '一致';
      } else {
        const ts = colorUtil.textSimilarity(String(av), String(bv));
        if (ts.score >= 0.5) { score = 0.75; note = '表述相近'; }
        else if (ts.score > 0.15) { score = 0.55; note = '表述部分相关'; }
        else { score = 0.3; note = '不同'; }
      }
    }

    const effectiveIncrease = conf.weight + (hardConflict && conf.hard ? 0.3 : 0);
    weightSum += effectiveIncrease;
    scoreSum += score * effectiveIncrease;
    if (score === 0 && conf.penalty) penaltySum += conf.penalty;

    items.push(attrItem(field, conf.label, av, bv, score, note, conf.hard));
  });

  let score = weightSum ? scoreSum / weightSum : 0;
  if (hardConflict) score = Math.max(0, score - penaltySum);
  score = clamp01(score);

  return {
    score,
    items,
    hardConflict,
    penalty: penaltySum,
    compared: items.length
  };
}

/* ===================== 2) 地理相关度 S_geo ===================== */

function geoScore(locA, locB, sigma) {
  if (!locA || !locB) return { score: 0, available: false, distance: null };
  const s = sigma || 300;
  const d = locations.distanceMeters(locA, locB);
  const sameArea = locA.area && locA.area === locB.area;
  let score = Math.exp(-d / s);
  // 同一功能区（如都在图书馆区）给一点额外相关性
  if (sameArea) score = Math.min(1, score * 1.06 + 0.04);
  return {
    score: clamp01(score),
    available: true,
    distance: d,
    distanceText: locations.distanceText(d),
    sameArea
  };
}

/* ===================== 3) 时间相关度 S_time ===================== */

function toRange(item, kind) {
  if (kind === 'lost') {
    if (item.timeRange && item.timeRange.start) return item.timeRange;
    if (item.timeRangeText) return timeUtil.parseTimeRange(item.timeRangeText);
    return null;
  }
  if (item.foundTime) {
    return { start: item.foundTime, end: item.foundTime };
  }
  return null;
}

/**
 * 指数衰减：S_time = exp(-Δt / τ)
 * 若失主给出的是时间范围，则计算拾取时间到该范围的距离（方案 8.1）。
 */
function timeScore(lostItem, foundItem, tauHours) {
  const lostRange = toRange(lostItem, 'lost');
  const foundTs = foundItem.foundTime || (foundItem.timeRange && foundItem.timeRange.start);
  if (!lostRange || !foundTs) return { score: 0, available: false };

  let delta;
  if (lostRange.start && lostRange.end && lostRange.end > lostRange.start) {
    if (foundTs >= lostRange.start && foundTs <= lostRange.end) {
      // 落在范围内部：按到范围中心的距离折半计
      const center = (lostRange.start + lostRange.end) / 2;
      delta = Math.abs(foundTs - center) * 0.35;
    } else if (foundTs < lostRange.start) {
      delta = lostRange.start - foundTs;
    } else {
      delta = foundTs - lostRange.end;
    }
  } else {
    delta = Math.abs(foundTs - (lostRange.start || lostRange.end));
  }

  const tau = (tauHours || 8) * timeUtil.HOUR;
  const signed = foundTs - timeUtil.rangeCenter(lostRange);
  return {
    score: clamp01(Math.exp(-delta / tau)),
    available: true,
    delta,
    signedDelta: signed,
    deltaText: timeUtil.durationText(delta),
    direction: signed >= 0 ? 'after' : 'before',
    inRange: !!(lostRange.start && lostRange.end && foundTs >= lostRange.start && foundTs <= lostRange.end)
  };
}

/* ===================== 4) 文字语义 S_text ===================== */

function textScore(a, b) {
  const textA = a.description || '';
  const textB = b.description || '';
  if (!textA && !textB) return { score: 0, available: false };
  const docA = [textA, a.name || '', a.attributes && a.attributes.category ? categorical.nameOf(a.attributes.category) : ''].join(' ');
  const docB = [textB, b.name || '', b.attributes && b.attributes.category ? categorical.nameOf(b.attributes.category) : ''].join(' ');
  const ts = colorUtil.textSimilarity(docA, docB);
  const embA = (a.embeddings && a.embeddings.text) || vlm.embed('text', docA);
  const embB = (b.embeddings && b.embeddings.text) || vlm.embed('text', docB);
  const cos = vlm.cosine(embA, embB);
  const embScore = clamp01((cos - 0.1) / 0.75);
  // 词汇层面与向量层面各占一半，兼顾可解释性与鲁棒性
  const score = clamp01(ts.score * 0.55 + embScore * 0.45);
  return { score, available: true, lexical: ts.score, semantic: embScore, shared: ts.shared.length };
}

/* ===================== 5) 动态权重归一化 ===================== */

function computeWeights(userLost, found, options, imageEvidence) {
  const opts = options || {};
  const modes = opts.modes || null; // 消融实验用
  const w = Object.assign({}, opts.baseWeights || BASE_WEIGHTS);
  const available = {};
  const notes = [];

  // 双方必须具备可用视觉证据；旧路径向量不能参与加权。
  available.image = (imageEvidence || vlm.imageSimilarity(userLost, found)).available;
  // 文字模态：一方有描述即可（失主没照片时描述就是主要线索）
  available.text = !!(userLost.description || found.description);
  // 属性模态：需要结构化属性
  const attrA = userLost.attributes || {};
  const attrB = found.attributes || {};
  const attrFieldCount = ATTR_FIELDS.filter((f) => {
    const av = attrA[f];
    const bv = attrB[f];
    return av !== undefined && bv !== undefined && av !== '' && bv !== '' && !(Array.isArray(av) && !av.length) && !(Array.isArray(bv) && !bv.length);
  }).length;
  available.attr = attrFieldCount > 0;
  // 时空模态：需要地点/时间信息
  available.geo = !!(userLost.location && found.location);
  available.time = !!(toRange(userLost, 'lost') && (found.foundTime || (found.timeRange && found.timeRange.start)));

  Object.keys(w).forEach((k) => {
    if (modes && modes.indexOf(k) < 0) w[k] = 0;
    else if (available[k] === false) w[k] = 0;
  });

  // 类别个性特征强 → 提高属性权重（方案 6.5 阈值/权重按类别区别设置）
  const cateKey = (attrA.category && attrA.category !== 'other') ? attrA.category : (attrB.category || 'other');
  const prof = categorical.profile(cateKey);
  if (w.attr > 0 && prof.attrBoost !== 1) {
    w.attr *= prof.attrBoost;
    notes.push('物品类别「' + categorical.nameOf(cateKey) + '」个性特征较' + (prof.attrBoost > 1 ? '强，已提高' : '弱，已降低') + '属性权重');
  }

  const sum = Object.keys(w).reduce((s, k) => s + w[k], 0);
  const norm = {};
  Object.keys(w).forEach((k) => { norm[k] = sum > 0 ? w[k] / sum : 0; });

  if (available.image === false) notes.push('缺少可用图片分析线索，α=0，权重已重新归一化');
  if (available.text === false) notes.push('缺少文字描述，γ=0');
  if (available.attr === false) notes.push('结构化属性不足，β=0（推荐补充描述或图片）');

  return { weights: norm, raw: w, available, notes, attrFieldCount, profile: prof };
}

/* ===================== 6) 主打分入口 ===================== */

/**
 * 对一条“失物记录”与一条“拾物记录”打分。
 * @param {object} lostItem
 * @param {object} foundItem
 * @param {object} options { modes, baseWeights }
 */
function scorePair(lostItem, foundItem, options) {
  const t0 = Date.now();
  const img = vlm.imageSimilarity(lostItem, foundItem);
  const wInfo = computeWeights(lostItem, foundItem, options, img);
  const weights = wInfo.weights;

  const attrResult = compareAttributes(lostItem.attributes, foundItem.attributes);
  const geo = geoScore(lostItem.location, foundItem.location, wInfo.profile.geoSigma);
  const time = timeScore(lostItem, foundItem, wInfo.profile.timeTau);
  const text = textScore(lostItem, foundItem);

  const scores = {
    image: img.available ? img.score : 0,
    attr: attrResult.compared ? attrResult.score : 0,
    text: text.available ? text.score : 0,
    geo: geo.available ? geo.score : 0,
    time: time.available ? time.score : 0
  };

  const contributions = {};
  let final = 0;
  Object.keys(scores).forEach((k) => {
    contributions[k] = scores[k] * weights[k];
    final += contributions[k];
  });
  final = clamp01(final);

  // 类别硬冲突时，最终分做温和压制（不直接过滤，保留人工判断空间）
  if (attrResult.hardConflict) {
    final = clamp01(final * 0.55);
  }

  const profile = wInfo.profile;
  const threshold = profile.threshold;
  const elapsed = Date.now() - t0;

  const detail = {
    score: final,
    threshold,
    passed: final >= threshold,
    weights,
    rawWeights: wInfo.raw,
    available: wInfo.available,
    notes: wInfo.notes,
    scores,
    contributions,
    attrItems: attrResult.items,
    attrScore: attrResult.score,
    hardConflict: attrResult.hardConflict,
    geo,
    time,
    text,
    image: img,
    profile,
    elapsed
  };
  detail.reasons = buildReasons(detail, lostItem, foundItem);
  return detail;
}

const SCORE_META = {
  image: { label: '视觉相似度', short: '图像' },
  attr: { label: '属性一致度', short: '属性' },
  text: { label: '文字语义', short: '文字' },
  geo: { label: '地点相关度', short: '地点' },
  time: { label: '时间相关度', short: '时间' }
};

/**
 * 生成可解释证据（方案 9.1）
 * @returns {{positive:Array, conflict:Array, uncertain:Array}}
 */
function buildReasons(detail, lostItem, foundItem) {
  const positive = [];
  const conflict = [];
  const uncertain = [];
  const s = detail.scores;

  // 分项证据
  Object.keys(SCORE_META).forEach((key) => {
    if (!detail.available[key]) return;
    const val = s[key];
    const weight = detail.weights[key];
    const meta = SCORE_META[key];
    const text = meta.label + ' ' + Math.round(val * 100) + '%';
    if (val >= 0.78 && weight > 0.05) {
      positive.push({ key, text, weight, score: val });
    } else if (val <= 0.35) {
      conflict.push({ key, text, weight, score: val });
    } else if (val >= 0.5 && val < 0.78) {
      uncertain.push({ key, text, weight, score: val });
    }
  });

  // 属性级证据（更强、更具体）
  detail.attrItems.forEach((it) => {
    if (it.field === 'category') return;
    if (it.score >= 0.95 && it.a !== '未提供' && it.b !== '未提供') {
      positive.push({ key: 'attr:' + it.field, text: it.label + '一致（' + it.a + '）', weight: 0.5, score: it.score });
    } else if (it.score <= 0.4 && it.a !== '未提供' && it.b !== '未提供') {
      conflict.push({ key: 'attr:' + it.field, text: it.label + '：' + it.a + ' vs ' + it.b, weight: 0.5, score: it.score });
    }
  });

  if (detail.hardConflict) {
    conflict.unshift({ key: 'category', text: '类别冲突：' + categorical.nameOf((lostItem.attributes || {}).category) + ' 与 ' + categorical.nameOf((foundItem.attributes || {}).category) + '，通常不是同一件物品', weight: 1, score: 0 });
  }

  // 时空证据
  if (detail.geo.available && detail.geo.distance <= 400) {
    positive.push({ key: 'geo:distance', text: '发现地点距最后丢失位置' + detail.geo.distanceText.replace('约 ', '约 '), weight: 0.6, score: detail.geo.score });
  }
  if (detail.geo.available && detail.geo.distance > 900) {
    conflict.push({ key: 'geo:distance', text: '两地相距' + detail.geo.distanceText + '，距离偏远', weight: 0.6, score: detail.geo.score });
  }
  if (detail.time.available && detail.time.inRange) {
    positive.push({ key: 'time:inrange', text: '拾取时间落在估计丢失时间范围内', weight: 0.6, score: detail.time.score });
  }
  if (detail.time.available && detail.time.delta > 12 * timeUtil.HOUR) {
    conflict.push({ key: 'time:delta', text: '拾取时间与丢失时间相差' + detail.time.deltaText, weight: 0.5, score: detail.time.score });
  }

  // 不确定证据
  if (!detail.available.image) {
    uncertain.push({ key: 'modality:image', text: '缺少图片，仅依赖文字与属性推断', weight: 1, score: 0 });
  }
  if (!detail.available.geo) {
    uncertain.push({ key: 'modality:geo', text: '地点信息不足，未参与重排', weight: 1, score: 0 });
  }
  ['main_color', 'secondary_color', 'size'].forEach((f) => {
    const it = detail.attrItems.find((x) => x.field === f);
    if (it && it.score > 0.4 && it.score < 0.95) {
      uncertain.push({ key: 'attr:' + f, text: it.label + '存在差异（' + it.a + ' / ' + it.b + '），可能受光照或表述影响', weight: 0.4, score: it.score });
    }
  });

  // 去重排序：先取出全部候选，再排序、去重、截断
  const dedupe = (arr, limit) => {
    const seen = {};
    return arr
      .sort((x, y) => y.score * (y.weight || 0.3) - x.score * (x.weight || 0.3))
      .filter((x) => {
        if (seen[x.text]) return false;
        seen[x.text] = 1;
        return true;
      })
      .slice(0, limit);
  };

  const positiveList = dedupe(positive, 4);
  const conflictList = dedupe(conflict, 3);
  const uncertainList = dedupe(uncertain, 3);

  // 类别硬冲突是最关键的判断依据，必须出现在解释里
  if (detail.hardConflict && !conflictList.some((c) => c.key === 'category')) {
    const cat = {
      key: 'category',
      text: '类别冲突：' + categorical.nameOf((lostItem.attributes || {}).category) +
        ' 与 ' + categorical.nameOf((foundItem.attributes || {}).category) + '，通常不是同一件物品',
      weight: 1,
      score: 0
    };
    conflictList.unshift(cat);
    if (conflictList.length > 3) conflictList.pop();
  }

  return { positive: positiveList, conflict: conflictList, uncertain: uncertainList };
}

/** 一句话解释（对比页顶部） */
function explain(detail, lostItem, foundItem) {
  if (!detail) return '';
  const la = lostItem.attributes || {};
  const fa = foundItem.attributes || {};
  const parts = [];
  const cateName = categorical.nameOf(la.category || fa.category);
  const colorText = [la.main_color, la.material].filter(Boolean).join('');
  parts.push('两件记录均指向「' + colorText + cateName + '」');
  if (detail.attrItems.find((x) => x.field === 'logo_text' && x.score >= 0.7)) {
    parts.push('Logo/标识描述高度一致');
  }
  if (detail.geo.available) {
    parts.push('发现地点距最后丢失位置' + detail.geo.distanceText);
  }
  if (detail.time.available) {
    parts.push('拾取时间与丢失时间相差' + detail.time.deltaText);
  }
  return parts.join('；') + '。综合匹配度 ' + Math.round(detail.score * 100) + '%。';
}

/** 认知结论：给用户一句“下一步做什么”的提示 */
function advise(detail) {
  if (!detail) return '';
  const conflicts = (detail.reasons && detail.reasons.conflict) || [];
  if (detail.hardConflict) return '类别不一致，通常不是同一件物品，建议忽略该候选';
  if (detail.scores.attr >= 0.75 && detail.scores.time >= 0.6) return '属性与时间都吻合，建议优先发起认领核验';
  if (!conflicts.length && detail.score >= 0.85) return '高相似候选，建议核对隐藏特征后发起认领';
  if (detail.score >= 0.75) return '较可信候选，建议查看详细对比确认细节差异';
  return '相似度一般，可继续等待新的拾物记录';
}

/**
 * 为一个失物记录检索 Top-K 拾物候选（两阶段：召回 → 重排，方案 7.5）
 */
function rankCandidates(lostItem, foundItems, options) {
  const opts = options || {};
  const topK = opts.topK || 20;
  const recallSize = opts.recallSize || 50;
  const t0 = Date.now();

  // 阶段一：粗召回。真实系统用 pgvector ANN；此处用“类别预筛 + 文本/图像快速分”模拟
  let pool = (foundItems || []).filter((it) => it.status !== 'closed' && it.status !== 'returned');
  if (pool.length > recallSize) {
    const rough = pool.map((it) => {
      const ts = textScore(lostItem, it);
      const catA = (lostItem.attributes || {}).category;
      const catB = (it.attributes || {}).category;
      const catBonus = catA && catB && catA === catB ? 0.35 : 0;
      const geoRough = geoScore(lostItem.location, it.location, opts.sigma || 400).score;
      return { item: it, rough: ts.score * 0.5 + catBonus + geoRough * 0.15 };
    });
    rough.sort((a, b) => b.rough - a.rough);
    pool = rough.slice(0, recallSize).map((x) => x.item);
  }

  // 阶段二：五路融合重排
  const scored = pool.map((it) => {
    const detail = scorePair(lostItem, it, opts);
    return Object.assign({ foundItem: it, lostItem }, detail);
  });
  scored.sort((a, b) => b.score - a.score);

  const results = scored.slice(0, topK).map((r, idx) => Object.assign({ rank: idx + 1 }, r, { hardConflict: r.hardConflict, threshold: r.threshold, passed: r.passed }));
  return {
    results,
    candidates: scored.length,
    recalled: pool.length,
    elapsed: Date.now() - t0
  };
}

/** 反向：为一条拾物记录找潜在失主（主动提醒，方案 6.5） */
function rankOwners(foundItem, lostItems, options) {
  const opts = options || {};
  const topK = opts.topK || 20;
  const scored = (lostItems || [])
    .filter((it) => it.status !== 'recovered' && it.status !== 'closed')
    .map((it) => {
      const detail = scorePair(it, foundItem, opts);
      return Object.assign({ lostItem: it, foundItem }, detail);
    });
  scored.sort((a, b) => b.score - a.score);
  return {
    results: scored.slice(0, topK).map((r, idx) => Object.assign({ rank: idx + 1 }, r, {
      hardConflict: r.hardConflict,
      threshold: r.threshold,
      passed: r.passed
    })),
    candidates: scored.length
  };
}

/** 手动“再匹配一次”：批量刷新某条失物的候选 */
function rankBoth(lostItem, foundItems, options) {
  return rankCandidates(lostItem, foundItems, options);
}

/* ===================== 评分展示辅助 ===================== */

function scoreBars(detail) {
  return Object.keys(SCORE_META).map((key) => {
    const meta = SCORE_META[key];
    const weight = detail.weights[key] || 0;
    const available = detail.available[key] !== false && weight > 0;
    return {
      key,
      label: meta.label,
      short: meta.short,
      score: available ? clamp01(detail.scores[key]) : 0,
      percent: available ? Math.round(clamp01(detail.scores[key]) * 100) : 0,
      weight,
      weightPercent: Math.round(weight * 100),
      available,
      contribution: available ? detail.contributions[key] : 0
    };
  });
}

module.exports = {
  BASE_WEIGHTS,
  ATTR_CONFIG,
  ATTR_FIELDS,
  ABLATION_GROUPS,
  SCORE_META,
  compareAttributes,
  geoScore,
  timeScore,
  textScore,
  computeWeights,
  scorePair,
  buildReasons,
  explain,
  advise,
  rankCandidates,
  rankOwners,
  rankBoth,
  scoreBars,
  clamp01
};
