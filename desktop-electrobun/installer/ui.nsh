/*
 * 自定义安装界面（#103，2026-10-16 重构）——对齐官方骨架，样式换成我们的：
 *
 *   · 官方机制：nsDialogs 真控件 + NM_CUSTOMDRAW owner-draw（drawing.nsh painter）
 *     + 预渲染位图资产（NSD_SetStretchedImage，官方品牌图同款）+ SetCtlColors 两套主题。
 *     全部是身经百战的显示路径。
 *   · 整页位图 + 大 static 的自创路线已废弃：位图双选、少参创建、方向反……
 *     五个真机白板根因全部长在那条路上，而且它导致「出图路径 ≠ 显示路径」。
 *   · 截图验证 = PrintWindow 抓真窗口（抓的就是显示路径本身，所见即所验）。
 *
 * 依赖（主 .nsi 必须先 !include）：strings.nsh → theme.nsh → drawing.nsh → 本文件；
 * 以及主 .nsi 提供的宏：DSH_INSTALLER_ASSETS、DSH_APP_NAME、DSH_APP_EXE。
 */

!ifndef DSH_INSTALLER_UI
!define DSH_INSTALLER_UI

!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"
${Using:StrFunc} StrStr

!define DSH_WINDOW_SIZE 600
!define WM_NOTIFY_OUTER_NEXT 0x408 ; 通知外层页面「前进」（NSIS 内部消息，官方同款）

; 标题栏：拖动条 + 窗口按钮（设计稿：瓦片在最左，窗口按钮 44×44 贴右）
!define DSH_DRAG_X 58
!define DSH_DRAG_Y 0
!define DSH_DRAG_W 440
!define DSH_DRAG_H 44
!define DSH_MIN_X 512
!define DSH_WINBTN_Y 0
!define DSH_WINBTN_W 44
!define DSH_WINBTN_H 44
!define DSH_HEADER_X 16
!define DSH_HEADER_Y 12
!define DSH_HEADER_W 400
!define DSH_HEADER_H 20
; 欢迎页几何（原型 docs/design/windows-installer-ui-prototype.html）
!define DSH_TILE_X 32
!define DSH_TILE_Y 44
!define DSH_TILE_W 44
!define DSH_TILE_H 44
!define DSH_APPNAME_X 88
!define DSH_APPNAME_Y 52
!define DSH_APPNAME_W 400
!define DSH_APPNAME_H 24
!define DSH_HEADLINE_X 32
!define DSH_HEADLINE_Y 136
!define DSH_HEADLINE_W 536
!define DSH_HEADLINE_H 48
!define DSH_SUBTITLE_X 32
!define DSH_SUBTITLE_Y 192
!define DSH_SUBTITLE_W 536
!define DSH_SUBTITLE_H 44
; 「安装位置」卡片：预渲染 card.bmp（surface+1px 边框+圆角 14）
!define DSH_CARD_X 32
!define DSH_CARD_Y 248
!define DSH_CARD_W 536
!define DSH_CARD_H 140    ; 卡片高度=内容（位置行+输入行+提示行+内边距），220 会留一大片空白
!define DSH_LOCATION_X 48
!define DSH_LOCATION_Y 268
!define DSH_LOCATION_W 300
!define DSH_LOCATION_H 22
!define DSH_EDIT_X 48
!define DSH_EDIT_Y 298
!define DSH_EDIT_W 392
!define DSH_EDIT_H 40
; 输入框圆角框：比 edit 四周大 4 逻辑像素（官方 InstallerDrawEditFrame 同款机制）
!define /math DSH_EDITFRAME_X ${DSH_EDIT_X} - 4
!define /math DSH_EDITFRAME_Y ${DSH_EDIT_Y} - 4
!define /math DSH_EDITFRAME_W ${DSH_EDIT_W} + 8
!define /math DSH_EDITFRAME_H ${DSH_EDIT_H} + 8
!define DSH_BROWSE_X 456
!define DSH_BROWSE_Y 298
!define DSH_BROWSE_W 96
!define DSH_BROWSE_H 40
!define DSH_HINT_X 48
!define DSH_HINT_Y 354
!define DSH_HINT_W 440
!define DSH_HINT_H 22
!define DSH_MAIN_X 32
!define DSH_MAIN_Y 486
!define DSH_MAIN_W 536
!define DSH_MAIN_H 48
; 取消：主按钮下方居中的文字次按钮（owner-draw ghost）
!define DSH_CANCELBTN_X 32    ; 与主按钮同宽（用户要求底部两按钮一致）
!define DSH_CANCELBTN_Y 544
!define DSH_CANCELBTN_W 536
!define DSH_CANCELBTN_H 40
!define DSH_FREE_X 316       ; 卡片右上「可用 N GB」
!define DSH_FREE_W 236
 

; 进度页：stock 进度条（1004）摆到设计稿的槽上，状态文本（1006）摆到状态行
!define DSH_STOCK_BAR_X 32
!define DSH_STOCK_BAR_Y 452
!define DSH_STOCK_BAR_W 536
!define DSH_STOCK_BAR_H 8
!define DSH_STATUS_X 32
!define DSH_STATUS_Y 476
!define DSH_STATUS_W 536
!define DSH_PROGRESS_CANCEL_X 32
!define DSH_PROGRESS_CANCEL_Y 520
; 完成页控件
; 完成页几何：大勾 64×64、标题/正文、立即启动开关、完成按钮
!define DSH_CHECK_X 32
!define DSH_CHECK_Y 150
!define DSH_CHECK_W 64
!define DSH_CHECK_H 64
!define DSH_DONE_HEADLINE_Y 238
!define DSH_DONE_BODY_Y 292
!define DSH_DONE_BODY_W 536
!define DSH_DONE_BODY_H 64
!define DSH_SWITCH_X 48
!define DSH_SWITCH_Y 428
!define DSH_SWITCH_W 44
!define DSH_SWITCH_H 24
!define DSH_DONE_X 32
!define DSH_DONE_Y 486
!define DSH_DONE_W 536
!define DSH_DONE_H 48
!define DSH_BUTTON_FONT_SIZE 15
!define DSH_BODY_FONT_SIZE 13
!define DSH_TITLE_FONT_SIZE 26
!define DSH_HINT_FONT_SIZE 12
Var DshDialog       ; 当前页的 nsDialogs 对话框
Var DshWindowSize   ; 600 逻辑像素换算成像素后的窗口边长
Var DshEdit
Var DshEditFrame   ; 输入框圆角框位图 static
Var DshHeaderLabel ; 页眉小标题（每页 SetText 换文案）
Var DshFreeLabel  ; 卡片右上「可用 N GB」
Var DshCancelBtn  ; 欢迎页取消（文字次按钮）
Var DshMain
Var DshSwitch
Var DshCancel
Var DshMinBtn
Var DshCloseBtn
Var DshDrag
; 位图控件与 NSD_SetStretchedImage 的句柄（页面退出时 NSD_FreeImage）
Var DshTile
Var DshTileImage
Var DshCard
Var DshCardImage
Var DshCheck
Var DshCheckImage
; 文本控件
Var DshAppName
Var DshHeadline
Var DshSubtitle
Var DshLocationLabel
Var DshHint
Var DshPlaceHwnd    ; DshPlace 的暂存：MulDiv 会写 $0..$3，句柄必须先存起来
Var DshLaunchWanted ; 完成页是否勾了「立即启动」
Var DshPath         ; 安装位置（校验通过后写回 $INSTDIR）
Var DshError        ; 路径校验错误（空 = 没错）
Var DshShotDir        ; --shot=<目录>：每页 PrintWindow 抓真窗口落 PNG（诊断/视觉回归）
Var DshShotName       ; 当前截图文件名（不带扩展名）
Var DshShotAdvance    ; 截图后是否自动翻页（1 = 给 welcome/finish 用）
Var DshShotBitmap     ; PrintWindow 的目标位图
Var DshShotHdc
!ifdef DSH_WINDOW_FRAME_DLL
Var DshProgressWindow ; 进度覆盖层窗口（由 DSH_WINDOW_FRAME_DLL 提供，无 DLL 时为空）
!endif
; 四档字体（pages.nsh 删除后由本文件持有；painter 用的是 $DshFont/$DshSmallFont 别名）
Var DshFontButton
Var DshFontBody
Var DshFontTitle
Var DshFontHint
; 诊断用：把一行进度追加到 $TEMP\dsh-trace.txt（临时手段，定位完就摘）。
; 写 $TEMP 而不是 --shot 目录：窗口还没建、$DshShotDir 还没解析时的早期步骤也要能留痕。
; $9 是 NSIS 的备用寄存器，页面代码不用它。
!macro DshShotTrace TEXT
  ; FileOpen 的 'a' 模式不会新建文件：文件不存在时会失败，后续 FileWrite 直接把安装器搞崩。
  ; 只在 --shot 诊断模式下留痕：正常安装与卸载不受影响。
  ${If} $DshShotDir != ""
    ; 持久句柄：.onInit 里开一次，每行只 FileWrite（实测逐行 FileOpen 会互相覆盖、丢行）
    ${If} $DshTraceFile != ""
      FileWrite $DshTraceFile "${TEXT}$\r$\n"
    ${EndIf}
  ${EndIf}
