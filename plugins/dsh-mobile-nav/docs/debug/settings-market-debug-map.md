# 设置 / 插件市场 调试地图（Settings & Market Debug Map）

> 目的：把设置区与插件市场的组件层级、入口链路、CSS 归属和取证手法固化下来。
> 下次再遇到这一块的布局/弹层异常，**先读本文档定位归属，再用 §5 探针取证**，
> 不要重新一层层摸索。

实测基线（2026-09-19 复核，两环境分立）：
- **真机基线（DSHA）**：裸宿主 + dsh-web-mobile，无任何第三方 web 插件 → 设置 nav **4 项**（通用设置/模型/插件/Agent 预设），无"Web 插件" tab。
- **本机 profile 基线**：裸宿主 + dsh-web-mobile + seshat + `web-ui-git-graph`（唯一启用的 @linxin666 行，注入 HfjcPG_/ZsMDKq_ 等 25 个 style，与设置区无关）→ nav **5 项**（多一个"Web 插件" tab = dsh-web-all 注入的 plugin-manager UI）。
- **判据是 `cordis.patch.yml` 的行启用状态，不是 node_modules**：`@linxin666/dsh-web-all` 0.3.20 等包虽在树里，但 25+ 行全部 `disabled: true`（market/usage-stats/genui/task-board/pet/ssh/skin-center…），"包在 ≠ 行启用 ≠ DOM 在场"。
- `@linxin666/dsh-client-ui-market` 0.3.20 在包树但无启用行；市场 UI 全环境 0 渲染（§2 市场节为历史快照）。

> [!warning] 2026-09-19 复核结论（读本文档前先看这段）
> 2026-09-16 复核已修正三条哈希归属（`VOzbGW_`=官方 settings-general、`hHd-Xa_`=官方 sidebar、`pI_x6G_`=官方 layout，均在宿主安装树 `@deepseek-ai/dsh/node_modules` 实证）；本节 2026-09-19 复核新增/变更：
> 1. **设置 nav 5 项**（通用设置/模型/插件/Agent 预设/Web 插件）：官方原生拆出「插件」（`dsh-client-ui-settings-plugins`，配置卡 `YyYd_a_`）+「Web 插件」（dsh-web-all 的 plugin-manager 注入，`HfjcPG_`）；真机无 dsh-web-all 时只有 4 项。dshmarket slot 注入路径作废，`hasMarketEntry=false`。
> 2. **`eGUBIq_`/`irow`/`_opPanel`/`_searchInline` 两棵包树 + 活 DOM 全 0 命中**——§2 市场子树、§4 市场行、§6 dshmarket 反制全部转为历史快照（章节内已标注）。
> 3. **`w1urq`/`cfgyt`/`1nxmc` 归属官方 `dsh-web-frontend/dist/assets/*.css`**（不在任何 client-ui 包）——宿主 dialog 家族（workspace 重命名对话框、确认卡 footer、语言菜单 item）。
> 4. **`_7D6uKa_` 归属 task-board 包**（行 disabled）→ 真机与本机都无此入口。
> 5. **§3 表已与 warning 同步**（09-16 时表体仍是旧归属，现已修）。
> 6. **AGENTS.md「第三方版本对账清单」同步失真**：usage-stats/genui/dsh-meme 均为装而未启用（dsh-meme 0.1.39 在树但 patch.yml 无行）；genui 的 @omdsh-dev 目录与 @changfenhuang 包逐字节相同（迁移副车，行仍指 @changfenhuang）。

> [!warning] 2026-09-25 复测（宿主 0.1.7-rc.1，读本文档前先看这段）
> 1. **设置 nav 4 项**（General/Models/Built-in plugins/Agent presets）：`web-ui-git-graph` 行 `disabled: true` 后「Web 插件」tab 消失（判据不变：`cordis.patch.yml` 行启用状态）。
> 2. **FAB 只在 hero 相态存在**；active 相态开抽屉走 header `[data-mobile-nav="toggle"]`——§1 旧点击流按相态分叉。
> 3. **设置面板新增 `VOzbGW_mask`**；panel 自身即 `[role=dialog][aria-modal=true]`——插件模态让位规则直接命中设置对话框。
> 4. **三组哈希换代**：`w1urq_`→`11bjj_`（bundle 判定，live 未复现宿主模态）、`1nxmc_`→`1t7on_`、`YyYd_a_`→`pbvGtq_`；**`oY77xG_`/`hVGvvW_`/`T1PP_` 0.1.7 复活**、与 `Pt1bsG_` 混用（`lats3W_` 仍 0）。
> 5. 增量详情见文末 §8；插件侧规则面变化（#101/#105/#111/eaf74e4）同见 §8。

