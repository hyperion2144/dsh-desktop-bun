# 官方安装程序 NSIS includes 可移植性分析

- 日期：2026-10-15
- 归属：wayfinder map #87（自定义 Windows 安装程序）· 研究票 #94
- 用途：本文是 #94 的交付物，供 #88（压缩+国际化）、#89（明暗主题）、#91（自定义 UI 页面）、#92（品牌资源）、#93（事务性安装）、#90（集成+测试+CHANGELOG）使用
- 证据来源（只读对照，本机镜像）：
  - 官方参考实现 `apps/desktop/` = `/Users/mutou/vault/projects/deepseek-harness/apps/desktop/`（票面写的 `D:/vault/projects/deepseek-harness/...` 即此目录）
  - 本仓现状 `desktop-electrobun/` = `/Users/mutou/vault/projects/dsh-desktop-bun/desktop-electrobun/`
- 判定口径（全文统一）：
  - **① 直接可移植**：纯 NSIS 核心 + NSIS 3.x 自带插件（nsDialogs / System / nsExec / LogicLib / FileFunc）即可落地，零自编译依赖
  - **② 需适配**：逻辑可用，但要针对本仓结构（生成式 `.nsi`、Electrobun payload `bin/launcher.exe` + `Resources/`、`$INSTDIR\App` 布局、`Unicode true`）改写
  - **③ 不可移植**：依赖官方自编译的 `window-frame.dll`，纯 NSIS 无等价物

## 0. 结论速览

1. **事务性安装 100% 是纯 NSIS 实现的**，官方并没有把它放进 C++：`apps/desktop/scripts/installer-directories.nsh`（135 行）用 `$INSTDIR.new-<GUID>` 暂存 → 两次 `Rename` promote → `RMDir /r "\\?\...old"` 提交，回滚也只有目录操作。→ 票 #93 不引任何依赖即可落地（见 §4）。
2. **`window-frame.dll` 只买三件事**：①窗口边框接管（无边框 + 阴影/圆角，靠 `SetWindowSubclass`）②进度页整窗 GDI+ 自绘（16ms 定时器 + 覆盖层）③受监督的 7za 解压（JobObject + `-bsp1` 进度管道）。前两件只影响观感，第三件**本仓根本不需要**——`build-windows-installer.mjs` 已在打包期把 `Resources/<hash>.tar.zst` 预解包进应用树，安装期没有解压阶段。
3. **官方 UI 的实现手段全部是 NSIS 层能写的**：`nsDialogs` + `NM_CUSTOMDRAW` 自绘 + `System::Call` 调**系统** DLL（`gdiplus.dll`/`user32`/`dwmapi`/`gdi32`）。`pages.nsh` 375 行里只有 1 处调 helper DLL（`pages.nsh:171`），`theme.nsh`/`drawing.nsh`/`strings.nsh` 零调用。→ 不引 C++ 的观感代价比预期小得多，官方 UI 代码约 90% 可原样搬。
4. **票面「当前 `desktop-electrobun/build/installer-windows.nsi`」是产物不是源文件**：它由 `build-windows-installer.mjs` 在打包时生成（`build-windows-installer.mjs` 中 `nsiPath = join(projectRoot,'build','installer-windows.nsi')`）。所以「include 化改造」的真实含义是把内联模板拆成 include 文件，且**必须同步 `desktop-electrobun/test/installer-nsis.test.ts`**——该测试按文本切片断言 `build-windows-installer.mjs` 的源码（`test/installer-nsis.test.ts:11-18`）。
5. **官方安装流程图**（对照本仓）：

   | 阶段 | 官方 | 本仓现状 |
   |---|---|---|
   | 载荷形态 | `app.7z` 归档，安装期用随包 `dsh-7za.exe` 解压 | 打包期已预解包成目录树，`File /r` 直接铺 |
   | 写入位置 | 暂存 `$INSTDIR.new-<GUID>` | 直接写 `$INSTDIR\App` |
   | 替换 | `Rename` 旧目录 → `.old-<GUID>`，新目录 → 正式名 | 无（覆盖写） |
   | 回滚 | 4 个触发点，纯目录操作 | 无 |
   | 进度 | DLL 覆盖层自绘 + stage 属性 | 原生 instfiles |
   | 主题 | 注册表探测 + `SetCtlColors` + GDI+ 自绘 | 无 |
   | 语言 | MUI2 + `installerLanguages:['en_US','zh_CN']` | `Unicode true` + 硬编码中文 |

## 1. 逐文件判定总表

