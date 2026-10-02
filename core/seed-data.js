/**
 * 演示数据集定义（纯数据 + 纯函数，平台无关）
 * ---------------------------------------------------------------
 * 方案 16.1 的演示故事线就在这份数据里：
 *   失主在图书馆丢失水杯 + 拾物者在图书馆西侧的学海无涯石捡到同一个杯子并保留隐藏特征，
 *   系统完成多模态召回 + 时空重排（距离约 120 m、时间相差 22 分钟）→ 高相似候选 → 对比 → 认领 → 归还。
 *
 * 另外刻意构造了「外观高度相似但不是同一件」的困难负样本，
 * 对应方案 12.2「测试集中必须包含长得非常像但不是同一件的困难负样本」。
 *
 * 每条记录带 identityId（同一真实物品的失物与拾物共享同一 identityId），
 * 这既是种子数据的配对依据，也是消融实验评测的 ground truth。
 */

const timeUtil = require('./time');

/**
 * 演示数据集版本号。
 * 改动这份数据（增删记录、改坐标、改描述）后请递增：
 * 小程序启动时会比对版本，不一致就重新灌入，避免旧数据留在本地缓存里。
 *
 * 版本历史：
 *   3 —— 初版演示数据（配套旧演示坐标）
 *   4 —— 地点库换成江南大学蠡湖校区真实坐标（WGS-84 → GCJ-02），
 *        种子数据地点 id 同步迁移，彻底淘汰旧演示坐标（武汉一带）
 *   5 —— 演示数据的时间改为按**北京时间**构造（timeUtil.cnTime）。
 *        此前用运行环境本地时区，云函数跑在 UTC 时会让全部时间偏移 8 小时，
 *        界面显示成次日凌晨，且时间相关度语义失真。
 *        递增版本号以强制淘汰按旧逻辑生成的时间戳。
 */
const SEED_VERSION = 5;

/**
 * 演示图片映射：同一真实物品的失物与拾物刻意使用同一张演示图
 * （模拟「同一物品的不同照片」），外观接近但非同一件的使用不同图片。
 */
const DEMO_IMAGE = {
  lost_cup_01: 'cup_metal_gray',
  found_cup_01: 'cup_metal_gray',
  lost_cup_02: 'cup_black_matte',
  found_cup_04: 'cup_black_matte',
  found_cup_03: 'cup_metal_gray',
  found_cup_02: 'cup_plastic_clear',
  lost_umbrella_01: 'umbrella_black',
  found_umbrella_01: 'umbrella_black',
  lost_umbrella_02: 'umbrella_blue',
  found_umbrella_02: 'umbrella_blue',
  lost_earphone_01: 'earphone_white_case',
  found_earphone_01: 'earphone_white_case',
  found_earphone_02: 'earphone_white_plain',
  lost_earphone_03: 'earphone_white_plain',
  found_earphone_04: 'earphone_white_plain',
  lost_earphone_02: 'earphone_black_case',
  found_earphone_05: 'earphone_black_case',
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
  lost_pen_01: 'stationery_black',
  found_pen_01: 'stationery_black',
  found_device_01: 'device_black',
  lost_powerbank_01: 'device_black',
  found_powerbank_01: 'device_black',
  lost_cup_03: 'cup_plastic_clear',
  found_cup_05: 'cup_plastic_clear'
};

/**
 * 把「今天 18:10」这类相对时间转换为绝对时间戳。
 * @param {number} hour
 * @param {number} minute
 * @param {number} dayOffset 0=今天，-1=昨天
 * @param {number} now 基准时间，便于测试固定
 */
/**
 * 构造「锚点日 + 时:分」的时间戳。
 *
 * ⚠ 必须用 timeUtil.cnTime（按北京时间），不能用 new Date().setHours()。
 *   云函数运行环境的时区不一定是 UTC+8，用本地时区构造会让演示数据
 *   整体偏移 8 小时——界面显示成次日凌晨，且时间相关度的语义会失真
 *   （"丢失后 22 分钟被捡到" 变成 "提前 7.5 小时被捡到"）。
 */
function at(hour, minute, dayOffset, now) {
  return timeUtil.cnTime(hour, minute, dayOffset, now);
}

