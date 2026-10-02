Component({
  options: {
    addGlobalClass: true
  },

  properties: {
    /** 候选匹配视图对象（service.matchView 的返回值） */
    match: {
      type: Object,
      value: null
    },
    /** 排序序号 */
    rank: {
      type: Number,
      value: 0
    },
    /** 展示方向：lost = 以失物为主体展示拾物候选 */
    from: {
      type: String,
      value: 'lost'
    },
    /** 是否显示“排除”按钮 */
    showReject: {
      type: Boolean,
      value: true
    },
    compact: {
      type: Boolean,
      value: false
    }
  },

  data: {
    imageError: false,
    expanded: false
  },

  observers: {
    match() {
      this.setData({ imageError: false });
    }
  },

  methods: {
    onImageError() {
      this.setData({ imageError: true });
    },

    onTap() {
      const m = this.data.match;
      if (!m) return;
      this.triggerEvent('tapcard', { matchId: m.id, match: m });
      wx.navigateTo({
        url: '/pages/compare/compare?matchId=' + m.id + '&lostId=' + m.lostId + '&foundId=' + m.foundId
      });
    },

    onReject(e) {
      if (e && e.stopPropagation) e.stopPropagation();
      const m = this.data.match;
      this.triggerEvent('reject', { matchId: m.id, match: m });
    },

    onClaim(e) {
      if (e && e.stopPropagation) e.stopPropagation();
      const m = this.data.match;
      this.triggerEvent('claim', { matchId: m.id, match: m });
    },

    onToggleReason(e) {
      if (e && e.stopPropagation) e.stopPropagation();
      this.setData({ expanded: !this.data.expanded });
    }
  }
});
