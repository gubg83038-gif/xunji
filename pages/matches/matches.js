const app = getApp();
const service = require('../../utils/service');
const store = require('../../utils/store');
const nav = require('../../utils/nav');
const categorical = require('../../core/categories.js');
const timeUtil = require('../../core/time.js');

const SORTS = [
  { key: 'score', label: '综合匹配度' },
  { key: 'time', label: '发现时间' },
  { key: 'geo', label: '距离最近' }
];

const FILTERS = [
  { key: 'all', label: '全部候选' },
  { key: 'passed', label: '超过阈值' },
  { key: 'new', label: '未查看' },
  { key: 'claimed', label: '认领中' },
  { key: 'returned', label: '已归还' },
  { key: 'rejected', label: '已排除' }
];

Page({
  data: {
    userId: '',
    contexts: [],
    contextIndex: 0,
    context: null,
    sorts: SORTS,
    sortKey: 'score',
    filters: FILTERS,
    filterKey: 'all',
    keyword: '',
    categories: [],
    categoryKey: 'all',
    matches: [],
    excluded: [],
    excludedCount: 0,
    stat: null,
    loading: true,
    elapsed: 0
  },

  onLoad(query) {
    const userId = app.globalData.userId;
    const cats = [{ key: 'all', name: '全部类别', icon: '🗂' }].concat(
      categorical.list().map((c) => ({ key: c.key, name: c.name, icon: c.icon }))
    );
    // 本页是 tabBar 页面：来自首页等页面的参数走 globalData（switchTab 不支持 query），
    // 同时兼容直接以 navigateTo 方式打开时带的 query。两路合并由 nav.mergeParams 负责。
    const params = nav.mergeParams(query, nav.takeParams(app), { category: 'all', itemId: '' });

    this.setData({
      userId,
      categories: cats,
      categoryKey: params.category
    });
    if (params.itemId) this.pendingItemId = params.itemId;
    if (params.kind) this.pendingKind = params.kind;
  },

  onShow() {
    this._visible = true;
    // 从别的 tab 带着参数切进来时（例如首页点类别），在此消费
    const params = nav.takeParams(app);
    if (params.category) this.setData({ categoryKey: params.category });
    if (params.itemId) this.pendingItemId = params.itemId;
    if (params.kind) this.pendingKind = params.kind;

    this.buildContexts();
    this.refresh();
    if (app.globalData.mode === 'cloud') {
      app.refresh().then((changed) => {
        if (!changed || !this._visible || this._closed) return;
        this.buildContexts();
        this.refresh();
      });
    }
  },

  onHide() { this._visible = false; },
  onUnload() { this._closed = true; this._visible = false; },
  async onPullDownRefresh() {
    try {
      if (app.globalData.mode === 'cloud') await app.refresh({ force: true });
      if (!this._closed) { this.buildContexts(); this.refresh(); }
    } finally { wx.stopPullDownRefresh(); }
  },

  /** 构建可切换的“寻找任务”上下文 */
  buildContexts() {
    const userId = this.data.userId || app.globalData.userId;
    const myLosts = service.myLostItems(userId).filter((x) => x.status !== 'recovered' && x.status !== 'closed');
    const myFounds = service.myFoundItems(userId).filter((x) => x.status !== 'returned' && x.status !== 'closed');

    const contexts = []
      .concat(myLosts.map((x) => ({ key: 'lost:' + x.id, id: x.id, kind: 'lost', label: x.title, icon: x.icon, meta: x.matchCount + ' 个拾物候选' })))
      .concat(myFounds.map((x) => ({ key: 'found:' + x.id, id: x.id, kind: 'found', label: x.title, icon: x.icon, meta: x.matchCount + ' 个潜在失主' })));
    contexts.push({ key: 'all', id: '', kind: 'all', label: '全部候选', icon: '🌐', meta: '跨记录候选汇总' });

    let index = 0;
    const want = this.pendingItemId;
    if (want) {
      const i = contexts.findIndex((c) => c.id === want);
      if (i >= 0) index = i;
      this.pendingItemId = '';
    } else if (this.data.context && this.data.context.key) {
      const i = contexts.findIndex((c) => c.key === this.data.context.key);
      if (i >= 0) index = i;
    }

    this.setData({
      contexts,
      contextIndex: index,
      context: contexts[index] || null
    });
  },

  onSwitchContext(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ contextIndex: index, context: this.data.contexts[index] });
    this.refresh();
  },

  onSortChange(e) {
    this.setData({ sortKey: e.currentTarget.dataset.key });
    this.refresh();
  },

  onFilterChange(e) {
    this.setData({ filterKey: e.currentTarget.dataset.key });
    this.refresh();
  },

  onCategoryChange(e) {
    this.setData({ categoryKey: e.detail.value === '0' ? 'all' : this.data.categories[Number(e.detail.value)].key });
    this.refresh();
  },

  goSearch() {
    wx.navigateTo({ url: '/pages/search/search' });
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  onKeywordConfirm() {
    this.refresh();
  },

  onResetKeyword() {
    this.setData({ keyword: '' });
    this.refresh();
  },

  refresh() {
    const ctx = this.data.context;
    if (!ctx) {
      this.setData({ loading: false });
      return;
    }

    let list = [];
    let elapsed = 0;
    let candidates = 0;

    /**
     * 服务层已经把「已排除」的候选从候选流里剔除了。
     * 这里再额外拉一次含排除项的列表，用于：
     *   · 「已排除」筛选页签；
     *   · 列表顶部的「撤销排除」入口——否则用户排除错了没法回头。
     */
    const withRejected = ctx.kind === 'lost'
      ? service.candidatesForLost(ctx.id, { topK: 20, minScore: 0.3, includeRejected: true }).views
      : ctx.kind === 'found'
        ? service.candidatesForFound(ctx.id, { topK: 20, minScore: 0.3, includeRejected: true }).views
        : service.allCandidateViews({ minScore: 0.3, includeRejected: true });
    const excluded = withRejected
      .filter((m) => m.status === 'rejected')
      .map((m) => Object.assign({}, m, { showUndo: true }));

    if (ctx.kind === 'lost') {
      const res = service.candidatesForLost(ctx.id, { topK: 20, minScore: 0.3 });
      list = res.views;
      elapsed = res.elapsed || 0;
      candidates = res.candidates || list.length;
    } else if (ctx.kind === 'found') {
      const res = service.candidatesForFound(ctx.id, { topK: 20, minScore: 0.3 });
      list = res.views;
      candidates = res.candidates || list.length;
    } else {
      list = service.allCandidateViews({ minScore: 0.3 });
      candidates = list.length;
    }

    // 过滤
    const fk = this.data.filterKey;
    if (fk === 'rejected') {
      list = excluded;
    } else if (fk !== 'all') {
      list = list.filter((m) => {
        if (fk === 'passed') return m.passed;
        if (fk === 'returned') return m.status === 'returned';
        return m.status === fk;
      });
    }
    if (this.data.categoryKey !== 'all') {
      list = list.filter((m) => (m.counterpart.attributes || {}).category === this.data.categoryKey);
    }
    const kw = (this.data.keyword || '').trim();
    if (kw) {
      list = list.filter((m) =>
        (m.counterpart.title + m.counterpart.description + m.counterpart.locationName).indexOf(kw) >= 0 ||
        (m.lost.title + m.lost.description).indexOf(kw) >= 0);
    }

    // 排序
    const sortKey = this.data.sortKey;
    if (sortKey === 'time') {
      list = list.slice().sort((a, b) => (b.found.foundTime || b.found.createdAt) - (a.found.foundTime || a.found.createdAt));
    } else if (sortKey === 'geo') {
      list = list.slice().sort((a, b) => {
        const da = a.detailDistance === undefined ? (a.geoText || '') : a.detailDistance;
        const db = b.detailDistance === undefined ? (b.geoText || '') : b.detailDistance;
        return String(da).localeCompare(String(db));
      });
    } else {
      list = list.slice().sort((a, b) => b.score - a.score);
    }

    const visible = list.filter((x) => x.status !== 'rejected');
    const passed = visible.filter((x) => x.passed).length;
    const avg = visible.length ? Math.round((visible.reduce((s, x) => s + x.score, 0) / visible.length) * 100) : 0;

    this.setData({
      matches: list,
      excluded,
      excludedCount: excluded.length,
      loading: false,
      elapsed,
      stat: {
        total: visible.length,
        passed,
        avg,
        candidates,
        contextLabel: ctx.label,
        threshold: visible.length ? Math.round(visible[0].threshold * 100) : 0
      }
    });
  },

  onMatchTap(e) {
    const m = e.detail.match;
    wx.navigateTo({ url: '/pages/compare/compare?matchId=' + m.id + '&lostId=' + m.lostId + '&foundId=' + m.foundId });
  },

  onMatchReject(e) {
    const matchId = e.detail.matchId;
    const m = e.detail.match || {};
    wx.showActionSheet({
      itemList: ['颜色/外观不一致', '地点距离太远', '时间对不上', '不是同一件物品', '其他原因'],
      success: async (res) => {
        const reasons = ['颜色/外观不一致', '地点距离太远', '时间对不上', '不是同一件物品', '其他原因'];
        wx.showLoading({ title: '处理中', mask: true });
        // 带上候选上下文：多数候选从未落库，离线模式下要靠它才能补出这条排除记录
        const r = await service.rejectMatchAsync(matchId, reasons[res.tapIndex], {
          lostId: m.lostId,
          foundId: m.foundId,
          score: m.score,
          threshold: m.threshold,
          passed: m.passed
        });
        wx.hideLoading();
        if (!r || !r.ok) {
          wx.showToast({ title: (r && r.message) || '排除失败', icon: 'none' });
          return;
        }
        // 先刷新再提示：候选会立刻从列表里消失，并出现在「已排除」页签，可随时撤销。
        this.refresh();
        wx.showToast({ title: '已排除，可在「已排除」里撤销', icon: 'none', duration: 2200 });
      },
      fail: () => {}
    });
  },

  onMatchRestore(e) {
    const matchId = e.detail.matchId;
    const m = e.detail.match || {};
    wx.showModal({
      title: '撤销排除',
      content: '该候选会重新回到候选列表（分数与排序保持不变）。',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中', mask: true });
        const r = await service.restoreMatchAsync(matchId, { lostId: m.lostId, foundId: m.foundId });
        wx.hideLoading();
        if (!r.ok) {
          wx.showToast({ title: r.message || '撤销失败', icon: 'none' });
          return;
        }
        this.refresh();
        wx.showToast({ title: '已恢复该候选', icon: 'success' });
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

  async onRerun() {
    wx.showLoading({ title: '重新匹配中', mask: true });
    const result = await service.rerunMatchAsync();
    wx.hideLoading();
    this.refresh();
    wx.showToast({ title: '已重新匹配，新增 ' + (result.created || 0) + ' 条候选', icon: 'none' });
  },

  goPublish() {
    if (this.data.context && this.data.context.kind === 'found') {
      wx.navigateTo({ url: '/pages/publish/publish?type=lost' });
    } else {
      wx.navigateTo({ url: '/pages/publish/publish?type=found' });
    }
  },

  /** 一键跳到「已排除」，让用户看得到自己排除了哪些 */
  onShowExcluded() {
    this.setData({ filterKey: 'rejected' });
    this.refresh();
  },

  /** 已排除页签下的空状态按钮：回到全部候选 */
  onExcludedEmptyAction() {
    this.setData({ filterKey: 'all' });
    this.refresh();
  },

  onExplain() {
    wx.showModal({
      title: '匹配是怎么算出来的？',
      content: 'S = α·S_image + β·S_attr + γ·S_text + δ·S_geo + ε·S_time。\n\n' +
        '· 少了哪一类输入，对应权重就置零并重新归一化；\n' +
        '· 时空信息只做加权重排，不做硬过滤，避免因记忆偏差漏掉正确结果；\n' +
        '· 类别硬冲突会大幅降分，但候选仍保留，交给人判断。',
      showCancel: false
    });
  }
});
