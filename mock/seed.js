/**
 * 演示数据集（Mock 种子数据）
 * ---------------------------------------------------------------
 * 方案 16.1 的演示故事线就在这份数据里：
 *   失主上传“以前拍的水杯照片” + 拾物者在图书馆北门捡到同一个杯子并保留隐藏特征，
 *   系统完成多模态召回 + 时空重排 → 92% 级候选 → 对比 → 认领 → 归还。
 *
 * 另外刻意构造了「困难负样本」（外观高度相似但不是同一件）用于消融实验，
 * 对应方案 12.2「测试集中必须包含长得非常像但不是同一件的困难负样本」。
 *
 * 数据结构与真实后端保持一致，切换后端时只需替换本文件。
 */

const store = require('../utils/store');
const service = require('../utils/service');
const timeUtil = require('../core/time.js');
const locations = require('../core/locations.js');
const vlm = require('../core/vlm.js');
const categorical = require('../core/categories.js');

/**
 * 数据集版本号（与 core/seed-data.js 的 SEED_VERSION 保持一致）。
 * 云端灌入演示数据时用的是 core/seed-data.js 的版本号，两者必须同步递增，
 * 否则本地与云端会出现“一边重灌、一边不重灌”的错位。
 *
 * 版本 4：地点库换成江南大学蠡湖校区真实坐标，种子地点 id 同步迁移。
 * 版本 5：演示数据的时间改为按北京时间构造（不受运行环境时区影响）。
 */
const SEED_VERSION = 5;

function loc(id) {
  return locations.getById(id) || locations.UNKNOWN_LOCATION;
}

function at(hour, minute, dayOffset) {
  const d = new Date();
  d.setDate(d.getDate() + (dayOffset || 0));
  d.setHours(hour, minute || 0, 0, 0);
  return d.getTime();
}

/** 演示图片键名 → 图片标识（demo:// 前缀表示包内演示图） */
function demoImage(key, fallback) {
  if (!key) return fallback || '';
  if (String(key).indexOf('demo://') === 0) return key;
  return 'demo://' + key;
}

/**
 * 推断记录的 kind。
 *
 * ⚠ 真实缺陷：这里原本是 `cfg.kind === 'found' ? 'found' : 'lost'`——**没传 kind 就静默兜成 lost**。
 *   `seedHistory()` 造「已归还案例」的那条拾物记录恰好漏传了 kind，于是它被塞进
 *   lostItems 集合（kind 字段也被写成 'lost'），造成：
 *     · 失物数 +1、拾物数 -1，看板统计对不上；
 *     · 它会被当成候选参与匹配，甚至出现「自己匹配自己」的幽灵候选；
 *     · 认领链路里 lost/found 角色错乱。
 *   这与本项目另一处 `ctx.userId = 'u_me'` 是同一类问题：**静默兜底掩盖了调用方的遗漏**。
 *
 * 现在按「显式 kind → id 前缀」两级判定，两条线索都没有才回落到 lost，
 * 让命名与实际归属天然一致（演示数据的 id 一律带 lost_ / found_ 前缀）。
 */
function inferKind(cfg) {
  if (cfg.kind === 'found' || cfg.kind === 'lost') return cfg.kind;
  const id = String(cfg.id || '');
  if (id.indexOf('found_') === 0) return 'found';
  if (id.indexOf('lost_') === 0) return 'lost';
  return 'lost';
}

/** 生成记录（与 service.publish 的字段结构完全一致） */
function buildItem(cfg) {
  const kind = inferKind(cfg);
  const category = cfg.category;
  const attributes = Object.assign(
    { category },
    cfg.attributes || {}
  );
  const image = cfg.image || demoImage(DEMO_IMAGE[cfg.id]);
  const description = cfg.description || '';
  const location = loc(cfg.locationId);
  return {
    id: cfg.id,
    kind,
    userId: cfg.userId,
    title: cfg.title || '',
    image,
    images: cfg.images || [],
    description,
    location,
    locationMatched: true,
    locationText: location.name,
    timeRange: kind === 'lost' ? cfg.timeRange : null,
    foundTime: kind === 'found' ? cfg.foundTime : 0,
    attributes,
    attributeSources: cfg.attributeSources || { category: 'text', main_color: 'text', material: 'text' },
    privateFeatures: cfg.privateFeatures || [],
    publicDescription: description,
    status: cfg.status || (kind === 'lost' ? 'searching' : 'available'),
    embeddings: {
      image: image ? vlm.embed('image', image) : null,
      text: vlm.embed('text', [description, categorical.nameOf(category), (cfg.attributes || {}).brand || '', (cfg.attributes || {}).main_color || ''].join(' '))
    },
    identityId: cfg.identityId || '',
    createdAt: cfg.createdAt || Date.now(),
    updatedAt: cfg.createdAt || Date.now(),
    views: 0,
    matchCount: 0
  };
}

/* ===================== 数据定义 ===================== */

