// 一次性探针：如果有检查器改成「先剥 WXML 注释再提取」，会不会有文件的提取结果发生变化？
// 只要有一处变化，那个检查器就带着一个「注释能骗过它 / 被注释误伤」的盲区。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function walk(dir, ext, out) {
  out = out || [];
  fs.readdirSync(dir).forEach(function (n) {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, ext, out);
    else if (n.endsWith(ext)) out.push(p);
  });
  return out;
}

const stripComments = function (s) { return s.replace(/<!--[\s\S]*?-->/g, ''); };

// 复制 mp-check / arch-check 的 class 提取口径
function classesOf(src) {
  const out = [];
  const re = /class="([^"]*)"/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[1].replace(/\{\{([^}]*)\}\}/g, function (_, expr) {
      const lits = [];
      const litRe = /'([^']*)'|"([^"]*)"/g;
      let x;
      while ((x = litRe.exec(expr))) lits.push(x[1] !== undefined ? x[1] : x[2]);
      return ' ' + lits.join(' ') + ' ';
    });
    raw.split(/\s+/).forEach(function (c) { if (c) out.push(c); });
  }
  return out.join('|');
}

// 复制 mp-check 的根标识符提取口径
function rootsOf(src) {
  const out = [];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1].trim());
  return out.join('|');
}

let bad = 0;
walk(path.join(ROOT, 'miniprogram'), '.wxml').forEach(function (f) {
  const raw = fs.readFileSync(f, 'utf8');
  const clean = stripComments(raw);
  const rel = path.relative(ROOT, f);
  if (classesOf(raw) !== classesOf(clean)) {
    bad++;
    console.log('【class 提取会被注释影响】' + rel);
  }
  if (rootsOf(raw) !== rootsOf(clean)) {
    bad++;
    console.log('【根标识符提取会被注释影响】' + rel);
  }
});
console.log(bad ? '→ 共 ' + bad + ' 处' : '→ 没有任何文件受影响（可以安全地加剥注释）');
