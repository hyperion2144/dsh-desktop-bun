// 单实例：第二个壳不该再起一份宿主，而应把已有实例的窗口带到前台。
//
// 为什么自己写：Electrobun 2.0.2 没有单实例 API（旧 Tauri 壳用 tauri-plugin-single-instance）。
// 锁文件放**应用支持目录**而不是 DSH_HOME——同一台机器上一个 App 只该有一份，与 profile 无关。
//
// 内容：{pid, origin, pageUrl, profile, startedAt, bootId}。
// 流程：启动时 acquire；失败 ⇒ POST 已有实例的 /__shell__/activate（走它自己的 loopback 服务面，
// 不占端口、不起宿主），然后本进程退出。origin 要等服务面起来才知道，所以先登记 pid，就绪后再回填。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 壳自答端点：请已有实例把窗口带到前台（POST，无 token） */
export const ACTIVATE_PATH = '/__shell__/activate'

export interface InstanceRecord {
  pid: number
  /** 已有实例的 loopback origin；'' 表示它还在启动（这时也**不能**起第二份宿主） */
  origin: string
  pageUrl: string | null
  profile: string
  startedAt: string
  /** 开机标识（macOS `kern.boottime` 的秒值）。重启后 pid 会被复用，靠它认出「上次开机的记录」 */
  bootId: string
  /** 本实例 bun 进程的可执行路径（process.execPath）。同开机内 pid 复用给同名进程时靠它区分（#202 加固） */
  exePath: string
}

export function parseInstanceRecord(text: string): InstanceRecord | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Partial<InstanceRecord>
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) return null
    return {
      pid: record.pid,
      origin: typeof record.origin === 'string' ? record.origin : '',
      pageUrl: typeof record.pageUrl === 'string' ? record.pageUrl : null,
      profile: typeof record.profile === 'string' ? record.profile : 'desktop',
      startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
      bootId: typeof record.bootId === 'string' ? record.bootId : '',
      exePath: typeof record.exePath === 'string' ? record.exePath : '',
    }
  } catch {
    return null
  }
}

export function activateUrl(record: InstanceRecord): string {
  return `${record.origin}${ACTIVATE_PATH}`
}

export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM'
  }
}

/** 壳进程的 comm 里可能出现的片段（打包后是 launcher / bun，dev 下是 bun） */
export const OUR_PROCESS_HINTS = ['bun', 'launcher', 'electrobun', 'dsh-desktop-bun'] as const

