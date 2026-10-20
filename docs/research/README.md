# 调研笔记索引

`docs/research/` 收录问题驱动的只读调查：每篇回答一个当时的具体问题，附证据与分级。调研是历史记录——结论落地后正文不随代码演进更新，读时以代码现状为准。

| 日期 | 笔记 | 触发 | 状态 |
| --- | --- | --- | --- |
| 2026-10-15 | [runtime-download-timeout-fallback](2026-10-15-runtime-download-timeout-fallback.md) | 运行时下载超时/进度条/回退 note 症状调查 | 已完成（落地于 #97） |
| 2026-10-15 | [windows-installer-nsis-portability](2026-10-15-windows-installer-nsis-portability.md) | 官方安装程序 NSIS includes 可移植性分析（map #87 研究票 #94） | 已完成（落地于 #88–#93、#103） |
| 2026-10-16 | [coldstart-tray-ordering](2026-10-16-coldstart-tray-ordering.md) | 冷启动时序与「DSH 起不来时的用户出口」 | 已完成（落地于 #117） |
| 2026-10-17 | [inspector-bootstrap-retry](2026-10-17-inspector-bootstrap-retry.md) | inspector 面板快捷键初载静默失效的 bootstrap 路径核实 | 已完成（落地于 #68） |
| 2026-10-17 | [macos-screenrecording-microphone-tcc](2026-10-17-macos-screenrecording-microphone-tcc.md) | macOS 屏幕录制/麦克风 TCC 记账与签名归属 | 已完成（落地于 #143） |
| 2026-10-17 | [windows-ci-webview2-cdp-smoke-elevation](2026-10-17-windows-ci-webview2-cdp-smoke-elevation.md) | Windows CI 打包态 WebView2 CDP 探活可行性（#109） | 已完成（落地于 #109） |
| 2026-10-17 | [windows-intl-default-locale](2026-10-17-windows-intl-default-locale.md) | Windows 上 Bun Intl 默认 locale 来源；#76 要不要补 win32 分支 | 已完成（结论被采纳：无需 win32 分支） |
| 2026-10-18 | [desktop-oauth-login-two-breaks](2026-10-18-desktop-oauth-login-two-breaks.md) | 桌面壳 OAuth 登录两处断点定位 | 已完成（落地于 #169、ADR-0007） |
| 2026-10-18 | [plugin-client-assets-local-serving](2026-10-18-plugin-client-assets-local-serving.md) | 插件 client 资产为何走 Host、本地直出的可行边界 | 现状调研（结论仍有效） |
| 2026-10-18 | [shell-sse-idle-timeout](2026-10-18-shell-sse-idle-timeout.md) | 壳反代 SSE 每 ~10s 被切断的 idleTimeout 定位 | 已完成（落地于 #159） |
| 2026-10-18 | [windows-tray-restart-launcher-unknown](2026-10-18-windows-tray-restart-launcher-unknown.md) | Windows 托盘「重启应用」第二次 launcher-unknown 诊断（#167） | 已完成（落地于 #167） |
| 2026-10-20 | [github-actions-desktop-mobile-build-split](2026-10-20-github-actions-desktop-mobile-build-split.md) | 桌面/移动端构建流水线拆分前的 GitHub Actions 触发语义核实（#212） | 已完成（结论见笔记） |
