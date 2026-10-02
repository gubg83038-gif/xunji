/**
 * wx-server-sdk 测试替身
 * ---------------------------------------------------------------
 * 只实现本项目用到的云数据库子集，用于在 Node 环境对云函数做冒烟测试：
 *   cloud.init / DYNAMIC_CURRENT_ENV / getWXContext
 *   db.collection().where()/orderBy()/skip()/limit()/get()/count()/add()/doc().update()/doc().remove()/where().update()/where().remove()
 *   db.command 的 and/or 以及普通条件对象匹配
 *
 * 关键点：查询条件用「普通对象」表达，仅在 and/or 出现时使用命令对象，
 * 与项目代码的写法一致（store.js 只在 or/and 场景使用 db.command）。
 */

const collections = {};

/** 已通过 db.createCollection 建过的集合（strict 模式下读取前必须存在） */
const createdCollections = {};

function matchesCondition(doc, cond) {
  if (!cond || typeof cond !== 'object') return true;

  // 命令对象
  if (cond.__cmd) {
    if (cond.op === 'or') {
      return cond.value.some((c) => matchesCondition(doc, c));
    }
    if (cond.op === 'and') {
      return cond.value.every((c) => matchesCondition(doc, c));
    }
  }

  return Object.keys(cond).every((key) => {
    const expected = cond[key];
    const actual = doc[key];
    if (expected && expected.__cmd) {
      if (expected.op === 'or') return expected.value.some((c) => matchesCondition(doc, c));
      if (expected.op === 'and') return expected.value.every((c) => matchesCondition(doc, c));
      if (expected.op === 'eq') return actual === expected.value;
      if (expected.op === 'neq') return actual !== expected.value;
      if (expected.op === 'in') return expected.value.indexOf(actual) >= 0;
      if (expected.op === 'gt') return actual > expected.value;
      if (expected.op === 'gte') return actual >= expected.value;
      if (expected.op === 'lt') return actual < expected.value;
      if (expected.op === 'lte') return actual <= expected.value;
    }
    return actual === expected;
  });
}

/** 支持 db.command.aggregate 的最小替身（本项目未真正使用聚合函数） */
function createAggregateCommand() {
  return new Proxy({}, {
    get() {
      return () => ({ __agg: true });
    }
  });
}

function createQueryCommand() {
  const make = (op) => (value) => ({ __cmd: true, op, value });
  return {
    or: (value) => ({ __cmd: true, op: 'or', value }),
    and: (value) => ({ __cmd: true, op: 'and', value }),
    eq: make('eq'),
    neq: make('neq'),
    in: make('in'),
    nin: make('nin'),
    gt: make('gt'),
    gte: make('gte'),
    lt: make('lt'),
    lte: make('lte'),
    exists: make('exists')
  };
}

/**
 * 是否让「读取不存在的集合」抛错。
 *
 * 真实的微信云开发**不会在写入前自动建集合**：集合不存在时读取会抛
 *   errCode -502005, errMsg "collection.get:fail -502005 database collection not exists"
 *
 * 替身默认模拟这个真实行为（strictCollections = true），
 * 否则云函数里「集合不存在应视为空数据」的容错逻辑永远测不出来。
 *
 * 测试代码可以先 createCollection 建集合，再往里面写数据。
 */
let strictCollections = true;

function setStrictCollections(on) {
  strictCollections = !!on;
}

function collectionNotExistError(name) {
  const err = new Error('collection.get:fail -502005 database collection not exists. ' +
    'Db or Table not exist: ' + name + '.');
  err.errCode = -502005;
  err.errMsg = err.message;
  return err;
}

function createCollection(name) {
  if (!collections[name]) collections[name] = [];
  const store = collections[name];

  /** strict 模式下，集合必须已通过 db.createCollection 建立过 */
  function assertExists() {
    if (strictCollections && !createdCollections[name]) {
      throw collectionNotExistError(name);
    }
  }

  function queryApi(state) {
    const api = {
      where(cond) {
        return queryApi(Object.assign({}, state, { where: cond }));
      },
      orderBy(field, direction) {
        const list = (state.orders || []).concat([{ field, direction }]);
        return queryApi(Object.assign({}, state, { orders: list }));
      },
      skip(n) {
        return queryApi(Object.assign({}, state, { skip: n }));
      },
      limit(n) {
        return queryApi(Object.assign({}, state, { limit: n }));
      },
      field() {
        return api;
      },
      async get() {
        assertExists();
        let list = store.filter((d) => matchesCondition(d, state.where));
        (state.orders || []).forEach((o) => {
          list = list.slice().sort((a, b) => {
            const av = a[o.field];
            const bv = b[o.field];
            if (av === bv) return 0;
            const r = av > bv ? 1 : -1;
            return o.direction === 'asc' ? r : -r;
          });
        });
        if (state.skip) list = list.slice(state.skip);
        if (state.limit !== undefined) list = list.slice(0, state.limit);
        return { data: JSON.parse(JSON.stringify(list)) };
      },
      async count() {
        assertExists();
        const list = store.filter((d) => matchesCondition(d, state.where));
        return { total: list.length };
      },
      async update({ data }) {
        assertExists();
        const list = store.filter((d) => matchesCondition(d, state.where));
        list.forEach((doc) => Object.assign(doc, data));
        return { stats: { updated: list.length } };
      },
      async remove() {
        assertExists();
        const keep = store.filter((d) => !matchesCondition(d, state.where));
        const removed = store.length - keep.length;
        store.length = 0;
        keep.forEach((d) => store.push(d));
        return { stats: { removed } };
      },
      doc(id) {
        return {
          async update({ data }) {
            assertExists();
            const doc = store.find((d) => d._id === id);
            if (!doc) return { stats: { updated: 0 } };
            Object.assign(doc, data);
            return { stats: { updated: 1 } };
          },
          async remove() {
            assertExists();
            const i = store.findIndex((d) => d._id === id);
            if (i >= 0) store.splice(i, 1);
            return { stats: { removed: i >= 0 ? 1 : 0 } };
          },
          async get() {
            assertExists();
            const doc = store.find((d) => d._id === id);
            if (!doc) throw new Error('document does not exist');
            return { data: JSON.parse(JSON.stringify(doc)) };
          }
        };
      }
    };
    return api;
  }

  const collectionApi = queryApi({});
  collectionApi.add = async ({ data }) => {
    // 真实云开发：向不存在的集合写入也会报错
    assertExists();
    const doc = Object.assign({ _id: name + '_' + Math.random().toString(36).slice(2, 10) }, data);
    store.push(doc);
    return { _id: doc._id };
  };
  return collectionApi;
}

const db = {
  collection: (name) => createCollection(name),
  command: Object.assign(createQueryCommand(), { aggregate: createAggregateCommand() }),
  createCollection: async (name) => {
    if (createdCollections[name]) {
      const err = new Error('collection already exists');
      err.errCode = -501001;
      throw err;
    }
    createdCollections[name] = true;
    if (!collections[name]) collections[name] = [];
    return { requestId: 'stub' };
  },
  serverDate: () => new Date()
};

const cloud = {
  DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
  init: () => {},
  database: () => db,
  getWXContext: () => ({ OPENID: 'test-openid', APPID: 'test-appid', UNIONID: '' })
};

module.exports = Object.assign(cloud, {
  __collections: collections,
  __db: db,
  __setStrictCollections: setStrictCollections,
  __reset: () => {
    Object.keys(collections).forEach((k) => {
      collections[k].length = 0;
      delete createdCollections[k];
    });
  }
});
