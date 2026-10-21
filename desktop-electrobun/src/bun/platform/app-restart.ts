// #119 整应用重启（B）：把自身可执行文件 detached 拉起一份新的，再优雅退掉自己。
//
// #211（2026-10-20 实测）：Windows 上中继会在旧壳退出时被一起收割（relay.log 只写一行就断），
// win32 回归「壳直接拉 launcher」的旧可靠路径，中继只留给 macOS；两路都写 relay 日志留痕。

import { appendFileSync } from 'node:fs'
import { loggingKernel } from '../logging/kernel.ts'
import { type Logger } from '../../shared/logging/levels.ts'
// 为什么不用框架 API：Electrobun 2.0.2 没有 relaunch/restart。
// 核符号表里只有 `quitGracefully` / `forceExit` / `stopEventLoop` / `waitForShutdownComplete`
// ——全是「怎么退」，没有「退之前把新实例拉起来」。`app` 面只有 `on` / `quit` / `isPackaged`
// / `isCarrotMode` / `manifest` / 路径与令牌那几个 getter。
// 所以走 fallback：**detached spawn 自身可执行文件**（这正是 #119 方案节预先批准的退化路径）。
//
// 为什么「先退再拉」不成立、也不能「先拉再退」：
//   · 先退再拉：退完进程就没了，没人再执行 spawn。
//   · 先拉再退：新实例起来时 `acquireInstance` 撞见旧 pid 还活着且仍是我们的壳进程
//     （single-instance.ts 的三条判据：pid 活着 + `ps -o comm=` 像壳 + 同一次开机）
//     ⇒ 判定「已有实例」⇒ 激活旧实例后自己退出；旧实例随即退掉 ⇒ **净结果什么都没起来**。
// 做法是让**新实例自己知道**它是接班人：父进程把旧 pid 经 `DSH_SHELL_RELAUNCH_PID` 传给
// launcher，新实例在抢锁前等那个 pid 真退干净，再照常抢锁。等待发生在新实例自己身上，
// 不靠两边的时间窗对齐，也就不存在竞态。
//
// 纯决策（planRelaunch / relaunchParentPid / awaitParentExit）与 IO（relaunchDesktopApp）分开，
// 与 devtools.ts 同一口径，便于单测。

/** 父进程把「要被接班的旧壳 pid」经 launcher env 传给新实例。 */
export const RELAUNCH_PID_ENV = 'DSH_SHELL_RELAUNCH_PID'

/** 接班方最多等旧壳这么久。超了就照常抢锁（acquireInstance 另有 succeedsPid 兜底），不把启动卡死。 */
export const RELAUNCH_WAIT_DEADLINE_MS = 15_000

const RELAUNCH_POLL_MS = 150

export type RelaunchFailure = 'dev-build' | 'launcher-unknown' | 'spawn-failed'

export type RelaunchPlan =
  | { ok: true; exe: string }
  | { ok: false; reason: RelaunchFailure; message: string }

/**
 * 能不能自拉起，以及拉哪个文件。
 *
 * `isPackaged` 先判：dev 态（`bun run dev`）的进程可执行文件是工具链 bun，不是壳，拉起来是错的
 * （#119 拍板时记为「已知并接受」的成本之一：dev 态必须**显式降级**，禁止静默失败、
 * 禁止假装重启成功）。
 */
export function planRelaunch(input: {
  isPackaged: boolean
  /** 打包态的可执行文件（launcher / launcher.exe）；null = 探测不到 */
  launcherExe: string | null
}): RelaunchPlan {
  if (!input.isPackaged) {
    return {
      ok: false,
      reason: 'dev-build',
      message: '开发构建不支持自动重启：dev 态的进程是工具链 bun，拉起来不是桌面壳。请手动重启（Ctrl-C 后重新 bun run dev）。',
    }
  }
  if (input.launcherExe === null || input.launcherExe.trim() === '') {
    return {
      ok: false,
      reason: 'launcher-unknown',
      message: '探测不到桌面壳可执行文件（ELECTROBUN_LAUNCHER_PID / ppid 都没解析出来），无法自动重启。请手动重启应用。',
    }
  }
  return { ok: true, exe: input.launcherExe }
}

/** 新实例从 env 里读出「我是谁的接班人」；不是接班人就 null（正常冷启动走老路）。 */
export function relaunchParentPid(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env[RELAUNCH_PID_ENV]
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const pid = Number(trimmed)
  return pid > 1 ? pid : null
}

/**
 * 接班方等旧壳真退干净。返回 true = 旧壳已退（或压根没这个 pid）。
 *
 * 不抛错：等不到也照常往下走（抢锁那边还有 succeedsPid 兜底）——接班等待不该把启动变成死等。
 */
