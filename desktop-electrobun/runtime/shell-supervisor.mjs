#!/usr/bin/env bun
// #237 统一后台运行模型：常驻监督进程（headless，本壳同款 bun 直跑本脚本，不露 Dock/任务栏
// ——后台归应用本体，而不是第二个应用图标）。
//
// 生命周期（三平台统一）：
//   · 冷启动由壳自举（platform/restart/entry.ts 的 ensureSupervisorAtBoot，抢到实例位后）；
//     被监督的接班桌面凭 env DSH_SHELL_SUPERVISED_BY 跳过自举，永远只有一份监督进程。
//   · 长驻循环：等守着的桌面退出 → 读重启意图（shell-restart.request）→ 清意图 →
//     等 CEF 锁释放（只 darwin，#204 口径）→ 按 user-data-dir 收割渲染进程尾巴（#237 主病灶：
//     旧代 CEF helper 孤儿在 Dock 上多出一个 bun Helper）→ 拉起 launcher
//     （DSH_SHELL_RELAUNCH_PID 接班 env 口径不变，#119/#211）→ 轮询单实例台账等新桌面接位 →
//     继续守。桌面退出且没有给本代的有效重启意图 = 真退出：收尾（桌面已退净才收割尾巴）→
//     清自己 bootId 的租约 → 进程退出。
//   · #211（Windows 垂死壳 spawn 的子进程会被收割）从模型上不复存在：重启时没有任何进程
//     「边死边拉」，spawn 都发生在长驻的本进程里。
//
// 配置走 env DSH_SHELL_SUPERVISOR_CONFIG（JSON），由桌面侧 buildSupervisorSpawn 组装；
// 依赖的纯逻辑（接班等待 / CEF 锁判定 / 意图与租约落盘）直接复用 src/ 下的零依赖 TS 模块
// （bun 运行时原生跑 .ts，包内按仓库相对结构一并复制，见 electrobun.config.ts 的 copy）。

import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { dirname } from 'node:path'
import { RELAUNCH_PID_ENV, awaitParentExit } from '../src/bun/platform/app-restart.ts'
import { cefDirFromExecPath, cefLockProbePaths, cefLockState } from '../src/bun/platform/restart/cef-lock.ts'
import { SUPERVISED_BY_ENV } from '../src/bun/platform/restart/entry.ts'
import {
  clearRestartIntent,
  clearSupervisorLease,
  instanceFilePath,
  intentFilePath,
  readRestartIntent,
  readSupervisorLease,
  supervisorLeasePath,
  writeSupervisorLease,
} from '../src/bun/platform/restart/intent.ts'

/** 桌面侧（buildSupervisorSpawn）与本脚本共用的配置 env 键。 */
export const SUPERVISOR_CONFIG_ENV = 'DSH_SHELL_SUPERVISOR_CONFIG'

/** 等旧桌面退净的上限（超时照常往下走，抢锁那边另有 succeedsPid 兜底）。 */
const PID_WAIT_DEADLINE_MS = 15_000
/** 等 CEF 锁释放的上限（只 darwin 生效）。 */
const LOCK_WAIT_DEADLINE_MS = 10_000
/** 收割渲染进程尾巴的等待上限。 */
const TAIL_WAIT_DEADLINE_MS = 5_000
/** 等下一个桌面接位的上限（冷启动要起宿主，给足）。 */
const NEXT_DESKTOP_WAIT_MS = 90_000
/** 各类轮询的节拍。 */
const POLL_MS = 150

/**
 * 从 env 解析配置；缺 env / 坏 JSON / 必填字段非法都返回 null——监督进程宁可拒绝启动，
 * 也不带病乱守。bootId 在这里生成（这份监督进程实例的身证，收尾只清自己 bootId 的租约）。
 */
