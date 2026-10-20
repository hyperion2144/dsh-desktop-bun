# 桌面壳反代 SSE 每 ~10s 被切断：壳侧 Bun.serve idleTimeout 定位

- 日期：2026-10-18
- 仓库：`dsh-desktop-bun`
- 基线：`763c6b5`（#159 报告时运行中的壳起于 `e067e7b`；两 commit 之间 `shell-server.ts` 无改动）
- 触发：issue #159「桌面壳 SSE 代理每 ~9s 断流」
- 性质：只读诊断 + 本机 curl 对照 + `/tmp` 最小 Bun 实验；无业务代码改动

## 结论

**主因已确认在壳侧：壳的 loopback HTTP 服务（页面 origin `127.0.0.1:6390`）使用 `Bun.serve` 时没有设置 `idleTimeout`，Bun 1.4.0 的默认空闲超时会在约 10–12s 后切断没有新 chunk 的 SSE 响应，页面侧表现为 `ERR_INCOMPLETE_CHUNKED_ENCODING`，EventSource 每 3s 重连，形成 ~12s 循环。**

上游 DSH 服务不是主因：绕过壳直连 `127.0.0.1:3081` 的同两条 SSE 在 20s 内保持打开。两条 SSE 都没有心跳，这是**促成条件**，但不是充分原因；客户端 3s 重连是**放大器**。

## 关键证据

### 1. 直连上游 vs 经壳（本机实测）

`/api/auto-continue-bridge`：

```text
# 直连上游 3081：20s 仍未断（curl 28）
curl -N --max-time 20 -sS -o /dev/null \
  -w 'http=%{http_code} time=%{time_total}\n' \
  http://127.0.0.1:3081/api/auto-continue-bridge
# http=200 time=20.005746, exit 28 (Operation timed out)

# 经壳 6390：约 10.5s 后以 curl 18 结束
curl -N --max-time 20 -sS \
  -H 'Origin: http://127.0.0.1:6390' \
  -H 'Sec-Fetch-Site: same-origin' -o /dev/null \
  -w 'http=%{http_code} time=%{time_total}\n' \
  http://127.0.0.1:6390/api/auto-continue-bridge
# http=200 time=10.548086, exit 18
# curl: (18) transfer closed with outstanding read data remaining
```

`/plugins/events`：

```text
# 直连上游：20s 未断（curl 28），期间收到 41661 bytes
# 经壳：http=200 time=11.976027, exit 18，收到 41661 bytes
# 同一响应体大小，但壳在空闲后没有发送合法的 chunked 终止块
```

这与页面 console 的 `ERR_INCOMPLETE_CHUNKED_ENCODING` 完全同形；壳日志对应 `[proxy] SLOW ... total≈9000ms ... -> 200`，`total` 是壳侧从 fetch 开始到流结束的时长，所以略小于 curl 从连接建立算起的 10.5–12s。

### 2. 壳代码未设置 idleTimeout

- `desktop-electrobun/src/bun/shell-server.ts:477` 的 `Bun.serve` 只设置 `hostname`、`port`、`fetch`（以及泛型），**没有 `idleTimeout`**。
- 同文件 `:183` 的 `trackedResponse` 把上游 `ReadableStream` 逐 chunk 透传给页面；空闲时没有数据，就会落进 Bun 的 idle 超时。
- 文件头注释明确写着「SSE 不再有寿命上限（那与 page_shim 一样是 Tauri 妥协，随迁移删除）」——当前实现与这条意图不一致。

### 3. Bun 1.4.0 最小实验

用 hutch 工具链的 Bun 1.4.0 起一个只发首帧、永不关闭的 SSE：

```text
默认（不设 idleTimeout）：curl 在 12.003896s 结束，exit 18
idleTimeout: 0：curl 在 15s 超时（exit 28），连接保持
idleTimeout: 30：curl 在 15s 超时（exit 28），连接保持
```

脚本：`/tmp/sse-idle-zero.mjs`（另见 `/tmp/sse-idle-test.mjs`）；运行时：`~/.hutch/toolchains/bun/1.4.0/macos-arm64/bun`。

## 根因候选与置信度

| 候选 | 置信度 | 判断 |
| --- | --- | --- |
| C1 壳 `Bun.serve` 默认 idleTimeout 切断空闲 SSE | **高（0.95）** | 直连上游 20s 不断、经壳 10.5–12s 断；壳代码无 `idleTimeout`；最小实验复现同形 |
| C2 上游 DSH 宿主关闭 SSE | **极低（0.02）** | 直连上游 20s 未断，已证伪 |
| C3 两条 SSE 无心跳 | **中（0.6，促成条件）** | 上游直连同样无心跳却保持，说明不是充分原因；但任何有空闲超时的中间层都会踩到 |
| C4 壳的 `trackedResponse` 把超时转成 incomplete chunked | **中（0.8，机制层）** | `total≈9000ms -> 200`、页面看到 200 + incomplete；是 C1 的表现路径，不是独立主因 |
| C5 客户端 3s 重连 | **低（0.1，放大器）** | 决定 ~12s 的循环节奏，不产生首次断流 |

## 影响范围

- 所有经壳 loopback 反代、且空闲超过 Bun idleTimeout 的 SSE / 长连接：目前明确观察到 `/plugins/events` 与 `/api/auto-continue-bridge`；其他插件 SSE 走同一代理时同样有风险。
- `/plugins/events` 每次重连重发完整 graph（实测约 41.6KB）；按 ~12s 一轮约 5 次/分钟，约 12.5MB/小时的本机回环传输与 JSON 解析，外加 console error 刷屏。
- 页面仍可用，EventSource 自动重连可自愈；但断流窗口内可能延迟/漏掉图变更通知，需在修复后确认。
- `api/changes.summary` 的 404 是独立问题，不在本单主症内。

## 修复面

- 壳的 loopback `Bun.serve` 需要显式 idle 策略：对 SSE 不能按 10s 默认值切断。可选：
  1. `idleTimeout: 0`（loopback-only、已有同源准入；最直接，但需评估是否接受无限空闲连接）；
  2. 设置更大的有限值 + 给 SSE 注入心跳（对非 SSE 保留有界 idle 保护）。
- 回归测试可复用 `desktop-electrobun/test/data-plane.test.ts` 的 `startShellServer` + mock upstream 习惯：mock upstream 发一帧后保持 20s，断言经壳的响应在 20s 内不结束；当前默认值会让该测试失败。
- 上游加心跳可作为纵深防御，但不是本单的必要条件；不建议把修复责任推给两条上游插件。

## 未决 / 待维护者拍板

1. 是否接受壳 loopback server 关闭 idleTimeout（推荐），还是选择「有限超时 + SSE 心跳」。
2. `api/changes.summary` 404 是否另立单（建议另立，不并入 #159）。

## 来源

- `desktop-electrobun/src/bun/shell-server.ts`（`Bun.serve` :477、`trackedResponse` :183）
- `desktop-electrobun/test/data-plane.test.ts`（`startShellServer` / mock upstream 测试习惯）
- `~/.dsh/shell.log`、`~/.dsh/dsh-desktop-webview.log`
- `/tmp/sse-idle-test.mjs`、`/tmp/sse-idle-zero.mjs`
- 本机 curl 对照（2026-10-18，见上）
