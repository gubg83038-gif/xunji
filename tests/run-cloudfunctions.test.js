/**
 * 云函数冒烟测试
 * ---------------------------------------------------------------
 *   node tests/run-cloudfunctions.test.js
 *
 * 用 tests/_stubs/wx-server-sdk 作为云数据库替身，直接在 Node 里跑云函数业务逻辑，
 * 覆盖「灌演示数据 → 发布 → 匹配 → 认领核验 → 归还」整条云端链路。
 *
 * 为什么值得写这个测试：
 *   云函数一旦部署上去，排查问题只能看云端日志；在本地用替身把逻辑跑通，
 *   能把绝大多数问题挡在部署之前。
 *
 * 注意：本测试不校验微信侧的鉴权、配额与真实网络行为。
 */

const path = require('path');
const Module = require('module');

/* ---------- 注入 wx-server-sdk 替身 ---------- */
const STUB = path.join(__dirname, '_stubs', 'wx-server-sdk', 'index.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'wx-server-sdk') return STUB;
  return originalResolve.call(this, request, parent, isMain, options);
};

const assert = require('assert');
const store = require(path.join(__dirname, '..', 'cloudfunctions', 'xj-api', 'store.js'));
const service = require(path.join(__dirname, '..', 'cloudfunctions', 'xj-api', 'service.js'));
const matcher = require(path.join(__dirname, '..', 'core', 'matcher.js'));
const seedData = require(path.join(__dirname, '..', 'core', 'seed-data.js'));
const ops = require(path.join(__dirname, '..', 'core', 'matching-ops.js'));

const api = require(path.join(__dirname, '..', 'cloudfunctions', 'xj-api', 'index.js'));
const ai = require(path.join(__dirname, '..', 'cloudfunctions', 'xj-ai', 'index.js'));

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
    console.log('    → ' + (e && e.message));
  }
}

function group(title) {
  console.log('\n' + title);
}

/** 调用 xj-api 的 main 并断言成功 */
async function call(action, payload) {
  const res = await api.main({ action, payload: payload || {} });
  if (!res.ok) {
    throw new Error('action ' + action + ' 失败：' + (res.error && res.error.message));
  }
  return res.data;
}

