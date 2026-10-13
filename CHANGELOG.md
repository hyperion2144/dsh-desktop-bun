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
- CI 每日定时全量兜底（#8）：build.yml 新增 schedule（UTC 18:30 = 北京 02:30）；main 打包链（三平台打包 / NSIS / 断言 / 冒烟）由每日自动验证，防 hutch 与 runner 镜像漂移导致的静默腐坏。

### Changed
- CI 触发策略分流（#7）：push/PR 只跑检查（typecheck + test，新增 Check workflow）；完整构建（三平台 + 断言 + 冒烟 + 上传）仅由 workflow_dispatch 与 tag push 触发。
- dsh 宿主由随包 Node sidecar 改为 Bun 直跑；启动链对齐官方桌面（`loadProfileDirectory` + `resolvedProfile`，profile 由 dsh 自身逻辑初始化）。
- 页面跑在壳自建 loopback origin 上：静态资产本地优先、真实 secure context（存储可写）、注入经 `dshDesktopBoot.ready()` 交付。
- 导航守卫在原生层评估（`navigationRules`），仅放行页面 origin，站外一律系统浏览器。
- 移除外部 DSH CLI 支持：运行时只认随包内置或已下载版本；dsh 来源固定内置，历史配置 `dsh_mode=external` 静默回退（设置键保留），托盘/设置面板/命令面不再出现外部选项。
- 移除兼容模式：端口被本壳旧实例或外部 dsh web 占用时自动清场后由壳自拉（不再弹「兼容 / 高级」选择框）；陌生程序占用且清理失败仍报错。壳 RPC 与页面环境载荷不再携带 mode 字段。

### Fixed

- Windows 安装版启动失败（#1）：DSH_HOME 缺省改走 `dshHome()`（Windows 无 HOME 时旧写法退化成相对路径 `.dsh`，日志/设置落进安装目录）；profile 依赖摊平改用 `lstatSync` 判存在——悬空链接不再撞 EEXIST，被旧版本真实目录占住的运行时包就地替换；指错方向的链接（含旧壳残留，不分公司）一律删掉重指到当前运行时树。
- profile 依赖摊平落点改共享池（#13）：reconcile 不再把运行时树链进各 profile 自己的 `node_modules`，改链到共享池 `profiles/node_modules`（对齐旧壳不变量「共享包在父级 node_modules，Node 向上解析」），多 profile 只维护一份链接、切运行时全 profile 一致重指（设置面板切运行时立即重指，不等下次启动）；启动与切运行时都会幂等清掉壳此前写进 per-profile 池的运行时链接（防近者优遮蔽共享层造成跨 profile 版本错配），pnpm 自有链接（含 store 暂时悬空）与用户资产不动。
- 内置 dsh 运行时按声明供给（#16）：新增 `desktop-electrobun/builtin-runtime.json` 声明 dsh 与 pnpm 的固定版本；prepare:bundle 按声明物化内置树（已就绪复用 / npm 下载 / `DSH_SHELL_BUILTIN_SOURCE` 显式逃生口），落盘版本与声明不符直接失败；assert-artifact 对产物里的内置 dsh 版本与声明再对一遍；退役 build.yml 备树步骤与本机运行时拾取链。
- client bundle 工厂 id 旧名致页面卡「Loading plugins」（#19）：插件改名 dsh-desktop-bun 后 build-client.mjs 的 banner id 仍是 dsh-desktop-tauriapp，模块系统按挂载名找不到工厂、回退单独加载再执行一遍 bundle，duplicate registration 抛错整页 boot 死循环；id 改回挂载名并在构建脚本注释里固化「工厂 id = 宿主挂载名」不变式。
- Windows 插件 experimental-inspector 激活失败（#6）：preload 归一 fetch 后，上游仍用旧访问器描述符 spread+value 定义属性被 Bun 拒绝——spread 定义一并替换成干净数据属性；补丁幂等改带 rev 指纹（旧补丁机器能刷到新替换）；koffi 禁用补丁的替换锚行尾锚定，修复历次 rev 提升在实机上叠加 throw 的缺陷。
- 修复 `npm run test:client`：dshDesktop 载体脚本测试改从 electrobun 壳的 `desktop-electrobun/src/bun/carrier.ts` 转译取材（旧壳 Rust 文件路径早已不存在，该测试自壳迁移起即不可跑），并同步 `platform-keyboard` / `desktop-browser-bridge` 的载体注释指认。
- Windows 安装器：静默安装/安装目录记忆/开始菜单快捷方式/卸载器；载荷打包期解并，装完即可直接使用。
- 单实例互斥与跨启动端口认领；壳异常退出后孤儿进程清扫；宿主崩溃自动恢复（退避重启，3 次封顶后告警）。
