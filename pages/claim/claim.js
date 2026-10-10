const app = getApp();
const service = require('../../utils/service');
const store = require('../../utils/store');

/** 核验问答的快捷选项（互斥三选一） */
const ACTION_HINTS = ['有', '没有', '不确定'];

/**
 * 「有 / 没有 / 不确定」这类方向性回答的判定。
 *
 * 复核发现：core/matching-ops.js 的 verifyAnswer 对短语回答给的是低分
 * （长度 < 2 直接 0.1，长度 < 6 再乘 0.7），所以只点快捷选项提交，
 * 三个问题的语义核验分会全部落在 10% 上下——看起来像「核验没生效」。
 * 这里据此给出即时提示，引导用户补一句具体细节。
 */
const DIRECTIONAL = ACTION_HINTS;

function isDirectional(value) {
  const v = String(value || '').trim();
  if (!v) return true;
  if (DIRECTIONAL.indexOf(v) >= 0) return true;
  return v.length <= 4;
}

Page({
  data: {
    claim: null,
    stage: '',           // answering | submitted | verified | rejected | returned
    myRole: 'claimant',  // claimant 认领者 / keeper 拾物者
    answers: [],
    hintChips: ACTION_HINTS,
    submitting: false,
    showResult: false,
    // 核验期临时会话
    session: null,
    messageDraft: '',
    scrollTarget: '',
    /** 读不到认领单时的说明（区分「不存在」与「不是我 / 读失败」） */
    missing: '',
    forbidden: ''
  },

  onLoad(query) {
    this.claimId = query.claimId || '';
    this._closed = false;
    this.load();
  },

  onShow() {
    if (this.data.claim || this.data.missing) this.load();
  },

  onUnload() {
    this._closed = true;
  },

  /**
   * 加载认领单。
   *
   * ⚠ 之前只读本地镜像，而镜像里的 claims 是按当前身份过滤的（claim.mine），
   *   切身份 / 换设备后镜像里就没有这张单，界面却弹「认领单不存在」——
   *   明明云端有。现在镜像缺失时回源服务端（见 service.claimDetailAsync）。
   */
  async load() {
    const r = await service.claimDetailAsync(this.claimId);
    if (this._closed) return;

    if (!r.claim) {
      /**
       * 三种情况要分开说，否则用户只会看到一句误导性的「认领单不存在」：
       *   · forbidden：这张单真实存在，只是当前身份不是双方；
       *   · error：网络/云端问题，读不到不等于不存在；
       *   · 其它：确实没有这张单。
       */
      if (r.forbidden) {
        this.setData({ missing: '', forbidden: r.error || '只有本次认领的失主与拾物者可以查看' });
        return;
      }
      this.setData({ missing: r.error || '认领单不存在', forbidden: '' });
      wx.showToast({ title: r.error || '认领单不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
      return;
    }

    this.applyClaim(r.claim);
  },

  applyClaim(claim) {
    const userId = app.globalData.userId;
    /**
     * 角色必须显式区分「不是我」的情况。
     *
     * 旧写法是 `keeperId === userId && claimantId !== userId ? 'keeper' : 'claimant'`，
     * 于是**任何与这张认领单无关的人**都会被当成 claimant，
     * 页面就敢把「提交核验回答」「完成归还」这些按钮亮出来给外人看。
     * 服务端现在会拦（FORBIDDEN），但界面不该先给错暗示。
     */
    const myRole = claim.claimantId === userId ? 'claimant'
      : (claim.keeperId === userId ? 'keeper' : 'none');
    const answers = (claim.questions || []).map((q, i) => {
      const existing = (claim.answers || [])[i];
      const value = existing ? existing.answer : '';
      return {
        qid: q.id,
        question: q.question,
        feature: q.feature,
        value,
        // choice 记录用户点过哪个快捷选项（用于按钮高亮），detailed 表示是否补了细节
        choice: DIRECTIONAL.indexOf(String(value).trim()) >= 0 ? String(value).trim() : '',
        detailed: !!value && !isDirectional(value),
        score: existing ? existing.score : 0,
        percent: existing ? Math.round(existing.score * 100) : 0,
        reason: existing ? existing.reason : ''
      };
    });
    wx.setNavigationBarTitle({
      title: claim.status === 'returned' ? '归还完成' : '认领核验'
    });
    // 核验期临时会话：只有认领双方能看到，未提交回答时处于 closed，不展示
    const session = service.claimSessionView(this.claimId, { userId });
    this.setData({
      claim,
      stage: claim.status,
      myRole,
      answers,
      session,
      missing: '',
      forbidden: '',
      scrollTarget: session && session.messages.length
        ? 'msg-' + session.messages[session.messages.length - 1].id
        : '',
      showResult: claim.status !== 'answering'
    });
  },

  onAnswerInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const answers = this.data.answers.slice();
    const value = e.detail.value;
    const trimmed = String(value).trim();
    answers[index] = Object.assign({}, answers[index], {
      value,
      choice: DIRECTIONAL.indexOf(trimmed) >= 0 ? trimmed : '',
      detailed: !isDirectional(value)
    });
    this.setData({ answers });
  },

  /**
   * 点快捷选项。
   * 互斥语义：再点一次同一个选项 = 取消选择；点另一个 = 直接切换。
   */
  onPickOption(e) {
    const index = Number(e.currentTarget.dataset.index);
    const value = e.currentTarget.dataset.value;
    const answers = this.data.answers.slice();
    const current = answers[index] || {};
    const same = String(current.value || '').trim() === value;
    answers[index] = Object.assign({}, current, {
      value: same ? '' : value,
      choice: same ? '' : value,
      detailed: false
    });
    this.setData({ answers });
    if (!same) {
      wx.showToast({ title: '已选「' + value + '」，建议再补一句细节', icon: 'none', duration: 1800 });
    }
  },

  async onSubmit() {
    if (this.data.myRole !== 'claimant') {
      wx.showToast({ title: '只有发起认领的失主可以作答', icon: 'none' });
      return;
    }
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
    if (this.data.myRole !== 'keeper') {
      wx.showToast({ title: '只有拾物者本人可以确认或拒绝', icon: 'none' });
      return;
    }
    const pass = e.currentTarget.dataset.action === 'pass';
    wx.showModal({
      title: pass ? '确认归还给该失主' : '确认特征不匹配',
      content: pass
        ? '确认后记录将进入“待交接”状态，线下完成交接后请点击“完成归还”。'
        : '该认领将结束，并作为负样本用于优化后续阈值与排序策略。',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中', mask: true });
        const r = await service.confirmClaimAsync(this.claimId, pass ? 'pass' : 'reject', '');
        wx.hideLoading();
        if (!r || !r.ok) {
          wx.showToast({ title: (r && r.message) || '操作失败', icon: 'none' });
          return;
        }
        wx.showToast({ title: pass ? '已确认' : '已拒绝', icon: 'success' });
        this.load();
      }
    });
  },

  onCompleteReturn() {
    if (this.data.myRole === 'none') {
      wx.showToast({ title: '只有本次认领的双方可以确认归还', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '确认完成归还',
      content: '双方已线下完成交接，点击确认后该匹配闭环结束，并作为正样本记录。',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中', mask: true });
        const r = await service.completeReturnAsync(this.claimId);
        wx.hideLoading();
        if (!r || !r.ok) {
          wx.showToast({ title: (r && r.message) || '操作失败', icon: 'none' });
          return;
        }
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

  /* ---------------- 核验期临时会话 ---------------- */

  onMessageInput(e) {
    this.setData({ messageDraft: e.detail.value });
  },

  async onSendMessage() {
    if (this._sending) return;
    const text = String(this.data.messageDraft || '').trim();
    if (!text) {
      wx.showToast({ title: '请先输入内容', icon: 'none' });
      return;
    }
    if (!this.data.session || !this.data.session.canSend) {
      wx.showToast({ title: '当前状态不能发送消息', icon: 'none' });
      return;
    }
    this._sending = true;
    wx.showLoading({ title: '发送中', mask: true });
    let r;
    try {
      r = await service.postClaimMessageAsync(this.claimId, {
        userId: app.globalData.userId,
        text
      });
    } finally {
      wx.hideLoading();
      this._sending = false;
    }
    if (this._closed) return;
    if (!r || !r.ok) {
      wx.showToast({ title: (r && r.message) || '发送失败', icon: 'none' });
      return;
    }
    if (r.message && r.message.redacted) {
      wx.showToast({ title: '已发送（联系方式已自动隐藏）', icon: 'none', duration: 2200 });
    }
    // 发送后重新加载：会话消息与认领状态都可能是最新的
    this.load();
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
