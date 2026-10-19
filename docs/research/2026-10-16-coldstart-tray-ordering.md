# 冷启动时序与「DSH 启动失败时的用户出口」：源码调查

- 日期：2026-10-16
- 仓库：`dsh-desktop-bun`（Electrobun/Bun 桌面壳），只读调查，无代码改动
- 基线：`main` @ `7e2e953`
- 触发：需要判定「托盘是否在 DSH 宿主 ready 之后才创建」，以及 DSH 起不来时用户还有哪些出口
- 调查范围：`desktop-electrobun/src/bun/{index,tray,tray-menu,splash,service,host,runtime,stages,settings-store}.ts`、`desktop-electrobun/src/shared/{runtime-catalog,settings,notify-policy}.ts`、`desktop-plugin/src/client/desktop-settings.tsx`、`desktop-electrobun/electrobun.config.ts`

---

## 0. 结论速览

| # | 问题 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 冷启动四件事的真实顺序 | **splash → DSH 宿主/服务面 → 桌面主窗口 → 托盘**。托盘是**最后**创建的，且是模块顶层顺序执行、无任何并发 | `index.ts:1168`（splash）→ `1236`（`ensureService`）→ `1273`（`createProfileWindow`）→ `1315-1320`（`createTray`） |
| 2 | 托盘是不是在 DSH ready 之后才创建 | **是**。且是**硬依赖**：`trayState()` → `uiService()` → 模块级 `let service`，而 `service` 在 `1236` 才赋值；提前建托盘会直接 `TypeError` | `index.ts:1322`（建托盘时同步求 `trayState()`）、`334-337`（`uiService` 返回 `focused ?? service`）、`1227`+`1236` |
| 3 | `restartDsh()` 的 splash 复用机制 | 只在 `showSplash = !noWindow && reopenProfiles.length > 0` 时新建 splash；此时**托盘必然已存在**（托盘在冷启动末尾就建好，`restartDsh` 只在有服务面后可达） | `index.ts:822`、`826`；托盘建点 `1320` |
| 4 | 有没有「托盘先建、再起 splash/DSH」的路径 | **没有**。全仓 `createTray(` 只有一处调用（`index.ts:1320`），位于顶层顺序流末尾 | `grep createTray(` → `index.ts:1320`（定义在 `tray.ts:29`） |
| 5 | DSH 启动失败时主窗口是否存在 | **不存在**。`ensureService` 抛错 → `1237-1250` catch → splash 显示失败 → 30s 后 `Utils.quit()` → rethrow；`1273` 的建窗根本没执行 | `index.ts:1236-1250`、`1273` |
| 6 | 失败时托盘是否存在 | **不存在**（`1315` 在抛错点之后，永不到达）。唯一例外是 **端口被陌生程序占用**（`service.state.blocked`）：**不抛错**，托盘会建出来，但没有主窗口，且 30s 后自动 `shutdown()` | `index.ts:1266-1273` vs `1315-1320`；`service.ts:667`/`676`/`807` |
| 7 | 失败时能切运行时版本的 UI 入口 | 托盘 ❌（失败路径无托盘）；设置面板 ❌（它注入在 DSH 页面里，DSH 没起就没有页面）；安装程序 ❌（NSIS 只管装壳）；命令行 ❌（`index.ts` 无 `process.argv` 分支）。**只剩手改 `~/.dsh/desktop-settings.json` 的 `dsh_runtime` 键** | `desktop-settings.tsx:22`（`inject = ['slots']`，插件注入 DSH 页面）；`settings.ts:342`；`grep process.argv src/bun/*.ts` → 无命中 |

---

## Q1 冷启动实际顺序

### 1.1 入口

`desktop-electrobun/electrobun.config.ts:71`：`entrypoint: 'src/bun/index.ts'`。

`desktop-electrobun/src/bun/index.ts` **整个文件就是一个顶层顺序脚本**（模块顶层 `await`，没有 `main()` 函数）。所以「时间顺序」= 文件里语句的先后顺序。

启动决策断言在 `index.ts:80`/`83`（`fail()`，win 构建不得打 CEF 等），`noWindow` 开关在 `index.ts:66`（`DSH_SHELL_NO_WINDOW === '1'`）。

