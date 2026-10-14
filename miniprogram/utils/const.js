// miniprogram/utils/const.js
// 项目的「协议常量」集中地：象限文案、布局常量、云函数协议版本与同步节奏。
//
// 为什么单独成文件：
//   这些值的**唯一权威来源**是别处 —— 象限文案来自设计稿，布局常量来自
//   index.wxss，FN_VER 来自 cloudfunctions/fqTodo/index.js。它们分散在
//   2300 行的页面文件里时，改 wxss 的人根本不会想到这里还有一份镜像。
//   集中到一处，「哪些东西必须成对修改」这件事才有地方写下去。
//
// 本文件只放常量，不放任何有副作用的代码（不发请求、不碰 wx、不读写状态）。

/* ---------------- 象限 ---------------- */

// 象限文案唯一来源：QUADS 是列表，QUAD_MAP 是按 key 查。
// 顺序即「总览页 2×2 矩阵的阅读顺序」：左上 → 右上 → 左下 → 右下。
const QUADS = [
  { key: 'q1', name: '重要且紧急', hint: '立刻做' },
  { key: 'q2', name: '不重要但紧急', hint: '授权出去' },
  { key: 'q3', name: '重要不紧急', hint: '排进日程' },
  { key: 'q4', name: '不重要也不紧急', hint: '划掉它' },
];

const QUAD_MAP = QUADS.reduce(function (m, q) {
  m[q.key] = q;
  return m;
}, {});

/* ---------------- 布局 ---------------- */

// 布局常量（单位 rpx），与 index.wxss 顶部注释里的同名常量一一对应。
// ⚠️ 自 2026-10-09 起，这里**没有一个常量参与运行期计算**了：
//    TAB_H 原先用来算 FAB 的悬浮偏移，而 FAB 现在挂在矩阵容器里、偏移量是常数。
//    保留整张表是为了让 WXSS 里的固定高度有个单一说明来源 ——
//    改 index.wxss 顶部那行数字时，这里要成对改（拖动那几个仍然在用，见下）。
const LAYOUT = {
  NAV_H: 88,
  CATS_H: 88,
  STATS_H: 112,
  TAB_H: 120,
  BOTTOM_H: 134,
  // 拖动排序用：.row 的 margin-bottom，以及左滑面板的宽度
  ROW_GAP: 16,
  SWIPE_W: 240,     // 左滑面板：完成 / 删除 各 120rpx，两种视图一致
  // 「拖到屏幕边缘、列表自己滚」用（单位 px，不是 rpx —— 这里比的是 clientY）：
  // DRAG_EDGE = 距滚动区上下边多少像素算进入边缘区；AS_STEP / AS_TICK = 每拍滚多远、隔多久。
  DRAG_EDGE: 96,
  AS_STEP: 14,
  AS_TICK: 40,
};

// 排序用的稀疏步长：每次重排都写成 0 / 10 / 20…，留出插入空间也便于人工核对
const ORDER_STEP = 10;
// 一次重排最多提交多少条（云函数侧同样有上限）
const REORDER_CAP = 200;

/* ---------------- 云函数协议 ---------------- */

// 云函数协议版本，必须与 cloudfunctions/fqTodo/index.js 的 FN_VER 相等。
// 云函数新增/删除 action 时两边一起 +1，首屏握手就能发现「云端还是旧包」。
// v3：引入共享家庭（归属键从 _openid 变成 fid），新增 sync / 家庭管理系列 action。
// v4：分类支持删除与改名，新增 removeCategory / renameCategory。
// v5：提醒推送，新增 grantSub（攒订阅额度）；保存带提醒的事项时顺手请求一次授权。
// v6：日程版块，新增 savePlan（按日期存「这一天要做什么」，空文本即删除）；
//     bootstrap / sync 多回一个 plans 字段。
// v7：事项进度条。fq_items 多出 progress（0~100），且 updateItem 里多了
//     「done ⟺ progress === 100」这条耦合。**没有新增 action 也照样 +1** ——
//     旧云函数不认识 progress，客户端拖完看着生效、一刷新全回 0%，正是握手要拦的
//     那类静默故障。
// v8：可配置的提前提醒时长。fq_items 多出 leadMin / pushAt 一对字段，
//     fqRemind 的扫描条件从 remindAt 换成 pushAt。同样**没有新增 action** ——
//     旧云函数不认识 leadMin，表现是「选好的提前量重进一次就变回 30 分钟」。
//     ⚠️ fqRemind 不在 action 清单里，握手管不到它，改完要记得单独重新部署。
// v9：提醒周期（只提醒一次 / 每天提醒）。fq_items 多出 repeat 字段，fqRemind
//     多出一套「发完把 pushAt 滚到下一个整天」的循环逻辑。还是**没有新增 action**
//     —— 旧云函数不认识 repeat，表现是「选了每天提醒，第二天就再也不响了」。
//     ⚠️ fqRemind 这次同样必须单独重新部署：它不在 action 清单里，握手管不到它。
const FN_VER = 9;

