# Electrobun Updater 的失败契约：404 为什么在壳里变成「未检查」（一手核实）

> **一句话结论：Electrobun 的 `checkForUpdate()` 从不 reject——HTTP 404 与网络中断、非法 JSON、清单非法一律在框架内部被 catch 掉，转成 `emitStatus('error', 'Failed to check for updates: HTTP 404')` + `updateInfo.error` 后「正常返回」；壳侧只在**抛异常**时记录失败，而视图合成里 `input.error ?? status.details?.errorMessage ?? remote.error` 被空串 `''` 短路 ⇒ 真实链路上 404 既不显示「更新失败」，也不显示「已是最新」，而是**「未检查」+ 一行英文原始错误**，错误文本进不了红色错误条。**

- 日期：2026-10-20
- 仓库：`dsh-desktop-bun`（`hyperion2144/dsh-desktop-bun`）
- 性质：只读调查；一手件为 Electrobun 对应 tag 的源码（`raw.githubusercontent.com/blackboardsh/electrobun`）
- 证据分级：【官方】= 上游框架源码原文；【实测】= 本机实跑观测；【推断】= 由上述推出、未实跑验证；【存疑】= 未找到一手明文
- 旁注：本机 hutch 装了 Electrobun **2.0.2** 与 **2.0.4** 两版（`~/.hutch/releases/electrobun/`），仓内未固化版本；本笔记两版都逐行核过，检查契约**完全一致**，故结论与版本无关
- 触发：#216「桌面壳『检查更新』在首个 Release 之前把 404 显示成失败态（应映射为『无更新』）」

## 1. 框架的检查契约：`checkForUpdate()` 永不抛

【官方】Electrobun v2.0.2 `package/src/sdks/main/core/Updater.ts`（v2.0.4 同款，行号差 2）：

`checkForUpdateOperation()`（v2.0.2 第 1744 行起）：

```ts
async function checkForUpdateOperation(): Promise<UpdateInfo> {
	emitStatus("checking", "Checking for updates...");
	const info = await Updater.getLocalInfo();
	...
	const updateInfoUrl = `${info.baseUrl.replace(/\/+$/, "")}/${platformPrefix}-update.json?${randomBytes(8).toString("hex")}`;
	try {
		const response = await fetch(updateInfoUrl, {
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		...
	} catch (error) {
		checkedManifest = undefined;
		const message = `Failed to check for updates: ${(error as Error).message}`;
		updateInfo = {
			version: "",
			hash: "",
			updateAvailable: false,
			updateReady: false,
			error: message,
		};
		emitStatus("error", message, {
			errorMessage: (error as Error).message,
			url: updateInfoUrl,
		});
		return updateInfo;   // ← 正常返回，不 rethrow
	}
}
```

要点：

- **404 的产生点**：`if (!response.ok) throw new Error(\`HTTP ${response.status}\`)` ⇒ 404 的错误文本就是字面量 `HTTP 404`。【官方】
- **失败被框架自己吞掉**：catch 块把错误转成 `emitStatus('error', …)` + `updateInfo.error`，然后 **`return updateInfo`** ⇒ 调用方的 `await checkForUpdate()` **永远 resolve，不会 reject**。【官方】
- `checkForUpdate()` 外层只做 in-flight 去重（`checkInFlight`），不改变这个结论。【官方】
- `const info = await Updater.getLocalInfo()` 在 try 之外，但 `getLocalInfo` 内部自带 try/catch（读不到 `version.json` 时返回空壳对象）⇒ 也不会让整条链 reject。【官方】
- 例外通道：`channel === 'dev'` ⇒ 直接 `emitStatus('no-update', 'Dev channel - updates disabled')`（dev 构建本来就关更新）；channel 不是合法 build environment ⇒ `emitStatus('error', 'Unsupported update channel: …')`。【官方】

## 2. 一次 404 的失败文本落在三处

| 落点 | 内容（404 时） | 取用方 |
| --- | --- | --- |
| `emitStatus('error', message, details)` 的 `message` | `Failed to check for updates: HTTP 404` | 壳侧 `status.message` → 视图 `view.message` |
| 同一条状态的 `details.errorMessage` | `HTTP 404` | 壳侧 `status.details?.errorMessage` |
| `updateInfo().error` | `Failed to check for updates: HTTP 404` | 壳侧 `remote.error` |

