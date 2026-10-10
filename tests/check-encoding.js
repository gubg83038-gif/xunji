/** 项目自包含的 UTF-8、JS 语法及 JSON 检查。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { TextDecoder } = require('util');
const root = path.resolve(__dirname, '..');
let checked = 0;
function walk(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(file);
    if (!/\.(js|json|wxml|wxss|md)$/.test(file)) return;
    const src = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    if (src.includes('\uFFFD') || fs.readFileSync(file).subarray(0, 3).equals(Buffer.from([239, 187, 191])))
      throw new Error('编码损坏或包含 BOM：' + file);
    if (file.endsWith('.js')) new vm.Script(src, { filename: file });
    if (file.endsWith('.json')) JSON.parse(src);
    checked += 1;
  });
}
walk(root);
console.log('✓ UTF-8 / JS / JSON 检查通过：' + checked + ' 个文件');
