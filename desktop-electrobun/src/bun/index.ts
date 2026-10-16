// Electrobun 主进程入口：CEF 断言 → 起服务面 → 建窗。
//
// 服务面（运行时就位、端口认领、起宿主、取 cookie、loopback 服务）在 service.ts 里，
// 那一层不 import electrobun；这里只做「渲染器断言」和「窗口」两件事。

import { ApplicationMenu, BrowserView, BrowserWindow, BuildConfig, ContextMenu, Screen, Utils, app } from 'electrobun/bun'
import { acceptShimScript } from './accept-shim.ts'
import { systemLocale } from './locale.ts'
import { installApplicationMenu } from './menu.ts'
import { deriveMaximized, ensureNativeMaximizeStyles, getWorkAreaForFrame, HEAL_MAX_REPLACES, healVerdict, isMaximizedPlacementDamaged, toggleWindowMaximize, windowMaxState, type WindowMaxState } from './window-max.ts'
import { shellLogLine } from './shell-log.ts'
import { bootPreloadScript } from './preload.ts'
import { attachShellRpc } from './rpc-bridge.ts'
import { startService, type ServiceOptions, type ShellService } from './service.ts'
import { createNativeNotify } from './notify-un.ts'
import type { RuntimeSnapshot } from './commands.ts'
import { ensureWindowsNotifyIdentity } from './win-notify-identity.ts'
import type { RuntimeDownloadStatus } from './runtime-install.ts'
import { SHELL_MENU_ACTIONS, contextMenuItems, isOpenablePath } from './context-menu.ts'
import { isExternalUrl } from './external.ts'
import { APP_NAME } from '../shared/app.ts'
import { appSupportDir, dshHome, resolveLauncherExecutablePath, trayImagePath } from './runtime.ts'
import { acquireInstance, activateUrl, defaultIsAlive, releaseInstance, updateInstance } from './single-instance.ts'
import { awaitParentExit, relaunchDesktopApp, relaunchParentPid } from './app-restart.ts'
import { createViewRegistry } from '../shared/view-grant.ts'
import { createGuestManager, type GuestViewLike } from './guest-manager.ts'
import { loadNativeWebviewCore } from './native-webview.ts'
import { GUEST_DEFAULT_URL, OFFSCREEN_GUEST_RECT } from '../shared/guest-policy.ts'
import { resolveAppVersion } from './app-version.ts'
import { SPLASH_HEIGHT, SPLASH_WIDTH, splashFailScript, splashHtml, splashStageScript } from './splash.ts'
import { stageLabel, stagePercent, type ShellStage } from './stages.ts'
import { createTray, type TrayHandle } from './tray.ts'
import { trayMenu, type TrayAction, type TrayCatalogItem, type TrayState } from './tray-menu.ts'
import { listProfiles } from './profiles.ts'
import { profileDialogHtml, type ProfileOpDialogKind } from './profile-dialog.ts'
import { confirmModalScript } from './input-modal.ts'
import { navRulesFor } from '../shared/nav-rules.ts'
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  readWindowFrame,
  readWindowMaximized,
  sanitizeFrame,
  writeWindowFrame,
  type DisplayBounds,
  type WindowFrame,
} from './window-state.ts'
import { loadSettings } from './settings-store.ts'
import { applyCdpDebugPort, DEVTOOLS_PORT_ENV, DEVTOOLS_PORT_OVERRIDE_ENV, devToolsMenuEnabled, isPortBindable, planDevToolsBoot, sendDevToolsKeystroke } from './devtools.ts'
import { activeProfile, type DesktopSettings } from '../shared/settings.ts'
import { closeAction, offsetFrame, planWindowOpen, windowKey } from '../shared/window-targets.ts'
import type { LaneForwarder } from './lane-forwarder.ts'
import { createNotifier, type Notifier } from './notifications.ts'
import { showWindowsBalloon } from './notify-win.ts'
import { SCENARIO } from '../shared/notify-policy.ts'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { createRegisterCli } from './register-cli.ts'
import { registerTrayLabel } from '../shared/register-cli.ts'

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
const wantsCef = available.includes('cef')
const renderer: 'cef' | 'native' = wantsCef ? 'cef' : 'native'
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
if (platform === 'win32') ensureWindowsNotifyIdentity({ log: (line) => console.log(line) })
// 系统语言：CEF 默认 en-US，页面语言跟着错；旧壳（WKWebView）是天然跟随系统的。
const locale = await systemLocale()
// 页面外链与右键菜单都要主进程出面：CEF 不会自己弹菜单，也不接管 window.open。
// 回调注册在窗口之前，闭包里的 mainWindow 在窗口建好后才有值。
/** 每个 profile 一份窗口 + 一份服务面（旧壳 `desktop/src-tauri/src/ui/multiwin.rs` 的等价物：
 *  每 profile 至多一窗；关窗只销毁 UI、实例继续跑；主窗关窗回托盘）。 */
interface ProfileWindow {
  profile: string
  window: BrowserWindow
  /** 该窗的 CEF 浏览器就绪（dom-ready 之前 loadURL/executeJavascript 会打到空 ref） */
  ready: boolean
}
const windows = new Map<string, ProfileWindow>()
const services = new Map<string, ShellService>()
/** F8：正在「退出（停止实例）」的 profile——will-close 对它们放行真关窗 */
const stoppingProfiles = new Set<string>()
/** D5：首次关窗回托盘提示过一次的 profile（进程生命周期内一次） */
const trayHintShown = new Set<string>()
/** 最近聚焦的窗口 profile；托盘「显示/隐藏窗口」作用在它身上（旧壳 focused_window_label）。 */
let focusedProfile: string | null = null
let mainWindow: BrowserWindow | null = null
/** 主窗的 CEF 浏览器就绪（dom-ready）之前，`loadURL` 与 `executeJavascript` 都会打到空 ref 上 */
let mainWindowReady = false

