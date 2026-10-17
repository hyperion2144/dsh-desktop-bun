// 「Profile 端口」卡（#90）：lane 转发器口 + 每个 profile 的三个端口（上游 / 页面口 / lane）。
//
// 端口表与四个输入框的初值都是**只回填一次**的：壳第一次回话之后，用户在框里的编辑必须活下来，
// 任何后续的 data 刷新都不能把它们冲掉。所以这里拿 `loaded`（首次快照、引用此后不变）而不是 `data`。
import React, { useEffect, useRef, useState } from 'react'
import { PfBtn, PortCell, SectionBox } from '../chrome.tsx'
import { DANGER_NOTE_STYLE, INPUT_BASE_STYLE, LABEL_STYLE, NOTE_STYLE, ROW_STYLE } from '../styles.ts'
import { invoke, nsSave } from '../rpc.ts'
import type { InitialData } from '../use-initial-data.ts'
import type { ProfilePortRow } from '../types.ts'

export function ProfilePortsCard({ loaded }: { loaded: InitialData | null }): React.ReactElement {
  const [profilePorts, setProfilePorts] = useState<ProfilePortRow[]>([])
  const [profilePortsStatus, setProfilePortsStatus] = useState<{
    state: 'loading' | 'ok' | 'error'
    text?: string
  }>({ state: 'loading', text: '加载中…' })
  const [profilePortInputs, setProfilePortInputs] = useState<Record<string, string>>({})
  const [profileLaneInputs, setProfileLaneInputs] = useState<Record<string, string>>({})
  const [profilePageInputs, setProfilePageInputs] = useState<Record<string, string>>({})
  const [forwarderInput, setForwarderInput] = useState('')
  const [profilePortBoxNote, setProfilePortBoxNote] = useState<string | null>(null)

  // 四个输入框：壳首次回话时填一次，之后用户改什么就是什么。
  const inputsFilledRef = useRef(false)
  useEffect(() => {
    if (!loaded || inputsFilledRef.current) return
    inputsFilledRef.current = true
    setForwarderInput(loaded.forwarderInput)
    setProfilePortInputs(loaded.profilePortInputs)
    setProfileLaneInputs(loaded.profileLaneInputs)
    setProfilePageInputs(loaded.profilePageInputs)
  }, [loaded])

  // 端口表：mount 拉取；失败重试 ≤2 次，每次 800ms。
  useEffect(() => {
    let cancelled = false
    let attempt = 0
    const load = (): void => {
      invoke<ProfilePortRow[]>('list_profile_ports')
        .then((rows) => {
          if (cancelled) return
          setProfilePorts(rows)
          setProfilePortsStatus({ state: 'ok' })
        })
        .catch((err) => {
          if (cancelled) return
          if (attempt < 2) {
            attempt += 1
            setProfilePortsStatus({ state: 'loading', text: `加载失败，重试中（${attempt}/2）…` })
            window.setTimeout(load, 800)
          } else {
            setProfilePortsStatus({
              state: 'error',
              text: `端口表加载失败：${String(err)}（请重启 dsh 后重试）`,
            })
          }
        })
    }
    load()
    return () => { cancelled = true }
  }, [])

  const parsePortInput = (raw: string): number | null => {
    const v = Number(raw)
    return !raw || Number.isNaN(v) || v < 1 || v > 65535 ? null : v
  }

  const savePortSetting = (key: string, v: number, note: string): void => {
    void nsSave({ [key]: v })
      .then(() => setProfilePortBoxNote(note))
      .catch((e) => setProfilePortBoxNote(`保存失败：${String(e)}`))
  }

  const handleSaveProfilePort = (profile: string): void => {
    const v = parsePortInput(profilePortInputs[profile] ?? '')
    if (v === null) return
    savePortSetting(`profile_ports.${profile}`, v, `${profile} 上游端口已改为 ${v}；重启该 profile 生效。`)
  }

  const handleSaveProfileLanePort = (profile: string): void => {
    const v = parsePortInput(profileLaneInputs[profile] ?? '')
    if (v === null) return
    savePortSetting(`profile_lane_ports.${profile}`, v, `${profile} lane 端口已改为 ${v}；重启该 profile 生效。`)
  }

  // 页面口＝loopback origin 的端口：换口＝换浏览器本地存储（#22 Q1：保存必须二次确认 + 常驻警示）。
  const handleSaveProfilePagePort = (profile: string): void => {
    const v = parsePortInput(profilePageInputs[profile] ?? '')
    if (v === null) return
    const ok = window.confirm(
      `${profile} 页面口将改为 ${v}：换口＝换浏览器本地存储（localStorage/IndexedDB 留在旧口）。确认修改？`,
    )
    if (!ok) return
    savePortSetting(`profile_page_ports.${profile}`, v, `${profile} 页面口已改为 ${v}；重启该 profile 生效。`)
  }

  const handleSaveForwarderPort = (): void => {
    const v = parsePortInput(forwarderInput.trim())
    if (v === null) return
    savePortSetting('lane_forwarder_port', v, `lane 转发器端口已改为 ${v}；重启壳生效。`)
  }

  return (
    <SectionBox title="Profile 端口">
      <div style={{ ...ROW_STYLE, marginBottom: 10 }}>
        <span style={LABEL_STYLE}>壳 lane 转发器口（重启壳生效）</span>
        <input
          style={{ ...INPUT_BASE_STYLE, width: 84 }}
          data-desktop-settings="lane-forwarder-port"
          placeholder="3091"
          value={forwarderInput}
          onChange={(e) => setForwarderInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSaveForwarderPort()
          }}
        />
        <PfBtn variant="ghost" onClick={handleSaveForwarderPort}>保存</PfBtn>
      </div>
      {profilePortsStatus.state === 'ok' ? (
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Profile', 'dsh 端口（上游）', '页面口（loopback）', 'Lane 端口', '状态', ''].map((h) => (
                <th key={h} style={{ textAlign: 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {profilePorts.map((r) => (
              <tr key={r.profile}>
                <td>{r.profile}</td>
                <td>
                  <PortCell
                    testId={`profile-port-${r.profile}`}
                    placeholder={String(r.upstream_port)}
                    value={profilePortInputs[r.profile] ?? ''}
                    onChange={(v) => setProfilePortInputs((prev) => ({ ...prev, [r.profile]: v }))}
                    onEnter={() => handleSaveProfilePort(r.profile)}
                    onSave={() => handleSaveProfilePort(r.profile)}
                  />
                </td>
                <td>
                  <PortCell
                    testId={`profile-page-port-${r.profile}`}
                    placeholder={r.page_port > 0 ? String(r.page_port) : '启动时分配'}
                    value={profilePageInputs[r.profile] ?? ''}
                    onChange={(v) => setProfilePageInputs((prev) => ({ ...prev, [r.profile]: v }))}
                    onEnter={() => handleSaveProfilePagePort(r.profile)}
                    onSave={() => handleSaveProfilePagePort(r.profile)}
                  />
                </td>
                <td>
                  <PortCell
                    testId={`profile-lane-port-${r.profile}`}
                    placeholder={String(r.lane_port)}
                    value={profileLaneInputs[r.profile] ?? ''}
                    onChange={(v) => setProfileLaneInputs((prev) => ({ ...prev, [r.profile]: v }))}
                    onEnter={() => handleSaveProfileLanePort(r.profile)}
                    onSave={() => handleSaveProfileLanePort(r.profile)}
                  />
                </td>
                <td
                  style={{
                    color: r.running
                      ? 'var(--dsw-alias-state-success-primary,#2fbf71)'
                      : 'var(--dsw-alias-label-secondary,#9aa4b2)',
                  }}
                >
                  {r.running ? '● 运行中' : '未运行'}
                </td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      ) : profilePortsStatus.state === 'error' ? (
        <div style={DANGER_NOTE_STYLE}>{profilePortsStatus.text}</div>
      ) : (
        <div style={NOTE_STYLE}>{profilePortsStatus.text ?? '加载中…'}</div>
      )}
      {profilePortBoxNote && <div style={NOTE_STYLE}>{profilePortBoxNote}</div>}
      <div style={NOTE_STYLE}>
        上游（dsh 实例）：web 3080 · desktop 3081 · 其余 3082 起散列避让；lane（手机代理）：web 3092 · desktop 3093 ·
        其余 3094 起散列；页面口（loopback origin）：6390 起 40 个顺延。改动后重启该 profile 生效；
        输入框显示的是已保存的期望值，灰字 placeholder 是当前实际值。
      </div>
      <div style={DANGER_NOTE_STYLE}>
        ⚠️ 改页面口＝换浏览器本地存储：localStorage / IndexedDB / 登录态留在旧端口，不会跟随到新口；转发器口改动需重启壳。
      </div>
    </SectionBox>
  )
}