### 1.2 四件事的时间顺序（含行号）

| 序 | 事件 | 位置 | 代码 |
|---|---|---|---|
| ① | **splash 窗口创建** | `index.ts:1168-1181` | `if (!noWindow) { splash = new BrowserWindow({ … html: splashHtml(), frame: { width: SPLASH_WIDTH, height: SPLASH_HEIGHT } }) … splash.on('dom-ready', () => { splashReady = true; pushStage() }) }` |
| ② | **DSH 宿主拉起** | `index.ts:1236` | `service = await ensureService(instanceProfile)` |
| ③ | **桌面主窗口创建** | `index.ts:1273` | `if (!startupBlocked) await createProfileWindow(instanceProfile, service)` |
| ④ | **托盘创建** | `index.ts:1315-1320` | `if (!noWindow) { const image = trayImagePath(); … tray = createTray({ image, state: trayState(), … }) }` |

关键中间点：

- splash 先于宿主：`1168` 的 `if (!noWindow)` 块整块在 `1236` 之前；注释自陈用途：`index.ts:1152`「启动界面：起宿主那几十秒里给用户看的东西」。
- 宿主 ready 的信号点：`index.ts:1251` `console.log(\`SHELL-READY …\`)`，紧接着 `1252` 把 origin/pageUrl 回填实例锁。
- 主窗口 dom-ready 时收掉 splash：`index.ts:697-702`（`if (isBoot) { … splash?.close(); splash = null; mainWindowReady = true }`）。
- 托盘在建之前还会走一次 `trayState()`（`1322`），它读的是**已经就绪的服务面**。

### 1.3 明确回答：**托盘是在 DSH 宿主 ready 之后才创建的吗？**

**是。** 而且不只是「顺序上在后」，是**数据依赖上的硬依赖**：

```ts
// index.ts:334-337
function uiService(): ShellService {
  const focused = focusedProfile === null ? undefined : services.get(focusedProfile)
  return focused ?? service
}
// index.ts:339-340
function trayState(): TrayState {
  const settings = uiService().settings()
```

模块级 `let service: ShellService` 声明在 `index.ts:1227`，**只在 `1236` 赋值**。建托盘那一刻（`1320-1322`）同步调用 `trayState()` → `uiService()` → 若 `services`/`service` 皆空则返回 `undefined`，`undefined.settings()` 直接抛 `TypeError`。

所以：**把 `createTray` 提到 1168 之前不是「顺序调整」，是必然崩溃**。这是本问题真正的结构约束。

---

## Q2 `restartDsh()` + splash UX 是否覆盖本问题

### 2.1 `restartDsh()` 当前实现

定义 `index.ts:814-901`，签名 `async function restartDsh(): Promise<void>`。

调用点三处，全部在**服务面已存在**之后：

| 调用点 | 位置 | 触发源 |
|---|---|---|
| 面板 RPC「重启 dsh 服务」 | `index.ts:581` `onFullRestart: noWindow ? undefined : () => restartDsh()` → `service.ts:1170-1172` `deps.restartService` | 页面（DSH 已起） |
| 托盘「重启 dsh 服务」 | `index.ts:904-912` `restartServiceFromTray()` → `907` | 托盘（已存在） |
| 托盘「切换运行时版本」 | `index.ts:916-932` `switchRuntimeFromTray()` → `927` | 托盘（已存在） |

### 2.2 splash 复用机制

`index.ts:820-826`：

```ts
// #79：重启前开着的窗口就绪后原样重开；没开的不趁机弹窗（关窗回托盘的语义）
const reopenProfiles = [...windows.keys()]
const showSplash = !noWindow && reopenProfiles.length > 0
…
if (showSplash) {
  splash = new BrowserWindow({ title: APP_NAME, html: splashHtml(), renderer, titleBarStyle: 'hiddenInset', frame: { width: SPLASH_WIDTH, height: SPLASH_HEIGHT } })
```

