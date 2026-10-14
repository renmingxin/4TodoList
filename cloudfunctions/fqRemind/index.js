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
//   fq_items  { ..., _openid, fid, title, note, quad, catId, remindAt, leadMin, pushAt,
//               repeat, pushed, pushedAt, pushOk, pushErr }
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
// · 一条提醒只发一次。发出去之后用户改了提醒时间 / 提前量 / 周期，由 fqTodo 的
//   updateItem 把 pushed 复位、pushAt 重算，它才重新排进队列（见那边「提醒这一组」）。
//   ⚠️ v9 的「每天提醒」是这条的例外，而且是**必须的例外**：它的 pushed 一直
//   保持未处理态（下一轮 tick 还要再发它），去重改由 pushAt 承担 —— 详见 claim。
// · 「每天提醒」每天消耗一条额度。用户点一次「允许」只攒一条发送权，所以
//   从第二天起就会开始缺额度，表现为每天记一条 no-quota。这不是 bug，是一次性
//   订阅这个前提下的必然结果；客户端的「我的」页给了一个补额度入口
//   （wx.requestSubscribeMessage 必须由用户点击触发，不能自动弹）。

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

// ⚠️ v8 起这里**没有全局提前量**了：每条事项各带一个 leadMin，推送时刻由
// fqTodo 预算成 pushAt 落库，本函数只按 pushAt 扫（见 fetchDue）。
// 下面这对常量如今只服务「老数据回填」（backfillPushAt）—— 那批文档没有
// leadMin，得按默认值补，而这个默认值必须与 fqTodo 的 LEAD_DEFAULT 完全一致，
// 否则升级那一刻同一批数据会在两边算出不同的推送时刻。
// 三份白名单（fqTodo / 本文件 / utils/const.js）由 test-remind.js 读源码比对。
const LEAD_ALLOWED = [-1, 5, 10, 30, 60, 180, 1440, 4320, 10080, 43200];
const LEAD_DEFAULT = 30;

// 提醒周期：1 = 每天提醒（0 是「只提醒一次」，也是缺省）。
// 与 fqTodo 的 REPEAT_DAILY、utils/const.js 的 REPEAT_OPTIONS 一致。
// ⚠️ 本函数不校验提前量上限（那是 fqTodo 的 toLead 夹的），所以这里
// **不需要** LEAD_DAILY_MAX —— 少一个要在三处同步的常量。
const REPEAT_DAILY = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

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

// 提前量净化 + 推送时刻推算。与 fqTodo 里的同名函数**同源**，靠 test-remind
// 读源码比对防漂移。回填老数据时必然用到，所以放在这里而不是内联：
// 让「两边算法相同」这件事在源码层面看得见、也测得到。
//
// ⚠️ toLead 比 fqTodo 那份**少一个 repeat 参数**，这是有意的：本函数用它只做
// 老数据回填，而那批文档一律是 v8 之前建的、全是「仅一次」，不存在
// 「每天提醒要把提前量夹到 1 天以内」这个场景。挂一个永远传 0 的参数，
// 只会让「两边签名为什么不一样」变成一个以后要反复解释的问题。
function toLead(v) {
  const n = Math.round(Number(v));
  return LEAD_ALLOWED.indexOf(n) >= 0 ? n : LEAD_DEFAULT;
}

function toPushAt(remindAt, leadMin) {
  const at = Number(remindAt);
  if (!Number.isFinite(at) || at <= 0) return null;
  if (leadMin === -1) return null;
  return at - leadMin * 60000;
}

// 「每天提醒」的下一次推送时刻：从当前 pushAt 起，按整天往前挪到
// **严格大于 now** 的第一个时刻。
//
// 为什么是「挪到下一个未来时刻」而不是简单 +1 天：云函数停过几天、或者用户
// 刚把「一次」改成「每天」时，pushAt 可能已经过去很久。若只 +1 天，它仍旧
// 在过去 → 下一轮又判一次 → 要连跑好几天才追上现在。
// 用除法一次算出该跳几天，而不是 while 累加 —— 极端情况下（一条 2020 年的
// 提醒）while 要转两千圈，除法一圈都不用。
// 取 floor + 1 而不是 ceil，是为了保证结果**严格大于** now：等于 now 的话
// 下一轮 tick 还会把它捞出来，白白多跑一轮。
function nextDailyPushAt(pushAt, now) {
  const at = Number(pushAt);
  if (!Number.isFinite(at) || at <= 0) return null;
  if (at > now) return at; // 还没到点，不用动
  const k = Math.floor((now - at) / DAY_MS) + 1;
  return at + k * DAY_MS;
}

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

