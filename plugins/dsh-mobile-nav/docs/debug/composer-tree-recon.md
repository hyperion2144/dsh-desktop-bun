# composer DOM 树 recon（2026-09-17，手机 + 桌面双场景）

> 交接文档：给接手 agent 的初查结果、原始数据位置、复现命令与未解问题。
> 所有数字都是 headless CDP 实测，不是推断；口径见 §7。本文档属 `docs/debug/`（2026-09-25 起按店主指示随仓库入库）。
>
> **2026-09-17 收口（接手 agent）**：§5 的 7 条全部给出结论（§5 保留原问 + 结论），§4.3 的「未布局副本」状态签名已实测锁定为一个可判别的状态（§8.2），标记族归属做了活体 + bundle 双向对账（§8.1），并据此删掉了锚点里的死回退分支。仍未亲手复现的是 fence-only 状态本身（只复现了它的形状），抓现场的工具见 §6。
>
> **2026-09-25 增补（0.1.7-rc.1）**：0.1.7-rc.1 复测主链哈希全活、§3/§4/§8.4 机制结论保留有效；上下文圈已迁 dock 行、卡根语义分相态、计数常数作废——详见 §9。

## 1. 一句话摘要

真身上只有**一个** composer（`uV2eYG_card`，带宿主自己的 `[data-composer-card]` 标记），链条完整、全部已布局。
探针一度「看到的隐藏副本」不是 composer 复制品，而是**两个宽松选择器撞到了会话流里的其他元素**：
`[class*="_card"]` 撞上 13 张 bash 工具卡，`[class*="_root"]:has(> [class*="_trigger"][aria-haspopup="dialog"])` 撞上轮尾动作栏的 dialog 按钮。
真正需要防的是第三件事：**未布局副本的 computed 尺寸与布局副本完全一样**（rect 却全 0），任何只用 computed 的几何断言都会假绿。

## 2. 实测环境

- 宿主 DSH 0.1.5-rc.1，`http://127.0.0.1:3080/`
- 手机场景 390×844 dpr2 + `Emulation.setTouchEmulationEnabled{enabled:true,maxTouchPoints:5}`（不加这一步 `(pointer: coarse)` 不成立，移动分支完全惰性）；桌面场景 1280×720 dpr1、触摸关闭
- 会话 `session-728385cb-372e-43dd-a14b-010d806bbcf1`（有上下文压力投影，圈才会渲染）
- 页面需要鉴权 cookie（`.local-tests/mint-cookie.mjs` 铸），会话 id 经 `addScriptToEvaluateOnNewDocument` 写 `localStorage['dsh.sessions.current']`

## 3. 真身链条（手机 390×844 / 桌面 1280×720）

| 层级 | 选择器 | 手机 rect | 桌面 rect | 稳定性 |
|---|---|---|---|---|
| app 根 | `[data-phase="active"]` `wSkVaW_root` | 0,0,390,844 | 0,0,1280,720 | `data-phase` 稳定，类哈希 |
| 会话滚动体 | `wSkVaW_scrollBody` | 0,77,388,767 | — | 哈希 |
| composer 座位 | `wSkVaW_composerSeat` | 0,713.5,388,130 | — | 哈希 |
| composer 栈 | `wSkVaW_composerStack` | 0,713.5,388,130 | — | 哈希 |
| **composer 卡** | `uV2eYG_card`，**有 `[data-composer-card]`** | 16,713.5,356,98 | 419,591.5,712,98 | 标记稳定（count=1） |
| 滚动 / 生长 | `uV2eYG_scroll` / `uV2eYG_grow` | 24,721.5,336,36 / 32,721.5,320,36 | 同左（x 偏移） | 哈希 |
| 编辑面 | `uV2eYG_input`，带 `[data-composer-input]` | 32,721.5,320,36 | 419,599.5,708,36 | 标记稳定（count=1） |
| 占位符 | `uV2eYG_placeholder` | 46,725.5,298,24 | 433,603.5,686,24 | 哈希 |
| 底行 | `uV2eYG_row` | 24,769.5,340,42 | 419,647.5,712,42 | 哈希 |
| 工具道 | `uV2eYG_tools` | 30,774.5,112,28 | 427,652.5,198.2,28 | 哈希 |
| 尾随道 | `uV2eYG_trailing` | 148,771.5,210,34 | 844.7,649.5,278.3,34 | 哈希 |
| 上下文圈 | `JObwrW_root`（`_trigger` + `svg` 环） | 290,771.5,**28×34**（插件规则） | 1049,652.5,**28×28**（官方） | 哈希 |
| 主键（发送/停止） | `uV2eYG_primary` | 324,769.5,34,34 | 1089,647.5,34,34 | 哈希 |

