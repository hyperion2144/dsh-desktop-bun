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
import { DECLARATION_FILE, defaultBuiltinIo, planBuiltinSource, readBuiltinRuntimeDeclaration, verifyBuiltinTree } from '../src/shared/runtime/builtin-runtime.ts'
import { runtimeNpmrc, runtimeWorkspaceYaml } from '../src/shared/profiles/profile-template.ts'
import { NPM_PACKAGE } from '../src/shared/runtime/runtime-catalog.ts'
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
// Windows 托盘：官方 tray-windows.ico 原字节直拷。官方由 scripts/render-tray-icon.ts 从
// icon-windows.svg 逐尺寸光栅化（16..64 七帧）并提交产物，托盘尺寸下每档都锐利；
// 不从应用图标 ico 借帧——那些小帧是为桌面尺寸画的，托盘下偏糊。
const trayIcoSource = resolve(repoRoot, 'resources', 'icons', 'tray.ico')
const trayIcoTarget = join(projectRoot, 'resources', 'tray.ico')
if (existsSync(trayIcoSource)) {
  mkdirSync(dirname(trayIcoTarget), { recursive: true })
  copyFileSync(trayIcoSource, trayIcoTarget)
  console.log(`[prepare-bundle] ${trayIcoSource}`)
  console.log(`            → ${trayIcoTarget}`)
}
// A2：Windows 安装程序/提取器外壳 + 快捷方式 + 任务栏的应用图标（Electrobun win.icon）。
// resources/app-icon.ico 是仓内提交的多尺寸源（16..256，scripts/render-app-icon.mjs 从
// icon-windows.svg 逐尺寸光栅化生成，与官方托盘同一转换方式）；缺失时退回托盘 ico。
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

// ── 5. 预打 bun 兼容层补丁（#143）────────────────────────────────────────
// 为什么必须在构建期打：内置运行时随包住在 .app 里，而 bun-preload.mjs 的补丁是**就地写入
// 运行时树**的；启动后才写 = 在签名之后改 sealed resource，整个 app 的 resource seal 当场作废
// （codesign --verify 报 `file modified: node_modules/…/index.js`）。而 macOS 的 TCC 把授权记成
// (bundle id, service, csreq)，匹配时走的就是「这段代码通不通得过校验」——seal 一破，屏幕录制/
// 麦克风的授权永远对不上，于是闸门亮着也照样反复弹窗。
//
// 所以这里用运行时同一套补丁逻辑先把树打成「当前 rev 已就位」，再交给 sign-app 签名：进程起来
// 时 hasCurrentRev() 全命中，一个字节都不写，seal 保持完整。
function prepatchBuiltinRuntime() {
  const preload = join(projectRoot, 'runtime', 'bun-preload.mjs')
  if (!existsSync(preload)) {
    console.error(`[prepare-bundle] 找不到兼容层 preload：${preload}`)
    process.exit(1)
  }
  const ran = spawnSync(process.execPath, ['--preload', preload, '-e', '0'], {
    cwd: builtinTarget,
    env: { ...process.env, DSH_BUN_PRELOAD_TREES: builtinTarget },
    stdio: 'inherit',
    timeout: 5 * 60_000,
  })
  if (ran.status !== 0) {
    console.error(`[prepare-bundle] 预打兼容层补丁失败（exit ${String(ran.status)}）`)
    process.exit(1)
  }
  // 断言：至少 node-pty 已被打成当前 rev，否则说明 roots 没指到内置树（运行时还会去写）
  const marker = 'bun-preload-rev:'
  const probe = join(builtinTarget, 'node_modules', 'node-pty', 'lib', 'index.js')
  let ok = false
  try {
    ok = readFileSync(probe, 'utf8').includes(marker)
  } catch {
    ok = false
  }
  if (!ok) {
    console.error('[prepare-bundle] 内置树没有预打上兼容层补丁（node-pty 仍是原样）——',
      '运行时会在签名后改写它，TCC 授权会因此失配（#143）')
    process.exit(1)
  }

  const inspectorClient = join(
    builtinTarget,
    'node_modules',
    '@deepseek-ai',
    'dsh-experimental-inspector',
    'lib',
    'client.js',
  )
  if (existsSync(inspectorClient)) {
    let inspectorPatched = false
    try {
      inspectorPatched = readFileSync(inspectorClient, 'utf8').includes('bun-preload: bootstrap 有界退避重试')
    } catch {
      inspectorPatched = false
    }
    if (!inspectorPatched) {
      console.error(
        '[prepare-bundle] 内置树的 inspector Client 没有预打 Patch 16（bootstrap 退避重试 / F7 日志）——',
        '上游 client.js 形状可能变了，检查 resources/dsh/bun-preload.mjs 的锚点',
      )
      process.exit(1)
    }
  }
  console.log('[prepare-bundle] 内置运行时已预打兼容层补丁（rev 已就位，运行时不会再写这棵树）')
}

prepatchBuiltinRuntime()
