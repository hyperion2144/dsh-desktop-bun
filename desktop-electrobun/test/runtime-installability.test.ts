import { describe, expect, test } from 'bun:test'
import {
  firstPartyPinned,
  installableVersions,
  NPM_REGISTRY_ORIGIN,
  packageDocUrl,
  runtimeInstallability,
} from '../src/shared/runtime-installability.ts'
import { NPM_PACKAGE } from '../src/shared/runtime-catalog.ts'

interface RegistryStub {
  /** 包名 → 该包有哪些版本在架。 */
  published: Record<string, readonly string[]>
  /** 强制报错的包名（模拟离线 / 超时 / registry 500）。 */
  failing?: readonly string[]
  requested?: string[]
  /** 顶层包的依赖清单。缺省 = 桩里「该版本在架」的兄弟包各 pin 一份。
   *  实机那个坑要显式给：顶层包照样 pin 着还没发的兄弟包（这正是 pnpm 报错的原因）。 */
  deps?: Record<string, string>
  concurrency?: { now: number; peak: number }
}

/** registry 桩：只有 published 里列着的版本才算存在，其余回 404。 */
function stubRegistry(stub: RegistryStub): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input)
    stub.requested?.push(url)
    stub.concurrency !== undefined && (stub.concurrency.now += 1, stub.concurrency.peak = Math.max(stub.concurrency.peak, stub.concurrency.now))
    await Promise.resolve()
    stub.concurrency !== undefined && (stub.concurrency.now -= 1)

    const match = new RegExp(`${NPM_REGISTRY_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+)/([^/?]+)`).exec(url)
    const name = match?.[1] === undefined ? '' : decodeURIComponent(match[1])
    const version = match?.[2] === undefined ? '' : decodeURIComponent(match[2])
    if (stub.failing?.includes(name) === true) throw new Error('fetch failed（桩：断网）')
    const versions = stub.published[name]
    if (versions === undefined || !versions.includes(version)) {
      return new Response('{"error":"Not found"}', { status: 404 })
    }
    // 顶层包的依赖清单：真实 registry 上它 pin 什么就写什么，哪怕那个包还没发。
    // 桩默认只 pin「该版本在架」的兄弟包；要复现错位就显式传 deps。
    let dependencies: Record<string, string> = stub.deps ?? {}
    if (name === NPM_PACKAGE && stub.deps === undefined) {
      for (const [other, otherVersions] of Object.entries(stub.published)) {
        if (other !== name && otherVersions.includes(version)) dependencies[other] = version
      }
    }
    return new Response(JSON.stringify({ name, version, dependencies }), { status: 200 })
  }) as unknown as typeof fetch
}

describe('packageDocUrl / firstPartyPinned', () => {
  test('scoped 包的文档地址要把 @ 和 / 编码掉', () => {
    expect(packageDocUrl('@deepseek-ai/dsh', '0.2.1-rc.2')).toBe(`${NPM_REGISTRY_ORIGIN}/%40deepseek-ai%2Fdsh/0.2.1-rc.2`)
  })

  test('只看「第一方 + 同号」，区间写法的独立发版库与第三方一律不看', () => {
    const pinned = firstPartyPinned(
      {
        '@deepseek-ai/dsh-base': '0.2.1-rc.2',
        '@deepseek-ai/cordis': '~4.0.5',
        react: '^19.0.0',
        '@deepseek-ai/dsh-tool-fs': '0.2.1-rc.1',
      },
      '0.2.1-rc.2',
    )
    expect(pinned).toEqual(['@deepseek-ai/dsh-base'])
  })

  test('没有同号锁步的第一方依赖就是空名单（全是区间的那种老包也认）', () => {
    expect(firstPartyPinned({ '@deepseek-ai/cordis': '~4.0.5' }, '0.2.1-rc.2')).toEqual([])
    expect(firstPartyPinned({}, '0.2.1-rc.2')).toEqual([])
  })
})