计数（两场景一致）：`[data-composer-card]`=1、`[class*="_card"]`=**14**、`[class*="_trailing"]`=1、`[data-composer-input]`=1、`textarea`=**0**（这一代是 Lexical contenteditable）、`[class*="_primary"]`=1、满足「`_root` > `_trigger[aria-haspopup="dialog"]`」=**2**。

链条上的其他节点：`uV2eYG_overlayAnchor`（整幅宽、**高 0**）、一个 `display:none` 的 `span`、若干 `display:contents` 包装 `div`、一个隐藏的 `input[type=file]`。
`[data-phase]` 计数 2：`active` 在 app 根、**`plain` 在编辑面 `uV2eYG_input` 上**。

## 4. 撞车的两族（「隐藏副本」的来源）

### 4.1 `[class*="_card"]` 不是 composer 专属

手机实测命中 14 个 = 1 个 composer 卡 + **13 个 `CY-8Ka_card`**。
`CY-8Ka_card` 的身份：**bash 工具调用卡**——`data-sample="bash" data-variant="bash" data-state="ok|error" data-expandable`，祖先链 `ztWv_q_callRow` → `EvIC1a_flowItem[data-chat-flow-kind][data-chat-turn]`（会话流）。
它们的 y 全为负值（例如 −2062.5，在视口上方很远），`getBoundingClientRect().width > 0` 因而**仍算「已布局」**，但点不到。
后果：`[...querySelectorAll('[class*="_card"]')].find(...)` 取到哪个纯看顺序。

### 4.2 `aria-haspopup="dialog"` 不是圈专属

满足 `[class*="_root"]:has(> [class*="_trigger"][aria-haspopup="dialog"])` 的有 **2** 个：圈，以及
`span.Q51KRG_root > button.Q51KRG_trigger[aria-haspopup="dialog"]`，位于 `div.xzv4MW_actions.TS9iAW_actions`（**轮尾 hover 动作栏**，`TS9iAW_root[data-turn-tail="2"][data-actions-reveal="hover"]`，同级兄弟是 `button.xzv4MW_action[aria-label="Copy"]`），y = −3906.5。
手机宽 28、桌面宽 134.5。
后果：圈的选择器必须限定在 composer 卡内，否则可能选中轮尾动作按钮。

### 4.3 真正阴的坑：未布局副本的 computed 尺寸一模一样

- 观测（2026-09-17 两次探针运行，手机与桌面场景都命中）：一张 composer 卡里的 `JObwrW_trigger` computed = `28px × 34px`（说明插件规则确实命中了它），但 `getBoundingClientRect()` 的 x/y/width/height **全是 0** → 整棵子树不在布局树里。
- 之后 4 次运行（recon ×2、正式锚点探针 ×2，含 A/B）**均未复现**，卡片全部 `laidOut=true`；触发条件没抓住，属瞬态观测。
- 后果（已落进锚点）：选卡必须用 `getBoundingClientRect().width > 0` 过滤；几何断言必须配 `elementFromPoint` 命中测试，否则 computed 全绿而实际点不到。
- **收口（§8.4，2026-09-18 更正）**：这个签名是**可判别的**，只可能来自「节点仍连接、但某祖先 computed `display:none`」。对照证据：分离节点（`cloneNode` / `remove()` 后）的 computed 返回**空串**（读不到 28×34，故「探针攥着旧引用」被排除）；`content-visibility:hidden` 是**另一类不可见**——rect 与 computed 全正常（实测 356×98 不动），只是不绘制、不可命中（只有 `elementFromPoint` 抓得到）。
- **谁是那个祖先：宿主自己的链式叠加**（不是 frame、不是 fence-only）。`dsh-client-ui-renderer` 的 `renderChainResult(slotKey, elected, opts)` 把 fallback 包进 `[data-chain-overlay-fallback="<slotKey>"]`：无叠加时 `display:contents`，一旦该槽选中叠加就写**内联 `display:none`**。2026-09-18 活体实测 electee ＝ 未回答的提问卡（`Mbwy4a_frame[data-question-key="question:1"]`，`dsh-client-ui-user-questions`）→ 整棵 composer 被藏，签名与 §4.3 观测逐项吻合。**「frame 内联 display:none（fence-only）」只是形状相同的另一种隐藏，当年认错了机制**（F 态对照仍保留在 §8.2）。探针判定见 §8.4。

