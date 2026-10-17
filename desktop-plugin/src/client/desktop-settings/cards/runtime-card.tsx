// 「dsh 运行时（版本下载 / 切换）」卡：内置运行时的版本目录、下载、切换、卸载。
//
// 这张卡里最要紧的不是 UI，是那两条「下载语义」的旧裁决，别在重构时顺手改掉：
// · 下载**不挂客户端超时**（#97 维护者裁决）。官方通道 120s 上限只会丢弃回包、不取消后台任务，
//   所以成败一律由 600ms 常驻轮询的 decideRuntimeDownload 定；那个 Promise 只回答「壳已受理」。
// · 「切 tab 会卸载本组件」是既有事实：useState 与未决 invoke 全部丢失而后台任务还在跑。
//   常驻轮询挂载即恢复进行中状态（进度条重现），这是唯一的真相源。
import React, { useCallback, useEffect, useState } from 'react'
import { PfBtn, SectionBox, showToast } from '../chrome.tsx'
import { DANGER_NOTE_STYLE, NOTE_STYLE } from '../styles.ts'
import { ThemeSelect } from '../../theme-select.tsx'
import {
  currentRuntimeLine,
  decideRuntimeDownload,
  isRuntimeInUse,
  runtimeDownloadButtonLabel,
  runtimeDownloadHint,
  sameDownloadEntry,
  stripDownloadErrorPrefix,
  type RuntimeDownloadEntry,
  type RuntimeDownloadSnapshot,
} from '../../runtime-download-ui.ts'
import { invoke, nsSave } from '../rpc.ts'
import type { Notify, RuntimeCatalog } from '../types.ts'

