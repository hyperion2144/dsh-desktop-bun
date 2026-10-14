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
import { startShellServer } from '../src/bun/shell-server.ts'
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

/** 拿一个空闲端口（Bun.serve 探针占用后立即放掉）——壳的 port 参数不吃 0（rpc.test 同款）。 */
function takeFreePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('probe') })
  const port = probe.port
  probe.stop(true)
  if (port === undefined) throw new Error('临时端口没拿到')
  return port
}
function withServer(upstreamOrigin: string): { origin: string; cleanup: () => void } {
  const dist = mkdtempSync(join(tmpdir(), 'dsh-dp-'))
  const server = startShellServer({
    distDir: dist,
    token: 'tok',
    cookie: 'dsh-auth-x=v1.y',
    upstreamOrigin,
    port: takeFreePort(),
    bootPayload: () => null,
    onRpc: (raw) => dispatchRpc(createRpcRouter({}), raw),
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
})
