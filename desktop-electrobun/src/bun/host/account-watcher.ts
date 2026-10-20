/**
 * 主进程账号 watcher（#169）：壳自己订阅宿主的账号状态流，登录进入「等浏览器」时把授权页
 * 交给系统浏览器。
 *
 * 为什么必须由主进程做：DSH 客户端在桌面语义下只发起 `startSignIn`（`BrowserLogin` 的弹窗
 * 路径是纯 web 客户端专用，桌面分支明确跳过），官方 Electron 宿主在主进程订阅
 * `account/watch` 并 `shell.openExternal` ——壳是另一个宿主，得补上同一件事；渲染器是
 * CEF 还是 WebView 与此无关（页面压根不会开窗）。
 *
 * 协议（与 apps/desktop/src/account-backend.ts 同款）：
 *   · 连宿主 `/api/remote.mux` 的 WebSocket，握手头带 `cookie` 与宿主 `origin`；
 *   · 连上先发 `{type:'open', streamId, endpoint:'account/watch', payload:{args:{}}}`；
 *   · 逐帧收 `{type:'item', streamId, value}`，value 就是账号投影；
 *   · 断线（宿主重启、ipc 抖动）1 秒后重连，每轮都现取 cookie/origin。
 */
import { isOpenableLoginUrl, loginUrlToOpen, platformLoginUrl } from '../../shared/app/account-login.ts'
import type { ShellThemePreference } from '../../shared/settings/shell-theme.ts'
import type { Logger } from '../../shared/logging/levels.ts'

/** 官方 REMOTE_STREAM_MUX_PATH 的同一条路径。 */
export const REMOTE_MUX_PATH = '/api/remote.mux'

/** 只用到 WebSocket 的这一面（Bun 客户端支持 headers，DOM 类型里没有）。 */
export interface WebSocketLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
  send(data: string): void
  close(): void
}

export interface AccountWatcherOptions {
  /** 宿主 origin；每次重连现取（宿主换端口也跟得上）。 */
  hostOrigin: () => string
  /** dsh 会话 cookie；每次重连现取。空串 = 还没换到，等下一轮。 */
  cookie: () => string
  /** 打开系统浏览器（主进程注入）；没给就不启动 watcher。 */
  openExternal?: (url: string) => void
  /** 当前主题偏好；system 不带 theme 参数。缺省跟着不改地址。 */
  theme?: () => ShellThemePreference
    log: Logger
  /** 重连间隔（测试可调）；缺省 1s，与官方 desktop 的重连节奏一致。 */
  retryMs?: number
  /** 测试注入 socket 工厂。 */
  createSocket?: (url: string, headers: Record<string, string>) => WebSocketLike
}

export interface AccountWatcher {
  /** 幂等：宿主就绪（applyHost）后调用；已在跑就什么都不做。 */
  start(): void
  /** 停表、断流；之后再 start() 不会复活（服务面退出即终态）。 */
  stop(): void
}

const DEFAULT_RETRY_MS = 1000

function defaultSocketFactory(url: string, headers: Record<string, string>): WebSocketLike {
  const Ctor = WebSocket as unknown as new (url: string, options?: { headers?: Record<string, string> }) => WebSocketLike
  return new Ctor(url, { headers })
}

export function createAccountWatcher(options: AccountWatcherOptions): AccountWatcher {
  const log = options.log
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS
  const createSocket = options.createSocket ?? defaultSocketFactory
  let stopped = false
  let started = false
  let retry: ReturnType<typeof setTimeout> | null = null
  let socket: WebSocketLike | null = null
  let openedAttempt = ''

  const scheduleRetry = (): void => {
    if (stopped || retry !== null) return
    retry = setTimeout(() => {
      retry = null
      connect()
    }, retryMs)
  }

  const connect = (): void => {
    if (stopped) return
    const cookie = options.cookie()
    const hostOrigin = options.hostOrigin()
    if (cookie === '' || hostOrigin === '') {
      scheduleRetry()
      return
    }
    let url: URL
    try {
      url = new URL(REMOTE_MUX_PATH, hostOrigin)
    } catch {
      scheduleRetry()
      return
    }
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    let current: WebSocketLike
    try {
      current = createSocket(url.href, { cookie, origin: hostOrigin })
    } catch (error) {
        log.debug(`连宿主账号流失败：${error instanceof Error ? error.message : String(error)}`)
      scheduleRetry()
      return
    }
    socket = current
    const streamId = crypto.randomUUID()

    current.addEventListener('open', () => {
      current.send(JSON.stringify({ type: 'open', streamId, endpoint: 'account/watch', payload: { args: {} } }))
    })
    current.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      let frame: { type?: unknown; streamId?: unknown; value?: unknown }
      try {
        frame = JSON.parse(event.data) as typeof frame
      } catch {
        return
      }
      if (frame.streamId !== streamId) return
      if (frame.type === 'end' || frame.type === 'error') {
        try {
          current.close()
        } catch {}
        return
      }
      if (frame.type !== 'item') return
      const next = loginUrlToOpen(frame.value, openedAttempt)
      openedAttempt = next.openedAttempt
      if (next.url === null) return
      if (!isOpenableLoginUrl(next.url)) {
          log.warn('授权地址不是可打开的外链，忽略')
        return
      }
      const target = options.theme === undefined ? next.url : platformLoginUrl(next.url, options.theme())
      options.openExternal?.(target)
        log.info(`登录等待中：授权页转系统浏览器 ${target}`)
    })
    current.addEventListener('error', () => {
      try {
        current.close()
      } catch {}
    })
    current.addEventListener('close', () => {
      if (socket === current) socket = null
      scheduleRetry()
    })
  }

  return {
    start(): void {
      if (started || stopped || options.openExternal === undefined) return
      started = true
          log.info(`主进程账号 watcher 启动（宿主 ${options.hostOrigin() || '未就绪'}）`)
      connect()
    },
    stop(): void {
      stopped = true
      if (retry !== null) {
        clearTimeout(retry)
        retry = null
      }
      const current = socket
      socket = null
      try {
        current?.close()
      } catch {}
    },
  }
}
