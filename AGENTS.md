# 项目约定（AGENTS.md）

> 本文件是给 AI 编码助手的项目级指令，会被自动加载。
> 任何人（包括 AI）在本项目中工作时，都必须遵守以下约定。

---

## 约定一：每次操作都要记录变更日志

**这是硬性要求，不是建议。**

用户明确要求：**以后的每次操作都更新一份日志**。

### 必须遵守的流程

1. **开始操作前**：先读 `CHANGELOG.md` 的"未发布"段落，确认当前状态
2. **操作完成后、回复用户之前**：必须把本次变更写入日志
3. 用脚本生成骨架（脚本在文档目录，路径见下）：

```powershell
cd C:\Users\ASUS\Desktop\历史版本
node scripts/add-changelog.js --type 修复 --title "一句话说明改了什么"
```

### 写入位置（两处都要写）

| 位置 | 用途 | 写法 |
| --- | --- | --- |
| `C:\Users\ASUS\Desktop\寻迹\CHANGELOG.md` | 完整变更记录（技术细节） | 追加到「未发布」段落顶部 |
| `C:\Users\ASUS\Desktop\历史版本\CHANGELOG.md` | 可读的历史汇总（给你自己看） | 追加到最新日期的顶部 |

`add-changelog.js` 会自动同时写两处，不用手动。

### 文档工具目录

按用户要求，**文档生成与管理工具已迁到文档目录**，项目文件夹只保留业务代码与构建工具：

| 位置 | 内容 |
| --- | --- |
| `历史版本\scripts\add-changelog.js` | 生成日志骨架（两处同写） |
| `历史版本\scripts\check-changelog.js` | 校验日志格式与新鲜度 |
| `历史版本\scripts\check-encoding.js` | 源码 + 文档编码完整性（跨两个目录扫描） |
| `历史版本\scripts\ai-health.js` | DeepSeek 连通性自检 |
| `历史版本\scripts\changelog-lib.js` | 路径与格式的共享库 |
| `历史版本\docs\` | 施工方案等文档 |
| `寻迹\scripts\` | **只放构建工具**（sync-core、gen-campus 等） |
| `寻迹\tests\` | **只放测试**（算法、结构、云函数） |

> `AGENTS.md` 与 `CHANGELOG.md` **保留在项目根目录**是有意为之：
> `AGENTS.md` 需要被 AI 助手在**改代码时**自动加载，搬到文档目录就形同失效，
> 「每次操作记日志」的约定会守不住。

### 每次操作也要写两处（脚本已自动处理）

项目内 `package.json` 的 `npm test` 已把日志校验接进去，
且路径直接指向文档目录的脚本：

```powershell
cd C:\Users\ASUS\Desktop\寻迹
npm test          # 8 个套件，含日志校验
npm run log -- --type 修复 --title "标题"    # 等价于文档目录的 add-changelog.js
```

### 每条记录的必填字段

```markdown
### [YYYY-MM-DD HH:mm] 类型 · 一句话标题

**用户诉求**：用户原话或诉求的准确复述

**改动文件**：
- `path/to/file.js` — 改了什么

