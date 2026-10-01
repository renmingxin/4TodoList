// cloudfunctions/fqTodo/index.js
// 四象限事项中心 · 唯一数据出口
//
// ============ 共享家庭模型（v3） ============
// 数据不挂在「人」上，而是挂在「家庭」上。一个家庭 = 一份共享的四象限清单，
// 家庭成员之间可读可写：你加入对方的家庭，看到的就是对方的清单；
// 退出，就回到自己的那份（自己的数据一直留着，什么都没删）。
//
// 集合：
//   fq_family      { name, ownerOpenid, inviteCode, inviteExpire, rev, createdAt }
//   fq_members     { _openid, fid, role, name, active, joinedAt }
//   fq_categories  { fid, _openid, name, order, createdAt }
//   fq_items       { fid, _openid, title, note, quad, catId, priority, done, remindAt,
//                    order, createdAt, updatedAt, doneAt, doneBy,
//                    pushed, pushedAt, pushOk, pushErr }
//   fq_subs        { _openid, quota, lastGrantAt, updatedAt }
//
//   · _openid 现在的含义是「谁创建的」，**不再参与归属过滤** —— 归属只看 fid。
//     但有两处例外，都是「按人」而不是「按家」的东西，且都读得理直气壮：
//     ① fq_subs 的提醒额度（订阅次数是发到人身上的，不是家庭资产）；
//     ② fq_items 里 pushed 系列字段的**收件人** —— 提醒只发给「创建这条事项的人」。
//
//   · pushed 系列是 fqRemind（定时触发器云函数）写的，本函数只负责在
//     「提醒时间被改动」时把它们复位。客户端**改不了**这几个字段
//     （updateItem 是白名单写法，没列进去）。
//   · rev 是家庭的数据版本号，每写一次 +1。客户端轮询它判断「有没有人改过」，
//     没改就只回一个数字，不拉数据。
//   · 一个用户可以有多个家庭（自己的一份 + 加入别人的），但同一时刻只有
//     fq_members.active = true 的那条是「当前家庭」。
//
// ⚠️ 铁律一：fid 只能由服务端从 OPENID 推导（见 ensureFamily），
//    **绝不接受客户端传入 fid**。云函数用的是管理员权限，会绕过数据库安全规则 ——
//    一旦让客户端传 fid，任何人构造一个请求就能读走全部家庭的数据。
//    所有 action 的归属一律取 ctx.fid，没有例外。
//
// ⚠️ 铁律二：客户端不做任何直接 db 调用，全部经本云函数读写。
//
//   （这条也是「自动同步用轮询而不是客户端 watch()」的原因：watch() 要求把集合
//     读权限放开给客户端，等于把铁律二破掉，代价比多几次云函数调用大得多。）

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COL_FAMILY = 'fq_family';
const COL_MEMBERS = 'fq_members';
const COL_CATS = 'fq_categories';
const COL_ITEMS = 'fq_items';
const COL_SUBS = 'fq_subs';

const QUADS = ['q1', 'q2', 'q3', 'q4'];
const MAX_TITLE = 60;
const MAX_NOTE = 200;
const MAX_CAT_NAME = 12;
const MAX_FAMILY_NAME = 16;
const MAX_MEMBER_NAME = 12;
const PAGE = 100;
const PAGE_CAP = 500;
const MAX_REORDER = 200;
const MAX_MEMBERS = 20;

// 提醒推送（v5）。模板 id 与 fqRemind 里那份必须一致 ——
// 这里是唯一来源，客户端从 bootstrap 拿，grantSub 时再回传核对。
const SUB_TEMPLATE_ID = '1AaZ3iSMfGpplGMUIVArXIPssCKAj2p3hHFxJPpOmlM';
// 一个人最多囤多少条额度。个人主体只有一次性订阅，囤多了没有意义，
// 但也不能不封顶 —— 不然客户端凭空连发 grantSub 就能把计数刷到天上。
const MAX_QUOTA = 50;
// 两次授权之间的最小间隔（毫秒）。正常流程里用户每攒一条都要过一次
// requestSubscribeMessage 的回调 + 一次云函数往返，人手撞不到这个闸；
// 它拦的是脚本连点。
const GRANT_MIN_MS = 300;

// 邀请码：6 位，去掉 0/O/1/I/L 这些看起来像的字符
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LEN = 6;
const INVITE_TTL = 24 * 60 * 60 * 1000;

/* ---------------- 协议版本（与小程序端 FN_VER 成对，改一处必须改另一处） ----------------
   为什么要这个：开发者工具的「编译」只处理小程序端，**不会上传云函数**。
   所以本地代码加了新 action、云端还是旧包，是很常见的一种「代码明明是对的却报错」。
   历史上已经踩过两次：第一次是根本没部署（报「尚未部署」），
   第二次是改了 action 清单没重新部署（拖动落库报「未知 action: reorder」）。

   约定：**只要改动 action 清单（新增 / 删除 / 改签名），FN_VER 就 +1。**
   v2 → v3：引入共享家庭，新增 sync / genInvite / joinFamily / leaveFamily /
            renameMember / renameFamily，且所有 action 的归属键从 _openid 变成 fid。
   v3 → v4：分类支持删除与改名，新增 removeCategory / renameCategory。
   v4 → v5：提醒推送，新增 grantSub（攒订阅额度）；fq_items 多出 pushed 系列字段，
            由独立的 fqRemind 定时云函数消费。
   客户端首屏 bootstrap 会拿这个值做握手，对不上直接弹窗告诉你重新部署。 */
