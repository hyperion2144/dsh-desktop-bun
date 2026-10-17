/**
 * 运行时更新判定层（#138，map #135）。
 *
 * 回答唯一一个问题：**从「实际在跑的版本」出发，有哪些比它更新的运行时版本可去。**
 * 启动提醒、托盘「检查更新」、设置面板三处都调这一个函数——版本比较逻辑只有这一份，
 * 谁也不许再写第二遍（#138 要点）。
 *
 * 四个钉死的口径（2026-10-17 grilling 定，ADR-0003 记了取舍）：
 *
 * 1. **基准是实际在跑的版本**（`runtimeSnapshot().running.version`），不是设置里的偏好值。
 *    偏好可能高于实际（设了没切、失败回落）或低于实际（切了没改设置），拿偏好当基准会同时误报和漏报。
 * 2. **内置运行时是一等候选**：随包分发的那棵也要进候选集、参与「更高」判定。它只是
 *    多了三条属性——位置在 builtinDir 而非 runtimesDir、面板删不掉、不需要下载。
 * 3. **同号合并**：内置版本号若同时出现在已下载目录里，只出**一条**（来源=内置）。
 *    不重复列、不重复下载，也没有「把内置树换掉」这种做法。
 * 4. **与内置不同的版本一律走下载路径**（`download_runtime` → `runtimesDir(appSupport)`）。
 *
 * 本文件只有纯逻辑：比较、归类、排序列计划。不 import electrobun、不碰文件系统，
 * IO 在调用方（`runtime-store.ts` 拉已装、`runtime-install.ts` 拉远端）。所以桩数据就能把
 * 「内置更新 / 已下载没切 / 目录拉挂 / 压根没在跑」四种边界钉死。
 */

import {
  compareRuntimeVersions,
  isRuntimeVersion,
  runtimeChannel,
  sortRuntimeVersionsDesc,
  type CatalogEntry,
  type InstalledRuntime,
} from './runtime-catalog.ts'

/** 条目从哪来（决定「要不要下载」「能不能卸载」）。 */
export type RuntimeUpdateSource = 'builtin' | 'downloaded' | 'remote'

/** 点按钮要做的事：本地已有树只需切换，远端候选要先下载再切。 */
export type RuntimeUpdateAction = 'switch' | 'download-and-switch'

export const RUNTIME_UPDATE_SOURCE_LABELS: Record<RuntimeUpdateSource, string> = {
  builtin: '内置',
  downloaded: '已下载',
  remote: '未下载',
}

export const RUNTIME_UPDATE_ACTION_LABELS: Record<RuntimeUpdateAction, string> = {
  switch: '切换到此版本',
  'download-and-switch': '下载并切换',
}

/** 一步 RPC 调用（参数即壳 RPC 的 args 对象，调用方直接 invoke）。 */
export interface RuntimeUpdateStep {
  rpc: string
  args: Record<string, unknown>
}

export interface RuntimeUpdateEntry {
  version: string
  /** 渠道标注：latest / alpha / rc / ''（离线或只在本地时按版本号猜）。 */
  channel: string
  source: RuntimeUpdateSource
  /** 本地已有树（内置或已下载）：点按钮直接切，不必下载。 */
  local: boolean
  /** 面板能否卸载（内置随包分发，删不掉）。 */
  uninstallable: boolean
  action: RuntimeUpdateAction
  /** 用户点按钮要走哪条 RPC，按顺序执行。#139 动作链直接消费这份计划。 */
  plan: RuntimeUpdateStep[]
}

export interface RuntimeUpdateInput {
  /** 实际在跑的版本（比较基准）；拿不到给 null。 */
  running: string | null
  /** 随包内置的版本号；dev 外部树或读不到时给 null。 */
  builtin: string | null
  /** 远端目录（github / npm）。拉取失败给 []，并用 catalogError 说明原因。 */
  catalog: readonly CatalogEntry[]
  /** 已下载的运行时（`listInstalledRuntimes` 的结果）。 */
  installed: readonly InstalledRuntime[]
  /** 目录来源：写进 `download_runtime` 的 source 参数；缺省 'github'（与壳命令面同口径）。 */
  source?: string
  /** 目录拉取失败原因（'' 或不给 = 正常）。 */
  catalogError?: string
  /**
   * 安装源上真正有的版本（实机修）。
   *
   * 目录与安装源可能不在一侧：目录默认取 GitHub releases，而安装只能走 npm——刚发到 GitHub
   * 的版本 npm 上还没有（实测 `dsh-v0.2.1-rc.2` 已发，npm 的 `next` 还停在 rc.1）。照目录提醒等于
   * 许一个装不上的诺：点了「下载并切换」才炸 ERR_PNPM_NO_MATCHING_VERSION。
   *
   * 给了数组 = 未下载的候选里只放行装得上的那些（内置与已下载是本地事实，不受此约束）；
   * 空数组 = 装不上任何未下载的版本（含「查安装源失败」，取保守口径：查不到就不承诺）。
   * undefined = 没查安装源，不筛（目录源本身就是 npm 时属于这种情况）。
   */
  installable?: readonly string[]
}

export interface RuntimeUpdateReport {
  /** 实际在跑的版本；null 表示没法判定（见 reason）。 */
  baseline: string | null
  builtin: string | null
  /** 目录来源（回传给下载动作）。 */
  source: string
  /** 比基准更高的候选，按版本从高到低。 */
  entries: RuntimeUpdateEntry[]
  /** 有没有可提醒的新版本（entries 非空）。 */
  available: boolean
  /** 目录拉取失败原因（'' = 正常）。 */
  catalogError: string
  /** 一句人话：为什么有更新 / 为什么没有。 */
  reason: string
}

