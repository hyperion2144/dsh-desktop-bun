// profile 依赖树 reconcile（#13）：把运行时树里的包按需软链进**共享池** `profiles/node_modules`，
// per-profile 池不再落运行时链接（历史遗留由 pruneLegacyPoolLinks 做一次性迁移清理）。
//
// 为什么需要：Bun 下装不了 Node 的 resolver hooks（`module.register` 是 no-op，
// `Bun.plugin({onResolve})` 既看不到 node_modules 内的裸说明符、也拿不到
// `@scope/pkg/subpath` 这种 exports 子路径），而 dsh 的 profile 装配本来靠 pnpm 把依赖摊到
// `profiles/<name>/node_modules`。空 DSH_HOME（CI 的缝 ①）没有这棵树，插件会整片
// `failed to import`（含 `@deepseek-ai/dsh-web-app/startup` 这类子路径导入）。
//
// 结论来自 #209 调研：NODE_PATH 只能兜住「包根」这一层，子路径必须有一棵真树。
// 碰撞策略：只收运行时自己的包（`@deepseek-ai/*`）；第三方包以共享池里已有的为准（profile 池的第三方资产不受影响）。

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, type Dirent, type Stats } from 'node:fs'
import { createDirLink, readDirLink } from '../shared/dir-link.ts'
import { profileDirOf } from './profile-scaffold.ts'
import { basename, dirname, join, resolve, sep } from 'node:path'

export interface ReconcileInput {
  /** 运行时树的 node_modules，如 <runtime>/node_modules */
  runtimeModules: string
  /** 链接池的 node_modules；#13 起调用方传共享池 <DSH_HOME>/profiles/node_modules */
  profileModules: string
  onLog?: (line: string) => void
}

export interface ReconcileResult {
  /** 新链上的包 */
  linked: number
  /** 指错方向、被重新指向运行时树的包 */
  repointed: number
  /** profile 自己那份保持不动 */
  kept: number
}


/** 运行时树里所有包的包名（含 `@scope/name` 两段形式，跳过 `.bin`/`.pnpm` 之类）。 */
export function runtimePackageNames(runtimeModules: string): string[] {
  const names: string[] = []
  for (const entry of readdirSync(runtimeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      for (const child of readdirSync(join(runtimeModules, entry.name), { withFileTypes: true })) {
        if (child.isDirectory() && !child.name.startsWith('.')) names.push(`${entry.name}/${child.name}`)
      }
      continue
    }
    names.push(entry.name)
  }
  return names.sort()
}

/** 目录链接指向比较：Windows 不区分路径大小写（旧链接存的盘符/目录大小写常与现算不一致，
 * 严格比较会让每次启动都 rm+create 抖动）；null 指向（readlink 失败）视为不等，走重指。 */
export function dirLinksEqual(a: string | null, b: string): boolean {
  if (a === null) return false
  if (a === b) return true
  return process.platform === 'win32' && a.toLowerCase() === b.toLowerCase()
}

/** 删掉 dest 上的旧条目、重指到 source（reconcile 只在壳启动单线程跑，删建之间无并发读者）。 */
function repointDir(source: string, dest: string, result: ReconcileResult): void {
  rmSync(dest, { recursive: true, force: true })
  createDirLink(source, dest)
  result.repointed += 1
}

