const assert = require('assert');
const TopK = require('../core/topk');
const engine = require('../core/search');
const domain = require('../core/domain');
const vlm = require('../core/vlm');
const matcher = require('../core/matcher');
const color = require('../core/color');
const api = require('../utils/api');
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log('  ✓ ' + name); }
const turn = () => new Promise((resolve) => setImmediate(resolve));
const snapshot = (id) => ({ items: id ? [{ id, kind: 'found', attributes: {} }] : [], matches: [], claims: [], notifications: [], users: [] });
function freshStore() {
  delete require.cache[require.resolve('../utils/store')];
  return require('../utils/store');
}
async function main() {
  await test('有界候选选择与稳定全量排序一致，同分保持输入顺序', () => {
    const values = Array.from({ length: 1500 }, (_, i) => ({ id: i, score: (i * 7919) % 23 }));
    for (const count of [0, 1, 20, 30, 1600]) {
      const top = new TopK(count, (a, b) => b.score - a.score);
      values.forEach((value) => { top.push(value); assert(top.heap.length <= count); });
      assert.deepEqual(top.values(), values.slice().sort((a, b) => b.score - a.score).slice(0, count));
    }
  });
  await test('1000 条命中只生成 20 条展示数据，统计与同分排序保持正确', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: 'id-' + String(i).padStart(4, '0'),
      kind: 'found', status: 'available', title: '黑色保温杯', description: '黑色保温杯',
      attributes: { category: 'cup', main_color: '黑' }, createdAt: i % 7 }));
    const saved = domain.itemView; let views = 0;
    domain.itemView = (item) => { views += 1; return saved(item); };
    try {
      const r = engine.search({ description: '黑色保温杯', topK: 20 }, items);
      assert.equal(views, 20); assert.equal(r.total, 1000); assert.equal(r.scanned, 1000);
      const expected = items.slice().sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).slice(0, 20);
      assert.deepEqual(r.results.map((x) => x.id), expected.map((x) => x.id));
      assert(!JSON.stringify(r).includes('embeddings'));
    } finally { domain.itemView = saved; }
  });
  await test('缓存超过容量时保留最近使用的文本和向量', () => {
    const tokens = color.tokenize('缓存热点黑色保温杯'); const vector = vlm.embed('text', '缓存热点黑色保温杯');
    for (let i = 0; i < 2200; i += 1) {
      color.tokenize('不同描述' + i); vlm.embed('text', '不同向量' + i);
      assert.strictEqual(color.tokenize('缓存热点黑色保温杯'), tokens);
      assert.strictEqual(vlm.embed('text', '缓存热点黑色保温杯'), vector);
    }
  });
  await test('每次完整匹配只计算一次视觉相似度', () => {
    const saved = vlm.imageSimilarity; let calls = 0;
    vlm.imageSimilarity = (...args) => { calls += 1; return saved(...args); };
    try {
      matcher.scorePair({ image: 'demo://cup_metal_gray', description: '杯子', attributes: {} },
        { image: 'demo://cup_metal_gray', description: '杯子', attributes: {} });
      assert.equal(calls, 1);
    } finally { vlm.imageSimilarity = saved; }
  });
  const savedCloud = api.isCloud; const savedFetch = api.fetchSnapshot; const savedCall = api.callApi;
  const savedWx = global.wx; const memory = {};
  global.wx = { setStorageSync: (k, v) => { memory[k] = v; }, getStorageSync: (k) => memory[k], showToast: () => {} };
  api.isCloud = () => true;
  try {
    await test('并发同步共享一个请求，30 秒内重复进入不拉取，强制及过期刷新生效', async () => {
      const store = freshStore(); let calls = 0; let resolve;
      api.fetchSnapshot = () => { calls += 1; return new Promise((r) => { resolve = r; }); };
      const a = store.refreshFromCloud(); const b = store.refreshFromCloud(); const c = store.refreshFromCloud();
      assert.strictEqual(a, b); assert.strictEqual(a, c); assert.equal(calls, 1);
      resolve(snapshot()); assert(await a); assert(await b);
      assert.equal(await store.refreshFromCloud(), false); assert.equal(calls, 1);
      api.fetchSnapshot = async () => { calls += 1; return snapshot(); };
      assert(await store.refreshFromCloud({ force: true })); assert.equal(calls, 2);
      const originalNow = Date.now;
      try { const later = originalNow() + 31000; Date.now = () => later; assert(await store.refreshFromCloud()); assert.equal(calls, 3); }
      finally { Date.now = originalNow; }
    });
    await test('同步途中发生写入，会补拉写入后的快照，所有等待者拿到新结果', async () => {
      const store = freshStore(); const resolves = [];
      api.fetchSnapshot = () => new Promise((r) => resolves.push(r));
      const initial = store.refreshFromCloud(); const afterWrite = store.refreshFromCloud({ force: true });
      assert.strictEqual(initial, afterWrite);
      resolves[0](snapshot('old')); await turn(); assert.equal(resolves.length, 2);
      resolves[1](snapshot('new')); assert(await afterWrite); assert(store.getItem('new')); assert(!store.getItem('old'));
    });
    await test('同步失败不缓存成功状态，下一次可重试', async () => {
      const store = freshStore(); let calls = 0;
      api.fetchSnapshot = async () => { calls += 1; if (calls === 1) throw new Error('测试网络失败'); return snapshot(); };
      assert.equal(await store.refreshFromCloud(), false); assert(await store.refreshFromCloud()); assert.equal(calls, 2);
    });
    await test('后台提交计数与 flush 等待有效，不会出现负数', async () => {
      const store = freshStore(); let resolve;
      api.callApi = () => new Promise((r) => { resolve = r; });
      store.dispatchToCloud('test.write', {}); assert.equal(store.cloudStatus().pending, 1);
      let done = false; const flushing = store.flushCloud().then((ok) => { done = true; return ok; });
      await turn(); assert.equal(done, false); resolve({}); assert(await flushing); assert.equal(store.cloudStatus().pending, 0);
      api.callApi = () => { throw new Error('测试同步抛错'); };
      store.dispatchToCloud('test.write', {}); assert.equal(store.cloudStatus().pending, 0);
    });
  } finally { api.isCloud = savedCloud; api.fetchSnapshot = savedFetch; api.callApi = savedCall; global.wx = savedWx; }
  await test('缓存未变化不重复渲染，隐藏页面忽略同步回调，手动刷新等待完成', async () => {
    let config; let resolve; let stopped = 0; let refreshes = 0;
    const app = { globalData: { mode: 'cloud' }, refresh: () => new Promise((r) => { resolve = r; }) };
    global.getApp = () => app; global.Page = (p) => { config = p; };
    global.wx = { stopPullDownRefresh: () => { stopped += 1; } };
    require('../pages/home/home');
    const page = Object.assign({}, config, { refresh: () => { refreshes += 1; } });
    page.onShow(); resolve(false); await turn(); assert.equal(refreshes, 1);
    page.onShow(); page.onHide(); resolve(true); await turn(); assert.equal(refreshes, 2);
    app.refresh = (p) => { assert(p.force); return new Promise((r) => { resolve = r; }); };
    const pulling = page.onPullDownRefresh(); assert.equal(stopped, 0); resolve(true); await pulling;
    assert.equal(stopped, 1); assert.equal(refreshes, 3);
  });
  console.log('\n✓ 性能与同步回归通过 ' + passed + ' 项');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
