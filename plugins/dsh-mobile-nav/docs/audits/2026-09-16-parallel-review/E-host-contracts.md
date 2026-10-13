# E — 宿主契约与第三方兼容（只读审查）

**Status: DONE_WITH_CONCERNS**

- 审查者：E，只读。未编辑仓库文件、未跑 build、未起 chromium/CDP。
- 冻结指纹**已失效**（父会话在读取窗口内改了 compat.css.ts / layout.css.ts）——本报告全部行号用**内容锚**重新取，取自审查当时的工作树：
  - `compat.css.ts` sha1 `2ce7c91ad2319c03fd0f4ca3bac5cbbde4413246`（928 行；CONTEXT 冻结值 `110f753c…`/930 行）
  - `layout.css.ts` sha1 `31f97d67ebaafa12ca781f4c14f58d322cbcca71`（1121 行；CONTEXT 冻结值 `ef22d818…`/1126 行）
  - `base.css.ts` `e6f2bac5…` ✓、`misc.css.ts` `4f5a5477…` ✓ 未变
- 证据语言：**「实测」= 命令输出/文件内容直接可复现；「推」= 由结构推断、未在活页面渲染验证**。

---

## 0. 方法（可复现）

活动页面与我禁起浏览器，所以用**上游语料 + 活页面 boot 清单**代替活 DOM 扫描：

```sh
C=$(grep -o 'dsh-auth-[^=]*=[^ ]*' ~/tmp/mint.out | head -1)
curl -s -H "Cookie: $C" http://127.0.0.1:3080/ > ~/tmp/review-2026-09-16/_live.html   # 200, 28445 B
# 从 __DSH_BOOT__ 取 application batch 的 54 条组合 URL，一次抓全量 served bundle
curl -s -H "Cookie: $C" "$(cat combo-url.txt)" -o served-application.js             # 200, 14050526 B
```

上游语料 = 宿主 `@deepseek-ai/dsh/node_modules/@deepseek-ai/*/lib/client.js` + `dsh-web-frontend/dist/assets/*` + profile `node_modules` 全部 `.js/.css`，**按 realpath 排除本仓库**（`~/.dsh/profiles/web/node_modules/@dsh-external/dsh-mobile-nav` 是指向同一仓库的符号链接，必须排；第一版语料没排，导致 `h8S2Va_` 假 HIT——已修正）。

**关键判据**：语料 ⊇ 活页面（语料读整文件，活页面读已渲染 DOM + 已注入样式表）⇒
- 语料 ABSENT ⇒ 活页面**必然** miss（强结论）
- 语料 HIT ⇏ 活页面 HIT（弱结论，个别条目我另行验证注入时机）

已验证注入时机（实测）：`@linxin666/dsh-web-all` 是**单个 2.5 MB client bundle**，54 条 boot entries 里只此一条；其内部每个 family 的 CSS 都以 `if (document.querySelector("style[data-plugin-css=…]") === null) { … appendChild }` 形式写在**模块顶层**（证据：`node -e` 打印 `lib/client.js` 首个注入点前 1500 字符），因此**被 disabled 的 family 的 CSS 也会被注入**。→ 语料 HIT 的弱结论在这里升格为「会注入」。

---

## 1. 实装版本对账

AGENTS.md「Testing & QA · Validate compatible third-party versions（2026-09-04 实装）」逐条：

| 包 | AGENTS.md 记录 | 实装（`~/.dsh/profiles/web/node_modules/<pkg>/package.json`） | 判定 |
|---|---|---|---|
| 宿主 `@deepseek-ai/dsh` | 0.1.1-rc.2 | **0.1.5-rc.1** | **过期**（漂 4 个 rc） |
| `@linxin666/dsh-web-ui-all` | 0.1.20 | 包名不存在；实体是 **`@linxin666/dsh-web-all` 0.3.20** | **过期（名字+版本双漂）** |
| `dshmarket` | 1.38.0 | **未安装** | **过期（整包消失）** |
| `dsh-meme` | 0.1.39 | 0.1.39 | ✓ 一致 |
| `dsh-usage-stats` | 0.3.1 (github) | `@ychris12138/dsh-usage-stats` 0.3.1 | ✓ 版本一致（scope 名未记） |
| `@omdsh-dev/dsh-genui` | 0.9.1 (github) | 包名与版本皆变：**`@changfenhuang/dsh-genui` 0.10.0** | **过期** |

