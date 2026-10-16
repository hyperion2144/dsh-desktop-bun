// 平台防休眠断言（旧壳 `desktop/src-tauri/src/power/mod.rs` 的等价物，规格第 6 条「防休眠自写」）。
//
// 结构照搬旧壳：**纯裁决**（`src/shared/power-arbiter.ts`）+ 常驻 tick 循环，
// tick 是唯一调用平台断言的地方——Windows 的 `SetThreadExecutionState` 是**线程级**的，
// 断言必须与调用它的线程同生共死；macOS 的断言随进程退出自动释放。
//
// 平台实现：
//   · macOS：`caffeinate -i -w <壳 pid>`（`-i` = PreventUserIdleSystemSleep，即旧壳的
//     `IOPMAssertionCreateWithName("PreventUserIdleSystemSleep")`；`-w` 让断言在壳消失时
//     自动收摊，不必依赖我们的清理路径跑完）。释放 = 杀掉这个子进程。
//   · Windows：`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` / 清位
//     `ES_CONTINUOUS`（经 bun:ffi 调 kernel32）。**未在 Windows 实测**——留给 Windows CI。
//   · Linux（#75）：拿会话/登录级的抑制锁。GNOME 会话优先 `gnome-session-inhibit
//     --inhibit=suspend`——gsd-power 自动挂起前读的是 gnome-session 的 InhibitedActions
//     （FLAG_SUSPEND），而 logind 的 idle 锁拦不住它随后显式发起的 `Suspend()`；suspend 只挡
//     自动挂起（屏幕该熄照熄），idle 会连熄屏一起挡。非 GNOME 桌面用
//     `systemd-inhibit --what=idle --mode=block`（只挡空闲检测），gnome-session-inhibit 不上场。
//     两个工具的 inhibit 锁都挂在**它自己的 D-Bus 连接**上：壳被 SIGKILL（崩溃/强退）时工具
//     会变孤儿、锁泄漏（机器从此不再空闲休眠，darwin 的 `caffeinate -w <pid>` 没这个问题），
//     所以命令行带一个看门狗（`watchdogScript`）——探到壳没了就退出，被 init 收养也退出；
//     释放 = 杀掉持有进程。候选按会话探测、秒退逐个降级，全试完 = 认账：`capability()` 报
//     available=false + 面板可见的 reason，不假装持有、不静默。

import { dlopen, FFIType } from 'bun:ffi'
import type { Arbiter } from '../shared/power-arbiter.ts'
import { LEASE_STALE_MS } from '../shared/power-arbiter.ts'

/** tick 周期：开关/忙状态变化到断言落地的最坏延迟（旧壳同值）。 */
export const TICK_MS = 1_000

/** 断言名（macOS 进程名/Windows 无对应物，仅用于日志）。 */
export const ASSERTION_NAME = 'dsh-desktop-bun: session running'

/** Windows 的 `SetThreadExecutionState` 位。 */
export const ES_CONTINUOUS = 0x8000_0000
export const ES_SYSTEM_REQUIRED = 0x0000_0001

/** Windows 断言：可注入（macOS 上只能靠类型与日志保真，Windows CI 上真跑）。 */
export type WindowsAssert = (flags: number) => boolean

/** Linux 断言通道：logind 的 D-Bus Inhibit 与 GNOME 会话抑制的官方命令行封装。 */
export type LinuxInhibitBackend = 'systemd-inhibit' | 'gnome-session-inhibit'

/** 面板可见的能力快照（#75：拿不到通道不许静默）。 */
export interface KeepAwakeCapability {
  platform: string
  backend: 'caffeinate' | 'execution-state' | LinuxInhibitBackend | null
  /** 本平台此刻有没有真能立住的通道（持有进程秒退 = false）。 */
  available: boolean
  /** available=false 时的用户可见原因（面板直接展示）。 */
  reason: string | null
}

/** 一个通道都探不到时的原因文案（框架语「本环境拿不到防休眠通道」由面板/日志行补）。 */
export const LINUX_NO_BACKEND_REASON = '未找到 systemd-inhibit / gnome-session-inhibit（非 systemd/GNOME 会话）'

/** Windows 断言调用失败时的原因文案（Windows 上未实测过这条路径）。 */
const WINDOWS_ASSERT_FAILED_REASON = 'SetThreadExecutionState 调用失败'

