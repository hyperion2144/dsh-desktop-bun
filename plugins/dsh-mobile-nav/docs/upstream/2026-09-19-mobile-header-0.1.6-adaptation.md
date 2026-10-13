# 手机端会话头部与输入框的 0.1.6-alpha.2 适配对账（16 条，附可直接落地的 CSS）

> 2026-09-19。来源：DSHA 分支 `dsh-web-mobile@2.4.1-dsha.5`，宿主 DSH 0.1.6-alpha.2（client-ui / frontend 同为 0.1.6-alpha.2）。
> 只记结果与实测读数。几何全部取自真机：vivo V2463A / Android 16 / 360×754 CSS px / DPR 4 / `(max-width: 1023px) and (pointer: coarse)`。

## 1. 结论摘要

本仓库面向 0.1.5-rc 代的头部体系（`src/client/styles/layout.css.ts:644-1032`）在 0.1.6-alpha.2 上有 3 条直接失效：

| 规则 | a2 上的后果 |
|---|---|
| `layout.css.ts:726-732` `header > :first-child > :first-child{flex:1 1 auto}` | 该选择器落到 a2 新增的**空** `headerLeading` 座位上，空位吃掉全部剩余宽度 → 标题被推到中间、顶部多出一大块空白（把该座位改成 `flex:0 0 auto` 后实测 `w=0`，空白消失） |
| `layout.css.ts:893-897` `header > :first-child > :last-child{display:none}` | 0.1.5 这里藏的是会话日志胶囊，a2 的 `:last-child` 变成 `_headerCorner` → **右侧栏展开按钮被一起隐藏**（它是手机上打开右侧栏的唯一入口） |
| `layout.css.ts:675-677` `header[class*="_headerHidden"]{display:none}` | a2 改名 `headerBlank` 且 blank header 不再 `display:none`（与 `docs/upstream/2026-09-19-dsh-0.1.6-alpha.2-compat-audit.md` §10.2 C-1/E-2 同一条） |

其余 13 条按 a2 的实际 DOM 重新落锚（§2）。**代际门控（2026-09-19 复查修正）**：四类 a2 专属类（`_headerLeading/_crumbCurrent/_crumbSeg/_headerCorner`）之外的锚（`_titleCluster/_crumbs/_headerActions/_headerUtilities/tablist/QsffPG_/ZKlsPq_` 及 `:first-child` 结构链）在 0.1.5-rc 宿主上同样存在——初审「这些规则在 rc 宿主不命中」的说法不成立。因此**本块每条选择器都带 `header:has([class*="_headerLeading"])` 存在性门控**：整个块在 pre-alpha.2 宿主上是死规则，rc 宿主继续由既有实测规则治理，rc.6 行为与 main 按构造等价；反之，与 a2 新块冲突的旧规则（`position:static` 钳制）补 `:not(:has(...))` 排除门控，让新块在 a2 上不被旧高特异性声明压死。

## 2. 适配清单（16 条）

