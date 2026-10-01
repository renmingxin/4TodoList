// 拖动排序 / 左滑操作的逻辑仿真测试
// 直接加载真实的 index.js（用假的 Page / wx 环境），跑真实方法，不复制逻辑。
const path = require('path');
const fs = require('fs');
// 本文件在 .workbuddy/tools/ 下，上两级即项目根
const ROOT = path.resolve(__dirname, '..', '..');

// 小程序端的协议版本。用例里一律引用它，**不要写死数字** ——
// 写死的话每次升 FN_VER 都得来改测试，而「把断言改成绿的」永远是最顺手的那一步。
const PAGE_VER = Number(
  /const FN_VER = (\d+)/.exec(
    fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.js'), 'utf8')
  )[1]
);

let page = null;
const cloudCalls = [];
let vibrateCalls = 0;

// index.js 里唯一用到的定时器是「进入排序模式后摘掉抖动标记」，桩掉它就能
// 在同一次运行里把「抖一下 → 标记摘掉」整条链路走完，不必真等 380ms。
const timers = [];
global.setTimeout = function (fn, ms) {
  timers.push({ fn: fn, ms: ms });
  return timers.length;
};
global.clearTimeout = function (id) {
  if (id) timers[id - 1] = null;
};
function flushTimers() {
  timers.splice(0).forEach(function (t) {
    if (t) t.fn();
  });
}

// 自动同步的轮询（8 秒一次）没法真等，也要桩掉。除了避免测试跑完挂着一个
// live interval，还能手动「响一次」，把避让规则测掉。
let tickFn = null;
global.setInterval = function (fn) {
  tickFn = fn;
  return 1;
};
global.clearInterval = function () {
  tickFn = null;
};
function flushSync() {
  if (tickFn) tickFn();
}

// 行测量（measureRows）走 wx.createSelectorQuery。
// 真机上这个回调**一定是异步的**（下一帧才回来），所以桩要能模拟「回调迟到」：
// 默认同步返回（大多数用例够用），把 measureDeferred 打开就改成排队，
// 由 flushMeasure() 决定它什么时候回来 —— 竞态那一组靠它复现。
let CUR_PAGE = null;
let RECTS_TOP = 200;
let measureDeferred = false;
const measureQueue = [];
function flushMeasure() {
  measureQueue.splice(0).forEach(function (run) {
    run();
  });
}

// 假滚动区（只有「拖到边缘自动滚」那一组会用）。
// 两个细节必须跟真机一致，否则测了个寂寞：
//   ① setData({scrollTop}) 不会同步生效 —— 要等视图层滚完才回 bindscroll，
//      所以这里也把它排进队列，由 flushScroll() 决定什么时候生效；
//   ② 越界会被夹取。这正是「滚到顶/底」的由来，自动滚能不能收手全靠它。
const SC = { top: 300, height: 600, content: 2000, scrollTop: 0 };
const scQueue = [];
// 默认量不到滚动区：其余各组的触摸坐标会落在边缘带里，但既然量不到就不该自动滚，
// 顺带也把「量不到 → 不自动滚、但拖动照常」这条降级路径测掉了。
let SC_MEASURABLE = false;
function scMax() {
  return Math.max(0, SC.content - SC.height);
}
function resetScroll() {
  SC.scrollTop = 0;
  scQueue.length = 0;
}
function flushScroll() {
  scQueue.splice(0).forEach(function (target) {
    const next = Math.max(0, Math.min(scMax(), target));
    // 夹取后跟原来一样 → 真机不会回 bindscroll，这里也不回调
    if (next === SC.scrollTop) return;
    SC.scrollTop = next;
    if (CUR_PAGE) CUR_PAGE.onScrollerScroll({ detail: { scrollTop: next } });
  });
}

// bootstrap 的返回体做成可替换的 —— 「版本握手」那组要换着 fnVer 试。
// 其余 action 一律回 { updated: 1 }，和以前一致。
let bootstrapPayload = { categories: [], items: [], fnVer: 2 };
const modalCalls = [];

global.Page = function (obj) {
  page = obj;
};

global.wx = {
  cloud: {
    callFunction(opts) {
      cloudCalls.push(opts.data);
      if (opts.data && opts.data.action === 'bootstrap') {
        return Promise.resolve({ result: { ok: true, data: bootstrapPayload } });
      }
      return Promise.resolve({ result: { ok: true, data: { updated: 1 } } });
    },
  },
  setNavigationBarColor() {},
  showToast() {},
  showModal(opts) {
    modalCalls.push(opts);
  },
  vibrateShort() {
    vibrateCalls++;
  },
  getWindowInfo() {
    return { windowWidth: 375, windowHeight: 700, screenHeight: 812, statusBarHeight: 44, safeArea: { bottom: 778 } };
  },
  getMenuButtonBoundingClientRect() {
    return { left: 280 };
  },
  createSelectorQuery() {
    const q = {
      _sel: '',
      select(sel) { q._sel = sel; return q; },
      selectAll() { q._sel = ''; return q; },
      boundingClientRect() { return q; },
      exec(cb) {
        // 单点查询：目前只有 measureScroller 用（量滚动区的上下边）。
        // ⚠️ 单点查询的 res[0] 就是**那个节点的 rect**，
        //    不是像 selectAll 那样是 rect 数组 —— 桩这里写错，
        //    页面会一直走「量不到」的降级分支，测试却以为量到了。
        if (q._sel) {
          if (!SC_MEASURABLE) return cb([]); // 量不到 → res[0] === undefined
          return cb([{ top: SC.top, height: SC.height }]);
        }
        const flat = CUR_PAGE ? CUR_PAGE.flatList() : [];
        const run = function () {
          cb([flat.map(function (_, i) {
            return { top: RECTS_TOP + i * 116, height: 100 };
          })]);
        };
        if (measureDeferred) measureQueue.push(run);
        else run();
      },
    };
    return q;
  },
};

require(path.join(ROOT, 'miniprogram/pages/index/index.js'));

/* ---------------- 测试脚手架 ---------------- */

const CAT = 'c1';
const CATS = [{ _id: CAT, name: '工作', order: 0 }];

// items: [[id, quad, done, order], ...]
function ctx(raw, view, filt, quad) {
  const p = Object.create(page);
  p.cats = JSON.parse(JSON.stringify(CATS));
  p.items = raw.map(function (r) {
    return { _id: r[0], quad: r[1], done: !!r[2], order: r[3], title: r[0], catId: CAT, priority: 3 };
  });
  p.items.sort(function (a, b) { return a.order - b.order; });
  p.state = { view: view || 'detail', catId: CAT, quad: quad || 'q1', filt: filt || 'all' };
  p.rf = 0.5;
  p.data = JSON.parse(JSON.stringify(page.data));
  // 与 onLoad 对齐：这三个都是「不进 data 的内部镜像」
  p._scrollTop = SC.scrollTop;
  p._scBand = null;
  p._asTimer = null;
  p.setData = function (patch, cb) {
    // scrollTop 是给视图层的指令，不是立即生效的状态 —— 排进队列，等 flushScroll()
    if (patch && patch.scrollTop != null) scQueue.push(patch.scrollTop);
    Object.assign(p.data, patch);
    if (typeof cb === 'function') cb.call(p);
  };
  p.render();
  CUR_PAGE = p;
  return p;
}

// 造与当前视图一致的行位置（每行 100px + 16px 间距）
function fakeRects(p, top) {
  const flat = p.flatList();
  return flat.map(function (_, i) {
    return { top: (top || 200) + i * 116, height: 100 };
  });
}

// 模拟一次拖动：from/to 是扁平列表下标
function drag(p, from, to) {
  p._dg = { id: p.flatList()[from].id, from: from, to: to, flat: p.flatList(), rects: fakeRects(p), dy: 0 };
  p.endDrag();
}

// 模拟一次真实触摸
function touch(id, x, y) {
  return { currentTarget: { dataset: { id: id } }, touches: [{ clientX: x, clientY: y }] };
}

const ids = function (p, quad) {
  return (quad ? p.inQuad(quad, false) : p.items).map(function (it) { return it._id; });
};
const last = function () { return cloudCalls[cloudCalls.length - 1]; };

let pass = 0;
let fail = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '\n      实际 ' + a + '\n      期望 ' + e); }
}

/* ---------------------------------------------------------- */

