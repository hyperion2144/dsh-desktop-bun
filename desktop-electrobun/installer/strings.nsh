; DeepSeek Harness 安装程序 ── 多语言文案表（#88）
;
; NSIS 的安装器文案有自己独立的语言表：它**不跟随应用内 locale**，而是由 exehead 在启动时
; 按系统 UI 语言在已装载的语言表里挑一个；**都不匹配时用第一个装载的语言表**（`lang.cpp` 写表时倒序、
; exehead 从尾往前扫 ⇒ 先装载的胜出；`langs.but` 也这么说：把常用语言放第一个）——所以下面英文排第一。
; 本安装器另外在 .onInit 里显式选一次语言（DshResolveLanguage），不把行为挂在装载顺序上。
;
; 用法约定（重要）：
;   · 引用一律写运行期形式 $(DSH_TEXT_XXX)；**不要**再用 !define + ${DSH_TEXT_XXX}，
;     否则文案会在编译期定死成一种语言（早期版本就是这么写的，#88 起废弃）。
;   · 需要拼接运行期变量时不要塞进 LangString（见下方 DSH_TEXT_DONE_BODY 的写法），
;     在调用点用普通字符串拼接，例如：StrCpy $0 "$(DSH_TEXT_DONE_BODY) $INSTDIR"
;   · 换行写 NSIS 的 $\n（不是 \n）；字面美元写 $$。
;
; 加一门语言：① 装载段补一行 LoadLanguageFile "<LangDir>\<Name>.nlf"（**第一个装载的就是回退语言**）；
;             ② 给每条 LangString 补一行同名 ${LANG_<Name>} 的译文——漏了只报 warning 6040、运行期渲染**空串**
;                （不是英文回退），所以构建用 -WX 把这条 warning 当错误，测试也逐条断言双语齐全；
;             ③ 若要按系统语言自动切到它，在 DshResolveLanguage 里补一条主语言分支。
;
; 依赖：主 .nsi 已 !include 本文件（由 installer/ui.nsh 负责），且本文件必须在任何
;       $(DSH_TEXT_*) 使用点之前被 include。

!ifndef DSH_INSTALLER_STRINGS
!define DSH_INSTALLER_STRINGS

; 装载语言表：直接用 LoadLanguageFile，**不用** MUI2 的 MUI_LANGUAGE——
;   · MUI2 的 Interface.nsh 会定义 Function .onGUIInit，与本安装器自己的 .onGUIInit
;     （无边框品牌窗初始化）撞车，makensis 直接报 "Function named \".onGUIInit\" already exists"；
;   · MUI_LANGUAGE 会顺带执行 MUI_INTERFACE：XPStyle On / ChangeUI modern.exe / 把 Icon 与 UninstallIcon
;     改成 MUI 自带的 modern-*.ico（会盖掉本安装器指定的 app-icon.ico）；且没有 MUI_PAGE_* 时
;     每种语言还各告警一条 "should be inserted after the MUI_[UN]PAGE_* macros"。
; MUI_LANGUAGE 内部（Localization.nsh 的 MUI_LANGUAGEEX）做的也正是 LoadLanguageFile，两者等价。
!include "LogicLib.nsh"
; ① 简中先装载 = 它是「系统语言全不匹配」时的回退语言（产品是中文优先：维护者 2026-10-16 拍板）
LoadLanguageFile "${NSISDIR}\Contrib\Language files\SimpChinese.nlf"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\English.nlf"


; 语言选择：exehead 自己就会选（完全匹配 → 主语言匹配 → 回退到**第一个装载**的表），这里再显式写一遍；
; 产品口径：默认简中，需要英文用 /LANG=en（.onInit 在调用本函数后解析 /LANG=）——英文按需选，不按系统猜。
; 写在 .onInit 里是 NSIS 的正规做法（MUI 的 MUI_LANGDLL_DISPLAY 同样在 .onInit 里 StrCpy $LANGUAGE）。
!define DSH_LANG_ID_ENGLISH 1033
!define DSH_LANG_ID_SIMPCHINESE 2052

Function DshResolveLanguage
  ; 默认简中（中文优先；英文走 /LANG=en 显式选择）
  StrCpy $LANGUAGE ${DSH_LANG_ID_SIMPCHINESE}
FunctionEnd

; ── 品牌 / 欢迎页 / 完成页 ─────────────────────────────────────────────────
LangString DSH_TEXT_APP_NAME ${LANG_ENGLISH} "DeepSeek Harness DesktopBUN"
LangString DSH_TEXT_APP_NAME ${LANG_SIMPCHINESE} "DeepSeek Harness DesktopBUN"

LangString DSH_TEXT_HEADLINE ${LANG_ENGLISH} "DeepSeek Harness DesktopBUN"
LangString DSH_TEXT_HEADLINE ${LANG_SIMPCHINESE} "DeepSeek Harness DesktopBUN"

