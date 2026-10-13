# 设计：conversation overlay 让位语义修正 + 外部合并把关补课

- 日期：2026-09-06
- 状态：已获用户批准（方案 F + 全部范围）
- 相关提交：955b69d（fork port）、6cc4405 / e01e60d（后续修复）

## §1 背景与问题

1. `src/client/effects/file-viewer-compat.ts` 的 `file-viewer-open-marker` task 用
   `document.querySelector('[data-conversation-composer-overlay]') !== null` 判定
   「文件查看器打开」，置位时给 frame 打 `data-file-viewer-open`。
2. 源码查证（dsh-client-ui-trajectory client.js:7249）：该属性是宿主
   conversation.view tab 系统的**通用 overlay 机制**，官方「轨迹」tab 的根 div
   同款属性。conversation 包以 `renderSlot("conversation.view", …, { only: active.id })`
   只渲染活跃 view，切 tab 即卸载。
3. 后果：轨迹 tab 打开时误置 marker → `sidebar-swipe.ts` 的 `takeoverActive()`
   禁用抽屉边缘滑。该行为**碰巧合理**（轨迹表格是横向滚动内容，横滑需要让位），
   但属未设计的隐式行为；fork 原版 2ff7976 同款判定，缺陷为继承而非移植失误。
4. 探针 `.local-tests/file-viewer-probe.mjs` 只注入「dsfv-panel 类 + 属性」组合，
   未覆盖「只有属性、无 dsfv 类」的误触发形态——违反 AGENTS.md diag-flow4 教训。

## §2 行为取向（用户已确认）

任何 conversation overlay（轨迹 / file-viewer / 未来第三方 view）打开期间，
**抽屉边缘滑动手势让位**（左缘横滑交给 overlay 内容），FAB 仍可开抽屉。
此行为从「误触发碰巧生效」升级为**显式设计语义**。

## §3 方案对比与选择

| 方案 | 内容 | 评价 |
|---|---|---|
| A 收窄判定 | marker 只查 `.dsfv-panel` | 轨迹横滑与手势冲突回归，不可单用 |
| B 改名 | marker 改名 `data-conversation-overlay-open` | 治标：CSS 端 marker 仍过宽 |
| **F 解耦（选定）** | 两消费方各用最贴近语义的信号 | 语义准确、保留 marker 模式 |
| F' 删 task | CSS 用 `frame:has(.dsfv-panel)`，删 marker task | 偏离「DOM marker 是跨模块状态契约」约定 |

## §4 核心改动

1. `src/client/effects/file-viewer-compat.ts`：ensure 判定改为
   `document.querySelector('.dsfv-panel') !== null`——marker 只反映 file-viewer
   面板存在，专服务 compat.css 的移动布局规则。注释同步重写（说明判定用独有类、
   overlay 属性属宿主通用机制）。
2. `src/client/effects/sidebar-swipe.ts` `takeoverActive()`：第三个条件从
   `document.querySelector('[data-file-viewer-open]') !== null` 改为
   `document.querySelector('[data-conversation-composer-overlay]') !== null`。
   语义 = 任何 conversation overlay 打开时左缘横滑让位（taskboard / ssh 两臂不变）。
   函数注释同步重写。
3. 不变式：marker 的 dispose 契约、`scopes: ['*']`、taskboard/ssh 判定均不动。

## §5 配套改动

1. 探针 `.local-tests/file-viewer-probe.mjs` 增加反断言场景：
   a. 注入「纯属性 div（有 data-conversation-composer-overlay、无 dsfv 类）」→
      断言 frame **无** `data-file-viewer-open`、但 `takeoverActive` 让位（边缘滑被抑制）；
   b. 既有「dsfv-panel + 属性」场景断言不变（marker 置位 + 让位）。
2. AGENTS.md：
   - Conventions marker 契约清单补 `data-file-viewer-open`（语义：file-viewer 布局生效）；
   - Pitfalls 新增条目：`data-conversation-composer-overlay` 是宿主 conversation.view
     通用 overlay 机制（轨迹/file-viewer 共用），判定 file-viewer 用 `.dsfv-panel`、
     手势让位直查 overlay 属性，两信号解耦。

## §6 补课三项 + 5 个文档小问题

1. #41 补沉淀：tab strip 横滚适配（`5a47149`）写入 AGENTS.md——选择器
   `[data-mobile-nav="frame"] [data-phase] header [role="tablist"]` 的
   overflow-x/touch-action pan-x/overscroll-behavior 机制，及
   `findHorizontalScroller` 的让位关系。
2. 外部 PR 审查检查单：Testing & QA 新增一条——外部贡献合并必须过
   「与既有体系冲突」检查（#47 冗余 iOS floor 教训：贡献者不知仓库既有 16px 下限体系）。
3. 5 个文档小问题：
   a. AGENTS.md 三件套条目补 6cc4405 meter-auto 修复（模型条缺席时 meter root 接
      margin-left:auto；diag-sub-idle-pin.mjs 为回归探针）；
   b. misc.css.ts L16 注释「40px chip clearance」改为 44px；
   c. debug.ts L34 build 标记更新（20260905-2 → 本批日期）；
   d. Conventions marker 清单补 data-file-viewer-open（与 §5.2 合并处理）；
   e. file-viewer 判定不再抽纯函数单测——F 方案下判定一行 querySelector，
      探针覆盖即验证手段（YAGNI）。

## §7 验证标准

1. `pnpm verify` 通过；`pnpm test:core` 60/60 绿。
2. `pnpm build` 后 `git status --short` 干净（lib 产物零漂移）。
3. 扩展后的 file-viewer-probe.mjs 全绿（含两个新反断言场景）。
4. 已知局限：本机 profile 未装 dsh-file-viewer，探针注入形状 ≠ 真机；
   若安装实包，真机复核 marker 置位与 takeover 让位。
5. 桌面 ≥1024px / 窄桌面指针场景零影响（所有改动在既有 mobile 分支内）。