console.log('\n[1] 详情页同象限拖动：q1 的 a,b,c,d 把 a 拖到第 3 位');
{
  const p = ctx([['a', 'q1', 0, 0], ['b', 'q1', 0, 10], ['c', 'q1', 0, 20], ['d', 'q1', 0, 30]]);
  cloudCalls.length = 0;
  eq('拖动前可见顺序', ids(p), ['a', 'b', 'c', 'd']);
  drag(p, 0, 2);
  eq('拖动后顺序', ids(p), ['b', 'c', 'a', 'd']);
  // 只有真正变了 order 的条目才回传：d 仍是 30，略过不发
  eq('只回传变化的 3 条', last().items, [
    { id: 'b', order: 0, quad: 'q1' },
    { id: 'c', order: 10, quad: 'q1' },
    { id: 'a', order: 20, quad: 'q1' },
  ]);
  eq('提交给云函数的 action', last().action, 'reorder');
}

console.log('\n[2] 详情页拖动 + 筛选「待办」：已完成的隐藏项不许被挤动');
{
  const p = ctx(
    [['a', 'q1', 1, 0], ['b', 'q1', 0, 10], ['c', 'q1', 0, 20], ['d', 'q1', 0, 30]],
    'detail', 'todo'
  );
  cloudCalls.length = 0;
  eq('可见顺序（a 已完成被隐藏）', ids(p).filter((x) => x !== 'a'), ['b', 'c', 'd']);
  eq('可见行数', p.data.rows.length, 3);
  drag(p, 0, 2); // 可见列表里把 b 拖到最后
  eq('可见顺序变为 c,d,b', p.data.rows.map((r) => r._id), ['c', 'd', 'b']);
  eq('隐藏的 a 仍在原处（第 1 位）', ids(p)[0], 'a');
  eq('完整顺序 a,c,d,b', ids(p), ['a', 'c', 'd', 'b']);
}

console.log('\n[3] 全部页同段拖动：不改象限，只改顺序');
{
  const p = ctx(
    [['a', 'q1', 0, 0], ['b', 'q1', 0, 10], ['c', 'q3', 0, 0], ['d', 'q3', 0, 10]],
    'all'
  );
  cloudCalls.length = 0;
  eq('扁平顺序', p.flatList().map((f) => f.id + ':' + f.quad), ['a:q1', 'b:q1', 'c:q3', 'd:q3']);
  drag(p, 0, 1); // q1 内 a↔b
  eq('q1 顺序', ids(p, 'q1'), ['b', 'a']);
  eq('q3 未被波及', ids(p, 'q3'), ['c', 'd']);
  eq('落库只含 q1', last().items.map((x) => x.id), ['b', 'a']);
}

console.log('\n[4] 全部页跨象限拖动：q1 的 a 拖到 q3 的 c 之前');
{
  const p = ctx(
    [['a', 'q1', 0, 0], ['b', 'q1', 0, 10], ['c', 'q3', 0, 0], ['d', 'q3', 0, 10]],
    'all'
  );
  cloudCalls.length = 0;
  drag(p, 0, 2); // 从 a（q1#0）到 c（q3#0）
  eq('q1 只剩 b', ids(p, 'q1'), ['b']);
  eq('q3 变为 a,c,d', ids(p, 'q3'), ['a', 'c', 'd']);
  eq('a 的 quad 已改为 q3', p.findItem('a').quad, 'q3');
  eq('落库含两条（源 + 目标）', last().items, [
    { id: 'b', order: 0, quad: 'q1' },
    { id: 'a', order: 0, quad: 'q3' },
    { id: 'c', order: 10, quad: 'q3' },
    { id: 'd', order: 20, quad: 'q3' },
  ]);
}

console.log('\n[5] 拖回原位（from === to）：不落库，位移还原');
{
  const p = ctx([['a', 'q1', 0, 0], ['b', 'q1', 0, 10]], 'detail');
  cloudCalls.length = 0;
  drag(p, 1, 1);
  eq('顺序不变', ids(p), ['a', 'b']);
  eq('没有发起云调用', cloudCalls.length, 0);
}

console.log('\n[6] 左滑操作只有两个：未完成 → 完成 / 删除，已完成 → 撤销 / 删除');
{
  const p = ctx([['a', 'q1', 0, 0], ['b', 'q1', 1, 10]], 'detail');
  cloudCalls.length = 0;
  eq('moveToEdge 已移除', typeof p.moveToEdge, 'undefined');
  eq('左滑面板宽度 = 240rpx（2 个按钮）', p.swipeMax(), 240);

  p.onRowAct({ currentTarget: { dataset: { act: 'done', id: 'a' } } });
  eq('未完成的 a → 标记完成', p.findItem('a').done, true);
  eq('act=done → 落库 updateItem', [last().action, last().patch], ['updateItem', { done: true }]);

  // 已完成的 b 走同一个 act，取反后落回未完成（就是「撤销」）
  p.onRowAct({ currentTarget: { dataset: { act: 'done', id: 'b' } } });
  eq('已完成的 b → 撤销回未完成', p.findItem('b').done, false);
  eq('撤销落库 updateItem done:false', [last().action, last().patch], ['updateItem', { done: false }]);

  // 删除走 showModal 二次确认；stub 不会回调 confirm，因此这里不应发请求
  const n = cloudCalls.length;
  p.onRowAct({ currentTarget: { dataset: { act: 'del', id: 'a' } } });
  eq('act=del → 只弹确认框，未确认不发请求', cloudCalls.length, n);
}

console.log('\n[7] 已完成事项：行内可撤销，编辑抽屉里另有一个「标记为未完成」');
{
  const p = ctx([['a', 'q1', 1, 0], ['b', 'q1', 0, 10]], 'detail');
  p.openForm(p.findItem('a'));
  eq('编辑已完成事项 → 抽屉出现撤销入口', p.data.sheetDone, true);
  p.openForm(p.findItem('b'));
  eq('编辑未完成事项 → 不出现撤销入口', p.data.sheetDone, false);

  p.openForm(p.findItem('a'));
  cloudCalls.length = 0;
  p.onSheetUndone();
  eq('撤销后抽屉关闭', p.data.sheetOpen, false);
  eq('撤销后 done 改回 false', p.findItem('a').done, false);
  eq('撤销落库 updateItem done:false', [last().action, last().patch], ['updateItem', { done: false }]);
}

console.log('\n[8] 位移计算：同段拖动时其余卡片的让位量');
{
  const p = ctx([['a', 'q1', 0, 0], ['b', 'q1', 0, 10], ['c', 'q1', 0, 20]], 'detail');
  p.rf = 0.5; // 16rpx 间距 → 8px
  p._dg = { id: 'a', from: 0, to: 2, flat: p.flatList(), rects: fakeRects(p), dy: 240 };
  p.paintDrag(240, 2);
  // slot = 100(卡片) + 8(间距) = 108；[1,2] 补位 -108
  eq('让位位移', p.data.rows.map((r) => r.shift), [0, -108, -108]);
  eq('被拖卡片自己不吃 shift', p.data.dragY, 240);
  eq('同段拖动不设跨象限提示', p.data.dropQuad, '');
}

console.log('\n[9] 跨段拖动：不做位移，改为高亮落点');
{
  const p = ctx([['a', 'q1', 0, 0], ['b', 'q3', 0, 0]], 'all');
  p._dg = { id: 'a', from: 0, to: 1, flat: p.flatList(), rects: fakeRects(p), dy: 116 };
  p.paintDrag(116, 1);
  eq('没有任何 shift', p.data.sections.map((s) => s.rows.map((r) => r.shift)), [[0], [0]]);
  eq('目标象限被高亮', p.data.dropQuad, 'q3');
}

console.log('\n[10] 两种视图共用同一套左滑按钮（渲染与否交给 WXML 的 wx:if）');
{
  const p = ctx([['a', 'q1', 0, 0]], 'all');
  eq('全部页 flatList 正确', p.flatList(), [{ id: 'a', quad: 'q1', sec: 0, idx: 0 }]);
  eq('全部页左滑宽度 = 240rpx', p.swipeMax(), 240);
  p.state.view = 'detail';
  eq('详情页左滑宽度（同样是完成 / 删除两个）', p.swipeMax(), 240);
}

