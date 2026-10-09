// .workbuddy/tools/test-water.js
// 今日饮水 · 逻辑仿真
//
// 为什么单独一个文件：饮水是**第一个完全不依赖云端的功能** —— 它不进 fqTodo 的
// action 体系，test-reorder / test-cloudfn / test-remind 三个仿真一个都覆盖不到它。
// 而它恰好有三条「错了也不报错、只是体验悄悄变坏」的规则：
//   ① 吸附：手指停在任意位置，读数都必须是 step 的整数倍（否则会出现 1237 这种数字）；
//   ② 夹紧：拖出轨道两端要停在 0 / 目标值，不能越界；
//   ③ 事件时机：按住期间**一次都不许** triggerEvent（高频路径不出组件），
//      松手必须**恰好发一次**（多发 = 重复写存储，不发 = 用户拖了个寂寞）。
//   —— 还有一条最容易被忽略的：跨天清零靠的是「key 里带日期」，
//      哪天有人把 key 改成固定字符串，功能当场静默坏掉。这条用静态契约钉住。
//
// 两个来源的实际取法（与项目里其它检查同一个原则：按**语义**挑源码）：
//   · 组件侧 → 真跑 fq-water.js（假宿主 Component / wx，真 require const.js）
//   · 页面侧 → 读 index.js 源码做静态断言（那三行是存储读写，动态跑要拖进整个 Page 沙箱，
//             收益不抵复杂度；真正的逻辑在组件侧，已经动态跑了）
//
// 运行：node .workbuddy/tools/test-water.js   （失败退出码 1）

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MP = path.join(ROOT, 'miniprogram');
const W_JS = path.join(MP, 'components', 'fq-water', 'fq-water.js');
const W_WXML = path.join(MP, 'components', 'fq-water', 'fq-water.wxml');
const P_JS = path.join(MP, 'pages', 'index', 'index.js');
const P_WXML = path.join(MP, 'pages', 'index', 'index.wxml');
const C_JS = path.join(MP, 'utils', 'const.js');

let pass = 0;
let fail = 0;