【官方】三处都在上面那段源码里；【实测】见 §4 的假实现（逐字照抄框架行为）。

## 3. 壳侧现状：两处错位叠在一起

【实测】壳侧代码（`desktop-electrobun/src/`）：

1. `src/bun/platform/updater.ts` 的 `run()`：`await call(updater)` **抛异常**才走 `remember(\`${action} 失败：…\`)`；不抛就 `failure = ''`。框架不抛 ⇒ `failure` 永远是空串。
2. `src/shared/runtime/update.ts` 的 `updateView()`：

```ts
const errorText = input.error ?? status.details?.errorMessage ?? remote.error ?? ''
```

`input.error` 恒为 `''`（空串，不是 `undefined`）⇒ `??` 短路 ⇒ `status.details?.errorMessage` 与 `remote.error` **永远读不到**。
3. 同函数的相位回落：`else if (phase === 'error' && errorText === '') phase = 'idle'` ⇒ 框架的 `status='error'` + 空错误文本 ⇒ 相位被回落成 **`idle`（标签「未检查」）**。

合起来：框架侧的失败在壳里既不是「更新失败」，也不是「已是最新」，而是**「未检查」**。

## 4. 实测复现（用真实壳代码 + 忠实模拟框架的假实现）

脚本 `/tmp/repro-216.ts`（只读诊断，未改仓内代码）：注入一个**照抄框架行为**的 `UpdaterLike`（check 时 emit `checking` → emit `error` → **不抛**、返回 `updateInfo`），再调壳侧 `createUpdater().check()`，读它合成出来的视图。

```
[framework-404]     phase=idle  label=未检查   error=""  message="Failed to check for updates: HTTP 404"  status=error  hint=""  canDownload=false
[framework-500]     phase=idle  label=未检查   error=""  message="Failed to check for updates: HTTP 500"  status=error  hint=""  canDownload=false
[framework-network] phase=idle  label=未检查   error=""  message="Failed to check for updates: The network connection was lost."  status=error  hint=""  canDownload=false
[no-update]         phase=up-to-date label=已是最新 error="" message="Already on latest version" status=no-update hint="0.1.0 已经是最新"
```

【实测】结论三条：

1. **404 不是「失败态」**（票面原话需修正）：`view.error` 为空 ⇒ 客户端的红色错误条不会出现。
2. **不只 404**：500、网络中断、非法 JSON、清单非法**全都长成同一个样子**（idle + 英文串）⇒ 真正的失败被吞。
3. **用户实际看到的**（见 §5）：`当前版本 0.1.0（stable）· 未检查` + 一行 `Failed to check for updates: HTTP 404`，点「检查更新」前后**看起来没区别**（hint 也是空）。

线上事实（【实测】2026-10-20）：

```
$ curl -sI https://github.com/hyperion2144/dsh-desktop-bun/releases/latest/download/stable-macos-arm64-update.json
HTTP/2 404
$ curl -sI https://github.com/hyperion2144/dsh-desktop-bun/releases/latest
HTTP/2 302
location: https://github.com/hyperion2144/dsh-desktop-bun/releases      # 没有 release ⇒ 302 落到列表页
```

与既有笔记一致（`docs/research/2026-10-20-github-releases-assets-latest-alias.md` §5：未创建 release 时 `releases/latest/download/*` = 404）——**那篇覆盖的是 GitHub 侧的 404 语义，不覆盖壳侧怎么把 404 显示出来**，故本篇另立。

## 5. 客户端渲染哪些字段（决定用户看到什么）

【实测】`desktop-plugin/src/client/desktop-settings/cards/update-card.tsx`（设置面板「应用更新」卡）渲染：

| 字段 | 渲染条件 | 404 时显示 |
| --- | --- | --- |
| `view.label` | 总是 | **未检查** |
| `view.message` | 非空 | `Failed to check for updates: HTTP 404`（英文原文，浅色说明行） |
| `actions.hint` | 非空 | （空 ⇒ 不渲染） |
| `view.error` | 非空 | （空 ⇒ **红色错误条不出现**） |
| `actions.canDownload` | — | false（`phase` 既不是 `available` 也不是 `error`） |

⇒ 用户看到的是「当前版本 0.1.0（stable）· 未检查」+ 一行英文错误，看不出「这个通道还没发过版」，也看不出「检查其实失败了」。