console.log('\n[11] 拖动几何：换位判定与位移夹取（3 行，行高 100、间距 16 → 步长 116）');
{
  const p = ctx([['a', 'q1', 0, 0], ['b', 'q1', 0, 10], ['c', 'q1', 0, 20]], 'detail');
  const rects = [{ top: 200, height: 100 }, { top: 316, height: 100 }, { top: 432, height: 100 }];
  // base0 = 拿起那一刻被拖卡片的屏幕顶边。列表没滚时它就等于 rects[from].top，
  // 位移公式 base0 + (clientY - _dgY0) - rects[from].top 正好退化成 clientY - _dgY0。
  p._dg = { id: 'a', from: 0, to: 0, flat: p.flatList(), rects: rects, dy: 0, base0: 200, lastY: null };

  p._dgY0 = 250; // 手指按在第 1 张卡片中心
  p.applyDragMove(250);
  eq('原地不动', p._dg.to, 0);

  p.applyDragMove(400);
  eq('中心越过第 2 张中线 → 第 2 位', p._dg.to, 1);

  p.applyDragMove(900);
  eq('拖到底：位移被夹到 232', p._dg.dy, 232);
  eq('拖到底 → 最后一位（EPS 容差救的就是这一档）', p._dg.to, 2);

  // 反过来：把最后一张拖到最上
  const q = ctx([['a', 'q1', 0, 0], ['b', 'q1', 0, 10], ['c', 'q1', 0, 20]], 'detail');
  q._dg = { id: 'c', from: 2, to: 2, flat: q.flatList(), rects: rects, dy: 0, base0: 432, lastY: null };
  q._dgY0 = 482;
  q.applyDragMove(100);
  eq('拖到顶：位移被夹到 -232', q._dg.dy, -232);
  eq('拖到顶 → 第 1 位', q._dg.to, 0);
}

console.log('\n[12] 排序模式开关：必须点「调整顺序」后才能拖动（走真实触摸序列）');
{
  const p = ctx([['a', 'q1', 0, 0], ['b', 'q1', 0, 10], ['c', 'q1', 0, 20]], 'detail');
  cloudCalls.length = 0;

  // ① 未开排序模式：纵向移动只是滚动列表，不许拿起卡片
  p.onRowStart(touch('a', 100, 100));
  p.onRowMove(touch(null, 100, 160));
  eq('未开排序模式：不进拖动', [p.data.dragOn, p.data.dragId], [false, '']);
  eq('未开排序模式：没有 _dg', !p._dg, true);
  p.onRowEnd();

  // ② 点开「调整顺序」
  const vib0 = vibrateCalls;
  p.onSortToggle();
  eq('排序模式已开启', p.data.sortMode, true);
  eq('进入时清掉滑动残留', [p.data.swipeKey, p.data.swipeX], ['', 0]);
  eq('进入时打开一次性抖动标记（卡片整体抖一下）', p.data.sortPulse, true);
  eq('进入时震动一次', vibrateCalls - vib0, 1);

  // ③ 排序模式下「在卡片本体上纵向移动」＝ 滚列表，不许拿起卡片。
  //    这是本轮的关键改动：以前整张卡片都能拖，所以只能把 scroll-y 关掉给拖动让路，
  //    代价是排序模式完全不能滚。现在拖动被收窄到右侧手柄上，卡片本体还给滚动。
  p.onRowStart(touch('a', 100, 100));
  p.onRowMove(touch(null, 100, 160));
  eq('排序模式：卡片本体不接管拖动（留给滚动）', [p.data.dragOn, p.data.dragId], [false, '']);
  eq('排序模式：卡片本体移动时没有 _dg', !p._dg, true);
  p.onRowEnd();

  // ④ 从手柄上按住、小位移（8px）才拿起卡片
  p.onHandleStart(touch('a', 100, 100));
  p.onHandleMove(touch(null, 100, 108));
  eq('手柄：已拿起卡片', [p.data.dragOn, p.data.dragId], [true, 'a']);
  eq('量到的行数 = 视图行数', p._dg ? p._dg.rects.length : -1, 3);
  eq('位移原点 = 拿起时的 clientY', p._dgY0, 108);
  eq('拿起卡片不再震动（反馈只在进入模式那一下）', vibrateCalls - vib0, 1);
  eq('拖动期间抖动标记仍在（动画由 class 驱动，还没到清理时机）', p.data.sortPulse, true);

  // ⑤ 往下拖到第 3 位（步长 116 × 2 = 232）
  p.onHandleMove(touch(null, 100, 108 + 232));
  eq('实时位移只推一个数字', p.data.dragY, 232);
  eq('让位交给 shift[]', p.data.rows.map((r) => r.shift), [0, -108, -108]);

  // ⑥ 松手：落库，但仍留在排序模式（render() 不许把它重置掉）
  p.onHandleEnd();
  eq('松手后退出拖动、留在排序模式', [p.data.dragOn, p.data.dragId, p.data.sortMode], [false, '', true]);
  eq('顺序已变 b,c,a', ids(p), ['b', 'c', 'a']);
  eq('已发 reorder', last().action, 'reorder');
  eq('拖动结束没有额外震动', vibrateCalls - vib0, 1);

  // ⑦ 定时器到点：抖动标记摘掉，后续 re-render 不会重放动画
  flushTimers();
  eq('抖动标记已摘掉', p.data.sortPulse, false);

  // ⑧ 排序模式下点卡片不编辑、左滑不展开
  p._moved = false;
  p.onRowTap(touch('a', 0, 0));
  eq('点卡片不打开抽屉', p.data.sheetOpen, false);
  p['form'] = p.data.form;
  p.onRowAct(touch('a', 0, 0));
  eq('操作按钮被锁：没有新的云调用', cloudCalls.length, 1);

  // ⑨ 切视图自动退出排序模式
  p.onBack();
  eq('返回总览后排序模式关闭', p.data.sortMode, false);
}

console.log('\n[13] 左滑开合：操作组只在「这一行被滑开」时存在（swipeKey 就是渲染闸门）');
{
  const p = ctx([['a', 'q1', 0, 0], ['b', 'q1', 0, 10]], 'detail');
  eq('初始没有任何行是滑开的', [p.data.swipeKey, p.data.swipeX], ['', 0]);

  // 轻轻推一下：位移不足 45% 阈值 → 松手必须整个收掉。
  // 早先这里留的是 swipeKey=id + swipeX=0，等于把 240rpx 的按钮组白挂在 DOM 里。
  p.onRowStart(touch('a', 300, 100));
  p.onRowMove(touch(null, 280, 100)); // dx = -20px → -40rpx
  eq('滑动中 swipeKey 已指向该行', [p.data.swipeKey, p.data.swipeX], ['a', -40]);
  p.onRowEnd();
  eq('位移不足：完全收回', [p.data.swipeKey, p.data.swipeX], ['', 0]);

  // 滑过阈值 → 停在 -240rpx，这时候操作组才该在
  p.onRowStart(touch('a', 300, 100));
  p.onRowMove(touch(null, 200, 100)); // dx = -100px → -200rpx
  p.onRowEnd();
  eq('滑过阈值：停在 -240rpx（面板宽度）', [p.data.swipeKey, p.data.swipeX], ['a', -240]);

  // 已滑开时点卡片 = 先收起，不进编辑
  p._moved = false;
  p.onRowTap(touch('a', 0, 0));
  eq('点已滑开的卡片 → 先收起，不打开抽屉', [p.data.swipeKey, p.data.sheetOpen], ['', false]);

  // 一次只允许滑开一行：滑 b 时 a 自动收回
  p.onRowStart(touch('a', 300, 100));
  p.onRowMove(touch(null, 180, 100));
  p.onRowEnd();
  eq('a 已滑开', p.data.swipeKey, 'a');
  p.onRowStart(touch('b', 300, 200));
  p.onRowMove(touch(null, 180, 200));
  p.onRowEnd();
  eq('滑开 b 之后只剩 b', [p.data.swipeKey, p.data.swipeX], ['b', -240]);
}

