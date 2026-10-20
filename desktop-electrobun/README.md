# desktop-electrobun

壳本体：**Electrobun（Bun 主进程）+ CEF 渲染 + Bun 运行 dsh**。
面向构建与开发；使用说明见 [GUIDE.md](GUIDE.md)。

## 开发

```bash
git submodule update --init --recursive          # 手机布局插件 dsh-web-mobile 来自 mobile/dsh-mobile-nav 子模块，漏拉则 dev 跳过、打包断言失败
bun install                          # devDep 只有 @types/bun

# 无窗口：只起服务面，stdout 打一行 SHELL-READY {json}（CI / 黑盒用）
DSH_HOME=/tmp/shell-home DSH_SHELL_PAGE_PORT=6391 bun run src/bun/serve.ts

# 有窗口（开发）：hutch 起 dev 包（自带 Bun 1.4.0 + CEF）
hutch electrobun dev

# 出正式包：macOS = .app/.dmg + 封装签名；Windows = 构建树 + NSIS 安装器；Linux = 安装包
bun run build

# 门禁
bun run typecheck                             # tsc --noEmit
DSH_SHELL_TEST_RUNTIME=<运行时树> bun test     # 黑盒需要真运行时树；不给则黑盒段跳过
bun run assert:artifact                       # 产物断言（CI）
```

`SHELL-READY {json}` 里的 `pageUrl` 即页面地址（`http://127.0.0.1:<port>/<token>/`）；
`/__shell__/health` 是服务面自检视图。

## 环境变量（常用）

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | 透传给 dsh 的主目录（缺省由 dsh 自行解析，壳不自设） |
| `DSH_SHELL_RUNTIME_DIR` | 强制指定 dsh 运行时树（开发时指向本地构建） |
| `DSH_SHELL_BUILTIN_DIR` | 内置运行时树（打包后是 `Resources/app/dsh`） |
| `DSH_SHELL_PAGE_PORT` | 页面 origin 端口（缺省按公式分配，被占顺延） |
| `DSH_SHELL_NO_WINDOW=1` | 只起服务面不建窗（无显示器/CI） |
| `DSH_SHELL_OPEN_PROFILES=a,b` | 启动时顺带打开其他 profile 窗口 |
| `DSH_SHELL_RESOLVE_ONLY=1` | 干跑：只打印运行时选择结果就退出 |
| `DSH_DESKTOP_NO_SINGLETON=1` | 只跳过壳层单实例锁（shell-instance.json）；CEF 层 ProcessSingleton 不归它管，并行双窗还要配 `DSH_SHELL_DEV_IDENTIFIER`（见下与「并行双实例」节） |
| `DSH_SHELL_DEV_IDENTIFIER=<id>` | dev 构建期换 bundle id——CEF 数据目录随 id 独立，才能并行开两个带窗实例；正式构建勿设 |
| `DSH_DESKTOP_AUTO_QUIT[=ms]` | 服务面就绪后延迟自动退出（探针收尾） |

## 并行双实例（带窗 dev 探针，#38）

CEF 层的 Chromium ProcessSingleton 按 `<identifier>/<channel>/CEF` 数据目录加锁，两个实例要并存必须在**构建期**就换 id（运行期环境变量救不了 CEF 层）：

```bash
bun run prepare:bundle                                                # 一次即可（物化内置运行时）
~/.hutch/bin/hutch electrobun build --env=dev                          # 实例 A：默认 id
cp -R "build/dev-macos-arm64/DeepSeek Harness Desktop BUN-dev.app" build/A-default.app   # 产物目录名不含 id，先拷走 A 再构建 B（否则被覆盖）
DSH_SHELL_DEV_IDENTIFIER=com.hyperion.dsh-desktop-bun.dev2 \
  ~/.hutch/bin/hutch electrobun build --env=dev                        # 实例 B：换 id
```

启动时两侧各自错开运行期状态（示例 B 侧；A 侧同理换目录/端口）：

```bash
DSH_HOME=/tmp/dsh38/b DSH_SHELL_APP_SUPPORT=/tmp/dsh38/appsupport \
DSH_SHELL_PAGE_PORT=3111 DSH_DESKTOP_PORT=3211 DSH_MOBILE_LANE_PORT=3311 \
DSH_DESKTOP_NO_SINGLETON=1 DSH_SHELL_BUILTIN_DIR=<worktree>/desktop-electrobun/builtin-runtime \
"<B.app>/Contents/MacOS/<二进制名>"
```

