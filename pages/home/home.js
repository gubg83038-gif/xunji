const app = getApp();
const service = require('../../utils/service');
const store = require('../../utils/store');
const nav = require('../../utils/nav');
const categorical = require('../../core/categories.js');
const timeUtil = require('../../core/time.js');

Page({
  data: {
    stats: null,
    topMatches: [],
    myTasks: [],
    recentFounds: [],
    recentLosts: [],
    categories: [],
    heatTop: [],
    unread: 0,
    loading: true
  },

  onLoad() {
    this.setData({ categories: categorical.list().slice(0, 8) });
  },

  onShow() {
    this.refresh();
    // 云端模式下从后台同步最新数据，保持候选与状态新鲜
    if (app.globalData.mode === 'cloud') {
      app.refresh().then(() => this.refresh());
    }
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  },

  refresh() {
    const userId = app.globalData.userId;
    const stats = service.stats();

    // 推荐候选：全局候选流中分数最高的几条
    const topMatches = service.allCandidateViews({ minScore: 0.55 }).slice(0, 3);

    // 我的持续寻找任务
    const myTasks = service.myLostItems(userId)
      .filter((x) => x.status !== 'recovered' && x.status !== 'closed')
      .slice(0, 3);

    // 最近拾物
    const recentFounds = store.itemsOf('found')
      .filter((x) => x.status !== 'returned' && x.status !== 'closed')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 4)
      .map(service.itemView);

    /**
     * 最近失物（对照设计稿首页的三张缩略图网格）。
     * itemView 提供 hasImage —— demo:// 演示图标识不能交给 <image src> 渲染。
     */
    const recentLosts = store.itemsOf('lost')
      .filter((x) => x.status !== 'recovered' && x.status !== 'closed')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 3)
      .map(service.itemView);

    const heatTop = service.heatmap().slice(0, 4);

    this.setData({
      stats,
      topMatches,
      myTasks,
      recentFounds,
      recentLosts,
      heatTop,
      unread: store.unreadCount(userId),
      loading: false
    });
  },

  goPublish(e) {
    const type = e.currentTarget.dataset.type || 'lost';
    wx.navigateTo({ url: '/pages/publish/publish?type=' + type });
  },

  goMatches() {
    nav.go(app, '/pages/matches/matches');
  },

  goMap() {
    nav.go(app, '/pages/map/map');
  },

  goNotify() {
    wx.navigateTo({ url: '/pages/notify/notify' });
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/admin' });
  },

  /**
   * 按类别查看。
   * 匹配页是 tabBar 页面，只能用 switchTab 打开（navigateTo 会静默失败），
   * 而 switchTab 不支持带 query，所以把类别放进 globalData 交给目标页消费。
   */
  goCategory(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    nav.go(app, '/pages/matches/matches', { category: key });
  },

  /** 查看某条记录的候选：同样需要跨 tab 跳转 */
  goTask(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    nav.go(app, '/pages/matches/matches', { itemId: id });
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  onMatchTap(e) {
    const m = e.detail.match;
    wx.navigateTo({ url: '/pages/compare/compare?matchId=' + m.id + '&lostId=' + m.lostId + '&foundId=' + m.foundId });
  },

  onMatchReject(e) {
    const matchId = e.detail.matchId;
    wx.showModal({
      title: '排除该候选',
      content: '排除后该候选不会再出现在列表中，并作为负样本用于优化排序策略。',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中', mask: true });
        await service.rejectMatchAsync(matchId, '用户手动排除');
        wx.hideLoading();
        wx.showToast({ title: '已排除', icon: 'success' });
        this.refresh();
      }
    });
  },

  async onMatchClaim(e) {
    const matchId = e.detail.matchId;
    wx.showLoading({ title: '创建核验', mask: true });
    const r = await service.startClaimAsync(matchId);
    wx.hideLoading();
    if (!r.ok) {
      wx.showToast({ title: r.message || '操作失败', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/claim/claim?claimId=' + r.claim.id });
  },

  onSeedReset() {
    wx.showModal({
      title: '重置演示数据',
      content: '将清空当前所有记录并恢复内置演示数据集，用于答辩前恢复初始状态。',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '重置中', mask: true });
        if (service.runtimeStatus().mode === 'cloud') {
          const api = require('../../utils/api');
          try {
            await api.seedDemo(true);
            await service.syncFromCloud();
          } catch (e) {
            wx.hideLoading();
            wx.showToast({ title: '云端重置失败：' + e.message, icon: 'none', duration: 2500 });
            return;
          }
        } else {
          const seed = require('../../mock/seed');
          store.reset(() => {});
          seed.ensureSeed();
        }
        wx.hideLoading();
        wx.showToast({ title: '已重置', icon: 'success' });
        this.refresh();
      }
    });
  }
});
