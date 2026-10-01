// cloudfunctions/fqRemind/index.js
// 四象限事项中心 · 提醒推送（定时触发器，每分钟一次）
//
// ============ 为什么单独一个云函数 ============
// fqTodo 是「用户在的时候」的数据出口，每个 action 的第一步都是 ensureFamily(OPENID)。
// 这个函数跑在**定时触发器**里，getWXContext() 里根本没有用户上下文 ——
// 硬塞进 fqTodo 就等于给那条铁律开一个例外。所以独立成一个函数：
// 它只读事项和分类，只写事项的 pushed 系列与 fq_subs 的额度，
// 不碰家庭、不碰分类、不碰任何增删改的业务逻辑。
//
// 集合（与前两个函数同一套）：
//   fq_items  { ..., _openid, fid, title, note, quad, catId, remindAt,
//               pushed, pushedAt, pushOk, pushErr }
//   fq_categories { _id, fid, name }
//   fq_subs   { _openid, quota, lastGrantAt, updatedAt }
//   fq_family { ..., rev }
//
// ============ 四条必须照做的官方约束 ============
// 1. 触发器时区固定 UTC+8，cron 直接按北京时间写，不用换算。
// 2. **会重复触发**。官方原文：「网络环境不稳定，微信可能会多次推送同一条消息」。
//    所以每条提醒都要抢锁去重 —— 只有 `stats.updated === 1` 的那一次才真发。
// 3. cron 是七段式：秒 分 时 日 月 星期 年。`0 * * * * * *` = 每分钟第 0 秒。
// 4. 云调用要在 config.json 里声明 `permissions.openapi`，否则 send 直接没权限。
//
// ============ 额度：扣到了才发 ============
// 个人主体拿不到长期订阅，用户点一次「允许」才攒下一条发送权，用完即止。
// 所以顺序是「先扣额度，再发」而不是「先发，被拒了再回滚」：
// 后者会让这条提醒变成已经烧掉机会的哑弹，而且回滚本身也可能失败。
// 扣不到就把它记成 no-quota —— 小程序里显示成「N 条提醒未送达」，不静默吞掉。
//
// 收件人是**条目的创建者**（item._openid），不是全家广播：
// 一条提醒发两个人要烧两份额度，额度又是各攒各的，所以各管各的。
//
// ============ 已知取舍 ============
// · 额度在「扣了但发送失败」时不退还。正常失败（43101 用户拒收、
//   模板字段超限）里，额度其实已经真被消耗掉了，退了反而记账不准；
//   网络抖动这种小概率事件，退与不退都说得过去，选了简单的那边。
// · 一条提醒只发一次。发出去之后用户改了提醒时间，由 fqTodo 的
//   updateItem 把 pushed 复位，它才重新排进队列（见那边「提醒时间真的变了」）。

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COL_ITEMS = 'fq_items';
const COL_CATS = 'fq_categories';
const COL_SUBS = 'fq_subs';
const COL_FAMILY = 'fq_family';

// 模板「待办事项提醒」。这份 id 与 fqTodo 里的 SUB_TEMPLATE_ID 是同一个，
// 两处必须一起改（测试会比对）。
const TEMPLATE_ID = '1AaZ3iSMfGpplGMUIVArXIPssCKAj2p3hHFxJPpOmlM';

// ⚠️ 体验期必须是 'trial'。这个字段决定**用户点通知后跳哪个版本**：
// 默认是 formal，而我们还没发布正式版，点了会跳「该小程序未发布」。
// 正式发布之后改成 'formal'。
const MINI_STATE = 'trial';

const PAGE_PATH = 'pages/index/index';

// 提前量：在提醒时间前 10 分钟发出去。
// 触发器最小粒度是分钟，所以实际提前量落在 9~10 分钟之间。
const LEAD_MS = 10 * 60 * 1000;

// 迟到容忍：超过这个还没发出去，就别补发了 ——
// 一条几小时前的提醒突然弹出来只会让人困惑。但也不能静默丢弃，
// 记成 expired（未送达），用户在小程序里看得见。
const LATE_MS = 5 * 60 * 1000;

const PAGE = 100;
const CAP = 500;

// thing 类型字段的硬上限，超了整条消息 47003 一起发不出去
const MAX_THING = 20;
const MAX_ERR = 80;

// 象限文案。这里不能 require 小程序端那份，云函数之间也不共享代码，
// 所以照抄一份 —— 改文案时两处一起改。
const QUAD_NAME = {
  q1: '重要且紧急',
  q2: '不重要但紧急',
  q3: '重要不紧急',
  q4: '不重要也不紧急',
};

/* ---------------- 工具 ---------------- */

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// 订阅消息的 time 类型要求 `YYYY-MM-DD HH:MM`，而且是**北京时间**。
// 容器时区不该被信任（不同部署形态下它可能不是 +8），所以写死偏移量
// 再走 getUTC* —— 这样跟容器怎么配完全无关。
function fmtTime(ts) {
  const d = new Date(Number(ts) + 8 * 3600 * 1000);
  return (
    d.getUTCFullYear() +
    '-' +
    pad2(d.getUTCMonth() + 1) +
    '-' +
    pad2(d.getUTCDate()) +
    ' ' +
    pad2(d.getUTCHours()) +
    ':' +
    pad2(d.getUTCMinutes())
  );
}