证据命令：

```sh
node -e "console.log(require('/data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh/package.json').version)"   # 0.1.5-rc.1
node -e "console.log(require('$HOME/.dsh/profiles/web/node_modules/@linxin666/dsh-web-all/package.json').version)"          # 0.3.20
ls -la /data/data/com.termux/files/usr/lib/node_modules/dshmarket
#   -> broken symbolic link to /data/data/.../home/.dsh/profiles/web/node_modules/dshmarket/  （该目录不存在）
```

### 1.1 `dshmarket` 的消失是「三处文档 + 一整块 CSS」的共同前提

实测：`dshmarket` 不是「装了但旧版」，而是**从 profile 组合里彻底退出**。

- 全局 `node_modules/dshmarket` 是**悬空符号链接**（实测 `ls -la` 给 "broken symbolic link"）。
- profile `package.json` 的依赖里没有它（有 `@linxin666/dsh-web-all: ^0.3.20`）。
- `dsh.profile.bundles` 里没有它。
- 活页面 `__DSH_BOOT__` 的 54 条 entries 里 `grep -c dshmarket` = **0**（实测）。
- 替代物：`cordis.patch.yml:93` 的 `web-ui-market` 行 → `@linxin666/dsh-web-all/market` → `@linxin666/dsh-client-ui-market` **0.3.20**（描述 "Workshop browser card"）。

**而且 `web-ui-market` 行当前 `disabled: true`**（`cordis.patch.yml:93-95`）。实测该 profile 的 disabled 清单包含：market / task-board / remote-web-ui / pet / ssh / describe-image / liangshen / skill-explorer / doctor / usage / session-archive / model-capabilities / preset-center / skin-center / i18n / community-plugins / **usage-stats** / **genui** / 等；enabled 的只有 `dsh-web-mobile`（:193-195）、`web-ui-git-graph`（:99-101）、`seshat`（:196-198）。

> 这一条对**契约探针**的影响很大：契约探针只跑活页面，disabled 的 family 若不注入就没有 needle。但 §0 已证明 web-all 聚合包会把**所有 family** 的 CSS 在模块顶层注入——所以「disabled」影响的是 JS 行为，不影响 CSS needle 的可见性。两者必须分开看，别混。

---

## 2. `docs/upstream/compat-contracts.json` 逐条核验（26 条）

探针语义（`scripts/cdp-compat-contracts.mjs`，实测读源码）：
- `kind: "hash"` → `scanText.includes(needle)`，`scanText` = 所有元素 `className` + 所有可达 `CSSRule.cssText`（递归 media）。
- `kind: "marker"` → `document.querySelector(needle)`（**活查询，不可自满足**）。
- `lazy: true` + 缺席 → `SKIP`（不计退出码）；`lazy: false` + 缺席 → `MISS` 且 `exit 1`。

### 2.1 判定表（实测）

