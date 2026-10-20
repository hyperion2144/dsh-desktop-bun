# 桌面端与移动端构建拆分：GitHub Actions 触发语义核实（#212）

> 只读调查：把 `.github/workflows/build.yml` 拆成桌面 / 移动端两条独立流水线之前，先核实
> GitHub Actions 的触发、过滤、复用与并发语义。本文件只记录官方文档原文与推论，不改任何 workflow。

- 日期：2026-10-20
- 仓库：`dsh-desktop-bun`
- 触发：issue #212（桌面 / 移动端构建流水线拆分）
- 性质：只读；一手件为 docs.github.com 的 Actions 参考 / 概念 / 操作页。原文经 `github/docs`
  仓库 Markdown 源逐句核对，引用页 URL 均已用 HTTP 200 验证可访问。
- 证据分级：【官方】docs.github.com 明文；【源码】本仓 workflow 现状；【推断】由官方语义推出、
  未实跑验证；【存疑】未找到一手明文。

## 结论

**机械上可行：两份 workflow 文件各自声明 `on:`，就能把桌面与移动端的触发面完全分开。但「按改动路径只跑一边」在 `workflow_dispatch`、`schedule`、tag push 上做不到——这三类触发都不评估 `paths` 过滤。能分开的只有「事件 + ref（tag / 分支）」，不是「改了哪些文件」。**

| 能做到 | 做不到 |
|---|---|
| 桌面 workflow 只听 `desktop/v*` 一类 tag；移动端只听 `mobile/v*` | 不能用 `paths` / `paths-ignore` 让 dispatch 只跑桌面、schedule 只跑移动端 |
| 各自拥有 `workflow_dispatch`（含 `inputs`）与各自的 `schedule` cron | 不能把触发器抽进 reusable workflow 让两个入口继承；`on:` 必须写在各入口文件里 |
| 把公共 job 抽成同仓 `workflow_call` 工作流共用 | 不能靠 GitHub 给 workflow 或产物发「版本号」；版本只能由 tag 命名与仓内版本文件约定 |
| 两个 workflow 里使用同名 artifact 不会互撞（run 作用域） | 两份都写 `tags: ['**']` 时，任何 tag 会同时触发两边 |
| 各自使用不同 `concurrency` group，互不取消 | `schedule` 不能跑在非默认分支，也不能保证准点；公开仓 60 天无活动会被自动禁用 |

一句话：拆分＝**把一份文件的 `on:` 与 jobs 复制成两份文件的 `on:` 与 jobs**，不是给同一份文件加路径过滤。

## 1. `paths` / `paths-ignore` 的适用面

官方 workflow syntax 里，路径过滤只定义在三个事件之下，小节标题即为
`on.<push|pull_request|pull_request_target>.<paths|paths-ignore>`：

| 事件 | 是否评估 `paths` | 依据 |
|---|---|---|
| `push`（分支） | 是 | 小节定义 + 原文 |
| `push`（tag） | **否** | 「Path filters are not evaluated for pushes of tags.」 |
| `pull_request` | 是 | 小节定义 |
| `pull_request_target` | 是 | 小节定义 |
| `workflow_dispatch` | **否** | 该事件下没有 `paths` 键 |
| `schedule` | **否** | 该事件下没有 `paths` 键 |

原文（<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore>）：

> When using the `push` and `pull_request` events, you can configure a workflow to run based on
> what file paths are changed. **Path filters are not evaluated for pushes of tags.**

同一页另一条：`branches` 与 `paths` 同时定义时取 AND
（<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushbranchestagsbranches-ignoretags-ignore>）：

> If you use both the `branches` filter and the `paths` filter, the workflow will only run when
> both filters are satisfied.

本仓先例：`.github/workflows/check.yml` 的 `push.paths` 只对 **main 分支 push** 生效，这正是
官方允许的那一种用法；`build.yml` 的三条触发（dispatch / tag / schedule）一条都用不上。

## 2. tag push 不评估路径过滤

