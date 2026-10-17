; ─────────────────────────────────────────────────────────────────────────────
; 安装器绘制层（#103）：GDI+ 圆角 / 文本 / 位图原语 + NM_CUSTOMDRAW 自绘控件
;
; 口径（对照官方 apps/desktop/installer/drawing.nsh 与 pages.nsh 的 InstallerPaintButton）：
;   · 只调系统 DLL（gdiplus / gdi32 / user32）：不引 C++ helper DLL，不用 MUI2。
;   · 坐标一律 96 DPI 逻辑像素，宏内部自己 MulDiv(..., $DshDpi, 96)。
;   · 原语只有 HDC 版：画到调用方给的 HDC，也就能画离屏位图 DC 做预览；四个 NM_CUSTOMDRAW
;     绘制函数直接用 NMCUSTOMDRAW 的 hdc，不再多取一次 DC。
;
; 调用方必须提供（本文件不 include 任何东西）：
;   · 已 include nsDialogs.nsh / LogicLib.nsh / WinMessages.nsh，Var DshDpi 已赋值（96 = 100%）。
;   · 主题色（本文件只读）。GDI+ ARGB：$DshBgArgb $DshSurfaceArgb $DshBorderArgb $DshTextArgb
;     $DshDimArgb $DshPrimaryArgb $DshPrimaryHoverArgb $DshPrimaryPressedArgb $DshTrackArgb
;     $DshGhostHoverArgb $DshDangerArgb $DshOnPrimaryArgb；GDI COLORREF 文字色：$DshBgColorref
;     $DshSurfaceColorref $DshTextColorref $DshDimColorref $DshOnPrimaryColorref。
;   · 字体句柄 $DshFont（按钮 16px）/ $DshSmallFont（开关文案 14px）；关闭按钮 HWND 落在本文件
;     声明的 $DshClose（调用方创建关闭钮后赋值；空串 = 窗口按钮不区分关闭钮，也就不会 hover 变红）。
;   · GDI+ 生命周期由本文件负责：DshGdiplusStartup 写 $DshGdiToken，DshGdiplusShutdown 收尾；
;     离屏预览走纯 GDI 的 DIB DC（不需要 GDI+ 的 Graphics，也就不碰 GdipGetDC）。
;
; 本文件自有的 Var（调用方不要再声明同名 Var）：
;   DshGdiToken / DshDrawHdc / DshDrawText / DshPreviewOldBmp / DshClose。
;
; 寄存器约定：HDC 版原语覆写 $0 $1 $2 $3 $R1 $R3 $R5 $R6 $R7 $R8，永不触碰 $R0 $R2 $R4 $R9
;   （四个绘制函数把 HWND / 客户区 RECT* / hdc / uItemState 分别放在这四个里）。
;   想传寄存器也行（几何/文本/字体/颜色都在覆写前就取用了）；TEXT / FILE / 字体 / 颜色既可以是
;   Var 名，也可以是带双引号的字符串（宏内部先 StrCpy 归一，两种写法都认）；含空格的字串请先在
;   调用方放进一个 Var；FORMAT 传字面量（它用在最后一步）。
;
; 手法备注（照官方，勿改）：
;   · System.dll 没有 float 参数类型：GDI+ 的 REAL 形参按 IEEE-754 位型传 —— 弧角
;     180°=0x43340000 / 90°=0x42B40000 / 270°=0x43870000，画笔宽度 1.0f=0x3F800000。
;   · 圆角路径恒画在局部 (0,0)，非零 X/Y 靠 DC 视口原点平移（官方 InstallerPaintCheckbox 同款手法）。
;   · 圆角按「半径」给参：半径 12 → 弧径 24（官方 INSTALLER_BUTTON_DIAMETER 20 对应半径 10 同口径）。
;   · 焦点框不画：真机实证按下态（含 CDIS_FOCUS）画焦点框必崩，原型也无焦点环；
; ─────────────────────────────────────────────────────────────────────────────

!ifndef DSH_INSTALLER_DRAWING
!define DSH_INSTALLER_DRAWING

