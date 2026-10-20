# 0009 — 壳源码按域分目录

状态：Accepted（2026-10-19）

## 背景

`desktop-electrobun/src/bun/` 在迁移初期把全部模块平铺在一个目录（一度 76 个 `.ts` 文件），`src/shared/` 与 `desktop-plugin/src/client/` 同样平铺。文件名前缀（`window-*`、`update-notice-*`、`profile-*`）承担了本该由目录承担的分组职责；新模块没有明确的落点，域边界只存在于人的脑子里。

## 决策

按**运行时域**分一层子目录；目录名回答「这块代码为哪个运行时域服务」，不再用文件名前缀表达归属。

### `desktop-electrobun/src/bun/`

| 目录 | 域 | 内容 |
| --- | --- | --- |
| `host/` | 宿主生命周期与服务面 | service、host、host-supervisor、host-registry、supervisor（重启台账）、process-tree、account-watcher |
| `windows/` | 窗口与原生 UI | profile-session、window-*、update-notice-window/dialog/rpc、profile-dialog、guest-manager、titlebar/dialog-titlebar、splash、accept-shim、context-menu、devtools、native-webview、render-backend、screen-work-area、input-modal、menu、carrier、external |
| `commands/` | RPC 命令层 | commands、rpc、rpc-bridge、profile-op-rpc、update-notice-ops/check/store、downloads、diagnostics、register-cli |
| `net/` | loopback 服务面与转发 | shell-server、lane-forwarder、port-owner、notify-server、coalescing |
| `runtime/` | 运行时管理 | runtime、runtime-install、runtime-store |
| `profiles/` | profile 管理与插件物化 | profile-manager、profile-scaffold、profile-tree、profiles、plugin-staging |
| `notify/` | 通知与防休眠 | notifications、notify-un、notify-win、win-notify-identity、sound-playback、keep-awake |
| `platform/` | 系统集成与应用面 | app-restart、app-version、login-shell-env、single-instance、system-proxy、settings-store、shell-log、log-sink、locale、theme-source、keybindings、stages、updater、tray、tray-menu |
| 根 | 组合根与入口 | index（组合根）、serve（dev 入口）、preload（渲染器注入） |

### `desktop-electrobun/src/shared/`

`runtime/`（运行时与更新纯逻辑）、`net/`（准入 / 代理 / 端口 / 视图授权）、`notify/`（通知策略）、`settings/`（设置 schema 与主题）、`profiles/`（profile 运维纯逻辑）、`app/`（应用身份 / 账号 / 杂项纯逻辑）。

### `desktop-plugin/src/client/`

`bridge/`（宿主桥）、`shell/`（壳 RPC 与注入）、`features/`（功能页）、`ui/`（界面杂项）、`desktop-settings/`（设置面板，含 `cards/`）；根留插件入口 `index.ts` 与面板入口 `desktop-settings.tsx`。

## 取舍

- **只分一层**，不再往下细分：目录深度服务于「找一个文件」与「新文件有唯一落点」，两层以上会增加 import 相对路径噪音（`../../../../`）而收益递减。
- **组合根留根目录**：`index.ts` 是唯一的组合点（#179/#183 后它只做组装），留在根上强调「它不属于任何域，它消费所有域」。
- **测试目录保持平铺**：测试天然跨域引用（一个模块的单测常断言多个协作者），按域镜像目录收益低、改动面大。
- 归属按「运行时域」而非「技术分层」：`tray-menu` 归 `platform/`（托盘是系统集成）而不是 `ui/`；`update-notice-rpc` 归 `windows/`（它是弹窗的 RPC 附件）而不是 `commands/`——同一特性跨域拆开时，按**它绑定运行时的哪一面**落位。

## 后果

- 新文件问一句「服务哪个域」即有落点；域目录就是模块清单。
- import 相对层级普遍加深一层；跨域引用（如 `commands/` → `contracts/`）出现四层 `../`，是分层的显性成本，可接受。
- 后续新域（如独立的 `updates/`）从现有域拆出时，`git mv` + import 重写即可，无架构阻力。
