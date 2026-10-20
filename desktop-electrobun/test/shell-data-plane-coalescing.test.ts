// #144-1 / #144-3：loopback 数据面单飞——跟随者的等待上限与取消，以及档位策略表。
//
// 断言口径沿用 data-plane.test.ts：上游是真实 HTTP 服务，自己数收到几条请求（不信壳的自报）；
// health 的字段只验「在、方向对、事后归零」。三条硬口径锁死：
//   1) 等满上限后跟随者不挂死，独立发起并正常返回；
//   2) 掉队不牵连领头——领头那条请求只发一次（计数断言，不给任何「已发出请求加自动重试」留口子）；
//   3) 页面 abort 后跟随者不再占资源，也不替它去打上游。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startShellServer } from '../src/bun/net/shell-server.ts'
import { AGGREGATION_POLICIES, FOLLOWER_WAIT_MS, GetCoalescer, aggregationPolicy } from '../src/bun/net/coalescing.ts'
import { LOOPBACK_AGGREGATION_MODES, type LoopbackAggregation } from '../src/shared/settings/settings.ts'

interface Health {
  proxiedInFlight: number
  coalesced: number
  followerDropouts: number
  followerWaitMs: number
}

const readHealth = async (origin: string): Promise<Health> =>
  (await (await fetch(`${origin}/__shell__/health`)).json()) as Health


interface Upstream {
  origin: string
  count: (key: string) => number
  /** 放开卡住的那条领头，让它落地。 */
  releaseStuck: () => void
  stop: () => void
}

/**
 * /api/stuck：第一条请求挂住不放（模拟「领头卡住不落地」，正是 #144-1 的病根场景），
 * 之后同 key 的请求立刻回——这样掉队的跟随者自己再发一次时不会被同一条挂住。
 * /api/slow：慢 150ms，给 full 档的正常搭车留汇合窗口。
 */
function startUpstream(): Upstream {
  const counts = new Map<string, number>()
  let openStuck = (): void => {}
  const stuck = new Promise<void>((resolve) => {
    openStuck = resolve
  })
  const server = Bun.serve({
    port: 0,
    // 与壳服务面同形（它自己就只绑 127.0.0.1）：Windows 上绑全接口时，壳回连 127.0.0.1 会偶发走不通（#220）
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      const key = `${request.method} ${url.pathname}${url.search}`
      const seen = counts.get(key) ?? 0
      counts.set(key, seen + 1)
      if (url.pathname === '/api/stuck') {
        if (seen === 0) {
          await stuck
          return Response.json({ ok: true, who: 'leader' })
        }
        return Response.json({ ok: true, who: 'alone' })
      }
      if (url.pathname === '/api/slow') {
        await new Promise((resolve) => setTimeout(resolve, 150))
        return Response.json({ ok: true, path: url.pathname })
      }
      return Response.json({ ok: true, path: url.pathname, query: url.search })
    },
  })
  return {
    origin: `http://127.0.0.1:${String(server.port)}`,
    count: (key) => counts.get(key) ?? 0,
    releaseStuck: () => openStuck(),
    stop: () => server.stop(true),
  }
}

function withServer(
  upstreamOrigin: string,
  opts: { aggregation?: () => LoopbackAggregation; followerWaitMs?: () => number } = {},
): { origin: string; cleanup: () => void } {
  const dist = mkdtempSync(join(tmpdir(), 'dsh-coalesce-'))
  const server = startShellServer({
    distDir: dist,
    token: 'tok',
    cookie: 'dsh-auth-x=v1.y',
    upstreamOrigin,
    // #168：端口交给系统分配，句柄里的 origin 就是真实端口（不再「先占后放」挑端口，那个窗口会被抢）。
    port: 0,
    bootPayload: () => null,
    onRpc: async () => ({ status: 200, body: {} }),
    aggregation: opts.aggregation,
    followerWaitMs: opts.followerWaitMs,
  })
  return {
    origin: server.origin,
    cleanup: () => {
      server.stop()
      rmSync(dist, { recursive: true, force: true })
    },
  }
}