// ---- 托盘 + 窗口几何：关窗回托盘、Dock 再激活、位置尺寸记忆 ----
// 旧 Tauri 壳用 tauri-plugin-window-state + tauri-plugin-single-instance；Electrobun 两样都没有。
const windowStateFile = join(appSupportDir(), 'window.json')
// 实例锁与托盘都要 profile：DSH_PROFILE > 设置 > 默认。
// 设置文件可能还不存在（首启），读失败就按默认——真正的落盘由 service 那一步做。
const bootSettings: DesktopSettings = loadSettings({ home: dshHome() }).settings
const instanceProfile = activeProfile(bootSettings, process.env)

// ---- #69 开发者工具开关：打包态是否给 CEF 开远程调试口 ----
// env 必须在任何 CEF 进程起来前就位（splash 就是 CEF 窗、native core 也在下面），
// 所以启动决策放这里做完；菜单可见 ⇔ 口已开（同一份 plan 推出，禁中间态）。
const devToolsPlan = await planDevToolsBoot({
  isPackaged: build.isPackaged,
  settingOn: bootSettings.devTools === true,
  envOverride: process.env[DEVTOOLS_PORT_OVERRIDE_ENV],
  isFree: isPortBindable,
})
// C environ 双写（dylib 用 C getenv 读开关；Bun map 写入不穿透，实测见 devtools.ts 头注）。
// 写入失败 = CDP 开不了：cdpReady 落 false，菜单同批不出现（禁中间态，fail-closed）。
const devToolsCdpReady = devToolsPlan.enableCdp && devToolsPlan.port !== null
  ? applyCdpDebugPort(devToolsPlan.port, { cefAvailable: wantsCef })
  : false
