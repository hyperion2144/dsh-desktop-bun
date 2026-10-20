# dsh-desktop-bun

DeepSeek Harness 的原生桌面与移动端：桌面用 **Electrobun（Bun 主进程）+ 原生渲染（mac/Linux CEF / Windows WebView2）+ Bun 运行 dsh**，另带 **Android / iOS / HarmonyOS** 三端手机访问壳。

桌面三平台安装包自带 dsh 运行时，开箱即用；手机通过手机访问（lane 通道）与桌面配对，随时随地接着用。

## 桌面（macOS / Windows / Linux）

- **开箱即用**：一个安装包内置 dsh 运行时，无需预装 Node/pnpm；也可在应用内下载、切换、卸载指定版本。
- **多 profile 多窗口**：每个 profile 独立窗口、独立端口、独立服务进程与窗口几何；托盘按 profile 分组聚焦/停止，支持新建与迁移。
- **托盘**：显隐窗口、运行时版本切换、本地/远程 dsh 一键切换、注册 dsh 系统命令、重启应用与退出。
- **通知中心**：15 类场景独立开关与音效、免打扰时段、全屏静默、窗口聚焦不扰，三平台真出声（含自定义音与系统事件音）。
- **防休眠**：会话运行期间阻止系统空闲休眠（macOS / Windows / Linux 原生实现）。
- **手机访问**：lane 通道转发 + 每 profile 独立端口，配合移动端壳远程使用桌面 dsh。
- **远程 dsh**：接入远程地址（token 换会话 cookie），托盘一键切回本地。
- **更新体系**：应用内更新检查 + 运行时更新判定，有新版弹合并提醒卡（全部更新 / 稍后 / 不再提示），托盘也可手动检查。
- **设置中心**：桌面设置 / 通知 / 下载 / 代理 / profile 端口等面板，旧设置文件首启自动只读迁移。
- **稳态底盘**：单实例互斥、跨启动端口认领、孤儿进程清扫、宿主崩溃自动恢复（退避封顶）、壳日志落盘。
- **安全边界**：页面跑在本机 loopback origin 上（真实 secure context），站外链接一律交系统浏览器，视图级鉴权与令牌准入。

## 移动端（Android / iOS / HarmonyOS）

- **三端原生壳**：Android / iOS 用 Expo React Native，鸿蒙用 ArkTS + ArkWeb；共享同一套配对逻辑层与设计令牌。
- **配对即用**：`dsh-mobile://pair?token=…` 深链、鸿蒙扫码（ScanKit）、或手输地址 + 令牌；令牌一次一用，换设备需桌面重新生成。
- **手机布局**：dsh 页面内由注入插件 dsh-mobile-nav 切换移动布局（`mobile/dsh-mobile-nav` 子模块）。
- **会话守卫**：断线退避可配（`mobile_guard_backoff_ms`）、弱网宽容，回前台不再误探测。
- **跟随桌面**：内置运行时版本跟随桌面 pin，「下载对应运行时」按远程构建逐版本定位。
- **CI 出包**：Android / iOS 矩阵随完整构建出包，鸿蒙 HAP 作业预留（自建 runner）。

## 安装

从 [Releases](https://github.com/hyperion2144/dsh-desktop-bun/releases/latest) 下载：

| 平台 | 产物 |
| --- | --- |
| macOS（Apple Silicon） | `macos-arm64-DeepSeekHarnessDesktopBUN.dmg` |
| Windows（x64） | `windows-x64-DeepSeekHarnessDesktopBUN-setup.exe` |
| Linux（x64） | `linux-x64-DeepSeekHarnessDesktopBUN-Setup.tar.gz` |
| Android / iOS | CI 完整构建产物（Expo 出包） |

安装与日常使用说明见 [GUIDE.md](desktop-electrobun/GUIDE.md)；移动端各端细节见 `mobile/expo-app/README.md` 与 `mobile/harmony/README.md`。

## 从源码构建

依赖：[Bun](https://bun.sh) 1.4+、[hutch](https://hutch.blackboard.sh)（Electrobun CLI）；Windows 安装器另需 NSIS。

```bash
git submodule update --init --recursive    # mobile/dsh-mobile-nav（手机布局插件 dsh-web-mobile）来自子模块，漏拉则构建断言失败
bun install --frozen-lockfile
node scripts/prepare-builtin-runtime.mjs --variant latest   # 装配随包 dsh 运行时
cd desktop-electrobun
bun run build        # 产物在 desktop-electrobun/artifacts/
bun test             # 单元 + 黑盒（需要真运行时树时设 DSH_SHELL_TEST_RUNTIME）
```

移动端各端构建与测试命令见各自目录的 README（`mobile/expo-app`、`mobile/harmony`）。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| `desktop-electrobun/` | 桌面壳本体（TypeScript / Bun / Electrobun） |
| `desktop-plugin/` | 桌面插件包 `dsh-desktop-bun`（壳 chrome 客户端 + 技能） |
| `plugins/dsh-mobile-access/` | 手机访问插件包（随包 staging） |
| `mobile/expo-app/` | Android / iOS 壳（Expo React Native） |
| `mobile/harmony/` | 鸿蒙壳（ArkTS + ArkWeb） |
| `mobile/shell-web/` | 移动端共享逻辑层（配对解析 / 会话守卫 / 本地资产） |
| `mobile/dsh-mobile-nav/` | 手机布局注入插件（子模块） |
| `contracts/` | 壳↔页面 72 条命令的契约类型层（壳与插件共用） |
| `shared/` | 壳与插件共享的运行时代码（RPC core 等） |
| `resources/` | Bun 兼容层（`dsh/bun-preload.mjs`）与图标 |

## 文档

- [desktop-electrobun/GUIDE.md](desktop-electrobun/GUIDE.md) —— 安装与日常使用
- [CONTEXT.md](CONTEXT.md) —— 领域词汇表
- [docs/adr/](docs/adr/README.md) —— 架构决定记录（ADR 索引）
- [docs/research/](docs/research/README.md) —— 调研笔记索引
- [CHANGELOG.md](CHANGELOG.md) —— 变更记录
