// 随包内置运行时的声明与校验（#16）。
//
// 单一事实源是 `desktop-electrobun/builtin-runtime.json`（dsh + pnpm 精确版本）：
// prepare:bundle 按声明经 npm 拉取物化 `builtin-runtime/`，落盘树逐项校验、不符
// fail 构建；assert-artifact 再对打包产物核对一遍。旧的「来源链」（仓内 Tauri 树 /
// 本机已下载运行时倒序取最新）已退役——那让产物版本取决于构建机上碰巧有什么。
//
// 本模块保持可桩测：文件读取走注入（缺省 node:fs），来源计划（planBuiltinSource）
// 是纯函数；校验报告 problems 全是人话，直接进构建失败信息。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRuntimeVersion } from './runtime-catalog.ts'

export interface BuiltinRuntimeDeclaration {
  /** 随包内置的 `@deepseek-ai/dsh` 精确版本 */
  dsh: string
  /**
   * 随包内置的 pnpm 精确版本。壳「下载运行时」与 profile 依赖重建跑的就是内置树里
   * 这份 pnpm.cjs（独立 store 大版本绑定它，浮动会 ERR_PNPM_UNEXPECTED_STORE）。
   */
  pnpm: string
}

/** 声明文件名（相对 desktop-electrobun/）。 */
export const DECLARATION_FILE = 'builtin-runtime.json'

export interface BuiltinIo {
  readText: (path: string) => string
  exists: (path: string) => boolean
}

export function defaultBuiltinIo(): BuiltinIo {
  return {
    readText: (path) => readFileSync(path, 'utf8'),
    exists: (path) => existsSync(path),
  }
}

/**
 * 声明解析：坏 JSON / 非对象 / 字段缺失 / 版本号不合法一律无效（返回 null，
 * 由调用方 fail 构建——声明是供给的唯一事实源，读不出来不该静默兜底）。
 */
export function parseBuiltinRuntimeDeclaration(text: string): BuiltinRuntimeDeclaration | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const row = parsed as Record<string, unknown>
  if (!isRuntimeVersion(row.dsh) || !isRuntimeVersion(row.pnpm)) return null
  return { dsh: row.dsh, pnpm: row.pnpm }
}

export function readBuiltinRuntimeDeclaration(
  path: string,
  io: BuiltinIo = defaultBuiltinIo(),
): BuiltinRuntimeDeclaration | null {
  try {
    return parseBuiltinRuntimeDeclaration(io.readText(path))
  } catch {
    return null
  }
}

/** package.json 文本里的 version 字段（读不出 / 不是非空字符串返回 null）。 */
function packageVersion(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    const version = (parsed as Record<string, unknown>).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

/** dsh 包 package.json 里的版本号（树校验与 assert-artifact 共用）。 */
export function dshVersionFromPackageJson(text: string): string | null {
  return packageVersion(text)
}

export interface BuiltinTreeState {
  ok: boolean
  /** 人话原因清单（为空即 ok），prepare:artifact / assert-artifact 直接展示。 */
  problems: string[]
  dshVersion: string | null
  pnpmVersion: string | null
}

/**
 * 校验一棵内置运行时树与声明一致：
 *  - dsh 包在（lib/bin.js 标记）且 package.json 版本 == 声明；
 *  - pnpm 在（bin/pnpm.cjs）且版本 == 声明（壳的下载通道跑的就是这份）。
 * 任何一项不满足都不 ok。escape hatch（DSH_SHELL_BUILTIN_SOURCE）过的树同样要过
 * 这道校验——离线 ≠ 换版本。
 */
export function verifyBuiltinTree(
  dir: string,
  declared: BuiltinRuntimeDeclaration,
  io: BuiltinIo = defaultBuiltinIo(),
): BuiltinTreeState {
  const problems: string[] = []
  const dshPkg = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const bin = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const pnpmCjs = join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  const pnpmPkg = join(dir, 'node_modules', 'pnpm', 'package.json')

  const readOrNull = (path: string): string | null => {
    try {
      return io.readText(path)
    } catch {
      return null
    }
  }

  let dshVersion: string | null = null
  if (!io.exists(dshPkg)) {
    problems.push('缺 dsh 包（node_modules/@deepseek-ai/dsh/package.json 不存在）')
  } else {
    dshVersion = dshVersionFromPackageJson(readOrNull(dshPkg) ?? '')
    if (dshVersion === null) problems.push('dsh 的 package.json 读不出版本号')
    else if (dshVersion !== declared.dsh) problems.push(`dsh 版本不符：落盘 ${dshVersion}，声明 ${declared.dsh}`)
    // 入口只在包在位时才单独查：整棵树都缺时「缺 dsh 包」一条就够，不叠报。
    if (!io.exists(bin)) problems.push('缺运行时入口（node_modules/@deepseek-ai/dsh/lib/bin.js）——不是一棵可用的 dsh 运行时树')
  }

  let pnpmVersion: string | null = null
  if (!io.exists(pnpmCjs)) {
    problems.push('缺内置 pnpm（node_modules/pnpm/bin/pnpm.cjs）——壳的运行时下载与 profile 依赖重建依赖它')
  } else {
    pnpmVersion = packageVersion(readOrNull(pnpmPkg) ?? '')
    if (pnpmVersion === null) problems.push('pnpm 的 package.json 读不出版本号')
    else if (pnpmVersion !== declared.pnpm) problems.push(`pnpm 版本不符：落盘 ${pnpmVersion}，声明 ${declared.pnpm}`)
  }

  return { ok: problems.length === 0, problems, dshVersion, pnpmVersion }
}

export type BuiltinSourcePlan =
  | { kind: 'reuse'; note: string }
  | { kind: 'external'; dir: string }
  | { kind: 'download' }

/**
 * 内置树来源计划（#16 后默认只剩两条正路）：目标树已是声明版本 → 复用；
 * 否则按声明下载。`force`（--force）跳过复用强制重物化。
 * DSH_SHELL_BUILTIN_SOURCE 是显式离线逃生口：一旦设置（非空白）就强制走它，
 * 后续校验同样要过；它不再是「有什么用什么」的隐式回退链的一环。
 */
export function planBuiltinSource(input: {
  envSource?: string | null
  targetReady: boolean
  force: boolean
}): BuiltinSourcePlan {
  const envSource = (input.envSource ?? '').trim()
  if (envSource !== '') return { kind: 'external', dir: envSource }
  if (!input.force && input.targetReady) return { kind: 'reuse', note: '已是声明版本' }
  return { kind: 'download' }
}
