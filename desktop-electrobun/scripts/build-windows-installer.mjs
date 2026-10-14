#!/usr/bin/env bun
/**
 * Windows 安装程序打包（A2/A4）：把 `hutch electrobun build` 的 Windows 产物装进 NSIS。
 *
 * 为什么要有这一步：Electrobun 的 Windows 产物是「构建目录 + payload 归档（*.tar.zst）」，
 * 没有可直接双击的安装器；旧壳（Tauri）给的是 -setup.exe。这里用 NSIS 补上等价物：
 *   · 可直接执行的 setup.exe（A2）
 *   · 安装程序与应用图标（win.icon 同源 resources/app-icon.ico，A2）
 *   · 目录选择页（InstallDir + InstallDirRegKey，A4 可选安装目录）
 *   · 每用户安装（RequestExecutionLevel user，不需要管理员）+ 开始菜单快捷方式 + 卸载器
 *
 * 用法（Windows CI 或本机）：
 *   bun run scripts/build-windows-installer.mjs            # 自动找 build/stable-windows-x64
 *   makensis 必须在 PATH（GitHub windows-latest 镜像自带 NSIS；缺了先 choco install nsis）
 *
 * 退出码：0 = 安装器已生成；1 = 找不到产物 / makensis 失败。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { execSync, spawnSync } from 'node:child_process'

const projectRoot = resolve(import.meta.dir, '..')
const buildRoot = join(projectRoot, 'build')

/** 找 Windows 构建目录：Electrobun 在 Windows 上的目录名不带 'windows' 字样（CI 实测），
 * 所以不按名字猜——挨个看哪份里能找到 launcher.exe，优先 stable-* 与最新名。 */
function pickBuildDir() {
  if (!existsSync(buildRoot)) return null
  const entries = readdirSync(buildRoot).filter((name) => !name.startsWith('.'))
  const stable = entries.filter((name) => name.startsWith('stable-'))
  const ordered = (stable.length > 0 ? stable : entries).sort().reverse()
  for (const name of ordered) {
    const dir = join(buildRoot, name)
    if (findLauncher(dir) !== null) return dir
  }
  return null
}

/** 找 launcher.exe 的完整路径（depth ≤ 4）：Windows 的应用根下是 bin/launcher.exe。 */
function findLauncher(root, depth = 0) {
  if (depth > 4 || !existsSync(root)) return null
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isFile() && entry === 'launcher.exe') return full
    if (!info.isDirectory()) continue
    const hit = findLauncher(full, depth + 1)
    if (hit !== null) return hit
  }
  return null
}

function listFilesRecursive(root, base = root, out = []) {
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) listFilesRecursive(full, base, out)
    else out.push(full)
  }
  return out
}

/** NSIS 字符串转义：双引号与 $ 需要转（$ 在 NSIS 里有变量语义）。 */
function nsiEscape(text) {
  return text.replaceAll('$', '$$').replaceAll('"', '$\\"')
}

const buildDir = pickBuildDir()
if (buildDir === null) {
  console.error(`[installer] build/ 下没有 Windows 构建目录：${buildRoot}`)
  process.exit(1)
}
// 应用根 = 构建目录下唯一的顶层目录（mac 是 .app，Windows 是 DeepSeekHarnessDesktopBUN/）。
// 打包整棵树：launcher + Resources/payload 归档都要装下去，首启自解压才有的解。
const launcher = findLauncher(buildDir)
if (launcher === null) {
  console.error(`[installer] ${buildDir} 里找不到 launcher.exe`)
  process.exit(1)
}
const topLevel = readdirSync(buildDir).filter((name) => {
  try {
    return statSync(join(buildDir, name)).isDirectory()
  } catch {
    return false
  }
})
if (topLevel.length !== 1) {
  console.error(`[installer] 构建目录顶层应有且只有一个应用目录，实际：${topLevel.join(', ')}`)
  process.exit(1)
}
const appDir = join(buildDir, topLevel[0] ?? '')
const appDirName = topLevel[0] ?? ''
const iconPath = join(projectRoot, 'resources', 'app-icon.ico')
if (!existsSync(iconPath)) {
  console.error('[installer] 缺 resources/app-icon.ico（先跑 prepare:bundle 或提交仓内源）')
  process.exit(1)
}

