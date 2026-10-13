# CSS 表面与结构审查（2026-09-15）· 发现清单 + 修复计划 + 再审查协议

> 基线分支 `fix/50-52-49-verified` @ `a7c4c97` · 四个样式模块全量人工审查 + 结构检测器实测

**给未来的审查者（包括未来的我）**：本文件是这次审查的**唯一权威快照**。不要凭记忆、也不要凭上一轮会话的转述复述结论——先跑 §0.2 的三条命令重新锚定，再按 §1 逐条复核（每条都带「复核命令」）。施工只做 §2 里状态为 READY 的任务；§3 的决策点必须先由用户拍板。

---

## §0 基线

### §0.1 冻结指纹（2026-09-15 21:48 本机）

| 文件 | sha1 | 行数 |
|---|---|---|
| `src/client/styles/base.css.ts` | `e6f2bac570a1fcb4e237dd151a8ae58cd21efe35` | 285 |
| `src/client/styles/layout.css.ts` | `c5e8a0140f0cec9494762ca288ddf2e5c8a5abb0` → 漂移后 `ef22d818bbab120ceb49ed02f42fd77218badf64` | 1117 → 1126 |
| `src/client/styles/compat.css.ts` | `110f753c746ba9ca30cf204b60308bdd947367e8` | 930 |
| `src/client/styles/misc.css.ts` | `4f5a5477a43040e5bb53af059a1be30ee4b500fc` | 277 |

四个文件在冻结时刻都 clean（= HEAD）。

> **注意（第 4 次漂移，冻结后 ≤15 分钟）**：`layout.css.ts` 已被另一个会话改成 `ef22d818…`（1126 行，+16/-7，未提交），内容是把消息正文的字号从冻结的 `15px !important` 改成宿主字号轴 `var(--dsw-font-markdown-base-font-size, var(--dsh-content-font-size, 14px))`（#52），`lib/` 同步重建中。**这是本文件唯一失效的一列行号**：`base` / `compat` / `misc` 三份 sha1 与冻结值完全一致，它们的行号仍然有效。已按内容逐条复核，**A2 / A4 / B1 / C1 / C2 / D1 / E2 七条全部存活**，只是偏移了 +8 ~ +11 行。

**行号是易耗品，内容是锚**：每条发现都带「复核命令」。行号对不上时用下表按内容重定位，不要凭偏移量硬加：

| 条目 | 按内容定位（`grep -n` on `layout.css.ts`） | 冻结时 | 第 4 次漂移后 |
|---|---|---|---|
| A2 | `order: 3` | L814–818 | **L824** |
| A4 | `out-specifies` | L187–196 | **L195** |
| B1a | `never matches it` | L743 | **L752** |
| B1b | `matches nothing` | L912 | **L921** |
| C1 | `max-width: 440px` / `max-width: 559px` | L913–916 / L929–932 | **L922 / L938** |
| C2 | `92vw` | L106 | L106（未变） |
| D1 | `below the host` | L84 | L84（未变） |
| E2 | `class\*="_text_"` | L301 / L317 | **L328** |

（`compat.css.ts` 的 A1/A3/C3/C4 与 `misc.css.ts` 的 D2/D3 行号不受影响；F1 在 `phone-chrome.ts`，按 §0.2 命令 3 检查。）

### §0.1b 奠基结果（隔壁会话收工、树静止之后）

| 项 | 结果 |
|---|---|
| 工作树 | `git status` **0 条**；最近 10 分钟无文件被改 → 静止 |
| 分支 / HEAD | `fix/50-52-49-verified`，头部 `e24687c docs(audits): add the 2026-09-15 CSS surface and structure audit`（本文件已被邻座提交入库） |
| 门禁 | `pnpm verify` ✅ · `pnpm test:core` **120/120** ✅ · `pnpm build` ✅ · `git diff --exit-code lib` **干净** ✅ |
| 指纹 | 与 §0.1 一致：只有 layout 是 `ef22d818…` / 1126 行（字体轴 #52），另三份与冻结值**逐字节相同** |
| **F1** | **已修**：`6111603 refactor(client): delete the dead host-generation probe`（源码 −43/+11，bundle 354267→352613 B），函数 docstring 留了墓碑注释 |
| **T0** | **已完成**：`scripts/css-structure-check.mjs` 入库（sha1 `b2fd5b9141914e9350ab8e79e72ad2a991b03f73`） |
| A–E 各条 | **全部存活**：A1 仍 16 fatal；A2/A4/B1/C1/C2/D1/E1/E2/C3/C4 的内容锚逐一命中（行号见上表） |
| 本文件登记 | 已写入 `AGENTS.md` 维护入口（并受 `tests/docs-consistency.test.ts` 的「引用必须存在」门约束） |

**F1 的再检查式必须改（否则假阳性）**：现在 `grep -rn 'data-mobile-nav-gen' src/ lib/` 会命中**墓碑注释**（3 处）。要锚在写入方/符号上：

```sh
grep -rnE "(set|remove)Attribute\('data-mobile-nav-gen'" src/ lib/ | wc -l   # 期望 0
grep -rn 'isNativeDrawerGeneration\|updateNativeDrawerGen' src/ lib/ | wc -l  # 期望 0
```

**教训（写进同类守卫）**：字符串式守卫会被「解释这条已删除」的注释打成假阳性——删死代码时留墓碑是对的，但守卫要锚在符号或写入方上。

**邻座新增的守卫面（别重复造）**：`src/client/core/css-rules.ts` + `tests/css-rules.test.ts` 是**源码级级联读取器**（回答「哪条 font-size 会落到这个元素上」，跑在 `test:core` 里）；它**刻意丢弃 at-rule 条件**，所以答不了嵌套深度/缩进这类问题——那正是本文件 T0 那个检测器的结构半边。两者互补，不合并。

**运行时就绪度（下一轮跑真页面前的硬前置）**：3080 在跑（无 cookie 401 → 有 cookie 200）；**served bundle 就是当前代码**（四个当前源码独有标记 `nothing ever read` / `dsw-font-markdown-base-font-size`×2 / `session-row-fiber`×3 / `data-mobile-nav-gen`×1 与本地 lib 1:1 命中），所以运行时审查看到的是被审的代码，不是旧 bundle。读它的正确姿势见 §0.1b 的 `rev` 修正（组合端点 `??dsh-web-mobile/client.js`；`rev` 与 sha1 无关，别用它判代）。零残留 headless chrom、`~/tmp/pw-dsh-tmp` 就位、chromium ELF 就位。

### §0.2 再审查：三条锚定命令

```sh
cd ~/dsh-mobile-nav
sha1sum src/client/styles/*.css.ts                       # 1. 比指纹，决定哪些行号还有效
node scripts/css-structure-check.mjs                     # 2. 结构门（本审查新增，源码见附录 A）
grep -rn 'data-mobile-nav-gen\|updateNativeDrawerGen' src/ lib/   # 3. F1 死代码回归检查（应 0 命中）
```

命令 2 的**基线是 16 fatal + 5 info**（全部 fatal 落在 `compat.css.ts` L743–817，即 A1）。T1 完成后应为 **0 fatal**，此后任何 fatal 都是新引入的结构缺陷。5 条 info 是复核清单，不是缺陷（C3、E2、dvh 兜底对）。

### §0.3 覆盖 / 不覆盖

- **覆盖**：四个 `.css.ts` 的语法结构、缩进与嵌套一致性、选择器特异度与顺序依赖、死声明/死规则、注释与实现是否一致、移动分支隔离（非移动环境是否被误伤）。
- **不覆盖**：像素级视觉正确性（那要靠真机/探针，见 §5）；第三方包内的样式；JS 行为正确性（只在其与 CSS 注释矛盾时作为证据引用）。
- 本审查**没有改动任何源码**，只新增本文件（与建议新增的检测器脚本）。

---

## §1 发现清单

严重度：**P1** = 会误导后续维护或已产生错误结论；**P2** = 冗余/脆弱，暂无行为错误；**P3** = 观感与整洁。

### A 类：结构

#### A1 · compat.css.ts L743–817 · P1 · 整块缩进失真 + 重复媒体查询

**现象**：`@media (max-width: 1023px) and (pointer: coarse)`（L6 开）仍然开着，但 L743–817 这 16 个块全部写在**第 0 列**，看起来像在媒体查询之外；其中 L763 又开了一层**同条件嵌套** `@media (max-width: 1023px) and (pointer: coarse)`（注释声称是「窄屏额外一条」，实际条件是 AND 合并的冗余嵌套）。

**证据**：检测器 16 条 fatal，范围 L743–817；L743/749/756/763/794 逐一目视核对为真（`sed -n '743p;749p;763p;794p' src/client/styles/compat.css.ts`）。

**风险（为什么是 P1 而不是 P3）**：缩进在 CSS 里是**唯一**的嵌套信号，这里它撒了谎。任何人（或任何模型）据此判断「这些规则不在移动分支里」，都会得出错误结论：以为它们会影响桌面，或者以为自己新写的规则需要再加一层媒体查询。L763 的嵌套副本更会让人以为「这里有个内层条件」，而它没有任何作用。

**修法**：删掉 L763 那一行重复的 `@media`（保留其花括号需要一并收掉），并把 L743–817 整块按实际深度缩进到 2 / 4 空格。**必须整块一起改**：只删 L763 而不重新缩进，会让块结构错配；只缩进不删 L763 则留下误导性的空壳。
**复核命令**：`node scripts/css-structure-check.mjs`（该块应全部消失，fatal 归零）。
**验收**：检测器 0 fatal；`pnpm test:core` 通过（`docs-consistency.test.ts` 会重新校验「无裸 `.hash_ {` 选择器」等不变量）。

#### A2 · layout.css.ts L814–818 · P2 · 死声明（`order` / `flex` 对绝对定位元素无效）

**现象**：`[data-mobile-nav="frame"] [data-phase] header [data-mobile-nav="files"] { order:3; flex:0 0 28px; width:28px }`——该元素在 L677–683 已被钉成 `position:absolute !important; right:8px; top:12px`。绝对定位的子元素**不是 flex item**，`order` 与 `flex` 对它完全无效。

**证据**：真引擎 A/B（Playwright 夹具，两种 order 取值 × 两种 position）：absolute 时 `order:-1` 与 `order:3` 命中测试都返回 x=1244；改成 static 后同一夹具给出 40 / 140。即 order 只在非绝对定位时生效。
**修法**：删掉 `order` 与 `flex` 两行，保留 `width`（仍需显式宽度）。若未来想让该按钮回到流式布局，需要连同 L677 的 position 覆盖一起撤销——不能只加回 order。
**复核命令**：`grep -n 'order:3' src/client/styles/layout.css.ts`（应 0 命中）。

#### A3 · compat.css.ts L402–409 · P2 · 构造上永不生效的规则

**现象**：L402 已给 `[class*="_header"]:not([class*="_headerActions"])` 下的**每个** `[class*="_actions"]` 设 `display:none !important`；L405 紧接着去样式化这些元素的子元素 `[class*="_action"]`。父元素已经彻底不渲染，子元素规则不可能有可见效果。
**证据**：两条选择器逐字对照（L402 是 L405 的真前缀链）。
**修法**：删 L405–409 整块（含注释）。删除**零行为变化**——这是全清单里最安全的一条。
**复核命令**：`grep -n '_actions"\] \[class\*="_action"\]' src/client/styles/compat.css.ts`（应 0 命中）。

#### A4 · layout.css.ts L187–196 · P2（决策 D-2）· 特异度平局被当成「压过」

**现象**：注释声称第一个选择器「simply out-specifies」宿主规则；实测两边都是 4 个属性选择器 = **(0,4,0)**，是平局，胜负由**样式表注入顺序**决定——正是同一段注释紧接着警告的那种依赖。
**证据**：`docs/audits/2026-09-13-0.1.5-region-audit.md:141` 记录了宿主那条规则的 (0,4,0)；本插件侧同数属性选择器。
**修法**：二选一，见 §3 D-2。不修也不能说它是 bug——平局在我们这边时结论正确，只是结论**没有它声称的那种保障**。
**复核命令**：`grep -n 'out-specifies' src/client/styles/layout.css.ts`。

### B 类：注释腐坏

#### B1 · layout.css.ts L743、L912 · P1 · 批量替换误伤散文

