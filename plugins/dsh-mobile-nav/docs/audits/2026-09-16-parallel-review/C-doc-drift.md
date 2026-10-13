# C — 文档与实现漂移审查（只读）

Status: **DONE_WITH_CONCERNS**（发现数 = 16；其中 7 条 P1）

**基线说明（重要）**：审查期间父会话在改 CSS，行号在动。下列 sha1 是我做最终核验时的读数，引用行号以这份为准；`layout.css.ts` 在我审查期内从 1126 行 → 1121 → 1116 行（三次读数）、`compat.css.ts` 930 → 928 → 924、`misc.css.ts` 277 → 281，故 CSS 里的结论请按**选择器/文本内容**定位，不要按行号。

```
c6c8a94574c9f88b9e89a52c8378cd3e82e41136  src/client/styles/layout.css.ts   (1116 行)
e6f2bac570a1fcb4e237dd151a8ae58cd21efe35  src/client/styles/base.css.ts     (285 行，与冻结值一致)
68c976b333c45cab42b8217e56fbd501f2c91bc0  src/client/styles/compat.css.ts   (924 行)
fad30b91c45dbb393b9fb79399662ee0803b7c96  src/client/styles/misc.css.ts     (281 行)
```
CONTEXT.md 里 compat 的冻结值 `110f753c…` / 930 行、layout 的 `ef22d818…` / 1126 行、misc 的 `4f5a5477…` / 277 行均已不再匹配（前两个是父会话明说的修改，misc 也在动）。

**已按要求排除**：AGENTS.md 的 rev 对账食谱（1d5ab8d 已修）、`data-mobile-nav-gen` 三处「已删除」（6111603 已修）、A–F 已知条目、B1 两条 `[class$=]` 散文（acc26ec 已修）。

---

## P1 · 会直接误导维护者做错改动的

### C-01 `layout.css.ts` 注释里的手势识别区是旧值 48px（且引用了不存在的常量）
- **文档原文**：`src/client/styles/layout.css.ts:150` — `capture listener (START_ZONE_PX = 48px); there is no hotspot element (removed per audit C2, 2026-08-27).`
- **源码事实**：全仓库不存在 `START_ZONE_PX`；识别区是比例常量 `START_ZONE_RATIO = 0.45`（`src/client/effects/sidebar-swipe.ts:77`），经 `startZonePxFor()`（同文件 :84）按视口现算 —— 390px → 176px。
- **证据命令**：
  ```sh
  grep -rn "START_ZONE_PX\|START_ZONE_RATIO = " src/client/
  # src/client/effects/sidebar-swipe.ts:77:const START_ZONE_RATIO = 0.45
  # src/client/styles/layout.css.ts:150:     capture listener (START_ZONE_PX = 48px); ...
  ```
- **影响**：这正是 AGENTS.md:158 自己记下的教训形态（「v2.3.0 定稿时发现识别区残留中间轮次旧值 96px」）——同一个旧值在**另一个文件**的注释里活了下来。维护者改手势 CSS 时会以为判定是「边缘 48px 固定带」，据此调参或写断言会与 45%（176px@390）的真实行为对不上。

### C-02 同一文件另一条注释的识别区也是旧值 96px
- **文档原文**：`src/client/styles/layout.css.ts:33` — `zone (96px, beyond every browser's edge-claim strip) is the mitigation.`
- **源码事实**：同 C-01，现行值是 0.45×视口宽（390px → 176px）；96px 是 2026-08-29 第四轮的中间轮次值（演进链见 `sidebar-swipe.ts:62-70` 的 `History of the constant`）。
- **证据命令**：`grep -n "96px" src/client/styles/layout.css.ts`（唯一命中即该注释）；`sed -n '60,70p' src/client/effects/sidebar-swipe.ts`
- **影响**：与 C-01 同一读者、同一处代码，两条注释互相也不一致（48px / 96px / 真值 176px@390）。iOS 边缘条避让论证建立在错误宽度上。

