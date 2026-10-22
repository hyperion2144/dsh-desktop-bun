# 0014 — Windows 壳更新改壳侧自管安装包链路（平台分叉）

状态：Accepted（2026-10-21）

> **修订（2026-10-21，mac 实机反馈）：** 平台分叉升格为全平台接管——mac 框架进度回调不可靠（秒到 100% 再卡住），用户拍板三平台全部壳侧自管，见文末「修订」段。

## 背景

#235 实机（Windows 正式安装包 + #87 自定义安装目录）暴露框架更新链路的三处硬伤：点「下载更新」弹窗即关、无进度反馈、失败只落日志（`The running application is outside its managed update directory`）。根因在 Electrobun 框架 `Updater` 的 Windows/Linux 布局契约：它按 `resolve(dirname(executablePath), '..', '..')` 推导安装根，与 `%LOCALAPPDATA%\<identifier>` 不符（忽略大小写比较）就一票否决——#87 的自定义安装能力与该契约**不可调和**，壳侧无法配置绕过（`channel='dev'` 例外对正式包不适用）。macOS 走 self-extraction 探测 + 宽松回落，不受影响。

## 决策

**Windows 壳更新改壳侧自管，macOS/Linux 维持框架链路**——平台分叉收敛在 `src/bun/host/service.ts` 组装处（`installerDownloader` 仅 win32 创建）：

- **下载**：win 直接下载 NSIS 安装包（`windows-x64-DeepSeekHarnessDesktopBUN-setup.exe`，`releases/latest/download` 下 URL 稳定），复用运行时下载器的模式（单飞/可取消/进度回调/`.part` 原子转正，`src/bun/platform/installer-download.ts`）；mac/Linux 仍走框架 `download()`。
- **安装**：win 的「安装更新」= 运行已就绪的安装包（#87 安装器正常模式，`InstallDirRegKey` 记住上次目录），随后退出本应用（`onExitApp` → `shutdown()`；安装器要替换运行中的程序文件，用户点按钮即确认）；mac/Linux 仍走框架 `apply()`。
- **续装**：开窗与轮询都探测已知目录下的就绪安装包（`findReady(latest)`），已下载未装时直接呈「安装态」，不重下。
- **UI 三诉求跨平台一致**（`update-notice-dialog.ts` / `update-notice-rpc.ts`）：桥上新增 `shell_update_status` 只读方法；含壳段动作不自动关窗（失败红字可见）；就绪换装「安装更新」按钮（`apply-shell` op，只有用户手动确认才触发）。

## 取舍

- 不修框架（上游黑盒 + 本机只有产物），也不让框架支持自定义目录——两者都超出本仓控制面；自管链路把 Windows 从「框架 manifest/artifact 链」解耦，代价是丢掉框架的差量更新与签名校验（安装包完整性目前靠 HTTPS 与 GitHub 资产），后续可在 `installer-download.ts` 内补哈希校验。
- 「运行安装包 + 退出」优于静默换文件（框架 win 路径的本意）：NSIS 安装器有 #87 的目录记忆与运行中检测兜底，且换 `.app`/`.exe` 的窗口期由安装器自己管，壳不需要发明热替换。
- 失败文案识别保留（`classifyUpdateFailure` 的 `managed-dir` 类）：框架链路在 mac/Linux 仍是默认路径，同类错误出现时用户能看懂。

## 后果

- `ShellService.shellUpdateStatus()` 成为壳段更新状态的唯一数据源（win = 安装包下载器 + 框架视图合成，mac/Linux = 框架视图回落）；提醒窗进度条、就绪态、失败红字都读它。
- Windows 安装包文件位置对用户可见（`%LOCALAPPDATA%\DSHDesktopBun\updates`，`DSH_SHELL_INSTALLER_DIR` 可覆盖），回应 #235 的「下载位置」诉求。
- 平台差异只影响壳段；运行时段的更新提醒/下载/切换路径不变。

## 修订（2026-10-21）：macOS/Linux 一并接管

mac 实机验证发现框架下载进度回调不可靠（进度秒到 100% 再回落卡住，与本仓 #97 观测过的运行时下载器「假活」同型），且设置面板「应用更新」卡同样没有可用进度。用户决策：**放弃平台分叉，三平台全部改壳侧自管安装包链路**。

- `installerDownloader` 三平台都建；资产名按 `release-publish.mjs` 的 `INSTALLER_PATTERNS`（mac `*.dmg`、linux `linux-*.tar.gz`，win 仍是 `*-setup.exe`），`releases/latest/download` 下名稳定。
- 缓存目录分平台：win `%LOCALAPPDATA%\DSHDesktopBun\updates`、mac `~/Library/Caches/DSHDesktopBun/updates`、linux `${XDG_CACHE_HOME:-~/.cache}/DSHDesktopBun/updates`（`DSH_SHELL_INSTALLER_DIR` 一律可覆盖）。
- `launch()` 平台分叉：win 直接 spawn 安装器；mac `open <dmg>` 挂载让用户拖装；linux `xdg-open <所在目录>` 打开文件夹由用户解包安装——三平台都是「用户手动确认安装」语义，不越「退出是用户动作」红线。
- 契约扩面：`get_shell_update_status` 入 shell 命令表（76 条），`ShellUpdateStatus` 形状单一真源在 `contracts/updates.ts`，平台模块与设置面板共用；面板「应用更新」卡加进度条/就绪态/失败红字，与提醒窗读同一数据源。
- 框架链路移除：`shellDownload`/`shellApply` 不再有框架兑底（下载器缺席直接报「壳未接自管安装包下载器」），`classifyUpdateFailure` 的受管目录文案保留给历史版本升级用户。

## 修订（2026-10-22）：检查更新一并自管

dev 隔离实例自测时发现框架 `checkForUpdate` 对 `channel === "dev"` 直接短路「updates disabled」——dev 构建永远检查不到更新，且清单名带 buildEnv 前缀（dev 实例查 `dev-*-update.json`，发布链只有 stable 的）。用户决策：**检查更新也不依赖框架，全自己实现**。

- `updater.ts` 重写为自管 check：直接 fetch 发布清单 `stable-<os>-<arch>-update.json`（前缀固定 stable，dev 实例也查发布链同一份），本地版本自读（`DSH_SHELL_APP_VERSION` 覆盖 → `version.json`）。
- 可用性判定用版本比较（`isNewerVersion`），不用框架 hash 比对——dev 实例的本地 hash 与清单不同源，永远对不上。本地版本读不到（`'unknown'`）时不自算「可更新」，宁可不报也不误报。
- 404 二义性语义保留（#216）：探 `releases/latest/download` 背后有无 Release，区分「暂未发布」与「发布链路故障」。
- `ShellUpdater` 接口收窄为 `{available, reason, snapshot(), check(), start(), stop()}`——`download()/apply()` 从接口上删除，下载与安装全部归安装包下载器链路。
- dev 实例自测通过（2026-10-22）：check → 0.1.1 available；download → 完成落 `/tmp/…/updates/0.1.1/`；get_shell_update_status → updateReady+路径；删包 → updateReady 立即回落 false。
