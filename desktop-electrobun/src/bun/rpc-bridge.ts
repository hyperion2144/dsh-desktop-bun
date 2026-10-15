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
// 双屏跨屏也因此消失）；补丁失败退手动 setFrame，再失败退原生 maximize。
// window_get_state 同源几何推导，页面用它切换最大化/还原图标。
//
// 超时：官方默认单请求 1000ms；「选择音效文件」「重启宿主」这类命令远超它，壳口径放宽。
import { dispatchRpc, type RpcRouter } from './rpc.ts'
import { denyReason, isCommandAllowed, type ViewGrant } from '../shared/view-grant.ts'
import { deriveMaximized, ensureNativeMaximizeStyles, getWorkAreaForFrame, type WindowFrame } from './window-max.ts'

/** 壳的官方 RPC 单请求超时（官方默认 1000ms 对文件选择器/重启宿主太紧）。 */
export const SHELL_RPC_MAX_REQUEST_TIME = 120_000

/** 窗口三键的窗口面（BrowserWindow 用到的最小子集，方便单测注入假窗）。 */
export interface ShellRpcWindow {
  minimize(): void
  isMaximized(): boolean
  unmaximize(): void
  maximize(): void
  close(): void
  /** 手动最大化（window-max.ts）要用：读当前帧 / 把窗口摆到指定帧。 */
  getFrame(): WindowFrame
  setFrame(frame: WindowFrame): void
}

export interface ShellRpcDeps {
  /** 命令表惰性取：命令表晚于窗口创建就绪也不炸（回 'shell rpc not ready'）。 */
  router: () => RpcRouter | null
  /** 该视图的授权（createProfileWindow 里 `views.issue('shell', …)` 的返回值）。 */
  grant: ViewGrant
  /** 三键作用的本窗（比「当前聚焦窗」精确：多窗口下不会打错窗）。 */
  window: ShellRpcWindow
  /** 工作区取法（测试注入；缺省 win32 走 user32 ffi，其余平台恒 null）。 */
  workArea?: (near: WindowFrame) => WindowFrame | null
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
  const workAreaOf = deps.workArea ?? getWorkAreaForFrame
  // 样式补丁按漏斗实例记忆：本窗首次 toggle 枚举补丁一次，多窗口后建的窗也能补到。
  const stylesPatched = deps.maximizeStylesPatched ?? (() => (platform === 'win32' ? ensureNativeMaximizeStyles() : false))
  // 手动兑底（补丁失败）时的还原框；系统最大化路径用原生还原，不碰它。
  // 手动最大化的还原框：点最大化时记下当前帧，还原时用掉。期间系统贴靠改变帧
  // 的话，下一次点最大化会重新记（还原到贴靠前的帧，行为与原生一致）。
  let restoreFrame: WindowFrame | null = null
  const deriveState = (): { maximized: boolean; workArea: WindowFrame | null } => {
    const frame = deps.window.getFrame()
    const workArea = platform === 'win32' ? workAreaOf(frame) : null
    return { maximized: deriveMaximized(frame, workArea, deps.window.isMaximized()), workArea }
  }
  const toggleMaximize = (): void => {
    const { maximized, workArea } = deriveState()
    // 主管道（win32 补丁成功 / 非 win32 原生本就对）：系统行为最大化——按所在显示器
    // 工作区收缩、原生抽贴靠、原生还原，不自算任何几何（双屏跨屏修复）。
    const systemMaximize = platform === 'win32' ? stylesPatched() : true
    if (maximized) {
      if (!systemMaximize && restoreFrame !== null) {
        deps.window.setFrame(restoreFrame)
        restoreFrame = null
      } else {
        deps.window.unmaximize()
      }
      return
    }
    restoreFrame = deps.window.getFrame()
    if (systemMaximize) deps.window.maximize()
    else if (platform === 'win32' && workArea !== null) deps.window.setFrame(workArea)
    else deps.window.maximize()
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
 * 返回值直接喂给 `new BrowserWindow({ rpc })`（框架把它接到窗口主视图）。
 */
export async function attachShellRpc(deps: ShellRpcDeps): Promise<unknown> {
  // 惰性加载：漏斗保持纯逻辑可单测；electrobun 运行时只在真挂点（建窗）时才需要。
  const { BrowserView } = await import('electrobun/bun')
  const funnel = createShellRpcFunnel(deps)
  return BrowserView.defineRPC({
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
}