console.log('\n[14] 拖动竞态：量行位置的异步回调迟到，不许留下「僵尸拖动」');
{
  const p = ctx([['a', 'q1', 0, 0], ['b', 'q1', 0, 10], ['c', 'q1', 0, 20]], 'detail');
  cloudCalls.length = 0;
  p.onSortToggle();

  // ① 回调挂起：模拟「手指点一下就抬走，量行位置还在路上」
  measureDeferred = true;
  p.onHandleStart(touch('a', 100, 100));
  p.onHandleMove(touch(null, 100, 108));
  eq('拿起瞬间：已标记拖动中', [p.data.dragOn, p.data.dragId], [true, 'a']);
  eq('回调没回来之前 _dg 仍为空', !p._dg, true);
  p.onHandleEnd();
  eq('松手时把拖动残留收干净（不留抬起阴影）', [p.data.dragOn, p.data.dragId, p.data.dragY], [false, '', 0]);

  // ② 回调迟到：必须被丢弃。修复前它会装上 _dg，此后每次 touchmove 都被
  //    applyDragMove 接管，拿过期坐标重排整个列表 —— 就是「滑到的块都消失」。
  flushMeasure();
  measureDeferred = false;
  eq('迟到的回调没有装上僵尸拖动', !p._dg, true);

  // ③ 退出排序模式，走一次「正常滚动列表」的手势
  p.onSortToggle();
  eq('已退出排序模式', p.data.sortMode, false);

  const rowPatches = [];
  const rawSet = p.setData;
  p.setData = function (patch, cb) {
    if (patch && patch.rows) rowPatches.push(patch.rows);
    rawSet.call(p, patch, cb);
  };
  const scroll = function () {
    p.onRowStart(touch('a', 100, 500));
    p.onRowMove(touch(null, 100, 900)); // 往下扫 400px
    p.onRowEnd();
  };
  const order0 = ids(p);
  scroll();
  eq('滚动时不该整表重排 rows', rowPatches.length, 0);
  eq('没有位移残留', p.data.rows.map((r) => r.shift).join(','), '0,0,0');
  eq('顺序没被误改', ids(p), order0);
  eq('没有误发 reorder', cloudCalls.length, 0);

  // ④ 反向对照：手动装一个僵尸拖动，同一个手势立刻就会整表重排 ——
  //    说明这组断言真的能抓到它，而不是「写了也永远绿」。
  p._dg = { id: 'a', from: 0, to: 0, rects: fakeRects(p), flat: p.flatList(), dy: 0, base0: fakeRects(p)[0].top, lastY: null };
  scroll();
  p.setData = rawSet;
  p._dg = null;
  eq('（反向对照）僵尸拖动会让滚动整表重排 rows', rowPatches.length > 0, true);
}

