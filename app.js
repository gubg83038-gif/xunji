const store = require('./utils/store');
const service = require('./utils/service');
const config = require('./core/config');

App({
  globalData: {
    userInfo: null,
    /** 当前登录用户 id（云端模式下由云函数 getWXContext 决定，演示时可切换） */
    userId: 'u_me',
    /** 当前运行模式：'local' | 'cloud' */
    mode: 'local',
    /** 启动同步状态 */
    ready: false,
    bootError: '',
    /** 当前选中的失物记录 id，用于“匹配”Tab 的默认上下文 */
    activeLostId: '',
    /** 地点库版本，用于地图页缓存判断 */
    locationVersion: config.campus.version
  },

  onLaunch() {
    this.boot();
  },

  onShow() {
    // 从后台回到前台时补一次同步（云端模式下数据可能已被其他设备修改）
    if (this.globalData.ready && this.globalData.mode === 'cloud') {
      service.syncFromCloud();
    }
  },

  /**
   * 启动流程：
   *   云端模式：拉取云端快照（含本地缓存秒开）→ 失败则退回本地演示数据
   *   本地模式：初始化存储并灌入演示数据
   */
  async boot() {
    try {
      const result = await service.bootstrap();
      this.globalData.mode = result.mode;
      this.globalData.ready = true;
      this.globalData.bootError = result.synced ? '' : '云端同步失败，已使用本地缓存数据';
      if (result.mode === 'cloud' && !result.synced) {
        console.warn('[寻迹] 云端不可用，已退回本地演示数据');
      }
    } catch (e) {
      console.error('[寻迹] 启动初始化失败：', e);
      this.globalData.bootError = e.message || '初始化失败';
      // 最后兜底：保证页面至少能用本地演示数据渲染
      try {
        store.init();
        require('./mock/seed').ensureSeed();
        this.globalData.mode = 'local';
      } catch (e2) {
        console.error('[寻迹] 本地兜底也失败：', e2);
      }
      this.globalData.ready = true;
    }
  },

  /** 供页面在 onShow 里调用，保持数据新鲜 */
  refresh() {
    if (this.globalData.mode === 'cloud') return service.syncFromCloud();
    return Promise.resolve(false);
  }
});
