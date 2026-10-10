const app = getApp();
const service = require('../../utils/service');
const store = require('../../utils/store');
const timeUtil = require('../../core/time.js');
const locations = require('../../core/locations.js');
const categorical = require('../../core/categories.js');

Page({
  data: {
    item: null,
    isOwner: false,
    candidates: [],
    timeline: [],
    attributeRows: [],
    privateFeatures: [],
    kindLabel: ''
  },

  onLoad(query) {
    this.itemId = query.id || '';
    this.load();
  },

  onShow() {
    if (this.data.item) this.load();
  },

  load() {
    const raw = store.getItem(this.itemId);
    if (!raw) {
      wx.showToast({ title: '记录不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    const item = service.itemView(raw);
    const isOwner = raw.userId === app.globalData.userId;

    // 关联候选
    let candidates = [];
    if (raw.kind === 'lost') {
      candidates = service.candidatesForLost(raw.id, { topK: 6, minScore: 0.3 }).views;
    } else {
      candidates = service.candidatesForFound(raw.id, { topK: 6, minScore: 0.3 }).views;
    }

    // 属性表
    const attrRows = Object.keys(raw.attributes || {}).map((k) => ({
      key: k,
      label: require('../../core/vlm.js').FIELD_LABELS[k] || k,
      value: Array.isArray(raw.attributes[k]) ? raw.attributes[k].join('、') : String(raw.attributes[k])
    }));

    // 时间线
    const timelineOpts = raw.kind === 'lost' ? { lostId: raw.id } : { foundId: raw.id };
    const timeline = service.timeline(timelineOpts);
    if (raw.kind === 'lost' && candidates.length) {
      const t2 = service.timeline({ lostId: raw.id, foundId: candidates[0].foundId, matchId: candidates[0].id });
      this.setData({ item, isOwner, candidates, timeline: t2, attributeRows: attrRows, privateFeatures: raw.privateFeatures || [], kindLabel: raw.kind === 'lost' ? '失物' : '拾物' });
      return;
    }

    this.setData({
      item,
      isOwner,
      candidates,
      timeline,
      attributeRows: attrRows,
      privateFeatures: raw.privateFeatures || [],
      kindLabel: raw.kind === 'lost' ? '失物' : '拾物'
    });
  },

  onPreview() {
    const url = this.data.item.image;
    if (!url || url.indexOf('demo://') === 0) {
      wx.showToast({ title: '演示图片，无原图可预览', icon: 'none' });
      return;
    }
    wx.previewImage({ urls: [url] });
  },

  onMatchTap(e) {
    const m = e.detail.match;
    wx.navigateTo({ url: '/pages/compare/compare?matchId=' + m.id + '&lostId=' + m.lostId + '&foundId=' + m.foundId });
  },

  onMatchReject(e) {
    const matchId = e.detail.matchId;
    const m = e.detail.match || {};
    wx.showLoading({ title: '处理中', mask: true });
    service.rejectMatchAsync(matchId, '详情页排除', {
      lostId: m.lostId,
      foundId: m.foundId,
      score: m.score,
      threshold: m.threshold,
      passed: m.passed
    }).then((r) => {
      wx.hideLoading();
      if (!r || !r.ok) {
        wx.showToast({ title: (r && r.message) || '排除失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: '已排除，可在「已排除」里撤销', icon: 'none' });
      this.load();
    });
  },

  onMatchRestore(e) {
    const matchId = e.detail.matchId;
    const m = e.detail.match || {};
    wx.showLoading({ title: '处理中', mask: true });
    service.restoreMatchAsync(matchId, { lostId: m.lostId, foundId: m.foundId }).then((r) => {
      wx.hideLoading();
      if (!r || !r.ok) {
        wx.showToast({ title: (r && r.message) || '撤销失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: '已恢复该候选', icon: 'success' });
      this.load();
    });
  },

  async onMatchClaim(e) {
    wx.showLoading({ title: '创建核验', mask: true });
    const r = await service.startClaimAsync(e.detail.matchId);
    wx.hideLoading();
    if (!r.ok) {
      wx.showToast({ title: r.message || '操作失败', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/claim/claim?claimId=' + r.claim.id });
  },

  async onRerun() {
    wx.showLoading({ title: '重新匹配中', mask: true });
    await service.rerunMatchAsync();
    wx.hideLoading();
    this.load();
    wx.showToast({ title: '已重新匹配', icon: 'success' });
  },

  onCloseItem() {
    wx.showModal({
      title: '关闭该记录',
      content: '关闭后将不再参与匹配（例如物品已自行找回）。',
      success: (res) => {
        if (!res.confirm) return;
        const raw = store.getItem(this.itemId);
        store.updateItem(this.itemId, { status: raw.kind === 'lost' ? 'closed' : 'closed' });
        store.persist();
        wx.showToast({ title: '已关闭', icon: 'success' });
        this.load();
      }
    });
  },

  onDelete() {
    wx.showModal({
      title: '删除记录',
      content: '删除后相关候选匹配也会一并移除，操作不可恢复。',
      success: (res) => {
        if (!res.confirm) return;
        store.removeItem(this.itemId);
        store.persist();
        wx.showToast({ title: '已删除', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      }
    });
  },

  onMarkReturned() {
    wx.showModal({
      title: '标记为已归还',
      content: '物品已通过线下方式找回或归还，标记后该记录不再参与匹配。',
      success: (res) => {
        if (!res.confirm) return;
        const raw = store.getItem(this.itemId);
        store.updateItem(this.itemId, { status: raw.kind === 'lost' ? 'recovered' : 'returned' });
        store.persist();
        wx.showToast({ title: '已标记', icon: 'success' });
        this.load();
      }
    });
  },

  goPublishFound() {
    wx.navigateTo({ url: '/pages/publish/publish?type=found' });
  },

  onMapTap() {
    wx.switchTab({ url: '/pages/map/map' });
  }
});