### C-03 权威手势 spec 自称「终值参数 … START_ZONE 48」，与它自己的参数表打架
- **文档原文**：`docs/specs/2026-08-27-sidebar-swipe-gestures.md:253` — `终值参数见上文「本方案参数（实装值…）」表：START_ZONE 48 / lock 8 / open 0.16 / close 0.13 / vel 0.45/0.45。`
  同文件 `:102`「96px 区覆盖这些容器的左段」、`:103`「靠 96px 区避让其 ~20-40px 边缘条」。
- **源码事实**：同 spec 的参数表 `:93` 写的是「`startZonePx` = **`round(0.45 × 视口宽)`**（390px → 176px）」——与 :253 的 48 直接矛盾；源码为 `START_ZONE_RATIO = 0.45`（`sidebar-swipe.ts:77`）。
- **证据命令**：`grep -n "START_ZONE 48\|96px 区" docs/specs/2026-08-27-sidebar-swipe-gestures.md`；`grep -n "startZonePx" docs/specs/2026-08-27-sidebar-swipe-gestures.md`
- **影响**：AGENTS.md 把这份 spec 定为「权威设计文档（gesture parameters/state machine）」。维护者按 :253 那句「终值」办事会得到 48px 识别区；照 :102/:103 理解会以为横滚让位与 iOS 避让按 96px 设计。**同一文档内部两个终值**是最坏形态：读者只能靠猜。

### C-04 `touch-action`「关键 CSS 一行」的文档值缺 `pinch-zoom`（会打回 #45 修复）
- **文档原文**：
  - `AGENTS.md:132` — `drawer 滚动容器 touch-action: pan-y`
  - `docs/maintenance/pitfalls.md:7` — `关键 CSS 一行：drawer 滚动容器 touch-action: pan-y（不加则横滑被浏览器吃成 pan 发 pointercancel，手势全失效）`
- **源码事实**：`src/client/styles/layout.css.ts:155` 为 `touch-action: pan-y pinch-zoom !important;`（根元素 `:42` 同值）；且该不变式被 `tests/ios-zoom-guard.test.ts:96-101` 断言钉死（`assert.equal(drawer, 'pan-y pinch-zoom !important')`），注释明写「a bare pan-y here would cancel the root grant」。AGENTS.md:142 自己也写着「根/抽屉 `touch-action` **必须含 `pinch-zoom`**」。
- **证据命令**：
  ```sh
  sed -n '154,156p' src/client/styles/layout.css.ts; sed -n '96,101p' tests/ios-zoom-guard.test.ts
  grep -n "touch-action: pan-y" AGENTS.md docs/maintenance/pitfalls.md
  ```
- **影响**：同一份 AGENTS.md 内 :132 与 :142 互斥。按 :132 / pitfalls「关键 CSS 一行」执行的人会把抽屉值改回裸 `pan-y`，直接违反 :142 与测试断言 —— 正是 #45「一输入就放大且捏合缩不回」的复现路径。

### C-05 AGENTS.md 维护入口写的结构检测基线已失效（16 fatal → 实为 0）
- **文档原文**：`AGENTS.md:218` — `结构检测器 node scripts/css-structure-check.mjs（当前基线 16 fatal＝A1 的债，T1 清零）`
- **源码事实**：实跑（只读，脚本内无任何写文件调用）：
  ```sh
  node scripts/css-structure-check.mjs
  # css-structure-check: 4 modules, 0 fatal, 2 info   （layout c6c8a945… / compat 68c976b3… 读数）
  #   info layout.css.ts:997  progressive-enhancement fallback pair for "max-height"
  #   info compat.css.ts:784  selector split across rules in one scope (first at 764)
  # 更早一次（layout f2be737f…）为 0 fatal / 5 info；两次都是 0 fatal
  ```
  A1 的重复 media + 缩进已由 `26ca8e9` 落地（`git log --oneline` 可见），检测器输出随之为 0 fatal。
- **影响**：维护者读到「当前基线 16 fatal」会以为 T1 未开工、树里有 16 条致死结构债，并可能照 `docs/audits/2026-09-15-css-surface-audit.md` 的 T1 任务重复施工；同时会把实跑的 0 fatal 当成「检测器坏了」。

