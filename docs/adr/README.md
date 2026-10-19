# ADR 索引

架构决策记录（Architecture Decision Records）：一条难逆转、脱离上下文会令人困惑、含真实取舍的决策一篇。新决策按日期追加编号，编号不复用、不改写——推翻旧决策就新写一篇并在状态行标注 supersede 关系。

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [0001](0001-windows-webview2-renderer.md) | Windows 渲染后端采用系统 WebView2，mac/linux 保持 CEF | Accepted（2026-10-15；#106 修订） |
| [0002](0002-notification-sound-backends.md) | 通知音播放按平台挑后端，「能不能响」作为数据面交给设置面板 | Accepted（2026-10-16） |
| [0003](0003-linux-keep-awake-inhibit.md) | Linux 防休眠走 logind/GNOME inhibit 的「持有进程 + 看门狗」 | Accepted（2026-10-16） |
| [0004](0004-window-state-logical-work-area.md) | 窗口最大化态判定统一用 Electrobun 逻辑坐标系 | Accepted（2026-10-17） |
| [0005](0005-shell-page-transport-boundary.md) | 壳↔页面通道：官方 Electrobun Typed RPC 是主路，`/__shell__/*` HTTP 降级为兼容与中继面 | Accepted（2026-10-17） |
| [0006](0006-builtin-runtime-as-first-class-candidate.md) | 内置运行时是一等候选，参与更新比较 | Accepted（2026-10-17） |
| [0007](0007-oauth-callback-admission-exemption.md) | OAuth 回调的准入窄豁免：只放跨站 GET 顶层文档导航 | Accepted（2026-10-18） |
| [0008](0008-shell-rpc-core-shared.md) | 壳 RPC 客户端收进 `shared/rpc/core.ts`：一处实现，preload / 两弹窗 / 插件四入口共用（supersede 0005 §3） | Accepted（2026-10-19） |
| [0009](0009-bun-source-domain-layout.md) | 壳源码按运行时域分一层子目录（host/windows/commands/net/runtime/profiles/notify/platform），组合根留根 | Accepted（2026-10-19） |

词表见根目录 [CONTEXT.md](../../CONTEXT.md)；调研笔记见 [docs/research/](../research/)。