> [!warning] 2026-09-25 复测二（宿主 0.1.7-rc.2，PR #116 合并后，读本文档前先看这段）
> **设置弹窗 rc.2 起 `createPortal(..., document.body)`**——§8「无 portal、就地渲染于 settingsArea」的挂载链实锤只对 rc.1 成立。插件全部 `[data-mobile-nav="frame"]` 作用域的对话框规则在 rc.2+ 上**静默失效**（选择器合法但零命中）。规则面已按 PR #116 全部换锚，详见 §9。


---

## 1. 入口链路（点击流，2026-09-19 实测）

| 断点 | 路径 |
|---|---|
| 桌面 ≥1024px | 侧栏底部 **Settings** 按钮 → `VOzbGW_panel` 800×800 居中对话框 |
| 移动 <1024px | FAB（`[data-mobile-nav="fab"]`）→ 抽屉 → footer **Settings**（`hHd-Xa_settingsArea`）→ 同一对话框变底部 sheet |

**设置 nav（`VOzbGW_navCell`×4，2026-09-25 复测）**：通用设置 / 模型 / Built-in plugins（内置插件）/ Agent 预设——「Web 插件」tab 消失。
（2026-09-19 记的 5 项系当时 web-all 行启用所致；现 `web-ui-git-graph` 行 `disabled: true` 后回落 4 项，判据不变：`cordis.patch.yml` 行启用状态。）
「插件」= 官方 `dsh-client-ui-settings-plugins`（配置卡 `YyYd_a_card`，0.1.7 换代 `pbvGtq_`，见 §3）；「Web 插件」= @linxin666/dsh-web-all 的 plugin-manager 注入（`HfjcPG_section`，文案「统一管理 dsh-web 全家桶插件的启用与配置」）——行启用时才出现，当前两环境均无。
历史入口（已失效，勿按此走）：dshmarket 经 `settings.section` slot 注入「Plugin Market」按钮 → 市场页内联渲染在设置滚动区（需 dshmarket 行启用）。

其他注入点（历史）：dshmarket 还注入 `settings.plugin.item` 与 `shell.overlay`；任务看板/SSH 是侧栏入口按钮（`button[data-dsh-taskboard-entry]` / `[data-dsh-ssh-entry]`，行 disabled 时整组缺席）。

## 2. 组件层层关系（DOM 层级图，2026-09-19 实测更新）

```
body
├─ 应用根
│  └─ pI_x6G_frame                          ← 应用框架列（overflow hidden）
│     ├─ pI_x6G_sidebarCol (absolute, ov hidden)   ← 侧栏（移动端抽屉化/隐藏）
│     │  └─ hHd-Xa_root                     ← 侧栏内容
│     │     └─ hHd-Xa_footArea              ← 底部按钮区（★抽屉收起 = display:none）
│     │        └─ hHd-Xa_settingsArea       ← Settings 按钮
│     └─ 主对话列 / aionui 面板列 …
├─ VOzbGW_overlay (fixed, z-index 1000)     ← 设置对话框根（覆盖全视口）
│  └─ VOzbGW_panel (absolute, z1, ov hidden)   ← 对话框面板 / 手机 sheet
│     └─ VOzbGW_content
│        └─ VOzbGW_options                 ← ★唯一滚动容器 (overflow auto)
│           └─ 各 section 内容…
└─ div._root_w1urq_2 (fixed, z1000)        ← ★宿主 dialog portal 根（第二个；2026-09-25 复测 w1urq_ 判死→11bjj_ 家族【bundle 判定，live 未复现宿主模态】，见 §8）
   └─ [role="dialog"][aria-modal="true"]   ← workspace 重命名等宿主模态（弹层 z 只在根内排序）
```

### 关键事实（排查弹层/裁剪必读）

