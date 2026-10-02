/**
 * 页面生命周期冒烟测试
 * ---------------------------------------------------------------
 *   node tests/run-pages.test.js
 *
 * 为什么需要它：
 *   前面的测试只覆盖 utils / core / 云函数，
 *   但「页面白屏」这类问题出在 Page 的 onLoad / onShow 里——
 *   比如访问了 undefined 的属性、调用不存在的方法、依赖未初始化的数据。
 *   这类错误在 Node 里不做任何检查就完全测不到。
 *
 * 做法：stub 出 Page / getApp / wx，加载每个页面的 .js，
 *      拿到页面配置后按真实顺序调用生命周期，并捕获异常。
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

/* ===================== 微信环境替身 ===================== */

const storage = {};
const calls = { toast: [], modal: [], navigate: [], switchTab: [], loading: [] };
let currentPageConfig = null;

/** 弹窗替身的行为开关：测试可设为 true 以模拟用户点击「确定」 */
const modalBehavior = { confirm: false };

function makeWxStub() {
  return {
    setStorageSync: (k, v) => { storage[k] = v; },
    getStorageSync: (k) => storage[k],
    removeStorageSync: (k) => { delete storage[k]; },

    showToast: (o) => calls.toast.push(o && o.title),
    hideToast: () => {},
    showModal: (o) => {
      calls.modal.push(o && o.title);
      if (o && o.success) o.success({ confirm: modalBehavior.confirm, cancel: !modalBehavior.confirm });
    },
    showLoading: (o) => calls.loading.push(o && o.title),
    hideLoading: () => {},
    showActionSheet: (o) => { if (o && o.fail) o.fail({ errMsg: 'cancel' }); },
    stopPullDownRefresh: () => {},

    navigateTo: (o) => calls.navigate.push(o && o.url),
    redirectTo: (o) => calls.navigate.push(o && o.url),
    switchTab: (o) => calls.switchTab.push(o && o.url),
    navigateBack: () => {},

    setNavigationBarTitle: () => {},
    setClipboardData: (o) => { if (o && o.success) o.success(); },
    previewImage: () => {},
    chooseMedia: (o) => { if (o && o.fail) o.fail({ errMsg: 'cancel' }); },
    chooseLocation: (o) => { if (o && o.fail) o.fail({ errMsg: 'cancel' }); },

    // 云开发不可用 → 走本地模式，避免测试依赖网络
    cloud: undefined
  };
}

global.wx = makeWxStub();

/** Page 注册：把配置存下来供测试调用 */
global.Page = function (config) { currentPageConfig = config; };
global.Component = function (config) { currentPageConfig = config; };
global.getApp = () => global.__app;

const appService = require(path.join(ROOT, 'utils/service.js'));
const store = require(path.join(ROOT, 'utils/store.js'));

/* 构造一个接近真实的 app 实例 */
global.__app = {
  globalData: {
    userInfo: null,
    userId: 'u_me',
    mode: 'local',
    ready: true,
    bootError: '',
    activeLostId: '',
    locationVersion: 2,
    pendingParams: null
  },
  refresh: () => Promise.resolve(false),
  boot: () => Promise.resolve()
};

/* ===================== 测试框架 ===================== */

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed += 1;
    failures.push({ name, error: e });
    console.log('  ✗ ' + name);
    console.log('    → ' + String(e && e.message).split('\n')[0]);
  }
}

function group(title) {
  console.log('\n' + title);
}

/** 加载页面配置（每个页面只加载一次，但每次测试都用新的实例状态） */
function loadPage(rel) {
  const file = path.join(ROOT, rel);
  delete require.cache[require.resolve(file)];
  currentPageConfig = null;
  require(file);
  if (!currentPageConfig) throw new Error('页面没有调用 Page()：' + rel);
  return currentPageConfig;
}

/**
 * 创建一个页面实例：模拟微信把 methods / data 挂到实例上
 */
function instantiate(config) {
  const inst = Object.assign({}, config);
  inst.data = JSON.parse(JSON.stringify(config.data || {}));
  inst.setData = function (patch, cb) {
    Object.assign(inst.data, patch);
    if (typeof cb === 'function') cb();
  };
  return inst;
}

/** 按真实顺序跑生命周期；同时把页面里的异步操作跑完 */
async function runLifecycle(inst, query, events) {
  const seq = events || ['onLoad', 'onShow'];
  for (let i = 0; i < seq.length; i += 1) {
    const fn = inst[seq[i]];
    if (typeof fn !== 'function') continue;
    await fn.call(inst, query || {});
    // 让 setData / promise 链跑完
    await new Promise((r) => setTimeout(r, 0));
  }
  return inst;
}

