// 防休眠与通知口（缝 ② 纯逻辑 + 真 HTTP/真进程）。
//
// 守的是旧壳 `power/mod.rs` + `network/notify.rs` 的语义（#186 用户拍板口径）：
//   只挡系统空闲休眠；「会话在跑」由宿主插件的 busy-state 上报决定，等审批/等回答不算；
//   心跳超时**不释放**（误释放比多持更糟）——这些是行为契约，不是实现细节。
// 平台断言用注入的假 spawn 断言调用形状；macOS 上另有一例真 `caffeinate` 落地验证。

import { describe, expect, test } from 'bun:test'
import {
  ASSERTION_NAME,
  createKeepAwake,
  ES_CONTINUOUS,
  ES_SYSTEM_REQUIRED,
  LINUX_NO_BACKEND_REASON,
  linuxInhibitBackends,
  linuxInhibitCommand,
  syncPreventSleep,
  TICK_MS,
  watchdogScript,
  type AwakeChild,
  type KeepAwake,
} from '../src/bun/notify/keep-awake.ts'
import {
  bearerToken,
  classifyNotify,
  MAX_NOTIFY_BYTES,
  startNotifyServer,
} from '../src/bun/net/notify-server.ts'
import { buildChildEnv } from '../src/shared/app/child-env.ts'
import {
  type Arbiter,
  BUSY_HEARTBEAT_MS,
  createArbiter,
  LEASE_STALE_MS,
  normalizeProfileName,
  parseBusyReport,
  UNKNOWN_PROFILE,
} from '../src/shared/app/power-arbiter.ts'

describe('power-arbiter（纯裁决）', () => {
  test('缺省开关为开；没有忙实例就不持有', () => {
    const arbiter = createArbiter()
    expect(arbiter.isEnabled()).toBe(true)
    expect(arbiter.shouldHold()).toBe(false)
    expect(arbiter.profiles()).toEqual([])
  })

  test('开关关掉时，忙实例再多也不持有（用户拍板：设置优先）', () => {
    const arbiter = createArbiter({ enabled: false })
    arbiter.setBusy('desktop', true, 1_000)
    expect(arbiter.profiles()).toEqual(['desktop'])
    expect(arbiter.shouldHold()).toBe(false)
    arbiter.setEnabled(true)
    expect(arbiter.shouldHold()).toBe(true)
  })

  test('setBusy 只在租约集合真的变化时返回 true（日志据此去重）', () => {
    const arbiter = createArbiter()
    expect(arbiter.setBusy('desktop', true, 1_000)).toBe(true)
    expect(arbiter.setBusy('desktop', true, 11_000)).toBe(false)
    expect(arbiter.setBusy('desktop', false, 12_000)).toBe(true)
    expect(arbiter.setBusy('desktop', false, 13_000)).toBe(false)
    expect(arbiter.shouldHold()).toBe(false)
  })

  test('多 profile：任一在跑就持有；forget 摘掉单个', () => {
    const arbiter = createArbiter()
    arbiter.setBusy('desktop', true, 1_000)
    arbiter.setBusy('web', true, 1_000)
    expect(arbiter.profiles()).toEqual(['desktop', 'web'])
    expect(arbiter.forget('desktop')).toBe(true)
    expect(arbiter.shouldHold()).toBe(true)
    expect(arbiter.forget('desktop')).toBe(false)
    arbiter.clear()
    expect(arbiter.shouldHold()).toBe(false)
  })

  test('缺 profile 名落到 UNKNOWN_PROFILE（旧壳同义）', () => {
    expect(normalizeProfileName(undefined)).toBe(UNKNOWN_PROFILE)
    expect(normalizeProfileName('   ')).toBe(UNKNOWN_PROFILE)
    expect(normalizeProfileName(' desktop ')).toBe('desktop')
    const arbiter = createArbiter()
    arbiter.setBusy('', true, 1_000)
    expect(arbiter.profiles()).toEqual([UNKNOWN_PROFILE])
  })

  test('心跳刷新租约；陈旧只诊断、不释放（#185 补充第 6 条）', () => {
    const arbiter = createArbiter()
    arbiter.setBusy('desktop', true, 1_000)
    // 心跳 10s 一次，60s 内不算陈旧
    arbiter.setBusy('desktop', true, 1_000 + BUSY_HEARTBEAT_MS)
    expect(arbiter.stale(1_000 + LEASE_STALE_MS)).toEqual([])
    // 边界取严：恰好 60s 就算陈旧
    expect(arbiter.stale(1_000 + BUSY_HEARTBEAT_MS + LEASE_STALE_MS)).toEqual(['desktop'])
    // 陈旧归陈旧，裁决不变
    expect(arbiter.shouldHold()).toBe(true)
  })
})

