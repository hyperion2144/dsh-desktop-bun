# Windows 托盘「重启应用」第二次 launcher-unknown：诊断调查（#167）

- 日期：2026-10-18
- 仓库：`dsh-desktop-bun`（Electrobun 2.0.2 + Bun 桌面壳），**只读诊断，未改业务代码**
- 触发：issue #167 —— Windows 11 打包态，托盘「重启应用」第一次成功、第二次稳定报「探测不到桌面壳可执行文件（ELECTROBUN_LAUNCHER_PID / ppid 都没解析出来）」
- 调查方式：本仓源码、Electrobun v2.0.2 上游源码（`package/src/launcher/main.zig`、`package/src/core/main.zig`、`package/src/native/win/nativeWrapper.cpp`）、构建产物（`windows-x64` artifact + NSIS 安装包）、CrossOver/Wine 实测
- 证据分级：【源码】可定位的上游/本仓源码；【实测】本机可复现实验；【推断】由源码与实测推出、未在 Windows 真机验证；【待证】需要报告人环境数据

## 0. 结论速览

| # | 问题 | 结论 | 分级 |
|---|---|---|---|
| 1 | 报错发生在哪条路径 | `index.ts` 的 `restartDesktopApp()` 每次重启都重新调 `resolveLauncherExecutablePath()`；返回 `null` 就走 `planRelaunch()` 的 `launcher-unknown`，弹通知且不退出 | 【源码】 |
| 2 | 为什么不复用启动时已解析的路径 | `restartDesktopApp()` 没有使用 `layout()` 的 `launcherPath`，也没有复用 `shellProjectRoot()` 的 fallback 链/缓存 | 【源码】 |
| 3 | 第一次为何能成功 | 第一次调用时 `ELECTROBUN_LAUNCHER_PID` 的 CIM/`ps` 查询拿到了路径；第二次查询失败（具体触发未在 Win11 取证） | 【推断】 |
| 4 | 空输出会怎样 | `defaultLauncherRun` 只把非空首行当路径；**status=0、stdout 为空**也返回 `null`，随后 `launcher-unknown` | 【源码】+【实测】 |
| 5 | 真机根因 | 未确认。最可能是接班实例里 PID→路径查询失败（launcher 已退出 / CIM 空或失败 / PID 过期），但本机没有 Win11，不能把候选当结论 | 【待证】 |
| 6 | 修复方向 | 冷启动时缓存 launcher 路径（并校验存在），重启时优先新鲜解析、失败回退缓存/布局/同目录 `launcher.exe`；补日志（PID、ppid、命令、status、stdout/stderr）与单测 | 【推断】 |

**一句话**：代码把「重启入口」绑在「每次现场用 PID 反查 launcher 路径」上；只要第二次反查失败，即使 `launcher.exe` 就在安装目录里，也会报 `launcher-unknown`。先把路径来源做成可缓存、可回退、可诊断，才是可验收的修复；真机触发条件由新日志继续定位。

## 1. 本仓路径与失败链

### 1.1 托盘入口

- `desktop-electrobun/src/bun/index.ts` 的托盘动作：
  - `onTrayAction` 的 `case 'restart-app'` → `restartAppFromTray()`。
  - `restartAppFromTray()`（约 `:1147`）只做两件事：`await restartDesktopApp()`；失败时 `refreshTray()`。
- `restartDesktopApp()`（约 `:1119`）：
  ```ts
  const plan = await relaunchDesktopApp({
    isPackaged: build.isPackaged,
    launcherExe: resolveLauncherExecutablePath(),
    pid: process.pid,
    onLog: (line) => console.log(line),
  })
  if (!plan.ok) {
    notifier.notify(SCENARIO.STARTUP_ERROR, '重启桌面应用未完成', plan.message)
    return { ok: false, reason: plan.reason, message: plan.message }
  }
  await shutdown()
  ```
  - **关键点**：`launcherExe` 是每次调用时现场解析的，没传 `layout()` 的 `launcherPath`，也没有缓存。

