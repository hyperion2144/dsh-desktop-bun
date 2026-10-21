// #237 统一后台运行模型（桌面侧入口）：托盘重启 + 冷启动自举监督进程。
//
// 语义（三平台统一）：
//   · 有活着的监督进程（本桌面是被它拉起来的接班人，或租约仍有效）⇒ 重启 = 写意图文件 +
//     shutdown，spawn 的事监督进程干——本进程退出时什么都不用拉，#211「垂死的壳 spawn 的
//     子进程会被一起收割」从根上不复存在；
//   · 没有监督进程 ⇒ 自举一个（本壳同款 bun 跑 runtime/shell-supervisor.mjs，detached、
//     headless 不露 Dock/任务栏）再写意图；自举失败（spawn 抛错 / 包里没有监督脚本）⇒
//     回退 #119/#211 的直拉 launcher 老路——重启永远不能因为新机制翻车而失效；
//   · dev 态照旧显式降级（#119 红线：不静默失败、不假报成功）。
//
// 纯决策（planRestartPath）与 IO（requestDesktopRestart / ensureSupervisorAtBoot）分开，
// 与 app-restart.ts 同一口径，便于单测。

import { appendFileSync, closeSync, existsSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RELAUNCH_PID_ENV, planRelaunch, type RelaunchFailure, type RelaunchPlan } from '../app-restart.ts'
import type { Logger } from '../../../shared/logging/levels.ts'
import {
  intentFilePath,
  readSupervisorLease,
  supervisorLeasePath,
  writeRestartIntent,
  type RestartFileIo,
} from './intent.ts'

/** 监督进程拿配置的 env 键（JSON blob，与 runtime/shell-supervisor.mjs 的解析一一对应）。 */
export const SUPERVISOR_CONFIG_ENV = 'DSH_SHELL_SUPERVISOR_CONFIG'

/** 监督进程传给接班桌面的 env 键：值 = 监督进程 pid（桌面冷启动凭它跳过自举）。 */
export const SUPERVISED_BY_ENV = 'DSH_SHELL_SUPERVISED_BY'

/** 重启路径：intent = 只写意图交监督进程；bootstrap = 自举监督进程再写意图；legacy = 直拉 launcher（#119/#211）。 */
export type RestartPathPlan =
  | { ok: true; kind: 'intent' | 'bootstrap' | 'legacy'; exe: string }
  | { ok: false; reason: RelaunchFailure; message: string }

/**
 * 包内监督脚本路径：<bundleDir>/../runtime/shell-supervisor.mjs；不存在（旧包结构 / dev 源态
 * 没物化过）返回 null，调用方据此走 legacy 回退。
 */
export function supervisorScriptFromBundle(
  bundleDir: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const path = join(bundleDir, '..', 'runtime', 'shell-supervisor.mjs')
  return exists(path) ? path : null
}

/** pid 活性缺省探测（监督进程 / 桌面都可能是任意 bun 进程，杀 0 信号足够）。 */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** env 里的「我是被谁监督的」；不是接班人 / pid 非法返回 null。 */
export function supervisedByPid(env: Record<string, string | undefined>): number | null {
  const raw = env[SUPERVISED_BY_ENV]?.trim() ?? ''
  if (!/^\d+$/.test(raw)) return null
  const pid = Number(raw)
  return pid > 1 ? pid : null
}

/** 本桌面是否有一个活着的监督进程罩着（env 指认的监督者活着，或租约的双方都活着）。 */
export function isSupervised(
  input: {
    env?: Record<string, string | undefined>
    appSupport?: string
    isAlive?: (pid: number) => boolean
    io?: RestartFileIo
  } = {},
): boolean {
  const isAlive = input.isAlive ?? defaultIsAlive
  const watched = supervisedByPid(input.env ?? process.env)
  if (watched !== null && isAlive(watched)) return true
  if (input.appSupport === undefined) return false
  const lease = readSupervisorLease(supervisorLeasePath(input.appSupport), input.io)
  return lease !== null && isAlive(lease.supervisorPid) && isAlive(lease.desktopPid)
}

/**
 * spawn 后轮询监督进程租约做「自证」（#237 Windows 实测补课）：spawn 返回成功 ≠ 进程真跑起来了
 * （实机出现过自举成功却零输出秒死的情形）。监督进程 main() 落了租约且 pid 活着，自举才算有效。
 */
