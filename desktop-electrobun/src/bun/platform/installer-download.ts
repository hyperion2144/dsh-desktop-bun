// 壳更新的「壳侧自管安装包下载器」（#235，三平台统一）。
//
// 为什么要有这个模块：Electrobun 框架的 Updater 链路两个硬伤——① download 一开始就校验
// 「应用必须住在受管更新目录（win/linux 硬编码 %LOCALAPPDATA%\<identifier>）」，#87 的
// 自定义安装目录必抛 `The running application is outside its managed update directory`；
// ② 它的进度回调在 macOS 实测不可靠（瞬间 100% 再回落、然后卡住不动，#235 实机报告）。
// 所以三平台都改走自管：直接从 Release 资产下载安装包（win=NSIS `*-setup.exe`、
// mac=DMG、linux=tar.gz），就绪后由用户点「安装」——win 运行安装器（记住上次安装目录，
// #87 的 UI 正常模式）、mac 挂载 DMG（用户拖拽进 Applications）、linux 打开所在文件夹
// （用户解压替换安装目录）。
//
// 模式照抄运行时下载器的既定约定（#97/#79/#139）：单飞（同时只有一个任务）、可取消、
// 进度落在一个可轮询的快照上、终态只有 ready/error/cancelled 三种。页面每 700ms 轮询
// `shell_update_status` 读它——壳算好百分比再递给页面，页面只负责画。
//
// 下载位置是壳指定的且路径可见（票面诉求 2）：`%LOCALAPPDATA%\DSHDesktopBun\updates\<version>\`
// （与安装器默认安装根同名，但它是壳的数据目录，不随用户在安装器里选的安装目录变）。
// 下载先落 `<asset>.part`，完整后原子改名——「正式名存在」即「下载完整」，`findReady()`
// 靠这一条实现「已下载未安装再开窗直接装」（票面诉求 3）。

import { existsSync, mkdirSync, renameSync, statSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import type { Logger } from '../../shared/logging/levels.ts'

/**
 * Release 资产里的安装包名，按平台（无版本号，`latest/download` 下名字稳定）。
 *
 * 名字的真源在发布链路，改动时三处同步：
 *   · 打包产物名（win：`scripts/build-windows-installer.mjs` 的 outFile；mac/linux：`hutch electrobun build` 产物）；
 *   · `scripts/release-publish.mjs` 的 INSTALLER_PATTERNS（发布资产名＝产物名）；
 *   · 本表（壳侧下载时拼 URL 用）。
 * 注意与清单前缀的平台词元不同：清单是 `win-x64`（stable-win-x64-update.json），
 * 安装包是 `windows-x64`（产物历史名）——不能从 prefix 拼出来；mac/linux 的资产名
 * 与清单前缀同形但独立维护，同样不从 prefix 拼。
 */
export const INSTALLER_ASSETS: Record<string, string> = {
  win32: 'windows-x64-DeepSeekHarnessDesktopBUN-setup.exe',
  darwin: 'macos-arm64-DeepSeekHarnessDesktopBUN.dmg',
  linux: 'linux-x64-DeepSeekHarnessDesktopBUN-Setup.tar.gz',
}

/** 覆盖安装包下载目录（测试与排障用；缺省见 `installerRootDir`）。 */
export const INSTALLER_DIR_ENV = 'DSH_SHELL_INSTALLER_DIR'

export type InstallerDownloadPhase = 'idle' | 'downloading' | 'ready' | 'error' | 'cancelled'

/** 下载器快照（`shell_update_status` 的数据源；字段语义与 RuntimeDownloadStatus 对齐）。 */
export interface InstallerDownloadStatus {
  active: boolean
  /** 目标版本（清单给的 latest；idle 时为空串）。 */
  version: string
  phase: InstallerDownloadPhase
  /** 0–100 整数；content-length 没到之前为 null（页面显示不确定动画）。 */
  percent: number | null
  bytesDownloaded: number
  totalBytes: number | null
  /** 就绪后的完整路径（壳自己知道路径，页面上直接展示——Q2 的「路径可见」）。 */
  filePath: string
  error: string
  cancelled: boolean
}

export interface InstallerStartInput {
  /** 更新源（清单的 baseUrl，与框架链路同源——DSH_SHELL_UPDATE_BASE_URL 覆盖照常生效）。 */
  baseUrl: string
  /** 目标版本（清单 version；目录按版本分，跨版本残留互不干扰）。 */
  version: string
}

export interface InstallerDownloader {
  /** 启动下载（单飞：已有任务或已就绪时抛错/幂等返回）。 */
  start(input: InstallerStartInput): Promise<void>
  status(): InstallerDownloadStatus
  cancel(): Promise<{ cancelled: boolean }>
  /** 对应版本的安装包是否已在本地就绪；在则返回完整路径，不在返回空串。 */
  findReady(version: string): string
  /**
   * 运行安装包（detached spawn；退出当前应用由调用方负责——用户点「安装」即确认）。
   * 优先用调用方从磁盘探到的路径（壳重启后内存态已丢，applyShell 的 findReady 就是这条），
   * 其次本次进程下载完的内存路径。
   */
  launch(overridePath?: string): Promise<void>
}

export interface InstallerDownloaderOptions {
  log: Logger
  env?: Record<string, string | undefined>
  /** 缺省 process.platform；三平台都有实质行为（launch 的动作按平台分叉）。 */
  os?: string
  /** 测试缝：注入假 fetch（返回 ReadableStream body 的 Response 即可全链路跑通）。窄签名——
   *  Bun 的全局 fetch 带额外属性（preconnect），按 `typeof fetch` 收会拒绝普通函数形态的假件。 */
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>
  /** 测试缝：注入假 spawn（launch 不真起进程）。 */
  spawnFn?: typeof spawn
}

/** 更新包根目录：优先显式覆盖，否则按平台的数据/缓存目录拼 `DSHDesktopBun/updates`。 */
export function installerRootDir(
  env: Record<string, string | undefined>,
  os: string = process.platform,
): string {
  const override = (env[INSTALLER_DIR_ENV] ?? '').trim()
  if (override !== '') return override
  if (os === 'win32') {
    const localAppData = (env['LOCALAPPDATA'] ?? '').trim()
    if (localAppData === '') return ''
    return join(localAppData, 'DSHDesktopBun', 'updates')
  }
  if (os === 'darwin') {
    // mac：Caches 放可再生文件（下载完就装，装完可删），不污染 Application Support。
    const home = (env['HOME'] ?? '').trim()
    if (home === '') return ''
    return join(home, 'Library', 'Caches', 'DSHDesktopBun', 'updates')
  }
  // linux：XDG_CACHE_HOME（缺省 ~/.cache）。
  const base = (env['XDG_CACHE_HOME'] ?? '').trim()
  const home2 = (env['HOME'] ?? '').trim()
  const root = base !== '' ? base : home2 !== '' ? join(home2, '.cache') : ''
  if (root === '') return ''
  return join(root, 'DSHDesktopBun', 'updates')
}

/** 拼安装包下载 URL（去尾斜杠；空 baseUrl 原样返回空串）。 */
export function installerUrl(baseUrl: string, os: string = process.platform): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed === '') return ''
  return `${trimmed}/${INSTALLER_ASSETS[os] ?? ''}`
}

