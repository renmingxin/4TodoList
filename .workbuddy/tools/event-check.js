#!/usr/bin/env node
/*
 * event-check.js —— 事件接线契约
 *
 * 为什么需要它（血的教训）：
 *   组件化把 WXML 逐字搬进组件，`bindtap="onNew"` 也跟着搬走了；
 *   而组件的 js 是**手写**的。两边的方法名没有任何东西保证一致。
 *
 *   于是出现了一整批「点了没反应」的按钮 —— 而且全是静默的：
 *     · fq-fab.wxml 绑 onNew     ，fq-fab.js 里叫 onCreate
 *     · fq-tabbar.wxml 绑 onTab  ，fq-tabbar.js 里叫 onPick
 *     · fq-sortdone.wxml 绑 onSortToggle，fq-sortdone.js 里叫 onToggle
 *     · fq-appbar.wxml 绑 onGotoMine，fq-appbar.js 里叫 onMine
 *     · 页面绑 bind:mine="onMine"，可页面里根本没有 onMine（有 onGotoMine）
 *
 *   arch-check 管的是「渲染结果」，它看不见接线；逻辑仿真只覆盖拖动/左滑，
 *   也不覆盖「按钮点了会不会有事」。这一整类失败当时**一条检查都没有**。
 *
 * 四条契约：
 *   A 组件自带：组件 WXML 里每个 bind/catch 的处理函数，必须在该组件 js 里有定义。
 *   B 页面自带：页面 WXML 里每个 bind/catch 的处理函数，必须在页面 js（或 drag.js）里有定义。
 *   C 出口闭合：组件 triggerEvent 的事件名，必须在页面上有对应的 bind: 监听；
 *              页面 bind: 的事件名，也必须真的有组件在发。两边任一悬空都是死绑定。
 *   D 取值形状：组件 triggerEvent 带了 detail 的，页面 handler 必须从 e.detail 取值。
 *              （组件把 dataset 原样塞进 detail，页面若还读 currentTarget.dataset，
 *                拿到的是 undefined —— 页面会静默跳到错误状态。）
 *
 * 用法（项目根目录）：
 *   node .workbuddy/tools/event-check.js
 * 退出码 0 = 全部满足；1 = 有悬空/错配。
 */

const path = require('path');
const F = require('./wxml-flatten.js');
const fs = F.fs;
const ROOT = F.ROOT;
const MP = F.MP;
const PAGE_DIR = path.join(MP, 'pages', 'index');

const problems = [];
function fail(rule, msg) {
  problems.push('[' + rule + '] ' + msg);
}

/* ---------------- 解析工具 ---------------- */

/* 匹配前必须先剥注释 —— 否则检查会被**自己的文档**骗过去。
   实测：onTab 的注释里写了一句「取值走 e.detail」，而 D 规则正是 grep
   /e\.detail/，于是「handler 明明还在读 currentTarget.dataset」也被判为通过。
   一条能被注释满足的检查，等于没有检查。
   剥法是朴素的两步：块注释整段换成空格，行注释删到行尾。
   字符串里出现双斜杠的极端情况本项目没有；真出现时要把它换成状态机。 */
function stripJsComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(function (l) {
      return l.replace(/\/\/.*$/, '');
    })
    .join('\n');
}

