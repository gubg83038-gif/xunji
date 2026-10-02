const app = getApp();
const service = require('../../utils/service');
const store = require('../../utils/store');

Page({
  data: {
    notifications: [],
    unread: 0
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const userId = app.globalData.userId;
    this.setData({
      notifications: service.notificationViews(userId),
      unread: store.unreadCount(userId)
    });
  },

  onMarkAll() {
    store.markAllRead(app.globalData.userId);
    wx.showToast({ title: '已全部标记为已读', icon: 'success' });
    this.refresh();
  },
  onTapNotify(e) {
    const id = e.currentTarget.dataset.id;
    const n = this.data.notifications.find((x) => x.id === id);
    if (!n) return;
    // 标记单条已读
    const list = store.notifications();
    const target = list.find((x) => x.id === id);
    if (target && !target.read) {
      target.read = true;
      store.persist();
    }

    if (n.matchId && n.lostView && n.foundView) {
      wx.navigateTo({
        url: '/pages/compare/compare?matchId=' + n.matchId + '&lostId=' + n.lostId + '&foundId=' + n.foundId
      });
    } else if (n.lostView) {
      wx.navigateTo({ url: '/pages/detail/detail?id=' + n.lostId });
    } else {
      this.refresh();
    }
  },

  async onClaim(e) {
    const matchId = e.currentTarget.dataset.match;
    wx.showLoading({ title: '创建核验', mask: true });
    const r = await service.startClaimAsync(matchId);
    wx.hideLoading();
    if (!r.ok) {
      wx.showToast({ title: r.message || '操作失败', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/claim/claim?claimId=' + r.claim.id });
  },

  goMatches() {
    wx.switchTab({ url: '/pages/matches/matches' });
  }
});
