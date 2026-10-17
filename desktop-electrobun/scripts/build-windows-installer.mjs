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

// #91：自定义 UI 依赖两张品牌图（#92 生成、不入库）与 installer/ui.nsh。缺了就在构建前拦下来，
// 免得 makensis 里报一句难懂的 "invalid file"。
const installerAssetsDir = join(projectRoot, 'installer', 'assets')
// #103：自绘 UI 的资产清单（同一个生成器产），守卫必须与 installer/ui.nsh 里的 File 一致：
// 品牌图 ×4（MUI 侧边栏/图标用）+ 鲸鱼瓦片 ×4（标题栏）+ 卡片 ×4（安装位置面板）+ 大勾 ×4（完成页）
const brandAssets = [
  'brand.bmp',
  'brand-2x.bmp',
  'brand-dark.bmp',
  'brand-dark-2x.bmp',
  'whale.bmp',
  'whale-2x.bmp',
  'whale-dark.bmp',
  'whale-dark-2x.bmp',
  'card.bmp',
  'card-2x.bmp',
  'card-dark.bmp',
  'card-dark-2x.bmp',
  'check-circle.bmp',
  'check-circle-2x.bmp',
  'check-circle-dark.bmp',
  'check-circle-dark-2x.bmp',
]
const missingAssets = brandAssets.filter((name) => !existsSync(join(installerAssetsDir, name)))
if (missingAssets.length > 0) {
  console.error(`[installer] 缺品牌图：${missingAssets.join(', ')}（应位于 ${installerAssetsDir}）`)
  console.error('[installer] 先在 desktop-electrobun 下跑：bun run prepare:installer-assets')
  process.exit(1)
}

const windowFrameDllPath = join(projectRoot, 'installer', 'window-frame.dll')
const hasWindowFrame = existsSync(windowFrameDllPath)
if (!hasWindowFrame) {
  console.warn('[installer] 未找到 installer/window-frame.dll —— 进度页回退纯 NSIS 样式（CI 用 scripts/build-window-frame.ps1 编译）')
}
const uiNshPath = join(projectRoot, 'installer', 'ui.nsh')
if (!existsSync(uiNshPath)) {
  console.error(`[installer] 缺自定义 UI 脚本：${uiNshPath}`)
  process.exit(1)
}

const stringsNshPath = join(projectRoot, 'installer', 'strings.nsh')
if (!existsSync(stringsNshPath)) {
  console.error(`[installer] 缺多语言文案表：${stringsNshPath}`)
  process.exit(1)
}

// #103：安装界面脚本（官方骨架：主题 → 绘制原语 → 页面/交互），缺任何一个都先拦下来
const installerScripts = ['theme.nsh', 'drawing.nsh']
const missingScripts = installerScripts.filter((name) => !existsSync(join(projectRoot, 'installer', name)))
if (missingScripts.length > 0) {
  console.error(`[installer] 缺安装界面脚本：${missingScripts.join(', ')}（应位于 ${join(projectRoot, 'installer')}）`)
  process.exit(1)
}
const themeNshPath = join(projectRoot, 'installer', 'theme.nsh')
const drawingNshPath = join(projectRoot, 'installer', 'drawing.nsh')

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