!macroend

; ── 页面截图（诊断用）：--shot=<目录> 时每页把自绘位图落成 PNG ──
; 用途：验证「真页面回调 + 真绘制」这条链路（/PREVIEW 走的是另一条路，验不到真页面）。
; 2026-10-16 的教训：只验 /PREVIEW 就交付，漏掉「真路径没启动 GDI+」，用户拿到一块白板。
; 走的是与手动安装完全相同的页面代码，Wine 与真机都能用。
!macro DshArmShotTimer NAME ADVANCE
  ${If} $DshShotDir != ""
    StrCpy $DshShotName "${NAME}"
    StrCpy $DshShotAdvance "${ADVANCE}"
    ${NSD_CreateTimer} DshShotTick 700
  ${EndIf}
!macroend

/** 抓当前窗口 → PNG（PrintWindow = 抓显示路径本身）。$DshShotName 由调用方先设好。 */
Function DshShotNow
  ${If} $DshShotDir == ""
    Return
  ${EndIf}
  ; 窗口还没显示（页面还在 nsDialogs::Show 之前）时 PrintWindow 抓到的是空客户区——
  ; welcome/finish 的直接调用会踩中，那时跳过，交给 700ms 后的 DshShotTick（页面已可见）。
  System::Call 'user32::IsWindowVisible(p $HWNDPARENT) i.r0'
  ${If} $r0 == 0
    StrCpy $8 "shot: $DshShotName skipped (window hidden)"
    !insertmacro DshShotTrace "$8"
    Return
  ${EndIf}
  !insertmacro DshCreateBitmapDC ${DSH_WINDOW_SIZE} ${DSH_WINDOW_SIZE} $DshShotBitmap $DshShotHdc
  ; PW_RENDERFULLCONTENT(2)：连 GDI+ 混合内容一起抓（Win8.1+；Wine 已实现）
  System::Call 'user32::PrintWindow(p $HWNDPARENT, p $DshShotHdc, i 2)'
  ; 地面真值：直接从屏幕读两个采样点（标题区/主按钮区），与 PrintWindow 的结果互证——
  ; 若屏幕上有字而截图没有，就是抓图路径的问题；两边都空才是真白板。
  ${If} $DshTraceFile != ""
    System::Call 'user32::GetDC(p 0) p.r0'
    System::Call 'kernel32::MulDiv(i 60, i $DshDpi, i 96) i.r1'
    System::Call 'kernel32::MulDiv(i 150, i $DshDpi, i 96) i.r2'
    System::Call 'gdi32::GetPixel(p r0, i r1, i r2) i.r3'
    System::Call 'kernel32::MulDiv(i 300, i $DshDpi, i 96) i.r1'
    System::Call 'kernel32::MulDiv(i 510, i $DshDpi, i 96) i.r2'
    System::Call 'gdi32::GetPixel(p r0, i r1, i r2) i.r4'
    System::Call 'user32::ReleaseDC(p 0, p r0)'
    FileWrite $DshTraceFile "pixel: headline=0x$3 main=0x$4$\r$\n"
  ${EndIf}
  !insertmacro DshSaveBitmapPng $DshShotBitmap "$DshShotDir\$DshShotName.png"
  StrCpy $8 "shot: $DshShotName status=$DshSaveStatus dir=$DshShotDir"
  !insertmacro DshShotTrace "$8"
  DetailPrint "截图：$DshShotDir\$DshShotName.png（状态 $DshSaveStatus）"
  !insertmacro DshReleaseBitmapDC $DshShotBitmap $DshShotHdc
FunctionEnd

Function DshShotTick
  ${NSD_KillTimer} DshShotTick
  StrCpy $8 "tick: $DshShotName"
  !insertmacro DshShotTrace "$8"
; 控件探针：hwnd / 可见性 / 文本长度 / 字体句柄（仅 --shot 模式，定位「创建了但不画」类问题）
!macro DshCtlProbe TAG HWND
  ${If} $DshShotDir != ""
    ${If} $DshTraceFile != ""
      System::Call 'user32::IsWindowVisible(p ${HWND}) i.s'
      Pop $R7
      System::Call 'user32::GetWindowTextLengthW(p ${HWND}) i.s'
      Pop $R8
      System::Call 'user32::SendMessageW(p ${HWND}, i 0x0031, i 0, i 0) i.s'
      Pop $R9
      StrCpy $R5 "probe: ${TAG} hwnd=${HWND} vis=$R7 textlen=$R8 font=$R9"
      FileWrite $DshTraceFile "$R5$\r$\n"
    ${EndIf}
  ${EndIf}
!macroend
  ${If} $DshShotAdvance == "1"
    ; 等价于点「下一步 / 完成」：让 /SHOT 模式自己走完三页。
    ; 必须 Post：0x408 是同步翻页，在定时器回调里 SendMessage 会重入 nsDialogs::Show
    ; 的消息泵 ⇒ 页面回调嵌套 ⇒ access violation（Wine 与 CI 真机同样崩，0xC0000005）。
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i 0x408, i 1, i 0)'
  ${EndIf}
FunctionEnd
; ── 落位：逻辑像素 → 当前 DPI 像素（官方 InstallerPlace 同款）──
; i.r0..i.r3 就是 $0..$3，句柄会被 MulDiv 结果冲掉 ⇒ 先把句柄存进专用 var（#89 的教训）。
!macro DshPlace HWND X Y W H
  StrCpy $DshPlaceHwnd ${HWND}
  System::Call 'kernel32::MulDiv(i ${X}, i $DshDpi, i 96) i.r0'
  System::Call 'kernel32::MulDiv(i ${Y}, i $DshDpi, i 96) i.r1'
  System::Call 'kernel32::MulDiv(i ${W}, i $DshDpi, i 96) i.r2'
  System::Call 'kernel32::MulDiv(i ${H}, i $DshDpi, i 96) i.r3'
  System::Call 'user32::MoveWindow(p $DshPlaceHwnd, i r0, i r1, i r2, i r3, i 1)'
!macroend

