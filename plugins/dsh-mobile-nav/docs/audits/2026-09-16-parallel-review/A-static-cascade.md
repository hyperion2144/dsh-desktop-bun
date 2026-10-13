# A · 静态 CSS 残余缺陷审查（跨模块同特异度踩踏 · 死声明 · env() · :has() 过匹配）

**Status: DONE_WITH_CONCERNS**

- 审查员：A（只读）。未编辑仓库任何文件，未跑 `pnpm build`，未起 chromium。`git status --porcelain` 在我整个作业期间为 **空**（父会话的改动已提交或已还原；见「基线漂移」）。
- 基线：`~/dsh-mobile-nav`，分支 `fix/50-52-49-verified`。**父会话在我作业期间持续改这四个文件（至少 3 轮）**，因此报告给出两张指纹表：

| 文件 | 审查开始（CONTEXT 冻结） | 中途读取 | **本报告行号所锚定的最终态** |
|---|---|---|---|
| `base.css.ts` | `e6f2bac5…` / 285 行 | 同左 | `e6f2bac570a1fcb4e237dd151a8ae58cd21efe35` / **285 行**（未动） |
| `layout.css.ts` | `ef22d818…` / 1126 行 | `31f97d67…` / 1126 | `c6c8a94574c9f88b9e89a52c8378cd3e82e41136` / **1116 行** |
| `compat.css.ts` | `110f753c…` / 930 行 | `2ce7c91a…` / 928 | `68c976b333c45cab42b8217e56fbd501f2c91bc0` / **924 行** |
| `misc.css.ts` | `4f5a5477…` / 277 行 | 同左 | `fad30b91c45dbb393b9fb79399662ee0803b7c96` / **281 行** |

> ⚠️ **行号是易耗品**。每一条都同时给了「选择器原文 / 注释原文」，行号对不上时请按内容重定位（`grep -n` 一行就能定位）。我在最终态下逐条复核过本报告引用的**每一个位置**；`base.css.ts` 与 `misc.css.ts` 的锚点在整个作业期间稳定，`layout` / `compat` 的锚点按最终态给出。
> 结构检测器在最终态是 `0 fatal, 2 info`（info 为 `layout.css.ts:997/998` 的 vh/dvh 兜底对、`compat.css.ts:784` 的 irow 选择器拆分）——**A1 那 16 条 fatal 已消失**。

- **A1 已修**（我复跑 `node scripts/css-structure-check.mjs` → `0 fatal, 5 info`）——本报告不再提它。所有行号都是**当前工作树**的行号，并与选择器/注释原文一起给出（内容锚优先）。
- 工具（一次性脚本，全部在 `~/tmp/review-2026-09-16/a/`，未写仓库）：
  - `spec.mjs` —— 真·CSS 特异度（Selectors 4；`:is/:not/:has` 取参数最大值、`:where` 归零、伪元素进 type 列），**对 17 条 W3C 参考例全部通过**（`node verify-spec.mjs`）。
  - `rules.mjs` —— 把四个 `.css.ts` 解析成「规则 × 选择器臂」，带真实行号、at-rule 栈、声明列表。
  - `final2.mjs` → `deliverable1.txt`；`crossmod-mobile.mjs`；`dup-decl.mjs`；`dupblock.mjs`；`order-flip.mjs`。

---

## §0 判定方法与它管不到的地方（先看这段，否则会误读下面的数字）

原脚本（`~/tmp/css-review/cross-module-conflict.mjs`）的两处系统性误差，先修正再谈结论：

1. **分组选择器没拆臂**。`[data-mobile-nav="session-log"], [data-mobile-nav="explorer"]`（base L40）被当成一个选择器，于是它和 `[data-aionui-explorer-col] [class*="_searchBox"]`（compat）被算成同特异度冲突——**其实 base 那条的 `eplorer` 臂根本不在那个元素上**。拆臂后大量候选自然消失。
2. **特异度是正则估的**，把 `:has()` 里的实参算成了额外 class。真实规则是「`:has(X)` 取 X 里最具体的那个」。差异会直接翻转排序，所以本报告一律用 `spec.mjs` 的真值。

**最终计数（当前工作树）**：

