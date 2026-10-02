/**
 * 江南大学蠡湖校区 · 校园地点数据
 * ===============================================================
 * 【数据来源与可信度——请务必读完】
 *
 * 坐标系：GCJ-02（微信 map 组件、wx.getLocation、腾讯/高德地图使用的坐标系）
 * 来源：OpenStreetMap（Overpass API），校区边界 way/286859146
 *       OSM 原始数据为 WGS-84，已用 core/coord.js 统一转换为 GCJ-02
 *       （本校区实测偏移约 484 米，不转换会让所有地点整体偏到隔壁街区）
 *
 * 每个地点带 verified 标记：
 *   verified: true   —— 来自 OSM 的实测建筑/道路/桥梁坐标，可信
 *   verified: false  —— 文档或地图上确认存在，但坐标是按教学楼群相对位置估算的，
 *                       需要你在校用「管理看板 → 校准地点坐标」重新取点确认
 *
 * 已知缺口（OSM 上没有可定位的图元，需要你补）：
 *   - 图书馆：按《新生入学指南》描述「过文浩馆，西边的高大建筑就是图书馆」，
 *     位置应在文浩馆以西、小蠡湖以东、一教以南，坐标为首层估算
 *   - 各宿舍楼（杏园/李园/桃园/桂园/榴园/梅园/桔园/橙园/留园 等）未在 OSM 中标注
 *   - 校园超市、浴室、校车站等生活设施同理
 *
 * 维护方式：管理看板 → 校准地点坐标 → 在地图上点选 → 导出 JSON → 覆盖本文件
 *           改完记得把 core/config.js 的 campus.version 加 1，并重跑 scripts/sync-core.js
 * ===============================================================
 */

const META = {
  school: '江南大学',
  campus: '蠡湖校区',
  address: '江苏省无锡市滨湖区蠡湖大道1800号',
  /** 校区中心（GCJ-02），用于地图初始视野与未知地点的兜底 */
  center: { lat: 31.4835, lng: 120.2735 },
  /** 校区大致范围（GCJ-02），用于判断坐标是否落在校园内 */
  bounds: { minLat: 31.4747, maxLat: 31.4916, minLng: 120.2639, maxLng: 120.2773 },
  /** 坐标系说明，会展示在小程序的地图页与答辩材料里 */
  coordSystem: 'GCJ-02',
  source: 'OpenStreetMap (ODbL) + 江南大学官微《新生入学指南》',
  updatedAt: '2026-10',
  /** 数据版本：修改坐标后请递增，前端会提示需要重新做地点标准化 */
  version: 2
};

/**
 * 区域划分（校区实际分区）
 * 曲水桥是南北区分界线（官方新生指南原话）
 */
const AREAS = [
  { id: 'area_north', name: '北区' },
  { id: 'area_south', name: '南区' },
  { id: 'area_center', name: '中心区' },
  { id: 'area_east', name: '东区' },
  { id: 'area_west', name: '西区' }
];

/**
 * 地点清单
 * 字段：id / name / area / cate / lat / lng / aliases / verified / note
 */
