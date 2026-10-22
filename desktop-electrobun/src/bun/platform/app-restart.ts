// #119 整应用重启的「接班三元组」：RELAUNCH_PID_ENV / relaunchParentPid / awaitParentExit。
//
// #240 map 的进程模型（#243 主进程/壳拆分、#245 监督进程收缩）：壳的托盘「重启应用」=
// 壳向主进程上报 restart 意图后自杀，主进程（daemon/run.ts）收割旧壳并重拉；#237 的独立
// 监督进程与中继（runtime/shell-supervisor.mjs、platform/restart/）已整体移除。
// 本文件只留新壳的接班等待：主进程重拉的新壳带着 DSH_SHELL_RELAUNCH_PID=旧壳 pid，
// 在抢壳锁前等那个 pid 真退干净再照常抢锁。等待发生在新实例自己身上，不靠两边的
// 时间窗对齐，也就不存在竞态。拉起新实例这件事由主进程的 spawnShell 负责（daemon/spawn.ts）。
//
// 为什么不用框架 API：Electrobun 2.0.2 没有 relaunch/restart。
// 核符号表里只有 `quitGracefully` / `forceExit` / `stopEventLoop` / `waitForShutdownComplete`
// ——全是「怎么退」，没有「退之前把新实例拉起来」。`app` 面只有 `on` / `quit` / `isPackaged`
// / `isCarrotMode` / `manifest` / 路径与令牌那几个 getter。
//
// 为什么「先退再拉」不成立、也不能「先拉再退」（#119 口径，历史决策保留）：
//   · 先退再拉：退完进程就没了，没人再执行 spawn。
//   · 先拉再退：新实例起来时 `acquireInstance` 撞见旧 pid 还活着且仍是我们的壳进程
//     （single-instance.ts 的三条判据：pid 活着 + `ps -o comm=` 像壳 + 同一次开机）
//     ⇒ 判定「已有实例」⇒ 激活旧实例后自己退出；旧实例随即退掉 ⇒ **净结果什么都没起来**。
// 做法是让**新实例自己知道**它是接班人：主进程把旧 pid 经 `DSH_SHELL_RELAUNCH_PID` 传给
// 新壳，新壳在抢锁前等那个 pid 真退干净，再照常抢锁。

/** 父进程把「要被接班的旧壳 pid」经 launcher env 传给新实例。 */
export const RELAUNCH_PID_ENV = 'DSH_SHELL_RELAUNCH_PID'

/** 接班方最多等旧壳这么久。超了就照常抢锁（acquireInstance 另有 succeedsPid 兜底），不把启动卡死。 */
export const RELAUNCH_WAIT_DEADLINE_MS = 15_000

const RELAUNCH_POLL_MS = 150


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

