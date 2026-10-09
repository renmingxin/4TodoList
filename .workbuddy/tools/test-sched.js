// .workbuddy/tools/test-sched.js
// 日程版块（v6）· 逻辑仿真
//
// 为什么单独一个文件：日程的**日期运算全是纯函数**，住在 utils/format.js 与页面的
// buildCal / buildPlan / buildSchedRows 里。test-reorder 管拖动/左滑，test-cloudfn 管云函数，
// test-water 管饮水 —— 上面四个都对「42 格怎么排、跨月怎么进位、今天-明天怎么说」一无所知。
//
// 而这一类错误的特点是**不报错**：
//   · 排错一格  → 日历整体错位，看起来"只是有点怪"；
//   · 时区算错  → iOS 上整块日历退一天（`new Date('2026-10-09')` 按 UTC 解析）；
//   · 标签写错  → 卡片记得是明天、标题却说「后天准备做什么」，一个会让人读错的谎；
//   · 圆点与列表两套口径 → 「有圆点但列表是空的」这种没人解释得通的状态。
// 所以这一组钉的是这些，而不是「函数能跑通」。
//
// ⚠️ 本文件第一版就跑出过一个真实缺陷：`buildPlan` 收了 addDays 之后的日期、
//    又去取 `planLabels(...)[1]`（那是「次日」的标题），于是第二张卡的标题整整错一天。
//    —— 加断言之前先想清楚「我期望的值是从哪个定义推出来的」，否则只是在固化自己的误解。
//
// 两个来源的实际取法（与项目里其它检查同一个原则：按**语义**挑源码）：
//   · 纯函数 → 真 require utils/format.js（无需沙箱）
//   · 页面侧 → 真 require index.js（假 Page / wx，跑真实方法，不复制逻辑）
//
// 运行：node .workbuddy/tools/test-sched.js   （失败退出码 1）

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MP = path.join(ROOT, 'miniprogram');
const FMT = require(path.join(MP, 'utils', 'format.js'));
const CONST = require(path.join(MP, 'utils', 'const.js'));
const C_JS = path.join(MP, 'utils', 'const.js');
const CF_JS = path.join(ROOT, 'cloudfunctions', 'fqTodo', 'index.js');
const P_JSON = path.join(MP, 'pages', 'index', 'index.json');
const P_WXML = path.join(MP, 'pages', 'index', 'index.wxml');
const TB_WXML = path.join(MP, 'components', 'fq-tabbar', 'fq-tabbar.wxml');

const {
  todayStr, parseDay, addDays, dayDiff, dayKey, hhmm,
  dayWord, ymOf, monthLabel, mdShort, dateCN, planLabels,
} = FMT;

let pass = 0;
let fail = 0;

function ok(cond, label) {
  if (cond) pass++;
  else {
    fail++;
    console.log('  ✗ ' + label);
  }
}
function eq(got, want, label) {
  ok(got === want, label + '（得到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want) + '）');
}
function section(t) {
  console.log(t);
}

const TODAY = todayStr();
// 用于「排布」的固定月份（只关心网格形状，与今天是哪天无关）
const DAY = '2026-10-09';
// ⚠️ 凡是要断言「这不是今天」的地方都必须用远期日期：
//    DAY 恰好等于跑测试那天的日期（这个项目就在 2026-10-09 上开发），
//    拿 DAY 当「非今天」会让两条断言假绿。
const FAR = '2030-06-15';

/* ================= ① 纯日期函数 ================= */

section('【① 常量与月份排布的原料】');
eq(CONST.CAL_CELLS, 42, '月历固定 42 格（6 行 × 7 列）');
eq(CONST.WEEK_MON.length, 7, 'WEEK_MON 是 7 个');
eq(CONST.WEEK_MON[0], '一', 'WEEK_MON 从**周一**起（getDay() 的 0 是周日，两者不是一回事）');
eq(CONST.WEEK_MON[6], '日', 'WEEK_MON 周日排在最后');
ok(CONST.WEEK_MON.join('') !== CONST.WEEK.join(''), 'WEEK_MON 与 WEEK 确实是两套排法（直接用错会整体错开一列）');

section('');
section('【② addDays：跨月 / 跨年 / 闰年全部交给 Date 进位】');
eq(addDays('2026-10-31', 1), '2026-11-01', '跨月：10-31 +1');
eq(addDays('2026-11-01', -1), '2026-10-31', '跨月反向：11-01 -1');
eq(addDays('2026-12-31', 1), '2027-01-01', '跨年：12-31 +1');
eq(addDays('2026-01-01', -1), '2025-12-31', '跨年反向：01-01 -1');
eq(addDays('2024-02-28', 1), '2024-02-29', '闰年：2024-02-28 +1 是 29 日');
eq(addDays('2026-02-28', 1), '2026-03-01', '平年：2026-02-28 +1 直接进 3 月');
eq(addDays('2024-02-29', 1), '2024-03-01', '闰日再 +1 也正确');
eq(addDays(DAY, 0), DAY, '加 0 天是恒等');
eq(addDays(addDays(DAY, 40), -40), DAY, '加 N 再减 N 回到原点（跨月也不漂）');

section('');
section('【③ 本地时区：绝不走 UTC】');
eq(dayDiff(TODAY), 0, '今天是 0');
eq(dayDiff(addDays(TODAY, 1)), 1, '明天是 1');
eq(dayDiff(addDays(TODAY, -1)), -1, '昨天是 -1');
{
  // 东八区晚上 21:00 的提醒必须落在**今天**。用 toISOString() 实现的版本
  // 会把它算到明天去（UTC 已跨日），于是「今晚的提醒」出现在明天的格子里。
  const d = new Date();
  const ts = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 21, 0, 0).getTime();
  eq(dayKey(ts), TODAY, '本地 21:00 的时间戳算今天（用 toISOString 会错到明天）');
  const ts0 = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 5, 0).getTime();
  eq(dayKey(ts0), TODAY, '本地 00:05 也算今天（不会退到昨天）');
}
eq(dayKey(parseDay(DAY).getTime()), DAY, '日期 → 时间戳 → 日期 往返一致（没有时区漂移）');
eq(hhmm(new Date(2026, 9, 9, 9, 5).getTime()), '09:05', 'hhmm 补零');
eq(hhmm(new Date(2026, 9, 9, 23, 59).getTime()), '23:59', 'hhmm 不缺位');
eq(dayKey(undefined), '', '非数字时间戳 → 空串');
eq(dayKey('abc'), '', '完全不是数字 → 空串（不会输出 NaN-NaN-NaN）');
// ⚠️ 注意 dayKey(0) 得到的是 1970-01-01（Number('') 是 0，不是 NaN）——
//    「提醒时间为 0」这件事由**调用方**的 `if (!it.remindAt) return;` 挡住，
//    见下面【⑨】里那条 remindAt=0 的事项。两条闸都要在。

