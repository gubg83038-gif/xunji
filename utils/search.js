const api = require('./api');
const store = require('./store');
const engine = require('../core/search');
const vision = require('./vision');

async function search(input) {
  const p = Object.assign({}, input);
  let model = 'local';
  let note = '根据文字、物品属性与已有图片描述检索';
  let recognition = { description: '', suggestions: [], status: '' };
  let visualHints = '';
  if (p.image || p.description) {
    const extracted = await vision.recognize({ image: p.image, description: p.description, type: 'lost', force: p.force, localOnly: p.localOnly });
    p.attributes = extracted.attributes;
    p.imageDescription = extracted.description || '';
    if (p.image && !extracted.fallback) {
      recognition = { description: p.imageDescription, suggestions: extracted.suggestions || [], status: extracted.status || 'recognized' };
      visualHints = recognition.suggestions.filter((s) => s.confidence === null).map((s) => s.displayValue).join(' ');
    }
    model = extracted.model || 'local';
    if (extracted.warning) {
      if (!String(p.description || '').trim()) throw new Error(extracted.warning);
      note = extracted.warning + '；已使用文字线索检索';
    }
    if (extracted.cached) note += '；已复用本次识别结果';
    if (extracted.notes && extracted.notes.length) note += '；' + extracted.notes.join('；');
  }
  if (recognition.suggestions.length && !p.description && !p.imageDescription && !visualHints &&
      !Object.keys(p.attributes || {}).some((k) => k !== 'category' || p.attributes[k] !== 'other')) {
    return { results: [], clues: [], total: 0, scanned: 0, elapsed: 0, model, recognition,
      mode: 'local', note: '照片中有待确认线索，请补充物品名称或更清晰的近照后检索' };
  }
  // 上传照片只用于 AI 分析；临时路径及 base64 不进入检索业务接口。
  const query = { description: p.description, imageDescription: p.imageDescription,
    attributes: p.attributes, visualHints, kind: p.kind, category: p.category, topK: 20 };
  if (!p.localOnly && api.isCloud()) {
    try {
      const result = await api.callApi('item.search', query);
      return Object.assign(result, { model, mode: 'cloud', note, recognition });
    } catch (e) {
      if (e.code !== 'UNKNOWN_ACTION') {
        if (/-601034|没有权限|permission|access denied/i.test(e.message || ''))
          throw new Error('当前账号没有云开发环境的访问权限。可先使用本机数据找物；真实照片识别需要环境管理员开通访问权限');
        throw new Error('云端搜索暂时不可用，请稍后重试，或使用本机数据找物');
      }
      // 兼容尚未部署新增接口的云函数，并明确标注数据来源。
      return Object.assign(engine.search(query, store.itemsOf()), { model, mode: 'cache',
        note: note + '；当前查询已同步到本机的数据，新云端搜索接口尚未部署', recognition });
    }
  }
  if (p.localOnly) note = '正在查询本机已有数据；当前模式不分析真实照片，也不会获取云端最新记录';
  return Object.assign(engine.search(query, store.itemsOf()), { model, mode: 'local', note, recognition });
}

module.exports = { search };
