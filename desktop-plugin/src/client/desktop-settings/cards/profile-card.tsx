// 「Profile」卡：切 profile（会重启 dsh web）。
import React from 'react'
import { SectionBox } from '../chrome.tsx'
import { NOTE_STYLE } from '../styles.ts'
import { ThemeSelect } from '../../ui/theme-select.tsx'
import { invoke, nsSave } from '../rpc.ts'
import type { DesktopData, Notify } from '../types.ts'

export function ProfileCard({
  desktop,
  notify,
}: {
  desktop: DesktopData
  notify: Notify
}): React.ReactElement {
  // Profile select 选中（active 优先；与原代码 `if (p.active) o.selected = true` 等价）。
  const activeProfile = desktop.profiles.find((p) => p.active)
  const profileSelectValue = activeProfile?.name ?? desktop.profiles[0]?.name ?? ''

  const handleSwitchProfile = (name: string): void => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      notify({ ok: false, text: 'Profile 名不合法' })
      return
    }
    void (async () => {
      try {
        await nsSave({ active_profile: name })
        await invoke('restart_dsh_service')
        notify({ ok: true, text: `已切换到 Profile「${name}」，正在重启…` })
      } catch (err) {
        notify({ ok: false, text: `切换 Profile 失败：${String(err)}` })
      }
    })()
  }

  return (
    <SectionBox title="Profile">
      <ThemeSelect
        style={{ marginBottom: 8 }}
        value={profileSelectValue}
        onChange={handleSwitchProfile}
        options={(desktop.profiles ?? []).map((p) => ({
          value: p.name,
          label: p.active ? `✓ ${p.name}` : p.name,
        }))}
      />
      <div style={NOTE_STYLE}>切换 Profile 会以目标 profile 重启 dsh web。</div>
    </SectionBox>
  )
}
