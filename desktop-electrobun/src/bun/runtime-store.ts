// 运行时目录的 IO 半边：扫描已装版本、清单读写、回收站、目录抓取（外部 dsh 定位已随 #3 移除）。
//
// 与旧壳 desktop/src-tauri/src/runtime/registry.rs 对齐的几条约定：
// - 有效性判据 = `<root>/node_modules/@deepseek-ai/dsh/lib/bin.js` 是文件（旧壳 is_valid_runtime）；
// - 版本号取自 `<root>/node_modules/@deepseek-ai/dsh/package.json`（不是目录名）；
// - 卸载不直接 unlink：先 rename 进 `.trash`，真正删除推迟到下次壳启动（旧壳 #114——
//   直接删会改到与运行树 hardlink 共享 inode 的 ctime/size，触发 dsh 插件 rebuilt → 白屏）；
// - 目录抓取失败不抛给调用方：返回 `{entries, error}`，设置面板降级显示已下载版本（旧壳 #107）。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_GITHUB_REPO,
  INSTALLED_MANIFEST,
  NPM_PACKAGE,
  RUNTIMES_DIR,
  RUNTIME_TRASH_DIR,
  isRuntimeVersion,
  mergeInstalled,
  parseGithubCatalog,
  parseInstalledManifest,
  parseNpmCatalog,
  removeInstalledEntry,
  serializeInstalledManifest,
  sortRuntimeVersionsDesc,
  upsertInstalled,
  type CatalogEntry,
  type InstalledRuntime,
} from '../shared/runtime-catalog.ts'

export interface RuntimeStoreLogger {
  (message: string): void
}

export function runtimesDir(appSupport: string): string {
  return join(appSupport, RUNTIMES_DIR)
}

export function runtimeDirOf(appSupport: string, version: string): string {
  return join(runtimesDir(appSupport), version)
}

export function runtimeTrashDir(appSupport: string): string {
  return join(runtimesDir(appSupport), RUNTIME_TRASH_DIR)
}

export function installedManifestPath(appSupport: string): string {
  return join(runtimesDir(appSupport), INSTALLED_MANIFEST)
}

/** 运行时树的 dsh 包根（root 布局）。 */
export function dshPackageRootOf(runtimeDir: string): string {
  return join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
}

export function isRuntimeTreeValid(runtimeDir: string): boolean {
  return existsSync(join(dshPackageRootOf(runtimeDir), 'lib', 'bin.js'))
}

/** 运行时树里 dsh 的真实版本号（读 package.json；读不到返回 null）。 */
export function readRuntimeVersion(runtimeDir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dshPackageRootOf(runtimeDir), 'package.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

/** 扫描 appSupport/runtimes 下有效的版本目录（跳过 .trash 与半成品）。 */
export function scanInstalledVersions(appSupport: string): string[] {
  const root = runtimesDir(appSupport)
  let entries: string[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
  return sortRuntimeVersionsDesc(
    entries.filter((version) => isRuntimeVersion(version) && isRuntimeTreeValid(runtimeDirOf(appSupport, version))),
  )
}

export function readInstalledManifest(appSupport: string): InstalledRuntime[] {
  try {
    return parseInstalledManifest(readFileSync(installedManifestPath(appSupport), 'utf8'))
  } catch {
    return []
  }
}

export function writeInstalledManifest(appSupport: string, list: readonly InstalledRuntime[]): void {
  const path = installedManifestPath(appSupport)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeInstalledManifest(list))
}

/** 已装运行时行：清单为准、目录扫描补漏；清单里的陈旧条目（树已不在，#79 安装失败窗口期）不进列表，
 * 否则面板会把已失败的下载渲染成「切换/卸载」成功态。 */
export function listInstalledRuntimes(appSupport: string): InstalledRuntime[] {
  const manifest = readInstalledManifest(appSupport).filter((row) =>
    isRuntimeTreeValid(runtimeDirOf(appSupport, row.version)),
  )
  return mergeInstalled(manifest, scanInstalledVersions(appSupport))
}

export function recordInstalledRuntime(appSupport: string, entry: InstalledRuntime): InstalledRuntime[] {
  const next = upsertInstalled(readInstalledManifest(appSupport), entry)
  writeInstalledManifest(appSupport, next)
  return next
}

export function forgetInstalledRuntime(appSupport: string, version: string): InstalledRuntime[] {
  const next = removeInstalledEntry(readInstalledManifest(appSupport), version)
  writeInstalledManifest(appSupport, next)
  return next
}

/**
 * 卸载：先移进回收站（rename 是原子的，且不动 inode），清单里立刻摘掉，
 * 真正删除留给下次启动的 purgeRuntimeTrash。
 */
export function trashInstalledRuntime(appSupport: string, version: string, log?: RuntimeStoreLogger): void {
  const dir = runtimeDirOf(appSupport, version)
  const trash = runtimeTrashDir(appSupport)
  mkdirSync(trash, { recursive: true })
  if (existsSync(dir)) {
    const target = join(trash, `${String(Date.now())}-${version}`)
    renameSync(dir, target)
    log?.(`运行时 dsh ${version} 已移入回收站（下次启动清理）：${target}`)
  } else {
    log?.(`运行时 dsh ${version} 目录不存在，只清理清单`)
  }
  forgetInstalledRuntime(appSupport, version)
}

/** 清空回收站（壳启动、spawn dsh 之前调用；失败只记日志，不阻塞启动）。 */
export function purgeRuntimeTrash(appSupport: string, log?: RuntimeStoreLogger): number {
  const trash = runtimeTrashDir(appSupport)
  if (!existsSync(trash)) return 0
  let removed = 0
  for (const entry of readdirSync(trash, { withFileTypes: true })) {
    const target = join(trash, entry.name)
    try {
      rmSync(target, { recursive: true, force: true })
      removed += 1
    } catch (error) {
      log?.(`回收站清理失败：${target}（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  return removed
}

export interface CatalogResult {
  entries: CatalogEntry[]
  error?: string
}

export interface FetchCatalogInput {
  source: string
  repo?: string | null
  fetchImpl?: typeof fetch
  timeoutMs?: number
  log?: RuntimeStoreLogger
}

/** 版本目录抓取：github → releases API；npm → registry 元数据。失败不算异常（error 交给面板）。 */
export async function fetchRuntimeCatalog(input: FetchCatalogInput): Promise<CatalogResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, input.timeoutMs ?? 12_000)
  try {
    if (input.source === 'npm') {
      const response = await fetchImpl(`https://registry.npmjs.org/${NPM_PACKAGE}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: controller.signal,
      })
      if (!response.ok) return { entries: [], error: `npm registry 查询失败：HTTP ${String(response.status)}` }
      return { entries: parseNpmCatalog(await response.json()) }
    }
    const repo = input.repo !== undefined && input.repo !== null && input.repo.trim() !== '' ? input.repo.trim() : DEFAULT_GITHUB_REPO
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=${String(20)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-desktop-bun' },
      signal: controller.signal,
    })
    if (!response.ok) return { entries: [], error: `GitHub releases 查询失败：HTTP ${String(response.status)}` }
    return { entries: parseGithubCatalog(await response.json()) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    input.log?.(`[runtime] 版本目录拉取失败（降级为仅本地已装）：${message}`)
    return { entries: [], error: message }
  } finally {
    clearTimeout(timeout)
  }
}





/** dsh 包根的版本号（读 package.json；override 指到包根布局的树时用）。 */
export function externalVersion(packageRoot: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}



