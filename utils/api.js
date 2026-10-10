/**
 * 客户端 API 层
 * ---------------------------------------------------------------
 * 唯一职责：把「业务动作」映射到具体的后端实现。
 *
 *   cloudReady() === true   → 云端模式：云函数 xj-api / xj-ai
 *   cloudReady() === false  → 本地模式：直接调用 utils/service.js（离线演示）
 *
 * 页面永远只调用 utils/service.js，不直接使用本文件，
 * 因此「切后端」这件事对页面完全透明。
 */

const config = require('../core/config');
const identity = require('../core/identity');

const api = {};

/* ===================== 云开发初始化 ===================== */

let cloudInited = false;
let cloudFailed = false;

function ensureCloudInit() {
  if (cloudInited || cloudFailed) return !cloudFailed;
  if (!config.cloudReady()) {
    cloudFailed = true;
    return false;
  }
  if (typeof wx === 'undefined' || !wx.cloud) {
    console.warn('[寻迹] 当前环境不支持 wx.cloud，已退回本地模式');
    cloudFailed = true;
    return false;
  }
  try {
    wx.cloud.init({ env: config.cloud.envId, traceUser: true });
    cloudInited = true;
    return true;
  } catch (e) {
    console.error('[寻迹] 云开发初始化失败：', e);
    cloudFailed = true;
    return false;
  }
}

function isCloud() {
  return config.cloudReady() && ensureCloudInit();
}

/**
 * 归一 payload。
 *
 * 注意语义分工：
 *   · `payload.userId` 是**读数据用的 persona**（「以谁的身份在看」），
 *     例如 claim.mine 返回谁的认领记录、item.list 决定 hasImage/isOwner 文案。
 *     它**不参与任何鉴权**。
 *   · 真正的调用方身份放在 event 顶层（见 identityEnvelope），
 *     服务端只认它，客户端传什么都改不了。
 *
 * 早期版本把两者混成一个 payload.userId，服务端又直接信任它，
 * 等于调用方自己声明「我是谁」——`item.update` / `item.remove` / `claim.get`
 * 的所有权校验形同虚设。现在彻底分开：
 * 演示要「以拾物者身份看核验页」时用 globalData 切全局身份（demoUserId），
 * 不去篡改 payload。
 */
function withIdentity(payload) {
  return Object.assign({}, payload || {});
}

/** 调用方身份（放在 event 顶层，与 payload 分离，语义不同） */
function identityEnvelope(userId) {
  return userId ? { demoUserId: userId } : {};
}

/* ===================== 云函数调用 ===================== */

/**
 * 调用 xj-api
 * @param {string} action
 * @param {object} payload
 */
function callApi(action, payload) {
  return new Promise((resolve, reject) => {
    if (!isCloud()) {
      reject(new Error('云开发未启用'));
      return;
    }
    wx.cloud.callFunction({
      name: config.cloud.functions.api,
      data: Object.assign(
        { action, payload: withIdentity(payload) },
        identityEnvelope(identity.currentUserId())
      ),
      config: { timeout: config.cloud.timeout }
    }).then((res) => {
      const r = res && res.result;
      if (!r) {
        reject(new Error('云函数返回为空'));
        return;
      }
      if (r.ok) resolve(r.data);
      else reject(Object.assign(new Error((r.error && r.error.message) || '云函数执行失败'), {
        code: r.error && r.error.code,
        detail: r
      }));
    }).catch((e) => {
      reject(Object.assign(new Error('云函数调用失败：' + (e.errMsg || e.message || '未知原因')), {
        raw: e, code: e.code, detail: e.detail
      }));
    });
  });
}

/** 调用 xj-ai */
function callAi(action, payload) {
  return new Promise((resolve, reject) => {
    if (!isCloud()) {
      reject(new Error('云开发未启用'));
      return;
    }
    wx.cloud.callFunction({
      name: config.cloud.functions.ai,
      data: { action, payload: payload || {} },
      config: { timeout: config.cloud.timeout }
    }).then((res) => {
      const r = res && res.result;
      if (r && r.ok) resolve(r.data);
      else reject(new Error((r && r.error && r.error.message) || 'AI 调用失败'));
    }).catch((e) => {
      reject(Object.assign(new Error('AI 云函数调用失败：' + (e.errMsg || e.message || '未知原因')), { raw: e }));
    });
  });
}

/**
 * 统一的业务调用：云端失败时自动退回本地实现
 * @param {string} action 云函数 action
 * @param {object} payload
 * @param {Function} localFallback 本地实现（返回同步结果）
 */