export async function awaitParentExit(input: {
  pid: number
  isAlive: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  deadlineMs?: number
}): Promise<boolean> {
  if (!input.isAlive(input.pid)) return true
  const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms))
  const deadlineMs = input.deadlineMs ?? RELAUNCH_WAIT_DEADLINE_MS
  for (let waited = 0; waited < deadlineMs; waited += RELAUNCH_POLL_MS) {
    await sleep(RELAUNCH_POLL_MS)
    if (!input.isAlive(input.pid)) return true
  }
  return !input.isAlive(input.pid)
}

/**
 * 中继等待脚本：等旧壳进程退出、再等 CEF 单实例锁释放，然后才拉起真正的 launcher。
 *
 * 为什么需要中继（bug #204）：launcher 的启动顺序是「先起 CEF/UI 主线程，后加载壳 bundle」——
 * #119 原设计里「新实例在壳 bundle 顶层等旧 pid 退净」排在 CEF 之后，等不到：新实例的 CEF
 * 会在旧实例 CEF 还活着时就开始初始化，撞 Chromium 单实例锁后把启动参数（main.js 路径）
 * 当文件转发/交给系统打开（用户实测：点击瞬间弹浏览器显示 main.js 源码），且新 CEF 处于
 * singleton 转交后的残废状态，旧实例退完后新实例也无窗口。等待必须发生在 CEF 之前，
 * 而那一层不归壳代码管 —— 所以把等待外包给一个独立的中继进程。
 *
 * 锁判定：CEF 的 user-data-dir 下 mac/linux 是 SingletonLock（symlink 指向 hostname-pid），
 * Windows 是 lockfile。文件不存在 = 已释放；symlink 指向的 pid 已死 = stale 锁（CEF 会自行接管）。
 * 两个等待各有上限，超时照常拉起 —— 中继只把撞活锁的概率压到零，不把重启变成死等。
 *
 * 纯决策（buildRelaySource / cefLockState）与 IO（relaunchDesktopApp 的 spawn）分开，便于单测。
 */
export const RELAY_PID_WAIT_DEADLINE_MS = 15_000
export const RELAY_LOCK_WAIT_DEADLINE_MS = 10_000
export const RELAY_POLL_MS = 150

/** CEF 锁现状：released = 可以拉；held-alive = 锁指向的进程还活着；unknown = 读不出持有者（Windows lockfile 无 pid 信息）。 */
export type CefLockState = 'released' | 'held-alive' | 'unknown'
/**
 * CEF 锁目录（#209 口径修正）：只在 macOS（CEF 后端）且打包态下启用；目录取**实际安装根**下的
 * CEF/（从 process.execPath <安装根>/<App>.app/Contents/MacOS/<exe> 上溯四层），不再是废弃的
 * ~/Library/Application Support/<id>/<root> 默认路径。Windows 用 WebView2，无 CEF 锁，返回 null。
 */
export function cefDirFromExecPath(execPath: string, platform: string = process.platform): string | null {
  if (platform !== 'darwin') return null
  // 手写 dirname×4（本文件保持零导入的注入式风格）：<安装根>/<App>.app/Contents/MacOS/<exe> → 安装根
  let dir = execPath
  for (let i = 0; i < 4; i++) {
    const cut = dir.lastIndexOf('/')
    if (cut <= 0) return null
    dir = dir.slice(0, cut)
  }
  return `${dir}/CEF`
}

/**
 * 判定 CEF 单实例锁是否已释放。输入全部由调用方探测，这里只做纯判定：
 * `rawLockTarget` 是 symlink 的 readlink 结果（mac/linux）；Windows lockfile 读不出持有者，传 null。
 * `targetPidAlive` 收到 rawLockTarget 解析出的 pid（无则不调）。
 */
export function cefLockState(input: {
  lockExists: boolean
  rawLockTarget?: string | null
  targetPidAlive?: (pid: number) => boolean
}): CefLockState {
  if (!input.lockExists) return 'released'
  const raw = input.rawLockTarget ?? null
  if (raw === null || raw.trim() === '') return 'unknown'
  // SingletonLock 的目标是 "<hostname>-<pid>"；取尾段数字
  const match = /-(\d+)$/.exec(raw.trim())
  if (match === null) return 'unknown'
  const pid = Number(match[1])
  if (!Number.isInteger(pid) || pid <= 1) return 'unknown'
  const alive = input.targetPidAlive?.(pid) ?? true
  return alive ? 'held-alive' : 'released'
}