| 契约 | lazy | 上游 | 自己 CSS 含该串 | 判定 |
|---|---|---|---|---|
| `sidebar-right-panel` `[data-sidebar-right-panel]` | true | 属性存在于 `dsh-client-ui-sidebar-right` | – | **成立**（marker 需活页面，见 §2.3） |
| `dshmarket-installed-row` `eGUBIq_` | true | **ABSENT** | no | **过期 · 永远 SKIP** |
| `agent-preset-menu` `cubgiG_` | false | `dsh-client-ui-agent-preset` | **YES** | 成立，但**自满足盲区** |
| `subagent-hover-gen` `ZKlsPq_` | false | `dsh-client-ui-subagent` | no | **成立** |
| `subagent-onclick-gen` `h8S2Va_` | true | **ABSENT** | no | **预期 SKIP**（旧世代） |
| `contextmeter` `JObwrW_` | false | `dsh-client-ui-conversation`（`JObwrW_trigger`/`_row`） | no | **成立** |
| `composer-card` `uV2eYG_` | false | `dsh-client-ui-conversation`（`_card/_grow/_row/_scroll/_trailing`） | no | **成立** |
| `frame-class` `pI_x6G_` | false | `dsh-client-ui-layout` | no | **成立** |
| `hero-header-actions` `qDHVXG_` | false | **ABSENT（全盘 0 文件）** | no | **过期 → 探针会 MISS/exit 1** |
| `settings-close` `VOzbGW_` | true | `dsh-client-ui-settings-general` | no | **成立** |
| `user-bubble` `gdEzaW_` | false | **ABSENT（全盘 0 文件）** | no | **过期 → 探针会 MISS/exit 1** |
| `goal-bubble` `oRe1gG_` | false | `dsh-client-ui-goal` | no | **成立** |
| `thirdparty-search-13px` `-NprXq_` | true | **ABSENT** | no | **过期 · 永远 SKIP** |
| `hero-composer-stack` `wSkVaW_` | false | `dsh-client-ui-conversation` | **YES** | 成立，但**自满足盲区** |
| `session-log-dialog` `_dialog_15u5s_22` | false | **ABSENT（已 rehash）** | no | **过期 → 探针会 MISS/exit 1** |
| `official-plugins-card` `YyYd_a_` | true | `dsh-client-ui-settings-plugins` | no | **成立** |
| `group-card-1` `Kwoi6G_` | false | `dsh-remote-web-ui` | no | 成立（CSS 会注入，见 §0） |
| `group-card-2` `bpnj3G_` | false | **ABSENT（全盘 0 文件）** | no | **过期 → 探针会 MISS/exit 1** |
| `group-card-3` `Jh0q7G_` | false | `dsh-client-ui-task-board` | no | 成立 |
| `group-card-4` `jmhvDG_` | false | **ABSENT（全盘 0 文件）** | no | **过期 → 探针会 MISS/exit 1** |
| `group-card-5` `rUBhvW_` | false | `dsh-tool-describe-image` | no | 成立 |
| `workspace-session-row` `_sessionRow` | true | `dsh-client-ui-workspace`（`YDXeBa_sessionRow`） | no | **成立** |
| `workspace-menu-item` `_itemLabel` | true | `dsh-web-frontend`（裸 `_itemLabel`） | no | **成立** |
| `workspace-group-section` `_groupSection` | true | `dsh-client-ui-workspace`（`bhn1Oq_groupSection`） | no | **成立**（前缀已从 `qDHVXG_` 换成 `bhn1Oq_`，子串匹配仍命中） |
| `marker-lexical-composer` `[data-composer-input]` | true | `dsh-client-ui-conversation` | – | **成立**（marker 需活页面） |
| `marker-conversation-overlay` `[data-conversation-composer-overlay]` | true | `dsh-client-ui-conversation` + `dsh-client-ui-trajectory` | – | **成立** |

**汇总：23 条 hash 契约里 15 HIT / 8 ABSENT；8 条 ABSENT 中 5 条非 lazy（探针会红）、3 条 lazy（永远 SKIP）。**

定位命令（全部 0 命中，含 `.map`，覆盖宿主树 + profile 树）：

```sh
grep -rl -F 'qDHVXG_' /data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/ ~/.dsh/profiles/web/node_modules/   # 0
# 同样 0 命中：gdEzaW_ / bpnj3G_ / jmhvDG_ / _dialog_15u5s_22 / eGUBIq_ / -NprXq_
```

### 2.2 五条「过期」契约的替代物（可直接拿去改）

