/**
 * 把各页面 wxss 里的硬编码设计值替换为 app.wxss 的设计令牌
 * ---------------------------------------------------------------
 * 用法：node scripts/tokenize-styles.js [--dry]
 *
 * 为什么用脚本而不是手改：
 *   9 个页面 wxss 里有大量重复的硬编码圆角与颜色，手改既慢又容易漏。
 *   脚本化后可以反复执行（幂等），也便于日后统一调整。
 *
 * 只替换「值与原令牌语义完全一致」的项，不做主观改色——
 * 换色是设计决策，应由人明确指定，不在这里偷偷改。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.indexOf('--dry') >= 0;

/** 圆角映射：旧硬编码值 → 令牌（就近归入，保持视觉接近） */
const RADIUS_MAP = [
  [/\bborder-radius:\s*(?:8|10|12|14|16)rpx\b/g, 'border-radius: var(--r-sm)'],
  [/\bborder-radius:\s*(?:18|20|22|24)rpx\b/g, 'border-radius: var(--r-md)'],
  [/\bborder-radius:\s*(?:28|30|32|36)rpx\b/g, 'border-radius: var(--r-lg)'],
  [/\bborder-radius:\s*(?:40|44|48)rpx\b/g, 'border-radius: var(--r-xl)'],
  [/\bborder-radius:\s*(?:999|9999)rpx\b/g, 'border-radius: var(--r-pill)'],
  /* 已经处理过的令牌形式，避免重复替换（幂等保护） */
  [/\bborder-radius:\s*var\(--r-sm\)/g, 'border-radius: var(--r-sm)']
];

/** 颜色映射：只替换与令牌完全同值的硬编码 */
const COLOR_MAP = [
  [/#2e6be6\b/gi, 'var(--c-primary)'],
  [/#1b47a8\b/gi, 'var(--c-primary-deep)'],
  [/#eaf1ff\b/gi, 'var(--c-primary-weak)'],
  [/#98a2b3\b/gi, 'var(--c-ink-3)'],
  [/#475467\b/gi, 'var(--c-ink-2)'],
  [/#101828\b/gi, 'var(--c-ink)'],
  [/#eaecf0\b/gi, 'var(--c-line)'],
  [/#f04438\b/gi, 'var(--c-danger)'],
  [/#12b76a\b/gi, 'var(--c-success)'],
  [/#f59e0b\b/gi, 'var(--c-warn)']
];

/** 不处理的文件：app.wxss 本身是令牌定义处 */
const SKIP = ['app.wxss'];

function targets() {
  const out = [];
  const push = (dir) => {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) push(full);
      else if (e.name.endsWith('.wxss') && SKIP.indexOf(e.name) < 0) out.push(full);
    });
  };
  push(path.join(ROOT, 'pages'));
  push(path.join(ROOT, 'components'));
  return out;
}

let totalFiles = 0;
let totalHits = 0;

targets().forEach((file) => {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  let hits = 0;

  const apply = (map) => {
    map.forEach((pair) => {
      const re = pair[0];
      const global = new RegExp(re.source, re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g');
      const found = after.match(global);
      if (found) {
        hits += found.length;
        after = after.replace(global, pair[1]);
      }
    });
  };

  apply(RADIUS_MAP);
  apply(COLOR_MAP);

  if (after !== before) {
    totalFiles += 1;
    totalHits += hits;
    console.log('  ' + rel + '  → ' + hits + ' 处');
    if (!DRY) fs.writeFileSync(file, after, 'utf8');
  }
});

console.log('');
console.log((DRY ? '[试运行] ' : '') + '处理 ' + totalFiles + ' 个文件，共 ' + totalHits + ' 处替换');
if (DRY) console.log('（未写入，去掉 --dry 才生效）');
