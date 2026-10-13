# D — 测试与探针的覆盖盲区（「静默坏点」清单）

**Status:** DONE_WITH_CONCERNS
（concern：本机禁止起 chromium，因此「没有门」这一半是**用可执行的静态/桩 DOM 判据证明的**，不是靠猜；但「有门但门本身是绿的假绿」这一半我只能静态判断，无法在真浏览器里复现。）

仓库基线：`HEAD = 1d5ab8d`，工作树 `git status` 干净。`node --test tests/*.test.ts` → `# pass 120 / # fail 0`。
CONTEXT.md 冻结指纹核对：**compat.css.ts / layout.css.ts 已被父会话改动**（协调者已广播），本报告所有 CSS 行号均用**内容锚**重新取过并附了 `sed -n` 可复现的命令。

---

## 0. 结论速览

| # | 静默坏点 | 严重度 |
|---|---|---|
| G1 | **指针守卫带（PC 泄漏那条修复）没有任何场景覆盖** —— 删除 MOBILE_QUERY 的 `(pointer: coarse)` 或 misc 隐藏块的 `(pointer: fine)/(none)`，全套门仍绿 | 高 |
| G2 | `aionui` 探索器/预览整条集成（点文件行→预览标记、折叠箭嘴、panelCollapse、升起动画、**navigator 全局伪装与还原**）零运行时门 | 高 |
| G3 | `subagent-chip-touch.ts`（161 行）**零门**（无单测、无探针、无脚本引用） | 高 |
| G4 | 「预览全屏」按钮（`data-mobile-preview-toggle` + `data-mobile-preview-full` + 图标互换 CSS）零门，唯一相关断言是**桌面不存在** | 中高 |
| G5 | `data-mobile-nav="stats"` 标记算法与 TPS 折叠零门（只测了纯谓词） | 中高 |
| G6 | `theme-color` meta（含深色主题跟随）零门 | 中 |
| G7 | 惰性影子 `dismiss-shadow`（抽屉行 ⋯ 四连坑① 的修复本体）零门 | 中 |
| G8 | `git-chip-reparent` 被写进 `EXPECTED_FAILURES` 基线 → 它坏了也报 BASE 不进退出码 | 中 |
| G9 | `overlay-backdrop-fab` 的渐隐 / 快速重开取消路径零门 | 中 |
| G10 | 「新增注入控件必须进桌面隐藏块」这条维护约定**没有任何机械门** | 中 |
| G11 | `scripts/css-structure-check.mjs` 检测器不在任何门里（可接，现 0 fatal） | 中 |
| G12 | debug 徽章 + `/diag` beacon（零门） | 低 |
| G13 | 全部「桌面」场景都是 ≥1024px，指针细/无指针 **在 1024px 以下从未被测**（G1 的具体形态） | 高 |

（G13 与 G1 是同一件事的两面，正文合并成一条讲。）

---

## 1. 门禁盘点 —— 每个门**实际**守什么（读断言，不读文件名）

### 1.1 窗口层

| 门 | 实际断言数 | 备注 |
|---|---|---|
| `pnpm verify` | tsc host + client，0 断言 | 类型 |
| `node --test tests/*.test.ts` | 17 文件 / 120 test | 见 §1.3 |
| `pnpm build` + `git diff --exit-code lib` | 0 断言 | 产物新鲜度 |
| `scripts/cdp-probe.mjs` | 命名 check 22 项 + `EXPECTED_FAILURES`(:63-67) 基线豁免 3 项 | 需 `DSH_PROBE_SESSION_ID` |
| `scripts/cdp-swipe-probe.mjs` | 23 | |
| `scripts/cdp-swipe-failures.mjs` | 16 场景 | 手势让位 |
| `scripts/cdp-zoom-probe.mjs` | 21（A0–A10 / B0–B6 / C0–C2） | |
| `scripts/cdp-compat-contracts.mjs` | 26 条契约（hash/marker needle 存在性） | 只查**存在**，不查行为 |
| `scripts/probes/*.mjs` | 17 个，见 §1.2 | 手动跑，不在 CI |
| `scripts/css-structure-check.mjs` | 0 fatal / 5 info | **不在任何门里**（G11，见 §5 P3） |

### 1.2 探针 → 实际守的行为

