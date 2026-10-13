# fork wzxmt-zhc/dsh-web-mobile 对账与摘抄

> 本目录是对社区 fork [wzxmt-zhc/dsh-web-mobile](https://github.com/wzxmt-zhc/dsh-web-mobile) 的专项工作文档：记录对账快照、摘抄决策与推进日志。**接手这个专项时先读本文件恢复上下文，再读 `backlog.md` 挑任务，最后看 `log.md` 看做过什么。**

## 接手协议

1. **读本文件**（对账快照）→ 恢复「fork 现状、差距、坑」的上下文。
2. **读 `backlog.md`** → 看摘抄清单的状态，挑「待摘」条目。
3. **recall 记忆**：开工前 recall 「dsh-web-mobile fork」相关教训（评估结论沉淀在 mnemopi `f4ae9279861fc778` 等条目里；记忆存教训/结论，本文档存进度/决策，两边不重复）。
4. **动手前重新对账**（fork 在独立推进，快照会过时）：

   ```sh
   git fetch https://github.com/wzxmt-zhc/dsh-web-mobile.git main:refs/remotes/fork/main
   git log --oneline origin/main..fork/main          # fork 独有
   git log --oneline fork/main..origin/main          # fork 缺失
   ```

   fork **没有配置为 remote**（防误推），`refs/remotes/fork/main` 是临时引用，重开工作区后需重新 fetch。

   **网络受限时的对账通道**（2026-09-06 实测：github.com:443 直连与 ghfast.top 镜像超时不可达；raw/codeload/api.github.com 可达）：

   ```sh
   # 全量源码：codeload tarball（推荐，一次拿全）
   curl -sL https://codeload.github.com/wzxmt-zhc/dsh-web-mobile/tar.gz/refs/heads/main | tar xz
   # 或单文件：api.github.com/repos/.../contents/<dir> 列目录 + raw.githubusercontent.com 逐文件拉
   ```
5. **每完成一步**：在 `log.md` 追加条目（日期 + 做了什么 + 结果），并同步更新 `backlog.md` 对应行的状态。完成一项摘抄后按项目惯例跑 `pnpm verify && pnpm test:core && pnpm build`。

## 对账快照（2026-09-06）

| 项 | 值 |
|---|---|
| fork 分支 | 仅 `main` |
| fork head | v2.7.0（head commit：`feat: adapt session deletion to DSH v0.1.3-alpha.1`；本轮网络受限未拿到精确 SHA，GitHub tree API 显示 main tree = `45cb2e1`） |
| 上游 head（对账时） | `ac7a588`（本地 main 与 origin/main 同步） |
| fork 同步水位 | v2.6.0 已合上游 round 9（PR #41/#43/#44/#45/#46/#47 + settings 工具栏锚定）并**主动删除 compress.ts**（上游已拥有压缩）；此后上游的 PR #48（composer-keyboard-guard）fork 未同步 |
| 宿主目标差异 | fork 会话删除重写针对 **DSH 0.1.3-alpha.1**（未发布 npm，最新公开版 0.1.2-rc.1）；本仓库实测基线 0.1.1-rc.2（全局宿主）/ 0.1.2-rc.1（**该快照时点**；2026-09-18 现役全局宿主 0.1.5-rc.1 + client-ui 子包 0.1.5-rc.2，本文其余版本断言同属快照） |
| patch 行 | 与主线完全相同（`id: dsh-web-mobile`）——两份不可并存安装 |

### fork 独有功能（v2.6.0 后仅剩会话删除）

| 功能 | fork 版本 | 摘抄评估 |
|---|---|---|
| 会话删除（行菜单 + 宿主 `/api/mobile-nav.session.delete`） | v2.1.0 → **v2.7.0 重写**（`src/delete-session.ts` DI 纯核 + 7 单测 + `src/client/effects/session-menu.ts`） | 🥉 维持不摘；升级为「分层摘抄候选」，见 backlog 重评 |
| 压缩 headerValue / tooltip / 三处锚点 / composer 集群 / file-viewer | ≤v2.5.9 | 已全部摘抄完毕（backlog 已摘 ✅）；fork v2.6.0 起不再携带压缩 |

### 会话删除 v2.7.0 × 宿主 0.1.1-rc.2 实装验证（2026-09-06）

- 兼容 ✅：JSONL 布局复刻（`encodeSegment`/`projectKey`/`sessionDir`）与 rc.2 后端**逐字节一致**；`persistence.config.root` rc.2 存在（jsonl 后端另有公开 `.root`）；`sessionPersistence`/`sessions`/`agents`/`workspaceRegistry` 服务名 rc.2 均在；客户端 `ctx.sessions`/`ctx.workspaces` 形状兼容（ids/byId/current/displayTitle/blank、archivedSessionIds）；`_sessionRow`/`_projectRow` 哈希类在 rc.2 dsh-client-ui-workspace 存在。
- 不兼容 ❌：rc.2 `persistence.list()` 返回扁平 `SessionHeader[]`（候选即 header），fork 按 `candidate.header.id` 读 → TypeError → 所有删除必 500；live 注销内部 `agents.store`/`detachEntered` rc.2 全库不存在 → optional-chain 静默 no-op，live 会话删除留幽灵注册。**即 v2.7.0 宿主半区只在 0.1.3-alpha.1 上工作，在全部已发布宿主上「装得上、删不了」。**
- 待实机验证：会话菜单签名「恰好 3 项 rename/fork/archive」+ 按标题反查 sessionId（组内位置消歧）——脆弱面与 🥉 理由同源。

### 已知坑

- **fork 提交作者统一为 `dev@dsh-web-mobile.local`**（历史被重写/压缩过），cherry-pick 时用 `--author` 处理。
- **composer 选择器两边各自改过**（fork 对 alpha.1、上游对 rc.1），合并 CSS 会冲突在生成文件 `lib/types/client/styles/*.css.d.ts`——按惯例 `pnpm build` 重建 lib 再 `git add`，不手改 d.ts。
- fork 的 alpha.1 适配不能整块抄：本仓库 PR #47 的 `data-composer-input` 是 `:not(:has(...))` 排除型，fork 是正向扩展型，两套需对账合并。
- 摘抄项落地后，若新增 `data-mobile-nav` 标记或新选择器，记得同步 misc.css.ts 桌面隐藏块清单与 README changelog（项目惯例）。
- **两仓 patch 行同 id（`dsh-web-mobile`）**：fork 与主线不可并存安装（locale/slot 双重注册直接抛错），装 fork 必须先移除主线行。
- **fork v2.7.0 的 peer 是并集范围**（`^0.1.0-rc.6 || >=0.1.1-rc.0 <0.2.0 || >=0.1.2-a <0.2.0 || >=0.1.3-alpha.1 <0.2.0`）：rc.2 满足解析、装得上，但会话删除在 rc.2 上必 500（list 形状）——「装得上 ≠ 用得了」。

## 文档索引

- `backlog.md` — 摘抄清单：每项的 fork 位置、决策、状态、注意点。
- `log.md` — 按时间的推进日志。