这是拆分里最容易误判的一条：即使 tag 指向的提交只改了 `desktop-electrobun/**`，只要
`push.tags` 命中，移动端 workflow 一样会被触发；反之亦然。想「只跑相关的一边」，能用的杠杆只有
**tag 名本身**（见 §3），或者跑起来后用 job 级 `if:` 自己判断（见 §10，属于事后跳过，不是不触发）。

## 3. `tags` / `tags-ignore` 的语法与匹配语义

原文（<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushbranchestagsbranches-ignoretags-ignore>）：

> Use the `tags` filter when you want to include tag name patterns or when you want to both include
> and exclude tag names patterns. Use the `tags-ignore` filter when you only want to exclude tag
> name patterns. You cannot use both the `tags` and `tags-ignore` filters for the same event in a
> workflow.
>
> If you define only `tags`/`tags-ignore` or only `branches`/`branches-ignore`, the workflow won't
> run for events affecting the undefined Git ref.

要点：

- `tags` 里多个模式是「或」关系，一个列表可以同时容纳多个命名空间，例如
  `['desktop/v*', 'mobile/v*']`（同一个文件要响应两个命名空间时用）。
- 要让两份 workflow 互斥，就各写各的：桌面 `tags: ['desktop/v*']`，移动端 `tags: ['mobile/v*']`。
- 通配语义（filter pattern cheat sheet，
  <https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#filter-pattern-cheat-sheet>）：
  - `*`：「Matches zero or more characters, but does not match the `/` character.」
  - `**`：「Matches zero or more of any character.」
  - 表里对 `'**'` 的说明：「Matches all branch and tag names. This is the default behavior when you
    don't use a `branches` or `tags` filter.」
  - 对 `feature/**` 的说明明确 `**` 会跨 `/`：「The `**` wildcard matches any character including
    slash (`/`) in branch and tag names.」

因此：

- `'**'` **会**匹配含 `/` 的 tag（如 `desktop/v1.2.3`）——本仓 build.yml 现在就是 `'**'`，它能吃到
  所有 tag，没有前缀过滤能力。
- `desktop/v*` 只匹配「`desktop/v` 后不含 `/` 的一段」；若将来要 `desktop/v1/rc1` 这类多段 tag，
  应写 `desktop/v**`。
- 想让某个 tag 同时触发桌面与移动端，就在**一份**文件的 `tags` 列表里写两个模式；想让两份文件
  各自独立，就绝不把对方的命名空间写进自己的列表。

## 4. `workflow_dispatch`

原文（<https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch>）：

> This trigger only receives events when the workflow file is on the default branch.
>
> On the GitHub UI, the "Run workflow" button will be present if the workflow file exists on the
> default branch. Once a workflow has run at least once, you can dispatch it against any branch or
> tag via the GitHub API or GitHub CLI.

补充（<https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow>）：

> Only workflow files that use the `workflow_dispatch` event trigger will have the option to run
> the workflow manually using the **Run workflow** button.
>
> You can define up to 25 `inputs` for a `workflow_dispatch` event.
>
> To run a workflow on a branch other than the repository's default branch, use the `--ref` flag.

结论：

- 任何位于默认分支 `.github/workflows/` 下、且声明了 `workflow_dispatch` 的文件都会获得手点入口；
  拆分后两份文件各自都有入口，不需要「转发 job」。
- **不支持路径过滤**：dispatch 没有「本次改了哪些文件」的天然 diff，也没有 `paths` 键。
- 支持 `inputs`（`boolean` / `choice` / `number` / `environment` / `string`），本仓 `mode=shots-only`
  这类开关可以原样搬到桌面端文件；移动端若也要开关，需各自声明。
- UI 默认只从默认分支起跑；API / CLI 可用 `ref` 指定任意分支或 tag，但文档措辞是「Once a workflow
  has run at least once」——新拆出的文件首次只能从默认分支触发。

## 5. `schedule`

原文（<https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule>）：

