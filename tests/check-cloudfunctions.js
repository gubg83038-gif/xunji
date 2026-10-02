/**
 * 云函数端静态校验 + 需要的模块可达性检查
 *
 *   node tests/check-cloudfunctions.js
 *
 * 微信云开发的部署方式是「上传整个云函数目录」，因此最容易出错的地方是：
 *   1. 云函数目录里缺少它 require 的 core/ 文件（忘了跑 scripts/sync-core.js）
 *   2. require 路径写错（多一层或少一层 ../）
 *   3. function 目录里多出了不该上传的东西
 *
 * 本脚本不依赖 wx-server-sdk，通过静态解析 require 调用即可发现上述问题。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLOUD_DIR = path.join(ROOT, 'cloudfunctions');
const CORE_DIR = path.join(ROOT, 'core');

let errors = [];
let warnings = [];
let checked = 0;

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

function walk(dir, ext, out) {
  const list = out || [];
  if (!fs.existsSync(dir)) return list;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) return;
      walk(full, ext, list);
    } else if (e.name.endsWith(ext)) {
      list.push(full);
    }
  });
  return list;
}

/** 解析一个 JS 文件里的 require('...') 字面量 */
function parseRequires(src) {
  const out = [];
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

function resolveRequire(fromFile, request) {
  if (request.charAt(0) !== '.') return { external: true, ok: true };
  const base = path.resolve(path.dirname(fromFile), request);
  const candidates = [base, base + '.js', base + '.json', path.join(base, 'index.js')];
  const hit = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
  return { external: false, ok: !!hit, resolved: hit };
}

/* ---------------- 1. 云函数目录结构 ---------------- */

if (!fs.existsSync(CLOUD_DIR)) {
  console.error('未找到 cloudfunctions/ 目录');
  process.exit(1);
}

const functions = fs.readdirSync(CLOUD_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
  .map((e) => e.name);

functions.forEach((fn) => {
  checked += 1;
  const dir = path.join(CLOUD_DIR, fn);
  const indexFile = path.join(dir, 'index.js');
  const pkgFile = path.join(dir, 'package.json');

  if (!fs.existsSync(indexFile)) errors.push('云函数 ' + fn + ' 缺少 index.js（云函数入口必须是 index.js）');
  if (!fs.existsSync(pkgFile)) {
    errors.push('云函数 ' + fn + ' 缺少 package.json（云开发依赖它安装 wx-server-sdk）');
  } else {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      if (!pkg.dependencies || !pkg.dependencies['wx-server-sdk']) {
        errors.push('云函数 ' + fn + ' 的 package.json 未声明 wx-server-sdk 依赖');
      }
    } catch (e) {
      errors.push('云函数 ' + fn + ' 的 package.json 解析失败：' + e.message);
    }
  }

  const coreDir = path.join(dir, 'core');
  if (!fs.existsSync(coreDir)) {
    errors.push('云函数 ' + fn + ' 缺少 core/ 目录，请先执行：node scripts/sync-core.js');
  }
});

/* ---------------- 2. require 可达性 ---------------- */

const cloudJs = [];
functions.forEach((fn) => walk(path.join(CLOUD_DIR, fn), '.js', cloudJs));

cloudJs.forEach((file) => {
  const src = fs.readFileSync(file, 'utf8');
  parseRequires(src).forEach((req) => {
    checked += 1;
    const r = resolveRequire(file, req);
    if (r.external || r.ok) return;
    if (req === 'wx-server-sdk') return;
    errors.push('require 无法解析：' + rel(file) + ' → ' + req);
  });
});

/* ---------------- 3. core 同步一致性 ---------------- */

const SYNC_SCRIPT = path.join(ROOT, 'scripts', 'sync-core.js');
if (!fs.existsSync(SYNC_SCRIPT)) {
  errors.push('缺少 scripts/sync-core.js（用于把 core/ 同步到各云函数）');
} else {
  const syncSrc = fs.readFileSync(SYNC_SCRIPT, 'utf8');
  const listMatch = syncSrc.match(/const SHARED_FILES = \[([\s\S]*?)\];/);
  const shared = listMatch
    ? (listMatch[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, ''))
    : [];

  if (!shared.length) errors.push('scripts/sync-core.js 的 SHARED_FILES 列表为空');

  shared.forEach((relPath) => {
    checked += 1;
    const source = path.join(CORE_DIR, relPath);
    if (!fs.existsSync(source)) {
      errors.push('SHARED_FILES 声明的文件不存在：core/' + relPath);
      return;
    }
    functions.forEach((fn) => {
      const target = path.join(CLOUD_DIR, fn, 'core', relPath);
      if (!fs.existsSync(target)) {
        errors.push('云函数 ' + fn + ' 缺少 core/' + relPath + '，请重新执行：node scripts/sync-core.js');
        return;
      }
      const a = fs.readFileSync(source, 'utf8');
      const b = fs.readFileSync(target, 'utf8');
      if (a !== b) {
        errors.push('云函数 ' + fn + ' 的 core/' + relPath + ' 与 core/ 不一致（可能改了 core 但忘了同步）');
      }
    });
  });

  // 反向检查：core/ 里有、但没被同步的算法文件（仅提示，不报错）
  walk(CORE_DIR, '.js').forEach((f) => {
    const relPath = path.relative(CORE_DIR, f).replace(/\\/g, '/');
    if (shared.indexOf(relPath) < 0 && relPath !== 'config.js') {
      warnings.push('core/' + relPath + ' 未列入 SHARED_FILES，云函数端将无法使用它');
    }
  });
}

/* ---------------- 4. 云函数入口必须导出 main ---------------- */

functions.forEach((fn) => {
  const indexFile = path.join(CLOUD_DIR, fn, 'index.js');
  if (!fs.existsSync(indexFile)) return;
  checked += 1;
  const src = fs.readFileSync(indexFile, 'utf8');
  if (!/exports\.main\s*=/.test(src)) {
    errors.push('云函数 ' + fn + ' 的 index.js 未导出 exports.main（云函数入口函数）');
  }
});

/* ---------------- 输出 ---------------- */

console.log('云函数结构校验完成');
console.log('· 云函数：' + functions.join('、'));
console.log('· 扫描 JS 文件：' + cloudJs.length + ' 个');
console.log('· 执行检查：' + checked + ' 项');

if (warnings.length) {
  console.log('\n提示（' + warnings.length + '）：');
  warnings.forEach((w) => console.log('  ! ' + w));
}

if (errors.length) {
  console.log('\n错误（' + errors.length + '）：');
  errors.forEach((e) => console.log('  ✗ ' + e));
  process.exit(1);
}

console.log('\n✓ 云函数结构与 core 同步状态正常');