section('');
section('【④ 显示文案】');
eq(ymOf(DAY), '2026-10', "ymOf 取 'YYYY-MM'");
eq(monthLabel('2026-10'), '2026 年 10 月', 'monthLabel 去掉前导零');
eq(monthLabel('2026-01'), '2026 年 1 月', 'monthLabel 1 月不写 01');
eq(mdShort(DAY), '10/9', 'mdShort 不补零（卡角上给人看的短日期）');
eq(mdShort('2026-10-31'), '10/31', 'mdShort 两位数日期');
{
  const d = parseDay(DAY);
  eq(dateCN(DAY), '10月9日 ' + CONST.WEEK[d.getDay()], 'dateCN 的星期由 Date 推，不硬编码');
  eq(CONST.WEEK[new Date(2026, 9, 9).getDay()], '周五', '2026-10-09 确实是周五（交叉验证上面的推算）');
}

section('');
section('【⑤ planLabels：一对标题描述「某天」与「它的次日」】');
{
  const l0 = planLabels(0);
  eq(l0[0], '今天要做什么', '差 0：[0] 是今天');
  eq(l0[1], '明天准备做什么', '差 0：[1] 是次日，即明天');
  eq(planLabels(1)[0], '明天要做什么', '差 1：[0] 递到明天');
  eq(planLabels(1)[1], '后天准备做什么', '差 1：[1] 递到后天');
  const lm = planLabels(-1);
  eq(lm[0], '昨天做了什么', '差 -1：时态改成过去（「要做什么」是错的）');
  eq(lm[1], '今天要做什么', '差 -1：[1] 回到今天');
  eq(planLabels(5)[0], '这天要做什么', '差 +5：不再冒充今天/明天');
  eq(planLabels(5)[1], '次日准备做什么', '差 +5：[1] 说「次日」');
  eq(planLabels(-9)[0], '这天做了什么', '差 -9：过去时');
  eq(planLabels(-9)[1], '次日做了什么', '差 -9：[1] 也是过去时');
  ok(planLabels(5).join('').indexOf('今天') < 0, '远日子上两个标题都不该出现「今天」');
}
eq(dayWord(0), '今天', 'dayWord(0)');
eq(dayWord(1), '明天', 'dayWord(1)');
eq(dayWord(2), '后天', 'dayWord(2)');
eq(dayWord(7), '这一天', 'dayWord 超出今天/明天/后天就退回「这一天」，不瞎猜');

/* ================= 页面侧：真跑 index.js ================= */

section('');
section('【⑥ 页面沙箱启动】');

const timers = [];
global.setTimeout = function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; };
global.clearTimeout = function (id) { if (id) timers[id - 1] = null; };
global.setInterval = function () { return 1; };
global.clearInterval = function () {};

const cloudCalls = [];
const modalCalls = [];
let pageDef = null;

