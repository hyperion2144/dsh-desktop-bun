# dsh-desktop-bun 工作约定

- 壳改动一律在 `desktop-electrobun/` 内；桌面插件在 `desktop-plugin/`（构建 `lib/client.js` 用
  `npm run build:client`，测试 `npm run test:client`）。
- 门禁：`bun run typecheck` + `bun test` 全绿才可提交；CI（build.yml）三平台构建 + 产物断言。
- 提交纪律：一票一提交；`git add` 点名文件（禁 `-A`）；改动后同步 `CHANGELOG.md` 的
  `## Unreleased`；PR 优先，未经维护者允许不合并。
- 契约红线：设置文件键名、`/api` 与 `/plugins` 的 no-store、页面 token 路径前缀准入、
  CEF 三处开关（config bundleCEF / defaultRenderer / 每窗 renderer:'cef'）与启动断言，
  缺一即回归（#220 规格）。
