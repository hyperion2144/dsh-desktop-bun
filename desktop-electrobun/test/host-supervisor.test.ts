/**
 * host-supervisor 单测（#183）：宿主生命周期收口的接线不变式。
 *
 * 真依赖只有两样：本地 Bun.serve 充当 dsh 的 303+set-cookie 鉴权端点（connect 里
 * 的 fetch 是真网络调用，没有注入口），其余（宿主、台账、判定、时钟）全部注入。
 * 守护器的退避睡眠用假 ledger 压到 1ms，测试不等真实退避。
 */
import { describe, expect, test, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHostSupervisor,
  type HostSpec,
  type HostSnapshot,
} from '../src/bun/host/host-supervisor.ts'
import type { HostSupervisorDeps } from '../src/bun/host/host-supervisor.ts'
import type { HostHandle } from '../src/bun/host/host.ts'
import type { RestartLedger, RestartDecision } from '../src/bun/host/supervisor.ts'
type StartHostInput = Parameters<NonNullable<HostSupervisorDeps['startHostFn']>>[0]

// ---- 鉴权端点：默认发 303 + set-cookie；路径带 nocookie 就发 200 不带 cookie ----
const server = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('nocookie')) return new Response('ok', { status: 200 })
    return new Response(null, {
      status: 303,
      headers: { 'set-cookie': 'dsh_session=test-cookie; Path=/', location: '/' },
    })
  },
})
const origin = server.url.origin
const registryDir = mkdtempSync(join(tmpdir(), 'host-supervisor-test-'))
const registryFile = join(registryDir, 'shell-hosts.json')

afterAll(() => {
  server.stop(true)
  rmSync(registryDir, { recursive: true, force: true })
})

// ---- 假宿主：exited 由测试手动触发 ----
const makeHost = (url = `${origin}/ready`): { handle: HostHandle; calls: string[]; exit: (code?: number) => void } => {
  const calls: string[] = []
  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve
  })
  const handle: HostHandle = {
    ready: { url, injections: [{ id: 'inj-1' }] },
    stop: async () => {
      calls.push('stop')
      resolveExit(0) // 真 HostHandle.stop 契约：等到宿主真退出 → exited 落定
    },
    pid: 4242,
    exited,
    lastTree: () => [4243],
  }
  return { handle, calls, exit: (code = 1) => resolveExit(code) }
}

const baseSpec = (): HostSpec => ({
  remoteAddr: null,
  layout: { profile: 'p-test' } as unknown as HostSpec['layout'],
  clientVersion: 'test',
  mode: 'fresh',
  env: {},
  patchFiles: [],
  upstreamPort: 0,
  pagePort: 0,
  lanePort: 0,
  remoteViewToken: () => 'view-token',
  proxy: null,
  cloudflaredBin: undefined,
  pathShimDir: undefined,
  notify: { port: 0, token: 't' },
  retryExisting: true,
})

const decide = (restart: boolean, delayMs = 1, reason = '自愈重启'): RestartDecision => ({
  restart,
  delayMs,
  reason,
})
const fakeLedger = (decision: RestartDecision): RestartLedger & { resets: number; records: number } => {
  const ledger: RestartLedger & { resets: number; records: number } = {
    history: [],
    resets: 0,
    records: 0,
    record: () => {
      ledger.records += 1
    },
    reset: () => {
      ledger.resets += 1
    },
    decide: () => decision,
  }
  return ledger
}

