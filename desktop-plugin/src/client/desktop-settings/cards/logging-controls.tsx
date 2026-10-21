
// 「日志与诊断」卡的日志管理区段（#221）：级别 / 保留与清理 / 导出日志 + 状态行。
// 卡结构约束（#225 复查 M1）：冻结断言要求每卡恰好一张 SectionBox，所以本文件只渲染
// 三个子区段（LABEL 式小标题），由 diagnostics-card 的那张 SectionBox 收留。
// 交互口径全部来自 #225 Decision 0–7：radio 切档即存、保留显式保存+清理回执、
// 导出 ThemeSelect+loading 防重、clear_logs 遮罩二次确认（30s 无操作自动退出）。
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { PfBtn, showToast } from '../chrome.tsx'
import { invokeCommand } from '../rpc.ts'
import { ThemeSelect } from '../../ui/theme-select.tsx'
import type { LogArchiveRow } from '../../../../../contracts/logging.ts'
import {
  DEV_TOOLS_ACTIONS_STYLE,
  DEV_TOOLS_BODY_STYLE,
  DEV_TOOLS_MODAL_STYLE,
  DEV_TOOLS_OVERLAY_STYLE,
  DEV_TOOLS_TITLE_STYLE,
  DANGER_NOTE_STYLE,
  INPUT_BASE_STYLE,
  NOTE_STYLE,
  RADIO_ROW_STYLE,
  RADIO_TEXT_STYLE,
  ROW_STYLE,
} from '../styles.ts'

const LOG_LEVEL_OPTIONS = [
  { value: 'debug', label: '调试 debug', detail: '最详细，排障时临时开' },
  { value: 'info', label: '信息 info', detail: '常规运行记录（默认）' },
  { value: 'warn', label: '警告 warn', detail: '只记警告与错误' },
  { value: 'error', label: '错误 error', detail: '只记错误' },
] as const
type LogLevelValue = (typeof LOG_LEVEL_OPTIONS)[number]['value']

const EXPORT_PRESETS = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'all', label: '全部' },
  { value: 'custom', label: '自定义范围' },
] as const
type ExportPreset = (typeof EXPORT_PRESETS)[number]['value']

/** #225 D5：清理确认约 30 秒无操作自动退出（仓内先例没有，本 feature 新增行为）。 */
const CONFIRM_AUTO_EXIT_MS = 30_000

const SUBTITLE_STYLE: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary,#e7eaf0)',
  margin: '14px 0 6px',
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/** 数字输入是文本框 + 保存时钳制（对齐 download-card 的路子，仓内不用 type=number）。 */
function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

interface LogFilesSnapshot {
  archive_dir: string
  level: string
  archives: LogArchiveRow[]
  active: Array<{ source: string; path: string; bytes: number; rotated: number }>
  health: { io_error_count: number; last_io_error: string | null }
}

