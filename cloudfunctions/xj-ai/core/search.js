/** 临时图文查询：只读取物品库，不创建物品、匹配或认领记录。 */
const vlm = require('./vlm');
const matcher = require('./matcher');
const categories = require('./categories');
const domain = require('./domain');
const TopK = require('./topk');
const EXCLUDED = new Set(['closed', 'returned', 'recovered', 'reserved', 'waiting_handover']);

function publicAttributes(input) {
  const out = {};
  matcher.ATTR_FIELDS.forEach((key) => {
    const value = (input || {})[key];
    if (typeof value === 'string') out[key] = value.slice(0, 200);
    else if (Array.isArray(value)) out[key] = value.filter((x) => typeof x === 'string').slice(0, 8);
  });
  if (out.category === 'other') delete out.category;
  return out;
}

function documentOf(item, attributes) {
  return [item.title, item.publicDescription || item.description, item.imageDescription,
    attributes.category ? categories.nameOf(attributes.category) : '',
    Object.keys(attributes).filter((key) => key !== 'category').map((key) => {
      const value = attributes[key];
      return Array.isArray(value) ? value.join(' ') : value;
    }).join(' ')].filter(Boolean).join(' ');
}

function search(input, items) {
  const started = Date.now();
  const p = input || {};
  const description = String(p.description || '').trim().slice(0, 500);
  const imageDescription = String(p.imageDescription || '').trim().slice(0, 1000);
  // 缺少置信度的建议仅作文本召回，不作为确定类别或属性参与硬比较。
  const visualHints = String(p.visualHints || '').trim().slice(0, 700);
  const attributes = publicAttributes(Object.assign({}, vlm.extractAttributes({ description }).attributes, p.attributes));
  const queryDoc = [documentOf({ description, imageDescription }, attributes), visualHints].filter(Boolean).join(' ');
  if (!queryDoc.trim()) throw new Error('请填写物品描述；照片未识别成功时请补充文字线索');
  const kind = p.kind === 'lost' ? 'lost' : 'found';
  const category = p.category && p.category !== 'all' ? p.category : '';
  const topK = Math.max(1, Math.min(30, Number(p.topK) || 20));
  const query = { description: queryDoc, attributes, embeddings: { text: vlm.embed('text', queryDoc) } };
  const top = new TopK(topK, (a, b) => b.score - a.score || b.createdAt - a.createdAt || String(a.item.id).localeCompare(String(b.item.id)));
  let total = 0;
  let scanned = 0;
  (items || []).forEach((item) => {
    if (item.kind !== kind || EXCLUDED.has(item.status) || (category && (item.attributes || {}).category !== category)) return;
    scanned += 1;
    const attrs = publicAttributes(item.attributes);
    const doc = documentOf(item, attrs);
    const text = matcher.textScore(query, { description: doc, attributes: attrs });
    const comparable = {};
    Object.keys(attributes).forEach((key) => { if (attrs[key]) comparable[key] = attrs[key]; });
    const attr = matcher.compareAttributes(attributes, comparable);
    const overlap = Object.keys(comparable).length;
    // 明确的颜色/品牌等线索比描述长度更可靠，避免短描述候选凭词频压过外观一致者。
    let score = overlap ? text.score * 0.45 + attr.score * 0.55 : text.score;
    if (attributes.category && attrs.category && attributes.category !== attrs.category) score *= 0.25;
    const reasons = attr.items.filter((x) => x.score >= 0.65 && comparable[x.field])
      .map((x) => x.label + '：' + (x.field === 'category' ? categories.nameOf(x.b) :
        (Array.isArray(x.b) ? x.b.join('、') : x.b))).slice(0, 3);
    if (!reasons.length && text.score >= 0.25) reasons.push('物品描述或图片描述包含相近线索');
    if (score < 0.24 || !reasons.length) return;
    total += 1;
    top.push({ item, attrs, score, reasons, createdAt: item.createdAt || 0 });
  });
  // 只为最终显示的候选构建页面数据，内存保留量始终 <= topK。
  const results = top.values().map(({ item, attrs, score, reasons }) => {
    const view = domain.itemView(item);
    // 固定输出白名单：不返回秘密特征、身份标注或原始向量。
    return {
      id: view.id, kind: view.kind, title: view.title, icon: view.icon,
      image: view.image, hasImage: view.hasImage, locationName: view.locationName,
      timeText: view.timeText, statusLabel: view.statusLabel, tags: view.tags,
      score, scorePercent: Math.round(score * 100),
      /**
       * 这里给的是**描述相似度**，不是候选列表里的「综合匹配度」。
       *
       * 为什么两者必然不同（本轮澄清，不是 bug）：
       *   「找物」时用户还没有发布记录，也就没有可配对的失物，
       *   因此算不出五路融合分 S = α·S_image + β·S_attr + γ·S_text + δ·S_geo + ε·S_time
       *   ——它缺了「跟谁的物品比」这个前提，时空两路无从谈起。
       *   同一条物品在搜索页 67%、在候选列表 82% 是正常的。
       *   为了不让用户以为分数自相矛盾，界面必须明确标注口径。
       */
      scoreLabel: '描述相似度（仅文字与属性，不含时空）',
      reasons,
      category: attrs.category || 'other', photoLabel: view.hasImage ? '物品照片' : '暂无真实照片',
      createdAt: item.createdAt || 0
    };
  });
  return { results, total, scanned,
    elapsed: Date.now() - started, attributes,
    clues: Object.keys(attributes).map((key) => ({ key, label: vlm.FIELD_LABELS[key] || key,
      value: key === 'category' ? categories.nameOf(attributes[key]) :
        (Array.isArray(attributes[key]) ? attributes[key].join('、') : attributes[key]) })) };
}

module.exports = { search, publicAttributes };
