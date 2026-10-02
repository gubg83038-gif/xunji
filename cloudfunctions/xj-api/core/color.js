/**
 * 颜色与文本工具
 * - 颜色：把“深灰 / 灰黑 / 银灰”这类日常描述映射到 RGB，用感知距离算相似度，
 *   而不是做字符串比较（对应方案 7.4 颜色“中”重要性、允许近似的设计）。
 * - 文本：中文场景用 字符 bigram + 关键词命中 的轻量语义相似度，
 *   MVP 阶段不引入外部 embedding 服务，但接口与真实向量模型保持一致（返回 0~1）。
 */

/* ============================ 颜色 ============================ */

const COLORS = {
  '黑': { rgb: [22, 22, 26], family: 'black' },
  '纯黑': { rgb: [10, 10, 12], family: 'black' },
  '亮黑': { rgb: [30, 30, 36], family: 'black' },
  '白': { rgb: [246, 246, 246], family: 'white' },
  '米白': { rgb: [240, 234, 220], family: 'white' },
  '灰': { rgb: [139, 141, 146], family: 'gray' },
  '浅灰': { rgb: [196, 199, 204], family: 'gray' },
  '银灰': { rgb: [180, 184, 190], family: 'gray' },
  '深灰': { rgb: [86, 90, 96], family: 'gray' },
  '烟灰': { rgb: [110, 114, 120], family: 'gray' },
  '灰黑': { rgb: [58, 60, 64], family: 'black' },
  '红': { rgb: [214, 45, 45], family: 'red' },
  '深红': { rgb: [150, 26, 34], family: 'red' },
  '酒红': { rgb: [122, 30, 46], family: 'red' },
  '粉': { rgb: [238, 158, 180], family: 'red' },
  '粉红': { rgb: [238, 158, 180], family: 'red' },
  '橙': { rgb: [240, 132, 40], family: 'orange' },
  '橘': { rgb: [240, 132, 40], family: 'orange' },
  '橘色': { rgb: [240, 132, 40], family: 'orange' },
  '黄': { rgb: [242, 201, 76], family: 'yellow' },
  '米黄': { rgb: [232, 214, 160], family: 'yellow' },
  '卡其': { rgb: [190, 168, 128], family: 'yellow' },
  '绿': { rgb: [56, 152, 96], family: 'green' },
  '深绿': { rgb: [30, 104, 66], family: 'green' },
  '墨绿': { rgb: [24, 74, 56], family: 'green' },
  '军绿': { rgb: [86, 100, 62], family: 'green' },
  '浅绿': { rgb: [156, 210, 168], family: 'green' },
  '薄荷绿': { rgb: [150, 214, 194], family: 'green' },
  '蓝': { rgb: [40, 96, 200], family: 'blue' },
  '深蓝': { rgb: [26, 54, 122], family: 'blue' },
  '藏蓝': { rgb: [30, 44, 88], family: 'blue' },
  '宝蓝': { rgb: [30, 90, 210], family: 'blue' },
  '浅蓝': { rgb: [136, 180, 232], family: 'blue' },
  '天蓝': { rgb: [108, 176, 232], family: 'blue' },
  '紫': { rgb: [128, 80, 190], family: 'purple' },
  '香芋紫': { rgb: [176, 148, 214], family: 'purple' },
  '棕': { rgb: [122, 84, 54], family: 'brown' },
  '咖啡': { rgb: [96, 66, 46], family: 'brown' },
  '咖色': { rgb: [96, 66, 46], family: 'brown' },
  '深棕': { rgb: [80, 54, 38], family: 'brown' },
  '浅棕': { rgb: [166, 128, 92], family: 'brown' },
  '驼色': { rgb: [190, 152, 108], family: 'brown' },
  '金': { rgb: [212, 175, 96], family: 'gold' },
  '金色': { rgb: [212, 175, 96], family: 'gold' },
  '银': { rgb: [190, 194, 200], family: 'gray' },
  '银色': { rgb: [190, 194, 200], family: 'gray' },
  '透明': { rgb: [228, 234, 240], family: 'clear' },
  '彩色': { rgb: [180, 160, 200], family: 'multi' },
  '花色': { rgb: [180, 160, 200], family: 'multi' },
  '多色': { rgb: [180, 160, 200], family: 'multi' }
};

// 长词优先，避免“深灰”被“灰”抢先匹配
const COLOR_WORDS = Object.keys(COLORS).sort((a, b) => b.length - a.length);

const LIGHT_MODIFIERS = ['浅', '淡', '亮', '嫩'];
const DARK_MODIFIERS = ['深', '暗', '墨', '浓'];