const makeHarness = (over: {
  spec?: Partial<HostSpec>
  startHostFn?: (input: StartHostInput) => Promise<HostHandle>
  ledger?: RestartLedger
  probePort?: () => number
  readyInitially?: boolean
  watchdogIntervalMs?: number
} = {}) => {
  const events: string[] = []
  const spawnModes: Array<'existing' | 'fresh'> = []
  const notifyCalls: Array<{ scenario: string; body: string }> = []
  const specCalls: number[] = []
  const spawn = async (input: StartHostInput): Promise<HostHandle> => {
    spawnModes.push(input.mode ?? 'existing')
    if (over.startHostFn !== undefined) return await over.startHostFn(input)
    return makeHost().handle
  }
  const sup = createHostSupervisor({
    registryFile,
    spec: () => {
      specCalls.push(1)
      return { ...baseSpec(), ...over.spec }
    },
    startHostFn: (input) => spawn(input),
    ledger: over.ledger,
    probePort: over.probePort,
    readyInitially: over.readyInitially,
    watchdogIntervalMs: over.watchdogIntervalMs ?? 60_000,
    log: (line) => events.push(`log:${line}`),
    notify: (scenario, body) => {
      notifyCalls.push({ scenario, body })
    },
    onInjections: (rows) => events.push(`injections:${String(rows.length)}`),
    onHost: (snap) => events.push(`host:${snap.status}:pid${String(snap.hostPid)}`),
    onRestart: () => events.push('restart'),
    onGiveUp: (_snap: HostSnapshot, reason: string, terminal: boolean) =>
      events.push(`giveup:${terminal ? 'terminal' : 'connect'}:${reason}`),
    onChange: (snap) => events.push(`change:restarting=${String(snap.restarting)}`),
    onCrash: () => events.push('crash'),
  })
  return { sup, events, spawnModes, notifyCalls, specCalls }
}

async function waitFor(cond: () => boolean, ms = 10000): Promise<void> { // CI 慢时钟下真定时器链路偶发超 2s（run 39221084307 实证）
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor 超时')
    await Bun.sleep(5)
  }
}

