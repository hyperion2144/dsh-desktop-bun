// 准入（规格第 2 条闸门口径）：两类准入 + 壳自答端点。
//
// ① 文档与静态资产走「每次启动的 token 路径前缀」，不匹配一律 404（不泄露存在性）；
// ② 数据面（RPC / SSE / WS 隧道 / 插件资产）以**根绝对路径**发出——dsh 会绕开 <base>，
//    所以对它们不做 token 前缀要求，改用「同源校验（Origin / Sec-Fetch-Site）+ 拒绝跨站」；
// ③ 壳自答端点（/__shell__/*）本地应答，但不豁免网络准入（仍须同源）。
//
// 为什么数据面不能要 token：`/api/...` 是根绝对路径（#219 实测：页面发出的 RPC、
// SSE、插件资产都不带启动令牌前缀），给它们加 token 要求就是全站 404。

export const SHELL_PREFIX = '/__shell__/'
export const FORBIDDEN_STATUS = 403
export const MISSING_STATUS = 404

export type AdmissionKind = 'shell' | 'document' | 'data' | 'reject'

export interface AdmissionDecision {
  kind: AdmissionKind
  /** document：已剥 token 的相对路径（默认补成 /index.html）；其余：原始 pathname */
  rel: string
  /** 转发用：已剥 token 但**不**补 index.html 的路径（/plugins/ 这类端点靠查询串寻址） */
  stripped: string
  status?: number
  reason?: string
}

export interface AdmissionInput {
  pathname: string
  token: string
  origin?: string | null
  secFetchSite?: string | null
  /** 请求方法与 Fetch Metadata 的顶层导航标记：只给 OAuth 回调那条窄豁免用（#169）。 */
  method?: string
  secFetchMode?: string | null
  secFetchDest?: string | null
  selfOrigin: string
}

/** 命中「/<token>/…」返回剥掉前缀的路径；`/<token>` 本身当根；否则 null。 */
export function stripToken(pathname: string, token: string): string | null {
  if (token === '') return null
  const prefix = `/${token}`
  if (pathname === prefix || pathname === `${prefix}/`) return '/'
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length)
  return null
}

/** 同源判据：Sec-Fetch-Site 只在明确跨站时拒绝；Origin 与自身 origin 不等即拒绝。 */
export function isCrossSite(input: Pick<AdmissionInput, 'origin' | 'secFetchSite' | 'selfOrigin'>): boolean {
  const { origin, secFetchSite, selfOrigin } = input
  if (
    secFetchSite !== undefined &&
    secFetchSite !== null &&
    secFetchSite !== '' &&
    secFetchSite !== 'same-origin' &&
    secFetchSite !== 'none'
  ) {
    return true
  }
  if (origin !== undefined && origin !== null && origin !== '' && origin !== selfOrigin) return true
  return false
}

/** OAuth 回调端点：唯一允许跨站进来的路径（浏览器从平台页顶层跳回）。 */
export const OAUTH_CALLBACK_PATH = '/oauth/callback'

/**
 * 窄豁免（#169）：只放「跨站 + GET + 顶层文档导航 + 精确 /oauth/callback」。
 * 校验面与另外几道闸门配合，缺一不可：
 *   · 只认 GET：回调是浏览器导航，POST/预检一律不放；
 *   · 只认 Sec-Fetch-Mode: navigate：Fetch Metadata 由浏览器自己写、页面脚本改不了，
 *     iframe 的嵌套文档（nested-navigate）与 fetch/XHR（cors/no-cors）都不算；
 *   · Dest 有值就只能是 document：图片/script 等子资源加载不放；
 *   · 精确路径：查询串（code/state）照常转发，路径本身不给通配。
 * 代价与收益见 docs/adr/0005-oauth-callback-admission-exemption.md。
 */
export function isOAuthCallbackNavigation(
  input: Pick<AdmissionInput, 'pathname' | 'method' | 'secFetchMode' | 'secFetchDest'>,
): boolean {
  if (input.pathname !== OAUTH_CALLBACK_PATH) return false
  if ((input.method ?? 'GET').toUpperCase() !== 'GET') return false
  if (input.secFetchMode !== 'navigate') return false
  if (input.secFetchDest !== undefined && input.secFetchDest !== null && input.secFetchDest !== 'document') {
    return false
  }
  return true
}

export function decide(input: AdmissionInput): AdmissionDecision {
  const { pathname, token } = input
  if (isCrossSite(input)) {
    // #169：OAuth 回调是唯一放行的跨站请求（浏览器从平台页顶层跳回），其余照旧 403。
    if (isOAuthCallbackNavigation(input)) {
      return { kind: 'data', rel: pathname, stripped: pathname }
    }
    return { kind: 'reject', rel: pathname, stripped: pathname, status: FORBIDDEN_STATUS, reason: 'cross-site' }
  }
  if (pathname.startsWith(SHELL_PREFIX)) return { kind: 'shell', rel: pathname.slice(SHELL_PREFIX.length), stripped: pathname }
  const rel = stripToken(pathname, token)
  if (rel !== null) return { kind: 'document', rel: normalizeRel(rel), stripped: rel }
  return { kind: 'data', rel: pathname, stripped: pathname }
}

/** 目录型路径补 index.html；`/` 与空串都指向首页。 */
export function normalizeRel(rel: string): string {
  if (rel === '' || rel === '/') return '/index.html'
  if (rel.endsWith('/')) return `${rel}index.html`
  return rel
}

export function sameOriginOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}
