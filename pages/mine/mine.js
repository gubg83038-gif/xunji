const app = getApp();
const service = require('../../utils/service');
const store = require('../../utils/store');
const nav = require('../../utils/nav');
const timeUtil = require('../../core/time.js');

const TABS = [
  { key: 'lost', label: '我的失物' },
  { key: 'found', label: '我的拾物' },
  { key: 'claim', label: '认领记录' }
];

Page({
  data: {
    user: null,
    tabs: TABS,
    tabKey: 'lost',
    stats: null,
    lostItems: [],
    foundItems: [],
    claims: [],
    unread: 0
  },

  onShow() {
    this.refresh();
    if (app.globalData.mode === 'cloud') {
      app.refresh().then(() => this.refresh());
    }
  },

  refresh() {
    const userId = app.globalData.userId;
    const user = store.user(userId);
    this.setData({
      user,
      stats: service.stats(),
      lostItems: service.myLostItems(userId),
      foundItems: service.myFoundItems(userId),
      claims: service.myClaims(userId),
      unread: store.unreadCount(userId)
    });
  },

  onTabChange(e) {
    this.setData({ tabKey: e.currentTarget.dataset.key });
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  /** 查看某条记录的候选：匹配页是 tabBar 页面，参数走 globalData */
  goMatches(e) {
    const id = e.currentTarget.dataset.id;
    const kind = e.currentTarget.dataset.kind || 'lost';
    if (!id) return;
    nav.go(app, '/pages/matches/matches', { itemId: id, kind });
  },

  goClaim(e) {
    wx.navigateTo({ url: '/pages/claim/claim?claimId=' + e.currentTarget.dataset.id });
  },

  goNotify() {
    wx.navigateTo({ url: '/pages/notify/notify' });
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/admin' });
  },

  onSwitchUser() {
    const users = store.users().filter((u) => u.role !== 'admin');
    wx.showActionSheet({
      itemList: users.map((u) => u.nickName + '（' + u.college + '）'),
      success: (res) => {
        app.globalData.userId = users[res.tapIndex].id;
        wx.showToast({ title: '已切换为 ' + users[res.tapIndex].nickName, icon: 'none' });
        this.refresh();
      },
      fail: () => {}
    });
  },

  onResetDemo() {
    wx.showModal({
      title: '重置演示数据',
      content: '将清空所有记录并恢复内置演示数据集（含方案 16.1 的演示故事线）。',
      success: (res) => {
        if (!res.confirm) return;
        const seed = require('../../mock/seed');
        store.reset(() => {});
        seed.ensureSeed();
        wx.showToast({ title: '已重置为初始演示数据', icon: 'success' });
        this.refresh();
      }
    });
  },

  onAbout() {
    wx.showModal({
      title: '关于「寻迹」',
      content: '基于多模态语义检索与时空关联的校园失物智能匹配平台。\n\n' +
        '完整闭环：发布 → 结构化 → 召回 → 时空重排 → 候选解释 → 主动提醒 → 认领 → 隐藏特征核验 → 双方确认 → 归还 → 反馈。\n\n' +
        '匹配公式：S = α·S_image + β·S_attr + γ·S_text + δ·S_geo + ε·S_time，权重随用户输入可模态动态归一化。',
      showCancel: false
    });
  },

  onFeedback() {
    wx.showModal({
      title: '匹配反馈',
      content: '反馈数据用于优化阈值与排序策略：\n· 已归还可作为正样本\n· 被排除候选作为弱负样本\n· 认领失败样本用于调整核验阈值\n\n' +
        '演示数据中已记录 ' + (store.feedbacks().length) + ' 条反馈样本。',
      showCancel: false
    });
  }
});
