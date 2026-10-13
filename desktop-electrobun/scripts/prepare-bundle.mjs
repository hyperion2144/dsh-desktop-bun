#!/usr/bin/env bun
// 构建期准备：
//  1) 把 Bun 兼容层物化进 desktop-electrobun/runtime/，供 electrobun.config.ts 的 build.copy
//     打进包内（打包后仓库不在身边，runtime.ts 的 layout() 会退到这份副本）。
//  2) 从仓库里的 Tauri 图标生成 icon.iconset（Electrobun 只吃 .iconset / .icon）。
//
// 单一来源仍是 desktop/src-tauri/ 下的资源（Tauri 壳与新壳共用），这里只做转换/拷贝 ——
// 不要在这里改内容，否则两条壳路径会漂移。
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DECLARATION_FILE, defaultBuiltinIo, planBuiltinSource, readBuiltinRuntimeDeclaration, verifyBuiltinTree } from '../src/shared/builtin-runtime.ts'
import { runtimeNpmrc, runtimeWorkspaceYaml } from '../src/shared/profile-template.ts'
import { NPM_PACKAGE } from '../src/shared/runtime-catalog.ts'
import { createHash } from 'node:crypto'

const projectRoot = resolve(import.meta.dir, '..')
const repoRoot = resolve(projectRoot, '..')

// ── 1. Bun 兼容层 ────────────────────────────────────────────────────────────
const preloadSource = resolve(repoRoot, 'resources', 'dsh', 'bun-preload.mjs')
const preloadTarget = join(projectRoot, 'runtime', 'bun-preload.mjs')

if (!existsSync(preloadSource)) {
  console.error(`[prepare-bundle] 找不到 Bun 兼容层单一来源：${preloadSource}`)
  process.exit(1)
}
mkdirSync(dirname(preloadTarget), { recursive: true })
copyFileSync(preloadSource, preloadTarget)
const sha256 = createHash('sha256').update(readFileSync(preloadTarget)).digest('hex')
console.log(`[prepare-bundle] ${preloadSource}`)
console.log(`            → ${preloadTarget}`)
console.log(`            sha256=${sha256}`)

// ── 2. 应用图标 ──────────────────────────────────────────────────────────────
const iconSource = resolve(repoRoot, 'resources', 'icons', 'icon.icns')
const iconTarget = join(projectRoot, 'icon.iconset')

if (existsSync(iconSource)) {
  rmSync(iconTarget, { recursive: true, force: true })
  const converted = spawnSync('iconutil', ['-c', 'iconset', iconSource, '-o', iconTarget], { stdio: 'inherit' })
  if (converted.status === 0 && existsSync(iconTarget)) {
    console.log(`[prepare-bundle] ${iconSource}`)
    console.log(`            → ${iconTarget}（iconutil）`)
  } else {
    console.warn(`[prepare-bundle] iconutil 转换失败（status=${String(converted.status)}），本次构建将使用默认图标`)
  }
} else {
  console.warn(`[prepare-bundle] 找不到图标来源：${iconSource}，本次构建将使用默认图标`)
}

