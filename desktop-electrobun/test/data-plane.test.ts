// #54 数据面聚合（loopback 反代）：GET 单飞合并 + /__shell__/batch 批量转发 + health 在飞计数。
//
// 断言口径：上游是真实 HTTP 服务，自己计数收到几条请求（不信壳的自报）；
// health 的 proxiedInFlight/coalesced 是壳侧记账，只验「字段在、方向对、事后归零」。
// 诊断背景：Windows 实例「全站等 loopback、CPU 不高」——嫌疑是同连接排队与逐请求小
// 消息挤占壳事件循环；本文件锁住聚合行为与可观测性契约，回归即报。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loopbackOrigin, startShellServer } from '../src/bun/shell-server.ts'
import type { LoopbackAggregation } from '../src/shared/settings.ts'
import { createRpcRouter, dispatchRpc } from '../src/bun/rpc.ts'

const delayed = (value: Response, ms: number): Promise<Response> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms))

interface Upstream {
  origin: string
  count: (key: string) => number
  stop: () => void
}

/** 计数上游：/api/slow 慢 150ms（给单飞留汇合窗口），/api/echo 回显 POST body，其余回 JSON。 */
function startUpstream(): Upstream {
  const counts = new Map<string, number>()
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const key = `${request.method} ${url.pathname}${url.search}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
      if (url.pathname === '/api/slow') {
        return delayed(
          new Response(JSON.stringify({ ok: true, at: 'slow' }), { headers: { 'content-type': 'application/json' } }),
          150,
        )
      }
      // 首段立刻到、第二段延后 150ms：证明 stream 档的领头在 body 没收完时就拿到首字节。
      if (url.pathname === '/api/dribble') {
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode('head:'))
              await new Promise((resolve) => setTimeout(resolve, 150))
              controller.enqueue(encoder.encode(':tail'))
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/plain' } },
        )
      }
      // 无 content-length 的 512KB 分块流：stream 档必须在 256KB 处放弃共享（内存有界）。
      if (url.pathname === '/api/big') {
        const chunk = new Uint8Array(64 * 1024).fill(0x61)
        let sent = 0
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (sent >= 8) {
                controller.close()
                return
              }
              await new Promise((resolve) => setTimeout(resolve, 40))
              sent += 1
              controller.enqueue(chunk)
            },
          }),
          { headers: { 'content-type': 'application/octet-stream' } },
        )
      }
      if (url.pathname === '/api/echo') return Response.json({ ok: true, body: await request.text() })
      return Response.json({ ok: true, path: url.pathname, query: url.search })
    },
  })
  return {
    origin: `http://127.0.0.1:${String(server.port)}`,
    count: (key) => counts.get(key) ?? 0,
    stop: () => server.stop(true),
  }
}

function withServer(upstreamOrigin: string, aggregation?: () => LoopbackAggregation): { origin: string; cleanup: () => void } {
  const dist = mkdtempSync(join(tmpdir(), 'dsh-dp-'))
  const server = startShellServer({
    distDir: dist,
    token: 'tok',
    cookie: 'dsh-auth-x=v1.y',
    upstreamOrigin,
    // #168：端口交给系统分配，句柄里的 origin 就是真实端口（不再「先占后放」挑端口，那个窗口会被抢）。
    port: 0,
    bootPayload: () => null,
    onRpc: (raw) => dispatchRpc(createRpcRouter({}), raw),
    aggregation,
  })
  return {
    origin: server.origin,
    cleanup: () => {
      server.stop()
      rmSync(dist, { recursive: true, force: true })
    },
  }
}

