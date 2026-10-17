# ADR-0003: 壳↔页面通道——官方 Electrobun Typed RPC 是主路，`/__shell__/*` HTTP 降级为兼容与中继面

- 状态：Accepted（2026-10-17）
- 关联：issue #128（三段同票）；前置 #50（官方 RPC 接缝）、#73（`window_state_changed` 推送）、#84（渲染后端）
- 决策人：维护者（#128 Q1 拍板「按推荐，不拆分，都在本票做」）

## 背景

壳（`desktop-electrobun`）与页面（dsh 宿主 WebView + 桌面插件）之间同时存在两条命令通道：

1. **壳自答的 HTTP 端点**：`/__shell__/rpc`（命令漏斗）、`/__shell__/boot`、`/__shell__/window`、`/__shell__/open-external`、`/__shell__/context-menu`、`/__shell__/input-confirm`、`/__shell__/profile-op`，另有跨进程 `activate`、`batch`、反代数据面 `proxy()`、WS 隧道、`health`。
2. **官方 Electrobun Typed RPC**：`BrowserView.defineRPC`，wire 协议 `{type:'request',id,method,params}` / `{type:'response',id,success,payload|error}`，经 `window.__electrobunHostBridge.postMessage` 桥到主进程。

#50 把命令表接上了官方 RPC，但壳 preload 注入页面的五处脚本（boot、标题栏带、开外链、右键菜单、输入确认弹窗）一直在打第 1 条路。两边的代价不一样：HTTP 每次请求要占同源连接（#54 的连接排队）、要过 `admission.ts` 的 token/跨站判定、要维护端点常量与注入脚本里的字面量、且各自有一套字段解析（本次就发现 `context-menu` 的请求解析在命令表与 HTTP 路由里各写了一份并且已经漂移）。

同时插件侧还留着一层**完全不可达的兜底**：`shell-rpc.ts` 的第三级 `fetchInvoke` 与 `available()` 的 view token 判据。桌面主窗拿不到那条路径——view token 与 `rpc:` 端点由同一次建窗成对下发（`index.ts` 的 `views.issue('shell', …)` 与 `rpc:` 一起传），所以插件进程永远走不到 HTTP 兜底分支。它是 #50 之前 Tauri shim 的遗留。

反过来，HTTP 面**不是**废的：远程页面（手机/平板访问）由 `plugins/dsh-mobile-access/lib/proxy.mjs` 把 `/__shell__/rpc` 中继到配对设备，远端浏览器里没有原生桥，只能走 HTTP。

## 决策

1. **主路是官方 RPC，HTTP 降级为「兼容 + 中继 + 数据面」。** 壳 preload 注入的五处脚本全部改调命令表显式方法（`get_boot_payload` / `window_*` / `open_external` / `show_context_menu` / `ui_input_confirm`）。插件侧删掉不可达的 fetch 兜底、view token 判据与无订阅者的 `onMessage`。

2. **接收面单槽，只允许一个 owner。** `window.__electrobun.receiveMessageFromHost` 是全局单槽，后写者赢、先接管者的回包就丢。选定的解法是 preload 最早期安装 `globalThis.__DSH_SHELL_RPC__`：一个 id 空间 + 一个 pending map，**包装框架原 handler 且必须继续调用它**（框架那个 handler 会把早到的包 push 进 `__electrobunPendingHostMessages`，吞掉即丢包）。页面插件的 `createShellRpc()` 改为委托给它，不再自己覆盖。
   preload 与页面在**同一个 JS realm**（preload 里的 `__DSH_SHELL_VIEW_TOKEN__`、`dshDesktopBoot` 都被页面读到，且 preload 里用了 `document`），所以不需要额外解决隔离世界。

3. **两份 dispatcher 实现是故意的重复。** `preload.ts` 的 `shellRpcDispatcherScript()` 产出的是字符串常量，`desktop-plugin/src/client/shell-rpc.ts` 是打包产物里的模块，两边没有可共享的模块边界。代价是协议常量（`MAX_ID`、`DEFAULT_TIMEOUT_MS = 15_000`）要同步改两处——**这里是这条重复的唯一权威清单**，改协议时两边一起改。测试 `test-client.mjs` 锁住「preload 与插件同时发请求回包不丢」。