export function parseSupervisorConfig(env = process.env) {
  let raw
  try {
    raw = JSON.parse(env[SUPERVISOR_CONFIG_ENV] ?? '')
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  const launcherExe = raw.launcherExe
  const desktopPid = raw.desktopPid
  const appSupport = raw.appSupport
  if (typeof launcherExe !== 'string' || launcherExe === '') return null
  if (typeof desktopPid !== 'number' || !Number.isInteger(desktopPid) || desktopPid <= 1) return null
  if (typeof appSupport !== 'string' || appSupport === '') return null
  return {
    launcherExe,
    desktopPid,
    appSupport,
    logFile: typeof raw.logFile === 'string' ? raw.logFile : '',
    bootId: `sup-${String(process.pid)}-${Date.now().toString(36)}`,
    ...(typeof raw.pidWaitMs === 'number' ? { pidWaitMs: raw.pidWaitMs } : {}),
    ...(typeof raw.lockWaitMs === 'number' ? { lockWaitMs: raw.lockWaitMs } : {}),
    ...(typeof raw.tailWaitMs === 'number' ? { tailWaitMs: raw.tailWaitMs } : {}),
    ...(typeof raw.nextWaitMs === 'number' ? { nextWaitMs: raw.nextWaitMs } : {}),
    ...(typeof raw.pollMs === 'number' ? { pollMs: raw.pollMs } : {}),
  }
}

export function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** relay 日志（与壳 relay 同格式同文件：`<ISO> [supervisor] [info] …`）。写失败不致命。 */
export function relayLog(logFile, message) {
  if (logFile === undefined || logFile === '') return
  const line = `${new Date().toISOString()} [supervisor] [info] ${message}\n`
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    appendFileSync(logFile, line)
  } catch (error) {
    try {
      process.stderr.write(`[supervisor] 日志写入失败：${String(error)}\n`)
    } catch { }
  }
}

/** CEF 锁是否已释放：候选锁文件全部不存在，或都只指向死 pid（stale，CEF 会自行接管）。 */
export function cefLockReleased(cefDir, isAlive = defaultIsAlive, platform = process.platform) {
  for (const path of cefLockProbePaths(cefDir, platform)) {
    try {
      // 存在性看链接本身、不追目标：SingletonLock 的目标是 <hostname>-<pid> 伪路径，
      // 磁盘上不存在，existsSync 会追链接误判「没锁」——活锁就这么被当成已释放（测试抓到的）。
      lstatSync(path)
    } catch {
      continue // 真不存在 = 这把锁没上
    }
    let target = null
    try {
      target = readlinkSync(path)
    } catch {
      return false // 存在但读不出指向（Windows lockfile）：按仍在持有处理
    }
    const state = cefLockState({ lockExists: true, rawLockTarget: target, targetPidAlive: isAlive })
    if (state !== 'released') return false
  }
  return true
}

/**
 * 收割目标：darwin 按 CEF 目录精确点名（--user-data-dir=<CEF>，只杀自家的 helper）；
 * win32 的 msedgewebview2 是公共镜像名（别的应用也在用），只等不杀（#209 口径）；
 * 其余（linux 无 cefDir 推导）没有尾巴问题就不管。
 */
export function buildTailTarget({ platform = process.platform, launcherExe = '' } = {}) {
  const cefDir = cefDirFromExecPath(launcherExe, platform)
  if (cefDir !== null) return { kind: 'pattern', pattern: `--user-data-dir=${cefDir}` }
  if (platform === 'win32') return { kind: 'webview2' }
  return null
}

/** 探活命令：pattern 用 pgrep；webview2 用 tasklist 按镜像名看在不在。 */
export function buildTailProbeArgv(target) {
  if (target === null) return null
  if (target.kind === 'pattern') return ['pgrep', '-f', target.pattern]
  return ['tasklist', '/FI', 'IMAGENAME eq msedgewebview2.exe', '/NH']
}

/** 收割命令：只对 pattern 类生效（TERM / KILL 两段）；webview2 返回 null（只等）。 */
export function buildTailKillArgv(target, signal = 'TERM') {
  if (target === null || target.kind !== 'pattern') return null
  return ['pkill', `-${signal}`, '-f', target.pattern]
}