console.log('\n[15] 视图层防回归：静止行不挂 transform / 拖与滚分属两个元素');
{
  const wxml = fs
    .readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.wxml'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, ''); // 去注释：注释里会引用「以前写过的写法」，否则误命中
  const wxss = fs
    .readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.wxss'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ''); // 同理

  const tfLines = wxml.split(/\r?\n/).filter(function (l) {
    return l.indexOf('style="transform:{{') >= 0;
  });
  eq('全页只有一处内联 transform（行位移）', tfLines.length, 1);
  eq(
    '行位移是条件渲染：静止时写 none，不带空位移图层',
    tfLines[0].indexOf(' ? ') > 0 && tfLines[0].indexOf("'none'") > 0,
    true
  );
  eq('.row 不常驻 overflow:hidden（不留裁剪层）', /\.row\s*\{[^}]*overflow/.test(wxss), false);
  eq('只有滑开的那一行裁剪（.row.sw）', /\.row\.sw\s*\{[^}]*overflow\s*:\s*hidden/.test(wxss), true);
  eq('模板给滑开的行挂了 sw 类', /swipeKey===item\._id\?'sw'/.test(wxml), true);

  // —— 图层纪律的另一面：静止的行不给 transform，但「正被拖动的那一张」必须
  //    提升为独立图层 —— 否则每帧都要重绘那圈 28px 模糊的抬起阴影。 ——
  eq(
    '被拖动的卡片提升为独立图层（阴影不跟着每帧重绘）',
    /\.row-in\.lift\s*\{[^}]*will-change\s*:\s*transform/.test(wxss),
    true
  );

  // —— 「拖」与「滚」的分界线：手柄必须 catch，卡片本体必须 bind ——
  //    只用 bind 手柄拦不住：事件照样冒泡到 scroll-view，会一边滚一边拖。
  //    反过来卡片本体误用 catch，整个列表就再也滚不动了。
  eq('手柄用 catch 吃掉 touchstart', /catchtouchstart="onHandleStart"/.test(wxml), true);
  eq('手柄用 catch 吃掉 touchmove', /catchtouchmove="onHandleMove"/.test(wxml), true);
  eq('手柄用 catch 吃掉 touchend / touchcancel', /catchtouchend="onHandleEnd"/.test(wxml), true);
  eq('卡片本体仍用 bind（用 catch 列表就滚不动了）', /bindtouchmove="onRowMove"/.test(wxml), true);
  eq('卡片本体没有误用 catch', /catchtouchmove="onRowMove"/.test(wxml), false);
  eq('手柄只在排序模式渲染', /class="dh"[\s\S]{0,200}wx:if="\{\{sortMode\}\}"/.test(wxml), true);
  eq('.dh 有样式规则', /\.dh\s*\{/.test(wxss), true);
  eq('.ico-drag 有样式规则（自绘图标不能只在 WXML 里出现）', /\.ico-drag\s*\{/.test(wxss), true);
  eq('滚动区不再按模式开关 scroll-y（拖与滚已分给不同元素）', /scroll-y="\{\{![^}]*\}\}"/.test(wxml), false);
  eq('滚动区接上 bindscroll（自动滚要读真实滚动量）', /bindscroll="onScrollerScroll"/.test(wxml), true);
  eq('滚动区绑定 scroll-top', /scroll-top="\{\{scrollTop\}\}"/.test(wxml), true);

  // —— 本轮的两处纯样式改动 ——
  eq('提示行左对齐的规则存在', /\.swipecue\.left\s*\{[^}]*text-align\s*:\s*left/.test(wxss), true);
  eq('详情页与全部页的提示行都挂了 left', (wxml.match(/class="swipecue left"/g) || []).length, 2);
  eq('总览页的矩阵说明没挂 left（仍居中）', /class="swipecue">矩阵/.test(wxml), true);
  eq('.stat 纵向居中（标题与数字不再贴顶）', /\.stat\s*\{[^}]*justify-content\s*:\s*center/.test(wxss), true);
}

console.log('\n[16] 排序模式可滚动：手柄管拖，手指贴边时列表自己滚');
{
  // ① 量不到滚动区（或不支持测量）→ 不自动滚，但拖动本身照常。
  //    降级只丢一个增强，不能连拖动一起废掉。
  resetScroll();
  SC_MEASURABLE = false;
  const p = ctx(
    [['a', 'q1', 0, 0], ['b', 'q1', 0, 10], ['c', 'q1', 0, 20], ['d', 'q1', 0, 30], ['e', 'q1', 0, 40]],
    'detail'
  );
  p.onSortToggle();
  p.onHandleStart(touch('a', 300, 500));
  p.onHandleMove(touch(null, 300, 508));
  eq('量不到也能拿起卡片', [p.data.dragOn, !!p._dg], [true, true]);
  eq('量不到 → 没有 _scBand', p._scBand, null);
  p.onHandleMove(touch(null, 300, 880)); // 贴住下边缘
  eq('量不到 → 不做边缘判定', p._dg.scrollDir, 0);
  flushTimers();
  eq('量不到 → 不会起自动滚的定时器', p._asTimer, null);
  p.onHandleEnd();

  // ② 量得到 → 手指贴住下边缘时列表自己滚；
  //    而且**被拖的卡片始终跟在手指下**（滚动量由 rects 抵消，不是靠手指去补）
  resetScroll();
  SC_MEASURABLE = true;
  SC.content = 2000; // 视口 600 → 可滚 1400
  const q = ctx(
    [['a', 'q1', 0, 0], ['b', 'q1', 0, 10], ['c', 'q1', 0, 20], ['d', 'q1', 0, 30], ['e', 'q1', 0, 40]],
    'detail'
  );
  q.onSortToggle();
  q.onHandleStart(touch('a', 300, 500));
  q.onHandleMove(touch(null, 300, 508));
  eq('量到滚动区的上下边', q._scBand, { top: 300, bottom: 900 });
  eq('手指在中间 → 不自动滚', q._dg.scrollDir, 0);

  q.onHandleMove(touch(null, 300, 850)); // 850 > 900-96 → 进入下边缘带
  eq('贴住下边缘 → 准备向下滚', q._dg.scrollDir, 1);

  // setData({scrollTop}) 只是「下指令」，要等 flushScroll() 才真的生效 ——
  // 真机上这就是 bindscroll 回来之前的那段时间
  flushTimers();
  flushScroll();
  eq('第一拍滚了一格', q.data.scrollTop, 14);
  eq('行位置快照跟着滚（整体上移 14）', q._dg.rects[0].top, 200 - 14);
  eq(
    '被拖的卡片仍停在手指下（屏幕位置不随滚动漂）',
    q._dg.rects[0].top + q.data.dragY,
    q._dg.base0 + (850 - q._dgY0)
  );

  flushTimers();
  flushScroll();
  eq('第二拍继续滚', q.data.scrollTop, 28);
  eq('累计位移也跟上了', q._dg.rects[0].top, 200 - 28);

  // ③ 手指离开边缘 → 立刻收手，不留定时器
  q.onHandleMove(touch(null, 300, 500));
  eq('离开边缘 → 方向归零', q._dg.scrollDir, 0);
  flushTimers();
  eq('收手后没有待执行的自动滚', q._asTimer, null);
  const st = q.data.scrollTop;
  flushScroll();
  eq('不再继续滚', q.data.scrollTop, st);

  // ④ 滚不动了（内容不比视口高）→ 不许对着墙一直 setData
  SC.content = SC.height;
  q._scrollTop = SC.scrollTop = 0;
  q.onHandleMove(touch(null, 300, 850));
  flushTimers();
  flushScroll(); // 第 1 拍：下了指令，被夹取 → 没生效
  flushTimers();
  flushScroll(); // 第 2 拍：发现推了没动 → 收手
  eq('滚不动 → 记住这个方向已到头', q._dg.asDirDone, 1);
  flushTimers();
  flushScroll();
  eq('收手后不再排新的一拍', q._asTimer, null);

  // ⑤ 手指再动一下（位置变了）→ 允许重试；松手必须把定时器停掉
  SC.content = 2000;
  q.onHandleMove(touch(null, 300, 860));
  flushTimers();
  flushScroll();
  eq('手指移动后重新开滚', q.data.scrollTop > 0, true);
  q.onHandleEnd();
  eq('松手后自动滚停了', q._asTimer, null);
  eq('松手后拖动状态清干净', [q.data.dragOn, q.data.dragId], [false, '']);

  SC_MEASURABLE = false; // 复位，别影响后面几组
  resetScroll();
}

console.log('\n[17] 版本握手：云端是旧包时首屏就提示重新部署');
{
  modalCalls.length = 0;
  const p = ctx([['a', 'q1', 0, 0]], 'detail');

  p.checkFnVer({ fnVer: PAGE_VER });
  eq('云端版本一致 → 静默', modalCalls.length, 0);

  p.checkFnVer({});
  eq('云端未上报版本 → 弹一次', modalCalls.length, 1);
  eq('标题指明版本过旧', modalCalls[0].title, '云函数版本过旧');
  eq('内容给出「上传并部署」这一步', /上传并部署/.test(modalCalls[0].content), true);

  p.checkFnVer({ fnVer: PAGE_VER - 1 });
  eq('同一会话不重复弹', modalCalls.length, 1);

  // 握手两端各有一份 FN_VER，只改一边等于白握 —— 直接读源码比对
  const pv = /const FN_VER = (\d+)/.exec(
    fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.js'), 'utf8')
  );
  const cv = /const FN_VER = (\d+)/.exec(
    fs.readFileSync(path.join(ROOT, 'cloudfunctions/fqTodo/index.js'), 'utf8')
  );
  eq('两端常量都存在', !!(pv && cv), true);
  eq('两端 FN_VER 相等（小程序 ' + (pv && pv[1]) + ' vs 云函数 ' + (cv && cv[1]) + '）', pv && cv && pv[1] === cv[1], true);
}

/* 最后一组走真实的 promise 链路：load() 必须把 bootstrap 的返回体原样交给握手检查。
   （fnVerWarned 是模块级一次性开关，所以顺序是「一致 → 不一致 → 再不一致」。） */
console.log('\n[18] load() 把 bootstrap 的返回体交给握手检查');
{
  const p = ctx([['a', 'q1', 0, 0]], 'detail');
  let seen = null;
  p.checkFnVer = function (d) {
    seen = d;
  };
  bootstrapPayload = {
    categories: [{ _id: CAT, name: '工作', order: 0 }],
    items: [
      { _id: 'a', title: 'a', quad: 'q1', catId: CAT, done: false, order: 0, priority: 3, note: '', remindAt: null },
    ],
    family: { id: 'fam1', name: '我的家庭', role: 'owner', isOwner: true, memberCount: 1, members: [], inviteCode: '', inviteExpire: 0, rev: 4 },
    fnVer: PAGE_VER,
  };
  p.load()
    .then(function () {
      eq('load() 成功路径调到了握手检查', seen !== null, true);
      eq('传下去的是 bootstrap 的返回体（含 fnVer）', seen && seen.fnVer, PAGE_VER);
      eq('load() 已把 items 写进镜像', p.items.length, 1);
      eq('load() 已把家庭写进镜像', p.fam && p.fam.id, 'fam1');
      eq('load() 已把 rev 记下来（自动同步要用）', p.rev, 4);
      eq('家庭信息进了 data，页面能直接渲染', p.data.fam.name, '我的家庭');
      eq('邀请码文案已算好', p.data.famInviteLabel, '生成邀请码');
    })
    .catch(function (err) {
      fail++;
      console.log('  ✗ 握手链路抛异常: ' + ((err && err.message) || err));
    });
}

/* 自动同步的避让规则。共享清单最容易出的一类投诉是「我点了一下，界面闪回去了」——
   成因就是轮询把服务端快照盖在还没落库的乐观更新上。这几条就是拦它的。
   注意这一组不能同步跑：前面各组发出的写操作还挂在微任务队列里，此刻
   pendingWrites 不为 0，而「让路」正是它的判定条件之一 —— 直接跑会测到上一组的余温。 */
console.log('\n[19] 自动同步：什么时候可以拉，什么时候必须让路');
function group19() {
  const p = ctx([['a', 'q1', 0, 0]], 'detail');
  p.setData({ ready: true });
  p.fam = { id: 'fam1', name: '我的家庭', role: 'owner', isOwner: true, memberCount: 1, members: [], inviteCode: '', inviteExpire: 0, rev: 7 };
  p.rev = 7;
  p._invite = '';
  cloudCalls.length = 0;

  p.startSync();
  eq('轮询已开', typeof tickFn, 'function');

  flushSync();
  eq('空闲时会发一次 sync', last().action, 'sync');
  eq('带的是本地 rev', last().rev, 7);

  // ① 正在拖动排序：绝不能拉，否则整张列表会在手指底下被换掉
  cloudCalls.length = 0;
  p.setData({ sortMode: true });
  flushSync();
  eq('排序模式中不发请求', cloudCalls.length, 0);

  // ② 抽屉开着正在编辑：列表在身后被换掉，保存就会落到一条已经不在的行上
  p.setData({ sortMode: false, sheetOpen: true });
  flushSync();
  eq('编辑抽屉开着时不发请求', cloudCalls.length, 0);

  // ③ 本地还有没落库的写操作：这是「点一下闪回去」的正源
  p.setData({ sheetOpen: false });
  flushSync();
  eq('恢复空闲后会继续拉', cloudCalls.length, 1);

  cloudCalls.length = 0;
  const origCall = global.wx.cloud.callFunction;
  let release = null;
  global.wx.cloud.callFunction = function (opts) {
    cloudCalls.push(opts.data);
    if (opts.data.action === 'updateItem') {
      // 挂起不 resolve，制造「写操作在路上」的状态
      return new Promise(function (res) {
        release = res;
      });
    }
    return Promise.resolve({ result: { ok: true, data: {} } });
  };

  p.toggleDone('a');
  eq('写操作已发出', cloudCalls.filter(function (c) { return c.action === 'updateItem'; }).length, 1);

  cloudCalls.length = 0;
  flushSync();
  eq('写操作未落库时不发 sync（否则乐观更新会被冲掉）', cloudCalls.length, 0);

  release({ result: { ok: true, data: { updated: 1 } } });

  // 排空微任务之后再断言：callCloud 内部有两级 then，commit 还挂了一个 catch。
  //
  // ⚠️ 这里刻意用 Promise 链而不是 await。本文件是 CommonJS，
  //    **模块顶层出现 await，Node 会直接拒绝加载**（ERR_AMBIGUOUS_MODULE_SYNTAX：
  //    同时看到 require() 和顶层 await，无法判断该按 CJS 还是 ESM 解析）。
  //    用 setImmediate 而不是连写几个 Promise.resolve().then —— 前者保证队列里
  //    **所有**微任务都跑完，后者只固定走几步，链路一长就不够了。
  //
  // 这一串也是整份测试的结算点：finish() 只挂在这里。
  new Promise(function (r) {
    setImmediate(r);
  }).then(function () {
    cloudCalls.length = 0;
    flushSync();
    eq('落库之后恢复同步', cloudCalls.length, 1);
    eq('恢复的确实是 sync', last().action, 'sync');

    global.wx.cloud.callFunction = origCall;

    // ④ 停轮询
    p.stopSync();
    cloudCalls.length = 0;
    flushSync();
    eq('stopSync 之后不再发请求', cloudCalls.length, 0);

    finish();
  });
}

// 等前面几组的写操作全部结算完，再开始 [19]。
new Promise(function (r) {
  setImmediate(r);
}).then(group19);

/* 家庭相关视图的静态约定。这些写成契约而不是靠人工检查，
   是因为它们坏了都不会报错 —— 只会「看不见」，而看不见的 bug 最难发现。 */
console.log('\n[20] 家庭视图层防回归');
{
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.js'), 'utf8');

  eq('「清空全家数据」只对创建者显示', /wx:if="\{\{fam\.isOwner\}\}" bindtap="onClearAll"/.test(wxml), true);
  eq('「生成邀请码」只对创建者显示', /wx:if="\{\{fam\.isOwner\}\}" bindtap="onGenInvite"/.test(wxml), true);
  eq('「退出家庭」只对非创建者显示', /wx:if="\{\{!fam\.isOwner\}\}" bindtap="onLeaveFamily"/.test(wxml), true);
  eq('「加入家人的家庭」对所有人显示', /\bbindtap="onJoinFamily"/.test(wxml), true);
  eq('成员行用服务端给的 key（不用 index，否则改名会串行）', /wx:key="key"/.test(wxml), true);

  // fid 绝不能被客户端当成入参发出去：云函数用的是管理员权限，
  // 一旦归属可以由入参决定，任何人构造一个请求就能读走全部家庭的数据。
  const cloudCallArgs = js.match(/callCloud\([^)]*\)/g) || [];
  eq('页面上确实有一批 callCloud 调用可查', cloudCallArgs.length >= 10, true);
  eq(
    '没有任何一处把 fid 当参数发给云函数',
    cloudCallArgs.filter(function (c) { return /fid/.test(c); }),
    []
  );
  eq('sync 只传 rev', /callCloud\('sync', \{ rev: this\.rev \}\)/.test(js), true);
  eq('joinFamily 只传 code', /callCloud\('joinFamily', \{ code: code \}\)/.test(js), true);

  // 自动同步的三个避让条件缺一不可
  eq('syncTick 里同时判了 sortMode / 未落库写 / 抽屉', /sortMode \|\| pendingWrites > 0 \|\| this\.data\.sheetOpen/.test(js), true);
  eq('onShow 会起轮询', /onShow\(\)[\s\S]{0,200}startSync\(\)/.test(js), true);
  eq('onHide 会停轮询', /onHide\(\)[\s\S]{0,120}stopSync\(\)/.test(js), true);

  // 分享卡片带邀请码 —— 这是「让家人用起来」最省事的入口
  eq('分享卡片会带上邀请码', /pages\/index\/index\?code=/.test(js), true);
  eq('onLoad 会接住卡片带来的邀请码', /options && \(options\.code \|\| options\.inviteCode\)/.test(js), true);
}

/* 分类删除 / 改名。和 [20] 一样，坏掉都不会报错 —— 只会「点了没反应」或
   「删错行」，所以既有静态契约，也有真跑方法的交互断言。 */
console.log('\n[21] 分类管理：长按改名 / 删除分类');
{
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.js'), 'utf8');
  const cloudSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions/fqTodo/index.js'), 'utf8');

  // ---- 入口：长按，而不是占用整行点击 ----
  eq('分类行挂了长按', /bindlongpress="onLongPressCat"/.test(wxml), true);
  eq('长按与点击挂在同一行（点行仍是切分类）', /bindtap="onPickCat"\s*\n\s*bindlongpress="onLongPressCat"/.test(wxml), true);
  eq('卡片底部有常驻的长按提示', /长按任意分类，可重命名或删除/.test(wxml), true);
  eq('「删除分类」只在该删的时候渲染', /wx:if="\{\{catCanDel\}\}" bindtap="onCatDeleteAsk"/.test(wxml), true);
  eq('不能删时把原因写出来', /只有家庭创建者可以删除/.test(wxml), true);
  eq('级联删除是一条单独的红色入口', /class="func warn" bindtap="onCatDeleteCascade"/.test(wxml), true);
  eq('「事项新家」由 moveRows 渲染', /wx:for="\{\{moveRows\}\}"[\s\S]{0,140}bindtap="onPickMoveTo"/.test(wxml), true);
  eq('抽屉有 catmenu 分支', /sheetKind==='catmenu'/.test(wxml) || /sheetKind==='catmenu'/.test(js), true);

  // ---- 协议与写操作名单 ----
  eq('本端 FN_VER 已升到 4 以上', PAGE_VER >= 4, true);
  eq('云函数动作清单里有 removeCategory', /'removeCategory'/.test(cloudSrc), true);
  eq('云函数动作清单里有 renameCategory', /'renameCategory'/.test(cloudSrc), true);
  eq('removeCategory 算写操作', /'removeCategory'/.test(js), true);
  eq('renameCategory 算写操作', /'renameCategory'/.test(js), true);

  // ---- 安全：服务端自己数事项，绝不采信客户端 ----
  eq(
    '服务端独立复核「非空」（不信客户端传来的判断）',
    /const used = await db\.collection\(COL_ITEMS\)\.where\(\{ fid: ctx\.fid, catId: id \}\)\.count\(\)/.test(cloudSrc),
    true
  );
  eq(
    'fid 依然没有任何一处当参数发给云函数',
    (js.match(/callCloud\([^)]*\)/g) || []).filter(function (c) { return /fid/.test(c); }),
    []
  );

  // ---- 关键约定：删的是「被长按的那一行」，不是当前选中的分类 ----
  eq('长按记录的是被按的那一行', /catMenuId: id/.test(js), true);
  eq('删除后把当前分类拉回合法值（否则整页空白）', /that\.fixCatId\(\);\s*\n\s*\}, p\);/.test(js), true);
  eq('本地也拦「最后一个分类」', /至少要保留一个分类/.test(js), true);

  // ---- 行为：长按开面板 ----
  const p = ctx([], 'mine');
  p.cats = [
    { _id: 'c1', name: '工作', order: 0 },
    { _id: 'c2', name: '空的', order: 1 },
  ];
  p.items = [{ _id: 'a', quad: 'q1', done: false, order: 0, title: 'a', catId: 'c1', priority: 3 }];
  p.fam = { id: 'fam1', name: '我的家庭', role: 'owner', isOwner: true, memberCount: 1, members: [], inviteCode: '', inviteExpire: 0, rev: 3 };
  p.state = { view: 'mine', catId: 'c2', quad: 'q1', filt: 'all' };
  p.render();

  p.onLongPressCat({ currentTarget: { dataset: { k: 'c1' } } });
  eq('长按「工作」→ 面板打开', p.data.sheetOpen, true);
  eq('面板类型正确', p.data.sheetKind, 'catmenu');
  eq('标题是被按的那一行（不是当前选中的 c2）', p.data.sheetTitle, '工作');
  eq('数出该分类下的事项条数', p.data.catDelCount, 1);
  eq('创建者可以删非空分类', p.data.catCanDel, true);

  p.onLongPressCat({ currentTarget: { dataset: { k: 'c2' } } });
  eq('空分类：条数为 0', p.data.catDelCount, 0);
  eq('空分类谁都能删', p.data.catCanDel, true);

  // ---- 行为：成员遇到非空分类，界面上就不给删 ----
  p.fam = { id: 'fam1', name: '我家', role: 'member', isOwner: false, memberCount: 2, members: [], inviteCode: '', inviteExpire: 0, rev: 3 };
  p.onLongPressCat({ currentTarget: { dataset: { k: 'c1' } } });
  eq('成员 + 非空分类 → 不给删', p.data.catCanDel, false);
  p.onLongPressCat({ currentTarget: { dataset: { k: 'c2' } } });
  eq('成员 + 空分类 → 可以删', p.data.catCanDel, true);

  // ---- 行为：空分类，一次确认就删 ----
  p.fam = { id: 'fam1', name: '我家', role: 'owner', isOwner: true, memberCount: 1, members: [], inviteCode: '', inviteExpire: 0, rev: 3 };
  p.state = { view: 'mine', catId: 'c2', quad: 'q1', filt: 'all' };
  p.render();
  cloudCalls.length = 0;
  modalCalls.length = 0;
  p.onLongPressCat({ currentTarget: { dataset: { k: 'c2' } } });
  p.onCatDeleteAsk();
  eq('空分类只弹一个确认框', modalCalls.length, 1);
  eq('文案说明不可恢复', /不可恢复/.test(modalCalls[0].content), true);
  eq('确认之前不发请求', cloudCalls.length, 0);

  modalCalls[0].success({ confirm: true });
  eq('确认后发出 removeCategory', last().action, 'removeCategory');
  eq('只带 id（空分类没有事项要搬）', Object.keys(last()).sort(), ['action', 'id']);
  eq('镜像里分类已摘掉', p.cats.filter(function (c) { return c._id === 'c2'; }).length, 0);
  eq('删掉正是当前分类 → 自动回落到第一个', p.state.catId, 'c1');

  // ---- 行为：非空分类，先给这 N 条找新家 ----
  const p2 = ctx([], 'mine');
  p2.cats = [{ _id: 'c1', name: '工作', order: 0 }, { _id: 'c2', name: '生活', order: 1 }];
  p2.items = [
    { _id: 'a', quad: 'q1', done: false, order: 0, title: 'a', catId: 'c1', priority: 3 },
    { _id: 'b', quad: 'q1', done: false, order: 10, title: 'b', catId: 'c1', priority: 3 },
  ];
  p2.fam = { id: 'fam1', name: '我家', role: 'owner', isOwner: true, memberCount: 1, members: [], inviteCode: '', inviteExpire: 0, rev: 3 };
  p2.state = { view: 'mine', catId: 'c2', quad: 'q1', filt: 'all' };
  p2.render();

  cloudCalls.length = 0;
  modalCalls.length = 0;
  p2.onLongPressCat({ currentTarget: { dataset: { k: 'c1' } } });
  p2.onCatDeleteAsk();
  eq('非空分类不弹确认框，直接进第二步', modalCalls.length, 0);
  eq('抽屉切到「选事项新家」', p2.data.sheetKind, 'catdel');
  eq('候选里不含自己', p2.data.moveRows, [{ id: 'c2', name: '生活' }]);
  eq('副标题说清还剩几条', p2.data.sheetSub, '「工作」下还有 2 条事项');
  eq('这一步还没发请求', cloudCalls.length, 0);

  p2.onPickMoveTo({ currentTarget: { dataset: { k: 'c2' } } });
  eq('选了新家 → 发出 removeCategory', last().action, 'removeCategory');
  eq('带上 moveTo', last().moveTo, 'c2');
  eq('事项在镜像里一条没少', p2.items.length, 2);
  eq('两条都改了归属', p2.items.filter(function (it) { return it.catId === 'c2'; }).length, 2);
  eq('分类已摘掉', p2.cats.filter(function (c) { return c._id === 'c1'; }).length, 0);

  // ---- 行为：级联删除必须二次确认 ----
  const p3 = ctx([], 'mine');
  p3.cats = [{ _id: 'c1', name: '工作', order: 0 }, { _id: 'c2', name: '生活', order: 1 }];
  p3.items = [{ _id: 'a', quad: 'q1', done: false, order: 0, title: 'a', catId: 'c1', priority: 3 }];
  p3.fam = { id: 'fam1', name: '我家', role: 'owner', isOwner: true, memberCount: 1, members: [], inviteCode: '', inviteExpire: 0, rev: 3 };
  p3.state = { view: 'mine', catId: 'c2', quad: 'q1', filt: 'all' };
  p3.render();

  cloudCalls.length = 0;
  modalCalls.length = 0;
  p3.onLongPressCat({ currentTarget: { dataset: { k: 'c1' } } });
  p3.onCatDeleteAsk();
  p3.onCatDeleteCascade();
  eq('级联删除再弹一次确认', modalCalls.length, 1);
  eq('确认键用危险色', modalCalls[0].confirmColor, '#D9303C');
  eq('文案点明家人的条目也在其中', /家庭成员录入的也在其中/.test(modalCalls[0].content), true);
  eq('没确认就不发请求', cloudCalls.length, 0);
  eq('事项还在', p3.items.length, 1);

  modalCalls[0].success({ confirm: true });
  eq('确认后才发请求', last().action, 'removeCategory');
  eq('不带 moveTo（就是一并删）', last().moveTo, undefined);
  eq('本地把事项也摘掉了', p3.items.length, 0);
  eq('分类也摘掉了', p3.cats.filter(function (c) { return c._id === 'c1'; }).length, 0);

  // ---- 行为：只剩一个分类时不许删 ----
  const p4 = ctx([], 'mine');
  p4.cats = [{ _id: 'c1', name: '唯一', order: 0 }];
  p4.items = [];
  p4.fam = { id: 'fam1', name: '我家', role: 'owner', isOwner: true, memberCount: 1, members: [], inviteCode: '', inviteExpire: 0, rev: 3 };
  p4.state = { view: 'mine', catId: 'c1', quad: 'q1', filt: 'all' };
  p4.render();
  cloudCalls.length = 0;
  modalCalls.length = 0;
  p4.onLongPressCat({ currentTarget: { dataset: { k: 'c1' } } });
  p4.onCatDeleteAsk();
  eq('只剩一个分类 → 连确认框都不弹', modalCalls.length, 0);
  eq('也没发请求', cloudCalls.length, 0);
  eq('分类还在', p4.cats.length, 1);

  // ---- 行为：成员硬点删除，界面这一层也发不出去 ----
  const p5 = ctx([], 'mine');
  p5.cats = [{ _id: 'c1', name: '工作', order: 0 }, { _id: 'c2', name: '生活', order: 1 }];
  p5.items = [{ _id: 'a', quad: 'q1', done: false, order: 0, title: 'a', catId: 'c1', priority: 3 }];
  p5.fam = { id: 'fam1', name: '我家', role: 'member', isOwner: false, memberCount: 2, members: [], inviteCode: '', inviteExpire: 0, rev: 3 };
  p5.state = { view: 'mine', catId: 'c2', quad: 'q1', filt: 'all' };
  p5.render();
  cloudCalls.length = 0;
  modalCalls.length = 0;
  p5.onLongPressCat({ currentTarget: { dataset: { k: 'c1' } } });
  p5.onCatDeleteAsk();
  eq('成员硬点删除 → 请求和确认框都没有', cloudCalls.length + modalCalls.length, 0);
  eq('分类没被删', p5.cats.length, 2);

  // ---- 行为：改名。（prompt 走 promise，success 只是 resolve ——
  //      所以这段断言放到下一拍；promise 的微任务排在 setImmediate 之前，
  //      不至于跑到 [19] 末尾的 finish() 后面去。） ----
  const p6 = ctx([], 'mine');
  p6.cats = [{ _id: 'c1', name: '工作', order: 0 }];
  p6.items = [];
  p6.fam = { id: 'fam1', name: '我家', role: 'owner', isOwner: true, memberCount: 1, members: [], inviteCode: '', inviteExpire: 0, rev: 3 };
  p6.state = { view: 'mine', catId: 'c1', quad: 'q1', filt: 'all' };
  p6.render();
  global.wx.canIUse = function () {
    return true;
  };

  p6.onLongPressCat({ currentTarget: { dataset: { k: 'c1' } } });
  cloudCalls.length = 0;
  modalCalls.length = 0;
  p6.onRenameCategory();
  eq('改名弹的是可输入框', modalCalls[0].editable, true);
  eq('输入框预填当前名字', modalCalls[0].content, '工作');
  eq('确认之前不发请求', cloudCalls.length, 0);

  modalCalls[0].success({ confirm: true, content: '  阅读  ' });
  Promise.resolve().then(function () {
    eq('改名发出 renameCategory', last().action, 'renameCategory');
    eq('带的是被长按的分类 id', last().id, 'c1');
    eq('名字已去掉首尾空格', last().name, '阅读');
    eq('镜像里的名字跟着改了', p6.cats[0].name, '阅读');
    eq('改完把抽屉关掉', p6.data.sheetOpen, false);

    // 原样确定 = 用户取消，不该白发一次请求
    cloudCalls.length = 0;
    modalCalls.length = 0;
    p6.onLongPressCat({ currentTarget: { dataset: { k: 'c1' } } });
    p6.onRenameCategory();
    modalCalls[0].success({ confirm: true, content: '阅读' });
    return Promise.resolve().then(function () {
      eq('名字没变就不发请求（原样确定 = 取消）', cloudCalls.length, 0);
    });
  });
}