| 口径 | 数量 |
|---|---|
| 四模块规则数（去重后） | 257 |
| 「不同选择器文本 + 特异度相同 + 同名属性 + 取值不同 + 跨模块」候选**对** | **397** |
| 按 (属性, 特异度) 归并后的**组** | **64**（原脚本 63，偏差来自拆臂+真特异度） |
| 两模块都处于**移动分支**（否则根本不同时生效） | 其中 2054 对（含被更高特异度压的） |
| 其中**只靠模块顺序分胜负**（特异度相同） | **41 对** |
| 其中 **`!important` 对普通声明** | **26 对** |
| **选择器文本逐字相同**、却是两个模块各写一遍 | **3 对**（见 §1，全部可静态定性） |

第三行那个 41/26 就是「真正需要运行时验证」的长名单——**我不把它当发现**：绝大多数对（例如 `[data-phase] table` vs `[data-mobile-nav="preview-full-toggle"] svg`）只有在「同一个元素既是 `<table>` 又是那个按钮里的 `<svg>`」时才冲突，而这是不可能的。运行时审查请**只按 §6 的清单**逐元素 `CSS.getMatchedStylesForNode`，不要遍历这 41 对。

---

## §1 已定性：选择器文本逐字相同的跨模块重复（3 对，可静态判定，无需运行时）

> 这一类**必然落在同一元素上**（选择器文本相同 ⇒ 匹配同一集合），所以胜负由 `base<layout<compat<misc` 唯一决定。逐条核过，**3 对都不是缺陷**，但属于「改顺序就翻车」的承重依赖。

### D1-A · `[data-mobile-nav="drawer-actions"]`（base L35 / compat L471）
- 声明：base `display:inline-flex; align-items:center; gap:8px`（无条件）；compat `width:100% !important`（移动分支）。
- **属性不相交**（base 那条没有 `width`，compat 只写 `width`），不是冲突。
- 但注意 compat 的 `width:100%` 是画在**无条件的 `display:inline-flex`** 之上的：`display:inline-flex` 来自 base 且**不在任何 media 里**，所以桌面（鼠标）分支里它也生效——只是被 misc L254 起的隐藏块 `display:none !important` 压掉。这是刻意设计（见 AGENTS「桌面隐藏块=精确补集」），记录为背景事实。
- 复核：`grep -n 'data-mobile-nav="drawer-actions"' src/client/styles/base.css.ts src/client/styles/compat.css.ts`

### D1-B · `[aria-modal="true"] [class*="_cubeRow"] > *`（layout L1102 / compat L427）
- layout：`flex:1 1 0; flex-direction:row !important; align-items:center; justify-content:center; gap:6px; padding:10px 8px; min-height:0`
- compat：`border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12)) !important`
- **属性不相交**，零冲突（两条是「三段式外观」的有意拆分）。
- 复核：`grep -n 'cubeRow' src/client/styles/layout.css.ts src/client/styles/compat.css.ts`

### D1-C · `[data-aionui-explorer-col], [data-aionui-preview-col]`（compat L32 / misc L224）★ 载荷承重
- compat L43/L62（每列各一条）：`left:8px !important; right:8px !important; width:auto !important; top:auto !important`（移动分支，`(0,1,0)`）
- misc L224（平板 768–1023 粗指针）：`left:0; right:0; width:min(calc(100vw - 32px), 720px); margin-inline:auto`（`(0,1,0)`，同样 `!important`）
- **两条都命中同一列元素、同一批属性、特异度同为 `(0,1,0)`、都是 `!important` ⇒ 唯一判据是模块顺序（misc 在 compat 之后）**。
- 证据（把顺序翻过来会怎样）：
  ```console
  $ node order-flip.mjs
  rules setting width on [data-aionui-explorer-col] (any arm of the selector list):
     compat.css.ts:43 spec(0,1,0) at=@media (max-width: 1023px) and (pointer: coarse) -> auto !important
     compat.css.ts:452 spec(0,2,1) at=… -> 14px !important
     misc.css.ts:224 spec(0,1,0) at=@media (min-width: 768px) and (max-width: 1023px) and (pointer: coarse) -> min(calc(100vw - 32px), 720px) !important
  result with the shipped order base<layout<compat<misc: misc wins  (width = min(calc(100vw - 32px), 720px))
  result if misc were concatenated before compat: compat wins (left/right 8px, width auto) -> the sheet goes edge-to-edge again
  ```
