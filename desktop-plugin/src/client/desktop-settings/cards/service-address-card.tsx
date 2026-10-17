// 「dsh 服务地址」卡：壳要连的 dsh 服务来源（本机 or 远程），可增删地址列表。
// 三个动作的语义各不相同：切换立即重启 dsh；新增/删除只改列表，重启后才生效。
import React, { useState } from 'react'
import { PfBtn, SectionBox } from '../chrome.tsx'
import { FLEX_1_STYLE, NOTE_STYLE, ROW_STYLE } from '../styles.ts'
import { ThemeSelect } from '../../theme-select.tsx'
import { invoke, nsSave } from '../rpc.ts'
import { normalizeRemote } from '../format.ts'
import type { DesktopData, Notify } from '../types.ts'

export function ServiceAddressCard({
  desktop,
  refreshData,
  notify,
}: {
  desktop: DesktopData
  refreshData: () => Promise<void>
  notify: Notify
}): React.ReactElement {
  const [newRemoteUrl, setNewRemoteUrl] = useState('')

  const handleSelectRemote = (addr: string | null): void => {
    void (async () => {
      try {
        await nsSave({ remote_addr: addr })
        await invoke('restart_dsh_service')
        notify({ ok: true, text: '已切换 dsh 服务来源，正在重启…' })
      } catch (err) {
        notify({ ok: false, text: `切换失败：${String(err)}` })
      }
    })()
  }

  const handleAddRemote = (): void => {
    const addr = normalizeRemote(newRemoteUrl)
    if (!addr) {
      notify({ ok: false, text: '地址非法：需 dsh web 完整 URL（含 token）或 host[:port]' })
      return
    }
    void (async () => {
      try {
        const list = Array.isArray(desktop.remote_list) ? [...desktop.remote_list] : []
        if (!list.includes(addr)) list.push(addr)
        await nsSave({ remote_list: list })
        setNewRemoteUrl('')
        notify({ ok: true, text: `已新增地址：${addr}（未切换，请在下拉框选择）` })
        await refreshData()
      } catch (err) {
        notify({ ok: false, text: `新增失败：${String(err)}` })
      }
    })()
  }

  const handleRemoveRemote = (addr: string): void => {
    void (async () => {
      try {
        const list = (desktop.remote_list ?? []).filter((a) => a !== addr)
        const patch: Record<string, unknown> = { remote_list: list }
        if (desktop.remote_addr === addr) patch.remote_addr = null
        await nsSave(patch)
        notify({ ok: true, text: `已删除：${addr}` })
      } catch (err) {
        notify({ ok: false, text: `删除失败：${String(err)}` })
      }
      await refreshData()
    })()
  }

  return (
    <SectionBox title="dsh 服务地址">
      <ThemeSelect
        style={{ marginBottom: 8 }}
        value={desktop.remote_addr ?? ''}
        onChange={(v) => handleSelectRemote(v || null)}
        options={[
          { value: '', label: '本地（127.0.0.1）' },
          ...(desktop.remote_list ?? []).map((addr) => ({ value: addr, label: addr })),
        ]}
      />

      {/* 新增地址行 */}
      <div style={ROW_STYLE}>
        <input
          placeholder="新增：dsh web 打印的完整 URL（含 token）或 host[:port]"
          className="pf-input"
          style={FLEX_1_STYLE}
          data-desktop-settings="remote-add"
          value={newRemoteUrl}
          onChange={(e) => setNewRemoteUrl(e.target.value.trim())}
        />
        <PfBtn variant="ghost" onClick={handleAddRemote}>新增</PfBtn>
      </div>

      {/* 地址删除行 */}
      {desktop.remote_list.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {desktop.remote_list.map((addr) => (
            <PfBtn
              key={addr}
              variant="danger"
              style={{ fontSize: 11 }}
              onClick={() => handleRemoveRemote(addr)}
            >
              删除：{addr}
            </PfBtn>
          ))}
        </div>
      )}
      <div style={NOTE_STYLE}>
        选择远程地址后立即按当前模式重启 dsh；新增/删除仅改列表，重启后生效。
      </div>
      <div style={NOTE_STYLE}>
        此处的地址是桌面壳连接的 dsh 服务来源（壳将直连该地址，不再拉起本地服务）；若要给手机/其它设备连接本机，请用「手机访问 → 远程访问」。
      </div>
    </SectionBox>
  )
}
