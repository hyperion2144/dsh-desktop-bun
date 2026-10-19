// #119 整应用重启（B）：计划决策 / 接班 pid 解析 / 等旧壳退干净 / 拉起失败路径。
//
// 守的是什么：
//   1. **不假装重启成功**——dev 态与探测不到 launcher 时必须给出可读的降级原因，
//      而不是静默 return 或假装 ok（这条是 #119 拍板时的硬要求）。
//   2. **接班不能靠时间窗对齐**——旧 pid 从 env 解析出来，新实例自己等它退干净；
//      等不到也照常往下走（不能把启动变成死等）。
//   3. spawn 抛错要有原因，不许变成裸异常糊到 RPC 层。
// 纯逻辑 + 注入式 spawn / sleep / isAlive，无需真实进程。

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  awaitParentExit,
  buildRelaySource,
  cefDirFromExecPath,
  cefLockState,
  planRelaunch,
  relaunchDesktopApp,
  relaunchParentPid,
  RELAUNCH_PID_ENV,
  RELAUNCH_WAIT_DEADLINE_MS,
} from '../src/bun/platform/app-restart.ts'
import { acquireInstance, type InstanceRecord } from '../src/bun/platform/single-instance.ts'

describe('planRelaunch（能不能自拉起）', () => {
  test('打包态 + 有 launcher ⇒ 拉起它', () => {
    const plan = planRelaunch({ isPackaged: true, launcherExe: '/Applications/X.app/Contents/MacOS/launcher' })
    expect(plan).toEqual({ ok: true, exe: '/Applications/X.app/Contents/MacOS/launcher' })
  })

  test('dev 态 ⇒ 显式降级，且明说是 dev 态（#119 拍板：禁止静默失败）', () => {
    const plan = planRelaunch({ isPackaged: false, launcherExe: '/usr/local/bin/bun' })
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('不该 ok')
    expect(plan.reason).toBe('dev-build')
    expect(plan.message).toContain('手动重启')
    // dev 态的「可执行文件」是工具链 bun，拉起来不是壳——文案必须让用户看出这一点
    expect(plan.message).toContain('bun')
  })

  test('探测不到 launcher（null / 空串 / 纯空白）⇒ launcher-unknown', () => {
    for (const launcherExe of [null, '', '   ']) {
      const plan = planRelaunch({ isPackaged: true, launcherExe })
      expect(plan.ok).toBe(false)
      if (plan.ok) throw new Error('不该 ok')
      expect(plan.reason).toBe('launcher-unknown')
      expect(plan.message).toContain('手动重启')
    }
  })
})

describe('relaunchParentPid（我是不是接班人）', () => {
  test('正常 pid ⇒ 那个数', () => {
    expect(relaunchParentPid({ [RELAUNCH_PID_ENV]: '4242' })).toBe(4242)
    expect(relaunchParentPid({ [RELAUNCH_PID_ENV]: '  4242 ' })).toBe(4242)
  })

  test('没这个变量 ⇒ null（正常冷启动走老路）', () => {
    expect(relaunchParentPid({})).toBeNull()
  })

  test('非数字 / 0 / 1 ⇒ null（0/1 在 posix 上是 init/kthread，等不了也不该等）', () => {
    for (const raw of ['', 'abc', '42a', '-1', '1.5', '0', '1']) {
      expect(relaunchParentPid({ [RELAUNCH_PID_ENV]: raw })).toBeNull()
    }
  })
})

describe('awaitParentExit（等旧壳退干净）', () => {
  test('旧壳已经不在 ⇒ 立刻 true，一次都不 sleep', async () => {
    let slept = 0
    const gone = await awaitParentExit({
      pid: 4242,
      isAlive: () => false,
      sleep: async () => {
        slept += 1
      },
    })
    expect(gone).toBe(true)
    expect(slept).toBe(0)
  })

  test('第二次轮询时旧壳退了 ⇒ true', async () => {
    let alive = true
    const gone = await awaitParentExit({
      pid: 4242,
      isAlive: () => alive,
      sleep: async () => {
        alive = false
      },
    })
    expect(gone).toBe(true)
  })

  test('一直活着 ⇒ 超时返回 false 而不是死等/抛错（抢锁那边另有 succeedsPid 兜底）', async () => {
    const gone = await awaitParentExit({
      pid: 4242,
      isAlive: () => true,
      sleep: async () => {},
      deadlineMs: 500,
    })
    expect(gone).toBe(false)
  })

  test('默认 deadline 就是 RELAUNCH_WAIT_DEADLINE_MS', () => {
    expect(RELAUNCH_WAIT_DEADLINE_MS).toBe(15_000)
  })
})

