/**
 * 一次性收敛脚本：消除 utils/ 下的算法层重复副本
 * ---------------------------------------------------------------
 * 背景：
 *   重构时把算法层收敛到了 core/（小程序端与云函数端共享），但 utils/ 下仍留着早期副本。
 *   页面若继续 require utils/locations，会读到旧的演示坐标，新换的真实校区数据就白换了。
 *
 * 本脚本做两件事：
 *   1. 把 utils/ 下的算法文件改成「转发到 core/」的兼容层（旧引用路径仍可用）；
 *   2. 把页面与业务层里指向 utils/ 算法模块的 require 改写成直接引用 core/。
 *
 * 用法：node scripts/dedupe-utils.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const UTILS = path.join(ROOT, 'utils');

/** utils 下需要改为转发层的算法文件 */
const SHIM_FILES = ['color.js', 'time.js', 'categories.js', 'locations.js', 'matcher.js', 'vlm.js'];

function shimContent(name) {
  return [
    '/**',
    ' * 兼容转发层：真正的实现在 core/' + name,
    ' * ---------------------------------------------------------------',
    ' * 项目重构后算法层统一收敛到 core/（小程序端与云函数端共享同一份实现），',
    ' * 这里保留 utils/ 的旧引用路径，避免历史代码与文档中的路径失效。',
    ' *',
    " * 新代码请直接：require('../../core/" + name + "')",
    ' */',
    '',
    "module.exports = require('../core/" + name + "');",
    ''
  ].join('\n');
}

const TARGET_DIRS = [
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

function rewriteRequires(file) {
  const src = fs.readFileSync(file, 'utf8');
  let next = src;
  let hits = 0;

  SHIM_FILES.forEach((name) => {
    const escaped = name.replace('.', '\\.');
    // 匹配 require('<相对路径>utils/<name>')
    const re = new RegExp("require\\((['\"])((?:\\.\\./)+|\\./)utils/" + escaped + "\\1\\)", 'g');
    next = next.replace(re, (m, quote, prefix) => {
      hits += 1;
      return "require(" + quote + prefix + "core/" + name + quote + ")";
    });
  });

  if (hits) fs.writeFileSync(file, next, 'utf8');
  return hits;
}

function main() {
  console.log('1) 生成转发层（utils/<name> → core/<name>）');
  SHIM_FILES.forEach((name) => {
    fs.writeFileSync(path.join(UTILS, name), shimContent(name), 'utf8');
    console.log('   utils/' + name);
  });

  console.log('\n2) 改写业务代码中的 require 指向 core/');
  let total = 0;
  let files = 0;
  TARGET_DIRS.forEach((dir) => {
    walk(dir).forEach((file) => {
      // 转发层自身不改写
      if (path.dirname(file) === UTILS && SHIM_FILES.indexOf(path.basename(file)) >= 0) return;
      const hits = rewriteRequires(file);
      if (hits) {
        files += 1;
        total += hits;
        console.log('   ' + path.relative(ROOT, file).replace(/\\/g, '/') + '  (' + hits + ' 处)');
      }
    });
  });

  console.log('\n完成：' + files + ' 个文件，共改写 ' + total + ' 处 require');
}

main();