/** 目录来源缺省值：与壳命令面 `download_runtime` 的 source 缺省同口径。 */
export const DEFAULT_CATALOG_SOURCE = 'github'

/**
 * 切换 = 把设置里的运行时钉成目标版本，再重启 DSH 服务让它生效。
 * 与 `desktop-settings.tsx` 的 `handleSwitchRuntime` 逐字同款（含 #97 补的 `dsh_mode`）：
 * 内置行也写版本号，写 null 会让壳把「切回内置」当成没设置，进而拿已装最高版本顶上。
 */
function switchPlan(version: string): RuntimeUpdateStep[] {
  return [
    { rpc: 'save_desktop_settings', args: { patch: { dsh_runtime: version, dsh_mode: 'builtin' } } },
    { rpc: 'restart_dsh_service', args: {} },
  ]
}

/** 下载并切换：先下载（下载类调用不挂客户端超时，成败由 `runtime_download_status` 轮询落），再走切换两步。 */
function downloadPlan(version: string, source: string): RuntimeUpdateStep[] {
  return [{ rpc: 'download_runtime', args: { version, source } }, ...switchPlan(version)]
}

/**
 * 判定「从在跑版本往上有哪些更新」。
 *
 * 候选集 = **内置 ∪ 远端目录 ∪ 已下载本地**，三者取并集——内置那一项不依赖远端目录是否可达
 * （离线时它依然是个真候选），已下载那一项也不依赖目录（拉到过就是本地事实）。
 * 过滤只留严格高于基准的版本，于是「已下载且正在用」自然落选（相等），不需要额外分支。
 */
export function evaluateRuntimeUpdates(input: RuntimeUpdateInput): RuntimeUpdateReport {
  const baseline = isRuntimeVersion(input.running) ? input.running : null
  const builtin = isRuntimeVersion(input.builtin) ? input.builtin : null
  const source = input.source === undefined || input.source === '' ? DEFAULT_CATALOG_SOURCE : input.source
  const catalogError = input.catalogError ?? ''
  const installedVersions = new Set(input.installed.map((row) => row.version).filter(isRuntimeVersion))
  const channels = new Map<string, string>()
  for (const row of input.catalog) {
    if (!isRuntimeVersion(row.version) || channels.has(row.version)) continue
    channels.set(row.version, row.channel)
  }
  if (baseline === null) {
    // 没有基准就没有「更高」可言：宁可什么都不提醒，也不拿设置里的偏好值凑数（否则会误报）。
    return {
      baseline: null,
      builtin,
      source,
      entries: [],
      available: false,
      catalogError,
      reason: '尚未拿到实际在跑的版本，暂不判定更新',
    }
  }
  const candidates = new Set<string>(installedVersions)
  for (const version of channels.keys()) candidates.add(version)
  if (builtin !== null) candidates.add(builtin)
  const newer = sortRuntimeVersionsDesc([...candidates]).filter(
    (version) => compareRuntimeVersions(version, baseline) > 0,
  )
  const sourceOf = (version: string): RuntimeUpdateSource =>
    // 同号合并：内置优先于已下载，内置那棵本来就够用，不需要再下一份。
    version === builtin ? 'builtin' : installedVersions.has(version) ? 'downloaded' : 'remote'
  // 只卡远端候选：内置与已下载是本地事实，不经安装源（也不该因为查不到安装源而被藏起来）。
  const installableSet = input.installable === undefined ? null : new Set(input.installable.filter(isRuntimeVersion))
  const reachable = installableSet === null
    ? newer
    : newer.filter((version) => sourceOf(version) !== 'remote' || installableSet.has(version))
  // 被卡下来的那些：安静时用它们解释为什么不提醒（有新版本但装不上，不算「已是最新」的沉默）。
  const pending = reachable.length === newer.length ? [] : newer.filter((version) => !reachable.includes(version))
  const entries = reachable.map((version): RuntimeUpdateEntry => {
    const entrySource: RuntimeUpdateSource = sourceOf(version)
    const local = entrySource !== 'remote'
    const action: RuntimeUpdateAction = local ? 'switch' : 'download-and-switch'
    return {
      version,
      channel: channels.get(version) ?? runtimeChannel(version),
      source: entrySource,
      local,
      uninstallable: entrySource !== 'builtin',
      action,
      plan: local ? switchPlan(version) : downloadPlan(version, source),
    }
  })
  const highest = entries[0]
  return {
    baseline,
    builtin,
    source,
    entries,
    available: highest !== undefined,
    catalogError,
    reason:
      highest === undefined
        ? pending.length === 0
          ? catalogError === ''
            ? `已是最新（${baseline}）`
            : `已是最新（${baseline}）；远端目录拉取失败：${catalogError}`
          : `已是最新（${baseline}）；更高的 ${pending.join('、')} 上游还没发全，装不上就不提醒`
        : `${entries.length} 个比 ${baseline} 更新的运行时（最高 ${highest.version}）`,
  }
}

/** 最高的那条更新（entries 已按版本降序；没有更新时 null）。 */
export function topRuntimeUpdate(report: RuntimeUpdateReport): RuntimeUpdateEntry | null {
  return report.entries[0] ?? null
}

export function runtimeUpdateActionLabel(entry: RuntimeUpdateEntry): string {
  return RUNTIME_UPDATE_ACTION_LABELS[entry.action]
}

export function runtimeUpdateSourceLabel(entry: RuntimeUpdateEntry): string {
  return RUNTIME_UPDATE_SOURCE_LABELS[entry.source]
}