- 复用方式：新建一个 `BrowserWindow`，**复用同一组模块级变量** `splash` / `splashReady` / `lastStage`，阶段推进仍由 `service.ts` 的 `onStage`（`index.ts:521-526`）→ `pushStage()`（`index.ts:1161-1166`）写同一份状态；`835-840` 重置 `splashReady = false; lastStage = 'instance'` 并重新挂 `dom-ready`。
- **splash 在什么条件下被创建**：`showSplash === true`，即「非无窗口模式」**且**「重启前至少开着一扇窗」（`windows` Map 非空）。
- **托盘此时是否已存在**：**必然存在**。`restartDsh` 的三个调用点都要求托盘或页面已存在，而托盘在冷启动 `1320` 就建好、此后只有 `shutdown()`（`1362-1363`）会摘掉。

### 2.3 结论：有没有「托盘先创建、再起 splash/DSH」的路径？

**没有。** 三点证据：

1. 全仓唯一的 `createTray(` 调用点是 `index.ts:1320`（定义在 `tray.ts:29`）：
   ```
   grep -rn "createTray(" desktop-electrobun/src → index.ts:1320, tray.ts:29
   ```
2. 该调用点在顶层顺序流的**末尾**，位于 `1236`（`ensureService`，可能抛错并 rethrow）与 `1273`（建主窗）**之后**。
3. 就算把它物理上移上去，`1322` 的 `state: trayState()` 也会因为 `service` 未赋值而崩（见 §1.3）。

**缺口在哪一层函数**：缺口不在 `restartDsh`，而在**冷启动的顶层编排**——`index.ts:1168 → 1236 → 1273 → 1315` 这一段是**写死在模块顶层的顺序语句**，没有被收敛成一个「启动编排函数」。具体地：

- 建托盘这件事没有自己的函数（`tray.ts:29` 的 `createTray` 只是构造器），调用点直接内联在顶层 `1315-1347`；
- 顶层顺序流里 `1236` 之后的任何抛错都会跳过 `1315`，所以「托盘」天然落在「失败即无托盘」的一侧；
- `trayState()`（`339`）依赖 `uiService()`（`334`）依赖模块级 `service`（`1227`）——这条依赖链把「建托盘」钉死在「服务面 ready 之后」，没有留出「先用空/降级状态建托盘」的接缝。

一句话：**#79/#81 的 `restartDsh` + splash UX 只覆盖了「已 ready 之后的重启」，完全没有触及「未 ready 时的托盘」**——因为托盘在那时还不存在。

---

## Q3 DSH 启动失败时用户当前有哪些出口

### 3.1 失败路径与错误呈现

**路径 A：运行时解析失败 / 布局不完整（同步抛错）**

- `service.ts:234` `let paths = layout({ … })` → `runtime.ts:401 layout()` → `runtime.ts:184 resolveRuntimeSelection()`。
- 两处硬抛：
  - `runtime.ts:223-225`：`找不到可用的 dsh 运行时：已下载目录 … 为空，也没找到随包内置树（可用 DSH_SHELL_RUNTIME_DIR / DSH_SHELL_BUILTIN_DIR 指定）`
  - `runtime.ts:460-462`：`壳布局不完整：dsh lib=… | 前端 dist=… | Bun 兼容层=… | 宿主脚本=…`
- 注意「设置点名版本不可用」**不抛错**，走回退：`runtime.ts:201-222` 返回 `note`（`runtime.ts:206` 文案：「设置指定的 dsh X 当前不可用（未装成、已卸载，且与随包内置版本不同），已回退随包内置运行时」），由 `service.ts:244-247` 记日志 + `service.ts:495-497` 补发 `SCENARIO.CONFIG_ERROR` 通知。**这意味着「版本选错」通常不会进入下面的崩溃路径。**

**路径 B：宿主启动失败（异步抛错）**

- `service.ts:592`（首次 `startHost`，`mode: 'fresh'`）→ 失败后 `service.ts:600-618` 用 `mode: 'existing'` 重试一次 → 仍失败则抛出。
- 超时来源 `host.ts:141-143`：`const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS`（`host.ts:64` `120_000`），`宿主 ${timeoutMs}ms 内未就绪`。
- 另一处 `service.ts:646-648`：`没拿到 dsh 会话 cookie（303 + set-cookie 流程失败）`（先 `host.stop()` 再抛）。
- 运行期崩溃由守护器兜：`service.ts:901-941` `supervise()`，`supervisor.ts:22-27` `SUPERVISOR_POLICY = { maxRestarts: 5, … }`，超限走 `service.ts:910-914`：`dshStatusCode = 5`、`options.onHostGiveUp?.(...)`、`notifier.notify(SCENARIO.STARTUP_ERROR, 'dsh 服务无法恢复：…')`。壳侧只 `console.error`（`index.ts:578`），**页面停在原 URL 不动**。