export function tailStillAlive(result, target) {
  if (target === null) return false
  if (target.kind === 'pattern') return (result?.exitCode ?? -1) === 0
  return String(result?.stdout ?? '').toLowerCase().includes('msedgewebview2')
}

/** 单实例台账里的桌面 pid（缺文件 / 坏 JSON / 字段非法 → null）。 */
export function readInstancePid(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const pid = raw?.pid
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 ? pid : null
  } catch {
    return null
  }
}

/** 轮询台账等新桌面接位：pid 换了人且活着才算。超时返回 null（新桌面没起来）。 */
export async function awaitNextDesktop({
  file,
  previousPid,
  isAlive = defaultIsAlive,
  readPid,
  sleep = (ms) => Bun.sleep(ms),
  deadlineMs,
  pollMs = POLL_MS,
}) {
  const read = readPid ?? (() => readInstancePid(file))
  for (let waited = 0; waited < deadlineMs; waited += pollMs) {
    const pid = read()
    if (pid !== null && pid !== previousPid && isAlive(pid)) return pid
    await sleep(pollMs)
  }
  return null
}

async function waitCefLockReleased(config, { isAlive, sleep, log }) {
  const cefDir = cefDirFromExecPath(config.launcherExe)
  if (cefDir === null) return
  const deadline = config.lockWaitMs ?? LOCK_WAIT_DEADLINE_MS
  const poll = config.pollMs ?? POLL_MS
  for (let waited = 0; waited < deadline; waited += poll) {
    if (cefLockReleased(cefDir, isAlive)) {
      log('CEF 锁已释放')
      return
    }
    await sleep(poll)
  }
  log(`CEF 锁等待超时（${String(deadline)}ms），照常拉起（stale 锁 CEF 会自行接管）`)
}

export async function reapRendererTails(config, { sleep, log, spawnSync, platform = process.platform }) {
  const target = buildTailTarget({ platform, launcherExe: config.launcherExe })
  if (target === null) return
  if (target.kind === 'webview2') {
    // #209：msedgewebview2 是公共镜像名，只等不杀；而「等」靠 tasklist 外部命令探测——#237 第三轮
    // 实测托盘重启时监督进程恰好在意图消费路径无声消失（pid 没了、.launcher 空、零 stderr），
    // 卡点就在这段外部命令与拉 launcher 之间。探测结果只影响日志、没有动作价值，win32 直接跳过：
    // 旧 webview2 尾巴随宿主死亡自会退出，不值得为它冒把监督进程带崩的风险。
    log('win32：msedgewebview2 只等不杀（#209），跳过外部命令探测（实机有带崩监督进程嫌疑）')
    return
  }
  const deadline = config.tailWaitMs ?? TAIL_WAIT_DEADLINE_MS
  const poll = config.pollMs ?? POLL_MS
  const term = buildTailKillArgv(target, 'TERM')
  if (term !== null) {
    try {
      spawnSync(term)
    } catch { }
    await sleep(poll)
  }
  const probe = buildTailProbeArgv(target)
  for (let waited = 0; waited < deadline; waited += poll) {
    let result = null
    try {
      result = spawnSync(probe)
    } catch { }
    if (!tailStillAlive(result, target)) {
      log(`渲染进程尾巴已退净（${target.kind}）`)
      return
    }
    await sleep(poll)
  }
  const kill = buildTailKillArgv(target, 'KILL')
  if (kill !== null) {
    try {
      spawnSync(kill)
    } catch { }
    log('尾巴等待超时，已补 KILL')
  } else {
    log(`尾巴等待超时（${String(deadline)}ms），照常继续`)
  }
}

