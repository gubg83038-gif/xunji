const service = require('../../utils/service');
const locations = require('../../core/locations.js');
const categorical = require('../../core/categories.js');

const KIND_OPTIONS = [
  { key: 'all', label: '全部' },
  { key: 'lost', label: '失物点' },
  { key: 'found', label: '拾物点' }
];

const RANGE_OPTIONS = [
  { key: 0, label: '不限时间' },
  { key: 1, label: '近 24 小时' },
  { key: 7, label: '近 7 天' }
];

const LEVEL_COLOR = { 1: '#bcd2fb', 2: '#7aa4f5', 3: '#f59e0b', 4: '#f04438' };

/** 校园围栏样式：以校区中心画一圈，直观表明这是江南大学蠡湖校区 */
const CAMPUS_FENCE = { color: '#2e6be6', fillColor: '#2e6be611', radius: 950, strokeWidth: 1 };

Page({
  data: {
    /* ------------------------------------------------------------------
     * 地图视野：map 组件的 latitude/longitude/scale/include-points 任意一项
     * 缺失或为 undefined，都会让它退化到微信默认视野（可能落在别的学校）。
     * 因此这里全部给出江南大学蠡湖校区的确切兜底值，onLoad 会再用真实
     * 校区中心与范围覆盖一遍。
     * ------------------------------------------------------------------ */
    campus: null,
    mapCenter: { lat: 31.4835, lng: 120.2735 },
    mapScale: 15,
    includePoints: [
      { latitude: 31.4747, longitude: 120.2639 },
      { latitude: 31.4916, longitude: 120.2773 }
    ],

    markers: [],
    circles: [],

    /* ---- 聚合数据 ---- */
    cells: [],
    campusSpots: [],
    selected: null,
    kindOptions: KIND_OPTIONS,
    kindKey: 'all',
    categories: [],
    categoryKey: 'all',
    rangeOptions: RANGE_OPTIONS,
    rangeKey: 0,
    total: 0,
    maxTotal: 1,
    hasRecords: false
  },

  onLoad() {
    const info = locations.campusInfo();
    const points = locations.includePoints();
    const center = { lat: info.center.lat, lng: info.center.lng };

    this.setData({
      campus: info,
      mapCenter: center,
      /**
       * 用三点锁定视野：西南角 + 校区中心 + 东北角。
       *
       * ⚠ 这里每个点的属性名必须是 latitude / longitude。
       *   地图组件的 include-points 只认这两个键；
       *   直接写 `center`（它是 { lat, lng }）会让该点变成 LatLng(NaN, NaN)，
       *   报错：SystemError (webviewScriptError) 参数错误: LatLng 传入参数 (NaN, NaN) 非合法数字。
       */
      includePoints: [
        { latitude: points[0].latitude, longitude: points[0].longitude },
        { latitude: center.lat, longitude: center.lng },
        { latitude: points[1].latitude, longitude: points[1].longitude }
      ],
      categories: [{ key: 'all', name: '全部类别' }].concat(
        categorical.list().map((c) => ({ key: c.key, name: c.name }))
      )
    });
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const since = this.data.rangeKey ? Date.now() - this.data.rangeKey * 24 * 3600 * 1000 : 0;
    const cells = service.heatmap({
      kind: this.data.kindKey,
      category: this.data.categoryKey,
      since
    });

    // 有记录的地点：气泡里直接写清是哪个地标，而不是只给一个数字
    const markers = cells.map((c, idx) => ({
      id: idx,
      latitude: c.lat,
      longitude: c.lng,
      width: 1,
      height: 1,
      callout: {
        content: c.name + '\n失物 ' + c.lost + ' · 拾物 ' + c.found,
        color: '#101828',
        fontSize: 12,
        borderRadius: 8,
        borderWidth: 0,
        bgColor: '#ffffff',
        padding: 8,
        display: 'ALWAYS',
        textAlign: 'center'
      }
    }));

    // 第一个圈是校园围栏（示意校区范围），其余是各地点的事件热力圈
    const circles = [{
      latitude: this.data.mapCenter.lat,
      longitude: this.data.mapCenter.lng,
      color: CAMPUS_FENCE.color,
      fillColor: CAMPUS_FENCE.fillColor,
      radius: CAMPUS_FENCE.radius,
      strokeWidth: CAMPUS_FENCE.strokeWidth
    }].concat(cells.map((c) => ({
      latitude: c.lat,
      longitude: c.lng,
      color: LEVEL_COLOR[c.level] || '#7aa4f5',
      fillColor: (LEVEL_COLOR[c.level] || '#7aa4f5') + '33',
      radius: 30 + c.level * 30,
      strokeWidth: 2
    })));

    const total = cells.reduce((s, c) => s + c.total, 0);
    const selected = this.data.selected
      ? cells.find((c) => c.id === this.data.selected.id) || null
      : null;

    this.setData({
      cells,
      markers,
      circles,
      campusSpots: this.buildCampusSpots(cells),
      total,
      maxTotal: cells.length ? cells[0].total : 1,
      hasRecords: cells.length > 0,
      selected
    });
  },

  /**
   * 校区全部地标清单（含 0 条记录的），用于：
   *   1. 记录为空或筛选过窄时，地图下方不会是一片空白；
   *   2. 答辩时能直接说清「地点库里到底有哪些地方」。
   */
  buildCampusSpots(cells) {
    const withRecords = {};
    cells.forEach((c) => { withRecords[c.id] = c; });

    return locations.list()
      .filter((loc) => loc.cate !== 'road')
      .map((loc) => {
        const hit = withRecords[loc.id];
        return {
          id: loc.id,
          name: loc.name,
          areaName: locations.areaName(loc.area),
          cateLabel: locations.cateLabel(loc.cate),
          lat: loc.lat,
          lng: loc.lng,
          verified: loc.verified !== false,
          lost: hit ? hit.lost : 0,
          found: hit ? hit.found : 0,
          total: hit ? hit.total : 0,
          level: hit ? hit.level : 0
        };
      })
      .sort((a, b) => (b.total - a.total) || (a.name < b.name ? -1 : 1));
  },

  onKindChange(e) {
    this.setData({ kindKey: e.currentTarget.dataset.key });
    this.refresh();
  },

  onRangeChange(e) {
    this.setData({ rangeKey: Number(e.currentTarget.dataset.key) });
    this.refresh();
  },

  onCategoryChange(e) {
    const index = Number(e.detail.value);
    this.setData({ categoryKey: index === 0 ? 'all' : this.data.categories[index].key });
    this.refresh();
  },

  onMarkerTap(e) {
    const id = e.detail.markerId !== undefined ? e.detail.markerId : e.markerId;
    const cell = this.data.cells[id];
    if (!cell) return;
    this.setData({
      selected: cell,
      mapCenter: { lat: cell.lat, lng: cell.lng },
      mapScale: 18
    });
  },

  /** 点击地点清单：把地图焦点移过去（即使该地点暂时没有记录） */
  onCellTap(e) {
    const spot = this.data.campusSpots[e.currentTarget.dataset.index];
    if (!spot) return;
    const cell = this.data.cells.find((c) => c.id === spot.id) || null;
    this.setData({
      selected: cell || {
        id: spot.id,
        name: spot.name,
        areaName: spot.areaName,
        lat: spot.lat,
        lng: spot.lng,
        lost: 0,
        found: 0,
        total: 0
      },
      mapCenter: { lat: spot.lat, lng: spot.lng },
      mapScale: 18
    });
  },

  onClosePanel() {
    this.setData({ selected: null, mapScale: 16 });
  },

  /** 回到校园全貌 */
  onResetView() {
    const info = locations.campusInfo();
    this.setData({
      mapCenter: { lat: info.center.lat, lng: info.center.lng },
      mapScale: 15,
      selected: null
    });
  },

  onOpenMatches() {
    wx.switchTab({ url: '/pages/matches/matches' });
  },

  onHeatExplain() {
    const c = this.data.campus;
    wx.showModal({
      title: '地图说明',
      content: (c ? c.school + c.campus + '\n' : '') +
        '· 蓝色大圈：校区范围示意\n' +
        '· 彩色圈：某地点的事件热度，圈越大记录越多（蓝→黄→红递增）\n' +
        '· 气泡：地点名称与「失物数 · 拾物数」\n\n' +
        '按建筑/区域级聚合，不展示精确坐标、姓名与联系方式。\n' +
        '坐标系：' + (c ? c.coordSystem : 'GCJ-02') + '（微信地图坐标系）\n' +
        '数据来源：' + (c ? c.source : ''),
      showCancel: false
    });
  }
});
