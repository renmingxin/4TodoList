// 假 wx-server-sdk —— fqTodo / fqRemind 两份云函数测试共用的内存实现。
//
// 为什么抽出来：两个云函数用的是同一套集合、同一套查询语义。假 SDK 要是各写一份，
// 迟早会漂移 —— 一边支持了 _.neq 的「字段不存在算命中」，另一边没支持，
// 于是同一段逻辑在两个测试里给出相反的结论。
//
// 只实现两份云函数真正用到的方法，不做通用模拟。但**查询条件**要尽量贴近真库：
//
//   · 等值：        doc[k] === v
//   · 比较命令：    gt / gte / lt / lte / neq / in / and / or（db.command）
//   · 字段不存在时：_.neq(x) **命中**（MongoDB 的 $ne 就是这个行为），
//                   而等值 false **不命中**。
//     「pushed: false」和「pushed: _.neq(true)」在选择条件里**不等价** ——
//     前者挑不到老文档（字段压根没有），后者可以。这个区别是本项目
//     「升级上来的老数据也要被定时任务捞到」的关键，假 SDK 必须如实还原。
//   · null 与数字比大小：JS 里 null <= 0 是 true，MongoDB 里 null 也排在数字之前，
//     两边一致。所以 fqRemind 才必须用 _.and(_.gt(0), _.lte(t)) 把「没有提醒时间」
//     的文档挡在窗口外，而不能只写 _.lte。

const Module = require('module');

const COLLECTIONS = {};
const ctx = { OPENID: 'openid-me', SOURCE: 'wx_trigger' };

// 项目用到的全部集合。reset() 会保证它们都存在且为空 ——
// 否则「刚 reset 完就 push 夹具」会撞上 undefined（懒建只发生在第一次访问时）。
// 测试里直接往 COLLECTIONS.xxx 里塞夹具是常规写法，这个保证不能省。
const KNOWN_COLLECTIONS = ['fq_family', 'fq_members', 'fq_categories', 'fq_items', 'fq_subs'];

function store(name) {
  if (!COLLECTIONS[name]) COLLECTIONS[name] = [];
  return COLLECTIONS[name];
}

let seq = 0;

/* ---------------- db.command ---------------- */

function wrapAnd(args) {
  return { __and: args.length === 1 && Array.isArray(args[0]) ? args[0] : [].slice.call(args) };
}

const command = {
  inc: function (n) {
    return { __inc: n };
  },
  gt: function (v) {
    return { __cmp: 'gt', v: v };
  },
  gte: function (v) {
    return { __cmp: 'gte', v: v };
  },
  lt: function (v) {
    return { __cmp: 'lt', v: v };
  },
  lte: function (v) {
    return { __cmp: 'lte', v: v };
  },
  neq: function (v) {
    return { __cmp: 'neq', v: v };
  },
  in: function (arr) {
    return { __in: arr };
  },
  and: function () {
    return wrapAnd([].slice.call(arguments));
  },
  or: function () {
    return { __or: [].slice.call(arguments) };
  },
};

// 单字段的条件求值
function test(cond, val) {
  if (cond && typeof cond === 'object') {
    if (cond.__cmp) {
      switch (cond.__cmp) {
        case 'gt':
          return val > cond.v;
        case 'gte':
          return val >= cond.v;
        case 'lt':
          return val < cond.v;
        case 'lte':
          return val <= cond.v;
        case 'neq':
          return val !== cond.v;
      }
    }
    if (cond.__and) return cond.__and.every(function (c) { return test(c, val); });
    if (cond.__or) return cond.__or.some(function (c) { return test(c, val); });
    if (cond.__in) return cond.__in.indexOf(val) >= 0;
  }
  return val === cond;
}

function match(doc, cond) {
  return Object.keys(cond).every(function (k) {
    return test(cond[k], doc[k]);
  });
}

// 写入补丁：除了普通赋值，还要认得 db.command.inc。
// 不处理的话 {rev:{__inc:1}} 会被原样写进文档，rev 永远是个对象，
// 客户端轮询就会永远认为「数据变了」。
function applyPatch(doc, patch) {
  Object.keys(patch).forEach(function (k) {
    const v = patch[k];
    if (v && typeof v === 'object' && typeof v.__inc === 'number') {
      doc[k] = (Number(doc[k]) || 0) + v.__inc;
    } else {
      doc[k] = v;
    }
  });
}

/* ---------------- 查询 / 文档 ---------------- */

