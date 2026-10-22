// 守护控制通道（map #240 / #242）。
//
// localhost + token 的最小 HTTP 面：壳（#243）与页面回调（#244）从这里读写守护的
// profile 注册表。鉴权完全复用页面 token 的准入口径——同一个头（`x-dsh-shell-view`），
// 但 token 是守护自产的随机值，只经 env 发给自己拉起的壳；没带对 ⇒ 403。
//
// 端口 0（内核分配）：真 origin 写进守护锁（daemon-instance.json 的 origin 字段），
// 谁拿到锁谁拿到地址——和壳服务面回填 shell-instance.json 同一招。

import { VIEW_TOKEN_HEADER } from '../../shared/net/view-grant.ts'
import type { ProfileEntry, ProfileRegistry } from './registry.ts'

export const DAEMON_STATE_PATH = '/__daemon__/state'
export const DAEMON_SHELL_EVENT_PATH = '/__daemon__/shell-event'

/** 壳 → 守护 的事件体（#243 壳侧上报）。 */
export interface ShellEvent {
  type: 'register' | 'heartbeat' | 'exit'
  /** 上报的 profile 名（本地条目 id） */
  profile: string
  pid: number
  /** exit 专属 */
  exitCode?: number | null
}

export interface ControlServerOptions {
  registry: ProfileRegistry
  /** 缺省随机生成（node:crypto 24 字节 hex） */
  token?: string
  port?: number
  hostname?: string
  /** 注入 fetch 做自测（默认全局 fetch） */
  fetchImpl?: typeof fetch
  onLog?: { info: (msg: string, ...rest: unknown[]) => void; warn: (msg: string, ...rest: unknown[]) => void }
}

export interface ControlChannel {
  origin: string
  token: string
  stop: () => void
  /** 仅供测试：直接把一次请求喂给路由层 */
  handle: (request: Request) => Promise<Response>
}

export function parseShellEvent(text: string): ShellEvent | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    const raw = parsed as Record<string, unknown>
    if (raw.type !== 'register' && raw.type !== 'heartbeat' && raw.type !== 'exit') return null
    if (typeof raw.profile !== 'string' || raw.profile === '') return null
    if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0) return null
    return {
      type: raw.type,
      profile: raw.profile,
      pid: raw.pid,
      exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
    }
  } catch {
    return null
  }
}

/** 事件 → 注册表状态迁移（与 spawn.ts 的 classifyShellExit 同口径）。 */
export function applyShellEvent(registry: ProfileRegistry, event: ShellEvent): ProfileEntry | null {
  const profile = event.profile
  switch (event.type) {
    case 'register':
      registry.upsertLocal(profile)
      return registry.markStatus(profile, 'running', event.pid)
    case 'heartbeat':
      return registry.markStatus(profile, 'running', event.pid)
    case 'exit': {
      const crashed = event.exitCode !== null && event.exitCode !== 0
      registry.upsertLocal(profile)
      return registry.markStatus(profile, crashed ? 'crashed' : 'stopped', event.pid)
    }
  }
}

export function startControlServer(options: ControlServerOptions): ControlChannel {
  const token = options.token ?? randomToken()
  const registry = options.registry
  const log = options.onLog

  async function route(request: Request): Promise<Response> {
    if (request.headers.get(VIEW_TOKEN_HEADER) !== token) {
      log?.warn(`控制通道拒绝无凭据请求（${request.method} ${new URL(request.url).pathname}）`)
      return new Response('daemon control token required', { status: 403 })
    }
    const pathname = new URL(request.url).pathname
    if (pathname === DAEMON_STATE_PATH) {
      return Response.json({ profiles: registry.list() })
    }
    if (pathname === DAEMON_SHELL_EVENT_PATH) {
      if (request.method.toUpperCase() !== 'POST') {
        return new Response('method not allowed', { status: 405 })
      }
      const event = parseShellEvent(await request.text().catch(() => ''))
      if (event === null) {
        return Response.json({ ok: false, error: 'bad shell event' }, { status: 400 })
      }
      const entry = applyShellEvent(registry, event)
      return Response.json({ ok: true, entry })
    }
    return new Response('not found', { status: 404 })
  }

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? '127.0.0.1',
    fetch: route,
  })
  const origin = `http://${server.hostname}:${String(server.port)}`
  log?.info(`控制通道就绪 ${origin}`)
  return {
    origin,
    token,
    stop: () => server.stop(true),
    handle: route,
  }
}

function randomToken(): string {
  const crypto = require('node:crypto') as typeof import('node:crypto')
  return crypto.randomBytes(24).toString('hex')
}