| 探针 | 断言 | 真正守住的行为 |
|---|---|---|
| `draggable-conflict-probe` | 15 | 0.45 识别区几何；无标记悬浮件让位+跟手；`data-mobile-nav-dragging` 标记接口；清除后恢复 |
| `drawer-new-session-probe` | 5 | 非会话行导航目标 tap 后**宿主 onClick 真的执行了**（#「点新会话只收回抽屉」） |
| `drawer-row-actions-probe` | 13 | 长按开行菜单 / 抬手不关 / **elementFromPoint 命中抽屉带** / 确认卡挂 body + z≥1400 / 遮罩关闭 / 行 tap 导航 |
| `file-viewer-probe` | 15 | `data-file-viewer-open` 置位/清除/图标态；`.dsfv-*` 计算后 CSS 9 条；手势让位与恢复 |
| `files-panel-safe-area-probe` | 21 | 全屏形态 safe-area 规则在场且命中活面板；注入 inset 后整行下移；停靠形态不双吃 |
| `files-swipe-probe` | 8 | 右缘 files 手势开关往返 / 不误伤抽屉 / 合成 click 不回翻 / 鼠标惰性 |
| `header-files-pin-probe` | 11 | Files 按钮钉右缘 382=390-8；与 toggle 同 top；命中测试；inset 后同步下移 |
| `hero-composer-clip-probe` | 12 | hero 输入框无溢出/未滚动/完整可见/不低于宿主下限/插件不钉该链高度；桌面不动 |
| `message-font-axis-probe` | ~10 | 消息字号轴 4 档跟随；容器无混号；还原 |
| `plugin-card-header-bleed` | 10 | 设置工具栏 reparent 后卡片头恢复 / 工具栏进 nav / 8 张卡头 chevron 还原 |
| `row-tap-no-click-probe` | 7 | WebKit 无 click 时行 tap 仍导航（fiber 解析 + store 订阅）+ 抽屉关闭 |
| `session-delete-probe` | ~20 | rail 绊线；405/400/404 路由；桌面 0 注入；宽屏触摸注入 4 项 + 弹窗开合 |
| `subagent-composer-fix-probe` | ~8 | running 子代理双 `_primary` 形态 trailing 换行 / send 贴右缘 / 无重叠 |
| `diag-flow4` | — | **无 pass/fail**：只 dump（tooltip 压制后非目标气泡是否可见） |
| `diag-hero-chip` | 8 | hero 卡片 44px 净空 / 胶囊与输入行不重叠 / 卡片高 108–132 |
| `diag-sub-idle-pin` | — | idle 无模型条时 ContextMeter root 挂 auto |
| `ellipse-regression` | 2 | 标题省略号 |

### 1.3 单测 → 实际守的行为（挑关键）

真行为测试：`sidebar-swipe`(49)、`session-row-fiber`(15)、`delete-session`(10)、`reconciler-core`(6)、`open-files-panel`(6)、`compress`(3)、`raf-scheduler`(2)、`css-rules`(3)、`host-parity`(1)、`stats-line-fastpath`(1)、`ios-zoom-guard`(前 3 条为真行为)。
**源码文本正则测试**：`composer-keyboard-guard`（6 test / 12 处）、`session-menu`（3 test / 13 处）、`installed-list`(1/1)、`market-gallery-style`(2/1)、`drawer-tree-visibility`(1/0，但有块内/块外负断言)、`docs-consistency`(6，文档一致性)。

---

## 2. 行为 → 关卡 对照表（缺口就是从这张表里漏出来的）

| 代码行为（file:line） | 由谁守 | 缺口 |
|---|---|---|
| frame 标记 + 4 个 frame 属性清理 `phone-chrome.ts:161-183` | cdp-probe `mobile.frame-marker` / `desktop.no-op` | — |
| viewport meta 所有权（改写/换节点重申）`phone-chrome.ts:360-385` | cdp-zoom A8/A9/A10 | 写法脆（§4 F2） |
| iOS 标记 `phone-chrome.ts:395-409` | cdp-zoom A1/B1/C1 + `ios-zoom-guard.test.ts` | — |
| **theme-color meta 跟随深色主题** `phone-chrome.ts:344,387-390` | **无** | **G6** |
| Escape/遮罩/导航 click 关抽屉 `phone-chrome.ts:441-677` | cdp-probe `mobile.drawer.escape/backdrop` + drawer-new-session | Escape 分支的 `[aria-modal]` 让位未被断言 |
| 非行导航目标关抽屉时机 `phone-chrome.ts:733-737` | drawer-new-session 1–5 | — |
| 行 tap 无 click 回退（fiber+store）`phone-chrome.ts:558-594` | row-tap-no-click 1–7 + `session-row-fiber.test.ts` | — |
| 长按行菜单 500/1200/800ms `phone-chrome.ts:46-59,495-703` | drawer-row-actions 3/4/4b/5/5b/5c | — |
| **惰性影子 `ensureDismissShadow`** `phone-chrome.ts:122-144` | **无** | **G7** |
| reconciler 任务注册/dispose `phone-chrome.ts:766-784` | `reconciler-core.test.ts`（纯核） | 真 dispose 未测 |
| 横滚容器让位 `findHorizontalScroller` | `sidebar-swipe.test.ts` + swipe-failures C1 | — |
| 选中文本/多指让位 | swipe-failures E1/E1c/E2/E3/E3c/F1/F2 | — |
| 悬浮件让位（几何启发式） | draggable-conflict-probe 15 | — |
| 抽屉/files 双族判定矩阵 | `sidebar-swipe.test.ts`（含跨族等价）+ files-swipe 8 | — |
| **手指/鼠标指针守卫（MOBILE_QUERY 的 coarse 臂 + misc 隐藏块）** `phone-chrome.ts:27` / `misc.css.ts:253,270` | **无**（所有桌面场景都 ≥1024px） | **G1/G13** |
| **新增注入控件进桌面隐藏块（维护约定）** | **无机械门** | **G10** |
| `createStatsLineTask` 标记 + TPS 折叠 `stats-line.ts:35-108` | 只有 `statsAnchorAlive` 纯谓词（`stats-line-fastpath.test.ts` 1 test） | **G5** |
| **aionui：文件行 tap → 预览标记** `aionui-compat.ts:58-67` | **无** | **G2** |
| **aionui：navigator 三属性伪装 + 1000ms 还原** `aionui-compat.ts:44-56` | **无** | **G2** |
| **aionui：折叠箭嘴 / panelCollapse 关预览** `aionui-compat.ts:9,71` | **无** | **G2** |
| **aionui：sheet 升起动画（280ms）** `aionui-compat.ts:106-143` | 只有 `reconciler-core.test.ts` 的 preview-close-sync 分支 | **G2** |
| preview-close-sync（inline visibility 关预览）`aionui-compat.ts:85-104` | `reconciler-core.test.ts`（桩 DOM） | — |
| **预览全屏按钮：注入/点击翻转/aria 互换/图标 CSS** `preview-fullscreen.ts:15-38` | **无**（cdp-probe 只在桌面断言 `data-mobile-preview-full` **不存在**） | **G4** |
| git 芯片 reparent `git-chip-reparent.ts:12` | cdp-probe —— 但**在 `EXPECTED_FAILURES` 里** | **G8** |
| 设置工具栏 reparent `settings-toolbar-reparent.ts` | plugin-card-header-bleed 10 | — |
| 遮罩生成/移除/渐隐/快速重开 `overlay-backdrop-fab.ts:11-88` | cdp-probe 只查 backdrop 在场 + 命中点 | **G9** |
| FAB 生成/移除（heroPhase 门） | cdp-probe `mobile.open-control` | — |
| `data-file-viewer-open` 标记 | file-viewer-probe 1/4/5/5swipe | — |
| session 菜单注入 + 删除流程 | session-delete-probe 15a–16d + `session-menu.test.ts`（文本） | — |
| **subagent-chip-touch 全模块** | **无** | **G3** |
| composer 键盘 guard | **只有 12 处源码文本正则** | §3 T2 |
| 响应压缩三条不变式 | `compress.test.ts` 3 | — |
| 删除端点分代/404/409 | `delete-session.test.ts` 10 + session-delete 14a-c | 409 真机未验（已知） |
| **debug 徽章 + `/diag` beacon** `debug.ts` | **无** | **G12** |
| CSS 结构不变量（顶层媒体/重复声明/选择器拆分） | `css-structure-check.mjs` —— **不在门里** | **G11** |

