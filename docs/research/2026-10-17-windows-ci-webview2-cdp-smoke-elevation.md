# Windows CI 上 WebView2 DevTools CDP 探活：可行性调查（#109）

> 本文件是 #109 的权威调查笔记；早期同名草稿（结论「无阻塞」）已删除，勘误见 §8。

- 日期：2026-10-17
- 仓库：`dsh-desktop-bun`（Electrobun 2.0.2 + Bun 桌面壳），**只读调查**
- 触发：issue #109（#106 验收遗留）——在 GitHub Actions 的 Windows job 里，对**打包态、带窗口**启动的桌面壳做 DevTools CDP `/json/version` 探活
- 调查方式：一手件＝MicrosoftDocs WebView2 API 参考（win32-reference 仓库）、Chromium 源码、`blackboardsh/electrobun` 源码与其 CI、`actions/runner-images` 仓库与 issue、GitHub Docs、WebView2Feedback 上游 issue；辅以本仓 `desktop-electrobun/src/bun/{index,devtools}.ts`、`src/shared/settings.ts`、`.github/workflows/{build,installer-ui}.yml`
- 证据分级：【官方】官方文档/官方仓库/上游 issue（含维护者结论）；【源码】可引行号的上游源码；【实测】本仓既有 CI 的既成事实；【推断】由前两类推出、未经实跑验证；【二手】转述，仅供参考

## 0. 结论速览

| # | 问题 | 结论 | 分级 |
|---|---|---|---|
| 1 | `windows-latest` 是哪张镜像 | Windows Server 2025 x64；image `20261013.288.2`，OS `10.0.26100 Build 33438`，Edge `155.0.4283.45` | 【官方】 |
| 2 | WebView2 Runtime 是否预装 | **在，但不是镜像的安装项**：随 Edge 上机（同版本时 Edge 与 Evergreen Runtime 硬链接），runner-images 明说「我们不单独 ship WebView2 版本，WebView2 是 Edge 安装的一部分」，同时明说它是 Evergreen、**不受镜像管控、会自己漂** | 【官方】 |
| 3 | runner 会话是交互桌面吗 | 是。有 `Shell_TrayWnd` 任务栏、可 `SendKeys`、应用窗口会被首启 OOBE 窗口盖住（上游 CI 为此显式压策略） | 【源码】+【实测】 |
| 4 | runner 是否提权 | **是，且 UAC 关闭**——GitHub Docs 原文「Windows virtual machines are configured to run as administrators with User Account Control (UAC) disabled」 | 【官方】 |
| 5 | CDP HTTP 端点形态 | `GET /json/version` → 200，JSON 含 `webSocketDebuggerUrl`（`ws://<Host 头><browser_guid>`）、`Protocol-Version`、`Browser`、`User-Agent`、`V8-Version` 等。**Host 头必须是 IP 或 localhost**，否则直接 500 | 【源码】 |
| 6 | 要不要 `--remote-allow-origins` | **不要**。它只管 WebSocket 的 Origin 校验，`/json/version` 是纯 HTTP GET | 【源码】 |
| 7 | 何时开始监听 | **建 WebView2 environment 时**。Electrobun 每 view 调一次 `CreateCoreWebView2EnvironmentWithOptions` ⇒ 无窗口模式（`DSH_SHELL_NO_WINDOW=1`）根本不建窗 ⇒ 没有 environment，env 写了也无人读 | 【源码】 |
| 8 | 我们的 env 会被 Electrobun 覆盖吗 | 不会。Electrobun 用 `put_AdditionalBrowserArguments` 写死自己那串；官方语义是 env/注册表参数**追加**在 API 参数之后 | 【源码】+【官方】 |
| 9 | **致命项** | Runtime **150 起**，宿主处于高完整性（提权）时 WebView2 **按设计丢弃 `WEBVIEW2_*` 环境变量与 HKCU 策略**，只认 API 直传与 HKLM 策略。叠加 #4 ⇒ **`SetEnvironmentVariableA` 这条路在当前 windows-latest 上开不出 9333** | 【官方】 |
| 10 | 已辟谣 | 「CDP 端点全局卡死回归」（#5685）由报告者自行撤回，实为其宿主死锁的下游症状，不是 WebView2 问题 | 【官方】 |

