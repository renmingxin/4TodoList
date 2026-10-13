// 变异验证：v8「可配置的提前提醒时长」
//
// 纪律（见 MEMORY.md §三·③）：新增检查的顺序不能反 ——
//   ① 先跑基线确认绿；② 再逐条做变异确认会红。
// **永远绿的测试等于没有测试。**
//
// 每条变异都必须能说出「该由哪条断言拦住」。跑不红的变异只有两种可能：
//   要么断言没守住东西，要么断言自己写错了 —— 后一种实测抓到过，别默认是前者。
// 最后一条是**对照组**：只改注释，必须保持绿。它证明红是变异带来的，
// 而不是被别的因素搞红的。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const NODE = process.execPath;
const TOOLS = path.join(ROOT, '.workbuddy', 'tools');

const TODO = path.join(ROOT, 'cloudfunctions/fqTodo/index.js');
const REMIND = path.join(ROOT, 'cloudfunctions/fqRemind/index.js');
const PAGE = path.join(ROOT, 'miniprogram/pages/index/index.js');
const CONSTJS = path.join(ROOT, 'miniprogram/utils/const.js');
const FAKE = path.join(TOOLS, 'fake-cloud.js');

const MUTATIONS = [
  // ---- fqTodo：白名单与换算 ----
  {
    name: '脏值回落到 -1（「不提醒」）而不是默认 30',
    file: TODO,
    from: '  return LEAD_ALLOWED.indexOf(n) >= 0 ? n : LEAD_DEFAULT;',
    to: '  return LEAD_ALLOWED.indexOf(n) >= 0 ? n : -1;',
    test: 'test-cloudfn.js',
    why: '一个脏值就会把提醒静默关掉 —— 整条改造里最危险的回落方向',
  },
  {
    name: 'toPushAt 忘了处理「不提醒」哨兵',
    file: TODO,
    from: '  if (leadMin === -1) return null;',
    to: '  if (false) return null;',
    test: 'test-cloudfn.js',
    why: '选了不提醒却仍然算出 pushAt → 到点照样推一条',
  },
  {
    name: 'pushAt 算反了方向（提醒时间 + 提前量）',
    file: TODO,
    from: '  return at - leadMin * 60000;',
    to: '  return at + leadMin * 60000;',
    test: 'test-cloudfn.js',
    why: '提前 30 分钟会变成「延后 30 分钟」，且提前档位越大越晚',
  },
  {
    name: '只改提前量时不复位推送状态',
    file: TODO,
    from: '    if (oldAt !== nextAt || oldLead !== nextLead) {',
    to: '    if (false) {',
    test: 'test-cloudfn.js',
    why: '改完提前量那条已经推过的提醒不会再排进队列，等于改了没用',
  },
  {
    name: '老数据没有 leadMin 时不按默认值补齐（落成 null）',
    file: TODO,
    from: '    const oldLead = oldAt === null ? null : toLead(old.leadMin);',
    to: '    const oldLead = oldAt === null ? null : null;',
    test: 'test-cloudfn.js',
    why: '用户只改个标题，就会因为「提前量从 30 变成 null」白白复位推送状态',
  },
  {
    name: 'addItem 不落客户端给的 leadMin（一律写默认档）',
    file: TODO,
    from: '      leadMin: leadMin,',
    to: '      leadMin: LEAD_DEFAULT,',
    test: 'test-cloudfn.js',
    why: '界面上选什么档都无效，全落成 30 分钟',
  },

  // ---- fqRemind：扫描与回填 ----
  {
    name: '扫描条件退回 remindAt（放弃逐条提前量）',
    file: REMIND,
    from: '        pushAt: _.and(_.gt(0), _.lte(now)),',
    to: '        remindAt: _.and(_.gt(0), _.lte(now)),',
    test: 'test-remind.js',
    why: '提前量彻底失效：所有提醒都按「提醒时间」到点才发',
  },
  {
    name: '到期判据退回 remindAt',
    file: REMIND,
    from: '    const at = Number(it.pushAt);',
    to: '    const at = Number(it.remindAt);',
    test: 'test-remind.js',
    why: '「提前 30 天」的事项会被判成「还没到期」，永远静默不发',
  },
  {
    name: '排序退回 remindAt',
    file: REMIND,
    from: "      .orderBy('pushAt', 'asc')",
    to: "      .orderBy('remindAt', 'asc')",
    test: 'test-remind.js',
    why: '额度有限时，先扣给谁变成了「谁的提醒时间早」而非「谁先该发」',
  },
  // ⚠️ 曾经想加一条「回填判据从 leadMin 改成 pushAt」的变异，跑出来是**绿的**，
  // 查证后发现它本来就区分不了，不是断言没守住：
  //   判据只影响「挑哪些文档」。新数据的 pushAt 要么是数字、要么是 null，
  //   字段都在；老数据两个字段都缺。两种判据挑出的是同一批文档，
  //   差异只出现在「值为 null 的字段会不会被容器当成缺失」这种平台行为上 ——
  //   那不是本地假 SDK 能如实模拟的东西。
  // 与其留一条永远绿的假守卫，不如把结论写在这里：用 leadMin 作判据是**更严谨**
  // 的选择（它和 pushAt 同生同灭，不受空值语义影响），但别声称测试守住了它。
  {
    name: '不执行老数据回填',
    file: REMIND,
    from: '  const backfilled = await backfillPushAt();',
    to: '  const backfilled = 0;',
    test: 'test-remind.js',
    why: '升级之后存量提醒一条都挑不到，而且一点报错都没有',
  },

  // ---- 客户端 ----
  {
    name: '选了「不提醒」仍然请求订阅授权',
    file: PAGE,
    from: '    if (remindAt && leadMin !== -1) this.askSubscribe();',
    to: '    if (remindAt) this.askSubscribe();',
    test: 'test-reorder.js',
    why: '用户明说不要通知，还弹订阅框 —— 骚扰且不符合「订阅要有真实触发场景」',
  },
  {
    name: '保存时不把 leadMin 送给云函数',
    file: PAGE,
    from: '      leadMin: leadMin,',
    to: '      leadMin: null,',
    test: 'test-reorder.js',
    why: '云函数拿不到档位，全部回落默认 30 分钟',
  },
  {
    name: '编辑保存后不更新本地镜像的 leadMin',
    file: PAGE,
    from: '          it.leadMin = payload.leadMin;',
    to: '          it.leadMin = LEAD_DEFAULT;',
    test: 'test-reorder.js',
    why: '落库那一份是对的，但镜像没跟着走 —— 重开抽屉就变回默认档。' +
      '这个现象与「云端还是旧包」长得一模一样，正是这条断言要分开的两个成因',
  },
  {
    name: '新建后镜像里那条漏掉 leadMin',
    file: PAGE,
    from: '            leadMin: payload.leadMin,\n',
    to: '',
    test: 'test-reorder.js',
    why: '刚建好马上点进去改会看到默认档。这一条只有静态断言守着 —— ' +
      'addItem 的镜像是在 promise 的 then 里写的，而本文件的结算点在 [19] 的链尾，' +
      '写在 then 里的断言根本轮不到执行（那会是一条**假装在测**的断言）',
  },
  {
    name: '客户端枚举漏掉「提前 3 小时」',
    file: CONSTJS,
    from: "  { v: 180, label: '提前 3 小时' },\n",
    to: '',
    test: 'test-remind.js',
    why: '三份白名单漂移：界面少了这一档，云端还认它',
  },
  {
    name: '默认提前量改成 10 分钟',
    file: CONSTJS,
    from: 'const LEAD_DEFAULT = 30;',
    to: 'const LEAD_DEFAULT = 10;',
    test: 'test-remind.js',
    why: '两端默认值不一致，新事项在界面显示 30、云端按 10 落库',
  },
  {
    name: 'fqRemind 的白名单与 fqTodo 不一致',
    file: REMIND,
    from: 'const LEAD_ALLOWED = [-1, 5, 10, 30, 60, 180, 1440, 4320, 10080, 43200];',
    to: 'const LEAD_ALLOWED = [-1, 5, 10, 20, 60, 180, 1440, 4320, 10080, 43200];',
    test: 'test-remind.js',
    why: '回填时按 20 分钟算，而 fqTodo 记的是 30 —— 同一批数据两边算出不同时刻',
  },

  // ---- 假 SDK 本身 ----
  {
    name: '假 SDK 不支持 _.exists（回填判据失效）',
    file: FAKE,
    from: '    if (cond.__exists !== undefined) return !!has === cond.__exists;\n',
    to: '',
    test: 'test-remind.js',
    why: '假 SDK 与真库语义漂移，回填用例会「挑不到而假装通过」',
  },

  // ---- 对照组：只改注释，必须保持绿 ----
  {
    name: '[对照组] 只改一句注释',
    file: TODO,
    from: '// 提前量净化：白名单之外的（undefined / null / NaN / 字符串 / 小数）',
    to: '// 提前量净化（注释改动，不该影响任何断言）：白名单之外的（undefined / null / NaN / 字符串 / 小数）',
    test: 'test-cloudfn.js',
    control: true,
    why: '它不该红。红了说明测试是被别的东西搞红的，这一整轮结果都不可信',
  },
];

