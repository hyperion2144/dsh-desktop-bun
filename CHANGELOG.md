# Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号见包内 `version.json`。

## Unreleased

### Added

- 桌面壳本体：Electrobun（Bun 主进程）+ CEF 渲染，随包内置 dsh 运行时，三平台安装包（macOS DMG / Windows NSIS 安装器 / Linux 安装包）。
- 多 profile 多窗口：每 profile 独立窗口、端口与服务进程；托盘聚焦/停止实例、新建与迁移 profile；每窗独立几何记忆。
- 托盘：显示/隐藏窗口、profile 窗口分组、运行时版本切换（内置/已下载/下载并切换）、dsh 服务地址（本地/远程）、注册 dsh 系统命令、重启与退出。
- 通知：14 场景策略（独立开关与音效）、免打扰时段、全屏静默、系统事件音（macOS/Windows/Linux）。
- 防休眠：会话运行期间阻止系统空闲休眠（等待审批不算运行）。
- 设置：27 项与旧版配置同源（旧设置文件自动迁移），设置面板数据面齐备。
- 手机访问：遗留 lane 端口 TCP 转发器 + 每 profile 端口分配（固定公式、冲突顺延）。
- 远程 dsh：接入远程地址（token 换会话 cookie），托盘一键切回本地。
- 运行时管理：内置/已下载两种来源的发现与切换；下载走 npm/GitHub 目录；卸载进回收站。
- 应用内更新检查（Electrobun 更新器，基址为本仓 Releases）。
- 页面右键菜单补齐（#21）：在既有系统 role 项与链接项之上，新增工作区文件行「打开」、文件夹行「打开文件夹」（dsh ui-sidebar-files 的 data-files-entry/data-files-path 稳定标记 → Utils.openPath，路径只认绝对路径）；dev 构建（未打包）菜单垫底「打开 DevTools」（BrowserView.openDevTools），release 不出现；「刷新页面」更名「刷新」。
- 开发者工具开关（#69）：桌面设置新增默认关的「开发者工具」；变开先弹安全确认弹窗（取消不写入），保存即重启桌面壳。打包态重启后按设置在回环地址开 CEF 远程调试口（ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT，默认 9333，DSH_SHELL_DEVTOOLS_PORT 可换），右键菜单才出现「打开 DevTools」——打包态菜单可见 ⇔ 口已开，禁中间态；口被占或覆盖 env 非法一律 fail-closed（不开口、不出菜单）。dev 构建行为不变（Electrobun 自动开调试口、菜单恒可见）。旧设置文件无 dev_tools 键按默认关。
- CI 每日定时全量兜底（#8）：build.yml 新增 schedule（UTC 18:30 = 北京 02:30）；main 打包链（三平台打包 / NSIS / 断言 / 冒烟）由每日自动验证，防 hutch 与 runner 镜像漂移导致的静默腐坏。
- loopback 数据面聚合（#54）：壳新增 `/__shell__/batch` 批量转发端点（一次 POST 携 ≤32 个子请求，并发转发按序聚合，单个失败不拖垮整批，整包 no-store）与相同 method+path+query 并发 GET 的单飞合并（≤256KB 且带 content-length 的响应共享给并发等待者，流式/大响应不缓冲）；`/__shell__/health` 新增 `proxiedInFlight`/`coalesced` 字段；proxy 慢请求日志由单段 ttfb 拆为 `ttfb`/`total` 两段（total 含流式体传输）。