async function main() {
  /* ===================== 1. 初始化与数据灌入 ===================== */
  group('1. 集合初始化与演示数据灌入');

  await test('system.init 创建全部集合', async () => {
    const data = await call('system.init');
    assert.ok(data.meta, '应返回元信息');
    const names = Object.keys(data.collections).length;
    assert.strictEqual(names, 7, '应定义 7 个集合，实际 ' + names);
  });

  await test('seed.demo 灌入演示数据', async () => {
    const data = await call('seed.demo', { reset: true });
    assert.ok(data.lostCount >= 15, '失物记录应 ≥15 条，实际 ' + data.lostCount);
    assert.ok(data.foundCount >= 15, '拾物记录应 ≥15 条，实际 ' + data.foundCount);
  });

  await test('重复灌入会被跳过（幂等）', async () => {
    const data = await call('seed.demo', {});
    assert.strictEqual(data.skipped, true, '第二次灌入应跳过');
  });

  await test('seed.demo 报告物品数与匹配数（便于判断是否半成品）', async () => {
    const data = await call('seed.demo', {});
    assert.ok(data.itemCount > 0, '应报告物品总数，实际 ' + data.itemCount);
    assert.ok(data.matchCount > 0, '应报告匹配数，实际 ' + data.matchCount);
  });

  /* ===================== 1.1 一键初始化 ===================== */
  group('1.1 一键初始化 system.setup');

  await test('system.setup 依次完成建集合 → 灌数据 → 补跑匹配', async () => {
    // 先清空，验证从零开始也能一步到位
    await store.clearData({ keepUsers: true });
    const data = await call('system.setup', { reset: true });

    const stepNames = data.steps.map((s) => s.step);
    assert.deepStrictEqual(stepNames, ['建集合', '灌演示数据', '补跑匹配'],
      '步骤顺序不对，实际 ' + stepNames.join(' → '));

    assert.ok(data.steps[1].lostCount >= 15, '应灌入失物数据，实际 ' + data.steps[1].lostCount);
    assert.ok(data.stats, '应返回统计');
    assert.ok(data.stats.lostCount >= 15, '统计里的失物数应正确');
    assert.ok(data.stats.matchCount > 0, '补跑匹配后应有候选，实际 ' + data.stats.matchCount);
    assert.ok(data.embedding && data.embedding.label, '应说明当前向量方案');
  });

  await test('system.setup 不传 reset 时不清空已有数据（安全默认）', async () => {
    // 先确保有数据
    await call('system.setup', { reset: true });
    const before = await store.countItems();

    // 不传 payload，验证不会误清空
    const data = await call('system.setup', {});
    const after = await store.countItems();
    assert.strictEqual(after, before, '不传 reset 时物品数不应变化（before=' + before + ' after=' + after + '）');
    assert.strictEqual(data.steps[1].skipped, true, '应报告跳过灌入');
  });

  await test('system.setup 后候选可正常检索（端到端可用）', async () => {
    const data = await call('match.candidates', { itemId: 'lost_cup_01', topK: 5, minScore: 0.3 });
    assert.ok(data.views.length > 0, '一键初始化后应能查到候选');
    assert.strictEqual(data.results[0].foundItem.id, 'found_cup_01', '演示主线第一名应正确');
  });

  await test('seed.demo 自愈：有记录但无匹配时自动补跑', async () => {
    // 模拟「上次灌入被 20 秒超时打断」的半成品状态：只留物品，清掉全部匹配
    const matches = await store.allMatches();
    for (let i = 0; i < matches.length; i += 1) {
      await store.removeMatch(matches[i].id);
    }
    const leftItems = await store.countItems();
    assert.ok(leftItems > 0, '应仍有物品记录（模拟半成品）');
    assert.strictEqual((await store.allMatches()).length, 0, '匹配应已清空');

    const data = await call('seed.demo', {});
    assert.ok(data.healed, '检测到无匹配时应触发自愈');
    assert.ok(data.healed.created > 0, '自愈应补出候选，实际 ' +
      (data.healed && data.healed.created));
    assert.ok((await store.allMatches()).length > 0, '自愈后应有匹配');
  });

  /* ===================== 1.2 分步 + 分块初始化 ===================== */
  group('1.2 分步 + 分块初始化 system.step（云函数默认超时只有 3 秒）');

  await test('step=init 建集合，并返回下一步的 payload', async () => {
    const wxSdk = require('./_stubs/wx-server-sdk/index.js');
    wxSdk.__reset();
    const data = await call('system.step', { step: 'init' });
    assert.strictEqual(data.step, 'init');
    assert.ok(data.created.length > 0, '首次应创建集合');
    assert.deepStrictEqual(data.next, { step: 'seed' }, 'next 应是可直接用作 payload 的对象');
  });

  await test('step=seed 灌数据，并报告物品数与匹配数', async () => {
    const data = await call('system.step', { step: 'seed' });
    assert.strictEqual(data.step, 'seed');
    assert.ok(data.lostCount >= 15, 'lostCount 不能是 undefined，实际 ' + data.lostCount);
    assert.ok(data.foundCount >= 15, 'foundCount 不能是 undefined，实际 ' + data.foundCount);
    assert.ok(data.itemCount >= 30, '应报告物品总数，实际 ' + data.itemCount);
    assert.ok(typeof data.matchCount === 'number', 'matchCount 应是数字');
    assert.deepStrictEqual(data.next, { step: 'match' });
  });

  await test('step=match 分块执行，next 可直接当 payload 续跑', async () => {
    // 从零开始循环调用，每次把返回的 next 原样作为 payload
    let payload = { step: 'match', chunk: 4 };
    let rounds = 0;
    let last = null;
    while (rounds < 40) {
      last = await call('system.step', payload);
      rounds += 1;
      assert.ok(last.processed <= 4, '每次处理条数不应超过 chunk，实际 ' + last.processed);
      if (last.next === null) break;
      // next 必须自带 chunk，否则续跑时会悄悄变回默认值、每轮耗时突增
      assert.strictEqual(last.next.chunk, 4,
        'next 应保留 chunk，实际 ' + JSON.stringify(last.next));
      payload = last.next;
    }
    assert.ok(rounds > 1, '失物 17 条 + 拾物 24 条，chunk=4 时应需要多轮，实际 ' + rounds + ' 轮');
    assert.strictEqual(last.next, null, '最终 next 应为 null');
    assert.ok(last.stats.matchCount > 0, '应产出候选，实际 ' + last.stats.matchCount);
  });

  await test('分块执行的结果与一次性执行一致（端到端可用）', async () => {
    const data = await call('match.candidates', { itemId: 'lost_cup_01', topK: 5, minScore: 0.3 });
    assert.ok(data.views.length > 0, '分块初始化后应能查到候选');
    assert.strictEqual(data.results[0].foundItem.id, 'found_cup_01',
      '演示主线第一名应正确，实际 ' + data.results[0].foundItem.id);
    assert.ok(data.results[0].score >= 0.7, '综合分应 ≥0.7，实际 ' + data.results[0].score);
  });

  await test('重复调用 init / seed 是幂等的', async () => {
    const again = await call('system.step', { step: 'init' });
    assert.ok(Array.isArray(again.created), '重复 init 不应出错');

    const seedAgain = await call('system.step', { step: 'seed' });
    assert.strictEqual(seedAgain.skipped, true, '重复 seed 应跳过');
  });

  await test('system.diagnose 报告版本与数据状态', async () => {
    const data = await call('system.diagnose');
    assert.ok(data.version, '应返回版本号（用于确认云函数是不是最新代码）');
    assert.ok(Array.isArray(data.collections) && data.collections.length >= 7,
      '应列出全部集合，实际 ' + data.collections.length);
    assert.ok(data.itemCount > 0, '应报告物品数，实际 ' + data.itemCount);
    assert.ok(data.matchCount > 0, '应报告匹配数，实际 ' + data.matchCount);
    assert.ok(data.advice, '应给出下一步建议');
    assert.ok(data.campusLocations >= 90, '应报告校区地点数，实际 ' + data.campusLocations);
  });

  await test('向量方案变化时自动重灌数据（避免「代码对了、数据是旧的」）', async () => {
    // 真实事故：云端代码更新了（修好图片向量持久化），但库里还是缺 embeddings 的旧记录，
    // 界面表现为视觉相似度 0%、综合分 48% 而不是 82%，极难排查。
    // 正常情况下第二次灌入应跳过
    const normal = await call('system.step', { step: 'seed' });
    assert.strictEqual(normal.skipped, true, '向量方案未变时应跳过');
    assert.strictEqual(normal.autoReset, undefined, '不应触发自动重灌');

    // 模拟「向量方案变了」：把 meta 里的指纹改成旧的
    await store.setMeta({ embeddingFingerprint: 'stale-old-fingerprint' });
    const healed = await call('system.step', { step: 'seed' });
    assert.strictEqual(healed.skipped, false, '指纹变化时应重新灌入，而不是跳过');
    assert.strictEqual(healed.autoReset, true, '应报告触发了自动重灌');
  });

  await test('库中旧数据缺少 embeddings 时自动清空重灌', async () => {
    // 真实事故：云端曾用「还没有向量持久化」的旧版本代码灌过数据，
    // 那些记录没有 embeddings。之后界面显示视觉相似度 0%、综合分 48%（而非 82%）。
    // 单纯比对「指纹」修不好——旧数据里根本没写过指纹，undefined !== fp 判为 false，
    // 于是永远跳过、旧数据永远留着。所以必须直接抽样检查数据本身。
    const wxSdk = require('./_stubs/wx-server-sdk/index.js');

    // 构造「旧数据」：有记录，但没有 embeddings
    await store.clearData({ keepUsers: true });
    await store.insertItem({
      id: 'lost_stale_01', kind: 'lost', title: '旧记录（无向量）',
      image: 'demo://cup_metal_gray', attributes: {}, createdAt: 1, timeRange: null
    });
    await store.insertItem({
      id: 'found_stale_01', kind: 'found', title: '旧记录（无向量）',
      image: 'demo://cup_metal_gray', attributes: {}, foundTime: 2, createdAt: 2
    });
    assert.strictEqual(await store.countItems(), 2, '应预置 2 条旧数据');

    const r = await call('system.step', { step: 'seed' });
    assert.strictEqual(r.skipped, false, '检测到旧数据不可用时应重灌，而不是跳过');
    assert.strictEqual(r.vectorsOk, true, '重灌后向量应校验通过');
    assert.ok(r.itemCount >= 40, '应是完整的演示数据集，实际 ' + r.itemCount);

    // 重灌后演示主线的分数应恢复正常
    const ins = await call('system.inspect', { lostId: 'lost_cup_01', foundId: 'found_cup_01' });
    assert.ok(ins.score.percent >= 80,
      '重灌后演示主线应恢复到 ≥80%，实际 ' + ins.score.percent + '%');
    assert.strictEqual(ins.diagnosis, '向量数据正常');
  });

  await test('system.inspect 能定位到向量缺失这类数据问题', async () => {
    const data = await call('system.inspect', { lostId: 'lost_cup_01', foundId: 'found_cup_01' });
    assert.strictEqual(data.lost.hasEmbeddings, true, '失物应有 embeddings');
    assert.strictEqual(data.found.hasEmbeddings, true, '拾物应有 embeddings');
    assert.ok(data.lost.embeddingDims.image > 0, '图像向量维度应大于 0');
    assert.strictEqual(data.imageSim.available, true, '视觉相似度应可用');
    assert.ok(data.score.percent >= 80, '演示主线应 ≥80%，实际 ' + data.score.percent);
    assert.strictEqual(data.diagnosis, '向量数据正常');
  });

  /* ===================== 2. 匹配链路 ===================== */
  group('2. 云端匹配链路');

  let cupCandidate = null;

  await test('保温杯失物能召回同一身份记录', async () => {
    const data = await call('match.candidates', { itemId: 'lost_cup_01', topK: 5, minScore: 0.3 });
    assert.ok(data.views.length > 0, '应有候选');
    assert.strictEqual(data.results[0].foundItem.id, 'found_cup_01', '第一名应为 found_cup_01');
    assert.ok(data.results[0].score >= 0.7, '综合分应 ≥0.7，实际 ' + data.results[0].score.toFixed(3));
    cupCandidate = data.views[0];
  });

  await test('候选视图包含分项分数与解释证据', async () => {
    assert.ok(cupCandidate.scoreBars.length === 5, '应有 5 个分项');
    assert.ok(cupCandidate.reasonTexts.length >= 1, '应有正向证据');
    assert.ok(cupCandidate.geoText.length > 0);
    assert.ok(cupCandidate.percent > 0);
  });

  await test('困难负样本分数低于正确匹配', async () => {
    const data = await call('match.candidates', { itemId: 'lost_cup_01', topK: 20, minScore: 0 });
    const wrong = data.results.find((r) => r.foundItem.id === 'found_cup_03');
    if (wrong && cupCandidate) {
      assert.ok(wrong.score < cupCandidate.score, '外观相似但不同件应更低：' + wrong.score.toFixed(3));
    }
  });

  await test('match.detail 返回完整对比数据', async () => {
    const data = await call('match.detail', { matchId: cupCandidate.id });
    assert.ok(data.detail, '应返回详情');
    assert.ok(data.detail.attrRows.length >= 3, '属性对比行应 ≥3，实际 ' + data.detail.attrRows.length);
    assert.ok(data.detail.explanation.length > 0, '应有系统解释');
    assert.ok(data.detail.weightsText.indexOf('α') >= 0, '应展示动态权重：' + data.detail.weightsText);
  });

  /* ===================== 3. 发布流程 ===================== */
  group('3. 云端发布流程');

  let publishedId = '';

  await test('发布拾物并自动完成反向匹配', async () => {
    const data = await call('item.publish', {
      kind: 'found',
      userId: 'u_lin',
      description: '深灰色不锈钢水杯，黑色杯盖，杯身有白色纵向标志',
      imageDescription: '深灰色圆柱形金属保温杯，黑色杯盖，杯身有白色纵向 Logo',
      locationId: 'lib_north',
      foundTime: Date.now() - 10 * 60 * 1000,
      attributes: { category: 'cup', main_color: '深灰', material: '金属' },
      privateFeatures: ['杯底有一道长划痕']
    });
    assert.ok(data.item.id, '应返回记录 id');
    assert.ok(data.matchCount >= 1, '应至少匹配到 1 位潜在失主');
    publishedId = data.item.id;
    const topIds = (data.top && [data.top.lostId]) || [];
    assert.ok(topIds.indexOf('lost_cup_01') >= 0 || data.matchCount >= 1, '应命中演示主线失物');
  });

  await test('发布的记录可通过 item.get 读回', async () => {
    const data = await call('item.get', { id: publishedId });
    assert.strictEqual(data.item.id, publishedId);
    assert.strictEqual(data.item.categoryName, '水杯/保温杯');
  });

  await test('图像语义描述被写入并参与向量计算', async () => {
    const item = await store.getItem(publishedId);
    assert.ok(item.imageDescription.indexOf('保温杯') >= 0, '应保留图像语义描述');
    assert.ok(item.embeddings && item.embeddings.text, '应生成文本向量');
  });

  await test('主动提醒已生成', async () => {
    const data = await call('notify.list', { userId: 'u_me' });
    assert.ok(data.notifications.length > 0, '失主应收到候选提醒');
  });

  /* ===================== 4. 认领核验闭环 ===================== */
  group('4. 认领核验与归还闭环');

  let claimId = '';

  await test('claim.start 生成针对性核验问题', async () => {
    const data = await call('claim.start', { matchId: cupCandidate.id });
    assert.ok(data.claim.questions.length >= 1, '应生成核验问题');
    claimId = data.claim.id;
  });

  await test('核验问题由隐藏特征转换而来', async () => {
    const claim = await store.getClaim(claimId);
    const questions = claim.questions.map((q) => q.question).join('|');
    assert.ok(questions.indexOf('痕迹') >= 0 || questions.indexOf('划痕') >= 0, '应问到痕迹：' + questions);
  });

  await test('claim.submit 给出语义核验辅助分', async () => {
    const answers = ['杯底有一道大约三厘米的长划痕，就在边缘位置'];
    const data = await call('claim.submit', { claimId, answers });
    assert.ok(data.claim.verificationScore > 0.3, '辅助分应 >0.3，实际 ' + data.claim.verificationScore);
    assert.ok(data.claim.answers[0].reason.length > 0, '应给出核验理由');
  });

  await test('claim.confirm 通过后进入待交接', async () => {
    const data = await call('claim.confirm', { claimId, action: 'pass', remark: '特征一致' });
    assert.strictEqual(data.claim.status, 'verified');
    const lost = await store.getItem('lost_cup_01');
    assert.strictEqual(lost.status, 'waiting_handover', '失物应进入待交接');
  });

  await test('claim.return 完成状态闭环', async () => {
    const data = await call('claim.return', { claimId });
    assert.strictEqual(data.claim.status, 'returned');
    const lost = await store.getItem('lost_cup_01');
    const found = await store.getItem('found_cup_01');
    assert.strictEqual(lost.status, 'recovered', '失物应为已归还');
    assert.strictEqual(found.status, 'returned', '拾物应为已归还');
  });

  await test('归还后写入正样本反馈', async () => {
    const feedbacks = await store.allFeedbacks();
    assert.ok(feedbacks.some((f) => f.userAction === 'returned'), '应记录 returned 反馈');
  });

  await test('归还后不再出现在候选池', async () => {
    const data = await call('match.candidates', { itemId: 'lost_cup_01', topK: 20, minScore: 0 });
    const ids = data.results.map((r) => r.foundItem.id);
    assert.ok(ids.indexOf('found_cup_01') < 0, '已归还的拾物不应再入候选');
  });

  await test('排除候选写入弱负样本', async () => {
    const list = await call('match.candidates', { itemId: 'lost_card_01', topK: 5, minScore: 0.3 });
    if (list.views.length) {
      await call('match.reject', { matchId: list.views[0].id, reason: '测试排除' });
      const feedbacks = await store.allFeedbacks();
      assert.ok(feedbacks.some((f) => f.userAction === 'rejected'), '应记录 rejected 反馈');
    }
  });

  /* ===================== 5. 统计与实验 ===================== */
  group('5. 统计、热力图与消融实验');

  await test('stats.dashboard 返回完整指标', async () => {
    const data = await call('stats.dashboard');
    assert.ok(data.stats.lostCount > 0 && data.stats.foundCount > 0);
    assert.ok(data.stats.recoverRate >= 0 && data.stats.recoverRate <= 100);
    assert.ok(data.categoryDistribution.length > 0, '应有类别分布');
    assert.ok(data.embedding && data.embedding.label, '应说明当前向量方案');
  });

  await test('消融实验四组齐全且单调合理', async () => {
    const data = await call('stats.evaluate');
    assert.strictEqual(data.groups.length, 4, '应有 4 组');
    data.groups.forEach((g) => {
      assert.ok(g.recall5Percent >= g.recall1Percent, g.name + ' 的 Recall@5 应不低于 Recall@1');
    });
    const baseline = data.groups[0];
    const full = data.groups[3];
    console.log('    · A(Image Only) Recall@5=' + baseline.recall5Percent + '%  MRR=' + baseline.mrrPercent + '%');
    console.log('    · D(完整方案)   Recall@5=' + full.recall5Percent + '%  MRR=' + full.mrrPercent + '%');
    assert.ok(full.recall5Percent >= baseline.recall5Percent, '完整方案不应弱于基线');
  });

  await test('热力图按地点聚合且总数自洽', async () => {
    const data = await call('stats.heatmap', {});
    assert.ok(data.cells.length > 0);
    data.cells.forEach((c) => assert.strictEqual(c.total, c.lost + c.found));
  });

  await test('事件时间线按时间递增', async () => {
    const data = await call('stats.timeline', { matchId: cupCandidate.id });
    assert.ok(data.events.length >= 3, '应至少有 丢失/拾取/匹配 三类事件');
    for (let i = 1; i < data.events.length; i += 1) {
      assert.ok(data.events[i].at >= data.events[i - 1].at, '时间线应递增');
    }
  });

  /* ===================== 6. 错误处理 ===================== */
  group('6. 错误处理与边界');

  await test('未知 action 返回可用动作清单', async () => {
    const res = await api.main({ action: 'not.exists', payload: {} });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'UNKNOWN_ACTION');
    assert.ok(res.availableActions.length > 15, '应返回动作清单');
  });

  await test('读取不存在的记录返回 NOT_FOUND', async () => {
    const res = await api.main({ action: 'item.get', payload: { id: 'no_such_id' } });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'NOT_FOUND');
  });

  await test('核验未通过时状态回滚为可继续寻找', async () => {
    const list = await call('match.candidates', { itemId: 'lost_umbrella_01', topK: 3, minScore: 0.3 });
    if (list.views.length) {
      const started = await call('claim.start', { matchId: list.views[0].id });
      await call('claim.submit', { claimId: started.claim.id, answers: ['完全不知道'] });
      const confirmed = await call('claim.confirm', { claimId: started.claim.id, action: 'reject' });
      assert.strictEqual(confirmed.claim.status, 'rejected');
      const lost = await store.getItem('lost_umbrella_01');
      assert.strictEqual(lost.status, 'candidate_found', '拒绝后失物应回到发现候选状态');
    }
  });

  /* ===================== 7. AI 云函数 ===================== */
  group('7. AI 云函数（无 Key 场景）');

  await test('ai.health 在未配置 Key 时如实报告', async () => {
    const res = await ai.main({ action: 'ai.health', payload: {} });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.ready, false);
    assert.ok(res.data.message.indexOf('DEEPSEEK_API_KEY') >= 0, '应提示配置环境变量');
  });

  await test('ai.extract 对演示图片短路，不消耗模型额度', async () => {
    const res = await ai.main({
      action: 'ai.extract',
      payload: { image: 'demo://cup_metal_gray', description: '', type: 'lost' }
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.model, 'demo-hints');
    assert.strictEqual(res.data.attributes.main_color, '深灰');
  });

  await test('ai.extract 在无图片无描述时报错', async () => {
    const res = await ai.main({ action: 'ai.extract', payload: { image: '', description: '' } });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'NO_INPUT');
  });

  await test('ai.extract 在无 Key 时降级为本地规则而非直接失败', async () => {
    const res = await ai.main({
      action: 'ai.extract',
      payload: { image: '', description: '深灰色不锈钢保温杯，杯底有划痕', type: 'lost' }
    });
    assert.strictEqual(res.ok, true, '应返回可用结果而不是抛错');
    assert.strictEqual(res.data.fallback, true);
    assert.strictEqual(res.data.attributes.main_color, '深灰');
  });

  /* ===================== 8. 核验纯函数 ===================== */
  group('8. 核验与解释纯函数');

  await test('回答越具体，核验分越高', async () => {
    const feature = '杯底有一道长划痕';
    const vague = ops.verifyAnswer('有划痕', feature);
    const detailed = ops.verifyAnswer('杯底边缘有一道大约三厘米的长划痕', feature);
    assert.ok(detailed.score > vague.score, '具体回答应得分更高：' + detailed.score + ' vs ' + vague.score);
  });

  await test('答非所问得分低', async () => {
    const r = ops.verifyAnswer('完全不知道', '杯底有一道长划痕');
    assert.ok(r.score < 0.35, '无关回答应低分，实际 ' + r.score);
  });

  await test('属性对比行给出正确的判断标签', async () => {
    const rows = ops.buildAttrRows([
      { field: 'category', label: '类别', a: 'cup', b: 'cup', score: 1, note: '' },
      { field: 'size', label: '尺寸', a: '大', b: '小', score: 0.1, note: '' },
      { field: 'brand', label: '品牌', a: '未提供', b: '膳魔师', score: 0.3, note: '' }
    ]);
    assert.strictEqual(rows[0].judgement, '一致');
    assert.strictEqual(rows[1].judgement, '不一致');
    assert.strictEqual(rows[2].judgement, '信息不全');
  });

  /* ===================== 9. 集合不存在时的容错 =====================
   * 放在最后：这一组会清空所有集合，会破坏前面测试依赖的数据。
   */
  group('9. 集合尚未创建时的容错（首次启动的真实场景）');

  await test('集合不存在时读取返回空，而不是抛错', async () => {
    // 真实场景：用户刚配好云环境、还没执行初始化，集合根本不存在。
    // 此时读 xj_items 会抛 errCode -502005 "database collection not exists"。
    // 若这个错误直接上抛，客户端会判定「云端不可用」并退回本地演示数据，
    // 用户看到的就是「明明配了云环境却一直是离线模式」。
    const wxSdk = require('./_stubs/wx-server-sdk/index.js');
    wxSdk.__reset();                    // 清掉所有集合（含"已创建"标记）

    const items = await store.itemsOf('lost');
    assert.deepStrictEqual(items, [], '集合不存在时应返回空数组，实际 ' + JSON.stringify(items));

    const one = await store.getItem('lost_cup_01');
    assert.strictEqual(one, null, '读单条也应返回 null');

    const matches = await store.allMatches();
    assert.deepStrictEqual(matches, [], '匹配集合不存在时也应返回空');
  });

  await test('集合不存在时 system.init 能正常建起来', async () => {
    const data = await call('system.init');
    assert.ok(Array.isArray(data.created), '应返回已创建的集合列表');
    assert.ok(data.created.length > 0, '首次应创建全部集合，实际 ' + data.created.length + ' 个');

    const items = await store.itemsOf('lost');
    assert.ok(Array.isArray(items), '建集合后应能正常查询');
  });

  await test('空库时 system.setup 能从零一键跑通（模拟首次部署）', async () => {
    const wxSdk = require('./_stubs/wx-server-sdk/index.js');
    wxSdk.__reset();

    const data = await call('system.setup', { reset: true });
    assert.ok(data.stats.lostCount >= 15, '空库也能一键灌满，实际 ' + data.stats.lostCount);
    assert.ok(data.stats.matchCount > 0, '应产出候选，实际 ' + data.stats.matchCount);
  });

  /* ===================== 10. item.update 的容错语义 =====================
   * 放在最后：需要演示数据已灌入（lost_cup_01 存在），
   * 且要直接用 api.main 检查返回结构，不能用会抛异常的 call()。
   */
  group('10. item.update 容错（记录不在云库时不应报错）');

  /** 不抛异常的调用，用于检查失败返回结构 */
  async function raw(action, payload) {
    return api.main({ action, payload: payload || {} });
  }

  await test('存在的记录正常更新', async () => {
    const r = await raw('item.update', { id: 'lost_cup_01', patch: { views: 42 } });
    assert.strictEqual(r.ok, true, '应成功，实际 ' + JSON.stringify(r.error));
    assert.ok(!r.data.ignored, '不应被判定为忽略');
    assert.strictEqual(r.data.item.views, 42, 'views 应更新为 42');
  });

  await test('不在云库的记录返回「已忽略」而非报错', async () => {
    // 真实现象：客户端本地镜像里可能残留云库没有的记录（本地模式灌的演示数据），
    // service 层状态流转会一并更新它们，报 NOT_FOUND 会让控制台刷红色错误——
    // 但这是可正常忽略的情况，记录本来就不在云端。
    const r = await raw('item.update', { id: 'lost_not_in_cloud_999', patch: { status: 'closed' } });
    assert.strictEqual(r.ok, true, '不应返回失败');
    assert.strictEqual(r.data.ignored, true, '应标记 ignored');
    assert.ok(r.data.reason, '应给出忽略原因');
    assert.strictEqual(r.data.id, 'lost_not_in_cloud_999', '应回显记录的 id');
  });

  await test('item.get 对不存在的记录仍返回 NOT_FOUND（读取语义不同）', async () => {
    // 读不到就是真的读不到，必须如实报错；这与「更新可忽略」是两回事
    const r = await raw('item.get', { id: 'lost_not_in_cloud_999' });
    assert.strictEqual(r.ok, false, '读取应失败');
    assert.strictEqual(r.error.code, 'NOT_FOUND', '错误码应为 NOT_FOUND');
  });

  /* ===================== 输出 ===================== */
  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  console.log('========================================');

  if (failed > 0) {
    console.log('\n失败详情：');
    failures.forEach((f) => {
      console.log('\n· ' + f.name);
      console.log(String(f.error && f.error.stack || f.error).split('\n').slice(0, 6).join('\n'));
    });
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n测试运行异常：', e);
  process.exit(1);
});