### C-06 `ReconcilerTask` 类型来源被写反（「六个 task 模块经 phone-chrome.ts 拿」）
- **文档原文**：`AGENTS.md:123` — `仍然要守的既有事实：reconciler-core.ts 保持零 import；六个 task 模块经 phone-chrome.ts 拿 ReconcilerTask 类型（现为 import type，编译期擦除、不进 bundle）。`
- **源码事实**：共 8 个 effect 模块引用 `ReconcilerTask`，其中**只有 1 个**（`aionui-compat.ts:2`）来自 `./phone-chrome.ts`，**另外 7 个**都来自 `'../core/reconciler-core.ts'`（file-viewer-compat、git-chip-reparent、overlay-backdrop-fab、phone-chrome、preview-fullscreen、settings-toolbar-reparent、stats-line）。
- **证据命令**：
  ```sh
  grep -rn "ReconcilerTask" src/client/effects/*.ts | grep import
  grep -n "from './phone-chrome.ts'" src/client/effects/*.ts
  ```
- **影响**：数量错（1 ≠ 6）且方向错（reconciler-core 才是类型的定义源）。新 task 模块的作者会照这句去 phone-chrome.ts 找类型并写出不必要的间接依赖；审计「类型从哪来」时会把 7 个正确 import 当成违规。

### C-07 宿主升级 runbook 仍保留父会话刚在 AGENTS.md 里否掉的 rev 对账法（未修的姊妹处）
- **文档原文**：
  - `docs/upstream/upgrade-runbook.md:10` — `sha1sum ~/dsh-mobile-nav/lib/client.js   # rev = 前 12 位`
  - `docs/upstream/upgrade-runbook.md:52` — `rev = sha1sum lib/client.js 前 12 位（服务端 no-cache，rev 仅缓存 bust…）`
- **文档/源码事实**：`AGENTS.md:170` 已按 0.1.5 实测改成「**rev 既不是 sha1(lib/client.js) 也不是 sha1(served)**（实测 760a4196b484 vs c37fc641a402 / ffcefb5084f8）——别用 rev 对账」。runbook 两处仍是旧食谱，且 runbook **是入库文件**（`git ls-files docs/upstream/` 列出它）。
- **证据命令**：`grep -rn "rev" docs/upstream/upgrade-runbook.md`；`git ls-files docs/upstream/`；`grep -n "rev 既不是" AGENTS.md`
- **影响**：每次宿主升级都要按 runbook §0/§2 走一遍；照旧食谱算出的 rev 与 served bundle 无关（AGENTS 的实测给出三组互不相等的 sha1）。这是本次被修条目在**另一份入库文档**里的副本，父会话只修了 AGENTS.md 而 runbook 未被覆盖。

---

## P2 · 局部误导 / 单项事实漂移

### C-08 主探针里还有一处被仓库明令禁止的 `[class$=]` 活选择器
- **文档原文（规则）**：`AGENTS.md:120` — `For unavoidable hashed classes use substring matching ([class*=_frag]), never attribute-suffix ([class$=…])`
- **源码事实**：`scripts/cdp-probe.mjs:544` — `const card = document.querySelector('textarea')?.closest('[class$="_card"]');`（**是选择器本体，不是注释**）
- **附带事实**：`EXPECTED_FAILURES` 的匹配只对带 `includes` 的条目查 detail（`scripts/cdp-probe.mjs:65-73`），`integration.gitgraph.reparented` 无 `includes`，因此该断言一旦因选择器失配变成 `hasCard=false`，仍会被记成 BASE、SUMMARY 报 `new=0`、退出码 0。今天基线里的 detail 是 `hasCard=true reparented=false`。
- **证据命令**：`grep -rn 'class\$=' scripts/ tests/ src/`（scripts 下唯一命中即 :544）
- **影响**：仓库花了一次全量迁移（d586aa5）才摆脱后缀失配，主探针自己仍在用；且这条断言的失败模式被基线吸收，失配不会报警——审计者会看到「BASE 三条」并认为与改动无关。

### C-09 ≤359px 仍有一条把模式名收成图标的规则，而它实际连图标一起隐藏；README/AGENTS 都宣称模式名保留文字
- **文档原文**：
  - `README.md:49`（未发布段）— `手机端会话头不再把模式名压成一个图标：模式名、会话标题与子代理计数各自保留文字…`
  - `AGENTS.md:146` — `模式名（手机端唯一的模式切换入口）与会话标题都保住文字…原先压模式文字的 max-width:18px 两条规则已删除。`
