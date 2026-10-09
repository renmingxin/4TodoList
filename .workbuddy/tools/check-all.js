// 一次跑完所有无 IDE 自检。改了页面、组件或云函数之后，先跑这个再开开发者工具。
//
//   node .workbuddy/tools/check-all.js
//
// 1. arch-check      组件化等价性：扁平化 class 序列 + 选择器/声明映射 与基线逐字比对
// 2. event-check     事件接线契约：组件自带 / 页面自带 / 出口闭合 / 取值形状
// 3. component-audit 组件解析：标签注册 / 四个文件齐 / component:true / 标签配平
// 4. mp-check        class 契约（全局）、data 契约（按作用域）、结构配对、固定头部
// 5. class-collision 图标内部 class 与页面级 class 重名
// 6. test-reorder    页面逻辑仿真（拖动 / 左滑 / 排序模式 / 版本握手）
// 7. test-cloudfn    云函数逻辑仿真（拿着假数据库真跑 fqTodo/index.js）
// 8. test-remind     云函数逻辑仿真（真跑 fqRemind/index.js：去重 / 额度 / 模板）
// 9. test-water      今日饮水逻辑仿真（吸附 / 夹紧 / 事件时机 / 跨天清零）
// 10. test-sched     日程逻辑仿真（月历 42 格 / 跨月 / 圆点 / 计划取存）
// 11. json           所有 .json 可解析
//
// ⚠️ 第 9 步也是一个盲区补丁：饮水是**第一个完全不依赖云端**的功能，
//    不进 fqTodo 的 action 体系 —— 上面三个仿真一个都盖不到它。
//
// ⚠️ 第 10 步同理：日程的日期运算是**纯函数**（42 格怎么排 / 跨月怎么进位 /
//    「今天-明天」怎么随选中日变），全在 utils/format.js 里，页面仿真与云函数仿真都盖不到；
//    而它错一天是**不报错**的 —— 只会安静地显示错的日子。
//
// ⚠️ 第 2、3 步都是补上的，补的理由是同一条：
//    组件化把 WXML **逐字搬走**，于是「搬得对不对」这件事被拆成了两层，
//    而原有的检查一层都没盖住 ——
//      第 2 步：js 是手写的，方法名与搬来的 WXML 对不上 → 5 个点了没反应的按钮；
//      第 3 步：标签没注册 / 切片把标签切坏 → 一整个区块安静地变空白。
//    两者都不报错、都不影响 arch-check 与逻辑仿真。凡是「新增一类文件 / 加一层
//    间接」的重构，都要问一句「哪条既有检查现在成了盲区」。
//
// 组件化之后路径不再写死：进化的方式是「多一个组件目录」，不是「多一行硬编码」。
// 所以下面的路径一旦不存在就跳过，而目录交给工具自己去递归展开。

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const NODE = process.execPath;

const PAGE = 'miniprogram/pages/index';
const COMPONENTS = 'miniprogram/components';
const APP_WXSS = 'miniprogram/app.wxss';

const exists = function (p) {
  return fs.existsSync(path.join(ROOT, p));
};
// 候选路径里存在的那几个（components 目录可能还没建）
const some = function (list) {
  return list.filter(exists);
};
const MP_ARGS = ['miniprogram/pages/index', 'miniprogram/components', 'miniprogram/app.wxss'];

// ⚠️ 依赖路径的步骤用 paths 声明依赖，而不是靠「命令行参数够不够多」来猜。
// 曾经写成 `if (s.args.length < 2) return;` —— 结果把只传一个脚本路径的
// 三个逻辑仿真步骤也一起跳过了：校验器把测试静默关掉，出的绿灯比红灯还危险。
const steps = [
  { name: '重构等价性（arch-check）', args: ['.workbuddy/tools/arch-check.js', 'verify'] },
  { name: '事件接线契约（event-check）', paths: [PAGE], args: ['.workbuddy/tools/event-check.js'] },
  { name: '组件解析审计（component-audit）', paths: [PAGE], args: ['.workbuddy/tools/component-audit.js'] },
  {
    name: 'mp-check 静态契约',
    paths: [PAGE, APP_WXSS],
    args: ['.workbuddy/tools/mp-check.js'].concat(some(MP_ARGS)),
  },
  {
    name: 'class 重名扫描',
    paths: [PAGE, APP_WXSS],
    args: ['.workbuddy/tools/class-collision.js'].concat(some(MP_ARGS)),
  },
  { name: '页面逻辑仿真（拖动 / 左滑 / 握手）', args: ['.workbuddy/tools/test-reorder.js'] },
  { name: '云函数逻辑仿真（fqTodo）', args: ['.workbuddy/tools/test-cloudfn.js'] },
  { name: '云函数逻辑仿真（fqRemind 提醒推送）', args: ['.workbuddy/tools/test-remind.js'] },
  { name: '今日饮水逻辑仿真（吸附 / 夹紧 / 事件时机）', args: ['.workbuddy/tools/test-water.js'] },
  { name: '日程逻辑仿真（月历 42 格 / 跨月 / 圆点 / 计划）', args: ['.workbuddy/tools/test-sched.js'] },
];

let failed = 0;

function run(label, fn) {
  process.stdout.write('\n=== ' + label + ' ===\n');
  try {
    const out = fn();
    if (out) process.stdout.write(out);
  } catch (err) {
    failed++;
    const out = (err.stdout || '') + (err.stderr || '');
    process.stdout.write(out);
    process.stdout.write('  → 未通过（退出码 ' + (err.status === undefined ? '?' : err.status) + '）\n');
  }
}

steps.forEach(function (s) {
  if (s.paths && !s.paths.every(exists)) {
    process.stdout.write('\n=== ' + s.name + ' ===\n  （依赖的路径不存在，跳过）\n');
    return;
  }
  run(s.name, function () {
    return execFileSync(NODE, s.args, { cwd: ROOT, encoding: 'utf8' });
  });
});

run('JSON 可解析', function () {
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      if (f === 'node_modules' || f === '.git') continue;
      const q = path.join(d, f);
      // .workbuddy/tmp 是脚手架/快照的草稿区，不当作项目产物来校验
      if (path.relative(ROOT, q) === path.join('.workbuddy', 'tmp')) continue;
      if (fs.statSync(q).isDirectory()) walk(q);
      else if (f.endsWith('.json')) files.push(q);
    }
  })(ROOT);

  const bad = [];
  for (const f of files) {
    try {
      JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      bad.push(path.relative(ROOT, f) + ' → ' + e.message);
      failed++;
    }
  }
  return bad.length
    ? '  ✗ ' + bad.join('\n  ✗ ') + '\n'
    : '  OK —— ' + files.length + ' 个全部合法\n';
});

console.log('\n========================================');
console.log(failed ? '✗ 有 ' + failed + ' 项未通过' : '✓ 全部通过');
process.exit(failed ? 1 : 0);
