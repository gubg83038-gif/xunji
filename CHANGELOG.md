# 变更日志 · 寻迹校园失物智能匹配平台

> **写入规则见 `AGENTS.md` 约定一。每次操作都必须在此追加一条记录。**
> 最新的在最上面。技术细节写这里；给自己的可读汇总同步写到
> `C:\Users\ASUS\Desktop\历史版本\CHANGELOG.md`。

**格式**：

```markdown
### [YYYY-MM-DD HH:mm] 类型 · 一句话标题

**用户诉求**：……
**改动文件**：
- `path` — 说明
**根因**（修复类必填）：……
**方案**：……
**影响范围**：……
**测试结果**：……
**遗留 / 待办**：……
```

类型取值：`新增` / `修复` / `重构` / `文档` / `数据` / `配置` / `测试` / `验证`

---

## 未发布

### [2026-10-03 02:10] 重构 · 对比页 / 认领页 / 我的页按设计稿改造

**用户诉求**：「继续做」（继续把剩余页面按 UI 设计稿改造）

**改动文件**：
- `pages/compare/compare.wxml|wxss|js` — 三段式对照头 + 两栏药丸；新增 `lostPills` / `foundPills`
- `pages/claim/claim.wxml|wxss` — 吉祥物移到问题下方；渐变卡改设计稿的蓝色
- `pages/mine/mine.wxml|wxss` — 头像药丸 + 资料条

**方案**：

先看设计稿原图确认结构，再改——避免照着自己的理解猜。

**① 对比页（改动最大）**

设计稿是**三段式对照头**：左「我的失物」紫色标签 ｜ 中间**白色圆形大分数** ｜ 右「拾到物品」青色标签，
圆形用负 margin 压在两块标签之上形成叠压层次。下面是**两栏对照**（左紫底 / 右青底），
每栏放图片 + 属性药丸。

原来是「左分数 + 右建议」的结论卡 + 单张双图卡，结构差别较大，重写了这部分：

| 原来 | 现在 |
| --- | --- |
| `verdict` 左分数右建议 | `duo-head` 三段式（标签-圆分数-标签） |
| `duo` 单卡双栏 + 中间竖线分数 | `duo__col` 两栏彩色底 + 药丸 |
| `duo__tag` / `duo__mid` / `duo__line` 等 | 删除（已无引用） |

药丸数据从视图模型取：主色 → 材质 → 类别 → 标签（去重，最多 5 条），
与设计稿的视觉密度一致。

**② 认领页**

设计稿的吉祥物在**卡片下方**，我上一版放在卡片右侧——按设计稿调整。
渐变卡原来用紫蓝渐变，设计稿是**蓝色**（`#2f8fe0` → `#4fb8e8`），一并改。

**③ 我的页**

设计稿是「大圆形头像 + **药丸用户名**」并排。原来头像和资料挤在一张卡里，
改为：头像 + 药丸（昵称 + 「个人主页 ›」）一行，资料（学院/信用分/统计）单独一张卡。

**影响范围**：
- 三个页面的视觉与布局
- 对比页新增 2 个 data 字段（`lostPills` / `foundPills`）
- 删除 6 条已无引用的 CSS 规则（`duo__side` / `duo__mid` / `duo__tag` 等）
- 无逻辑改动

**测试结果**（2026-10-03 02:10，10 套件全绿）：

```
历史版本/scripts/check-encoding.js    ✓
历史版本/scripts/check-changelog.js   ✓
tests/check-reachable.js              ✓
tests/run-utils.test.js               通过 66 项
tests/run-cloudfunctions.test.js      通过 53 项
tests/run-mirror.test.js              通过 14 项
tests/run-ai-routing.test.js          通过 12 项
tests/run-pages.test.js               通过 32 项
tests/check-project.js                ✓ 201 项
tests/check-cloudfunctions.js         ✓ 96 项
```

每个页面都做了三项核对：类名与样式一一对应、模板变量都在 `data` 里、
无死代码残留（顺便发现我的死代码检查脚本会读到自己写的注释，已手动确认规则确实删除了）。

**遗留 / 待办**：
- 用户侧：重新编译
- **仍未改造**：消息页、详情页、管理看板（目前沿用设计令牌，配色/圆角/按钮一致，但无素材点缀）
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-03 01:20] 重构 · 接入 UI 设计稿真实素材并改造首页/匹配页

