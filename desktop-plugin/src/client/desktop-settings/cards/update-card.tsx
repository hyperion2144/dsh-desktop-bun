// 「应用更新」卡：走框架自带的 Updater，壳把状态机翻成 UpdateSnapshotLike，客户端只负责渲染。
// 检查/下载/安装期间 1s 轮询——轮询与「忙不忙」的判定都在本卡内，不再借面板的账。
import React, { useEffect, useState } from 'react'
import { PfBtn, SectionBox, showToast } from '../chrome.tsx'
import { DANGER_NOTE_STYLE, NOTE_STYLE } from '../styles.ts'
import { fmtBytes } from '../format.ts'
import { invoke } from '../rpc.ts'
import type { UpdateSnapshotLike } from '../types.ts'

export function UpdateCard(): React.ReactElement {
  const [updateState, setUpdateState] = useState<UpdateSnapshotLike | null>(null)
  const updateBusy =
    updateState !== null &&
    (updateState.view.phase === 'checking' ||
      updateState.view.phase === 'downloading' ||
      updateState.view.phase === 'preparing')

  const runUpdate = (cmd: 'check_update' | 'download_update' | 'apply_update'): void => {
    void invoke<UpdateSnapshotLike>(cmd)
      .then((snapshot) => {
        setUpdateState(snapshot)
        showToast(snapshot.view.label, snapshot.view.phase !== 'error')
      })
      .catch((e: unknown) => showToast(`更新失败：${String(e)}`, false))
  }

  useEffect(() => {
    let cancelled = false
    void invoke<UpdateSnapshotLike>('get_update_state')
      .then((snapshot) => {
        if (!cancelled) setUpdateState(snapshot)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!updateBusy) return
    const timer = setInterval(() => {
      void invoke<UpdateSnapshotLike>('get_update_state')
        .then(setUpdateState)
        .catch(() => {})
    }, 1000)
    return () => clearInterval(timer)
  }, [updateBusy])

  return (
    <SectionBox title="应用更新">
      <div style={NOTE_STYLE}>
        {updateState === null
          ? '读取中…'
          : `当前版本 ${updateState.view.current || '未知'}${
              updateState.view.channel ? `（${updateState.view.channel}）` : ''
            } · ${updateState.view.label}`}
      </div>
      {updateState !== null && updateState.view.message !== '' && (
        <div style={NOTE_STYLE}>{updateState.view.message}</div>
      )}
      {updateState !== null && updateState.actions.hint !== '' && (
        <div style={NOTE_STYLE}>{updateState.actions.hint}</div>
      )}
      {updateState !== null && !updateState.available && updateState.reason !== '' && (
        <div style={NOTE_STYLE}>{updateState.reason}</div>
      )}
      {updateState !== null && updateState.view.error !== '' && (
        <div style={DANGER_NOTE_STYLE}>{updateState.view.error}</div>
      )}
      {updateBusy && updateState !== null && updateState.view.progress !== null && (
        <div style={NOTE_STYLE}>
          进度 {updateState.view.progress}%
          {updateState.view.totalBytes !== null
            ? `（${fmtBytes(updateState.view.bytesDownloaded)} / ${fmtBytes(updateState.view.totalBytes)}）`
            : ''}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <PfBtn
          variant="ghost"
          disabled={updateState === null || !updateState.actions.canCheck}
          onClick={() => runUpdate('check_update')}
        >
          检查更新
        </PfBtn>
        <PfBtn
          variant="ghost"
          disabled={updateState === null || !updateState.actions.canDownload}
          onClick={() => runUpdate('download_update')}
        >
          下载更新
        </PfBtn>
        <PfBtn
          variant="ghost"
          disabled={updateState === null || !updateState.actions.canApply}
          onClick={() => runUpdate('apply_update')}
        >
          重启并安装
        </PfBtn>
      </div>
    </SectionBox>
  )
}
