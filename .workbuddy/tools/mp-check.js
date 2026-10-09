#!/usr/bin/env node
/*
 * mp-check.js —— 微信小程序「无 IDE」静态自检
 *
 * 为什么需要它：改完 WXML / WXSS / JS 后，如果不打开微信开发者工具，
 * 很难发现「WXML 用了没定义的 class」「插值里引用了 data 里没有的变量」
 * 「标签没闭合」这类低级错误。这几个检查能在命令行里把这类问题一次扫出来。
 *
 * 用法（在项目根目录）：
 *   node .workbuddy/tools/mp-check.js <file|dir ...>
 *
 *   传文件按扩展名分派；传目录会递归展开成其中的 .wxml / .wxss / .js。
 *   混着传也行。
 *
 * ── 作用域（组件化之后新增，2026-10-02）────────────────────────────
 * 【class 契约】与【固定头部】是**全局**的：组件用的是 apply-shared，
 *     页面的样式本来就进得去组件，所以「谁定义了这个 class」不需要分清，
 *     全部 wxss 合起来看即可。
 *
 * 【data 契约】必须是**分作用域**的：组件看不见页面的 data，页面也看不见
 *     组件的 properties。原来把所有 js 的 data 键和所有 wxml 的根标识符
 *     混在一起比，拆出组件后会把每个 property 都报成「未声明」——
 *     一个全是假警报的检查等于没有检查，所以改成按目录配对：
 *        某个目录下的 <name>.wxml 的根标识符
 *          ⊆ 同目录 <name>.js 的 data 键（页面）或 properties + data 键（组件）
 *     页面恰好也符合这条规则，于是两者可以共用一套逻辑。
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * 参数：文件与目录
 * ------------------------------------------------------------------ */

const SRC_EXT = ['.wxml', '.wxss', '.js'];

function expand(args) {
  const out = [];
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
          } else if (SRC_EXT.indexOf(path.extname(f)) >= 0) {
            out.push(q);
          }
        });
      })(a);
    } else {
      out.push(a);
    }
  });
  return out;
}