// 自动同步的轮询间隔。页面可见时每 8 秒问一次「家庭数据变了没」，
// 云函数只回一个 rev 数字，没变就是几十字节。
// 为什么不用客户端 watch()：那要求把集合读权限放开给客户端，等于破掉
// 「云函数是唯一数据出口」这条底线（见云函数头部铁律二）。两人用，轮询完全够。
const SYNC_MS = 8000;

// 这些 action 会改数据。计数是为了让自动同步给它们让路 ——
// 本地已经改完、页面也重绘了，但云端还没落库，这时如果同步把服务端快照拉回来覆盖，
// 用户会看到自己刚点的那一下被弹回去（几秒后才自愈，属于最招人烦的那类抖动）。
// 消费者：services/cloud.js（写操作进出各记一笔）、页面 syncTick（>0 就让路）。
const WRITE_ACTIONS = [
  'addItem', 'updateItem', 'removeItem', 'reorder', 'bulk', 'clearDone', 'clearAll',
  'addCategory', 'removeCategory', 'renameCategory', 'savePlan',
  'genInvite', 'joinFamily', 'leaveFamily', 'renameMember', 'renameFamily',
  // grantSub 也改云端状态（额度）。它不在数据快照里，但同样要占住
  // pendingWrites —— 否则同步回来的 sub 会把这刚攒的那条盖回旧值。
  'grantSub',
];

/* ---------------- 提醒推送 ---------------- */

// 提前提醒时长的选项。**值必须与 fqTodo / fqRemind 的 LEAD_ALLOWED 完全一致**，
// 三处一起改（云函数不能 require 本文件，两个云函数之间也不共享，只能各留一份；
// test-remind.js 会读三份源码逐一比对，漏改一处就红）。
//
// ⚠️ -1 是「不提醒」的哨兵值，**不是「提前 0 分钟」**。理由写在 fqTodo 的
// LEAD_ALLOWED 上面：0 若是个合法档位，脏值回落就会把提醒静默关掉。
//
// 单位是分钟。超过 1 天的几档不是凑数 —— 「提前一周提醒我交房租」靠的就是它们，
// 也是这次改造最主要的收益（原先写死 10 分钟时，长周期事项根本提醒不到）。
const LEAD_OPTIONS = [
  { v: -1, label: '不提醒' },
  { v: 5, label: '提前 5 分钟' },
  { v: 10, label: '提前 10 分钟' },
  { v: 30, label: '提前 30 分钟' },
  { v: 60, label: '提前 1 小时' },
  { v: 180, label: '提前 3 小时' },
  { v: 1440, label: '提前 1 天' },
  { v: 4320, label: '提前 3 天' },
  { v: 10080, label: '提前 7 天' },
  { v: 43200, label: '提前 30 天' },
];

// 没设过提前量时的默认档（30 分钟）。与两个云函数的 LEAD_DEFAULT 相同。
// v8 之前的老数据也没有这个字段，读到 undefined 时一律按它兜底。
const LEAD_DEFAULT = 30;

// 「每天提醒」模式下提前量的上限（分钟）。与 fqTodo 的 LEAD_DAILY_MAX 成对。
// 客户端藏档位只是体验，云端还会再夹一次（前端能绕过，后端不能信任）。
const LEAD_DAILY_MAX = 180;

