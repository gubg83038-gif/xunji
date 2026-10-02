/**
 * 向量（embedding）统一入口
 * ---------------------------------------------------------------
 * 方案 7.2 / 7.3 需要图像向量与文本向量。现状说明：
 *
 *   DeepSeek 提供对话与视觉理解能力，但**没有 embedding 接口**
 *   （官方 /models 只返回对话模型，社区 issue 亦确认无专用 embedding）。
 *
 * 因此本项目采用三层可切换方案，默认第 1 层即可跑通：
 *
 *  1) provider = 'local'     本地语义指纹（同义词概念 + 字符 bigram 哈希）
 *                            零成本、离线可用、结果可复现；语义泛化能力弱于真实模型
 *  2) provider = 'deepseek'  图像走「视觉描述 → 文本向量」，文本走同一套本地编码
 *                            这是对 CLIP 跨模态对齐的近似：图 → 语义空间
 *  3) provider = 'http'      第三方 OpenAI 兼容 embedding 服务（如 BAAI/bge、通义）
 *                            只需配置 baseUrl / apiKey / model，代码无需改动
 *
 * 注意：无论用哪一层，core/matcher.js 都只调用 buildVector() 与 cosine()，
 * 后续接入 CLIP/SigLIP 时替换本文件即可，匹配引擎与页面无需改动。
 */

const vlm = require('../vlm');
const imageSpec = require('../image-spec');

const EXTERNAL_DEFAULTS = {
  timeout: 20000,
  dim: 256
};

/* ===================== 外部 embedding 服务 ===================== */

/**
 * ⚠ 这里不要在模块顶层 require Node 内置模块。
 *
 * 真实事故：本文件曾被 app.js → utils/service.js → core/domain.js 间接引入，
 * 而顶层写着 require('https') / require('http') / require('url')。
 * 小程序环境没有这些模块，App 加载直接失败，表现为**所有页面白屏**。
 *
 * 现在改为在真正要发 HTTP 请求时才惰性获取：
 *   - 云函数端（Node）→ 能取到，正常走 http provider
 *   - 小程序端       → 取不到，抛一个明确错误，但**不影响模块加载**
 */
function loadNodeHttp() {
  /* eslint-disable global-require */
  const https = require('https');
  const http = require('http');
  const URL = require('url').URL;
  /* eslint-enable global-require */
  return { https, http, URL };
}

/** 当前环境是否能发 HTTP 请求（小程序端为 false） */
function canUseHttpProvider() {
  try {
    loadNodeHttp();
    return true;
  } catch (e) {
    return false;
  }
}