**错误落到哪里**：

| 载体 | 位置 | 证据 |
|---|---|---|
| splash 窗口（红字 + 提示） | `index.ts:1245` `splash.webview?.executeJavascript(splashFailScript(message))` | `splash.ts:24-26`；`splash.ts:53-58` 的 `body.failed` 样式把 `.error`/`.hint` 显示出来；`splash.ts:59` 提示「可退出后重试；日志在 ~/.dsh/shell.log」 |
| 桌面通知 | `index.ts:1240` `notifier.notify(SCENARIO.STARTUP_ERROR, \`桌面壳启动失败：${message}\`)` | `notify-policy.ts:16` 场景 id |
| 壳日志 | `index.ts:1239` `console.error(\`[shell] 启动失败：${message}\`)` + `service.ts:205` 的 `createLogSink` | `service.ts:198` `logFile = env.DSH_SHELL_LOG ?? join(home, 'shell.log')` |
| 状态文件 | `service.ts:809` 写 `shell-state.json`（仅在未抛错时） | — |

失败后的收尾（`index.ts:1243-1249`）：

```ts
if (splash === null || !splashReady) throw error      // splash 还没 dom-ready：只留日志，直接抛
try { splash.webview?.executeJavascript(splashFailScript(message)) } catch {}
await Bun.sleep(SPLASH_FAILURE_HOLD_MS)                // 30_000（index.ts:64）
Utils.quit()
throw error
```

**即：失败态的用户可见停留时间上限是 30 秒，然后进程自己退出。**

### 3.2 除托盘外，桌面主窗口此时是否存在？

**不存在。** 抛错点在 `1236`，主窗口建在 `1273`，`catch` 块（`1237-1250`）之后必然 `Utils.quit()` + rethrow，`1273` 永远不会执行。

### 3.3 「DSH 未起来」状态下切换运行时版本的 UI 入口逐项判定

| 入口 | 判定 | 证据 |
|---|---|---|
| **托盘菜单**「运行时版本」 | **不可达** | 菜单项定义在 `tray-menu.ts:352-358`（`label: '运行时版本'`，子项 `runtimeMenuItems` `tray-menu.ts:181`）；但 `tray` 只在 `index.ts:1320` 创建，失败路径（`1249` rethrow）永远到不了。**例外**：`service.state.blocked` 分支（见下）不抛错，托盘会建出来，但 30s 后自动 `shutdown()`（`index.ts:1268`） |
| **设置面板**（dsh 来源 / dsh 运行时区块） | **不可达** | 面板是 **DSH 页面内的 slot 注入**：`desktop-plugin/src/client/desktop-settings.tsx:22` `export const inject = ['slots']`；面板经 `shellRpc` 打到壳命令（`desktop-settings.tsx:25-27` 注释 + `commands.ts:293-343`）。页面 URL 来自 `service.state.pageUrl`（`service.ts:770`），页面由 `startShellServer`（`service.ts:760`）在**服务面内部**起。DSH 没起 ⇒ 没有页面 ⇒ 没有面板 |
| **页面 RPC** `save_desktop_settings` / `restart_dsh_service` | **不可达** | 命令表 `commands.ts:1159-1161` `createRpcRouter(createCommandTable({...}))` 挂在服务面上；`restart_dsh_service`（`commands.ts:356`）要求 `deps.restartService` 存在 |
| **安装程序** | **不可达（且不提供该能力）** | `desktop-electrobun/scripts/build-windows-installer.mjs` 只做 NSIS 打包/卸载清理（`:248-277` 处理插件链接），没有任何运行时版本选择 UI |
| **命令行**（给壳传参切运行时） | **不存在此入口** | `grep -rn "process.argv\|Bun.argv" desktop-electrobun/src/bun/*.ts` → **无命中**。`register-cli.ts` 注册的是 `dsh` 命令（指向当前运行时的 `bin.js`），不是切壳运行时的开关 |
| **环境变量** | **理论可用但非 UI** | `runtime.ts:186` `const override = … env.DSH_SHELL_RUNTIME_DIR`；`runtime.ts:224` 错误文案也提示 `DSH_SHELL_BUILTIN_DIR`。GUI 启动的进程环境由 launchd/Explorer 给定，实际不可控 |
| **手改设置文件** | **可达（唯一实际出口）** | `settings-store.ts:17` `SETTINGS_FILE = 'desktop-settings.json'`（`<DSH_HOME>/desktop-settings.json`）；键名映射 `settings.ts:342` `['dshRuntime', ['dshRuntime', 'dsh_runtime']]`；读取点 `service.ts:234-238`（`preferred: settings.dshRuntime`）→ `runtime.ts:201` `selectRuntimeVersion` |