## 5. 未解问题（2026-09-17 收口：7 条全部给出结论）

原问编号保留，结论附取证；取证表见 §8。

1. **§4.3 的未布局 composer 卡是什么状态？**
   **已定（2026-09-18 更正）：宿主链式叠加顶掉了整棵 composer，属正常应用态、非页面假象。** 签名只可能来自「已连接 + 祖先 `display:none`」（§4.3 的对照证据），而真正当过那个祖先的是 `renderChainResult()` 给 `conversation.composer` 槽的 fallback 包装 `[data-chain-overlay-fallback="conversation.composer"]`——有叠加被选中时写内联 `display:none`（§8.4 有宿主源码与活体证据）。实测 electee ＝ **未回答的提问卡**（`Mbwy4a_frame[data-question-key="question:1"]`，`dsh-client-ui-user-questions`，卡头「执行方式」）；那段时间连续 4 次全新 profile 全部命中，提问被答掉后同参数再跑即恢复已布局。
   **复现率**：早期 8 次全新 profile 连跑（recon 原流程含清 DOM ×3、真会话 ×2、hero、不存在的会话 id、桌面 1280×720；各 10 s、自 document_start 起 100 ms 变化驱动采样）**一次未复现**——当时那个会话没有待答提问。应用真实过渡是「无卡 → hero 卡已布局 356×108 → `active` 卡已布局 356×98」，期间卡片从不离布局树（`settling` 相位只把 composer seat 置 `visibility:hidden`，不归零 rect）→ 排除「hero→session 空档」这个怀疑方向。
   **封堵**：`rect.width > 0` 过滤 + `elementFromPoint` 命中测试 + 标记缺席时 `0.composer-present` 大声红；A/B 表（§8.2）证明该口径非空转——状态 B/F 下新口径给 0 张可用卡，而旧的 computed-only 写法同一时刻仍报 `28×34`（假绿）。**新增门（§8.4）**：识别出叠加状态时走 SKIP 并点名 elected 节点，不当红也不静默跳过。
   **认错的机制**：把祖先归给「frame 内联 `display:none`（fence-only）」只复现了形状（F 态对照仍在 §8.2），不是 §4.3 观测的来源；现场脚本（§6）记录的 `frameInlineDisplay` 在真正的故障期一直是 `(none)`-free 的 `grid`。
2. **`Q51KRG_*` 点开的是什么对话框？与圈的面板互斥吗？**
   **身份已定，互斥性未测。** `Q51KRG_*` ＝ `dsh-client-ui-chat` 的 `TurnUsagePanel`（每轮用量面板，挂在轮尾 hover 动作栏 `TS9iAW_root[data-turn-tail][data-actions-reveal="hover"]` 内，同级是 Copy 等动作）。两者分属不同包、各自渲染面板；「同时打开会怎样」要一次点击实验，未做——当前无用户症状，登记为**可选**。
3. **`uV2eYG_overlayAnchor`（高 0）与那个 `display:none` 的 span？与 `data-conversation-composer-overlay` 相关吗？**
   **已定。** anchor ＝ 宿主 `conversation.input.overlay` 槽的挂载点（`{className: overlayAnchor, children: renderSlot("conversation.input.overlay")}`，CSS `height:0; position:absolute; inset:0 0 auto`）；槽里那个 `display:none` 的 `span` 是该槽的占位节点。`data-conversation-composer-overlay` **不是 anchor 发的**——由接管型视图自己声明（轨迹 tab 的 `views_module_css_default.root` 实测带该属性），宿主 CSS 反过来用 `:has(...)` 把 composerSeat 切成 absolute。插件 `takeoverActive()` 读的正是这个通用属性；轻量浮层（meme picker 等）不带它，手势照常。
