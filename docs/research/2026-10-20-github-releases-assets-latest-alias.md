# GitHub Releases 发布链路：latest 别名、tag、权限与资产语义（官方核实）

> **一句话结论：`releases/latest` 是「仓库级、同一时刻只有一个」的指针，默认由「新发布的、非 draft 非 prerelease 的 release」接管（REST `make_latest` 默认 `true`）；它不分 tag 命名空间、不分桌面/移动端、不分 stable/canary——谁最后发布谁占位。本仓 updater 写死的 `latest/download` 别名因此只能承载一个通道，多通道必须靠发布纪律（`--latest=false`）或换寻址方式。**

- 日期：2026-10-20
- 仓库：`dsh-desktop-bun`（`hyperion2144/dsh-desktop-bun`，public，当前 0 release / 0 tag，`default_workflow_permissions: read`）
- 性质：只读调查；一手件为 docs.github.com、GitHub REST API 官方文档、GitHub CLI（`gh`）官方手册
- 证据分级：【官方】docs.github.com / api.github.com / cli.github.com 明文；【实测】对公开仓库与官方 API 的实际观测；【推断】由官方语义推出、未实跑验证；【存疑】未找到一手明文
- 旁注：docs.github.com 的每个页面都提供源 Markdown 变体（页面 URL 加 `.md`），本笔记的引文均按该变体逐句核对；引用 URL 仍给公开页面地址

## 逐条结论

### 1. `releases/latest/download/<asset>` 解析到哪个 release

**结论：先看「被显式标记为 latest 的那个 release」，没有显式标记时才回落为「最近的非 draft 非 prerelease」——而官方对「最近」给出的排序键是 `created_at`，它等于 tag 所指提交的日期，不是发布时间。发布一个新的正式 release 默认会把指针挪过去（`make_latest` 默认 `true`）。draft 与 prerelease 永远不会成为 latest。指针可以被显式指定，也可以在数据层被显式取消（`false`）或交还给 `legacy` 算法。**