**根因**（修复类必填）：为什么会出这个问题
**方案**：怎么改的
**影响范围**：哪些页面 / 模块 / 数据结构受影响
**测试结果**：`npm test` 或相关套件的实际输出
**遗留 / 待办**：还没做完的、需要用户决定的
```

### 什么算"一次操作"

| 要记录 | 不必单独记录 |
| --- | --- |
| 新增功能、修改功能、修复缺陷 | 纯读取文件、搜索 |
| 改数据结构、改算法、改配置 | 中途失败的探查命令 |
| 改校园地点库、改演示数据 | 同一次操作内的反复微调（合并为一条） |
| 删除文件、重构、换技术方案 | |
| 修文档、加/改测试 | |

一次对话里做了多件事，就写多条记录（按时间顺序，最新的在最上面）。

---

## 约定二：改源码不要用 PowerShell 的文本命令

**这是花了首页白屏一次事故换来的红线。**

禁止：

```powershell
Get-Content file.js -Raw | Set-Content file.js    # ✗ 会按 GBK 重新编码
(Get-Content file.js -Raw) -replace 'a','b' | Set-Content file.js   # ✗ 同上
```

原因：PowerShell 的 `Get-Content`/`Set-Content` 按系统 ANSI 代码页（GBK）处理，
会导致中文乱码，并**吞掉行尾**——字符串的结束引号与下一行代码粘连，
产生 SyntaxError，表现为页面直接白屏。

正确做法：

- 用编辑器工具调用（write / edit 类操作）直接读写
- 必须用脚本批量改的话，用 Node 的 `fs.readFileSync(p, 'utf8')` / `fs.writeFileSync(p, s, 'utf8')`
- 改完跑编码检查确认（脚本在文档目录）：

```powershell
cd C:\Users\ASUS\Desktop\历史版本
node scripts/check-encoding.js
```

---

## 约定二之二：项目内的 .js 不许写 shebang

**这是真机调试报「非法的文件」换来的。**

```js
#!/usr/bin/env node      // ✗ 绝对不要出现在项目内任何 .js 里
```

原因：`project.config.json` 的 `miniprogramRoot` 是 `"./"`，
微信开发者工具会**扫描项目内所有 .js 并解析**，包括 `scripts/` 与 `tests/`。
shebang 不是合法 JS，真机调试会直接报：

```
Error: 非法的文件，错误信息：invalid file: scripts/sync-core.js, 1:0
SyntaxError: Invalid or unexpected token
#!/usr/bin/env node
```

处理：

- 项目内脚本一律不加 shebang，用 `node scripts/xxx.js` 调用（效果完全一样）
- `scripts/` 与 `tests/` 已写进 `project.config.json` 的 `packOptions.ignore`，
  不会被打进小程序包
- 文档目录（`历史版本\scripts\`）**不在小程序项目内**，那里加 shebang 无害

`tests/check-project.js` 有静态检查会拦住 shebang，改完跑一次 `npm test` 即可发现。

---

## 约定三：算法只改 core/，改完必须同步

`core/` 是算法层的**唯一事实来源**，小程序端与云函数端都用它。

```bash
# 改完 core/ 后必须执行，否则云函数用的是旧代码
node scripts/sync-core.js
```

云函数只能上传自身目录，无法 `require` 外层，所以靠复制同步。

---

## 约定四：改数据或地点库必须递增版本号

否则本地缓存不会失效，旧数据（含旧坐标）会一直留着。

| 改了什么 | 要改哪里 |
| --- | --- |
| 演示数据集（增删记录、改坐标、改描述） | `core/seed-data.js` 与 `mock/seed.js` 的 `SEED_VERSION`（**两处必须同步**） |
| 校园地点库（改坐标、增删地点） | `core/campus-data.js` 的 `META.version` |

改完重新编译，`ensureSeed()` 会自动淘汰旧缓存。

---

## 约定五：测试必须全绿再交付

```bash
npm test        # 依次跑全部 8 个套件
```

| 套件 | 位置 | 覆盖 |
| --- | --- | --- |
| `check-encoding.js` | **历史版本\scripts** | 项目 + 文档：JS 语法 / 乱码 / BOM / U+FFFD |
| `check-changelog.js` | **历史版本\scripts** | 日志格式、必填字段、新鲜度 |
| `check-reachable.js` | 寻迹\tests | **从 app.js 走依赖图，查 Node 专有模块/全局量（白屏元凶）** |
| `run-utils.test.js` | 寻迹\tests | 算法 + 校区数据 + 跳转规则（63 项） |
| `run-cloudfunctions.test.js` | 寻迹\tests | 云函数端闭环（41 项） |
| `run-pages.test.js` | 寻迹\tests | **10 个页面的生命周期与渲染数据（27 项）** |
| `check-project.js` | 寻迹\tests | 小程序结构 + 可编译性 + 云函数根目录（172 项） |
| `check-cloudfunctions.js` | 寻迹\tests | 云函数结构 + core 同步（96 项） |

**新增静态检查规则后，必须植入错误验证它真的会报，然后还原。**
否则可能规则本身是空的（本项目已经踩过：检测器最初误报 24 处正常中文）。

### 两个专门防白屏的套件（血泪教训）

**`check-reachable.js`** —— 从 `app.js` 出发静态走完整 require 图，检查：
- 顶层 `require('https'/'http'/'fs'...)` 等 Node 内置模块
- 模块顶层使用 `process` / `Buffer` / `__dirname` 等 Node 全局量

> 起因：`core/ai/embed.js` 顶层写了 `require('https')`，
> 被 `app.js → utils/service.js → core/domain.js` 间接引入后，
> **App 加载失败 → 所有页面白屏**。
> 这类错误在 Node 里跑测试完全正常（Node 有这些模块），只有真机/开发者工具才炸，
> 所以必须专门静态检查。

**`run-pages.test.js`** —— stub 出 `Page`/`getApp`/`wx`，真实调用每个页面的
`onLoad` → `onShow`，并检查 WXML 绑定的变量都在 `data` 里定义过。

### 写 core/ 时的硬性规则

`core/` 被小程序与云函数**共享**，因此：

- **禁止**顶层 `require` Node 内置模块（`https`/`http`/`url`/`fs`/`path`/`crypto`…）
- **禁止**顶层使用 `process` / `Buffer` / `__dirname`
- 需要这些能力时，写成**函数内惰性 require**，并用 `typeof x !== 'undefined'` 做能力检测

```js
// ✗ 会导致小程序全白屏
const https = require('https');