describe('busy-state 载荷解析', () => {
  test('只认 { type: "busy-state", busy: boolean }', () => {
    expect(parseBusyReport({ type: 'busy-state', profile: 'desktop', busy: true })).toEqual({
      profile: 'desktop',
      busy: true,
    })
    expect(parseBusyReport({ type: 'busy-state', busy: false })).toEqual({
      profile: UNKNOWN_PROFILE,
      busy: false,
    })
    expect(parseBusyReport({ type: 'busy-state' })).toBeNull()
    expect(parseBusyReport({ type: 'busy-state', busy: 'yes' })).toBeNull()
    expect(parseBusyReport({ type: 'task-complete', body: 'x' })).toBeNull()
    expect(parseBusyReport(null)).toBeNull()
    expect(parseBusyReport(['busy-state'])).toBeNull()
  })

  test('classifyNotify 把忙状态与通知分开（通知轮次接后者）', () => {
    expect(classifyNotify({ type: 'busy-state', profile: 'web', busy: true })).toEqual({
      kind: 'busy',
      profile: 'web',
      busy: true,
    })
    expect(classifyNotify({ type: 'task-complete', body: '任务已完成' })).toEqual({
      kind: 'notify',
      payload: { type: 'task-complete', body: '任务已完成' },
    })
    expect(classifyNotify({ type: 'dsh-approval' })).toEqual({
      kind: 'notify',
      payload: { type: 'dsh-approval', body: '' },
    })
    expect(classifyNotify({ type: 'nope' })).toEqual({ kind: 'unknown' })
    expect(classifyNotify('busy-state')).toEqual({ kind: 'unknown' })
  })

  test('Authorization 解析容忍大小写与空格，但只要 Bearer', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('bearer   abc  ')).toBe('abc')
    expect(bearerToken('Basic abc')).toBe('')
    expect(bearerToken(null)).toBe('')
  })
})

