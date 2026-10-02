/**
 * 云函数 xj-api：统一业务网关
 * ---------------------------------------------------------------
 * 小程序端所有数据读写都走这里，客户端不直接操作数据库，便于统一鉴权与校验。
 *
 * 调用方式（小程序端）：
 *   wx.cloud.callFunction({ name: 'xj-api', data: { action: 'item.list', payload: {...} } })
 *
 * 返回格式统一为：
 *   { ok: true, data: ... }  或  { ok: false, error: { message, code } }
 *
 * action 一览（与方案附录 A 的接口设计一一对应）：
 *   system.init          初始化集合与元信息（部署后调用一次）
 *   seed.demo            灌入演示数据（reset: true 可重置）
 *   user.me              当前用户信息（含未读提醒数）
 *   user.switch          切换演示身份（仅演示用）
 *   item.publish         发布失物/拾物（POST /items/lost | /items/found）
 *   item.get             记录详情
 *   item.list            记录列表（按类型/用户/类别筛选）
 *   item.update          更新记录（关闭、标记已归还等）
 *   item.remove          删除记录
 *   match.candidates     候选列表（POST /match/search）
 *   match.detail         候选详情（GET /match/{id}）
 *   match.all            全局候选流
 *   match.rerun          重新执行增量匹配
 *   match.reject         排除候选（写入弱负样本）
 *   claim.start          发起认领（POST /claim）
 *   claim.submit         提交核验回答
 *   claim.confirm        拾物者确认/拒绝（POST /claim/{id}/confirm）
 *   claim.return         完成归还
 *   claim.get            认领详情
 *   notify.list          通知列表（GET /notifications）
 *   notify.read          全部标记已读
 *   stats.dashboard      看板统计
 *   stats.heatmap        热力图数据
 *   stats.timeline       事件时间线
 *   stats.evaluate       消融实验
 *   config.get           返回服务端配置（地点库版本、向量方案说明等）
 */

const cloud = require('wx-server-sdk');
const store = require('./store');
const service = require('./service');
const aiEmbed = require('./core/ai/embed');
const locations = require('./core/locations');
const seedData = require('./core/seed-data');
const matcher = require('./core/matcher');
const vlm = require('./core/vlm');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * 校园地点库版本号：以 core/campus-data.js 的 META.version 为唯一来源。
 * 修改地点库后递增 META.version 即可，前端会据此提示需要重新做地点标准化。
 */
const CAMPUS_VERSION = require('./core/campus-data.js').META.version;

/** 当前登录用户：真实项目里应使用 cloud.getWXContext().OPENID 关联用户表 */
function currentUserId(event) {
  if (event && event.userId) return event.userId;
  return 'u_me';
}

function ok(data) {
  return { ok: true, data };
}

function fail(message, code) {
  return { ok: false, error: { message: String(message || '未知错误'), code: code || 'ERROR' } };
}

/** 两位补零（诊断输出用） */
function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/* ===================== action 实现 ===================== */

