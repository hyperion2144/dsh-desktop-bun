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
//   3. 同源 fetch 兜底：POST /__shell__/rpc（壳 loopback 同源 + x-dsh-shell-view token，
//      token 由壳 preload 暴露在 `__DSH_SHELL_VIEW_TOKEN__`）。
//
// 语义与旧 shim 一致：成功 resolve value；业务失败 reject(new Error(error))；
// 没有任何通道时 reject('shell rpc unavailable')。注意：官方通道**请求级失败不重试**
// （超时/拒绝都不再打 fetch 兜底）——命令可能已在壳侧生效，toggle 类命令二次执行会翻转两次。

/** 壳 RPC 端点（与壳侧 tauri-ipc 时代的常量同名同值；现仅作 fetch 兜底用）。 */
const RPC_ENDPOINT = '/__shell__/rpc'
/** 自绘窗口三键端点（A5）：不在命令表里，官方通道用 window_* 方法，兜底走它。 */
const WINDOW_ENDPOINT = '/__shell__/window'
/** 每视图 token 请求头（壳侧 shared/view-grant.ts 的同名常量；跨包复制，注释互指）。 */
const VIEW_TOKEN_HEADER = 'x-dsh-shell-view'
/** 官方默认单请求超时：官方 createRPC 的默认值是 1000ms，对文件选择器太紧。 */
const DEFAULT_TIMEOUT_MS = 15_000
/** 请求 id 上限（对齐官方 MAX_ID，溢出归零）。 */
const MAX_ID = 1e10

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
  /** 壳 preload 暴露的每视图 token（fetch 兜底认证用） */
  __DSH_SHELL_VIEW_TOKEN__?: string
}


export interface ShellRpcInvokeOptions {
  /** 单请求超时（官方通道生效；默认 15s，文件选择/重启类调用可放宽）。 */
  timeoutMs?: number
}

export type ShellRpcMessageListener = (name: string, payload: unknown) => void

export interface ShellRpcClient {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>, options?: ShellRpcInvokeOptions): Promise<T>
  onMessage(listener: ShellRpcMessageListener): () => void
  /** 是否存在任一可用通道（面板据此决定激活桌面 chrome 与否）。 */
  available(): boolean
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

