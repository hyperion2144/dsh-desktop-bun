/**
 * 壳 RPC 客户端核心（#185）：全部页面入口共用的唯一协议实现。
 *
 * wire 协议对齐官方 Electrobun Typed RPC（api/shared/rpc.ts）：
 *   - 请求 `{type:'request', id, method, params}` 经原生桥 postMessage(JSON 字符串) 上送；
 *   - 回包 `{type:'response', id, success, payload|error}` 由宿主回调 receiveMessageFromHost(对象)。
 *
 * 四个消费点（全部从这里取实现，协议常量只剩这一处）：
 *   1. 壳 preload（preload.ts）：装全局唯一分发器 `__DSH_SHELL_RPC__`，注入脚本与页面插件共用；
 *   2. 两扇 html 弹窗（profile-dialog.ts / update-notice-dialog.ts）：html 文档里没有模块系统，
 *      以 `SHELL_RPC_CORE_SOURCE`（本工厂的函数源码字符串）内联进 <script> 自举；
 *   3. 桌面插件 shell-rpc.ts：壳 preload 分发器在场时整条官方通道委托给它；dev/旧壳缺席时
 *      用本工厂自装接收面。
 *
 * 语义基线（与 #128 归一时的四入口行为一致）：
 *   - 默认 15s 单请求超时（官方 createRPC 的 1000ms 对文件选择器太紧），`noTimeout` 可关
 *     （长任务靠状态快照收尾，不靠客户端超时砍它）；
 *   - 绝不重试：协议没有取消，超时后壳侧 handler 仍会跑到底，toggle 类命令重试会翻两次；
 *   - 请求 id 从 1 起、到 MAX_ID 溢出归 1；`receive` 对非 response 包与无主 id 静默忽略。
 */

/** invoke 的可选行为（透传自各消费点的公开选项）。 */
export interface RpcInvokeOptions {
  /** 单请求超时毫秒数；缺省用工厂的 timeoutMs（15s）。 */
  timeoutMs?: number
  /** 不挂客户端超时：pending 一直留着，回包什么时候到都还能收（#97 长任务语义）。 */
  noTimeout?: boolean
}

export interface RpcCoreOptions {
  /** 发送函数：把序列化好的 request 包发出去；同步抛错等价于「通道不可用」。 */
  post: (message: string) => void
  /** 默认单请求超时（毫秒），缺省 15_000。 */
  timeoutMs?: number
  /** 请求 id 上限，溢出归 1；缺省 1e10（对齐官方 MAX_ID）。 */
  maxId?: number
  /** 计时器注入（测试与无 window 环境用）；缺省全局 setTimeout。 */
  setTimeout?: (fn: () => void, ms: number) => unknown
  /** 计时器注入（与 setTimeout 成对）；缺省全局 clearTimeout。 */
  clearTimeout?: (handle: unknown) => void
}

export interface RpcCore {
  invoke(method: string, params?: Record<string, unknown>, options?: RpcInvokeOptions): Promise<unknown>
  /** 回包分发口：接到 receiveMessageFromHost（或包一层透传框架 handler）上。 */
  receive(packet: unknown): void
}

/**
 * 自包含工厂：函数体不引用任何模块级标识，`createRpcCore.toString()` 即得可求值的纯 JS
 * （Bun 转译已剥类型），这就是 `SHELL_RPC_CORE_SOURCE` 能内联进 html 的前提。
 */
export function createRpcCore(options: RpcCoreOptions): RpcCore {
  const post = options.post
  const defaultTimeoutMs = options.timeoutMs ?? 15_000
  const maxId = options.maxId ?? 1e10
  const scheduleTimeout = options.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const cancelTimeout = options.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as number))
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: unknown }
  >()
  let nextId = 0
  function settle(packet: { id?: unknown; success?: unknown; payload?: unknown; error?: unknown }): void {
    const id = typeof packet.id === 'number' ? packet.id : NaN
    const waiter = pending.get(id)
    if (waiter === undefined) return
    pending.delete(id)
    if (waiter.timer !== undefined) cancelTimeout(waiter.timer)
    if (packet.success === true) waiter.resolve(packet.payload)
    else waiter.reject(new Error(typeof packet.error === 'string' ? packet.error : 'shell rpc failed'))
  }
  return {
    invoke(method, params, invokeOptions) {
      nextId = nextId < maxId ? nextId + 1 : 1
      const id = nextId
      return new Promise((resolve, reject) => {
        // noTimeout 时压根不挂计时器——pending 一直留着，回包什么时候到都还能收（#97）。
        const timer =
          invokeOptions?.noTimeout === true
            ? undefined
            : scheduleTimeout(() => {
                pending.delete(id)
                reject(new Error('RPC request timed out.'))
              }, invokeOptions?.timeoutMs ?? defaultTimeoutMs)
        pending.set(id, { resolve, reject, timer })
        try {
          post(JSON.stringify({ type: 'request', id, method, params: params ?? {} }))
        } catch (error) {
          pending.delete(id)
          if (timer !== undefined) cancelTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    receive(packet) {
      if (!packet || typeof packet !== 'object' || (packet as { type?: unknown }).type !== 'response') return
      settle(packet as { id?: unknown; success?: unknown; payload?: unknown; error?: unknown })
    },
  }
}

/**
 * 工厂的函数源码（Bun 已剥类型的纯 JS）：给没有模块系统的 html 弹窗内联自举用——
 * `new Function('return (' + SHELL_RPC_CORE_SOURCE + ')')()` 即还原同一实现。
 */
export const SHELL_RPC_CORE_SOURCE: string = createRpcCore.toString()