describe('#54 数据面聚合', () => {
  test('并发相同 GET 只打上游一次（单飞合并），不同 query 不误合并，事后在飞归零', async () => {
    const upstream = startUpstream()
    const shell = withServer(upstream.origin)
    try {
      const hits = await Promise.all(Array.from({ length: 8 }, () => fetch(`${shell.origin}/api/slow`)))
      for (const hit of hits) expect(hit.status).toBe(200)
      // 150ms 汇合窗口内 8 个并发全到：领头 1 条 + 跟随 7 条
      expect(upstream.count('GET /api/slow')).toBe(1)

      const other = await fetch(`${shell.origin}/api/slow?x=1`)
      expect(other.status).toBe(200)
      expect(upstream.count('GET /api/slow?x=1')).toBe(1)

      const health = (await (await fetch(`${shell.origin}/__shell__/health`)).json()) as {
        proxiedInFlight: number
        coalesced: number
      }
      expect(health.coalesced).toBe(7)
      expect(health.proxiedInFlight).toBe(0)
    } finally {
      shell.cleanup()
      upstream.stop()
    }
  })

  test('/__shell__/batch：一次 POST 并发转发 N 个子请求，按序聚合、单失败不拖批', async () => {
    const upstream = startUpstream()
    const shell = withServer(upstream.origin)
    try {
      const res = await fetch(`${shell.origin}/__shell__/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requests: [
            { path: '/api/a' },
            { path: '/api/a', query: 'x=1' },
            { path: '/api/echo', method: 'POST', body: '你好' },
            { path: 'bad-path' },
          ],
        }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const payload = (await res.json()) as {
        responses: { status: number; contentType: string | null; body: string; ttfbMs: number }[]
      }
      expect(payload.responses).toHaveLength(4)
      expect(payload.responses[0]?.status).toBe(200)
      expect(JSON.parse(payload.responses[0]?.body ?? '{}')).toMatchObject({ path: '/api/a' })
      expect(payload.responses[1]?.status).toBe(200)
      expect(JSON.parse(payload.responses[1]?.body ?? '{}')).toMatchObject({ query: '?x=1' })
      expect(JSON.parse(payload.responses[2]?.body ?? '{}')).toMatchObject({ body: '你好' })
      expect(payload.responses[2]?.contentType).toContain('application/json')
      // 非法子请求只毒自己，不拖垮整批
      expect(payload.responses[3]?.status).toBe(400)
      expect(upstream.count('GET /api/a')).toBe(1)
      expect(upstream.count('GET /api/a?x=1')).toBe(1)
      expect(upstream.count('POST /api/echo')).toBe(1)
    } finally {
      shell.cleanup()
      upstream.stop()
    }
  })

  test('/__shell__/batch：空批 400、超 32 条 413、非 POST 405', async () => {
    const upstream = startUpstream()
    const shell = withServer(upstream.origin)
    try {
      const batchUrl = `${shell.origin}/__shell__/batch`
      const empty = await fetch(batchUrl, { method: 'POST', body: JSON.stringify({ requests: [] }) })
      expect(empty.status).toBe(400)
      const tooMany = await fetch(batchUrl, {
        method: 'POST',
        body: JSON.stringify({ requests: Array.from({ length: 33 }, () => ({ path: '/api/a' })) }),
      })
      expect(tooMany.status).toBe(413)
      const wrongMethod = await fetch(batchUrl, { method: 'GET' })
      expect(wrongMethod.status).toBe(405)
      expect((await fetch(`${shell.origin}/__shell__/health`)).status).toBe(200)
    } finally {
      shell.cleanup()
      upstream.stop()
    }
  })

  // #128 聚合档位：full（全开，= #54 原行为，缺省）/ stream（只关整条缓冲）/ none（全关）
  test('stream 档：仍合并，且领头首字节早于 body 读完就拿到', async () => {
    const upstream = startUpstream()
    const shell = withServer(upstream.origin, () => 'stream')
    try {
      const t0 = performance.now()
      const leader = await fetch(`${shell.origin}/api/dribble`)
      expect(leader.status).toBe(200)
      if (leader.body === null) throw new Error('领头没有 body')
      const reader = leader.body.getReader()
      const decoder = new TextDecoder()
      const first = await reader.read()
      if (first.done) throw new Error('领头首段没拿到')
      const firstMs = performance.now() - t0
      let leaderBody = decoder.decode(first.value)
      expect(leaderBody).toBe('head:')
      // 上游第二段 150ms 后才有：首段到手时整条还没读完 ⇒ 没有被整条缓冲。
      expect(firstMs).toBeLessThan(100)

      // 领头还在传时来的跟随者照样搭车：8 个并发只打一次上游（仍在合并）。
      const followers = Promise.all(Array.from({ length: 8 }, () => fetch(`${shell.origin}/api/dribble`)))
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        leaderBody += decoder.decode(next.value)
      }
      expect(leaderBody).toBe('head::tail')
      const bodies = await followers
      for (const body of bodies) expect(await body.text()).toBe('head::tail')
      expect(upstream.count('GET /api/dribble')).toBe(1)

      const health = (await (await fetch(`${shell.origin}/__shell__/health`)).json()) as {
        proxiedInFlight: number
        coalesced: number
      }
      expect(health.coalesced).toBe(8)
      expect(health.proxiedInFlight).toBe(0)
    } finally {
      shell.cleanup()
      upstream.stop()
    }
  })

  test('stream 档：累积超 256KB 放弃共享，跟随者落回自己打一次上游', async () => {
    const upstream = startUpstream()
    const shell = withServer(upstream.origin, () => 'stream')
    try {
      const leader = await fetch(`${shell.origin}/api/big`)
      // 跟随者必须在领头还在传时就发出去（领头 body 512KB，共享在 256KB 处被放弃）
      const followers = Promise.all(Array.from({ length: 2 }, () => fetch(`${shell.origin}/api/big`)))
      expect((await leader.arrayBuffer()).byteLength).toBe(512 * 1024)
      for (const follower of await followers) {
        expect(follower.status).toBe(200)
        expect((await follower.arrayBuffer()).byteLength).toBe(512 * 1024)
      }
      // 领头 1 条 + 两个跟随者各自回落 = 3 条（谁也没拿到对方的 body）
      expect(upstream.count('GET /api/big')).toBe(3)
      const health = (await (await fetch(`${shell.origin}/__shell__/health`)).json()) as {
        proxiedInFlight: number
        coalesced: number
      }
      expect(health.coalesced).toBe(2)
      expect(health.proxiedInFlight).toBe(0)
    } finally {
      shell.cleanup()
      upstream.stop()
    }
  })

  test('none 档：不合并，并发同 URL 各自打上游；不重启切到 full 立即生效', async () => {
    const upstream = startUpstream()
    let mode: LoopbackAggregation = 'none'
    const shell = withServer(upstream.origin, () => mode)
    try {
      const hits = await Promise.all(Array.from({ length: 4 }, () => fetch(`${shell.origin}/api/slow`)))
      for (const hit of hits) expect(hit.status).toBe(200)
      expect(upstream.count('GET /api/slow')).toBe(4)
      const afterNone = (await (await fetch(`${shell.origin}/__shell__/health`)).json()) as { coalesced: number }
      expect(afterNone.coalesced).toBe(0)

      // 同一个服务面直接换档，不重启：8 个并发又只打一次上游（= full 档，#54 原行为）
      mode = 'full'
      const merged = await Promise.all(Array.from({ length: 8 }, () => fetch(`${shell.origin}/api/slow`)))
      for (const hit of merged) expect(hit.status).toBe(200)
      expect(upstream.count('GET /api/slow')).toBe(5)

      const health = (await (await fetch(`${shell.origin}/__shell__/health`)).json()) as {
        proxiedInFlight: number
        coalesced: number
      }
      expect(health.coalesced).toBe(7)
      expect(health.proxiedInFlight).toBe(0)
    } finally {
      shell.cleanup()
      upstream.stop()
    }
  })
})

describe('#168 端口语义：句柄的 origin 一律是真实绑定端口', () => {
  test('port: 0 ⇒ 系统分配；句柄、origin 与 health 三处口径一致，且能直接访问', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'dsh-port0-'))
    // 旧形状：传 0 时 Bun.serve 绑上了临时端口，但句柄回的是「端口 0」的 origin，按它发请求直接报
    // typo/port 错。这里钉死新形状：句柄报真实端口。
    const server = startShellServer({
      distDir: dist,
      token: 'tok',
      cookie: 'dsh-auth-x=v1.y',
      upstreamOrigin: 'http://127.0.0.1:1',
      port: 0,
      bootPayload: () => null,
    })
    try {
      expect(server.port).toBeGreaterThan(0)
      expect(server.origin).toBe(loopbackOrigin(server.port))
      const health = (await (await fetch(`${server.origin}/__shell__/health`)).json()) as {
        ok: boolean
        origin: string
      }
      expect(health.ok).toBe(true)
      expect(health.origin).toBe(server.origin)
    } finally {
      server.stop()
      rmSync(dist, { recursive: true, force: true })
    }
  })

  test('loopbackOrigin：给定端口就是 origin（传具体端口的契约不变）', () => {
    expect(loopbackOrigin(41000)).toBe('http://127.0.0.1:41000')
  })
})