Var DshGdiToken       ; GDI+ 令牌：DshGdiplusStartup 写、DshGdiplusShutdown 读
Var DshDrawHdc        ; 当前绘制 HDC（HDC 版把入参抄一份进来，避免调用方寄存器被覆写）
Var DshDrawText       ; DshTextHdc 的文本暂存（TEXT 可能是调用方寄存器，先抄出来再用）
Var DshPreviewOldBmp  ; 预览 DC 里 SelectObject 返回的旧位图（收尾时还回去）
Var DshSaveStatus      ; 上一次 DshSaveBitmapPng 的结果（"封装状态/落盘状态"）
Var DshClose           ; 关闭按钮 HWND：本文件声明，调用方创建关闭钮后赋值，空串 = 不区分
Var DshBrowse          ; 浏览按钮 HWND：本文件声明（painter 按它区分四角铺底色）；调用方赋值
Var DshTraceFile       ; --shot 模式的持久 trace 句柄（声明在本文件：painter 里的诊断写盘先用它；.onInit 开一次）
Var DshTraceSeq       ; 诊断序号：一行一文件用（文件通道被杀软锁住时也不丢历史）
Var DshOuterWin        ; 外层主窗：DshUiInit 存、instfiles show 回调兑底用

; ═══ GDI+ 生命周期 + 离屏位图（预览用：没有 Windows 也能落一张 PNG 看效果）══════════════

; GdiplusStartupInput{ GdiplusVersion=1, DebugEventCallback=0, SuppressBackgroundThread=0,
;                      SuppressExternalCodecs=0 }（x86 stub 上 4 个字段都是 4 字节）
!macro DshGdiplusStartup
    System::Call '*(i 1, i 0, i 0, i 0) p.R5'
    System::Call 'gdiplus::GdiplusStartup(*i .s, p R5, p 0) i.R6'
    Pop $DshGdiToken
    ${If} $R6 != 0
        DetailPrint "GDI+ 初始化失败（GdiplusStartup 状态 $R6）"
    ${EndIf}
    System::Free $R5
!macroend

!macro DshGdiplusShutdown
    System::Call 'gdiplus::GdiplusShutdown(p $DshGdiToken)'
!macroend

; 离屏位图 + 它的绘图 HDC：纯 GDI 的 32bpp 顶向下 DIB，绘制层照旧 GdipCreateFromHDC。
; **不用 GdipGetDC** —— 那会把「GDI+ 的 DC」交给又要建 GDI+ Graphics 的原语（嵌套误用，
; 实测在 Wine 下画出全白并在第二页卡死）。BITMAPVAR / HDCVAR 传 Var 名。
!macro DshCreateBitmapDC W H BITMAPVAR HDCVAR
    ; 位图必须跟**屏幕 DC** 兼容：跟内存 DC 兼容会得到 1bpp（内存 DC 默认选着 1×1 单色位图），GDI+ 画上去就是抖动噪点（实测）。
    System::Call 'user32::GetDC(p 0) p.R4'
    System::Call 'gdi32::CreateCompatibleDC(p R4) p.s'
    Pop ${HDCVAR}
    System::Call 'gdi32::CreateCompatibleBitmap(p R4, i ${W}, i ${H}) p.s'
    Pop ${BITMAPVAR}
    System::Call 'user32::ReleaseDC(p 0, p R4)'
    System::Call 'gdi32::SelectObject(p ${HDCVAR}, p ${BITMAPVAR}) p.s'
    Pop $DshPreviewOldBmp
!macroend

; 落盘 PNG：把 DIB 包成 GDI+ Bitmap 再存（CLSID {557cf406-1a04-11d3-9a73-0000f81ef32e}，
; 前三个字段小端、Data4 逐字节；System 插件的 1/2/4 字节类型是 b(byte) / h(int16) / i(int32)）。
!macro DshSaveBitmapPng BITMAPVAR FILE
    System::Call 'gdiplus::GdipCreateBitmapFromHBITMAP(p ${BITMAPVAR}, p 0, *p .s) i.R6'
    Pop $R5
    System::Call '*(i 0x557cf406, h 0x1a04, h 0x11d3, b 0x9a, b 0x73, b 0, b 0, b 0xf8, b 0x1e, b 0xf3, b 0x2e) p.R7'
    System::Call 'gdiplus::GdipSaveImageToFile(p R5, w "${FILE}", p R7, p 0) i.R8'
    StrCpy $DshSaveStatus "$R6/$R8"
    ${If} $R6 != 0
        DetailPrint "位图封装失败（GDI+ 状态 $R6）: ${FILE}"
    ${ElseIf} $R8 != 0
        DetailPrint "位图落盘失败（GDI+ 状态 $R8）: ${FILE}"
    ${EndIf}
    System::Free $R7
    System::Call 'gdiplus::GdipDisposeImage(p R5)'
!macroend

; 收尾：先把旧位图选回去，再删位图与 DC（顺序不能反）。
!macro DshReleaseBitmapDC BITMAPVAR HDCVAR
    System::Call 'gdi32::SelectObject(p ${HDCVAR}, p $DshPreviewOldBmp)'
    System::Call 'gdi32::DeleteObject(p ${BITMAPVAR})'
    System::Call 'gdi32::DeleteDC(p ${HDCVAR})'
