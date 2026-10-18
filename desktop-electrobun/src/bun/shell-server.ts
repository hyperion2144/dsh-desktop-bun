// loopback 服务：页面 origin + 静态资产 + 数据面反代 + WS 隧道。
//
// 为什么是 loopback 而不是自定义协议（ADR 0006）：Electrobun 没有面向应用的自定义
// protocol 注册 API（只有硬编码的 views:// 与 appdata://），而 views:// 在 macOS CEF 下
// `<script src>` 不执行（上游 #237 OPEN）。loopback origin 是真实 origin：secure context、
// localStorage 可写且跨重启存活、SSE/WS 原生可用、cookie 由壳持有——
// 「本地静态 + 数据面同源」对齐官方 Electron 的做法，只是 scheme 名从 dsh-app:// 变成 http://127.0.0.1。
//
// 路由（静态优先，规格第 2 条）：
//   1) 准入判定（token 前缀 / 同源 / 壳自答端点）
//   2) dist 命中就出磁盘文件（本地优先）；index.html 顺带注入 BOOT 行
//   3) 其余一律转发给 Host（/api/*、/plugins/*、插件自带路由、WS 隧道）
//
// 闸门：cookie 由壳持有，转发时剥 set-cookie 与 hop-by-hop 头；/api/* 与 /plugins/* 一律
// no-store。SSE 不再有寿命上限（那与 page_shim 一样是 Tauri 妥协，随迁移删除）。

import { statSync } from 'node:fs'
import { decide } from '../shared/admission.ts'
import { INDEX_FILE, contentTypeFor, isNoContentAsset, resolveAsset } from '../shared/asset-path.ts'
import { corsHeaders, scrubRequestHeaders, scrubResponseHeaders, shouldNoStore } from '../shared/headers.ts'
import { DEFAULT_LOOPBACK_AGGREGATION, type LoopbackAggregation } from '../shared/settings.ts'
import { isExternalUrl } from './external.ts'
import { VIEW_TOKEN_HEADER, denyReason, isCommandAllowed } from '../shared/view-grant.ts'
import type { ViewGrant, ViewRegistry } from '../shared/view-grant.ts'
import { parseContextMenuRequest, type ContextMenuRequest } from './context-menu.ts'
import { FOLLOWER_WAIT_MS, GetCoalescer, aggregationPolicy, type SharedGet } from './coalescing.ts'
import { isWindowControlAction, type WindowControlAction, type WindowMaxState } from './window-max.ts'


/** 官方 web-document.ts 的同一行：index 会等异步的 Host 注入，先把 promise 挂上。 */
export const BOOT_LINE = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>'

/** Bun 的 WebSocket 客户端支持 headers（DOM 类型里没有），收窄成我们用到的那一面。 */
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocket

export interface BootPayload {
  injections: unknown[]
  streamBaseUrl: string
}