async function fetchDue(now) {
  const out = [];
  let skip = 0;
  for (let i = 0; i < CAP / PAGE; i++) {
    const res = await db
      .collection(COL_ITEMS)
      .where({
        // 必须是 and(gt(0), lte(now))，不能只写 lte(now)：
        // pushAt 为 null 的文档（= 选了「不提醒」或压根没设提醒时间）在 $lte 下
        // 也会被捞出来（null 在类型序里排在数字之前），白占分页窗口。
        //
        // ⚠️ 千万不要改回「remindAt + 固定提前量」：每条事项的提前量各不相同，
        // 单一窗口表达不了（完整理由见 fqTodo 的 toPushAt 注释）。
        pushAt: _.and(_.gt(0), _.lte(now)),
        // 用 neq(true) 而不是等值 false：升级上来的老文档没有这个字段，
        // 等值条件挑不到它们，那批提醒就永远不会被处理。
        pushed: _.neq(true),
        done: _.neq(true),
      })
      .orderBy('pushAt', 'asc')
      .skip(skip)
      .limit(PAGE)
      .get();
    out.push(...res.data);
    if (res.data.length < PAGE) break;
    skip += PAGE;
  }
  return out;
}

// 老数据回填：v8 之前没有 pushAt 字段（那时提前量是全局常量，用不着预计算），
// fqRemind 改按 pushAt 扫之后，这批提醒会**一条都挑不到**。
//
// 为什么不要求用户手动迁移：这是典型的「静默漏掉」—— 用户不会知道自己
// 有 30 条提醒不再生效了。每轮 tick 顺手补一页，补过之后就挑不到它们了，
// 开销随老数据减少而趋近于零。
//
// ⚠️ 判据用 **leadMin 缺失**，不是 pushAt 缺失：选了「不提醒」的新数据
// pushAt 落的是 null（字段存在、值为空），拿 pushAt 当判据会反复扫到它、
// 无限回填。leadMin 和 pushAt 是同一次改动引入的，两者必同生同灭，
// 所以 leadMin 缺失 ⇔ 老数据，这个判据是干净的。
//
// 用**默认提前量**补齐：老数据一定也没 leadMin，没有更好的信息可依据。
// ⚠️ 副作用是有意的、需要记住的：存量事项的提前量会从原来写死的 10 分钟
// 变成 30 分钟 —— 否则「默认 30 分钟」这条规则对老用户就不成立。
async function backfillPushAt() {
  let fixed = 0;
  // 单轮最多补 5 页，避免某次 tick 长时间占着。触发器每分钟就来一次，足够补完。
  for (let round = 0; round < 5; round++) {
    let res;
    try {
      res = await db
        .collection(COL_ITEMS)
        .where({
          leadMin: _.exists(false),
          remindAt: _.and(_.gt(0)),
          pushed: _.neq(true),
          done: _.neq(true),
        })
        .limit(PAGE)
        .get();
    } catch (e) {
      return fixed;
    }
    if (!res.data.length) break;

    for (const it of res.data) {
      const at = Number(it.remindAt);
      const lead = toLead(it.leadMin); // 缺失 → 回落 LEAD_DEFAULT
      try {
        await db.collection(COL_ITEMS).doc(it._id).update({
          data: { leadMin: lead, pushAt: toPushAt(at, lead) },
        });
        fixed++;
      } catch (e) {
        /* 单条补不上不拖崩整轮，下一轮还会再来捡它 */
      }
    }
    if (res.data.length < PAGE) break;
  }
  return fixed;
}

