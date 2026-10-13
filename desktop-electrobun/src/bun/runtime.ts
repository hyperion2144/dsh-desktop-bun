// 运行时定位：显式覆盖 / 已下载运行时 / 随包内置三种来源的发现与选中，
// 布局计算（dsh lib、前端 dist、Bun 兼容层、宿主脚本）都在这里。
//
// 与旧壳 desktop/src-tauri/src/runtime/builtin.rs + registry.rs 对齐：选中顺序为
// 显式覆盖 > 偏好/最高已下载版本 > 随包内置；两套目录布局
// 都要认（appSupport/runtimes 是 root 布局，override 指到 dsh 包根时是 package 布局）。

import { profileDirOf } from './profile-scaffold.ts'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  externalVersion,
  readRuntimeVersion,
  runtimesDir,
  runtimeDirOf,
  scanInstalledVersions,
} from './runtime-store.ts'
import { isRuntimeVersion, selectRuntimeVersion } from '../shared/runtime-catalog.ts'

export const APP_SUPPORT = 'Library/Application Support/com.hyperion.dsh-desktop-bun'

export interface ShellLayout {
  /** ~/.dsh 或 DSH_HOME */
  home: string
  profile: string
  /** profile 目录绝对路径（<home>/profiles/<name>，宿主 argv 用） */
  profileDir: string
  /** 应用支持目录（运行时树所在） */
  appSupport: string
  /** 运行时来源：override=env 指定 / installed=已下载 / builtin=随包 */
  runtimeKind: RuntimeKind
  /** 运行时根：root 布局的树根，或 override 指到 dsh 包根时的包根 */
  runtimeDir: string
  /** 运行时真实版本号（读 dsh/package.json；读不到为 null） */
  runtimeVersion: string | null
  /** 选中过程中的回退说明（外部 CLI 移除后当前恒 null，保留给日志与面板） */
  runtimeNote: string | null
  /** dsh 包的 lib 目录（宿主脚本的入参） */
  dshLibDir: string
  /** 前端 dist（本地文档与静态资产的来源） */
  distDir: string
  /** Bun 兼容层（preload 补丁），单一来源在仓根 resources/dsh/bun-preload.mjs */
  preloadFile: string
  /** 宿主脚本 */
  hostScript: string
  /** 仓库根（开发态插件包与脚本的来源） */
  repoRoot: string
  /** 打包态资源根（`Contents/Resources`）；开发态为 null */
  resourcesDir: string | null
}

export interface LayoutInput {
  env?: Record<string, string | undefined>
  /** 覆盖运行时目录（测试/多运行时用） */
  runtimeDir?: string
  /** 覆盖 profile（设置里选了别的 profile 时给；缺省按 DSH_PROFILE > default） */
  profile?: string
  /** 偏好的已下载运行时版本（settings.dshRuntime；失效则退回最高版本） */
  preferred?: string | null
  /** 随包内置树目录（缺省按打包态 resources/dsh、开发态仓根 resources/builtin 找） */
  builtinDir?: string | null
}

export function dshHome(env: Record<string, string | undefined> = process.env): string {
  const home = env.DSH_HOME
  if (home !== undefined && home !== '') return home
  return join(homedir(), '.dsh')
}

export function appSupportDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.DSH_SHELL_APP_SUPPORT
  if (override !== undefined && override !== '') return override
  return join(homedir(), APP_SUPPORT)
}

/**
 * 托盘图标：仓内单一来源是 `resources/icons/32x32.png`，构建期（prepare-bundle）
 * 拷成 `desktop-electrobun/resources/tray.png`，打包时再由 build.copy 落进包内 `runtime/tray.png`。
 * 三处都找不到就返回 null——没有图标就不建托盘，别用默认图标骗人。
 */