describe('runtimeInstallability：依赖闭包齐了才放行', () => {
  test('顶层包与所有同号兄弟包都在架 ⇒ 装得上', async () => {
    const fetchImpl = stubRegistry({
      published: {
        '@deepseek-ai/dsh': ['0.2.1-rc.2'],
        '@deepseek-ai/dsh-base': ['0.2.1-rc.2'],
        '@deepseek-ai/dsh-tool-pwsh-persistent': ['0.2.1-rc.2'],
      },
    })
    const verdicts = await runtimeInstallability({ versions: ['0.2.1-rc.2'], fetchImpl })
    expect(verdicts.get('0.2.1-rc.2')).toEqual({ ok: true, missing: [] })
    expect(installableVersions(verdicts)).toEqual(['0.2.1-rc.2'])
  })

  test('实机那个坑：顶层在、兄弟包缺 ⇒ 装不上，并把缺的那个点名', async () => {
    // @deepseek-ai/dsh@0.2.1-rc.2 已在 npm，但 dsh-tool-pwsh-persistent@0.2.1-rc.2 还没发。
    // 真实情况：顶层包 pin 着还没发的兄弟包，registry 照样这么写。
    const fetchImpl = stubRegistry({
      published: {
        '@deepseek-ai/dsh': ['0.2.1-rc.2'],
        '@deepseek-ai/dsh-base': ['0.2.1-rc.2'],
        '@deepseek-ai/dsh-tool-pwsh-persistent': ['0.2.1-rc.1'],
      },
      deps: {
        '@deepseek-ai/dsh-base': '0.2.1-rc.2',
        '@deepseek-ai/dsh-tool-pwsh-persistent': '0.2.1-rc.2',
      },
    })
    const verdicts = await runtimeInstallability({ versions: ['0.2.1-rc.2'], fetchImpl })
    expect(verdicts.get('0.2.1-rc.2')).toEqual({
      ok: false,
      missing: ['@deepseek-ai/dsh-tool-pwsh-persistent@0.2.1-rc.2'],
    })
    expect(installableVersions(verdicts)).toEqual([])
  })

  test('顶层包压根不在 npm ⇒ 装不上（缺的就是它自己）', async () => {
    const fetchImpl = stubRegistry({ published: {} })
    const verdicts = await runtimeInstallability({ versions: ['0.2.1-rc.9'], fetchImpl })
    expect(verdicts.get('0.2.1-rc.9')).toEqual({ ok: false, missing: ['@deepseek-ai/dsh@0.2.1-rc.9'] })
  })

  test('断网 / registry 报错 ⇒ 判定失败，同样不放行（查不到就不承诺）', async () => {
    const fetchImpl = stubRegistry({ published: { '@deepseek-ai/dsh': ['0.2.1-rc.2'] }, failing: ['@deepseek-ai/dsh'] })
    const verdicts = await runtimeInstallability({ versions: ['0.2.1-rc.2'], fetchImpl })
    const verdict = verdicts.get('0.2.1-rc.2')
    expect(verdict?.ok).toBe(false)
    expect(verdict?.error).toContain('fetch failed')
    expect(installableVersions(verdicts)).toEqual([])
  })

  test('无状态：上游补发之后，同一个版本自己就恢复（用户「不拉黑」的根据）', async () => {
    const before = stubRegistry({
      published: { '@deepseek-ai/dsh': ['0.2.1-rc.2'], '@deepseek-ai/dsh-base': ['0.2.1-rc.1'] },
      deps: { '@deepseek-ai/dsh-base': '0.2.1-rc.2' },
    })
    expect(installableVersions(await runtimeInstallability({ versions: ['0.2.1-rc.2'], fetchImpl: before }))).toEqual([])

    const after = stubRegistry({
      published: { '@deepseek-ai/dsh': ['0.2.1-rc.2'], '@deepseek-ai/dsh-base': ['0.2.1-rc.2'] },
      deps: { '@deepseek-ai/dsh-base': '0.2.1-rc.2' },
    })
    expect(installableVersions(await runtimeInstallability({ versions: ['0.2.1-rc.2'], fetchImpl: after }))).toEqual(['0.2.1-rc.2'])
  })

  test('多个候选各判各的，键去重', async () => {
    const fetchImpl = stubRegistry({
      published: {
        '@deepseek-ai/dsh': ['0.2.1-rc.1', '0.2.1-rc.2'],
        '@deepseek-ai/dsh-base': ['0.2.1-rc.1', '0.2.1-rc.2'],
        '@deepseek-ai/dsh-tool-fs': ['0.2.1-rc.1'],
      },
      // dsh-tool-fs 只发到 rc.1：rc.2 的闭包里缺它，rc.1 的闭包齐。
      deps: { '@deepseek-ai/dsh-base': '0.2.1-rc.2', '@deepseek-ai/dsh-tool-fs': '0.2.1-rc.2' },
    })
    const verdicts = await runtimeInstallability({ versions: ['0.2.1-rc.2', '0.2.1-rc.1', '0.2.1-rc.2', ''], fetchImpl })
    expect([...verdicts.keys()].sort()).toEqual(['0.2.1-rc.1', '0.2.1-rc.2'])
    expect(verdicts.get('0.2.1-rc.1')?.ok).toBe(true)
    expect(verdicts.get('0.2.1-rc.2')?.ok).toBe(false)
    expect(installableVersions(verdicts)).toEqual(['0.2.1-rc.1'])
  })

  test('空名单不发请求', async () => {
    const stub: RegistryStub = { published: {}, requested: [] }
    const verdicts = await runtimeInstallability({ versions: [], fetchImpl: stubRegistry(stub) })
    expect(verdicts.size).toBe(0)
    expect(stub.requested).toEqual([])
  })

  test('兄弟包并发受 concurrency 约束（一次核验约 80 个包，别把 CDN 打出包）', async () => {
    const siblings = Array.from({ length: 20 }, (_, i) => `@deepseek-ai/dsh-sibling-${String(i)}`)
    const published: Record<string, readonly string[]> = { '@deepseek-ai/dsh': ['0.2.1-rc.2'] }
    for (const name of siblings) published[name] = ['0.2.1-rc.2']
    const concurrency = { now: 0, peak: 0 }
    const fetchImpl = stubRegistry({ published, concurrency })
    const verdicts = await runtimeInstallability({ versions: ['0.2.1-rc.2'], fetchImpl, concurrency: 4 })
    expect(verdicts.get('0.2.1-rc.2')?.ok).toBe(true)
    expect(concurrency.peak).toBeGreaterThan(1)
    expect(concurrency.peak).toBeLessThanOrEqual(4)
  })
})