const FN_VER = 5;

const ACTIONS = [
  'bootstrap',
  'sync',
  'addItem',
  'updateItem',
  'removeItem',
  'reorder',
  'bulk',
  'clearDone',
  'clearAll',
  'addCategory',
  'removeCategory',
  'renameCategory',
  'genInvite',
  'joinFamily',
  'leaveFamily',
  'renameMember',
  'renameFamily',
  'grantSub',
];

/* ---------------- 字段净化（永远不要信任前端传参） ---------------- */

function toStr(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function toQuad(v) {
  return QUADS.indexOf(v) >= 0 ? v : 'q1';
}

function toPriority(v) {
  const n = parseInt(v, 10);
  return n >= 1 && n <= 4 ? n : 3;
}

// remindAt 存毫秒时间戳；空值/非法值一律落 null。
// 到点前 10 分钟由 fqRemind 依据它推送（见那个云函数）。
function toRemind(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// order 存整数。客户端每次重排都整段写成 0 / 10 / 20…，
// 这里只做数值收敛，不做「必须是正数」的假设（种子数据是从 1000 起的）。
function toOrder(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return Date.now();
  return Math.round(Math.max(-1e12, Math.min(1e12, n)));
}

// 邀请码：统一大写、去掉空格与常见误输入的连字符
function toCode(v) {
  return toStr(v, 16).toUpperCase().replace(/[\s-]/g, '');
}

function makeCode() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) {
    s += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  }
  return s;
}

/* ---------------- 分页取全（云函数单次 limit 上限 100） ---------------- */

async function fetchAll(collName, where, orderField) {
  const out = [];
  let skip = 0;
  for (let i = 0; i < PAGE_CAP / PAGE; i++) {
    const res = await db
      .collection(collName)
      .where(where)
      .orderBy(orderField, 'asc')
      .skip(skip)
      .limit(PAGE)
      .get();
    out.push(...res.data);
    if (res.data.length < PAGE) break;
    skip += PAGE;
  }
  return out;
}

/* ---------------- 家庭：解析当前归属 ---------------- */

// 家庭的版本号推一格。客户端轮询靠它判断「有没有人改过」。
// 失败不影响业务本身（同步信号丢一格的代价只是客户端晚 8 秒才发现），所以吞掉异常。
async function bumpRev(fid) {
  if (!fid) return;
  try {
    await db.collection(COL_FAMILY).doc(fid).update({ data: { rev: _.inc(1) } });
  } catch (e) {
    /* ignore */
  }
}

async function readFamily(fid) {
  try {
    const r = await db.collection(COL_FAMILY).doc(fid).get();
    return r && r.data ? r.data : null;
  } catch (e) {
    return null;
  }
}

// 首次进入 / 升级上来的老用户：把「按 openid 隔离」的老数据认领进新家庭。
// 这一步不能省 —— 否则老用户升级后会看到一个空列表，以为数据丢了。
async function createDefaultFamily(openid) {
  const oldCats = await fetchAll(COL_CATS, { _openid: openid }, 'createdAt');
  const oldItems = await fetchAll(COL_ITEMS, { _openid: openid }, 'createdAt');
  const looseCats = oldCats.filter(function (c) {
    return !c.fid;
  });
  const looseItems = oldItems.filter(function (it) {
    return !it.fid;
  });

  const res = await db.collection(COL_FAMILY).add({
    data: {
      name: '我的家庭',
      ownerOpenid: openid,
      inviteCode: '',
      inviteExpire: 0,
      rev: 0,
      createdAt: db.serverDate(),
    },
  });
  const fid = res._id;

  await db.collection(COL_MEMBERS).add({
    data: {
      _openid: openid,
      fid: fid,
      role: 'owner',
      name: '',
      active: true,
      joinedAt: db.serverDate(),
    },
  });

  if (looseCats.length || looseItems.length) {
    // 老用户：认领已有数据，**不播种**（否则他会看到自己的数据 + 5 条示例混在一起）
    const tasks = [];
    looseCats.forEach(function (c) {
      tasks.push(db.collection(COL_CATS).doc(c._id).update({ data: { fid: fid } }));
    });
    looseItems.forEach(function (it) {
      tasks.push(db.collection(COL_ITEMS).doc(it._id).update({ data: { fid: fid } }));
    });
    await Promise.all(tasks);
  } else {
    await seed(openid, fid);
  }

  await bumpRev(fid);
  return { fid: fid, role: 'owner', fam: await readFamily(fid) };
}