; ── z 序提升：Win32 子窗口后建者落在 z 序底部，会被先建且重叠的位图盖住 ──
; （卡片位图盖住卡片内控件 = 真机必现）；HWND_TOP(0)+NOMOVE|NOSIZE|NOACTIVATE(0x53）
!macro DshTopWindow HWND
  System::Call 'user32::SetWindowPos(p ${HWND}, p 0, i 0, i 0, i 0, i 0, i 0x53)'
!macroend

; 输入框圆角框：官方 InstallerDrawEditFrame 同款——GDI+ 画一张 1px 边框位图（底色跟卡片表面融合）
; 用 STM_SETIMAGE 贴在 static 上；edit 本体的 classic/themed 边框在创建后剥掉（官方同款 GetWindowLongW 掩码）
!macro DshDrawEditFrame
  System::Call 'kernel32::MulDiv(i ${DSH_EDITFRAME_W}, i $DshDpi, i 96) i.R5'
  System::Call 'kernel32::MulDiv(i ${DSH_EDITFRAME_H}, i $DshDpi, i 96) i.R6'
  System::Call 'gdiplus::GdipCreateBitmapFromScan0(i R5, i R6, i 0, i 0x26200A, i 0, *p .s)'
  Pop $R4                                            ; GpBitmap（用完即弃，HBITMAP 是拷贝）
  System::Call 'gdiplus::GdipGetImageGraphicsContext(p $R4, *p .s)'
  Pop $R7
  System::Call 'gdiplus::GdipGraphicsClear(p R7, i $DshSurfaceArgb)'
  System::Call 'gdiplus::GdipSetSmoothingMode(p R7, i 4)'
  !insertmacro DshRoundPath $2 $R5 $R6 24            ; r12 逻辑像素；位图是设备像素，直接给弧径
  System::Call 'gdiplus::GdipCreatePen1(i $DshBorderArgb, i 0x3F800000, i 2, *p .s)'
  Pop $3
  System::Call 'gdiplus::GdipDrawPath(p R7, p $3, p $2)'
  System::Call 'gdiplus::GdipDeletePen(p $3)'
  System::Call 'gdiplus::GdipDeletePath(p $2)'
  System::Call 'gdiplus::GdipDeleteGraphics(p R7)'
  System::Call 'gdiplus::GdipCreateHBITMAPFromBitmap(p $R4, *p .s, i $DshSurfaceArgb)'
  Pop $R8
  SendMessage $DshEditFrame ${STM_SETIMAGE} ${IMAGE_BITMAP} $R8
  System::Call 'gdiplus::GdipDisposeImage(p $R4)'
!macroend

; ── 品牌瓦片：整页自绘要用到，进页面之前先解到 $PLUGINSDIR ──
!macro DshReleaseBrandFiles
  File "/oname=$PLUGINSDIR\whale.bmp" "${DSH_INSTALLER_ASSETS}\whale.bmp"
  File "/oname=$PLUGINSDIR\whale-dark.bmp" "${DSH_INSTALLER_ASSETS}\whale-dark.bmp"
  File "/oname=$PLUGINSDIR\whale-2x.bmp" "${DSH_INSTALLER_ASSETS}\whale-2x.bmp"
  File "/oname=$PLUGINSDIR\whale-dark-2x.bmp" "${DSH_INSTALLER_ASSETS}\whale-dark-2x.bmp"
  File "/oname=$PLUGINSDIR\card.bmp" "${DSH_INSTALLER_ASSETS}\card.bmp"
  File "/oname=$PLUGINSDIR\card-dark.bmp" "${DSH_INSTALLER_ASSETS}\card-dark.bmp"
  File "/oname=$PLUGINSDIR\card-2x.bmp" "${DSH_INSTALLER_ASSETS}\card-2x.bmp"
  File "/oname=$PLUGINSDIR\card-dark-2x.bmp" "${DSH_INSTALLER_ASSETS}\card-dark-2x.bmp"
  File "/oname=$PLUGINSDIR\check-circle.bmp" "${DSH_INSTALLER_ASSETS}\check-circle.bmp"
  File "/oname=$PLUGINSDIR\check-circle-dark.bmp" "${DSH_INSTALLER_ASSETS}\check-circle-dark.bmp"
  File "/oname=$PLUGINSDIR\check-circle-2x.bmp" "${DSH_INSTALLER_ASSETS}\check-circle-2x.bmp"
  File "/oname=$PLUGINSDIR\check-circle-dark-2x.bmp" "${DSH_INSTALLER_ASSETS}\check-circle-dark-2x.bmp"
!macroend

/**
 * .onGUIInit：无边框品牌窗 + DPI + 居中 + 藏掉所有原生 stock 控件。
 * 之后所有页面都是「自绘整页 + 少量自绘控件」，没有原生外观混在里面。
 */
Function .onGUIInit
  Call DshUiInit
FunctionEnd

Function DshUiInit
  StrCpy $DshOuterWin $HWNDPARENT       ; 外层主窗：instfiles 的 show 回调里 $HWNDPARENT 会变成内页，先存一份
  StrCpy $DshError ""
  StrCpy $8 "uiinit: entered"
  !insertmacro DshShotTrace "$8"
  StrCpy $DshLaunchWanted "0"
  ; 先解析主题（/THEME= 或注册表）→ 填两套调色板；不调用的话自绘拿到的是空颜色变量
  Call DshResolveTheme
  StrCpy $8 "uiinit: theme resolved=$DshTheme"
  !insertmacro DshShotTrace "$8"
  ; 官方同款：DWM 圆角/阴影 + 客户区吞掉非客户区（有 DLL 时；无 DLL 已有手写 DwmSetWindowAttribute）
!ifdef DSH_WINDOW_FRAME_DLL
  System::Call '${DSH_WINDOW_FRAME_DLL}::InstallerApplyFrame(p $HWNDPARENT) i.r0 ?c'
!endif
  ; $PLUGINSDIR 必须先初始化：品牌瓦片靠 DshBuildPageChrome 里的 File 指令解到这里，
  ; 没初始化时 File 静默失败，标题栏就是空的（真机踩到过）。
  InitPluginsDir
  ; GDI+ 必须先启动：整页位图与全部自绘原语都走 gdiplus::*；漏了这一步，所有 Gdip 调用静默失败、
  ; 页面渲染成一块白板 + 原生控件——「没有任何自定义样式」的真身。
  !insertmacro DshGdiplusStartup
  StrCpy $8 "uiinit: theme=$DshTheme brand=$DshBrandPrefix token=$DshGdiToken dpi=$DshDpi"
  !insertmacro DshShotTrace "$8"
  ; --shot=<目录>：真窗口截图模式（仅诊断/视觉回归用，不影响正常安装）
  StrCpy $DshShotDir ""
  ${GetParameters} $0
  ; 不用 GetOptions：它把值里的「-」当开关分隔符，带连字符的路径会被截断
  ; （CI 的 dsh-shot\light 截成 dsh ⇒ PNG 落错目录 ⇒ 断言找不到文件）。
  ${StrStr} $1 $0 "--shot="
  ${If} $1 != ""
    StrCpy $DshShotDir $1 "" 7
    ; 值截到第一个空格：--shot 后面还可能跟 /THEME= 等参数（dark 轮吃过这个亏：
    ; 路径变成 "...\\dark /THEME=dark" ⇒ 建目录失败 ⇒ 全轮无 PNG）
    StrCpy $2 0
    DshShotCutLoop:
    StrCpy $3 $DshShotDir 1 $2
    StrCmp $3 "" DshShotCutDone
    StrCmp $3 " " DshShotCutTrunc
    IntOp $2 $2 + 1
    Goto DshShotCutLoop
    DshShotCutTrunc:
    StrCpy $DshShotDir $DshShotDir $2
    DshShotCutDone:
    CreateDirectory "$DshShotDir"
    FileOpen $DshTraceFile "$DshShotDir\trace.txt" w
  ${EndIf}
  StrCpy $8 "shotdir=$DshShotDir"
  !insertmacro DshShotTrace "$8"
  HideWindow
  StrCpy $8 "uiinit: dressed dpi=$DshDpi size=$DshWindowSize"
  !insertmacro DshShotTrace "$8"
  ; 官方 lifecycle.nsh:11 同款：去掉标题栏/边框，保留系统菜单位与最小化位
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i 0x800A0000)'
  ; DPI：GetDeviceCaps(LOGPIXELSY = 88)，失败按 96（100%）
  StrCpy $DshDpi 96
  System::Call 'user32::GetDC(p $HWNDPARENT) p.r0'
  System::Call 'gdi32::GetDeviceCaps(p r0, i 88) i.r1'
  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p r0)'
  ${If} $1 > 0
    StrCpy $DshDpi $1
  ${EndIf}
  System::Call 'kernel32::MulDiv(i ${DSH_WINDOW_SIZE}, i $DshDpi, i 96) i.r0'
  StrCpy $DshWindowSize $0
  System::Call 'user32::GetSystemMetrics(i 0) i.r1'
  System::Call 'user32::GetSystemMetrics(i 1) i.r2'
  IntOp $1 $1 - $DshWindowSize
  IntOp $1 $1 / 2
  IntOp $2 $2 - $DshWindowSize
  IntOp $2 $2 / 2
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r1, i r2, i $DshWindowSize, i $DshWindowSize, i 0x34)'
  ; Win11 圆角：DWMWA_WINDOW_CORNER_PREFERENCE(33) → DWMWCP_ROUND(2)；Win10 上调用失败直接忽略
  System::Alloc 4
  Pop $0
  System::Call '*$0(i 2)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, p $0, i 4) i.r1'
  System::Free $0
  ; 藏掉 stock 的「下一步/取消/上一步」与版本字符串（我们自绘全套）
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1028
  ShowWindow $0 0
  ; 中文字体：界面文案统一 Microsoft YaHei UI，缺字体时系统会自己替换
  ; 四档字体：按钮 15/600、正文 13/400、标题 26/650、辅助 12/400
  !insertmacro DshPixelFont $DshFontButton ${DSH_BUTTON_FONT_SIZE} 600
  !insertmacro DshPixelFont $DshFontBody ${DSH_BODY_FONT_SIZE} 400
  !insertmacro DshPixelFont $DshFontTitle ${DSH_TITLE_FONT_SIZE} 650
  !insertmacro DshPixelFont $DshFontHint ${DSH_HINT_FONT_SIZE} 400
  StrCpy $8 "uiinit: fonts done size=$DshWindowSize"
  !insertmacro DshShotTrace "$8"
  ; drawing.nsh 的 painter 直接引用这两个名字（按钮字 / 开关文案字）
  StrCpy $DshFont $DshFontButton
  StrCpy $DshSmallFont $DshFontBody
