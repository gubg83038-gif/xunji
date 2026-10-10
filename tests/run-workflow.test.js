/**
 * 端到端闭环回归
 * ---------------------------------------------------------------
 *   node tests/run-workflow.test.js
 *
 * 为什么需要这个套件：
 *   今天这一轮里发现的几个真实缺陷，**没有任何现成套件能挡住**：
 *     · `rejectMatch` 对未落库的候选静默 return ok:false，页面却提示成功；
 *     · 「从候选卡片直接发起认领」因为 matchId 是合成 id 而完全走不通；
 *     · `claim.confirm` 能被重复调用，把已通过的认领改成未通过；
 *     · `u_me` 被错放进管理员名单，导致所有权校验被静默绕过。
 *
 *   它们的共同点是：**单点函数都对，串起来才错**。
 *   现有套件分别覆盖算法（run-utils）、结构（check-*）、页面生命周期（run-pages），
 *   但没有一条测试把「发布 → 匹配 → 候选 → 认领 → 核验 → 确认 → 归还 → 反馈」
 *   当作用户会走的一条路径完整跑一遍。
 *
 * 本套件就做这一件事：在云端（用 wx-server-sdk 替身）与离线两条实现上，
 * 各跑一遍完整闭环，并断言每一步的状态、身份与数据都正确。
 */

const Module = require('module');
const path = require('path');

/* ---------- 注入 wx-server-sdk 替身（云函数端） ---------- */
const STUB = path.join(__dirname, '_stubs', 'wx-server-sdk', 'index.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'wx-server-sdk') return STUB;
  return originalResolve.call(this, request, parent, isMain, options);
};

const assert = require('assert');
const cloudStore = require(path.join(__dirname, '..', 'cloudfunctions', 'xj-api', 'store.js'));
const cloudApi = require(path.join(__dirname, '..', 'cloudfunctions', 'xj-api', 'index.js'));

/* ---------- 离线端：模拟小程序环境 ---------- */
const memory = {};
global.wx = {
  setStorageSync(key, value) { memory[key] = value; },
  getStorageSync(key) { return memory[key]; },
  removeStorageSync(key) { delete memory[key]; },
  showToast() {},
  showModal() {},
  navigateTo() {},
  switchTab() {},
  redirectTo() {}
};
global.getApp = () => global.__app;
global.__app = { globalData: { userId: 'u_me', mode: 'local' } };
const identity = require(path.join(__dirname, '..', 'core', 'identity.js'));
identity.register(() => global.__app.globalData.userId);

const localStore = require(path.join(__dirname, '..', 'utils', 'store.js'));
const localService = require(path.join(__dirname, '..', 'utils', 'service.js'));
const localSeed = require(path.join(__dirname, '..', 'mock', 'seed.js'));

/* ===================== 测试框架 ===================== */

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    const out = await fn();
    passed += 1;
    console.log('  ✓ ' + name);
    return out;
  } catch (e) {
    failed += 1;
    failures.push({ name, error: e });
    console.log('  ✗ ' + name);
    console.log('    → ' + String(e && e.message).split('\n')[0]);
    return null;
  }
}

function group(title) {
  console.log('\n' + title);
}

/* ===================== 云端闭环 ===================== */

async function call(action, payload, userId) {
  const res = await cloudApi.main(Object.assign({ action, payload: payload || {} }, userId ? { userId } : {}));
  if (!res.ok) throw new Error(action + ' 失败：' + (res.error && res.error.message));
  return res.data;
}

/**
 * 云端闭环。
 * 返回值是第 ③ 步建立的认领上下文（后续步骤需要 claimId / keeperId）。
 */
