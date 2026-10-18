/**
 * 账号登录的纯判定层（#169）：把宿主 account/watch 的投影变成「该给系统浏览器哪个地址」。
 *
 * 分工：本文件只做字段判定与地址整形（能单测）；socket 生命周期在 `bun/account-watcher.ts`。
 * 协议只认官方投影里的 attempt.id / attempt.phase / attempt.authorizeUrl（apps/desktop/src/
 * account-backend.ts 的 accountView 同一口径），其它字段一概不看——跨版本协议变化不该把登录弄挂。
 */
import type { ShellThemePreference } from './shell-theme.ts'

/** 账号投影里跟登录跳转有关的那一小块。 */
export interface SignInAttemptView {
  id: string
  phase: string
  authorizeUrl?: string
}

/** 从一次 account/watch 投影里抽 attempt；形状不对就当没有。 */
export function readSignInAttempt(value: unknown): SignInAttemptView | null {
  if (typeof value !== 'object' || value === null) return null
  const attempt = (value as { attempt?: unknown }).attempt
  if (typeof attempt !== 'object' || attempt === null) return null
  const record = attempt as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return null
  if (typeof record.phase !== 'string' || record.phase === '') return null
  return {
    id: record.id,
    phase: record.phase,
    ...(typeof record.authorizeUrl === 'string' && record.authorizeUrl !== ''
      ? { authorizeUrl: record.authorizeUrl }
      : {}),
  }
}

/**
 * 只有「等待浏览器」且本 attempt 还没开过时才给出要打开的地址。
 * @returns 新去重键与待打开 URL（url 为 null = 这次不打开）。
 */
export function loginUrlToOpen(value: unknown, openedAttempt: string): { openedAttempt: string; url: string | null } {
  const attempt = readSignInAttempt(value)
  if (attempt === null || attempt.phase !== 'waiting-browser') return { openedAttempt, url: null }
  if (attempt.id === openedAttempt || attempt.authorizeUrl === undefined) return { openedAttempt, url: null }
  return { openedAttempt: attempt.id, url: attempt.authorizeUrl }
}

/**
 * 官方 desktop 的 platformLoginUrl：授权页跟随壳的浅/深色。
 * `system` 不塞参数，交给页面自己的媒体查询（壳不替它在「系统色」与「页面默认」之间拍板）。
 */
export function platformLoginUrl(authorizeUrl: string, theme: ShellThemePreference): string {
  const url = new URL(authorizeUrl)
  if (theme !== 'system') url.searchParams.set('theme', theme)
  return url.href
}

/** 只放 https 或本机 loopback 的 http（官方 validateBrowserDestination 的同口径）。 */
export function isOpenableLoginUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username !== '' || url.password !== '') return false
    if (url.protocol === 'https:') return true
    if (url.protocol !== 'http:') return false
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}