/** 找出页面 data 里被 WXML 用到、但从未定义的字段（潜在白屏/空白原因） */
function checkDataBindings(pageRel, config) {
  const wxmlFile = path.join(ROOT, pageRel.replace(/\.js$/, '.wxml'));
  if (!fs.existsSync(wxmlFile)) return [];
  const wxml = fs.readFileSync(wxmlFile, 'utf8');
  const used = new Set();
  const re = /\{\{\s*([a-zA-Z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(wxml)) !== null) used.add(m[1]);

  const own = new Set(Object.keys(config.data || {}));
  const methods = new Set();
  Object.keys(config).forEach((k) => { if (typeof config[k] === 'function') methods.add(k); });

  // wx:for 的作用域变量：默认 item/index，以及 wx:for-item / wx:for-index 自定义的别名。
  // 不排除这些会把 <text wx:for-item="tag">{{tag}}</text> 误报成"未定义变量"。
  const forItemRe = /wx:for-item\s*=\s*"([^"]+)"/g;
  const forIndexRe = /wx:for-index\s*=\s*"([^"]+)"/g;
  while ((m = forItemRe.exec(wxml)) !== null) own.add(m[1]);
  while ((m = forIndexRe.exec(wxml)) !== null) own.add(m[1]);
  // wx:for 嵌套时可能用到的作用域名
  ['item', 'index', 'idx', 'it', 'key', 'value', 'true', 'false', 'null', 'undefined']
    .forEach((x) => own.add(x));

  const missing = [];
  used.forEach((u) => {
    if (!own.has(u) && !methods.has(u)) missing.push(u);
  });
  return missing;
}

/* ===================== 前置：灌本地演示数据 ===================== */

store.init();
require(path.join(ROOT, 'mock/seed.js')).ensureSeed();

/* ===================== 测试主体 ===================== */

const PAGES = [
  { rel: 'pages/home/home.js', name: '首页', query: {} },
  { rel: 'pages/matches/matches.js', name: '匹配列表', query: { itemId: 'lost_cup_01' } },
  { rel: 'pages/map/map.js', name: '地图', query: {} },
  { rel: 'pages/publish/publish.js', name: '发布页', query: { type: 'lost' } },
  { rel: 'pages/compare/compare.js', name: '详细对比', query: { matchId: 'match_lost_cup_01_found_cup_01', lostId: 'lost_cup_01', foundId: 'found_cup_01' } },
  { rel: 'pages/detail/detail.js', name: '记录详情', query: { id: 'lost_cup_01' } },
  { rel: 'pages/notify/notify.js', name: '消息', query: {} },
  { rel: 'pages/mine/mine.js', name: '我的', query: {} },
  { rel: 'pages/claim/claim.js', name: '认领核验', query: { claimId: '__none__' } },
  { rel: 'pages/admin/admin.js', name: '管理看板', query: {} }
];

