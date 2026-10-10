/**
 * 端到端：云端数据 → 客户端镜像 → 详细对比页
 * ---------------------------------------------------------------
 * 复现真实事故：详细对比页显示 48% 而不是 82%。
 * 根因是客户端镜像由「展示视图」重建，丢了 embeddings / timeRange。
 *
 * 这个测试用真实的同步链路（wx.cloud → fetchSnapshot → applySnapshot），
 * 而不是直接调内部函数，确保覆盖用户实际走的那条路。
 *
 * 用法：node tests/run-mirror.test.js
 */

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const STUB_SDK = path.join(__dirname, '_stubs', 'wx-server-sdk', 'index.js');

/* 让云函数能 require('wx-server-sdk') */
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (r, p, i, o) {
  return r === 'wx-server-sdk' ? STUB_SDK : origResolve.call(this, r, p, i, o);
};

const api = require(path.join(ROOT, 'cloudfunctions', 'xj-api', 'index.js'));

/**
 * 直接调云函数 handler，模拟 wx.cloud.callFunction。
 *
 * 注意 userId 要放进 **event 顶层**——那才是云函数认定的调用方身份
 * （对应客户端 utils/api.js 的 demoUserId 信封）。放进 payload 的 userId
 * 只是读数据用的 persona，不参与隐私裁剪。
 */
function callCloud(action, payload, userId) {
  return api.main({ action, payload, userId: userId || 'u_me' });
}

/**
 * 小程序环境替身：wx.cloud.callFunction 转发到上面的 handler。
 *
 * ⚠ 转发时必须把客户端构造的**身份信封**（data.demoUserId）如实传下去。
 *   早期替身写死 'u_me'，于是「客户端有没有带身份」这件事根本没被测到——
 *   而它正是服务端所有权校验的唯一依据。现在按真实形状转发，
 *   顺带验证 utils/api.js 的 withIdentity / identityEnvelope 是否配对。
 */
const storage = {};
global.wx = {
  setStorageSync: (k, v) => { storage[k] = v; },
  getStorageSync: (k) => storage[k],
  removeStorageSync: (k) => { delete storage[k]; },
  showToast: () => {},
  showModal: () => {},
  cloud: {
    init: () => {},
    callFunction: (opt) => {
      const { name, data } = opt;
      if (name !== 'xj-api') {
        return Promise.resolve({ result: { ok: false, error: '未知云函数 ' + name } });
      }
      return callCloud(data.action, data.payload, data.demoUserId)
        .then((r) => ({ result: r }))
        .catch((e) => ({ result: { ok: false, error: e.message } }));
    }
  }
};

/* 现在可以安全加载小程序端模块 */
const config = require(path.join(ROOT, 'core', 'config.js'));
const store = require(path.join(ROOT, 'utils', 'store.js'));
const apiClient = require(path.join(ROOT, 'utils', 'api.js'));
const service = require(path.join(ROOT, 'utils', 'service.js'));

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

