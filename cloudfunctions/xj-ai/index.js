/**
 * 云函数 xj-ai：AI 能力出口
 * ---------------------------------------------------------------
 * 为什么必须有这一层：
 *   DeepSeek API Key 一旦写进小程序代码包，就可以被反编译提取，等于公开泄露。
 *   所以真实模型调用只能发生在服务端，小程序端通过云函数间接使用。
 *
 * ⚠ 部署后必须在云函数环境变量中配置（不要在代码里硬编码）：
 *   DEEPSEEK_API_KEY    必填，你的 DeepSeek API Key
 *   DEEPSEEK_MODEL      选填，默认 deepseek-flash
 *   DEEPSEEK_BASE_URL   选填，默认 https://api.deepseek.com
 *
 * 设置路径：微信开发者工具 → 云开发 → 云函数 → xj-ai → 配置 → 环境变量
 *
 * 调用方式：
 *   wx.cloud.callFunction({
 *     name: 'xj-ai',
 *     data: {
 *       action: 'ai.extract',
 *       payload: { imageBase64, mimeType, description, type: 'lost', detail: 'low' }
 *     }
 *   })
 *
 * action 一览：
 *   ai.extract    图像 + 描述 → 结构化属性 + 图像语义描述（发布时调用一次并缓存）
 *   ai.describe   仅生成图像语义描述（用于图像向量）
 *   ai.health     检查 Key 是否配置、模型是否可用
 */

const cloud = require('wx-server-sdk');
const deepseek = require('./core/ai/deepseek');
const vlm = require('./core/vlm');
const imageSpec = require('./core/image-spec');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function ok(data) { return { ok: true, data }; }
function fail(message, code) {
  return { ok: false, error: { message: String(message || '未知错误'), code: code || 'ERROR' } };
}

/** 演示图片无需调用模型：直接使用内置线索，省时省钱且结果可复现 */
function resolveDemoImage(image, imageBase64) {
  if (imageBase64) return null;
  const spec = imageSpec.get(image);
  if (!spec) return null;
  return Object.assign({ category: spec.category }, spec.hints);
}

/** 组装模型所需的图片输入 */
async function buildImageInput(payload) {
  const p = payload || {};
  if (p.imageBase64) {
    return { base64: p.imageBase64, mimeType: p.mimeType || 'image/jpeg' };
  }
  if (p.imageFileId && String(p.imageFileId).indexOf('cloud://') === 0) {
    // CloudBase fileID 与模型服务 Files API file_id 属于不同系统。
    const file = await cloud.downloadFile({ fileID: p.imageFileId });
    if (!file.fileContent || !file.fileContent.length) throw new Error('云存储照片为空或无权读取');
    if (file.fileContent.length > 1350 * 1024) throw new Error('云存储照片过大，请重新选择较小的照片');
    const data = file.fileContent.toString('base64');
    const mime = data.indexOf('iVBOR') === 0 ? 'image/png' : data.indexOf('UklGR') === 0 ? 'image/webp' : data.indexOf('R0lGOD') === 0 ? 'image/gif' : 'image/jpeg';
    return { base64: data, mimeType: mime };
  }
  if (p.imageFileId) return { fileId: p.imageFileId };
  if (p.imageUrl) return { url: p.imageUrl };
  return null;
}

/** 本地兜底：模型不可用时不让发布流程失败 */
function localFallback(payload) {
  const p = payload || {};
  const demo = resolveDemoImage(p.image, p.imageBase64);
  if (demo) {
    return {
      attributes: demo,
      confidence: {},
      sources: Object.keys(demo).reduce((acc, k) => { acc[k] = 'demo'; return acc; }, {}),
      description: '',
      model: 'demo-hints',
      fallback: true
    };
  }
  const local = vlm.extractAttributes({
    image: p.image || '',
    description: p.description || '',
    type: p.type || 'lost'
  });
  return {
    attributes: local.attributes,
    confidence: local.confidence,
    sources: local.sources,
    description: '',
    model: 'local-text-rules',
    fallback: true
  };
}

const handlers = {
  'ai.extract': async (payload) => {
    const p = payload || {};

    // 1) 演示图片：不消耗模型额度
    const demo = resolveDemoImage(p.image, p.imageBase64);
    if (demo) {
      return ok({
        attributes: demo,
        confidence: {},
        sources: Object.keys(demo).reduce((acc, k) => { acc[k] = 'demo'; return acc; }, {}),
        description: '',
        model: 'demo-hints'
      });
    }

    if (!p.imageBase64 && !p.imageFileId && !p.imageUrl && !p.description) {
      return fail('需要提供图片或文字描述', 'NO_INPUT');
    }

    try {
      const imageInput = await buildImageInput(p);
      const result = await deepseek.extractAttributes({
        image: imageInput,
        description: p.description || '',
        type: p.type || 'lost',
        detail: p.detail || 'high'
      });
      return ok({
        attributes: result.attributes,
        confidence: result.confidence,
        sources: result.sources,
        notes: result.notes,
        description: result.description || '',
        model: result.model,
        usage: result.usage
      });
    } catch (e) {
      // 模型失败时降级到本地规则，保证发布流程不中断，并如实告知前端。
      // 未配置 Key 属于「预期内的降级」而非异常，用 warn 记录，避免云函数日志里出现误导性的 error。
      const isConfigIssue = /未配置 DEEPSEEK_API_KEY/.test(e.message || '');
      if (isConfigIssue) {
        console.warn('[xj-ai] 未配置 DEEPSEEK_API_KEY，本次使用本地规则提取属性');
      } else {
        console.error('[xj-ai] ai.extract 失败，降级本地规则：', e.message);
      }
      const fallback = localFallback(p);
      fallback.error = e.message;
      return ok(fallback);
    }
  },

  'ai.describe': async (payload) => {
    const p = payload || {};
    if (!p.imageBase64 && !p.imageFileId && !p.imageUrl) return fail('需要提供图片', 'NO_INPUT');
    try {
      const imageInput = await buildImageInput(p);
      const result = await deepseek.describeImage(imageInput, { detail: p.detail || 'low' });
      return ok(result);
    } catch (e) {
      console.error('[xj-ai] ai.describe 失败：', e.message);
      return fail(e.message, 'AI_FAILED');
    }
  },

  'ai.health': async () => {
    const cfg = deepseek.resolveOptions({});
    const hasKey = !!cfg.apiKey;
    if (!hasKey) {
      return ok({
        ready: false,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        message: '未配置 DEEPSEEK_API_KEY 环境变量，当前会降级使用本地规则提取属性'
      });
    }
    try {
      const res = await deepseek.chat([{ role: 'user', content: '回复两个字：正常' }], { maxTokens: 16, temperature: 0 });
      return ok({
        ready: true,
        model: res.model,
        baseUrl: cfg.baseUrl,
        sample: String(res.content || '').slice(0, 20),
        usage: res.usage
      });
    } catch (e) {
      return ok({ ready: false, model: cfg.model, baseUrl: cfg.baseUrl, message: e.message });
    }
  }
};

exports.main = async (event) => {
  const start = Date.now();
  const action = (event && event.action) || 'ai.extract';
  const handler = handlers[action];
  if (!handler) {
    return Object.assign(fail('未知 action：' + action, 'UNKNOWN_ACTION'), {
      availableActions: Object.keys(handlers)
    });
  }
  try {
    const result = await handler(event && event.payload);
    result.elapsed = Date.now() - start;
    return result;
  } catch (e) {
    console.error('[xj-ai] action=' + action + ' 异常：', e);
    return fail(e.message || 'AI 服务异常', 'INTERNAL');
  }
};
