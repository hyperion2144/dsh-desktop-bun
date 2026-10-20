// 宿主监督 module（#187 设计 / #183 实施）：从 startService 拆出的宿主生命周期。
//
// 边界（#187 决策）：
//   - 只收宿主事实与宿主生命周期：connect（本地 spawn + 远程 cookie 换取）、supervise +
//     createRestartLedger、watchdog、宿主台账（register/forget/sweep）、stopping/starting
//     单飞、hostPid/hostOrigin/cookie/injections/blocked/restarting。
//   - adoptLayout（运行时切换）留服务面；restart 前服务面先 adoptLayout，本模块经 spec()
//     每次 spawn 现算布局/端口/代理——不缓存，重启即拿到最新设置。
//   - 状态经快照回调发布（回调而非 EventEmitter；factory 注入假宿主/假时钟便于单测）；
//     服务面 publish() 组合公开 ShellState，是状态文件的唯一写者。
//   - restarting 只进快照（服务面映射 dshStatusCode=4）；dshStatusCode 0..7 仍留服务面。

import type { ShellLayout } from '../runtime/runtime.ts'
import type { ProxyEnv } from '../../shared/net/proxy-env.ts'
import { createRestartLedger, type RestartLedger } from './supervisor.ts'
import { createWatchdogState, tickWatchdog, WATCHDOG_INTERVAL_MS } from '../../shared/watchdog.ts'
import { readHostRecords, upsertHostRecord, writeHostRecords } from './host-registry.ts'
import { sweepProcessRemnants } from './process-tree.ts'
import { portOpen } from '../net/port-owner.ts'
import { normalizeRemoteUrl, remoteDisplay, remoteHostPort, remoteOrigin } from '../../shared/net/remote.ts'
import { extractTokenFromUrl } from '../../shared/net/port-claim.ts'
import { SCENARIO } from '../../shared/notify/notify-policy.ts'
import { startHost, type HostHandle } from './host.ts'

/** 与 service.ts 的 ShellServiceStatus 同一口径（5 态），避免反向 import 成环。 */
export type HostLifecycleStatus = 'stopped' | 'starting' | 'running' | 'failed' | 'blocked'

/** 一次 spawn 需要的全部输入——spec() 每次 connect 现算，宿主重启即拿到最新设置。 */
export interface HostSpec {
  /** 远程 dsh 地址（设置 remoteAddr 归一后的值）；非空 = 远程模式，不 spawn 宿主 */
  remoteAddr: string | null
  layout: ShellLayout
  clientVersion: string
  mode: 'existing' | 'fresh'
  env: Record<string, string | undefined>
  patchFiles: readonly string[]
  upstreamPort: number
  pagePort: number
  lanePort: number
  /** #47 remote 视图 token：服务面缓存（首铸沿用同一枚），本模块只在本地 spawn 时取 */
  remoteViewToken: () => string | undefined
  proxy: ProxyEnv | null
  cloudflaredBin: string | undefined
  pathShimDir: string | undefined
  notify: { port: number; token: string }
  /** fresh 起不来且 profile 已有 package.json 时按 existing 重试一次（首启脚手架窗口） */
  retryExisting: boolean
}

/** 宿主事实快照：经回调发布给服务面（组合 ShellState、刷 boot 载荷/反代、写状态文件）。 */
export interface HostSnapshot {
  hostPid: number
  hostOrigin: string
  cookie: string
  injections: readonly unknown[]
  remoteAddr: string | null
  status: HostLifecycleStatus
  error: string | null
  /** 守护器正在重启（服务面映射 dshStatusCode=4） */
  restarting: boolean
  stopping: boolean
  blocked?: string
}