/** 从文字中解析颜色，返回标准色名与 RGB */
function parseColor(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  for (let i = 0; i < COLOR_WORDS.length; i += 1) {
    const word = COLOR_WORDS[i];
    const idx = raw.indexOf(word);
    if (idx >= 0) {
      const entry = COLORS[word];
      return { name: word, rgb: entry.rgb.slice(), family: entry.family, light: false, dark: false };
    }
  }
  // 只给出修饰词（如“浅色”“深色”）
  if (LIGHT_MODIFIERS.some((m) => raw.indexOf(m) === 0)) {
    return { name: raw, rgb: [196, 199, 204], family: 'gray', light: true, dark: false, vague: true };
  }
  if (DARK_MODIFIERS.some((m) => raw.indexOf(m) === 0)) {
    return { name: raw, rgb: [70, 74, 80], family: 'gray', light: false, dark: true, vague: true };
  }
  return null;
}

/** 颜色名列表（用于展示标签），保留用户原词 */
function colorTags(attr) {
  const tags = [];
  if (attr && attr.main_color) tags.push(attr.main_color);
  if (attr && attr.secondary_color) tags.push(attr.secondary_color);
  return tags;
}

function rgbDistance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/**
 * 颜色相似度
 * @returns {{score:number, relation:'一致'|'近似'|'差异'|'未知', detail:string, distance:number}}
 */
function colorSimilarity(aText, bText) {
  const a = parseColor(aText);
  const b = parseColor(bText);
  if (!a || !b) {
    if (!a && !b) return { score: 0, relation: '未知', detail: '双方均未提供颜色', distance: null };
    return { score: 0, relation: '未知', detail: '一方未提供颜色', distance: null };
  }
  const d = rgbDistance(a.rgb, b.rgb);
  const sameFamily = a.family === b.family;

  // 相似度：感知距离用不同尺度衰减；跨色族之间再乘一个折损系数
  // （黑/灰这类低饱和邻接色族只轻度折损，红/蓝这类跨色族大幅折损）
  const raw = d <= 60 ? Math.exp(-d / 150) : Math.exp(-d / 105);
  const crossPenalty = sameFamily ? 1 : (Math.abs(a.rgb[0] - b.rgb[0]) < 60 && Math.abs(a.rgb[2] - b.rgb[2]) < 60 ? 0.82 : 0.5);
  const score = raw * crossPenalty;

  // 颜色关系判定：区分“一致 / 近似 / 差异”
  let relation;
  if (a.name === b.name && d < 20) relation = '一致';
  else if (d <= 60) relation = '近似';
  else if (d <= 100) relation = score >= 0.4 ? '近似' : '差异';
  else relation = '差异';

  let detail;
  if (relation === '一致') detail = '均为' + a.name;
  else if (relation === '近似') detail = a.name + ' 与 ' + b.name + '，肉眼相近';
  else detail = a.name + ' 与 ' + b.name + ' 差异明显';

  return { score, relation, detail, distance: d };
}

/* ============================ 文本 ============================ */

const STOP_WORDS = ['的', '了', '是', '在', '和', '与', '有', '一个', '一只', '一把', '一件', '大概', '好像', '有点', '非常', '很', '然后', '就', '都', '也', '被', '把', '着', '过', '我', '他', '她', '它', '这', '那', '个', '只', '把', '请问', '谢谢'];

/** 领域同义词归一：把不同表达映射到同一概念，缓解“描述不一致”问题 */
const SYNONYMS = [
  ['保温杯', '水杯', '杯子', '马克杯', '保温壶', '杯'],
  ['耳机', '蓝牙耳机', '无线耳机', 'airpods', 'airpod', 'earbuds', '耳塞'],
  ['耳机盒', '充电盒', '充电仓', '耳机仓', 'airpods盒'],
  ['雨伞', '伞', '折叠伞', '遮阳伞', '长柄伞'],
  ['背包', '书包', '双肩包', '电脑包', '帆布包'],
  ['钱包', '钱夹', '卡包'],
  ['钥匙', '钥匙串', '钥匙扣', '门禁卡'],
  ['学生卡', '校园卡', '一卡通', '饭卡', '学生证'],
  ['身份证', '证件', '银行卡'],
  ['充电器', '充电头', '电源适配器', '数据线', '充电线'],
  ['充电宝', '移动电源'],
  ['眼镜', '近视镜', '墨镜', '镜框'],
  ['手表', '手环', '智能手表', '运动手环'],
  ['笔记本', '电脑', '平板', 'ipad', 'laptop'],
  ['书', '教材', '课本', '笔记', '本子', '笔记本子'],
  ['笔', '签字笔', '钢笔', '铅笔', '笔袋', '文具盒'],
  ['口罩', '雨衣', '手套', '围巾', '帽子'],
  ['金属', '不锈钢', '铝合金', '铁', '钢'],
  ['塑料', '硅胶', '树脂', '亚克力'],
  ['木质', '木头', '木'],
  ['皮革', '真皮', 'pu', '牛皮']
];