### 1.2 解析实现

`desktop-electrobun/src/bun/runtime.ts:311` `resolveLauncherExecutablePath(env, ppid, run, readlink, platform)`：

- 优先 `env.ELECTROBUN_LAUNCHER_PID`（必须是纯数字）；否则 `ppid > 1 ? String(ppid) : null`。
- `win32`：
  ```
  powershell -NoProfile -Command
  (Get-CimInstance Win32_Process -Filter "ProcessId=<pid>").ExecutablePath
  ```
  超时 8s；只取 stdout 第一个非空行；空行/非零退出 → `null`。
- `darwin`：`/bin/ps -p <pid> -o comm=`；`linux`：`/proc/<pid>/exe`。
- **没有任何 fallback**：不查安装布局、不查同目录 `launcher.exe`、不查启动时缓存。

`desktop-electrobun/src/bun/runtime.ts` 的 `layout()` 在启动时也会调 `resolveLauncherExecutablePath` 得到 `launcherPath`；`shellProjectRoot()` 还有 `DSH_SHELL_PROJECT ?? packagedRootFromLauncher ?? packagedRootFromProcess ?? findProjectRoot(...) ?? ...` 的 fallback 链，且 `launcherExeCache` 会缓存一次。**但 `restartDesktopApp()` 不复用这些结果。**

### 1.3 失败消息

`desktop-electrobun/src/bun/app-restart.ts` 的 `planRelaunch()`：

- `!isPackaged` → `dev-build`；
- `null` / 空串 / 纯空白 → `launcher-unknown`：
  ```
  探测不到桌面壳可执行文件（ELECTROBUN_LAUNCHER_PID / ppid 都没解析出来），无法自动重启。请手动重启应用。
  ```
- spawn 抛错 → `spawn-failed`。

`relaunchDesktopApp()` 用 `env = {...process.env, DSH_SHELL_RELAUNCH_PID: String(pid)}`，`defaultSpawn` 用：

```ts
Bun.spawn([exe], { env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
```

随后 `proc.unref()`，**没有 `detached: true`，也没有诊断输出**。

## 2. Electrobun 2.0.2 的 launcher 生命周期（上游源码）

### 2.1 launcher 会重写 `ELECTROBUN_LAUNCHER_PID`

`package/src/launcher/main.zig` 的 `configureInstallRootEnv()`：

1. `environ_map.swapRemove(install_root_name_environment_variable)`；
2. `environ_map.swapRemove(launcher_pid_environment_variable)`；
3. `environ_map.put(launcher_pid_environment_variable, launcherProcessId())`。

所以冷启动/每次 relaunch 后，新 launcher 都会把 `ELECTROBUN_LAUNCHER_PID` 覆盖成自己的 PID；理论上接班实例不应拿到旧 launcher 的 PID。

### 2.2 Windows 非 dev 的 GUI 分支

`use_gui_mode = builtin.os.tag == .windows and !is_dev_build`。生产安装包走：

```zig
CreateProcessW(
  null, cmd_line_w,
  null, null, .FALSE,
  CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
  environment_block, exe_dir,
  &si, &pi,
);
// ...
WaitForSingleObject(pi.hProcess, INFINITE);
```

子进程 argv 是 `<exe_dir>/bun.exe` + `<exe_dir>/../Resources/main.js`；launcher **一直等到子进程退出** 才退出。dev/non-Windows 走 `std.process.spawn` + inherited I/O，同样等待。

### 2.3 Windows 安装树

构建产物（installer 解包）是：

```
bin/  launcher.exe  bun.exe  ElectrobunCore.dll  libNativeWrapper.dll  libasar.dll
Resources/  main.js  build.json  version.json  app/bun/index.js  app/dsh/...
```