describe('host-supervisor：宿主生命周期收口（#183）', () => {
  test('start 单飞：并发两次只 spawn 一个宿主，cookie 从 303+set-cookie 提取', async () => {
    const { sup, events, spawnModes } = makeHarness()
    await Promise.all([sup.start(), sup.start()])
    expect(spawnModes).toEqual(['fresh'])
    const snap = sup.state()
    expect(snap.hostPid).toBe(4242)
    expect(snap.cookie).toBe('dsh_session=test-cookie')
    expect(snap.hostOrigin).toBe(origin)
    expect(events.some((line) => line.startsWith('host:'))).toBe(true)
    await sup.stop()
  })

  test('fresh 首启失败且已有 package.json：按 existing 重试一次（首启脚手架窗口）', async () => {
    let calls = 0
    const { sup, spawnModes } = makeHarness({
      startHostFn: async () => {
        calls += 1
        if (calls === 1) throw new Error('fresh 起不来（依赖树为空）')
        return makeHost().handle
      },
    })
    await sup.start()
    expect(spawnModes).toEqual(['fresh', 'existing'])
    await sup.stop()
  })

  test('非 fresh 失败不重试：错误原样抛出', async () => {
    const { sup, spawnModes } = makeHarness({
      spec: { mode: 'existing' },
      startHostFn: async () => {
        throw new Error('existing 也起不来')
      },
    })
    expect(sup.start()).rejects.toThrow('existing 也起不来')
    await waitFor(() => spawnModes.length === 1)
    expect(spawnModes).toEqual(['existing'])
  })

  test('空 cookie：停掉刚起的宿主并抛错（303 + set-cookie 流程失败）', async () => {
    let wrapper: ReturnType<typeof makeHost> | undefined
    const { sup } = makeHarness({
      startHostFn: async () => {
        wrapper = makeHost(`${origin}/nocookie`)
        return wrapper.handle
      },
    })
    expect(sup.start()).rejects.toThrow('没拿到 dsh 会话 cookie')
    await waitFor(() => (wrapper?.calls.length ?? 0) > 0)
    expect(wrapper?.calls).toContain('stop')
  })

  test('崩溃自愈链：crash → restarting 翻转 → 退避后 connect 新宿主 → onRestart + SERVICE_HEALTH', async () => {
    let calls = 0
    let first: ReturnType<typeof makeHost> | undefined
    const { sup, events, spawnModes, notifyCalls } = makeHarness({
      ledger: fakeLedger(decide(true, 1)),
      startHostFn: async () => {
        calls += 1
        const host = makeHost()
        if (calls === 1) first = host
        return host.handle
      },
    })
    await sup.start()
    expect(sup.state().hostPid).toBe(4242)
    first?.exit(1)
    await waitFor(() => spawnModes.length === 2)
    await waitFor(() => events.includes('restart'))
    expect(events).toContain('crash')
    expect(events).toContain('change:restarting=true')
    expect(events).toContain('change:restarting=false')
    expect(events).toContain('restart')
    expect(notifyCalls.some((n) => n.body.includes('dsh 服务已自动重启'))).toBe(true)
    expect(events.some((line) => line.startsWith('giveup:'))).toBe(false)
    await sup.stop()
  })

  test('判定层放弃（restart=false）：onGiveUp terminal=true，不再拉新宿主', async () => {
    const host = makeHost()
    const { sup, events, spawnModes } = makeHarness({
      ledger: fakeLedger(decide(false, 0, '窗口期内已重启 5 次，上限 5——停止守护')),
      startHostFn: async () => host.handle,
    })
    await sup.start()
    host.exit(1)
    await waitFor(() => events.some((line) => line.startsWith('giveup:')))
    expect(events).toContain('giveup:terminal:窗口期内已重启 5 次，上限 5——停止守护')
    expect(events).toContain('crash')
    expect(spawnModes).toEqual(['fresh'])
    expect(events.includes('restart')).toBe(false)
    // #215：放弃重启也要把终态发布出去——否则托盘还拿着死 PID 说「运行中」，
    // ensureRunning 又因 status==='running' 早退，这个 profile 再也拉不起来。
    expect(sup.state().hostPid).toBe(0)
    expect(sup.state().status).toBe('failed')
    expect(events).toContain('host:failed:pid0')
    await sup.stop()
  })

  test('stop 时宿主停不掉：不装死——状态落 failed、PID 留着（#215）', async () => {
    const { sup, events } = makeHarness({
      startHostFn: async () => {
        const host = makeHost()
        return {
          ...host.handle,
          stop: async () => {
            throw new Error('宿主停不掉')
          },
        }
      },
    })
    await sup.start()
    await sup.stop()
    expect(sup.state().status).toBe('failed')
    expect(sup.state().hostPid).toBe(4242)
    expect(events).toContain('host:failed:pid4242')
  })

  test('守护器重启时 connect 失败：onGiveUp terminal=false，restarting 保持原状（原 supervise 行为）', async () => {
    let calls = 0
    const first = makeHost()
    const { sup, events } = makeHarness({
      ledger: fakeLedger(decide(true, 1)),
      startHostFn: async () => {
        calls += 1
        if (calls === 1) return first.handle
        throw new Error('第二次拉不起来')
      },
    })
    await sup.start()
    first.exit(1)
    await waitFor(() => events.some((line) => line.startsWith('giveup:connect')))
    expect(events).toContain('giveup:connect:第二次拉不起来')
    expect(sup.state().restarting).toBe(true)
    expect(events.includes('restart')).toBe(false)
    // #215：重启失败同样要落终态（宿主没了就别让托盘继续说「运行中」）
    expect(sup.state().hostPid).toBe(0)
    expect(sup.state().status).toBe('failed')
    expect(events).toContain('host:failed:pid0')
    await sup.stop()
  })

  test('stop 后宿主退出：守护静默（不 crash、不重启、不再 spawn）', async () => {
    const host = makeHost()
    const ledger = fakeLedger(decide(true, 1))
    const { sup, events, spawnModes } = makeHarness({
      ledger,
      startHostFn: async () => host.handle,
    })
    await sup.start()
    await sup.stop()
    expect(ledger.resets).toBe(1)
    host.exit(1)
    await Bun.sleep(30)
    expect(events.includes('crash')).toBe(false)
    expect(spawnModes).toEqual(['fresh'])
  })

  test('stop 后发布终态快照：hostPid 归 0、状态落 stopped（#215）', async () => {
    const { sup, events } = makeHarness()
    await sup.start()
    expect(sup.state().hostPid).toBe(4242)
    await sup.stop()
    // 宿主没了就是没了：旧 PID 不能留在快照里，否则下游（服务面 state → 托盘行）
    // 一直拿着它说「运行中」——托盘退出实例后那个 profile 就再也开不起来了（#215）。
    expect(sup.state().hostPid).toBe(0)
    expect(sup.state().status).toBe('stopped')
    // 终态事实要发布出去：服务面是状态文件的唯一写者（不发布，下游就收不到）
    expect(events).toContain('host:stopped:pid0')
  })

  test('restart 本地→本地：只停旧宿主，不立即重连（交给退出事件那条守护器回路）', async () => {
    const host = makeHost()
    const { sup, events, spawnModes } = makeHarness({
      startHostFn: async () => host.handle,
      ledger: fakeLedger(decide(false, 0, '停')),
    })
    await sup.start()
    await sup.restart()
    expect(host.calls).toContain('stop')
    expect(spawnModes).toEqual(['fresh'])
    // 退出事件那条路已被守护器接管（这里判定层选择不拉新：giveup terminal）
    await waitFor(() => events.some((line) => line.startsWith('giveup:terminal')))
    await sup.stop()
  })

  test('restart 远程模式：connect 重发鉴权并发布，全程不 spawn（武装后的 supervise 立即“崩溃”一次是原版既有怪行为）', async () => {
    const { sup, spawnModes, events } = makeHarness({
      spec: { remoteAddr: `${origin}/remote?token=tok` },
      ledger: fakeLedger(decide(false, 0, '停')), 
    })
    await sup.start()
    const snap = sup.state()
    expect(snap.hostPid).toBe(0)
    expect(snap.cookie).toBe('dsh_session=test-cookie')
    expect(snap.hostOrigin).toBe(origin)
    await waitFor(() => events.some((line) => line.startsWith('giveup:terminal')))
    await sup.restart()
    expect(spawnModes).toEqual([])
    expect(events.filter((line) => line.startsWith('host:')).length).toBeGreaterThanOrEqual(2)
    await sup.stop()
  })

  test('onInjections 转交：宿主推送清单 → supervisor 存档 + 服务面回调', async () => {
    let captured: StartHostInput | undefined
    const { sup, events } = makeHarness({
      startHostFn: async (input) => {
        captured = input
        return makeHost().handle
      },
    })
    await sup.start()
    // connect 时的初始清单由 supervisor 直接存档（不走回调）；回调只在宿主后续推送时触发
    expect(sup.state().injections).toEqual([{ id: 'inj-1' }])
    // HOST-INJECTIONS 通道再推一次（走 spawn 时注册的 onInjections 回调）
    const rows = [{ id: 'inj-2' }]
    captured?.onInjections?.(rows)
    await waitFor(() => events.some((line) => line.startsWith('injections:1')))
    expect(sup.state().injections).toEqual(rows)
    await sup.stop()
  })

  test('blocked 与 setStatus：状态落快照，onHost 发布', async () => {
    const { sup, events } = makeHarness()
    sup.blocked('端口被占用')
    expect(sup.state().status).toBe('blocked')
    expect(sup.state().blocked).toBe('端口被占用')
    sup.setStatus('failed', '布局解析失败')
    expect(sup.state().status).toBe('failed')
    expect(sup.state().error).toBe('布局解析失败')
    expect(events.filter((line) => line.startsWith('host:')).length).toBe(2)
  })

  test('watchdog attempt 线：探测失败 → 通知 + 停宿主（交给退出事件重启）', async () => {
    const host = makeHost()
    const { sup, events, notifyCalls } = makeHarness({
      startHostFn: async () => host.handle,
      probePort: () => 0, // 永远探不通
      ledger: fakeLedger(decide(false, 0, '停')),
      watchdogIntervalMs: 10,
    })
    await sup.start()
    await waitFor(() => notifyCalls.some((n) => n.body.includes('dsh 服务异常，正在自动重启（第 1 次）')))
    expect(host.calls).toContain('stop')
    // 宿主被 watchdog 停掉后，退出事件那条路同样接管（判定层选拉新）
    await waitFor(() => events.some((line) => line.startsWith('giveup:terminal')))
    await sup.stop()
  })

  test('watchdog tick 不触发 spec() 现算：垫片重写/系统代理探测的副作用链只在 connect 时跑（#195）', async () => {
    // 真实回归：spec() 每 tick 被取端口 → Windows 上每 30s 重写 pnpm 垫片 + 打「继承系统代理」日志，
    // 且垫片重写撞文件锁时那一次启动的宿主会丢 PATH 垫片。修复后 watchdog 只读 connect 时的 spec 快照。
    const livePort = Number(new URL(origin).port)
    const { sup, specCalls } = makeHarness({
      spec: { upstreamPort: livePort }, // 探活走 fallback（不注 probePort），指到真监听端口 → healthy
      watchdogIntervalMs: 5,
    })
    await sup.start()
    const afterStart = specCalls.length
    expect(afterStart).toBeGreaterThan(0)
    await Bun.sleep(40) // 跨 ≥5 个 watchdog tick
    expect(specCalls.length).toBe(afterStart) // tick 期间零 spec() 调用
    await sup.stop()
  })
})