## 6. 对本仓的落点（供 #216 实施，勿当结论）

1. **先让错误可见**：`updateView()` 里 `errorText` 的取法改成「取第一个非空串」（`input.error` 为空串时继续看 `status.details?.errorMessage` / `remote.error`），并让 `status.status === 'error'` + 有错误文本 ⇒ 相位 `error`（当前被回落成 `idle`）。修完后 404 会显示红色「更新失败 / HTTP 404」——**这是中间态**，不是终点。
2. **再判 404**：壳侧需要区分「HTTP 404」与其它失败。判据二选一：① 解析框架给的错误文本（`HTTP 404`）；② 壳侧自己探一次 feed URL（`HEAD <feedUrl>` 看状态码）。②更硬、但多一次请求。
3. **404 的两种含义必须分开**：「仓库还没有任何 release」＝正常态（该通道尚未发布）；「release 存在但这个平台前缀的资产不在 latest 上」＝发布链路故障（#213 的 latest 纪律被破坏、移动端抢了 latest、清单名不匹配）——**后者不能静默成「无更新」**。用一次轻量探针（例如 `releases/latest` 的 302 落点：落回 `/releases` ⇒ 没有 release）可以把两者分开。【推断】
4. **语义与文案要定**：「尚未发布」和「已是最新」不是一回事，现有相位集合里只有 `up-to-date`（标签「已是最新」）⇒ 要么新增一个相位（如 `no-release`），要么复用并在文案上区分。
5. **测试要按真实契约写**：`desktop-electrobun/test/update.test.ts` 现有的「失败态」用例是让假实现**抛异常**且不 emit 任何状态——真实框架不抛 ⇒ 这条测试一直在验证一条不存在的路径。改完 fake（emit `error` + 不抛）后，「404 ⇒ 无更新」「其它错误 ⇒ 错误态且文本可见」才有意义。
6. **本地可验**：`DSH_SHELL_UPDATE_BASE_URL` 能把更新源指向本地静态目录（`desktop-electrobun/src/shared/runtime/update.ts` 注释明写「本地起一个静态目录就能验更新流程，不必真发版」）⇒ 不用真发版就能造「没有清单」与「有清单」两种情形。

## 证据清单

| # | 事实 | 分级 | 来源 |
| --- | --- | --- | --- |
| 1 | `checkForUpdate()` 内部 catch 住失败并正常返回，不 reject | 【官方】 | Electrobun v2.0.2 `package/src/sdks/main/core/Updater.ts` 第 1828–1843 行（v2.0.4 第 1830–1845 行同款） |
| 2 | `!response.ok` ⇒ `throw new Error(\`HTTP ${response.status}\`)` | 【官方】 | 同上，第 1780–1782 行 |
| 3 | 失败文本三落点（message / details.errorMessage / updateInfo.error） | 【官方】 | 同上，第 1829–1842 行 |
| 4 | `dev` channel 直接 `no-update`；非法 channel ⇒ `error` | 【官方】 | 同上，第 1757–1772 行 |
| 5 | 壳侧 `run()` 只在抛异常时记失败 | 【实测】 | `desktop-electrobun/src/bun/platform/updater.ts` `run()` |
| 6 | `updateView()` 的 `??` 被空串短路 + 相位回落 `error`→`idle` | 【实测】 | `desktop-electrobun/src/shared/runtime/update.ts` `updateView()` |
| 7 | 404 / 500 / 网络中断在壳里都渲染成「未检查」+ 英文串 | 【实测】 | `/tmp/repro-216.ts`（真实壳代码 + 忠实 fake）输出 |
| 8 | 线上 `releases/latest/download/stable-macos-arm64-update.json` = 404；`releases/latest` = 302 → `/releases` | 【实测】 | `curl -sI`（2026-10-20） |
| 9 | 客户端渲染 `label` / `message` / `hint` / `error` 四个字段 | 【实测】 | `desktop-plugin/src/client/desktop-settings/cards/update-card.tsx` |
| 10 | 「release 存在但资产不在 latest 上」时 URL 也返回 404 | 【官方】 | `docs/research/2026-10-20-github-releases-assets-latest-alias.md` §1/§5 |
| 11 | 用 `releases/latest` 的 302 落点区分「有没有 release」 | 【推断】 | 由 #8 的 302 → `/releases` 与「有 release 时 302 → `/releases/tag/<tag>`」推出，未实跑 |