---

## 3.「断言断在 bug 本身」：抽查结果

仓库先例（AGENTS.md §tooltip）：`diag-flow4` 当年把「10 个 tooltip」断言成通过，实际那 10 个是用户消息气泡。我按同一形态抽查了断言与实现的**同源性**。

**T1 — `tests/session-menu.test.ts`（3 test / 13 处源码文本断言）：最严重。**
三个 test 全部是 `assert.match(SOURCE, /…/)`，`SOURCE` 就是被审的那个 `.ts` 文件本身。断言内容 = 实现的字面副本，例如
`assert.match(SOURCE, /label\.textContent = navT\('deleteSession'\)/)`。
这条断言**只证明源码里有这行文本**：改坏 `navT` 的 key、改坏插入位置、把 guard 反过来，全都照绿。
更脆的是它的反断言：
`assert.doesNotMatch(SOURCE, /querySelectorAll<HTMLElement>\('\[role="menuitem"\] \[class\*="_itemLabel"\]'\)/)`
—— 它断的是**引号风格 + 空格 + 换行形态**。rc.2-only 的选择器只要换个引号或折行就会「合法复活」，而这条门依然绿。
缓解：该功能另有 `session-delete-probe` 真机门（16a–16d），所以 T1 是「单测是假的」，不是「功能没门」。

**T2 — `tests/composer-keyboard-guard.test.ts`（6 test / 12 处源码文本断言）：唯一门就是文本匹配。**
文件头自己写明「The DOM half (capture listener, closest() scoping) is browser-only; these tests audit the source invariants」。AGENTS.md 也记录 headless 的 `detectIosWebKit` 恒 false，**活跃路径本地无法验**。所以这一模块的**全部**门 = 6 条 `assert.match(SOURCE, …)`，没有一条驱动行为。一个保留全部标识符、只改顺序/条件的改动（例如把 `target.closest(COMPOSER_INPUT_SELECTOR)` 的判据从 ≠null 改成记录日志）会静默通过。

**T3 — `tests/installed-list.test.ts`（1 test / 1 处）：**
```ts
assert.match(COMPAT_CSS, /\[class\*="irow"\]:not\(\[class\*="irowActions"\]\):not\(\[class\*="irowTrailing"\]\)/)
```
断言 = 选择器字符串本身。若该规则被挪进桌面块、或被后续规则覆盖，这条仍绿。

**T4 — `tests/market-gallery-style.test.ts`（2 test）：断言实现的常量。**
断言 `flex: 0 0 min(100%, 420px) !important` 等**实现里的数值**back out of source。且它的「移动分支」检查是
`assert.match(COMPAT_CSS, /^@media \(max-width: 1023px\) and \(pointer: coarse\) \{/)` —— 只证明**文件以该块开头**，不证明这些规则**在这个块里**。把 gallery 规则移到文件末尾的桌面块，此测试照绿。
对照：`tests/drawer-tree-visibility.test.ts` 用了正确的形态（`const outside = MISC_CSS.replace(block[0], '')` 后 `assert.doesNotMatch(outside, /content-visibility/)`）—— 同一个仓库里两种做法并存。

**T5 — `tests/open-files-panel.test.ts`：桩回答实现自己导出的选择器。**
```ts
const openerDoc = (found) => ({ querySelector: (sel) => (sel === HOST_FILES_OPENER ? found : null) })
```
`HOST_FILES_OPENER` 是从实现 import 的，桩只回答这一个字符串 —— 常量值改成任何东西（哪怕真实宿主上 0 命中）测试都绿。
缓解：`files-panel-safe-area-probe.mjs:106,135` 直接在活页面用 `[data-sidebar-right-expand]` 打开面板，所以**常量本身**有运行时覆盖；缺的只是「常量与宿主对账」这条机械约束。