| # | 现象 | 根因 | 落锚 / 改法 | 真机读数 |
|---|---|---|---|---|
| 1 | 顶部一整块空白，标题被推到中间 | `layout.css.ts:726-732` 的老规则在 a2 命中**空的** `headerLeading` | 该座位 `flex:0 0 auto; width:auto`，保留 `:empty{display:none}` | 座位 `[40,20,0,0]`、`shown=false` |
| 2 | 头部变三行 | a2 下 `titleCluster` 被拆两行 | `titleCluster` nowrap、`crumbs` 自适应、`headerActions` 回行内 | `header` 高 69.5（原 76） |
| 3 | 状态栏到内容留白偏多 | 宿主 `padding-top:10px` + `min-height:76px` | 两处清零 | 同上 |
| 4 | 标题与预设/文件互抢 | 面包屑整条无上限 | `crumbs{flex:1 1 auto;min-width:72px}`，每段 `max-width:100px`（6 字）+ `touch-action:pan-x` | 当前段按钮 `w=100`、`overflow-x:auto`、可滚 88px、**滚动条厚度 0** |
| 5 | 进子代理会话头部叠在一起 | 面包屑出现「父/子」两段，父段无窗口 | 所有 `crumbSeg > button` 同样限 6 字 + 可滑 | 两段时 `crumbs w=230`，当前段仍 `w=100` |
| 6 | 预设名被压成「图标+一条缝」 | 外层 anchor 覆盖成 `width:auto`、内层 `width:100%` → 父子循环依赖 | anchor 恢复 `width:max-content`；保留 `padding-left:18px` | 预设 `w=110`（不是 18px 纯图标） |
| 7 | 预设名过长顶到标题 | 无上限 | `max-width: min(40vw,130px)` + `overflow:hidden` | 生效（`max-width:130px`） |
| 8 | 右上角「⋯」成唯一入口，右侧栏打不开 | 见 §1 第 2 条 | 用更高优先级放行 `corner` 并给 36px 触控；窄屏隐藏 `headerUtilities` | 展开按钮 `[316,2,36,36]`；`utilities` `display:none` |
| 9 | 开后台任务后动作行互相重叠 | 动作行已被「标题 6 字 + 预设 + 文件」占满 | 后台任务 chip 绝对定位到标签行右侧；标签行按需预留 118px；**chip root 补 `display:flex`**（见下条注） | chip `[264,44,88,25]`、`right:8px`、`bottom:0`、`h:25`、`max-width:118px`；标签行 `padding-right` 8→**118** |
| 9 注 | 后台任务 chip 内容比标签行低 6.8px、挂出 header 下沿 | 宿主 `.QsffPG_root` 只声明 `position:relative` → **block 容器**，原规则里的 `align-items:stretch` 在 block 上无效，里面 `display:inline-flex` 的按钮按**基线**落位（谱系 chip 的 `.ZKlsPq_root` 本身是 inline-flex，所以只有 jobs 这个坏） | 该 root 补 `display:flex !important` | 偏移 **6.8 → 0**；trigger 盒子与 root 重合、底边比 header 下沿高 0.5px，与标签按钮 `[16,44,26,25]`、谱系 chip 同一套盒模型（y=44 / h=25 / 下内边距 9px）→ 文字中线齐平 |
| 10 | 子代理 chip 同样挤 | 同 9 | 谱系 chip 绝对定位到标签行空白区居中 | 无 jobs 时 `[178.9,44,98.3,25]`；有 jobs 时 `right:126px` → `[119.9,44,98.3,25]`，两 chip **不重叠** |
| 11 | chip 与「对话/轨迹」不齐平（低 7px） | 宿主 `min-height:76px`、内容仅 ~69px → 底部垫 7.6px 空白 | `header{min-height:0}`；两个状态 chip 镜像标签盒模型（`h:25px + bottom:0 + padding-bottom:9px`） | chip 与 tablist 同为 `y=44 h=25` |
| 12 | 头部弹层点开像没反应 | 弹层左缘跟着 chip 走 → 336px 面板被推出视口；绝对定位面板还会被 `headerActions` 的 `overflow:auto` 裁掉 | 统一改视口定位：`position:fixed; left:8px; right:8px; top:calc(safe-area + 80px)` | 实测菜单 `[8,80,344,40]`、完全在视口内 |
| 13 | 标签 ≥3 时 chip 与标签重叠 | 居中区左边界写死 104px（＝「对话/轨迹」两段宽） | `:has()` 按标签数切换：≥3 时不再居中、改右靠（`right:8px`；有 jobs 时 `126px`） | 合成第三标签：chip `185.7 → 267.4`、与标签不重叠；拆掉后回 `185.7` |
| 14 | 标题下面多出一条灰色滑条 | 第 4/5 条让面包屑可横滑（`overflow-x:auto`，`scrollWidth-clientWidth=88`），WebView 就画出原生滚动条 | 整个会话头部统一 `::-webkit-scrollbar{display:none}`（本机 `CSS.supports('scrollbar-width','none')===false`，标准属性无效） | 像素实测滑条 `x=40.0~89.5`、高 7.8、拇指宽 ≈50（＝100×100/188）；改后浏览器不再绘制 |
| 15 | 输入卡片中间一大块空白（文字在顶部、按钮在底部） | **宿主自身**样式：`.uV2eYG_card{padding-top:8px; gap:12px}` + `.uV2eYG_row{padding:2px 8px 6px}`；单行输入时 98px 卡片里 29px 是纯空白 | 只压纵向：卡片 `padding-top:2px / gap:4px`、行 `padding:0 8px`、编辑器 `min-height:28px / padding-top:2px` | 卡片 98→**78**、编辑器 36→32、按钮行 42→36、文字底→按钮顶 29→**19px**（moderate 档真机读数，与 CSS 注释对齐；早期读数 70/28/34/10 为调音前测值） |
| 16 | 标签行右缘越过 header 8px，使 118px 预留有 8px 落在屏外 | 宿主标签行满宽且 `content-box`，`padding-right` 把它顶到 `x=8..368` | 标签行补 `box-sizing: border-box` | 盒子 `[8,44,344,25]`；`header.scrollWidth-clientWidth` **8 → 0**；带 jobs 时预留 118px 下仍为 0 |

## 3. 与既有体系冲突检查（AGENTS.md:208）

