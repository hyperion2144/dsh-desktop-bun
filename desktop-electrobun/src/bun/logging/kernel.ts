/**
 * 统一日志内核（IO 层）——#224 Decision v2 第 1/4/5/9/10/11 条的落地。
 *
 * 进程级唯一 sink + 进程级级别持有者：tee 单例与全部 per-profile 服务面 sink 共用同一个
 * 内核实例（懒创建单例，首调即锁配置），级别存实例字段，`applySettings` 热更新——
 * 设置卡切档不需要广播也不需要重启，所有写者的下一行立即生效（#128 范式）。
 *
 * 三活跃文件：shell.log / dsh-desktop-webview.log / shell-relay.log（路径与文件名是契约
 * 红线，永不变）；轮转产物 gzip 进 `$DSH_HOME/logs/archive/`，命名
 * `<源词干>-<内容起始日>-<当日序号>.log.gz`。relay 源只被内核**代管**（轮转/归档/保留/
 * 导出/快照），写入仍在 relay 进程——级别过滤不作用 relay（恒定落盘，语义视为 info）。
 *
 * IO 失败可感知（Decision 9）：写/转/删失败计数进 health，每目标每次会话首败在壳日志里
 * 写一条 `[logging]` 告警（壳日志自身失败降级 stderr，绝不递归）。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { LOG_MAX_BYTES, formatLogLine } from '../../shared/app/log-file.ts'
import {
  ARCHIVE_DIR_NAME,
  archiveFileName,
  localDayKey,
  parseArchiveFileName,
  parseIsoLineDay,
  parseLineDay,
  retentionPlan,
  type ArchiveRow,
} from '../../shared/logging/archive-plan.ts'
import {
  DEFAULT_LOG_LEVEL,
  LEVEL_TAGS,
  formatMessage,
  shouldLog,
  type Logger,
  type LogLevel,
} from '../../shared/logging/levels.ts'
import { dshHome } from '../runtime/runtime.ts'

export type LogSource = 'shell' | 'webview' | 'relay'
const SOURCES: readonly LogSource[] = ['shell', 'webview', 'relay']

/** 源词干（归档命名用；活跃文件名不变，词干取自文件名去扩展名）。 */
export const LOG_STEMS: Record<LogSource, string> = {
  shell: 'shell',
  webview: 'dsh-desktop-webview',
  relay: 'shell-relay',
}

export interface RetentionConfig {
  /** 保留天数（1–365，默认 14；只作用归档份）。 */
  maxDays: number
  /** 总量上限 MB（50–2000，默认 200；口径 = 归档合计 + 三个活跃文件）。 */
  maxTotalMb: number
}

export interface RetentionReceipt {
  removedFiles: number
  bytesFreed: number
}

export interface LogHealth {
  ioErrorCount: number
  lastIoError: string | null
}

export interface LoggingKernelOptions {
  home: string
  level?: LogLevel
  retention?: RetentionConfig
  /** 覆盖活跃文件路径（测试注临时目录；缺省按 $DSH_HOME 惯例拼）。 */
  files?: Partial<Record<LogSource, string>>
  now?: () => Date
  /** gzip 实现（缺省 Bun.gzipSync；测试可注入恒等以便直接读内容）。 */
  gzip?: (data: Uint8Array) => Uint8Array
  /** 启动迁移遗留 `*.log.1..9` 进归档（Decision 5；测试可关）。 */
  migrate?: boolean
  onRotate?: (info: { source: LogSource; archive: string; reason: 'day' | 'size' }) => void
}

export interface SourceFileStat {
  path: string
  bytes: number
  rotated: number
}

export interface ArchiveRowWithSource extends ArchiveRow {
  source: LogSource
}

export interface LogSinkAdapter {
  path: string
  line(message: string, level?: LogLevel): void
  write(text: string, level?: LogLevel): void
  tail(lines: number): string[]
}

export interface PageSinkAdapter {
  path: string
  /** 页面控制台一批行（已带 `[level] [page=…]` 前缀、无时间戳——行格式红线不动）。 */
  writeLines(lines: readonly string[], level: LogLevel): void
  tail(lines: number): string[]
}

/** 一次会话里已告警过的 IO 目标（每目标每次会话至多一条 `[logging]` 告警，Decision 9）。 */
interface KernelState {
  level: LogLevel
  retention: RetentionConfig
  settingsApplied: boolean
  health: LogHealth
  warnedTargets: Set<string>
  /** 每源的内容日记账（webview 行无戳，按写入日记账——复查 minor-6 口径）。 */
  days: Record<LogSource, string>
  sizes: Record<LogSource, number>
  statesReady: Record<LogSource, boolean>
}