!macroend

; ═══ 设备无关原语（全部画到调用方给的 HDC 上）══════════════════════════════════════════

; 逻辑像素字体：96 DPI 的 -SIZE 像素高 + ClearType，字面字体名同官方 InstallerPixelFont
!macro DshPixelFont HANDLE SIZE WEIGHT
    System::Call 'kernel32::MulDiv(i -${SIZE}, i $DshDpi, i 96) i.r0'
    System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i ${WEIGHT}, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "Microsoft YaHei UI") p.s'
    Pop ${HANDLE}
!macroend

; 闭合圆角矩形路径：GdipCreatePath + 四段 GdipAddPathArcI + GdipClosePathFigure。
; 输入与输出都不得用 $0 / $1（宏内部拿它们算两条直角边的起点）。
!macro DshRoundPath PATH WIDTH HEIGHT DIAMETER
    System::Call 'gdiplus::GdipCreatePath(i 0, *p .s)'
    Pop ${PATH}
    IntOp $0 ${WIDTH} - ${DIAMETER}
    IntOp $1 ${HEIGHT} - ${DIAMETER}
    ; System.dll 没有 float 参数类型：弧角按 IEEE-754 位型传（180° / 270° / 0° / 90°，扫过 90°）
    System::Call 'gdiplus::GdipAddPathArcI(p ${PATH}, i 0, i 0, i ${DIAMETER}, i ${DIAMETER}, i 0x43340000, i 0x42B40000)'
    System::Call 'gdiplus::GdipAddPathArcI(p ${PATH}, i r0, i 0, i ${DIAMETER}, i ${DIAMETER}, i 0x43870000, i 0x42B40000)'
    System::Call 'gdiplus::GdipAddPathArcI(p ${PATH}, i r0, i r1, i ${DIAMETER}, i ${DIAMETER}, i 0, i 0x42B40000)'
    System::Call 'gdiplus::GdipAddPathArcI(p ${PATH}, i 0, i r1, i ${DIAMETER}, i ${DIAMETER}, i 0x42B40000, i 0x42B40000)'
    System::Call 'gdiplus::GdipClosePathFigure(p ${PATH})'
!macroend

; 圆角实心矩形（HDC 版）。X/Y/W/H/DIAMETER 是 96 DPI 逻辑像素。
!macro DshFillRoundHdc HDC X Y W H DIAMETER FILLARGB
    ; 画刷先建：${FILLARGB} 可能是调用方寄存器，后头会被本宏的 MulDiv 覆写
    System::Call 'gdiplus::GdipCreateSolidFill(i ${FILLARGB}, *p .s)'
    Pop $R1
    StrCpy $DshDrawHdc ${HDC}
    ; 几何入参先全部压栈再取用：X/Y/W/H/直径 完全可能就传的成本宏要覆写的那几个寄存器，
    ; 只有先进栈（NSIS 栈）才谈得上「读到的都是原值」。
    Push ${X}
    Push ${Y}
    Push ${W}
    Push ${H}
    Push ${DIAMETER}
    Pop $R7                                            ; 弧径（最终位）
    Pop $R8                                            ; 高（最终位）
    Pop $R5                                            ; 宽（最终位）
    Pop $R6                                            ; y（SetViewportOrgEx 之后让位给 Graphics）
    Pop $R3                                            ; x（同上）
    System::Call 'kernel32::MulDiv(i R7, i $DshDpi, i 96) i.R7'
    ${If} $R7 == 0
        StrCpy $R7 1       ; 直径 0 = 直角矩形：零尺寸弧几何不合法，钳成 1 逻辑像素（视觉上就是直角）
    ${EndIf}
    System::Call 'kernel32::MulDiv(i R5, i $DshDpi, i 96) i.R5'
    System::Call 'kernel32::MulDiv(i R8, i $DshDpi, i 96) i.R8'
    System::Call 'kernel32::MulDiv(i R3, i $DshDpi, i 96) i.R3'
    System::Call 'kernel32::MulDiv(i R6, i $DshDpi, i 96) i.R6'
    System::Call 'gdi32::SetViewportOrgEx(p $DshDrawHdc, i R3, i R6, p 0)'
    System::Call 'gdiplus::GdipCreateFromHDC(p $DshDrawHdc, *p .s)'
    Pop $R6
    System::Call 'gdiplus::GdipSetSmoothingMode(p R6, i 4)'    ; AntiAlias
    System::Call 'gdiplus::GdipSetPixelOffsetMode(p R6, i 4)'  ; Half
    !insertmacro DshRoundPath $2 $R5 $R8 $R7
    System::Call 'gdiplus::GdipFillPath(p R6, p R1, p $2)'
    System::Call 'gdiplus::GdipDeletePath(p $2)'
    System::Call 'gdiplus::GdipDeleteGraphics(p R6)'
    System::Call 'gdiplus::GdipDeleteBrush(p R1)'
    System::Call 'gdi32::SetViewportOrgEx(p $DshDrawHdc, i 0, i 0, p 0)'