0. **设置面板渲染在抽屉 footer 的 `settingsArea` 内部，不是 portal**——抽屉收起 = `footArea` display:none = 面板整个 0×0 被杀。「收抽屉给设置面板让位」的修复方向必错；面板视觉上盖在抽屉上（fixed 后代不受 sidebarCol overflow 裁剪），不要凭 z 1300>1000 推断遮挡（2026-09-19 误诊实录）。
0a. **宿主 dialog portal 根是 body 直接子 `div._root_w1urq_2`（fixed z1000）**——提升 `[role=dialog]` 自身无效（内部 z 只在门户根内排序），必须提升门户根（base.css 抽屉打开态 `:has(>)` 家族已做到 1400）；我们自己的 session-delete 卡 role 挂 body 直接子上，不被 `:has(>)` 误命中。（2026-09-25 复测：`w1urq_` 判死→`11bjj_` 家族【bundle 判定，live 未复现宿主模态】；本插件 base.css 只锚形状——`body:has(...)` 结构选择器、不写哈希，故哈希之死不影响该规则，机制描述对继任家族同样适用。）
1. **市场不是独立弹层**【历史快照】——它长在设置的滚动容器里。任何"浮起来"的卡片都受
   `VOzbGW_options`(overflow auto) 的滚动与 `VOzbGW_panel`(overflow hidden) 的裁剪影响。
2. 弹层要真正脱离该容器：用 `position:fixed`。前提是祖先链上**没有 transform**
   （否则 fixed 退化为该祖先的包含块）。本链路实测无 transform，可用。
3. absolute 元素的 `left/top` 百分比锚定的是**最近 positioned 祖先**——
   例如 opPanel 的锚是 54px 小按钮 wrapper，`left:50%` 会锚错对象。
4. 设置 nav 列表在移动端由 compat.css 改为单行横滚（现为 `VOzbGW_navCell` 结构）。

## 3. CSS module 哈希前缀对照表（升级对账用，2026-09-19 修正+补全）

归属均在宿主安装树 `@deepseek-ai/dsh/node_modules` 实证（只搜 profile 树会假 0 命中）：

| 前缀 | 归属 | 出现位置 |
|---|---|---|
| `VOzbGW_` | **官方** dsh-client-ui-settings-general | overlay / panel / content / options / navCell / navIcon / navLabel / close |
| `Pt1bsG_`（row/title/description）· `yIbyla_`（row 变体）· `_WvWnq_`（section）· `me01iq_`（action/error）· `DOUpOa_`（badge/icon/indicator/spinner/errorDot）· `UQsH_q_`（triggerLabel） | 官方 settings-general | 通用设置 tab 行组件。**2026-09-24 对账换代**：旧 `oY77xG_/hVGvvW_/bVCLcG_/lats3W_/T1PP_q_` 已随宿主升级消失；行已重设计为紧凑 space-between 行（`.Pt1bsG_row{justify-content:space-between;align-items:center;padding:16px 0;border-bottom:.5px}`），compat 的「文字上/控件下」竖堆规则族因此整体删除（compat.css.ts 墓碑注释）。`VOzbGW_` 前缀未变（overlay/panel/options/navList/navCell 等全数存活，compat nav 规则锚点仍有效）。**2026-09-25 复测更正**：oY77xG_/hVGvvW_/T1PP_ 实未消失——0.1.7 复活与 Pt1bsG_ 混用（bVCLcG_ 在场、lats3W_ 仍 0），见下行历史快照行与 §8 |
| 【历史快照】`oY77xG_` `hVGvvW_` `bVCLcG_` `lats3W_` `T1PP_q_` / `hVGvvW_selector` | 旧版 settings-general（宿主升级前） | 2026-09-19 实测的每行独立 module 与语言行 selector；**0.1.7 复测：oY77xG_/hVGvvW_/T1PP_ 复活、与 Pt1bsG_ 混用（live 各 6/5/6 token），bVCLcG_ 在场（live 11），lats3W_ 仍 0**——前四者按 §8 增补节排查，勿再按「0 命中」排除 |
| `hHd-Xa_` · `pI_x6G_` | **官方** dsh-client-ui-sidebar / -layout | sidebarCol / root / footArea / settingsArea；frame |
| `zGbnIq_` | **官方** dsh-client-ui-settings-models | Models 区 section / title / intro / rows / rowCard / rowHead / rowName / rowTag / addBlock / **editor / field / input / modelRow**；编辑器内 `DETAILS.zGbnIq_customized`（关闭态 body 幽灵渲染，见 §6） |
| `GL8Viq_` | 同包（包内存在，**当前 UI 未渲染**，归属待其对应 UI 打开再验） | — |
| `w1urq_` `cfgyt_` `1nxmc_` | **官方 dsh-web-frontend/dist**（非 client-ui） | `_root_w1urq_2` dialog portal 根；确认卡 footer（`_footer_w1urq_97`）与按钮（`_button_cfgyt_4`）；语言菜单 `_item_1nxmc`。**2026-09-25 换代**：`w1urq_`→`11bjj_` dialog 家族（`_root_11bjj_6`/`_mask_11bjj_18`/`_dialog_11bjj_26`/`_footer_11bjj_101` 等，【bundle 判定，live 未复现宿主模态】）；`1nxmc_`→primitives Menu `1t7on_`（`_itemLabel_1t7on_194`/`_viewport_1t7on_22`，session-menu 的子串锚实测仍命中；语言菜单 item 具体新锚系按 1t7on_ 菜单族推断【推断】）；`cfgyt_` 未换代（0.1.7 live Button 系 36 命中） |
| `YyYd_a_` | **官方** dsh-client-ui-settings-plugins | 「插件」tab 配置卡 card / header / headText / name / chevron。**2026-09-25 换代**：→ `pbvGtq_` Built-in plugins 卡族（cards/configurable/empty/heading/intro/panel/presetSettings/section/tab/tabs，0.1.7 live 在场） |
| `Kwoi6G_` `bpnj3G_` `Jh0q7G_` `jmhvDG_` `rUBhvW_` | @linxin666/dsh-web-all（remote-web-ui 分组卡） | 「Web 插件」tab 分组卡头（真机缺席） |
| `HfjcPG_` `ZsMDKq_` | @linxin666/dsh-web-all（git-graph 行带 25 style） | 「Web 插件」tab 说明区；与设置区无冲突 |
| `cubgiG_` | **官方** dsh-client-ui-agent-preset | [role="menu"]（见 AGENTS.md Pitfalls） |
| `eGUBIq_` / `_7D6uKa_` / `_button_kz6gm_` | 历史快照 | eGUBIq_（dshmarket）两树 0 命中；_7D6uKa_（task-board 包）行 disabled；kz6gm_ 两树 0 命中 |