- **结论：不是 bug，但「平板端不铺满」这一行为 100% 寄生在拼接顺序上**，且 compat 自己的注释（L34–37「The per-column rules below override the geometry」）会把读者引到相反的理解。建议在 misc L224 处补一句「本规则靠 misc 在 compat 之后胜出，见 styles/index.ts 顺序契约」。
- 同类（同一顺序依赖、但只影响装饰性伪元素）：`layout L262-265 [data-phase] [class*="_scrollBody"]::-webkit-scrollbar` 与 `compat L708 [role="menu"]:has(...)::before` —— 两者都是 `::` 伪元素、`(0,2,1)`，不构成真实冲突。

---

## §2 死声明与无效值

### G2 · `base.css.ts` L70–79 · `[data-mobile-nav="delete-confirm"]` 整条规则是死代码（**已验证**）
- 事实：这个标记**从未被写入 DOM**。全仓（`src/`、`lib/`、`tests/`、`scripts/`、`docs/`）只有 CSS 里有它；`session-menu.ts` 两张卡（`showDeleteDialog` / `showError`）的根节点标记是 `delete-dialog`（L181、L272），内部只有 `delete-confirm-title/-desc/-actions/-no/-yes` 与 `delete-error`。
- 证据：
  ```console
  $ grep -rn "delete-confirm\b" src/ lib/ tests/ scripts/ docs/ | grep -v base.css.ts
  src/client/effects/session-menu.ts:185:  data-mobile-nav="delete-confirm-title"…
  …（全部是 delete-confirm-* 子串，无一处单独的 delete-confirm）
  $ grep -rnoE "dataset\.mobileNav = '[^']+'|setAttribute\('data-mobile-nav', '[^']+'" src/client/
  …只给出 backdrop / fab / preview-full-toggle / delete-dialog-backdrop / delete-dialog / frame / stats / session-delete / dismiss-shadow
  ```
- 受影响声明（8 条，全部永不生效）：`display:flex; flex-direction:column; gap:4px; width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid var(--dsw-alias-state-error-secondary…); border-radius:12px; background:var(--dsw-alias-interactive-bg-hover-danger…)`。注释 L66–68 还写着「Danger-tinted card with a description and two actions」——描述的是一个不再存在的中间层。
- 判 P2（无行为影响，纯误导）：底座功能由 `[data-mobile-nav="delete-dialog"]`（L137，白底 + 阴影 + 圆角）承担，危险色只由 `delete-confirm-yes` 的红色承载。
- 修法（候选，零行为变化）：删 L66–79 整块（含注释）。**建议先跑一次主探针**：`session-delete-probe.mjs` 断言的是 `delete-dialog` 系，预期不受影响。
- **第三方/宿主侧已排除**（比源码搜索更强的证据）：
  ```console
  $ timeout 120 grep -rl 'data-mobile-nav="delete-confirm"' ~/.dsh/profiles/web/node_modules/
  （无输出 —— 整棵 profile 依赖树里没有任何包定义这个标记）
  $ grep -rno 'delete-confirm[^ "';,)}]*' ~/.dsh/profiles/web/node_modules/dsh-better-sidebar/src/client/sidebar.module.css
  803:delete-confirmation        ← 唯一命中，是无关的 class 名 "delete-confirmation"
  ```
- 编号：**G2**（新缺陷候选，不占用 A–F/H）。**确定性：源码 + bundle + 整棵 profile node_modules 三处独立搜索全部为空命中。**

### 同规则内被后写覆盖的声明：**0 条**（除下述有意兜底）
- `node dup-decl.mjs` 全仓只报 1 条：
  - `layout.css.ts` L1002/L1003 · `max-height: min(800px, calc(100vh - …))` 紧跟 `max-height: min(800px, calc(100dvh - …))` —— **故意的 vh→dvh 渐进增强兜底对**，已登记在 CONTEXT「已知 info 级」与检测器 info 里。不重复报。
- 这条 0 是可信的，因为解析器把 `/* 注释 */` 掩码掉了（不会把注释里的冒号当声明），且同规则内的 `!important`/普通反转也一并覆盖。

### `!important` 参与的反转：8 对，全部是**刻意的状态覆盖**（不是缺陷）
同模块、同选择器文本、一 plain 一 `!important` 的组合共 8 对，逐条核对全部是 reduced-motion / 强制覆盖：

