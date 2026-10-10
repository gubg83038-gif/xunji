const assert = require('assert');
const Module = require('module');
const path = require('path');
const engine = require('../core/search');
const vlm = require('../core/vlm');
const store = require('../utils/store');
const api = require('../utils/api');
const retrieval = require('../utils/search');
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log('  ✓ ' + name); }
const items = [
  { id: 'cup-black', kind: 'found', title: '黑色保温杯', description: '黑色保温杯，白色文字，有贴纸', imageDescription: '黑色杯身印有白色文字', image: 'https://example.test/cup.jpg', status: 'available', attributes: { category: 'cup', main_color: '黑色', sticker: '有贴纸' }, privateFeatures: ['杯底刻字秘密'], identityId: 'secret-id', location: { name: '图书馆' }, createdAt: 10 },
  { id: 'cup-blue', kind: 'found', title: '蓝色保温杯', description: '蓝色保温杯', status: 'available', attributes: { category: 'cup', main_color: '蓝色' } },
  { id: 'umbrella', kind: 'found', title: '蓝色折叠雨伞', description: '蓝色折叠雨伞', status: 'available', attributes: { category: 'umbrella', main_color: '蓝色' } },
  { id: 'returned', kind: 'found', description: '黑色保温杯，白色文字，有贴纸', status: 'returned', attributes: { category: 'cup' } },
  { id: 'reserved', kind: 'found', description: '黑色保温杯，白色文字，有贴纸', status: 'reserved', attributes: { category: 'cup' } },
  { id: 'lost', kind: 'lost', title: '黑色保温杯', description: '黑色保温杯，白色文字', status: 'searching', attributes: { category: 'cup', main_color: '黑色' } }
];
let pageConfig;
global.Page = (p) => { pageConfig = p; };
const navigations = [];
global.wx = { navigateTo: (p) => navigations.push(p.url), setNavigationBarTitle: () => {} };
global.getApp = () => ({ globalData: { userId: 'u_me' } });
function page(rel) {
  delete require.cache[require.resolve(rel)];
  require(rel);
  const p = Object.assign({}, pageConfig, { data: JSON.parse(JSON.stringify(pageConfig.data)) });
  p.setData = (patch) => Object.assign(p.data, patch);
  return p;
}
async function main() {
  await test('自然语言无需发布即可检索，颜色与个性特征正确候选领先', () => {
    const r = engine.search({ description: '黑色保温杯，白色文字，有贴纸' }, items);
    assert.equal(r.results[0].id, 'cup-black');
    assert(r.results[0].score > r.results.find((x) => x.id === 'cup-blue').score);
  });
  await test('匹配图片描述，即使公开文字没有这些线索', () => {
    const r = engine.search({ description: '黑色杯身印有白色文字' }, [Object.assign({}, items[0], { title: '待认领物品', description: '', attributes: {} })]);
    assert.equal(r.results[0].id, 'cup-black');
  });
  await test('纯图识别结果可以形成临时查询', () => {
    assert.equal(engine.search({ imageDescription: '黑色保温杯白色文字', attributes: { category: 'cup', main_color: '黑色' } }, items).results[0].id, 'cup-black');
  });
  await test('已归还、关闭及锁定记录不参加找物', () => {
    const r = engine.search({ description: '黑色保温杯' }, items);
    assert(!r.results.some((x) => ['returned', 'reserved', 'lost'].includes(x.id)));
  });
  await test('切换失物与类别筛选均生效', () => {
    assert.equal(engine.search({ description: '黑色保温杯', kind: 'lost' }, items).results[0].id, 'lost');
    const r = engine.search({ description: '蓝色雨伞', category: 'umbrella' }, items);
    assert(r.results.every((x) => x.category === 'umbrella'));
  });
  await test('空查询拒绝，未知线索不会返回全部物品', () => {
    assert.throws(() => engine.search({}, items), /请填写/);
    assert.equal(engine.search({ description: '火星飞船反应堆' }, items).results.length, 0);
  });
  await test('数量上限与缺图占位信息正确', () => {
    assert.equal(engine.search({ description: '保温杯', topK: 1 }, items).results.length, 1);
    const r = engine.search({ description: '蓝色折叠雨伞' }, items).results[0];
    assert.equal(r.hasImage, false); assert.equal(r.photoLabel, '暂无真实照片');
  });
  await test('查询不修改源数据且不泄露秘密、标注或向量', () => {
    const before = JSON.stringify(items);
    const r = engine.search({ description: '黑色保温杯' }, items);
    assert.equal(JSON.stringify(items), before);
    assert(!JSON.stringify(r).includes('杯底刻字秘密')); assert(!JSON.stringify(r).includes('secret-id'));
    assert(!JSON.stringify(r).includes('embeddings'));
  });
  await test('未知真实照片不会生成随机属性', () => {
    const attr = vlm.extractAttributes({ image: 'wxfile://unknown-photo.jpg' }).attributes;
    assert.deepEqual(attr, { category: 'other' });
  });
  const originalCloud = api.isCloud;
  const originalExtract = api.extractAttributes;
  const originalCall = api.callApi;
  const originalItems = store.itemsOf;
  const originalRead = api.readFileBase64;
  api.isCloud = () => false; store.itemsOf = () => items;
  await test('离线真实照片必须补文字，不造图片识别结果', async () => {
    await assert.rejects(retrieval.search({ image: 'wxfile://a.jpg' }), /离线/);
    const r = await retrieval.search({ image: 'wxfile://a.jpg', description: '黑色保温杯' });
    assert.equal(r.results[0].id, 'cup-black'); assert.equal(r.model, 'local');
  });
  await test('旧云端接口兼容本机缓存并明确标注', async () => {
    api.isCloud = () => true;
    api.extractAttributes = async (p, fallback) => fallback();
    api.callApi = async () => { throw Object.assign(new Error('未知 action'), { code: 'UNKNOWN_ACTION' }); };
    const r = await retrieval.search({ description: '黑色保温杯' });
    assert.equal(r.mode, 'cache'); assert(r.note.includes('尚未部署'));
  });
  await test('真实网络失败明确报错，不伪装成最新云端结果', async () => {
    api.callApi = async () => { throw new Error('网络断开'); };
    await assert.rejects(retrieval.search({ description: '保温杯' }), /云端搜索暂时不可用/);
  });
  await test('云端权限错误不给用户显示内部调用标识，可主动选择本机查询', async () => {
    api.callApi = async () => { throw new Error('-601034 没有权限 callid-secret'); };
    await assert.rejects(retrieval.search({ description: '黑色保温杯' }), (e) => /访问权限/.test(e.message) && !e.message.includes('callid-secret'));
    api.extractAttributes = async () => { throw new Error('本机查询不应调用模型'); };
    const r = await retrieval.search({ description: '黑色保温杯', localOnly: true });
    assert.equal(r.results[0].id, 'cup-black'); assert.equal(r.mode, 'local'); assert(r.note.includes('本机已有数据'));
  });
  await test('照片只交给识别接口，不传给检索业务接口', async () => {
    api.readFileBase64 = async () => 'image-payload';
    api.extractAttributes = async (p) => {
      assert.equal(p.imageBase64, 'image-payload');
      return { attributes: { category: 'cup', main_color: '黑色' }, confidence: { category: 0.95, main_color: 0.9 }, description: '黑色保温杯', model: 'visual-model' };
    };
    api.callApi = async (action, p) => { assert.equal(action, 'item.search'); assert(!p.image); assert(!p.imageBase64); return engine.search(p, items); };
    const r = await retrieval.search({ image: 'wxfile://a.jpg' });
    assert.equal(r.results[0].id, 'cup-black'); assert.equal(r.mode, 'cloud');
  });
  await test('缺失置信度的眼镜类别仅作软召回，页面仍拿到待确认类别与特征', async () => {
    const vision = require('../utils/vision'); vision.clearCache();
    api.extractAttributes = async () => ({ attributes: { category: 'glasses', features: ['细框', '双鼻托'] }, model: 'visual-model' });
    const glasses = { id: 'glasses', kind: 'found', status: 'available', description: '黑色细框眼镜，双鼻托', attributes: { category: 'glasses' } };
    api.callApi = async (action, query) => {
      assert.equal(query.attributes.category, 'other'); assert(query.visualHints.includes('眼镜')); assert(!query.imageBase64);
      return engine.search(query, [glasses]);
    };
    const r = await retrieval.search({ image: 'wxfile://glasses.jpg' });
    assert.equal(r.results[0].id, 'glasses'); assert.equal(r.recognition.suggestions[0].displayValue, '眼镜');
    assert.equal(r.recognition.status, 'needs_confirmation');
  });
  await test('只识别出照片描述也能检索并展示，低置信度值不用于软召回', async () => {
    const vision = require('../utils/vision'); vision.clearCache();
    api.extractAttributes = async () => ({ attributes: { category: 'cup' }, confidence: { category: 0 }, description: '一张蓝白色校园卡', model: 'visual-model' });
    api.callApi = async (action, query) => { assert.equal(query.visualHints, ''); return engine.search(query, []); };
    const r = await retrieval.search({ image: 'wxfile://card.jpg' });
    assert.equal(r.recognition.description, '一张蓝白色校园卡'); assert.equal(r.recognition.suggestions[0].confidence, 0);
    assert.equal(r.clues.length, 0);
  });
  await test('只有低置信度线索时展示待确认信息，避免假装已经识别或进行空查询', async () => {
    require('../utils/vision').clearCache();
    api.extractAttributes = async () => ({ attributes: { category: 'glasses' }, confidence: { category: 0.2 }, model: 'visual-model' });
    api.callApi = async () => { throw new Error('不应进行无可靠线索查询'); };
    const r = await retrieval.search({ image: 'wxfile://uncertain.jpg' });
    assert.equal(r.recognition.suggestions[0].displayValue, '眼镜'); assert.equal(r.total, 0); assert(r.note.includes('待确认'));
  });
  Object.assign(api, { isCloud: originalCloud, extractAttributes: originalExtract, callApi: originalCall, readFileBase64: originalRead });
  store.itemsOf = originalItems;
  await test('业务错误经过真实客户端调用层仍保留错误码', async () => {
    global.wx.cloud = { init: () => {}, callFunction: async () => ({ result: { ok: false, error: { code: 'UNKNOWN_ACTION', message: '尚未部署' } } }) };
    delete require.cache[require.resolve('../utils/api')];
    const freshApi = require('../utils/api');
    await assert.rejects(freshApi.callApi('item.search', {}), (e) => e.code === 'UNKNOWN_ACTION');
    delete global.wx.cloud;
  });
  const originalSearch = retrieval.search;
  await test('搜索页展示照片观察与待确认建议，换图或输入后清除旧线索', async () => {
    retrieval.search = async () => ({ results: [], clues: [], total: 0, scanned: 0, elapsed: 0, model: 'vision-model',
      recognition: { description: '一副细框眼镜', suggestions: [{ key: 'category', displayValue: '眼镜' }] } });
    const p = page('../pages/search/search'); p.onLoad(); p.data.image = '/tmp/glasses'; await p.onSearch();
    assert.equal(p.data.visualDescription, '一副细框眼镜'); assert.equal(p.data.suggestions[0].displayValue, '眼镜');
    p.onInput({ detail: { value: '饭卡' } }); assert.equal(p.data.visualDescription, ''); assert.deepEqual(p.data.suggestions, []);
  });
  await test('本机搜索切换范围及类别仍查本机，显式搜索可重试云端', async () => {
    const queries = [];
    retrieval.search = async (p) => { queries.push(p); return { results: [], clues: [], total: 0, scanned: 0, elapsed: 0, model: 'local', note: '' }; };
    const p = page('../pages/search/search'); p.onLoad(); p.onInput({ detail: { value: '杯子' } });
    await p.onSearchLocal(); await p.onKind({ currentTarget: { dataset: { kind: 'lost' } } });
    await p.onCategory({ detail: { value: 1 } });
    assert(queries.every((q) => q.localOnly));
    await p.onSearch(); assert.equal(queries[3].localOnly, false);
  });
  await test('连续输入不触发模型或检索', () => {
    let calls = 0; retrieval.search = async () => { calls += 1; };
    const p = page('../pages/search/search'); p.onLoad();
    for (let i = 0; i < 50; i += 1) p.onInput({ detail: { value: '描述' + i } });
    assert.equal(calls, 0); assert.equal(p.data.description, '描述49');
  });
  await test('新查询结果不会被旧查询的异步返回覆盖', async () => {
    const resolves = [];
    retrieval.search = () => new Promise((resolve) => resolves.push(resolve));
    const p = page('../pages/search/search'); p.onLoad();
    p.onInput({ detail: { value: '杯子' } }); const first = p.onSearch();
    p.onInput({ detail: { value: '雨伞' } }); const second = p.onSearch();
    const response = (id) => ({ results: [{ id }], clues: [], total: 1, scanned: 1, elapsed: 0, model: 'local', note: '' });
    resolves[1](response('new')); await second;
    resolves[0](response('old')); await first;
    assert.equal(p.data.results[0].id, 'new'); assert.equal(p.data.loading, false);
  });
  await test('退出页面后异步返回不更新页面', async () => {
    let resolve; retrieval.search = () => new Promise((r) => { resolve = r; });
    const p = page('../pages/search/search'); p.onLoad(); p.onInput({ detail: { value: '杯子' } });
    const work = p.onSearch(); p.onUnload(); resolve({ results: [{ id: 'late' }] }); await work;
    assert.deepEqual(p.data.results, []);
  });
  await test('详情跳转只接受当前搜索结果', () => {
    const p = page('../pages/search/search'); p.onLoad(); p.data.results = [{ id: 'cup-black' }];
    p.onDetail({ currentTarget: { dataset: { id: 'cup-black' } } });
    assert.equal(navigations.pop(), '/pages/detail/detail?id=cup-black');
  });
  retrieval.search = originalSearch;
  await test('发布页快速输入只做一次防抖本地分析', async () => {
    const p = page('../pages/publish/publish'); let calls = 0;
    p.recompute = async (showTip) => { assert.equal(showTip, false); calls += 1; };
    for (let i = 0; i < 20; i += 1) p.onDescInput({ detail: { value: '杯子' + i } });
    await new Promise((resolve) => setTimeout(resolve, 500)); assert.equal(calls, 1); p.onUnload();
  });
  await test('照片识别失败保留人工属性并明确显示未完成识别', async () => {
    const vision = require('../utils/vision'); const originalRecognize = vision.recognize;
    wx.showLoading = () => {}; wx.hideLoading = () => {};
    vision.recognize = async () => { throw new Error('照片读取失败'); };
    try {
      const p = page('../pages/publish/publish');
      p.data.images = ['/tmp/unreadable']; p.data.categories = [{ key: 'cup', name: '杯子' }];
      p.data.attributes = { category: 'cup', brand: '手工品牌' }; p.data.sources = { category: 'user', brand: 'user' };
      p.data.attrFields = [{ key: 'brand', value: '手工品牌', source: 'user' }];
      await p.recompute(true);
      assert.equal(p.data.attributes.brand, '手工品牌'); assert.equal(p.data.attributes.category, 'cup');
      assert(p.data.resultTip.includes('识别未完成')); assert(p.data.notes.includes('照片读取失败'));
    } finally { vision.recognize = originalRecognize; }
  });
  await test('同图视觉结果在补文字及重试失败后保留，换图后清除', async () => {
    const vision = require('../utils/vision'); const saved = vision.recognize; let calls = 0;
    vision.recognize = async (p) => {
      calls += 1; assert.equal(p.description, '');
      if (p.force || p.image === '/tmp/new') throw new Error('识别暂不可用');
      return { attributes: { category: 'cup', brand: '图片品牌' }, confidence: { category: 0.95, brand: 0.9 }, sources: { category: 'ai', brand: 'ai' }, description: '黑色杯身白色文字', model: 'vision-model', notes: [] };
    };
    try {
      const p = page('../pages/publish/publish'); p.data.categories = require('../core/categories').list(); p.data.images = ['/tmp/old'];
      await p.recompute(true); p.data.description = '我刚丢了这个物品'; await p.recompute(false);
      assert.equal(p.data.attributes.brand, '图片品牌'); assert.equal(p.data.imageDescription, '黑色杯身白色文字');
      await p.recompute(true); assert.equal(calls, 1);
      await p.recompute(true, true); assert.equal(p.data.aiModel, 'vision-model'); assert(p.data.notes.some((x) => x.includes('上次成功')));
      p.data.images = ['/tmp/new']; await p.recompute(true); assert.equal(p.data.imageDescription, ''); assert(!p.data.attributes.brand);
    } finally { vision.recognize = saved; }
  });
  await test('自动类别随文字更新，人工类别及属性不被新识别覆盖', async () => {
    const p = page('../pages/publish/publish'); p.data.categories = require('../core/categories').list();
    p.data.description = '黑色保温杯'; await p.recompute(false);
    assert.equal(p.data.categories[p.data.categoryIndex].key, 'cup');
    p.data.description = '蓝色雨伞'; await p.recompute(false);
    assert.equal(p.data.categories[p.data.categoryIndex].key, 'umbrella');
    p.onPickCategory({ detail: { value: p.data.categories.findIndex((x) => x.key === 'cup') } });
    p.data.description = '黑色背包'; await p.recompute(false);
    assert.equal(p.data.attributes.category, 'cup'); assert.equal(p.data.categories[p.data.categoryIndex].key, 'cup'); assert.equal(p.data.confidence.category, 1);
  });
  await test('发布页可确认眼镜类别与镜框特征，确认后仍保留人工值', async () => {
    const vision = require('../utils/vision'); const saved = vision.recognize;
    vision.recognize = async () => Object.assign(vlm.mergeAiResult(vlm.extractAttributes({}), {
      attributes: { category: 'glasses', features: ['半框', '双鼻托'] }, confidence: {}, description: '黑色半框眼镜' }), { model: 'vision-model' });
    try {
      const p = page('../pages/publish/publish'); p.data.categories = require('../core/categories').list(); p.data.images = ['/tmp/glasses'];
      await p.recompute(true); assert.equal(p.data.aiSuggestions.length, 2); assert.equal(p.data.imageDescription, '黑色半框眼镜');
      p.onConfirmAiSuggestion({ currentTarget: { dataset: { key: 'category' } } });
      p.onConfirmAiSuggestion({ currentTarget: { dataset: { key: 'features' } } });
      assert.equal(p.data.categoryName, '眼镜'); assert.equal(p.data.sources.category, 'user'); assert.equal(p.data.confidence.features, 1);
      await p.recompute(false); assert.deepEqual(p.data.attributes.features, ['半框', '双鼻托']); assert.deepEqual(p.data.aiSuggestions, []);
    } finally { vision.recognize = saved; }
  });
  await test('发布页空分析不显示成功，确认的显著特征可编辑且保存为数组', async () => {
    const vision = require('../utils/vision'); const saved = vision.recognize;
    vision.recognize = async () => ({ attributes: { category: 'other' }, model: 'vision-model', status: 'empty', warning: '未提取到可用的物体线索' });
    try {
      const p = page('../pages/publish/publish'); p.data.categories = require('../core/categories').list(); p.data.images = ['/tmp/empty'];
      await p.recompute(true); assert(p.data.resultTip.includes('未完成')); assert(!p._visual);
      p.data.aiSuggestions = [{ key: 'features', value: ['半框'], displayValue: '半框' }];
      p.onConfirmAiSuggestion({ currentTarget: { dataset: { key: 'features' } } });
      p.onEditAttr({ currentTarget: { dataset: { key: 'features' } } });
      assert(p.data.attrFields.find((f) => f.key === 'features').editing);
      p.onAttrInput({ detail: { value: '半框、双鼻托' } }); p.onAttrSave();
      assert.deepEqual(p.data.attributes.features, ['半框', '双鼻托']); assert.equal(p.data.confidence.features, 1);
    } finally { vision.recognize = saved; }
  });
  await test('本地发布完整保留视觉描述、模型、来源及置信度，并参与后续检索', () => {
    const service = require('../utils/service');
    const item = service.publish({ kind: 'found', image: '/tmp/real', description: '捡到杯子',
      imageDescription: '杯身白色纵向文字红色猫咪贴纸', attributesModel: 'vision-model',
      attributes: { category: 'cup', main_color: '黑色' }, attributeSources: { main_color: 'ai' }, attributeConfidence: { main_color: 0.91 } }, { localOnly: true }).item;
    assert.equal(item.attributesModel, 'vision-model'); assert.equal(item.attributeConfidence.main_color, 0.91); assert.equal(item.attributeSources.main_color, 'ai');
    assert(item.imageDescription.includes('猫咪')); assert(item.embeddings.image);
    assert.equal(engine.search({ description: '红色猫咪贴纸' }, [item]).results[0].id, item.id);
  });
  await test('发布页等待分析完成，提交时调用异步发布并携带视觉信息', async () => {
    const service = require('../utils/service'); const saved = service.publishAsync; let calls = 0;
    wx.showToast = () => {}; wx.showModal = () => {};
    service.publishAsync = async (payload) => { calls += 1; assert.equal(payload.imageDescription, '黑色杯子'); assert.equal(payload.aiResult.confidence.brand, 0.9); return { item: { id: 'published' }, mode: 'local', matchCount: 0, locationMatched: true }; };
    try {
      const p = page('../pages/publish/publish'); p.data.extracting = true; await p.onSubmit(); assert.equal(calls, 0);
      p.data.extracting = false; p.validate = () => ''; p.data.images = ['/tmp/photo'];
      p._visual = { image: '/tmp/photo', result: { attributes: { category: 'cup', brand: '品牌' }, confidence: { category: 0.95, brand: 0.9 }, sources: { brand: 'ai' }, description: '黑色杯子', model: 'vision-model', notes: [] } };
      await p.onSubmit(); assert.equal(calls, 1); assert.equal(p.data.submitting, false);
    } finally { service.publishAsync = saved; }
  });
  await test('云端发布上传真实照片，镜像失败不重复创建本地记录；发布失败可回退', async () => {
    const service = require('../utils/service'); const publishApi = require('../utils/api'); const savedCloud = publishApi.isCloud; const savedCall = publishApi.callApi;
    const savedRefresh = store.refreshFromCloud; const savedWxCloud = wx.cloud; let calls = 0;
    publishApi.isCloud = () => true; store.refreshFromCloud = async () => { throw new Error('同步失败'); };
    wx.cloud = { uploadFile: async (p) => { assert.equal(p.filePath, '/tmp/photo.png'); return { fileID: 'cloud://env/photo' }; } };
    const item = { id: 'uploaded-audit', kind: 'found', image: 'cloud://env/photo', description: '黑色杯子', attributes: { category: 'cup' } };
    publishApi.callApi = async (action, p) => { calls += 1; assert.equal(action, 'item.publish'); assert.deepEqual(p.images, ['cloud://env/photo']); return { item, matchCount: 0 }; };
    try {
      const before = store.itemsOf().length;
      const r = await service.publishAsync({ kind: 'found', image: '/tmp/photo.png', images: ['/tmp/photo.png'] });
      assert.equal(r.mode, 'cloud'); assert.equal(calls, 1); assert.equal(store.itemsOf().length, before + 1); assert(store.getItem(item.id));
      let failures = 0; publishApi.callApi = async () => { failures += 1; throw new Error('发布失败'); };
      const fallback = await service.publishAsync({ kind: 'found', description: '杯子', image: '/tmp/photo.png', images: ['/tmp/photo.png'], imageDescription: '黑色杯子' });
      assert.equal(fallback.mode, 'local'); assert.equal(fallback.item.image, 'cloud://env/photo'); assert.equal(fallback.item.imageDescription, '黑色杯子');
      assert.equal(failures, 1);
    } finally { publishApi.isCloud = savedCloud; publishApi.callApi = savedCall; store.refreshFromCloud = savedRefresh; wx.cloud = savedWxCloud; }
  });
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function(request, parent, ...rest) {
    return request === 'wx-server-sdk' ? path.join(__dirname, '_stubs/wx-server-sdk/index.js') : resolveFilename.call(this, request, parent, ...rest);
  };
  await test('新增云端查询接口可用且不持久化临时查询', async () => {
    const serverStore = require('../cloudfunctions/xj-api/store');
    const old = serverStore.itemsOf; serverStore.itemsOf = async () => items;
    const server = require('../cloudfunctions/xj-api/index');
    const r = await server.main({ action: 'item.search', payload: { description: '黑色保温杯' } });
    assert(r.ok); assert.equal(r.data.results[0].id, 'cup-black');
    const empty = await server.main({ action: 'item.search', payload: {} }); assert(!empty.ok);
    serverStore.itemsOf = old;
  });
  Module._resolveFilename = resolveFilename;
  console.log('\n✓ 核心检索回归通过 ' + passed + ' 项');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
