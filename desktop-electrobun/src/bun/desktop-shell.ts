// 壳进程（desktop-shell）：桌面全流程住在这一层——CEF 断言 → 起服务面 → 建窗 → 托盘。
//
// 它是被主进程（main-process.ts，launcher 占用的进程）用专门拉起方法 spawn 的子进程
// （env DSH_SHELL_ROLE=shell，map #240 / #243）：窗口、托盘、DSH 全部自洽，进程可被
// 主进程随意杀掉重拉（重启应用 = 主进程重拉本进程）。单实例/单窗口语义不变。
//
// 服务面（运行时就位、端口认领、起宿主、取 cookie、loopback 服务）在 service.ts 里，
// 那一层不 import electrobun；这里只做「渲染器断言」和「窗口」两件事。
import { ApplicationMenu, BrowserView, BrowserWindow, BuildConfig, ContextMenu, Screen, Utils, app } from 'electrobun/bun'
import { acceptShimScript } from './windows/accept-shim.ts'
import { systemLocale } from './platform/locale.ts'
import { installApplicationMenu } from './windows/menu.ts'
import { deriveMaximized, toggleWindowMaximize, windowMaxState, type WindowMaxState } from './windows/window-max.ts'
import { pickWorkArea } from './windows/screen-work-area.ts'
import { installShellConsoleTee, resolveShellLogFile } from './platform/shell-log.ts'
import { createShellReporter } from './daemon/shell-reporter.ts'
import { SHELL_RESTORE_PROFILES_ENV } from './daemon/control.ts'
import { isRemoteProfile } from '../shared/app/remote-profile.ts'
import { bootPreloadScript } from './preload.ts'
import { attachShellRpc } from './commands/rpc-bridge.ts'
import { startService, type ServiceOptions, type ShellService } from './host/service.ts'

import { createNativeNotify } from './notify/notify-un.ts'
import type { RuntimeSnapshot } from './commands/commands.ts'
import { ensureWindowsNotifyIdentity } from './notify/win-notify-identity.ts'
import type { RuntimeDownloadStatus } from './runtime/runtime-install.ts'
import { SHELL_MENU_ACTIONS, contextMenuItems, isOpenablePath } from './windows/context-menu.ts'
import { isExternalUrl } from './windows/external.ts'
import { APP_NAME } from '../shared/app/app.ts'
import { appSupportDir, dshHome, trayImagePath } from './runtime/runtime.ts'
import { acquireInstance, activateUrl, defaultIsAlive, releaseInstance, updateInstance } from './platform/single-instance.ts'
import { awaitParentExit, relaunchParentPid } from './platform/app-restart.ts'
import { applyWindowsIcon, windowIconCandidates } from './platform/window-icon.ts'
import { createViewRegistry } from '../shared/net/view-grant.ts'
import { createGuestManager, type GuestViewLike } from './windows/guest-manager.ts'
import { loadNativeWebviewCore } from './windows/native-webview.ts'
import { GUEST_DEFAULT_URL, OFFSCREEN_GUEST_RECT } from '../shared/profiles/guest-policy.ts'
import { resolveAppVersion } from './platform/app-version.ts'
import { SPLASH_HEIGHT, SPLASH_WIDTH, splashFailScript, splashHtml, splashStageScript } from './windows/splash.ts'
import { dialogTitlebarFrameHeight } from './windows/dialog-titlebar.ts'
import { readShellTheme } from './platform/theme-source.ts'
import { stageLabel, stagePercent, type ShellStage } from './platform/stages.ts'
import { createTray, type TrayHandle } from './platform/tray.ts'
import {
  trayMenu,
  type TrayAction,
  type TrayState,
  type TrayUpdateCheck,
} from './platform/tray-menu.ts'
import { listProfiles } from './profiles/profiles.ts'
import { profileDialogHtml, type ProfileOpDialogKind } from './windows/profile-dialog.ts'
import {
  createUpdateNoticePresenter,
  type NoticeWindowLike,
  type NoticeWindowOptions,
} from './windows/update-notice-window.ts'
import type { UpdateNoticePayload } from './windows/update-notice-dialog.ts'
import { createProfileSessions } from './windows/profile-session.ts'

import { attachProfileOpRpc } from './commands/profile-op-rpc.ts'
import type { UpdateNoticeCheckResult } from './commands/update-notice-check.ts'
import { confirmModalScript } from './windows/input-modal.ts'
import { navRulesFor } from '../shared/net/nav-rules.ts'
import { normalizeRemoteUrl, remoteDisplay, remoteOrigin } from '../shared/net/remote.ts'
import { remoteProfileAddress, remoteProfileId } from '../shared/app/remote-profile.ts'
import {
  defaultWindowFrame,
  readWindowFrame,
  readWindowMaximized,
  sanitizeFrame,
  writeWindowFrame,
  type DisplayBounds,
  type WindowFrame,
} from './windows/window-state.ts'
import { loadSettings } from './platform/settings-store.ts'
import { applyCdpDebugPort, closeDevToolsTarget, DEVTOOLS_DEFAULT_PORT, DEVTOOLS_PORT_OVERRIDE_ENV, devToolsMenuEnabled, isPortBindable, planDevToolsBoot, resolveDevToolsInspectorUrl } from './windows/devtools.ts'
import { resolveRenderBackend } from './windows/render-backend.ts'
import { activeProfile, type DesktopSettings } from '../shared/settings/settings.ts'
import { evaluateRuntimeUpdates } from '../shared/runtime/runtime-update.ts'
import type { CatalogEntry } from '../shared/runtime/runtime-catalog.ts'
import { closeAction, offsetFrame, windowKey } from '../shared/app/window-targets.ts'

import { createNotifier, type Notifier } from './notify/notifications.ts'
import { showWindowsBalloon } from './notify/notify-win.ts'
import { SCENARIO } from '../shared/notify/notify-policy.ts'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { createRegisterCli } from './commands/register-cli.ts'
import { registerTrayLabel } from '../shared/app/register-cli.ts'
import { loggingKernel } from './logging/kernel.ts'

// 打包态主进程 stdout 无人接：把 console.* 同时 tee 进 shell.log（#80 取证缺口）。
installShellConsoleTee()

/**
 * #228：带级别的日志转发。注入进来的回调（通知身份 / guest 管理器 / register CLI /
 * 整应用重启 / 原生通知桥 / 通知投递）现在直接收 Logger：调用点按级别选方法，
 * 级别与结构化参数在调用时定稿，写路径不再解析行内前缀。
 *
 * 源（source）就是模块身份：shell / guest / notify / register。路径口径与 service.ts 一致
 * （DSH_SHELL_LOG 优先，兜 $DSH_HOME/shell.log）——内核是进程级单例，先到先锁。
 */
const logging = loggingKernel({ home: dshHome(process.env), files: { shell: resolveShellLogFile(process.env) } })
const shellLog = logging.logger('shell')
const guestLog = logging.logger('guest')
const notifyLog = logging.logger('notify')
const registerLog = logging.logger('register')

/** 客户端版本标识：dsh 0.2.1-alpha.2 的 telemetry/product-analytics 插件把它当必填项。 */
const CLIENT_VERSION = '0.1.0'
/** 退出时等宿主与 CEF 子进程收尾的上限（超过就交给框架的优雅退出） */
const SHELL_STOP_DEADLINE_MS = 8_000
// #117：启动失败时不再有「留 30 秒再自己退掉」的时限——托盘先在，用户有自救入口，
// 什么时候走由他决定（托盘 → 退出）。这个常量与它的注释一并撤掉。

function fail(message: string, code: number): never {
  console.error(`[shell] ${message}`)
  process.exit(code)
}

// 渲染器三处开关（平台条件化，#84）：构建期 bundleCEF/defaultRenderer + 每窗 renderer +
// 这里的平台化启动断言。win 走系统 WebView2（构建不打 CEF）；mac/linux 必须有 CEF——
// renderer 请求不可用的渲染器会被静默回落（mac 回落 WKWebView），断言把静默变显式。
const build = BuildConfig.getSync()
const available: string[] = build.availableRenderers ?? []
const backend = resolveRenderBackend({ availableRenderers: available })
const wantsCef = backend.kind === 'cef'
const renderer: 'cef' | 'native' = backend.renderer
const isWinBuild = process.platform === 'win32'
if (isWinBuild && wantsCef) {
  fail(`win 构建不应打 CEF（#84 切 WebView2；availableRenderers：${available.join(',')}）：检查 electrobun.config.ts 的 win.bundleCEF`, 3)
}
if (!isWinBuild && !wantsCef) {
  fail(`availableRenderers 不含 cef（实际：${available.join(',') || '空'}）：mac/linux 必须走 CEF（系统 webview 的 WebKit 渲染一致性不可接受）`, 3)
}
const expectedDefaultRenderer = isWinBuild ? 'native' : 'cef'
if (build.defaultRenderer !== expectedDefaultRenderer) {
  console.warn(`[shell] defaultRenderer=${build.defaultRenderer} 与平台期望 ${expectedDefaultRenderer} 不符；建窗时显式传 renderer 兜住`)
}

const noWindow = process.env.DSH_SHELL_NO_WINDOW === '1'
/** 壳平台名：与旧壳 body[data-dsh-desktop-platform] 契约同名。 */
const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
// macOS 的 Cmd+C/Cmd+V 由 NSMenu 的选择器驱动（见 menu.ts），不装菜单就没有系统剪贴板快捷键。
if (platform === 'darwin') installApplicationMenu(ApplicationMenu, APP_NAME)
// Windows 通知身份（#107）：抢在任何能发通知的环节之前声明 AUMID 并注册身份，
// 通知横幅才显示应用名与图标（缺了就显示进程名「BUN」）。失败只降级不阻断启动。
if (platform === 'win32') ensureWindowsNotifyIdentity({ log: notifyLog })
// 系统语言：CEF 默认 en-US，页面语言跟着错；旧壳（WKWebView）是天然跟随系统的。
const locale = await systemLocale()
// 页面外链与右键菜单都要主进程出面：CEF 不会自己弹菜单，也不接管 window.open。
// 回调注册在窗口之前，闭包里的主窗引用在建窗后才有值（bootSession/sessions 派生）。

// ---- 托盘 + 窗口几何：关窗回托盘、Dock 再激活、位置尺寸记忆 ----
// 旧 Tauri 壳用 tauri-plugin-window-state + tauri-plugin-single-instance；Electrobun 两样都没有。
const windowStateFile = join(appSupportDir(), 'window.json')
// 实例锁与托盘都要 profile：DSH_PROFILE > 设置 > 默认。
// 设置文件可能还不存在（首启），读失败就按默认——真正的落盘由 service 那一步做。
const bootSettings: DesktopSettings = loadSettings({ home: dshHome() }).settings
const instanceProfile = activeProfile(bootSettings, process.env)

// ---- #69 开发者工具开关：打包态是否开远程调试口（CEF / WebView2 载体见 render-backend.ts） ----
// env 必须在任何渲染进程起来前就位（splash 就是第一个窗、native core 也在下面），
// 所以启动决策放这里做完；菜单可见 ⇔ 口已开（cdpReady 来自同一份启动决策，禁中间态）。
const devToolsPlan = await planDevToolsBoot({
  isPackaged: build.isPackaged,
  settingOn: bootSettings.devTools === true,
  envOverride: process.env[DEVTOOLS_PORT_OVERRIDE_ENV],
  isFree: isPortBindable,
})
// C environ 双写（dylib 用 C getenv 读开关；Bun map 写入不穿透，实测见 devtools.ts 头注）。
// 写入失败 = CDP 开不了：cdpReady 落 false，菜单同批不出现（禁中间态，fail-closed）。
const devToolsCdpReady = devToolsPlan.enableCdp && devToolsPlan.port !== null
  ? applyCdpDebugPort(devToolsPlan.port, { backend })
  : false
