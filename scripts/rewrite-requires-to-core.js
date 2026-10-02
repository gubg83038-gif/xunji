/**
 * 把业务代码里指向 utils/ 算法模块的 require 改写成直接引用 core/
 * 用法：node scripts/rewrite-requires-to-core.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NAMES = ['color.js', 'time.js', 'categories.js', 'locations.js', 'matcher.js', 'vlm.js'];

const DIRS = [
  path.join(ROOT, 'pages'),
  path.join(ROOT, 'components'),
  path.join(ROOT, 'utils'),
  path.join(ROOT, 'mock')
];

function walk(dir, out) {
  const list = out || [];
  if (!fs.existsSync(dir)) return list;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) return;
      walk(full, list);
    } else if (e.name.endsWith('.js')) {
      list.push(full);
    }
  });
  return list;
}

let changedFiles = 0;
let totalHits = 0;

DIRS.forEach((dir) => {
  walk(dir).forEach((file) => {
    const isShim = path.dirname(file) === path.join(ROOT, 'utils') && NAMES.indexOf(path.basename(file)) >= 0;
    if (isShim) return;

    const src = fs.readFileSync(file, 'utf8');
    let next = src;
    let hits = 0;

    NAMES.forEach((name) => {
      // 模块名同时兼容带与不带 .js 的写法（把 .js 变成可选的 .js 后缀）
      const base = name.replace(/\.js$/, '').replace('.', '\\.');
      const re = new RegExp("require\\((['\"])((?:\\.\\./)+|\\./)utils/" + base + "(?:\\.js)?\\1\\)", 'g');
      next = next.replace(re, (m, quote, prefix) => {
        hits += 1;
        return "require(" + quote + prefix + "core/" + name + quote + ")";
      });
    });

    if (hits) {
      fs.writeFileSync(file, next, 'utf8');
      changedFiles += 1;
      totalHits += hits;
      console.log('  ' + path.relative(ROOT, file).replace(/\\/g, '/') + '  (' + hits + ' 处)');
    }
  });
});

console.log('\n共修改 ' + changedFiles + ' 个文件，' + totalHits + ' 处 require');