## 4. 我们的干预点（compat 层索引）

均在 `src/client/styles/compat.css.ts` 的 `@media (max-width:1023px)` 块内，带 `!important`。**【历史快照】标 = 目标哈希当前全环境 0 渲染（行 disabled），规则仍在但无处命中，勿据其排查**：

| 规则目标 | 选择器要点 | 解决的问题 |
|---|---|---|
| 【历史快照】市场 tabs 行 | `[aria-modal="true"] [class*="_tabs"]` wrap + `_searchInline` 全宽（**子串**，`compat.css.ts:255`） | 搜索框溢出右缘 |
| 【历史快照】标题行 | `[data-mobile-nav="frame"] [aria-modal="true"] [class*="_titleRow"]` wrap；`_title` 单行 ellipsis；行内 button nowrap（**带 frame 域 + 子串**，`:304/:308/:315`）——**rc.2 起该 frame 形态已死，换锚 `[data-dsh-market-root]` 且 `_title` 改 `flex: 0 1 auto`，见 §9** | **待更新按钮出现时**(~450px 自然宽)把文字压成逐词竖排 |
| 【历史快照】Tasks 弹卡 | `[class*="_opPanel"]` → position:fixed + translate(-50%,-50%) | 上游右对齐下拉贴边、不居中 |
| 【历史快照】设置 nav 恢复（dshmarket ≥1.20） | `@media(max-width:560px)` 内镜像上游条件：`[role=dialog]:has([data-dsh-market-root]) > nav { display:flex !important }`（frame 域限定）——**rc.2 起增补 portal 感知孪生规则（无 frame 前缀），frame 形态保留作测试守护，见 §9** | 1.20.x 起 ≤560px 上游藏宿主 nav 让市场接管整屏，但本宿主唯一叉号在该 nav 里 → 分类+叉号全消失、无路可退 |
| 【历史快照】已安装列表 | index.tsx 内联 effect：`[class*="irow"]:not(irowActions):not(irowTrailing)` | 行文本挤压（注意排除嵌套 action 容器） |
| 【历史快照】Models 卡片列表 | 设置行三连 `[class*="_section"] [class*="_row"]` 加 `:not(_rows/_rowCard/_rowHead/_rowIdentity/_rowActions)` 复合族守卫（2026-08-24） | PR#27 `$=`→`*=` 复活过匹配：UL 命中使首尾卡 width:100%，官方 content-box(+14px padding+1px border) 变 372px vs 兄弟 342px 并超出 390 视口；守卫后四卡等宽、按钮回自然宽。**2026-09-24 #111：竖堆四连（flex-direction:column + gap:8 + 首尾子 width:100% + 开关钉宽）已整删**，墓碑注释在 compat.css.ts 原位（宿主行已重设计为紧凑 space-between）；复发须按代际门控重引入，不许 blanket `[class*="_row"]` 覆盖 |
| 设置工具栏三连 | **2026-09-24 #105 A′ 改纯 CSS 重锚定**：`[aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"]))`（navList 复刻 nowrap 横滚条 + `margin-right:42px` 让位）；reparent 任务已删（settings-toolbar-reparent.ts 32 行删除）——**rc.2 起 #116 大改：navList nowrap+overflow-x 移入本锚（compat frame 版墓碑）、工具栏 z-index:10 + 盒高 32px、✕ 热区 ::after 扩 6px（不向下）、移动端隐藏 `_actions`，见 §9** | 旧裸 `[class*="_header"]` 命中内容区插件卡头：标题右对齐、官方 padding/gap 被清空、箭头套 32px 灰圆底。0.1.7 复测：结构锚两断点唯一命中 `VOzbGW_panel`（panel>nav:first-child>navList:last-child>button 链成立；`<nav>` 隐式 role 不带属性、不触发排除） |
| ghost details 隐藏 | `details[class*="_customized"]:not([open]) > [class*="_customizedBody"] { display:none }`（2026-09-19） | 引擎把关闭态 details 的 body（模型目录 ~1500px）照常渲染成幽灵层，盖住编辑器动作行与其前的提供商行（命中被劫持）——「无法删除提供商/获取模型无反应/Cancel 关不掉」同根因；宿主布局按关闭态正确计算，解压方向全无效，open=true 立即恢复 |
| dialog footer 按钮不折行 | `[aria-modal] [class*="_footer"]` flex-wrap + 内 `button[class*="_button"]` nowrap（2026-09-19） | 36px 单行按钮 white-space:normal 在窄视口/长名/fontScale~1.3 下标签折行裁字（工作区重命名对话框同族受益） |

