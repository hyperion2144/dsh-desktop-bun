# dsh-desktop-bun 工作约定

- 壳改动一律在 `desktop-electrobun/` 内；桌面插件在 `desktop-plugin/`（构建 `lib/client.js` 用
  `bun run build:client`，测试 `bun run test:client`）。
- 门禁：壳 `bun run typecheck` + `bun test`、插件 `bun run typecheck` + `bun run test:client` 全绿才可提交（插件命令需 Bun 1.4.x，与 CI setup-bun 及仓内 hutch 工具链对齐）；CI 分流：push/PR 跑检查（check.yml：壳检查 + 插件门禁 + Windows 兜底 job，#18），完整构建留给 workflow_dispatch、tag push 与每日定时兜底——桌面与移动端自 #212 起拆成两条流水线（`build.yml` 只跑桌面、tag 只认 `desktop/v*`；`mobile.yml` 只跑移动端、tag 只认 `mobile/v*`；#7/#8）；自 #213 起 tag push 同时发版：`scripts/release-publish.mjs` 把安装包与自动更新清单发成 GitHub Release 资产（桌面独占 latest，移动端 prerelease 不夺 latest；tag 版本必须等于版本文件版本）。
- 提交纪律：一张需求地图（map，可含多张子票）= 一个 worktree = 一个提交；`git add` 点名文件（禁 `-A`）；改动后同步对应通道的
  changelog（桌面 `CHANGELOG.md` / 移动 `CHANGELOG-mobile.md`，各自独立维护）的 `## Unreleased`；PR 优先，未经维护者允许不合并。
- worktree：read/edit/write 一律传 worktree 绝对路径（相对路径按会话根解析），bash 用 workdir；新 worktree 先 `bun install`，再从主仓复制 `.hutch`（符号链接会让 hutch 报 `InvalidProjectStatePath`），最后 `bun run prepare:bundle`。
- 工具链：壳/插件的 typecheck/test 用 hutch Bun 1.4.0（`~/.hutch/toolchains/bun/1.4.0/macos-arm64/bun`）；系统 PATH 的 1.3.x 会造 FFI/PTC 假失败。
- 壳日志：`$DSH_HOME/shell.log`（主进程 console 已 tee，`[shell log/warn/error]` 行都在）；页面日志同目录 `dsh-desktop-webview.log`。
- Electrobun 原生源码：GitHub `blackboardsh/electrobun` 对应 tag；本机 `~/.hutch/releases/electrobun/<ver>/`；符号用 `strings .../libNativeWrapper.dylib` 查。
- 构建后跑 `bun run assert:artifact`：断言 CEF/native 载荷、内置 dsh、`launcher` 必须是原生 Mach-O（不是 exec shim）、`app/bun/index.js` 关键符号、`app/runtime/tray.png`。
- 契约红线：设置文件键名、`/api` 与 `/plugins` 的 no-store、页面 token 路径前缀准入、
  渲染器平台条件化（#84）：win=系统 WebView2（config `bundleCEF:false` + `defaultRenderer:'native'` + 建窗 renderer 随 availableRenderers），mac/linux=bundleCEF——三处开关与平台化启动断言，
  缺一即回归。

## Agent skills

### Issue tracker

本仓库的 issue 与 spec 统一走 GitHub Issues（hyperion2144/dsh-desktop-bun，`gh` CLI 操作；PRs 不作为 triage 请求面）。See `docs/agents/issue-tracker.md`。

### Triage labels

使用默认五个 triage 角色：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`；`/wayfinder` 另用 `wayfinder:map` / `research` / `prototype` / `grilling` / `task`。See `docs/agents/triage-labels.md`。

### Domain docs

single-context：一个仓库共用一份根目录的 `CONTEXT.md`，架构决定放 `docs/adr/`。See `docs/agents/domain.md`。