- `Resources/main.js` 是 **Electrobun 的 JS launcher**（`src/launcher/main.ts` 编译产物），不是壳业务入口。
- 它读 `version.json` / `build.json`，选择 `bin/bun.exe`；然后 `new Worker(Resources/app/bun/index.js)` 启动壳 Worker，并在主线程调 `electrobun_core_run_main_thread(...)`。
- 因此 **壳业务代码的 `process.pid` 就是 `bun.exe` 的 PID，父进程是 `launcher.exe`**；不是 launcher 再 fork 一个独立壳进程。`process.ppid` 应等于 `ELECTROBUN_LAUNCHER_PID`（在 launcher 正常存活时）。
- `build.json` 为 `{"mainProcess":"bun","electrobunVersion":"2.0.2","runtimeVersions":{"bun":"1.4.0"},"defaultRenderer":"native",...}`；`version.json` 的 `channel` 是 `stable`（非 dev）。

### 2.4 退出路径

- 壳 `shutdown()`（`index.ts:1829`）先 `tray.destroy()`、停 DSH 服务、`releaseInstance()`，最后 `Utils.quit()`。
- `Utils.quit()` → FFI `quitGracefully({code, timeoutMs:5000})` → core `quitGracefully`：`stopEventLoop()` + `waitForShutdownComplete(timeoutMs)` + `forceExit(code)`；`forceExit` 是 native wrapper 的 `_exit(code)`。
- **没有看到任何显式杀子进程的代码**；因此「壳退出会杀 launcher」在当前源码里找不到依据（但这不等于真机不会发生，见 §4）。

## 3. 本机可复现的失败模式（CrossOver/Wine，非 Win11）

> 目的：验证「只要 PID→路径查询返回空，即使 launcher 活着也会走 `launcher-unknown`」；**不是**宣称复现了报告人的 Win11 根因。

### 3.1 实验设置

- 用 CrossOver 26.3 的 Wine bottle `dsh-ui-test` 跑 **Windows 版 launcher.exe / bun.exe**（x64）。
- 从 Windows installer 解包出完整 `bin/` + `Resources/`，把 `Resources/app/bun/index.js` 换成测试 Worker：
  - 启动时记录 `process.pid`、`process.ppid`、`ELECTROBUN_LAUNCHER_PID`；
  - 调用一次与 `resolveLauncherExecutablePath` 完全相同的 PowerShell CIM 查询；
  - 用 `Bun.spawn([launcher.exe], {stdio:'ignore'})` + `unref()` 拉起下一代；
  - 1.5s 后 `process.exit(0)`，模拟旧壳退出。
- 运行真实 `bin/launcher.exe`，观察 3 代进程。

### 3.2 结果

- 进程链稳定：`launcher.exe(PID L0) → bun.exe(PID S0)`；S0 拉起 `launcher.exe(L1)`；S0 退出；`bun.exe(S1)` 的 `ppid=L1`、`ELECTROBUN_LAUNCHER_PID=L1`；S1 再拉 L2，S1 退出；S2 正常启动。**launcher 在子进程存活期间没有提前退出**。
- **但**：测试 Worker 对活着的 launcher PID 执行同一条 CIM 命令，返回 **exit status 0、stdout 为空、stderr 为空**：
  ```
  {"event":"app-start","pid":1248,"ppid":1236,"launcherPid":"1236"}
  {"event":"cim","status":0,"out":"","err":""}
  ```
  `resolveLauncherExecutablePath` 会把空行判为 `null` ⇒ `planRelaunch` 报 `launcher-unknown`。
- 这说明：
  1. **failure mode 可确定复现**：status=0 + 空输出就是 `null`；
  2. 「launcher 活着」和「CIM 能查到路径」是两件事，代码把后者当作前者；
  3. Wine 的 CIM 不可用导致空输出，但**真机 Windows 上也可能因 PATH/权限/WMI/超时/编码等原因得到空输出**，需要现场日志区分。

### 3.3 未能复现报告人真机症状