| # | 官方文件 | 行数 | 判定 | 一句话策略 |
|---|---|---|---|---|
| 1 | `installer/pages.nsh` | 375 | ①主体 / ③1 处 | 欢迎页骨架+控件+自绘按钮整套搬；唯一 DLL 调用 `InstallerPresentWelcome` 换成 `System::Call 'user32::FlashWindowEx'` |
| 2 | `installer/theme.nsh` | 91 | ① 全量 | 整文件照搬：明暗探测（注册表）+ `/THEME=` 覆盖 + 双色板 |
| 3 | `installer/drawing.nsh` | 120 | ① 全量 | 整文件照搬：GDI+ 圆角路径/离屏位图/自绘勾选框 |
| 4 | `installer/strings.nsh` | 57 | ② | 机制是 NSIS 核心，但 `${LANG_ENGLISH}`/`${LANG_SIMPCHINESE}` 需语言装载（引 MUI2 最省事） |
| 5 | `installer/path.nsh` | 169 | ① 全量 | 整文件照搬：路径校验/保留设备名/reparse 拒绝/空间与可写探测，只用 System 插件 |
| 6 | `installer/lifecycle.nsh` | 90 | ①骨架 / ③3 处 | 首页/翻页/收尾骨架搬；`InstallerApplyFrame`/`InstallerShowProgress`/`InstallerFinishProgress` 三处 DLL 重写 |
| 7 | `installer/uninstall.nsh` | 36 | ①骨架 / ③1 处 | 引入它的守卫与顺序，丢掉 `un.RemoveData` 的 DLL 实现（见 §5.6） |
| 8 | `scripts/installer-directories.nsh` | 135 | ① 全量（3 处软依赖） | **事务核心，整文件照搬**，只把 `customInstallerExtract`/`installApplicationFiles`/`InstallerPublishStage` 换成 `File /r` 与 no-op |
| 9 | `scripts/installer.nsh` | 218 | ② 结构范本 | 不照搬内容，照搬 include 拆分与宏入口的组织方式 |
| 10 | `installer/window-frame.cpp` | 295 | ③ 全量 | 只作能力边界说明书（§3） |

## 2. 逐文件展开

### 2.1 `installer/pages.nsh`（375 行）

判定：①主体，唯一 ③ 在 `pages.nsh:171`。

可直接搬（都是纯 NSIS/nsDialogs/系统 DLL）：

- `pages.nsh:25` `InstallerPlace`（`MulDiv` 算 DPI + `MoveWindow` 手工布局）——官方不用 MUI 自动布局，控件位置全手算，本仓照抄即可规避 MUI 布局体系。
- `pages.nsh:34` `nsDialogs::Create 1018` + 返回 `error` 则 `Abort`；`nsDialogs::Show`（`:173`）。
- 控件与回调：`${NSD_CreateLabel/Button/Bitmap/Text/Checkbox}`（`:54-88`）、`${NSD_AddStyle} ${SS_NOTIFY}`、`${NSD_OnClick/OnNotify/OnChange}`、`${NSD_GetText/GetState/SetText/Check/Return}`、`${NSD_CreateTimer}`（路径编辑 450ms 防抖，`:247-280`）、`nsDialogs::SelectFolderDialog`。
- `pages.nsh:71-82` 品牌位图：`${NSD_CreateBitmap}` + `${NSD_SetStretchedImage}`，明暗两套 + 2x 分支。
- `pages.nsh:290-364` `InstallerPaintButton`：`NM_CUSTOMDRAW` + `gdiplus::GdipCreateSolidFill/GdipCreateFromHDC/GdipSetSmoothingMode/GdipFillPath/GdipCreatePen`，`${NSD_Return} 4`。**圆角抗锯齿按钮本来就是纯 NSIS 实现的。**
- `pages.nsh:204-207` 翻页：`SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT}(0x408) 1 0`（`pages.nsh:4` 定义常量）。
- `pages.nsh:282-286` 标题栏拖拽：`ReleaseCapture` + `WM_NCLBUTTONDOWN HTCAPTION`。
- `pages.nsh:210-245` 离开回调 + `StdUtils.ExecShellAsUser`（跑安装器/启动应用）。

需改写：