**唯一的「有托盘但没主窗」场景**（端口被陌生程序占用）值得单独记一笔：

```ts
// index.ts:1263-1273
let startupBlocked = false
if (!noWindow) {
  if (service.state.blocked !== undefined) {
    splash?.webview?.executeJavascript(splashFailScript(service.state.blocked))
    setTimeout(() => { void shutdown() }, SPLASH_FAILURE_HOLD_MS)
    startupBlocked = true
  }
  if (!startupBlocked) await createProfileWindow(instanceProfile, service)
```

`blocked` 由 `service.ts:662-679` 产生（`端口 ${upstreamPort} 被其他实例或程序占用（profile=…），已停止自动拉起；可在设置中调整该 profile 的端口后重试`），经 `service.ts:807` 落进 `state.blocked`。此分支**不抛错**，所以执行流会继续走到 `1315` 建托盘——但托盘里能做的事仍然受限于：菜单状态由 `trayState()` 读 `uiService()`（服务面对象在，只是宿主没起），「重启 dsh 服务」可点，而 30s 后 `shutdown()` 会把托盘摘掉（`index.ts:1362-1363`）。

### 3.4 托盘菜单里有哪些项，是否依赖服务面已就绪

菜单树由 `tray-menu.ts:293 trayMenu(state)` 生成，完整清单：

| 菜单项 | 行号 | action | 是否依赖服务面 |
|---|---|---|---|
| 显示/隐藏窗口 | `tray-menu.ts:296-300` | `toggleWindow` | 是（`focusedWindow()`） |
| PROFILE 窗口（每 profile 子菜单：聚焦窗口 / 在新窗口打开 / 退出（停止实例）） | `tray-menu.ts:344-345`、`306-341` | `windowAction` / `stopProfile` | 是 |
| 新建 Profile… / 迁移 Profile… | `tray-menu.ts:341-342` | `newProfile` / `migrateProfile` | 否（`openProfileOpDialog`，`index.ts:936`，独立 `BrowserWindow`） |
| 运行时：`<label>`（只读行） | `tray-menu.ts:351` | `enabled: false` | 是（`uiService().runtime()`） |
| **运行时版本**（内置 / 已装各版本 / ↓ 下载并切换） | `tray-menu.ts:352-358` → `trayMenuItems` `tray-menu.ts:181` | `runtimeBuiltin` / `runtimeVersionPrefix` / `runtimeFetchPrefix` | **是**：走 `switchRuntimeFromTray`（`index.ts:916`）→ `uiService().save()` |
| dsh 服务地址（本地/远程） | `tray-menu.ts:359-363` → `remoteMenuItems` `tray-menu.ts:250` | `remoteLocal` / `remoteAddrPrefix` | 是 |
| 状态：运行中 / 宿主未运行（只读） | `tray-menu.ts:364-368` | `enabled: false` | 是（`uiService().state.hostPid`） |
| **重启 dsh 服务** | `tray-menu.ts:367` | `restartService` | 是 → `restartServiceFromTray`（`index.ts:904`）→ `restartDsh` |
| 注册 dsh 命令（条件项） | `tray-menu.ts:368-377` | `registerCli` | 否 |
| **退出** | `tray-menu.ts:379` | `quit` | 否（`shutdown()`，`index.ts:1357`） |

结论：**托盘菜单里只有「新建/迁移 Profile」「注册 dsh 命令」「退出」三项不依赖服务面**；所有与运行时版本、重启相关的项全部经 `uiService()` 取事实源。也就是说，即便强行让托盘提前出现，它当前也**渲染不出**可用的运行时菜单（`trayState()` 会先炸）。