## 5. 无头取证 SOP（CDP 探针）

Termux 前提：playwright-core 在 android 直接抛 `Unsupported platform`——**用原生 CDP**。

1. **起浏览器**：spawn 系统 chromium：
   `chromium-browser --headless=new --no-sandbox --disable-dev-shm-usage --remote-debugging-port=<port> --user-data-dir=<临时目录>`；
   env 必给可写 `TMPDIR` 与 `XDG_RUNTIME_DIR`（否则 ProcessSingleton 失败、CDP 端口永不上线）。
2. **连接**：fetch `http://127.0.0.1:<port>/json` 取 `webSocketDebuggerUrl` → 原生 WebSocket；
   CDP 客户端可直接抄 `scripts/cdp-probe.mjs` 的 createCdpClient（send/evaluate/on）。
3. **会话与视口**：导航前用 `Page.addScriptToEvaluateOnNewDocument` 写
   `localStorage["dsh.sessions.current"] = JSON.stringify({sessionId})`；
   `Emulation.setDeviceMetricsOverride {width:390,height:844,deviceScaleFactor:2,mobile:true}`。
4. **走点击流**：对元素直接 `.click()`（React 合成事件即可响应），每步 sleep 0.9–3.5s 等动画/加载：
   FAB → Settings →（nav：通用设置/模型/插件/Agent 预设[/Web 插件]）→（目标交互）。
5. **取证四板斧**（全部 Runtime.evaluate + returnByValue）：
   - **几何测量**：getBoundingClientRect + computed style（position/overflow/z-index/transform/flex/whiteSpace）
   - **祖先链审计**：从目标沿 parentElement 向上收集 pos/ov/z/transform/rect —— 裁剪与包含块问题一眼现形
   - **命中栈**：`document.elementsFromPoint(cx,cy)` —— 判断谁挡谁
   - **快照 diff**：点击前后对全量元素做签名 (tag|cls|rect|text) 集合，差集即新弹出节点
