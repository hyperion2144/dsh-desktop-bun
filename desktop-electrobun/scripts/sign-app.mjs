#!/usr/bin/env node
// 打包后的 ad-hoc 封装签名（#220 起，#115 实机钉死完整规格）。
//
// UNUserNotificationCenter 把请求归属到 app 的依据，是【发起请求的进程自己的代码签名】
// 是否认领 bundle 的 CFBundleIdentifier。本壳的实际 JS 主进程是 Contents/MacOS/bun
// （跑 Resources/main.js），构建期它是 Apple 开发者签名（Identifier=bun + Info.plist=not
// bound）——归属永远失败：requestAuthorization 恒 not_determined 且不弹授权窗（#115 实机：
// 只签 Frameworks + 外层仍复现；补签 bun 认领 bundle id 后，面板立即读回真实授权态、通知恢复）。
//
// 所以完整规格是三层，缺一不可：
// ① Contents/MacOS 下每个 Mach-O 以 `--identifier <CFBundleIdentifier>` ad-hoc 重签，
//    并原样保留既有 entitlements（bun 带 5 条 CEF/V8 豁免，比仓库 plist 多
//    disable-executable-page-protection，丢了会 Fatal OOM）；
// ② Contents/Frameworks 的 .framework / 内嵌 .app / dylib；
// ③ 外层 bundle 带 --entitlements（这一步才把 Info.plist 绑进 CFBundleExecutable 的签名）。
//
// 不需要 Developer ID、不做公证；规格 #220 的「代码签名与公证」仍在 Out of Scope（这只是
// 本机封装层的一致性）。也不能用 `codesign --deep` 一步签：--deep 之后可执行体仍是构建期
// 独立签名（#115 实测复现）。
//
// 用法：node scripts/sign-app.mjs [app 路径]      （不给就找 build/ 下最新的 .app）

import { execFileSync } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')

/** 深度受限地找 .app（Electrobun 的产物层级不固定：build/<channel>-<平台>/<名字>.app）。 */
function findApps(dir, depth = 0) {
  if (depth > 3) return []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const hits = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    if (entry.name.endsWith('.app')) hits.push(full)
    else hits.push(...findApps(full, depth + 1))
  }
  return hits
}

function newestApp() {
  const buildDir = join(projectRoot, 'build')
  const apps = findApps(buildDir)
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)
  return apps[0]?.path ?? null
}

const entTempFiles = []

/** 提取既有 entitlements 到临时文件：构建期签名的可执行体可能带 CEF/V8 豁免，重签必须原样保留。 */
function preservedEntitlements(path) {
  const got = spawnSync('codesign', ['-d', '--entitlements', ':-', path], { encoding: 'utf8' })
  const xml = (got.stdout ?? '').trim()
  if (!xml.startsWith('<?xml') && !xml.startsWith('<plist')) return null
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-ent-')), 'ent.plist')
  writeFileSync(file, xml)
  entTempFiles.push(file)
  return file
}

const target = process.argv[2] ?? process.env.DSH_SHELL_SIGN_APP ?? newestApp()
if (target === null || target === undefined) {
  console.error('[sign-app] 没找到要签的 .app（先跑 hutch electrobun build，或把路径当参数传进来）')
  process.exit(1)
}
if (process.platform !== 'darwin') {
  console.log(`[sign-app] 非 macOS（${process.platform}），跳过封装签名：${target}`)
  process.exit(0)
}

