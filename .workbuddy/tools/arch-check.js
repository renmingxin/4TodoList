#!/usr/bin/env node
/*
 * arch-check.js —— 组件化重构的「等价性守卫」
 *
 * 为什么需要它：
 *   把一个大页面拆成「页面 + N 个组件」时，出错的方式几乎都不是语法错误，
 *   而是**静默的丢失**——某段 WXML 忘了搬、某个 class 的样式没跟着走、
 *   搬的时候手滑改了半个数值。这三件事 WXML/WXSS 全都合法，mp-check 也
 *   全都放行，只有真机上肉眼看才发现「这里怎么少了一块」。
 *
 *   所以这里不做语法检查，只做一件事：把**重构前后的渲染结果**压成两个
 *   可逐字比对的东西。
 *
 *   ① 扁平化 class 序列
 *      把页面 WXML 里的自定义组件标签按其 .wxml 递归展开（见 wxml-flatten.js），
 *      再按文档顺序抽出所有 class token。
 *      组件化只是「把一段 WXML 搬进另一个文件」，渲染出来的 class 序列
 *      应当逐字不变 —— 于是这个数组就是比对的基准。
 *
 *   ② 选择器 → 声明 映射
 *      把所有 wxss（app.wxss + 页面 + 全部组件）按
 *      「选择器（去掉注释与多余空白）→ 声明体（同样规范化）」建表。
 *      把样式从页面搬进组件属于**换地方**，不属于**改内容**，
 *      所以这张表也必须逐字不变。表是跨文件合并的，因此「搬家」对它透明，
 *      一旦有人顺手改了数值就会立刻暴露。
 *
 * 用法（在项目根目录）：
 *   node .workbuddy/tools/arch-check.js snapshot   # 改动前落基线
 *   node .workbuddy/tools/arch-check.js verify     # 改动后比对
 *
 * verify 退出码非 0 表示「渲染结果变了」（或基线不存在）。
 */

const fs = require('fs');
const path = require('path');
const WF = require('./wxml-flatten.js');

const ROOT = WF.ROOT;
const SNAP_PATH = path.join(ROOT, '.workbuddy', 'tmp', 'arch-baseline.json');

/* ------------------------------------------------------------------ *
 * 已声明的「有意差异」
 *
 * 重构过程中允许出现的、且经人工确认无害的差异写在这里。
 * 空集合代表「本该逐字一致」—— 出现任何差异都要先解释清楚再决定是
 * 改回代码还是登记到这里，**不允许直接放过**。
 * ------------------------------------------------------------------ */

// .qmark 的字形原本靠祖先类选（.q1 .qmark），搬进组件后改成
// 复合式（.qmark.q1），由使用方把象限键直接挂在图标元素上。
// 这样组件不必依赖「跨组件边界的后代匹配」是否成立。
const SELECTOR_RENAMES = [
  ['.q1 .qmark', '.qmark.q1'],
  ['.q2 .qmark', '.qmark.q2'],
  ['.q3 .qmark', '.qmark.q3'],
  ['.q4 .qmark', '.qmark.q4'],
];

// 一个组件被两处调用、而两处的 class 串本来就不一样时，
// 合并成一个组件会让「差异」消失（另一处也带上这个类）。
// 这类 delta 是结构性的、可解释的，登记在这里；
// 每次都会打印出来（不静默吞掉），其余任何计数变化仍然报错。
//
// flat +1：统计条原本总览写 class="stats"、我的写 class="stats flat"；
//          抽成 fq-stats 后两处共用同一个模板，flat 出现次数 1 → 2。
const TOKEN_DELTA = {
  flat: 1,
};

/* ------------------------------------------------------------------ */

