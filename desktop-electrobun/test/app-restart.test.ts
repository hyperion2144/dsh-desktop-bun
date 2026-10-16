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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  awaitParentExit,
  planRelaunch,
  relaunchDesktopApp,
  relaunchParentPid,
  RELAUNCH_PID_ENV,
  RELAUNCH_WAIT_DEADLINE_MS,
} from '../src/bun/app-restart.ts'
import { acquireInstance, type InstanceRecord } from '../src/bun/single-instance.ts'

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
  test('成功时把旧 pid 经 env 传给新实例（它得知道自己要接班）', async () => {
    let seen: { exe: string; env: Record<string, string> } | null = null
    const plan = await relaunchDesktopApp({
      isPackaged: true,
      launcherExe: '/Applications/X.app/Contents/MacOS/launcher',
      pid: 4242,
      env: { PATH: '/usr/bin' },
      spawn: (exe, env) => {
        seen = { exe, env }
      },
    })
    expect(plan.ok).toBe(true)
    expect(seen).not.toBeNull()
    const got = seen as unknown as { exe: string; env: Record<string, string> }
    expect(got.exe).toBe('/Applications/X.app/Contents/MacOS/launcher')
    expect(got.env[RELAUNCH_PID_ENV]).toBe('4242')
    expect(got.env.PATH).toBe('/usr/bin')
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
