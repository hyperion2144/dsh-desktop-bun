# ADR-0007: OAuth 回调的准入窄豁免——只放跨站 GET 顶层文档导航到 `/oauth/callback`

- 状态：Accepted（2026-10-18）
- 关联：#169（登录两步都断）；前置：准入口径（规格第 2 条）、#130（壳端点鉴权）
- 决策人：维护者（#169 Q1/Q3 拍板「按推荐，不拆分，都在本票做」）

## 背景

壳把页面 origin（`streamBaseUrl` = `http://127.0.0.1:<pagePort>`）作为 `callbackOrigin` 交给宿主，DSH 的 OAuth 授权码必须回到这个 origin。浏览器从平台页（`https://platform.deepseek.com`）跳回时带 `Sec-Fetch-Site: cross-site`（+ `Mode: navigate` / `Dest: document`），壳的 `admission.ts` 先判跨站、再分文档/数据面，回调在第一步就被 403 拦死。

这是壳与官方桌面的结构性差异：官方 Electron 宿主把 host origin 作为 `callbackOrigin`，回调直接打 host，不经过壳；壳的页面 origin 是 loopback 壳端口，回调必然穿过壳的准入。渲染器是 CEF 还是 WebView 与此无关——回调走的是浏览器导航，不是页面脚本。

## 决策

1. **只给一个入口，不整体放宽。** `isOAuthCallbackNavigation` 四条件缺一不可：`pathname` 精确等于 `/oauth/callback`、`method` 为 GET、`Sec-Fetch-Mode: navigate`、`Sec-Fetch-Dest` 有值时为 `document`。其余跨站请求（含同一路径的 POST、截图/脚本等子资源加载）照旧 403。
2. **放行后走数据面转发**，回调原样交给宿主 `/oauth/callback`；`code`/`state` 查询串保留，壳不解析、不缓存、不写日志。
3. **不引入 token 前缀要求**：回调是浏览器从外站发起的顶层导航，拿不到会话令牌，也带不上壳的启动 token。
4. **风险口径**：攻击者最多能让用户浏览器跳到该端点；`state` 是单次挑战、授权码由宿主校验并一次性兑换（PKCE S256），伪造跳转会以 400 收场。壳只多出一个「可被任意网站触发的 GET 转发」，不暴露新数据。
5. **不动的边界**：文档面的 token 前缀准入、数据面的同源校验、`/__shell__/*` 的 view token 鉴权全部保持原样；这条豁免只加在「跨站拒绝」之前的那一刀上。

## 后果

- 正面：登录回调恢复；豁免面最小、可测试（`test/policy.test.ts` 锁住四条件与「其它跨站仍 403」）。
- 负面：多一条需要长期盯住的跨站例外；未来任何「顶层导航」类需求不得顺手复用这条豁免，必须单独 ADR。
- 配套：`test/account-login.test.ts` 覆盖登录地址判定，`test/account-watcher.test.ts` 覆盖主进程 watcher 的开流/去重/重连。