// Windows 长路径前缀：应用树里 node_modules 很深，删暂存/备份目录必须绕过 MAX_PATH 规范化。
// UNC 路径（\\server\share）不能带这个前缀——.nsi 里按 $INSTDIR 前两个字符判断，UNC 时留空退回普通路径。
const longPrefix = '\\\\?\\'
// 进程名：安装/卸载前要问 launcher 在不在跑（findLauncher 认定的名字）
const launcherExe = launcher.split(sep).pop() ?? 'launcher.exe'
// 构建身份：git 短 sha + 时间戳。写进 exe 属性（ProductVersion）与 trace 文件名，
// 让每一个包自报身份——多轮验证循环里再也不可能拿错新旧包。
const buildId = (() => {
  try { return `${execSync('git rev-parse --short HEAD').toString().trim()}-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')}` }
  catch { return `dev-${Date.now()}` }
})()
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
; XPStyle on：comctl v6 清单 —— 没有 v6，BUTTON/Edit 跑在 v5 classic（Win95 方形灰钮），
; 而 classic BUTTON 根本不发 NM_CUSTOMDRAW，自绘 painter 永远不会被调用（真机实锤）。官方 MUI2 同款机制。
XPStyle on
; dpiAware：没有它，高 DPI 屏上窗口被 DWM 位图拉伸 → 全局发虚模糊（真机 300% 缩放实锤）；
; 开启后 LOGPIXELSY 返回真实 DPI，DshUiInit/DshPlace/DshPixelFont 的 MulDiv 全部按真实像素走
ManifestDPIAware true

  ; 压缩回退 NSIS 默认 zlib（用户真机拍板：解压速度优先，lzma 固体曾拖慢解压数分钟；
  ; 体积代价约 +40%，后续如需再议——原 #88 的 lzma 实测数据留在 issue #88）
ShowInstDetails nevershow       ; #91：自定义 UI 页不要 stock 详情列表（进度条与状态行保留）
ShowUnInstDetails nevershow
Icon "${nsiEscape(iconPath)}"
UninstallIcon "${nsiEscape(iconPath)}"
Caption "@@APP_NAME@@ 安装程序"
SpaceTexts none

; ── #91 自定义 UI：品牌图 + nsDialogs 三页（welcome / instfiles / finish）──
; 布局与交互对照官方 apps/desktop/installer/pages.nsh；实现见 installer/ui.nsh（纯 NSIS，无 C++ DLL）。
!define DSH_INSTALLER_ASSETS "${nsiEscape(installerAssetsDir)}"
!define DSH_APP_NAME "@@APP_NAME@@"
!define DSH_APP_EXE "$INSTDIR\\App\\bin\\${launcherExe}"
!define DSH_BUILD_ID "@@BUILD_ID@@"              ; 构建身份：trace 文件名用它区分新旧包
${hasWindowFrame ? '!define DSH_WINDOW_FRAME_DLL "$PLUGINSDIR\\window-frame.dll"   ; 官方同款进度覆盖层/窗体（#103b）\n' : ''}
!include "nsDialogs.nsh"                    ; 自绘页面与控件都走 nsDialogs::Create
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "${nsiEscape(stringsNshPath)}"     ; 多语言文案表（#88）：其余脚本都要用 $(DSH_TEXT_*)
!include "${nsiEscape(themeNshPath)}"       ; 主题与调色板（#103）：颜色变量必须在 drawing.nsh 之前
!include "${nsiEscape(drawingNshPath)}"     ; GDI+ 绘制原语 + NM_CUSTOMDRAW painter（#103）
!include "${nsiEscape(uiNshPath)}"          ; 页面与交互（#103）

; ── #93 事务性安装状态：暂存 → 原子替换 → 回滚 ──
Var DshFinalDir     ; 正式目录 $INSTDIR\\App（注册表/快捷方式都指向它）
Var DshNewDir       ; 本次暂存 $INSTDIR\\App.new-<token>（与目标同卷，Rename 才原子）
Var DshOldDir       ; 旧版本备份 $INSTDIR\\App.old-<token>
Var DshOldMoved     ; 1 = 旧目录已改名成备份
Var DshNewMoved     ; 1 = 暂存已改名成正式目录（未提交前回滚要删它）
Var DshPrefix       ; 长路径前缀（本地盘 ${longPrefix}，UNC 留空）
Var DshRunning      ; 1 = 检测到 launcher 在跑
Var DshFailReason   ; 失败原因，进统一失败出口
Var DshToken        ; 本次事务短 token

Page custom DshWelcomeCreate DshWelcomeLeave
Page instfiles "" DshProgressShow
Page custom DshFinishCreate DshFinishLeave
UninstPage uninstConfirm
UninstPage instfiles