global.Page = function (obj) { pageDef = obj; };
global.wx = {
  cloud: {
    callFunction(opts) {
      cloudCalls.push(opts.data);
      return Promise.resolve({ result: { ok: true, data: { updated: 1 } } });
    },
  },
  setNavigationBarColor() {},
  showToast() {},
  showModal(opts) { modalCalls.push(opts); },
  vibrateShort() {},
  getStorageSync() { return 0; },
  setStorageSync() {},
  getWindowInfo() {
    return { windowWidth: 375, windowHeight: 700, screenHeight: 812, statusBarHeight: 44, safeArea: { bottom: 778 } };
  },
  getMenuButtonBoundingClientRect() { return { left: 280 }; },
  createSelectorQuery() {
    const q = {
      in() { return q; }, select() { return q; }, selectAll() { return q; },
      boundingClientRect() { return q; }, exec(cb) { if (cb) cb([]); },
    };
    return q;
  },
};

require(path.join(MP, 'pages', 'index', 'index.js'));
ok(!!pageDef, 'index.js 能加载并交出 Page 配置');

const CAT = 'c1';

function mkItem(id, quad, done, remindAt, title) {
  return {
    _id: id, quad: quad, done: !!done, remindAt: remindAt || 0,
    title: title || id, catId: CAT, order: 100, priority: 3,
  };
}

// 选中某一天的日程页实例
function sctx(items, plans, date) {
  const p = Object.create(pageDef);
  p.cats = [{ _id: CAT, name: '工作', order: 0 }];
  p.items = items || [];
  p.plans = plans || {};
  p.state = {
    view: 'sched', catId: '', quad: 'q1', filt: 'all',
    schedYm: ymOf(date), schedDate: date,
  };
  p.data = JSON.parse(JSON.stringify(pageDef.data));
  p.setData = function (patch, cb) {
    Object.assign(p.data, patch);
    if (typeof cb === 'function') cb.call(p);
  };
  p.render();
  return p;
}

function at(dateStr, h, mi) {
  return new Date(
    Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1, Number(dateStr.slice(8, 10)),
    h === undefined ? 9 : h, mi || 0, 0, 0
  ).getTime();
}
function countOf(arr, fn) {
  return arr.filter(fn).length;
}

ok(!!pageDef.buildCal && !!pageDef.buildPlan && !!pageDef.buildSchedRows, '页面确实有那三个派生方法');

/* ================= ⑦ 42 格排布 ================= */

section('');
section('【⑦ 月历 42 格：周一起始 + 连续 42 天】');
{
  const p = sctx([], {}, DAY);
  const cells = p.buildCal();
  eq(cells.length, CONST.CAL_CELLS, '产出的格子数 === CAL_CELLS');
  eq(cells[0].k, '2026-09-28', '2026-10 首格是上周一（2026-10-01 是周四 → 前补 3 格）');

  let contiguous = 0;
  for (let i = 1; i < cells.length; i++) {
    if (addDays(cells[i - 1].k, 1) === cells[i].k) contiguous++;
  }
  eq(contiguous, cells.length - 1, '42 格是**连续**的 42 天（跨月不用单独判）');

  let allMonday = true;
  let allSunday = true;
  for (let i = 0; i < cells.length; i += 7) {
    if (parseDay(cells[i].k).getDay() !== 1) allMonday = false;
    if (parseDay(cells[i + 6].k).getDay() !== 0) allSunday = false;
  }
  ok(allMonday, '周一起始：每行第一个格子都是周一');
  ok(allSunday, '每行最后一格都是周日');
}
{
  const p = sctx([], {}, DAY);
  const cells = p.buildCal();
  const own = cells.filter(function (c) { return !c.other; });
  eq(own.length, 31, '2026-10 有 31 天，other=false 的格子正好 31 个');
  eq(own[0].k, '2026-10-01', 'other=false 从 1 号开始');
  eq(own[own.length - 1].k, '2026-10-31', 'other=false 到月末结束');
  eq(cells[0].other, true, '首格属于上月 → other=true');
  eq(cells[cells.length - 1].other, true, '末格属于下月 → other=true');
  eq(cells.filter(function (c) { return c.n === 1 && !c.other; })[0].k, '2026-10-01', '每格的 n 是「几号」，与 k 对得上');
}
{
  const p = sctx([], {}, '2026-02-10');
  const cells = p.buildCal();
  eq(countOf(cells, function (c) { return !c.other; }), 28, '平年 2 月 → 28 个当月格');
  eq(cells[0].k, '2026-01-26', '2026-02-01 是周日 → 首格是 2026-01-26（周一）');
}
{
  const p = sctx([], {}, '2024-02-10');
  const cells = p.buildCal();
  eq(countOf(cells, function (c) { return !c.other; }), 29, '闰年 2 月 → 29 个当月格');
  eq(cells[0].k, '2024-01-29', '2024-02-01 是周四 → 首格是 2024-01-29');
  ok(cells.some(function (c) { return c.k === '2024-02-29'; }), '闰日 2/29 在网格里');
}