async function main() {
  group('0. 准备云端数据');

  await test('云端初始化 + 灌入演示数据', async () => {
    const init = await callCloud('system.step', { step: 'init' });
    assert(init.ok, 'init 失败：' + init.error);
    const seed = await callCloud('system.step', { step: 'seed' });
    assert(seed.ok, 'seed 失败：' + seed.error);
    assert(seed.data.itemCount >= 40, '物品数应 ≥40，实际 ' + seed.data.itemCount);
  });

  group('1. 云端 item.list 必须返回可用于计算的实体');

  let listRes = null;

  await test('默认返回 entity 格式（不是展示视图）', async () => {
    listRes = await callCloud('item.list', {});
    assert(listRes.ok, 'item.list 失败');
    assert(listRes.data.format === 'entity',
      '应返回 entity 格式，实际 ' + listRes.data.format +
      '（若为 view 则客户端镜像会丢字段）');
  });

  await test('实体里包含 embeddings', async () => {
    const lost = listRes.data.items.find((x) => x.id === 'lost_cup_01');
    assert(lost, '应能找到 lost_cup_01');
    assert(lost.embeddings, '实体必须含 embeddings，否则视觉相似度会整体失效');
    assert(lost.embeddings.image && lost.embeddings.image.length > 0, '图像向量不能为空');
    assert(lost.embeddings.text && lost.embeddings.text.length > 0, '文本向量不能为空');
  });

  await test('实体里包含 timeRange（不能是 null）', async () => {
    const lost = listRes.data.items.find((x) => x.id === 'lost_cup_01');
    assert(lost.timeRange, '失物必须含 timeRange，否则时间维度会「未参与」');
    assert(typeof lost.timeRange.start === 'number' && lost.timeRange.start > 0,
      'timeRange.start 应是有效时间戳，实际 ' + JSON.stringify(lost.timeRange));
  });

  await test('实体里包含 foundTime 与完整 location', async () => {
    const found = listRes.data.items.find((x) => x.id === 'found_cup_01');
    assert(found.foundTime > 0, '拾物必须有 foundTime，实际 ' + found.foundTime);
    assert(found.location && found.location.id, 'location 必须有 id');
    assert(found.location.area, 'location 必须有 area（分区判断需要）');
    assert(typeof found.location.lat === 'number', 'location 必须有纬度');
  });

  await test('隐藏特征只回传给本人（防冒充）', async () => {
    /**
     * 身份分两层，测试必须分别验证：
     *   · 隐私裁剪只认服务端身份（callCloud 的第三个参数，即 ctx.userId）；
     *   · 客户端传 viewerId 只能影响展示 persona，**换不来别人的隐藏特征**。
     */
    // u_me 是 lost_cup_01 的所有者，能看到自己的隐藏特征
    const mine = await callCloud('item.list', { viewerId: 'u_me' }, 'u_me');
    const myLost = mine.data.items.find((x) => x.id === 'lost_cup_01');
    assert(myLost.privateFeatures.length > 0, '本人应能看到自己的隐藏特征');

    // 换个真实身份：不应看到别人的隐藏特征
    const other = await callCloud('item.list', { viewerId: 'u_other' }, 'u_other');
    const notMine = other.data.items.find((x) => x.id === 'lost_cup_01');
    assert(notMine.privateFeatures.length === 0,
      '非本人不应看到隐藏特征（认领核验的答案），实际泄露 ' +
      notMine.privateFeatures.length + ' 项');
    assert(notMine.privateCount > 0, '但应回传数量供界面提示');

    // 关键回归：冒充。伪造 viewerId 也不能拿到别人的隐藏特征
    const spoof = await callCloud('item.list', { viewerId: 'u_me' }, 'u_other');
    const spoofed = spoof.data.items.find((x) => x.id === 'lost_cup_01');
    assert(spoofed.privateFeatures.length === 0,
      '伪造 viewerId 不应拿到别人的隐藏特征，实际泄露 ' + spoofed.privateFeatures.length + ' 项');
    assert(spoofed.privateCount > 0, '数量仍应保留');
  });

  await test('客户端云调用带身份信封，且 identity 是身份的唯一来源', async () => {
    /**
     * 这条测试盯的是「服务端拿不到身份」这个根因：
     *   身份必须由 core/identity 统一提供，utils/api.js 每次云调用放进
     *   event 顶层（demoUserId）。任一处断了，服务端所有权校验就退化成
     *   「所有人都是 u_me」——也就是之前所有权的洞。
     */
    const identity = require(path.join(ROOT, 'core', 'identity.js'));

    // 未注册读取器时回落到默认身份
    identity.reset();
    assert(identity.currentUserId() === identity.DEFAULT_USER_ID,
      '未注册时应回落默认身份（保证离线演示不受影响）');

    // 注册后立刻反映最新值（切身份后下一次调用即生效，不能缓存）
    let acting = 'u_lin';
    identity.register(() => acting);
    assert(identity.currentUserId() === 'u_lin', '应读到注册后的身份');
    acting = 'u_wang';
    assert(identity.currentUserId() === 'u_wang', '应实时读取，不能缓存旧身份');

    // 读取器抛异常时不能把整个调用链打断
    identity.register(() => { throw new Error('boom'); });
    assert(identity.currentUserId() === identity.DEFAULT_USER_ID, '读取异常应安全兜底');

    // 走真实客户端链路：apiClient 发出的调用必须让服务端看到 u_wang
    identity.register(() => 'u_wang');
    const cfg = require(path.join(ROOT, 'core', 'config.js'));
    assert(cfg.cloudReady(), '前置条件：云端模式已启用');

    const apiClient = require(path.join(ROOT, 'utils', 'api.js'));
    // 以 u_wang 的身份去更新 u_me 的记录，应被服务端所有权校验拒绝
    const denied = await apiClient.callApi('item.update', {
      id: 'lost_cup_01', patch: { description: '冒充者改的' }
    }).then(() => null, (e) => e);
    assert(denied, '以他人身份修改记录应被拒绝（说明身份确实传到了服务端）');
    assert(/只能修改自己发布的记录/.test(denied.message),
      '应返回所有权错误，实际：' + denied.message);

    // 换回物主本人则允许
    identity.register(() => 'u_me');
    const okRes = await apiClient.callApi('item.update', {
      id: 'lost_cup_01', patch: { description: '本人改的描述' }
    });
    assert(okRes && okRes.item, '物主本人应能更新自己的记录');
  });

  group('2. 客户端镜像必须保留计算字段');

  await test('配置为云端模式且能取到快照', async () => {
    assert(config.cloudReady(), 'cloudReady 应为 true（envId 已配置）');
    const snap = await apiClient.fetchSnapshot('u_me');
    assert(snap && snap.items, '快照应含 items');
    assert(snap.items.length >= 40, '快照物品数应 ≥40，实际 ' + (snap.items || []).length);
  });

  await test('同步后本地镜像里的失物保留 timeRange 与 embeddings', async () => {
    // 走真实同步链路
    const ok = await store.refreshFromCloud();
    assert(ok, 'refreshFromCloud 应成功');

    const lost = store.getItem('lost_cup_01');
    assert(lost, '本地镜像应有 lost_cup_01');
    assert(lost.embeddings, '镜像必须保留 embeddings（否则视觉相似度失效）');
    assert(lost.timeRange, '镜像必须保留 timeRange（否则时间维度失效）');
    assert(lost.timeRange.start > 0, 'timeRange.start 应有效');
  });

  group('3. 详细对比页的本地重算必须与云端一致');

  await test('本地 compareDetail 得到 82%（而不是 48%）', async () => {
    const det = service.compareDetail(null, { lostId: 'lost_cup_01', foundId: 'found_cup_01' });
    assert(det, 'compareDetail 不应为 null');
    assert(det.percent >= 80,
      '本地重算应 ≥80%，实际 ' + det.percent + '%' +
      '（若为 48% 说明镜像丢了 embeddings 或 timeRange）');
  });

  await test('五路分项全部可用', async () => {
    const det = service.compareDetail(null, { lostId: 'lost_cup_01', foundId: 'found_cup_01' });
    const av = det.detail.available;
    assert(av.image === true, '视觉相似度应可用（实际 ' + av.image + '）');
    assert(av.time === true, '时间相关度应可用（实际 ' + av.time + '）');
    assert(av.geo === true, '地点相关度应可用');
    assert(av.attr === true, '属性一致度应可用');
    assert(av.text === true, '文字语义应可用');
  });

  await test('时间差显示为 22 分钟', async () => {
    const det = service.compareDetail(null, { lostId: 'lost_cup_01', foundId: 'found_cup_01' });
    assert(det.detail.time.available, '时间应可用');
    assert(det.detail.time.deltaText.indexOf('22') >= 0,
      '时间差应含 22，实际 ' + det.detail.time.deltaText);
  });

  await test('视觉相似度有分数且接近 1', async () => {
    const det = service.compareDetail(null, { lostId: 'lost_cup_01', foundId: 'found_cup_01' });
    assert(det.detail.image.available, '视觉应可用');
    assert(det.detail.image.score > 0.9,
      '同一图片标识的视觉相似度应接近 1，实际 ' + det.detail.image.score);
  });

  await test('客户端分数与云端权威分数一致（误差 <1%）', async () => {
    const cloud = await callCloud('system.inspect', { lostId: 'lost_cup_01', foundId: 'found_cup_01' });
    const local = service.compareDetail(null, { lostId: 'lost_cup_01', foundId: 'found_cup_01' });
    const diff = Math.abs(cloud.data.score.total - local.detail.score);
    assert(diff < 0.01,
      '客户端与云端分数应一致：云端 ' + (cloud.data.score.total * 100).toFixed(1) +
      '% vs 本地 ' + (local.detail.score * 100).toFixed(1) + '%');
  });

  group('4. 匹配列表也走同一份镜像');

  await test('匹配页能拿到候选且卡片字段完整', async () => {
    const cells = service.allCandidateViews({ minScore: 0.3 });
    assert(cells.length > 0, '应有候选，实际 ' + cells.length);
    const top = cells[0];
    assert(top.percent >= 50, '第一张卡匹配度应 ≥50%，实际 ' + top.percent);
    assert(top.counterpart, '卡片应有 counterpart');
    assert(top.counterpart.hasImage !== undefined, 'hasImage 应有值');
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
