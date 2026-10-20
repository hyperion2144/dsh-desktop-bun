/**
 * 页面控制台攒批（#54 数据面聚合）。
 *
 * 背景：webview console 镜像以前是「一条 console = 一次 RPC（log_console）」，页面刷屏时
 * 这串小请求会跟 loopback 反代数据面抢同一个壳事件循环（Windows 上尤其明显）。这里把
 * N 条消息合并成一次 `log_console_batch` 调用——满足任意一条即发：
 *   · 攒满 `maxItems` 条；
 *   · 累计字符（JSON 尺寸近似）超过 `maxChars`；
 *   · 最老一条等满 `flushMs` 毫秒。
 * 崩溃/刷新最多丢一个未 flush 的窗口，与页面日志的调试价值相称。
 */
export interface ConsoleLogItem {
  level: string
  msg: string
  pageUrl: string
}

export interface ConsoleBatchOptions {
  /** 原子上报：拿到整批（按 push 顺序）。同步抛错按丢弃处理（与旧「单条失败吞掉」同口径）。 */
  send: (items: ConsoleLogItem[]) => void
  /** 攒满即发（默认 20） */
  maxItems?: number
  /** 累计字符超过即发（默认 16384） */
  maxChars?: number
  /** 最老一条的最大等待毫秒（默认 100，与壳日志缓冲同窗口） */
  flushMs?: number
  /** 时钟可注入（测试用）；缺省 Date.now */
  now?: () => number
  /** 定时器可注入（测试用）；返回取消函数。缺省 setTimeout/clearTimeout */
  schedule?: (fn: () => void, ms: number) => () => void
}

export interface ConsoleBatch {
  push(item: ConsoleLogItem): void
  /** 立即发掉手头的批次（visibilitychange/beforeunload 时调用，防丢尾） */
  flush(): void
}

export function createConsoleBatch(options: ConsoleBatchOptions): ConsoleBatch {
  const maxItems = options.maxItems ?? 20
  const maxChars = options.maxChars ?? 16_384
  const flushMs = options.flushMs ?? 100
  const now = options.now ?? (() => Date.now())
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    })

  let items: ConsoleLogItem[] = []
  let chars = 0
  let oldestAt: number | null = null
  let cancelTimer: (() => void) | null = null

  const dispatch = (): void => {
    if (cancelTimer !== null) {
      cancelTimer()
      cancelTimer = null
    }
    if (items.length === 0) return
    const batch = items
    items = []
    chars = 0
    oldestAt = null
    try {
      options.send(batch)
    } catch {
      // send 同步抛错：这批丢弃，不影响页面
    }
  }

  return {
    push(item) {
      items.push(item)
      chars += item.msg.length + item.pageUrl.length + item.level.length + 16
      if (oldestAt === null) {
        oldestAt = now()
        cancelTimer = schedule(dispatch, flushMs)
      }
      if (items.length >= maxItems || chars >= maxChars) dispatch()
    },
    flush: dispatch,
  }
}