- Wine 的 CIM 与 Windows 11 的 WMI/CIM 行为不同；本机无 Windows 11 真机。
- 另外，用完整真实壳跑 Wine 时，壳在 `Failed to create hotkey window` 后 Worker 启动即卡住（Wine/WebView2 环境限制），无法走托盘点击路径。
- 因此 **不能** 把 Wine 的空输出直接当作报告人的根因；它只证明「空输出 → launcher-unknown」这条代码链是真实可达的。

## 4. 根因候选（按置信度）

| ID | 候选 | 置信度 | 证据/反证 |
|---|---|---|---|
| R1 | **代码缺少回退/缓存**：`restartDesktopApp()` 每次现场解析；失败即 `launcher-unknown`，即便安装目录里的 `launcher.exe` 存在 | **高（代码事实）** | `runtime.ts` 无 fallback；`index.ts` 不复用 `layout().launcherPath`/缓存；单测只覆盖 `planRelaunch(null)`，没覆盖解析回退 |
| R2a | **接班实例的 launcher 已退出**：Windows 上 launcher 生命周期与 macOS 不同（进程重挂/父进程退出/被杀），第二次查询目标不存在 | **中** | Wine 下 launcher 在子进程存活时稳定存活；本仓/上游源码未见杀子进程；但 Win11 未取证；若真机如此，`WaitForSingleObject` 之后 launcher 退出也解释得通 |
| R2b | **PowerShell CIM 查询失败/空输出**（PATH、执行策略、WMI 服务、编码、8s 超时、输出被吞） | **中** | 本机 Wine 已复现「活进程 + status 0 + 空输出」；真机需 `Get-CimInstance` 现场输出 |
| R2c | **PID 过期/环境变量未更新**：`ELECTROBUN_LAUNCHER_PID` 指向旧 launcher，`ppid` 也不是当前 launcher | **低** | launcher 源码明确 `swapRemove` + `put` 自身 PID；Wine 实测 S1/S2 的 env 都是当前 launcher；未在 Win11 反驳 |
| R3 | **诊断缺失放大问题**：`stdio:'ignore'`，解析失败不记录 PID/命令/输出，只有一句 `launcher-unknown` | **高（代码事实）** | `defaultSpawn` 与 `restartDesktopApp` 均无诊断文件/日志 |
| R4 | **spawn 未 detach**：`Bun.spawn` 未设 `detached`，旧壳退出时 launcher 被连带结束 | **低** | Wine 实测同样 spawn+unref+exit，launcher 存活；`Bun.spawn`/`_exit` 不会杀子进程；`detached` 不是当前证据支持的修复点 |

**当前最稳妥的表述**：R1 是确定的代码缺陷，R2a/R2b 是触发它的两个候选；R3 是必须补的诊断。不要把「launcher 已死」写成已证实结论。

## 5. 最小复现（不依赖 Win11）

### 5.1 代码级（确定性）

`resolveLauncherExecutablePath` 接受注入的 `run`，因此可以在 macOS/Linux 上直接构造：

```ts
const resolved = resolveLauncherExecutablePath(
  { ELECTROBUN_LAUNCHER_PID: '1234' },
  0,
  () => ({ status: 0, stdout: '' }), // 模拟 CIM 空输出
  () => null,
  'win32',
)
// => null
const plan = planRelaunch({ isPackaged: true, launcherExe: resolved })
// => { ok: false, reason: 'launcher-unknown' }
```

这条测试不需要 Windows，能锁住「空输出不能直接变成不可重启」的回归。

### 5.2 环境级（可选）

按 §3.1 在 Wine 里跑真实 `launcher.exe` + 测试 Worker；观察 `{"status":0,"out":""}` 与进程链。注意这是 **failure mode** 复现，不是 Win11 根因复现。

### 5.3 真机取证（报告人/维护者）

第二次报错时在 PowerShell 里执行：