Function .onInit
  Call DshResolveLanguage   ; #88：语言表初始化前定好语言（中文系统 → 简中，其余 → 英文）
  ; /LANG=zh|en：显式指定语言（检测=系统 UI 语言→用户区域，两者都不是中文才走英文；
  ; 真机 en-US 环境实测会走英文——想看中文就 /LANG=zh）
  \${GetOptions} $CMDLINE "/LANG=" $DshError
  \${If} $DshError == "zh"
    StrCpy $LANGUAGE 2052
  \${ElseIf} $DshError == "en"
    StrCpy $LANGUAGE 1033
  \${EndIf}
  StrCpy $DshError ""
  ; （/PREVIEW 模式已随 preview.nsh 退役：--shot 抓的就是显示路径本身）
  ; 旧版双层布局（<APP_ID>\\<APP_ID>\\）会把 node_modules 深处的文件顶过 MAX_PATH(260)，
  ; 安装器写不进去（Can't write）。检测到旧安装先清场：目录尽力删（个别超长文件删不动就残留，
  ; 不阻塞新装），注册表 InstallDir 一并抹掉——否则 InstallDirRegKey 会把 $INSTDIR 拉回旧长路径。
  ReadRegStr $R0 HKCU "Software\\@@APP_ID@@" "InstallDir"
  IfErrors legacy_done
  IfFileExists "$R0\\@@APP_ID@@\\bin\\launcher.exe" 0 legacy_done
    IfSilent legacy_remove
    MessageBox MB_OKCANCEL "$(DSH_TEXT_LEGACY_TITLE)$\\n$R0$\\n$\\n$(DSH_TEXT_LEGACY_BODY)" IDOK legacy_remove IDCANCEL legacy_done
  legacy_remove:
  RMDir /r "$R0"
  DeleteRegValue HKCU "Software\\@@APP_ID@@" "InstallDir"
  legacy_done:
  ; #93：上次安装中断会留下 App.new-*（未完成暂存，必删）与 App.old-*（旧版本备份）。
  ; 备份只在当前版本在位时删——否则它可能是用户仅存的可用副本，留着能手工恢复。
  InitPluginsDir
${hasWindowFrame ? '  File "/oname=$PLUGINSDIR\\window-frame.dll" "' + nsiEscape(windowFrameDllPath) + '"\n' : ''}
  Call DshResolveLongPrefix
  FindFirst $R3 $R4 "$INSTDIR\\App.new-*"
  dsh_init_new_loop:
    StrCmp $R4 "" dsh_init_new_done
    ClearErrors
    RMDir /r "$DshPrefix$INSTDIR\\$R4"
    DetailPrint "清理未完成的暂存目录：$INSTDIR\\$R4"
    FindNext $R3 $R4
    Goto dsh_init_new_loop
  dsh_init_new_done:
  FindClose $R3
  IfFileExists "$INSTDIR\\App\\bin\\launcher.exe" 0 dsh_init_stale_done
  FindFirst $R3 $R4 "$INSTDIR\\App.old-*"
  dsh_init_old_loop:
    StrCmp $R4 "" dsh_init_old_done
    ClearErrors
    RMDir /r "$DshPrefix$INSTDIR\\$R4"
    DetailPrint "清理旧版本备份目录：$INSTDIR\\$R4"
    FindNext $R3 $R4
    Goto dsh_init_old_loop
  dsh_init_old_done:
  FindClose $R3
  dsh_init_stale_done:
FunctionEnd

; ── #93 事务性安装：对照官方 scripts/installer-directories.nsh ──
; 新版先完整写进同卷兄弟目录 App.new-<token>，再用两次 Rename 完成替换；注册表与快捷方式
; 写在 promote 成功之后，所以回滚只需撤目录，不必撤销注册表（官方同款取舍）。

; 长路径前缀：删 App.old-*（整棵含深层 node_modules 的树）必须绕过 MAX_PATH 规范化；
; UNC 路径不能用 ${longPrefix}，留空退回普通路径。
Function DshResolveLongPrefix
  StrCpy $DshPrefix "${longPrefix}"
  StrCpy $R0 $INSTDIR 2
  StrCmp $R0 "\\" 0 dsh_prefix_done
    StrCpy $DshPrefix ""
  dsh_prefix_done:
FunctionEnd

