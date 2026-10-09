// 一次性探针：扫描「页面级单类规则」里是否已存在我准备用的类名。
// 判据与 class-collision.js 的 A 条一致：选择器整串就是一个 .name（无组合器）。
const fs = require('fs');
const p = require('path');

const SEARCH = [
  'd', 'lg', 'l', 'r', 'a', 'b', 'c',
  'cal', 'calwrap', 'monthbar', 'mbtn', 'mv', 'wk', 'days', 'dy', 'num', 'dt', 'i', 'q',
  'sel', 'today', 'other', 'on', 'chev-lg',
  'apcard', 'aphead', 'apico', 'aplabel', 'apdate', 'apbody',
  'pbody', 'pdate',
  'schedwrap', 'schcal', 'schbody', 'dayh', 'dsec', 'minirow',
];

const files = [];
(function walk(d) {
  fs.readdirSync(d).forEach(function (f) {
    const q = p.join(d, f);
    if (fs.statSync(q).isDirectory()) {
      if (f === 'node_modules' || f === '.git') return;
      walk(q);
    } else if (/\.(wxss|wxml)$/.test(f)) {
      files.push(q.split(p.sep).join('/'));
    }
  });
})('miniprogram');

const clean = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const hits = [];

files.filter((f) => /\.wxss$/.test(f)).forEach(function (f) {
  const src = clean(fs.readFileSync(f, 'utf8'));
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(src))) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel || sel.charAt(0) === '@') continue;
    const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    if (!parts.every((x) => /^\.[-_a-zA-Z][\w-]*$/.test(x))) continue;
    const line = src.slice(0, m.index).split('\n').length;
    parts.forEach(function (x) {
      const n = x.slice(1);
      if (SEARCH.indexOf(n) >= 0) hits.push('  .' + n + '  →  ' + f + ':' + line);
    });
  }
});

console.log('=== 已被用作「页面级单类规则」的名字 ===');
console.log(hits.length ? hits.join('\n') : '  （无 —— 这些名字都还空着）');
console.log('');
console.log('扫描文件数：' + files.length + '（wxss ' + files.filter((f) => /\.wxss$/.test(f)).length + '）');