// OutFile 固定落 artifacts/（与 mac dmg 同一个交付目录）。
const outFile = join(projectRoot, 'artifacts', 'windows-x64-DeepSeekHarnessDesktopBUN-setup.exe')
// NSIS 的 File /r 在 Windows 上打不开超过 MAX_PATH（260）的源文件——CI 的构建根
// （D:\a\...\build\stable-win-x64\...）叠上 dsh 依赖树里的长文件名就会爆。
// 解法：打包前把整棵应用树 robocopy 到超短路径（C:\dsh-pkg\App），NSI 从那里打包。

// ── 打包期载荷解压：setup 装完即可直接用，双击 launcher 不再二次解压 ──
// 用户实机反馈（m23622）：NSIS 只装「launcher + payload 归档」，首跑 launcher 还要自解压一遍
// （等于装两次）。所以在打包时就把 Resources/<hash>.tar.zst 解开并并回应用树，随后从安装树里
// 删掉归档；.installer 改名行也随之不需要（extractFromSelf 找不到相邻归档 → 直接正常启动）。
const payloadResDir = join(appDir, 'Resources')
const payloadArchiveName = existsSync(payloadResDir)
  ? readdirSync(payloadResDir).find((name) => name.endsWith('.tar.zst'))
  : undefined
let payloadPreExtracted = false
if (payloadArchiveName !== undefined) {
  const toolsDir = join(projectRoot, 'build', 'installer-tools')
  mkdirSync(toolsDir, { recursive: true })
  const zstdZip = join(toolsDir, 'zstd.zip')
  const zstdExePath = join(toolsDir, 'zstd.exe')
  if (!existsSync(zstdExePath)) {
    execSync(
      `curl -fsSL -o ${JSON.stringify(zstdZip)} https://github.com/facebook/zstd/releases/download/v1.5.6/zstd-v1.5.6-win64.zip`,
      { stdio: 'inherit' },
    )
    execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zstdZip}' -DestinationPath '${toolsDir}' -Force"`, { stdio: 'inherit' })
  }
  let resolvedZstd = zstdExePath
  if (!existsSync(resolvedZstd)) {
    // Expand-Archive 会保留 zip 内层目录（zstd-v1.5.6-win64/zstd.exe），递归找
    const found = readdirSync(toolsDir, { recursive: true }).find((name) => name === 'zstd.exe' || name.endsWith('\\zstd.exe'))
    if (found === undefined) {
      console.error('[installer] zstd.exe 下载/展开失败，无法在打包期解载荷')
      process.exit(1)
    }
    resolvedZstd = join(toolsDir, found)
  }
  const stageTar = join(toolsDir, 'payload.tar')
  execSync(`${JSON.stringify(resolvedZstd)} -d -f ${JSON.stringify(join(payloadResDir, payloadArchiveName))} -o ${JSON.stringify(stageTar)}`, { stdio: 'inherit' })
  const stageDir = join(toolsDir, 'payload')
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  execSync(`tar -xf ${JSON.stringify(stageTar)} -C ${JSON.stringify(stageDir)}`, { stdio: 'inherit' })
  // 归档根目录 = 应用目录名；把它的内容并回 appDir（覆盖式）
  const extractedRoot = join(stageDir, appDirName)
  const mergeFrom = existsSync(extractedRoot) ? extractedRoot : stageDir
  cpSync(mergeFrom, appDir, { recursive: true, force: true })
  rmSync(join(payloadResDir, payloadArchiveName), { force: true })
  payloadPreExtracted = true
  // 诊断：bin/ 里必须落着 bun.exe（冒烟与首启都靠它）；不在就打印两边目录找差异
  const mergedBin = join(appDir, 'bin')
  const binEntries = existsSync(mergedBin) ? readdirSync(mergedBin) : []
  console.log(`[installer] 合并后 bin/：${binEntries.join(', ') || '(空)'}`)
  const stageBin = join(stageDir, appDirName, 'bin')
  if (!binEntries.includes('bun.exe')) {
    const stageBinEntries = existsSync(stageBin) ? readdirSync(stageBin) : []
    console.log(`[installer] 解包暂存 bin/：${stageBinEntries.join(', ') || '(空)'}`)
    const payloadBin = join(stageDir, appDirName, 'Resources', 'app', 'bun')
    if (existsSync(payloadBin)) {
      console.log(`[installer] Resources/app/bun/：${readdirSync(payloadBin).slice(0, 10).join(', ')}`)
    }
  }
  console.log('[installer] 载荷已在打包期解并（setup 装完即用，首启不再自解压）')
}

