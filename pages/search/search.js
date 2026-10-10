const retrieval = require('../../utils/search');
const categories = require('../../core/categories');

Page({
  data: {
    description: '', image: '', kind: 'found', categoryIndex: 0, categories: [],
    results: [], clues: [], loading: false, searched: false, dirty: false,
    visualDescription: '', suggestions: [],
    error: '', note: '', model: '', total: 0, scanned: 0, elapsed: 0, localOnly: false,
    examples: ['黑色保温杯，杯身有白色文字', '蓝色折叠雨伞', '一串钥匙，带挂件']
  },
  onLoad() {
    this._request = 0;
    this._closed = false;
    this.setData({ categories: [{ key: 'all', name: '全部类别' }].concat(categories.list()) });
  },
  onUnload() {
    this._closed = true;
    this._request += 1;
  },
  invalidate(patch) {
    this._request += 1;
    this.setData(Object.assign({ loading: false, dirty: this.data.searched,
      results: [], total: 0, clues: [], visualDescription: '', suggestions: [], error: '', note: '' }, patch));
  },
  onInput(e) {
    // 输入只更新文本，点击搜索时才分析，避免每次击键调用模型。
    this.invalidate({ description: e.detail.value });
  },
  onExample(e) {
    this.invalidate({ description: this.data.examples[Number(e.currentTarget.dataset.index)], image: '' });
    return this.onSearch();
  },
  onKind(e) {
    this.invalidate({ kind: e.currentTarget.dataset.kind });
    if (this.data.searched) return this.onSearch({ localOnly: this.data.localOnly });
  },
  onCategory(e) {
    this.invalidate({ categoryIndex: Number(e.detail.value) });
    if (this.data.searched) return this.onSearch({ localOnly: this.data.localOnly });
  },
  onChooseImage() {
    wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'],
      success: (res) => {
        if (this._closed || !res.tempFiles || !res.tempFiles.length) return;
        this.invalidate({ image: res.tempFiles[0].tempFilePath });
      },
      fail: (e) => {
        if (!this._closed && !/cancel/i.test(e.errMsg || '')) this.setData({ error: '照片选择失败，请重试' });
      }
    });
  },
  onRemoveImage() { this.invalidate({ image: '' }); },
  onRetryImage() { return this.onSearch(true); },
  onSearchLocal() { return this.onSearch({ localOnly: true }); },
  async onSearch(force) {
    if (this.data.loading) return;
    if (!this.data.description.trim() && !this.data.image) {
      this.setData({ error: '请描述要找的物品，或选择一张照片' });
      return;
    }
    const request = ++this._request;
    const localOnly = !!(force && force.localOnly === true);
    this.setData({ loading: true, searched: true, dirty: false, results: [], clues: [], visualDescription: '', suggestions: [], error: '', note: '', localOnly });
    try {
      const result = await retrieval.search({ description: this.data.description,
        image: this.data.image, kind: this.data.kind,
        category: this.data.categories[this.data.categoryIndex].key, force: force === true,
        localOnly });
      if (this._closed || request !== this._request) return;
      this.setData({ results: result.results, clues: result.clues, total: result.total,
        scanned: result.scanned, elapsed: result.elapsed, note: result.note,
        visualDescription: result.recognition && result.recognition.description || '',
        suggestions: result.recognition && result.recognition.suggestions || [],
        model: result.model === 'local' ? '文字规则分析' : 'AI 分析：' + result.model });
    } catch (e) {
      if (!this._closed && request === this._request) this.setData({ error: e.message || '搜索失败，请重试' });
    } finally {
      if (!this._closed && request === this._request) this.setData({ loading: false });
    }
  },
  onDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.results.some((item) => item.id === id))
      wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) });
  },
  onImageError(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ results: this.data.results.map((item) => item.id === id
      ? Object.assign({}, item, { hasImage: false, photoLabel: '照片暂无法显示' }) : item) });
  }
});