| 旧 needle | 现役替代（实测） | 位置 |
|---|---|---|
| `_dialog_15u5s_22` | **`_dialog_w1urq_22`** | 宿主共享 Dialog 原语：`_root_w1urq_2 / _mask_w1urq_14 / _dialog_w1urq_22 / _content_w1urq_37 / _header_w1urq_45`（`dsh-web-frontend/dist/assets/index-DP…css` + `index-BK…js` 的 classmap 字面量）。**同一模块只是 rehash**（`15u5s`→`w1urq`，序号 `_22` 未变）——注意这是**构建哈希**，每次上游 build 都会变，作为契约 needle 天生高漂移。 |
| `qDHVXG_` | hero 的 headerActions 现为 **`wSkVaW_headerActions`**（`dsh-client-ui-conversation`） | 与 AGENTS.md「宽度断点 ≠ 设备判定」条里写的 `qDHVXG_headerActions` 已经不是一个东西 |
| `gdEzaW_` | 用户气泡现为 **`Sixlwa_bubble` / `Sixlwa_userStack`**（`dsh-client-ui-chat`） | layout.css.ts:285-286 的**注释**还在指 `gdEzaW_bubble` |
| `bpnj3G_` / `jmhvDG_` | 现役分组卡前缀集合（`@linxin666/dsh-web-all/lib/client.js` 实测）：`Kwoi6G_` `Jh0q7G_` `rUBhvW_` `kKk9aW_` `eDzMgW_` `VadyJG_` `RcIGlq_` `cBrkua_` `bkhjFa_` `Qzh-QG_` `yoSR5W_` `fThDlq_` | 5 条 `group-card-*` 契约里 2 条已无主；`kKk9aW_`/`VadyJG_`/`eDzMgW_` 等是候选新卡头，**需活页面确认哪几张是「设置里的插件分组卡」**（我无法渲染，标「未验证」） |

### 2.3 我**无法**验证的部分（诚实边界）

- 3 条 marker 契约（`[data-sidebar-right-panel]`、`[data-composer-input]`、`[data-conversation-composer-overlay]`）只能靠 `document.querySelector` 判活。我只能证明**属性名仍由对应包产出**（`locate` 命中宿主 `dsh-client-ui-sidebar-right` / `-conversation` / `-trajectory`），**不能**证明特定状态下面板真的渲染。结论写「成立（属性在产）」而非「活页面已 HIT」。
- §2.1 里 15 条 HIT 中，属于 **disabled** family 的（`Kwoi6G_`、`Jh0q7G_`、`rUBhvW_`）我论证了「CSS 会注入」（§0），但**没有**在活页面确认其元素真的渲染。

---

## 3. 探针机制缺陷：hash 契约可以被**自己的 CSS** 满足

### 3.1 机制

hash 契约走的是 **文本扫描**（`scanText.includes(needle)`），而 `scanText` 包含 `document.styleSheets` 里每条规则的 `cssText` —— **本插件自己注入的那一个 `<style data-plugin>` 也在 `document.styleSheets` 里**。于是：只要 `src/client/styles/*.css.ts` 的选择器里出现过某个前缀，该契约就**永远 HIT**，上游把类名删光了也照样绿。

### 3.2 实测（判据：先把 CSS 注释剥掉——`cssText` 不含注释，注释里的 needle 不构成自满足）

```js
const noc = raw.replace(/\/\*[\s\S]*?\*\//g, '')   // 剥注释后再 includes()
```

结果：**23 条 hash 契约里恰好 2 条自满足**——

| 契约 | needle | 出现在自己的**选择器**里 |
|---|---|---|
| `agent-preset-menu` | `cubgiG_` | YES（compat.css.ts 的 `[role="menu"]:has([class*="cubgiG_item"])` 一族） |
| `hero-composer-stack` | `wSkVaW_` | YES（layout.css.ts 多处 `[class*="wSkVaW_…"]`） |