**用户诉求**：「`C:\Users\ASUS\Documents\xwechat_files\...\2026-10\` 这是所有UI的png图片，你根据图片进行设计上的修改」

**改动文件**：
- `scripts/import-ui-assets.js` — **新建**。导入并优化设计稿素材（自写 PNG 解码/缩放/编码，零依赖）
- `static/ui/*.png` — **新增 10 个**：4 个吉祥物 + 6 个 3D 图标，共 279KB
- `app.wxss` — 背景渐变改为设计稿的青→蓝→紫；新增 `.score-ellipse`（匹配度椭圆）、
  `.mascot`、`.ui-icon` 工具类；主按钮改紫蓝渐变
- `pages/home/home.wxml|wxss|js` — 按设计稿重做：重叠双卡 + 吉祥物、最近失物网格、
  地图横幅；`refresh()` 新增 `recentLosts`
- `pages/matches/matches.wxml|wxss` — 统计条改「一共为您找到 N 个可能匹配物品」；
  底部加吉祥物探头
- `components/item-card/item-card.wxml` — 匹配度改用 `.score-ellipse` 椭圆容器

**方案**：

用户提供了完整的 UI 素材包（21 个 PNG）：6 张 375×812 页面图、6 个 240×240 的 3D 图标、
4 张 1254×1254 的吉祥物、1 张背景渐变、1 张设计系统总览。

**素材处理是前提**：吉祥物单张 900KB，四张就 3.5MB——微信主包上限 2MB，直接用会超限。
所以写了 `import-ui-assets.js`：自写 PNG 解码（含 5 种 filter 反解）+ 双线性缩放 +
自写 PNG 编码（含逐行 filter 择优 + 最高压缩），**零依赖**。

| 素材 | 原始 | 处理后 |
| --- | --- | --- |
| 4 个吉祥物 | 3.5 MB | 226 KB（260×260） |
| 6 个 3D 图标 | 331 KB | 40 KB |
| **合计** | **3.8 MB** | **279 KB（占主包 27%）** |

**过程中的一次质量事故（必须记录）**：

第一版我用**调色板 PNG（色类型 3 + tRNS）**压缩，体积降到 60KB 看起来很漂亮。
但把素材放大拼成预览图检查后，发现**吉祥物出现大片黑色色块，地图图标有黑斑**。

根因：我把「调色板索引 0 留给透明」与颜色量化混在一起——
**不透明像素也会被量化到索引 0**，于是深色区域被强制成透明，露出黑底。
而且这些素材有大面积柔和渐变，本来就不适合调色板量化（必然出色带）。

改为 **RGBA 直存**（色类型 6）后质量无损，体积 279KB 仍在可接受范围。

> 教训：**压缩后必须自己看结果**。60KB 这个数字很好看，
> 但如果直接把第一版接进去，用户看到的会是黑块吉祥物。

**设计稿与初版的关键差异（这次才做对）**：

1. **首页两张卡是上下错位重叠的** —— 绿色卡上边缘有一段弧形包边盖住紫色卡。
   用负 margin + 绿色卡左上大圆角近似实现。
2. **背景渐变比我初版更亮更饱和** —— 顶部青绿 `#9fe8e0` 而非浅蓝。
3. **匹配度放在浅蓝紫椭圆里** —— 新增 `.score-ellipse`。
4. **首页有「最近失物」三图网格**，之前没有。

**影响范围**：
- 首页、匹配页视觉完全按设计稿；其余页面沿用上一轮的设计令牌
- 新增 `static/ui/` 素材目录（在包内，不在 packOptions.ignore 里）
- 无逻辑改动

**测试结果**（2026-10-03 01:20，10 套件全绿）：

```
历史版本/scripts/check-encoding.js    ✓
历史版本/scripts/check-changelog.js   ✓
tests/check-reachable.js              ✓
tests/run-utils.test.js               通过 66 项
tests/run-cloudfunctions.test.js      通过 53 项
tests/run-mirror.test.js              通过 14 项
tests/run-ai-routing.test.js          通过 12 项
tests/run-pages.test.js               通过 32 项
tests/check-project.js                ✓ 193 项
tests/check-cloudfunctions.js         ✓ 96 项
```

另用真实数据验证首页渲染：`recentLosts` 3 条、`myTasks` 2 条、
`categories` 8 个、`hasImage` 字段齐备。

**遗留 / 待办**：
- 用户侧：**重新编译**（新增 `static/ui/` 素材）
- **仍待改造的页面**：发布页（有大上传区 + 相机素材）、我的页（齿轮/信箱图标）、
  认领核验（思考吉祥物）、对比页、消息页、详情页、管理看板
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 23:55] 新增 · tabBar 底部导航图标（脚本生成 PNG）

**用户诉求**：「导航栏也添加上一些小图标」

**改动文件**：
- `scripts/gen-tab-icons.js` — **新建**。用「矢量形状 + 光栅化 + 手写 PNG 编码」生成图标
- `static/tabbar/*.png` — **新建 8 个**：home / match / map / mine 各一套（未选中灰 + 选中蓝）
- `app.json` — tabBar 每项补 `iconPath` 与 `selectedIconPath`；窗口背景色随新底色调为 `#EAF2FF`
- `tests/check-project.js` — 新增 tabBar 图标校验（4 项规则）

**方案**：

微信 tabBar **不支持字体图标，必须是本地 PNG 文件**。我不能画图，
但可以**用代码生成**——所以写了个纯 Node 的图标生成器：

1. 用圆形 / 圆环 / 胶囊 / 矩形四种基本形状描述图标（坐标为 0—100 相对空间，改尺寸不变形）
2. **4 倍超采样**后缩小，得到抗锯齿的平滑边缘
3. 自己实现最小 PNG 编码器（`zlib` + CRC32 + IHDR/IDAT/IEND 分块），**零依赖**

生成 4 个图标：

| 图标 | 形状 | 语义 |
| --- | --- | --- |
| 首页 | 屋顶 + 屋身 | 首页 |
| 匹配 | 放大镜 | 检索 —— 呼应本项目「多模态语义检索」 |
| 地图 | 定位针 | 地图 |
| 我的 | 人像剪影 | 个人中心 |

规格 81×81（微信推荐），选中态用 `#2E6BE6`、未选中 `#98A2B3`，
与 `app.json` 的 `selectedColor` / `color` 一致。

**过程中的三次修正（都是靠肉眼看预览图发现的）**：

第一次生成后我把图标放大 6 倍拼成预览图检查，发现两个问题：

1. **地图**：内孔挖得不对，中间成了「钥匙孔」，读起来像放大镜。
   → 改为内孔圆心偏上，让下方形成实心针尖
2. **我的**：头部是小圆环 + 下方一条分离的横线，像「圆圈加横线」而不是人。
   → 先试加大头环、缩短肩线，仍不理想；最终改为**实心剪影**（圆头 + 宽肩），
     这是这类图标最通用的画法，辨识度最高

> 这一步印证了一个方法：**生成类工作必须自己先看结果再交付**。
> 如果直接把第一版接进 `app.json`，用户会看到钥匙孔和「圆圈加横线」。

**新增的静态检查（4 项）**：

- tabBar 每项必须有 `iconPath`
- 每项必须有 `selectedIconPath`
- 图标文件必须**真实存在**（缺失会直接导致编译失败）
- 图标体积不超过 40KB（微信限制）

规则有效性已验证：临时移走 `map-on.png` → 检查器报
「tabBar 图标文件不存在：static/tabbar/map-on.png（缺失会导致编译失败）」→ 还原。

同时确认 `static/` **不在** `packOptions.ignore` 里——图标是运行时资源，必须在包内。

**影响范围**：
- 底部导航从纯文字变为「图标 + 文字」，选中态有图标变色
- 窗口背景色由 `#F6F7FB` 改为 `#EAF2FF`，与新渐变底色衔接
- 无任何逻辑改动

**测试结果**（2026-10-02 23:55，10 套件全绿）：

```
历史版本/scripts/check-encoding.js    ✓
历史版本/scripts/check-changelog.js   ✓
tests/check-reachable.js              ✓
tests/run-utils.test.js               通过 66 项
tests/run-cloudfunctions.test.js      通过 53 项
tests/run-mirror.test.js              通过 14 项
tests/run-ai-routing.test.js          通过 12 项
tests/run-pages.test.js               通过 32 项
tests/check-project.js                ✓ 192 项（新增 4 项图标检查）
tests/check-cloudfunctions.js         ✓ 96 项
```

**遗留 / 待办**：
- 用户侧：重新编译（新增了 `static/` 资源，需重新编译才能被打进包）
- 图标风格可调：改 `scripts/gen-tab-icons.js` 里的形状定义后重跑脚本即可，
  不需要重新找素材
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 23:30] 重构 · 按 UI 设计稿改造整体视觉

**用户诉求**：「按照这个UI修改小程序的代码」（附 7 屏设计稿：首页、发布失物、匹配列表、匹配详情、发布拾物、认领核验、个人中心）

**改动文件**：
- `app.wxss` — 设计令牌扩充：页面渐变、hero 渐变（蓝/绿）、主按钮渐变、分数渐变、柔和渐变面；
  新增阴影令牌（卡片/hero/按钮）；圆角整体放大；新增 `.hero-card`、`.score-big`、
  `.tag--violet`、`.tag--cyan`、`.page--plain`
- `pages/home/home.wxml|wxss` — 两个入口改为**上下排列的彩色渐变大卡**（蓝/绿）
- `components/item-card/item-card.wxml|wxss` — 重排为**左图右分**：左侧大缩略图 + 来源用户，
  右侧大号匹配度 + 「查看详情」按钮；时空信息与可解释证据移到下方
- `pages/compare/compare.wxss` — 大分数改**渐变文字**；通过阈值改**实心绿药丸**
- `pages/claim/claim.wxml|wxss` — 新增**蓝色渐变说明卡**
- `pages/mine/mine.wxml|wxss` — 头像位改为**圆形 emoji**（原来塞的是昵称文本，会撑破圆形）
- `pages/map/map.wxss` — 背景改 `transparent`（整屏地图页不铺渐变）
- `scripts/tokenize-styles.js` — **新建**。把各页面的硬编码圆角与颜色批量替换为设计令牌
- 13 个 wxss 文件 — 由脚本完成 **258 处**令牌化

**方案**：

设计稿与原有实现的差距主要在五处，逐一落实：

| 维度 | 原实现 | 改为 |
| --- | --- | --- |
| 页面背景 | 纯色 `#f6f7fb` | 蓝→紫**渐变** |
| 圆角 | 20–40rpx 混用 | 令牌化，卡片 36rpx、按钮胶囊 |
| 按钮 | 92rpx 高、方角 | 100rpx 高、**胶囊 + 渐变 + 投影** |
| 首页入口 | 两张小卡并排 | **上下排列的彩色大卡**（蓝/绿） |
| 候选卡 | 分数在顶部、信息在右 | **左图右分**，右侧突出匹配度 |

**为什么用脚本做令牌化**：9 个页面 wxss 里有 258 处重复的硬编码圆角与颜色值。
手改既慢又容易漏，脚本化后可反复执行（已验证**幂等**：第二次运行 0 处变化），
日后统一调整设计也只需改映射表。

**必须说明的限制（诚实交代）**：

设计稿里的**卡通吉祥物与装饰插画我无法生成**——我是文本 AI，不能画图。
经与用户确认，本轮**不引入吉祥物**，只做配色、圆角、按钮、布局的改造：

- 首页两张 hero 卡右侧的装饰位用 **emoji 占位**（`.hero-card__emoji`）
- 个人中心的头像位用 **圆形 emoji**（`.profile__avatar`）
- 其余插画位置暂不添加

这些位置都已留好结构与样式，日后拿到 PNG 素材，
把 emoji 换成 `<image>` 即可，不需要再改版式。

**影响范围**：
- 全部 10 个页面 + 3 个组件的视觉外观
- 无任何数据、算法、云函数改动；功能行为完全不变
- 所有页面测试与结构检查通过，说明 WXML 改动未破坏事件绑定

**测试结果**（2026-10-02 23:30，10 套件全绿）：

```
历史版本/scripts/check-encoding.js    ✓
历史版本/scripts/check-changelog.js   ✓
tests/check-reachable.js              ✓
tests/run-utils.test.js               通过 66 项
tests/run-cloudfunctions.test.js      通过 53 项
tests/run-mirror.test.js              通过 14 项
tests/run-ai-routing.test.js          通过 12 项
tests/run-pages.test.js               通过 32 项
tests/check-project.js                ✓ 178 项
tests/check-cloudfunctions.js         ✓ 96 项
```

改造过程中修正的两个自查项：
1. 首次令牌化有 19 处中间值圆角（18/22rpx）未映射 → 扩宽映射区间后补齐
2. `mine.wxss` 的头像位原本渲染昵称文本，改成圆形后会撑破 → 改为 emoji 占位

**遗留 / 待办**：
- 用户侧：**重新编译**即可查看效果（纯样式改动，云函数不用重传）
- 吉祥物与插画需用户提供 PNG 素材后再补
- 底栏图标：设计稿是图标 + 选中态，当前 tabBar 是纯文字。
  改用图标需要 PNG 素材（tabBar 不支持字体图标），已记入待办
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 22:10] 修复 · 发布成功后「查看候选」点了没反应（navigateTo 跳 tabBar）

**用户诉求**：「我发布了一条失物之后，为什么在匹配页面没有更新，还是原来的几个」

**改动文件**：
- `pages/publish/publish.js` — 发布成功后的跳转改用 `nav.go()`；补充 `nav` 引用
- `tests/run-pages.test.js` — 新增 2 项跳转回归测试；弹窗替身支持模拟「确定」
- `tests/check-project.js` — 该规则本来就有，本次未改（见下方说明）

**根因**：

`pages/publish/publish.js` 发布成功后的「查看候选」按钮走的是：

```js
wx.navigateTo({ url: '/pages/matches/matches?itemId=' + result.item.id + '&type=' + kind });
```

**但 `/pages/matches/matches` 是 tabBar 页面**。小程序里 `wx.navigateTo`
打开 tabBar 页面会**静默失败**——不跳转、不报错、不执行 fail 回调。

用户看到的就是「提示发布成功、有 N 个候选」，但**点确定后什么都没发生**，
再手动切到「匹配」tab，看到的还是原来那几条（因为没跳到新记录那个上下文）。

**这是本项目第二次踩同一个坑**：第一次是首页类别图标点不动，
当时写了 `utils/nav.js`（把参数暂存在 globalData + 走 switchTab）来统一解决，
但发布页这一处漏改了。

**方案**：

```js
nav.go(app, '/pages/matches/matches', {
  itemId: result.item.id,
  kind: this.data.kind
});
```

`nav.go` 内部判断是否 tabBar 页面：是则把参数写进 `globalData.pendingParams`
再 `switchTab`（因为 switchTab 不支持 query），匹配页在 `onShow` 里消费。

**影响范围**：
- 发布后点「查看候选」能正确跳到匹配页，并定位到刚发布的记录
- 「匹配」tab 手动进入时的行为不变

**测试结果**（2026-10-02 22:10，10 套件全绿）：

```
历史版本/scripts/check-encoding.js    ✓
历史版本/scripts/check-changelog.js   ✓
tests/check-reachable.js              ✓
tests/run-utils.test.js               通过 66 项
tests/run-cloudfunctions.test.js      通过 53 项
tests/run-mirror.test.js              通过 14 项
tests/run-ai-routing.test.js          通过 12 项
tests/run-pages.test.js               通过 32 项（新增 2 项）
tests/check-project.js                ✓ 177 项
tests/check-cloudfunctions.js         ✓ 96 项
```

新增的两项测试：
1. **全量扫描**：所有页面里不得用 `navigateTo` 打开 tabBar 页面（跳过注释行）
2. **行为验证**：发布页 `onSubmit` 确认后必须调用 `switchTab` 且把 `itemId`
   写进 `globalData.pendingParams`

**规则有效性验证**：把跳转改回 `navigateTo` → 两项测试同时报错，
其中全量扫描精确指出 `pages/publish/publish.js:464 → pages/matches/matches`
并提示「应改用 nav.go」→ 还原。

**一个值得记录的细节**：`tests/check-project.js` **本来就有这条规则**，
但它没拦住真实 bug——因为它只认 `url: '字面量'` 的写法，而真实代码里
url 是字符串拼接的（`'...?itemId=' + id`），静态判断不到。
而我修完后在注释里写了那个报错写法，**反而把规则触发了**：
规则是对的，是我注释的写法骗过了它。已改掉注释写法。

> 教训：静态规则只能覆盖它能识别的写法。**拼接出来的路径它看不见**，
> 所以还需要行为层面的测试（第 2 项）来兜底。

**遗留 / 待办**：
- 用户侧：重新编译（只改了页面，云函数不用重传）
- 待验证：发布后点「查看候选」应跳到匹配页并定位到新记录
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 21:20] 修复 · 更新不在云库的记录时刷红色错误（item.update 报 NOT_FOUND）

**用户诉求**：（截图）Console 报
`[寻迹] 云端提交 item.update 失败： 记录不存在`

**改动文件**：
- `cloudfunctions/xj-api/index.js` — `item.update` 对不存在的记录返回「已忽略」而非 `NOT_FOUND`；
  清理该处因多次编辑叠加产生的**三份重复定义与一段残缺注释**
- `utils/store.js` — `updateItem` 只对「云库确实存在的记录」发更新请求；发布成功后打 `_cloudSynced` 标记
- `tests/run-cloudfunctions.test.js` — 新增第 10 组共 3 项测试

**根因**：

`utils/service.js` 有 8 处对已存在记录调用 `store.updateItem`（状态流转、
匹配后回写 `status`/`matchCount` 等）。这些调用会一并更新**本地镜像里存在、
但云库中没有**的记录——例如本地模式下灌的演示数据，之后切到云端模式。

云端 `item.update` 对这种记录返回 `NOT_FOUND`，客户端 `dispatchToCloud`
把失败打成红色 error。

**功能其实没坏**（记录本来就不在云端，没什么可更新的），但两个实际代价：
1. 控制台刷红色错误，掩盖真正的问题
2. 白白发出一次注定失败的云函数调用

**方案**：

1. **云端容错**：`item.update` 找不到记录时返回 `ok({ ignored: true, reason, id })`。
   注意 `item.get` **保持报错**——读不到就是真的读不到，这与
   「更新可忽略」是两种不同语义，不能一并放宽。
2. **客户端减少无效请求**：`updateItem` 只在记录带 `_fromCloud`
   （来自云端快照）或 `_cloudSynced`（本地发布已被云端确认）时才发更新。
3. **发布成功后打标记**：`insertItem` 的云端回调里设 `item._cloudSynced = true`，
   之后该记录的状态流转才会同步到云端。

**自我纠错（必须记录）**：

修改 `item.update` 时我连续用文本替换叠加编辑，**把同一个 handler 写成了三份**，
并留下一段残缺注释和一个孤立的 `},`，直接导致 `index.js` 语法错误。

发现后我改用**按行号边界精确切除**的一次性脚本修复，
而不是继续用文本替换（替换已连续失败多次，说明我对当前文本的判断是错的）。
修复后核实：`item.publish` / `item.get` / `item.list` / `item.update` / `item.remove`
各只有一处定义，语法检查通过。

教训：**同一文件连续多轮文本编辑后，必须先看实际状态再改**——
我以为的"原文"早就被前几次编辑改掉了。

**影响范围**：
- 状态流转不再刷红色错误
- 不再对云库中没有的记录发无效请求
- `item.get` 的错误语义保持不变

**测试结果**（2026-10-02 21:20，10 套件全绿）：

```
历史版本/scripts/check-encoding.js    ✓
历史版本/scripts/check-changelog.js   ✓
tests/check-reachable.js              ✓
tests/run-utils.test.js               通过 66 项
tests/run-cloudfunctions.test.js      通过 53 项（新增 3 项）
tests/run-mirror.test.js              通过 14 项
tests/run-ai-routing.test.js          通过 12 项
tests/run-pages.test.js               通过 30 项
tests/check-project.js                ✓ 172 项
tests/check-cloudfunctions.js         ✓ 96 项
```

新增测试覆盖三种语义：
- 存在的记录正常更新（`views` 写回 42）
- 不在云库的记录返回 `ignored: true` + 原因 + 回显 id
- `item.get` 对不存在的记录**仍返回** `NOT_FOUND`

**遗留 / 待办**：
- 用户侧：**重新上传 `xj-api`**（云函数改了）+ 重新编译
- 待验证：发布页拍照后应显示「属性由 deepseek-flash 视觉模型识别」
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 20:45] 修复 · 空 payload 触发云端报错（发布页 onLoad 的噪音）

**用户诉求**：（截图）Console 连续三条红色 error：
`[寻迹] AI 属性提取失败，降级本地规则：需要提供图片或文字描述`

**改动文件**：
- `utils/api.js` — `extractAttributes` 增加空输入门禁；调整演示图短路顺序
- `pages/publish/publish.js` — `recompute()` 增加 `hasContent` 判断与 `canCallCloud` 二次确认
- `tests/run-ai-routing.test.js` — **新建**。锁定 AI 调用路由规则（12 项断言）
- `package.json` — 测试套件 9 → **10 个**

**根因**：

`pages/publish/publish.js` 的 `onLoad` 会调用 `this.recompute(false)`（第 84 行），
**那时用户还没选图、也没填描述**。于是发出去一个空 payload：

```js
{ image: '', description: '', type: 'lost', detail: 'low', mimeType: 'image/jpeg' }
```

云函数 `xj-ai` 按设计拒绝它：

```js
const imageInput = buildImageInput(p);
if (!imageInput && !p.description) {
  return fail('需要提供图片或文字描述', 'NO_INPUT');
}
```

客户端捕获失败 → 打红色 error → 降级本地规则。

**功能没有坏**（降级是设计好的容错），但有两个实际代价：
1. 控制台每次进发布页都刷红色 error，掩盖真正的问题
2. **白白浪费一次云函数调用**（进页面就调，什么都没传）

**方案**：

1. `extractAttributes` 在**发云函数之前**判断「是否真的有东西可识别」：
   有图片（base64 / fileId / url）或有非空文字描述才调用，否则直接走本地兜底。
   **门禁放在 API 层**而不是调用方，所有调用点都受保护。
2. **演示图短路必须排在门禁之前**——演示图不是可上传的图片资源，
   但从业务上看它是有效输入；若先跑门禁会被判成空输入而丢失内置线索。
   这一点我第一版写反了，测试直接抓到。（见下方"自我纠错"）
3. `publish.js` 的 `recompute()` 增加 `hasContent` 判断，
   并在 base64 读取失败时二次确认（`canCallCloud`）——那种情况下云端也无从识别。

**自我纠错（记录以避免重复）**：

第一版我把门禁写在演示图短路**之前**，逻辑是：

```js
const hasImage = !!(p.imageBase64 || ... || (p.image && !demo));
if (!hasImage && !hasDescription) return localFallback();
// ↓ 演示图分支在这里，永远走不到
```

结果 `demo://cup_metal_gray` 被 `hasImage` 判为 false，
在演示图分支之前就返回了本地兜底，**丢失了内置线索**。

测试第一轮就报出来了：`model=local` 而不是 `demo-hints`。
修正为「先判演示图 → 再判空输入」。

**影响范围**：
- 进发布页不再刷红色 error
- 空输入不再消耗云函数调用
- 演示图库仍走短路（零额度消耗），且内置线索正常返回
- 有真实图片或描述时行为不变，照常调用 DeepSeek

**测试结果**（2026-10-02 20:45，10 套件全绿）：

```
历史版本/scripts/check-encoding.js    ✓
历史版本/scripts/check-changelog.js   ✓
tests/check-reachable.js              ✓
tests/run-utils.test.js               通过 66 项
tests/run-cloudfunctions.test.js      通过 50 项
tests/run-mirror.test.js              通过 14 项
tests/run-ai-routing.test.js          通过 12 项 ← 新建
tests/run-pages.test.js               通过 30 项
tests/check-project.js                ✓ 172 项
tests/check-cloudfunctions.js         ✓ 96 项
```

`run-ai-routing.test.js` 覆盖的 12 种输入组合：

| 输入 | 期望云函数调用 | 期望 model |
| --- | --- | --- |
| 完全空（onLoad 场景） | 0 | local |
| 只有空白描述 | 0 | local |
| image 为 undefined / null | 0 | local |
| 演示图（带 demo:// 前缀） | 0 | demo-hints |
| 演示图（不带前缀） | 0 | demo-hints |
| 演示图 + 文字描述 | 0 | demo-hints |
| 只有文字描述 | 1 | local（stub 拒绝后降级） |
| 只有图片 base64 | 1 | local |
| imageFileId / imageUrl | 1 | local |
| 云函数失败 | — | 降级不抛异常 |

**遗留 / 待办**：
- 用户侧：重新编译（`utils/` 与 `pages/` 都改了，**云函数不用重传**）
- 待验证：发布页拍照后应显示「属性由 deepseek-flash 视觉模型识别」
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 20:20] 配置 · 切换 AI provider 为 deepseek，启用真实视觉模型

**用户诉求**：「我上传好了，你来修改」——要求把 AI 开关切到 DeepSeek

**改动文件**：
- `core/config.js` — `ai.provider` 由 `'local'` 改为 `'deepseek'`；更新注释说明生效前提
- `cloudfunctions/xj-ai/core/*`、`cloudfunctions/xj-api/core/*` — `scripts/sync-core.js` 重新同步（各 14 个文件）

**方案 / 架构确认**：

先厘清了两端的职责，避免误改：

| 端 | provider 的作用 | Key 来源 |
| --- | --- | --- |
| **小程序端** | `aiReady()` 依据它决定「是否调用 `xj-ai` 云函数」还是「走本地规则提取」 | 不持有 Key |
| **云函数 `xj-ai`** | 不看 provider，只读环境变量 | `DEEPSEEK_API_KEY` 环境变量 |

`core/config.js` **故意不同步**到云函数（云端配置走环境变量），
所以云函数目录里没有 `config.js` 是正确的，不是遗漏。

**影响范围**：
- 小程序发布时会调用 `xj-ai` 走真实视觉模型（属性提取 + 图像语义描述）
- 演示图库仍走短路逻辑，不消耗模型额度
- Key 失效或超时时自动降级为本地规则，发布流程不中断
- 两个云函数需重新上传（`core/` 有同步更新）

**测试结果**（2026-10-02 20:20，9 套件全绿）：

```
历史版本/scripts/check-encoding.js    ✓
历史版本/scripts/check-changelog.js   ✓
tests/check-reachable.js              ✓
tests/run-utils.test.js               通过 66 项
tests/run-cloudfunctions.test.js      通过 50 项
tests/run-mirror.test.js              通过 14 项
tests/run-pages.test.js               通过 30 项
tests/check-project.js                ✓ 172 项
tests/check-cloudfunctions.js         ✓ 96 项
```

配置校验：`aiReady()` 由 `false` 变为 `true`；
`imageVectorByDescription` 与 `cacheAttributes` 保持 `true`。

**遗留 / 待办**：
- 用户侧：**重新上传两个云函数**（`core/` 已更新）+ 重新编译
- 待验证：发布页拍照后应显示「属性由 deepseek-flash 视觉模型识别」
- 未做本地 `ai-health.js` 自检（本机未设置 `DEEPSEEK_API_KEY` 进程级环境变量），
  改为直接在小程序端验证；若降级会明确提示
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 19:45] 修复 · 演示数据时间偏移 8 小时（云函数时区不是 UTC+8）

**用户诉求**：（截图）详细对比页已恢复 **82%**（视觉相似度 100%、时间相关度 94%），
但时间显示为 `2026-10-03 02:42`、丢失窗口 `10-03 01:30 — 02:20`，
而演示数据定义的是当天 18:42 / 17:30—18:20。

**改动文件**：
- `core/time.js` — 新增 `cnTime(hour, minute, dayOffset, anchorTs)` 与 `CN_OFFSET_MINUTES`
- `core/seed-data.js` — `at()` 改为委托 `timeUtil.cnTime()`；`SEED_VERSION` 4 → 5
- `mock/seed.js` — `SEED_VERSION` 4 → 5
- `cloudfunctions/xj-api/index.js` — `system.diagnose` 增加时区诊断字段
- `tests/run-utils.test.js` — 新增 3 项时区回归测试

**根因**：

演示数据用 `new Date().setHours(18, 42)` 构造「今天 18:42」——
**这是按运行环境的本地时区解释的**。

而**微信云函数运行环境的时区不一定是 UTC+8**。实测数据可以反推出来：

```
数据里 foundTime = 1790937720000 = 10:42 UTC = 18:42 (UTC+8)
界面显示 = 次日 02:42
差 8 小时
```

若云函数跑在 UTC，`setHours(18,42)` 生成的是 **18:42 UTC** = 次日 02:42（UTC+8），
与界面显示完全吻合。

**这不只是显示问题，还破坏了语义**：原本「丢失窗口结束后 22 分钟被捡到」，
偏移后变成「提前 7.5 小时被捡到」——时间相关度虽然还能算出分数，
但描述的是一个不真实的故事。演示主线的时间线因此完全错乱。

**方案**：

1. `core/time.js` 新增 `cnTime()`：**按北京时间构造时间戳，与运行环境时区无关**。
   做法是先把锚点换算成北京时间的"墙上时间"，用 `Date.UTC` 构造，
   再减去 8 小时偏移还原成绝对时刻。
2. `core/seed-data.js` 的 `at()` 改为委托 `cnTime()`。
3. `SEED_VERSION` 4 → 5，强制淘汰按旧逻辑生成的时间戳。
4. `system.diagnose` 增加 `timezone` 字段（偏移、TZ 环境变量、本地/UTC 时间、
   `isUtc8` 标志）与 `timezoneWarning`，以后这类问题可直接查证。

**多时区验证**（同一份代码，用 TZ 环境变量实测）：

```
TZ=UTC                    → cnTime(18,42) 北京时间 = 2026-10-02 18:42  ✓
TZ=Asia/Shanghai          → cnTime(18,42) 北京时间 = 2026-10-02 18:42  ✓
TZ=America/New_York       → cnTime(18,42) 北京时间 = 2026-10-02 18:42  ✓
TZ=Pacific/Kiritimati     → cnTime(18,42) 北京时间 = 2026-10-02 18:42  ✓
```

**影响范围**：
- 演示数据时间恢复为当天 17:30—18:20 与 18:42（北京时间）
- 「丢失后 22 分钟被捡到」的时间线语义恢复正确
- 时间相关度不再受部署环境时区影响
- 需重新灌数据（`SEED_VERSION` 已递增，seed 会自动重灌）

**测试结果**（2026-10-02 19:45，9 套件全绿）：

```
历史版本/scripts/check-encoding.js    ✓
历史版本/scripts/check-changelog.js   ✓
tests/check-reachable.js              ✓
tests/run-utils.test.js               通过 66 项（新增 3 项）
tests/run-cloudfunctions.test.js      通过 50 项
tests/run-mirror.test.js              通过 14 项
tests/run-pages.test.js               通过 30 项
tests/check-project.js                ✓ 172 项
tests/check-cloudfunctions.js         ✓ 96 项
```

新增的时区回归测试最关键的一条：

```
✓ 演示数据的丢失窗口与拾取时间保持 22 分钟（时区修复的核心目的）
   若为 502 分钟说明时区偏移 8 小时
```

同时断言丢失与拾取必须在**同一天**（北京时间）。

**版本一致性校验**：`core/seed-data.js`、`mock/seed.js`、
云函数副本三处 `SEED_VERSION` 均为 `5`。

**遗留 / 待办**：
- 用户侧：重新上传 `xj-api` + 重新编译；seed 会自动检测版本变化并重灌
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 19:10] 修复 · 详细对比页 48% 的真凶：客户端镜像丢掉了计算字段

**用户诉求**：（截图）`system.inspect` 显示云端 **82%**（五路分项全部可用），
`mode = cloud`、`ready = true`、`bootError` 为空，但详细对比页依然显示 **48%**。

**改动文件**：
- `cloudfunctions/xj-api/service.js` — 新增 `toClientEntity()`，把云端实体转成
  **含计算字段**的客户端文档（embeddings / timeRange / foundTime / 完整 location），
  并对隐藏特征做归属过滤
- `cloudfunctions/xj-api/index.js` — `item.list` 默认返回 `entity` 格式而非展示视图；
  新增 `viewerId` 参数
- `utils/store.js` — `viewToEntity()` 重写：实体格式如实还原，不再丢字段
- `tests/run-mirror.test.js` — **新建**。端到端覆盖「云端 → 客户端镜像 → 对比页」
- `package.json` — 测试套件 8 → **9 个**

**根因**：

`utils/store.js` 的 `viewToEntity()` 把云端返回的**展示视图**转回本地实体时，
丢掉了匹配引擎需要的字段：

```js
timeRange: null,                                  // ✗ 写死 null
foundTime: k === 'found' ? v.createdAt : 0,       // ✗ 用了 createdAt 而非真 foundTime
location: { id: '', name: v.locationName, area: '', lat: v.lat, lng: v.lng },  // ✗ area 丢失
// 完全没有 embeddings                            // ✗ 向量整个丢了
```

因为 `service.viewItem()` 返回的是 `domain.itemView()`——**面向展示**的视图，
本来就不含向量、时间范围这些原始字段。

于是形成一条「数据被逐层削弱」的链路：

```
云数据库（完整，inspect 算出 82%）        ← 用户已验证
   ↓ item.list 返回展示视图（无向量、无 timeRange）
客户端镜像（字段残缺）
   ↓ compareDetail 本地重算
详细对比页 48%（视觉相似度 0%、时间未参与）
```

**客户端与云端算出不同答案，不是算法问题，是数据在传输环节被削掉了。**

**方案**：

1. 云端新增 `toClientEntity(item, viewerId)`：返回**可用于计算的实体文档**——
   `embeddings`、`timeRange`、`foundTime`、完整 `location`（含 area/lat/lng）、
   原始 `attributes`，而不是美化后的展示字段。
2. `item.list` 默认返回 `entity` 格式；需要纯展示数据时传 `{ view: true }`。
3. `viewToEntity()` 重写：实体格式如实还原全部计算字段，同时保留对旧视图格式的兼容。
4. 新增 `tests/run-mirror.test.js` 走**真实同步链路**
   （`wx.cloud.callFunction` → `fetchSnapshot` → `applySnapshot`），
   而不是直接调内部函数——确保覆盖用户实际走的那条路。

**顺带修掉一个隐私泄露（测试抓到的）**：

`item.list` 原本用 `ctx.userId` 判断「是否本人」，
而 `refreshFromCloud` 调用时不传 userId，导致 ctx 默认成 `u_me`，
**任何人请求列表都会被视为 `u_me`，从而看到 `lost_cup_01` 的隐藏特征**
（也就是认领核验的答案）。

现在改为 `p.viewerId || p.userId || ctx.userId || 'u_me'`，
并在 `toClientEntity` 里按归属过滤：非本人只拿到 `privateCount`，拿不到具体内容。

**影响范围**：
- 详细对比页恢复 82%；五路分项全部参与计算
- 客户端与云端分数一致（测试断言误差 <1%）
- 隐藏特征不再泄露给非本人
- 新增第 9 个测试套件（14 项断言）

**测试结果**（2026-10-02 19:10，9 套件全绿）：

```
历史版本/scripts/check-encoding.js    ✓
历史版本/scripts/check-changelog.js   ✓
tests/check-reachable.js              ✓
tests/run-utils.test.js               通过 63 项
tests/run-cloudfunctions.test.js      通过 50 项
tests/run-mirror.test.js              通过 14 项 ← 新建
tests/run-pages.test.js               通过 30 项
tests/check-project.js                ✓ 172 项
tests/check-cloudfunctions.js         ✓ 96 项
```

`run-mirror.test.js` 的关键断言：
- `item.list` 返回 `entity` 格式（不是 view）
- 实体含 `embeddings`（text 64 维 + image 64 维）、`timeRange`、`foundTime`、完整 `location`
- 隐藏特征只回传本人
- 客户端镜像保留全部计算字段
- **本地重算 ≥80%**（这条直接锁死 48% 的回归）
- 五路分项全部 `available: true`
- 时间差含「22」
- 客户端与云端分数误差 <1%

**遗留 / 待办**：
- 用户侧：重新上传 `xj-api`，重新编译；若本地镜像仍是旧的，下拉刷新或重新编译即可
- 待查：时间戳展示的 8 小时时区偏移
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 18:00] 修复 · 上一版的自动重灌逻辑失效（旧数据没有指纹可比）

**用户诉求**：（截图）执行 seed 后输出
`结果: 数据库已有数据且向量方案未变，未重复灌入。下一步: match ｜失物 undefined 拾物 undefined`
—— 并没有触发自动重灌，48% 的问题依然存在。

**改动文件**：
- `cloudfunctions/xj-api/service.js` — `seedDemo` 改为**抽样检查数据本身**（是否有 embeddings）而非依赖指纹
- `cloudfunctions/xj-api/store.js` — 新增 `sampleItem()`（1 次查询取一条记录）
- `cloudfunctions/xj-api/index.js` — `seed` 步骤新增 `vectorsOk` 校验；修正跳过分支下计数为 `undefined`
- `tests/run-cloudfunctions.test.js` — 新增 1 项测试

**根因**：

上一版我用「向量方案指纹比对」判断是否需要重灌：

```js
const stale = metaBefore.embeddingFingerprint &&
              metaBefore.embeddingFingerprint !== fingerprint;
```

**但旧数据里从未写过 `embeddingFingerprint`**，它是 `undefined`，
`undefined && ...` 短路为 `false` —— 永远判定「未变化」，永远跳过。

**这个方案对「历史遗留的旧数据」完全无效**，而这恰恰是要解决的问题。

> 核心教训：**指纹只能检测「方案变了」，检测不出「数据是坏的」。**
> 判断数据能不能用，必须**直接看数据本身**。

**方案**：

1. `seedDemo` 改为**抽样检查**：库里有数据时取一条记录，看它有没有 `embeddings`，
   缺就清空重灌。只需 1 次查询（原指纹方案反而要遍历 41 条）。
2. `seed` 返回值新增 `vectorsOk`：重灌后**立即抽样确认向量确实写入**，
   而不是只报告「灌完了」。
3. 修正跳过分支下 `lostCount` / `foundCount` 返回 `undefined` 的问题。

**影响范围**：
- 旧数据（缺向量）现在能自动被识别并淘汰，无需手动 reset
- seed 的返回值更可信（`vectorsOk` 是实测结果，不是假设）
- 界面分数应恢复 82%

**测试结果**（2026-10-02 18:00，8 套件全绿）：

```
历史版本/scripts/check-encoding.js    ✓
历史版本/scripts/check-changelog.js   ✓
tests/check-reachable.js              ✓
tests/run-utils.test.js               通过 63 项
tests/run-cloudfunctions.test.js      通过 50 项（新增 1 项）
tests/run-pages.test.js               通过 30 项
tests/check-project.js                ✓ 172 项
tests/check-cloudfunctions.js         ✓ 96 项
```

新增测试直接复现用户场景：预置 2 条无 `embeddings` 的旧记录 →
验证 seed 不跳过 → 重灌后 `vectorsOk: true` → 演示主线恢复 ≥80%。

**自我复盘**：上一版我把「指纹比对」当成通用解法就交付了，
没有先构造「旧数据没有指纹」这个显而易见的边界场景去验证。
**如果当时就写这个测试，会立刻发现方案失效。**
规则的教训——新增判断逻辑时必须先构造它要处理的**最坏输入**。

**遗留 / 待办**：
- 用户侧：重新上传 `xj-api` + 再跑一次 seed
- 待查：时间戳展示的 8 小时时区偏移
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 17:20] 修复 · 演示主线显示 48% 而非 82%——云端存的是缺 embeddings 的旧数据

**用户诉求**：（截图）详细对比页正常渲染，但显示 `48% 匹配`，
**视觉相似度 0%**（权重 32%）、**时间相关度「未参与」**、`时间待确认`。
另外用户说明已把云函数超时改成 60 秒。

**改动文件**：
- `cloudfunctions/xj-api/index.js` — `system.step` 的 `seed` 增加**向量方案指纹校验**（不一致自动重灌）；
  新增 `system.inspect` 诊断入口；补充 `matcher` / `vlm` 引用
- `tests/run-cloudfunctions.test.js` — 新增 2 项测试

**根因**：

本地用**完全相同的代码路径**（云函数 `service.js` + `core/matcher.js`）复现，
结果是 **82.2%**，五路分项全部可用（image=1.0、time=0.94、时间差 22 分钟）。

同样代码同样数据，云端算出 48% —— 差别只能在**数据库里存的记录**。

检查 `core/vlm.js` 的 `imageSimilarity()`：

```js
const va = itemA.embeddings && (itemA.embeddings.imageDesc || itemA.embeddings.image);
if (!va || !vb) return { score: 0, available: false };
```

**没有 `embeddings` 字段 → 视觉相似度判为不可用（0%）**，其 32% 权重被重新分配到其余分项。
云端那条记录正是缺少 `embeddings`。

**为什么缺**：用户在「建集合」与「灌数据」之间那个时间点，云端运行的还是
**加向量持久化之前的代码**，那时插入的记录没有 `embeddings`；
后续 `seed` 因「库中已有数据」被跳过，旧记录一直留着。

**这是「代码是对的、数据是旧的」**——最难排查的一类问题：
代码没问题、逻辑没问题，但结果是错的。

**方案**：

1. **向量方案指纹 + 自动重灌**：`seed` 时把 `aiEmbed.describe()` 序列化成指纹存进 meta，
   并与库中记录比对；不一致就自动 `reset` 重灌，无需手动干预。
   以后任何影响向量的改动都会自动淘汰旧数据。
2. **`system.inspect` 诊断入口**：摊开两条记录的 `embeddings` 各维度长度、
   `timeRange`、`foundTime`、坐标、属性键，以及五路分项与权重、可用性。
   这类「数据与预期不符」的问题以后一眼可查。

**影响范围**：
- 界面分数恢复为 82%（需重新上传 `xj-api` 并跑一次 `seed`）
- 时间相关度恢复参与计算
- 向量相关代码改动后会自动重灌，避免旧数据残留

**测试结果**（2026-10-02 17:20，8 套件全绿）：

```
历史版本/scripts/check-encoding.js    ✓
历史版本/scripts/check-changelog.js   ✓
tests/check-reachable.js              ✓
tests/run-utils.test.js               通过 63 项
tests/run-cloudfunctions.test.js      通过 49 项（新增 2 项）
tests/run-pages.test.js               通过 30 项
tests/check-project.js                ✓ 172 项
tests/check-cloudfunctions.js         ✓ 96 项
```

新增测试：向量指纹变化时自动重灌（同时验证正常情况仍会跳过）、
`system.inspect` 验证 embeddings 存在且演示主线 ≥80%。

**发现的另一个待查问题**：截图中 `foundTime` 显示为 `2026-10-03 02:50`，
而演示数据录的是当天 18:42，疑似 8 小时时区偏移影响展示。已记入待办。

**遗留 / 待办**：
- 用户侧：重新上传 `xj-api`，执行一次 `seed`（会自动重灌）
- 待查：时间戳展示的时区处理
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 16:20] 验证 · 云端数据库初始化成功（首次跑通）

**用户诉求**：（截图）初始化命令执行输出：
`✅ 初始化完成 / 云函数版本 2026-10-02-1610 / 物品数 41 / 匹配数 44 / 地点库 91 个 / 状态：数据与匹配均已就绪`

**改动文件**：无代码改动。本条目记录一次**验证结果**。

**方案 / 验证内容**：

用户按文档执行「一条命令自动跑完」，实际输出与预期完全一致：

| 项目 | 实际值 | 预期 | 结论 |
| --- | --- | --- | --- |
| 建集合 | 已存在（无需新建） | — | ✓ 前次超时请求已建好集合 |
| 失物数 | 17 | 17 | ✓ |
| 拾物数 | 24 | 24 | ✓ |
| 匹配轮数 | 11 轮 | 需多轮 | ✓ 分块生效 |
| 候选数 | 44 | 44 | ✓ 与测试环境一致 |
| 云函数版本 | `2026-10-02-1610` | 同代码标记 | ✓ **部署确认成功** |
| 物品总数 | 41 | 17+24 | ✓ |
| 地点库 | 91 | 91 | ✓ |
| 状态 | 数据与匹配均已就绪 | — | ✓ |

**这次跑通证明了三件事**：
1. `cloudfunctionRoot` 修复有效（右键菜单出现「上传并部署」）
2. 分块执行有效（11 轮跑完，未触发 -504003 超时）
3. `system.diagnose` 的版本号可作为**部署成功判据**——用户不必猜云函数是不是最新代码

**影响范围**：云端环境已就绪，可进行端到端界面验证。

**测试结果**：无需重跑测试（无代码改动）；此前 8 套件已全绿。

**遗留 / 待办**：
- **待验证**：重新编译后确认 `mode === 'cloud'`、匹配 tab 显示演示主线候选
- 待验证：发布 / 认领 / 归还闭环
- 云函数超时仍为 3 秒（当前靠分块规避，建议改为 60 秒）
- AI 仍为 `local`（等 DeepSeek Key 后切换）
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 15:40] 修复 · match 步骤未真正分块导致仍然超时；新增诊断入口

**用户诉求**：（截图）`init` 返回 `created: []`、`seed` 返回 `undefined 失物 / undefined 拾物`、
`match` 连续两次 `-504003 Invoking task timed out after 3 seconds`

**改动文件**：
- `cloudfunctions/xj-api/service.js` — 新增 `matchLostChunk()` / `matchFoundChunk()` 分块匹配
- `cloudfunctions/xj-api/index.js` — `system.step` 的 `match` 改为游标式分块；`seed` 字段提到顶层；新增 `system.diagnose`
- `cloudfunctions/xj-api/store.js` — `countItems()` 增加集合不存在容错
- `tests/run-cloudfunctions.test.js` — 更新与新增分块测试
- `历史版本\docs\DeepSeek与数据库接入施工方案.md` — 步骤 5 改为「一条命令自动跑完」

**根因**：

上一版我加了 `system.step` 分步入口，但 **`match` 这一步没有真正分块**——
它内部仍调用 `incrementalMatch()`，一次处理全部 17 条失物 + 24 条拾物，
每条都要「读候选 → 五路打分 → 多次写库 → 生成通知」。
在真实云数据库上远超 3 秒，所以照样超时。

**分步 ≠ 分块**。建集合、灌数据这类单一操作可以一步做完，
但匹配是 O(失物 × 拾物) 的写密集型操作，必须**可中断、可续跑**。

另外 `step=seed` 的 `lostCount` / `foundCount` 嵌套在 `result` 对象里，
前端按顶层字段读，拿到 `undefined`——不是没灌成功，是字段位置不对。

`init` 返回 `created: []` 是**正常的**：集合已存在时无需新建（之前超时的请求
其实已经把集合建好了，只是没能返回）。

**方案**：

1. `service.js` 新增两个分块函数，按 `id` 排序保证游标稳定，返回 `nextOffset`
2. `system.step` 的 `match` 改成游标式：返回
   `next: { step:'match', phase:'lost', offset:6, chunk:4 }`，
   把 `next` 原样作为 payload 传回即可继续，直到 `next === null`
3. **`next` 里带回 `chunk`**：否则客户端第二轮会丢回默认值 6，每轮耗时突然变长
4. 新增 `system.diagnose`：报告版本号、每个集合是否存在及记录数、物品数、匹配数、下一步建议
5. `seed` 的 `lostCount` / `foundCount` / `itemCount` / `matchCount` 全部提到顶层

**影响范围**：
- 初始化不再受 3 秒超时限制（每轮 4 条，单轮远低于 3 秒）
- `system.diagnose` 可用于确认云函数是否部署成功
- `system.setup` 保留，仍需配合 60 秒超时

**测试结果**（2026-10-02 15:40，8 套件全绿）：

```
历史版本/scripts/check-encoding.js    ✓
历史版本/scripts/check-changelog.js   ✓
tests/check-reachable.js              ✓ 依赖图干净
tests/run-utils.test.js               通过 63 项
tests/run-cloudfunctions.test.js      通过 47 项
tests/run-pages.test.js               通过 30 项
tests/check-project.js                ✓ 172 项
tests/check-cloudfunctions.js         ✓ 96 项
```

新增测试专门验证「`next` 必须自带 `chunk`」——
第一版实现漏了这一点时，测试报
「next 应保留 chunk，实际 {"step":"match","phase":"lost","offset":6}」。

**排查过程**：先用最小脚本直接调用 handler 确认 `chunk` 参数生效（返回 `processed: 4`），
发现问题在**测试跟随 `next` 时丢了 `chunk`**；进而意识到这是客户端也会踩的坑，
于是让服务端在 `next` 里带上 `chunk`。**测试暴露的问题不一定是产品 bug，
但顺着它改进产品是对的。**

**遗留 / 待办**：
- 用户侧：重新上传 `xj-api`，执行文档里的「一条命令自动跑完」
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 14:55] 修复 · 地图 LatLng(NaN) 报错 + 云函数 3 秒默认超时

**用户诉求**：（截图）三个报错：
1. `SystemError (webviewScriptError) 参数错误: LatLng 传入参数 (NaN, NaN) 非合法数字`
2. `collection.get:fail -502005 database collection not exists ... xj_claims / xj_items`
3. `cloud.callFunction:fail errCode: -504003 Invoking task timed out after 3 seconds`

**改动文件**：
- `pages/map/map.js` — 修复 `includePoints` 里混入 `{ lat, lng }` 的问题
- `cloudfunctions/xj-api/index.js` — 新增 `system.step` 分步初始化入口；`system.setup` 补充超时前置说明
- `tests/run-pages.test.js` — 新增 3 项地图坐标检查
- `tests/run-cloudfunctions.test.js` — 新增 5 项分步初始化测试
- `历史版本\docs\DeepSeek与数据库接入施工方案.md` — 新增「如何修改云函数超时」；步骤 5 改为分步优先；新增第 5 章「常见报错速查」

**根因**：

**问题 1（地图 NaN）**：`pages/map/map.js` 的 `onLoad` 里：

```js
includePoints: [
  { latitude: points[0].latitude, longitude: points[0].longitude },
  center,                                             // ✗ center 是 { lat, lng }
  { latitude: points[1].latitude, longitude: points[1].longitude }
]
```

地图组件的 `include-points` **只认 `latitude` / `longitude`** 两个键。
`center` 是 `{ lat, lng }`，被当成点后解析出 `LatLng(undefined, undefined)` → 组件抛 NaN。

**问题 3（3 秒超时）**：微信云开发的云函数**默认超时是 3 秒**，不是 20 秒
（客户端 `cloud.timeout` 是 20 秒，两者是独立配置）。
而 `system.setup` 要「建 7 个集合 + 灌 41 条记录 + 跑 40 次匹配」，
在真实云数据库上需要 5~15 秒，必然报 `-504003`。

**问题 2 是问题 3 的后果**：集合没建成，后续所有读取都报不存在。

**方案**：

1. 地图：显式转换 `{ latitude: center.lat, longitude: center.lng }`；
   并在页面测试里加检查——include-points 每个点必须是合法经纬度、
   属性名必须是 latitude/longitude、范围必须落在校区内。这类错误静态看不出来，
   必须在页面初始化后检查真实数据。
2. 超时：新增 `system.step` 分步入口，`step` 取 `init` / `seed` / `match` / `all`，
   每次只做一步，每步都在 3 秒内完成，返回 `next` 告知下一步。重复调用幂等。
3. 文档：补充**修改云函数超时**的具体操作路径（开发者工具右键菜单里没有这一项，
   必须在云开发控制台 → 云函数 → 版本与配置 → 配置 → 高级配置）。

**影响范围**：
- 地图页正常显示，不再有 NaN 报错
- 初始化不再受 3 秒超时限制；`system.setup` 保留但需配合 60 秒超时
- 客户端与云函数行为一致

**测试结果**（2026-10-02 14:55，8 套件全绿）：

```
历史版本/scripts/check-encoding.js    ✓
历史版本/scripts/check-changelog.js   ✓
tests/check-reachable.js              ✓ 22 个可达模块，依赖图干净
tests/run-utils.test.js               通过 63 项
tests/run-cloudfunctions.test.js      通过 46 项（新增 5 项）
tests/run-pages.test.js               通过 30 项（新增 3 项）
tests/check-project.js                ✓ 172 项
tests/check-cloudfunctions.js         ✓ 96 项
```

规则有效性验证：把 `center` 改回 `includePoints` →
检查器报「includePoints[1] 不是合法经纬度：{"lat":31.4835,"lng":120.2735}
（属性名必须是 latitude / longitude）」并返回退出码 1 → 还原。

**排查中的一次自我纠错（记录以避免重复）**：
benchmark 显示云端 `incrementalMatch()` 返回 `created: 0`，一度判断为
「全新灌入的数据居然产出 0 条候选」，准备深入排查算法。
进一步诊断后发现是**误报**——灌数据阶段已经生成好 44 条候选，
所以 match 步骤确实没有新增。样本失物第一名得分 0.9719，匹配引擎完全正常。
教训：`created: 0` 不等于「没有候选」，要看匹配表总数而不是增量数。

**遗留 / 待办**：
- 用户侧：重新编译；用 `system.step` 分步初始化；建议顺手把两个云函数超时改到 60 秒
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 14:20] 修复 · 所有页面白屏——core/ai/embed.js 顶层 require Node 内置模块

**用户诉求**：「不是，现在小程序的页面都不显示了」

**改动文件**：
- `core/ai/embed.js` — 删除顶层 `require('https'/'http'/'url')`，改为 `loadNodeHttp()` 函数内惰性加载；
  `process.env` 改用 `envVar()`；`Buffer.byteLength` 改用自实现 `byteLength()`
- `core/ai/deepseek.js` — 同样处理（虽然它当前不在小程序依赖图内，但同类风险必须一并消除）
- `tests/check-reachable.js` — **新建**。从 `app.js` 走完整 require 图，检查 Node 专有模块/全局量
- `tests/run-pages.test.js` — **新建**。stub Page/getApp/wx，真实跑 10 个页面的生命周期
- `package.json` — 测试套件从 6 个增加到 8 个
- `AGENTS.md` — 新增「写 core/ 时的硬性规则」与两个防白屏套件的说明

**根因**：

`core/ai/embed.js` 顶部写着：

```js
const https = require('https');
const http = require('http');
const { URL } = require('url');
```

这是 **Node.js 内置模块，小程序环境根本不存在**。

**这是我上一轮改动引入的**：我把 `utils/service.js` 的 `itemView` 改成委托 `core/domain.js`，
于是接出了这条依赖链：

```
app.js → utils/service.js → core/domain.js → core/ai/embed.js → require('https')  ✗
```

模块加载失败 → `App()` 执行不下去 → `onLaunch` 不运行 → **所有页面白屏**。

**为什么测试没发现**：6 个既有套件全绿。因为 Node 环境**有** `http`/`https`/`url`，
`require` 完全正常。这类错误只在真机 / 开发者工具里炸——
测试环境与运行环境的差异正好把这个 bug 藏住了。

**方案**：

1. `embed.js` / `deepseek.js` 的 Node 专有代码全部改为**函数内惰性加载**：
   - `loadNodeHttp()`：调用时才 require，小程序里根本不会执行到
   - `envVar(name)`：`typeof process !== 'undefined'` 能力检测，小程序端返回空串
   - `byteLength(str)`：优先 `Buffer`，没有则按 UTF-8 手工计算
2. 新增 `tests/check-reachable.js`：从 `app.js` 出发静态走 require 图，
   报告顶层 Node 内置模块与顶层 Node 全局量。
   **关键设计**：区分「顶层 require」（致命）与「函数内惰性 require」（安全），
   后者只作提示，否则修复本身会被误报。
3. 新增 `tests/run-pages.test.js`：把 10 个页面的 `onLoad` → `onShow` 真实跑一遍。

**影响范围**：
- 页面恢复显示
- `core/` 现在可以在小程序端安全加载
- 云函数端行为不变（惰性 require 在 Node 里照常生效）
- 测试门槛提高：8 个套件，新增两道防白屏防线

**测试结果**（2026-10-02 14:20，8 套件全绿）：

```
历史版本/scripts/check-encoding.js    ✓ 无语法错误、乱码、BOM
历史版本/scripts/check-changelog.js   ✓ 变更日志格式正常
tests/check-reachable.js              ✓ 22 个可达模块，无 Node 专有模块/全局量
                                        （3 处惰性 require 已确认为安全）
tests/run-utils.test.js               通过 63 项
tests/run-cloudfunctions.test.js      通过 41 项
tests/run-pages.test.js               通过 27 项 ← 新建
tests/check-project.js                ✓ 172 项
tests/check-cloudfunctions.js         ✓ 96 项
```

规则有效性验证：把顶层 `require('https')` 加回 `embed.js` →
检查器报「Node 内置模块 ... 由 core/domain.js 间接引入」并返回退出码 1 → 还原。

**本次排查的完整过程**（记录方法，便于复用）：
1. 先怀疑页面代码 → 写 `run-pages.test.js` 跑 10 个页面 → **全部正常**，排除页面层
2. 检查 `app.json` / `app.js` / 循环依赖 → **均正常**
3. 写 `check-reachable.js` 做依赖图可达性分析 → **一次命中**：`core/ai/embed.js`

**排查中的自身失误**：
- `run-pages.test.js` 最初把 `wx:for-item` 定义的作用域变量（`tag`、`hint`）误报为
  "未定义模板变量"，已修正为识别 `wx:for-item` / `wx:for-index`
- `check-reachable.js` 最初把注释里的 `require('../../core/matcher.js')` 当成真依赖，
  已修正为跳过注释

**遗留 / 待办**：
- 用户侧：**重新编译**即可（纯前端修复，云函数无需重传）
- 若尚未初始化数据库，仍需执行 `system.setup`
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 13:40] 修复 · 首次启动两个报错：集合不存在被误判为云端不可用 + demo:// 图片被当资源加载

**用户诉求**：（截图）Console 报两个错：
1. `[渲染层网络层错误] Failed to load local image resource /components/item-card/demo://stationery_black`（HTTP 500）
2. `[寻迹] 云端同步失败: collection.get:fail -502005 database collection not exists ... xj_items`
   然后是 `[寻迹] 云端不可用，已退回本地演示数据`

**改动文件**：

修复 1（集合不存在容错）：
- `cloudfunctions/xj-api/store.js` — 新增 `isCollectionNotExist()`；`fetchAll` / `findOne` 捕获集合不存在错误并返回空结果
- `tests/_stubs/wx-server-sdk/index.js` — **替身改为可模拟真实行为**：读取未创建的集合抛 `errCode -502005`
- `tests/run-cloudfunctions.test.js` — 新增第 9 组测试（空库场景）

修复 2（图片渲染）：
- `core/domain.js` — 视图模型新增 `hasImage`（预计算，替代各页面重复写 `indexOf('demo://')`）
- `components/item-card/item-card.wxml` — 改用 `hasImage`（**原来这里漏了 demo:// 判断**）
- `pages/detail/detail.wxml`、`pages/compare/compare.wxml` — 统一改用 `hasImage`
- `utils/service.js` — **删除重复的 `itemView` 实现，改为委托 `core/domain.js`**

**根因**：

**问题 1：把「还没建集合」误判成「云端不可用」**

微信云开发不会在写入前自动建集合。首次启动时集合全都不存在，
`store.fetchAll()` 直接把 `-502005 database collection not exists` 上抛，
`refreshFromCloud()` 捕获后返回 `false`，`app.js` 判定云端不可用 →
**整个应用退回本地演示数据**。

用户看到的现象是「明明配好了云环境，却一直在离线模式」——
但真实原因只是「还没执行初始化」。这是**容错缺失**，不是配置问题。

**问题 2：演示图库标识被当成了图片路径**

`demo://stationery_black` 是「演示图库标识」，只用于属性提取与向量计算，
**不是可渲染的图片资源**。

对比页、详情页、发布页都写了 `indexOf('demo://') !== 0` 来排除它，
但 `components/item-card/item-card.wxml` 的判断只写了 `match.counterpart.image`，
**漏了这一层**。于是演示数据一进候选卡，微信就按相对路径去找本地文件：
`components/item-card/demo://stationery_black` → 500。

**深层问题是重复实现**：`utils/service.js` 与 `core/domain.js` 各有一份 `itemView`，
两处逻辑几乎相同但并不完全同步——加新字段只改一边就会出现「云端对、本地错」。

**方案**：

1. `store.js` 识别 `-502005` 类错误，读取时视为空数据。这样首次启动不会误判云端不可用，
   只是拿到空列表（界面显示空状态），用户执行初始化后数据立刻出现；
2. 测试替身**改为默认严格模式**：读取未创建的集合会抛真实错误。
   之前替身对任何集合名都自动"存在"，所以这个 bug 在测试里永远暴露不出来；
3. 视图模型统一提供 `hasImage`，页面不再各自判断 `demo://`；
4. **删除 `utils/service.js` 里重复的 `itemView`，改为委托 `core/domain.js`**，
   从根上消除这类"改一处漏一处"的问题。

**影响范围**：
- 首次启动不再退回离线模式（云端可用时始终走云端，只是数据为空）
- 演示数据的图片位置改显示 emoji 图标占位（与原来在发布页/详情页的行为一致，不是回归）
- `utils/service.js` 的 `itemView` 输出结构与云函数端完全对齐

**测试结果**（2026-10-02 13:40，6 套件全绿）：

```
历史版本/scripts/check-encoding.js   ✓ 无语法错误、乱码、BOM
历史版本/scripts/check-changelog.js  ✓ 变更日志格式正常
tests/run-utils.test.js              通过 63 项
tests/run-cloudfunctions.test.js     通过 41 项（新增 3 项空库场景）
tests/check-project.js               ✓ 172 项
tests/check-cloudfunctions.js        ✓ 96 项
```

针对性验证（用真实数据跑视图模型）：
- 43 条候选中 37 条带 `demo://` → `hasImage` 全部为 `false`，不会再渲染成图片
- 用户截图里那条 `found_stationery_01` → `hasImage: false`，改为显示 `✏️` 图标
- `hasImage` 未定义的候选：0 条

排查过程中的两个自身失误，均已修正：
1. 新增测试放在中间、清空了数据，导致后续测试失败 → 移到文件末尾
2. 移动测试时残留了半截块头（`await test('核验问题...', async () => {  group('2. ...`），
   造成语法错误 → 已修正

**遗留 / 待办**：
- **用户需要重新上传部署 `xj-api`**（store.js 与 core/domain.js 都改了）
- 用户侧：重新编译后执行 `system.setup` 完成初始化
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 13:05] 修复 · 右键云函数目录没有「上传并部署」菜单——缺少 cloudfunctionRoot

**用户诉求**：（截图）「没有菜单里找『上传并部署：云端安装依赖（不上传 node_modules）』」
截图显示右键后只有普通文件夹菜单（新建 Page / 删除 Page / 新建文件 / 剪切 / 复制 等），
没有任何云函数相关项。

**改动文件**：
- `project.config.json` — 新增 `"cloudfunctionRoot": "cloudfunctions/"`
- `tests/check-project.js` — 新增第 9 组规则里的云函数根目录校验（含每个函数的入口与依赖检查）

**根因**：

`project.config.json` 里只声明了 `miniprogramRoot`（小程序代码根目录），
**缺少 `cloudfunctionRoot`（云函数根目录）**。

微信开发者工具靠 `cloudfunctionRoot` 判断哪个目录是云函数目录。
缺这一行时，它把 `cloudfunctions/` 当成普通文件夹，
右键只有通用文件操作菜单，**不会出现「上传并部署」系列菜单项**。

这是配置文件遗漏，不是操作问题——用户右键的位置是对的。

**方案**：

```json
"miniprogramRoot": "./",
"cloudfunctionRoot": "cloudfunctions/",   // ← 新增
```

同时加了静态检查，扫三类问题：
1. 存在 `cloudfunctions/` 但 `cloudfunctionRoot` 缺失
2. `cloudfunctionRoot` 指向的目录不存在
3. 每个云函数缺 `index.js`、缺 `package.json`、或未声明 `wx-server-sdk` 依赖

**影响范围**：
- 开发者工具重启或刷新后，`cloudfunctions` 会显示为云函数目录（带云图标）
- 右键应出现「上传并部署：云端安装依赖（不上传 node_modules）」
- 不影响运行时代码

**测试结果**（2026-10-02 13:05，6 套件全绿）：

```
历史版本/scripts/check-encoding.js   ✓ 无语法错误、乱码、BOM
历史版本/scripts/check-changelog.js  ✓ 变更日志格式正常
tests/run-utils.test.js              通过 63 项
tests/run-cloudfunctions.test.js     通过 38 项
tests/check-project.js               ✓ 172 项（新增 5 项云函数根目录检查）
tests/check-cloudfunctions.js        ✓ 96 项
```

规则有效性验证：临时删除 `cloudfunctionRoot` → 检查器报
「存在 cloudfunctions/ 目录，但 project.config.json 缺少 cloudfunctionRoot」并返回退出码 1 → 还原。

另外确认了两个云函数的部署要件完整：
`xj-ai` 与 `xj-api` 都有 `index.js`、`package.json`、且都声明了 `wx-server-sdk` 依赖。

**遗留 / 待办**：
- 用户侧：刷新开发者工具后重试上传部署
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 12:45] 新增 · 一键初始化入口 system.setup + 灌数据自愈

**用户诉求**：「① 上传并部署两个云函数 ② 建集合并灌演示数据 …具体一点」
（用户要更细的可执行步骤；排查中发现分步调用存在真实的失败面）

**改动文件**：
- `cloudfunctions/xj-api/index.js` — 新增 `system.setup` 聚合入口；`seed.demo` 增加半成品自愈与状态回报
- `tests/run-cloudfunctions.test.js` — 新增 4 项测试覆盖新入口与自愈逻辑
- `历史版本\docs\DeepSeek与数据库接入施工方案.md` — 步骤 5 改为推荐一键初始化，补充 20 秒超时处理
- 云函数 `core/` — `scripts/sync-core.js` 重新同步

**根因（为什么需要这个改动）**：

排查用户操作步骤时发现两个真实问题：

1. **客户端单次调用硬超时 20 秒**（`core/config.js` 的 `cloud.timeout`），
   而灌数据要「建 7 个集合 + 插 40 条记录 + 跑全量匹配」，耗时接近这个上限。
   超时后云函数仍在后台执行，用户看到报错但实际可能成功——难以判断。
2. **分步调用会停在半成品状态**：若 `seed.demo` 在插完物品、还没跑匹配时被打断，
   再次调用 `seed.demo` 会因 `skipped: true` 直接返回，导致「有记录但候选列表为空」，
   而 `match.rerun` 是独立入口，用户不知道要用它恢复。

**方案**：

1. 新增 `system.setup`：一次做完「建集合 → 灌数据 → 补跑匹配」，
   返回逐步结果与统计，避免来回粘贴命令；
2. `seed.demo` 增加自愈：检测到「物品数 > 0 但匹配数 = 0」时自动补跑匹配，
   并在返回值里报告 `itemCount` / `matchCount` / `healed`，便于判断是否半成品；
3. **`reset` 默认值改为安全语义**：`system.setup` 不传 `reset` 时**不清空**已有数据
   （初次设计是 `reset !== false`，等于默认清空，风险太高，已改为 `reset === true`）。

**影响范围**：
- 新增 action `system.setup`，原有 action 全部保持兼容
- `seed.demo` 返回值新增字段（`itemCount`、`matchCount`、`healed`、`hint`），不破坏既有调用
- 用户在 Console 的调用方式更简单，且超时后有明确的恢复路径

**测试结果**（2026-10-02 12:45，6 套件全绿）：

```
历史版本/scripts/check-encoding.js   ✓ 无语法错误、乱码、BOM
历史版本/scripts/check-changelog.js  ✓ 变更日志格式正常
tests/run-utils.test.js              通过 63 项
tests/run-cloudfunctions.test.js     通过 38 项（新增 5 项）
tests/check-project.js               ✓ 167 项
tests/check-cloudfunctions.js        ✓ 96 项
```

新增测试覆盖：
- `system.setup` 步骤顺序正确（建集合 → 灌数据 → 补跑匹配）
- `system.setup` 后候选可检索（端到端可用，演示主线第一名正确）
- **不传 `reset` 时不清空已有数据**（安全默认，专门验证）
- `seed.demo` 自愈：清空全部匹配后调用，确认自动补出候选

排查过程中的一个虚警：`run-cloudfunctions.test.js` 在 PowerShell 下显示 `exit code 1`，
实际退出码是 **0**——PowerShell 把 stderr 上的 `console.warn`（未配置 DEEPSEEK_API_KEY 的预期提示）
当成了错误。已用重定向分别验证 stdout/stderr 确认。

**遗留 / 待办**：
- 用户侧：上传部署云函数 → 执行 `system.setup` → 设数据库权限 → 验证
- 答辩 PPT 仍未制作
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 12:25] 配置 · 填入云开发环境 ID，启用云端模式

**用户诉求**：「cloud1-d1g8bdwcp51d8918d 这是环境 ID」

**改动文件**：
- `core/config.js` — `cloud.enabled` 由 `false` 改为 `true`；`cloud.envId` 填入 `cloud1-d1g8bdwcp51d8918d`；补充 provider 切换的前置条件说明
- `cloudfunctions/xj-api/core/*`、`cloudfunctions/xj-ai/core/*` — 由 `scripts/sync-core.js` 重新同步

**方案**：

只填了环境 ID，**AI provider 仍保持 `local`**，这是有意的：

环境 ID 只是路由信息，填上就能连云端数据库，不依赖任何密钥。
而切换 `provider: 'deepseek'` 需要三个前提同时满足，缺一个都会导致云函数降级：

1. `xj-ai` 的环境变量里配好 `DEEPSEEK_API_KEY`
2. 重新部署 `xj-ai`（环境变量改动需重启实例才生效）
3. 本地先跑通 `ai-health.js` 自检

在未拿到 Key 之前切过去，只会让发布页显示「AI 服务暂不可用」。
所以先只开云端，AI 保持离线规则提取（功能完整可用）。

同时确认了一个设计决定：**`core/config.js` 故意不同步到云函数**。
云函数端的配置靠环境变量，若把小程序配置（含 envId）复制过去反而容易混淆。
已用 grep 确认云函数没有任何文件 `require` 它，因此不同步是安全的。

**影响范围**：
- 小程序启动后走云端模式：`wx.cloud.init({ env: 'cloud1-d1g8bdwcp51d8918d' })`
- 启动时拉快照，依次调用 5 个 action：`item.list`、`match.all`、`claim.mine`、`notify.list`、`user.me`
- 云端不可用时仍会自动降级本地模式，演示不中断
- 云函数代码更新（14 个共享文件 × 2 个函数）

**测试结果**（2026-10-02 12:25，6 套件全绿）：

```
历史版本/scripts/check-encoding.js   ✓ 无语法错误、乱码、BOM
历史版本/scripts/check-changelog.js  ✓ 变更日志格式正常
tests/run-utils.test.js              通过 63 项
tests/run-cloudfunctions.test.js     通过 33 项
tests/check-project.js               ✓ 167 项
tests/check-cloudfunctions.js        ✓ 96 项（core 同步状态正常）
```

额外做了启动链路模拟（用 wx.cloud 替身），确认：
- `cloudReady()` 返回 `true`
- `wx.cloud.init` 传入的环境 ID 正确
- 快照请求依次触发 5 个 action，返回结构完整

**遗留 / 待办**（用户侧操作，按顺序）：
1. 上传并部署 `xj-api` 与 `xj-ai`（右键 → 云端安装依赖）
2. Console 调 `system.init` 建 7 个集合
3. Console 调 `seed.demo` 灌演示数据
4. 数据库权限设为「仅创建者可读写」
5. 拿到 DeepSeek Key 后再做 AI 切换（见施工方案第 2 章）
6. 答辩 PPT 仍未制作
7. 9 个校园地点坐标待现场校准

---

### [2026-10-02 12:05] 修复 · 真机调试报「非法的文件 syntax-error」——项目内 .js 的 shebang

**用户诉求**：「真机调试 Error: 非法的文件，错误信息：invalid file: scripts/sync-core.js, 1:0 /
SyntaxError: Invalid or unexpected token / #!/usr/bin/env node」

**改动文件**：
- `scripts/sync-core.js` — 删除首行 shebang，并在文件头写清为什么不能加
- `project.config.json` — `packOptions.ignore` 排除 `scripts/`、`tests/` 与四个根目录文档；`ignoreDevUnusedFiles` / `ignoreUploadUnusedFiles` 改为 `true`
- `tests/check-project.js` — 新增第 9 组规则「小程序能否被开发者工具正常编译」；修正 `collect()` 的扫描范围（新增 `all` 选项）
- `AGENTS.md` — 新增「约定二之二：项目内的 .js 不许写 shebang」

**根因**：

`project.config.json` 的 `miniprogramRoot` 是 `"./"`，
微信开发者工具会**扫描项目内所有 `.js` 并解析**——包括 `scripts/` 与 `tests/` 这类开发工具，
而不是只扫描被页面引用的文件。

`scripts/sync-core.js` 第一行是 shebang：

```js
#!/usr/bin/env node
```

shebang 是 Unix 脚本的约定语法，**不是合法 JavaScript**。
Node 执行时会特殊处理它，但微信的编译器按纯 JS 解析，直接抛
`SyntaxError: Invalid or unexpected token`，报错位置正是 `1:0`。

这是我上一轮把构建工具留在项目里时引入的问题——之前项目根目录只有小程序代码，
加了 `scripts/` 之后编译器开始扫到它。

**方案**：

1. **删掉 shebang**（根治）：项目内脚本一律用 `node scripts/xxx.js` 调用，效果完全一样，不需要 shebang。
2. **排除开发目录**（防复发 + 减包体）：`packOptions.ignore` 加入 `scripts`、`tests` 两个目录，
   以及 `package.json`、`AGENTS.md`、`CHANGELOG.md`、`README.md` 四个根目录文件。
3. **打开未使用文件过滤**：`ignoreDevUnusedFiles` 与 `ignoreUploadUnusedFiles` 由 `false` 改为 `true`。
4. **加静态检查**：`tests/check-project.js` 新增规则，扫全项目任何 `.js` 的首行，
   发现 shebang 即报错；同时校验 `packOptions.ignore` 是否已排除 `scripts`/`tests`。

**影响范围**：
- 修复后打包内容为：`app.js` / `app.json` / `app.wxss` / `sitemap.json` / `project.*.json`
  / `pages` / `components` / `core` / `utils` / `mock` / `cloudfunctions`
- `scripts/` 与 `tests/` 不再进入小程序包（同时减小包体）
- 云函数不受影响（云开发上传单独进行）

**测试结果**（2026-10-02 12:10，6 套件全绿）：

```
历史版本/scripts/check-encoding.js   ✓ 无语法错误、乱码、BOM
历史版本/scripts/check-changelog.js  ✓ 变更日志格式正常
tests/run-utils.test.js              通过 63 项
tests/run-cloudfunctions.test.js     通过 33 项
tests/check-project.js               ✓ 167 项结构检查（含新增的可编译性规则）
tests/check-cloudfunctions.js        ✓ 96 项
```

规则有效性验证：给 `scripts/sync-core.js` 临时加回 shebang →
检查器报「文件带 shebang，微信开发者工具无法解析」并返回退出码 1 → 还原。

修复过程中发现的附带问题：验证脚本还原文件时给 `sync-core.js` 留下了一个多余的 `*/`，
导致语法错误，已修正并实际运行 `node scripts/sync-core.js` 确认可用（成功同步 28 个文件）。

**遗留 / 待办**：
- 答辩 PPT 仍未制作（唯一未交付项）
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 11:45] 重构 · 把文档工具迁到「历史版本」，项目只留业务代码与构建工具

**用户诉求**：「把创建 md 文档的相关程序都放在 `C:\Users\ASUS\Desktop\历史版本`，当前文件夹只保留小程序业务功能的代码」

**改动文件**：

新增（文档目录）：
- `历史版本\scripts\changelog-lib.js` — 新建。日志工具共享库：两处路径解析、时间戳、类型校验、记录头解析
- `历史版本\scripts\add-changelog.js` — 从项目迁入并重写（基于共享库，自动同时写两处日志）
- `历史版本\scripts\check-changelog.js` — 从项目迁入并重写（字段/占位符/新鲜度校验）
- `历史版本\scripts\check-encoding.js` — 从 `寻迹\tests\` 迁入并增强：**跨两个目录扫描**，按「项目业务代码 / 文档目录」分组报告
- `历史版本\scripts\ai-health.js` — 从项目迁入，改为用 `XUNJI_PROJECT` 解析项目路径
- `历史版本\docs\DeepSeek与数据库接入施工方案.md` — 新建。数据库 + DeepSeek 接入的逐步施工文档

删除（项目内）：
- `寻迹\scripts\add-changelog.js`
- `寻迹\scripts\check-changelog.js`
- `寻迹\scripts\ai-health.js`
- `寻迹\tests\check-encoding.js`

修改：
- `寻迹\package.json` — 6 个脚本改为指向 `../历史版本/scripts/`；`ai:health` 与 `log` 也改指文档目录
- `寻迹\AGENTS.md` — 更新 5 处工具路径引用：约定二、约定五、快速参考；新增「文档工具目录」章节说明分工
- `寻迹\README.md` — 1.2 节命令改为跨目录路径；1.3 节补充；**新增 1.4 节「目录分工」**

**方案**：

按「是否服务于运行时代码」划清边界，而不是简单按文件类型：

| 类别 | 归属 | 理由 |
| --- | --- | --- |
| 小程序业务代码（pages/components/core/utils/mock/cloudfunctions） | 项目 | 运行时必需 |
| 构建与部署工具（`sync-core`、`gen-campus`、`migrate-locations`） | **项目** | 它们生成运行时代码，删了以后改代码就没法同步 |
| 测试套件（`tests\`） | **项目** | 开发流程的一部分，不是文档 |
| 文档生成与管理工具 | 文档目录 | 只服务文档本身 |
| 文档本体 | 文档目录 | — |

**有意保留在项目根目录的两个文件**（与用户"只留业务代码"的字面要求略有出入，但必要）：

- `AGENTS.md` —— 需要被 AI 助手在**改代码时**自动加载。搬到文档目录后不再自动加载，
  「每次操作记日志」等 7 条约定会形同失效，机制直接失效。
- `CHANGELOG.md` —— 项目内技术日志的权威位置，`check-changelog.js` 校验它。

**影响范围**：

- 运行时代码**零改动**（迁移只涉及工具与文档）
- `npm test` 的 6 个套件路径变化，但对外命令不变
- 文档工具需在 `历史版本` 目录下执行，或从项目用 `npm run log` / `npm run ai:health` 转调
- 新增环境变量 `XUNJI_PROJECT` / `XUNJI_DOCS`，用于项目或文档目录被移动时指定路径

**测试结果**（2026-10-02 11:45，6 套件全绿）：

```
历史版本/scripts/check-encoding.js   ✓ 项目业务代码 102 文件 + 文档 8 文件，无语法错误、乱码、BOM
历史版本/scripts/check-changelog.js  ✓ 变更日志格式正常（跨目录读写两处验证通过）
tests/run-utils.test.js              通过 63 项，失败 0 项
tests/run-cloudfunctions.test.js     通过 33 项，失败 0 项
tests/check-project.js               ✓ 未发现结构性错误（106 项）
tests/check-cloudfunctions.js        ✓ 云函数结构与 core 同步正常（96 项）
```

迁移有效性验证：
- 从项目目录用 `../历史版本/scripts/...` 跨目录调用 → 成功
- 从文档目录生成日志骨架 → 确认两处日志都被写入（项目 CHANGELOG + 文档 CHANGELOG）→ 校验器报出未填占位符 → 还原
- `check-encoding.js` 的跨目录扫描捕获到 `寻迹项目开发总结.md` 第 557 行的**故意引用乱码示例**，已加入显式白名单

**遗留 / 待办**：
- 答辩 PPT 仍未制作（唯一未交付项）
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 11:30] 配置 · 建立变更日志机制与项目约定文件

**用户诉求**：「然后以后的每次操作都更新一份」（要求把每次操作都记录成日志）

**改动文件**：
- `AGENTS.md` — 新建。项目级约定，会被自动加载；含 7 条约定（日志、禁止 PowerShell 改源码、core 唯一来源、版本号递增、测试全绿、Key 隔离、诚实表达局限）
- `CHANGELOG.md` — 新建。本文件，完整变更记录
- `C:\Users\ASUS\Desktop\历史版本\CHANGELOG.md` — 新建。可读的历史汇总
- `scripts/add-changelog.js` — 新建。生成日志骨架并插入正确位置（两处同时写）
- `scripts/check-changelog.js` — 新建。校验日志存在性、必填字段、未填占位符、新鲜度
- `package.json` — `test` 流程加入日志校验；新增 `log` / `test:changelog` 命令
- `tests/check-encoding.js` — 新增乱码白名单（文档需引用乱码示例）

**方案**：
1. 规则写进 `AGENTS.md` —— 该文件会被 AI 助手自动加载，不依赖「记住」；
2. 日志写入两处：项目内 `CHANGELOG.md`（技术细节）+ 历史版本目录（可读汇总）；
3. 提供生成脚本与校验脚本，降低执行成本并提供兜底；
4. **把日志校验接入 `npm test --strict`**：日志过期超过 7 天或记录缺字段/有未填占位符，
   测试直接失败。这样「忘记写」会被测试拦住，而不是靠自觉；
5. 第 1–5 轮的历史变更（无日志期间）已在《寻迹项目开发总结.md》中完整记录，不重复回填。

**影响范围**：仅新增文件与构建脚本，不影响任何运行时代码。

**测试结果**（2026-10-02 11:35，6 个套件全绿）：

```
tests/check-encoding.js            ✓ 137 文件无语法错误、乱码、BOM
scripts/check-changelog.js --strict ✓ 变更日志格式正常
tests/run-utils.test.js            通过 63 项，失败 0 项
tests/run-cloudfunctions.test.js   通过 33 项，失败 0 项
tests/check-project.js             ✓ 未发现结构性错误（106 项）
tests/check-cloudfunctions.js      ✓ 云函数结构与 core 同步正常（96 项）
```

生成脚本与校验器均已做有效性验证：植入测试记录确认插入位置正确、确认校验器能报出遗忘的占位符，验证后还原。

**遗留 / 待办**：
- 答辩 PPT 仍未制作（唯一未交付项）
- 9 个校园地点坐标待现场校准

---

### [2026-10-02 11:14] 文档 · 输出开发总结文档到历史版本目录

**用户诉求**：「把上述操作整体总结为一个md文档，但不要保留在当前文件夹，保留到 `C:\Users\ASUS\Desktop\历史版本`」

**改动文件**：
- `C:\Users\ASUS\Desktop\历史版本\寻迹项目开发总结.md` — 新建。785 行 / 38 KB

**方案**：11 个章节——项目概况、技术架构、匹配算法、校园地点库、五轮开发过程、**12 个真实缺陷的根因分析**、测试体系、使用指南、待办与限制、开发规范与教训、关键文件索引。

**影响范围**：无代码改动；项目文件夹内未新增文档（仅原 `README.md`）。

**测试结果**：
- 文档完整性：785 行 / 13 个二级章节 / 56 个三级章节 / 7 个代码块 / 157 行表格
- 编码检查：无 BOM、无 U+FFFD；`鎺` 出现 1 次（第 557 行，为故意引用的乱码示例）
- 11 个缺陷编号 D1–D11 全部收录

**遗留 / 待办**：答辩 PPT。

---

## 归档说明（本文件创建之前的操作）

本文件创建于 2026-10-02。在此之前共完成 5 轮开发，**未逐条记录日志**，其完整内容已整理进
`C:\Users\ASUS\Desktop\历史版本\寻迹项目开发总结.md`，摘要如下：

| 轮次 | 主题 | 关键产出 | 修掉缺陷 |
| --- | --- | --- | --- |
| 1 | 阅读方案，搭建完整小程序 | 项目骨架 + utils 算法层 + 10 页面 + 3 组件 + 演示数据 + 2 个测试套件 | D1–D5 |
| 2 | 接入 DeepSeek + 云开发 | `core/` 共享层、`core/ai/*`、2 个云函数、同步与自检脚本、双模式数据层 | — |
| 3 | 江南大学蠡湖校区真实地点库 | 91 个地点（OSM + GCJ-02 转换）、`coord.js`、校准工具、11 项校区自检 | D6、D7 |
| 4 | 用户反馈：地图显示别的学校 | `campusVersion` 双重版本比对、地图视野重构、6 项防回归测试 | D8 |
| 5 | 用户反馈：图标点不动 / 首页白屏 / 顶栏滑不动 | `nav.js` 跨 tab 跳转、`check-encoding.js`、scroll-view 布局修正、3 组静态规则 | D9、D10、D11 |
