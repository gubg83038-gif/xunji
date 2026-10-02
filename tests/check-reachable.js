/**
 * 小程序端模块可达性检查
 * ---------------------------------------------------------------
 *   node tests/check-reachable.js
 *
 * 背景（真实事故，导致全部页面白屏）：
 *   app.js → utils/service.js → core/domain.js → core/ai/embed.js
 *   而 core/ai/embed.js 顶部写着 require('https') / require('http') / require('url')——
 *   这些是 Node.js 内置模块，**小程序环境根本不存在**。
 *
 *   结果是 App 加载失败 → onLaunch 不执行 → 所有页面白屏。
 *   而且这类错误在 Node 里跑测试完全正常（Node 有这些模块），
 *   只有真机 / 开发者工具才会炸。所以必须专门检查。
 *
 * 检查方式：
 *   1. 从 app.js 出发，静态解析所有 require()，走出完整依赖图
 *   2. 逐个判断目标是否是 Node 内置模块 / npm 包 / 不存在的路径
 *   3. 同时检查模块顶层是否使用了 Node 专有全局量（process / Buffer / __dirname 等）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** Node 内置模块：小程序里一律不可用 */
const NODE_BUILTINS = [
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys',
  'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib'
];

/** 小程序里不存在的 Node 全局量（顶层使用会导致加载失败） */
const NODE_GLOBALS = ['process', 'Buffer', '__dirname', '__filename', 'global', 'require.resolve'];

const problems = [];
const lazy = [];
const graph = new Map();
let scanned = 0;

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

/**
 * 解析 require('x') 里的模块名，并区分「模块顶层」与「函数内部」。
 *
 * 只有顶层 require 才会在模块加载时执行——那才是致命的。
 * 写在函数内部的惰性 require（例如 loadNodeHttp()）在 Node 上按需加载、
 * 在小程序里根本不会执行到，是**安全且推荐的**写法。
 *
 * @returns {Array<{name:string, line:number, topLevel:boolean}>}
 */
function extractRequires(src) {
  const out = [];
  const lines = src.split('\n');
  let inBlockComment = false;
  let depth = 0;

  lines.forEach((rawLine, i) => {
    let line = rawLine;

    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end < 0) return;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    if (line.indexOf('/*') >= 0) {
      const s = line.indexOf('/*');
      const e = line.indexOf('*/', s);
      if (e < 0) { line = line.slice(0, s); inBlockComment = true; }
      else line = line.slice(0, s) + line.slice(e + 2);
    }
    line = line.replace(/\/\/.*$/, '');

    const depthAtLineStart = depth;

    const re = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      out.push({ name: m[2], line: i + 1, topLevel: depthAtLineStart === 0 });
    }

    for (let k = 0; k < line.length; k += 1) {
      if (line[k] === '{') depth += 1;
      else if (line[k] === '}') depth -= 1;
    }
    if (depth < 0) depth = 0;
  });

  return out;
}

/** 判断一个模块名是否是 Node 内置 */
function builtinName(name) {
  if (NODE_BUILTINS.indexOf(name) >= 0) return name;
  if (name.indexOf('node:') === 0) return name.slice(5);
  return null;
}

/** 解析相对路径 require 到真实文件 */
function resolveRelative(fromFile, name) {
  const base = path.resolve(path.dirname(fromFile), name);
  const candidates = [base, base + '.js', path.join(base, 'index.js')];
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * 检查 Node 专有全局量。
 *
 * 只有「模块顶层就求值」的用法才会导致加载失败——
 * 例如 `const x = process.env.A` 或 `Buffer.byteLength(...)` 写在函数外。
 * 写在函数体内部是安全的（那些分支在小程序里根本不会执行到）。
 *
 * 因此这里跟踪花括号深度，只报告深度为 0（顶层）的使用，
 * 并跳过注释与字符串。
 */
function scanGlobals(src, file) {
  const lines = src.split('\n');
  let depth = 0;
  let inBlockComment = false;

  lines.forEach((rawLine, i) => {
    let line = rawLine;

    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end < 0) return;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    // 去掉块注释与行注释，避免注释里的词被当成代码
    if (line.indexOf('/*') >= 0) {
      const s = line.indexOf('/*');
      const e = line.indexOf('*/', s);
      if (e < 0) { line = line.slice(0, s); inBlockComment = true; }
      else line = line.slice(0, s) + line.slice(e + 2);
    }
    line = line.replace(/\/\/.*$/, '');
    // 去掉字符串字面量，避免 'process' 这类文本误报
    const code = line.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');

    const depthAtLineStart = depth;

    // 先统计本行的括号变化
    let delta = 0;
    for (let k = 0; k < code.length; k += 1) {
      if (code[k] === '{') delta += 1;
      else if (code[k] === '}') delta -= 1;
    }

    // 顶层（进入本行时深度为 0）才检查
    if (depthAtLineStart === 0) {
      NODE_GLOBALS.forEach((g) => {
        const re = new RegExp('(?<![\\w$.])' + g.replace('.', '\\.') + '(?![\\w$])');
        if (re.test(code)) {
          problems.push({
            type: 'Node 全局量',
            file: rel(file),
            line: i + 1,
            detail: '模块顶层使用 `' + g + '`，小程序环境不存在此全局量，会导致加载失败：' +
              code.trim().slice(0, 80)
          });
        }
      });
    }

    depth += delta;
    if (depth < 0) depth = 0;
  });
}