> 修正记录：不剥注释时会得到 16 条「自满足」的假结论——因为 `layout.css.ts:285-286` 等**注释**里写了 `gdEzaW_bubble`/`qDHVXG_` 等名字。剥注释后只剩 2 条。**这一条本身就是教训：注释里的哈希不构成自满足，别用裸 `includes` 判。**

`marker` 契约不受影响（活查询）。**这 2 条契约在「上游改名」这一唯一要防的事故上失效**——它们只会在「插件自己也改了选择器」时才可能红，而那不是它们要守的东西。

### 3.3 5 条非 lazy 契约的**真实** MISS 会被探针报出来（好消息）

`qDHVXG_` / `gdEzaW_` / `_dialog_15u5s_22` / `bpnj3G_` / `jmhvDG_` 都不自满足 ⇒ 今天跑 `node scripts/cdp-compat-contracts.mjs` 应当 `miss=5 / exit 1`。

**但这个门没有人会撞上**（见 §5 R1）：它需要活浏览器 + 手动跑，不在 `.github/workflows/ci.yml` 的 verify→test:core→build→lib-freshness 里。

---

## 4. 第三方 CSS 干预点的过匹配风险

全部规则都在 `@media (max-width: 1023px) and (pointer: coarse)` 内（compat.css.ts:6 起，:814 收；嵌套 `max-width:560px` 在 :328，`prefers-reduced-motion` 在 :211）——**桌面不泄漏**，这点没问题。下面是移动分支内部的过匹配。

术语：**「族数」= 上游语料里含该子串的 distinct class 名数量**（`overmatch.mjs`，实测）。

### 4.1 结构上已「无主」的干预点（死规则，配上 §1.1 的 dshmarket 消失）

| compat 位置（内容锚） | 选择器 | 上游族数 | 误伤/失效说明 |
|---|---|---|---|
| `_opPanel` fixed 居中块（注释 "dshmarket polish: Tasks operations popup"） | `[data-mobile-nav="frame"] [aria-modal="true"] [class*="_opPanel"]` | **0** | 死规则；无副作用 |
| `_titleRow` wrap 三连（注释 "dshmarket polish: header title row"） | `[class*="_titleRow"]` + `[class*="_title"]` + `button` | `_titleRow` **1**（`wSkVaW_titleRow`，宿主 conversation）；另有 `dsh-remote-web-ui` 用**裸 `_titleRow`** | **要修的市场标题行已不存在**；规则变成「任何模态里的 `_titleRow` 都 wrap」。`_title` 上游 38 族，但被 `_titleRow` 祖先限定，风险可控 |
| `dshmarket 1.20+ nav 反制` | `[role="dialog"]:has([data-dsh-market-root]) > nav { display:flex !important }` | `data-dsh-market-root` **0** | 死规则 |
| market 搜索框 iOS 16px | `[data-dsh-market-root] [class*="tabSearch"] input` | `tabSearch` **0** | 死规则 |
| market tab 行 | `[aria-modal="true"] [class*="tabSearchRow"]` | `tabSearchRow` **0** | 死规则 |
| 市场搜索行换行 | `[aria-modal="true"] [class*="_searchInline"]` | `_searchInline` **0** | 死规则 |
| 已安装列表 outer-row 五连（`irow` 族） | `[class*="irow"]:not([class*="irowActions"]):not([class*="irowTrailing"]) > … [class*="spec"｜"nm"｜"grow"｜"switch"｜"owner"]` | `irow` **0** · `irowActions` **0** · `irowTrailing` **0** | **整族死**。注意这些后代片段本身**毫无 owner 限定**（`spec`/`nm`/`grow` 这种两三字母片段在别处命中面极大）——今天靠 `irow` 祖先挡着，**一旦 `irow` 复活，误伤面不受控** |

> `irow` 族的死法与 AGENTS.md 的因果链一致：那 5 条规则的注释/文档都指向 `eGUBIq_irowActions`，而 `eGUBIq_` 整族已随 dshmarket 消失。

### 4.2 仍然活着、但**没有 owner 限定**的干预点（真过匹配）

