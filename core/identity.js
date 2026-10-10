/**
 * 当前用户身份（小程序端唯一事实来源）
 * ---------------------------------------------------------------
 * 为什么需要单独一个模块：
 *
 *   之前 `app.globalData.userId` 是身份的**唯一**存放点，而 `utils/api.js`
 *   拿不到 `getApp()`（模块级调用 getApp 在小程序里不可靠），于是云端调用
 *   从来不携带身份。云函数侧只能写死 `ctx.userId = 'u_me'`，导致所有
 *   「校验当前用户是不是记录所有者」的判断都形同虚设——这就是
 *   `item.update` / `item.remove` 能被任意调用方操作别人记录的直接原因。
 *
 *   现在把身份收在这里：
 *     · `app.js` 启动时 register 一次「读取全局身份」的回调（切用户后仍然读得到最新值）
 *     · `utils/api.js` 每次云调用从这里取 userId 注入 payload
 *     · 页面继续用 `app.globalData.userId`，行为不变
 *
 * 为什么不让本模块直接 `getApp()`：
 *   小程序里 getApp() 在模块顶层执行不可靠（App 可能尚未构造），
 *   而 core/ 层还有硬性规定不能依赖小程序全局量。所以改成「谁有全局数据谁注册」。
 */

/** 读取当前身份的注入点，由 app.js 注册 */
let reader = null;

/** 云端模式的默认演示身份（本地模式同样用它作为兜底） */
const DEFAULT_USER_ID = 'u_me';

/**
 * 注册身份读取器。
 * @param {Function} fn 返回当前 userId 的函数
 */
function register(fn) {
  reader = typeof fn === 'function' ? fn : null;
}

/**
 * 当前用户 id。
 * 读不到时回落到 u_me，保证本地演示与不切用户的场景行为不变。
 */
function currentUserId() {
  if (!reader) return DEFAULT_USER_ID;
  try {
    const id = reader();
    return id || DEFAULT_USER_ID;
  } catch (e) {
    return DEFAULT_USER_ID;
  }
}

/** 测试用：清空注入点 */
function reset() {
  reader = null;
}

module.exports = {
  DEFAULT_USER_ID,
  register,
  currentUserId,
  reset
};