if (devToolsPlan.enableCdp && !devToolsCdpReady) {
  console.error('[shell] 开发者工具：调试口 env 写入失败（C environ 写入不可用），本次不开口、不出菜单')
}
if (devToolsPlan.reason === 'enabled-by-setting') {
  console.log(`[shell] 开发者工具：已开启，${wantsCef ? 'CEF' : 'WebView2'} 远程调试口 127.0.0.1:${String(devToolsPlan.port)}（重启后生效${wantsCef ? '' : '；DevTools 按需打开：F12 或右键菜单（合成 F12），不自动弹窗'}；本机任意进程可借该口在页面里执行代码）`)
} else if (devToolsPlan.reason === 'port-unavailable') {
  console.error(`[shell] 开发者工具：端口 ${String(devToolsPlan.port)} 被占用，本次不开调试口、不出菜单（可用 ${DEVTOOLS_PORT_OVERRIDE_ENV} 换口）`)
} else if (devToolsPlan.reason === 'port-invalid') {
  console.error(`[shell] 开发者工具：${DEVTOOLS_PORT_OVERRIDE_ENV} 非法（需要 1-65535 整数），按未开启处理`)
} else if (devToolsPlan.reason === 'dev-build') {
  console.log('[shell] 开发者工具：dev 构建，DevTools 菜单恒可见（打包态才吃 dev_tools 开关）')
} else {
  console.log('[shell] 开发者工具：未开启（设置 dev_tools）——不监听调试口、不出菜单')
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
console.log(
  nativeCore.core === null
    ? `[guest] 原生核不可用：${nativeCore.error ?? '未知原因'}`
    : `[guest] 原生核就绪：${nativeCore.libPath}`
)
const guests = createGuestManager({
  log: (line) => console.log(line),
  core: nativeCore.core,
  // guest 挂在发起调用的那个窗口上（多窗口下天然跟随宿主窗口）。
  createView: ({ partition, caller }) => {
    const hit = windows.get(caller.profile)
    if (hit === undefined) return null
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
    const hit = windows.get(caller.profile)
    if (hit === undefined || !hit.ready) return
    try {
      hit.window.webview?.executeJavascript(script)
    } catch (error) {
      console.warn(`[guest] 状态推送失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
})
let windowVisible = false
/** 隐藏回托盘前窗口是否处于最大化（ffi hide/show 往返会丢最大化，show 前补回，#50 验证反馈）。 */
let hiddenWhileMaximized = false
/** #73：启动要恢复最大化的窗——建窗/dom-ready 的 maximize 在 Windows 实测不稳，改在首次 focus 断言补齐。 */
const pendingStartMaximized = new Set<string>()
let quitting = false
/** 关窗后是否只是隐藏：没有托盘（原生层没建成）时隐藏就叫不回来了，那时关窗等于退出。 */
const closeToTray = (): boolean => tray !== null

function displayBounds(): DisplayBounds[] {
  try {
    return Screen.getAllDisplays().map((display) => display.bounds)
  } catch (error) {
    console.warn(`[shell] 取显示器信息失败，窗口用默认尺寸：${String(error)}`)
    return []
  }
}

/** 落盘几何 → 可用几何；越界/太小/坏数据一律回默认（外接屏拔掉后不能把窗口丢在屏幕外）。 */
/** D3：每窗几何记忆——主窗沿用 window.json，其余 profile 各存 window-<profile>.json */
function windowStateFileOf(profile: string): string {
  return profile === instanceProfile ? windowStateFile : join(appSupportDir(), `window-${profile}.json`)
}

function restoreWindowFrame(profile: string = instanceProfile): WindowFrame {
  const saved = sanitizeFrame(readWindowFrame(windowStateFileOf(profile)), displayBounds())
  if (saved === null) return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT, x: 0, y: 0 }
  console.log(`[shell] 还原窗口位置：${String(saved.x)},${String(saved.y)} ${String(saved.width)}×${String(saved.height)}`)
  return saved
}

/** 拖动/缩放会连续触发：合并 400ms 只写一次（D3：按 profile 各写各的文件） */
const frameSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
function scheduleFrameSave(win: BrowserWindow, profile: string): void {
  const existing = frameSaveTimers.get(profile)
  if (existing !== undefined) clearTimeout(existing)
  frameSaveTimers.set(
    profile,
    setTimeout(() => {
      frameSaveTimers.delete(profile)
      try {
        saveFrameNow(win, profile)
      } catch (error) {
        console.warn(`[shell] 窗口几何落盘失败：${String(error)}`)
      }
    }, 400),
  )
}
/**
 * 几何立即落盘（scheduleFrameSave 定时器 / 关窗 flush / 退出 flush 三处共用）：
 * 最大化态 = 原生旗标 ∨ 几何推导——后者兜住旗标未落的窗口（启动期、系统贴靠
 * 等场景），只记旗标的话重启就丢最大化态。
 */
function saveFrameNow(win: BrowserWindow, profile: string): void {
  const frame = win.getFrame()
  const native = win.isMaximized()
  writeWindowFrame(
    windowStateFileOf(profile),
    { x: Math.round(frame.x), y: Math.round(frame.y), width: Math.round(frame.width), height: Math.round(frame.height) },
    native || deriveMaximized(frame, getWorkAreaForFrame(frame), native),
  )
}

/**
 * 关窗策略（will-close / RPC window_close / 兑底端点三处共用，#50 验证反馈）：
 * 主窗+有托盘 → 隐藏回托盘（进程继续）；主窗无托盘 → 直接退；其余 profile → 只销毁。
 */
function performClosePolicy(win: BrowserWindow, profile: string): 'hidden' | 'quit' | 'close' {
  if (closeAction(profile, instanceProfile) === 'hide-to-tray' && closeToTray()) {
    // D5：首次关窗回托盘时提示一次（旧壳关窗提示的等价物；用户知道了就不再弹）
    if (!trayHintShown.has(profile)) {
      trayHintShown.add(profile)
      notifier.notify(SCENARIO.WINDOW_LIFECYCLE, '窗口已最小化到托盘，点托盘图标可找回。')
    }
    hiddenWhileMaximized = win.isMaximized()
    win.hide()
    windowVisible = false
    refreshTray()
    return 'hidden'
  }
  if (!closeToTray() && profile === instanceProfile) return 'quit'
  return 'close'
}
/** 版本目录缓存：托盘子菜单用它渲染「↓ 下载并切换」，但不该每刷一次托盘就打网络（旧壳也拿缓存）。 */
const TRAY_CATALOG_TTL_MS = 10 * 60_000
let catalogCache: { at: number; entries: TrayCatalogItem[] } | null = null
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
    .catch((error: unknown) => {
      console.warn(`[shell] 拉运行时版本目录失败：${String(error)}`)
    })
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
  const focused = focusedProfile === null ? undefined : services.get(focusedProfile)
  return focused ?? service
}

function trayState(): TrayState {
  const settings = uiService().settings()
  const snapshot = uiService().runtime()
  const download = downloadStatusSafe()
  return {
    // 可见性是「当前那个窗口」的：多窗口下托盘的显示/隐藏只动一个
    windowVisible: focusedWindow()?.isVisible() ?? windowVisible,
    profile: uiService().paths.profile,
    // 多 profile：菜单按 home 下的 profile 目录列，点了开/聚焦那一份窗口
    profiles: listProfiles(dshHome(), instanceProfile),
    openWindows: [...windows.keys()],
    profileRows: listProfiles(dshHome(), instanceProfile).map((profile) => {
      const svc = services.get(profile)
      const origin = svc?.state.origin ?? ''
      const port = Number(origin.split(':').pop() ?? '') || null
      return {
        profile,
        open: windows.has(profile),
        running: (svc?.state.hostPid ?? 0) > 0,
        port,
        focused: focusedProfile === profile,
      }
    }),
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
    catalog: catalogCache?.entries ?? [],
    downloading: download.active && download.version !== '' ? download.version : null,
    remoteAddr: settings.remoteAddr ?? null,
    remoteList: settings.remoteList,
    registerLabel: registerTrayLabel(registerCli.cached()),
  }
}

function refreshTray(): void {
  if (tray === null) return
  tray.setState(trayState())
  // 顺带把「有哪些版本可下载」拿回来（有缓存/正在拉就跳过，不阻塞窗口操作）
  ensureCatalog()
  // 注册状态同理：TTL 内直接用缓存，绝不在菜单构建里同步 spawn 登录 shell
  void registerCli.refresh().then(() => {
    if (tray !== null) tray.setState(trayState())
  })
}

/**
 * #80：THICKFRAME 无边框窗在「最大化→最小化→恢复」往返可能被系统按隐形缩放边框
 * 外扩落位（顶部越出屏幕）。只读自检：仍处最大化但帧相对所在显示器工作区外扩超
 * 容差 → 判定落位损坏 → 纯原生 unmaximize()+maximize() 重摆（零自算坐标，落位由
 * Windows 重算，与首次最大化同一条已验证路径）。Win+方向键半屏贴靠 IsZoomed=false
 * 天然不触发。触发面：focus + resize（去抖）+ focus 后延迟复查——实机证明落位
 * 外扩在恢复动画完成后才定格，focus 当拍检查经常早于损坏成形；resize 则在最终
 * 摆位后必到。每次判定都落日志（含 workArea 取不取得到），实机排查有据可查。
 * 三轮重开（双屏 2K 越屏依旧）定位：前两轮的损坏判定错用了状态推导的
 * deriveMaximized(frame, workArea, true)——旗标为真它恒真，判定永远「落位正常」，
 * 自愈从未触发（4K 屏系统不走外扩补偿，死代码因此在前两轮实机验证中没现形）。
 * 改用专用损坏判定 isMaximizedPlacementDamaged（容差 4px：THICKFRAME 边框 96DPI
 * 就有 8px/边，8px 容差会把恰好 8px 的外扩当正常吃掉），并加同段最大化期重摆
 * 上限（HEAL_MAX_REPLACES）防「重摆→resize→再检查」循环闪窗。
 */
const healCheckTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** 延迟复查的登记版计时器：可被重摆取消顺延（裸 setTimeout 不受管，会在重摆动画
 *  中途开火——实机「恢复时抖几下」的来源）。 */
const healRecheckTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** 同段最大化期已原生重摆次数（healVerdict 的计数存储）。只在最大化期结束（旗标
 * 落下）或窗口销毁时清零；判定 clean 不重置——若 damaged↔clean 交替刷新预算，
 * 上限就挡不住「重摆→动画中途量到好帧→再损坏」的循环。 */
const healReplaces = new Map<string, number>()
/** 去抖窗口：resize 连发期间只做最后一次检查，重摆引发的 resize 不叠加。 */
const HEAL_DEBOUNCE_MS = 250
/** 延迟复查间隔：给恢复/重摆动画留出定格时间。 */
const HEAL_RECHECK_DELAY_MS = 350

function healMaximizedPlacement(win: BrowserWindow, profile: string, reason: string): void {
  if (process.platform !== 'win32') return
  if (!win.isMaximized()) {
    healReplaces.delete(profile) // 旗标落下 = 一段最大化期结束，重摆计数清零
    return
  }
  const frame = win.getFrame()
  const workArea = getWorkAreaForFrame(frame)
  if (workArea === null) {
    shellLogLine(`[shell] #80 heal 检查（${reason}）：workArea 取不到（ffi 失败？），跳过`)
    return
  }
  const verdict = healVerdict(isMaximizedPlacementDamaged(frame, workArea), healReplaces.get(profile) ?? 0)
  if (verdict === 'clean') {
    shellLogLine(`[shell] #80 heal 检查（${reason}）：落位正常，不干预 frame=${JSON.stringify(frame)} workArea=${JSON.stringify(workArea)}`)
    return
  }
  if (verdict === 'exhausted') {
    shellLogLine(`[shell] #80 heal 检查（${reason}）：已重摆 ${HEAL_MAX_REPLACES} 次仍外扩，停止防循环 frame=${JSON.stringify(frame)} workArea=${JSON.stringify(workArea)}（重摆也落不好，日志留给上游 WM_NCCALCSIZE 根治）`)
    return
  }
  healReplaces.set(profile, (healReplaces.get(profile) ?? 0) + 1)
  shellLogLine(
    `[shell] #80 heal 检查（${reason}）：落位外扩 frame=${JSON.stringify(frame)} workArea=${JSON.stringify(workArea)}，原生重摆（第 ${healReplaces.get(profile)} 次）`,
  )
  win.unmaximize()
  win.maximize()
  // 重摆会引发 resize 与动画：作废在途的去抖检查与延迟复查，重摆落定后重排一次
  // 复查——后续判定全部锚在最近一次摆位动作之后，不在动画中途开火（实机抖动修复）。
  const pendingDebounce = healCheckTimers.get(profile)
  if (pendingDebounce !== undefined) {
    clearTimeout(pendingDebounce)
    healCheckTimers.delete(profile)
  }
  scheduleHealRecheck(win, profile, '重摆后复查')
}

/** resize/focus 入口的去抖包装：同窗连发只留最后一次。 */
function scheduleHealCheck(win: BrowserWindow, profile: string, reason: string): void {
  if (process.platform !== 'win32') return
  const previous = healCheckTimers.get(profile)
  if (previous !== undefined) clearTimeout(previous)
  healCheckTimers.set(profile, setTimeout(() => {
    healCheckTimers.delete(profile)
    healMaximizedPlacement(win, profile, reason)
  }, HEAL_DEBOUNCE_MS))
}

/** 延迟复查的登记版：重摆时会被取消顺延，复查永远落在最近一次摆位动作之后。 */
function scheduleHealRecheck(win: BrowserWindow, profile: string, reason: string): void {
  if (process.platform !== 'win32') return
  const previous = healRecheckTimers.get(profile)
  if (previous !== undefined) clearTimeout(previous)
  healRecheckTimers.set(profile, setTimeout(() => {
    healRecheckTimers.delete(profile)
    healMaximizedPlacement(win, profile, reason)
  }, HEAL_RECHECK_DELAY_MS))
}

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
  refreshTray()
}

// ---- 多窗口：每 profile 一份服务面 + 一个窗口（旧壳 `ui/multiwin.rs` 的等价物）----

/** 当前那个窗口：最近聚焦的；没焦点记录就回主窗。 */
function focusedWindow(): BrowserWindow | null {
  if (focusedProfile !== null) {
    const hit = windows.get(focusedProfile)
    if (hit !== undefined) return hit.window
  }
  return mainWindow
}

/**
 * 焦点窗的最大化态（#112 壳层标题栏带）：判定收口在 window-max.ts 的 windowMaxState
 * （与 RPC window_get_state 同源）。无焦点窗时回 false（无窗场景图标无意义）。
 */
function focusedWindowState(): WindowMaxState {
  const win = focusedWindow()
  if (win === null) return { maximized: false }
  return windowMaxState(win)
}

/** 起/profile 复用一份服务面：每份服务面 = 一个 dsh 宿主 + 一个 loopback origin。 */
async function ensureService(profile: string): Promise<ShellService> {
  const existing = services.get(profile)
  if (existing !== undefined) return existing
  console.log(`[shell] 起服务面：profile = ${profile}`)
  const started = await startService(serviceOptionsFor(profile))
  services.set(profile, started)
  return started
}

/** 服务面选项：除了 profile 与状态文件，其余回调全是壳侧共用的那几个。 */
function serviceOptionsFor(profile: string): ServiceOptions {
  const home = dshHome()
  return {
    profile,
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
      console.log(`[shell] 右键菜单：${items.map((item) => item.label ?? item.role ?? item.type ?? '?').join(' | ')}`)
      ContextMenu.showContextMenu(items as unknown[])
    },
    onStage: (stage) => {
      lastStage = stage
      console.log(`[shell] 启动阶段：${stageLabel(stage)}（${String(stagePercent(stage))}%）`)
      pushStage()
    },
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
        toggleWindowMaximize(win)
      } else {
        // #50 验证反馈：兑底端点的关窗也走统一策略（要拿到 profile 才能判主/副窗）
        const focusedEntry = [...windows.values()].find((entry) => entry.window === win)
        if (focusedEntry === undefined) {
          win.close()
          return
        }
        const closePolicyAction = performClosePolicy(win, focusedEntry.profile)
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
      windows.get(profile)?.window.close()
    },
    // 启动确认选了别的 profile：#82 的旧行为是「用它重启」；新壳每 profile 一份服务面，所以是开它那份窗口
    onOpenProfileWindow: async (target) => {
      if (target === profile) return
      await openProfileWindow(target)
    },
  }
}

function originOf(profile: string): string {
  return services.get(profile)?.state.origin ?? ''
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
  const hit = windows.get(profile)
  if (hit === undefined || !hit.ready) return
  hit.window.webview?.loadURL(url)
}

/** 建一个 profile 窗口并接上壳侧语义（关窗、聚焦、几何）；DOM 事件与旧单窗实现同一套。 */
async function createProfileWindow(profile: string, svc: ShellService): Promise<BrowserWindow> {
  const isBoot = profile === instanceProfile
  const index = windows.size
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
  const shellRpcHandle = await attachShellRpc({ router: () => svc.rpcRouter(), grant, window: rpcWindow })
  win = new BrowserWindow({
    // D1：原生层同步评估的导航守卫——白名单页面 origin，其余导航被拦（外链交给 open_external）
    navigationRules: navRulesFor({ origin: svc.state.origin }),
    title: isBoot ? APP_NAME : `${APP_NAME} · ${profile}`,
    url: svc.state.pageUrl,
    renderer,
    preload: bootPreloadScript(locale, platform, svc.state.origin, grant.token),
    rpc: shellRpcHandle.rpc,
    // hidden = 纯无边框方框（实机报的「方形无边框」）。mac 两态都以 hiddenInset 出红绿灯。
    titleBarStyle: 'hiddenInset',
    frame,
  })
  // D3 反馈：上次是最大化收场的，这次直接最大化（几何记忆只当还原帧用）。
  // Windows 实测：从未显示过的窗上 maximize() 不落 WS_MAXIMIZE 旗标（#73）。
  // 收敛口径（收 hack 轮）：建窗时尽力而为，唯一断言点=首次 focus（届时必然可见）；
  // dom-ready 二次补齐与定时补推两层已删——竞态由「focus 断言 + 客户端首查/onMessage」闭环。
  const startMaximized = readWindowMaximized(windowStateFileOf(profile))
  if (startMaximized) {
    ensureNativeMaximizeStyles()
    win.maximize()
    pendingStartMaximized.add(profile)
  }
  windows.set(profile, { profile, window: win, ready: false })
  focusedProfile = profile
  if (isBoot) mainWindow = win
  console.log(`[shell] 建窗：${windowKey(profile)}（${svc.state.pageUrl}）`)
  win.on('dom-ready', () => {
    const hit = windows.get(profile)
    if (hit !== undefined) hit.ready = true
    if (isBoot) {
      // 主窗已出画面：拆掉启动界面（页面自己也等 __DSH_BOOT_READY__，这里只负责别让两个窗口并存）
      try {
        splash?.close()
      } catch {}
      splash = null
      mainWindowReady = true
    }
    windowVisible = true
    // 启动最大化不在 dom-ready 补齐/补推（收 hack 轮已删）：旗标由建窗时或首次 focus
    // 断言立起；客户端首查晚于两者则直接查到真值，早于则收 window_state_changed 再查。
    refreshTray()
  })
  win.on('focus', () => {
    focusedProfile = profile
    // lane 稳定接入点跟随焦点（旧壳 forwarder.rs：新连接落焦点实例，存量不动）。
    // #73：启动恢复最大化断言（唯一断言点）——Windows 上从未显示的窗 maximize 可能不落
    // 旗标（建窗时试过不稳），首次获得焦点时窗口必然已可见，再补一次并推送图标重查；
    // 断言成功即清 pending，之后不再干预。
    if (pendingStartMaximized.has(profile)) {
      if (!win.isMaximized()) {
        ensureNativeMaximizeStyles()
        win.maximize()
      }
      if (win.isMaximized()) {
        // 旗标已立也要推：客户端首查可能发生在旗标立起之前（实机「偶发才对」的竞态源）
        pendingStartMaximized.delete(profile)
        shellRpcHandle.notifyWindowState()
      }
    }
    // #80 自检排在启动补 maximize 之后：去抖 250ms/复查 350ms 都落在补推完成后，
    // 不会量到启动最大化动画中途的还原帧（与 #73 收敛方向一致）。
    scheduleHealCheck(win, profile, 'focus')
    // 实机证据：落位外扩在恢复动画完成后才定格，focus 当拍检查常早于损坏成形，
    // 延迟复查一次兜住。
    scheduleHealRecheck(win, profile, 'focus+350ms')
    // 转发器挂在先起的那份服务面上，这里找到它再指目标。
    focusedLaneForwarder()?.setTarget(services.get(profile)?.state.lanePort ?? 0)
    refreshTray()
  })
  // 关窗策略三处共用 performClosePolicy；原生层会先问 `will-close`，回 response.allow=false 就不关（旧 Tauri 壳同行为）
  win.on('will-close', (event) => {
    if (quitting) return
    // F8：「退出（停止实例）」主动销毁窗口时不拦截（stoppingProfiles 由 stopProfileFromTray 置位）
    if (stoppingProfiles.has(profile)) return
    const action = performClosePolicy(win, profile)
    if (action === 'hidden') {
      ;(event as { response?: unknown }).response = { allow: false }
      console.log(`[shell] 关窗回托盘（${profile} 窗口隐藏，进程继续）`)
      return
    }
    if (action === 'quit') {
      console.log('[shell] 关窗（无托盘）：直接退出')
      void shutdown()
      return
    }
    console.log(`[shell] 关窗（${profile}）：只销毁窗口，实例继续跑`)
  })
  win.on('close', () => {
    // 真销毁前把挂起的几何写盘（去抖定时器等不到了），最大化态一并记住
    const pending = frameSaveTimers.get(profile)
    if (pending !== undefined) {
      clearTimeout(pending)
      frameSaveTimers.delete(profile)
      try {
        saveFrameNow(win, profile)
      } catch {}
    }
    windows.delete(profile)
    // #80：heal 的挂起去抖/延迟复查定时器与重摆计数随窗口回收（迟到的定时器不再摸已销毁的窗）
    const healTimer = healCheckTimers.get(profile)
    if (healTimer !== undefined) clearTimeout(healTimer)
    healCheckTimers.delete(profile)
    const healRecheck = healRecheckTimers.get(profile)
    if (healRecheck !== undefined) clearTimeout(healRecheck)
    healRecheckTimers.delete(profile)
    healReplaces.delete(profile)
    // 窗口没了就撤销它的视图 token（旧壳的 capability 是静态文件，这里跟着窗口走）
    views.revokeLabel(windowKey(profile))
    // 窗口里的 guest 子 webview 跟着窗口一起回收（否则会留在窗口之外无法关闭）
    const released = guests.releaseHost(windowKey(profile))
    if (released > 0) console.log(`[shell] 随窗口回收 guest：${released} 个（${profile}）`)
    if (focusedProfile === profile) {
      focusedProfile = null
      focusedLaneForwarder()?.setTarget(0)
    }
    refreshTray()
  })
  // D3：每窗各自记几何（windowStateFileOf 按 profile 分文件；scheduleFrameSave 带目标文件）
  // #80：resize 也纳入 heal 触发面——任务栏恢复的落位外扩在最终摆位后才定格，
  // resize 必到且晚于损坏成形；与 focus 去抖共用一套计时器。
  win.on('resize', () => scheduleHealCheck(win, profile, 'resize'))
  win.on('resize', () => scheduleFrameSave(win, profile))
  win.on('move', () => scheduleFrameSave(win, profile))
  return win
}

/** 托盘「PROFILE 窗口」：已开就聚焦，没开就起一份服务面再开窗（旧壳 open_profile_window）。 */
async function openProfileWindow(profile: string): Promise<void> {
  const existing = windows.get(profile)
  if (existing !== undefined && planWindowOpen(profile, [...windows.keys()]) === 'focus') {
    existing.window.unminimize()
    existing.window.show()
    existing.window.activate()
    focusedProfile = profile
    refreshTray()
    return
  }
  console.log(`[shell] 打开 profile 窗口：${profile}`)
  try {
    const svc = await ensureService(profile)
    await createProfileWindow(profile, svc)
    refreshTray()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[shell] 打开 profile 窗口失败（${profile}）：${message}`)
    notifier.notify(SCENARIO.INSTANCE_LIFECYCLE, `打开 ${profile} 窗口失败：${message}`)
  }
}

let restartingShell = false

/**
 * #60 + #79：全壳统一的「重启 dsh 服务」入口——面板按钮、托盘重启、托盘切运行时都走这一条。
 * 语义（维护者拍板）：DSH 侧等效「退出应用再启动」——宿主+伴生进程树整树灭确认后全新拉起；
 * 桌面壳本体（托盘/进程）不退出。有窗口时：关窗 → 重启界面（复用冷启动 splash 通道，
 * onStage 阶段照推）→ 服务面就绪后原样重开重启前开着的窗口；无窗口模式保持纯服务面重启。
 */
async function restartDsh(): Promise<void> {
  if (restartingShell || quitting) return
  restartingShell = true
  try {
    const restartProfiles = [...services.keys()]
    const serviceCount = restartProfiles.length
    // #79：重启前开着的窗口就绪后原样重开；没开的不趁机弹窗（关窗回托盘的语义）
    const reopenProfiles = [...windows.keys()]
    const showSplash = !noWindow && reopenProfiles.length > 0
    console.log(`[shell] 完整重启：DSH 树级重启 ${String(serviceCount)} 份服务面（壳与托盘保持不动）`)
    // ---- 阶段〇：关窗 → 重启界面（splash 复用冷启动通道：onStage/pushStage 写同一组模块变量）----
    if (showSplash) {
      splash = new BrowserWindow({
        title: APP_NAME,
        html: splashHtml(),
        renderer,
        titleBarStyle: 'hiddenInset',
        frame: { width: SPLASH_WIDTH, height: SPLASH_HEIGHT },
      })
      // 冷启动的 splash 早已收掉（主窗 dom-ready 收尾）；这里重新立一面。dom-ready 前不能推 JS
      //（原生层 FATAL，见启动段注释），先记阶段，dom-ready 后补推。
      splashReady = false
      lastStage = 'instance'
      splash.on('dom-ready', () => {
        splashReady = true
        pushStage()
      })
      for (const profile of reopenProfiles) {
        // 关窗绕过关窗策略（回托盘/退进程的判断是给用户手关用的；重启关窗是壳自己的动作）
        stoppingProfiles.add(profile)
        windows.get(profile)?.window.close()
      }
      // close 事件异步落账（windows Map 清理在 close 回调里），等一拍再动服务面
      await Bun.sleep(100)
      for (const profile of reopenProfiles) stoppingProfiles.delete(profile)
      windowVisible = false
    }
    // ---- 阶段一：树级停止（host.stop 树级契约：伴生进程随宿主退场，树灭确认后才返回）----
    await Promise.all(
      restartProfiles.map(async (profile) => {
        const svc = services.get(profile)
        if (svc === undefined) return
        try {
          await svc.stop()
        } catch (error) {
          console.error(`[shell] 完整重启：停止服务面失败（${profile}）：${String(error)}`)
        }
        services.delete(profile)
      }),
    )
    // ---- 阶段二：全新服务面（新宿主、新 token）；重启前开着的窗口原样重开 ----
    for (const profile of restartProfiles) {
      const fresh = await ensureService(profile).catch(() => null)
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
        // 启动 profile 的服务面引用要换新（uiService/托盘/实例锁都以它为事实源）
        service = fresh
        updateInstance(instanceFile, process.pid, { origin: fresh.state.origin, pageUrl: fresh.state.pageUrl })
      }
      if (reopenProfiles.includes(profile)) {
        // 重开（createProfileWindow：几何记忆/关窗策略/RPC 全套语义重新接上；
        // 启动 profile 的窗口 dom-ready 会收掉重启界面并回填 mainWindowReady）
        try {
          await createProfileWindow(profile, fresh)
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
      } catch {}
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
 * #119 整应用重启（B）：先拉起新实例，**再**退自己。
 *
 * 顺序不能反：先退就没人执行 spawn；先退到一半再拉也不行（壳正在释放端口，新实例会抢到一半的世界）。
 * 新实例知道自己是被拉起来的（DSH_SHELL_RELAUNCH_PID），会等本进程真退干净再抢实例锁（app-restart.ts）。
 * 拉不起来（dev 构建 / 探测不到 launcher）**不退出、不假报成功**，把原因原样回给页面。
 */
async function restartDesktopApp(): Promise<{ ok: boolean; reason?: string; message?: string }> {
  const warning = await recheckDevToolsPort().catch(() => null)
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
  if (warning !== null) {
    console.error(`[shell] 重启桌面应用：${warning}`)
    notifier.notify(SCENARIO.STARTUP_ERROR, '开发者工具：重启后口仍开不了', warning)
  }
  await shutdown()
  return { ok: true }
}

/** 托盘「重启 dsh 服务」：完整重启语义（#60）——等效退出应用再启动，伴生进程不跨重启残留。 */
async function restartServiceFromTray(): Promise<void> {
  console.log('[shell] 托盘：重启 dsh 服务')
  try {
    await restartDsh()
  } catch (error) {
    console.error(`[shell] 重启 dsh 服务失败：${String(error)}`)
  }
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
  } catch (error) {
    // 拉不起来不是死局：托盘还在，状态行会显示原因，用户可以再换一版再试。
    console.error(`[shell] 切换运行时后仍未起来：${String(error)}`)
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
    notifier.notify(SCENARIO.STARTUP_ERROR, `下载运行时 ${version} 失败`)
    refreshTray()
    return
  }
  console.log(`[shell] 运行时 ${version} 装好了，切过去`)
  // 装完的版本要从「↓ 下载并切换」那一栏挪进「已装」：缓存作废，重新拉一份
  catalogCache = null
  await switchRuntimeFromTray({ kind: 'switch-runtime', version })
}

function onTrayAction(action: TrayAction): void {
  switch (action.kind) {
    case 'toggle-window':
      if (windowVisible) hideMainWindow()
      else showMainWindow()
      return
    case 'quit':
      console.log('[shell] 托盘：退出')
      void shutdown()
      return
    case 'restart-service':
      void restartServiceFromTray()
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
    case 'register-cli':
      void registerDshCliFromTray()
      return
    case 'remote-source': {
      // 「dsh 服务地址」（旧壳 #136）：本地/远程同层单选；选完立即按目标重启 dsh。
      // 远程不可用（token 失效 401）时也能从这里一键切回本地。
      const svc = uiService()
      const current = svc.settings()
      const target = action.addrIndex === undefined ? '' : current.remoteList[action.addrIndex] ?? ''
      if ((current.remoteAddr ?? '') === target) return
      svc.save({ remote_addr: target })
      void svc
        .restartHost()
        .then(() => refreshTray())
        .catch((error) => console.error(`[shell] 切换 dsh 服务地址失败：${String(error)}`))
      return
    }
    case 'stop-profile':
      if (action.profile !== undefined) void stopProfileFromTray(action.profile)
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
  const svc = services.get(profile)
  if (svc === undefined) {
    console.log(`[shell] 退出实例：${profile} 没有在跑的服务面，忽略`)
    return
  }
  console.log(`[shell] 退出实例：停止 ${profile} 的 dsh 与服务面`)
  stoppingProfiles.add(profile)
  try {
    windows.get(profile)?.window.close()
    await svc.stop()
  } finally {
    stoppingProfiles.delete(profile)
    void refreshTray()
  }
}

/** F9：托盘「新建 / 迁移 Profile…」——弹一张小表单窗，提交给服务面的 /profile-op */
function openProfileOpDialog(kind: ProfileOpDialogKind): void {
  const dialog = new BrowserWindow({
    title: kind === 'create' ? '新建 Profile' : '迁移 Profile',
    html: profileDialogHtml(kind, listProfiles(dshHome(), instanceProfile)),
    renderer,
    titleBarStyle: 'hiddenInset',
    frame: { width: 460, height: kind === 'create' ? 240 : 330 },
  })
  dialog.on('closed', () => void refreshTray())
}
/** F12：页面内确认弹窗（旧壳 register/confirm_modal 的等价物）：注入 JS，等 POST 回填，180s 超时。 */
let pendingInput: { flow: string; resolve: (value: string) => void } | null = null
const INPUT_CONFIRM_TIMEOUT_MS = 180_000

async function confirmModal(flow: string, title: string, body: string): Promise<boolean> {
  const win = focusedWindow() ?? mainWindow
  if (win === null || !mainWindowReady) {
    console.log('[input] 主窗口不可用，确认弹窗直接按取消处理')
    return false
  }
  const promise = new Promise<string>((resolve) => {
    pendingInput = { flow, resolve }
  })
  showMainWindow()
  try {
    win.webview?.executeJavascript(confirmModalScript({ flow, title, body }))
  } catch (error) {
    console.log(`[input] 确认弹窗注入失败：${String(error)}`)
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
    console.log(`[register] 通知投递失败：${error instanceof Error ? error.message : String(error)}`)
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
// #119 接班等待：本实例是被上一个实例拉起来的话，先等它真退干净再抢锁。
// 不等的话会撞上「旧 pid 还活着」→ 判定已有实例 → 激活它后自己退出 → 净结果什么都没起来。
const relaunchParent = relaunchParentPid(process.env)
if (relaunchParent !== null) {
  console.log(`[shell] 重启接班：等待上一个实例（pid ${String(relaunchParent)}）退出`)
  const gone = await awaitParentExit({ pid: relaunchParent, isAlive: defaultIsAlive })
  console.log(gone ? `[shell] 重启接班：上一个实例已退出` : `[shell] 重启接班：等待超时（${String(relaunchParent)} 仍在），照常启动`)
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
  } catch {}
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
  // 无窗口模式（CI/黑盒）不建托盘——那里没有窗口可隐藏，托盘只会碍事
  if (noWindow) return
  const image = trayImagePath()
  if (image === null) {
    console.warn('[shell] 找不到托盘图标（resources/tray.png / runtime/tray.png），本次不建托盘')
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
      log: (line) => console.log(line),
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
    console.log('[shell] Dock 再激活：显示主窗')
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
    html: splashHtml(),
    renderer,
    titleBarStyle: 'hiddenInset',
    frame: { width: SPLASH_WIDTH, height: SPLASH_HEIGHT },
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
  log: (message) => console.log(message),
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
const notifyBridge = createNativeNotify({ log: (line) => console.log(line) })
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
  isFullscreen: () => mainWindow?.isFullScreen() ?? false,
  onLog: (line) => console.log(line),
})
let service: ShellService
/** 找到持有 lane 转发器的那份服务面（多实例下只有先起的那份非 null）。 */
const focusedLaneForwarder = (): LaneForwarder | null => {
  for (const svc of services.values()) {
    if (svc.laneForwarder !== null) return svc.laneForwarder
  }
  return null
}
try {
  service = await ensureService(instanceProfile)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[shell] 启动失败：${message}`)
  notifier.notify(SCENARIO.STARTUP_ERROR, `桌面壳启动失败：${message}`)
  // #117：能走到这里的是**壳自己**立不起服务面（设置文件写不进、端口听不了、HTTP 面起不来），
  // 而不是 DSH 起不来——而托盘的状态来自服务面，托盘/启动界面都还没有自救入口可言。
  // 这种就如实抛出去（dev 直接崩、CI 判红），不再「在屏幕上留 30 秒然后自己退掉」。
  throw error
}
// ---- #117 冷启动编排：服务面 → 托盘 → 启动界面 → DSH → 桌面窗口 ----
startupTray()
splash = startupSplash()

// DSH。就这一步失败也**不退出**：托盘已经在了，状态行摆着原因，
// 用户能换一个运行时版本再试，也能从托盘退出（旧行为是报错→30 秒→自己退掉，等于把自救入口没收走）。
let dshStarted = true
try {
  await service.ensureRunning()
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
    } catch {}
  }
}
if (dshStarted) {
  console.log(`SHELL-READY ${JSON.stringify({ ...service.state, locale })}`)
  // 服务面就绪：把 origin/页面 URL 回填给实例锁，第二个壳才能激活这个窗口
  updateInstance(instanceFile, process.pid, { origin: service.state.origin, pageUrl: service.state.pageUrl })
  // P2 测试钩子（旧壳 lib.rs:744 _AUTO_QUIT）：服务面就绪后延迟自动退出，给 CI/探针一个干净的结束信号
  if ((process.env.DSH_DESKTOP_AUTO_QUIT ?? '') !== '') {
    const delayMs = Number(process.env.DSH_DESKTOP_AUTO_QUIT) > 0 ? Number(process.env.DSH_DESKTOP_AUTO_QUIT) : 3_000
    setTimeout(() => {
      console.log('[shell] DSH_DESKTOP_AUTO_QUIT 触发自动退出')
      void shutdown()
    }, delayMs).unref?.()
  }
}