describe('通知口（真 HTTP，缝 ①）', () => {
  test('令牌闸门：无 token 401、坏 token 401、方法不符 405、路径不符 404、坏 JSON 400', async () => {
    const seen: string[] = []
    const server = startNotifyServer({ onBusy: (profile, busy) => seen.push(`${profile}:${String(busy)}`) })
    const url = `${server.origin}/notify`
    try {
      expect((await fetch(url, { method: 'POST' })).status).toBe(401)
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers: { authorization: 'Bearer wrong' },
            body: '{}',
          })
        ).status,
      ).toBe(401)
      expect(
        (
          await fetch(url, {
            method: 'GET',
            headers: { authorization: `Bearer ${server.token}` },
          })
        ).status,
      ).toBe(405)
      expect((await fetch(`${server.origin}/other`)).status).toBe(404)
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${server.token}` },
            body: '{oops',
          })
        ).status,
      ).toBe(400)
    } finally {
      server.stop()
    }
    expect(seen).toEqual([])
  })

  test('合法忙状态上报：204 且回调拿到 profile/busy；通知类走另一条回调', async () => {
    const busy: string[] = []
    const notes: string[] = []
    const server = startNotifyServer({
      onBusy: (profile, isBusy) => busy.push(`${profile}:${String(isBusy)}`),
      onNotify: (payload) => notes.push(`${payload.type}:${payload.body}`),
    })
    const post = (body: unknown): Promise<Response> =>
      fetch(`${server.origin}/notify`, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    try {
      expect((await post({ type: 'busy-state', profile: 'desktop', busy: true })).status).toBe(204)
      expect((await post({ type: 'busy-state', profile: 'desktop', busy: false })).status).toBe(204)
      expect((await post({ type: 'task-complete', body: '任务已完成' })).status).toBe(204)
      expect((await post({ type: 'unknown-type' })).status).toBe(204)
    } finally {
      server.stop()
    }
    expect(busy).toEqual(['desktop:true', 'desktop:false'])
    expect(notes).toEqual(['task-complete:任务已完成'])
  })

  test('载荷上限 64 KiB（超了 413，不打爆壳）', async () => {
    const server = startNotifyServer({})
    try {
      const huge = 'x'.repeat(MAX_NOTIFY_BYTES + 1)
      const response = await fetch(`${server.origin}/notify`, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'task-complete', body: huge }),
      })
      expect(response.status).toBe(413)
    } finally {
      server.stop()
    }
  })
})

describe('keep-awake（平台断言，注入假 spawn）', () => {
  interface FakeChild {
    pid: number
    killed: boolean
    /** 带 exited 的假子进程（withExited）：用例 resolve 它来演「起来就秒退」。 */
    exited?: Promise<number>
  }

  /**
   * 假 spawn：默认子进程一直活着；`withExited` 时每个子进程带一个用例可控的 exited promise
   * （`exit(code)` 按启动顺序 resolve 最早那个），用来验秒退认账。
   */
  function fakeAwake(withExited = false): {
    spawns: string[][]
    children: FakeChild[]
    spawnCommand: (command: string[]) => AwakeChild
    exit: (code: number) => void
  } {
    const spawns: string[][] = []
    const children: FakeChild[] = []
    const pending: Array<(code: number) => void> = []
    return {
      spawns,
      children,
      exit: (code: number) => {
        pending.shift()?.(code)
      },
      spawnCommand: (command: string[]) => {
        spawns.push(command)
        const child: FakeChild = { pid: 4_000 + spawns.length, killed: false }
        children.push(child)
        const kill = (): void => void (child.killed = true)
        if (!withExited) return { pid: child.pid, kill }
        const exited = new Promise<number>((resolve) => {
          pending.push(resolve)
        })
        child.exited = exited
        return { pid: child.pid, kill, exited }
      },
    }
  }

  /** 假 KeepAwake：syncPreventSleep 只碰 start/stop，这里就把这一面记下来。 */
  function fakeKeep(arbiter: Arbiter): { calls: string[]; keepAwake: KeepAwake } {
    const calls: string[] = []
    return {
      calls,
      keepAwake: {
        arbiter,
        start: (): void => void calls.push('start'),
        stop: (): void => void calls.push('stop'),
        tick: (): boolean => false,
        isHolding: (): boolean => false,
        capability: () => ({ platform: 'linux', backend: null, available: false, reason: null }),
      },
    }
  }

  describe('syncPreventSleep（#186/#75：prevent_sleep 运行期可改，saveSettings 是唯一写路径）', () => {
    test('同值不动：已开再传开，start/stop 都不被调（无关保存不 churn）', () => {
      const arbiter = createArbiter()
      const { calls, keepAwake } = fakeKeep(arbiter)
      syncPreventSleep(true, { arbiter, keepAwake })
      expect(arbiter.isEnabled()).toBe(true)
      expect(calls).toEqual([])
    })

    test('关→开：裁决器跟着开，tick 循环被拉起（start 一次、stop 不调）', () => {
      const arbiter = createArbiter({ enabled: false })
      const { calls, keepAwake } = fakeKeep(arbiter)
      syncPreventSleep(true, { arbiter, keepAwake })
      expect(arbiter.isEnabled()).toBe(true)
      expect(calls).toEqual(['start'])
    })

    test('开→关：裁决器关掉，持有中的断言被释放（stop 被调，持有进程被杀）', () => {
      const arbiter = createArbiter()
      const fake = fakeAwake()
      const awake = createKeepAwake({
        arbiter,
        platform: 'darwin',
        pid: 7,
        spawnCommand: fake.spawnCommand,
        setIntervalFn: () => 0,
        clearIntervalFn: () => {},
      })
      arbiter.setBusy('desktop', true, Date.now())
      expect(awake.tick()).toBe(true)
      expect(fake.children[0]?.killed).toBe(false)

      syncPreventSleep(false, { arbiter, keepAwake: awake })

      expect(arbiter.isEnabled()).toBe(false)
      expect(fake.children[0]?.killed).toBe(true)
      expect(awake.isHolding()).toBe(false)
    })

    test('真实链路（B8 验收路径）：启动时关 → 运行期开 → 忙起来真起断言', () => {
      const arbiter = createArbiter({ enabled: false })
      const fake = fakeAwake()
      const awake = createKeepAwake({
        arbiter,
        platform: 'darwin',
        pid: 7,
        spawnCommand: fake.spawnCommand,
        setIntervalFn: () => 0,
        clearIntervalFn: () => {},
      })
      // 启动时开关是关的：忙起来也不持有、不起进程
      arbiter.setBusy('desktop', true, Date.now())
      expect(awake.tick()).toBe(false)
      expect(fake.spawns).toHaveLength(0)

      // 面板保存（运行期开）→ 下一次裁决就该真起断言
      syncPreventSleep(true, { arbiter, keepAwake: awake })
      expect(awake.tick()).toBe(true)
      expect(fake.spawns).toHaveLength(1)
      awake.stop()
    })
  })

  test('macOS：忙了才起 caffeinate（-i -w 壳 pid），闲了杀掉，重复 tick 不重复起', () => {
    const logs: string[] = []
    const arbiter = createArbiter()
    const fake = fakeAwake()
    const awake = createKeepAwake({
      arbiter,
      platform: 'darwin',
      pid: 9_999,
      log: (line) => logs.push(line),
      spawnCommand: fake.spawnCommand,
    })

    expect(awake.tick()).toBe(false)
    expect(fake.spawns).toEqual([])

    arbiter.setBusy('desktop', true, Date.now())
    expect(awake.tick()).toBe(true)
    expect(awake.tick()).toBe(true)
    expect(fake.spawns).toEqual([['caffeinate', '-i', '-w', '9999']])
    expect(fake.children).toHaveLength(1)
    expect(fake.children[0]?.killed).toBe(false)

    arbiter.setBusy('desktop', false, Date.now())
    expect(awake.tick()).toBe(false)
    expect(fake.children[0]?.killed).toBe(true)
    expect(logs.some((line) => line.includes('释放断言'))).toBe(true)
    expect(logs.some((line) => line.includes('持有断言'))).toBe(true)
  })

  test('开关关掉时不起断言；打开后下一次 tick 生效', () => {
    const arbiter = createArbiter({ enabled: false })
    const fake = fakeAwake()
    const awake = createKeepAwake({ arbiter, platform: 'darwin', pid: 1, spawnCommand: fake.spawnCommand })
    arbiter.setBusy('desktop', true, Date.now())
    expect(awake.tick()).toBe(false)
    expect(fake.spawns).toEqual([])
    arbiter.setEnabled(true)
    expect(awake.tick()).toBe(true)
    expect(fake.spawns).toHaveLength(1)
    awake.stop()
    expect(fake.children[0]?.killed).toBe(true)
  })

  test('start 幂等（只挂一个定时器），stop 释放断言并停表', () => {
    const ticks: Array<() => void> = []
    let cleared = 0
    const arbiter = createArbiter()
    arbiter.setBusy('desktop', true, Date.now())
    const fake = fakeAwake()
    const awake = createKeepAwake({
      arbiter,
      platform: 'darwin',
      pid: 7,
      spawnCommand: fake.spawnCommand,
      setIntervalFn: (fn) => {
        ticks.push(fn)
        return ticks.length
      },
      clearIntervalFn: () => {
        cleared += 1
      },
    })
    awake.start()
    awake.start()
    expect(ticks).toHaveLength(1)
    expect(fake.spawns).toHaveLength(1)
    expect(TICK_MS).toBe(1_000)
    awake.stop()
    expect(cleared).toBe(1)
    expect(fake.children[0]?.killed).toBe(true)
  })

  test('Windows：注入的 SetThreadExecutionState 收到 ES_CONTINUOUS|ES_SYSTEM_REQUIRED，释放只留 ES_CONTINUOUS', () => {
    const flags: number[] = []
    const arbiter = createArbiter()
    const awake = createKeepAwake({
      arbiter,
      platform: 'win32',
      setThreadExecutionState: (value) => {
        flags.push(value)
        return true
      },
    })
    arbiter.setBusy('desktop', true, Date.now())
    expect(awake.tick()).toBe(true)
    arbiter.setBusy('desktop', false, Date.now())
    expect(awake.tick()).toBe(false)
    expect(flags).toEqual([ES_CONTINUOUS | ES_SYSTEM_REQUIRED, ES_CONTINUOUS])
  })

  test('Linux：systemd-inhibit 主通道——命令逐字、capability 上报、闲了释放', () => {
    const logs: string[] = []
    const arbiter = createArbiter()
    const fake = fakeAwake()
    const awake = createKeepAwake({
      arbiter,
      platform: 'linux',
      pid: 9_999,
      which: (command) => (command === 'systemd-inhibit' ? '/usr/bin/systemd-inhibit' : null),
      env: {},
      log: (line) => logs.push(line),
      spawnCommand: fake.spawnCommand,
    })

    expect(awake.tick()).toBe(false)
    expect(fake.spawns).toEqual([])

    arbiter.setBusy('desktop', true, Date.now())
    expect(awake.tick()).toBe(true)
    expect(awake.tick()).toBe(true)
    expect(fake.spawns).toEqual([
      ['systemd-inhibit', '--what=idle', '--mode=block', `--why=${ASSERTION_NAME}`, 'sh', '-c', watchdogScript(9_999)],
    ])
    expect(fake.children).toHaveLength(1)
    expect(fake.children[0]?.killed).toBe(false)
    expect(awake.capability()).toEqual({
      platform: 'linux',
      backend: 'systemd-inhibit',
      available: true,
      reason: null,
    })
    expect(logs.some((line) => line.includes('持有断言'))).toBe(true)

    arbiter.setBusy('desktop', false, Date.now())
    expect(awake.tick()).toBe(false)
    expect(fake.children[0]?.killed).toBe(true)
    expect(logs.some((line) => line.includes('释放断言'))).toBe(true)
  })

  // 这里只锁脚本逐字（两条孤儿腿都在）；SIGKILL / release 两腿的语义证据在
  // docs/adr/0002-linux-keep-awake-inhibit.md 的容器矩阵（dash + busybox ash），用例名不再暗示已跑过 SIGKILL 语义。
  test('Linux：持有命令带看门狗两腿（脚本逐字；语义证据见 ADR-0002 容器矩阵）', () => {
    expect(watchdogScript(4_242)).toBe(
      'while kill -0 4242 2>/dev/null; do [ "$PPID" -le 1 ] && exit 0; kill -0 "$PPID" 2>/dev/null || exit 0; sleep 2; done',
    )
    // 防回归：硬化腿（kill -0 "$PPID"）与收养腿都不许被删（dash/ash 下前者才是真判据）
    expect(watchdogScript(4_242)).toContain('kill -0 4242')
    expect(watchdogScript(4_242)).toContain('kill -0 "$PPID"')
    expect(watchdogScript(4_242)).toContain('[ "$PPID" -le 1 ] && exit 0')
    expect(linuxInhibitCommand('systemd-inhibit', 'why', 4_242).slice(-3)).toEqual([
      'sh',
      '-c',
      watchdogScript(4_242),
    ])
    expect(linuxInhibitCommand('gnome-session-inhibit', 'why', 4_242)).toEqual([
      'gnome-session-inhibit',
      '--inhibit=suspend',
      '--reason=why',
      'sh',
      '-c',
      watchdogScript(4_242),
    ])
  })

  test('Linux：GNOME 会话首选 gnome-session-inhibit（--inhibit=suspend，屏幕该熄照熄）', () => {
    const logs: string[] = []
    const arbiter = createArbiter()
    const fake = fakeAwake()
    const which = (command: string): string | null => `/usr/bin/${command}`
    // GNOME：gnome-session 在前（gsd-power 自动挂起前读的是它的 InhibitedActions）
    expect(linuxInhibitBackends(which, { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toEqual([
      'gnome-session-inhibit',
      'systemd-inhibit',
    ])
    // 会话判定大小写不敏感（真实环境里有 `GNOME` / `gnome` / `ubuntu:GNOME` 各种写法）
    expect(linuxInhibitBackends(which, { DESKTOP_SESSION: 'gnome' })).toEqual([
      'gnome-session-inhibit',
      'systemd-inhibit',
    ])

    const awake = createKeepAwake({
      arbiter,
      platform: 'linux',
      pid: 8_888,
      which,
      env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' },
      log: (line) => logs.push(line),
      spawnCommand: fake.spawnCommand,
    })
    arbiter.setBusy('desktop', true, Date.now())
    expect(awake.tick()).toBe(true)
    expect(fake.spawns).toEqual([
      ['gnome-session-inhibit', '--inhibit=suspend', `--reason=${ASSERTION_NAME}`, 'sh', '-c', watchdogScript(8_888)],
    ])
    expect(awake.capability()).toEqual({
      platform: 'linux',
      backend: 'gnome-session-inhibit',
      available: true,
      reason: null,
    })

    arbiter.setBusy('desktop', false, Date.now())
    expect(awake.tick()).toBe(false)
    expect(fake.children[0]?.killed).toBe(true)
    expect(logs.some((line) => line.includes('释放断言'))).toBe(true)
  })

  test('Linux：两个通道都拿不到就认账（不假装持有、只落一条原因、capability 可见）', () => {
    const logs: string[] = []
    const arbiter = createArbiter()
    const fake = fakeAwake()
    const awake = createKeepAwake({
      arbiter,
      platform: 'linux',
      env: {},
      which: () => null,
      log: (line) => logs.push(line),
      spawnCommand: fake.spawnCommand,
    })
    arbiter.setBusy('desktop', true, Date.now())
    expect(awake.tick()).toBe(false)
    expect(awake.tick()).toBe(false)
    expect(fake.spawns).toEqual([])
    expect(awake.isHolding()).toBe(false)
    expect(logs.filter((line) => line.includes('拿不到防休眠通道'))).toHaveLength(1)
    expect(awake.capability()).toEqual({
      platform: 'linux',
      backend: null,
      available: false,
      reason: LINUX_NO_BACKEND_REASON,
    })
  })

  test('Linux：持有进程秒退就认账（剔除候选、报 exit、不再无限重生）', async () => {
    const logs: string[] = []
    const arbiter = createArbiter()
    const fake = fakeAwake(true)
    const awake = createKeepAwake({
      arbiter,
      platform: 'linux',
      pid: 1_234,
      which: (command) => (command === 'systemd-inhibit' ? '/usr/bin/systemd-inhibit' : null),
      env: {},
      log: (line) => logs.push(line),
      spawnCommand: fake.spawnCommand,
    })
    arbiter.setBusy('desktop', true, Date.now())
    expect(awake.tick()).toBe(true)
    expect(fake.spawns).toHaveLength(1)

    fake.exit(1)
    await Bun.sleep(1)

    const capability = awake.capability()
    expect(capability.available).toBe(false)
    expect(capability.backend).toBeNull()
    expect(capability.reason).toBe('systemd-inhibit 启动后立即退出（exit=1）')
    expect(logs).toContain(
      '[keepawake] Linux 拿不到防休眠通道：systemd-inhibit 启动后立即退出（exit=1）',
    )

    // 候选只减不增：不许每秒重生进程，原因也只落一条
    expect(awake.tick()).toBe(false)
    expect(awake.tick()).toBe(false)
    expect(fake.spawns).toHaveLength(1)
    expect(logs.filter((line) => line.includes('exit=1'))).toHaveLength(1)
  })

  test('Linux：非 GNOME 桌面不让 gnome-session-inhibit 进候选（白起进程还刷日志）', () => {
    const arbiter = createArbiter()
    const fake = fakeAwake()
    const which = (command: string): string | null => `/usr/bin/${command}`
    expect(linuxInhibitBackends(which, { XDG_CURRENT_DESKTOP: 'KDE' })).toEqual(['systemd-inhibit'])

    const awake = createKeepAwake({
      arbiter,
      platform: 'linux',
      pid: 1_234,
      which,
      env: { XDG_CURRENT_DESKTOP: 'KDE' },
      spawnCommand: fake.spawnCommand,
    })
    arbiter.setBusy('desktop', true, Date.now())
    expect(awake.tick()).toBe(true)
    expect(fake.spawns).toHaveLength(1)
    expect(fake.spawns[0]?.[0]).toBe('systemd-inhibit')
    expect(awake.capability().backend).toBe('systemd-inhibit')
    awake.stop()
  })

  test('Linux：GNOME 上 gnome-session 秒退 → 按序降级到 systemd-inhibit，全试完才认账', async () => {
    const arbiter = createArbiter()
    const fake = fakeAwake(true)
    const awake = createKeepAwake({
      arbiter,
      platform: 'linux',
      pid: 1_234,
      which: (command) => `/usr/bin/${command}`,
      env: { XDG_SESSION_DESKTOP: 'gnome' },
      spawnCommand: fake.spawnCommand,
    })
    arbiter.setBusy('desktop', true, Date.now())
    expect(awake.tick()).toBe(true)
    expect(fake.spawns[0]?.[0]).toBe('gnome-session-inhibit')

    fake.exit(1)
    await Bun.sleep(1)

    // 降级：候选里还有 systemd，capability 仍说「拿得到」
    expect(awake.capability().available).toBe(true)
    expect(awake.capability().backend).toBe('systemd-inhibit')
    expect(awake.tick()).toBe(true)
    expect(fake.spawns).toHaveLength(2)
    expect(fake.spawns[1]?.[0]).toBe('systemd-inhibit')

    // 兜底也秒退 → 候选耗尽，认账且不再重生
    fake.exit(1)
    await Bun.sleep(1)
    expect(awake.capability().available).toBe(false)
    expect(awake.capability().reason).toBe('systemd-inhibit 启动后立即退出（exit=1）')
    expect(awake.tick()).toBe(false)
    expect(fake.spawns).toHaveLength(2)
    awake.stop()
  })

  test('Linux 真进程：systemd-inhibit 真的拿住了锁，释放后真的没了', async () => {
    if (process.platform !== 'linux') return
    const logs: string[] = []
    const spawnedPids: number[] = []
    const arbiter = createArbiter()
    arbiter.setBusy('desktop', true, Date.now())
    // 真 spawn（与 defaultSpawn 同形）：记下 pid，好对着 systemd-inhibit --list 断言
    const awake = createKeepAwake({
      arbiter,
      log: (line) => logs.push(line),
      spawnCommand: (command) => {
        const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
        spawnedPids.push(child.pid)
        return { pid: child.pid, kill: (): void => void child.kill(), exited: child.exited }
      },
    })
    awake.tick()
    // 给秒退判定一拍时间：拿不到通道时这条路径要跑完
    await Bun.sleep(300)

    const capability = awake.capability()
    if (!capability.available) {
      // 非 systemd/GNOME 会话（容器/CI）：必须留下可见原因，且不假装持有
      expect(capability.reason).not.toBeNull()
      expect(logs.some((line) => line.includes(capability.reason ?? ''))).toBe(true)
      expect(awake.isHolding()).toBe(false)
      awake.stop()
      return
    }

    expect(spawnedPids).toHaveLength(1)
    const holder = spawnedPids[0] ?? 0
    if (capability.backend === 'systemd-inhibit') {
      const listed = new TextDecoder().decode(Bun.spawnSync(['systemd-inhibit', '--list']).stdout)
      expect(listed).toContain(String(holder))
    } else {
      // GNOME 兜底通道没有 --list 可查：只确认持有进程活着
      expect(awake.isHolding()).toBe(true)
    }

    arbiter.setBusy('desktop', false, Date.now())
    expect(awake.tick()).toBe(false)
    await Bun.sleep(300)
    if (capability.backend === 'systemd-inhibit') {
      const after = new TextDecoder().decode(Bun.spawnSync(['systemd-inhibit', '--list']).stdout)
      expect(after).not.toContain(String(holder))
    }
    awake.stop()
  })

  test('macOS 真进程：caffeinate 真的起来了，释放后真的没了', async () => {
    if (process.platform !== 'darwin') return
    const arbiter = createArbiter()
    arbiter.setBusy('desktop', true, Date.now())
    const awake = createKeepAwake({ arbiter, pid: process.pid })
    expect(awake.tick()).toBe(true)
    // 断言进程活着（signal 0 只探活）
    const listed = Bun.spawnSync(['pgrep', '-f', `caffeinate -i -w ${String(process.pid)}`])
    expect(new TextDecoder().decode(listed.stdout).trim().length).toBeGreaterThan(0)
    arbiter.setBusy('desktop', false, Date.now())
    expect(awake.tick()).toBe(false)
    await Bun.sleep(200)
    const after = Bun.spawnSync(['pgrep', '-f', `caffeinate -i -w ${String(process.pid)}`])
    expect(new TextDecoder().decode(after.stdout).trim()).toBe('')
  })
})

describe('子进程环境：通知口契约', () => {
  const base = { HOME: '/tmp/home' }

  test('给了通知口就注入三项（插件据此回报忙状态）', () => {
    const env = buildChildEnv({
      base,
      clientVersion: '0.12.0',
      profile: 'desktop',
      home: '/tmp/home/.dsh',
      notify: { port: 51_234, token: 'tok-abc' },
    })
    expect(env.DSH_DESKTOP_NOTIFY_PORT).toBe('51234')
    expect(env.DSH_DESKTOP_NOTIFY_TOKEN).toBe('tok-abc')
    expect(env.DSH_DESKTOP_PROFILE).toBe('desktop')
  })

  test('没给通知口就不留残留（继承环境里同名的键也会被清掉）', () => {
    const env = buildChildEnv({
      base: { ...base, DSH_DESKTOP_NOTIFY_PORT: '1', DSH_DESKTOP_NOTIFY_TOKEN: 'x', DSH_DESKTOP_PROFILE: 'y' },
      clientVersion: '0.12.0',
      profile: 'desktop',
      home: '/tmp/home/.dsh',
    })
    expect(env.DSH_DESKTOP_NOTIFY_PORT).toBeUndefined()
    expect(env.DSH_DESKTOP_NOTIFY_TOKEN).toBeUndefined()
    expect(env.DSH_DESKTOP_PROFILE).toBeUndefined()
  })

  test('端口为 0 或令牌为空视为没给（插件那边就是静默降级）', () => {
    const env = buildChildEnv({
      base,
      clientVersion: '0.12.0',
      profile: 'desktop',
      home: '/tmp/home/.dsh',
      notify: { port: 0, token: 'tok' },
    })
    expect(env.DSH_DESKTOP_NOTIFY_PORT).toBeUndefined()
    const env2 = buildChildEnv({
      base,
      clientVersion: '0.12.0',
      profile: 'desktop',
      home: '/tmp/home/.dsh',
      notify: { port: 5_000, token: '' },
    })
    expect(env2.DSH_DESKTOP_NOTIFY_TOKEN).toBeUndefined()
  })
})
