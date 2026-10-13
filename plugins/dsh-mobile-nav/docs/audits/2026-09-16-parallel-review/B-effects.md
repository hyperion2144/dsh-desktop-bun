# B — `src/client/` 运行时 JS/DOM 隐性缺陷审查

- Status: **DONE_WITH_CONCERNS**（3 条已验证、2 条未验证线索、1 条低危泄漏；另有 4 处「未配对但无害」的清理项与一组负结果）
- 只读审查，未改仓库任何文件（`git status --porcelain` 在写本报告前为空）。
- 读取时的 HEAD = `3157c3f`。**父会话已改过 compat/layout**，指纹与 CONTEXT.md 冻结值不同：
  - base.css.ts `e6f2bac5…`（== 冻结值）、misc.css.ts `4f5a5477…`（== 冻结值）
  - compat.css.ts `2ce7c91a…`（≠ 冻结 `110f753c…`）、layout.css.ts `31f97d67…`（≠ 冻结 `ef22d818…`）→ 我只在「已知事实」层面引用这两个文件（`[data-input-*]` 两条规则实际在 misc）；**本报告不依赖它们的行号**。
  - 我引用的 JS 文件 sha1：overlay-backdrop-fab.ts `b5f568a5`、phone-chrome.ts `f56aa698`、reconciler-core.ts `95d0ab94`、gesture-guard.ts `31790a22`、settings-toolbar-reparent.ts `e3e9d5f8`、stats-line.ts `a1f23c36`、sidebar-swipe.ts `b34eb8b3`、session-menu.ts `a437134b`（这几个文件父会话没动，行号与当前磁盘一致）。
- 未跑 `pnpm build`、未起 chromium、未派发子代理；只用了 grep/sed/node 一次性脚本（脚本在 `~/tmp/review-2026-09-16/`）。

---

## B1 [已验证 · 中] `fadeOverlayOut()` 在**第一次移动端→桌面端切换后永久失效**（本会话内不再恢复）

**位置**：`src/client/effects/overlay-backdrop-fab.ts:14`（`let fadeHook`）、`:45-50`（**唯一赋值点**，在 `createOverlayTask()` 工厂体内）、`:112`（`dispose` 里 `fadeHook = null`）；
配合 `src/client/core/reconciler-core.ts:146-158`（`deactivate()` 对**每个 active task 调 runDispose**）与 `src/client/effects/phone-chrome.ts:254-258`（reconciler 的 cleanup = `observer.disconnect(); core.deactivate()`）。

**事实链（要能自证，逐步给）**：
1. `createOverlayTask(t, …)` 只在 `registerReconcileTasks()` 里被调用一次；而 `registerReconcileTasks` 被 `reconcileTasksRegistered` 门控、只在 `index.tsx:165-174` 的**非 matchMedia 效应**里调用一次 → 整个页面生命周期里这个 task 对象只构造一次。
2. 该 task 对象的 `ensure/dispose` 由 reconciler 的激活周期反复调用：`installMobileEffect` 的 `arm()` 在 query 不匹配时执行 `cleanup?.()` → `core.deactivate()` → `runDispose(task)`（reconciler-core.ts:156）。
3. `dispose` 把 `fadeHook` 置 `null`；**没有任何代码在重新激活时再赋值**（`fadeHook = ` 全文只有两处：工厂体第 45 行、dispose 第 112 行）。
   ```
   $ grep -n "fadeHook" src/client/effects/overlay-backdrop-fab.ts
   14:let fadeHook: (() => void) | null = null
   45:  fadeHook = (): void => {
   112:      fadeHook = null
   ```
4. 重新激活只走 `core.activate()` → `ensure()`（reconciler-core.ts:139-144），不会重建工厂。

