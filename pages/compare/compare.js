const service = require('../../utils/service');
const store = require('../../utils/store');
const timeUtil = require('../../core/time.js');
const locations = require('../../core/locations.js');

Page({
  data: {
    matchId: '',
    detail: null,
    bars: [],
    attrRows: [],
    timeline: [],
    explanation: '',
    advice: '',
    weightText: '',
    lostPills: [],
    foundPills: [],
    reasonList: [],
    conflictList: [],
    uncertainList: [],
    claim: null,
    canClaim: true,
    activeTab: 'evidence',
    privateFeatures: []
  },

  onLoad(query) {
    this.matchId = query.matchId || '';
    this.lostId = query.lostId || '';
    this.foundId = query.foundId || '';
    this.load();
  },

  onShow() {
    if (this.data.detail) this.load();
  },

  load() {
    const detail = service.compareDetail(this.matchId, { lostId: this.lostId, foundId: this.foundId });
    if (!detail) {
      wx.showToast({ title: '候选不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }

    const timeline = service.timeline({
      matchId: this.matchId,
      lostId: detail.lostId,
      foundId: detail.foundId
    });

    const claim = store.byMatch(this.matchId);

    wx.setNavigationBarTitle({ title: '详细对比 · ' + detail.percent + '% 匹配' });

    /**
     * 两栏属性药丸（对照 UI 设计稿）。
     * 设计稿里左栏是紫底药丸、右栏是青底药丸，各放 3—5 条可比较的特征。
     * 这里从视图模型的 tags 取（已含品牌/颜色/材质/特征），最多 5 条——
     * 与设计稿的视觉密度一致，也避免药丸堆得太长。
     */
    const pillsOf = (view) => {
      const out = [];
      if (view.attributes && view.attributes.main_color) out.push(view.attributes.main_color);
      if (view.attributes && view.attributes.material) out.push(view.attributes.material);
      if (view.categoryName) out.push(view.categoryName);
      (view.tags || []).forEach((t) => {
        if (out.indexOf(t) < 0 && out.length < 5) out.push(t);
      });
      return out.slice(0, 5);
    };

    this.setData({
      detail,
      bars: detail.bars,
      attrRows: detail.attrRows,
      timeline,
      explanation: detail.explanation,
      advice: detail.advice,
      weightText: detail.weightsText,
      lostPills: pillsOf(detail.lost),
      foundPills: pillsOf(detail.found),
      reasonList: detail.reasons.positive || [],
      conflictList: detail.reasons.conflict || [],
      uncertainList: detail.reasons.uncertain || [],
      claim: claim ? service.claimView(claim) : null,
      canClaim: !claim || claim.status === 'rejected',
      privateFeatures: detail.found.privateCount ? ['共 ' + detail.found.privateCount + ' 项隐藏特征（认领时逐条核验）'] : ['拾物者未填写隐藏特征，将由类别常识生成问题']
    });
  },

  onTabChange(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab });
  },

  onBarTap(e) {
    const bar = e.detail.bar;
    if (!bar) return;
    const explains = {
      image: '图像相似度：真实系统由 CLIP/SigLIP 图像向量余弦相似度计算；演示环境使用内置图像向量与视觉属性一致性混合估算。',
      attr: '属性一致度：独立于 embedding 计算。类别冲突大幅降分，颜色允许“深灰/灰黑”这类近似，显著个性特征权重最高。',
      text: '文字语义：中文 bigram + 同义词概念归一 + 文本向量的混合相似度，缓解“保温杯/金属水杯”这类不同表述。',
      geo: '地点相关度：S_geo = exp(-d/σ)，d 为标准化校园地点间的球面距离，σ 由物品类别决定。',
      time: '时间相关度：S_time = exp(-Δt/τ)。若失主给出时间范围，则计算拾取时间到该范围的距离。'
    };
    wx.showModal({
      title: bar.label + ' ' + bar.percent + '%（权重 ' + bar.weightPercent + '%）',
      content: explains[bar.key] || '',
      showCancel: false
    });
  },

  async onClaim() {
    if (this.data.claim && this.data.claim.status !== 'rejected') {
      wx.navigateTo({ url: '/pages/claim/claim?claimId=' + this.data.claim.id });
      return;
    }
    wx.showLoading({ title: '创建核验', mask: true });
    const r = await service.startClaimAsync(this.matchId);
    wx.hideLoading();
    if (!r.ok) {
      wx.showToast({ title: r.message || '操作失败', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/claim/claim?claimId=' + r.claim.id });
  },

  onReject() {
    wx.showActionSheet({
      itemList: ['颜色/外观不一致', '地点距离太远', '时间对不上', '不是同一件物品', '其他原因'],
      success: async (res) => {
        const reasons = ['颜色/外观不一致', '地点距离太远', '时间对不上', '不是同一件物品', '其他原因'];
        wx.showLoading({ title: '处理中', mask: true });
        await service.rejectMatchAsync(this.matchId, reasons[res.tapIndex]);
        wx.hideLoading();
        wx.showToast({ title: '已排除该候选', icon: 'success' });
        this.load();
      },
      fail: () => {}
    });
  },

  onPreview(e) {
    const url = e.currentTarget.dataset.url;
    if (!url || url.indexOf('demo://') === 0) {
      wx.showToast({ title: '演示图片，无原图可预览', icon: 'none' });
      return;
    }
    wx.previewImage({ urls: [url], current: url });
  },

  onOpenMap() {
    const d = this.data.detail;
    if (!d) return;
    wx.switchTab({ url: '/pages/map/map' });
  },

  onCopyExplain() {
    wx.setClipboardData({
      data: this.data.explanation + '\n' + this.data.weightText,
      success: () => wx.showToast({ title: '解释已复制', icon: 'success' })
    });
  }
});