| plain | `!important` | 性质 |
|---|---|---|
| base L130 `z-index:55` | base L194 `z-index:1400 !important` | 移动分支把确认卡抬到菜单带（有意） |
| base L137 `z-index:56` | base L197 `z-index:1401 !important` | 同上 |
| base L237 `animation:dsh-web-mobile-fade…` | base L256 `animation:none !important` | `prefers-reduced-motion` |
| layout L90 `transition:transform .28s …` | layout L232 `transition:none !important` | `prefers-reduced-motion` |

- 结论：**没有一处是「写了 `!important` 反而反转了本意」的缺陷**。跨模块的 `!important` 对普通声明是另一回事（26 对，见 §6），那些是设计（隐藏块用 important 压基础样式）。

### 交叉验证：`order`/`flex` 的死声明（A2 已修，**别按旧行号找**）
- `layout.css.ts` 里原来的 `order:3 / flex:0 0 28px`（A2）**已删除**：`grep -n 'order: 3' src/client/styles/layout.css.ts` → 无命中。
- 现在文件里唯一的 `order:` 是 `compat.css.ts:776/779/782/785` 的市集行族（`> button[class*="switch"]{order:3}` 等），命中的是**流式 flex 子元素**，有效。
- 我顺带用真引擎语义核了一遍「绝对定位元素上 order/flex 无效」这条：`[data-mobile-nav="files"]` 在 `layout.css.ts:681` 起的规则里是 `position:absolute !important`（`right:8px!important; left:auto!important; top:12px!important; z-index:2!important`），所以 **A2 的判据依然成立**，只是应用对象已消失。

---

## §3 `env()` 兜底审计（对照仓库既有 safe-area 契约）

**事实：`src/client/styles/` 里 12 处真实 `env()` 调用全部带 `0px` 兜底，零缺失**（另有 1 处出现在注释里）。
```console
$ grep -n "env(" src/client/styles/*.css.ts        # 12 处真实调用（+1 处在注释里）
base.css.ts:141   bottom: calc(env(safe-area-inset-bottom, 0px) + 16px);
base.css.ts:207   top:    calc(env(safe-area-inset-top, 0px) + 12px);
compat.css.ts:200 padding-top: env(safe-area-inset-top, 0px) !important;
compat.css.ts:209 top: calc(env(safe-area-inset-top, 0px) + 8px) !important;
compat.css.ts:877 padding: 4px 8px calc(4px + env(safe-area-inset-bottom, 0px)) !important;
layout.css.ts:67  padding-top: env(safe-area-inset-top, 0px) !important;   （frame）
layout.css.ts:123 padding-top: env(safe-area-inset-top, 0px) !important;   （抽屉列）
layout.css.ts:222 padding-top: env(safe-area-inset-top, 0px) !important;   （Files 面板 fullscreen 形态）
layout.css.ts:990 top: calc(env(safe-area-inset-top, 0px) + 12px) !important;（设置弹层）
layout.css.ts:997/998 max-height: … env(safe-area-inset-top, 0px)（vh/dvh 兜底对）
```
（上面是同一批声明的逐条展开：`base` 2 + `compat` 3 + `layout` 7 = **12 处真实调用**，`layout.css.ts:35` 那条是注释里的示例写法，不是声明。`grep -c "env("` 给出的 2/3/7/0 与之一致。）

契约配对核对：
- `layout.css.ts:64` 的 `box-sizing: border-box !important` 与 L67 的 `padding-top` **同在 frame 规则内** → 既有铁律「safe-area padding 与 border-box 必须成对」满足。
- 抽屉列 L123（自己的包含块是 frame 的 padding box）与 L225（**带 `="fullscreen"` 形态限定**，停靠形态不吃第二次 inset）都符合 pitfalls §Files 面板 safe-area 的写法。

**未验证线索（不写成缺陷）**：全套安全区只处理 `top`，`bottom` 仅在 FAB（base L141）和 `/*** dsfv 状态栏 ***/`（compat L881）出现；composer seat 在 notched 机上是否被 home indicator 压住，仓库从未测过（探针只断言 `scrollHeight-clientHeight===0` 与 `seat.bottom===innerHeight`，headless 的 inset 恒 0）。要判定必须真机或 `Emulation.setSafeAreaInsets`。**这条我无法静态定性**。

---

## §4 `:has()` 过匹配清单（逐条：还可能匹配到什么）

