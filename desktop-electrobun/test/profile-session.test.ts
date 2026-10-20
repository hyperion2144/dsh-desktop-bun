/**
 * profile-session 单测（#179）：不开真窗口，注入假 createService/createWindow，
 * 断言开窗顺序、失败 phase、单飞去重、dispose 拆除、关窗策略、stop/重启时序。
 * 环境噪声：heal 只在 win32 生效，macOS 上天然跳过。
 */
import { describe, expect, test } from 'bun:test'
import { createProfileSessions } from '../src/bun/windows/profile-session.ts'
import type { ProfileSessionDeps } from '../src/bun/windows/profile-session.ts'
import type { ShellService } from '../src/bun/host/service.ts'
import { windowKey } from '../src/shared/app/window-targets.ts'

type Handler = (event?: unknown) => void

/** 假窗口：记下事件处理器供测试触发；方法调用记进 calls。 */
function fakeWindow() {
  const handlers = new Map<string, Handler[]>()
  const calls: string[] = []
  const win = {
    webview: null,
    close() {
      calls.push('close')
      for (const h of handlers.get('close') ?? []) h()
    },
    isVisible: () => true,
    isMinimized: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
    getFrame: () => ({ x: 10, y: 20, width: 800, height: 600 }),
    setFrame: () => {},
    unmaximize: () => calls.push('unmaximize'),
    maximize: () => calls.push('maximize'),
    unminimize: () => calls.push('unminimize'),
    show: () => calls.push('show'),
    activate: () => calls.push('activate'),
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    emit(event: string, arg?: unknown) {
      for (const h of handlers.get(event) ?? []) h(arg)
    },
  }
  return { win: win as never, handlers, calls }
}

function fakeService(overrides: Partial<Record<string, unknown>> = {}): ShellService {
  return {
    state: {
      status: 'running',
      error: null,
      blocked: null,
      origin: 'http://127.0.0.1:65432',
      pageUrl: 'http://127.0.0.1:65432/app',
      lanePort: 12345,
      hostPid: 4242,
    },
    laneForwarder: null,
    ensureRunning: async () => {},
    stop: async () => {},
    ...overrides,
  } as unknown as ShellService
}

/** 组装一套 deps：假工厂 + 记账的 views/guests/回调；测试按需覆写单个字段。 */
function makeDeps(overrides: Partial<ProfileSessionDeps> = {}) {
  const revoked: string[] = []
  const released: string[] = []
  const domReady: string[] = []
  const windowsChanged: number[] = []
  const deps: ProfileSessionDeps = {
    instanceProfile: 'main',
    createService: async () => fakeService(),
    createWindow: async () => fakeWindow().win,
    closePolicy: () => 'close',
    isQuitting: () => false,
    onQuitRequested: () => {},
    windowStateFile: () => '/tmp/dsh-profile-session-test-never-exists.json',
    workArea: () => null,
    onDomReady: (profile) => domReady.push(profile),
    onWindowsChanged: () => windowsChanged.push(windowsChanged.length),
    views: { revokeLabel: (label) => void revoked.push(label) },
    guests: { releaseHost: (label) => (released.push(label), 0) },
    ...overrides,
  }
  return { deps, revoked, released, domReady, windowsChanged }
}

async function openMain(sessions: ReturnType<typeof createProfileSessions>): Promise<void> {
  const result = await sessions.open('main')
  if (!result.ok) throw new Error(`open 失败：${result.phase} ${result.reason}`)
}