; launcher 在跑就不动目录：被占用的文件顶着，Rename 必失败，宁可不开始。
; find 的退出码 0 = 命中；nsExec 不弹控制台，silent 安装同样适用。
Function DshDetectRunning
  StrCpy $DshRunning 0
!ifdef DSH_WINDOW_FRAME_DLL
  ; 首选：按安装目录路径枚举进程（launcher.exe 只是壳父进程，bun.exe/WebView2 同样占文件，按名杀不全）
  System::Call '\${DSH_WINDOW_FRAME_DLL}::InstallerFindUnderPath(w "$INSTDIR") i .r0'
  IntCmp $0 0 dsh_running_fallback
    StrCpy $DshRunning 1
    Return
  dsh_running_fallback:
!endif
  nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq @@LAUNCHER_EXE@@" /NH | find /I "@@LAUNCHER_EXE@@"'
  Pop $0
  Pop $1
  StrCmp $0 "0" 0 dsh_running_done
    StrCpy $DshRunning 1
  dsh_running_done:
FunctionEnd

; 只撤本次安装自己建/改名的目录；备份恢复不了就完整保留，绝不删掉用户仅存的副本。

; 扫掉历史残留的 .new-* / .old-* 目录（本次备份之外的老遗留；被占用的删不掉就留给下次启动）
Function DshSweepLeftovers
  FindFirst $R3 $R4 "$DshPrefix$INSTDIR\\App.old-*"
  dsh_sweep_old_loop:
    StrCmp $R4 "" dsh_sweep_old_done
    RMDir /r "$DshPrefix$INSTDIR\\$R4"
    FindNext $R3 $R4
    Goto dsh_sweep_old_loop
  dsh_sweep_old_done:
  FindClose $R3
  FindFirst $R3 $R4 "$DshPrefix$INSTDIR\\App.new-*"
  dsh_sweep_new_loop:
    StrCmp $R4 "" dsh_sweep_new_done
    RMDir /r "$DshPrefix$INSTDIR\\$R4"
    FindNext $R3 $R4
    Goto dsh_sweep_new_loop
  dsh_sweep_new_done:
  FindClose $R3
FunctionEnd
Function DshRollbackDirectories
  SetOutPath $PLUGINSDIR
  StrCmp $DshNewMoved "1" 0 dsh_rb_old
    DetailPrint "回滚：删除未完成的正式目录 $DshFinalDir"
    RMDir /r "$DshPrefix$DshFinalDir"
    StrCpy $DshNewMoved ""
  dsh_rb_old:
  StrCmp $DshOldMoved "1" 0 dsh_rb_stage
    ClearErrors
    Rename $DshOldDir $DshFinalDir
    IfErrors 0 dsh_rb_restored
      DetailPrint "回滚未完成：旧版本完整保留在 $DshOldDir（可手工改名恢复）"
      Goto dsh_rb_done
    dsh_rb_restored:
    StrCpy $DshOldMoved ""
  dsh_rb_stage:
  StrCmp $DshNewDir "" dsh_rb_done
    ClearErrors
    RMDir /r "$DshPrefix$DshNewDir"
  dsh_rb_done:
FunctionEnd

; 所有退出路径（.onGUIEnd / .onInstFailed / 显式 Quit）都从这里走
Function DshCleanupDirectories
  StrCmp $DshFinalDir "" dsh_cleanup_done
    Call DshRollbackDirectories
  dsh_cleanup_done:
FunctionEnd

Function .onGUIEnd
  Call DshCleanupDirectories
  \${If} $DshTraceFile != ""
    FileClose $DshTraceFile
    StrCpy $DshTraceFile ""
  \${EndIf}
FunctionEnd

Function .onInstFailed
  Call DshCleanupDirectories
FunctionEnd

