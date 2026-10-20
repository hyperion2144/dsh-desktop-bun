// 「这个更新源背后有没有已发布的 Release」探测（#216）。
// 404 的二义性靠它区分：没发过版 ⇒「暂未发布」；发过版但本平台资产漏传 ⇒ 发布链路故障，必须报错。
import { describe, expect, test } from 'bun:test'
import {
  presenceFromResponse,
  probeReleasePresence,
  releaseAliasUrl,
} from '../src/bun/platform/release-probe.ts'

describe('更新源的 release 别名', () => {
  test('去掉末尾的 /download（GitHub 的 latest/download → latest）', () => {
    expect(releaseAliasUrl('https://github.com/o/r/releases/latest/download')).toBe(
      'https://github.com/o/r/releases/latest'
    )
    expect(releaseAliasUrl('https://github.com/o/r/releases/latest/download/')).toBe(
      'https://github.com/o/r/releases/latest'
    )
  })

  test('别的形状原样保留（本地静态目录等）', () => {
    expect(releaseAliasUrl('http://127.0.0.1:8899/feed')).toBe('http://127.0.0.1:8899/feed')
    expect(releaseAliasUrl('')).toBe('')
  })
})

describe('探测结果判定', () => {
  test('302 到 /releases/tag/... ⇒ 有发布', () => {
    expect(presenceFromResponse(302, 'https://github.com/o/r/releases/tag/v1.2.3')).toBe('present')
  })

  test('302 回 /releases ⇒ 一个 release 都没有', () => {
    expect(presenceFromResponse(302, 'https://github.com/o/r/releases')).toBe('absent')
    expect(presenceFromResponse(302, 'https://github.com/o/r/releases/')).toBe('absent')
  })

  test('200 ⇒ 有发布', () => {
    expect(presenceFromResponse(200, null)).toBe('present')
  })

  test('404 ⇒ 别名页不存在（按没发布算）', () => {
    expect(presenceFromResponse(404, null)).toBe('absent')
  })

  test('认不出的落点/状态 ⇒ 不知道（不猜）', () => {
    expect(presenceFromResponse(302, 'https://example.com/other')).toBe('unknown')
    expect(presenceFromResponse(500, null)).toBe('unknown')
    expect(presenceFromResponse(403, null)).toBe('unknown')
  })
})

describe('探测请求', () => {
  test('HEAD 别名页，并按重定向落点判定', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${String(url)} ${init?.method ?? 'GET'}`)
      return new Response(null, {
        status: 302,
        headers: { location: 'https://github.com/o/r/releases' },
      })
    }) as unknown as typeof fetch
    const presence = await probeReleasePresence(
      'https://github.com/o/r/releases/latest/download',
      { fetchImpl }
    )
    expect(presence).toBe('absent')
    expect(calls[0]).toBe('https://github.com/o/r/releases/latest HEAD')
  })

  test('网络坏了 ⇒ 不知道（不猜）', async () => {
    const fetchImpl = (async () => {
      throw new Error('boom')
    }) as unknown as typeof fetch
    const presence = await probeReleasePresence(
      'https://github.com/o/r/releases/latest/download',
      { fetchImpl }
    )
    expect(presence).toBe('unknown')
  })

  test('空 baseUrl ⇒ 不知道，而且不发请求', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch
    expect(await probeReleasePresence('', { fetchImpl })).toBe('unknown')
    expect(called).toBe(false)
  })
})
