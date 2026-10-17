// 「代理设置」卡：模式 / URL / NO_PROXY / 凭证 + 连通性测试。
//
// 两个分支口径是旧的、也是对的，别"统一"：NO_PROXY 只在 manual 下可编辑（system 模式后端读系统设置，
// 页面改了不生效，给个能编辑的框等于骗人）；凭证两种模式都生效（拼进代理 URL）。
import React, { useEffect, useRef, useState } from 'react'
import { PfBtn, SectionBox } from '../chrome.tsx'
import { FLEX_1_STYLE, INPUT_FULL_STYLE, LABEL_STYLE, NOTE_STYLE } from '../styles.ts'
import { ThemeSelect } from '../../theme-select.tsx'
import { invoke, nsSave } from '../rpc.ts'
import type { InitialData } from '../use-initial-data.ts'
import type { Notify, ProxySettings } from '../types.ts'

export function ProxyCard({
  proxy,
  proxyEffective,
  loaded,
  notify,
}: {
  proxy: ProxySettings
  proxyEffective: ProxySettings['effective']
  loaded: InitialData | null
  notify: Notify
}): React.ReactElement {
  // 代理五个字段在面板里是**一份可编辑草稿**：切 tab 不该把没保存的编辑冲掉，
  // 但壳首次回话后必须由它填初值。用 `loaded`（首次快照）做一次性回填。
  const [draft, setDraft] = useState<ProxySettings>(proxy)
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testBusy, setTestBusy] = useState(false)

  const filledRef = useRef(false)
  useEffect(() => {
    if (!loaded || filledRef.current) return
    filledRef.current = true
    setDraft(loaded.proxy)
  }, [loaded])

  const set = <K extends keyof ProxySettings>(key: K, value: ProxySettings[K]): void => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const handleSaveProxy = (): void => {
    if (busy) return
    setBusy(true)
    void (async () => {
      try {
        await nsSave({
          proxy_mode: draft.proxy_mode,
          proxy_url: draft.proxy_url,
          no_proxy: draft.no_proxy,
          proxy_user: draft.proxy_user,
          proxy_pass: draft.proxy_pass,
        })
        notify({ ok: true, text: '代理设置已保存；下次 dsh 重启后生效。' })
      } catch (err) {
        notify({ ok: false, text: `保存失败：${String(err)}` })
      } finally {
        setBusy(false)
      }
    })()
  }

  const handleTestProxy = (): void => {
    if (testBusy) return
    setTestBusy(true)
    setTestResult(null)
    void (async () => {
      try {
        const ms = await invoke<number>('test_proxy_connectivity', { url: draft.proxy_url })
        setTestResult(`连接成功（${ms}ms）`)
      } catch (err) {
        setTestResult(`连接失败：${String(err)}`)
      } finally {
        setTestBusy(false)
      }
    })()
  }

  return (
    <SectionBox title="代理设置">
      <div style={LABEL_STYLE}>代理模式</div>
      <ThemeSelect
        style={{ marginBottom: 10 }}
        value={draft.proxy_mode}
        onChange={(v) => set('proxy_mode', v)}
        options={[
          { value: 'off', label: '不使用代理' },
          { value: 'system', label: '跟随系统代理' },
          { value: 'manual', label: '手动指定代理' },
        ]}
      />

      {draft.proxy_mode === 'manual' && (
        <>
          <div style={LABEL_STYLE}>代理 URL</div>
          <input
            placeholder="http/https/socks5://host:port"
            value={draft.proxy_url}
            className="pf-input"
            style={INPUT_FULL_STYLE}
            data-desktop-settings="proxy-url"
            onChange={(e) => set('proxy_url', e.target.value.trim())}
          />
        </>
      )}

      {/* #102：NO_PROXY 为 manual 专属（system 模式下后端读系统设置，编辑不生效）；凭证两种模式都生效（拼入代理 URL） */}
      {(draft.proxy_mode === 'manual' || draft.proxy_mode === 'system') && (
        <>
          {draft.proxy_mode === 'manual' && (
            <>
              <div style={LABEL_STYLE}>NO_PROXY（不走代理的地址，逗号分隔）</div>
              <input
                placeholder="localhost,127.0.0.1,*.internal"
                value={draft.no_proxy}
                className="pf-input"
                style={INPUT_FULL_STYLE}
                data-desktop-settings="no-proxy"
                onChange={(e) => set('no_proxy', e.target.value.trim())}
              />
            </>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <div style={FLEX_1_STYLE}>
              <div style={LABEL_STYLE}>用户名（可选）</div>
              <input
                value={draft.proxy_user}
                className="pf-input"
                style={INPUT_FULL_STYLE}
                data-desktop-settings="proxy-user"
                onChange={(e) => set('proxy_user', e.target.value)}
              />
            </div>
            <div style={FLEX_1_STYLE}>
              <div style={LABEL_STYLE}>密码（可选）</div>
              <input
                type="password"
                value={draft.proxy_pass}
                className="pf-input"
                style={INPUT_FULL_STYLE}
                data-desktop-settings="proxy-pass"
                onChange={(e) => set('proxy_pass', e.target.value)}
              />
            </div>
          </div>
        </>
      )}

      {proxyEffective && (
        <div style={NOTE_STYLE}>当前生效：{JSON.stringify(proxyEffective)}</div>
      )}
      {draft.proxy_mode === 'system' && (
        <div style={NOTE_STYLE}>系统代理模式下，代理地址与 NO_PROXY 来自系统设置（如 Windows 注册表 ProxyOverride）；用户名/密码仍取自设置并拼入代理地址。</div>
      )}

      {draft.proxy_mode === 'manual' && draft.proxy_url && (
        <>
          <div style={{ marginTop: 8 }}>
            <PfBtn variant="ghost" onClick={handleTestProxy}>
              {testBusy ? '测试中…' : '测试连接'}
            </PfBtn>
          </div>
          {testResult && <div style={NOTE_STYLE}>{testResult}</div>}
        </>
      )}
      {/* #128：保存按钮原本落在 </SectionBox> 之后（面板里唯一的例外），与其它卡的「按钮在卡内」惯例对齐 */}
      <div style={{ marginTop: 10 }}>
        <PfBtn variant="primary" disabled={busy} onClick={handleSaveProxy}>
          {busy ? '保存中…' : '保存代理设置'}
        </PfBtn>
      </div>
    </SectionBox>
  )
}