**现象**：两处注释现在读作「so `[class*="_root"]` never matches it. Use `[class*="_root"]`…」与「…carries a trailing space; `[class*="_root"]` matches nothing」——**语义完全颠倒**（原文讲的是后缀选择器 `[class$=` 失配，被改成了子串选择器）。
**证据**：`d586aa5`（`fix: match prefixed CSS-module hashes with substring selectors`）把 `[class$=` 批量替换为 `[class*=`,替换**扫到了注释**；全仓库 `src/` 现存 `[class$=` 命中数为 0，说明这次替换是全局的。
**修法**：只改回这两处散文里的记号（保持结论正确：后缀测试对整串生效，带尾随空格/多 token 的 class 会整体失配）。**不要**去动任何选择器本体。
**复核命令**：`grep -rn 'class\$\=' src/client/styles/`（修完后这两处注释里应出现 `[class$=]` 字样，选择器仍是 `[class*=]`）。

### C 类：冗余与失效

| ID | 位置 | 现象 | 修法 |
|---|---|---|---|
| C1 | layout.css.ts L913–916 vs L929–932 | 同一条 `…header [class*="_crumbs"] { padding-right: 8px }` 同时写在 `@media (max-width: 440px)` 与 `(max-width: 559px)` 里；440 ⊂ 559，窄的那份永不单独生效（两份的 `_count` 守卫不同是**有意**的，别一起删） | 删 440 块里的 `_crumbs` 那条，保留 `_count` 那条 |
| C2 | layout.css.ts L106 | `max-width: 92vw` 永不生效：同行 L105 已是 `width: min(88vw,280px) !important`，88vw 恒小于 92vw；它也无法「防」宿主的 important 宽度（important 对 important 靠特异度与顺序，不靠 max-width） | 删 L106（保留 L105 的 `min()` 作为唯一宽度来源） |
| C3 | compat.css.ts L769/L789（另 layout L592/L617、base L137/L196 同形） | 同一个 `> [class*="grow"]` 选择器被拆成相隔 15–20 行的两条规则 | 合并成一条；纯整洁，零行为变化（检测器把它列为 info） |
| C4 | compat.css.ts L110 | 注释「The fullscreen toggle has its own drawer-open rule at the end of its section.」——**该规则不存在**（全文没有 `preview-full-toggle` 与 `data-sidebar-collapsed` 的配对） | 删这句，或改写成事实：toggle 作为列的子孙被 L111–115 一并隐藏（同文件 L157–159 的注释写的是正确版本） |

### D 类：注释与实现漂移

#### D1 · layout.css.ts L82–88 · P1 · 注释仍在论证已被推翻的取值

**现象**：注释说「z-index:40 is below the host's 1100」，而实际规则是 `z-index: 1300 !important`（L115）；引用的 321px 等测量值也来自旧宽度（现为 `min(88vw,280px)`）。
**证据**：同文件 L179（AGENTS.md 亦同）记录了 40→1300 的历史与「全黑 + 点哪都关」的根因。
**修法**：把这 7 行注释改写成当前事实：抽屉列 1300 / 遮罩 1250 的层级契约，以及为什么 40 会致命（压到宿主 1100 之下 → 有 box 不绘制）。不必保留历史数值。
**复核命令**：`grep -n 'below the host' src/client/styles/layout.css.ts`（应 0 命中）。

#### D2 · misc.css.ts L204–207 · P2 · 「所有模态框都居中」言过其实

**现象**：L208–209 的实际覆盖是 `(sheet-shape ∧ ¬nav ∧ ¬ZuhsRW) ∪ (¬sheet-shape)`——**目录选择器一族被有意排除**（见 `layout.css.ts` L977–996 的专门规则）。
**修法**：把「All modal dialogs」改成实际覆盖范围，并指出目录选择器由哪条规则接管。
**复核命令**：`grep -n 'never edge-to-edge' src/client/styles/misc.css.ts`。

#### D3 · misc.css.ts L113–116、L125–129 · P2（决策 D-1）· 16px 规则没有 iOS 门控

**现象**：这两条被标题为「kill iOS Safari auto-zoom」的 16px 规则**不带** `html[data-mobile-nav-ios]` 门控；而同文件 L146–148 的注释明确写着「Android and desktop keep the compact 13px search boxes」，L168 起另有一套**带门控**的 16px 下限。
**后果**：iOS 上这两条与 L168–174 完全冗余；Android 上它们的唯一效果是把 13–14px 抬到 16px（与「Android 保持紧凑」的声明直接矛盾）。
**修法**：见 §3 D-1（要么加 iOS 门控，要么承认 Android 就要 16px 并改掉 L146–148 的说法）。
**复核命令**：`node scripts/cdp-zoom-probe.mjs`（21 断言；三场景含 Android 无 iOS 标记时应保持 13px 的那条断言）。

### E 类：有意为之，但脆

#### E1 · base.css.ts L98 vs L111 · P2 · 特异度倒挂使三条 `!important` 变成承重墙

**现象**：L98 `[data-mobile-nav="delete-confirm-actions"] > button` (0,1,1) **压过** L111 `[data-mobile-nav="delete-confirm-yes"]` (0,1,0)。因此 L111 里的三条声明必须带 `!important` 才画得出来。
**证据**：真引擎实测——去掉 `!important` 后计算值是 `rgb(1,1,1)/rgb(2,2,2)`，保留时是 `rgb(9,9,9)/rgb(8,8,8)`。
**修法**：不紧急，但要在 L111 处留一句注释说明「这里的 `!important` 是被 L98 的特异度逼出来的，任何新增的非 important 属性都会静默失效」。这是**防止下一个人加属性加了个死的**。
**复核命令**：`grep -n 'delete-confirm-yes' src/client/styles/base.css.ts`。

#### E2 · layout.css.ts L301、L317 · P3 · 全仓仅有的两处多行选择器

**现象**：`[data-phase]` 与 `[class*="_scroll"]…` 被折成三行、用 `[ class*="_text_" ]` 这种带空格的写法。这是四个模块里**唯一**的格式例外（检测器按「选择器首行缩进」判定为合规，故不报 fatal）。
**修法**：可选改成单行，与全仓风格一致；不改也无害。
**复核命令**：`node scripts/css-structure-check.mjs`（无输出即合规）。

### F 类：流程与仓库状态（本次审查最重要的两条）

#### F1 · phone-chrome.ts L118/L166/L170/L171/L186/L197 · P1 · 已被批准删除的死代码回来了，而三份文档都写着「源码零残留」

> **状态：已修（2026-09-15，`6111603`）**——邻座按本条删除并留墓碑注释；下面的现象描述保留为原始取证。**再检查式见 §0.1b**（不要用裸字符串，墓碑会假阳性）。

**现象（原）**：`isNativeDrawerGeneration()` / `updateNativeDrawerGen()` 仍在源码里，每次 `frame-marker` flush 在 `<html>` 写 `data-mobile-nav-gen="native-drawer"`——**全仓库没有任何读者**（CSS 四模块 0 命中、JS 0 命中，只有 3 处写/清）。而 `AGENTS.md` §Pitfalls、`docs/maintenance/pitfalls.md:131`、`docs/audits/2026-09-13-0.1.5-region-audit.md:233` 三处都写着「已于 2026-09-14 用户批准后整体删除（源码零残留）」。

**根因（可复现）**：`git log --all --oneline -S'isNativeDrawerGeneration' -- src/client/effects/phone-chrome.ts` **只返回一个提交 `6e80661`（加入的那次）**——**删除从未被提交**，它只存在于当时的working tree，随后在某次分支切换/还原中丢失。这与本次会话 21:44 记录的其它丢失同源（见 §4）。

**为什么必须记在这里**：这正是「文档说做过了、代码说没做」的活体案例，而它踩的还是本仓库已经总结过的教训（`pitfalls.md:131`：判死代码要 grep 读方，不能读写入方的自述注释）。下一位审计者若相信文档，会把「4 处写入 + 0 读者」这一现状**再次**误判成已清理。

**修法**：见 §3 D-3（推荐重新删除，并在同一次提交里重建 lib）。
**验收（两条都要）**：
```sh
grep -rn 'data-mobile-nav-gen\|updateNativeDrawerGen\|isNativeDrawerGeneration' src/ lib/ tests/ scripts/ | wc -l   # 期望 0
pnpm build && git diff --exit-code lib   # 期望无差异（lib 已随源码重建并提交）
```

#### F2 · 仓库状态 · P2 · 审查对象在审查过程中被三次改写

**时间线（本机同时刻，同一会话内实测）**：

| 时刻 | 分支 | `git status` 条目 | 4 个 CSS 文件 | AGENTS.md |
|---|---|---|---|---|
| 21:44 | `fix/issues-50-52-host-parity` | 21 | base/misc MODIFIED，layout/compat clean | MODIFIED（66353 B，超预算） |
| 21:48 | `fix/50-52-49-verified` @ `a7c4c97` | 8 | 四份 sha1 **与 21:44 完全一致** | = HEAD |
| 22:0x | `fix/50-52-49-verified`（未提交） | 10 | **layout 变成 `ef22d818…`（+16/-7）**，另三份不变；`lib/` 已被对方重建 | 未变 |

`a7c4c97`（`chore: baseline normalization — carry in-flight work…`）把在飞工作一并提交，理由是**已提交的 AGENTS.md 66353 B 超过 `tests/docs-consistency.test.ts` 的 65536 B 预算**，干净检出会直接挂在 `test:core`。该提交**没有碰** `layout.css.ts` / `compat.css.ts`——本次审查的 CSS 结论因此全部存活（行号已按新文件复核）。

**流程结论（写进下次审查的开工动作）**：审查开始前必须先 `sha1sum` 四个 CSS 文件并记录分支/HEAD；审查中途若文件变了，**只重定位变化的那几个条目**，不要重跑全量。本文件 §0.1 就是按这个规矩写的。

---

### G 类：本次**没有**系统审查的隐性 bug 类别（诚实登记，勿当成已审）

上面 A–F 是**静态可得**的那一类隐性缺陷：永远不生效的死代码、撒谎的注释、被当成压过的平局、特异度倒挂逼出的承重 `!important`。下面这一类**本次只做了线索级扫描，没有定性**，而它恰恰是本仓库历史上真正出过事的类别（hero 净空被同特异度 (0,3,0) 踩成 6px；header 排布冲突；`base→layout→compat→misc` 的拼接顺序让 misc 覆盖 compat）：

> **跨模块「同特异度 + 命中同一元素 + 靠样式表加载顺序定胜负」的声明。** 表现是：某条规则看着写对了，实际被后一块里一条**并不更强**的规则压掉；或者反过来，一条旧规则在特定状态下才被压掉，于是只有那个状态出问题。

**本次做到哪一步**：现补了一次静态扫描（脚本 `~/tmp/css-review/cross-module-conflict.mjs`，一次性工具，故意不落库）：
- (a) **完全相同的选择器文本**跨模块且同名属性取值不同 → **0 组**（这是个有用的阴性结论：冲突不是「同一选择器写两遍」这种显式形态）。
- (b) 不同选择器、**特异度相同**、同名属性取值不同 → **63 组候选**，但绝大多数是**假阳性**：`[data-mobile-nav="toggle"]`（base L7）与 `[data-mobile-nav="fab"]`（base L205）特异度都是 (0,1,0) 且都声明 `display`/`align-items`，可它们**永远不可能是同一个元素**。静态匹配无法回答「是否命中同一元素」，所以 (b) 只能当线索表，**不能当结论**。

**结论：这一类无法用静态分析定性，必须取运行时的元素级 matched rules。** 唯一可靠手段是 CDP 的 `CSS.getMatchedStylesForNode`（对每个命中元素返回 matchedCSSRules、各自特异度与来源样式表），把「被同特异度对手按顺序压掉的声明」逐条列出来。本仓库现有的 18 个 anchors 探针 + 4 个 cdp-* 探针 + 主探针 14 项断言 + CI 三门**都没有覆盖这个能力**（2026-09-16 订正：此前写的 15/32 是过时计数）。