**一句话**：CDP 端点语义与 GUI 可行性都没问题；**唯一让 #109 必须改方案的是 #9**，而它有官方支持、且**不需要动壳代码**的绕法（HKLM 策略）。

## 1. 镜像与 WebView2 Runtime 供给（Q1）

- `windows-latest` = Windows Server 2025：`actions/runner-images/README.md:37` 列出 `windows-latest, windows-2025, windows-2025-vs2026`。
- 当前镜像清单 `images/windows/Windows2025-Readme.md:6-8`、`:114-115`：只有 Edge / Edge Driver `155.0.4283.45`，**没有 WebView2 Runtime 条目**；`actions/runner-images` 全仓代码检索 `WebView2` 命中 0 ⇒ 镜像没有专门安装它的脚本。
- 但机器上确实有，来源是 Edge 安装：
  - 官方文档：「On eligible systems, binaries for Microsoft Edge and the Evergreen WebView2 Runtime are **hard-linked together** when they are on the same version」——<https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution>。
  - runner-images 维护者原话：`We do not ship a separate version of WebView2 and as far as I remember WebView2 itself comes as a part of the edge installation`——actions/runner-images#9538 评论。
  - 真机取证：`windows-2025-vs2026` 上 `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` → `pv 152.0.4191.66`，`C:\Program Files (x86)\Microsoft\EdgeWebView\Application\152.0.4191.66` 存在——actions/runner-images#14738。
- **不稳定**：同 issue 维护者结帖称该 runtime 是 Evergreen、**不由镜像安装/固定**（`we only ship msedgedriver for the full Edge browser`），会随时间前滚。【官方】
- 结论【推断】：镜像 Edge 155 ⇒ WebView2 Runtime 同在 155 版本线 ⇒ **≥150，落在 §4 的问题区间内**。
- **兜底配方**（镜像若哪天真没 runtime）：Bootstrapper 约 2 MB（distribution 文档），URL `https://go.microsoft.com/fwlink/p/?LinkId=2124703`，`/silent /install`，装完查上面那个 `pv` 键（distribution 文档「Detect if a WebView2 Runtime is already installed」两处 64 位路径）。Electrobun 上游已把这套做成脚本，可直接抄：`package/scripts/webview2-runtime.mjs`（探测→缺失才装→装后再探，5 分钟总预算）+ `webview2-runtime.ps1`（下载 + `Get-AuthenticodeSignature` 验 `O=Microsoft Corporation`）。

## 2. runner 会话实况（Q2）

- **提权 + UAC 关闭**：GitHub Docs「GitHub-hosted runners → Administrative privileges」——<https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges>。【官方】
- **真交互桌面**：`blackboardsh/electrobun` 的 `.github/workflows/desktop-smoke.yml`（`runs-on: windows-2025`）为跑 GUI 冒烟做了三件事，注释自陈「first-sign-in privacy setup **covering all app windows**」：写 `HKLM/HKCU\SOFTWARE\Policies\Microsoft\Windows\OOBE\DisablePrivacyExperience=1`、用 `System.Windows.Forms.SendKeys::SendWait('{ESC}')` 赶走开始菜单浮层、`FindWindow('Shell_TrayWnd')` 确认任务栏存在（不存在就自己起 `explorer.exe`），并打印 `Runner session: $((Get-Process -Id $PID).SessionId)`。【源码】
- 旁证：actions/runner-images#14069 的截图就是 runner 上的 OOBE 隐私窗口；本仓 `.github/workflows/installer-ui.yml` 在 `windows-latest` 上跑 NSIS UI 并把每页真实渲染位图落成 PNG。【实测】
- 代价：Server 2025 无 GPU、无输入设备，WebView2 走 Chromium 软件合成回退；未找到任何一手件表明这是阻断条件。上游在同一张镜像上跑真实 WebView2 窗测试（`package/scripts/test-windows-webview2-window.mjs`，注释自陈「A working installed WebView2 runtime is required; setup failures cannot skip this gate」）。【源码】
- 坑：Windows 11 arm 镜像首启 OOBE 窗口会盖住应用窗口（#14069）。`windows-latest` 通常无此问题，但**保险起见冒烟前压一条 `DisablePrivacyExperience`**（抄上游那 6 行）。【官方】+【推断】

