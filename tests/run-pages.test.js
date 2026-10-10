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

/**
 * 把身份注入点接到 __app，与 app.js 的 onLaunch 行为一致。
 * 服务层的写操作（认领/核验/归还）会带当前身份做授权校验，
 * 不注册的话 identity 只能回落到 u_me，换身份的用例会误判。
 */
require(path.join(ROOT, 'core/identity.js')).register(() => global.__app.globalData.userId);

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
  { rel: 'pages/admin/admin.js', name: '管理看板', query: {} },
  { rel: 'pages/search/search.js', name: '文字图片找物', query: {} }
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

    await inst.onSubmit();
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

  /* ===================== 7. 本轮反馈的 5 个问题的页面级回归 ===================== */

  group('7. 用户反馈问题回归（发布页 / 核验页 / 匹配页）');

  await test('发布页：自定义时间地点的输入框与选择器是不同的区块（避免视觉重叠）', async () => {
    const fsx = require('fs');
    const wxml = fsx.readFileSync(path.join(ROOT, 'pages/publish/publish.wxml'), 'utf8');
    const wxss = fsx.readFileSync(path.join(ROOT, 'pages/publish/publish.wxss'), 'utf8');

    // 手动输入必须包在独立的 subfield 区块里（有分隔线与说明文字）
    const subfields = (wxml.match(/class="subfield"/g) || []).length;
    if (subfields < 2) {
      throw new Error('地点与时间的自定义输入都应包在 .subfield 区块内，实际 ' + subfields + ' 处');
    }
    if (!/\.subfield\s*\{[^}]*border-top/.test(wxss)) {
      throw new Error('.subfield 应有分隔线（border-top），否则两块会看起来粘在一起');
    }
    if (wxml.indexOf('location-input') >= 0) {
      throw new Error('不应再使用旧的 location-input（那个类只有 margin-top，正是重叠的成因）');
    }
  });

  await test('发布页：重新提取只有一个入口，AI 识别使用页面内状态遮罩', async () => {
    const fsx = require('fs');
    const wxml = fsx.readFileSync(path.join(ROOT, 'pages/publish/publish.wxml'), 'utf8');
    const js = fsx.readFileSync(path.join(ROOT, 'pages/publish/publish.js'), 'utf8');

    const rerunButtons = (wxml.match(/bindtap="onRerunExtract"/g) || []).length;
    if (rerunButtons !== 1) {
      throw new Error('发布页应只保留一个“重新提取”按钮，实际 ' + rerunButtons + ' 个');
    }
    if (wxml.indexOf('class="ai-mask"') < 0 || wxml.indexOf('ai-recognizing.mp4') < 0) {
      throw new Error('发布页缺少 AI 自定义识别遮罩或动画素材');
    }
    if (js.indexOf("aiState: 'idle'") < 0 || js.indexOf('beginAiProgress') < 0 || js.indexOf('finishAiProgress') < 0) {
      throw new Error('发布页未定义完整的 AI 状态流程');
    }
    if (js.indexOf("wx.showLoading({ title: 'AI 识别中'") >= 0) {
      throw new Error('AI 识别不应继续使用系统级 wx.showLoading');
    }

    const inst = instantiate(loadPage('pages/publish/publish.js'));
    if (inst.data.aiState !== 'idle') throw new Error('AI 初始状态应为 idle');
    inst.beginAiProgress();
    if (inst.data.aiState !== 'preparing' || !inst.data.extracting) {
      throw new Error('AI 开始时应进入 preparing 状态');
    }
    inst.onAiVideoError();
    if (!inst.data.aiVideoFailed) throw new Error('动画失败后应切换静态降级素材');
    inst.finishAiProgress('fallback', '正在使用本地规则');
    if (inst.data.aiState !== 'fallback') throw new Error('AI 降级状态未生效');
    inst.onUnload();
  });

  await test('发布页：自定义隐藏特征可以删除并恢复（用户反馈「加错了没法撤回」）', async () => {
    const inst = instantiate(loadPage('pages/publish/publish.js'));
    await runLifecycle(inst, { type: 'found' });
    inst.data.attributes = { category: 'cup' };

    // 勾一项类别推荐特征（清空时要靠它验证「删除后可恢复」）
    if (!inst.data.privateSuggestions.length) {
      throw new Error('前置条件：杯子类别应有推荐隐藏特征');
    }
    inst.onTogglePrivate({ currentTarget: { dataset: { value: inst.data.privateSuggestions[0] } } });
    if (inst.data.privateSelected.length !== 1) {
      throw new Error('勾选推荐特征应生效');
    }

    // 添加两条自定义特征
    inst.data.privateCustom = '杯底有一道长划痕';
    inst.onAddPrivateCustom();
    inst.data.privateCustom = '杯盖内侧有贴纸';
    inst.onAddPrivateCustom();
    if (inst.data.privateSelected.length !== 3) {
      throw new Error('应有 1 推荐 + 2 自定义，实际 ' + JSON.stringify(inst.data.privateSelected));
    }
    if (!/^自定义：/.test(inst.data.privateSelected[1])) {
      throw new Error('自定义特征应带统一前缀，实际 ' + inst.data.privateSelected[1]);
    }

    // 删除第一条自定义
    inst.onRemovePrivate({ currentTarget: { dataset: { index: 1 } } });
    if (inst.data.privateSelected.length !== 2 ||
        inst.data.privateSelected.some((x) => x.indexOf('长划痕') >= 0)) {
      throw new Error('删除后不应还有那条，实际 ' + JSON.stringify(inst.data.privateSelected));
    }

    // 重新提取属性时，自定义特征不能被静默丢掉（旧实现前缀判断不匹配会丢）
    inst.data.images = [];
    await inst.recompute(false);
    if (!inst.data.privateSelected.some((x) => x.indexOf('贴纸') >= 0)) {
      throw new Error('重新提取后自定义特征被丢弃了：' + JSON.stringify(inst.data.privateSelected));
    }

    // 全部清空：推荐项进入「可恢复」计数，自定义项直接丢弃
    modalBehavior.confirm = true;
    inst.onClearPrivate();
    modalBehavior.confirm = false;
    if (inst.data.privateSelected.length !== 0) {
      throw new Error('清空后不应还有已选特征');
    }
    if (inst.data.privateDeletedCount < 1) {
      throw new Error('清空推荐项后应记录可恢复的删除数，实际 ' + inst.data.privateDeletedCount);
    }

    // 恢复：推荐项应重新出现在候选里
    const suggested = inst.data.privateSuggestions;
    inst.onRestorePrivate();
    if (inst.data.privateDeletedCount !== 0) {
      throw new Error('恢复后删除计数应清零');
    }
    if (inst.data.privateSuggestions.length < suggested.length) {
      throw new Error('恢复后推荐特征应回到候选列表');
    }
  });

  await test('核验页：快捷选项互斥、可取消，选中后有据实提示', async () => {
    const appService = require(path.join(ROOT, 'utils/service.js'));
    const st = require(path.join(ROOT, 'utils/store.js'));
    st.init();

    // 自己去开一张处于「待回答」状态的新认领单（认领只能由失主本人发起）
    let claim = null;
    st.itemsOf('lost').some((l) => {
      const views = appService.candidatesForLost(l.id, { topK: 20, minScore: 0.3 }).views;
      const fresh = views.find((v) => !st.byMatch(v.id));
      if (!fresh) return false;
      const started = appService.startClaim(fresh.id, { userId: l.userId });
      if (started.ok) { claim = started.claim; return true; }
      return false;
    });
    if (!claim) throw new Error('前置条件：应能开出一张待回答的认领单');

    const config = loadPage('pages/claim/claim.js');
    const inst = instantiate(config);
    await runLifecycle(inst, { claimId: claim.id });

    if (!inst.data.answers.length) throw new Error('应有核验问题');
    const pick = (i, v) => inst.onPickOption({ currentTarget: { dataset: { index: i, value: v } } });

    pick(0, '有');
    if (inst.data.answers[0].value !== '有' || inst.data.answers[0].choice !== '有') {
      throw new Error('Q1 选「有」应生效，实际 ' + JSON.stringify(inst.data.answers[0]));
    }
    // 同一题换一个选项必须能改（问题 3 的核心：不能只认第一个）
    pick(0, '没有');
    if (inst.data.answers[0].value !== '没有') {
      throw new Error('Q1 应能从「有」改成「没有」，实际 ' + inst.data.answers[0].value);
    }
    pick(1, '不确定');
    if (inst.data.answers[1].value !== '不确定' || inst.data.answers[0].value !== '没有') {
      throw new Error('各题的选项必须互相独立，实际 ' + JSON.stringify(inst.data.answers.map((a) => a.value)));
    }
    if (inst.data.answers[1].detailed !== false) {
      throw new Error('只点选项不算「补充了细节」，应给出低分提示');
    }
    // 再点同一项 = 取消
    pick(1, '不确定');
    if (inst.data.answers[1].value !== '') {
      throw new Error('再点同一项应取消选择，实际 ' + inst.data.answers[1].value);
    }
    // 补一句细节后 detailed 应为 true
    inst.onAnswerInput({ currentTarget: { dataset: { index: 0 } }, detail: { value: '杯底有一道三厘米划痕' } });
    if (inst.data.answers[0].detailed !== true) {
      throw new Error('具体描述应被认定为已补充细节');
    }
  });

  await test('匹配页：已排除候选从主列表移除，并出现在「已排除」筛选里', async () => {
    const appService = require(path.join(ROOT, 'utils/service.js'));
    const st = require(path.join(ROOT, 'utils/store.js'));
    st.init();

    const lost = st.itemsOf('lost').filter((l) => {
      const v = appService.candidatesForLost(l.id, { topK: 20, minScore: 0.3 }).views;
      return v.length >= 2;
    })[0];
    if (!lost) throw new Error('前置条件：应有候选数 ≥2 的失物');

    const before = appService.candidatesForLost(lost.id, { topK: 20, minScore: 0.3 }).views;
    const target = before[0];
    appService.rejectMatch(target.id, '页面回归测试', {
      lostId: lost.id, foundId: target.foundId, score: target.score, passed: target.passed
    });

    const config = loadPage('pages/matches/matches.js');
    const inst = instantiate(config);
    global.__app.globalData.pendingParams = null;
    await runLifecycle(inst, { itemId: lost.id });

    if (inst.data.matches.some((m) => m.id === target.id)) {
      throw new Error('已排除的候选不应还在主列表里（这正是「界面没有任何变化」的原因）');
    }
    if (inst.data.excludedCount < 1) {
      throw new Error('应统计出已排除数量并在界面上提示，实际 ' + inst.data.excludedCount);
    }
    if (!inst.data.excluded.some((m) => m.id === target.id)) {
      throw new Error('已排除列表里应能找到它');
    }

    // 切到「已排除」页签应能看到，并能撤销
    inst.onShowExcluded();
    if (!inst.data.matches.some((m) => m.id === target.id)) {
      throw new Error('「已排除」筛选下应显示该候选');
    }
    const excludedCard = inst.data.matches.find((m) => m.id === target.id);
    if (excludedCard.statusLabel !== '已排除') {
      throw new Error('卡片应带「已排除」标记，实际 ' + excludedCard.statusLabel);
    }

    appService.restoreMatch(target.id, { lostId: lost.id, foundId: target.foundId });
    inst.refresh();
    if (!inst.data.matches.some((m) => m.id === target.id) && inst.data.filterKey === 'rejected') {
      // 撤销后仍停在「已排除」页签，此时它应已不在列表里
    }
    inst.setData({ filterKey: 'all' });
    inst.refresh();
    if (!inst.data.matches.some((m) => m.id === target.id)) {
      throw new Error('撤销后候选应回到主列表');
    }
  });

  await test('核验页：提交回答后开启临时会话，能发消息并渲染', async () => {
    const appService = require(path.join(ROOT, 'utils/service.js'));
    const st = require(path.join(ROOT, 'utils/store.js'));
    const identity = require(path.join(ROOT, 'core/identity.js'));
    st.init();

    // 找一条「状态活跃 + 没有进行中认领单」的失物的新候选
    // （新增了两条守卫：一物一单、已找回/关闭不受理，测试必须先满足前置条件）
    const ACTIVE = ['answering', 'submitted', 'verified'];
    // 先把演示数据恢复到干净状态，避免被前面用例消耗掉候选
    st.reset(() => {});
    require(path.join(ROOT, 'mock/seed.js')).ensureSeed();
    let target = null;
    let owner = null;
    st.itemsOf('lost').some((l) => {
      if (l.status === 'recovered' || l.status === 'closed') return false;
      if (st.claimsOfLost(l.id).some((c) => ACTIVE.indexOf(c.status) >= 0)) return false;
      const views = appService.candidatesForLost(l.id, { topK: 20, minScore: 0.3 }).views;
      // 双方必须是不同的人，否则 claimantId === keeperId，会话视图没有「对方」
      const fresh = views.find((v) => !st.byMatch(v.id) && v.found.userId !== l.userId);
      if (fresh) { target = fresh; owner = l; return true; }
      return false;
    });
    if (!target) throw new Error('前置条件：应有尚未发起认领的候选');

    /**
     * 以失主身份操作：认领、提交核验都要求调用方就是失主本人
     * （页面读 app.globalData.userId，所以这里切全局身份，而不是改 payload）。
     */
    global.__app.globalData.userId = owner.userId;
    const started = appService.startClaim(target.id);
    if (!started.ok) throw new Error('发起认领失败：' + started.message);
    const claimId = started.claim.id;

    const config = loadPage('pages/claim/claim.js');
    const inst = instantiate(config);
    await runLifecycle(inst, { claimId });
    if (inst.data.myRole !== 'claimant') {
      throw new Error('失主本人进来应是 claimant，实际 ' + inst.data.myRole);
    }

    // answering 阶段不该暴露会话
    if (inst.data.session && inst.data.session.state !== 'closed') {
      throw new Error('未提交核验前不应开启会话');
    }
    // 提交核验
    inst.data.answers = inst.data.answers.map((a) => Object.assign({}, a, {
      value: '杯底有一道大约三厘米的纵向划痕'
    }));
    modalBehavior.confirm = false;
    await inst.onSubmit();

    const after = instantiate(loadPage('pages/claim/claim.js'));
    await runLifecycle(after, { claimId });
    if (!after.data.session || after.data.session.state !== 'open') {
      throw new Error('提交核验后会话应开启，实际 ' + JSON.stringify(after.data.session && after.data.session.state));
    }
    if (!after.data.session.canSend) throw new Error('提交核验后应允许发送消息');
    if (after.data.session.counterpartLabel !== '拾物者' && after.data.session.counterpartLabel !== '失主') {
      throw new Error('应标明对方身份，实际 ' + after.data.session.counterpartLabel);
    }

    after.data.messageDraft = '明天中午12:30 图书馆一楼服务台';
    await after.onSendMessage();
    if (!after.data.session.hasMessages) {
      throw new Error('发送后应能看到消息');
    }
    const last = after.data.session.messages[after.data.session.messages.length - 1];
    if (!last.mine) throw new Error('自己发的消息应标记 mine');
    if (last.text.indexOf('12:30') < 0) throw new Error('消息内容应被保留');
    if (after.data.messageDraft !== '' && after.data.messageDraft !== undefined && after.data.scrollTarget === '') {
      throw new Error('发送后应把滚动定位到最新消息');
    }

    // 换一个与本次认领无关的身份进来：不该看到核验问答，也不该能操作
    global.__app.globalData.userId = 'u_admin' === owner.userId ? 'u_chen' : 'u_admin';
    const outsider = instantiate(loadPage('pages/claim/claim.js'));
    await runLifecycle(outsider, { claimId });
    if (outsider.data.myRole !== 'none') {
      throw new Error('无关身份应被判为 none，实际 ' + outsider.data.myRole);
    }
    if (outsider.data.session && outsider.data.session.state !== 'closed') {
      throw new Error('无关身份不应看到会话');
    }

    global.__app.globalData.userId = 'u_me';
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
