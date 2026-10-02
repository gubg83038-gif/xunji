/**
 * AI 调用路由测试
 * ---------------------------------------------------------------
 *   node tests/run-ai-routing.test.js
 *
 * 背景（真实现象）：
 *   发布页 onLoad 会调一次 recompute()，那时用户还没选图也没填描述，
 *   于是发出去一个空 payload。云函数按设计拒绝（「需要提供图片或文字描述」），
 *   控制台刷出红色 error 再降级——功能没坏，但噪音很大且浪费一次云函数调用。
 *
 * 这个套件锁定「什么情况下该发云函数、什么情况下不该发」的路由规则。
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let cloudCalls = 0;
const storage = {};

global.wx = {
  setStorageSync: (k, v) => { storage[k] = v; },
  getStorageSync: (k) => storage[k],
  removeStorageSync: (k) => { delete storage[k]; },
  showToast: () => {},
  showModal: () => {},
  cloud: {
    init: () => {},
    callFunction: () => {
      cloudCalls += 1;
      // 模拟云函数的真实拒绝行为
      return Promise.resolve({
        result: { ok: false, error: { message: '需要提供图片或文字描述', code: 'NO_INPUT' } }
      });
    }
  }
};

const api = require(path.join(ROOT, 'utils', 'api.js'));
const config = require(path.join(ROOT, 'core', 'config.js'));

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed += 1;
    failures.push({ name, error: e });
    console.log('  ✗ ' + name);
    console.log('    → ' + String(e && e.message).split('\n')[0]);
  }
}

function group(t) { console.log('\n' + t); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** 跑一次 extractAttributes，返回 { result, cloudDelta } */
async function run(input) {
  let localCalled = 0;
  const before = cloudCalls;
  const result = await api.extractAttributes(input, () => {
    localCalled += 1;
    return { attributes: { category: 'other' }, model: 'local' };
  });
  return { result, cloud: cloudCalls - before, local: localCalled };
}

async function main() {
  group('0. 前置条件');

  await test('云端已启用且 AI 开关为 deepseek（否则路由测试无意义）', async () => {
    assert(config.cloudReady(), 'cloudReady 应为 true');
    assert(config.aiReady(), 'aiReady 应为 true（provider 应为 deepseek）');
  });

  group('1. 空输入不得调用云函数（发布页 onLoad 的真实场景）');

  await test('完全空输入：不发云函数，走本地兜底', async () => {
    const r = await run({ image: '', description: '', type: 'lost' });
    assert(r.cloud === 0, '不该调用云函数，实际调用 ' + r.cloud + ' 次');
    assert(r.local === 1, '应走本地兜底');
    assert(r.result.model === 'local', '模型标识应为 local');
  });

  await test('只有空白字符的描述：同样不发云函数', async () => {
    const r = await run({ image: '', description: '   \n  ', type: 'lost' });
    assert(r.cloud === 0, '空白描述不该触发云函数，实际 ' + r.cloud + ' 次');
  });

  await test('image 为 undefined / null 时不报错', async () => {
    const r1 = await run({ description: '', type: 'lost' });
    assert(r1.cloud === 0, 'undefined image 不该调云函数');
    const r2 = await run({ image: null, description: null, type: 'lost' });
    assert(r2.cloud === 0, 'null 字段不该调云函数');
  });

  group('2. 演示图库必须短路（不消耗模型额度）');

  await test('带 demo:// 前缀的演示图：不发云函数，返回内置线索', async () => {
    const r = await run({ image: 'demo://cup_metal_gray', description: '', type: 'lost' });
    assert(r.cloud === 0, '演示图不该调模型，实际 ' + r.cloud + ' 次');
    assert(r.result.model === 'demo-hints', '应返回 demo-hints，实际 ' + r.result.model);
    assert(r.result.attributes && r.result.attributes.category === 'cup',
      '应带内置类别线索，实际 ' + JSON.stringify(r.result.attributes));
  });

  await test('不带前缀的演示图 key 也能识别', async () => {
    const r = await run({ image: 'cup_metal_gray', description: '', type: 'lost' });
    assert(r.cloud === 0, '演示图 key 不该调模型');
    assert(r.result.model === 'demo-hints', '应返回 demo-hints');
  });

  await test('演示图 + 文字描述：仍走短路（优先级更高）', async () => {
    const r = await run({ image: 'demo://cup_metal_gray', description: '深灰色保温杯', type: 'lost' });
    assert(r.cloud === 0, '演示图应优先短路，实际调用 ' + r.cloud + ' 次');
    assert(r.result.model === 'demo-hints', '应返回 demo-hints');
  });

  await test('演示图短路在空输入门禁之前（顺序错误会丢失内置线索）', async () => {
    // 演示图不是可上传的图片资源，如果先跑「是否有图片」的门禁，
    // 它会被判成空输入而错误地走本地兜底，拿不到内置线索。
    const r = await run({ image: 'demo://cup_metal_gray', description: '', type: 'lost' });
    assert(r.local === 0, '演示图不该走本地兜底');
    // 内置线索的每个属性来源都应标记为 demo
    const srcValues = Object.keys(r.result.sources || {}).map((k) => r.result.sources[k]);
    assert(srcValues.length > 0, '应有内置线索（sources 不能为空）');
    assert(srcValues.every((v) => v === 'demo'),
      '属性来源应全部标记为 demo，实际 ' + JSON.stringify(r.result.sources));
    assert(r.result.attributes && r.result.attributes.main_color,
      '应带上内置颜色线索，实际 ' + JSON.stringify(r.result.attributes));
  });

  group('3. 有真实输入时必须调用云函数');

  await test('只有文字描述：调用云函数', async () => {
    const r = await run({ image: '', description: '深灰色金属保温杯，杯底有一道划痕', type: 'lost' });
    assert(r.cloud === 1, '有描述应调用云函数，实际 ' + r.cloud + ' 次');
  });

  await test('只有图片 base64：调用云函数', async () => {
    const r = await run({ image: '', imageBase64: 'iVBORw0KGgo=', description: '', type: 'found' });
    assert(r.cloud === 1, '有图片应调用云函数，实际 ' + r.cloud + ' 次');
  });

  await test('图片 fileId / url 也视为有效输入', async () => {
    const r1 = await run({ imageFileId: 'cloud://x/y.jpg', description: '', type: 'lost' });
    assert(r1.cloud === 1, 'imageFileId 应触发云函数，实际 ' + r1.cloud + ' 次');
    const r2 = await run({ imageUrl: 'https://example.com/a.jpg', description: '', type: 'lost' });
    assert(r2.cloud === 1, 'imageUrl 应触发云函数，实际 ' + r2.cloud + ' 次');
  });

  group('4. 云函数失败时降级不抛错');

  await test('云函数返回失败：降级本地规则，不向页面抛异常', async () => {
    // 上面的 stub 固定返回 ok:false，正好验证降级路径
    const r = await run({ image: '', description: '一个有描述但云端会拒绝的场景', type: 'lost' });
    assert(r.result, '应仍然返回结果（降级），而不是抛异常');
    assert(r.result.model === 'local', '降级后模型标识应为 local');
  });

  /* ===================== 输出 ===================== */

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  console.log('========================================');

  if (failed > 0) {
    console.log('\n失败详情：');
    failures.forEach((f) => {
      console.log('\n· ' + f.name);
      console.log(String((f.error && f.error.stack) || f.error).split('\n').slice(0, 6).join('\n'));
    });
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n测试运行异常：', e);
  process.exit(1);
});