function postJson(url, body, headers, timeout) {
  return new Promise((resolve, reject) => {
    let nodeHttp;
    try {
      nodeHttp = loadNodeHttp();
    } catch (e) {
      const err = new Error('当前环境不支持直连 embedding 服务（小程序端请改用云函数转发）');
      err.retryable = false;
      reject(err);
      return;
    }
    const target = new nodeHttp.URL(url);
    const payload = JSON.stringify(body);
    const useLib = target.protocol === 'http:' ? nodeHttp.http : nodeHttp.https;
    const req = useLib.request({
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
        try { json = JSON.parse(text); } catch (e) { /* ignore */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json || {});
        else {
          const err = new Error('embedding 服务 ' + res.statusCode + '：' + text.slice(0, 300));
          err.status = res.statusCode;
          reject(err);
        }
      });
    });
    req.setTimeout(timeout || EXTERNAL_DEFAULTS.timeout, () => req.destroy(new Error('embedding 服务超时')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** 字节长度：优先用 Buffer，没有则按 UTF-8 手工计算（小程序端用这条） */
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

/**
 * 调用 OpenAI 兼容的 /embeddings 接口
 * 适配 BAAI/bge、通义 text-embedding、以及任何兼容实现。
 */
async function embedViaHttp(texts, options) {
  const opts = options || {};
  const baseUrl = opts.baseUrl || envVar('EMBEDDING_BASE_URL');
  const apiKey = opts.apiKey || envVar('EMBEDDING_API_KEY');
  const model = opts.model || envVar('EMBEDDING_MODEL');
  if (!baseUrl || !apiKey || !model) {
    const err = new Error('未配置外部 embedding 服务（需要 baseUrl / apiKey / model）');
    err.retryable = false;
    throw err;
  }
  const res = await postJson(baseUrl.replace(/\/$/, '') + '/embeddings', {
    model,
    input: texts,
    encoding_format: 'float'
  }, { Authorization: 'Bearer ' + apiKey }, opts.timeout);

  if (!res || !res.data) throw new Error('embedding 服务返回格式异常');
  return res.data.map((d) => d.embedding);
}

/* ===================== 统一入口 ===================== */

let provider = 'local';
let providerOptions = {};

/** 由云函数或小程序端在启动时配置 */
function configure(options) {
  const opts = options || {};
  if (opts.provider) provider = opts.provider;
  providerOptions = opts;
  return { provider };
}

function currentProvider() {
  return provider;
}

/**
 * 生成向量
 * @param {'text'|'image'} kind
 * @param {string|object} payload
 *   - kind='text'：字符串
 *   - kind='image'：{ image, imageDescription, tokens } 或图片标识字符串
 * @returns {Promise<number[]>}
 */
async function buildVector(kind, payload) {
  if (provider === 'http') {
    const text = kind === 'text' ? String(payload || '') : String((payload && payload.imageDescription) || payload || '');
    const vecs = await embedViaHttp([text], providerOptions);
    return normalize(vecs[0]);
  }

  // local / deepseek：图像使用「语义描述」优先，其次使用图片标识线索
  if (kind === 'image') {
    const spec = typeof payload === 'object' && payload ? payload : { image: payload };
    if (spec.imageDescription) return vlm.embed('text', spec.imageDescription);
    return vlm.embed('image', spec.image);
  }
  return vlm.embed('text', String(payload || ''));
}

/** 同步版本：local 与 deepseek 模式可用，http 模式需要先在批量接口里取回 */
function buildVectorSync(kind, payload) {
  if (provider === 'http') {
    // 同步无法等待网络；降级为本地向量，保证不阻塞页面
    if (kind === 'image') {
      const spec = typeof payload === 'object' && payload ? payload : { image: payload };
      return spec.imageDescription ? vlm.embed('text', spec.imageDescription) : vlm.embed('image', spec.image);
    }
    return vlm.embed('text', String(payload || ''));
  }
  if (kind === 'image') {
    const spec = typeof payload === 'object' && payload ? payload : { image: payload };
    if (spec.imageDescription) return vlm.embed('text', spec.imageDescription);
    return vlm.embed('image', spec.image);
  }
  return vlm.embed('text', String(payload || ''));
}

/**
 * 为一条物品记录生成完整向量集合
 * @param {object} item { image, imageDescription, description, attributes }
 */
function buildItemVectors(item) {
  const it = item || {};
  const attrs = it.attributes || {};
  const textDoc = [
    it.description || '',
    attrs.category || '',
    attrs.brand || '',
    attrs.main_color || '',
    attrs.material || '',
    (attrs.features || []).join(' ')
  ].join(' ');

  const vectors = {
    text: buildVectorSync('text', textDoc),
    image: null
  };
  if (it.image) {
    vectors.image = buildVectorSync('image', {
      image: it.image,
      imageDescription: it.imageDescription || ''
    });
  }
  return vectors;
}

/** 归一化外部向量（L2），保证与本地向量同一尺度 */
function normalize(vec) {
  if (!vec || !vec.length) return [];
  let norm = 0;
  for (let i = 0; i < vec.length; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

function cosine(a, b) {
  return vlm.cosine(a, b);
}

/** 说明当前向量方案，便于在看板/日志里如实展示 */
function describe() {
  if (provider === 'http') {
    return {
      provider,
      label: '第三方 embedding 服务',
      detail: '文本与图像均使用外部向量模型（' + (providerOptions.model || '未配置') + '）'
    };
  }
  if (provider === 'deepseek') {
    return {
      provider,
      label: 'DeepSeek 视觉描述 + 本地语义指纹',
      detail: '图像经 DeepSeek 生成语义描述后编码为向量；文本使用同义词概念 + 字符 bigram 语义指纹。' +
        '这是对 CLIP 跨模态对齐的近似，不具备像素级细节匹配能力。'
    };
  }
  return {
    provider: 'local',
    label: '本地语义指纹',
    detail: '同义词概念 + 字符 bigram 哈希向量，离线可用、结果可复现；语义泛化能力弱于真实 embedding 模型。'
  };
}

module.exports = {
  EMBED_DIM_FALLBACK: vlm.EMB_DIM,
  imageSpec,
  configure,
  currentProvider,
  buildVector,
  buildVectorSync,
  buildItemVectors,
  embedViaHttp,
  cosine,
  normalize,
  describe
};