4. **编辑面上的 `data-phase="plain"` 是什么语义？**
   **已定：与 app 相位同名不同物。** 它是 **composer SubmitMachine 的相位**（`"data-phase": input?.phase ?? "inert"`，值 `plain|claimed|…|inert`）；app 根（`ConversationRoot`）的 `data-phase` 才是 `hero|active|settling`。活体时间线实测两枚 `[data-phase]`：`hero@div` + `inert@div` → 会话就绪后 `active@div` + `plain@div`。→ 探针断言 app 相位必须写值（`[data-phase="active"]`），裸 `[data-phase]` 取「第一个」会随 DOM 顺序变化。**0.1.7 增补**：primitives 连接指示器新增第三处 `data-phase=connecting|recovered`（bundle 实证 `primitives/lib/index.js:4560`；live 未捕获，断连场景才出现），同页 `[data-phase]` 枚数上限再 +1——「断言必须写值」从建议升级为硬要求。
5. **桌面 `Q51KRG_root` 宽 134.5、手机 28 的响应式差异会影响移动端命中吗？**
   **已定：是宿主自己的规则，与插件无关。** `dsh-client-ui-chat` 的 `TurnUsagePanel.module.css` 自带 `@media (width<=480px){ .Q51KRG_trigger{width:28px;padding:6px} .Q51KRG_label{display:none} }`；插件不碰该族，命中盒就是官方 28×28。
6. **`[data-composer-card]` 从哪个宿主版本开始？回退分支还要留多久？**
   **已定：不用留。** 23 个已发布版本（`0.0.1-rc.1` 2026-08-10 … `0.1.6-alpha.2`）**全都有该标记**（npm tarball 阶梯 ×8 + jsdelivr 全量普查 ×20，jsdelivr 与 tarball 逐字节一致做锚）；真正按代际出现的另一个标记是 `[data-composer-input]`（`0.1.2-alpha.2` 起，Lexical 代）。→ 锚点里的 `[class*="_card"]` 回退分支本次已删除：标记缺席＝`0.composer-present` 大声红，而不是退化去量 13 张 bash 卡里的第一个。
7. **13 张 bash 工具卡都在视口上方很远 —— 值得 `content-visibility` 吗？**
   **否决（不做）。** 归属上属于宿主会话流的 React 滚动内容，插件注入 containment 会引入滚动锚定跳变、find-in-page 失效与 React 复用风险；宿主 `ui-conversation`/`ui-chat` 目前一处 `content-visibility` 都没有（grep 0 命中），而插件自己的滚动区（抽屉会话树）已经在用 `content-visibility:auto`。真出现长会话滚动卡顿，正解在宿主侧。

## 6. 复现命令

```sh
# 初查（本文档的数据源）
C=$(node .local-tests/mint-cookie.mjs)
DSH_PROBE_COOKIE="$C" DSH_PROBE_SESSION_ID=session-728385cb-372e-43dd-a14b-010d806bbcf1 \
DSH_PROBE_CHROME=/data/data/com.termux/files/usr/lib/chromium/chrome \
RECON_SCENE=phone node .local-tests/composer-tree-recon.mjs > ~/tmp/recon/phone.json
# RECON_SCENE=desktop 跑桌面场景
```

```sh
# 正式锚点（20 断言，手机 + 桌面，含 elementFromPoint 命中测试）
node scripts/probes/composer-meter-hitbox-probe.mjs
# A/B 非空转证明：旧 bundle 上 1.hitbox-28x34 与 5.hit-slip-6px-right-of-ring-is-meter 翻红
git show HEAD~1:lib/client.js > lib/client.js && node scripts/probes/composer-meter-hitbox-probe.mjs
git checkout -- lib/client.js
```

```sh
# 2026-09-17 收口新增（本地脚本，均在 .local-tests/）

# ① 状态 → 签名 → 探针判定对照表（§8.2）：一次运行同时给出五种状态的 computed/rect 与两个口径的判定
C=$(node .local-tests/mint-cookie.mjs)
DSH_PROBE_COOKIE="$C" \
DSH_PROBE_SESSION_ID=session-728385cb-372e-43dd-a14b-010d806bbcf1 \
DSH_PROBE_CHROME=/data/data/com.termux/files/usr/lib/chromium/chrome \
node .local-tests/hidden-copy-signature.mjs

# ② 启动时间线（§8.3）：从 document_start 起 100ms 采样，记录卡片布局态、app 相位、frame 内联 display
#    —— §5.1 的现场抓取工具；TL_MODE=hack 复刻 recon 原流程（先等 composer DOM，再摘 aria-modal 与 body 级 _root_15u5s）
DSH_PROBE_COOKIE="$C" DSH_PROBE_SESSION_ID=<id> DSH_PROBE_CHROME=/data/data/com.termux/files/usr/lib/chromium/chrome \
TL_SCENE=phone TL_MODE=plain TL_OUT=~/tmp/recon/tl/phone.json node .local-tests/composer-timeline.mjs
```

