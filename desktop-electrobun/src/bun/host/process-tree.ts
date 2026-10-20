// 进程树枚举与树级停止（#60）。
//
// 宿主的伴生进程（第三方插件的代理进程、会话终端等）是宿主的后代：只杀宿主 PID 的
// 话，它们会变成孤儿、退场时机不受控——快速重启窗口里新宿主可能撞上垂死的旧伴生
// （#60 实证：新宿主 attach 上旧代理后 watcher 注册失败，模型流量静默直连）。
// 所以「停止宿主」的契约必须是树级：枚举整棵树 → 同批 SIGTERM → 宽限 →
// SIGKILL 幸存者 → 确认树灭。机制只认「宿主进程树」这个通用概念，不点名任何
// 插件或端口段；清理失败不阻塞重启（有界等待，超时放行 + 记日志）。
//
// 分层：
//   纯逻辑    parseProcessTable / collectDescendants / waitAllDead（单测直接覆盖）
//   平台绑定  createPlatformProbe（macOS/Linux: ps；Windows: PowerShell CIM）
//   编排      stopProcessTree（宿主停止）/ sweepProcessRemnants（崩溃后孤儿清扫）
//             startTreeSampler（宿主生前树快照，崩溃路径定位孤儿用）

export interface ProcessTableEntry {
  pid: number
  ppid: number
}

/** 探活：kill(pid, 0) 只验存在与权限，不发信号。 */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程在、只是没权限杀，也算活着；ESRCH = 已退场
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 进程表文本 → 条目：吃 `ps -eo pid=,ppid=` 与 PowerShell CIM 两列输出两种形态
 * （`pid ppid`，空白分隔）。表头、坏行、pid<=0 一律跳过——解析容错优先，缺行只当
 * 「枚举不全」，不能让停止流程炸掉。
 */
export function parseProcessTable(text: string): ProcessTableEntry[] {
  const entries: ProcessTableEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 2) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0 || ppid < 0) continue
    entries.push({ pid, ppid })
  }
  return entries
}

/** BFS 收集 rootPid 的全部后代（不含 root 自己）；环（正常不会有）靠 visited 兜底。 */
export function collectDescendants(entries: ProcessTableEntry[], rootPid: number): number[] {
  const childrenOf = new Map<number, number[]>()
  for (const { pid, ppid } of entries) {
    if (pid === rootPid) continue
    const list = childrenOf.get(ppid)
    if (list === undefined) childrenOf.set(ppid, [pid])
    else list.push(pid)
  }
  const out: number[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const parent = queue.shift() as number
    for (const child of childrenOf.get(parent) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      out.push(child)
      queue.push(child)
    }
  }
  return out
}

/** 有界等待一批 pid 全部退场；到点把仍活着的返回（超时放行，由调用方记录）。 */
export async function waitAllDead(
  pids: number[],
  aliveFn: (pid: number) => boolean,
  timeoutMs: number,
  pollMs = 100,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let remaining = pids.filter(aliveFn)
  while (remaining.length > 0 && Date.now() < deadline) {
    await Bun.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    remaining = remaining.filter(aliveFn)
  }
  return remaining
}

// ---- 平台绑定：进程表快照 ----------------------------------------------------

export interface TreeProbe {
  /** 全表快照；失败抛错，由调用方决定降级（停止流程退化为停单进程）。 */
  list(): Promise<ProcessTableEntry[]>
}

/** 表读取上限：枚举卡死不能拖着停止流程走。 */
const TABLE_READ_TIMEOUT_MS = 5_000

async function readCommandTable(command: string[], timeoutMs = TABLE_READ_TIMEOUT_MS): Promise<string> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'ignore' })
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {}
  }, timeoutMs)
  try {
    const text = await new Response(child.stdout as ReadableStream<Uint8Array>).text()
    await child.exited
    return text
  } finally {
    clearTimeout(timer)
  }
}

/** macOS / Linux：ps 一把拿全表（`pid=,ppid=` 两列，无表头）。 */
export function createPosixProbe(): TreeProbe {
  return {
    list: async () => parseProcessTable(await readCommandTable(['ps', '-eo', 'pid=,ppid='])),
  }
}

/**
 * Windows：wmic 已从 Win11 24H+ 移除，走 PowerShell CIM。输出与 ps 同构的两列
 * （pid ppid），解析层不用分叉。
 */