// 所有 action 的总入口：拿到调用者「当前是哪个家庭、什么身份」。
// 这是整个文件里唯一允许产生 fid 的地方 —— 客户端永远传不进来。
async function ensureFamily(openid) {
  const mem = await db
    .collection(COL_MEMBERS)
    .where({ _openid: openid, active: true })
    .limit(1)
    .get();

  if (mem.data.length) {
    const m = mem.data[0];
    const fam = await readFamily(m.fid);
    if (fam) return { fid: m.fid, role: m.role, fam: fam };
    // 家庭文档不在了（数据被人手工删过）→ 把这条僵尸成员记录清掉，重建一个
    await db.collection(COL_MEMBERS).doc(m._id).remove();
  }

  return await createDefaultFamily(openid);
}

function emptyFamily() {
  return {
    id: '',
    name: '我的家庭',
    role: 'owner',
    isOwner: true,
    memberCount: 1,
    members: [],
    inviteCode: '',
    inviteExpire: 0,
    rev: 0,
  };
}

// 给客户端的家庭信息。注意两点：
//   1. 不回传任何 openid —— 客户端不需要，泄漏也没好处；成员用文档 _id 做 key。
//   2. 邀请码只回给创建者 —— 成员看不到码，就没法把码随手转给别人拉人进来。
async function familyInfo(ctx, openid) {
  const fam = ctx.fam || {};
  const isOwner = fam.ownerOpenid === openid;
  const mems = await db.collection(COL_MEMBERS).where({ fid: ctx.fid }).limit(MAX_MEMBERS).get();
  const members = mems.data.map(function (m) {
    const me = m._openid === openid;
    return {
      key: m._id,
      me: me,
      role: m.role === 'owner' ? 'owner' : 'member',
      // 没设显示名时的兜底。放在服务端算，是因为「我」这个称呼只有服务端
      // 知道该给谁 —— 客户端拿到的列表里没有 openid，认不出哪条是自己。
      name: toStr(m.name, MAX_MEMBER_NAME) || (me ? '我' : '家人'),
    };
  });
  return {
    id: ctx.fid,
    name: toStr(fam.name, MAX_FAMILY_NAME) || '我的家庭',
    role: ctx.role,
    isOwner: isOwner,
    memberCount: members.length,
    members: members,
    inviteCode: isOwner ? toStr(fam.inviteCode, 16) : '',
    inviteExpire: isOwner ? Number(fam.inviteExpire) || 0 : 0,
    rev: Number(fam.rev) || 0,
  };
}

/* ---------------- 首次进入的种子数据（对齐设计稿演示内容） ---------------- */

async function seed(openid, fid) {
  const catDefs = [
    { name: '工作', order: 0 },
    { name: '生活', order: 1 },
  ];

  const catIds = [];
  for (let i = 0; i < catDefs.length; i++) {
    const res = await db.collection(COL_CATS).add({
      data: {
        fid: fid,
        _openid: openid,
        name: catDefs[i].name,
        order: catDefs[i].order,
        createdAt: db.serverDate(),
      },
    });
    catIds.push(res._id);
  }

  // 「明天 09:00」
  const tmr = new Date(Date.now() + 24 * 60 * 60 * 1000);
  tmr.setHours(9, 0, 0, 0);

  const itemDefs = [
    { title: '学习后端的体系', note: '从后端到前端的完整链路，含协议与部署', quad: 'q1', priority: 3, remind: false },
    { title: '整理面试信息-鹏程九点', note: '面试宝典 BPM2 系列', quad: 'q1', priority: 3, remind: true },
    { title: '工作没搞定npm', note: '了解发布 npm 包流程', quad: 'q3', priority: 3, remind: false },
    { title: '锻炼身体', note: '锻炼三次，每次跑 5 公里，伴随徒步 1-2 天', quad: 'q3', priority: 3, remind: false },
    { title: '做一个家庭财务代办账务系统', note: '整理扣入成本管理', quad: 'q4', priority: 4, remind: false },
  ];

  for (let i = 0; i < itemDefs.length; i++) {
    const it = itemDefs[i];
    await db.collection(COL_ITEMS).add({
      data: {
        fid: fid,
        _openid: openid,
        title: it.title,
        note: it.note,
        quad: it.quad,
        catId: catIds[0], // 种子事项全部落在「工作」
        priority: it.priority,
        done: false,
        remindAt: it.remind ? tmr.getTime() : null,
        order: 1000 + i, // 种子数据排在新增事项之前
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        doneAt: null,
        doneBy: '',
      },
    });
  }
}

// 家庭里一个分类都没有时兜底建一个 —— 否则「新建事项」会因为无分类可选而卡死。
// 正常路径走不到这里（种子 / 老数据认领都会带分类），是防御性的。
async function ensureDefaultCategory(fid, openid) {
  const res = await db.collection(COL_CATS).add({
    data: { fid: fid, _openid: openid, name: '默认', order: 0, createdAt: db.serverDate() },
  });
  return [{ _id: res._id, fid: fid, name: '默认', order: 0 }];
}

/* ---------------- 各 action ---------------- */

