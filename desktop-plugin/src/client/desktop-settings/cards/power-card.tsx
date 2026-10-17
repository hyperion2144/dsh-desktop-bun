// 「电源」卡：#186 防休眠开关 + #75 壳报的防休眠能力口径。
// 开关自己即时落盘；能力拿不到时必须明说降级（不许静默）。
import React, { useEffect, useState } from 'react'
import { SectionBox } from '../chrome.tsx'
import { NOTE_STYLE, ROW_STYLE, WARN_NOTE_STYLE } from '../styles.ts'
import { nsSave } from '../rpc.ts'
import { keepAwakeNote } from '../../keep-awake-note.ts'
import type { DesktopData } from '../types.ts'

export function PowerCard({ desktop }: { desktop: DesktopData }): React.ReactElement {
  const [preventSleep, setPreventSleep] = useState(true)
  const [preventSleepNote, setPreventSleepNote] = useState<string | null>(null)

  // 壳键状态从持久化值回填（设置弹窗每次挂载都重读；只写不回填 = 关掉再进就丢）。
  // 依赖 desktop 的引用：refreshData() 换新对象时也会重新回填，与旧面板那一个大 effect 同拍。
  useEffect(() => {
    setPreventSleep(desktop.prevent_sleep !== false)
  }, [desktop])

  /** #186：防休眠开关（即时保存；壳侧状态机立刻生效，不需要重启）。 */
  const handleTogglePreventSleep = (next: boolean): void => {
    setPreventSleep(next)
    void nsSave({ prevent_sleep: next })
      .then(() =>
        setPreventSleepNote(
          next
            ? '已保存：有会话在跑时阻止系统休眠（屏幕仍会照常熄灭）。'
            : '已保存：不再阻止系统休眠。',
        ),
      )
      .catch((e) => setPreventSleepNote(`保存失败：${String(e)}`))
  }

  return (
    <SectionBox title="电源">
      <div style={ROW_STYLE}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            data-desktop-settings="prevent-sleep"
            checked={preventSleep}
            onChange={(e) => handleTogglePreventSleep(e.target.checked)}
          />
          有会话在跑时阻止系统休眠（缺省开）
        </label>
      </div>
      {preventSleepNote && <div style={NOTE_STYLE}>{preventSleepNote}</div>}
      {(() => {
        // #75：壳报的防休眠能力决定这段口径——拿不到抑制通道时降级为醒目提示（不许静默）。
        const note = keepAwakeNote(desktop.keep_awake)
        return <div style={note.tone === 'warn' ? WARN_NOTE_STYLE : NOTE_STYLE}>{note.text}</div>
      })()}
    </SectionBox>
  )
}