// ✓ 安全：小程序里根本不会执行到
function loadNodeHttp() {
  const https = require('https');
  return { https };
}
```

---

## 约定六：API Key 只在云函数环境变量里

小程序代码包可被反编译，客户端里的任何密钥等于公开。

```
小程序端 → wx.cloud.callFunction → 云函数 xj-ai（Key 存环境变量） → DeepSeek API
```

---

## 约定七：诚实表达局限

本项目在这些位置**主动标注**了能力边界，改动时不要"美化"掉：

- DeepSeek 无 embedding 接口，图像向量是「视觉描述 → 文本向量」的近似方案
- 消融实验的区分度有限，原因写在 README 第 9 节
- `campus-data.js` 中 9 个地点坐标为估算值，带 `verified: false`
- `core/ai/embed.js` 的 `describe()` 如实返回当前向量方案

方案文档第 13 章明确要求：「不要把用了 VLM/CLIP/大模型当创新点」。

---

## 快速参考

### 文档目录（历史版本）

```powershell
cd C:\Users\ASUS\Desktop\历史版本

node scripts/add-changelog.js --type 修复 --title "标题"   # 生成日志骨架（两处同写）
node scripts/check-changelog.js                           # 校验日志格式
node scripts/check-encoding.js                            # 项目 + 文档编码完整性
$env:DEEPSEEK_API_KEY="sk-xxx"; node scripts/ai-health.js  # DeepSeek 连通性自检
```

### 项目目录（寻迹）

```powershell
cd C:\Users\ASUS\Desktop\寻迹

npm test                          # 全部 8 个套件
npm run log -- --type 修复 --title "标题"   # 等价于文档目录的 add-changelog.js
npm run ai:health                 # 等价于文档目录的 ai-health.js
npm run test:reachable            # 只查依赖图（页面白屏时先跑这个）
npm run test:pages                # 只跑页面生命周期
node scripts/sync-core.js         # 改完 core/ 必须跑
node scripts/gen-campus.js        # 从 OSM 重新生成地点清单
node scripts/migrate-locations.js # 演示数据地点 id 迁移
```

## 项目速览

| 项 | 值 |
| --- | --- |
| 类型 | 微信原生小程序 + 云开发（CloudBase） |
| 学校 | 江南大学蠡湖校区（91 个地点，GCJ-02） |
| 算法 | `core/matcher.js` 五路融合打分 + 动态权重 |
| AI | DeepSeek `deepseek-flash`（视觉属性提取，仅云端调用） |
| 代码量 | 137 文件 / 约 23,900 行 |
| 详细总结 | `C:\Users\ASUS\Desktop\历史版本\寻迹项目开发总结.md` |