## 7. 原始数据与口径

- `~/tmp/recon/phone.json`（343 KB）、`~/tmp/recon/desktop.json`（394 KB）：每个候选的 `tag / class / data-* / rect / computed(display,visibility,opacity,position,contentVisibility) / offsetParent===null / aria-hidden / inert / 是否含输入或圈 / elementFromPoint 命中 / outerHTML 片段 / 5 层祖先链`，外加 `counts`、`phases`、`bodyKids`、`meters`、`inputChains`、`composerOutline`（卡内 3 层轮廓）。
- 候选口径：`[data-composer-card], [class*="_card"], [class*="_trailing"], [class*="_composer"], [class*="_hero"], [class*="_seat"], [class*="_row"]`（手机 108 个候选；其余族是 `CY-8Ka`×13、`uV2eYG`×3、`wSkVaW`×2）。
- `laidOut` 判据 = `getBoundingClientRect().width > 0 && height > 0`；注意它对「视口外但与布局树连通」的元素为真（13 张工具卡与轮尾动作栏都是这种）。

## 8. 收口取证（2026-09-17，接手 agent）

### 8.1 标记族归属（活体实测 + 宿主 bundle 双向对账）

| 标记 | 发射方 | 值 / 语义 | 已知消费方（实测） |
|---|---|---|---|
| `data-composer-card` | `dsh-client-ui-conversation` InputBar（`"data-composer-card": true` 挂 `InputBar_module_css_default.card`） | 恒 true，卡根，count = 1 | 宿主 `ui-model-selection` / `ui-message-feedback` / `ui-input-trigger` / `ui-agent-preset` 用它做 toast 锚与「点在卡内」判定；本插件 `composer-keyboard-guard.ts`、meter 锚点探针也锚它 |
| `data-composer-input` | 同包 Lexical 编辑面 | 恒 true，**0.1.2-alpha.2 起才有** | 本插件 `composer-keyboard-guard.ts`、手势层 files 族判定 |
| `data-phase` | app 根：`ConversationRoot`（`hero` / `active` / `settling`）<br>编辑面：SubmitMachine（`plain` / `claimed` / … / `inert`） | **双命名空间同名属性** | 宿主自己的 CSS（`[data-phase=active]`、`[data-phase=settling]` 隐藏 seat）；插件规则把它当特异度前缀用 |
| `data-conversation-composer-overlay` | 接管型视图自己声明（轨迹 tab 的 `views_module_css_default.root`） | 存在即「接管中」 | 宿主 `:has(...)` 布局切换 + 插件 `takeoverActive()` 手势让位 |

### 8.2 状态 → 签名 → 探针判定（`.local-tests/hidden-copy-signature.mjs`，手机 390×844 实测）

| 状态（在一张真实卡上就地构造） | trigger computed | trigger rect | 探针新口径（`rect.width > 0` 过滤） | 旧口径（只看 computed） |
|---|---|---|---|---|
| 0 live | 28×34 | 28×34 | 1 张可用卡 | 量到真身 |
| A `cloneNode`（分离节点） | **`""`（空串）** | 0 | 不受影响（真身仍在） | 量到真身 |
| B 祖先 `display:none` | **28×34** | **0** | **0 张可用卡 → `0.composer-present` 红** | **报 28×34 → 假绿** |
| C stack 上 `content-visibility:hidden` | 28×34 | 28×34 | 1 张可用卡 | 量到真身 |
| F **frame 内联 `display:none`（fence-only 形状）** | **28×34** | **0** | **0 张可用卡 → 红** | **报 28×34 → 假绿** |
| D `remove()`（分离节点） | `""` | 0 | 0 张可用卡（卡不在文档里） | 找不到 |
| E 还原 | 28×34 | 28×34 | 1 张可用卡 | 量到真身 |

→ 两列合看就是 §4.3 的结论：**签名 = 隐藏祖先**；同时这张表是新口径的**非空转证明**（B/F 行两列不同）。