**T6 — `tests/stats-line-fastpath.test.ts`：假元素的 `closest()` 复制了实现的选择器串。**
`fake()` 里手写 `'[class*="_composerStack"]'`。改名时若实现与假件一起改，测试无感。缓解：假件对未知选择器返回 null，所以**单边**改名会红。属于低危同源。

---

## 4. 脆断言点名（逐条）

**F1 — 固定 sleep 代替轮询。** 按「字面量 ≥100ms 的 `await sleep(N)`」计数：
`cdp-swipe-failures` **30**、`session-delete-probe` 12、`draggable-conflict-probe` 12、`drawer-row-actions-probe` 13、`files-swipe-probe` 10、`file-viewer-probe` 9、`subagent-composer-fix-probe` 8、`row-tap-no-click-probe` 7。
其中 `cdp-swipe-failures` 的 sleep 是**等 350ms cooldown 过期**（探针注释自己写明「探针每步 sleep(500)」）—— 这是有意为之；但 `plugin-card-header-bleed.mjs:106,110,125` 的 `sleep(2500)/sleep(1500)/sleep(1500)` 是纯猜渲染时间，同仓库 `cdp-probe.mjs` / `cdp-swipe-probe.mjs` 的**字面 sleep 数都是 0**（全用 `waitFor`）。同一仓库两种风格并存 = 后者一旦变慢就是 flaky。

**F2 — `cdp-zoom-probe.mjs` A9/A10 用 `await sleep(200)` 等 viewport meta 重申，而不用 `waitFor`。**
```js
await evalv(`…content = 'width=device-width, initial-scale=1, maximum-scale=1'…`)
await sleep(200)
const rewritten = await viewportOf()
```
文件里 `boot()`/`survey()` 都是轮询的，只有这两处是固定等待。MutationObserver 是微任务所以今天够用，但它断的是**时序假设**而不是**结果**。
（对照 cdp-probe 的 `waitFor('…', …)` 包装：超时会被记成 FAIL 而不是异常。）

**F3 — 依赖宿主特定哈希类名（重哈希后不是「红」而是「指错方向」）。**
`scripts/probes/plugin-card-header-bleed.mjs`：
`button.VOzbGW_trigger`(107)、`button.VOzbGW_navCell`(109)、`.YyYd_a_header`(113)、`.VOzbGW_header`(113)、`JS: /(Kwoi6G|bpnj3G|Jh0q7G|jmhvDG|rUBhvW)_header/`(126)。
`diag-hero-chip.mjs`：`[class*="uV2eYG_card"]`。
对照 `session-delete-probe` 的 `qDHVXG_rail` 是**刻意**的绊线（有 SKIP 提示 + backlog 指路），性质不同。上面前者是纯脆。

**F4 — DOM-only（存在即通过），未断可见性/命中。**
全仓库 22 个脚本里只有 **3 个**用过 `elementFromPoint`：`drawer-row-actions-probe`(3)、`header-files-pin-probe`(2)、`cdp-probe`(3)。
`file-viewer-probe.mjs`：15 断言，`getBoundingClientRect|visibility|display` 出现 **0 次**（全是 marker 存在性 + `getComputedStyle` 单属性）。marker 断言本身不需要几何，但它有 3 条「让位」断言（3/5swipe/6）也没有 `elementFromPoint` 或 rect —— 「让位生效」与「元素在不在」是两回事。
`draggable-conflict-probe.mjs`：15 断言，rect/visibility 出现 **0 次**，`during.open === false` 只是读 marker。让位失败时抽屉被「打开」是 marker 可观测的，所以这条相对安全；但「悬浮球跟手」只看了 `style.left` 数值（第 301/366 行手写拖拽），没验证元素真的可见。
仓库先例（AGENTS.md §抽屉行菜单 ④）已明确：**DOM-only 断言在「渲染了但被盖住」时全绿**。这条不是「已知 bug」，而是「同类断言还没被补上 elementFromPoint」的清单。

**F5 — 内容/会话耦合。** `subagent-composer-fix-probe.mjs:13` 默认 `SESSION='d2bd6659-e128-485c-90fb-0898660621b9'`；`file-viewer-probe.mjs:14` 默认 `session-404e3554-…`；`diag-sub-idle-pin`/`subagent-composer-fix-probe` 依赖菜单里出现「盘点」「样式审查」等真实子代理名。这些探针只能在**一台特定 seed 过的本机 profile** 上跑，换机即失败（不是红成「功能坏了」，而是红成「环境不对」）。
`diag-flow4.mjs` 更特殊：**没有任何 pass/fail 记录**，只 `console.log` 一份 dump（我在 §1.2 表里标了「—」）。它作为回归门是不存在的。

**F6 — `sleep` 之外的另一类脆：`cdp-probe.mjs:159 setViewport(client, w, h, mobile)` 把 `mobile` 同时喂给 `Emulation.setDeviceMetricsOverride.mobile` 与 `setTouchEmulationEnabled.enabled`。** 二者被耦合，于是**不可能**表达「窄视口 + 鼠标指针」这个组合 —— 这正是 G1/G13 的机制根因。

---

## 5. 缺口详述（改了会坏 / 用户看到什么 / 为什么没人守）

### G1+G13 — 指针守卫带：删掉 `(pointer: coarse)` 全套门仍绿 【高】

**行为**：`MOBILE_QUERY = '(max-width: 1023px) and (pointer: coarse)'`（`phone-chrome.ts:27`）与 misc 桌面隐藏块 `@media (min-width: 1024px), (pointer: fine), (pointer: none)`（`misc.css.ts:253`）互为精确补集。