export function buildRelaySource(input: {
  pid: number
  launcherExe: string
  /** CEF user-data-dir；null/undefined = 不等锁（退化成纯 pid 等待） */
  cefDir?: string | null
  pidWaitMs?: number
  lockWaitMs?: number
  pollMs?: number
  /** 中继日志落盘路径（stdio 全 ignore，没有它中继侧死活不可观测） */
  logFile?: string
}): string {
  const pidWaitMs = input.pidWaitMs ?? RELAY_PID_WAIT_DEADLINE_MS
  const lockWaitMs = input.lockWaitMs ?? RELAY_LOCK_WAIT_DEADLINE_MS
  const pollMs = input.pollMs ?? RELAY_POLL_MS
  const cefDir = input.cefDir?.trim() ?? ''
  return [
    `const parentPid = ${String(input.pid)};`,
    `const launcherExe = ${JSON.stringify(input.launcherExe)};`,
    `const cefDir = ${JSON.stringify(cefDir)};`,
    `const pidWaitMs = ${String(pidWaitMs)};`,
    `const lockWaitMs = ${String(lockWaitMs)};`,
    `const pollMs = ${String(pollMs)};`,
    `const logFile = ${JSON.stringify(input.logFile ?? '')};`,
    `const { appendFileSync, mkdirSync } = await import('node:fs');`,
    `const { dirname } = await import('node:path');`,
    `const log = (message) => { try { if (logFile !== '') { mkdirSync(dirname(logFile), { recursive: true }); appendFileSync(logFile, new Date().toISOString() + ' [relay] [info] ' + message + '\\n') } } catch (error) { try { process.stderr.write('[relay] 中继日志写入失败：' + String(error) + '\\n') } catch {} } };`,
    `log('中继启动：等 pid=' + parentPid + ' 退净后拉 ' + launcherExe + '（cefDir=' + (cefDir === '' ? '无' : cefDir) + '）');`,
    `const parentAlive = () => { try { process.kill(parentPid, 0); return true } catch { return false } };`,
    // 等旧壳进程退出（上限 pidWaitMs；ESRCH 即已退，EPERM 视为仍在）`,
    `for (let waited = 0; waited < pidWaitMs && parentAlive(); waited += pollMs) {`,
    `  await Bun.sleep(pollMs);`,
    `}`,
    `log(parentAlive() ? '旧壳 pid 等待超时（仍活着），照常继续' : '旧壳已退净');`,
    // 等 CEF 锁释放（mac/linux SingletonLock symlink；Windows lockfile 只能等它消失）。`,
    `if (cefDir !== '') {`,
    `  const { existsSync, readlinkSync } = await import('node:fs');`,
    `  const lockNames = process.platform === 'win32' ? ['lockfile'] : ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];`,
    `  const lockState = () => {`,
    `    for (const name of lockNames) {`,
    `      const p = cefDir + '/' + name;`,
    `      if (!existsSync(p)) continue;`,
    `      let target = null;`,
    `      try { target = readlinkSync(p) } catch {}`,
    `      if (target === null) return false; // 存在但读不出指向（Windows lockfile）：只能按仍在持有处理`,
    `      const match = /-(\\d+)$/.exec(target.trim());`,
    `      if (match === null) return false;`,
    `      const holderPid = Number(match[1]);`,
    `      try { process.kill(holderPid, 0); return false } catch { continue } // 指向死 pid：stale，CEF 会自行接管`,
    `    }`,
    `    return true;`,
    `  };`,
    `  for (let waited = 0; waited < lockWaitMs; waited += pollMs) {`,
    `    if (lockState()) break;`,
    `    await Bun.sleep(pollMs);`,
    `  }`,
    `  log('CEF 锁等待结束');`,
    `}`,
    // Windows：WebView2（msedgewebview2）是独立进程树，宿主死后仍有尾巴；不等净就拉新实例会撞
    // WebView2 用户数据目录锁（#209 实测「拉起 launcher 后无下文」的主嫌疑）。上限 5s，超时照常拉。
    `if (process.platform === 'win32') {`,
    `  const { execSync } = await import('node:child_process');`,
    `  for (let waited = 0; waited < 5000; waited += 200) {`,
    `    let alive = false;`,
    `    try { alive = execSync('tasklist /FI "IMAGENAME eq msedgewebview2.exe" /NH', { stdio: ['ignore','pipe','ignore'] }).toString().toLowerCase().includes('msedgewebview2'); } catch {}`,
    `    if (!alive) break;`,
    `    await Bun.sleep(200);`,
    `  }`,
    `  log('WebView2 进程等待结束');`,
    `}`,
    `log('拉起 launcher');`,
    `try {`,
    `  const launcherLog = logFile === '' ? 'ignore' : await import('node:fs').then((fs) => fs.openSync(logFile + '.launcher', 'a'));`,
    `  const proc = Bun.spawn([launcherExe], { env: process.env, stdin: 'ignore', stdout: launcherLog, stderr: launcherLog });`,
    `  const pid = proc.pid;`,
    `  log('launcher 已 spawn（pid=' + pid + '），中继退出（launcher 孤儿化继续跑）');`,
    `} catch (error) {`,
    `  log('拉起失败：' + (error instanceof Error ? (error.stack ?? error.message) : String(error)));`,
    `  process.exit(1);`,
    `}`
  ].join('\n')
}