> The `schedule` event can be delayed during periods of high loads of GitHub Actions workflow runs.
> High load times include the start of every hour. If the load is sufficiently high enough, some
> queued jobs may be dropped. To decrease the chance of delay, schedule your workflow to run at a
> different time of the hour.
>
> Scheduled workflows will only run on the default branch.
>
> In a public repository, scheduled workflows are automatically disabled when no repository
> activity has occurred in 60 days.

`on.schedule` 语法页（<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule>）：

> Scheduled workflows run on the latest commit on the default branch. The shortest interval you can
> run scheduled workflows is once every 5 minutes.
>
> A single workflow can be triggered by multiple `schedule` events.

结论：

- 只跑**默认分支最新提交**：schedule 永远不会跑 tag 或 release 分支上的版本；拆分后两份文件的
  cron 都盯 main。
- 两个文件各自声明 `on.schedule`，就是两条独立 cron（文档没有「共享 cron」概念；每个 workflow
  文件自带触发器）。代价是每日全量跑两遍。
- 北京时间 02:30 的偏移是合理的：官方明说整点是高负载、可能延迟甚至丢队列。
- 60 天自动禁用仅明文限定「In a public repository」；私有 / 内部仓的行为该页未说明（见 §未验证）。

## 6. `schedule` + `workflow_dispatch` + `push tags` 共存

官方明确允许一个 workflow 定义多个事件
（<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#on>）：

> You can define single or multiple events that can trigger a workflow, or set a time schedule.

没有任何文档说这三类触发不能共存。需要注意的只是各事件自己的约束叠加：

- `schedule` 只使用默认分支（§5），因此「只在 feature 分支上改 cron」不会生效，直到合入默认分支。
- `workflow_dispatch` 的入口也要求文件在默认分支（§4）。
- tag push 用**被推送 ref 上的文件**（见 §未验证 的推论）；tag 若指向拆分前的旧提交，新文件根本
  不在那个提交里，不会跑。
- 三个事件在同一文件里时，运行时的 `github.event_name` 不同（`schedule` / `workflow_dispatch` /
  `push`），job 级 `if:` 可据此分流；`schedule` 的 `GITHUB_REF` 固定是默认分支。

## 7. Reusable workflow（`workflow_call`）

**能共享 job，不能共享触发器。** 原文
（<https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows>）：

> For a workflow to be reusable, the values for `on` must include `workflow_call`:

同仓调用写 `uses: ./.github/workflows/xxx.yml`（不带 `@ref`，即调用方所在提交的那份）；在
`build.yml` 里已有先例：`installer-ui-shots` job `uses: ./.github/workflows/installer-ui.yml`。

限制与继承（<https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations>）：

- 可调用条件第一条：「Both workflows are in the same repository.」——同仓满足。
- 嵌套深度：fpt/ghec 为 **10 层**（顶层 caller + 最多 9 层 reusable）；原文
  「You can connect a maximum of ten levels of workflows - that is, the top-level caller workflow
  and up to nine levels of reusable workflows.」
- 单文件最多调用 **50** 个唯一 reusable workflow：
  「You can call a maximum of 50 unique reusable workflows from a single workflow file.」
- caller 的 job 只允许这些键：`name` / `uses` / `with` / `secrets` / `strategy` / `needs` / `if` /
  `concurrency` / `permissions`（没有 `env`、没有 `steps`、没有 `runs-on`）。
- 权限：「If `jobs.<job_id>.permissions` is not specified in the calling job, the called workflow
  will have the default permissions for the `GITHUB_TOKEN`.」以及「The `GITHUB_TOKEN` permissions
  passed from the caller workflow can be only downgraded (not elevated) by the called workflow.」
- secrets：「Secrets are only passed to directly called workflow, so in the workflow chain A > B > C,
  workflow C will only receive secrets from A if they have been passed from A to B, and then from
  B to C.」可用 `secrets: inherit` 或逐个传。
- `workflow_call` 的 payload 是 caller 的 payload：
  「When a workflow is triggered with the `workflow_call` event, the event payload in the called
  workflow is the same event payload from the calling workflow.」
