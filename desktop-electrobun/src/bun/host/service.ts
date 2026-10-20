// 壳的「服务面」：运行时就位 → 认领端口 → 起宿主 → 取 cookie → 起 loopback 服务。
//
// 这一层**不 import electrobun**，所以缝 ① 的黑盒测试与「无窗口启动契约」可以直接用
// 普通 bun 跑（无显示器、无 CEF 的 CI 也能跑），窗口是 index.ts 的事。

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { reconcileProfileRuntimeTree } from '../profiles/profile-tree.ts'
import { scaffoldProfile } from '../profiles/profile-scaffold.ts'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { choosePort, claimFor, parseClaims, pruneClaims, releaseClaim, upsertClaim } from '../../shared/net/ports.ts'
import { decideClaim } from '../../shared/net/port-claim.ts'
import { startLaneForwarder, type LaneForwarder } from '../net/lane-forwarder.ts'
import { portOpen, stopPortOwner } from '../net/port-owner.ts'
import { readLoginShellEnvironment, resolveLoginShellTimeoutMs } from '../platform/login-shell-env.ts'
import { normalizeRemoteUrl } from '../../shared/net/remote.ts'
import { createAccountWatcher } from './account-watcher.ts'
import type { ShellStage } from '../platform/stages.ts'
import { dshHome, layout, resolveBuiltinRuntimeDir, type ShellLayout } from '../runtime/runtime.ts'
import { startShellServer, type BootPayload, type ShellServer, type ShellServerOptions } from '../net/shell-server.ts'
import type { UpdateNoticeOp, UpdateNoticePayload } from '../windows/update-notice-dialog.ts'
import type { UpdateNoticeTarget } from '../../shared/notify/update-notice-policy.ts'
import { evaluateRuntimeUpdates, remoteRuntimeCandidates, DEFAULT_CATALOG_SOURCE } from '../../shared/runtime/runtime-update.ts'
import { installableVersions, runtimeInstallability } from '../../shared/runtime/runtime-installability.ts'
import { createUpdateNoticeStore } from '../commands/update-notice-store.ts'
import { readShellTheme } from '../platform/theme-source.ts'
import { runUpdateNoticeCheck, type UpdateNoticeCheckResult } from '../commands/update-notice-check.ts'
import { createUpdateNoticeOpRunner, type UpdateNoticeOpResult } from '../commands/update-notice-ops.ts'
import type { WindowControlAction, WindowMaxState } from '../windows/window-max.ts'
import { readHostRecords, sweepStaleHosts } from './host-registry.ts'
import { createHostSupervisor, type HostLifecycleStatus, type HostSnapshot } from './host-supervisor.ts'
import type { ContextMenuRequest } from '../windows/context-menu.ts'
import { loadSettings } from '../platform/settings-store.ts'
import { isValidProfileName, isSelfMigrate } from '../windows/profile-dialog.ts'
import type { ProfileOpRequest, ProfileOpResult } from '../windows/profile-dialog.ts'
export type { ProfileOpRequest, ProfileOpResult } from '../windows/profile-dialog.ts'
import { cleanupStagedPlugins, stagePlugins } from '../profiles/plugin-staging.ts'
import { createArbiter } from '../../shared/app/power-arbiter.ts'
import { proxyEnvRecord, resolveProxyEnv } from '../../shared/net/proxy-env.ts'
import { detectSystemProxy } from '../platform/system-proxy.ts'
import type { ProxyEnv } from '../../shared/net/proxy-env.ts'
import { createKeepAwake, syncPreventSleep } from '../notify/keep-awake.ts'
import { startNotifyServer } from '../net/notify-server.ts'
import { createNotifier, importSound as importSoundFile, type Notifier } from '../notify/notifications.ts'
import { systemDefaultSoundCommand } from '../notify/sound-playback.ts'
import { createNativeNotify, type NativeNotify } from '../notify/notify-un.ts'
import type { ViewRegistry } from '../../shared/net/view-grant.ts'
import type { GuestCommands } from '../windows/guest-manager.ts'
import { createUpdater, type ShellUpdater } from '../platform/updater.ts'
import { permissionHint, permissionLabel } from '../../shared/notify/notify-permission.ts'
import { NOTIFY_TYPE_SCENARIOS, SCENARIO } from '../../shared/notify/notify-policy.ts'
import { resolveBundleIdentifier } from '../../shared/app/app-identity.ts'
import { DEFAULT_LOOPBACK_AGGREGATION, activeProfile, changedPortKeys, profileLanePort, profilePort, settingsSummary, type DesktopSettings } from '../../shared/settings/settings.ts'
import { createCommandTable, type RuntimeSnapshot } from '../commands/commands.ts'
import { createRpcRouter, dispatchRpc, type RpcRouter } from '../commands/rpc.ts'
import { updateSettings } from '../platform/settings-store.ts'
import type { RuntimeDownloadStatus } from '../runtime/runtime-install.ts'
import { listProfiles } from '../profiles/profiles.ts'
import { createDownloadManager } from '../commands/downloads.ts'
import { createLogSink, describeLogFile } from '../platform/log-sink.ts'
import { buildDiagnostics, DIAG_TAIL_LINES, type DiagnosticsInput } from '../../shared/app/diagnostics.ts'
import { exportDiagnostics } from '../commands/diagnostics.ts'
import { classifyLevel, mirrorToShellLog, pageLogLines } from '../../shared/app/log-file.ts'
import { revealPath } from '../commands/downloads.ts'
import { release as osRelease, cpus as osCpus, freemem as osFreemem, totalmem as osTotalmem } from 'node:os'
import { builtinPnpmVersion, createTaskTracker, installProfileDependencies, migrateProfile, profileDependencyRows, profileHealth, testProxyConnectivity } from '../profiles/profile-manager.ts'
import { readKeybindings, writeKeybindings } from '../platform/keybindings.ts'
import type { CatalogEntry } from '../../shared/runtime/runtime-catalog.ts'
import type { RuntimeSource } from '../../shared/settings/settings.ts'
import {
  fetchRuntimeCatalog,
  listInstalledRuntimes,
  purgeRuntimeTrash,
  purgeStagingDirs,
  readRuntimeVersion,
  recordInstalledRuntime,
  trashInstalledRuntime,
} from '../runtime/runtime-store.ts'
import { createRuntimeDownloader, ensureNodeShim, ensureShimDir, installRuntime, resolvePnpmCjs, withRuntimeDownloadNotify } from '../runtime/runtime-install.ts'


/** #117：服务面自己管 DSH 的判别位（ShellState.status 取这个联合）。 */
/** #117：服务面自己管 DSH 的判别位（ShellState.status 取这个联合；口径定义在 host-supervisor，避免反向 import 成环）。 */
export type ShellServiceStatus = HostLifecycleStatus
export interface ServiceOptions {
  /** 平台（命令表要回给页面；缺省 process.platform） */
  platform?: NodeJS.Platform
  /** 页面请求关窗（`close_current_window` / `exit_window_instance`） */
  onCloseWindow?: () => void
  clientVersion: string
  /** 这个服务面负责哪个 profile（多窗口下每 profile 一份；缺省按 DSH_PROFILE > 设置 > 默认） */
  profile?: string
  /** 覆盖 DSH_HOME 等；默认读 process.env */
  env?: Record<string, string | undefined>
  noWindow?: boolean
  /** 页面外链转系统浏览器（主进程实现；无窗口宿主可不给） */
  onOpenExternal?: (url: string) => void
  /** 打开另一个 profile 的窗口（启动确认选了别的 profile 时用；多窗口见 index.ts） */
  onOpenProfileWindow?: (profile: string) => Promise<void>
  /** F13：窗口⇄最大化切换（index.ts 操作 focusedWindow） */
  onZoomToggle?: () => void
  /** 页面右键菜单（主进程实现） */
  onContextMenu?: (request: ContextMenuRequest) => void
  /** 宿主被守护器重启成功（主进程用它把页面刷回来） */
  onHostRestart?: (state: ShellState) => void
  /** 宿主反复退出，守护器放弃（不再重启） */
  onHostGiveUp?: (state: ShellState, reason: string) => void
  /** #60：手动「重启 dsh 服务」= DSH 树级完整重启（宿主+伴生树灭后全新拉起，壳/窗口不动）；缺省回落宿主级 restartHost（无窗口/测试） */
  onFullRestart?: () => Promise<void>
  /** #119：整应用退出 + 自动重启（B）。拉不起时带原因回传（dev 态显式降级），不抛给页面。 */
  onRestartApp?: () => Promise<{ ok: boolean; reason?: string; message?: string }>
  /** F9：托盘弹框的 profile 新建/迁移落地后（create → 开窗，migrate → 刷新托盘） */
  onProfileOpApplied?: (op: 'create' | 'migrate', profile: string) => void
  /** #142：提醒卡的「不再提示」拉黑版本号（壳主进程持有 update-notice.json；没接上时如实报不可用） */
  /** #142：启动检查的提醒窗由壳主进程开；没接上就一路不弹（只进日志） */
  onOpenUpdateNotice?: (payload: UpdateNoticePayload) => boolean | Promise<boolean>
  /** #142：提醒卡的「不再提示」拉黑版本号（带路：壳与运行时各算各的）；缺省写自己的 update-notice.json */
  onIgnoreVersions?: (targets: UpdateNoticeTarget[]) => void
  /** F12：页面内确认弹窗的回填（壳主进程的 pending-input 单槽） */
  onInputConfirm?: (flow: string, value: string) => void
  /** 启动阶段变化（启动界面据此报进度；无窗口模式也会调） */
  onStage?: (stage: ShellStage) => void
  /** 第二个实例请求把窗口带到前台（单实例激活） */
  onActivate?: () => void
  /** 自绘窗口控制（A5）：页面三键 → 主进程操作 BrowserWindow */
  onWindowControl?: (action: WindowControlAction) => void
  /** 该 profile 的窗口是否在前台聚焦（#115：聚焦 → 通知整条不投递；无窗口/测试可不给） */
  isWindowFocused?: (profile: string) => boolean
  /** 最大化态读取（#112 壳层标题栏带）：GET /__shell__/window 回 { maximized }；缺省时 GET 仍 405 */
  onWindowState?: () => WindowMaxState
  onLog?: (line: string) => void
  /** 通知权限桥（index.ts 注入同一个实例；缺省自建） */
  notifyBridge?: NativeNotify
  /** 应用更新（index.ts 可注入同一个实例；缺省自建；单测可注入假实现） */
  updater?: ShellUpdater
  settings?: DesktopSettings
  /** 通知器（index.ts 注入 Electrobun 原生通道；缺省走命令行兜底） */
  notifier?: Notifier
  /** 弹原生文件选择器选音频（index.ts 注入；缺省返回 null） */
  pickSoundFile?: () => Promise<string | null>
  /** 弹目录选择器选下载位置（index.ts 注入 Electrobun 的 openFileDialog；缺省落 ~/Downloads） */
  chooseDownloadDir?: (start: string) => Promise<string | null>
  views?: ViewRegistry
  /** 浏览器 guest 命令（guest 挂在发起调用的窗口上，所以由窗口层实现并注入） */
  guests?: GuestCommands
  /** 应用版本（诊断快照里报；index.ts 注入壳自己的版本号） */
  appVersion?: string
  /** 页面语言（诊断快照里报） */
  locale?: string
}