describe('profile-session：开窗（#179）', () => {
  test('成功链：ensureService → ensureRunning → 建窗 → dom-ready 置 ready', async () => {
    const order: string[] = []
    const { deps, domReady } = makeDeps({
      createService: async () => {
        order.push('service')
        return fakeService()
      },
      createWindow: async () => {
        order.push('window')
        return fakeWindow().win
      },
    })
    const sessions = createProfileSessions(deps)
    const service = await sessions.ensureService('main')
    ;(service.ensureRunning as () => Promise<void>) // 类型收窄无意义，仅占位避免误改
    const result = await sessions.open('main')
    expect(result.ok).toBe(true)
    expect(order).toEqual(['service', 'window'])
    const session = sessions.get('main')
    expect(session).toBeDefined()
    expect(session?.state().ready).toBe(false)
    ;(session?.window as unknown as { emit(event: string): void } | null)?.emit('dom-ready')
    expect(session?.state().ready).toBe(true)
    expect(domReady).toEqual(['main'])
  })

  test('失败 phase：服务面起不来=service，DSH 起不来=dsh，建窗失败=window；服务面按 #117 保留', async () => {
    const { deps } = makeDeps({ createService: async () => { throw new Error('端口被占') } })
    const failService = createProfileSessions(deps)
    const r1 = await failService.open('main')
    expect(r1).toMatchObject({ ok: false, phase: 'service' })

    const { deps: deps2 } = makeDeps({
      createService: async () =>
        fakeService({ ensureRunning: async () => { throw new Error('dsh 炸了') } }),
    })
    const failDsh = createProfileSessions(deps2)
    const r2 = await failDsh.open('main')
    expect(r2).toMatchObject({ ok: false, phase: 'dsh' })

    const { deps: deps3 } = makeDeps({
      createWindow: async () => { throw new Error('窗口没了') },
    })
    const failWindow = createProfileSessions(deps3)
    const r3 = await failWindow.open('main')
    expect(r3).toMatchObject({ ok: false, phase: 'window' })
    // #117：开窗失败不回滚服务面（托盘可见、可换运行时再试）
    expect(failWindow.serviceProfiles()).toEqual(['main'])
  })

  test('单飞：建窗进行中再次 open 复用同一个 promise', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { deps } = makeDeps({ createWindow: async () => { await gate; return fakeWindow().win } })
    const sessions = createProfileSessions(deps)
    const p1 = sessions.open('main')
    const p2 = sessions.open('main')
    expect(p1).toBe(p2)
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
  })

  test('已有窗时 open 走 focus（unminimize/show/activate），不重建服务面', async () => {
    let windows = 0
    const { deps } = makeDeps({
      createWindow: async () => { windows += 1; return fakeWindow().win },
    })
    const sessions = createProfileSessions(deps)
    await openMain(sessions)
    const calls = (sessions.get('main')?.window as unknown as { close(): void } & Record<string, () => void>)
    expect(windows).toBe(1)
    // 第二次 open：窗口还在 → focus 分支
    const again = await sessions.open('main')
    expect(again.ok).toBe(true)
    expect(windows).toBe(1)
    expect(calls['activate']).toBeDefined()
  })
})

describe('profile-session：关窗与拆除（#179）', () => {
  test('dispose 十步关键点：撤视图 token、回收 guest、清窗清 ready、record 保留服务面', async () => {
    const { deps, revoked, released } = makeDeps()
    const sessions = createProfileSessions(deps)
    await openMain(sessions)
    const session = sessions.get('main')
    expect(session?.state().windowOpen).toBe(true)
    ;(session?.window as unknown as { emit(event: string): void } | null)?.emit('close')
    expect(revoked).toEqual([windowKey('main')])
    expect(released).toEqual([windowKey('main')])
    expect(session?.state().windowOpen).toBe(false)
    expect(session?.state().ready).toBe(false)
    // record 保留：托盘/重启路径还要用
    expect(sessions.get('main')).toBeDefined()
    expect(sessions.serviceProfiles()).toEqual(['main'])
    expect(sessions.openProfiles()).toEqual([])
  })

  test('closePolicy=hidden：will-close 拦下（allow:false），窗口不拆', async () => {
    const { deps } = makeDeps({ closePolicy: () => 'hidden' })
    const sessions = createProfileSessions(deps)
    await openMain(sessions)
    const win = sessions.get('main')?.window as unknown as { emit(event: string, arg?: unknown): void }
    const event: { response?: unknown } = {}
    win.emit('will-close', event)
    expect(event.response).toEqual({ allow: false })
    expect(sessions.openProfiles()).toEqual(['main'])
  })

  test('closePolicy=quit：请壳退进程，不拆窗不写 response', async () => {
    let quitAsked = false
    const { deps } = makeDeps({ closePolicy: () => 'quit', onQuitRequested: () => { quitAsked = true } })
    const sessions = createProfileSessions(deps)
    await openMain(sessions)
    const win = sessions.get('main')?.window as unknown as { emit(event: string, arg?: unknown): void }
    const event: { response?: unknown } = {}
    win.emit('will-close', event)
    expect(quitAsked).toBe(true)
    expect(event.response).toBeUndefined()
    expect(sessions.openProfiles()).toEqual(['main'])
  })

  test('isQuitting / stopping 放行：不问策略，close 直接落 dispose', async () => {
    let policyAsked = 0
    let quitting = false
    const { deps } = makeDeps({
      closePolicy: () => (policyAsked += 1, 'hidden' as const),
      isQuitting: () => quitting,
    })
    const sessions = createProfileSessions(deps)
    await openMain(sessions)
    const win = sessions.get('main')?.window as unknown as {
      emit(event: string, arg?: unknown): void
      close(): void
    }
    // isQuitting=true：will-close 直接放行，不问策略
    quitting = true
    win.emit('will-close', {})
    expect(policyAsked).toBe(0)
    quitting = false
    // stopping=true（重启关窗）：同样不问策略——模拟真实平台 close 先发 will-close 再 close
    const realClose = win.close.bind(win)
    ;(win as { close(): void }).close = () => {
      win.emit('will-close', {})
      realClose()
    }
    await sessions.closeWindowsForRestart(['main'])
    expect(policyAsked).toBe(0)
    expect(sessions.openProfiles()).toEqual([])
  })
})