; 两次 Rename 完成替换；任何一步失败都回滚并置错误标志
Function DshPromoteDirectories
  ; SetOutPath 会持有当前输出目录的句柄，改名之前必须释放（官方 :99 同因）
  SetOutPath $PLUGINSDIR
  ClearErrors
  IfFileExists "$DshFinalDir\\*.*" 0 dsh_promote_first
    Rename $DshFinalDir $DshOldDir
    IfErrors dsh_promote_failed
    StrCpy $DshOldMoved "1"
    Goto dsh_promote_swap
  dsh_promote_first:
    RMDir $DshFinalDir
  dsh_promote_swap:
  ClearErrors
  Rename $DshNewDir $DshFinalDir
  IfErrors dsh_promote_failed
  StrCpy $DshNewMoved "1"
  SetOutPath $DshFinalDir
  Return
  dsh_promote_failed:
  Call DshRollbackDirectories
  SetErrors
FunctionEnd

; 失败统一出口：先回滚，再提示，最后以退出码 2 结束（silent 下 MessageBox 自动跳过）
Function DshFailInstall
  Call DshCleanupDirectories
  SetErrorLevel 2
  MessageBox MB_OK|MB_ICONSTOP "$(DSH_TEXT_APP_NAME)$\\n$\\n$DshFailReason$\\n$\\n$(DSH_TEXT_INSTALL_FAILED)" /SD IDOK
  Quit
FunctionEnd
Section "install"
  ; ── #93 事务性安装：写暂存 → 原子替换 → 提交 ──
  ; NSIS 内置步骤文案（Output/Extract/Delete…）会盖状态行；textonly 只留文字、
  ; 进度条照常走（nevershow 已把详情列表藏掉），阶段文案由 DetailPrint 写进状态行（1006）
  SetDetailsPrint textonly
  DetailPrint "$(DSH_TEXT_PREPARING)"
  StrCpy $DshFinalDir "$INSTDIR\\App"
  Call DshResolveLongPrefix
  Call DshDetectRunning
  StrCmp $DshRunning "1" 0 dsh_install_clear
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "$(DSH_TEXT_APP_NAME)$\\n$\\n$(DSH_TEXT_RUNNING_ASK)" IDYES dsh_install_runkill IDNO dsh_install_runcancel
    dsh_install_runkill:
      !ifdef DSH_WINDOW_FRAME_DLL
        System::Call '\${DSH_WINDOW_FRAME_DLL}::InstallerTerminateUnderPath(w "$INSTDIR") i .r0'
      !endif
      nsExec::Exec 'taskkill /F /T /IM "@@LAUNCHER_EXE@@"'   ; 无 DLL 时兜底；有 DLL 时再扫一遍名字以防万一
      Pop $0
      Call DshDetectRunning
      StrCmp $DshRunning "1" 0 dsh_install_clear
        StrCpy $DshFailReason "$(DSH_TEXT_RUNNING_KILL_FAILED)"
        Call DshFailInstall
    dsh_install_runcancel:
      SetErrorLevel 2   ; 用户选择取消：静默退出，不弹框
      Quit
  dsh_install_clear:
  ; 事务 token：GUID 前 6 位十六进制，够唯一，又只给路径加 11 个字符（MAX_PATH 余量）
  System::Call 'ole32::CoCreateGuid(g .r0) i .r1'
  StrCmp $1 "0" 0 dsh_install_token_fallback
    StrCpy $DshToken $0 6 1
  dsh_install_token_fallback:
  StrCmp $DshToken "" 0 dsh_install_token_ready
    System::Call 'kernel32::GetTickCount() i.r0'
    StrCpy $DshToken "$0"
  dsh_install_token_ready:
  StrCpy $DshNewDir "$DshFinalDir.new-$DshToken"
  StrCpy $DshOldDir "$DshFinalDir.old-$DshToken"
  ClearErrors
  CreateDirectory $DshNewDir
  IfErrors 0 dsh_install_stage_ready
    StrCpy $DshFailReason "无法创建暂存目录 $DshNewDir（磁盘空间或权限不足）。"
    Call DshFailInstall
  dsh_install_stage_ready:
  ; 新版先完整落进同卷暂存目录：写失败时正式目录一个字节都没动
  SetOutPath $DshNewDir
  DetailPrint "$(DSH_TEXT_COPYING)"        ; 解压=「安装文件」阶段：先切阶段再 File /r，进度条才不会假死在「准备 2%」
  System::Call 'user32::SetPropW(p $HWNDPARENT, w "HarnessInstaller.Stage", p 1)'
  File /r "${nsiEscape(packDir)}\\*.*"