FunctionEnd

/** 标题栏：品牌瓦片 + 拖动条 + 窗口按钮（三页共用）。 */
Function DshBuildPageChrome
  !insertmacro DshReleaseBrandFiles
  ; 品牌瓦片：NSD 位图 + SetStretchedImage（官方品牌图同款机制——预渲染资产走原生显示路径）
  ${NSD_CreateBitmap} ${DSH_TILE_X} ${DSH_TILE_Y} ${DSH_TILE_W} ${DSH_TILE_H} ""
  Pop $DshTile
  ${If} $DshDpi > 96
    ${NSD_SetStretchedImage} $DshTile "$DshWhaleFile2x" $DshTileImage
  ${Else}
    ${NSD_SetStretchedImage} $DshTile "$DshWhaleFile" $DshTileImage
  ${EndIf}

  ; 拖动条：空 label，只在标题栏区域，点击即拖动窗口
  ${NSD_CreateLabel} ${DSH_DRAG_X} ${DSH_DRAG_Y} ${DSH_DRAG_W} ${DSH_DRAG_H} ""
  Pop $DshDrag
  ${NSD_AddStyle} $DshDrag ${SS_NOTIFY}
  ${NSD_OnClick} $DshDrag DshDragMove
  ; 页眉小标题：文案由每页 ${NSD_SetText} 填（原型顶部小字）
  ${NSD_CreateLabel} ${DSH_HEADER_X} ${DSH_HEADER_Y} ${DSH_HEADER_W} ${DSH_HEADER_H} ""
  Pop $DshHeaderLabel
  SendMessage $DshHeaderLabel ${WM_SETFONT} $DshFontBody 1

  ; 最小化 / 关闭：自绘按钮（DshPaintWinBtn）
  ${NSD_CreateButton} ${DSH_MIN_X} ${DSH_WINBTN_Y} ${DSH_WINBTN_W} ${DSH_WINBTN_H} "−"
  Pop $DshMinBtn
  ${NSD_OnNotify} $DshMinBtn DshPaintWinBtn
  ${NSD_OnClick} $DshMinBtn DshMinimize

  ${NSD_CreateButton} 556 ${DSH_WINBTN_Y} ${DSH_WINBTN_W} ${DSH_WINBTN_H} "×"
  Pop $DshCloseBtn
  StrCpy $DshClose $DshCloseBtn
  ${NSD_OnNotify} $DshCloseBtn DshPaintWinBtn
  ${NSD_OnClick} $DshCloseBtn DshCloseWindow
  ; DPI 落位（官方 InstallerPlace 同款）：nsDialogs 创建坐标在高 DPI 会话不等于物理像素，
  ; 必须逐控件 MoveWindow 到 MulDiv 换算后的值——只放大窗口不摆控件=「挤在左上角、右下空白」（真机实锤）
  !insertmacro DshPlace $DshTile ${DSH_TILE_X} ${DSH_TILE_Y} ${DSH_TILE_W} ${DSH_TILE_H}
  !insertmacro DshPlace $DshDrag ${DSH_DRAG_X} ${DSH_DRAG_Y} ${DSH_DRAG_W} ${DSH_DRAG_H}
  !insertmacro DshPlace $DshHeaderLabel ${DSH_HEADER_X} ${DSH_HEADER_Y} ${DSH_HEADER_W} ${DSH_HEADER_H}
  !insertmacro DshPlace $DshMinBtn ${DSH_MIN_X} ${DSH_WINBTN_Y} ${DSH_WINBTN_W} ${DSH_WINBTN_H}
  !insertmacro DshPlace $DshCloseBtn 556 ${DSH_WINBTN_Y} ${DSH_WINBTN_W} ${DSH_WINBTN_H}
  !insertmacro DshShotTrace "chrome: tile=$DshTile min=$DshMinBtn close=$DshCloseBtn"
FunctionEnd