LangString DSH_TEXT_SUBTITLE ${LANG_ENGLISH} "Installs for the current user. No administrator rights required."
LangString DSH_TEXT_SUBTITLE ${LANG_SIMPCHINESE} "按当前用户安装，不需要管理员权限。"

LangString DSH_TEXT_LOCATION ${LANG_ENGLISH} "Install to"
LangString DSH_TEXT_LOCATION ${LANG_SIMPCHINESE} "安装位置"

LangString DSH_TEXT_HINT ${LANG_ENGLISH} "Needs 1.2 GB of disk space · %LOCALAPPDATA%\\DSHDesktopBun"
LangString DSH_TEXT_HINT ${LANG_SIMPCHINESE} "需要 1.2 GB 磁盘空间 · %LOCALAPPDATA%\\DSHDesktopBun"

LangString DSH_TEXT_CHOOSE_PATH ${LANG_ENGLISH} "Choose installation folder"
LangString DSH_TEXT_CHOOSE_PATH ${LANG_SIMPCHINESE} "选择安装位置"

LangString DSH_TEXT_BROWSE ${LANG_ENGLISH} "Browse…"
LangString DSH_TEXT_BROWSE ${LANG_SIMPCHINESE} "选择…"

LangString DSH_TEXT_CANCEL ${LANG_ENGLISH} "Cancel"
LangString DSH_TEXT_CANCEL ${LANG_SIMPCHINESE} "取消"
LangString DSH_TEXT_HEADER ${LANG_ENGLISH} "Install DeepSeek Harness DesktopBUN"
LangString DSH_TEXT_HEADER ${LANG_SIMPCHINESE} "安装 DeepSeek Harness DesktopBUN"
LangString DSH_TEXT_FREE ${LANG_ENGLISH} "$1 GB free"
LangString DSH_TEXT_FREE ${LANG_SIMPCHINESE} "$1 GB 可用"

LangString DSH_TEXT_INSTALL ${LANG_ENGLISH} "Install now"
LangString DSH_TEXT_INSTALL ${LANG_SIMPCHINESE} "立即安装"
LangString DSH_TEXT_DISK_NOTE ${LANG_ENGLISH} "Keep about 1 GB free on the target drive."
LangString DSH_TEXT_DISK_NOTE ${LANG_SIMPCHINESE} "建议目标磁盘预留 1 GB 以上可用空间。"

LangString DSH_TEXT_PROGRESS_H1 ${LANG_ENGLISH} "Installing"
LangString DSH_TEXT_PROGRESS_H1 ${LANG_SIMPCHINESE} "正在安装"

 

LangString DSH_TEXT_DONE_HEADLINE ${LANG_ENGLISH} "Installation complete"
LangString DSH_TEXT_DONE_HEADLINE ${LANG_SIMPCHINESE} "安装完成"

; 只到「已安装到」为止，安装目录由调用点拼在后面（LangString 里不放运行期变量）
LangString DSH_TEXT_DONE_BODY ${LANG_ENGLISH} "Installed to"
LangString DSH_TEXT_DONE_BODY ${LANG_SIMPCHINESE} "已安装到"

LangString DSH_TEXT_FINISH ${LANG_ENGLISH} "Finish"
LangString DSH_TEXT_FINISH ${LANG_SIMPCHINESE} "完成"

LangString DSH_TEXT_LAUNCH ${LANG_ENGLISH} "Launch DeepSeek Harness DesktopBUN"
LangString DSH_TEXT_LAUNCH ${LANG_SIMPCHINESE} "立即启动 DeepSeek Harness DesktopBUN"
LangString DSH_TEXT_LAUNCH_SUB ${LANG_ENGLISH} "You can launch it later from the Start menu."
LangString DSH_TEXT_LAUNCH_SUB ${LANG_SIMPCHINESE} "可以稍后从开始菜单启动。"

; ── 提示 / 报错 ───────────────────────────────────────────────────────────
LangString DSH_TEXT_LAUNCH_FAILED ${LANG_ENGLISH} "DeepSeek Harness could not be started. Open it from the Start menu."
LangString DSH_TEXT_LAUNCH_FAILED ${LANG_SIMPCHINESE} "无法启动 DeepSeek Harness，请从开始菜单手动打开。"

LangString DSH_TEXT_UI_ERROR ${LANG_ENGLISH} "The installer window could not be initialized. Close it and try again."
LangString DSH_TEXT_UI_ERROR ${LANG_SIMPCHINESE} "无法初始化安装窗口，请关闭后重试。"

LangString DSH_TEXT_THEME_ERROR ${LANG_ENGLISH} "Invalid theme. Use /THEME=light, /THEME=dark or /THEME=auto."
LangString DSH_TEXT_THEME_ERROR ${LANG_SIMPCHINESE} "主题参数无效：仅支持 /THEME=light|dark|auto。"