export function createWindowsProbe(): TreeProbe {
  const script = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }"
  return {
    list: async () =>
      parseProcessTable(
        await readCommandTable(['powershell', '-NoProfile', '-NonInteractive', '-Command', script]),
      ),
  }
}

export function createPlatformProbe(platform: NodeJS.Platform = process.platform): TreeProbe {
  return platform === 'win32' ? createWindowsProbe() : createPosixProbe()
}

/** 给一批 pid 发信号（尽力而为），返回发失败的 pid（多半是刚好退场了，无害）。 */
export function signalPids(
  pids: number[],
  signal: NodeJS.Signals,
  signalFn: (pid: number, signal: NodeJS.Signals) => void,
): number[] {
  const failed: number[] = []
  for (const pid of pids) {
    try {
      signalFn(pid, signal)
    } catch {
      failed.push(pid)
    }
  }
  return failed
}

// ---- 编排一：宿主停止（树级升级） ---------------------------------------------

export interface StopProcessTreeInput {
  rootPid: number
  /** root 自己的退出承诺（宿主 child.exited）；没给就按纯时限等待。 */
  rootExited?: Promise<number>
  probe: TreeProbe
  graceMs?: number
  killWaitMs?: number
  confirmTimeoutMs?: number
  signalFn?: (pid: number, signal: NodeJS.Signals) => void
  aliveFn?: (pid: number) => boolean
  onLog?: (line: string) => void
}

export interface StopProcessTreeResult {
  /** 本次纳入停止的后代（枚举失败为空 = 退化为停单进程，不阻塞停止本身）。 */
  descendants: number[]
  /** 确认阶段到点仍活着的进程（超时放行，调用方记日志；不阻塞重启）。 */
  survivors: number[]
}

export const DEFAULT_STOP_GRACE_MS = 5_000
export const DEFAULT_STOP_KILL_WAIT_MS = 2_000
export const DEFAULT_CONFIRM_TIMEOUT_MS = 3_000
const CONFIRM_POLL_MS = 100

/**
 * 树级停止：杀前枚举（宿主一死直接子代就被 init/launchd 收养，事后按 ppid 找不到）
 * → 同批 SIGTERM → 宽限期到点升级 SIGKILL → 等退出承诺（有界）→ 确认树灭（有界，
 * 到点补一刀再放行）。全程有界，任何一步失败都不断链。
 */
export async function stopProcessTree(input: StopProcessTreeInput): Promise<StopProcessTreeResult> {
  const graceMs = input.graceMs ?? DEFAULT_STOP_GRACE_MS
  const killWaitMs = input.killWaitMs ?? DEFAULT_STOP_KILL_WAIT_MS
  const confirmTimeoutMs = input.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS
  const signalFn = input.signalFn ?? ((pid, signal) => process.kill(pid, signal))
  const aliveFn = input.aliveFn ?? isProcessAlive
  const onLog = input.onLog ?? (() => {})
  const { rootPid } = input

  // 1. 杀前枚举：只有这一刻整棵树还挂着宿主的 ppid。
  let descendants: number[] = []
  try {
    descendants = collectDescendants(await input.probe.list(), rootPid)
  } catch (error) {
    onLog(`[tree] 进程表枚举失败，退化为停单进程：${error instanceof Error ? error.message : String(error)}`)
  }
  const targets = [rootPid, ...descendants]

  // 2. 同批 SIGTERM：宿主与后代各自走优雅退场。
  signalPids(targets, 'SIGTERM', signalFn)

  // 3. 宽限期到点没走的，整批升级 SIGKILL。
  const escalation = setTimeout(() => {
    const stuck = targets.filter(aliveFn)
    if (stuck.length === 0) return
    onLog(`[tree] 宿主树 ${String(graceMs)}ms 未退场（${String(stuck.length)} 个），升级 SIGKILL：${stuck.join(', ')}`)
    signalPids(stuck, 'SIGKILL', signalFn)
  }, graceMs)

  try {
    if (input.rootExited !== undefined) {
      await Promise.race([input.rootExited, Bun.sleep(graceMs + killWaitMs)])
    } else {
      await Bun.sleep(graceMs + killWaitMs)
    }
  } finally {
    clearTimeout(escalation)
  }
  if (aliveFn(rootPid)) signalPids([rootPid], 'SIGKILL', signalFn) // 兜底：承诺没等到也不拖

  // 4. 确认树灭（有界）：到点仍活着的补一发 SIGKILL，再等一小轮，然后放行。
  let survivors = await waitAllDead(descendants, aliveFn, confirmTimeoutMs, CONFIRM_POLL_MS)
  if (survivors.length > 0) {
    onLog(`[tree] 确认窗口内仍有 ${String(survivors.length)} 个未退场，补发 SIGKILL：${survivors.join(', ')}`)
    signalPids(survivors, 'SIGKILL', signalFn)
    survivors = await waitAllDead(survivors, aliveFn, Math.min(confirmTimeoutMs, 1_000), CONFIRM_POLL_MS)
  }
  return { descendants, survivors }
}