---

## Q4 相关既有资产（供后续修复直接引用）

### 4.1 托盘

```ts
// desktop-electrobun/src/bun/tray.ts
export interface TrayHandle {            // :11-14
  setState: (state: TrayState) => void
  destroy: () => void
}
export interface CreateTrayOptions {     // :16-24
  image: string
  state: TrayState
  onAction: (action: TrayAction) => void
  onEmptyClick?: () => void
  log?: (line: string) => void
}
export function createTray(options: CreateTrayOptions): TrayHandle | null   // :29
```

- 内部：`tray.ts:33` `new Tray({ image, template: false, width: TRAY_ICON_SIZE(18), height: … })`；`:34-36` 原生层没建成时返回 `null`（不拖垮壳）。
- 菜单装配：`desktop-electrobun/src/bun/tray-menu.ts`
  - `export const TRAY_MENU_ACTIONS = { … }` — `tray-menu.ts:27-41`（`quit: 'tray:quit'` `:29`，`restartService: 'tray:restart-service'` `:30`，`runtimeBuiltin` / `runtimeVersionPrefix` / `runtimeFetchPrefix` `:34-36`）
  - `export type TrayActionKind = …` — `tray-menu.ts:42`
  - `export interface TrayAction` — `tray-menu.ts:55`
  - `export interface TrayState` — `tray-menu.ts:67`
  - `export function parseTrayAction(action: string | undefined | null): TrayAction | null` — `tray-menu.ts:124`
  - `export function orderedProfiles(state: Pick<TrayState,'profile'|'profiles'>): string[]` — `tray-menu.ts:164`
  - `export function runtimeMenuItems(state: TrayState): TrayMenuItem[]` — `tray-menu.ts:181`
  - `export function remoteMenuItems(state: Pick<TrayState,'remoteAddr'|'remoteList'>): TrayMenuItem[]` — `tray-menu.ts:245`
  - `export function trayMenu(state: TrayState): TrayMenuItem[]` — `tray-menu.ts:293`
  - `export function trayTitle(state: Pick<TrayState,'profile'>): string` — `tray-menu.ts:385`
  - 限宽：`export const TRAY_LABEL_MAX = 48` `tray-menu.ts:275`、`truncateTrayLabel` `:276`、`truncateMenu` `:283`

### 4.2 splash

```ts
// desktop-electrobun/src/bun/splash.ts（纯 HTML/注入脚本，不 import electrobun）
export const SPLASH_WIDTH = 420                    // :12
export const SPLASH_HEIGHT = 236                   // :13
export function splashStageScript(stage: ShellStage): string   // :20
export function splashFailScript(message: string): string      // :24
export function splashHtml(): string                          // :28
```

窗口创建点（两处，参数完全相同）：
- 冷启动：`index.ts:1168-1181`
- 重启：`index.ts:825-840`

阶段定义：`desktop-electrobun/src/bun/stages.ts:21-29` `SHELL_STAGES`（`instance → layout → ports → host → cookie → server → ready`），`FAILED_LABEL = '启动失败'` `:31`，`stageLabel` `:38`，`stagePercent` `:43`。

### 4.3 host 启动

```ts
// desktop-electrobun/src/bun/host.ts
export interface HostReady { url: string; injections: unknown[] }   // :12-15
export interface StartHostInput { … }                                // :17-…（timeoutMs?: number 在 :30）
export interface HostHandle {                                        // :51-60
  ready: HostReady
  stop: () => Promise<void>
  pid: number
  exited: Promise<number>
  lastTree: () => number[]
}
export async function startHost(input: StartHostInput): Promise<HostHandle>   // :74
```

服务面层：

```ts
// desktop-electrobun/src/bun/service.ts
export interface ServiceOptions { … }        // :74（onFullRestart? 在 :97 注释处）
export interface ShellService { … }          // :157（restartHost: () => Promise<void> 在 :166）
export async function startService(options: ServiceOptions): Promise<ShellService>   // :193
```

### 4.4 运行时选择

