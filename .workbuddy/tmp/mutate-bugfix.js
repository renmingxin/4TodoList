// .workbuddy/tmp/mutate-bugfix.js —— 一次性的变异验证器（草稿区，不入库）
//
// 目的：证明这次为两个 bug 新加的断言**不是永远绿的**，并且证明
//       「给 mp-check / arch-check 加剥注释」这一行是承重的（不是装饰）。
// 做法：对源码做一处「看起来更像手滑」的改动 → 跑对应测试 → 结果必须符合预期 → 原样还原。
//
// 运行：node .workbuddy/tmp/mutate-bugfix.js
//
// ⚠️ 每个变异都在 finally 里还原；跑完请 `git diff --stat` 确认工作区干净。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const T_SCHED = '.workbuddy/tools/test-sched.js';
const T_REORDER = '.workbuddy/tools/test-reorder.js';
const MP_CHECK = '.workbuddy/tools/mp-check.js';
const ARCH = '.workbuddy/tools/arch-check.js';
const WXML_FLATTEN = '.workbuddy/tools/wxml-flatten.js';
// 与 check-all.js 里第 4 步传的参数保持一致（换个参数集就等于换了被测对象）
const MP_ARGS = ['miniprogram/pages/index', 'miniprogram/components', 'miniprogram/app.wxss'];

const P_JS = 'miniprogram/pages/index/index.js';
const P_WXML = 'miniprogram/pages/index/index.wxml';
const P_WXSS = 'miniprogram/pages/index/index.wxss';
const F_JS = 'miniprogram/components/fq-fab/fq-fab.js';
const F_WXSS = 'miniprogram/components/fq-fab/fq-fab.wxss';

// 「注释里塞一段长得像代码的东西」——用来验检查器有没有先剥注释
const BAD_COMMENT =
  '  <!-- 变异对照：注释里写 class="zzz-不存在的类" 与 {{nopeNotAKey}} 都不该被当成真引用 -->\n';

const MUTS = [
  /* ---------- bug 1：日程页眉的日期固定为今天 ---------- */
  {
    edits: [{ file: P_JS, from: 'patch.pageMeta = dateCN(todayStr());', to: "patch.pageMeta = dateCN(date) + (diff === 0 ? ' · 今天' : '');" }],
    cmd: [T_SCHED],
    why: '回到那个 bug：页眉副标题跟着点日历变',
    red: ['页眉副标题纹丝不动'],
  },
  {
    edits: [{ file: P_JS, from: 'patch.pageMeta = dateCN(todayStr());', to: "patch.pageMeta = dateCN(todayStr()) + ' · 今天';" }],
    cmd: [T_SCHED],
    why: '固定今天之后又给它挂「· 今天」后缀（废话）',
    red: ['不再挂「· 今天」后缀'],
  },

  /* ---------- bug 2：悬浮新建挪进矩阵右下角 ---------- */
  {
    edits: [{ file: F_WXSS, from: '  right: 24rpx;\n  bottom: 22rpx;\n', to: '  right: 36rpx;\n' }],
    cmd: [T_REORDER],
    why: '样式改回「贴屏幕右边、由 JS 算 bottom」的老坐标',
    red: ['距矩阵右边 24rpx', '距矩阵底边 22rpx'],
  },
  {
    edits: [
      {
        file: P_WXML,
        from: '      <view class="ovgrid">\n        <fq-quad fill grid="{{grid}}" bind:open="onOpenQuad" />\n        <fq-fab bind:create="onNew" />\n      </view>',
        to: '      <view class="ovgrid">\n        <fq-quad fill grid="{{grid}}" bind:open="onOpenQuad" />\n      </view>\n      <fq-fab bind:create="onNew" />',
      },
    ],
    cmd: [T_REORDER],
    why: '把按钮挪出矩阵容器、挂回屏幕级（这次修的就是它）',
    red: ['落在 .ovgrid 与 .ovwater 之间'],
  },
  {
    edits: [
      {
        file: P_WXSS,
        from: '     矩阵高是 flex 分出来的，所以这两个坐标天然跟着矩阵走。 */\n  position: relative;\n}',
        to: '     矩阵高是 flex 分出来的，所以这两个坐标天然跟着矩阵走。 */\n}',
      },
    ],
    cmd: [T_REORDER],
    why: '忘了给参照系：.fab 会一路找到 .screen 上去',
    red: ['成为绝对定位的参照系'],
  },
  {
    edits: [{ file: F_JS, from: '  methods: {', to: '  properties: {\n    bottom: { type: null },\n  },\n\n  methods: {' }],
    cmd: [T_REORDER],
    why: '又把偏移量做成组件的入参（页面就得重新算像素）',
    red: ['不再收这个入参'],
  },
  {
    edits: [{ file: P_JS, from: '    safeBottom: 0,\n', to: '    safeBottom: 0,\n    fabBottom: 80,\n' }],
    cmd: [T_REORDER],
    why: '页面 data 里又长出一个算出来的悬浮偏移',
    red: ['页面已不再算这个偏移量'],
  },

  /* ---------- 检查器：剥注释的两处修补（正 / 反向对照） ---------- */
  {
    edits: [{ file: P_WXML, from: '  <view wx:if="{{view===\'overview\'}}" class="ovbody">', to: BAD_COMMENT + '  <view wx:if="{{view===\'overview\'}}" class="ovbody">' }],
    cmd: [MP_CHECK].concat(MP_ARGS),
    why: '【对照】注释里写类名与插值，mp-check 应当**看不见**',
    red: [],
    expectGreen: true,
  },
  {
    // 反向对照：把 mp-check 里那行剥注释删掉，同一条注释立刻变成真引用。
    // 两条必须成对出现 —— 只删剥注释的话，源码里已经没有「注释里带插值」的地方了
    // （那条被我改写过），会得到一个「绿」的假结论。
    edits: [
      { file: P_WXML, from: '  <view wx:if="{{view===\'overview\'}}" class="ovbody">', to: BAD_COMMENT + '  <view wx:if="{{view===\'overview\'}}" class="ovbody">' },
      { file: MP_CHECK, from: '  src = stripWxmlComments(src);\n  const locals = new Set([', to: '  const locals = new Set([' },
    ],
    cmd: [MP_CHECK].concat(MP_ARGS),
    why: '【反向对照】删掉 rootsInWxml 的剥注释 + 注释里写插值 → 假警报回来',
    red: ['nopeNotAKey'],
  },
  {
    edits: [{ file: P_WXML, from: '  <view wx:if="{{view===\'overview\'}}" class="ovbody">', to: BAD_COMMENT + '  <view wx:if="{{view===\'overview\'}}" class="ovbody">' }],
    cmd: [ARCH, 'verify'],
    why: '【对照】注释里写 class="zzz..."，等价性守卫应当**看不见**',
    red: [],
    expectGreen: true,
  },
  {
    // 反向对照：把摊平器里那句剥注释删掉 —— 守卫其实在那一侧。
    // （一开始我给 classTokens 也加了一遍剥注释，就是这条变异证明它冗余。）
    edits: [
      { file: P_WXML, from: '  <view wx:if="{{view===\'overview\'}}" class="ovbody">', to: BAD_COMMENT + '  <view wx:if="{{view===\'overview\'}}" class="ovbody">' },
      { file: WXML_FLATTEN, from: "  let text = stripWxmlComments(fs.readFileSync(file, 'utf8'));", to: "  let text = fs.readFileSync(file, 'utf8');" },
    ],
    cmd: [ARCH, 'verify'],
    why: '【反向对照】删掉摊平器的剥注释 → 注释里的 class 混进基线',
    red: ['计数', 'zzz-不存在的类'],
  },

  /* ---------- 对照组：只改注释，不该让任何断言变红 ---------- */
  {
    edits: [{ file: P_WXSS, from: '/* ---------------- 总览页主体', to: '/* ---------------- 总览页主体（变异对照：只改注释）' }],
    cmd: [T_REORDER],
    why: '【对照组】只改注释，应当保持全绿',
    red: [],
    expectGreen: true,
  },
];

