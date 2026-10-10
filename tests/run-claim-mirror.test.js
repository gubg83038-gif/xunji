/**
 * 回归：认领单读取不能依赖「本地镜像里恰好有它」
 * ---------------------------------------------------------------
 * 真实缺陷（用户反馈「为什么会有认领单不存在」+「数据更新矛盾」）：
 *   认领页读的是本地镜像，而镜像里的 claims 来自 `claim.mine`，
 *   是**按当前身份过滤过的**。切身份 / 换设备后镜像里没有这张单，
 *   界面就弹「认领单不存在」，可云端明明有数据。
 *
 *   node tests/run-claim-mirror.test.js
 */
const Module = require('module');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STUB = path.join(__dirname, '_stubs', 'wx-server-sdk', 'index.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'wx-server-sdk') return STUB;
  return originalResolve.call(this, request, parent, isMain, options);
};

const assert = require('assert');
const cloudStore = require(path.join(ROOT, 'cloudfunctions', 'xj-api', 'store.js'));
const cloudApi = require(path.join(ROOT, 'cloudfunctions', 'xj-api', 'index.js'));

/* ---------- 小程序环境替身：把云调用转发到真实 handler ---------- */
const storage = {};
let actingUser = 'u_me';
global.wx = {
  setStorageSync: (k, v) => { storage[k] = v; },
  getStorageSync: (k) => storage[k],
  removeStorageSync: (k) => { delete storage[k]; },
  showToast() {}, showModal() {}, hideToast() {}, showLoading() {}, hideLoading() {},
  setNavigationBarTitle() {},
  cloud: {
    init() {},
    callFunction(opt) {
      const { name, data } = opt;
      if (name !== 'xj-api') return Promise.resolve({ result: { ok: false, error: '未知云函数' } });
      return cloudApi.main({
        action: data.action,
        payload: data.payload || {},
        userId: data.demoUserId || 'u_me'
      }).then((r) => ({ result: r })).catch((e) => ({ result: { ok: false, error: { message: e.message } } }));
    }
  }
};

const identity = require(path.join(ROOT, 'core', 'identity.js'));
const lstore = require(path.join(ROOT, 'utils', 'store.js'));
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

async function cloudCall(action, payload) {
  const r = await cloudApi.main({ action, payload: payload || {}, userId: actingUser });
  if (!r.ok) throw new Error(action + ' → ' + r.error.message);
  return r.data;
}

/**
 * 模拟「以当前身份同步一次快照」：
 * 云端 fetchSnapshot 里 claims 来自 claim.mine（按身份过滤），
 * 这里如实把快照里的 claims 覆盖进镜像，复现「镜像里没有对方的认领单」。
 */
async function syncMirror() {
  const apiClient = require(path.join(ROOT, 'utils', 'api.js'));
  const snap = await apiClient.fetchSnapshot(actingUser);
  lstore.reset(() => {});
  (snap.claims || []).forEach((c) => lstore.insertClaim(c));
  (snap.matches || []).forEach((m) => lstore.upsertMatch(m));
  lstore.persist({ silent: true });
  return snap;
}

/** 把镜像清空，模拟「本地完全没有这张认领单」 */
function clearMirror() {
  lstore.reset(() => {});
  lstore.persist({ silent: true });
}