// 按「字符」截断，不是按 UTF-16 码元。名字里有 emoji 时 .slice 会把
// 一个代理对从中间劈开，发出去是个乱码方块。
function clipThing(v) {
  const s = String(v == null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim();
  const arr = Array.from(s);
  if (!arr.length) return '-';
  return arr.length > MAX_THING ? arr.slice(0, MAX_THING - 1).join('') + '…' : s;
}

// 家庭的版本号推一格 —— 客户端轮询它，用来发现「有人在别处改了数据」。
// 这里推它是因为「未送达」计数会变，界面上那行字要跟着刷新。
// 失败不影响推送本身，所以吞掉异常。
async function bumpRev(fid) {
  if (!fid) return;
  try {
    await db.collection(COL_FAMILY).doc(fid).update({ data: { rev: _.inc(1) } });
  } catch (e) {
    /* ignore */
  }
}

async function catName(catId, fid) {
  if (!catId) return '';
  try {
    const r = await db
      .collection(COL_CATS)
      .where({ _id: catId, fid: fid })
      .limit(1)
      .get();
    return r.data.length ? String(r.data[0].name || '') : '';
  } catch (e) {
    return '';
  }
}

/* ---------------- 捞出待处理 ---------------- */

async function fetchDue(maxTs) {
  const out = [];
  let skip = 0;
  for (let i = 0; i < CAP / PAGE; i++) {
    const res = await db
      .collection(COL_ITEMS)
      .where({
        // 必须是 and(gt(0), lte(t))，不能只写 lte(t)：
        // remindAt 为 null 的文档在 $lte 下也会被捞出来（null 在类型序里排在数字之前），
        // 那会把「压根没设提醒」的条目全卷进来，白占分页窗口。
        remindAt: _.and(_.gt(0), _.lte(maxTs)),
        // 用 neq(true) 而不是等值 false：升级上来的老文档没有这个字段，
        // 等值条件挑不到它们，那批提醒就永远不会被处理。
        pushed: _.neq(true),
        done: _.neq(true),
      })
      .orderBy('remindAt', 'asc')
      .skip(skip)
      .limit(PAGE)
      .get();
    out.push(...res.data);
    if (res.data.length < PAGE) break;
    skip += PAGE;
  }
  return out;
}

// 抢锁。返回 true 表示「这一条归我了」。
// 触发器重复触发时，两条并发实例里只有一条能拿到 stats.updated === 1，
// 另一条拿到 0 —— 这就是去重，不需要额外的锁表。
async function claim(item, patch) {
  try {
    const res = await db
      .collection(COL_ITEMS)
      .where({ _id: item._id, done: _.neq(true), pushed: _.neq(true) })
      .update({ data: Object.assign({ pushed: true, pushedAt: db.serverDate() }, patch) });
    return res.stats.updated === 1;
  } catch (e) {
    return false;
  }
}

async function finish(id, patch) {
  try {
    await db.collection(COL_ITEMS).where({ _id: id }).update({ data: patch });
  } catch (e) {
    /* 记录推送结果失败不该把整轮拖崩 */
  }
}

// 扣一条额度。**扣到了才发**（见文件头的说明）
async function spend(openid) {
  try {
    const res = await db
      .collection(COL_SUBS)
      .where({ _openid: openid, quota: _.gt(0) })
      .update({ data: { quota: _.inc(-1), updatedAt: db.serverDate() } });
    return res.stats.updated > 0;
  } catch (e) {
    return false;
  }
}

/* ---------------- 下发 ---------------- */

async function push(item) {
  const cat = await catName(item.catId, item.fid);

  // 5 个槽一个都不能少、不能空：选用模板时勾了几个字段，
  // 代码里就得赋几个非空值，缺一个整条消息 47003 全灭。
  await cloud.openapi.subscribeMessage.send({
    touser: item._openid,
    templateId: TEMPLATE_ID,
    page: PAGE_PATH,
    miniprogramState: MINI_STATE,
    lang: 'zh_CN',
    data: {
      thing26: { value: clipThing(item.title) },                // 事项名称
      thing15: { value: QUAD_NAME[item.quad] || QUAD_NAME.q1 },  // 事项类型 = 所在象限
      thing12: { value: clipThing(item.note) },                 // 备注消息
      thing1: { value: clipThing(cat) },                        // 事项主题 = 分类名
      time23: { value: fmtTime(item.remindAt) },                // 提醒时间
    },
  });
}

/* ---------------- 入口 ---------------- */

exports.main = async () => {
  const now = Date.now();
  const rows = await fetchDue(now + LEAD_MS);
  const stat = { scanned: rows.length, sent: 0, expired: 0, noQuota: 0, failed: 0, skipped: 0 };
  const touched = new Set();

  for (let i = 0; i < rows.length; i++) {
    const it = rows[i];
    const at = Number(it.remindAt);
    if (!Number.isFinite(at) || at <= 0) continue;

    // 早就过点了：容器冷启动、触发器漏跑都会造成这个。
    // 不补发，但也不静默丢弃 —— 记成未送达。
    if (at < now - LATE_MS) {
      if (await claim(it, { pushOk: false, pushErr: 'expired' })) {
        stat.expired++;
        touched.add(it.fid);
      }
      continue;
    }

    if (!(await claim(it, { pushOk: false, pushErr: '' }))) {
      stat.skipped++;
      continue;
    }
    touched.add(it.fid);

    if (!(await spend(it._openid))) {
      await finish(it._id, { pushOk: false, pushErr: 'no-quota' });
      stat.noQuota++;
      continue;
    }

    try {
      await push(it);
      await finish(it._id, { pushOk: true, pushErr: '' });
      stat.sent++;
    } catch (err) {
      const code = (err && (err.errCode || err.errMsg)) || 'send-fail';
      await finish(it._id, { pushOk: false, pushErr: String(code).slice(0, MAX_ERR) });
      stat.failed++;
    }
  }

  for (const fid of touched) {
    await bumpRev(fid);
  }

  return { ok: true, data: stat };
};
