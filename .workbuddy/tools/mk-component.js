#!/usr/bin/env node
/*
 * mk-component.js —— 按清单把页面上的一段「搬」成自定义组件
 *
 * 为什么要有它：
 *   抽出 13 个组件的动作是高度同构的 —— 切一段 WXML、切几段 WXSS、
 *   写 json/js、把页面上的调用点换成一个标签、登记 usingComponents。
 *   手工做 13 遍，出错的方式还都不是语法错误，而是「少切了两行样式」
 *   这种静默问题（症状是某个按钮突然没颜色）。
 *
 *   所以机械部分交给它；需要判断的部分（标签怎么写、发什么事件、
 *   组件内部有哪些 handler）由清单里手写 —— 机器只做搬运，不做设计。
 *
 * 用法（项目根目录）：
 *   node .workbuddy/tools/mk-component.js <清单.json>
 *   然后立刻 node .workbuddy/tools/check-all.js
 *
 * 清单里每个组件可用的字段：
 *   name          组件名（目录名、文件名都用它）
 *   title         中文用途，写进生成文件的头注释
 *   wxml[]        { from, to, replaceWith, expectFirst, expectLast,
 *                   replaceOnly, bodyEdits:[[找, 换]] }
 *   wxss[]        { from, to, expectFirst, expectLast }
 *   hoist[]       同上，但目标是 app.wxss（多处共用的共享资产）
 *   hoistBanner   上提那一块的说明注释
 *   js            手写的 methods 片段
 *   jsNote        写在组件 js 头部的补充说明
 *
 *   from/to 是**清单所依据的那一份原文的 1-based 行号（闭区间）**。
 *   同一组件有多段时，不带 replaceOnly 的那一段进组件，其余段只把页面上的
 *   位置换成标签。bodyEdits 记录「进组件时改了什么」—— 比如去掉挂在根上的
 *   wx:if（它现在挂在组件标签上），既是改动记录也是说明书。
 *
 * ⚠️ 所有区间都是「同一份原文上的坐标」，所以必须**先收集、再统一从后往前切**。
 *    曾经写成「逐个组件切割」：第一个组件的切割改了行号，第二个组件按原始行号
 *    去切就切到了别处（好在锚点断言拦住了）。同一份坐标只能在同一遍里消费。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MP = path.join(ROOT, 'miniprogram');
const PAGE_DIR = path.join(MP, 'pages', 'index');
const COMP_DIR = path.join(MP, 'components');

const specPath = process.argv[2];
if (!specPath) {
  console.error('用法：node mk-component.js <清单.json>');
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

let wxml = fs.readFileSync(path.join(PAGE_DIR, 'index.wxml'), 'utf8').split('\n');
let wxss = fs.readFileSync(path.join(PAGE_DIR, 'index.wxss'), 'utf8').split('\n');
let appwxss = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8').split('\n');
const pageJson = JSON.parse(fs.readFileSync(path.join(PAGE_DIR, 'index.json'), 'utf8'));

function slice(lines, from, to) {
  if (from < 1 || to > lines.length || to < from) {
    throw new Error('区间越界：' + from + '..' + to + '（文件共 ' + lines.length + ' 行）');
  }
  return lines.slice(from - 1, to).join('\n');
}
function assertRange(lines, r, label) {
  if (r.expectFirst && !lines[r.from - 1].includes(r.expectFirst)) {
    throw new Error(label + ' 首行不含「' + r.expectFirst + '」→ ' + JSON.stringify(lines[r.from - 1]));
  }
  if (r.expectLast && !lines[r.to - 1].includes(r.expectLast)) {
    throw new Error(label + ' 尾行不含「' + r.expectLast + '」→ ' + JSON.stringify(lines[r.to - 1]));
  }
}
/** WXML 插值里的根标识符 → 组件属性（排除 wx:for 局部名） */
function rootsOf(src) {
  const locals = new Set(['item', 'index', 'true', 'false', 'null', 'undefined']);
  let m;
  const fi = /wx:for-item="([^"]+)"/g;
  while ((m = fi.exec(src))) locals.add(m[1]);
  const out = new Set();
  const re = /\{\{([\s\S]*?)\}\}/g;
  while ((m = re.exec(src))) {
    const rootRe = /(^|[^\w.$'"])([A-Za-z_$][\w$]*)\s*(?=[.\s}\?!&|=<>)\]:,)]|$)/g;
    let r;
    while ((r = rootRe.exec(m[1]))) {
      if (!locals.has(r[2])) out.add(r[2]);
    }
  }
  return [...out].sort();
}

/* ============================================================
   一遍切完：先把所有组件的区间收齐，再统一从后往前切
   ============================================================ */

const bodies = {};
const styleParts = {};
const hoistParts = [];
const push = function (map, name, v) {
  (map[name] = map[name] || []).push(v);
};

/* 1) WXML */
const wxmlCuts = [];
spec.components.forEach(function (c) {
  (c.wxml || []).forEach(function (r) {
    wxmlCuts.push({ c: c, r: r });
  });
});
wxmlCuts
  .sort(function (a, b) {
    return b.r.from - a.r.from;
  })
  .forEach(function (x) {
    assertRange(wxml, x.r, x.c.name + ' WXML');
    if (!x.r.replaceOnly) {
      let piece = slice(wxml, x.r.from, x.r.to);
      (x.r.bodyEdits || []).forEach(function (e) {
        if (piece.indexOf(e[0]) < 0) {
          throw new Error(x.c.name + ' bodyEdits 没找到原文：' + JSON.stringify(e[0]));
        }
        piece = piece.split(e[0]).join(e[1]);
      });
      push(bodies, x.c.name, { from: x.r.from, text: piece });
    }
    wxml = wxml.slice(0, x.r.from - 1).concat(x.r.replaceWith.split('\n'), wxml.slice(x.r.to));
  });

/* 2) WXSS：组件样式与「上提 app.wxss」一起切 */
const wxssCuts = [];
spec.components.forEach(function (c) {
  (c.wxss || []).forEach(function (r) {
    wxssCuts.push({ c: c, r: r, hoist: false });
  });
  (c.hoist || []).forEach(function (r) {
    wxssCuts.push({ c: c, r: r, hoist: true });
  });
});
wxssCuts
  .sort(function (a, b) {
    return b.r.from - a.r.from;
  })
  .forEach(function (x) {
    assertRange(wxss, x.r, x.c.name + (x.hoist ? ' hoist' : ' WXSS'));
    const text = slice(wxss, x.r.from, x.r.to);
    if (x.hoist) hoistParts.push({ name: x.c.name, banner: x.c.hoistBanner, text: text });
    else push(styleParts, x.c.name, text);
    wxss = wxss.slice(0, x.r.from - 1).concat(wxss.slice(x.r.to));
  });

/* ============================================================
   写组件文件
   ============================================================ */

const report = [];
spec.components.forEach(function (c) {
  const dir = path.join(COMP_DIR, c.name);
  fs.mkdirSync(dir, { recursive: true });

  const parts = (bodies[c.name] || []).sort(function (a, b) {
    return a.from - b.from;
  });
  if (!parts.length) throw new Error(c.name + ' 没有指定「进组件」的 WXML 区间');
  const body = parts
    .map(function (p) {
      return p.text;
    })
    .join('\n\n');
  const styles = (styleParts[c.name] || []).join('\n');
  const props = rootsOf(body);

  fs.writeFileSync(
    path.join(dir, c.name + '.wxml'),
    '<!-- components/' + c.name + '/' + c.name + '.wxml\n' +
      '     ' + (c.title || '') + '\n' +
      '     从 pages/index/index.wxml 整段搬来。结构一字未改 —— 只有挂在根上的\n' +
      '     wx:if 挪到了组件标签上（「该不该出现」是页面的事，不是组件的事）。 -->\n' +
      body +
      '\n'
  );

  fs.writeFileSync(
    path.join(dir, c.name + '.wxss'),
    '/* components/' + c.name + '/' + c.name + '.wxss\n' +
      '   ' + (c.title || '') + '\n' +
      '   规则原在 pages/index/index.wxss 里，整段搬来、一字未改。\n' +
      '   共享资产（自绘图标 .ico-* / 象限图标 .qmark / 按钮 .btn*）留在 app.wxss，\n' +
      '   靠 styleIsolation: apply-shared 生效 —— 所以这里只有本组件自己的骨架。\n' +
      (c.wxssNote ? '   ' + c.wxssNote + '\n' : '') +
      '   ' + '='.repeat(62) + ' */\n\n' +
      styles +
      '\n'
  );

  fs.writeFileSync(
    path.join(dir, c.name + '.js'),
    '// components/' + c.name + '/' + c.name + '.js\n' +
      '// ' + (c.title || '') + '\n' +
      '//\n' +
      (c.jsNote
        ? c.jsNote
            .split('\n')
            .map(function (l) {
              return '// ' + l;
            })
            .join('\n') + '\n//\n'
        : '') +
      '// 组件化三条硬约定（见 README「组件分层」）：\n' +
      '//   1. virtualHost: true —— 组件不产生额外节点。\n' +
      '//      这条是必须的：.screen 是纵向 flex，各固定块靠「不伸不缩」占住自己的高度，\n' +
      '//      组件一旦变成真实的 flex item，原先的布局就全靠运气了。\n' +
      '//   2. styleIsolation: apply-shared —— app.wxss 的共享资产能进组件，\n' +
      '//      同时组件自己的 wxss 不会反向污染页面。\n' +
      '//   3. 数据只走 properties、交互只走 triggerEvent。\n' +
      '//      组件不碰 wx.cloud、不读写页面实例 —— 那样它才能被单独看懂。\n' +
      '\n' +
      'Component({\n' +
      '  options: {\n' +
      '    virtualHost: true,\n' +
      "    styleIsolation: 'apply-shared',\n" +
      '  },\n' +
      '\n' +
      '  properties: {\n' +
      (props.length
        ? props
            .map(function (p) {
              return '    // 页面上对应 data.' + p + '\n    ' + p + ': { type: null },';
            })
            .join('\n')
        : '    // 本组件不接收数据，内容全是静态的。') +
      '\n' +
      '  },\n' +
      '\n' +
      '  methods: {\n' +
      (c.js || '    // 本组件没有交互。') +
      '\n' +
      '  },\n' +
      '});\n'
  );

  fs.writeFileSync(
    path.join(dir, c.name + '.json'),
    JSON.stringify({ component: true, usingComponents: {} }, null, 2) + '\n'
  );

  pageJson.usingComponents[c.name] = '/components/' + c.name + '/' + c.name;
  report.push({ name: c.name, props: props, rules: (styleParts[c.name] || []).length });
});

/* 3) 上提的共享资产 */
hoistParts.forEach(function (h) {
  appwxss = appwxss.concat([''], h.banner.split('\n'), [''], h.text.split('\n'), ['']);
});

/* 4) 落盘 */
fs.writeFileSync(path.join(PAGE_DIR, 'index.wxml'), wxml.join('\n'));
fs.writeFileSync(path.join(PAGE_DIR, 'index.wxss'), wxss.join('\n'));
fs.writeFileSync(path.join(MP, 'app.wxss'), appwxss.join('\n'));
fs.writeFileSync(path.join(PAGE_DIR, 'index.json'), JSON.stringify(pageJson, null, 2) + '\n');

console.log('已生成组件：');
report.forEach(function (r) {
  console.log(
    '  ' +
      r.name.padEnd(14) +
      '属性 ' + String(r.props.length).padStart(2) + ' [' + r.props.join(', ') + ']' +
      '  样式段 ' + r.rules
  );
});
if (hoistParts.length) {
  console.log('上提到 app.wxss：' + hoistParts.map(function (h) { return h.name; }).join(', '));
}
console.log(
  '\n页面：WXML ' + wxml.length + ' 行 / WXSS ' + wxss.length + ' 行 / usingComponents ' +
    Object.keys(pageJson.usingComponents).length + ' 个'
);