; ═══════════════════════════════════════════════ 欢迎页
Function DshWelcomeCreate
  nsDialogs::Create 1018
  Pop $DshDialog
  ${If} $DshDialog == error
    Abort
  ${EndIf}
  !insertmacro DshPlace $DshDialog 0 0 ${DSH_WINDOW_SIZE} ${DSH_WINDOW_SIZE}
  Call DshBuildPageChrome
  ; 页面底色 + 文字色（SetCtlColors 只吃编译期常量 ⇒ 两套写死）
  ${If} $DshTheme == "dark"
    SetCtlColors $DshDialog F2F3F5 141417
  ${Else}
    SetCtlColors $DshDialog 0F1115 FFFFFF
  ${EndIf}

  ; 品牌行：应用名
  ${NSD_CreateLabel} ${DSH_APPNAME_X} ${DSH_APPNAME_Y} ${DSH_APPNAME_W} ${DSH_APPNAME_H} "$(DSH_TEXT_APP_NAME)"
  Pop $DshAppName
  SendMessage $DshAppName ${WM_SETFONT} $DshFontBody 1
  ; 大标题 / 副标题
  ${NSD_CreateLabel} ${DSH_HEADLINE_X} ${DSH_HEADLINE_Y} ${DSH_HEADLINE_W} ${DSH_HEADLINE_H} "$(DSH_TEXT_HEADLINE)"
  Pop $DshHeadline
  SendMessage $DshHeadline ${WM_SETFONT} $DshFontTitle 1
  ${NSD_CreateLabel} ${DSH_SUBTITLE_X} ${DSH_SUBTITLE_Y} ${DSH_SUBTITLE_W} ${DSH_SUBTITLE_H} "$(DSH_TEXT_SUBTITLE)"
  Pop $DshSubtitle
  SendMessage $DshSubtitle ${WM_SETFONT} $DshFontBody 1
  ; 页面同色底：不加就是默认 BTNFACE 灰底（真机截图实锤）；SetCtlColors 只吃编译期常量 ⇒ 两套写死
  ${If} $DshTheme == "dark"
    SetCtlColors $DshAppName F2F3F5 141417
    SetCtlColors $DshHeadline F2F3F5 141417
    SetCtlColors $DshSubtitle A7ACB4 141417
    SetCtlColors $DshDrag F2F3F5 141417
    SetCtlColors $DshHeaderLabel A7ACB4 141417
  ${Else}
    SetCtlColors $DshAppName 0F1115 FFFFFF
    SetCtlColors $DshHeadline 0F1115 FFFFFF
    SetCtlColors $DshSubtitle 5A6069 FFFFFF
    SetCtlColors $DshDrag 0F1115 FFFFFF
    SetCtlColors $DshHeaderLabel 5A6069 FFFFFF
  ${EndIf}
  ${NSD_SetText} $DshHeaderLabel "$(DSH_TEXT_HEADER)"

  ; 「安装位置」卡片：预渲染圆角面板（surface + 1px 边框 + r14）
  ${NSD_CreateBitmap} ${DSH_CARD_X} ${DSH_CARD_Y} ${DSH_CARD_W} ${DSH_CARD_H} ""
  Pop $DshCard
  StrCpy $R9 "card"
  ${If} $DshTheme == "dark"
    StrCpy $R9 "card-dark"
  ${EndIf}
  ${If} $DshDpi > 96
    StrCpy $R9 "$R9-2x"
  ${EndIf}
  ${NSD_SetStretchedImage} $DshCard "$PLUGINSDIR\$R9.bmp" $DshCardImage

  ; 卡片内文字（底色跟卡片 surface 对齐）
  ${NSD_CreateLabel} ${DSH_LOCATION_X} ${DSH_LOCATION_Y} ${DSH_LOCATION_W} ${DSH_LOCATION_H} "$(DSH_TEXT_LOCATION)"
  Pop $DshLocationLabel
  SendMessage $DshLocationLabel ${WM_SETFONT} $DshFontHint 1
  ${NSD_CreateLabel} 316 ${DSH_LOCATION_Y} 236 ${DSH_LOCATION_H} ""
  Pop $DshFreeLabel
  ${NSD_AddStyle} $DshFreeLabel ${SS_RIGHT}
  SendMessage $DshFreeLabel ${WM_SETFONT} $DshFontHint 1
  ${NSD_CreateLabel} ${DSH_HINT_X} ${DSH_HINT_Y} ${DSH_HINT_W} ${DSH_HINT_H} "$(DSH_TEXT_HINT)"
  Pop $DshHint
  SendMessage $DshHint ${WM_SETFONT} $DshFontHint 1
  ${If} $DshTheme == "dark"
    SetCtlColors $DshLocationLabel A7ACB4 1E1E23
    SetCtlColors $DshHint A7ACB4 1E1E23
    SetCtlColors $DshFreeLabel A7ACB4 1E1E23
  ${Else}
    SetCtlColors $DshLocationLabel 5A6069 F3F4F7
    SetCtlColors $DshHint 5A6069 F3F4F7
    SetCtlColors $DshFreeLabel 5A6069 F3F4F7
  ${EndIf}
  ; 可用空间：GetDiskFreeSpaceExW。System::Call 的字符串参数不能以反斜杠结尾——
  ; 解析器把 \" 当转义吃掉引号、整条命令变垃圾、调用静默失败（真机「0 GB 可用」的根因），
  ; 所以盘根只取前两个字符 "C:"；int64 用 Alloc + 双 dword 回读。
  StrCpy $R9 "$INSTDIR" 2
  System::Alloc 8
  Pop $R6
  System::Alloc 8
  Pop $R7
  System::Alloc 8
  Pop $R8
  System::Call 'kernel32::GetDiskFreeSpaceExW(w "$R9", p $R6, p $R7, p $R8) i.r3'
  ${If} $r3 != 0
    System::Call '*$R6(i .R4, i .R5)'
    ; GB = hi*4 + floor(lo/2^30)，全程 32 位 IntOp（2^32/2^30=4）。
    ; 历史回归两连：Int64Op 大字面量版把 28.9 GB 算成 30297728（恰为 KB）；
    ; 系数 4096 + 寄存器大小写混用版把 605 GB 算成 619616（恰为 MiB）。
    IntOp $2 $R5 * 4
    IntOp $3 $R4 / 1073741824
    ${If} $R4 < 0
      IntOp $3 $3 - 1                                   ; 负 lo：除法向零截断，补回 floor
    ${EndIf}
    IntOp $1 $2 + $3
    ${NSD_SetText} $DshFreeLabel "$(DSH_TEXT_FREE)"
  ${EndIf}
  System::Free $R6
  System::Free $R7
  System::Free $R8

  ; 路径输入框：真控件（要能编辑），颜色两套写死
  ${NSD_CreateText} ${DSH_EDIT_X} ${DSH_EDIT_Y} ${DSH_EDIT_W} ${DSH_EDIT_H} "$INSTDIR"
  Pop $DshEdit
  ${NSD_AddStyle} $DshEdit ${ES_AUTOHSCROLL}
  SendMessage $DshEdit ${WM_SETFONT} $DshFontBody 1
  ; 输入框内边距：EM_SETMARGINS(EC_LEFTMARGIN=1)，照原型的 12 逻辑像素留白（系统默认几乎为零，文字贴边）
  System::Call 'kernel32::MulDiv(i 12, i $DshDpi, i 96) i.r0'
  SendMessage $DshEdit 0x00D3 1 $0
  ${If} $DshTheme == "dark"
    SetCtlColors $DshEdit F2F3F5 1E1E23
  ${Else}
    SetCtlColors $DshEdit 0F1115 F3F4F7
  ${EndIf}
  ; 剥掉系统自带边框（官方同款掩码）：WS_BORDER(0x800000) / WS_EX_CLIENTEDGE(0x200)
  System::Call 'user32::GetWindowLongW(p $DshEdit, i -16) i.r0'
  IntOp $0 $0 & 0xFF7FFFFF
  System::Call 'user32::SetWindowLongW(p $DshEdit, i -16, i r0)'
  System::Call 'user32::GetWindowLongW(p $DshEdit, i -20) i.r0'
  IntOp $0 $0 & 0xFFFFFDFF
  System::Call 'user32::SetWindowLongW(p $DshEdit, i -20, i r0)'
  ; 圆角框 static：比 edit 四周大 4px，位图由 DshDrawEditFrame 画
  ${NSD_CreateBitmap} ${DSH_EDITFRAME_X} ${DSH_EDITFRAME_Y} ${DSH_EDITFRAME_W} ${DSH_EDITFRAME_H} ""
  Pop $DshEditFrame

  ; 浏览按钮（owner-draw ghost）
  ${NSD_CreateButton} ${DSH_BROWSE_X} ${DSH_BROWSE_Y} ${DSH_BROWSE_W} ${DSH_BROWSE_H} "$(DSH_TEXT_BROWSE)"
  Pop $DshBrowse
  ${NSD_OnNotify} $DshBrowse DshPaintGhost
  ${NSD_OnClick} $DshBrowse DshBrowsePath
  SendMessage $DshBrowse ${WM_SETFONT} $DshFontButton 1

  ; 主按钮（立即安装，owner-draw primary）
  ${NSD_CreateButton} ${DSH_MAIN_X} ${DSH_MAIN_Y} ${DSH_MAIN_W} ${DSH_MAIN_H} "$(DSH_TEXT_INSTALL)"
  Pop $DshMain
  ${NSD_OnNotify} $DshMain DshPaintPrimary
  ${NSD_OnClick} $DshMain DshStartInstall
  SendMessage $DshMain ${WM_SETFONT} $DshFontButton 1
  ; 取消（文字次按钮，ghost owner-draw；点击关窗）
  ${NSD_CreateButton} 236 546 128 32 "$(DSH_TEXT_CANCEL)"
  Pop $DshCancelBtn
  ${NSD_OnNotify} $DshCancelBtn DshPaintGhost
  ${NSD_OnClick} $DshCancelBtn DshCloseWindow
  SendMessage $DshCancelBtn ${WM_SETFONT} $DshFontBody 1

  StrCpy $DshPath "$INSTDIR"
  StrCpy $DshError ""
  !insertmacro DshShotTrace "welcome: name=$DshAppName head=$DshHeadline sub=$DshSubtitle card=$DshCard edit=$DshEdit browse=$DshBrowse main=$DshMain"
  !insertmacro DshCtlProbe drag $DshDrag
  !insertmacro DshCtlProbe appname $DshAppName
  !insertmacro DshCtlProbe headline $DshHeadline
  !insertmacro DshCtlProbe subtitle $DshSubtitle
  !insertmacro DshCtlProbe card $DshCard
  !insertmacro DshCtlProbe location $DshLocationLabel
  !insertmacro DshCtlProbe hint $DshHint
  !insertmacro DshCtlProbe edit $DshEdit
  !insertmacro DshCtlProbe browse $DshBrowse
  !insertmacro DshCtlProbe main $DshMain
  !insertmacro DshTopWindow $DshDrag
  ; DPI 落位（官方 InstallerPlace 同款，见 DshBuildPageChrome 注释）；先落位再抬 z 序
  !insertmacro DshPlace $DshAppName ${DSH_APPNAME_X} ${DSH_APPNAME_Y} ${DSH_APPNAME_W} ${DSH_APPNAME_H}
  !insertmacro DshPlace $DshHeadline ${DSH_HEADLINE_X} ${DSH_HEADLINE_Y} ${DSH_HEADLINE_W} ${DSH_HEADLINE_H}
  !insertmacro DshPlace $DshSubtitle ${DSH_SUBTITLE_X} ${DSH_SUBTITLE_Y} ${DSH_SUBTITLE_W} ${DSH_SUBTITLE_H}
  !insertmacro DshPlace $DshCard ${DSH_CARD_X} ${DSH_CARD_Y} ${DSH_CARD_W} ${DSH_CARD_H}
  !insertmacro DshPlace $DshLocationLabel ${DSH_LOCATION_X} ${DSH_LOCATION_Y} ${DSH_LOCATION_W} ${DSH_LOCATION_H}
  !insertmacro DshPlace $DshFreeLabel ${DSH_FREE_X} ${DSH_LOCATION_Y} ${DSH_FREE_W} ${DSH_LOCATION_H}
  !insertmacro DshPlace $DshHint ${DSH_HINT_X} ${DSH_HINT_Y} ${DSH_HINT_W} ${DSH_HINT_H}
  !insertmacro DshPlace $DshEditFrame ${DSH_EDITFRAME_X} ${DSH_EDITFRAME_Y} ${DSH_EDITFRAME_W} ${DSH_EDITFRAME_H}
  !insertmacro DshDrawEditFrame
  !insertmacro DshPlace $DshEdit ${DSH_EDIT_X} ${DSH_EDIT_Y} ${DSH_EDIT_W} ${DSH_EDIT_H}
  !insertmacro DshPlace $DshBrowse ${DSH_BROWSE_X} ${DSH_BROWSE_Y} ${DSH_BROWSE_W} ${DSH_BROWSE_H}
  !insertmacro DshPlace $DshMain ${DSH_MAIN_X} ${DSH_MAIN_Y} ${DSH_MAIN_W} ${DSH_MAIN_H}
  !insertmacro DshPlace $DshCancelBtn ${DSH_CANCELBTN_X} ${DSH_CANCELBTN_Y} ${DSH_CANCELBTN_W} ${DSH_CANCELBTN_H}
  ; z 序：后建者落底，卡片内控件必须盖在卡片位图上（真机 HWND_BOTTOM 事故）
  !insertmacro DshTopWindow $DshAppName
  !insertmacro DshTopWindow $DshHeadline
  !insertmacro DshTopWindow $DshSubtitle
  !insertmacro DshTopWindow $DshCard
  !insertmacro DshTopWindow $DshLocationLabel
  !insertmacro DshTopWindow $DshFreeLabel
  !insertmacro DshTopWindow $DshHint
  !insertmacro DshTopWindow $DshEditFrame
  !insertmacro DshTopWindow $DshEdit
  !insertmacro DshTopWindow $DshBrowse
  !insertmacro DshTopWindow $DshMain
  StrCpy $R5 "vars: fontB=$DshFontButton fontBody=$DshFontBody fontT=$DshFontTitle fontH=$DshFontHint bg=$DshBgColorref primary=$DshPrimaryArgb token=$DshGdiToken dpi=$DshDpi"
  ${If} $DshShotDir != ""
    ${If} $DshTraceFile != ""
      FileWrite $DshTraceFile "$R5$\r$\n"
    ${EndIf}
  ${EndIf}
  !insertmacro DshArmShotTimer 01-welcome 1
  ; HideWindow 之后必须把窗口 Show 回来（官方防闪三连的第三步）：不 Show 的窗口
  ; 用户看到的就是「没画过」，PrintWindow 也抓不到内容。
  ShowWindow $DshDialog 5
  ShowWindow $HWNDPARENT 5
  Call DshShotNow
  nsDialogs::Show
  ${NSD_FreeImage} $DshTileImage
  ${NSD_FreeImage} $DshCardImage