function ok(cond, label) {
  if (cond) {
    pass++;
  } else {
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

const CONST = require(C_JS);

/* ================= 组件侧：真跑 fq-water.js ================= */

const wsrc = fs.readFileSync(W_JS, 'utf8');

const fakeWx = {
  createSelectorQuery() {
    const q = {
      in() { return q; },
      select() { return q; },
      boundingClientRect(cb) { q._cb = cb; return q; },
      exec() { if (q._cb) q._cb(null); },   // 量不到（null）→ 组件保留旧值
    };
    return q;
  },
};

let def = null;
new Function('Component', 'require', 'wx', wsrc)(
  function (o) { def = o; },
  function (p) {
    if (/const\.js$/.test(p)) return CONST;
    throw new Error('fq-water 里出现了意料之外的 require：' + p);
  },
  fakeWx
);

section('【组件契约】');
ok(!!def, '组件定义能取出');
ok(def && def.options && def.options.virtualHost === true, 'options.virtualHost: true（不产生额外节点）');
ok(def && def.options && def.options.styleIsolation === 'apply-shared', 'options.styleIsolation: apply-shared');

// 造一个假组件实例：_twLeft/_twWidth 就是「量到的轨道几何」。
function inst(left, width) {
  const it = {
    data: { wcur: 0, wdrag: false, goal: CONST.WATER_GOAL },
    _twLeft: left === undefined ? 0 : left,
    _twWidth: width === undefined ? 400 : width,
    _setCount: 0,
    events: [],
    setData(patch) { this._setCount++; Object.assign(this.data, patch); },
    triggerEvent(n, d) { this.events.push({ n: n, d: d }); },
  };
  Object.keys(def.methods).forEach(function (k) { it[k] = def.methods[k].bind(it); });
  return it;
}
function touch(x) { return { touches: [{ clientX: x }] }; }

section('');
section('【① 吸附：任意位置都落在 step 的整数倍】');
{
  const it = inst();
  const step = CONST.WATER_GOAL / 40;
  let bad = 0;
  let first = null;
  for (let x = -60; x <= 460; x += 1) {
    it.data.wcur = -1;                     // 强制每次都真的算一遍
    it.applyTouch(touch(x));
    if (it.data.wcur % step !== 0) { bad++; if (first === null) first = [x, it.data.wcur]; }
  }
  ok(bad === 0, '521 个位置全部吸附到 ' + step + 'ml 的整数倍' + (bad ? '，越界 ' + bad + ' 次，首个 ' + JSON.stringify(first) : ''));
}
{
  const it = inst();
  it.applyTouch(touch(200));
  eq(it.data.wcur, 1000, '轨道正中 → 1000ml（目标的一半）');
}
{
  const it = inst(100, 400);               // 轨道左边缘在屏幕 100px
  it.applyTouch(touch(300));               // 相对位置 200/400
  eq(it.data.wcur, 1000, '轨道有左偏移时按「相对位置」算，不按绝对坐标');
}
{
  const it = inst();
  it.data.goal = 1000;                     // 目标改成 1000 → 档位变 25
  let bad = 0;
  for (let x = 0; x <= 400; x += 3) {
    it.data.wcur = -1;
    it.applyTouch(touch(x));
    if (it.data.wcur % 25 !== 0) bad++;
  }
  ok(bad === 0, '目标变了档位跟着变（1000 目标 → 25ml 一档）');
}

section('');
section('【② 夹紧：拖出轨道两端不越界】');
{
  const it = inst();
  it.applyTouch(touch(-9999));
  eq(it.data.wcur, 0, '拖到左端之外 → 0');
  it.applyTouch(touch(9999));
  eq(it.data.wcur, CONST.WATER_GOAL, '拖到右端之外 → 目标值');
}

section('');
section('【③ 事件时机：按住不发，松手恰好一次】');
{
  const it = inst();
  it.onWaterStart(touch(400));
  eq(it.events.length, 0, '按下不发事件');
  eq(it.data.wcur, CONST.WATER_GOAL, '按下即按落点定位（不用先移动一次）');
  it.onWaterMove(touch(200));
  it.onWaterMove(touch(100));
  eq(it.events.length, 0, '拖动中一次都不发（高频路径不出组件）');
  it.onWaterEnd();
  eq(it.events.length, 1, '松手恰好发一次');
  eq(it.events[0].n, 'change', '事件名是 change');
  eq(it.events[0].d.ml, 500, '事件带回最终饮水量');
}
{
  const it = inst();
  it.onWaterStart(touch(100));
  it.onWaterEnd();
  const n = it.events.length;
  it.onWaterMove(touch(400));              // 松手之后再来 move
  it.onWaterEnd();                         // 以及再收一次尾
  eq(it.events.length, n, '松手后再 move / 再 end 都不再发事件');
  eq(it.data.wcur, 500, '松手后数值不再被 move 改写');
}
{
  const it = inst();
  it.onWaterMove(touch(200));              // 没按过就 move（不该有反应）
  eq(it.data.wcur, 0, '没按下时的 move 被忽略');
}

section('');
section('【④ 去重：同一档位不重复 setData】');
{
  const it = inst();
  it.onWaterStart(touch(200));
  const n0 = it._setCount;
  it.onWaterMove(touch(200));
  it.onWaterMove(touch(201));
  it.onWaterMove(touch(199));
  eq(it._setCount, n0, '停在 1000ml 上反复 move，不再 setData');
}

section('');
section('【⑤ observer：外部值也要夹紧】');
{
  const obs = def.properties.ml.observer;
  const it = inst();
  obs.call(it, 1500);
  eq(it.data.wcur, 1500, '外部传入 1500 → 显示 1500');
  obs.call(it, 99999);
  eq(it.data.wcur, CONST.WATER_GOAL, '超出目标 → 夹到目标值');
  obs.call(it, -8);
  eq(it.data.wcur, 0, '负数 → 夹到 0');
  obs.call(it, 'x');
  eq(it.data.wcur, 0, '非数字 → 0（不会显示 NaN）');
}

/* ================= 页面侧：静态契约 ================= */

section('');
section('【页面侧：存储与跨天】');

const pjs = fs.readFileSync(P_JS, 'utf8');
const wxml = fs.readFileSync(W_WXML, 'utf8');    // 组件自己的模板：刻度 / 手势
const pwxml = fs.readFileSync(P_WXML, 'utf8');   // 页面模板：组件标签是怎么接上去的

ok(
  /waterKey\(\)\s*\{\s*return WATER_KEY \+ todayStr\(\);\s*\}/.test(pjs),
  'key = 前缀 + 今天日期（跨天读到的就是空 key = 清零，不需要定时任务）'
);
ok(
  /wx\.getStorageSync\(this\.waterKey\(\)\)/.test(pjs),
  'loadWater 从本机存储读'
);
ok(
  /wx\.setStorageSync\(this\.waterKey\(\), ml\)/.test(pjs),
  'onWaterChange 写回本机存储'
);
ok(
  /this\.checkWaterDay\(\);/.test(pjs),
  'syncTick 里做了跨零点检查'
);
ok(
  /if\s*\(d === this\._waterDay\)\s*return;/.test(pjs),
  'checkWaterDay 只在日期真的变了才刷新（同一拍不白刷）'
);
ok(
  /waterMl: 0,/.test(pjs) && /waterGoal: WATER_GOAL,/.test(pjs),
  'data 里有 waterMl / waterGoal'
);
ok(
  /const ml = Math\.max\(0, Math\.min\(WATER_GOAL,/.test(pjs),
  '页面侧对组件回传的值再夹一次（不信任单一来源）'
);

section('');
section('【组件接线：标签 + 刻度】');
ok(
  /<fq-water[^>]*ml="\{\{waterMl\}\}"/.test(pwxml),
  '组件用 ml="{{waterMl}}" 接页面数据'
);
ok(
  /<fq-water[^>]*bind:change="onWaterChange"/.test(pwxml),
  '组件 change 事件接在 onWaterChange 上'
);
ok(
  /left:25%/.test(wxml) && /left:50%/.test(wxml) && /left:75%/.test(wxml),
  '3 道刻度落在 25 / 50 / 75%（= 500 / 1000 / 1500ml，与 WATER_GOAL 对应）'
);
ok(
  wxml.indexOf('catchtouchmove') >= 0,
  '轨道用 catchtouchmove（横向拖动不再冒泡到 scroll-view）'
);
ok(
  wxml.indexOf('class="wu"') < 0,
  '没有残留的未定义 class（曾经用过 .wu 但没写样式，被 mp-check 抓到）'
);
ok(
  /class="wtrack\s*\{\{wdrag\s*\?\s*'on'\s*:\s*''\}\}"/.test(wxml),
  '按住时的抓取反馈挂在 .wtrack 上（轨道加深 + 圆点放大由 app.wxss 的 .wtrack.on 提供；' +
    '这一条丢了就是静默的 —— 手感没了，画面上什么都不缺）'
);

section('');
console.log('========================================');
console.log('饮水：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
