// 「开发者工具」卡：#69。两个方向的变更都先弹确认（取消不写入），确认才保存并重启桌面壳。
// 确认弹窗、Escape 取消、重启回包两路文案全在本卡内——它不需要面板替它记任何东西。
import React, { useEffect, useState } from 'react'
import { PfBtn, SectionBox } from '../chrome.tsx'
import {
  DEV_TOOLS_ACTIONS_STYLE,
  DEV_TOOLS_BODY_STYLE,
  DEV_TOOLS_CONFIRM,
  DEV_TOOLS_DISABLE,
  DEV_TOOLS_MODAL_STYLE,
  DEV_TOOLS_OVERLAY_STYLE,
  DEV_TOOLS_TITLE_STYLE,
  NOTE_STYLE,
  ROW_STYLE,
} from '../styles.ts'
import { invoke, nsSave } from '../rpc.ts'
import { devToolsSavedNote, planDevToolsUi, type DevToolsRestartOutcome } from '../../shell/devtools-toggle.ts'
import type { DesktopData } from '../types.ts'

export function DevToolsCard({ desktop }: { desktop: DesktopData }): React.ReactElement {
  const [devToolsConfirmKind, setDevToolsConfirmKind] = useState<null | 'on' | 'off'>(null)
  const [devTools, setDevTools] = useState(false)
  const [devToolsNote, setDevToolsNote] = useState<string | null>(null)

  // 壳键状态从持久化值回填（与「电源」「手机访问」同一拍）。
  useEffect(() => {
    setDevTools(desktop.dev_tools === true)
  }, [desktop])

  /** #69：开发者工具开关——两个方向的变更都先弹确认（取消不写入），确认才保存并重启桌面壳。 */
  const handleToggleDevTools = (next: boolean): void => {
    const plan = planDevToolsUi(devTools, next)
    if (plan.action === 'idle') return
    setDevToolsConfirmKind(plan.action === 'confirm-on' ? 'on' : 'off')
  }

  const saveDevToolsSetting = (on: boolean): void => {
    setDevToolsConfirmKind(null)
    setDevTools(on)
    void nsSave({ dev_tools: on })
      // #119：改走 `restart_desktop_app`（整应用退出 + 自动拉起），不再走 `restart_dsh_service`。
      // 后者只重起 DSH 树、壳不动，而 dev_tools 的决策（planDevToolsBoot + C environ 双写）锁在壳进程加载那一刻——
      // 不重启壳它永不重跑。这就是 #69「保存即重启桌面壳」的文案与实现的背离。
      .then(() => invoke<DevToolsRestartOutcome>('restart_desktop_app'))
      // 回包两路：拉起来了 { ok:true }；拉不起来 { ok:false, reason, message }（dev 态、探测不到 launcher）。
      .then((outcome) => setDevToolsNote(devToolsSavedNote(on, outcome)))
      .catch((e) => {
        // 壳已经开始退时 RPC 连接随之断开（Failed to fetch 一类）——那是重启**成功**的预期形态，不是失败
        // （沿用 #79 重启语义的老判据）。真拉不起来时壳会回包，走上面那条降级文案。
        if (/failed to fetch|network ?error|load failed|fetch failed|terminated/i.test(String(e))) {
          setDevToolsNote(devToolsSavedNote(on))
          return
        }
        setDevToolsNote(`设置已保存，但重启桌面应用失败：${String(e)}`)
      })
  }

  // #69：确认弹窗开着时 Escape = 取消（不写入），与 local-chrome 退出确认同款键盘可达
  useEffect(() => {
    if (devToolsConfirmKind === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDevToolsConfirmKind(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [devToolsConfirmKind])

  const devToolsActiveConfirm = devToolsConfirmKind === 'off' ? DEV_TOOLS_DISABLE : DEV_TOOLS_CONFIRM

  return (
    <SectionBox title="开发者工具">
      <div style={ROW_STYLE}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            data-desktop-settings="dev-tools"
            checked={devTools}
            onChange={(e) => handleToggleDevTools(e.target.checked)}
          />
          允许打开 DevTools（打包态默认关；改动重启桌面壳生效）
        </label>
      </div>
      {devToolsNote && <div style={NOTE_STYLE}>{devToolsNote}</div>}
      <div style={NOTE_STYLE}>
        开启后桌面壳在本机回环地址监听一个远程调试口，本机任意程序可借它在页面里执行代码。只在自己排查问题时开启，用完记得关掉并重启。
        Windows 下按 F12 或右键菜单「打开 DevTools」打开（不自动弹窗）；mac/Linux 为「打开 DevTools」。
      </div>
      {devToolsConfirmKind !== null && (
        <div style={DEV_TOOLS_OVERLAY_STYLE}>
          <div style={DEV_TOOLS_MODAL_STYLE} data-desktop-settings="dev-tools-confirm">
            <div style={DEV_TOOLS_TITLE_STYLE}>{devToolsActiveConfirm.title}</div>
            {devToolsActiveConfirm.lines.map((line) => (
              <div key={line} style={DEV_TOOLS_BODY_STYLE}>
                {line}
              </div>
            ))}
            <div style={DEV_TOOLS_ACTIONS_STYLE}>
              <PfBtn variant="ghost" onClick={() => setDevToolsConfirmKind(null)}>
                {devToolsActiveConfirm.cancel}
              </PfBtn>
              <PfBtn variant="primary" onClick={() => saveDevToolsSetting(devToolsConfirmKind === 'on')}>
                {devToolsActiveConfirm.confirm}
              </PfBtn>
            </div>
          </div>
        </div>
      )}
    </SectionBox>
  )
}
