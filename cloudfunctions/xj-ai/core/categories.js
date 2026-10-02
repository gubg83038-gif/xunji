/**
 * 物品类别体系与结构化属性定义
 * 对应方案 6.1“建议的结构化属性字段”与 6.6“防冒领核验”的物品级隐藏特征建议。
 */

const CATEGORIES = [
  {
    key: 'cup', name: '水杯/保温杯', icon: '🥤', aliases: ['水杯', '保温杯', '杯子', '马克杯', '杯', '水壶', '保温壶'],
    materialHints: ['金属', '不锈钢', '塑料', '玻璃', '木质'],
    privateFeatures: ['杯底划痕/磨损', '杯内贴纸或刻字', '杯盖内侧特征', '杯身个性化贴纸', '购买时附赠的配件'],
    colorHints: ['深灰', '灰黑', '银灰', '黑色', '白色', '蓝色']
  },
  {
    key: 'umbrella', name: '雨伞', icon: '☂️', aliases: ['雨伞', '伞', '折叠伞', '遮阳伞', '长柄伞', '自动伞'],
    materialHints: ['金属', '塑料', '木质', '尼龙'],
    privateFeatures: ['伞柄材质与形状', '伞面某处破损/污渍', '伞套是否还在', '伞骨颜色'],
    colorHints: ['黑色', '深蓝', '格子', '墨绿', '透明']
  },
  {
    key: 'earphone', name: '耳机/耳机盒', icon: '🎧', aliases: ['耳机', '蓝牙耳机', '无线耳机', 'airpods', '耳机盒', '充电仓', '耳塞'],
    materialHints: ['塑料', '硅胶', '金属'],
    privateFeatures: ['保护壳图案或文字', '耳机盒内侧贴纸', '序列号后几位（自愿提供）', '单只耳机上的划痕'],
    colorHints: ['白色', '黑色', '浅蓝', '粉色']
  },
  {
    key: 'key', name: '钥匙/门禁卡', icon: '🔑', aliases: ['钥匙', '钥匙串', '钥匙扣', '门禁卡', '校园卡扣'],
    materialHints: ['金属', '塑料', '皮革'],
    privateFeatures: ['共有几把钥匙及用途', '钥匙扣的形状/挂件', '钥匙齿形特征', '门禁卡上的编号后几位'],
    colorHints: ['银色', '金色', '黑色']
  },
  {
    key: 'bag', name: '背包/手提包', icon: '🎒', aliases: ['背包', '书包', '双肩包', '电脑包', '手提包', '帆布包', '单肩包'],
    materialHints: ['帆布', '皮革', '尼龙', '塑料'],
    privateFeatures: ['包内主要物品', '内侧姓名贴或标签', '特殊挂件/挂饰', '拉链头特征'],
    colorHints: ['黑色', '深蓝', '灰色', '卡其', '军绿']
  },
  {
    key: 'card', name: '证件/卡片', icon: '🪪', aliases: ['学生卡', '校园卡', '一卡通', '饭卡', '身份证', '证件', '银行卡', '学生证'],
    materialHints: ['塑料', '纸质'],
    privateFeatures: ['卡面编号后四位（自愿提供）', '卡套样式', '卡上照片特征', '绑定姓名（仅用于人工核对）'],
    colorHints: ['蓝色', '白色', '红色']
  },
  {
    key: 'device', name: '电子设备', icon: '📱', aliases: ['手机', '平板', 'ipad', '笔记本电脑', '充电宝', '移动电源', '电子书', 'kindle'],
    materialHints: ['金属', '玻璃', '塑料'],
    privateFeatures: ['锁屏壁纸内容', '机身某处划痕/磕碰', '设备序列号后几位（自愿提供）', '保护壳图案'],
    colorHints: ['银色', '深灰', '黑色', '金色']
  },
  {
    key: 'charger', name: '充电器/数据线', icon: '🔌', aliases: ['充电器', '充电头', '数据线', '充电线', '电源适配器', 'type-c线', '转接头'],
    materialHints: ['塑料', '金属'],
    privateFeatures: ['线材上的缠绕方式/胶带标记', '插头上的贴纸', '线长与接口类型', '接头处的磨损'],
    colorHints: ['白色', '黑色']
  },
  {
    key: 'glasses', name: '眼镜', icon: '👓', aliases: ['眼镜', '近视镜', '墨镜', '镜框', '太阳镜'],
    materialHints: ['金属', '塑料', '板材'],
    privateFeatures: ['镜腿内侧刻字/度数', '镜片上的划痕', '镜盒颜色与品牌', '鼻托磨损情况'],
    colorHints: ['黑色', '金色', '银色', '棕色']
  },
  {
    key: 'watch', name: '手表/手环', icon: '⌚', aliases: ['手表', '手环', '智能手表', '运动手环', '腕表'],
    materialHints: ['金属', '硅胶', '皮革'],
    privateFeatures: ['表带内侧磨损/刻字', '表盘表盘贴膜状况', '配对手机型号（自愿提供）', '表扣特征'],
    colorHints: ['黑色', '银色', '金色']
  },
  {
    key: 'book', name: '书籍/笔记本', icon: '📚', aliases: ['书', '教材', '课本', '笔记', '本子', '练习册', '专业书'],
    materialHints: ['纸质'],
    privateFeatures: ['扉页姓名/学号', '书中的笔记笔迹', '夹在书中的物品', '书脊破损位置'],
    colorHints: ['蓝色', '白色', '绿色', '红色']
  },
  {
    key: 'stationery', name: '文具/笔袋', icon: '✏️', aliases: ['笔', '签字笔', '钢笔', '铅笔', '笔袋', '文具盒', '橡皮', '尺子'],
    materialHints: ['塑料', '金属', '布'],
    privateFeatures: ['笔袋内物品清单', '笔身刻字或贴纸', '钢笔笔尖型号', '笔袋拉链头'],
    colorHints: ['黑色', '透明', '蓝色']
  },
  {
    key: 'cloth', name: '衣物/配饰', icon: '🧣', aliases: ['衣服', '外套', '围巾', '帽子', '手套', '口罩', '卫衣'],
    materialHints: ['棉', '羊毛', '化纤', '皮革'],
    privateFeatures: ['内衬标签/尺码', '污渍或破损位置', '口袋内物品', '刺绣字母'],
    colorHints: ['黑色', '灰色', '米白', '卡其']
  },
  {
    key: 'sport', name: '运动器材', icon: '🏸', aliases: ['球拍', '羽毛球拍', '篮球', '足球', '跳绳', '护腕', '球'],
    materialHints: ['碳素', '塑料', '橡胶', '皮革'],
    privateFeatures: ['拍柄缠绕方式/手胶颜色', '球上写的名字', '器材上的贴纸', '磨损部位'],
    colorHints: ['黑色', '红色', '蓝色']
  },
  {
    key: 'other', name: '其他物品', icon: '📦', aliases: [],
    materialHints: ['金属', '塑料', '布', '纸质', '木质'],
    privateFeatures: ['内部特征或刻字', '明显磨损/痕迹', '附带的小物件', '特殊气味或标记'],
    colorHints: ['黑色', '白色', '灰色']
  }
];

