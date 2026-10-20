/**
 * 日志导出（IO 层）——#224 Decision v2 第 3 条：tar.gz 单包、包内按日志源分文件。
 *
 * 时间过滤口径：
 *   - 归档份按文件名**内容日**整体进出，`from` 端向前多捞 1 天兜跨天轮转的边界；
 *   - 壳活跃文件按行首本地时间戳逐行过滤，解析不出时间的行保留；
 *   - relay 活跃文件按行首 ISO 戳逐行过滤（同规则）；
 *   - webview 活跃文件为**整文件近似**（页面日志行无时间戳，红线禁改格式），manifest 注明。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  offsetDayKey,
  parseIsoLineDay,
  parseLineDay,
  pickArchivesForRange,
  type ExportRange,
} from '../../shared/logging/archive-plan.ts'
import { buildTar, type TarEntry } from '../../shared/logging/tar.ts'
import { LOG_STEMS, type LoggingKernel } from './kernel.ts'

export interface ExportLogsInput {
  kernel: LoggingKernel
  destDir: string
  range: ExportRange
  now: Date
  gzip?: (data: Uint8Array) => Uint8Array
}

export interface ExportLogsResult {
  path: string
  bytes: number
  /** 近似口径说明（当前只有 webview 整文件近似会给出）。 */
  approximations: string[]
  archivesIncluded: number
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

/** 导出包名：`dsh-logs-YYYYMMDD-HHmmss.tar.gz`（本地时区，与诊断导出同风格）。 */
export function exportLogsFileName(now: Date): string {
  const date = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `dsh-logs-${date}-${time}.tar.gz`
}

function filterLinesByDay(content: string, range: ExportRange, parse: (line: string) => string | null): string {
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const kept = lines.filter((line) => {
    const day = parse(line)
    // 解析不出时间的行保留（Decision 3：无法解析 ⇒ 保留，宁可多给不给少）
    if (day === null) return true
    if (range.from !== undefined && day < range.from) return false
    if (range.to !== undefined && day > range.to) return false
    return true
  })
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`
}

export function exportLogRange(input: ExportLogsInput): ExportLogsResult {
  const { kernel } = input
  const gzip = input.gzip ?? ((data: Uint8Array) => Bun.gzipSync(data as unknown as Uint8Array<ArrayBuffer>))
  const approximations: string[] = []
  const entries: TarEntry[] = []

  // 1) 归档份：按内容日整体进出（from 向前多捞 1 天）
  const rows = kernel.archiveRows()
  const picked = pickArchivesForRange(rows, input.range)
  for (const row of picked) {
    try {
      entries.push({ name: `archive/${row.name}`, data: new Uint8Array(readFileSync(join(kernel.archiveDir, row.name))) })
    } catch {
      // 单份读不到不炸整个导出（可能刚被并发清理）；manifest 数量对得上即可
    }
  }

  // 2) 活跃文件：壳按行首戳逐行；webview 整文件近似；relay 按 ISO 戳逐行
  const shellPath = kernel.files().shell
  if (existsSync(shellPath)) {
    const filtered = filterLinesByDay(readFileSync(shellPath, 'utf8'), input.range, parseLineDay)
    entries.push({ name: 'active/shell.log', data: new Uint8Array(Buffer.from(filtered, 'utf8')) })
  }
  const webviewPath = kernel.files().webview
  if (existsSync(webviewPath)) {
    entries.push({ name: 'active/dsh-desktop-webview.log', data: new Uint8Array(readFileSync(webviewPath)) })
    if (input.range.from !== undefined || input.range.to !== undefined) {
      approximations.push('active/dsh-desktop-webview.log 为整文件近似：页面日志行没有时间戳（行格式红线），无法按行过滤时间')
    }
  }
  const relayPath = kernel.files().relay
  if (existsSync(relayPath)) {
    const filtered = filterLinesByDay(readFileSync(relayPath, 'utf8'), input.range, parseIsoLineDay)
    entries.push({ name: 'active/shell-relay.log', data: new Uint8Array(Buffer.from(filtered, 'utf8')) })
  }

  // 3) manifest：把范围与近似口径写进包里，收到材料的人不用猜
  const manifest = {
    generatedAt: input.now.toISOString(),
    range: { from: input.range.from ?? null, to: input.range.to ?? null },
    archivesIncluded: picked.length,
    approximations,
    sources: Object.values(LOG_STEMS),
  }
  entries.push({ name: 'manifest.json', data: new Uint8Array(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')), mtime: input.now })

  const tar = buildTar(entries)
  const packed = gzip(tar)
  mkdirSync(input.destDir, { recursive: true })
  const path = join(input.destDir, exportLogsFileName(input.now))
  writeFileSync(path, packed)
  let bytes = packed.length
  try {
    bytes = statSync(path).size
  } catch {
    // stat 失败就用内存长度（写成功刚发生，概率极低）
  }
  return { path, bytes, approximations, archivesIncluded: picked.length }
}

/** 预设范围 → 日键区间（「今天」＝本地零点；7d/30d 含今天在内往前数 N 天）。 */
export function resolveRangePreset(preset: 'today' | '7d' | '30d' | 'all' | 'custom', from: string | undefined, to: string | undefined, now: Date): ExportRange {
  const today = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case '7d':
      return { from: offsetDayKey(today, -6), to: today }
    case '30d':
      return { from: offsetDayKey(today, -29), to: today }
    case 'custom': {
      if (from === undefined || from === '') throw new Error('export_log_range: 自定义范围需要 from（YYYY-MM-DD 或 YYYYMMDD）')
      const normalizedFrom = from.replaceAll('-', '')
      const normalizedTo = to === undefined || to === '' ? normalizedFrom : to.replaceAll('-', '')
      return { from: normalizedFrom, to: normalizedTo }
    }
    case 'all':
    default:
      return {}
  }
}
