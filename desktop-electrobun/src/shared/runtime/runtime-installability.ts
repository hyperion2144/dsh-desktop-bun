/**
 * 「这个运行时版本装得上吗」的判定——目录说有，不等于装得上。
 *
 * 目录（GitHub tag / npm dist-tag）说有 `0.2.1-rc.2`，npm 上 `@deepseek-ai/dsh@0.2.1-rc.2`
 * 也确实有了，但它 pin 的八十来个第一方兄弟包未必都发完了。上游一次发布几十个包，谁先谁后
 * 有时差；差口没补上时 `pnpm add` 会死在 `ERR_PNPM_NO_MATCHING_VERSION` 上（实机撞过两次：
 * 先是 `dsh` 本身没上 npm，后是 `dsh-tool-pwsh-persistent@0.2.1-rc.2` 还没发）。照目录提醒
 * 等于许一个装不上的诺——点了才炸，用户白等一场下载。
 *
 * 判定口径：**只验第一方依赖（`@deepseek-ai/*`）的同号是否都已发布**。版本错位只发生在同一次
 * 发布的第一方包之间；第三方依赖不参与版本锁步，`cordis` / `schemastery` 这类独立发版的
 * 第一方库用的是 `~4.0.5` 这种区间，跟运行时版本无关，一律不看。
 *
 * 安装源恒为 npm（`runtime-install.ts` 无条件 `pnpm add @deepseek-ai/dsh@<version>`），
 * 所以这道闸门跟设置里的「运行时下载源」无关：GitHub 目录与 npm 目录都得过它。
 *
 * **无状态**：每次检查都真查一遍 registry。上游把缺的包补上之后，下一次检查自己就恢复——
 * 不留黑名单，也不猜「什么时候恢复」。查不通（离线 / 超时 / registry 抽风）按装不上处理：
 * 宁可静默，不承诺点不动的按钮。
 */
import { NPM_PACKAGE } from './runtime-catalog.ts'

export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'

export interface RuntimeInstallability {
  /** 装得上（含「没查成」——没查成同样不放行，宁可静默）。 */
  ok: boolean
  /** 缺席的第一方包（`name@version`），给日志与托盘灰字当证据。 */
  missing: string[]
  /** 判定本身没查成（离线 / 超时 / registry 回了怪东西）：不是「装不上」，但同样不放行。 */
  error?: string
}

export interface InstallabilityInput {
  /** 待核验的候选版本（一般只有比在跑的高出那么几个）。 */
  versions: readonly string[]
  fetchImpl?: typeof fetch
  /** 单个请求超时，默认 5s。 */
  timeoutMs?: number
  /** 全局在飞请求上限，默认 8。 */
  concurrency?: number
  log?: (line: string) => void
}

interface PackageDoc {
  /** 请求本身没失败（404 也算「请求成功、但这个版本不存在」）。 */
  ok: boolean
  found: boolean
  dependencies: Record<string, string>
  error?: string
}

/** registry 包文档地址：`https://registry.npmjs.org/@deepseek-ai%2Fdsh/0.2.1-rc.2`。 */
export function packageDocUrl(name: string, version: string): string {
  return `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
}

/**
 * 同号锁步的第一方依赖：`@deepseek-ai/dsh-x` 且 range 恰好等于该版本。
 * 区间写法（`~4.0.5`）的独立发版库不进名单——它们跟运行时版本各发各的。
 */
export function firstPartyPinned(dependencies: Record<string, string>, version: string): string[] {
  const names: string[] = []
  for (const [name, range] of Object.entries(dependencies)) {
    if (name.startsWith('@deepseek-ai/') && range === version) names.push(name)
  }
  return names.sort()
}

function emptyDoc(error?: string): PackageDoc {
  return { ok: false, found: false, dependencies: {}, error }
}

async function fetchPackageDoc(
  fetchImpl: typeof fetch,
  name: string,
  version: string,
  timeoutMs: number,
): Promise<PackageDoc> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetchImpl(packageDocUrl(name, version), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (response.status === 404) return { ok: true, found: false, dependencies: {} }
    if (!response.ok) return emptyDoc(`${name}@${version}：HTTP ${String(response.status)}`)
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return emptyDoc(`${name}@${version}：registry 回的不是对象`)
    }
    const raw = (body as Record<string, unknown>)['dependencies']
    const deps: Record<string, string> = {}
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const [dep, range] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof range === 'string') deps[dep] = range
      }
    }
    return { ok: true, found: true, dependencies: deps }
  } catch (error) {
    return emptyDoc(`${name}@${version}：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 在飞请求数的闸门。`concurrency` 是**全局**上限，不只是候选之间——一次核验约 80 个兄弟包，
 * 不设闸就是一次打 80 个请求，别把 CDN 打出包。
 */
function createGate(width: number): <T>(work: () => Promise<T>) => Promise<T> {
  const waiting: (() => void)[] = []
  let active = 0
  return async function run<T>(work: () => Promise<T>): Promise<T> {
    if (active >= width) await new Promise<void>((resolve) => { waiting.push(resolve) })
    active += 1
    try {
      return await work()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}

/**
 * 逐个候选核验安装可行性。返回 map（版本 → 判定），键去重。
 * 候选之间并发，每个候选的兄弟包也并发；两处共用同一个在飞闸门。
 */
export async function runtimeInstallability(input: InstallabilityInput): Promise<Map<string, RuntimeInstallability>> {
  const fetchImpl = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? 5000
  const gate = createGate(Math.max(1, input.concurrency ?? 8))
  const doc = (name: string, version: string): Promise<PackageDoc> => gate(() => fetchPackageDoc(fetchImpl, name, version, timeoutMs))
  const verdicts = new Map<string, RuntimeInstallability>()
  const versions = [...new Set(input.versions.filter((version) => version.trim() !== ''))]

  const verify = async (version: string): Promise<RuntimeInstallability> => {
    const self = await doc(NPM_PACKAGE, version)
    if (!self.ok) return { ok: false, missing: [], error: self.error ?? `${version}：核验失败` }
    if (!self.found) return { ok: false, missing: [`${NPM_PACKAGE}@${version}`] }

    const siblings = firstPartyPinned(self.dependencies, version)
    const docs = await Promise.all(siblings.map(async (name) => [name, await doc(name, version)] as const))
    const missing: string[] = []
    let error: string | undefined
    for (const [name, result] of docs) {
      if (!result.ok) {
        if (error === undefined) error = result.error ?? `${name}@${version}：核验失败`
      } else if (!result.found) {
        missing.push(`${name}@${version}`)
      }
    }
    if (missing.length > 0) return { ok: false, missing: missing.sort() }
    if (error !== undefined) return { ok: false, missing: [], error }
    return { ok: true, missing: [] }
  }

  const settled = await Promise.all(versions.map(async (version) => [version, await verify(version)] as const))
  for (const [version, verdict] of settled) {
    verdicts.set(version, verdict)
    input.log?.(
      verdict.ok
        ? `[update-notice] ${version} 的第一方依赖都齐了，可以装`
        : `[update-notice] ${version} 先不提醒：${verdict.error ?? `上游还没发全（缺 ${verdict.missing.join('、')}）`}`,
    )
  }
  return verdicts
}

/** map 里 ok 的版本集合——`evaluateRuntimeUpdates` 的 `installable` 要的就是这个。 */
export function installableVersions(verdicts: Map<string, RuntimeInstallability>): string[] {
  const out: string[] = []
  for (const [version, verdict] of verdicts) {
    if (verdict.ok) out.push(version)
  }
  return out
}