/**
 * 每条记录对应的演示图片（离线演示用）。
 * 同一真实物品的失物与拾物刻意使用同一张演示图（模拟“同一物品的不同照片”），
 * 外观接近但不是同一件的记录使用不同的图片，作为困难负样本。
 */
const DEMO_IMAGE = {
  lost_cup_01: 'cup_metal_gray',
  found_cup_01: 'cup_metal_gray',
  lost_cup_02: 'cup_black_matte',
  found_cup_03: 'cup_metal_gray',
  found_cup_02: 'cup_plastic_clear',
  lost_umbrella_01: 'umbrella_black',
  found_umbrella_01: 'umbrella_black',
  lost_umbrella_02: 'umbrella_blue',
  found_umbrella_02: 'umbrella_blue',
  lost_earphone_01: 'earphone_white_case',
  found_earphone_01: 'earphone_white_case',
  found_earphone_02: 'earphone_white_plain',
  lost_earphone_02: 'earphone_black_case',
  found_earphone_03: 'earphone_black_case',
  lost_key_01: 'key_duck',
  found_key_01: 'key_duck',
  found_key_02: 'key_duck',
  lost_card_01: 'card_blue',
  found_card_01: 'card_blue',
  lost_charger_01: 'charger_white',
  found_charger_01: 'charger_white',
  lost_bag_01: 'bag_blue',
  found_bag_01: 'bag_blue',
  lost_glasses_01: 'glasses_black',
  found_glasses_01: 'glasses_black',
  lost_watch_01: 'watch_black',
  found_watch_01: 'watch_black',
  lost_book_01: 'book_blue',
  found_book_01: 'book_blue',
  found_stationery_01: 'stationery_black',
  found_device_01: 'device_black',
  lost_cloth_01: 'cloth_gray',
  lost_sport_01: 'sport_racket',
  lost_powerbank_01: 'device_black',
  found_powerbank_01: 'device_black',
  lost_pen_01: 'stationery_black',
  found_pen_01: 'stationery_black',
  found_cup_04: 'cup_black_matte',
  found_earphone_05: 'earphone_black_case'
};