**同一类别里另外三个未审项**（都需要运行时，本次完全没碰）：
1. **状态矩阵**：抽屉开/合 × files 面板开/合 × sheet 开 × `[role="menu"]` 开 × 流式中 × subagent running/idle 形态 × `html[data-mobile-nav-ios]` 有/无 × ≥1024px 宽触摸。本次只在「默认态」上推理。
2. **`:has()` 过匹配**：如 `header:has(> *)`、`body:has([data-mobile-nav="frame"]:not([data-sidebar-collapsed]))`——守卫是有的，但没验证它在别的状态（空 header、hero 态、多个 menu）下是否误命中。
3. **`env()` 兜底完整性**：只在 files 面板那条上核过；没做全量 `env(safe-area-inset-*)` 的 sweep（有无 fallback、是否与 `box-sizing` 成对）。

### H 类：本次未审的其它面

- 第三方包自带的样式表（aionui / market / genui / meme / stats / file-viewer 的 **上游** CSS 与我们规则的交互，只看了我们自己这四份）。
- `lib/` 生成物与源码的一致性（只用了 `git diff --exit-code lib` 这个门，没逐条比对 CSS 文本）。
- 动画/过渡的时序与 `prefers-reduced-motion` 分支的实际观感。

## §2 施工任务

### Global Constraints（每个任务都隐含遵守）

- **AGENTS.md 预算**：测试强制 ≤ **65536 B**；**但运行时注入截断更早**（实测 65501 B 时尾部整条不加载），安全线按 **≤64800 B** 走。2026-09-16 压缩后为 **64714 B**（本轮又落了三条契约，同轮压缩了会话删除与市场两条旧条目腾出空间）。加指针时若超，先把叙述性内容搬进 `docs/maintenance/pitfalls.md`。
- **AGENTS.md 只能引用存在的路径**，且必须匹配 `scripts/probes/*.mjs` / `scripts/cdp-*.mjs` / `docs/specs/*.md` / `docs/audits/*.md` / `docs/upstream/*.{md,json}` / `docs/maintenance/*.md`；引用数 ≥10。
- **`pitfalls.md` 需 ≥15 个 `## ` 小节；AGENTS.md 需 ≥15 个指向它的 `docs/maintenance/pitfalls.md\` §` 指针。**
- **每个 CSS 模块反引号恰好 2 个**（模板定界符）；**CSS 注释里写反引号会提前终止模板**（TS1005）。
- 三个 CSS 模块中**不得出现裸 `.hash_ {` 选择器行**；`wSkVaW_` 规则必须带 `[data-mobile-nav="frame"]`（同测试文件）。
- **`lib/` 必须随源码重建**：CI 有 `git diff --exit-code lib` 新鲜度门。改完源码不 rebuild = 任务未完成。
- 门禁顺序：`pnpm verify` → `pnpm test:core` → `pnpm build` → lib 新鲜度。
- **门禁还要看得见未跟踪文件**：`git diff` 系列都不报 `lib/` 下的孤儿产物，而 `tsc` 从不清理 outDir——删源码后旧产物会永久留下。补一条 `git status --porcelain --ignored lib` 必须为空。
- **lib 新鲜度这条命令有陷阱（2026-09-16 实证，两个坏提交就是这样溜过去的）**：`git diff --exit-code lib` 比的是**工作区 ↔ index**，只要你之前 `git add lib` 过，它**恒绿**，无论源码有没有一起提交。CI 里 index==HEAD 所以有意义，本地不是。本地等价写法＝提交后**再 build 一次**，然后 `git diff --exit-code HEAD -- lib`（比 HEAD，不比 index）；源码与 `lib/` 必须进**同一个提交**。
- **HEAD 已实测为绿（2026-09-16）**：`git archive HEAD` 导出到 `~/tmp` 干净目录 → 接上仓库 `node_modules` → `pnpm build`，再逐字节比对：**69 个入库 `lib` 文件全部一致、0 个未跟踪孤儿**。所以修正后的门禁在分支尖端会通过；历史上有两处「`lib/` 领先源码一个提交」的配对（`acc26ec`/`26ca8e9` 由 `232cc26` 补源），只影响逐提交的历史形状，不影响 HEAD 与将来的 PR。这条检查**不必等浏览器**，任何时候可重复。
- 动任何文件前先跑 §0.2 命令 1；指纹不符则该文件的行号作废。

---

> **执行状态总表（2026-09-16 复核，逐条以命令实测而非提交信息为准）**
>
> | 任务 | 状态 | 实测核对（命令 → 观察值） |
> |---|---|---|
> | Task 0 结构检测器 | ✅ 落库 | `sha1sum scripts/css-structure-check.mjs` → `b2fd5b9141914e9350ab8e79e72ad2a991b03f73`，与下方 Step 2 期望**逐字节相同** |
> | Task 1 A1 缩进／重复 media | ✅ | `grep -c '@media (max-width: 1023px) and (pointer: coarse)' src/client/styles/compat.css.ts` → **1**（去重后）；checker 16 fatal → 0 |
> | Task 2 B1 后缀匹配注释 | ✅ | `grep -rn 'class\$=' src/client/styles/` → **2 命中，都是注释**（无选择器） |
> | Task 3 A2/A3 死 order 与死规则 | ✅ | `grep -c 'order: 3' …/layout.css.ts` → **0**；`grep -c 'flex: 0 0 28px' …` → **0** |
> | Task 4 C 类冗余 | ✅ | 合并两对分割选择器（`f1738f1`）；**第三对刻意不并**，作为 checker 的 info 留在基线里（不是漏做） |
> | Task 5 D 类注释订正 | ✅ | 手势旧值 `96px` 在 `src/client/styles/` **0 命中** |
> | Task 6 F1 死代码 | ✅ | `isNativeDrawerGeneration` 在 `src/` **0 命中**（`6111603` 删除；源码只剩一条解释它已消失的注释） |
> | Task 7 收口 | ✅ | 计数两处同步（AGENTS 两处「18 个回归锚点」+ README「十八个锚点」）；`node --test tests/docs-consistency.test.ts` → 6/6 |
> | Task 8 G 类运行时门 | ✅ | 见 §状态表 G 行（独立验收 EXIT=0 + 白名单自失效红队实测） |
>
> 各任务下的 `- [ ]` **Step 勾选框保留为原始计划文本，未逐条回填**——执行中的偏差（删改行数、合并取舍、实测数字变化）以本表和 §6 修订记录为准，回填勾选框只会产生第二份可能过时的真相。

---

### Task 0：把结构检测器落库 —— **已完成（2026-09-15）**

> 已落在 `scripts/css-structure-check.mjs`（sha1 `b2fd5b9141914e9350ab8e79e72ad2a991b03f73`），跑当前树输出 **16 fatal + 5 info**（＝A1 的债，T1 清零）。脚本头已注明与 `src/client/core/css-rules.ts` 的分工。**是否接进 `test:core` 见 §3 D-4**（T1 已落地，16 fatal 已清零，现在是可接的时点）。

**Files:** Create `scripts/css-structure-check.mjs`（源码见**附录 A**，本审查已实测）

- [ ] **Step 1**：把附录 A 的源码原样复制为 `scripts/css-structure-check.mjs`（该脚本在 `scripts/` 下会自动把仓库根解析为 `../`，无需环境变量）。
- [ ] **Step 2**：`sha1sum scripts/css-structure-check.mjs` → 期望 `b2fd5b9141914e9350ab8e79e72ad2a991b03f73`（与实测文件逐字节相同）。
- [ ] **Step 3**：`node scripts/css-structure-check.mjs` → 期望 **16 fatal + 5 info**，且 16 条 fatal 全部落在 `compat.css.ts` L743–817。
- [ ] **Step 4**：`node --test tests/docs-consistency.test.ts` → PASS（新脚本不进任何测试，只作人工门）。
- [ ] **Step 5**：提交 `chore: add css structure checker`。

> 可选（不阻塞）：把它挂进 `package.json` scripts（如 `"check:css": "node scripts/css-structure-check.mjs"`）。**不要**接进 `test:core`：当前基线是 16 fatal，接了立刻红。

---

### Task 1：A1 —— compat 块缩进归位 + 删除重复媒体查询

**Files:** Modify `src/client/styles/compat.css.ts:743-817`（并删除 `:763`）

- [ ] **Step 1**：先跑基线：`node scripts/css-structure-check.mjs`（记录 16 fatal 的确切行号）。
- [ ] **Step 2**：删除 `:763` 那一行 `@media (max-width: 1023px) and (pointer: coarse) {` **及其配对闭合花括号**（配对括号在块尾，务必数清楚；删完先跑 Step 4 看 fatal 数是否从 16 降到 15 左右再继续）。
- [ ] **Step 3**：把 L743–817 整块按真实嵌套深度缩进：直接位于移动媒体查询内的规则缩 2 空格，嵌套层内的缩 4 空格。**只改行首空白**，不动任何选择器和声明。
- [ ] **Step 4**：`node scripts/css-structure-check.mjs` → 期望 **0 fatal**（info 仍为 5）。
- [ ] **Step 5**：`git diff --stat src/client/styles/compat.css.ts` 人工核对：diff 应**只有空白变化 + 一行删除**，不得出现任何属性/选择器改动。
- [ ] **Step 6**：`pnpm verify && pnpm test:core && pnpm build && git diff --exit-code lib`（最后一条在提交前必然显示 lib 有差异——先 `git add lib` 再复跑）。
- [ ] **Step 7**：提交 `style(compat): restore block indentation and drop the duplicate media query`。

---

### Task 2：B1 —— 复原两处被批量替换误伤的注释

**Files:** Modify `src/client/styles/layout.css.ts:743`、`:912`（散文里的记号，**不是选择器**）

- [ ] **Step 1**：`sed -n '742,744p;911,913p' src/client/styles/layout.css.ts` 读现行文本（现在语义是反的）。
- [ ] **Step 2**：把两处散文改回后缀记号的正确说法：后缀测试对整个 class 属性串生效，因此带尾随空格或多 token 的值（如 `ZKlsPq_root `）会整体失配。
- [ ] **Step 3**：`grep -rn 'class\$\=' src/client/styles/` → 只应命中这两条注释；`grep -c 'class\*=' src/client/styles/layout.css.ts` 不变（选择器一个没动）。
- [ ] **Step 4**：`node --test tests/docs-consistency.test.ts` → PASS（反引号恰好 2 个；注释词不引入反引号）。
- [ ] **Step 5**：`pnpm build && git add src lib && git commit && pnpm build && git diff --exit-code HEAD -- lib`。
- [ ] **Step 6**：提交 `docs(css): restore the suffix-matching prose mangled by the hash migration`。

---

### Task 3：A2 + A3 —— 删死声明与死规则

**Files:** Modify `src/client/styles/layout.css.ts`（A2，用 `grep -n 'order: 3'` 定位；冻结时 L814–818）；Modify `src/client/styles/compat.css.ts:402-409`（A3）

- [ ] **Step 1（A2）**：定位 `order: 3` 所在的那条 `[data-mobile-nav="files"]` 规则，删掉 `order: 3;` 与 `flex: 0 0 28px;` 两行，保留 `width: 28px` 与选择器/花括号。
- [ ] **Step 2（A2 验证）**：`grep -n 'order:3' src/client/styles/layout.css.ts` → 0 命中。
- [ ] **Step 3（A3）**：删掉 L405–409 整块（死规则 + 其上方的说明注释）。
- [ ] **Step 4（A3 验证）**：`grep -n '_actions"\] \[class\*="_action"\]' src/client/styles/compat.css.ts` → 0 命中。
- [ ] **Step 5**：`node scripts/css-structure-check.mjs` → 仍 0 fatal（若 T1 未做则为 16，注意别把新问题算进基线）。
- [ ] **Step 6**：`node scripts/probes/header-files-pin-probe.mjs`（若本机有活跃 3080 实例；它守的正是那个被钉在右上角的按钮，11 断言）——A2 只删死声明，期望结果不变。
- [ ] **Step 7**：`pnpm verify && pnpm test:core && pnpm build && git add src lib && git commit && pnpm build && git diff --exit-code HEAD -- lib`。
- [ ] **Step 8**：提交 `refactor(css): drop declarations and a rule that can never apply`。

---

### Task 4：C1–C4 —— 冗余清理

**Files:** Modify `src/client/styles/layout.css.ts:106`、`:913-916`、`:592/617`；`src/client/styles/compat.css.ts:110`、`:769/789`；`src/client/styles/base.css.ts:137/196`

