// 壳 RPC 客户端统一传输层（#50）。
//
// 旧壳经 preload 注入的 Tauri 兼容 shim（伪装全局 invoke 面）已随壳侧删除；桌面 chrome 的所有
// 壳调用改走这里。通道优先级：
//   1. 官方 Electrobun Typed RPC（壳内 webview）：wire 协议对齐官方 api/shared/rpc.ts——
//      请求 `{type:'request', id, method, params}` 经原生桥
//      `__electrobunHostBridge.postMessage(JSON 字符串)`；回包由宿主执行
//      `__electrobun.receiveMessageFromHost(对象)`。Windows 框架不建 socket 通道，全走桥；
//      mac/linux 上框架对未连 socket 的视图也回退 executeJS（官方 Socket.ts 注释：
//      返回 false ⇒ caller falls back to the native bridge / evaluateJS path），
//      所以页面侧只接桥即可覆盖全部平台。
//   2. mobile-access 中继桥（配对远程页）：`__DSH_SHELL_RELAY__.invoke`（#47 注入，
//      远程页没有原生桥，物理上走不了官方 RPC，HTTP 中继是唯一通道）。
//
// #128：第 3 级「同源 fetch 兜底」整条删除（连带 token 判据）。壳 preload 已经在最早期装好
// 官方 RPC 分发器 `__DSH_SHELL_RPC__`，接收面与 id 空间都归它。插件在场时把**整条官方通道**
// 委托给它，而不是只把接收面让出去：两个 owner 各发各的 id，壳侧按 id 存表只留最后一份，
// 另一个在途请求的回包就永远丢了。只有 dev/旧壳（无分发器）时插件才自己接管接收面。
//
// 语义与旧 shim 一致：成功 resolve value；业务失败 reject(new Error(error))；
// 没有任何通道时 reject('shell rpc unavailable')。官方通道**请求级失败不重试**（命令可能已在
// 壳侧生效，toggle 类命令二次执行会翻转两次）。
//
// #185：官方通道的协议实现收进根 shared/rpc/core.ts——委托模式直接用 preload 分发器，
// 自装模式（dev/旧壳）也用同一个 createRpcCore，全仓协议常量只剩一处。

import { createRpcCore, type RpcCore } from '../../../../shared/rpc/core.ts'

/** 壳/中继注入到页面的全局面（都是可选：纯浏览器里一个都没有）。 */
export interface ShellRpcGlobals {
  /** 官方原生桥（Electrobun 运行时注入；远程浏览器没有） */
  __electrobunHostBridge?: { postMessage?: (message: string) => void }
  /** 官方接收面（框架 preload 注入；宿主回包执行 receiveMessageFromHost） */
  __electrobun?: { receiveMessageFromHost?: (message: unknown) => void }
  /** 宿主回包先于页面接管抵达时，框架 preload 会先攒在这（接管后要排空） */
  __electrobunPendingHostMessages?: unknown[]
  /** mobile-access 中继桥（#47：配对远程页） */
  __DSH_SHELL_RELAY__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
  /** 壳 preload 的官方 RPC 分发器（#128：preload 最早期装；官方通道交给它，见文件头） */
  __DSH_SHELL_RPC__?: {
    invoke?: <T = unknown>(
      method: string,
      params: Record<string, unknown>,
      options?: { timeoutMs?: number; noTimeout?: boolean },
    ) => Promise<T>
    request?: (
      method: string,
      params: Record<string, unknown>,
      options?: { timeoutMs?: number; noTimeout?: boolean },
    ) => Promise<unknown>
  }
}


export interface ShellRpcInvokeOptions {
  /** 单请求超时（官方通道生效；默认 15s，文件选择/重启类调用可放宽）。 */
  timeoutMs?: number
  /**
   * #97：不挂客户端超时。长任务（运行时下载）必须靠轮询快照收尾——官方通道自身的 120s 上限
   * 只放弃回包、**不取消**壳侧任务，客户端再补一刀超时就会出现「安装其实完成了，面板却报超时、
   * 进度条还卡着」。这类调用改用 `noTimeout`，终态一律由 `runtime_download_status` 对账。
   */
  noTimeout?: boolean
}