/**
 * 真正自拉起：spawn 一个 detached 的中继进程，由它等旧实例（含 CEF）退净后再拉 launcher。
 *
 * 中继本身是本壳同款 bun 跑一段内联脚本（不落盘）；env 原样透传（含 RELAUNCH_PID 兑底）。
 * **不做任何退出动作**：退出是调用方（index.ts）的事，
 * 顺序是「先拉起中继、后 shutdown」，否则没人执行 spawn。
 *
 * `spawn` 仅测试注入。
 */
export async function relaunchDesktopApp(input: {
  isPackaged: boolean
  launcherExe: string | null
  pid: number
  /** CEF user-data-dir；不传/空串 = 中继只等旧 pid，不等 CEF 锁 */
  cefDir?: string | null
  /** 中继日志落盘路径（透传 buildRelaySource） */
  logFile?: string
  env?: Record<string, string | undefined>
  /** 平台分支（测试注入）；缺省取 process.platform */
  platform?: string
  spawn?: (argv: string[], env: Record<string, string>) => void
  onLog?: Logger
}): Promise<RelaunchPlan> {
  const plan = planRelaunch({ isPackaged: input.isPackaged, launcherExe: input.launcherExe })
  if (!plan.ok) {
    input.onLog?.warn(`重启桌面应用：${plan.reason} —— ${plan.message}`)
    return plan
  }
  const env = { ...(input.env ?? process.env), [RELAUNCH_PID_ENV]: String(input.pid) }
  const launch = input.spawn ?? ((argv, env) => defaultSpawn(argv, env, input.onLog))

  // #211 实测口径：Windows 上中继会在旧壳退出时被一起收割（relay.log 只写一行就断），
  // 回归旧可靠路径——壳直接 spawn launcher（接班逻辑 DSH_SHELL_RELAUNCH_PID 不变，用户实测可用）；
  // 中继（等 pid/CEF 锁/WebView2 尾巴）只留给 macOS。两路都写 relay 日志留痕。
  if ((input.platform ?? process.platform) === 'win32') {
    try {
      launch([plan.exe], env)
    } catch (error) {
      const message = `拉起 launcher 失败：${error instanceof Error ? error.message : String(error)}`
      writeRelayLog(input.logFile, `直拉失败：${message}`)
      input.onLog?.error(`重启桌面应用：spawn-failed —— ${message}`)
      return { ok: false, reason: 'spawn-failed', message }
    }
    writeRelayLog(input.logFile, `Windows 直拉 launcher：${plan.exe}（旧壳 pid=${String(input.pid)} 由接班逻辑等待退净）`)
    input.onLog?.info('重启桌面应用：已直接拉起 launcher（Windows 直拉路径），本进程即将退出')
    return plan
  }

  const relay = buildRelaySource({ pid: input.pid, launcherExe: plan.exe, cefDir: input.cefDir, logFile: input.logFile })
  const argv = [process.execPath, '-e', relay]
  try {
    launch(argv, env)
  } catch (error) {
    const message = `拉起中继进程失败：${error instanceof Error ? error.message : String(error)}`
    input.onLog?.error(`重启桌面应用：spawn-failed —— ${message}`)
    return { ok: false, reason: 'spawn-failed', message }
  }
  input.onLog?.info(`重启桌面应用：已拉起中继（等 ${String(input.pid)} 退净后拉 ${plan.exe}），本进程即将退出`)
  return plan
}

/** 壳侧 relay 日志（Windows 直拉路径；中继路径的日志由中继自己写）。写失败不影响重启。 */
function writeRelayLog(logFile: string | undefined, message: string): void {
  if (logFile === undefined || logFile === '') return
  const line = `${new Date().toISOString()} [relay] [info] ${message}\n`
  // 壳侧写入口走统一内核（级别过滤不作用、写前巡检轮转、IO 失败进 health）；
  // 中继子进程是独立生成脚本，不引内核，仍自写（Decision 10 边界）。
  try {
    if (loggingKernel().files().relay === logFile) {
      loggingKernel().writeRelayLine(line)
      return
    }
  } catch { }
  try {
    appendFileSync(logFile, line)
  } catch (error) {
    console.error(`[shell] 中继日志写入失败：${String(error)}`)
  }
}

function defaultSpawn(argv: string[], env: Record<string, string>, onLog?: Logger): void {
  const proc = Bun.spawn(argv, {
    env,
    stdin: 'ignore',
    stdout: 'ignore',
    // 中继是短命进程（等完就退），stderr 没什么可看的；一并丢弃，不占 pipe。
    stderr: 'ignore',
  })
  // 中继不挂在旧壳的进程组上；旧壳退出时不要把它一起带走。
  proc.unref()
  void onLog
}