6. **构建验证闭环**（受限 shell 里 env node shebang 跑不通，须显式 node 调 tsc 与打包器）：
   `node node_modules/typescript/bin/tsc -p tsconfig.json` → 同理 client → `node scripts/build-client.mjs`；
   服务端 no-cache 读 lib，页面刷新经 `?rev=sha1前12位` 自动拿新 bundle。

## 6. 本区已知坑速查（全文见 AGENTS.md Pitfalls）

- 文字时横时竖 = 标题行被待更新按钮压爆（已修，§4 标题行）
- 弹卡贴边不居中 = opPanel 上游 absolute 右对齐（已修 fixed 居中）
- 打开市场后分类+叉号全消失 = dshmarket ≥1.20 在 ≤560px 隐藏 `[role=dialog]:has([data-dsh-market-root]) > nav`，其注释假设的「content header 关闭按钮」在本宿主不存在；compat 已镜像条件反制（§4）。此类「谁藏了它」问题：活页面遍历 `document.styleSheets`（递归 media 规则）找命中目标且带 display:none 的规则即可定位注入 style 标签
- `[class*="irow"]` 宽泛匹配会误伤已安装列表的 action 容器
- 设置 nav「不换行、cell 排到 x≈1400」不是失效：单行横滑就是设计（commit 1185f2e，2026-08-16 用户反馈——13 个分类 wrap 要占三行 ~130px；2px 细滚动条即滑动可供性）。~~layout 的 wrap 规则仍命中但被 compat `flex-wrap:nowrap !important` 有意覆盖~~**2026-09-25 rc.2 起机制简化：compat 的 frame 域 nowrap 三连已墓碑，layout 结构锚自身就是 `nowrap !important + overflow-x:auto`（#116），不再有跨文件覆盖关系**；排查时别再误判（2026-08-25 实锤：锚点链 full match，modal 无 [role=navigation] 属性——`<nav>` 的隐式 ARIA role 不产生该属性，属性选择器匹配不受影响）。
- **插件卡头被工具栏规则波及（右对齐/清 padding/箭头灰圆底）**＝ layout.css 工具栏三连用了裸 `[class*="_header"]`；2026-09-05 全节扫描实锤 8 个卡头（YyYd_a_header×3 + Kwoi6G/bpnj3G/Jh0q7G/jmhvDG/rUBhvW_header×5）中招，已改结构锚定（§4）。新装插件卡再现同类症状先查这条规则；回归探针 `.local-tests/plugin-card-header-bleed.mjs`（10 断言）
- **设置分类顶部灰色椭圆**（2026-08-25 实锤）：layout.css 的 `[class*="_header"]:not([class*="_headerActions"])` 工具栏复合规则命中 @linxin666 插件设置卡头 `*_headerStatic`（pet/community-plugins/skin-center/live-stats 共享 PluginSettingsCard 模板）——「关闭按钮圆形底座」的 50% 圆角+灰底落在全宽 `_headText` span（340×32）上成椭圆，容器规则还压掉上游 14px/16px 内边距。三处规则已追加 `:not([class*="_headerStatic"])`。取证手法升级：朴素逐规则 `el.matches` 扫描会因 var() 间接赋值漏报，改用**样式表二分禁用法**（每轮关一半 document.styleSheets 看 getComputedStyle 签名变化，~7 轮锁定唯一肇事表）。回归探针 `.local-tests/ellipse-regression.mjs`（断言 headText 无圆角无底色 + VOzbGW_close 32×32 圆底座保留）
- 设置 Models 区卡片宽窄不一+首尾卡出屏 = compat `_row` 子串规则过匹配 `_row*` 复合族（PR#27 复活）；同类「某区卡片宽度不一致/出屏」症状先查 `[aria-modal] _section _row` 三连规则的命中面，回归用 assert-models-layout.mjs
- 复用旧 browser context 会出「fence-only」假象——探针必须全新 context
- 视觉工具只收 workspace 内路径且依赖外部凭证（401 即失效，别硬重试）
- **宿主 CSS module 规则不可枚举**（2026-09-19 实测）：`_w1urq`/`_cfgyt` 族既不在 `document.styleSheets` 的 cssRules、不在 adoptedStyleSheets（count 0）、也不在任何 style 标签文本里——matches() 扫描与字符串扫描全 0 命中但 computed 生效；只有 CDP `CSS.getMatchedStylesForNode` 能拿全匹配链
- **样式表二分禁用法的边界**（2026-09-19）：它只对 author CSS 生效——ghost details（§4）不是 CSS 覆盖而是引擎渲染缺陷，禁用所有 sheet 也不消失，别在这类问题上烧轮次
- **cookie 过期取证**（2026-09-19）：页面 401「authentication required」= cookie TTL 到期（约 1 天）或服务重启；不需重启 dsh web——若 9229 inspector 在，heap 快照抓 `dsh-auth-<后缀>|v1.<串>` 配对（正则配对抓，单独 64 位串拼不出 cookie），选 authority=3080 且 issuedAt 最新的，写 `~/tmp/dsh-cookie-3080.txt` 后 addCookies 重导航即可