/** WXML 里所有 bind/catch 的处理函数名。bind:mine="x" 与 bindtap="x" 都要。 */
function bindHandlers(src) {
  const out = [];
  const re = /(?:bind|catch)[a-zA-Z:-]*\s*=\s*"([A-Za-z_$][\w$]*)"/g;
  let m;
  while ((m = re.exec(src))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
  return out;
}

/** 页面里 bind:xxx="h" 的组件事件名 → 处理函数名 */
function componentBinds(src) {
  const out = [];
  const re = /bind:([a-zA-Z][\w-]*)\s*=\s*"([A-Za-z_$][\w$]*)"/g;
  let m;
  while ((m = re.exec(src))) out.push({ event: m[1], handler: m[2] });
  return out;
}

/* 方法定义的写法有三种，必须都认：
     onTab(e) {            ← 方法简写（页面 / drag.js 用的就是它，2 空格缩进）
     onMine: function () { ← 属性写法
     onX: (a) => {         ← 箭头写法（组件 js 里 4 空格缩进）
   ⚠️ 曾经写成 `NAME\s*[:(]\s*(?:function\s*)?\(` —— 那个 `[:(]` 已经把 `(` 吃掉了，
   后面又要求一个 `(`，于是「方法简写」一种都匹配不到。症状是 B 规则刷出 60 条
   假警报，而**满是假警报的检查比没有检查更糟**：人会开始无视它。
   改法是把三种写法并列，各写各的括号。 */
const DEF = '[ \\t]{2,4}([A-Za-z_$][\\w$]*)\\s*(?:\\([^)]*\\)\\s*\\{|:\\s*(?:function\\s*)?\\([^)]*\\)\\s*\\{|:\\s*\\([^)]*\\)\\s*=>)';

/** js 里定义的方法名 */
function methodsOf(src) {
  const set = new Set();
  const re = new RegExp('^' + DEF, 'gm');
  let m;
  while ((m = re.exec(src))) set.add(m[1]);
  return set;
}

/** 组件 js 里所有 triggerEvent('x'[, payload]) */
function emitsOf(src) {
  const out = [];
  const re = /triggerEvent\(\s*'([^']+)'\s*(,?)/g;
  let m;
  while ((m = re.exec(src))) {
    // 有逗号 → 后面接的是 detail；找到这一对括号的收尾，看逗号后是否真有东西
    let hasPayload = false;
    if (m[2] === ',') {
      const rest = src.slice(re.lastIndex);
      const close = rest.indexOf(')');
      const tail = close >= 0 ? rest.slice(0, close) : rest;
      hasPayload = tail.trim().length > 0;
    }
    out.push({ event: m[1], hasPayload: hasPayload });
  }
  return out;
}

/** 某个方法体（从定义行到下一个同级方法定义）*/
function bodyOf(src, name) {
  const re = new RegExp('^[ \\t]{2,4}' + name + '\\s*(?:\\([^)]*\\)\\s*\\{|:\\s*(?:function\\s*)?\\([^)]*\\)\\s*\\{|:\\s*\\([^)]*\\)\\s*=>)', 'm');
  const m = re.exec(src);
  if (!m) return null;
  const rest = src.slice(m.index);
  const next = new RegExp('\\n' + DEF).exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}
/** 组件目录清单 */
function components() {
  const dir = path.join(MP, 'components');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(function (f) {
      return fs.statSync(path.join(dir, f)).isDirectory();
    })
    .sort()
    .map(function (name) {
      return {
        name: name,
        wxml: path.join(dir, name, name + '.wxml'),
        js: path.join(dir, name, name + '.js'),
      };
    })
    .filter(function (c) {
      return fs.existsSync(c.wxml) && fs.existsSync(c.js);
    });
}

/* ---------------- 跑 ---------------- */

