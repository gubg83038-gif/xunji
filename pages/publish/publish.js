const app = getApp();
const service = require('../../utils/service');
const vlm = require('../../core/vlm');
const api = require('../../utils/api');
const config = require('../../core/config');
const timeUtil = require('../../core/time');
const locations = require('../../core/locations');
const categorical = require('../../core/categories');
const imageLib = require('../../core/image-spec');
const nav = require('../../utils/nav');

const FIELD_ORDER = [
  'brand', 'main_color', 'secondary_color', 'material', 'shape', 'size',
  'logo_text', 'pattern', 'sticker', 'damage_mark', 'accessory'
];

const AI_EDITABLE = ['brand', 'main_color', 'secondary_color', 'material', 'shape', 'size', 'logo_text', 'damage_mark'];

function buildAttrFields(attributes, sources, editingField) {
  return FIELD_ORDER.map((key) => ({
    key,
    label: vlm.FIELD_LABELS[key] || key,
    value: attributes[key] || '',
    source: sources[key] || (attributes[key] ? 'user' : ''),
    sourceLabel: sources[key] === 'image' ? 'AI 图像' : sources[key] === 'text' ? 'AI 文字' : sources[key] === 'both' ? 'AI 图+文' : '人工',
    editing: editingField === key,
    editable: AI_EDITABLE.indexOf(key) >= 0
  })).filter((f) => f.value || f.editing);
}

