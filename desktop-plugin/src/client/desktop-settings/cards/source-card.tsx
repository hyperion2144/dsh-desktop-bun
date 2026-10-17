// 「dsh 来源」卡：面板在跑的是哪棵树、内置是哪版。
// 自带探测与刷新，不依赖面板任何状态——这是它能独立成文件的原因。
import React, { useCallback, useEffect, useState } from 'react'
import { PfBtn, SectionBox } from '../chrome.tsx'
import { DANGER_NOTE_STYLE, NOTE_STYLE } from '../styles.ts'
import { invoke } from '../rpc.ts'
import type { DshSourceState } from '../types.ts'

export function SourceCard(): React.ReactElement {
  const [sourceState, setSourceState] = useState<DshSourceState | null>(null)
  const [sourceError, setSourceError] = useState<string | null>(null)

  const refreshSource = useCallback(async (): Promise<void> => {
    setSourceError(null)
    try {
      const s = await invoke<DshSourceState>('get_dsh_source')
      setSourceState(s)
    } catch (err) {
      setSourceError(String(err))
    }
  }, [])

  useEffect(() => {
    void refreshSource()
  }, [refreshSource])

  const sourceInfoText = ((): string => {
    if (!sourceState) return ''
    const parts: string[] = []
    if (sourceState.running) {
      const runVer = sourceState.running.version || (sourceState.builtin?.dsh_version ?? '')
      const origin = sourceState.running.origin === 'shell' ? '本壳 spawn' : '复用接入'
      parts.push(`当前运行：内置 dsh ${runVer}（${origin} · port ${sourceState.running.port}）`)
    } else {
      parts.push('当前无运行中的 dsh 实例；下次启动将使用内置树')
    }
    if (sourceState.builtin) parts.push(`内置可用：dsh ${sourceState.builtin.dsh_version}`)
    return parts.join(' · ')
  })()

  return (
    <SectionBox title="dsh 来源">
      {sourceState ? (
        <div style={NOTE_STYLE}>{sourceInfoText}</div>
      ) : sourceError ? (
        <div style={DANGER_NOTE_STYLE}>检测失败：{sourceError}</div>
      ) : (
        <div style={NOTE_STYLE}>检测中…</div>
      )}
      <div style={{ marginTop: 8 }}>
        <PfBtn variant="ghost" onClick={() => void refreshSource()}>重新检测</PfBtn>
      </div>
      <div style={NOTE_STYLE}>
        内置：随应用分发的 dsh 依赖树 + Node，直调内部启动接口（不依赖系统环境）。
      </div>
    </SectionBox>
  )
}
