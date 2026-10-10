/**
 * 云函数部署脚本
 * ---------------------------------------------------------------
 *   node scripts/deploy.js              部署 xj-api 与 xj-ai
 *   node scripts/deploy.js xj-api       只部署 xj-api
 *
 * 背景：云函数只能通过微信开发者工具的 CLI 部署，而 CLI 要求 IDE 的
 * 「设置 → 安全设置 → 服务端口」处于开启状态。本脚本把这个流程包起来：
 *   1. 先同步 core/ 到云函数目录（避免部署旧算法，见 AGENTS.md 约定三）
 *   2. 跑一遍结构与同步检查，避免把不一致的代码传上去
 *   3. 调 CLI 部署
 *   4. 部署后提示如何核验云端是否真的跑上新代码
 *
 * ⚠ 本文件不加 shebang（见 AGENTS.md 约定二之二）。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEVTOOLS = process.env.XJ_DEVTOOLS || 'D:\\微信web开发者工具';
const CLI = path.join(DEVTOOLS, 'cli.bat');
const ENV_ID = (function () {
  try {
    const cfg = fs.readFileSync(path.join(ROOT, 'core', 'config.js'), 'utf8');
    const m = cfg.match(/envId:\s*'([^']+)'/);
    return m ? m[1] : '';
  } catch (e) { return ''; }
})();

const functions = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const TARGETS = functions.length ? functions : ['xj-api', 'xj-ai'];

function run(cmd, args) {
  const label = path.basename(cmd) + ' ' + args.join(' ');
  console.log('\n> ' + label);
  const out = execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (out && out.trim()) console.log(out.trim());
  return out;
}

function step(title) { console.log('\n===== ' + title + ' ====='); }

/* ---------------- 1) 前置检查 ---------------- */

step('1. 环境检查');

if (!fs.existsSync(CLI)) {
  console.error('✗ 找不到开发者工具 CLI：' + CLI);
  console.error('  如果工具装在别处，用环境变量指定：$env:XJ_DEVTOOLS="<安装目录>"');
  process.exit(1);
}
if (!ENV_ID) {
  console.error('✗ 没能从 core/config.js 读到 cloud.envId');
  process.exit(1);
}
TARGETS.forEach((fn) => {
  const dir = path.join(ROOT, 'cloudfunctions', fn);
  if (!fs.existsSync(path.join(dir, 'index.js'))) {
    console.error('✗ 云函数目录不完整：cloudfunctions/' + fn + '/index.js 不存在');
    process.exit(1);
  }
});
console.log('· CLI      : ' + CLI);
console.log('· 云环境   : ' + ENV_ID);
console.log('· 待部署   : ' + TARGETS.join('、'));

/* ---------------- 2) 同步 core ---------------- */

step('2. 同步 core/ 到云函数目录');
try {
  run(process.execPath, [path.join('scripts', 'sync-core.js')]);
} catch (e) {
  console.error('✗ sync-core 失败，已中止（避免部署旧算法）');
  console.error(String(e.stdout || e.message));
  process.exit(1);
}

/* ---------------- 3) 部署前自检 ---------------- */

step('3. 部署前自检');
const CHECKS = [
  ['tests/check-cloudfunctions.js', '云函数结构 + core 同步一致性'],
  ['tests/check-encoding.js', '编码完整性']
];
for (const [file, what] of CHECKS) {
  try {
    execFileSync(process.execPath, [path.join(ROOT, file)], { cwd: ROOT, stdio: 'pipe' });
    console.log('✓ ' + what);
  } catch (e) {
    console.error('✗ ' + what + ' 未通过，已中止部署：');
    console.error(String(e.stdout || '') + String(e.stderr || e.message));
    process.exit(1);
  }
}

/* ---------------- 4) 部署 ---------------- */

step('4. 部署云函数（云端安装依赖）');
const args = ['cloud', 'functions', 'deploy',
  '--project', ROOT,
  '--env', ENV_ID,
  '--names'].concat(TARGETS).concat(['--remote-npm-install']);

try {
  run(CLI, args);
} catch (e) {
  const msg = String(e.stdout || '') + String(e.stderr || '') + String(e.message || '');
  console.error('\n✗ 部署失败');
  if (/service port disabled|服务端口已关闭/i.test(msg)) {
    console.error('\n原因：开发者工具的「服务端口」处于关闭状态，CLI 无法连接。');
    console.error('处理（一次性）：');
    console.error('  微信开发者工具 → 右上角「设置」→「安全设置」→ 打开「服务端口」');
    console.error('  然后再执行：node scripts/deploy.js');
  } else if (/not login|未登录|请先登录/i.test(msg)) {
    console.error('\n原因：CLI 未登录。');
    console.error('处理：在开发者工具里扫码登录后重试，或执行 cli.bat login');
  } else {
    console.error(msg.trim().split('\n').slice(0, 15).join('\n'));
  }
  process.exit(1);
}

/* ---------------- 5) 核验提示 ---------------- */

step('5. 部署完成');
console.log('请在小程序里核验云端是否真的跑上新代码（不要只信 CLI 的「成功」）：');
console.log('  1. 开发者工具 Console 执行：');
console.log('     wx.cloud.callFunction({ name:"xj-api", data:{ action:"system.diagnose", payload:{} } })');
console.log('  2. 看返回的 version —— 应为 2026-10-08-2000（更早就说明部署没生效）');
console.log('  3. 顺手确认已修的问题：');
console.log('     · 别人发布的记录，你不能修改/删除（返回 FORBIDDEN）');
console.log('     · 非认领双方的 claim.get 返回 FORBIDDEN，而不是给出隐藏特征');
console.log('     · 切身份后进认领页，不再弹「认领单不存在」');
console.log('\n如需重灌演示数据以修正历史错位记录：');
console.log('  wx.cloud.callFunction({ name:"xj-api", data:{ action:"seed.demo", payload:{ reset:true }, userId:"u_me" } })');