**改了会怎样**：删掉 JS 的 ` and (pointer: coarse)`，iOS/安卓以外的**鼠标窄窗**（分屏、系统缩放把 PC 的 CSS 视口推到 1024 以下）会武装整个移动外壳；删掉 CSS 隐藏块的 `(pointer: fine), (pointer: none)`，插件的 slot 按钮在窄桌面窗里露出来。这正是 2026-08-30 已发生过一次的 PC 泄漏。

**用户能看到什么**：桌面上突然多出抽屉按钮 / 文件按钮 / 遮罩，布局被移动规则接管。

**为什么现有门抓不到**：所有「桌面」场景的宽度都 ≥1024px。
- `cdp-probe.mjs` 的桌面场景只有 `1280×800`(:425) 与 `1024×800`(:447)；
- `cdp-swipe-probe.mjs:768` = `1280×800`；`cdp-zoom-probe.mjs` C 场景 = `1440×900`；`session-delete-probe:175` = `1280×800`；`hero-composer-clip-probe:168` = `1280×720`。
宽度臂 `(min-width: 1024px)` **自己就能**把它们全部隐藏，所以指针臂删掉也全绿。

**证据（可复跑）**：
```sh
node ~/tmp/review-2026-09-16/D-pointer-guard-gap.mjs
# PASS P1 desktop hide block is the exact complement
# FAIL P2 a gate scene covers a sub-1024 MOUSE window — scenes=33 narrow-mouse=0
#   (all desktop scenes: 1280x720, 1280x800, 1280x800, 1024x800, 1280x800, 1440x900)
```
```sh
grep -rn "MOBILE_QUERY\|min-width: 1024px\|pointer: fine" tests/ scripts/
# → 只有注释与 css-structure-check 的顶层媒体白名单，没有任何断言
```

### G2 — aionui（dsh-web-ui 探索器/预览）整条集成零门 【高】

**行为**（`src/client/effects/aionui-compat.ts`）：
1. `:58-67` 点探索器里的**文件行**（`[class*="_treeRow"]` 且无 `_treeArrow`）→ 给 frame 挂 `data-aionui-preview-open`，**并且临时把 `navigator.platform/userAgent/appVersion` 改写成 Win32 桌面 UA**（`:44-56`），1000ms 后还原；
2. `:9` 点 `.aionui-collapse-chevron` → 摘 `data-aionui-explorer-open`；
3. `:71` 点预览列的 `[class*="_panelCollapse"]` → 摘 preview 标记 + `data-mobile-preview-full`；
4. `:106-143` 两个列从隐藏变可见时播 280ms 升起动画。

**改了会怎样 / 用户看到什么**：文件行点了没反应（预览面板不弹，只剩遮罩/空白）；或者**navigator 被永久伪装**——所有依赖 `navigator.platform` 的第三方代码（含宿主自己的 UA 分支）从此以为自己在 Windows 上跑，安卓壳的判定全部走错分支；动画丢失（面板硬切）。

**为什么现有门抓不到**：`grep -rl "aionui" scripts/` → **0 个脚本**。全仓库唯一的相关覆盖是 `open-files-panel.test.ts`（桩 doc，只断一个 setAttribute）与 `reconciler-core.test.ts`（桩 DOM，只断 preview-close-sync 的分支）—— 二者都不执行上面 1–4 任意一条。`cdp-compat-contracts.json` 26 条契约里也没有 `data-aionui*`（实测：`data-aionui -> (none)`）。

**可跑证明**：见 §6 O-A（桩 DOM oracle，真源 3/3 绿，改坏后红）。

### G3 — `subagent-chip-touch.ts`（161 行）零门 【高】

**行为**：count 变体 trigger 无 onClick，走「pointerup 派发合成 ArrowDown/Escape + ~800ms 吞射向 `ZKlsPq_`/`h8S2Va_` 子树的 trusted hover + document 捕获 click 让位 500ms」；`HOVER_SUBTREE_SELECTOR` 同时列两代哈希。

**改了会怎样 / 用户能看到什么**：子代理芯片在手机上点不动（或点一次闪退/双开关竞态）——AGENTS.md 记的是「闪退竞态」与「三类症状」。

**为什么现有门抓不到**：
```sh
grep -rl "subagent-chip-touch\|installSubagentChipTouch" scripts/ tests/   # → 空
for s in toggledTrigger HOVER_SUBTREE_SELECTOR ArrowDown; do grep -rlF "$s" scripts/ tests/; done  # → 全空
```
唯一「引用」是 `src/client/index.tsx` 的调用行与文档。`cdp-swipe-failures` 里的 `#32 nav-arm` 场景走的是 `phone-chrome` 的 `armNav`，不是这个模块。

### G4 — 预览全屏按钮零门 【中高】

**行为**：`createPreviewFullscreenTask`（`preview-fullscreen.ts`）往 `[data-aionui-preview-col]` 注入 `[data-mobile-nav="preview-full-toggle"]`，点击翻转 frame 的 `data-mobile-preview-full`、交换 `aria-label/title`（全屏预览 ↔ 退出全屏）；compat.css `:180/:183/:189/:207` 用该标记控制图标互换与面板铺满。

**改了会怎样 / 用户能看到什么**：按钮点了不变全屏（或图标不换、`aria-label` 一直是「全屏预览」，无障碍状态与实际相反）。

**为什么现有门抓不到**：`grep -rl "preview-full-toggle" scripts/ tests/` → **空**。`scripts/cdp-probe.mjs:437,459` 里的 `data-mobile-preview-full` 是**桌面 no-op 断言**（要求它不存在），移动端从不点亮它。
注意：`misc.css.ts:260` 的桌面隐藏块**列了这个标记**，所以「桌面不出现」有门；「移动端点得动」没有。

