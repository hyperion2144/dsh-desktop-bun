# 推进日志

> 按时间倒序（最新在上）。每条：日期 + 做了什么 + 结果/遗留。做完一步就记，别攒到结尾。

## 2026-09-24

- **0.1.7 session-delete bring-up 完成（eaf74e4；#W1 落码 → #V1 diff 审查 → #W2/#W3 修复轮，交接文档在本地 `docs/handover/`）**：
  - 菜单识别去掉 `length===3` 硬卡，改**包含式签名** `rename+fork+(archive|unarchive)`：命中 0.1.7 四项普通行（新增 pin）；**归档行（unarchive 换 archive）不再命中**——#V1 发现 0.1.7 新签名 unarchive 分支使已归档行被注入删除项，而 `resolveSessionId` 的 `!archived.has(id)` 过滤使点击必弹 deleteError（#W2 修复）；blank 新会话行（标题=宿主 `session.new`）跳过注入（0.1.7 blank 行本无 ⋯，`!row.blank &&` 门，守卫属跨代防御，#V1 确认为不可达分支）。
  - 删除确认弹窗按真机反馈重设计（#W3）：居中毛玻璃卡——材质取自宿主 ⋯ 菜单（`rgba(248,249,250,.58)` + `blur(40px) saturate(1.5)`、16px 圆角、hairline+软影），几何取自宿主 Dialog（16px/500 标题、36px pill 按钮、danger 实心主键）；卡片挂进 backdrop flex 容器、target-guarded **点遮罩才关（点卡片不关）**；无独立入场动画（随 backdrop 淡入）。DONE_WITH_CONCERNS 备案：真机观感/backdrop 点击语义变化待 QA 复核。
  - 回归面：探针 15c 期望改「0.1.7 四项宿主菜单+零注入」、16b 期望 items=5 injected=1；`tests/session-menu.test.ts` 增 containment / archived-row / blank-row 契约锚（test:core 185）。
  - chore：`docs/handover/` 进 .gitignore（成员交接文档本地化）；pitfalls §会话删除补 0.1.7 换形段，backlog 会话删除行状态同步。

## 2026-09-08

- **🥉→🥇 会话删除分层摘抄完成（预备式）**：纯核 `src/delete-session.ts`（4c58bc6，fork 原样 + 3 处分代适配：`entry.header ?? entry` 扁平 list 归一、live 门控降级 409 session-busy、`workspace.detachSession?()` 可选链）+ 10/10 单测（fork 7 条逐字 + rc.2 基线 3 条）；宿主路由（95e5839，`POST /api/mobile-nav.session.delete`，405/400/503/200/404/409）；客户端 `effects/session-menu.ts` fork 逐字（f54690a；fork 原文 `n(ns)` 系本仓库 `rg -r` 误读产物，保留 `bind(NS)`；i18n 10 键）+ base.css 弹窗块（d1113a3；**动画名坑**：fork 的 `dsh-mobile-nav-*` 在本仓库是 no-op，已改 `dsh-web-mobile-fade/sheet-in`）+ misc 桌面隐藏块 +3 类。
- **rc.2 抽屉=rail 变体 → 决策 A 预备式收尾**：CDP 实测 390/768px 抽屉无会话行可注入（`qDHVXG_rail`，listArea 恒空；`YDXeBa_sessionRow`+⋯ 菜单只在 ≥1024px 桌面面板）→ UI 在 rc.2 静默、0.1.3 抽屉渲染会话行后自动激活；用户否决 B（全宽注入）/C（抽屉展开面板）。探针 `scripts/probes/session-delete-probe.mjs`（a336c1d）：12 PASS + 1 SKIP，断言 5=升级绊线（0.1.3 上翻红→回 backlog 本行复启 6-13）；桌面 15b/15c 修正为 hover-then-click（行操作钮 display:none 需先 mouseMoved），实测菜单恰 3 项（Rename/Fork session/Archive session）且 `_itemIcon/_itemLabel` 克隆模板齐全、零注入标记。
- **真机破坏性 E2E（一次性脚本，未入库）**：桌面 UI 自建牺牲会话 → 走真路由删除：200 {ok,deleted} + 存储目录整删（跨项目 projectKey 复算命中真实布局 `--data-data-com.termux-files-home-mc-search-skill--/session-*`）；GET 405 / 空参 400 / 未知 404；「刷新后行消失」以行数回归旁证（脚本删了自己正看的会话致 reload 超时=脚本假象，**边缘已记 backlog：删除当前打开的会话时客户端恢复指针需能回落，0.1.3 实机顺带验**）。409 live 拒删仅单测覆盖（实机需 agent 真在跑）。
- **文档收口**：README changelog（结果式）、AGENTS（树/入口/架构/约定/markers/坑/计数）、compat-contracts.json +3 条（workspace-session-row / workspace-menu-item / workspace-group-section，均 lazy）、backlog 本行改 ✅ 已摘（预备式）。

