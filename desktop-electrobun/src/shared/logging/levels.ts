/**
 * 日志级别词表（纯逻辑，零 IO）——统一日志内核的级别语义（#224 Decision v2 第 2 条）。
 *
 * 全局单档四值（debug/info/warn/error，默认 info）：设置卡一处切换、进程级持有者一处存储、
 * 写日志热路径直读。级别只控**写盘**，stdout console 镜像行为维持现状——排障时在 dev 终端
 * 仍然什么都能看到，只有落盘的行会随级别抬高而严格退出。
 */

/** 全局日志级别（四档，从严到松：error > warn > info > debug）。 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** 级别序：数值越大越严重；`shouldLog` 拿它做「>= 阈值才落盘」的比较。 */
export const LOG_LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** 默认档（#224 Decision 6）：存量用户升级后写盘量只减不增，debug 行静下来属预期（UI 有说明）。 */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info'

/** 归一化：白名单外的值一律当「没设置」（对齐 settings.ts 的 oneOf 规矩，不猜不抛）。 */
export function normalizeLogLevel(value: unknown): LogLevel | undefined {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (LOG_LEVELS as readonly string[]).includes(candidate) ? (candidate as LogLevel) : undefined
}

/** 严格语义：级别 >= 阈值才写盘（抬高后低级别行严格退出，切回 debug 实时找回）。 */
export function shouldLog(level: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[threshold]
}

/**
 * 页面五档 → 全局四档（#224 Decision 2：映射收在分类函数一处）。
 * 页面的 `log` 是普通输出 ⇒ info；其余逐一对应。
 */
export function pageLevelToLogLevel(level: 'error' | 'warn' | 'info' | 'debug' | 'log'): LogLevel {
  return level === 'log' ? 'info' : level
}

/**
 * 宿主流二分（#224 Decision 2）：stderr ⇒ error、stdout ⇒ info。
 * 宿主行没有可信的级别语义，不做关键字启发式；UI 把它标注为推断值。
 */
export function hostStreamLogLevel(stream: 'stdout' | 'stderr'): LogLevel {
  return stream === 'stderr' ? 'error' : 'info'
}
/** 级别字面量标签：写盘行格式 `<时间戳> [来源] [级别] 消息` 的第二段。 */
export const LEVEL_TAGS: Record<LogLevel, string> = {
  debug: '[debug]',
  info: '[info]',
  warn: '[warn]',
  error: '[error]',
}

/**
 * 分级日志接口（用户 2026-10-21 拍板：调用点按级别选方法、支持结构化参数，
 * 格式化发生在调用时——内核写路径不做任何字符串转换）。
 */
export interface Logger {
  debug(message: string, ...args: readonly unknown[]): void
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
  error(message: string, ...args: readonly unknown[]): void
}

const FORMAT_SPECIFIER = /%[sdifjoO%]/g

/** 结构化值序列化：Error → `Name: message`；对象/数组单行展开（防环、限深 4）。 */
export function serializeLogValue(value: unknown, depth = 0, seen?: Set<object>): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (typeof value === 'function' || typeof value === 'symbol') return value.toString()
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (value instanceof Date) return value.toISOString()
  if (depth >= 4 || typeof value !== 'object') return String(value)
  const visited = seen ?? new Set<object>()
  if (visited.has(value as object)) return '[Circular]'
  visited.add(value as object)
  try {
    if (Array.isArray(value)) return `[${value.map((item) => serializeLogValue(item, depth + 1, visited)).join(', ')}]`
    if (value instanceof Map) return serializeLogValue(Object.fromEntries(value), depth + 1, visited)
    if (value instanceof Set) return serializeLogValue([...value], depth + 1, visited)
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${key}: ${serializeLogValue(item, depth + 1, visited)}`,
    )
    return `{ ${entries.join(', ')} }`
  } finally {
    visited.delete(value as object)
  }
}

/**
 * 结构化消息格式化（console 风格占位符）：`%s` 字符串、`%d`/`%i` 整数、`%f` 数值、
 * `%o`/`%j` 序列化值、`%%` 字面量 `%`；占位符耗尽后的多余参数以空格追加序列化。
 */
export function formatMessage(message: string, args: readonly unknown[]): string {
  if (args.length === 0) return message
  let index = 0
  const formatted = message.replace(FORMAT_SPECIFIER, (specifier: string): string => {
    if (specifier === '%%') return '%'
    const arg = args[index++]
    if (arg === undefined) return specifier
    if (specifier === '%s') return serializeLogValue(arg)
    if (specifier === '%d' || specifier === '%i') {
      const numeric = Number(arg)
      return Number.isFinite(numeric) ? String(Math.trunc(numeric)) : String(numeric)
    }
    if (specifier === '%f') return String(Number(arg))
    return serializeLogValue(arg)
  })
  const rest = args.slice(index)
  if (rest.length === 0) return formatted
  return `${formatted} ${rest.map((arg) => serializeLogValue(arg)).join(' ')}`
}