const pageWxml = fs.readFileSync(path.join(PAGE_DIR, 'index.wxml'), 'utf8');
const pageJs = stripJsComments(
  fs.readFileSync(path.join(PAGE_DIR, 'index.js'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(MP, 'utils', 'drag.js'), 'utf8')
);
const pageMethods = methodsOf(pageJs);

const comps = components();
const emitted = new Map(); // event -> [component]
const emittedPayload = new Map();
const emittedShape = new Map(); // event -> { component: 'detail' | '空' }

comps.forEach(function (c) {
  const wxml = fs.readFileSync(c.wxml, 'utf8');
  const js = stripJsComments(fs.readFileSync(c.js, 'utf8'));
  const methods = methodsOf(js);

  /* A 组件自带 */
  bindHandlers(wxml).forEach(function (h) {
    if (!methods.has(h)) {
      fail('A 组件自带', c.name + '.wxml 绑了 ' + h + '，但 ' + c.name + '.js 里没有这个方法');
    }
  });

  /* 记下它发什么事件 */
  emitsOf(js).forEach(function (e) {
    if (!emitted.has(e.event)) emitted.set(e.event, []);
    if (emitted.get(e.event).indexOf(c.name) < 0) emitted.get(e.event).push(c.name);
    if (e.hasPayload) emittedPayload.set(e.event, true);
    // E 用：同名事件在每个组件里的形状
    if (!emittedShape.has(e.event)) emittedShape.set(e.event, {});
    emittedShape.get(e.event)[c.name] = e.hasPayload ? 'detail' : '空';
  });
});

/* B 页面自带 */
bindHandlers(pageWxml).forEach(function (h) {
  if (!pageMethods.has(h)) {
    fail('B 页面自带', 'index.wxml 绑了 ' + h + '，但 index.js / drag.js 里没有这个方法');
  }
});

/* C 出口闭合 */
const pageCompBinds = componentBinds(pageWxml);
pageCompBinds.forEach(function (b) {
  if (!emitted.has(b.event)) {
    fail('C 出口闭合', 'index.wxml 监听了 bind:' + b.event + '，但没有任何组件 triggerEvent(\'' + b.event + '\')');
  }
});
emitted.forEach(function (owners, event) {
  if (!pageCompBinds.some(function (b) { return b.event === event; })) {
    fail('C 出口闭合', owners.join('/') + ' 会 triggerEvent(\'' + event + '\')，但页面上没有 bind:' + event + ' 接住它 —— 按钮点了不会有任何反应');
  }
});

/* D 取值形状 */
const pageRef = stripJsComments(fs.readFileSync(path.join(PAGE_DIR, 'index.js'), 'utf8'));
pageCompBinds.forEach(function (b) {
  if (!emittedPayload.get(b.event)) return; // 没带 detail，不要求
  const body = bodyOf(pageRef, b.handler);
  if (!body) return; // B 已经报过了
  if (!/e\.detail/.test(body)) {
    fail(
      'D 取值形状',
      '组件发 bind:' + b.event + ' 时带了 detail，但页面 ' + b.handler +
        ' 只读 e.currentTarget.dataset —— 拿到的是 undefined'
    );
  }
});

/* E 同名同形
   两个组件发同名事件时，形状必须一致。否则「页面 handler 该不该读 e.detail」
   就没有唯一答案：规则 D 按「该事件名有人带 detail」就要求都读，
   可绑定到「不带 detail 那个组件」的 handler 会读到 undefined。
   宁可要求取个不同的名字，也不要让同名事件有两种形状。 */
emittedShape.forEach(function (shapes, event) {
  const vals = Object.keys(shapes);
  const kinds = vals.map(function (v) { return shapes[v]; });
  if (kinds.indexOf('detail') >= 0 && kinds.indexOf('空') >= 0) {
    fail(
      'E 同名同形',
      '事件名 ' + event + ' 有两个形状：' +
        vals.map(function (v) { return v + '=' + shapes[v]; }).join(' / ') +
        ' —— 请给其中一个换个事件名'
    );
  }
});

/* ---------------- 输出 ---------------- */

console.log('=== 事件接线契约 ===');
console.log('组件 ' + comps.length + ' 个 / 组件事件出口 ' + emitted.size + ' 个 / 页面 bind: ' + pageCompBinds.length + ' 处');
if (problems.length) {
  console.log('');
  problems.forEach(function (p) { console.log('  ✗ ' + p); });
  console.log('\n结果：' + problems.length + ' 项不满足');
  process.exit(1);
}
console.log('OK —— 组件自带 / 页面自带 / 出口闭合 / 取值形状 / 同名同形 五项全过');