| 本次条目 | 本仓库既有机制 | 判定 |
|---|---|---|
| 1 / 3 / 11 | `layout.css.ts:933-962`（`header:has(> *){min-height:0; grid-template-rows:…}`）、`:658-662`（header padding） | **互补**：同一诉求、锚点代际不同。注意 `:has(> *)` 门控**必须保留**（否则 hero 空 header 会被压，composer 位移） |
| 2 | 既有头部本就是单行形态 | **不冲突**（a2 下是被结构变化拆开的） |
| 4 / 5 | `layout.css.ts:779-786`（`crumbs{flex:1 1 0;min-width:30%}`） | **互补**：既有只有下限、无上限；a2 的 `crumbSeg` 是本代新物 |
| 6 / 7 | `layout.css.ts:796-815`（模式名 `max-width:min(38vw,220px)` + `padding-left:18px` 让位） | **可能冗余**：若 a2 下该选择器仍命中预设 chip，本次 6/7 可砍。请以真机 `elementFromPoint` 判定 |
| 8 | `:866-889`（`headerUtilities` 释放/限高 + More 按钮隐藏）、`:893-897`（行尾胶囊隐藏） | **冲突（需注意）**：a2 下 `:last-child` 会误伤 `_headerCorner`。建议改成按类名/位置限定，而不是 `:last-child` |
| 9 / 10 | `:836-857`（chip 留流内钉宽 + `max-width:min(40vw,180px)`）、`:972-1014`（拥挤三档，≤440px 隐藏 jobs 文字标签） | **取向不同**：本次是「搬出文档流 + 绝对定位」，既有是「留流内钉宽 + 拥挤隐藏标签」。两条都成立，**不应并存**，请择一 |
| 9 注 | 既有对 chip 的处理假定 root 是 flex（```align-items``` 生效） | **互补的缺陷修复**：a2 的 jobs root 是 block，单靠 `align-items` 不成立 |
| 12 | `:1016-1032`（菜单钳制 `right:8px; width:min(336px,…)`）+ `:658-661`/`:696-698`（包含块两半） | **可合并**：`fixed` 视口定位能彻底脱离 `headerActions` 的 `overflow:auto` 裁剪；若沿用既有的钳制路线，则 a2 下仍需验证 chip 位置左移后是否仍成立 |
| 13 / 14 / 16 | `:898-932`（tab strip 五件套，含隐藏滚动条） | **互补**：既有只隐藏 strip 自己的滚动条；14 覆盖头部其它滚动容器，13/16 是本代新物 |
| 15 | 无（本仓库 composer 规则只管字号轴与 safe-area） | **新增**：定性是"压缩宿主留白"，不是修 bug —— 那两条声明出自宿主 `dsh-client-ui-conversation`，逐条拉 `document.styleSheets` 命中规则确认过**无一条来自插件** |

## 4. CSS 与落位

- **段 A**（移动端：右侧栏/文件面板/输入区字号 + 输入卡片压缩）：并入 `src/client/styles/layout.css.ts` 现有移动块（当前 `6..1187`）**内**，按嵌套深度缩进；
- **段 B**（`(min-width: 1024px) and (pointer: coarse)`）：本仓库白名单内的顶层 at-rule，可独立成块；
- **段 C**（移动端头部 14 条）：同段 A。
- 实测：把段 C 以**新的顶层** `@media (max-width: 1023px) and (pointer: coarse)` 追加时，`node scripts/css-structure-check.mjs` 仍报 `4 modules, 0 fatal`（只是风格冗余，不触门）；推荐并入现有块，避免重复媒体查询。
- 约束核对（已过）：无裸哈希类选择器；含 `wSkVaW_` 的行不含 `{`，不触 `tests/docs-consistency.test.ts` 的作用域断言；`/* */` 与 `{}` 配平；模板串内**无反引号**。

