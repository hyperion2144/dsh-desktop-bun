# 摘抄清单（backlog）

> 状态流转：待摘 → 进行中 → 已摘 ✅ / 跳过 ❌。每项摘抄完成时：更新状态 + 在 `log.md` 追加条目 + 跑 `pnpm verify && pnpm test:core && pnpm build`。
> 行内「fork 位置」给出 fork 提交 hash，动手前 `git show <hash> -- <path>` 取最新实现（fork 独立推进，hash 内容以 fetch 后的实际为准）。

## 🥇 直接摘（小而稳）

| 项 | fork 位置 | 决策 | 状态 | 注意点 |
|---|---|---|---|---|
| compress.ts 大小写修复（`headerValue`） | round 3 merge（`20d2ce2` 带入），`src/compress.ts` | 摘 | 已摘 ✅ d25d7d3 | 上游 `10f55da` 移植时漏带；对原始 `writeHead` 参数大小写不敏感查找（content-type / content-encoding / vary / content-length）。tests/compress.test.ts 3 用例覆盖。 |
| 消息操作 tooltip 残留修复 | `7e58824`，`src/client/styles/layout.css.ts` | 摘 | 已摘 ✅ 190fbbf | 门控 `(hover: none), (pointer: coarse)`。**摘抄时放宽了作用域**：fork 的 `[data-phase] [class*="_actions"] :is(...)` 在我们宿主（0.1.1-rc.2）不命中真实 bubble（实测 bubble 挂在 `gdEzaW_userRow` 内而非 actions 行），已去掉 actions 祖先限定；CDP 实测 8/8（含真实宿主 10 个 tooltip 元素全压制、桌面不生效）。 |
| 三处裸 textarea 锚点改 `textarea, [data-composer-input]` | `c246feb`：`git-chip-reparent.ts` / `stats-line.ts` / `debug.ts` | 摘 | 已摘 ✅ 3fc6c17 | 上游这三处是漏网的；宿主升 0.1.2（Lexical contentEditable）后裸 textarea 全部失效。机械替换，向后兼容（textarea 分支保留）。CDP 冒烟：0.1.1 上 stats 标记 + badge composer 字段均正常。 |

## 🥈 对账合并摘（不能整块抄）

| 项 | fork 位置 | 决策 | 状态 | 注意点 |
|---|---|---|---|---|
| composer 集群 `:has(textarea)` 正向加 `[data-composer-input]` | `7f47f9e`，`layout.css.ts` / `misc.css.ts` | 合并 | 已摘 ✅ e1ea61d | **对账结论：与 PR #47 不冲突**——#47 的 `:not(:has(...))` 用在 `_scroll` 内容规则（排除 composer 内部内容），fork 的正向 `:has(...)` 用在 `_card` 识别规则（找卡片本身），作用对象不同可共存。layout 24 处 + misc 2 处机械替换，另摘 misc 的 `[data-composer-placeholder]` 门控 2 条（0.1.2 空状态折叠）。CDP 11 断言全绿。 |
| dsh-file-viewer 移动端适配全套 | `2ff7976`：新 `file-viewer-compat.ts`（35 行）+ compat.css 106 行 + misc.css 12 行 + sidebar-swipe takeover 3 行 + phone-chrome 注册 2 行 | 按需 | 已摘 ✅ 955b69d | 全部 marker 门控（没装 viewer 零影响）。**本机 profile 未装 viewer，CDP 只能注入形状验证**（13 断言全绿），真机行为待有 viewer 的用户复核。takeover 语义：viewer 打开时左缘横滑让位给内容滚动（CSV/代码）。 |

## 🥉 参考不摘

| 项 | fork 位置 | 决策 | 状态 | 说明 |
|---|---|---|---|---|
| ~~会话删除（行菜单 + `/api/mobile-nav.session.delete`）~~ → **已移入 🥇 分层摘抄并完成（预备式）** | v2.7.0（`src/delete-session.ts` DI 纯核 + `effects/session-menu.ts`），针对 0.1.3-alpha.1 | 分层摘抄：纯核 + list 形状分代适配直取，live 策略（cancel/whenIdle 路径）留 0.1.3 阶段二 | ✅ 已摘（预备式，2026-09-08）→ **0.1.7 bring-up 完成（2026-09-24，见 log 同日条目）** | **落地（提交 4c58bc6/95e5839/f54690a/d1113a3/a336c1d + 本文档随文更新）**：纯核 `src/delete-session.ts`（fork 原样 + 3 处分代适配：`entry.header ?? entry` 扁平 list 归一、live 门控降级为 409 session-busy（rc.2 Agent face 无 cancel/whenIdle）、`workspace.detachSession?()` 可选链）+ 10/10 单测（fork 7 条逐字 + 3 条 rc.2 基线）；宿主路由进 `src/index.ts`（405/400/503/200/404/409 错误码族）；客户端 `session-menu.ts` fork 逐字（`ctx.locale.bind(NS)` 保留，fork 原文 `n(ns)` 是本仓库 rg -r 误读产物）+ i18n 10 键 + base.css 弹窗块（动画名修正为 `dsh-web-mobile-fade/sheet-in`，fork 的 `dsh-mobile-nav-*` 在本仓库是 no-op）+ misc 桌面隐藏块补 3 个类。**rc.2 探针发现（决策 A 预备式收尾）**：手机抽屉是 rail 变体（`qDHVXG_rail`，listArea 恒空），无会话行可注入 → UI 在 rc.2 静默、0.1.3 抽屉渲染会话行后自动激活；探针 `scripts/probes/session-delete-probe.mjs` 断言 5 = 升级绊线，翻红时**回来本行复启**：解禁 6-13（菜单项数/弹窗开/取消/Escape 全套 UI 断言）并实测阶段二 live 删除。桌面零注入由 15c/15d 双保险守住（mobile 门控 + misc 隐藏块）。真机 E2E：冷会话 200 且存储目录整删（跨项目 projectKey 复算命中真实布局 `--data-data-com.termux-files-home-mc-search-skill--/`）、GET 405/空参 400/未知 404 通过；「刷新后行消失」用行数回归旁证（脚本删了自己正看的会话导致 reload 超时，属脚本假象非产品路径——**注意边缘：删除当前正打开的会话时客户端恢复指针要能回落**，0.1.3 实机验证时顺带验）。409 live 拒删仅单测覆盖，实机需 agent 真在跑。 |

## 备选（方向性，未排期）

| 项 | 说明 | 状态 |
|---|---|---|
| 反向帮 fork 同步上游 15 commits（round 9） | PR #46/#47、#43/#44、#41、settings 工具栏锚定。fork 是独立发版线，同步需 fork 作者配合或走 PR。 | 未排期 |