- **源码事实**：`src/client/styles/layout.css.ts:938-942`（`@media (max-width: 359px)`）对 `[class*="_label"]:has(> svg)` 施加 `display: none !important`；其紧邻注释（:936-937）自述 `so the mode chip keeps only its icon`。而 `:724` 与 `:738` 表明该 `_label` 元素**就是图标的父元素**（`:738` 把它的 `> svg` 绝对定位到 left:0），即被 `display:none` 的是「图标+文字」整体。
- **证据命令**：`sed -n '936,942p' src/client/styles/layout.css.ts`；`sed -n '722,743p' src/client/styles/layout.css.ts`
- **残留不确定（诚实标注）**：宿主是否在该 `_label` 之外另画一个图标，我无法在无浏览器条件下证实/证伪；能确定的是「隐藏的正是 `_label:has(> svg)`」与「其注释说图标保留」二者互斥。
- **影响**：README 未发布段与 AGENTS 的让位优先级都被 ≤359px 这条规则部分推翻；读者会以为 320px 级屏幕上模式名仍然可读，排查「模式切不了」时会先漏掉这条规则。

### C-10 「实装版本」清单与 profile 实际不符（AGENTS 自己要求以 profile 为准）
- **文档原文**：`AGENTS.md:205` — `Validate compatible third-party versions when exercising integrations（2026-09-04 实装）：宿主 @deepseek-ai/dsh 0.1.1-rc.2、@linxin666/dsh-web-ui-all 0.1.20、dshmarket 1.38.0、dsh-meme 0.1.39、dsh-usage-stats 0.3.1 (github)、@omdsh-dev/dsh-genui 0.9.1 (github)。以 ~/.dsh/profiles/web/node_modules/<pkg>/package.json 的实装版本为准…`
- **环境事实**（只读读 profile）：
  ```
  @deepseek-ai/dsh                 0.1.5-rc.1   （文档写 0.1.1-rc.2）
  @linxin666/dsh-web-all           0.3.20       （文档写 @linxin666/dsh-web-ui-all 0.1.20；该包名已不在 profile）
  @linxin666/dsh-client-ui-market  0.3.20       （独立包 dshmarket 1.38.0 已不在 profile）
  @omdsh-dev/dsh-genui             0.10.0       （文档写 0.9.1）
  dsh-meme                         0.1.39   ✓
  @ychris12138/dsh-usage-stats     0.3.1    ✓（包名与文档写法不同）
  ```
- **证据命令**：
  ```sh
  for p in @deepseek-ai/dsh @linxin666/dsh-web-all @linxin666/dsh-client-ui-market @omdsh-dev/dsh-genui dsh-meme @ychris12138/dsh-usage-stats; do
    node -e "console.log(require('$HOME/.dsh/profiles/web/node_modules/$p/package.json').version, '$p')"; done
  ls ~/.dsh/profiles/web/node_modules | grep -i market   # 无 dshmarket，只有 @linxin666/dsh-client-ui-market
  ```
- **影响**：插件有大量规则是**按宿主版本分代**写的（0.1.2-rc.1 Lexical、0.1.5 抽屉/菜单换形）。清单说实装 0.1.1-rc.2，而 profile 是 0.1.5-rc.1 —— 维护者会以为自己在旧代上验证，或据此判定某条 0.1.5 规则「本机测不到」。README:166-167（兼容插件表：dsh-web-ui-all **0.1.20** / dshmarket **v1.38.0**）同样与 profile 的包名/版本脱节。