/** GNOME 会话判定：XDG_CURRENT_DESKTOP / XDG_SESSION_DESKTOP / DESKTOP_SESSION 任一含 gnome。 */
function isGnomeSession(env: Record<string, string | undefined>): boolean {
  return [env['XDG_CURRENT_DESKTOP'], env['XDG_SESSION_DESKTOP'], env['DESKTOP_SESSION']].some(
    (value) => typeof value === 'string' && value.toLowerCase().includes('gnome'),
  )
}

/**
 * 候选顺序：GNOME 会话先 gnome-session（suspend 抑制才是 gsd-power 认的那把锁），再 systemd
 * 兜底；非 GNOME 桌面只认 systemd-inhibit——gnome-session-inhibit 在那儿白起进程、还会刷日志。
 */
function linuxBackendOrder(env: Record<string, string | undefined>): LinuxInhibitBackend[] {
  return isGnomeSession(env) ? ['gnome-session-inhibit', 'systemd-inhibit'] : ['systemd-inhibit']
}

/**
 * 按会话与优先级探测可用的 Linux 通道（which 注入，缺省 Bun.which；env 注入，缺省 process.env）。
 * 顺序只由会话决定，再用 which() 滤掉不存在的。
 */
export function linuxInhibitBackends(
  which: (command: string) => string | null,
  env: Record<string, string | undefined> = process.env,
): LinuxInhibitBackend[] {
  return linuxBackendOrder(env).filter((backend) => {
    const found = which(backend)
    return found !== null && found !== ''
  })
}

/**
 * 看门狗脚本：`kill -0` 探壳活着；壳没了、或自己已被 init 收养（inhibit 工具被我们杀掉后就是这
 * 种状态）就退出。没有它，壳被 SIGKILL 时 inhibit 锁会随孤儿进程一直挂着。
 *
 * 两条孤儿腿都要留（容器实测：debian 的 dash 与 alpine 的 busybox ash 都不刷新 `$PPID`——收养
 * 不会把它写成 1，只留 `$PPID -le 1` 会漏杀，release 后白留一个 sleep 循环）：
 *   · `$PPID -le 1`：父进程先死、sh 起来时已被 init 收养的竞态；
 *   · `kill -0 "$PPID"`：`$PPID` 是启动时记下的原父进程 pid，父死即探活失败。
 */
export function watchdogScript(pid: number): string {
  return `while kill -0 ${String(pid)} 2>/dev/null; do [ "$PPID" -le 1 ] && exit 0; kill -0 "$PPID" 2>/dev/null || exit 0; sleep 2; done`
}

/** 通道的命令行（why 用 ASSERTION_NAME；子进程活着 = 断言在，杀掉 = 释放，等价 caffeinate -w）。 */
export function linuxInhibitCommand(backend: LinuxInhibitBackend, why: string, pid: number): string[] {
  const watchdog = watchdogScript(pid)
  if (backend === 'systemd-inhibit') {
    return ['systemd-inhibit', '--what=idle', '--mode=block', `--why=${why}`, 'sh', '-c', watchdog]
  }
  return ['gnome-session-inhibit', '--inhibit=suspend', `--reason=${why}`, 'sh', '-c', watchdog]
}

export interface AwakeChild {
  pid: number
  kill: () => void
  /** Bun.spawn 的 exited；注入的假子进程用它演「起来就秒退」（#75）。 */
  exited?: Promise<number>
}

export interface KeepAwakeOptions {
  arbiter: Arbiter
  platform?: NodeJS.Platform
  log?: (line: string) => void
  tickMs?: number
  /** 壳自己的 pid（macOS `caffeinate -w` 用；缺省 `process.pid`）。 */
  pid?: number
  /** 起断言进程（测试注入；缺省 `Bun.spawn`）。 */
  spawnCommand?: (command: string[]) => AwakeChild
  /** 查命令路径（**只在 platform === 'linux' 时使用**，别的平台不许因此多出 IO；缺省 `Bun.which`）。 */
  which?: (command: string) => string | null
  /** 会话探测用的环境变量（**只在 platform === 'linux' 时使用**；缺省 `process.env`）。 */
  env?: Record<string, string | undefined>
  /** Windows 断言（测试注入；缺省懒加载 bun:ffi）。 */
  setThreadExecutionState?: WindowsAssert
  /** 定时器注入（测试用假时钟）。 */
  setIntervalFn?: (fn: () => void, ms: number) => unknown
  clearIntervalFn?: (handle: unknown) => void
  now?: () => number
}

