// dsh 系统命令注册的 IO 外壳（旧壳 `desktop/src-tauri/src/register/` 的等价物）。
//
// 三件事：
//   1. 维护 shim：`<appSupport>/runtime/bin-dsh/dsh[.cmd]`，内容永远指向**当前**运行时的 dsh 入口
//      （运行时切了要重写；内容不是我们写的（foreign）就不动）；
//   2. 探测：spawn 用户**真实登录 shell** 解析 `dsh`（GUI 进程的 PATH 不等于终端 PATH），
//      与本壳 shim 比 realpath 得三态；超时/失败就是「没探出来」，保持旧缓存；
//   3. 注册：macOS 走 `osascript … with administrator privileges` 提权 `ln -sfn`（冲突要 force）。
//
// 缓存与并发：菜单重建很频繁，所以状态缓存起来（`CACHE_TTL_MS`），刷新在后台跑且
// 同一时刻只跑一个——**调用方绝不能同步等探测**。
import {
  CACHE_TTL_MS,
  CONFLICT_MARKER,
  DETECT_COMMAND,
  DETECT_ENV,
  DETECT_TIMEOUT_MS,
  appleEscape,
  classifyResolution,
  classifyShim,
  describeRegisterState,
  extractLastNonEmptyLine,
  parseUserShell,
  linuxRegistrationScript,
  linuxRegistrationTarget,
  parseWindowsPathRegQuery,
  windowsPathHasEntry,
  windowsPathWriteScript,
  windowsUserPathEntries,
  windowsUserPathWrite,
  registrationScript,
  REGISTER_TARGET,
  samePath,
  shimPathOf,
  shimScript,
  type RegisterKind,
  type RegisterState,
  type ShimVerdict,
} from '../../shared/app/register-cli.ts'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Logger } from '../../shared/logging/levels.ts'

export interface RunResult {
  status: number
  stdout: string
  stderr: string
}

export type RunImpl = (argv: string[], options?: { env?: Record<string, string>; timeoutMs?: number }) => RunResult

export interface RegisterCliOptions {
    log: Logger
  appSupport: string
  /** 当前运行时的 dsh 启动命令（可执行 + 参数）；运行时切换后 shim 会按它重写 */
  shellCommand: () => readonly string[] | null
  platform?: string
  env?: Record<string, string | undefined>
  run?: RunImpl
  readText?: (path: string) => string | null
  writeText?: (path: string, text: string, mode?: number) => void
  exists?: (path: string) => boolean
  realpath?: (path: string) => string | null
  home?: string
  /** 读系统入口（follow 符号链接，拿不到回 null）——菜单保鲜的 fs 级快探测用（#62） */
  readlink?: (path: string) => string | null
  username?: string
  now?: () => number
}

export interface RegisterResult {
  ok: boolean
  /** canceled = 用户在系统授权弹窗点了取消（中性结果，系统未改动） */
  code?: 'canceled' | 'conflict' | 'unsupported' | 'error'
  message: string
}

export interface RegisterCli {
  cached: () => RegisterState
  /** 异步探测（带 in-flight 去重 + TTL）；返回最新缓存 */
  refresh: (options?: { force?: boolean }) => Promise<RegisterState>
  /** 物化/维护 shim，返回路径与判词 */
  ensureShim: () => { path: string; verdict: ShimVerdict }
  register: (options?: { force?: boolean }) => Promise<RegisterResult>
  describe: () => string
  /** 保鲜轮询：只跑 fs 级快探测（不 spawn）；判不出来或没变化时返回现有缓存 */
  poll: () => RegisterState
}

const EMPTY_STATE: RegisterState = { kind: 'unknown', resolved: null, shimReady: false, at: 0 }