### Changed
- CI 触发策略分流（#7）：push/PR 只跑检查（typecheck + test，新增 Check workflow）；完整构建（三平台 + 断言 + 冒烟 + 上传）仅由 workflow_dispatch 与 tag push 触发。
- dsh 宿主由随包 Node sidecar 改为 Bun 直跑；启动链对齐官方桌面（`loadProfileDirectory` + `resolvedProfile`，profile 由 dsh 自身逻辑初始化）。
- 页面跑在壳自建 loopback origin 上：静态资产本地优先、真实 secure context（存储可写）、注入经 `dshDesktopBoot.ready()` 交付。
- 导航守卫在原生层评估（`navigationRules`），仅放行页面 origin，站外一律系统浏览器。
- 移除外部 DSH CLI 支持：运行时只认随包内置或已下载版本；dsh 来源固定内置，历史配置 `dsh_mode=external` 静默回退（设置键保留），托盘/设置面板/命令面不再出现外部选项。
- 移除兼容模式：端口被本壳旧实例或外部 dsh web 占用时自动清场后由壳自拉（不再弹「兼容 / 高级」选择框）；陌生程序占用且清理失败仍报错。壳 RPC 与页面环境载荷不再携带 mode 字段。
- 页面 console 镜像与壳日志批量刷盘（#54）：桌面插件 client 的 console 镜像改攒批上报（新命令 `log_console_batch`，≤20 条/100ms 合并一次 RPC，旧壳自动回退逐条，guest/remote 白名单同步放行）；LogSink 新增 `bufferMs`（本壳 shell.log 与 dsh-desktop-webview.log 均 100ms 合并落盘，退出钩子同步 flush，崩溃最多丢一个缓冲窗口；行序/行格式/轮转/路径契约不变，不开缓冲仍逐行同步写）。

### Fixed

- 全新 Windows 插件安装报「无法获取插件信息」+ GBK 乱码（#70）：壳拉起 dsh 宿主时没把内置 pnpm 注入宿主子进程 PATH，dsh-plugin-manager 裸调 `execa(options.command ?? "pnpm")`，PATH 上没有 pnpm 就 ENOENT（中文 Windows 上错误经 GBK 解码成乱码）。修复：宿主拉起前物化 PATH 垫片目录（`<appSupport>/runtimes/.node-shim`：POSIX `pnpm` shell 脚本 + Windows `pnpm.cmd`，pnpm.cjs 按 DSH_SHELL_PNPM > 运行时树 > 内置树链路解析；顺路补 `node`/`node.cmd` 垫片），经 `buildChildEnv` 的 `pathPrepend` 前置到宿主子进程 PATH 最前（大小写不敏感防 Windows PATH/Path 双键，垫片赢过系统里可能存在的旧 pnpm）。首发与自愈重连两条拉起路径都接线，connect 时现算（切运行时/新下载后重连即拿到新 pnpm.cjs）；pnpm.cjs 解析不到时清掉陈旧 pnpm 垫片（不留死垫片）、启动不失败。旧通道（运行时安装/profile 依赖重建的 node 垫片）语义不变。
- 手动「重启 dsh 服务」升级为 DSH 完整重启、宿主停止升级为进程树级（#60）：托盘重启后 billion-context 会话代理失效的根因，是旧宿主被杀后其伴生进程（第三方插件的共享代理等）成孤儿，新宿主在秒级重启窗口 attach 上垂死的旧伴生（watcher 注册失败 → 模型流量静默直连；退出应用再启动不复现）。三层修复：新增 process-tree 模块（ps / PowerShell CIM 进程表枚举 + 树级停止编排：杀前枚举→同批 SIGTERM→宽限→SIGKILL 幸存者→有界确认树灭，超时放行并记日志，不阻塞重启）；host.stop() 按树级契约停止并暴露宿主生前树快照，守护器自愈在退避睡眠期间并行清扫崩溃残留孤儿（自愈节奏与退避策略不变）；托盘与设置面板「重启 dsh 服务」改为 DSH 完整重启语义（服务面树级停止 → 树灭确认 → 全新拉起新宿主，壳/托盘/窗口不动，窗口重载新会话）。机制按「宿主进程树」通用概念实现，不点名任何插件或端口段。
- BUN 桌面「NodeJS 诊断」面板全白（#61）：Bun 的 node:inspector CDP 面太窄（官方兼容表 🟡，Runtime.evaluate / HeapProfiler.* 一律 -32601 wasn't found），DevTools 前端拿不到求值结果，底部面板整块空白（快捷键 Ctrl/Cmd+Shift+.）。bun-preload 新增 Patch 13/14：worker 侧在 HostInspectorSession.request()（五条宿主后端共用的唯一 session.post 落点）命中桥方法时经 hostSourcePort 转给主线程执行（node:vm.runInThisContext 按 CDP 原始 script 完成值语义求值 + WeakRef 对象表 + util.inspect 有界预览 + awaitPromise 服务端补 await），堆快照用主线程 v8.getHeapSnapshot() 读成分块经合成事件 HeapProfiler.addHeapSnapshotChunk 推回客户端；未命中方法照旧透传原生，typeof Bun 守卫下 Node 零变化。Sources/Debugger（断点）依赖 Bun 转发丢结果的协议面，本补丁不覆盖。PATCH_REV 7→8。
- CI job 无超时兑底（#51）：hutch 首次构建要下载 cottontail/Electrobun/CEF/bun 四件套，下载器无超时无重试，偶发半开连接时进程挂死不退出（run 38493719636 实证 macOS job 占 runner 85 分钟；正常 3.5 分钟）。build.yml job 加 `timeout-minutes: 40`（全量正常 ~15 分钟）、check.yml 两 job 各加 `timeout-minutes: 20`，再挂自动失败不占 runner。
- 侧栏 header 错层（#44）：壳侧骨架期红绿灯让位注入（padding-top:28px + body 平台标记）在桌面插件接管后未退役，叠在官方 alpha 前端的 darwin 顶带布局上，logo 被折叠按钮顶下一层（官方 Desktop.app 的视觉是 logo 与折叠按钮同行）。退役骨架注入；插件 CSS 把 topStrip 浮到 logoRow 行、logoRow 顶回红绿灯让位带下方，还原单行几何；data-platform 信号保留（折叠全隐/红绿灯旁座位按钮依赖它）。随票修复 PR #48 合入时 CHANGELOG 残留的一处未解冲突标记。

