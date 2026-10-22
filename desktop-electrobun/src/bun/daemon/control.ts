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
export const DAEMON_ACTIVATE_PATH = '/__daemon__/activate'

/** 壳 → 守护 的事件体（#243 壳侧上报）。 */
export interface ShellEvent {
  type: 'register' | 'heartbeat' | 'exit'
  /** 上报的 profile 名（本地条目 id） */
  profile: string
  pid: number
  /** register/exit 专属：壳当前开着的窗口清单（守护重拉壳时透传回 env 恢复）。 */
  openProfiles?: string[]
  /** exit 专属 */
  exitCode?: number | null
  /** exit 专属：restart = 壳自杀由守护立即重拉；缺省 = 普通退出。 */
  exitIntent?: ShellExitIntent
}

/** 壳退出意图（exit 专属）：restart = 壳自杀由守护重拉；quit = 连主进程一起退（win/linux 全退口径，#247）；缺省 = 普通退出。 */
export type ShellExitIntent = 'restart' | 'quit'

/** 守护 → 壳的进程级 env（窗口控制不跨进程——壳自己管窗口，#243 拍板）。 */
export const SHELL_RESTORE_PROFILES_ENV = 'DSH_SHELL_RESTORE_PROFILES'
/** 恢复窗口清单的 env 序列化（逗号分隔；空 = 无恢复）。 */
export function encodeRestoreProfiles(profiles: readonly string[]): string {
  return profiles.filter((p) => p !== '').join(',')
}
export function decodeRestoreProfiles(text: string | undefined): string[] {
  if (text === undefined || text === '') return []
  return text.split(',').filter((p) => p !== '')
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
  /** 事件到达回调（#243：守护用 exit+exitIntent=restart 触发立即重拉；route 内同步调用）。 */
  onEvent?: (event: ShellEvent) => void
  /** 激活回调（#243：第二实例转发「再点图标」意图；主进程用壳没跑才拉的幂等语义）。 */
  onActivate?: () => void
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
        openProfiles: Array.isArray(raw.openProfiles)
          ? raw.openProfiles.filter((p): p is string => typeof p === 'string' && p !== '')
          : undefined,
        exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
        exitIntent: raw.exitIntent === 'restart' || raw.exitIntent === 'quit' ? raw.exitIntent : undefined,
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
      if (event.openProfiles !== undefined) registry.setOpenProfiles(profile, event.openProfiles)
      return registry.markStatus(profile, 'running', event.pid)
    case 'heartbeat':
      return registry.markStatus(profile, 'running', event.pid)
    case 'exit': {
      const crashed = event.exitCode !== null && event.exitCode !== 0
      registry.upsertLocal(profile)
      if (event.openProfiles !== undefined) registry.setOpenProfiles(profile, event.openProfiles)
      return registry.markStatus(profile, crashed ? 'crashed' : 'stopped', event.pid)
    }
  }
}

export function startControlServer(options: ControlServerOptions): ControlChannel {
  const token = options.token ?? randomToken()
  const registry = options.registry
  const log = options.onLog

  async function route(request: Request): Promise<Response> {
    // 激活端点免 token：发送方是同机的第二实例（launcher 层，拿不到守护 token），
    // 且动作幂等（壳活着=不动）——暴露面与风险同原壳服务面的 activate 口径。
    if (new URL(request.url).pathname === DAEMON_ACTIVATE_PATH) {
      if (request.method.toUpperCase() !== 'POST') {
        return new Response('method not allowed', { status: 405 })
      }
      options.onActivate?.()
      return Response.json({ ok: true })
    }
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
      options.onEvent?.(event)
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