- `pages.nsh:171` `window-frame.dll::InstallerPresentWelcome(p $HWNDPARENT)` → 替代：`System::Call 'user32::FlashWindowEx(...)'`（`FLASHW_TRAY|FLASHW_TIMERNOFG`）+ `SetWindowPos(HWND_TOP, SWP_NOACTIVATE)`；等价物 `window-frame.cpp:285-294` 只有这两件事。
- `pages.nsh:91-158` 路径编辑行（去 `ES_*` 样式、`GetTextMetricsW` 手算行高做垂直居中、`EM_SETLIMITTEXT`）——可纯 NSIS 重写，是全文件最费工的一段，v1 可以简化成 `NSD_CreateText` + label，不必复刻像素级居中。

### 2.2 `installer/theme.nsh`（91 行）— ① 全量

- `theme.nsh:1-33` 设计 token：像素尺寸、`INSTALLER_FONT "Microsoft YaHei UI"`、GDI+ ARGB 与 COLORREF 双色板（`Var`）。
- `theme.nsh:43-49` `InstallerControlColors` 宏：`SetCtlColors ${HANDLE} FFFFFF 151517`（浅）/`0F1115 FFFFFF`（深）；`theme.nsh:42` 注释自陈约束——`SetCtlColors` 只吃编译期常量，所以只有两套原生色板。
- `theme.nsh:51-91` `InstallerResolveTheme`：`theme.nsh:54` `ReadRegDWORD $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" "AppsUseLightTheme"`，`0 → dark`，读失败按 light；再按明暗 `StrCpy` 整套调色板。
- 主题**必须在 `.onInit`（页创建前）解析**，`/THEME=auto|light|dark` 用 `${GetOptions}` 解析、非法值弹 `$(INSTALLER_THEME_ERROR)`（模式见 `scripts/installer.nsh:44-60`）。

结论：整文件可搬，**这是 #89 的主料**。不认 `SetCtlColors` 的控件（按钮/勾选框/进度条）走 §2.3 的自绘或 `uxtheme::SetWindowTheme` + `PBM_*`。

### 2.3 `installer/drawing.nsh`（120 行）— ① 全量

- `drawing.nsh:5-10` `InstallerPixelFont`：`MulDiv(-SIZE, dpi, 96)` + `CreateFontW "${INSTALLER_FONT}"`。
- `drawing.nsh:12-23` `InstallerRoundPath`：`GdipCreatePath/GdipAddPathArcI/GdipClosePathFigure`；`drawing.nsh:17` 注释说明「System.dll 没有 float 参数类型，弧角用 IEEE-754 位型传参」——可移植但脆，改动时要保留该手法。
- `drawing.nsh:25-45` `InstallerDrawEditFrame`：`GdipCreateBitmapFromScan0/GdipGraphicsClear/GdipDrawPath/GdipCreateHBITMAPFromBitmap` + `SendMessage ${STM_SETIMAGE}`（离屏位图当边框）。
- `drawing.nsh:48-120` `InstallerPaintCheckbox`：`NM_CUSTOMDRAW` + 圆角 + `gdi32::MoveToEx/LineTo` 画勾。

结论：整文件可搬（`gdiplus.dll` 是系统 DLL，不属于"引入 C++ 编译依赖"）。

### 2.4 `installer/strings.nsh`（57 行 / 28 个名字 × 中英）— ②

- `strings.nsh:2-57` 共 28 组 `LangString NAME ${LANG_ENGLISH}/... ${LANG_SIMPCHINESE}`，含 `%d%%`、`%s` 占位。
- 机制本身是 NSIS 核心，缺的是**语言装载**：官方靠 electron-builder 的 MUI2 模板 + `installerLanguages: ['en_US','zh_CN']`（`scripts/electron-builder-config.mjs:245`）。本仓 `.nsi` 是手写模板、无任何 include。
- 落地选项（#88 决策）：(a) 引 `!include MUI2.nsh` + `MUI_LANGUAGE`（可用 `${LANG_*}`、成本很低，推荐）；(b) 只做中文，把 28 组收成单语言 `LangString`，暂不引 MUI2。
- 硬约束：`build-windows-installer.mjs` 的模板已有 `Unicode true` 且写盘时加 BOM，**两者都必须保留**，否则中文快捷方式名乱码。

### 2.5 `installer/path.nsh`（169 行）— ① 全量

只用 `System::Call` 调 `kernel32`（`GetDriveTypeW`/`GetFileAttributesW`/`GetTempFileNameW`/`GetDiskFreeSpaceExW`/`GetFullPathNameW`）与 NSIS 内建。校验项（全部值得搬）：路径长度 4-180、盘符存在、非法字符、保留设备名（`CON`/`PRN`/`COM1-9`，`path.nsh:67`）、拒 reparse point（`path.nsh:86` `IntOp $1 $0 & 0x400`）、拒 `$WINDIR`/`$PROGRAMFILES`/`$PROFILE`/`$LOCALAPPDATA` 本体、占位非空目录校验、磁盘空间与可写性探测（`path.nsh:121` `InstallerPreflight`）。