export function reconcileProfileTree(input: ReconcileInput): ReconcileResult {
  const onLog = input.onLog ?? (() => {})
  const result: ReconcileResult = { linked: 0, repointed: 0, kept: 0 }
  if (!existsSync(input.runtimeModules)) {
    onLog(`[profile-tree] 运行时没有 node_modules，跳过 reconcile：${input.runtimeModules}`)
    return result
  }

  for (const name of runtimePackageNames(input.runtimeModules)) {
    const source = join(input.runtimeModules, name)
    const dest = join(input.profileModules, name)
    const runtimeOwned = name.startsWith('@deepseek-ai/')
    try {
      // 条目存在性用 lstat 判（不跟随链接）：existsSync 对悬空链接返回 false，会把
      // 「链接还在、只是指空」误判成不存在 → createDirLink 撞 EEXIST（#1 根因 2）。
      let stat: Stats | null = null
      try {
        stat = lstatSync(dest)
      } catch (error) {
        // 只把「真不存在」当不存在；EACCES/EPERM 等上抛给外层 catch 记日志——
        // 吞掉的话权限问题会被误判成不存在 → createDirLink 撞 EEXIST（#1 同款故障）。
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (stat === null) {
        mkdirSync(dirname(dest), { recursive: true })
        createDirLink(source, dest)
        result.linked += 1
        continue
      }
      if (stat.isSymbolicLink()) {
        const raw = readDirLink(dest)
        const pointsTo = raw === null ? null : resolve(dirname(dest), raw)
        // 指错方向（含旧壳残留的悬空/错指链接，不分公司）：删掉重指到当前运行时树
        // （#1 根因④与「修后效果 2/3」的原文没限 @deepseek-ai/*；#209 碰撞策略要保留的
        // 用户资产指真目录，symlink 形态的错链保留没有任何价值）。
        if (!dirLinksEqual(pointsTo, source)) {
          repointDir(source, dest, result)
        } else {
          result.kept += 1
        }
        continue
      }
      if (runtimeOwned) {
        // 运行时自己的包被真实目录/文件占住：旧版本残留，换成运行时树链接（#1 根因 3）；
        // 第三方包继续按碰撞策略保留（profile 已有者优先）。
        repointDir(source, dest, result)
        continue
      }
      result.kept += 1
    } catch (error) {
      onLog(`[profile-tree] ${name} 处理失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  onLog(
    `[profile-tree] 收 ${String(result.linked)} 个新链、${String(result.repointed)} 个重指、${String(result.kept)} 个保留（运行时 ${input.runtimeModules}）`,
  )
  return result
}

/** 路径包含判定（p 是否落在 root 内）：Windows 不区分大小写（与 dirLinksEqual 同一套语义）。 */
function pathInside(p: string, root: string): boolean {
  if (p === root) return true
  if (p.startsWith(root + sep)) return true
  if (process.platform === 'win32') {
    const lp = p.toLowerCase()
    const lr = root.toLowerCase()
    return lp === lr || lp.startsWith(`${lr}${sep}`)
  }
  return false
}

export interface PruneLegacyPoolLinksInput {
  /** 旧落点：profile 专属池（`<DSH_HOME>/profiles/<name>/node_modules`），清理对象 */
  poolModules: string
  onLog?: (line: string) => void
}

export interface PruneLegacyPoolLinksResult {
  /** 清掉的壳遗留链接（指任何运行时树 / 悬空残骸 / 指向不可读） */
  removed: number
  /** 保留的条目（pnpm 自有链接、真目录/文件等用户资产） */
  kept: number
}

/**
 * #13 迁移：清掉 per-profile 池里壳此前写下的 `@deepseek-ai/*` 运行时链接。
 *
 * 落点上移共享池后，per-profile 池里的运行时链接会以「近者优」遮蔽共享层——
 * 切运行时版本后其它 profile 还解析到旧树（运行时卸载后成悬空链，子路径导入整片断）。
 * 判定（保守，只清确定是壳遗留的形态）：
 * - 链接目标落在池自身内（pnpm 的 `.pnpm` store 形态，含 store 暂时悬空）→ 保留（先于悬空判定，pnpm 自家链不代劳）；
 * - 目标是 `<...>/node_modules/@deepseek-ai/<pkg>` 形态（任何运行时树：当前/旧版本/内置/外部）→ 清；
 * - 悬空残骸（运行时已卸载）或指向不可读 → 清；
 * - 真目录/文件是用户资产 → 一律不动（共享池里陌生条目的口径见票 #13 Q2：也不在此处）。
 */
export function pruneLegacyPoolLinks(input: PruneLegacyPoolLinksInput): PruneLegacyPoolLinksResult {
  const onLog = input.onLog ?? (() => {})
  const result: PruneLegacyPoolLinksResult = { removed: 0, kept: 0 }
  const scope = join(input.poolModules, '@deepseek-ai')
  let entries: Dirent[]
  try {
    entries = readdirSync(scope, { withFileTypes: true })
  } catch (error) {
    // 池还没建过（新机器/新 profile）：无事可清
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw error
  }
  const poolRoot = resolve(input.poolModules)
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      result.kept += 1
      continue
    }
    const dest = join(scope, entry.name)
    let stat: Stats
    try {
      stat = lstatSync(dest)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        result.kept += 1
        continue
      }
      throw error
    }
    // 真目录/文件不是链接：用户/pnpm 资产，不动
    if (!stat.isSymbolicLink()) {
      result.kept += 1
      continue
    }
    const raw = readDirLink(dest)
    const pointsTo = raw === null ? null : resolve(dirname(dest), raw)
    let removeReason = ''
    if (pointsTo === null) {
      // lstat 说是链接但 readlink 失败：无法判定的坏链，按残骸清
      removeReason = '指向不可读'
    } else if (pathInside(pointsTo, poolRoot)) {
      // 指向池自身（pnpm store 形态）：pnpm 自有，保留——即使 store 暂时悬空（半装/pnpm prune）
      // 也归 pnpm 自己重建，不代劳（先于悬空判定，否则会误删 pnpm 自有悬空链）
      result.kept += 1
      continue
    } else {
      let targetMissing = false
      try {
        statSync(pointsTo)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') targetMissing = true
        else throw error
      }
      if (targetMissing) {
        removeReason = '悬空残骸'
      } else if (basename(dirname(pointsTo)) === '@deepseek-ai' && basename(dirname(dirname(pointsTo))) === 'node_modules') {
        // `<...>/node_modules/@deepseek-ai/<pkg>` 形态：任何运行时树的链接都是壳遗留
        removeReason = '指向运行时树'
      }
    }
    if (removeReason === '') {
      result.kept += 1
      continue
    }
    rmSync(dest, { force: true })
    result.removed += 1
    onLog(`[profile-tree] 迁移清理：${dest}（${removeReason}）`)
  }
  if (result.removed > 0) {
    onLog(`[profile-tree] 迁移清理完成：清 ${String(result.removed)} 条壳遗留链接、留 ${String(result.kept)} 条（池 ${input.poolModules}）`)
  }
  return result
}

export interface ReconcileProfileRuntimeTreeInput {
  /** DSH_HOME（`<home>/profiles/...` 的根） */
  home: string
  profile: string
  /** 运行时树的 node_modules，如 `<runtime>/node_modules` */
  runtimeModules: string
  onLog?: (line: string) => void
}

export interface ReconcileProfileRuntimeTreeResult {
  /** 共享池 reconcile 结果（#13 起的落点） */
  shared: ReconcileResult
  /** per-profile 池的迁移清理结果（幂等，每次启动/切运行时都跑） */
  pruned: PruneLegacyPoolLinksResult
}

/**
 * profile 依赖树的启动入口（#13）：reconcile 落点是**共享池** `<home>/profiles/node_modules`
 * （运行时包跨 profile 共享同一份链接，各 profile 靠 Node/Bun 向上解析命中，
 * 即旧壳不变量「共享包在父级 node_modules」），并先把壳此前写进 per-profile 池的运行时链接
 * 幂等清掉（否则近者优遮蔽共享层，切运行时后跨 profile 版本错配）。
 * per-profile 池继续承载 pnpm 依赖树与第三方包（碰撞策略不变）；插件 staging 池不在此处。
 */
export function reconcileProfileRuntimeTree(input: ReconcileProfileRuntimeTreeInput): ReconcileProfileRuntimeTreeResult {
  const onLog = input.onLog ?? (() => {})
  const sharedModules = join(input.home, 'profiles', 'node_modules')
  const profileModules = join(profileDirOf(input.home, input.profile), 'node_modules')
  // ① 迁移清理（幂等）：先清 per-profile 池的壳遗留运行时链接（近者优会遮蔽共享层）
  const pruned = pruneLegacyPoolLinks({ poolModules: profileModules, onLog })
  // ② reconcile 落点 = 共享池；per-profile 池仍保目录存在（profileHealth 以 node_modules 存在为健康项）
  mkdirSync(sharedModules, { recursive: true })
  mkdirSync(profileModules, { recursive: true })
  const shared = reconcileProfileTree({ runtimeModules: input.runtimeModules, profileModules: sharedModules, onLog })
  return { shared, pruned }
}