- [ ] **Step 1（C1）**：删 `@media (max-width: 440px)` 块内的 `…header [class*="_crumbs"] { padding-right: 8px }`（保留同块的 `_count` 规则，那是 ≤440 与 ≤559 的**有意差异**）。
- [ ] **Step 2（C2）**：删 L106 的 `max-width: 92vw`（`min(88vw,280px)` 恒更小）。
- [ ] **Step 3（C3）**：合并三处被拆分的同选择器规则（`grow` / `:first-child` / `header`）——**先 `node scripts/css-structure-check.mjs` 看 info 列表确认位置**，合并时保持声明顺序，因为同一条规则内后写的同属性才生效。
- [ ] **Step 4（C4）**：删掉「has its own drawer-open rule at the end of its section」这句失实注释，改成 toggle 作为列的子孙被同一块隐藏。
- [ ] **Step 5**：`node scripts/css-structure-check.mjs` → fatal 数不增加；info 从 5 降到 2（C3 三处消失，dvh 与 E2 保留）。
- [ ] **Step 6**：`pnpm verify && pnpm test:core && pnpm build && git add src lib && git commit && pnpm build && git diff --exit-code HEAD -- lib`。
- [ ] **Step 7**：提交 `refactor(css): remove redundant rules and a stale comment`。

---

### Task 5：D1 + D2 —— 注释订正

**Files:** Modify `src/client/styles/layout.css.ts:82-88`；`src/client/styles/misc.css.ts:204-207`

- [ ] **Step 1**：把 layout L82–88 改写成当前事实（列 1300 / 遮罩 1250 的层级契约；为什么 40 会致命——压过宿主 1100 后「有 box 却不绘制不命中」）。删掉 321px 等旧测量值。
- [ ] **Step 2**：`grep -n 'below the host' src/client/styles/layout.css.ts` → 0 命中。
- [ ] **Step 3**：把 misc L204 的「All modal dialogs」改成实际覆盖（sheet 形态 ∧ ¬nav ∧ ¬ZuhsRW，加上 ¬sheet 形态），并注明目录选择器由 `layout.css.ts` 的专条接管。
- [ ] **Step 4**：`pnpm verify && pnpm test:core && pnpm build && git add src lib && git commit && pnpm build && git diff --exit-code HEAD -- lib`。
- [ ] **Step 5**：提交 `docs(css): align comments with the shipped behaviour`。

---

### Task 6：F1 —— 重新删除 `data-mobile-nav-gen` 死代码（须先过 §3 D-3）

**Files:** Modify `src/client/effects/phone-chrome.ts:118-197`（两个函数 + 调用点 + dispose 清理）

- [ ] **Step 1**：`git log --all --oneline -S'isNativeDrawerGeneration' -- src/client/effects/phone-chrome.ts` 记录证据（应只有 `6e80661` 一个提交 = 删除从未提交）。
- [ ] **Step 2**：删除 `isNativeDrawerGeneration()`、`updateNativeDrawerGen()` 两个函数、`frame-marker` 任务里的调用、以及 dispose 分支里的 `removeAttribute`。
- [ ] **Step 3**：`grep -rn 'data-mobile-nav-gen\|NativeDrawerGen' src/ | wc -l` → **0**。
- [ ] **Step 4**：`pnpm verify && pnpm test:core`（`pnpm verify` 会抓出遗漏的导出引用）。
- [ ] **Step 5**：`pnpm build`，然后 `grep -c 'data-mobile-nav-gen' lib/client.js` → **0**（lib 里的 3 处旧命中随之消失）。
- [ ] **Step 6**：`git add src lib && git commit && pnpm build && git diff --exit-code HEAD -- lib`。
- [ ] **Step 7**：更正三处「已删除」陈述，使其与**这一次真的提交了**的事实一致（AGENTS.md §Pitfalls 那句、`docs/maintenance/pitfalls.md:131`、`docs/audits/2026-09-13-0.1.5-region-audit.md:233`），并追加一句溯源：上次删除未提交、在分支切换中丢失，本次以提交固化。
- [ ] **Step 8**：提交 `fix(client): actually remove the dead drawer-generation probe`。

---

### Task 7：收口

**Files:** Modify `AGENTS.md`（Maintenance 区一条指针）、`README.md`（若涉及计数）、`docs/maintenance/pitfalls.md`（若新增小节）

- [ ] **Step 1**：在 AGENTS.md 的 Maintenance/Testing 区加**一条**指针（≤527 B 余量）：指向本文件，说明「CSS 表面审查的发现与再审查协议在此」。
- [ ] **Step 2**：`node --test tests/docs-consistency.test.ts` → PASS（三条：引用路径存在、字节 ≤65536、pitfalls 小节/指针 ≥15）。
- [ ] **Step 3**：`stat -c%s AGENTS.md` → 必须 ≤65536（超了就把等长叙述搬进 `pitfalls.md` 再试）。
- [ ] **Step 4**：全门禁 `pnpm verify && pnpm test:core && pnpm build && git diff --exit-code lib`。
- [ ] **Step 5**：把本文件 §1 各条的状态列改为 DONE/SKIPPED 并补一行「本次执行人 / 日期 / HEAD」。
- [ ] **Step 6**：提交 `docs: register the css surface audit and close its tasks`。

---

### Task 8（可选 · 需你决定是否立项）：把「同特异度踩踏」这一类从「没审」变成「有门」

**为什么值得单独立项**：它是本仓库唯一反复出事的隐性类别，而现有 CI 与探针对它零覆盖；本次只能给到线索级。

**Files:** Create `scripts/probes/cascade-conflict-probe.mjs`（原生 CDP，复用 `scripts/cdp-probe.mjs` 的 `createCdpClient`）

- [ ] **Step 1（设备）**：起 390×844 触摸仿真页面（`Emulation.setTouchEmulationEnabled`），等到 `[data-mobile-nav="frame"]` 与 `[data-phase="active"]` 同时在场。
- [ ] **Step 2（取元素）**：枚举移动分支下所有可见元素（`elementFromPoint` 网格采样 + 关键 marker 清单并集，避免全树遍历开销）。
- [ ] **Step 3（取 matched rules）**：对每个元素调 `CSS.getMatchedStylesForNode`，收集 `matchedCSSRules`；对同一 (属性, 取值) 只看**胜出**的那条。
- [ ] **Step 4（判定）**：挑出**被压掉的声明中，特异度 ≥ 胜出者**的那些 → 即「不是输在弱，而是输在顺序」的踩踏候选。优先级：特异度相等（纯顺序决定，最脆）> 被压掉者更强（说明有 `!important` 参与）。
- [ ] **Step 5（过滤噪声）**：排除同一声明块内的自然后写覆盖（`vh`→`dvh` 兜底对）、排除 `:hover`/`:active`/`:focus` 伪类（非默认态）——前者在白名单里，后者留给 Step 6。
- [ ] **Step 6（状态矩阵）**：把 Step 1–5 在 8 个状态各跑一遍（抽屉开/合、files 面板开/合、menu 开、sheet 开、流式中、iOS 标记 on/off），只有**跨状态稳定**或**仅在某一状态出现**的分别归两类。
- [ ] **Step 7（产出）**：写一份「元素 → 被压掉的声明 → 压它的规则（模块:行 + 特异度）」清单，交给人工判定是**故意覆盖**还是**事故**；故意的在 `pitfalls.md` 记一条，事故的进 §1 变成新发现。
- [ ] **Step 8**：`DSH_PROBE_SESSION_ID=… node scripts/probes/cascade-conflict-probe.mjs` 跑通，把断言数写进 AGENTS.md 探针清单（注意 AGENTS.md 只有 527 B 余量，需同时搬走等量叙述）。

**风险**：Step 2 的采样策略决定覆盖率；全树遍历在大型会话上会超时，必须用 marker 清单 + 网格采样的并集（这是一个「采样而非穷举」的近似，`ponytail:` 上限：漏掉冷门元素；升级路径=对 marker 清单做全量、其余靠网格）。

## §3 待用户拍板

### D-1（原 D3）· Android 上这两条 16px 规则留不留？—— **已执行（选项 A，2026-09-16）**

`misc.css.ts:113-116` 与 `:125-129` 把 `[data-question-key] [class*="_customInput"]` 与 `[class*="dsfv-search-input"]` 抬到 16px，但**不带 iOS 门控**，与同文件 L146–148 的「Android 与桌面保持紧凑 13px」相矛盾。

- **实测依据（2026-09-16，逐行核对源码）**：这两条的靶子都是文本 `input`/`textarea`，而 iOS 通用网（`html[data-mobile-nav-ios] input:not(...)` / `textarea` / `[contenteditable]:not(...)`）**特异性更高且同为 `!important`**——网是 (0,2,2) 量级（`html`+属性+类型+一个 `:not` 参数），这两条是 (0,1,0)/(0,2,0) → **在 iOS 上它们本来就完全被盖住，是死规则**。也就是说：它们今天唯一的实际作用就是「Android 上把这两个字段从 13px 抬到 16px」，而那正是与本文件 `:147-148`「Android 与桌面保持紧凑 13px」相矛盾的部分。
- **选项 A（推荐）**：加 `html[data-mobile-nav-ios]` 前缀，与 L168–174 的既有体系合一（iOS 行为逐字节不变——那边本来由网负责）。iOS 行为不变（那边本来也被 L168 覆盖），Android 回到 13px，声明与实现一致。
- **选项 B**：承认 Android 就是要 16px，改掉 L146–148 的说法（并把这两条从「iOS 反缩放」标题下移出来）。
- **选项 C**：不动，只加注释说明这是有意的例外——**不推荐**：这正是下一轮审查会再次报同一条的原因。

**影响面**：选项 A 会让 Android 上这两个输入框从 16px 回落到紧凑的 13px（iOS 不变——那边本来就被 L168 起的门控规则覆盖，故这两条在 iOS 上确实冗余）；选项 B 只改注释、不动像素。第三方案不是「等价改动」：它是把矛盾留在代码里。

### D-2（原 A4）· `layout.css.ts:187` 的特异度平局怎么办？

- **选项 A**：给插件那条再加一个匹配器（如 `:has(> …)`）把特异度提到 (0,5,0)，让「压过宿主」变成结构性事实。
- **选项 B**：接受平局，把注释改成「当前依赖注入顺序（插件样式表后注入），宿主若改注入顺序会翻转」。
- **推荐 B**：A 会引入一次未经验证的特异度加码，而这条规则目前工作正常；B 只需诚实记录风险。

### D-3（F1）· 死代码是删掉还是把文档改口？

- **选项 A（推荐）**：重新删除（2026-09-14 用户已批准过一次，删除理由仍成立：3 处写、0 处读，每帧 flush 白跑一次 `getComputedStyle`），并在同一次提交里重建 lib —— 即 Task 6。
- **选项 B**：保留代码，把三处「已删除」改口为「仍存在且无读者」。**不推荐**：留着每帧的无效计算，且下次还会有人上当。

### D-4（新，2026-09-16）· 把结构检测器接进 `test:core` 吗？—— **已执行（选项 A，2026-09-16，`bcd8167`）**

Task 0 落库时写的是「暂不接进 `test:core`：接入即在 16 fatal 上变红，等 T1 之后再说」。**T1 已完成，检测器今天 0 fatal / 2 info、退出码 0**（2 条 info 是计划预期的 dvh 兜底对与 E2），这个「再说」到期了。**已按选项 A 落地**（`tests/css-structure.test.ts`，提交 `bcd8167`）：断言 `4 modules` + `0 fatal`（模块数断言防「找不到文件却报 0 fatal」的空转）；反空转红队＝把 MODULES 塞一个不存在的模块得到 exit 1，随后逐字节还原；`test:core` 121/121。以下为当时的选项记录：

- **选项 A（推荐）**：`tests/` 加一个小测试——spawn `node scripts/css-structure-check.mjs`、断言退出码 0——把「0 fatal」变成回归门。代价：测试文件 17 → 18，README 与 AGENTS 的计数条目两处同步（AGENTS 自己那条「计数条目必须两处同步」的教训就是这么来的）。
- **选项 B**：不接，检测器保持手动跑（AGENTS「维护入口」与本文件都已列它）。代价：T1 修的 16 条 fatal 将来无人守——缩进错位、重复媒体查询、同选择器拆分可以无声回归，而这正是本轮开头那 16 条 fatal 的成因。
- **选项 C**：只在 CI 里加一步，不进 `test:core`。**不推荐**：`fix/*` 分支不触发任何 CI（见「维护入口」），等于本地仍然无门。