/** 某版本的安装包落点（`<root>/<version>/<asset>`；root 为空返回空串）。 */
export function installerFilePath(
  root: string,
  version: string,
  os: string = process.platform,
): string {
  if (root === '' || version === '') return ''
  return join(root, version, INSTALLER_ASSETS[os] ?? '')
}

/** 空闲态（模块级共享：service 组装处在下载器缺席时也用同一个空快照）。 */
export function idleInstallerStatus(): InstallerDownloadStatus {
  return {
    active: false,
    version: '',
    phase: 'idle',
    percent: null,
    bytesDownloaded: 0,
    totalBytes: null,
    filePath: '',
    error: '',
    cancelled: false,
  }
}

export function createInstallerDownloader(options: InstallerDownloaderOptions): InstallerDownloader {
  const env = options.env ?? process.env
  const log = options.log
  const os = options.os ?? process.platform
  const fetchFn = options.fetchFn ?? fetch
  const spawnFn = options.spawnFn ?? spawn

  let status: InstallerDownloadStatus = idleStatus()
  let controller: AbortController | null = null

  function idleStatus(): InstallerDownloadStatus {
    return idleInstallerStatus()
  }

  function root(): string {
    return installerRootDir(env, os)
  }

  return {
    async start(input: InstallerStartInput): Promise<void> {
      if (status.active) throw new Error('已有安装包下载任务在进行中')
      if (input.baseUrl === '') throw new Error('没有更新源（release.baseUrl 未配置）')
      if (input.version === '') throw new Error('拿不到目标版本（先检查更新）')
      const file = installerFilePath(root(), input.version, os)
      if (file === '') {
        throw new Error(`拿不到安装包下载目录（${INSTALLER_DIR_ENV} 未设且平台缓存目录不可用）`)
      }
      // 已就绪直接幂等返回：重开窗再点「下载」不重下（票面诉求 3 的动作侧）。
      if (existsSync(file)) {
        status = {
          active: false,
          version: input.version,
          phase: 'ready',
          percent: 100,
          bytesDownloaded: statSync(file).size,
          totalBytes: statSync(file).size,
          filePath: file,
          error: '',
          cancelled: false,
        }
        log.info(`安装包已就绪，跳过下载：${file}`)
        return
      }
      const url = installerUrl(input.baseUrl, os)
      if (url === '') throw new Error('没有更新源（release.baseUrl 未配置）')
      const partFile = `${file}.part`
      const dir = dirname(file)
      mkdirSync(dir, { recursive: true })
      controller = new AbortController()
      status = {
        active: true,
        version: input.version,
        phase: 'downloading',
        percent: null,
        bytesDownloaded: 0,
        totalBytes: null,
        filePath: '',
        error: '',
        cancelled: false,
      }
      log.info(`开始下载安装包：${url} → ${partFile}`)
      // sink 提到 try 外：失败/取消路径必须先 end 再删 .part（Windows 上打开中的文件删不掉，
      // 否则 rmSync 抛错掩盖原始失败、status 还会卡在 downloading）。
      let sink: Bun.FileSink | null = null
      try {
        const response = await fetchFn(url, { signal: controller.signal })
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? '发布资产里没有安装包（HTTP 404）——发布链路可能漏传，请等下一个版本或手动下载'
              : `下载安装包失败：HTTP ${String(response.status)}`,
          )
        }
        const totalHeader = response.headers.get('content-length')
        const total = totalHeader === null ? null : Number.parseInt(totalHeader, 10)
        status.totalBytes = Number.isFinite(total) && total !== null && total > 0 ? total : null
        const body = response.body
        if (body === null) throw new Error('下载安装包失败：响应没有内容')
        rmSync(partFile, { force: true })
        sink = Bun.file(partFile).writer()
        const reader = body.getReader()
        for (; ;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value !== undefined) {
            await sink.write(value)
            status.bytesDownloaded += value.byteLength
          }
          status.percent =
            status.totalBytes !== null && status.totalBytes > 0
              ? Math.min(100, Math.max(0, Math.round((status.bytesDownloaded / status.totalBytes) * 100)))
              : null
        }
        await sink.end()
        sink = null
        const written = statSync(partFile).size
        if (status.totalBytes !== null && written !== status.totalBytes) {
          throw new Error(`安装包下载不完整（${String(written)}/${String(status.totalBytes)} 字节），请重试`)
        }
        renameSync(partFile, file)
        status = {
          active: false,
          version: input.version,
          phase: 'ready',
          percent: 100,
          bytesDownloaded: written,
          totalBytes: status.totalBytes,
          filePath: file,
          error: '',
          cancelled: false,
        }
        log.info(`安装包下载完成：${file}（${String(written)} 字节）`)
      } catch (error) {
        const aborted = controller.signal.aborted
        if (sink !== null) {
          // end 失败也吞掉：清理路径不许掩盖原始错误（#235 review）。
          try {
            await sink.end()
          } catch {
            /* 忽略：文件句柄已在坏状态 */
          }
          sink = null
        }
        const raw = error instanceof Error ? error.message : String(error)
        rmSync(partFile, { force: true })
        status = {
          active: false,
          version: input.version,
          phase: aborted ? 'cancelled' : 'error',
          percent: null,
          bytesDownloaded: 0,
          totalBytes: null,
          filePath: '',
          error: aborted ? '安装包下载已取消' : raw,
          cancelled: aborted,
        }
        if (aborted) log.info('安装包下载已取消')
        else log.warn('安装包下载失败 %o', error)
        if (!aborted) throw new Error(raw, { cause: error })
      } finally {
        controller = null
      }
    },
    status() {
      return status
    },
    async cancel() {
      if (controller === null) return { cancelled: false }
      controller.abort()
      return { cancelled: true }
    },
    findReady(version: string): string {
      const file = installerFilePath(root(), version, os)
      if (file === '' || !existsSync(file)) return ''
      return file
    },
    async launch(overridePath?: string): Promise<void> {
      // 路径优先级：显式覆盖（applyShell 从磁盘 findReady 拿的，壳重启后内存态已丢）>
      // 本次进程下载完的内存态 > 无。
      const file =
        overridePath !== undefined && overridePath !== '' && existsSync(overridePath)
          ? overridePath
          : status.filePath !== '' && existsSync(status.filePath)
            ? status.filePath
            : ''
      if (file === '') throw new Error('安装包还没下载完成，无法安装')
      // detached：壳退出后安装器/打开动作继续跑；stdio ignore 免得挂在我们的管道上。
      // 三平台的「安装」动作：win=运行 NSIS 安装器；mac=挂载 DMG（Finder 弹拖拽窗）；
      // linux=tar.gz 没有安装器，打开所在文件夹（用户解压替换安装目录后重开应用）。
      const [cmd, args] =
        os === 'win32'
          ? [file, [] as string[]]
          : os === 'darwin'
            ? ['open', [file]]
            : ['xdg-open', [dirname(file)]]
      log.info(os === 'win32' ? `启动安装器：${file}` : `打开安装包：${file}`)
      const child = spawnFn(cmd, args, { detached: true, stdio: 'ignore' })
      child.unref?.()
    },
  }
}