@@PAYLOAD_RENAME@@
  WriteUninstaller "$DshNewDir\\uninstall.exe"
  IfErrors 0 dsh_install_staged
    StrCpy $DshFailReason "写入暂存目录 $DshNewDir 失败（磁盘空间或路径过长）。"
    Call DshFailInstall
  dsh_install_staged:
  StrCpy $DshShotName "02-progress"
  Call DshShotNow
  Call DshPromoteDirectories
  IfErrors 0 dsh_install_promoted
    StrCpy $DshFailReason "替换安装目录失败（可能被杀毒软件或资源管理器占用）。"
    Call DshFailInstall
  dsh_install_promoted:
  StrCpy $DshShotName "03-progress-done"
  Call DshShotNow
  DetailPrint "$(DSH_TEXT_REGISTERING)"
  System::Call 'user32::SetPropW(p $HWNDPARENT, w "HarnessInstaller.Stage", p 2)'
  ; ── 提交点：目录已就位，此后才写注册表与快捷方式，回滚不必撤销它们 ──
  StrCpy $DshNewMoved ""
  DetailPrint "$(DSH_TEXT_FINALIZING)"
  System::Call 'user32::SetPropW(p $HWNDPARENT, w "HarnessInstaller.Stage", p 3)'   ; 删旧版备份耗时较长（真机可达分钟级），先切到完成收尾阶段给用户反馈
  WriteRegStr HKCU "Software\\@@APP_ID@@" "InstallDir" $INSTDIR
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\@@APP_ID@@" "DisplayName" "$(DSH_TEXT_APP_NAME)"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\@@APP_ID@@" "DisplayIcon" "$INSTDIR\\App\\bin\\launcher.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\@@APP_ID@@" "UninstallString" "$INSTDIR\\App\\uninstall.exe"
  CreateDirectory "$SMPROGRAMS\\@@APP_NAME@@"
  CreateShortCut "$SMPROGRAMS\\@@APP_NAME@@\\@@APP_NAME@@.lnk" "$INSTDIR\\App\\bin\\launcher.exe"
  CreateShortCut "$SMPROGRAMS\\@@APP_NAME@@\\$(DSH_TEXT_UNINSTALL_SHORTCUT).lnk" "$INSTDIR\\App\\uninstall.exe"
  ; 删掉旧版本备份才算提交完成；删不掉（占用/长路径）只留残留，不回滚已经可用的新版
  StrCmp $DshOldMoved "1" 0 dsh_install_done
  Call DshDetectRunning
  StrCmp $DshRunning "1" 0 dsh_install_rmold
    DetailPrint "旧版本仍在运行，备份保留在 $DshOldDir（下次启动安装器时清理）"
    Goto dsh_install_done
  dsh_install_rmold:
    ; 同步删（nsExec 等待完成）：覆盖层此时已显示「正在清理旧版本…」，耗时是诚实的；rd 比 RMDir /r 快
    nsExec::Exec '"$SYSDIR\\cmd.exe" /C rd /s /q "$DshPrefix$DshOldDir"'
    Pop $0
    StrCpy $DshOldMoved ""   ; 删不剩的（上次锁定残留）由下次启动清理
  dsh_install_done:
  Call DshSweepLeftovers   ; 顺手扫掉历史残留的 .old-*/.new-*（本次之外的老遗留）
  DetailPrint "$(DSH_TEXT_FINALIZING)"
  System::Call 'user32::SetPropW(p $HWNDPARENT, w "HarnessInstaller.Stage", p 4)'
  StrCpy $8 "section: done"
  !insertmacro DshShotTrace "$8"
  ; NSIS 在段末会把 Back/Next 摆回来（准备下一页）：段尾再藏一次，覆盖层与完成页才不会被穿帮
  GetDlgItem $1 $HWNDPARENT 3
  ShowWindow $1 0
  GetDlgItem $1 $HWNDPARENT 1
  ShowWindow $1 0
  StrCpy $8 "section: end"
  !insertmacro DshShotTrace "$8"
SectionEnd