async function cloudWorkflow() {
  group('1. 云端闭环：发布 → 匹配 → 候选 → 认领 → 核验 → 确认 → 归还 → 反馈');

  await call('system.init', {}, 'u_me');
  await call('seed.demo', { reset: true }, 'u_me');

  /** 演示主线：u_me 的失物（图书馆丢的保温杯） */
  const lostId = 'lost_cup_01';
  const lost = await cloudStore.getItem(lostId);
  const owner = lost.userId;

  await test('① 失主能看到自己的失物，且隐藏特征只回传给本人', async () => {
    const mine = await call('item.list', {}, owner);
    const item = mine.items.find((x) => x.id === lostId);
    assert.ok(item, '失主应能看到自己的记录');

    const other = await call('item.list', { viewerId: owner }, 'u_chen');
    const leaked = other.items.find((x) => x.id === lostId);
    assert.strictEqual(leaked.privateFeatures.length, 0, '非本人不应看到隐藏特征');
  });

  await test('② 匹配引擎给出候选，且都带有可解释证据', async () => {
    const res = await call('match.candidates', { itemId: lostId, topK: 20, minScore: 0.3 }, owner);
    assert.ok(res.views.length >= 1, '应至少有一个候选，实际 ' + res.views.length);
    const top = res.views[0];
    ['score', 'percent', 'counterpart', 'reasonTexts', 'scoreBars'].forEach((k) => {
      assert.ok(top[k] !== undefined, '候选卡缺少字段 ' + k);
    });
    assert.ok(top.counterpart.hasImage !== undefined, 'counterpart.hasImage 未定义');
  });

  const ctx = await test('③ 从候选卡片直接发起认领（合成 id + 含下划线的物品 id）', async () => {    /**
     * 这条路径之前是坏的，而且坏得很隐蔽：
     *   · 候选列表是**读时重算**的，合成 id 的约定是
     *     `match_<lostId>__<foundId>`（双下划线）；
     *   · 旧实现直接 `getMatch(id)`，拿不到就回「候选不存在」，
     *     所以「从候选卡片点发起认领」根本走不通；
     *   · 而且**物品 id 本身含下划线**（演示数据 `found_cup_01`、
     *     真实发布生成的 `item_mv0wqk6j_17b`），
     *     用单下划线拼接时这个 id 无法可靠反解——分隔符必须用 `__`。
     *
     * 这里发布一条全新的拾物（它的 id 就是运行时生成的、带下划线的形式），
     * 然后从候选列表直接发起认领。
     */
    const found = await call('item.publish', {
      kind: 'found',
      userId: 'u_chen',
      description: '深灰色不锈钢保温杯，黑色杯盖，杯身有白色纵向 Logo',
      attributes: { category: 'cup', main_color: '深灰', material: '不锈钢' },
      locationId: (await cloudStore.getItem(lostId)).location.id,
      foundTime: Date.now(),
      privateFeatures: ['杯底有一道大约三厘米的纵向划痕'],
      images: []
    }, 'u_chen');
    assert.ok(found.item, '新拾物应发布成功');
    assert.ok(found.item.id.indexOf('_') >= 0, '前置条件：物品 id 含下划线');

    const syntheticId = 'match_' + lostId + '__' + found.item.id;
    const res = await call('match.candidates', { itemId: lostId, topK: 20, minScore: 0.3 }, owner);
    const target = res.views.find((v) => v.id === syntheticId);
    assert.ok(target, '新发布的拾物应出现在候选列表里：' +
      JSON.stringify(res.views.map((v) => v.foundId)));
    assert.strictEqual(target.found.userId, 'u_chen', '候选应属于新发布的拾物者');

    const started = await call('claim.start', { matchId: target.id }, owner);
    assert.strictEqual(started.claim.claimantId, owner, 'claimantId 应为失主');
    assert.strictEqual(started.claim.keeperId, 'u_chen', 'keeperId 应为拾物者本人');
    assert.strictEqual(started.claim.status, 'answering');

    const claim = await cloudStore.getClaim(started.claim.id);
    assert.ok(claim.questions.length >= 1, '应生成核验问题');
    assert.ok(claim.questions.some((q) => q.question.indexOf('划痕') >= 0 || q.question.indexOf('痕迹') >= 0),
      '问题应由隐藏特征转换而来：' + JSON.stringify(claim.questions.map((q) => q.question)));

    const match = await cloudStore.getMatch(syntheticId);
    assert.ok(match, '候选记录应存在');
    assert.strictEqual(match.foundId, found.item.id, '分类出的 foundId 必须与真实 id 完全一致');

    return { claimId: claim.id, keeperId: claim.keeperId, foundId: claim.foundId, matchId: target.id };
  });

  return ctx;
}