FunctionEnd

Function DshWelcomeLeave
  ${NSD_GetText} $DshEdit $DshPath
  Call DshValidatePath
  ${If} $DshError != ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "$DshError" /SD IDOK
    Abort
  ${EndIf}
  StrCpy $INSTDIR "$DshPath"
FunctionEnd

/** 校验安装位置：非空、至少 4 个字符、必须是 `X:\` 形式的绝对路径、可创建。 */
Function DshValidatePath
  StrCpy $DshError ""
  ${If} $DshPath == ""
    StrCpy $DshError "$(DSH_TEXT_PATH_EMPTY)"
    Return
  ${EndIf}
  StrCpy $0 $DshPath "" -1
  ${If} $0 == "\"
    StrCpy $DshPath $DshPath -1
  ${EndIf}
  StrLen $0 $DshPath
  ${If} $0 < 4
    StrCpy $DshError "$(DSH_TEXT_PATH_INVALID)"
    Return
  ${EndIf}
  StrCpy $1 $DshPath 1 1
  ${If} $1 != ":"
    StrCpy $DshError "$(DSH_TEXT_PATH_INVALID)"
    Return
  ${EndIf}
  CreateDirectory "$DshPath"
  ${If} ${Errors}
    StrCpy $DshError "$(DSH_TEXT_PATH_UNWRITABLE)"
  ${EndIf}
FunctionEnd

Function DshBrowsePath
  !insertmacro DshBrowseTrace "handler entered"
  ${NSD_GetText} $DshEdit $DshPath
  ; 选目录用官方同款 nsDialogs::SelectFolderDialog（官方 pages.nsh 同一调用）。
  ; 之前真机两连崩的直因疑似「初始目录不存在」：插件拿它 SetFolder，非法路径崩。
  ; 所以初始目录做存在性守卫——不存在就传空（插件自己用默认值）。
  ${If} ${FileExists} "$DshPath\*.*"
    nsDialogs::SelectFolderDialog "$(DSH_TEXT_CHOOSE_PATH)" "$DshPath"
  ${Else}
    nsDialogs::SelectFolderDialog "$(DSH_TEXT_CHOOSE_PATH)" ""
  ${EndIf}
  !insertmacro DshBrowseTrace "dialog closed"
  Pop $0
  ${If} "$0" != "error"
    ${NSD_SetText} $DshEdit "$0"
  ${EndIf}
  !insertmacro DshBrowseTrace "done"
FunctionEnd

Function DshStartInstall
  ${NSD_GetText} $DshEdit $DshPath
  Call DshValidatePath
  ${If} $DshError != ""
    Return
  ${EndIf}
  StrCpy $INSTDIR "$DshPath"
  SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
FunctionEnd

; ═══════════════════════════════════════════════ 进度页
/**
 * instfiles 页的 show 回调：撑满页面、状态文本（1006）跟主题、stock 进度条摆到设计稿的槽上。
 * 页面上没有任何自建控件——instfiles 没有 nsDialogs 会话，在这里 ${NSD_Create*} 是
 * use-after-free（真机 0xC0000005）；一切交给原生控件 + 配色。
 */