describe('profile-session：停止与重启（#179）', () => {
  test('stop()：关窗 + 停服务面；record 保留（托盘/复活还要用）', async () => {
    let stopped = 0
    const { deps } = makeDeps({
      createService: async () => fakeService({ stop: async () => { stopped += 1 } }),
    })
    const sessions = createProfileSessions(deps)
    await openMain(sessions)
    await sessions.stop('main')
    expect(stopped).toBe(1)
    expect(sessions.get('main')).toBeDefined()
    expect(sessions.openProfiles()).toEqual([])
  })

  test('closeWindowsForRestart：stopping 放行关窗，等一拍后复位 stopping', async () => {
    const { deps } = makeDeps()
    const sessions = createProfileSessions(deps)
    await openMain(sessions)
    const started = Date.now()
    await sessions.closeWindowsForRestart(['main'])
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
    expect(sessions.openProfiles()).toEqual([])
    expect(sessions.get('main')).toBeDefined()
  })

  test('resetService：停服务面并丢记录，下次 ensureService 全新拉起', async () => {
    let created = 0
    let stopped = 0
    const { deps } = makeDeps({
      createService: async () => { created += 1; return fakeService({ stop: async () => { stopped += 1 } }) },
    })
    const sessions = createProfileSessions(deps)
    await openMain(sessions)
    await sessions.resetService('main')
    expect(stopped).toBe(1)
    expect(sessions.get('main')).toBeUndefined()
    const fresh = await sessions.ensureService('main')
    expect(created).toBe(2)
    expect(sessions.get('main')?.service).toBe(fresh)
  })

  test('stopAllServices：全部服务面都 stop；个别失败不影响其余', async () => {
    const stopped: string[] = []
    const { deps } = makeDeps({
      createService: async (profile: string) =>
        fakeService({
          stop: async () => {
            if (profile === 'bad') throw new Error('停不下来')
            stopped.push(profile)
          },
        }),
    })
    const sessions = createProfileSessions(deps)
    await openMain(sessions)
    await sessions.ensureService('side')
    await sessions.ensureService('bad')
    await sessions.stopAllServices()
    expect(stopped.sort()).toEqual(['main', 'side'])
  })
})

describe('profile-session：焦点与杂项（#179）', () => {
  test('focus 事件记账 → inFront/anyInFront；blur 清账；焦点窗的 lane 指向跟焦点走', async () => {
    const target = { value: null as number | null }
    const lane = { setTarget: (port: number) => void (target.value = port) }
    const { deps } = makeDeps()
    const sessions = createProfileSessions(deps)
    await openMain(sessions)
    await sessions.ensureService('side')
    // side 持 lane 转发器（多实例下先起的那份）
    ;(sessions.get('side')?.service as unknown as { laneForwarder: unknown }).laneForwarder = lane
    const win = sessions.get('main')?.window as unknown as { emit(event: string): void }
    win.emit('focus')
    expect(sessions.focused()?.profile).toBe('main')
    expect(sessions.inFront('main')).toBe(true)
    expect(sessions.anyInFront()).toBe(true)
    expect(target.value).toBe(12345)
    win.emit('blur')
    expect(sessions.inFront('main')).toBe(false)
    expect(sessions.anyInFront()).toBe(false)
  })

  test('dispose 清最近聚焦并把 lane 指回 0', async () => {
    const target = { value: null as number | null }
    const lane = { setTarget: (port: number) => void (target.value = port) }
    const { deps } = makeDeps()
    const sessions = createProfileSessions(deps)
    await openMain(sessions)
    ;(sessions.get('main')?.service as unknown as { laneForwarder: unknown }).laneForwarder = lane
    const holder = sessions.get('main')
    const win = holder?.window as unknown as { emit(event: string): void }
    win.emit('focus')
    expect(target.value).toBe(12345)
    win.emit('close')
    expect(target.value).toBe(0)
    expect(sessions.focused()).toBeUndefined()
  })

  test('onceTrayHint：第一次 true，之后 false', async () => {
    const { deps } = makeDeps()
    const sessions = createProfileSessions(deps)
    expect(sessions.onceTrayHint('main')).toBe(true)
    expect(sessions.onceTrayHint('main')).toBe(false)
    expect(sessions.onceTrayHint('side')).toBe(true)
  })

  test('byWindow / focusedWindow / originOf 查询口径', async () => {
    const { deps } = makeDeps()
    const sessions = createProfileSessions(deps)
    await openMain(sessions)
    const win = sessions.get('main')?.window ?? null
    expect(win).not.toBeNull()
    expect(sessions.byWindow(win as never)?.profile).toBe('main')
    expect(sessions.focusedWindow()).toBe(win)
    expect(sessions.originOf('main')).toBe('http://127.0.0.1:65432')
    expect(sessions.originOf('ghost')).toBe('')
  })
})
