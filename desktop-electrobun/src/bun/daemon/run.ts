// 守护装配层（map #240 / #242 / #243）：把角色锁、注册表、控制通道、spawn/杀壳拼成
// 主进程的可运行编排。主进程＝原「临时监督守护」常驻化后提到启动链最前面：
// 零窗、无托盘，只管壳进程（拉起/杀掉/重启/watchdog）；窗口控制全在壳自己。
//
// 拉壳是主进程对壳唯一的控制面：壳的窗口/托盘/DSH 全在壳进程内自洽（#243 拍板）。

import { defaultIsAlive } from '../platform/single-instance.ts'
import { startControlServer, type ControlChannel } from './control.ts'
import { ProfileRegistry, type RegistryIo } from './registry.ts'
import { acquireDaemonRole, DAEMON_ROLE, daemonInstanceFile, readShellInstance, releaseDaemonRole } from './roles.ts'
import { killShell, spawnShell, shellDaemonEnv } from './spawn.ts'

import { updateInstance } from '../platform/single-instance.ts'
export interface DaemonLogger {
  info: (msg: string, ...rest: unknown[]) => void
  warn: (msg: string, ...rest: unknown[]) => void
  error: (msg: string, ...rest: unknown[]) => void
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RunDaemonOptions {
  appSupport: string
  /** 主进程 token 缺省随机；测试注入固定值 */
  controlToken?: string
  /** 壳的 launcher 路径；null = dev/找不到（拉壳能力退化为不可用，其余照常） */
  launcherExe: string | null
  /** 拉壳落日志的文件（壳的 stdout/stderr 尾巴） */
  shellLogFile?: string
  /** 缺省 true：主进程开机即拉壳；测试关掉 */
  spawnShellOnBoot?: boolean
  /** 壳的主 profile 名（与壳现有 instanceProfile 同源） */
  defaultProfile?: string
  /** watchdog 轮询间隔毫秒（缺省 2s；测试调小） */
  watchdogIntervalMs?: number
  /** 注入睡眠（watchdog 循环测试用） */
  sleepImpl?: (ms: number) => Promise<void>
  /** 注入拉壳（watchdog/重拉测试用）；缺省真 spawn */
  spawnShellImpl?: typeof spawnShell
  /** 注入杀壳（重拉收割/stop 测试用）；缺省真 TERM→KILL 梯次 */
  killShellImpl?: typeof killShell
  /** 注入进程退出（quit 意图测试用）；缺省真 process.exit */
  processExitImpl?: (code: number) => void
  /**
   * 壳侧 CEF 身份覆盖（#243 冒烟实抓：同 identifier ⇒ CEF ProcessSingleton 互斥）。
   * 空缺省不透传（行为同旧版：与主进程共用目录——升级包 patch 未就位时的降级面）。
   */
  shellCefIdentity?: string
  registryIo?: RegistryIo
  isAlive?: (pid: number) => boolean
  isOurProcess?: (pid: number, expectedExe?: string) => boolean
  onLog?: DaemonLogger
}

export interface DaemonHandle {
  role: 'acquired' | 'yielded'
  control: ControlChannel | null
  registry: ProfileRegistry | null
  /** 已拉起/认领的本地壳 pid（null = 没拉壳） */
  shellPid: number | null
  /** 让位时已有主进程的控制通道 origin（null = 非让位或锁里没记） */
  previousOrigin: string | null
  /** 优雅收尾：杀壳（可关）→ 停控制通道 → 释放主锁 */
  stop: (options?: { killShell?: boolean }) => Promise<void>
}

export async function runDaemon(options: RunDaemonOptions): Promise<DaemonHandle> {
  const log = options.onLog
  const isAlive = options.isAlive ?? defaultIsAlive
  const sleep = options.sleepImpl ?? defaultSleep
  const watchdogIntervalMs = options.watchdogIntervalMs ?? 2_000
  const doSpawn = options.spawnShellImpl ?? spawnShell
  const doKill = options.killShellImpl ?? killShell
  const processExit = options.processExitImpl ?? ((code: number) => process.exit(code))
  const lockFile = daemonInstanceFile(options.appSupport)
  const profile = options.defaultProfile ?? 'desktop'
  let shellPid: number | null = null
  let stopped = false

  const acquired = acquireDaemonRole(lockFile, { isAlive, isOurProcess: options.isOurProcess })
  if (!acquired.acquired) {
    // 已有主进程：让位退出（exit 0，不是错误）。把它的控制通道 origin 带出去，
    // 调用方发激活——本次启动（用户又点了一次图标）的意图就是「给我开桌面」。
    const previousOrigin = acquired.previous?.origin ?? null
    log?.info(`主进程已存在（pid=${String(acquired.previous?.pid ?? 0)}），本实例让位退出`)
    return { role: 'yielded', control: null, registry: null, shellPid: null, previousOrigin, stop: async () => { } }
  }
  log?.info(`主进程角色就位（pid=${String(process.pid)}，锁=${lockFile}）`)

  const registry = new ProfileRegistry(options.appSupport, options.registryIo)

  // 拉壳（开机/重拉/激活共用）；restoreProfiles = 要恢复的开窗清单（来自注册表记账）。
  async function spawnShellNow(restoreProfiles?: readonly string[]): Promise<number | null> {
    // 重拉前先收割旧壳：活壳持有壳锁，新壳会抢锁失败自杀 → watchdog 重拉死循环（#243 冒烟实抓：
    // 伪造乱序 restart 事件连拉 64 次）。正常重启流程壳已自杀，这里只是乱序兜底。
    if (shellPid !== null && shellPid !== process.pid && isAlive(shellPid)) {
      const reaped = await doKill({ pid: shellPid })
      shellPid = null
      log?.info(`重拉前收割旧壳 pid（${reaped.via}）`)
    }
    if (options.launcherExe === null) {
      log?.warn('launcher 不可用（dev 态未打包），拉壳退化为不可用')
      return null
    }
    const env = shellDaemonEnv({
      controlOrigin: control.origin,
      token: control.token,
      daemonPid: process.pid,
      role: 'shell',
      restoreProfiles,
      cefIdentity: options.shellCefIdentity,
    })
    const result = doSpawn({ argv: [options.launcherExe], env, logFile: options.shellLogFile ?? '', onLog: log })
    if (!result.ok || result.pid === null) {
      log?.error(`拉壳失败：${result.error ?? 'unknown'}`)
      return null
    }
    shellPid = result.pid
    registry.upsertLocal(profile)
    registry.markStatus(profile, 'starting', result.pid)
    log?.info(`已拉起壳 pid=${String(result.pid)}${restoreProfiles?.length ? `（恢复窗口：${restoreProfiles.join(', ')}）` : ''}`)
    return result.pid
  }

  const control = startControlServer({
    registry,
    token: options.controlToken,
    onLog: log,
    onEvent: async (event) => {

      if (event.type !== 'exit') return
      if (event.exitIntent === 'restart') {
        // 壳请求重启：它已自行退出（reportExit('restart') 后自杀），主进程立即重拉。
        const entry = registry.get(event.profile)
        log?.info(`壳请求重启（pid=${String(event.pid)}）→ 重拉`)
        await spawnShellNow(entry?.openProfiles ?? undefined)
        return
      }
      if (event.exitIntent === 'quit') {
        // #247 退出矩阵：win/linux 的「退出应用」连主进程一起退（macOS 不发 quit，留守值守
        // 等下一次激活）。壳已自行退出，这里补一次收割兑底再收摊。
        log?.info(`壳请求退出（pid=${String(event.pid)}）→ 主进程跟随退出`)
        await stop({ killShell: true })
        processExit(0)
      }
    },
    onActivate: async () => {
      // 再点图标的激活意图：壳没跑才拉；壳活着幂等不动（窗口聚焦归壳自己，#243 拍板）。
      if (shellPid !== null && isAlive(shellPid)) {
        log?.info('激活请求：壳活着，保持不动')
        return
      }
      log?.info('激活请求：拉起壳')
      await spawnShellNow(registry.get(profile)?.openProfiles ?? undefined)
    },
  })
  // origin 回填主锁：第二实例从锁里拿到控制通道地址（与壳服务面回填同招）。
  updateInstance(lockFile, process.pid, { origin: control.origin })

  // 认领旧壳：锁里活着 ⇒ 注册表标记 running（主进程比壳晚起的自愈——升级重装场景）。
  const previousShell = readShellInstance(options.appSupport)
  if (previousShell !== null && isAlive(previousShell.pid)) {
    const claimedProfile = previousShell.profile === DAEMON_ROLE ? profile : previousShell.profile
    registry.upsertLocal(claimedProfile)
    registry.markStatus(claimedProfile, 'running', previousShell.pid)
    shellPid = previousShell.pid
    log?.info(`认领已有壳 pid=${String(previousShell.pid)}（profile=${claimedProfile}）`)
  } else if (options.spawnShellOnBoot !== false) {
    await spawnShellNow()
  }

  // watchdog：壳死了且不是「正常退（exit 事件已落 stopped）」⇒ 崩溃/被杀 → 重拉。
  // 正常退不重拉——macOS 后台语义：留主进程值守，等下一次激活（再点图标）。
  void (async () => {
    while (!stopped) {
      await sleep(watchdogIntervalMs)
      if (stopped || shellPid === null) continue
      if (isAlive(shellPid)) continue
      const entry = registry.get(profile)
      shellPid = null
      if (entry?.status === 'stopped') {
        log?.info('壳已正常退出，主进程继续值守（等待下一次激活）')
        continue
      }
      log?.warn(`壳意外消失（status=${entry?.status ?? 'unknown'}）→ watchdog 重拉`)
      await spawnShellNow(entry?.openProfiles ?? undefined)
    }
  })()

  const stop = async (stopOptions?: { killShell?: boolean }): Promise<void> => {
    stopped = true
    if (stopOptions?.killShell === true && shellPid !== null && shellPid !== process.pid) {
      await doKill({ pid: shellPid, isAlive })
    }
    control.stop()
    releaseDaemonRole(lockFile, process.pid)
  }

  // shellPid 用 getter：重拉/activate 换壳后外部读到的是当前值（对象字面量属性会快照）。
  return { role: 'acquired', control, registry, get shellPid() { return shellPid }, previousOrigin: null, stop }
}
