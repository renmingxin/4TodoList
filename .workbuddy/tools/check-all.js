// 一次跑完所有无 IDE 自检。改了页面或云函数之后，先跑这个再开开发者工具。
//
//   node .workbuddy/tools/check-all.js
//
// 1. mp-check        class / data 契约、结构配对
// 2. class-collision 图标内部 class 与页面级 class 重名
// 3. test-reorder    页面逻辑仿真（拖动 / 左滑 / 排序模式 / 版本握手）
// 4. test-cloudfn    云函数逻辑仿真（拿着假数据库真跑 fqTodo/index.js）
// 5. test-remind     云函数逻辑仿真（真跑 fqRemind/index.js：去重 / 额度 / 模板）
// 6. json            所有 .json 可解析

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const NODE = process.execPath;

const PAGE = 'miniprogram/pages/index';

const steps = [
  {
    name: 'mp-check 静态契约',
    args: ['.workbuddy/tools/mp-check.js', PAGE + '/index.wxml', PAGE + '/index.wxss', PAGE + '/index.js'],
  },
  {
    name: 'class 重名扫描',
    args: [
      '.workbuddy/tools/class-collision.js',
      PAGE + '/index.wxml',
      PAGE + '/index.wxss',
      'miniprogram/app.wxss',
    ],
  },
  { name: '页面逻辑仿真（拖动 / 左滑 / 握手）', args: ['.workbuddy/tools/test-reorder.js'] },
  { name: '云函数逻辑仿真（fqTodo）', args: ['.workbuddy/tools/test-cloudfn.js'] },
  { name: '云函数逻辑仿真（fqRemind 提醒推送）', args: ['.workbuddy/tools/test-remind.js'] },
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
