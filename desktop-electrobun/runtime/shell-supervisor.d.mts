// #237 监督进程（runtime/shell-supervisor.mjs）的类型面：本体是明文 .mjs（bun 直跑），
// 这份声明只给 tsc / 测试用——让 test/restart-supervisor.test.ts 的注入回调拿到上下文类型。
export declare const SUPERVISOR_CONFIG_ENV: string

export declare type SupervisorRunConfig = {
  launcherExe: string
  desktopPid: number
  appSupport: string
  logFile: string
  bootId: string
  pidWaitMs?: number
  lockWaitMs?: number
  tailWaitMs?: number
  nextWaitMs?: number
  pollMs?: number
}

export declare type SupervisorTailTarget = { kind: 'pattern'; pattern: string } | { kind: 'webview2' }

export declare type SupervisorSpawnSyncResult = { exitCode?: number | null; stdout?: unknown }

export declare type SupervisorRunDeps = {
  isAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  spawnSync?: (argv: string[]) => SupervisorSpawnSyncResult
  spawnLauncher?: (previousPid: number) => number | null
  readPid?: () => number | null
  waitPidExit?: (pid: number) => Promise<boolean>
  waitCefLock?: () => Promise<void>
  reapTails?: () => Promise<void>
}

export declare function parseSupervisorConfig(env?: Record<string, string | undefined>): SupervisorRunConfig | null
export declare function defaultIsAlive(pid: number): boolean
export declare function relayLog(logFile: string, message: string): void
export declare function cefLockReleased(
  cefDir: string,
  isAlive?: (pid: number) => boolean,
  platform?: string,
): boolean
export declare function buildTailTarget(input?: { platform?: string; launcherExe?: string }): SupervisorTailTarget | null
export declare function buildTailProbeArgv(target: SupervisorTailTarget | null): string[] | null
export declare function buildTailKillArgv(target: SupervisorTailTarget | null, signal?: string): string[] | null
export declare function tailStillAlive(
  result: SupervisorSpawnSyncResult | null | undefined,
  target: SupervisorTailTarget | null,
): boolean
export declare function readInstancePid(file: string): number | null
export declare function awaitNextDesktop(input: {
  file: string
  previousPid: number
  isAlive?: (pid: number) => boolean
  readPid?: () => number | null
  sleep?: (ms: number) => Promise<void>
  deadlineMs: number
  pollMs?: number
}): Promise<number | null>
export declare function runSupervisor(config: SupervisorRunConfig, deps?: SupervisorRunDeps): Promise<void>
export declare function reapRendererTails(
  config: SupervisorRunConfig,
  deps: {
    sleep: (ms: number) => Promise<void>
    log: (message: string) => void
    spawnSync: (argv: string[]) => SupervisorSpawnSyncResult
    platform?: string
  },
): Promise<void>