### G5 — stats 标记算法 + TPS 折叠零门 【中高】

**行为**：`stats-line.ts:53-108` 在 composer stack 里按文本/按钮/输入域三重条件挑出状态行并打 `data-mobile-nav="stats"`；`:35-52` 把单独的 TPS 读数折进该行；`:119-139` dispose 再放回。

**改了会怎样 / 用户能看到什么**：状态行（轮次/步数/LLM 时间/TTFT/缓存）不再被标记 → 手机上一行放不下、指标换行/被截；TPS 读数留在自己那一行，不跟着横滚。

**为什么现有门抓不到**：`grep -rlF 'data-mobile-nav="stats"' scripts/ tests/` → **空**。唯一单测 `stats-line-fastpath.test.ts` 只测**纯谓词** `statsAnchorAlive`（5 个布尔组合），一行 `mark()`/`moveTps()` 都不执行。
仓库自己的注释（`:67-73`、`:86-91`）记着两次「这个 hunt 永远 miss / 标记数 0」的实测事故，发现方式都是**人工量**。

### G6 — theme-color meta 零门 【中】

**行为**：`phone-chrome.ts:343-344,387-390,396` 建 `<meta name="theme-color">`，初值 = `getComputedStyle(document.body).backgroundColor`，并用 `MutationObserver` 观察 `body[data-ds-dark-theme]` 重新写入；`:408` dispose 移除。

**改了会怎样 / 用户能看到什么**：安卓状态栏/地址栏不再跟随应用主题 —— 深色模式下页面顶部一条亮色（或反之），是那种「说不清哪里不对但很刺眼」的观感。

**为什么现有门抓不到**：`grep -rl "theme-color" scripts/ tests/` → **空**（`src/` 内只有 `phone-chrome.ts` 与 `layout.css.ts:122` 的一句注释）。`cdp-compat-contracts.json` 无该契约。
顺带：这个 meta 的**存在性**在探针里也从未被断言过，所以连「meta 没建出来」都不会红。

### G7 — `dismiss-shadow` 惰性影子零门 【中】

**行为**：`phone-chrome.ts:122-144` 在 sidebar pane 首子节点插一个 `display:none !important` 的 `<span data-mobile-nav="dismiss-shadow" data-dsh-responsive-part="sidebar-toggle">`，让第三方 shim `querySelector('[data-dsh-responsive-part="sidebar-toggle"]')` 先命中它 → 其关抽屉分支变 no-op。

**改了会怎样 / 用户能看到什么**：点会话行的 ⋯ 三点，第三方 shim 把抽屉关掉（或直接不弹菜单），用户感知「点三点没反应 / 抽屉自己收了」。这正是 2026-09-14 真机四连坑①。

**为什么现有门抓不到**：`grep -rl "dismiss-shadow" scripts/ tests/` → **空**（只在 `src/` 与 `docs/` 出现）。`drawer-row-actions-probe` 覆盖了 ②③④（长按/层带/弹窗），**① 的修复本体没有断言**——探针跑在**没装** `@linxin666/dsh-web-all` 的 profile 上时，影子根本不会插（`real === null` → `shadow?.remove()`），所以探针即使跑绿也不代表影子在场。

### G8 — git-chip-reparent 被基线豁免 【中】

`scripts/cdp-probe.mjs:63-67`：
```js
const EXPECTED_FAILURES = [
  { name: 'page.errors', includes: '404' },
  { name: 'integration.gitgraph.reparented' },
  { name: 'integration.gitgraph.pressed' },
]
```
`reparented`/`pressed` 命中基线 → 记 `BASE`，**不计入退出码**（`:117` 的 `printSummary` 只有 `new>0` 才 exit 1）。
后果：`git-chip-reparent.ts` 的行为**当前没有有效门**——芯片可以彻底不 reparent（今天就是），甚至 `createGitChipTask` 被整段删掉，探针也只是继续报 BASE。
注意这是**有意写成机读基线**的（AGENTS.md 有 A/B 实验记录），不是疏忽；但覆盖效果上它确实是空的，而「某条目修好后必须从 EXPECTED_FAILURES 移除」这条约定**没有机械门**。

### G9 — 遮罩渐隐 / 快速重开取消路径零门 【中】

**行为**：`overlay-backdrop-fab.ts:19` `BACKDROP_FADE_MS = 200`；`:83-88` 关闭时先 pointer-events/opacity 归零、`200+60ms` 后移除；`:71-79` 若在这窗口内重开，取消定时器并还原 inline。
**改了会怎样**：遮罩闪一下又活过来（或重开后仍被移除，抽屉全屏无遮罩、内容可点 = 「全屏黑」类观感）。
**为什么没人守**：`cdp-probe` 只断言 backdrop **存在** + 中心点命中（`mobile.backdrop.point`），从不走「关→立刻开」的时序。没有探针断言渐隐过程。

### G10 — 「新增注入控件必须进桌面隐藏块」没有机械门 【中】

**行为/约定**（AGENTS.md `misc.css.ts:238-251`）：任何 `data-mobile-nav` 注入控件都要进隐藏块。
**现状核对（我做了，绿）**：把 `src/` 里所有注入标记与 `misc.css.ts` 的隐藏清单对了一遍 ——
注入：`toggle / files / fab / backdrop / session-log / explorer / drawer-actions / preview-full-toggle / session-delete / delete-dialog / delete-dialog-backdrop / dismiss-shadow`；
隐藏块（`:253-264` 宽度臂 + `:270-276` 指针臂）+ inline `display:none`（`dismiss-shadow`）覆盖齐全。**当前是完整的**。
**缺的是机械保证**：没有任何 test/probe 读这份清单。下一个人加一个 `data-mobile-nav="foo"` 控件而不加隐藏规则时，全套门绿；只有在**真实窄桌面窗**里才会看到它（而那个场景本来就不存在 → G1）。