### C-11 一个文档 bullet 把两个 phone-chrome 常量记到了 subagent-chip-touch 名下（且窗口值不同）
- **文档原文**：`AGENTS.md:161`（标题即 `子代理芯片触摸兼容（subagent-chip-touch.ts）`）— `…行导航不依赖合成 click 时序（iOS 壳整体吞），用 aria-selected MutationObserver arm（2000ms 自 disarm）；document 捕获 click 在行 tap 后 500ms 让位。`
- **源码事实**：`aria-selected` MutationObserver 与 2000ms disarm 在 `src/client/effects/phone-chrome.ts:539`（`attributeFilter: ['aria-selected']`）与 `:541`（`navTimer = window.setTimeout(disarmNav, 2000)`）；「500ms 让位」在 `:675`（`if (performance.now() - lastTouchNavAt < 500) return`）。`subagent-chip-touch.ts` 里既无 MutationObserver，也无 500ms —— 它自己的 click 宽限是 `CLICK_GRACE_MS = 1000`（同文件 :69）。`pitfalls.md:95` 的记录是对的（把 nav-arm / 500ms 归在抽屉导航语境）。
- **证据命令**：
  ```sh
  grep -rn "MutationObserver\|CLICK_GRACE_MS" src/client/effects/subagent-chip-touch.ts
  grep -n "aria-selected\|disarmNav, 2000\|lastTouchNavAt < 500" src/client/effects/phone-chrome.ts
  ```
- **影响**：改芯片兼容的人会去 `subagent-chip-touch.ts` 找/改一个不存在的 2000ms arm，或把该文件的 `CLICK_GRACE_MS=1000` 当成文档说的 500ms 去调 —— 500 与 1000 是两个不同机制的真实值，混一处即引入行为变化。

### C-12 AGENTS.md 的 `§探针环境参数（旧）` 指针在档案里没有对应小节
- **文档原文**：`AGENTS.md:141` — `完整清单（cookie TTL / mint-cookie.mjs / URL 带 token 的陷阱）→ docs/maintenance/pitfalls.md §探针环境参数（旧）与 §探针运行环境。`
- **档案事实**：`docs/maintenance/pitfalls.md` 的 `##` 小节只有 `## 探针运行环境：cookie TTL、headless chromium 与 Playwright MCP（2026-09-14 实测定稿）`；全文搜不到「探针环境参数」。
- **证据命令**：`grep -n "探针环境参数" docs/maintenance/pitfalls.md`（无输出）；`grep -nE '^## ' docs/maintenance/pitfalls.md`
- **为何守卫没拦住**：`tests/docs-consistency.test.ts:91-121` 的指针解析是启发式，其 ponytail 注释（:73-78）自陈「真实助记符 断点与设备（0.571）与编造的 不存在的主题xyz（0.556）在阈值下不可分」——`探针环境参数（旧）` 靠 CJK 窗口（探针/环境…）落在已有正文上而通过。
- **影响**：按指针 grep 的人会找不到「（旧）」小节，误以为 cookie TTL / mint-cookie 的证据缺失（实际已并入「探针运行环境」）。

### C-13 runbook 写的契约条数与 JSON 实际不符
- **文档原文**：`docs/upstream/upgrade-runbook.md:29` — `数据：docs/upstream/compat-contracts.json（22 条，lazy 标记状态门控/懒加载条目）`（另 :27 记录首跑 `19 HIT / 3 SKIP / 0 MISS`）
- **源码事实**：JSON 现在是 26 条，其中 `lazy: true` **11** 条：
  ```sh
  node -e "const c=require('./docs/upstream/compat-contracts.json');console.log(c.contracts.length, c.contracts.filter(x=>x.lazy).length)"
  # 26 11
  ```
- **残留不确定**：`19 HIT / 3 SKIP / 0 MISS` 是某次运行的读数，需要真机页面才能复核（本审查不起 chromium），不作断言。
- **影响**：「22 条」会让按条盘点的人以为少了 4 条记录（或以为 JSON 被误加条目而回删）；lazy 数与「3 SKIP」并列时读者会误判门控条目规模。

### C-14 README 的 v2.1.1 条目仍在承诺「保留宿主 maximum-scale」
- **文档原文**：`README.md:151` — `viewport meta 改写保留宿主 maximum-scale，页面缩放行为与官方一致`
- **源码事实**：`src/client/effects/phone-chrome.ts:313` — `const VIEWPORT_CONTENT = 'width=device-width, initial-scale=1, viewport-fit=cover'`；`:366` 在宿主改写后重申该串、`:405-406` 仅在 dispose 还原原串。AGENTS.md:142 明写「**不要改回 `maximum-scale=1`**（iOS 10+ 忽略、安卓/桌面认真执行）」「写入永不带缩放锁」。
- **证据命令**：`grep -n "VIEWPORT_CONTENT" src/client/effects/phone-chrome.ts`；`sed -n '151p' README.md`
- **影响**：属历史变更条目（v2.1.1），但它是 README 里唯一提到 maximum-scale 的句子，与当前 #46 契约（插件拥有 meta、永不带缩放锁）方向相反；照它回填 release notes 或据此验收会判错。