section('');
section('【⑧ today / sel 标记】');
{
  const p = sctx([], {}, DAY);
  const cells = p.buildCal();
  eq(countOf(cells, function (c) { return c.sel; }), 1, 'sel 恰好一个');
  eq(cells.filter(function (c) { return c.sel; })[0].k, DAY, 'sel 落在选中日上');
  // today 只可能在「今天落进这 42 天窗口」时出现 —— 用成员关系判，而不是假设今天在不在
  const w0 = cells[0].k;
  const w1 = cells[cells.length - 1].k;
  const inWin = TODAY >= w0 && TODAY <= w1;
  eq(countOf(cells, function (c) { return c.today; }), inWin ? 1 : 0, 'today 的个数 === 今天是否落在窗口里');
}
{
  const p = sctx([], {}, TODAY);
  const cells = p.buildCal();
  eq(countOf(cells, function (c) { return c.sel; }), 1, '选中今天时 sel 仍恰好一个');
  eq(countOf(cells, function (c) { return c.today; }), 1, '选中今天时 today 恰好一个');
  eq(cells.filter(function (c) { return c.today; })[0].sel, true, '今天与选中日重合时落在同一格（不是两个圈）');
}
{
  const p = sctx([], {}, FAR);
  const cells = p.buildCal();
  eq(countOf(cells, function (c) { return c.today; }), 0, '远期月份的窗口里没有今天 → 一个 today 都没有');
  eq(countOf(cells, function (c) { return c.sel; }), 1, '但仍有一个 sel');
}

section('');
section('【⑨ 圆点：hi = 有提醒事项，hp = 写过计划】');
{
  const items = [
    mkItem('i1', 'q1', false, at('2026-10-15', 9)),
    mkItem('i2', 'q2', true, at('2026-10-15', 14)),
    mkItem('i3', 'q3', false, at('2026-10-20', 8)),
    mkItem('i4', 'q4', false, 0, '没有提醒时间的事项'),
    // ⚠️ 这一条必须是**只放已完成事项**的一天，而且要单独一天：
    //    变异验证第一次跑就抓出原来的用例是假的 —— 我把「已完成仍算一天」的断言
    //    挂在一个 done=false 的条目上，而且它那天还有另一条未完成的，
    //    于是「itemDays 偷偷加了 !done 条件」这个变异照样全绿。
    //    一条守不住东西的断言比没有断言更糟：它让人以为这块已经有人看了。
    mkItem('i5', 'q1', true, at('2026-10-22', 9), '只放一条、而且是已完成的'),
  ];
  const p = sctx(items, { '2026-10-16': '写点东西' }, DAY);
  const byK = {};
  p.buildCal().forEach(function (c) { byK[c.k] = c; });
  eq(byK['2026-10-15'].hi, true, '同一天两条 → 有深点');
  eq(byK['2026-10-15'].hp, false, '没写计划 → 没浅点');
  eq(byK['2026-10-16'].hp, true, '写过计划 → 有浅点');
  eq(byK['2026-10-16'].hi, false, '没有提醒 → 没深点');
  eq(byK['2026-10-18'].hi, false, '什么都没有的日子深点不亮');
  eq(byK['2026-10-18'].hp, false, '同上（浅点）');
  eq(byK['2026-10-20'].hi, true, '只有一条（未完成）的日子也有深点');
  eq(byK['2026-10-22'].hi, true, '**只放已完成事项**的日子也有深点（看的是有没有内容，不是还剩多少活）');
  eq(countOf(p.buildCal(), function (c) { return c.hi; }), 3, '深点只落在真有提醒的那三天（remindAt=0 的那条被 `!remindAt` 挡住）');
}

section('');
section('【⑩ ⚠️ 圆点与「这天的事项」必须同口径（否则出现「有点但列表空」）】');
{
  const items = [
    mkItem('i1', 'q1', false, at('2026-10-15', 9)),
    mkItem('i2', 'q2', false, at('2026-10-16', 9)),
    mkItem('i3', 'q3', true, at('2026-10-16', 10)),
    mkItem('i4', 'q4', false, 0),
    mkItem('i5', 'q1', false, at('2026-09-28', 9)),   // 落在补格里
    mkItem('i6', 'q2', false, at('2026-11-08', 9)),   // 落在下月补格里
    mkItem('i7', 'q3', true, at('2026-11-02', 9)),    // 又一天「只有已完成」：口径分叉最容易在这里露出来
  ];
  const p = sctx(items, {}, DAY);
  const cells = p.buildCal();
  let mismatch = 0;
  let dots = 0;
  cells.forEach(function (c) {
    p.state.schedDate = c.k;
    const rows = p.buildSchedRows();
    if (c.hi) dots++;
    if (c.hi !== (rows.length > 0)) mismatch++;
  });
  eq(mismatch, 0, '42 格里，hi 与「列表非空」逐格一致');
  eq(dots, 5, '有内容的日子数对得上（含补格里的两天）');

  p.state.schedDate = '2026-10-16';
  eq(p.buildSchedRows().length, 2, '列表口径也是「提醒时间落在那一天」');
}

