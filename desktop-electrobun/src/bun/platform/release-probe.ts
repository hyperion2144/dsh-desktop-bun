/**
 * 「这个更新源背后有没有已发布的 Release」探测（#216）。
 *
 * 404 有二义性：`releases/latest/download/<资产>` 返回 404，既可能是**还没发过版**，
 * 也可能是**发过版但这个平台的资产漏传**（latest 被别的 release 抢走、资产名对不上）。
 * 前者该显示「暂未发布」，后者是发布链路故障、必须报错——所以壳侧要自己探一下。
 *
 * · GitHub 的 `releases/latest` 别名：有 release 时 302 到 `/releases/tag/<tag>`，
 *   一个 release 都没有时 302 回 `/releases`（2026-10-20 实测）。
 * · 别的源（本地静态目录等）没有这个别名语义，探不到就当「不知道」，不猜。
 */

import { type ReleasePresence } from '../../shared/runtime/update.ts'

/** 去掉末尾的 `/download`（GitHub 的 `releases/latest/download` → `releases/latest`）。 */
export function releaseAliasUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.replace(/\/download$/, '')
}

/** 从状态码 + 重定向落点判断有没有已发布的 Release。 */
export function presenceFromResponse(status: number, location: string | null): ReleasePresence {
  if (status >= 300 && status < 400) {
    const target = (location ?? '').trim()
    if (/\/releases\/tag\//.test(target)) return 'present'
    if (/\/releases\/?$/.test(target)) return 'absent'
    return 'unknown'
  }
  if (status === 200) return 'present'
  if (status === 404) return 'absent'
  return 'unknown'
}

/** 探一次更新源的别名页；网络不通或结构不认识都返回 `unknown`（不猜）。 */
export async function probeReleasePresence(
  baseUrl: string,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<ReleasePresence> {
  const alias = releaseAliasUrl(baseUrl)
  if (alias === '') return 'unknown'
  const doFetch = options.fetchImpl ?? fetch
  try {
    const response = await doFetch(alias, { method: 'HEAD', redirect: 'manual' })
    return presenceFromResponse(response.status, response.headers.get('location'))
  } catch {
    return 'unknown'
  }
}