- caller 与 callee 都写 `cancel-in-progress: true` 时，不要共用同一个 `concurrency.group`，否则
  会取消正在跑的 caller（`github.workflow` 在 callee 里是 caller 的名字）。

对拆分的直接含义：可以抽 `_desktop-build.yml` / `_mobile-build.yml` 作为被调用的「纯 job 定义」，
但**触发面仍必须由桌面 / 移动端两个入口文件各自声明**；`workflow_call` 只是把 job 搬过去，不会把
`push` / `schedule` / `workflow_dispatch` 继承过去。

## 8. Artifact：run 作用域，跨 workflow 同名不冲突

官方概念页（<https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts>）：

> An artifact is a file or collection of files produced during a workflow run.

`actions/upload-artifact` 官方 README（<https://github.com/actions/upload-artifact>）：

> Artifact names must be unique since each created artifact is idempotent so multiple jobs cannot
> modify the same artifact.
>
> Artifacts created by `upload-artifact@v4` are immutable.

下载文档（<https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts>）：

> If you want to download artifacts from a different workflow or workflow run, you need to supply a
> token and run identifier.

REST 侧同样是 run 作用域：`GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts`
（<https://docs.github.com/en/rest/actions/artifacts#list-workflow-run-artifacts>）。

结论：

- v4 的「name 唯一」是**同一个 workflow run 内**的约束（多 job / matrix 不能往同名 artifact 里写）；
  两个不同 workflow 产生两个不同 run，各自命名空间独立，同名不会互撞，也不需要全局前缀。
- 跨 workflow / run 读取才需要 token + `run-id`。
- 本仓 artifact 名里带平台前缀（如 `macOS arm64` 之类）本来就是 matrix 内的区分，不是跨 workflow
  的防撞措施；拆分后可以保留现状。

## 9. `concurrency`：group 跨 workflow 共享

原文（<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency>，
具体段落经 `data/reusables/actions/actions-group-concurrency.md` 渲染）：

> If you have multiple workflows in the same repository, concurrency group names must be unique
> across workflows to avoid canceling in-progress jobs or runs from other workflows. Otherwise, any
> previously in-progress or pending job will be canceled, regardless of the workflow.
>
> To also cancel any currently running job or workflow in the same concurrency group, specify
> `cancel-in-progress: true`.
>
> The concurrency group name is case insensitive.

概念页（<https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency>）：默认并发不受限；
`concurrency` 组内同时最多一个 running，另有一个 pending；新排队会替换掉旧 pending。

对 split 的含义：

- 两个 workflow 若用同一个 group（例如都写 `build-${{ github.ref }}`），会**互相取消**；必须
  各用各的 group（如 `desktop-${{ github.ref }}` / `mobile-${{ github.ref }}`），或把
  `${{ github.workflow }}` 拼进 group。
- `cancel-in-progress: true` 对 scheduled run 没有专门文档例外：schedule 的 `GITHUB_REF` 是默认
  分支，因此 group 若只按 ref 命名，定时 run 会与同分支的 push/dispatch run 落在同一组，可能互相
  取消。这是从通用语义推出的（见 §未验证）。
- `build.yml` 目前没有 `concurrency`，加不加是拆分时的新决定。

## 10. 非 push 事件按改动路径跳过：没有官方触发器级机制

- 触发级路径过滤只属于 `push`（分支）/`pull_request`/`pull_request_target`（§1）；`schedule` 与
  `workflow_dispatch` 没有这个键。
- 官方的「跳过运行」机制只覆盖 push/PR（<https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs>）：
  > Skip instructions only apply to the `push` and `pull_request` events.
- 唯一文档化原语是 job 级条件
  （<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idif>）：
  > You can use the `jobs.<job_id>.if` conditional to prevent a job from running unless a condition
  > is met.