// #117：DSH 没起来就不建桌面窗口（页面要的是 DSH），但**启动界面留着、托盘留着**——
// 这正是这张单要的死局出口。
let startupBlocked = false
if (!noWindow) {
  // 端口被陌生程序占着（service.state.blocked）或 DSH 根本没起来，都不进桌面窗口。
  if (service.state.status !== 'running') {
    // #117：失败原因已经在 ensureRunning 的 catch 里推过启动界面了，这里不重复推。
    startupBlocked = true
  }
  // 标题栏形态与旧壳对齐：macOS 保留原生红绿灯并叠在内容上（旧壳 TitleBarStyle::Overlay），
  // Windows/Linux 隐藏原生标题栏，caption 行与窗口按钮由插件 client 自绘（旧壳 decorations:false）。
  if (!startupBlocked) await createProfileWindow(instanceProfile, service)
  // 右键菜单里我们自己那几项（原生 role 由系统处理，不会回到这里）；
  // 多窗口下作用在「最近聚焦」那个窗口上。
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
    // 菜单：打开当前聚焦窗口的 DevTools——CEF 走 openDevTools（应用内 inspector）；
    // win 走合成 F12（#106 返工：上游 WebView2 壳无 openDevTools 实现，物理 F12 由 WebView2 默认能力响应）。
    if (action === SHELL_MENU_ACTIONS.openDevTools) {
      if (process.platform === 'win32') {
        if (sendDevToolsKeystroke()) {
          console.log('[shell] 开发者工具：已发送 F12 键击（WebView2 原生响应，与物理按键同路径）')
        } else {
          console.error('[shell] 开发者工具：user32 键击不可用，请直接按 F12 / Ctrl+Shift+I')
        }
      } else {
        focusedWindow()?.webview?.openDevTools()
      }
      return
    }
    const url = detail?.data?.url
    if (action === SHELL_MENU_ACTIONS.reload) {
      focusedWindow()?.webview?.loadURL(uiService().state.pageUrl)
      return
    }
    if (action === SHELL_MENU_ACTIONS.openExternal && url !== undefined) {
      if (!Utils.openExternal(url)) console.warn(`[shell] 系统浏览器没接住外链：${url}`)
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
const shutdown = async (): Promise<void> => {
  if (stopping) return
  stopping = true
  quitting = true
  // 托盘先摘：否则退出过程中它还会响菜单（点了就是另一个 shutdown）
  tray?.destroy()
  tray = null
  // 挂起的几何定时器不丢：退出前把各窗当前态同步落盘（上次只 clear，最后 400ms 内的变动全丢）
  for (const [timerProfile, timer] of frameSaveTimers) {
    clearTimeout(timer)
    frameSaveTimers.delete(timerProfile)
    const win = windows.get(timerProfile)?.window
    if (win === undefined) continue
    try {
      saveFrameNow(win, timerProfile)
    } catch {}
  }
  try {
    // 先摘服务面与宿主（SIGTERM → 宽限期 → SIGKILL，并等它真退出）再让框架退出；
    // 不能像以前那样发完信号就走——壳一退，宿主就被 launchd 收养，变成占着会话的孤儿。
    const stops = [...services.values()].map(async (svc) => {
      try {
        await svc.stop()
      } catch (error) {
        console.error(`[shell] 停止服务面失败（${svc.paths.profile}）：${String(error)}`)
      }
    })
    await Promise.race([Promise.all(stops), Bun.sleep(SHELL_STOP_DEADLINE_MS)])
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
      for (const svc of services.values()) {
        void svc.stop()
      }
    } catch {}
  }
})