function stripCss(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 把一段 WXML 里的 class 属性展开成 token 数组（保持文档顺序）
 *  ⚠️ 这里**不需要**再剥一遍注释：传进来的已经是 wxml-flatten.js 摊平过的文本，
 *     而摊平时每个文件都先过了一遍 stripWxmlComments。
 *     验证（2026-10-09）：往 index.wxml 塞一条写着 class="zzz" 的注释，verify 照旧全绿；
 *     再把摊平器里那句剥注释删掉，同一条注释立刻让 verify 报「计数变了」。
 *     也就是说守卫在**摊平器那一侧**。在这儿重复一遍只会让人以为防线在本地 ——
 *     一开始我就写错了这一步，是变异验证把这条冗余改出来的。 */
function classTokens(src) {
  const out = [];
  const re = /class="([^"]*)"/g;
  let m;
  while ((m = re.exec(src))) {
    // 插值里的字符串字面量算作类名（如 {{done?'done':''}} → done）
    const raw = m[1].replace(/\{\{([^}]*)\}\}/g, function (_, expr) {
      const lits = [];
      const litRe = /'([^']*)'|"([^"]*)"/g;
      let x;
      while ((x = litRe.exec(expr))) lits.push(x[1] !== undefined ? x[1] : x[2]);
      return ' ' + lits.join(' ') + ' ';
    });
    raw.split(/\s+/).forEach(function (c) {
      if (c) out.push(c);
    });
  }
  return out;
}

/** 「选择器 → 规范化声明体」映射。跨文件合并，所以「搬家」对它透明。 */
function cssMap(files) {
  const map = {};
  const dup = [];
  files.forEach(function (f) {
    const src = stripCss(fs.readFileSync(f, 'utf8'));
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = ruleRe.exec(src))) {
      const sel = m[1].replace(/\s+/g, ' ').trim();
      const decl = m[2].replace(/\s+/g, ' ').replace(/\s*:\s*/g, ':').trim();
      if (!sel) continue;
      if (map[sel] !== undefined && map[sel] !== decl) {
        dup.push(sel + '（' + map[sel] + ' vs ' + decl + '）');
      }
      map[sel] = decl;
    }
  });
  return { map: map, dup: dup };
}

function norm(t) {
  let s = t;
  SELECTOR_RENAMES.forEach(function (p) {
    if (s === p[0]) s = p[1];
  });
  return s;
}

function normCss(map) {
  const out = {};
  Object.keys(map).forEach(function (k) {
    out[norm(k)] = map[k];
  });
  return out;
}

function compute() {
  const wxsss = WF.allWxss();
  const css = cssMap(wxsss);
  return {
    pageTokens: classTokens(WF.flattenPage()),
    css: normCss(css.map),
    dup: css.dup,
    missing: WF.flattenProblems(),
    files: wxsss.map(function (f) {
      return path.relative(ROOT, f);
    }),
  };
}

const mode = process.argv[2] || 'verify';

if (mode === 'snapshot') {
  const cur = compute();
  if (cur.missing.length) {
    console.error('❌ 组件引用缺失，先修好再落基线：');
    cur.missing.forEach(function (x) {
      console.error('   ' + x);
    });
    process.exit(2);
  }
  const snap = {
    at: new Date().toISOString(),
    pageTokens: cur.pageTokens,
    css: cur.css,
  };
  fs.mkdirSync(path.dirname(SNAP_PATH), { recursive: true });
  fs.writeFileSync(SNAP_PATH, JSON.stringify(snap, null, 1));
  console.log('已落基线 → ' + path.relative(ROOT, SNAP_PATH));
  console.log('  class token ' + snap.pageTokens.length + ' 个');
  console.log('  css 选择器 ' + Object.keys(snap.css).length + ' 个，来自 ' + cur.files.length + ' 个 wxss');
  process.exit(0);
}

if (!fs.existsSync(SNAP_PATH)) {
  console.error('❌ 没有基线。先在**改动之前**跑一次：node .workbuddy/tools/arch-check.js snapshot');
  process.exit(2);
}

const base = JSON.parse(fs.readFileSync(SNAP_PATH, 'utf8'));
const cur = compute();
let bad = 0;

console.log('基线取自 ' + base.at);

/* ---------- ① 扁平化 class 序列 ----------
   主判据是**多重集**（每个 class 出现几次），不是逐位比较 ——
   逐位比较对「组件被多处复用、各处的 class 串略有不同」这种情况必然误报。
   逐位比较只在多重集完全一致时再加一道（作为更强的证据）。 */