const LOCATIONS = [
  /* ==================== 校门 ==================== */
  { id: 'gate_e', name: '东门', area: 'area_east', cate: 'gate', lat: 31.4823, lng: 120.277009, verified: true,
    aliases: ['东门', '东校门', '学校东门', '正东门', '校东门'],
    note: '新生报到入口，进门可见校名石与青铜鼎' },
  { id: 'gate_ne', name: '东北门', area: 'area_north', cate: 'gate', lat: 31.488417, lng: 120.277232, verified: true,
    aliases: ['东北门', '东北校门'] },
  { id: 'gate_n', name: '北门', area: 'area_north', cate: 'gate', lat: 31.491566, lng: 120.273, verified: true,
    aliases: ['北门', '北校门', '后门'] },
  { id: 'gate_s', name: '南门', area: 'area_south', cate: 'gate', lat: 31.474755, lng: 120.272796, verified: true,
    aliases: ['南门', '南校门', '正南门'] },

  /* ==================== 图书馆与教学 ==================== */
  { id: 'lib', name: '图书馆', area: 'area_center', cate: 'learning', lat: 31.4839, lng: 120.2721, verified: false,
    aliases: ['图书馆', '图书馆二楼', '图书馆三楼', '图书馆一楼', '图书馆自习室', '阅览室', '书库', '自习室', '图书馆大厅'],
    note: '坐标待校准：按官微描述位于文浩馆以西、小蠡湖以东、一教以南（此处按相对位置估算）。请在图书馆正门用校准工具取点' },
  { id: 'teach1', name: '第一教学楼', area: 'area_center', cate: 'teaching', lat: 31.483275, lng: 120.27432, verified: true,
    aliases: ['第一教学楼', '一教', '教一', '1教', '1号教学楼', '一教楼'] },
  { id: 'teach2', name: '第二教学楼', area: 'area_south', cate: 'teaching', lat: 31.47999, lng: 120.273985, verified: true,
    aliases: ['第二教学楼', '二教', '教二', '2教', '2号教学楼', '二教楼'] },
  { id: 'yifu', name: '逸夫楼', area: 'area_center', cate: 'teaching', lat: 31.484144, lng: 120.269593, verified: true,
    aliases: ['逸夫楼', '逸夫教学楼'] },
  { id: 'wenhao', name: '文浩馆', area: 'area_center', cate: 'public', lat: 31.482814, lng: 120.276043, verified: true,
    aliases: ['文浩馆', '文浩报告厅', '报告厅', '文浩厅'],
    note: '讲座、迎新晚会、毕业晚会举办地' },
  { id: 'admin_bldg', name: '行政楼', area: 'area_center', cate: 'public', lat: 31.481395, lng: 120.276135, verified: true,
    aliases: ['行政楼', '办公楼', '校办公楼', '办公楼宇'] },
  { id: 'renwen', name: '人文学院（田家炳楼）', area: 'area_center', cate: 'teaching', lat: 31.484313, lng: 120.274772, verified: true,
    aliases: ['人文学院', '田家炳楼', '田家炳', '人文楼'] },
  { id: 'science', name: '理学院', area: 'area_center', cate: 'teaching', lat: 31.48457, lng: 120.273986, verified: true,
    aliases: ['理学院', '数理学院'] },
  { id: 'mech', name: '机械工程学院', area: 'area_west', cate: 'teaching', lat: 31.484925, lng: 120.269485, verified: true,
    aliases: ['机械工程学院', '机械学院', '机械楼'] },
  { id: 'iot', name: '物联网工程学院', area: 'area_center', cate: 'teaching', lat: 31.48375, lng: 120.271284, verified: true,
    aliases: ['物联网工程学院', '物联网学院', '物联学院', '物联网'] },
  { id: 'textile', name: '纺织服装学院', area: 'area_west', cate: 'teaching', lat: 31.486361, lng: 120.269463, verified: true,
    aliases: ['纺织服装学院', '纺服学院', '纺织学院'] },
  { id: 'design', name: '设计学院', area: 'area_center', cate: 'teaching', lat: 31.486135, lng: 120.2712, verified: true,
    aliases: ['设计学院', '设计院', '设计楼'] },
  { id: 'art', name: '艺术系（人文学院）', area: 'area_center', cate: 'teaching', lat: 31.486649, lng: 120.271363, verified: true,
    aliases: ['人文学院艺术系', '艺术系', '艺术楼'] },
  { id: 'chem', name: '化工学院', area: 'area_south', cate: 'teaching', lat: 31.480208, lng: 120.269508, verified: true,
    aliases: ['化工学院', '化学与材料工程学院', '化学院'] },
  { id: 'food_college', name: '食品学院', area: 'area_south', cate: 'teaching', lat: 31.479659, lng: 120.268642, verified: true,
    aliases: ['食品学院', '食品科学', '食品楼'] },
  { id: 'bio', name: '生物工程学院', area: 'area_south', cate: 'teaching', lat: 31.47901, lng: 120.268766, verified: true,
    aliases: ['生物工程学院', '生工学院', '生工楼', '生物工程'] },
  { id: 'pharmacy', name: '生命科学与健康工程学院', area: 'area_south', cate: 'teaching', lat: 31.48052, lng: 120.268284, verified: true,
    aliases: ['生命科学与健康工程学院', '药学院', '健康工程学院', '生命科学学院'] },
  { id: 'medicine', name: '医学院', area: 'area_west', cate: 'teaching', lat: 31.481583, lng: 120.266916, verified: true,
    aliases: ['医学院', '无锡医学院', '医学楼'] },
  { id: 'business', name: '商学院', area: 'area_south', cate: 'teaching', lat: 31.478963, lng: 120.276106, verified: true,
    aliases: ['商学院', '管理学院', '商院'] },
  { id: 'ai', name: '人工智能与计算机学院', area: 'area_south', cate: 'teaching', lat: 31.478198, lng: 120.276013, verified: true,
    aliases: ['人工智能与计算机学院', '计算机学院', '人工智能学院', '计科院', '计算机楼'] },
  { id: 'foreign', name: '外国语学院', area: 'area_south', cate: 'teaching', lat: 31.479748, lng: 120.276195, verified: true,
    aliases: ['外国语学院', '外语学院', '外院'] },
  { id: 'law', name: '法学院', area: 'area_south', cate: 'teaching', lat: 31.479704, lng: 120.27568, verified: true,
    aliases: ['法学院', '法学楼'] },
  { id: 'marx', name: '马克思主义学院', area: 'area_south', cate: 'teaching', lat: 31.480069, lng: 120.275998, verified: true,
    aliases: ['马克思主义学院', '马院'] },
  { id: 'na_edu', name: '北美学院', area: 'area_south', cate: 'teaching', lat: 31.479442, lng: 120.27642, verified: true,
    aliases: ['北美学院', '国际教育学院'] },
  { id: 'cce', name: '继续教育与网络教育学院', area: 'area_north', cate: 'teaching', lat: 31.488076, lng: 120.272074, verified: true,
    aliases: ['继续教育与网络教育学院', '继教院', '网教院', '继续教育学院'] },
  { id: 'skl', name: '国家重点实验室', area: 'area_south', cate: 'teaching', lat: 31.478631, lng: 120.269685, verified: true,
    aliases: ['国家重点实验室', '食品国重', '国重实验室'] },
  { id: 'ferment_lab', name: '粮食发酵国家工程实验室', area: 'area_south', cate: 'teaching', lat: 31.479954, lng: 120.266851, verified: true,
    aliases: ['粮食发酵工艺与技术国家工程实验室', '发酵实验室', '国家工程实验室', '发酵工程'] },
  { id: 'innovation', name: '协同创新中心', area: 'area_south', cate: 'teaching', lat: 31.478633, lng: 120.266652, verified: true,
    aliases: ['协同创新中心', '创新中心'] },
  { id: 'hazmat', name: '实验物资与危险品仓库', area: 'area_west', cate: 'public', lat: 31.486068, lng: 120.266885, verified: true,
    aliases: ['实验物资与危险品仓库', '危险品仓库', '仓库'] },

  /* ==================== 食堂 ==================== */
  { id: 'canteen1', name: '第一食堂（江南苑）', area: 'area_north', cate: 'food', lat: 31.488818, lng: 120.271347, verified: true,
    aliases: ['第一食堂', '一食堂', '一餐', '江南苑', '1食堂', '1餐'] },
  { id: 'canteen2', name: '第二食堂（梁溪苑）', area: 'area_north', cate: 'food', lat: 31.489769, lng: 120.265813, verified: true,
    aliases: ['第二食堂', '二食堂', '二餐', '梁溪苑', '2食堂', '2餐'],
    note: '旁边是大众书局，倚靠濠上亭，对面是清名桥与听雨轩' },
  { id: 'canteen3', name: '第三食堂（教工活动中心）', area: 'area_south', cate: 'food', lat: 31.477281, lng: 120.271957, verified: true,
    aliases: ['第三食堂', '三食堂', '三餐', '教工餐厅', '3食堂', '3餐', '教工活动中心'] },
  { id: 'canteen4', name: '第四食堂（广溪苑）', area: 'area_south', cate: 'food', lat: 31.476373, lng: 120.274641, verified: true,
    aliases: ['第四食堂', '四食堂', '四餐', '广溪苑', '4食堂', '4餐'] },

  /* ==================== 体育 ==================== */
  { id: 'gym', name: '体育中心', area: 'area_north', cate: 'sport', lat: 31.487064, lng: 120.275337, verified: true,
    aliases: ['体育中心', '体育馆', '风雨操场'],
    note: '东北角夹竹桃丛后是菜鸟驿站（快递中心）' },
  { id: 'track_n', name: '北区运动场', area: 'area_north', cate: 'sport', lat: 31.486775, lng: 120.265871, verified: true,
    aliases: ['北区运动场', '田径场', '操场', '跑道', '北操场', '运动场'] },
  { id: 'court_n', name: '北区篮球场', area: 'area_north', cate: 'sport', lat: 31.487229, lng: 120.264875, verified: true,
    aliases: ['北区篮球场', '篮球场', '北篮球场'] },
  { id: 'tennis_n', name: '北区网球场', area: 'area_north', cate: 'sport', lat: 31.487719, lng: 120.264171, verified: true,
    aliases: ['北区网球场', '网球场'] },
  { id: 'tennis_c', name: '中心网球场', area: 'area_center', cate: 'sport', lat: 31.486715, lng: 120.273566, verified: true,
    aliases: ['中心网球场', '教学区网球场'] },
  { id: 'pool', name: '游泳池', area: 'area_north', cate: 'sport', lat: 31.486369, lng: 120.276715, verified: true,
    aliases: ['游泳池', '游泳馆'] },
  { id: 'football', name: '足球训练场', area: 'area_north', cate: 'sport', lat: 31.487168, lng: 120.27672, verified: true,
    aliases: ['足球训练场', '足球场'] },
  { id: 'court_s', name: '南区运动场', area: 'area_south', cate: 'sport', lat: 31.477549, lng: 120.276012, verified: true,
    aliases: ['南区运动场', '南篮球场', '南运动场', '南区球场'] },

  /* ==================== 生活服务 ==================== */
  { id: 'student_center', name: '大学生活动中心', area: 'area_center', cate: 'public', lat: 31.487005, lng: 120.271245, verified: true,
    aliases: ['大学生活动中心', '大活', '学生活动中心'] },
  { id: 'activity_center', name: '活动中心', area: 'area_north', cate: 'public', lat: 31.48747, lng: 120.272188, verified: true,
    aliases: ['活动中心', '社团活动中心'] },
  { id: 'express', name: '快递中心（菜鸟驿站）', area: 'area_north', cate: 'public', lat: 31.489008, lng: 120.276671, verified: true,
    aliases: ['快递中心', '菜鸟驿站', '快递站', '取快递', '驿站', '快递点'],
    note: '取件需带校园卡' },
  { id: 'hospital', name: '江南大学校医院', area: 'area_north', cate: 'public', lat: 31.484601, lng: 120.276174, verified: true,
    aliases: ['校医院', '医院', '医务室', '卫生所'] },
  { id: 'post', name: '江南大学邮政支局', area: 'area_center', cate: 'public', lat: 31.481392, lng: 120.275683, verified: true,
    aliases: ['邮政支局', '邮局', '中国邮政', '邮政'] },
  { id: 'bank_icbc', name: '中国工商银行（北区）', area: 'area_center', cate: 'public', lat: 31.481515, lng: 120.275678, verified: true,
    aliases: ['工商银行', '工行', '银行', '北区工行'] },
  { id: 'bank_icbc_s', name: '中国工商银行（南区）', area: 'area_south', cate: 'public', lat: 31.475585, lng: 120.272614, verified: true,
    aliases: ['南区工商银行', '南区工行', '工商银行南区'] },
  { id: 'market', name: '校园超市', area: 'area_north', cate: 'public', lat: 31.4892, lng: 120.2702, verified: false,
    aliases: ['校园超市', '超市', '便利店', '教育超市', '小超市'],
    note: '坐标待校准：北区一食堂附近的校园超市' },
  { id: 'bathhouse', name: '浴室', area: 'area_north', cate: 'public', lat: 31.4896, lng: 120.2688, verified: false,
    aliases: ['浴室', '澡堂', '公共浴室', '洗浴中心'],
    note: '坐标待校准：请按实际浴室位置取点' },
  { id: 'bus_stop', name: '校车站', area: 'area_east', cate: 'road', lat: 31.4836, lng: 120.2766, verified: false,
    aliases: ['校车站', '班车站', '公交站', '校车点', '校车'],
    note: '坐标待校准：东门附近的校车/公交站' },

  /* ==================== 宿舍园区 ==================== */
  { id: 'dorm_north', name: '北区宿舍园区', area: 'area_north', cate: 'dorm', lat: 31.4903, lng: 120.2695, verified: false,
    aliases: ['北区宿舍', '北区寝室', '北区公寓', '宿舍'],
    note: '坐标待校准：北区宿舍（杏园/李园等）成片分布在一食堂、二食堂附近，请按实际园区取点' },
  { id: 'dorm_south', name: '南区宿舍园区', area: 'area_south', cate: 'dorm', lat: 31.4771, lng: 120.2712, verified: false,
    aliases: ['南区宿舍', '南区寝室', '南区公寓'],
    note: '坐标待校准：南区宿舍（桃园/桂园等）集中在三食堂、四食堂周边' },
  { id: 'dorm_teacher', name: '青教公寓', area: 'area_north', cate: 'dorm', lat: 31.488805, lng: 120.275113, verified: true,
    aliases: ['青教公寓', '青年教师公寓', '教师公寓'] },
  { id: 'dorm_intl', name: '留学生公寓', area: 'area_south', cate: 'dorm', lat: 31.475328, lng: 120.27351, verified: true,
    aliases: ['留学生公寓', '国际学生公寓', '留学生楼'] },

  /* ==================== 其他 ==================== */
  { id: 'hotel', name: '长广溪宾馆', area: 'area_north', cate: 'public', lat: 31.490216, lng: 120.26425, verified: true,
    aliases: ['长广溪宾馆', '宾馆', '招待所'] },
  { id: 'repair', name: '维修厂', area: 'area_south', cate: 'public', lat: 31.475566, lng: 120.269669, verified: true,
    aliases: ['维修厂', '后勤维修'] },
  { id: 'parking', name: '停车棚', area: 'area_center', cate: 'road', lat: 31.4848, lng: 120.2729, verified: false,
    aliases: ['停车棚', '车棚', '自行车棚', '电动车棚', '停车场'],
    note: '坐标待校准：教学区周边的自行车/电动车棚' },

  /* ==================== 道路 ==================== */
  { id: 'road_central', name: '中央大道', area: 'area_center', cate: 'road', lat: 31.486398, lng: 120.272604, verified: true,
    aliases: ['中央大道', '主干道', '主路', '大道', '路上', '校园路'] },
  { id: 'road_jiangnan', name: '江南大道', area: 'area_center', cate: 'road', lat: 31.482015, lng: 120.274402, verified: true,
    aliases: ['江南大道'] },
  { id: 'road_emei', name: '峨眉山路', area: 'area_south', cate: 'road', lat: 31.477882, lng: 120.269542, verified: true,
    aliases: ['峨眉山路', '樱花大道'],
    note: '春季樱花大道' },
  { id: 'road_huangshan', name: '黄山路', area: 'area_north', cate: 'road', lat: 31.485065, lng: 120.27537, verified: true,
    aliases: ['黄山路'] },
  { id: 'road_taishan', name: '泰山路', area: 'area_north', cate: 'road', lat: 31.488386, lng: 120.27484, verified: true,
    aliases: ['泰山路'] },
  { id: 'road_sanjiang', name: '三江路', area: 'area_west', cate: 'road', lat: 31.485823, lng: 120.266511, verified: true,
    aliases: ['三江路'] },
  { id: 'road_liangjiang', name: '两江路', area: 'area_center', cate: 'road', lat: 31.482905, lng: 120.275353, verified: true,
    aliases: ['两江路'] },
  { id: 'road_tianshan', name: '天山路', area: 'area_north', cate: 'road', lat: 31.4907, lng: 120.267599, verified: true,
    aliases: ['天山路'] },
  { id: 'road_wuyishan', name: '武夷山路', area: 'area_south', cate: 'road', lat: 31.479251, lng: 120.271679, verified: true,
    aliases: ['武夷山路'] },
  { id: 'road_huashan', name: '华山路', area: 'area_center', cate: 'road', lat: 31.483801, lng: 120.274407, verified: true,
    aliases: ['华山路'] },
  { id: 'road_songshan', name: '嵩山路', area: 'area_north', cate: 'road', lat: 31.48719, lng: 120.271404, verified: true,
    aliases: ['嵩山路'] },
  { id: 'road_jinggangshan', name: '井冈山路', area: 'area_center', cate: 'road', lat: 31.484466, lng: 120.270286, verified: true,
    aliases: ['井冈山路'] },
  { id: 'road_qingshanwan', name: '青山湾路', area: 'area_center', cate: 'road', lat: 31.483534, lng: 120.273464, verified: true,
    aliases: ['青山湾路'] },
  { id: 'road_tianmushan', name: '天目山路', area: 'area_south', cate: 'road', lat: 31.474807, lng: 120.273635, verified: true,
    aliases: ['天目山路'] },
  { id: 'road_north_college', name: '北学院路', area: 'area_north', cate: 'road', lat: 31.487476, lng: 120.270476, verified: true,
    aliases: ['北学院路', '北学院街'] },
  { id: 'road_south_college', name: '南学院街', area: 'area_south', cate: 'road', lat: 31.479354, lng: 120.269314, verified: true,
    aliases: ['南学院街', '南学院路'] },

  /* ==================== 桥与景观 ==================== */
  { id: 'bridge_qushui', name: '曲水桥', area: 'area_center', cate: 'scenic', lat: 31.480987, lng: 120.272524, verified: true,
    aliases: ['曲水桥', '曲水流觞', '南北分界桥', '分界桥'],
    note: '南北区分界线；春看燕舞莺啼，夏有荷塘' },
  { id: 'bridge_donglin', name: '东林桥', area: 'area_north', cate: 'scenic', lat: 31.48836, lng: 120.272408, verified: true,
    aliases: ['东林桥'] },
  { id: 'bridge_jixin', name: '即心桥', area: 'area_center', cate: 'scenic', lat: 31.482763, lng: 120.268532, verified: true,
    aliases: ['即心桥'],
    note: '西边的即心桥，暮色里曼妙宁静' },
  { id: 'bridge_zhengxin', name: '正心桥', area: 'area_center', cate: 'scenic', lat: 31.480682, lng: 120.275336, verified: true,
    aliases: ['正心桥'] },
  { id: 'bridge_yunshui', name: '云水桥', area: 'area_south', cate: 'scenic', lat: 31.477877, lng: 120.272524, verified: true,
    aliases: ['云水桥'] },
  { id: 'bridge_yuying', name: '育英桥', area: 'area_south', cate: 'scenic', lat: 31.479254, lng: 120.270841, verified: true,
    aliases: ['育英桥'] },
  { id: 'bridge_siyuan', name: '思源桥', area: 'area_south', cate: 'scenic', lat: 31.479247, lng: 120.272533, verified: true,
    aliases: ['思源桥'] },
  { id: 'bridge_dongxing', name: '东行桥', area: 'area_south', cate: 'scenic', lat: 31.477883, lng: 120.27117, verified: true,
    aliases: ['东行桥'] },
  { id: 'bridge_wenchang', name: '文昌桥', area: 'area_north', cate: 'scenic', lat: 31.48706, lng: 120.272456, verified: true,
    aliases: ['文昌桥'] },
  { id: 'chimatei', name: '赤马咀遗址', area: 'area_south', cate: 'scenic', lat: 31.47935, lng: 120.271749, verified: true,
    aliases: ['赤马咀', '赤马嘴', '赤马咀遗址'] },
  { id: 'ting_shiji', name: '史记亭', area: 'area_center', cate: 'scenic', lat: 31.480357, lng: 120.272617, verified: true,
    aliases: ['史记亭', '亭子'] },
  { id: 'lake_xiaoli', name: '小蠡湖', area: 'area_center', cate: 'scenic', lat: 31.483, lng: 120.2705, verified: false,
    aliases: ['小蠡湖', '湖边', '湖畔', '湖'],
    note: '坐标待校准：图书馆西侧的水面' },
  { id: 'xuehai_stone', name: '学海无涯石', area: 'area_center', cate: 'scenic', lat: 31.4835, lng: 120.2709, verified: false,
    aliases: ['学海无涯石', '学海无涯', '打卡石', '校名石'],
    note: '坐标待校准：图书馆西边，吉祥物小鼋所在处' }
];

module.exports = {
  META,
  AREAS,
  LOCATIONS
};