!macroend

; 圆角实心矩形 + 1px 描边（HDC 版）
!macro DshFillRoundBorderHdc HDC X Y W H DIAMETER FILLARGB BORDERARGB
    System::Call 'gdiplus::GdipCreateSolidFill(i ${FILLARGB}, *p .s)'
    Pop $R1
    ; GdipCreatePen1(颜色, 宽度 REAL, 单位 2=UnitPixel)：宽度 1.0f 的位型 0x3F800000
    System::Call 'gdiplus::GdipCreatePen1(i ${BORDERARGB}, i 0x3F800000, i 2, *p .s)'
    Pop $3                                             ; 描边笔（$3 是临时变量，不碰寄存器）
    StrCpy $DshDrawHdc ${HDC}
    Push ${X}
    Push ${Y}
    Push ${W}
    Push ${H}
    Push ${DIAMETER}
    Pop $R7                                            ; 弧径
    Pop $R8                                            ; 高
    Pop $R5                                            ; 宽
    Pop $R6                                            ; y
    Pop $R3                                            ; x
    System::Call 'kernel32::MulDiv(i R7, i $DshDpi, i 96) i.R7'
    ${If} $R7 == 0
        StrCpy $R7 1       ; 直径 0 = 直角矩形：零尺寸弧几何不合法，钳成 1 逻辑像素（视觉上就是直角）
    ${EndIf}
    System::Call 'kernel32::MulDiv(i R5, i $DshDpi, i 96) i.R5'
    System::Call 'kernel32::MulDiv(i R8, i $DshDpi, i 96) i.R8'
    System::Call 'kernel32::MulDiv(i R3, i $DshDpi, i 96) i.R3'
    System::Call 'kernel32::MulDiv(i R6, i $DshDpi, i 96) i.R6'
    System::Call 'gdi32::SetViewportOrgEx(p $DshDrawHdc, i R3, i R6, p 0)'
    System::Call 'gdiplus::GdipCreateFromHDC(p $DshDrawHdc, *p .s)'
    Pop $R6
    System::Call 'gdiplus::GdipSetSmoothingMode(p R6, i 4)'
    System::Call 'gdiplus::GdipSetPixelOffsetMode(p R6, i 4)'
    !insertmacro DshRoundPath $2 $R5 $R8 $R7
    System::Call 'gdiplus::GdipFillPath(p R6, p R1, p $2)'
    System::Call 'gdiplus::GdipDrawPath(p R6, p $3, p $2)'
    System::Call 'gdiplus::GdipDeletePath(p $2)'
    System::Call 'gdiplus::GdipDeleteGraphics(p R6)'
    System::Call 'gdiplus::GdipDeletePen(p $3)'
    System::Call 'gdiplus::GdipDeleteBrush(p R1)'
    System::Call 'gdi32::SetViewportOrgEx(p $DshDrawHdc, i 0, i 0, p 0)'
!macroend

; 一行文本（HDC 版）：透明底 + COLORREF + FONT，左/上/宽/高都是逻辑像素。
; FORMAT 是 DrawTextW 的 format（主/次按钮居中 0x25、开关左对齐 0x24）。
!macro DshTextHdc HDC TEXT X Y W H FONT COLORREF FORMAT
    ; TEXT 可以是带双引号的字符串（字面量或 "$Var"）也可以是裸 Var/寄存器名：StrCpy 先归一，
    ; 后面统一用 w "$DshDrawText" 交给插件，避免引号被加两遍。
    StrCpy $DshDrawText ${TEXT}
    StrCpy $DshDrawHdc ${HDC}
    ; 几何入参先压栈（可能是调用方寄存器），字体与颜色也趁原值先把 DC 设好
    Push ${X}
    Push ${Y}
    Push ${W}
    Push ${H}
    System::Call 'gdi32::SetBkMode(p $DshDrawHdc, i 1)'                 ; 1 = 透明
    System::Call 'gdi32::SetTextColor(p $DshDrawHdc, i ${COLORREF})'
    System::Call 'gdi32::SelectObject(p $DshDrawHdc, p ${FONT}) p.R6'   ; $R6 = 原字体，用完还原
    Pop $R2                                                 ; 高
    Pop $R1                                                 ; 宽
    Pop $R8                                                 ; top
    Pop $R7                                                 ; left
    System::Call 'kernel32::MulDiv(i R7, i $DshDpi, i 96) i.R7'
    System::Call 'kernel32::MulDiv(i R8, i $DshDpi, i 96) i.R8'
    System::Call 'kernel32::MulDiv(i R1, i $DshDpi, i 96) i.R1'
    System::Call 'kernel32::MulDiv(i R2, i $DshDpi, i 96) i.R2'
    IntOp $R1 $R7 + $R1                                                 ; right = left + w
    IntOp $R2 $R8 + $R2                                                 ; bottom = top + h
    System::Alloc 16
    Pop $R3
    System::Call '*$R3(i R7, i R8, i R1, i R2)'                         ; 手工写四个 int
    System::Call 'user32::DrawTextW(p $DshDrawHdc, w "$DshDrawText", i -1, p R3, i ${FORMAT})'
    System::Call 'gdi32::SelectObject(p $DshDrawHdc, p R6)'
    System::Free $R3
