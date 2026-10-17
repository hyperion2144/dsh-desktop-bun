// 面板的首次挂载数据：一次拉齐，然后按卡片切片分下去。
//
// #144 之前这段是面板里一个大 useEffect，配二十来个 setState（proxy / proxyEffective / desktop /
// forwarderInput / 三份端口输入 / migrationSource / migrationDest / loopbackAggregation …）。
// 后果是每个 setter 都成了跨卡的隐式契约：谁都能写、谁都在等，卡片没法单独拿走自己的那份。
// 现在一次 fetch 折成一个值，**派生规则逐字照旧**（ns 优先、回退口径、迁移 select 的填充行为都没动），
// 卡片只从 `data` 上取自己那几个字段。顺带把「一次挂载刷二十次 setState」变成一次。
import { useCallback, useEffect, useState } from 'react'
import { invoke, nsGet } from './rpc.ts'
import { loopbackAggregationMode, type LoopbackAggregationMode } from './loopback-aggregation.ts'
import type { DesktopData, ProxySettings } from './types.ts'

/** 每个字段的初值 = 挂载后、首次拉取返回之前面板要显示的东西。 */
export interface InitialData {
  proxy: ProxySettings
  proxyEffective: ProxySettings['effective']
  desktop: DesktopData
  loopbackAggregation: LoopbackAggregationMode
  forwarderInput: string
  profilePortInputs: Record<string, string>
  profileLaneInputs: Record<string, string>
  profilePageInputs: Record<string, string>
  migrationSource: string
  migrationDest: string
}

const INITIAL: InitialData = {
  proxy: { proxy_mode: 'off', proxy_url: '', no_proxy: '', proxy_user: '', proxy_pass: '' },
  proxyEffective: undefined,
  desktop: { remote_addr: null, remote_list: [], port: 3080, profiles: [] },
  // 壳首回话前的占位值；真实档位随后从 get_desktop_settings_data 回来。回退档＝壳侧 DEFAULT_LOOPBACK_AGGREGATION（stream）。
  loopbackAggregation: 'stream',
  forwarderInput: '',
  profilePortInputs: {},
  profileLaneInputs: {},
  profilePageInputs: {},
  migrationSource: '',
  migrationDest: '',
}

export function useInitialData(onLoadError: (text: string) => void): {
  data: InitialData
  /** 挂载首次拉取的结果，**引用此后不再变**。卡片要「只回填一次」的初值时用它，别拿 `data`。 */
  loaded: InitialData | null
  /** 重新读一次壳的设置数据（增删远程地址后用；不重读 ns 段，与旧行为一致）。 */
  refreshData: () => Promise<void>
} {
  const [data, setData] = useState<InitialData>(INITIAL)
  const [loaded, setLoaded] = useState<InitialData | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [ns, p, d] = await Promise.all([
          nsGet(),
          invoke<ProxySettings>('get_proxy_settings'),
          invoke<DesktopData>('get_desktop_settings_data'),
        ])
        if (cancelled) return
        // `next` 一个对象同时喂给两处：`data` 供渲染，`loaded` 则是「壳第一次回话」这个快照。
        // 分开是为了让「只回填一次」的卡片能拿稳定的引用——`data` 会被 refreshData 换掉。
        const next: InitialData = {
          proxy: {
            proxy_mode: (ns.proxy_mode as string) || p.proxy_mode || 'off',
            proxy_url: (ns.proxy_url as string) || p.proxy_url || '',
            no_proxy: (ns.no_proxy as string) || p.no_proxy || '',
            proxy_user: (ns.proxy_user as string) || p.proxy_user || '',
            proxy_pass: (ns.proxy_pass as string) || p.proxy_pass || '',
          },
          proxyEffective: p.effective,
          // #128：聚合档位从壳回吐的设置快照读（老设置文件没这个键 = undefined ⇒ 下面回默认 full）
          loopbackAggregation: loopbackAggregationMode(ns.loopback_aggregation),
          // 以 **壳返回的完整对象为基底**，只覆盖三个以 ns 优先的展示字段——
          // 之前是手写对象，漏字段就静默丢值（#147 实测：勾选保存成功但重开永远不勾）。
          desktop: {
            ...d,
            remote_addr: (ns.remote_addr as string | null) ?? d.remote_addr ?? null,
            remote_list: (ns.remote_list as string[]) ?? d.remote_list ?? [],
            port: (ns.port as number) || d.port || 3080,
            mux_heartbeat_ms: d.mux_heartbeat_ms ?? null,
            desktop_layout_on_phones: d.desktop_layout_on_phones ?? null,
            prevent_sleep: d.prevent_sleep ?? null,
            keep_awake: d.keep_awake ?? null,
          },
          forwarderInput:
            typeof ns.lane_forwarder_port === 'number' && ns.lane_forwarder_port > 0
              ? String(ns.lane_forwarder_port)
              : '',
          ...savedPortInputs(ns),
          ...migrationSelectDefaults(d),
        }
        setData(next)
        setLoaded(next)

      } catch (err) {
        if (cancelled) return
        onLoadError(`读取设置失败：${String(err)}`)
      }
    })()
    return () => {
      cancelled = true
    }
    // 只在挂载时拉一次（onLoadError 是 setState，稳定引用）
  }, [onLoadError])

  const refreshData = useCallback(async (): Promise<void> => {
    try {
      const d = await invoke<DesktopData>('get_desktop_settings_data')
      setData((prev) => ({ ...prev, desktop: d }))
    } catch {
      /* 保留旧数据 */
    }
  }, [])

  return { data, loaded, refreshData }
}

// #22：三个 per-profile 端口输入框按已保存期望值回填——设置弹窗每次挂载都重读，
// 只写不回填 = 切 tab 回来像「改回去」（灰字 placeholder 才是当前实际值）。
function savedPortInputs(ns: Record<string, unknown>): Pick<
  InitialData,
  'profilePortInputs' | 'profileLaneInputs' | 'profilePageInputs'
> {
  const saved = (key: string): Record<string, string> => {
    const raw = ns[key]
    const out: Record<string, string> = {}
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, n] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof n === 'number' && n > 0) out[k] = String(n)
      }
    }
    return out
  }
  return {
    profilePortInputs: saved('profile_ports'),
    profileLaneInputs: saved('profile_lane_ports'),
    profilePageInputs: saved('profile_page_ports'),
  }
}

/** 迁移 select 默认填充：源取第一个，目标取另一个（保持原 fillDst 行为）。 */
function migrationSelectDefaults(d: DesktopData): Pick<InitialData, 'migrationSource' | 'migrationDest'> {
  if (d.profiles.length === 0) return { migrationSource: '', migrationDest: '' }
  const first = d.profiles[0]
  if (!first) return { migrationSource: '', migrationDest: '' }
  const other = d.profiles.find((pp) => pp.name !== first.name)
  return { migrationSource: first.name, migrationDest: other ? other.name : '' }
}