验收要点：两窗并存、各自 `DSH_DESKTOP_PORT` 的 `/__shell__/health` 就绪、后启实例日志无 `Opening in existing browser session.`；`$DSH_SHELL_APP_SUPPORT/<identifier>/dev/CEF` 按 id 分家、无交叉写入。

副作用（已接受的取舍）：换 id 的实例在 macOS 是独立 bundle——TCC 权限需重新授权、日志/缓存独立，仅用于测试实例；正式构建勿设 `DSH_SHELL_DEV_IDENTIFIER`。

## 结构（谁管什么）

| 路径 | 职责 |
|---|---|
| `electrobun.config.ts` | 三平台 `bundleCEF` + `defaultRenderer`、bundle id、资源拷贝清单 |
| `src/bun/index.ts` | Electrobun 主进程：CEF 断言 → 启动界面 → 接入模式弹框 → 多 profile 窗口 → 托盘 → 单实例 → 退出回收 |
| `src/bun/serve.ts` | 无窗口入口（不 import electrobun） |
| `src/bun/service.ts` | 服务面编排：布局 → 端口认领 → 起宿主 → 换 cookie → loopback → 守护器/watchdog → 通知口 → 防休眠 |
| `src/bun/shell-server.ts` | 同源 HTTP 面：准入（token 前缀壳面 / 根路径数据面）、静态优先反代、WS 隧道、`/__shell__/*` 自答端点 |
| `src/bun/host.ts` + `runtime/dsh-host.mjs` | Bun 起 dsh 宿主（官方 desktop-host 同构），`HOST-READY` 握手；父进程看门狗防孤儿 |
| `src/bun/commands.ts` | RPC 命令表（页面经 `/__shell__/rpc` 调壳） |
| `src/bun/{tray,tray-menu}.ts` | 托盘（事件驱动 `setMenu`，不重建不闪菜单） |
| `src/bun/{profile-manager,plugin-staging,profile-dialog}.ts` | profile 依赖物化 / 插件 staging 与 `--patch` 注入 / 新建迁移对话框 |
| `src/bun/{downloads,notifications,keep-awake,lane-forwarder,watchdog,register-cli}.ts` | 下载管理器 / 通知策略 / 防休眠 / 手机 lane 转发 / 服务健康自愈 / 注册 dsh 命令 |
| `src/bun/{runtime-store,runtime}.ts` + `src/shared/runtime-catalog.ts` | 运行时来源（内置/已下载）、下载安装、回收站卸载 |
| `src/shared/*.ts` | 纯逻辑（无 IO，直接单测）：设置归一化、端口公式、准入、导航规则、代理解析、watchdog 裁决 |
| `runtime/bun-preload.mjs` | Bun 兼容层（node-pty shim / xterm 同步写 / koffi 探测），随 dsh 版本维护 |
| `scripts/*.mjs` | 打包物料 / 封装签名 / NSIS 安装器 / 产物断言 |

## 测试

1. **进程级黑盒**（进 CI）：起真壳，真 HTTP 打 loopback 面：准入、静态资产、RPC、WS、接入模式分支。
2. **纯逻辑单测**（进 CI）：`src/shared/*` 与可注入 IO 层。
3. 引擎断言（CEF/长跑）属一次性验收，不进常规 CI。

CI 分两条（#7）：push/PR 走 `.github/workflows/check.yml`，#18 起覆盖壳类型检查 + 单测、插件门禁（test:client + 全量 tsc）与 Windows 兜底 job（双平台只跑测试面）；完整构建（三平台矩阵 → 出包 → 产物断言，Windows 追加 NSIS 安装器与冒烟）在 `.github/workflows/build.yml`，由手动 dispatch、tag push（只认 `desktop/v*`）与每日定时兜底（#8，UTC 18:30 = 北京 02:30）触发。移动端出包（Android APK / iOS IPA / 鸿蒙 HAP）自 #212 起独立在 `.github/workflows/mobile.yml`（tag 只认 `mobile/v*`，定时兜底 UTC 19:00），不再随桌面流水线白跑。发版自 #213 起接上：tag push 时 `scripts/release-publish.mjs` 把安装包与自动更新清单（`<platformPrefix>-update.json` + 整包）发成 GitHub Release 资产；桌面 stable 独占 `latest`（自动更新取 `releases/latest/download`），移动端是 prerelease 且不夺 latest；tag 版本必须等于版本文件版本。

## 已知边界

- macOS 通知授权需要封装签名（build 已自动 `codesign` 绑定 Info.plist + entitlements）；Developer ID 公证未做。
- `rlimit` 无法在 `Bun.spawn` 前设置，子进程 fd 上限沿用继承值。
