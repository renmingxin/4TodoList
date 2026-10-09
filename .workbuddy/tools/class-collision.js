#!/usr/bin/env node
/*
 * class-collision.js —— 找出「图标子树里用了页面级 class 名」的隐性冲突
 *
 * 为什么需要它：
 *   小程序的 WXSS 是全局作用域的（app.wxss 对所有页面生效，页面 wxss 对本页生效）。
 *   图标内部的子元素如果起了个和页面级容器同名的 class —— 经典写法是
 *     <view class="ico ico-trash"><view class="lid"></view><view class="body"></view></view>
 *   —— 那个 .body 会静默命中页面级的 .body{padding:24rpx 32rpx 0}（滚动内容的
 *   内边距容器）。绝对定位的桶身原定 left:5rpx;right:5rpx → 宽 22rpx，
 *   但左右 padding 相加 64rpx 远大于它，盒子被撑到约 70rpx 并向右溢出。
 *   实测：桶身中心比按钮中心偏右约 21rpx，而同一图标里的 .lid（无同名冲突）
 *   渲染完全正确 —— 表现为「删除图标不居中」这种看着像定位写错的 bug。
 *
 * 判据（单信号，刻意收窄，目标是零误报）：
 *   报出同时满足两条的 class 名：
 *     A. WXSS 里存在页面级规则（选择器整串就是 .name，可逗号分组、无组合器；
 *        页面 wxss 与 app.wxss 都算，因为它们都全局生效）
 *     B. WXML 里这个 class **出现在某个 ico-* 元素的子树里**
 *   为什么加 B：A 单独用会误报一片 —— `.btn .ico-plus`、`.row.done .row-in` 这类
 *   「元素自身 + 修饰上下文」是正常写法，页面级规则本来就是给这个元素的。
 *   只有当名字被用在一个「本不该认识页面语义」的地方（图标内部零件）时才真出事。
 *   实测对比：`.body`（A 有、B 有）→ 报；`.ico-plus`（A 有、B 无）→ 不报 ✓
 *
 * 用法（项目根目录）：
 *   node .workbuddy/tools/class-collision.js \
 *     miniprogram/pages/index \
 *     miniprogram/components \
 *     miniprogram/app.wxss
 *
 *   参数可以传目录（递归取其中的 .wxml / .wxss），也可以传单个文件。
 *   组件化之后图标散落在多个组件里，传目录才不容易漏。
 *
 * 退出码非 0 表示发现冲突。
 */

const fs = require('fs');

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 页面级规则里的 class 名 → [file:line] */
function pageLevelNames(src, file, into) {
  const clean = stripComments(src);
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(clean))) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel || sel.charAt(0) === '@') continue;
    const parts = sel.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) continue;
    if (!parts.every(function (p) { return /^\.[-_a-zA-Z][\w-]*$/.test(p); })) continue;
    const line = clean.slice(0, m.index).split('\n').length;
    parts.forEach(function (p) {
      const n = p.slice(1);
      if (!into.has(n)) into.set(n, []);
      into.get(n).push(file + ':' + line);
    });
  }
}

/**
 * 扫 WXML，找出「位于 ico-* 子树内」的 class 名 → [file:line 父级]
 * 用简单的标签栈解析，够用（本项目 WXML 结构规整，没有自闭合的复杂情况）。
 */
function iconSubtreeClasses(src, file, into) {
  const clean = src.replace(/<!--[\s\S]*?-->/g, '');
  const lineOf = (idx) => clean.slice(0, idx).split('\n').length;
  const stack = [];       // [{ ico:bool, classes:string }]
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(clean))) {
    const closing = m[1] === '/';
    const selfClose = m[4] === '/';
    const attrs = m[3] || '';
    const cm = /class="([^"]*)"/.exec(attrs);
    const classes = cm ? cm[1] : '';

    if (closing) {
      stack.pop();
      continue;
    }

    const parent = stack[stack.length - 1];
    const inIcon = (parent && parent.ico) || /(^|\s)ico-/.test(classes);

    if (parent && parent.ico && classes) {
      const line = lineOf(m.index);
      classes.replace(/\{\{[^}]*\}\}/g, ' ').split(/\s+/).forEach(function (c) {
        if (!c) return;
        if (!into.has(c)) into.set(c, []);
        into.get(c).push(file + ':' + line + '  (父级 ' + parent.classes.trim() + ')');
      });
    }

    if (!selfClose) stack.push({ ico: inIcon, classes: classes });
  }
}

// 参数可以是文件，也可以是目录（递归取 .wxml / .wxss）。
// 组件化之后图标散落在多个组件里，逐个列路径既啰嗦又容易漏，所以支持目录。
const path = require('path');
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('用法：node class-collision.js <file|dir ...>（.wxml / .wxss）');
  process.exit(2);
}
const files = [];
args.forEach(function (a) {
  if (!fs.existsSync(a)) {
    console.error('路径不存在：' + a);
    process.exit(2);
  }
  if (fs.statSync(a).isDirectory()) {
    (function walk(d) {
      fs.readdirSync(d).sort().forEach(function (f) {
        const q = path.join(d, f);
        if (fs.statSync(q).isDirectory()) {
          if (f === 'node_modules' || f === '.git') return;
          walk(q);
        } else if (/\.(wxml|wxss)$/.test(f)) {
          files.push(q);
        }
      });
    })(a);
  } else {
    files.push(a);
  }
});

const wxmls = files.filter(function (f) { return /\.wxml$/.test(f); });
const wxsss = files.filter(function (f) { return /\.wxss$/.test(f); });
if (!wxmls.length || !wxsss.length) {
  console.error('需要至少一个 .wxml 和一个 .wxss');
  process.exit(2);
}

const page = new Map();
wxsss.forEach(function (f) { pageLevelNames(fs.readFileSync(f, 'utf8'), f, page); });

const inIcon = new Map();
wxmls.forEach(function (f) { iconSubtreeClasses(fs.readFileSync(f, 'utf8'), f, inIcon); });

const hits = [];
inIcon.forEach(function (where, name) {
  if (!page.has(name)) return;
  hits.push({ name: name, where: where, page: page.get(name) });
});
hits.sort(function (a, b) { return a.name.localeCompare(b.name); });

console.log(
  '扫描：页面级选择器 ' + page.size + ' 个 / 图标子树里的 class ' + inIcon.size + ' 个'
);

if (!hits.length) {
  console.log('OK —— 图标内部没有和页面级 class 重名的元素');
  process.exit(0);
}

console.log('\n发现 ' + hits.length + ' 处冲突（图标内部元素会吃到页面级规则）：');
hits.forEach(function (h) {
  console.log('\n  ⚠️  .' + h.name);
  console.log('      图标内使用：' + h.where.join('\n                  '));
  console.log('      页面级规则：' + h.page.join(', '));
});
console.log('\n处理：给图标内部换个不会重名的名字 —— 建议直接删掉内层 <view>，改用 ::before / ::after。');
process.exit(1);