### 8.3 启动时间线（8 次全新 profile，各 10 s，100 ms 变化驱动采样）

所有场景一致：`loading`（0 卡）→ `interactive`（0 卡）→ `complete` + hero 卡已布局（中间帧 22×116 → 356×108）→ 会话就绪后 app 相位 `active` + 卡 356×98；`[data-phase]` 两枚始终在场（`hero`+`inert` → `active`+`plain`）。**没有任何一次出现未布局的卡。** 原始数据 `~/tmp/recon/tl/*.json`（8 份），摘要如下：

| 场景 | 运行次数 | 采样区间 | 未布局卡的样本 | 无卡样本（仅启动期） |
|---|---|---|---|---|
| recon 原流程（清 `aria-modal` + body 级 `_root_15u5s`） | 3 | 10 s | 0 | 2–3 |
| 全新流程 + 真会话 | 2 | 10 s | 0 | 2–3 |
| hero（不注入会话 id） | 1 | 10 s | 0 | 3 |
| 不存在的会话 id | 1 | 10 s | 0 | 2 |
| 桌面 1280×720 | 1 | 10 s | 0 | 2 |

### 8.4 真身：宿主「链式叠加」顶掉 composer（2026-09-18 定案）

**机制（宿主源码，非推断）**：`@deepseek-ai/dsh-client-ui-renderer` 的 `renderChainResult(slotKey, elected, opts, ...)` 在有 `opts.overlay` 时渲染：

```jsx
<div data-chain-overlay-fallback={slotKey} style={{ display: elected === null ? "contents" : "none" }}>{fallback}</div>
{elected}
```

—— 即：**该槽没有叠加时包装是 `display:contents`（透传，布局照常），一旦有叠加被选中，包装变成内联 `display:none`**，选中节点作为它的下一个兄弟渲染。`conversation.composer` 就是这样一个带 overlay 的槽。

**活体证据（2026-09-18，连续 4 次全新 profile，同一会话 id）**：

| 观测项 | 值 |
|---|---|
| `[data-chain-overlay-fallback="conversation.composer"]` | 在場、内联 `display:none` |
| 其 sibling（elected） | `Mbwy4a_frame[data-question-key="question:1"]`（`dsh-client-ui-user-questions`，卡头「执行方式」——一张**未回答的提问卡**） |
| composer 卡 | 仍在 DOM、`connected=true`、computed `28px/34px`（规则值）、`getBoundingClientRect()` 全 0 |
| frame | 内联 display 无 `none`，computed `grid` 390×844（**fence-only 假设当场被证伪**） |
| `matchMedia(MOBILE_QUERY)` | true（排除断点误判） |
| 祖先链 | card → `uV2eYG_root` → `display:contents` → `wSkVaW_composerStack` → **`div[data-chain-overlay-fallback]`（display:none）** → `display:contents` → `wSkVaW_composerSeat` 388×448 → … → `pI_x6G_frame` |

提问被回答后，同参数再跑即回到「卡已布局 + meter 在场」，锚点探针 ALL PASS——即该状态是**会话级、可自行消失的正常状态**，不是环境损坏。

**状态对照（同一次运行实测，390×844）**：

| 状态 | computed | rect | 探针旧口径 | 探针现口径 |
|---|---|---|---|---|
| 正常 | 28×34 | 28×34 | 真身 | 真身 |
| 宿主链式叠加（G，模拟同形） | 28×34 | **0** | 假绿（报 28×34） | **SKIP + 点名 elected** |
| `content-visibility:hidden`（C，真祖先） | 28×34 | 28×34 | 真身 | 真身，但 `elementFromPoint` 命中为 null（第二类不可见） |
| `display:none` 祖先（B） | 28×34 | 0 | 假绿 | 0 张可用卡 → 红 |
| 分离节点（A/D） | `""` | 0 | 找不到 | 找不到 |

**探针契约（已实现于 `scripts/probes/composer-meter-hitbox-probe.mjs`）**：

