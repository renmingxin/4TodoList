#!/usr/bin/env node
/*
 * mp-check.js —— 微信小程序「无 IDE」静态自检
 *
 * 为什么需要它：改完 WXML / WXSS / JS 后，如果不打开微信开发者工具，
 * 很难发现「WXML 用了没定义的 class」「插值里引用了 data 里没有的变量」
 * 「标签没闭合」这类低级错误。这三个检查能在命令行里把这类问题一次扫出来。
 *
 * 用法（在项目根目录）：
 *   node .workbuddy/tools/mp-check.js miniprogram/pages/index/index.wxml miniprogram/pages/index/index.wxss miniprogram/pages/index/index.js
 *
 * 传入顺序无所谓，脚本按扩展名分派。
 */

const fs = require('fs');
const path = require('path');

function countAll(s, sub) {
  let n = 0;
  let i = 0;
  while ((i = s.indexOf(sub, i)) >= 0) {
    n++;
    i += sub.length;
  }
  return n;
}

function stripWxssComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

function stripWxmlComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '');
}

/** WXML 里所有 class 名（含插值中的字符串字面量） */
function classesInWxml(src) {
  const out = new Set();
  const re = /class="([^"]*)"/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[1].replace(/\{\{([^}]*)\}\}/g, function (_, expr) {
      const lits = [];
      const litRe = /'([^']*)'|"([^"]*)"/g;
      let x;
      while ((x = litRe.exec(expr))) lits.push(x[1] !== undefined ? x[1] : x[2]);
      return ' ' + lits.join(' ') + ' ';
    });
    raw.split(/\s+/).forEach(function (c) {
      if (c) out.add(c);
    });
  }
  return out;
}