console.log('\n[22] 拖动上手体验：启动竞态不许反复重来 + 高频位移必须量化去重');
{
  const rows = [['a', 'q1', 0, 0], ['b', 'q1', 0, 10], ['c', 'q1', 0, 20]];

  // ---- ① 启动竞态：`_dg` 要等量行位置的回调才装上，这中间手指一直在动，
  //        每个 touchmove 都会再喊一次 startDrag。修复前它会把在途回调全废掉，
  //        手指不停就永远拿不起卡片 —— 就是「按住拖不动，要多试好几次」。 ----
  measureDeferred = true;
  const m0 = measureQueue.length;

  const p = ctx(rows, 'detail');
  p.onSortToggle();
  let rawSet = p.setData;
  let pickups = 0;
  p.setData = function (patch, cb) {
    // startDrag 的那一次 setData 一定带 dragId；重复调用会把它推好几次
    if (patch && patch.dragId !== undefined) pickups++;
    rawSet.call(p, patch, cb);
  };

  p.onHandleStart(touch('a', 100, 100));
  p.onHandleMove(touch(null, 100, 108));
  p.onHandleMove(touch(null, 100, 116));
  p.onHandleMove(touch(null, 100, 124));
  eq('起点连续 touchmove：只拿起一次（不许反复重来）', pickups, 1);
  eq('量行位置只排队一次（补发的全被闸挡掉）', measureQueue.length - m0, 1);
  eq(
    '位移原点定在拿起那一下，不被后续 touchmove 改写',
    p._dgY0,
    108
  );

  flushMeasure();
  eq('回调落地后卡片才真正拿起来', !!p._dg, true);
  eq('闸在装上状态机之后自动松开（不阻塞下一轮手势）', p._dgP, null);

  // 拿起来之后位移要照常生效：手指再往下 116px（一个步长）→ 换到第 2 位
  p.onHandleMove(touch(null, 100, 108 + 116));
  eq('拿起来之后拖动正常生效', p.data.dragY, 116);
  eq('落点也算到了第 2 位', p._dg.to, 1);
  p.onHandleEnd();
  eq('顺序已变 b,a,c', ids(p), ['b', 'a', 'c']);

  // ---- ② 反向对照：每步手动把闸拆掉（＝修复前的行为），同一个手势立刻反复重来。
  //        没有这一段，上面那组断言可能是「写了也永远绿」。 ----
  const m1 = measureQueue.length;
  const r = ctx(rows, 'detail');
  r.onSortToggle();
  let rawR = r.setData;
  let rPickups = 0;
  r.setData = function (patch, cb) {
    if (patch && patch.dragId !== undefined) rPickups++;
    rawR.call(r, patch, cb);
  };
  r.onHandleStart(touch('a', 100, 100));
  r.onHandleMove(touch(null, 100, 108));
  r._dgP = null; // ← 拆掉闸
  r.onHandleMove(touch(null, 100, 116));
  r._dgP = null;
  r.onHandleMove(touch(null, 100, 124));
  eq('（反向对照）拆掉闸就会反复重来', rPickups, 3);
  eq('（反向对照）量行位置被排了 3 次', measureQueue.length - m1, 3);
  eq('（反向对照）位移原点被最后一次覆盖成 124', r._dgY0, 124);
  flushMeasure();
  eq('（反向对照）只有最后一次的回调算数', !!r._dg, true);
  r.onHandleEnd();
  measureDeferred = false;

  // ---- ③ 高频位移量化 + 去重。dragY 挂在**每一行**的 style 表达式里，
  //        每 setData 一次整个列表都要重算样式 —— 亚像素重复推送就是卡顿的主因。 ----
  const q = ctx(rows, 'detail');
  q.onSortToggle();
  q.onHandleStart(touch('a', 100, 100));
  q.onHandleMove(touch(null, 100, 108)); // 同步量到 → _dg 立刻装上，但这一下不推位移
  eq('已拿起', !!q._dg, true);

  let yPushes = 0;
  const rawY = q.setData;
  q.setData = function (patch, cb) {
    if (patch && patch.dragY !== undefined) yPushes++;
    rawY.call(q, patch, cb);
  };

  q.onHandleMove(touch(null, 100, 108.2));
  eq('亚像素位移不推视图层', yPushes, 0);
  q.onHandleMove(touch(null, 100, 108.4));
  eq('仍在同一像素格内 → 还是不推', yPushes, 0);
  q.onHandleMove(touch(null, 100, 111));
  eq('跨过一个整数像素才推一次', yPushes, 1);
  eq('推下去的是量化后的整数', q.data.dragY, 3);
  q.onHandleMove(touch(null, 100, 111.3));
  eq('同一像素格内不重复推', yPushes, 1);
  q.onHandleEnd();
}

