/**
 * 校正演示主线（found_cup_01）的发现地点。
 * 目标：让「图书馆丢失 → 附近拾到」的距离落在 100—200 m 区间，
 *      与方案 16.1 的演示脚本（“距离最后丢失地点约 120 m”）一致。
 *
 * 用法：node scripts/fix-demo-pair.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = [
  path.join(ROOT, 'core', 'seed-data.js'),
  path.join(ROOT, 'mock', 'seed.js')
];

const TARGET = "locationId: 'xuehai_stone',";

function patch(file, anchorId) {
  let src = fs.readFileSync(file, 'utf8');
  const anchor = "id: '" + anchorId + "'";
  const start = src.indexOf(anchor);
  if (start < 0) {
    console.log('  未找到 ' + anchorId + '，跳过');
    return 0;
  }
  const keyAt = src.indexOf('locationId:', start);
  if (keyAt < 0) return 0;
  const lineEnd = src.indexOf('\n', keyAt);
  const current = src.slice(keyAt, lineEnd).trim();
  if (current === TARGET) {
    console.log('  已是目标值，无需修改');
    return 0;
  }
  src = src.slice(0, keyAt) + TARGET + src.slice(lineEnd);
  fs.writeFileSync(file, src, 'utf8');
  console.log('  ' + current + '  →  ' + TARGET);
  return 1;
}

function main() {
  let changed = 0;
  FILES.forEach((file) => {
    console.log(path.relative(ROOT, file).replace(/\\/g, '/'));
    changed += patch(file, 'found_cup_01');
  });
  console.log(changed ? '\n已更新，请执行：node scripts/sync-core.js' : '\n无需修改');
}

main();
