# dsh-desktop-bun 工作约定

- 壳改动一律在 `desktop-electrobun/` 内；桌面插件在 `desktop-plugin/`（构建 `lib/client.js` 用
  `npm run build:client`，测试 `npm run test:client`）。
- 门禁：`bun run typecheck` + `bun test` 全绿才可提交；CI（build.yml）三平台构建 + 产物断言。
- 提交纪律：一票一提交；`git add` 点名文件（禁 `-A`）；改动后同步 `CHANGELOG.md` 的
  `## Unreleased`；PR 优先，未经维护者允许不合并。
- 契约红线：设置文件键名、`/api` 与 `/plugins` 的 no-store、页面 token 路径前缀准入、
  CEF 三处开关（config bundleCEF / defaultRenderer / 每窗 renderer:'cef'）与启动断言，
  缺一即回归。

## Agent skills

### Issue tracker

本仓库的 issue 与 spec 统一走 GitHub Issues（hyperion2144/dsh-desktop-bun，`gh` CLI 操作；PRs 不作为 triage 请求面）。See `docs/agents/issue-tracker.md`。

### Triage labels

使用默认五个 triage 角色：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`；`/wayfinder` 另用 `wayfinder:map` / `research` / `prototype` / `grilling` / `task`。See `docs/agents/triage-labels.md`。

### Domain docs

single-context：一个仓库共用一份根目录的 `CONTEXT.md`，架构决定放 `docs/adr/`。See `docs/agents/domain.md`。