function defaultSpawnLauncher(config, previousPid) {
  // launcher 的 stdout/stderr 落 <relay>.launcher：它若在启动早期就崩（native 载荷缺失等），
  // 自己的 shell.log 未必来得及写——错误只走 stderr。#237 教训：后台链路每个进程的死因都必须
  // 有 stderr 落盘，「spawn 成功却无声消失」没法排障。
  // 用 node:child_process 而非 Bun.spawn：#237 第三轮实测，托盘重启时监督进程在意图消费路径
  // 无声消失（pid 没了、.launcher 空、零 stderr），卡点在 reapTails 外部命令与这一步之间；
  // node 的 numeric-fd stdio 在 Windows 上成熟稳定，不再赌 Bun 的 Windows 实现。
  // detached + unref：launcher 不随监督进程退场。
  let launcherFd = null
  try {
    launcherFd = config.logFile === '' ? null : openSync(`${config.logFile}.launcher`, 'a')
    const child = nodeSpawn(config.launcherExe, {
      env: {
        ...process.env,
        [RELAUNCH_PID_ENV]: String(previousPid),
        [SUPERVISED_BY_ENV]: String(process.pid),
      },
      stdio: ['ignore', launcherFd ?? 'ignore', launcherFd ?? 'ignore'],
      detached: true,
      cwd: dirname(config.launcherExe),
    })
    child.unref()
    return child.pid ?? null
  } catch (error) {
    relayLog(config.logFile, `spawn launcher 失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    if (launcherFd !== null) closeSync(launcherFd)
  }
}

/**
 * 监督主循环。所有副作用都可注入（isAlive / sleep / spawnSync / spawnLauncher / readPid /
 * log / waitPidExit / waitCefLock / reapTails），单测不碰真进程。
 */
export async function runSupervisor(config, deps = {}) {
  const isAlive = deps.isAlive ?? defaultIsAlive
  const sleep = deps.sleep ?? ((ms) => Bun.sleep(ms))
  const log = deps.log ?? ((message) => relayLog(config.logFile, message))
  const spawnSync =
    deps.spawnSync ??
    ((argv) => {
      try {
        return Bun.spawnSync(argv, { stdout: 'ignore', stderr: 'ignore' })
      } catch {
        return { exitCode: -1, stdout: '' }
      }
    })
  const spawnLauncher = deps.spawnLauncher ?? ((previousPid) => defaultSpawnLauncher(config, previousPid))
  const readPid = deps.readPid ?? (() => readInstancePid(instanceFilePath(config.appSupport)))
  const waitPidExit =
    deps.waitPidExit ??
    ((pid) => awaitParentExit({ pid, isAlive, sleep, deadlineMs: config.pidWaitMs ?? PID_WAIT_DEADLINE_MS }))
  const waitCefLock = deps.waitCefLock ?? (() => waitCefLockReleased(config, { isAlive, sleep, log }))
  const reapTails = deps.reapTails ?? (() => reapRendererTails(config, { sleep, log, spawnSync }))

  const intentFile = intentFilePath(config.appSupport)
  let watched = config.desktopPid

  for (;;) {
  try {
    log(`守 pid=${String(watched)}：等它退出（有重启意图就拉下一个）`)
    const gone = await waitPidExit(watched)
    if (!gone) {
      // 常驻监督：等待窗口内桌面没退就继续守，绝不弃守——启动自举的监督者守的本来就是活桌面，
      // 超时收尾等于「后台常驻」名存实亡（#237 Windows 实测：15s 弃守后每次重启都要重新自举，
      // 还留下「监督者跟着桌面退出」的观感）。只有桌面真退才往下走。
      log(`等待窗口内未退出（pid=${String(watched)} 仍在），继续守`)
      await sleep(POLL_MS)
      continue
    }
    const intent = readRestartIntent(intentFile)
    if (intent === null || intent.pid !== watched) {
      log(`桌面退出（pid=${String(watched)}）且没有给本代的有效重启意图 → 收尾`)
      break
    }
    clearRestartIntent(intentFile)
    log(`收到重启意图（意图 pid=${String(intent.pid)}）：${cefDirFromExecPath(config.launcherExe) === null ? '' : '等 CEF 锁 → '}收割尾巴 → 拉 launcher`)
    await waitCefLock()
    log('CEF 锁已释放（或本平台无锁可等）')
    await reapTails()
    log('尾巴收割完成（或本平台无收割动作）')
    log(`正在拉 launcher：${config.launcherExe}`)
    const launcherPid = spawnLauncher(watched)
    if (launcherPid === null) {
      log('拉起 launcher 失败 → 收尾（桌面已退，用户可手动再开）')
      break
    }
    log(`launcher 已拉起（pid=${String(launcherPid)}），等新桌面接位`)
    const next = await awaitNextDesktop({
      file: instanceFilePath(config.appSupport),
      previousPid: watched,
      isAlive,
      readPid,
      sleep,
      deadlineMs: config.nextWaitMs ?? NEXT_DESKTOP_WAIT_MS,
      pollMs: config.pollMs ?? POLL_MS,
    })
    if (next === null) {
      log(`等了 ${String(config.nextWaitMs ?? NEXT_DESKTOP_WAIT_MS)}ms 没等到新桌面接位 → 收尾`)
      break
    }
    watched = next
    writeSupervisorLease(
      supervisorLeasePath(config.appSupport),
      {
        supervisorPid: process.pid,
        desktopPid: watched,
        bootId: config.bootId,
        startedAt: new Date().toISOString(),
      },
    )
    log(`新桌面已接位（pid=${String(watched)}），继续守`)
  } catch (error) {
    // 主循环异常绝不能无声退场（#237 Windows 实测：监督进程零日志消失无法排障）：记 relay 后续守。
    log(`本轮守候异常（续守不退）：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    await sleep(POLL_MS)
  }
  }

  // 走到收尾必是桌面真退（超时已改为续守，不再硬闯）：尾巴收割不再需要活死判守
  await reapTails()
  clearSupervisorLease(supervisorLeasePath(config.appSupport), config.bootId)
  log('监督进程退出')
}