```css
/* ===== 段 A：移动端右侧栏 / 文件面板 / 输入区 ===== */
@media (max-width: 1023px) and (pointer: coarse) {
  [data-mobile-nav="frame"] [data-rightbar-col] {
    position: fixed !important; inset: 0 !important; width: 100vw !important;
    height: 100% !important; z-index: 35; pointer-events: none;
  }
  [data-mobile-nav="frame"] [data-sidebar-right-panel] {
    width: 100% !important; max-width: 100vw !important;
    box-sizing: border-box; padding-top: env(safe-area-inset-top, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  [data-sidebar-right-panel][data-sidebar-right-open] { pointer-events: auto; }
  /* 标签关闭按钮由上游按 20px 居中定位，不能套用普通工具按钮的最小高度。 */
  [data-sidebar-right-panel] button:not([data-dockkit-tab-close]) { min-height: 32px; }
  /* DSHA：输入文字缩小一级；编辑层、占位符与高度测量层使用同一字号。 */
  html:not([data-mobile-nav-ios]) [data-composer-card] {
    --dsh-content-font-size: 13px;
  }
  html:not([data-mobile-nav-ios]) [data-composer-card] [data-composer-input],
  html:not([data-mobile-nav-ios]) [data-composer-card] [data-composer-placeholder],
  html:not([data-mobile-nav-ios]) [data-composer-card] textarea,
  html:not([data-mobile-nav-ios]) [data-composer-card] [data-input-mirror],
  html:not([data-mobile-nav-ios]) [data-composer-card] [data-input-backdrop] {
    font-size: 13px !important;
    line-height: 1.5 !important;
  }
  /* DSHA：输入卡片自身留白偏大。宿主那两声明全出自它自己的
     dsh-client-ui-conversation（.uV2eYG_card 是 padding-top:8px + gap:12px，
     .uV2eYG_row 再吃 padding:2px 8px 6px），单行输入时卡片 98px 里有 29px
     是纯空白。手机上只压纵向留白（真机实测 moderate 档）：
       卡片 98 -> 78、编辑器 36 -> 32、按钮行 42 -> 36、文字底到按钮顶 29 -> 19px。
     横向 padding（8px）与两个按钮尺寸（28/34px）一律不动，触控目标不变；
     编辑器仍是可增长的多行框（max-height 336px），只是单行时不再垫高。 */
  [data-mobile-nav="frame"] [data-composer-card] {
    padding-top: 2px !important;
    gap: 4px !important;
  }
  [data-mobile-nav="frame"] [data-composer-card] [class*="_row"] {
    padding: 0 8px !important;
  }
  [data-mobile-nav="frame"] [data-composer-card] [data-composer-input],
  [data-mobile-nav="frame"] [data-composer-card] [class*="_scroll"] {
    min-height: 28px !important;
    padding-top: 2px !important;
  }
}

/* ===== 段 B：宽屏触控（桌面鼠标不受影响） ===== */
/* DSHA：宽屏触控保留文件入口，预设和文件靠右；鼠标桌面规则保持不变。 */
@media (min-width: 1024px) and (pointer: coarse) {
  [data-phase] header [class*="_headerActions"] {
    margin-inline-start: auto;
    gap: 4px;
  }
  [data-phase] header .dsha-preset-header-anchor {
    order: 90;
    flex: 0 1 auto;
    min-width: 0;
    max-width: 220px;
  }
  [data-phase] header [data-mobile-nav="files"] {
    display: inline-flex !important;
    order: 100;
    position: static !important;
    width: 44px;
    height: 44px;
    flex: none;
  }
}

/* ===== 段 C：移动端会话头部 14 条 ===== */
@media (max-width: 1023px) and (pointer: coarse) {
  [data-mobile-nav="frame"] [data-phase] header {
    /* 顶部留白收窄：宿主 header 自带 padding-top: 10px、标题行再垫 2px，
       叠在刘海/状态栏避让之上就显空。这两处一起清零。 */
    padding-left: 8px !important;
    padding-right: 8px !important;
    padding-top: 0 !important;
    /* 宿主 header 有 min-height: 76px，而内容只有 ~69px，底部会垫出 7.6px 空白
       （实测：标签行底边 106，header 底边 113.6）。贴底定位的状态 chip 会被这
       段空白顶下去、和标签行错开。手机上让 header 贴住内容高度。 */
    min-height: 0 !important;
  }
  [data-mobile-nav="frame"] [data-phase] header > :first-child {
    flex-wrap: nowrap !important;
    align-items: center !important;
    gap: 0 !important;
    padding-left: 32px !important;
    padding-right: 0 !important;
    padding-top: 0 !important;
  }
  /* 目录开关跟着一起上移，保持与标题/按钮同一行居中。 */
  [data-mobile-nav="frame"] [data-mobile-nav="toggle"] {
    top: 6px !important;
  }
  [data-mobile-nav="frame"] [data-phase] header [class*="_headerLeading"]:empty {
    display: none !important;
  }
  /* 0.1.6 的新头部里，titleRow 的第一个孩子是新增的空座位
     headerLeading（macOS 桌面控件，安卓上渲染 null）。插件按 0.1.5 老结构
     写的「header > :first-child > :first-child { flex: 1 1 auto }」现在套在
     这个空座位上，于是它吃掉全部剩余宽度、把标题顶到右侧（实测 411px 宽
     屏幕上标题被推到 131px 处）。让它不参与伸缩即可——有内容时也不会塌。 */
  [data-mobile-nav="frame"] [data-phase] header > :first-child > :first-child {
    flex: 0 0 auto !important;
    width: auto !important;
    min-width: 0 !important;
    gap: 0 !important;
  }
  [data-mobile-nav="frame"] [data-phase] header [class*="_titleCluster"] {
    display: flex !important;
    flex-wrap: nowrap !important;
    flex: 1 1 auto !important;
    width: auto !important;
    max-width: none !important;
    min-width: 0 !important;
    min-height: 40px !important;
    gap: 0 6px !important;
    justify-content: flex-start !important;
    align-items: center !important;
  }
  [data-mobile-nav="frame"] [data-phase] header [class*="_titleCluster"] > [class*="_crumbs"] {
    /* 标题改成自适应：面包屑条吃掉动作区之外的剩余宽度，标题多长就显示多少，
       装不下时由每一段自己的滑动窗口（见下）横向滑。min-width 保底 4 字，
       防止预设名字很长时把标题挤没。 */
    flex: 1 1 auto !important;
    width: auto !important;
    min-width: 72px !important;
    max-width: none !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
    min-height: 0 !important;
    padding-right: 0 !important;
    overflow: visible !important;
    white-space: nowrap !important;
  }
  /* 标题本体：自适应宽度 + 横向滑动。宽度由上面面包屑条的剩余空间决定，
     装不下时在本段内左右滑（touch-action: pan-x 让浏览器先认领横滑，
     左缘抽屉手势不会抢走这一笔）。 */
  [data-mobile-nav="frame"] [data-phase] header [class*="_crumbs"] [class*="_crumbCurrent"] {
    flex: 0 1 auto !important;
    width: auto !important;
    min-width: 0 !important;
    /* 6 个汉字上限：6×14px + 左右 padding 16px = 100px。再长就在本段内横滑，
       这样标题永远不会顶到右侧的预设。 */
    max-width: 100px !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    text-overflow: clip !important;
    white-space: nowrap !important;
    text-align: left !important;
    justify-content: flex-start !important;
    touch-action: pan-x !important;
    overscroll-behavior-x: contain !important;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  [data-mobile-nav="frame"] [data-phase] header [class*="_crumbs"] [class*="_crumbCurrent"]::-webkit-scrollbar {
    display: none;
  }
  /* 面包屑的父会话段同样是 <button>，不设窗口就会顶出去（子代理会话实测）。 */
  [data-mobile-nav="frame"] [data-phase] header [class*="_crumbs"] [class*="_crumbSeg"] > button {
    flex: 0 1 auto !important;
    min-width: 0 !important;
    max-width: 100px !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    text-overflow: clip !important;
    white-space: nowrap !important;
    text-align: left !important;
    touch-action: pan-x !important;
    overscroll-behavior-x: contain !important;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  [data-mobile-nav="frame"] [data-phase] header [class*="_crumbs"] [class*="_crumbSeg"] {
    flex: 0 1 auto !important;
    min-width: 0 !important;
    justify-content: flex-start !important;
  }
  [data-mobile-nav="frame"] [data-phase] header [class*="_headerActions"] {
    flex: 0 1 auto !important;
    width: auto !important;
    max-width: none !important;
    min-height: 36px !important;
    margin-left: auto !important;
    padding: 0 !important;
    border-top: 0 !important;
    justify-content: flex-end !important;
    gap: 6px !important;
    overflow-x: auto !important;
    scrollbar-width: none;
  }
  [data-mobile-nav="frame"] [data-phase] header [class*="_headerActions"]::-webkit-scrollbar {
    display: none;
  }
  [data-mobile-nav="frame"] [data-phase] header .dsha-preset-header-anchor {
    /* 预设 chip 完整显示：不截断名字。宽度必须是 max-content——里面的按钮
       是 width:100%，锚点若给 auto 就形成「父靠子、子靠父」的循环依赖，
       浏览器会算出接近 0 的宽度，只剩图标加一条缝。 */
    flex: 0 0 auto !important;
    width: max-content !important;
    min-width: 0 !important;
    /* 预设名 5 个字上限：图标 20 + 5×13px 字号 65 + 箭头 16 + 内边距/缝隙 ≈ 125，
       卡在 130px；名字更长时由内部 span 自己打省略号（不会顶到/钻进标题）。
       同时给 overflow: hidden 兜底，避免任何子元素溢出到标题上。 */
    max-width: min(40vw, 130px) !important;
    overflow: hidden !important;
    overflow: visible !important;
    margin-left: auto !important;
  }
  [data-mobile-nav="frame"] [data-phase] header .dsha-preset-header-anchor [data-dsha-agent-preset="header"] {
    height: 36px !important;
    min-height: 36px !important;
    padding: 0 6px !important;
  }
  /* 预设按钮的「完整显示」解禁：插件在 ≤559px / ≤440px 两档里，只要面包屑
     出现子代理（lineage root），就把「模式标签」压成 18px 纯图标
     （max-width/min-width: 18px + padding-left: 18px）。本 DSHA 构建里那个
     模式标签就是预设按钮（.SVAs4q_label），所以子代理一出现，预设名就被吃
     掉只剩图标。这里把宽度限制和左侧留白复原，让名字完整显示。 */
  [data-mobile-nav="frame"] [data-phase] header [class*="_headerActions"] [class*="_label"]:has(> svg) {
    max-width: none !important;
    min-width: 0 !important;
    width: max-content !important;
    /* 左内边距必须留着 18px：图标是绝对定位在 left:0，靠它避让，改小会压住文字。 */
    padding-left: 18px !important;
  }
  [data-mobile-nav="frame"] [data-phase] header [data-mobile-nav="files"] {
    width: 36px !important;
    height: 36px !important;
    flex: 0 0 36px !important;
  }
  /* 右上角换人：0.1.6 把「右侧栏展开按钮」放进了 headerCorner，而插件的
     老规则「header > :first-child > :last-child 显示 none」在 0.1.5
     藏的是「会话日志胶囊」；新结构里 titleRow 的 :last-child 变成 corner，
     于是右侧栏入口被误藏、面板在手机上打不开。这里把 corner 放出来，
     同时让出「⋯」菜单那一格（360px 一行塞不下两个）。 */
  [data-mobile-nav="frame"] [data-phase] header > :first-child > :last-child[class*="_headerCorner"] {
    display: flex !important;
    flex: 0 0 auto !important;
    margin-left: 4px !important;
    margin-right: 0 !important;
  }
  [data-mobile-nav="frame"] [data-phase] header [class*="_headerCorner"] button {
    width: 36px !important;
    height: 36px !important;
    min-width: 36px !important;
    min-height: 36px !important;
  }
  [data-mobile-nav="frame"] [data-phase] header [class*="_headerUtilities"] {
    display: none !important;
  }
  [data-mobile-nav="frame"] [data-phase] header [role="tablist"] {
    width: 100% !important;
    margin-top: 4px !important;
  }
  /* 标签行右侧的两个状态 chip：
     · 后台任务 chip（dsh-client-ui-jobs 的 QsffPG_root）
     · 子代理谱系 chip（dsh-client-ui-subagent 的 ZKlsPq_root）
     它们在动作行里会和标题窗口 + 预设 + 文件抢同一条 flex，实测直接叠在一起
     （进子代理会话时最明显）。两块都绝对定位到「对话/轨迹」行右侧，动作行只留
     [预设][文件]；标签行右侧按 chip 宽度预留，标签变多横向滑动也不会钻到下面。
     两个 chip 同时存在时，子代理排在后台任务左边。 */
  [data-mobile-nav="frame"] [data-phase] header {
    position: relative !important;
  }
  [data-mobile-nav="frame"] [data-phase] header [role="tablist"] {
    padding-right: 8px !important;
    /* 宿主的标签行宽度是满宽、默认 content-box，加 padding 会把它顶到
       x=8..368（右缘越过 header 右缘 360 共 8px，header.scrollWidth-clientWidth=8），
       也就是下面那条 118px 预留里有 8px 落在屏外。补 border-box 把它收回来，
       预留才是"整整 118px"。 */
    box-sizing: border-box !important;
  }
  [data-mobile-nav="frame"] [data-phase] header:has([class*="QsffPG_root"]) [role="tablist"] {
    padding-right: 118px !important;
  }
  [data-mobile-nav="frame"] [data-phase] header [class*="_headerActions"] [class*="QsffPG_root"] {
    position: absolute !important;
    right: 8px !important;
    /* 和子代理 chip 同一套：贴 header 底边 + 下内边距 9px = 与标签文字齐平。 */
    bottom: 0 !important;
    height: 25px !important;
    min-height: 25px !important;
    /* 必须显式 flex：宿主 .QsffPG_root 只声明了 position:relative，是 block 容器，
       下面那条 align-items 在 block 上完全无效 —— 里面的 inline-flex 按钮会按基线
       落位，实测低 6.8px、内容挂出 header 下沿（69.5 -> 75.8），和第 11 条那类
       "chip 与标签行不齐平"是同一毛病。谱系 chip 的 .ZKlsPq_root 本身就是
       inline-flex，所以只有 jobs 这个 root 需要补。 */
    display: flex !important;
    align-items: stretch !important;
    z-index: 3 !important;
    margin: 0 !important;
    min-width: 0 !important;
    max-width: 118px !important;
    flex: 0 0 auto !important;
  }
  [data-mobile-nav="frame"] [data-phase] header [class*="QsffPG_root"] > button {
    height: 25px !important;
    min-height: 25px !important;
    padding: 0 2px 9px !important;
    line-height: 16px !important;
    align-items: center !important;
  }
  /* 头部弹层定位（jobs 任务列表 / subagent 谱系 / 预设菜单都会命中的同一族）：
     插件老规则是「弹层左缘 = chip 左缘 + 8px」，那条规则成立的年代 chip 都
     贴着 header 左缘；现在标题窗口 72px + 子代理 chip + 预设都靠中右，336px
     宽的面板会被整体推到视口外 —— 点开就像没反应。
     统一改成视口定位：贴在 header 下方、左右各留 8px 满宽展开；顺带脱离
     headerActions 的 overflow 裁剪（绝对定位的面板会被那个 auto 裁掉）。 */
  [data-mobile-nav="frame"] [data-phase] header [class*="_menu"]:not([class*="_menuAnchor"]) {
    position: fixed !important;
    left: 8px !important;
    right: 8px !important;
    top: calc(env(safe-area-inset-top, 0px) + 80px) !important;
    bottom: auto !important;
    width: auto !important;
    max-width: none !important;
    max-height: calc(100dvh - 96px) !important;
  }
  /* 子代理谱系 chip（ZKlsPq_root）：0.1.6 把它渲染在标题面包屑内部。进子代理
     会话时面包屑变成「父会话 / 当前会话」两段 + 这个 chip，动作行就叠在一起，
     所以整块搬到「对话/轨迹」这一行的空白区里居中，并与标签文字纵向对齐。 */
  [data-mobile-nav="frame"] [data-phase] header [class*="ZKlsPq_root"] {
    position: absolute !important;
    /* 在「标签右侧的空白区」里居中（左边界让开对话/轨迹，约 104px），
       比整行居中往右一些。 */
    left: 104px !important;
    right: 8px !important;
    /* 纵向对齐标签：直接镜像标签的盒模型 —— 标签是「16px 行高 + 9px 下内边距」，
       总高 25px 且贴着 header 底边。chip 也做成 25px 高、bottom:0、下内边距 9px，
       内容区正好落在同一段 16px 里，文字必然与「对话/轨迹」齐平。 */
    bottom: 0 !important;
    height: 25px !important;
    min-height: 25px !important;
    align-items: stretch !important;
    z-index: 3 !important;
    margin: 0 auto !important;
    width: max-content !important;
    min-width: 0 !important;
    max-width: min(32vw, 116px) !important;
    flex: 0 0 auto !important;
  }
  /* 后台任务 chip 也在标签行时，往左让出它那一格，仍保持居中。 */
  [data-mobile-nav="frame"] [data-phase] header:has([class*="QsffPG_root"]) [class*="ZKlsPq_root"] {
    right: 126px !important;
  }
  [data-mobile-nav="frame"] [data-phase] header [class*="ZKlsPq_root"] > button {
    height: 25px !important;
    min-height: 25px !important;
    line-height: 16px !important;
    padding: 0 4px 9px !important;
    align-items: center !important;
  }
  /* 已知边界（交接文档第 5.5 节第一条）：标签行出现第三个标签时，标签总宽约
     252px，已经越过子代理 chip 居中区的左边界（104px），两者会叠在一起。
     这里用 :has() 按标签数量切换策略 —— ≥3 个标签时不再居中，改成停靠在标签行
     右侧的空白区（右缘 8px；有后台任务 chip 时让到 126px）。标签行本身可横向
     滑动，chip 不会被挤到下面，也不再盖住第三个标签：
       chip 占 268~352（宽 84），标签止于 8+252=260，右侧余量 8px。
     两个变体并列，兼容「tab 是 tablist 直接子按钮」与「tab 被容器包裹」两种渲染；
     权重 (0,5,2)/(0,6,2)，高于上面两条既有规则，不依赖书写顺序。 */
  [data-mobile-nav="frame"] [data-phase] header:has([role="tablist"] button:nth-of-type(3)) [class*="ZKlsPq_root"],
  [data-mobile-nav="frame"] [data-phase] header:has([role="tablist"] > button:nth-child(3)) [class*="ZKlsPq_root"] {
    left: auto !important;
    right: 8px !important;
    margin: 0 !important;
  }
  [data-mobile-nav="frame"] [data-phase] header:has([role="tablist"] button:nth-of-type(3)):has([class*="QsffPG_root"]) [class*="ZKlsPq_root"],
  [data-mobile-nav="frame"] [data-phase] header:has([role="tablist"] > button:nth-child(3)):has([class*="QsffPG_root"]) [class*="ZKlsPq_root"] {
    right: 126px !important;
  }
  /* 真机反馈：「标题下面多了一条灰色滑条」。第 4/5 条为了让长标题能左右拖着看，
     把面包屑做成了横向滚动容器 —— 实测 button.wSkVaW_crumb: overflow-x:auto、
     scrollWidth − clientWidth = 88；像素实测那条灰条是 x=40.0~89.5、高 7.8、
     拇指宽 ≈50 的圆角滚动条（100×100/188 ≈ 53，吻合）。
     本机 WebView 不认 scrollbar-width（CSS.supports 为 false），只有
     ::-webkit-scrollbar 生效；而且滚动条是「经典占位式」的 8px（合成容器实测
     offsetHeight − clientHeight = 8）。所以这里对整个会话头部统一掐掉滚动条：
     滑动能力保留，视觉上不再多一条。头部里任何位置的滚动条在 360px 宽的手机上
     都不是想要的，故不再按具体类名收窄范围。 */
  [data-mobile-nav="frame"] [data-phase] header,
  [data-mobile-nav="frame"] [data-phase] header * {
    scrollbar-width: none !important;
    -ms-overflow-style: none !important;
  }
  [data-mobile-nav="frame"] [data-phase] header::-webkit-scrollbar,
  [data-mobile-nav="frame"] [data-phase] header *::-webkit-scrollbar {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
  }
  /* 谱系 chip 里的文字（子代理标题 /「N 个子代理」）给一个规矩的省略号窗口：
     不要裁成半个字，也不要靠滚动去够剩下的字。 */
  [data-mobile-nav="frame"] [data-phase] header [class*="ZKlsPq_root"] span {
    display: block !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
    min-width: 0 !important;
    max-width: 100% !important;
  }
}
```