Function DshProgressShow
  !insertmacro DshBrowseTrace "progress: show"
  ; 官方 lifecycle.nsh:46 同款：段完自动前进到完成页（没有这行就停在「已完成」）
  SetAutoClose true
  ; show 回调里 $HWNDPARENT 的指向不保证是外层窗（CI 真机 trace：child=0 且 Cancel 取空 ⇒
  ; 两个查找全落在同一层）。先按类名分清内外：#32770 = 内页，否则 $HWNDPARENT 就是外层。
  System::Call 'user32::GetClassNameW(p $HWNDPARENT, t .s, i 64)'
  Pop $R6
  ; 判定不用类名字符串比较（# 在 LogicLib 展开层会踩坑，真机实证走不进分支）：
  ; show 回调里 $HWNDPARENT 若不是 DshUiInit 存下的外层窗，它就是内页本身
  StrCpy $R7 $DshOuterWin
  StrCpy $R8 0                                       ; 内页对话框句柄（DshPlace 会覆写 $0-$3，绝不能用 $0 暂存）
  ${If} $HWNDPARENT != $R7
    StrCpy $R8 $HWNDPARENT                           ; show 回调给的就是内页
  ${Else}
    ; 内页对话框不再用 1018/FindWindow 找（CI 与真机都取不到，进度页全 stock 的根因）——
    ; 直接走 Z 序：外层窗的子窗口里，谁拥有进度条（1004）谁就是当前页内页。
    System::Call 'user32::GetWindow(p $R7, i 5) p.R1'          ; GW_CHILD
    ${While} $R8 == 0
      ${If} $R1 == 0
        ${Break}
      ${EndIf}
      GetDlgItem $R2 $R1 1004
      ${If} $R2 != 0
        StrCpy $R8 $R1
      ${Else}
        System::Call 'user32::GetWindow(p $R1, i 2) p.R1'      ; GW_HWNDNEXT
      ${EndIf}
    ${EndWhile}
  ${EndIf}
  ; ── 官方同款覆盖层（有 window-frame.dll 时）：整页自绘接管进度页 ──
!ifdef DSH_WINDOW_FRAME_DLL
  ${If} $R8 != 0
    ShowWindow $R8 0                 ; stock 内页藏掉（DLL 里 HiddenPageProc 会按住它）
    StrCpy $0 0                      ; dark 标志
    ${If} $DshTheme == "dark"
      StrCpy $0 1
    ${EndIf}
    StrCpy $DshProgressWindow 0      ; 预置：Pop 落空时不至于拿旧值误判
      System::Call '${DSH_WINDOW_FRAME_DLL}::InstallerShowProgress(p $R7, p $R2, i $0, i $DshDpi, w "$(DSH_TEXT_APP_NAME)", w "$(DSH_TEXT_PROGRESS_HEADLINE)", w "$(DSH_TEXT_PREPARING)", w "$(DSH_TEXT_COPYING)", w "$(DSH_TEXT_REGISTERING)", w "$(DSH_TEXT_FINALIZING)", w "$DshWhaleFile2x", w "$(DSH_TEXT_CANCEL)") p.s ?c'
    Pop $DshProgressWindow
    ${If} $DshProgressWindow == 0
      StrCpy $R5 -1                     ; DLL 本身加载失败时 InstallerDiag 也调不到，先给个哨兵值
      System::Call '${DSH_WINDOW_FRAME_DLL}::InstallerDiag() i .R5'
      System::Call '${DSH_WINDOW_FRAME_DLL}::InstallerDiagAttrs() i .R6'
       System::Call '${DSH_WINDOW_FRAME_DLL}::InstallerDiagStr(0) i .R7'
       !insertmacro DshShotTrace "overlay: FAIL diag=$R5 attrs=$R6 str0=$R7 src=$R2 inner=$R8 dpi=$DshDpi whale=$DshWhaleFile2x theme=$DshTheme"
    ${EndIf}
    !insertmacro DshShotTrace "overlay: hwnd=$DshProgressWindow"

    ${If} $DshProgressWindow != 0
      ShowWindow $R7 5
      Return                         ; 覆盖层接管，跳过 stock restyle
    ${EndIf}
    ShowWindow $R8 5                 ; DLL 加载失败 → 回退 stock restyle
  ${EndIf}
!endif
  GetDlgItem $1 $R7 2                ; 取消 = stock 的，露出来（后面向 $R7 取，不是 $HWNDPARENT）
  StrCpy $DshCancel $1
  ShowWindow $DshCancel 5
  System::Call 'uxtheme::SetWindowTheme(p $DshCancel, w " ", w "")'   ; 剥 v6 主题：经典按钮才吃 SetCtlColors
  ShowWindow $R7 5                   ; instfiles 页没有 nsDialogs::Show，自己把外层窗露出来
  GetDlgItem $1 $R7 1                ; NSIS 每页都会把 Back/Next 摆回来：逐页再藏一次
  ShowWindow $1 0
  GetDlgItem $1 $R7 3
  ShowWindow $1 0
  ${If} $R8 != 0
    !insertmacro DshPlace $R8 0 0 ${DSH_WINDOW_SIZE} ${DSH_WINDOW_SIZE}
    ${If} $DshTheme == "dark"
      SetCtlColors $R8 F2F3F5 141417
    ${Else}
      SetCtlColors $R8 0F1115 FFFFFF
    ${EndIf}
  ${EndIf}
  !insertmacro DshShotTrace "progress: class=$R6 outer=$R7 child=$R8"

  ; 状态文本（1006）与进度条（1004）都活在 #32770 子对话框里；往外层窗口取只会拿到空句柄，
  ; MoveWindow/上色全都落空（Wine 实测：bar 停在默认位、Output folder 文案在顶部）。
  ${If} $R8 != 0
    ; 状态文本（1006）：摆到设计稿的状态行，字体/配色跟主题
    GetDlgItem $R5 $R8 1006
    !insertmacro DshPlace $R5 ${DSH_STATUS_X} ${DSH_STATUS_Y} ${DSH_STATUS_W} 24
    SendMessage $R5 ${WM_SETFONT} $DshFontBody 1
    ${If} $DshTheme == "dark"
      SetCtlColors $R5 A7ACB4 141417
    ${Else}
      SetCtlColors $R5 5A6069 FFFFFF
    ${EndIf}

    ; 进度条：摆位 + 深色/浅色两套颜色（PBM_SETBKCOLOR / PBM_SETBARCOLOR）
    GetDlgItem $R5 $R8 1004
    !insertmacro DshPlace $R5 ${DSH_STOCK_BAR_X} ${DSH_STOCK_BAR_Y} ${DSH_STOCK_BAR_W} ${DSH_STOCK_BAR_H}
    System::Call 'uxtheme::SetWindowTheme(p $R5, w " ", w "")'           ; 剥 v6 主题：经典进度条才吃 PBM 配色
    ${If} $DshTheme == "dark"
      SendMessage $R5 0x0408 0 0x2C2C33      ; PBM_SETBKCOLOR
      SendMessage $R5 0x0409 0 0x4D6BFE      ; PBM_SETBARCOLOR
    ${Else}
      SendMessage $R5 0x0408 0 0xE7E9EE      ; PBM_SETBKCOLOR
      SendMessage $R5 0x0409 0 0x4D6BFE      ; PBM_SETBARCOLOR
    ${EndIf}
  ${EndIf}
  !insertmacro DshShotTrace "progress: text=$R5"

  ; 取消按钮 = stock 的（上面已露出）：instfiles 上没有 nsDialogs 会话，
  ; NM_CUSTOMDRAW owner-draw 钩不进来，只换字体与配色。
  ; （句柄已在函数开头从外层窗取好：$DshCancel）
  ${If} $DshTheme == "dark"
    SetCtlColors $DshCancel F2F3F5 141417
  ${Else}
    SetCtlColors $DshCancel 0F1115 FFFFFF
  ${EndIf}
  SendMessage $DshCancel ${WM_SETFONT} $DshFontButton 1
FunctionEnd


; ═══════════════════════════════════════════════ 完成页
Function DshFinishCreate
  !insertmacro DshBrowseTrace "finish: enter"
  !insertmacro DshShotTrace "finish: function enter"
!ifdef DSH_WINDOW_FRAME_DLL
  ${If} $DshProgressWindow != 0
    System::Call '${DSH_WINDOW_FRAME_DLL}::InstallerFinishProgress(p $DshProgressWindow) i.r0 ?c'
    System::Call 'user32::DestroyWindow(p $DshProgressWindow)'
    StrCpy $DshProgressWindow 0
  ${EndIf}