共 19 处 `:has()` 出现在 15 条规则里（`grep -n ":has(" src/client/styles/*.css.ts`）。按锚点的通用度排序：

| # | 位置 | 选择器要点 | 还可能匹配到什么 | 判定 |
|---|---|---|---|---|
| H1 | `base.css.ts:188` | `body:has([data-mobile-nav="frame"]:not([data-sidebar-collapsed])) [role="menu"]` | 抽屉打开时，**body 下任何** `[role="menu"]`（宿主菜单、第三方菜单、`dsh-meme` 的表情面板若带 role=menu） | **过匹配**，但这是有意的（pitfall「菜单被压在抽屉下」要求全带抬高到 1400）。真正的风险是 **150 行外的 `compat.css.ts:703` 会把 preset 菜单改造成底部弹层**——见 H2 |
| H2 | `compat.css.ts:703` | `[role="menu"]:has([class*="cubgiG_item"])` | **任何**含一个 `class` 属性里出现子串 `cubgiG_item` 的元素的 `role="menu"`。`cubgiG_` 是上游 `@deepseek-ai/dsh-client-ui-agent-preset` 的 CSS Module 前缀，已进 `docs/upstream/compat-contracts.json`（id `agent-preset-menu`），所以**不是"随手写的哈希"**；但它是一条**子串**测试，任何第三方在菜单里放一个同片段的类名都会中招 | 保留（契约覆盖），建议升级 runbook 时把「同片段误命中」列为对账项 |
| H3 | `compat.css.ts:712/727/731/734` | 同上 + `[class*="_viewport_"]` | 同上；**外加**：`_viewport_` 是通用片段（模块哈希 + `_viewport_`），preset 菜单内任何嵌套滚动容器都会被套上 4px 细滚动条 | 低危（只在 H2 命中时生效） |
| H4 | `compat.css.ts:363` | `[data-mobile-nav="frame"] [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"]))` | 「第一个孩子 → 最后一个孩子 → 含一个 button」——**任何**这个形状的模态：设置弹层、会话日志导出弹层（`. _dialog_15u5s_22`）、目录选择器（靠 `[role="navigation"]`/`ZuhsRW` 排除）、**以及本插件自己的删除确认卡**（它是 `<div data-mobile-nav="delete-dialog" role="dialog" aria-modal="true">`，内部结构是 `title → desc → actions(div>button) → error(div[hidden])`：`:first-child`=title（无子元素）⇒ **不命中**）。**这是安全的**，但理由很反直觉（靠第一孩子不是容器） | 保留；建议在注释里加一句「插件自己的删除卡结构上不命中」，否则下一个改卡片结构的人会踩 |
| H5 | `compat.css.ts:498` | `body:has([aria-modal="true"]) > [class*="_float"]:has([class*="_sprite"][role="button"])` | 任意模态在场时，**body 直属**、class 含 `_float`、且内含 `*_sprite[role=button]` 的浮件全部 `display:none`（dsh-pet 桌宠、任何同形状悬浮球） | 有意（模态期间背景 inert）。风险点：**只要模态存在就隐藏**——包括插件自己的删除确认卡（它也是 `[aria-modal="true"]`，挂在 body）：打开删除卡时桌宠会消失，这大概是想要的，但没人写过 |
| H6 | `layout.css.ts:304/323/325/327` | `[data-phase] [class*="_scroll"]:not([class*="_scrollBody"]):not(:has([data-composer-input])):has(p)` | `_scroll` 家族里**任何含 `<p>`** 的容器（消息区、渲染出的 markdown 块、第三方面板） | 已按 PR #47 加固（`:has(p)` + 排除 composer）；`_scroll` 是低危片段（家谱里已标「低危候选」），保留 |
| H7 | `layout.css.ts:381/402/405/414/424/433/440/451/457/464…` | `[data-phase] [class*="_card"]:has(textarea, [data-composer-input]) [class*="_row"]:has([class*="_trailing"]) …` | `_card` + `_row` + `_trailing` 的组合——**任何第三方卡片**只要同片段（`dsh-market` 的卡不叫 `_row`，但未来插件可能） | 已知脆弱（composer 三件套契约），本条不新增判定 |
| H8 | `misc.css.ts:24` | `[data-phase="hero"] [class*="_card"]:has(…):not(:has([data-gitgraph-chip-anchor]))` | hero 卡不含芯片锚点时压 padding-top 到 6px（2026-09-06 那个 (0,3,0) 级联事故的修复形态） | 已覆盖（pitfalls §hero 净空） |
| H9 | `base.css.ts:190`（同 H1） | `body:has(...)` 的 `body` 锚 | `body:has()` 在 **body 自身**上求值：只要抽屉开着，**整棵 body 下**的 `[role="menu"]` 全部 1400——包括与抽屉无关的宿主菜单 | 有意（见 H1） |

