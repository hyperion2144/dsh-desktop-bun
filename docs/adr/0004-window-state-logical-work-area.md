# ADR-0004: 窗口最大化态判定统一用 Electrobun 逻辑坐标系

- 状态：Accepted（2026-10-17）
- 关联：issue #73（启动恢复最大化图标）、#50（窗口三键）、#80（heal 落位自检）、#144（删窗口态推送）
- 决策人：实施轮（Agent）定位根因后提案；维护者按票面实机验收

## 背景

标题栏最大化/还原图标取决于 `window_get_state` 的 `maximized` 真值。该值一直由「原生旗标优先、
几何兜底」推导；Windows 的几何兜底拿 `BrowserWindow.getFrame()` 与 `user32 GetMonitorInfoW` 的
`rcWork` 直接比。但两者不在同一坐标系：`getFrame()` 是 Electrobun **逻辑 px**，`rcWork` 是**物理 px**。
2K@125% 实测最大化帧 2062.4×1118.4 = (2560+18)/1.25，rcWork 却是 2560×1380——四边全差一个缩放比，
几何兜底恒假。

启动恢复最大化时，`WS_MAXIMIZE` 旗标又因「从未显示过的窗上 `maximize()` 不落旗标」而缺失
（#73 五轮实证），窗口态于是被读成非最大化，标题栏在启动时画成单方框。旧实现的 8px 容差另有
第二重缺陷：THICKFRAME 隐形边框让最大化帧四边外扩（100% ≈9px/边、125% ≈7.2 逻辑px/边），
逐项比 width/height 要 ≥9px 容差才不漏判。

## 决策

1. **工作区改用 Electrobun `Screen.getAllDisplays()` 的 `workArea`（逻辑坐标），不再用 user32 物理 `rcWork`。**
   上游 2.0.2 的 Windows 侧 `serializeWindowsDisplay` 序列化的就是 `logicalBounds`/`logicalWorkArea`，
   与 `getFrame` 同空间（随包 API 包 `shared/windows-window-shell.test.ts` 钉住）。新增
   `screen-work-area.ts` 做纯几何选屏（重叠面积优先、中心最近兜底）；`index.ts` 只在 win32 注入，
   其余平台 / 读取失败一律 null。
2. **判定改逐边比对（左/上/右/下各 ±12px），不再比 width/height 差。** 补偿带让 x 与 width 同号
   同量偏移，逐边比只需一条容差且语义直白；12px 罩住 100% 的 9px 补偿带，也远小于任务栏 40+px
   与贴靠吸附误差。
3. **生产路径唯一**：状态查询、`#80` heal 自检、几何落盘三处共用同一个注入的 `workArea`；
   缺省 null = 只看原生旗标（与旧非 win32 语义一致）。删除仓内 user32 工作区 FFI。

## 备选与取舍

- **保留 user32 + 按显示器 DPI 把帧换算成物理 px**：要新增 `GetDpiForMonitor` FFI 与每屏 DPI
  拓扑处理，仍属自己维护坐标换算；Screen API 已给出同一空间的现成值。
- **只放宽容差**：125% 下四边差 20%（约 500px），容差放到那个量级会把普通窗口也判成最大化。
- **恢复 `window_state_changed` 推送**：#144 已按维护者要求整条删除；#73 的验收要求首查即真，
  推送只能掩盖判定错误，不能替代真值。

## 后果

- #73：旗标未落的启动首查靠几何判出最大化，标题栏画双框；#80 heal 在 125% 下读到同一空间，
  补偿带 7.4 逻辑px 由 12px 容差吸收，正常落位不再被误判。
- 依赖 Electrobun 的逻辑坐标承诺；若 `Screen.workArea` 将来退回物理 px，判定会整体偏大而恒真。
  `screen-work-area.test.ts` 的「物理工作区不再参与判定」用例与 `deriveMaximized` 注释是防回退钉。
- 删掉 user32 `GetMonitorInfoW`/`MonitorFromRect` 的 FFI 与结构体缓冲（约 60 行），取工作区只剩
  Electrobun API 一条路。

## 验证边界

本机 macOS，无法实机复现 Windows 窗口行为；回归钉用 #73 第五轮 2K@125% 实机日志原值
（逻辑帧 2062.4×1118.4、逻辑工作区 2048×1104）。Windows 实机验收由维护者按票面复验。
