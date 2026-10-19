// #78 卸载清理：NSIS 模板断言。makensis 不在测试里跑（macOS/CI 测试机都没有），这里只守模板内容——
// 卸载段必须调用 un.CleanShellPluginLinks；函数体对三个壳插件包名只 RMDir 链接本身，
// 禁 RMDir /r（真实目录占位时递归删会误伤用户文件）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

// 行尾统一成 LF：Windows 检出是 CRLF，下面有 "\n" 锚定的正则
const script = readFileSync(join(import.meta.dir, '..', 'scripts', 'build-windows-installer.mjs'), 'utf8').replaceAll('\r\n', '\n')

const fnStart = script.indexOf('Function un.CleanShellPluginLinks')
const uninstallerFn = script.slice(fnStart, script.indexOf('FunctionEnd', fnStart))
const uninstallSection = script.slice(
  script.indexOf('Section "un.install"'),
  script.indexOf('SectionEnd', script.indexOf('Section "un.install"')),
)

describe('NSIS 卸载段：清壳插件链接（#78）', () => {
  test('un.install 段调用清理函数', () => {
    expect(uninstallSection).toContain('Call un.CleanShellPluginLinks')
  })

  test('home 解析与壳 dshHome() 同源：DSH_HOME 优先，缺省回 %USERPROFILE%\\.dsh；两者皆空直接放弃', () => {
    expect(uninstallerFn).toContain('ReadEnvStr $R0 "DSH_HOME"')
    expect(uninstallerFn).toContain('ReadEnvStr $R0 "USERPROFILE"')
    expect(uninstallerFn).toContain(String.raw`StrCpy $R0 "$R0\\.dsh"`)
    expect(uninstallerFn).toContain(String.raw`FindFirst $R1 $R2 "$R0\\profiles\\*.*"`)
  })

  test('三件壳插件包名逐一 RMDir（profile 池 + 旧布局 home 直下池），且不递归', () => {
    for (const name of ['dsh-desktop-bun', 'dsh-mobile-access', 'dsh-web-mobile']) {
      expect(uninstallerFn).toContain(String.raw`RMDir "$R0\\profiles\\$R2\\node_modules\\${name}"`)
      expect(uninstallerFn).toContain(String.raw`RMDir "$R0\\node_modules\\${name}"`)
      expect(uninstallerFn).toContain(String.raw`IfFileExists "$R0\\profiles\\$R2\\node_modules\\*.*" 0 un78_next`)
      expect(uninstallerFn).toContain(String.raw`FindNext $R1 $R2`)
      expect(uninstallerFn).toContain('FindClose $R1')
    }
    expect(uninstallerFn).not.toContain('RMDir /r')
  })
})

// ── #93 事务性安装：写暂存 → 原子替换 → 回滚 ───────────────────────────────────
// 同 #78 的口径：makensis 不在测试机跑（macOS/CI 测试机都没有），这里只守模板结构，
// 真实编译在 CI 的 Windows job（build.yml）。
const installSection = script.slice(
  script.indexOf('Section "install"'),
  script.indexOf('SectionEnd', script.indexOf('Section "install"')),
)
const onInitFn = script.slice(
  script.indexOf('Function .onInit'),
  script.indexOf('FunctionEnd', script.indexOf('Function .onInit')),
)
const promoteFn = script.slice(
  script.indexOf('Function DshPromoteDirectories'),
  script.indexOf('FunctionEnd', script.indexOf('Function DshPromoteDirectories')),
)
const rollbackFn = script.slice(
  script.indexOf('Function DshRollbackDirectories'),
  script.indexOf('FunctionEnd', script.indexOf('Function DshRollbackDirectories')),
)
const failFn = script.slice(
  script.indexOf('Function DshFailInstall'),
  script.indexOf('FunctionEnd', script.indexOf('Function DshFailInstall')),
)
const unTxnFn = script.slice(
  script.indexOf('Function un.DshRemoveAppTree'),
  script.indexOf('FunctionEnd', script.indexOf('Function un.DshRemoveAppTree')),
)