4. **保留清单（`/__shell__/*` 全量），逐条给理由：**

   | 路径 | 判定 | 理由 |
   | --- | --- | --- |
   | `POST /__shell__/rpc`（**壳侧路由**） | 留 | 远程页面的中继目标。远端浏览器没有原生桥，只能走它。插件侧兜底已删，但路由本身是跨设备面的命脉。 |
   | `POST /__shell__/batch` | 留 | console / 日志批量上报的攒批入口，是数据面不是命令面。 |
   | 反代数据面 `proxy()` + WS 隧道 | 留 | 流式二进制与长连接，官方 RPC 是 JSON-only、无流式/分片/取消，带不动。 |
   | `GET /__shell__/health` | 留 | 远程页面的存活探针。 |
   | 跨进程 `activate` | 留 | 第二个实例 → 既有实例，单实例激活靠 OS 语义，不经 RPC。 |
   | `/__shell__/boot`、`/window`、`/open-external`、`/context-menu`、`/input-confirm` | 路由留、注入脚本不再打 | 兼容面：旧页面/远程页可能仍在打。壳侧路由删掉前先留，避免远程访问在壳升级后突然断。 |
   | `/__shell__/profile-op` | 留 | 独立 `html:` 弹窗窗，没有 rpc 挂点也没有 token。迁官方 RPC 是 #129 的活。 |
   | guest 子视图 | 保持现状 | `sandbox: true`、无 view token，走 `executeJavascript` 推快照。 |

5. **鉴权不降级。** RPC 直达主进程，比 HTTP 更少一层壳，所以命令必须自带闸：
   - `open_external` 用 `isOpenableUrl`（`external.ts`）而不是 `isExternalUrl`。这是**两档口径**：链接口径 `http/https/mailto/tel` 供网页拦截脚本用；命令口径额外放行 `OS_HANDLER_PROTOCOLS` 里的系统 handler 协议。原因是壳内 UI 按钮也要用 `open_external` 唤起系统设置面板（通知设置卡的 `x-apple.systempreferences:`，调用点带 `.catch(() => {})`），硬套链接口径会把它静默吞掉。仍然显式枚举，不退化成 denylist——`javascript:` / `data:` / `file:` 照旧挡死。
   - `show_context_menu` 新增命令，按 RPC 的 view grant 授权（guest/remote 都拒）。**不要在命令上再叠 token/来源校验**：grant 已经过了，重复校验会挡掉合法的 remote lane。
   - 输入确认调已存在的 `ui_input_confirm`（同 handler）。

6. **「请求级失败不重试」不变，且不得顺手加自动重试。** 官方协议没有取消语义；超时的实际行为只是删掉 listener，壳侧 handler 照样跑到底。给 `toggle_zoom` 这类切换命令加自动重试会翻两次执行。

7. **窗口命令以「发起请求的那扇窗」为准。** 漏斗（`createShellRpcFunnel`）拿到的是 `deps.window`，窗口三键与 F13 的 `toggle_zoom` 都直接操作它。只有保留的 HTTP `/__shell__/window` 兜底端点仍走 `focusedWindow()`——HTTP 没有窗口身份可言，这是有意的差异。窗口动作集合收口在 `window-max.ts` 的 `WindowControlAction`，`service.ts` 签名、`shell-server.ts` 校验、`titlebar.ts` 的动作→方法映射共用同一份。

## 后果