export interface ShellRpcDeps {
  readGlobals: () => ShellRpcGlobals
  fetchImpl: typeof fetch
  setTimeoutImpl: typeof setTimeout
  clearTimeoutImpl: typeof clearTimeout
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createShellRpc(deps?: Partial<ShellRpcDeps>): ShellRpcClient {
  const readGlobals = deps?.readGlobals ?? (() => globalThis as unknown as ShellRpcGlobals)
  const fetchImpl = deps?.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const setTimeoutImpl = deps?.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimeoutImpl = deps?.clearTimeoutImpl ?? ((t) => clearTimeout(t))

  const pending = new Map<number, PendingRequest>()
  const messageListeners = new Set<ShellRpcMessageListener>()
  let nextId = 0
  /** 接收面是否已接管（每文档一次；接管后宿主回包直达 handlePacket）。 */
  let receiveAttached = false

  function officialBridge(): ((message: string) => void) | undefined {
    const post = readGlobals().__electrobunHostBridge?.postMessage
    return typeof post === 'function' ? post : undefined
  }

  function handlePacket(packet: unknown): void {
    if (!isRecord(packet)) return
    // 壳→页面的主动推送（#73）：{type:'message', id:消息名, payload}。消息是触发器，
    // 客户端收到就自重查真值（window_get_state 是唯一状态源）；一个监听器抛错不影响其余。
    if (packet.type === 'message') {
      const name = typeof packet.id === 'string' ? packet.id : ''
      if (name === '') return
      for (const listener of messageListeners) {
        try {
          listener(name, packet.payload)
        } catch (error) {
          console.error('shell rpc message listener failed', error)
        }
      }
      return
    }
    if (packet.type !== 'response') return
    const id = typeof packet.id === 'number' ? packet.id : NaN
    const waiter = pending.get(id)
    if (waiter === undefined) return
    pending.delete(id)
    if (waiter.timer !== undefined) clearTimeoutImpl(waiter.timer)
    if (packet.success === true) waiter.resolve(packet.payload)
    else waiter.reject(new Error(typeof packet.error === 'string' ? packet.error : 'shell rpc failed'))
  }

  /** 接管官方接收面并排空先期积压（顺序对齐官方 Electroview.init）。 */
  function ensureReceive(): void {
    if (receiveAttached) return
    const g = readGlobals()
    const eb = g.__electrobun
    if (!eb) return
    eb.receiveMessageFromHost = handlePacket
    receiveAttached = true
    const queued = g.__electrobunPendingHostMessages
    if (Array.isArray(queued)) {
      g.__electrobunPendingHostMessages = []
      for (const packet of queued) handlePacket(packet)
    }
  }

  function officialInvoke<T>(cmd: string, args: Record<string, unknown>, options?: ShellRpcInvokeOptions): Promise<T> {
    const post = officialBridge()
    if (post === undefined) return Promise.reject(new Error('official bridge unavailable'))
    ensureReceive()
    nextId = nextId < MAX_ID ? nextId + 1 : 1
    const id = nextId
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const timer = setTimeoutImpl(() => {
        pending.delete(id)
        reject(new Error('RPC request timed out.'))
      }, timeoutMs)
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      try {
        post(JSON.stringify({ type: 'request', id, method: cmd, params: args }))
      } catch (error) {
        pending.delete(id)
        if (timer !== undefined) clearTimeoutImpl(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  function relayInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    const invoke = readGlobals().__DSH_SHELL_RELAY__?.invoke
    if (typeof invoke !== 'function') return Promise.reject(new Error('relay bridge unavailable'))
    return invoke(cmd, args) as Promise<T>
  }

  async function fetchInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    const token = readGlobals().__DSH_SHELL_VIEW_TOKEN__
    let response: Response
    try {
      response = await fetchImpl(RPC_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(typeof token === 'string' && token !== '' ? { [VIEW_TOKEN_HEADER]: token } : {}) },
        body: JSON.stringify({ cmd, args }),
      })
    } catch (error) {
      throw new Error(`shell rpc failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(`shell rpc failed: ${String(response.status)}`)
    const body = (await response.json().catch(() => null)) as { ok?: unknown; value?: unknown; error?: unknown } | null
    if (body !== null && body.ok === true) return body.value as T
    throw new Error(typeof body?.error === 'string' ? body.error : 'shell rpc failed')
  }

  return {
    invoke<T = unknown>(cmd: string, args?: Record<string, unknown>, options?: ShellRpcInvokeOptions): Promise<T> {
      const rest = isRecord(args) ? args : {}
      if (officialBridge() !== undefined) return officialInvoke<T>(cmd, rest, options)
      if (typeof readGlobals().__DSH_SHELL_RELAY__?.invoke === 'function') return relayInvoke<T>(cmd, rest)
      if (typeof readGlobals().__DSH_SHELL_VIEW_TOKEN__ === 'string') return fetchInvoke<T>(cmd, rest)
      return Promise.reject(new Error('shell rpc unavailable'))
    },
    onMessage(listener: ShellRpcMessageListener): () => void {
      messageListeners.add(listener)
      return () => {
        messageListeners.delete(listener)
      }
    },
    available(): boolean {
      const g = readGlobals()
      return (
        officialBridge() !== undefined ||
        typeof g.__DSH_SHELL_RELAY__?.invoke === 'function' ||
        typeof g.__DSH_SHELL_VIEW_TOKEN__ === 'string'
      )
    },
  }
}

/** 页面级单例（浏览器 globalThis 即 window；测试可 createShellRpc 注入假环境）。 */
export const shellRpc = createShellRpc()

export type WindowAction = 'minimize' | 'toggle-maximize' | 'close'

/** 窗口三键（A5）：官方 RPC 的 window_* 方法优先，桥不在时回 /__shell__/window 兜底。 */
export async function sendWindowAction(
  action: WindowAction,
  deps?: { rpc?: ShellRpcClient; fetchImpl?: typeof fetch; readGlobals?: () => ShellRpcGlobals },
): Promise<void> {
  const method = { minimize: 'window_minimize', 'toggle-maximize': 'window_toggle_maximize', close: 'window_close' }[action]
  const rpc = deps?.rpc ?? shellRpc
  const readGlobals = deps?.readGlobals ?? (() => globalThis as unknown as ShellRpcGlobals)
  if (typeof readGlobals().__electrobunHostBridge?.postMessage === 'function') {
    await rpc.invoke(method, {}, { timeoutMs: 30_000 })
    return
  }
  const fetchImpl = deps?.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const token = readGlobals().__DSH_SHELL_VIEW_TOKEN__
  const response = await fetchImpl(WINDOW_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(typeof token === 'string' && token !== '' ? { [VIEW_TOKEN_HEADER]: token } : {}) },
    body: JSON.stringify({ action }),
  })
  if (!response.ok) throw new Error(`window action failed: ${String(response.status)}`)
}