/* ===================== 失物定义 ===================== */

function lostDefs(now) {
  function t(h, m, off) { return at(h, m, off, now); }
  const defs = [
    /* ---------- 演示主线 1：保温杯（方案 16.1 故事线） ---------- */
    {
      id: 'lost_cup_01', userId: 'u_me', identityId: 'id_cup_thermos',
      title: '深灰金属保温杯',
      category: 'cup',
      description: '深灰色不锈钢保温杯，黑色杯盖，杯身有一道白色纵向品牌 Logo，杯底有一道长划痕，之前在图书馆自习时用过',
      locationId: 'lib',
      timeRange: { start: t(17, 30), end: t(18, 20), text: '约 17:30 — 18:20' },
      attributes: {
        brand: '膳魔师', main_color: '深灰', secondary_color: '黑色', material: '金属',
        shape: '圆柱形', size: '约 500ml', logo_text: '白色纵向文字Logo',
        damage_mark: '杯底有一道长划痕', accessory: '带杯套'
      },
      privateFeatures: ['杯底有一道长划痕', '杯盖内侧有一个小凹点'],
      createdAt: t(19, 5)
    },
    {
      id: 'lost_cup_02', identityId: 'id_cup_black_matte', userId: 'u_wang',
      title: '黑色磨砂保温杯',
      category: 'cup',
      description: '黑色磨砂质感的保温杯，杯盖也是黑色，没有明显图案，在操场跑步后丢的',
      locationId: 'track_n',
      timeRange: { start: t(16, 0), end: t(17, 30), text: '约 16:00 — 17:30' },
      attributes: {
        main_color: '黑', secondary_color: '黑', material: '金属', shape: '圆柱形',
        size: '约 500ml', pattern: '纯色'
      },
      privateFeatures: ['杯身底部有一个贴纸残留', '杯盖是按压式'],
      createdAt: t(18, 40)
    },
    {
      id: 'lost_umbrella_01', identityId: 'id_umbrella_wood', userId: 'u_lin',
      title: '黑色折叠伞',
      category: 'umbrella',
      description: '黑色折叠伞，木质弯柄，伞套丢了，伞面有一处小破损',
      locationId: 'canteen2',
      timeRange: { start: t(11, 40), end: t(12, 30), text: '约 11:40 — 12:30' },
      attributes: {
        main_color: '黑', material: '金属', shape: '折叠', accessory: '无伞套',
        damage_mark: '伞面有一处小破损'
      },
      privateFeatures: ['木质弯柄，握把处有一圈浅色木纹', '伞骨有一根是银色的'],
      createdAt: t(13, 10)
    },
    {
      id: 'lost_earphone_01', identityId: 'id_earphone_white', userId: 'u_chen',
      title: '白色无线耳机盒',
      category: 'earphone',
      description: '白色无线耳机充电盒，外面套了一个浅蓝色硅胶保护壳，壳上有一个小猫图案贴纸',
      locationId: 'teach2',
      timeRange: { start: t(9, 50), end: t(10, 30), text: '约 09:50 — 10:30' },
      attributes: {
        brand: 'Apple', main_color: '白', secondary_color: '浅蓝', material: '塑料',
        shape: '椭圆形', sticker: '有卡通贴纸', accessory: '带保护壳'
      },
      privateFeatures: ['硅胶壳背面有一个小猫贴纸', '盒盖内侧有轻微划痕'],
      createdAt: t(11, 0)
    },
    {
      id: 'lost_key_01', identityId: 'id_key_bunch', userId: 'u_zhao',
      title: '一串钥匙',
      category: 'key',
      description: '三把钥匙串在一起，挂着一个黄色小鸭钥匙扣，钥匙圈是银色的',
      locationId: 'dorm_north',
      timeRange: { start: t(21, 30), end: t(22, 30), text: '约 21:30 — 22:30' },
      attributes: {
        main_color: '银', secondary_color: '黄', material: '金属', accessory: '带黄色小鸭挂件'
      },
      privateFeatures: ['一共有三把钥匙：宿舍门、柜子、自行车锁', '钥匙扣是黄色小鸭形状'],
      createdAt: t(22, 50)
    },
    {
      id: 'lost_card_01', identityId: 'id_card_student', userId: 'u_me',
      title: '校园一卡通',
      category: 'card',
      description: '校园一卡通，蓝色卡面，套了一个透明卡套，背面贴了一张小贴纸',
      locationId: 'canteen1',
      timeRange: { start: t(12, 0), end: t(12, 40), text: '约 12:00 — 12:40' },
      attributes: {
        main_color: '蓝', material: '塑料', accessory: '带卡套', sticker: '有贴纸'
      },
      privateFeatures: ['卡号后四位是 2381', '卡套背面贴了一张小猫贴纸'],
      createdAt: t(13, 30)
    },
    {
      id: 'lost_charger_01', identityId: 'id_charger_apple', userId: 'u_wang',
      title: '白色充电头和数据线',
      category: 'charger',
      description: '白色充电头和 Type-C 数据线，线材上缠了一小圈黑色胶带做标记',
      locationId: 'express',
      timeRange: { start: t(15, 20), end: t(16, 0), text: '约 15:20 — 16:00' },
      attributes: {
        brand: 'Apple', main_color: '白', material: '塑料', accessory: '带原装扎带'
      },
      privateFeatures: ['数据线上缠了一圈黑色胶带', '充电头插脚处有一道划痕'],
      createdAt: t(16, 40)
    },
    {
      id: 'lost_bag_01', identityId: 'id_bag_herschel', userId: 'u_lin',
      title: '深蓝色双肩包',
      category: 'bag',
      description: '深蓝色帆布双肩包，包上挂了一个小挂件，内衬是灰色的，拉链头是黑色皮质',
      locationId: 'gym',
      timeRange: { start: t(18, 30), end: t(19, 30), text: '约 18:30 — 19:30' },
      attributes: {
        main_color: '深蓝', secondary_color: '灰', material: '帆布', shape: '方形',
        accessory: '带挂件'
      },
      privateFeatures: ['包内有一本专业书和一个灰色水杯', '内侧有一个绣了名字的标签'],
      createdAt: t(20, 10)
    },
    {
      id: 'lost_glasses_01', identityId: 'id_glasses_black', userId: 'u_chen',
      title: '黑色细框眼镜',
      category: 'glasses',
      description: '黑色细金属框近视眼镜，镜腿内侧有度数刻字，配一个深棕色镜盒',
      locationId: 'lib',
      timeRange: { start: t(20, 0), end: t(21, 0), text: '约 20:00 — 21:00' },
      attributes: {
        main_color: '黑', material: '金属', shape: '椭圆形', accessory: '带镜盒'
      },
      privateFeatures: ['镜腿内侧刻有度数 -3.50', '镜盒是深棕色，拉链有点涩'],
      createdAt: t(21, 30)
    },
    {
      id: 'lost_watch_01', identityId: 'id_watch_band', userId: 'u_zhao',
      title: '黑色运动手环',
      category: 'watch',
      description: '黑色硅胶表带运动手环，屏幕贴了钢化膜，表带内侧有磨损',
      locationId: 'court_n',
      timeRange: { start: t(17, 0), end: t(18, 0), text: '约 17:00 — 18:00' },
      attributes: {
        main_color: '黑', material: '硅胶', shape: '长方形', damage_mark: '表带内侧有磨损'
      },
      privateFeatures: ['表带内侧有两道明显磨损', '表盘贴的钢化膜右上角有个小气泡'],
      createdAt: t(18, 30)
    },
    {
      id: 'lost_book_01', identityId: 'id_book_calculus', userId: 'u_wang',
      title: '高等数学教材',
      category: 'book',
      description: '一本高等数学教材，蓝色封面，扉页写了名字和学号，里面夹着几张草稿纸',
      locationId: 'teach1',
      timeRange: { start: t(14, 0), end: t(15, 30), text: '约 14:00 — 15:30' },
      attributes: {
        main_color: '蓝', material: '纸质', shape: '长方形'
      },
      privateFeatures: ['扉页写了名字和学号', '夹着三张写着积分公式的草稿纸'],
      createdAt: t(16, 0)
    },
    {
      id: 'lost_earphone_02', identityId: 'id_earphone_black_in_ear', userId: 'u_me',
      title: '黑色蓝牙耳机',
      category: 'earphone',
      description: '黑色入耳式蓝牙耳机，带一个黑色充电盒，盒子有点旧',
      locationId: 'road_central',
      timeRange: { start: t(7, 40), end: t(8, 20), text: '约 07:40 — 08:20' },
      attributes: {
        main_color: '黑', material: '塑料', shape: '椭圆形', pattern: '纯色'
      },
      privateFeatures: ['充电盒底部有一道裂纹', '右耳耳机上的耳塞是后换的灰色'],
      createdAt: t(9, 0)
    },
    {
      id: 'lost_powerbank_01', identityId: 'id_device_powerbank', userId: 'u_chen',
      title: '黑色充电宝',
      category: 'device',
      description: '黑色 10000mAh 充电宝，外壳一角有磕碰掉漆，配一根红色编织短线',
      locationId: 'bus_stop',
      timeRange: { start: t(17, 10), end: t(17, 40), text: '约 17:10 — 17:40' },
      attributes: {
        main_color: '黑', material: '塑料', shape: '长方形', damage_mark: '外壳一角有磕碰掉漆'
      },
      privateFeatures: ['外壳一角有磕碰掉漆', '带的短线是红色编织线'],
      createdAt: t(18, 5)
    },
    {
      id: 'lost_pen_01', identityId: 'id_stationery_pen', userId: 'u_lin',
      title: '黑色笔袋和签字笔',
      category: 'stationery',
      description: '黑色布质笔袋，里面有几支黑色签字笔和一把尺子，拉链头是卡通造型',
      locationId: 'mech',
      timeRange: { start: t(10, 0), end: t(10, 30), text: '约 10:00 — 10:30' },
      attributes: {
        main_color: '黑', material: '布', shape: '长方形'
      },
      privateFeatures: ['笔袋里有一支刻了名字的钢笔', '笔袋拉链头是卡通造型'],
      createdAt: t(11, 5)
    },
    {
      id: 'lost_cup_03', identityId: 'id_cup_white_plastic', userId: 'u_zhao',
      title: '白色塑料水杯',
      category: 'cup',
      description: '白色塑料水杯，粉色杯盖，杯身没有图案，容量不大',
      locationId: 'gym',
      timeRange: { start: t(16, 20), end: t(17, 0), text: '约 16:20 — 17:00' },
      attributes: {
        main_color: '白', secondary_color: '粉色', material: '塑料', shape: '圆柱形', size: '约 350ml'
      },
      privateFeatures: ['杯盖内侧有一圈粉色胶圈', '杯底印着一个很小的生产批号'],
      createdAt: t(17, 20)
    },
    {
      id: 'lost_earphone_03', identityId: 'id_earphone_plain_white', userId: 'u_wang',
      title: '白色耳机充电盒',
      category: 'earphone',
      description: '白色无线耳机充电盒，没有保护壳，盒子底部贴了一圈灰色胶带',
      locationId: 'canteen1',
      timeRange: { start: t(10, 50), end: t(11, 30), text: '约 10:50 — 11:30' },
      attributes: {
        main_color: '白', material: '塑料', shape: '椭圆形'
      },
      privateFeatures: ['盒子底部有一圈灰色胶带', '盖子开合有点松'],
      createdAt: t(12, 0)
    },
    {
      id: 'lost_umbrella_02', identityId: 'id_umbrella_blue_similar', userId: 'u_chen',
      title: '深蓝色折叠伞',
      category: 'umbrella',
      description: '深蓝色折叠伞，塑料直柄，伞面完好，带一个印着校徽的伞套',
      locationId: 'market',
      timeRange: { start: t(12, 40), end: t(13, 20), text: '约 12:40 — 13:20' },
      attributes: {
        main_color: '深蓝', material: '塑料', shape: '折叠', accessory: '带伞套'
      },
      privateFeatures: ['伞套上印着校徽', '按扣处有点松'],
      createdAt: t(13, 50)
    }
  ];
  defs.forEach((d) => { d.kind = 'lost'; });
  return defs;
}