// ── 3. 托盘图标 ───────────────────────────────────────────────────────────────
// 旧的 Tauri 壳用同一份 32x32.png 做托盘；这里拷成 resources/tray.png，
// 再由 build.copy 落进包内 runtime/tray.png（runtime.ts 的 trayImagePath 按这两处找）。
const traySource = resolve(repoRoot, 'resources', 'icons', '32x32.png')
const trayTarget = join(projectRoot, 'resources', 'tray.png')
if (existsSync(traySource)) {
  mkdirSync(dirname(trayTarget), { recursive: true })
  copyFileSync(traySource, trayTarget)
  console.log(`[prepare-bundle] ${traySource}`)
  console.log(`            → ${trayTarget}`)
} else {
  console.warn(`[prepare-bundle] 找不到托盘图标：${traySource}，本次构建不建托盘`)
}
// Windows 托盘：win32 原生用 .ico（HICON 加载 png 在部分壳层不渲染），拷一份 icon.ico 备用
const trayIcoSource = resolve(repoRoot, 'resources', 'icons', 'icon.ico')
const trayIcoTarget = join(projectRoot, 'resources', 'tray.ico')
if (existsSync(trayIcoSource)) {
  mkdirSync(dirname(trayIcoTarget), { recursive: true })
  copyFileSync(trayIcoSource, trayIcoTarget)
  console.log(`[prepare-bundle] ${trayIcoSource}`)
  console.log(`            → ${trayIcoTarget}`)
}
// A2：Windows 安装程序/提取器外壳 + 快捷方式 + 任务栏的应用图标（Electrobun win.icon）。
// resources/app-icon.ico 是仓内提交的多尺寸源（16..256，由 icon.png 生成）；缺失时退回旧壳单尺寸 icon.ico。
const appIconSource = resolve(repoRoot, 'resources', 'icons', 'icon.ico')
const appIconTarget = join(projectRoot, 'resources', 'app-icon.ico')
if (existsSync(appIconTarget)) {
  console.log(`[prepare-bundle] 应用图标（多尺寸）：${appIconTarget}`)
} else if (existsSync(appIconSource)) {
  mkdirSync(dirname(appIconTarget), { recursive: true })
  copyFileSync(appIconSource, appIconTarget)
  console.warn('[prepare-bundle] 仓内 resources/app-icon.ico 缺失，退回单尺寸 icon.ico（安装外壳图标质量差）')
} else {
  console.warn('[prepare-bundle] 找不到应用图标，Windows 安装外壳将没有应用图标')
}

// ── 4. 内置 dsh 运行时（随包发出）───────────────────────────────────────
// 为什么必须随包：ADR 0004 的页面资产取自「当前生效运行时」的 dist。以前新壳只有
// “下载的运行时”，干净机器上首次启动直接报「找不到可用的 dsh 运行时」（实测），
// 内置树随包后才有兜底（与旧 Tauri 壳的 resources/dsh 同语义）。
//
// 供给唯一路径（#16）：声明（builtin-runtime.json）→ 按声明版本经 npm 拉取
// （bun x pnpm，与壳「下载运行时」同通道：hoisted 平铺 + 独立 store + allowBuilds
// 白名单）→ 物化进 builtin-runtime/ → 落盘树逐项校验，不符 fail 构建。
// 旧「来源链」（仓内 Tauri 树 / 本机已下载运行时倒序取最新）已退役：那让产物版本
// 取决于构建机上碰巧有什么。DSH_SHELL_BUILTIN_SOURCE 仅作显式离线逃生口，且树版本
// 同样必须与声明一致（离线 ≠ 换版本）；任何一步不满足都退出非零，绝不带病打包。
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000
const builtinTarget = join(projectRoot, 'builtin-runtime')
const builtinIo = defaultBuiltinIo()
const copyFilter = (src) => {
  const name = src.split(/[\\/]/).pop() ?? ''
  return name !== '.DS_Store' && !name.startsWith('._') && name !== '.git'
}

const declared = readBuiltinRuntimeDeclaration(join(projectRoot, DECLARATION_FILE))
if (declared === null) {
  console.error(`[prepare-bundle] 内置运行时声明读不出来：${join(projectRoot, DECLARATION_FILE)}（应形如 {"dsh":"x.y.z-…","pnpm":"a.b.c"}）`)
  process.exit(1)
}
console.log(`[prepare-bundle] 内置运行时声明：dsh ${declared.dsh} + pnpm ${declared.pnpm}（${DECLARATION_FILE}）`)