### G11 — `css-structure-check.mjs` 不在门里 【中】

`node scripts/css-structure-check.mjs` → `4 modules, 0 fatal, 5 info`，退出码 0（`:161` `process.exit(fatal.length ? 1 : 0)`）。
`grep -rn "css-structure-check" tests/ .github/ package.json scripts/*.mjs` → 只有它自己。
CI（`.github/workflows/ci.yml`）= `verify → test:core → build → git diff --exit-code lib`，无它。
后果：2026-09-15 CSS 表面审查期间那个「16 fatal」的状态在 CI 里是**可复现的漏网**——检测器写好了、判据齐全、退出码语义正确，但没人调用。
按协调者说明：不接入是当时的**故意**选择（接入就会立刻红）；**现在的状态（0 fatal）已经可以接**。

### G12 — debug 徽章 + `/diag` beacon 零门 【低】
`grep -rl "mobile-nav-debug" scripts/ tests/` → 空。徽章自己有过一次「观察自己写入的子树导致页面硬冻结」的事故（AGENTS.md 有记录），修复后仍无门。属诊断通道，坏了不影响用户，但会让人在真机取证时误判。

---

## 6. 可复跑的「能红的验证」

两个产物都在 `~/tmp/review-2026-09-16/`，**未进仓库**。

### 6.1 `D-oracles.mjs` —— 给三条零门行为各写一个 oracle（桩 DOM，无 chromium）

```sh
node ~/tmp/review-2026-09-16/D-oracles.mjs
# PASS A.aionui-file-row-tap-sets-preview-marker — frame attrs = data-mobile-nav,data-shell-overlay,data-aionui-preview-open
# PASS A.aionui-tap-spoofs-desktop-navigator — platform=Win32
# PASS A.aionui-navigator-restored-after-1000ms — platform=Linux armv8l
# PASS B.preview-fullscreen-button-injected — label=全屏预览
# PASS B.preview-fullscreen-click-sets-frame-marker
# PASS B.preview-fullscreen-label-swaps — label=退出全屏
# PASS B.preview-fullscreen-click-toggles-back
# PASS B.preview-fullscreen-dispose-removes-button
# PASS C.stats-marks-the-status-row-not-the-composer-card — statsRow=stats card=null
# PASS C.stats-folds-the-tps-readout-into-the-strip — tps.parent = bOPqQW_root
# PASS C.stats-dispose-clears-marker
# ORACLE SUMMARY total=11 pass=11 fail=0   (EXIT=0)
```
**灵敏度反证**（把三处行为各改坏一行，副本放 `mut/`，仓库不动）：
```sh
node ~/tmp/review-2026-09-16/D-oracles.mjs ~/tmp/review-2026-09-16/mut
# FAIL A.aionui-file-row-tap-sets-preview-marker
# FAIL B.preview-fullscreen-click-sets-frame-marker
# FAIL B.preview-fullscreen-label-swaps
# FAIL C.stats-marks-the-status-row-not-the-composer-card
# ORACLE SUMMARY total=11 pass=7 fail=4   (EXIT=1)
```
**同一时刻仓库自带的门**：`node --test tests/*.test.ts` → `# pass 120 / # fail 0`（未受任何影响），`node scripts/css-structure-check.mjs` → exit 0。
即：这三条行为**坏了 4 个断言量**，而仓库没有任何一条门会红。

### 6.2 `D-pointer-guard-gap.mjs` —— 指针守卫带 + 检测器接线

```sh
node ~/tmp/review-2026-09-16/D-pointer-guard-gap.mjs
# PASS P1 MOBILE_QUERY has the expected shape — query=(max-width: 1023px) and (pointer: coarse)
# PASS P1 desktop hide block is the exact complement — complement=(min-width: 1024px), (pointer: fine), (pointer: none)
# FAIL P2 a gate scene covers a sub-1024 MOUSE window — scenes=33 narrow-mouse=0
#      (all desktop scenes: 1280x720, 1280x800, 1280x800, 1024x800, 1280x800, 1440x900)
# FAIL P3 css-structure-check runs in CI or as an npm script
# GAP SUMMARY total=4 pass=2 fail=2   (EXIT=1)
```
P1 绿 = **守卫本身是对的**；P2/P3 红 = **没有任何东西在守它**。
P3 是 G11 的机读版：现在 0 fatal，接进 `test:core` 或 CI 立即可以绿。

---

## 7. 逐条一行（file:line + 事实 + 证据命令）