- 并行带窗 dev 实例被 CEF 单例顶掉（#38）：DSH_DESKTOP_NO_SINGLETON 只跳壳层 shell-instance.json 锁，真正拦第二实例的是 Chromium ProcessSingleton——按 `<identifier>/<channel>/CEF` 数据目录加锁，hutch 侧无环境口子可绕。新增构建期换 id：electrobun.config 的 app.identifier 改经 src/shared/app-identity.ts 的 resolveBundleIdentifier() 解析，`DSH_SHELL_DEV_IDENTIFIER` 非空（去首尾空白）则覆盖、默认与既有产物一致（正式构建/升级/签名链零感知）；README 环境表与钩子注释同步改诚实描述。
- 配对远程页壳命令桥缺席（#47）：新壳对不可信 guest/远程视图零命令（#220 决策 12），配对远程设备被一并归零——远程页 `__TAURI_INTERNALS__.invoke` 全部 reject，设置面板「桌面通知」等 tab 恒「加载中」（旧壳 `remote-desktop.json` 有 74 条命令）。新增 `remote` 视图种类：壳铸 remote 视图 token 经宿主 env 下发给 mobile-access，桥给配对远程页注入与壳侧 tauri-ipc 逐字对齐的 invoke shim（经 /_loopback 达壳页面服务）；命令白名单 `REMOTE_ALLOWED_COMMANDS`（通知族 + 报日志，`get_desktop_client_environment` 刻意不在名单——不让远程浏览器画桌面 chrome），guest 不因 remote 多放一条。
- 远程页桌面通知面板卡「加载中」（#43）：mobile-access 配对门禁对所有路径要求会话 cookie，而浏览器对 `<link rel=manifest>` 的获取不保证携带 cookie，manifest.webmanifest 恒 401 unpaired，前端桌面通知面板拿到 401 无兑底挂起。门禁对清单路径精确放行（非敏感 PWA 元数据，透传上游），其余路径门禁行为不变。
- 手机访问必崩重启循环（#41）：壳在宿主 SHELL-READY 后 return 掉 stdout 的 for-await reader，Bun 会连带取消子进程管道读端——此后宿主任何 stdout 写都是 EPIPE（异步错误，插件侧 try/catch 捕不住），dsh 按 fatal load failure 退出；mobile-access 反代的 accessLog 是 ready 后唯一 stdout 写路径，故平时潜伏、手机一访问必崩（6 连崩复现，watchdog 自愈耗尽后服务彻底下线）。改为拿到 READY 后继续 drain 到流尾，宿主 stdout 日志全程可见。
- 远程页设置/模型目录全拒（#42）：上游对 HTML 也 gzip，mobile-access 反代原样转发手机的压缩协商后，注入管线判 isCompressed 整体跳过（OWNS_HOST/POLYFILL 等补丁缺席）→ 页面被判非 loopback 远程浏览器，settings/提供商目录等特权 RPC 全拒（「settings are unavailable in this browser」）。修复：文档导航请求（Accept 含 text/html）对上游强制 Accept-Encoding: identity 保证可注入，API/资产保留压缩协商不白费移动带宽。
- 端口三类混显、只有上游可设（#22）：Profile 端口表只显一列「启动端口」（实为页面 origin 口）却拿它当上游输入框占位，lane 口只读、页面口无设置项、壳级转发器口写死 3091——dsh 实例上游口 / 页面口（loopback）/ lane（手机代理）三类口互相混淆。行契约改显式 page_port / upstream_port / lane_port 三列（台账补记 dataPort=上游口激活避让；未运行 profile 显配置/公式期望值，页面口显上次台账值或「启动时分配」）；三类口全部可设置：上游 profile_ports.<name>（既有）、页面口 profile_page_ports.<name>（新键，语义对齐 env DSH_SHELL_PAGE_PORT——请求值被占顺延，保存二次确认 + 常驻警示「换口＝换浏览器本地存储」）、lane profile_lane_ports.<name>（既有键改可编辑）、壳级转发器 lane_forwarder_port（新键，缺省回退遗留 lane_port 再缺省 3091，重启壳生效）；另修面板点号键 patch 新壳静默丢失（旧壳 Rust 会展开）：updateSettings 补 expandDottedPatch。
- 手机布局插件未进 dev 与打包（#20）：mobile/dsh-mobile-nav 子模块未拉取时插件池缺 dsh-web-mobile，staging 只在汇总行尾部带一句「缺包跳过」纯静默——新增独立警告通道（缺包时单独一行点名缺的包与 `git submodule update --init` 补救命令，经壳 `console.warn` 输出）；assert-artifact 把 `plugins/dsh-web-mobile/package.json` 列入必带清单（漏拉子模块的构建硬失败）；README 两处补子模块拉取步骤；CI Checkout 已带 `submodules: recursive`（44f2c53）。
- CI 检查覆盖面（#18）：check.yml 并入桌面插件门禁——`test:client`（含 main 已重写指向新壳 `carrier.ts` 的载体断言段）+ 全量 `tsc`（tsconfig strict 覆盖 src/client 全部 14 文件，契约补 `ctx.effect`、disposer 用类型谓词收窄，零豁免）；新增 Windows 兜底 job（壳 `bun test` + 插件 `test:client` 双平台可跑性），首跑即抓到 `test-client.mjs` 裸路径动态 import 的移植性 bug（`pathToFileURL` 修复），POSIX-only 用例按平台条件 skip 并在票内留档清单；同步修正 `desktop-plugin/README.md` 旧壳构建/发布链说明；`build:client` 定性为构建产出、不进检查门禁。
- Windows 安装版启动失败（#1）：DSH_HOME 缺省改走 `dshHome()`（Windows 无 HOME 时旧写法退化成相对路径 `.dsh`，日志/设置落进安装目录）；profile 依赖摊平改用 `lstatSync` 判存在——悬空链接不再撞 EEXIST，被旧版本真实目录占住的运行时包就地替换；指错方向的链接（含旧壳残留，不分公司）一律删掉重指到当前运行时树。
- profile 依赖摊平落点改共享池（#13）：reconcile 不再把运行时树链进各 profile 自己的 `node_modules`，改链到共享池 `profiles/node_modules`（对齐旧壳不变量「共享包在父级 node_modules，Node 向上解析」），多 profile 只维护一份链接、切运行时全 profile 一致重指（设置面板切运行时立即重指，不等下次启动）；启动与切运行时都会幂等清掉壳此前写进 per-profile 池的运行时链接（防近者优遮蔽共享层造成跨 profile 版本错配），pnpm 自有链接（含 store 暂时悬空）与用户资产不动。
- 内置 dsh 运行时按声明供给（#16）：新增 `desktop-electrobun/builtin-runtime.json` 声明 dsh 与 pnpm 的固定版本；prepare:bundle 按声明物化内置树（已就绪复用 / npm 下载 / `DSH_SHELL_BUILTIN_SOURCE` 显式逃生口），落盘版本与声明不符直接失败；assert-artifact 对产物里的内置 dsh 版本与声明再对一遍；退役 build.yml 备树步骤与本机运行时拾取链。
- 注入 chrome 条带与侧栏色差、折叠侧栏未隐藏（#23）：条带不再填主题 token（上游实际绘制面不对应任何单一 token，实测即色差源），改为全透明拖拽带——红绿灯浮在侧栏 header 左侧空白区，透明层与任何主题同像素透出，色差从结构上消除；壳补设官方桌面信号 `html[data-platform]`（旧 Tauri 壳有、Electrobun 迁移丢失），ui-layout 据此 darwin 折叠=0px 全隐并由 shell.leading 座位提供官方「打开侧边栏/新会话」按钮；拖拽带折叠态收窄到红绿灯区（76px）不遮座位按钮，底部状态条随折叠隐藏；退役折叠加宽轨道与两侧补条等 #37 补偿逻辑。
- client bundle 工厂 id 旧名致页面卡「Loading plugins」（#19）：插件改名 dsh-desktop-bun 后 build-client.mjs 的 banner id 仍是 dsh-desktop-tauriapp，模块系统按挂载名找不到工厂、回退单独加载再执行一遍 bundle，duplicate registration 抛错整页 boot 死循环；id 改回挂载名并在构建脚本注释里固化「工厂 id = 宿主挂载名」不变式。
- Windows 插件 experimental-inspector 激活失败（#6）：preload 归一 fetch 后，上游仍用旧访问器描述符 spread+value 定义属性被 Bun 拒绝——spread 定义一并替换成干净数据属性；补丁幂等改带 rev 指纹（旧补丁机器能刷到新替换）；koffi 禁用补丁的替换锚行尾锚定，修复历次 rev 提升在实机上叠加 throw 的缺陷。
- 修复 `npm run test:client`：dshDesktop 载体脚本测试改从 electrobun 壳的 `desktop-electrobun/src/bun/carrier.ts` 转译取材（旧壳 Rust 文件路径早已不存在，该测试自壳迁移起即不可跑），并同步 `platform-keyboard` / `desktop-browser-bridge` 的载体注释指认。
- Windows 安装器：静默安装/安装目录记忆/开始菜单快捷方式/卸载器；载荷打包期解并，装完即可直接使用。
- 单实例互斥与跨启动端口认领；壳异常退出后孤儿进程清扫；宿主崩溃自动恢复（退避重启，3 次封顶后告警）。