- 因此 dispatch / schedule 想「按改动跳过」，只能自己算 diff：前置一个 job 用 Compare API 或
  changed-files 类 action 产出 `outputs`，后续 job 用 `needs.<job>.outputs.x == 'true'` 的 `if:`
  跳过。官方没有为这条路径背书，且有明确成本/限制：
  - 需要 `contents: read` 的 token（REST compare 接口）；
  - schedule 的事件 payload 没有「本次改动」概念，base 只能由仓库约定（例如上一个 tag）；
  - dispatch 的 ref 由触发者选择，base 同样要显式给；
  - 这是「跑起来后跳过 job」，不是「不创建 run」，runner 分钟数与 run 记录仍会产生。

## 11. 版本：Actions 没有 workflow / 产物版本号

- 官方只讲「按 git ref 固定 action 版本」
  （<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax>）：
  > We strongly recommend that you include the version of the action you are using by specifying a
  > Git ref, SHA, or Docker tag.
- reusable workflow 的「版本」同样只是调用端的 ref，例如
  `uses: octo-org/example-repo/.github/workflows/workflow-A.yml@v1`
  （<https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows>）。
- docs 中没有「workflow 自身版本号」字段，也没有「artifact 版本」概念；`package.json` /
  `app.json` / tag 名决定产物版本，是**仓侧约定**，Actions 只负责按 ref 触发和存 run。
- 所以「桌面与移动端各自独立版本」在机制上只能表达为：各自 tag 命名空间（`desktop/v*` /
  `mobile/v*`）+ 各自的版本文件 + 各自的 release job；GitHub 不会替你对齐或校验版本号。

## 对本仓的落点

**落地定稿（#212 实施口径，维护者已拍板）**：桌面保留现文件名 `build.yml`（只跑桌面三平台矩阵 + shots-only 转发），移动端新建 `mobile.yml`（`build-mobile` + `build-harmony`）；tag 命名空间桌面 `desktop/v*`、移动端 `mobile/v*`；两端各留一条 cron（桌面 UTC 18:30 不动，移动端 UTC 19:00 错峰）；发布链路另开 #213。本节第 1 条「新建 build-desktop.yml」是调研期的候选口径，未采用。
1. **拆法**：新建 `.github/workflows/build-desktop.yml` 与 `build-mobile.yml`，各自复制原文件中
   属于自己的一半 `on:` 与 jobs；`build.yml` 可以退役或缩成兼容入口。触发面无法共享，必须两份都写。
2. **tag 命名空间**：桌面 `push.tags: ['desktop/v*']`，移动端 `['mobile/v*']`。现在仓内 0 个 tag，
   这两个前缀是**新约定**，Actions 不会强制；两份都写 `'**'` 等于没拆。
3. **不要指望路径过滤**：`paths` 只对分支 push / PR 有效（`check.yml` 已经这么用）。桌面构建的
   dispatch、schedule、tag push 都不会因为「只改了 mobile」而跳过；反过来同理。
4. **dispatch 入口**：两份文件各自声明 `workflow_dispatch`；`mode=shots-only` 直接留在桌面端
   （或作为独立 workflow）。`installer-ui.yml` 已同时声明 `workflow_dispatch` + `workflow_call`，
   是本仓「一个文件既可手点又可被调」的既成先例。
5. **schedule**：两份各一条 cron，都只跑默认分支最新提交；如果不想每天双份全量，可以让移动端
   低频（例如每周）而桌面保持每日——这是仓侧决定，不是 Actions 能力。
6. **共用 job**：把三平台矩阵 / assert / NSIS / smoke 抽成 `workflow_call` 文件是可行的；注意 caller
   job 不能带 `env` 与 `steps`，`permissions` 只能降不能升，secrets 需显式传或 `secrets: inherit`，
   且 callee 的 `github.workflow` 是 caller 名字（concurrency 别撞）。
7. **artifact**：两个 workflow 可以继续用各自的名字，不必加全局前缀；v4 的唯一性约束只在同一个
   run 内（矩阵里保持现有平台后缀即可）。
8. **concurrency**：如果加，桌面与移动端必须用不同 group；`cancel-in-progress` 对定时 run 也会生效
   （schedule 的 ref 是默认分支），要避免定时全量被同分支的手动 run 取消。
