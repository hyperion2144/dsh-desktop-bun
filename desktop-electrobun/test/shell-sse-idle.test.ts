// #159：壳 loopback 反代必须让健康但空闲的 SSE 一直开着。
//
// 回归口径：上游首帧后不再写数据；壳若沿用 Bun 默认 idleTimeout（约 10s），
// 连接会以 incomplete chunked 结束，reader 在 20s 计时器之前就拿到 done/错误。
// 修复后 reader 保持 pending，计时器先到；测试本身不依赖壳的日志或自报状态。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startShellServer } from '../src/bun/shell-server.ts'

interface Upstream {
  origin: string
  stop: () => void
}

/** 上游：首帧后保持打开，模拟 /plugins/events 与 /api/auto-continue-bridge 的空闲段。 */
function startSseUpstream(): Upstream {
  const encoder = new TextEncoder()
  const server = Bun.serve({
    port: 0,
    // 上游也要关掉自己的 idleTimeout，避免把「上游先断」误判成壳的问题。
    idleTimeout: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== '/api/sse-idle') return new Response('not found', { status: 404 })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: hello\n\n'))
          },
        }),
        { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } },
      )
    },
  })
  return {
    origin: `http://127.0.0.1:${String(server.port)}`,
    stop: () => server.stop(true),
  }
}


function withServer(upstreamOrigin: string): { origin: string; cleanup: () => void } {
  const dist = mkdtempSync(join(tmpdir(), 'dsh-sse-idle-'))
  const server = startShellServer({
    distDir: dist,
    token: 'tok',
    cookie: 'dsh-auth-x=v1.y',
    upstreamOrigin,
    // #168：端口交给系统分配，句柄里的 origin 就是真实端口（不再「先占后放」挑端口，那个窗口会被抢）。
    port: 0,
    bootPayload: () => null,
  })
  return {
    origin: server.origin,
    cleanup: () => {
      server.stop()
      rmSync(dist, { recursive: true, force: true })
    },
  }
}

describe('#159 空闲 SSE', () => {
  test('越过 Bun 默认 idle 窗口后仍保持打开', async () => {
    const upstream = startSseUpstream()
    const shell = withServer(upstream.origin)
    const controller = new AbortController()
    try {
      const response = await fetch(`${shell.origin}/api/sse-idle`, { signal: controller.signal })
      expect(response.status).toBe(200)
      if (response.body === null) throw new Error('SSE 没有 body')
      const reader = response.body.getReader()
      const first = await reader.read()
      if (first.done) throw new Error('SSE 首帧没拿到')
      expect(new TextDecoder().decode(first.value)).toBe('data: hello\n\n')

      // 默认 ~10s（经壳实测约 12s）会在这之前 done/抛错；修复后计时器先到。
      const next = await Promise.race([
        reader.read().then((chunk) => (chunk.done ? 'closed' : 'data')),
        new Promise<'idle'>((resolve) => setTimeout(() => resolve('idle'), 20_000)),
      ])
      expect(next).toBe('idle')
    } finally {
      controller.abort()
      shell.cleanup()
      upstream.stop()
    }
  }, 30_000)
})