/* ===================== 离线闭环 ===================== */

let localCtx = null;

function localWorkflow() {
  group('2. 离线闭环：同一路径在纯本地实现下也成立（两端行为不能漂移）');

  localStore.reset(() => {});
  localSeed.ensureSeed();

  let ctx = null;

  return Promise.resolve()
    .then(() => test('① 失物、拾物与候选都在本地就绪', () => {
      assert.ok(localStore.itemsOf('lost').length >= 15, '失物数据应已灌入');
      assert.ok(localStore.itemsOf('found').length >= 15, '拾物数据应已灌入');
      const views = localService.candidatesForLost('lost_cup_01', { topK: 20, minScore: 0.3 }).views;
      assert.ok(views.length >= 1, '演示主线应有候选');
    }))
    .then(() => test('② 合成 matchId 也能发起认领（与云端同源）', () => {
      /**
       * 与云端同一个缺陷：候选列表是读时重算的（合成 id 为
       * `match_<lostId>__<foundId>`），而物品 id 本身含下划线。
       *
       * 演示主线恰好已经落库，所以这里**自己发布一对新记录**，
       * 再直接拿合成 id 发起认领，精确复现「从候选卡片直接认领」的现场。
       */
      const a = localService.publish({
        kind: 'lost',
        userId: 'u_me',
        description: '端到端回归：深灰色不锈钢保温杯，黑色杯盖，杯身有白色纵向 Logo',
        attributes: { category: 'cup', main_color: '深灰', material: '不锈钢' },
        locationId: 'library',
        timeText: '今天 15:00'
      }, { localOnly: true });
      const b = localService.publish({
        kind: 'found',
        userId: 'u_chen',
        description: '端到端回归：灰黑色金属水杯，深黑杯盖，杯身有白色英文标志',
        attributes: { category: 'cup', main_color: '灰黑', material: '金属' },
        locationId: 'library',
        foundTime: Date.now(),
        privateFeatures: ['杯底有一道大约三厘米的纵向划痕']
      }, { localOnly: true });
      assert.ok(a.item && b.item, '两条新记录都应发布成功');
      assert.ok(b.item.id.indexOf('_') >= 0, '前置条件：物品 id 含下划线');

      const syntheticId = 'match_' + a.item.id + '__' + b.item.id;
      const views = localService.candidatesForLost(a.item.id, { topK: 20, minScore: 0.1 }).views;
      const target = views.find((v) => v.id === syntheticId);
      assert.ok(target, '新发布的拾物应出现在候选列表里（合成 id）：' +
        JSON.stringify(views.map((v) => v.foundId)));
      assert.strictEqual(target.found.userId, 'u_chen');

      const started = localService.startClaim(syntheticId, { userId: 'u_me' });
      assert.strictEqual(started.ok, true, '应能从合成 id 直接发起认领：' + started.message);
      assert.strictEqual(started.claim.claimantId, 'u_me');
      assert.strictEqual(started.claim.keeperId, 'u_chen', 'keeperId 应正确分类出拾物者');
      const stored = localStore.getMatch(syntheticId);
      assert.ok(stored, '认领后应补出 match 记录');
      assert.strictEqual(stored.foundId, b.item.id, '分类出的 foundId 必须与真实 id 完全一致');
      localCtx = { claimId: started.claim.id, claim: started.claim };
    }))
    .then(() => test('③ 提交核验回答后进入待确认，且开启临时会话', () => {
      const c = localCtx.claim;
      const r = localService.submitClaim(c.id, c.questions.map(() => '杯底有一道大约三厘米的纵向划痕'),
        { userId: c.claimantId });
      assert.strictEqual(r.ok, true, '提交核验应成功：' + r.message);
      assert.strictEqual(localStore.getClaim(c.id).status, 'submitted');

      const session = localService.claimSessionView(c.id, { userId: c.claimantId });
      assert.strictEqual(session.state, 'open', '提交后会话应开启');
      assert.strictEqual(session.counterpartLabel, '拾物者');
    }))
    .then(() => test('④ 双方可在临时会话里约定交接', () => {
      const c = localCtx.claim;
      const a = localService.postClaimMessage(c.id, {
        userId: c.claimantId, text: '明天 12:30 图书馆一楼，我手机 13812345678'
      });
      assert.strictEqual(a.ok, true);
      assert.ok(a.message.text.indexOf('13812345678') < 0, '手机号应被脱敏');
      assert.ok(a.message.text.indexOf('12:30') >= 0, '交接时间应保留');

      const b = localService.postClaimMessage(c.id, { userId: c.keeperId, text: '可以，我带杯套过去' });
      assert.strictEqual(b.ok, true);

      const view = localService.claimSessionView(c.id, { userId: c.keeperId });
      assert.strictEqual(view.count, 2, '双方各一条');
      assert.strictEqual(view.myRole, 'keeper');
      assert.ok(view.messages[0].mine === false, '第一条不是自己发的');
    }))
    .then(() => test('⑤ 拾物者确认后进入待交接，重复确认被拒', () => {
      const c = localCtx.claim;
      const pass = localService.confirmClaim(c.id, 'pass', '', { userId: c.keeperId });
      assert.strictEqual(pass.ok, true, '拾物者确认应成功：' + pass.message);
      assert.strictEqual(localStore.getClaim(c.id).status, 'verified');

      const again = localService.confirmClaim(c.id, 'reject', '', { userId: c.keeperId });
      assert.strictEqual(again.ok, false, '不能重复确认');
      assert.strictEqual(localStore.getClaim(c.id).status, 'verified', '状态不应被改写');

      const lost = localStore.getItem(c.lostId);
      assert.strictEqual(lost.status, 'waiting_handover', '失物应进入待交接');
    }))
    .then(() => test('⑥ 完成归还后闭环：双方物品状态与反馈样本都正确', () => {
      const c = localCtx.claim;
      const done = localService.completeReturn(c.id, { userId: c.keeperId });
      assert.strictEqual(done.ok, true, '完成归还应成功：' + done.message);

      assert.strictEqual(localStore.getClaim(c.id).status, 'returned');
      assert.strictEqual(localStore.getItem(c.lostId).status, 'recovered', '失物应为已找回');
      assert.strictEqual(localStore.getItem(c.foundId).status, 'returned', '拾物应为已归还');

      const fbs = localStore.feedbacks().filter((f) => f.matchId === c.matchId);
      assert.ok(fbs.some((f) => f.userAction === 'returned'), '应写入正样本反馈');

      // 已归还后不再出现在候选池
      const after = localService.candidatesForLost(c.lostId, { topK: 20, minScore: 0 }).views;
      assert.ok(!after.some((v) => v.foundId === c.foundId), '已归还的拾物不应再入候选');
    }))
    .then(() => test('⑦ 会话在归还后转只读，历史可回看', () => {
      const c = localCtx.claim;
      const view = localService.claimSessionView(c.id, { userId: c.claimantId });
      assert.strictEqual(view.state, 'readonly');
      assert.strictEqual(view.canSend, false);
      assert.strictEqual(view.count, 2, '历史消息应保留');

      const denied = localService.postClaimMessage(c.id, { userId: c.claimantId, text: '再聊一句' });
      assert.strictEqual(denied.ok, false, '只读状态不应能发送');
    }))
    .then(() => test('⑧ 已归还的失物不再产生候选，也不能再发起认领', () => {
      const c = localCtx.claim;
      const views = localService.candidatesForLost(c.lostId, { topK: 20, minScore: 0 }).views;
      assert.strictEqual(views.length, 0, '已找回的失物不应再有候选');

      const again = localService.startClaim(c.matchId, { userId: 'u_me' });
      assert.strictEqual(again.ok, false, '已找回的失物不应再受理认领');
    }));
}

