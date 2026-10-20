// 「应用更新」卡：走框架自带的 Updater，壳把状态机翻成 UpdateSnapshotLike，客户端只负责渲染。
// 检查/下载/安装期间 1s 轮询——轮询与「忙不忙」的判定都在本卡内，不再借面板的账。
import React, { useEffect, useState } from 'react'
import { PfBtn, SectionBox, showToast } from '../chrome.tsx'
import { DANGER_NOTE_STYLE, FLEX_1_STYLE, NOTE_STYLE, ROW_STYLE } from '../styles.ts'
import { fmtBytes } from '../format.ts'
import { invoke } from '../rpc.ts'
import type { UpdateSnapshotLike } from '../types.ts'
import {
  ignoredEmptyHint,
  ignoredRows,
  parseUpdateNoticeState,
  updateNoticeEnabledHint,
  type UpdateNoticeStateLike,
} from '../../features/update-notice-settings.ts'

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

  // 启动更新提醒（#136）：开关 + 已忽略版本列表。状态住在壳的 `app-support/update-notice.json`，
  // **不在 desktop-settings.json 里**——设置文件的键名是契约红线，壳内部状态不往里塞。
  const [updateNotice, setUpdateNotice] = useState<UpdateNoticeStateLike | null>(null)
  const [updateNoticeError, setUpdateNoticeError] = useState<string | null>(null)
  const refreshUpdateNotice = (): void => {
    void invoke<unknown>('get_update_notice_state')
      .then((raw) => {
        setUpdateNotice(parseUpdateNoticeState(raw))
        setUpdateNoticeError(null)
      })
      // 读不到就说读不到：开关置灰而不是默认画成「开」——假装开着比报错更坏。
      .catch((e: unknown) => setUpdateNoticeError(String(e)))
  }
  useEffect(() => {
    refreshUpdateNotice()
  }, [])
  /** 写完拿壳回传的状态刷新（不回传就没法确认真的落盘了）。 */
  const afterUpdateNoticeWrite = (raw: unknown): void => {
    setUpdateNotice(parseUpdateNoticeState(raw))
    setUpdateNoticeError(null)
  }
  const failUpdateNoticeWrite = (e: unknown): void => setUpdateNoticeError(String(e))
  const handleToggleUpdateNotice = (enabled: boolean): void => {
    // 先本地翻转再发请求：勾选框必须立刻响应，回包只用来纠正。
    setUpdateNotice((prev) => (prev === null ? prev : { ...prev, enabled }))
    void invoke<unknown>('set_update_notice_enabled', { enabled })
      .then(afterUpdateNoticeWrite)
      .catch((e: unknown) => {
        failUpdateNoticeWrite(e)
        refreshUpdateNotice()
      })
  }
  const handleRestoreIgnored = (row: { kind: 'shell' | 'runtime' | null; version: string }): void => {
    // 无前缀的未知键传 null：壳只认带路的 kind，所以这一类只能靠「清空全部」清（面板如实说明）。
    if (row.kind === null) return
    void invoke<unknown>('restore_update_notice', {
      targets: [{ kind: row.kind, version: row.version }],
    })
      .then(afterUpdateNoticeWrite)
      .catch(failUpdateNoticeWrite)
  }
  const handleClearIgnored = (): void => {
    void invoke<unknown>('clear_update_notice_ignored')
      .then(afterUpdateNoticeWrite)
      .catch(failUpdateNoticeWrite)
  }

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
      {/* ── 启动更新提醒（#136）：开关 + 已忽略版本。状态在 app-support/update-notice.json ── */}
      <div style={{ ...ROW_STYLE, marginTop: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            data-desktop-settings="update-notice-enabled"
            checked={updateNotice?.enabled ?? false}
            disabled={updateNotice === null}
            onChange={(e) => handleToggleUpdateNotice(e.target.checked)}
          />
          启动时有新版本就提醒（缺省开）
        </label>
      </div>
      {updateNoticeError !== null && <div style={DANGER_NOTE_STYLE}>{updateNoticeError}</div>}
      {updateNotice !== null && (
        <div style={NOTE_STYLE}>{updateNoticeEnabledHint(updateNotice.enabled)}</div>
      )}
      {updateNotice !== null && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>已忽略的版本</div>
          {(() => {
            const rows = ignoredRows(updateNotice.ignored)
            if (rows.length === 0) return <div style={NOTE_STYLE}>{ignoredEmptyHint()}</div>
            return (
              <div>
                {rows.map((row) => (
                  <div key={row.key} style={{ ...ROW_STYLE, marginBottom: 4 }}>
                    <span style={FLEX_1_STYLE}>{row.label}</span>
                    <PfBtn
                      variant="ghost"
                      disabled={row.kind === null}
                      onClick={() => handleRestoreIgnored(row)}
                    >
                      恢复
                    </PfBtn>
                  </div>
                ))}
                <div style={NOTE_STYLE}>
                  标「未知来源」的条目是早期格式写的，没法单独恢复，用「清空全部」一并清掉。
                </div>
                <div style={{ marginTop: 4 }}>
                  <PfBtn variant="ghost" onClick={handleClearIgnored}>
                    清空全部
                  </PfBtn>
                </div>
              </div>
            )
          })()}
        </div>
      )}
    </SectionBox>
  )
}