const CATEGORY_MAP = {};
CATEGORIES.forEach((c) => {
  CATEGORY_MAP[c.key] = c;
  c.aliases.forEach((a) => { CATEGORY_MAP['alias:' + a] = c; });
});

function list() {
  return CATEGORIES.slice();
}

function get(key) {
  return CATEGORY_MAP[key] || CATEGORY_MAP.other;
}

function nameOf(key) {
  return get(key).name;
}

function iconOf(key) {
  return get(key).icon;
}

/** 用关键词猜测类别（文字输入 → 类别） */
function guessFromText(text) {
  const src = String(text || '').toLowerCase();
  if (!src) return 'other';
  let best = 'other';
  let bestLen = 0;
  CATEGORIES.forEach((c) => {
    const words = c.aliases.concat([c.name]);
    words.forEach((w) => {
      if (w.length > bestLen && src.indexOf(w.toLowerCase()) >= 0) {
        best = c.key;
        bestLen = w.length;
      }
    });
  });
  return best;
}

/** 类别的“区别度”：个性特征越强的类别，属性权重越高（方案 6.5 阈值可按类别区别设置） */
const CATEGORY_PROFILE = {
  cup: { attrBoost: 1.06, timeTau: 6, geoSigma: 260, threshold: 0.72 },
  umbrella: { attrBoost: 1.0, timeTau: 12, geoSigma: 320, threshold: 0.74 },
  earphone: { attrBoost: 1.08, timeTau: 5, geoSigma: 220, threshold: 0.72 },
  key: { attrBoost: 1.12, timeTau: 8, geoSigma: 280, threshold: 0.7 },
  bag: { attrBoost: 1.05, timeTau: 8, geoSigma: 300, threshold: 0.7 },
  card: { attrBoost: 1.15, timeTau: 6, geoSigma: 250, threshold: 0.66 },
  device: { attrBoost: 1.1, timeTau: 4, geoSigma: 240, threshold: 0.7 },
  charger: { attrBoost: 0.94, timeTau: 10, geoSigma: 320, threshold: 0.78 },
  glasses: { attrBoost: 1.08, timeTau: 8, geoSigma: 260, threshold: 0.72 },
  watch: { attrBoost: 1.12, timeTau: 5, geoSigma: 240, threshold: 0.7 },
  book: { attrBoost: 0.98, timeTau: 14, geoSigma: 340, threshold: 0.76 },
  stationery: { attrBoost: 0.92, timeTau: 12, geoSigma: 340, threshold: 0.8 },
  cloth: { attrBoost: 0.96, timeTau: 12, geoSigma: 340, threshold: 0.78 },
  sport: { attrBoost: 1.0, timeTau: 10, geoSigma: 320, threshold: 0.75 },
  other: { attrBoost: 1.0, timeTau: 10, geoSigma: 320, threshold: 0.76 }
};

function profile(key) {
  return CATEGORY_PROFILE[key] || CATEGORY_PROFILE.other;
}

module.exports = {
  CATEGORIES,
  list,
  get,
  nameOf,
  iconOf,
  guessFromText,
  profile
};