function lostDefs() {
  const defs = [
    /* ---------- 演示主线 1：保温杯（方案 16.1 故事线） ---------- */
    {
      id: 'lost_cup_01', userId: 'u_me', identityId: 'id_cup_thermos',
      title: '深灰金属保温杯',
      category: 'cup',
      description: '深灰色不锈钢保温杯，黑色杯盖，杯身有一道白色纵向品牌 Logo，杯底有一道长划痕，之前在图书馆自习时用过',
      locationId: 'lib',
      timeRange: { start: at(17, 30), end: at(18, 20), text: '约 17:30 — 18:20' },
      attributes: {
        brand: '膳魔师', main_color: '深灰', secondary_color: '黑色', material: '金属',
        shape: '圆柱形', size: '约 500ml', logo_text: '白色纵向文字Logo',
        damage_mark: '杯底有一道长划痕', accessory: '带杯套'
      },
      privateFeatures: ['杯底有一道长划痕', '杯盖内侧有一个小凹点'],
      createdAt: at(19, 5)
    },
    {
      id: 'lost_cup_02', identityId: 'id_cup_black_matte', userId: 'u_wang',
      title: '黑色磨砂保温杯',
      category: 'cup',
      description: '黑色磨砂质感的保温杯，杯盖也是黑色，没有明显图案，在操场跑步后丢的',
      locationId: 'track_n',
      timeRange: { start: at(16, 0), end: at(17, 30), text: '约 16:00 — 17:30' },
      attributes: {
        main_color: '黑', secondary_color: '黑', material: '金属', shape: '圆柱形',
        size: '约 500ml', pattern: '纯色'
      },
      privateFeatures: ['杯身底部有一个贴纸残留', '杯盖是按压式'],
      createdAt: at(18, 40)
    },
    {
      id: 'lost_umbrella_01', identityId: 'id_umbrella_wood', userId: 'u_lin',
      title: '黑色折叠伞',
      category: 'umbrella',
      description: '黑色折叠伞，木质弯柄，伞套丢了，伞面有一处小破损',
      locationId: 'canteen2',
      timeRange: { start: at(11, 40), end: at(12, 30), text: '约 11:40 — 12:30' },
      attributes: {
        main_color: '黑', material: '金属', shape: '折叠', accessory: '无伞套',
        damage_mark: '伞面有一处小破损'
      },
      privateFeatures: ['木质弯柄，握把处有一圈浅色木纹', '伞骨有一根是银色的'],
      createdAt: at(13, 10)
    },
    {
      id: 'lost_earphone_01', identityId: 'id_earphone_white', userId: 'u_chen',
      title: '白色无线耳机盒',
      category: 'earphone',
      description: '白色无线耳机充电盒，外面套了一个浅蓝色硅胶保护壳，壳上有一个小猫图案贴纸',
      locationId: 'teach2',
      timeRange: { start: at(9, 50), end: at(10, 30), text: '约 09:50 — 10:30' },
      attributes: {
        brand: 'Apple', main_color: '白', secondary_color: '浅蓝', material: '塑料',
        shape: '椭圆形', sticker: '有卡通贴纸', accessory: '带保护壳'
      },
      privateFeatures: ['硅胶壳背面有一个小猫贴纸', '盒盖内侧有轻微划痕'],
      createdAt: at(11, 0)
    },
    {
      id: 'lost_key_01', identityId: 'id_key_bunch', userId: 'u_zhao',
      title: '一串钥匙',
      category: 'key',
      description: '三把钥匙串在一起，挂着一个黄色小鸭钥匙扣，钥匙圈是银色的',
      locationId: 'dorm_north',
      timeRange: { start: at(21, 30), end: at(22, 30), text: '约 21:30 — 22:30' },
      attributes: {
        main_color: '银', secondary_color: '黄', material: '金属', accessory: '带黄色小鸭挂件'
      },
      privateFeatures: ['一共有三把钥匙：宿舍门、柜子、自行车锁', '钥匙扣是黄色小鸭形状'],
      createdAt: at(22, 50)
    },
    {
      id: 'lost_card_01', identityId: 'id_card_student', userId: 'u_me',
      title: '校园一卡通',
      category: 'card',
      description: '校园一卡通，蓝色卡面，套了一个透明卡套，背面贴了一张小贴纸',
      locationId: 'canteen1',
      timeRange: { start: at(12, 0), end: at(12, 40), text: '约 12:00 — 12:40' },
      attributes: {
        main_color: '蓝', material: '塑料', accessory: '带卡套', sticker: '有贴纸'
      },
      privateFeatures: ['卡号后四位是 2381', '卡套背面贴了一张小猫贴纸'],
      createdAt: at(13, 30)
    },
    {
      id: 'lost_charger_01', identityId: 'id_charger_apple', userId: 'u_wang',
      title: '白色充电头和数据线',
      category: 'charger',
      description: '白色充电头和 Type-C 数据线，线材上缠了一小圈黑色胶带做标记',
      locationId: 'express',
      timeRange: { start: at(15, 20), end: at(16, 0), text: '约 15:20 — 16:00' },
      attributes: {
        brand: 'Apple', main_color: '白', material: '塑料', accessory: '带原装扎带'
      },
      privateFeatures: ['数据线上缠了一圈黑色胶带', '充电头插脚处有一道划痕'],
      createdAt: at(16, 40)
    },
    {
      id: 'lost_bag_01', identityId: 'id_bag_herschel', userId: 'u_lin',
      title: '深蓝色双肩包',
      category: 'bag',
      description: '深蓝色帆布双肩包，包上挂了一个小挂件，内衬是灰色的，拉链头是黑色皮质',
      locationId: 'gym',
      timeRange: { start: at(18, 30), end: at(19, 30), text: '约 18:30 — 19:30' },
      attributes: {
        main_color: '深蓝', secondary_color: '灰', material: '帆布', shape: '方形',
        accessory: '带挂件'
      },
      privateFeatures: ['包内有一本专业书和一个灰色水杯', '内侧有一个绣了名字的标签'],
      createdAt: at(20, 10)
    },
    {
      id: 'lost_glasses_01', identityId: 'id_glasses_black', userId: 'u_chen',
      title: '黑色细框眼镜',
      category: 'glasses',
      description: '黑色细金属框近视眼镜，镜腿内侧有度数刻字，配一个深棕色镜盒',
      locationId: 'lib',
      timeRange: { start: at(20, 0), end: at(21, 0), text: '约 20:00 — 21:00' },
      attributes: {
        main_color: '黑', material: '金属', shape: '椭圆形', accessory: '带镜盒'
      },
      privateFeatures: ['镜腿内侧刻有度数 -3.50', '镜盒是深棕色，拉链有点涩'],
      createdAt: at(21, 30)
    },
    {
      id: 'lost_watch_01', identityId: 'id_watch_band', userId: 'u_zhao',
      title: '黑色运动手环',
      category: 'watch',
      description: '黑色硅胶表带运动手环，屏幕贴了钢化膜，表带内侧有磨损',
      locationId: 'court_n',
      timeRange: { start: at(17, 0), end: at(18, 0), text: '约 17:00 — 18:00' },
      attributes: {
        main_color: '黑', material: '硅胶', shape: '长方形', damage_mark: '表带内侧有磨损'
      },
      privateFeatures: ['表带内侧有两道明显磨损', '表盘贴的钢化膜右上角有个小气泡'],
      createdAt: at(18, 30)
    },
    {
      id: 'lost_book_01', identityId: 'id_book_calculus', userId: 'u_wang',
      title: '高等数学教材',
      category: 'book',
      description: '一本高等数学教材，蓝色封面，扉页写了名字和学号，里面夹着几张草稿纸',
      locationId: 'teach1',
      timeRange: { start: at(14, 0), end: at(15, 30), text: '约 14:00 — 15:30' },
      attributes: {
        main_color: '蓝', material: '纸质', shape: '长方形'
      },
      privateFeatures: ['扉页写了名字和学号', '夹着三张写着积分公式的草稿纸'],
      createdAt: at(16, 0)
    },
    {
      id: 'lost_earphone_02', identityId: 'id_earphone_black_in_ear', userId: 'u_me',
      title: '黑色蓝牙耳机',
      category: 'earphone',
      description: '黑色入耳式蓝牙耳机，带一个黑色充电盒，盒子有点旧',
      locationId: 'road_central',
      timeRange: { start: at(7, 40), end: at(8, 20), text: '约 07:40 — 08:20' },
      attributes: {
        main_color: '黑', material: '塑料', shape: '椭圆形', pattern: '纯色'
      },
      privateFeatures: ['充电盒底部有一道裂纹', '右耳耳机上的耳塞是后换的灰色'],
      createdAt: at(9, 0)
    },
    {
      id: 'lost_powerbank_01', identityId: 'id_device_powerbank', userId: 'u_chen',
      title: '黑色充电宝',
      category: 'device',
      description: '黑色 10000mAh 充电宝，外壳一角有磕碰掉漆，配一根红色编织短线',
      locationId: 'bus_stop',
      timeRange: { start: at(17, 10), end: at(17, 40), text: '约 17:10 — 17:40' },
      attributes: {
        main_color: '黑', material: '塑料', shape: '长方形', damage_mark: '外壳一角有磕碰掉漆'
      },
      privateFeatures: ['外壳一角有磕碰掉漆', '带的短线是红色编织线'],
      createdAt: at(18, 5)
    },
    {
      id: 'lost_pen_01', identityId: 'id_stationery_pen', userId: 'u_lin',
      title: '黑色笔袋和签字笔',
      category: 'stationery',
      description: '黑色布质笔袋，里面有几支黑色签字笔和一把尺子，拉链头是卡通造型',
      locationId: 'mech',
      timeRange: { start: at(10, 0), end: at(10, 30), text: '约 10:00 — 10:30' },
      attributes: {
        main_color: '黑', material: '布', shape: '长方形'
      },
      privateFeatures: ['笔袋里有一支刻了名字的钢笔', '笔袋拉链头是卡通造型'],
      createdAt: at(11, 5)
    },
    {
      id: 'lost_cup_03', identityId: 'id_cup_white_plastic', userId: 'u_zhao',
      title: '白色塑料水杯',
      category: 'cup',
      description: '白色塑料水杯，粉色杯盖，杯身没有图案，容量不大',
      locationId: 'gym',
      timeRange: { start: at(16, 20), end: at(17, 0), text: '约 16:20 — 17:00' },
      attributes: {
        main_color: '白', secondary_color: '粉色', material: '塑料', shape: '圆柱形', size: '约 350ml'
      },
      privateFeatures: ['杯盖内侧有一圈粉色胶圈', '杯底印着一个很小的生产批号'],
      createdAt: at(17, 20)
    },
    {
      id: 'lost_earphone_03', identityId: 'id_earphone_plain_white', userId: 'u_wang',
      title: '白色耳机充电盒',
      category: 'earphone',
      description: '白色无线耳机充电盒，没有保护壳，盒子底部贴了一圈灰色胶带',
      locationId: 'canteen1',
      timeRange: { start: at(10, 50), end: at(11, 30), text: '约 10:50 — 11:30' },
      attributes: {
        main_color: '白', material: '塑料', shape: '椭圆形'
      },
      privateFeatures: ['盒子底部有一圈灰色胶带', '盖子开合有点松'],
      createdAt: at(12, 0)
    },
    {
      id: 'lost_umbrella_02', identityId: 'id_umbrella_blue_similar', userId: 'u_chen',
      title: '深蓝色折叠伞',
      category: 'umbrella',
      description: '深蓝色折叠伞，塑料直柄，伞面完好，带一个印着校徽的伞套',
      locationId: 'market',
      timeRange: { start: at(12, 40), end: at(13, 20), text: '约 12:40 — 13:20' },
      attributes: {
        main_color: '深蓝', material: '塑料', shape: '折叠', accessory: '带伞套'
      },
      privateFeatures: ['伞套上印着校徽', '按扣处有点松'],
      createdAt: at(13, 50)
    }
  ];
  defs.forEach((d) => { d.kind = 'lost'; });
  return defs;
}