## 3. CDP 端点语义（Q3）

一手来源：Chromium `content/browser/devtools/devtools_http_handler.cc`（`main`）。

- 响应体：`devtools_http_handler.cc:626-641` 组装 `Protocol-Version`、`WebKit-Version`、`Browser`、`File-Path-Style`、`User-Agent`、`V8-Version`，以及 `kTargetWebSocketDebuggerUrlField`（`:88` 定义为 `"webSocketDebuggerUrl"`），值为 `ws://<Host 头><browser_guid>`。
- Host 校验：`ServerWrapper::OnHttpRequest` 先过 `RequestIsSafeToServe`，不过就 `Send500(... "Host header is specified and is not an IP address or localhost.")`（`:471-475`；WebSocket 入口同款，`:526-529`）⇒ 用 `127.0.0.1` 轮询安全；用机器名/容器名会被拒。
- `--remote-allow-origins`：`:959-968` 只解析进 `remote_allow_origins_`，仅在 WebSocket 升级路径校验 Origin；`/json/version` 不经该路径。
- 绑定：端点由 `DevToolsSocketFactory::CreateForHttpServer` 起（`:289`），不给 `--remote-debugging-address` 时只监听回环（未逐行读到 factory 实现，必要时以真机 `netstat -ano | findstr 9333` 复核）。
- WebView2 侧官方背书：`WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER` 一节写明「To enable debugging of the targets identified by the JSON, you must set the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable to send `--remote-debugging-port={port_num}`」——`MicrosoftDocs/webview2-win32-reference` → `1-0-1185-39/webview2-idl.md:102-104`。

## 4. 致命项：提权宿主丢 env（决定 #109 要改方案）

