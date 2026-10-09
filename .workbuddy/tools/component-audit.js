// 组件解析审计 + WXML 结构配平
//
//   node .workbuddy/tools/component-audit.js
//
// 查的是「标签能不能被解析到」这一层。它不在其它任何检查的覆盖范围内：
//
//   arch-check   管「渲染出来的 class 序列与样式与基线一致」——它靠展平组件来比对，
//                展不平的时候它只会说「路径不存在」，管不了「标签压根没注册」。
//   event-check  管「事件接线」，前提是标签已经能渲染。
//   逻辑仿真     管拖动 / 左滑 / 云函数，完全不碰 WXML 的标签层。
//
// ⚠️ 为什么单独补这一层（2026-10-02 的教训）：
//    主界面矩阵区整块空白，而 arch-check 绿、event-check 绿、274/214/107 全绿 ——
//    因为组件化是把 WXML **逐字搬走**：标签写错、json 漏注册、切片把标签切坏，
//    这三种错都不会让任何一条既有断言变红，页面只是安静地少了一块。
//    （那次最后定位到开发者工具的增量编译没更新组件注册表，属于构建态问题；
//      但「磁盘上这四种不变量」本来也没人看着，这里先把它补上。）
//
// 本文件断言的四种不变量：
//   A 每个 usingComponents 条目：四个文件都在、目标 .json 有 component:true、
//     目标 .js 里有 Component({、目标 .wxml 去注释后非空。
//   B 每个 .wxml 里用到的自定义标签（带连字符且非原生标签）都在该目录的
//     usingComponents 里注册过 —— 少一条就是一块静默空白。
//   C 每个 .wxml 的标签配平（含自闭合）。切片把标签切坏时，微信会把整块吞掉。
//   D 组件目录名与文件名同名（微信要求 <name>/<name>.{wxml,wxss,js,json}）。
//
// 无参数：范围固定为「页面 + components 目录下的所有组件」。刻意不开放参数 ——
// 少一个参数就少一种「忘了传所以没查」的可能。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MP = path.join(ROOT, 'miniprogram');
const PAGE_DIR = path.join(MP, 'pages', 'index');
const COMP_DIR = path.join(MP, 'components');

// 原生标签里带连字符的那些，不算自定义组件
const NATIVE = new Set([
  'scroll-view', 'cover-view', 'cover-image', 'movable-view', 'movable-area',
  'swiper-item', 'picker-view', 'picker-view-column', 'rich-text', 'web-view',
  'open-data', 'functional-page-navigator', 'official-account', 'navigation-bar',
  'page-meta', 'match-media', 'keyboard-accessory', 'voip-room', 'page-container',
  'share-element', 'root-portal', 'ad-custom', 'inline-payment-panel',
  'channel-live', 'channel-video', 'store-home', 'store-product', 'grid-view',
  'list-view', 'sticky-section', 'sticky-header', 'snapshot',
]);

let bad = 0;
function fail(msg) {
  bad++;
  console.log('  ✗ ' + msg);
}
function ok(msg) {
  console.log('  ✓ ' + msg);
}

const stripComments = function (s) {
  return s.replace(/<!--[\s\S]*?-->/g, '');
};

/** 文件里用到的自定义标签（带连字符、非原生） */
function customTags(src) {
  const out = new Set();
  const re = /<([a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(stripComments(src)))) {
    const t = m[1];
    if (t.indexOf('-') < 0) continue;
    if (NATIVE.has(t)) continue;
    if (/^(wx|mpx)-/.test(t)) continue;
    out.add(t);
  }
  return out;
}

/** C 标签配平。返回错误描述数组 */
function balance(src) {
  const s = stripComments(src);
  const errs = [];
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = re.exec(s))) {
    const line = s.slice(0, m.index).split('\n').length;
    const tag = m[2];
    if (m[1] === '/') {
      if (!stack.length) errs.push('L' + line + ' 多余的 </' + tag + '>');
      else {
        const top = stack.pop();
        if (top.tag !== tag) {
          errs.push('L' + line + ' </' + tag + '> 与 L' + top.line + ' 的 <' + top.tag + '> 不配对');
        }
      }
    } else if (m[4] !== '/') {
      stack.push({ tag: tag, line: line });
    }
  }
  stack.forEach(function (t) {
    errs.push('L' + t.line + ' <' + t.tag + '> 未闭合');
  });
  return errs;
}