1. `src/client/effects/phone-chrome.ts:27` + `src/client/styles/misc.css.ts:253,270` — 指针守卫带正确但无场景覆盖，删任一侧全套门仍绿 — `node ~/tmp/review-2026-09-16/D-pointer-guard-gap.mjs`（P2 FAIL）
2. `src/client/effects/aionui-compat.ts:58-67,44-56,9,71,106-143` — 探索器/预览集成 + navigator 伪装零运行时门 — `grep -rl aionui scripts/`（空）
3. `src/client/effects/subagent-chip-touch.ts`（全文件） — 零门（无单测/探针/脚本引用） — `grep -rl installSubagentChipTouch scripts/ tests/`（空）
4. `src/client/effects/preview-fullscreen.ts:15` — 全屏按钮点击/aria 互换零门；`data-mobile-preview-full` 只在桌面被断言**不存在** — `grep -rl preview-full-toggle scripts/ tests/`（空）
5. `src/client/effects/stats-line.ts:104,35-52` — 标记算法与 TPS 折叠零门（只测纯谓词） — `grep -rlF 'data-mobile-nav="stats"' scripts/ tests/`（空）
6. `src/client/effects/phone-chrome.ts:344,387-390,408` — theme-color meta 零门 — `grep -rl theme-color scripts/ tests/`（空）
7. `src/client/effects/phone-chrome.ts:122-144` — `dismiss-shadow` 零门（且探针前提是没装第三方 shim） — `grep -rl dismiss-shadow scripts/ tests/`（空）
8. `scripts/cdp-probe.mjs:63-67` — git-chip-reparent 的两条断言被写进 `EXPECTED_FAILURES`，坏了报 BASE 不进退出码 — `sed -n '63,67p' scripts/cdp-probe.mjs`
9. `src/client/effects/overlay-backdrop-fab.ts:19,71-88` — 渐隐/快速重开取消零门 — cdp-probe 只断言 backdrop 在场
10. `src/client/styles/misc.css.ts:253-276` — 隐藏块清单无机械门（当前内容完整，缺的是保证） — `grep -rn MOBILE_QUERY tests/`（空）
11. `scripts/css-structure-check.mjs` — 检测器不在 CI/`test:core` 里（现 0 fatal，可接） — `grep -rn css-structure-check tests/ .github/ package.json`（只命中自己）
12. `src/client/debug.ts` — 徽章 + `/diag` beacon 零门 — `grep -rl mobile-nav-debug scripts/ tests/`（空）
13. `tests/session-menu.test.ts`（3 test /13 处） — 全源码文本正则，改行为不红；反断言对引号/换行敏感 — `grep -cE "assert\.(match|doesNotMatch)\(SOURCE" tests/session-menu.test.ts`
14. `tests/composer-keyboard-guard.test.ts`（6 test /12 处） — 唯一门是源码文本正则，活跃路径本地不可验 — 同上
15. `tests/market-gallery-style.test.ts` — 断言实现常量，且移动分支检查只证明「文件以该块开头」 — `cat tests/market-gallery-style.test.ts`
16. `scripts/cdp-zoom-probe.mjs` A9/A10 — 固定 `sleep(200)` 等 viewport 重申，同文件其余全轮询
17. `scripts/probes/plugin-card-header-bleed.mjs:107,109,113,126` — 硬编码宿主哈希（`VOzbGW_`/`YyYd_a_`/`Kwoi6G|bpnj3G|Jh0q7G|jmhvDG|rUBhvW`）
18. 全仓库 22 个脚本只有 3 个用 `elementFromPoint`；`file-viewer-probe`(15 断言/0 几何)、`draggable-conflict-probe`(15/0) — `for f in scripts/probes/*.mjs scripts/cdp-*.mjs; do grep -c elementFromPoint $f; done`
19. `scripts/probes/diag-flow4.mjs` — 无 pass/fail，只 dump，作为回归门不存在
20. `scripts/cdp-probe.mjs:159-171` — `setViewport` 把 `mobile` 同时喂给 deviceMetrics 与 touchEmulation，结构上无法表达「窄视口 + 鼠标」

---

## 8. 自检：我可能错在哪

- **没起浏览器。** 本机禁止 chromium，我的所有「没有门」结论都建立在**引用检索 + 静态/桩 DOM 判据**上。我没有在真浏览器里复现过任何一条缺口；G4/G5/G9 的「用户能看到什么」是从代码与 CSS 推的，不是我看到的。
- **「零引用」的边界。** 我用 `grep -rl <符号> scripts/ tests/` 判定「无门」。如果某个门通过**文本内容/几何**间接触及（例如某个探针 dump 里恰好含这些 marker 但不做断言），我的 grep 会漏。我逐条核对了 `diag-flow4`（它确实只 dump），但没逐行读完 22 个脚本。
- **G3 的严重度可能被我高估。** `subagent-chip-touch.ts` 的两代哈希可能已经不需要了（宿主升级后 count 变体可能已有 onClick）。我没有核对当前宿主实装版本的行为，只证明了「它没有门」。
- **G8 是有意为之。** `EXPECTED_FAILURES` 是显式记录的基线，不是疏忽。我把它列进来是因为**覆盖效果**上它是空的，不代表作者不知道。
- **`D-oracles.mjs` 的假 DOM 是我的实现。** 它支持的 CSS 选择器子集是我按用到的形状手写的（后代组合子、`:not`、`[attr*=]`）。oracle 全绿只能证明**这几种形状下**行为成立；它不能替代真浏览器的 CDP 探针，只能证明「这行为可以被一个便宜的判据钉住，而现在没有」。
- **`mut/` 副本是我改坏的**，仓库工作树未被我触碰（`git status` 干净）；我全程没有 `pnpm build`、没有起 chromium、没有写仓库文件。
- **行号。** `compat.css.ts`/`layout.css.ts` 在我读取窗口内被父会话改过（已广播）。我引用的 CSS 行号只用 `misc.css.ts`（未在冻结清单外被改动，`:253/:270` 已用 `sed -n` 复核）与 `layout.css.ts:122`（注释锚，非行号依赖）。`src/client/effects/*` 与 `scripts/*` 的行号均已用 `sed -n '<N>p'` 逐条取出核对。
