// profile 树的 reconcile：把运行时树里的包按需软链进 `profiles/<name>/node_modules`。
//
// 为什么需要：Bun 下装不了 Node 的 resolver hooks（`module.register` 是 no-op，
// `Bun.plugin({onResolve})` 既看不到 node_modules 内的裸说明符、也拿不到
// `@scope/pkg/subpath` 这种 exports 子路径），而 dsh 的 profile 装配本来靠 pnpm 把依赖摊到
// `profiles/<name>/node_modules`。空 DSH_HOME（CI 的缝 ①）没有这棵树，插件会整片
// `failed to import`（含 `@deepseek-ai/dsh-web-app/startup` 这类子路径导入）。
//
// 结论来自 #209 调研：NODE_PATH 只能兜住「包根」这一层，子路径必须有一棵真树。
// 碰撞策略：只收运行时自己的包（`@deepseek-ai/*`）；第三方包以 profile 里已有的为准。

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, type Stats } from 'node:fs'
import { createDirLink, readDirLink } from '../shared/dir-link.ts'
import { dirname, join, resolve } from 'node:path'

export interface ReconcileInput {
  /** 运行时树的 node_modules，如 <runtime>/node_modules */
  runtimeModules: string
  /** profile 的 node_modules，如 <DSH_HOME>/profiles/<name>/node_modules */
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