// ---- 编排二：崩溃残留清扫（守护器自愈拉新宿主前） ------------------------------

export interface SweepRemnantsInput {
  /** 宿主生前最后一次树快照（伴生 pid）。宿主死后直接子代已被收养，只有生前快照能定位。 */
  pids: number[]
  graceMs?: number
  confirmTimeoutMs?: number
  signalFn?: (pid: number, signal: NodeJS.Signals) => void
  aliveFn?: (pid: number) => boolean
  onLog?: (line: string) => void
}

export const SWEEP_GRACE_MS = 1_500
export const SWEEP_CONFIRM_TIMEOUT_MS = 2_000

/**
 * 清扫已亡宿主的伴生孤儿：TERM → 短宽限 → KILL 幸存者 → 有界确认。空快照零开销
 * （直接返回），清扫与守护器的退避睡眠并行，不给自愈加可感知时延。
 */
export async function sweepProcessRemnants(input: SweepRemnantsInput): Promise<number[]> {
  const graceMs = input.graceMs ?? SWEEP_GRACE_MS
  const confirmTimeoutMs = input.confirmTimeoutMs ?? SWEEP_CONFIRM_TIMEOUT_MS
  const signalFn = input.signalFn ?? ((pid, signal) => process.kill(pid, signal))
  const aliveFn = input.aliveFn ?? isProcessAlive
  const onLog = input.onLog ?? (() => {})

  const live = input.pids.filter(aliveFn)
  if (live.length === 0) return [] // 无树可清：零开销路径
  onLog(`[tree] 清理已亡宿主的伴生进程（树快照）：${live.join(', ')}`)

  signalPids(live, 'SIGTERM', signalFn)
  let survivors = await waitAllDead(live, aliveFn, graceMs, CONFIRM_POLL_MS)
  if (survivors.length > 0) {
    onLog(`[tree] 伴生 ${String(graceMs)}ms 未退场，升级 SIGKILL：${survivors.join(', ')}`)
    signalPids(survivors, 'SIGKILL', signalFn)
    survivors = await waitAllDead(survivors, aliveFn, confirmTimeoutMs, CONFIRM_POLL_MS)
  }
  return survivors
}

// ---- 编排三：宿主生前树采样（崩溃路径的定位手段） ------------------------------

export interface TreeSampler {
  /** 最近一次快照里宿主的后代（不含宿主）；宿主死后冻结为最后一份有效快照。 */
  latest(): number[]
  stop(): void
}

/**
 * 周期采样宿主的进程树。崩溃场景下伴生进程被 init/launchd 收养（ppid 不再指向
 * 宿主），事后无法按 ppid 找回——只有生前快照能定位它们。宿主一死立刻冻结
 * （死后的表里宿主子树已散，不能让空表冲掉最后一份有效快照）。
 */
export function startTreeSampler(
  probe: TreeProbe,
  rootPid: number,
  intervalMs: number,
  onLog?: (line: string) => void,
  aliveFn: (pid: number) => boolean = isProcessAlive,
): TreeSampler {
  let latest: number[] = []
  let stopped = false
  const sample = async (): Promise<void> => {
    if (stopped) return
    if (!aliveFn(rootPid)) {
      stopped = true
      return
    }
    try {
      latest = collectDescendants(await probe.list(), rootPid)
    } catch (error) {
      onLog?.(`[tree] 树采样失败（沿用上次快照）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  void sample()
  const timer = setInterval(() => {
    void sample()
  }, intervalMs)
  timer.unref?.()
  return {
    latest: () => latest,
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