const cnt = function (arr) {
  const m = {};
  arr.forEach(function (t) {
    m[t] = (m[t] || 0) + 1;
  });
  return m;
};
const a = cnt(base.pageTokens);
const b = cnt(cur.pageTokens);
const diff = [];
new Set(Object.keys(a).concat(Object.keys(b))).forEach(function (k) {
  if ((a[k] || 0) !== (b[k] || 0)) diff.push({ k: k, from: a[k] || 0, to: b[k] || 0 });
});

const allowed = [];
const unexpected = [];
diff.forEach(function (d) {
  const allow = TOKEN_DELTA[d.k];
  if (allow !== undefined && d.to - d.from === allow) allowed.push(d);
  else unexpected.push(d);
});

console.log('\n【渲染 class 序列】基线 ' + base.pageTokens.length + ' 个 / 当前 ' + cur.pageTokens.length + ' 个（多重集）');
if (allowed.length) {
  console.log(
    '  已登记的差异：' +
      allowed
        .map(function (d) {
          return d.k + ' ' + d.from + '→' + d.to;
        })
        .join('，')
  );
}
if (unexpected.length) {
  bad++;
  console.log('  ❌ 未登记的计数变化：' + unexpected.map(function (d) {
    return d.k + ' ' + d.from + '→' + d.to;
  }).join('，'));
  const lost = unexpected.filter(function (d) {
    return d.to < d.from;
  });
  if (lost.length) console.log('     （变少通常意味着「有一段 WXML 没搬全」或「漏了一段」）');
} else {
  console.log('  OK —— 计数一致（含已登记差异）');
}

// 多重集一致时，再要逐位一致 —— 顺序变了同样说明渲染结构被动过
if (!diff.length) {
  const shown = [];
  const n = Math.max(base.pageTokens.length, cur.pageTokens.length);
  for (let i = 0; i < n; i++) {
    if (base.pageTokens[i] !== cur.pageTokens[i]) {
      shown.push(i);
      if (shown.length <= 8) {
        console.log('    第 ' + i + ' 位：基线 ' + JSON.stringify(base.pageTokens[i]) + '  当前 ' + JSON.stringify(cur.pageTokens[i]));
      }
    }
  }
  if (shown.length) {
    bad++;
    console.log('  ❌ 计数一致但顺序变了（共 ' + shown.length + ' 处）—— 渲染结构被动过');
  } else {
    console.log('  逐位一致');
  }
}

/* ---------- ② 选择器 → 声明 ---------- */
const bc = base.css;
const cc = cur.css;
const bKeys = Object.keys(bc);
const cKeys = Object.keys(cc);
const removed = bKeys.filter(function (k) {
  return cc[k] === undefined;
});
const added = cKeys.filter(function (k) {
  return bc[k] === undefined;
});
const changed = bKeys.filter(function (k) {
  return cc[k] !== undefined && cc[k] !== bc[k];
});

console.log('\n【样式映射】基线 ' + bKeys.length + ' 个 / 当前 ' + cKeys.length + ' 个');
if (removed.length) {
  bad++;
  console.log('  ❌ 丢了 ' + removed.length + ' 个选择器：' + removed.slice(0, 12).join(' | '));
}
if (added.length) {
  bad++;
  console.log('  ❌ 多了 ' + added.length + ' 个选择器：' + added.slice(0, 12).join(' | '));
}
if (changed.length) {
  bad++;
  changed.slice(0, 12).forEach(function (k) {
    console.log('  ❌ 声明被改了：' + k + '\n       基线 ' + bc[k] + '\n       当前 ' + cc[k]);
  });
}
if (!removed.length && !added.length && !changed.length) {
  console.log('  OK —— 选择器与声明逐字一致（仅换了文件）');
}

if (cur.dup.length) {
  console.log('\n⚠️  同一个选择器被定义了多次且内容不同（跨文件合并后互相覆盖）：');
  cur.dup.forEach(function (d) {
    console.log('   ' + d);
  });
}

if (cur.missing.length) {
  bad++;
  console.log('\n❌ usingComponents 指向的文件不存在：');
  cur.missing.forEach(function (x) {
    console.log('   ' + x);
  });
}

console.log('\n' + (bad ? '✗ 渲染结果与基线不一致（' + bad + ' 项）' : '✓ 与基线等价：搬家没有改变任何 class 序列与样式内容'));
process.exit(bad ? 1 : 0);