export interface ShellState {
  pid: number
  origin: string
  pageUrl: string
  token: string
  profile: string
  runtimeDir: string
  distDir: string
  hostPid: number
  /** dsh 上游监听端口（旧壳 `DSH_DESKTOP_PORT`，手机访问插件靠它找上游） */
  upstreamPort: number
  /** 手机访问 lane 端口（旧壳 `DSH_MOBILE_LANE_PORT`） */
  lanePort: number
  /** 通知口端口（忙状态/通知上报；0 = 未起） */
  notifyPort: number
  injections: number
  noWindow: boolean
  /** 壳设置（loadSettings 的结果，可供托盘/设置面板/防休眠等复用） */
  settings: DesktopSettings
  /** 设置文件的读取过程（首启/迁移/损坏重建） */
  settingsProvenance: { created: boolean; migrated: boolean; recovered: boolean }
  /** 启动被阻塞的原因（旧壳 ForeignUnknown：端口被陌生程序占用，只报错不代杀）；未阻塞时无此字段 */
  blocked?: string
  /**
   * #117：服务面自己管 DSH 的判别位。服务面**先于** DSH 存在：
   * stopped=壳的面全就绪但还没拉 DSH / starting=正在拉 / running=DSH 已就绪 /
   * failed=拉过但没起来（看 error）/ blocked=端口被陌生程序占着，自动拉起被拒（看 blocked）。
   */
  status: ShellServiceStatus
  /** status === 'failed' 时的原因。托盘据此显示，用户改完运行时还能再拉一次。 */
  error: string | null
}

export interface ShellService {
  state: ShellState
  paths: ShellLayout
  server: ShellServer
  /** 手机稳定接入点（遗留 lane 端口 → 本实例 lane）；多实例下只有先起的服务面持有（其余 null） */
  laneForwarder: LaneForwarder | null
  /** 停止：摘服务、SIGTERM→SIGKILL 停宿主、上台账与端口回收 */
  stop: () => Promise<void>
  /** 手动重启宿主（守护器会接住退出并把服务面切到新宿主） */
  restartHost: () => Promise<void>
  // 每份服务面只服务一个 profile：profile 由 ServiceOptions.profile 在启动时给定，
  // 切换 profile ＝ 打开那份 profile 的窗口（多窗口，见 src/bun/index.ts 的 openProfileWindow）。
  /** 当前生效设置（托盘这类壳侧调用方读它） */
  settings: () => DesktopSettings
  /** 改设置：与命令表同一条写盘路径（落盘 + 刷新状态文件） */
  save: (patch: Record<string, unknown>) => DesktopSettings
  /** 运行时快照（来源 / 内置版本 / 已装列表） */
  runtime: () => RuntimeSnapshot
  /** 拉版本目录（失败不抛，回 {entries, error}） */
  fetchCatalog: (source: RuntimeSource) => Promise<{ entries: CatalogEntry[]; error?: string }>
  /** 通知权限桥（托盘/面板共用：真实状态 + 主动申请） */
  notify: NativeNotify
  /** 下载进度（托盘与设置面板共用同一个单飞状态） */
  downloadStatus: () => RuntimeDownloadStatus
  /** 下载并安装一个运行时（单飞） */
  download: (version: string, source: RuntimeSource) => Promise<{ ok: true; version: string }>
  /** #97：取消进行中的运行时安装（托盘与面板共用；没有任务是幂等 no-op） */
  cancelRuntimeDownload: () => Promise<{ cancelled: boolean; version: string }>
  /** 新建 / 迁移 profile（F9：托盘弹框的落点；结果回给弹框展示） */
  profileOp: (request: ProfileOpRequest) => Promise<ProfileOpResult>
  /** profileOp 落地后的回调（create → 开窗，migrate → 刷新托盘）；测试可注入 */
  onProfileOpApplied: (op: 'create' | 'migrate', profile: string) => void
  /** #139：启动更新提醒卡的动作落地（壳与运行时两段，共用已有下载/切换/重启路径） */
  updateNoticeOp: (op: UpdateNoticeOp) => Promise<UpdateNoticeOpResult>
  /**
   * #141：托盘「检查更新」显式触发一次（`manual`）——绕过总开关与「已提醒过」，但拉黑仍然认。
   * 与启动那次共用同一份 store / 探针 / 提醒窗，不另长一套 UI。
   */
  checkUpdates: (trigger: 'startup' | 'manual') => Promise<UpdateNoticeCheckResult>
  /** 官方 RPC 的命令表（惰性；壳 RPC 漏斗派发用，见 rpc-bridge.ts #50） */
  rpcRouter: () => RpcRouter | null
  /**
   * #117：把 DSH 拉起来 —— 服务面**管理** DSH 的动作，不是服务面**存在**的前提。
   * startService() 不调它；调用方（index.ts 冷启动 / serve.ts 黑盒握手 / 托盘改完运行时再试一次）
   * 决定什么时候要 DSH。已经在 running / 正在拉 / blocked 时都是空操作（或复用正在拉的那次，
   * 不重复 spawn 宿主）。失败不重建服务面：落 failed 态 + 记原因 + 照旧抛给调用方——
   * 壳自己的部分（托盘/设置/切换运行时/退出）此时完全可用，这正是 #117 要的死局出口。
   */
  ensureRunning: () => Promise<void>
}

