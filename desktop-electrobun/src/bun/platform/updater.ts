/**
/**
 * 应用更新的 IO 层（#235：**壳侧全自管**，不再依赖 Electrobun 框架 Updater）。
 *
 * 框架链路的三个硬伤（ADR-0014）：
 *   · win/linux「受管更新目录」校验对 #87 自定义安装位置一票否决；
 *   · mac 实测进度回调不可靠（瞬间 100% 再回落、然后卡住）；
 *   · dev 通道直接短路「updates disabled」，开发实例永远检查不到更新。
 *
 * 所以检查/下载/安装全部壳侧自己实现：check 自己 fetch 发布清单（`stable-<os>-<arch>-update.json`，
 * 发布链 `release-publish.mjs` 的产物，`DSH_SHELL_UPDATE_BASE_URL` 可指向本地静态目录自测）；
 * 下载/安装走自管安装包下载器（`installer-download.ts`，在 host/service.ts 组装）。
 *
 * 不可用的两种正当理由，都会原样写进视图让用户看见：
 *   · 更新源没配（`release.baseUrl` 为空）；
 *   · 被 `DSH_SHELL_DISABLE_UPDATER=1` 关掉。
 */

import {
  DEFAULT_UPDATE_BASE_URL,
  UPDATE_BASE_URL_ENV,
  UPDATE_DISABLE_ENV,
  classifyUpdateFailure,
  firstNonEmpty,
  platformPrefixOf,
  updateView,
  isNewerVersion,
  feedUrl,
  type LocalUpdateLike,
  type ReleasePresence,
  type RemoteUpdateLike,
  type StatusLike,
  type UpdateView,
  updateActions,
  type UpdateActions,
} from '../../shared/runtime/update.ts'
import { probeReleasePresence } from './release-probe.ts'
import { resolveAppVersion } from './app-version.ts'
import { type Logger } from '../../shared/logging/levels.ts'

/** 壳侧自管清单用的通道前缀：发布链只发 stable（桌面独占 latest），dev 实例也查它。 */
const SELF_MANAGED_CHANNEL = 'stable'

/** 发布清单条目（`release-publish.mjs` 写出的结构；壳侧只取需要的字段）。 */
export interface ShellUpdateManifest {
  version?: string
  hash?: string
  channel?: string
  identifier?: string
}

/** 发布清单校验：只要求 version 是非空字符串（其余字段展示用，不强校验）。 */
export function validateShellManifest(document: unknown): ShellUpdateManifest {
  if (typeof document !== 'object' || document === null) {
    throw new Error('更新清单不是 JSON 对象')
  }
  const manifest = document as ShellUpdateManifest
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error('更新清单缺少 version 字段')
  }
  return manifest
}
export interface UpdaterSnapshot {
  available: boolean
  reason: string
  view: UpdateView
  /** 三个按钮能不能点，以及一句「为什么不能点」（客户端直接照这个渲染） */
  actions: UpdateActions
}

export interface ShellUpdater {
  available: boolean
  reason: string
  snapshot(): UpdaterSnapshot
  check(): Promise<UpdaterSnapshot>
  /** 启动时预热（读本地版本/解析更新源，只记日志不拖启动）。 */
  start(): void
  /** 壳退出收尾（自管实现无订阅，保留口子对齐旧接口）。 */
  stop(): void
}

export interface UpdaterOptions {
  log: Logger
  env?: Record<string, string | undefined>
  os?: string
  arch?: string
  /** 本地版本（缺省 resolveAppVersion()：DSH_SHELL_APP_VERSION 覆盖 → version.json）。 */
  currentVersion?: string
  /** 测试缝：注入假 fetch（清单拉取）。 */
  fetchFn?: typeof fetch
  /** 测试缝：注入假的「这个更新源背后有没有已发布的 Release」探测。 */
  probeRelease?: (baseUrl: string) => Promise<ReleasePresence>
  now?: () => number
}

/** `1`/`true`/`yes`/`on` 才算开（`0`/`false`/空串都不算）。 */
export function isFlagOn(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}