export function trayImagePath(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env.DSH_SHELL_TRAY_IMAGE
  if (explicit !== undefined && explicit !== '') return explicit
  const projectRoot =
    env.DSH_SHELL_PROJECT ?? findProjectRoot(import.meta.dir) ?? packagedRoot(import.meta.dir) ?? resolve(import.meta.dir, '..', '..')
  const candidates = process.platform === 'win32'
    ? [
        join(projectRoot, 'resources', 'tray.ico'),
        join(projectRoot, 'runtime', 'tray.ico'),
        join(resolve(projectRoot, '..'), 'resources', 'icons', 'icon.ico'),
        join(projectRoot, 'resources', 'tray.png'),
        join(projectRoot, 'runtime', 'tray.png'),
      ]
    : [
        join(projectRoot, 'resources', 'tray.png'),
        join(projectRoot, 'runtime', 'tray.png'),
        join(resolve(projectRoot, '..'), 'resources', 'icons', '32x32.png'),
      ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export type RuntimeKind = 'override' | 'installed' | 'builtin'

/** 两套目录布局：root = 树根下有 node_modules（随包内置 / 已下载）；package = dsh 包根（override 指到包根布局的树） */
export type RuntimeLayout = 'root' | 'package'

export interface RuntimeSelection {
  kind: RuntimeKind
  root: string
  layout: RuntimeLayout
  version: string | null
  /** 选中过程中的回退说明（外部 CLI 移除后当前恒 null） */
  note: string | null
}

/** 一套运行时树的 dsh lib 与前端 dist：root 布局与 dsh 包根布局都认。 */
export function runtimePathsOf(root: string, layout: RuntimeLayout = 'root'): { dshLibDir: string; distDir: string } {
  const dshLibDir = layout === 'package' ? join(root, 'lib') : join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  const candidates =
    layout === 'package'
      ? [
          join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'),
          join(resolve(root, '..'), 'dsh-web-frontend', 'dist'),
          join(resolve(root, '..', '..'), 'dsh-web-frontend', 'dist'),
        ]
      : [
          join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'),
          join(resolve(dshLibDir, '..'), 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'),
        ]
  const distDir = candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? (candidates[0] as string)
  return { dshLibDir, distDir }
}

/** 随包内置树：打包态 `resources/dsh`，开发态仓库 `desktop/src-tauri/resources/dsh`。 */
export function resolveBuiltinRuntimeDir(
  env: Record<string, string | undefined>,
  roots: { repoRoot: string; resourcesDir: string | null },
): string | null {
  const explicit = env.DSH_SHELL_BUILTIN_DIR
  const candidates = [
    explicit !== undefined && explicit !== '' ? explicit : null,
    roots.resourcesDir === null ? null : join(roots.resourcesDir, 'dsh'),
    join(roots.repoRoot, 'resources', 'builtin'),
  ].filter((value): value is string => value !== null)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) return resolve(candidate)
  }
  return null
}

export interface RuntimeSelectionInput {
  env?: Record<string, string | undefined>
  /** 显式覆盖（LayoutInput.runtimeDir / DSH_SHELL_RUNTIME_DIR） */
  overrideDir?: string
  appSupport?: string
  preferred?: string | null
  builtinDir?: string | null
  /** 测试注入：已装版本列表（跳过磁盘扫描） */
  installed?: readonly string[]
}

function versionOf(root: string, layout: RuntimeLayout): string | null {
  return layout === 'package' ? externalVersion(root) : readRuntimeVersion(root)
}

/**
 * 生效运行时（旧壳 builtin.rs 的选中顺序）：
 * 显式覆盖 > 已下载版本（偏好 > 最高）> 随包内置。外部 dsh CLI 支持已移除（#3）。
 */
export function resolveRuntimeSelection(input: RuntimeSelectionInput = {}): RuntimeSelection {
  const env = input.env ?? process.env
  const override = input.overrideDir !== undefined && input.overrideDir !== '' ? input.overrideDir : env.DSH_SHELL_RUNTIME_DIR
  if (override !== undefined && override !== '') {
    const root = resolve(override)
    const layout: RuntimeLayout = existsSync(join(root, 'lib', 'bin.js')) ? 'package' : 'root'
    return { kind: 'override', root, layout, version: versionOf(root, layout), note: null }
  }
  const appSupport = input.appSupport ?? appSupportDir(env)
  const installed = input.installed !== undefined ? input.installed : scanInstalledVersions(appSupport)
  const picked = selectRuntimeVersion({ installed, preferred: input.preferred ?? null })
  if (picked !== null && isRuntimeVersion(picked)) {
    const root = runtimeDirOf(appSupport, picked)
    return { kind: 'installed', root, layout: 'root', version: readRuntimeVersion(root) ?? picked, note: null }
  }
  const builtin = input.builtinDir ?? null
  if (builtin !== null && builtin !== '') {
    const root = resolve(builtin)
    return { kind: 'builtin', root, layout: 'root', version: readRuntimeVersion(root), note: null }
  }
  throw new Error(
    `找不到可用的 dsh 运行时：已下载目录 ${runtimesDir(appSupport)} 为空，也没找到随包内置树（可用 DSH_SHELL_RUNTIME_DIR / DSH_SHELL_BUILTIN_DIR 指定）`
  )
}

/** 兼容旧签名：只关心运行时根的地方用它。 */
export function resolveRuntimeDir(input: LayoutInput = {}): string {
  return resolveRuntimeSelection({ env: input.env, overrideDir: input.runtimeDir, preferred: input.preferred, builtinDir: input.builtinDir }).root
}

/** 从某目录往上找带 `runtime/dsh-host.mjs` + `package.json` 的项目根（最多 8 层）。 */
function findProjectRoot(startDir: string): string | null {
  let dir = startDir
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'runtime', 'dsh-host.mjs')) && existsSync(join(dir, 'package.json'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** 打包后的包内资源根：主进程在 <app>/Contents/Resources/app/bun/index.js，构建期把
 *  runtime/{dsh-host.mjs,bun-preload.mjs} 拷到 <app>/Contents/Resources/app/runtime/。 */
function packagedRoot(startDir: string): string | null {
  for (const candidate of [resolve(startDir, '..'), startDir, resolve(startDir, '..', '..')]) {
    if (existsSync(join(candidate, 'runtime', 'dsh-host.mjs'))) return candidate
  }
  return null
}

/** 打包态的 `Contents/Resources`：只有在那里真的存在 `plugins/<壳插件>` 时才算数。 */
function packagedResources(startDir: string): string | null {
  for (const candidate of [resolve(startDir, '..', '..'), resolve(startDir, '..')]) {
    if (existsSync(join(candidate, 'plugins', 'dsh-desktop-bun', 'package.json'))) return candidate
  }
  return null
}

export function layout(input: LayoutInput = {}): ShellLayout {
  const env = input.env ?? process.env
  const home = dshHome(env)
  const profile =
    input.profile !== undefined && input.profile !== ''
      ? input.profile
      : env.DSH_PROFILE !== undefined && env.DSH_PROFILE !== ''
        ? env.DSH_PROFILE
        : 'desktop'
  // 项目根：开发时是 desktop-electrobun/（源码里的 import.meta.dir 往上找）；
  // 打包后是包内 <app>/Contents/Resources/app（主进程在 app/bun/index.js），
  // 那里由构建期 build.copy 放一份 runtime/{dsh-host.mjs,bun-preload.mjs}。
  const projectRoot = env.DSH_SHELL_PROJECT ?? findProjectRoot(import.meta.dir) ?? packagedRoot(import.meta.dir) ?? resolve(import.meta.dir, '..', '..')
  const repoRoot = resolve(projectRoot, '..')
  const resourcesDir = env.DSH_SHELL_RESOURCES ?? packagedResources(import.meta.dir)
  // 运行时选中：显式覆盖 > 已下载（偏好 > 最高）> 随包内置
  const selection = resolveRuntimeSelection({
    env,
    overrideDir: input.runtimeDir,
    appSupport: appSupportDir(env),
    preferred: input.preferred,
    builtinDir: resolveBuiltinRuntimeDir(env, { repoRoot, resourcesDir }),
  })
  const runtimeDir = selection.root
  const runtimePaths = runtimePathsOf(runtimeDir, selection.layout)
  const dshLibDir = runtimePaths.dshLibDir
  const distDir = env.DSH_SHELL_DIST ?? runtimePaths.distDir
  // Bun 兼容层是仓内单一来源（resources/dsh/bun-preload.mjs）：
  // 开发与 CI 直接用仓库路径；打包后仓库不在身边，改用构建期物化进包内的副本。
  const repoPreload = join(repoRoot, 'resources', 'dsh', 'bun-preload.mjs')
  const bundledPreload = join(projectRoot, 'runtime', 'bun-preload.mjs')
  const preloadFile = env.DSH_SHELL_PRELOAD ?? (existsSync(repoPreload) ? repoPreload : bundledPreload)
  const hostScript = env.DSH_SHELL_HOST_SCRIPT ?? join(projectRoot, 'runtime', 'dsh-host.mjs')
  const result: ShellLayout = {
    home,
    profile,
    profileDir: profileDirOf(home, profile),
    appSupport: appSupportDir(env),
    runtimeKind: selection.kind,
    runtimeDir,
    runtimeVersion: selection.version,
    runtimeNote: selection.note,
    dshLibDir,
    distDir,
    preloadFile,
    hostScript,
    repoRoot,
    resourcesDir,
  }
  const missing = [
    ['dsh lib', dshLibDir],
    ['前端 dist', distDir],
    ['Bun 兼容层', preloadFile],
    ['宿主脚本', hostScript],
  ].filter(([, path]) => !existsSync(path as string))
  if (missing.length > 0) {
    throw new Error(`壳布局不完整：${missing.map(([label, path]) => `${label}=${String(path)}`).join(' | ')}`)
  }
  return result
}