/** 开机标识：macOS 用 `kern.boottime` 的秒值；拿不到就回空串（此时只靠进程身份判断） */
export function readBootId(): string {
  if (process.platform !== 'darwin') return ''
  try {
    const result = Bun.spawnSync(['sysctl', '-n', 'kern.boottime'], { stdout: 'pipe', stderr: 'ignore' })
    const text = new TextDecoder().decode(result.stdout ?? new Uint8Array())
    const match = /\{\s*sec\s*=\s*(\d+)/.exec(text)
    return match?.[1] ?? ''
  } catch {
    return ''
  }
}

/**
 * tasklist CSV 行取镜像名（win32 专用解析，拆纯函数便于在非 Windows 平台单测，#202）。
 * 行形态："launcher.exe","1234","Console",... 取第一列；
 * 找不到该 pid 时 tasklist 输出 INFO: 文案（无引号列）返回空串。
 */
export function imageFromTasklist(text: string): string {
  return text.split('"')[1] ?? ''
}

/**
 * 这个 pid 看起来还是我们的壳吗？
 *
 * 系统重启后 pid 会被复用（实测：一个 16GB 的 macOS 启动后 pid 546 变成了 mobiletimerd），
 * 所以「pid 活着」远不足以判定「上个实例还在跑」——必须再看进程身份。
 */
export function defaultIsOurProcess(
  pid: number,
  expectedExe?: string,
  needles: readonly string[] = OUR_PROCESS_HINTS,
): boolean {
  try {
    // #202：Windows 没有 ps（spawnSync 直接 ENOENT，身份判定恒 false → 单实例整体失效），
    // 改 tasklist 按 pid 取镜像名；POSIX 保留 ps -o comm=。
    const result = process.platform === 'win32'
      ? Bun.spawnSync(['tasklist', '/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'], { stdout: 'pipe', stderr: 'ignore' })
      : Bun.spawnSync(['ps', '-p', String(pid), '-o', 'comm='], { stdout: 'pipe', stderr: 'ignore' })
    const text = new TextDecoder().decode(result.stdout ?? new Uint8Array()).trim().toLowerCase()
    if (text === '') return false
    const comm = process.platform === 'win32' ? imageFromTasklist(text) : text
    if (comm === '') return false
    if (!needles.some((needle) => comm.includes(needle.toLowerCase()))) return false
    // 粗筛命中只是「名字像」（bun/launcher 都是常见词）——pid 复用给用户自己 `bun run` 的进程
    // 也会命中。锁里存了我们自己写入的 exePath 时再验一道：对方进程的可执行路径必须完全一致，
    // 同名不同路径一律不认（旧锁无 exePath 则回退粗筛结果，兼容升级）。
    const expected = (expectedExe ?? '').trim()
    if (expected === '') return true
    const observed = executablePathOf(pid)
    if (observed === '') return false
    return pathMatches(observed, expected)
  } catch {
    return false
  }
}

/**
 * 读 pid 对应进程的可执行文件路径（深验证用，仅粗筛命中时调用）:
 * win32 用 PowerShell Get-CimInstance（wmic 新镜像已移除，tasklist 给不了全路径）；
 * POSIX 用 `ps -o args=` 取 argv[0]（比 comm= 信息全，macOS 上通常已是完整路径）。
 * 读不到（权限/进程刚退）返回空串 —— 调用方按不认处理，宁可错杀 stale lock 不误认外戚。
 */
export function executablePathOf(pid: number): string {
  try {
    const result =
      process.platform === 'win32'
        ? Bun.spawnSync(
            [
              'powershell',
              '-NoProfile',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${String(pid)}').ExecutablePath`,
            ],
            { stdout: 'pipe', stderr: 'ignore' },
        )
        : Bun.spawnSync(['ps', '-p', String(pid), '-o', 'args='], { stdout: 'pipe', stderr: 'ignore' })
    const text = new TextDecoder().decode(result.stdout ?? new Uint8Array()).trim()
    if (text === '') return ''
    return process.platform === 'win32' ? text : firstArgOfPsArgs(text)
  } catch {
    return ''
  }
}

/** `ps -o args=` 输出取 argv[0]（首段；引号包裹时取引号内） */
export function firstArgOfPsArgs(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? ''
  if (line.startsWith('"')) return line.slice(1).split('"')[0] ?? ''
  return line.split(/\s+/)[0] ?? ''
}

/** 可执行路径全等比对：去引号 + 大小写归一（Windows 路径大小写不敏感） */
export function pathMatches(observed: string, expected: string): boolean {
  const norm = (value: string): string => value.trim().replace(/^"|"$/g, '').toLowerCase()
  return norm(observed) === norm(expected) && norm(observed) !== ''
}

export interface InstanceIdentity {
  pid: number
  profile: string
  startedAt: string
  /** 测试可覆盖；默认取 process.execPath（锁里存下自己，供后续实例深验证 pid 复用） */
  exePath: string
}

export interface AcquireOptions {
  isAlive?: (pid: number) => boolean
  /** 当前开机标识（默认自己读）；测试可覆盖 */
  bootId?: string
  /** #119：本进程接的是谁的班——该 pid 虽还活着（正退未退净）也**不算**已有实例，允许接管。 */
  succeedsPid?: number
  /** 判断某个 pid 是否还是我们的壳进程（默认 `ps -o comm=`）；测试可覆盖 */
  /** 判断某个 pid 是否还是我们的壳进程（第二参为锁里记录的可执行路径，供深验证 pid 复用）；测试可覆盖 */
  isOurProcess?: (pid: number, expectedExe?: string) => boolean
  /** 覆盖身份，便于单测 */
  identity?: Partial<InstanceIdentity>
}

export interface AcquireResult {
  /** true ⇒ 本进程是唯一实例（可以继续启动）；false ⇒ 已有活着的实例 */
  acquired: boolean
  previous: InstanceRecord | null
  record: InstanceRecord
  /**
   * #123：锁**写不下来**时的原因（null = 写成了）。
   *
   * 与 `acquired` 正交，别混：`acquired` 回答的是「有没有另一个活着的实例要我把位子让给它」，
   * 这里回答的是「我自己这份记不记得下来」。写失败时 `acquired` 仍是 true（本进程确实是唯一实例，
   * 没有谁要抢），但单实例保护实际上**没生效**——把这两件事混成一个字段，
   * 调用方就会在没有实例可激活的情况下去走「激活已有实例」那条路。
   */
  lockError: string | null
}

export function readInstance(file: string): InstanceRecord | null {
  if (!existsSync(file)) return null
  try {
    return parseInstanceRecord(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 写锁文件的成败。#123：以前失败是 `catch {}` 吞掉的，现在如实回报。 */
export interface WriteInstanceOutcome {
  ok: boolean
  /** ok=false 时的原因（人话，直接进日志） */
  error: string | null
}

/**
 * 写锁文件。建目录是这一层自己的责任：应用支持目录不归壳里任何别的模块管，
 * 全仓唯一给它 mkdir 的地方是插件物化（晚于抢锁），干净机器上的首次启动就会扑空。
 * 照仓内既有约定（diagnostics / log-sink / notifications / keybindings / profile-manager）一律 mkdir。
 */
export function writeInstance(file: string, record: InstanceRecord): WriteInstanceOutcome {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 抢实例位。已有实例活着（且不是自己）⇒ acquired=false，调用方应当只做「激活它然后退出」。
 * 自己不活/文件损坏/pid 就是自己 ⇒ 直接接管并写自己的记录。
 */
export function acquireInstance(
  file: string,
  profile: string,
  options: AcquireOptions = {},
): AcquireResult {
  const isAlive = options.isAlive ?? defaultIsAlive
  const pid = options.identity?.pid ?? process.pid
  const startedAt = options.identity?.startedAt ?? new Date().toISOString()
  const bootId = options.bootId ?? readBootId()
  const isOurProcess = options.isOurProcess ?? defaultIsOurProcess
  const mine: InstanceRecord = {
    pid,
    origin: '',
    pageUrl: null,
    profile: options.identity?.profile ?? profile,
    startedAt,
    bootId,
    exePath: options.identity?.exePath ?? process.execPath,
  }
  const existing = readInstance(file)
  // 「已有实例还活着」要同时满足四条：pid 不是自己、不是要接班的那个、pid 活着、
  // 仍是我们的壳进程、且不是上次开机留下的记录。
  // 只看 pid 会在系统重启后被别家进程（pid 复用）骗过去 ⇒ 用户看到的症状是「点了没反应」。
  // succeedsPid（#119）：整应用重启时新实例是被旧实例拉起来的，旧实例此刻往往还活着——
  // 不豁免它，新实例会判定「已有实例」→ 激活旧实例后自己退出 → 净结果什么都没起来。
  const succeedsPid = options.succeedsPid
  if (existing !== null && existing.pid !== pid && existing.pid !== succeedsPid && isAlive(existing.pid)) {
    const sameBoot = bootId === '' || existing.bootId === '' || existing.bootId === bootId
    if (sameBoot && isOurProcess(existing.pid, existing.exePath)) {
      return { acquired: false, previous: existing, record: existing, lockError: null }
    }
  }
  const written = writeInstance(file, mine)
  // #123：写失败也要把事实带走。以前这里是 `writeInstance(...)` 然后无条件 acquired=true，
  // 等于把「没写成」说成「拿到了」——单实例保护静默失效，日志里一个字都没有。
  return { acquired: true, previous: existing, record: mine, lockError: written.error }
}

/** 服务面就绪后回填 origin/页面 URL（第二个实例据此激活本实例）。 */
export function updateInstance(
  file: string,
  pid: number,
  patch: Partial<Pick<InstanceRecord, 'origin' | 'pageUrl'>>,
): void {
  const current = readInstance(file)
  if (current === null || current.pid !== pid) return
  // #123：这里刻意不把 writeInstance 的成败升级成错误。抢锁时已经把目录建出来了，本函数只是往
  // 已存在的锁上补 origin/pageUrl；补不上的话单实例仍在本进程手里（锁是自己写的），只是第二个
  // 实例拿不到 activate 地址。为此加回读重试属于过度设计，不做。
  void writeInstance(file, { ...current, ...patch })
}

/**
 * 退出时清掉自己的记录（不是自己的就不动——可能已被新实例接管）。
 *
 * 直接删文件而不是写 pid=0：锁文件的语义就是「有文件 = 有实例」，
 * 留一个假记录会让后面每个启动都多一次「这是死 pid 吗」的判定。
 * 先读再删，只为自己不误删新实例刚写下的锁。
 */
export function releaseInstance(file: string, pid: number): void {
  const current = readInstance(file)
  if (current === null || current.pid !== pid) return
  try {
    rmSync(file, { force: true })
  } catch {}
}