## 5. 验证方式（可复现）

1. **真机页内探针**：把一段临时探针注入 client bundle，量目标元素的 `tag/class/rect/computed` 并 POST 到容器内 `127.0.0.1:3199` 的接收端（与 `?mobile-nav-debug=1` 的 beacon 同一思路）。**不需要无障碍服务、不写剪贴板**。
2. **像素扫描**：对真机截图逐行统计灰/深色像素定位边框与墨迹（例：输入卡片上/下边框 `y=9 / 107.5` → 卡片高 98.5，与 DOM `h=98` 吻合；灰滑条 `x=40.0~89.5 / 高 7.8`）。
3. **合成 DOM**：对"标签 ≥3 才生效""弹层视口定位""后台任务 chip"这类难以自然触发的分支，用**真类名**临时造元素（克隆第三个标签 / 造 `QsffPG_root` 与 `QsffPG_menu`），量完即拆。
4. **对照实验**：验证滚动条抑制时同页造两个合成滚动容器（一个在 `body`、一个在头部），前者 `offsetHeight-clientHeight=8`、后者 `=0`，证明规则生效且未影响页面其它部分。
5. **不变量**：`header.scrollWidth-clientWidth`（溢出）与各 chip 的 `rect` 在开/关菜单、增删 chip 前后应回到基线（本次实测均可还原，无脏状态）。