function foundDefs() {
  const defs = [
    /* ---------- 演示主线：图书馆北门捡到保温杯 ---------- */
    {
      id: 'found_cup_01', userId: 'u_lin', identityId: 'id_cup_thermos',
      title: '灰黑色金属水杯',
      category: 'cup',
      description: '灰黑色金属水杯，深黑杯盖，杯身有白色英文标志，看着挺新的',
      locationId: 'xuehai_stone',
      foundTime: at(18, 42),
      attributes: {
        brand: '膳魔师', main_color: '灰黑', secondary_color: '深黑', material: '金属',
        shape: '圆柱形', size: '约 500ml', logo_text: '白色英文标志', damage_mark: '有轻微划痕'
      },
      privateFeatures: ['杯底有一道长划痕', '杯盖内侧有一个小凹点', '杯身贴纸边缘有点翘起'],
      createdAt: at(18, 50)
    },
    {
      id: 'found_cup_02', userId: 'u_chen', identityId: 'id_cup_plastic_conflict',
      title: '塑料运动水壶',
      category: 'cup',
      description: '透明塑料运动水壶，蓝色瓶盖，带一个提环',
      locationId: 'track_n',
      foundTime: at(19, 20),
      attributes: {
        main_color: '透明', secondary_color: '蓝', material: '塑料', shape: '圆柱形', accessory: '带提环'
      },
      privateFeatures: ['瓶身有一道竖向裂纹', '瓶盖上有刻度线'],
      createdAt: at(19, 30)
    },
    {
      id: 'found_umbrella_01', userId: 'u_wang', identityId: 'id_umbrella_wood',
      title: '黑色长柄伞',
      category: 'umbrella',
      description: '一把黑色雨伞，木色弯柄，伞面有一处小破损，没有伞套',
      locationId: 'canteen2',
      foundTime: at(12, 55),
      attributes: {
        main_color: '黑', material: '木质', shape: '长柄', accessory: '无伞套',
        damage_mark: '伞面有一处小破损'
      },
      privateFeatures: ['木质弯柄，握把处有一圈浅色木纹', '伞骨有一根是银色的'],
      createdAt: at(13, 20)
    },
    {
      id: 'found_umbrella_02', userId: 'u_zhao', identityId: 'id_umbrella_blue_similar',
      title: '深蓝色折叠伞',
      category: 'umbrella',
      description: '深蓝色折叠伞，塑料直柄，伞面完好，带伞套',
      locationId: 'market',
      foundTime: at(13, 10),
      attributes: {
        main_color: '深蓝', material: '塑料', shape: '折叠', accessory: '带伞套'
      },
      privateFeatures: ['伞套上印着校徽', '按扣处有点松'],
      createdAt: at(13, 40)
    },
    {
      id: 'found_earphone_01', userId: 'u_lin', identityId: 'id_earphone_white',
      title: '白色耳机充电盒',
      category: 'earphone',
      description: '白色无线耳机充电盒，套着浅蓝色硅胶保护壳，壳上有个小卡通贴纸',
      locationId: 'teach2',
      foundTime: at(10, 45),
      attributes: {
        brand: 'Apple', main_color: '白', secondary_color: '浅蓝', material: '塑料',
        shape: '椭圆形', sticker: '有卡通贴纸', accessory: '带保护壳'
      },
      privateFeatures: ['硅胶壳背面有一个小猫贴纸', '盒盖内侧有轻微划痕'],
      createdAt: at(11, 10)
    },
    {
      id: 'found_earphone_02', userId: 'u_zhao', identityId: 'id_earphone_white_similar',
      title: '白色蓝牙耳机盒',
      category: 'earphone',
      description: '白色耳机盒，没有保护壳，盒子上有一个很小的品牌标志',
      locationId: 'canteen1',
      foundTime: at(11, 15),
      attributes: {
        main_color: '白', material: '塑料', shape: '椭圆形', logo_text: '小Logo'
      },
      privateFeatures: ['盒子底部有一圈灰色胶带', '盖子开合有点松'],
      createdAt: at(11, 40)
    },
    {
      id: 'found_key_01', userId: 'u_chen', identityId: 'id_key_bunch',
      title: '钥匙串（带小鸭挂件）',
      category: 'key',
      description: '银色钥匙圈上挂着三把钥匙和一个黄色小鸭钥匙扣',
      locationId: 'dorm_north',
      foundTime: at(22, 40),
      attributes: {
        main_color: '银', secondary_color: '黄', material: '金属', accessory: '带黄色小鸭挂件'
      },
      privateFeatures: ['一共有三把钥匙：宿舍门、柜子、自行车锁', '钥匙扣是黄色小鸭形状'],
      createdAt: at(22, 55)
    },
    {
      id: 'found_key_02', userId: 'u_wang', identityId: 'id_key_single_similar',
      title: '单把钥匙',
      category: 'key',
      description: '单独一把银色钥匙，没有任何挂件，钥匙柄上有磨损',
      locationId: 'parking',
      foundTime: at(8, 30),
      attributes: {
        main_color: '银', material: '金属', damage_mark: '钥匙柄有磨损'
      },
      privateFeatures: ['钥匙柄上有一道竖向磨损', '钥匙齿形比较特殊'],
      createdAt: at(8, 45)
    },
    {
      id: 'found_card_01', userId: 'u_wang', identityId: 'id_card_student',
      title: '校园一卡通（带卡套）',
      category: 'card',
      description: '蓝色校园一卡通，装在透明卡套里，卡套背面有一张小贴纸',
      locationId: 'canteen1',
      foundTime: at(12, 35),
      attributes: {
        main_color: '蓝', material: '塑料', accessory: '带卡套', sticker: '有贴纸'
      },
      privateFeatures: ['卡号后四位是 2381', '卡套背面贴了一张小猫贴纸'],
      createdAt: at(12, 50)
    },
    {
      id: 'found_charger_01', userId: 'u_chen', identityId: 'id_charger_apple',
      title: '白色充电头和数据线',
      category: 'charger',
      description: '白色充电头和 Type-C 线，线上缠了一圈黑色胶带',
      locationId: 'express',
      foundTime: at(16, 10),
      attributes: {
        brand: 'Apple', main_color: '白', material: '塑料'
      },
      privateFeatures: ['数据线上缠了一圈黑色胶带', '充电头插脚处有一道划痕'],
      createdAt: at(16, 25)
    },
    {
      id: 'found_bag_01', userId: 'u_lin', identityId: 'id_bag_herschel',
      title: '深蓝色双肩包',
      category: 'bag',
      description: '深蓝色帆布双肩包，灰色内衬，包上挂了一个小挂件，拉链头是黑色的',
      locationId: 'gym',
      foundTime: at(19, 35),
      attributes: {
        main_color: '深蓝', secondary_color: '灰', material: '帆布', shape: '方形', accessory: '带挂件'
      },
      privateFeatures: ['包内有一本专业书和一个灰色水杯', '内侧有一个绣了名字的标签'],
      createdAt: at(19, 50)
    },
    {
      id: 'found_glasses_01', userId: 'u_zhao', identityId: 'id_glasses_black',
      title: '黑色细框眼镜',
      category: 'glasses',
      description: '黑色细金属框眼镜，深棕色镜盒，镜腿内侧有刻字',
      locationId: 'lib',
      foundTime: at(21, 5),
      attributes: {
        main_color: '黑', material: '金属', shape: '椭圆形', accessory: '带镜盒'
      },
      privateFeatures: ['镜腿内侧刻有度数 -3.50', '镜盒是深棕色，拉链有点涩'],
      createdAt: at(21, 20)
    },
    {
      id: 'found_watch_01', userId: 'u_chen', identityId: 'id_watch_band',
      title: '黑色运动手环',
      category: 'watch',
      description: '黑色硅胶表带手环，屏幕贴了膜，表带内侧磨损明显',
      locationId: 'court_n',
      foundTime: at(18, 5),
      attributes: {
        main_color: '黑', material: '硅胶', shape: '长方形', damage_mark: '表带内侧有磨损'
      },
      privateFeatures: ['表带内侧有两道明显磨损', '表盘贴的钢化膜右上角有个小气泡'],
      createdAt: at(18, 20)
    },
    {
      id: 'found_book_01', userId: 'u_wang', identityId: 'id_book_calculus',
      title: '高等数学教材',
      category: 'book',
      description: '蓝色封面高等数学教材，扉页有名字，里面夹着几张草稿纸',
      locationId: 'teach1',
      foundTime: at(15, 40),
      attributes: {
        main_color: '蓝', material: '纸质', shape: '长方形'
      },
      privateFeatures: ['扉页写了名字和学号', '夹着三张写着积分公式的草稿纸'],
      createdAt: at(15, 50)
    },
    {
      id: 'found_cup_03', userId: 'u_zhao', identityId: 'id_cup_gray_similar',
      title: '灰色塑料水杯',
      category: 'cup',
      description: '灰色塑料水杯，黑色杯盖，杯身没有任何标志，看起来比较旧',
      locationId: 'lib',
      foundTime: at(18, 30),
      attributes: {
        main_color: '灰', secondary_color: '黑', material: '塑料', shape: '圆柱形', pattern: '纯色'
      },
      privateFeatures: ['杯身有一条竖向裂纹', '杯盖内侧有一圈黑色胶圈'],
      createdAt: at(18, 55)
    },
    {
      id: 'found_stationery_01', userId: 'u_lin', identityId: 'id_stationery_pen',
      title: '黑色签字笔和笔袋',
      category: 'stationery',
      description: '黑色布质笔袋，里面有几支黑色签字笔和一把尺子',
      locationId: 'mech',
      foundTime: at(10, 20),
      attributes: {
        main_color: '黑', material: '布', shape: '长方形'
      },
      privateFeatures: ['笔袋里有一支刻了名字的钢笔', '笔袋拉链头是卡通造型'],
      createdAt: at(10, 40)
    },
    {
      id: 'found_device_01', userId: 'u_chen', identityId: 'id_device_powerbank',
      title: '黑色充电宝',
      category: 'device',
      description: '黑色 10000mAh 充电宝，外壳有轻微磕碰，带一根短线',
      locationId: 'bus_stop',
      foundTime: at(17, 30),
      attributes: {
        main_color: '黑', material: '塑料', shape: '长方形', damage_mark: '有轻微磕碰'
      },
      privateFeatures: ['外壳一角有磕碰掉漆', '带的短线是红色编织线'],
      createdAt: at(17, 50)
    },
    {
      id: 'found_powerbank_01', userId: 'u_wang', identityId: 'id_device_powerbank',
      title: '黑色充电宝（带短线）',
      category: 'device',
      description: '黑色充电宝，一角有磕碰掉漆，带一根红色编织短线',
      locationId: 'bus_stop',
      foundTime: at(17, 35),
      attributes: {
        main_color: '黑', material: '塑料', shape: '长方形', damage_mark: '外壳一角有磕碰掉漆'
      },
      privateFeatures: ['外壳一角有磕碰掉漆', '带的短线是红色编织线'],
      createdAt: at(17, 55)
    },
    {
      id: 'found_pen_01', userId: 'u_chen', identityId: 'id_stationery_pen',
      title: '黑色布质笔袋',
      category: 'stationery',
      description: '黑色布质笔袋，里面有几支黑色签字笔和一把尺子，拉链头是卡通造型',
      locationId: 'mech',
      foundTime: at(10, 45),
      attributes: {
        main_color: '黑', material: '布', shape: '长方形'
      },
      privateFeatures: ['笔袋里有一支刻了名字的钢笔', '笔袋拉链头是卡通造型'],
      createdAt: at(11, 0)
    },
    {
      id: 'found_cup_04', userId: 'u_chen', identityId: 'id_cup_black_matte',
      title: '黑色磨砂保温杯',
      category: 'cup',
      description: '黑色磨砂保温杯，纯色无图案，杯盖是按压式',
      locationId: 'track_n',
      foundTime: at(17, 45),
      attributes: {
        main_color: '黑', secondary_color: '黑', material: '金属', shape: '圆柱形', size: '约 500ml', pattern: '纯色'
      },
      privateFeatures: ['杯身底部有一个贴纸残留', '杯盖是按压式'],
      createdAt: at(18, 5)
    },
    {
      id: 'found_earphone_05', userId: 'u_wang', identityId: 'id_earphone_black_in_ear',
      title: '黑色入耳式蓝牙耳机盒',
      category: 'earphone',
      description: '黑色入耳式蓝牙耳机，黑色充电盒，盒子比较旧，底部有一道裂纹',
      locationId: 'road_central',
      foundTime: at(8, 25),
      attributes: {
        main_color: '黑', material: '塑料', shape: '椭圆形', pattern: '纯色'
      },
      privateFeatures: ['充电盒底部有一道裂纹', '右耳耳机上的耳塞是后换的灰色'],
      createdAt: at(8, 40)
    },
    {
      id: 'found_cup_05', userId: 'u_lin', identityId: 'id_cup_white_plastic',
      title: '白色塑料水杯（粉色杯盖）',
      category: 'cup',
      description: '白色塑料水杯，粉色杯盖，容量不大，杯身没有图案',
      locationId: 'gym',
      foundTime: at(17, 10),
      attributes: {
        main_color: '白', secondary_color: '粉', material: '塑料', shape: '圆柱形', size: '约 350ml'
      },
      privateFeatures: ['杯盖内侧有一圈粉色胶圈', '杯底印着一个很小的生产批号'],
      createdAt: at(17, 35)
    },
    {
      id: 'found_earphone_04', userId: 'u_zhao', identityId: 'id_earphone_plain_white',
      title: '白色耳机盒（贴灰色胶带）',
      category: 'earphone',
      description: '白色无线耳机充电盒，没有保护壳，底部贴了一圈灰色胶带',
      locationId: 'canteen1',
      foundTime: at(11, 20),
      attributes: {
        main_color: '白', material: '塑料', shape: '椭圆形'
      },
      privateFeatures: ['盒子底部有一圈灰色胶带', '盖子开合有点松'],
      createdAt: at(11, 45)
    }
  ];
  defs.forEach((d) => { d.kind = 'found'; });
  return defs;
}

