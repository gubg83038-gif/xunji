/**
 * DeepSeek 视觉能力封装（仅云端调用）
 * ---------------------------------------------------------------
 * ⚠ 安全约束：本文件使用 API Key，只能运行在云函数 / 服务端。
 *    小程序端通过 wx.cloud.callFunction('xj-ai') 间接调用，绝不直接持有 Key。
 *
 * 依据官方文档实现（https://api-docs.deepseek.com/zh-cn/guides/vision）：
 *  - 模型名 deepseek-flash 原生支持图像输入，格式 JPEG/PNG/GIF/WebP
 *  - 三种传图方式：base64 data URL、外部 http(s) URL、Files API file_id
 *  - detail 可选 low / high / original / auto，low 会缩放到 512×512 更省 token
 *  - 图片只能出现在 user 消息中，放在 system/assistant 会返回 400
 *
 * JSON Output（https://api-docs.deepseek.com/zh-cn/guides/json_mode）：
 *  - response_format = { type: 'json_object' }
 *  - prompt 中必须出现 "json" 字样并给出样例
 *  - 官方说明有概率返回空 content，因此这里必须带重试
 */

/**
 * ⚠ 不要在模块顶层 require Node 内置模块。
 *
 * 本文件只应由**云函数端**使用（API Key 必须留在云端），
 * 但小程序端有些工具脚本可能间接 require 到它。
 * 顶层 require('https') 会让模块在小程序里直接加载失败，
 * 表现为「页面全部白屏」——这类错误在 Node 测试里完全看不出来。
 *
 * 因此改为函数内惰性获取。
 */
function loadNodeHttp() {
  /* eslint-disable global-require */
  const https = require('https');
  const http = require('http');
  const URL = require('url').URL;
  /* eslint-enable global-require */
  return { https, http, URL };
}

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  timeout: 60000,
  maxRetries: 3,
  retryDelay: 800
};

/** 字节长度：优先 Buffer，没有则按 UTF-8 手工计算（小程序端用这条） */
function byteLength(str) {
  if (typeof Buffer !== 'undefined' && Buffer.byteLength) return Buffer.byteLength(str);
  let bytes = 0;
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { bytes += 4; i += 1; }
    else bytes += 3;
  }
  return bytes;
}

/** 读取环境变量：小程序端没有 process，返回空串 */
function envVar(name) {
  try {
    if (typeof process !== 'undefined' && process.env) return process.env[name] || '';
  } catch (e) { /* ignore */ }
  return '';
}

/* ===================== HTTP ===================== */

