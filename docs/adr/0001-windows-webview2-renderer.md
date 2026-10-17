# ADR-0001: Windows 渲染后端采用系统 WebView2，mac/linux 保持 CEF

- 状态：Accepted（2026-10-15）；2026-10-16 经 #106 修订（win 打包态 DevTools 双载体，见「#106 修订」）
- 关联：issue #84；动机链 #82（cottontail 调研）、Windows 卡顿调研；#106 修订（win 打包态 DevTools 恢复）
- 决策人：维护者（跳过前置判别实验，直接实施）

## 背景

用户主诉 Windows 上 BUN 版桌面明显卡顿（页面不在对话状态也卡）；同机对照官方 Electron 版流畅、arcreel Tauri（WebView2）版一般。

源码级根因（Electrobun 上游 `package/src/native/win/nativeWrapper.cpp`）——Windows CEF 走 OSR 离屏渲染，三重结构性劣势：

1. **30fps 上限**：`windowless_rendering_enabled = true`（:7030）但未设 `windowless_frame_rate`（:8480 仅设 `background_color`）→ CEF 默认 30fps；
2. **全帧 CPU 回传**：`OnPaint`（:2854）→ `UpdateBuffer` 整帧 memcpy（W×H×4 BGRA，4K ≈ 33MB/帧）；`OnAcceleratedPaint`（GPU 零拷贝共享纹理）全仓零命中（CEF issue #1006 长期缺口）；
3. **GDI 上屏**：`UpdateLayeredWindow()` 分层窗口提交（为透明窗口设计，不走 DXGI flip，每帧全帧 GDI 提交 + DWM 重合成）。

引擎层等价的权威背书：Electron 官方博客（WebView2 团队联合审阅）——「渲染 web 内容时 Electron、WebView2 与任何其他 Chromium 渲染器预期几乎无性能差异——Chromium is Chromium」。

CEF 的存在理由（Electrobun 官方 Bundling CEF 文档）只有：pin 浏览器版本、`<electrobun-webview>` 的 masks/input passthrough（Windows 专属）。dsh 壳两者都不使用（BrowserWindow/BrowserView 普通窗口加载 loopback URL，无透明窗口、无 electrobun-webview 标签）。

## 决策

Windows 渲染后端切换为系统 WebView2（`renderer: 'native'`），**平台条件化**：

- `electrobun.config.ts`：`win: { bundleCEF: false, defaultRenderer: 'native' }`；mac/linux 保持 `{ bundleCEF: true, defaultRenderer: 'cef' }`
- `src/bun/index.ts`：建窗 renderer 不再写死 `'cef'`，改随 `availableRenderers` 推导（`wantsCef ? 'cef' : 'native'`）；启动断言平台化——win 构建出现 CEF 即 fail(3)，mac/linux 缺 CEF 即 fail(3)
- `src/bun/devtools.ts`：`planDevToolsBoot` 新增 `cefAvailable` 输入（缺省 true）；无 CEF 构建打包态出 `reason: 'cef-only'` fail-closed（不开 CDP 口、不出 DevTools 菜单），dev 态照旧（`openDevTools()` 与后端无关）——**#106 修订废止**：不再以 cef-only 整体 fail-closed，见下「#106 修订」

macOS 保持 CEF 的理由不变：WKWebView 是 WebKit，渲染一致性是当初 bundle CEF 的原始动机；且 mac 的 CEF 路径走 CAMetalLayer 合成，无 Windows 的 OSR 税。Linux 同理保持 CEF（WebKitGTK 引擎最弱、且整进程只能单实现）。

## 后果

- 正面：win 帧路径从 30fps 上限 + 全帧 memcpy + GDI 提交变为 Chromium 直绘；包体约 -150MB（CEF 不再打包）；回到 Electrobun「系统 webview 即 better default」的官方默认路径
- 代价：~~win 打包态失去 CEF remote-debugging CDP 口~~（初版判断；#106 修订恢复，见下）；WebView2 依赖系统 Evergreen Runtime（Win11 inbox，Win10 普及率高）
- 风险下限：WebView2 与 CEF 同为 Chromium，渲染一致性无损；若页面层另有 Windows 共性卡顿，切换改善幅度打折但不劣于现状
- 回退：revert 单提交即恢复 win 三处 CEF 开关（契约表述随提交回滚）

## #106 修订（2026-10-16）：win 打包态 DevTools 双载体

维护者拍板「最好能支持 devtools」（#106 Q1=(a)）。cef-only fail-closed 在诊断中被定性为 #84 契约的第四处遗漏：#69 设置页开关（desktop-plugin）未随平台条件化，「开关可用但功能不生效」。修订为——门控与 fail-closed 不变，载体随平台：

- 同一套 `planDevToolsBoot`（平台无关）+ `devToolsMenuEnabled`（打包态可见 ⇔ 口已开，禁中间态）
- CEF（mac/linux）：`ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT=N`（libSystem setenv 双写）→ 菜单「打开 DevTools」
- win WebView2：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`（kernel32 SetEnvironmentVariableA 双写，已有值追加不覆盖）＝`--remote-debugging-port=N`：CDP 口可外部附加；DevTools 不自动弹窗（`--auto-open-devtools-for-tabs` 曾随返工一引入，实测逐窗都弹、含 splash，维护者否决，返工二移除）
- win（dev/打包同形态）：菜单「打开 DevTools」＝壳经 user32 `keybd_event` 合成 F12（与物理按键同路径；WebView2 默认 `AreDevToolsEnabled=true`，上游壳未关）。初版「复制 DevTools 调试地址」（edge://inspect 形态）经维护者实测否决——CDP 地址贴浏览器是空白页——返工废弃；dev_tools 设置键名不变
- 语义边界：dev_tools 开关管控 CDP 口与菜单入口；F12 是 WebView2 默认能力（settings 层在 native），开关管不住——要关需上游接线 AreDevToolsEnabled（#106 Q3 拍板不去上游）
- 实现收拢（#110）：上述载体差异（env 名/值编码、C environ 写入器、DevTools 打开方式）统一收在 `src/bun/render-backend.ts` 的渲染后端描述符；`applyCdpDebugPort` 的 `cefAvailable` 入参与 `plan.menuEnabled` 字段已不存在，行为与本节口径一致。
## 验证边界

本机为 macOS，Windows 产物验证（WebView2 加载 dsh、token 准入、xterm 终端、包体对比）依赖 native runner 构建，由 CI Windows 兜底 job 与维护者实机完成；macOS 侧以门禁（typecheck + bun test 全绿）与单测覆盖决策层语义。

CI 产物断言（`scripts/assert-artifact.mjs`）随本决策平台条件化：mac/linux 正断言 CEF 载荷必须存在，win 反向断言 CEF 载荷不得出现（`libcef.dll`/`chrome_elf.dll`）——两向都是策略回归的硬门禁（集成分支实测：win 断言未条件化时 CI 在产物断言处报「应用树缺 CEF 标志：libcef.dll」而挂）。反向断言的本地探针验证（伪造 win/mac 产物）覆盖：win 无 CEF 不误报、win 出现 `libcef.dll` 正确报错、mac 缺失 CEF 正确报错。