/** A + B + D：审计一个宿主（页面或组件）。host 是不带扩展名的路径 */
function audit(host, label) {
  const jsonPath = host + '.json';
  const wxmlPath = host + '.wxml';

  if (!fs.existsSync(jsonPath)) return fail(label + ' 没有 .json');
  if (!fs.existsSync(wxmlPath)) return fail(label + ' 没有 .wxml');

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    return fail(label + '.json 解析失败：' + e.message);
  }

  // 组件自己必须声明 component:true（页面不能声明）
  const isComponent = label !== 'pages/index/index';
  if (isComponent && cfg.component !== true) fail(label + '.json 缺少 "component": true');

  // ---- A ----
  const reg = cfg.usingComponents || {};
  Object.keys(reg).forEach(function (tag) {
    const raw = String(reg[tag]);
    const target = raw.charAt(0) === '/'
      ? path.join(MP, raw.slice(1).split('/').join(path.sep))
      : path.resolve(path.dirname(host), raw.split('/').join(path.sep));

    const missing = ['wxml', 'wxss', 'js', 'json'].filter(function (e) {
      return !fs.existsSync(target + '.' + e);
    });
    if (missing.length) {
      return fail(label + ' 注册的 <' + tag + '> 缺少文件：' + missing.join(' , '));
    }

    // ---- D 目录名与文件名同名 ----
    if (path.basename(path.dirname(target)) !== path.basename(target)) {
      fail('<' + tag + '> 的目录名与文件名不同名（微信要求 <name>/<name>.*）');
    }

    let cj;
    try {
      cj = JSON.parse(fs.readFileSync(target + '.json', 'utf8'));
    } catch (e) {
      return fail('<' + tag + '> 的 json 解析失败：' + e.message);
    }
    if (cj.component !== true) fail('<' + tag + '> 的 json 缺少 "component": true');
    if (!/Component\s*\(\s*\{/.test(fs.readFileSync(target + '.js', 'utf8'))) {
      fail('<' + tag + '> 的 js 里找不到 Component({');
    }
    const cw = stripComments(fs.readFileSync(target + '.wxml', 'utf8')).trim();
    if (!cw) fail('<' + tag + '> 的 wxml 去掉注释后是空的');
    else ok('<' + tag + '> → ' + path.relative(MP, target).replace(/\\/g, '/') +
      '（' + cw.length + ' 字节内容）');
  });

  // ---- B ----
  const used = customTags(fs.readFileSync(wxmlPath, 'utf8'));
  used.forEach(function (t) {
    if (!reg[t]) {
      fail(label + ' 用了 <' + t + '>，但它的 json 里没有注册 —— 运行时这一块会静默变空白');
    }
  });
  if (used.size) {
    console.log('    自定义标签 ' + used.size + ' 个：' + Array.from(used).join(' '));
  }
}

console.log('=== 页面 ===');
audit(path.join(PAGE_DIR, 'index'), 'pages/index/index');

if (!fs.existsSync(COMP_DIR)) {
  console.log('\n（还没有 components 目录，跳过）');
} else {
  const names = fs.readdirSync(COMP_DIR).filter(function (n) {
    return fs.statSync(path.join(COMP_DIR, n)).isDirectory();
  }).sort();
  console.log('\n=== 组件（' + names.length + ' 个）===');
  names.forEach(function (n) {
    audit(path.join(COMP_DIR, n, n), 'components/' + n + '/' + n);
  });
}

// ---- C 全部 wxml 标签配平 ----
console.log('\n=== WXML 标签配平 ===');
const wxmls = [];
(function walk(d) {
  fs.readdirSync(d).forEach(function (f) {
    const q = path.join(d, f);
    if (fs.statSync(q).isDirectory()) walk(q);
    else if (/\.wxml$/.test(f)) wxmls.push(q);
  });
})(MP);
wxmls.forEach(function (f) {
  const label = path.relative(MP, f).replace(/\\/g, '/');
  const errs = balance(fs.readFileSync(f, 'utf8'));
  if (errs.length) {
    fail(label);
    errs.forEach(function (e) { console.log('      ' + e); });
  } else {
    ok(label);
  }
});

console.log('');
if (bad) {
  console.log('✗ ' + bad + ' 处问题');
  process.exit(1);
}
console.log('OK —— 组件解析 / 标签注册 / 文件名 / 标签配平 四项全过');