## 未查到的明文

- Electrobun 没有公开的「错误分类」API（404 与 500 同样折叠成 `HTTP <code>` 文本），官方文档也没给「如何区分未发布」的指引 ⇒ 判据只能由壳侧自己定。【存疑】
- Electrobun 是否在某个版本改过 `checkForUpdate` 的 reject 语义：只核了 v2.0.2 与 v2.0.4 两版，更早/更晚版本未查。【存疑】
- `releases/latest` 在「有 release」时的 302 落点是否为 `/releases/tag/<tag>`：未实跑（仓库现在 0 release，造不出对照）。【存疑】

## 落地定稿（#216 实施，2026-10-20）

维护者拍板（Q1–Q4 全部按推荐）：

| 问 | 拍板 | 落点 |
| --- | --- | --- |
| Q1「尚未发布」用什么相位 | **新增 `no-release`**（不复用 `up-to-date`） | `src/shared/runtime/update.ts` 的 `UpdatePhase` + `UPDATE_PHASE_LABELS`（标签「暂未发布」）；`contracts/updates.ts` 同步 |
| Q2 404 怎么判、怎么区分二义性 | **先按错误文本判 `HTTP 404`，再用一次轻量探针区分** | 新文件 `src/bun/platform/release-probe.ts`：`HEAD <baseUrl 去掉 /download>`，302→`/releases` ⇒ 没有发布；302→`/releases/tag/…` ⇒ 有发布；探不到 ⇒ `unknown`（按没发布算，不猜） |
| Q3 是否同票修「所有框架侧错误被吞」 | **修** | `updateView()` 的错误文本改成「取第一个非空串」；相位不再从 `error` 回落 `idle`；`updater.ts` 的 `run()` 在**不抛**的框架失败上也记失败 |
| Q4 英文框架文案 | **中文化** | `classifyUpdateFailure()` 给中文说明：已知类别（404 / 5xx / 网络 / 清单非法）全中文，未知类别给中文前缀 + 原文 |

实现要点：

- 壳侧错误模型改成「**框架从不 reject**」：失败从 `updateInfo.error` / `status.details.errorMessage` 取，不再依赖抛异常（`src/bun/platform/updater.ts` 的 `run()`）。
- 404 二义性由 `releasePresence`（`present` / `absent` / `unknown`）区分：`present` ⇒ 报「这个版本里没有本平台的更新资产（发布链路可能漏传了）」；`absent` / `unknown` ⇒ 相位 `no-release`，`view.error` 为空、不出红色条。
- 线上实测（2026-10-20，`releases/latest` 302 → `/releases` ⇒ 没有 release）：404 ⇒ `phase=no-release`、label「暂未发布」、`view.error` 为空、message「这个通道还没有发布过版本，暂时没有可安装的更新。」
- 探测落点的推断（`/releases/tag/<tag>` ⇒ 有发布）仍未实跑（仓库 0 release，造不出对照）——但**不依赖**它：探不到时按「没发布」处理，代价是「有 release 但本平台资产漏传」这种故障会被显示成「暂未发布」。

新增/改动的文件：

- `desktop-electrobun/src/shared/runtime/update.ts`：`ReleasePresence` / `UpdateFailure` / `classifyUpdateFailure()` / `firstNonEmpty()` / `NO_RELEASE_MESSAGE`、新相位 `no-release`、错误文本与相位的修复。
- `desktop-electrobun/src/bun/platform/release-probe.ts`（新）：`releaseAliasUrl()` / `presenceFromResponse()` / `probeReleasePresence()`。
- `desktop-electrobun/src/bun/platform/updater.ts`：失败不再只靠抛异常、`probeRelease` 测试缝、日志动作名中文化。
- `contracts/updates.ts`：`UpdatePhase` 加 `no-release`（IPC 契约；插件端由 `Commands['get_update_state']['result']` 自动跟上）。
- `desktop-electrobun/test/update.test.ts`：假实现加 `failWith`（emit `error` + **不抛**，忠实框架契约）+ 9 条新用例。
- `desktop-electrobun/test/release-probe.test.ts`（新）：探测的别名 / 判定 / 请求三层 11 条用例。