/** 轮询等条件成立（并发时序靠确定性等待，不靠 sleep 猜）。 */
async function until(check: () => Promise<boolean>, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const untilCount = async (upstream: Upstream, key: string, want: number): Promise<void> =>
  until(async () => upstream.count(key) >= want, `${key} 累计 ${String(want)} 条（实际 ${String(upstream.count(key))}）`)

describe('#144-3 档位策略表', () => {
  test('映射穷尽：键集就是档位枚举全集，三档给出互不相同的转发路线', () => {
    // 新增一个档位枚举值时这张表会缺键 → 编译不过，而不是静默走默认分支。
    expect(Object.keys(AGGREGATION_POLICIES).sort()).toEqual([...LOOPBACK_AGGREGATION_MODES].sort())
    const kinds = LOOPBACK_AGGREGATION_MODES.map((mode) => aggregationPolicy(mode).kind)
    expect(new Set(kinds).size).toBe(LOOPBACK_AGGREGATION_MODES.length)
    expect(aggregationPolicy('none').kind).toBe('passthrough')
    expect(aggregationPolicy('full').kind).toBe('coalesced-buffered')
    expect(aggregationPolicy('stream').kind).toBe('coalesced-streamed')
  })

  test('在飞登记表：claim 只登记一次、settle 恰好一次并摘表（后到的跟随者不再搭车）', async () => {
    const coalescer = new GetCoalescer()
    const first = coalescer.claim('/a')
    expect(first).not.toBeNull()
    expect(coalescer.pending).toBe(1)
    // 已有活着的领头 ⇒ 不重复登记
    expect(coalescer.claim('/a')).toBeNull()
    const shared = { status: 200, headers: new Headers(), body: new ArrayBuffer(0) }
    coalescer.settle('/a', first, shared)
    expect(coalescer.pending).toBe(0)
    expect(await first?.buffered).toBe(shared)
    // entry 为 null（这个请求压根没登记过）⇒ 什么都不做
    coalescer.settle('/b', null, shared)
    expect(coalescer.pending).toBe(0)
  })
})

describe('#144-1 跟随者等待上限与取消', () => {
  test('等待上限是具名常量 10s，缺省走常量并由 health 暴露当前值', async () => {
    expect(FOLLOWER_WAIT_MS).toBe(10_000)
    const upstream = startUpstream()
    const shell = withServer(upstream.origin)
    try {
      const health = await readHealth(shell.origin)
      expect(health.followerWaitMs).toBe(FOLLOWER_WAIT_MS)
      expect(health.followerDropouts).toBe(0)
    } finally {
      shell.cleanup()
      upstream.stop()
    }
  })

  test('正常共享不该误触发上限：并发只打一次上游、零掉队、事后在飞归零', async () => {
    // 上游是同进程里的真 HTTP 服务：Windows 兜底 runner 上偶发「连不上上游」的传输级抖动（壳回 502 upstream unreachable）。
    // 那是传输层的事、不是聚合逻辑的事：只对传输失败换一套夹具重来；语义断言一旦不符立即失败（不吞回归）。
    for (let attempt = 1; attempt <= 3; attempt++) {
      const upstream = startUpstream()
      const shell = withServer(upstream.origin, { followerWaitMs: () => 5_000 })
      try {
        let hits: Response[] = []
        try {
          hits = await Promise.all(Array.from({ length: 8 }, () => fetch(`${shell.origin}/api/slow`)))
        } catch {
          continue // 连壳都连不上：同样是传输级抖动，换一套夹具重来
        }
        if (hits.some((hit) => hit.status === 502)) continue // 上游传输失败：换一套夹具重来
        for (const hit of hits) expect(hit.status).toBe(200)
        expect(upstream.count('GET /api/slow')).toBe(1)
        const health = await readHealth(shell.origin)
        expect(health.coalesced).toBe(7)
        expect(health.followerDropouts).toBe(0)
        expect(health.proxiedInFlight).toBe(0)
        return
      } finally {
        shell.cleanup()
        upstream.stop()
      }
    }
    throw new Error('连续 3 轮都撞上上游传输失败（502 upstream unreachable）')
  })

  test('full 档：等满阈值后不挂死，独立发起并正常返回；领头那条只发一次', async () => {
    const upstream = startUpstream()
    const shell = withServer(upstream.origin, { followerWaitMs: () => 150 })
    try {
      // 领头：真的打上游，然后卡住不落地
      const leader = fetch(`${shell.origin}/api/stuck`)
      await untilCount(upstream, 'GET /api/stuck', 1)

      // 跟随者：搭车等 150ms 后掉队，自己打一次上游并正常拿到响应
      const follower = await fetch(`${shell.origin}/api/stuck`)
      expect(follower.status).toBe(200)
      expect(await follower.json()).toEqual({ ok: true, who: 'alone' })

      // 上游共两条 = 领头那条 + 掉队者自己那条。领头没被重发（否则是 3）。
      expect(upstream.count('GET /api/stuck')).toBe(2)
      const during = await readHealth(shell.origin)
      expect(during.coalesced).toBe(1)
      expect(during.followerDropouts).toBe(1)
      expect(during.followerWaitMs).toBe(150)
      // 此刻只剩领头挂在飞——掉队的跟随者已经把自己的名额还回去了
      expect(during.proxiedInFlight).toBe(1)

      upstream.releaseStuck()
      expect(await (await leader).json()).toEqual({ ok: true, who: 'leader' })
      expect((await readHealth(shell.origin)).proxiedInFlight).toBe(0)
    } finally {
      upstream.releaseStuck()
      shell.cleanup()
      upstream.stop()
    }
  })

  test('stream 档：同样有上限——掉队后独立发起，头领那条也不重发', async () => {
    const upstream = startUpstream()
    const shell = withServer(upstream.origin, { aggregation: () => 'stream', followerWaitMs: () => 150 })
    try {
      const leader = fetch(`${shell.origin}/api/stuck`)
      await untilCount(upstream, 'GET /api/stuck', 1)

      const follower = await fetch(`${shell.origin}/api/stuck`)
      expect(follower.status).toBe(200)
      expect(await follower.json()).toEqual({ ok: true, who: 'alone' })
      expect(upstream.count('GET /api/stuck')).toBe(2)
      const during = await readHealth(shell.origin)
      expect(during.followerDropouts).toBe(1)
      expect(during.coalesced).toBe(1)
      expect(during.proxiedInFlight).toBe(1)

      upstream.releaseStuck()
      expect(await (await leader).json()).toEqual({ ok: true, who: 'leader' })
      expect((await readHealth(shell.origin)).proxiedInFlight).toBe(0)
    } finally {
      upstream.releaseStuck()
      shell.cleanup()
      upstream.stop()
    }
  })

  test('页面 abort：跟随者被摘出等待表，在飞回落，且不替它去打上游', async () => {
    const upstream = startUpstream()
    // 上限给得极大：这里走的一定是 abort 这条路，不是超时。
    const shell = withServer(upstream.origin, { followerWaitMs: () => 30_000 })
    try {
      const leader = fetch(`${shell.origin}/api/stuck`)
      await untilCount(upstream, 'GET /api/stuck', 1)

      const controller = new AbortController()
      const pending = fetch(`${shell.origin}/api/stuck`, { signal: controller.signal })
      const failure = pending.then(
        () => null,
        (error: Error) => error,
      )
      // 等跟随者真的登记上（coalesced 走到 1）再断，否则测的是「进场就已 abort」那条早退。
      await until(async () => (await readHealth(shell.origin)).coalesced === 1, '跟随者登记上')
      controller.abort()
      expect(((await failure) ?? new Error('请求居然成功了')).name).toBe('AbortError')

      await until(async () => (await readHealth(shell.origin)).proxiedInFlight === 1, '跟随者把在飞名额还回来')
      // 跟随者从头到尾没发出去过，所以取消之后不该有任何新的上游请求
      expect(upstream.count('GET /api/stuck')).toBe(1)
      const afterAbort = await readHealth(shell.origin)
      expect(afterAbort.coalesced).toBe(1)
      expect(afterAbort.followerDropouts).toBe(0)

      upstream.releaseStuck()
      expect(await (await leader).json()).toEqual({ ok: true, who: 'leader' })
      expect((await readHealth(shell.origin)).proxiedInFlight).toBe(0)
    } finally {
      upstream.releaseStuck()
      shell.cleanup()
      upstream.stop()
    }
  })

  test('none 档压根不搭车：上限再小也不掉队，各自打上游', async () => {
    const upstream = startUpstream()
    const shell = withServer(upstream.origin, { aggregation: () => 'none', followerWaitMs: () => 1 })
    try {
      const hits = await Promise.all(Array.from({ length: 4 }, () => fetch(`${shell.origin}/api/slow`)))
      for (const hit of hits) expect(hit.status).toBe(200)
      expect(upstream.count('GET /api/slow')).toBe(4)
      const health = await readHealth(shell.origin)
      expect(health.coalesced).toBe(0)
      expect(health.followerDropouts).toBe(0)
      expect(health.proxiedInFlight).toBe(0)
    } finally {
      shell.cleanup()
      upstream.stop()
    }
  })
})