- 官方语义：env/注册表里的 `additionalBrowserArguments` 是**追加**在 API 参数之后；env 表为 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` / `WEBVIEW2_USER_DATA_FOLDER` / `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` / `WEBVIEW2_RELEASE_CHANNEL_PREFERENCE`（`1-0-1185-39/webview2-idl.md:72-83`）。
- Runtime 150 的硬化（微软工程师 krbharadwaj 在 WebView2Feedback#5640 的结帖原文）：

  > In Runtime 150 we added a security hardening for scenarios involving an elevated (High-integrity) host process. To close a local privilege-escalation gap, WebView2 now **ignores command-line switch overrides and HKCU policy values when read from an elevated process**. When the host is elevated, only HKLM policy and arguments the app passes directly via the API are honored — the user-writable channels (`WEBVIEW2_*` environment variables and HKCU) are intentionally dropped. … **This is by design.**

  同帖 ProcMon 佐证：非提权 `msedgewebview2.exe` 命令行里有 `--remote-debugging-port=9222`，提权那份没有。复现矩阵：149 提权 ✅ / 150 提权 ❌ / 150 非提权 ✅。
- 叠加 §2 ⇒ `SetEnvironmentVariableA` 在当前 windows-latest 上必然开不出 9333。
- **官方绕法（不动壳代码）**（同帖 + `1-0-1185-39/webview2-idl.md:112-140`）：

  ```text
  [{Root}]\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments
  "{AppId}"=""
  ```

  `Root` 先查 `HKLM` 再查 `HKCU`；`AppId` 先取进程 AUMID，再取编译 code name，都没有则回落 `*`。⇒ CI 里给 **`HKLM\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments` 的（默认）空名字符串**写 `--remote-debugging-port=9333`。注意这是**追加**语义，不会覆盖 Electrobun 的参数。

## 5. Electrobun win 原生壳（Q5）

上游 `blackboardsh/electrobun`（`main`）`package/src/native/win/nativeWrapper.cpp`：

- `:8128` `options->put_AdditionalBrowserArguments(L"--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --allow-insecure-localhost --disable-web-security")`。配合 §4「追加」语义：`--remote-debugging-port` 排在其后，**不用改上游**。
- `:8168-8196` 每个 view 单独算 UDF：`buildWebView2UserDataPath(localAppData, identifier, channel, partition, view->webviewId)`，用 `SHCreateDirectoryExW` 建目录、`canPersistWebView2UserDataPath` 预先查剩余空间。
- `:8197-8199` `CreateCoreWebView2EnvironmentWithOptions(nullptr, userDataFolderPtr, options.Get(), handler)` —— **这就是 environment 创建点，即 splash 窗那一路**。
- `:8203-8206` 失败形态：`ERROR: CreateCoreWebView2EnvironmentWithOptions failed with HRESULT: 0x%08X`。缺 runtime 时官方错误表（`webview2-idl.md:144-155`）给 `HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)`（*Could not find Edge installation*）或 `E_FAIL`（*Edge runtime unable to start*）⇒ CI 失败时 grep 这一行即可自证是 runtime 问题还是别的问题。

本仓对应点：

- `src/bun/index.ts:94-107` 三处开关：win 构建 `renderer = 'native'`、`defaultRenderer` 期望 `'native'`、不打 CEF ⇒ splash 与主窗都进 `WebView2View`。
- `src/bun/index.ts:176-186`：env 决策在模块顶层、任何窗之前做完；`index.ts:1600` `startupSplash()` 首行 `if (noWindow) return null`；`index.ts:1683` `splash = startupSplash()`；`index.ts:1721` `if (!noWindow)` 才 `createProfileWindow`。⇒ **`DSH_SHELL_NO_WINDOW=1` 时一个窗都不建、一个 environment 都不建**。
- `src/bun/index.ts:1723-1729`：`service.state.status !== 'running'` 时壳**故意不建桌面窗口**（#117 死局出口）⇒ 冒烟必须等 DSH 真起来之后才有窗。
- `src/bun/devtools.ts:83-96`：`!isPackaged` → `enableCdp: false`，只打印 `dev-build` ⇒ CI 必须走打包路径。
- `src/bun/devtools.ts:123-141`：win 走 `dlopen('kernel32.dll').SetEnvironmentVariableA`；`:151-166` 已有值时追加而非覆盖。
- `src/bun/index.ts:193` 的 `[shell] 开发者工具：已开启，WebView2 远程调试口 127.0.0.1:<port>…` 是唯一能证明「决策成立」的日志 ⇒ 冒烟先 grep 它，再轮端口。
- 设置开关：`<DSH_HOME>/desktop-settings.json` 写 `{"devTools": true/false}`（`src/shared/settings.ts:147,344` 同时接受驼峰与下划线）。**目前没有任何 env 能强开 dev_tools**，只能写设置文件。

## 6. 其它坑与已辟谣项（Q4）

- **UDF 与多实例**：UDF 按 `view->webviewId` 分 ⇒ splash 与主窗是**两套 profile、两组浏览器进程**，都吃同一份 `AdditionalBrowserArguments`。同端口只会有一组 bind 成功，对探活无害，但会看到多份 `msedgewebview2.exe`；收尾清理按安装目录枚举进程（`scripts/build-windows-installer.mjs:386` 已这么干）。
- **无 `--no-sandbox` 需求**：WebView2 由宿主直接创建，不受 Chrome 那套 sandbox 启动参数约束；未找到任何一手件要求 CI 补它。【推断】
- **已辟谣**：「DevTools/CDP HTTP endpoint accepts TCP but never responds…（自 2026-08-30 起全局回归）」WebView2Feedback#5685 —— 报告者自行撤回：根因是其宿主进程自死锁（Rust 结构体字面量跨字段重入同一 mutex，UI 线程卡在 `NtUserSetFocus`），端点卡住只是下游症状，修掉后同机同 runtime 全绿。**不要据此认定 runner 上的 CDP 不可靠**。【官方】
- **仍在开放的相关上游问题**：#5718（runtime 153 上非提权宿主远程调试端点拒绝连接，自述 related to #5640）、#5645（runtime 150 上连不上远程调试口）、#5174（`--remote-allow-origins` 不生效）。⇒ **CDP 面在 150+ 处于活跃回归期**，断言要能区分「口没开」与「口开了但不回」。
- **并列记录**：actions/runner-images#14738 报告 Windows-2025 上 `WebView2 + msedgedriver` 从 runtime 133 起的上游回归（`session not created: DevToolsActivePort file doesn't exist`），同提交在 windows-2022 上 8/8 绿。我们不碰 WebDriver，但同属调试面。

## 7. 对 #109 的影响、风险与建议