let packDir = appDir
if (process.platform === 'win32' && appDir.length > 80) {
  const shortRoot = 'C:\\dsh-pkg'
  const shortDir = join(shortRoot, 'App')
  rmSync(shortRoot, { recursive: true, force: true })
  mkdirSync(shortRoot, { recursive: true })
  const copied = spawnSync('robocopy', [appDir, shortDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' })
  // robocopy 的退出码 0-7 都是成功（1=有文件复制）；≥8 才是失败
  if ((copied.status ?? 8) > 7) {
    console.error(`[installer] robocopy 到短路径失败：status = ${copied.status}`)
    process.exit(1)
  }
  packDir = shortDir
  console.log(`[installer] 应用树已复制到短路径（源路径 ${appDir.length} 字符）：${shortDir}`)
}
const nsiTemplate = `
; Unicode true：快捷方式名里的中文（卸载）必须走 Unicode 安装器，否则开始菜单乱码
Unicode true
!define APP_NAME "DeepSeek Harness Desktop BUN"
!define APP_ID "DeepSeekHarnessDesktopBUN"
!define APP_DIR_NAME "${nsiEscape(appDirName)}"
!define INSTALL_ROOT "DSHDesktopBun"  ; 安装根目录名（比 APP_ID 短，给深层 node_modules 留 MAX_PATH 余量）

Name "@@APP_NAME@@"
OutFile "${nsiEscape(outFile)}"
InstallDir "$LOCALAPPDATA\\@@INSTALL_ROOT@@"
InstallDirRegKey HKCU "Software\\@@APP_ID@@" "InstallDir"
RequestExecutionLevel user
ShowInstDetails show
ShowUnInstDetails show
Icon "${nsiEscape(iconPath)}"
UninstallIcon "${nsiEscape(iconPath)}"
Caption "@@APP_NAME@@ 安装程序"
SpaceTexts none

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles


Function .onInit
  ; 旧版双层布局（<APP_ID>\\<APP_ID>\\）会把 node_modules 深处的文件顶过 MAX_PATH(260)，
  ; 安装器写不进去（Can't write）。检测到旧安装先清场：目录尽力删（个别超长文件删不动就残留，
  ; 不阻塞新装），注册表 InstallDir 一并抹掉——否则 InstallDirRegKey 会把 $INSTDIR 拉回旧长路径。
  ReadRegStr $R0 HKCU "Software\\@@APP_ID@@" "InstallDir"
  IfErrors legacy_done
  IfFileExists "$R0\\@@APP_ID@@\\bin\\launcher.exe" 0 legacy_done
    IfSilent legacy_remove
    MessageBox MB_OKCANCEL "@@APP_NAME@@$\\n检测到旧版安装（$R0）。$\\n将迁移到更短的安装目录（Windows 路径长度限制）并删除旧目录，继续？" IDOK legacy_remove IDCANCEL legacy_done
  legacy_remove:
  RMDir /r "$R0"
  DeleteRegValue HKCU "Software\\@@APP_ID@@" "InstallDir"
  legacy_done:
FunctionEnd
Section "install"
  SetOutPath "$INSTDIR\\App"
  File /r "${nsiEscape(packDir)}\\*.*"
  @@PAYLOAD_RENAME@@  ; Windows 自解压约定：<launcher 同目录>/.installer/<stem>.tar.zst + <stem>.metadata.json
  WriteUninstaller "$INSTDIR\\App\\uninstall.exe"
  WriteRegStr HKCU "Software\\@@APP_ID@@" "InstallDir" $INSTDIR
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\@@APP_ID@@" "DisplayName" "@@APP_NAME@@"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\@@APP_ID@@" "DisplayIcon" "$INSTDIR\\App\\launcher.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\@@APP_ID@@" "UninstallString" "$INSTDIR\\App\\uninstall.exe"
  CreateDirectory "$SMPROGRAMS\\@@APP_NAME@@"
  CreateShortCut "$SMPROGRAMS\\@@APP_NAME@@\\@@APP_NAME@@.lnk" "$INSTDIR\\App\\bin\\launcher.exe"
  CreateShortCut "$SMPROGRAMS\\@@APP_NAME@@\\卸载.lnk" "$INSTDIR\\App\\uninstall.exe"
SectionEnd

Section "un.install"
  ; 卸载器的 $INSTDIR 从安装时写的注册表恢复（用户自定义目录也要卸干净）
  ReadRegStr $INSTDIR HKCU "Software\\@@APP_ID@@" "InstallDir"
  Delete "$SMPROGRAMS\\@@APP_NAME@@\\@@APP_NAME@@.lnk"
  Delete "$SMPROGRAMS\\@@APP_NAME@@\\卸载.lnk"
  RMDir "$SMPROGRAMS\\@@APP_NAME@@"
  RMDir /r "$INSTDIR\\App"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\@@APP_ID@@"
  DeleteRegKey HKCU "Software\\@@APP_ID@@"
SectionEnd`
  // Windows 自解压约定（extractor/main.zig extractFromSelf）：exe 同目录的 .installer/<stem>.tar.zst + <stem>.metadata.json，
  // 退回同目录裸 <stem>.tar.zst/<stem>.metadata.json。hutch 产出的 payload 在 Resources/<hash>.tar.zst，装完就地改名挪过去。
  const payloadDir = join(appDir, 'Resources')
  const payloadListing = payloadPreExtracted ? [] : (existsSync(payloadDir) ? readdirSync(payloadDir) : [])
  const payloadArchive = payloadListing.find((name) => name.endsWith('.tar.zst'))
  const payloadMetadata = payloadListing.find((name) => name === 'metadata.json')
  let payloadRename = '; 未找到 Resources/<hash>.tar.zst，跳过自解压重命名（无法首启自装）'
  if (payloadPreExtracted) {
    payloadRename = '; 载荷已在打包期解并进应用树，安装期无需 .installer 改名'
  } else if (payloadArchive !== undefined && payloadMetadata !== undefined) {
    const escapedPayload = nsiEscape(payloadArchive)
    payloadRename = [
      `  CreateDirectory "$INSTDIR\\App\\bin\\.installer"`,
      `  Rename "$INSTDIR\\App\\Resources\\${escapedPayload}" "$INSTDIR\\App\\bin\\.installer\\launcher.tar.zst"`,
      `  Rename "$INSTDIR\\App\\Resources\\metadata.json" "$INSTDIR\\App\\bin\\.installer\\launcher.metadata.json"`,
    ].join('\n')
  }
const nsi = nsiTemplate.replaceAll('@@PAYLOAD_RENAME@@', payloadRename).replaceAll('@@APP_NAME@@', 'DeepSeek Harness Desktop BUN').replaceAll('@@APP_ID@@', 'DeepSeekHarnessDesktopBUN').replaceAll('@@APP_DIR_NAME@@', appDirName).replaceAll('@@INSTALL_ROOT@@', 'DSHDesktopBun')

const nsiPath = join(projectRoot, 'build', 'installer-windows.nsi')
// BOM 让 makensis 按 UTF-8 读脚本（中文快捷方式名不乱码）
await Bun.write(nsiPath, '\uFEFF' + nsi)
const sourceCount = listFilesRecursive(appDir).length
console.log(`[installer] 应用目录：${appDir}（${String(sourceCount)} 个文件）`)
console.log(`[installer] NSIS 脚本：${nsiPath}`)
/** 定位 makensis：PATH 上先找，找不到再探 choco/NSIS 的固定安装位置（CI 刚装完时 PATH 可能还没刷新）。 */
function resolveMakensis() {
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['makensis'], { encoding: 'utf8' })
  const fromPath = typeof probe.stdout === 'string' ? probe.stdout.split(/\r?\n/)[0]?.trim() ?? '' : ''
  if (probe.status === 0 && fromPath !== '') return fromPath
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files (x86)\\NSIS\\makensis.exe',
        'C:\\ProgramData\\chocolatey\\lib\\nsis\\tools\\nsis\\Bin\\makensis.exe',
        'C:\\ProgramData\\chocolatey\\bin\\makensis.exe',
      ]
    : ['/usr/local/bin/makensis', '/opt/homebrew/bin/makensis']
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const makensisPath = resolveMakensis()
if (makensisPath === null) {
  console.error('[installer] 找不到 makensis（GitHub 镜像自带；本地 choco install nsis）')
  process.exit(1)
}
console.log(`[installer] makensis：${makensisPath}`)
const makensis = spawnSync(makensisPath, [nsiPath], { stdio: 'inherit' })
if (makensis.status !== 0 || makensis.error !== undefined) {
  console.error('[installer] makensis 编译失败（看上方 NSIS 输出定位 .nsi 行号）')
  process.exit(1)
}
const info = statSync(outFile)
if (info.size < 1_000_000) {
  console.error(`[installer] 产物异常地小：${outFile}（${String(info.size)} B）`)
  process.exit(1)
}
console.log(`[installer] 完成：${outFile}（${String(info.size)} B）`)