async function main() {
  const config = parseSupervisorConfig()
  if (config === null) {
    // 抢救留痕（#237 Windows 实测补课）：配置非法也把死因写进桌面给定的 relay 文件——stderr 会随
    // stdio 丢弃（壳侧 spawn 全 ignore），relay 是后台链路唯一找得到的日志。
    let rescued = ''
    try {
      const parsed = JSON.parse(process.env[SUPERVISOR_CONFIG_ENV] ?? '')
      rescued = typeof parsed?.logFile === 'string' ? parsed.logFile : ''
    } catch { }
    relayLog(rescued, '监督进程启动失败：缺少/非法的 DSH_SHELL_SUPERVISOR_CONFIG，拒绝带病上岗（明细见 stderr）')
    process.stderr.write('[supervisor] 缺少/非法的 DSH_SHELL_SUPERVISOR_CONFIG，监督进程拒绝启动\n')
    process.exit(1)
  }
  relayLog(
    config.logFile,
    `监督进程启动（pid=${String(process.pid)}）：守 pid=${String(config.desktopPid)}，launcher=${config.launcherExe}`,
  )
  // 双监督守卫：已有监督进程且它守的桌面还活着 → 让位；它守的桌面已经死了 → 它马上会收尾，
  // 本进程接任（覆写租约；对方收尾只清自己 bootId，不会误删这份新租约）。
  const existing = readSupervisorLease(supervisorLeasePath(config.appSupport))
  if (
    existing !== null
    && existing.bootId !== config.bootId
    && defaultIsAlive(existing.supervisorPid)
    && defaultIsAlive(existing.desktopPid)
  ) {
    relayLog(config.logFile, `已有监督进程在位（pid=${String(existing.supervisorPid)}），本进程让位退出`)
    process.exit(0)
  }
  writeSupervisorLease(
    supervisorLeasePath(config.appSupport),
    {
      supervisorPid: process.pid,
      desktopPid: config.desktopPid,
      bootId: config.bootId,
      startedAt: new Date().toISOString(),
    },
  )
  await runSupervisor(config)
}

if (import.meta.main) {
  main().catch((error) => {
    try {
      process.stderr.write(`[supervisor] 未捕获异常退出：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    } catch { }
    process.exit(1)
  })
}