9. **版本**：独立版本号只能靠 tag 前缀 + `package.json` / `app.json` 约定；等接 release job 时，
   桌面与移动端各写各的 Release / 资产名，Actions 不提供版本仲裁。
10. **首次拆分后的 tag**：tag 必须指向包含新 workflow 文件的提交，否则该 tag 的 push 事件按那个
    旧提交的文件集合执行，新拆出的 workflow 不会存在（推论，见下节）。

## 未验证 / 存疑

1. **reusable workflow 能否同时声明 `workflow_call` 与 `push` / `schedule` / `workflow_dispatch`**：
   文档只写「`on` 必须 include `workflow_call`」，没有明文允许或禁止其他事件。本仓
   `installer-ui.yml` 已同时声明 `workflow_dispatch` + `workflow_call`（可手点、可被调用），
   但 `push` / `schedule` + `workflow_call` 的组合未找到一手明文，也未在本仓验证。
2. **tag push 到底用哪份 workflow 文件**：push 段只说
   「This includes workflows that are not merged into the default branch.」，没有一句直接写
   「tag 使用 tag 所指提交上的文件」。按 push 的 ref 语义推断为「被推送 ref 上的文件」，因此 tag
   指向旧提交时新文件不会跑；这条影响首次拆分的发版顺序，建议实测确认。
3. **artifact 跨 workflow 同名的「不冲突」**：没有一句总括明文；由「artifact 是 run 的产物」+
   「跨 run 下载要 token + run-id」+ 「v4 name 在 run 内唯一」推出，语义上成立但未见逐字表述。
4. **schedule 与 concurrency 的交互**：没有 schedule 专属说明；「定时 run 与同分支 run 共享 group」
   是由通用 concurrency 文本 + schedule 的 `GITHUB_REF`=默认分支推出。
5. **60 天自动禁用**：明文限定「In a public repository」；私有 / 内部仓是否同样处理，该页未说明。
6. **`workflow_dispatch` 的 ref 细节**：文档说 UI 从默认分支起跑、API/CLI 可指定任意 branch/tag，
   但「Once a workflow has run at least once」这句的精确边界（按 workflow 还是按文件、首次 run 后
   多久可用）未展开；新拆分文件首发建议先走默认分支 UI。
7. **文档版本**：本笔记核对的是 `github/docs` 仓库 `main` 上的 Markdown 源；docs.github.com 渲染页
   已确认 200，但小节锚点名可能随文档重构变化，引用以页面标题为准。

## 来源

- Workflow syntax（`on.push` / `on.schedule` / `on.workflow_dispatch` / `on.workflow_call` /
  `concurrency` / filter pattern cheat sheet / `jobs.<job_id>.if`）：
  <https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax>
- Events that trigger workflows（`push` / `schedule` / `workflow_dispatch` / `workflow_call`）：
  <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows>
- Reusing workflow configurations（访问规则、嵌套与数量上限、caller 允许键、权限与 secrets）：
  <https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations>
- Reuse workflows（`workflow_call`、inputs / secrets、嵌套）：
  <https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows>
- Manually run a workflow（默认分支、`--ref`、25 个 inputs 上限）：
  <https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow>
- Skip workflow runs（只适用于 push / PR）：
  <https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs>
- Workflow artifacts（概念）：
  <https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts>
- Download workflow artifacts（跨 run 需 token + run-id）：
  <https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts>
- Concurrency（概念）：
  <https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency>
- REST：List workflow run artifacts：
  <https://docs.github.com/en/rest/actions/artifacts#list-workflow-run-artifacts>
- `actions/upload-artifact` README（v4 命名唯一 / 不可变）：
  <https://github.com/actions/upload-artifact>
- 本仓：`.github/workflows/build.yml`（`on:` 三条触发、`build` / `build-mobile` /
  `build-harmony` / `installer-ui-shots`）、`.github/workflows/installer-ui.yml`（`on:` 双声明）、
  `.github/workflows/check.yml`（`push.paths` 先例）