export function createRegisterCli(options: RegisterCliOptions): RegisterCli {
  const platform = options.platform ?? process.platform
  const env = options.env ?? (process.env as Record<string, string | undefined>)
  const now = options.now ?? Date.now
  const shimPath = shimPathOf(options.appSupport, platform)
  const run = options.run ?? defaultRun
  const readText = options.readText ?? defaultReadText
  const writeText = options.writeText ?? defaultWriteText
  const exists = options.exists ?? defaultExists
  const realpath = options.realpath ?? defaultRealpath
  const readlink = options.readlink ?? defaultReadlink

  let cached: RegisterState = { ...EMPTY_STATE }
  let inflight: Promise<RegisterState> | null = null
  let lastAt = 0

  function ensureShim(): { path: string; verdict: ShimVerdict } {
    const argv = options.shellCommand()
    if (argv === null || argv.length === 0) return { path: shimPath, verdict: 'absent' }
    const expected = shimScript(platform, argv)
    const existing = readText(shimPath)
    const verdict = classifyShim(existing, expected)
    // shim 文件在本壳私有的 appSupport 目录里：只要内容不是最新就对账重写——旧版本写坏的
    // 入口路径没带标记注释，也不会被误判成「别人占位」（#62 PR 实测：旧 dsh.cmd 一直占着坑）。
    if (existing === expected) return { path: shimPath, verdict: 'ours' }
    if (verdict === 'foreign') {
        options.log.warn(`shim 位置发现非本壳内容，按本壳目录回收重写：${shimPath}`)
    }
    try {
      writeText(shimPath, expected, 0o755)
        options.log.info(`shim 已${verdict === 'stale' ? '更新' : '写入'}：${shimPath} → ${argv.join(' ')}`)
      return { path: shimPath, verdict: verdict === 'stale' ? 'stale' : 'ours' }
    } catch (error) {
        options.log.error(`shim 写入失败：${String(error)}`)
      return { path: shimPath, verdict: 'absent' }
    }
  }

  /** 用户真实登录 shell（macOS 用 dscl 问系统，回落到 $SHELL，再回落 /bin/zsh）。 */
  function userShell(): string {
    if (platform === 'darwin') {
      const username = options.username ?? env.USER ?? ''
      if (username !== '') {
        const out = run(['/usr/bin/dscl', '.', '-read', `/Users/${username}`, 'UserShell'], { timeoutMs: 4_000 })
        const parsed = out.status === 0 ? parseUserShell(out.stdout) : null
        if (parsed !== null) return parsed
      }
    }
    return env.SHELL ?? (platform === 'win32' ? 'cmd.exe' : '/bin/zsh')
  }

  /** 解析用户环境里的 dsh；`undefined` = 探测不确定（超时/失败），调用方保持旧缓存。 */
  function resolveInUserEnv(): string | null | undefined {
    if (platform === 'win32') {
      // 新终端按注册表用户 PATH 解析：先看本壳入口在不在（权威）。
      const query = run(['reg', 'query', 'HKCU\\Environment', '/v', 'Path'], { timeoutMs: DETECT_TIMEOUT_MS })
      const parsed = query.status === 0 ? parseWindowsPathRegQuery(query.stdout) : null
      const entries = parsed !== null ? windowsUserPathEntries(parsed.raw) : null
      if (entries !== null && windowsPathHasEntry(entries, dirname(shimPath))) return shimPath
      // `where dsh` 走进程 PATH 启动快照，会命中旧安装残留（PR #67 实测）；只用来发现「别人」。
      const out = run(['where', 'dsh'], { timeoutMs: DETECT_TIMEOUT_MS })
      const first = out.status === 0 ? out.stdout.split(/\r?\n/).find((line) => line.trim() !== '') : undefined
      const hit = first !== undefined && first.trim() !== '' ? first.trim() : null
      if (hit !== null) {
          options.log.info(`where dsh → ${hit}（注册表用户 PATH 里没有本壳入口）`)
        return hit
      }
      if (parsed === null) {
          options.log.warn(`注册表用户 PATH 读取失败（exit ${String(query.status)}），按未注册处理`)
        return null
      }
        options.log.warn(`注册表用户 PATH 里没有本壳入口（${dirname(shimPath)}）且 where 落空，按未注册处理`)
      return null
    }
    const shell = userShell()
    const out = run([shell, '-ilc', DETECT_COMMAND], { env: DETECT_ENV, timeoutMs: DETECT_TIMEOUT_MS })
    // 超时/起不来：`-ilc` 正常返回非零是「没找到」，这里用 124 之类区分不开 ⇒ 用信号判据
    if (out.status === 124 || out.status === 137) return undefined
    const line = extractLastNonEmptyLine(out.stdout)
    if (line === null || line === '') return null
    // 非 '/' 开头 = alias/function 命中：不是可执行文件路径，但仍算「解析到了别人」
    return line
  }

  function classify(): RegisterState {
    const shim = ensureShim()
    const shimReady = shim.verdict !== 'absent' && exists(shimPath)
    const resolved = resolveInUserEnv()
    if (resolved === undefined) {
      // 探测不确定：保留旧结论，只更新时间戳
      return { ...cached, at: now() }
    }
    const normalizedResolved = resolved === null ? null : (realpath(resolved) ?? resolved)
    const normalizedShim = realpath(shimPath) ?? shimPath
    const kind: RegisterKind = classifyResolution({
      shimPath: normalizedShim,
      shimReady,
      resolved: normalizedResolved,
      platform,
    })
    return { kind, resolved: normalizedResolved, shimReady, at: now() }
  }

  async function refresh(refreshOptions: { force?: boolean } = {}): Promise<RegisterState> {
    const forced = refreshOptions.force === true
    const fresh = !forced && now() - lastAt < CACHE_TTL_MS && cached.kind !== 'unknown'
    if (fresh) return cached
    // 在途刷新只服务非强制请求。强制刷新要的是「此刻的结论」，在途那次是在状态改动之前起的，
    // 合并进来等于把旧结论当新结论（#62 实测：注册成功后菜单不消失、直到重启才对）。
    if (inflight !== null) {
      if (!forced) return inflight
      await inflight
    }
    // classify() 是同步的：任务在微任务里就结束，闩锁必须在微任务里解，否则后续每次刷新
    // 都会拿到第一次那个已兑现的 Promise（#62：状态永远停在启动那一次的判定）。
    const task: Promise<RegisterState> = (async () => {
      const next = classify()
      lastAt = now()
      const changed = next.kind !== cached.kind || next.resolved !== cached.resolved
      cached = next
        if (changed) options.log.info(`注册状态：${describeRegisterState(next)}`)
      return cached
    })()
    inflight = task
    const release = (): void => {
      if (inflight === task) inflight = null
    }
    void task.then(release, release)
    return task
  }

  /**
   * fs 级快探测：直接问系统入口当前指向谁（微秒级，不 spawn）。菜单保鲜必须便宜，
   * 否则只能靠 30s TTL 的旧结论，菜单里长期是打开那一刻之前的真相（#62）。
   * Windows 的用户 PATH 在注册表里（要 spawn reg），这里返回 null 交给慢路径。
   */
  function cheapState(): RegisterState | null {
    if (platform === 'win32') return null
    const home = options.home ?? env.HOME ?? ''
    const target = platform === 'darwin' ? REGISTER_TARGET : home === '' ? null : linuxRegistrationTarget(home)
    if (target === null) return null
    const linked = readlink(target)
    if (linked === null) return null
    const shimReady = ensureShim().verdict !== 'absent' && exists(shimPath)
    const raw = samePath(linked, shimPath, platform) ? shimPath : (realpath(linked) ?? linked)
    const resolved = realpath(raw) ?? raw
    const kind = classifyResolution({
      shimPath: realpath(shimPath) ?? shimPath,
      shimReady,
      resolved,
      platform,
    })
    return { kind, resolved, shimReady, at: now() }
  }

  /** 保鲜轮询：快探测判出变化就落缓存并打日志；没变化只续 TTL，不打扰菜单。 */
  function poll(): RegisterState {
    const next = cheapState()
    if (next === null) return cached
    lastAt = now()
    const changed = next.kind !== cached.kind || next.resolved !== cached.resolved
    if (!changed) return cached
    cached = next
      options.log.info(`注册状态：${describeRegisterState(cached)}`)
    return cached
  }

  async function register(registerOptions: { force?: boolean } = {}): Promise<RegisterResult> {
    const shim = ensureShim()
    if (shim.verdict === 'absent') {
      return { ok: false, code: 'error', message: `shim 没写成功：${shimPath}` }
    }
    if (platform === 'linux') {
      const home = options.home ?? env.HOME ?? ''
      if (home === '') return { ok: false, code: 'error', message: '拿不到用户主目录（$HOME 为空），注册不了' }
      const target = linuxRegistrationTarget(home)
      const script = linuxRegistrationScript({ shim: shimPath, home, force: registerOptions.force === true })
      const out = run(['/bin/sh', '-c', script], { timeoutMs: 30_000 })
      void refresh({ force: true })
      if (out.status === 0) return { ok: true, message: `已注册：${target} → ${shimPath}` }
      if (out.stderr.includes(CONFLICT_MARKER)) {
        return {
          ok: false,
          code: 'conflict',
          message: `${target} 已存在且不是本壳入口——再点一次会强制覆盖（原来的会带时间戳备份）`,
        }
      }
      return { ok: false, code: 'error', message: `注册脚本执行失败：${out.stderr.trim() || `exit ${String(out.status)}`}` }
    }
    if (platform === 'win32') {
      const shimDir = dirname(shimPath)
      const query = run(['reg', 'query', 'HKCU\\Environment', '/v', 'Path'], { timeoutMs: 15_000 })
      if (query.status !== 0) {
        return { ok: false, code: 'error', message: `读取用户 PATH 失败：${query.stderr.trim() || `exit ${String(query.status)}`}` }
      }
      const parsed = parseWindowsPathRegQuery(query.stdout)
      if (parsed === null) return { ok: false, code: 'error', message: '用户 PATH 注册表值解析失败（HKCU\\Environment\\Path）' }
      const entries = windowsUserPathEntries(parsed.raw)
      if (!windowsPathHasEntry(entries, shimDir)) {
        const script = windowsPathWriteScript(
          windowsUserPathWrite(entries, shimDir, registerOptions.force === true),
          parsed.type,
        )
        const out = run(
          ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
          { timeoutMs: 30_000 },
        )
        if (out.status !== 0) {
          return { ok: false, code: 'error', message: `写入用户 PATH 失败：${out.stderr.trim() || `exit ${String(out.status)}`}` }
        }
      }
      // 写回成功即乐观置「已注册」：注册项立刻从托盘消失。不在返回前 force refresh 立即重测——
      // 探测链任何一环在会话内读不到刚写进注册表的值（#62 实测：托盘不更新、重启才对），
      // 都会把菜单打回「未注册」；30s TTL 过后的下一次刷新如实重测，以注册表为准。
      cached = { kind: 'registered', resolved: shimPath, shimReady: true, at: now() }
      lastAt = now()
        options.log.info('注册状态：已注册（用户 PATH 写回成功，乐观置位）')
      return { ok: true, message: `已把 ${shimDir} 加进用户 PATH——已开的终端不会热更新，新开终端生效` }
    }
    if (platform !== 'darwin') {
      return {
        ok: false,
        code: 'unsupported',
        message: `这个平台还没接注册执行（${platform}）：shim 在 ${shimPath}，可手动加进 PATH`,
      }
    }
    const script = registrationScript({ shim: shimPath, force: registerOptions.force === true })
    const out = run(
      ['/usr/bin/osascript', '-e', `do shell script "${appleEscape(script)}" with administrator privileges`],
      { timeoutMs: 120_000 },
    )
    void refresh({ force: true })
    if (out.status === 0) {
      return { ok: true, message: `已注册：/usr/local/bin/dsh → ${shimPath}` }
    }
    const stderr = out.stderr
    if (stderr.includes('-128') || stderr.includes('User canceled') || stderr.includes('用户已取消')) {
      return { ok: false, code: 'canceled', message: '你取消了系统授权，没有改动' }
    }
    if (stderr.includes(CONFLICT_MARKER)) {
      return {
        ok: false,
        code: 'conflict',
        message: '/usr/local/bin/dsh 已存在且不是本壳入口——再点一次会强制覆盖（原来的会带时间戳备份）',
      }
    }
    return { ok: false, code: 'error', message: `提权执行失败：${stderr.trim() || `exit ${String(out.status)}`}` }
  }

  return {
    cached: () => cached,
    refresh,
    ensureShim,
    register,
    describe: () => describeRegisterState(cached),
    poll,
  }
}

const defaultRun: RunImpl = (argv, runOptions = {}) => {
  const result = Bun.spawnSync({
    cmd: argv,
    env: { ...process.env, ...(runOptions.env ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: runOptions.timeoutMs ?? DETECT_TIMEOUT_MS,
  })
  return {
    status: result.exitCode ?? 124,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  }
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function defaultWriteText(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, mode)
}

function defaultExists(path: string): boolean {
  return existsSync(path)
}

function defaultRealpath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** 读符号链接（follow）——快探测专用；路径不存在或不是链接时回 null。 */
function defaultReadlink(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}