export interface KeepAwake {
  start: () => void
  stop: () => void
  /** 走一次裁决并落地（返回本次 tick 后的持有状态；测试直接调它）。 */
  tick: () => boolean
  isHolding: () => boolean
  /** 面板可见的能力快照（#75：Linux 拿不到通道时要能说出来）。 */
  capability: () => KeepAwakeCapability
  arbiter: Arbiter
}

function defaultSpawn(command: string[]): AwakeChild {
  const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
  return { pid: child.pid, kill: (): void => void child.kill(), exited: child.exited }
}

let windowsSymbol: ((flags: number) => number) | null | undefined

function defaultWindowsAssert(): WindowsAssert {
  // 懒加载：dlopen 只在真调用的平台上发生（非 Windows 上 kernel32 必失败）。
  if (windowsSymbol === undefined) {
    try {
      const lib = dlopen('kernel32.dll', {
        SetThreadExecutionState: { args: [FFIType.u32], returns: FFIType.u32 },
      })
      windowsSymbol = (flags: number): number => lib.symbols.SetThreadExecutionState(flags)
    } catch {
      windowsSymbol = null
    }
  }
  const symbol = windowsSymbol
  if (symbol === null) return (): boolean => false
  return (flags: number): boolean => symbol(flags) !== 0
}

/**
 * 创建防休眠循环：`start()` 起 tick（幂等），`stop()` 收摊并把断言释放掉。
 * 关闭开关或忙实例清零时，下一次 tick 就把断言放掉（最坏 1s 延迟，与旧壳一致）。
 */