**影响面（用户看到什么）**：任何一次 `MOBILE_QUERY` 翻转（最典型：**平板竖屏↔横屏跨 1023px**，如 iPad mini 768↔1024、安卓平板 800↔1280；或 pointer coarse↔fine 变化）之后再回到手机/平板竖屏布局，**滑动关闭抽屉时遮罩不再随抽屉一起渐隐**：抽屉先滑走 ~280ms，黑色遮罩保持全不透明、保持可命中，直到 `finishPendingCommit` 翻 marker（320ms 后）才由 `ensure` 的关闭分支渐隐移除 —— 正是 `commitWithAnimation` 注释里那次修复（2026-08-29/2026-09-14）要消掉的「抽屉先走、黑幕后消失」伪影。功能不坏（不会双 toggle，`finishPendingCommit` 有 frame 已收的守卫），纯视觉 + 遮罩多拦 ~280ms 指针。
**为什么一直没被发现**：全仓库没有任何测试/探针覆盖这条 pre-fade ——
```
$ grep -rln "fadeOverlayOut" scripts tests      → 无输出
$ grep -n "BACKDROP_SELECTOR\|MOBILE_BACKDROP_SELECTOR" scripts/*.mjs
  scripts/cdp-probe.mjs:21 / scripts/cdp-swipe-probe.mjs:37   （只断言存在/命中，不读 inline opacity）
```
**建议修法（最小）**：把 `fadeHook` 的赋值从「工厂体」挪进 `ensure()`（幂等，每次激活都重装），`dispose` 里保留置空即可；或让 dispose 不置空（但那样 task 卸载后 hook 会指向已 dispose 的闭包 —— 现在闭包里 `backdrop === null` 已天然安全）。二者取一即可，**别只改 dispose**。
**可选运行时验证**：`?mobile-nav-debug=1` 下用 CDP Emulation 先 390×844(touch) → 1280×800 → 再回 390×844，然后做一次「抽屉开→内容左滑关闭」，在释放后 0~280ms 内读 `document.querySelector('[data-mobile-nav=backdrop]').style.opacity` —— 期望 `0`，有 bug 时读到 `''`。

---

## B2 [已验证 · 中(视觉) ] CSS 的 `[data-mobile-nav="delete-confirm"]` **没有任何写方** → 删除确认卡的危险配色规则是死规则

**位置**：`src/client/styles/base.css.ts:70`（`[data-mobile-nav="delete-confirm"] { display:flex; … border:1px solid …error-secondary; background: …error…06; }`，注释自称「Danger-tinted card with a description and two actions」）。
**写方**：`src/client/effects/session-menu.ts:181` 与 `:272` 只创建 `card.dataset.mobileNav = 'delete-dialog'`，卡内子节点是 `delete-confirm-title` / `-desc` / `-actions` / `-no` / `-yes` / `delete-error`，**没有任何元素叫 `delete-confirm`**（无包裹层）。
**证据**：
```
$ grep -rn 'delete-confirm"' src/client            → 只有 src/client/styles/base.css.ts:70
$ grep -o 'mobileNav="delete-confirm"' lib/client.js   → 无输出
$ grep -o 'delete-confirm"' lib/client.js | wc -l  → 1     （就是那条 CSS 选择器本身）
```
**溯源**：不是本次迁移引入的 —— fork 快照 `.local-tests/fork-v2.7.0/` 里 markup 与 CSS 同形（同样只有 `delete-dialog`），`git log -S 'data-mobile-nav="delete-confirm"' -- src/client` 只命中导入提交 `d1113a3`。所以这条规则从摘抄进来起就没生效过。
**影响面**：确认/错误卡实际渲染成 `delete-dialog` 的**白底卡片**（`base.css.ts:137+`，bg=`--dsw-alias-bg-base`），只有标题文字与「删除」按钮是红的；设计意图里的**红色描边 + 淡红底**（1px error-secondary 边框 + 6% 红底）从未出现。用户不会遇到功能问题，只会觉得删除确认「不够危险」。
**注意**：`delete-confirm-title/-desc/-actions/-yes/-error` 这几条都有效（元素存在），**只需要删掉 :70 那一条**（或把包裹层补进 markup —— 但那就是改视觉了，属父会话决策）。

---

## B3 [已验证(源码事实) · 中] reconciler 的 MutationObserver **没有开 `characterData`**，与文档化的「文字更新也要唤醒 task」契约矛盾