export function createLoggingKernel(options: LoggingKernelOptions): LoggingKernel {
  const home = options.home
  const now = options.now ?? (() => new Date())
  const gzip = options.gzip ?? ((data: Uint8Array) => Bun.gzipSync(data as unknown as Uint8Array<ArrayBuffer>))
  const files: Record<LogSource, string> = {
    shell: options.files?.shell ?? join(home, 'shell.log'),
    webview: options.files?.webview ?? join(home, 'dsh-desktop-webview.log'),
    relay: options.files?.relay ?? join(home, 'shell-relay.log'),
  }
  const archiveDir = join(home, 'logs', ARCHIVE_DIR_NAME)
  const state: KernelState = {
    level: options.level ?? DEFAULT_LOG_LEVEL,
    retention: options.retention ?? { maxDays: 14, maxTotalMb: 200 },
    settingsApplied: false,
    health: { ioErrorCount: 0, lastIoError: null },
    warnedTargets: new Set(),
    days: { shell: '', webview: '', relay: '' },
    sizes: { shell: 0, webview: 0, relay: 0 },
    statesReady: { shell: false, webview: false, relay: false },
  }

  const rotateListeners: Array<(info: { archive: string; reason: string }) => void> = []
  const loggers = new Map<string, Logger>()
  // ---- 基础 IO 工具（全部失败都走 reportIoFailure，不再 catch{} 静默）----

  function reportIoFailure(target: LogSource, op: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    state.health.ioErrorCount += 1
    state.health.lastIoError = `${target}.${op}: ${message}`
    if (state.warnedTargets.has(target)) return
    state.warnedTargets.add(target)
    const line = `[logging] [warn] 日志 ${target} 源 ${op} 失败（本次会话仅告警一次）：${message}`
    if (target === 'shell') {
      // 壳日志自己写不进去：降级 stderr，绝不递归（Decision 9）
      console.error(formatLogLine(line, now()))
      return
    }
    try {
      appendFileSync(files.shell, `${formatLogLine(line, now())}\n`)
    } catch {
      console.error(formatLogLine(line, now()))
    }
  }

  /** 显式分级的壳行写入口（logger 工厂与 shellSink 适配共用）：调用时格式化，不做行内前缀解析。 */
  function writeShellLineInner(source: string, level: LogLevel, message: string, args: readonly unknown[]): void {
    if (!shouldLog(level, state.level)) return
    const text = args.length === 0 ? message : formatMessage(message, args)
    maybeRotateBeforeWrite('shell', Buffer.byteLength(text) + 32)
    appendSafe('shell', `${formatLogLine(`[${source}] ${LEVEL_TAGS[level]} ${text}`, now())}\n`)
  }

  function todayKey(): string {
    return localDayKey(now())
  }

  function ensureArchiveDir(): boolean {
    try {
      mkdirSync(archiveDir, { recursive: true })
      return true
    } catch (error) {
      reportIoFailure('shell', 'archive-mkdir', error)
      return false
    }
  }

  /** 文件首行所属内容日：shell 本地戳、relay ISO 戳、webview 无戳退 mtime 日（Decision 5 口径）。 */
  function contentDayOfFile(source: LogSource): string {
    const file = files[source]
    try {
      if (existsSync(file)) {
        const head = readFileSync(file, 'utf8').slice(0, 4096)
        const firstLine = head.split('\n', 1)[0] ?? ''
        const day =
          source === 'shell'
            ? parseLineDay(firstLine)
            : source === 'relay'
              ? parseIsoLineDay(firstLine)
              : null
        if (day !== null) return day
        return localDayKey(statSync(file).mtime)
      }
    } catch (error) {
      reportIoFailure(source, 'content-day', error)
    }
    return todayKey()
  }

  function ensureState(source: LogSource): void {
    if (state.statesReady[source]) return
    state.statesReady[source] = true
    try {
      state.sizes[source] = existsSync(files[source]) ? statSync(files[source]).size : 0
    } catch (error) {
      state.sizes[source] = 0
      reportIoFailure(source, 'stat', error)
    }
    state.days[source] = contentDayOfFile(source)
  }

  function archiveRows(): ArchiveRowWithSource[] {
    const rows: ArchiveRowWithSource[] = []
    try {
      for (const name of readdirSync(archiveDir)) {
        const parsed = parseArchiveFileName(name)
        if (parsed === null) continue
        const source = (Object.keys(LOG_STEMS) as LogSource[]).find((key) => LOG_STEMS[key] === parsed.stem)
        if (source === undefined) continue
        let bytes = 0
        try {
          bytes = statSync(join(archiveDir, name)).size
        } catch (error) {
          reportIoFailure(source, 'archive-stat', error)
        }
        rows.push({ source, name, day: parsed.day, seq: parsed.seq, bytes })
      }
    } catch (error) {
      // 归档目录不存在视作空台账（首次启动常态）；其它错误照常上报
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reportIoFailure('shell', 'archive-list', error)
    }
    return rows
  }

  function nextSeq(stem: string, day: string): number {
    let max = 0
    for (const row of archiveRows()) {
      if (parseArchiveFileName(row.name)?.stem !== stem) continue
      if (row.day !== day) continue
      if (row.seq > max) max = row.seq
    }
    return max + 1
  }

  function activeBytes(): number {
    let total = 0
    for (const source of SOURCES) {
      try {
        if (existsSync(files[source])) total += statSync(files[source]).size
      } catch (error) {
        reportIoFailure(source, 'active-stat', error)
      }
    }
    return total
  }

  /**
   * 轮转：活跃文件**原子改名**进归档目录（同卷 rename），gzip 后落到
   * `<stem>-<内容起始日>-<当日序号>.log.gz`，失败把活跃文件改回去、写盘照旧（Decision 12）。
   */
  function rotate(source: LogSource, reason: 'day' | 'size'): void {
    ensureState(source)
    const file = files[source]
    if (!existsSync(file) || state.sizes[source] === 0) {
      // 空文件没有可归档的内容：只翻日记账
      state.days[source] = todayKey()
      state.sizes[source] = 0
      return
    }
    if (!ensureArchiveDir()) return
    const day = state.days[source]
    const stem = LOG_STEMS[source]
    const staging = join(archiveDir, `${stem}-rotating-${process.pid}.tmp`)
    try {
      renameSync(file, staging)
    } catch (error) {
      reportIoFailure(source, 'rotate-rename', error)
      state.sizes[source] = existsSync(file) ? statSync(file).size : 0
      return
    }
    const finalName = archiveFileName(stem, day, nextSeq(stem, day))
    try {
      const compressed = gzip(new Uint8Array(readFileSync(staging)))
      writeFileSync(join(archiveDir, finalName), compressed)
      rmSync(staging, { force: true })
    } catch (error) {
      reportIoFailure(source, 'rotate-gzip', error)
      try {
        renameSync(staging, file)
      } catch (restoreError) {
        reportIoFailure(source, 'rotate-restore', restoreError)
      }
      state.sizes[source] = existsSync(file) ? statSync(file).size : 0
      return
    }
    state.days[source] = todayKey()
    state.sizes[source] = 0
    for (const listener of rotateListeners) listener({ archive: finalName, reason })
    runRetention()
  }

  function maybeRotateBeforeWrite(source: LogSource, incomingBytes: number): void {
    ensureState(source)
    const today = todayKey()
    if (state.days[source] !== today) {
      rotate(source, 'day')
      return
    }
    if (state.sizes[source] + incomingBytes > LOG_MAX_BYTES) rotate(source, 'size')
  }

  function appendSafe(source: LogSource, text: string): void {
    try {
      appendFileSync(files[source], text)
      state.sizes[source] += Buffer.byteLength(text)
    } catch (error) {
      reportIoFailure(source, 'write', error)
    }
  }

  /** 遗留 `*.log.1..9` 一次性压缩迁入归档（Decision 5 升级迁移；内容日推不出用 mtime）。 */
  function migrateLegacyRotations(): void {
    let legacy: string[] = []
    try {
      legacy = readdirSync(home).filter((name) => /^(shell|dsh-desktop-webview)\.log\.\d+$/.test(name))
    } catch {
      return
    }
    if (legacy.length === 0) return
    if (!ensureArchiveDir()) return
    for (const name of legacy) {
      const source: LogSource = name.startsWith('shell.log.') ? 'shell' : 'webview'
      const sourcePath = join(home, name)
      try {
        const head = readFileSync(sourcePath, 'utf8').slice(0, 4096)
        const firstLine = head.split('\n', 1)[0] ?? ''
        const day = parseLineDay(firstLine) ?? localDayKey(statSync(sourcePath).mtime)
        const stem = LOG_STEMS[source]
        const finalName = archiveFileName(stem, day, nextSeq(stem, day))
        writeFileSync(join(archiveDir, finalName), gzip(new Uint8Array(readFileSync(sourcePath))))
        rmSync(sourcePath)
      } catch (error) {
        reportIoFailure(source, 'migrate', error)
      }
    }
  }

  function runRetention(): RetentionReceipt {
    sweepRelay()
    const rows = archiveRows()
    const plan = retentionPlan({
      archives: rows,
      activeBytes: activeBytes(),
      maxDays: state.retention.maxDays,
      maxTotalBytes: state.retention.maxTotalMb * 1_000_000,
      now: now(),
    })
    let removedFiles = 0
    let bytesFreed = 0
    for (const name of plan.delete) {
      const row = rows.find((entry) => entry.name === name)
      try {
        rmSync(join(archiveDir, name))
        removedFiles += 1
        bytesFreed += row?.bytes ?? 0
      } catch (error) {
        reportIoFailure(row?.source ?? 'shell', 'retention-delete', error)
      }
    }
    return { removedFiles, bytesFreed }
  }

  /** relay 源巡检：内核不写它，但大小超限 / 内容日已翻篇时要就地归档（Decision 10/11）。 */
  function sweepRelay(): void {
    ensureState('relay')
    if (!existsSync(files.relay) || state.sizes.relay === 0) return
    if (state.sizes.relay > LOG_MAX_BYTES) {
      rotate('relay', 'size')
      return
    }
    if (state.days.relay !== todayKey()) rotate('relay', 'day')
  }

  // ---- 对外 API ----

  const kernel: LoggingKernel = {
    home,
    archiveDir,
    files: () => ({ ...files }),

    level: () => state.level,

    health: () => ({ ...state.health }),

    applySettings(next: { logLevel?: LogLevel; logRetentionDays?: number; logMaxTotalMb?: number }): RetentionReceipt | null {
      const previous = { ...state.retention }
      if (next.logLevel !== undefined) state.level = next.logLevel
      if (next.logRetentionDays !== undefined) state.retention.maxDays = next.logRetentionDays
      if (next.logMaxTotalMb !== undefined) state.retention.maxTotalMb = next.logMaxTotalMb
      const firstApply = !state.settingsApplied
      state.settingsApplied = true
      // 触发时机（Decision 5）：启动时（首次 apply）与保留设置变更后；归档后另有 rotate 内的触发
      if (!firstApply && previous.maxDays === state.retention.maxDays && previous.maxTotalMb === state.retention.maxTotalMb) {
        return null
      }
      return runRetention()
    },

    /** 模块级 Logger 工厂：调用点按级别选方法、结构化参数在调用时格式化（用户拍板：重构而非包装）。 */
    logger(source: string): Logger {
      const cached = loggers.get(source)
      if (cached !== undefined) return cached
      const created: Logger = {
        debug: (message, ...args) => writeShellLineInner(source, 'debug', message, args),
        info: (message, ...args) => writeShellLineInner(source, 'info', message, args),
        warn: (message, ...args) => writeShellLineInner(source, 'warn', message, args),
        error: (message, ...args) => writeShellLineInner(source, 'error', message, args),
      }
      loggers.set(source, created)
      return created
    },

    writeShellLine(message: string, level?: LogLevel): void {
      writeShellLineInner('shell', level ?? 'info', message, [])
    },

    writeWebviewLines(lines: readonly string[], level: LogLevel): void {
      const kept = lines.filter((line) => shouldLog(level, state.level))
      if (kept.length === 0) return
      const text = `${kept.join('\n')}\n`
      maybeRotateBeforeWrite('webview', Buffer.byteLength(text))
      appendSafe('webview', text)
    },

    /** relay 壳侧写入口：级别过滤不作用（恒定落盘，语义视为 info）；写前巡检超限/翻篇（Decision 10）。 */
    writeRelayLine(text: string): void {
      sweepRelay()
      appendSafe('relay', text)
    },

    rotate,
    fileStat(source: LogSource): SourceFileStat {
      ensureState(source)
      let bytes = 0
      try {
        bytes = existsSync(files[source]) ? statSync(files[source]).size : 0
      } catch (error) {
        reportIoFailure(source, 'file-stat', error)
      }
      const stem = LOG_STEMS[source]
      const rotated = archiveRows().filter((row) => row.source === source).length
      return { path: files[source], bytes, rotated }
    },

    archiveRows,

    tailSource(source: LogSource, lines: number): string[] {
      if (lines <= 0) return []
      try {
        const content = existsSync(files[source]) ? readFileSync(files[source], 'utf8') : ''
        const all = content.split('\n')
        if (all[all.length - 1] === '') all.pop()
        return all.slice(-lines)
      } catch (error) {
        reportIoFailure(source, 'tail', error)
        return []
      }
    },

    runRetention,

    clearLogs(): RetentionReceipt {
      sweepRelay()
      let removedFiles = 0
      let bytesFreed = 0
      for (const row of archiveRows()) {
        try {
          rmSync(join(archiveDir, row.name))
          removedFiles += 1
          bytesFreed += row.bytes
        } catch (error) {
          reportIoFailure(row.source, 'clear-archive', error)
        }
      }
      for (const source of SOURCES) {
        ensureState(source)
        try {
          if (existsSync(files[source])) {
            bytesFreed += statSync(files[source]).size
            truncateSync(files[source], 0)
          }
          state.sizes[source] = 0
          state.days[source] = todayKey()
        } catch (error) {
          reportIoFailure(source, 'clear-active', error)
        }
      }
      return { removedFiles, bytesFreed }
    },

    shellSink(adapters?: { stdout?: (line: string) => void; onRotateLine?: (info: { archive: string; reason: string }) => void }): LogSinkAdapter {
      if (adapters?.onRotateLine !== undefined) {
        // 服务面要在日志里留痕；挂在 options.onRotate 之外再补一路（单例只吃一份 options）
        rotateListeners.push(adapters.onRotateLine)
      }
      return {
        path: files.shell,
        line(message: string, level?: LogLevel): void {
          const resolved = level ?? 'info'
          adapters?.stdout?.(formatLogLine(`[shell] ${LEVEL_TAGS[resolved]} ${message}`, now()).trimEnd())
          kernel.writeShellLine(message, resolved)
        },
        write(text: string, level?: LogLevel): void {
          kernel.writeShellLine(text, level)
        },
        tail(lines: number): string[] {
          return kernel.tailSource('shell', lines)
        },
      }
    },

    pageSink(): PageSinkAdapter {
      return {
        path: files.webview,
        writeLines(lines: readonly string[], level: LogLevel): void {
          kernel.writeWebviewLines(lines, level)
        },
        tail(lines: number): string[] {
          return kernel.tailSource('webview', lines)
        },
      }
    },
  }

  if (options.onRotate !== undefined) rotateListeners.push((info) => options.onRotate?.({ source: 'shell', archive: info.archive, reason: info.reason as 'day' | 'size' }))

  if (options.migrate !== false) migrateLegacyRotations()

  return kernel
}