唯一外部引用是 `${APP_64_UNPACKED_SIZE}`（electron-builder 提供的体积常量）→ 本仓改成打包期自算体积（`build-windows-installer.mjs` 已在数文件，可顺带算字节数）。

### 2.6 `installer/lifecycle.nsh`（90 行）— ①骨架 / ③3 处

- ③ `lifecycle.nsh:19` `window-frame.dll::InstallerApplyFrame`（无边框接管 + 隐藏原生控件 + DWM 阴影/圆角）、`:65` `::InstallerShowProgress`（进度覆盖层）、`:83` `::InstallerFinishProgress`（100% 收尾动画 750ms 自泵消息）。
- ① `lifecycle.nsh:5` `System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i 0x800A0000)'`（`WS_POPUP|WS_VISIBLE`，纯 NSIS 就能做无边框）；`lifecycle.nsh:24-34` 用 `GetDlgItem $0 $HWNDPARENT {1,2,3,1028,1256}` + `ShowWindow SW_HIDE` 藏原生控件——**纯 NSIS 已能藏控件，DLL 只是额外做了子类化**。
- ① 欢迎页/安装前钩子/完成页的骨架（`InstallerGuiInit`/`InstallerWelcome`/`InstallerBeforeInstall`/`InstallerFinish`）可照抄。

替代方案（#91 进度页，按风险升序）：

1. **v1 推荐**：保留原生 `Page instfiles` 当安装引擎，在 `MUI_PAGE_CUSTOMFUNCTION_SHOW`（=`InstallerProgressShow`）里藏掉原生控件，另建自有静态/位图子窗口，用 `${NSD_CreateTimer}` 轮询 `PBM_GETPOS`（`0x0408`）或自读 stage 属性刷新文案。
2. 圆角进度轨道：预渲染两张位图 + `STM_SETIMAGE` 换图（同 `drawing.nsh:25-45` 手法）。
3. 60fps 整窗自绘缓动（官方路线）：**只有 DLL 能做，明确放弃**。

### 2.7 `installer/uninstall.nsh`（36 行）— ①骨架 / ③1 处

- ③ `uninstall.nsh:9` `window-frame.dll::UninstallRemoveData`（reparse 安全的递归删除）、`:32` `::UninstallRemoveEmptyParents`。
- ①② 值得引入的骨架：`uninstall.nsh:13-15` `${isUpdated}` 早退、`:16-22` `/KEEP_APP_DATA` 守卫、`:13-35` 的顺序与作用域（**只删 Electron 用户数据/更新缓存，绝不碰 DSH home**）。
- 明确不要：默认删 `$APPDATA\<PRODUCT>`/`$APPDATA\<APP_PACKAGE_NAME>`/`$LOCALAPPDATA\<updaterCache>`（`uninstall.nsh:26-35`）——与本仓 #78 的「`.dsh` 主目录与用户数据不随卸载删」约定冲突；`UninstallRemoveEmptyParents` 向上清理 `$APPDATA` 风险更高。

### 2.8 `scripts/installer-directories.nsh`（135 行）— ① 全量（事务核心）

见 §4，它是本 map 里最值得原样搬的一份代码。

### 2.9 `scripts/installer.nsh`（218 行）— ② 结构范本

- `scripts/installer.nsh:11-30` `customHeader`：按 `BUILD_UNINSTALLER` 分流 include（`strings` 常驻；卸载态 include `uninstall.nsh`，安装态 include `theme/pages/lifecycle`）。
- `:86-88`/`:94-97`/`:99-101` 三个页面挂载宏：`Page custom InstallerWelcome InstallerWelcomeLeave`、`MUI_PAGE_CUSTOMFUNCTION_SHOW InstallerProgressShow`、`Page custom InstallerFinish InstallerFinishLeave`。
- `:104-120` `InstallerPublishStage`：`System::Call 'user32::SetPropW(p $HWNDPARENT, w "HarnessInstaller.Stage", p <n>)'`，且用 `System::Store /NOUNLOAD "S"` 保护栈与错误标志。本仓无 DLL 消费者时可直接 no-op 或改写成 DetailPrint。
- `:199-201` 仅安装态 `!include installer-directories.nsh`。
- 本仓要学的是**组织方式**：把生成式模板拆成 `strings/theme/pages/lifecycle/path/directories/(un)install` 若干 `.nsh`，由 `build-windows-installer.mjs` 组装（见 §5.1）。