| compat / layout 位置（内容锚） | 选择器 | 族数 | 会误伤什么 |
|---|---|---|---|
| 「market tab row 换行」 | `[aria-modal="true"] [class*="_tabs"] { flex-wrap:wrap; row-gap:8px }` | `_tabs` **8** | 只按「模态里的 `_tabs`」判定，与市场无关。上游 8 族含**宿主自己的** `wSkVaW_tabs`（conversation）、`pbvGtq_tabs`（settings-plugins），第三方 `bkhjFa_tabs`(market) / `cBrkua_tabs`(skill-explorer) / `yoSR5W_tabs`(session-archive) / `cvtkAW_tabs`(usage) / `V1MMBW_tabs`(genui)。**误伤：任何模态里本来该 nowrap 或按自己的 gap 排布的 tab 行都被强制 wrap + 8px 行距。** |
| 「drawer footer 两行」 | `[data-mobile-nav="frame"] [class*="_footerActions"]` | `_footerActions` **2** | 命中 `hHd-Xa_footerActions`（sidebar，**本意**）与 `Mbwy4a_footerActions`（**user-questions**）。**推**（未在活页面验证 portal 归属）：若用户提问模态渲染在 frame 子树内，它也会拿到 `flex-wrap:wrap; gap:6px`。frame = `[data-shell-overlay]` 的 parentElement（phone-chrome.ts `findFrame`），而宿主部分 overlay 走 body portal，故此项**未定性** |
| git 胶囊净空 | `[data-mobile-nav="frame"] [class*="_card"]:has([data-gitgraph-chip-anchor]) { padding-top:44px }` | `_card` **92** | `:has()` 会命中**每一层**带 `_card` 的祖先。**推**：若胶囊上方存在嵌套 `_card`（card 套 card），每层各加 44px，净空翻倍。92 族的基数让「嵌套存在」不可忽略；无门可红 |
| 设置行竖排 | `[aria-modal="true"] [class*="_section"] [class*="_row"]:not(×5) { flex-direction:column }` + 首/末子 `width:100%` | `_section` **25** · `_row` **83** | 已有 5 段 `:not` 守卫（作者记为 C3/D 类债），但**判定域是「任何模态」**而非设置页：`ZkiH0q_section`(chat) / `zGbnIq_section`(settings-models) / `bhn1Oq_section*`(workspace) 等下属的 `_row` 全在射程内 |
| header 拥挤 | `[class*="_scroll"]:not([class*="_scrollBody"]):not(:has([data-composer-input])):has(p)`（layout） | `_scroll` **5** | 命中 `uV2eYG_scroll`（本意）与 `wSkVaW_scroll` / `EvIC1a_scroll`（chat）。`:has(p)` 已收窄，风险低 |
| `_statsRow` 竖排 | `[class*="usg_"][class*="_statsRow"]` | `usg_` 命中 1 包 | **成立**：usage-stats 用的是**无哈希**前缀 `usg_statsRow`（实测 `".usg_statsRow{display:flex;gap:8p`）。这条不是过匹配，特别记一笔以免被误杀 |
| 预设菜单弹层 | `[role="menu"]:has([class*="cubgiG_item"]) [class*="_viewport_"]` | `_viewport_` 1 | 由 `:has(cubgiG_item)` 圈定，可控。注意**此处的 `cubgiG_` 同时是自满足源**（§3.2） |

### 4.3 结论一句话

**死规则（无主）7 处**：`_opPanel`、`_titleRow` 三连、`data-dsh-market-root`×2、`tabSearch`、`tabSearchRow`、`_searchInline`、`irow` 族五连。
**活着的过匹配 4 处**：`_tabs`（无 owner 限定，最宽）、`_footerActions`（2 族，1 族误伤·未定性）、`_card:has()`（嵌套双倍·推）、`_section _row`（任何模态）。

---

## 5. 升级风险清单：改名后**静默失效且没有门会红**