class Query {
  constructor(name, cond) {
    this.name = name;
    this.cond = cond || {};
    this._order = null;
    this._skip = 0;
    this._limit = Infinity;
  }
  orderBy(field, dir) {
    this._order = { field: field, dir: dir === 'desc' ? -1 : 1 };
    return this;
  }
  skip(n) {
    this._skip = n;
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  _rows() {
    let rows = store(this.name).filter((d) => match(d, this.cond));
    if (this._order) {
      const f = this._order.field;
      const dir = this._order.dir;
      rows = rows.slice().sort(function (a, b) {
        if (a[f] === b[f]) return 0;
        return a[f] < b[f] ? -dir : dir;
      });
    }
    return rows;
  }
  async get() {
    return { data: this._rows().slice(this._skip, this._skip + this._limit).map((d) => Object.assign({}, d)) };
  }
  async count() {
    return { total: this._rows().length };
  }
  async update(opts) {
    const rows = this._rows();
    rows.forEach(function (d) {
      applyPatch(d, opts.data);
    });
    return { stats: { updated: rows.length } };
  }
  async remove() {
    const rows = this._rows();
    const ids = new Set(rows.map((d) => d._id));
    COLLECTIONS[this.name] = store(this.name).filter((d) => !ids.has(d._id));
    return { stats: { removed: rows.length } };
  }
}

class Doc {
  constructor(name, id) {
    this.name = name;
    this.id = id;
  }
  _row() {
    return store(this.name).filter((d) => d._id === this.id)[0];
  }
  async get() {
    const r = this._row();
    if (!r) throw new Error('document.get:fail document does not exist');
    return { data: Object.assign({}, r) };
  }
  async update(opts) {
    const r = this._row();
    if (!r) throw new Error('document.update:fail document does not exist');
    applyPatch(r, opts.data);
    return { stats: { updated: 1 } };
  }
  async remove() {
    const before = store(this.name).length;
    COLLECTIONS[this.name] = store(this.name).filter((d) => d._id !== this.id);
    return { stats: { removed: before - store(this.name).length } };
  }
}

class Collection extends Query {
  constructor(name) {
    super(name, {});
    this.name = name;
  }
  where(cond) {
    return new Query(this.name, cond);
  }
  doc(id) {
    return new Doc(this.name, id);
  }
  async add(opts) {
    seq++;
    const _id = this.name + '_' + seq;
    store(this.name).push(Object.assign({ _id: _id }, opts.data));
    return { _id: _id };
  }
}

/* ---------------- 云调用（openapi） ---------------- */

// 记录每一次下发，供测试断言「发了什么」。默认成功，
// 需要造失败时用 queueDefault / queue 预置一条。
const openapi = {
  calls: [],
  queue: [],
  fallback: null, // { errCode, errMsg }
};

openapi.subscribeMessage = {
  async send(params) {
    openapi.calls.push(JSON.parse(JSON.stringify(params)));
    const r = openapi.queue.length ? openapi.queue.shift() : openapi.fallback;
    if (r && r.errCode) {
      const e = new Error(r.errMsg || 'openapi error ' + r.errCode);
      e.errCode = r.errCode;
      e.errMsg = r.errMsg || 'openapi error ' + r.errCode;
      throw e;
    }
    return { errCode: 0, errMsg: 'openapi.subscribeMessage.send:ok' };
  },
};

/* ---------------- SDK 本体 ---------------- */

const sdk = {
  DYNAMIC_CURRENT_ENV: '__DYNAMIC__',
  init() {},
  getWXContext() {
    return { OPENID: ctx.OPENID, SOURCE: ctx.SOURCE, ENV: 'fake-env' };
  },
  database() {
    return {
      command: command,
      serverDate() {
        return { __serverDate: true };
      },
      collection(name) {
        return new Collection(name);
      },
    };
  },
  openapi: openapi,
};

let installed = false;

function install() {
  if (installed) return;
  installed = true;
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'wx-server-sdk') return sdk;
    return origLoad.apply(this, arguments);
  };
}

// 必须先 install 再 require，否则云函数拿到的还是真 SDK（会去连网络）
function loadFunction(absPath) {
  install();
  return require(absPath);
}

function reset() {
  Object.keys(COLLECTIONS).forEach(function (k) {
    COLLECTIONS[k] = [];
  });
  KNOWN_COLLECTIONS.forEach(function (k) {
    COLLECTIONS[k] = [];
  });
  seq = 0;
  ctx.OPENID = 'openid-me';
  ctx.SOURCE = 'wx_trigger';
  openapi.calls = [];
  openapi.queue = [];
  openapi.fallback = null;
  return COLLECTIONS;
}

module.exports = {
  COLLECTIONS: COLLECTIONS,
  ctx: ctx,
  // 写成访问器，测试里可以继续用 `FC.OPENID = 'openid-a'` 的直白写法
  get OPENID() {
    return ctx.OPENID;
  },
  set OPENID(v) {
    ctx.OPENID = v;
  },
  get SOURCE() {
    return ctx.SOURCE;
  },
  set SOURCE(v) {
    ctx.SOURCE = v;
  },
  command: command,
  openapi: openapi,
  install: install,
  loadFunction: loadFunction,
  reset: reset,
  nextId(prefix) {
    seq++;
    return (prefix || 'doc') + '_' + seq;
  },
};
