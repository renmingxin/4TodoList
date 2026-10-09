// .workbuddy/tmp/mutate-sched.js —— 一次性的变异验证器（草稿区，不入库）
//
// 目的：证明 test-sched.js 的断言**不是永远绿的**。
// 做法：对源码做一处「看起来更像手滑」的改动 → 跑测试 → 必须变红 → 原样还原。
// 一条断言如果对应的变异仍然是绿的，那它就没在守任何东西。
//
// 运行：node .workbuddy/tmp/mutate-sched.js
//
// ⚠️ 每个变异都在 finally 里还原；脚本被中断也只会留下最多一个文件的改动，
//    跑完请 `git diff --stat` 确认工作区干净。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST = '.workbuddy/tools/test-sched.js';
const P_JS = 'miniprogram/pages/index/index.js';
const P_WXML = 'miniprogram/pages/index/index.wxml';
const C_JS = 'miniprogram/utils/const.js';
const F_JS = 'miniprogram/utils/format.js';
const CF_JS = 'cloudfunctions/fqTodo/index.js';
const TB_WXML = 'miniprogram/components/fq-tabbar/fq-tabbar.wxml';

// { file, from, to, why }  —— why 就是这条变异在模拟哪种手滑
const MUTS = [
  {
    file: P_JS,
    from: 'label: planLabels(dayDiff(date))[which],',
    to: 'label: planLabels(dayDiff(d))[which],',
    why: '回到那个 off-by-one：拿「已前进一天」的基准再取 [which]',
    red: ['第二张卡的标题说的是**次日**'],
  },
  {
    file: P_JS,
    from: 'const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;',
    to: 'const lead = new Date(y, m - 1, 1).getDay() % 7;',
    why: '忘了把周日从 0 挪到末尾（日历整体错开一列）',
    red: ['周一起始'],
  },
  {
    file: P_JS,
    from: 'const k = dayKey(it.remindAt);',
    to: "const k = it.done ? '' : dayKey(it.remindAt);",
    why: '圆点口径偷偷加了「未完成」条件 → 与事项列表的口径分叉',
    red: ['逐格一致', '已完成的条目仍算'],
  },
  {
    file: P_JS,
    from: 'if (!Array.isArray(list)) return;',
    to: 'if (!list) return;',
    why: '容错只判真假 → 收到非数组时 forEach 直接抛（首屏白屏）',
    red: ['不是数组'],
  },
  {
    file: C_JS,
    from: 'const CAL_CELLS = 42;',
    to: 'const CAL_CELLS = 35;',
    why: '把月历改成「5 行」省一点高度',
    red: ['产出的格子数'],
  },
  {
    file: C_JS,
    from: 'const PLAN_MAX = 300;',
    to: 'const PLAN_MAX = 200;',
    why: '只改客户端那半边，云函数没跟着改（成对常量）',
    red: ['PLAN_MAX'],
  },
  {
    file: F_JS,
    from: `  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 毫秒时间戳 → 'HH:MM'。日程列表右槽那个短时刻。`,
    to: `  return d.toISOString().slice(0, 10);
}

// 毫秒时间戳 → 'HH:MM'。日程列表右槽那个短时刻。`,
    why: 'dayKey 改用 toISOString（UTC）→ 晚上 8 点后的提醒跑到明天',
    red: ['21:00'],
  },
  {
    file: F_JS,
    from: "  if (diff === 1) return ['明天要做什么', '后天准备做什么'];",
    to: "  if (diff === 1) return ['今天要做什么', '明天准备做什么'];",
    why: '标题写死成「今天/明天」——选中明天时照样说今天',
    red: ['差 1'],
  },
  {
    file: CF_JS,
    from: 'const MAX_PLAN = 300;',
    to: 'const MAX_PLAN = 200;',
    why: '只改云函数那半边（成对常量的另一侧）',
    red: ['PLAN_MAX'],
  },
  {
    file: TB_WXML,
    from: 'data-k="sched"',
    to: 'data-k="schedule"',
    why: 'Tab 的 state 名与页面 state.view 对不上',
    red: ['日程是第 2 个 Tab'],
  },
  {
    file: P_WXML,
    from: 'kind="next"',
    to: 'kind="day"',
    why: '两张计划卡的 kind 撞在一起（都去写选中日）',
    red: ['两张计划卡分别是 day / next'],
  },
  // —— 对照组：这处改动不该让任何断言变红 ——
  // 如果它也报红，说明这个「变异器」本身在瞎报，上面 10 条红就都不算数了。
  {
    file: P_JS,
    from: '  /* ================= 渲染 ================= */',
    to: '  /* ================= 渲染（变异对照：只改注释） ================= */',
    why: '【对照组】只改注释，应当保持全绿',
    red: [],
    expectGreen: true,
  },
];

function run() {
  try {
    execFileSync(process.execPath, [TEST], { cwd: ROOT, encoding: 'utf8' });
    return { green: true, out: '' };
  } catch (err) {
    return { green: false, out: (err.stdout || '') + (err.stderr || '') };
  }
}

console.log('变异验证：每条改动都必须让 test-sched.js 变红（除对照组）\n');
const rows = [];
let bad = 0;

for (const m of MUTS) {
  const abs = path.join(ROOT, m.file);
  const src = fs.readFileSync(abs, 'utf8');
  if (src.indexOf(m.from) < 0) {
    rows.push([m.file, m.why, '变异点未命中', '✗ 测试脚本写错了（源码里找不到这段），这条变异无效']);
    bad++;
    continue;
  }
  fs.writeFileSync(abs, src.replace(m.from, m.to));
  let res;
  try {
    res = run();
  } finally {
    fs.writeFileSync(abs, src); // 无论成败都还原
  }

  const wantRed = !m.expectGreen;
  const gotRed = !res.green;
  const verdict = wantRed
    ? gotRed
      ? '✓ 变红'
      : '✗ **仍然全绿 —— 这条断言没在守东西**'
    : gotRed
      ? '✗ **对照组变红了 —— 变异器/测试在瞎报，上面的红都不算数**'
      : '✓ 保持绿';
  if (wantRed !== gotRed) bad++;

  // 报出具体是哪几条断言挂的，证明红得「打在了正确的地方」而不是别处崩了
  let hits = [];
  if (gotRed) {
    hits = (m.red || []).filter(function (k) { return res.out.indexOf(k) >= 0; });
  }
  rows.push([m.file, m.why, m.red && m.red[0] ? '期望挂：' + m.red.join(' / ') : '—', verdict + (hits.length ? '（命中 ' + hits.length + ' 项）' : '')]);
}

console.log('变异点 → 结果\n');
rows.forEach(function (r, i) {
  console.log((i + 1) + '. ' + r[1]);
  console.log('   文件：' + r[0] + '   ' + r[2]);
  console.log('   结果：' + r[3]);
});
console.log('\n========================================');
console.log(bad ? '✗ 有 ' + bad + ' 条变异不符合预期' : '✓ 全部 ' + MUTS.length + ' 条变异符合预期（红得其所 + 对照组保持绿）');
process.exit(bad ? 1 : 0);