section('');
section('【⑪ 「这天的事项」的排序与右槽】');
{
  const items = [
    mkItem('late', 'q1', false, at(DAY, 18), '傍晚'),
    mkItem('early', 'q1', false, at(DAY, 8), '早上'),
    mkItem('done1', 'q2', true, at(DAY, 7), '已办'),
  ];
  const p = sctx(items, {}, DAY);
  const rows = p.buildSchedRows();
  eq(rows.length, 3, '三条都落在这一天');
  eq(rows[0]._id, 'early', '未完成在前，同状态按时刻先后');
  eq(rows[1]._id, 'late', '晚的那条排在后面');
  eq(rows[2]._id, 'done1', '已完成的沉到最后（与详情页「待办在前」一致）');
  eq(rows[0].tail, '08:00', '未完成的行右槽是具体时刻');
  eq(rows[2].tail, '已完成', '已完成的行右槽是状态，不是时刻');
  eq(rows[0].q, 'q1', '行上带着象限，颜色由 .q1~.q4 提供');
}
{
  const p = sctx([mkItem('x', 'q1', false, at(DAY, 9))], {}, DAY);
  p.state.filt = 'undone';
  p.state.catId = 'nonexistent';
  eq(p.buildSchedRows().length, 1, '分类筛选 / 待办筛选都不影响日程列表（日程是跨分类的时间视图）');
}

/* ================= ⑫ 计划卡 ================= */

section('');
section('【⑫ 计划卡：`date` 是**选中日**，次日由 buildPlan 自己算】');
{
  const D0 = TODAY;
  const D1 = addDays(TODAY, 1);
  const plans = {};
  plans[D0] = '今天写方案';
  plans[D1] = '明天先评审';
  const p = sctx([], plans, D0);

  eq(p.buildPlan(D0, 0).label, '今天要做什么', '第一张卡说的是「今天」');
  // ⚠️ 这一条是回归钉子：曾经把 addDays 之后的日期又喂回 [which] 索引，
  //    于是这张「记的是明天」的卡标题写成了「后天准备做什么」。
  eq(p.buildPlan(D0, 1).label, '明天准备做什么', '第二张卡的标题说的是**次日**，不是次日的次日');
  eq(p.buildPlan(D0, 0).text, '今天写方案', '第一张卡取 plans[选中日]');
  eq(p.buildPlan(D0, 1).text, '明天先评审', '第二张卡取 plans[选中日的次日] —— 文本和标题必须指同一天');
  eq(p.buildPlan(D0, 0).dateShort, mdShort(D0), '第一张卡角上写选中日');
  eq(p.buildPlan(D0, 1).dateShort, mdShort(D1), '第二张卡角上写次日');
}
{
  const p = sctx([], {}, DAY);
  const F = addDays(TODAY, 5);
  eq(p.buildPlan(F, 0).label, '这天要做什么', '选中 +5 天时第一张卡不再冒充「今天」');
  eq(p.buildPlan(F, 1).label, '次日准备做什么', '第二张卡跟着变成「次日」');
  eq(p.buildPlan(F, 0).text, '', '没写过就是空文本（由页面渲染成占位）');
  ok(p.buildPlan(F, 0).label.indexOf('今天') < 0, '远日子上标题里不该出现「今天」');
}
{
  const p = sctx([], {}, DAY);
  eq(p.buildPlan(DAY, 0).placeholder, '还没写，点一下记一笔', '第一张卡的占位文案');
  ok(p.buildPlan(TODAY, 1).placeholder.indexOf('明天') >= 0, '选中今天时，第二张卡的占位说「明天」');
  const Y = addDays(TODAY, -1);
  ok(p.buildPlan(Y, 1).placeholder.indexOf('今天') >= 0, '选中昨天时，第二张卡的占位说「今天」（写死就自相矛盾了）');
}
{
  const p = sctx([], {}, '2026-10-31');
  const N = addDays('2026-10-31', 1);
  eq(N, '2026-11-01', '（前置）10-31 的次日是 11-01');
  eq(p.buildPlan('2026-10-31', 1).dateShort, '11/1', '跨月：次日的卡角显示 11/1');
  eq(p.buildPlan('2026-10-31', 1).text, '', '次日没写过就是空');
  eq(p.buildCalLabel(), '2026 年 10 月', '日历表头跟着 schedYm');
}
{
  const p = sctx([], { '2026-11-01': '下月一号' }, '2026-10-31');
  eq(p.buildPlan('2026-10-31', 1).text, '下月一号', '次日取的确实是下月那天的计划');
}

/* ================= ⑬ 交互 ================= */

