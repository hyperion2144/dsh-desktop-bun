// 「手机访问（远程连接）」卡：#144 网关心跳覆盖 + #147 路线 A 的手机端桌面布局开关。
//
// 两件事的来龙去脉不同，但原本就是同一张卡（#128 把布局开关从裸奔状态并进来），保持在一起。
// 心跳保存的回执写到「下载」卡的 note（onNote）——那是旧行为，本票不改，只在此注明。
import React, { useEffect, useState } from 'react'
import { PfBtn, SectionBox } from '../chrome.tsx'
import { INPUT_BASE_STYLE, LABEL_STYLE, NOTE_STYLE, ROW_STYLE } from '../styles.ts'
import { nsSave } from '../rpc.ts'
import type { DesktopData } from '../types.ts'

export function MobileAccessCard({
  desktop,
  onNote,
}: {
  desktop: DesktopData
  onNote: (next: string | null) => void
}): React.ReactElement {
  // #147 路线 A：手机端是否改用桌面布局（不注入 dsh-web-mobile）；#144：网关 mux 心跳覆盖
  const [muxHeartbeatInput, setMuxHeartbeatInput] = useState<string>('30000')
  const [desktopLayoutOnPhones, setDesktopLayoutOnPhones] = useState(false)
  // #147 路线 A：布局开关的保存回执（就近显示；原先落在「下载」卡的共享 note 里，隔着一整张卡）
  const [mobileLayoutNote, setMobileLayoutNote] = useState<string | null>(null)

  // 壳键状态从持久化值回填（设置弹窗每次挂载都重读；只写不回填 = 关掉再进就丢）。
  useEffect(() => {
    setDesktopLayoutOnPhones(desktop.desktop_layout_on_phones === true)
    const hb = desktop.mux_heartbeat_ms
    setMuxHeartbeatInput(typeof hb === 'number' ? String(hb) : '30000')
  }, [desktop])

  /** #144：保存 dsh 网关心跳覆盖（mux_heartbeat_ms）。空/非数字→保留 30000；0 = 不覆盖。 */
  const handleSaveMuxHeartbeat = (): void => {
    const raw = muxHeartbeatInput.trim()
    const parsed = raw === '' ? 30000 : parseInt(raw, 10)
    if (Number.isNaN(parsed) || parsed < 0) {
      onNote('心跳间隔需为整数毫秒（0 = 不覆盖，回退 dsh 默认 2s）')
      return
    }
    const v = Math.min(600000, parsed)
    void nsSave({ mux_heartbeat_ms: v })
      .then(() =>
        onNote(
          v === 0
            ? '已保存：不覆盖心跳（dsh 默认 2s），重启 dsh 生效。'
            : `已保存：mux 心跳 ${v}ms（dsh 原生 2s），重启 dsh 生效。`,
        ),
      )
      .catch((e) => onNote(`保存失败：${String(e)}`))
  }

  /** #147 路线 A：「手机端改用桌面布局」开关——与同面板其它 checkbox（#69 / #186 / #128）口径一致：勾选即存。
   *  「即时生效」不是这一项的额外特性，只是落盘之外没有别的步骤；它要对手机端真正生效仍需重启 dsh，
   *  那件事写在下方说明文字里。保存失败回拨，避免 UI 显示已开而盘上还是旧值。 */
  const handleToggleMobileLayout = (next: boolean): void => {
    setDesktopLayoutOnPhones(next)
    void nsSave({ desktop_layout_on_phones: next })
      .then(() =>
        setMobileLayoutNote(
          next
            ? '已保存：手机使用桌面布局（不加载移动布局插件），重启 dsh 生效。'
            : '已保存：手机使用移动布局，重启 dsh 生效。',
        ),
      )
      .catch((e) => {
        setDesktopLayoutOnPhones(!next)
        setMobileLayoutNote(`保存失败：${String(e)}`)
      })
  }

  return (
    <SectionBox title="手机访问（远程连接）">
      <div style={ROW_STYLE}>
        <input
          placeholder="30000"
          data-desktop-settings="mux-heartbeat-ms"
          style={{ ...INPUT_BASE_STYLE, width: 100 }}
          value={muxHeartbeatInput}
          onChange={(e) => setMuxHeartbeatInput(e.target.value)}
        />
        <PfBtn variant="ghost" onClick={handleSaveMuxHeartbeat}>保存</PfBtn>
      </div>
      <div style={NOTE_STYLE}>
        dsh 网关对 <code>/api/remote.mux</code> 的心跳间隔（毫秒）。dsh 原生 2s 且连丢 2 次即断开，
        移动端切后台/弱网会被秒判死（表现为「能发消息、收不到新消息」）；壳默认覆盖为 30000。
        填 0 = 不覆盖（回退 dsh 默认），改动重启 dsh 生效。
      </div>
      {/* #147 路线 A：原先这一块掉在 </SectionBox> 之后裸奔（没有卡片框），这里并进本卡的第二段。 */}
      <div style={{ ...LABEL_STYLE, marginTop: 12 }}>移动端布局</div>
      <div style={ROW_STYLE}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            data-desktop-settings="desktop-layout-on-phones"
            checked={desktopLayoutOnPhones}
            onChange={(e) => handleToggleMobileLayout(e.target.checked)}
          />
          手机端改用桌面布局（不加载移动布局插件）
        </label>
      </div>
      <div style={NOTE_STYLE}>
        手机上的卡顿来自宿主前端（会话整段挂载 + 逐块代码高亮），不是网络。勾选后手机走与 iPad
        相同的桌面布局：明显更流畅，代价是排版更挤（可横屏缓解）。不勾选 = 移动布局。改动重启 dsh 生效。
      </div>
      {mobileLayoutNote && <div style={NOTE_STYLE}>{mobileLayoutNote}</div>}
    </SectionBox>
  )
}