Section "un.install"
  ; 卸载器的 $INSTDIR 从安装时写的注册表恢复（用户自定义目录也要卸干净）
  ReadRegStr $INSTDIR HKCU "Software\\@@APP_ID@@" "InstallDir"
  ; 应用在跑时删树只会删一半（占用文件删不掉，还留半残目录），先劝退
  Call un.DshDetectRunning
  StrCmp $DshRunning "1" 0 dsh_uninstall_clear
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(DSH_TEXT_APP_NAME)$\\n$\\n$(DSH_TEXT_RUNNING_UNINSTALL)" /SD IDOK
    SetErrorLevel 2
    Quit
  dsh_uninstall_clear:
  Delete "$SMPROGRAMS\\@@APP_NAME@@\\@@APP_NAME@@.lnk"
  Delete "$SMPROGRAMS\\@@APP_NAME@@\\$(DSH_TEXT_UNINSTALL_SHORTCUT).lnk"
  RMDir "$SMPROGRAMS\\@@APP_NAME@@"
  ; #78 + #93：先摘壳插件链接（junction）再删应用树——链接在树内时递归删除会顺着走进 .dsh 主目录
  Call un.CleanShellPluginLinks
  Call un.DshRemoveAppTree
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\@@APP_ID@@"
  DeleteRegKey HKCU "Software\\@@APP_ID@@"
  ; #107：壳运行时写的通知身份键（HKCU\Software\Classes\AppUserModelId\<APP_ID>）一并清掉
  DeleteRegKey HKCU "Software\\Classes\\AppUserModelId\\@@APP_ID@@"
  ; 非递归：安装根只有空了才删得掉，别误伤用户自己放进去的东西
  RMDir "$INSTDIR"
SectionEnd`

// 卸载器专用：尽力摘掉三件壳插件在各 profile 池里的挂载链接（DSH_HOME 优先，缺省 %USERPROFILE%\\.dsh，与壳 dshHome() 同源）。
// 只 RMDir 链接本身：junction/symlink 按目录项摘除、不进目标内容；真实目录非空时 RMDir 静默失败，不会误删。
const uninstallerCleanupFn = `
Function un.CleanShellPluginLinks
  ReadEnvStr $R0 "DSH_HOME"
  StrCmp $R0 "" 0 un78_have
  ReadEnvStr $R0 "USERPROFILE"
  StrCmp $R0 "" 0 un78_default
  Return
un78_default:
  StrCpy $R0 "$R0\\.dsh"
un78_have:
  FindFirst $R1 $R2 "$R0\\profiles\\*.*"
un78_profile:
  StrCmp $R2 "" un78_done
  IfFileExists "$R0\\profiles\\$R2\\node_modules\\*.*" 0 un78_next
  RMDir "$R0\\profiles\\$R2\\node_modules\\dsh-desktop-bun"
  RMDir "$R0\\profiles\\$R2\\node_modules\\dsh-mobile-access"
  RMDir "$R0\\profiles\\$R2\\node_modules\\dsh-web-mobile"
un78_next:
  FindNext $R1 $R2
  Goto un78_profile
un78_done:
  FindClose $R1
  ; 旧布局兜底：共享池曾直接放 <home>\\node_modules（#13 之前）
  RMDir "$R0\\node_modules\\dsh-desktop-bun"
  RMDir "$R0\\node_modules\\dsh-mobile-access"
  RMDir "$R0\\node_modules\\dsh-web-mobile"
FunctionEnd`

// #93 卸载期：同样用长路径前缀删应用树，并清掉安装中断留下的暂存/备份目录（事务残渣）。
const uninstallerTxnFn = `
Function un.DshResolveLongPrefix
  StrCpy $DshPrefix "${longPrefix}"
  StrCpy $R3 $INSTDIR 2
  StrCmp $R3 "\\" 0 un_dsh_prefix_done
    StrCpy $DshPrefix ""
  un_dsh_prefix_done:
FunctionEnd