/* ===================== 排除与撤销的完整路径 ===================== */

async function rejectWorkflow() {
  group('3. 排除 → 撤销 的完整路径（界面必须有状态回执）');

  await test('云端：排除后候选消失、可撤销、撤销后回到列表', async () => {
    await call('seed.demo', { reset: true }, 'u_me');
    const owner = (await cloudStore.getItem('lost_key_01')).userId;

    const before = await call('match.candidates', { itemId: 'lost_key_01', topK: 5, minScore: 0.3 }, owner);
    assert.ok(before.views.length >= 2, '前置条件：应有多个候选');
    const target = before.views[0];

    await call('match.reject', {
      matchId: target.id, reason: '端到端回归', lostId: target.lostId, foundId: target.foundId
    }, owner);

    const after = await call('match.candidates', { itemId: 'lost_key_01', topK: 5, minScore: 0.3 }, owner);
    assert.ok(!after.views.some((v) => v.id === target.id), '排除后不应再出现');

    const withRejected = await call('match.candidates', {
      itemId: 'lost_key_01', topK: 5, minScore: 0.3, includeRejected: true
    }, owner);
    const found = withRejected.views.find((v) => v.id === target.id);
    assert.ok(found, '「已排除」视图应能取回它');
    assert.strictEqual(found.status, 'rejected');

    await call('match.restore', { matchId: target.id, lostId: target.lostId, foundId: target.foundId }, owner);
    const restored = await call('match.candidates', { itemId: 'lost_key_01', topK: 5, minScore: 0.3 }, owner);
    assert.ok(restored.views.some((v) => v.id === target.id), '撤销后应回到列表');
  });

  await test('离线：同一路径行为一致', () => {
    localStore.reset(() => {});
    localSeed.ensureSeed();

    const owner = localStore.getItem('lost_key_01').userId;
    const before = localService.candidatesForLost('lost_key_01', { topK: 5, minScore: 0.3 }).views;
    assert.ok(before.length >= 2, '前置条件：应有多个候选');
    const target = before[0];

    const r = localService.rejectMatch(target.id, '端到端回归', {
      lostId: target.lostId, foundId: target.foundId, score: target.score, passed: target.passed
    });
    assert.strictEqual(r.ok, true, '排除应成功：' + r.message);

    const after = localService.candidatesForLost('lost_key_01', { topK: 5, minScore: 0.3 }).views;
    assert.ok(!after.some((v) => v.id === target.id), '排除后不应再出现');

    const back = localService.restoreMatch(target.id, { lostId: target.lostId, foundId: target.foundId });
    assert.strictEqual(back.ok, true, '撤销应成功：' + back.message);
    const restored = localService.candidatesForLost('lost_key_01', { topK: 5, minScore: 0.3 }).views;
    assert.ok(restored.some((v) => v.id === target.id), '撤销后应回到列表');
    assert.strictEqual(localStore.getMatch(target.id).userStatus, 'new', 'userStatus 应一起复位');
  });
}