### 7.1 方案必须改的一处（阻断级）

现方案「dev_tools 开 → 壳内写 env → 期待 9333 起」在提权 runner 上必红。改法（**不改壳/插件代码**，符合 #109 的 Out of scope）：冒烟在拉起产物**之前**写 HKLM 策略，值名用 `*`（官方解析：AUMID → 编译 code name → `*` 回落；`*` 即所有应用）；这是**追加**语义，不会覆盖 Electrobun 自己的参数。

```powershell
$key = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey('SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments')
$key.SetValue('*', '--remote-debugging-port=9333', [Microsoft.Win32.RegistryValueKind]::String)
$key.Close()
# 关态/收尾：
# [Microsoft.Win32.Registry]::LocalMachine.DeleteSubKeyTree('SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments', $false)
```

⚠️ HKLM 策略是**全局**的，会同时作用于「dev_tools 关」那一态 ⇒ 关态也会开口。**两态必须靠「写不写这个键」区分**，各自用干净注册表（跑完清理该键，或拆成两个 job/两个 runner）。另建议在代码注释里写明：这等价于 IT 强推策略，只在一次性 CI runner 上使用，不是产品路径。

### 7.2 同一步里的其余前置

1. **不能设 `DSH_SHELL_NO_WINDOW=1`**（`index.ts:1600/1721`）——否则没有 environment。建议与现有无窗口冒烟拆成两次拉起。
2. **必须打包态**（`devtools.ts:83-85`），并先 grep `index.ts:193` 的日志再轮端口。
3. **开关态用设置文件注入**（`desktop-settings.json`），没有 env 可用。
4. **runtime 前置检查**：按 distribution 文档的 `pv` 键查一次，缺失就照 Electrobun 上游 `webview2-runtime.mjs` 那套装 Bootstrapper（下载 → 验签 → `/silent /install` → 复探）。
5. **桌面卫生**：拉起前写 `DisablePrivacyExperience=1`（抄 `desktop-smoke.yml:92-100`）。
6. **窗口要真能建出来**：等 DSH 起来之后才有窗；轮询预算按现冒烟量级（600s）。

### 7.3 断言写法

- 开态：`curl.exe -s --noproxy '*' --max-time 5 -o body -w '%{http_code}' http://127.0.0.1:9333/json/version` = 200 且 body 含 `webSocketDebuggerUrl`。**必须用 `--noproxy '*'`**：runner 上若有 `HTTP_PROXY`，curl 会把 `127.0.0.1` 也发给代理，得到非 200/非 7 的结果。**Host 头必须是 `127.0.0.1`**（§3）。加一条软断言：`Get-CimInstance Win32_Process -Filter "name='msedgewebview2.exe'" | Select CommandLine` 打出来，失败时一眼看出开关有没有传下去——这正是 #5640 的定位手段。
- 关态：不写 HKLM 键启动，`curl.exe --noproxy '*' --max-time 5 …` 期望连接拒绝（Windows curl 退出码 7 / WinSock 10061），至少探 3 次，且壳日志无调试口行。注意区分「连接拒绝」与「连上不回」（§6 的 150+ 回归）。
- PowerShell 细节：`-s` 而非 `-sS`，`2>$null`，不要 `2>&1` 合并流（native stderr 在 `$ErrorActionPreference='Stop'` 下会被当错误记录）。

### 7.4 残留风险

- **CDP 面在 Runtime 150+ 是活跃回归期**（§6）。建议这条冒烟允许 retry 或先记为 flaky 并记录，而不是一上来做成硬门禁——否则第一次 Evergreen 滚动更新就会把 job 打红，而红的原因不在本仓。
- **WebView2 Runtime 版本不由镜像 pin**，同一天两次 CI 可能跑在不同 runtime 上；建议把实际 runtime 版本打进 job summary 便于日后定位。

## 8. 对另一份同名草稿的勘误

`2026-10-17-windows-ci-webview2-cdp-smoke.md` 那份草稿结论为「可行，无阻塞项」，以下逐条更正（保留其仍有效的操作建议：§7.3 的 `--noproxy '*'`、PowerShell stderr 注意事项、收尾杀进程树）：

