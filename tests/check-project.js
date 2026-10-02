/**
 * 小程序静态结构校验（在 Node 环境运行，不需要微信开发者工具）
 *
 *   node tests/check-project.js
 *
 * 校验项：
 *   1. 所有 JSON 文件可解析（app.json / *.json / project.config.json）
 *   2. app.json 中声明的每个页面都存在 .js/.json/.wxml 文件
 *   3. 所有 usingComponents 指向的组件都存在四件套文件
 *   4. WXML 标签配对平衡（忽略自闭合与注释）
 *   5. WXML 中绑定的事件处理函数在对应 Page/Component 中存在
 *   6. data-* 传参为标量时对应处理函数存在（避免“静默失效”的假按钮）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let errors = [];
let warnings = [];
let checks = 0;

function fail(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

/**
 * 收集文件。
 * 默认跳过开发目录（小程序端结构校验不关心它们），
 * 但「能否被开发者工具编译」这一项需要扫描全项目，
 * 因此提供 all 选项：只跳过 node_modules / .git / 云函数里的 core 副本。
 */
function collect(dir, ext, out, options) {
  const opts = options || {};
  const list = out || [];
  const SKIP = opts.all
    ? ['node_modules', '_stubs']
    : ['node_modules', 'cloudfunctions', 'scripts', '_stubs'];
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP.indexOf(entry.name) >= 0 || entry.name.startsWith('.')) return;
      collect(full, ext, list, options);
    } else if (entry.name.endsWith(ext)) {
      // 云函数里的 core/ 是 scripts/sync-core.js 的同步产物，检查源文件即可
      if (opts.all) {
        const r = rel(full);
        if (/^cloudfunctions\/[^/]+\/core\//.test(r)) return;
      }
      list.push(full);
    }
  });
  return list;
}

/* ---------------- 1. JSON 可解析 ---------------- */
const jsonFiles = collect(ROOT, '.json');
jsonFiles.forEach((file) => {
  checks += 1;
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail('JSON 解析失败 ' + rel(file) + ' → ' + e.message);
  }
});

/* ---------------- 2. 页面文件齐全 ---------------- */
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
(appJson.pages || []).forEach((page) => {
  checks += 1;
  ['.js', '.json', '.wxml'].forEach((ext) => {
    const file = path.join(ROOT, page + ext);
    if (!fs.existsSync(file)) fail('缺少页面文件 ' + page + ext);
  });
});

(appJson.tabBar && appJson.tabBar.list ? appJson.tabBar.list : []).forEach((tab) => {
  checks += 1;
  if ((appJson.pages || []).indexOf(tab.pagePath) < 0) {
    fail('tabBar 中的页面未在 pages 声明：' + tab.pagePath);
  }
});

/* ---------------- 3. 组件路径存在 ---------------- */
function checkUsingComponents(jsonFile) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  } catch (e) {
    return;
  }
  const using = cfg.usingComponents || {};
  Object.keys(using).forEach((name) => {
    checks += 1;
    let target = using[name];
    if (target.charAt(0) === '/') target = target.slice(1);
    const base = path.resolve(path.dirname(jsonFile), target);
    const resolved = fs.existsSync(base) ? base : path.resolve(ROOT, target);
    ['.js', '.json', '.wxml'].forEach((ext) => {
      if (!fs.existsSync(resolved + ext)) {
        fail('组件路径不存在：' + rel(jsonFile) + ' → ' + name + ' (' + using[name] + ext + ')');
      }
    });
  });
}
jsonFiles.forEach(checkUsingComponents);

/* ---------------- 4/5/6. WXML 校验 ---------------- */
const VOID_TAGS = ['image', 'input', 'import', 'include', 'wxs'];

function stripComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

function checkTags(file, src) {
  checks += 1;
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2];
    const selfClose = m[4] === '/' || VOID_TAGS.indexOf(tag) >= 0;
    if (closing) {
      const top = stack.pop();
      if (top !== tag) {
        fail('WXML 标签未正确闭合 ' + rel(file) + '：期望 </' + (top || '?') + '>，实际 </' + tag + '>');
        return;
      }
    } else if (!selfClose) {
      stack.push(tag);
    }
  }
  if (stack.length) {
    fail('WXML 存在未闭合标签 ' + rel(file) + '：' + stack.join(' > '));
  }
}