## 7. 对账清单（什么时候回来更新这份文档）

- **`cordis.patch.yml` 行启用状态变更**（启用/禁用任何 web-ui 行）→ 活 DOM 全变，重跑 §5 点击流刷新 §1-§3——这是第一判据，优先级高于包升级
- @linxin666 包升级后 → 重跑 §5 点击流，核对 §2 层级与 §3 哈希前缀
- 新增第三方弹层兼容时 → 把规则登记进 §4，把新哈希登记进 §3
- 发现新的状态型触发器（类似"待更新按钮"这种）→ 补进 §6 并同步 AGENTS.md Pitfalls
- auth 401 → 按 §6 cookie 条目换 token，别先怀疑页面/构建

## 8. 0.1.7-rc.1 增补（2026-09-25 复测）

**基线**：宿主 0.1.7-rc.1；2026-09-25 源码对账（scout）+ live DOM 双通道（checker）复测。报告：`docs/handover/2026-09-25-debugmap-recon-code-scout.md` / `-code-checker.md`。本节只记增量；§1-§7 除上文就地标注各点外保留有效。

**入口流修正【live】**：FAB（`data-mobile-nav="fab"`）= hero 相态限定；active 相态开抽屉走 header `[data-mobile-nav="toggle"]`。桌面入口 = 侧栏 footer `VOzbGW_triggerRow > VOzbGW_trigger`（0.1.7 起触发器带新键 triggerRow/trigger，两断点在场）。

**面板结构升级【live，挂载链实证】**：`VOzbGW_overlay` > `VOzbGW_mask`（新，absolute inset0）+ `VOzbGW_panel[role=dialog][aria-modal=true]`——设置对话框自身就是 aria-modal dialog，模态让位规则直接命中。`VOzbGW_` 新键 live 分布：mask/navTitle/trigger/triggerRow 在场；rail/railRow/triggerLabel bundle 有、当前形态未渲染。唯一滚动容器仍 = `VOzbGW_options`。

**portal 根现状【live】**：设置打开态 body 直接子 fixed z≥900 = 0（无 portal）——「就地渲染于 settingsArea」（§2 关键事实 0）由推断升级为挂载链实锤。**【rc.2 起失效】0.1.7-rc.2 改 `createPortal(..., document.body)`，设置弹窗成为 body 直接子——本条只对 rc.1 成立，见 §9**。`_root_w1urq_2` 与继任 `11bjj_` 全程 0 命中（只有真宿主模态才挂 body，本次未复现）。`_overlay` 子串另有两个常驻命中别误认：`uV2eYG_overlayAnchor`（composer）、`pI_x6G_overlayLayer`（shell）。

**0.1.7 新族速览【live 计数 + scout 归属】**：

| 前缀 | live token 数 | 归属/位置 |
|---|---|---|
| `rtSEdW_` | 63 | Agent presets tab |
| `qSYn7G_` | 20 | Built-in plugins tab |
| `brmue_` | 5 | Agent presets tab |
| `1vyxu_` | 4 | General + Agent presets |
| `bOPqQW_` | — | composer stats pills（`[data-composer-stats]`） |
| `iWlSmW_` | — | 权限菜单 trigger（composer permission 槽） |
| `_7KE1Ra_` | — | 模型选择器（`conversation.input.model` 槽） |

后三行属 composer 侧（详见 composer-tree-recon.md §9），列此备查。