1. **遗漏了 §4 的阻断项**（提权宿主丢弃 `WEBVIEW2_*` env，Runtime ≥150，by design）——这是结论从「无阻塞」改为「方案必须改」的唯一原因。
2. 函数签名错：草稿写 `planDevToolsBoot({ platform, devTools, explicitPort, env })`，实际是 `planDevToolsBoot({ isPackaged, settingOn, envOverride, isFree })`（`src/bun/devtools.ts:77-96`），且**漏了 `isPackaged` 这个决定性前置**。
3. 行号错：草稿把调用点写成 `src/bun/index.ts:1258-1277`，实际在 `src/bun/index.ts:176-186`（devtools 决策）、`:193`（成功日志）。
4. 设置键错：草稿写 `normalizeDevTools` 只认 `true/false`，实际归一化在 `src/shared/settings.ts:344`（`devTools: bool(pick('devTools','dev_tools')) ?? base.devTools`）。
5. 环境变量名错：草稿写 `DSH_SHELL_DEVTOOLS_CDP_PORT`，实际是 `DEVTOOLS_PORT_OVERRIDE_ENV`（见 `devtools.ts` 顶部常量），默认口 9333。
6. 证据误读：草稿把 #5685 当作「windows-2025 runner 上 `/json/version` 返回 200」的实测证据。该 issue 已被报告者撤回（根因是宿主死锁），不能单独作为「runner 上 CDP 可用」的证据；§1 的 runtime 在场结论改用 runner-images#9538 维护者原话 + #14738 的注册表/`EdgeWebView\Application` 路径取证。
7. 草稿称维护者回复是「我们并不安装 WebView2；agent 上呈现的版本与 Azure 基础镜像一致」——这是转述且方向偏了；维护者实际说的是「WebView2 随 Edge 安装而来」，且另一条维护者结帖明确该 runtime 由 Evergreen 自己滚、**镜像不 pin**（见 §1）。

## 附录：一手证据清单

| 结论 | 来源 |
|---|---|
| `windows-latest` = Server 2025；镜像/Edge 版本 | `actions/runner-images` `README.md:37`、`images/windows/Windows2025-Readme.md:6-8,114-115` |
| WebView2 随 Edge 上机、不由镜像 pin | distribution 文档；actions/runner-images#9538、#14738 |
| runtime 检测注册表 / Bootstrapper / Fixed Version | <https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution> |
| env/注册表参数「追加」语义、env 表、`--remote-debugging-port` 官方背书、注册表策略路径、错误表 | `MicrosoftDocs/webview2-win32-reference` → `1-0-1185-39/webview2-idl.md:72-83,102-104,112-140,144-155` |
| `/json/version` 字段、Host 校验、`--remote-allow-origins` 作用域 | Chromium `content/browser/devtools/devtools_http_handler.cc:88,289,471-475,526-529,626-641,959-968` |
| 提权宿主丢弃 `WEBVIEW2_*` env（150+，by design） | WebView2Feedback#5640（krbharadwaj 2026-07-09 结帖 + ProcMon 证据） |
| 「CDP 端点全局回归」不成立 | WebView2Feedback#5685 报告者撤回说明 |
| Windows-2025 上 WebView2+msedgedriver 回归 | actions/runner-images#14738；WebView2Feedback#5415/#5718/#5645/#5174 |
| runner 提权 + UAC 关闭 | <https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges> |
| runner 是真交互桌面、OOBE 抢焦点 | `blackboardsh/electrobun` `.github/workflows/desktop-smoke.yml:88-130`；actions/runner-images#14069 |
| Electrobun WebView2 environment 创建点与参数 | `blackboardsh/electrobun` `package/src/native/win/nativeWrapper.cpp:8128,8168-8196,8197-8199,8203-8206` |
| runtime 缺失时怎么装（可抄） | `blackboardsh/electrobun` `package/scripts/{webview2-runtime.mjs,webview2-runtime.ps1,test-windows-webview2-window.mjs}` |
| 本仓无窗口模式不建窗 / 打包态才开口 / 设置键 | `desktop-electrobun/src/bun/index.ts:176-186,193,1600,1683,1721-1729`；`devtools.ts:77-96,123-141,151-166`；`src/shared/settings.ts:147,344`；`.github/workflows/build.yml:186-263`、`.github/workflows/installer-ui.yml` |
