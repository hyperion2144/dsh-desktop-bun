# dsh-desktop-bun

DeepSeek Harness 的独立桌面壳：**Electrobun 2.0.2（stable）+ CEF（Blink/V8 渲染）+ Bun 1.4.0（主进程与 dsh 宿主）**。
由 [hyperion2144/dsh-desktop-tauriapp](https://github.com/hyperion2144/dsh-desktop-tauriapp) 的
`map/204-electrobun-shell` 迁移线整体迁出（A8 迁移，#220/#204）；旧仓保留 Tauri 壳作回退（v0.12.0）。

换壳动机：macOS 26+ 系统 WKWebView（JavaScriptCore）上流式会话页面反复触发 JSC JIT tier-up
崩溃 → 白屏自动刷新（旧仓 #200，13+ 次实锤崩溃）。CEF 渲染彻底换掉 JSC；Bun 主进程替换
随包 Node sidecar。

## 布局

| 目录 | 内容 |
| --- | --- |
| `desktop-electrobun/` | 壳本体（TypeScript/Bun/Electrobun）：窗口、托盘、通知、设置、RPC、插件 staging、运行时管理 |
| `desktop-plugin/` | 桌面插件包 `dsh-desktop-bun`（原 `dsh-desktop-tauriapp`，A10 改名）：壳 chrome 客户端 + 技能 |
| `plugins/dsh-mobile-access/` | 手机访问插件包（随包 staging） |
| `resources/dsh/bun-preload.mjs` | Bun 兼容层单一来源（构建时拷进包内 runtime/） |
| `resources/icons/` | 应用/托盘图标单一来源 |
| `scripts/prepare-builtin-runtime.mjs` | 装配随包内置 dsh 依赖树（→ `resources/builtin/`，gitignore） |

## 构建

```bash
# 依赖：Bun 1.4.0、hutch（Electrobun CLI）、NSIS（仅 Windows 安装器）
bun install --frozen-lockfile       # 在 desktop-electrobun/ 内
node scripts/prepare-builtin-runtime.mjs --variant latest
cd desktop-electrobun
bun run build        # = build:native + prepare:bundle + hutch electrobun build + sign-app（macOS）
bun test             # 单元 + 黑盒（需要真运行时树时设 DSH_SHELL_TEST_RUNTIME）
```

产物：`desktop-electrobun/artifacts/`（macOS DMG / Windows NSIS setup.exe / Linux 目录包）。

详细文档见 [desktop-electrobun/README.md](desktop-electrobun/README.md) 与 [GUIDE.md](desktop-electrobun/GUIDE.md)。
