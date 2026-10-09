// 找出「剥掉注释后消失」的那些 {{...}} 表达式 —— 它们就是被注释误伤的那些。
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');

const files = [
  'miniprogram/components/fq-fab/fq-fab.wxml',
  'miniprogram/pages/index/index.wxml',
];

function exprs(src) {
  const out = [];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1].trim());
  return out;
}

files.forEach(function (f) {
  const raw = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const clean = raw.replace(/<!--[\s\S]*?-->/g, '');
  const a = exprs(raw);
  const b = exprs(clean);
  const setB = {};
  b.forEach(function (x) { setB[x] = (setB[x] || 0) + 1; });
  const only = [];
  a.forEach(function (x) {
    if (setB[x]) setB[x]--;
    else only.push(x);
  });
  console.log('=== ' + f);
  console.log('   只在注释里的表达式：' + JSON.stringify(only));
});