export function RuntimeCard({ notify }: { notify: Notify }): React.ReactElement {
  const [runtimeSource, setRuntimeSource] = useState<'github' | 'npm'>('github')
  const [runtimeStatus, setRuntimeStatus] = useState<{
    state: 'loading' | 'ok' | 'error'
    text?: string
  }>({ state: 'loading', text: '读取中…' })
  const [runtimeCatalog, setRuntimeCatalog] = useState<RuntimeCatalog | null>(null)
  // 下载状态：'downloading' | 'downloaded' | { failed: 原因 } | { cancelled: true }
  //（#95 失败必须带原因展示；#97 取消是独立终态，不与失败混同）
  const [runtimeDownloading, setRuntimeDownloading] = useState<
    Record<string, RuntimeDownloadEntry>
  >({})
  // pnpm 安装进度（后端轮询；remote 页 event.listen 不可用）
  const [dlProgress, setDlProgress] = useState<{
    version: string
    resolved: number
    downloaded: number
  } | null>(null)
  // 版本目录折叠（#95：列表太长，默认只显示各渠道头版 + 已安装）
  const [runtimeExpanded, setRuntimeExpanded] = useState(false)
  // #110：卸载中的版本（行级禁用态；删除可能数秒，期间按钮显示「卸载中…」）
  const [removingVersion, setRemovingVersion] = useState<string | null>(null)

  // ── 运行时目录：mount 拉一次，refreshRuntimes 显式刷新。──
  const refreshRuntimes = useCallback(async (): Promise<void> => {
    setRuntimeStatus({ state: 'loading', text: '读取版本目录中…' })
    try {
      const s = await invoke<RuntimeCatalog>('list_runtime_catalog', { source: runtimeSource })
      setRuntimeCatalog(s)
      setRuntimeStatus(
        s.error
          ? { state: 'error', text: `目录拉取失败：${s.error}（仅显示已下载版本）` }
          : { state: 'ok' },
      )
      setRuntimeDownloading({})
    } catch (err) {
      setRuntimeStatus({ state: 'error', text: `版本目录读取失败：${String(err)}` })
    }
  }, [runtimeSource])

  // #95 评论 Bug 3：弹窗重开时恢复后台下载中的状态（后端 DL_ACTIVE 仍 true）。
  // 挂在卡片上而不是面板：它写的正是 runtimeDownloading，跟 600ms 轮询同一份状态，分开放会分叉。
  useEffect(() => {
    void invoke<{ active: boolean; version: string }>('runtime_download_status')
      .then((s) => {
        if (s.active && s.version) {
          setRuntimeDownloading((prev) => ({ ...prev, [s.version]: 'downloading' }))
        }
      })
      .catch(() => {})
  }, [])
  useEffect(() => {
    void refreshRuntimes()
  }, [refreshRuntimes])

  const handleDownloadRuntime = (version: string): void => {
    setRuntimeDownloading((prev) => ({ ...prev, [version]: 'downloading' }))
    // #97：**不挂客户端超时**（维护者裁决：下载类调用无超时限制）。官方通道 120s 上限只会丢弃回包、
    // 不取消后台任务，所以成败一律由轮询快照定，这个 Promise 只回答「壳已受理」。
    void invoke('download_runtime', { source: runtimeSource, version }, { noTimeout: true })
      .then(() => {
        // 终态（成功 / 失败 / 取消）由轮询的 decideRuntimeDownload 落。这里要是直接写「已下载」，
        // 下一拍的 active 又会把它打回「下载中」——状态来回闪就是这么来的。
        void refreshRuntimes()
      })
      .catch((err) => {
        const text = String(err)
        if (text.includes('已有运行时下载任务')) {
          // 后端单飞行：真实任务仍在跑，常驻轮询会在 600ms 内恢复 downloading 态，
          // 不能标成失败（否则用户会去点重试，永远撞墙）。
          setRuntimeDownloading((prev) => {
            const next = { ...prev }
            delete next[version]
            return next
          })
          return
        }
        // #95 评论：失败原因必须落到 UI，不能只打 console
        const reason = stripDownloadErrorPrefix(text)
        setRuntimeDownloading((prev) => ({ ...prev, [version]: { failed: reason || '未知错误' } }))
        showToast(`dsh ${version} 下载失败：${reason || '未知错误'}`, false)
      })
  }

  // #97：取消运行时下载——取消是用户唯一的主动出口（下载不再有时间限制）。
  // 终态仍由轮询落；这里只回报「取消已受理」，官方通道的回包可能被 120s 上限丢掉，不能等它。
  const handleCancelRuntimeDownload = (version: string): void => {
    void invoke<{ cancelled: boolean; version: string }>('cancel_runtime_download', {}, { noTimeout: true })
      .then((r) => {
        if (r.cancelled) showToast(`正在取消 dsh ${version} 下载…`, true, 'info')
      })
      .catch((err) => showToast(`取消失败：${String(err)}`, false))
  }

  // 下载状态以后端 runtime_download_status 为唯一事实源（#135 验证反馈）：
  // 设置弹窗切 tab 会卸载本组件——useState 与未决 invoke 全部丢失，而后台任务仍在跑。
  // 常驻轮询：挂载即恢复进行中状态（进度条重现）；观察到 active true→false 时按 error 判定成败。
  useEffect(() => {
    let sawActive = false
    const timer = setInterval(() => {
      void invoke<RuntimeDownloadSnapshot>('runtime_download_status')
        .then((s) => {
          // #97：终态判定收进纯函数（scripts/test-client.mjs 直接断言）。
          // 这段原先散在 then 分支里，于是三个坑一起长：超时弹窗后进度条永久卡住、
          // 取消被报成红色失败、以及终态被下一拍的 active 覆盖。
          const decision = decideRuntimeDownload(s, sawActive)
          if (s.active) sawActive = true
          else if (sawActive) sawActive = false
          // 非进行中一律撤进度条：超时弹窗一关就再没人动它，不撤就是永久定格
          setDlProgress(decision.progress)
          const entry = decision.entry
          if (entry !== null) {
            const version = entry.version
            if ('remove' in entry) {
              setRuntimeDownloading((prev) => {
                if (prev[version] === undefined) return prev
                const next = { ...prev }
                delete next[version]
                return next
              })
            } else {
              const value = entry.value
              setRuntimeDownloading((prev) =>
                // 同值不重写：否则每 600ms 一拍会把终态反复重置，失败原因闪一下就没
                sameDownloadEntry(prev[version], value) ? prev : { ...prev, [version]: value },
              )
            }
          }
          const toast = decision.toast
          if (toast !== null) {
            showToast(toast.text, toast.tone === 'ok', toast.tone === 'info' ? 'info' : undefined)
            void refreshRuntimes()
          }
        })
        .catch(() => {})
    }, 600)
    return () => clearInterval(timer)
  }, [refreshRuntimes])

  const handleSwitchRuntime = (version: string): void => {
    // 运行时切换 = 把设置里的运行时钉成目标版本，然后重启让它生效。
    // #97：内置那一行也写**版本号**（旧写法置 null，因为顶行当时读的是设置值、会误显示成「运行时」；
    // 顶行已改成按实际在跑的树派生，null 就只剩坏处——它和「没设置过」长得一模一样，壳无法区分，
    // 于是「切回内置」会被当成没设置，进而拿已装最高版本顶上，看着像切换失败）。
    void nsSave({ dsh_runtime: version, dsh_mode: 'builtin' })
      .then(() => invoke('restart_dsh_service'))
      .then(() => {
        notify({ ok: true, text: `已切换到 dsh ${version}，正在重启…` })
        void refreshRuntimes()
      })
      .catch((err) => notify({ ok: false, text: `切换失败：${String(err)}` }))
  }

  const handleRemoveRuntime = (version: string): void => {
    // #104/#110：卸载已下载运行时，后端 async+spawn_blocking（不阻塞 UI）；错误文案可观测。
    if (removingVersion) return
    if (!window.confirm(`卸载运行时 dsh ${version}？将删除本地已下载文件，不可恢复。`)) return
    setRemovingVersion(version)
    invoke('remove_runtime', { version })
      .then(() => {
        notify({ ok: true, text: `已卸载运行时 dsh ${version}` })
        void refreshRuntimes()
      })
      .catch((err) => notify({ ok: false, text: `卸载失败：${String(err)}` }))
      .finally(() => setRemovingVersion(null))
  }

  return (
    <SectionBox title="dsh 运行时（版本下载 / 切换）">
      <ThemeSelect
        style={{ marginBottom: 8 }}
        value={runtimeSource}
        onChange={(v) => setRuntimeSource(v as 'github' | 'npm')}
        options={[
          { value: 'github', label: '下载源：GitHub Releases' },
          { value: 'npm', label: '下载源：npm registry' },
        ]}
      />
      <PfBtn variant="ghost" onClick={() => void refreshRuntimes()}>刷新版本目录</PfBtn>
      <div style={{ marginTop: 8 }}>
        {runtimeStatus.state === 'error' && runtimeStatus.text && (
          <div style={DANGER_NOTE_STYLE}>{runtimeStatus.text}</div>
        )}
        {runtimeCatalog && (
          <>
            <div style={{ marginBottom: 6 }}>
              {/* #97：判据是**实际在跑的那棵树**（catalog.running），不再拿设置里钉的 selected 当「当前使用」 */}
              {
                currentRuntimeLine({
                  selected: runtimeCatalog.selected,
                  builtin: runtimeCatalog.builtin,
                  running: runtimeCatalog.running,
                })
              }
            </div>
            {runtimeCatalog.note && (
              <div style={{ ...DANGER_NOTE_STYLE, marginBottom: 6, whiteSpace: 'pre-wrap' }}>{`⚠ ${runtimeCatalog.note}`}</div>
            )}
            {(() => {
              // 折叠（#95）：默认只显示各渠道头版 + 已下载版本，其余收进「展开全部」
              const seen = new Set<string>()
              const heads: typeof runtimeCatalog.catalog = []
              for (const ch of ['latest', 'alpha', 'rc']) {
                const e = runtimeCatalog.catalog.find((c) => c.channel === ch)
                if (e && !seen.has(e.version)) {
                  seen.add(e.version)
                  heads.push(e)
                }
              }
              const installedPinned = runtimeCatalog.catalog.filter(
                (c) =>
                  !seen.has(c.version) &&
                  runtimeCatalog.installed.some((i) => i.version === c.version),
              )
              const rest = runtimeCatalog.catalog.filter((c) => !seen.has(c.version))
              // #107 并集渲染：installed 中不在 catalog 的版本（目录拉取失败/版本已下架）也要可见
              const installedOnly = runtimeCatalog.installed
                .filter((i) => !runtimeCatalog.catalog.some((c) => c.version === i.version))
                .map((i) => ({ version: i.version, channel: '' }))
              // 补：内置版本同样可能不在 catalog（目录拉取失败时）——必须可见以切回内置
              if (
                runtimeCatalog.builtin &&
                !runtimeCatalog.catalog.some((c) => c.version === runtimeCatalog.builtin) &&
                !installedOnly.some((i) => i.version === runtimeCatalog.builtin)
              ) {
                installedOnly.unshift({ version: runtimeCatalog.builtin, channel: '' })
              }
              const visible = runtimeExpanded
                ? [...runtimeCatalog.catalog, ...installedOnly]
                : [...heads, ...installedPinned, ...installedOnly.filter((i) => !seen.has(i.version))]
              return (
                <>
                  {visible.map((c) => {
                    const installed = runtimeCatalog.installed.some((i) => i.version === c.version)
                    // #113：内置随包分发（不在 installed 数组）——可切换、标「内置」、不显示下载
                    const isBuiltin = runtimeCatalog.builtin === c.version
                    // 运行中的那棵树（多为 dev 用 DSH_SHELL_RUNTIME_DIR 指着的树）：它不是「可下载」的东西，
                    // 也不该显示下载按钮（用户报：内置正在用的版本还能下载）
                    const isRunning =
                      runtimeCatalog.running?.version !== null &&
                      runtimeCatalog.running?.version !== undefined &&
                      runtimeCatalog.running.version === c.version
                    const available = installed || isBuiltin || isRunning
                    // #97：「使用中」只看**实际在跑的那棵树**。旧判据 selected 为空时回退
                    // `isBuiltin || isRunning`，于是内置行和运行行同时标上「使用中」（症状⑤）。
                    const isCurrent = isRuntimeInUse(
                      {
                        selected: runtimeCatalog.selected,
                        builtin: runtimeCatalog.builtin,
                        running: runtimeCatalog.running,
                      },
                      c.version,
                    )
                    const tags: string[] = []
                    if (c.channel) tags.push(c.channel)
                    if (isBuiltin) tags.push('内置')
                    else if (installed) tags.push('已下载')
                    if (isRunning) tags.push('运行中')
                    const downloadState = runtimeDownloading[c.version]
                    const failedReason = runtimeDownloadHint(downloadState)
                    const pct =
                      dlProgress && dlProgress.version === c.version && dlProgress.resolved > 0
                        ? Math.min(100, Math.round((dlProgress.downloaded / dlProgress.resolved) * 100))
                        : 0
                    return (
                      <div key={c.version} style={{ margin: '4px 0' }}>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <span>{`${c.version}${tags.length ? '（' + tags.join(' · ') + '）' : ''}`}</span>
                          {!available ? (
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <PfBtn
                                variant="ghost"
                                disabled={downloadState === 'downloading'}
                                onClick={() => handleDownloadRuntime(c.version)}
                              >
                                {runtimeDownloadButtonLabel(downloadState)}
                              </PfBtn>
                              {/* #97：下载进行中就给一个出口——取消。维护者定了「下载不超时」，
                              取消于是成了用户唯一的主动手段，没有它就只能干等。 */}
                              {downloadState === 'downloading' && (
                                <PfBtn variant="ghost" onClick={() => handleCancelRuntimeDownload(c.version)}>
                                  取消
                                </PfBtn>
                              )}
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <PfBtn
                                variant="ghost"
                                disabled={isCurrent}
                                onClick={() => handleSwitchRuntime(c.version)}
                              >
                                {isCurrent ? '使用中' : '切换到此版本'}
                              </PfBtn>
                              {/* Q3：内置行不显示卸载——它随应用分发，本来就删不掉 */}
                              {!isBuiltin && (
                                <PfBtn
                                  variant="danger"
                                  disabled={removingVersion !== null || isRunning || runtimeCatalog.selected === c.version}
                                  title={
                                    isRunning
                                      ? '正在运行的版本不可卸载'
                                      : runtimeCatalog.selected === c.version
                                        ? '使用中的版本不可卸载，请先切换'
                                        : '删除本地已下载的运行时'
                                  }
                                  onClick={() => handleRemoveRuntime(c.version)}
                                >
                                  {removingVersion === c.version ? '卸载中…' : '卸载'}
                                </PfBtn>
                              )}
                            </div>
                          )}
                        </div>
                        {downloadState === 'downloading' && (
                          <div style={{ marginTop: 4 }}>
                            <div
                              style={{
                                height: 6,
                                borderRadius: 4,
                                background: 'var(--dsw-alias-bg-base,#111)',
                                overflow: 'hidden',
                              }}
                            >
                              <div
                                style={{
                                  height: '100%',
                                  width: `${pct}%`,
                                  background: 'var(--dsw-alias-state-accent-primary,#3b82f6)',
                                  transition: 'width .3s',
                                }}
                              />
                            </div>
                            <div style={NOTE_STYLE}>
                              {dlProgress && dlProgress.version === c.version
                                ? `安装依赖：已下载 ${dlProgress.downloaded} / ${dlProgress.resolved || '…'} 个包${
                                    dlProgress.resolved > 0 ? `（${pct}%）` : ''
                                  }`
                                : '准备中…'}
                            </div>
                          </div>
                        )}
                        {failedReason && (
                          <div
                            style={{
                              // #97：取消是中性终态，不能穿红色警告色、也不能顶着「下载失败：」的前缀
                              ...(downloadState !== undefined &&
                              typeof downloadState === 'object' &&
                              'cancelled' in downloadState
                                ? NOTE_STYLE
                                : DANGER_NOTE_STYLE),
                              marginTop: 4,
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            {failedReason}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {rest.length > 0 && !runtimeExpanded && (
                    <PfBtn variant="ghost" style={{ marginTop: 4 }} onClick={() => setRuntimeExpanded(true)}>
                      展开全部 {runtimeCatalog.catalog.length} 个版本 ▾
                    </PfBtn>
                  )}
                  {runtimeExpanded && (
                    <PfBtn variant="ghost" style={{ marginTop: 4 }} onClick={() => setRuntimeExpanded(false)}>
                      收起版本列表 ▴
                    </PfBtn>
                  )}
                </>
              )
            })()}
          </>
        )}
      </div>
    </SectionBox>
  )
}