describe('NSIS 事务性安装（#93）', () => {
  test('新版先写同卷暂存目录，正式目录在替换前一个字节都不动', () => {
    expect(installSection).toContain('SetOutPath $DshNewDir')
    expect(installSection).toContain('File /r ')
    expect(installSection).toContain(String.raw`WriteUninstaller "$DshNewDir\\uninstall.exe"`)
    expect(installSection).not.toContain(String.raw`SetOutPath "$INSTDIR\\App"`)
  })

  test('替换 = 两次 Rename（先备份旧目录再换上新目录），改名之前释放输出目录句柄', () => {
    expect(promoteFn).toContain('SetOutPath $PLUGINSDIR')
    expect(promoteFn).toContain('Rename $DshFinalDir $DshOldDir')
    expect(promoteFn).toContain('Rename $DshNewDir $DshFinalDir')
    expect(promoteFn.indexOf('SetOutPath $PLUGINSDIR')).toBeLessThan(promoteFn.indexOf('Rename'))
    expect(promoteFn.indexOf('Rename $DshFinalDir $DshOldDir')).toBeLessThan(
      promoteFn.indexOf('Rename $DshNewDir $DshFinalDir'),
    )
    // Rename 的目标必须不存在：存在就先改名，不存在才删空目录
    expect(promoteFn).toContain(String.raw`IfFileExists "$DshFinalDir\\*.*"`)
    expect(promoteFn).toContain('RMDir $DshFinalDir')
  })

  test('回滚只撤本次事务的目录；备份恢复不了就完整保留（绝不删用户仅存的副本）', () => {
    expect(rollbackFn).toContain('Rename $DshOldDir $DshFinalDir')
    expect(rollbackFn).toContain(String.raw`RMDir /r "$DshPrefix$DshFinalDir"`)
    expect(rollbackFn).toContain(String.raw`RMDir /r "$DshPrefix$DshNewDir"`)
    expect(rollbackFn).toContain('可手工改名恢复')
  })

  test('注册表与快捷方式写在 promote 之后（回滚只需撤目录）', () => {
    const promoteAt = installSection.indexOf('Call DshPromoteDirectories')
    expect(promoteAt).toBeGreaterThan(-1)
    expect(promoteAt).toBeLessThan(installSection.indexOf(String.raw`"InstallDir" $INSTDIR`))
    expect(promoteAt).toBeLessThan(installSection.indexOf('CreateShortCut'))
    expect(installSection).toContain(String.raw`StrCpy $DshNewMoved ""`) // 提交点
  })


  test('任务栏身份（#199）：lnk 写 AUMID + 注册表身份在提交点之后，卸载清同一键', () => {
    const promoteAt = installSection.indexOf('Call DshPromoteDirectories')
    expect(promoteAt).toBeGreaterThan(-1)
    expect(installSection).toContain(String.raw`WinShell::SetLnkAUMI "$SMPROGRAMS\\@@APP_NAME@@\\@@APP_NAME@@.lnk" "@@APP_ID@@"`)
    expect(installSection).toContain(String.raw`WriteRegStr HKCU "Software\\Classes\\AppUserModelId\\@@APP_ID@@" "DisplayName" "$(DSH_TEXT_APP_NAME)"`)
    expect(installSection).toContain(String.raw`WriteRegStr HKCU "Software\\Classes\\AppUserModelId\\@@APP_ID@@" "IconUri" "$INSTDIR\\App\\bin\\launcher.exe"`)
    expect(installSection.indexOf('SetLnkAUMI')).toBeGreaterThan(promoteAt) // 与注册表/快捷方式同一提交点之后
    expect(uninstallSection).toContain(String.raw`DeleteRegKey HKCU "Software\\Classes\\AppUserModelId\\@@APP_ID@@"`)
    expect(script).toContain('!addplugindir') // WinShell 插件目录挂载（仓内自持）
  })

  test('launcher.exe 元数据与图标补丁（#199）：rcedit 设图标 + 应用名（Electrobun win.icon 未生效的兑底）', () => {
    expect(script).toContain('--set-icon')
    expect(script).toContain('rcedit')
    expect(script).toContain('--set-version-string FileDescription')
    expect(script).toContain('--set-version-string ProductName')
    // 补丁对象必须是包内 launcher（packDir 内相对 appDir 同路径），失败不阻断安装器主流程
    expect(script).toContain('relative(appDir, launcher)')
  })

  test('窗口图标 ico 兑底（#203 四轮）：app-icon.ico 随安装树进 bin/，壳侧从文件加载', () => {
    expect(script).toContain("copyFileSync(iconPath, join(appDir, 'bin', 'app-icon.ico'))")
  })
  test('失败出口统一：先回滚，再非零退出码，每个失败分支都走它', () => {
    expect(failFn).toContain('Call DshCleanupDirectories')
    expect(failFn).toContain('SetErrorLevel 2')
    expect(failFn).toContain('Quit')
    expect(installSection.match(/Call DshFailInstall/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  test('GUI 退出/用户取消与安装失败都会回滚', () => {
    expect(script).toMatch(/Function \.onGUIEnd\s+Call DshCleanupDirectories/)
    expect(script).toMatch(/Function \.onInstFailed\s+Call DshCleanupDirectories/)
  })

  test('装/卸之前都查 launcher 是否在跑（占用的文件顶着，Rename 必失败）', () => {
    expect(installSection).toContain('Call DshDetectRunning')
    expect(uninstallSection).toContain('Call un.DshDetectRunning')
    expect(script).toContain(String.raw`tasklist /FI "IMAGENAME eq @@LAUNCHER_EXE@@"`)
    expect(script).toContain(String.raw`find /I "@@LAUNCHER_EXE@@"`)
    // 占位符必须真被替换：替换链要覆盖 nsiTemplate + 两个卸载器片段
    expect(script).toContain("replaceAll('@@LAUNCHER_EXE@@', launcherExe)")
    expect(script).toContain('(nsiTemplate + uninstallerCleanupFn + uninstallerTxnFn)')
  })

  test('.onInit 清掉上次中断留下的暂存目录；备份只在当前版本在位时才删', () => {
    expect(onInitFn).toContain('InitPluginsDir')
    expect(onInitFn).toContain(String.raw`"$INSTDIR\\App.new-*"`)
    const guardAt = onInitFn.indexOf(String.raw`IfFileExists "$INSTDIR\\App\\bin\\launcher.exe"`)
    expect(guardAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(onInitFn.indexOf(String.raw`"$INSTDIR\\App.old-*"`))
  })

  test('长路径：删暂存/备份/应用树带条件前缀，UNC 退回普通路径', () => {
    expect(script).toMatch(/StrCpy \$R0 \$INSTDIR 2\n\s+StrCmp \$R0 "\\\\" 0 dsh_prefix_done/)
    expect(script).toContain(String.raw`StrCpy $DshPrefix ""`)
    expect(unTxnFn).toContain(String.raw`RMDir /r "$DshPrefix$INSTDIR\\App"`)
    expect(unTxnFn).toContain(String.raw`"$INSTDIR\\App.new-*"`)
    expect(unTxnFn).toContain(String.raw`"$INSTDIR\\App.old-*"`)
  })

  test('卸载顺序：先摘壳插件链接（junction 在树内）再删应用树，收尾非递归 RMDir', () => {
    const cleanAt = uninstallSection.indexOf('Call un.CleanShellPluginLinks')
    expect(cleanAt).toBeGreaterThan(-1)
    expect(cleanAt).toBeLessThan(uninstallSection.indexOf('Call un.DshRemoveAppTree'))
    expect(uninstallSection).toContain(String.raw`RMDir "$INSTDIR"`)
    expect(uninstallSection).not.toContain(String.raw`RMDir /r "$INSTDIR"`)
  })
})

// #103：安装界面拆成四个真 NSIS 源文件（主 .nsi 按 文案 → 主题 → 绘制 → 交互 顺序 include），
// 断言按职责落到对应文件上，不再一律盯 ui.nsh。视觉与真机行为留给 #90 的 Windows 验证与 --shot 抓真窗口。
const installerDir = join(import.meta.dir, '..', 'installer')
const readNsh = (name: string): string => readFileSync(join(installerDir, name), 'utf8').replaceAll('\r\n', '\n')
const stringsNsh = readNsh('strings.nsh') // 文案表（#88，LangString 双语）
const themeNsh = readNsh('theme.nsh') // 主题解析 + 两套调色板（#89）
const drawingNsh = readNsh('drawing.nsh') // GDI+ 绘制原语 + NM_CUSTOMDRAW painter
const uiNsh = readNsh('ui.nsh') // 页面生命周期 + 真控件 + 交互
const fnBody = (text: string, name: string): string => {
  // 按行首 Function <name> 精确匹配：DshFinish 是 DshFinishCreate 的前缀，indexOf 会抓错函数
  const start = text.search(new RegExp(`^Function ${name}\\s*$`, 'm'))
  return start < 0 ? '' : text.slice(start, text.indexOf('FunctionEnd', start))
}
// 去注释后的代码面：注释里会提到 window-frame.dll / GdipGetDC / !define 文案（说明为什么不用它们），断言只看真代码
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(';'))
    .join('\n')
const themeNshCode = codeOf(themeNsh)
const drawingNshCode = codeOf(drawingNsh)
const uiNshCode = codeOf(uiNsh)
/** 取 !define 的十进制值：跨文件比对「同一块版面」的常量有没有漂移。 */
const defineOf = (text: string, name: string): string => new RegExp(`!define ${name} (\\d+)`).exec(text)?.[1] ?? `<missing ${name}>`
const welcomeFn = fnBody(uiNsh, 'DshWelcomeCreate')
const welcomeLeaveFn = fnBody(uiNsh, 'DshWelcomeLeave')
const startInstallFn = fnBody(uiNsh, 'DshStartInstall')
const progressFn = fnBody(uiNsh, 'DshProgressShow')
const finishFn = fnBody(uiNsh, 'DshFinishCreate')
const finishLeaveFn = fnBody(uiNsh, 'DshFinishLeave')
const dshFinishFn = fnBody(uiNsh, 'DshFinish')
const uiInitFn = fnBody(uiNsh, 'DshUiInit')
const validatePathFn = fnBody(uiNsh, 'DshValidatePath')
const browsePathFn = fnBody(uiNsh, 'DshBrowsePath')
const installSectionFromScript = installSection

// ── #91 自定义 UI：nsDialogs 真控件 + 预渲染位图资产 + owner-draw（#103 重构）────────
// 四个 .nsh 都是真被 !include 的 NSIS 源文件：断言直接读它们，只守结构与关键 API。
describe('NSIS 自定义 UI（#91）', () => {
  test('三页取代 stock 目录页：welcome → instfiles → finish', () => {
    expect(script).toContain('Page custom DshWelcomeCreate DshWelcomeLeave')
    expect(script).toContain('Page instfiles "" DshProgressShow')
    expect(script).toContain('Page custom DshFinishCreate DshFinishLeave')
    expect(script).not.toContain('Page directory')
    const welcomeAt = script.indexOf('Page custom DshWelcomeCreate')
    const progressAt = script.indexOf('Page instfiles "" DshProgressShow')
    const finishAt = script.indexOf('Page custom DshFinishCreate')
    expect(welcomeAt).toBeLessThan(progressAt)
    expect(progressAt).toBeLessThan(finishAt)
  })

  test('comctl v6 清单（XPStyle on）：classic v5 BUTTON 不发 NM_CUSTOMDRAW，自绘 painter 会被饿死（真机实锤）', () => {
    expect(script).toContain('XPStyle on')
  })

  test('进度页只有 stock 控件（详情列表关掉）：状态行由安装段 DetailPrint 推阶段，并允许中途取消', () => {
    expect(script).toContain('ShowInstDetails nevershow')
    expect(script).toContain('ShowUnInstDetails nevershow')
    // show 槽里先按类名分清内/外层（$HWNDPARENT 不保证是外层，CI 真机 trace 实证）：
    // 取消 = stock 按钮 2，从外层 $R7 取，露出 + 换字体配色
    expect(progressFn).toMatch(/GetDlgItem \$1 \$R7 2[\s\S]*?ShowWindow \$DshCancel 5/)
    // 版本串（1028 IDC_VERSTR）不藏会在窗中间露出来；stock 状态文本（1006）不藏——
    // 它就是设计稿里的状态行，阶段文案由安装段 DetailPrint 推进
    // 进度条让 stock 1004 自己走，只把它摆到设计稿的槽上（原生高度会盖住那 8px 槽）；
    // 1004/1006 都住在内页子对话框里 ⇒ 必须从子对话框句柄取，从外层 $HWNDPARENT 取只会拿到空句柄
    expect(progressFn).toMatch(
      /GetDlgItem \$R5 \$R8 1004[\s\S]*?!insertmacro DshPlace \$R5 \$\{DSH_STOCK_BAR_X\} \$\{DSH_STOCK_BAR_Y\} \$\{DSH_STOCK_BAR_W\} \$\{DSH_STOCK_BAR_H\}/,
    )
    expect(progressFn).toMatch(
      /GetDlgItem \$R5 \$R8 1006[\s\S]*?!insertmacro DshPlace \$R5 \$\{DSH_STATUS_X\} \$\{DSH_STATUS_Y\} \$\{DSH_STATUS_W\} 24/,
    )
    // 阶段文案走 NSIS 内置 DetailPrint（textonly 只静音内置步骤文案，进度条照走）；
    // 页面侧不再回读自绘层 ⇒ DshRefreshProgress / DshPhaseText / DshProgressStep 整条消失
    expect(installSectionFromScript).toContain('SetDetailsPrint textonly')
    for (const phase of ['PREPARING', 'COPYING', 'REGISTERING', 'FINALIZING']) {
      expect(installSectionFromScript).toContain(`DetailPrint "$(DSH_TEXT_${phase})"`)
    }
    expect(uiNsh).not.toMatch(/Function DshRefreshProgress/)
    expect(uiNsh).not.toContain('$DshPhaseText')
    expect(uiNsh).not.toContain('$DshProgressStep')
    // 中途取消：instfiles 上没有 nsDialogs 会话（$nsDialogs.Dialog 还指着已销毁的欢迎页，
    // 再用 ${NSD_Create*} 就是 use-after-free ⇒ 真机 0xC0000005），取消走 stock 按钮 2：
    // 露出 + 换字体配色；点击仍是系统 Cancel 路径（.onGUIEnd/.onInstFailed 回滚）
    expect(progressFn).toMatch(
      /SetCtlColors \$DshCancel [\s\S]*?SendMessage \$DshCancel \$\{WM_SETFONT\} \$DshFontButton 1/,
    )
    // 回归钉：instfiles 页严禁 nsDialogs 控件（use-after-free）
    expect(progressFn).not.toMatch(/\$\{NSD_Create(BUTTON|BITMAP)\}/)
    expect(uiNsh).toMatch(/Function DshCloseWindow[\s\S]*?SendMessageW\(p \$HWNDPARENT, i \$\{WM_COMMAND\}, i 2, i 0\)/)   // WM_CLOSE 被 NSIS 吞掉，走 IDCANCEL 命令
    // #88：文案改走 LangString 双语表，主 .nsi 必须先 include strings.nsh 再 include ui.nsh
    expect(script).toContain('!include "${nsiEscape(stringsNshPath)}"')
    expect(uiNshCode).toMatch(/\$\(DSH_TEXT_[A-Z_]+\)/) // 引用一律是运行期 $(...) 形式
  })

  test('无边框品牌窗：官方同款样式 + FRAMECHANGED + 藏掉 stock 按钮（前进由自建按钮驱动）', () => {
    expect(uiInitFn).toContain("SetWindowLongW(p $HWNDPARENT, i -16, i 0x800A0000)")
    expect(uiInitFn).toContain('GetDeviceCaps(p r0, i 88)')
    // 0x34 = SWP_NOZORDER(0x04) | SWP_NOACTIVATE(0x10) | SWP_FRAMECHANGED(0x20)：换掉窗口样式后必须带 FRAMECHANGED
    const setWindowPos = /SetWindowPos\(p \$HWNDPARENT, p 0, i r1, i r2, i \$DshWindowSize, i \$DshWindowSize, i (0x[0-9A-Fa-f]+)\)/.exec(uiInitFn)
    expect(setWindowPos?.[1]).toBe('0x34')
    expect(Number(setWindowPos?.[1]) & 0x20).toBe(0x20) // SWP_FRAMECHANGED
    // 「下一步 / 取消 / 上一步」与版本串全藏（我们自绘一套）
    for (const id of ['1', '2', '3', '1028']) {
      expect(uiInitFn).toContain(`GetDlgItem $0 $HWNDPARENT ${id}`)
    }
    expect(uiNsh).toMatch(/Function \.onGUIInit\s+Call DshUiInit/)
    // 窗口没有标题栏，拖动/最小化/关闭必须自带
    expect(uiNsh).toContain('user32::ReleaseCapture()')
    expect(uiNsh).toMatch(/SendMessage \$HWNDPARENT \$\{WM_NCLBUTTONDOWN\} 2 0/)
    expect(uiNsh).toMatch(/Function DshMinimize[\s\S]*?ShowWindow \$HWNDPARENT 6/)
    expect(uiNsh).toMatch(/Function DshCloseWindow[\s\S]*?SendMessageW\(p \$HWNDPARENT, i \$\{WM_COMMAND\}, i 2, i 0\)/)
    // 拖动条 + 两个窗口按钮都是真控件，外观走 NM_CUSTOMDRAW 自绘（DshPaintWinBtn）
    expect(uiNsh).toMatch(
      /\$\{NSD_CreateLabel\} \$\{DSH_DRAG_X\} \$\{DSH_DRAG_Y\} \$\{DSH_DRAG_W\} \$\{DSH_DRAG_H\} ""[\s\S]*?\$\{NSD_OnClick\} \$DshDrag DshDragMove/,
    )
    expect(uiNsh.match(/\$\{NSD_OnNotify\} \$(DshMinBtn|DshCloseBtn) DshPaintWinBtn/g)?.length ?? 0).toBe(2)
 
    // 两个窗口按钮贴在标题栏右侧（44 宽：最小化 512、关闭 556）；字形随创建携带（空文本 painter 无字可画）
    expect(uiNsh).toContain('!define DSH_MIN_X 512')
    expect(uiNsh).toContain('${NSD_CreateButton} ${DSH_MIN_X} ${DSH_WINBTN_Y} ${DSH_WINBTN_W} ${DSH_WINBTN_H} "−"')
    expect(uiNsh).toContain('${NSD_CreateButton} 556 ${DSH_WINBTN_Y} ${DSH_WINBTN_W} ${DSH_WINBTN_H} "×"')
  })

  test('DPI 适配：布局写 96 DPI 逻辑像素，落位一律 MulDiv，>96 换 2x 品牌图', () => {
    // 落位统一走 DshPlace：几何四项逐个 MulDiv 之后再 MoveWindow
    expect(uiNsh).toMatch(/!macro DshPlace[\s\S]*?MulDiv\(i \$\{X\}, i \$DshDpi, i 96\)[\s\S]*?MulDiv\(i \$\{H\}, i \$DshDpi, i 96\)[\s\S]*?MoveWindow/)
    // 窗口边长也是换算出来的
    expect(uiNsh).toMatch(/MulDiv\(i \$\{DSH_WINDOW_SIZE\}, i \$DshDpi, i 96\)/)
    // 字号同样按 DPI：96 DPI 下 -SIZE 就是像素高
    expect(drawingNsh).toMatch(/!macro DshPixelFont HANDLE SIZE WEIGHT[\s\S]*?MulDiv\(i -\$\{SIZE\}, i \$DshDpi, i 96\)/)
    // >96 DPI 用 2x 瓦片（theme.nsh 给出两套路径，ui.nsh 的 DshBuildPageChrome 按 $DshDpi 选）
    expect(uiNsh).toMatch(/\$\{If\} \$DshDpi > 96[\s\S]*?\$DshWhaleFile2x[\s\S]*?\$\{Else\}[\s\S]*?"\$DshWhaleFile"/)
    expect(themeNsh).toContain('StrCpy $DshWhaleFile2x "$PLUGINSDIR\\whale-2x.bmp"')
    expect(themeNsh).toContain('StrCpy $DshWhaleFile2x "$PLUGINSDIR\\whale-dark-2x.bmp"')
    // 布局常量是 96 DPI 逻辑像素（窗口 600×600、标题栏 44、瓦片 44）
    expect(uiNsh).toContain('!define DSH_WINDOW_SIZE 600')
    expect(uiNsh).toContain('!define DSH_TILE_W 44')
    expect(uiNsh).toContain('!define DSH_TILE_H 44')
    expect(uiNsh).toContain('!define DSH_DRAG_H 44') // 标题栏高度
    expect(uiNsh).toContain('!define DSH_WINBTN_H 44')
    // #89 顺带修掉的 #91 落位缺陷：i.r0..i.r3 就是 $0..$3，句柄必须先存进专用 var
    expect(uiNsh).toContain('StrCpy $DshPlaceHwnd ${HWND}')
    expect(uiNsh).toContain('MoveWindow(p $DshPlaceHwnd')
    expect(uiNshCode).not.toContain('MoveWindow(p ${HWND}')
  })

  test('品牌图走 $PLUGINSDIR（官方 /oname 写法）并用完即释放', () => {
    // 编译期解到 $PLUGINSDIR，运行期从那里读（File /oname 官方同款）
    for (const name of ['whale.bmp', 'whale-dark.bmp', 'whale-2x.bmp', 'whale-dark-2x.bmp']) {
      expect(uiNsh).toContain(`File "/oname=$PLUGINSDIR\\${name}" "\${DSH_INSTALLER_ASSETS}\\${name}"`)
    }
    expect(uiNsh).toMatch(/!macro DshReleaseBrandFiles[\s\S]*?File "\/oname=\$PLUGINSDIR\\whale\.bmp"/)
    // 品牌瓦片 / 卡片 / 大勾都走 NSD 位图控件 + ${NSD_SetStretchedImage}（官方品牌图同款机制），
    // 页面退出时 ${NSD_FreeImage} 逐张释放；整页位图自建路线（$DshPageBitmap）已整条废弃。
    // 回归钉（2026-10-16 真机「双击无窗口」事故的根因家族）：GdipCreateHBITMAPFromBitmap
    // 只能吃 GpBitmap*（GdipCreateBitmapFromScan0 产物）；喂 GDI HBITMAP ⇒ System::Call 运行期崩。
    // 输入框圆角框（官方 InstallerDrawEditFrame 同款）是 ui.nsh 里唯一合法调用点。
    const hbitmapFromArgs = [...uiNsh.matchAll(/GdipCreateHBITMAPFromBitmap\(p (\$[\w]+)/g)].map((m) => m[1])
    expect(hbitmapFromArgs).toEqual(['$R4'])
    expect(drawingNsh).not.toContain('GdipCreateHBITMAPFromBitmap')
    expect(uiNsh).not.toContain('DshPageBitmap')
    expect(uiNsh).not.toContain('DshCreatePageBitmap')
    expect(drawingNsh).toMatch(
      /!macro DshReleaseBitmapDC BITMAPVAR HDCVAR[\s\S]*?SelectObject\(p \$\{HDCVAR\}, p \$DshPreviewOldBmp\)[\s\S]*?DeleteObject\(p \$\{BITMAPVAR\}\)[\s\S]*?DeleteDC\(p \$\{HDCVAR\}\)/,
    )
    for (const body of [welcomeFn, finishFn]) {
      expect(body).toContain('${NSD_FreeImage} $DshTileImage')
    }
    // 欢迎页释放卡片位图、完成页释放大勾位图（各一张，不是标题栏那张瓦片）
    expect(welcomeFn).toContain('${NSD_FreeImage} $DshCardImage')
    expect(finishFn).toContain('${NSD_FreeImage} $DshCheckImage')
  })

  test('官方同款 window-frame.dll 覆盖层（可选增强）：!ifdef 门禁 + 进度/完成/窗体接线 + 段内阶段推进', () => {
    // 用户拍板「照抄官方」：进度覆盖层与 DWM 窗体由 CI 编译的 window-frame.dll 提供（官方机制）；
    // 本机无 MSVC 时 dll 不存在 ⇒ 生成器不注入 define，覆盖层代码整段编译剔除，回退纯 NSIS 样式。
    expect(uiNshCode).toContain('!ifdef DSH_WINDOW_FRAME_DLL')
    expect(uiNshCode).toContain('${DSH_WINDOW_FRAME_DLL}::InstallerApplyFrame(p $HWNDPARENT)')
    expect(uiNshCode).toContain('${DSH_WINDOW_FRAME_DLL}::InstallerShowProgress(p $R7, p $R2, i $0, i $DshDpi')
    expect(uiNshCode).toContain('w "$DshWhaleFile2x", w "$(DSH_TEXT_CANCEL)") p.s ?c')   // tile/cancel 必须带引号传（CI diag：不带引号的 $var 会把垃圾指针传给 DLL）
    expect(uiNshCode).toContain('$(DSH_TEXT_PROGRESS_HEADLINE)')
    expect(uiNshCode).toContain('${DSH_WINDOW_FRAME_DLL}::InstallerFinishProgress(p $DshProgressWindow)')
    expect(progressFn).toContain('Pop $DshProgressWindow')
    expect(progressFn).toContain('Return') // 覆盖层接管后跳过 stock restyle
    expect(finishFn).toContain('DestroyWindow(p $DshProgressWindow)')
    // 覆盖层时间线引擎读 HarnessInstaller.Stage prop，由安装段的四个阶段推进
    expect(installSectionFromScript).toContain('"HarnessInstaller.Stage", p 1)')
    expect(installSectionFromScript).toContain('"HarnessInstaller.Stage", p 2)')
    expect(installSectionFromScript).toContain('"HarnessInstaller.Stage", p 4)')
    expect(installSectionFromScript).toContain('"HarnessInstaller.Stage", p 3)')   // 删旧版备份（真机分钟级）前先切阶段，别让 UI 冻在上一步
    expect(installSectionFromScript).toMatch(/Call DshDetectRunning[\s\S]{0,500}rd \/s \/q "\$DshPrefix\$DshOldDir"/)   // 旧版在运行→跳过删除；否则同步删（UI 此时显示「正在清理旧版本…」）
    expect(installSectionFromScript).toContain('DSH_TEXT_RUNNING_ASK')   // 旧实例在跑：二选一（结束并继续/取消安装），不再是只带确认的原生错误框
    expect(installSectionFromScript).toContain('taskkill /F /T /IM "@@LAUNCHER_EXE@@"')   // /T 连子进程树一起杀，只杀父进程时文件仍被占用
    expect(script).toContain('InstallerFindUnderPath(w "$INSTDIR")')   // 检测在 DshDetectRunning（模板函数内）；击杀/检测都按安装目录路径，按进程名杀不全（bun/WebView2 同样占文件）
    expect(installSectionFromScript).toContain('InstallerTerminateUnderPath(w "$INSTDIR")')
    const windowFrameCpp = readFileSync(join(installerDir, 'window-frame.cpp'), 'utf8')
    expect(windowFrameCpp).toContain('PBM_GETPOS')   // 解压阶段从被藏住的 stock 进度条读真实百分比
    expect(windowFrameCpp).toContain('stockBar')
    expect(windowFrameCpp).toContain('GhostButton')   // 覆盖层上的取消按钮（解压期间可中止）
    expect(windowFrameCpp).not.toContain('SetTimer(window, 1, 16')   // 60fps 全量重绘曾拖慢解压数倍
    expect(windowFrameCpp).toContain('InstallerFindUnderPath')
    expect(windowFrameCpp).toContain('InstallerTerminateUnderPath')
    expect(installSectionFromScript).toContain('Call DshSweepLeftovers')   // 安装完成前把历史残留的 .old-*/.new-* 一并扫掉
    expect(script).toContain('Function DshSweepLeftovers')
    // 段尾再藏 Back/Next：NSIS 在段末会摆回来准备下一页
    expect(installSectionFromScript).toMatch(/GetDlgItem \$1 \$HWNDPARENT 3[\s\S]*?GetDlgItem \$1 \$HWNDPARENT 1/)
    // 生成器：dll 存在→define+File 注入；不存在→告警回退
    expect(script).toContain('const hasWindowFrame = existsSync(windowFrameDllPath)')
    expect(script).toContain('File "/oname=$PLUGINSDIR\\\\window-frame.dll"')
    // 四脚本不出现未替换的 @@占位符@@
    const surfaces: Array<[string, string]> = [
      ['strings.nsh', codeOf(stringsNsh)],
      ['theme.nsh', themeNshCode],
      ['drawing.nsh', drawingNshCode],
      ['ui.nsh', uiNshCode],
    ]
    for (const [name, text] of surfaces) {
      expect(text, name).not.toContain('window-frame.dll') // 引用只走 ${DSH_WINDOW_FRAME_DLL}
      expect(text, name).not.toContain('@@')
    }
    // 只调系统 DLL：dwmapi(Win11 圆角) + uxtheme(剥 v6 主题让 PBM/SetCtlColors 生效)
    const plugins = new Set(['System', 'nsDialogs', 'nsExec'])
    const dlls = new Set(
      surfaces.flatMap(([, text]) => [...text.matchAll(/(\w+)::/g)].map((m) => m[1] ?? '')).filter((name) => !plugins.has(name)),
    )
    expect([...dlls].sort()).toEqual(['dwmapi', 'gdi32', 'gdiplus', 'kernel32', 'user32', 'uxtheme'])
    // 离屏预览用纯 GDI 的 DIB DC，不碰 GdipGetDC（嵌套误用实测会在 Wine 下画白并卡死）
    // --shot 抓真窗口用纯 GDI 的 DIB DC，不碰 GdipGetDC（嵌套误用实测会在 Wine 下画白并卡死）
    // 两个宏要由主 .nsi 在 include 之前提供
    expect(uiNsh).toContain('${DSH_INSTALLER_ASSETS}')
    expect(uiNsh).toContain('${DSH_APP_EXE}')
    expect(script).toMatch(/!define DSH_INSTALLER_ASSETS "\$\{nsiEscape\(installerAssetsDir\)\}"/)
    expect(script).toMatch(/!define DSH_APP_EXE "\$INSTDIR\\\\App\\\\bin\\\\\$\{launcherExe\}"/)
    expect(script).toContain('!include "${nsiEscape(uiNshPath)}"')
  })

  test('安装位置：选择目录 + 校验后写进 $INSTDIR（校验不过 Abort）', () => {
    // 目录选择用官方同款 nsDialogs::SelectFolderDialog；真机曾两连崩，直因疑似「初始目录不存在」——
    // 现在传参前做存在性守卫（不存在传空），SELECTFOLDER 崩溃路径不再可达
    expect(uiNsh).toContain('nsDialogs::SelectFolderDialog')
    // 输入框是真控件（起点 $INSTDIR）；浏览按钮把选中的目录写回输入框
    expect(welcomeFn).toMatch(/\$\{NSD_CreateText\} \$\{DSH_EDIT_X\} \$\{DSH_EDIT_Y\} \$\{DSH_EDIT_W\} \$\{DSH_EDIT_H\} "\$INSTDIR"[\s\S]*?Pop \$DshEdit/)
    // 初始目录必须真实存在（不存在传空用插件默认值），选中后写回输入框
    expect(browsePathFn).toMatch(/\$\{If\} \$\{FileExists\} "\$DshPath\\\*\.\*"[\s\S]*?SelectFolderDialog[\s\S]*?\$\{NSD_SetText\} \$DshEdit "\$0"/)
    // 校验 + 落 $INSTDIR：leave 回调与主按钮（发 0x408 之前）走同一套
    expect(welcomeLeaveFn).toMatch(/\$\{NSD_GetText\} \$DshEdit \$DshPath[\s\S]*?Call DshValidatePath[\s\S]*?Abort[\s\S]*?StrCpy \$INSTDIR "\$DshPath"/)
    expect(startInstallFn).toMatch(
      /Call DshValidatePath[\s\S]*?StrCpy \$INSTDIR "\$DshPath"[\s\S]*?SendMessage \$HWNDPARENT \$\{WM_NOTIFY_OUTER_NEXT\} 1 0/,
    )
    // 校验规则：空 / 短于 4 字符（盘根）/ 不是 `X:` 形式 / 建不出来 → 各有 LangString 报错
    expect(validatePathFn).toContain('StrCpy $DshError "$(DSH_TEXT_PATH_EMPTY)"')
    expect(validatePathFn).toMatch(/\$\{If\} \$0 < 4[\s\S]*?DSH_TEXT_PATH_INVALID/)
    expect(validatePathFn).toMatch(/\$\{If\} \$1 != ":"[\s\S]*?DSH_TEXT_PATH_INVALID/)
    expect(validatePathFn).toMatch(/CreateDirectory "\$DshPath"[\s\S]*?\$\{If\} \$\{Errors\}[\s\S]*?DSH_TEXT_PATH_UNWRITABLE/)
  })

  test('版面几何常量落在 ui.nsh 单源（同一份设计稿，不许两边各写一套）', () => {
    // 字段 / 浏览 / 主按钮 / 开关 / 进度槽 / 状态行：整页自绘层已删除，只剩 ui.nsh 一处 !define，
    // 值逐条对齐设计稿（96 DPI 逻辑像素）
    const expected: Array<[string, string]> = [
      ['DSH_EDIT_X', '48'],
      ['DSH_EDIT_Y', '298'],
      ['DSH_EDIT_W', '392'],
      ['DSH_EDIT_H', '40'],
      ['DSH_BROWSE_X', '456'],
      ['DSH_BROWSE_Y', '298'],
      ['DSH_BROWSE_W', '96'],
      ['DSH_BROWSE_H', '40'],
      ['DSH_MAIN_X', '32'],
      ['DSH_MAIN_Y', '486'],
      ['DSH_MAIN_W', '536'],
      ['DSH_MAIN_H', '48'],
      ['DSH_SWITCH_X', '48'],
      ['DSH_SWITCH_Y', '428'],
      ['DSH_SWITCH_W', '44'],
      ['DSH_SWITCH_H', '24'],
      ['DSH_STOCK_BAR_X', '32'],
      ['DSH_STOCK_BAR_Y', '452'],
      ['DSH_STOCK_BAR_W', '536'],
      ['DSH_STOCK_BAR_H', '8'],
      ['DSH_STATUS_X', '32'],
      ['DSH_STATUS_Y', '476'],
      ['DSH_STATUS_W', '536'],
      ['DSH_PROGRESS_CANCEL_Y', '520'],
    ]
    for (const [name, value] of expected) expect(defineOf(uiNsh, name), name).toBe(value)
    // 真控件一律引用这些 ${} 常量落位，不写裸坐标
    expect(welcomeFn).toContain('${NSD_CreateText} ${DSH_EDIT_X} ${DSH_EDIT_Y} ${DSH_EDIT_W} ${DSH_EDIT_H} "$INSTDIR"')
    expect(welcomeFn).toContain('${NSD_CreateButton} ${DSH_BROWSE_X} ${DSH_BROWSE_Y} ${DSH_BROWSE_W} ${DSH_BROWSE_H}')
    expect(welcomeFn).toContain('${NSD_CreateButton} ${DSH_MAIN_X} ${DSH_MAIN_Y} ${DSH_MAIN_W} ${DSH_MAIN_H}')
    expect(finishFn).toContain(
      '${NSD_CreateCheckBox} ${DSH_SWITCH_X} ${DSH_SWITCH_Y} ${DSH_SWITCH_W} ${DSH_SWITCH_H}',
    )
    expect(progressFn).toMatch(
      /!insertmacro DshPlace \$R5 \$\{DSH_STOCK_BAR_X\} \$\{DSH_STOCK_BAR_Y\} \$\{DSH_STOCK_BAR_W\} \$\{DSH_STOCK_BAR_H\}/,
    )
    expect(progressFn).toMatch(
      /!insertmacro DshPlace \$R5 \$\{DSH_STATUS_X\} \$\{DSH_STATUS_Y\} \$\{DSH_STATUS_W\}/,
    )
  })

  test('完成页：勾选启动则 Exec 安装后的 launcher，失败不静默', () => {
    // 开关是真 checkbox（NSD 宏名就是 CheckBox），默认勾上，外观由 DshPaintSwitch 画
    expect(finishFn).toContain('${NSD_CreateCheckBox}')
    expect(finishFn).toContain('${NSD_Check} $DshSwitch')
    expect(finishFn).toContain('${NSD_OnNotify} $DshSwitch DshPaintSwitch')
    // 完成按钮 = 自绘主按钮：点击先发 0x408 结束向导（Function DshFinish），收尾在 leave 回调
    expect(finishFn).toMatch(
      /\$\{NSD_CreateButton\} \$\{DSH_DONE_X\}[\s\S]*?Pop \$DshMain[\s\S]*?\$\{NSD_OnNotify\} \$DshMain DshPaintPrimary[\s\S]*?\$\{NSD_OnClick\} \$DshMain DshFinish\b/,
    )
    expect(dshFinishFn).toMatch(/SendMessage \$HWNDPARENT \$\{WM_NOTIFY_OUTER_NEXT\} 1 0/)
    expect(finishLeaveFn).toContain('StrCpy $DshLaunchWanted "1"')
    // 勾了就 Exec 安装后的 launcher；Exec 报错必须弹 LangString 文案（不静默）
    expect(finishLeaveFn).toMatch(
      /\$\{NSD_GetState\} \$DshSwitch \$0[\s\S]*?Exec '"\$\{DSH_APP_EXE\}"'[\s\S]*?\$\{If\} \$\{Errors\}[\s\S]*?MessageBox MB_OK\|MB_ICONEXCLAMATION "\$\(DSH_TEXT_LAUNCH_FAILED\)"/,
    )
  })

  test('自建按钮走 0x408（WM_NOTIFY_OUTER_NEXT）推进分页，等价 stock 下一步', () => {
    expect(uiNsh).toContain('!define WM_NOTIFY_OUTER_NEXT 0x408')
    // 首页主按钮 = 前进入口（stock 按钮全藏着），校验通过才发
    expect(startInstallFn).toContain('SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0')
    expect(welcomeFn).toContain('${NSD_OnClick} $DshMain DshStartInstall')
    // 完成页的「完成」也是 0x408 前进（Function DshFinish），真正的收尾在 leave 回调：
    // 记录开关（$DshLaunchWanted）→ 需要时 Exec，失败弹 LangString
    expect(finishFn).toContain('${NSD_OnClick} $DshMain DshFinish')
    expect(dshFinishFn).toMatch(/SendMessage \$HWNDPARENT \$\{WM_NOTIFY_OUTER_NEXT\} 1 0/)
    expect(uiNsh.match(/SendMessage \$HWNDPARENT \$\{WM_NOTIFY_OUTER_NEXT\} 1 0/g)?.length ?? 0).toBe(2)
  })

  test('文案走 installer/strings.nsh 的 LangString 双语表（#88），不再用 !define 定死', () => {
    // 绘制层/交互层只许 $(...) 运行期引用文案；!define DSH_TEXT_X 是 #88 起废弃的写法
    // 交互层只许 $(...) 运行期引用文案；!define DSH_TEXT_X 是 #88 起废弃的写法
    //（DrawTextW 的 format 常量在 drawing.nsh 的 DshTextHdc 宏里以字面量出现，与文案 key 不同名，
    //   不能对 !define DSH_TEXT_ 一刀切；theme.nsh 那条已死掉的 !define DSH_TEXT_THEME_ERROR 见报告）
    const painting = [uiNshCode, drawingNshCode].join('\n')
    const references = [...painting.matchAll(/\$\(DSH_TEXT_([A-Z_]+)\)/g)]
    expect(references.length).toBeGreaterThanOrEqual(15)
    for (const [, key] of references) expect(painting).not.toContain(`!define DSH_TEXT_${key} `)
    expect(stringsNsh).toContain('LoadLanguageFile "${NSISDIR}\\Contrib\\Language files\\English.nlf"')
    expect(stringsNsh).toContain('LoadLanguageFile "${NSISDIR}\\Contrib\\Language files\\SimpChinese.nlf"')
    // ① 第一个装载的语言 = 系统语言全不匹配时的回退语言 ⇒ 产品是中文优先，简中在前（维护者 2026-10-16 拍板）
    expect(stringsNsh.indexOf('SimpChinese.nlf')).toBeLessThan(stringsNsh.indexOf('English.nlf'))
    // 用到的每条文案必须两种语言都在（缺一门只报 warning 6040、运行期渲染空串）
    const used = new Set(
      [uiNshCode, drawingNshCode, themeNshCode].flatMap((text) =>
        [...text.matchAll(/\$\(DSH_TEXT_([A-Z_]+)\)/g)].map((m) => m[1] ?? ''),
      ),
    )
    expect(used.size).toBeGreaterThan(10)
    for (const name of used) {
      expect(stringsNsh).toContain(`LangString DSH_TEXT_${name} \${LANG_ENGLISH} `)
      expect(stringsNsh).toContain(`LangString DSH_TEXT_${name} \${LANG_SIMPCHINESE} `)
    }
    expect(uiNsh).toContain('!ifndef DSH_INSTALLER_UI')
  })

  test('!define 常量一律用 ${} 引用（$NAME 会被当变量、warning 6000 静默置空）', () => {
    // makensis 实测：$DSH_TEXT_X 只报 warning 6000 然后把整段文案变空串，编译仍然成功——必须钉死
    for (const text of [uiNshCode, drawingNshCode, themeNshCode]) {
      expect(text).not.toMatch(/\$DSH_[A-Z_]+/)
    }
    for (const name of ['DSH_INSTALLER_ASSETS', 'DSH_APP_EXE', 'DSH_WINDOW_SIZE']) {
      expect(uiNshCode).toMatch(new RegExp(`\\$\\{${name}[^A-Z_]`))
    }
    for (const name of ['DSH_TILE_X', 'DSH_STATUS_Y', 'DSH_CHECK_W']) {
      expect(uiNshCode).toMatch(new RegExp(`\\$\\{${name}[^A-Z_]`))
    }
  })

  test('生成器拦在缺品牌图之前：没跑 prepare:installer-assets 就给出可执行的下一步', () => {
    expect(script).toContain('const missingAssets = brandAssets.filter')
    expect(script).toContain('bun run prepare:installer-assets')
    expect(script).toContain(String.raw`const uiNshPath = join(projectRoot, 'installer', 'ui.nsh')`)
    // #103：界面脚本缺一个都要先拦（ui/strings 各有守卫，theme/drawing 走清单；否则 makensis 只报难懂的 file not found）
    expect(script).toContain("const installerScripts = ['theme.nsh', 'drawing.nsh']")
    expect(script).toContain('缺安装界面脚本')
    // 资产守卫清单 = 品牌 ×4 + 鲸鱼瓦片 ×4 + 卡片 ×4 + 大勾 ×4（必须与 ui.nsh 的 File 逐张对齐）
    const guard = /const brandAssets = \[([^\]]*)\]/.exec(script)?.[1] ?? ''
    for (const family of ['brand', 'whale', 'card', 'check-circle']) {
      expect([...guard.matchAll(new RegExp(`'${family}[^']*\\.bmp'`, 'g'))].length, family).toBe(4)
    }
  })
})

describe('安装器回归：离屏预览路线已整条删掉（#103 重构）', () => {
  // 背景：DshRunPreview 最初把「没传 /PREVIEW=」当成用法错误 → SetErrorLevel 2 + Quit，
  // 于是**所有正常安装**（含 CI 的静默安装）都在 .onInit 里直接退出，安装目录根本不建。
  // 重构后 preview.nsh 与 DshRunPreview 一起删掉，截图验证改走 --shot 抓真窗口；
  // 预览入口与 /PREVIEW 都不得复活（这是 #103 CI 事故的根因面）。
  test('DshRunPreview 与 /PREVIEW 全消失：三个界面脚本 + 主 .nsi 都不许再有', () => {
    expect(uiNsh + drawingNsh + themeNsh).not.toContain('DshRunPreview')
    expect(script).not.toContain('DshRunPreview')
    expect(script).not.toContain('DshPreviewDir')
    // 事故复盘留在 ui.nsh 的注释里（--shot 说明），判据只看去注释后的代码面
    for (const text of [uiNshCode, drawingNshCode, themeNshCode]) {
      expect(text).not.toContain('/PREVIEW')
      expect(text).not.toContain('$DshPreviewDir')
    }
  })

  test('--shot 抓真窗口：IsWindowVisible 守卫 + PrintWindow 落 PNG，tick 用 Post 翻页', () => {
    const shotNow = fnBody(uiNsh, 'DshShotNow')
    const shotTick = fnBody(uiNsh, 'DshShotTick')
    expect(shotNow).toContain('user32::IsWindowVisible(p $HWNDPARENT) i.r0')
    expect(shotNow).toContain('user32::PrintWindow(p $HWNDPARENT, p $DshShotHdc, i 2)')
    expect(shotNow).toContain(
      String.raw`!insertmacro DshSaveBitmapPng $DshShotBitmap "$DshShotDir\$DshShotName.png"`,
    )
    // 0x408 是同步翻页：定时器回调里 SendMessage 会重入 nsDialogs::Show ⇒ 必须 Post
    expect(shotTick).toContain('user32::PostMessageW(p $HWNDPARENT, i 0x408, i 1, i 0)')
    expect(shotTick).not.toContain('SendMessage $HWNDPARENT')
  })
})

// ── #89 明暗主题：系统探测 + /THEME= 覆盖 + 两套调色板 ───────────────────────
describe('NSIS 明暗主题（#89）', () => {
  test('主题来自系统（AppsUseLightTheme）或 /THEME= 覆盖，非法值报警退出', () => {
    expect(themeNsh).toContain(
      String.raw`ReadRegDWORD $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" "AppsUseLightTheme"`,
    )
    expect(themeNsh).toContain('${GetParameters} $0')
    expect(themeNsh).toContain('${GetOptions} $0 "/THEME=" $1')
    for (const value of ['light', 'dark', 'auto']) {
      expect(themeNsh).toContain(`$1 == "${value}"`)
    }
    expect(themeNsh).toMatch(/\$\{Else\}[\s\S]*?MessageBox MB_OK\|MB_ICONEXCLAMATION "\$\(DSH_TEXT_THEME_ERROR\)"/)
    expect(themeNsh).toMatch(/\$\(DSH_TEXT_THEME_ERROR\)[\s\S]*?SetErrorLevel 2[\s\S]*?Quit/)
    // 只有 auto 才读注册表；0 = 深色、读不到 = 浅色（官方 theme.nsh 同款取向）
    expect(themeNsh).toMatch(/\$\{If\} \$DshTheme == "auto"[\s\S]*?ReadRegDWORD/)
    expect(themeNsh).toMatch(/\$\{If\} \$\{Errors\}[\s\S]*?StrCpy \$DshTheme "light"/)
    expect(themeNsh).toMatch(/\$\{ElseIf\} \$0 == 0[\s\S]*?StrCpy \$DshTheme "dark"/)
    // 解析完就落调色板；ui.nsh 只按 $DshTheme 分支（颜色值全部来自 theme.nsh）
    expect(themeNsh).toMatch(/Function DshResolveTheme[\s\S]*?Call DshApplyPalette/)
    expect(uiNsh).toContain('${If} $DshTheme == "dark"')
    // 真机路径：.onGUIInit → DshUiInit 里 Call DshResolveTheme，在任何 HideWindow/自绘/字体之前
    // —— 调色板必定在第一次绘制前填好（比索引，顺序错了就是真机一片空颜色）
    const themeAt = uiInitFn.indexOf('Call DshResolveTheme')
    expect(themeAt).toBeGreaterThan(-1)
    expect(themeAt).toBeLessThan(uiInitFn.indexOf('HideWindow'))
    expect(themeAt).toBeLessThan(uiInitFn.indexOf('!insertmacro DshPixelFont'))
    expect(themeAt).toBeLessThan(uiInitFn.indexOf('SetWindowPos'))
  })

  test('两套调色板（ARGB + COLORREF）齐备，SetCtlColors 落到对话框/输入框且颜色不带 0x 前缀', () => {
    // 深/浅两套都写：ARGB 给 GDI+ 填充，COLORREF 给 GDI 文字/画笔（0x00BBGGRR，字节序反过来）
    expect(themeNsh).toMatch(
      /\$\{If\} \$DshTheme == "dark"[\s\S]*?StrCpy \$DshBgArgb 0xFF141417[\s\S]*?\$\{Else\}[\s\S]*?StrCpy \$DshBgArgb 0xFFFFFFFF/,
    )
    expect(themeNsh).toContain('StrCpy $DshBgColorref 0x00171414') // #141417 的 COLORREF
    expect(themeNsh).toContain('StrCpy $DshBgColorref 0x00FFFFFF') // #FFFFFF 的 COLORREF
    // 两套色板不许串：ARGB 一律 0xFF 不透明前缀、COLORREF 一律 0x00（深/浅各 13 + 7 条）
    const argb = [...themeNshCode.matchAll(/StrCpy \$(Dsh\w+Argb) (0x[0-9A-Fa-f]{8})/g)]
    expect(argb.length).toBe(26)
    for (const [, name, value] of argb) expect(`${name ?? ''}=${value ?? ''}`).toMatch(/Argb=0xFF/)
    const colorref = [...themeNshCode.matchAll(/StrCpy \$(Dsh\w+Colorref) (0x[0-9A-Fa-f]{8})/g)]
    expect(colorref.length).toBe(14)
    for (const [, name, value] of colorref) expect(`${name ?? ''}=${value ?? ''}`).toMatch(/Colorref=0x00/)
    // 真控件里还在用 SetCtlColors 的两处：路径输入框与进度页内层对话框；颜色是编译期常量、不带 0x
    expect(uiNsh).toMatch(
      /\$\{If\} \$DshTheme == "dark"\s+SetCtlColors \$DshEdit F2F3F5 1E1E23\s+\$\{Else\}\s+SetCtlColors \$DshEdit 0F1115 F3F4F7/,
    )
    expect(uiNsh).toMatch(/SetCtlColors \$R8 F2F3F5 141417/) // 进度页内层 IDD_INSTFILES（深）
    expect(uiNsh).toMatch(/SetCtlColors \$R8 0F1115 FFFFFF/) // （浅）
    expect(uiNshCode).not.toMatch(/SetCtlColors [^\n]*0x[0-9A-Fa-f]{6}/) // 0x 前缀会被 ParseCtlColor 截断
    // 品牌瓦片也跟主题走：四张（1x/2x × 明暗）都要解出来并能释放
    expect(themeNsh).toContain('StrCpy $DshWhaleFile "$PLUGINSDIR\\whale-dark.bmp"')
    expect(themeNsh).toContain('StrCpy $DshWhaleFile "$PLUGINSDIR\\whale.bmp"')
  })

  test('进度页：stock instfiles 页撑满窗口，stock 进度条/状态文本按设计稿位置与颜色落位', () => {
    expect(uiNsh).toMatch(
      /Function DshProgressShow[\s\S]*?GetWindow\(p \$R7, i 5\)[\s\S]*?GetDlgItem \$R2 \$R1 1004[\s\S]*?DshPlace \$R8 0 0 \$\{DSH_WINDOW_SIZE\} \$\{DSH_WINDOW_SIZE\}/,
    )
    // 1004/1006 从内页子对话框句柄 $0 取：从外层 $HWNDPARENT 取只会拿到空句柄
    // （Wine 实测：进度条停在默认位、状态文本跑到顶部）
    expect(progressFn).toMatch(/GetDlgItem \$R5 \$R8 1004/)
    expect(progressFn).toMatch(/GetDlgItem \$R5 \$R8 1006/)
    // 进度条槽位常量单源在 ui.nsh，不允许再有一套 DSH_BAR_*
    expect(uiNsh).toContain('!define DSH_STOCK_BAR_Y 452')
    expect(uiNsh).toContain('!define DSH_STOCK_BAR_H 8')
    expect(uiNsh).not.toMatch(/!define DSH_BAR_/)
    // 状态行（1006）落在设计稿的状态行上，槽位常量同样单源
    expect(uiNsh).toContain('!define DSH_STATUS_Y 476')
    // 进度条两套颜色：PBM_SETBKCOLOR 0x408 / PBM_SETBARCOLOR 0x409（0x2001 是 SETRANGE32，会把量程清零）
    expect(uiNsh).toContain('SendMessage $R5 0x0408 0 0x2C2C33') // 深：槽
    expect(uiNsh).toContain('SendMessage $R5 0x0409 0 0x4D6BFE') // 深：条（强调色）
    expect(uiNsh).toContain('SendMessage $R5 0x0408 0 0xE7E9EE') // 浅：槽
    expect(uiNsh).toContain('SendMessage $R5 0x0409 0 0x4D6BFE') // 浅：条
    // v6 主题化控件无视 PBM 配色与 SetCtlColors：先 uxtheme::SetWindowTheme(" ") 剥主题（回退路径用）
    expect(uiNsh).toContain('uxtheme::SetWindowTheme(p $R5, w " ", w "")')
    expect(uiNsh).toContain('uxtheme::SetWindowTheme(p $DshCancel, w " ", w "")')
  })

describe('NSIS 真 DPI 布局与语言覆盖（真机 200% DPI 实锤）', () => {
  test('每个控件创建后都 DshPlace（MulDiv+MoveWindow）：只放大窗口不摆控件=挤在左上角', () => {
    for (const call of [
      'DshPlace $DshTile ${DSH_TILE_X}',
      'DshPlace $DshAppName ${DSH_APPNAME_X}',
      'DshPlace $DshHeadline ${DSH_HEADLINE_X} ${DSH_HEADLINE_Y}',
      'DshPlace $DshSubtitle ${DSH_SUBTITLE_X}',
      'DshPlace $DshCard ${DSH_CARD_X}',
      'DshPlace $DshEdit ${DSH_EDIT_X}',
      'DshPlace $DshBrowse ${DSH_BROWSE_X}',
      'DshPlace $DshMain ${DSH_MAIN_X}',
      'DshPlace $DshCheck ${DSH_CHECK_X}',
      'DshPlace $DshSwitch ${DSH_SWITCH_X}',
    ]) {
      expect(uiNsh).toContain(`!insertmacro ${call}`)
    }
  })

  test('进度页内页句柄不存 $0（DshPlace 覆写 $0-$3，runner 实证 child 被冲成 0=stock 布局）', () => {
    const progress = fnBody(uiNsh, 'DshProgressShow')
    expect(progress).toContain('StrCpy $R8 $HWNDPARENT')
    expect(progress).toContain('GetDlgItem $R5 $R8 1006')
    expect(progress).not.toMatch(/GetDlgItem \$[0-3] \$R8 100[46]/)
    expect(progress).not.toMatch(/DshPlace \$[0-3] \$\{DSH_(STOCK_BAR|STATUS)_/)
  })

  test('/LANG=zh|en 显式覆盖语言（检测=UI 语言→区域，en-US 真机走英文）', () => {
    expect(script).toContain('\\${GetOptions} $CMDLINE "/LANG=" $DshError')
    expect(script).toContain('StrCpy $LANGUAGE 2052')
  })
})
})

// ── #88 压缩 + 国际化：LZMA 固体压缩 + LangString 双语表 ─────────────────────
describe('NSIS 压缩与国际化（#88）', () => {
  test('压缩回退 zlib 默认（用户真机拍板解压速度优先）；解压=「安装文件」阶段（Stage=1 先于 File /r）', () => {
    expect(script).not.toContain('SetCompressor /FINAL /SOLID lzma')   // lzma 固体解压慢数倍，体积代价换速度（原 #88 实测留档 issue #88）
    const stageAt = script.indexOf('w "HarnessInstaller.Stage", p 1)')
    const fileAt = script.indexOf('File /r "${nsiEscape(packDir)}')
    expect(stageAt).toBeGreaterThan(0)
    expect(fileAt).toBeGreaterThan(stageAt)   // 解压期间进度条走「安装文件」阶段，不会假死在「准备 2%」
  })

  test('语言表装载：LoadLanguageFile 双语（不用 MUI2），四个脚本按序 include', () => {
    expect(stringsNsh).toContain('LoadLanguageFile "${NSISDIR}\\Contrib\\Language files\\SimpChinese.nlf"')
    expect(stringsNsh).toContain('LoadLanguageFile "${NSISDIR}\\Contrib\\Language files\\English.nlf"')
    // 不用 MUI2：它自带的 .onGUIInit 会与本安装器的同名回调撞车，且在无 MUI 页时告警
    for (const text of [stringsNsh, uiNsh, themeNsh, drawingNsh]) {
      expect(text).not.toContain('MUI2.nsh')
    }
    // 先装载语言、再 LangString（LangString 要求该语言已装载）
    expect(stringsNsh.indexOf('LoadLanguageFile')).toBeLessThan(stringsNsh.indexOf('LangString DSH_TEXT_'))
    // 构建侧钉住解码与「漏译文」：-WX 把 warning 6040（缺一门译文 ⇒ 运行期空串）当错误；
    // /INPUTCHARSET UTF8 显式声明按 UTF-8 解码（四个 .nsh 都没有 BOM，BOM 是按文件生效的）
    expect(script).toContain("process.platform === 'win32' ? '/' : '-'")
    expect(script).toContain('${makensisDash}WX')
    expect(script).toContain('${makensisDash}INPUTCHARSET')
    expect(script).toContain("'UTF8'")
    // 语言不靠系统猜：产品中文优先，默认简中；需要英文用 /LANG=en（.onInit 在调用后解析）
    expect(stringsNsh).toContain('StrCpy $LANGUAGE ${DSH_LANG_ID_SIMPCHINESE}')
    expect(stringsNsh).toContain('!define DSH_LANG_ID_ENGLISH 1033')
    expect(stringsNsh).toContain('!define DSH_LANG_ID_SIMPCHINESE 2052')
    expect(script).toMatch(/Function \.onInit\s+Call DshResolveLanguage/)
    // #103：四个脚本的 include 顺序 = 文案 → 主题 → 绘制 → 交互（依赖方向）
    const includeOrder = ['stringsNshPath', 'themeNshPath', 'drawingNshPath', 'uiNshPath']
    // script 是构建脚本源码（.nsi 是其中的模板字面量），include 行长这样：!include "${nsiEscape(stringsNshPath)}"
    const includeAt = includeOrder.map((variable) => script.indexOf(`!include "\${nsiEscape(${variable})}"`))
    for (const at of includeAt) expect(at).toBeGreaterThan(-1)
    expect(includeAt).toEqual([...includeAt].sort((a, b) => a - b))
    expect(script).toContain("const stringsNshPath = join(projectRoot, 'installer', 'strings.nsh')")
  })

  test('用户可见字符串全部走语言变量，旧的硬编码中文名不再出现', () => {
    expect(script).toContain('"DisplayName" "$(DSH_TEXT_APP_NAME)"')
    expect(script).toContain('$(DSH_TEXT_UNINSTALL_SHORTCUT).lnk')
    expect(script).toContain('$(DSH_TEXT_LEGACY_TITLE)')
    expect(script).toContain('$(DSH_TEXT_INSTALL_FAILED)')
    expect(script).toContain('$(DSH_TEXT_RUNNING_UNINSTALL)')
    expect(script).not.toContain('卸载.lnk')
  })

  test('拼接运行期变量的文案不进 LangString（DONE_BODY = 文案 + $INSTDIR）', () => {
    expect(uiNsh).toContain('"$(DSH_TEXT_DONE_BODY) $INSTDIR"')
    expect(finishFn).toMatch(/\$\{NSD_CreateLabel\} \$\{DSH_HEADLINE_X\} \$\{DSH_DONE_BODY_Y\}[^"]*"\$\(DSH_TEXT_DONE_BODY\) \$INSTDIR"/)
    expect(stringsNsh).toContain('LangString DSH_TEXT_DONE_BODY ${LANG_ENGLISH} "Installed to"')
    expect(stringsNsh).toContain('LangString DSH_TEXT_DONE_BODY ${LANG_SIMPCHINESE} "已安装到"')
    expect(stringsNsh).not.toMatch(/LangString[^\n]*\$INSTDIR/)
  })

  test('生成器拦在缺 strings.nsh 之前', () => {
    expect(script).toContain('const stringsNshPath = join(')
    expect(script).toContain('缺多语言文案表')
    expect(script).toContain('bun run prepare:installer-assets') // 品牌图守卫仍在
  })

  test('XPStyle on + ManifestDPIAware：无 v6 清单 BUTTON 不发 NM_CUSTOMDRAW、无 dpiAware 清单全局被 DWM 拉虚（真机实锤）', () => {
    expect(script).toContain('XPStyle on')
    expect(script).toContain('ManifestDPIAware true')
  })

  test('窗钮字形随创建携带、选目录初始路径守卫、输入框圆角框贴图、可用空间探测（原型对齐）', () => {
    expect(uiNsh).toContain('"−"')
    expect(uiNsh).toContain('"×"')
    expect(uiNsh).toContain('nsDialogs::SelectFolderDialog "$(DSH_TEXT_CHOOSE_PATH)" ""')
    // 构建身份：trace 文件名带 commit（多轮验证循环里不可能拿错新旧包）
    expect(script).toContain('@@BUILD_ID@@')
    expect(script).toContain("replaceAll('@@BUILD_ID@@', buildId)")
    expect(uiNsh).toContain('$DshPath\\*.*')
    expect(uiNsh).toContain('!insertmacro DshDrawEditFrame')
    expect(uiNsh).toContain('GetDiskFreeSpaceExW')
    // 可用空间换算：GB = hi*4 + floor(lo/2^30)（2^32/2^30=4）。
    // 历史回归两连：Int64Op 大字面量版把 28.9 GB 算成 30297728（恰为 KB）；系数 4096 版把
    // 605 GB 算成 619616（恰为 MiB）——系数与寄存器一律钉死。
    expect(uiNsh).toContain('IntOp $2 $R5 * 4')
    expect(uiNsh).toContain('IntOp $3 $R4 / 1073741824')
    expect(uiNsh).toContain('IntOp $1 $2 + $3')
    expect(uiNsh).not.toContain('IntOp $2 $r5 * 4096')
    expect(uiNsh).not.toContain('System::Int64Op $r5 * 4294967296')
    // Win11 圆角：DWMWA_WINDOW_CORNER_PREFERENCE(33) → ROUND(2)（纯 NSIS 能拿到的唯一圆角）
    expect(uiNsh).toContain('dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, p $0, i 4)')
    // 品牌文案：产品是 DeepSeek Harness DesktopBUN，不用「桌面版/ Desktop」措辞
    expect(stringsNsh).not.toContain('DeepSeek Harness 桌面版')
    expect(stringsNsh).not.toContain('"DeepSeek Harness Desktop"')
    expect(stringsNsh).toContain('DeepSeek Harness DesktopBUN')
  })
})
