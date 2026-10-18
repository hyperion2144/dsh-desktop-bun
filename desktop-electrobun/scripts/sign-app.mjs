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
//    各层都用 `-r 'designated => identifier "<CFBundleIdentifier>"'` 换掉默认的 cdhash 型
//    designated requirement（#143）：TCC 把授权记在 csreq 里，cdhash 一变就匹配不上。
//
// 不需要 Developer ID、不做公证；规格 #220 的「代码签名与公证」仍在 Out of Scope（这只是
// 本机封装层的一致性）。也不能用 `codesign --deep` 一步签：--deep 之后可执行体仍是构建期
// 独立签名（#115 实测复现）。
//
// 用法：node scripts/sign-app.mjs [app 路径]      （不给就找 build/ 下最新的 .app）

import { execFileSync } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/** 归属断言：Contents/MacOS 下每个 Mach-O 的签名 Identifier 必须认领 bundle id（#132）。
 * `codesign --verify --deep --strict` 只验 seal 完整性、不验归属——#115/#132 实机：首启自解压
 * 把 bun 打回 Apple 开发者签名（Identifier=bun）时复核照样通过，UN 授权归属静默失效。
 */
function assertMacosAttribution(appPath, expectedBundleId) {
  const macosDir = join(appPath, 'Contents', 'MacOS')
  if (!existsSync(macosDir)) return
  for (const entry of readdirSync(macosDir)) {
    const full = join(macosDir, entry)
    if (!statSync(full).isFile()) continue
    const probe = spawnSync('codesign', ['-dv', full], { encoding: 'utf8' })
    const found = /Identifier=(\S+)/.exec(`${probe.stdout ?? ''}${probe.stderr ?? ''}`)?.[1] ?? null
    if (found !== expectedBundleId) {
      console.error(`[sign-app] 归属断言失败：${entry} 的签名 Identifier=${found ?? '（无签名）'} ≠ ${expectedBundleId}；UN 通知授权归属会静默失效（#132）`)
      process.exit(1)
    }
  }
  console.log(`[sign-app] 归属断言通过：Contents/MacOS 全部 Mach-O 认领 ${expectedBundleId}`)
}

/** #132：bootstrap 产物（hutch electrobun build 的直接产物）本身只有 launcher+payload+metadata，
 * 完整 app 藏在 Contents/Resources/<hash>.tar.zst（metadata.json 的 hash 字段=文件名引用，实测
 * 不校验内容）里；首装/首启自解压会覆盖整棵树。所以要把 payload 解出来→对完整树做层①②③→
 * 归属断言→用签名后的树重打回去，首启解压出来的即已签名字节。完整 app 形态（已解压/已安装）
 * 没有 payload，跳过。zstd 缺失时明示跳过（退回 #115 的「装好后重签」手工流程）。 */