```ts
// desktop-electrobun/src/bun/runtime.ts
export function dshHome(env?: Record<string, string|undefined>): string    // :72
export function appSupportDir(env?: …): string                              // :78
export function trayImagePath(env?: …): string | null                       // :89
export interface RuntimeSelection { kind; root; layout; version; note }     // :117-124
export function runtimePathsOf(root: string, layout?: RuntimeLayout): { dshLibDir: string; distDir: string }   // :127
export function resolveBuiltinRuntimeDir(…): string | null                 // :145
export interface RuntimeSelectionInput { env?; overrideDir?; appSupport?; preferred?; builtinDir?; installed? }  // :161-170
export function resolveRuntimeSelection(input: RuntimeSelectionInput = {}): RuntimeSelection   // :184
export function resolveRuntimeDir(input: LayoutInput = {}): string          // :229
export function layout(input: LayoutInput = {}): ShellLayout               // :401
```

```ts
// desktop-electrobun/src/shared/runtime-catalog.ts
export function selectRuntimeVersion(input: {
  installed: readonly string[]
  preferred?: string | null
  builtin?: string | null
}): string | null                                                            // :204-215
```

### 4.5 壳侧其它相关函数

```ts
// desktop-electrobun/src/bun/index.ts
function uiService(): ShellService                                   // :334
async function downloadRuntimeFromTray(version: string): Promise<void>   // :960
function onTrayAction(action: TrayAction): void                       // :978
function openProfileOpDialog(kind: ProfileOpDialogKind): void        // :1048
function refreshTray(): void                                         // :376
function showMainWindow(): void                                      // :431
function focusedWindow(): BrowserWindow | null                       // :458
async function ensureService(profile: string): Promise<ShellService>  // :477
async function createProfileWindow(profile: string, svc: ShellService): Promise<BrowserWindow>  // :643
async function openProfileWindow(profile: string): Promise<void>     // :784
async function restartDsh(): Promise<void>                           // :814
async function restartServiceFromTray(): Promise<void>               // :904
async function switchRuntimeFromTray(action: TrayAction): Promise<void>  // :916
async function downloadRuntimeFromTray(version: string): Promise<void>   // :959
function onTrayAction(action: TrayAction): void                       // :989 附近
const shutdown = async (): Promise<void>                             // :1357
const pushStage = (): void                                           // :1161
```

---

## 附录：调查过程中确认的事实与坑

1. **`index.ts` 没有 `main()`**：整个入口是模块顶层顺序脚本 + 顶层 `await`。「冷启动顺序」在任何意义上都等于源码顺序，无法通过调用图推断出别的顺序。
2. **`trayState()` 的隐式前置条件**是本问题最硬的一处耦合：任何「提前建托盘」的改动都必须先处理 `uiService()` 在 `service` 未赋值时的返回值（目前是 `undefined`，直接 `.settings()` 崩）。
3. **`blocked`（端口被陌生程序占用）不是抛错路径**，是本问题里唯一「托盘存在但主窗口不存在」的状态，而且 30s 后会被 `shutdown()` 自动收掉（`index.ts:1268`）。评估「DSH 未起来」的用户出口时，这一格不能和「真失败」混为一谈。
4. **「设置里的运行时版本不可用」通常不崩**：`runtime.ts:201-222` 会回退到随包内置并给 `note`，用户看到的是通知 + 日志，不是 splash 红字。所以真正会打到 splash 红字的是「一个运行时都找不到」或「布局资产缺失」这类更硬的失败。
5. **`SPLASH_FAILURE_HOLD_MS = 30_000`**（`index.ts:64`）决定了失败态的最长可见时间：30s 后 `Utils.quit()`（`1248`）。splash 自身没有任何交互控件（`splash.ts:28-79` 只有进度条、红字和一行 hint），不能点任何按钮。
6. **无进程内 CLI**：`src/bun/*.ts` 里没有 `process.argv` / `Bun.argv` 命中，壳没有「`dsh-desktop --runtime=…`」这类参数入口。
7. **既有测试不覆盖时序**：`desktop-electrobun/test/window-tray.test.ts` 测的是 `trayMenu` / `parseTrayAction` / `runtimeMenuItems` 等**纯函数**，`lifecycle.test.ts` 里没有 tray/splash 顺序断言。冷启动顺序目前是**无测试保护**的行为。