function checkHandlers(file, src) {
  const jsFile = file.replace(/\.wxml$/, '.js');
  if (!fs.existsSync(jsFile)) return;
  const js = fs.readFileSync(jsFile, 'utf8');

  // 收集处理函数名：兼容 goXxx() / goXxx(e) {} / goXxx: function 三种写法
  const methods = new Set();
  let m;
  const patterns = [
    /(?:^|[\s,{])(on[A-Z][\w]*|go[A-Z][\w]*)\s*\(/g,
    /(?:^|[\s,{])(on[A-Z][\w]*|go[A-Z][\w]*)\s*:\s*function/g
  ];
  patterns.forEach((re) => {
    while ((m = re.exec(js)) !== null) methods.add(m[1]);
  });

  checks += 1;
  const bindRe = /\b(?:bind|catch|capture-bind|capture-catch):?([a-zA-Z]+)\s*=\s*"([^"]+)"/g;
  while ((m = bindRe.exec(src)) !== null) {
    const handler = m[2].trim();
    if (handler.indexOf('{{') >= 0) continue;
    if (!methods.has(handler)) {
      fail('事件处理函数未定义 ' + rel(file) + '：' + handler + '（' + m[1] + '）');
    }
  }
}

/**
 * data-xxx 的取值检查：
 * - wx:for 提供的循环变量（item / index / 自定义名）与其属性访问（item.id）都是标量，属正常用法；
 * - 只有把页面 data 中的整个对象直接塞进 dataset（如 data-match="{{match}}"）才是真实风险。
 */
function checkDatasetObjects(file, src) {
  const jsFile = file.replace(/\.wxml$/, '.js');
  if (!fs.existsSync(jsFile)) return;
  const js = fs.readFileSync(jsFile, 'utf8');

  // 收集 data 中的顶层字段名
  const dataBlock = js.match(/data\s*:\s*\{([\s\S]*?)\n\s{2}\}/);
  const dataKeys = new Set();
  if (dataBlock) {
    const keyRe = /^\s{4}([A-Za-z_$][\w$]*)\s*:/gm;
    let km;
    while ((km = keyRe.exec(dataBlock[1])) !== null) dataKeys.add(km[1]);
  }
  if (!dataKeys.size) return;

  // 收集 wx:for 的循环变量名（含 wx:for-item 自定义名）
  const loopVars = new Set(['item', 'index']);
  const forItemRe = /wx:for-item\s*=\s*"([^"]+)"/g;
  let fm;
  while ((fm = forItemRe.exec(src)) !== null) loopVars.add(fm[1].trim());

  const dataRe = /\bdata-([a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = dataRe.exec(src)) !== null) {
    const value = m[2].trim();
    if (value.indexOf('{{') < 0) continue;
    const expr = value.replace(/[{}]/g, '').trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(expr)) continue;
    if (loopVars.has(expr)) continue;
    if (dataKeys.has(expr)) {
      fail('data-' + m[1] + ' 直接传入了整个对象「' + expr + '」，dataset 只能安全传递标量（' + rel(file) + '）');
    }
  }
}

const wxmlFiles = collect(ROOT, '.wxml');
wxmlFiles.forEach((file) => {
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripComments(raw);
  checkTags(file, src);
  checkHandlers(file, src);
  checkDatasetObjects(file, src);
});

/* ---------------- 7. 跳转 API 与 tabBar 是否匹配 ---------------- */

/**
 * 规则（小程序硬性限制）：
 *   tabBar 页面只能用 wx.switchTab 打开；用 wx.navigateTo 会静默失败。
 *   非 tabBar 页面只能用 wx.navigateTo / redirectTo；用 switchTab 会失败。
 * 这类错误不会在编译时报出，只表现为“点了没反应”，所以必须静态拦住。
 */