!macroend



; ═══ NM_CUSTOMDRAW 绘制函数 ═════════════════════════════════════════════════════════════
; 这套 NMCUSTOMDRAW 布局按 x86 NSIS stub 写（x64 Windows 上跑的也是 x86 stub）。
; 四个函数的寄存器占用固定：$R0 控件 HWND、$R2 客户区 RECT*、$R4 控件 DC、$R9 uItemState；
; 原语覆写 $R1 $R3 $R5..$R8，所以每画完一步要重取的值都紧挨着用之前取。

; 主按钮：$DshPrimaryArgb，hover CDIS_HOT → Hover，pressed CDIS_SELECTED → Pressed；半径 12。
Function DshPaintPrimary
    Pop $R0
    Pop $R1
    Pop $R2
    ${If} $DshTraceFile != ""
      FileWrite $DshTraceFile "paintP: enter r0=$R0 r1=$R1$\r$\n"
    ${EndIf}
    ${If} $R1 != -12                                   ; -12 = NM_CUSTOMDRAW
        Return
    ${EndIf}
    System::Call '*$R2(p, p, i, i .R3, p .R4, i .R5, i .R6, i .R7, i .R8, p, i .R9)'
    ${If} $R3 != 1                                     ; 1 = CDDS_PREPAINT，别的阶段交回系统
    ${If} $DshTraceFile != ""
      FileWrite $DshTraceFile "paintP: stage=$R3 dc=$R4 state=$R9$\r$\n"
    ${EndIf}
        Return
    ${EndIf}
    System::Call 'gdi32::SaveDC(p R4)'
    System::Alloc 16
    Pop $R2                                            ; $R2 换成客户区 RECT*（NMCUSTOMDRAW 已解析完）
    System::Call 'user32::GetClientRect(p R0, p R2)'
    System::Call 'gdi32::CreateSolidBrush(i $DshBgColorref) p.R3'
    System::Call 'user32::FillRect(p R4, p R2, p R3)'
    System::Call 'gdi32::DeleteObject(p R3)'
    StrCpy $R3 $DshPrimaryArgb
    IntOp $R1 $R9 & 64                                 ; CDIS_HOT
    ${If} $R1 != 0
        StrCpy $R3 $DshPrimaryHoverArgb
    ${EndIf}
    IntOp $R1 $R9 & 1                                  ; CDIS_SELECTED
    ${If} $R1 != 0
        StrCpy $R3 $DshPrimaryPressedArgb
    ${EndIf}
    ; 客户区 RECT 是设备像素，原语吃 96 DPI 逻辑像素：反算回去（与页面 DshPlace 的正向
    ; MulDiv 互逆，误差 ≤1 设备像素，且溢出部分被 DC 裁掉，肉眼不可见）
    System::Call '*$R2(i, i, i .R7, i .R8)'
    System::Call 'kernel32::MulDiv(i R7, i 96, i $DshDpi) i.R5'
    System::Call 'kernel32::MulDiv(i R8, i 96, i $DshDpi) i.R6'
    !insertmacro DshFillRoundHdc $R4 0 0 $R5 $R6 24 $R3      ; 圆角半径 12 → 弧径 24
    System::Call '*$R2(i, i, i .R7, i .R8)'                  ; 原语覆写了 $R5/$R6，文本框重算
    System::Call 'kernel32::MulDiv(i R7, i 96, i $DshDpi) i.R5'
    System::Call 'kernel32::MulDiv(i R8, i 96, i $DshDpi) i.R6'
    ${NSD_GetText} $R0 $R3                                   ; 按钮文案是 $(DSH_TEXT_*) 给进去的
    !insertmacro DshTextHdc $R4 $R3 0 0 $R5 $R6 $DshFont $DshOnPrimaryColorref 0x25
    ; 焦点框已移除：真机实证按下态（state=81 = pressed+focus+hot）必崩在焦点分支
    ; （DrawFocusRect/InflateRect 一段，多轮双通道 trace 夹逼定位）；
    ; 原型无焦点环，按钮也不进 Tab 序，不画不影响键盘可达性（Alt+F4 / 系统菜单）。
    System::Call 'gdi32::RestoreDC(p R4, i -1)'
    System::Free $R2
    ${If} $DshTraceFile != ""
      FileWrite $DshTraceFile "paintP: done$\r$\n"
    ${EndIf}
    ${NSD_Return} 4                                          ; 4 = CDRF_SKIPDEFAULT