## 3. `window-frame.dll` 依赖清单与替代（#93/#91/#89 的共同边界）

官方唯一自编译产物：`installer/window-frame.cpp`（295 行），由 `scripts/prepare-windows-installer.ps1:17` 用 MSVC 编译（`vswhere` 找 VS → `call vcvars32.bat` → `cl /LD /MT /O1 /W4 /WX /EHsc ... user32.lib comctl32.lib dwmapi.lib gdiplus.lib ole32.lib shell32.lib uuid.lib advapi32.lib`，x86）。编译期依赖 VS C++ Build Tools + Windows SDK；`electron-builder-config.mjs:119-124` 在 `beforeBuild` 里调它并随后签名。

| 导出（cpp:line） | 用途 | 调用点 | 纯 NSIS 替代 | 残留损失 |
|---|---|---|---|---|
| `InstallerApplyFrame`（cpp:256） | `SetWindowSubclass` 父窗口 + 隐藏 11 个原生控件 + `DwmExtendFrameIntoClientArea`/圆角属性 | `lifecycle.nsh:19` | 藏控件用 `GetDlgItem`+`ShowWindow`（`lifecycle.nsh:24-34` 已示范）；DWM 可用 `System::Call 'dwmapi::DwmSetWindowAttribute(...)'` | 无子类化 ⇒ 拿不到 `WM_NCCALCSIZE`/`WM_NCHITTEST`，DWM 阴影/圆角无法同时保留 |
| `InstallerShowProgress`（cpp:187） | 整窗 GDI+ 覆盖层 + 16ms 定时器 + 进度插值 | `lifecycle.nsh:65` | 原生进度条轮询 `PBM_GETPOS` / 定时换图（§2.6） | 60fps 缓动动画与统一视觉 |
| `InstallerFinishProgress`（cpp:222） | 750ms 自泵消息推到 100% | `lifecycle.nsh:83` | 预渲染 100% 位图 + `Sleep` | 收尾动画 |
| `InstallerPresentWelcome`（cpp:285） | `SetWindowPos`+`FlashWindowEx` | `pages.nsh:171` | 两条 `System::Call` 1:1 重写 | 无 |
| `InstallerExtract`（`extract.h:101`，不在 cpp 内） | JobObject 监督 7za + `-bsp1` 进度管道 | `scripts/installer.nsh:125` | **不需要**（打包期已预解包） | 无 |
| `InstallerReportExtractFailure`（cpp:22） | 自绘失败报告对话框（复制/展开/打开日志） | `scripts/installer.nsh:154` | `MessageBox` + 日志落盘（`$LOCALAPPDATA\<cache>\installer-logs\`） | 报告 UI 与一键复制 |
| `InstallerFindProcess`（cpp:56） | 进程检测（`isUpdated` 时 40×250ms 重试） | `scripts/installer.nsh:172,178` | `nsExec::ExecToStack 'tasklist /FI "IMAGENAME eq launcher.exe"'` 或 `FindWindow`/互斥体探测 | 精确度略降；本仓已有单实例互斥体可借 |
| `UninstallRemoveData`（cpp:45）/`UninstallRemoveEmptyParents`（cpp:50） | reparse 安全递归删除 | `uninstall.nsh:9,32` | 先摘 junction 再 `RMDir /r "\\?\..."` | 对异常 reparse 的兜底 |

## 4. 事务性安装：官方机制 → 本仓序列（#93 主料）

### 4.1 官方机制拆解（全部在 `installer-directories.nsh`）

- **暂存**：`installer-directories.nsh:32-42` `System::Call 'ole32::CoCreateGuid(g .r0) i .r1'` → `$dshNewDirectory = "$INSTDIR.new-$0"`、`$dshOldDirectory = "$INSTDIR.old-$0"` → `CreateDirectory`。暂存是**同卷兄弟目录**，不是 `$PLUGINSDIR`。
- **写入**：`:47-50` 取随包 7za（`File /oname=$PLUGINSDIR\dsh-7za.exe "${DSH_SEVENZIP_PATH}"`）→ `StrCpy $INSTDIR $dshNewDirectory`（临时改指向）→ `SetOutPath $INSTDIR` → `!insertmacro installApplicationFiles` → `:56` 恢复 `$INSTDIR`。
- **promote（原子替换）**：`:95-120` 先 `SetOutPath $PLUGINSDIR`（`:99` 注释：SetOutPath 持有目录句柄，两次 rename 前必须释放）→ `IfFileExists "$dshFinalDirectory\*.*"` 成立则 `Rename final old`（失败即回滚）→ `Rename new final`（失败即回滚）→ `SetOutPath final`。**只用 NSIS `Rename`，没有 MoveFileEx/目录交换。**
- **提交**：`:129-135` `dshFinishDirectories` 清 `$dshNewMoved` 标记并 `RMDir /r "\\?\$dshOldDirectory"`——删掉旧备份才算提交完成。
- **回滚触发点 4 个**：①解压失败 `:19`；②第一次 rename 失败 `:104-107`；③第二次 rename 失败 `:116-119`；④任何 `Quit` 路径：`:62 .onGUIEnd → :66 dshCleanupDirectories → :73 dshRollbackDirectories`，且 `scripts/windows-directory-installer.mjs:52` 用正则给上游模板里**每个 `Quit` 前插入 `Call dshCleanupDirectories`**（含"另一实例在跑"、silent 安装）。
- **回滚动作**：`:73-93` `SetOutPath $PLUGINSDIR` → 若新目录已就位 `RMDir /r "\\?\$dshFinalDirectory"` → `Rename old final` 还原备份（再失败则 `DetailPrint` 备份路径并**完整保留备份**，`:80-82`）→ `RMDir /r "\\?\$dshNewDirectory"` → 恢复 `$INSTDIR`。
- **注册表/快捷方式不在回滚范围**：`scripts/windows-directory-installer.mjs:40` 把 `Call dshPromoteDirectories` 插在模板的 `installApplicationFiles` 之后、`registryAddInstallInfo` 之前（顺序由 `tests/windows-directory-installer.spec.ts` 断言），所以 promote 失败时注册表还没写。**"先动目录、后写注册表"是这套事务的关键。**
- **7za 来源与签名**：`windows-directory-installer.mjs:60-73` 从 `app-builder-lib/out/toolsets/7zip.js` 取 `getPath7za()` 并 `signIf` 签名。本仓走 Electrobun 打包，没有这条链路（也正因为预解包而不需要）。

### 4.2 本仓等价序列（事务单元 = `$INSTDIR\App`）

本仓布局是 `$INSTDIR\App\{bin,Resources,...}`，注册表/快捷方式/卸载器全部指向 `$INSTDIR\App\...`（`build-windows-installer.mjs` 的 `nsiTemplate`），因此**搬 `App` 子目录即可，不需要动 `$INSTDIR` 本身**：

```nsis
Var AppFinal   ; $INSTDIR\App
Var AppNew     ; $INSTDIR\App.new-<GUID>
Var AppOld     ; $INSTDIR\App.old-<GUID>
Var OldMoved
Var NewMoved

