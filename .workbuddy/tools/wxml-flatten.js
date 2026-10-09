// wxml-flatten.js —— 把页面 WXML 里的自定义组件就地递归展开成一份「摊平的 WXML」
//
// 为什么需要它：
//   组件化之后，「页面长什么样」这件事不再由一个文件决定 ——
//   页面上写了 <fq-mine />，真正的内容在 components/fq-mine/fq-mine.wxml 里。
//   于是所有**按源码文本做断言**的地方（静态契约、等价性守卫）都会失效：
//   它们去 index.wxml 里找 .dhead，可 .dhead 已经搬走了；找不到就报错，
//   而「把断言删掉」永远是最顺手的那一步 —— 契约就这么一条条消失的。
//
//   正确的做法不是放弃契约，而是让它们继续看「页面的样子」，只不过
//   这份「样子」由展开得到。渲染结果没变，契约就一个都不用改。
//
// 约定：
//   - 组件在页面里写成 <fq-x ... />（自闭合）或 <fq-x ...>...</fq-x>，两种都认
//   - 展开是**纯文本替换**，不做属性到 properties 的映射 —— 这里只服务于
//     「有哪些 class / 有哪些 wx:if」这类文本级断言，不模拟数据流
//   - 注释在展开时一并剥掉（调用方此前普遍先剥注释再断言）

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MP = path.join(ROOT, 'miniprogram');

function stripWxmlComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '');
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * 读 dir 下的 <name>.json，返回 { 组件标签: { dir, name } }
 * usingComponents 的值可以是相对路径，也可以是「小程序根起」的绝对路径。
 *
 * ⚠️ 拆成 { dir, name } 而不是只回一个路径，是因为**两段各有用途**：
 *   dir  —— 继续找该组件自己的 json（组件里还可能嵌组件）
 *   name —— 定位它的 .wxml（这里的约定是 <name>/<name>.wxml）
 * 早先只回一个完整路径、再由调用方 path.basename() 取名字，等于把
 * 「组件名」当成了「组件目录名」又拼一遍，拼出
 * components/fq-appbar/fq-appbar/fq-appbar.wxml 这种三级路径，组件永远展不开 ——
 * 而展不开**不报错**，只是 class 少了一大批，守卫于是报「未登记的计数变化」，
 * 把「工具坏了」伪装成「代码改坏了」。工具自身的路径拼接必须自己先钉死。
 */
function usingComponents(dir, name) {
  const j = readJson(path.join(dir, name + '.json'));
  if (!j || !j.usingComponents) return {};
  const map = {};
  Object.keys(j.usingComponents).forEach(function (tag) {
    const v = String(j.usingComponents[tag]).split('/').join(path.sep);
    const full = v.startsWith('.') ? path.resolve(dir, v) : path.join(MP, v.replace(/^\//, ''));
    map[tag] = { dir: path.dirname(full), name: path.basename(full) };
  });
  return map;
}

const missing = [];

/** 递归展开。返回摊平后的文本。 */
function flatten(dir, name, depth) {
  const file = path.join(dir, name + '.wxml');
  if (!fs.existsSync(file)) return '';
  if (depth > 12) throw new Error('组件嵌套过深（疑似循环引用）：' + file);
  let text = stripWxmlComments(fs.readFileSync(file, 'utf8'));
  const map = usingComponents(dir, name);
  Object.keys(map).forEach(function (tag) {
    const cdir = map[tag].dir;
    const cname = map[tag].name;
    const cwxml = path.join(cdir, cname + '.wxml');
    if (!fs.existsSync(cwxml)) {
      missing.push(tag + ' → ' + path.relative(ROOT, cwxml));
      return;
    }
    const body = flatten(cdir, cname, depth + 1);
    // 自闭合形式
    text = text.replace(
      new RegExp('<' + tag + '(?=[\\s/>])(?:(?!<)[\\s\\S])*?/>', 'g'),
      body
    );
    // 带子节点的形式（同名标签之间不会嵌套同名标签，够用）
    text = text.replace(
      new RegExp('<' + tag + '(?=[\\s/>])[^>]*>([\\s\\S]*?)</' + tag + '>', 'g'),
      body + '$1'
    );
  });
  return text;
}

/** 摊平的页面 WXML（overview / detail / all / mine 四种视图都在里面） */
function flattenPage() {
  missing.length = 0;
  return flatten(path.join(MP, 'pages', 'index'), 'index', 0);
}

/** 摊平过程中发现的问题（组件标签指向的文件不存在等） */
function flattenProblems() {
  return missing.slice();
}

/** 列出小程序下所有 wxss（app.wxss + 页面 + 全部组件），顺序稳定 */
function allWxss() {
  const out = [path.join(MP, 'app.wxss')];
  const compDir = path.join(MP, 'components');
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d).sort().forEach(function (f) {
      const q = path.join(d, f);
      if (fs.statSync(q).isDirectory()) walk(q);
      else if (f.endsWith('.wxss')) out.push(q);
    });
  })(compDir);
  out.push(path.join(MP, 'pages', 'index', 'index.wxss'));
  return out.filter(function (f) {
    return fs.existsSync(f);
  });
}

/** 客户端 JS 的全部来源（页面 + utils 下所有模块 + services 下所有模块）。
 *  「客户端这一侧有没有某事」这类断言要拼起来看 —— 拆文件之后
 *  只看页面会把契约变成盲区（比如 fid 泄漏其实发生在 services 里、
 *  拖动引擎的落库调用发生在 utils/drag.js 里）。
 *
 *  ⚠️ 刻意用**遍历目录**而不是写死文件名：以后每加一个模块都要回来改一次
 *  列表的话，迟早会漏，而漏掉的那个模块正好就是契约的盲区。 */
function clientJs() {
  const roots = [
    path.join(MP, 'pages', 'index', 'index.js'),
    path.join(MP, 'utils'),
    path.join(MP, 'services'),
  ];
  const files = [];
  roots.forEach(function (r) {
    if (!fs.existsSync(r)) return;
    if (fs.statSync(r).isFile()) {
      files.push(r);
      return;
    }
    (function walk(d) {
      fs.readdirSync(d).sort().forEach(function (f) {
        const q = path.join(d, f);
        if (fs.statSync(q).isDirectory()) walk(q);
        else if (f.endsWith('.js')) files.push(q);
      });
    })(r);
  });
  // 去重后按相对路径排序，保证拼接顺序稳定（页面放最前，便于读）
  const uniq = [];
  files.forEach(function (f) {
    if (uniq.indexOf(f) < 0) uniq.push(f);
  });
  uniq.sort(function (a, b) {
    const ra = path.relative(ROOT, a);
    const rb = path.relative(ROOT, b);
    if (ra === path.join('miniprogram', 'pages', 'index', 'index.js')) return -1;
    if (rb === path.join('miniprogram', 'pages', 'index', 'index.js')) return 1;
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
  return uniq
    .map(function (f) {
      return '/* == ' + path.relative(ROOT, f).split(path.sep).join('/') + ' == */\n' + fs.readFileSync(f, 'utf8');
    })
    .join('\n');
}

module.exports = {
  ROOT: ROOT,
  MP: MP,
  flattenPage: flattenPage,
  flattenProblems: flattenProblems,
  flatten: flatten,
  allWxss: allWxss,
  clientJs: clientJs,
  stripWxmlComments: stripWxmlComments,
  path: path,
  fs: fs,
};