async function invoke(action, payload, localFallback) {
  if (isCloud()) {
    try {
      return await callApi(action, payload);
    } catch (e) {
      console.error('[寻迹] 云端调用 ' + action + ' 失败，降级本地实现：', e.message);
      wx.showToast({ title: '云端不可用，已切换离线模式', icon: 'none', duration: 2000 });
    }
  }
  if (typeof localFallback !== 'function') throw new Error('缺少本地实现：' + action);
  return localFallback();
}

/* ===================== AI 能力 ===================== */

/**
 * 结构化属性提取
 * @param {object} input { image, imageBase64, imageFileId, imageUrl, mimeType, description, type, detail }
 * @param {Function} localFallback 返回 vlm.extractAttributes 的结果
 */
async function extractAttributes(input, localFallback) {
  const p = input || {};
  const imageSpec = require('../core/image-spec');

  /**
   * 演示图库短路：不调模型，直接给内置线索。
   *
   * ⚠ 必须在「空输入门禁」之前判断。
   *   演示图（demo://xxx）不是可上传的图片资源，但从业务上看它**是有效输入**。
   *   如果先跑门禁，它会被判成「没有图片」而错误地走本地兜底，
   *   失去内置线索（也就拿不到高置信度的演示属性）。
   */
  if (!p.imageBase64 && imageSpec.get(p.image)) {
    const spec = imageSpec.get(p.image);
    return {
      attributes: Object.assign({ category: spec.category }, spec.hints),
      confidence: {},
      sources: Object.keys(spec.hints).reduce((acc, k) => { acc[k] = 'demo'; return acc; }, {}),
      description: '',
      model: 'demo-hints'
    };
  }

  /**
   * 空输入直接走本地规则，不发云函数。
   *
   * 真实现象：发布页 onLoad 会调一次 recompute()，那时用户还没选图也没填描述，
   * 于是发出去一个空 payload。云函数按设计拒绝（「需要提供图片或文字描述」），
   * 客户端打出一条红色 error 再降级——功能没坏，但控制台噪音很大，
   * 而且白白浪费一次云函数调用。
   */
  const hasRealImage = !!(p.imageBase64 || p.imageFileId || p.imageUrl);
  const hasDescription = !!(p.description && String(p.description).trim());
  if (!hasRealImage && !hasDescription) {
    return localFallback();
  }

  if (isCloud() && config.aiReady()) {
    try {
      return await callAi('ai.extract', p);
    } catch (e) {
      console.error('[寻迹] AI 属性提取失败，降级本地规则：', e.message);
    }
  }
  return localFallback();
}

/** 读取本地文件为 base64（云函数调用用） */
function readFileBase64(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const fs = wx.getFileSystemManager();
      fs.readFile({
        filePath,
        encoding: 'base64',
        success: (res) => resolve(res.data),
        fail: (e) => reject(new Error('读取图片失败：' + (e.errMsg || '')))
      });
    } catch (e) {
      reject(e);
    }
  });
}

/** 检查 AI 服务状态（用于设置页与答辩前自检） */
async function aiHealth() {
  if (!isCloud()) {
    return { ready: false, mode: 'local', message: '未启用云开发，使用本地规则提取属性' };
  }
  try {
    const r = await callAi('ai.health', {});
    return Object.assign({ mode: 'cloud' }, r);
  } catch (e) {
    return { ready: false, mode: 'cloud', message: e.message };
  }
}

/* ===================== 系统与演示数据 ===================== */

function systemInit() {
  return callApi('system.init', {});
}

function seedDemo(reset) {
  return callApi('seed.demo', { reset: !!reset });
}

function getServerConfig() {
  return callApi('config.get', {});
}

/* ===================== 数据同步（镜像） ===================== */

/**
 * 一次性拉取客户端渲染所需的全部数据，写入本地镜像。
 * 这样页面读取仍然是同步的（离线体验），写操作再提交到云端。
 */
async function fetchSnapshot(userId) {
  const [items, matches, claims, notifications, users] = await Promise.all([
    callApi('item.list', {}),
    callApi('match.all', {}),
    callApi('claim.mine', { userId }),
    callApi('notify.list', { userId }),
    callApi('user.me', { userId })
  ]);
  return {
    items: (items && items.items) || [],
    matches: (matches && matches.matches) || [],
    claims: (claims && claims.claims) || [],
    notifications: (notifications && notifications.notifications) || [],
    users: (users && users.users) || []
  };
}

module.exports = {
  isCloud,
  ensureCloudInit,
  callApi,
  callAi,
  invoke,
  extractAttributes,
  readFileBase64,
  aiHealth,
  systemInit,
  seedDemo,
  getServerConfig,
  fetchSnapshot
};