section('');
section('【⑬ 翻月 / 选日】');
{
  const p = sctx([], {}, DAY);
  p.onCalNext();
  eq(p.state.schedYm, '2026-11', 'onCalNext 进位一个月');
  eq(p.state.schedDate, '2026-11-01', '选中日不在新月份里 → 落到 1 号（否则选中的是个看不见的日子）');
  p.onCalPrev();
  eq(p.state.schedYm, '2026-10', 'onCalPrev 退回来');
}
{
  const p = sctx([], {}, '2026-12-20');
  p.onCalNext();
  eq(p.state.schedYm, '2027-01', '12 月 +1 跨年（交给 Date 进位）');
  p.onCalPrev();
  eq(p.state.schedYm, '2026-12', '跨年后还能退回来');
}
{
  const p = sctx([], {}, DAY);
  p.onCalPick({ detail: { k: '2026-11-02' } });
  eq(p.state.schedDate, '2026-11-02', '点某一天 → 选中它');
  eq(p.state.schedYm, '2026-11', '点到下月补格 → 显示的月份也跟过去（否则那格像点不动）');
  eq(p.data.calAtToday, false, '选中的不是今天');
  const before = p.state.schedDate;
  p.onCalPick({ detail: {} });
  eq(p.state.schedDate, before, '没带日期的事件被忽略（不会把选中日清成 undefined）');
}
{
  const p = sctx([], {}, DAY);
  p.onCalToday();
  eq(p.state.schedDate, TODAY, '「今天」按钮回到今天');
  eq(p.state.schedYm, ymOf(TODAY), '月份也回到今天所在的月');
  eq(p.data.calAtToday, true, 'calAtToday 置真（「今天」按钮才会灰掉）');
}
{
  const p = sctx([], {}, DAY);
  eq(p.data.calCells.length, 42, 'render() 把 42 格推给了视图层');
  eq(p.data.schedDayLabel, dateCN(DAY), '日期大标题：跟着选中日走');
  eq(p.data.pageTitle, '日程', '页面标题');

  // ⚠️ 页眉那行小标题是**今天**，而且**不跟选中日走**（2026-10-09 修的 bug）。
  //    它和 .dayh 分工不同：.dayh 回答「我在看哪一天」，它回答「今天是几号」。
  //    两行都跟着点日历变的话，屏幕上就没有任何一处能告诉你日历上那个描边圈
  //    （今天）到底是几号了。
  eq(p.data.pageMeta, dateCN(TODAY), '页眉副标题 = 今天');
  eq(p.data.pageMeta.indexOf('今天') < 0, true, '不再挂「· 今天」后缀（它固定就是今天，再标一次是废话）');

  // 核心那条：换一天，页眉必须纹丝不动。
  // ⚠️ 必须用 FAR（2030 年）而**不能**用 DAY 来验 —— DAY 恰好就是今天，
  //    用 DAY 的话「跟着选中日走」这个错误实现照样是绿的，等于没断言。
  const meta0 = p.data.pageMeta;
  const day0 = p.data.schedDayLabel;
  p.onCalPick({ detail: { k: FAR } });
  eq(p.state.schedDate, FAR, '（前置）选中日确实换了');
  eq(p.data.schedDayLabel, dateCN(FAR), '下面那行大标题跟着换');
  eq(p.data.schedDayLabel !== day0, true, '（前置）大标题真的变了，否则下一条是空断言');
  eq(p.data.pageMeta, meta0, '⚠️ 页眉副标题纹丝不动 —— 这就是那个 bug 的验收条件');
  eq(p.data.pageMeta, dateCN(TODAY), '而且它始终是今天');
}
{
  const p = sctx([], {}, FAR);
  eq(p.data.schedBadge, '', '不是今天 → 不挂「今天」角标');
  eq(p.data.calAtToday, false, '远期日期也不点亮「今天」按钮');
  eq(p.data.pageMeta.indexOf('· 今天'), -1, '副标题里也不该出现「今天」');
}

section('');
section('【⑭ 点行 / 点卡】');
{
  const items = [mkItem('i1', 'q1', false, at(DAY, 9), '开例会')];
  const p = sctx(items, {}, DAY);
  let captured = null;
  p.openForm = function (it) { captured = it; };
  p.onSchedRow({ currentTarget: { dataset: { id: 'i1' } } });
  eq(captured && captured._id, 'i1', '点事项行 → 用 dataset.id 找到那条事项，复用同一个编辑抽屉');
  captured = null;
  p.onSchedRow({ currentTarget: { dataset: { id: 'nope' } } });
  eq(captured, null, 'id 找不到时什么都不做（不弹空抽屉）');
}
{
  const p = sctx([], {}, DAY);
  p.onPlanEdit({ detail: { kind: 'day' } });
  eq(p.data.planDate, DAY, '点第一张卡 → 写的就是选中日');
  eq(p.data.sheetOpen, true, '打开抽屉');
  eq(p.data.sheetKind, 'plan', '抽屉是计划模式（不新增弹层）');
  eq(p.data.sheetTitle, planLabels(dayDiff(DAY))[0], '抽屉标题与卡片标题同源');
  eq(p.data.sheetSub, dateCN(DAY), '抽屉副标题写着是哪一天');
}
{
  const p = sctx([], {}, FAR);
  p.onPlanEdit({ detail: { kind: 'next' } });
  eq(p.data.planDate, addDays(FAR, 1), '点第二张卡 → 写的是**选中日的次日**');
  ok(p.data.planDate !== addDays(TODAY, 1), '「次日」是相对选中日算的，不是相对今天（否则翻到别的月份就写错地方）');
}
{
  const p = sctx([], { [DAY]: '原计划' }, DAY);
  p.onPlanEdit({ detail: { kind: 'day' } });
  eq(p.data.planDraft, '原计划', '打开抽屉时回填已有计划');
  p.onInputPlan({ detail: { value: '改了' } });
  eq(p.data.planDraft, '改了', '输入同步到 planDraft');
}