function postJson(url, body, headers, timeout) {
  return new Promise((resolve, reject) => {
    let nodeHttp;
    try {
      nodeHttp = loadNodeHttp();
    } catch (e) {
      const err = new Error('当前环境不支持直连 DeepSeek（API Key 必须放在云函数里）');
      err.retryable = false;
      reject(err);
      return;
    }
    const target = new nodeHttp.URL(url);
    const payload = JSON.stringify(body);
    const lib = target.protocol === 'http:' ? nodeHttp.http : nodeHttp.https;
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': byteLength(payload)
      }, headers || {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 保留原始文本 */ }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(json || { raw: text });
        } else {
          const err = new Error('DeepSeek API ' + res.statusCode + '：' + text.slice(0, 400));
          err.status = res.statusCode;
          err.body = json || text;
          reject(err);
        }
      });
    });

    req.setTimeout(timeout || DEFAULTS.timeout, () => {
      req.destroy(new Error('DeepSeek API 请求超时'));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 可重试的错误：限流、服务端错误、超时、空返回 */
function isRetryable(err) {
  if (!err) return false;
  if (err.retryable) return true;
  if (err.status === 429 || err.status >= 500) return true;
  if (/超时|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(err.message || '')) return true;
  return false;
}

/* ===================== 配置 ===================== */

function resolveOptions(options) {
  const opts = options || {};
  const apiKey = opts.apiKey || envVar('DEEPSEEK_API_KEY') || '';
  return {
    apiKey,
    baseUrl: opts.baseUrl || envVar('DEEPSEEK_BASE_URL') || DEFAULTS.baseUrl,
    model: opts.model || envVar('DEEPSEEK_MODEL') || DEFAULTS.model,
    timeout: opts.timeout || DEFAULTS.timeout,
    maxRetries: opts.maxRetries === undefined ? DEFAULTS.maxRetries : opts.maxRetries
  };
}

function assertKey(cfg) {
  if (!cfg.apiKey) {
    const err = new Error('未配置 DEEPSEEK_API_KEY。请在云函数 xj-ai 的环境变量中设置，不要写进小程序端代码。');
    err.retryable = false;
    throw err;
  }
}

/* ===================== 底层对话调用 ===================== */

/**
 * 调用 DeepSeek 对话补全
 * @param {Array} messages OpenAI 兼容消息数组
 * @param {object} options { apiKey, model, baseUrl, jsonMode, maxTokens, temperature }
 */
async function chat(messages, options) {
  const cfg = resolveOptions(options);
  assertKey(cfg);
  const body = {
    model: cfg.model,
    messages,
    temperature: options && options.temperature !== undefined ? options.temperature : 0.2
  };
  if (options && options.maxTokens) body.max_tokens = options.maxTokens;
  if (options && options.jsonMode) body.response_format = { type: 'json_object' };

  let lastError = null;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt += 1) {
    try {
      const res = await postJson(cfg.baseUrl + '/chat/completions', body, {
        Authorization: 'Bearer ' + cfg.apiKey
      }, cfg.timeout);

      const choice = res && res.choices && res.choices[0];
      const content = choice && choice.message ? choice.message.content : '';
      if (!content && options && options.jsonMode) {
        // 官方说明 JSON 模式有概率返回空 content，这里作为可重试情况处理
        const err = new Error('DeepSeek 返回空内容（JSON 模式偶发，将重试）');
        err.retryable = true;
        throw err;
      }
      return {
        content,
        usage: res.usage || null,
        model: res.model || cfg.model,
        raw: res
      };
    } catch (e) {
      lastError = e;
      if (attempt >= cfg.maxRetries || !isRetryable(e)) break;
      await sleep(DEFAULTS.retryDelay * Math.pow(2, attempt));
    }
  }
  throw lastError;
}

/* ===================== 图片输入构造 ===================== */

/**
 * 构造图片内容块。三种方式都支持，按传入内容自动选择：
 *  - { base64, mimeType }  → data URL（本地文件最简单）
 *  - { url }               → 外部可公开访问链接
 *  - { fileId }            → Files API 上传后的 file_id
 */
function buildImageBlock(image, detail) {
  if (!image) return null;
  if (image.fileId) {
    return { type: 'file', file_id: image.fileId };
  }
  if (image.url) {
    return { type: 'image_url', image_url: { url: image.url, detail: detail || 'auto' } };
  }
  if (image.base64 || image.data) {
    const data = image.base64 || image.data;
    const mime = image.mimeType || image.mime || 'image/jpeg';
    const url = String(data).indexOf('data:') === 0 ? data : 'data:' + mime + ';base64,' + data;
    return { type: 'image_url', image_url: { url, detail: detail || 'auto' } };
  }
  if (typeof image === 'string') {
    const url = image;
    return { type: 'image_url', image_url: { url, detail: detail || 'auto' } };
  }
  return null;
}

/* ===================== 业务能力：属性提取 + 语义描述 ===================== */

const FIELD_SPEC = [
  'category（只能取下列之一：cup,umbrella,earphone,key,bag,card,device,charger,glasses,watch,book,stationery,cloth,sport,other）',
  'brand（品牌，没有则空字符串）',
  'main_color（主色，中文，如 深灰）',
  'secondary_color（辅色，没有则空字符串）',
  'material（材质，如 金属/塑料/帆布/皮革/木质/玻璃）',
  'shape（形状，如 圆柱形/方形/椭圆形）',
  'size（尺寸或容量，没有则空字符串）',
  'logo_text（Logo 或文字标识的位置与样式描述）',
  'pattern（图案，如 纯色/条纹/格纹）',
  'sticker（贴纸情况，没有则空字符串）',
  'damage_mark（磨损、划痕、掉漆等痕迹）',
  'accessory（附属物，如 挂件/保护壳/伞套）',
  'features（数组，0-4 个最显著的个性化特征，如 ["杯底划痕","卡通贴纸"]）'
];

function buildExtractPrompt(description, type) {
  const role = type === 'found' ? '拾物者（捡到物品的人）' : '失主（丢失物品的人）';
  return [
    '你是校园失物招领平台的结构化信息抽取模块。用户是' + role + '，会提供一张物品照片和/或一句自然语言描述。',
    '',
    '请仔细观察图片，并结合用户描述，抽取物品的结构化属性，以 json 格式输出。',
    '',
    '输出 json 的字段要求：',
    FIELD_SPEC.map((f) => '- ' + f).join('\n'),
    '',
    '另外还需要输出两个辅助字段：',
    '- description：一段 40—80 字的中文客观描述，用于跨模态检索。只描述你真正看到的内容（类别、颜色、材质、形状、显著特征、Logo），不要编造，不要给建议。',
    '- confidence：json 对象，为每个字段给出 0—1 的置信度。',
    '',
    '重要规则：',
    '1. 只输出 json，不要输出任何解释文字，不要使用 markdown 代码块。',
    '2. 看不清或没有把握的字段，填空字符串 ""，绝对不要猜测编造。',
    '3. 颜色使用常见中文颜色词（黑/白/灰/深灰/银灰/蓝/深蓝/红/绿/棕/卡其/粉/透明/彩色）。',
    '4. 用户文字描述与图片冲突时，以用户描述为准（用户更了解自己的物品）。',
    '',
    'json 输出样例：',
    '{',
    '  "category": "cup",',
    '  "brand": "膳魔师",',
    '  "main_color": "深灰",',
    '  "secondary_color": "黑色",',
    '  "material": "金属",',
    '  "shape": "圆柱形",',
    '  "size": "约 500ml",',
    '  "logo_text": "杯身有白色纵向文字 Logo",',
    '  "pattern": "纯色",',
    '  "sticker": "",',
    '  "damage_mark": "杯底有一道长划痕",',
    '  "accessory": "带杯套",',
    '  "features": ["杯底长划痕", "白色纵向 Logo"],',
    '  "description": "深灰色圆柱形金属保温杯，黑色杯盖，杯身有白色纵向文字 Logo，杯底有一道长划痕，外观整洁。",',
    '  "confidence": { "category": 0.95, "main_color": 0.9, "material": 0.85 }',
    '}',
    '',
    description ? '用户描述：' + description : '用户未提供文字描述，请完全依据图片判断。'
  ].join('\n');
}

function safeJsonParse(text) {
  if (!text) return null;
  let s = String(text).trim();
  // 容错：模型偶尔会包 markdown 代码块
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(s);
  } catch (e) { /* 继续尝试截取 */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch (e) { /* 放弃 */ }
  }
  return null;
}

