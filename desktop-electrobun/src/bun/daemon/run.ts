// 守护装配层（map #240 / #242）：把角色锁、注册表、控制通道、spawn/杀壳拼成
// 一个可运行的守护。#248 的 prototype 验证了进程形态（零窗 CEF + 托盘），本层
// 只负责编排，不碰窗口。
//
// 壳的拉起默认关（spawnShellOnBoot）——「启动器拉守护、守护拉壳」的接线在 #243
// 壳改造落地时打开；本轮骨架先把守护侧的全部能力与契约立住。

import { defaultIsAlive } from '../platform/single-instance.ts'
import { startControlServer, type ControlChannel } from './control.ts'
import { ProfileRegistry, type RegistryIo } from './registry.ts'
import { acquireDaemonRole, daemonInstanceFile, readShellInstance, releaseDaemonRole } from './roles.ts'
import { killShell, spawnShell, shellDaemonEnv } from './spawn.ts'

import { updateInstance } from '../platform/single-instance.ts'
import { DAEMON_ROLE } from './roles.ts'
export interface DaemonLogger {
  info: (msg: string, ...rest: unknown[]) => void
  warn: (msg: string, ...rest: unknown[]) => void
  error: (msg: string, ...rest: unknown[]) => void
}

export interface RunDaemonOptions {
  appSupport: string
  /** 守护 token 缺省随机；测试注入固定值 */
  controlToken?: string
  /** 壳的 launcher 路径；null = dev/找不到（拉壳能力退化为不可用，守护其余照常） */
  launcherExe: string | null
  /** 拉壳落日志的文件（壳的 stdout/stderr 尾巴） */
  shellLogFile?: string
  /** 默认 false：#243 接线时打开 */
  spawnShellOnBoot?: boolean
  /** 默认 default profile 名（与壳现有 instanceProfile 同源） */
  defaultProfile?: string
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
  /** 优雅收尾：杀壳（可关）→ 停控制通道 → 释放守护锁 */
  stop: (options?: { killShell?: boolean }) => Promise<void>
}

export async function runDaemon(options: RunDaemonOptions): Promise<DaemonHandle> {
  const log = options.onLog
  const isAlive = options.isAlive ?? defaultIsAlive
  const lockFile = daemonInstanceFile(options.appSupport)

  const acquired = acquireDaemonRole(lockFile, { isAlive, isOurProcess: options.isOurProcess })
  if (!acquired.acquired) {
    // 已有守护：让位退出（exit 0，不是错误）。谁让位谁自己退——与壳的激活语义不同，
    // 守护没有窗口可激活，第二个守护唯一正确动作就是消失。
    log?.info(`守护已存在（pid=${String(acquired.previous?.pid ?? 0)}），本实例让位退出`)
    return { role: 'yielded', control: null, registry: null, shellPid: null, stop: async () => { } }
  }
  log?.info(`守护角色就位（pid=${String(process.pid)}，锁=${lockFile}）`)

  const registry = new ProfileRegistry(options.appSupport, options.registryIo)

  const control = startControlServer({
    registry,
    token: options.controlToken,
    onLog: log,
  })
  // origin 回填守护锁：壳/页面从锁里拿控制通道地址（与壳服务面回填 shell-instance.json 同招）。
  updateInstance(lockFile, process.pid, { origin: control.origin })

  // 认领旧壳：锁里活着 ⇒ 注册表标记 running（重启场景守护比壳晚起的自愈）。
  let shellPid: number | null = null
  const previousShell = readShellInstance(options.appSupport)
  if (previousShell !== null && isAlive(previousShell.pid)) {
    const profile = previousShell.profile === DAEMON_ROLE ? (options.defaultProfile ?? 'desktop') : previousShell.profile
    registry.upsertLocal(profile)
    registry.markStatus(profile, 'running', previousShell.pid)
    shellPid = previousShell.pid
    log?.info(`认领已有壳 pid=${String(previousShell.pid)}（profile=${profile}）`)
  }

  // 开机拉壳：launcher 探测得到 + 开关打开才拉；否则等 #243 接线。
  if (options.spawnShellOnBoot === true && shellPid === null && options.launcherExe !== null) {
    const profile = options.defaultProfile ?? 'desktop'
    const env = shellDaemonEnv({ controlOrigin: control.origin, token: control.token, daemonPid: process.pid })
    const result = spawnShell({
      argv: [options.launcherExe],
      env,
      logFile: options.shellLogFile ?? '',
      onLog: log,
    })
    if (result.ok && result.pid !== null) {
      shellPid = result.pid
      registry.upsertLocal(profile)
      registry.markStatus(profile, 'starting', result.pid)
    }
  }

  const stop = async (stopOptions?: { killShell?: boolean }): Promise<void> => {
    if (stopOptions?.killShell === true && shellPid !== null && shellPid !== process.pid) {
      await killShell({ pid: shellPid, isAlive })
    }
    control.stop()
    releaseDaemonRole(lockFile, process.pid)
  }

  return { role: 'acquired', control, registry, shellPid, stop }
}