export async function startService(options: ServiceOptions): Promise<ShellService> {
  const env = options.env ?? process.env
  // #1：home 统一走 dshHome()（DSH_HOME → homedir()/.dsh）；Windows 没有 HOME，
  // 旧实现 env.HOME 兜 '.' 的写法会退化成相对路径 .dsh，shell.log/settings 全落进 bin\.dsh。
  const home = dshHome(env)
  const logFile = env.DSH_SHELL_LOG ?? join(home, 'shell.log')
  const webviewLogFile = join(home, 'dsh-desktop-webview.log')
  const stateFile = env.DSH_SHELL_STATE_FILE ?? join(home, 'shell-state.json')
  const claimsFile = env.DSH_SHELL_PORT_CLAIMS ?? join(home, 'shell-ports.json')
  mkdirSync(home, { recursive: true })

  // 壳日志：本地时区时间戳 + 有界轮转（10 MB × 5 份；旧壳 KeepAll 实测堆了 90+ 份）。
  const shellLog = createLogSink({
    file: logFile,
    // #54：批量异步刷盘——行进内存缓冲 100ms 合并落盘，不再逐行同步 I/O；退出钩子同步 flush
    bufferMs: 100,
    stdout: (line) => console.log(line),
    onRotate: ({ moved, deleted }) => console.log(`[shell] 日志轮转：搬 ${String(moved)} 份、删 ${String(deleted)} 份`),
  })
  // 页面控制台另写一份（旧壳路径 `$DSH_HOME/dsh-desktop-webview.log`，不镜像到 stdout）。
  const pageLog = createLogSink({ file: webviewLogFile, bufferMs: 100 })

  const log = (line: string): void => {
    shellLog.line(line)
    options.onLog?.(line)
  }
  /** D6：运行时回退提示先记着，notifier 建好后补发（回退发生在 notifier 创建之前） */
  let pendingRuntimeNote: string | null = null

  // ---- 设置：壳自己的一份（desktop-settings.json，旧壳的 settings.yaml 只读迁移一次）----
  const loaded = loadSettings({ home, log })
  const settings = options.settings ?? loaded.settings
  const provenance = [
    loaded.created ? '首次启动已落盘' : '',
    loaded.migrated ? '已从 settings.yaml 迁移' : '',
    loaded.recovered ? '原文件损坏，已备份重建' : '',
  ].filter((entry) => entry !== '')
  log(`设置：${settingsSummary(settings)}${provenance.length > 0 ? `（${provenance.join('；')}）` : ''}`)

  // 运行时选中：设置里的偏好版本（dsh_runtime）在这里生效；
  // 旧壳的 DSH_MODE / DSH_SHELL_RUNTIME_DIR 覆盖仍在 layout 内部处理。
  let paths = layout({
    env,
    profile: options.profile ?? activeProfile(settings, env),
    preferred: settings.dshRuntime,
  })
  options.onStage?.('layout')
  log(
    `运行时 = ${paths.runtimeDir}（${paths.runtimeKind}${paths.runtimeVersion === null ? '' : ` ${paths.runtimeVersion}`}）| dist = ${paths.distDir} | profile = ${paths.profile} | home = ${paths.home}`
  )

  if (paths.runtimeNote !== null) {
    log(`运行时回退：${paths.runtimeNote}`)
    // D6：notifier 在下面才建好，先记下，建好后补发
    pendingRuntimeNote = paths.runtimeNote
  }
  // 回收站：上一次卸载留下的运行时目录到这时才真删（旧壳 #114：直接删会动到与运行树
  // 共享 hardlink 的 ctime，触发 dsh 插件 rebuilt → 白屏），所以只能在 spawn 之前清。
  const purgedTrash = purgeRuntimeTrash(paths.appSupport, log)
  if (purgedTrash > 0) log(`运行时回收站：清理 ${String(purgedTrash)} 项（上一次卸载的残留）`)
  // 安装中断留下的临时目录（.staging-*）：扫描看不见但占磁盘，同样在 spawn 之前清
  const purgedStaging = purgeStagingDirs(paths.appSupport, log)
  if (purgedStaging > 0) log(`运行时安装残留：清理 ${String(purgedStaging)} 项（上次装到一半没装完的）`)

  // ---- 运行时下载安装：面板点「下载」→ 单飞装树（命令表只调 downloader，不自己 spawn）----
  // pnpm.cjs 随内置树分发（prepare:bundle 按 builtin-runtime.json 声明物化，#16）；包管理器跑在**我们的 Bun** 上。
  const bunPath = process.execPath
  const builtinDir = resolveBuiltinRuntimeDir(env, { repoRoot: paths.repoRoot, resourcesDir: paths.resourcesDir })
  const pnpmCjs = resolvePnpmCjs({
    env,
    runtimeRoot: paths.runtimeDir,
    builtinDir,
    appSupport: paths.appSupport,
  })
  if (pnpmCjs === null) log('运行时下载：没找到 pnpm.cjs（可用 DSH_SHELL_PNPM 指定），面板点下载会失败')
  const downloader = createRuntimeDownloader({
    // #97：signal 是取消信号——面板点取消 → downloader.cancel() abort 它 → installRuntime 树级停树
    install: async (version, onProgress, signal) => {
      if (pnpmCjs === null) throw new Error('找不到 pnpm.cjs（可用 DSH_SHELL_PNPM 指定内置的那份）')
      const nodeShimDir = ensureNodeShim({
        appSupport: paths.appSupport,
        bunPath,
        hasNode: Bun.which('node') !== null,
        log,
      })
      // #79：手动/系统代理注入 pnpm 安装环境（childProxy 在下方 connect 段定义，下载时才执行）；
      // off = null → 不传 env，继承壳环境原样（与宿主 spawn 同语义：不动用户自己设的代理变量）
      const proxy = childProxy()
      await installRuntime({
        appSupport: paths.appSupport,
        version,
        bunPath,
        pnpmCjs,
        nodeShimDir,
        env: proxy === null ? undefined : proxyEnvRecord(proxy),
        onProgress,
        signal,
        onLog: log,
      })
    },
    record: (version, source) => {
      recordInstalledRuntime(paths.appSupport, {
        version,
        source: source === 'npm' ? 'npm' : 'github',
        installed_at: Date.now(),
      })
    },
    log,
  })

  // 运行时下载的唯一通知出口（#115 收全通知面）：托盘（service.download）与面板（download_runtime）
  // 两条路都汇到这里的包装——成功/失败发 SCENARIO.RUNTIME_DOWNLOAD（取消不发），调用方不重复发。
  const downloadRuntimeNotified = withRuntimeDownloadNotify((version, source) => downloader.start(version, source), {
    notify: (scenarioId, body) => notifier.notify(scenarioId, body),
    cancelled: () => downloader.status().cancelled,
  })

  // ---- 宿主 PATH 垫片（#70）：connect 时现算——切运行时/新下载后重连即拿到新 pnpm.cjs；
  // pnpm.cjs 找不到时回 undefined，宿主 PATH 不动（启动不因此失败，插件安装维持旧行为报错）。----
  // hasNode 口径沿用旧通道（探壳进程 PATH；startService 已把 login shell env 并入 process.env）。
  const hostPathShimDir = (): string | undefined =>
    ensureShimDir({
      appSupport: paths.appSupport,
      bunPath,
      hasNode: Bun.which('node') !== null,
      pnpmCjs: resolvePnpmCjs({
        env,
        runtimeRoot: paths.runtimeDir,
        builtinDir: resolveBuiltinRuntimeDir(env, { repoRoot: paths.repoRoot, resourcesDir: paths.resourcesDir }),
        appSupport: paths.appSupport,
      }),
      log,
    }) ?? undefined

  // ---- 页面 origin 端口：固定 + 被占顺延（origin 是 localStorage 的隔离键）----
  const readClaims = async (): Promise<string> => {
    try {
      return await Bun.file(claimsFile).text()
    } catch {
      return '[]'
    }
  }
  // 空闲判定必须同时试 127.0.0.1 与 0.0.0.0：手机访问插件绑的是通配地址，
  // 而 macOS 上「别人占着 *:P」时绑 127.0.0.1:P 仍会成功（实测），只试 loopback 会
  // 把已被占用的 lane 端口判成空闲，第二份服务面的宿主直接 EADDRINUSE 退出（多窗口实测）。
  const portFree = (port: number): boolean => {
    for (const hostname of ['127.0.0.1', '0.0.0.0']) {
      try {
        const probe = Bun.listen({ hostname, port, socket: { data() {}, open() {}, close() {} } })
        probe.stop(true)
      } catch {
        return false
      }
    }
    return true
  }

  // 台账是多个服务面共享的文件（每份 profile 一份服务面）：写入前重读并合并，
  // 否则后启动的那份会把先启动那份的条目当成脏数据覆盖掉。
  const isAlivePid = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return pid === process.pid
    }
  }
  let claims = pruneClaims(parseClaims(await readClaims()), isAlivePid)
  const previous = claimFor(claims, paths.profile)
  // 页面 origin 的认定 key：切 profile 不换 origin（localStorage 的隔离键就是它）
  const claimProfile = paths.profile
  const pagePort = choosePort({
    requested: Number(env.DSH_SHELL_PAGE_PORT ?? '') || settings.profilePagePorts?.[paths.profile],
    lastClaimed: previous?.port,
    isFree: portFree,
  })
  if (pagePort === null) throw new Error('页面 origin 端口池已耗尽')
  // 上游/lane 固定端口（旧壳公式，用户口径：不做随机端口与顺延）：
  //   上游 = env DSH_DESKTOP_PORT > profile_ports >（web 的遗留 port）> 3080/3081/3082+fnv%512
  //   lane = env DSH_MOBILE_LANE_PORT > profile_lane_ports >（web 的遗留 lane_port）> 3092/3093/3094+fnv%512
  // 跨进程的端口冲突不做静默顺延：启动前判定（见下方 decideClaim）；本壳/外部 dsh 占用 → 自动清场后壳自拉，陌生程序占用 → 明确报错。
  // 同进程多窗口的互相避让用 taken（含其它服务面已占的端口与页面端口），只在会话内存里记。
  const taken = new Set<number>([pagePort])
  for (const claim of claims) {
    taken.add(claim.port)
    if (claim.dataPort !== undefined) taken.add(claim.dataPort)
    if (claim.lanePort !== undefined) taken.add(claim.lanePort)
  }
  const lanePort: number = profileLanePort(settings, paths.profile, env, taken)
  taken.add(lanePort)
  const upstreamPort: number = profilePort(settings, paths.profile, env, taken)
  taken.add(upstreamPort)
  log(`端口：页面 origin ${String(pagePort)} | dsh 上游 ${String(upstreamPort)} | 手机 lane ${String(lanePort)}`)
  options.onStage?.('ports')
  const token = `tok-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`

  // ---- 启动清扫：上一次壳留下的孤儿宿主 ----
  // 本次壳起的宿主有看门狗（runtime/parent-watch.mjs）兜底；上一次壳被 SIGKILL/崩溃后留下的
  // 孤儿只能靠台账在启动时清掉——它会一直占着会话（实机复现过）。
  const hostRegistryFile = env.DSH_SHELL_HOST_REGISTRY ?? join(home, 'shell-hosts.json')
  const swept = sweepStaleHosts({ file: hostRegistryFile, log })
  if (swept.killed.length > 0 || swept.pruned.length > 0) {
    log(`宿主台账清扫：杀掉孤儿 ${String(swept.killed.length)} 个、清理过期条目 ${String(swept.pruned.length)} 个`)
  }
  // ---- 宿主：Bun 起 dsh，自己拿端口并上报 { url, injections } ----
  // GUI（Finder/LaunchServices）启动只继承 launchd 的最小 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
  // 于是 dsh 子进程里 gh / bun / node / pnpm 全部找不到。官方 Electron 桌面为此读回登录 shell
  // 的环境；这里同语义做一遍，并把结果也落到壳自己的 process.env（后续 spawn 都受益）。
  const loginShell = await readLoginShellEnvironment(env, { timeoutMs: resolveLoginShellTimeoutMs(env) })
  if (loginShell.failures.length > 0) {
    log(`登录 shell 环境读取失败：${loginShell.failures.map((failure) => `${failure.shell}(${failure.reason})`).join('、')}——沿用继承环境`)
  }
  log(`PATH = ${loginShell.environment.PATH ?? '(空)'}`)
  for (const [key, value] of Object.entries(loginShell.environment)) process.env[key] = value
  const childEnv = loginShell.environment

  const hostMode = env.DSH_SHELL_PROFILE_MODE === 'fresh' ? 'fresh' : 'existing'

  /**
   * 选中运行时的版本号：优先用运行时树自报的 package.json 版本，目录名只当兜底。
   *
   * 为什么不能只看目录名：内置树落在 `<Resources>/app/dsh`（目录名就是 `dsh`），
   * 目录名当版本号会让 `versionAtLeast('dsh', …)` 判否 ⇒ 注入清单退回旧的 `webRuntime`
   * 契约 ⇒ 宿主报 `connection (required) webRuntime` 而启动失败（实测）。
   */
  const runtimeVersion = paths.runtimeVersion ?? basename(paths.runtimeDir)
  // ---- profile 脚手架 + 插件 staging（都必须在起宿主之前，这次 spawn 就要能看到）----
  // ① profile：上游 `loadProfile()` 只认「目录里已有 package.json」的 profile，缺了就报
  //    `dsh: profile "desktop" does not exist`——全新 DSH_HOME 能起壳就是因为这一步。
  // 官方对齐（分两层）：
  // ① profile 目录初始化 = dsh 自己的 initProfile（apps/desktop/src/project-manager.ts 的
  //    createPluginProfile 同款，bundles 与 web 一致）；壳不再手写四份模板。
  // ② 依赖物化：官方打包态会把 core 依赖物化进 profile（createRuntimeProjectMetadata +
  //    包管理器）；Bun 下没有等价 loader（#209），所以沿用「运行时树摊平」物化。

  // dsh 自己的 profile 初始化（apps/desktop createPluginProfile 同款）：目录缺 package.json
  // 时用 boot.initProfile 落 dsh 的标准 profile，而不是壳手写的脚手架。
  const ensureProfileInitialised = (layout: ShellLayout): void => {
    const profileDir = `${layout.home}/profiles/${layout.profile}`
    if (existsSync(`${profileDir}/package.json`)) return
    try {
      const require = createRequire(join(layout.dshLibDir, 'bin.js'))
      const bootUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href
      // 动态 import 拿不到具名导出时静默退回（宿主脚本里还有同款兜底）
      void import(bootUrl).then((boot) => {
        boot.initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
        log(`profile 初始化（dsh initProfile）：${profileDir}`)
      }).catch(() => {})
    } catch {
      // 运行时树还没就绪等场景：宿主脚本启动时会再兜底一次
    }
  }

  // ---- profile 依赖树：运行时树摊平（#209；官方打包态 core 物化的等价物）----
  const reconcileProfileFor = (profile: string): void => {
    // #13：落点 = 共享池 profiles/node_modules（per-profile 池的壳遗留链接由入口前置清理）
    reconcileProfileRuntimeTree({
      home: paths.home,
      profile,
      runtimeModules: `${paths.runtimeDir}/node_modules`,
      onLog: log,
    })
  }
  ensureProfileInitialised(paths)
  reconcileProfileFor(paths.profile)

  // ---- 防休眠（#186）：纯裁决 + tick 循环；忙状态由宿主插件 POST /notify 上报 ----
  // 旧壳把通知口跑在独立随机端口上（notify.rs），端口与令牌经环境变量交给 dsh 侧插件；
  // 插件缺 env 时静默降级（不是关键路径）——这里保持同一契约。
  const arbiter = createArbiter({ enabled: settings.preventSleep })
  // 令牌缺省每启动随机；`DSH_SHELL_NOTIFY_TOKEN` 是探针/黑盒测试用的覆盖口（与其它 DSH_SHELL_* 同性质）。
  const notifyTokenOverride = (env.DSH_SHELL_NOTIFY_TOKEN ?? '').trim()
  const notifyServer = startNotifyServer({
    ...(notifyTokenOverride === '' ? {} : { token: notifyTokenOverride }),
    onBusy: (profile, busy) => {
      const changed = arbiter.setBusy(profile, busy, Date.now())
      if (changed) {
        log(`防休眠：${profile} ${busy ? '开始' : '结束'}跑会话 → ${arbiter.shouldHold() ? '持有断言' : '可释放'}`)
      }
    },
    onNotify: (payload) => {
      const scenarioId = NOTIFY_TYPE_SCENARIOS[payload.type]
      if (scenarioId === undefined) {
        log(`通知口收到未知类型 ${payload.type}，已忽略`)
        return
      }
      notifier.notify(scenarioId, payload.body)
    },
    onLog: log,
  })
  const keepAwake = createKeepAwake({ arbiter, log })
  if (settings.preventSleep ?? true) keepAwake.start()
  else log('防休眠：设置里已关闭（prevent_sleep = false）')

  // ---- 通知：决策在 notify-policy，这里只做「场景 → 投递」与宿主事件映射 ----
  // 旧壳 70 个调用点收敛到场景 id；新壳先接已有的调用点（宿主事件 + 服务健康 + 启动受阻）。
  // 通知权限：macOS 走我们自己的 UN 桥（旧壳 notify_un.rs 的等价物）——能读真实授权状态、
  // 能主动申请；Electrobun 只暴露投递，拿不到状态（面板上那个写死的「已授权」就是这么来的）。
  const notifyBridge = options.notifyBridge ?? createNativeNotify({ log, env, execPath: process.execPath })
  const notifier =
    options.notifier ??
    createNotifier({
      notifications: settings.notifications,
      home,
      onLog: log,
      isFocused: () => options.isWindowFocused?.(paths.profile) ?? false,
      show: notifyBridge.available
        ? (payload) => {
            const ok = notifyBridge.post({ title: payload.title, body: payload.body, sound: payload.silent !== true })
            if (!ok) log(`[notify] 原生桥拒绝投递：${payload.title}`)
          }
        : undefined,
    })
  if (pendingRuntimeNote !== null) {
    notifier.notify(SCENARIO.CONFIG_ERROR, `运行时回退：${pendingRuntimeNote}`)
    pendingRuntimeNote = null
  }
  if (notifyBridge.available) {
    notifyBridge.start()
    // start() 是异步的（原生层要等系统回调），第一行日志只能报「当时快照」；
    // 1.5s 后再报一次真实状态，诊断时一眼能看出到底是未决定还是被拒。
    const announce = (): void => {
      const permission = notifyBridge.status()
      log(
        `[notify-un] 通知权限：${permissionLabel(permission)}（${permissionHint(permission, options.platform ?? process.platform)}；err=${String(notifyBridge.lastError())}）`
      )
    }
    log(`[notify-un] 原生通知桥已就绪：${String(notifyBridge.libPath)}（权限：${permissionLabel(notifyBridge.status())}）`)
    announce()
    setTimeout(announce, 1_500).unref?.()
  }
  // ②b 应用更新（#220 决策 11）：旧壳没有这个能力，是新增件——包住框架 Updater。
  // 拿不到更新源（dev 构建 / 未配 release.baseUrl）时只记日志，面板里显示「为什么不可用」。
  const updater = options.updater ?? createUpdater({ log, env })
  updater.start()
  // ② 插件：把桌面壳插件（+ 手机侧，若在）挂进 profile 模块池，并写 `--patch` 注入清单。
  const staged = stagePlugins({
    home,
    profile: paths.profile,
    appSupport: paths.appSupport,
    paths: { repoRoot: paths.repoRoot, resourcesDir: paths.resourcesDir },
    ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
    muxHeartbeatMs: settings.muxHeartbeatMs,
    desktopLayoutOnPhones: settings.desktopLayoutOnPhones,
    env,
    log,
    warn: (line) => {
      console.warn(`[shell] ${line}`)
      log(line)
    },
  })
  let patchFiles = [staged.injectFile]
  // remote 视图 token（#47）：铸给 mobile-access 远程命令桥；守护器重启宿主时沿用同一枚
  let remoteViewToken: string | undefined
  // #101：boot 载荷是否已可写（服务面 guard：声明前的早期注入更新只落宿主快照，不会被丢）
  let bootPayloadLive = false
  let liveSettings = settings
  // 远程 dsh 地址（旧壳 select_remote）：设置里存了就进入远程模式——本地文档 + 远程数据面，
  // 不 spawn 宿主（「远程只是少了启动 dsh 这一步」）。restartHost 会重算。
  let remoteAddr: string | null = normalizeRemoteUrl(liveSettings.remoteAddr ?? '')
  /**
   * 代理注入（旧壳 `resolved_proxy_env` + `system_proxy_env`）：manual 用设置里的 URL，
   * system 问系统（macOS `scutil` / Windows 注册表 / 其余环境变量），off 不注入。
   * 每次 spawn 现算——面板改完代理重启服务面就生效。
   */
  const childProxy = (): ProxyEnv | null =>
    resolveProxyEnv(liveSettings, detectSystemProxy({ platform: process.platform, env: childEnv, log }))
  // ---- 端口认领判定（旧壳 decide_claim：启动前判定，free 才自动拉起）----
  const upstreamOpen = await portOpen(upstreamPort)
  const oursAlive = readHostRecords(hostRegistryFile).some(
    (record) => record.profile === paths.profile && isAlivePid(record.hostPid),
  )
  const decision = decideClaim({
    profile: paths.profile,
    port: upstreamPort,
    portOpen: upstreamOpen,
    claims: oursAlive ? [{ profile: paths.profile, port: upstreamPort, alive: true }] : [],
    legacyWebPort: profilePort(settings, 'web', env),
  })
  let blockedMessage: string | undefined
  // 远程模式跳过本地端口认领（旧壳 startup 远程短路：根本不走本地 spawn 链）
  // #117：把「认领判定」（壳的事，startService 阶段就跑完）与「把 DSH 拉起来」（服务面管的事）拆开。
  // 这里只决定该不该拉、为什么不该拉；真拉是 ensureRunning() 的活。
  let shouldConnect = false
  if (remoteAddr !== null || decision === 'free') {
    shouldConnect = true
  } else if (decision === 'foreign-unknown') {
    blockedMessage = `端口 ${String(upstreamPort)} 被其他实例或程序占用（profile=${paths.profile}），已停止自动拉起；可在设置中调整该 profile 的端口后重试`
    log(`[shell] ${blockedMessage}`)
  } else {
    // 端口被占（本壳旧实例 / 外部 dsh web）：自动清场后由壳自拉（不再弹「兼容 / 高级」弹框）
    const freed = await stopPortOwner({ port: upstreamPort, log })
    if (freed) {
      log(`[shell] 已清理 127.0.0.1:${String(upstreamPort)} 上的旧实例，由壳重新拉起上游`)
      shouldConnect = true
    } else {
      blockedMessage = `端口 ${String(upstreamPort)} 清理失败，仍被其他程序占用（profile=${paths.profile}）；可在设置中调整该 profile 的端口后重试`
      log(`[shell] ${blockedMessage}`)
    }
  }
  options.onStage?.('cookie')

  // ---- loopback 服务 ----
  // boot 载荷与上游可换：守护器重启宿主后要指向新的 url/cookie（同一个 options 对象）。
  let bootPayload: BootPayload = {
    injections: [],
    streamBaseUrl: `http://127.0.0.1:${String(pagePort)}`,
  }
  // 壳 ↔ 页面 RPC：命令表要等 service 对象建好才能回填（restart_dsh_service 直接打它）。
  // 页面在服务就绪后才会来调，所以那时一定已装好；未装好则明确回 503。
  let rpcRouter: RpcRouter | null = null
  // 启动检查的进程内状态（旧壳 DshState：skip_startup_check 与 pending_active_profile 都不落盘）
  let startupChecked = false
  let pendingProfile: string | null = null
  // 迁移/依赖重建的进度（设置面板 300ms 轮询 migration_status）
  const taskTracker = createTaskTracker()
  // 下载管理器（旧壳 `download/{manager,transfer}.rs`）：URL 直链与页面 blob 两条管线共用一份任务表。
  // cookie 只在「下载目标就是壳对接的那个 dsh 实例」时带（旧壳 transfer.rs 同语义）；
  // 页面 origin 的请求由壳自己的反代补 cookie，所以它不需要这里带。
  const downloads = createDownloadManager({
    home,
    log,
    notify: (filename) => notifier.notify(SCENARIO.DOWNLOAD_COMPLETE, filename, '下载完成'),
    chooseDirectory: options.chooseDownloadDir,
    concurrency: liveSettings.downloadConcurrency,
    saveConcurrency: (value) => {
      // 注意：这条写路径绕过 saveSettings——新增「需即时生效」的开关键必须改走 saveSettings，否则壳侧裁决器/循环不同步。
      liveSettings = updateSettings(home, { download_concurrency: value }, log)
    },
    cookieFor: (url) => {
      if (serverOptions.cookie === undefined || serverOptions.cookie === '') return null
      try {
        const origin = new URL(url).origin
        if (origin === serverOptions.upstreamOrigin) return serverOptions.cookie
      } catch {
        return null
      }
      return null
    },
    downloadDir: join(env.HOME ?? home, 'Downloads'),
  })
  // 命令表要的运行时快照：当前生效的运行时 + 内置版本 + 已装列表。
  // 每次调用都重算（面板刷新时顺带发现新装/新删的版本；旧壳同样在命令里现查）。
  const runtimeSnapshot = (): RuntimeSnapshot => {
    const builtinDir = resolveBuiltinRuntimeDir(env, { repoRoot: paths.repoRoot, resourcesDir: paths.resourcesDir })
    return {
      builtinVersion: builtinDir === null ? null : readRuntimeVersion(builtinDir),
      activeVersion: paths.runtimeVersion,
      activeKind: paths.runtimeKind,
      activeDir: paths.runtimeDir,
      selected: liveSettings.dshRuntime ?? null,
      // #79：回退说明（偏好版本不在已装里时的用户可见原因；无回退为 null），面板直接展示
      note: paths.runtimeNote,
      installed: listInstalledRuntimes(paths.appSupport),
    }
  }
  const serverOptions: ShellServerOptions = {
    distDir: paths.distDir,
    token,
    cookie: '',
    upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
    port: pagePort,
    bootPayload: () => bootPayload,
    onOpenExternal: options.onOpenExternal,
    onContextMenu: options.onContextMenu,
    onActivate: options.onActivate,
    onWindowControl: options.onWindowControl,
    onWindowState: options.onWindowState,
    onInputConfirm: options.onInputConfirm,
    views: options.views,
    // #128：聚合档位读内存单写者（saveSettings 每次重新赋值 liveSettings）——切档即时生效，热路径零磁盘 IO。
    aggregation: () => liveSettings.loopbackAggregation ?? DEFAULT_LOOPBACK_AGGREGATION,
    onLog: log,
    onRpc: async (raw, grant) => {
      if (rpcRouter === null) return { status: 503, body: { ok: false, error: 'shell rpc not ready' } }
      return await dispatchRpc(
        rpcRouter,
        raw,
        grant === null ? {} : { caller: { kind: grant.kind, profile: grant.profile, label: grant.label } },
      )
    },
  }
  const server = startShellServer(serverOptions)
  // #169：主进程账号 watcher——页面在桌面语义下不会自己开窗，登录「等浏览器」这一步由壳完成。
  const accountWatcher = createAccountWatcher({
    hostOrigin: () => serverOptions.upstreamOrigin,
    cookie: () => serverOptions.cookie,
    openExternal: options.onOpenExternal,
    theme: () => readShellTheme(paths.home, paths.profile),
    log,
  })
  options.onStage?.('server')
  // #101：从这里起 boot 载荷可写；宿主后续推送的注入清单经 supervisor onInjections 转交刷新（不丢）
  bootPayloadLive = true
  // 手机稳定接入点（旧壳 forwarder.rs #94）：监听遗留 lane 端口（laneForwarderPort > lanePort > 3091），
  // 新连接落本实例的 lane；外部 dsh 占了端口时退场（手机直连它即可）。多实例下只有先起的那份
  // 服务面拿得到转发器（同端口第二绑定必失败），index.ts 的焦点切换会找到它更新目标。
  const forwarder = startLaneForwarder({ port: settings.laneForwarderPort ?? settings.lanePort ?? 3091, log })
  forwarder?.setTarget(lanePort)
  const pageUrl = `${server.origin}/${token}/`

  // 写入前重读磁盘：多窗口下台账被所有服务面共享，内存副本可能是旧的（否则会覆盖掉别人的行）。
  const writeClaim = async (): Promise<void> => {
    const onDisk = pruneClaims(parseClaims(await readClaims()), isAlivePid)
    const merged = upsertClaim(onDisk, {
      profile: claimProfile,
      port: pagePort,
      dataPort: upstreamPort,
      lanePort,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })
    claims = merged
    await Bun.write(claimsFile, `${JSON.stringify(merged, null, 2)}\n`)
  }
  await writeClaim()
  // 底部状态条轮询的 dsh 服务状态码（旧壳 0..7：2 运行中 / 4 重启中 / 5 服务异常 / 6 服务下线）。
  // 页面重载后状态条要能立刻显示真值，所以每个阶段都得维护它。
  let dshStatusCode = 2
  /**
   * #215：服务面是终态对象——stop() 走一遍就把 HTTP 面/看门狗/端口认领全拆了。
   * 第二次 stop() 不再拆一遍（会跟第一次打架），而是等同一份拆解跑完：
   * 壳退出兜底路径并发调 stop() 时，得等真的拆完，不能提前放行。
   */
  let stopping: Promise<void> | null = null

  const state: ShellState = {
    pid: process.pid,
    origin: server.origin,
    pageUrl,
    token,
    profile: paths.profile,
    runtimeDir: paths.runtimeDir,
    distDir: paths.distDir,
    hostPid: 0,
    upstreamPort,
    lanePort,
    notifyPort: notifyServer.port,
    injections: bootPayload.injections.length,
    noWindow: options.noWindow ?? false,
    settings,
    settingsProvenance: { created: loaded.created, migrated: loaded.migrated, recovered: loaded.recovered },
    ...(blockedMessage === undefined ? {} : { blocked: blockedMessage }),
    // #117：此刻要么 blocked（端口占着，自动拉起被拒），要么 stopped（壳的面全就绪，DSH 还没拉）。
    // 「把 DSH 拉起来」是 ensureRunning() 的事，不再是 startService() 返回的前提。
    status: blockedMessage === undefined ? 'stopped' : 'blocked',
    error: null,
  }
  await Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`)

  // ---- 宿主监督（#183）：宿主生命周期与宿主事实收口 host-supervisor.ts，服务面只组合与发布 ----
  /** 宿主事实落定（supervisor 发布）：组合 ShellState 并写状态文件（服务面是唯一写者）。 */
  const applyHost = (snap: HostSnapshot): void => {
    bootPayload.injections = [...snap.injections]
    serverOptions.cookie = snap.cookie
    if (snap.hostOrigin !== '') serverOptions.upstreamOrigin = snap.hostOrigin
    // 宿主就绪/重启后都调一次（幂等）：watcher 断线自己重连，每轮现取 cookie/origin。
    accountWatcher.start()
    state.hostPid = snap.hostPid
    state.injections = bootPayload.injections.length
    state.status = snap.status
    state.error = snap.error
    void Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`)
  }
  const supervisor = createHostSupervisor({
    registryFile: hostRegistryFile,
    readyInitially: remoteAddr !== null || decision === 'free',
    spec: () => ({
      remoteAddr: normalizeRemoteUrl(liveSettings.remoteAddr ?? ''),
      layout: paths,
      clientVersion: options.clientVersion,
      mode: hostMode,
      env: childEnv,
      patchFiles,
      upstreamPort,
      pagePort,
      lanePort,
      remoteViewToken: () => {
        remoteViewToken ??= options.views?.issue('remote', paths.profile, 'mobile-access 命令桥').token
        return remoteViewToken
      },
      proxy: childProxy(),
      cloudflaredBin: liveSettings.cloudflaredBin,
      pathShimDir: hostPathShimDir(),
      notify: { port: notifyServer.port, token: notifyServer.token },
      retryExisting: existsSync(`${paths.home}/profiles/${paths.profile}/package.json`),
    }),
    log,
    notify: (scenario, body) => notifier.notify(scenario, body),
    onInjections: (rows) => {
      if (bootPayloadLive) bootPayload.injections = [...rows]
      log(`[shell] 注入清单更新：injections = ${String(rows.length)}（宿主图重算，boot 载荷已刷新）`)
    },
    onHost: applyHost,
    onRestart: () => {
      dshStatusCode = 2
      options.onHostRestart?.(state)
    },
    onGiveUp: (_snap, reason, terminal) => {
      if (terminal) dshStatusCode = 5
      options.onHostGiveUp?.(state, reason)
      if (terminal) notifier.notify(SCENARIO.STARTUP_ERROR, `dsh 服务无法恢复：${reason}`)
    },
    onChange: (snap) => {
      if (snap.restarting) dshStatusCode = 4
    },
    onCrash: () => {
      // 旧实例没了 = 它的忙租约不再会被刷新：先摘干净再决定要不要重启。
      arbiter.clear()
      keepAwake.tick()
    },
  })
  // 端口被陌生程序占用：blocked 记进宿主监督的口径（服务面 ShellState.blocked 同源）
  if (blockedMessage !== undefined) supervisor.blocked(blockedMessage)

  // ---- 诊断快照（#220 日志与诊断）：一个 JSON 回答「哪版、哪个 profile、端口/pod、日志在哪」----
  const startedAt = new Date().toISOString()
  const pageLogPath = webviewLogFile
  const diagnosticsInput = (): DiagnosticsInput => ({
    appVersion: options.appVersion ?? 'unknown',
    pid: process.pid,
    startedAt,
    uptimeMs: Date.now() - Date.parse(startedAt),
    noWindow: state.noWindow,
    locale: options.locale ?? 'zh-CN',
    profile: paths.profile,
    origin: state.origin,
    pageUrl: state.pageUrl,
    pagePort,
    upstreamPort: state.upstreamPort,
    lanePort: state.lanePort,
    hostPid: state.hostPid,
    hostRunning: state.hostPid > 0,
    runtimeKind: paths.runtimeKind,
    runtimeVersion: paths.runtimeVersion,
    runtimeDir: paths.runtimeDir,
    distDir: paths.distDir,
    injections: state.injections,
    settingsSummary: settingsSummary(settings),
    settingsPath: join(home, 'desktop-settings.json'),
    settingsProvenance: state.settingsProvenance,
    views: (options.views?.list() ?? []).map((grant) => ({ kind: grant.kind, profile: grant.profile, label: grant.label })),
    downloads: {
      tasks: downloads.list().length,
      active: downloads.list().filter((task) => task.status === 'downloading' || task.status === 'queued').length,
      concurrency: downloads.concurrency(),
    },
    notify: {
      available: notifyBridge.available,
      permission: notifyBridge.available ? notifyBridge.status() : 'unavailable',
      port: state.notifyPort,
    },
    logs: {
      shell: describeLogFile(logFile),
      webview: describeLogFile(pageLogPath),
      tail: shellLog.tail(DIAG_TAIL_LINES),
    },
    process: {
      platform: options.platform ?? process.platform,
      arch: process.arch,
      osRelease: osRelease(),
      bun: Bun.version,
      ...(process.versions.node === undefined ? {} : { node: process.versions.node }),
      cpus: osCpus().length,
      totalMemBytes: osTotalmem(),
      freeMemBytes: osFreemem(),
    },
  })
  const diagnosticsSnapshot = (): Record<string, unknown> => buildDiagnostics(diagnosticsInput(), new Date())

  /** 页面控制台一条消息：写 `dsh-desktop-webview.log`；warn/error 另镜像一份到壳日志（旧壳同口径） */
  const logPageConsole = (input: { level: string; msg: string; pageUrl: string | null }): void => {
    const level = classifyLevel(input.level)
    for (const line of pageLogLines({ level, msg: input.msg, pageUrl: input.pageUrl })) pageLog.write(`${line}\n`)
    if (mirrorToShellLog(level)) log(`[page.${level}] ${input.msg.split('\n')[0] ?? ''}`)
  }

  // #117：registerHost / supervise 跟着 ensureRunning 走了 —— 它们描述的是「宿主在跑」这件事，
  // 而 startService 现在只负责把服务面立起来。端口台账（writeClaim）与诊断快照仍在这里。
  log(`端口台账：${JSON.stringify(claims)}`)
  options.onStage?.('ready')
