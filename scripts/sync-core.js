/**
 * 把 core/ 共享层同步到各云函数目录
 * ---------------------------------------------------------------
 * 微信云开发要求「每个云函数都是独立目录，只能上传自身目录及其子目录的文件」，
 * 因此不能直接 require 云函数目录之外的 ../core。
 *
 * 处理方式：core/ 是唯一事实来源（single source of truth），
 * 本脚本在部署前把它复制进各云函数的 core/ 子目录。
 * 修改算法请永远只改 core/，然后执行：
 *
 *   node scripts/sync-core.js
 *
 * ⚠ 本文件**不要**加 shebang（`#!/usr/bin/env node`）。
 *   本项目 miniprogramRoot 是 "./"，微信开发者工具会扫描项目内所有 .js 并解析，
 *   shebang 不是合法 JS，会导致真机调试直接报「非法的文件，SyntaxError」。
 *   用 `node scripts/sync-core.js` 调用，不需要 shebang。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CORE_DIR = path.join(ROOT, 'core');
const CLOUD_DIR = path.join(ROOT, 'cloudfunctions');

/** 需要在各处共享的文件（相对 core/ 的路径） */
const SHARED_FILES = [
  'color.js',
  'time.js',
  'coord.js',
  'campus-data.js',
  'categories.js',
  'locations.js',
  'matcher.js',
  'matching-ops.js',
  'vlm.js',
  'domain.js',
  'image-spec.js',
  'seed-data.js',
  'ai/embed.js',
  'ai/deepseek.js'
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyFile(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
}

function main() {
  if (!fs.existsSync(CORE_DIR)) {
    console.error('未找到 core/ 目录');
    process.exit(1);
  }
  if (!fs.existsSync(CLOUD_DIR)) {
    console.error('未找到 cloudfunctions/ 目录');
    process.exit(1);
  }

  const functions = fs.readdirSync(CLOUD_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name);

  if (!functions.length) {
    console.error('cloudfunctions/ 下没有云函数目录');
    process.exit(1);
  }

  let total = 0;
  functions.forEach((fn) => {
    const target = path.join(CLOUD_DIR, fn, 'core');
    SHARED_FILES.forEach((rel) => {
      const from = path.join(CORE_DIR, rel);
      if (!fs.existsSync(from)) {
        console.warn('  ! 跳过不存在的共享文件：core/' + rel);
        return;
      }
      copyFile(from, path.join(target, rel));
      total += 1;
    });
    console.log('  ✓ ' + fn + ' ← core/ （' + SHARED_FILES.length + ' 个文件）');
  });

  console.log('\n同步完成：' + functions.length + ' 个云函数，共复制 ' + total + ' 个文件');
  console.log('提示：只有云函数目录内的文件会被上传，因此每次改动 core/ 后都要重新执行本脚本。');
}

main();