export interface HostSupervisorDeps {
  /** 每次 spawn 现算启动输入；不缓存 */
  spec: () => HostSpec
  /** 宿主台账文件（register/forget） */
  registryFile: string
  /** 注入口（测试给假宿主）；缺省真 startHost */
  startHostFn?: (input: Parameters<typeof startHost>[0]) => Promise<HostHandle>
  /** watchdog 探测端口覆盖（缺省：远程取远程端口，本地取上游端口） */
  probePort?: () => number
  /** 初始 readyOnce：远程模式或启动判定 free 时已视为就绪（服务面启动判定传入） */
  readyInitially?: boolean
  ledger?: RestartLedger
  now?: () => number
  watchdogIntervalMs?: number
  log: (line: string) => void
  /** 场景通知（give-up / 自动重启 / watchdog 线） */
  notify: (scenario: string, body: string) => void
  /** 宿主上报新注入清单（HOST-INJECTIONS）：本模块存档后原样转交（服务面刷 boot 载荷） */
  onInjections: (rows: readonly unknown[]) => void
  /** 宿主事实/状态落定：服务面组合 ShellState 并写状态文件（唯一写者） */
  onHost: (snapshot: HostSnapshot) => void
  /** 守护器重启完成（服务面：dshStatusCode=2 + onHostRestart） */
  onRestart: (snapshot: HostSnapshot) => void
  /** 宿主放弃：terminal=true 判定层放弃（服务面加 dshStatusCode=5 + 启动失败通知），false 仅 connect 失败 */
  onGiveUp: (snapshot: HostSnapshot, reason: string, terminal: boolean) => void
  /** restarting 翻转发布（服务面映射 dshStatusCode=4） */
  onChange: (snapshot: HostSnapshot) => void
  /** 崩溃后的服务面清理（忙租约 arbiter.clear + keepAwake.tick），原 supervise 语义 */
  onCrash: () => void
}

export interface HostSupervisor {
  /** 把 DSH 拉起来（connect + 台账登记 + 发布 + 武装守护器）；单飞 */
  start: () => Promise<void>
  /** 手动重启：重算 remoteAddr 后停宿主——本地路径交给退出事件那条守护器回路 */
  restart: () => Promise<void>
  /** 停守护器 + 停宿主 + 摘台账 */
  stop: () => Promise<void>
  /** 服务面端口判定 blocked 时告知 */
  blocked: (reason: string) => void
  /** 宿主判别位（服务面 ensureRunning/adoptLayout 萰 failed/starting/running 时写） */
  setStatus: (status: HostLifecycleStatus, error?: string | null) => void
  state: () => HostSnapshot
  /** 手动触发一次发布（服务面改了自己的字段后刷新组合态/状态文件） */
  onChange: () => void
}

