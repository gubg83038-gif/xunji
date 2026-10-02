/**
 * 演示图片规格（小程序端与云函数端共用，纯数据 + 纯函数，无平台依赖）
 * ---------------------------------------------------------------
 * 离线演示时无法真实上传照片，这里为每条演示记录提供一张「装置化」图片标识
 * （demo://<key>），并带上类别 / 颜色 / 材质等线索。
 *
 * 这样做的价值：
 *  - 属性提取结果稳定可复现，答辩演示不会因为网络或模型波动而出错；
 *  - 图像模态能给出有意义的相似度，消融实验才有区分度。
 *
 * 真机演示建议替换成自己拍摄的照片；接入真实 VLM 后这些 hints 不再参与属性
 * 提取（只有 provider=local 时才用），但仍可保留作为兜底。
 */

const LIBRARY = [
  { key: 'cup_metal_gray', label: '深灰金属保温杯', category: 'cup',
    hints: { main_color: '深灰', secondary_color: '黑色', material: '金属', logo_text: '白色纵向文字Logo', shape: '圆柱形' },
    keywords: ['灰色', '金属', 'logo', '杯子'] },
  { key: 'cup_black_matte', label: '黑色磨砂保温杯', category: 'cup',
    hints: { main_color: '黑', secondary_color: '黑色', material: '金属', shape: '圆柱形', pattern: '纯色' },
    keywords: ['黑色', '磨砂', '保温杯'] },
  { key: 'cup_plastic_clear', label: '透明塑料水壶', category: 'cup',
    hints: { main_color: '透明', secondary_color: '蓝色', material: '塑料', shape: '圆柱形' },
    keywords: ['透明', '塑料', '水壶'] },
  { key: 'umbrella_black', label: '黑色折叠伞', category: 'umbrella',
    hints: { main_color: '黑', material: '金属', shape: '折叠' },
    keywords: ['黑色', '伞', '折叠'] },
  { key: 'umbrella_blue', label: '深蓝色折叠伞', category: 'umbrella',
    hints: { main_color: '深蓝', material: '塑料', shape: '折叠', accessory: '带伞套' },
    keywords: ['深蓝色', '折叠伞'] },
  { key: 'earphone_white_case', label: '白色耳机盒（带保护壳）', category: 'earphone',
    hints: { main_color: '白', secondary_color: '浅蓝', material: '塑料', accessory: '带保护壳' },
    keywords: ['白色', '耳机盒', '硅胶壳'] },
  { key: 'earphone_white_plain', label: '白色耳机盒（无保护壳）', category: 'earphone',
    hints: { main_color: '白', material: '塑料', shape: '椭圆形', logo_text: '小Logo' },
    keywords: ['白色', '耳机盒'] },
  { key: 'earphone_black_case', label: '黑色耳机充电盒', category: 'earphone',
    hints: { main_color: '黑', material: '塑料', shape: '椭圆形' },
    keywords: ['黑色', '耳机盒'] },
  { key: 'key_duck', label: '钥匙串（带小鸭挂件）', category: 'key',
    hints: { main_color: '银', secondary_color: '黄', material: '金属', accessory: '带黄色小鸭挂件' },
    keywords: ['钥匙', '挂件', '银色'] },
  { key: 'card_blue', label: '蓝色校园卡（带卡套）', category: 'card',
    hints: { main_color: '蓝', material: '塑料', accessory: '带卡套' },
    keywords: ['蓝色', '校园卡', '卡套'] },
  { key: 'bag_blue', label: '深蓝色帆布双肩包', category: 'bag',
    hints: { main_color: '深蓝', secondary_color: '灰', material: '帆布', shape: '方形' },
    keywords: ['深蓝色', '帆布', '双肩包'] },
  { key: 'glasses_black', label: '黑色细框眼镜', category: 'glasses',
    hints: { main_color: '黑', material: '金属', shape: '椭圆形' },
    keywords: ['黑色', '眼镜', '金属框'] },
  { key: 'watch_black', label: '黑色运动手环', category: 'watch',
    hints: { main_color: '黑', material: '硅胶', shape: '长方形' },
    keywords: ['黑色', '手环', '硅胶'] },
  { key: 'charger_white', label: '白色充电头 + 数据线', category: 'charger',
    hints: { main_color: '白', material: '塑料' },
    keywords: ['白色', '充电器', '数据线'] },
  { key: 'book_blue', label: '蓝色封面教材', category: 'book',
    hints: { main_color: '蓝', material: '纸质', shape: '长方形' },
    keywords: ['蓝色', '教材', '书'] },
  { key: 'stationery_black', label: '黑色笔袋', category: 'stationery',
    hints: { main_color: '黑', material: '布', shape: '长方形' },
    keywords: ['黑色', '笔袋', '文具'] },
  { key: 'device_black', label: '黑色充电宝', category: 'device',
    hints: { main_color: '黑', material: '塑料', shape: '长方形' },
    keywords: ['黑色', '充电宝'] },
  { key: 'cloth_gray', label: '灰色卫衣', category: 'cloth',
    hints: { main_color: '灰', material: '棉', shape: '不规则' },
    keywords: ['灰色', '卫衣', '外套'] },
  { key: 'sport_racket', label: '羽毛球拍', category: 'sport',
    hints: { main_color: '黑', secondary_color: '红色', material: '碳素' },
    keywords: ['黑色', '球拍', '羽毛球'] }
];

const LIB_MAP = {};
LIBRARY.forEach((x) => { LIB_MAP[x.key] = x; });

const PREFIX = 'demo://';

function list() {
  return LIBRARY.slice();
}

function get(key) {
  if (!key) return null;
  const k = String(key).indexOf(PREFIX) === 0 ? String(key).slice(PREFIX.length) : String(key);
  return LIB_MAP[k] || null;
}

function isDemo(image) {
  return String(image || '').indexOf(PREFIX) === 0;
}

/** demo 键名 → 完整图片标识；已是完整标识则原样返回 */
function toImageId(key) {
  if (!key) return '';
  return isDemo(key) ? key : PREFIX + key;
}

/** 图片标识 → 可读标题 */
function titleOf(image) {
  if (!image) return '照片';
  if (isDemo(image)) {
    const spec = get(image);
    return spec ? spec.label : '演示图片';
  }
  const parts = String(image).split('/');
  return parts[parts.length - 1] || '照片';
}

module.exports = {
  PREFIX,
  LIBRARY,
  list,
  get,
  isDemo,
  toImageId,
  titleOf
};