/* 提醒推送（v5）的客户端契约。
   盯的是额度的两头：一头是**攒**（必须由用户交互触发、只认 accept），
   一头是**显示**（额度与未送达都由服务端算）。这两头坏了都不报错 ——
   只会表现为「明明设了提醒却收不到」，或者「额度悄悄少了却不知道为什么」。 */
console.log('\n[23] 提醒推送视图层防回归（v5）');
{
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.js'), 'utf8');

  eq('两端协议版本都是 5', Number(/const FN_VER = (\d+)/.exec(js)[1]), 5);

  // ---- 模板 id 只有服务端一个来源 ----
  eq('客户端不硬编码模板 id', /1AaZ3iSMfGpplGMUIVArXIPssCKAj2p3hHFxJPpOmlM/.test(js), false);
  eq('模板 id 由 adoptSub 从 bootstrap 存下来', /if \(s\.templateId\) this\.subTpl = s\.templateId;/.test(js), true);

  // ---- 攒额度：一个入口、一个条件、一种结果才算数 ----
  const subs = js.match(/wx\.requestSubscribeMessage\(\{/g) || [];
  eq('弹授权的地方全文件只有一处（没有旁路补额度的入口）', subs.length, 1);
  eq('只在保存带提醒的事项时请求', /if \(remindAt\) this\.askSubscribe\(\);/.test(js), true);
  eq('只有用户点了「允许」才记账', /res\[tpl\] === 'accept'/.test(js), true);
  eq('grantSub 只传模板 id（加多少由服务端定）', /callCloud\('grantSub', \{ templateId: tpl \}\)/.test(js), true);
  eq('grantSub 占住同步避让名额', /'grantSub',\n\]/.test(js), true);

  // requestSubscribeMessage 必须在**这一次 tap 的调用栈里**调 ——
  // 挪进 callCloud 的 then 里就过了「用户交互后」这个窗口。
  const saveStart = js.indexOf('onSave() {');
  const saveEnd = js.indexOf('/* ================= 交互：分类 =================');
  const save = js.slice(saveStart, saveEnd);
  eq('onSave 里请求授权排在 closeSheet 之后', save.indexOf('this.askSubscribe()') > save.indexOf('this.closeSheet()'), true);
  eq('onSave 里请求授权排在落库之前（同一调用栈）', save.indexOf('this.askSubscribe()') < save.indexOf("callCloud('addItem'"), true);

  // ---- 显示：两个数都由服务端算 ----
  eq('首屏与同步都接收 sub', (js.match(/that\.adoptSub\(data\.sub\);/g) || []).length, 2);
  eq('我的页有「提醒」卡片', /<view class="h4">提醒<\/view>/.test(wxml), true);
  eq('未送达入口只在有未送达时出现', /wx:if="\{\{subMissed>0\}\}" bindtap="onExplainMissed"/.test(wxml), true);
  eq('未送达点了会给解释，不静默', /onExplainMissed\(\) \{/.test(js), true);
  eq('解释文案讲清了「一次性订阅」这件事', /一次性订阅/.test(js), true);
  eq('关于卡片标了提醒推送', /v1\.2（共享家庭 · 提醒推送）/.test(wxml), true);

  // ---- 行为：adoptSub 的收敛与容错（老云函数回包没有 sub） ----
  const m = ctx([], 'mine');
  m.adoptSub({ quota: 3, missed: 2, templateId: 'TPL-X' });
  eq('额度落进 data', m.data.subQuota, 3);
  eq('未送达落进 data', m.data.subMissed, 2);
  eq('模板 id 存进内部镜像', m.subTpl, 'TPL-X');
  m.adoptSub({ quota: -5, missed: -1 });
  eq('负数被夹到 0', [m.data.subQuota, m.data.subMissed], [0, 0]);
  m.adoptSub({ quota: 'x' });
  eq('脏值不写成 NaN', m.data.subQuota, 0);
  m.adoptSub(null);
  eq('服务端没给 sub 时不炸', m.data.subQuota, 0);
  eq('也不清掉已有的模板 id', m.subTpl, 'TPL-X');
}

// 整份测试的结算点。由 [19] 的 Promise 链末尾调用（见那里的说明）。
// 自带一次性闸门：将来若有人又在别处补一个 finish()，也不会出现「跑一半就 exit」。
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}