**没有新的过匹配缺陷需要定编号**；H1–H5 的「还可能匹配到什么」已列全，其中 **H4 的"为什么它没命中插件自己的删除卡"** 是我这次唯一发现「读代码会读错、只有对着 DOM 数才知道」的点，建议补注释。

---

## §5 编号候选（新缺陷，不占用 A–F/H）

| 编号 | 位置 | 级别 | 事实 | 证据 | 状态 |
|---|---|---|---|---|---|
| **G2** | `src/client/styles/base.css.ts:70–79` | P2 | `[data-mobile-nav="delete-confirm"]` 从未被写入 DOM；整条规则（9 条声明）+ 上方 3 行注释描述的是不存在的层级 | `grep -rn "delete-confirm\b" src/ lib/ tests/`（除 CSS 外只有 `delete-confirm-*` 子串）；`session-menu.ts:181/272` 建的根是 `delete-dialog` | **已验证** |
| **G3** | `src/client/styles/misc.css.ts:209–212`（注释）+ `layout.css.ts:988`（规则） | P3 | 注释写「The settings sheet has a **higher-specificity** full-width rule above, so repeat its selector here to win」——实测两边都是 **(0,5,1)**，是平局，胜负由 misc 在 layout 之后决定（A4 同类）。原句会把读者引向"已经加过特异度了"的错误结论 | `node -e "…spec(layout.sel) / spec(misc.sel)…"` → 均 `(0,5,1)`；`node scripts/css-structure-check.mjs` 不覆盖此类 | **已验证（注释与实现漂移，无行为错误）** |
| **G1** | `src/client/styles/compat.css.ts:34–37`（注释） | P3 | 注释「The per-column rules below override the geometry」在平板档是**反的**：misc L224 的平板居中规则靠拼接顺序压过 compat L43/L62，且两者同为 `(0,1,0)` + `!important` | `node order-flip.mjs`（顺序翻转后行为翻转） | **已验证** |

---

## §6 交给运行时审查的清单（**只测这些**）

### §6.1 必须先跑的机器检查（30 秒，无需浏览器）
```sh
cd ~/dsh-mobile-nav
sha1sum src/client/styles/*.css.ts                # 与我 §0 的四个值比对，行号才有效
node scripts/css-structure-check.mjs              # 期望 0 fatal（A1 修完后的新基线）
node ~/tmp/review-2026-09-16/a/dup-decl.mjs       # 期望恰好 1 条（layout 的 dvh 兜底对）；多于 1 条 = 新引入死声明
```

### §6.2 需要真页面 + 逐元素 `CSS.getMatchedStylesForNode` 的 8 个场景（按价值排序）