FunctionEnd

; 浏览/绘制痕迹（真机排查）：双通道——窗口标题（冻结时截图即得）+ %TEMP%\dsh-t\ 一行一文件；
!macro DshBrowseTrace MSG
  ; 通道 1：窗口标题。冻结时直接截图标题栏即得最后一步，不依赖任何文件。
  System::Call 'user32::SetWindowTextW(p $DshOuterWin, t "dsh: ${MSG}")'
  ; 通道 2：一行一文件。共享名单文件会被杀软锁文件+追写失败+回退 w 截断历史
  ; （真机实证：多轮 trace 都只剩最后一行），一行一文件彻底避开。
  IntOp $DshTraceSeq $DshTraceSeq + 1
  CreateDirectory "$TEMP\dsh-t"
  ; 不清错误标志就判断 ${Errors}：段末的 Delete/RMDir 失败会把标志留着，宏会提前 Return——
  ; 完成页 create 一旦提前返回（还没 nsDialogs::Show），NSIS 就把这页当成已结束直接前进，窗口关闭、没有完成页。
  ClearErrors
  FileOpen $R7 "$TEMP\dsh-t\$DshTraceSeq.txt" w
  ${If} ${Errors}
    ClearErrors
  ${Else}
    FileWrite $R7 "${MSG}$\r$\n"
    FileClose $R7
  ${EndIf}
  ClearErrors
!macroend
; 次按钮：$DshSurfaceArgb，hover/pressed（& 65）→ $DshGhostHoverArgb；半径 10 + 1px $DshBorderArgb。
Function DshPaintGhost
    Pop $R0
    Pop $R1
    Pop $R2
    ${If} $R1 != -12
        Return
    ${EndIf}
    System::Call '*$R2(p, p, i, i .R3, p .R4, i .R5, i .R6, i .R7, i .R8, p, i .R9)'
    ${If} $R3 != 1
        Return
    ${EndIf}
    !insertmacro DshBrowseTrace "paint stage=$R3 state=$R9"   ; 每次重绘都记（含 hover/焦点），卡死时看是否刷屏
    IntOp $R1 $R9 & 1                                 ; 只在按下重绘时写痕迹
    ${If} $R1 != 0
        !insertmacro DshBrowseTrace "painter pressed enter"
    ${EndIf}
    System::Call 'gdi32::SaveDC(p R4)'
    System::Alloc 16
    Pop $R2
    System::Call 'user32::GetClientRect(p R0, p R2)'
    StrCpy $R6 $DshBgColorref                          ; 圆角四角的外露底色：Browse 在卡片上→卡片色，其余（取消）→页底色
    ${If} $R0 == $DshBrowse
        StrCpy $R6 $DshSurfaceColorref
    ${EndIf}
    System::Call 'gdi32::CreateSolidBrush(i $R6) p.R3'
    System::Call 'user32::FillRect(p R4, p R2, p R3)'
    System::Call 'gdi32::DeleteObject(p R3)'
    StrCpy $R3 $DshSurfaceArgb
    IntOp $R1 $R9 & 64                                 ; 只认 CDIS_HOT：focus/selected 不让 ghost 上灰（原型 .btn-ghost 只在 hover 变色）
    ${If} $R1 != 0
        StrCpy $R3 $DshGhostHoverArgb
    ${EndIf}
    System::Call '*$R2(i, i, i .R7, i .R8)'
    System::Call 'kernel32::MulDiv(i R7, i 96, i $DshDpi) i.R5'
    System::Call 'kernel32::MulDiv(i R8, i 96, i $DshDpi) i.R6'
    !insertmacro DshFillRoundBorderHdc $R4 0 0 $R5 $R6 20 $R3 $DshBorderArgb  ; 半径 10 → 弧径 20
    System::Call '*$R2(i, i, i .R7, i .R8)'
    System::Call 'kernel32::MulDiv(i R7, i 96, i $DshDpi) i.R5'
    System::Call 'kernel32::MulDiv(i R8, i 96, i $DshDpi) i.R6'
    ${NSD_GetText} $R0 $R3
    !insertmacro DshTextHdc $R4 $R3 0 0 $R5 $R6 $DshFont $DshTextColorref 0x25
    IntOp $R6 $R9 & 1                                 ; 按下位存 $R6（$R9 下面会被焦点位改写）
    ${If} $R6 != 0
        !insertmacro DshBrowseTrace "painter pressed exit"
    ${EndIf}
    ; 焦点框已移除（真机实证按下态必崩在焦点分支；原型无焦点环、无 Tab 序）
    System::Call 'gdi32::RestoreDC(p R4, i -1)'
    System::Free $R2
    ${If} $R6 != 0
        !insertmacro DshBrowseTrace "painter returning"
    ${EndIf}
    ${NSD_Return} 4