async function bootstrap(openid) {
  const ctx = await ensureFamily(openid);

  let categories = await fetchAll(COL_CATS, { fid: ctx.fid }, 'order');
  if (!categories.length) categories = await ensureDefaultCategory(ctx.fid, openid);
  const items = await fetchAll(COL_ITEMS, { fid: ctx.fid }, 'order');

  // fnVer / actions 是握手信息，不是业务数据；客户端只用来判断「云端是不是旧包」
  return {
    categories,
    items,
    family: await familyInfo(ctx, openid),
    sub: await subInfo(openid),
    fnVer: FN_VER,
    actions: ACTIONS,
  };
}

// 自动同步：客户端带着本地的 rev 来问「变了没」。
// 没变 → 只回一个数字（几十字节），这是绝大多数轮询的形态；
// 变了 → 顺带把整份数据带回去，省掉二次往返。
async function sync(openid, event) {
  const ctx = await ensureFamily(openid);
  const rev = Number(ctx.fam && ctx.fam.rev) || 0;
  const since = Number(event && event.rev);

  if (Number.isFinite(since) && since === rev) {
    // rev 一致 = 数据没变、也没人加入/改名（那两种都会推 rev），直接收工
    return { changed: false, rev: rev };
  }

  let categories = await fetchAll(COL_CATS, { fid: ctx.fid }, 'order');
  if (!categories.length) categories = await ensureDefaultCategory(ctx.fid, openid);
  const items = await fetchAll(COL_ITEMS, { fid: ctx.fid }, 'order');

  return {
    changed: true,
    rev: rev,
    categories: categories,
    items: items,
    family: await familyInfo(ctx, openid),
    // 额度可能被 fqRemind 消耗掉（提醒发出去了），「未送达」数也会跟着变，
    // 所以每次拉数据都顺带回一次。只在 changed 分支里查，绝大多数轮询不付这个成本。
    sub: await subInfo(openid),
  };
}

async function addItem(openid, event) {
  const ctx = await ensureFamily(openid);
  const src = event.item || {};
  const catId = toStr(src.catId, 64);
  if (!catId) throw new Error('缺少分类');

  // 分类必须属于当前家庭，防止跨家庭写入
  const owned = await db.collection(COL_CATS).where({ _id: catId, fid: ctx.fid }).count();
  if (owned.total === 0) throw new Error('分类不存在');

  const res = await db.collection(COL_ITEMS).add({
    data: {
      fid: ctx.fid,
      _openid: openid,
      title: toStr(src.title, MAX_TITLE) || '未命名事项',
      note: toStr(src.note, MAX_NOTE),
      quad: toQuad(src.quad),
      catId,
      priority: toPriority(src.priority),
      done: false,
      remindAt: toRemind(src.remindAt),
      // pushed 系列由 fqRemind 消费。新建时显式落 false（而不是留空），
      // 查询条件里那些 _.neq(true) 就能少一层「字段不存在」的含糊。
      pushed: false,
      pushedAt: null,
      pushOk: false,
      pushErr: '',
      order: Date.now(),
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
      doneAt: null,
      doneBy: '',
    },
  });
  await bumpRev(ctx.fid);
  return { _id: res._id };
}

async function updateItem(openid, event) {
  const ctx = await ensureFamily(openid);
  const id = toStr(event.id, 64);
  if (!id) throw new Error('缺少事项 id');

  const patch = {};
  const src = event.patch || {};

  if (src.title !== undefined) patch.title = toStr(src.title, MAX_TITLE) || '未命名事项';
  if (src.note !== undefined) patch.note = toStr(src.note, MAX_NOTE);
  if (src.quad !== undefined) patch.quad = toQuad(src.quad);
  if (src.priority !== undefined) patch.priority = toPriority(src.priority);
  if (src.remindAt !== undefined) {
    const next = toRemind(src.remindAt);
    patch.remindAt = next;

    // 提醒时间**真的变了** → 把推送状态复位，让它重新走一遍队列。
    // 为什么要先读一次旧值：客户端每次保存都会带上 remindAt（哪怕没动过它），
    // 若无脑复位，用户只是想改个标题，那条已经推过的提醒就会被重新排进队列，
    // 到点再发一条重复的 —— 而每条消息都要烧掉一条攒来的额度。
    const cur = await db.collection(COL_ITEMS).where({ _id: id, fid: ctx.fid }).limit(1).get();
    const before = cur.data.length ? toRemind(cur.data[0].remindAt) : null;
    if (before !== next) {
      patch.pushed = false;
      patch.pushedAt = null;
      patch.pushOk = false;
      patch.pushErr = '';
    }
  }

  if (src.catId !== undefined) {
    const catId = toStr(src.catId, 64);
    const owned = await db.collection(COL_CATS).where({ _id: catId, fid: ctx.fid }).count();
    if (owned.total === 0) throw new Error('分类不存在');
    patch.catId = catId;
  }

  if (src.done !== undefined) {
    patch.done = !!src.done;
    patch.doneAt = src.done ? db.serverDate() : null;
    // 共享清单里「谁完成的」是刚需，而且几乎不要成本，顺手记下来
    patch.doneBy = src.done ? openid : '';
  }

  if (!Object.keys(patch).length) return { updated: 0 };

  patch.updatedAt = db.serverDate();

  // where 里同时带 fid，避免越权改到别的家庭的数据
  const res = await db
    .collection(COL_ITEMS)
    .where({ _id: id, fid: ctx.fid })
    .update({ data: patch });
  if (res.stats.updated) await bumpRev(ctx.fid);
  return { updated: res.stats.updated };
}

