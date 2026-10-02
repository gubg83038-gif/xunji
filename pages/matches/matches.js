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
  { key: 'returned', label: '已归还' }
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
    // 从别的 tab 带着参数切进来时（例如首页点类别），在此消费
    const params = nav.takeParams(app);
    if (params.category) this.setData({ categoryKey: params.category });
    if (params.itemId) this.pendingItemId = params.itemId;
    if (params.kind) this.pendingKind = params.kind;

    this.buildContexts();
    this.refresh();
    if (app.globalData.mode === 'cloud') {
      app.refresh().then(() => {
        this.buildContexts();
        this.refresh();
      });
    }
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
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
    if (this.data.filterKey !== 'all') {
      const fk = this.data.filterKey;
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

    const passed = list.filter((x) => x.passed).length;
    const avg = list.length ? Math.round((list.reduce((s, x) => s + x.score, 0) / list.length) * 100) : 0;

    this.setData({
      matches: list,
      loading: false,
      elapsed,
      stat: {
        total: list.length,
        passed,
        avg,
        candidates,
        contextLabel: ctx.label,
        threshold: list.length ? Math.round(list[0].threshold * 100) : 0
      }
    });
  },

  onMatchTap(e) {
    const m = e.detail.match;
    wx.navigateTo({ url: '/pages/compare/compare?matchId=' + m.id + '&lostId=' + m.lostId + '&foundId=' + m.foundId });
  },

  onMatchReject(e) {
    const matchId = e.detail.matchId;
    wx.showActionSheet({
      itemList: ['颜色/外观不一致', '地点距离太远', '时间对不上', '不是同一件物品', '其他原因'],
      success: async (res) => {
        const reasons = ['颜色/外观不一致', '地点距离太远', '时间对不上', '不是同一件物品', '其他原因'];
        wx.showLoading({ title: '处理中', mask: true });
        await service.rejectMatchAsync(matchId, reasons[res.tapIndex]);
        wx.hideLoading();
        wx.showToast({ title: '已排除，感谢反馈', icon: 'success' });
        this.refresh();
      },
      fail: () => {}
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