FunctionEnd

; 窗口按钮（最小化 / 关闭）：平时只有页底色（等于透明），hover/pressed（& 65）才铺 $DshSurfaceArgb；
; 关闭钮（HWND == $DshClose）hover 铺 $DshDangerArgb，文字转白。半径 8。
Function DshPaintWinBtn
    Pop $R0
    Pop $R1
    Pop $R2
    ${If} $R1 != -12
        Return
    ${EndIf}
    System::Call '*$R2(p, p, i, i .R3, p .R4, i .R5, i .R6, i .R7, i .R8, p, i .R9)'
    ${If} $R3 != 1
        Return
    ${EndIf}
    System::Call 'gdi32::SaveDC(p R4)'
    System::Alloc 16
    Pop $R2
    System::Call 'user32::GetClientRect(p R0, p R2)'
    System::Call 'gdi32::CreateSolidBrush(i $DshBgColorref) p.R3'
    System::Call 'user32::FillRect(p R4, p R2, p R3)'
    System::Call 'gdi32::DeleteObject(p R3)'
    StrCpy $R3 ""                                      ; 空 = 不铺底（页底色即透明态）
    IntOp $R1 $R9 & 64                                 ; 只认 CDIS_HOT（同上）
    ${If} $R1 != 0
        StrCpy $R3 $DshSurfaceArgb
        ${If} $R0 == $DshClose
            StrCpy $R3 $DshDangerArgb
        ${EndIf}
    ${EndIf}
    ${If} $R3 != ""
        System::Call '*$R2(i, i, i .R7, i .R8)'
        System::Call 'kernel32::MulDiv(i R7, i 96, i $DshDpi) i.R5'
        System::Call 'kernel32::MulDiv(i R8, i 96, i $DshDpi) i.R6'
        !insertmacro DshFillRoundHdc $R4 0 0 $R5 $R6 16 $R3    ; 圆角半径 8 → 弧径 16
    ${EndIf}
    ; 文字色必须在铺底之后算：铺底原语会拿 $R1 当画刷，先算就被覆写了
    StrCpy $R1 $DshTextColorref
    IntOp $R6 $R9 & 64
    ${If} $R6 != 0
        StrCpy $R1 $DshDimColorref
        ${If} $R0 == $DshClose
            StrCpy $R1 $DshOnPrimaryColorref
        ${EndIf}
    ${EndIf}
    System::Call '*$R2(i, i, i .R7, i .R8)'
    System::Call 'kernel32::MulDiv(i R7, i 96, i $DshDpi) i.R5'
    System::Call 'kernel32::MulDiv(i R8, i 96, i $DshDpi) i.R6'
    ${NSD_GetText} $R0 $R3
    !insertmacro DshTextHdc $R4 $R3 0 0 $R5 $R6 $DshFont $R1 0x25
    ; 焦点态：窗口按钮没进 Tab 序（无 WS_TABSTOP），不画 DrawFocusRect —— 空焦点框只会
    ; 添乱，键盘可达性由最小化/关闭之外的路径保证（Alt+F4 / 系统菜单）。
    System::Call 'gdi32::RestoreDC(p R4, i -1)'
    System::Free $R2
    ${NSD_Return} 4
FunctionEnd

