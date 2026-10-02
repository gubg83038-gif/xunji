Component({
  options: { addGlobalClass: true },
  properties: {
    /** matcher.scoreBars() 返回的分项数组 */
    bars: {
      type: Array,
      value: []
    },
    /** 是否显示权重 */
    showWeight: {
      type: Boolean,
      value: true
    },
    /** 是否显示横条与百分比同排 */
    dense: {
      type: Boolean,
      value: false
    }
  },
  methods: {
    onTapBar(e) {
      const key = e.currentTarget.dataset.key;
      const bar = (this.data.bars || []).find((b) => b.key === key);
      this.triggerEvent('tapbar', { key, bar });
    }
  }
});
