const service = require('../../utils/service');
const store = require('../../utils/store');
const matcher = require('../../core/matcher.js');
const categorical = require('../../core/categories.js');
const locations = require('../../core/locations.js');
const timeUtil = require('../../core/time.js');

Page({
  data: {
    stats: null,
    quality: null,
    categoryBars: [],
    groups: [],
    improvement: null,
    evalNote: '',
    sampleCount: 0,
    anomalies: [],
    hotCategories: [],
    weights: [],
    statusFlow: [],
    campus: null,
    pendingLocations: []
  },

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  },

  refresh() {
    const stats = service.stats();
    const dist = service.categoryDistribution();
    const maxCount = dist.length ? dist[0].count : 1;
    const categoryBars = dist.map((d) => Object.assign({}, d, {
      percent: Math.round((d.count / maxCount) * 100)
    }));

    const items = store.allItems();
    const losts = store.itemsOf('lost');
    const founds = store.itemsOf('found');
    const withImage = items.filter((x) => x.image).length;
    const withDesc = items.filter((x) => (x.description || '').length >= 6).length;
    const attrFields = matcher.ATTR_FIELDS;
    const attrComplete = items.map((x) => {
      const a = x.attributes || {};
      const filled = attrFields.filter((f) => a[f] !== undefined && a[f] !== '' && !(Array.isArray(a[f]) && !a[f].length)).length;
      return filled / attrFields.length;
    });
    const avgAttr = attrComplete.length ? attrComplete.reduce((s, x) => s + x, 0) / attrComplete.length : 0;
    const locStd = items.filter((x) => x.location && x.location.id !== 'unknown').length;
    const privateRate = founds.filter((x) => (x.privateFeatures || []).length).length;

    const quality = {
      itemCount: items.length,
      imageCoverage: items.length ? Math.round((withImage / items.length) * 100) : 0,
      descCoverage: items.length ? Math.round((withDesc / items.length) * 100) : 0,
      locationStd: items.length ? Math.round((locStd / items.length) * 100) : 0,
      attrCompleteness: Math.round(avgAttr * 100),
      privateRate: founds.length ? Math.round((privateRate / founds.length) * 100) : 0,
      identityPairs: losts.filter((l) => l.identityId).length
    };

    const evaluation = service.evaluate();
    const groups = (evaluation.groups || []).map((g) => Object.assign({}, g, {
      recall1Width: g.recall1Percent,
      recall5Width: g.recall5Percent,
      mrrWidth: g.mrrPercent
    }));

    this.setData({
      stats,
      quality,
      categoryBars,
      groups,
      improvement: evaluation.improvement || null,
      evalNote: evaluation.note || '',
      sampleCount: evaluation.sampleCount || 0,
      anomalies: this.findAnomalies(),
      hotCategories: dist.slice(0, 3),
      weights: this.weightRows(),
      statusFlow: this.statusFlow(),
      campus: locations.campusInfo(),
      pendingLocations: locations.unverified()
    });
  },

  /** 异常与低质量记录检测（方案 6.8 管理后台） */
  findAnomalies() {
    const list = [];

    // 1) 信息过少 / 地点未标准化
    store.allItems().forEach((it) => {
      if (!it.image && (it.description || '').length < 6) {
        list.push({
          type: 'low_quality',
          level: 'warn',
          title: '信息量不足的记录',
          desc: '「' + service.itemView(it).title + '」既无图片也无有效描述，难以参与匹配',
          itemId: it.id
        });
      } else if (!it.location || it.location.id === 'unknown') {
        list.push({
          type: 'location',
          level: 'warn',
          title: '地点未标准化',
          desc: '「' + (it.description || '').slice(0, 16) + '…」未能匹配到校园标准地点，时空重排权重被置零',
          itemId: it.id
        });
      }
    });

    // 2) 相似但身份不同的记录（疑似重复发布 / 困难负样本）
    const losts = store.itemsOf('lost');
    const founds = store.itemsOf('found');
    const dup = [];
    losts.slice(0, 20).forEach((l) => {
      founds.slice(0, 20).forEach((f) => {
        if (!l.identityId || !f.identityId) return;
        if (l.identityId === f.identityId) return;
        const d = matcher.scorePair(l, f);
        if (d.score >= 0.78 && (l.attributes || {}).category === (f.attributes || {}).category) {
          dup.push({
            type: 'duplicate',
            level: 'info',
            title: '高度相似但非同一件',
            desc: service.itemView(l).title + ' ⇄ ' + service.itemView(f).title + '（' + Math.round(d.score * 100) + '%），可作为困难负样本',
            matchId: 'match_' + l.id + '_' + f.id
          });
        }
      });
    });
    list.push.apply(list, dup.slice(0, 4));

    // 3) 低分认领
    store.claims().forEach((c) => {
      if (c.status === 'submitted' && (c.verificationScore || 0) < 0.3) {
        list.push({
          type: 'claim',
          level: 'danger',
          title: '低置信度认领待人工复核',
          desc: '认领单附加说明：语义核验辅助分仅 ' + Math.round((c.verificationScore || 0) * 100) + '%，建议人工介入',
          claimId: c.id
        });
      }
    });

    return list.slice(0, 8);
  },

  weightRows() {
    const base = matcher.BASE_WEIGHTS;
    return Object.keys(matcher.SCORE_META).map((key) => ({
      key,
      label: matcher.SCORE_META[key].label,
      base: Math.round(base[key] * 100)
    }));
  },

  statusFlow() {
    const d = store.db();
    const losts = d.lostItems;
    const founds = d.foundItems;
    return [
      { label: '寻找中 / 待认领', lost: losts.filter((l) => l.status === 'searching' || l.status === 'candidate_found').length, found: founds.filter((f) => f.status === 'available').length },
      { label: '核验中 / 已锁定', lost: losts.filter((l) => l.status === 'verifying').length, found: founds.filter((f) => f.status === 'reserved').length },
      { label: '待交接', lost: losts.filter((l) => l.status === 'waiting_handover').length, found: 0 },
      { label: '已归还 / 已关闭', lost: losts.filter((l) => l.status === 'recovered' || l.status === 'closed').length, found: founds.filter((f) => f.status === 'returned' || f.status === 'closed').length }
    ];
  },

  onAnomalyTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    const a = this.data.anomalies[index];
    if (!a) return;
    if (a.claimId) {
      wx.navigateTo({ url: '/pages/claim/claim?claimId=' + a.claimId });
    } else if (a.itemId) {
      wx.navigateTo({ url: '/pages/detail/detail?id=' + a.itemId });
    } else if (a.matchId) {
      wx.navigateTo({ url: '/pages/compare/compare?matchId=' + a.matchId });
    }
  },

  onExplainMetrics() {
    wx.showModal({
      title: '指标说明',
      content: 'Recall@1：第一名即为正确物品的比例（对应“一眼找到”的体验）\n' +
        'Recall@5：前五名包含正确物品的比例（对应候选列表）\n' +
        'MRR：正确物品平均排名倒数的均值，衡量排序质量\n' +
        '平均检索耗时：一次查询的响应时间\n\n' +
        '身份标注（identityId）保证“同一物品的不同照片/不同描述”被视为同一身份，避免数据泄漏；' +
        '数据集中已刻意包含外观接近的困难负样本。',
      showCancel: false
    });
  },

  onExplainAblation() {
    wx.showModal({
      title: '消融实验设计',
      content: 'A · Image Only：建立单图像检索基线\n' +
        'B · Image + Text：验证文字信息贡献\n' +
        'C · Image + Text + Attr：验证结构化属性贡献\n' +
        'D · + Time + Geo：验证完整方案\n\n' +
        '每组使用同一批带身份标注的样本，逐步增加信息类型，观察 Recall@5 与 MRR 是否提升。',
      showCancel: false
    });
  },

  onExplainWeights() {
    wx.showModal({
      title: '动态权重机制',
      content: 'S = α·S_image + β·S_attr + γ·S_text + δ·S_geo + ε·S_time\n\n' +
        'α~ε 不是固定常数：缺少某一模态时该权重置零，其余按比例重新归一化；' +
        '类别个性特征强（如钥匙、证件、手表）时自动提高属性权重；' +
        '时空信息只参与排序加权，不做硬过滤。',
      showCancel: false
    });
  },

  /* ===================== 地点坐标校准（现场补点工具） ===================== */

  onExplainCampus() {
    const info = locations.campusInfo();
    wx.showModal({
      title: info.school + info.campus,
      content: info.address + '\n\n' +
        '地点库：' + info.locationCount + ' 个，其中 ' + info.unverifiedCount + ' 个坐标待校准\n' +
        '坐标系：' + info.coordSystem + '（微信地图坐标系）\n' +
        '数据来源：' + info.source + '\n\n' +
        '已校准地点来自 OpenStreetMap 实测建筑坐标；待校准地点（图书馆、宿舍园区、超市等）' +
        '是按文档描述与相对位置估算的，需要到现场用「校准地点坐标」取点。',
      showCancel: false
    });
  },

  onCalibrate() {
    const pending = locations.unverified();
    if (!pending.length) {
      wx.showToast({ title: '所有地点坐标都已校准', icon: 'success' });
      return;
    }
    wx.showActionSheet({
      itemList: pending.slice(0, 10).map((l) => l.name + '（待校准）'),
      success: (res) => {
        const target = pending[res.tapIndex];
        if (target) this.pickCoordinate(target);
      },
      fail: () => {}
    });
  },

  /** 打开地图选点，并把结果与最近的标准地点一起展示，便于确认没有选错 */
  pickCoordinate(target) {
    if (!wx.chooseLocation) {
      wx.showModal({
        title: '当前环境不支持地图选点',
        content: '请在真机（开发者工具的模拟器可能不可用）上使用该功能，或直接在 core/campus-data.js 中填写坐标。',
        showCancel: false
      });
      return;
    }
    wx.chooseLocation({
      latitude: target.lat,
      longitude: target.lng,
      success: (res) => {
        const near = locations.nearest(res.latitude, res.longitude, 3);
        const info = locations.campusInfo();
        const payload = {
          id: target.id,
          name: target.name,
          lat: Number(res.latitude.toFixed(6)),
          lng: Number(res.longitude.toFixed(6)),
          address: res.address || '',
          coordSystem: info.coordSystem,
          pickedAt: timeUtil.format(Date.now())
        };
        const nearestText = near.map((n) => n.name + ' ' + n.distanceText).join('\n');
        wx.showModal({
          title: '已取点：' + target.name,
          content: '坐标（' + info.coordSystem + '）：\n' + payload.lat + ', ' + payload.lng + '\n\n' +
            '附近标准地点：\n' + nearestText + '\n\n' +
            '确定后复制 JSON，粘贴到 core/campus-data.js 对应地点，' +
            '把 verified 改为 true，并递增 campus.version。',
          confirmText: '复制 JSON',
          success: (r) => {
            if (!r.confirm) return;
            wx.setClipboardData({
              data: JSON.stringify(payload, null, 2),
              success: () => wx.showToast({ title: '已复制到剪贴板', icon: 'success' })
            });
          }
        });
      },
      fail: (e) => {
        if (e && e.errMsg && e.errMsg.indexOf('cancel') >= 0) return;
        wx.showToast({ title: '取点失败：' + ((e && e.errMsg) || ''), icon: 'none', duration: 2500 });
      }
    });
  },

  /** 把全部待校准地点导出成可粘贴的代码片段 */
  onExportPending() {
    const pending = locations.unverified();
    if (!pending.length) {
      wx.showToast({ title: '没有待校准地点', icon: 'none' });
      return;
    }
    const lines = pending.map((l) =>
      "  // TODO 待校准：" + l.name + '\n' +
      "  { id: '" + l.id + "', name: '" + l.name + "', lat: " + l.lat + ", lng: " + l.lng + ", verified: false }");
    wx.setClipboardData({
      data: lines.join(',\n'),
      success: () => wx.showToast({ title: '已复制 ' + pending.length + ' 条', icon: 'success' })
    });
  },

  onResetDemo() {
    wx.showModal({
      title: '重置演示数据',
      content: '清空并恢复内置演示数据集，用于答辩前恢复初始状态。',
      success: (res) => {
        if (!res.confirm) return;
        const seed = require('../../mock/seed');
        store.reset(() => {});
        seed.ensureSeed();
        wx.showToast({ title: '已重置', icon: 'success' });
        this.refresh();
      }
    });
  },

  onExportData() {
    const db = store.db();
    const payload = {
      exportedAt: timeUtil.format(Date.now()),
      stats: this.data.stats,
      quality: this.data.quality,
      evaluation: { groups: this.data.groups, improvement: this.data.improvement },
      counts: {
        lostItems: db.lostItems.length,
        foundItems: db.foundItems.length,
        matches: db.matches.length,
        claims: db.claims.length,
        feedbacks: db.feedbacks.length
      }
    };
    wx.setClipboardData({
      data: JSON.stringify(payload, null, 2),
      success: () => wx.showToast({ title: '统计结果已复制', icon: 'success' })
    });
  }
});