/* ================= ⑮ / ⑯ / ⑰ ================= */

const runAsync = (async function () {
  section('');
  section('【⑮ 保存计划：落库 + 乐观更新 + 空文本=删除】');
  {
    cloudCalls.length = 0;
    const p = sctx([], {}, DAY);
    let committed = null;
    p.closeSheet = function () { this._closed = true; };
    p.commit = function (optimistic, promise) { committed = optimistic; return promise; };
    p.onPlanEdit({ detail: { kind: 'day' } });
    p.onInputPlan({ detail: { value: '  写周报  ' } });
    p.onSavePlan();
    eq(p._closed, true, '保存后收起抽屉');
    ok(typeof committed === 'function', '走 commit（带乐观更新），不是裸调云函数');
    eq(p.plans[DAY] === undefined, true, 'commit 的乐观函数跑之前，镜像不动');
    committed();
    eq(p.plans[DAY], '  写周报  ', '乐观更新：先改镜像，UI 立刻能看到');
    await new Promise(function (r) { setImmediate(r); });
    const call1 = cloudCalls[cloudCalls.length - 1];
    eq(call1.action, 'savePlan', '落库调的是 savePlan');
    eq(call1.date, DAY, '带上日期键');
    eq(call1.text, '  写周报  ', '带上文本');
    eq(countOf(cloudCalls, function (c) { return c.action === 'savePlan'; }), 1, '只发一次请求');
  }
  {
    cloudCalls.length = 0;
    const p = sctx([], { [DAY]: '旧计划' }, DAY);
    let committed = null;
    p.closeSheet = function () {};
    p.commit = function (optimistic, promise) { committed = optimistic; return promise; };
    p.onPlanEdit({ detail: { kind: 'day' } });
    p.onInputPlan({ detail: { value: '' } });
    p.onSavePlan();
    committed();
    eq(p.plans[DAY], undefined, '空文本 = 删掉这天的计划（不需要另一个「删除」按钮）');
    await new Promise(function (r) { setImmediate(r); });
    const call2 = cloudCalls[cloudCalls.length - 1];
    eq(call2.action, 'savePlan', '删除也走同一个 action');
    eq(call2.text, '', '用空文本表达删除');
  }
  {
    cloudCalls.length = 0;
    const p = sctx([], {}, DAY);
    p.closeSheet = function () {};
    p.commit = function (optimistic) { optimistic(); return Promise.resolve(); };
    p.onPlanEdit({ detail: { kind: 'day' } });
    p.onInputPlan({ detail: { value: 'x'.repeat(CONST.PLAN_MAX + 50) } });
    p.onSavePlan();
    eq(p.plans[DAY].length, CONST.PLAN_MAX, '页面侧按 PLAN_MAX 截断（textarea 的 maxlength 拦不住手动构造的请求）');
    await new Promise(function (r) { setImmediate(r); });
    eq(cloudCalls[cloudCalls.length - 1].text.length, CONST.PLAN_MAX, '发出去的也已经是截断后的');
  }
  {
    cloudCalls.length = 0;
    const p = sctx([], {}, DAY);
    p.closeSheet = function () {};
    p.commit = function () { return Promise.resolve(); };
    p.data.planDate = '';
    p.onSavePlan();
    await new Promise(function (r) { setImmediate(r); });
    eq(cloudCalls.length, 0, '抽屉里没有日期时直接返回，不发请求');
  }

  section('');
  section('【⑯ adoptPlans：收的是**数组**，整体重建，且容忍旧云函数】');
  {
    // ⚠️ 形状必须与云函数对齐：plansFor() map 成 [{date, text}]，
    //    而 adoptPlans 收的正是它。写成对象会让 list.forEach 直接抛（首屏白屏）。
    const cfjs0 = fs.readFileSync(CF_JS, 'utf8');
    ok(/date:\s*p\.date,\s*text:\s*p\.text/.test(cfjs0), '云函数下发的形状就是 [{date, text}]（与 adoptPlans 成对）');
  }
  {
    const p = sctx([], { '2026-10-01': 'a', '2026-10-02': 'b' }, DAY);
    p.adoptPlans([{ date: '2026-10-01', text: 'a2' }]);
    eq(p.plans['2026-10-01'], 'a2', '同一天的新文本覆盖旧文本');
    eq(p.plans['2026-10-02'], undefined, '服务端没下发的日子被**删掉**（增量合并会在本地留幽灵）');
    eq(Object.keys(p.plans).length, 1, '整体重建后只剩服务端给的那一条');
  }
  {
    const p = sctx([], { '2026-10-01': 'a' }, DAY);
    p.adoptPlans(undefined);
    eq(p.plans['2026-10-01'], 'a', '旧版云函数不返回 plans 时**不动**本地数据（否则首屏被清空）');
    p.adoptPlans(null);
    eq(p.plans['2026-10-01'], 'a', 'null 同上');
    p.adoptPlans({});
    eq(p.plans['2026-10-01'], 'a', '给了个对象（不是数组）也当作「没给」，不炸也不会清空');
    eq(p.plans['2026-10-01'] !== undefined, true, '非数组输入不会把 plans 换成空表');
  }
  {
    const p = sctx([], { '2026-10-01': 'a' }, DAY);
    p.adoptPlans([]);
    eq(Object.keys(p.plans).length, 0, '服务端明确给了空数组 → 真的清空（与 undefined 区分开）');
  }

  section('');
  section('【⑰ 接线契约：注册 / 标签 / 配对常量】');
  const pjson = JSON.parse(fs.readFileSync(P_JSON, 'utf8'));
  const pwxml = fs.readFileSync(P_WXML, 'utf8');
  const tbwxml = fs.readFileSync(TB_WXML, 'utf8');
  const cjs = fs.readFileSync(C_JS, 'utf8');
  const cfjs = fs.readFileSync(CF_JS, 'utf8');

  eq(pjson.usingComponents['fq-cal'], '/components/fq-cal/fq-cal', 'index.json 注册了 fq-cal');
  eq(pjson.usingComponents['fq-plan'], '/components/fq-plan/fq-plan', 'index.json 注册了 fq-plan');

  ok(/<fq-cal[^>]*bind:pick="onCalPick"/.test(pwxml), 'fq-cal 的 pick 接在 onCalPick 上');
  ok(/<fq-cal[^>]*bind:prev="onCalPrev"/.test(pwxml), 'fq-cal 的 prev 接在 onCalPrev 上');
  ok(/<fq-cal[^>]*bind:next="onCalNext"/.test(pwxml), 'fq-cal 的 next 接在 onCalNext 上');
  ok(/<fq-cal[^>]*bind:today="onCalToday"/.test(pwxml), 'fq-cal 的 today 接在 onCalToday 上');
  ok(/<fq-cal[^>]*cells="\{\{calCells\}\}"/.test(pwxml), 'fq-cal 用 cells="{{calCells}}" 接 42 格');
  ok(/<fq-cal[^>]*attoday="\{\{calAtToday\}\}"/.test(pwxml), 'fq-cal 用 attoday 控制「今天」按钮');
  ok(/<fq-plan[^>]*kind="day"/.test(pwxml) && /<fq-plan[^>]*kind="next"/.test(pwxml), '两张计划卡分别是 day / next');
  ok(/<fq-plan[^>]*bind:edit="onPlanEdit"/.test(pwxml), 'fq-plan 的 edit 接在 onPlanEdit 上');
  ok(/<fq-plan[^>]*label="\{\{planDay\.label\}\}"/.test(pwxml), '第一张卡的标题来自 planDay.label');
  ok(/<fq-plan[^>]*label="\{\{planNext\.label\}\}"/.test(pwxml), '第二张卡的标题来自 planNext.label');
  ok(/maxlength="\{\{planMax\}\}"/.test(pwxml), 'textarea 的 maxlength 走 planMax（常量单一来源）');
  ok(/bindinput="onInputPlan"/.test(pwxml), 'textarea 的输入接在 onInputPlan 上');
  ok(/planMax:\s*PLAN_MAX/.test(fs.readFileSync(path.join(MP, 'pages', 'index', 'index.js'), 'utf8')), 'data.planMax 由 PLAN_MAX 喂');

  eq(CONST.PLAN_MAX, Number(/const MAX_PLAN = (\d+)/.exec(cfjs)[1]), 'PLAN_MAX（客户端）=== MAX_PLAN（云函数）：成对常量不能各改各的');
  ok(/const WRITE_ACTIONS = \[[\s\S]*?'savePlan'/.test(cjs), 'savePlan 进了客户端的 WRITE_ACTIONS（否则轮询同步会踩掉正在保存的计划）');
  ok(/'savePlan'/.test((/const ACTIONS = \[[\s\S]*?\];/.exec(cfjs) || [''])[0]), 'savePlan 进了云函数的 ACTIONS 清单');
  ok(/fq_plans/.test(cfjs), '云函数里有 fq_plans 集合');
  ok(/const COL_PLANS = 'fq_plans'/.test(cfjs), '集合名是常量，不是散落的字符串');

  const tabs = tbwxml.match(/data-k="[a-z]+"/g) || [];
  eq(tabs.length, 4, '底栏是 4 个 Tab');
  eq(tabs.indexOf('data-k="sched"'), 1, '日程是第 2 个 Tab（与总览相邻）');
  ok(/<text class="lbl">日程<\/text>/.test(tbwxml), 'Tab 文案是「日程」');
  ok(tbwxml.indexOf('ico-cal') >= 0, 'Tab 用自绘的 ico-cal 图标');

  section('');
  console.log('========================================');
  console.log('日程：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