### D-5（新，2026-09-16）· 两条跨插件顺序依赖：结构化修掉，还是登记为有意依赖？—— **已执行（选项 A，2026-09-16）**

T8 的探针实测出 2 条 plugin-involved 的 order-tie（双方**同特异度、同 `!important`**，只靠样式表顺序分胜负），对手都是第三方 `@linxin666/dsh-web-all` 注入的样式表——**不是宿主**：宿主树里根本没有 `data-dsh-frame` 这个字面量，那条规则原文（`pointer-events: auto; display: inline-flex !important;`，media `max-width:768px`）在它的 `lib/client.js` 里；探针的外来表标签是启发式的（按表文本里的特征选择器取名），读的时候别当成宿主作者。

| 属性 | 我们的赢家 | 若顺序翻转的机械后果 |
|---|---|---|
| `grid-template-columns` | `layout.css.ts:63` (0,1,0) `minmax(0,1fr) 0 0` | frame 回到单轨，抽屉两条 0 宽轨消失 |
| `display` | `layout.css.ts:199` (0,4,0) `none` | dismiss-shadow 变回 `inline-flex` + `pointer-events:auto` 的**可见盒** |

- **实测依据（2026-09-16，读源码 + 探针逐元素结果）**：`:199` 那条规则**只有一条声明**（`display: none !important`）→ 提权零波及面；`:63` 那条有 4 条声明（`box-sizing` / `position` / `grid-template-columns` / `padding-top`，全 `!important`），但探针在 frame 这个元素上（四场景唯一那个元素）只发现 `grid-template-columns` 一条同特异度竞争 → **提权在今天不改变任何计算结果**，只是把「今天已经赢来的胜利」写死。
- **选项 A（我的建议）**：结构化修掉——给这两条规则加前导元素选择器（如 `html `），特异度升到 (0,1,1)/(0,4,1)，从此与顺序无关；随之**白名单清空**，探针变成零白名单的纯回归门。代价：这两条规则内**所有**声明一起提权（理论上只会让更多同特异度的对手让位，但仍须重跑探针 + 相关回归，约一轮）。
- **选项 B（本轮现状）**：登记为有意顺序依赖（白名单 2 条，理由已写进探针源码）。代价：`dsh-web-all` 是 `^` 版本范围且会重新注入样式，顺序一旦翻转，症状是「影子变成可见盒」；探针**会**把它报成 CANDIDATE（自失效已实测，见状态表 G 行），但它只在有人手动跑探针时才说话——没有 CI 兜底（`fix/*` 分支不触发 CI，见「维护入口」）。
- **不做的事**：不要把 `data-plugin` 当来源过滤器去改探针（宿主加载器会给所有尚无该属性的 `<style>` 盖章，见 §6.6）。

---

## §4 过程记录：这次审查的仓库为何一直在动

1. **21:44**：审查进行中，`layout.css.ts` 从 1130 行变成 1117 行。丢失的未提交内容：`layout.css.ts` 的字体轴改动、`phone-chrome.ts`、`src/index.ts`，以及**被删除的未跟踪文件** `src/client/effects/session-row-fiber.ts`、`tests/session-row-fiber.test.ts`、`tests/host-parity.test.ts`。`git stash list` 为空，`git reflog` 只有一次分支切换。
2. **21:48**：分支变为 `fix/50-52-49-verified`，新提交 `a7c4c97` 把在飞工作一并提交（理由：已提交的 AGENTS.md 超 65536 B 预算会让干净检出挂在 `test:core`）。**四个 CSS 文件 sha1 未变**，故本次审查的 CSS 结论与行号全部有效。
3. **同会话内 AGENTS.md 被替换 ≥2 次**（内容互斥：一处说 `effects/` 的 `../` import 禁用，另一处说该禁令已证伪；测试/文档计数也在 13/14、6/7 之间摆动）。**结论：不要把 AGENTS.md 当作比代码更新的真相源**，冲突时以源码 + 探针为准，并把冲突登记到本文件。
4. **F1 是同一模式的第三次**：文档声称已完成的改动，实际没有落到提交里。

**给下一次审查的开工动作（三条，缺一不可）**：
1. `sha1sum src/client/styles/*.css.ts` + `git rev-parse --abbrev-ref HEAD` 记下基线；
2. `node scripts/css-structure-check.mjs` 看结构门是否仍为 0 fatal；
3. 重跑 §0.2 命令 3，确认 F1 没有回归。

---

## §5 未验证 / 不覆盖（诚实清单）

- **像素级视觉结论一律未验证**：本次没有起真机/探针。A1、A2、A3、C1–C4 的「零行为变化」是**基于 CSS 语义的推理 + 引擎 A/B（仅 A2、E1）**，不是端到端实测。涉及删除的条目（A3、C1、C2、C4）建议在合并后跑一次 `pnpm smoke:cdp`（主探针 32 断言，3 项预存失败已写成机读基线，看 SUMMARY 的 `new` 字段）。
- **A4 的特异度结论**来自 `docs/audits/2026-09-13-0.1.5-region-audit.md` 记录的宿主值 + 插件侧计数，未在活页面上用 `document.styleSheets` 递归核验。
- **D3 在真机 iOS 上的实际效果未测**（本地 headless 的 `detectIosWebKit` 恒 false，`cdp-zoom-probe.mjs` 只覆盖到标记与字号的可计算层）。
- **未审查**：`lib/` 生成物、`scripts/` 下探针的 CSS 断言、第三方包内的样式表。
- **最重要的一条**：本次**没有**系统审查「跨模块同特异度踩踏」这一类隐性 bug（见 §1 G 类）。静态扫描只能给线索（63 组候选里绝大多数是假阳性），定性必须靠运行时逐元素 `CSS.getMatchedStylesForNode`——那是 Task 8。**不要把「本次审查通过」读成「这一类也干净」。**
- 检测器本身**不覆盖**三类问题：语义冗余（C1/C2 那种「条件被包含」）、注释与实现是否一致（C4/D1/D2）、特异度平局（A4）——这三类必须人工判断，检测器只负责结构。

---

## §6 追加审查：2026-09-16 六向并行只读审查

起因：§1 的 A–F 是**静态可得**的那一类，§G 当时诚实登记为「未审」。2026-09-16 用六个互不重叠的只读 agent 补审，每个带同一份上下文包（`docs/audits/2026-09-16-parallel-review/00-context-brief.md`），硬约束＝**不改仓库、不跑 build、不起 chromium、不派子代理**，报告先写 `~/tmp` 再落库。落库报告见同目录。

| 报告 | 方向 |
|---|---|
| `B-effects.md` | `src/client/` 运行时 JS/DOM：marker 写读差集、disposer/observer/timer 配对、pointerup/click 时序、异常吞没 |
| `D-coverage-gaps.md` | 测试与探针的覆盖盲区：「改了会静默坏」清单 + 「断言断在 bug 本身」实证 |

（文档-实现漂移、宿主契约、生成物一致性与静态 CSS 残余四路由另派，报告落同一目录。）

### §6.1 新发现与处置

| 编号 | 发现 | 处置 |
|---|---|---|
| J1 | `overlay-backdrop-fab.ts`：`fadeHook` 只在**工厂体**里赋值一次，而 `core.deactivate()` 每次 MOBILE_QUERY 翻转都对每个 task 跑 `dispose()`（`reconciler-core.ts:146-158`），重新激活只跑 `ensure()`（`:139-143`），而 `registerReconcileTasks` 只被 `index.tsx:169` 调一次 → **第一次跨 1023px 之后遮罩渐隐永久失效**（收抽屉时遮罩直接消失）。全仓无测试/探针覆盖 `fadeOverlayOut` | **已修**（`4e6a45e`）：改为在 `ensure()` 里重新武装，并在注释里写明为什么不能在工厂体 |
| J2 | ~~`base.css.ts:70` 的 `[data-mobile-nav="delete-confirm"]` 没有任何写方~~ → **2026-09-16 复核：此发现不成立，撤回** | **已证伪（无 bug）**。证据：①裸字面量 `data-mobile-nav="delete-confirm"` 在 `src/` 与 `lib/client.js` 里各出现 **0 次**——它既不是选择器也不是写方，不存在「死规则」；②`base.css.ts:70` 实为 `[data-mobile-nav="delete-confirm-title"]`，有写方（`session-menu.ts:185`）；③把四个 CSS 模块里全部 18 个 `data-mobile-nav` 选择器与全部 20 个 JS 写方做集合差：**有选择器无写方 = 0**。卡片本体是白底底部弹层（`base.css.ts:123`），红色只在标题文字色（`:67`，活的）。**教训**：审查结论也要过「选择器真的存在吗」这一关，否则会有人照它去删一条活规则 |
| J3 | reconciler 的 `MutationObserver` 未开 `characterData`，与 AGENTS.md「stats-line 因 TPS 是 characterData 文本变更而保持 `scopes:['*']`」相矛盾 | **未复现**：流式期大概率有别的 mutation 陪伴而掩盖。报告里写了构造验证法；**不改代码**（改了没有可证收益） |
| J4 | `gesture-guard` 的 `consumed` Map 对 DOM 节点持强引用、只在节点再次进入某次 click 祖先链时才删过期项 → 长会话单调增长并保留已卸载子树 | 低危（无功能错误）。可换 `WeakMap`；**未做** |
| J5 | `settings-toolbar-reparent.ts:12` 用**裸后代** `[class*="_header"]` 找锚点——正是仓库禁止的那条子串（CSS 侧已锚定到 `> [class*="_nav"] > …`）。当前安全只靠**文档顺序**（工具栏头在卡头之前） | 线索：活页面一条 `compareDocumentPosition` 即可判定；`plugin-card-header-bleed` 探针抓不到这个退化 |
| J6 | `stats-line.ts` 的 TPS 归还循环**以 marker 为索引**，marker 被自身 stale 分支摘掉后（慢路径又没重新标记）归还整体跳过 | 线索：需构造时序。最坏＝桌面态少一行 TPS |
| J7 | C3 的那三处「同选择器拆成两条规则」**未合并**：计划称「纯整洁、零行为变化」，但合并只有在证明两条之间的规则不会插队后才成立（同选择器拆分正是靠中间规则插队才成为经典陷阱） | **留作待办**，不当作已完成。检测器仍把它们列为 3 条 info（5 info 而非计划预期的 2） |

### §6.2 覆盖面：D 报告的结论

**最高危的一条**：`MOBILE_QUERY` 的 `(pointer: coarse)` 臂与 `misc.css.ts` 隐藏块的 `(pointer: fine), (pointer: none)` 臂**没有任何场景覆盖**——全部 CDP「桌面」场景都是 ≥1024px，宽度臂自己就能全隐藏，所以**删掉任一侧指针臂，全套门仍然绿**。根因是 `scripts/cdp-probe.mjs:159` 的 `setViewport(w,h,mobile)` 把 mobile 同时喂给 deviceMetrics 与 touchEmulation，**结构上无法表达「窄视口 + 鼠标」**——这正是 2026-08-30 已经泄漏过一次的 PC 泄漏形态。可跑判据：`D-pointer-guard-gap.mjs`（P1 绿＝守卫本身是精确补集；P2/P3 红＝scenes=33 而 narrow-mouse=0）。

其余缺口（aionui 整条集成零门、`subagent-chip-touch.ts` 零门、预览全屏按钮零门、`data-mobile-nav="stats"` 标记与 TPS 折叠零门、theme-color meta 零门、`dismiss-shadow` 零门、git-chip 被 `EXPECTED_FAILURES` 基线豁免、backdrop 渐隐零门、隐藏块清单无机械门、检测器未接进 `test:core`、debug 徽章与 `/diag` beacon 零门）逐条见 `D-coverage-gaps.md`。

### §6.3 对 §5「诚实清单」的修订