## 2026-09-06

- **重新对账完成（fork v2.6.0/v2.7.0），只分析未合并**（用户指示）：
  - fork v2.6.0：合上游 round 9（PR #41/#43/#44/#45/#46/#47、settings 锚定），**主动删除 compress.ts**（上游已拥有压缩）；fork 独有能力清零至「会话删除」一项。
  - fork v2.7.0：会话删除重写，目标 DSH 0.1.3-alpha.1（未上 npm）：persistence 改 handle 模型后，按公开 `config.root` 复刻 JSONL 布局递归删目录 + 摘工作区账目；核心抽 `src/delete-session.ts`（DI 纯核）+ 7 单测；客户端 `effects/session-menu.ts`（克隆宿主菜单项 + 按标题反查 sessionId + 自绘确认弹窗）。
  - 对照本机 rc.2 实装宿主逐项验证：布局复刻逐字节一致 ✅、`persistence.config.root` 存在 ✅、四个服务名均在 ✅、客户端 ctx.sessions/workspaces 形状兼容 ✅、`_sessionRow/_projectRow` 存在 ✅；**但 `list()` rc.2 返回扁平 SessionHeader[]（fork 按 `.header.id` 读 → 必 500）**、`agents.store/detachEntered` rc.2 不存在（live 注销静默 no-op）→ **v2.7.0 只在 0.1.3-alpha.1 上真正可用，在已发布宿主上装得上删不了**。
  - fork 落后上游：PR #48（composer-keyboard-guard）未同步；两仓 patch 行同 id，不可并存安装。
  - 网络取证：github.com:443/ghfast 镜像超时不可达，raw/codeload/api.github.com 可达 → codeload tarball 全量落地 `~/tmp/fork-src/fork`（保留待合并用）；取证通道已写进 README 接手协议。
  - 评估结论已同步 mnemopi 项目库；README 快照与 backlog 会话删除行已更新。

## 2026-09-05