; 开关：BS_AUTOCHECKBOX 只借它的状态/文本/键盘与无障碍语义，画法全接管 ——
; 轨道 44×24 半径 12（未选 $DshTrackArgb / 选中 $DshPrimaryArgb），滑块 18 圆（未选 x=4、
; 选中 x=22，$DshOnPrimaryArgb），文案在轨道右侧 12px（$DshTextColorref）。
Function DshPaintSwitch
    Pop $R0
    Pop $R1
    Pop $R2
    ${If} $R1 != -12
        Return
    ${EndIf}
    System::Call '*$R2(p, p, i, i .R3, p .R4, i .R5, i .R6, i .R7, i .R8, p, i .R9)'
    ${If} $R3 != 1
        Return
    ${EndIf}
    System::Call 'gdi32::SaveDC(p R4)'
    System::Alloc 16
    Pop $R2
    System::Call 'user32::GetClientRect(p R0, p R2)'
    System::Call 'gdi32::CreateSolidBrush(i $DshBgColorref) p.R3'
    System::Call 'user32::FillRect(p R4, p R2, p R3)'
    System::Call 'gdi32::DeleteObject(p R3)'
    ; ── 轨道：垂直居中（控件比 24 高就留白，比 24 矮就贴顶）──
    ${NSD_GetState} $R0 $R1                            ; BST_CHECKED = 1
    StrCpy $R3 $DshTrackArgb
    ${If} $R1 == ${BST_CHECKED}
        StrCpy $R3 $DshPrimaryArgb
    ${EndIf}
    System::Call '*$R2(i, i, i, i .R8)'
    System::Call 'kernel32::MulDiv(i R8, i 96, i $DshDpi) i.R7'   ; 客户区高（逻辑像素）
    IntOp $R7 $R7 - 24
    ${If} $R7 < 0
        StrCpy $R7 0
    ${EndIf}
    IntOp $R7 $R7 / 2                                  ; 轨道顶（逻辑像素）
    !insertmacro DshFillRoundHdc $R4 0 $R7 44 24 24 $R3           ; 半径 12 → 弧径 24（胶囊）
    ; ── 滑块：GdipFillEllipseI 直接吃设备像素，所以这里自己换算 ──
    ; 轨道顶要重算：铺底原语已经把 $R7 覆写成缩放后的弧径了
    System::Call '*$R2(i, i, i, i .R8)'
    System::Call 'kernel32::MulDiv(i R8, i 96, i $DshDpi) i.R7'   ; 客户区高（逻辑像素）
    IntOp $R7 $R7 - 24
    ${If} $R7 < 0
        StrCpy $R7 0
    ${EndIf}
    IntOp $R7 $R7 / 2
    System::Call 'kernel32::MulDiv(i R7, i $DshDpi, i 96) i.R7'   ; 轨道顶（设备像素）
    System::Call 'kernel32::MulDiv(i 3, i $DshDpi, i 96) i.R6'    ; 轨道内 y = (24 − 18) / 2
    IntOp $R6 $R6 + $R7
    ${NSD_GetState} $R0 $R1                            ; 原语覆写了 $R1，状态重新取一次
    ${If} $R1 == ${BST_CHECKED}
        System::Call 'kernel32::MulDiv(i 22, i $DshDpi, i 96) i.R7'   ; 选中：轨道内 x = 22
    ${Else}
        System::Call 'kernel32::MulDiv(i 4, i $DshDpi, i 96) i.R7'    ; 未选：轨道内 x = 4
    ${EndIf}
    System::Call 'kernel32::MulDiv(i 18, i $DshDpi, i 96) i.R8'   ; 滑块直径
    System::Call 'gdiplus::GdipCreateSolidFill(i $DshOnPrimaryArgb, *p .s)'
    Pop $R5
    System::Call 'gdiplus::GdipCreateFromHDC(p R4, *p .s)'
    Pop $R1
    System::Call 'gdiplus::GdipSetSmoothingMode(p R1, i 4)'
    System::Call 'gdiplus::GdipSetPixelOffsetMode(p R1, i 4)'
    System::Call 'gdiplus::GdipFillEllipseI(p R1, p R5, i R7, i R6, i R8, i R8)'
    System::Call 'gdiplus::GdipDeleteBrush(p R5)'
    System::Call 'gdiplus::GdipDeleteGraphics(p R1)'
    ; ── 文案：轨道 44 + 间距 12 起，纵向与轨道同一带（宽度给足，超出部分由 DC 裁）──
    System::Call '*$R2(i, i, i, i .R8)'
    System::Call 'kernel32::MulDiv(i R8, i 96, i $DshDpi) i.R7'
    IntOp $R7 $R7 - 24
    ${If} $R7 < 0
        StrCpy $R7 0
    ${EndIf}
    IntOp $R7 $R7 / 2
    ${NSD_GetText} $R0 $R3
    !insertmacro DshTextHdc $R4 $R3 56 $R7 600 24 $DshSmallFont $DshTextColorref 0x24
    ; 焦点框已移除（同上：按下态必崩在焦点分支）
    System::Call 'gdi32::RestoreDC(p R4, i -1)'
    System::Free $R2
    ${NSD_Return} 4
FunctionEnd

!endif