async function removeItem(openid, event) {
  const ctx = await ensureFamily(openid);
  const id = toStr(event.id, 64);
  if (!id) throw new Error('缺少事项 id');
  const res = await db.collection(COL_ITEMS).where({ _id: id, fid: ctx.fid }).remove();
  if (res.stats.removed) await bumpRev(ctx.fid);
  return { removed: res.stats.removed };
}

// 批量：象限内全部完成 / 清空象限已完成 / 删除象限全部
async function bulk(openid, event) {
  const ctx = await ensureFamily(openid);
  const op = toStr(event.op, 32);
  const quad = toQuad(event.quad);
  const catId = toStr(event.catId, 64);
  if (!catId) throw new Error('缺少分类');

  const where = { fid: ctx.fid, quad, catId };

  if (op === 'markAllDone') {
    const res = await db
      .collection(COL_ITEMS)
      .where({ ...where, done: false })
      .update({ data: { done: true, doneAt: db.serverDate(), updatedAt: db.serverDate(), doneBy: openid } });
    if (res.stats.updated) await bumpRev(ctx.fid);
    return { updated: res.stats.updated };
  }

  if (op === 'clearDone') {
    const res = await db.collection(COL_ITEMS).where({ ...where, done: true }).remove();
    if (res.stats.removed) await bumpRev(ctx.fid);
    return { removed: res.stats.removed };
  }

  if (op === 'clearQuad') {
    const res = await db.collection(COL_ITEMS).where(where).remove();
    if (res.stats.removed) await bumpRev(ctx.fid);
    return { removed: res.stats.removed };
  }

  throw new Error('未知批量操作: ' + op);
}

// 我的页：清空已完成（全部象限 / 当前分类）
async function clearDone(openid, event) {
  const ctx = await ensureFamily(openid);
  const catId = toStr(event.catId, 64);
  const where = { fid: ctx.fid, done: true };
  if (catId) where.catId = catId;
  const res = await db.collection(COL_ITEMS).where(where).remove();
  if (res.stats.removed) await bumpRev(ctx.fid);
  return { removed: res.stats.removed };
}

// 我的页：清空全部数据（保留分类）。
// 共享之后这条的破坏力变大了 —— 它清的是**全家**的清单，不再只是自己的，
// 所以收紧成只有家庭创建者能用，客户端也把入口藏起来。
async function clearAll(openid, ctx) {
  const fam = ctx.fam || {};
  if (fam.ownerOpenid !== openid) {
    throw new Error('只有家庭创建者可以清空整个家庭的数据');
  }
  const res = await db.collection(COL_ITEMS).where({ fid: ctx.fid }).remove();
  if (res.stats.removed) await bumpRev(ctx.fid);
  return { removed: res.stats.removed };
}

// 排序：客户端拖动之后把受影响的事项一次性回写。
// 客户端只提交真正变了的行（id + order，跨象限时多带一个 quad），
// 这里逐条校验 fid 归属，越权的那条会静默不生效而不是报错中断。
async function reorder(openid, event) {
  const ctx = await ensureFamily(openid);
  const rows = Array.isArray(event.items) ? event.items : [];
  if (!rows.length) return { updated: 0 };
  if (rows.length > MAX_REORDER) throw new Error('一次最多重排 ' + MAX_REORDER + ' 条');

  const tasks = [];
  for (let i = 0; i < rows.length; i++) {
    const id = toStr(rows[i].id, 64);
    if (!id) continue;
    const patch = { order: toOrder(rows[i].order), updatedAt: db.serverDate() };
    // quad 只在跨象限拖拽时携带；显式传了才改，避免误把事项挪走
    if (rows[i].quad !== undefined && rows[i].quad !== null && rows[i].quad !== '') {
      patch.quad = toQuad(rows[i].quad);
    }
    tasks.push(
      db.collection(COL_ITEMS).where({ _id: id, fid: ctx.fid }).update({ data: patch })
    );
  }
  if (!tasks.length) return { updated: 0 };

  // 每条都是独立的小 update，并发发出去；几十条量级完全够用
  const res = await Promise.all(tasks);
  let updated = 0;
  res.forEach(function (r) {
    updated += (r && r.stats && r.stats.updated) || 0;
  });
  if (updated) await bumpRev(ctx.fid);
  return { updated };
}

async function addCategory(openid, event) {
  const ctx = await ensureFamily(openid);
  const name = toStr(event.name, MAX_CAT_NAME);
  if (!name) throw new Error('分类名不能为空');

  const dup = await db.collection(COL_CATS).where({ fid: ctx.fid, name }).count();
  if (dup.total > 0) throw new Error('分类已存在');

  const res = await db.collection(COL_CATS).add({
    data: { fid: ctx.fid, _openid: openid, name, order: Date.now(), createdAt: db.serverDate() },
  });
  await bumpRev(ctx.fid);
  return { _id: res._id, name };
}

