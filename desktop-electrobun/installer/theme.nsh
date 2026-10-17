/*
 * 安装界面的主题与调色板（#103）——对应官方 `apps/desktop/installer/theme.nsh` 的位置，
 * 但颜色来自设计稿 docs/design/windows-installer-ui-prototype.html 的令牌表。
 *
 * 职责：
 *   · 声明绘制层要用的颜色变量（必须在 drawing.nsh 之前 include：那边有同名的 Var 引用）；
 *   · 决定明暗主题：`/THEME=light|dark|auto` 覆盖 > 系统 AppsUseLightTheme > 亮色；
 *   · 按主题把两套调色板写进变量：ARGB（GDI+ 填充）与 COLORREF（GDI 文本/画笔）。
 *
 * 约束（踩过的坑）：SetCtlColors 只吃编译期常量（如仍需用它，颜色不能带 0x 前缀）；
 * 这里的颜色是给 System::Call 的 GDI+/GDI 调用用的，ARGB 必须带 0xFF 不透明前缀，
 * COLORREF 是 0x00BBGGRR（字节序反过来），两者不能混用。
 */

!ifndef DSH_INSTALLER_THEME
!define DSH_INSTALLER_THEME 1

!include "LogicLib.nsh"
!include "FileFunc.nsh" ; ${GetParameters} / ${GetOptions}



Var DshTheme         ; "light" | "dark"
Var DshDpi           ; 逻辑像素 -> 物理像素的缩放基准（96 = 100%）
Var DshBrandPrefix   ; 品牌图前缀：brand | brand-dark
Var DshWhaleFile     ; 标题栏品牌瓦片（1x）
Var DshWhaleFile2x   ; 标题栏品牌瓦片（2x；$DshDpi > 96 时用）

Var DshBgArgb
Var DshSurfaceArgb
Var DshBorderArgb
Var DshTextArgb
Var DshDimArgb
Var DshMuteArgb
Var DshPrimaryArgb
Var DshPrimaryHoverArgb
Var DshPrimaryPressedArgb
Var DshTrackArgb
Var DshGhostHoverArgb
Var DshDangerArgb
Var DshOnPrimaryArgb

Var DshBgColorref
Var DshSurfaceColorref
Var DshTextColorref
Var DshDimColorref
Var DshMuteColorref
Var DshDangerColorref
Var DshOnPrimaryColorref

; drawing.nsh 的 painter 直接引用这三个：字体句柄由调用方（ui.nsh）DshUiInit 里造好，
; 关闭按钮 HWND 由页面 chrome 建好后赋值（空串 = 不区分关闭钮，hover 不变红）。
Var DshFont        ; 按钮字体（16px 量级）
Var DshSmallFont   ; 小字/开关文案字体（14px 量级）
; （关闭按钮 HWND 由 drawing.nsh 自己声明：$DshClose）

/**
 * 定主题：命令行 /THEME= 优先（非法值直接报错退出），否则读系统的 AppsUseLightTheme，
 * 读不到（键不存在/无权限）按亮色处理——浅色是安全默认，深色底在旧系统上更容易糊。
 */
Function DshResolveTheme
  StrCpy $DshTheme "auto"
  ${GetParameters} $0
  ${GetOptions} $0 "/THEME=" $1
  ${IfNot} ${Errors}
    ${If} $1 == "light"
    ${OrIf} $1 == "dark"
    ${OrIf} $1 == "auto"
      StrCpy $DshTheme $1
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(DSH_TEXT_THEME_ERROR)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}

  ${If} $DshTheme == "auto"
    ClearErrors
    ReadRegDWORD $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" "AppsUseLightTheme"
    ${If} ${Errors}
      StrCpy $DshTheme "light"
    ${ElseIf} $0 == 0
      StrCpy $DshTheme "dark"
    ${Else}
      StrCpy $DshTheme "light"
    ${EndIf}
  ${EndIf}

  Call DshApplyPalette
FunctionEnd

/** 把 $DshTheme 对应的令牌写进变量（ARGB + COLORREF 两套，品牌图前缀也随之切换）。 */
Function DshApplyPalette
  ${If} $DshTheme == "dark"
    ; 深色：bg #141417 / surface #1E1E23 / border #2C2C33 / text #F2F3F5 / dim #A7ACB4 / mute #7C828B
    StrCpy $DshBgArgb 0xFF141417
    StrCpy $DshSurfaceArgb 0xFF1E1E23
    StrCpy $DshBorderArgb 0xFF2C2C33
    StrCpy $DshTextArgb 0xFFF2F3F5
    StrCpy $DshDimArgb 0xFFA7ACB4
    StrCpy $DshMuteArgb 0xFF7C828B
    StrCpy $DshPrimaryArgb 0xFF4D6BFE
    StrCpy $DshPrimaryHoverArgb 0xFF3D5BEE
    StrCpy $DshPrimaryPressedArgb 0xFF3350D8
    StrCpy $DshTrackArgb 0xFF2C2C33
    StrCpy $DshGhostHoverArgb 0xFF26262C
    StrCpy $DshDangerArgb 0xFFFF6B6B
    StrCpy $DshOnPrimaryArgb 0xFFFFFFFF
    StrCpy $DshBgColorref 0x00171414
    StrCpy $DshSurfaceColorref 0x00231E1E
    StrCpy $DshTextColorref 0x00F5F3F2
    StrCpy $DshDimColorref 0x00B4ACA7
    StrCpy $DshMuteColorref 0x008B827C
    StrCpy $DshDangerColorref 0x006B6BFF
    StrCpy $DshOnPrimaryColorref 0x00FFFFFF
    StrCpy $DshBrandPrefix "brand-dark"
    StrCpy $DshWhaleFile "$PLUGINSDIR\whale-dark.bmp"
    StrCpy $DshWhaleFile2x "$PLUGINSDIR\whale-dark-2x.bmp"
  ${Else}
    ; 亮色：bg #FFFFFF / surface #F3F4F7 / border #E3E5EA / text #0F1115 / dim #5A6069 / mute #7C828B
    StrCpy $DshBgArgb 0xFFFFFFFF
    StrCpy $DshSurfaceArgb 0xFFF3F4F7
    StrCpy $DshBorderArgb 0xFFE3E5EA
    StrCpy $DshTextArgb 0xFF0F1115
    StrCpy $DshDimArgb 0xFF5A6069
    StrCpy $DshMuteArgb 0xFF7C828B
    StrCpy $DshPrimaryArgb 0xFF4D6BFE
    StrCpy $DshPrimaryHoverArgb 0xFF3D5BEE
    StrCpy $DshPrimaryPressedArgb 0xFF3350D8
    StrCpy $DshTrackArgb 0xFFE7E9EE
    StrCpy $DshGhostHoverArgb 0xFFF3F4F7
    StrCpy $DshDangerArgb 0xFFD93A3A
    StrCpy $DshOnPrimaryArgb 0xFFFFFFFF
    StrCpy $DshBgColorref 0x00FFFFFF
    StrCpy $DshSurfaceColorref 0x00F7F4F3
    StrCpy $DshTextColorref 0x0015110F
    StrCpy $DshDimColorref 0x0069605A
    StrCpy $DshMuteColorref 0x008B827C
    StrCpy $DshDangerColorref 0x003A3AD9
    StrCpy $DshOnPrimaryColorref 0x00FFFFFF
    StrCpy $DshBrandPrefix "brand"
    StrCpy $DshWhaleFile "$PLUGINSDIR\whale.bmp"
    StrCpy $DshWhaleFile2x "$PLUGINSDIR\whale-2x.bmp"
  ${EndIf}
FunctionEnd

!endif