| # | 风险 | 为什么没有门 | 证据 |
|---|---|---|---|
| **R1** | 5 条非 lazy 契约已失真（`qDHVXG_`/`gdEzaW_`/`_dialog_15u5s_22`/`bpnj3G_`/`jmhvDG_`） | `cdp-compat-contracts.mjs` 需要活浏览器 + 手动跑；`.github/workflows/ci.yml` 只有 verify → test:core → build → `git diff --exit-code lib`。契约探针**不在 CI** | CI 文件 + 探针 `readConfig`（要 `DSH_PROBE_CHROME`） |
| **R2** | §4.1 那 7 处死规则 | 无任何门覆盖 CSS 选择器的**有效性**（`css-structure-check.mjs` 只查结构 fatal，不查选择器命中） | `docs/audits/2026-09-15-css-surface-audit.md` 定位为结构检测器 |
| **R3** | §3.2 的 2 条自满足契约（`cubgiG_`、`wSkVaW_`） | 探针永远 HIT | 剥注释后的 `includes` 实测 |
| **R4** | `eGUBIq_` / `-NprXq_` 真实失效 | `lazy: true` ⇒ SKIP，不计退出码 | 契约 JSON `lazy` 字段 + 探针 `status = found ? 'hit' : (contract.lazy ? 'skip' : 'miss')` |
| **R5** | `_titleRow` 规则**换了打击目标**（市场没了，改打 conversation/remote-web-ui） | 选择器仍「有效」，没有门判「打的是不是该打的那个」 | §4.1 |
| **R6** | `[class*="irow"]` 族一旦复活，其后代片段（`spec`/`nm`/`grow`/`switch`/`owner`）**无 owner 限定** | 无门 | §4.1 |

---

## 6. 文档/食谱漂移（含协调者点名的「拿哈希当版本凭据」同类）

### 6.1 `docs/upstream/upgrade-runbook.md` 的 rev 食谱**实测错误**

```
:10   sha1sum ~/dsh-mobile-nav/lib/client.js   # rev = 前 12 位
:52   … rev = `sha1sum lib/client.js` 前 12 位
```

实测（同一时刻）：

```
活页面 __DSH_BOOT__ 里 dsh-web-mobile 的 rev = 6d6b8afda63c
sha1(lib/client.js)                        = 70e6f5deeb99     <-- 不等
md5 (lib/client.js)                        = 4e642370607b
```

**结论：这两行是错的**，与 AGENTS.md「页面状态/bundle 校验」条已经改正的说法（"rev 既不是 sha1(lib/client.js) 也不是 sha1(served)"）**直接冲突**。AGENTS.md 改了、runbook 没跟。这正是「同一类过期食谱」的第二处。

附带实测：单个包路的组合 URL 一律 404（`/plugins/??dsh-web-mobile/client.js`、加 `@linxin666/dsh-web-all/client.js` 两段、`&rev=` 有无，四种都 404 空 body，`sha1` = `da39a3ee5e6b`）；**只有 `__DSH_BOOT__` 里那条 54 段的完整 URL 才 200**。所以「路径猜错拿 404」在 0.1.5 上比 runbook 描述的更严格——**不能靠「猜一条组合 URL」取 served 内容**。

### 6.2 `compat-contracts.json` 的计数与基线陈述过期

- runbook:29 写「**22 条**」；实测 `compat-contracts.json` 是 **26** 条（lazy 11 / 非 lazy 15）。
- runbook:27 写「首跑 **19 HIT / 3 SKIP / 0 MISS**」；按 §2.1 应为 **18 HIT / 3 SKIP / 5 MISS**（18 = 23 条 hash 里 15 HIT + 3 条 marker 未计；若把 3 条 marker 也算 HIT 则 21/3/5 也不会是 19/3/0 的形态）。

### 6.3 `AGENTS.md` 自身的过期条目（供父会话收口）