export function createUpdater(options: UpdaterOptions): ShellUpdater {
  const env = options.env ?? process.env
  const log = options.log
  const now = options.now ?? (() => Date.now())
  const os = options.os ?? process.platform
  const arch = options.arch ?? process.arch
  const fetchFn = options.fetchFn ?? globalThis.fetch
  // 清单前缀固定 stable：发布链（release-publish.mjs）只发 stable（桌面独占 latest），
  // dev 实例也查同一份清单——框架「dev 通道禁更新」的短路从此与我们无关。
  const prefix = platformPrefixOf({ buildEnv: SELF_MANAGED_CHANNEL, os: osName(os), arch: archName(arch) })

  let ready = false
  let local: LocalUpdateLike = {}
  let remote: RemoteUpdateLike = {}
  let status: StatusLike | undefined
  /** 壳侧检查/网络失败的**原始**文本（分类与中文说明交给 `updateView`）。 */
  let failure = ''
  /** 404 二义性判据：这个更新源背后有没有已发布的 Release。 */
  let releasePresence: ReleasePresence = 'unknown'
  let reason = ''
  let available = false

  function snapshot(): UpdaterSnapshot {
    const view = updateView({
      available,
      reason,
      prefix,
      local,
      remote,
      status,
      error: failure,
      releasePresence,
    })
    return { available, reason, view, actions: updateActions(view) }
  }

  function remember(raw: string, actionLabel: string): void {
    failure = raw
    log.warn(`${actionLabel}失败：${raw}`)
  }

  async function load(): Promise<void> {
    if (ready) return
    ready = true
    if (isFlagOn(env[UPDATE_DISABLE_ENV])) {
      reason = `更新被 ${UPDATE_DISABLE_ENV} 关掉了`
      log.debug(reason)
      return
    }
    // 本地版本自读（DSH_SHELL_APP_VERSION 覆盖 → version.json），不再依赖框架 getLocalInfo。
    const current = options.currentVersion ?? resolveAppVersion({ env })
    const override = env[UPDATE_BASE_URL_ENV]
    const baseUrl = override !== undefined && override !== '' ? override : DEFAULT_UPDATE_BASE_URL
    local = { version: current, channel: SELF_MANAGED_CHANNEL, baseUrl }
    available = baseUrl !== ''
    if (!available) {
      reason = `当前构建没有更新源（${UPDATE_BASE_URL_ENV} 与默认源都为空）`
      log.debug(reason)
      return
    }
    log.info(
      `更新源就绪：${current}（自管，通道=${SELF_MANAGED_CHANNEL}）→ ${baseUrl}` +
      (override !== undefined && override !== '' ? `（由 ${UPDATE_BASE_URL_ENV} 覆盖）` : ''),
    )
  }

  /** 探「这个更新源背后有没有已发布的 Release」（404 二义性靠它）。 */
  async function probeRelease(): Promise<ReleasePresence> {
    const base = local.baseUrl ?? ''
    if (base === '') return 'unknown'
    const probe = options.probeRelease ?? probeReleasePresence
    try {
      return await probe(base)
    } catch {
      return 'unknown'
    }
  }

  /** 拉发布清单并判可用性：壳侧自己的 check，失败写进视图不抛出。 */
  async function check(): Promise<UpdaterSnapshot> {
    await load()
    if (!available) return snapshot()
    const url = feedUrl(local.baseUrl ?? '', prefix)
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const manifest = validateShellManifest(await response.json())
      const latest = manifest.version ?? ''
      const current = local.version ?? ''
      // 本地版本读不到（'unknown'/空）时无法比较——不误报「可更新」，视图里的 current 如实显示。
      const comparable = current !== '' && current !== 'unknown'
      remote = {
        version: latest,
        hash: manifest.hash,
        // 自管口径：版本比较定可用性（框架的 hash 比对要求本地 hash 与清单同源，dev 实例对不上）。
        updateAvailable: comparable && isNewerVersion(latest, current),
        updateReady: false,
        error: '',
      }
      failure = ''
      // 框架词表里 check-complete 是「查完发现有更新」的中间态（phase→checking）；自管 check 的
      // 终态要按结果落 update-available / no-update，否则面板轮询永远显示「正在检查…」（PR #236 实测）。
      status = {
        status: remote.updateAvailable ? 'update-available' : 'no-update',
        message: `已检查：${latest}`,
        timestamp: now(),
      }
      log.info(`检查更新完成：${latest}（available=${String(remote.updateAvailable)}）`)
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      remember(raw, '检查更新')
      remote = {}
      status = { status: 'error', message: raw, timestamp: now() }
      if (classifyUpdateFailure(raw).kind === 'not-found') {
        // 404 有二义性：探一下这个更新源背后到底有没有已发布的 Release
        releasePresence = await probeRelease()
      }
    }
    return snapshot()
  }
  return {
    get available() {
      return available
    },
    get reason() {
      return reason
    },
    snapshot,
    check,
    start: () => {
      void load().then(() => {
        const current = snapshot()
        log.info(`状态：${current.view.label}（${current.view.current || '版本未知'}）`)
      })
    },
    stop: () => { },
  }
}

/** 框架用的 os 名是 `macos`/`win`/`linux`（`process.platform` 是 `darwin`/`win32`/`linux`）。 */
function osName(platform: string): string {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'win'
  return platform
}

function archName(arch: string): string {
  if (arch === 'x64') return 'x64'
  if (arch === 'arm64') return 'arm64'
  return arch
}