// #117：'ready' 阶段不再在这里推 —— 它得等 DSH 真的就绪，由 ensureRunning() 推（启动界面据此收尾）。


  // 写设置的唯一路径：命令表（设置面板）与壳侧（托盘切运行时）都走它
  const saveSettings = (patch: Record<string, unknown>): DesktopSettings => {
    const before = liveSettings
    liveSettings = updateSettings(home, patch, log)
    // config.info（端口保存等低危信息）：只有真动了端口键才提示一句，普通保存不打扰。
    const changedPorts = changedPortKeys(before, liveSettings)
    if (changedPorts.length > 0) {
      notifier.notify(SCENARIO.CONFIG_INFO, `端口设置已保存（${changedPorts.join('、')}）；重连服务面后生效。`)
    }
    state.settings = liveSettings
    state.settingsProvenance = { created: false, migrated: false, recovered: false }
    void Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`)
    // 面板承诺「改动立即生效」，这里兑现（#186 遗留）：prevent_sleep 不能只在启动时读一次。
    // 放在状态文件写入之后：平台断言这条路径万一抛错（darwin 分支没有 try/catch）也不拖累落盘。
    // `?? true` 与 createArbiter 的缺省一致（settings 已归一化，这里只是给类型收口）。
    syncPreventSleep(liveSettings.preventSleep ?? true, { arbiter, keepAwake })
    return liveSettings
  }

  /** profile 依赖重建（旧壳 profiles.rs 的 pnpm_install_profile）：内置 pnpm install --no-frozen-lockfile */
  const rebuildProfileDependencies = async (profile: string): Promise<string> => {
    // 新 profile 先落四份模板（没有 package.json 时 pnpm install 直接报错）——旧壳在 repair 前也会先补模板。
    scaffoldProfile(home, profile)
    const result = await installProfileDependencies({
      home,
      profile,
      appSupport: paths.appSupport,
      runtimeRoot: paths.runtimeDir,
      env: childEnv,
      log,
    })
    if (!result.ok) throw new Error(result.error)
    return `${profile}：依赖已重建`
  }

  // ---- #117：服务面管 DSH 的那条线 ----
  /** 正在拉的那次（并发调用复用它，不重复 spawn 宿主） */
  let starting: Promise<void> | null = null
  /**
   * 按当前设置重新解析运行时布局，并就地更新服务面认的那一份（paths/共享池/distDir/状态文件）。
   * 设置面板切版本与托盘切版本共用这条。**切不出来就落 failed 态并抛，绝不拿旧布局去拉宿主**——
   * 把现在还能跑的 DSH 弄死，换来的还是一个起不来的。
   */
  const adoptLayout = (): void => {
    const next = layout({ env, profile: paths.profile, preferred: liveSettings.dshRuntime })
    if (next.unresolved !== null) {
      supervisor.setStatus('failed', next.unresolved)
      log(`运行时切换失败：${next.unresolved}（保持当前运行时不动）`)
      throw new Error(next.unresolved)
    }
    if (next.runtimeDir !== paths.runtimeDir) {
      log(
        `运行时切换：${paths.runtimeVersion ?? paths.runtimeDir} → ${next.runtimeVersion ?? next.runtimeDir}（${next.runtimeKind}）`
      )
    }
    Object.assign(paths, next)
    // #13：运行时变了，共享池立即重指（全局一份，重指一次全部 profile 生效；迁移清理幂等）
    reconcileProfileFor(paths.profile)
    serverOptions.distDir = paths.distDir
    state.runtimeDir = paths.runtimeDir
    state.distDir = paths.distDir
    void Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`)
  }
  /**
   * 把 DSH 拉起来 —— 服务面**管理** DSH 的动作，不是它**存在**的前提。
   * 调用方（index.ts 冷启动 / serve.ts 黑盒握手 / 托盘改完运行时再试一次）决定什么时候要 DSH。
   *
   * 失败不重建服务面：落 failed 态 + 记原因 + 照旧抛给调用方。壳自己的部分（托盘/设置/
   * profile/退出）此时完全可用 —— 这正是 #117：DSH 起不来时用户仍然能换一个运行时再试。
   */
  const ensureRunning = async (): Promise<void> => {
    if (supervisor.state().stopping) return
    if (state.status === 'running') return
    // 端口被陌生程序占着：重试没用，得先改该 profile 的端口（状态里已经有原因）
    if (state.status === 'blocked') throw new Error(state.blocked ?? '端口被占用')
    if (starting !== null) return await starting
    // #117：用户刚在托盘/面板换了运行时 → 设置里的偏好与服务面认的运行时已经不是一回事，
    // 重新解析一次布局。切不出来 adoptLayout 自己落 failed 并抛，不会拿旧布局去拉。
    if (liveSettings.dshRuntime !== (paths.runtimeVersion ?? null)) adoptLayout()
    // 布局/运行时一个都解析不出来：没有可启动的宿主。服务面照样在，原因说清楚就行。
    if (paths.unresolved !== null) {
      supervisor.setStatus('failed', paths.unresolved)
      log(`[shell] dsh 起不来：${paths.unresolved}`)
      throw new Error(paths.unresolved)
    }
    supervisor.setStatus('starting')
    starting = (async (): Promise<void> => {
      await supervisor.start()
      dshStatusCode = 2
      options.onStage?.('ready')
      supervisor.setStatus('running')
      // #142：服务面就绪后在**后台**查一次更新（fire-and-forget）：窗口与托盘不等人，查不到也静默。
      void checkUpdates('startup')
    })()
    try {
      await starting
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      dshStatusCode = 5
      supervisor.setStatus('failed', reason)
      log(`[shell] dsh 未起来：${reason}（服务面仍在：托盘/设置/切换运行时/退出都可用）`)
      throw error
    } finally {
      starting = null
    }
  }
  // #60：面板「重启 dsh 服务」= 壳级完整重启（退出级 teardown → 全新启动，壳本体/托盘不退出）；
  // 无窗口/测试没有壳 teardown 回调，回落宿主级 restartHost（已树安全）。
  // #126 起托盘那项已是「重启应用」（整应用重来），不再是本条的同语义兄弟。
  // 具名是因为提醒卡的「切换后重启」也要走它（#139）——两条路径只能有一份。
  const restartService = async (): Promise<void> => {
    if (options.onFullRestart !== undefined) {
      await options.onFullRestart()
      return
    }
    await service.restartHost()
  }
  // ---- #142：启动后那次后台更新检查 ----
  // 判定/去重/记账都在纯逻辑层（shared/update-notice-policy.ts + #138 的判定层），这里只接两路探针。
  // app-support/update-notice.json 是服务面自己的落点——它不在 desktop-settings.json 里（键名是契约红线）。
  const updateNoticeStore = createUpdateNoticeStore(paths.appSupport, log)

  /**
   * 未下载候选的「装得上吗」闸门（#139 两次实机修）：目录说有 ≠ 装得上。
   *
   * 第一次真实失败是 GitHub 上刚发、npm 上还没有；第二次更隐蔽——`dsh@0.2.1-rc.2` 已在 npm，
   * 但它 pin 的第一方兄弟包 `dsh-tool-pwsh-persistent@0.2.1-rc.2` 还没发，`pnpm add` 直接炸
   * ERR_PNPM_NO_MATCHING_VERSION。所以这里按 registry 包文档核验每个候选的依赖闭包
   * （`shared/runtime-installability.ts`）：缺任何一个兄弟包就不提醒它。
   *
   * 无状态、每次真查：上游把缺的包补上之后，下一次检查自己就恢复（用户原话「拉黑你怎么知道有没有
   * 恢复」——所以不拉黑）。安装源恒为 npm（runtime-install.ts 无条件 pnpm add），这道闸门跟设置里
   * 的「运行时下载源」无关，GitHub 目录也一样要过。
   *
   * 返回 null = 压根没有未下载候选，不设闸；返回 [] = 一个都装不上（含「核验没查成」）。
   */
  const installableGate = async (candidates: readonly string[]): Promise<readonly string[] | null> => {
    if (candidates.length === 0) return null
    return installableVersions(await runtimeInstallability({ versions: candidates, log }))
  }
  // 启动那次与托盘手动那次共用这份依赖；差别只有 trigger（#141）。
  const checkUpdates = async (trigger: 'startup' | 'manual'): Promise<UpdateNoticeCheckResult> => {
    const open = options.onOpenUpdateNotice
    // 启动那次：主进程没接开窗能力就压根不查（省掉两次网络，也没东西可提醒）；
    // 托盘那次照查——用户亲手点的，结果要落到托盘那行灰字上。
    if (open === undefined && trigger === 'startup') {
      return { notify: false, reason: '提醒窗未接入', notified: [] }
    }
    return runUpdateNoticeCheck({
      trigger,
      store: updateNoticeStore,
      // 壳这一路：框架 updater 拿不到更新源（dev 构建）时 view 里压根没有新版本 ⇒ 自然静默。
      probeShell: async () => ({ view: (await updater.check()).view, fresh: true }),
      probeRuntime: async () => {
        const snapshot = runtimeSnapshot()
        const source = liveSettings.runtimeSource ?? DEFAULT_CATALOG_SOURCE
        const catalog = await fetchRuntimeCatalog({ source, repo: liveSettings.runtimeGithubRepo ?? null, log })
        const base = {
          running: snapshot.activeVersion,
          builtin: snapshot.builtinVersion,
          catalog: catalog.entries,
          installed: snapshot.installed,
          source,
          ...(catalog.error === undefined ? {} : { catalogError: catalog.error }),
        }
        // 第一遍只为算出「比在跑的更高的未下载候选」；核验过它们的依赖闭包，第二遍才是最终判定。
        const remote = remoteRuntimeCandidates(evaluateRuntimeUpdates(base))
        const installable = await installableGate(remote)
        return {
          report: evaluateRuntimeUpdates({
            ...base,
            ...(installable === null ? {} : { installable }),
          }),
          fresh: true,
        }
      },
      context: () => ({
        profile: paths.profile,
        baseline: runtimeVersion,
        preference: liveSettings.dshRuntime ?? '',
        theme: readShellTheme(paths.home, paths.profile),
      }),
      open: open ?? (() => false),
      log,
    })
  }
  // #139：提醒卡动作的依赖全部指向**已有**能力——壳下载走 updater，运行时下载走同一个单飞下载器，
  // 落设置走 saveSettings（#97：dsh_mode 必须一起写，否则「切回内置」会被当成没设置），重启走上面那份，
  // 「不再提示」落到上面那份 update-notice.json（测试可经 options.onIgnoreVersions 注入假实现）。
  const updateNoticeOp = createUpdateNoticeOpRunner({
    downloadShell: async () => {
      await updater.download()
    },
    // 端点是回环 HTTP，source 按普通外部输入对待：只认这两个，其余回落 github。
    downloadRuntime: (version, source) => downloadRuntimeNotified(version, source === 'npm' ? 'npm' : 'github'),
    switchRuntime: (version) => {
      saveSettings({ dsh_runtime: version, dsh_mode: 'builtin' })
    },
    restartService,
    ignoreVersions: (targets) => {
      if (options.onIgnoreVersions !== undefined) {
        options.onIgnoreVersions(targets)
        return
      }
      updateNoticeStore.ignore(targets)
    },
  })
  const service: ShellService = {
    state,
    paths,
    server,
    laneForwarder: forwarder,
    rpcRouter: () => rpcRouter,
    notify: notifyBridge,
    settings: () => liveSettings,
    // #117：服务面管理 DSH 的入口。起服务面不等它；什么时候要 DSH 由调用方说。
    ensureRunning,
    save: saveSettings,
    runtime: () => runtimeSnapshot(),
    fetchCatalog: (source) =>
      fetchRuntimeCatalog({ source, repo: liveSettings.runtimeGithubRepo ?? null, log }),
    downloadStatus: () => downloader.status(),
    download: downloadRuntimeNotified,
    // #97：托盘与面板共用同一个取消口，取消后两边都从轮询快照看到 cancelled 终态
    cancelRuntimeDownload: () => downloader.cancel(),
    // #139：提醒卡动作复用同一条重启路径（面板切运行时也是它）
    updateNoticeOp,
    // #141：托盘「检查更新」显式触发（manual）——同一份 store/探针/提醒窗，只是绕过去重
    checkUpdates,
    profileOp: async (request) => {
      if (request.op === 'create') {
        const name = request.target ?? ''
        if (!isValidProfileName(name)) {
          return { ok: false, message: '名称仅允许小写字母、数字与连字符（1-64 字符）' }
        }
        const result = scaffoldProfile(home, name)
        const message = result.created
          ? `profile ${name} 已创建；开窗时会自动装依赖树并拉起 dsh。`
          : `profile ${name} 已存在，直接打开即可。`
        options.onProfileOpApplied?.('create', name)
        if (result.created) notifier.notify(SCENARIO.PROFILE_OP, `profile ${name} 已创建`)
        return { ok: true, message, profile: name }
      }
      // migrate：校验后交给命令表同一条迁移路径（复制依赖树 + pnpm install，长任务）
      const source = request.source ?? ''
      const target = request.target ?? ''
      if (!isValidProfileName(target)) {
        return { ok: false, message: '目标名称仅允许小写字母、数字与连字符（1-64 字符）' }
      }
      if (isSelfMigrate(source, target)) {
        return { ok: false, message: '源与目标相同，无需迁移。' }
      }
      try {
        const summary = await migrateProfile({
          home,
          source,
          dest: target,
          overwrite: request.overwrite === true,
          activeProfile: paths.profile,
          install: () =>
            installProfileDependencies({
              home,
              profile: target,
              appSupport: paths.appSupport,
              runtimeRoot: paths.runtimeDir,
              env: childEnv,
              preferOffline: true,
              log,
            }),
          log,
          track: taskTracker,
        })
        options.onProfileOpApplied?.('migrate', target)
        notifier.notify(SCENARIO.PROFILE_OP, `profile ${target} 迁移完成`)
        return { ok: true, message: summary, profile: target }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        notifier.notify(SCENARIO.PROFILE_ERROR, `profile ${target} 迁移失败：${reason}`)
        return { ok: false, message: reason }
      }
    },
    onProfileOpApplied: (op, profile) => {
      log(`[profile-op] ${op} ${profile} 完成`)
    },
    restartHost: async () => {
      // 设置面板切了运行时版本：这里重新解析选中项（同一个 paths 对象就地更新，
      // 服务面、状态与命令表都以它为事实源），再杀宿主——守护器会带着新运行时重启。
      adoptLayout()
      // #117：服务面还没在跑 DSH 时，切运行时不需要走「杀宿主」那条路——直接按新布局拉起来即可。
      // 只有 DSH 已经在跑的时候，才需要先把旧宿主停下来。
      if (state.status !== 'running' && state.status !== 'starting') {
        await ensureRunning()
        return
      }
      await supervisor.restart()
    },
    // 多窗口：不再就地换 profile（旧壳的「托盘切换 profile」在新壳里就是把那份 profile 的窗口开到前台）。
    stop: async () => {
      // 终态对象：第一次 stop() 拆解，之后的调用等同一份拆解跑完——
      // 不重复拆（会跟第一次打架），也不提前放行（退出兜底路径要等真的拆完）。
      if (stopping !== null) return await stopping
      stopping = (async () => {
        // 先停账号 watcher，再停 supervisor：supervisor.stop() 会发布终态快照 → applyHost →
        // watcher.start()，watcher 停过就不会再复活（它自己的 start() 认 stopped），
        // 免得收摊时还去连一个已经死掉的宿主。
        accountWatcher.stop()
        await supervisor.stop()
        dshStatusCode = 6
        server.stop()
        notifyServer.stop()
        forwarder?.stop()
        keepAwake.stop()
        arbiter.clear()
        downloads.stop()
        updater.stop()
        // 插件链接要拆掉（item 9，旧壳 cleanup_desktop_plugin_links 的等价物）：
        // 不拆的话，用户回头用旧壳/别的安装时 profile 池里会留一份悬空 symlink。
        try {
          cleanupStagedPlugins(staged.staged, log)
        } catch (error) {
          log(`[exit] 清理插件链接失败：${String(error)}`)
        }
        // 同样先重读：退出时只能摘掉自己那一行，别人的行要留着
        const next = releaseClaim(parseClaims(await readClaims()), claimProfile)
        try {
          await Bun.write(claimsFile, `${JSON.stringify(next, null, 2)}\n`)
        } catch {}
      })()
      return await stopping
    },
  }
  // 命令表回填：页面侧的壳插件（设置面板/通知 tab/下载 tab/本地 chrome）靠它拿到壳的能力
  rpcRouter = createRpcRouter(
    createCommandTable({
      home,
      profile: () => paths.profile,
      platform: options.platform ?? process.platform,
      bundleId: resolveBundleIdentifier(),
      // #75：Linux 防休眠通道的能力快照（面板可见；拿不到通道时不静默）
      keepAwake: () => keepAwake.capability(),
      log,
      settings: () => liveSettings,
      save: saveSettings,
      restartService,
      // #119：整应用重启与「重启 dsh 服务」是两条路。壳没这个能力（无窗口模式/测试）时如实报不可用，
      // 不静默回落成 restartHost——那正是本票要修的那个「以为重启了其实没重跑」的假象。
      restartApp: async () => {
        if (options.onRestartApp === undefined) {
          log('[shell] 重启桌面应用：当前无壳层入口（无窗口模式），未执行')
          return { ok: false, reason: 'unavailable', message: '当前运行模式不支持自动重启桌面应用，请手动重启。' }
        }
        return options.onRestartApp()
      },
      status: () => ({ ...state }),
      ports: () => ({ port: pagePort, upstreamPort, lanePort }),
      // 设置面板的 Profile 端口表要看到所有 profile（多窗口）：行来自共享台账 + 磁盘 profile 目录
      portClaims: async () => pruneClaims(parseClaims(await readClaims()), isAlivePid),
      profiles: () => listProfiles(home, paths.profile),
      openExternal: options.onOpenExternal,
      // 壳 preload 脚本迁官方 RPC（#128③）：boot 载荷与右键菜单改走命令表
      bootPayload: () => bootPayload,
      showContextMenu: options.onContextMenu,
      closeWindow: options.onCloseWindow,
      playSound: (name) => notifier.previewSound(name),
      playSystemSound: () => {
        const command = systemDefaultSoundCommand(options.platform ?? process.platform)
        if (command === null) {
          // 没有后端就如实回 false：面板会提示「本机不支持」，不再假报成功（#74）
          log('[notify] 系统默认提示音：本机没有可用播放后端，未出声')
          return false
        }
        try {
          const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
          child.unref?.()
          log(`[notify] 试听系统提示音：${command.join(' ')}（pid = ${String(child.pid)}）`)
          return true
        } catch (error) {
          log(`[notify] 系统音试听失败：${error instanceof Error ? error.message : String(error)}`)
          return false
        }
      },
      pickSoundFile: options.pickSoundFile,
      importSound: (path) => importSoundFile(home, path),
      notifier,
      // 通知 tab 的权限徽标 / 「申请权限」按钮：真值来自我们的 UN 桥（非 macOS 或没打包时回 unavailable）
      notifyPermission: () => notifyBridge.status(),
      notifyRequestPermission: () => notifyBridge.request(),
      dshStatus: () => dshStatusCode,
      dshVersion: () => paths.runtimeVersion ?? basename(paths.runtimeDir),
      runtime: () => runtimeSnapshot(),
      fetchCatalog: (source) =>
        fetchRuntimeCatalog({ source, repo: liveSettings.runtimeGithubRepo ?? null, log }),
      removeRuntime: async (version) => {
        trashInstalledRuntime(paths.appSupport, version, log)
      },
      downloadRuntime: downloadRuntimeNotified,
      downloadStatus: () => downloader.status(),
      cancelRuntimeDownload: () => downloader.cancel(),
      downloads,
      logPageConsole,
      diagnostics: () => diagnosticsSnapshot(),
      exportDiagnostics: (snapshot) =>
        exportDiagnostics({
          home,
          snapshot,
          now: new Date(),
          reveal: (path) => revealPath(path, log),
          log,
        }),
      downloadDir: join(env.HOME ?? home, 'Downloads'),
      // ---- profile 运维与启动检查（旧壳 commands.rs 的对应命令）----
      startupChecked: () => startupChecked,
      markStartupChecked: () => {
        startupChecked = true
      },
      freshInstall: () => loaded.created,
      profileHealth: (profile) => profileHealth(home, profile),
      setPendingProfile: (profile) => {
        pendingProfile = profile
      },
      takePendingProfile: () => {
        const pending = pendingProfile
        pendingProfile = null
        return pending
      },
      confirmStartupProfile: async (profile, repair) => {
        // 旧壳顺序：先按需修复，再把该 profile 交给服务面（pending 由前端取回后自己落盘）
        if (repair) await rebuildProfileDependencies(profile)
        saveSettings({ active_profile: profile })
        if (profile !== paths.profile) await options.onOpenProfileWindow?.(profile)
      },
      runningPortOfProfile: async (profile) => {
        const claims = pruneClaims(parseClaims(await readClaims()), isAlivePid)
        const hit = claimFor(claims, profile)
        return hit === undefined ? null : hit.port
      },
      rebuildProfile: rebuildProfileDependencies,
      migrateProfile: async (source, dest, overwrite) => {
        const next = await migrateProfile({
          home,
          source,
          dest,
          overwrite,
          activeProfile: paths.profile,
          install: () =>
            installProfileDependencies({
              home,
              profile: dest,
              appSupport: paths.appSupport,
              runtimeRoot: paths.runtimeDir,
              env: childEnv,
              preferOffline: true,
              log,
            }),
          log,
          track: taskTracker,
        })
        return next
      },
      migrationStatus: () => taskTracker.migrationStatus(),
      testProxy: (url) => testProxyConnectivity(url),
      guests: options.guests,
      updater,
      dependencyRows: async () => {
        const builtinPnpm = builtinPnpmVersion({
          env: childEnv,
          runtimeRoot: paths.runtimeDir,
          appSupport: paths.appSupport,
        })
        const claimed = pruneClaims(parseClaims(await readClaims()), isAlivePid)
        return profileDependencyRows({
          home,
          profiles: listProfiles(home, paths.profile),
          builtinPnpm,
          running: (name) => claimFor(claimed, name) !== undefined,
        })
      },
      taskStatus: () => taskTracker.status(),
      zoomToggle: () => options.onZoomToggle?.(),
      inputConfirm: (flow, value) => options.onInputConfirm?.(flow, value),
      keybindings: {
        read: () => readKeybindings(home),
        write: (raw) => writeKeybindings(home, raw),
      },
      // #136：启动更新提醒的开关与拉黑列表（落 app-support/update-notice.json，不动设置键名）
      updateNotice: updateNoticeStore,
      // 面板展示与真实注入同源：一样走 scutil / 注册表 / 环境变量三级检测。
      proxyEffective: () => resolveProxyEnv(liveSettings, detectSystemProxy({ platform: process.platform, env: childEnv, log })),
    }),
  )
  return service
}
