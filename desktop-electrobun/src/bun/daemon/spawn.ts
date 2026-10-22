// 壳进程 spawn / 杀壳 / 崩溃检测（map #240 / #242）。
//
// 守护是壳的父进程（终态模型：应用 = 守护拉壳，壳可完全重启）。这里只管进程机械：
// 拉起、按 pid 收割（TERM → 超时 KILL）、退出事件回调。业务语义（什么时候拉、
// 拉哪个 profile）归 run.ts 编排层。

import { defaultIsAlive } from '../platform/single-instance.ts'

/**
 * 拉壳注入给壳的守护上下文 env。#243 的壳按这些键认出「自己是被守护管的」：
 * - SUPERVISED_BY 复用 #237 既有键（接班等待/单实例 succeedsPid 已按它豁免）
 * - CONTROL_URL/TOKEN 是壳回连控制通道的凭据（token 准入口径与页面 token 一致）
 */
import { encodeRestoreProfiles, SHELL_RESTORE_PROFILES_ENV } from './control.ts'
export function shellDaemonEnv(input: {
  controlOrigin: string
  token: string
  daemonPid: number
  /** 壳角色标记（#243：入口路由靠它分流；固定 'shell'） */
  role?: 'shell'
  /** 重拉恢复的开窗清单（#243：壳启动读它恢复窗口；缺省不透传） */
  restoreProfiles?: readonly string[]
  /**
   * CEF 身份覆盖（#243 冒烟实抓：主进程与壳同 identifier ⇒ 同一 CEF 目录的
   * ProcessSingleton 互斥，后起的一方 abort 退出）。壳侧注入 DSH_SHELL_CEF_IDENTITY
   * （launcher main.js 的 #239 patch 杠杆）换一个 CEF 数据目录；主进程保留默认目录。
   */
  cefIdentity?: string
}): Record<string, string> {
  const env: Record<string, string> = {
    DSH_SHELL_SUPERVISED_BY: String(input.daemonPid),
    DSH_SHELL_CONTROL_URL: input.controlOrigin,
    DSH_SHELL_CONTROL_TOKEN: input.token,
  }
  if (input.role !== undefined) env.DSH_SHELL_ROLE = input.role
  if (input.cefIdentity !== undefined && input.cefIdentity !== '') env.DSH_SHELL_CEF_IDENTITY = input.cefIdentity
  if (input.restoreProfiles !== undefined && input.restoreProfiles.length > 0) {
    env[SHELL_RESTORE_PROFILES_ENV] = encodeRestoreProfiles(input.restoreProfiles)
  }
  return env
}

export interface SpawnShellOptions {
  /** launcher 可执行文件绝对路径（打包态）或 [exe, ...args]（dev 态自拼） */
  argv: string[]
  env?: Record<string, string>
  /** stdout/stderr 落点（守护侧为壳留的日志尾巴）；空串 = 丢弃 */
  logFile?: string
  spawn?: (argv: string[], env: Record<string, string>, logFile: string) => number
  onLog?: { info: (msg: string, ...rest: unknown[]) => void; warn: (msg: string, ...rest: unknown[]) => void }
}

export interface SpawnShellResult {
  ok: boolean
  pid: number | null
  error: string | null
}

export function defaultSpawnShell(argv: string[], env: Record<string, string>, logFile: string): number {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  // 日志尾巴可能连目录都还没有（全新安装首启 / 隔离环境）：openSync 'a' 只建文件不建目录，
  // 不先 mkdir 会让整个拉壳 ENOENT 失败（#243 冒烟实抓）。
  let logFd: number | null = null
  if (logFile !== '') {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    logFd = fs.openSync(logFile, 'a')
  }
  try {
    const envAll = { ...process.env, ...env }
    // stdio 的 [In, Out, Err] 泛型按分支独立推断：合成一个条件表达式会因元组联合推不出而报错。
    const child =
      logFd === null
        ? Bun.spawn(argv, { env: envAll, stdio: ['ignore', 'ignore', 'ignore'] })
        : Bun.spawn(argv, { env: envAll, stdio: ['ignore', logFd, logFd] })
    child.unref?.()
    return child.pid
  } finally {
    if (logFd !== null) fs.closeSync(logFd)
  }
}

export function spawnShell(options: SpawnShellOptions): SpawnShellResult {
  const spawn = options.spawn ?? defaultSpawnShell
  const logFile = options.logFile ?? ''
  try {
    const pid = spawn(options.argv, options.env ?? {}, logFile)
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false, pid: null, error: `spawn 返回异常 pid：${String(pid)}` }
    }
    options.onLog?.info(`已拉起壳进程 pid=${String(pid)}（argv[0]=${options.argv[0] ?? ''}）`)
    return { ok: true, pid, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.onLog?.warn(`拉壳失败：${message}`)
    return { ok: false, pid: null, error: message }
  }
}

export interface KillShellOptions {
  pid: number
  isAlive?: (pid: number) => boolean
  /** TERM 后等多久再 KILL（毫秒）；默认 3000 */
  graceMs?: number
  sleep?: (ms: number) => Promise<void>
  /** 信号投递（默认 process.kill）；测试注入记录 */
  signal?: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => void
}

export interface KillShellResult {
  /** true = 进程已死（或本来就不在）；false = KILL 后仍活着（权限等异常） */
  dead: boolean
  /** 实际走的信号路径：'none'（本来已死）/ 'SIGTERM' / 'SIGKILL' */
  via: 'none' | 'SIGTERM' | 'SIGKILL'
}

export async function killShell(options: KillShellOptions): Promise<KillShellResult> {
  const isAlive = options.isAlive ?? defaultIsAlive
  const signal = options.signal ?? ((pid, sig) => process.kill(pid, sig))
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const graceMs = options.graceMs ?? 3_000
  if (!isAlive(options.pid)) return { dead: true, via: 'none' }
  try {
    signal(options.pid, 'SIGTERM')
  } catch {
    // EPERM/ESRCH：交给 isAlive 复核——真死了照样算收干净。
  }
  for (let waited = 0; waited < graceMs; waited += 150) {
    if (!isAlive(options.pid)) return { dead: true, via: 'SIGTERM' }
    await sleep(150)
  }
  try {
    signal(options.pid, 'SIGKILL')
  } catch {
    // 同上：以 isAlive 为准。
  }
  return { dead: !isAlive(options.pid), via: 'SIGKILL' }
}

/**
 * 壳退出事件归类：守护据此决定「认领的壳没了」是正常退（用户让退）还是崩溃（watchdog 拉起）。
 * exitCode !== 0 或被信号带走 ⇒ crashed；否则 normal。
 */
export function classifyShellExit(input: { exitCode: number | null; signalCode: string | null }): 'normal' | 'crashed' {
  if (input.signalCode !== null) return 'crashed'
  return input.exitCode === 0 || input.exitCode === null ? 'normal' : 'crashed'
}