/* ===================== 灌入 ===================== */

function ensureSeed() {
  // 云端模式下数据以云数据库为准，本地不灌演示数据，避免覆盖云端内容
  if (store.isCloud()) return false;

  const db = store.db();
  const campusVersion = locations.META ? locations.META.version : 0;

  // 两重版本判断：
  //   seedVersion   —— 演示数据集本身变了
  //   campusVersion —— 校园地点库变了（换学校 / 改坐标 / 校准点位）
  // 少了第二项，升级后旧坐标会一直留在缓存里，地图就会显示成别的学校。
  if (db.seeded &&
      db.meta.seedVersion === SEED_VERSION &&
      db.meta.campusVersion === campusVersion) {
    return false;
  }

  // 注意：reset 会替换内部缓存对象，之后必须一律通过 store API 读写，
  // 不能再使用上面拿到的 db 引用（否则会写入已被丢弃的旧对象）。
  store.reset((d) => {
    d.users = store.clone(store.DEMO_USERS);
    d.seeded = true;
    d.meta.seedVersion = SEED_VERSION;
    d.meta.campusVersion = campusVersion;
  });

  // 写入物品（按时间正序，便于 unshift 后天然倒序）
  const losts = lostDefs().map(buildItem).sort((a, b) => a.createdAt - b.createdAt);
  losts.forEach((it) => store.insertItem(it));
  const founds = foundDefs().map(buildItem).sort((a, b) => a.createdAt - b.createdAt);
  founds.forEach((it) => store.insertItem(it));

  // 全量匹配一次，让首页/匹配页打开就有内容
  const t0 = Date.now();
  losts.forEach((l) => service.runMatchForLost(l, { topK: 12 }));
  founds.forEach((f) => service.runMatchForFound(f, { topK: 8 }));

  // 预置一条“寻找中”的历史闭环记录，丰富统计与个人页
  seedHistory();

  store.patchMeta({
    seedVersion: SEED_VERSION,
    campusVersion,
    avgMatchMs: store.meta().avgMatchMs || (Date.now() - t0)
  });
  store.persist({ silent: true });
  return true;
}