// 改分类名。任何成员都能改 —— 和 addCategory 对称，改错了再改回来就是了。
// 同一个家庭内拒绝重名：分类之间本来就是互相隔离的，重名只会让人选错那一个。
async function renameCategory(openid, event) {
  const ctx = await ensureFamily(openid);
  const id = toStr(event.id, 64);
  if (!id) throw new Error('缺少分类 id');
  const name = toStr(event.name, MAX_CAT_NAME);
  if (!name) throw new Error('分类名不能为空');

  const owned = await db.collection(COL_CATS).where({ _id: id, fid: ctx.fid }).count();
  if (owned.total === 0) throw new Error('分类不存在');

  // 用「查出来再比 _id」而不是 count()：改成自己原来的名字时 count 会命中自己，
  // 那样「点开又原样确定」会被误判成重名。
  const dup = await db.collection(COL_CATS).where({ fid: ctx.fid, name }).limit(1).get();
  if (dup.data.length && dup.data[0]._id !== id) throw new Error('分类已存在');

  await db
    .collection(COL_CATS)
    .where({ _id: id, fid: ctx.fid })
    .update({ data: { name: name } });
  await bumpRev(ctx.fid);
  return { name: name };
}

// 删除分类。权限按「破坏力」分两层，不搞一刀切：
//   · 空分类：任何成员都能删（和 addCategory 全员可用对称，删错了再建一个就行）；
//   · 非空分类：**只有家庭创建者**能删 —— 它底下可能躺着别人录的事项，
//     破坏力和 clearAll 同级，所以用同一把尺子。
// 非空时的去向由客户端选：带 moveTo 就先把事项挪过去再删分类，不带就把它们一起删。
//
// ⚠️ 「这个分类底下有没有事项」**必须服务端自己重算**，绝不采信客户端。
//    否则构造一个不带 moveTo 的请求，就能绕过界面上的确认直接抹掉整个分类。
//    （同 §铁律一：云函数跑管理员权限、绕过数据库安全规则，一切判定都要在服务端重来一遍。）
async function removeCategory(openid, event) {
  const ctx = await ensureFamily(openid);
  const id = toStr(event.id, 64);
  if (!id) throw new Error('缺少分类 id');

  // 归属二次校验：不是本家庭的分类，一律当「不存在」（和 addItem 一个写法）
  const owned = await db.collection(COL_CATS).where({ _id: id, fid: ctx.fid }).count();
  if (owned.total === 0) throw new Error('分类不存在');

  // 兜底：家里至少留一个分类。全删光之后「新建事项」会因为无分类可选而卡死
  const total = await db.collection(COL_CATS).where({ fid: ctx.fid }).count();
  if (total.total <= 1) throw new Error('至少要保留一个分类');

  const used = await db.collection(COL_ITEMS).where({ fid: ctx.fid, catId: id }).count();
  const moveTo = toStr(event.moveTo, 64);

  if (used.total > 0) {
    const fam = ctx.fam || {};
    if (fam.ownerOpenid !== openid) {
      throw new Error('只有家庭创建者可以删除还有事项的分类');
    }

    if (moveTo) {
      if (moveTo === id) throw new Error('不能把事项移回它自己');
      const dest = await db.collection(COL_CATS).where({ _id: moveTo, fid: ctx.fid }).count();
      if (dest.total === 0) throw new Error('目标分类不存在');

      // 先搬事项、后删分类：中途失败也只是「分类还在、事项已搬走」，
      // 反过来先删分类就可能把事项连同归属一起弄丢。
      const mv = await db
        .collection(COL_ITEMS)
        .where({ fid: ctx.fid, catId: id })
        .update({ data: { catId: moveTo, updatedAt: db.serverDate() } });
      await db.collection(COL_CATS).where({ _id: id, fid: ctx.fid }).remove();
      await bumpRev(ctx.fid);
      return { removed: 1, moved: mv.stats.updated, deletedItems: 0, to: moveTo };
    }

    // 没给 moveTo = 用户选了「连同事项一起删除」。走到这里已经是服务端最后一道闸，
    // 上面那道 owner 校验刚刚放行过。
    const del = await db.collection(COL_ITEMS).where({ fid: ctx.fid, catId: id }).remove();
    await db.collection(COL_CATS).where({ _id: id, fid: ctx.fid }).remove();
    await bumpRev(ctx.fid);
    return { removed: 1, moved: 0, deletedItems: del.stats.removed };
  }

  // 空分类：直接删，不需要权限也不需要问去向
  await db.collection(COL_CATS).where({ _id: id, fid: ctx.fid }).remove();
  await bumpRev(ctx.fid);
  return { removed: 1, moved: 0, deletedItems: 0 };
}

/* ---------------- 家庭管理 ---------------- */