function run(argv) {
  try {
    execFileSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8' });
    return { green: true, out: '' };
  } catch (err) {
    return { green: false, out: (err.stdout || '') + (err.stderr || '') };
  }
}

console.log('变异验证：bug 1 / bug 2 / 检查器剥注释 —— 逐条确认「该红的红、该绿的绿」\n');

const rows = [];
let bad = 0;
let hitMiss = 0;

for (const m of MUTS) {
  // 先确认每个变异点都能命中，否则这条变异是无效的（不是「通过」）
  let miss = null;
  for (const e of m.edits) {
    const abs = path.join(ROOT, e.file);
    if (fs.readFileSync(abs, 'utf8').indexOf(e.from) < 0) {
      miss = e.file + ' 里找不到变异点';
      break;
    }
  }
  if (miss) {
    rows.push([m.why, '变异点未命中：' + miss, '✗ 脚本写错了，这条变异无效']);
    bad++;
    hitMiss++;
    continue;
  }

  const saved = m.edits.map(function (e) {
    const abs = path.join(ROOT, e.file);
    const src = fs.readFileSync(abs, 'utf8');
    fs.writeFileSync(abs, src.replace(e.from, e.to));
    return { abs: abs, src: src };
  });

  let res;
  try {
    res = run(m.cmd);
  } finally {
    saved.forEach(function (s) {
      fs.writeFileSync(s.abs, s.src);
    });
  }

  const wantRed = !m.expectGreen;
  const gotRed = !res.green;
  const verdict = wantRed
    ? gotRed
      ? '✓ 变红'
      : '✗ **仍然全绿 —— 这条断言没在守东西**'
    : gotRed
      ? '✗ **对照变红了 —— 变异器/检查器在瞎报，上面的红都不算数**'
      : '✓ 保持绿';
  if (wantRed !== gotRed) bad++;

  const hits = gotRed
    ? (m.red || []).filter(function (k) { return res.out.indexOf(k) >= 0; })
    : [];
  rows.push([
    m.why,
    m.red && m.red.length ? '期望挂：' + m.red.join(' / ') : '—',
    verdict + (hits.length ? '（命中 ' + hits.length + ' 项）' : ''),
  ]);
}

console.log('变异点 → 结果\n');
rows.forEach(function (r, i) {
  console.log(i + 1 + '. ' + r[0]);
  console.log('   ' + r[1]);
  console.log('   结果：' + r[2]);
});
console.log('\n========================================');
console.log(
  bad
    ? '✗ 有 ' + bad + ' 条变异不符合预期' + (hitMiss ? '（其中 ' + hitMiss + ' 条是变异点没命中）' : '')
    : '✓ 全部 ' + MUTS.length + ' 条变异符合预期（红得其所 + 对照组保持绿）'
);
process.exit(bad ? 1 : 0);