| # | 元素选择器 | 场景 | 要断言什么 | 关联发现 |
|---|---|---|---|---|
| R1 | `[data-aionui-explorer-col]` / `[data-aionui-preview-col]` | **768–1023px + 粗指针**（平板档） | 计算 `width` 必须是 `min(calc(100vw-32px),720px)` 而不是 `auto`；`left/right` 必须是 `0` 而不是 `8px`。**这是 D1-C 的另一半：misc 靠顺序赢，若宿主/浏览器把顺序改了就静默变回铺满** | G1 |
| R2 | 设置弹层（`[aria-modal="true"]:has(> :first-child > :last-child > button)…`） | 同上平板档 | 计算 `left/right/width/max-width` 取 misc L212–219 的值（`0/0/min(...)`），不是 layout L988 的 `8px/calc(100vw-16px)` | G3 |
| R3 | `[data-mobile-nav="delete-dialog"]` + 内部 4 个子标记 | 手机 390px | 确认**没有**任何元素带 `delete-confirm` 标记（G2 的反证式）；卡片白底、actions 右对齐、yes 红底白字（这三条现由 `delete-dialog` + `delete-confirm-yes` 承担） | G2 |
| R4 | `[data-mobile-nav="drawer-actions"]` | 手机 390px + 抽屉开 | `display` 必须是 `inline-flex`（base L35 的无条件规则 + compat 只加 width）；`gap:8px` 未被 compat 的 `gap:6px` 影响（当前 compat L471 只写 `width`——**若未来有人往那条加 `gap`，base 的 8px 会被静默踩掉**） | D1-A |
| R5 | preset 菜单 `[role="menu"]:has([class*="cubgiG_item"])` | 手机 390px | 只命中**一个**菜单；`max-height` = `min(55dvh,440px)`；`::before` 手柄在场；**同时断言其它 role=menu（模型/权限下拉）未被改成底部弹层** | H2/H3 |
| R6 | `body > [class*="_float"]:has([class*="_sprite"][role="button"])` | 手机 390px | ① 无模态时 `transform: scale(.66)`；② **打开插件自己的删除确认卡时**桌宠是否被隐藏（它也是 aria-modal，H5）——这是唯一没被文档写过的组合 | H5 |
| R7 | `[data-mobile-nav="frame"]` | 手机 + `Emulation.setSafeAreaInsets(0,0,0,47)` | `padding-top` = 47px **且** `scrollHeight-clientHeight === 0`（border-box 成对）；**同一时刻记录 composer seat 的 `bottom` 与 `innerHeight` 的差**——这是 §3 未验证线索的唯一取证方式 | §3 |
| R8 | `[data-mobile-nav="toggle"]` / `[data-mobile-nav="files"]` | **1280px + 粗指针**（大平板横屏） | 两者是 `display:none`（移动块与隐藏块都不覆盖这一档），且 `getComputedStyle` 里**没有**插件的 `width:28px`（base 是无条件规则）——确认「大平板不渲染这两个按钮」是靠窄→宽的补集，而不是靠 base 规则缺席 | D1-A / 隐藏块契约 |

### §6.3 我**没能**判定的（诚实清单）
1. **41 对「同特异度 + 只靠顺序分胜负」的移动分支对**：我的 `DOMAIN/containment` 过滤器把它们压到 67 对候选，但其中仍有大量「同一宿主卡片里两个不同子元素」的伪冲突（例：`[data-phase] table` vs `[data-mobile-nav="preview-full-toggle"] svg`）。**判定它们必须要有真实 DOM 的逐元素 matched rules**——静态到此为止。
2. **`misc.css.ts:236 [aria-modal="true"] [class*="_section"]` 的 `max-width:none !important` 是否会踩到预设菜单**：那一块在平板档（768–1023 粗指针），而 preset 菜单在同一档也会渲染（它是 `[role="menu"]`，不是 `[aria-modal]`）。我把这条排除是因为 `[class*="_section"]` 需要宿主有该片段，但我**没有验证** tablet 档菜单是否在 `[aria-modal]` 之外的 body 里——**未验证线索**。
3. **`base.css.ts:188` 的 `body:has(...) [role="menu"]{z-index:1400}` 与宿主菜单自身 z-index 的胜负**：我读到的宿主值是 1100（2026-09-13 审计记录），但那是**宿主包内**的声明，我没有在活页面上用 `document.styleSheets` 递归核过它现在是否仍带 `!important`。若宿主哪天改成 `z-index:1100 !important`，插件这条（`(0,3,0) !important`）会因特异度落败。**未验证线索**。
4. **`layout.css.ts:452 [data-aionui-explorer-col] [class*="_treeRow"] svg{width:14px}` 与 misc 的 `[data-phase="hero"] textarea:placeholder-shown{height:28px}` 等 26 对 `!important`-vs-plain**：我判定它们不同元素（`svg` vs `textarea`），**没有**用引擎验证。
5. **`compat.css.ts:283` 的 `.QsffPG_root` 的 `_opPanel` fixed 居中规则**（`transform: translate(-50%,-50%) !important`）：它与 `layout.css.ts:155` 的抽屉 `transform:none !important` 同为 `(0,3,0)`。我**不认为**它们同元素（一个是抽屉列，一个是弹卡），但这条规则我在本次审查里没有逐行读完（它属于 D 类注释漂移的邻域）。**未验证线索**。

---

## §7 自检：我可能错在哪