- G 类（同特异度踩踏）**已从「未审」变成「有门」**（2026-09-16，T8）：`scripts/probes/cascade-conflict-probe.mjs` 在真实级联上按元素取证，带正对照（证伪空转），验收绿。但门只覆盖 390×844 coarse 的四场景——**不是全状态、全视口的结论**（缺口见状态表 G 第二行）。A–F 依然是「静态可得」的全集，**不是**「隐性 bug」的全集。
- 新增一条基础教训：**本地那条 `git add lib && git diff --exit-code lib` 是假门**——它比的是 index ↔ 工作区，`git add` 之后恒绿，源码没提交也能过。2026-09-15 的两个提交就是这样只装了 `lib/`（源码留在工作区，等价于 HEAD 在干净检出下过不了自己的 CI），已由 `232cc26` 补上源码。正确写法见 §2 Global Constraints。

---

### §6.4 A 向：静态 CSS 残余（`A-static-cascade.md`）

A 先修掉了上一轮脚本的两处系统性误差——分组选择器没拆臂、特异度用正则估（`:has()` 实参被多算）——并用 17 条 W3C 参考例自检了解析器，所以口径从「63 组候选」修正为：**候选对 386 → 按（属性,特异度）归并 31 组 → 两模块同在移动分支且只靠顺序分胜负 41 对 → `!important` vs 普通声明 26 对**。

**选择器文本逐字相同**的跨模块重复只有 3 对，全部可静态定性：

| 对 | 结论 |
|---|---|
| `[data-mobile-nav="drawer-actions"]`（base L35 / compat L471） | 属性不相交，非冲突 |
| `[aria-modal="true"] [class*="_cubeRow"] > *`（layout / compat） | 属性不相交，非冲突 |
| `[data-aionui-explorer-col], [data-aionui-preview-col]`（compat / misc） | **载荷承重**：两者同 (0,1,0) 且都 `!important`，平板档「居中不铺满」100% 靠 misc 排在 compat 之后。A 写了 `order-flip.mjs`：把顺序翻过来就退回铺满 |

第三条是「拼接顺序是行为契约」的第一个**可复现**证据（此前只有 2026-09-06 那条 hero 净空的间接教训）。它值得一条回归门，但**没有现成的门**——检测器不看顺序语义，测试也不看。**未做，登记为待办**。

另三条已验证的注释漂移（与 §1 D-2 同类）：`base.css.ts` 的 delete-confirm 死规则（**已删**，见 §6.1 J2）；`misc.css.ts:204` 注释自称 "higher-specificity full-width rule"，实测与 layout 同为 (0,5,1)、靠顺序赢；`compat.css.ts:34–37` 注释「The per-column rules below override the geometry」在平板档是**反的**（正是上面第三对）。

死声明与兜底：同规则内被后写覆盖**恰好 1 条**（layout 的 vh→dvh 有意兜底对）；8 对 `!important`/普通声明反转**全部**是有意的 reduced-motion/状态覆盖；`env()` 12 处真实调用**全部**带 `0px` 兜底。**未验证线索**：全套只处理 top inset，bottom 只在 FAB 与 dsfv 状态栏出现，composer seat 在真有 home indicator 的机器上会不会被压住从没测过（headless inset 恒 0）。

### §6.5 C 向：文档与实现漂移（`C-doc-drift.md`）

16 条，7 条 P1。**已修 8 条**（`7de13fb`）：手势识别区 `START_ZONE_PX = 48px` / `96px` 三处（两处 CSS 注释 + spec 的「终值」行）、AGENTS 与 pitfalls 的 `touch-action: pan-y` 缺 `pinch-zoom`（**按它改就会复现 #45**）、检测器基线仍写 16 fatal、task 模块归属、components 树漏 `open-files-panel.ts`、悬空 `§探针环境参数（旧）`、实装版本清单 4 项、runbook 的 rev 食谱。

**未修 → 2026-09-16 逐条取证后的处置**（只读取证；四项逐字对源码与实装宿主 bundle）：

- ✅ **已修**（`0d2c308`）`subagent-chip-touch` 的 2000ms/500ms 归属：两个数字实测在 `phone-chrome.ts`——`navObserver` 与 `setTimeout(disarmNav, 2000)` 同处 `armNav()`，`:675` 的 `lastTouchNavAt < 500` 在 document 捕获 click；芯片模块无 MutationObserver，自身窗口是 800/1000ms。已移进「只许一个抽屉 closer 武装」条。
- ✅ **已修**（`0d2c308`）`README.md:151` 的 `maximum-scale` 承诺：它在 `### v2.1.1` 段内，作为该版本历史条目当年为真（`7f39ac0`），但已被 `cb16329` 取代（现写死 `VIEWPORT_CONTENT`、写入永不带缩放锁）——**标注取代而非改写历史**。附带更正：viewport 所有权由 `scripts/cdp-zoom-probe.mjs` 的 A8–A10 守；`tests/ios-zoom-guard.test.ts` 的 5 个 test 全是引擎判定 / 16px 下限 / touch-action，**不断言 viewport**。
- ✅ **已修** 调试地图（本地不入库，126→134 行）：基线包名换代（`dsh-web-all` 0.3.20 / `dsh-client-ui-market` 0.3.20）、三条哈希归属更正（`VOzbGW_`→官方 settings-general、`hHd-Xa_`→官方 sidebar、`pI_x6G_`→官方 layout；**两棵树都搜才判得准**——只搜 profile 会得 0 命中而误判「哈希消失」）、§4 两行后缀式改回源码实写的子串 + frame 域，并加复核块说明市场 UI 当前未启用、§2/§4/§6 市场段无处对账。
- ⏳ **排队（须浏览器，排 T8 之后）** `scripts/cdp-probe.mjs:544` 的 `[class$="_card"]`：原文逐字属实，基线吸收也属实（该条无 `includes` ⇒ detail 变了仍记 BASE、`new=0`）。**两项新增发现**：①宿主 `uV2eYG_card` 是**两态** class——`workspaceTrigger` 为真时拼成 `uV2eYG_card uV2eYG_cardWorkspaceTrigger`，后缀**必失配**（`[data-composer-card]` 是稳定替代，仓库已在用）；②同一行的锚点 `querySelector('textarea')` **也已换代失配**（0.1.5 composer 是 Lexical，会话包内 `textarea` 零命中，页面上能取到的 textarea 来自别的包）。两处一起换，再跑一轮决定该基线条目是否加 detail 约束。
- ⏳ **待浏览器复核** `layout.css.ts:938-942`（≤359px 对 `[class*="_label"]:has(> svg)` 施加 `display:none`）与 README/AGENTS「模式名保留文字」的矛盾——C 自己标了未验证，无浏览器同样无法定论。

### §6.6 E 向：宿主契约与第三方（`E-host-contracts.md`）

27 条。**最有行动价值的三条**：

1. **26 条哈希契约里 8 条上游已 0 命中**（`qDHVXG_` / `gdEzaW_` / `bpnj3G_` / `jmhvDG_` / `_dialog_15u5s_22` / `eGUBIq_` / `-NprXq_`）；其中 **5 条非 lazy ⇒ `node scripts/cdp-compat-contracts.mjs` 今天应 miss=5 / exit 1**。有替代物（`_dialog_15u5s_22` → `_dialog_w1urq_22` 同一 Dialog 原语 rehash；`qDHVXG_headerActions` → `wSkVaW_headerActions`；`gdEzaW_bubble` → `Sixlwa_bubble`）。（E 的语料是宿主 bundle + profile，**按 realpath 排除了本仓库**——第一版没排导致假 HIT。）
2. **契约探针的 hash 判据可自满足**：它做文本扫描，而 `document.styleSheets` 含插件自己注入的样式表。**2026-09-16 复核后这条要改写对策**（E 的原理对、给的修法对不上现行代码）：

   - 现行 `scripts/cdp-compat-contracts.mjs` 的 `SCAN_TEXT_EXPRESSION`（:128–141）是 `collect(document.styleSheets)` **无条件全收**，没有任何来源过滤；判据 `scanText.includes(contract.needle)`（:252）。所以**自满足向量是「我们自己的 compat 选择器里写着目标哈希」**（`[class*="qDHVXG_"]` 这类字面量就活在注入样式表里）——上游把该 class 删了，探针照样报 hit。
   - E 提的「先把 CSS 注释剥掉」对现行判据是**空转**：它扫的是 `rule.cssText`，而 cssText 本来就不含注释（注释只在源串/`textContent` 里）。剥注释只对「按源码文本扫描」的写法有意义。
   - **不要用 `data-plugin` 当「插件注入」的过滤器**：宿主加载器会给*所有*尚无该属性的 `<style>` 盖章——见 `@deepseek-ai/dsh-client-modules/lib/client.js` 的 `for (const el of document.querySelectorAll("style:not([data-plugin])")) el.setAttribute("data-plugin", id)`。宿主 UI 模块走同一注册路径（id 形如 `@deepseek-ai/dsh-client-ui-*`），所以宿主样式表**也带 `data-plugin`**；按它过滤会把宿主证据一起丢掉，门从「恒真」翻成「恒假」。
   - 可行的收窄（待 T8 释放浏览器后 A/B 验证）：只排除**本插件 id**（`data-plugin="dsh-web-mobile"`）的样式表，或把 CSS 文本一路降级为辅助信号、以 DOM className 为主判据（触发条件性 UI lazy 的条目仍走 `lazy`/`skip`）。**判据要先量 hit/miss 变化再定**：改完必须回答「26 条里有几条从 hit 翻成 miss、翻的是否正是 E 那 8 条 0 命中的」，否则等于换了个方向的门。
3. **死规则 7 处 + 活着的过匹配 4 处**：`[aria-modal="true"] [class*="_tabs"]` 完全没有 owner 限定，上游 8 族连同宿主自己的 tabs 一起被强制 wrap+8px；`irow` 族后代片段（`spec`/`nm`/`grow`/`switch`/`owner`）**无 owner 限定**，复活后误伤不受控。

**未做**：E 建议「跑一次 `cdp-compat-contracts.mjs` 以真实 hit/skip/miss 推翻或确认整张表」——需要活浏览器，与 T8 探针冲突，**排在 T8 之后**。

### §6.7 F 向：lib ↔ src 一致性与脆弱点（`F-lib-parity.md`）

**结论：当前一致，且是三条独立路径（从 src 重算闭包 / 真 tsc 编译 / 回放 build-client 逻辑）互证的**——27/27 模块集合相等、CSS 四条腿逐字节一致（两侧 `new Function` 求值后比字符串，避开转义假阳性）、31 d.ts + 31 map 文件集精确相等、`npm pack --dry-run` 108 项含 `lib/client.js`、`import('./lib/index.js')` 通过。F 还纠正了一个陷阱：`lib/types/**/*.css.d.ts` 把非 ASCII 转成 `\uXXXX` 而 bundle 是字面 UTF-8，**直接字节比对会假报漂移**。

四条结构性洞（前两条已进 Global Constraints）：

- **F-6 门禁看不见 `lib/` 下的未跟踪文件**：干净 clone 里植入孤儿产物后 `git diff --exit-code lib` 仍 exit 0，`git add lib` 之后也是 0；而 **tsc 从不清理 outDir**，删源码会留下永久孤儿。补法：`git status --porcelain --ignored lib` 必须为空。
- **F-7/F-8** 见 Global Constraints 与 §6.3。
- **F-10** `lib/client.js` **没有 sourcemap**（build-client.mjs 显式删），而 host 半区 3 个 `.js.map` 全发货——最大的出货文件不可回溯。
  - **2026-09-16 修正（结论保留，说法改准）**：磁盘上确实没有 `lib/client.js.map`，但**服务端会合成并 200 返回一个 map**（396744 B，index map：1 个 section、累计 `sources` 1 个、mappings 34924 字符）——那 80 字节 `sourceMappingURL` 尾巴是加载器加的，不是 bundle 自带。要害是它的 `sources` 只有 `/plugins/dsh-web-mobile/client.js` **它自己**：devtools 拿到的是「bundle 映射到 bundle」的退化 map，**无法回溯到 `src/`**。所以 F-10 的结论（最大出货文件不可回溯）成立，但「没有 sourcemap／devtools 拿不到东西」的说法不准确；排查时也别拿那 396 KB 的响应体去反推源码。
- **F-11** CSS 占 bundle **37.0%**（130812/353082 B；2026-09-16 复核 131965/352521 B ＝ **37.4%**，量级一致），src 里已有的 CSS 被整份复制一遍；顺带修正了本文件与 AGENTS 的「client.js≈2 万行」旧读数（实测 7003 行 / 353082 B / 27 模块）。