Section "install"
  StrCpy $AppFinal "$INSTDIR\App"
  System::Call 'ole32::CoCreateGuid(g .r0) i .r1'
  StrCpy $AppNew "$AppFinal.new-$0"
  StrCpy $AppOld "$AppFinal.old-$0"
  CreateDirectory "$AppNew"
  SetOutPath "$AppNew"
  File /r "<packDir>\*.*"
  WriteUninstaller "$AppNew\uninstall.exe"     ; 卸载器必须写进暂存
  SetOutPath "$PLUGINSDIR"                     ; 释放目录句柄，否则 rename sharing violation
  ClearErrors
  IfFileExists "$AppFinal\*.*" 0 +4
    Rename "$AppFinal" "$AppOld"
    IfErrors rollback
    StrCpy $OldMoved 1
  Rename "$AppNew" "$AppFinal"
  IfErrors rollback
  StrCpy $NewMoved 1
  ; —— commit 之后才写注册表 / 快捷方式 / 卸载信息，再删 $AppOld
  IfFileExists "$AppOld\*.*" 0 +2
    RMDir /r "\\?\$AppOld"
  Goto done
rollback:
  Call dshRollbackDirectories
  SetErrorLevel 2
  Quit
done:
SectionEnd
```

回滚函数与官方 `:73-93` 同构（删已就位的 final → rename old 回 final → 删暂存 → 恢复 `$INSTDIR`），并同样挂到 `.onGUIEnd`（外加 `.onInstFailed`）与每个 `Quit` 前。

### 4.3 坑清单（每条都有官方依据）

1. `Rename` 目标必须不存在——官方先 `IfFileExists` 再改名（`:100-103`），不要赌覆盖语义。
2. 同卷才原子：暂存放 `$INSTDIR` 同级；**不要**用 `$PLUGINSDIR`（`%TEMP%`，可能异卷且会被清理）。本仓 `$INSTDIR=$LOCALAPPDATA\DSHDesktopBun`，同卷无碍。
3. `SetOutPath` 持有当前目录句柄 → 两次 `Rename` 前必须 `SetOutPath $PLUGINSDIR`（`:99`）。
4. 应用在跑 → `Rename $AppFinal` 必失败：先查进程（§3 的 `tasklist` 替代），命中就中止在"写暂存之前"或提示关闭后重试（官方 `isUpdated` 重试 10s，`scripts/installer.nsh:173-188`）。
5. 长路径：`RMDir /r "\\?\..."` 关掉路径规范化、只接受完整绝对路径；`File /r` 在**安装期**仍受 MAX_PATH 约束，深层 `node_modules` 是主风险（本仓 `.onInit` 已为长路径清过一次场）。
6. 注册表 `InstallDir`、快捷方式、`UninstallString` 保持指向 `$INSTDIR\App\...`，搬 `App` 不动它们。
7. `.onInit` 顺手清 `App.new-*`/`App.old-*` 陈旧残留（挂到现有 legacy 清场分支）。
8. silent / `Abort` / "另一实例在跑" 路径同样要回滚——学 `windows-directory-installer.mjs:52` 的"每个 `Quit` 前插清理"。
9. 不引 7za 时压缩用 NSIS 原生 `SetCompressor /FINAL /SOLID lzma`（+`SetCompressorDictSize`）；7za 路线的价值在"载荷是独立归档/需签名/需增量"，不在压缩率。

## 5. 本仓落点建议

### 5.1 结构：生成式模板 → include 拆分

- 现状：单个模板字符串（`build-windows-installer.mjs` 内 `nsiTemplate`）+ 生成的 `build/installer-windows.nsi`（已加 BOM）。
- 建议落点：仓内提交 `desktop-electrobun/build/installer/*.nsh`（`strings/theme/drawing/pages/lifecycle/path/directories/uninstall.nsh`），`build-windows-installer.mjs` 只负责：算路径与体积、拼 `!include`、注入可变部分（图标/输出路径/载荷重命名）、调 `makensis`。
- **同步改测试**：`desktop-electrobun/test/installer-nsis.test.ts:11-18` 通过 `readFileSync(build-windows-installer.mjs)` 再按 `Function un.CleanShellPluginLinks`/`Section "un.install"` 文本切片断言（#78 的卸载契约）。拆文件后必须把断言源改成新 `.nsh`（或让 `.mjs` 继续内联拼接），否则门禁红。**这是 #90 的必做项。**

### 5.2 品牌与图标资源（#92 输入）

官方用到 3 类资源：欢迎页品牌位图（`brand.png` 600×196 + 深色 + 各 @2x，`scripts/prepare-windows-installer.ps1:65-76` 转 BMP）、MUI 侧边栏 `uninstaller-sidebar.png` 164×314（`electron-builder-config.mjs:238-239`，要求 BMP）、应用图标 ico。

本仓现有 `desktop-electrobun/resources/app-icon.ico`（多尺寸，63KB）与 `tray.ico/tray.png`；**没有**品牌字标位图，也没有 164×314 侧边栏。落点建议：从 `app-icon.ico` 导出 BMP/位图（welcome 页品牌图用图标+文字合成或先用图标位图占位），侧边栏仅在引 MUI2 时才需要。

### 5.3 语言（#88 输入）

见 §2.4。推荐 v1 引 MUI2：`!include MUI2.nsh` + `!insertmacro MUI_LANGUAGE English`/`SimpChinese`（常量 `${LANG_ENGLISH}`/`${LANG_SIMPCHINESE}` 由 MUI2 提供），同时保住 `Unicode true` + BOM。

### 5.4 压缩（#88 输入）

官方在 electron-builder 里没有单独配压缩（`electron-builder-config.mjs:238-247` 只有 sidebar/include/`oneClick:false`/`perMachine:false`/`allowElevation:false`/`allowToChangeInstallationDirectory:false`/`installerLanguages`/`differentialPackage:true`），压缩由 electron-builder 模板默认带。本仓要在 `.nsi` 顶显式写：`SetCompressor /FINAL /SOLID lzma`（+ 必要时 `SetCompressorDictSize`）。**压缩率与安装耗时必须实测**（macOS 上无法测，需 Windows 真机/CI）——这是 map 的 fog 项之一，建议在 #88 里做一次 before/after 测量并记进票。

### 5.5 与 `Unicode true`、MAX_PATH 清场的既有约定

现有 `.nsi` 的三条既存约束不要动：`Unicode true`（中文快捷方式名）、`.onInit` 旧双层布局清场（长路径）、`un.CleanShellPluginLinks`。

### 5.6 卸载侧修正（可并入 #93 或单开）

- 顺序修正：先 `un.CleanShellPluginLinks`（摘 junction），再 `RMDir /r "$INSTDIR\App"`；本仓现状相反（junction 在被递归删除的树内）。
- `RMDir /r "\\?\$INSTDIR\App"` 走长路径形式。
- 收尾 `RMDir "$INSTDIR"`（非递归，删空根目录）。
- `/KEEP_APP_DATA` + `${isUpdated}` 守卫：只有将来做"旧卸载器就地升级"时才需要，可先留注释位。

## 6. 未决 / 需 Windows 真机验证

1. 从 instfiles 的 SHOW 回调往 `$HWNDPARENT` 挂自建子窗口（`CreateWindowExW`）是否与原页面板/布局冲突——纯 NSIS 进度覆盖层的关键假设，未在真机验证（#91 风险点）。
2. `${LANG_*}` 常量在**不引 MUI2** 的纯 `LoadLanguageFile` 下是否可用；`${PBM_GETPOS}` 在 CI 的 NSIS 版本（choco nsis）常量是否存在（否则写 `0x0408` 字面量）。
3. 无子类化、仅 `WS_POPUP`（`lifecycle.nsh:5` 的 `0x800A0000`）时 DWM 是否真无阴影/圆角；能否仅靠 `System::Call 'dwmapi::DwmExtendFrameIntoClientArea'` 挽回观感（Win10 vs Win11 可能不同）。
4. `File /r` 在安装期写超 260 字符目标路径的失败边界（本仓注释只覆盖源侧）。
5. `RMDir /r "\\?\..."` 在 NSIS 3.x 对子路径是否全部生效（官方只用于删 new/old 暂存目录）。
6. 压缩率 / 安装时长实测（fog 项，归 #88）。
7. 本仓 Windows 产物树的确切布局需在 Windows CI 上确认一次（macOS 对照：`DeepSeek Harness Desktop BUN-dev.app/Contents/{MacOS,Resources/app/{bin,bun,dsh,plugins,runtime}}`；Windows 侧应为 `<AppDir>/bin/launcher.exe` + `<AppDir>/Resources/...`，`pickBuildDir/findLauncher` 已按此假设实现）。

## 附录 A：证据索引（关键 file:line）

| 主题 | 证据 |
|---|---|
| 事务暂存/改名/回滚 | `apps/desktop/scripts/installer-directories.nsh:32,41,42,48,49,50,58,73,95,100,103,115,129,132` |
| 每个 Quit 前插清理 | `apps/desktop/scripts/windows-directory-installer.mjs:40,52` |
| 7za 来源与签名 | `apps/desktop/scripts/windows-directory-installer.mjs:60,70,73` |
| DLL 编译（MSVC cl） | `apps/desktop/scripts/prepare-windows-installer.ps1:17,10` |
| DLL 装载与签名 | `apps/desktop/scripts/installer.nsh:68,170`；`apps/desktop/scripts/electron-builder-config.mjs:119,123` |
| 事务性安装入口宏 | `apps/desktop/scripts/installer.nsh:199-201,202-218` |
| 进度/边框/收尾 DLL 调用 | `apps/desktop/installer/lifecycle.nsh:5,19,65,83` |
| 欢迎页唯一 DLL 调用 | `apps/desktop/installer/pages.nsh:171` |
| 自绘按钮/圆角 | `apps/desktop/installer/pages.nsh:290-364`；`apps/desktop/installer/drawing.nsh:12-23,25-45,48-120` |
| 明暗主题探测 | `apps/desktop/installer/theme.nsh:43-49,51-91`（注册表键在 `:54`） |
| 路径校验 | `apps/desktop/installer/path.nsh:3,67,86,121` |
| 语言配置 | `apps/desktop/scripts/electron-builder-config.mjs:238-247` |
| 本仓生成式 .nsi 与 payload 预解包 | `desktop-electrobun/scripts/build-windows-installer.mjs`（`nsiTemplate`/`payloadPreExtracted`/`nsiPath`） |
| 本仓卸载契约测试 | `desktop-electrobun/test/installer-nsis.test.ts:11-18` |
