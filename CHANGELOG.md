# Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号见包内 `version.json`。

## Unreleased

### Added

- 桌面壳本体：Electrobun（Bun 主进程）+ CEF 渲染，随包内置 dsh 运行时，三平台安装包（macOS DMG / Windows NSIS 安装器 / Linux 安装包）。
- 多 profile 多窗口：每 profile 独立窗口、端口与服务进程；托盘聚焦/停止实例、新建与迁移 profile；每窗独立几何记忆。
- 托盘：显示/隐藏窗口、profile 窗口分组、运行时版本切换（内置/已下载/下载并切换/外部 dsh）、dsh 服务地址（本地/远程）、注册 dsh 系统命令、重启与退出。
- 通知：14 场景策略（独立开关与音效）、免打扰时段、全屏静默、系统事件音（macOS/Windows/Linux）。
- 防休眠：会话运行期间阻止系统空闲休眠（等待审批不算运行）。
- 设置：27 项与旧版配置同源（旧设置文件自动迁移），设置面板数据面齐备。
- 手机访问：遗留 lane 端口 TCP 转发器 + 每 profile 端口分配（固定公式、冲突顺延）。
- 远程 dsh：接入远程地址（token 换会话 cookie），托盘一键切回本地。
- 运行时管理：内置/已下载/外部 CLI 三种来源的发现与切换；下载走 npm/GitHub 目录；卸载进回收站。
- 应用内更新检查（Electrobun 更新器，基址为本仓 Releases）。

### Changed
- CI 触发策略分流（#7）：push/PR 只跑检查（typecheck + test，新增 Check workflow）；完整构建（三平台 + 断言 + 冒烟 + 上传）仅由 workflow_dispatch 与 tag push 触发。
- dsh 宿主由随包 Node sidecar 改为 Bun 直跑；启动链对齐官方桌面（`loadProfileDirectory` + `resolvedProfile`，profile 由 dsh 自身逻辑初始化）。
- 页面跑在壳自建 loopback origin 上：静态资产本地优先、真实 secure context（存储可写）、注入经 `dshDesktopBoot.ready()` 交付。
- 导航守卫在原生层评估（`navigationRules`），仅放行页面 origin，站外一律系统浏览器。

### Fixed

- Windows 安装器：静默安装/安装目录记忆/开始菜单快捷方式/卸载器；载荷打包期解并，装完即可直接使用。
- 单实例互斥与跨启动端口认领；壳异常退出后孤儿进程清扫；宿主崩溃自动恢复（退避重启，3 次封顶后告警）。