!endif
  !insertmacro DshShotTrace "finish: overlay destroyed"
  nsDialogs::Create 1018
  Pop $DshDialog
  ${If} $DshDialog == error
    !insertmacro DshShotTrace "finish: nsdlg create failed"
    Abort
  ${EndIf}
  !insertmacro DshShotTrace "finish: dialog created"
  !insertmacro DshPlace $DshDialog 0 0 ${DSH_WINDOW_SIZE} ${DSH_WINDOW_SIZE}
  Call DshBuildPageChrome
  !insertmacro DshShotTrace "finish: chrome ok"
  ${If} $DshTheme == "dark"
    SetCtlColors $DshDialog F2F3F5 141417
  ${Else}
    SetCtlColors $DshDialog 0F1115 FFFFFF
  ${EndIf}
  !insertmacro DshBrowseTrace "finish: chrome done"

  ; 大勾：预渲染 check-circle（圆底 + 主题色勾）
  ${NSD_CreateBitmap} ${DSH_CHECK_X} ${DSH_CHECK_Y} ${DSH_CHECK_W} ${DSH_CHECK_H} ""
  Pop $DshCheck
  StrCpy $R9 "check-circle"
  ${If} $DshTheme == "dark"
    StrCpy $R9 "check-circle-dark"
  ${EndIf}
  ${If} $DshDpi > 96
    StrCpy $R9 "$R9-2x"
  ${EndIf}
  ${NSD_SetStretchedImage} $DshCheck "$PLUGINSDIR\$R9.bmp" $DshCheckImage
  !insertmacro DshBrowseTrace "finish: check set"

  ; 标题 / 正文（正文带安装路径）
  ${NSD_CreateLabel} ${DSH_HEADLINE_X} ${DSH_DONE_HEADLINE_Y} ${DSH_HEADLINE_W} ${DSH_HEADLINE_H} "$(DSH_TEXT_DONE_HEADLINE)"
  Pop $DshHeadline
  SendMessage $DshHeadline ${WM_SETFONT} $DshFontTitle 1
  ${NSD_CreateLabel} ${DSH_HEADLINE_X} ${DSH_DONE_BODY_Y} ${DSH_DONE_BODY_W} ${DSH_DONE_BODY_H} "$(DSH_TEXT_DONE_BODY) $INSTDIR"
  Pop $DshSubtitle
  SendMessage $DshSubtitle ${WM_SETFONT} $DshFontBody 1
  ${If} $DshTheme == "dark"
    SetCtlColors $DshHeadline F2F3F5 141417
    SetCtlColors $DshSubtitle A7ACB4 141417
    SetCtlColors $DshDrag F2F3F5 141417
    SetCtlColors $DshHeaderLabel A7ACB4 141417
  ${Else}
    SetCtlColors $DshHeadline 0F1115 FFFFFF
    SetCtlColors $DshSubtitle 5A6069 FFFFFF
    SetCtlColors $DshDrag 0F1115 FFFFFF
    SetCtlColors $DshHeaderLabel 5A6069 FFFFFF
  ${EndIf}
  ${NSD_SetText} $DshHeaderLabel "$(DSH_TEXT_DONE_HEADLINE)"
  ; DPI 落位（官方 InstallerPlace 同款）
  !insertmacro DshPlace $DshCheck ${DSH_CHECK_X} ${DSH_CHECK_Y} ${DSH_CHECK_W} ${DSH_CHECK_H}
  !insertmacro DshPlace $DshHeadline ${DSH_HEADLINE_X} ${DSH_DONE_HEADLINE_Y} ${DSH_HEADLINE_W} ${DSH_HEADLINE_H}
  !insertmacro DshPlace $DshSubtitle ${DSH_HEADLINE_X} ${DSH_DONE_BODY_Y} ${DSH_DONE_BODY_W} ${DSH_DONE_BODY_H}

  ; 立即启动开关：真 checkbox，外观由 DshPaintSwitch 画
  ${NSD_CreateCheckBox} ${DSH_SWITCH_X} ${DSH_SWITCH_Y} ${DSH_SWITCH_W} ${DSH_SWITCH_H} ""
  Pop $DshSwitch
  ${NSD_OnNotify} $DshSwitch DshPaintSwitch
  ${NSD_Check} $DshSwitch

  ; 完成按钮
  ${NSD_CreateButton} ${DSH_DONE_X} ${DSH_DONE_Y} ${DSH_DONE_W} ${DSH_DONE_H} "$(DSH_TEXT_FINISH)"
  Pop $DshMain
  ${NSD_OnNotify} $DshMain DshPaintPrimary
  ${NSD_OnClick} $DshMain DshFinish
  SendMessage $DshMain ${WM_SETFONT} $DshFontButton 1
  ; DPI 落位必须在控件创建之后（此前 $DshSwitch/$DshMain 还是上一页的句柄，真机完成页错位的根因）
  !insertmacro DshPlace $DshSwitch ${DSH_SWITCH_X} ${DSH_SWITCH_Y} ${DSH_SWITCH_W} ${DSH_SWITCH_H}
  !insertmacro DshPlace $DshMain ${DSH_DONE_X} ${DSH_DONE_Y} ${DSH_DONE_W} ${DSH_DONE_H}

  ; 开关文案（原型：立即启动 + 副文案）。句柄用 $R 寄存器：DshPlace 会写 $0..$3
  ${NSD_CreateLabel} 104 424 420 24 "$(DSH_TEXT_LAUNCH)"
  Pop $R1
  SendMessage $R1 ${WM_SETFONT} $DshFontBody 1
  ${NSD_CreateLabel} 104 450 420 18 "$(DSH_TEXT_LAUNCH_SUB)"
  Pop $R2
  SendMessage $R2 ${WM_SETFONT} $DshFontHint 1
  ${If} $DshTheme == "dark"
    SetCtlColors $R1 F2F3F5 141417
    SetCtlColors $R2 A7ACB4 141417
  ${Else}
    SetCtlColors $R1 0F1115 FFFFFF
    SetCtlColors $R2 5A6069 FFFFFF
  ${EndIf}
  !insertmacro DshPlace $R1 104 424 420 24
  !insertmacro DshPlace $R2 104 450 420 18

  !insertmacro DshBrowseTrace "finish: controls done"
  !insertmacro DshArmShotTimer 05-finish 1
  ShowWindow $DshDialog 5
  !insertmacro DshShotTrace "finish: showing"
  ShowWindow $HWNDPARENT 5
  Call DshShotNow
  nsDialogs::Show
  ${NSD_FreeImage} $DshTileImage
  ${NSD_FreeImage} $DshCheckImage
FunctionEnd

Function DshFinish
  ; 「完成」也是 0x408 前进：真正收尾（记录开关、需要时启动应用）在 leave 回调里做
  SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
FunctionEnd

Function DshFinishLeave
  ${NSD_GetState} $DshSwitch $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $DshLaunchWanted "1"
  ${Else}
    StrCpy $DshLaunchWanted "0"
  ${EndIf}
  ${If} $DshLaunchWanted == "1"
    Exec '"${DSH_APP_EXE}"'
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(DSH_TEXT_LAUNCH_FAILED)" /SD IDOK
    ${EndIf}
  ${EndIf}
FunctionEnd

; ═══════════════════════════════════════════════ 窗口行为
Function DshDragMove
  System::Call 'user32::ReleaseCapture()'
  SendMessage $HWNDPARENT ${WM_NCLBUTTONDOWN} 2 0
FunctionEnd

Function DshMinimize
  ShowWindow $HWNDPARENT 6
FunctionEnd

Function DshCloseWindow
  ; WM_CLOSE 会被 NSIS 吞掉（borderless 窗实测关不掉）；走 stock 取消命令（IDCANCEL=2）才是有效退出路径
  System::Call 'user32::SendMessageW(p $HWNDPARENT, i ${WM_COMMAND}, i 2, i 0)'
FunctionEnd

!endif