LangString DSH_TEXT_PATH_EMPTY ${LANG_ENGLISH} "Enter an installation folder."
LangString DSH_TEXT_PATH_EMPTY ${LANG_SIMPCHINESE} "请填写安装位置。"

LangString DSH_TEXT_PATH_INVALID ${LANG_ENGLISH} "Choose a full folder path on a local disk. Drive roots are not supported."
LangString DSH_TEXT_PATH_INVALID ${LANG_SIMPCHINESE} "请选择本地磁盘上的完整文件夹路径（不能用磁盘根目录）。"

LangString DSH_TEXT_PATH_UNWRITABLE ${LANG_ENGLISH} "This location is not writable. Choose a folder the current user can write to; the installer does not request administrator rights."
LangString DSH_TEXT_PATH_UNWRITABLE ${LANG_SIMPCHINESE} "无法写入此位置，请换一个当前用户可写的文件夹（安装程序不申请管理员权限）。"

; ── 进度页状态行（安装段逐步替换）─────────────────────────────────────────
LangString DSH_TEXT_PREPARING ${LANG_ENGLISH} "Preparing installation…"
LangString DSH_TEXT_PREPARING ${LANG_SIMPCHINESE} "正在准备安装…"

LangString DSH_TEXT_COPYING ${LANG_ENGLISH} "Installing files…"
LangString DSH_TEXT_COPYING ${LANG_SIMPCHINESE} "正在安装文件…"

LangString DSH_TEXT_REGISTERING ${LANG_ENGLISH} "Creating shortcuts…"
LangString DSH_TEXT_REGISTERING ${LANG_SIMPCHINESE} "正在创建快捷方式…"

LangString DSH_TEXT_FINALIZING ${LANG_ENGLISH} "Cleaning up the previous version…"   ; 第 4 步实际内容 = 删除旧版本备份（GB 级，真机可达分钟级）
LangString DSH_TEXT_FINALIZING ${LANG_SIMPCHINESE} "正在清理旧版本…"

LangString DSH_TEXT_PROGRESS_HEADLINE ${LANG_ENGLISH} "Installing"
LangString DSH_TEXT_PROGRESS_HEADLINE ${LANG_SIMPCHINESE} "正在安装"

; ── 安装 / 卸载的前置检查 ─────────────────────────────────────────────────
LangString DSH_TEXT_RUNNING ${LANG_ENGLISH} "DeepSeek Harness is running. Quit it from the system tray and try again."
LangString DSH_TEXT_RUNNING ${LANG_SIMPCHINESE} "DeepSeek Harness 正在运行，请先在系统托盘中退出应用后重试。"
LangString DSH_TEXT_RUNNING_ASK ${LANG_ENGLISH} "DeepSeek Harness is running. End it and continue installing?"
LangString DSH_TEXT_RUNNING_ASK ${LANG_SIMPCHINESE} "检测到 DeepSeek Harness 正在运行。要结束它并继续安装吗？"
LangString DSH_TEXT_RUNNING_KILL_FAILED ${LANG_ENGLISH} "Could not end the running instance. Quit it manually and try again."
LangString DSH_TEXT_RUNNING_KILL_FAILED ${LANG_SIMPCHINESE} "无法结束正在运行的实例，请手动退出后重试。"

LangString DSH_TEXT_RUNNING_UNINSTALL ${LANG_ENGLISH} "DeepSeek Harness is running. Quit it in full before uninstalling."
LangString DSH_TEXT_RUNNING_UNINSTALL ${LANG_SIMPCHINESE} "检测到应用正在运行，请先完全退出再卸载。"

LangString DSH_TEXT_INSTALL_FAILED ${LANG_ENGLISH} "Installation did not finish. No changes were made to your system; run the installer again to retry."
LangString DSH_TEXT_INSTALL_FAILED ${LANG_SIMPCHINESE} "安装未完成。系统未做改动，可重新运行安装程序重试。"

LangString DSH_TEXT_LEGACY_TITLE ${LANG_ENGLISH} "An older DeepSeek Harness installation was found."
LangString DSH_TEXT_LEGACY_TITLE ${LANG_SIMPCHINESE} "检测到旧版 DeepSeek Harness 安装。"

LangString DSH_TEXT_LEGACY_BODY ${LANG_ENGLISH} "It will be moved to a shorter folder (Windows path length limits) and the old folder will be deleted. Continue?"
LangString DSH_TEXT_LEGACY_BODY ${LANG_SIMPCHINESE} "将迁移到更短的安装目录（Windows 路径长度限制）并删除旧目录，继续？"


; ── 开始菜单 / 卸载入口 ───────────────────────────────────────────────────
LangString DSH_TEXT_UNINSTALL_SHORTCUT ${LANG_ENGLISH} "Uninstall DeepSeek Harness DesktopBUN"
LangString DSH_TEXT_UNINSTALL_SHORTCUT ${LANG_SIMPCHINESE} "卸载 DeepSeek Harness DesktopBUN"

!endif