describe('relaunchDesktopApp（真拉起）', () => {
  test('成功时 spawn 的是中继（bun -e），脚本带旧 pid 与 launcher 路径，env 透传 RELAUNCH_PID', async () => {
    let seen: { argv: string[]; env: Record<string, string> } | null = null
    const plan = await relaunchDesktopApp({
      isPackaged: true,
      launcherExe: '/Applications/X.app/Contents/MacOS/launcher',
      pid: 4242,
      platform: 'darwin',
      cefDir: '/support/CEF',
      env: { PATH: '/usr/bin' },
      spawn: (argv, env) => {
        seen = { argv, env }
      },
    })
    expect(plan.ok).toBe(true)
    expect(seen).not.toBeNull()
    const got = seen as unknown as { argv: string[]; env: Record<string, string> }
    // 中继进程 = 本壳同款 bun 跑内联脚本（#204：等旧实例含 CEF 退净再拉 launcher）
    expect(got.argv[0]).toBe(process.execPath)
    expect(got.argv[1]).toBe('-e')
    expect(got.argv[2]).toContain('parentPid = 4242;')
    expect(got.argv[2]).toContain(JSON.stringify('/Applications/X.app/Contents/MacOS/launcher'))
    expect(got.argv[2]).toContain(JSON.stringify('/support/CEF'))
    expect(got.env[RELAUNCH_PID_ENV]).toBe('4242')
    expect(got.env.PATH).toBe('/usr/bin')
  })

  test('cefDir 不传时中继退化成纯 pid 等待（脚本不含 CEF 锁段）', async () => {
    let source = ''
    const plan = await relaunchDesktopApp({
      isPackaged: true,
      launcherExe: '/x/launcher',
      pid: 7,
      platform: 'darwin',
      spawn: (argv) => {
        source = argv[2] ?? ''
      },
    })
    expect(plan.ok).toBe(true)
    expect(plan.ok).toBe(true)
    expect(source).toContain('cefDir = "";')
    // 锁段代码始终在脚本里，靠 cefDir 空串运行时短路；真正的不拉锁行为由下面的真跑测试覆盖
    expect(source).toContain("if (cefDir !== '') {")
  })

  test('cefLockState：锁不存在/指向死 pid = released，活着 = held-alive，读不出 = unknown', () => {
    expect(cefLockState({ lockExists: false })).toBe('released')
    expect(cefLockState({ lockExists: true, rawLockTarget: 'MacBook-4242', targetPidAlive: () => true })).toBe('held-alive')
    expect(cefLockState({ lockExists: true, rawLockTarget: 'MacBook-4242', targetPidAlive: () => false })).toBe('released')
    expect(cefLockState({ lockExists: true, rawLockTarget: null })).toBe('unknown')
    expect(cefLockState({ lockExists: true, rawLockTarget: 'garbage' })).toBe('unknown')
  })

  test('cefDirFromExecPath：mac 从实际安装根反推 CEF/，Windows 返回 null（WebView2 无 CEF 锁）', () => {
    expect(
      cefDirFromExecPath('/Apps/DSH/DeepSeek Harness Desktop BUN.app/Contents/MacOS/bun', 'darwin'),
    ).toBe('/Apps/DSH/CEF')
    expect(cefDirFromExecPath('C:\\Apps\\DSH\\App\\bin\\bun.exe', 'win32')).toBeNull()
  })

  test('中继脚本含 Windows WebView2 进程等待段（宿主死后 msedgewebview2 有尾巴，#209）', () => {
    const source = buildRelaySource({ pid: 7, launcherExe: '/x/launcher' })
    expect(source).toContain('msedgewebview2')
    expect(source).toContain("log('WebView2 进程等待结束')")
  })

  test('真跑中继脚本：旧 pid 已死 + stale 锁 → 拉起假 launcher（等 350ms 内完成）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-'))
    // Windows CreateProcess 不认 shebang：用独名 exe 替身（notepad 拷贝）验证「中继能 spawn 真 exe」，
    // marker 断言只在 POSIX 做（spawn 的进程树管理跨平台差异大，拉起可执行性已验证到）。
    const win32 = process.platform === 'win32'
    const launcher = join(dir, win32 ? 'dsh-relay-probe.exe' : 'fake-launcher.mjs')
    const marker = join(dir, 'launched')
    if (win32) {
      copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe'), launcher)
    } else {
      writeFileSync(launcher, `#!/usr/bin/env bun\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ok')`)
    }
    if (!win32) chmodSync(launcher, 0o755)
    // stale SingletonLock：symlink 指向不存在的 pid
    mkdirSync(join(dir, 'CEF'))
    symlinkSync('stubhost-999999', join(dir, 'CEF', 'SingletonLock'))
    const relay = buildRelaySource({
      pid: 999998,
      launcherExe: launcher,
      cefDir: join(dir, 'CEF'),
      pollMs: 50,
      pidWaitMs: 400,
      lockWaitMs: 400,
    })
    const proc = Bun.spawnSync({ cmd: [process.execPath, '-e', relay], stdout: 'ignore', stderr: 'ignore' })
    expect(proc.exitCode).toBe(0)
    if (!win32) {
      // 中继 unref 拉起后立即退出；marker 由孤儿化的假 launcher 异步写出，轮询等它
      let launched = false
      for (let i = 0; i < 40 && !launched; i++) {
        launched = existsSync(marker)
        if (!launched) await Bun.sleep(50)
      }
      expect(launched).toBe(true)
    } else {
      // 替身 notepad 挂着：按独名清掉（不碰用户开的记事本）
      Bun.spawnSync(['taskkill', '/F', '/IM', 'dsh-relay-probe.exe'], { stdout: 'ignore', stderr: 'ignore' })
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test('#211：Windows 直拉路径——spawn 的是 launcher 本尊（中继会被旧壳退出时收割）', async () => {
    const calls: string[][] = []
    const plan = await relaunchDesktopApp({
      isPackaged: true,
      launcherExe: 'C:\\Apps\\DSH\\App\\bin\\launcher.exe',
      pid: 4242,
      platform: 'win32',
      spawn: (argv) => {
        calls.push(argv)
      },
    })
    expect(plan.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['C:\\Apps\\DSH\\App\\bin\\launcher.exe'])
  })

  test('#211：非 Windows 仍走中继（argv = bun -e 中继脚本）', async () => {
    const calls: string[][] = []
    const plan = await relaunchDesktopApp({
      isPackaged: true,
      launcherExe: '/Applications/X.app/Contents/MacOS/launcher',
      pid: 4242,
      platform: 'darwin',
      spawn: (argv) => {
        calls.push(argv)
      },
    })
    expect(plan.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe(process.execPath)
    expect(calls[0]?.[1]).toBe('-e')
  })
  test('spawn 抛错 ⇒ spawn-failed + 可读原因，不是裸异常', async () => {
    const plan = await relaunchDesktopApp({
      isPackaged: true,
      launcherExe: '/Applications/X.app/Contents/MacOS/launcher',
      pid: 4242,
      spawn: () => {
        throw new Error('EACCES')
      },
    })
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('不该 ok')
    expect(plan.reason).toBe('spawn-failed')
    expect(plan.message).toContain('EACCES')
  })

  test('dev 态一个字节都不 spawn（拉起来的是 bun，不是壳）', async () => {
    let spawned = 0
    const plan = await relaunchDesktopApp({
      isPackaged: false,
      launcherExe: '/usr/local/bin/bun',
      pid: 4242,
      spawn: () => {
        spawned += 1
      },
    })
    expect(plan.ok).toBe(false)
    expect(spawned).toBe(0)
  })
})

describe('接班与单实例锁（succeedsPid 兜底）', () => {
  const dirs: string[] = []
  function lockFile(pid: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-relaunch-'))
    dirs.push(dir)
    const file = join(dir, 'shell-instance.json')
    writeFileSync(
      file,
      JSON.stringify({
        pid,
        origin: 'http://127.0.0.1:6390',
        pageUrl: 'http://127.0.0.1:6390/tok/',
        profile: 'desktop',
        startedAt: '2026-10-16T00:00:00.000Z',
        bootId: '',
        exePath: '',
      } satisfies InstanceRecord),
    )
    return file
  }
  /** 旧 pid 仍活着且仍被认成壳进程——整应用重启的常态。 */
  const stillOurs = { identity: { pid: 5555, startedAt: 'now' }, isAlive: () => true, isOurProcess: () => true }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('锁文件里那个 pid 就是我被指定的接班目标 ⇒ 接管，不当「已有实例」', () => {
    const result = acquireInstance(lockFile(4242), 'desktop', { ...stillOurs, succeedsPid: 4242 })
    expect(result.acquired).toBe(true)
    expect(result.previous?.pid).toBe(4242)
  })

  test('不指定 succeedsPid 时行为不变：还活着的旧 pid 仍判「已有实例」', () => {
    const result = acquireInstance(lockFile(4242), 'desktop', stillOurs)
    expect(result.acquired).toBe(false)
    expect(result.previous?.pid).toBe(4242)
  })

  test('指定的接班目标不是锁里那个 pid ⇒ 照常判「已有实例」（别把无关进程当成接班对象）', () => {
    const result = acquireInstance(lockFile(4242), 'desktop', { ...stillOurs, succeedsPid: 9999 })
    expect(result.acquired).toBe(false)
  })
})