export function createKeepAwake(options: KeepAwakeOptions): KeepAwake {
  const arbiter = options.arbiter
  const platform = options.platform ?? process.platform
  const log = options.log ?? ((): void => {})
  const tickMs = options.tickMs ?? TICK_MS
  const pid = options.pid ?? process.pid
  const now = options.now ?? ((): number => Date.now())
  const spawnCommand = options.spawnCommand ?? defaultSpawn
  const which = options.which ?? ((command: string): string | null => Bun.which(command))
  const env = options.env ?? process.env
  // #75：Linux 通道只在构造期探测一次；候选列表此后只减不增（不重复探测、不每秒重生进程）。
  const linuxBackends = platform === 'linux' ? linuxInhibitBackends(which, env) : []
  const setIntervalFn =
    options.setIntervalFn ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms))
  const clearIntervalFn =
    options.clearIntervalFn ?? ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>))

  let child: AwakeChild | null = null
  let windowsHeld = false
  let timer: unknown = null
  let warnedPlatform = false
  let linuxBackend: LinuxInhibitBackend | null = null
  let linuxReason: string | null = null
  let lastLinuxReasonLogged: string | null = null
  let windowsFailed = false
  let lastStale: string[] = []

  const applyWindows = (hold: boolean): void => {
    if (platform !== 'win32') return
    const assert = options.setThreadExecutionState ?? defaultWindowsAssert()
    const flags = hold ? ES_CONTINUOUS | ES_SYSTEM_REQUIRED : ES_CONTINUOUS
    const ok = assert(flags)
    windowsFailed = !ok
    if (!ok) log('[keepawake] SetThreadExecutionState 失败（Windows 上未实测过这条路径）')
  }

  const hold = (): void => {
    if (platform === 'darwin') {
      if (child !== null) return
      // `-i` 只挡系统空闲休眠；`-w <pid>` 让断言随壳进程消失自动释放。
      child = spawnCommand(['caffeinate', '-i', '-w', String(pid)])
      log(`[keepawake] 持有断言（${ASSERTION_NAME}）：caffeinate pid = ${String(child.pid)}`)
      return
    }
    if (platform === 'win32') {
      windowsHeld = true
      applyWindows(true)
      log(`[keepawake] 持有断言（${ASSERTION_NAME}）：SetThreadExecutionState`)
      return
    }
    if (platform === 'linux') {
      if (child !== null) return
      const backend = linuxBackends[0]
      if (backend === undefined) {
        // 候选耗尽：认账。同一 reason 只落一条日志（记「上次打印过的 reason」，不用一次性布尔开关）
        const reason = linuxReason ?? LINUX_NO_BACKEND_REASON
        if (lastLinuxReasonLogged !== reason) {
          lastLinuxReasonLogged = reason
          log(`[keepawake] Linux 拿不到防休眠通道：${reason}`)
        }
        return
      }
      try {
        const spawned = spawnCommand(linuxInhibitCommand(backend, ASSERTION_NAME, pid))
        child = spawned
        linuxBackend = backend
        log(`[keepawake] 持有断言（${ASSERTION_NAME}）：${backend} pid = ${String(spawned.pid)}`)
        // 秒退判定：只有「还是当前持有的那个子进程」才算意外退出——正常释放路径先置
        // child = null 再 kill，退出回调看到的 child 已经不是它。
        void spawned.exited?.then((code) => {
          if (child !== spawned) return
          child = null
          linuxBackend = null
          const index = linuxBackends.indexOf(backend)
          if (index >= 0) linuxBackends.splice(index, 1)
          linuxReason = `${backend} 启动后立即退出（exit=${String(code)}）`
          if (lastLinuxReasonLogged !== linuxReason) {
            lastLinuxReasonLogged = linuxReason
            log(`[keepawake] Linux 拿不到防休眠通道：${linuxReason}`)
          }
        })
      } catch (error) {
        // spawn 抛异常（二进制半路消失/权限）：转成认账，不许把 tick 循环炸掉
        const index = linuxBackends.indexOf(backend)
        if (index >= 0) linuxBackends.splice(index, 1)
        linuxBackend = null
        linuxReason = `${backend} 启动失败（${String(error)}）`
        if (lastLinuxReasonLogged !== linuxReason) {
          lastLinuxReasonLogged = linuxReason
          log(`[keepawake] Linux 拿不到防休眠通道：${linuxReason}`)
        }
      }
      return
    }
    if (!warnedPlatform) {
      warnedPlatform = true
      log(`[keepawake] 本平台（${platform}）暂无防休眠实现——旧壳同样只覆盖 macOS/Windows`)
    }
  }

  const release = (): void => {
    if (child !== null) {
      const dying = child
      child = null
      linuxBackend = null
      try {
        dying.kill()
      } catch {}
      log('[keepawake] 释放断言')
    }
    if (windowsHeld) {
      windowsHeld = false
      applyWindows(false)
    }
  }

  const tick = (): boolean => {
    const desired = arbiter.shouldHold()
    const holding = child !== null || windowsHeld
    if (desired !== holding) {
      if (desired) hold()
      else release()
    }
    const stale = arbiter.stale(now(), LEASE_STALE_MS)
    if (stale.join(',') !== lastStale.join(',')) {
      lastStale = stale
      if (stale.length > 0) {
        log(`[keepawake] 租约陈旧（心跳 ${String(LEASE_STALE_MS / 1000)}s 未到，仍按旧壳口径继续持有）：${stale.join('、')}`)
      }
    }
    return child !== null || windowsHeld
  }

  const capability = (): KeepAwakeCapability => {
    if (platform === 'darwin') {
      return { platform, backend: 'caffeinate', available: true, reason: null }
    }
    if (platform === 'win32') {
      return {
        platform,
        backend: 'execution-state',
        available: !windowsFailed,
        reason: windowsFailed ? WINDOWS_ASSERT_FAILED_REASON : null,
      }
    }
    if (platform === 'linux') {
      const available = linuxBackends.length > 0
      return {
        platform,
        backend: linuxBackend ?? linuxBackends[0] ?? null,
        available,
        reason: available ? null : (linuxReason ?? LINUX_NO_BACKEND_REASON),
      }
    }
    return { platform, backend: null, available: false, reason: `本平台（${platform}）没有防休眠实现` }
  }

  return {
    start: (): void => {
      if (timer !== null) return
      timer = setIntervalFn(() => {
        tick()
      }, tickMs)
      tick()
    },
    stop: (): void => {
      if (timer !== null) {
        clearIntervalFn(timer)
        timer = null
      }
      release()
    },
    tick,
    isHolding: (): boolean => child !== null || windowsHeld,
    capability,
    arbiter,
  }
}

/**
 * #186/#75：prevent_sleep 是运行期可改的开关（面板即时保存），裁决器与 tick 循环要跟着走；
 * 同值不动——saveSettings 是所有设置的唯一写路径，无关保存不该 churn。
 */
export function syncPreventSleep(enabled: boolean, deps: { arbiter: Arbiter; keepAwake: KeepAwake }): void {
  if (deps.arbiter.isEnabled() === enabled) return
  deps.arbiter.setEnabled(enabled)
  if (enabled) deps.keepAwake.start()
  else deps.keepAwake.stop()
}