export function LoggingSection(): React.ReactElement {
  // 设置初值：读侧走 get_desktop_settings_data 的 settings 段（snake_case wire 形状）。
  const [level, setLevel] = useState<LogLevelValue>('info')
  const [retentionDays, setRetentionDays] = useState('14')
  const [maxTotalMb, setMaxTotalMb] = useState('200')
  const [retentionNote, setRetentionNote] = useState<string | null>(null)
  // 现状快照：挂载拉一次，每次操作回执后刷新（#225 D6：状态行自动刷新，无独立刷新键）。
  const [snap, setSnap] = useState<LogFilesSnapshot | null>(null)
  // 导出：预设/自定义、loading 防重、上次回执行。
  const [preset, setPreset] = useState<ExportPreset>('7d')
  const [exportFrom, setExportFrom] = useState('')
  const [exportTo, setExportTo] = useState('')
  const [exporting, setExporting] = useState(false)
  const [lastExport, setLastExport] = useState<string | null>(null)
  // 清理：遮罩二次确认（Escape 取消 + 30s 自动退出）。
  const [clearConfirming, setClearConfirming] = useState(false)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback((): void => {
    void invokeCommand('list_log_files')
      .then((r) => setSnap(r))
      .catch(() => { }
      ) // 失败只当没有——读取不该挡住设置面板
  }, [])

  useEffect(() => {
    let cancelled = false
    void invokeCommand('get_desktop_settings_data')
      .then((r) => {
        if (cancelled) return
        const s = (r.settings ?? {}) as Record<string, unknown>
        const lv = typeof s.log_level === 'string' ? s.log_level : 'info'
        if (LOG_LEVEL_OPTIONS.some((o) => o.value === lv)) setLevel(lv as LogLevelValue)
        if (typeof s.log_retention_days === 'number') setRetentionDays(String(s.log_retention_days))
        if (typeof s.log_max_total_mb === 'number') setMaxTotalMb(String(s.log_max_total_mb))
      })
      .catch(() => { }
      )
    refresh()
    return () => {
      cancelled = true
    }
  }, [refresh])

  // 清理确认开着时：Escape = 取消；30s 无操作自动退出（#225 D5）。
  useEffect(() => {
    if (!clearConfirming) return
    clearTimerRef.current = setTimeout(() => setClearConfirming(false), CONFIRM_AUTO_EXIT_MS)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setClearConfirming(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current)
      window.removeEventListener('keydown', onKey)
    }
  }, [clearConfirming])

  /** 级别切档即存（radio 点选即写盘，热路径直读立即生效——文案不许出现「重启生效」）。
   * 存失败把 radio 拨回盘上那一档：停在没存上的值上比只给提示更误导（同 loopback 卡）。 */
  const saveLevel = (next: LogLevelValue): void => {
    const prev = level
    if (next === prev) return
    setLevel(next)
    void invokeCommand('save_desktop_settings', { patch: { log_level: next } })
      .then(() => {
        const label = LOG_LEVEL_OPTIONS.find((o) => o.value === next)?.label ?? next
        showToast(`日志级别已切到${label}（立即生效）`, true)
        refresh()
      })
      .catch((e: unknown) => {
        setLevel(prev)
        showToast(`保存失败，已回到原档位：${String(e)}`, false)
      })
  }

  /** 保留策略：显式「保存」按钮（区别于级别即存）；壳在 patch 动了阈值时同步清理一次并带回执。 */
  const saveRetention = (): void => {
    const days = clampInt(retentionDays, 1, 365, 14)
    const mb = clampInt(maxTotalMb, 50, 2000, 200)
    setRetentionDays(String(days))
    setMaxTotalMb(String(mb))
    void invokeCommand('save_desktop_settings', { patch: { log_retention_days: days, log_max_total_mb: mb } })
      .then((r) => {
        setRetentionNote(
          r.log_cleanup !== undefined
            ? `已保存；并按新阈值清理了 ${r.log_cleanup.removed_files} 份归档、释放 ${formatBytes(r.log_cleanup.bytes_freed)}`
            : '已保存',
        )
        refresh()
      })
      .catch((e: unknown) => showToast(`保存失败：${String(e)}`, false))
  }

  const confirmClearLogs = (): void => {
    setClearConfirming(false)
    void invokeCommand('clear_logs')
      .then((r) => {
        showToast(`已清理 ${r.removed_files} 份归档、释放 ${formatBytes(r.bytes_freed)}`, true)
        refresh()
      })
      .catch((e: unknown) => showToast(`清理失败：${String(e)}`, false))
  }

  /** 导出：预设或自定义范围；按钮 loading 防重（长任务期间不许重复点）。 */
  const runExport = (): void => {
    if (exporting) return
    if (preset === 'custom' && exportFrom === '') {
      showToast('自定义范围需要先选起始日期', false)
      return
    }
    setExporting(true)
    const args =
      preset === 'custom'
        ? ({ range: 'custom', from: exportFrom, ...(exportTo === '' ? {} : { to: exportTo }) } as const)
        : ({ range: preset } as const)
    void invokeCommand('export_log_range', args)
      .then((r) => {
        const approx = r.approximations.length > 0 ? `（${r.approximations.length} 个源为整文件近似）` : ''
        setLastExport(`${r.path}（${formatBytes(r.bytes)}）${approx}`)
        showToast(`日志已导出到所选目录，共 ${r.archives_included} 份归档入包`, true)
        refresh()
      })
      .catch((e: unknown) => showToast(`导出失败：${String(e)}`, false))
      .finally(() => setExporting(false))
  }

  const openLogDir = (): void => {
    void invokeCommand('list_log_files', { reveal: true })
      .then(() => showToast('已在文件管理器打开日志目录', true, 'info'))
      .catch((e: unknown) => showToast(`打开失败：${String(e)}`, false))
  }

  const activeTotal = snap?.active.reduce((sum, f) => sum + f.bytes, 0) ?? 0
  const archiveTotal = snap?.archives.reduce((sum, a) => sum + a.bytes, 0) ?? 0

  return (
    <>
      {/* ── 状态行（#225 D6：挂载拉取 + 操作回执后刷新；health 故障红字） ── */}
      <div style={NOTE_STYLE} data-desktop-settings="log-status">
        {snap === null
          ? '日志现状读取中…'
          : `当前级别：${snap.level} · 归档 ${snap.archives.length} 份 · ${formatBytes(archiveTotal)} · 活跃 ${snap.active.length} 文件 · ${formatBytes(activeTotal)}`}
      </div>
      {snap !== null && snap.health.io_error_count > 0 && (
        <div style={DANGER_NOTE_STYLE} data-desktop-settings="log-health">
          日志写入异常 {snap.health.io_error_count} 次
          {snap.health.last_io_error !== null ? `（最近：${snap.health.last_io_error}）` : ''}
        </div>
      )}

      {/* ── 区段一：日志级别（四选一 radio，切档即存） ── */}
      <div style={SUBTITLE_STYLE}>日志级别</div>
      {LOG_LEVEL_OPTIONS.map((opt) => (
        <label key={opt.value} style={RADIO_ROW_STYLE}>
          <input
            type="radio"
            name="log-level"
            data-desktop-settings={`log-level-${opt.value}`}
            checked={level === opt.value}
            onChange={() => saveLevel(opt.value)}
          />
          <span style={RADIO_TEXT_STYLE}>
            {opt.label}
            <span style={{ color: 'var(--dsw-alias-label-secondary,#9aa4b2)', marginLeft: 8 }}>{opt.detail}</span>
          </span>
        </label>
      ))}
      <div style={NOTE_STYLE}>级别只影响写盘详细程度，切换立即生效（无需重启）；调高后低级别行立刻不再落盘，切回即可找回。</div>

      {/* ── 区段二：保留与清理（数字输入 + 显式保存；保存即按新阈值清理一次） ── */}
      <div style={SUBTITLE_STYLE}>保留与清理</div>
      <div style={ROW_STYLE} data-desktop-settings="log-retention-fields">
        <label style={ROW_STYLE}>
          <span style={{ fontSize: 12 }}>保留天数（1–365）</span>
          <input
            style={{ ...INPUT_BASE_STYLE, width: 72 }}
            inputMode="numeric"
            data-desktop-settings="log-retention-days"
            value={retentionDays}
            onChange={(e) => setRetentionDays(e.target.value)}
          />
        </label>
        <label style={ROW_STYLE}>
          <span style={{ fontSize: 12 }}>总大小上限 MB（50–2000）</span>
          <input
            style={{ ...INPUT_BASE_STYLE, width: 72 }}
            inputMode="numeric"
            data-desktop-settings="log-max-total-mb"
            value={maxTotalMb}
            onChange={(e) => setMaxTotalMb(e.target.value)}
          />
        </label>
        <PfBtn variant="ghost" onClick={saveRetention} testId="log-retention-save">
          保存
        </PfBtn>
      </div>
      {retentionNote !== null && <div style={NOTE_STYLE}>{retentionNote}</div>}
      <div style={{ ...ROW_STYLE, marginTop: 8 }} data-desktop-settings="log-clear-actions">
        <PfBtn variant="ghost" onClick={openLogDir} testId="log-open-dir">
          打开日志目录
        </PfBtn>
        <PfBtn variant="danger" onClick={() => setClearConfirming(true)} testId="log-clear">
          一键清理日志
        </PfBtn>
      </div>
      <div style={NOTE_STYLE}>保留策略超限时自动删最旧归档（只清归档目录，不碰活跃文件）；「一键清理」额外截断活跃日志，需要二次确认。</div>

      {/* ── 区段三：导出日志（预设 + 自定义范围；tar.gz 单包落所选目录） ── */}
      <div style={SUBTITLE_STYLE}>导出日志</div>
      <div style={ROW_STYLE}>
        <div style={{ width: 180 }} data-desktop-settings="log-export-preset">
          <ThemeSelect
            value={preset}
            options={EXPORT_PRESETS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(v) => setPreset(v as ExportPreset)}
          />
        </div>
        {preset === 'custom' && (
          <>
            <input
              type="date"
              style={INPUT_BASE_STYLE}
              data-desktop-settings="log-export-from"
              value={exportFrom}
              onChange={(e) => setExportFrom(e.target.value)}
            />
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary,#9aa4b2)' }}>至</span>
            <input
              type="date"
              style={INPUT_BASE_STYLE}
              data-desktop-settings="log-export-to"
              value={exportTo}
              onChange={(e) => setExportTo(e.target.value)}
            />
          </>
        )}
        <PfBtn variant="primary" disabled={exporting} onClick={runExport} testId="log-export-run">
          {exporting ? '导出中…' : '导出日志'}
        </PfBtn>
      </div>
      {lastExport !== null && <div style={NOTE_STYLE} data-desktop-settings="log-last-export">上次日志导出：{lastExport}</div>}
      <div style={NOTE_STYLE}>导出为 tar.gz 单包，按所选时间范围收集归档与活跃日志，落到你选的目录后自动打开所在位置。页面日志无时间戳，以整文件方式近似收录。</div>

      {/* ── 清理二次确认遮罩（#225 D5：红字后果 + danger 确认 + 30s 自动退出 + Escape 取消） ── */}
      {clearConfirming && (
        <div style={DEV_TOOLS_OVERLAY_STYLE}>
          <div style={DEV_TOOLS_MODAL_STYLE} data-desktop-settings="log-clear-confirm">
            <div style={DEV_TOOLS_TITLE_STYLE}>清理全部日志？</div>
            <div style={DEV_TOOLS_BODY_STYLE}>
              将清空归档目录中的全部 .gz 归档，并把三个活跃日志文件（shell / 页面 / relay）截断为空。
              <br />
              截断后壳会继续写入新日志，但被清掉的内容不可恢复。约 30 秒无操作自动取消。
            </div>
            <div style={DEV_TOOLS_ACTIONS_STYLE}>
              <PfBtn variant="ghost" onClick={() => setClearConfirming(false)}>
                取消
              </PfBtn>
              <PfBtn variant="danger" onClick={confirmClearLogs}>
                确认清理
              </PfBtn>
            </div>
          </div>
        </div>
      )}
    </>
  )
}