/** 归一化模型输出，避免脏数据进入数据库 */
function normalizeResult(parsed) {
  const categories = require('../categories');
  const validCategories = categories.list().map((c) => c.key);
  const out = { attributes: {}, confidence: {}, sources: {}, notes: [] };

  const raw = parsed || {};
  Object.keys(raw).forEach((key) => {
    if (key === 'description' || key === 'confidence') return;
    const value = raw[key];
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      const list = value.map((x) => String(x).trim()).filter(Boolean).slice(0, 4);
      if (list.length) out.attributes[key] = list;
      return;
    }
    out.attributes[key] = String(value).trim();
    out.sources[key] = 'ai';
  });

  if (out.attributes.category && validCategories.indexOf(out.attributes.category) < 0) {
    out.attributes.category = categories.guessFromText(out.attributes.category) || 'other';
    out.notes.push('模型返回的类别不在预设体系内，已按关键词重新归类');
  }

  if (raw.confidence && typeof raw.confidence === 'object') {
    Object.keys(raw.confidence).forEach((k) => {
      const v = Number(raw.confidence[k]);
      if (!Number.isNaN(v)) out.confidence[k] = Math.min(1, Math.max(0, v));
    });
  }

  if (typeof raw.description === 'string') out.description = raw.description.trim();
  return out;
}

/**
 * 抽取结构化属性（主入口）
 * @param {object} input
 *   {
 *     image: { base64 | url | fileId, mimeType },   // 可选
 *     description: string,                          // 可选
 *     type: 'lost' | 'found',
 *     detail: 'low' | 'high' | 'original' | 'auto'  // 可选，默认 low 省 token
 *   }
 * @param {object} options { apiKey, model, baseUrl }
 */
async function extractAttributes(input, options) {
  const opts = input || {};
  const content = [];
  const imageBlock = buildImageBlock(opts.image, opts.detail || 'low');
  if (imageBlock) content.push(imageBlock);
  content.push({ type: 'text', text: buildExtractPrompt(opts.description, opts.type) });

  if (!imageBlock && !opts.description) {
    const err = new Error('图片与描述至少需要一个');
    err.retryable = false;
    throw err;
  }

  const res = await chat([{ role: 'user', content }], Object.assign({}, options, {
    jsonMode: true,
    maxTokens: 1200,
    temperature: 0.1
  }));

  const parsed = safeJsonParse(res.content);
  if (!parsed) {
    const err = new Error('DeepSeek 返回内容无法解析为 JSON：' + String(res.content || '').slice(0, 200));
    err.retryable = true;
    throw err;
  }

  const normalized = normalizeResult(parsed);
  normalized.usage = res.usage;
  normalized.model = res.model;
  return normalized;
}

/**
 * 只生成图像语义描述（用于图像向量，替代 CLIP 近似方案）
 * 比完整属性提取更省：只要一段文字。
 */
async function describeImage(image, options) {
  const imageBlock = buildImageBlock(image, (options && options.detail) || 'low');
  if (!imageBlock) {
    const err = new Error('缺少图片输入');
    err.retryable = false;
    throw err;
  }
  const prompt = [
    '请用一段 40—80 字的中文客观描述这张图片中的物品，用于失物匹配检索。',
    '依次说明：物品类别、主色与辅色、材质、形状、显著特征（磨损/贴纸/挂件/文字 Logo）、新旧程度。',
    '只描述你确实看到的内容，不要编造，不要给出找回建议，不要输出 json，直接输出这段描述。'
  ].join('\n');

  const res = await chat([{
    role: 'user',
    content: [imageBlock, { type: 'text', text: prompt }]
  }], Object.assign({}, options, { maxTokens: 300, temperature: 0.2 }));

  return {
    description: String(res.content || '').trim(),
    usage: res.usage,
    model: res.model
  };
}

module.exports = {
  DEFAULTS,
  chat,
  buildImageBlock,
  buildExtractPrompt,
  safeJsonParse,
  normalizeResult,
  extractAttributes,
  describeImage,
  resolveOptions
};