if (devToolsPlan.enableCdp && !devToolsCdpReady) {
  console.error('[shell] 开发者工具：调试口 env 写入失败（C environ 写入不可用），本次不开口、不出菜单')
}
if (devToolsPlan.reason === 'enabled-by-setting') {
  console.log(`[shell] 开发者工具：已开启，${backend.label} 远程调试口 127.0.0.1:${String(devToolsPlan.port)}（重启后生效${backend.devToolsLogHint}；本机任意进程可借该口在页面里执行代码）`)
} else if (devToolsPlan.reason === 'port-unavailable') {
  console.error(`[shell] 开发者工具：端口 ${String(devToolsPlan.port)} 被占用，本次不开调试口、不出菜单（可用 ${DEVTOOLS_PORT_OVERRIDE_ENV} 换口）`)
} else if (devToolsPlan.reason === 'port-invalid') {
  console.error(`[shell] 开发者工具：${DEVTOOLS_PORT_OVERRIDE_ENV} 非法（需要 1-65535 整数），按未开启处理`)
} else if (devToolsPlan.reason === 'dev-build') {
  console.debug('[shell] 开发者工具：dev 构建，DevTools 菜单恒可见（打包态才吃 dev_tools 开关）')
} else {
  console.debug('[shell] 开发者工具：未开启（设置 dev_tools）——不监听调试口、不出菜单')
}
let tray: TrayHandle | null = null
// 每视图授权台账（#220 决策 12）：每个窗口一枚 token，页面桥带回来，壳按视图种类放行命令。
const views = createViewRegistry()
// 浏览器 guest（#118/#134）：侧边栏浏览器 / 远程窗口的子 webview。
// 历史（canGoBack/goBack…）与几何（bounds）走框架原生核：公开的 BrowserView API 里没有这两样。
const nativeCore = await loadNativeWebviewCore({
  execPath: process.execPath,
  importDir: import.meta.dir,
  env: process.env,
})
if (nativeCore.core === null) {
  console.warn(`[guest] 原生核不可用：${nativeCore.error ?? '未知原因'}`)
} else {
  console.log(`[guest] 原生核就绪：${nativeCore.libPath}`)
}
const guests = createGuestManager({
  log: guestLog,
  core: nativeCore.core,
  // guest 挂在发起调用的那个窗口上（多窗口下天然跟随宿主窗口）。
  createView: ({ partition, caller }) => {
    const hit = sessions.get(caller.profile)
    if (hit === undefined || hit.window === null) return null
    const view = new BrowserView({
      url: GUEST_DEFAULT_URL,
      renderer,
      // #58：guest 页也可能有 MIME 形式的 file input；shim 只做 DOM 归一化，无 RPC，sandbox 下安全
      preload: acceptShimScript(platform),
      partition,
      frame: { ...OFFSCREEN_GUEST_RECT },
      windowId: hit.window.id,
      hostWebviewId: hit.window.webviewId,
      // 不可信内容：不开 RPC，只保留事件（Electrobun 自己给远程 URL 的建议档位）
      sandbox: true,
      autoResize: false,
    })
    return view as unknown as GuestViewLike
  },
  // 状态推送：dsh 对 <webview> 是同步拉取，所以壳把快照 eval 回宿主页面（旧壳同款）。
  pushToHost: (caller, script) => {
    const hit = sessions.get(caller.profile)
    if (hit === undefined || hit.window === null || !hit.state().ready) return
    try {
      hit.window.webview?.executeJavascript(script)
    } catch (error) {
      console.warn(`[guest] 状态推送失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
})
// ---- C1 ProfileSession（#188 拍板 / #179 实施）----
// 原 11 张 per-profile 散表（windows/services/stoppingProfiles/trayHintShown/
// pendingStartMaximized/frameSaveTimers/heal 三表/焦点记账）收口进 profile-session.ts；
// 壳侧只保留组合面：托盘/菜单/设置/启动界面/单实例/退出。此后新增一类 per-profile
// 状态只能加在 profile-session.ts（record 字段 + dispose 顺序）。
const sessions = createProfileSessions({
  instanceProfile,
  createService: (profile) => startService(serviceOptionsFor(profile)),
  createWindow: (profile, svc) => createProfileWindow(profile, svc),
  createRemoteWindow: (profile) => createRemoteWindow(profile),
  closePolicy: (profile, win) => performClosePolicy(win, profile),
  isQuitting: () => quitting,
  onQuitRequested: () => void shutdown(),
  windowStateFile: windowStateFileOf,
  workArea: workAreaForFrame,
  onDomReady: () => {
    // 主窗已出画面：拆掉启动界面（页面自己也等 __DSH_BOOT_READY__，这里只负责别让两个窗口并存）
    try {
      splash?.close()
    } catch (error) {
      console.warn(`[shell] 启动界面关闭失败（冷启动）：${String(error)}`)
    }
    splash = null
    windowVisible = true
  },
  onWindowsChanged: () => void refreshTray(),
  views,
  guests,
})

/** 启动 profile 的 session：主窗/主服务面的派生口径（替代原 mainWindow/mainWindowReady）。 */
function bootSession() {
  return sessions.get(instanceProfile)
}

/**
 * #115：这个 profile 的窗口此刻是否真的挡在用户眼前——焦点记账 + 可见/最小化兜底
 * （账在 profile-session.ts；服务面回调按 profile 判「聚焦不打扰」仍从这里走）。
 */
function windowInFront(profile: string): boolean {
  return sessions.inFront(profile)
}

/** #115：壳级通知（启动失败/服务健康/托盘提示）没有 profile 归属——最近聚焦的窗口在前台就不打扰。 */
function anyWindowInFront(): boolean {
  return sessions.anyInFront()
}
let windowVisible = false
/** 隐藏回托盘前窗口是否处于最大化（ffi hide/show 往返会丢最大化，show 前补回，#50 验证反馈）。 */
let hiddenWhileMaximized = false
let quitting = false
/** 关窗后是否只是隐藏：没有托盘（原生层没建成）时隐藏就叫不回来了，那时关窗等于退出。 */
const closeToTray = (): boolean => tray !== null

/**
 * Screen.getAllDisplays() 的容错读取：失败只记日志并当空表，调用方各退回自己的兜底
 * （窗口默认尺寸 / 最大化态退回原生旗标）。
 */
function screenDisplays(purpose: string): ReturnType<typeof Screen.getAllDisplays> {
  try {
    return Screen.getAllDisplays()
  } catch (error) {
    console.warn(`[shell] 取显示器信息失败（${purpose}）：${String(error)}`)
    return []
  }
}

function displayBounds(): DisplayBounds[] {
  return screenDisplays('窗口用默认尺寸').map((display) => display.bounds)
}

/**
 * 逻辑工作区取法（#73）：Screen.getAllDisplays() 与 BrowserWindow.getFrame() 同属 Electrobun
 * 逻辑坐标系；非 Windows / 无显示器数据 / 读取异常一律 null，判定退回原生旗标。
 * 不直接调 user32 GetMonitorInfoW：那是物理 px，125% 缩放下与逻辑帧四边全差 20%。
 */
function workAreaForFrame(frame: WindowFrame): WindowFrame | null {
  if (process.platform !== 'win32') return null
  const workArea = pickWorkArea(frame, screenDisplays('最大化态退回原生旗标'))
  if (workArea === null) console.warn('[shell] Screen 没有可用的显示器工作区，最大化态退回原生旗标')
  return workArea
}

/** 落盘几何 → 可用几何；越界/太小/坏数据一律回默认（外接屏拔掉后不能把窗口丢在屏幕外）。 */
/** D3：每窗几何记忆——主窗沿用 window.json，其余 profile 各存 window-<profile>.json */
function windowStateFileOf(profile: string): string {
  return profile === instanceProfile ? windowStateFile : join(appSupportDir(), `window-${profile}.json`)
}

function restoreWindowFrame(profile: string = instanceProfile): WindowFrame {
  const file = windowStateFileOf(profile)
  const raw = readWindowFrame(file)
  const saved = sanitizeFrame(raw, displayBounds())
  if (saved === null) return defaultWindowFrame()
  // #73 回归：旧版 saveFrameNow 把最大化帧当常规帧落盘，SW_RESTORE 会回到一个和
  // 工作区一样大的「窗口化」帧——几何判定把窗口态误读成最大化（图标恒为还原、按钮
  // 只会 unmaximize）。与工作区几乎重合的落盘帧不可信，退回默认几何；正常窗口不会
  // 刚好铺满工作区，这个判定只命中中毒帧。
  if (raw !== null) {
    const workArea = workAreaForFrame(raw)
    if (workArea !== null && deriveMaximized(raw, workArea, false)) {
      console.warn(
        `[shell] 丢弃与工作区重合的窗口位置（最大化帧被落盘成常规帧）：${String(raw.x)},${String(raw.y)} ${String(raw.width)}×${String(raw.height)}`,
      )
      const repaired = defaultWindowFrame()
      writeWindowFrame(file, repaired, readWindowMaximized(file))
      return repaired
    }
  }
  console.debug(`[shell] 还原窗口位置：${String(saved.x)},${String(saved.y)} ${String(saved.width)}×${String(saved.height)}`)
  return saved
}


/**
 * 关窗策略（will-close / RPC window_close / 兑底端点三处共用，#50 验证反馈）：
 * 主窗+有托盘 → 隐藏回托盘（进程继续）；主窗无托盘 → 直接退；其余 profile → 只销毁。
 */
function performClosePolicy(win: BrowserWindow, profile: string): 'hidden' | 'quit' | 'close' {
  if (closeAction(profile, instanceProfile) === 'hide-to-tray' && closeToTray()) {
    // D5：首次关窗回托盘时提示一次（旧壳关窗提示的等价物；用户知道了就不再弹）
    if (sessions.onceTrayHint(profile)) {
      notifier.notify(SCENARIO.WINDOW_LIFECYCLE, '窗口已最小化到托盘，点托盘图标可找回。')
    }
    hiddenWhileMaximized = win.isMaximized()
    win.hide()
    windowVisible = false
    sessions.releaseFocus(profile)
    refreshTray()
    return 'hidden'
  }
  if (!closeToTray() && profile === instanceProfile) return 'quit'
  return 'close'
}
/** 版本目录缓存：托盘子菜单用它渲染「↓ 下载并切换」，但不该每刷一次托盘就打网络（旧壳也拿缓存）。 */
const TRAY_CATALOG_TTL_MS = 10 * 60_000

/**
 * #141：托盘「检查更新」的进程态。**只在这两个时刻变**：点「检查更新」时置 checking，
 * 出结果时换成 result。定时轮询不碰它（票面明令：事件驱动，禁止定时重建菜单）。
 * 注意与 `catalogCache` 的区别：那个是「有哪些版本可下载」且带 10 分钟 TTL，
 * 手动检查要绕过它强制真检，所以这里另存一份不带 TTL 的结果。
 */
let trayUpdateCheck: TrayUpdateCheck | null = null
let catalogCache: { at: number; entries: CatalogEntry[] } | null = null
let catalogPending = false

function ensureCatalog(): void {
  if (catalogPending) return
  if (catalogCache !== null && Date.now() - catalogCache.at < TRAY_CATALOG_TTL_MS) return
  catalogPending = true
  void uiService()
    .fetchCatalog(uiService().settings().runtimeSource ?? 'github')
    .then((result) => {
      if (result.error === undefined) catalogCache = { at: Date.now(), entries: result.entries }
      else console.warn(`[shell] 拉运行时版本目录失败：${result.error}`)
    })
    .catch(() => { })
    .finally(() => {
      catalogPending = false
      tray?.setState(trayState())
    })
}

/** 下载状态在运行时管理器里；壳侧只读它——取不到就当作不在下载。 */
function downloadStatusSafe(): RuntimeDownloadStatus {
  try {
    return uiService().downloadStatus()
  } catch {
    return { active: false, version: '', resolved: 0, downloaded: 0, added: 0, error: '', cancelled: false }
  }
}

/** 运行时的展示名：已下载版本 / 随包内置两档，旧壳 `运行时：<label>` 同一口径。 */
function runtimeLabelOf(snapshot: RuntimeSnapshot): string {
  if (snapshot.activeVersion !== null && snapshot.activeVersion !== snapshot.builtinVersion) {
    return `${snapshot.activeVersion}（已下载）`
  }
  return snapshot.activeVersion === null ? '内置（版本未知）' : `内置 ${snapshot.activeVersion}`
}

/** 面向托盘与设置面板的那份服务面：最近聚焦窗口的；没有就退回启动 profile 的。 */
function uiService(): ShellService {
  const focused = sessions.focused()?.service
  if (focused != null) return focused
  const boot = bootSession()?.service
  if (boot == null) throw new Error('启动服务面尚未就绪')
  return boot
}

function trayState(): TrayState {
  const settings = uiService().settings()
  const snapshot = uiService().runtime()
  const download = downloadStatusSafe()
  // 判定层候选（#186/#189）：托盘菜单只消费归一候选，不再自己并集去重；不额外拉网
  //（目录用 10 分钟 TTL 的 catalogCache，miss 时给空——ensureCatalog 会在后台补）。
  const runtimeReport = evaluateRuntimeUpdates({
    running: snapshot.activeVersion,
    builtin: snapshot.builtinVersion,
    catalog: catalogCache?.entries ?? [],
    installed: snapshot.installed,
    source: settings.runtimeSource,
  })
  return {
    // 可见性是「当前那个窗口」的：多窗口下托盘的显示/隐藏只动一个
    windowVisible: focusedWindow()?.isVisible() ?? windowVisible,
    profile: uiService().paths.profile,
    // 多 profile：菜单按 home 下的 profile 目录列，点了开/聚焦那一份窗口
    profiles: listProfiles(dshHome(), instanceProfile),
    openWindows: sessions.openProfiles(),
      profileRows: [
        ...listProfiles(dshHome(), instanceProfile).map((profile) => {
          const row = sessions.get(profile)
          // #215：运行中与否由会话状态说了算（服务面 stop() 之后状态落 stopped、宿主 PID 归 0）。
          // 旧口径只看 hostPid：退过实例还留着旧 PID，托盘就一直说「运行中」——
          // 那个 profile 既开不了新窗（服务面是终态对象），菜单还只剩「退出」没别的路走。
          // 一次 state() 拿全：origin 也从会话状态取，别越过会话接口摸服务面。
          const sessionState = row?.state()
          const running = sessionState?.running ?? false
          const port = running ? Number((sessionState?.origin ?? '').split(':').pop() ?? '') || null : null
          const windowOpen = sessionState?.windowOpen ?? false
          return {
            profile,
            kind: 'local' as const,
            open: windowOpen,
            // #241：窗口开着但不在前台（隐藏回托盘）→ 菜单给「显示窗口」而不是「隐藏窗口」。
            hidden: windowOpen && !sessions.inFront(profile),
            running,
            port,
            focused: sessions.focused()?.profile === profile,
          }
        }),
        // #241/#6：远程 dsh 地址以独立条目进「profile 管理」；#246 通路已接：开窗/显隐/重启（窗口重建）。
        ...settings.remoteList.map((addr) => {
          const id = remoteProfileId(addr)
          const sessionState = sessions.get(id)?.state()
          const windowOpen = sessionState?.windowOpen ?? false
          return {
            profile: id,
            kind: 'remote' as const,
            open: windowOpen,
            hidden: windowOpen && !sessions.inFront(id),
            running: false,
            port: null,
            focused: sessions.focused()?.profile === id,
          }
        }),
      ],
    hostRunning: uiService().state.hostPid > 0,
    // #117：服务面先于 DSH 存在，所以托盘在 DSH 没起来/起不来时照样拿得到真相，
    // 并能把原因摆进状态行告诉用户「还能换一版再试」。
    serviceStatus: uiService().state.status,
    serviceError: uiService().state.error ?? uiService().state.blocked ?? null,
    runtimeLabel: runtimeLabelOf(snapshot),
    builtinVersion: snapshot.builtinVersion,
    runningVersion: snapshot.activeVersion,
    selected: settings.dshRuntime ?? null,
    installed: snapshot.installed.map((entry) => entry.version),
    candidates: runtimeReport.candidates,
    builtinDescriptor: runtimeReport.builtinDescriptor,
    downloading: download.active && download.version !== '' ? download.version : null,
    registerLabel: registerTrayLabel(registerCli.cached()),
    // #141：手动检查的进程态。壳主进程持有，不进设置/服务面——菜单只负责把它显示出来。
    // 没查过就压根不摆这一行（与 registerLabel 同一套「缺省不扰民」的口径）
    updateCheck: trayUpdateCheck ?? undefined,
  }
}

function refreshTray(): void {
  if (tray === null) return
  tray.setState(trayState())
  // 顺带把「有哪些版本可下载」拿回来（有缓存/正在拉就跳过，不阻塞窗口操作）
  ensureCatalog()
  // 窗口集合可能变了：重跑一次窗口图标（幂等、有缓存，覆盖后建的主窗/弹窗；#203 二轮）
  if (!noWindow && process.platform === 'win32') {
    applyWindowsIcon(shellLog, windowIconCandidates(dirname(process.execPath)))
  }
  // 注册状态同理：TTL 内直接用缓存，绝不在菜单构建里同步 spawn 登录 shell
  void registerCli.refresh().then(() => {
    if (tray !== null) tray.setState(trayState())
  })
}

/**
 * #80 最大化落位自检（heal）：触发面（focus/resize 去抖 + 延迟复查）、损坏判定与重摆
 * 上限都已收口进 profile-session.ts（C1，#179）——这里不再有 per-profile 计时器表。
 */

function showMainWindow(): void {
  const win = focusedWindow()
  if (win === null) return
  win.unminimize()
  if (hiddenWhileMaximized) {
    // 隐藏前是最大化：show 前先 maximize（与启动路径同构，窗口直接以最大化出现不闪小窗）
    win.maximize()
    hiddenWhileMaximized = false
  }
  win.show()
  win.activate()
  windowVisible = true
  refreshTray()
}

function hideMainWindow(): void {
  const win = focusedWindow()
  if (win === null) return
  hiddenWhileMaximized = win.isMaximized()
  win.hide()
  windowVisible = false
  sessions.releaseFocus(sessions.focused()?.profile ?? instanceProfile)
  refreshTray()
}

// ---- 多窗口：每 profile 一份服务面 + 一个窗口（旧壳 `ui/multiwin.rs` 的等价物）----

/** 当前那个窗口：最近聚焦的；没焦点记录就回主窗（口径收口在 profile-session.ts）。 */
function focusedWindow(): BrowserWindow | null {
  return sessions.focusedWindow()
}

/**
 * 焦点窗的最大化态（#112 壳层标题栏带）：判定收口在 window-max.ts 的 windowMaxState
 * （与 RPC window_get_state 同源）。无焦点窗时回 false（无窗场景图标无意义）。
 */
function focusedWindowState(): WindowMaxState {
  const win = focusedWindow()
  if (win === null) return { maximized: false }
  return windowMaxState(win, { workArea: workAreaForFrame })
}

/** 服务面选项：除了 profile 与状态文件，其余回调全是壳侧共用的那几个。 */
function serviceOptionsFor(profile: string): ServiceOptions {
  const home = dshHome()
  return {
    profile,
    // #115：通知的「聚焦不打扰」按 profile 判——该 profile 的窗口真的在前台才不投（兜底见 windowInFront）。
    isWindowFocused: (target) => windowInFront(target),
    clientVersion: CLIENT_VERSION,
    noWindow,
    // 一个 profile 一份状态文件（诊断脚本按 profile 找）；启动 profile 保留旧路径
    env:
      profile === instanceProfile
        ? process.env
        : { ...process.env, DSH_SHELL_STATE_FILE: join(home, `shell-state-${profile}.json`) },
    onOpenExternal: (url) => {
      if (!Utils.openExternal(url)) console.warn(`[shell] 系统浏览器没接住外链：${url}`)
    },
    onContextMenu: (request) => {
      const linkIsExternal =
        request.linkUrl !== null && isExternalUrl(request.linkUrl, originOf(profile))
      // #119：settingOn 改**实时读**（原为 bootSettings 启动快照）。菜单门控本不必等重启：
      // 关掉开关菜单立刻消失（口还开着但没入口，方向安全）；`cdpReady` 仍是启动快照——
      // 口开没开由那次启动真决定，env 早于第一个 CEF 窗 / WebView2 environment 写入，运行期改不了。
      const isPackagedBuild = BuildConfig.getSync().isPackaged
      const devToolsMenuOn = devToolsMenuEnabled({
        isPackaged: isPackagedBuild,
        settingOn: uiService().settings().devTools === true,
        cdpReady: devToolsCdpReady,
      })
      // 菜单统一「打开 DevTools」（#106 返工）：CEF＝openDevTools 应用内 inspector；
      // win＝点击后壳发合成 F12（与物理按键同路径弹原生 DevTools 窗），复制地址形态已废弃。
      const items = contextMenuItems(request, linkIsExternal, { devTools: devToolsMenuOn })
      // 「挂不上也要出声」：菜单内容进日志，实机排查时能看出是哪一档
      console.debug(`[shell] 右键菜单：${items.map((item) => item.label ?? item.role ?? item.type ?? '?').join(' | ')}`)
      ContextMenu.showContextMenu(items as unknown[])
    },
    onStage: (stage) => {
      lastStage = stage
      console.debug(`[shell] 启动阶段：${stageLabel(stage)}（${String(stagePercent(stage))}%）`)
      pushStage()
    },
    // #142：服务面在后台判定完就把提醒窗开出来（没得提醒时它自己返回 false）
    onOpenUpdateNotice: (payload) => openUpdateNotice(profile, payload),
    onActivate: () => {
      // 第二个壳点了一次图标：把当前窗口带到前台（恢复最小化、显示、抢焦点）
      console.log('[shell] 收到激活请求：窗口带到前台')
      showMainWindow()
    },
    onWindowControl: (action) => {
      const win = focusedWindow()
      if (win === null) return
      if (action === 'minimize') {
        win.minimize()
      } else if (action === 'toggle-maximize') {
        // 与 RPC window_toggle_maximize 同语义：判定/样式位/原生切换收口在 window-max.ts（#112）。
        toggleWindowMaximize(win, { workArea: workAreaForFrame })
      } else {
        // #50 验证反馈：兑底端点的关窗也走统一策略（要拿到 profile 才能判主/副窗）
        const focusedSession = sessions.byWindow(win)
        if (focusedSession === undefined) {
          win.close()
          return
        }
        const closePolicyAction = performClosePolicy(win, focusedSession.profile)
        if (closePolicyAction === 'close') win.close()
        else if (closePolicyAction === 'quit') void shutdown()
      }
    },
    onWindowState: () => {
      // GET /__shell__/window（#112 壳层标题栏带的最大化图标查询）：与漏斗同源推导
      return focusedWindowState()
    },
    onProfileOpApplied: (op, profile) => {
      // F9：创建成功直接开那扇窗（ensureService 会装依赖并拉宿主）；迁移完成刷新托盘。
      if (op === 'create') {
        void openProfileWindow(profile)
          .then(() => refreshTray())
          .catch((error) => console.error(`[shell] 打开新 profile 窗口失败：${String(error)}`))
      } else {
        void refreshTray()
      }
    },
    onZoomToggle: () => {
      const win = focusedWindow()
      if (win === null) return
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    },
    onInputConfirm: (flow, value) => {
      if (pendingInput?.flow === flow) {
        pendingInput.resolve(value)
        pendingInput = null
      }
    },
    onHostRestart: (state) => {
      // 宿主被守护器拉起来了：把对应窗口刷回同一个页面 origin（token/端口都没变）
      console.log(`[shell] 宿主已重启，页面重载：${state.pageUrl}`)
      reloadWindow(state.profile, state.pageUrl)
    },
    onHostGiveUp: (state, reason) => {
      console.error(`[shell] 宿主守护器放弃重启（${reason}）；页面停在 ${state.pageUrl}`)
    },
    // #79：面板「重启 dsh 服务」= 统一 restartDsh（树级全重启 + 关窗→splash→原样重开）；无窗口模式回落宿主级
    onFullRestart: noWindow ? undefined : () => restartDsh(),
    // #119：dev_tools 保存后的生效路径。拉不起时带原因回传（dev 态显式降级），不假报成功。
    onRestartApp: () => restartDesktopApp(),
    notifier,
    // 同一个 UN 桥实例（状态与投递都走它；面板的权限徽标也从这里读）
    notifyBridge,
    views,
    guests,
    appVersion: resolveAppVersion(),
    locale,
    pickSoundFile: pickSoundFileImpl,
    chooseDownloadDir: pickDownloadDirImpl,
    // 页面请求关窗（`close_current_window` / `exit_window_instance`）：关它自己那个窗口
    onCloseWindow: () => {
      sessions.get(profile)?.closeWindow()
    },
    // 启动确认选了别的 profile：#82 的旧行为是「用它重启」；新壳每 profile 一份服务面，所以是开它那份窗口
    onOpenProfileWindow: async (target) => {
      if (target === profile) return
      await openProfileWindow(target)
    },
  }
}

function originOf(profile: string): string {
  return sessions.originOf(profile)
}

/**
 * 下载的「保存位置」：Electrobun 只暴露 openFileDialog（没有 NSSavePanel 封装），所以让用户选**目录**、
 * 文件名由壳按建议名自动起（撞车时退成 `名字 (1).ext`）——与旧壳的保存框语义等价，只是不能连带改名。
 */
async function pickDownloadDirImpl(start: string): Promise<string | null> {
  const picked = await Utils.openFileDialog({
    startingFolder: start,
    allowedFileTypes: '*',
    canChooseFiles: false,
    canChooseDirectory: true,
    allowsMultipleSelection: false,
  })
  const dir = picked[0] ?? null
  return dir === '' ? null : dir
}

/** 「桌面通知」tab 的「自定义文件…」：Electrobun 原生文件选择器（旧壳 tauri-plugin-dialog 的等价物）。 */
async function pickSoundFileImpl(): Promise<string | null> {
  const picked = await Utils.openFileDialog({
    startingFolder: '~/',
    allowedFileTypes: 'wav,mp3,ogg',
    canChooseFiles: true,
    canChooseDirectory: false,
    allowsMultipleSelection: false,
  })
  return picked[0] ?? null
}

/** 宿主重启后把对应窗口刷回同一个页面 origin。 */
function reloadWindow(profile: string, url: string): void {
  sessions.get(profile)?.reload(url)
}


/** 建一个 profile 窗口并接上 RPC（#50）；事件接线与窗口期状态归 profile-session.ts（#179）。 */
async function createProfileWindow(profile: string, svc: ShellService): Promise<BrowserWindow> {
  const index = sessions.openProfiles().length
  const frame = index === 0 ? restoreWindowFrame(profile) : offsetFrame(restoreWindowFrame(profile), index)
  // 每视图授权 + 官方 RPC（#50）：token 一枚两用——preload 注给页面（HTTP 兑底用），
  // 整份 grant 闭进 defineRPC（漏斗里做每视图白名单）。
  const grant = views.issue('shell', profile, windowKey(profile))
  // 三键目标窗：闭包面（构造前声明；官方 RPC 请求到达时 win 已赋值）。
  let win: BrowserWindow
  const rpcWindow = {
    minimize: () => win.minimize(),
    isMaximized: () => win.isMaximized(),
    unmaximize: () => win.unmaximize(),
    maximize: () => win.maximize(),
    close: () => {
      // #50 验证反馈：三键关闭按钮走与 will-close 同一套策略——主窗隐藏回托盘，不是退进程
      const action = performClosePolicy(win, profile)
      if (action === 'close') win.close()
      else if (action === 'quit') void shutdown()
    },
    // 漏斗状态推导要用的只读帧（本仓不做任何窗口摆位，#80）。
    getFrame: () => win.getFrame(),
  }
  const shellRpcHandle = await attachShellRpc({ router: () => svc.rpcRouter(), grant, window: rpcWindow, workArea: workAreaForFrame })
  win = new BrowserWindow({
    // D1：原生层同步评估的导航守卫——白名单页面 origin，其余导航被拦（外链交给 open_external）
    navigationRules: navRulesFor({ origin: svc.state.origin }),
    title: profile === instanceProfile ? APP_NAME : `${APP_NAME} · ${profile}`,
    url: svc.state.pageUrl,
    renderer,
    preload: bootPreloadScript(locale, platform, svc.state.origin, grant.token),
    rpc: shellRpcHandle.rpc,
    // hidden = 纯无边框方框（实机报的「方形无边框」）。mac 两态都以 hiddenInset 出红绿灯。
    titleBarStyle: 'hiddenInset',
    frame,
  })
  console.log(`[shell] 建窗：${windowKey(profile)}（${svc.state.pageUrl}）`)
  // 启动恢复最大化（D3/#73）、dom-ready/focus/blur/will-close/close/resize/move 的
  // 事件接线与 per-profile 状态，全部在 profile-session.ts（C1，#179）。
  return win
}
/**
 * #246：远程条目窗口。数据面（dsh 页面与其 /api）直接打远程地址；chrome 桥回本桌面——
 * preload 的 RPC origin 注本桌面服务面，页面的桌面 chrome（侧边栏/标题栏命令）经官方 RPC
 * 落到本桌面壳，重启等命令由壳按 remote: 身份处理。导航白名单只放远程 origin。
 */
async function createRemoteWindow(profile: string): Promise<BrowserWindow> {
  const addr = remoteProfileAddress(profile)
  const normalized = addr === null ? null : normalizeRemoteUrl(addr)
  if (normalized === null) throw new Error(`远程条目地址无效：${profile}`)
  const boot = uiService()
  const index = sessions.openProfiles().length
  const frame = index === 0 ? restoreWindowFrame(profile) : offsetFrame(restoreWindowFrame(profile), index)
  const grant = views.issue('shell', profile, windowKey(profile))
  // 三键目标窗：闭包面（构造前声明；官方 RPC 请求到达时 win 已赋值）。与本地窗同款。
  let win: BrowserWindow
  const rpcWindow = {
    minimize: () => win.minimize(),
    isMaximized: () => win.isMaximized(),
    unmaximize: () => win.unmaximize(),
    maximize: () => win.maximize(),
    close: () => {
      // 关闭走与本地窗同一套策略（主窗隐藏回托盘，其余销毁）。
      const action = performClosePolicy(win, profile)
      if (action === 'close') win.close()
      else if (action === 'quit') void shutdown()
    },
    getFrame: () => win.getFrame(),
  }
  // chrome 桥指回本桌面 boot 服务面的 router：远程页面的桌面 chrome 由本桌面壳接管（#246）。
  const shellRpcHandle = await attachShellRpc({ router: () => boot.rpcRouter(), grant, window: rpcWindow, workArea: workAreaForFrame })
  win = new BrowserWindow({
    navigationRules: navRulesFor({ origin: remoteOrigin(normalized) }),
    title: `${APP_NAME} · ${remoteDisplay(normalized)}`,
    url: normalized,
    renderer,
    preload: bootPreloadScript(locale, platform, boot.state.origin, grant.token),
    rpc: shellRpcHandle.rpc,
    titleBarStyle: 'hiddenInset',
    frame,
  })
  console.log(`[shell] 建远程窗：${windowKey(profile)}（${normalized}）`)
  return win
}

/** 托盘「PROFILE 窗口」：已开就聚焦，没开就起一份服务面再开窗（旧壳 open_profile_window）。 */
async function openProfileWindow(profile: string): Promise<void> {
  const result = await sessions.open(profile)
  if (result.ok) return
  console.error(`[shell] 打开 profile 窗口失败（${profile}）：${result.reason}`)
  notifier.notify(SCENARIO.INSTANCE_LIFECYCLE, `打开 ${profile} 窗口失败：${result.reason}`)
}

let restartingShell = false

/**
 * #247：重启界面的立窗段（restartDsh 与单 profile 重建共用）——立一面 splash、
 * 记阶段，dom-ready 后补推。冷启动的 splash 早已收掉；这里重新立一面。
 */
function raiseRestartSplash(): void {
  splash = new BrowserWindow({
    title: APP_NAME,
    html: splashHtml(readShellTheme(dshHome(), instanceProfile), platform),
    renderer,
    titleBarStyle: 'hiddenInset',
    // #164：win32/linux 多一条标题带，窗高相应加一段（darwin 有系统红绿灯，不加）。
    frame: {
      width: SPLASH_WIDTH,
      height: dialogTitlebarFrameHeight(SPLASH_HEIGHT, platform),
    },
  })
  splashReady = false
  lastStage = 'instance'
  splash.on('dom-ready', () => {
    splashReady = true
    pushStage()
  })
}

/**
 * #247：托盘单 profile「重启」——带 splash 的壳内重建（不再只是无界面 stop+open）。
 * 本地：停服务面 → 共享重启界面 → 全新拉起 → 新窗就绪撤界面；
 * 远程（#246）：无服务面可停，窗口销毁重建即数据面重连，不立界面。
 */
async function restartProfileWithSplash(profile: string): Promise<void> {
  if (quitting) return
  if (isRemoteProfile(profile)) {
    await sessions.stop(profile)
    await openProfileWindow(profile)
    return
  }
  const showSplash = !noWindow && !restartingShell
  if (showSplash) raiseRestartSplash()
  await sessions.stop(profile)
  await openProfileWindow(profile)
  // 重建完成：没有别的重建在排队就收掉界面（新主窗 dom-ready 也会收，这里是其它 profile 的兜底）。
  if (showSplash) {
    try {
      splash?.close()
    } catch (error) {
      console.warn(`[shell] 启动界面关闭失败（单 profile 重建路径）：${String(error)}`)
    }
    splash = null
    splashReady = false
  }
  refreshTray()
}

/**
 * #60 + #79：DSH 侧的「重启 dsh 服务」入口——面板按钮、托盘切运行时都走这一条。
 * 语义（维护者 2026-10-14 拍板）：DSH 侧等效「退出应用再启动」——宿主+伴生进程树整树灭确认后全新拉起；
 * 桌面壳本体（托盘/进程）不退出。有窗口时：关窗 → 重启界面（复用冷启动 splash 通道，
 * onStage 阶段照推）→ 服务面就绪后原样重开重启前开着的窗口；无窗口模式保持纯服务面重启。
 *
 * #126：托盘那项「重启应用」**不再**走这里——它现在是整个应用退出 + 自动拉起（restartAppFromTray）。
 */
async function restartDsh(): Promise<void> {
  if (restartingShell || quitting) return
  restartingShell = true
  try {
    const restartProfiles = sessions.serviceProfiles()
    const serviceCount = restartProfiles.length
    // #79：重启前开着的窗口就绪后原样重开；没开的不趁机弹窗（关窗回托盘的语义）
    const reopenProfiles = sessions.openProfiles()
    const showSplash = !noWindow && reopenProfiles.length > 0
    console.log(`[shell] 完整重启：DSH 树级重启 ${String(serviceCount)} 份服务面（壳与托盘保持不动）`)
    // ---- 阶段〇：关窗 → 重启界面（raiseRestartSplash：冷启动通道复用，onStage/pushStage 同一套）----
    if (showSplash) {
      raiseRestartSplash()
      // 关窗绕过关窗策略（回托盘/退进程的判断是给用户手关用的；重启关窗是壳自己的动作）——
      // 置位/关窗/等一拍/复位的时序收口在 profile-session.ts（C1，#179）
      await sessions.closeWindowsForRestart(reopenProfiles)
      windowVisible = false
    }
    // ---- 阶段一：树级停止（host.stop 树级契约：伴生进程随宿主退场，树灭确认后才返回）----
    await Promise.all(
      restartProfiles.map(async (profile) => {
        try {
          await sessions.resetService(profile)
        } catch (error) {
          console.error(`[shell] 完整重启：停止服务面失败（${profile}）：${String(error)}`)
        }
      }),
    )
    // ---- 阶段二：全新服务面（新宿主、新 token）；重启前开着的窗口原样重开 ----
    for (const profile of restartProfiles) {
      const fresh = await sessions.ensureService(profile).catch((error: unknown) => {
        console.error(`[shell] 完整重启：拉服务面失败（${profile}）：${String(error)}`)
        return null
      })
      if (fresh === null) {
        console.error(`[shell] 完整重启：重启服务面失败（${profile}）`)
        continue
      }
      // #117：startService 只把壳的面立起来了，DSH 得显式拉（冷启动那条路上是 ensureService 之后
      // 紧跟一句 ensureRunning()）。拉不起来就跳过这份 profile 的窗口，但**服务面仍然留着**
      // ——托盘还在，用户能接着换运行时再试（这正是 #117 的那个死局出口）。
      try {
        await fresh.ensureRunning()
      } catch (error) {
        console.error(`[shell] 完整重启：dsh 未起来（${profile}）：${String(error)}（服务面保留，可从托盘换运行时再试）`)
        continue
      }
      if (profile === instanceProfile) {
        // 启动 profile 的服务面引用换新（session record 持引用；实例锁回填 origin/页面）
        updateInstance(instanceFile, process.pid, { origin: fresh.state.origin, pageUrl: fresh.state.pageUrl })
      }
      if (reopenProfiles.includes(profile)) {
        // 重开（createProfileWindow：几何记忆/关窗策略/RPC 全套语义重新接上；
        // 启动 profile 的窗口 dom-ready 会收掉重启界面（主窗就绪口径在 session record）
        try {
          await sessions.attachWindow(profile, fresh)
        } catch (error) {
          console.error(`[shell] 完整重启：重开窗口失败（${profile}）：${String(error)}`)
        }
      } else {
        reloadWindow(profile, fresh.state.pageUrl)
      }
    }
    // ---- 收尾：重启界面收掉（启动 profile 窗口的 dom-ready 也会收，这里是兜底）----
    if (showSplash) {
      try {
        splash?.close()
      } catch (error) {
        console.warn(`[shell] 启动界面关闭失败（重启路径）：${String(error)}`)
      }
      splash = null
      splashReady = false
    }
    console.log(`[shell] 完整重启完成（服务面 ${String(serviceCount)} 份）`)
  } finally {
    restartingShell = false
    refreshTray()
  }
}

/** #119 保存后重探调试口：把「保存了但口开不了」变成用户能看到的字，而不是重启完才发现没反应。 */
async function recheckDevToolsPort(): Promise<string | null> {
  const plan = await planDevToolsBoot({
    isPackaged: build.isPackaged,
    settingOn: uiService().settings().devTools === true,
    envOverride: process.env[DEVTOOLS_PORT_OVERRIDE_ENV],
    isFree: isPortBindable,
  })
  if (plan.reason === 'port-unavailable') {
    return `端口 ${String(plan.port)} 当前被占用，重启后也不会开口（可用 ${DEVTOOLS_PORT_OVERRIDE_ENV} 换口）`
  }
  if (plan.reason === 'port-invalid') {
    return `${DEVTOOLS_PORT_OVERRIDE_ENV} 非法（需要 1-65535 整数），按未开启处理`
  }
  return null
}

/**
 * #237/#243 进程模型下的「重启应用」：壳只「表态 + 自杀」——把 restart 意图上报给主进程
 * （daemon/shell-reporter，尽力而为一次），随后 shutdown 退出；等退净、重拉新壳全是主进程
 * （daemon/run.ts：exit 事件 + exitIntent=restart → 立即重拉）的事。#237 时代的 launcher
 * 中继/常驻监督脚本三件套已由主进程整体取代（#245 清理残留文件）。
 *
 * 不被主进程拉起（dev 直跑 / 老包升级首启）⇒ 自杀后没人重拉，**拒绝并如实回报**（#119 红线：
 * 不退出、不假报成功）。
 */
async function restartDesktopApp(): Promise<{ ok: boolean; reason?: string; message?: string }> {
  const controlUrl = process.env.DSH_SHELL_CONTROL_URL ?? ''
  const controlToken = process.env.DSH_SHELL_CONTROL_TOKEN ?? ''
  if (controlUrl === '' || controlToken === '') {
    const message = '本壳不是主进程拉起的（dev 态直跑或旧包首启），退出后无人重拉，重启被拒绝'
    console.warn(`[shell] 重启桌面应用：${message}`)
    notifier.notify(SCENARIO.STARTUP_ERROR, '重启桌面应用未完成', message)
    return { ok: false, reason: 'unsupervised', message }
  }
  const warning = await recheckDevToolsPort().catch((error: unknown) => {
    console.warn(`[shell] 开发者工具：重启前复查调试口失败：${String(error)}`)
    return null
  })
  if (warning !== null) {
    // 预检在旧壳存活期执行：占用调试口的通常就是本壳自己的渲染进程（devTools=true 时 100% 触发），
    // 旧壳退出后口自然释放、新壳会重开——降为 debug 留痕，不再弹误导性 error 通知（#237 实测）。
    console.debug(`[shell] 重启桌面应用：${warning}（预检时口仍由旧壳占用属预期）`)
  }
  console.log('[shell] 重启桌面应用：上报 restart 意图后退出，由主进程重拉')
  shellReporter.reportExit('restart')
  await shutdown()
  return { ok: true }
}

/**
 * 托盘「重启应用」（#126）：整个应用退出 + 自动拉起。#243 进程模型：壳表态后自杀，
 * 主进程收到 exit+restart 立即重拉（三平台一致——不再有 #237 的 win32 分叉）。
 *
 * 口径 2026-10-16 改过：#60 当初定的是「托盘重启 = DSH 侧树级重启，壳不退出」——那样托盘图标和
 * 窗口从头到尾都在，用户看不出到底重启了没有。现在这一项改成整个应用重来。
 * 面板的「重启 dsh 服务」仍是 DSH 侧重启（onFullRestart），那是另一件事：切远程 dsh / 切 Profile /
 * 切运行时只需要 DSH 换，壳没必要跟着退。
 */
async function restartAppFromTray(): Promise<void> {
  console.log('[shell] 托盘：重启应用')
  // 拒绝（dev 直跑无人重拉）时 restartDesktopApp 自己 notify 并返回 { ok: false } 且不退出，
  // 这儿不用再兜一层；成功路径它 await shutdown() 退出本进程，下一行只在失败时才跑到。
  await restartDesktopApp()
  refreshTray()
}

/**
 * 托盘「运行时版本」：内置 / 某个已下载版本。
 *
 * #117：这条路径**不再要求 DSH 已经就绪**。运行时选中只是 `<DSH_HOME>/desktop-settings.json`
 * 里的 `dsh_runtime`，而设置文件是壳独占的纯文件 IO（settings-store.ts：tmp+rename 原子写），
 * 跟 DSH 进程活不活没关系。以前它之所以依赖 ready，是被「要重启」绑成了
 * 「先把服务面拆了重建」——那是实现顺序，不是这份能力的内在要求。
 */
async function switchRuntimeFromTray(action: TrayAction): Promise<void> {
  const svc = uiService()
  // 维护者在本单明确同意：切任何一行都写版本号，含「内置」——`dsh_runtime: null` 与「没设置过」
  // 同形，壳按未指定处理，跟设置面板的写法不一致（#97 裁决）。票面那条「#97 的口径不动」指的是
  // resolveRuntimeSelection / selectRuntimeVersion 本体不动；这里是托盘侧写法，向后对齐。
  const version = action.version ?? svc.runtime().builtinVersion
  if (version === null || version === undefined) {
    console.error('[shell] 切换运行时失败：拿不到内置版本号，先查内置运行时树是否完整')
    refreshTray()
    return
  }
  const patch: Record<string, unknown> = { dsh_mode: 'builtin', dsh_runtime: version }
  console.log(`[shell] 托盘：切换运行时 ${JSON.stringify(patch)}`)
  try {
    svc.save(patch)
  } catch (error) {
    console.error(`[shell] 切换运行时失败（写设置）：${String(error)}`)
    refreshTray()
    return
  }
  refreshTray()
  try {
    // #117：分流的关键。DSH 已经在跑 → 树级全重启 + splash UX（#79 Q2 的原语义原样保留）；
    // 还没起来 / 起不来 → 直接把这份服务面按新设置拉起来，**不拆服务面、不杀宿主**。
    if (svc.state.status === 'running' || svc.state.status === 'starting') {
      await restartDsh()
    } else {
      await svc.ensureRunning()
    }
    // RUNTIME_SWITCH（切换结果）：成败都让托盘外的人知道；「下载并切换」的托盘流会与下载完成
    // 通知连发两条，嫌吵可以在设置里单独关「运行时切换」。
    notifier.notify(
      SCENARIO.RUNTIME_SWITCH,
      action.version === undefined ? '已切换到内置运行时' : `已切换到 dsh ${action.version}`,
    )
  } catch (error) {
    // 拉不起来不是死局：托盘还在，状态行会显示原因，用户可以再换一版再试。
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[shell] 切换运行时后仍未起来：${message}`)
    notifier.notify(SCENARIO.RUNTIME_SWITCH, `切换运行时失败：${message}`)
  }
  refreshTray()
}

/**
 * 下载中的托盘刷新：**事件驱动**——只在「在下载 / 下载完」这类状态跳变时下发菜单，
 * 不每秒重建（菜单开着时反复 setMenu 会把它顶掉，用户口径明确要求不要定时刷新）。
 */
let downloadTimer: ReturnType<typeof setInterval> | null = null
function downloadTrayKey(): string {
  const status = downloadStatusSafe()
  return `${status.active ? '1' : '0'}|${status.version}`
}
function pollDownload(): void {
  if (downloadTimer !== null) return
  let lastKey = downloadTrayKey()
  downloadTimer = setInterval(() => {
    const key = downloadTrayKey()
    if (key !== lastKey) {
      lastKey = key
      refreshTray()
    }
    if (!downloadStatusSafe().active && downloadTimer !== null) {
      clearInterval(downloadTimer)
      downloadTimer = null
    }
  }, 1_000)
}

/** 托盘「↓ 下载并切换 <v>」：装完直接切过去（旧壳 runtime-fetch-<v> 同语义）。 */
async function downloadRuntimeFromTray(version: string): Promise<void> {
  if (version === '') return
  console.log(`[shell] 托盘：下载运行时 ${version}`)
  pollDownload()
  try {
    await uiService().download(version, uiService().settings().runtimeSource ?? 'github')
  } catch (error) {
    console.error(`[shell] 下载运行时 ${version} 失败：${String(error)}`)
    // 失败通知由服务层统一发（SCENARIO.RUNTIME_DOWNLOAD，见 service.ts 的 downloadRuntimeNotified）；
    // 托盘不再用 STARTUP_ERROR 重复报一遍。
    refreshTray()
    return
  }
  console.log(`[shell] 运行时 ${version} 装好了，切过去`)
  // 装完的版本要从「↓ 下载并切换」那一栏挪进「已装」：缓存作废，重新拉一份
  catalogCache = null
  await switchRuntimeFromTray({ kind: 'switch-runtime', version })
}

/**
 * #141：托盘「检查更新」——后台真检壳与运行时，任一路有新版本就开**启动那张提醒卡**
 * （#140 的 `openUpdateNotice`）。托盘自己不长第二套 UI，票面明令。
 *
 * 三条口径：
 * 1. **强制真检**：走 `service.checkUpdates('manual')`，它直接打 `fetchRuntimeCatalog`，
 *    不经 `ensureCatalog()` 那个 10 分钟 TTL 的 `catalogCache`——用户点的是「现在查」，
 *    拿缓存糊弄等于没点。查完顺手作废 `catalogCache`，让子菜单的「↓ 下载并切换」跟上。
 * 2. **菜单只跳变两次**：开始检查、出结果，各 `refreshTray()` 一次；不新建菜单实例、不定时轮询。
 * 3. **结果只落到那行灰字**：有更新时提醒窗已经开了，托盘不重复弹；查不成就把原因写灰字，
 *    让用户知道「没弹窗」是因为没查到，而不是坏了。
 */
async function checkUpdatesFromTray(): Promise<void> {
  if (trayUpdateCheck?.checking === true) return
  trayUpdateCheck = { checking: true, result: trayUpdateCheck?.result ?? null }
  refreshTray()
  console.log('[shell] 托盘：检查更新')
  let result: UpdateNoticeCheckResult
  try {
    result = await uiService().checkUpdates('manual')
  } catch (error) {
    // 检查本身理论上不抛（runUpdateNoticeCheck 全吐成 reason）；真抛了也得把理由摆到灰字上
    result = {
      notify: false,
      reason: `检查失败：${error instanceof Error ? error.message : String(error)}`,
      notified: [],
    }
  }
  // 手动查完，目录缓存里的旧结果不再作数：作废它，下一次 refreshTray 会真拉一份
  catalogCache = null
  trayUpdateCheck = {
    checking: false,
    result: { notify: result.notify, reason: result.reason, updates: result.notified.length },
  }
  refreshTray()
  console.log(
    `[shell] 托盘检查更新：${result.notify ? `有 ${String(result.notified.length)} 项` : result.reason}`,
  )
}

function onTrayAction(action: TrayAction): void {
  switch (action.kind) {
    case 'toggle-window':
      if (windowVisible) hideMainWindow()
      else showMainWindow()
      return
    case 'quit':
      console.debug('[shell] 托盘：退出')
      void shutdown()
      return
    case 'restart-app':
      void restartAppFromTray()
      return
    case 'open-window':
      if (action.profile !== undefined) void openProfileWindow(action.profile)
      return
    case 'switch-runtime':
      void switchRuntimeFromTray(action)
      return
    case 'download-runtime':
      void downloadRuntimeFromTray(action.version ?? '')
      return
    case 'check-updates':
      // 点了就把菜单关掉（检查在后台跑，结果落到灰字与提醒窗）
      void checkUpdatesFromTray()
      return
    case 'register-cli':
      void registerDshCliFromTray()
      return
    case 'stop-profile':
      if (action.profile !== undefined) void stopProfileFromTray(action.profile)
      return
    case 'restart-profile': {
      // #247：单 profile 重建升级成带 splash（共享 restartDsh 的重启界面通道）；
      // 远程条目仍走 #246 的窗口销毁重建（无服务面可停）。
      const profile = action.profile
      if (profile !== undefined) void restartProfileWithSplash(profile)
      return
    }
    case 'toggle-profile-window':
      // #241：条目级「隐藏·显示」，只动这个 profile 的窗口（一级显隐仍对全部生效）。
      if (action.profile !== undefined) {
        if (sessions.inFront(action.profile)) sessions.hideWindow(action.profile)
        else sessions.focus(action.profile)
      }
      return
    case 'new-profile':
      void openProfileOpDialog('create')
      return
    case 'migrate-profile':
      void openProfileOpDialog('migrate')
      return
  }
}

/** F8：托盘「退出（停止实例）」——销毁那扇窗、停那份额服务面（旧壳 tray.rs:63-73） */
async function stopProfileFromTray(profile: string): Promise<void> {
  // #142：服务面停了，它的提醒窗也别留着（否则会成为无主窗口）
  updateNoticePresenter.close(profile)
  // 关窗 → svc.stop → finally 复位并刷托盘：时序在 profile-session.ts 的 stop()
  await sessions.stop(profile)
}

/** F9：托盘「新建 / 迁移 Profile…」——弹一张小表单窗，动作经官方原生桥交给服务面（#129） */
function openProfileOpDialog(kind: ProfileOpDialogKind): void {
  // 关窗（#162）：页面关不掉自己（html: 文档里的 window.close 是空操作），成功后请壳代劳。
  // rpc 挂在开窗之前，所以窗要后填；真被叫关窗时还没建好就安静跳过（那时页面也还没加载）。
  let dialog: BrowserWindow | null = null
  const closeDialog = (): void => {
    const win = dialog
    if (win !== null) win.close()
  }
  // 每扇窗一份 rpc：壳里其余窗（createProfileWindow）也是这么挂的。共用一份会让多开的
  // 两张窗按请求 id 串回包。
  attachProfileOpRpc({
    run: async (request) => {
      // #241/#9：新建弹窗的「远程 dsh 地址」分流在壳侧落地——写 settings 的 remote_list
      // （去重追加）并刷新托盘；远程条目的开窗/重启通路是 #246 的活。
      if (request.op === 'add-remote') {
        const svc = uiService()
        const addr = request.target ?? ''
        const list = svc.settings().remoteList
        if (!list.includes(addr)) svc.save({ remote_list: [...list, addr] })
        refreshTray()
        return { ok: true, message: '已添加远程地址（远程开窗通路在后续版本接入）' }
      }
      return uiService().profileOp(request)
    },
    close: closeDialog,
  })
    .catch((error: unknown) => {
      // 通道挂不上时**仍然开窗**：页面会把「壳桥不可用」显示成红字，比「点了没反应」强——
      // 那正是本票要根治的失败形态。
      console.warn(`[shell] profile 操作通道挂不上，弹窗降级：${String(error)}`)
      return null
    })
    .then((rpc) => {
      dialog = new BrowserWindow({
        title: kind === 'create' ? '新建 Profile' : '迁移 Profile',
        // #164：platform 传进去，win32/linux 才画标题带（关窗键 + 拖拽面）。
        html: profileDialogHtml(
          kind,
          listProfiles(dshHome(), instanceProfile),
          readShellTheme(dshHome(), instanceProfile),
          platform,
        ),
        renderer,
        titleBarStyle: 'hiddenInset',
        // 高度按内容排：标题居中后没有大片空白，也不留下滚动。
        // #164：win32/linux 的标题带要占一段高度（darwin 有系统红绿灯，不占）。
        frame: {
          width: 460,
          height: dialogTitlebarFrameHeight(kind === 'create' ? 210 : 290, platform),
        },
        ...(rpc === null ? {} : { rpc }),
      })
      dialog.on('closed', () => void refreshTray())
    })
}

/**
 * #140/#142：更新提醒窗句柄（按 profile 一张：多 profile 各查各的，互不叠窗、互不记账）。
 *
 * 判定在服务面那边（#138 判定层 + 纯逻辑策略层），这里只把模型渲染出来开窗；
 * 「没什么可提醒」返回 false，服务面据此不写 lastNotified，下次还能再弹。
 */
/**
 * #140/#142：更新提醒窗（按 profile 一张：多 profile 各查各的，互不叠窗、互不记账）。
 * C1（#179）把窗口表/RPC 表/组装逻辑收进 update-notice-window.ts 的 presenter；
 * 壳侧只剩 show/close 两个动作。判定在服务面那边（#138），「没什么可提醒」返回 false，
 * 服务面据此不写 lastNotified，下次还能再弹。
 */
const updateNoticePresenter = createUpdateNoticePresenter({
  createNoticeWindow: class NoticeWindow implements NoticeWindowLike {
    private readonly win: BrowserWindow

    constructor(options: NoticeWindowOptions) {
      this.win = new BrowserWindow(options)
    }

    close(): void {
      this.win.close()
    }

    on(event: 'closed', handler: () => void): void {
      this.win.on('closed', handler)
    }

    getFrame(): { x: number; y: number; width: number; height: number } {
      return this.win.getFrame()
    }

    setFrame(x: number, y: number, width: number, height: number): void {
      this.win.setFrame(x, y, width, height)
    }
  },
  run: (op) => uiService().updateNoticeOp(op),
  // 页面只读的下载进度：同一个单飞下载器的状态，壳算好百分比再递给页面。
  downloadStatus: () => uiService().downloadStatus(),
  refresh: () => void refreshTray(),
  // #164：platform 决定提醒窗画不画标题带（win32/linux 画，窗高也相应加一段）。
  renderer,
  platform,
})

async function openUpdateNotice(profile: string, payload: UpdateNoticePayload): Promise<boolean> {
  // rpc 实例的懒挂载（动态 import electrobun）由 presenter 兜住：开窗这一步等它一下。
  return updateNoticePresenter.show(profile, payload)
}
/** F12：页面内确认弹窗（旧壳 register/confirm_modal 的等价物）：注入 JS，等 POST 回填，180s 超时。 */
let pendingInput: { flow: string; resolve: (value: string) => void } | null = null
const INPUT_CONFIRM_TIMEOUT_MS = 180_000

async function confirmModal(flow: string, title: string, body: string): Promise<boolean> {
  const win = focusedWindow() ?? bootSession()?.window ?? null
  if (win === null || bootSession()?.state().ready !== true) {
    console.warn('[input] 主窗口不可用，确认弹窗直接按取消处理')
    return false
  }
  const promise = new Promise<string>((resolve) => {
    pendingInput = { flow, resolve }
  })
  showMainWindow()
  try {
    win.webview?.executeJavascript(confirmModalScript({ flow, title, body }))
  } catch (error) {
    console.error(`[input] 确认弹窗注入失败：${String(error)}`)
    pendingInput = null
    return false
  }
  const value = await Promise.race([
    promise,
    Bun.sleep(INPUT_CONFIRM_TIMEOUT_MS).then(() => ''),
  ])
  if (pendingInput?.flow === flow) pendingInput = null
  return value === 'force'
}

/** 托盘「注册 dsh 命令」：冲突时弹确认（旧壳 confirm_modal），确认才强制覆盖。 */
async function registerDshCliFromTray(): Promise<void> {
  const state = registerCli.cached()
  let force = false
  if (state.kind === 'conflict') {
    const target = state.resolved ?? '未知目标'
    const confirmed = await confirmModal(
      'register-cli',
      '检测到 dsh 命令冲突',
      `当前系统里的 dsh 指向：\n${target}\n\n注册会把 /usr/local/bin/dsh 指到本壳的垫片，原目标会先备份。`,
    )
    if (!confirmed) {
      console.log('[register] 用户取消覆盖，注册未完成')
      return
    }
    force = true
  }
  const result = await registerCli.register({ force })
  console.log(`[register] ${result.ok ? '注册成功' : '注册未完成'}：${result.message}`)
  try {
    notifier.notify(
      SCENARIO.REGISTER_CLI,
      result.message,
      result.ok
        ? 'dsh 命令注册成功'
        : result.code === 'canceled'
          ? 'dsh 命令注册取消'
          : result.code === 'conflict'
            ? 'dsh 命令注册有冲突'
            : 'dsh 命令注册失败',
    )
  } catch (error) {
    // 通知挂了不能连累托盘刷新——「出错了但没有日志、菜单不更新」的嫌疑路径（#62 实测）
    console.error(`[register] 通知投递失败：${error instanceof Error ? error.message : String(error)}`)
  }
  // 菜单只走 setState 更新：refreshTray 内部已有「异步刷新完再 setState」的延时更新，
  // 这里不再额外 await/重复刷——菜单开着时多余的动作会把它顶掉（用户口径：拒绝所有菜单重建）
  refreshTray()
}

// ---- 单实例：已有实例活着就不起第二份宿主，只请它把窗口带到前台 ----
// （Electrobun 2.0.2 没有单实例 API，旧 Tauri 壳用的是 tauri-plugin-single-instance）
// P2 测试钩子（旧壳 lib.rs:742-757）：DSH_DESKTOP_NO_SINGLETON=1 只跳过这把壳层锁——
// CEF 层的 Chromium ProcessSingleton（按 <identifier>/<channel>/CEF 数据目录加锁）不归它管；
// 并行带窗双实例还要在构建期用 DSH_SHELL_DEV_IDENTIFIER 换 id（见 electrobun.config / README #38）。
const instanceFile = join(appSupportDir(), 'shell-instance.json')
// #119 接班等待（主进程重拉时经 env 传旧壳 pid）：先等旧壳真退干净再抢锁。
const relaunchParent = relaunchParentPid(process.env)
if (relaunchParent !== null) {
  console.log(`[shell] 重启接班：等待上一个实例（pid ${String(relaunchParent)}）退出`)
  const gone = await awaitParentExit({ pid: relaunchParent, isAlive: defaultIsAlive })
  if (gone) console.log(`[shell] 重启接班：上一个实例已退出`)
  else console.warn(`[shell] 重启接班：等待超时（${String(relaunchParent)} 仍在），照常启动`)
}
const instance = acquireInstance(instanceFile, instanceProfile, {
  // 接班窗口的兜底：即便上面的等待超时了，也不把刚退未退净的旧实例当成「已有实例」。
  ...(relaunchParent === null ? {} : { succeedsPid: relaunchParent }),
})
// #123：抢到实例位 ≠ 锁写下来了。写不下来时按维护者拍板的 A 口径——fail-open + 明说：
// 照常启动（一次 IO 抖动不该让用户打不开应用），但把「单实例保护不可用」写进日志。
// 以前这里是彻底无声：应用看起来一切正常，第二个实例却能再起一份壳。
if (instance.lockError !== null) {
  console.warn(
    `[shell] 单实例保护不可用：实例位没记下来（${instance.lockError}）。本次照常启动，但再开一个可能起两份。` +
      `锁文件：${instanceFile}`,
  )
}
const skipSingleton = (process.env.DSH_DESKTOP_NO_SINGLETON ?? '') !== ''
if (!instance.acquired && !skipSingleton) {
  const previous = instance.previous
  if (previous !== null && previous.origin !== '') {
    try {
      await fetch(activateUrl(previous), { method: 'POST' })
      console.log(`[shell] 已有实例在运行（pid = ${String(previous.pid)}），已请求激活后退出`)
    } catch (error) {
      console.error(`[shell] 激活已有实例失败：${String(error)}`)
    }
  } else {
    console.log(`[shell] 已有实例正在启动（pid = ${String(previous?.pid ?? '?')}），本次不再起宿主`)
  }
  // 第二个实例不做任何服务面工作，直接退出（不起宿主、不抢端口、不写台账）
  process.exit(0)
}

// #243 壳→主进程上报：register/心跳/退出意图（restart）。origin+token 只有「主进程拉起」的
// 壳才有 env（daemon/spawn.ts shellDaemonEnv）；dev 直跑/老包升级 = 没有 → reporter 全程 no-op，
// 重启路径随之显式降级（restartDesktopApp 拒绝自杀）。
const shellReporter = createShellReporter({
  controlOrigin: process.env.DSH_SHELL_CONTROL_URL,
  token: process.env.DSH_SHELL_CONTROL_TOKEN,
  profile: instanceProfile,
  openProfiles: () => sessions.openProfiles(),
  onLog: shellLog,
})

// ---- 启动界面：起宿主那几十秒里给用户看的东西（无窗口模式跳过）----
let splash: BrowserWindow | null = null
/**
 * 启动界面的 CEF 浏览器要到 `dom-ready` 才真存在。在那之前调 `executeJavascript` 会打到
 * 空的 `scoped_refptr<CefBrowser>` 上，**原生层直接 FATAL 记账退出**（实测：`Check failed: ptr_.`
 * in `cef_scoped_refptr.h`，栈在 `-[CEFWebViewImpl evaluateJavaScriptWithNoCompletion:]`）——
 * 那是 abort，JS 的 try/catch 拦不住。所以先只记阶段，等 dom-ready 再补推。
 */
let splashReady = false
let lastStage: ShellStage = 'instance'
const pushStage = (): void => {
  if (splash === null || !splashReady) return
  try {
    splash.webview?.executeJavascript(splashStageScript(lastStage))
  } catch (error) {
    console.warn(`[shell] 启动阶段进度注入失败：${String(error)}`)
  }
}


/**
 * 冷启动第 ④ 步：托盘。#117 —— 托盘排在 DSH **之前**，这是这票的全部要害。
 *
 * 以前托盘排在最后（DSH 就绪之后），有个硬后果：DSH 一旦起不来（运行时版本问题是最常见
 * 的那类），整条流断在托盘之前，用户连「换一个运行时」都点不到，只能退出去手改
 * desktop-settings.json。托盘先在就不同了：它不需要 DSH 也能建出来（状态行走 serviceStatus
 * 的 stopped / failed 分支，说得清「DSH 为什么没起来」），于是 DSH 起不来时用户仍然能
 * 换一版再试、能退出。
 */
const startupTray = (): void => {
  // 无窗口模式（CI/黑盒）不建托盘——那里没有窗口可隐藏，托盘只会碍事。
  if (noWindow) return
  const image = trayImagePath()
  shellLog.debug(`托盘图标：${image ?? '（未找到）'}`)
  if (image === null) {
    shellLog.warn('找不到托盘图标（resources/tray.png / runtime/tray.png），本次不建托盘')
  } else {
    tray = createTray({
      image,
      state: trayState(),
      onAction: onTrayAction,
      onEmptyClick: () => {
        // P8（旧壳 tray.rs:265-285，#181）：左键单击托盘 = 聚焦最后活跃窗口；没有就开主 profile 的窗
        const win = focusedWindow()
        if (win !== null && win !== undefined) {
          win.unminimize?.()
          win.show()
          win.activate()
        } else {
          void openProfileWindow(instanceProfile)
        }
      },
      log: shellLog,
    })
    // 菜单保鲜（#62）：状态每 5s 走一次 fs 级快探测（不 spawn）。Electrobun 的 Tray 只有
    // tray-clicked 一个事件、拿不到「菜单即将打开」的钩子，所以保鲜靠轮询而不是打开时现查；
    // 只有状态真变了才 refreshTray()（它内部对菜单 JSON 去重，没变就完全不碰原生菜单）。
    setInterval(() => {
      if (tray === null) return
      const before = registerCli.cached()
      const after = registerCli.poll()
      if (after.kind === before.kind && after.resolved === before.resolved) return
      refreshTray()
    }, 5_000)
    refreshTray()
  }
  // macOS Dock 图标被点（无可见窗口时）：把主窗带回来
  app.on('reopen', () => {
    console.debug('[shell] Dock 再激活：显示主窗')
    showMainWindow()
  })
}

/**
 * 冷启动第 ⑤ 步：启动界面（起 DSH 那几十秒里给用户看的东西）。
 * 排在托盘之后：托盘是「出事了还能自救」的常驻入口，优先级高于一次性的进度界面。
 * 启动期间 serviceOptionsFor.onStage 推的阶段都记在 lastStage 上，这里 dom-ready 后补推一次。
 */
// 返回窗口而不直接写模块变量：赋值留在调用点，TypeScript 的控制流分析才看得见
// 「splash 现在可能为 null」这件事（后续两处失败提示都在模块顶层读它）。
const startupSplash = (): BrowserWindow | null => {
  if (noWindow) return null
  const win = new BrowserWindow({
    title: APP_NAME,
    html: splashHtml(readShellTheme(dshHome(), instanceProfile), platform),
    renderer,
    titleBarStyle: 'hiddenInset',
    // #164：win32/linux 多一条标题带（可拖、无关闭键），窗高相应加一段。
    frame: {
      width: SPLASH_WIDTH,
      height: dialogTitlebarFrameHeight(SPLASH_HEIGHT, platform),
    },
  })
  // 页面还没加载完时推阶段会被丢掉：dom-ready 之后再补推一次（也是浏览器对象可用的信号）
  win.on('dom-ready', () => {
    splashReady = true
    pushStage()
  })
  return win
}

// dsh 系统命令注册（旧壳 `register/`）：shim 指向当前运行时，探测走用户真实登录 shell，
// 状态缓存起来供托盘用（菜单重建很频繁，**绝不在这里同步 spawn shell**）。
const registerCli = createRegisterCli({
  log: registerLog,
  appSupport: appSupportDir(),
  shellCommand: () => {
    const paths = uiService().paths
    // shim 里的 bun 优先取 launcher 旁的运行时（Electrobun 约定 <app 树>/bin/，bun.exe 就在 launcher 旁边）——
    // 自定义安装/解压目录说了算；拿不到（dev 等）再退回当前进程的执行器（#62）
    const bunBesideLauncher =
      paths.launcherPath !== null
        ? join(dirname(paths.launcherPath), process.platform === 'win32' ? 'bun.exe' : 'bun')
        : null
    const bun = bunBesideLauncher !== null && existsSync(bunBesideLauncher) ? bunBesideLauncher : process.execPath
    return [bun, '--no-install', '--preload', paths.preloadFile, join(paths.dshLibDir, 'bin.js')]
  },
})

// 通知：决策在壳里（notify-policy）；macOS 上投递走我们自己的 UN 桥（旧壳 `notify_un.rs` 的路子：
// 进程自己就有 bundle 身份、状态可查、授权可申请），桥不可用或投递失败再退回 Electrobun 的原生通道。
// 裸 dev 进程没有 bundle id，UN 会硬崩——所以只在 available 时才调。
const notifyBridge = createNativeNotify({ log: notifyLog })
const notifier: Notifier = createNotifier({
  notifications: bootSettings.notifications,
  home: dshHome(),
  appName: APP_NAME,
  show: (options) => {
    if (
      notifyBridge.available &&
      notifyBridge.post({ title: options.title, body: options.body ?? '', sound: options.silent !== true })
    ) {
      return
    }
    // Electrobun 自带的原生通道（上上版 Windows 注册成功走的就是它，别抢它前面）
    if (Utils.showNotification) {
      Utils.showNotification(options)
      return
    }
    // 连原生通道都没有的平台才退到 PowerShell 气泡（notify-win.ts）
    showWindowsBalloon({ title: options.title, body: options.body ?? '' })
  },
  isFullscreen: () => bootSession()?.window?.isFullScreen() ?? false,
  // #115：壳级通知（启动失败 / 服务健康 / 托盘提示）没有 profile 归属，任一 DSH 窗口在前台就不打扰
  isFocused: () => anyWindowInFront(),
  onLog: notifyLog,
})
let bootService: ShellService
try {
  bootService = await sessions.ensureService(instanceProfile)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[shell] 启动失败：${message}`)
  notifier.notify(SCENARIO.STARTUP_ERROR, `桌面壳启动失败：${message}`)
  // #117：能走到这里的是**壳自己**立不起服务面（设置文件写不进、端口听不了、HTTP 面起不来），
  // 而不是 DSH 起不来——而托盘的状态来自服务面，托盘/启动界面都还没有自救入口可言。
  // 这种就如实抛出去（dev 直接崩、CI 判红），不再「在屏幕上留 30 秒然后自己退掉」。
  throw error
}
// ---- #117 冷启动编排：服务面 → 启动界面 → 托盘 → DSH → 桌面窗口 ----
splash = startupSplash()
// #203：第一个窗口（启动界面）一出就设窗口图标 —— 现存窗口 WM_SETICON 立即生效，
// 窗口类默认改写让主窗/后续弹窗不再走系统白框回退；失败只记日志不拖累启动。
if (!noWindow) applyWindowsIcon(shellLog, windowIconCandidates(dirname(process.execPath)))
startupTray()

// DSH。就这一步失败也**不退出**：托盘已经在了，状态行摆着原因，
// 用户能换一个运行时版本再试，也能从托盘退出（旧行为是报错→30 秒→自己退掉，等于把自救入口没收走）。
let dshStarted = true
try {
} catch (error) {
  dshStarted = false
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[shell] dsh 启动失败：${message}`)
  notifier.notify(SCENARIO.STARTUP_ERROR, `dsh 启动失败：${message}`)
  // 无窗口模式（CI/黑盒）没有托盘可救，把失败原样抛出去：缝 ① 靠这一条判红
  if (noWindow) throw error
  // 启动界面留着红字，告诉他还有别的路（启动界面还没到 dom-ready 时不能推 JS：原生层会 FATAL）
  if (splash !== null && splashReady) {
    try {
      splash.webview?.executeJavascript(splashFailScript(`${message}\n\n托盘已就绪：在托盘里换运行时版本或退出。`))
    } catch (error) {
      console.warn(`[shell] 启动失败提示注入失败：${String(error)}`)
    }
  }
}
// #243：无论 DSH 起没起来都向主进程报到位 + 开始心跳（老包/dev = no-op）。
void shellReporter.start()
if (dshStarted) {
  console.log(`SHELL-READY ${JSON.stringify({ ...bootService.state, locale })}`)
  // 服务面就绪：把 origin/页面 URL 回填给实例锁，第二个壳才能激活这个窗口
  updateInstance(instanceFile, process.pid, { origin: bootService.state.origin, pageUrl: bootService.state.pageUrl })
  // P2 测试钩子（旧壳 lib.rs:744 _AUTO_QUIT）：服务面就绪后延迟自动退出，给 CI/探针一个干净的结束信号
  if ((process.env.DSH_DESKTOP_AUTO_QUIT ?? '') !== '') {
    const delayMs = Number(process.env.DSH_DESKTOP_AUTO_QUIT) > 0 ? Number(process.env.DSH_DESKTOP_AUTO_QUIT) : 3_000
    setTimeout(() => {
      console.debug('[shell] DSH_DESKTOP_AUTO_QUIT 触发自动退出')
      void shutdown()
    }, delayMs).unref?.()
  }
}

// #117：DSH 没起来就不建桌面窗口（页面要的是 DSH），但**启动界面留着、托盘留着**——
// 这正是这张单要的死局出口。
let startupBlocked = false
if (!noWindow) {
  // 端口被陌生程序占着（service.state.blocked）或 DSH 根本没起来，都不进桌面窗口。
  if (bootService.state.status !== 'running') {
    // #117：失败原因已经在 ensureRunning 的 catch 里推过启动界面了，这里不重复推。
    startupBlocked = true
  }
  // 标题栏形态与旧壳对齐：macOS 保留原生红绿灯并叠在内容上（旧壳 TitleBarStyle::Overlay），
  // Windows/Linux 隐藏原生标题栏，caption 行与窗口按钮由插件 client 自绘（旧壳 decorations:false）。
  if (!startupBlocked) await sessions.attachWindow(instanceProfile, bootService)
  // #247「先就绪先开」：重启应用/崩溃自愈后主进程塞来的恢复清单（spawn.ts shellDaemonEnv 写入）。
  // 启动 profile 的窗口上面已接好；其余逐份拉起（服务面就绪一份开一份窗，不攒批次）。
  // 失败不挡启动——托盘里还能手动开。
  const restoreList = (process.env[SHELL_RESTORE_PROFILES_ENV] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && entry !== instanceProfile)
  if (restoreList.length > 0) {
    console.log(`[shell] 恢复上一次开着的窗口：${restoreList.join('、')}`)
    void (async () => {
      for (const profile of restoreList) {
        try {
          await openProfileWindow(profile)
        } catch (error) {
          console.error(`[shell] 恢复窗口失败（${profile}）：${String(error)}`)
        }
      }
    })()
  }
  // 右键菜单里我们自己那几项（原生 role 由系统处理，不会回到这里）；

/**
 * 壳托管 DevTools：用 CDP 前端 URL 建一扇普通窗口，窗口归壳所有——关闭即销毁前端页面。
 * 三平台同一条路径；不再起窗口枚举/关窗回收定时器。
 */
async function openDevToolsWindow(port: number): Promise<void> {
  if (devToolsWindow !== null) {
    devToolsWindow.show()
    devToolsWindow.focus()
    return
  }
  // 旧原生入口留下的 inspector target 先回收（新窗口的前端此时尚未创建）
  if (await closeDevToolsTarget(port)) {
    shellLog.debug('开发者工具：已回收旧的 inspector target')
  }
  const url = await resolveDevToolsInspectorUrl(port)
  if (url === null) {
    shellLog.debug(`开发者工具：CDP 口 ${port} 没有可用的页面目标`)
    return
  }
  const win = new BrowserWindow({
    title: `${APP_NAME} · DevTools`,
    url,
    renderer,
    frame: { x: 80, y: 80, width: 1000, height: 720 },
  })
  devToolsWindow = win
  // DevTools 窗口也是 launcher.exe 进程的顶层窗口，同样吃白框回退（#203 三轮）；
  // 立即补图标（applyWindowsIcon 幂等带缓存，不依赖下一次 refreshTray 才覆盖）。
  if (process.platform === 'win32') applyWindowsIcon(shellLog, windowIconCandidates(dirname(process.execPath)))
  win.on('close', () => {
    if (devToolsWindow !== win) return
    devToolsWindow = null
    shellLog.debug('开发者工具：DevTools 窗口已关闭，前端已销毁')
  })
}
  ContextMenu.on('context-menu-clicked', (event) => {
    const detail = (event as { data?: { action?: string; data?: { url?: string; path?: string } } }).data
    const action = detail?.action ?? ''
    // 工作区文件行：打开文件 / 打开文件夹（系统默认方式，Utils.openPath）
    if (action === SHELL_MENU_ACTIONS.openPath) {
      const path = detail?.data?.path
      if (typeof path === 'string' && isOpenablePath(path)) {
        if (!Utils.openPath(path)) console.warn(`[shell] 系统没接住打开：${path}`)
      }
      return
    }
    // 菜单：打开当前聚焦窗口的 DevTools——落地方式来自后端描述符（#110）：
    // CEF 走 openDevTools（应用内 inspector）；WebView2 走合成 F12（#106 返工：上游 WebView2 壳无 openDevTools 实现）。
    if (action === SHELL_MENU_ACTIONS.openDevTools) {
      void openDevToolsWindow(devToolsPlan.port ?? DEVTOOLS_DEFAULT_PORT)
      return
    }
    const url = detail?.data?.url
    if (action === SHELL_MENU_ACTIONS.reload) {
      focusedWindow()?.webview?.loadURL(uiService().state.pageUrl)
      return
    }
    if (action === SHELL_MENU_ACTIONS.openExternal && url !== undefined) {
      Utils.openExternal(url)
      return
    }
    if (action === SHELL_MENU_ACTIONS.copyLink && url !== undefined) {
      Utils.clipboardWriteText(url)
      return
    }
  })
  // 测试钩子：启动时把这些 profile 的窗口一并开出来（多窗口的实机/CI 验证用，逗号分隔）
  const extraProfiles = (process.env.DSH_SHELL_OPEN_PROFILES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && entry !== instanceProfile)
  for (const profile of extraProfiles) void openProfileWindow(profile)
}

// 托盘的建法已经上移到冷启动编排里（startupTray，排在 DSH 之前——见 #117）。

let stopping = false
// DevTools 窗口引用：必须在顶层 await 之前初始化——ContextMenu 的 openDevTools 回调在启动期就能触发，
// undefined !== null 为真，未初始化的 let 会误走 show() 分支（bug #201 同因）。
let devToolsWindow: BrowserWindow | null = null
// function 声明（非 const 箭头）：顶层 await 的启动编排把求值冻结在 ensureRunning 上，
// 而托盘（startupTray）已在冻结前排好 —— 启动期间点「退出应用」会重入这里；
// const 箭头此时还是未初始化绑定（bundle 里即 undefined，实测 TypeError: shutdown is not a function），
// function 声明整体提升，冻结期内也是完整函数（bug #201）。
async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  quitting = true
  // #243/#247：退出前上报（尽力而为）。macOS 不带意图：主进程留守值守（后台语义，等下一次激活）；
  // win/linux 带 quit：主进程跟随退出（全退口径，防 watchdog 回拉）。
  shellReporter.reportExit(platform === 'darwin' ? undefined : 'quit')
  // 托盘先摘：否则退出过程中它还会响菜单（点了就是另一个 shutdown）
  tray?.destroy()
  tray = null
  // 挂起的几何定时器不丢：退出前把各窗当前态同步落盘（上次只 clear，最后 400ms 内的变动全丢）

  sessions.flushAllFrames()
  try {
    // 先摘服务面与宿主（SIGTERM → 宽限期 → SIGKILL，并等它真退出）再让框架退出；
    // 不能像以前那样发完信号就走——壳一退，宿主就被 launchd 收养，变成占着会话的孤儿。
    // stopAllServices 内每份 stop 自带 try/catch（失败只记日志不串台）；

    await Promise.race([sessions.stopAllServices(), Bun.sleep(SHELL_STOP_DEADLINE_MS)])
  } catch (error) {
    console.error(`[shell] 停止服务面失败：${String(error)}`)
  }
  releaseInstance(instanceFile, process.pid)
  Utils.quit()
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
process.on('exit', () => {
  if (!stopping) {
    stopping = true
    try {
      for (const session of sessions.list()) {
        if (session.service !== null) void session.service.stop()
      }
    } catch (error) {
      console.warn(`[shell] 退出清理异常：${String(error)}`)
    }
  }
})