- **🥈-2 已摘：dsh-file-viewer 全套**（提交 955b69d）：新 `file-viewer-compat.ts`（file-viewer-open-marker task，`[data-conversation-composer-overlay]` 存在即给 frame 打 `data-file-viewer-open`）+ compat.css 106 行（marker 门控的移动布局）+ misc.css 12 行（viewer 输入 16px 防 iOS 聚焦放大）+ sidebar-swipe `takeoverActive()` 并入 file-viewer（左缘横滑让位给 CSV/代码滚动）+ phone-chrome 注册。全部 marker 门控：无 viewer 安装零影响。验证 `.local-tests/file-viewer-probe.mjs` 13/13（注入 viewer 形状：marker 生命周期、8 条 CSS 断言、takeover 抑制边缘滑、移除后手势恢复）。**注意：本机 profile 未装 dsh-file-viewer，注入形状 ≠ 真机**；`dsfv-*` 前缀升级后对账。附带把上一轮并发会话的 layout d.ts 漂移（dual-primary wrap 规则的 build 产物）一并对齐。
- **🥈-1 已摘：composer 集群适配**（提交 e1ea61d）：layout.css.ts 24 处 + misc.css.ts 2 处 `[class*="_card"]:has(textarea)` → `:has(textarea, [data-composer-input])`，另摘 fork 的 misc `[data-composer-placeholder]` 门控 2 条（0.1.2 hero 空状态一行折叠）。**对账澄清：与 PR #47 的排除型不冲突**（#47 作用 `_scroll` 内容规则，本摘作用 `_card` 识别规则）。验证 `.local-tests/composer-cluster.mjs` 11/11：0.1.1 textarea 分支不变（add 28 / send 34 / container-name）、0.1.2 形状 fixture 命中 card 规则、hero placeholder 折叠 28px×3。
- **🥇-3 已摘：三处 textarea 锚点**（提交 3fc6c17）：git-chip-reparent（`querySelector('[data-composer-input], textarea')`）、stats-line（`querySelector('textarea, [data-composer-input]')`，注释同步）、debug badge（`q('textarea, [data-composer-input]')`）。CDP 冒烟（`.local-tests/anchors-smoke.mjs`）：0.1.1-rc.2 宿主上 stats 标记存在、badge composer 字段 true——textarea 分支在新选择器下仍活。
- **🥇-2 已摘：tooltip 残留修复**（提交 190fbbf）：`@media (hover:none),(pointer:coarse)` 内压制 `[data-phase] :is([class*="_bubble"],[role="tooltip"])`。**摘抄时放宽 fork 的作用域**——CDP 实测 fork 原选择器（`_actions` 祖先限定）在我们宿主 0.1.1-rc.2 不命中真实 bubble（挂 `gdEzaW_userRow` 内），放宽后 10 个真实宿主 tooltip 全压制、桌面 1440 不受影响（探针 `.local-tests/tooltip-probe.mjs` 8/8）。
- **发现宿主 session 恢复的探针坑**：0.1.1-rc.2 的 persist store（dsh-client-runtime `createSnapshotStore` persist=localStorage key `dsh.sessions.current`）在 boot 早期把内存空快照写回 localStorage，**会覆盖 addScriptToEvaluateOnNewDocument 的预注入**——正确做法是 boot 完成后再写 localStorage 并 reload，然后轮询 `data-phase="active"`（等异步恢复，1500ms sleep 不够，实测需轮询）。恢复成功条件：sessionId 必须属于 dsh web 进程 cwd 的 sessions 目录（本机 3080 的 cwd 是 home，不是 dsh-mobile-nav）。
- **🥇-1 已摘：compress.ts headerValue 大小写修复**（提交 d25d7d3）：headerValue 纯函数导出 + isDeferrable / varyWithAcceptEncoding / content-length 删除改大小写不敏感；新增 tests/compress.test.ts 3 用例（全量 60/60 绿）；verify + build + diff --check 通过。
- **建立本框架**：`docs/fork-wzxmt-zhc/`（README 对账快照 + backlog 摘抄清单 + 本日志），确立接手协议：恢复上下文读 README → 挑任务读 backlog → 推进记 log。
- **完成首次对账**（结论已写入 README/backlog）：
  - fork 仅 `main` 分支，head `2ff7976` v2.5.9；merge-base `ebbd18b`（round 8）；落后上游 15 commits；fork 针对宿主 0.1.2-alpha.1，本仓库基线 rc.1/rc.2。
  - fork 独有：会话删除、压缩 headerValue 大小写修复、alpha.1 composer 适配、tooltip 残留修复、file-viewer 适配。
  - 摘抄三档评估：🥇 直接摘（headerValue / tooltip / 三处 textarea 锚点）；🥈 对账合并（composer 集群选择器、file-viewer 全套）；🥉 参考不摘（会话删除）。
- **评估结论已入记忆**：mnemopi `f4ae9279861fc778`（三档摘抄结论）、`2bef97326b58f9ed`（fork 独立发版线概况）。
- 本地已有临时引用 `refs/remotes/fork/main`（重开工作区后需重新 fetch，命令见 README 接手协议）。
- **未动手**：所有摘抄条目均为「待摘」，用户当前指示是只看不动。