### C-15 调试地图（本地文档）里的市场选择器仍写成后缀匹配
- **文档原文**：`docs/debug/settings-market-debug-map.md:78-79` — `| 市场 tabs 行 | [aria-modal] [class$="_tabs"] wrap + _searchInline 全宽 |`、`| 标题行 | [class$="_titleRow"] wrap；_title 单行 ellipsis…|`
- **源码事实**：`src/client/styles/compat.css.ts` 用的是子串匹配（`[aria-modal="true"] [class*="_tabs"]`、`[data-mobile-nav="frame"] [aria-modal="true"] [class*="_titleRow"]`）。
- **证据命令**：`grep -n '_tabs\|_titleRow' src/client/styles/compat.css.ts`；`grep -n 'class\$=' docs/debug/settings-market-debug-map.md`
- **影响**：同 B1 形态的**未修**副本，且这份地图是「排查该区域先读它」的入口（AGENTS Testing&QA）；按它写出的选择器在真实 DOM 上会静默失配。注：该文档 gitignore、仅本地可见（`git check-ignore docs/debug/settings-market-debug-map.md` 命中）。

### C-16 仓库树把 `components/` 注释成 2 个文件，实际 3 个
- **文档原文**：`AGENTS.md:26`（树）— `│     ├─ components/       ← MobileNavToggle / MobileDrawerFooter`
- **源码事实**：`ls src/client/components/` → `MobileDrawerFooter.tsx`、`MobileNavToggle.tsx`、`open-files-panel.ts`。`open-files-panel.ts` 不是边角料：它是右缘 files 手势的动作入口（spec 2026-09-13 与 AGENTS 的 files 手势条目都依赖它，`index.tsx` 以参数注入）。
- **证据命令**：`ls src/client/components/`；`grep -rn "openFilesPanel" src/client/index.tsx`
- **影响**：低。读者找「打开文件列表面板」的实现会先在 `effects/` 里翻。

---

## 已核验为**准确**的文档断言（避免父会话重复投入）

计数类全部对得上：effects **14**（`ls src/client/effects | wc -l`）、probes **17**、`tests/*.test.ts` **17**、`docs/specs` **7**、styles **4 个 .css.ts**；`index.tsx` 的两个 slot（header actions `order: 10` / footer `order: 5`）与「无 settings slot」、6 项 `inject`、`reconciler-core.ts` 零 import、`gesture-guard.ts` 零 import、`installMobileEffect` 第 4 参 query 覆盖、`test:core` = `node --test tests/*.test.ts`、engines `>=24.0.0` 均命中。

断言条数：主探针 **32**（28 个固定标签 + `waitDrawerChecked` 的 4 个运行期标签；静态 30 处含 2 处函数定义）、zoom **21**、draggable **15**、drawer-row-actions **13**、hero-composer-clip **12**、header-files-pin **11**、plugin-card-header-bleed **10**、diag-hero-chip **8**、drawer-new-session **5**、files-swipe **8 场景**、cdp-swipe-failures **16 场景**、session-delete 的 15c/15d + 16a-16d。

手势常量与 AGENTS 参数速查逐项一致：`START_ZONE_RATIO 0.45` / `LOCK_PX 8` / `OPEN 0.16` / `CLOSE 0.13` / `VELOCITY_WINDOW_MS 60` / `OPEN&CLOSE_VELOCITY 0.45` / `COOLDOWN_MS 350` / `CONSUME_WINDOW_MS 300` / `CLOSED_SLOT_PCT 110` / `COMMIT_ANIM_MS 280` / `OPEN_FOLLOW_BASE_PCT 101` / `OPEN_FOLLOW_ARM_PX 8` / `FLOATING_WIDGET_MAX_PX 200`；`LONG_PRESS_MS 500` 与 `LONG_PRESS_MENU_GUARD_MS 1200` 在 phone-chrome.ts、`SWALLOW_WINDOW_MS 800` 在 subagent-chip-touch.ts。

