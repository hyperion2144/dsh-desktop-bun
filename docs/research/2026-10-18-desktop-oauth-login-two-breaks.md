# 桌面壳 OAuth 登录的两处断点：跨站回调导航被 403 + 主进程不打开系统浏览器

> 状态：triage 调查笔记（2026-10-18）｜关联 #169｜本仓 main `69ddde8`，上游 `687f282e86`（0.2.1-rc.2）
> 结论：两条断点相互独立，①是壳主进程缺少官方桌面同款的账号 watcher；②是壳把页面 origin 当 OAuth 回调基址、回调被壳自己的跨站闸门 403。与渲染器（CEF/WebView）、代理无关。

## 1. 现象

打包态桌面壳（Electrobun）里触发 DeepSeek 账号登录：

1. 弹「等待登录」，系统浏览器**没有**被拉起；只能点「复制登录链接」手动打开。
2. 在浏览器完成平台登录后，平台 302 回 `http://127.0.0.1:6390/oauth/callback?code=…&state=…`，页面只有一行 `forbidden`（403）。

## 2. 回调为什么被 403：Fetch Metadata 的语义

- 浏览器的这一次跳转是**跨站顶层导航**：`Sec-Fetch-Site: cross-site`、`Sec-Fetch-Mode: navigate`、`Sec-Fetch-Dest: document`；因为是文档导航，浏览器不发 `Origin` 头（壳日志里 `origin=-` 正对应这一点）。
- MDN 对 `Sec-Fetch-Site` 的定义：`cross-site` = 请求发起方与目标资源不同站点；`none` = 地址栏输入 / 书签 / 拖放等用户发起；对不被接受的请求，默认用 403 拒绝。该头只对 potentially trustworthy URL 发送。（[MDN]）
- W3C Fetch Metadata 规范同义：服务端据此判断请求来源，可拒绝跨站请求。（[W3C]）
- 结论：壳的 `isCrossSite`（`Sec-Fetch-Site ∉ {same-origin, none}` ⇒ 跨站）判定本身符合语义；问题出在准入策略把**所有**跨站请求一刀切 403，连带拒绝了合法的 OAuth 回调。

## 3. 放行回调的风险评估（为什么窄豁免可接受）

OAuth 2.0 授权码流程自带两层防护：

- `state`：客户端发起时生成、回调时回传校验，用于防 CSRF（RFC 6749 §10.12）。
- 授权码：一次性、短时效（建议 ≤10 分钟）、绑定 `client_id` 与 `redirect_uri`（RFC 6749 §4.1.2 / §4.1.3）。上游实现另有 PKCE S256（RFC 7636）与 attempt 匹配校验。

若壳只放行「`GET` + 顶层文档导航 + 路径恰为 `/oauth/callback`」，其余跨站请求仍 403：

- 暴露面 = 一个**无需凭据、只读**的入口：请求只带查询参数，不向第三方泄露 cookie/凭据。
- 伪造 `code/state` 对会被上游拒绝（state 不匹配 400、code 一次性、PKCE 绑定）。
- 比放行全部跨站顶层导航安全得多；比「改 callbackOrigin 绕开壳」对现有传输契约的扰动小。

> 实现时需确认：放行后壳把该请求转发上游时，上游 `/oauth/callback` 不依赖被壳抹掉的 `Origin`/`Sec-Fetch-*` 头（当前探针是 404 路径，未走真实 attempt）。

## 4. 官方桌面为什么不遇到这两个问题

- ① 官方 Electron 主进程订阅账号流：`accountBackend.watch(state)`，attempt 进入 `waiting-browser` 且带 `authorizeUrl` 时 `shell.openExternal(platformLoginUrl(authorizeUrl))`，按 attempt id 去重（`apps/desktop/src/main.ts`）。页面侧 `BrowserLogin`（`window.open("about:blank")`）只在纯 web 客户端走，桌面分支明确 `if (desktop) await request()`，注释为「Desktop main opens the authorization page natively」。
- ② 官方 `account-backend.ts` 的 `startSignIn` 把 `callbackOrigin` 设为 **host origin**（`new URL(origin).origin`，origin = host URL），回调直连 host、不经过 app 壳；本仓壳的页面 `startSignIn` 取 `streamBaseUrl` 的 origin，而壳把它设成**页面 origin**（`http://127.0.0.1:${pagePort}`）⇒ `redirect_uri` 落在壳上，回调必经过准入闸门。这是本壳与官方桌面的结构性差异。

## 5. 复现证据（本机只读，未涉及真实登录）

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: navigate' \
  'http://127.0.0.1:6390/oauth/callback?code=probe&state=probe'
# 403；正文 forbidden

curl -sS -o /dev/null -w '%{http_code}\n' \
  'http://127.0.0.1:6390/oauth/callback?code=probe&state=probe'
# 404（被转发到上游；无进行中的 attempt）

# 壳日志（$DSH_HOME/shell.log）
# [shell] 拒绝跨站请求 /oauth/callback（origin=-）
```

## 6. 结论与修复方向

- ① 壳主进程补账号 watcher：订阅 host 的账号状态流（官方用 WebSocket 连 `REMOTE_STREAM_MUX_PATH`，header 带 cookie 与 host origin），`waiting-browser` 时打开系统浏览器，按 attempt id 去重，`succeeded/failed/expired` 收尾。
- ② 准入窄豁免：`GET` + 顶层导航（`Sec-Fetch-Mode: navigate`）+ 路径恰为 `/oauth/callback` 放行；其余跨站请求维持 403；补单测与（按仓库习惯）ADR 记录口径。
- 备选（不推荐、风险大）：让桌面分支的 `callbackOrigin` 走 host origin——会改动页面 `streamBaseUrl` 的语义，牵涉传输契约。

## 参考

- [MDN] Sec-Fetch-Site：https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site （2026-09-28 更新）
- [W3C] Fetch Metadata Request Headers：https://w3c.github.io/webappsec-fetch-metadata/#sec-fetch-site-header
- [RFC 6749] OAuth 2.0 §4.1.2 Authorization Response、§10.12 CSRF：https://www.rfc-editor.org/rfc/rfc6749
- [RFC 7636] PKCE：https://www.rfc-editor.org/rfc/rfc7636
- 上游实现：`apps/desktop/src/main.ts`（账号 watcher）、`apps/desktop/src/account-backend.ts`（startSignIn / watch），commit `687f282e86`