export interface LoggingKernel {
  home: string
  /** `$DSH_HOME/logs/archive/`。 */
  archiveDir: string
  files(): Record<LogSource, string>
  level(): LogLevel
  health(): LogHealth
  /** 热切换入口：级别即时生效；保留阈值变更（或首次落设置）返回清理回执。 */
  applySettings(next: { logLevel?: LogLevel; logRetentionDays?: number; logMaxTotalMb?: number }): RetentionReceipt | null
  writeShellLine(message: string, level?: LogLevel): void
  /** 模块级 Logger：按级别方法 + 结构化参数（调用时格式化）。 */
  logger(source: string): Logger
  writeWebviewLines(lines: readonly string[], level: LogLevel): void
  /** relay 行落盘（壳侧写入口；级别过滤不作用，ISO 戳由调用方带；写前巡检轮转，Decision 10）。 */
  writeRelayLine(text: string): void
  fileStat(source: LogSource): SourceFileStat
  rotate(source: LogSource, reason: 'day' | 'size'): void
  archiveRows(): ArchiveRowWithSource[]
  tailSource(source: LogSource, lines: number): string[]
  runRetention(): RetentionReceipt
  clearLogs(): RetentionReceipt
  shellSink(adapters?: { stdout?: (line: string) => void; onRotateLine?: (info: { archive: string; reason: string }) => void }): LogSinkAdapter
  pageSink(): PageSinkAdapter
}

// ---- 进程级单例（首调锁配置；级别/保留走 applySettings 热更新）----

let singleton: LoggingKernel | null = null

export function loggingKernel(init?: LoggingKernelOptions): LoggingKernel {
  if (singleton === null) {
    singleton = createLoggingKernel(init ?? { home: dshHome(process.env) })
  }
  return singleton
}

/** 测试隔离口：仅测试用（生产代码禁止重置进程级单例）。 */
export function resetLoggingKernelForTests(): void {
  singleton = null
}