**F 主动声明未取证的一条**：served bundle 的字节前缀判据它没做成（cookie 过期 → 组合 URL 返回空 body，正是 `da39a3ee5e6b` 那个别误判形态）。这条链路 **F 不下结论**，本文件也不据此改动。

> **2026-09-16 已补齐**（`4223fe5`）：空 body 的真因不是 cookie，而是 **URL 里的 `rev` 必须是 shell HTML 的当前值**——自造的 `rev=probe`、全零或过期值一律 404 空 body，外观与「插件没被服务」完全相同（这正是当初误判的入口）。取当前 rev 后判据成立：HTTP 200，总 **352601 B ＝ `lib/client.js` 352521 B ＋ 80 B `sourceMappingURL` 尾巴**，前缀 sha1 **`2dfc5c027bd6`** 与本地文件逐字节相同。链路另外两环也已实测：profile 用 `link:` 装本仓库（`~/.dsh/profiles/web/node_modules/dsh-web-mobile → ../../../../dsh-mobile-nav`）、本仓库 `lib/` 与 HEAD 逐字节一致（干净导出重建：69 文件全同、0 孤儿）。**至此「浏览器跑的到底是哪份代码」在无浏览器条件下也可判定**，AGENTS 与 pitfalls §① 已同步食谱。

---

## 附录 A：`scripts/css-structure-check.mjs`（已实测，sha1 `b2fd5b9141914e9350ab8e79e72ad2a991b03f73`）

设计要点：单趟解析模板字面量→记录每个块的嵌套深度与选择器首行行号（**多行选择器按首行判定**，这是 layout 那两处合规写法的前提）；行号已按模板起始行做了偏移，输出**就是 `.css.ts` 的真实行号**；fatal 决定退出码，info 只提示。刻意不做的事：不判定语义冗余、不比对注释——那三类留给人工与探针。

```js
// Structural checks for the four concatenated CSS modules.
//
// The repo has no linter and the CSS lives in TypeScript template literals, so
// these defect classes survive every existing gate (verify / test:core /
// docs-consistency): indentation that lies about nesting, declarations that can
// never apply, and blocks that escaped the mobile media query.
// node:builtin-only.  Usage: node scripts/css-structure-check.mjs
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = process.env.CSS_STRUCTURE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULES = ['base', 'layout', 'compat', 'misc']

// Top-level at-rules that are legitimate in a module. Anything else must sit
// inside the mobile query, or it applies to desktop too.
const TOP_LEVEL_ALLOWED = [
  '@media (max-width: 1023px) and (pointer: coarse)',
  '@media (min-width: 1024px) and (pointer: coarse)',
  '@media (min-width: 1024px), (pointer: fine), (pointer: none)',
  '@media (pointer: fine), (pointer: none)',
  '@media (min-width: 768px) and (max-width: 1023px) and (pointer: coarse)',
  '@media (prefers-reduced-motion: reduce)',
]

const problems = []
const fatal = []
const info = []
const note = (file, line, msg) => fatal.push(file + ':' + line + '  ' + msg)
const soft = (file, line, msg) => info.push(file + ':' + line + '  ' + msg)

function load(name) {
  const file = name + '.css.ts'
  const source = fs.readFileSync(join(root, 'src/client/styles', file), 'utf8')
  const match = source.match(/=\s*`([\s\S]*)`\s*;?\s*$/)
  if (!match) throw new Error(file + ': no CSS template literal found')
  const css = match[1]
  // Lines reported must be real file lines: the template body starts after the
  // backtick on some earlier line, so shift every report by that many lines.
  const lineOffset = source.slice(0, match.index).split('\n').length - 1
  return { file, css, lineOffset, masked: css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')) }
}

// One pass: every block gets depth + indentation; every style rule also gets
// its raw body and the enclosing at-rule scopes.
function parse(file, css, masked, lineOffset) {
  const lines = css.split('\n')
  const blocks = []
  const rules = []
  const stack = []
  let line = 1
  let buf = ''
  let preludeLine = null
  const newlinesBefore = (from, to) => {
    let n = 0
    for (let k = from; k < to; k++) if (masked[k] === '\n') n++
    return n
  }
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i]
    if (c === '\n') { line++; buf += ' '; continue }
    if (c === '{') {
      const prelude = buf.trim()
      buf = ''
      const frame = {
        prelude, line: preludeLine ?? line, start: i + 1,
        depth: stack.length,
        scope: stack.filter((f) => f.prelude.startsWith('@')).map((f) => f.prelude),
      }
      stack.push(frame)
      blocks.push(frame)
      preludeLine = null
      continue
    }
    if (c === '}') {
      const frame = stack.pop()
      if (frame && !frame.prelude.startsWith('@') && frame.prelude) {
        frame.body = css.slice(frame.start, i)
        frame.bodyStart = frame.start
        rules.push(frame)
      }
      buf = ''
      preludeLine = null
      continue
    }
    if (!/\s/.test(c) && preludeLine === null) preludeLine = line
    buf += c
  }
  if (stack.length) note(file, lines.length + lineOffset, 'brace balance broken at EOF')
  return { lines, blocks, rules, newlinesBefore }
}

for (const name of MODULES) {
  const { file, css, masked, lineOffset } = load(name)
  const { lines, blocks, rules, newlinesBefore } = parse(file, css, masked, lineOffset)
  const fail = (l, m) => note(file, l + lineOffset, m)
  const hint = (l, m) => soft(file, l + lineOffset, m)

  // 1. indentation must match real nesting depth
  for (const b of blocks) {
    if (b.depth === 0) continue
    const expected = b.depth * 2
    const actual = (lines[b.line - 1]?.match(/^ */) ?? [''])[0].length
    if (actual !== expected) {
      fail(b.line, 'indent ' + actual + ', nesting expects ' + expected + ': ' + b.prelude.slice(0, 60))
    }
  }

  // 2. top-level blocks that would apply outside the mobile branch
  for (const b of blocks) {
    if (b.depth !== 0 || !b.prelude.startsWith('@')) continue
    if (b.prelude.startsWith('@keyframes')) continue
    if (TOP_LEVEL_ALLOWED.includes(b.prelude)) continue
    fail(b.line, 'top-level at-rule outside the allowed set: ' + b.prelude)
  }

  // 3. the same property twice in one rule (the first can never apply)
  for (const r of rules) {
    const seen = new Map()
    let offset = 0
    for (const chunk of r.body.split(';')) {
      const decl = chunk.split('\n').map((s) => s.trim()).filter(Boolean).join(' ')
      const at = r.line + newlinesBefore(r.bodyStart, r.bodyStart + offset)
      offset += chunk.length + 1
      if (!decl) continue
      const idx = decl.indexOf(':')
      if (idx < 0) continue
      const prop = decl.slice(0, idx).trim()
      if (seen.has(prop)) {
        // A vh/px fallback followed by a dvh/px line is deliberate progressive
        // enhancement, not a mistake — report it as info so a reviewer can see it.
        const fallback = seen.get(prop)
        if (/dvh|dvw/.test(decl) && !/dvh|dvw/.test(fallback)) {
          hint(at, 'progressive-enhancement fallback pair for "' + prop + '"')
        } else {
          fail(at, 'duplicate property "' + prop + '" in one rule (first value: ' + fallback + '): ' + r.prelude.slice(0, 50))
        }
      }
      seen.set(prop, decl.slice(idx + 1).trim())
    }
  }

  // 4. the same selector declared twice in one scope
  const seenSelector = new Map()
  for (const r of rules) {
    const key = r.scope.join(' && ') + ' ||| ' + r.prelude
    if (seenSelector.has(key)) {
      hint(r.line, 'selector split across rules in one scope (first at ' + seenSelector.get(key) + '): ' + r.prelude.slice(0, 60))
    } else seenSelector.set(key, r.line)
  }
}

console.log('css-structure-check: ' + MODULES.length + ' modules, ' + fatal.length + ' fatal, ' + info.length + ' info')
for (const p of info) console.log('  info ' + p)
for (const p of fatal) console.log('  FAIL ' + p)
process.exit(fatal.length ? 1 : 0)
```

## 附录 B：一条命令复现本次全部证据

```sh
cd ~/dsh-mobile-nav
sha1sum src/client/styles/*.css.ts                        # §0.1 指纹
node scripts/css-structure-check.mjs                      # 0 fatal + 5 info（A1 已清；info = C3 三处 + dvh 兜底 + E2）
grep -rn 'class\$\=' src/client/styles/                   # B1（修完后仅注释命中）
grep -n 'order:3' src/client/styles/layout.css.ts         # A2（应 0）
grep -n '_actions"\] \[class\*="_action"\]' src/client/styles/compat.css.ts   # A3（应 0）
grep -n 'below the host' src/client/styles/layout.css.ts  # D1（应 0）
grep -n 'never edge-to-edge' src/client/styles/misc.css.ts # D2
grep -rn 'data-mobile-nav-gen\|NativeDrawerGen' src/ lib/ | wc -l  # F1（修完应为 0）
git log --all --oneline -S'isNativeDrawerGeneration' -- src/client/effects/phone-chrome.ts  # F1 溯源
```

---

**状态表（执行时逐条改这里，不要新开文件）**

| 条目 | 任务 | 状态 | 备注 |
|---|---|---|---|
| A1 | T1 | **DONE**（`26ca8e9`） | `git diff -w` 只剩「重复 media + 配对 `}`」两行删除；检测器 16 → **0 fatal** |
| B1 | T2 | **DONE**（`acc26ec`） | 两行散文，纯 `$`↔`*`；选择器未动 |
| A2 / A3 | T3 | **DONE**（`e2fa5a1`） | 复核命令 0 命中；A3 是零行为变化的那条 |
| C1–C4 | T4 | **DONE**（`e2fa5a1` + `f1738f1`） | C1/C2/C4 在 `e2fa5a1`；C3 的**两对**在 `f1738f1`（合并前逐对验过中间无同属性规则）；第三对（compat 的 `grow`/`owner`）**故意不并**，见 §6.1 J7 |
| D1 / D2 | T5 | **DONE**（`e2fa5a1`） | 注释按当前事实重写（1300/1250 契约、模态覆盖实际范围） |
| F1 | T6 | **DONE**（`6111603`） | 再检查式改用写入方锚，见 §0.1b |
| A4 | D-2 | 待拍板 | |
| D3 | D-1 | 待拍板 | |
| E1 / E2 | — | 建议加注释 / 可不动 | |
| F2 | — | 流程约定已写进 §0.2 |
| G（同特异度踩踏） | T8 | **有门（2026-09-16）** | `scripts/probes/cascade-conflict-probe.mjs`（原生 CDP `CSS.getMatchedStylesForNode`，390×844 coarse，4 场景 + 正对照，640 行，builtin-only）。独立验收运行（本会话亲跑）EXIT=0：`candidates=0 plugin-involved=0 whitelisted=2 host-only=10 importance-ties=6 model-errors=0 module-lines=exact sampled=271`。2 条白名单＝与本插件与第三方 `@linxin666/dsh-web-all` 注入表的**跨插件顺序依赖**（frame 三轨 grid、dismiss-shadow 的 display:none），处置见 §3 D-5。**白名单自失效已实测**（2026-09-16 红队：把第 1 条的 `winnerWhere` 改到不匹配 → 该候选复现为 `CANDIDATE`、`whitelisted` 2→1、`candidates=1`、EXIT=1；随后逐字节还原）。**注意运行环境**：`DSH_PROBE_SESSION_ID` 必须是完整 UUID（`session-<36 位>`，前缀写法会一直停在 `frame+active timed out`）|
| G（状态矩阵/:has 过匹配/env 兜底） | T8 | **部分审（覆盖缺口已登记）** | 探针只覆盖 390×844 coarse 的四场景（default / drawer-open / files-open / ios-attr）。**未覆盖**：`[role=menu]` 打开态、宿主设置与市场对话框、aionui 探索器·预览 sheet、hero 空态、流式期、子代理 running/idle、第三方插件自身态、tablet 与桌面档、inset≠0。**机制盲区**：inline style 不入模型（手势层 `setProperty(...,'important')` 正在此列）、未激活伪类 CDP 不返回、`@supports`/`@layer` 不区分、24px 网格 ∪ 标记采样会漏极小或被覆盖元素。采样量 run 间浮动（host-only 10↔11），故「某次跑绿」≠穷尽 |
| H（第三方上游 CSS / lib 一致性 / 动效时序） | — | **未审** | | |

