# Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号见包内 `version.json`。

## Unreleased

首个版本：DeepSeek Harness 的完整桌面与移动形态。以下按能力域组织；每条末尾的 #N 是开发过程中的 issue 编号，供追溯。

### 桌面壳（macOS / Windows / Linux）

- 第三方插件的 const 重赋值在加载时自动放宽为 let，插件入口不再因 Bun 转译期拒绝而整条失活（#205）。
- dev 打包可选「只带链接」：`DSH_SHELL_BUILTIN_LINK=<runtime 目录>` 时内置运行时改成目录链接，dev build 不再每次拷几百 MB 实体树（#210）。
- preload 汇总行不再误报「HMR 关闭」：`DSH_BUN_COMPAT_DISABLE_HMR` 是无人读的死开关，真开关在 profile 的 bundle patch。

- 三平台安装包，内置 dsh 运行时（0.2.1-rc.2）开箱即用，无需预装 Node/pnpm；宿主由 Bun 直跑。
- 完整 dsh 桌面体验：会话、插件、托盘、系统通知、防休眠、手机访问、远程 dsh 接入。
- 多 profile 多窗口：每 profile 独立窗口/端口/服务进程/窗口几何；服务面先于 DSH 存在，DSH 起不来托盘也有自救入口（#117）。
- 托盘：显隐窗口、profile 分组聚焦、运行时切换、本地/远程一键切换、重启应用（整应用退出自动拉起 #126）、检查更新（#141）。
- 注册 dsh 为系统命令：macOS / Windows PATH / Linux symlink 三平台补齐，带结果通知（#62）。
- 通知中心：15 类场景独立开关与音效、免打扰时段、全屏静默、聚焦不投递（#115）；Windows/Linux 真出声（自定义音/系统默认音/试听，#74）；Windows 以应用名与图标显示（#107）。
- 防休眠：会话运行期阻止系统休眠，三平台原生实现（#75）。
- 运行时管理：内置/已下载双来源发现与切换、目录下载可取消（#97）、临时目录原子安装（#139）、卸载进回收站、以实际在跑版本为基准判定（#138，[ADR-0006](docs/adr/0006-builtin-runtime-as-first-class-candidate.md)）。
- 更新体系：应用内更新检查 + 启动后台检查（#142）+ 合并提醒卡（全部更新/稍后/不再提示 #140）+ 只提醒装得上的版本（#139）+ 面板开关与忽略版本管理（#136）。
- 设置面板 27 项设置，旧设置文件首启自动只读迁移，开关即存体验统一（#128）。
- 原生窗口：自绘三键与几何记忆（#50）、最大化自愈（#80/#73）、右键菜单补齐（#21）、弹窗自绘标题带（#164）与高度自适应（#130）、闪屏/提醒窗跟随 DSH 主题（#140）。
- 开发者工具：开关确认+保存即重启（#69/#119）、打包态 CDP 调试口（#106）、壳托管 DevTools 窗口（#68）、NodeJS 诊断面板（#61）。
- 手机访问：lane 通道转发 + 每 profile 端口（page/upstream/lane 三列可设 #22），配对通道稳定不崩（#41）。
- 远程 dsh：token 换会话 cookie 接入，远程页命令桥（#47）与设置/模型目录可用（#42），托盘一键切回本地。
- 登录：壳代开系统浏览器完成 OAuth，回调窄豁免（#169，[ADR-0007](docs/adr/0007-oauth-callback-admission-exemption.md)）。
- 安全边界：页面跑壳自建 loopback origin（真实 secure context）、站外一律系统浏览器、端点视图级鉴权（#130，[ADR-0005](docs/adr/0005-shell-page-transport-boundary.md)）。
- 数据面：静态资产本地优先、`/__shell__/batch` 批量转发与并发单飞合并（#54）、三档聚合开关（#128）。
- 稳态底盘：单实例互斥与端口认领、壳异常退出孤儿清扫、宿主崩溃自动恢复（退避封顶）+ 树级停止（#60）、SSE 空闲不切断（#159）、壳日志落盘（#178）。
- 内置运行时按声明供给，落盘/产物双对账（#16）。

### 桌面插件（dsh-desktop-bun）

- 设置面板多卡：桌面设置、代理（连通性测试）、profile 端口、迁移、通知（场景/音效试听）、下载（进度/取消）、环境、更新提醒，深浅主题适配。
- 面板按职责拆分 + 数据面 adapter：首屏一次取数、输入不被秒级重置（#175）、行为测试直跑（#144/#182）。
- 通知配置三端同源：「全屏时静默」等开关读写一致生效（#190）。
- 壳↔页面 72 条命令以根 contracts/ 契约类型层对齐，invokeCommand 编译期校验（#190）。
- 桌面壳代理转发补回已验证的源标头，第三方插件设置保存不再被上游同源校验拒绝（#197）。

### 移动端（Android / iOS / HarmonyOS）

