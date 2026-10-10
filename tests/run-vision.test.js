const assert = require('assert');
const path = require('path');
const Module = require('module');
const api = require('../utils/api');
const vision = require('../utils/vision');
const vlm = require('../core/vlm');
const deepseek = require('../core/ai/deepseek');
let count = 0;
async function test(name, fn) { vision.clearCache(); await fn(); count += 1; console.log('  ✓ ' + name); }
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
global.wx = {};
async function main() {
  await test('PNG/JPEG/GIF/WebP 从真实内容判断 MIME，不依赖临时路径扩展名', () => {
    assert.equal(vision.mimeOf(png, null, '/tmp/a.jpg'), 'image/png');
    assert.equal(vision.mimeOf('/9j/abc'), 'image/jpeg');
    assert.equal(vision.mimeOf('R0lGODabc'), 'image/gif');
    assert.equal(vision.mimeOf('UklGRabc'), 'image/webp');
  });
  await test('CloudBase 与外部 URL 使用各自的图片输入，不读取本地文件', async () => {
    assert.equal((await vision.prepareImage('cloud://env/photo')).imageFileId, 'cloud://env/photo');
    assert.equal((await vision.prepareImage('https://test/photo')).imageUrl, 'https://test/photo');
  });
  await test('大图按原比例缩小，识别副本不覆盖原图', async () => {
    wx.getImageInfo = (p) => p.success({ width: 4000, height: 3000, type: 'jpeg' });
    wx.compressImage = (p) => { assert.equal(p.compressedWidth, 1600); assert.equal(p.compressedHeight, 1200); p.success({ tempFilePath: '/tmp/compressed' }); };
    api.readFileBase64 = async (file) => { assert.equal(file, '/tmp/compressed'); return '/9j/abc'; };
    assert.equal((await vision.prepareImage('/tmp/original')).mimeType, 'image/jpeg');
  });
  await test('小图提示清晰度，无法读取及不支持格式明确报错', async () => {
    wx.getImageInfo = (p) => p.success({ width: 100, height: 100, type: 'png' });
    api.readFileBase64 = async () => png;
    assert((await vision.prepareImage('/tmp/small')).notes[0].includes('分辨率'));
    wx.getImageInfo = (p) => p.fail({ errMsg: 'bad image' });
    await assert.rejects(vision.prepareImage('/tmp/bad'), /无法读取/);
    wx.getImageInfo = (p) => p.success({ width: 500, height: 500, type: 'heic' });
    await assert.rejects(vision.prepareImage('/tmp/heic'), /格式暂不支持/);
  });
  await test('过大的 Base64 在调用云函数前拦截', async () => {
    delete wx.getImageInfo; delete wx.compressImage;
    api.readFileBase64 = async () => 'A'.repeat(1900 * 1024);
    await assert.rejects(vision.prepareImage('/tmp/huge'), /照片过大/);
  });
  await test('像素不大但体积超限的照片尝试压缩，失败最多重试两次', async () => {
    let attempts = 0;
    wx.getImageInfo = (p) => p.success({ width: 1000, height: 800, type: 'png' });
    wx.compressImage = (p) => { attempts += 1; p.success({ tempFilePath: '/tmp/small-copy' }); };
    api.readFileBase64 = async (file) => file === '/tmp/small-copy' ? '/9j/abc' : 'A'.repeat(1900 * 1024);
    const r = await vision.prepareImage('/tmp/large-bytes');
    assert.equal(attempts, 1); assert.equal(r.mimeType, 'image/jpeg');
    attempts = 0; api.readFileBase64 = async () => 'A'.repeat(1900 * 1024);
    await assert.rejects(vision.prepareImage('/tmp/large-bytes'), /照片过大/); assert.equal(attempts, 2);
    delete wx.getImageInfo; delete wx.compressImage;
  });
  api.isCloud = () => true;
  api.readFileBase64 = async () => png;
  let calls = 0;
  const result = () => ({ attributes: { category: 'cup', main_color: '黑色' }, description: '黑色保温杯', confidence: { category: 0.95, main_color: 0.9 }, model: 'vision-model' });
  await test('相同照片和描述复用识别结果，筛选不重复消耗模型', async () => {
    calls = 0; api.extractAttributes = async (p) => { calls += 1; assert.equal(p.detail, 'high'); return result(); };
    const r = await vision.recognize({ image: '/tmp/a' }); assert.equal(r.attributes.category, 'cup');
    assert((await vision.recognize({ image: '/tmp/a' })).cached); assert.equal(calls, 1);
    await vision.recognize({ image: '/tmp/a', force: true }); assert.equal(calls, 2);
    await vision.recognize({ image: '/tmp/a', description: '蓝色' }); assert.equal(calls, 3);
  });
  await test('并发的相同识别请求合并为一次模型调用', async () => {
    let resolve; calls = 0;
    api.extractAttributes = () => { calls += 1; return new Promise((r) => { resolve = r; }); };
    const a = vision.recognize({ image: '/tmp/same' }); const b = vision.recognize({ image: '/tmp/same' });
    await new Promise((r) => setTimeout(r, 0)); resolve(result()); await Promise.all([a, b]); assert.equal(calls, 1);
  });
  await test('调用方修改属性与提示不会污染识别缓存', async () => {
    api.extractAttributes = async () => result();
    const a = await vision.recognize({ image: '/tmp/immutable' });
    a.attributes.main_color = '篡改'; a.notes.push('篡改提示');
    const b = await vision.recognize({ image: '/tmp/immutable' });
    assert.equal(b.attributes.main_color, '黑色'); assert(!b.notes.includes('篡改提示'));
    b.attributes.main_color = '再次篡改';
    assert.equal((await vision.recognize({ image: '/tmp/immutable' })).attributes.main_color, '黑色');
  });
  await test('识别失败不缓存；读图失败保留文字检索能力', async () => {
    calls = 0; api.extractAttributes = async () => { calls += 1; return { model: 'local-text-rules', fallback: true, attributes: { category: 'other' } }; };
    assert((await vision.recognize({ image: '/tmp/fail' })).warning);
    await vision.recognize({ image: '/tmp/fail' }); assert.equal(calls, 2);
    api.readFileBase64 = async () => { throw new Error('missing file'); };
    const r = await vision.recognize({ image: '/tmp/lost', description: '蓝色雨伞' });
    assert.equal(r.attributes.category, 'umbrella'); assert(r.warning.includes('读取失败'));
    api.readFileBase64 = async () => png;
  });
  await test('低置信度与零置信度不覆盖已知文字属性', () => {
    const local = vlm.extractAttributes({ description: '黑色保温杯' });
    const r = vlm.mergeAiResult(local, { attributes: { main_color: '蓝色', brand: '猜测品牌' }, confidence: { main_color: 0, brand: 0.2 } });
    assert.equal(r.attributes.main_color, local.attributes.main_color); assert(!r.attributes.brand); assert(r.notes.some((s) => s.includes('把握较低')));
  });
  await test('缺失置信度标为不确定，高置信度冲突仍保留用户文字', () => {
    const local = vlm.extractAttributes({ description: '黑色保温杯' });
    const unknown = vlm.mergeAiResult(local, { attributes: { main_color: '蓝色', brand: '猜测品牌' } });
    assert.equal(unknown.attributes.main_color, local.attributes.main_color); assert(!unknown.attributes.brand); assert(!unknown.confidence.brand);
    const conflict = vlm.mergeAiResult(local, { attributes: { main_color: '蓝色' }, confidence: { main_color: 0.99 } });
    assert.equal(conflict.attributes.main_color, local.attributes.main_color); assert(conflict.notes.some((s) => s.includes('不同')));
  });
  await test('真实路径与历史路径向量不产生视觉证据；权重重新分配', () => {
    const matcher = require('../core/matcher');
    const a = { image: 'wxfile://folder/photo1.jpg', description: '黑色杯子', embeddings: { image: [1, 0] } };
    const b = { image: 'wxfile://folder/photo2.jpg', description: '黑色杯子', embeddings: { image: [1, 0] } };
    assert.equal(vlm.embed('image', a.image), null); assert.equal(vlm.imageSimilarity(a, b).available, false);
    const w = matcher.computeWeights(a, b); assert.equal(w.weights.image, 0);
    assert.equal(Object.values(w.weights).reduce((sum, x) => sum + x, 0), 1);
    a.imageDescription = b.imageDescription = '黑色杯身白色纵向文字';
    assert(vlm.imageSimilarity(a, b).available); assert(vlm.imageSimilarity(a, b).score > 0.9);
  });
  await test('模型字段白名单与类型检查拦截无关数据及非有限置信度', () => {
    const r = deepseek.normalizeResult({ category: 'cup', privateFeatures: ['secret'], brand: { bad: true }, main_color: ['蓝'], features: ['贴纸', { bad: true }], confidence: { category: Infinity, features: 0, privateFeatures: 1 } });
    assert.deepEqual(r.attributes, { category: 'cup', features: ['贴纸'] });
    assert.equal(r.confidence.features, 0); assert(!r.confidence.category); assert(!r.confidence.privateFeatures);
  });
  await test('各类别标签归一化保留眼镜、饭卡及其他常见物体，不误匹配英文子串', () => {
    const labels = { eyeglasses: 'glasses', sunglasses: 'glasses', spectacles: 'glasses', student_card: 'card', '饭卡': 'card',
      mug: 'cup', backpack: 'bag', earphones: 'earphone', keys: 'key', smartphone: 'device', 'USB cable': 'charger',
      smartwatch: 'watch', notebook: 'book', pencil: 'stationery', scarf: 'cloth', racket: 'sport', parasol: 'umbrella' };
    Object.keys(labels).forEach((label) => assert.equal(deepseek.normalizeResult({ category: label }).attributes.category, labels[label]));
    assert.equal(deepseek.normalizeResult({ category: 'glass sculpture' }).attributes.category, 'other');
  });
  await test('多类别完整示例都满足字段置信度契约，不靠猜测补齐置信度', () => {
    const prompt = deepseek.buildExtractPrompt('', 'lost');
    const examples = prompt.split('\n').filter((line) => line.startsWith('{')).map(JSON.parse);
    assert.deepEqual(examples.map((x) => x.category), ['glasses', 'card', 'cup']);
    examples.forEach((x) => Object.keys(deepseek.normalizeResult(x).attributes).forEach((k) => assert.equal(typeof x.confidence[k], 'number')));
    require('../core/categories').list().forEach((c) => assert(prompt.includes(c.key + '：')));
    assert.equal(deepseek.normalizeResult({ category: 'glasses', confidence: { category: true } }).confidence.category, undefined);
  });
  await test('缺少置信度的类别与细节保留为待确认值，再次合并也不消失', () => {
    const local = vlm.extractAttributes({});
    const ai = deepseek.normalizeResult({ category: 'eyeglasses', features: ['半框', '双鼻托'] });
    const first = vlm.mergeAiResult(local, ai);
    assert.equal(first.attributes.category, 'other'); assert(!first.confidence.features);
    assert.deepEqual(first.suggestions.map((s) => s.key), ['category', 'features']);
    assert.equal(first.suggestions[0].displayValue, '眼镜'); assert.equal(first.suggestions[0].confidence, null);
    assert.deepEqual(vlm.mergeAiResult(local, first).suggestions, first.suggestions);
  });
  await test('零置信度建议保持零分，other 不覆盖已有类别，无效字段不进入建议', () => {
    const r = vlm.mergeAiResult(vlm.extractAttributes({ description: '黑色眼镜' }), {
      attributes: { category: 'other', features: ['双鼻托'], privateFeatures: ['secret'], shape: { invalid: true } }, confidence: { features: 0 } });
    assert.equal(r.attributes.category, 'glasses'); assert.equal(r.suggestions[0].confidence, 0);
    assert.deepEqual(r.suggestions.map((s) => s.key), ['features']);
  });
  await test('15 类可靠类别与可见特征均被保留，不依赖杯子示例', () => {
    require('../core/categories').list().forEach((c) => {
      const ai = deepseek.normalizeResult({ category: c.key, features: ['可见特征'], confidence: { category: 0.9, features: 0.8 } });
      const r = vlm.mergeAiResult(vlm.extractAttributes({}), ai);
      assert.equal(r.attributes.category, c.key); assert.deepEqual(r.attributes.features, ['可见特征']);
    });
  });
  await test('空视觉返回明确提示并允许重试，纯描述结果仍被保留', async () => {
    let attempts = 0;
    api.extractAttributes = async () => { attempts += 1; return { attributes: { category: 'other' }, confidence: { category: 0.9 }, model: 'vision-model' }; };
    assert.equal((await vision.recognize({ image: '/tmp/empty-result' })).status, 'empty');
    assert((await vision.recognize({ image: '/tmp/empty-result' })).warning.includes('近照')); assert.equal(attempts, 2);
    const withText = await vision.recognize({ image: '/tmp/empty-with-text', description: '黑色眼镜' });
    assert.equal(withText.attributes.category, 'glasses'); assert.equal(withText.status, 'empty'); assert(withText.warning);
    assert(!withText.notes.some((s) => s.includes('未上传图片')));
    api.extractAttributes = async () => ({ attributes: {}, description: '一副黑色细框眼镜', model: 'vision-model' });
    const r = await vision.recognize({ image: '/tmp/description-only' });
    assert.equal(r.status, 'recognized'); assert.equal(r.description, '一副黑色细框眼镜');
  });
  await test('实际模型请求保留 high 细节并关闭思考，截断响应不会重复请求', async () => {
    const fs = require('fs'); const vm = require('vm'); const requests = [];
    let finishReason = 'stop';
    const http = { request(options, callback) { return {
      setTimeout() {}, on() {}, destroy() {}, write(body) { requests.push(JSON.parse(body)); },
      end() {
        const listeners = {};
        callback({ statusCode: 200, on(name, fn) { listeners[name] = fn; } });
        listeners.data(Buffer.from(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: JSON.stringify({ category: 'glasses', confidence: { category: 0.9 } }) } }] })));
        listeners.end();
      }
    }; } };
    const stub = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../core/ai/deepseek'), 'utf8'), {
      module: stub, Buffer, process: { env: {} }, setTimeout,
      require(name) { return name === 'https' || name === 'http' ? http : name === '../categories' ? require('../core/categories') : require(name); }
    });
    await stub.exports.extractAttributes({ image: { base64: png } }, { apiKey: 'test-key-not-real' });
    assert.equal(requests[0].thinking.type, 'disabled');
    assert.equal(requests[0].messages[0].content[0].image_url.detail, 'high');
    finishReason = 'length';
    await assert.rejects(stub.exports.extractAttributes({ image: { base64: png } }, { apiKey: 'test-key-not-real' }), /截断/);
    assert.equal(requests.length, 2);
  });
  const original = Module._resolveFilename;
  Module._resolveFilename = function(request, parent, ...args) {
    return request === 'wx-server-sdk' ? path.join(__dirname, '_stubs/wx-server-sdk/index.js') : original.call(this, request, parent, ...args);
  };
  const sdk = require('wx-server-sdk');
  const serverDeepseek = require('../cloudfunctions/xj-ai/core/ai/deepseek');
  const server = require('../cloudfunctions/xj-ai/index');
  await test('云存储图片先下载，再转 Base64；不冒充模型 file_id', async () => {
    sdk.downloadFile = async (p) => { assert.equal(p.fileID, 'cloud://env/photo'); return { fileContent: Buffer.from(png, 'base64') }; };
    serverDeepseek.extractAttributes = async (p) => { assert.equal(p.image.base64, png); assert(!p.image.fileId); assert.equal(p.image.mimeType, 'image/png'); assert.equal(p.detail, 'high'); return result(); };
    const r = await server.main({ action: 'ai.extract', payload: { imageFileId: 'cloud://env/photo' } });
    assert(r.ok); assert.equal(r.data.model, 'vision-model');
  });
  await test('云图片下载失败返回明确降级，不留下随机视觉属性', async () => {
    sdk.downloadFile = async () => { throw new Error('没有读取权限'); };
    const r = await server.main({ action: 'ai.extract', payload: { imageFileId: 'cloud://env/photo', description: '黑色保温杯' } });
    assert(r.ok && r.data.fallback); assert.equal(r.data.attributes.category, 'cup'); assert(r.data.error.includes('权限'));
  });
  Module._resolveFilename = original;
  console.log('\n✓ 图像识别回归通过 ' + count + ' 项');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
