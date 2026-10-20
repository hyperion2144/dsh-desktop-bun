/**
 * 归档命名 / 保留计划 / 导出选份（纯逻辑，零 IO）——#224 Decision v2 第 3/5/11 条。
 *
 * 归档命名（B2 修正）：`<源词干>-<内容起始日 YYYYMMDD>-<当日序号>.log.gz`。
 * 戳语义是**内容日**（该份第一行所属的本地日），不是轮转发生的时刻——跨天首写轮转会把
 * 前一日的份封进次日名字里，按轮转时刻命名会系统性错天。长静默期产出的横跨多天的份，
 * 归属它的首写日；导出按「区间向前多捞 1 天」兜这条边界。
 */

/** 归档目录名（挂在 `$DSH_HOME/logs/` 下，非 per-profile）。 */
export const ARCHIVE_DIR_NAME = 'archive'

/** 归档文件名：`<stem>-<YYYYMMDD>-<NN>.log.gz`。 */
export function archiveFileName(stem: string, day: string, seq: number): string {
  return `${stem}-${day}-${String(seq).padStart(2, '0')}.log.gz`
}

/** 归档文件名解析（对齐上面的拼装格式；非归档名返回 null）。 */
export function parseArchiveFileName(
  name: string,
): { stem: string; day: string; seq: number } | null {
  const match = /-(\d{8})-(\d{2})\.log\.gz$/.exec(name)
  if (match === null) return null
  return { stem: name.slice(0, match.index), day: match[1]!, seq: Number(match[2]) }
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** 本地时区日键 YYYYMMDD（「今天」＝本地零点，#224 Decision 12）。 */
export function localDayKey(now: Date): string {
  return `${String(now.getFullYear())}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`
}

/** 日键 → 本地零点。 */
export function dayKeyToDate(day: string): Date {
  return new Date(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)))
}

/** 日键偏移：`offsetDayKey('20260103', -1)` = '20260102'（导出向前多捞一天用）。 */
export function offsetDayKey(day: string, offsetDays: number): string {
  const date = dayKeyToDate(day)
  date.setDate(date.getDate() + offsetDays)
  return localDayKey(date)
}

/**
 * 壳日志行的本地时区时间戳（`YYYY-MM-DD HH:MM:SS.mmm`，log-file.ts formatStamp 同款）→ 行首日期。
 * 解析不出（页面行、外来行）返回 null——调用方按「保留」处理。
 */
export function parseLineDay(line: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) /.exec(line)
  if (match === null) return null
  return `${match[1]}${match[2]}${match[3]}`
}

/** relay 行的 ISO 戳（`2026-10-20T12:34:56.789Z [relay] …`）→ 行首日期。 */
export function parseIsoLineDay(line: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(line)
  if (match === null) return null
  return `${match[1]}${match[2]}${match[3]}`
}

/** 磁盘上一份归档的台账行（IO 层组装，纯逻辑只消费）。 */
export interface ArchiveRow {
  name: string
  day: string
  seq: number
  bytes: number
}

/** 保留清理的输入：归档台账 + 活跃文件合计字节 + 阈值。 */
export interface RetentionInput {
  archives: ArchiveRow[]
  /** 三个活跃文件合计字节（总量口径含活跃，#224 Decision 11）。 */
  activeBytes: number
  /** 保留天数（1–365；只作用归档份）。 */
  maxDays: number
  /** 总量上限字节（归档合计 + 活跃合计）。 */
  maxTotalBytes: number
  now: Date
}

/** 保留计划：删谁、留谁（调用方照单执行，纯逻辑不碰磁盘）。 */
export interface RetentionPlan {
  delete: string[]
  keep: string[]
}

/**
 * 保留计划（#224 Decision 11）：先按天数删过期归档（活跃文件不参与天数清理），
 * 再按总量删最旧（day 升序、seq 升序）直到 `归档合计 + activeBytes ≤ maxTotalBytes`。
 * 活跃文件只受大小超限轮转约束，永远不进 delete 名单。
 */
export function retentionPlan(input: RetentionInput): RetentionPlan {
  const today = localDayKey(input.now)
  const cutoff = offsetDayKey(today, -(Math.max(1, Math.round(input.maxDays)) - 1))
  const expired = input.archives.filter((row) => row.day < cutoff)
  const survivors = input.archives.filter((row) => row.day >= cutoff)
  const deleteNames = new Set(expired.map((row) => row.name))

  let total = input.activeBytes + survivors.reduce((sum, row) => sum + row.bytes, 0)
  const oldestFirst = [...survivors].sort((left, right) =>
    left.day === right.day ? left.seq - right.seq : left.day < right.day ? -1 : 1,
  )
  for (const row of oldestFirst) {
    if (total <= input.maxTotalBytes) break
    deleteNames.add(row.name)
    total -= row.bytes
  }
  return {
    delete: [...deleteNames],
    keep: input.archives.filter((row) => !deleteNames.has(row.name)).map((row) => row.name),
  }
}

/** 时间区间（本地时区日键，含端点；`from`/`to` 缺省表示不设界 =「全部」）。 */
export interface ExportRange {
  from?: string
  to?: string
}

/**
 * 导出选份（#224 Decision 3）：归档份按内容日整体进出；`from` 端**向前多捞 1 天**
 * 兜「跨天首写轮转把前一日内容封进次日份」的边界（B2）。无界的「全部」选一切归档。
 */
export function pickArchivesForRange(archives: ArchiveRow[], range: ExportRange): ArchiveRow[] {
  if (range.from === undefined && range.to === undefined) return [...archives]
  const from = range.from === undefined ? undefined : offsetDayKey(range.from, -1)
  return archives.filter((row) => {
    if (from !== undefined && row.day < from) return false
    if (range.to !== undefined && row.day > range.to) return false
    return true
  })
}