```powershell
$launcherPid = $env:ELECTROBUN_LAUNCHER_PID
"PID=$launcherPid"
Get-Process -Id $launcherPid -ErrorAction SilentlyContinue | Format-List Id,ProcessName,Path
Get-CimInstance Win32_Process -Filter "ProcessId=$launcherPid" | Select-Object ProcessId,ExecutablePath
Get-CimInstance Win32_Process -Filter "ProcessId=$PID" | Select-Object ProcessId,ParentProcessId
```

再取 `%USERPROFILE%\.dsh\shell.log` 中 `[shell] 重启桌面应用：launcher-unknown` 前后片段。若 `Get-Process` 有、CIM 空 ⇒ R2b；若 `Get-Process` 也没有 ⇒ R2a。

## 6. 修复方向（供 agent brief）

1. **冷启动缓存 launcher 路径**：在 `layout()` 解析成功时把 `launcherPath` 缓存到模块级（或由 `restartDesktopApp` 接收 `layout().launcherPath`）；重启时优先新鲜解析，失败回退缓存。
2. **多级 fallback**：`DSH_SHELL_LAUNCHER` 显式覆盖 → 启动缓存 → 安装布局（`<App>/bin/launcher.exe`）→ `dirname(process.execPath)/launcher.exe`（Windows 打包态 `bun.exe` 同目录有 `launcher.exe`）→ `existsSync` 校验。
3. **不 spawn 不存在的路径**：fallback 候选必须 `existsSync`；全失败仍保留 `launcher-unknown` 与「手动重启」文案。
4. **诊断**：解析失败时记录 `pid`、`ppid`、命令、status、stdout/stderr（截断）；`defaultSpawn` 不要一律 `ignore`，至少给 launcher 的 stderr 一个文件/回调。日志不得泄露 token（launcher 命令不含 token，安全）。
5. **测试**：
   - `resolveLauncherExecutablePath` 的 win32 空输出 → null；
   - 缓存/fallback 存在 → 返回缓存路径；不存在 → null；
   - `restartDesktopApp` 在某次解析 null 时仍用缓存路径 spawn；
   - 全失败时 `planRelaunch` 仍是 `launcher-unknown`；
   - 不 spawn 不存在文件。
6. **验收**：Windows 11 打包态连点 ≥3 次均成功；macOS 既有启动/重启不回归；`bun run typecheck` + `bun test` 全绿。

## 7. 既有笔记是否适用

- `docs/research/2026-10-17-windows-ci-webview2-cdp-smoke-elevation.md`：讲 CI 里 WebView2/CDP 探活，**不涉及 launcher 重启/进程生命周期**，不能回答本问题。
- `docs/research/2026-10-15-windows-installer-nsis-portability.md`：讲安装器 NSIS 可移植性与 `bin/launcher.exe` 布局，**不涉及运行期 relaunch**，只能作为安装树事实参考。
- 因此本次新查并新写本笔记；没有可复用的既有结论。

## 8. 附：关键源码位置

| 内容 | 位置 |
|---|---|
| 托盘动作/重启入口 | `desktop-electrobun/src/bun/index.ts`（`restartAppFromTray()` 约 `:1147`，`restartDesktopApp()` 约 `:1119`，`shutdown()` `:1829`） |
| launcher 路径解析 | `desktop-electrobun/src/bun/runtime.ts:311` |
| 启动布局/缓存 | `desktop-electrobun/src/bun/runtime.ts`（`layout()`、`shellProjectRoot()`、`launcherExeCache`） |
| 计划与 spawn | `desktop-electrobun/src/bun/app-restart.ts` |
| 单测 | `desktop-electrobun/test/app-restart.test.ts`（已有 `planRelaunch`/`relaunchDesktopApp` 用例，缺解析 fallback） |
| Electrobun launcher | `package/src/launcher/main.zig`（`configureInstallRootEnv`、`CreateProcessW`、`WaitForSingleObject`） |
| Electrobun core 退出 | `package/src/core/main.zig`（`quitGracefully`/`forceExit`） |
| Windows 安装树 | 构建产物 `bin/launcher.exe` + `Resources/main.js` + `Resources/app/bun/index.js` |
