# 右缘文件面板手势（files-swipe）

> **评审状态**：基于 `docs/specs/2026-08-27-sidebar-swipe-gestures.md` 的 B 档手势层做右缘扩展，不新建监听器。方向语义与抽屉让位收窄经用户两轮拍板（2026-09-13）：①右缘 45% 屏宽；②右缘左滑＝开文件面板、右滑＝关闭已开界面；③**抽屉开着时右缘左滑绝不收抽屉**（对 2026-08-29 anywhere-close 的刻意收窄；2026-09-17 限定为「抽屉右缘之外」——抽屉本体上的左滑永远归抽屉族），只有右缘右滑收抽屉。
> **定位**：宿主 0.1.5 的 Files 面板（`ui-sidebar-right`）目前唯一入口是右上角文件夹按钮；本方案给它补上与抽屉对称的边缘滑动手势。

## 概述

为 dsh-web-mobile 的手势层（`sidebar-swipe.ts`）增加**右缘文件手势**：右缘 45% 屏宽识别区内，**左滑打开宿主 Files 面板，右滑关闭已打开的界面**（Files 面板开着关面板；抽屉开着收抽屉）。左滑在任何状态下都不收起任何东西。复用现有让位链、轴锁、速度/距离双阈值、冷却与 consume 机制：零新增 document 监听器、零新 CSS、零新文案。

## 现状

- Files 面板 = 宿主 `ui-sidebar-right`：关闭时渲染打开按钮 `[data-sidebar-right-expand]`，打开时该按钮卸载、只剩 `[data-sidebar-right-toggle]`（全屏 fixed `z-40`，手机端 fullscreen 形态）。
- 插件侧唯一动作入口：`openFilesPanel()`（`src/client/components/open-files-panel.ts`）——按宿主控件状态自然 toggle，开/关同一个函数。
- 手势层现状（B 档）：左缘 45% 右滑开抽屉（轴锁 8px 提前提交 + 跟手）；抽屉开着 → 整 frame 横滑**两方向**都收抽屉（2026-08-29 第六轮 anywhere-close）。

## 行为规格（手势矩阵）

右缘识别区＝从右缘起 `0.45 × viewport` 宽的竖条（LTR：`clientX ≥ viewportWidth − zone`；与抽屉 45% 完全镜像）。

| 状态 | 右缘左滑 | 右缘右滑 |
|---|---|---|
| 抽屉关 + Files 关 | **打开 Files 面板** | 无动作 |
| 抽屉关 + Files 开 | 无动作 | **关闭 Files 面板** |
| 抽屉开 | **无动作（绝不收抽屉）** | **收抽屉**（走抽屉现有动画关闭路径，观感与今天一致） |

- **左滑永不收起任何东西（限「抽屉右缘之外」，2026-09-17 收窄）**：抽屉开着时右缘左滑是刻意的无动作——此时开 Files 会被抽屉（z-1100）盖住不可见，等于手势坏了；抽屉的左滑收起语义保留在**左半屏与抽屉内容区**（8-29 行为在左区原样）。
- Files 面板开着时，左缘右滑仍是「开抽屉盖到面板上」（现状不变）。
- 关闭提交按**可见顶层**路由：抽屉开 → 收抽屉；否则 Files 开 → 关 Files 面板。
- 无动作格子不写 consume、不进入提交，合成 click 正常派发（与抽屉非判定 stroke 同构）。
- **抽屉开 + 右滑 = 抽屉关闭的门槛**：该格提交的是**抽屉关闭**，故沿用抽屉族的 `CLOSE_DISTANCE_RATIO = 0.13 × viewport` 或 `|velX| ≥ 0.45`（方向须与笔画一致）——两族对同一笔物理笔画判定一致。**不可省**：390px 下 files 区（x ≥ 214）与抽屉列（280px）重叠 66px，而**这 66px 自 2026-09-17 起归抽屉族**（起点落在抽屉矩形内即由抽屉族接管，触摸抽屉本体左滑＝收回；files 区只从抽屉右缘之外起算），抽屉内容上的拇指在滚动时会横向漂 8px，无门槛即误收抽屉并吞掉这次 click（2026-09-14 质检发现，判定函数原本直接 `return 'close'`）。
- **RTL 镜像**：files 区＝左缘 45%，左滑↔右滑语义整体镜像。

## 判定参数（全部镜像抽屉现值，标注可调）

| 参数 | 值 | 说明 |
|---|---|---|
| `FILES_ZONE_RATIO` | 0.45 | 右缘竖条宽；不能用窄条——Chrome Android 的 history-nav 边缘条（~48dp）会 pointercancel 窄条起手（抽屉识别区当年扩到 45% 的同一原因） |
| `LOCK_PX` | 8 | 轴锁共用 |
| `FILES_DISTANCE_RATIO` | 0.16 × w | 两方向同值（≈62px@390）；抽屉 close 用 0.13 的原因是 follow 槽位语义，files 无 follow 不沿用 |
| `FILES_VELOCITY` | 0.45 px/ms | 与抽屉 open/close 同值 |
| 冷却 / consume | 350ms / 300ms | 与抽屉共用同一个 `cooldownUntil` 与 consume 标记 |

## 技术选型：扩展 sidebar-swipe.ts（单手势层，方案 A）