- 三端原生壳入库：Android / iOS（Expo React Native，#31）、鸿蒙（ArkTS + ArkWeb，#32），共用配对逻辑层与设计令牌。
- 配对：`dsh-mobile://pair` 深链、鸿蒙扫码（ScanKit）、手输地址 + 令牌；令牌一次一用，换设备需桌面重新生成。
- dsh 页面加载：WebView / ArkWeb，手机布局由注入插件 dsh-mobile-nav 生效（`mobile/dsh-mobile-nav` 子模块）。
- 会话守卫：弱网宽容、回前台不误探测、退避可配 `mobile_guard_backoff_ms`（#175）。
- 「下载对应运行时」：按远程构建逐版本定位（CDN 探测，鸿蒙 npm 单包，#35）；内置运行时跟随桌面 pin。
- 配对与直连稳定性：重复 Cookie 放行、无 cookie 引导重载（#36）、鸿森 cookie 覆写（#36）、安卓 cleartext 与白屏修复、iOS Hermes 兼容（#34）、iOS 安全区适配（#175）。
- CI 出包：Android / iOS 矩阵（#33），鸿森 HAP 作业预留（自建 runner）。

### 工程与交付

- Windows 安装器：品牌三页（#91）、明暗双主题（#89）、中英双语 + LZMA 降 30.8% 体积（#88）、事务性安装失败回滚（#93）、进度页窗口帧覆盖层（#103）、高 DPI 适配（#103）。
- macOS 交付：签名后重打 DMG（#95）、三层 ad-hoc 重签认领 bundle id（#115）、屏幕录制授权 designated requirement 锚定（#143）、内置树补丁构建期打上（#143）。
- CI 分流：push/PR 跑检查（壳+插件门禁+Windows 兑底 #18）、完整构建留 workflow_dispatch/tag/每日兑底（#7/#8）、job 超时兑底（#51）、产物断言（渲染器载荷/launcher/version.json）；壳主进程 console 默认 tee 进 shell.log（#178）。
- 壳架构深模块化：ProfileSession（#179）、命令契约 contracts/（#190）、共享 RPC core（#185）、面板数据 adapter（#182）、判定层 candidates（#189）、宿主监督器 HostSupervisor（#183/#195）。
- 壳源码按运行时域分一层子目录（host/windows/commands/net/runtime/profiles/notify/platform，shared 与插件客户端同口径），组合根留根，129 文件归位（[ADR-0009](docs/adr/0009-bun-source-domain-layout.md)）。
- 源码门禁测试随分域同步路径，加载失败不再被 pass/fail 计数掩盖（#196）。
- 应用图标全面替换为官方 DeepSeek 桌面图标：托盘/移动端直接用官方产物原字节，安装器与 exe 图标从官方矢量源逐尺寸光栅化（多帧 16–256），各尺寸边缘锐利（#198）。
- Windows 任务栏身份：开始菜单快捷方式写入 AppUserModelID（固定项退出后可拉起）、安装即注册任务栏显示名/图标、launcher.exe 版本资源改应用名并补嵌官方多帧图标（右键菜单不再显示 BUN，缩略图不再是默认 exe 图标）、安装器顶部品牌瓦片直接用应用图标铺满（#199）。
- CI 触发策略收敛：构建流水线不再跟随提交触发，只留手动 dispatch/tag/每日兑底；提交验证仍由 check.yml 全跑（#200）。
- 安装器链路快验 CI：假树 + stub 载荷分钟级验证 rcedit/NSIS/产物断言（#199 反馈）；NSIS 改官方 zip 直下（choco 源不稳）。
- 启动期退出与单实例修复：启动期间托盘「退出应用」不再报错（#201）；单实例判活 Windows 改 tasklist 取进程身份 + 锁内存自身可执行路径深验证（同名不同路径的 pid 复用不误判，#202）。
- 运行中窗口图标：壳侧 FFI 对 launcher/bun 进程的顶层窗口（含 DevTools 窗）设 WM_SETICON，任务栏与缩略图不再回退系统白框（#203）。
- macOS 托盘「重启应用」修复：改为中继进程等旧实例（含 CEF 单实例锁）退净后再拉起，不再弹出浏览器或拉起失败（#204）；安装后 bun.exe 一并写入应用显示名（任务管理器不再显示 BUN）。
- Windows DevTools 修复：右键菜单打开的 DevTools 连接不再断开（CDP 允许跨源 WebSocket + ws 地址回环归一）；F12 行为不变（#207）。
- 高分屏最小化恢复修复：最大化窗口在缩放屏上最小化后恢复，重新落位不再超出屏幕（#208）。
- Windows 托盘「重启应用」修复：壳直接拉起 launcher 的可靠路径保留并补 relay 日志留痕，重启后新实例正常拉起（#211）。
- 架构文档：[docs/adr](docs/adr/README.md) 0001–0009 带索引、[docs/research](docs/research/README.md) 11 篇调研入库、[CONTEXT.md](CONTEXT.md) 领域词汇表。
- 插件客户端资产本地服务（#175 系）：plugin 资产本地直出，不依赖远端。
