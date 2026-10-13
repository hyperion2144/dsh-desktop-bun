# dsh-desktop-bun

DeepSeek Harness 的原生桌面壳：**Electrobun（Bun 主进程）+ CEF（Blink/V8）渲染 + Bun 运行 dsh**。

一个安装包，自带 dsh 运行时，开箱即用；macOS（Apple Silicon）、Windows（x64）、Linux（x64）三平台 CI 出包。

## 特性

- **完整 dsh 桌面体验**：会话、插件、托盘、系统通知、防休眠、手机访问（lane 端口）、远程 dsh 接入。
- **多 profile 多窗口**：每个 profile 一个窗口、一份独立服务面；托盘聚焦/开关实例、新建与迁移 profile。
- **运行时管理**：内置随包运行时开箱即跑；也可下载/切换指定版本。
- **稳定的项目隔离**：每 profile 独立端口、独立窗口几何、独立服务进程；壳退出后不留孤儿进程。
- **原生窗口**：系统边框 + 自绘标题栏与三键（macOS/Windows 一致行为），站外链接走系统浏览器。

## 安装

从 [Releases](https://github.com/hyperion2144/dsh-desktop-bun/releases/latest) 下载：

| 平台 | 产物 |
| --- | --- |
| macOS（Apple Silicon） | `macos-arm64-DeepSeekHarnessDesktopBUN.dmg` |
| Windows（x64） | `windows-x64-DeepSeekHarnessDesktopBUN-setup.exe` |
| Linux（x64） | `linux-x64-DeepSeekHarnessDesktopBUN-Setup.tar.gz` |

安装与日常使用说明见 [GUIDE.md](desktop-electrobun/GUIDE.md)。

## 从源码构建

依赖：[Bun](https://bun.sh) 1.4+、[hutch](https://hutch.blackboard.sh)（Electrobun CLI）；Windows 安装器另需 NSIS。

```bash
bun install --frozen-lockfile
node scripts/prepare-builtin-runtime.mjs --variant latest   # 装配随包 dsh 运行时
cd desktop-electrobun
bun run build        # 产物在 desktop-electrobun/artifacts/
bun test             # 单元 + 黑盒（需要真运行时树时设 DSH_SHELL_TEST_RUNTIME）
```

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| `desktop-electrobun/` | 壳本体（TypeScript / Bun / Electrobun） |
| `desktop-plugin/` | 桌面插件包 `dsh-desktop-bun`（壳 chrome 客户端 + 技能） |
| `plugins/dsh-mobile-access/` | 手机访问插件包（随包 staging） |
| `resources/` | Bun 兼容层（`dsh/bun-preload.mjs`）与图标 |