z-index 契约逐项命中（唯一例外见上一节末尾的 delete-dialog 基值 55/56）：抽屉列 1300（layout :115）、插遮罩 1250（base :240）、菜单抬升 1400（base :191）、抽屉/文件按钮 `z-index:2`、wide-touch 卡片 420px 居中（base :156-163）、桌面隐藏块=精确补集（misc :257）、session-delete 三件套 pointer-only 块（misc :274-275）。

（补充：文档把删除卡的层写成不带限定的 `delete-dialog-backdrop` 1400 / `delete-dialog` 1401；源码基值是 base.css.ts:133/142 的 **55/56**，1400/1401 只存在于 `@media (max-width: 1023px) and (pointer: coarse)` 内（base :189-198）。因此 v2.4.1 的宽屏触摸分支（≥1024px + coarse，正是该契约存在的理由）拿到的是 55/56；`scripts/probes/session-delete-probe.mjs` 的 16c 只断言弹卡存在、不断言堆叠，抽屉族 5d 才断言 `z >= 1400`。**未验证线索**：该分支下卡片是否真被宿主桌面侧栏遮挡需要浏览器 elementFromPoint，本审查不起 chromium，未下结论。）

表格类：会话头 97→77px（rows 36/32 + tab 32 + `:has(> *)` 门控 + 8px padding 保留）、titleCluster 44→26px、hero 卡片 84→108px、文件面板 `[data-sidebar-right-panel="fullscreen"]` inset 规则只在移动块、消息字号走 `--dsw-font-markdown-base-font-size`、各 media 块与 MOBILE_QUERY 同步（compat 现在只剩移动块一个顶层 media）。

`docs/upstream/` 命令：`node scripts/cdp-compat-contracts.mjs` 确实不要求 `DSH_PROBE_SESSION_ID`、lazy→SKIP、非 lazy MISS 才 exit 1（脚本 :9-11、:261-276）。`docs/upstream/upgrade-runbook.md`、`compat-contracts.json`、`docs/fork-wzxmt-zhc/{README,backlog,log}.md`、`.local-tests/mint-cookie.mjs` 均存在；fork 专项「未配置 remote」与 `git remote -v`（仅 origin）一致。

---

## 自检：我可能错在哪

1. **C-09 的渲染后果未在浏览器里验证**：我确认了「被 `display:none` 的元素是 `_label`，且 `> svg` 在其内部」，但没有活页面证据证明芯片上不留任何图标（宿主可能在 `_label` 外另有图标节点）。该条的**文档 vs 规则**矛盾是确定的，「图标也消失」是需要 CDP 复核的部分。
2. **C-13 的 HIT/SKIP/MISS 我没跑**（会起 chromium，任务禁止）：只断言了 JSON 条数 22→26 与 lazy=11，首跑三点数字未复核。
3. **C-05 的 0 fatal 是在工作区（含未提交改动）上跑的**：若父会话回退 A1 相关提交，基线会变回非 0；我引用的 `26ca8e9` 已在 HEAD 历史里，读数是当前树。
4. **C-10 是「文档 vs 本机环境」而非「文档 vs 源码」**：我按 AGENTS 自己写的口径（以 profile 实装为准）判定，但 profile 是活的——若期间刚升级过依赖，这条的漂移方向请你们裁定。
5. **行号会被父会话的持续编辑打掉**：本报告所有 CSS 行号对应文首那组 sha1；`layout.css.ts` 在我审查期已变动两次（1126→1121 行），引用请按选择器/文本定位。
6. **我没做的**：不起 chromium/CDP、不跑 `pnpm build`、不写仓库文件、不执行任何 git 写操作；运行时事实（宿主 0.1.5 的 DOM 形状、菜单项数、elementFromPoint 命中）一律未复核，也未据此下结论。
7. **写文件方式**：`write` 工具在本目录报 EACCES（`link()` 被拒），报告改用 `bash` heredoc 落盘，内容不受影响。
