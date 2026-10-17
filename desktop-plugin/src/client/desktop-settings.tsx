// 桌面设置 Tab 入口：注册 `settings.section` 插槽，并只做编排（见 DesktopSettingsPanel 的注释）。
// 纯 React JSX + hooks 重写（先前是 React 入口 + document.createElement 手拼 DOM 的混合写法，已被否决）：
// 禁止 document.createElement / innerHTML / appendChild，UI 全部由 JSX 返回；状态 useState/useEffect/useCallback 声明式管理。
// （唯一例外是下面 `check_startup_needed` 的两个启动检查弹窗仍是手拼 DOM——那是壳发起的独立流程，不属于面板，留在 #129 处理。）
//
// #144 分层：本文件过去是 2341 行的单体——类型、样式、RPC 通道、通用外壳件、15 张卡，加一个 1790 行的
// DesktopSettingsPanel 全挤在一处；卡片层想复用 SectionBox/PfBtn 就得反向 import 入口，于是入口与卡片互为依赖。
// 现在入口只留「注册 + 编排」，其余按职责下沉：types / rpc / styles / chrome / loopback-aggregation / format / cards。
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientContext } from './ctx-types.ts'
import { shellRpc } from './shell-rpc.ts'
import { ensureStyles, NOTE_STYLE, ROOT_STYLE } from './desktop-settings/styles.ts'
import { captureNsRpc, hasNsRpc, invoke } from './desktop-settings/rpc.ts'
import { showToast } from './desktop-settings/chrome.tsx'
import { useInitialData } from './desktop-settings/use-initial-data.ts'
import type { BannerMsg, Notify } from './desktop-settings/types.ts'
import { DependenciesCard } from './desktop-settings/cards/dependencies-card.tsx'
import { DevToolsCard } from './desktop-settings/cards/devtools-card.tsx'
import { DiagnosticsCard } from './desktop-settings/cards/diagnostics-card.tsx'
import { DownloadCard } from './desktop-settings/cards/download-card.tsx'
import { LoopbackAggregationCard } from './desktop-settings/cards/loopback-aggregation-card.tsx'
import { MigrationCard } from './desktop-settings/cards/migration-card.tsx'
import { MobileAccessCard } from './desktop-settings/cards/mobile-access-card.tsx'
import { PowerCard } from './desktop-settings/cards/power-card.tsx'
import { ProfileCard } from './desktop-settings/cards/profile-card.tsx'
import { ProfilePortsCard } from './desktop-settings/cards/profile-ports-card.tsx'
import { ProxyCard } from './desktop-settings/cards/proxy-card.tsx'
import { RuntimeCard } from './desktop-settings/cards/runtime-card.tsx'
import { ServiceAddressCard } from './desktop-settings/cards/service-address-card.tsx'
import { SourceCard } from './desktop-settings/cards/source-card.tsx'
import { UpdateCard } from './desktop-settings/cards/update-card.tsx'
import { nsSave } from './desktop-settings/rpc.ts'

export const inject = ['slots']

// ── 主组件 ──────────────────────────────────────────
/**
 * 面板 = 编排。卡片自己拥有自己的状态、自己的轮询、自己的回执文案；
 * 这里只剩三样跨卡的东西，每一样都必须留在这一层，因为它们天然跨卡：
 *   · msg       —— 顶部横幅。十几张卡的保存回执都往这儿发（ServiceAddress / Profile / Runtime / Proxy…）。
 *   · taskInfo  —— 长任务卡。新建/迁移/依赖重建共用一个 600ms 轮询，谁在跑就显示谁。
 *   · downloadBoxNote —— 下载卡与手机访问卡**共用**的一条回执（旧的跨卡耦合，见 download-card.tsx 头注）。
 * 其余每个字段都有唯一的归属卡片，数据靠 props 切片下去。
 */
