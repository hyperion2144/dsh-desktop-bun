// 官方 Electrobun Typed RPC 与壳命令表的缝合（#50）。
//
// 旧壳的 Tauri 兼容 shim（tauri-ipc.ts，伪装 Tauri invoke 全局面）随本票删除：
// 壳改在 BrowserWindow 上挂官方 `BrowserView.defineRPC`，页面侧按官方 wire 协议
// （`{type:'request', id, method, params}` / `{type:'response', id, success, payload|error}`）
// 经原生桥收发。这里用 requests 表的 `_` 通配把任意 method 单漏斗进 `dispatchRpc`——
// 命令表（commands.ts）仍是唯一事实源，每视图授权（view-grant）仍是唯一闸门。
//
// 窗口三键（A5）不在命令表（HTTP 兜底走专门的 `/__shell__/window` 端点），
// 这里作为显式方法挂进同一张 requests 表，与漏斗共用同一份错误语义。
// Windows 最大化主管道是系统行为：首次三键前给本进程窗补 WS_MAXIMIZEBOX 等样式位
// （window-max.ts，上游 electrobun#558 实测——系统最大化只在带该位时按工作区收缩，
// 双屏跨屏也因此消失）；补丁失败也直接原生 maximize（#80 维护者指令：拒绝一切
// 自绘窗口尺寸，不做 setFrame 兜底）。
// window_get_state 同源几何推导，页面用它切换最大化/还原图标。
//
// 超时：官方默认单请求 1000ms；「选择音效文件」「重启宿主」这类命令远超它，壳口径放宽。
import { dispatchRpc, type RpcRouter } from './rpc.ts'
import { denyReason, isCommandAllowed, type ViewGrant } from '../../shared/net/view-grant.ts'
import { ensureNativeMaximizeStyles, toggleWindowMaximize, windowMaxState, type WorkAreaLookup, type WindowFrame, type WindowMaxState } from '../windows/window-max.ts'

/** 壳的官方 RPC 单请求超时（官方默认 1000ms 对文件选择器/重启宿主太紧）。 */
export const SHELL_RPC_MAX_REQUEST_TIME = 120_000

/** 窗口三键的窗口面（BrowserWindow 用到的最小子集，方便单测注入假窗）。 */
export interface ShellRpcWindow {
  minimize(): void
  isMaximized(): boolean
  unmaximize(): void
  maximize(): void
  close(): void
  /** 漏斗状态推导要用：读当前帧（只读——本仓不做任何窗口摆位，#80）。 */
  getFrame(): WindowFrame
}

export interface ShellRpcDeps {
  /** 命令表惰性取：命令表晚于窗口创建就绪也不炸（回 'shell rpc not ready'）。 */
  router: () => RpcRouter | null
  /** 该视图的授权（createProfileWindow 里 `views.issue('shell', …)` 的返回值）。 */
  grant: ViewGrant
  /** 三键作用的本窗（比「当前聚焦窗」精确：多窗口下不会打错窗）。 */
  window: ShellRpcWindow
  /** 逻辑工作区取法（生产由 index.ts 注入 Screen 工作区；测试常用 () => null 只看原生旗标）。 */
  workArea: WorkAreaLookup
  /** 样式补丁是否生效（测试注入；缺省 win32 走 window-max.ts 枚举补丁，其余平台恒 false）。 */
  maximizeStylesPatched?: () => boolean
  /** 平台（测试注入；缺省 process.platform）。 */
  platform?: NodeJS.Platform
}

/** 漏斗签名：官方 RPC 的一次请求（method/params）→ 值或 throw（映射 success:false）。 */
export type ShellRpcFunnel = (method: string, params: unknown) => Promise<unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 纯漏斗（可单测）：命令语义全部复用 dispatchRpc，任何失败都 throw（官方协议
 * 会把它变成 `{success:false, error}`，页面侧 reject(new Error(error))，与旧 shim
 * 的 reject 语义一致，面板的 `.catch` 显示路径不变）。
 */