## 6. 裁定记录（原「待裁定」，2026-09-19 已裁）

1. **#8 的代际冲突**：已按建议改锚——新块以 `:last-child[class*="_headerCorner"]`（(0,5,1)）压过旧 `:last-child` 藏匿规则（(0,4,1)），corner 在 a2 放出、rc.6 的会话日志胶囊继续被旧规则藏。
2. **#9/#10 的取向**：**a2 取「搬出文档流 + 绝对定位」体系，rc 保留「留流内钉宽 + 拥挤隐藏标签」体系**。旧 `position:static` 钳制规则补 `:not(:has([class*="_headerLeading"]))` 排除门控（初审实测：旧规则特异性 (0,6,2) 高于新绝对定位 (0,4,1)，不打门控时 static 在 a2 也赢，#9 修复失效）；旧钉宽/拥挤三档的残余声明在 a2 上要么被新规则 `!important` 压过、要么前提（chip 在行内）已不成立，不再另加门控。
3. **#12 的弹层定位**：a2 取 `position:fixed` 视口定位（新规则特异性更高，a2 上覆盖旧钳制）；旧「钳制 + 包含块两半」规则原样保留给 rc.6（其在 rc.6 上是实测 [46,77,336,73] 的承载）。

另：空头部隐藏在 a2 补了新锚——a2 把 `headerHidden` 改名 `headerBlank` 且不再自带 `display:none`，新增 `header[class*="headerBlank"]{display:none}` 与旧规则并列覆盖两代；探针 5b/6b 断言同步接受两类名。

## 7. 未覆盖

- 本文读数全部来自 0.1.6-alpha.2 真机；rc.6 宿主上**按构造**不受影响（全块 `_headerLeading` 存在性门控），但未在 rc.6 真机上逐条复测观感——门控的意义正是让这不必要。
- 后台任务 chip 在本插件链路里**没有自然生产者**（持久版 bash 不登记 job；后台子代理是 `continuable` 不是 job），故 #9 用**真类名合成**验证；**复查发现合成 fixture 未带 `> button[class*="_trigger"]` 子节点，复现不出旧 static 规则的互压**——已用 `:not` 排除门控修掉（§6.2），真实出现时的表现仍建议顺手看一眼。
- 对角双钮（toggle/files）几何为静态推算（中心对齐 top 2px），未经真机像素复测。