const handlers = {
  /* ---------- 系统与演示数据 ---------- */

  /**
   * 分步 + 分块初始化（专为「云函数 3 秒默认超时」设计）。
   *
   * 背景：
   *   微信云开发的云函数**默认超时只有 3 秒**。
   *   建 7 个集合 / 灌 41 条记录 / 跑 17×N 次匹配，任何一步做全量都可能超时，
   *   报错 -504003 Invoking task timed out。
   *
   * 所以：
   *   - init / seed 一步做完（都很快）
   *   - match 会**分块**执行，每次只处理 chunk 条，返回 next 让你继续调用
   *     直到 next === null 为止
   *
   * payload：
   *   { step: 'init' }                                建集合并写入 meta
   *   { step: 'seed', reset?: true }                  灌演示数据
   *   { step: 'match', phase?, offset?, chunk? }      分块跑匹配
   *   { step: 'all' }                                 一次做完（需把超时改到 60 秒）
   *
   * match 的用法（循环调用直到 next 为 null）：
   *   wx.cloud.callFunction({ name:'xj-api', data:{ action:'system.step',
   *     payload:{ step:'match' } } })
   *   // 返回 { done:false, next:{ step:'match', phase:'lost', offset:6 } }
   *   // 把 next 原样作为 payload 再调一次即可
   */
  'system.step': async (payload) => {
    const p = payload || {};
    const step = p.step || 'all';

    if (step === 'init') {
      const before = await store.ensureCollections();
      const meta = await store.setMeta({
        seedVersion: seedData.SEED_VERSION,
        campusVersion: CAMPUS_VERSION,
        embedding: aiEmbed.describe()
      });
      return ok({
        step: 'init',
        created: before,
        collections: store.COLLECTIONS,
        meta,
        next: { step: 'seed' },
        hint: before.length
          ? '新建了 ' + before.length + ' 个集合。下一步：seed'
          : '集合本来就已存在（无需新建）。下一步：seed'
      });
    }

    if (step === 'seed') {
      /**
       * 数据可用性由 service.seedDemo 自己判断：
       *   库里有数据、但抽样发现记录缺少 embeddings（旧版本代码灌的），
       *   它会自动清空重灌。
       *
       * 这里额外存一个「向量方案指纹」，用于以后比对方案是否变化。
       */
      const fingerprint = JSON.stringify(aiEmbed.describe());
      const metaBefore = await store.getMeta();
      const fingerprintChanged = !!(metaBefore && metaBefore.embeddingFingerprint &&
        metaBefore.embeddingFingerprint !== fingerprint);

      const result = await service.seedDemo({ reset: p.reset === true || fingerprintChanged });

      await store.setMeta({
        seedVersion: seedData.SEED_VERSION,
        campusVersion: CAMPUS_VERSION,
        embedding: aiEmbed.describe(),
        embeddingFingerprint: fingerprint,
        seededAt: Date.now()
      });

      const itemCount = await store.countItems();
      const stats = await service.stats();
      // 抽样确认向量确实写进去了
      const probe = await store.sampleItem();
      const vectorsOk = !!(probe && probe.embeddings && probe.embeddings.image);

      return ok({
        step: 'seed',
        lostCount: result.lostCount || 0,
        foundCount: result.foundCount || 0,
        skipped: !!result.skipped,
        autoReset: (fingerprintChanged || !vectorsOk) ? true : undefined,
        vectorsOk,
        itemCount,
        matchCount: stats.matchCount,
        next: { step: 'match' },
        hint: result.skipped
          ? '数据库已有可用数据，未重复灌入（' + result.message + '）。下一步：match'
          : ('已灌入 ' + (result.lostCount || 0) + ' 条失物 / ' + (result.foundCount || 0) +
            ' 条拾物' + (vectorsOk ? '，向量已写入' : '，但向量校验未通过') + '。下一步：match')
      });
    }

    if (step === 'match') {
      const chunk = Number(p.chunk) > 0 ? Number(p.chunk) : 6;
      const phase = p.phase === 'found' ? 'found' : (p.phase === 'lost' ? 'lost' : null);
      const offset = Number(p.offset) > 0 ? Number(p.offset) : 0;

      /**
       * next 里带上 chunk，是为了让调用方把 next 原样当 payload 传回来。
       * 否则 chunk 会在第二轮丢回默认值（对方以为还是自己指定的 4，其实是 6），
       * 每轮耗时就会突然变长——正是这个 3 秒超时要避免的事。
       */
      const withChunk = (next) => (next === null ? null : Object.assign({ chunk }, next));

      // 未指定 phase：从 lost 开始
      if (!phase) {
        const r = await service.matchLostChunk(0, chunk);
        return ok({
          step: 'match',
          phase: 'lost',
          processed: r.processed,
          created: r.created,
          total: r.total,
          next: withChunk(r.nextOffset === null
            ? { step: 'match', phase: 'found', offset: 0 }
            : { step: 'match', phase: 'lost', offset: r.nextOffset }),
          hint: '失物匹配进行中（共 ' + r.total + ' 条待处理）'
        });
      }

      if (phase === 'lost') {
        const r = await service.matchLostChunk(offset, chunk);
        return ok({
          step: 'match',
          phase: 'lost',
          processed: r.processed,
          created: r.created,
          total: r.total,
          next: withChunk(r.nextOffset === null
            ? { step: 'match', phase: 'found', offset: 0 }
            : { step: 'match', phase: 'lost', offset: r.nextOffset }),
          hint: '失物匹配进行中'
        });
      }

      // phase === 'found'
      const r = await service.matchFoundChunk(offset, chunk);
      if (r.nextOffset !== null) {
        return ok({
          step: 'match',
          phase: 'found',
          processed: r.processed,
          total: r.total,
          next: withChunk({ step: 'match', phase: 'found', offset: r.nextOffset }),
          hint: '拾物反向匹配进行中'
        });
      }

      // 全部完成
      const stats = await service.stats();
      return ok({
        step: 'match',
        phase: 'found',
        processed: r.processed,
        total: r.total,
        stats,
        next: null,
        hint: '匹配全部完成，候选 ' + stats.matchCount + ' 条'
      });
    }

    // step === 'all'：一次做完（需要把云函数超时改到 60 秒）
    const steps = [];
    const created = await store.ensureCollections();
    steps.push({ step: '建集合', created });

    const seedResult = await service.seedDemo({ reset: p.reset === true });
    steps.push({
      step: '灌演示数据',
      skipped: !!seedResult.skipped,
      lostCount: seedResult.lostCount,
      foundCount: seedResult.foundCount
    });

    const matched = await service.incrementalMatch();
    steps.push({ step: '跑匹配', created: matched.created });

    return ok({
      step: 'all',
      steps,
      stats: await service.stats(),
      embedding: aiEmbed.describe(),
      next: null
    });
  },

  /**
   * 一键初始化：建集合 → 灌演示数据 → 补跑匹配 → 返回统计
   *
   * ⚠ 需要把云函数超时改到 **60 秒**，否则会报 -504003 超时。
   *   云开发控制台 → 云函数 → xj-api → 版本与配置 → 配置 → 高级配置 → 超时时间。
   *   如果不想改超时，请改用 `system.step` 分步执行（见上）。
   */
  'system.setup': async (payload) => {
    const p = payload || {};
    const steps = [];

    const created = await store.ensureCollections();
    steps.push({ step: '建集合', created });

    const seedResult = await service.seedDemo({ reset: p.reset === true });
    steps.push({
      step: '灌演示数据',
      skipped: !!seedResult.skipped,
      lostCount: seedResult.lostCount,
      foundCount: seedResult.foundCount
    });

    // 无论刚灌的还是本来就有，都补跑一次匹配，保证候选列表非空
    const matched = await service.incrementalMatch();
    steps.push({ step: '补跑匹配', ...matched });

    return ok({
      steps,
      stats: await service.stats(),
      embedding: aiEmbed.describe()
    });
  },

  'system.init': async () => {
    const created = await store.ensureCollections();
    const meta = await store.setMeta({
      seedVersion: seedData.SEED_VERSION,
      campusVersion: CAMPUS_VERSION,
      embedding: aiEmbed.describe()
    });
    return ok({ created, meta, collections: store.COLLECTIONS });
  },

  /**
   * 灌入演示数据。
   * 幂等：已有数据时不再重复插入。
   * 自愈：如果检测到「有物品记录但没有任何匹配」，说明上次灌入在中途被打断
   *      （例如客户端 20 秒超时），这里自动补跑一次匹配，避免停在半成品状态。
   */
  'seed.demo': async (payload) => {
    const result = await service.seedDemo({ reset: !!(payload && payload.reset) });

    let healed = null;
    const itemCount = await store.countItems();
    const matchCount = (await store.allMatches()).length;
    if (itemCount > 0 && matchCount === 0) {
      healed = await service.incrementalMatch();
    }

    return ok(Object.assign({}, result, {
      itemCount,
      matchCount: matchCount + (healed ? healed.created : 0),
      healed,
      hint: result.skipped && matchCount > 0
        ? '数据库中已有数据，未重复灌入。如需重置请传 reset: true'
        : undefined
    }));
  },

  /**
   * 诊断：一次性报告云函数版本与当前数据状态。
   *
   * 用途：排查「云函数是不是最新代码」「数据到哪一步了」这类问题。
   *   返回 version 是代码版本标记，每次有结构性改动都要递增。
   */
  'system.diagnose': async () => {
    // store.COLLECTIONS 是 { items: 'xj_items', ... } 映射，这里转成物理集合名
    const physical = Object.keys(store.COLLECTIONS).map((k) => store.COLLECTIONS[k]);
    const status = [];
    for (let i = 0; i < physical.length; i += 1) {
      const name = physical[i];
      let count = 0;
      let exists = true;
      try {
        const res = await store.db().collection(name).count();
        count = res.total || 0;
      } catch (e) {
        if (store.isCollectionNotExist && store.isCollectionNotExist(e)) {
          exists = false;
          count = 0;
        } else {
          count = -1;
        }
      }
      status.push({ name, exists, count });
    }

    let itemCount = 0;
    let matchCount = 0;
    try { itemCount = await store.countItems(); } catch (e) { itemCount = 0; }
    try { matchCount = (await store.allMatches()).length; } catch (e) { matchCount = 0; }

    /**
     * 时区诊断。
     *
     * 为什么需要：云函数运行环境的时区不一定是 UTC+8。
     * 若云端按 UTC 执行 new Date().setHours(18,42)，生成的时间戳
     * 在小程序端（UTC+8）显示就是次日 02:42 —— 演示数据的时间会整体偏移 8 小时。
     * 这里把云端时区如实报出来，用于确认这类偏移。
     */
    const now = new Date();
    const tz = {
      offsetMinutes: now.getTimezoneOffset(),
      utcOffsetText: (now.getTimezoneOffset() <= 0 ? '+' : '-') +
        Math.abs(now.getTimezoneOffset() / 60) + ':00',
      envTZ: (typeof process !== 'undefined' && process.env && process.env.TZ) || '(未设置)',
      localNow: now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) +
        ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()),
      utcNow: now.toISOString(),
      isUtc8: now.getTimezoneOffset() === -480
    };

    return ok({
      version: '2026-10-02-1930',
      stepApi: 'system.step（init / seed / match 分块）',
      seedVersion: seedData.SEED_VERSION,
      campusVersion: CAMPUS_VERSION,
      campusLocations: locations.list().length,
      embedding: aiEmbed.describe(),
      collections: status,
      itemCount,
      matchCount,
      timezone: tz,
      timezoneWarning: tz.isUtc8
        ? null
        : ('云函数时区不是 UTC+8（当前 ' + tz.utcOffsetText +
          '），演示数据的时间会整体偏移，界面显示的日期可能不正确'),
      advice: itemCount === 0
        ? '还没有数据，请先执行 system.step { step:"seed" }'
        : (matchCount === 0
          ? '有记录但没有匹配，请循环执行 system.step { step:"match" } 直到 next 为 null'
          : '数据与匹配均已就绪')
    });
  },

  /**
   * 诊断指定候选对：把两条记录的关键字段与五路分项全部摊开。
   *
   * 用途：当界面显示的分数与预期不符时，用它确认「数据库里到底存了什么」。
   *   例如演示主线本该 ~82%，若显示 48%，看这里就能知道是
   *   embeddings 缺失、还是时间范围丢失。
   *
   * payload: { lostId, foundId }
   */
  'system.inspect': async (payload) => {
    const lostId = (payload && payload.lostId) || 'lost_cup_01';
    const foundId = (payload && payload.foundId) || 'found_cup_01';
    const lost = await store.getItem(lostId);
    const found = await store.getItem(foundId);
    if (!lost || !found) {
      return fail('记录不存在：' + lostId + ' / ' + foundId, 'NOT_FOUND');
    }

    const brief = (it) => ({
      id: it.id,
      kind: it.kind,
      title: it.title,
      image: it.image,
      hasEmbeddings: !!it.embeddings,
      embeddingDims: it.embeddings ? {
        text: it.embeddings.text ? it.embeddings.text.length : null,
        image: it.embeddings.image ? it.embeddings.image.length : null,
        imageDesc: it.embeddings.imageDesc ? it.embeddings.imageDesc.length : null
      } : null,
      timeRange: it.timeRange || null,
      foundTime: it.foundTime || null,
      foundTimeText: it.foundTime ? new Date(it.foundTime).toISOString() : null,
      locationId: it.location ? it.location.id : null,
      attributeKeys: Object.keys(it.attributes || {}),
      updatedAt: it.updatedAt || null
    });

    const detail = matcher.scorePair(lost, found);
    const sim = vlm.imageSimilarity(lost, found);
    const tScore = matcher.timeScore(lost, found);

    return ok({
      version: '2026-10-02-1700',
      lost: brief(lost),
      found: brief(found),
      score: {
        total: detail.score,
        percent: Math.round(detail.score * 100),
        scores: detail.scores,
        weights: detail.weights,
        available: detail.available
      },
      imageSim: sim,
      timeScore: {
        available: tScore.available,
        score: tScore.score,
        deltaText: tScore.deltaText || null
      },
      diagnosis: (!lost.embeddings || !found.embeddings)
        ? '记录缺少 embeddings 字段 → 视觉相似度会判为不可用（0%）。' +
          '请在云函数端用 seed 的 reset:true 重新灌入数据'
        : ((!sim.available)
          ? 'embeddings 存在但 imageSimilarity 判为不可用，需检查 embeddings.image / imageDesc'
          : '向量数据正常')
    });
  },

  'config.get': async () => ok({
    seedVersion: seedData.SEED_VERSION,
    campusVersion: CAMPUS_VERSION,
    locations: locations.list(),
    embedding: aiEmbed.describe(),
    categories: require('./core/categories').list().map((c) => ({ key: c.key, name: c.name, icon: c.icon }))
  }),

  /* ---------- 用户 ---------- */
  'user.me': async (payload, ctx) => {
    await store.ensureUsers(seedData.DEMO_USERS);
    const userId = currentUserId({ userId: payload && payload.userId }) || ctx.userId;
    const me = await store.user(userId);
    return ok({
      user: me,
      unread: await store.unreadCount(userId),
      users: (await store.users()).filter((u) => u.role !== 'admin')
    });
  },

  'user.switch': async (payload) => ok({ userId: payload && payload.userId }),

  /* ---------- 物品 ---------- */
  'item.publish': async (payload, ctx) => {
    const data = Object.assign({}, payload || {}, { userId: (payload && payload.userId) || ctx.userId });
    const result = await service.publish(data, { aiResult: payload && payload.aiResult });
    return ok(result);
  },

  'item.get': async (payload) => {
    const item = await store.getItem(payload && payload.id);
    if (!item) return fail('记录不存在', 'NOT_FOUND');
    return ok({ item: await service.viewItem(item) });
  },

  /**
   * 物品列表。
   *
   * 默认返回「客户端实体文档」（service.toClientEntity）：含 embeddings、timeRange、
   * 原始 location 等计算所需字段，供客户端镜像后本地重算匹配。
   *
   * 为什么不能只返回展示视图（历史 bug）：
   *   客户端镜像若由展示视图重建，会丢失向量与时间范围，
   *   导致详细对比页本地重算出 48% 而不是云端的 82%。
   *
   * 需要纯展示数据时传 { view: true }。
   */
  'item.list': async (payload, ctx) => {
    const p = payload || {};
    let list;
    if (p.userId) list = await store.itemsByUser(p.userId, p.kind);
    else list = await store.itemsOf(p.kind);
    if (p.category && p.category !== 'all') {
      list = list.filter((i) => (i.attributes || {}).category === p.category);
    }
    if (p.status && p.status !== 'all') list = list.filter((i) => i.status === p.status);
    list = list.sort((a, b) => b.createdAt - a.createdAt);
    if (p.limit) list = list.slice(0, p.limit);

    /**
     * 查看者必须是「谁在看」，而不是写死的默认用户。
     * 真实项目里应取 cloud.getWXContext().OPENID；
     * 这里允许 payload.viewerId 覆盖，方便前端演示切换用户。
     *
     * ⚠ 传错这个值会导致隐藏特征（认领核验的答案）泄露给非本人——
     *   测试 run-mirror.test.js 专门验证这一点。
     */
    const viewerId = p.viewerId || (p.userId ? p.userId : (ctx && ctx.userId)) || 'u_me';

    if (p.view === true) {
      const views = [];
      for (let i = 0; i < list.length; i += 1) views.push(await service.viewItem(list[i]));
      return ok({ items: views, total: views.length, format: 'view' });
    }

    const entities = list.map((it) => service.toClientEntity(it, viewerId));
    return ok({ items: entities, total: entities.length, format: 'entity', viewerId });
  },

  /**
   * 更新物品。
   *
   * ⚠ 记录不存在时返回「已忽略」而不是报错。
   *
   * 为什么：客户端的本地镜像里可能存在云库没有的记录
   *   （例如本地模式下灌的演示数据，之后切到云端模式）。
   *   service 层的状态流转（匹配后回写 status 等）会把这些记录也一起更新，
   *   于是报 NOT_FOUND，控制台刷出红色错误——但这是**可正常忽略的情况**：
   *   记录本来就不在云端，没什么可更新的。
   *
   *   当错误处理既污染日志，又会让用户以为功能坏了。
   */
  'item.update': async (payload) => {
    const p = payload || {};
    const item = await store.updateItem(p.id, p.patch || {});
    if (!item) {
      return ok({ ignored: true, reason: '记录不在云库中，已忽略本次更新', id: p.id });
    }
    return ok({ item: await service.viewItem(item) });
  },

  'item.remove': async (payload) => {
    await store.removeItem(payload && payload.id);
    return ok({ removed: true });
  },

  /* ---------- 匹配 ---------- */
  'match.candidates': async (payload, ctx) => {
    const p = payload || {};
    const userId = p.userId || ctx.userId;
    if (p.kind === 'found' && p.itemId) {
      return ok(await service.candidatesForFound(p.itemId, { topK: p.topK || 20, minScore: p.minScore }));
    }
    if (p.itemId) {
      return ok(await service.candidatesForLost(p.itemId, { topK: p.topK || 20, minScore: p.minScore }));
    }
    const list = await service.allCandidateViews({
      minScore: p.minScore || 0.3,
      mineOnly: !!p.mineOnly,
      userId,
      category: p.category
    });
    return ok({ views: list, total: list.length });
  },

  'match.detail': async (payload) => {
    const p = payload || {};
    const detail = await service.compareDetail(p.matchId, { lostId: p.lostId, foundId: p.foundId });
    if (!detail) return fail('候选不存在', 'NOT_FOUND');
    return ok({ detail });
  },

  'match.rerun': async () => ok(await service.incrementalMatch()),

  'match.all': async () => {
    const matches = await store.allMatches();
    const out = [];
    for (let i = 0; i < matches.length; i += 1) {
      const v = await service.matchView(matches[i]);
      if (v) out.push(v);
    }
    out.sort((a, b) => b.score - a.score);
    return ok({ matches: out, total: out.length });
  },

  'match.reject': async (payload) => {
    const p = payload || {};
    return ok(await service.rejectMatch(p.matchId, p.reason));
  },

  /* ---------- 认领 ---------- */
  'claim.start': async (payload) => {
    const r = await service.startClaim(payload && payload.matchId);
    if (!r.ok) return fail(r.message, 'CLAIM_FAILED');
    return ok({ claim: r.claimView });
  },

  'claim.submit': async (payload) => {
    const p = payload || {};
    const r = await service.submitClaim(p.claimId, p.answers || []);
    if (!r.ok) return fail(r.message, 'CLAIM_FAILED');
    return ok({ claim: r.claimView });
  },

  'claim.confirm': async (payload) => {
    const p = payload || {};
    const r = await service.confirmClaim(p.claimId, p.action, p.remark);
    if (!r.ok) return fail(r.message, 'CLAIM_FAILED');
    return ok({ claim: r.claimView });
  },

  'claim.return': async (payload) => {
    const r = await service.completeReturn(payload && payload.claimId);
    if (!r.ok) return fail(r.message, 'CLAIM_FAILED');
    return ok({ claim: r.claimView });
  },

  'claim.get': async (payload) => {
    const claim = await store.getClaim(payload && payload.claimId);
    if (!claim) return fail('认领单不存在', 'NOT_FOUND');
    return ok({ claim: await service.claimView(claim) });
  },

  'claim.mine': async (payload, ctx) => ok({
    claims: await service.myClaims((payload && payload.userId) || ctx.userId)
  }),

  /* ---------- 通知 ---------- */
  'notify.list': async (payload, ctx) => {
    const userId = (payload && payload.userId) || ctx.userId;
    return ok({
      notifications: await service.notificationViews(userId),
      unread: await store.unreadCount(userId)
    });
  },

  'notify.read': async (payload, ctx) => {
    await store.markAllRead((payload && payload.userId) || ctx.userId);
    return ok({ read: true });
  },

  /* ---------- 统计与实验 ---------- */
  'stats.dashboard': async () => {
    const stats = await service.stats();
    const dist = await service.categoryDistribution();
    const evaluation = await service.evaluate();
    return ok({ stats, categoryDistribution: dist, evaluation, embedding: aiEmbed.describe() });
  },

  'stats.heatmap': async (payload) => ok({
    cells: await service.heatmap(payload || {})
  }),

  'stats.timeline': async (payload) => ok({
    events: await service.timeline(payload || {})
  }),

  'stats.evaluate': async () => ok(await service.evaluate())
};

/* ===================== 入口 ===================== */

exports.main = async (event, context) => {
  const start = Date.now();
  const action = (event && event.action) || '';
  const handler = handlers[action];

  if (!handler) {
    return Object.assign(fail('未知 action：' + action, 'UNKNOWN_ACTION'), {
      availableActions: Object.keys(handlers)
    });
  }

  try {
    const wxContext = cloud.getWXContext();
    const ctx = { userId: (event && event.demoUserId) || 'u_me', openid: wxContext.OPENID };
    const result = await handler(event && event.payload, ctx);
    result.elapsed = Date.now() - start;
    return result;
  } catch (e) {
    console.error('[xj-api] action=' + action + ' 失败：', e);
    return Object.assign(fail(e.message || '服务端异常', 'INTERNAL'), {
      stack: String(e.stack || '').split('\n').slice(0, 4)
    });
  }
};