/* ===================== 拾物定义 ===================== */

function foundDefs(now) {
  function t(h, m, off) { return at(h, m, off, now); }
  const defs = [
    /* ---------- 演示主线：图书馆北门捡到保温杯 ---------- */
    {
      id: 'found_cup_01', userId: 'u_lin', identityId: 'id_cup_thermos',
      title: '灰黑色金属水杯',
      category: 'cup',
      description: '灰黑色金属水杯，深黑杯盖，杯身有白色英文标志，看着挺新的',
      locationId: 'xuehai_stone',
      foundTime: t(18, 42),
      attributes: {
        brand: '膳魔师', main_color: '灰黑', secondary_color: '深黑', material: '金属',
        shape: '圆柱形', size: '约 500ml', logo_text: '白色英文标志', damage_mark: '有轻微划痕'
      },
      privateFeatures: ['杯底有一道长划痕', '杯盖内侧有一个小凹点', '杯身贴纸边缘有点翘起'],
      createdAt: t(18, 50)
    },
    {
      id: 'found_cup_02', userId: 'u_chen', identityId: 'id_cup_plastic_conflict',
      title: '塑料运动水壶',
      category: 'cup',
      description: '透明塑料运动水壶，蓝色瓶盖，带一个提环',
      locationId: 'track_n',
      foundTime: t(19, 20),
      attributes: {
        main_color: '透明', secondary_color: '蓝', material: '塑料', shape: '圆柱形', accessory: '带提环'
      },
      privateFeatures: ['瓶身有一道竖向裂纹', '瓶盖上有刻度线'],
      createdAt: t(19, 30)
    },
    {
      id: 'found_umbrella_01', userId: 'u_wang', identityId: 'id_umbrella_wood',
      title: '黑色长柄伞',
      category: 'umbrella',
      description: '一把黑色雨伞，木色弯柄，伞面有一处小破损，没有伞套',
      locationId: 'canteen2',
      foundTime: t(12, 55),
      attributes: {
        main_color: '黑', material: '木质', shape: '长柄', accessory: '无伞套',
        damage_mark: '伞面有一处小破损'
      },
      privateFeatures: ['木质弯柄，握把处有一圈浅色木纹', '伞骨有一根是银色的'],
      createdAt: t(13, 20)
    },
    {
      id: 'found_umbrella_02', userId: 'u_zhao', identityId: 'id_umbrella_blue_similar',
      title: '深蓝色折叠伞',
      category: 'umbrella',
      description: '深蓝色折叠伞，塑料直柄，伞面完好，带伞套',
      locationId: 'market',
      foundTime: t(13, 10),
      attributes: {
        main_color: '深蓝', material: '塑料', shape: '折叠', accessory: '带伞套'
      },
      privateFeatures: ['伞套上印着校徽', '按扣处有点松'],
      createdAt: t(13, 40)
    },
    {
      id: 'found_earphone_01', userId: 'u_lin', identityId: 'id_earphone_white',
      title: '白色耳机充电盒',
      category: 'earphone',
      description: '白色无线耳机充电盒，套着浅蓝色硅胶保护壳，壳上有个小卡通贴纸',
      locationId: 'teach2',
      foundTime: t(10, 45),
      attributes: {
        brand: 'Apple', main_color: '白', secondary_color: '浅蓝', material: '塑料',
        shape: '椭圆形', sticker: '有卡通贴纸', accessory: '带保护壳'
      },
      privateFeatures: ['硅胶壳背面有一个小猫贴纸', '盒盖内侧有轻微划痕'],
      createdAt: t(11, 10)
    },
    {
      id: 'found_earphone_02', userId: 'u_zhao', identityId: 'id_earphone_white_similar',
      title: '白色蓝牙耳机盒',
      category: 'earphone',
      description: '白色耳机盒，没有保护壳，盒子上有一个很小的品牌标志',
      locationId: 'canteen1',
      foundTime: t(11, 15),
      attributes: {
        main_color: '白', material: '塑料', shape: '椭圆形', logo_text: '小Logo'
      },
      privateFeatures: ['盒子底部有一圈灰色胶带', '盖子开合有点松'],
      createdAt: t(11, 40)
    },
    {
      id: 'found_key_01', userId: 'u_chen', identityId: 'id_key_bunch',
      title: '钥匙串（带小鸭挂件）',
      category: 'key',
      description: '银色钥匙圈上挂着三把钥匙和一个黄色小鸭钥匙扣',
      locationId: 'dorm_north',
      foundTime: t(22, 40),
      attributes: {
        main_color: '银', secondary_color: '黄', material: '金属', accessory: '带黄色小鸭挂件'
      },
      privateFeatures: ['一共有三把钥匙：宿舍门、柜子、自行车锁', '钥匙扣是黄色小鸭形状'],
      createdAt: t(22, 55)
    },
    {
      id: 'found_key_02', userId: 'u_wang', identityId: 'id_key_single_similar',
      title: '单把钥匙',
      category: 'key',
      description: '单独一把银色钥匙，没有任何挂件，钥匙柄上有磨损',
      locationId: 'parking',
      foundTime: t(8, 30),
      attributes: {
        main_color: '银', material: '金属', damage_mark: '钥匙柄有磨损'
      },
      privateFeatures: ['钥匙柄上有一道竖向磨损', '钥匙齿形比较特殊'],
      createdAt: t(8, 45)
    },
    {
      id: 'found_card_01', userId: 'u_wang', identityId: 'id_card_student',
      title: '校园一卡通（带卡套）',
      category: 'card',
      description: '蓝色校园一卡通，装在透明卡套里，卡套背面有一张小贴纸',
      locationId: 'canteen1',
      foundTime: t(12, 35),
      attributes: {
        main_color: '蓝', material: '塑料', accessory: '带卡套', sticker: '有贴纸'
      },
      privateFeatures: ['卡号后四位是 2381', '卡套背面贴了一张小猫贴纸'],
      createdAt: t(12, 50)
    },
    {
      id: 'found_charger_01', userId: 'u_chen', identityId: 'id_charger_apple',
      title: '白色充电头和数据线',
      category: 'charger',
      description: '白色充电头和 Type-C 线，线上缠了一圈黑色胶带',
      locationId: 'express',
      foundTime: t(16, 10),
      attributes: {
        brand: 'Apple', main_color: '白', material: '塑料'
      },
      privateFeatures: ['数据线上缠了一圈黑色胶带', '充电头插脚处有一道划痕'],
      createdAt: t(16, 25)
    },
    {
      id: 'found_bag_01', userId: 'u_lin', identityId: 'id_bag_herschel',
      title: '深蓝色双肩包',
      category: 'bag',
      description: '深蓝色帆布双肩包，灰色内衬，包上挂了一个小挂件，拉链头是黑色的',
      locationId: 'gym',
      foundTime: t(19, 35),
      attributes: {
        main_color: '深蓝', secondary_color: '灰', material: '帆布', shape: '方形', accessory: '带挂件'
      },
      privateFeatures: ['包内有一本专业书和一个灰色水杯', '内侧有一个绣了名字的标签'],
      createdAt: t(19, 50)
    },
    {
      id: 'found_glasses_01', userId: 'u_zhao', identityId: 'id_glasses_black',
      title: '黑色细框眼镜',
      category: 'glasses',
      description: '黑色细金属框眼镜，深棕色镜盒，镜腿内侧有刻字',
      locationId: 'lib',
      foundTime: t(21, 5),
      attributes: {
        main_color: '黑', material: '金属', shape: '椭圆形', accessory: '带镜盒'
      },
      privateFeatures: ['镜腿内侧刻有度数 -3.50', '镜盒是深棕色，拉链有点涩'],
      createdAt: t(21, 20)
    },
    {
      id: 'found_watch_01', userId: 'u_chen', identityId: 'id_watch_band',
      title: '黑色运动手环',
      category: 'watch',
      description: '黑色硅胶表带手环，屏幕贴了膜，表带内侧磨损明显',
      locationId: 'court_n',
      foundTime: t(18, 5),
      attributes: {
        main_color: '黑', material: '硅胶', shape: '长方形', damage_mark: '表带内侧有磨损'
      },
      privateFeatures: ['表带内侧有两道明显磨损', '表盘贴的钢化膜右上角有个小气泡'],
      createdAt: t(18, 20)
    },
    {
      id: 'found_book_01', userId: 'u_wang', identityId: 'id_book_calculus',
      title: '高等数学教材',
      category: 'book',
      description: '蓝色封面高等数学教材，扉页有名字，里面夹着几张草稿纸',
      locationId: 'teach1',
      foundTime: t(15, 40),
      attributes: {
        main_color: '蓝', material: '纸质', shape: '长方形'
      },
      privateFeatures: ['扉页写了名字和学号', '夹着三张写着积分公式的草稿纸'],
      createdAt: t(15, 50)
    },
    {
      id: 'found_cup_03', userId: 'u_zhao', identityId: 'id_cup_gray_similar',
      title: '灰色塑料水杯',
      category: 'cup',
      description: '灰色塑料水杯，黑色杯盖，杯身没有任何标志，看起来比较旧',
      locationId: 'lib',
      foundTime: t(18, 30),
      attributes: {
        main_color: '灰', secondary_color: '黑', material: '塑料', shape: '圆柱形', pattern: '纯色'
      },
      privateFeatures: ['杯身有一条竖向裂纹', '杯盖内侧有一圈黑色胶圈'],
      createdAt: t(18, 55)
    },
    {
      id: 'found_stationery_01', userId: 'u_lin', identityId: 'id_stationery_pen',
      title: '黑色签字笔和笔袋',
      category: 'stationery',
      description: '黑色布质笔袋，里面有几支黑色签字笔和一把尺子',
      locationId: 'mech',
      foundTime: t(10, 20),
      attributes: {
        main_color: '黑', material: '布', shape: '长方形'
      },
      privateFeatures: ['笔袋里有一支刻了名字的钢笔', '笔袋拉链头是卡通造型'],
      createdAt: t(10, 40)
    },
    {
      id: 'found_device_01', userId: 'u_chen', identityId: 'id_device_powerbank',
      title: '黑色充电宝',
      category: 'device',
      description: '黑色 10000mAh 充电宝，外壳有轻微磕碰，带一根短线',
      locationId: 'bus_stop',
      foundTime: t(17, 30),
      attributes: {
        main_color: '黑', material: '塑料', shape: '长方形', damage_mark: '有轻微磕碰'
      },
      privateFeatures: ['外壳一角有磕碰掉漆', '带的短线是红色编织线'],
      createdAt: t(17, 50)
    },
    {
      id: 'found_powerbank_01', userId: 'u_wang', identityId: 'id_device_powerbank',
      title: '黑色充电宝（带短线）',
      category: 'device',
      description: '黑色充电宝，一角有磕碰掉漆，带一根红色编织短线',
      locationId: 'bus_stop',
      foundTime: t(17, 35),
      attributes: {
        main_color: '黑', material: '塑料', shape: '长方形', damage_mark: '外壳一角有磕碰掉漆'
      },
      privateFeatures: ['外壳一角有磕碰掉漆', '带的短线是红色编织线'],
      createdAt: t(17, 55)
    },
    {
      id: 'found_pen_01', userId: 'u_chen', identityId: 'id_stationery_pen',
      title: '黑色布质笔袋',
      category: 'stationery',
      description: '黑色布质笔袋，里面有几支黑色签字笔和一把尺子，拉链头是卡通造型',
      locationId: 'mech',
      foundTime: t(10, 45),
      attributes: {
        main_color: '黑', material: '布', shape: '长方形'
      },
      privateFeatures: ['笔袋里有一支刻了名字的钢笔', '笔袋拉链头是卡通造型'],
      createdAt: t(11, 0)
    },
    {
      id: 'found_cup_04', userId: 'u_chen', identityId: 'id_cup_black_matte',
      title: '黑色磨砂保温杯',
      category: 'cup',
      description: '黑色磨砂保温杯，纯色无图案，杯盖是按压式',
      locationId: 'track_n',
      foundTime: t(17, 45),
      attributes: {
        main_color: '黑', secondary_color: '黑', material: '金属', shape: '圆柱形', size: '约 500ml', pattern: '纯色'
      },
      privateFeatures: ['杯身底部有一个贴纸残留', '杯盖是按压式'],
      createdAt: t(18, 5)
    },
    {
      id: 'found_cup_05', userId: 'u_lin', identityId: 'id_cup_white_plastic',
      title: '白色塑料水杯（粉色杯盖）',
      category: 'cup',
      description: '白色塑料水杯，粉色杯盖，容量不大，杯身没有图案',
      locationId: 'gym',
      foundTime: t(17, 10),
      attributes: {
        main_color: '白', secondary_color: '粉', material: '塑料', shape: '圆柱形', size: '约 350ml'
      },
      privateFeatures: ['杯盖内侧有一圈粉色胶圈', '杯底印着一个很小的生产批号'],
      createdAt: t(17, 35)
    },
    {
      id: 'found_earphone_04', userId: 'u_zhao', identityId: 'id_earphone_plain_white',
      title: '白色耳机盒（贴灰色胶带）',
      category: 'earphone',
      description: '白色无线耳机充电盒，没有保护壳，底部贴了一圈灰色胶带',
      locationId: 'canteen1',
      foundTime: t(11, 20),
      attributes: {
        main_color: '白', material: '塑料', shape: '椭圆形'
      },
      privateFeatures: ['盒子底部有一圈灰色胶带', '盖子开合有点松'],
      createdAt: t(11, 45)
    },
    {
      id: 'found_earphone_05', userId: 'u_zhao', identityId: 'id_earphone_black_in_ear',
      title: '黑色入耳式蓝牙耳机盒',
      category: 'earphone',
      description: '黑色入耳式蓝牙耳机，黑色充电盒，盒子比较旧，底部有一道裂纹',
      locationId: 'road_central',
      foundTime: t(8, 25),
      attributes: {
        main_color: '黑', material: '塑料', shape: '椭圆形', pattern: '纯色'
      },
      privateFeatures: ['充电盒底部有一道裂纹', '右耳耳机上的耳塞是后换的灰色'],
      createdAt: t(8, 40)
    }
  ];
  defs.forEach((d) => { d.kind = 'found'; });
  return defs;
}