export function createHostSupervisor(deps: HostSupervisorDeps): HostSupervisor {
  const spawnHost = deps.startHostFn ?? startHost
  const ledger = deps.ledger ?? createRestartLedger()
  const now = deps.now ?? ((): number => Date.now())

  // ---- 宿主事实（本模块唯一持有） ----
  let host: HostHandle | undefined
  let hostOrigin = ''
  let cookie = ''
  let hostInjections: readonly unknown[] = []
  let remoteAddr: string | null = null
  let blockedMessage: string | undefined
  let status: HostLifecycleStatus = 'stopped'
  let statusError: string | null = null
  let restarting = false
  let stopping = false
  /** connect 成功时的 spec 快照：watchdog/registerHost 等高频路径只读它——spec() 现算带副作用链（垫片重写 + 系统代理探测都打日志），不能每 tick 触发（#195） */
  let activeSpec: HostSpec | null = null
  let readyOnce = deps.readyInitially ?? false
  /** 正在拉的那次（并发调用复用它，不重复 spawn 宿主） */
  let starting: Promise<void> | null = null

  const snapshot = (): HostSnapshot => ({
    hostPid: host?.pid ?? 0,
    hostOrigin,
    cookie,
    injections: hostInjections,
    remoteAddr,
    status,
    error: statusError,
    restarting,
    stopping,
    ...(blockedMessage === undefined ? {} : { blocked: blockedMessage }),
  })
  const publish = (): void => {
    deps.onHost(snapshot())
  }
  const setRestarting = (value: boolean): void => {
    if (restarting === value) return
    restarting = value
    deps.onChange(snapshot())
  }

  // 起宿主 + 取 cookie。守护器重启时重复调这个（cookie 与宿主事实都换新的）。
  const connect = async (): Promise<void> => {
    const s = deps.spec()
    remoteAddr = s.remoteAddr
    if (remoteAddr !== null) {
      // ---- 远程模式（旧壳 navigate_remote / startup 远程短路）：不 spawn 宿主，数据面指向远程。
      // URL 里的 token 换会话 cookie；拿不到照常起服务面，由 dsh 自行展示鉴权错误页（旧壳同口径）。
      host = undefined
      hostInjections = []
      const upstream = remoteOrigin(remoteAddr)
      const token = extractTokenFromUrl(remoteAddr)
      cookie = ''
      if (token !== null) {
        try {
          const auth = await fetch(`${upstream}/?token=${token}`, { redirect: 'manual' })
          const setCookies = (auth.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
          cookie = setCookies[0]?.split(';')[0] ?? ''
          deps.log(`[remote] 换 cookie：auth ${String(auth.status)} | cookie = ${cookie === '' ? '(none)' : `${cookie.slice(0, 18)}…`}`)
        } catch (error) {
          deps.log(`[remote] 换 cookie 失败（照常继续，由 dsh 展示鉴权页）：${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        deps.log('[remote] 地址里没有 ?token=（旧格式 host:port），按老版 dsh 直连（新版会 401）')
      }
      hostOrigin = upstream
      deps.log(`[remote] 数据面上游 = ${remoteDisplay(remoteAddr)} | 页面文档仍由本机 dist 出`)
      activeSpec = s
      return
    }
    const spawnInput = (mode: 'existing' | 'fresh'): Parameters<typeof startHost>[0] => ({
      layout: s.layout,
      clientVersion: s.clientVersion,
      mode,
      env: s.env,
      onLog: deps.log,
      // #101：宿主运行期图重算（插件更新/装卸）会经 HOST-INJECTIONS 通道推送新清单。
      // 本模块存档（快照口径），再转交服务面刷 boot 载荷（bootPayloadLive 守护在服务面）。
      onInjections: (rows): void => {
        hostInjections = rows
        deps.onInjections(rows)
      },
      patchFiles: [...s.patchFiles],
      upstreamPort: s.upstreamPort,
      shellPagePort: s.pagePort,
      shellRpcViewToken: s.remoteViewToken(),
      lanePort: s.lanePort,
      proxy: s.proxy,
      cloudflaredBin: s.cloudflaredBin,
      pathShimDir: s.pathShimDir,
      notify: s.notify,
    })
    try {
      host = await spawnHost(spawnInput(s.mode))
    } catch (error) {
      // 首次启动：dsh 刚把 profile 脚手架（cordis.yml/package.json）落盘，但依赖树还是空的，
      // 插件会整片 failed to import。摊平 profile 树后按 existing 重试一次——只在首启发生。
      if (s.mode !== 'fresh' || !s.retryExisting) throw error
      host = await spawnHost(spawnInput('existing'))
    }
    hostOrigin = new URL(host.ready.url).origin
    hostInjections = host.ready.injections
    deps.log(`host ready | dsh = ${hostOrigin} | injections = ${String(hostInjections.length)}`)

    // ---- 取 cookie：303 + set-cookie（官方 authenticateWebHost 语义，不解析 stdout 的 token 行）----
    const auth = await fetch(host.ready.url, { redirect: 'manual' })
    const setCookies = (auth.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    cookie = setCookies[0]?.split(';')[0] ?? ''
    deps.log(`auth: ${String(auth.status)} ${auth.headers.get('location') ?? ''} | cookie = ${cookie === '' ? '(none)' : `${cookie.slice(0, 18)}…`}`)
    if (cookie === '') {
      await host.stop()
      throw new Error('没拿到 dsh 会话 cookie（303 + set-cookie 流程失败）')
    }
    activeSpec = s
  }

  const registerHost = (): void => {
    const records = upsertHostRecord(readHostRecords(deps.registryFile), {
      hostPid: host?.pid ?? 0,
      shellPid: process.pid,
      profile: (activeSpec ?? deps.spec()).layout.profile,
      startedAt: new Date().toISOString(),
    })
    writeHostRecords(deps.registryFile, records)
  }
  const forgetHosts = (): void => {
    writeHostRecords(
      deps.registryFile,
      readHostRecords(deps.registryFile).filter((entry) => entry.shellPid !== process.pid),
    )
  }
  // #60：崩溃自愈的伴生孤儿清扫。宿主死后直接子代被 init/launchd 收养（按 ppid 找不到），
  // 只能靠宿主生前的树快照（host.lastTree()）定位；清扫与退避睡眠并行，树灭确认后才拉新宿主。
  const sweepHostTree = (pids: number[]): Promise<number[]> => sweepProcessRemnants({ pids, onLog: deps.log })

  // ---- 宿主守护器：异常退出就退避重启，并把服务面切到新宿主（页面不再停在转发失败） ----
  const supervise = async (): Promise<void> => {
    registerHost()
    const code = await host?.exited
    if (stopping) return
    deps.onCrash()
    const decision = ledger.decide(now())
    deps.log(`宿主 ${String(host?.pid ?? 0)} 意外退出（code = ${String(code)}）：${decision.reason}`)
    if (!decision.restart) {
      deps.onGiveUp(snapshot(), decision.reason, true)
      return
    }
    setRestarting(true)
    ledger.record(now())
    // #60 树灭前置清理：与退避睡眠并行（自愈节奏不变），sleep 回来等清扫收尾——
    // 树灭确认才 connect() 拉新宿主；清扫超时放行（记日志），不阻塞自愈。
    const treeSweep = sweepHostTree(host?.lastTree() ?? [])
    await Bun.sleep(decision.delayMs)
    const treeLeftovers = await treeSweep
    if (treeLeftovers.length > 0) {
      deps.log(`[shell] 伴生进程清扫超时，放行：${treeLeftovers.join(', ')}（不阻塞自愈）`)
    }
    if (stopping) return
    try {
      await connect()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      deps.log(`守护器重启宿主失败：${reason}`)
      deps.onGiveUp(snapshot(), reason, false)
      return
    }
    setRestarting(false)
    publish()
    deps.log(`守护器已重启宿主：pid = ${String(host?.pid ?? 0)} | injections = ${String(hostInjections.length)}`)
    deps.notify(SCENARIO.SERVICE_HEALTH, `dsh 服务已自动重启（${(activeSpec ?? deps.spec()).layout.profile}）`)
    deps.onRestart(snapshot())
    void supervise()
  }

  // ---- D2 守护器：周期 TCP 判活（旧壳 lib.rs 守护器的等价物，语义照旧壳）----
  // 只管「运行中」：readyOnce 之前（启动/重启期/等选模式）归 spawn 与守护器退出事件管。
  const watchdog = createWatchdogState()
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  const probePort = (): number => {
    if (deps.probePort !== undefined) return deps.probePort()
    if (remoteAddr !== null) {
      const port = Number(remoteHostPort(remoteAddr).split(':').pop() ?? '')
      if (Number.isInteger(port) && port > 0) return port
    }
    return (activeSpec ?? deps.spec()).upstreamPort
  }
  const watchdogTick = async (): Promise<void> => {
    if (stopping || !readyOnce) return
    const up = await portOpen(probePort())
    const verdict = tickWatchdog(watchdog, {
      up,
      spawned: host !== undefined,
      remote: remoteAddr !== null,
      now: now(),
    })
    if (verdict.kind === 'healthy') {
      if (verdict.reset) deps.log('[watchdog] 连续健康 ≥2 分钟，自愈计数已重置')
      return
    }
    if (verdict.kind === 'remote-down') {
      if (verdict.notify) deps.notify(SCENARIO.SERVICE_HEALTH, `远程 dsh 不可达：${verdict.verbose}`)
      return
    }
    // 兼容复用已移除（地图 #2）：壳不再认领「外部实例」；此裁决仅在宿主交接窗口瞬时可达，跳过本轮即可
    if (verdict.kind === 'external-down') return
    if (verdict.kind === 'gave-up') {
      deps.log('[watchdog] 连续自动恢复失败 3 次，停止自愈')
      deps.notify(SCENARIO.SERVICE_HEALTH, 'dsh 服务异常：连续自动恢复失败，请手动重启')
      return
    }
    deps.log(`[watchdog] dsh 不可达（TCP 探测失败），自动重启（第 ${String(verdict.attempt)} 次）`)
    deps.notify(SCENARIO.SERVICE_HEALTH, `dsh 服务异常，正在自动重启（第 ${String(verdict.attempt)} 次）`)
    if (host !== undefined) {
      // 交给退出事件那条路：守护器杀旧拉新，watchdog 的封顶比它的退避更严
      void host.stop().catch(() => {})
    } else if (remoteAddr !== null) {
      try {
        await connect()
        publish()
      } catch (error) {
        deps.log(`[watchdog] 远程重连失败：${String(error)}`)
      }
    }
  }

  const start = (): Promise<void> => {
    if (starting !== null) return starting
    starting = (async (): Promise<void> => {
      if (stopping) return
      await connect()
      registerHost()
      readyOnce = true
      if (watchdogTimer === null) {
        watchdogTimer = setInterval(() => {
          void watchdogTick()
        }, deps.watchdogIntervalMs ?? WATCHDOG_INTERVAL_MS)
        watchdogTimer.unref?.()
      }
      publish()
      // 崩溃自愈/退避重启那条线跟服务面绑在一起，不跟某一次启动绑（#60 的语义原样保留；
      // 远程模式 host=undefined 会让 supervise 立即返回一次 —— 原版 ensureRunning 尾部同样的既有怪行为，#187 决策保持）
      void supervise()
    })()
    // 清理链吞掉自身的 rejection（connect 失败时 starting 本体会 reject，由调用方处理；
    // 这条派生链不能再生第二个 unhandled rejection）
    void starting.catch(() => {}).then(() => {
      starting = null
    })
    return starting
  }

  const restart = async (): Promise<void> => {
    if (stopping) return
    // 远程/本地互切：先重算 remoteAddr（设置面板 nsSave 已落盘），再分流——
    // 远程模式没有宿主可杀，直接把服务面切过去；从远程切回本地时也没有宿主，立即拉起。
    // 其余（本地→本地）杀掉宿主即可：退出会唤醒守护器，由它重启并把服务面切过去。
    remoteAddr = deps.spec().remoteAddr
    await host?.stop()
    if (remoteAddr !== null || host === undefined) {
      await connect()
      publish()
    }
  }

  const stop = async (): Promise<void> => {
    stopping = true
    if (watchdogTimer !== null) {
      clearInterval(watchdogTimer)
      watchdogTimer = null
    }
    ledger.reset()
    try {
      await host?.stop()
    } catch {}
    forgetHosts()
  }

  const blocked = (reason: string): void => {
    blockedMessage = reason
    status = 'blocked'
    publish()
  }

  const setStatus = (next: HostLifecycleStatus, error: string | null = null): void => {
    status = next
    statusError = error
    publish()
  }

  return {
    start,
    restart,
    stop,
    blocked,
    setStatus,
    state: snapshot,
    onChange: publish,
  }
}

/** 服务面启动判定要用的远程地址归一（与 spec().remoteAddr 同一来源口径）。 */
export const normalizeHostRemoteAddr = normalizeRemoteUrl