const files = expand(process.argv.slice(2));
if (!files.length) {
  console.error('用法：node mp-check.js <file|dir ...>（.wxml / .wxss / .js 混传即可）');
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * 词法提取
 * ------------------------------------------------------------------ */

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

/** 取 src 里 `key: {` 起的那一对花括号之间的内容（含嵌套） */
function objectBodyAfter(src, key) {
  const at = src.search(new RegExp('(^|[\\s{,])' + key + '\\s*:\\s*\\{'));
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** 对象字面量的第一层键。单行写法按逗号切，多行写法按行切。 */
function topLevelKeys(body) {
  const keys = new Set();
  if (!body) return keys;
  if (body.indexOf('\n') < 0) {
    body.split(',').forEach(function (seg) {
      const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(seg);
      if (m) keys.add(m[1]);
    });
    return keys;
  }
  body.split('\n').forEach(function (line) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
    if (m) keys.add(m[1]);
  });
  return keys;
}

/** WXML 里所有 class 名（含插值中的字符串字面量） */
function classesInWxml(src) {
  // ⚠️ 先剥注释，理由同 rootsInWxml：注释里引一句 class="foo"，这里就会凭空多出
  //    一个「WXML 用到但没有任何 WXSS 规则」的假警报；反过来，一条本该报出来的
  //    问题也可能被注释里的写法「满足」掉。
  src = stripWxmlComments(src);
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

/** 一个 js 文件对外可见的「模板可引用的键」：data（+ 组件的 properties） */
function templateKeysInJs(src) {
  const keys = topLevelKeys(objectBodyAfter(src, 'data'));
  topLevelKeys(objectBodyAfter(src, 'properties')).forEach(function (k) {
    keys.add(k);
  });
  return keys;
}

/** WXML 插值里的根标识符（排除 wx:for 局部变量） */
function rootsInWxml(src) {
  // ⚠️ 先剥注释。注释里写一句 bottom 的插值，下面就会把它当成真引用报「取不到」——
  //    2026-10-09 真踩了一次：fq-fab 的说明注释引了已删掉的 bottom 属性，
  //    检查器于是报了一个根本不存在的错。反向的病更大：**一条能被注释满足的检查，
  //    等于没有检查**。两头病根同一个 —— 拿没剥注释的源码做匹配。
  src = stripWxmlComments(src);
  const locals = new Set(['item', 'index', 'true', 'false', 'null', 'undefined']);
  const fi = /wx:for-item="([^"]+)"/g;
  let f;
  while ((f = fi.exec(src))) locals.add(f[1]);
  const ti = /<template[^>]*data="\{\{([^}]*)\}\}"/g;
  while ((f = ti.exec(src))) {
    f[1].split(',').forEach(function (pair) {
      const k = pair.split(':')[0].trim();
      if (k) locals.add(k);
      // 值那边的根标识符仍要校验，但 <template> 的 data 左边是局部名
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

/* ------------------------------------------------------------------ *
 * 契约定义
 * ------------------------------------------------------------------ */

/** 这些块必须留在 <scroll-view class="scroller"> 的**外面**。
 *  列表一长，它们若在滚动区里就会跟着滚走 —— 返回键、「调整顺序」按钮、
 *  筛选胶囊都会点不到。这类回归不会被任何语法检查发现（WXML 完全合法），
 *  只会表现为「滑到底部找不到返回键」，所以单独设一条契约。 */
const FIXED_HEAD_CLASSES = ['dhead', 'filters', 'sortrow'];

/** 插值里出现在引号内的状态字符串会被误抓，这里放行。
 *  ⚠️ 新增视图（如 sched）必须**两处都加**：它是 `view` 的状态值，
 *  与 detail / all / mine 同类，页面不会为它写 `.sched{}` 规则。 */
const ROOT_WHITELIST = new Set(['mode', 'detail', 'overview', 'all', 'mine', 'sched']);

/** 由 app.wxss / 内联 style / 状态类提供，不要求本文件有规则 */
const CLASS_WHITELIST = ['q1', 'q2', 'q3', 'q4', 'num', 'detail', 'overview', 'all', 'mine', 'sched'];

/* ------------------------------------------------------------------ */

const wxmls = files.filter(function (f) {
  return /\.wxml$/.test(f);
});
const wxsss = files.filter(function (f) {
  return /\.wxss$/.test(f);
});
const jss = files.filter(function (f) {
  return /\.js$/.test(f);
});

let problems = 0;
const rel = function (f) {
  return path.relative(process.cwd(), f);
};

/* 1) class 契约（全局） */
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
  CLASS_WHITELIST.forEach(function (c) {
    defined.add(c);
  });
  const missing = [...used].filter(function (c) {
    return !defined.has(c);
  });
  console.log('【class 契约】WXML ' + used.size + ' 个 / WXSS ' + defined.size + ' 个');
  if (missing.length) {
    problems++;
    console.log('  ❌ WXML 用到但没有任何 WXSS 规则：' + missing.sort().join(', '));
    console.log('     （若为 view 状态字符串，如 detail / all / mine，属正常误报）');
  } else {
    console.log('  OK');
  }
}

/* 2) data 契约（按目录分作用域） */
if (wxmls.length && jss.length) {
  // 按目录配对：一个目录里同名（或同目录唯一）的 wxml 与 js 属于同一作用域
  const scopes = [];
  const dirs = {};
  wxmls.forEach(function (f) {
    const d = path.dirname(f);
    (dirs[d] = dirs[d] || {}).wxml = f;
  });
  jss.forEach(function (f) {
    const d = path.dirname(f);
    if (!dirs[d]) dirs[d] = {};
    // 只认与 wxml 同名的 js；否则取该目录下第一个 js
    if (!dirs[d].js) dirs[d].js = f;
    if (path.basename(f, '.js') === path.basename(dirs[d].wxml || '', '.wxml')) dirs[d].js = f;
  });
  Object.keys(dirs).forEach(function (d) {
    if (dirs[d].wxml && dirs[d].js) scopes.push({ dir: d, wxml: dirs[d].wxml, js: dirs[d].js });
  });

  let totalKeys = 0;
  let bad = 0;
  scopes.forEach(function (s) {
    const keys = templateKeysInJs(fs.readFileSync(s.js, 'utf8'));
    totalKeys += keys.size;
    const used = rootsInWxml(fs.readFileSync(s.wxml, 'utf8'));
    const missing = [...used.keys()].filter(function (k) {
      return !keys.has(k) && !ROOT_WHITELIST.has(k);
    });
    if (missing.length) {
      bad++;
      console.log('  ❌ ' + rel(s.dir) + ' → ' + missing.map(function (k) {
        return k + '（' + used.get(k) + '）';
      }).join('，'));
    }
  });
  console.log('【data 契约】' + scopes.length + ' 个作用域 / 合计 ' + totalKeys + ' 个键');
  if (bad) {
    problems++;
    console.log('  ❌ 有 ' + bad + ' 个作用域的模板引用了自身取不到的变量（上面逐条列出）');
  } else {
    console.log('  OK');
  }
}

/* 3) 括号 / 标签配对 */
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
  console.log('【结构配对】' + rel(f) + ': { } ' + ob + '/' + cb + '  ( ) ' + op + '/' + cp + extra + (ok ? '  OK' : '  ❌'));
  if (!ok) problems++;
});

/* 4) 固定头部契约 */
wxmls.forEach(function (f) {
  const src = stripWxmlComments(fs.readFileSync(f, 'utf8'));
  const open = src.indexOf('<scroll-view class="scroller"');
  if (open < 0) return; // 这个文件没有主滚动区，跳过
  const close = src.indexOf('</scroll-view>', open);
  const inside = src.slice(open, close < 0 ? src.length : close);
  const bad = FIXED_HEAD_CLASSES.filter(function (c) {
    return new RegExp('class="[^"]*\\b' + c + '\\b[^"]*"').test(inside);
  });
  console.log('【固定头部】' + rel(f) + ' 滚动区内不得出现 ' + FIXED_HEAD_CLASSES.join(' / '));
  if (bad.length) {
    problems++;
    console.log('  ❌ 这些块被写进了滚动区：' + bad.join(', '));
    console.log('     → 移到 <scroll-view class="scroller"> 之前，并写 flex:0 0 auto');
  } else {
    console.log('  OK');
  }
});

console.log(problems ? '\n结果：发现 ' + problems + ' 处需要人工确认' : '\n结果：全部通过');
process.exit(problems ? 1 : 0);
