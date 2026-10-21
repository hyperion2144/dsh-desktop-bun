/**
 * 日志运维命令的 IO 层——list_log_files / clear_logs 的执行体。
 * 决策出处：#224 Decision v2 第 7/11 条；#232 命令契约（回执形状）。
 */

import { readdirSync, statSync, truncateSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ARCHIVE_DIR_NAME, parseArchiveFileName, type ArchiveRow } from '../../shared/logging/archive-plan.ts'
import type { LoggingKernel } from './kernel.ts'

export interface ClearLogsResult {
  removedFiles: number
  bytesFreed: number
}

/** 归档目录全量清单（带解析出来的内容日与序号；解析失败的文件跳过不报）。 */
export function listArchiveFiles(kernel: LoggingKernel): ArchiveRow[] {
  let names: string[]
  try {
    names = readdirSync(kernel.archiveDir)
  } catch {
    return []
  }
  const rows: ArchiveRow[] = []
  for (const name of names) {
    const parsed = parseArchiveFileName(name)
    if (parsed === null) continue
    try {
      const bytes = statSync(join(kernel.archiveDir, name)).size
      rows.push({ name, ...parsed, bytes })
    } catch {
      // 刚被并发清理掉的份直接跳过
    }
  }
  rows.sort((a, b) => (a.day === b.day ? a.seq - b.seq : a.day < b.day ? -1 : 1))
  return rows
}

/** clear_logs：清空归档 + 截断三个活跃文件（截断后继续写，路径与句柄都不动）。 */
export function clearAllLogs(kernel: LoggingKernel): ClearLogsResult {
  const receipt = kernel.clearLogs()
  return { removedFiles: receipt.removedFiles, bytesFreed: receipt.bytesFreed }
}

/** 删除归档目录下指定份（list→delete 之间可能已被清理并发移除，重删按不存在处理）。 */
export function deleteArchiveFile(kernel: LoggingKernel, name: string): { removed: boolean; bytes: number } {
  if (parseArchiveFileName(name) === null) throw new Error(`clear: 非归档命名，拒绝删除：${name}`)
  try {
    const bytes = statSync(join(kernel.archiveDir, name)).size
    unlinkSync(join(kernel.archiveDir, name))
    return { removed: true, bytes }
  } catch {
    return { removed: false, bytes: 0 }
  }
}

export const ARCHIVE_DIR = ARCHIVE_DIR_NAME