/** 演示用户 */
const DEMO_USERS = [
  { id: 'u_me', nickName: '我', avatar: '', role: 'user', credit: 100, college: '计算机学院' },
  { id: 'u_lin', nickName: '林同学', avatar: '', role: 'user', credit: 98, college: '外语学院' },
  { id: 'u_chen', nickName: '陈同学', avatar: '', role: 'user', credit: 96, college: '机械学院' },
  { id: 'u_wang', nickName: '王同学', avatar: '', role: 'user', credit: 95, college: '数理学院' },
  { id: 'u_zhao', nickName: '赵同学', avatar: '', role: 'user', credit: 99, college: '设计学院' },
  { id: 'u_admin', nickName: '平台管理员', avatar: '', role: 'admin', credit: 100, college: '学工处' }
];

/** 已闭环的历史案例（用于个人页历史、看板统计与反馈样本） */
function historyCase(now) {
  return {
    lostId: 'lost_earphone_02',
    found: {
      id: 'found_earphone_06', userId: 'u_zhao', identityId: 'id_earphone_black_in_ear',
      title: '黑色蓝牙耳机盒', category: 'earphone', kind: 'found',
      description: '黑色入耳耳机充电盒，盒子比较旧，底部有一道裂纹',
      locationId: 'road_central', foundTime: at(8, 30, -2, now),
      attributes: { main_color: '黑', material: '塑料', shape: '椭圆形' },
      privateFeatures: ['充电盒底部有一道裂纹', '耳塞是灰色的'],
      createdAt: at(8, 45, -2, now),
      status: 'returned'
    },
    claim: {
      answers: [
        '充电盒底部有一道裂纹，挺明显的',
        '右耳耳塞是后换的灰色'
      ],
      verificationScore: 0.66
    }
  };
}

module.exports = {
  SEED_VERSION,
  DEMO_IMAGE,
  DEMO_USERS,
  at,
  lostDefs,
  foundDefs,
  historyCase
};
