/**
 * 桌面通知设置 Tab（#142 / 规格 #143 / T4 原型 A「分区列表」布局）。
 *
 * 注入 dsh 设置弹窗的 settings.section 槽位（同 desktop-settings.tsx 模式）。
 * 结构：权限卡（三态 + 申请/打开系统设置）→ 总开关 → 免打扰（时段+全屏静默）→
 * 免打扰三行（时段 / 全屏静默 / 前台聚焦不投递的说明，#115）；
 * 场景区（6 组 12 行：名称+id·说明 | 开关 | 音效下拉 | 试听▶）。
 * 数据面：get_notifications_state 一次拉全；改动即时 set_notifications_config 落盘
 * （宿主单写者）；音效选择经 choose_notification_sound + import_notification_sound。
 * #74：壳给的「本机播放能力」（capability）可能整个缺失（老壳 / 测试桩）——判定全在
 * notification-sound-ui.ts 里，缺失按「不判定」处理；试听「真放了但没出声」与「已配置但本机
 * 播不了」都要在面板里看得见，不许静默、不许假成功。
 * 权限被拒（macOS 27 对 ad-hoc 签名的静默拒绝，#130/#142）：引导打开系统设置手动开启。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientContext } from '../bridge/ctx-types.ts'
import { focusSuppressHint } from './notification-focus-hint.ts'
import { invokeCommand } from '../desktop-settings/rpc.ts'
import type { Commands } from '../../../../contracts/index.ts'
import {
  capabilityHint,
  configuredSoundWarning,
  previewFailure,
  customSoundOptions,
  permissionUnavailableCopy,
  deniedPermissionCopy,
  type SoundCapability,
} from './notification-sound-ui.ts'

export const inject = ['slots']

/** 面板数据形状：锚在契约上（#190）。老手抄版把 dnd 的 suppressFullscreen 写成了
 * suppress_fullscreen——读侧永远 undefined（开关画不成 on）、写侧把孤立键写进设置文件
 * （壳读不到，功能等于坏），契约化后两端同源，顺带修掉这个潜伏 bug。 */
type NotificationState = Commands['get_notifications_state']['result']
type ScenarioRow = NotificationState['scenarios'][number]

const SYS_PREFS = 'x-apple.systempreferences:com.apple.Preference.Notifications'

// ── 主题 token：真实 dsh 变量名 + 回退值（独立打开时生效）──
const PANEL_CSS = `
[data-notification-settings] { font-size: 13px; }
[data-notification-settings] .n-card { border:1px solid var(--dsw-alias-border-l2,#ffffff1f); border-radius:12px; padding:12px 16px; margin-bottom:10px; }
[data-notification-settings] .n-banner { display:flex; gap:10px; align-items:center; border:1px solid var(--dsw-alias-border-l2,#ffffff1f); border-left:3px solid var(--dsw-alias-state-warn,#e8a33d); background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); border-radius:8px; padding:9px 12px; font-size:12.5px; margin-bottom:10px; }
[data-notification-settings] .n-banner.granted { border-left-color:var(--dsw-alias-state-success,#2fbf71); }
[data-notification-settings] .n-banner.denied { border-left-color:var(--dsw-alias-state-danger,#e5534b); }
[data-notification-settings] .n-banner.neutral { border-left-color:var(--dsw-alias-border-l2,#ffffff1f); }
[data-notification-settings] .n-banner .grow { flex:1; min-width:0; }
[data-notification-settings] .n-chip { display:inline-block; font-size:11px; border:1px solid var(--dsw-alias-border-l2,#ffffff1f); border-radius:6px; padding:1px 7px; color:var(--dsw-alias-label-secondary,#9aa4b2); white-space:nowrap; }
[data-notification-settings] .n-chip.ok { color:var(--dsw-alias-state-success,#2fbf71); border-color:var(--dsw-alias-state-success,#2fbf71); }
[data-notification-settings] .n-chip.warn { color:var(--dsw-alias-state-warn,#e8a33d); border-color:var(--dsw-alias-state-warn,#e8a33d); }
[data-notification-settings] .n-chip.danger { color:var(--dsw-alias-state-danger,#e5534b); border-color:var(--dsw-alias-state-danger,#e5534b); }
[data-notification-settings] .n-btn { background:var(--dsw-alias-brand-primary-new-color,#4176e6); border:none; color:#fff; border-radius:8px; padding:5px 12px; font-size:12px; cursor:pointer; }
[data-notification-settings] .n-btn:hover { filter:brightness(1.12); }
[data-notification-settings] .n-btn.ghost { background:transparent; border:1px solid var(--dsw-alias-border-l2,#ffffff1f); color:var(--dsw-alias-label-primary,#e7eaf0); }
[data-notification-settings] .n-btn.ghost:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); filter:none; }
[data-notification-settings] .n-btn.mini { padding:2px 9px; font-size:11px; }
[data-notification-settings] .n-btn:disabled { opacity:.45; cursor:default; filter:none; }
[data-notification-settings] .n-switch { position:relative; width:34px; height:19px; border-radius:999px; background:var(--dsw-alias-border-l2,#ffffff1f); cursor:pointer; flex:none; transition:background .15s; display:inline-block; vertical-align:middle; }
[data-notification-settings] .n-switch.on { background:var(--dsw-alias-state-success,#2fbf71); }
[data-notification-settings] .n-switch::after { content:""; position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%; background:var(--dsw-alias-bg-base,#151517); transition:left .15s; }
[data-notification-settings] .n-switch.on::after { left:17px; }
[data-notification-settings] .n-setrow { display:flex; justify-content:space-between; align-items:center; gap:10px; font-size:12.5px; }
[data-notification-settings] .n-srow { display:flex; align-items:center; gap:10px; padding:7px 0; border-bottom:1px solid var(--dsw-alias-border-l2,#ffffff1f); }
[data-notification-settings] .n-grp:last-child .n-srow:last-child { border-bottom:none; }
[data-notification-settings] .n-sinfo { flex:1; min-width:0; }
[data-notification-settings] .n-sinfo b { font-size:12.5px; font-weight:600; }
[data-notification-settings] .n-mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10.5px; color:var(--dsw-alias-label-secondary,#9aa4b2); }
[data-notification-settings] .n-gname { font-size:11px; color:var(--dsw-alias-label-secondary,#9aa4b2); letter-spacing:.4px; margin:10px 0 2px; }
[data-notification-settings] .n-select, [data-notification-settings] .n-time { font:inherit; font-size:12px; color:inherit; background:transparent; border:1px solid var(--dsw-alias-border-l2,#ffffff1f); border-radius:8px; padding:3px 7px; }
[data-notification-settings] .n-note { font-size:11px; color:var(--dsw-alias-label-secondary,#9aa4b2); margin-top:8px; }
[data-notification-settings] .n-mastoff .n-srow .n-switch, [data-notification-settings] .n-mastoff .n-srow select, [data-notification-settings] .n-mastoff .n-srow button { opacity:.4; pointer-events:none; }
[data-notification-settings] input[type="time"] { color-scheme: inherit; }
`