// 生成 / 刷新邀请码。只有创建者能生成，且码只回给创建者（见 familyInfo）。
async function genInvite(openid) {
  const ctx = await ensureFamily(openid);
  const fam = ctx.fam || {};
  if (fam.ownerOpenid !== openid) throw new Error('只有家庭创建者可以生成邀请码');

  let code = '';
  for (let i = 0; i < 5; i++) {
    const c = makeCode();
    const dup = await db.collection(COL_FAMILY).where({ inviteCode: c }).count();
    if (dup.total === 0) {
      code = c;
      break;
    }
  }
  if (!code) throw new Error('邀请码生成失败，请重试');

  const expire = Date.now() + INVITE_TTL;
  await db.collection(COL_FAMILY).doc(ctx.fid).update({
    data: { inviteCode: code, inviteExpire: expire },
  });
  await bumpRev(ctx.fid);
  return { inviteCode: code, inviteExpire: expire };
}

// 用邀请码加入对方的家庭。
// 注意这里只「切换当前家庭」，**不动任何数据** ——
// 自己原来那份清单原地留着，退出家庭就能回去。
async function joinFamily(openid, event) {
  const ctx = await ensureFamily(openid);
  const code = toCode(event.code);
  if (!code) throw new Error('请输入邀请码');

  const hit = await db.collection(COL_FAMILY).where({ inviteCode: code }).limit(1).get();
  if (!hit.data.length) throw new Error('邀请码无效');
  const target = hit.data[0];

  if (!target.inviteExpire || Number(target.inviteExpire) < Date.now()) {
    throw new Error('邀请码已过期，请让对方重新生成');
  }
  if (target._id === ctx.fid) throw new Error('你已经在这个家庭里了');

  const count = await db.collection(COL_MEMBERS).where({ fid: target._id }).count();
  if (count.total >= MAX_MEMBERS) throw new Error('这个家庭的人数已达上限（' + MAX_MEMBERS + '）');

  // 一个用户同一时刻只有一个「当前家庭」：先把别的置为非活动
  await db.collection(COL_MEMBERS).where({ _openid: openid, active: true }).update({ data: { active: false } });

  const exist = await db
    .collection(COL_MEMBERS)
    .where({ _openid: openid, fid: target._id })
    .limit(1)
    .get();
  if (exist.data.length) {
    // 以前加入过又退出了 → 复用那条记录，别重复建
    await db.collection(COL_MEMBERS).doc(exist.data[0]._id).update({ data: { active: true } });
  } else {
    await db.collection(COL_MEMBERS).add({
      data: {
        _openid: openid,
        fid: target._id,
        role: 'member',
        name: '',
        active: true,
        joinedAt: db.serverDate(),
      },
    });
  }

  await bumpRev(target._id);
  // 原来那个家庭也推一格：万一那边还有别的客户端在轮询
  await bumpRev(ctx.fid);

  return { fid: target._id, name: toStr(target.name, MAX_FAMILY_NAME) || '家庭' };
}

// 退出当前家庭，回到自己创建的那份清单。
// 创建者不能「退出」自己的家庭 —— 那个家就是他的默认清单，没有可退回的地方。
async function leaveFamily(openid) {
  const ctx = await ensureFamily(openid);
  const fam = ctx.fam || {};
  if (fam.ownerOpenid === openid) {
    throw new Error('这是你自己的家庭，不能退出');
  }

  await db
    .collection(COL_MEMBERS)
    .where({ _openid: openid, fid: ctx.fid })
    .update({ data: { active: false } });

  const own = await db
    .collection(COL_MEMBERS)
    .where({ _openid: openid, role: 'owner' })
    .limit(1)
    .get();

  if (own.data.length) {
    await db.collection(COL_MEMBERS).doc(own.data[0]._id).update({ data: { active: true } });
    await bumpRev(own.data[0].fid);
    return { fid: own.data[0].fid, backToOwn: true };
  }

  // 兜底：正常情况下每个人都有自己的一份（首次进入就建了），走不到这里
  const nf = await createDefaultFamily(openid);
  return { fid: nf.fid, backToOwn: false };
}

// 改自己在家庭里的显示名。
// 为什么不做微信昵称：小程序已没有稳定可用的昵称/头像接口，硬接要走用户手动填写，
// 还会牵出《用户隐私保护指引》。自己起个名最省事，也不碰任何隐私接口。
async function renameMember(openid, event) {
  const ctx = await ensureFamily(openid);
  const name = toStr(event.name, MAX_MEMBER_NAME);
  if (!name) throw new Error('名字不能为空');

  await db
    .collection(COL_MEMBERS)
    .where({ _openid: openid, fid: ctx.fid })
    .update({ data: { name: name } });
  await bumpRev(ctx.fid);
  return { name: name };
}

async function renameFamily(openid, event) {
  const ctx = await ensureFamily(openid);
  const fam = ctx.fam || {};
  if (fam.ownerOpenid !== openid) throw new Error('只有家庭创建者可以改家庭名');

  const name = toStr(event.name, MAX_FAMILY_NAME);
  if (!name) throw new Error('家庭名不能为空');

  await db.collection(COL_FAMILY).doc(ctx.fid).update({ data: { name: name } });
  await bumpRev(ctx.fid);
  return { name: name };
}

