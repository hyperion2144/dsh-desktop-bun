// #119 整应用重启（B）的纯逻辑半边：接班 env 解析 + 等旧壳退净 + 能不能自拉起的判定。
//
// #237 统一后台运行模型落地后，本文件只剩「接班三元组 + planRelaunch」：spawn / 等锁 / 收割
// 等 IO 全部搬进 platform/restart/（entry.ts 桌面侧）与 runtime/shell-supervisor.mjs（监督进程）。
// 本文件保持零导入，与 devtools.ts 同一口径，便于单测。
//
// #211（2026-10-20 实测）：Windows 上垂死壳 spawn 的中继会被一起收割——#237 的监督进程
// 不再由垂死的壳拉起（冷启动自举 / 接班桌面凭 env 跳过），这个坑从模型上不存在了。
//
// 接班口径不变：上一任把「要被接班的旧壳 pid」经 DSH_SHELL_RELAUNCH_PID 传给下一任，
// 新实例在抢锁前等那个 pid 真退干净再照常抢锁。等待发生在新实例自己身上，不靠两边的
// 时间窗对齐，也就不存在竞态。
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
// 纯决策（planRelaunch / relaunchParentPid / awaitParentExit）留在本文件；spawn / 等锁 / 收割
// 等 IO 在 platform/restart/entry.ts 与 runtime/shell-supervisor.mjs，同一口径，便于单测。

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