let stylesInstalled = false
function ensureStyles(): void {
  if (stylesInstalled) return
  stylesInstalled = true
  const style = document.createElement('style')
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
}

function NotificationSettingsPanel(): React.ReactElement {
  const [data, setData] = useState<NotificationState | null>(null)
  const [busy, setBusy] = useState(false)
  /** 试听失败提示（#74）：只有「真放了但没出声」才写；成功或换行即清。 */
  const [previewNote, setPreviewNote] = useState<{ id: string; text: string } | null>(null)
  /** 数据面整个拉不到（老壳没有这条命令等）：如实说，别让面板永远停在「加载中…」。 */
  const [loadFailed, setLoadFailed] = useState(false)

  const refresh = useCallback((): void => {
    invokeCommand('get_notifications_state')
      .then((res) => {
        setLoadFailed(false)
        setData(res)
      })
      .catch((e) => {
        // 缺 capability 不吭声，整条命令失败也不许留白（#74）
        logFail(e)
        setLoadFailed(true)
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 权限状态是异步刷的缓存：status() 读前踢的那次刷新还没落地，打开面板后补拉一次
  const refetched = useRef(false)
  useEffect(() => {
    if (data === null || refetched.current) return
    refetched.current = true
    const timer = setTimeout(() => { refresh() }, 700)
    return () => clearTimeout(timer)
  }, [data, refresh])

  const save = useCallback((next: NotificationState['config']): void => {
    setBusy(true)
    invokeCommand('set_notifications_config', { config: next })
      .catch((e) => { logFail(e) })
      .finally(() => setBusy(false))
  }, [])

  const logFail = (e: unknown): void => {
    console.warn('[notifications] 保存失败', e)
  }

  const patch = useCallback((fn: (c: NotificationState['config']) => void): void => {
    setData((prev) => {
      if (prev === null) return prev
      const next = {
        enabled: prev.config.enabled,
        dnd: { ...prev.config.dnd },
        scenarios: Object.fromEntries(
          Object.entries(prev.config.scenarios).map(([k, v]) => [k, { ...v }]),
        ),
      }
      fn(next)
      save(next)
      return { ...prev, config: next }
    })
  }, [save])

  if (data === null) {
    return (
      <div data-notification-settings className="n-note">
        {loadFailed ? '通知设置读取失败：桌面壳没有响应（详见控制台）' : '加载中…'}
      </div>
    )
  }


  const requestPerm = (): void => {
    setBusy(true)
    invokeCommand('request_notification_permission_cmd')
      .then(() => refresh())
      .catch((error: unknown) => {
        console.warn(`[notifications] 通知权限申请失败：${String(error)}`)
      })
      .finally(() => setBusy(false))
  }

  const openSysPrefs = (): void => {
    void invokeCommand('open_external', { url: SYS_PREFS }).catch(() => {})
  }

  const chooseSound = (): void => {
    invokeCommand('choose_notification_sound')
      .then((path) => {
        if (path === null || path === undefined || path === '') return
        return invokeCommand('import_notification_sound', { path }).then((name) => {
          refresh()
          return name
        })
      })
      .catch((e) => console.warn('[notifications] 导入音效失败', e))
  }

  /** 试听（#74）：壳会说「真放出去了但没出声」——那种必须看得见，不许静默。 */
  const previewSound = (id: string, sound: string): void => {
    invokeCommand('preview_notification_sound', { sound })
      .then((res) => {
        const failure = previewFailure(res)
        setPreviewNote(failure === null ? null : { id, text: failure })
      })
      .catch((e) => {
        logFail(e)
        setPreviewNote({ id, text: '试听失败：桌面壳没有响应（详见控制台）' })
      })
  }

  const groupLabel = (gid: string): string => data.groups.find(([g]) => g === gid)?.[1] ?? gid
  const grouped = data.groups.map(([gid]) => ({
    gid,
    rows: data.scenarios.filter((s) => s.group === gid),
  }))

  // #74：能力报告可能整个缺失（老壳 / 测试桩）——判定全在 notification-sound-ui 里，
  // 缺失一律按「不判定」处理，面板照常渲染。
  const capability = data.capability ?? null
  const soundHint = capabilityHint(capability)
  const soundChoices = customSoundOptions(data.sounds, capability)
  // PR #100 实测反馈：win32/linux 没有「通知授权」这个概念，旧文案（dev 裸二进制 / .app）是假话
  const permissionUnavailable = permissionUnavailableCopy(capability?.platform)

  return (
    <div data-notification-settings className={data.config.enabled ? '' : 'n-mastoff'}>
      {/* 权限卡 */}
      {data.permission === 'granted' ? (
        <div className="n-banner granted">
          <span className="n-chip ok">已授予</span>
          <span className="grow">系统允许本应用发送通知。</span>
          <button className="n-btn ghost mini" onClick={openSysPrefs}>打开系统设置</button>
        </div>
      ) : data.permission === 'denied' ? (
        <div className="n-banner denied">
          <span className="n-chip danger">被拒绝</span>
          <span className="grow">{deniedPermissionCopy(capability?.platform, data.bundleId)}</span>
          <button className="n-btn ghost mini" onClick={openSysPrefs}>打开系统设置</button>
          <button className="n-btn mini" onClick={requestPerm} disabled={busy}>申请权限</button>
        </div>
      ) : data.permission === 'unavailable' ? (
        <div className={`n-banner${permissionUnavailable.neutral ? ' neutral' : ''}`}>
          {permissionUnavailable.chip !== null && <span className="n-chip">{permissionUnavailable.chip}</span>}
          <span className="grow">{permissionUnavailable.text}</span>
        </div>
      ) : (
        <div className="n-banner">
          <span className="n-chip warn">未决定</span>
          <span className="grow">尚未向系统申请通知权限，首次申请会弹系统授权窗。</span>
          <button className="n-btn mini" onClick={requestPerm} disabled={busy}>申请权限</button>
          <button className="n-btn ghost mini" onClick={openSysPrefs}>打开系统设置</button>
        </div>
      )}

      {/* 总开关 */}
      <div className="n-card">
        <div className="n-setrow">
          <div>
            <b>启用桌面通知</b>
            <div className="n-note">总开关：关闭后所有场景一律静默（场景开关保留，重新开启即恢复）</div>
          </div>
          <span
            className={`n-switch ${data.config.enabled ? 'on' : ''}`}
            onClick={() => patch((c) => { c.enabled = !c.enabled })}
          />
        </div>
      </div>

      {/* 免打扰 */}
      <div className="n-card">
        <div className="n-setrow" style={{ marginBottom: 10 }}>
          <div>
            <b>免打扰时段</b>
            <div className="n-note">时段内通知静默（仍进系统通知中心）</div>
          </div>
          <span
            className={`n-switch ${data.config.dnd.on ? 'on' : ''}`}
            onClick={() => patch((c) => { c.dnd.on = !c.dnd.on })}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, opacity: data.config.dnd.on ? 1 : 0.45 }}>
          <span className="n-note" style={{ margin: 0 }}>从</span>
          <input
            className="n-time"
            type="time"
            value={data.config.dnd.from}
            disabled={!data.config.dnd.on}
            onChange={(e) => patch((c) => { c.dnd.from = e.target.value })}
          />
          <span className="n-note" style={{ margin: 0 }}>到</span>
          <input
            className="n-time"
            type="time"
            value={data.config.dnd.to}
            disabled={!data.config.dnd.on}
            onChange={(e) => patch((c) => { c.dnd.to = e.target.value })}
          />
        </div>
        <div className="n-setrow">
          <div>
            <b>全屏时静默</b>
            <div className="n-note">本应用窗口全屏时不弹横幅</div>
          </div>
          <span
            className={`n-switch ${data.config.dnd.suppressFullscreen ? 'on' : ''}`}
            onClick={() => patch((c) => { c.dnd.suppressFullscreen = !c.dnd.suppressFullscreen })}
          />
        </div>
        <div className="n-note">{focusSuppressHint()}</div>
      </div>

      {/* 场景 */}
      <div className="n-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <b style={{ fontSize: 13 }}>场景</b>
          <span className="n-note">每个场景独立开关与音效</span>
        </div>
        {grouped.map(({ gid, rows }) => (
          <div className="n-grp" key={gid}>
            <div className="n-gname">{groupLabel(gid)}</div>
            {rows.map((s) => {
              const conf = data.config.scenarios[s.id] ?? { enabled: s.defaultOn, sound: 'default' }
              // #74：已配置但本机播不了的音效，行里就要看得见（不只在被禁用的下拉项里）
              const soundWarning = configuredSoundWarning(capability, conf.sound)
              const failureNote = previewNote !== null && previewNote.id === s.id ? previewNote.text : null
              return (
                <div className="n-srow" key={s.id}>
                  <div className="n-sinfo">
                    <b>{s.name}</b>
                    <span className="n-mono" style={{ display: 'block' }}>{s.id} · {s.desc}</span>
                    {soundWarning !== null && (
                      <div className="n-note" style={{ color: 'var(--dsw-alias-state-warn,#e8a33d)' }}>
                        {soundWarning}
                      </div>
                    )}
                    {failureNote !== null && (
                      <div className="n-note" style={{ color: 'var(--dsw-alias-state-danger,#e5534b)' }}>
                        {failureNote}
                      </div>
                    )}
                  </div>
                  <span
                    className={`n-switch ${conf.enabled ? 'on' : ''}`}
                    onClick={() => patch((c) => {
                      const cur = c.scenarios[s.id] ?? { enabled: s.defaultOn, sound: 'default' }
                      c.scenarios[s.id] = { ...cur, enabled: !cur.enabled }
                    })}
                  />
                  <select
                    className="n-select"
                    style={{ minWidth: 126 }}
                    value={conf.sound}
                    onChange={(e) => {
                      const v = e.target.value
                      // 换了音效，上一次的试听结论就不算数了（#74）
                      setPreviewNote(null)
                      if (v === '__choose') chooseSound()
                      else patch((c) => {
                        const cur = c.scenarios[s.id] ?? { enabled: s.defaultOn, sound: 'default' }
                        c.scenarios[s.id] = { ...cur, sound: v === '__default' ? 'default' : v }
                      })
                    }}
                  >
                    <option value="default">系统默认</option>
                    <option value="none">无声</option>
                    {soundChoices.map((opt) => (
                      <option key={opt.value} value={opt.value} disabled={opt.disabled} title={opt.title}>
                        {opt.label}
                      </option>
                    ))}
                    <option value="__choose">自定义文件…</option>
                  </select>
                  <button
                    className="n-btn ghost mini"
                    title="试听"
                    onClick={() => previewSound(s.id, conf.sound)}
                  >
                    ▶
                  </button>
                </div>
              )
            })}
          </div>
        ))}
         <div className="n-note">
           自定义音效文件（wav / mp3 / ogg，≤5MB）导入后存放于数据目录 sounds/，可随时在下拉中切换或覆盖。{busy ? ' · 保存中…' : ''}
         </div>
         {soundHint !== null && (
           <div className="n-banner" style={{ marginTop: 10, marginBottom: 0 }}>
             <span className="n-chip warn">音效</span>
             <span className="grow">{soundHint}</span>
           </div>
         )}
        </div>
      </div>
  )
}

/** 注册「桌面通知」设置 tab（settings.section 槽位；同桌面设置模式）。 */
export function registerNotificationsTab(ctx: ClientContext): void {
  ensureStyles()
  const slots = (ctx as unknown as {
    slots?: {
      inject: (name: string, fn: () => void) => void
      register: (meta: Record<string, unknown>, comp: unknown) => void
    }
  }).slots
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
  slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: 'dsh-notification-settings', order: 41, label: () => '桌面通知' },
      NotificationSettingsPanel,
    ),
  )
}
