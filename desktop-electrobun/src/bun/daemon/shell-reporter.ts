// 壳 → 守护 事件上报客户端（map #240 / #243）。
//
// 被守护拉起的壳（env 带 DSH_SHELL_CONTROL_URL）用它把 register/heartbeat/exit
// 三个事件 POST 到守护控制通道。守护只做进程级编排（拉/杀/重拉壳），窗口控制
// 不跨进程（#243 拍板）——所以上报的是进程事实（活着/窗口清单/退出意图），
// 不是窗口指令。
//
// 宽容原则：守护不在（先死/被手动杀）时壳照常当桌面跑——上报失败只记 warn，
// 绝不阻塞壳的任何路径；退出上报尽力而为（一次 try，不等响应）。

import { DAEMON_SHELL_EVENT_PATH } from './control.ts'
import { VIEW_TOKEN_HEADER } from '../../shared/net/view-grant.ts'
import type { ShellEvent, ShellExitIntent } from './control.ts'

// 注意：DAEMON_SHELL_EVENT_PATH 与 VIEW_TOKEN_HEADER 实际住在 daemon/control.ts
// 与 shared/net/view-grant.ts；这里从 control.ts 拿路径常量，view-grant 拿头名。
// （control.ts 同时被守护侧使用；壳侧只 import 纯常量与类型，不碰 Bun.serve。）

export interface ShellReporterOptions {
  /** 守护控制通道 origin（env DSH_SHELL_CONTROL_URL）；空串/undefined = 不上报 */
  controlOrigin: string | undefined
  /** 守护 token（env DSH_SHELL_CONTROL_TOKEN） */
  token: string | undefined
  /** 本壳的主 profile（instanceProfile） */
  profile: string
  /** 本壳 pid（缺省 process.pid；测试注入） */
  pid?: number
  /** 开窗清单轮询器：每次上报时取当前开着窗口的 profile 列表 */
  openProfiles: () => string[]
  /** 心跳间隔毫秒（缺省 15s；测试可调小） */
  intervalMs?: number
  fetchImpl?: typeof fetch
  onLog?: { info: (msg: string, ...rest: unknown[]) => void; warn: (msg: string, ...rest: unknown[]) => void }
}

export interface ShellReporter {
  /** 启动：发一次 register + 开始心跳。origin/token 缺失时是安静的 no-op。 */
  start(): Promise<void>
  /** 停心跳（壳退出前先 exit 上报再调它）。 */
  stop(): void
  /** 退出上报（尽力而为：一次 try，不等响应、不重试），随后停心跳。 */
  reportExit(exitIntent?: ShellExitIntent): void
}

export function createShellReporter(options: ShellReporterOptions): ShellReporter {
  const origin = options.controlOrigin
  const token = options.token
  const pid = options.pid ?? process.pid
  const intervalMs = options.intervalMs ?? 15_000
  const doFetch = options.fetchImpl ?? fetch
  const log = options.onLog
  let timer: ReturnType<typeof setInterval> | null = null

  // 未被守护拉起（env 缺）⇒ 整个 reporter 是 no-op——普通桌面启动零开销。
  const enabled = typeof origin === 'string' && origin !== '' && typeof token === 'string' && token !== ''

  function body(type: ShellEvent['type'], extra?: Partial<ShellEvent>): string {
    return JSON.stringify({
      type,
      profile: options.profile,
      pid,
      openProfiles: options.openProfiles(),
      ...extra,
    })
  }

  async function post(text: string): Promise<boolean> {
    if (!enabled) return false
    try {
      const response = await doFetch(`${origin}${DAEMON_SHELL_EVENT_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [VIEW_TOKEN_HEADER]: token! },
        body: text,
      })
      return response.ok
    } catch (error) {
      log?.warn(`守护上报失败（守护可能已退出，壳照常运行）：${String(error)}`)
      return false
    }
  }

  return {
    async start(): Promise<void> {
      if (!enabled) {
        log?.info('未配置守护控制通道，跳过壳事件上报')
        return
      }
      const ok = await post(body('register'))
      log?.info(`守护上报：register ${ok ? '已送达' : '未送达'}`)
      timer = setInterval(() => {
        void post(body('heartbeat'))
      }, intervalMs)
      // bun 的 interval 不阻塞退出（unref 不可移植地写死）——壳退出走 stop()/reportExit()。
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    reportExit(exitIntent?: ShellExitIntent): void {
      const text = body('exit', exitIntent === undefined ? {} : { exitIntent })
      this.stop()
      if (!enabled) return
      // 退出路径：一次尽力而为的上报。用 keepalive 风格的独立 fetch，不等也不拖退进程。
      void doFetch(`${origin}${DAEMON_SHELL_EVENT_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [VIEW_TOKEN_HEADER]: token! },
        body: text,
      }).catch(() => undefined)
    },
  }
}