Function un.DshDetectRunning
  StrCpy $DshRunning 0
  nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq @@LAUNCHER_EXE@@" /NH | find /I "@@LAUNCHER_EXE@@"'
  Pop $0
  Pop $1
  StrCmp $0 "0" 0 un_dsh_running_done
    StrCpy $DshRunning 1
  un_dsh_running_done:
FunctionEnd

Function un.DshRemoveAppTree
  Call un.DshResolveLongPrefix
  RMDir /r "$DshPrefix$INSTDIR\\App"
  FindFirst $R3 $R4 "$INSTDIR\\App.new-*"
  un_dsh_new_loop:
    StrCmp $R4 "" un_dsh_new_done
    ClearErrors
    RMDir /r "$DshPrefix$INSTDIR\\$R4"
    FindNext $R3 $R4
    Goto un_dsh_new_loop
  un_dsh_new_done:
  FindClose $R3
  FindFirst $R3 $R4 "$INSTDIR\\App.old-*"
  un_dsh_old_loop:
    StrCmp $R4 "" un_dsh_old_done
    ClearErrors
    RMDir /r "$DshPrefix$INSTDIR\\$R4"
    FindNext $R3 $R4
    Goto un_dsh_old_loop
  un_dsh_old_done:
  FindClose $R3
FunctionEnd`
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
      `  CreateDirectory "$DshNewDir\\bin\\.installer"`,
      `  Rename "$DshNewDir\\Resources\\${escapedPayload}" "$DshNewDir\\bin\\.installer\\launcher.tar.zst"`,
      `  Rename "$DshNewDir\\Resources\\metadata.json" "$DshNewDir\\bin\\.installer\\launcher.metadata.json"`,
    ].join('\n')
  }
// 占位符替换覆盖全部片段（含卸载器函数），否则 @@LAUNCHER_EXE@@ 之类会漏进生成的 .nsi
const nsi = (nsiTemplate + uninstallerCleanupFn + uninstallerTxnFn)
  .replaceAll('@@PAYLOAD_RENAME@@', payloadRename)
  .replaceAll('@@APP_NAME@@', 'DeepSeek Harness Desktop BUN')
  .replaceAll('@@APP_ID@@', 'DeepSeekHarnessDesktopBUN')
  .replaceAll('@@APP_DIR_NAME@@', appDirName)
  .replaceAll('@@INSTALL_ROOT@@', 'DSHDesktopBun')
  .replaceAll('@@LAUNCHER_EXE@@', launcherExe)
  .replaceAll('@@BUILD_ID@@', buildId)

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
// artifacts/ 由 mac 打包步骤创建；单独跑这个脚本（或集成测试）时它可能还不存在
mkdirSync(join(projectRoot, 'artifacts'), { recursive: true })
// -WX：把 warning 当错误 —— 漏一门语言的译文只报 warning 6040，运行期会渲染空串（没有英文回退），必须拦住
// /INPUTCHARSET UTF8：ui.nsh / strings.nsh 都不带 BOM，显式声明按 UTF-8 解码（BOM 只按文件生效）
// makensis 的开关在 Windows 用 / 前缀、在 POSIX（macOS/Linux）用 - 前缀，混用会被当成脚本名
const makensisDash = process.platform === 'win32' ? '/' : '-'
const makensis = spawnSync(
  makensisPath,
  [`${makensisDash}WX`, `${makensisDash}INPUTCHARSET`, 'UTF8', nsiPath],
  { stdio: 'inherit' },
)
if (makensis.status !== 0 || makensis.error !== undefined) {
  console.error('[installer] makensis 编译失败（看上方 NSIS 输出定位 .nsi 行号）')
  process.exit(1)
}
// DSH_INSTALLER_ALLOW_STUB=1：installer-ui.yml 专用验证工作流用 stub 载荷秒级打包，
// 产物只有 ~220KB；不设该变量时维持 ≥1MB 断言（真载荷回归照旧被拦住）
const info = statSync(outFile)
if (info.size < 1_000_000 && process.env.DSH_INSTALLER_ALLOW_STUB !== '1') {
  console.error(`[installer] 产物异常地小：${outFile}（${String(info.size)} B）`)
  process.exit(1)
}
console.log(`[installer] 完成：${outFile}（${String(info.size)} B）`)