/* ===================== 主流程 ===================== */

async function main() {
  let claimCtx = null;

  await cloudWorkflow().then(async (ctx) => {
    claimCtx = ctx;
    assert.ok(claimCtx, '云端闭环第 ③ 步必须回传认领上下文，否则后续步骤无法继续');

    group('1.2 云端闭环（续）：已建立的认领单走完剩余步骤');

    await test('④ 核验回答决定辅助分，且只有认领者能提交', async () => {
      const c = await cloudStore.getClaim(claimCtx.claimId);

      const byOutsider = await cloudApi.main({
        action: 'claim.submit', payload: { claimId: c.id, answers: ['随便'] }, userId: 'u_chen'
      });
      assert.strictEqual(byOutsider.ok, false, '非认领者不应能提交');

      const r = await call('claim.submit', {
        claimId: c.id,
        answers: c.questions.map(() => '杯底有一道大约三厘米的纵向划痕，就在边缘')
      }, c.claimantId);
      assert.ok(r.claim.verificationScore > 0.3, '辅助分应 >0.3，实际 ' + r.claim.verificationScore);
      assert.strictEqual(r.claim.status, 'submitted');
    });

    await test('⑤ 核验会话随状态开启，联系方式自动脱敏', async () => {
      const c = await cloudStore.getClaim(claimCtx.claimId);
      const session = await call('claim.message', { claimId: c.id }, c.claimantId);
      assert.strictEqual(session.session.state, 'open', '提交后会话应开启');

      const sent = await call('claim.message', {
        claimId: c.id, text: '明天 12:30 图书馆一楼服务台，我电话 13812345678'
      }, c.claimantId);
      assert.ok(sent.message.text.indexOf('13812345678') < 0, '手机号应被脱敏');
      assert.ok(sent.message.text.indexOf('12:30') >= 0, '交接时间应保留');
      assert.strictEqual(sent.message.redacted, true);

      const reply = await call('claim.message', { claimId: c.id, text: '可以，我带杯套过去' }, c.keeperId);
      assert.strictEqual(reply.message.senderRole, 'keeper');
    });

    await test('⑥ 拾物者确认后进入待交接；重复确认被状态守卫拒绝', async () => {
      const c = await cloudStore.getClaim(claimCtx.claimId);

      const byClaimant = await cloudApi.main({
        action: 'claim.confirm', payload: { claimId: c.id, action: 'pass' }, userId: c.claimantId
      });
      assert.strictEqual(byClaimant.ok, false, '认领者不应能替拾物者确认');

      const pass = await call('claim.confirm', { claimId: c.id, action: 'pass' }, c.keeperId);
      assert.strictEqual(pass.claim.status, 'verified');

      const again = await cloudApi.main({
        action: 'claim.confirm', payload: { claimId: c.id, action: 'reject' }, userId: c.keeperId
      });
      assert.strictEqual(again.ok, false, '不能重复确认');
      assert.strictEqual((await cloudStore.getClaim(c.id)).status, 'verified', '状态不应被改写');
    });

    await test('⑦ 完成归还后闭环：状态、反馈与候选池都正确', async () => {
      const c = await cloudStore.getClaim(claimCtx.claimId);
      const done = await call('claim.return', { claimId: c.id }, c.keeperId);
      assert.strictEqual(done.claim.status, 'returned');

      assert.strictEqual((await cloudStore.getItem(c.lostId)).status, 'recovered');
      assert.strictEqual((await cloudStore.getItem(c.foundId)).status, 'returned');

      const fbs = await cloudStore.allFeedbacks();
      assert.ok(fbs.some((f) => f.matchId === c.matchId && f.userAction === 'returned'), '应有正样本反馈');

      const after = await call('match.candidates', { itemId: c.lostId, topK: 20, minScore: 0 }, c.claimantId);
      assert.ok(!after.views.some((v) => v.foundId === c.foundId), '已归还的拾物不应再入候选');
    });

    await test('⑧ 归还后会话转只读，历史消息仍可回看', async () => {
      const c = await cloudStore.getClaim(claimCtx.claimId);
      const view = await call('claim.message', { claimId: c.id }, c.claimantId);
      assert.strictEqual(view.session.state, 'readonly');
      assert.strictEqual(view.session.canSend, false);
      assert.strictEqual(view.messages.length, 2, '历史消息应保留');
    });
  });

  await localWorkflow();
  await rejectWorkflow();

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