console.log(`[sign-app] ad-hoc 重签（MacOS 执行体 → Frameworks → 外层）：${target}`)
// P10：带上旧壳同款 entitlements（CEF/V8 初始化需要 JIT 豁免，缺了会 Fatal OOM）——挂外层主执行文件。
const entitlements = join(projectRoot, 'resources', 'entitlements.plist')
const outerSignArgs = ['--force', '--sign', '-']
if (existsSync(entitlements)) outerSignArgs.push('--entitlements', entitlements)
const bundleId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(target, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
// ① Contents/MacOS 下的每个 Mach-O 自己认领 bundle id（#115 实机：真正的 JS 主进程是 bun，
// 构建期签名 Identifier=bun，归属永远失败；--identifier 是 Electron helper 同款约定）。
// 每个文件原样保留既有 entitlements（bun 比仓库 plist 多 disable-executable-page-protection）。
const macosDir = join(target, 'Contents', 'MacOS')
if (existsSync(macosDir)) {
  for (const entry of readdirSync(macosDir)) {
    const full = join(macosDir, entry)
    if (!statSync(full).isFile()) continue
    const preserved = preservedEntitlements(full)
    const args = ['--force', '--sign', '-', '--identifier', bundleId]
    if (preserved !== null) args.push('--entitlements', preserved)
    execFileSync('codesign', [...args, full], { stdio: 'inherit' })
  }
}
// ② 嵌套 bundle / framework / dylib。
const frameworksDir = join(target, 'Contents', 'Frameworks')
if (existsSync(frameworksDir)) {
  for (const entry of readdirSync(frameworksDir)) {
    if (!entry.endsWith('.framework') && !entry.endsWith('.app') && !entry.endsWith('.dylib')) continue
    execFileSync('codesign', ['--force', '--sign', '-', join(frameworksDir, entry)], { stdio: 'inherit' })
  }
}
// ③ 外层最后签：这一步才把 Info.plist 绑进 CFBundleExecutable 的签名。
execFileSync('codesign', [...outerSignArgs, target], { stdio: 'inherit' })
for (const file of entTempFiles) rmSync(file, { force: true })

// 读回签名：`codesign -dv` 把详情写在 **stderr**（stdout 是空的），所以两路都要收
const check = spawnSync('codesign', ['-dv', target], { encoding: 'utf8' })
const detail = `${check.stdout ?? ''}${check.stderr ?? ''}`
const identifier = /Identifier=(\S+)/.exec(detail)?.[1] ?? '(未知)'
const plistEntries = /Info\.plist entries=(\d+)/.exec(detail)?.[1] ?? '0'
console.log(`[sign-app] Identifier=${identifier}  Info.plist entries=${plistEntries}`)
if (plistEntries === '0') {
  console.error('[sign-app] Info.plist 没被绑进签名（通知授权仍会失败）；检查 .app 结构')
  process.exit(1)
}

// ── DMG 重建（交付面修复）：`hutch electrobun build` 是「先打 DMG、后由本脚本重签 .app」──
// 它打包时用的是未重签的 .app（linker-signed，Info.plist=not bound，bundle 无 _CodeSignature），
// 而上游 CI 上传的正是那份 DMG：用户装到的是签名不合法的包，macOS（arm64 至少要求合法 ad-hoc
// 签名）直接报「已损坏，无法打开」。签完必须把 DMG 用签名后的 .app 重打一遍，并挂载复核。
const artifactsDir = join(projectRoot, 'artifacts')
const dmgFiles = existsSync(artifactsDir)
  ? readdirSync(artifactsDir).filter((name) => name.endsWith('.dmg'))
  : []

if (dmgFiles.length === 0) {
  console.log('[sign-app] artifacts/ 下没有 .dmg（本地开发常见），跳过 DMG 重建')
} else {
  for (const name of dmgFiles) {
    const dmgPath = join(artifactsDir, name)
    try {
      repackDmg(dmgPath, target)
    } catch (error) {
      console.error(`[sign-app] DMG 重建失败（${dmgPath}）：${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
  }
}

/** 用已签名的 .app 重打 DMG（保留 /Applications 拖放入口），覆盖前先挂载复核签名。 */
function repackDmg(dmgPath, appPath) {
  const appName = basename(appPath)
  const volumeName = appName.replace(/\.app$/, '')
  const work = mkdtempSync(join(tmpdir(), 'dsh-dmg-'))
  const root = join(work, 'root')
  const outDmg = join(work, `${volumeName}.dmg`)
  const mountPoint = join(work, 'mnt')
  mkdirSync(root)
  mkdirSync(mountPoint)
  // ditto 比 cp -R 更忠于 Apple 元数据（资源叉/扩展属性/签名文件），别换成 fs.cpSync
  execFileSync('ditto', [appPath, join(root, appName)], { stdio: 'inherit' })
  execFileSync('ln', ['-s', '/Applications', join(root, 'Applications')], { stdio: 'inherit' })
  execFileSync('hdiutil', ['create', '-volname', volumeName, '-srcfolder', root, '-ov', '-format', 'UDZO', '-fs', 'HFS+', outDmg], {
    stdio: 'inherit',
  })
  try {
    execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, outDmg], { stdio: 'inherit' })
    try {
      execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', join(mountPoint, appName)], { stdio: 'inherit' })
      console.log(`[sign-app] DMG 复核通过（签名合法）：${appName}`)
    } finally {
      execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'inherit' })
    }
  } finally {
    if (existsSync(mountPoint)) rmSync(mountPoint, { recursive: true, force: true })
  }
  renameSync(outDmg, dmgPath)
  rmSync(work, { recursive: true, force: true })
  console.log(`[sign-app] DMG 已用签名后的 .app 重打：${dmgPath}`)
}