export interface ShellServerOptions {
  distDir: string
  token: string
  cookie: string
  /** 上游（Host）origin，如 http://127.0.0.1:55600 */
  upstreamOrigin: string
  port: number
  /** 宿主就绪前返回 null（页面会等 __DSH_BOOT_READY__） */
  bootPayload: () => BootPayload | null
  /** 「在系统浏览器打开」——由主进程实现（Electrobun Utils.openExternal）。 */
  onOpenExternal?: (url: string) => void
  /** 页面右键菜单——由主进程弹原生菜单。 */
  onContextMenu?: (request: ContextMenuRequest) => void
  /** 单实例激活：第二个壳请求把窗口带到前台（主进程实现） */
  onActivate?: () => void
  /** 自绘窗口控制（A5）：页面三键 → 主进程操作 BrowserWindow */
  onWindowControl?: (action: WindowControlAction) => void
  /** 最大化态读取（#112 壳层标题栏带）：GET /__shell__/window 回 { maximized }；缺省时 GET 仍 405 */
  onWindowState?: () => WindowMaxState
  /** F12：页面内确认弹窗的回填（旧壳 ui_input_confirm） */
  onInputConfirm?: (flow: string, value: string) => void
  /** 壳 ↔ 页面 RPC（`/__shell__/rpc`）：调用方给命令表与错误语义，这里只管 HTTP */
  /**
   * 每视图授权（#220 决策 12）：页面桥带 `x-dsh-shell-view` 回来，这里查表拿视图种类。
   * 不给或给了没登记的 token ⇒ 一律拒绝（403）；`shell` 视图放行全部命令，`guest` 只放行白名单。
   * 不传 `views` ⇒ 不做每视图校验（只在测试与旧调用点里出现）。
   */
  views?: ViewRegistry
  /** loopback 数据面聚合档位（#128）；缺省 = 全开。热路径读，不得每次同步读盘。 */
  aggregation?: () => LoopbackAggregation
  /**
   * 单飞跟随者等待上限（#144-1）；缺省 = FOLLOWER_WAIT_MS。
   *
   * 与 `aggregation` 同款的 live getter 形状，但**service.ts 目前没传它**——壳里生效的值就是 10s 常量，
   * 没有对应的设置键。存在的理由是测试要注入 150ms 这种小阈值（10s 的超时路径进不了单测），
   * 以及将来真把它做成设置项时不必改这里的读法。health 同步暴露当前生效值。
   */
  followerWaitMs?: () => number
  onRpc?: (raw: string, grant: ViewGrant | null) => Promise<{ status: number; body: Record<string, unknown> }>
  onLog?: (line: string) => void
}

export interface ShellServer {
  origin: string
  port: number
  stop: () => void
  /** 缝 ① 用的进程内自检视图 */
  health: () => Record<string, unknown>
}

interface WsData {
  upstream?: WebSocket
  queue?: (string | ArrayBufferLike)[]
  path: string
}

