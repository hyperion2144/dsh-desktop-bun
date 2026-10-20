# Changelog（移动端）

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；本文件只记**移动端**（Android / iOS / HarmonyOS），桌面端见 [CHANGELOG.md](CHANGELOG.md)。

## [0.1.0] - 2026-10-20

首个版本：DeepSeek Harness 的移动形态——手机访问桌面 dsh。

- 三端原生壳：Android / iOS（Expo React Native）、鸿蒙（ArkTS + ArkWeb），共用配对逻辑层与设计令牌。
- 配对：`dsh-mobile://pair` 深链、鸿蒙扫码（ScanKit）、手输地址 + 令牌；令牌一次一用，换设备需桌面重新生成。
- dsh 页面加载：WebView / ArkWeb，手机布局由注入插件 dsh-mobile-nav 生效。
- 会话守卫：弱网宽容、回前台不误探测、退避可配 `mobile_guard_backoff_ms`。
- 运行时下载：按远程构建逐版本定位（CDN 探测，鸿蒙 npm 单包）；内置运行时跟随桌面 pin。
- 配对与直连适配：重复 Cookie 放行、无 cookie 引导重载、安卓 cleartext、iOS Hermes 兼容与安全区适配。
- CI 出包：Android / iOS 矩阵，鸿蒙 HAP 作业预留（自建 runner）。