1. **特异度解析器是新写的**：我用 17 条 W3C 参考例钉住了它（`:is/:not/:has/:where`、多臂取最大、伪元素进 type 列），但**没有**用它去对账真实引擎。若某条选择器里出现我没设想到的形状（例如 `:host()`、`::part()`、属性值里的逗号/括号），`splitTop` 会切错。抽检方法：`node verify-spec.mjs`，以及对我列出的每条选择器跑一遍 `document.querySelectorAll` 的命中数（§6.2 的场景正好覆盖）。
2. **「删臂」是本报告与原 63 组差异的主因**：如果父会话的运行时审查是按**未拆臂**的口径去对账数量，会对不上。对账请用 §0 那张表的口径。
3. **G2（delete-confirm 死代码）已补强到"整棵 profile 依赖树"**：`src/`（14 个 effect + 组件）、`lib/client.js`（bundle 文本）、`tests/`、`scripts/`、`docs/`、以及 `~/.dsh/profiles/web/node_modules/` 全树，`data-mobile-nav="delete-confirm"` 命中数 **0**。残留风险只剩「运行时由某个我读不到的字符串拼接动态生成」——我没找到这种代码，但它不是零概率。**愿意被推翻**：`grep -rl 'data-mobile-nav="delete-confirm"' ~/.dsh/ | head` 一条命令即可。
4. **我只读了行号，没有逐条读完 257 条规则的注释**：§4 的 H5 里「删除卡打开时桌宠被隐藏」是我从选择器语义推的，这条**没有**在任何文档/注释里被确认过——它可能是有意的，也可能是没人想过的副作用。我把它标成"值得断言"而不是"缺陷"。
5. **compat 的行号漂移**：父会话在我读取之后又改了 compat（−2 行）与 layout（注释）。我最终一行行复核了引用的每个位置；但 `git status` 在我最后一次检查时为**空**——若父会话在我写报告期间又落了一版未提交改动，**compat 743 之后的行号会再次偏移**。所有条目都给了选择器/注释原文，请用内容锚重定位。

---

## §8 附录：产出文件（全部在 `~/tmp/review-2026-09-16/a/`，未写仓库）

| 文件 | 内容 |
|---|---|
| `spec.mjs` / `verify-spec.mjs` | 真特异度解析器 + 17 条 W3C 参考例自检（全绿） |
| `rules.mjs` | 四模块 → 规则×选择器臂（真实行号 / at-rule 栈 / 声明） |
| `scan-baseline.mjs` → `baseline-pairs.txt` | 未过滤候选（397 对 / 64 组），用于对账 |
| `final2.mjs` → `deliverable1.txt` | 过滤后的 67 对（含 3 对同文本选择器） |
| `crossmod-mobile.mjs` | 移动分支内跨模块覆盖全量（2054 对，含被高特异度压的） |
| `dup-decl.mjs` | 同规则内重复/死声明（1 条：dvh 兜底） |
| `dupblock.mjs` | 逐字相同的声明块跨模块重复（18 组） |
| `order-flip.mjs` | D1-C 的顺序依赖证明 |
| `walk.mjs` / `walk2.mjs` | 逐元素族级联走查（插件控件族 / 宿主元素族） |

---

## §9 最终态复算（我最后一次读取时的树）

父会话在我写报告的过程中又改了一轮，下面数字是在**最终指纹**（§开头表格第三列）上复算的，可直接与 §0 表对账：

```console
$ node scan-baseline.mjs
property buckets with >=1 cross-module equal-specificity pair: 31
pairs (baseline (b) count): 386          # 审查开始时是 397（compat 的 irow 块被父会话精简）

$ node final2.mjs
surviving pairs: 67  {"ORDER(SAME-SPEC)":41,"IMPORTANT-vs-PLAIN":26}

$ node dup-decl.mjs
dead/duplicate declarations inside one rule: 1   # 仍是 dvh 兜底对（layout.css.ts:997/998）

$ node scripts/css-structure-check.mjs
css-structure-check: 4 modules, 0 fatal, 2 info
```

**结论未受影响**：G1 / G2 / G3 三条在最终态逐条复核仍然成立（`delete-confirm` 规则在 base L70；misc L204 注释与 L209-219 规则、layout 的设置弹层规则均在场；`order: 3` 在 layout 里仍为 0 命中）。§6 清单里的 R1/R2 请用**最终态**的行号。
