const app = getApp();
const service = require('../../utils/service');
const vlm = require('../../core/vlm');
const vision = require('../../utils/vision');
const timeUtil = require('../../core/time');
const locations = require('../../core/locations');
const categorical = require('../../core/categories');
const imageLib = require('../../core/image-spec');
const nav = require('../../utils/nav');

const FIELD_ORDER = [
  'brand', 'main_color', 'secondary_color', 'material', 'shape', 'size',
  'logo_text', 'pattern', 'sticker', 'damage_mark', 'accessory', 'features'
];

const AI_EDITABLE = FIELD_ORDER;

/**
 * 自定义隐藏特征的前缀。
 * 必须与 refreshPrivateSuggestions / 提交时的 replace 保持一致，
 * 否则自定义项会在重新提取属性后被当成「不属于当前类别」而静默丢弃。
 */
const PRIVATE_PREFIX = '自定义：';

/**
 * 构造结构化属性列表。
 *
 * ⚠ 真实缺口（本轮修复）：旧实现最后有一句
 *     `.filter((f) => f.value || f.editing)`
 *   于是**所有没识别出内容的字段都不会渲染**。AI 没识别出「品牌」时，
 *   用户根本找不到可以点的那一行去手工补——而产品说明写的是
 *   「每个字段可点开人工修改」。属性区越空，缺口越明显。
 *
 * 现在：可编辑字段始终渲染（空值显示「未识别 · 点击填写」），
 * 不可编辑字段只在有值时出现（模型原始字段，不需要用户去填）。
 */