async function main() {
  group('1. 页面能否正常加载与渲染数据');

  for (let i = 0; i < PAGES.length; i += 1) {
    const p = PAGES[i];
    await test(p.name + ' 生命周期无异常（onLoad → onShow）', async () => {
      const config = loadPage(p.rel);
      const inst = instantiate(config);
      await runLifecycle(inst, p.query);
      // 渲染后 data 不应为 undefined
      if (inst.data === undefined) throw new Error('页面 data 为 undefined');
      return inst;
    });
  }

  group('2. 页面初始化后关键数据已就绪');

  await test('首页 stats / categories 已填充', async () => {
    const inst = await runLifecycle(instantiate(loadPage('pages/home/home.js')), {});
    if (!inst.data.stats) throw new Error('stats 未填充（首页统计会空白）');
    if (!inst.data.categories || !inst.data.categories.length) throw new Error('categories 未填充（类别区会空白）');
    if (inst.data.stats.lostCount < 1) throw new Error('失物数异常：' + inst.data.stats.lostCount);
  });

  await test('匹配页候选列表非空且卡片字段完整', async () => {
    global.__app.globalData.pendingParams = null;
    const inst = await runLifecycle(
      instantiate(loadPage('pages/matches/matches.js')),
      { itemId: 'lost_cup_01' }
    );
    if (!inst.data.matches.length) throw new Error('候选列表为空');
    const card = inst.data.matches[0];
    ['id', 'percent', 'counterpart', 'reasonTexts', 'scoreBars'].forEach((k) => {
      if (card[k] === undefined) throw new Error('候选卡缺少字段 ' + k);
    });
    if (card.counterpart.hasImage === undefined) throw new Error('counterpart.hasImage 未定义');
  });

  await test('地图页视野参数完整（缺失会导致地图飘到别处）', async () => {
    const inst = await runLifecycle(instantiate(loadPage('pages/map/map.js')), {});
    if (!inst.data.mapCenter || typeof inst.data.mapCenter.lat !== 'number') {
      throw new Error('mapCenter 无效：' + JSON.stringify(inst.data.mapCenter));
    }
    if (!Array.isArray(inst.data.includePoints) || inst.data.includePoints.length < 2) {
      throw new Error('includePoints 无效');
    }
    if (!inst.data.campus || !inst.data.campus.school) throw new Error('campus 信息未填充');
    if (inst.data.mapScale === undefined) throw new Error('mapScale 未定义');
  });

  await test('地图页传给 include-points 的每个点都是合法经纬度', async () => {
    // 真实报错：SystemError (webviewScriptError) 参数错误: LatLng 传入参数 (NaN, NaN) 非合法数字
    // 起因是把 { lat, lng } 直接塞进 include-points（组件只认 latitude / longitude）
    const inst = await runLifecycle(instantiate(loadPage('pages/map/map.js')), {});
    inst.data.includePoints.forEach((p, i) => {
      if (!isFinite(p.latitude) || !isFinite(p.longitude)) {
        throw new Error('includePoints[' + i + '] 不是合法经纬度：' + JSON.stringify(p) +
          '（属性名必须是 latitude / longitude）');
      }
      if (p.lat !== undefined || p.lng !== undefined) {
        throw new Error('includePoints[' + i + '] 用了 lat/lng，组件不认这两个键：' +
          JSON.stringify(p));
      }
    });

    // 范围要落在江南大学蠡湖校区（GCJ-02），避免"飘到别的学校"
    inst.data.includePoints.forEach((p, i) => {
      if (p.latitude < 31.4 || p.latitude > 31.55 ||
          p.longitude < 120.2 || p.longitude > 120.35) {
        throw new Error('includePoints[' + i + '] 落在校区范围外：' + JSON.stringify(p));
      }
    });
  });

  await test('地图页 markers / circles 的坐标都合法', async () => {
    const inst = await runLifecycle(instantiate(loadPage('pages/map/map.js')), {});
    (inst.data.markers || []).forEach((m, i) => {
      if (!isFinite(m.latitude) || !isFinite(m.longitude)) {
        throw new Error('markers[' + i + '] 坐标非法：' + JSON.stringify(m));
      }
    });
    (inst.data.circles || []).forEach((c, i) => {
      if (!isFinite(c.latitude) || !isFinite(c.longitude)) {
        throw new Error('circles[' + i + '] 坐标非法：' + JSON.stringify(c));
      }
      if (!isFinite(c.radius) || c.radius <= 0) {
        throw new Error('circles[' + i + '] 半径非法：' + c.radius);
      }
    });
  });

  await test('切地点 / 重置视野后 mapCenter 仍然合法', async () => {
    const inst = await runLifecycle(instantiate(loadPage('pages/map/map.js')), {});
    if (inst.data.campusSpots.length) {
      inst.onCellTap({ currentTarget: { dataset: { index: 0 } } });
      if (!isFinite(inst.data.mapCenter.lat) || !isFinite(inst.data.mapCenter.lng)) {
        throw new Error('onCellTap 后 mapCenter 非法：' + JSON.stringify(inst.data.mapCenter));
      }
    }
    inst.onResetView();
    if (!isFinite(inst.data.mapCenter.lat) || !isFinite(inst.data.mapCenter.lng)) {
      throw new Error('onResetView 后 mapCenter 非法：' + JSON.stringify(inst.data.mapCenter));
    }
  });

  await test('详细对比页拿到完整对比数据', async () => {
    const inst = await runLifecycle(
      instantiate(loadPage('pages/compare/compare.js')),
      { matchId: 'match_lost_cup_01_found_cup_01', lostId: 'lost_cup_01', foundId: 'found_cup_01' }
    );
    if (!inst.data.detail) throw new Error('detail 为空');
    if (!inst.data.bars || inst.data.bars.length !== 5) throw new Error('分项分数应为 5 项');
    if (!inst.data.attrRows) throw new Error('attrRows 为空');
  });

  await test('我的页三个列表均已就绪', async () => {
    const inst = await runLifecycle(instantiate(loadPage('pages/mine/mine.js')), {});
    ['lostItems', 'foundItems', 'claims', 'stats'].forEach((k) => {
      if (inst.data[k] === undefined) throw new Error('缺少 ' + k);
    });
  });

  await test('管理看板各区块数据均已就绪', async () => {
    const inst = await runLifecycle(instantiate(loadPage('pages/admin/admin.js')), {});
    ['stats', 'quality', 'categoryBars', 'groups', 'campus', 'pendingLocations'].forEach((k) => {
      if (inst.data[k] === undefined) throw new Error('缺少 ' + k);
    });
    if (!inst.data.campus.school) throw new Error('campus 信息未填充');
  });

  group('3. WXML 绑定的变量都在 data 里定义过');

  for (let i = 0; i < PAGES.length; i += 1) {
    const p = PAGES[i];
    await test(p.name + ' 无未定义的模板变量', async () => {
      const config = loadPage(p.rel);
      const missing = checkDataBindings(p.rel, config);
      if (missing.length) {
        throw new Error('WXML 用到但 data 未定义：' + missing.join(', ') +
          '（这些位置会渲染成空白）');
      }
    });
  }

  group('4. 页面里引用的跳转目标都真实存在');

  await test('页面调用的 navigateTo / switchTab 目标合法', async () => {
    const appJson = require(path.join(ROOT, 'app.json'));
    const tabPages = ((appJson.tabBar && appJson.tabBar.list) || []).map((t) => t.pagePath);
    const allPages = appJson.pages || [];
    const bad = [];
    PAGES.forEach((p) => {
      const src = fs.readFileSync(path.join(ROOT, p.rel), 'utf8');
      const re = /url\s*:\s*['"]\/(pages\/[\w/]+)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const target = m[1];
        if (allPages.indexOf(target) < 0) bad.push(p.rel + ' → ' + target);
      }
    });
    if (bad.length) throw new Error('跳转目标未在 app.json 声明：' + bad.join('; '));
    if (!tabPages.length) throw new Error('tabBar 配置为空');
  });

  await test('没有用 navigateTo 跳 tabBar 页面（会静默失败）', async () => {
    // 这个坑踩过两次：首页类别图标点不动、发布成功后「查看候选」没反应。
    // navigateTo 跳 tabBar 页面不报错也不跳转，用户只看到"点了没反应"。
    const appJson = require(path.join(ROOT, 'app.json'));
    const tabPages = ((appJson.tabBar && appJson.tabBar.list) || []).map((t) => t.pagePath);
    const bad = [];

    PAGES.forEach((p) => {
      const src = fs.readFileSync(path.join(ROOT, p.rel), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (line.indexOf('navigateTo') < 0) return;
        // 跳过注释行
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        tabPages.forEach((t) => {
          if (line.indexOf(t) >= 0) {
            bad.push(p.rel + ':' + (i + 1) + ' → ' + t + '（应改用 nav.go）');
          }
        });
      });
    });

    if (bad.length) throw new Error('用 navigateTo 跳 tabBar 页面：' + bad.join('; '));
  });

  group('5. 发布成功后的「查看候选」跳转');

  await test('发布页确认后走 nav.go 并暂存 itemId', async () => {
    // 真实 bug：原本写 wx.navigateTo({ url: '/pages/matches/matches?itemId=...' })，
    // 而「匹配」是 tabBar 页面 → 静默失败 → 用户以为"发布成功但匹配页没更新"。
    const config = loadPage('pages/publish/publish.js');
    const inst = instantiate(config);
    await runLifecycle(inst, { type: 'lost' });

    // 造一条可发布的数据
    inst.data.kind = 'lost';
    inst.data.description = '蓝色折叠雨伞，伞面有白色波点，木质弯柄';
    inst.data.locationId = 'canteen2';
    inst.data.locationText = '第二食堂';
    inst.data.attributes = { category: 'umbrella', main_color: '蓝' };
    inst.data.privateSelected = [];

    // 记录跳转行为，并让弹窗替身模拟「用户点了确定」
    global.__app.globalData.pendingParams = null;
    calls.switchTab.length = 0;
    calls.navigate.length = 0;
    modalBehavior.confirm = true;

    inst.onSubmit();
    modalBehavior.confirm = false;

    // 弹窗替身会自动 confirm，因此跳转应立即发生
    if (calls.switchTab.length === 0) {
      throw new Error('应调用 switchTab 跳转到匹配页，实际没有（' +
        '若用 navigateTo 跳 tabBar 页面会静默失败）');
    }
    const url = calls.switchTab[calls.switchTab.length - 1];
    if (url !== '/pages/matches/matches') {
      throw new Error('switchTab 目标应为 /pages/matches/matches，实际 ' + url);
    }
    const pending = global.__app.globalData.pendingParams;
    if (!pending || !pending.itemId) {
      throw new Error('应把 itemId 暂存到 globalData.pendingParams，实际 ' +
        JSON.stringify(pending));
    }
  });

  /* ===================== 输出 ===================== */

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  console.log('========================================');

  if (failed > 0) {
    console.log('\n失败详情：');
    failures.forEach((f) => {
      console.log('\n· ' + f.name);
      console.log(String((f.error && f.error.stack) || f.error).split('\n').slice(0, 6).join('\n'));
    });
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n测试运行异常：', e);
  process.exit(1);
});
