/**
 * 全局配置（小程序端与云函数端共用）
 * ---------------------------------------------------------------
 * ⚠ 重要：DeepSeek API Key 绝对不能写在小程序端。
 *    小程序代码包可被反编译，客户端里的任何 Key 都等于公开。
 *    Key 的正确位置是「云函数的环境变量」，见 cloudfunctions/README 或本文件 cloud.ai 段。
 *
 * 小程序端只读这里的 cloud 段；云函数端读 cloud 段 + ai 段。
 */

const config = {
  /* ---------------- 云开发 ---------------- */
  cloud: {
    /** 是否启用云开发后端。false 时自动退回本地 Mock 数据层（离线演示仍可用） */
    enabled: true,

    /**
     * 微信云开发环境 ID。
     * 在开发者工具 → 云开发 → 设置 → 环境 ID 中查看。
     *
     * 当前值由用户提供：cloud1-d1g8bdwcp51d8918d
     * 注意：环境 ID 不是密钥，写在这里是安全的；
     *      但 DeepSeek 的 API Key 绝不能写进小程序端（见本文件顶部说明）。
     */
    envId: 'cloud1-d1g8bdwcp51d8918d',

    /** 云函数名，需与 cloudfunctions/ 下目录名一致 */
    functions: {
      api: 'xj-api',      // 统一业务网关：物品 CRUD、匹配、认领、统计、灌演示数据
      ai: 'xj-ai'         // AI 能力：DeepSeek 视觉属性提取与图像语义描述（持有 API Key）
    },

    /** 单次云函数调用超时（毫秒） */
    timeout: 20000
  },

  /* ---------------- AI 能力 ---------------- */
  ai: {
    /**
     * provider 取值：'local' | 'deepseek'
     * - local：不联网，使用内置文本抽取 + 本地语义指纹向量（离线演示、无 Key 时使用）
     * - deepseek：调用 DeepSeek 视觉模型提取结构化属性并生成图像语义描述
     *
     * 已切换为 'deepseek'。生效前提（缺一即自动降级为本地规则）：
     *   1. 云函数 xj-ai 的环境变量里配好 DEEPSEEK_API_KEY —— 已配置
     *   2. 已重新部署 xj-ai（环境变量改动需重启实例才生效）—— 已部署
     *   3. 云函数 xj-ai 的执行超时建议 60 秒（默认 3 秒会超时）—— 已改为 60 秒
     *
     * 降级是设计好的容错：Key 失效或模型超时不会中断发布流程，
     * 只在发布页提示「AI 服务暂不可用，已使用本地规则提取」。
     * 验证是否真的生效：发布页属性区显示「属性由 deepseek-flash 视觉模型识别」。
     */
    provider: 'deepseek',

    /**
     * 是否用「图像语义描述向量」代替真实 CLIP 图像向量。
     * 由于 DeepSeek 未提供 embedding 接口，图像模态采用
     * 「视觉模型生成结构化属性 + 语义描述」→「对描述做向量化」的近似方案，
     * 与 CLIP 的跨模态对齐思路一致（图 → 同一语义空间）。
     * 若你后续接入 CLIP/SigLIP 自建服务，把它设为 false 并实现 core/ai/embed.js 的 image provider。
     */
    imageVectorByDescription: true,

    /** 是否把 AI 提取结果缓存进数据库，避免重复计费（强烈建议开启） */
    cacheAttributes: true
  },

  /* ---------------- 匹配引擎 ---------------- */
  match: {
    /** 第一阶段粗召回候选数（真实 pgvector 场景对应 ANN 的 top-k） */
    recallSize: 50,
    /** 第二阶段重排后返回的 Top-K */
    topK: 20,
    /** 低于该分数不落库，避免候选列表噪音 */
    persistMinScore: 0.32
  },

  /* ---------------- 地点库 ---------------- */
  campus: {
    /** 校园地点库版本号：修改 core/locations.js 后请递增，云端会提示重建索引 */
    version: 1,
    /** 是否允许在发布页用地图拾取自定义坐标（用于现场校正地点库） */
    allowPickCoordinate: true
  }
};

/** 云开发是否可用 */
function cloudReady() {
  return !!(config.cloud.enabled && config.cloud.envId);
}

/** AI 是否走真实模型 */
function aiReady() {
  return config.ai.provider === 'deepseek';
}

module.exports = {
  config,
  cloudReady,
  aiReady,
  get cloud() { return config.cloud; },
  get ai() { return config.ai; },
  get match() { return config.match; },
  get campus() { return config.campus; }
};