function DesktopSettingsPanel(): React.ReactElement {
  const [msg, setMsg] = useState<BannerMsg | null>(null)
  const notify: Notify = useCallback((m: BannerMsg) => setMsg(m), [])
  // 成功 toast 4 秒自动消失；错误 toast 手动点击关闭
  useEffect(() => {
    if (msg && msg.ok) {
      const t = window.setTimeout(() => setMsg(null), 4000)
      return () => window.clearTimeout(t)
    }
  }, [msg])

  // 通用长任务状态（#95 拒绝静默）：新建/迁移的任务卡全程可见
  const [taskInfo, setTaskInfo] = useState<{
    running: boolean
    finished: boolean
    kind: string
    title: string
    stage: string
    done: number
    total: number
    error: string
    result: string
  } | null>(null)
  useEffect(() => {
    const timer = setInterval(() => {
      void invoke<{
        running: boolean; finished: boolean; kind: string; title: string; stage: string;
        done: number; total: number; error: string; result: string
      }>('task_status')
        .then((t) => {
          // 任务开启或进行中刷新；结束后保留末态（直到下一次任务开始）
          if (t.running || t.finished) setTaskInfo(t)
        })
        .catch(() => {})
    }, 600)
    return () => clearInterval(timer)
  }, [])

  // 下载 section 内嵌反馈（保留原 note(box, …) 行为）
  const [downloadBoxNote, setDownloadBoxNote] = useState<string | null>(null)

  useEffect(() => {
    ensureStyles()
  }, [])

  // 首次挂载拉齐所有设置数据（一次 fetch → 一份切片）。
  const { data, loaded, refreshData } = useInitialData((text) => notify({ ok: false, text }))
  const { desktop, proxy, proxyEffective, loopbackAggregation } = data

  return (
    <div data-desktop-settings="" style={ROOT_STYLE}>
      {taskInfo && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            marginBottom: 10,
            fontSize: 12,
            background: 'var(--dsw-alias-bg-base,#16181d)',
            border: taskInfo.finished
              ? taskInfo.error
                ? '1px solid rgba(239,68,68,.6)'
                : '1px solid rgba(34,197,94,.5)'
              : '1px solid var(--dsw-alias-border-neutral,#2a2e37)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {taskInfo.running ? '⏳ ' : taskInfo.error ? '✗ ' : '✓ '}
            {taskInfo.title}
          </div>
          {taskInfo.running && (
            <>
              <div style={{ opacity: 0.8 }}>{taskInfo.stage || '准备中…'}</div>
              {taskInfo.total > 0 && (
                <>
                  <div
                    style={{
                      height: 5,
                      borderRadius: 3,
                      marginTop: 6,
                      overflow: 'hidden',
                      background: 'rgba(127,127,127,.25)',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.min(100, Math.round((taskInfo.done / taskInfo.total) * 100))}%`,
                        background: 'var(--dsw-alias-state-accent-primary,#3b82f6)',
                        transition: 'width .3s',
                      }}
                    />
                  </div>
                  <div style={{ opacity: 0.6, marginTop: 3 }}>
                    {taskInfo.done}/{taskInfo.total}
                  </div>
                </>
              )}
            </>
          )}
          {taskInfo.finished && taskInfo.error && (
            <div style={{ color: '#f87171', whiteSpace: 'pre-wrap' }}>{taskInfo.error}</div>
          )}
          {taskInfo.finished && !taskInfo.error && taskInfo.result && (
            <div style={{ opacity: 0.85 }}>{taskInfo.result}</div>
          )}
        </div>
      )}

      {/* 卡片顺序＝历史 DOM 顺序（#144 不改外观）。每张卡的内部实现都在 cards/ 下。 */}
      <SourceCard />
      <ServiceAddressCard desktop={desktop} refreshData={refreshData} notify={notify} />
      <ProfileCard desktop={desktop} notify={notify} />
      <ProfilePortsCard loaded={loaded} />
      <MigrationCard profiles={desktop.profiles} loaded={loaded} notify={notify} />
      {/* 顺序＝拆分前那个单文件的真实 DOM 顺序。这一段（日志与诊断 → 应用更新 → dsh 运行时 → 依赖状态）
          第一次拆的时候把「应用更新」和「dsh 运行时」写反了，靠「与拆分前文件逐项 diff 标题序列」才发现——
          这类相邻卡的错位肉眼扫不出来，改这里的顺序前先跑 probe/panel-order.ts 对一遍。 */}
      <DiagnosticsCard />
      <UpdateCard />
      <RuntimeCard notify={notify} />
      <DependenciesCard />
      <DownloadCard note={downloadBoxNote} onNote={setDownloadBoxNote} />
      <MobileAccessCard desktop={desktop} onNote={setDownloadBoxNote} />
      <LoopbackAggregationCard value={loopbackAggregation} />
      <PowerCard desktop={desktop} />
      <DevToolsCard desktop={desktop} />
      <ProxyCard
        proxy={proxy}
        proxyEffective={proxyEffective}
        loaded={loaded}
        notify={notify}
      />

      {msg && (
        <div
          style={{
            position: 'fixed',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 99999,
            padding: '10px 20px',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            maxWidth: 480,
            boxShadow: '0 4px 12px rgba(0,0,0,.4)',
            cursor: 'pointer',
            background: msg.ok ? 'rgba(34,197,94,.15)' : 'rgba(239,68,68,.15)',
            border: `1px solid ${msg.ok ? 'rgba(34,197,94,.6)' : 'rgba(239,68,68,.6)'}`,
            color: msg.ok ? '#4ade80' : '#f87171',
            backdropFilter: 'blur(8px)',
          }}
          onClick={() => setMsg(null)}
        >
          {msg.text}
        </div>
      )}

      {/* #128：面板级脚注（覆盖服务地址/Profile/端口/代理四节，不属任何单卡），加分隔线与上边距，
          免得紧贴最后一张卡看起来像从卡里漏出来的元素 */}
      <div
        style={{
          ...NOTE_STYLE,
          marginTop: 2,
          paddingTop: 10,
          borderTop: '1px solid var(--dsw-alias-border-l2, #ffffff1f)',
        }}
      >
        服务地址/Profile 切换会立即重启 dsh；端口与代理在下次重启后生效。
      </div>
    </div>
  )
}

export function registerDesktopSettings(ctx: ClientContext): void {
  if (!shellRpc.available()) return
  // 捕获 connection RPC（dsh settings 服务的桌面壳命名空间读写通道）。
  // 变量本体与「有没有捕获到」的问法都在 rpc.ts，入口不再自己持有一个可变的 nsRpc。
  captureNsRpc(ctx)
  const slots = (ctx as unknown as {
    slots?: {
      inject: (name: string, fn: () => void) => void
      register: (meta: Record<string, unknown>, comp: unknown) => void
    }
  }).slots
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
  slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: 'dsh-desktop-settings', order: 40, label: () => '桌面设置' },
      DesktopSettingsPanel,
    ),
  )

  // dsh 启动后：取回启动时选择的 profile，通过 nsSave 持久化到 settings.yaml
  void invoke<string | null>('get_pending_active_profile').then((profile) => {
    if (profile && hasNsRpc()) {
      void nsSave({ active_profile: profile }).catch(() => {})
    }
  }).catch(() => {})

  // 启动检查：前端加载后调 check_startup_needed，根据返回显示弹窗
  void invoke<{ action: string; profiles?: string[]; profile?: string; details?: { dir_exists: boolean; missing_files: string[]; node_modules_exists: boolean } }>('check_startup_needed').then((res) => {
    if (!res || res.action === 'none') return
    if (res.action === 'profile-selection') {
      const profiles = res.profiles ?? []
      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)'
      const card = document.createElement('div')
      card.style.cssText = 'background:var(--dsw-alias-bg-base,#16181d);border:1px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:12px;padding:24px;min-width:320px;max-width:400px'
      const title = document.createElement('div')
      title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:16px;color:var(--dsw-alias-label-primary,#e7eaf0)'
      title.textContent = '选择要启动的 Profile'
      card.appendChild(title)
      const list = document.createElement('div')
      list.style.cssText = 'display:flex;flex-direction:column;gap:8px'
      for (const p of profiles) {
        const btn = document.createElement('button')
        btn.style.cssText = 'padding:10px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);background:transparent;color:var(--dsw-alias-label-primary,#e7eaf0);font-size:13px;cursor:pointer;text-align:left'
        btn.textContent = p
        btn.onmouseenter = () => btn.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))'
        btn.onmouseleave = () => btn.style.background = 'transparent'
        btn.onclick = () => {
          el.remove()
          showToast(`正在启动 ${p} profile…`, true)
          void invoke('confirm_startup_profile', { name: p, repair: false }).catch((e) => showToast(`启动失败：${String(e)}`, false))
        }
        list.appendChild(btn)
      }
      const input = document.createElement('input')
      input.style.cssText = 'margin-top:12px;padding:8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);background:var(--dsw-alias-bg-base,#151517);color:var(--dsw-alias-label-primary,#e7eaf0);font-size:13px;width:100%;box-sizing:border-box'
      input.placeholder = '或输入新 profile 名称'
      const startBtn = document.createElement('button')
      startBtn.style.cssText = 'margin-top:8px;padding:8px 14px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary-new-color,#4176e6);color:#fff;font-size:13px;cursor:pointer;width:100%'
      startBtn.textContent = '新建并启动'
      startBtn.onclick = () => {
        const name = input.value.trim()
        if (!name) return
        el.remove()
        showToast(`正在创建并启动 ${name} profile…`, true)
        void invoke('confirm_startup_profile', { name, repair: true }).catch((e) => showToast(`创建失败：${String(e)}`, false))
      }
      card.appendChild(list)
      card.appendChild(input)
      card.appendChild(startBtn)
      el.appendChild(card)
      document.body.appendChild(el)
      return
    }
    if (res.action === 'profile-incomplete') {
      const profile = res.profile ?? ''
      if (!profile) return
      const details = res.details
      const missingDesc = details ? [
        ...details.missing_files,
        ...(details.node_modules_exists ? [] : ['node_modules']),
        ...(details.dir_exists ? [] : ['profile 目录']),
      ].join(', ') : ''
      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)'
      const card = document.createElement('div')
      card.style.cssText = 'background:var(--dsw-alias-bg-base,#16181d);border:1px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:12px;padding:24px;min-width:340px;max-width:420px;text-align:center'
      const title = document.createElement('div')
      title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:8px;color:var(--dsw-alias-label-primary,#e7eaf0)'
      title.textContent = `Profile「${profile}」不完整`
      const desc = document.createElement('div')
      desc.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-bottom:20px'
      desc.textContent = `缺失：${missingDesc}。是否修复？`
      const btns = document.createElement('div')
      btns.style.cssText = 'display:flex;gap:10px'
      const noBtn = document.createElement('button')
      noBtn.style.cssText = 'flex:1;padding:10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);background:transparent;color:var(--dsw-alias-label-primary,#e7eaf0);font-size:13px;cursor:pointer'
      noBtn.textContent = '直接启动'
      noBtn.onclick = () => {
        el.remove()
        void invoke('confirm_startup_profile', { name: profile, repair: false }).catch((e) => showToast(`启动失败：${String(e)}`, false))
      }
      const yesBtn = document.createElement('button')
      yesBtn.style.cssText = 'flex:1;padding:10px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary-new-color,#4176e6);color:#fff;font-size:13px;cursor:pointer'
      yesBtn.textContent = '修复并启动'
      yesBtn.onclick = () => {
        el.remove()
        showToast(`正在修复 ${profile} profile…`, true)
        void invoke('confirm_startup_profile', { name: profile, repair: true }).catch((e) => showToast(`修复失败：${String(e)}`, false))
      }
      btns.appendChild(noBtn)
      btns.appendChild(yesBtn)
      card.appendChild(title)
      card.appendChild(desc)
      card.appendChild(btns)
      el.appendChild(card)
      document.body.appendChild(el)
    }
  }).catch(() => {})
}