// 抢锁。返回 true 表示「这一条归我了」。
// 触发器重复触发时，两条并发实例里只有一条能拿到 stats.updated === 1，
// 另一条拿到 0 —— 这就是去重，不需要额外的锁表。
//
// ⚠️ 第三个参数 nextAt 是「每天提醒」的专用路径，也是这里唯一会咬人的地方。
//
//   普通提醒靠「写入 pushed: true」去重：条件里的 `pushed: neq(true)` 在写入
//   之后就不再成立，第二条并发实例自然拿到 updated: 0。干净。
//
//   但每天提醒**不能**把 pushed 写成 true —— 它下一轮 tick 还要再发，必须保持
//   未处理态（fetchDue 的条件里也有 neq(true)）。而那个条件在写入前后**都成立**，
//   于是两条并发实例会双双拿到 updated: 1：同一件事被推两遍，额度也被扣两次。
//   所以改成「拿 pushAt 当版本号」：条件里带上我刚读到的那个 pushAt，
//   第一条把它滚到下次之后，第二条的 where 就不再匹配了。
//
//   滚动与「保持未处理态」必须在**同一次 update** 里完成。拆成两次写会留下中间态
//   （已经滚走了、pushed 却仍是 true），那条提醒就永远不再响了 —— 而且不报错。
async function claim(item, patch, nextAt) {
  const where = { _id: item._id, done: _.neq(true) };
  const data = Object.assign({ pushedAt: db.serverDate() }, patch);
  if (nextAt) {
    where.pushAt = item.pushAt;
    data.pushAt = nextAt;
    data.pushed = false;
  } else {
    where.pushed = _.neq(true);
    data.pushed = true;
  }
  try {
    const res = await db.collection(COL_ITEMS).where(where).update({ data: data });
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

  // 通知里显示的「提醒时间」用**本次实际的提醒时刻** = pushAt + 提前量，
  // 而不是 item.remindAt。对「只提醒一次」两者永远相等（pushAt 本来就是从
  // remindAt 减出来的），但对「每天提醒」就分道扬镳了：remindAt 是用户设的
  // **起点**、一直不动，pushAt 才是滚到今天的那个时刻。用 remindAt 会在
  // 10 月 20 日这天告诉用户「提醒时间 2026-10-15 09:00」，白白让人以为发错了。
  // lead ≤ 0（选「不提醒」时是 -1）不会走到这里 —— 那种条目 pushAt 是 null，
  // 挑不进候选；这里仍然夹一道，免得算出个 NaN 把整条消息打成 47003。
  const lead = toLead(item.leadMin);
  const pushMs = Number(item.pushAt) + (lead > 0 ? lead : 0) * 60000;

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
      time23: { value: fmtTime(pushMs) },                       // 提醒时间
    },
  });
}

/* ---------------- 入口 ---------------- */

exports.main = async () => {
  const now = Date.now();
  // 顺序不能反：先把老数据补上 pushAt，再按 pushAt 扫。
  // 反过来的话，刚升级的那一轮会把存量提醒整批漏掉（它们本来就不在扫描范围里）。
  const backfilled = await backfillPushAt();
  const rows = await fetchDue(now);
  const stat = {
    scanned: rows.length,
    backfilled: backfilled,
    sent: 0,
    // expired 与 rolled 是两件事，别合并计数：
    // expired = 该发没发成（用户要看见的「未送达」），
    // rolled  = 每天提醒按计划滚到下一轮（正常行为，不该报给用户）。
    expired: 0,
    rolled: 0,
    noQuota: 0,
    failed: 0,
    skipped: 0,
  };
  const touched = new Set();

  for (let i = 0; i < rows.length; i++) {
    const it = rows[i];
    // 判据是 pushAt，不是 remindAt：现在「该发的时刻」由每条自己的提前量决定，
    // remindAt 只是它的一个输入。到期容忍也跟着改按 pushAt 算 ——
    // 一条提前 7 天的事项迟到 6 天仍旧该发，而按 remindAt 判反而会说「还没到期」。
    const at = Number(it.pushAt);
    if (!Number.isFinite(at) || at <= 0) continue;

    // 「每天提醒」的下次时刻必须先算出来：下面三条路（过期 / 正常 / 发送失败）
    // 都得把它交给 claim 去滚。漏掉任何一条，那条提醒都会卡死在原地不再响。
    const nextAt = it.repeat === REPEAT_DAILY ? nextDailyPushAt(at, now) : null;

    // 早就过点了：容器冷启动、触发器漏跑都会造成这个。
    // 不补发，但也不静默丢弃 —— 记成未送达。
    //
    // ⚠️ 每天提醒在这里要分开处理：它的 pushAt 停在一个过去的时刻是**设计内**
    // 的状态（用户刚把「一次」改成「每天」，或者云函数停了几天），滚到下一个
    // 整天就完事了，不该记成「未送达」—— 那会让用户在「我的」页看到一条根本
    // 不存在的失败。所以 pushErr 置空，只留 pushedAt 表示「处理过」。
    if (at < now - LATE_MS) {
      const rolled = !!nextAt;
      if (await claim(it, { pushOk: false, pushErr: rolled ? '' : 'expired' }, nextAt)) {
        if (rolled) stat.rolled++;
        else stat.expired++;
        touched.add(it.fid);
      }
      continue;
    }

    if (!(await claim(it, { pushOk: false, pushErr: '' }, nextAt))) {
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