function signInsideBootstrapPayload(appPath, bundleId) {
  const resourcesDir = join(appPath, 'Contents', 'Resources')
  const payloads = existsSync(resourcesDir)
    ? readdirSync(resourcesDir).filter((name) => name.endsWith('.tar.zst'))
    : []
  if (payloads.length === 0) {
    console.log('[sign-app] Resources 没有 .tar.zst payload（完整 app 形态），跳过 payload 内层处理')
    return
  }
  if (payloads.length > 1) {
    console.error(`[sign-app] Resources 下出现多个 payload（${payloads.join('、')}），契约不明，拒绝处理（#132）`)
    process.exit(1)
  }
  const zstd = ['/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', 'zstd'].find((candidate) => spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0)
  if (zstd === undefined) {
    console.warn('[sign-app] 找不到 zstd（brew install zstd），跳过 payload 重打：首启自解压仍会用未签名树覆盖（#132）')
    return
  }
  const payloadName = payloads[0]
  const payloadPath = join(resourcesDir, payloadName)
  const work = mkdtempSync(join(tmpdir(), 'dsh-payload-'))
  try {
    console.log(`[sign-app] 处理首启 payload：${payloadName}（解出完整树 → 三层签名 → 归属断言 → 重打回）`)
    const stageTar = join(work, 'stage.tar')
    const extractRoot = join(work, 'tree')
    mkdirSync(extractRoot, { recursive: true })
    execFileSync(zstd, ['-dc', payloadPath, '-o', stageTar])
    execFileSync('/usr/bin/tar', ['-xpf', stageTar, '-C', extractRoot])
    rmSync(stageTar, { force: true })
    const innerApp = join(extractRoot, basename(appPath))
    if (!existsSync(innerApp)) {
      console.error(`[sign-app] payload 里没有 ${basename(appPath)}（打包契约变化？），拒绝处理（#132）`)
      process.exit(1)
    }
    signAppLayers(innerApp)
    ensureUsageDescriptions(innerApp)
    execFileSync('codesign', [...outerSignArgs, innerApp], { stdio: 'inherit' })
    assertMacosAttribution(innerApp, bundleId)
    const packedTar = join(work, 'repacked.tar')
    // tar 结构与 hutch 打包一致：条目以「<name>.app/」为根，无 ./ 前缀；解压端只认 zstd 流，压缩级别无关。
    // 不带 xattr/PAX 扩展：zig 解包器不认 PAX 扩展头，会把每条记录物化成 ._AppleDouble 文件，
    // 破坏已签 bundle 的 seal（实测 #132）。COPYFILE_DISABLE 双保险。
    execFileSync('/usr/bin/tar', ['--no-xattrs', '-cf', packedTar, '-C', extractRoot, basename(appPath)], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    execFileSync(zstd, ['-q', '-f', packedTar, '-o', join(work, payloadName)])
    try {
      renameSync(join(work, payloadName), payloadPath)
    } catch {
      copyFileSync(join(work, payloadName), payloadPath)
    }
    console.log(`[sign-app] payload 已重打（新 ${statSync(payloadPath).size} 字节）：首启解压即已签名树（#132）`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
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

// #143：hutch 生成的 Info.plist 只有 6 个基础键，没有任何 NS*UsageDescription。macOS 的麦克风授权
// 会先看 usage description 再弹窗，缺了就直接拒——tccd 日志原文：`Refusing authorization request for
// service kTCCServiceMicrophone and subject Sub:{com.hyperion.dsh-desktop-bun}… without
// NSMicrophoneUsageDescription key`。屏幕录制不走这个键（没有对应 usage description，系统提示是
// 固定的），所以这里只补麦克风。
//
// 必须在签之前写入：Info.plist 是签名的一部分，先签后改会破 seal（#143 另一处根因同形）。
// 首启解压用的是 payload 里那棵树，所以内层也要补（见 signInsideBootstrapPayload）。
const usageDescriptions = {
  NSMicrophoneUsageDescription: '用于语音输入：把你说的话转成会话里的文字。',
}

function ensureUsageDescriptions(appPath) {
  const plist = join(appPath, 'Contents', 'Info.plist')
  for (const [key, value] of Object.entries(usageDescriptions)) {
    const got = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' })
    if (got.status === 0 && (got.stdout ?? '').trim() !== '') continue
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist], { stdio: 'inherit' })
    console.log(`[sign-app] Info.plist 补上 ${key}`)
  }
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

console.log(`[sign-app] ad-hoc 重签（MacOS 执行体 → Frameworks → payload 内层完整树 → 外层）：${target}`)
// P10：带上旧壳同款 entitlements（CEF/V8 初始化需要 JIT 豁免，缺了会 Fatal OOM）——挂外层主执行文件。
const entitlements = join(projectRoot, 'resources', 'entitlements.plist')
const outerSignArgs = ['--force', '--sign', '-']
if (existsSync(entitlements)) outerSignArgs.push('--entitlements', entitlements)
const bundleId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(target, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
// #143：默认 ad-hoc 签名的 designated requirement 是 **cdhash**，重签或换个构建就变；而 macOS 把
// 「已授权」记成 (bundle id, service, csreq)，csreq 里钉的就是授权那一刻的 cdhash。于是重签之后
// requirement 匹配不上——屏幕录制开关亮着也照样反复弹窗（tccd 日志原文：Failed to match existing
// code requirement for subject com.hyperion.dsh-desktop-bun and service kTCCServiceScreenCapture）。
// 换成 identifier 锚定后，同一 bundle id 的任何构建都满足要求（实测：换掉源码重签仍校验通过）。
const designatedRequirement = `=designated => identifier "${bundleId}"`
outerSignArgs.push('-r', designatedRequirement)
// 层①②：MacOS 执行体认领 bundle id + Frameworks。对 bootstrap 自身与 payload 解出的完整树复用（#132）。
function signAppLayers(appPath) {
  // ① Contents/MacOS 下的每个 Mach-O 自己认领 bundle id（#115 实机：真正的 JS 主进程是 bun，
  // 构建期签名 Identifier=bun，归属永远失败；--identifier 是 Electron helper 同款约定）。
  // 每个文件原样保留既有 entitlements（bun 比仓库 plist 多 disable-executable-page-protection）。
  const macosDir = join(appPath, 'Contents', 'MacOS')
  if (existsSync(macosDir)) {
    for (const entry of readdirSync(macosDir)) {
      const full = join(macosDir, entry)
      if (!statSync(full).isFile()) continue
      const preserved = preservedEntitlements(full)
      const args = ['--force', '--sign', '-', '--identifier', bundleId, '-r', designatedRequirement]
      if (preserved !== null) args.push('--entitlements', preserved)
      execFileSync('codesign', [...args, full], { stdio: 'inherit' })
    }
  }
  // ② 嵌套 bundle / framework / dylib。
  const frameworksDir = join(appPath, 'Contents', 'Frameworks')
  if (existsSync(frameworksDir)) {
    for (const entry of readdirSync(frameworksDir)) {
      if (!entry.endsWith('.framework') && !entry.endsWith('.app') && !entry.endsWith('.dylib')) continue
      execFileSync('codesign', ['--force', '--sign', '-', join(frameworksDir, entry)], { stdio: 'inherit' })
    }
  }
}

// ②⑤ payload 在外层签名【前】处理：payload 是外层 seal 覆盖的资源，改完必须重签外层（#132）。
ensureUsageDescriptions(target)
signAppLayers(target)
signInsideBootstrapPayload(target, bundleId)
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
// 同样的断言跑在构建树上：首启覆盖的源头就是这棵树没被签对（#132）。
assertMacosAttribution(target, bundleId)

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

/** hdiutil create 在 runner 上偶发 Resource busy；重试三次，别把可恢复的构建抖动当签名失败。 */
function createDmgWithRetry(args) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      execFileSync('hdiutil', args, { stdio: 'inherit' })
      return
    } catch (error) {
      if (attempt === 3) throw error
      console.warn(`[sign-app] hdiutil create 第 ${attempt} 次失败，30s 后重试…`)
      rmSync(args[args.length - 1], { force: true })
      execFileSync('sleep', ['30'])
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
  createDmgWithRetry(['create', '-volname', volumeName, '-srcfolder', root, '-ov', '-format', 'UDZO', '-fs', 'HFS+', outDmg])
  try {
    execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, outDmg], { stdio: 'inherit' })
    try {
      assertMacosAttribution(join(mountPoint, appName), bundleId)
      console.log(`[sign-app] DMG 复核通过（签名合法 + 归属认领）：${appName}`)
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