/* ---------------- 提醒推送：额度记账（v5） ----------------
   背景：个人主体的小程序只能用**一次性订阅** —— 用户点一次「允许」，
   我们才攒下「一条消息」的发送权，用完就没了，官方不给长期订阅。
   所以额度是按人攒、按人花的，和共享家庭无关：家里谁设的提醒，
   耗的就是谁攒的额度（fqRemind 按条目的 _openid 扣）。

   这里只做两件事：账本（grantSub）和查账（subInfo）。真正的发送在 fqRemind ——
   那边**不经过本函数**，因为它要按分钟跑，而定时触发器里没有 OPENID。 */

// 客户端要的三样东西：还剩几条额度、有几条提醒没能送出去、模板 id。
async function subInfo(openid) {
  const hit = await db.collection(COL_SUBS).where({ _openid: openid }).limit(1).get();
  const quota = hit.data.length ? Math.max(0, Number(hit.data[0].quota) || 0) : 0;

  // 「未送达」只算**自己创建的**条目：提醒发给的是条目创建者，
  // 家里别人那条没送出去，不该记在我头上。
  const miss = await db
    .collection(COL_ITEMS)
    .where({ _openid: openid, pushed: true, pushOk: _.neq(true), done: _.neq(true) })
    .count();

  return { quota: quota, missed: miss.total, templateId: SUB_TEMPLATE_ID };
}

// 攒一条额度。客户端在「保存带提醒的事项」时先过 wx.requestSubscribeMessage，
// 用户点了「允许」才回来调这个。
//
// ⚠️ 三处**不采信客户端**：
//   ① templateId 必须等于本项目的模板 —— 否则拿别的模板的授权也能给自己记额度；
//   ② 加多少由服务端定（一次授权就是一条），客户端传 999 也只加 1；
//   ③ 总量封顶 MAX_QUOTA，防止脚本连点把计数刷爆。
async function grantSub(openid, event) {
  if (toStr(event.templateId, 64) !== SUB_TEMPLATE_ID) throw new Error('模板不匹配');

  const now = Date.now();
  const hit = await db.collection(COL_SUBS).where({ _openid: openid }).limit(1).get();

  if (!hit.data.length) {
    await db.collection(COL_SUBS).add({
      data: { _openid: openid, quota: 1, lastGrantAt: now, updatedAt: db.serverDate() },
    });
    return { quota: 1, capped: false, tooFast: false };
  }

  const doc = hit.data[0];
  const cur = Math.max(0, Number(doc.quota) || 0);
  if (now - (Number(doc.lastGrantAt) || 0) < GRANT_MIN_MS) {
    // 间隔太短：当没发生过，把当前值回给客户端。
    // 这里**不报错** —— 用户正常地连存两条带提醒的事项也可能撞上，
    // 弹一条「操作失败」反而莫名其妙。
    return { quota: cur, capped: false, tooFast: true };
  }

  const next = Math.min(MAX_QUOTA, cur + 1);
  await db.collection(COL_SUBS).doc(doc._id).update({
    data: { quota: next, lastGrantAt: now, updatedAt: db.serverDate() },
  });
  return { quota: next, capped: next === cur, tooFast: false };
}

/* ---------------- 入口 ---------------- */

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, msg: '无法识别用户身份' };

  const action = String(event && event.action ? event.action : '');

  try {
    let data;
    switch (action) {
      case 'bootstrap':
        data = await bootstrap(OPENID);
        break;
      case 'sync':
        data = await sync(OPENID, event);
        break;
      case 'addItem':
        data = await addItem(OPENID, event);
        break;
      case 'updateItem':
        data = await updateItem(OPENID, event);
        break;
      case 'removeItem':
        data = await removeItem(OPENID, event);
        break;
      case 'reorder':
        data = await reorder(OPENID, event);
        break;
      case 'bulk':
        data = await bulk(OPENID, event);
        break;
      case 'clearDone':
        data = await clearDone(OPENID, event);
        break;
      case 'clearAll':
        data = await clearAll(OPENID, await ensureFamily(OPENID));
        break;
      case 'addCategory':
        data = await addCategory(OPENID, event);
        break;
      case 'removeCategory':
        data = await removeCategory(OPENID, event);
        break;
      case 'renameCategory':
        data = await renameCategory(OPENID, event);
        break;
      case 'genInvite':
        data = await genInvite(OPENID);
        break;
      case 'joinFamily':
        data = await joinFamily(OPENID, event);
        break;
      case 'leaveFamily':
        data = await leaveFamily(OPENID);
        break;
      case 'renameMember':
        data = await renameMember(OPENID, event);
        break;
      case 'renameFamily':
        data = await renameFamily(OPENID, event);
        break;
      case 'grantSub':
        data = await grantSub(OPENID, event);
        break;
      default:
        // 带上云端版本，方便一眼分辨「参数写错」还是「云端是旧包」
        return {
          ok: false,
          msg: '未知 action: ' + action + '（云端 fqTodo v' + FN_VER + '，若本端代码更新过请重新上传部署云函数）',
        };
    }
    return { ok: true, data };
  } catch (err) {
    // 只回传可读信息，不透传堆栈
    return { ok: false, msg: (err && err.message) || '服务异常' };
  }
};