原文，`GET /repos/{owner}/{repo}/releases/latest`（[rest/releases/releases#get-the-latest-release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)）：

> View the latest published full release for the repository.
> The latest release is the most recent non-prerelease, non-draft release, sorted by the `created_at` attribute. The `created_at` attribute is the date of the commit used for the release, and not the date when the release was drafted or published.

`make_latest`（创建与更新 release 同文，[rest/releases/releases#create-a-release](https://docs.github.com/en/rest/releases/releases#create-a-release)）：

> Specifies whether this release should be set as the latest release for the repository. Drafts and prereleases cannot be set as latest. Defaults to `true` for newly published releases. `legacy` specifies that the latest release should be determined based on the release creation date and higher semantic version.

取值语义（`enum: ["true","false","legacy"]`，`default: "true"`）：

| 取值 | 语义 | 依据 |
| --- | --- | --- |
| `true` | 把本 release 设为仓库 latest；新发布的 release 默认就是它 | 【官方】同上默认值 `true` |
| `false` | 显式不把它设为 latest；指针留在原处 | 【官方】同上；`gh --latest=false` 同义 |
| `legacy` | 不用显式指定，改由「release 创建日期 + 更高的语义版本」推导 | 【官方】同上 |

网页 UI 的说法与 REST 不完全一致——UI 把默认行为描述成语义版本优先（[managing-releases-in-a-repository#creating-a-release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#creating-a-release)）：

> Optionally, select **Set as latest release**. If you do not select this option, the latest release label will automatically be assigned based on semantic versioning.

`gh` 的说法又是第三种（[gh_release_create](https://cli.github.com/manual/gh_release_create)）：

> `--latest` — Mark this release as "Latest" (default \[automatic based on date and version\]). --latest=false to explicitly NOT set as latest

**这三段官方文本给出的判据不同**（显式 `true` / `created_at` 排序 / 语义版本 / 日期+版本），属于文档层面的不一致。工程上唯一稳的做法：不要赌默认，发布时显式传 `make_latest=true`（REST）或 `--latest`（gh）。【推断】

- **发布新 release 会不会自动挪指针**：会。`make_latest` 对「新发布的 release」默认 `true`，因此发布动作本身就是一次显式指定。【官方】同上
- **prerelease / draft 能否当 latest**：不能。`Drafts and prereleases cannot be set as latest.`【官方】同上。把它们从 latest 改成 prerelease 后指针如何回退，未见明文。【存疑】
- **latest 是仓库级单指针**：GraphQL `Release.isLatest` 是布尔字段（`Whether or not the release is the latest releast.`，原文含拼写错误），一个仓库同一时刻只有一个 release 为真。【官方】[graphql/reference/releases#release-object](https://docs.github.com/en/graphql/reference/releases#release-object)
- **别名本身**：`releases/latest` 与 `releases/latest/download/asset-name.zip` 是官方给出的公开链接形式，未提供「按 tag 前缀分别解析」的任何机制。【官方】[linking-to-releases](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)

【实测】对公开仓库的直接观测（2026-10-20）：`https://github.com/kubernetes-sigs/kustomize/releases/latest` 返回 `302`，`location: https://github.com/kubernetes-sigs/kustomize/releases/tag/kustomize/v5.8.3`，与该仓库 `GET /repos/kubernetes-sigs/kustomize/releases/latest` 的 `tag_name` 一致。同一手法打本仓：`/releases/latest` → `302` 到 `.../releases`（因为没有 release 可解析），`/releases/latest/download/x-update.json` → `404`。

### 2. tag 能不能带斜杠；`gh release create` 与 tag 的关系

**结论：能。官方明文说 tag 名可以用路径分隔符 `/` 做层级（例：`desktop/v1.0.0`），限制只有「不以 `/` 开头/结尾、不出现连续 `//`」这类 Git 侧例外，外加 GitHub 的两条额外禁令（形如 40 位十六进制对象 ID、以 `refs/` 开头）。tag 不必指向默认分支；但 `gh release create` 在远端没有该 tag 时会「从默认分支最新状态自动建一个」——这正是最容易把 tag 建到错误提交上的地方，`--verify-tag` 就是把这种自动行为改成 abort。**

原文（[dealing-with-special-characters-in-branch-and-tag-names](https://docs.github.com/en/get-started/using-git/dealing-with-special-characters-in-branch-and-tag-names)）：

> Both branch names and tag names may also use the path separator (`/`) for structure, for example `area/item` or `level-1/level-2/level-3`. Other than some exceptions — such as not starting or ending a name with a slash, or having consecutive slashes in the name — Git has very few restrictions on what characters may be used in branch and tag names.

同页「Restrictions on names in GitHub」小节：

> - No names which look like Git object IDs (40 characters containing only 0-9 and A-F), to prevent confusion with actual Git object IDs.
> - No names beginning with `refs/`, to prevent confusion with the full name of Git refs.

`gh release create` 的建 tag 语义（[gh_release_create](https://cli.github.com/manual/gh_release_create)）：

> If a matching git tag does not yet exist, one will automatically get created from the latest state of the default branch. Use `--target` to point to a different branch or commit for the automatic tag creation. Use `--verify-tag` to abort the release if the tag doesn't already exist.

> `--verify-tag` — Abort in case the git tag doesn't already exist in the remote repository
> `--target <branch>` — Target branch or full commit SHA (default \[main branch\])

REST 侧对应 `target_commitish`（[create-a-release](https://docs.github.com/en/rest/releases/releases#create-a-release)）：

> Specifies the commitish value that determines where the Git tag is created from. Can be any branch or commit SHA. Unused if the Git tag already exists. Default: the repository's default branch.

要点：

- **斜杠 tag 合法**，`desktop/v0.1.0`、`mobile/v0.1.0` 都在允许范围内；`releases/tag/<tag>` 的 URL 里斜杠可以保持原样（实测 kustomize 的 `location` 头就是未编码的 `kustomize/v5.8.3`），API 调用则需 `%2F` 编码。【官方】+【实测】
- **不必指向默认分支**：`--target` 可指任意 branch/commit；tag 已存在时 `target_commitish` 直接被忽略。【官方】
- **自动建 tag 的陷阱**：只要**远端**没有这个 tag，`gh release create` 就会拿默认分支 HEAD 建一个。本地有 tag 但没 `git push`，gh 依然认为「不存在」，会建出指向默认分支 HEAD 的同名 tag。【官方】
- **`--verify-tag` 是唯一能把「自动建 tag」关掉的方式**：tag 不在远端就直接失败。【官方】
- 附带一条：`--fail-on-no-commits` 只影响「自上一 release 以来无新提交」时是否失败，首个 release 不受影响。【官方】同上

【实测】`kustomize/v5.8.3` 是真实在用的斜杠 tag：API 返回 `tag_name: "kustomize/v5.8.3"`、`draft: false`、`prerelease: false`。

### 3. `GITHUB_TOKEN` 的权限与「默认 read-only」的关系

**结论：建 release / 传资产要 `contents: write`（fine-grained 的 Contents 写权限；若发版提交相对默认分支改了 `.github/workflows/`，还要 Workflows 写——这一项 `GITHUB_TOKEN` 拿不到）。仓库「默认工作流权限 = read-only」只是**默认值**，工作流文件里显式写 `permissions: contents: write` 依然拿得到写权限——两份官方文档分别从「默认值的来源」和「谁可以改」两个方向说明了这一点。用 `GITHUB_TOKEN` 造出来的 release 不会触发 `on: release` 工作流，防循环规则是全局性的，`release` 只是被这条全局规则覆盖的普通事件。**
**结论：建 release / 传资产要 `contents: write`（fine-grained 的 Contents 写权限；若发版提交相对默认分支改了 `.github/workflows/`，还要 Workflows 写——这一项 `GITHUB_TOKEN` 拿不到）。仓库「默认工作流权限 = read-only」只是默认值，工作流文件里显式写 `permissions: contents: write` 依然拿得到写权限——两份官方文档分别从「默认值的来源」和「谁可以改」两个方向说明了这一点。用 `GITHUB_TOKEN` 造出来的 release 不会触发 `on: release` 工作流，防循环规则是全局性的，`release` 只是被这条全局规则覆盖的普通事件。**
权限需求，两条互补的明文：

- `contents: write` 允许建 release——workflow syntax 的权限表（[workflow-syntax#permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)）：
  > `contents` — Work with the contents of the repository. For example, `contents: read` permits an action to list the commits, and `contents: write` allows the action to create a release.
- fine-grained token 权限集合（[create-a-release](https://docs.github.com/en/rest/releases/releases#create-a-release)）：
  > The fine-grained token must have at least one of the following permission sets: "Contents" repository permissions (write) / "Contents" repository permissions (write) and "Workflows" repository permissions (write)
- 资产接口同属 Contents：`Update a release asset` / `Delete a release asset` 均要求 `"Contents" repository permissions (write)`，读取类接口要求 `(read)`。【官方】[assets#update-a-release-asset](https://docs.github.com/en/rest/releases/assets#update-a-release-asset)

**默认 read-only 不封死显式声明**——先看权限如何计算（[workflow-syntax#permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)，小节「How permissions are calculated for a workflow job」）：

> The permissions for the `GITHUB_TOKEN` are initially set to the default setting for the enterprise, organization, or repository. If the default is set to the restricted permissions at any of these levels then this will apply to the relevant repositories. […] The permissions are then adjusted based on any configuration within the workflow file, first at the workflow level and then at the job level.

再看谁有权改（[managing-github-actions-settings-for-a-repository#setting-the-permissions-of-the-github_token-for-your-repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#setting-the-permissions-of-the-github_token-for-your-repository)）：

> Anyone with write access to a repository can modify the permissions granted to the `GITHUB_TOKEN`, adding or removing access as required, by editing the `permissions` key in the workflow file.

同页还给了 read-only 默认值的来历：

> By default, when you create a new repository in your personal account, `GITHUB_TOKEN` only has read access for the `contents` and `packages` scopes. If you create a new repository in an organization, the setting is inherited from what is configured in the organization settings.

三个仍然会压制写权限的例外（都要注意）：

1. **fork 的 PR**：`The GITHUB_TOKEN has read-only permissions in pull requests from forked repositories.`（[events-that-trigger-workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)）——本仓发版不走 PR，可忽略。
2. **组织级限制**：`Owners of an organization can restrict write access for the GITHUB_TOKEN at the repository level.`（[workflow-syntax#permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)）——本仓属个人账号，无此层。
3. **workflow 文件改动**（这条最阴）——[create-a-release](https://docs.github.com/en/rest/releases/releases#create-a-release)：
   > If the commit identified by `target_commitish` (or, when `target_commitish` is omitted, the latest commit on the default branch) adds or modifies any file under `.github/workflows/` relative to the repository's default branch, the authenticating token must be authorized to modify workflows. Otherwise, this endpoint returns `404 Not Found`; some authentication paths surface `403 Resource not accessible by integration` instead.
   > […] The `GITHUB_TOKEN` available to GitHub Actions cannot be authorized for this.

**防循环（`on: release` 会不会被自己触发）**——[actions/concepts/security/github_token#when-github_token-triggers-workflow-runs](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs)：

> When you use the repository's `GITHUB_TOKEN` to perform tasks, events triggered by the `GITHUB_TOKEN` will not create a new workflow run, with the following exceptions:
> - `workflow_dispatch` and `repository_dispatch` events always create workflow runs.
> - `pull_request` events with the `opened`, `synchronize`, or `reopened` activity types […]
> For all other events, this behavior prevents you from accidentally creating recursive workflow runs.

`release` 属于「other events」，工程上就是「不会触发」。事件页给了同一规则的另一句更直白的表述（[events-that-trigger-workflows#release](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)）：

> With the exception of `workflow_dispatch` and `repository_dispatch`, other `GITHUB_TOKEN`-triggered events do not create workflow runs at all.

`release` 事件本身的几条官方细节（同页）：

> - Workflows are not triggered for the `created`, `edited`, or `deleted` activity types for draft releases. […]
> - The `prereleased` type will not trigger for pre-releases published from draft releases, but the `published` type will trigger.

（`release` 的 `GITHUB_REF` 是 `refs/tags/<tag_name>`，`GITHUB_SHA` 是「Last commit in the tagged release」。）

### 4. 资产上传：语义、覆盖、大小、名字、CDN

**结论：`gh release upload` 就是「往指定 tag 的 release 追加资产」；`--clobber` 不是覆盖，而是「先删同名资产再重传」，且「If the upload fails, the original assets will be lost」。资产名会被 GitHub 规整（特殊字符/非字母数字/首尾点会被重命名），同名资产直接重传会 422，必须先删后传；REST 没有任何「原地替换内容」的接口。单文件上限 2 GiB，单 release 上限 1000 个资产。CDN 缓存语义官方无明文；实测下载走 302 到带签名、约 1 小时过期的对象 URL，响应 `cache-control: no-cache`，对象地址由资产 UUID 决定。**

`gh release upload`（[gh_release_upload](https://cli.github.com/manual/gh_release_upload)）：

> Upload asset files to a GitHub Release.
> When using `--clobber`, existing assets are deleted before new assets are uploaded. If the upload fails, the original assets will be lost.
> `--clobber` — Delete and re-upload existing assets of the same name

REST 侧的三条硬约束（[assets#upload-a-release-asset](https://docs.github.com/en/rest/releases/assets#upload-a-release-asset)）：

> GitHub renames asset filenames that have special characters, non-alphanumeric characters, and leading or trailing periods. The "List release assets" endpoint lists the renamed filenames.
> If you upload an asset with the same filename as another uploaded asset, you'll receive an error and must delete the old file before you can re-upload the new asset.

对应状态码：`201` 成功；`422` 「Response if you upload an asset with the same filename as another uploaded asset」。

「已上传资产能否被替换」——不能原地替换内容。`PATCH /repos/{owner}/{repo}/releases/assets/{asset_id}` 的 body 只有 `name` 与 `label`（[assets#update-a-release-asset](https://docs.github.com/en/rest/releases/assets#update-a-release-asset)），没有内容字段；要换内容只能 DELETE 旧资产再 POST 新资产（得到**新的 asset id**）。【官方】

大小与数量（[about-releases#storage-and-bandwidth-quotas](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#storage-and-bandwidth-quotas)）：

> Up to 1000 release assets may be associated with a single release. Each file included in a release must be under 2 GiB. There is no limit on the total size of a release, nor bandwidth usage.

不可变性（若仓库开启 immutable releases，[immutable-releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)）：

> - **Git tags cannot be moved** […]
> - **Release assets cannot be modified or deleted** […]
> Only the assets and tag are locked. You can still edit the title and release notes […] and change whether it is marked as a pre-release or as the latest release.

同文给的推荐姿势是 **draft → 传完所有资产 → publish**；`gh release create` 带资产时内部就是这么做的（[gh_release_create](https://cli.github.com/manual/gh_release_create)）：

> When using the `create` command to attach assets to a release, separate API calls are made to create the release as a draft, upload the assets, and then publish the release. Immutability protections will be enforced ONLY after the release is published.

**CDN 与「同名替换后 return 新内容吗」**：

- 官方文档没有关于 release 资产缓存或「替换后生效时延」的任何明文。【存疑】
- 【实测】`https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv5.8.3/checksums.txt` → `302`，`location` 指向 `https://release-assets.githubusercontent.com/github-production-release-asset/<repo_id>/<asset_uuid>?sp=r&…&se=<约 1 小时后>&response-content-disposition=…`，该 302 响应带 `cache-control: no-cache`；最终对象响应为 `HTTP/2 206`，带 `etag`、`last-modified`、`x-ms-creation-time`（Azure Blob）。
- 【推断】对象路径里带的是 **asset UUID**，而文件名只是查询参数（`response-content-disposition`），所以「同名替换」在对象层必然是一个新对象；但 `…/download/<name>` 这个按名字解析的入口没有任何官方「立即生效」保证，中间任何缓存（客户端、代理、CDN 边缘）都可能继续给旧字节。**不要把「同名资产覆盖」当成可靠的发布机制**；清单里带版本号、客户端校验版本，才是稳的。

### 5. draft / prerelease 对三个下载 URL 的影响

**结论：`releases/latest/download/<asset>` 永远只解析到 latest（latest 不可能是 draft 或 prerelease）；`releases/download/<tag>/<asset>` 按 tag 精确寻址，tag 存在且对应的 release 已发布就能取到，prerelease 也一样；未发布的 draft release 及其资产不对匿名可见——官方只说「draft 列表仅 push 权限可见」「按 tag 取只返回 published」，没有直说匿名 404。**

| 状态 | `releases/download/<tag>/<asset>` | `releases/latest/download/<asset>` | 匿名可见性 |
| --- | --- | --- | --- |
| published（正式） | 可取到 | 仅当它是最新且含该资产 | 可见 |
| prerelease | 可取到（tag 公开） | **永不**（prerelease 不能当 latest） | 可见 |
| draft | 不作为 published release 暴露 | 永不 | 不可见（仅 push 权限者） |
| 未创建 | 404 | 404 | — |

依据：

- `GET /repos/{owner}/{repo}/releases/tags/{tag}` 的说明是 `Get a published release with the specified tag.`——按 tag 取只承诺 published。【官方】[releases#get-a-release-by-tag-name](https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name)
- `GET /repos/{owner}/{repo}/releases/{release_id}`：`Gets a public release with the specified release ID.`【官方】[releases#get-a-release](https://docs.github.com/en/rest/releases/releases#get-a-release)
- `GET /repos/{owner}/{repo}/releases`：`Information about published releases are available to everyone. Only users with push access will receive listings for draft releases.`【官方】[releases#list-releases](https://docs.github.com/en/rest/releases/releases#list-releases)
- draft 的 created/edited/deleted 不触发工作流；`published` 会触发（draft 发布出来时）。【官方】[events-that-trigger-workflows#release](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)
- draft 可改可删、对应 tag 也可改可删（immutable 只在 publish 后生效）。【官方】[immutable-releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)

两点补充：

- **latest release 里没有这个资产 → 404**，别名不会回落到更旧的 release。这是「latest 指向 + 该 tag 下按名取资产」两步语义的直接推论。【推断】
- `releases/download/<tag>/<asset>` 这种「按 tag 的下载路径」在官方文档里**没有独立小节**（`Linking to releases` 只写了 `latest` 形式）；上表按 REST 语义与实测行为给出。【实测】+【存疑】

### 6. 官方对「CI 里发版」的推荐做法与最小权限

**结论：官方文档没有点名推荐任何第三方 release action（包括 `softprops/action-gh-release`，未查到明文）；官方自己给出的路径是「在 Actions 里用预装的 `gh`，把 `GH_TOKEN` 设成 `${{ secrets.GITHUB_TOKEN }}`，并把该 job 的 `permissions` 提到 `contents: write`」。最小权限集合就是 `contents: write` 一项；唯一会需要额外 Workflows 写的场景（发版提交改了 `.github/workflows/`）恰是 `GITHUB_TOKEN` 拿不到的，只能换 App/PAT 或从流程上避开。**

- `gh` 在 runner 上的官方用法（[use-github-cli](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-github-cli)）：
  > GitHub CLI is preinstalled on all GitHub-hosted runners. For each step that uses GitHub CLI, you must set an environment variable called `GH_TOKEN` to a token with the required scopes.
- 官方 release 操作路径就是 UI 或 `gh release create`（[managing-releases-in-a-repository#creating-a-release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#creating-a-release) 的 CLI 分页）：
  > To create a release, use the `gh release create` subcommand.
- 最小权限：`contents: write`（见 §3 两条明文）。给 job 级而不是 workflow 级更贴合最小权限——`permissions` 支持 job 级覆盖（[workflow-syntax#permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)）。
- 写 release notes / 建 discussion 等附加动作不在本题范围；`discussion_category_name` 要在仓库里已存在该分类，否则 404。【官方】[create-a-release](https://docs.github.com/en/rest/releases/releases#create-a-release)
- 关于 `softprops/action-gh-release`：docs.github.com、REST 文档、`gh` 手册三处都**未查到**官方推荐或背书。【存疑】

## 对本仓的落点（只给建议，不改代码）

本仓已知：`desktop-electrobun/src/shared/runtime/update.ts` 把 `DEFAULT_UPDATE_BASE_URL` 写死为 `https://github.com/hyperion2144/dsh-desktop-bun/releases/latest/download`，清单名 `<buildEnvironment>-<os>-<arch>-update.json`；桌面 tag `desktop/v*`、移动端 tag `mobile/v*` 共用同一仓库；当前 0 release / 0 tag；`build.yml` 是 `permissions: contents: read` 且**还没有 release job**（注释里写着「等允许打 tag 时再加」）。

1. **最大的落地风险：latest 是仓库级单指针，而本仓至少要装下三种通道。** 桌面 stable、桌面 canary（`canary-macos-arm64` 这类前缀在 `test/update.test.ts` 里已出现）、移动端，三者共用 `/releases/latest`。谁最后发布，谁的 release 占位；其余通道的 `latest/download/<name>` 会 404（因为 latest release 里没有那个资产）。可选三条路，按代价排序：
   - 发布纪律：**只有桌面 stable 允许默认 latest**；canary 与任何移动端 release 一律 `--latest=false`（移动端若为预发布再加 `--prerelease`，双保险——prerelease 本来就当不了 latest）。
   - 换寻址：updater 的 baseUrl 改成按 tag 精确寻址（如滚动 tag `desktop-stable` → `releases/download/desktop-stable/<name>`），把「latest」从发布链路里摘掉。
   - 单 release 汇总：一次发布里同时上传所有通道的清单与包，代价是清单名要能区分通道且 latest 只指向这一个「汇总 release」。
2. **0 release 期间别把 404 当异常。** 实测本仓 `/releases/latest` 现在 302 到 `/releases`，`/releases/latest/download/*` 直接 404。updater 在首个 release 之前必须把「404 / 无清单」归到「无更新」，否则首启即报错。
3. **加 release job 时只改 job 级权限即可，不必动仓库设置。** `build.yml` 现在是 `permissions: contents: read`；给上传 job 单独写 `permissions: contents: write` 就能拿到写权限（§3 两份明文），无需把仓库默认工作流权限从 `read` 改成 `write`——本仓当前正是 `read`。
4. **发布顺序要反过来：先 push tag，再建 release。** 若远端没有 tag，`gh release create desktop/vX` 会**从默认分支 HEAD 自动建 tag**——本地打了 tag 但忘了 `git push origin desktop/vX` 时，gh 会建出指向 `main` 当前 HEAD 的同名 tag（可能不是你要发的那个提交），而本仓 `build.yml` 恰好只认 `desktop/v*` 的 tag push。稳的顺序是：`git push origin desktop/vX` → `gh release create desktop/vX --verify-tag <资产>`；`--verify-tag` 会在 tag 不在远端时直接失败。
5. **发版提交尽量别同时改 `.github/workflows/`。** 一旦 release 的 `target_commitish` 相对默认分支改了 workflow 文件，创建 release 需要 Workflows 写权限，而 `GITHUB_TOKEN` 永远拿不到——表现为 404（或 403 `Resource not accessible by integration`）。发版提交只动版本号/CHANGELOG，workflow 改动走单独的 PR。
6. **资产名必须与清单名逐字一致，并且只用安全字符。** 官方会重命名含特殊字符、非字母数字、首尾带点的文件名；`<env>-<os>-<arch>-update.json` 这种全小写+连字符的命名本来就在安全区。但要注意「上传后的名字」才是最终名字：清单/补丁/整包三类资产都要按同一平台前缀传全，否则 `latest/download/<name>` 命中 latest 却取不到资产 → 404。
7. **别用 `--clobber` 当日常覆盖手段。** 它是「先删后传」，上传失败原资产就没了；而且同名重传必须先删（REST 422）。需要「重发同一个 tag」时，正确做法是删掉整个 release 重建，或直接换一个新 tag（版本号递增）。
8. **若开启 immutable releases，发布流程必须是 draft → 传完 → publish。** `gh release create` 带资产时内部已经是这个顺序；但**不要**在 publish 之后再补资产（会被完全禁止）。本仓目前未开启，值得在启用前把「一次传全」写进发布脚本。
9. **不要用 `on: release` 作为发版链路的触发点。** 用 `GITHUB_TOKEN` 建的 release 不会触发工作流（全局防循环规则，`release` 无例外）；只有 `workflow_dispatch` / `repository_dispatch` 例外。现在的设计（tag push 触发 `build.yml`，`workflow_dispatch` 兜底）正好踩在安全的一侧；如果将来想在 release 后补动作，只能用 `workflow_dispatch` 或非 `GITHUB_TOKEN` 的凭证。
10. **`desktop/v*` 这种斜杠 tag 能用在 Actions 过滤里**，也能出现在 `releases/tag/` URL 里；但 API 调用要 URL 编码成 `desktop%2Fv0.1.0`，shell 里要加引号。斜杠 tag 的另一个副作用：`gh release view`/`gh release download` 等命令的参数同样是 tag 字符串，按原样传即可。

## 证据清单

| # | 结论要点 | 一手 URL |
| --- | --- | --- |
| 1 | latest 别名与 `latest/download` 形式 | https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases |
| 2 | latest 的判定（非 draft 非 prerelease，按 `created_at`=提交日期） | https://docs.github.com/en/rest/releases/releases#get-the-latest-release |
| 3 | `make_latest` = true/false/legacy 语义与默认 true；draft/prerelease 不能当 latest | https://docs.github.com/en/rest/releases/releases#create-a-release |
| 4 | 更新 release 时 `make_latest` 同义 | https://docs.github.com/en/rest/releases/releases#update-a-release |
| 5 | UI 侧「Set as latest release / 按语义版本自动分配」 | https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#creating-a-release |
| 6 | `gh --latest` 的「按日期与版本自动」说法 | https://cli.github.com/manual/gh_release_create |
| 7 | latest 是单值布尔（`isLatest`） | https://docs.github.com/en/graphql/reference/releases#release-object |
| 8 | tag 可用 `/`；GitHub 的两条名字禁令 | https://docs.github.com/en/get-started/using-git/dealing-with-special-characters-in-branch-and-tag-names |
| 9 | gh 自动建 tag 从默认分支、`--target`、`--verify-tag` | https://cli.github.com/manual/gh_release_create |
| 10 | `target_commitish` 语义（tag 已存在则忽略） | https://docs.github.com/en/rest/releases/releases#create-a-release |
| 11 | `contents: write` 可建 release；权限计算顺序；组织可限制 | https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions |
| 12 | 任何人都可通过 workflow 里的 `permissions` 增删 token 权限；个人账号默认只读 contents/packages | https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#setting-the-permissions-of-the-github_token-for-your-repository |
| 13 | `GITHUB_TOKEN` 触发的事件不建新 run（`release` 无例外） | https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs |
| 14 | 同一规则的直白表述 + draft 不触发 created/edited/deleted + `prereleased` vs `published` | https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release |
| 15 | 改 `.github/workflows/` 会让建 release 返回 404/403；`GITHUB_TOKEN` 无法被授权 | https://docs.github.com/en/rest/releases/releases#create-a-release |
| 16 | fine-grained 权限集合（Contents 写；或 Contents+Workflows 写） | https://docs.github.com/en/rest/releases/releases#create-a-release |
| 17 | 资产接口需要 Contents 写 | https://docs.github.com/en/rest/releases/assets#update-a-release-asset |
| 18 | `gh release upload` 语义与 `--clobber`（删后传、失败丢原资产） | https://cli.github.com/manual/gh_release_upload |
| 19 | 资产名重命名规则；同名 422、须先删 | https://docs.github.com/en/rest/releases/assets#upload-a-release-asset |
| 20 | PATCH 只能改 name/label（无内容替换） | https://docs.github.com/en/rest/releases/assets#update-a-release-asset |
| 21 | 单资产 <2 GiB、单 release ≤1000 资产 | https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#storage-and-bandwidth-quotas |
| 22 | immutable releases 的保护范围与 draft→传→publish 推荐 | https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases |
| 23 | `gh release create` 带资产时走 draft→upload→publish | https://cli.github.com/manual/gh_release_create |
| 24 | 按 tag 只返回 published release | https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name |
| 25 | 只返回 public release / draft 列表仅 push 权限可见 | https://docs.github.com/en/rest/releases/releases#get-a-release · https://docs.github.com/en/rest/releases/releases#list-releases |
| 26 | Actions 里用 gh 需要 `GH_TOKEN` | https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-github-cli |

【实测】证据（非文档，2026-10-20 观测）：

- `https://github.com/kubernetes-sigs/kustomize/releases/latest` → `302` → `/releases/tag/kustomize/v5.8.3`；`GET /repos/kubernetes-sigs/kustomize/releases/latest` → `tag_name: "kustomize/v5.8.3"`（斜杠 tag + latest 解析）
- `https://github.com/hyperion2144/dsh-desktop-bun/releases/latest` → `302` → `/releases`（无 release）；`/releases/latest/download/x-update.json` → `404`
- `https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv5.8.3/checksums.txt` → `302`（`cache-control: no-cache`）→ `release-assets.githubusercontent.com/.../<asset_uuid>?...&se=<约 1h>` → `206` 带 `etag` / `last-modified` / `x-ms-creation-time`
- `GET /repos/hyperion2144/dsh-desktop-bun` → `0` releases、`0` tags、`private: false`、`default_branch: main`
- `GET /repos/hyperion2144/dsh-desktop-bun/actions/permissions/workflow` → `default_workflow_permissions: "read"`

## 未查到的明文

1. **CDN 缓存的官方语义**：release 资产在 CDN 上的缓存键/过期策略，以及「同名资产删后重传，`latest/download/<name>` 是否立即返回新内容」，docs.github.com 无明文。本笔记只给实测头（`cache-control: no-cache` + 短时效签名 URL）与结构推断。
2. **`releases/download/<tag>/<asset>` 独立文档**：官方只把 `releases/latest/download/<asset>` 写进 `Linking to releases`，按 tag 的下载路径没有专门小节。
3. **官方推荐 `softprops/action-gh-release`**：docs.github.com、REST 文档、`gh` 手册三处均未查到；官方只演示 UI 与 `gh release create`。
4. **`gh release create` 默认实际发出的 `make_latest` 取值**：手册只说「default \[automatic based on date and version\]」，与 REST 的 `default: true` 不一致；gh 源码行为未核实。
5. **draft 资产匿名下载的确切状态码**：官方只有「draft 列表仅 push 权限可见」「按 tag 取只返回 published」，没写匿名请求 draft 资产是 404 还是 302→登录。
6. **把已存在的 latest release 改成 prerelease 后，latest 指针如何回退**：官方只说 prerelease 不能「被设为」latest，没写撤销路径。
7. **用非 `GITHUB_TOKEN`（PAT/App）通过 API 创建 tag 是否触发 `push` 事件**：docs.github.com 未查到明文。工程上用 `git push` 推 tag 最稳。
8. **`.github/workflows/` 那条 404 规则的精确 diff 基准**：原文只说「relative to the repository's default branch」，对「tag 指向的提交是 main 的历史祖先、而 main 后来改过该 workflow 文件」时如何判定，没有更细的说明。