- 正面：注入脚本与页面插件走同一条命令面，端点常量、字段解析、鉴权逻辑不再有两份；插件侧那条不可达的 HTTP 兜底消失（「官方通道失败时不该偷偷发 fetch」成为可测断言）；`TITLEBAR_WINDOW_METHODS` 被 `WindowControlAction` 锁住，拼错的动作名在编译期报错而不是在页面里静默不响应。
- 代价：preload dispatcher 与插件 dispatcher 两份实现要同步维护（见决策 3，这是有意的）；保留的 HTTP 路由仍需单测兜住不被误删。
- 风险下限：任何一条迁过去的命令都在漏斗里先过 `isCommandAllowed(grant.kind, method)`，授权语义与 HTTP 面同源，不会因为换通道而放宽。
- 已知残留（本票记录，未修）：
  - `rpc-bridge.ts` 的 `notifyWindowState` 仍向页面推 `window_state_changed`，但新的 dispatcher 只处理 `type:'response'`，这条推送现在结构性无接收方。它在本票之前就没有生产订阅者（插件侧 `onMessage` 零订阅），不是本票引入的回归，但「要么接上订阅方、要么删掉推送」是一张待开的票。
  - stream 聚合档位下，跟随者仍 `await joined.buffered` 等领头整条读完，没有超时也没有取消——与 #54 同源的问题，本票未动。
  - ~~`context-menu` 的请求解析在 `commands.ts` 与保留的 `shell-server.ts` 路由里各有一份且已经漂移~~ —— **已解决（#144-2）**：两边共用 `context-menu.ts` 的 `parseContextMenuRequest`，只剩一份。

## 权限附录：`/__shell__/*` 各端点的鉴权口径（#130 追加）

「保留哪条路由」看决策 4；「那条路由要不要验身份」看这里。两层闸：**第一道网络准入**（`shared/admission.ts` 的 `decide`，同源才放行，跨站一律 403）→ **第二道视图授权**（`authorize()`，查 `x-dsh-shell-view`）。

补第二道之前的事故面：只有 `boot` / `rpc` / `open-external` 验了视图，`context-menu` / `window` / `input-confirm` / `batch` 没有。同源闸门只约束浏览器——本机进程没有 `Origin` / `Sec-Fetch-Site`，`isCrossSite()` 会把它当同源放行，于是「任意本机进程」能弹原生菜单（菜单里的「打开 / 打开文件夹」最终落到 `Utils.openPath(绝对路径)`，而命令表里根本没有 `open_path`，这条菜单是它唯一入口）、能关窗/最小化、能用一个伪造值代答挂起的确认弹窗。

| 端点 | 视图授权 | 理由 / 谁在调 |
| --- | --- | --- |
| `GET /__shell__/health` | 无 | 只读探活，远程监测与启动探针用；不带任何变更能力 |
| `GET /__shell__/boot` | `authorize(null)` | 注入包；页面拿不到就等于黑屏 |
| `POST /__shell__/rpc` | `authorize(cmd)` + `isCommandAllowed` | 命令漏斗；远程页面由 mobile-access 插件带 remote token 中继 |
| `POST /__shell__/open-external` | `authorize(null)` | 任何已登记视图都能开外链；先过 `isExternalUrl` |
| `POST /__shell__/context-menu` | `authorize(null)`（#130 补） | 兼容面，壳内已无生产者（#128 起走 RPC `show_context_menu`） |
| `POST /__shell__/window` | POST `authorize(null)`（#130 补）；GET 不验 | 变更态才需要身份；GET 只读 window state，与 RPC 的 `window_get_state` 同级 |
| `POST /__shell__/input-confirm` | `authorize(null)`（#130 补） | 能解答挂起的确认弹窗，不验身份等于任何人可代答 |
| `POST /__shell__/batch` | `authorize(null)`（#130 补） | 会替调用方打上游；手机端本来就到不了（lane 是纯 TCP 转发，跨站早被第一道闸拦） |
| `POST /__shell__/activate` | 无 | 第二个实例 → 既有实例的跨进程调用；它没有视图，也**不可能**有 token |

两条口径不在表里就会各自拍：①`authorize(null)` = 「任何**已登记**视图都行」，不按命令白名单细分（与 `open-external` 同级）；②`views === undefined`（只建壳不接视图注册表，多见于单测）时 `authorize()` 直接放行，所以新增鉴权不会弄挂这类测试。
