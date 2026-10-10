/** 照片识别共享入口：准备图像、复用成功结果、明确降级原因。 */
const api = require('./api');
const vlm = require('../core/vlm');
const library = require('../core/image-spec');
const cache = new Map();
const TTL = 3 * 60 * 1000;
const MAX_BASE64 = 1800 * 1024;

function wxCall(name, options) {
  return new Promise((resolve, reject) => wx[name](Object.assign({}, options, {
    success: resolve, fail: (e) => reject(new Error(e.errMsg || '图片处理失败'))
  })));
}

function mimeOf(base64, info, file) {
  if (base64.indexOf('iVBOR') === 0) return 'image/png';
  if (base64.indexOf('/9j/') === 0) return 'image/jpeg';
  if (base64.indexOf('R0lGOD') === 0) return 'image/gif';
  if (base64.indexOf('UklGR') === 0) return 'image/webp';
  const type = (info && info.type) || (String(file).match(/\.(png|webp|gif|jpe?g)(?:\?|$)/i) || [])[1];
  return type && /png|webp|gif/i.test(type) ? 'image/' + type.toLowerCase() : 'image/jpeg';
}

async function prepareImage(image) {
  if (!image || library.get(image)) return { image: image || '', notes: [] };
  if (image.indexOf('cloud://') === 0) return { imageFileId: image, notes: [] };
  if (/^https?:\/\//.test(image)) return { imageUrl: image, notes: [] };
  let info = null;
  let file = image;
  const notes = [];
  if (typeof wx !== 'undefined' && typeof wx.getImageInfo === 'function') {
    try { info = await wxCall('getImageInfo', { src: image }); }
    catch (e) { throw new Error('照片无法读取，请重新选择 JPG、PNG、GIF 或 WebP 图片'); }
    if (info.type && !/^(jpg|jpeg|png|gif|webp)$/i.test(info.type))
      throw new Error('照片格式暂不支持，请换成 JPG、PNG 或 WebP');
    if (Math.min(info.width, info.height) < 240) notes.push('照片分辨率较低，建议换一张更清晰的近照');
    if (Math.max(info.width, info.height) > 1600 && typeof wx.compressImage === 'function') {
      const ratio = 1600 / Math.max(info.width, info.height);
      try {
        const compressed = await wxCall('compressImage', { src: image, quality: 85,
          compressedWidth: Math.round(info.width * ratio), compressedHeight: Math.round(info.height * ratio) });
        file = compressed.tempFilePath || image;
      } catch (e) { notes.push('照片压缩未成功，将尝试读取原图'); }
    }
  }
  const read = (path) => api.readFileBase64(path).catch(() => { throw new Error('照片读取失败，请重新选择照片'); });
  let imageBase64 = await read(file);
  if (!imageBase64) throw new Error('照片为空，请重新选择照片');
  // 像素尺寸较小的 PNG 也可能超过传输限制；最多追加两次压缩。
  if (imageBase64.length > MAX_BASE64 && typeof wx !== 'undefined' && typeof wx.compressImage === 'function') {
    for (const quality of [70, 55]) {
      try {
        const compressed = await wxCall('compressImage', { src: file, quality });
        if (!compressed.tempFilePath) continue;
        const candidate = await read(compressed.tempFilePath);
        if (candidate && candidate.length < imageBase64.length) {
          imageBase64 = candidate;
          file = compressed.tempFilePath;
        }
        if (imageBase64.length <= MAX_BASE64) break;
      } catch (e) { break; }
    }
  }
  if (imageBase64.length > MAX_BASE64) throw new Error('照片过大，请裁剪到物品主体或选择较小的照片');
  return { imageBase64, mimeType: mimeOf(imageBase64, file === image ? info : null, file), notes };
}

async function recognize(input) {
  const p = input || {};
  const image = p.image || '';
  const description = String(p.description || '').trim();
  const local = vlm.extractAttributes({ image, description, type: p.type });
  if (!image && !description) return Object.assign({ model: 'local', warning: '' }, local);
  if (p.localOnly) return Object.assign(local, { model: 'local', fallback: true, description: '',
    warning: image && !library.get(image) ? '本机模式无法分析真实照片，请补充文字描述' : '' });
  if (image && !library.get(image) && !api.isCloud()) return Object.assign(local, {
    model: 'local', fallback: true, description: '', warning: '当前离线，无法分析真实照片，请补充文字描述'
  });
  const key = JSON.stringify([image, description, p.type || 'lost']);
  const cached = cache.get(key);
  if (!p.force && cached && Date.now() - cached.time < TTL)
    return Object.assign(JSON.parse(JSON.stringify(await cached.promise)), { cached: true });
  const promise = (async () => {
    let prepared;
    try { prepared = await prepareImage(image); }
    catch (e) {
      if (!description) throw e;
      return Object.assign(local, { model: 'local', fallback: true, description: '', warning: e.message + '；已使用文字线索' });
    }
    const payload = Object.assign({ description, type: p.type || 'lost', detail: 'high' }, prepared);
    if (image && !library.get(image)) payload.description = '';
    delete payload.notes;
    const ai = await api.extractAttributes(payload, () => Object.assign({ model: 'local', fallback: true }, local));
    const visual = vlm.mergeAiResult(null, ai);
    const merged = vlm.mergeAiResult(local, ai);
    const fallback = !!ai.fallback || /^local(?:-|$)/.test(ai.model || 'local');
    const observedDescription = fallback ? '' : String(ai.description || '').trim();
    // 判断照片是否识别成功只看视觉返回，不能把用户文字提取误当成视觉证据。
    const hasAccepted = Object.keys(visual.attributes).some((k) => k !== 'category' || visual.attributes[k] !== 'other');
    const suggestions = fallback ? [] : merged.suggestions || [];
    const status = fallback ? 'fallback' : suggestions.length ? 'needs_confirmation'
      : hasAccepted || observedDescription ? 'recognized' : 'empty';
    const warning = image && !library.get(image)
      ? fallback ? '照片识别暂不可用，请补充文字线索或点击重新识别'
        : status === 'empty' ? '未提取到可用的物体线索，请拍摄物品近照或补充文字' : '' : '';
    return Object.assign({}, merged, { model: ai.model || 'local', fallback,
      description: observedDescription, suggestions, status, warning,
      notes: (merged.notes || []).concat(prepared.notes || []) });
  })();
  cache.set(key, { time: Date.now(), promise });
  if (cache.size > 4) cache.delete(cache.keys().next().value);
  try {
    const result = await promise;
    if ((result.fallback || result.status === 'empty') && cache.get(key) && cache.get(key).promise === promise) cache.delete(key);
    return JSON.parse(JSON.stringify(result));
  } catch (e) {
    if (cache.get(key) && cache.get(key).promise === promise) cache.delete(key);
    throw e;
  }
}

module.exports = { recognize, prepareImage, mimeOf, clearCache: () => cache.clear() };
