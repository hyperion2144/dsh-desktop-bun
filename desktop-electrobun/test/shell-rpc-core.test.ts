// 壳 RPC 客户端核心（shared/rpc/core.ts，#185）的回归测试。
//
// 双轨锁行为（ADR-0008 的「自包含」硬约束）：直接 import 调工厂是一轨；
// `new Function('return (' + SHELL_RPC_CORE_SOURCE + ')')()` 求值出同一实现再跑一遍是另一轨——
// 工厂体若引用了模块级标识或 Bun 的 toString 行为变了，第二轨当场红。
// 另有 preload 分发器端到端：脚本真执行一次，桥/回包/框架 handler 透传全走真路径。
import { describe, expect, test } from 'bun:test'
import { createRpcCore, SHELL_RPC_CORE_SOURCE, type RpcCoreOptions } from '../../shared/rpc/core.ts'
import { shellRpcDispatcherScript } from '../src/bun/preload.ts'

/** 收集型计时器：记录 (fn, ms)，返回自增句柄；手动点火。 */
function fakeTimers() {
  const timers: Array<{ fn: () => void; ms: number }> = []
  return {
    timers,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimeout: () => {},
    fireLast() {
      const t = timers[timers.length - 1]
      if (t === undefined) throw new Error('没有计时器可点火')
      t.fn()
    },
  }
}

/** 一套「关键行为」断言：直接实现与求值实现都要过这一关。 */
async function assertCoreBehaviors(make: (options: Partial<RpcCoreOptions>) => ReturnType<typeof createRpcCore>) {
  // wire 包形 + 成功回包 resolve payload
  {
    const sent: unknown[] = []
    const core = make({ post: (m) => sent.push(m) } as Partial<RpcCoreOptions>)
    const p = core.invoke('echo', { a: 1 })
    expect(sent.length).toBe(1)
    expect(JSON.parse(sent[0] as string)).toEqual({ type: 'request', id: 1, method: 'echo', params: { a: 1 } })
    core.receive({ type: 'response', id: 1, success: true, payload: 'ok-echo' })
    await expect(p).resolves.toBe('ok-echo')
  }
  // 业务失败 reject Error(error)；非字符串 error 落到兜底文案
  {
    const core = make({ post: () => {} })
    const p1 = core.invoke('boom')
    core.receive({ type: 'response', id: 1, success: false, error: '炸了' })
    await expect(p1).rejects.toThrow('炸了')
    const p2 = core.invoke('boom2')
    core.receive({ type: 'response', id: 2, success: false })
    await expect(p2).rejects.toThrow('shell rpc failed')
  }
  // 超时：注入计时器点火后 reject，语义对齐官方（'RPC request timed out.'）
  {
    const t = fakeTimers()
    const core = make({ post: () => {}, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })
    const p = core.invoke('slow', {}, { timeoutMs: 50 })
    t.fireLast()
    await expect(p).rejects.toThrow('RPC request timed out.')
  }
  // noTimeout：压根不挂计时器（#97 长任务语义）
  {
    const t = fakeTimers()
    const core = make({ post: () => {}, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })
    void core.invoke('long', {}, { noTimeout: true })
    expect(t.timers.length).toBe(0)
  }
  // post 同步抛错（桥缺失的胶水语义）：reject 该错误、pending 与计时器都清掉
  {
    const t = fakeTimers()
    let calls = 0
    const core = make({
      post: () => {
        calls += 1
        if (calls === 1) throw new Error('official bridge unavailable')
      },
      setTimeout: t.setTimeout,
      clearTimeout: t.clearTimeout,
    })
    await expect(core.invoke('x')).rejects.toThrow('official bridge unavailable')
    expect(t.timers.length).toBe(1)
    t.fireLast()
    // 抛错后计时器已废：点火不得再影响后续请求
    const p = core.invoke('y')
    core.receive({ type: 'response', id: 2, success: true, payload: 'fine' })
    await expect(p).resolves.toBe('fine')
  }
  // id 溢出归 1（maxId=2：1,2,1）；receive 忽略非 response 包与无主 id。
  // 这些请求都不回包——必须注入假计时器，否则真 15s 计时器会在测试后期爆 unhandled rejection。
  {
    const t = fakeTimers()
    const sent: Array<Record<string, unknown>> = []
    const core = make({ post: (m) => sent.push(JSON.parse(m)), maxId: 2, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })
    void core.invoke('a')
    void core.invoke('b')
    void core.invoke('c')
    expect(sent.map((p) => p.id)).toEqual([1, 2, 1])
    expect(() => core.receive({ type: 'request', id: 1 })).not.toThrow()
    expect(() => core.receive({ type: 'response', id: 999, success: true })).not.toThrow()
    expect(() => core.receive(null)).not.toThrow()
  }
}