export function startShellServer(options: ShellServerOptions): ShellServer {
  const log = options.onLog ?? (() => {})
  const startedAt = Date.now()
  const origin = `http://127.0.0.1:${String(options.port)}`
  const authority = new URL(options.upstreamOrigin).host
  let served = 0
  let proxied = 0
  // 数据面在飞计数（#54）：loopback 反代与批量端点子请求共用一个计数，health 暴露，
  // 用来在 Windows 上区分「壳还在处理请求」与「壳已经闲着」。
  let inFlight = 0
  // 搭车（coalesced）与因等待上限掉队（followerDropouts）的计数归 GetCoalescer（#144-1/#144-3），health 从那里读。

  /**
   * 每视图授权：页面桥带 `x-dsh-shell-view` 回来。missing/未登记 —— 拒绝；
   * 拿到授权后再看命令是否属于该视图的允许集（guest 只留白名单）。
   */
  function authorize(request: Request, command: string | null): { grant: ViewGrant | null; deny: Response | null } {
    if (options.views === undefined) return { grant: null, deny: null }
    const grant = options.views.lookup(request.headers.get(VIEW_TOKEN_HEADER))
    if (grant === null) {
      log(`[shell] 拒绝未登记视图的请求（${command ?? request.url}，token=${request.headers.get(VIEW_TOKEN_HEADER) ?? '无'}）`)
      return { grant: null, deny: new Response('shell view token required', { status: 403 }) }
    }
    if (command !== null && !isCommandAllowed(grant.kind, command)) {
      log(`[shell] 拒绝命令：${denyReason(grant.kind, command)}（${grant.label}）`)
      return { grant, deny: Response.json({ ok: false, error: denyReason(grant.kind, command) }, { status: 403 }) }
    }
    return { grant, deny: null }
  }

  async function serveStatic(rel: string): Promise<Response | null> {
    const file = resolveAsset(options.distDir, rel)
    // 源映射：按现状协议不变量直接 204（不看文件是否存在，也不泄露存在性）
    if (isNoContentAsset(rel)) return new Response(null, { status: 204 })
    if (file === null) return null
    let stat
    try {
      stat = statSync(file)
    } catch {
      return null
    }
    if (stat.isDirectory()) return serveStatic(`${rel.replace(/\/$/, '')}/${INDEX_FILE}`)
    if (!stat.isFile()) return null

    if (rel.endsWith('.html') || rel.endsWith(`/${INDEX_FILE}`)) {
      const raw = await Bun.file(file).text()
      return new Response(injectBoot(raw), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    }
    return new Response(Bun.file(file), {
      status: 200,
      headers: { 'content-type': contentTypeFor(file), 'cache-control': 'no-store' },
    })
  }

  function injectBoot(html: string): string {
    const head = html.indexOf('<head>')
    if (head < 0) return `${BOOT_LINE}\n${html}`
    const insertAt = head + '<head>'.length
    return `${html.slice(0, insertAt)}${BOOT_LINE}${html.slice(insertAt)}`
  }

  /** 共享体的定义、在飞登记表与跟随者等待都在 coalescing.ts（#144-3）；proxy() 只读它导出的结果。 */
  /** 共享体的体积上限（#128）：`full` 档按 content-length 预先判定，`stream` 档按实际累积量封顶——超了放弃共享，绝不无限缓冲。 */
  const SINGLEFLIGHT_MAX_BYTES = 262_144
  /**
   * 档位读取（#128）：缺省 = 全开。每个请求在 proxy() 入口取一次，同请求内不重复读；
   * 调用方给的是内存 getter（liveSettings），切档即时生效且热路径零磁盘 IO。
   */
  const aggregation = (): LoopbackAggregation => options.aggregation?.() ?? DEFAULT_LOOPBACK_AGGREGATION
  const coalescer = new GetCoalescer()
  /** 跟随者等待上限（#144-1）：live getter，缺省 FOLLOWER_WAIT_MS。health 暴露当前值。 */
  const followerWaitMs = (): number => options.followerWaitMs?.() ?? FOLLOWER_WAIT_MS

  /**
   * 流式回传 + 完成结算（#54）：pull 式逐 chunk 转发（保背压），done / 上游出错 / 页面取消
   * 三个终点都恰好结算一次——在飞计数不泄漏，SLOW 日志能拿到 total（含流式体传输时间）。
   */
  function trackedResponse(input: {
    status: number
    headers: Headers
    body: ReadableStream<Uint8Array>
    method: string
    pathname: string
    ttfbMs: number
    t0: number
    onSettled: () => void
  }): Response {
    const reader = input.body.getReader()
    let settledOnce = false
    const finish = (totalMs: number): void => {
      if (settledOnce) return
      settledOnce = true
      input.onSettled()
      // P1（旧壳 stream_proxy.rs:456 SLOW 口径）：任一段 ≥2s 记一条。ttfb=「发 fetch → 上游
      // 响应头」（读作上游慢或壳进程堵），total=整条响应（读作传输/排队慢）。
      if (input.ttfbMs >= 2_000 || totalMs >= 2_000) {
        log(`[proxy] SLOW ttfb=${input.ttfbMs}ms total=${totalMs}ms ${input.method} ${input.pathname} -> ${input.status}`)
      }
    }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            finish(Math.round(performance.now() - input.t0))
          } else {
            controller.enqueue(value)
          }
        } catch (error) {
          controller.error(error)
          finish(Math.round(performance.now() - input.t0))
        }
      },
      cancel(reason) {
        void reader.cancel(reason).catch(() => {})
        finish(Math.round(performance.now() - input.t0))
      },
    })
    return new Response(stream, { status: input.status, headers: input.headers })
  }
  /** 累积的 chunk 拼成一份 ArrayBuffer（跟随者拿到的就是这一份）。 */
  function concatChunks(chunks: Uint8Array[], total: number): ArrayBuffer {
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out.buffer
  }

  /**
   * `stream` 档的领头 body（#128）：pull 式逐 chunk 转发给页面（保背压），同时旁路累积一份——
   * 首个 chunk 一到就下发，首字节不再等整条读完。累积总量超上限立刻放弃共享并丢掉已累积的引用（内存有界）；
   * 读完且在限额内才 settle 一份给跟随者（仍在合并）。读失败 / 页面取消 / 超限 ⇒ settle(null)，
   * 跟随者各自回落打一次上游。settle 恰好一次。
   */
  function teeSharedBody(
    source: ReadableStream<Uint8Array>,
    head: { status: number; headers: Headers },
    settle: (value: SharedGet | null) => void,
  ): ReadableStream<Uint8Array> {
    const reader = source.getReader()
    const chunks: Uint8Array[] = []
    let accumulated = 0
    let shareable = true
    let settled = false
    const finish = (value: SharedGet | null): void => {
      if (settled) return
      settled = true
      chunks.length = 0
      settle(value)
    }
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            finish(shareable ? { status: head.status, headers: head.headers, body: concatChunks(chunks, accumulated) } : null)
            return
          }
          controller.enqueue(value)
          if (!shareable) return
          accumulated += value.byteLength
          if (accumulated > SINGLEFLIGHT_MAX_BYTES) {
            shareable = false
            chunks.length = 0
            return
          }
          chunks.push(value)
        } catch (error) {
          controller.error(error)
          finish(null)
        }
      },
      cancel(reason) {
        void reader.cancel(reason).catch(() => {})
        finish(null)
      },
    })
  }

  // ---- 批量转发端点（#54 数据面聚合）：一次 POST 携 N 个子请求，并发转发、按序聚合 ----
  const BATCH_MAX_ITEMS = 32
  interface BatchSubResponse {
    status: number
    contentType: string | null
    body: string
    ttfbMs: number
    error?: string
  }

  function subRequestHeaders(raw: unknown): Headers | null {
    if (raw === undefined || raw === null) return new Headers()
    if (typeof raw !== 'object' || Array.isArray(raw)) return null
    const out = new Headers()
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'string') return null
      out.set(key, value)
    }
    return out
  }

  async function forwardBatchItem(item: unknown): Promise<BatchSubResponse> {
    const invalid = (): BatchSubResponse => ({ status: 400, contentType: null, body: 'bad sub-request', ttfbMs: 0, error: 'invalid sub-request' })
    if (typeof item !== 'object' || item === null) return invalid()
    const row = item as { method?: unknown; path?: unknown; query?: unknown; body?: unknown; headers?: unknown }
    if (typeof row.path !== 'string' || !row.path.startsWith('/')) return invalid()
    const method = (typeof row.method === 'string' && row.method !== '' ? row.method : 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') return invalid()
    let query = typeof row.query === 'string' ? row.query : ''
    if (query.startsWith('?')) query = query.slice(1)
    const rawHeaders = subRequestHeaders(row.headers)
    if (rawHeaders === null) return invalid()
    const hasBody = method !== 'GET' && method !== 'HEAD'
    const body = hasBody && typeof row.body === 'string' ? row.body : undefined
    const target = `${options.upstreamOrigin}${row.path}${query === '' ? '' : `?${query}`}`
    proxied += 1
    inFlight += 1
    const t0 = performance.now()
    try {
      const upstream = await fetch(target, {
        method,
        headers: scrubRequestHeaders(rawHeaders, { cookie: options.cookie, authority }),
        body,
        redirect: 'manual',
      })
      const ttfbMs = Math.round(performance.now() - t0)
      const text = await upstream.text()
      inFlight = Math.max(0, inFlight - 1)
      return { status: upstream.status, contentType: upstream.headers.get('content-type'), body: text, ttfbMs }
    } catch (error) {
      inFlight = Math.max(0, inFlight - 1)
      return { status: 502, contentType: null, body: 'upstream unreachable', ttfbMs: Math.round(performance.now() - t0), error: String(error) }
    }
  }

  async function proxy(request: Request, pathname: string, search: string): Promise<Response> {
    proxied += 1
    const method = request.method.toUpperCase()
    const key = `${pathname}${search}`
    // #128：档位每请求读一次，同请求内不再读——中途切档只影响后续请求，不会把在飞请求换语义。
    const mode = aggregation()
    // #144-3：档位判别只有这一处——后续只 switch 策略标签，不再比较档位字符串、不再持有派生的布尔量。
    const policy = aggregationPolicy(mode)

    // ---- GET 单飞（#54）：并发同 URL 搭领头请求的车，不重复打上游；等满上限就自己打一次（#144-1）----
    const riding = policy.kind === 'passthrough' || method !== 'GET' ? undefined : coalescer.peek(key)
    if (riding !== undefined && !riding.done) {
      inFlight += 1
      const t0 = performance.now()
      const outcome = await coalescer.wait(riding, request.signal, followerWaitMs())
      inFlight = Math.max(0, inFlight - 1)
      if (outcome.kind === 'shared') {
        // 缓冲路径：拿到共享响应即整条完成（body ≤256KB 才会走到这）
        const shared = outcome.shared
        const totalMs = Math.round(performance.now() - t0)
        if (totalMs >= 2_000) {
          log(`[proxy] SLOW ttfb=${totalMs}ms total=${totalMs}ms ${method} ${pathname} -> ${shared.status}（单飞跟随）`)
        }
        return new Response(shared.body, { status: shared.status, headers: new Headers(shared.headers) })
      }
      if (outcome.kind === 'aborted') {
        // 页面自己断了：不再占资源，也不该替它去打上游（#144-1）。
        log(`[proxy] 跟随者被页面取消，放弃 ${method} ${pathname}`)
        return new Response(null, { status: 499 })
      }
      // unshared（领头失败/不可共享）或 timeout（等满上限掉队）⇒ 落回自己打一次。
      // 这一支安全的前提：这个请求从头到尾没发出去过，「自己再发一次」不产生重复副作用——
      // 也正是因此绝不给任何**已发出**的请求加自动重试（#54 拍板的架构口径）。
      log(`[proxy] 跟随者${outcome.kind === 'timeout' ? '等满上限掉队' : '没拿到共享响应'}，自己打一次 ${method} ${pathname}`)
    }

    inFlight += 1
    const target = `${options.upstreamOrigin}${pathname}${search}`
    const headers = scrubRequestHeaders(request.headers, { cookie: options.cookie, authority })
    const hasBody = method !== 'GET' && method !== 'HEAD'
    let upstream: Response
    const t0 = performance.now()

    // 领头占位：先登记再发上游，并发同 URL 才赶得上搭车（passthrough 档与非 GET 压根不登记）。
    const entry = policy.kind === 'passthrough' || method !== 'GET' ? null : coalescer.claim(key)

    try {
      upstream = await fetch(target, {
        method,
        headers,
        body: hasBody ? request.body : undefined,
        redirect: 'manual',
      })
    } catch (error) {
      inFlight = Math.max(0, inFlight - 1)
      coalescer.settle(key, entry, null)
      log(`[shell] 转发失败 ${method} ${pathname}: ${String(error)}`)
      return new Response('upstream unreachable', { status: 502 })
    }
    const ttfbMs = Math.round(performance.now() - t0)
    const outHeaders = scrubResponseHeaders(upstream.headers, { pathname })
    if (upstream.status >= 500) log(`[proxy] 上游 ${upstream.status} ${method} ${pathname}（ttfb=${ttfbMs}ms）`)

    // 可共享判定：只合并「带 content-length 且 ≤256KB」的 GET——大响应与流式（SSE/chunked）
    // 一律不缓冲，避免内存膨胀与背压变化。
    const onSettled = (): void => {
      inFlight = Math.max(0, inFlight - 1)
    }

    // `stream` 档（#128）：领头立刻流式下发（首字节不等整条读完），边转发边旁路累积一份给跟随者。
    // 不看 content-length，靠实际累积量封顶；超限 / 读失败 / 页面取消 ⇒ 跟随者回落自己打一次。
    // 判定只看策略标签：streamed 走下面这段，buffered 落到 full 段，passthrough 压根没有 entry。
    if (policy.kind === 'coalesced-streamed' && entry !== null) {
      const inflight = entry
      const streamed = upstream.body
      if (streamed === null) {
        coalescer.settle(key, entry, null)
        onSettled()
        return new Response(null, { status: upstream.status, headers: outHeaders })
      }
      return trackedResponse({
        status: upstream.status,
        headers: outHeaders,
        body: teeSharedBody(streamed, { status: upstream.status, headers: outHeaders }, (value) => {
          coalescer.settle(key, inflight, value)
        }),
        method,
        pathname,
        ttfbMs,
        t0,
        onSettled,
      })
    }

    // `full`（默认，= #54 原行为）：只合并「带 content-length 且 ≤256KB」的 GET——大响应与流式
    // （SSE/chunked）一律不缓冲，避免内存膨胀与背压变化。`none` 档压根没有 entry，整段跳过。
    let shared: SharedGet | null = null
    if (entry !== null && upstream.body !== null) {
      const length = Number(upstream.headers.get('content-length'))
      if (Number.isFinite(length) && length >= 0 && length <= SINGLEFLIGHT_MAX_BYTES) {
        try {
          shared = { status: upstream.status, headers: outHeaders, body: await upstream.arrayBuffer() }
        } catch {
          shared = null
        }
      }
    }
    coalescer.settle(key, entry, shared)
    if (shared !== null) {
      onSettled()
      const totalMs = Math.round(performance.now() - t0)
      if (ttfbMs >= 2_000 || totalMs >= 2_000) {
        log(`[proxy] SLOW ttfb=${ttfbMs}ms total=${totalMs}ms ${method} ${pathname} -> ${shared.status}`)
      }
      return new Response(shared.body, { status: shared.status, headers: new Headers(shared.headers) })
    }
    if (upstream.body === null) {
      onSettled()
      return new Response(null, { status: upstream.status, headers: outHeaders })
    }
    return trackedResponse({
      status: upstream.status,
      headers: outHeaders,
      body: upstream.body,
      method,
      pathname,
      ttfbMs,
      t0,
      onSettled,
    })
  }

  const server = Bun.serve<WsData, string>({
    hostname: '127.0.0.1',
    port: options.port,
    // #159：Bun 默认 ~10s idleTimeout 会切断首帧后空闲的健康 SSE（/plugins/events、
    // /api/auto-continue-bridge），页面看到 ERR_INCOMPLETE_CHUNKED_ENCODING。这里显式关闭；
    // 该口只绑 127.0.0.1，不设有限值以免任何有限超时在 SSE 空闲时重演本次断流。
    idleTimeout: 0,
    async fetch(request, srv) {
      const url = new URL(request.url)
      const decision = decide({
        pathname: url.pathname,
        token: options.token,
        origin: request.headers.get('origin'),
        secFetchSite: request.headers.get('sec-fetch-site'),
        selfOrigin: origin,
      })

      if (decision.kind === 'reject') {
        log(`[shell] 拒绝跨站请求 ${url.pathname}（origin=${request.headers.get('origin') ?? '-'}）`)
        return new Response('forbidden', { status: decision.status ?? 403 })
      }

      if (request.method.toUpperCase() === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) })
      }

      if (decision.kind === 'shell') {
        if (decision.rel === 'health') {
          return Response.json(health())
        }
        if (decision.rel === 'boot') {
          const bootAuth = authorize(request, null)
          if (bootAuth.deny !== null) return bootAuth.deny
          const payload = options.bootPayload()
          if (payload === null) return new Response('boot pending', { status: 503 })
          return Response.json(payload, { headers: { 'cache-control': 'no-store' } })
        }
        // 壳 ↔ 页面 RPC（旧壳 Tauri IPC 的等价物）：壳自己的客户端插件靠它拿环境、读写设置
        if (decision.rel === 'rpc') {
          if (request.method.toUpperCase() !== 'POST') return new Response('method not allowed', { status: 405 })
          if (options.onRpc === undefined) return new Response('rpc unavailable', { status: 501 })
          const raw = await request.text()
          const parsed = ((): { cmd?: unknown } | null => {
            try {
              return JSON.parse(raw) as { cmd?: unknown }
            } catch {
              return null
            }
          })()
          const command = typeof parsed?.cmd === 'string' ? parsed.cmd : null
          const rpcAuth = authorize(request, command)
          if (rpcAuth.deny !== null) return rpcAuth.deny
          const result = await options.onRpc(raw, rpcAuth.grant)
          return Response.json(result.body, {
            status: result.status,
            headers: { 'cache-control': 'no-store' },
          })
        }
        // 外链：交给系统浏览器（页面里 window.open / 点击 / 中键都走这里）
        if (decision.rel === 'open-external') {
          if (request.method.toUpperCase() !== 'POST') return new Response('method not allowed', { status: 405 })
          if (options.onOpenExternal === undefined) return new Response('no window host', { status: 501 })
          const externalAuth = authorize(request, null)
          if (externalAuth.deny !== null) return externalAuth.deny
          const body = (await request.json().catch(() => null)) as { url?: unknown } | null
          const target = typeof body?.url === 'string' ? body.url : ''
          if (target === '' || !isExternalUrl(target, origin)) {
            log(`[shell] 拒绝外链 ${target}`)
            return new Response('not an external url', { status: 400 })
          }
          options.onOpenExternal(target)
          log(`[shell] 外链转系统浏览器 ${target}`)
          return new Response(null, { status: 204 })
        }
        // 右键菜单：页面把上下文报过来，主进程弹原生菜单
        if (decision.rel === 'context-menu') {
          if (request.method.toUpperCase() !== 'POST') return new Response('method not allowed', { status: 405 })
          if (options.onContextMenu === undefined) return new Response('no window host', { status: 501 })
          // 鉴权与 open-external 同级（#130）：任何**已登记视图**都能弹，不再按命令白名单细分。
          // 叠在解析之前：未登记视图连请求体都不读。
          const menuAuth = authorize(request, null)
          if (menuAuth.deny !== null) return menuAuth.deny
          // 字段归一化只有一份实现（#144-2）：与 commands.ts 的 show_context_menu 共用同一个解析器，
          // 改一边忘另一边导致的漂移就此消失。
          options.onContextMenu(parseContextMenuRequest(await request.json().catch(() => null)))
          return new Response(null, { status: 204 })
        }
        // 单实例：第二个壳请已有实例把窗口带到前台（不占端口、不起宿主）
        if (decision.rel === 'activate') {
          if (request.method.toUpperCase() !== 'POST') return new Response('method not allowed', { status: 405 })
          if (options.onActivate === undefined) return new Response('no window host', { status: 501 })
          options.onActivate()
          log('[shell] 收到激活请求：窗口带到前台')
          return new Response(null, { status: 204 })
        }
        // 自绘窗口控制（A5）：最小化 / 最大化切换 / 关闭
        if (decision.rel === 'window') {
          if (request.method.toUpperCase() === 'GET') {
            if (options.onWindowState === undefined) return new Response('method not allowed', { status: 405 })
            return Response.json(options.onWindowState(), { headers: { 'cache-control': 'no-store' } })
          }
          if (request.method.toUpperCase() !== 'POST') return new Response('method not allowed', { status: 405 })
          if (options.onWindowControl === undefined) return new Response('no window host', { status: 501 })
          // 变更态也叠鉴权（#130）；上面的 GET 只读 window state，保持不鉴权（与 window_get_state 一致）。
          const windowAuth = authorize(request, null)
          if (windowAuth.deny !== null) return windowAuth.deny
          let action = ''
          try {
            const body = (await request.json()) as { action?: unknown }
            if (typeof body.action === 'string') action = body.action
          } catch {
            return new Response('bad json', { status: 400 })
          }
          if (!isWindowControlAction(action)) {
            return new Response(`unknown window action: ${action}`, { status: 400 })
          }
          options.onWindowControl(action)
          return new Response(null, { status: 204 })
        }
        // F9：托盘弹框的新建/迁移 profile 表单提交
        // F12：页面内确认弹窗的回填端点（旧壳 ui_input_confirm 的 HTTP 形态）
        if (decision.rel === 'input-confirm') {
          if (request.method.toUpperCase() !== 'POST') return new Response('method not allowed', { status: 405 })
          if (options.onInputConfirm === undefined) return new Response('no listener', { status: 501 })
          // 回填能解答挂起的确认弹窗，不鉴权等于任何人可代答（#130）。
          const confirmAuth = authorize(request, null)
          if (confirmAuth.deny !== null) return confirmAuth.deny
          let body: { flow?: unknown; value?: unknown }
          try {
            body = (await request.json()) as { flow?: unknown; value?: unknown }
          } catch {
            return new Response('bad json', { status: 400 })
          }
          if (typeof body.flow !== 'string') return new Response('bad flow', { status: 400 })
          options.onInputConfirm(body.flow, typeof body.value === 'string' ? body.value : '')
          return new Response(null, { status: 204 })
        }
        // 批量转发（#54 数据面聚合）：一次 POST 携 N 个子请求，壳并发转发、按序聚合返回；
        // 单个子请求失败不拖垮整批（各自回状态码）。整包响应 no-store。
        if (decision.rel === 'batch') {
          if (request.method.toUpperCase() !== 'POST') return new Response('method not allowed', { status: 405 })
          // 批量转发会替调用方打上游，叠鉴权（#130）；手机端走 lane 纯 TCP 转发，早已被同源闸门挡在外。
          const batchAuth = authorize(request, null)
          if (batchAuth.deny !== null) return batchAuth.deny
          const parsed = (await request.json().catch(() => null)) as { requests?: unknown } | null
          const items = Array.isArray(parsed?.requests) ? (parsed as { requests: unknown[] }).requests : null
          if (items === null || items.length === 0) return new Response('bad batch', { status: 400 })
          if (items.length > BATCH_MAX_ITEMS) return new Response('batch too large', { status: 413 })
          const responses = await Promise.all(items.map((item) => forwardBatchItem(item)))
          return Response.json({ responses }, { headers: { 'cache-control': 'no-store' } })
        }
        return new Response('not found', { status: 404 })
      }

      // WS 隧道：升级本地连接，再开一条到上游的双向管道
      if ((request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') {
        const upgraded = srv.upgrade(request, { data: { path: `${decision.stripped}${url.search}` } })
        if (upgraded) return undefined as unknown as Response
        return new Response('upgrade failed', { status: 400 })
      }

      // 静态只服务文档类（带 token）——根绝对路径不打 token，不能从 dist 出东西
      const staticHit = decision.kind === 'document' ? await serveStatic(decision.rel) : null
      if (staticHit !== null) {
        served += 1
        return staticHit
      }
      if (isNoContentAsset(url.pathname)) return new Response(null, { status: 204 })
      // 文档类未命中本地 dist：按剥掉 token 的路径转发（插件客户端脚本就走 token 前缀下）
      return proxy(request, decision.stripped, url.search)
    },
    websocket: {
      open(ws) {
        const data = ws.data
        const target = `ws://${authority}${data.path}`
        const upstream = new BunWebSocket(target, { headers: { cookie: options.cookie } })
        data.upstream = upstream
        upstream.addEventListener('open', () => {
          for (const item of data.queue ?? []) upstream.send(item)
          data.queue = []
        })
        upstream.addEventListener('message', (event) => {
          const payload = event.data
          if (typeof payload === 'string') ws.send(payload)
          else if (payload instanceof ArrayBuffer) ws.send(payload)
          else ws.send(String(payload))
        })
        upstream.addEventListener('close', () => ws.close())
        upstream.addEventListener('error', () => ws.close())
      },
      message(ws, message) {
        const upstream = ws.data.upstream
        if (upstream === undefined || upstream.readyState !== WebSocket.OPEN) {
          ws.data.queue = [...(ws.data.queue ?? []), message as string | ArrayBufferLike]
          return
        }
        upstream.send(message as string | ArrayBufferLike)
      },
      close(ws) {
        try {
          ws.data.upstream?.close()
        } catch {}
      },
    },
  })

  function health(): Record<string, unknown> {
    const boot = options.bootPayload()
    return {
      ok: true,
      pid: process.pid,
      origin,
      upstream: options.upstreamOrigin,
      token: options.token,
      injections: boot?.injections.length ?? 0,
      bootReady: boot !== null,
      served,
      proxied,
      proxiedInFlight: inFlight,
      coalesced: coalescer.joined,
      // #144-1：跟随者等满上限掉队的次数（>0 ⇒ 上游曾卡住并拖住过一批搭车请求）+ 当前等待阈值。
      followerDropouts: coalescer.dropouts,
      followerWaitMs: followerWaitMs(),
      uptimeMs: Date.now() - startedAt,
    }
  }

  log(`[shell] loopback origin = ${origin} | 页面 = ${origin}/${options.token}/ | 上游 = ${options.upstreamOrigin}`)

  return {
    origin,
    port: options.port,
    health,
    stop: () => {
      void server.stop(true)
    },
  }
}

export { shouldNoStore }