---

## §7 完整修复链（2026-09-16 立项 · 一条链，按依赖排序）

**为什么是这个顺序**：这一轮反复撞到的根因不是「有 bug 没修」，而是**结论没有门**——修好的东西可以无声回归，没修的东西没人知道谁在守。所以链的顺序是「先把门弄可靠 → 再用门兜着改行为 → 最后清理低危项」，而不是按严重度排。

每一环都带：根因 → 改法 → 验证（含**反空转**：故意破坏必须变红）→ 回滚 → 交付。**未完成的环不写「已完成」**，只写状态。

### L1 · 把结构检测器接进门 —— ✅ 完成（`bcd8167`）
- **根因**：检测器写好了、判据齐全、退出码语义正确，`package.json`/CI/所有测试文件**都不调用它** → 它存在的意义（缩进错位、重复媒体查询、选择器拆分）可无声回归。
- **改法**：`tests/css-structure.test.ts` spawn 检测器，断言 `4 modules` + `0 fatal`；AGENTS 两处计数 17→18（字节数不变）。
- **验证**：反空转红队＝把 `MODULES` 塞一个不存在的模块 → exit 1；还原后逐字节一致。`test:core` 121/121、`verify`、`build`、lib 与 HEAD 一致。
- **回滚**：删该测试文件即可（无源码依赖）。

### L2 · 门的地基：把锚点换代（需浏览器）—— **已发现第 3 个过期锚点：`cdp-zoom-probe.mjs` 的 composer 卡**（A3/B3 在本机 headless 恒红，A/B 证实与代码改动无关；选择器 `(?:)…:has(textarea)` 在本环境 0 命中），修它时必须同时确定「当前代 composer 到底渲染成什么」（textarea 还是 Lexical contenteditable + mirror/backdrop）
- **根因**：`scripts/cdp-probe.mjs:544` 的两个锚点都已换代——`[class$="_card"]` 在宿主里是**两态 class**（`workspaceTrigger` 为真时拼成 `…_card …_cardWorkspaceTrigger`，后缀必失配），同行的 `querySelector('textarea')` 在 0.1.5 Lexical composer 上**零命中**；`cdp-compat-contracts.mjs` 的自证也来自「文本扫描把插件自己的样式表算进去」。
- **改法**：换 `[data-composer-card]`（稳定 marker，仓库已在用）+ Lexical 编辑面 marker；`SCAN_TEXT_EXPRESSION` 排除本插件注入的表；`layout.css.ts:938-942`（≤359px 隐藏 `_label`）与 README「模式名保留文字」的矛盾用浏览器判定后择一改。
- **验证**：主探针 `SUMMARY base/new` 中 `new` 不得上升（基线条目 detail 变化仍归 BASE 是有意的）；契约探针改判据前后跑一次，比较命中/漏判差值；`≤359px` 那条以 359px/360px 两档截图或几何断言定论。
- **回滚**：探针改动只影响探针文件，单提交可撤。

### L3 · 补最高危的零覆盖：指针臂场景 —— ✅ 完成（2026-09-16）
- **根因**：`cdp-probe.mjs:159 setViewport(w,h,mobile)` 把**宽度与指针耦合**在同一参数上，结构上无法表达「窄视口 + 鼠标」——于是 `MOBILE_QUERY` 的 `(pointer: coarse)` 臂与 misc 隐藏块的 `(pointer: fine)/(pointer: none)` 臂**没有任何场景覆盖**：删掉任一侧指针臂，全套门仍然绿（2026-08-30 已泄漏过一次的形态）。
- **改法**：把两个维度拆开（`setViewport(w,h)` + 独立的 `setPointer(client,'coarse'|'fine')`，后者走 `Emulation.setTouchEmulationEnabled`——`setEmulatedMedia` 对 pointer 特征无效）；新增「390×844 + pointer:fine」场景，断言插件零干预（frame 不出现、注入控件不在、移动规则 `matches=false`）；反向「≥1024px + coarse」可仿 session-delete 的 16a–16d。
- **验证**：反空转红队＝**故意删掉 JS 的 coarse 臂或 CSS 的 pointer 臂，新场景必须变红**；再跑一遍全场景确认没有回归。
- **回滚**：新场景独立于既有场景；`setPointer` 拆维度后旧调用点补默认值即可退回。

### L3 的落地与实测（2026-09-16）
- **新场景** `desktop.narrow-mouse-no-op`：390×844 + 非粗指针（关触摸模拟）。断言四件事同时成立——宽度条件命中（`(max-width: 1023px)` 为真）、`(pointer: coarse)` 为假、frame 缺席、注入控件不可见。实测输出把它自报为 `mouse=pointer:none`。
- **控制组就是既有场景**：同一宽度 390×844 的 touch 场景（frame 在场、控件可见）——两场景同宽同页，只差指针一个变量 ⇒ 删掉 JS 的 coarse 臂或 CSS 的 pointer 臂，本场景必红而 touch 场景仍绿（不需改源码做对照实验）。
- **实测**：`SUMMARY pass=14 skip=1 fail=0 base=0 new=0 green=false`，EXIT=0，无残留 chromium 进程。
- **`(pointer: fine)` 臂无法用 CDP 覆盖**：headless 报 `pointer: none`，`Emulation.setEmulatedMedia` 与 `--blink-settings=primaryPointerType=4,availablePointerTypes=4` 都试过无效（后者连 headless 都没改观，已从启动参数里撤掉，不留死配置）。该臂改由**结构断言**守：`tests/css-structure.test.ts` 第二条断言把隐藏块钉成 MOBILE_QUERY 的补集（宽度 +1、pointer 覆盖 fine/none 两侧）。
- **两条红队**：①删掉隐藏块的 `(pointer: fine)` 臂 → 该测试红（2 项），且检测器同时报 `top-level at-rule outside the allowed set`（它的 allowed-set 白名单本来就在守这行，L1 接门后才生效）；②把 MOBILE_QUERY 宽度改成 767 而隐藏块不动 → **新断言红、检测器仍绿** ⇒ 这条「两处必须同步」的推导链此前确实无人守（768–1023 带会静默失去桌面侧隐藏）。
- **顺带订正过时计数**：AGENTS 两处与本文档一处写的「主探针 32 断言」实为 14 项（SUMMARY 的 pass+skip）。

### L4 · 行为改动 A：两条跨插件顺序依赖 —— ✅ 完成（D-5 选项 A，用户 2026-09-16 拍板）
- **落地**：`layout.css.ts` 的 frame 规则与 toggle 隐藏规则的每个选择器加前导 `html` → (0,1,1) / (0,2,1)…(0,4,1)，与注入顺序无关；探针 `WHITELIST` 清空（机制保留）。
- **实测（本机独立跑）**：`SUMMARY candidates=0 plugin-involved=0 host-only=10 whitelisted=0 important=0 importance-ties=6 model-errors=0 ALL PASS`，EXIT=0；提权前那两条**不再出现在任何类别**（不是变成 `important`，是彻底消失——赢家仍是我们的规则、值不变）。全场景 `plugin=true` 行数 0 ⇒ 本插件表已不参与任何同特异度判定。
- **反空转**：白名单机制本身此前已红队过（改坏一条 entry → 候选复现、EXIT=1）；本次清空后，若哪天顺序真的再翻，规则没有白名单可吸收 → 直接红。
- **根因**：与第三方 `@linxin666/dsh-web-all` 的注入表**同特异度、同 `!important`** → 只靠样式表顺序分胜负；`display` 那条翻转的症状是 dismiss-shadow 变回可见盒。
- **改法（A）**：给 `layout.css.ts:63` 与 `:199` 加前导元素选择器（如 `html `）→ (0,1,1)/(0,4,1)，与顺序无关；随之**清空探针白名单**，它变成零白名单的纯回归门。**注意探针抓不到「提权后反而赢过头」**（它只报输给同特异度对手的声明，不报「因为特异度变高而新赢的」）——所以验收要另加一步：提权前后各打一次 frame 与 dismiss-shadow 的计算值快照（`grid-template-columns` / `display` / `position` / `padding-top`），必须**逐个相同**。**改法（B）**：维持现状，白名单 2 条（理由已在探针源码里）。
- **验证**：`scripts/probes/cascade-conflict-probe.mjs` 重跑——A 完成后期望这两条不再出现为 order-tie（或转为「靠特异度赢」的 normal 声明），`whitelisted` 归 0；另跑 `order-flip.mjs` 确认顺序翻转不再改变结果。
- **回滚**：去掉前缀 + 还原白名单（同一提交内可逆）。

### L5 · 行为改动 B：Android 16px 门控 —— ✅ 完成（D-1 选项 A，用户 2026-09-16 拍板）
- **落地**：`misc.css.ts` 两条规则加 `html[data-mobile-nav-ios]` 门控（ask composer 的 `_customInput`/`_customTextarea`、file viewer 的 `dsfv-*-input`）；注释同步说明「只在 iOS 需要下限」。
- **新门（本次补）**：zoom 探针加 A11（安卓：这三个字段必须 <16px）与 B7（iOS：必须 >=16px），断言读**注入形状的计算值**而非规则文本 —— 规则在但失效也能抓到。
- **实测（本机独立跑，23 断言）**：新 bundle `A11 PASS {"customInput":13.3333,…} / B7 PASS {…:16}`；**旧 bundle 同一环境 A11 FAIL {…:16}**（= D-1 的病灶本体）⇒ 断言非空转，本次改动可被它证伪。
- **预存红（与本次改动无关，A/B 实证）**：A3/B3 `composer=null` 在旧、新 bundle 上**完全同款**——本机 headless 环境里没有 textarea、也没有可见 contenteditable，探针的 composer 卡选择器 `(?:_card):has(textarea)` 命中不到。归入 L2 锚点换代。
- **根因**：`misc.css.ts:113-116`、`:125-129` 无 iOS 门控地抬到 16px，与同文件 `:146-148`「Android 与桌面保持紧凑 13px」自相矛盾。
- **改法（A）**：加 `html[data-mobile-nav-ios]` 前缀 → Android 回落 13px（iOS 不变，那两条在 iOS 上本来冗余）；**（B）**：改 `:146-148` 的说法承认 Android 也是 16px。
- **验证**：`scripts/cdp-zoom-probe.mjs`（21 断言）必须仍全绿；A 需要**新增一条 Android 断言**（把「第三方 13px 输入框不变」同场景扩到这两个输入框），否则这次像素变更自身也没有门。
- **回滚**：去掉前缀即回 16px。

### L6 · 低危清理（不需要决定，逐个带判定法）
- **J5** `settings-toolbar-reparent.ts:12` 用裸 `[class*="_header"]`（仓库禁止的子串，CSS 侧已锚定）：活页面一条 `compareDocumentPosition` 判「工具栏头是否在卡头之前」；是则改结构锚，否则记录为「当前靠文档顺序安全」。
- **J6** `stats-line.ts` 的 TPS 归还循环以 marker 为索引，marker 被自身 stale 分支摘掉后归还整体跳过（最坏＝桌面态少一行 TPS）：构造时序（摘 marker → 触发归还）后断言 TPS 仍归还。
- **J7** C3 剩 1 处「同选择器拆两条」（irow 那处，checker 仍列 info）：合并前先列出两条**之间**的规则，证明不会插队；能证明才并。
- **J4** `gesture-guard` 的 `consumed` Map 持强引用：可换 `WeakMap`（低危，无功能错误）。
- **验证**：J5/J6 各自一条 live 断言；J7 有 `css-structure.test.ts` 兜底；J4 无行为断言，属有意的延后。

### 链的边界（不在这条链里的事）
- 覆盖率缺口的**其余**部分（aionui 整条、subagent-chip-touch、预览全屏、stats 标记、theme-color、dismiss-shadow、debug 徽章）——它们是「新增门」的独立课题，不在修复链上。
- `gitgraph` 芯片 reparent（被 `EXPECTED_FAILURES` 基线豁免）——独立课题，修好后必须从基线移除。