// 物化成功后统一走这里：再校验一遍落盘树 + 写元数据记录。校验不过 = fail 构建。
const finishBuiltin = (source) => {
  const state = verifyBuiltinTree(builtinTarget, declared, builtinIo)
  if (!state.ok) {
    for (const problem of state.problems) console.error(`[prepare-bundle] 内置树校验失败：${problem}`)
    console.error('[prepare-bundle] 落盘内置运行时与声明不一致——修声明或修来源，不要带病打包（#16）')
    process.exit(1)
  }
  const counted = spawnSync('sh', ['-c', `find ${JSON.stringify(builtinTarget)} -type f | wc -l`], { encoding: 'utf8' })
  const files = (counted.stdout ?? '').trim()
  writeFileSync(
    join(builtinTarget, '.builtin-runtime.json'),
    `${JSON.stringify({ version: state.dshVersion, pnpm: state.pnpmVersion, declared, source, files: Number(files) || 0 }, null, 2)}\n`,
  )
  console.log(`[prepare-bundle] ${builtinTarget}`)
  console.log(`            （内置 dsh ${state.dshVersion} + pnpm ${state.pnpmVersion}，${files} 个文件，来源 ${source}）`)
}

const plan = planBuiltinSource({
  envSource: process.env.DSH_SHELL_BUILTIN_SOURCE,
  targetReady: verifyBuiltinTree(builtinTarget, declared, builtinIo).ok,
  force: process.argv.includes('--force'),
})

if (plan.kind === 'reuse') {
  console.log(`[prepare-bundle] builtin-runtime 已是声明版本（dsh ${declared.dsh}），跳过下载（--force 重物化）`)
} else if (plan.kind === 'external') {
  console.log(`[prepare-bundle] 离线逃生口 DSH_SHELL_BUILTIN_SOURCE = ${plan.dir}（仍按声明校验）`)
  if (!builtinIo.exists(plan.dir)) {
    console.error(`[prepare-bundle] DSH_SHELL_BUILTIN_SOURCE 指向的目录不存在：${plan.dir}`)
    process.exit(1)
  }
  rmSync(builtinTarget, { recursive: true, force: true })
  cpSync(plan.dir, builtinTarget, { recursive: true, dereference: true, filter: copyFilter })
  finishBuiltin('DSH_SHELL_BUILTIN_SOURCE')
} else {
  const stage = resolve(repoRoot, '.builtin-stage')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify({ name: 'dsh-builtin-stage', private: true }, null, 2)}\n`)
  // 与壳「下载运行时」同一套配置：workspace 自声明截断向上搜索、hoisted 平铺（与内置树
  // 同构）、独立 store、allowBuilds 白名单（旧壳 #95/#114/#135 的坑全在这里）。
  writeFileSync(join(stage, 'pnpm-workspace.yaml'), runtimeWorkspaceYaml(join(stage, '.pnpm-store')))
  writeFileSync(join(stage, '.npmrc'), runtimeNpmrc(join(stage, '.pnpm-store')))
  console.log(`[prepare-bundle] 按声明下载：${NPM_PACKAGE}@${declared.dsh} + pnpm@${declared.pnpm} → ${stage}`)
  const installed = spawnSync(
    process.execPath,
    ['x', `pnpm@${declared.pnpm}`, 'add', '--reporter=default', `${NPM_PACKAGE}@${declared.dsh}`, `pnpm@${declared.pnpm}`],
    { cwd: stage, stdio: 'inherit', timeout: DOWNLOAD_TIMEOUT_MS },
  )
  if (installed.status !== 0) {
    const reason = installed.error === undefined ? `exit ${String(installed.status)}` : String(installed.error)
    console.error(`[prepare-bundle] 按声明下载内置运行时失败（${reason}）——构建不带与声明不符/缺失的内置 dsh（#16）`)
    process.exit(1)
  }
  const staged = verifyBuiltinTree(stage, declared, builtinIo)
  if (!staged.ok) {
    for (const problem of staged.problems) console.error(`[prepare-bundle] 下载树校验失败：${problem}`)
    process.exit(1)
  }
  rmSync(builtinTarget, { recursive: true, force: true })
  cpSync(join(stage, 'node_modules'), join(builtinTarget, 'node_modules'), { recursive: true, dereference: true, filter: copyFilter })
  finishBuiltin(`npm:${NPM_PACKAGE}@${declared.dsh}`)
  rmSync(stage, { recursive: true, force: true })
}
