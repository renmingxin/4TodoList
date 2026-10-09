// .workbuddy/tmp/mutate-progress.js —— 事项进度条的变异验证器（草稿区，不入库）
//
// 目的：证明这一轮为「事项进度」新加的每一条断言**都能红**。
//       一条永远绿的断言比没有断言更糟 —— 它会让人以为这块已经有人看过了。
// 做法：对源码做一处「看起来更像手滑」的改动 → 跑对应测试 → 结果必须符合预期 → 原样还原。
//
// 运行：node .workbuddy/tmp/mutate-progress.js
//
// ⚠️ 每个变异都在 finally 里还原；跑完请 `git diff --stat` 确认工作区干净。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const T_REORDER = '.workbuddy/tools/test-reorder.js';
const T_CLOUDFN = '.workbuddy/tools/test-cloudfn.js';
const T_WATER = '.workbuddy/tools/test-water.js';

const FN = 'cloudfunctions/fqTodo/index.js';
const P_JS = 'miniprogram/pages/index/index.js';
const P_WXML = 'miniprogram/pages/index/index.wxml';
const P_WXSS = 'miniprogram/pages/index/index.wxss';
const W_WXML = 'miniprogram/components/fq-water/fq-water.wxml';

const MUTS = [
  /* ============ 云函数：耦合与净化 ============ */
  {
    edits: [{ file: FN, from: '      progress: 0,\n      done: false,', to: '      done: false,' }],
    cmd: [T_CLOUDFN],
    why: '新建事项忘了落 progress',
    red: ['新建事项落库 progress = 0'],
  },
  {
    edits: [{ file: FN, from: '        progress: 0,\n        done: false,', to: '        done: false,' }],
    cmd: [T_CLOUDFN],
    why: '种子事项忘了落 progress（新库里唯一没有 progress 的那批行）',
    red: ['种子事项也带 progress'],
  },
  {
    edits: [{ file: FN, from: '    patch.progress = done ? 100 : prog;', to: '    patch.progress = prog;' }],
    cmd: [T_CLOUDFN],
    why: '耦合只写了 done，忘了补 progress（「完成但进度 60%」的矛盾行回来了）',
    red: ['只送 done:true → 进度补齐到 100'],
  },
  {
    edits: [{ file: FN, from: '    const done = hasDone ? !!src.done : prog >= 100;', to: '    const done = hasDone ? !!src.done : false;' }],
    cmd: [T_CLOUDFN],
    why: '送 progress 不再联动 done（拖到 100% 不会完成）',
    red: ['送 100% → 自动成为已完成'],
  },
  {
    edits: [{ file: FN, from: '    const done = hasDone ? !!src.done : prog >= 100;', to: '    const done = prog >= 100;' }],
    cmd: [T_CLOUDFN],
    why: '矛盾输入时改以 progress 为准（不再以 done 为准）',
    red: ['矛盾输入以 done 为准'],
  },
  {
    edits: [{ file: FN, from: '  return Math.max(0, Math.min(100, Math.round(n)));', to: '  return Math.round(n);' }],
    cmd: [T_CLOUDFN],
    why: 'toProgress 忘了夹紧',
    red: ['150% 夹到 100'],
  },
  {
    edits: [{ file: FN, from: '  return Math.max(0, Math.min(100, Math.round(n)));', to: '  return Math.max(0, Math.min(100, n));' }],
    cmd: [T_CLOUDFN],
    why: 'toProgress 忘了取整（拖动每一帧都是小数）',
    red: ['小数落到整数'],
  },
  {
    edits: [{ file: FN, from: '          progress: 100,\n', to: '' }],
    cmd: [T_CLOUDFN],
    why: '批量「标记为已完成」绕过耦合（批量路径上的破口）',
    red: ['批量标记完成 → 进度一并补到 100'],
  },

  /* ============ 页面：读口径 ============ */
  {
    edits: [{ file: P_JS, from: '  return it && it.done ? 100 : 0;', to: '  return 0;' }],
    cmd: [T_REORDER],
    why: '老数据（没有 progress）不再按 done 推 —— 已完成事项显示 0%',
    red: ['已完成**事项 → 100%'],
  },
  {
    edits: [{ file: P_JS, from: '    return Math.max(0, Math.min(100, Math.round(p)));', to: '    return p;' }],
    cmd: [T_REORDER],
    why: 'rowVM 不取整（库里的小数直接上屏）',
    red: ['小数落到整数'],
  },
  {
    edits: [{ file: P_JS, from: '        it.done = next;\n        it.progress = pct;', to: '        it.done = next;' }],
    cmd: [T_REORDER],
    why: '点「完成」不再同步进度（本地镜像与云端不一致）',
    red: ['镜像同步：progress = 100'],
  },
  {
    edits: [{ file: P_JS, from: '          if (rs[i]._id === id) return \'sections[\' + j + \'].rows[\' + i + \']\';', to: '          if (rs[i]._id === id) return \'rows[\' + i + \']\';' }],
    cmd: [T_REORDER],
    why: '「全部」页用错了数据树（改到另一棵上，屏幕不动）',
    red: ['「全部」页 → sections[j].rows[i]'],
  },

  /* ============ 页面：手势 ============ */
  {
    edits: [{ file: P_JS, from: '      if (Math.abs(pg.dx) <= Math.abs(pg.dy)) return;\n', to: '' }],
    cmd: [T_REORDER],
    why: '去掉横纵判别（在进度条上往下滑列表会改进度）',
    red: ['纵滑不动进度'],
  },
  {
    edits: [
      {
        file: P_JS,
        from: '  progPctAt(rect, clientX) {\n    if (!rect || !rect.width) return null;\n    const v = ((clientX - rect.left) / rect.width) * 100;',
        to: '  progPctAt(rect, clientX) {\n    const r = this._pg && this._pg.rect;\n    if (!r || !r.width) return null;\n    const v = ((clientX - r.left) / r.width) * 100;',
      },
    ],
    cmd: [T_REORDER],
    why: '【本次真抓到的 bug】progPctAt 自己去读 this._pg —— 松手时它已被清空',
    red: ['轻点（无位移）→ 跳到该位置 75%'],
  },
  {
    edits: [{ file: P_JS, from: '      const v = this.progPctAt(pg.rect, pg.x0);\n      if (v === null) return;\n      this.paintProgress(pg.id, v);', to: '      const v = this.progPctAt(pg.rect, pg.x0);\n      if (v === null) return;' }],
    cmd: [T_REORDER],
    why: '「点一下跳到该位置」只算不画',
    red: ['轻点（无位移）→ 跳到该位置 75%'],
  },
  {
    edits: [{ file: P_JS, from: '    this._pg = null;\n    if (this.data.sortMode) return;\n', to: '    this._pg = null;\n' }],
    cmd: [T_REORDER],
    why: '去掉排序模式的手势闸（第二道保险）',
    red: ['排序模式下不记手势'],
  },
  {
    edits: [{ file: P_WXML, from: '            bindtouchmove="onProgMove"', to: '            catchtouchmove="onProgMove"' }],
    cmd: [T_REORDER],
    why: 'touchmove 改成 catch（卡片底部多一条按着滑不动的死区）',
    red: ['touchmove 必须是 bind'],
  },
  {
    edits: [{ file: P_WXML, from: '            catchtouchstart="onProgStart"', to: '            bindtouchstart="onProgStart"' }],
    cmd: [T_REORDER],
    why: 'touchstart 改成 bind（左滑会从第一帧就启动，抢手手势）',
    red: ['touchstart 绝不能是 bind'],
  },
  {
    edits: [{ file: P_WXML, from: '            catchtap="onProgTap"', to: '            bindtap="onProgTap"' }],
    cmd: [T_REORDER],
    why: '点击屏障改成 bind（拖完松手会顺带弹出编辑抽屉）',
    red: ['catchtap 吸掉点击'],
  },

  /* ============ 页面：样式 ============ */
  {
    edits: [{ file: P_WXSS, from: '  --wt: var(--qc, var(--ink3));', to: '  --wt: var(--ink3);' }],
    cmd: [T_REORDER],
    why: '进度条不再取所属象限色（四条进度条全长一个样）',
    red: ['颜色只有一个入口'],
  },
  {
    edits: [{ file: P_WXSS, from: '  flex: 0 0 68rpx;', to: '  flex: 0 1 auto;' }],
    cmd: [T_REORDER],
    why: '读数不再固定宽（9%→100% 位数一变就把轨道推挤）',
    red: ['读数宽度固定'],
  },
  {
    edits: [
      {
        file: 'miniprogram/app.wxss',
        from: '.wtrack {\n  position: relative;\n  height: 48rpx;',
        to: '.wtrack {\n  position: relative;\n  touch-action: none;\n  height: 48rpx;',
      },
    ],
    cmd: [T_REORDER],
    why: '共享块里加回 touch-action（卡片底部立刻多一条死区）',
    red: ['共享块里没有 touch-action'],
  },

  /* ============ 饮水卡：搬家后不能丢的那条接线 ============ */
  {
    edits: [{ file: W_WXML, from: "    class=\"wtrack {{wdrag ? 'on' : ''}}\"", to: '    class="wtrack"' }],
    cmd: [T_WATER],
    why: '饮水卡丢了抓取反馈的类（搬家到 .wtrack.on 之后）',
    red: ['抓取反馈挂在 .wtrack 上'],
  },

  /* ============ 反向对照：证明测试桩那条 setData 路径支持是承重的 ============ */
  {
    edits: [
      {
        file: T_REORDER,
        from: "      if (k.indexOf('.') >= 0 || k.indexOf('[') >= 0) setPath(p.data, k, patch[k]);\n      else p.data[k] = patch[k];",
        to: '      p.data[k] = patch[k];',
      },
    ],
    cmd: [T_REORDER],
    why: '【反向对照】测试桩退回 Object.assign（不支持数据路径）→ 拖动看着像没生效',
    red: ['横拖到中线 → 读数 50%'],
  },

  /* ============ 对照组：只改注释，不该让任何断言变红 ============ */
  {
    edits: [{ file: P_WXSS, from: '/* ---------------- 事项进度条 ----------------', to: '/* ---------------- 事项进度条（变异对照：只改注释） ----------------' }],
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

console.log('变异验证：事项进度条（云函数耦合 / 页面读口径 / 手势 / 样式复用）\n');

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