const CANON = {};
SYNONYMS.forEach((group, gi) => {
  group.forEach((word) => { CANON[word] = 'C' + gi; });
});

const TOKEN_CACHE = {};
const TOKEN_CACHE_MAX = 800;

function tokenize(text) {
  const key = String(text || '');
  if (TOKEN_CACHE[key]) return TOKEN_CACHE[key];
  const result = tokenizeUncached(key);
  // 演示数据量不大，做一个带上限的简单缓存，避免同一文本被反复切词
  const keys = Object.keys(TOKEN_CACHE);
  if (keys.length >= TOKEN_CACHE_MAX) delete TOKEN_CACHE[keys[0]];
  TOKEN_CACHE[key] = result;
  return result;
}

function tokenizeUncached(text) {
  const src = String(text || '')
    .toLowerCase()
    .replace(/[\s,，。、；;：:！!？?（）()《》"'“”‘’\-—_/\\|+*#@￥$%^&~`\[\]{}<>]/g, '');
  const tokens = new Set();
  if (!src) return tokens;

  // 英文/数字词
  const latin = src.match(/[a-z0-9]+/g) || [];
  latin.forEach((w) => { if (w.length > 1) tokens.add(w); });

  // 同义词概念
  Object.keys(CANON).forEach((word) => {
    if (src.indexOf(word) >= 0) tokens.add(CANON[word]);
  });

  // 中文 bigram
  const cjk = src.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i + 1 < cjk.length; i += 1) {
    const bg = cjk.substr(i, 2);
    if (STOP_WORDS.indexOf(bg) < 0) tokens.add(bg);
  }
  // 单字兜底，保证极短描述也能比较
  if (cjk.length <= 2) {
    for (let i = 0; i < cjk.length; i += 1) tokens.add(cjk[i]);
  }
  return tokens;
}

/** 语义相似度（0~1）：Dice 系数 + 概念命中加权 */
function textSimilarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.size || !tb.size) return { score: 0, shared: [] };
  let inter = 0;
  const shared = [];
  ta.forEach((t) => {
    if (tb.has(t)) {
      inter += 1;
      if (t.charAt(0) === 'C') shared.push(t);
    }
  });
  const dice = (2 * inter) / (ta.size + tb.size);
  // 概念命中奖励：命中的同义概念越多，越说明说的是同一种东西
  const conceptBonus = Math.min(0.18, shared.length * 0.06);
  return { score: Math.min(1, dice + conceptBonus), shared };
}

/** 从自由文本中抽取品牌候选 */
const BRAND_LIST = [
  '膳魔师', 'thermos', '象印', '虎牌', '富光', '希诺', '哈尔斯', '乐扣', 'lock&lock',
  '小米', 'xiaomi', '华为', 'huawei', '苹果', 'apple', 'airpods', '索尼', 'sony', 'jbl',
  '漫步者', 'edifier', 'bose', 'beats', '三星', 'samsung', 'oppo', 'vivo', '荣耀', 'honor',
  '联想', 'lenovo', '戴尔', 'dell', '惠普', 'hp', '华硕', 'asus', '宏碁', 'acer',
  '安踏', 'anta', '李宁', 'lining', '耐克', 'nike', '阿迪达斯', 'adidas', '彪马', 'puma',
  '优衣库', 'uniqlo', '名创优品', 'miniso', '晨光', 'm&g', '得力', 'deli', '斑马', 'zebra',
  '南极人', '稻草人', 'herschel', 'jansport', '新秀丽', 'samsonite', '瑞士军刀', 'victorinox'
];

function extractBrand(text) {
  const src = String(text || '').toLowerCase();
  const hit = BRAND_LIST.find((b) => src.indexOf(b.toLowerCase()) >= 0);
  if (!hit) return '';
  // 归一成规范写法
  return hit.charAt(0).toUpperCase() + hit.slice(1);
}

module.exports = {
  COLORS,
  parseColor,
  colorTags,
  colorSimilarity,
  rgbDistance,
  tokenize,
  textSimilarity,
  extractBrand,
  BRAND_LIST
};