describe('createRpcCore（直接 import）', () => {
  test('wire 协议 / 超时 / 不重试 / id 口径', async () => {
    await assertCoreBehaviors((options) => createRpcCore({ post: () => {}, ...options }))
  })
})

describe('SHELL_RPC_CORE_SOURCE（求值实现，同表断言）', () => {
  test('函数源码可求值且行为与 import 一致', async () => {
    const revived = new Function('return (' + SHELL_RPC_CORE_SOURCE + ')')() as typeof createRpcCore
    expect(typeof revived).toBe('function')
    await assertCoreBehaviors((options) => revived({ post: () => {}, ...options }))
  })
})

/** 装一次 preload 分发器：桩桥 + 桩接收面，返回句柄与还原函数。 */
function installDispatcher(bridge: { postMessage: (raw: string) => void } | undefined) {
  const g = globalThis as Record<string, unknown>
  const saved = {
    bridge: g.__electrobunHostBridge,
    eb: g.__electrobun,
    rpc: g.__DSH_SHELL_RPC__,
    queued: g.__electrobunPendingHostMessages,
  }
  g.__electrobunHostBridge = bridge
  g.__electrobun = {}
  delete g.__electrobunPendingHostMessages
  delete g.__DSH_SHELL_RPC__
  new Function(shellRpcDispatcherScript())()
  const rpc = g.__DSH_SHELL_RPC__ as {
    invoke: (m: string, p?: Record<string, unknown>, o?: { timeoutMs?: number; noTimeout?: boolean }) => Promise<unknown>
    request: (m: string, p?: Record<string, unknown>, o?: { timeoutMs?: number; noTimeout?: boolean }) => Promise<unknown>
  }
  const electrobun = g.__electrobun as { receiveMessageFromHost: (packet: unknown) => void }
  return {
    rpc,
    electrobun,
    restore() {
      g.__electrobunHostBridge = saved.bridge
      g.__electrobun = saved.eb
      if (saved.rpc === undefined) delete g.__DSH_SHELL_RPC__
      else g.__DSH_SHELL_RPC__ = saved.rpc
      if (saved.queued === undefined) delete g.__electrobunPendingHostMessages
      else g.__electrobunPendingHostMessages = saved.queued
    },
  }
}

describe('preload 分发器（shellRpcDispatcherScript 端到端）', () => {
  test('脚本可解析、装出全局，请求经桥上送、回包经接收面归位', async () => {
    const sent: Record<string, unknown>[] = []
    const env = installDispatcher({ postMessage: (raw) => sent.push(JSON.parse(raw)) })
    try {
      expect(typeof env.rpc.invoke).toBe('function')
      expect(typeof env.rpc.request).toBe('function')
      const p = env.rpc.request('get_boot_payload', {})
      expect(sent.length).toBe(1)
      expect(sent[0]).toEqual({ type: 'request', id: 1, method: 'get_boot_payload', params: {} })
      env.electrobun.receiveMessageFromHost({ type: 'response', id: 1, success: true, payload: { ok: true } })
      await expect(p).resolves.toEqual({ ok: true })
    } finally {
      env.restore()
    }
  })

  test('包装框架原 handler 且继续调用它（吞掉即丢包——#128 硬约束）', async () => {
    const forwarded: unknown[] = []
    const env = installDispatcher({ postMessage: () => {} })
    try {
      const prev = (packet: unknown) => forwarded.push(packet)
      env.electrobun.receiveMessageFromHost = prev
      const p = env.rpc.invoke('x')
      env.electrobun.receiveMessageFromHost({ type: 'response', id: 1, success: true, payload: 'done' })
      await expect(p).resolves.toBe('done')
      expect(forwarded.length).toBe(1)
    } finally {
      env.restore()
    }
  })

  test('先期积压在安装时排空；桥缺失时 request reject 不抛同步异常', async () => {
    const g = globalThis as Record<string, unknown>
    const savedQueued = g.__electrobunPendingHostMessages
    try {
      const env = installDispatcher(undefined)
      g.__electrobunPendingHostMessages = [
        { type: 'response', id: 7, success: true, payload: 'early' },
      ]
      env.electrobun.receiveMessageFromHost({ type: 'response', id: 999, success: true })
      expect(Array.isArray(g.__electrobunPendingHostMessages) === false || (g.__electrobunPendingHostMessages as unknown[]).length === 0).toBe(true)
      await expect(env.rpc.request('x')).rejects.toThrow('official bridge unavailable')
    } finally {
      if (savedQueued === undefined) delete g.__electrobunPendingHostMessages
      else g.__electrobunPendingHostMessages = savedQueued
    }
  })
})