- **方案 A（选定）**：在 `sidebar-swipe.ts` 内加 `strokeMode` 状态位（`'drawer' | 'files'`），同一组 document 捕获监听器、同一条让位链、同一个冷却/consume 状态机。files 分支只在 `beginStroke` 命中右缘时进入。
- **方案 B（否决）**：独立 `files-swipe.ts` effect——需自建让位链并与抽屉手势做双监听器互斥，每次触摸跑两遍判定，回归面更大。
- **动作注入**：effects 禁 `../` import，`openFilesPanel` 留在 `components/`；由 `index.tsx` 以参数注入：`installSidebarSwipe(ctx, openFilesPanel)`。不挪文件、不复制选择器逻辑。
- **无跟随动画**（`ponytail:` 面板关闭时根本不在 DOM、打开时是 React 拥有的节点，跟手要 inline 对抗 React；真机若觉得生硬，升级路径＝按抽屉 close 的 inline-follow 套路给右滑关方向加跟随）。

## 实现改动点

1. `src/client/effects/sidebar-swipe.ts`
   - 新增 `FILES_ZONE_RATIO` / `FILES_DISTANCE_RATIO` / `FILES_VELOCITY` 常量与 `filesZonePxFor()`、`filesZoneHit()`（纯函数，RTL 镜像，导出供单测）。
   - 新增纯函数 `classifyFilesSwipe(panelOpen, drawerOpen, dx, velX, thresholds, rtl)`：方向 × 状态决策表——左滑仅当 `!panelOpen && !drawerOpen` → `'open-files'`；右滑时 `panelOpen → 'close-files'`，否则 `drawerOpen → 'close-drawer'`；其余 `'none'`。锁轴时快照 `panelOpen`（与 `lockDrawerOpen` 同模式）。
   - `beginStroke`：抽屉关时左区→drawer 模式、右区→files 模式；抽屉开时左区/抽屉内→drawer 模式、**抽屉右缘之外**的右区→files 模式（承担右滑收抽屉 + 左滑抑制）。家族路由由纯函数 `openStateStartMode(insideDrawer, inFilesZone)` 决定（2026-09-17）：抽屉体内一律归抽屉族。全部让位前置检查（cooldown/modal/takeover/selection/drag 标记/悬浮窗形状/横滚容器）两条分支共用，不新增。
   - `tryLock` / `onPointerMove`：files 模式跳过 `startFollow` / `applyFollow`（无跟手），采样照常。
   - `endStroke`：files 分支按 `classifyFilesSwipe` 判定——`'open-files'` / `'close-files'` → `filesToggle()` + 冷却 + consume；`'close-drawer'` → 与抽屉 close 判定同一提交路径（`commitFollowClose`，280ms 晚提交动画）+ consume；`'none'` → 释放、无动作。
2. `src/client/index.tsx`：`installSidebarSwipe(ctx, openFilesPanel)` 一行接线。
3. 无 CSS 改动、无 i18n 改动、无新 DOM 标记（files 模式全部复用现有 marker 体系）。

## 让位与边界

- 让位清单整链复用：cooldown / modal / takeover（taskboard、ssh、通用 `data-conversation-composer-overlay`）/ 划词选择 / `data-mobile-nav-dragging` / 悬浮窗形状启发式 / 横滚容器（**含 Files 面板内部的横滚条**——`chainFrom` 走真实祖先链，天然覆盖）。
- Files 面板开态检测：`[data-sidebar-right-panel]` 在场**且可见**——0.1.5 实测面板关闭时仍常驻 DOM（`visibility:hidden`、rect 顶到 `x=视口宽`），只查在场会把「双关+左滑=开面板」误判成无动作，故实现取 `sidebar-swipe.ts` 的 `filesPanelOpen()`：`visibility`/`display`/`rect.left < innerWidth` 三重判定（fullscreen 与停靠形态通吃；移动分支实际为 fullscreen）。
- 抽屉开 + 右缘左滑＝无动作是刻意的：files 面板会渲染在抽屉（z-1100）之下不可见；用户规则「左滑永不收起」+「只有右滑能收」。
- 已提交手势写 consume 标记（300ms，链上至 frame），防手势后的合成 click 误触释放点下的控件（发送键、行按钮等）——与抽屉同构。
- 触摸流：files 模式与抽屉共用既有 `touchmove` preventDefault 守卫（锁轴前防浏览器抢走手势流，锁轴后保持至松手）。

## 回归门影响（必须同步改的现役断言）

- `scripts/cdp-swipe-probe.mjs` 的 `swipe.close-from-backdrop-area`：旧语义「抽屉旁区域**左滑**收抽屉」被本方案收窄为 no-op。改写为：①右缘**右滑**收抽屉（走新 close-drawer 路径，合成 click 不得再开）；②新增反断言「抽屉旁区域左滑不收抽屉」。其余关闭断言（`close-leftward-inside`、B0/B1/B2）起点都在抽屉内，不受影响。

## 验证计划

- **单测**（`tests/sidebar-swipe.test.ts` 增补，决策表风格）：`filesZoneHit` 边界（区左右缘、RTL 镜像）；`classifyFilesSwipe` 全矩阵（方向 × panel/drawer 状态 × 距离/速度边界、方向反转拒绝）。
- **新探针** `scripts/probes/files-swipe-probe.mjs`（CDP 触摸手势，参照 `files-panel-safe-area-probe.mjs` 的 opener/panel 流程）：右缘左滑开面板、面板开右滑关、方向反例不动作、抽屉开时右缘右滑收抽屉、右缘左滑不收抽屉（收窄反断言）、consume 不误触、桌面/无指针零影响。
- **既有回归门全绿**：主探针 14 核心 + 6 集成（3 项机读基线）、`scripts/cdp-swipe-probe.mjs` 35 项（含改写后的 `swipe.close-from-right-zone`）、`cdp-swipe-failures.mjs` 16 场景、`draggable-conflict-probe.mjs` 15 断言、`pnpm verify` + `pnpm test:core` + `pnpm build`（lib 新鲜度）。