export async function waitForSupervisorLease(input: {
  appSupport: string
  isAlive?: (pid: number) => boolean
  io?: RestartFileIo
  /** 自证等待上限；缺省 2s——真跑起来的监督进程毫秒级就落租约 */
  deadlineMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<boolean> {
  const isAlive = input.isAlive ?? defaultIsAlive
  const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms))
  const deadline = Date.now() + (input.deadlineMs ?? 2_000)
  const pollMs = input.pollMs ?? 50
  for (;;) {
    const lease = readSupervisorLease(supervisorLeasePath(input.appSupport), input.io)
    if (lease !== null && isAlive(lease.supervisorPid)) return true
    if (Date.now() >= deadline) return false
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}
/** 重启走哪条路。失败（dev / 探测不到 launcher）直接复用 #119 的降级口径。 */
export function planRestartPath(input: {
  isPackaged: boolean
  launcherExe: string | null
  supervised: boolean
  supervisorScript: string | null
}): RestartPathPlan {
  const base = planRelaunch({ isPackaged: input.isPackaged, launcherExe: input.launcherExe })
  if (!base.ok) return base
  if (input.supervised) return { ok: true, kind: 'intent', exe: base.exe }
  if (input.supervisorScript !== null) return { ok: true, kind: 'bootstrap', exe: base.exe }
  return { ok: true, kind: 'legacy', exe: base.exe }
}

export type SupervisorBootConfig = {
  launcherExe: string
  desktopPid: number
  appSupport: string
  logFile: string
  /** 等旧壳退净的上限；缺省用监督进程内建值 */
  pidWaitMs?: number
  /** 等 CEF 锁释放的上限（只 darwin 生效） */
  lockWaitMs?: number
  /** 收割渲染进程尾巴的等待上限 */
  tailWaitMs?: number
  /** 等下一个桌面接位的上限（冷启动要起宿主，给足） */
  nextWaitMs?: number
  pollMs?: number
}

/** 组监督进程的 spawn：argv = [bun, runtime/shell-supervisor.mjs]，配置走 env JSON。 */
export function buildSupervisorSpawn(input: {
  bunExe: string
  scriptPath: string
  config: SupervisorBootConfig
  env?: Record<string, string | undefined>
}): { argv: string[]; env: Record<string, string> } {
  const config: SupervisorBootConfig = {
    launcherExe: input.config.launcherExe,
    desktopPid: input.config.desktopPid,
    appSupport: input.config.appSupport,
    logFile: input.config.logFile,
    ...(input.config.pidWaitMs !== undefined ? { pidWaitMs: input.config.pidWaitMs } : {}),
    ...(input.config.lockWaitMs !== undefined ? { lockWaitMs: input.config.lockWaitMs } : {}),
    ...(input.config.tailWaitMs !== undefined ? { tailWaitMs: input.config.tailWaitMs } : {}),
    ...(input.config.nextWaitMs !== undefined ? { nextWaitMs: input.config.nextWaitMs } : {}),
    ...(input.config.pollMs !== undefined ? { pollMs: input.config.pollMs } : {}),
  }
  return {
    argv: [input.bunExe, input.scriptPath],
    env: {
      ...(input.env ?? process.env),
      [SUPERVISOR_CONFIG_ENV]: JSON.stringify(config),
    },
  }
}

/** 托盘「重启应用」：按 planRestartPath 落到某条路上，成功 = 本进程可以放心 shutdown。 */
export async function requestDesktopRestart(input: {
  isPackaged: boolean
  launcherExe: string | null
  pid: number
  appSupport: string
  logFile: string
  bundleDir: string
  env?: Record<string, string | undefined>
  supervised?: boolean
  supervisorAlive?: boolean
  /** 显式覆盖包内脚本探测（测试注入）；undefined = 按 bundleDir 探测 */
  supervisorScript?: string | null
  isAlive?: (pid: number) => boolean
  io?: RestartFileIo
  spawn?: (plan: { argv: string[]; env: Record<string, string> }) => void
  onLog?: Logger
  /** 自证「监督进程真的跑起来了」（缺省 waitForSupervisorLease；测试注入） */
  leaseWait?: (input: { appSupport: string }) => Promise<boolean>
}): Promise<RelaunchPlan> {
  const env = input.env ?? process.env
  const isAlive = input.isAlive ?? defaultIsAlive
  const launch =
    input.spawn ?? ((plan: { argv: string[]; env: Record<string, string> }) => defaultSpawn(plan.argv, plan.env, input.logFile))
  const script =
    input.supervisorScript !== undefined ? input.supervisorScript : supervisorScriptFromBundle(input.bundleDir)
  const supervised =
    input.supervised ?? isSupervised({ env, appSupport: input.appSupport, isAlive, io: input.io })
  const plan = planRestartPath({
    isPackaged: input.isPackaged,
    launcherExe: input.launcherExe,
    supervised,
    supervisorScript: script,
  })
  if (!plan.ok) {
    input.onLog?.warn(`重启桌面应用：${plan.reason} —— ${plan.message}`)
    return plan
  }

  if (plan.kind === 'intent') {
    try {
      writeRestartIntent(intentFilePath(input.appSupport), { pid: input.pid, at: new Date().toISOString() }, input.io)
    } catch (error) {
      const message = `写重启意图失败：${error instanceof Error ? error.message : String(error)}`
      input.onLog?.error(`重启桌面应用：spawn-failed —— ${message}`)
      return { ok: false, reason: 'spawn-failed', message }
    }
    writeRelayLog(
      input.logFile,
      `托盘重启：意图已写（pid=${String(input.pid)}），交监督进程等退净后拉 ${plan.exe}`,
    )
    input.onLog?.info('重启桌面应用：重启意图已交监督进程，本进程即将退出')
    return { ok: true, exe: plan.exe }
  }

  if (plan.kind === 'bootstrap') {
    const supervisorPlan = buildSupervisorSpawn({
      bunExe: process.execPath,
      scriptPath: script ?? '',
      config: {
        launcherExe: plan.exe,
        desktopPid: input.pid,
        appSupport: input.appSupport,
        logFile: input.logFile,
      },
      env,
    })
    let spawned = false
    try {
      launch(supervisorPlan)
      spawned = true
    } catch (error) {
      input.onLog?.warn(
        `重启桌面应用：自举监督进程失败（${error instanceof Error ? error.message : String(error)}），回退直拉 launcher`,
      )
    }
    if (spawned) {
      // 自证（#237 Windows 实测补课）：spawn 成功 ≠ 监督进程真跑起来。租约没在时限内落地
      // 就不写意图——绝不能把重启押在「以为有人在守」上，直接落 legacy 保底。
      const verified = await (input.leaseWait ?? waitForSupervisorLease)({ appSupport: input.appSupport })
      if (verified) {
        try {
          writeRestartIntent(intentFilePath(input.appSupport), { pid: input.pid, at: new Date().toISOString() }, input.io)
        } catch (error) {
          const message = `写重启意图失败：${error instanceof Error ? error.message : String(error)}`
          input.onLog?.error(`重启桌面应用：spawn-failed —— ${message}`)
          return { ok: false, reason: 'spawn-failed', message }
        }
        writeRelayLog(input.logFile, `托盘重启：已自举监督进程并写意图（pid=${String(input.pid)} → ${plan.exe}）`)
        input.onLog?.info('重启桌面应用：监督进程已自举，本进程即将退出')
        return { ok: true, exe: plan.exe }
      }
      input.onLog?.warn('重启桌面应用：监督进程自举后未落租约（启动即退？），回退直拉 launcher')
      writeRelayLog(input.logFile, `托盘重启：监督进程自举未过自证，回退直拉 launcher`)
    }
    // 自举失败/自证不过：带着 RELAUNCH_PID 落到下面的 legacy 保底，重启不能断。
  }

  // legacy（#119/#211 直拉）：监督进程不在且自举不了时的保底，env 接班口径与监督路径一致。
  const env2 = { ...env, [RELAUNCH_PID_ENV]: String(input.pid) }
  try {
    launch({ argv: [plan.exe], env: env2 })
  } catch (error) {
    const message = `拉起 launcher 失败：${error instanceof Error ? error.message : String(error)}`
    writeRelayLog(input.logFile, `直拉失败：${message}`)
    input.onLog?.error(`重启桌面应用：spawn-failed —— ${message}`)
    return { ok: false, reason: 'spawn-failed', message }
  }
  writeRelayLog(
    input.logFile,
    `直拉 launcher（无监督进程保底路径）：${plan.exe}（旧壳 pid=${String(input.pid)} 由接班逻辑等待退净）`,
  )
  input.onLog?.info('重启桌面应用：已直接拉起 launcher（保底路径），本进程即将退出')
  return { ok: true, exe: plan.exe }
}

/**
 * 冷启动自举（#237）：抢到实例位后调用。已有活着的监督进程（接班桌面 / 上一份还在）就不再拉；
 * dev 态、探测不到 launcher、包里没有监督脚本都安静跳过——自举失败不挡启动，重启时还有
 * requestDesktopRestart 里的保底路径兜着。
 */
export async function ensureSupervisorAtBoot(input: {
  isPackaged: boolean
  launcherExe: string | null
  pid: number
  appSupport: string
  logFile: string
  bundleDir: string
  env?: Record<string, string | undefined>
  isAlive?: (pid: number) => boolean
  io?: RestartFileIo
  spawn?: (plan: { argv: string[]; env: Record<string, string> }) => void
  onLog?: Logger
  /** 自证「监督进程真的跑起来了」（缺省 waitForSupervisorLease；测试注入） */
  leaseWait?: (input: { appSupport: string }) => Promise<boolean>
}): Promise<boolean> {
  const env = input.env ?? process.env
  const isAlive = input.isAlive ?? defaultIsAlive
  if (!input.isPackaged) return false
  if (input.launcherExe === null) {
    input.onLog?.debug('监督进程自举：探测不到 launcher，跳过（重启时走保底路径）')
    return false
  }
  if (isSupervised({ env, appSupport: input.appSupport, isAlive, io: input.io })) {
    input.onLog?.debug('监督进程自举：已有监督进程在位，跳过')
    return false
  }
  const script = supervisorScriptFromBundle(input.bundleDir)
  if (script === null) {
    input.onLog?.debug('监督进程自举：包里没有 runtime/shell-supervisor.mjs，跳过（旧包结构）')
    return false
  }
  const plan = buildSupervisorSpawn({
    bunExe: process.execPath,
    scriptPath: script,
    config: {
      launcherExe: input.launcherExe,
      desktopPid: input.pid,
      appSupport: input.appSupport,
      logFile: input.logFile,
    },
    env,
  })
  try {
    const spawnFn =
      input.spawn ?? ((p: { argv: string[]; env: Record<string, string> }) => defaultSpawn(p.argv, p.env, input.logFile))
    spawnFn(plan)
  } catch (error) {
    input.onLog?.warn(`监督进程自举失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  // 自证：租约没落地 = 监督进程没真跑起来（#237 Windows 实机案例）。自举失败不挡启动，
  // 重启时 requestDesktopRestart 的自证 + legacy 保底兜着。
  const verified = await (input.leaseWait ?? waitForSupervisorLease)({ appSupport: input.appSupport })
  if (!verified) {
    input.onLog?.warn('监督进程自举后未落租约（启动即退？），本代不认它——重启时走保底路径')
    return false
  }
  input.onLog?.info(`监督进程已自举（守 pid=${String(input.pid)}）：${script}`)
  writeRelayLog(input.logFile, `监督进程自举：守 pid=${String(input.pid)}，launcher=${input.launcherExe}`)
  return true
}

function defaultSpawn(argv: string[], env: Record<string, string>, logFile: string): void {
  // 子进程 stdout/stderr 落 <relay>.child：监督进程若在 main() 之前就崩（import 解析失败等），
  // 它自己的 relay 留痕机制完全够不着——Bun 的模块错误只走 stderr。#237 实证：Windows 安装包
  // copy 清单漏 entry.ts 时，正是这份 .child 文件给出了唯一死因（Cannot find module）。
  // 早期「stdio 指到文件 fd 会秒死」的怀疑被同一份证据推翻：错误能写进 .child，说明子进程
  // 活到了写 stderr。追加模式多次 spawn 不互踩；父进程 spawn 后即关自己的 fd 副本。
  let childFd: number | null = null
  try {
    childFd = logFile === '' ? null : openSync(`${logFile}.child`, 'a')
    const proc = Bun.spawn(argv, {
      env,
      stdin: 'ignore',
      stdout: childFd ?? 'ignore',
      stderr: childFd ?? 'ignore',
      // 显式 cwd 到可执行文件目录：不继承桌面进程的工作目录（它可能已被用户删除/移动）。
      cwd: dirname(argv[0] ?? '.'),
    })
    // 后台进程不挂在本进程组上：桌面退出时不要把它一起带走（监督进程 / launcher 都一样）。
    proc.unref()
  } finally {
    if (childFd !== null) closeSync(childFd)
  }
}

/** 壳侧 relay 日志（后台链路的留痕）。写失败不影响重启。 */
function writeRelayLog(logFile: string, message: string): void {
  if (logFile === '') return
  const line = `${new Date().toISOString()} [relay] [info] ${message}\n`
  try {
    appendFileSync(logFile, line)
  } catch {
    console.error(`[shell] relay 日志写入失败：${message}`)
  }
}