1. 判定**只认 composer 槽自己的包装** `[data-chain-overlay-fallback="conversation.composer"]` 且其 computed `display === 'none'`。第一版写成 `document.querySelector('[data-chain-overlay-fallback]')`（文档里第一个）——其余槽的包装是 `contents`，于是永远判不出叠加（2026-09-18 自测抓到）。
2. 命中时**走 SKIP 并打印 elected 节点身份**（class + `data-question-key`），不当红、也不静默跳过；desktop 场景的 SKIP 行同样带上该信息。
3. 落回兼容：正常态一切照旧（`0.composer-present` 等断言全跑），`rect.width > 0` 过滤与 `elementFromPoint` 命中测试保留不动。

**遗留（登记，不在本次范围）**：宿主在「有叠加」与「无叠加」间切换时，插件注入的 meter 是否需要重算/重挂（当前实测无残影、切换后几何自洽）；提问卡本身不归本插件管。

## 9. 0.1.7-rc.1 增补（2026-09-25 复测）

**基线**：宿主 0.1.7-rc.1；2026-09-25 源码对账（scout）+ live DOM 双通道（checker）复测。报告：`docs/handover/2026-09-25-debugmap-recon-code-scout.md` / `-code-checker.md`。本节只记增量；§1-§8 机制结论除下述各点外保留有效，§3 表读数只适用 0.1.5。

**存活【bundle+live】**：旧 8 前缀（`uV2eYG_`/`wSkVaW_`/`JObwrW_`/`CY-8Ka_`/`Q51KRG_`/`TS9iAW_`/`xzv4MW_`/`Mbwy4a_`）全活；`renderChainResult` 逐字未变、`conversation.composer` 槽仍 `overlay:true`（bundle 实证）；`[data-chain-overlay-fallback="conversation.composer"]` 常态 `display:contents` live 在场——§4.3/§8.4 链式叠加机制原样有效。

**形态变化【live】**：
- 上下文圈 `JObwrW_` 迁出卡 → 新 `uV2eYG_dock` 行（`data-slot=conversation.composer.dock`）+ 旁增 `bOPqQW_` stats pills（`[data-composer-stats]`，「3 turns 22 steps…」）；移动端圈 16×20 / 桌面 pill 64.9×22「40%」。插件 28×34 hitbox 靶形态消失；#104 overlay 五标记实测随迁（`stats-ring-dock`=uV2eYG_dock、`stats`=bOPqQW_root、`stats-ring`=JObwrW_root）。
- 尺寸轴：卡 356×98→356×70（active）、input 高 36→28、row 42→34、tools 112×28→97×34。

**结构增量【live】**：tools 内新 `uV2eYG_modes` = `[data-slot=conversation.input.permission]`（权限菜单根 `_root_1t7on_1` / `iWlSmW_trigger`）+ `[data-slot=conversation.input.plan]`；trailing 内新 `uV2eYG_standardControls` = `[data-slot=conversation.input.right]` + `[data-slot=conversation.input.model]`（`_7KE1Ra_` 模型选择器）；新标记 `data-composer-seat` / `data-conversation-content` / `data-conversation-scroll` / `data-composer-placeholder` / `data-input-scroll`。

**相态语义【live】**：hero 卡根 = `uV2eYG_cardWorkspaceTrigger`（点卡=切工作区、编辑面 `aria-haspopup="menu"`、phase=inert）；「点卡根=无副作用」只在 active 相态成立——§3/探针对卡根 click 的假设按相态分叉。

**data-phase【live+bundle】**：稳定态恒 2 枚（active+plain / hero+inert）；第三处 `connecting|recovered` 出现在断连场景（primitives 连接指示器，bundle 实证、本测未捕获）——断言必须写值。

**计数常数作废【live】**：`[class*="_card"]` 与 `_root>_trigger[aria-haspopup="dialog"]` 随会话内容/渲染窗口变（本测移动 1/2、桌面 6/5；§3 的 14/2 只适用 0.1.5 那次会话）——记判定法不记常数。会话流有渲染窗口化迹象（移动 active 抓到 scrollBody 文本仅 101 字符、CY-8Ka 卡不在 DOM），滚动相关断言须滚动到位后取值。

**QA 配方两条变更【live】**：①会话种子必须全量 `dsh.*` localStorage 快照（只写 `dsh.sessions.current` 单键 0.1.7 落 hero 不恢复会话）；②`mint-cookie.mjs` 已禁用，改 token URL（GET / 303 换 HttpOnly cookie）。

**证据路径**：原始数据 `~/tmp/doc-recon-20260925/`（composer-desktop.json / composer-mobile.json / composer-mobile-active.json / capture-scripts.md）。