**插件侧规则面（2026-09-19 以来）【git log 实证】**：
- #101：模型 chip padding/gap 归零改 ≤767 分档（768–1023 平板档回宿主间距）。
- #105 A′：两个 reparent 任务（git-chip / settings-toolbar）删除，改纯 CSS 重锚定（§4 工具栏行，live 实测两断点唯一命中 VOzbGW_panel）。
- #111：设置行竖堆四连整删（§4 Models 行，墓碑注释在 compat.css.ts 原位）。
- eaf74e4：会话删除 0.1.7 bring-up——磨砂确认卡 + 菜单三元组判别（accommodating 置顶为第四项）。

**QA 配方变更【live】**（同 composer-tree-recon.md §9）：①会话种子必须全量 `dsh.*` localStorage 快照（只写 `dsh.sessions.current` 单键 0.1.7 落 hero 不恢复会话）；②`mint-cookie.mjs` 已禁用，改 token URL（GET / 303 换 HttpOnly cookie）。

**证据路径**：原始数据 `~/tmp/doc-recon-20260925/`（settings-desktop.json / settings-mobile.json / settings-desktop-supplement.json / beacon-listener.cjs + raw.jsonl / capture-scripts.md）。

## 9. 0.1.7-rc.2 增补（2026-09-25，PR #116 合并后）

**根因（上游包逐字节 diff 实证，贡献者 @BuvkB）**：`dsh-client-ui-settings-general` rc.1 **原地渲染**设置弹窗（bundle 内无 `createPortal`），rc.2 改 **`createPortal(..., document.body)`** → overlay 成 body 直接子，插件全部 `[data-mobile-nav="frame"]` 作用域对话框规则一次性失效。活体症状：设置 nav 3/2/3/2/1 换行且首行滑进 138px 工具栏底下、市场 ✕ 看得见点不着（`nUhMVa_root` 后画且 z:auto 盖住工具栏）、byline「· ★ 8k」孤行、页面零距离贴顶。取证前后对照图：`docs/audits/2026-09-25-rc2-portal-regression/`（4 张）。

**插件规则面变化（全部仍在移动 media 包裹内，桌面零影响）**：

| 规则 | rc.1 形态 | rc.2 起现役形态 |
|---|---|---|
| 市场 opPanel / titleRow | frame 域（compat） | compat 原位**换锚 `[data-dsh-market-root]`**；`_title` flex `1 1 auto` → **`0 1 auto`**（版本号回归标题左侧，不再被顶到 ✕ 角致误触） |
| 市场 byline / 顶距 | —（上游自流） | **byline 钉单行**（nowrap，owner 项 `flex:0 1 auto`+ellipsis 吸收挤压）+ **≤360px 紧凑档**（10px 字 / 4px gap）+ **页顶 12px 留白**（与自身左右 padding 一致；工具栏/✕ 不动） |
| 设置 nav 单行横滚 | compat frame 域三连（滚动条+紧凑 cell+藏 actions） | compat 三连 **tombstone（原位墓碑注释，勿按 frame 选择器复活）**；接管者 = layout.css 结构锚同族：`flex-wrap:nowrap !important + overflow-x:auto` + 细滚条 + 紧凑 cell，宿主代际无关 |
| 设置工具栏 | `margin-right:42px` 让位（#105 A′） | **`z-index:10`**（盖市场根与 stickyHead z:5，仍低于 opPanel z:40 / lightbox z:10000）+ 盒高 54→**32px**（下半空区曾吃「导出日志」右上角形成死区）+ **✕ 热区 `::after` 上/左/右各扩 6px（绝不向下**——13px 下就是导出按钮）+ 移动端**隐藏 `_actions`**（「打开配置文件」；✕ 是 actions 的**兄弟**节点，关闭路径不受牵连） |
| dshmarket ≥1.20 nav-hide 反制 | frame 域单规则 | frame 规则**保留**（测试守护 `tests/market-gallery-style.test.ts:26`）+ **portal 感知孪生**（`[role=dialog]:has([data-dsh-market-root]) > nav`，无 frame 前缀；rc.1 上与 frame 规则同声明双命中、无行为差；rc.2+ 由孪生接管） |

**排查提示（本区通用）**：先判宿主代际（rc.1 vs rc.2+）再按表选锚。frame 域规则在 rc.2+ 失效的形态是**静默的**——选择器合法、styleSheets 里规则在场、就是不命中目标（被 portal 摘出 frame 子树）。「规则在场却不生效」类症状，先查目标还在不在 `[data-mobile-nav="frame"]` 子树里，再查谁藏了它（§6 手法）。