/** WXSS 里所有 class 选择器 */
function classesInWxss(src) {
  const out = new Set();
  const clean = stripWxssComments(src);
  const ruleRe = /([^{}]+)\{/g;
  let m;
  while ((m = ruleRe.exec(clean))) {
    const clsRe = /\.(-?[_a-zA-Z][\w-]*)/g;
    let c;
    while ((c = clsRe.exec(m[1]))) out.add(c[1]);
  }
  return out;
}

/** JS 里 Page({ data: {...} }) 的第一层键 */
function dataKeysInJs(src) {
  const keys = new Set();
  const start = src.indexOf('data: {');
  if (start < 0) return keys;
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  stripWxssComments(src.slice(open + 1, end))
    .split('\n')
    .forEach(function (line) {
      const mm = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
      if (mm) keys.add(mm[1]);
    });
  return keys;
}

/** WXML 插值里的根标识符（排除 wx:for 局部变量） */
function rootsInWxml(src) {
  const locals = new Set(['item', 'index', 'true', 'false', 'null', 'undefined']);
  // 收集 wx:for-item="xxx" 声明的局部名
  const fi = /wx:for-item="([^"]+)"/g;
  let f;
  while ((f = fi.exec(src))) locals.add(f[1]);
  // 模板 data="{{k: v}}" 左侧的名字也算局部
  const ti = /<template[^>]*data="\{\{([^}]*)\}\}"/g;
  while ((f = ti.exec(src))) {
    f[1].split(',').forEach(function (pair) {
      const k = pair.split(':')[0].trim();
      if (k) locals.add(k);
    });
  }

  const out = new Map();
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = re.exec(src))) {
    const expr = m[1];
    const rootRe = /(^|[^\w.$'"])([A-Za-z_$][\w$]*)\s*(?=[.\s}\?!&|=<>)\]:,)]|$)/g;
    let r;
    while ((r = rootRe.exec(expr))) {
      const name = r[2];
      if (locals.has(name)) continue;
      if (!out.has(name)) out.set(name, expr.trim());
    }
  }
  return out;
}

/** 这些块必须留在 <scroll-view class="scroller"> 的**外面**。
 *  列表一长，它们若在滚动区里就会跟着滚走 —— 返回键、「调整顺序」按钮、
 *  筛选胶囊都会点不到。这类回归不会被任何语法检查发现（WXML 完全合法），
 *  只会表现为「滑到底部找不到返回键」，所以单独设一条契约。 */
const FIXED_HEAD_CLASSES = ['dhead', 'filters', 'sortrow'];

function checkFixedHead(files) {
  const wxmls = files.filter(function (f) {
    return /\.wxml$/.test(f);
  });
  if (!wxmls.length) return 0;
  let problems = 0;
  wxmls.forEach(function (f) {
    const src = stripWxmlComments(fs.readFileSync(f, 'utf8'));
    const open = src.indexOf('<scroll-view class="scroller"');
    if (open < 0) return; // 这个页面没有主滚动区，跳过
    const close = src.indexOf('</scroll-view>', open);
    const inside = src.slice(open, close < 0 ? src.length : close);
    const bad = FIXED_HEAD_CLASSES.filter(function (c) {
      return new RegExp('class="[^"]*\\b' + c + '\\b[^"]*"').test(inside);
    });
    console.log('【固定头部】滚动区内不得出现 ' + FIXED_HEAD_CLASSES.join(' / '));
    if (bad.length) {
      problems++;
      console.log('  ❌ 这些块被写进了滚动区：' + bad.join(', '));
      console.log('     → 移到 <scroll-view class="scroller"> 之前，并写 flex:0 0 auto');
    } else {
      console.log('  OK');
    }
  });
  return problems;
}

function checkPair(files) {
  let problems = 0;
  const wxmls = files.filter(function (f) {
    return /\.wxml$/.test(f);
  });
  const wxsss = files.filter(function (f) {
    return /\.wxss$/.test(f);
  });
  const jss = files.filter(function (f) {
    return /\.js$/.test(f);
  });

  // 1) class 契约
  if (wxmls.length && wxsss.length) {
    const used = new Set();
    wxmls.forEach(function (f) {
      classesInWxml(fs.readFileSync(f, 'utf8')).forEach(function (c) {
        used.add(c);
      });
    });
    const defined = new Set();
    wxsss.forEach(function (f) {
      classesInWxss(fs.readFileSync(f, 'utf8')).forEach(function (c) {
        defined.add(c);
      });
    });
    // 全局通用类（app.wxss 与状态类）：由调用方按需补充
    ['q1', 'q2', 'q3', 'q4', 'num', 'detail', 'overview', 'all', 'mine'].forEach(function (c) {
      defined.add(c);
    });
    const missing = [...used].filter(function (c) {
      return !defined.has(c);
    });
    console.log('【class 契约】WXML ' + used.size + ' 个 / WXSS ' + defined.size + ' 个');
    if (missing.length) {
      problems++;
      console.log('  ❌ WXML 用到但 WXSS 没有规则：' + missing.sort().join(', '));
      console.log('     （若为 view 状态字符串，如 detail / all / mine，属正常误报）');
    } else {
      console.log('  OK');
    }
  }

  // 2) data 契约
  if (wxmls.length && jss.length) {
    const keys = new Set();
    jss.forEach(function (f) {
      dataKeysInJs(fs.readFileSync(f, 'utf8')).forEach(function (k) {
        keys.add(k);
      });
    });
    if (keys.size) {
      const used = new Map();
      wxmls.forEach(function (f) {
        rootsInWxml(fs.readFileSync(f, 'utf8')).forEach(function (v, k) {
          if (!used.has(k)) used.set(k, v);
        });
      });
      // 状态字符串与常见误报白名单（插值里出现在 'xxx' 引号内的短词会被误抓）
      const whitelist = new Set(['mode', 'detail', 'overview', 'all', 'mine']);
      const missing = [...used.keys()].filter(function (k) {
        return !keys.has(k) && !whitelist.has(k);
      });
      console.log('【data 契约】Page.data ' + keys.size + ' 个键');
      if (missing.length) {
        problems++;
        missing.forEach(function (k) {
          console.log('  ❌ 未声明：' + k + '   ← ' + used.get(k));
        });
      } else {
        console.log('  OK');
      }
    }
  }

  // 3) 括号 / 标签配对
  files.forEach(function (f) {
    const src = fs.readFileSync(f, 'utf8');
    const isWxml = /\.wxml$/.test(f);
    const clean = isWxml ? stripWxmlComments(src) : stripWxssComments(src);
    const ob = countAll(clean, '{');
    const cb = countAll(clean, '}');
    const op = countAll(clean, '(');
    const cp = countAll(clean, ')');
    let ok = ob === cb && op === cp;
    let extra = '';
    if (isWxml) {
      const mo = countAll(clean, '{{');
      const mc = countAll(clean, '}}');
      if (mo !== mc) ok = false;
      const opens = {};
      const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
      let m;
      while ((m = tagRe.exec(clean))) {
        if (m[4]) continue;
        opens[m[2]] = (opens[m[2]] || 0) + (m[1] ? -1 : 1);
      }
      const badTags = Object.keys(opens).filter(function (k) {
        return opens[k] !== 0;
      });
      if (badTags.length) ok = false;
      extra = '  {{/}} ' + mo + '/' + mc + (badTags.length ? '  标签未闭合: ' + badTags.join(',') : '');
    }
    console.log('【结构配对】' + path.basename(f) + ': { } ' + ob + '/' + cb + '  ( ) ' + op + '/' + cp + extra + (ok ? '  OK' : '  ❌'));
    if (!ok) problems++;
  });

  // 4) 固定头部契约
  problems += checkFixedHead(files);

  console.log(problems ? '\n结果：发现 ' + problems + ' 处需要人工确认' : '\n结果：全部通过');
  process.exit(problems ? 1 : 0);
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法：node mp-check.js <file...>（.wxml / .wxss / .js 混传即可）');
  process.exit(2);
}
checkPair(files);
