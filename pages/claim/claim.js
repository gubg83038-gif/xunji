const app = getApp();
const service = require('../../utils/service');
const store = require('../../utils/store');

const ACTION_HINTS = ['有', '没有', '不确定'];

Page({
  data: {
    claim: null,
    stage: '',           // answering | submitted | verified | rejected | returned
    myRole: 'claimant',  // claimant 认领者 / keeper 拾物者
    answers: [],
    hintChips: ACTION_HINTS,
    submitting: false,
    showResult: false
  },

  onLoad(query) {
    this.claimId = query.claimId || '';
    this.load();
  },

  onShow() {
    if (this.data.claim) this.load();
  },

  load() {
    const claim = service.claimDetail(this.claimId);
    if (!claim) {
      wx.showToast({ title: '认领单不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    const userId = app.globalData.userId;
    const myRole = claim.keeperId === userId && claim.claimantId !== userId ? 'keeper' : 'claimant';
    const answers = claim.questions.map((q, i) => {
      const existing = (claim.answers || [])[i];
      return {
        qid: q.id,
        question: q.question,
        feature: q.feature,
        value: existing ? existing.answer : '',
        score: existing ? existing.score : 0,
        percent: existing ? Math.round(existing.score * 100) : 0,
        reason: existing ? existing.reason : ''
      };
    });
    wx.setNavigationBarTitle({
      title: claim.status === 'returned' ? '归还完成' : '认领核验'
    });
    this.setData({
      claim,
      stage: claim.status,
      myRole,
      answers,
      showResult: claim.status !== 'answering'
    });
  },

  onAnswerInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const answers = this.data.answers.slice();
    answers[index] = Object.assign({}, answers[index], { value: e.detail.value });
    this.setData({ answers });
  },

  onHintTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    const value = e.currentTarget.dataset.value;
    const answers = this.data.answers.slice();
    answers[index] = Object.assign({}, answers[index], { value });
    this.setData({ answers });
  },

  async onSubmit() {
    const empty = this.data.answers.filter((a) => !a.value.trim());
    if (empty.length) {
      wx.showToast({ title: '请回答全部核验问题', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    wx.showLoading({ title: '核验中', mask: true });
    const r = await service.submitClaimAsync(this.claimId, this.data.answers.map((a) => a.value));
    wx.hideLoading();
    this.setData({ submitting: false });
    if (!r.ok) {
      wx.showToast({ title: r.message || '提交失败', icon: 'none' });
      return;
    }
    const score = r.claim ? r.claim.verificationScore : (r.claimView ? r.claimView.verificationScore : 0);
    wx.showModal({
      title: '已提交核验',
      content: '系统语义核验辅助分 ' + Math.round((score || 0) * 100) +
        '%。该分数仅作辅助，最终由拾物者结合特征确认。',
      showCancel: false,
      success: () => this.load()
    });
  },

  onConfirm(e) {
    const pass = e.currentTarget.dataset.action === 'pass';
    wx.showModal({
      title: pass ? '确认归还给该失主' : '确认特征不匹配',
      content: pass
        ? '确认后记录将进入“待交接”状态，线下完成交接后请点击“完成归还”。'
        : '该认领将结束，并作为负样本用于优化后续阈值与排序策略。',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中', mask: true });
        await service.confirmClaimAsync(this.claimId, pass ? 'pass' : 'reject', '');
        wx.hideLoading();
        wx.showToast({ title: pass ? '已确认' : '已拒绝', icon: 'success' });
        this.load();
      }
    });
  },

  onCompleteReturn() {
    wx.showModal({
      title: '确认完成归还',
      content: '双方已线下完成交接，点击确认后该匹配闭环结束，并作为正样本记录。',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中', mask: true });
        await service.completeReturnAsync(this.claimId);
        wx.hideLoading();
        wx.showToast({ title: '归还完成', icon: 'success' });
        this.load();
      }
    });
  },

  onCopyAnswer() {
    const text = this.data.answers.map((a, i) => (i + 1) + '. ' + a.question + '\n答：' + a.value).join('\n\n');
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    });
  },

  onSafety() {
    wx.showModal({
      title: '安全与隐私提示',
      content: '· 隐藏核验特征只用于认领流程，不会出现在公开页面；\n' +
        '· 平台不强制公开姓名、手机号等敏感信息，建议在校园公共区域交接；\n' +
        '· 证件、银行卡等高敏感物品请走管理员人工复核流程；\n' +
        '· 自动核验只能降低冒领风险，不能完全替代线下确认。',
      showCancel: false
    });
  },

  goCompare() {
    const c = this.data.claim;
    wx.navigateTo({ url: '/pages/compare/compare?matchId=' + c.matchId + '&lostId=' + c.lostId + '&foundId=' + c.foundId });
  },

  goMatches() {
    wx.switchTab({ url: '/pages/matches/matches' });
  }
});