**位置**：`src/client/effects/phone-chrome.ts:240-253`：
```
observer.observe(document.documentElement, {
  childList: true, subtree: true, attributes: true,
  attributeFilter: ['style','class','data-phase','data-sidebar-collapsed',
                    'data-aionui-explorer-open','data-aionui-preview-open','data-mobile-preview-full'],
})
```
**事实**：`characterData` 缺省 `false` → 纯文本节点的 `nodeValue` 改动**不产生任何 record**。而 AGENTS.md 明确写着「`stats-line` must stay `scopes: ['*']` because TPS updates are childList/**characterData** text mutations」，`stats-line.ts` 同样按这个前提设计（`moveTps` 的 TPS 行是纯文本 readout）。React DOM 的 `commitTextUpdate` 就是原地写 `textInstance.nodeValue`（原地更新不产生 childList）。
**影响面（诚实版，未实测）**：task 只在「同帧内还有别的 childList/attribute 变更」时才被唤醒 —— 流式期间消息区本来就在 childList 变动，所以**大概率被掩盖**；真正的暴露面是「文档里只有一次纯文本更新的那一帧」：TPS readout 文本被原地改写、而 strip 恰好在这一帧被 React 重建 → `stats-line` 不会重跑，TPS 行可能停在被丢弃的旧容器里（直到下一次别的 mutation 才补锚）。**这是「注释/不变式与实现不一致」，不是「已复现的用户可见 bug」**。
**需要运行时验证 + 怎么验**：在真机/仿真里执行
```js
// CDP Runtime.evaluate，移动分支武装状态下
const t = document.querySelector('[data-mobile-nav="stats"]')?.querySelector('div')?.firstChild
t.nodeValue = t.nodeValue + ' '   // 只改文本节点
```
然后看 `[data-mobile-nav="stats"]` 是否在同一帧被重新锚定/`stats-line` 是否重跑（用临时 `console.count` 或对比 marker 位置）。若确认「纯文本不唤醒」，修法是给 `observe()` 加 `characterData: true`（注意：那会让每次流式 token 的文本更新唤醒 `scopes:['*']` 的 4 个 task，`stats-line` 的快路径 `statsAnchorAlive` 就是为这条热点准备的，加之前建议先量）。

---

## B4 [已验证(源码事实) · 低] `gesture-guard` 的 consume 标记表对 DOM 节点持**强引用**且无周期清扫

**位置**：`src/client/effects/gesture-guard.ts:28`（`const consumed = new Map<EventTarget, number>()`）、`:78-94`（`markGestureConsumed` 沿祖先链逐节点 `set`，一次手势 5~10 个节点）、`:101-123`（`consumeIfGestured` 只在**走到该节点**时才删过期项；对非 element target 才会全表清扫，而真实事件总是 element）。
**事实**：每次滑动都在 Map 里留下「释放点 → 起始元素」链上的节点条目，过期后**只在该节点再次出现在某次 click 的祖先链上时才会被删除**；被 React 换掉的节点（会话行、消息节点）永远不会再出现 → 条目 + 节点一起常驻。
**影响面**：长会话里反复滑动 → Map 单调增长（每次约 5~10 个条目），并**保留已卸载子树**（会话行、其祖先链上已卸载的中间节点）。不会导致功能错误（过期判断先于命中返回，`until <= now` 一律视为未消费），属内存增长类。运行一整天 + 大量滑动的会话值得看一眼 `performance.memory`。
**最小修法**：在 `markGestureConsumed` 里先做一次便宜的全表过期清扫（或按阈值触发），或把 key 换成 `WeakMap<EventTarget, number>`（WeakMap 无法遍历做全表清扫，但过期项本就不需要清扫 —— 除 `consumeIfGestured` 的 `for (const [t, until] of consumed)` 那段全表扫要跟着删掉）。

---

## B5 [未验证线索 · 低] `settings-toolbar-reparent` 用**裸后代** `[class*="_header"]` 找锚点，与本仓库「禁止裸 `_header`」的 CSS 约定同形

**位置**：`src/client/effects/settings-toolbar-reparent.ts:12`
```
const header = dialog.querySelector('[class*="_header"]:not([class*="_headerActions"])')
```
**为什么可疑**：本仓库 Pitfall「设置工具栏规则结构化锚定，禁止裸 `[class*="_header"]`」记着这条子串会命中**全部 8 个插件卡头**（官方 `YyYd_a_` + dsh-web-ui-all 五张）；CSS 侧已改用 `> [class*="_nav"] > [class*="_header"]` 锚定，而 JS 侧仍是全后代查询。当前它安全**只靠文档顺序**（设置对话框自己的工具栏头在其内容区顶部，plugin 卡头在其 body 里、更靠后），reparent 之后该头进了 `nav`（dialog 第一个子节点）→ 后续 ensure 依旧先命中它，所以幂等成立。
**风险**：只要宿主某版把卡头排到工具栏头之前（或工具栏头被插件/宿主移除），`ensure` 会把**卡片头搬进 nav** —— 静默的布局破坏，且探针 `plugin-card-header-bleed.mjs` 断言的是 `.VOzbGW_header` 的父节点与卡头 computed 样式，**不会**发现"某个卡头被搬走"。
**怎么验（无需真机，活页面即可）**：设置对话框打开 + Plugins 分区渲染出卡片后执行
```js
const d = document.querySelector('[aria-modal=true]')
const first = d.querySelector('[class*="_header"]:not([class*="_headerActions"])')
first === d.querySelector('[class*="VOzbGW_header"], .VOzbGW_header')
// 以及：first.compareDocumentPosition(卡头) & Node.DOCUMENT_POSITION_FOLLOWING
```
若 `first` 不是工具栏本尊 → 该 task 正在搬错节点。若确实是工具栏，则本条降级为「脆弱但当前正确」，可只加一条探针断言钉住文档顺序。

---

## B6 [未验证线索 · 低] `stats-line.dispose` 的还原路径**以 marker 为索引**，marker 被自己摘掉后就找不回被移动的 TPS 节点

**位置**：`stats-line.ts:65`（陈旧分支 `anchor?.removeAttribute('data-mobile-nav')`）与 `:122-137`（dispose 还原：只在 `document.querySelectorAll('[data-mobile-nav="stats"]')` 里找 TPS 节点，找不到就整段跳过，随后 `tpsOrigin = null`）。
**推理链**：`moveTps` 会把宿主自己的 TPS readout **移动**进被标记的 strip；若该 strip 后来被判为 stale（离开 `[data-phase]`/`_composerStack`）而被摘掉 marker，而慢路径又没能重新标记（`stack === null` 直接 return、或候选全被过滤），那么 dispose 时全文档已无 `[data-mobile-nav="stats"]` → 归还循环整体跳过 → 被移走的 TPS 节点留在原地（可能已随 React 卸载而不可见，也可能留在旧容器里）。
**为什么只算线索**：这条路径要求「marker 被摘 + 慢路径失败」同时发生，我没有构造出真实时序；且即便发生，最坏结果是桌面态少了一个 TPS 行（宿主的布局边界在 `.composerStack` 内），不影响功能。
**怎么验**：移动分支下人为给 strip 加干扰（例如把 clip 到 `[data-phase]` 之外的节点、或删掉 `_composerStack` 类）逼出 stale 分支，然后切到桌面看 TPS readout 是否回到原行。**修法（若确认）**：dispose 的归还循环去掉 marker 前置条件，改成直接把 `tpsOrigin` 记下的父节点与我们的目标节点对账。

---

## 负结果（做过但**没**发现问题的部分，含方法与原因）

1. **marker 读写交叉差集（任务第 1 项）已做完**：脚本 `~/tmp/review-2026-09-16/markers.mjs`（写方/读方/同一行分类）+ `cssmarkers.mjs`（先剥 `/* */` 注释再抽 `[data-*=…]`，避免把注释里的 `[data-composer-placeholder]` 当规则）。结论：
   - 插件自有 marker：`frame` / `backdrop` / `fab` / `stats` / `files` / `toggle` / `explorer` / `session-log` / `drawer-actions` / `preview-full-toggle` / `session-delete` / `delete-dialog*` / `delete-error` / `data-aionui-*-open` / `data-mobile-preview-full` / `data-file-viewer-open` / `data-mobile-nav-ios` **全部两侧存在**（写方在 JSX 或 `setAttribute`，读方在 CSS/JS）。
   - CSS 读、src 无写方的其余 marker 都是**宿主/第三方写的**，逐个在安装包里核过：`data-composer-placeholder`/`data-composer-card`/`data-composer-input`/`data-conversation-composer-overlay`（`@deepseek-ai/dsh/node_modules/dsh-client-ui-conversation/lib/client.js` + `dsh-client-ui-trajectory`）、`data-question-key`（`dsh-client-ui-user-questions`）、`data-sidebar-right-expand`/`-panel`（`dsh-client-ui-sidebar-right`）、`data-gitgraph-chip(-anchor)`（`@linxin666/dsh-client-ui-git-graph`）、`data-dsh-taskboard-*`（dsh-client-ui-task-board）、`data-genui-panel`（`@omdsh-dev/dsh-genui`：`"data-genui-panel":!0`）、`data-dsh-responsive-part="sidebar-toggle"`（`@linxin666/dsh-web-all`，dismiss-shadow 依赖的就是它）。
   - 唯一真死的是 **B2** 的 `delete-confirm`。
   - `[data-input-mirror]` / `[data-input-backdrop]`（misc.css.ts:170-171 的 iOS 16px 下限）在当前宿主里**确实无人写**，但这是**已知的有意兜底**：`docs/upstream/upgrade-runbook.md:51` 与 `docs/maintenance/pitfalls.md`（§iOS zoom）都写明「0.1.2 起被删，保留为旧宿主兜底」。**不算发现**，仅在此记录以免父会话重复报告。
2. **清理配对（第 2 项）**：把 14 个模块的 `addEventListener / observe / setTimeout / rAF` 与 `removeEventListener / disconnect / clearTimeout / cAF` 做了逐条对账（grep 全量输出人工配对），**没有**「同一事件注册两次只解绑一次」或「capture 监听在 dispose 后仍在」的情况；每个 effect 的 disposer 都覆盖了自己注册的全部监听/观察器/定时器。每个被注入的节点（style tag、theme-color meta、dismiss-shadow、preview 全屏按钮、backdrop、FAB、删除卡、注入的菜单项）与每个被写入的属性（`data-mobile-nav=frame` 族、`data-file-viewer-open`、`data-mobile-nav-ios`、viewport content、navigator UA/platform spoof、抽屉 inline transition/transform/content-visibility）都有对应还原路径（`frame-marker`/`file-viewer`/`phone-chrome`/`aionui-compat`/`sidebar-swipe.releaseFollowStyles+revealDrawerContent`）。**唯一的状态丢失是 B1。**
3. **未配对但无害的 4 处（列出以免被当成泄漏）**：
   - `index.tsx:53-55` 的 `setTimeout(…,0)` 未进 disposer —— 回调先判 `tag.isConnected`，dispose 已 `tag.remove()` → 必然 no-op。
   - `composer-keyboard-guard.ts:95` 的 `setTimeout(restore,0)` —— `restore()` 幂等（先查 `[data-mobile-nav-focus-shadow]`，找不到就返回），dispose 也直接调它。
   - `sidebar-swipe.ts:820-822` 的双层 rAF 未记 id —— 回调只有 `revealDrawerContent()`（`cvDeferred` 守卫 + `removeProperty`），dispose 后调用是无害 no-op。
   - `session-menu.ts:224-258` 的删除请求 `await` 之后仍会执行 —— 但 `ctx.layout.toggleSidebar()` 被 `matchMedia(MOBILE_QUERY).matches` 门控，desktop 侧不会误收；只有「插件被卸载且仍是移动分支」这一瞬时窗口能触发一次多余 toggle。
4. **时序/竞态（第 4 项）盘过 `pointerup` 收容器的先例**：`phone-chrome.onDrawerPointerUp` 对**已选中会话行**在 pointerup 里 `toggleSidebar()`（会取消该行的 click），但那一行的语义就是 no-op，且仓库已在 2026-09-13 把**非行导航目标**的关闭挪到 click；未选中行走 `closeOnNavigation` + `ctx.sessions.open(id)` 自己开会话，不依赖被取消的 click。没找到新的同类竞态。
5. **异常吞没（第 5 项）**：全仓库 `catch` 共 7 处，逐条读过 —— 无空 catch 掩盖真实错误路径：`phone-chrome.ts:294`（CSS.supports 探测）、`sidebar-swipe.ts:621`（selectionStart 在非文本 input 上抛 InvalidStateError，注释已说明）、`session-menu.ts:236/241/339`（都落到可见的失败卡片）、`debug.ts:101`（beacon 无监听器时静默，文档化）、`reconciler-core.ts:82/89`（task 错误上报 `console.error`，不吞）。`?.` 的使用集中在「元素可能已卸载」的查询上，未发现掩盖真实分支的用法。

## 自检：我可能错在哪
- **B1** 全靠静态链（工厂只跑一次 + dispose 置空 + 再激活只跑 ensure）。若宿主某处会在 MQ 变化时重建 plugin（重跑 `apply`），我的结论就会缩水成「仅同一 JS 环境内的切换会丢」；建议按报告里的运行时验证跑一遍再定稿。
- **B3** 我只证明了「观察器看不到纯文本更新」这个源码事实，**没有**证明用户能看见后果；TPS 是否真的被原地改写、是否总有伴随 mutation，需要实测（给了命令）。**不要按「已复现 bug」对外表述。**
- **B5/B6 是线索不是结论**，未构造出真实时序；B5 的活页面检查若显示工具栏头就是首个 `_header`，则应降级为「脆弱但当前正确」。
- 我的 marker 差集依赖「字面量出现在同一行」的分类启发式（JSX 属性会被算成读方、常量名如 `IOS_MARKER` 会被算成无写方），所以**没有**直接用它会话的 w/r 计数下结论，每条都做了字面量级 grep 复核（B2 的计数是逐字面量 grep 出来的）。
