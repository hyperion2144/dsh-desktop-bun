// 「日志与诊断」卡：一个按钮导出快照，用户报问题时直接发文件（#220）。
// 自带挂载读一次 + 导出结果，不碰面板其它状态。
import React, { useEffect, useState } from 'react'
import { PfBtn, SectionBox, showToast } from '../chrome.tsx'
import { LoggingSection } from './logging-controls.tsx'
import { NOTE_STYLE } from '../styles.ts'
import { invoke } from '../rpc.ts'

export function DiagnosticsCard(): React.ReactElement {
  const [diagSummary, setDiagSummary] = useState<string | null>(null)
  const [diagLogPath, setDiagLogPath] = useState<string | null>(null)
  const [diagExport, setDiagExport] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // 失败只当没有——诊断读取不该挡住设置面板
    void invoke<{ diagnostics?: { summary?: string; logs?: { shell?: { path?: string } } } }>('get_diagnostics')
      .then((r) => {
        if (cancelled) return
        const summary = r.diagnostics?.summary
        if (typeof summary === 'string' && summary !== '') setDiagSummary(summary)
        const path = r.diagnostics?.logs?.shell?.path
        if (typeof path === 'string' && path !== '') setDiagLogPath(path)
      })
      .catch((error: unknown) => {
        console.warn(`[dsh-desktop-tauriapp] 读取诊断快照失败：${String(error)}`)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <SectionBox title="日志与诊断">
      <div style={NOTE_STYLE}>{diagSummary === null ? '读取中…' : diagSummary}</div>
      {diagLogPath !== null && <div style={NOTE_STYLE}>壳日志：{diagLogPath}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <PfBtn
          variant="ghost"
          onClick={() => {
            void invoke<{ path: string; bytes: number }>('export_diagnostics')
              .then((r) => {
                setDiagExport(r.path)
                showToast(`诊断已导出：${r.path}`, true)
              })
              .catch((e: unknown) => showToast(`导出失败：${String(e)}`, false))
          }}
        >
          导出诊断
        </PfBtn>
        <PfBtn
          variant="ghost"
          onClick={() => {
            void invoke<{ diagnostics?: { logs?: { shell?: { path?: string } } } }>('get_diagnostics')
              .then((r) => {
                const path = r.diagnostics?.logs?.shell?.path
                if (typeof path === 'string' && path !== '') showToast(`壳日志：${path}`, true)
                else showToast('诊断里没有日志路径', false)
              })
              .catch((e: unknown) => showToast(`读取失败：${String(e)}`, false))
          }}
        >
          显示日志路径
        </PfBtn>
      </div>
      {diagExport !== null && <div style={NOTE_STYLE}>上次导出：{diagExport}</div>}
            {/* #221 统一日志管理：级别 / 保留与清理 / 导出（子区段共用本卡唯一 SectionBox，M1） */}
            <LoggingSection />
        </SectionBox>
    )
}