export interface ShellRpcClient {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>, options?: ShellRpcInvokeOptions): Promise<T>
  /** 是否存在任一可用通道（面板据此决定激活桌面 chrome 与否）。 */
  available(): boolean
}


export interface ShellRpcDeps {
  readGlobals: () => ShellRpcGlobals
  setTimeoutImpl: (fn: () => void, ms: number) => unknown
  clearTimeoutImpl: (handle: unknown) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createShellRpc(deps?: Partial<ShellRpcDeps>): ShellRpcClient {
  const readGlobals = deps?.readGlobals ?? (() => globalThis as unknown as ShellRpcGlobals)
  const setTimeoutImpl = deps?.setTimeoutImpl ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimeoutImpl = deps?.clearTimeoutImpl ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))

  /** 自装模式（dev/旧壳，无 preload 分发器）用的共享 core（#185）：惰性建，首次官方调用时才建。 */
  let core: RpcCore | null = null
  /** 接收面是否已接管（每文档一次；接管后宿主回包直达 core.receive）。 */
  let receiveAttached = false

  function officialBridge(): ((message: string) => void) | undefined {
    const post = readGlobals().__electrobunHostBridge?.postMessage
    return typeof post === 'function' ? post : undefined
  }

  function rpcCore(): RpcCore {
    if (core === null) {
      const post = officialBridge()
      if (post === undefined) throw new Error('official bridge unavailable')
      core = createRpcCore({ post, setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl })
    }
    return core
  }

  /**
   * 接管官方接收面并排空先期积压（顺序对齐官方 Electroview.init）。
   * #128：preload 分发器在场时**直接复用，一个字节都不碰** receiveMessageFromHost——
   * 后装的 handler 会把前一个顶掉，前一个在途请求的回包就没人接了。
   */
  function ensureReceive(): void {
    if (typeof readGlobals().__DSH_SHELL_RPC__?.invoke === 'function') {
      receiveAttached = true
      return
    }
    if (receiveAttached) return
    const g = readGlobals()
    const eb = g.__electrobun
    if (!eb) return
    eb.receiveMessageFromHost = rpcCore().receive
    receiveAttached = true
    const queued = g.__electrobunPendingHostMessages
    if (Array.isArray(queued)) {
      g.__electrobunPendingHostMessages = []
      for (const packet of queued) rpcCore().receive(packet)
    }
  }

  function officialInvoke<T>(cmd: string, args: Record<string, unknown>, options?: ShellRpcInvokeOptions): Promise<T> {
    // #128：preload 分发器拥有接收面与 id 空间，在场时整条官方通道委托给它（理由见文件头）。
    const dispatcher = readGlobals().__DSH_SHELL_RPC__
    if (typeof dispatcher?.invoke === 'function') return dispatcher.invoke<T>(cmd, args, options)
    const post = officialBridge()
    if (post === undefined) return Promise.reject(new Error('official bridge unavailable'))
    ensureReceive()
    return rpcCore().invoke(cmd, args, options) as Promise<T>
  }

  function relayInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    const invoke = readGlobals().__DSH_SHELL_RELAY__?.invoke
    if (typeof invoke !== 'function') return Promise.reject(new Error('relay bridge unavailable'))
    return invoke(cmd, args) as Promise<T>
  }


  return {
    invoke<T = unknown>(cmd: string, args?: Record<string, unknown>, options?: ShellRpcInvokeOptions): Promise<T> {
      const rest = isRecord(args) ? args : {}
      if (officialBridge() !== undefined) return officialInvoke<T>(cmd, rest, options)
      if (typeof readGlobals().__DSH_SHELL_RELAY__?.invoke === 'function') return relayInvoke<T>(cmd, rest)
      return Promise.reject(new Error('shell rpc unavailable'))
    },
    available(): boolean {
      const g = readGlobals()
      return (
        officialBridge() !== undefined ||
        typeof g.__DSH_SHELL_RELAY__?.invoke === 'function' ||
        typeof g.__DSH_SHELL_RPC__?.invoke === 'function'
      )
    },
  }
}

/** 页面级单例（浏览器 globalThis 即 window；测试可 createShellRpc 注入假环境）。 */
export const shellRpc = createShellRpc()