export function createShellRpcFunnel(deps: ShellRpcDeps): ShellRpcFunnel {
  const platform = deps.platform ?? process.platform
  const workAreaOf = deps.workArea
  // 样式补丁按漏斗实例记忆：本窗首次 toggle 枚举补丁一次，多窗口后建的窗也能补到。
  const stylesPatched = deps.maximizeStylesPatched ?? (() => (platform === 'win32' ? ensureNativeMaximizeStyles() : false))
  const deriveState = (): WindowMaxState => windowMaxState(deps.window, { platform, workArea: workAreaOf })
  const toggleMaximize = (): void => {
    // 判定/样式位/原生切换收口在 window-max.ts（与 /__shell__/window 端点共用，#112）。
    toggleWindowMaximize(deps.window, { platform, workArea: workAreaOf, maximizeStylesPatched: stylesPatched })
  }
  return async (method, params) => {
    // 授权先行：三键与命令一视同仁（shell 视图全放行；guest/remote 即便拿到
    // RPC 实例也一条都不许过——白名单是最后一道闸）。
    if (!isCommandAllowed(deps.grant.kind, method)) {
      throw new Error(denyReason(deps.grant.kind, method))
    }
    // 窗口三键：不进命令表，直接操作本窗（与 /__shell__/window 同语义）。
    if (method === 'window_minimize') {
      deps.window.minimize()
      return null
    }
    if (method === 'window_toggle_maximize') {
      toggleMaximize()
      return null
    }
    if (method === 'window_get_state') {
      return { maximized: deriveState().maximized }
    }
    if (method === 'window_close') {
      deps.window.close()
      return null
    }
    // #128：F13 旧命令 toggle_zoom（窗口⇄工作区）原先走命令表 → deps.zoomToggle() →
    // focusedWindow()，是「窗口命令打哪扇窗由全局决定」的最后一条漏网路径（多窗口下会盖错窗）。
    // 归进漏斗与 window_* 同源：作用对象恒为发起请求的那扇窗；切换语义本就等价于
    // window_toggle_maximize（Electrobun 无 workArea API，maximize/unmaximize 就是「窗口⇄工作区」）。
    // 命令表里的同名条目保留——保留的 HTTP /__shell__/rpc 路由（远程页中继目标）仍走它。
    if (method === 'toggle_zoom') {
      toggleMaximize()
      return { ok: true }
    }
    const router = deps.router()
    if (router === null) throw new Error('shell rpc not ready')
    const raw = JSON.stringify({ cmd: method, args: isRecord(params) ? params : {} })
    const result = await dispatchRpc(router, raw, {
      caller: { kind: deps.grant.kind, profile: deps.grant.profile, label: deps.grant.label },
    })
    if (result.body.ok === true) return result.body.value
    throw new Error(typeof result.body.error === 'string' ? result.body.error : 'rpc failed')
  }
}

/**
 * 官方 defineRPC 挂点：requests 表 = 窗口三键显式方法 + `_` 通配进命令表。
 * 返回 ShellRpcHandle：只有 rpc 一个字段，喂给 `new BrowserWindow({ rpc })`（框架接到窗口主视图）。
 * 没有状态推送口：窗口状态一律由页面主动查 window_get_state（#144：旧的窗口状态推送
 * 整条删除，从未被任何订阅方消费过）。
 */
/** attachShellRpc 的返回：只有官方 rpc 实例，原样喂给 BrowserWindow。 */
export interface ShellRpcHandle {
  /** 官方 rpc 实例，原样喂给 `new BrowserWindow({ rpc })`。 */
  rpc: unknown
}



export async function attachShellRpc(deps: ShellRpcDeps): Promise<ShellRpcHandle> {
  // 惰性加载：漏斗保持纯逻辑可单测；electrobun 运行时只在真挂点（建窗）时才需要。
  const { BrowserView } = await import('electrobun/bun')
  const funnel = createShellRpcFunnel(deps)
  const rpc = BrowserView.defineRPC({
    maxRequestTime: SHELL_RPC_MAX_REQUEST_TIME,
    handlers: {
      requests: {
        window_minimize: () => funnel('window_minimize', undefined),
        window_toggle_maximize: () => funnel('window_toggle_maximize', undefined),
        window_close: () => funnel('window_close', undefined),
        window_get_state: () => funnel('window_get_state', undefined),
        // `_` 通配：官方 createRPC 对未命中方法回退到它（收到 (method, params)）。
        _: (method: string, params: unknown) => funnel(method, params),
      },
    },
  })
  // 只挂收：壳侧没有向页面主动推送的通道，窗口状态一律由页面反向查 window_get_state
  // （#144：旧的窗口状态推送整条删除，浏览器侧也从无订阅方）。
  return { rpc }
}