Page({
  data: {
    kind: 'lost',
    step: 1,
    // 图片
    images: [],
    imageTitles: [],
    // 文本
    description: '',
    // 类别
    categories: [],
    categoryIndex: -1,
    categoryName: '',
    // 地点
    hotLocations: [],
    locationText: '',
    locationId: '',
    locationName: '',
    locationMatched: true,
    // 时间
    timeText: '',
    dateStr: '',
    timeStr: '',
    timeStart: 0,
    timeEnd: 0,
    // 属性
    attributes: {},
    sources: {},
    attrFields: [],
    editingField: '',
    editingValue: '',
    notes: [],
    // 私有特征
    privateSuggestions: [],
    privateSelected: [],
    privateCustom: '',
    // 状态
    submitting: false,
    resultTip: ''
  },

  onLoad(query) {
    const kind = query && query.type === 'found' ? 'found' : 'lost';
    const now = Date.now();
    const cats = categorical.list();
    this.setData({
      kind,
      categories: cats,
      hotLocations: locations.list().slice(0, 14),
      dateStr: timeUtil.toDateInput(now),
      timeStr: timeUtil.toTimeInput(now - 30 * 60 * 1000)
    });
    wx.setNavigationBarTitle({ title: kind === 'lost' ? '发布失物' : '发布拾物' });
    this.refreshPrivateSuggestions();
    this.recompute(false);
  },

  /* ---------------- 输入 ---------------- */

  onSwitchType(e) {
    const kind = e.currentTarget.dataset.type === 'found' ? 'found' : 'lost';
    if (kind === this.data.kind) return;
    this.setData({ kind, privateSelected: [] });
    wx.setNavigationBarTitle({ title: kind === 'lost' ? '发布失物' : '发布拾物' });
    this.recompute(false);
  },

  onDescInput(e) {
    this.setData({ description: e.detail.value });
    // 输入过程中做轻量重算，让用户即时看到 AI 建议（发布时还会再算一次）
    if ((e.detail.value || '').length % 4 === 0 || (e.detail.value || '').length < 3) {
      this.recompute(false);
    }
  },

  onDescBlur() {
    this.recompute(true);
  },

  onPickCategory(e) {
    const index = Number(e.detail.value);
    const cate = this.data.categories[index];
    const attributes = Object.assign({}, this.data.attributes, { category: cate.key });
    const sources = Object.assign({}, this.data.sources, { category: 'user' });
    this.setData({
      categoryIndex: index,
      categoryName: cate.name,
      attributes,
      sources,
      attrFields: buildAttrFields(attributes, sources, this.data.editingField)
    });
    this.refreshPrivateSuggestions();
  },

  onPickLocation(e) {
    const index = Number(e.detail.value);
    const loc = this.data.hotLocations[index];
    this.setData({
      locationId: loc.id,
      locationName: loc.name,
      locationText: loc.name,
      locationMatched: true
    });
  },

  onLocationInput(e) {
    const text = e.detail.value;
    const norm = locations.normalize(text);
    this.setData({
      locationText: text,
      locationId: norm.matched ? norm.location.id : '',
      locationName: norm.matched ? norm.location.name : '未识别到标准地点',
      locationMatched: norm.matched
    });
  },

  onDateChange(e) {
    this.setData({ dateStr: e.detail.value });
    this.syncTimeText();
  },

  onTimeChange(e) {
    this.setData({ timeStr: e.detail.value });
    this.syncTimeText();
  },

  onTimeTextInput(e) {
    this.setData({ timeText: e.detail.value });
  },

  syncTimeText() {
    const start = timeUtil.fromPicker(this.data.dateStr, this.data.timeStr);
    if (!start) return;
    this.setData({
      timeStart: start,
      timeEnd: start + 50 * timeUtil.MIN,
      timeText: '约 ' + timeUtil.formatClock(start)
    });
  },

  /* ---------------- 图片 ---------------- */

  onChooseImage() {
    const lib = imageLib.list();
    const foundCategory = this.data.attributes.category;
    const labels = lib.map((x) => x.label + (x.category === foundCategory ? '（与当前类别一致）' : ''));
    wx.showActionSheet({
      itemList: labels.slice(0, 10),
      success: (res) => {
        const spec = lib[res.tapIndex];
        this.applyImage(spec);
      },
      fail: () => {}
    });
  },

  onUploadImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const path = res.tempFiles[0].tempFilePath;
        this.applyImage({ key: 'upload', label: '本地照片', image: path });
      },
      fail: () => {}
    });
  },

  applyImage(spec) {
    const image = spec.image || ('demo://' + spec.key);
    const images = this.data.images.concat([image]);
    this.setData({
      images,
      imageTitles: images.map((x) => imageLib.titleOf(x))
    });
    this.recompute(true);
  },

  onRemoveImage(e) {
    const index = Number(e.currentTarget.dataset.index);
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.setData({
      images,
      imageTitles: images.map((x) => imageLib.titleOf(x))
    });
    this.recompute(true);
  },

  /* ---------------- 结构化属性提取 ---------------- */

  /**
   * 重新提取属性。
   *
   * provider=local：直接用本地规则（离线、瞬时）
   * provider=deepseek 且云开发已启用：调用云函数 xj-ai，由 DeepSeek 视觉模型识别
   *   —— 图片需要以 base64 传给云函数，本地照片先读文件；
   *      演示图库不消耗模型额度，直接用内置线索。
   */
  async recompute(showTip) {
    const image = this.data.images[0] || '';
    const description = this.data.description;
    const local = vlm.extractAttributes({ image, description, type: this.data.kind });

    let aiResult = null;
    /**
     * 只在「真的有东西可识别」时才调云函数。
     *
     * 页面 onLoad 会调一次 recompute()，那时还没选图也没填描述。
     * 如果照样发请求，云函数会按设计拒绝（「需要提供图片或文字描述」），
     * 控制台刷出红色 error，还浪费一次云函数调用。
     */
    const isDemo = image.indexOf('demo://') === 0;
    const hasContent = !!image || !!(description && description.trim());
    if (api.isCloud() && config.aiReady() && hasContent) {
      if (showTip) wx.showLoading({ title: 'AI 识别中', mask: true });
      try {
        const payload = {
          image,
          description,
          type: this.data.kind,
          detail: 'low',
          mimeType: 'image/jpeg'
        };
        // 真实上传的本地照片：转 base64 交给云函数
        if (image && image.indexOf('http') !== 0 && !isDemo) {
          try {
            payload.imageBase64 = await api.readFileBase64(image);
          } catch (e) {
            console.warn('[寻迹] 读取图片失败，退化为仅用描述：', e.message);
          }
        }
        // base64 读取失败且没有文字描述时，云端也无从识别，直接用本地规则
        const canCallCloud = !!payload.imageBase64 || isDemo || !!(description && description.trim());
        if (canCallCloud) {
          aiResult = await api.extractAttributes(payload, () => null);
        }
      } catch (e) {
        console.error('[寻迹] AI 属性提取失败：', e.message);
      } finally {
        if (showTip) wx.hideLoading();
      }
    }

    const merged = aiResult && aiResult.attributes
      ? vlm.mergeAiResult(local, aiResult)
      : local;

    // 用户手动改过的属性优先级最高
    const userEdits = {};
    (this.data.attrFields || []).forEach((f) => {
      if (f.source === 'user' && f.value) userEdits[f.key] = f.value;
    });
    const attributes = Object.assign({}, merged.attributes, userEdits);
    const sources = Object.assign({}, merged.sources);
    Object.keys(userEdits).forEach((k) => { sources[k] = 'user'; });

    const catIndex = this.data.categories.findIndex((c) => c.key === attributes.category);
    if (catIndex >= 0 && this.data.categoryIndex < 0) {
      this.setData({ categoryIndex: catIndex, categoryName: this.data.categories[catIndex].name });
    }

    const notes = (merged.notes || []).slice();
    if (aiResult && aiResult.model && aiResult.model !== 'demo-hints') {
      notes.unshift('属性由 ' + aiResult.model + ' 视觉模型识别，请确认后再发布');
    }
    if (aiResult && aiResult.fallback) {
      notes.unshift('AI 服务暂不可用，已使用本地规则提取（' + (aiResult.error || '') + '）');
    }

    this.setData({
      attributes,
      sources,
      imageDescription: (aiResult && aiResult.description) || '',
      aiModel: (aiResult && aiResult.model) || 'local',
      notes,
      attrFields: buildAttrFields(attributes, sources, ''),
      resultTip: showTip
        ? '已根据' + (this.data.images.length ? '图片与描述' : '描述') + '更新结构化属性，可点击修改'
        : this.data.resultTip
    });
    this.refreshPrivateSuggestions();
  },

  onEditAttr(e) {
    const key = e.currentTarget.dataset.key;
    const field = this.data.attrFields.find((f) => f.key === key);
    if (!field) return;
    this.setData({ editingField: key, editingValue: field.value });
  },

  onAttrInput(e) {
    this.setData({ editingValue: e.detail.value });
  },

  onAttrSave() {
    const key = this.data.editingField;
    const value = this.data.editingValue;
    const attributes = Object.assign({}, this.data.attributes);
    const sources = Object.assign({}, this.data.sources);
    if (value) {
      attributes[key] = value;
      sources[key] = 'user';
    } else {
      delete attributes[key];
      delete sources[key];
    }
    this.setData({
      attributes,
      sources,
      editingField: '',
      editingValue: '',
      attrFields: buildAttrFields(attributes, sources, '')
    });
  },

  onAttrCancel() {
    this.setData({ editingField: '', editingValue: '' });
  },

  /* ---------------- 私有核验特征 ---------------- */

  refreshPrivateSuggestions() {
    const cate = categorical.get(this.data.attributes.category || 'other');
    const suggestions = (cate.privateFeatures || []).slice(0, 5);
    const selected = this.data.privateSelected.filter((x) => suggestions.indexOf(x) >= 0 || x.indexOf('自定义') === 0);
    this.setData({ privateSuggestions: suggestions, privateSelected: selected });
  },

  onTogglePrivate(e) {
    const value = e.currentTarget.dataset.value;
    const list = this.data.privateSelected.slice();
    const idx = list.indexOf(value);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(value);
    this.setData({ privateSelected: list });
  },

  onPrivateCustomInput(e) {
    this.setData({ privateCustom: e.detail.value });
  },

  onAddPrivateCustom() {
    const text = (this.data.privateCustom || '').trim();
    if (!text) return;
    const list = this.data.privateSelected.concat(['自定义：' + text]);
    this.setData({ privateSelected: list, privateCustom: '' });
  },

  /* ---------------- 提交 ---------------- */

  validate() {
    if (this.data.kind === 'lost') {
      if (!this.data.description.trim() && !this.data.images.length) {
        return '请至少上传一张照片或填写物品描述';
      }
      if (!this.data.locationText && !this.data.locationId) {
        return '请选择或填写丢失地点';
      }
    } else {
      if (!this.data.description.trim() && !this.data.images.length) {
        return '请至少上传一张照片或填写物品描述';
      }
      if (!this.data.locationId) {
        return '请选择发现地点（便于时空重排）';
      }
      if (!this.data.privateSelected.length) {
        return '请补充至少 1 项隐藏核验特征，用于防止冒领';
      }
    }
    return '';
  },

  onSubmit() {
    const err = this.validate();
    if (err) {
      wx.showToast({ title: err, icon: 'none', duration: 2200 });
      return;
    }

    this.setData({ submitting: true });
    const payload = {
      kind: this.data.kind,
      userId: app.globalData.userId,
      image: this.data.images[0] || '',
      images: this.data.images,
      description: this.data.description.trim(),
      imageDescription: this.data.imageDescription || '',
      attributesModel: this.data.aiModel || 'local',
      locationId: this.data.locationId,
      locationText: this.data.locationText || this.data.locationName,
      attributes: this.data.attributes,
      attributeSources: this.data.sources,
      aiResult: (this.data.imageDescription || this.data.aiModel === 'deepseek') ? {
        description: this.data.imageDescription || '',
        model: this.data.aiModel,
        attributes: this.data.attributes
      } : null,
      privateFeatures: this.data.kind === 'found' ? this.data.privateSelected : this.data.privateSelected.map((x) => x.replace('自定义：', ''))
    };

    if (this.data.kind === 'lost') {
      const start = this.data.timeStart || timeUtil.fromPicker(this.data.dateStr, this.data.timeStr);
      payload.timeStart = start;
      payload.timeEnd = this.data.timeEnd || start + 50 * timeUtil.MIN;
      payload.timeText = this.data.timeText;
    } else {
      payload.foundTime = this.data.timeStart || timeUtil.fromPicker(this.data.dateStr, this.data.timeStr);
      payload.timeText = this.data.timeText;
    }

    const result = service.publish(payload);
    app.globalData.activeLostId = this.data.kind === 'lost' ? result.item.id : app.globalData.activeLostId;

    wx.hideLoading();
    wx.showModal({
      title: '发布成功',
      content: '系统已完成结构化与首次匹配，共找到 ' + result.matchCount + ' 个候选' +
        (result.locationMatched ? '' : '（地点未匹配到标准地点，已按校园中心处理）'),
      confirmText: '查看候选',
      cancelText: '稍后再说',
      success: (res) => {
        this.setData({ submitting: false });
        if (res.confirm) {
          /**
           * 「匹配」是 tabBar 页面，**必须用 nav.go**（内部走 switchTab）。
           *
           * 真实 bug：这里原本用 navigateTo 直接打开匹配页并拼了 query，
           * 而 navigateTo 打开 tabBar 页面会**静默失败**——不跳转、不报错，
           * 用户看到的就是「发布成功了但匹配页还是原来那几条」。
           * 另外 switchTab 不支持 query，所以 itemId 必须经 nav 暂存到 globalData。
           */
          nav.go(app, '/pages/matches/matches', {
            itemId: result.item.id,
            kind: this.data.kind
          });
        } else {
          wx.navigateBack();
        }
      }
    });
  },

  onGuide() {
    wx.showModal({
      title: '怎么填更容易被匹配到？',
      content: '1. 描述里带上颜色、材质、品牌等可比较的属性；\n2. 尽量填写准确的时间范围和地点；\n3. 拾物者请务必保留 1—2 个只有真正失主才知道的隐藏特征。',
      showCancel: false
    });
  },

  /** 供“重新提取”按钮使用：显式要求显示更新提示 */
  onRerunExtract() {
    this.recompute(true);
  }
});