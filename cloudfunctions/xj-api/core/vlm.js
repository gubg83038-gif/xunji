/**
 * 结构化属性提取与向量表示（平台无关核心层）
 * ---------------------------------------------------------------
 * 本文件提供两套实现，通过 core/config.js 的 ai.provider 选择：
 *
 *  1) local（默认，离线可用）
 *     - extractAttributes：确定性伪随机（图像）+ 文本抽取（描述）
 *     - embed：本地语义指纹向量（同义词概念 + 字符 bigram 哈希）
 *
 *  2) deepseek（联网）
 *     - 真正的属性提取在 core/ai/deepseek.js，由云函数 xj-ai 调用
 *     - 本文件的 extractFromText / extractFromImage 仍作为兜底与结果校验
 *
 * 无论哪一种，对外契约完全一致：
 *   extractAttributes({ image, description, type }) ->
 *   { attributes, sources, confidence, notes }
 *
 * 这样上层 store / service / 匹配引擎 / 页面都不需要知道用的是哪一套。
 */

const categories = require('./categories');
const colorUtil = require('./color');
const imageSpec = require('./image-spec');

/* ===================== 确定性伪随机 ===================== */

function hashString(str) {
  let h = 2166136261;
  const s = String(str || 'seed');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 生成 [0,1) 的确定性随机序列 */
function makeRng(seed) {
  let state = hashString(seed) || 1;
  return function rng() {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/* ===================== 文本属性抽取 ===================== */

const MATERIAL_WORDS = [
  ['不锈钢', '金属'], ['金属', '金属'], ['铝合金', '金属'], ['铁', '金属'], ['钢', '金属'],
  ['塑料', '塑料'], ['硅胶', '硅胶'], ['树脂', '树脂'], ['亚克力', '亚克力'], ['abs', '塑料'],
  ['帆布', '帆布'], ['尼龙', '尼龙'], ['牛津布', '尼龙'], ['皮', '皮革'], ['pu', '皮革'], ['皮革', '皮革'],
  ['木质', '木质'], ['木头', '木质'], ['竹', '竹质'], ['玻璃', '玻璃'], ['陶瓷', '陶瓷'],
  ['羊毛', '羊毛'], ['棉', '棉'], ['绒', '绒'], ['纸', '纸质'], ['碳素', '碳素'], ['橡胶', '橡胶']
];

const SHAPE_WORDS = ['圆柱形', '方形', '长方形', '圆形', '椭圆形', '扁形', '不规则', '三角形', '折叠', '长柄'];

const FEATURE_WORDS = [
  '划痕', '刻字', '贴纸', '挂件', '挂饰', '钥匙扣', 'logo', '标志', '图案', '印花', '条纹', '格纹',
  '破损', '污渍', '掉漆', '磨损', '贴膜', '拉链', '姓名贴', '标签', '刺绣', '烫金', '反光条'
];

const SIZE_WORDS = [
  ['大号', '较大'], ['小号', '较小'], ['迷你', '较小'], ['便携', '较小'],
  ['500ml', '约 500ml'], ['350ml', '约 350ml'], ['1l', '约 1L'],
  ['10000mah', '10000mAh'], ['大容量', '较大'], ['很小', '较小'], ['很大', '较大']
];

function findByWords(text, dict) {
  const src = String(text || '').toLowerCase();
  for (let i = 0; i < dict.length; i += 1) {
    const pair = dict[i];
    if (src.indexOf(String(pair[0]).toLowerCase()) >= 0) return pair[1];
  }
  return '';
}

/** 从自然语言描述中抽取结构化属性 */
function extractFromText(description) {
  const text = String(description || '').trim();
  const out = {};
  if (!text) return out;

  const color = colorUtil.parseColor(text);
  if (color) {
    out.main_color = color.name;
    const rest = text.split(color.name).join(' ');
    const color2 = colorUtil.parseColor(rest);
    if (color2 && color2.name !== color.name) out.secondary_color = color2.name;
  }

  const material = findByWords(text, MATERIAL_WORDS);
  if (material) out.material = material;

  const brand = colorUtil.extractBrand(text);
  if (brand) out.brand = brand;

  const shape = SHAPE_WORDS.find((s) => text.indexOf(s) >= 0);
  if (shape) out.shape = shape;

  const size = findByWords(text, SIZE_WORDS);
  if (size) out.size = size;

  const pattern = ['条纹', '格纹', '格子', '波点', '卡通', '纯色', '渐变'].find((s) => text.indexOf(s) >= 0);
  if (pattern) out.pattern = pattern;

  const sticker = ['贴纸', '贴画', '贴膜', '贴标'].find((s) => text.indexOf(s) >= 0);
  if (sticker) out.sticker = '有' + sticker;

  const damage = ['划痕', '破损', '掉漆', '磨损', '缺口', '裂缝', '污渍'].find((s) => text.indexOf(s) >= 0);
  if (damage) out.damage_mark = '有' + damage;

  const accessory = ['挂件', '挂饰', '钥匙扣', '吊坠', '伞套', '保护壳', '卡套', '杯套'].find((s) => text.indexOf(s) >= 0);
  if (accessory) out.accessory = '带' + accessory;

  const logoMatch = text.match(/([^\s，。]{0,8}(?:logo|标志|标识|字样|文字)[^\s，。]{0,6})/i);
  if (logoMatch) out.logo_text = logoMatch[0];

  const features = FEATURE_WORDS.filter((w) => text.indexOf(w) >= 0);
  if (features.length) out.features = features.slice(0, 4);

  return out;
}

/* ===================== 图像属性建议（本地兜底实现） ===================== */

/**
 * 本地「伪 VLM」：同一个 image 标识永远得到同样的结果（可复现）。
 * provider=local 时使用；provider=deepseek 时由 core/ai/deepseek.js 取代。
 */
function extractFromImage(image, type) {
  // 演示图片库：直接使用内置线索，保证离线演示结果稳定可复现
  const spec = imageSpec.get(image);
  if (spec) return Object.assign({ category: spec.category }, spec.hints);

  const rng = makeRng('vlm::' + image);
  const categories_ = categories.list();
  const bias = type === 'found'
    ? ['cup', 'umbrella', 'key', 'card', 'earphone']
    : ['cup', 'earphone', 'umbrella', 'charger', 'card'];
  const cateKey = rng() < 0.72 ? pick(rng, bias) : pick(rng, categories_).key;
  const cate = categories.get(cateKey);

  const mainColor = pick(rng, cate.colorHints);
  const paletteAll = ['黑色', '白色', '灰色', '深灰', '银灰', '蓝色', '深蓝', '红色', '绿色', '卡其', '粉色', '棕色'];
  const secondary = pick(rng, paletteAll);
  const attrs = {
    category: cateKey,
    main_color: mainColor,
    secondary_color: secondary === mainColor ? '' : secondary,
    material: pick(rng, cate.materialHints),
    shape: pick(rng, SHAPE_WORDS)
  };
  if (rng() < 0.5) attrs.logo_text = pick(rng, ['品牌Logo居中', '白色纵向文字Logo', '正面英文标志', '侧面小Logo', '无Logo']);
  if (rng() < 0.4) attrs.pattern = pick(rng, ['纯色', '条纹', '格纹', '波点', '渐变']);
  if (rng() < 0.35) attrs.accessory = pick(rng, ['带挂件', '带保护壳', '带说明书', '带原包装']);
  if (rng() < 0.3) attrs.damage_mark = pick(rng, ['有轻微划痕', '有掉漆', '有磨损']);
  if (rng() < 0.25) attrs.sticker = pick(rng, ['有卡通贴纸', '有反光贴纸']);
  return attrs;
}

/* ===================== 对外统一入口 ===================== */

const FIELD_LABELS = {
  category: '类别',
  brand: '品牌',
  main_color: '主色',
  secondary_color: '辅色',
  material: '材质',
  shape: '形状',
  size: '尺寸',
  logo_text: 'Logo/标识',
  pattern: '图案',
  sticker: '贴纸',
  damage_mark: '磨损痕迹',
  accessory: '附属物',
  features: '显著特征'
};

/**
 * 融合图像与文本两个来源，生成最终建议属性。
 * @param {{image?:string, description?:string, type?:string}} input
 * @returns {{attributes:object, sources:object, confidence:object, notes:string[]}}
 */
function extractAttributes(input) {
  const opts = input || {};
  const imageAttrs = opts.image ? extractFromImage(opts.image, opts.type) : {};
  const textAttrs = extractFromText(opts.description);

  const attributes = {};
  const sources = {};
  const notes = [];

  Object.keys(imageAttrs).forEach((k) => {
    if (imageAttrs[k]) {
      attributes[k] = imageAttrs[k];
      sources[k] = 'image';
    }
  });
  Object.keys(textAttrs).forEach((k) => {
    if (textAttrs[k]) {
      attributes[k] = textAttrs[k];
      sources[k] = imageAttrs[k] && imageAttrs[k] === textAttrs[k] ? 'both' : 'text';
    }
  });

  const fromText = opts.description ? categories.guessFromText(opts.description) : 'other';
  if (fromText !== 'other') {
    attributes.category = fromText;
    sources.category = 'text';
  } else if (imageAttrs.category) {
    attributes.category = imageAttrs.category;
    sources.category = 'image';
  } else {
    attributes.category = 'other';
    sources.category = 'default';
  }

  if (!opts.image) notes.push('未上传图片，图像相似度权重已自动置零，其余权重重新归一化');
  if (!opts.description) notes.push('未填写描述，文字语义权重已自动置零');
  if (sources.main_color === 'image') notes.push('颜色来自图像识别，建议人工确认（光照会影响判断）');

  const confidence = {};
  Object.keys(attributes).forEach((k) => {
    confidence[k] = sources[k] === 'text' ? 0.86 : sources[k] === 'both' ? 0.9 : 0.72;
  });

  return { attributes, sources, confidence, notes };
}

/**
 * 用真实 AI 结果覆盖本地结果（云函数返回时使用）。
 * 只接受白名单字段，避免模型返回脏数据污染数据库。
 */
const ALLOWED_FIELDS = Object.keys(FIELD_LABELS).concat(['category']);

function mergeAiResult(local, ai) {
  const base = local || { attributes: {}, sources: {}, confidence: {}, notes: [] };
  if (!ai || !ai.attributes) return base;

  const attributes = Object.assign({}, base.attributes);
  const sources = Object.assign({}, base.sources);
  const confidence = Object.assign({}, base.confidence);

  Object.keys(ai.attributes).forEach((key) => {
    if (ALLOWED_FIELDS.indexOf(key) < 0) return;
    const value = ai.attributes[key];
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value) && !value.length) return;
    attributes[key] = value;
    sources[key] = ai.sources && ai.sources[key] ? ai.sources[key] : 'ai';
    confidence[key] = (ai.confidence && ai.confidence[key]) || 0.88;
  });

  const notes = (base.notes || []).concat(ai.notes || []);
  return { attributes, sources, confidence, notes, description: ai.description || '' };
}

/* ===================== 向量表示 ===================== */

const EMB_DIM = 64;
const EMB_CACHE = {};

/**
 * 语义指纹向量：把文本/图片标识映射到单位球面上的向量（本地实现）。
 *
 * 特点与局限（答辩时应如实说明）：
 *  - 优点：无需联网、结果稳定、可解释，能体现「同义词归一 + 字符重叠」的语义相近性；
 *  - 局限：它捕捉的是词汇与同义词层面的相似，不具备真实 embedding 模型的深层语义泛化。
 *    接入 CLIP/SigLIP 或第三方 embedding 后，替换本函数即可，上层无需改动。
 */
function embed(kind, payload) {
  const cacheKey = kind + '|' + String(payload || '');
  if (EMB_CACHE[cacheKey]) return EMB_CACHE[cacheKey];
  const vec = embedUncached(kind, payload);
  const keys = Object.keys(EMB_CACHE);
  if (keys.length > 2000) delete EMB_CACHE[keys[0]];
  EMB_CACHE[cacheKey] = vec;
  return vec;
}

function embedUncached(kind, payload) {
  const vec = new Array(EMB_DIM).fill(0);
  let tokens;

  if (kind === 'text') {
    tokens = Array.from(colorUtil.tokenize(payload));
  } else {
    // 图像：如果传入的是「AI 生成的图像语义描述」，按文本方式编码；
    // 如果传入的是 demo:// 图片标识，用演示线索编码（保证离线可复现）。
    const spec = imageSpec.get(payload);
    if (spec) {
      tokens = ['img', spec.category, spec.label]
        .concat(spec.keywords || [])
        .concat(Object.keys(spec.hints || {}).map((k) => String(spec.hints[k])));
      colorUtil.tokenize(spec.label + ' ' + (spec.keywords || []).join(' ')).forEach((t) => tokens.push(t));
    } else {
      tokens = ['img'].concat(String(payload || '').split(/[\/\\._\-\s]/).filter(Boolean));
      colorUtil.tokenize(String(payload || '')).forEach((t) => tokens.push(t));
    }
  }

  tokens.forEach((token) => {
    if (!token) return;
    const h = hashString(kind + ':' + token);
    vec[h % EMB_DIM] += 1;
    vec[(h >>> 7) % EMB_DIM] += 0.6;
    vec[(h >>> 13) % EMB_DIM] += 0.35;
  });

  let norm = 0;
  for (let i = 0; i < EMB_DIM; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMB_DIM; i += 1) vec[i] = Number((vec[i] / norm).toFixed(4));
  return vec;
}

function cosine(a, b) {
  if (!a || !b || !a.length || !b.length) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 图像相似度：
 * 若条目带有 imageDescVec（由视觉模型描述编码而来），优先使用它；
 * 否则退回 image embedding（demo 图片或历史数据）。
 */
function imageSimilarity(itemA, itemB) {
  if (!itemA.image && !itemB.image) return { score: 0, available: false };
  const va = (itemA.embeddings && (itemA.embeddings.imageDesc || itemA.embeddings.image)) || null;
  const vb = (itemB.embeddings && (itemB.embeddings.imageDesc || itemB.embeddings.image)) || null;
  if (!va || !vb) return { score: 0, available: false };
  const cos = cosine(va, vb);
  const mapped = Math.min(1, Math.max(0, (cos - 0.15) / 0.7));
  return { score: mapped, available: true, cosine: cos };
}

/**
 * 为一条记录生成完整向量集合（文本 + 图像）。
 * 图像向量优先用 AI 描述编码，其次用图片标识编码。
 */
function buildEmbeddings(item) {
  const description = (item && item.description) || '';
  const attrs = (item && item.attributes) || {};
  const textDoc = [
    description,
    categories.nameOf(attrs.category),
    attrs.brand || '',
    attrs.main_color || '',
    attrs.material || '',
    (attrs.features || []).join(' ')
  ].join(' ');

  const out = {
    text: embed('text', textDoc),
    image: null,
    imageDesc: null
  };
  if (item && item.image) out.image = embed('image', item.image);
  if (item && item.imageDescription) out.imageDesc = embed('text', item.imageDescription);
  return out;
}

module.exports = {
  FIELD_LABELS,
  ALLOWED_FIELDS,
  EMB_DIM,
  hashString,
  makeRng,
  extractFromText,
  extractFromImage,
  extractAttributes,
  mergeAiResult,
  embed,
  cosine,
  imageSimilarity,
  buildEmbeddings
};