/** 预置一个已完成的归还案例（用于个人页历史与看板统计） */
function seedHistory() {
  const lost = store.getItem('lost_earphone_02');
  if (!lost) return;
  // 为已归还案例单独造一条拾物记录
  const found = buildItem({
    id: 'found_earphone_05', userId: 'u_zhao', identityId: 'id_earphone_black_in_ear',
    title: '黑色蓝牙耳机盒', category: 'earphone',
    description: '黑色入耳耳机充电盒，盒子比较旧，底部有一道裂纹',
    locationId: 'road_central', foundTime: at(8, 30, -2),
    attributes: { main_color: '黑', material: '塑料', shape: '椭圆形' },
    privateFeatures: ['充电盒底部有一道裂纹', '耳塞是灰色的'],
    createdAt: at(8, 45, -2),
    status: 'returned'
  });
  store.insertItem(found);

  const matchId = 'match_' + lost.id + '__' + found.id;
  const match = store.upsertMatch({
    id: matchId,
    lostId: lost.id,
    foundId: found.id,
    score: 0.93,
    scores: { image: 0.9, attr: 0.95, text: 0.92, geo: 0.97, time: 0.9 },
    weights: { image: 0.3, attr: 0.28, text: 0.22, geo: 0.12, time: 0.08 },
    contributions: { image: 0.27, attr: 0.266, text: 0.202, geo: 0.116, time: 0.072 },
    available: { image: true, attr: true, text: true, geo: true, time: true },
    attrItems: [],
    geo: { score: 0.97, available: true, distance: 40, distanceText: '约 40 m' },
    time: { score: 0.9, available: true, delta: 20 * 60 * 1000, deltaText: '20 分钟', inRange: true },
    reasons: {
      positive: [{ key: 'attr:main_color', text: '主色一致（黑）', weight: 0.5, score: 1 }],
      conflict: [],
      uncertain: []
    },
    threshold: 0.72,
    passed: true,
    hardConflict: false,
    status: 'returned',
    userStatus: 'claimed',
    createdAt: at(8, 50, -2)
  });

  store.insertClaim({
    id: 'claim_history_01',
    matchId: match.id,
    lostId: lost.id,
    foundId: found.id,
    claimantId: lost.userId,
    keeperId: found.userId,
    questions: service.buildQuestions(found),
    answers: [
      { questionId: 'q1', question: '这件物品上有什么明显的使用痕迹？大概在什么位置？', feature: '充电盒底部有一道裂纹', answer: '充电盒底部有一道裂纹，挺明显的', score: 0.72, reason: '回答与记录的私有特征语义高度一致' },
      { questionId: 'q2', question: '请描述「耳塞是灰色的」的具体情况', feature: '耳塞是灰色的', answer: '右耳耳塞是后换的灰色', score: 0.6, reason: '回答与记录的私有特征语义高度一致' }
    ],
    verificationScore: 0.66,
    status: 'returned',
    createdAt: at(9, 0, -2),
    submittedAt: at(9, 5, -2),
    confirmedAt: at(9, 30, -2),
    returnedAt: at(10, 0, -2)
  });

  store.updateItem(lost.id, { status: 'recovered' });
  store.updateItem(found.id, { status: 'returned' });
  store.insertFeedback({
    id: 'fb_history_01',
    matchId: match.id,
    lostId: lost.id,
    foundId: found.id,
    userAction: 'returned',
    confirmed: true,
    timestamp: at(10, 0, -2)
  });
}

module.exports = {
  SEED_VERSION,
  buildItem,
  ensureSeed,
  lostDefs,
  foundDefs
};