function runTest(name) {
  try {
    execFileSync(NODE, [path.join(TOOLS, name)], { stdio: 'pipe' });
    return true; // 绿
  } catch (e) {
    return false; // 红
  }
}

function applyAndRun(m) {
  const orig = fs.readFileSync(m.file, 'utf8');
  if (orig.indexOf(m.from) < 0) {
    throw new Error('变异锚点找不到（源码改过了？）: ' + m.name);
  }
  const patched = orig.replace(m.from, m.to);
  if (patched === orig) {
    throw new Error('变异没有生效: ' + m.name);
  }
  fs.writeFileSync(m.file, patched);
  try {
    return runTest(m.test);
  } finally {
    fs.writeFileSync(m.file, orig);
  }
}

(function main() {
  console.log('=== 基线 ===');
  const basePass = ['test-cloudfn.js', 'test-remind.js', 'test-reorder.js'].every(function (t) {
    const g = runTest(t);
    console.log((g ? '  ✓ ' : '  ✗ ') + t + (g ? ' 绿' : ' 红（基线就不该红！）'));
    return g;
  });
  if (!basePass) {
    console.error('\n基线不是绿的，先修好再来做变异。');
    process.exit(1);
  }

  console.log('\n=== 逐条变异 ===');
  let good = 0;
  let bad = 0;
  const failures = [];

  MUTATIONS.forEach(function (m) {
    let green;
    try {
      green = applyAndRun(m);
    } catch (e) {
      console.log('  ⚠ ' + m.name + '\n      ' + e.message);
      bad++;
      failures.push(m.name + '（变异没跑起来）');
      return;
    }
    const want = m.control ? green : !green;
    if (want) {
      good++;
      console.log('  ✓ ' + m.name + (m.control ? '  → 保持绿' : '  → 变红'));
    } else {
      bad++;
      console.log('  ✗ ' + m.name + '  → ' + (green ? '仍然绿（没守住）' : '意外变红'));
      console.log('      为什么该被拦住：' + m.why);
      failures.push(m.name);
    }
  });

  console.log('\n----------------------------------------');
  console.log('变异 ' + good + ' / ' + MUTATIONS.length + ' 条符合预期');
  if (failures.length) {
    console.log('不符合预期的：');
    failures.forEach(function (f) {
      console.log('  · ' + f);
    });
    process.exit(1);
  }
  console.log('✓ 全部符合预期（红的红得其所 + 对照组保持绿）');
})();
