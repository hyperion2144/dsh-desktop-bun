// 面板数据 adapter（#182）：把「设置面板要的一份数据」从 React 里剥出来。
//
// 过去这份逻辑住在 use-initial-data.ts 的 hook 里：拉取、合并规则、600ms 任务轮询全绑在
// useEffect/useState 上，测试只能靠源码文本断言。现在拆成两层：
//   · 本文件：非 React 的 store —— buildSnapshot 纯函数（合并规则唯一实现）+ createPanelData
//     （拉取/订阅/只换 desktop 的刷新/落盘透传/任务轮询），依赖全部可注入，node 里就能测行为。
//   · use-panel-data.ts：薄 React 壳 —— useSyncExternalStore 把 store 接进组件树。
// 合并规则逐字照旧（ns 优先、回退口径、迁移 select 的填充行为都没动）；
// 传输走 #190 的 invokeCommand，形状只有契约一处事实源。
import { invokeCommand, nsGet, nsSave } from './rpc.ts'
import { loopbackAggregationMode, type LoopbackAggregationMode } from './loopback-aggregation.ts'
import type { DesktopData, ProxySettings } from './types.ts'
import type { TaskSnapshot } from '../../../../contracts/index.ts'

export type { TaskSnapshot }

/** 面板一份数据快照：每个字段都有唯一归属卡片，面板靠 props 切片下去。 */
export interface PanelSnapshot {
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

/** store 的整体状态：快照 + 「壳第一次回话」的稳定引用 + 长任务卡。 */
export interface PanelState {
  snapshot: PanelSnapshot
  /** 挂载首拉的结果，**引用此后不再变**。卡片要「只回填一次」的初值时用它，别拿 `snapshot`。 */
  loaded: PanelSnapshot | null
  task: TaskSnapshot | null
}

/** 每个字段的初值 = 挂载后、首次拉取返回之前面板要显示的东西。 */
export const PLACEHOLDER: PanelSnapshot = {
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

/**
 * 合并规则的唯一实现（纯函数）：三路输入折成一份快照。
 * 规则逐字来自原 use-initial-data.ts——ns 段优先、壳回吐兜底、desktop 以壳的完整对象为基底
 * 只覆盖 ns 优先的展示字段（#147：手写对象漏字段会静默丢值）。
 */
export function buildSnapshot(
  ns: Record<string, unknown>,
  p: ProxySettings,
  d: DesktopData,
): PanelSnapshot {
  return {
    proxy: {
      proxy_mode: (ns.proxy_mode as string) || p.proxy_mode || 'off',
      proxy_url: (ns.proxy_url as string) || p.proxy_url || '',
      no_proxy: (ns.no_proxy as string) || p.no_proxy || '',
      proxy_user: (ns.proxy_user as string) || p.proxy_user || '',
      proxy_pass: (ns.proxy_pass as string) || p.proxy_pass || '',
    },
    proxyEffective: p.effective,
    // #128：聚合档位从壳回吐的设置快照读（老设置文件没这个键 = undefined ⇒ loopbackAggregationMode 回默认）。
    loopbackAggregation: loopbackAggregationMode(ns.loopback_aggregation),
    // 以 **壳返回的完整对象为基底**，只覆盖三个以 ns 优先的展示字段。
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
}

export interface PanelDataDeps {
  nsGet?: () => Promise<Record<string, unknown>>
  getProxySettings?: () => Promise<ProxySettings>
  getDesktopData?: () => Promise<DesktopData>
  taskStatus?: () => Promise<TaskSnapshot>
  save?: (patch: Record<string, unknown>) => Promise<void>
  /** 任务轮询周期（缺省 600ms，历史值）。 */
  pollMs?: number
  setIntervalImpl?: (fn: () => void, ms: number) => unknown
  clearIntervalImpl?: (handle: unknown) => void
}

export interface PanelData {
  getState(): PanelState
  /** 订阅状态变化（useSyncExternalStore 的缝）。返回退订函数。 */
  subscribe(listener: () => void): () => void
  /** 挂载首拉：三路并发读 → buildSnapshot。单飞；dispose 后到货的结果被丢弃。 */
  loadAll(onError?: (text: string) => void): Promise<void>
  /** 只重拉 desktop 段（增删远程地址后用）：不重读 ns/代理段，`loaded` 不动——旧 refreshData 语义。 */
  refreshDesktop(): Promise<void>
  /** 落盘透传（save_desktop_settings）。 */
  save(patch: Record<string, unknown>): Promise<void>
  /** 600ms 任务轮询：running/finished 才更新（结束后保留末态），其余轮次静默。 */
  startTaskPolling(): void
  stopTaskPolling(): void
  /** 组件卸载：停表、标记弃单（在途结果丢弃）。store 不可复用。 */
  dispose(): void
}

/** 非 React 面板数据 store。每个面板挂载建一个实例（与原「挂载级 state」生命周期一致）。 */
export function createPanelData(deps: PanelDataDeps = {}): PanelData {
  const io = {
    nsGet: deps.nsGet ?? nsGet,
    getProxySettings: deps.getProxySettings ?? (() => invokeCommand('get_proxy_settings')),
    getDesktopData: deps.getDesktopData ?? (() => invokeCommand('get_desktop_settings_data')),
    taskStatus: deps.taskStatus ?? (() => invokeCommand('task_status')),
    save: deps.save ?? nsSave,
  }
  const pollMs = deps.pollMs ?? 600
  const setIntervalImpl = deps.setIntervalImpl ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clearIntervalImpl = deps.clearIntervalImpl ?? ((handle: unknown) => clearInterval(handle as number))

  let state: PanelState = { snapshot: PLACEHOLDER, loaded: null, task: null }
  const listeners = new Set<() => void>()
  let loadPromise: Promise<void> | null = null
  let pollHandle: unknown = null
  let disposed = false

  function setState(patch: Partial<PanelState>): void {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  function loadAll(onError?: (text: string) => void): Promise<void> {
    // 单飞：React 18 StrictMode 双挂载也只拉一次。
    if (loadPromise !== null) return loadPromise
    loadPromise = (async () => {
      try {
        const [ns, proxy, desktop] = await Promise.all([
          io.nsGet(),
          io.getProxySettings(),
          io.getDesktopData(),
        ])
        if (disposed) return
        // `next` 一个对象同时喂给两处：`snapshot` 供渲染，`loaded` 则是「壳第一次回话」这个快照。
        // 同一引用是「只回填一次」卡片拿稳定初值的依据。
        const snapshot = buildSnapshot(ns, proxy, desktop)
        setState({ snapshot, loaded: snapshot })
      } catch (err) {
        if (disposed) return
        onError?.(`读取设置失败：${String(err)}`)
      }
    })()
    return loadPromise
  }

  async function refreshDesktop(): Promise<void> {
    try {
      const desktop = await io.getDesktopData()
      if (disposed) return
      setState({ snapshot: { ...state.snapshot, desktop } })
    } catch {
      /* 保留旧数据 */
    }
  }

  function startTaskPolling(): void {
    if (pollHandle !== null || disposed) return
    pollHandle = setIntervalImpl(() => {
      void io
        .taskStatus()
        .then((t) => {
          if (disposed) return
          // 任务开启或进行中刷新；结束后保留末态（直到下一次任务开始）
          if (t.running || t.finished) setState({ task: t })
        })
        .catch(() => {})
    }, pollMs)
  }

  function stopTaskPolling(): void {
    if (pollHandle === null) return
    clearIntervalImpl(pollHandle)
    pollHandle = null
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    loadAll,
    refreshDesktop,
    save: (patch) => io.save(patch),
    startTaskPolling,
    stopTaskPolling,
    dispose() {
      disposed = true
      stopTaskPolling()
      listeners.clear()
    },
  }
}

// #22：三个 per-profile 端口输入框按已保存期望值回填——设置弹窗每次挂载都重读，
// 只写不回填 = 切 tab 回来像「改回去」（灰字 placeholder 才是当前实际值）。
function savedPortInputs(ns: Record<string, unknown>): Pick<
  PanelSnapshot,
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
function migrationSelectDefaults(d: DesktopData): Pick<PanelSnapshot, 'migrationSource' | 'migrationDest'> {
  if (d.profiles.length === 0) return { migrationSource: '', migrationDest: '' }
  const first = d.profiles[0]
  if (!first) return { migrationSource: '', migrationDest: '' }
  const other = d.profiles.find((pp) => pp.name !== first.name)
  return { migrationSource: first.name, migrationDest: other ? other.name : '' }
}