function checkNavigation() {
  const tabPages = ((appJson.tabBar && appJson.tabBar.list) || [])
    .map((t) => String(t.pagePath).replace(/^\//, ''));

  const jsFiles = collect(ROOT, '.js').filter((f) => /pages[\\/]/.test(f) || /utils[\\/]nav\.js$/.test(f));

  jsFiles.forEach((file) => {
    const src = fs.readFileSync(file, 'utf8');
    const fileKey = rel(file);

    // 只认「url: '<字面量>'」这种写法；拼接出来的路径（如 '/' + normalize(path)）
    // 无法静态判断，跳过，避免误报。utils/nav.js 自身就是这种动态写法。
    const isNavHelper = /utils[\\/]nav\.js$/.test(file);

    if (!isNavHelper) {
      const navRe = /wx\.(navigateTo|redirectTo)\s*\(\s*\{[^}]*url\s*:\s*['"]([^'"]+)['"]/g;
      let m;
      while ((m = navRe.exec(src)) !== null) {
        checks += 1;
        const api = m[1];
        const page = m[2].replace(/^\//, '').split('?')[0];
        if (tabPages.indexOf(page) >= 0) {
          fail('跳转 API 用错 ' + fileKey + '：' + api + ' 不能打开 tabBar 页面 ' + page +
            '（会静默失败，表现为“点了没反应”），请改用 wx.switchTab 或 utils/nav.js 的 go()');
        }
      }

      const tabRe = /wx\.switchTab\s*\(\s*\{[^}]*url\s*:\s*['"]([^'"]+)['"]/g;
      while ((m = tabRe.exec(src)) !== null) {
        checks += 1;
        const page = m[1].replace(/^\//, '').split('?')[0];
        if (tabPages.indexOf(page) < 0) {
          fail('跳转 API 用错 ' + fileKey + '：switchTab 只能打开 tabBar 页面，' + page + ' 不在 tabBar 中');
        }
      }
    }

    // 反向检查：任何页面调用 nav.go(app, '<页面>') 时，路径必须真实存在
    const goRe = /nav\.go\(\s*app\s*,\s*['"]([^'"]+)['"]/g;
    let g;
    while ((g = goRe.exec(src)) !== null) {
      checks += 1;
      const page = g[1].replace(/^\//, '').split('?')[0];
      if ((appJson.pages || []).indexOf(page) < 0) {
        fail('nav.go 指向未在 app.json 声明的页面：' + fileKey + ' → ' + page);
      }
    }
  });

  // utils/nav.js 里的 TAB_PAGES 必须与 app.json 的 tabBar 完全一致
  const navFile = path.join(ROOT, 'utils', 'nav.js');
  if (fs.existsSync(navFile)) {
    checks += 1;
    const navSrc = fs.readFileSync(navFile, 'utf8');
    const listMatch = navSrc.match(/const TAB_PAGES = \[([\s\S]*?)\];/);
    const navTabs = listMatch
      ? (listMatch[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, ''))
      : [];
    const missing = tabPages.filter((p) => navTabs.indexOf(p) < 0);
    const extra = navTabs.filter((p) => tabPages.indexOf(p) < 0);
    if (missing.length || extra.length) {
      fail('utils/nav.js 的 TAB_PAGES 与 app.json 的 tabBar 不一致：' +
        (missing.length ? '缺少 ' + missing.join('、') : '') +
        (extra.length ? ' 多出 ' + extra.join('、') : ''));
    }
  } else {
    fail('缺少 utils/nav.js（跨 tab 跳转的统一入口）');
  }
}

checkNavigation();

/* ---------------- 8. 横向滚动写法是否正确 ---------------- */

/**
 * 规则：scroll-view 横向滚动必须用「white-space: nowrap + 子项 inline-block」。
 * 如果 WXML 加了 enable-flex，而对应 WXSS 里子项又是 display: inline-flex 或 flex，
 * white-space: nowrap 会失效，表现就是「这一栏滑不动」。
 * 这类问题编译不报错，必须静态拦住。
 */
function checkHorizontalScroll() {
  const wxmlFiles = collect(ROOT, '.wxml');

  wxmlFiles.forEach((file) => {
    const src = fs.readFileSync(file, 'utf8');
    const wxssFile = file.replace(/\.wxml$/, '.wxss');
    if (!fs.existsSync(wxssFile)) return;
    const wxss = fs.readFileSync(wxssFile, 'utf8');

    // 找出所有 scroll-x 的 scroll-view，取它的 class
    const scrollRe = /<scroll-view([^>]*scroll-x[^>]*)>/g;
    let m;
    while ((m = scrollRe.exec(src)) !== null) {
      checks += 1;
      const attrs = m[1];
      const classMatch = attrs.match(/class\s*=\s*"([^"]+)"/);
      if (!classMatch) continue;
      const classes = classMatch[1].split(/\s+/).filter(Boolean);
      const hasEnableFlex = /enable-flex\s*=\s*"\{\{\s*true\s*\}\}"/.test(attrs) || /\senable-flex(?![-\w=])/.test(attrs);

      classes.forEach((cls) => {
        // 该 class 的样式块
        const ruleRe = new RegExp('\\.' + cls.replace(/[-]/g, '\\-') + '\\s*\\{([^}]*)\\}');
        const rule = wxss.match(ruleRe);
        if (!rule) return;
        const body = rule[1];

        if (hasEnableFlex) {
          fail('横向滚动写法有误 ' + rel(file) + '：scroll-view 同时用了 enable-flex，' +
            'white-space:nowrap 会失效（表现为滑不动）。请去掉 enable-flex，子项改用 display:inline-block');
        }

        if (body.indexOf('white-space') < 0) {
          fail('横向滚动缺少 white-space: nowrap ' + rel(file) + ' 的 .' + cls +
            '（scroll-view 横向滚动必须靠它把子项排成一行）');
        }
      });

      // 子项若用了 inline-flex / flex，与 nowrap 冲突
      classes.forEach((cls) => {
        const itemRe = new RegExp('\\.' + cls.replace(/[-]/g, '\\-') + '__item\\s*\\{([^}]*)\\}');
        const item = wxss.match(itemRe);
        if (item && /display\s*:\s*(inline-)?flex/.test(item[1])) {
          fail('横向滚动子项用了 flex 布局 ' + rel(file) + '：.' + cls +
            '__item 应为 display:inline-block，否则 white-space:nowrap 不生效');
        }
      });
    }
  });
}

checkHorizontalScroll();

/* ---------------- 9. 小程序能否被开发者工具正常编译 ---------------- */

/**
 * miniprogramRoot 是 "./"，微信开发者工具会**扫描项目内所有 .js 并解析**，
 * 包括 scripts/ 与 tests/ 这类开发工具。
 *
 * 真实事故：scripts/sync-core.js 第一行写了 shebang（#!/usr/bin/env node），
 * shebang 不是合法 JS，真机调试直接报
 *   「非法的文件，错误信息：invalid file: scripts/sync-core.js, 1:0
 *     SyntaxError: Invalid or unexpected token」
 *
 * 所以这里拦住两件事：
 *   1. 项目内任何 .js 都不许有 shebang（改用 node <file> 调用即可）
 *   2. 开发目录必须写进 packOptions.ignore，避免被打进小程序包
 */
function checkMiniProgramCompilable() {
  const configFile = path.join(ROOT, 'project.config.json');
  const config = fs.existsSync(configFile)
    ? JSON.parse(fs.readFileSync(configFile, 'utf8'))
    : {};

  // 1) shebang 检查（必须扫描全项目：scripts/ 与 tests/ 也在 miniprogramRoot 内）
  const jsFiles = collect(ROOT, '.js', [], { all: true });
  jsFiles.forEach((file) => {
    checks += 1;
    const first = fs.readFileSync(file, 'utf8').split('\n')[0];
    if (first.indexOf('#!') === 0) {
      fail('文件带 shebang，微信开发者工具无法解析 ' + rel(file) +
        '：`' + first.trim() + '`。shebang 不是合法 JS，会导致真机调试报「非法的文件」。' +
        '请删掉第一行，用 `node ' + rel(file) + '` 调用');
    }
  });

  // 2) 开发目录是否被排除出小程序包
  const ignore = (config.packOptions && config.packOptions.ignore) || [];
  const ignoredFolders = ignore
    .filter((x) => x.type === 'folder')
    .map((x) => String(x.value).replace(/\/+$/, ''));

  ['scripts', 'tests'].forEach((dir) => {
    checks += 1;
    if (!fs.existsSync(path.join(ROOT, dir))) return;
    if (ignoredFolders.indexOf(dir) < 0) {
      fail('开发目录 ' + dir + '/ 未写进 project.config.json 的 packOptions.ignore，' +
        '会被打进小程序包并被编译器扫描。请在 ignore 中加入 { type: "folder", value: "' + dir + '" }');
    }
  });

  // 3) 云函数根目录配置
  //    缺少 cloudfunctionRoot 时，开发者工具不会把 cloudfunctions 识别为云函数目录，
  //    右键只有普通文件夹菜单，**找不到「上传并部署」这一项**（真实踩过）。
  checks += 1;
  const cfRoot = config.cloudfunctionRoot;
  if (!cfRoot) {
    const cfDir = path.join(ROOT, 'cloudfunctions');
    if (fs.existsSync(cfDir)) {
      fail('存在 cloudfunctions/ 目录，但 project.config.json 缺少 "cloudfunctionRoot": "cloudfunctions/"。' +
        '缺这一行时开发者工具不会显示「上传并部署」菜单，云函数无法部署');
    }
  } else {
    const cfDir = path.join(ROOT, String(cfRoot).replace(/\/+$/, ''));
    if (!fs.existsSync(cfDir)) {
      fail('cloudfunctionRoot 指向的目录不存在：' + cfRoot);
    } else {
      // 每个云函数都要有 index.js 与声明了 wx-server-sdk 的 package.json
      fs.readdirSync(cfDir, { withFileTypes: true }).forEach((entry) => {
        if (!entry.isDirectory() || entry.name.startsWith('.')) return;
        const fnDir = path.join(cfDir, entry.name);
        checks += 1;
        if (!fs.existsSync(path.join(fnDir, 'index.js'))) {
          fail('云函数 ' + entry.name + ' 缺少 index.js（入口必须是 index.js）');
        }
        checks += 1;
        const pkgFile = path.join(fnDir, 'package.json');
        if (!fs.existsSync(pkgFile)) {
          fail('云函数 ' + entry.name + ' 缺少 package.json（云端安装依赖需要它）');
        } else {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
            if (!pkg.dependencies || !pkg.dependencies['wx-server-sdk']) {
              fail('云函数 ' + entry.name + ' 的 package.json 未声明 wx-server-sdk 依赖');
            }
          } catch (e) {
            fail('云函数 ' + entry.name + ' 的 package.json 解析失败：' + e.message);
          }
        }
      });
    }
  }

  // 4) 根目录的文档与 npm 清单也不必打包
  ['package.json', 'AGENTS.md', 'CHANGELOG.md', 'README.md'].forEach((name) => {
    checks += 1;
    if (!fs.existsSync(path.join(ROOT, name))) return;
    const ignoredFiles = ignore.filter((x) => x.type === 'file').map((x) => x.value);
    if (ignoredFiles.indexOf(name) < 0) {
      warn(name + ' 未写进 packOptions.ignore，会被打进小程序包（不影响运行，但会增大包体）');
    }
  });
}

checkMiniProgramCompilable();

/* ---------------- 输出 ---------------- */
console.log('静态结构校验完成：' + rel(ROOT));
console.log('· 扫描文件：' + (jsonFiles.length + wxmlFiles.length) + ' 个（JSON ' + jsonFiles.length + ' / WXML ' + wxmlFiles.length + '）');
console.log('· 执行检查：' + checks + ' 项');

if (warnings.length) {
  console.log('\n提示（' + warnings.length + '）：');
  warnings.forEach((w) => console.log('  ! ' + w));
}

if (errors.length) {
  console.log('\n错误（' + errors.length + '）：');
  errors.forEach((e) => console.log('  ✗ ' + e));
  process.exit(1);
}

console.log('\n✓ 未发现结构性错误');