/** 从入口出发遍历依赖图 */
function walk(file, from) {
  if (graph.has(file)) return;
  const src = fs.readFileSync(file, 'utf8');
  scanned += 1;
  graph.set(file, from || null);

  scanGlobals(src, file);

  extractRequires(src).forEach((r) => {
    const b = builtinName(r.name);
    if (b) {
      // 惰性 require（函数内）是安全的：小程序里不会执行到那一行
      if (!r.topLevel) {
        lazy.push({ file: rel(file), line: r.line, name: r.name });
        return;
      }
      problems.push({
        type: 'Node 内置模块',
        file: rel(file),
        line: r.line,
        detail: 'require(\'' + r.name + '\') 在小程序环境不存在，会导致本模块加载失败' +
          (from ? '（由 ' + rel(from) + ' 间接引入）' : '')
      });
      return;
    }
    if (r.name.charAt(0) === '.') {
      const target = resolveRelative(file, r.name);
      if (!target) {
        problems.push({
          type: '路径不存在',
          file: rel(file),
          line: r.line,
          detail: 'require(\'' + r.name + '\') 找不到对应文件'
        });
        return;
      }
      if (target.indexOf(ROOT) !== 0) return;
      walk(target, file);
      return;
    }
    // npm 包：小程序需要 npm 构建，这里只提示（惰性加载同样只提示）
    problems.push({
      type: '第三方依赖',
      file: rel(file),
      line: r.line,
      detail: 'require(\'' + r.name + '\') 是 npm 包，小程序端需先「构建 npm」，否则运行时报错'
    });
  });
}

/* ===================== 执行 ===================== */

console.log('小程序端模块可达性检查');
console.log('入口：app.js');

walk(path.join(ROOT, 'app.js'), null);

console.log('· 可达模块：' + scanned + ' 个');
if (lazy.length) {
  console.log('· 惰性 require 的 Node 内置模块：' + lazy.length + ' 处（安全，小程序不会执行到）');
  const byFile = {};
  lazy.forEach((l) => { byFile[l.file] = (byFile[l.file] || 0) + 1; });
  Object.keys(byFile).forEach((f) => console.log('    · ' + f + '：' + byFile[f] + ' 处'));
}
console.log('');

if (!problems.length) {
  console.log('✓ 依赖图内没有 Node 专有模块或全局量，小程序端可正常加载');
  process.exit(0);
}

// Node 内置模块 / 全局量 = 致命；第三方依赖 = 提示
const fatal = problems.filter((p) => p.type !== '第三方依赖');
const soft = problems.filter((p) => p.type === '第三方依赖');

if (soft.length) {
  console.log('提示（' + soft.length + '）：');
  soft.forEach((p) => console.log('  ! ' + p.file + ':' + p.line + '  ' + p.detail));
}

if (fatal.length) {
  console.log('致命问题（' + fatal.length + '）—— 小程序加载时会直接失败（表现：页面全部白屏）：');
  fatal.forEach((p) => {
    console.log('  ✗ [' + p.type + '] ' + p.file + ':' + p.line);
    console.log('      ' + p.detail);
  });
  console.log('\n修复方向：把 Node 专有代码挪进函数内惰性 require，或移到云函数端。');
  process.exit(1);
}

console.log('\n（无致命问题）');