function buildAttrFields(attributes, sources, editingField) {
  return FIELD_ORDER.map((key) => {
    const value = Array.isArray(attributes[key]) ? attributes[key].join('、') : attributes[key] || '';
    const editable = AI_EDITABLE.indexOf(key) >= 0;
    return {
      key,
      label: vlm.FIELD_LABELS[key] || key,
      value,
      empty: !value,
      source: sources[key] || (attributes[key] ? 'user' : ''),
      sourceLabel: sources[key] === 'image' ? 'AI 图像' : sources[key] === 'text' ? 'AI 文字' : sources[key] === 'both' ? 'AI 图+文' : sources[key] === 'ai' ? 'AI 建议' : sources[key] === 'demo' ? '演示线索' : (value ? '人工' : '待补充'),
      editing: editingField === key,
      editable
    };
  }).filter((f) => f.editable || f.value || f.editing);
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
    confidence: {},
    aiSuggestions: [],
    imageDescription: '',
    aiModel: 'local',
    extracting: false,
    aiState: 'idle',
    aiMessage: '',
    aiVideoFailed: false,
    attrFields: [],
    editingField: '',
    editingValue: '',
    notes: [],
    // 私有特征
    privateSuggestions: [],
    privateSelected: [],
    privateCustom: '',
    privateDeletedCount: 0,
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
    if (this.data.submitting) return;
    this.setData({ description: e.detail.value, extracting: false });
    this._extractRequest = (this._extractRequest || 0) + 1;
    clearTimeout(this._descTimer);
    this._descTimer = setTimeout(() => this.recompute(false), 450);
  },

  onDescBlur() {
    clearTimeout(this._descTimer);
    return this.recompute(true);
  },

  onUnload() {
    this._closed = true;
    this._extractRequest = (this._extractRequest || 0) + 1;
    clearTimeout(this._descTimer);
    clearTimeout(this._aiStageTimer);
    clearTimeout(this._aiCloseTimer);
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

  setAiProgress(state, message) {
    if (this._closed) return;
    this.setData({ aiState: state, aiMessage: message });
  },

  beginAiProgress() {
    clearTimeout(this._aiStageTimer);
    clearTimeout(this._aiCloseTimer);
    this.setData({
      extracting: true,
      aiState: 'preparing',
      aiMessage: '正在读取图片',
      aiVideoFailed: false
    });
    this._aiStageTimer = setTimeout(() => {
      if (!this._closed) this.setAiProgress('recognizing', '正在识别物品特征');
    }, 420);
  },

  finishAiProgress(state, message) {
    if (this._closed) return;
    clearTimeout(this._aiStageTimer);
    this.setAiProgress(state, message);
    clearTimeout(this._aiCloseTimer);
    this._aiCloseTimer = setTimeout(() => {
      if (!this._closed) this.setData({ aiState: 'idle', aiMessage: '', extracting: false });
    }, 450);
  },

  onAiVideoError() {
    if (!this._closed) this.setData({ aiVideoFailed: true });
  },

  /**
   * 重新提取属性。
   *
   * provider=local：直接用本地规则（离线、瞬时）
   * provider=deepseek 且云开发已启用：调用云函数 xj-ai，由 DeepSeek 视觉模型识别
   *   —— 图片需要以 base64 传给云函数，本地照片先读文件；
   *      演示图库不消耗模型额度，直接用内置线索。
   */
  async recompute(showTip, force) {
    if (this._closed) return;
    this.setData({ extracting: false });
    const request = this._extractRequest = (this._extractRequest || 0) + 1;
    const image = this.data.images[0] || '';
    const description = this.data.description;
    const local = vlm.extractAttributes({ image, description, type: this.data.kind });

    if (!image || (this._visual && this._visual.image !== image)) this._visual = null;
    let aiResult = this._visual ? this._visual.result : null;
    let warning = '';
    if (showTip && (image || description.trim()) && (!aiResult || force)) {
      this._loadingRequest = request;
      let terminalState = 'success';
      this.beginAiProgress();
      try {
        // 视觉观察独立于用户陈述，同一照片结果不会因补文字而消失。
        const candidate = await vision.recognize({ image, description: image ? '' : description, type: this.data.kind, force: !!force });
        if (this._closed || request !== this._extractRequest) return;
        if (!candidate.fallback && candidate.status !== 'empty') {
          aiResult = candidate;
          if (image) this._visual = { image, result: candidate };
        } else {
          warning = candidate.warning || 'AI 服务暂不可用，已使用文字规则分析';
          terminalState = 'fallback';
          if (!aiResult) aiResult = candidate;
        }
      } catch (e) {
        warning = e.message;
        terminalState = 'error';
        if (!aiResult) aiResult = { model: 'local', fallback: true, warning, attributes: {} };
      } finally {
        if (this._loadingRequest === request && !this._closed && request === this._extractRequest) {
          this.finishAiProgress(
            terminalState,
            terminalState === 'success'
              ? '正在整理可匹配信息'
              : terminalState === 'fallback'
                ? 'AI 暂不可用，正在使用本地规则'
                : '识别未完成，可继续手动填写'
          );
        }
      }
    }
    if (this._closed || request !== this._extractRequest) return;
    const merged = aiResult ? vlm.mergeAiResult(local, aiResult) : local;

    // 用户手动改过的属性优先级最高
    const userEdits = {};
    if (this.data.sources.category === 'user') userEdits.category = this.data.attributes.category;
    (this.data.attrFields || []).forEach((f) => {
      if (f.source === 'user' && f.value) userEdits[f.key] = f.key === 'features'
        ? (Array.isArray(this.data.attributes.features) ? this.data.attributes.features.slice() : f.value.split(/[、，,;；]/)) : f.value;
    });
    const attributes = Object.assign({}, merged.attributes, userEdits);
    const sources = Object.assign({}, merged.sources);
    const confidence = Object.assign({}, merged.confidence);
    Object.keys(userEdits).forEach((k) => { sources[k] = 'user'; });
    Object.keys(userEdits).forEach((k) => { confidence[k] = 1; });

    const catIndex = this.data.categories.findIndex((c) => c.key === attributes.category);
    if (catIndex >= 0 && sources.category !== 'user') {
      this.setData({ categoryIndex: catIndex, categoryName: this.data.categories[catIndex].name });
    }

    const notes = (merged.notes || []).slice();
    if (aiResult && !aiResult.fallback && aiResult.model && !/^local/.test(aiResult.model) && aiResult.model !== 'demo-hints') {
      notes.unshift('属性由 ' + aiResult.model + (image ? ' 分析照片' : ' 分析文字') + '，请确认后再发布');
    }
    if (warning) notes.unshift(warning + (this._visual ? '；已保留这张照片上次成功的分析' : ''));
    const pending = (merged.suggestions || []).filter((s) => !userEdits[s.key]);

    this.setData({
      attributes,
      sources,
      confidence,
      aiSuggestions: pending,
      imageDescription: (image && aiResult && !aiResult.fallback && aiResult.description) || '',
      aiModel: (aiResult && aiResult.model) || 'local',
      notes,
      attrFields: buildAttrFields(attributes, sources, ''),
      resultTip: showTip
        ? (warning && this._visual ? '本次重新识别未完成，已保留此前的视觉线索，可点击修改' : (warning || aiResult && aiResult.fallback)
          ? (description.trim() ? '照片或 AI 分析暂不可用，已根据文字更新属性，可点击修改' : '照片识别未完成，请重新识别或手动填写属性')
          : pending.length ? '已提取物品线索，部分建议需要确认后采用'
          : '已根据' + (image ? '图片与描述' : '描述') + '更新结构化属性，可点击修改')
        : this.data.resultTip
    });
    this.refreshPrivateSuggestions();
  },

  onConfirmAiSuggestion(e) {
    const key = e.currentTarget.dataset.key;
    const suggestion = this.data.aiSuggestions.find((s) => s.key === key);
    if (!suggestion || vlm.ALLOWED_FIELDS.indexOf(key) < 0) return;
    const attributes = Object.assign({}, this.data.attributes, { [key]: suggestion.value });
    const sources = Object.assign({}, this.data.sources, { [key]: 'user' });
    const confidence = Object.assign({}, this.data.confidence, { [key]: 1 });
    const patch = { attributes, sources, confidence,
      aiSuggestions: this.data.aiSuggestions.filter((s) => s.key !== key),
      attrFields: buildAttrFields(attributes, sources, '') };
    patch.resultTip = patch.aiSuggestions.length ? '已采用这条线索，其余建议请继续确认' : '待确认线索已采用，可继续修改属性';
    if (key === 'category') {
      patch.categoryIndex = this.data.categories.findIndex((c) => c.key === suggestion.value);
      patch.categoryName = categorical.nameOf(suggestion.value);
    }
    this.setData(patch);
    this.refreshPrivateSuggestions();
  },

  onEditAttr(e) {
    const key = e.currentTarget.dataset.key;
    const field = this.data.attrFields.find((f) => f.key === key);
    if (!field) return;
    this.setData({ editingField: key, editingValue: field.value,
      attrFields: buildAttrFields(this.data.attributes, this.data.sources, key) });
  },

  onAttrInput(e) {
    this.setData({ editingValue: e.detail.value });
  },

  onAttrSave() {
    const key = this.data.editingField;
    if (vlm.ALLOWED_FIELDS.indexOf(key) < 0) return;
    const value = String(this.data.editingValue || '').trim();
    const attributes = Object.assign({}, this.data.attributes);
    const sources = Object.assign({}, this.data.sources);
    if (value) {
      attributes[key] = key === 'features' ? value.split(/[、，,;；]/).map((s) => s.trim()).filter(Boolean).slice(0, 4) : value;
      sources[key] = 'user';
    } else {
      delete attributes[key];
      delete sources[key];
    }
    this.setData({
      attributes,
      sources,
      confidence: Object.assign({}, this.data.confidence, { [key]: value ? 1 : 0 }),
      editingField: '',
      editingValue: '',
      attrFields: buildAttrFields(attributes, sources, '')
    });
  },

  onAttrCancel() {
    this.setData({ editingField: '', editingValue: '',
      attrFields: buildAttrFields(this.data.attributes, this.data.sources, '') });
  },

  /* ---------------- 私有核验特征 ---------------- */

  /**
   * 刷新类别推荐特征。
   *
   * ⚠ 这里踩过两个坑（用户报「自定义问题加错了没法撤回」时一并发现）：
   *   1. 判断自定义项用的是 `indexOf('自定义') === 0`，而实际写入的前缀是
   *      `'自定义：' + text`（带全角冒号）——某些情况下匹配不上，
   *      用户加的自定义特征会在下一次「重新提取」时被静默丢掉。
   *      现在统一用 PRIVATE_PREFIX 常量判断。
   *   2. 用户手动删掉的推荐项会被重新加回来。现在用 `_privateRemoved`
   *      记住「本次编辑里被删掉的推荐项」，刷新时不复活。
   */
  refreshPrivateSuggestions() {
    const cate = categorical.get(this.data.attributes.category || 'other');
    const removed = this._privateRemoved || [];
    const suggestions = (cate.privateFeatures || [])
      .filter((x) => removed.indexOf(x) < 0)
      .slice(0, 5);
    const selected = this.data.privateSelected.filter((x) =>
      suggestions.indexOf(x) >= 0 || x.indexOf(PRIVATE_PREFIX) === 0);
    this.setData({
      privateSuggestions: suggestions,
      privateSelected: selected,
      privateDeletedCount: removed.length
    });
  },

  onTogglePrivate(e) {
    const value = e.currentTarget.dataset.value;
    const list = this.data.privateSelected.slice();
    const idx = list.indexOf(value);
    if (idx >= 0) {
      list.splice(idx, 1);
      this._privateRemoved = (this._privateRemoved || []).concat([value]);
    } else {
      list.push(value);
      this._privateRemoved = (this._privateRemoved || []).filter((x) => x !== value);
    }
    this.setData({ privateSelected: list });
  },

  onPrivateCustomInput(e) {
    this.setData({ privateCustom: e.detail.value });
  },

  onAddPrivateCustom() {
    const text = (this.data.privateCustom || '').trim();
    if (!text) {
      wx.showToast({ title: '请先输入要补充的特征', icon: 'none' });
      return;
    }
    const value = PRIVATE_PREFIX + text;
    const list = this.data.privateSelected.slice();
    if (list.indexOf(value) >= 0) {
      wx.showToast({ title: '这条特征已经加过了', icon: 'none' });
      return;
    }
    list.push(value);
    this._privateRemoved = (this._privateRemoved || []).filter((x) => x !== value);
    this.setData({ privateSelected: list, privateCustom: '' });
  },

  /** 删除任意一项已选特征（推荐项或自定义项都支持撤回） */
  onRemovePrivate(e) {
    const index = Number(e.currentTarget.dataset.index);
    const list = this.data.privateSelected.slice();
    const value = list[index];
    if (value === undefined) return;
    list.splice(index, 1);
    if (value.indexOf(PRIVATE_PREFIX) !== 0) {
      this._privateRemoved = (this._privateRemoved || []).concat([value]);
    }
    this.setData({ privateSelected: list });
  },

  /** 撤销「删除」，把刚删掉的推荐特征放回来 */
  onRestorePrivate() {
    if (!(this._privateRemoved || []).length) {
      wx.showToast({ title: '没有已删除的特征', icon: 'none' });
      return;
    }
    this._privateRemoved = [];
    this.refreshPrivateSuggestions();
    wx.showToast({ title: '已恢复全部推荐特征', icon: 'success' });
  },

  /** 全部清空已选特征（自定义项也能一次撤回） */
  onClearPrivate() {
    if (!this.data.privateSelected.length) return;
    wx.showModal({
      title: '清空已选特征',
      content: '将移除全部已选隐藏特征（含自定义项）。拾物保留隐藏特征可以防止冒领，建议至少留 1 项。',
      success: (res) => {
        if (!res.confirm) return;
        const removed = (this._privateRemoved || []).concat(
          this.data.privateSelected.filter((x) => x.indexOf(PRIVATE_PREFIX) !== 0)
        );
        this._privateRemoved = removed.filter((x, i) => removed.indexOf(x) === i);
        this.setData({ privateSelected: [] });
        this.refreshPrivateSuggestions();
        wx.showToast({ title: '已清空，可随时重新勾选', icon: 'none' });
      }
    });
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

  async onSubmit() {
    if (this.data.submitting || this._closed) return;
    if (this.data.extracting) {
      wx.showToast({ title: '照片分析尚未完成，请稍候再发布', icon: 'none' });
      return;
    }
    clearTimeout(this._descTimer);
    this.setData({ submitting: true });
    await this.recompute(false);
    if (this._closed) return;
    const err = this.validate();
    if (err) {
      this.setData({ submitting: false });
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
      attributeConfidence: this.data.confidence,
      aiResult: this.data.aiModel !== 'local' ? {
        description: this.data.imageDescription || '',
        model: this.data.aiModel,
        attributes: this.data.attributes,
        sources: this.data.sources,
        confidence: this.data.confidence
      } : null,
      privateFeatures: this.data.kind === 'found' ? this.data.privateSelected : this.data.privateSelected.map((x) => x.replace(PRIVATE_PREFIX, ''))
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

    let result;
    wx.showLoading({ title: '正在保存', mask: true });
    try {
      result = await service.publishAsync(payload);
    } catch (e) {
      if (!this._closed) wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      return;
    } finally {
      wx.hideLoading();
      if (!this._closed) this.setData({ submitting: false });
    }
    if (this._closed) return;
    app.globalData.activeLostId = this.data.kind === 'lost' ? result.item.id : app.globalData.activeLostId;

    wx.hideLoading();
    wx.showModal({
      title: result.mode === 'local' ? '已保存到本机' : '发布成功',
      content: (result.mode === 'local' ? '当前记录保存在本机；云端用户暂时无法看到。' : '') + '系统已完成结构化与首次匹配，共找到 ' + result.matchCount + ' 个候选' +
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
    if (this.data.extracting) return;
    this.recompute(true, true);
  }
});