- **Testing & QA** 的「Validate compatible third-party versions（2026-09-04 实装）」整段：见 §1 表，6 项里 4 项过期。
- **Pitfalls** 三条 dshmarket 条目全部失去前提——「已安装列表的 outer-row 选择器必须排除嵌套 action 容器」「市场头部『文字变竖排』的触发器是待更新按钮」「dshmarket ≥1.20 手机端隐藏设置 nav 造成死路」。它们的**因果分析仍然正确**，但指向的包已不在 profile 里。
- `docs/maintenance/pitfalls.md:37`（iOS zoom 长条）里把 `-NprXq_searchInput` 说成「真正可见的 <16px 域是第三方 13px 搜索框」——该前缀全盘 0 命中，这句话的**取证对象已经不在**（结论「16px 下限盖住第三方搜索框」的操作价值不变，因为下限是通配规则而非按类名匹配）。
- 本地（gitignore）`docs/debug/settings-market-debug-map.md`：:7 基线「`@linxin666/dsh-web-ui-all` 0.1.16 · `dshmarket` 1.20.2 · 2026-08-23」整段过期，:39-47 的 `eGUBIq_` DOM 树、:65 哈希表、:79-82 干预点索引全部对不上 0.3.20。另 :79 用了本仓库**已禁用**的写法 `[class$="_titleRow"]`（AGENTS.md 规定哈希类一律子串匹配）——**照它排错会把排错人引到错误技术**。

---

## 7. 自检：我可能错在哪

1. **语料 ≠ 活页面**：我用「宿主 client bundle + dist assets + profile 全部 js/css」代替活 DOM 扫描。语料 ABSENT ⇒ 活页面必 miss（这条是硬的）；但语料 HIT **不保证**活页面 HIT。§2.1 的 15 条 HIT 里，`Kwoi6G_`/`Jh0q7G_`/`rUBhvW_` 属 disabled family，我用「聚合包模块顶层注入」论证了会注入——**该论证基于静态读源码，没有实跑**。若父会话能跑一次 `node scripts/cdp-compat-contracts.mjs`，真实 `hit/skip/miss` 三元组可以直接推翻或确认我的整张表。
2. **我不能起浏览器**，所以 marker 三兄弟（`data-sidebar-right-panel` / `data-composer-input` / `data-conversation-composer-overlay`）只验到「属性名仍由对应包产出」，**没验到「特定状态下面板真渲染」**。§2.3 已标注。
3. **`dshmarket` 的判定依赖「profile」这一层**：全局 `node_modules/dshmarket` 是悬空链接、profile 依赖里没有、boot entries 里没有——三条独立证据一致。但**别的机器/别的 profile 可能仍装着 dshmarket**，此时 §4.1 的规则可能仍然有效。我给的结论限定在**本机 web profile**。
4. **`_footerActions` → user-questions 的误伤是「推」**：我没能确定用户提问模态是否渲染在 `[data-mobile-nav="frame"]` 子树内（宿主 bundle 里 `createPortal`/`document.body` 都 grep 不到，可能被压缩改名）。已标「未定性」。
5. **`_card:has()` 嵌套双倍 padding 也是「推」**：我没有活 DOM 可查 `_card` 的实际嵌套深度。92 族只是「可能」的基数，不等于实际嵌套。
6. **`-NprXq_` 的「过期」结论有一个弱化版**：它是 lazy 契约，且 `scripts/` 里没有任何脚本消费它（只有两份文档提到）——所以它的失效**没有功能后果**，只是文档噪音。我把它列进 §2.1 是按其契约语义如实记账，不是声称有 bug。
7. **行号**：CONTEXT 的冻结指纹在我开工前就已被父会话打破（compat −2 行、layout 注释改动）。本报告所有规则引用都带**选择器原文**做内容锚，若父会话继续改文件，请按选择器串重新定位，不要按我写的行号。
8. **`kKk9aW_`/`VadyJG_`/`eDzMgW_` 等「候选新卡头」是我推的**——它们来自 `dsh-web-all` 聚合包的前缀统计，我**没有**确认哪几个对应 AGENTS.md 说的「dsh-web-ui-all 五张分组卡」。
