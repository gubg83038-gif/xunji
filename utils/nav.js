/**
 * 页面跳转工具
 * ---------------------------------------------------------------
 * 存在的必要：小程序里 tabBar 页面**只能用 wx.switchTab 跳转**，
 * 用 wx.navigateTo 会静默失败（不跳转、不报错，用户看到的就是“点了没反应”）。
 * 而 wx.switchTab 又不支持带 query 参数。
 *
 * 所以这里把两者合起来：把参数写进全局变量，再用 switchTab 跳过去，
 * 目标页在 onLoad/onShow 里读取并消费这些参数。
 */

/** tabBar 页面清单，与 app.json 的 tabBar.list 保持一致 */
const TAB_PAGES = [
  'pages/home/home',
  'pages/matches/matches',
  'pages/map/map',
  'pages/mine/mine'
];

function normalize(path) {
  return String(path || '').replace(/^\//, '').split('?')[0];
}

function isTabPage(path) {
  return TAB_PAGES.indexOf(normalize(path)) >= 0;
}

/** 把参数对象写进 globalData，供目标页读取 */
function stashParams(app, params) {
  if (!params) return;
  app.globalData.pendingParams = Object.assign({}, app.globalData.pendingParams || {}, params);
}

/**
 * 统一跳转入口
 * @param {object} app getApp() 得到的实例
 * @param {string} path 页面路径，可带 query（仅非 tab 页有效）
 * @param {object} params tab 页需要的参数（会写进 globalData）
 */
function go(app, path, params) {
  if (isTabPage(path)) {
    stashParams(app, params);
    wx.switchTab({
      url: '/' + normalize(path),
      fail: (e) => {
        console.error('[寻迹] switchTab 失败：', e);
        wx.showToast({ title: '页面跳转失败', icon: 'none' });
      }
    });
    return;
  }
  wx.navigateTo({
    url: path,
    fail: (e) => {
      console.error('[寻迹] navigateTo 失败：', e);
      wx.showToast({ title: '页面打开失败：' + ((e && e.errMsg) || ''), icon: 'none' });
    }
  });
}

/**
 * 在目标页读取并清空参数（读一次就消费掉，避免下次进入还带着旧筛选）
 * @returns {object} 参数对象（可能为空对象）
 */
function takeParams(app) {
  const params = (app.globalData && app.globalData.pendingParams) || {};
  if (app.globalData) app.globalData.pendingParams = null;
  return params;
}

/**
 * 合并两路参数来源（纯函数，便于测试）：
 *   query   —— 通过 wx.navigateTo 直接打开时带的 query
 *   pending —— 通过 switchTab 跳转时暂存在 globalData 的参数
 * 两路都缺时用 defaults 兜底。
 *
 * 为什么要有它：switchTab 不支持 query，所以首页点「类别」只能把参数暂存，
 * 由本页消费；而有些入口又是用 navigateTo 打开的（带 query）。
 * 两条路径必须都覆盖，否则筛选条件会时灵时不灵。
 */
function mergeParams(query, pending, defaults) {
  return Object.assign({}, defaults || {}, pending || {}, query || {});
}

/** 从 globalData 中取出待消费参数，不影响原对象（供测试与复用） */
function pickParams(globalData) {
  return (globalData && globalData.pendingParams) || {};
}

module.exports = {
  TAB_PAGES,
  isTabPage,
  go,
  takeParams,
  stashParams,
  mergeParams,
  pickParams
};