/* ---------------- 提醒周期（v9） ---------------- */

// 0 = 只提醒一次（默认），1 = 每天提醒。
//
// ⚠️ 为什么「每天提醒」要把提前量收到 1 天以内（LEAD_DAILY_MAX）：
//    「每天提醒」+「提前 30 天」字面读出来是「提前 30 天起、每天推一条」——
//    等于连推 30 条同一件事。而会用到「每天提醒」的场景（吃药、锻炼、喂水、
//    喂猫）本来就不需要提前几天，所以直接把这组档位收掉，比让用户自己承担
//    这个组合的后果干净。
//    夹取的失败方向也是安全的：从「提前 30 天」夹到「提前 3 小时」是**发得晚**
//    而不是**不发**，用户看得见也改得回来（与 -1 哨兵那条同一个原则）。
const REPEAT_OPTIONS = [
  { v: 0, label: '只提醒一次' },
  { v: 1, label: '每天提醒' },
];

// 没设过的（含 v9 之前的老数据）一律按「只提醒一次」兜底。
const REPEAT_DEFAULT = 0;

/* ---------------- 今日饮水 ---------------- */

// 每日饮水目标（ml）。唯一来源：页面传给组件 fq-water 的 goal，组件默认值也读这里。
// ⚠️ fq-water.wxss 里那 3 道刻度写死的是 25% / 50% / 75%（即 500 / 1000 / 1500 ml），
// 改这个数**不会**自动挪刻度 —— 目标不再等于 2000 时，要么同步改那 3 个 left，
// 要么把刻度改成算出来的。拖动吸附档位也跟着目标走（40 档 = 50ml/档）。
const WATER_GOAL = 2000;

// 本地存储的 key 前缀。饮水量按「日期」各存一条（fq_water_2026-10-09），
// 于是「每天零点清零」不需要任何定时任务 —— 跨天读到的就是一个空 key。
// 只存本机（不上云）：饮水是个人身体指标，没有全家共享的意义，
// 也因此不占用云函数 action、不牵动 FN_VER。
const WATER_KEY = 'fq_water_';

/* ---------------- 日程 ---------------- */

// 一天的日程计划最多多少字。与云函数 fqTodo 的 MAX_PLAN 成对 ——
// 客户端限的是输入框，云端限的是入库，两道都要有（前端能绕过，后端不能信任）。
const PLAN_MAX = 300;

// 月历固定 6 行 × 7 列 = 42 格，无论当月实际需要几行都补满。
// 理由写在 components/fq-cal 的头注释里：高度稳定是高频切换组件的第一要求。
const CAL_CELLS = 42;

/* ---------------- 日期 ---------------- */

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 月历表头用单字（一 二 三 四 五 六 日），顺序是**周一起始**。
// 与 WEEK 不是一回事：WEEK 按 Date.getDay() 的 0=周日 排，直接拿来当表头会错位一列。
const WEEK_MON = ['一', '二', '三', '四', '五', '六', '日'];

module.exports = {
  QUADS: QUADS,
  QUAD_MAP: QUAD_MAP,
  LAYOUT: LAYOUT,
  ORDER_STEP: ORDER_STEP,
  REORDER_CAP: REORDER_CAP,
  FN_VER: FN_VER,
  SYNC_MS: SYNC_MS,
  WRITE_ACTIONS: WRITE_ACTIONS,
  LEAD_OPTIONS: LEAD_OPTIONS,
  LEAD_DEFAULT: LEAD_DEFAULT,
  LEAD_DAILY_MAX: LEAD_DAILY_MAX,
  REPEAT_OPTIONS: REPEAT_OPTIONS,
  REPEAT_DEFAULT: REPEAT_DEFAULT,
  WATER_GOAL: WATER_GOAL,
  WATER_KEY: WATER_KEY,
  PLAN_MAX: PLAN_MAX,
  CAL_CELLS: CAL_CELLS,
  WEEK: WEEK,
  WEEK_MON: WEEK_MON,
};