(async () => {
  await cloudCall('system.init', {});
  await cloudCall('seed.demo', { reset: true });
  identity.register(() => actingUser);

  group('1. 复现：认领单在云端存在，但本地镜像里没有');

  let claimId = '';
  let claimantId = '';
  let keeperId = '';

  await test('失主发起认领后，切到拾物者身份同步，镜像里就没有这张单了', async () => {
    // 失主创建认领单
    const list = await cloudCall('match.candidates', { itemId: 'lost_cup_01', topK: 20, minScore: 0.3 });
    const target = list.views.filter((v) => v.found.userId !== 'u_me')[0] || list.views[0];
    const started = await cloudCall('claim.start', { matchId: target.id });
    claimId = started.claim.id;
    claimantId = started.claim.claimantId;
    keeperId = started.claim.keeperId;
    assert.ok(claimId, '应创建出认领单');
    assert.notStrictEqual(claimantId, keeperId, '前置条件：双方不是同一人');
    // 提交核验，让会话打开
    const c = await cloudStore.getClaim(claimId);
    await cloudApi.main({
      action: 'claim.submit',
      payload: { claimId, answers: c.questions.map(() => '杯底有一道大约三厘米的纵向划痕') },
      userId: claimantId
    });

    // 以失主身份同步一次镜像：这张单在镜像里
    actingUser = claimantId;
    await syncMirror();
    assert.ok(lstore.getClaim(claimId), '以失主身份同步后，镜像里应有这张单');

    /**
     * 关键：`claim.mine` 是按身份过滤的，镜像只覆盖「当前身份」的认领单。
     * 因此只要换一个身份重新同步（或换设备 / 清缓存），镜像里就没有这张单了——
     * 这就是用户看到「认领单不存在」的现场。
     */
    actingUser = keeperId;
    await syncMirror();
    assert.ok(lstore.getClaim(claimId), '另一身份也属于双方，镜像里仍有它（说明过滤按双方判定）');

    // 换一个与本次认领无关的身份同步，镜像必然不含这张单
    actingUser = 'u_zhao';
    await syncMirror();
    assert.strictEqual(lstore.getClaim(claimId) || null, null,
      '无关身份同步后镜像里不应有该认领单');
  });

  group('2. 修复后的行为：镜像缺失时回源服务端');

  await test('镜像里没有该单时，claimDetailAsync 会回源服务端读到它', async () => {
    // 以拾物者身份操作，但先把镜像清空——模拟「本地根本没有这张单」
    actingUser = keeperId;
    clearMirror();
    assert.strictEqual(lstore.getClaim(claimId) || null, null, '前置条件：镜像里没有这张认领单');

    const r = await service.claimDetailAsync(claimId);
    assert.ok(r.claim, '应回源读到认领单，实际错误：' + r.error);
    assert.strictEqual(r.claim.id, claimId);
    assert.strictEqual(r.claim.keeperId, keeperId);
    assert.ok(r.claim.questions.length >= 1, '应带回核验问题');
  });

  await test('镜像里已有该单时，直接读镜像（不回源，行为不变）', async () => {
    actingUser = claimantId;
    await syncMirror();
    assert.ok(lstore.getClaim(claimId), '前置条件：镜像里有这张单');
    const r = await service.claimDetailAsync(claimId);
    assert.ok(r.claim, '应能读到');
    assert.strictEqual(r.forbidden, false);
  });

  await test('回源后写回镜像，后续读取（会话等）才能命中', async () => {
    assert.ok(lstore.getClaim(claimId), '应已写回本地镜像');
    const session = service.claimSessionView(claimId, { userId: keeperId });
    assert.ok(session, '会话视图应可构造');
    assert.strictEqual(session.myRole, 'keeper', '拾物者的角色应为 keeper');
    assert.strictEqual(session.state, 'open', '已提交核验，会话应开启');
  });

  await test('无关身份：回源返回 forbidden 而不是「不存在」', async () => {
    actingUser = 'u_zhao';
    clearMirror();
    assert.strictEqual(lstore.getClaim(claimId) || null, null, '前置条件：镜像里没有');

    const r = await service.claimDetailAsync(claimId);
    assert.strictEqual(r.claim, null, '不应读到内容');
    assert.strictEqual(r.forbidden, true, '应标记为「无权查看」而不是「不存在」');
    assert.ok(/失主与拾物者/.test(r.error), '应给出权限原因，实际：' + r.error);
  });

  await test('真的不存在时：forbidden=false，错误可区分', async () => {
    actingUser = 'u_me';
    const r = await service.claimDetailAsync('claim_not_exist_at_all');
    assert.strictEqual(r.claim, null);
    assert.strictEqual(r.forbidden, false, '不存在与无权必须区分开');
    assert.ok(/不存在/.test(r.error), '应说明不存在，实际：' + r.error);
  });

  group('3. 数据一致性：认领单指向的 match 必须真实存在');

  await test('claim.matchId 指向的 match 记录存在', async () => {
    const claim = await cloudStore.getClaim(claimId);
    const m = await cloudStore.getMatch(claim.matchId);
    assert.ok(m, 'claim.matchId 指向的 match 不存在：' + claim.matchId);
    assert.strictEqual(m.lostId, claim.lostId, 'match.lostId 应与认领单一致');
    assert.strictEqual(m.foundId, claim.foundId, 'match.foundId 应与认领单一致');
  });

  await test('候选列表里的每个 id 都指向真实存在的 match（不会出现幽灵候选 id）', async () => {
    let ghost = 0;
    let checked = 0;
    for (const l of await cloudStore.itemsOf('lost')) {
      if (l.status === 'recovered' || l.status === 'closed') continue;
      // 认领只能由失主本人发起，身份要跟着记录走
      const res = await cloudApi.main({
        action: 'match.candidates', payload: { itemId: l.id, topK: 20, minScore: 0.3 }, userId: l.userId
      });
      if (!res.ok) continue;
      for (const v of res.data.views) {
        checked += 1;
        const m = await cloudStore.getMatch(v.id);
        if (!m) ghost += 1;
      }
    }
    assert.ok(checked > 0, '应至少检查到一些候选');
    assert.strictEqual(ghost, 0, '存在 ' + ghost + ' 个候选 id 在库里查不到 match（共检查 ' + checked + ' 个）');
  });

  await test('同一对 (lostId, foundId) 不会出现两条 match 记录', async () => {
    const all = await cloudStore.allMatches();
    const seen = {};
    const dups = [];
    all.forEach((m) => {
      const k = m.lostId + '|' + m.foundId;
      if (seen[k]) dups.push(k);
      seen[k] = true;
    });
    assert.strictEqual(dups.length, 0, '重复配对：' + JSON.stringify(dups.slice(0, 5)));
  });

  await test('认领单的 claimantId/keeperId 与 match 的双方一致', async () => {
    const claims = await cloudStore.fetchAll('claims', {});
    let bad = 0;
    for (const c of claims) {
      const m = await cloudStore.getMatch(c.matchId);
      if (!m) { bad += 1; continue; }
      if (m.lostId !== c.lostId || m.foundId !== c.foundId) bad += 1;
    }
    assert.strictEqual(bad, 0, '有 ' + bad + ' 张认领单与它的 match 记录不一致');
  });

  await test('库里 match 记录用的是旧 id 格式时，认领仍走通且 id 被归一', async () => {
    /**
     * 真实场景：云端历史数据的 match id 用单下划线，
     * 而客户端新代码按 `__` 推导合成 id。两者指向同一对记录。
     *
     * 若 resolveMatch 只是「找到就返回」，调用方继续用传入 id 去
     * updateMatch / claimByMatch 就会影响 0 行 / 查不到——
     * 认领单会指向一个不存在的 match，表现为「数据对不上」。
     */
    // 造一对全新的记录，避免复用演示数据里已有的 match
    const lostNew = await cloudApi.main({
      action: 'item.publish',
      payload: {
        kind: 'lost', userId: 'u_me',
        description: '一致性回归：灰色折叠雨伞，伞面有白色波点',
        attributes: { category: 'umbrella', main_color: '灰' },
        locationId: 'library', timeText: '今天 10:00'
      },
      userId: 'u_me'
    });
    assert.ok(lostNew.ok, '发布失物应成功：' + (lostNew.error && lostNew.error.message));
    const lostId = lostNew.data.item.id;

    const foundNew = await cloudApi.main({
      action: 'item.publish',
      payload: {
        kind: 'found', userId: 'u_wang',
        description: '一致性回归：灰白色折叠伞，伞面带白色圆点',
        attributes: { category: 'umbrella', main_color: '灰白' },
        locationId: 'library', foundTime: Date.now(),
        privateFeatures: ['伞柄末端有一处掉漆']
      },
      userId: 'u_wang'
    });
    assert.ok(foundNew.ok, '发布拾物应成功');
    const foundId = foundNew.data.item.id;

    const canonical = 'match_' + lostId + '__' + foundId;
    const legacy = 'match_' + lostId + '_' + foundId;

    /**
     * 把库里那条改成「旧格式 id」，模拟历史数据。
     * 注意不能走 store.updateMatch —— 它会主动剥掉 patch 里的 id
     * （防止业务代码随意改主键），所以这里直接用替身集合改文档。
     */
    const stub = require(STUB);
    const rows = stub.__collections.xj_matches;
    const row = rows.filter((d) => d.id === canonical)[0];
    assert.ok(row, '应能在集合里找到该 match 文档');
    row.id = legacy;
    assert.ok(await cloudStore.getMatch(legacy), '旧格式记录应就位');
    assert.strictEqual(await cloudStore.getMatch(canonical), null, '规范 id 此时查不到');

    // 客户端会按规范格式发起认领
    const started = await cloudApi.main({
      action: 'claim.start', payload: { matchId: canonical }, userId: 'u_me'
    });
    assert.ok(started.ok, '应能发起认领：' + (started.error && started.error.message));

    const claim = await cloudStore.getClaim(started.data.claim.id);
    assert.ok(claim, '认领单应落库');
    assert.strictEqual(claim.matchId, canonical, 'claim.matchId 应等于调用方使用的 id');

    const m = await cloudStore.getMatch(claim.matchId);
    assert.ok(m, 'claim.matchId 必须指向真实存在的 match（否则就是数据矛盾）');
    assert.strictEqual(m.lostId, lostId);
    assert.strictEqual(m.foundId, foundId);

    // 同一对记录不能留下两条 match
    const pair = (await cloudStore.allMatches()).filter((x) => x.lostId === lostId && x.foundId === foundId);
    assert.strictEqual(pair.length, 1, '同一对应只有一条 match，实际 ' + pair.length + '：' + JSON.stringify(pair.map((x) => x.id)));
  });

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
})().catch((e) => { console.error('运行异常：', e); process.exit(1); });
