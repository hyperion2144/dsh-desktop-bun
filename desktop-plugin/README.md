# dsh-desktop-bun

DeepSeek Harness 桌面壳的桌面半区插件（DSH plugin）：随宿主挂载后给 dsh 页面注入桌面 chrome——标题栏适配、桌面设置面板、通知设置、下载管理、快捷键桥、控制台镜像等；并注册「DSH 桌面壳」技能与桌面设置的 settings 命名空间。

壳本体（窗口、托盘、服务面、运行时管理）在 [`../desktop-electrobun/`](../desktop-electrobun/)，使用指南见 [GUIDE.md](../desktop-electrobun/GUIDE.md)。

## 构建

```bash
bun install
bun run build:client        # esbuild 打包 src/client → lib/client.js（产物入库，随包分发）
bun run typecheck           # tsc --noEmit（strict）
bun run test:client         # 断言门禁（需 Bun 1.4.x，与 CI 及 hutch 工具链对齐）
```

## 结构

```
index.js           插件入口：技能注册 + 桌面设置 schema + RPC 桥
cordis.patch.yml   bundle 层：安装时自动挂载插件行
src/client/        浏览器半区 TypeScript（桌面 chrome 各模块）
lib/client.js      esbuild 产物（入库）
scripts/           build-client / test-client / build-mobile-client
```

## 客户端能力一览

- **shell-rpc 统一传输层**：官方 Electrobun Typed RPC → mobile-access 中继 → 同源 HTTP `/__shell__/rpc` 三通道，请求级失败可见（通道边界见 [ADR-0005](../docs/adr/0005-shell-page-transport-boundary.md)）。
- **桌面设置面板**（`desktop-settings/`）：dsh 运行时管理、profile 与端口、代理、通知、防休眠、开发者工具、手机访问、更新提醒等卡片。
- **桌面 chrome**：标题栏三键与拖拽带（平台条件化）、右键菜单、下载拦截与管理 Tab、通知设置与音效、快捷键桥（官方 `desktop:<os>` 档）、console 镜像攒批上报。
- **移动访问协作**：guest/远程视图的命令白名单与 mobile-access 中继同一套传输契约。

## 许可

MIT（见 [LICENSE](LICENSE)）。DeepSeek 鲸鱼为官方商标，本项目是非官方客户端。
