# inspector 面板快捷键初载静默失效：bootstrap 失败路径逐行核实与修复面评估

- 日期：2026-10-17
- 仓库：`dsh-desktop-bun`（Electrobun/Bun 桌面壳），只读调查，无代码改动
- 基线 commit：`6e5f07f`
- 触发：issue #68「inspector 面板快捷键初载可能静默失效——bootstrap 获取失败无重试（上游行为）」，源自 #61 验机过程
- 调查方式：仓内三份 `lib/client.js` 逐行 diff + npm 六个版本 tarball 对比 + 上游 `deepseek-harness` master 源码/commit 检索 + 壳与宿主启动链只读走查
- 现场环境：本机已安装 `/Applications/DeepSeek Harness Desktop BUN.app`（内置运行时 0.2.1-rc.2）；仓内物化树 `desktop-electrobun/builtin-runtime/`（0.2.1-alpha.2）

**证据分级标注**（全文统一）：

| 标记 | 含义 |
|---|---|
| 【实测】 | 本机对仓内文件 / 已安装产物 / npm tarball 的只读观测（附 md5、行号、diff） |
| 【源码】 | 上游 `deepseek-ai/deepseek-harness` master 或仓内运行时文件源码 |
| 【推断】 | 由上述证据推出，仓内与上游均未明说 |
| 【未证实】 | 假设缺关键证据，不能作为结论 |

---

## 0. 结论速览

| # | 问题 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | `client.js` 三份副本是否同一逻辑？ | **是，且逐字节相同**。仓内 alpha.2、已装 app 的 rc.2、dev 构建产物的 `lib/client.js` md5 全为 `39f4fd68f6f67d3362f05cae33b79053` | 【实测】`diff` 退出码 0；【实测】md5 三份一致 |
| 2 | npm 上 alpha.2→rc.2（2026-10-09 → 2026-10-17，六个版本）`client.js` 变过吗？ | **一次都没变**，md5 恒为 `39f4fd68…`。浏览器侧「fetch 失败只 warn 一次、无重试无退避」到 rc.2 为止成立 | 【实测】六个 tarball `package/lib/client.js` md5 全等 |
| 3 | 宿主侧的启动竞态呢？ | **上游已在 `0.2.1-alpha.4` 修掉**（commit `bf1a2bf69` 2026-10-14「serve the Client bootstrap while the Inspector Worker starts」）：bootstrap 路由**先注册**，请求 `await ready.promise` 直到 Worker 就绪 | 【实测】alpha.3 及更早无 `bootstrapResponse`，alpha.4 起有；【源码】master `host/plugin.ts:52-66` |
| 4 | 本仓现在处于哪个状态？ | `desktop-electrobun/builtin-runtime.json` 已声明 `0.2.1-rc.2`（commit `806aa42`，今天），但**仓内物化树仍是 alpha.2**（gitignore，按需物化）——本地复现会一直踩在未修的那一侧 | 【实测】`git show HEAD:desktop-electrobun/builtin-runtime.json` = rc.2；`package.json` = alpha.2 |
| 5 | 那 #68 的定位对不对？ | **半对**。「客户端无重试」是事实且是放大器，但**主因候选应是宿主侧注册时序**（alpha.2 把路由注册排在 `await startInspector()` 之后，Worker 起得慢就 404），而这条上游已修、rc.2 已含。把 #68 当纯上游行为、等上游，代价是白等 | 【实测】`lib/index.js` diff |
| 6 | 面板注册链在哪一步会「静默」？ | `replace()` 里的 `ctx.inject([...], async ctx => { require.async('./client.page.js'); registerInspectorPage(...) })` **没有被 await**（`client.js:3537`），内层抛错时 `apply()` 照样 resolve、连接照样算健康、**没有任何 warn**，`inspector.toggle`（注册在 `client.page.js:245`）永不出现 | 【源码】`client.js:3537-3545`；`client.page.js:170,245` |
| 7 | 有几条 warn 出口？ | 三条，共用同一句文案：`readBootstrap` 的 fetch catch（3491）、`!response.ok`（3495）、`replace` 里 `startInspectorClient` 失败（3523）。而 `response.json()` / `parseInspectorClientBootstrap` 抛错、`ctx.inject` 内层抛错**都不走 warn**，签名完全不同 | 【源码】`client.js:3501-3504` |
| 8 | 唯一的重触发点 | `ctx.on('connection/reset')`（`client.js:3457`），由 `dsh-api-gateway` 的 `onConnected` 发出（`dsh-api-gateway/lib/client.js:1608`），即网关 WS 每次连上/网络恢复（`watchBrowserNetwork`）才补一次 | 【源码】两处 |
| 9 | inspector 默认开着吗？ | **不开**。壳种 profile 时只放 `['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']`，inspector 在上游 `OPTIONAL_BUNDLES` 里（`dsh-app-boot/lib/index.js:576`），属插件市场按需开启 ⇒ 首载窗口天然存在 | 【源码】`runtime/dsh-host.mjs` WEB_PROFILE_BUNDLES；`service.ts` initProfile 同款 |

---

## 1. Q1：三份副本的 bootstrap 失败路径逐行核实

### 1.1 三份副本同一性（【实测】）

```
$ md5 -q desktop-electrobun/builtin-runtime/node_modules/@deepseek-ai/dsh-experimental-inspector/lib/client.js
39f4fd68f6f67d3362f05cae33b79053
$ md5 -q "/Applications/DeepSeek Harness Desktop BUN.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai/dsh-experimental-inspector/lib/client.js"
39f4fd68f6f67d3362f05cae33b79053
$ diff A/lib/client.js B/lib/client.js   # 仓内 vs 已装 app
exit=0   # 0 行差异
```

扩展到 npm 全版本线（`npm pack` 六个版本后逐个 md5）：

| 版本 | 发布时间 (UTC) | `lib/client.js` md5 | `lib/index.js` 含 `bootstrapResponse` |
|---|---|---|---|
| 0.2.1-alpha.2 | 2026-10-09T08:13:31Z | `39f4fd68…` | 否 |
| 0.2.1-alpha.3 | 2026-10-14T12:28:44Z | `39f4fd68…` | 否 |
| 0.2.1-alpha.4 | 2026-10-15T12:56:59Z | `39f4fd68…` | **是** |
| 0.2.1-alpha.5 | 2026-10-16T12:22:33Z | `39f4fd68…` | 是 |
| 0.2.1-rc.1 | 2026-10-17T03:09:56Z | `39f4fd68…` | 是 |
| 0.2.1-rc.2 | 2026-10-17T08:28:44Z | `39f4fd68…` | 是 |

> 结论：**浏览器侧六个版本一字未改**，宿主侧从 alpha.4 起换了实现。这条把 issue 里「上游行为」的说法从「整条链都没修」修正为「只有宿主侧修了」。

### 1.2 `apply()` 主路径（【源码】`desktop-electrobun/builtin-runtime/node_modules/@deepseek-ai/dsh-experimental-inspector/lib/client.js`）

```
3454  async function apply(ctx) {
3455    const session = new InspectorClientSession(ctx);
3456    ctx.effect(() => () => session.dispose(), "experimental-inspector: Client lifetime");
3457    ctx.on("connection/reset", () => {
3458      session.refresh().catch((error) => {
3459        ctx.logger.warn("experimental-inspector: Client connection failed; reconnect or reload the page to retry", error);
3460      });
3461    });
3462    const injected = globalThis.__DSH_INSPECTOR__;
3463    if (injected !== void 0) await session.connect(parseInspectorClientBootstrap(injected));
3464    else await session.refresh();
3465  }
```

- 有注入全局 ⇒ 走 `connect()`，**根本不 fetch**（3463）。
- 无注入全局 ⇒ 走 `refresh()` → `readBootstrap()` → fetch 相对路径 `api/experimental-inspector/bootstrap`（`client.js:21` 的 `.slice(1)` 去掉了前导斜杠，文档相对解析，落在 token 前缀下）。
- 唯一补发点：3461 的 `connection/reset`。

### 1.3 全部失败分支及其可观测签名（【源码】）

| # | 分支 | 位置 | 行为 | 可观测签名 |
|---|---|---|---|---|
| F1 | `fetch` 抛错（网络中断 / 壳 502 / abort） | `client.js:3489-3493` | `connectionFailed(error)` → `return` | **warn 一次**，句柄已注册，无重试 |
| F2 | `!response.ok`（宿主 404 未注册 / 503 / 壳 502） | `client.js:3494-3497` | `connectionFailed(new Error(\`Inspector bootstrap failed: HTTP ${status}\`))` → `return` | **warn 一次**（错误对象里带状态码），无重试 |
| F3 | `response.json()` 抛错（截断 / 非 JSON） | `client.js:3498` | 异常穿出 `readBootstrap` → 穿出 `enqueue`（3512 的 `pending`）→ **`apply()` reject** | **无 warn**；Cordis 记插件启动错误并回滚 fiber，`inspector.toggle` 永不注册 |
| F4 | `parseInspectorClientBootstrap` 抛错（字段/URL 校验） | `client.js:3499` → 定义在 `client.js:150-196` | 同 F3：`apply()` reject | **无 warn**，fiber 回滚 |
| F5 | `startInspectorClient` 抛错（realm claim / WS 构造） | `client.js:3520-3524` | `connectionFailed(error)` → `return` | **warn 一次**（与 F1/F2 同文案，但 error 内容不同） |
| F6 | `ctx.provide` / `ctx.inject` / `publishCordisTree` 同步抛错 | `client.js:3531-3546` 的 try/catch | 先 `dispose()` 回滚再 **`throw`** ⇒ `apply()` reject | **无 warn**（除非回滚本身失败，才多一条 `…rollback failed` error） |
| F7 | **`require.async("./client.page.js")` / `registerInspectorPage` 抛错** | `client.js:3537-3544`，**`ctx.inject` 未 await** | 内层 fiber 自己 reject，外层毫不知情：`replace()` 正常收尾（3556-3558 写 `this.bootstrap`/`this.release`），`apply()` 正常 resolve | **完全静默**——连接看起来健康，面板与快捷键不存在，且再也不会有第二次机会 |

F7 是本题里最值得单独立票的隐患：它是唯一一条「面板打不开、但日志里什么线索都没有」的路径。`inspector.toggle` 的注册点在 `lib/client.page.js:245`（`ctx.shortcuts.register({ id: ID, ... })`，`ID = "inspector.toggle"` 定义在 `client.page.js:170`），只有经 F6/F7 这条 `ctx.inject` 才能到达。

> 排错口径建议：面板打不开时先看浏览器控制台有没有 `experimental-inspector: Client connection failed…`。**没有这行 warn ≠ 正常**——F3/F4/F6 走的是插件启动错误，F7 一行日志都不留。

### 1.4 上游 master 现状（【源码】）

`gh api repos/deepseek-ai/deepseek-harness/contents/packages/experimental/inspector/src/client/plugin.ts`：

```ts
private async readBootstrap(): Promise<void> {
  let response: Response
  try {
    response = await fetch(INSPECTOR_BOOTSTRAP_ROUTE, { signal: this.lifetime.signal })
  } catch (error) { this.connectionFailed(error); return }
  if (!response.ok) {
    this.connectionFailed(new Error(`Inspector bootstrap failed: HTTP ${response.status}`)); return
  }
  const value: unknown = await response.json()
  await this.replace(parseInspectorClientBootstrap(value))
}
```

master 与 alpha.2 逐行同构：**到今天仍然没有任何重试、退避或超时**。issue 描述的「上游行为」在这一半上完全成立。

---

## 2. Q2：触发窗口分析

### 2.1 宿主侧竞态的精确形状（【实测】diff + 【源码】行号）

**alpha.2（= 仓内物化树）** `lib/index.js`：

```
2378  async function apply$1(ctx, config) {
2379    await ctx.effect(async () => {
2380      const spec = resolveInspectorOptions(config);
2381      const handle = await startInspector(spec);      // ← 先等 Worker（含 worker 启动 + 端口分配）
...
2392      disposers.push(ctx.on("webserver/index-inject", (table) => {
2394          name: "__DSH_INSPECTOR__",
2395          value: handle.endpoint.client
...
2398      disposers.push(ctx.connection.fetch.register({  // ← 路由排在 Worker 之后
2400          path: INSPECTOR_BOOTSTRAP_PATH,
2402          fetch: () => Promise.resolve(Response.json(handle.endpoint.client, …))
```

**rc.2（= 已装 app）** `lib/index.js`：

```
2391  disposers.push(ctx.connection.fetch.register({     // ← 路由先注册
2395    fetch: (request) => bootstrapResponse(ready.promise, request.signal)
2396  }));
2397  const handle = await startInspector(spec).catch((error) => {
2398    if (!isUnavailableOnPlatform(error)) throw error;
2400    ctx.logger.warn("experimental-inspector: NodeJS Inspector is unavailable on this platform; …")
2402  if (handle === void 0) { ready.resolve(void 0); return dispose }   // → 503
2412  disposers.push(ctx.on("webserver/index-inject", (table) => { … }))
2517  ready.resolve(handle.endpoint.client);
2533  function isUnavailableOnPlatform(error) { … "code" === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" }
2542  async function bootstrapResponse(ready, signal) {          // 竞速 ready 与页面 abort
2554    const client = await Promise.race([ready, abandoned.promise]);
2555    return client === void 0 ? new Response(null, { status: 503, headers }) : Response.json(client, { headers })
```

rc.2 上游注释原文（`host/plugin.ts:52`，master）：

> *The bootstrap route exists before the Worker is ready, so a Client published during startup waits instead of failing.*

【源码】cordis 侧 effect 的 await 语义：`Fiber.await()`（`cordis/src/fiber.ts:704-710`）只等 `inertia`；但 `apply$1` 自己 `await ctx.effect(async …)`，所以**`apply()` 的 promise 一定等到路由注册完**。`cordis-plugin-loader` 的 `EntryTree.await()`（`cordis-plugin-loader/lib/index.js:152-160`）等的是 `entry._initTask || fiber.inertia`，而 `_initTask` 就是 apply 的 promise（`:438`）。

### 2.2 时点表

| 时点 | 发生了什么 | 证据 |
|---|---|---|
| T0 | 宿主进程 `--preload` 阶段：bun-preload 落盘补丁（早于任何插件/页面加载） | `resources/dsh/bun-preload.mjs` 顶部注释与 Patch 12/13/14 循环 |
| T1 | `boot()` → `mountRootInclude` → `await ctx.get("loader")?.await()`，等**当前树里所有**插件 init task | `dsh-app-boot/lib/index.js:4271-4272` |
| T2 | `await application` 返回 → `collectIndexInjections()` → 打印 `HOST-READY {…injections}`，**注入清单在这一刻冻结** | `desktop-electrobun/runtime/dsh-host.mjs` |
| T3 | 壳拿到 HOST-READY 才把页面指给 WebView；页面 HTML 里带 `BOOT_LINE`（`__DSH_BOOT_READY__`） | `desktop-electrobun/src/bun/shell-server.ts` `BOOT_LINE` |
| T4 | 页面执行 client bundle 图 → 各 client 插件 `apply()`，inspector 在其中 | `client.js:3454` |
| T5 | T2 之后每 1s 轮询 `collectIndexInjections()`，变了补发 `HOST-INJECTIONS`（壳更新 boot 载荷，供**下一次**刷新用） | `dsh-host.mjs` `INJECTIONS_WATCH_MS = 1_000` |

### 2.3 「首载 fetch 失败」候选原因，逐项证据强度

| # | 候选 | 机制 | 证据强度 |
|---|---|---|---|
| C1 | **宿主插件 apply 晚于页面首载，路由还没注册 → 404 → F2** | inspector 是 OPTIONAL bundle，不在 `dsh-app-boot/lib/index.js:568-579` 的默认层里；壳种 profile 也只放 base+web-app。宿主 fiber 起来后要 `await startInspector()` 才注册路由（alpha.2）。issue 自述「同 DSH_HOME 复测面板约 +2.5s 注册成功」正好落在这个窗口里 | **强**。唯一能同时解释「首次打不开」「重启后正常」「时间尺度 ~2.5s」的机制，且被 alpha.2↔rc.2 的 diff 直接印证 |
| C2 | 注入行晚到（`__DSH_INSPECTOR__` 不在页面里） | 这本身**不该**导致失败：注入缺失只让代码走 `refresh()`，而 fetch 是兜底路径。只要路由已注册就该成功 | **弱**（是 C1 的伴随现象，不是独立原因） |
| C3 | 壳反代 502 `upstream unreachable` | 壳转发时上游 fetch 抛错即回 502（`shell-server.ts:402`，批量子请求同款 `:341`）。宿主刚起、上游端口未 listen、或连接被掐都会命中 → F2（`HTTP 502`） | **中**。可解释「刷新无效」（只要上游持续不可达就一直 502），但解释不了「重启恢复」之外的自愈 |
| C4 | GET 单飞取消 / 跟随者掉队 | 单飞只在 GET 且非 passthrough 档生效；跟随者被页面取消回 499（`shell-server.ts:373`），等满 `FOLLOWER_WAIT_MS = 10_000`（`coalescing.ts:27`）掉队后**自己再打一次**（`shell-server.ts:376-378`）。引导请求那次会命中；首个 inspector bootstrap 通常是**领头**（无同 URL 并发） | **弱**。499 只在页面主动 abort 时出现；掉队反而会自愈 |
| C5 | Worker 起不来 → 503 | 仅 rc.2 才有：`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`（浏览器宿主无 `worker_threads`）→ 路由常驻回 503。本壳宿主是 Bun，路径存在 | **中低**（alpha.2 无此分支；rc.2 下若有，重试也救不回来） |
| C6 | `response.json()` / `parseInspectorClientBootstrap` 抛错 → F3/F4，`apply()` reject | 需要响应体被截断或字段不符。壳反代对 ≤256KB 带 content-length 的 GET 会整条缓冲转发（`shell-server.ts:169` `SINGLEFLIGHT_MAX_BYTES`），理论上不截断 | **中低**。【未证实】无现场日志 |
| C7 | `ctx.inject` 内层抛错 → F7，纯静默 | 需要 `require.async('./client.page.js')` 失败或 `registerInspectorPage` 抛错。`client.page.js` 满足 dsh-client-modules 的分块白名单 `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`，通常会被服务 | **低**。【未证实】但**危害最大**（无任何线索），值得单开探针 |
| C8 | 页面/宿主重启窗口 | 壳把 boot 载荷冻在 HOST-READY；`HOST-INJECTIONS` 补发只影响**下一次**刷新。若插件是在页面加载**之后**才被启用（插件市场热装），当前页面永远拿不到 `__DSH_INSPECTOR__` | **中**。解释「一次性、刷新表现不一致」 |

### 2.4 「刷新页面无效」怎么解释

前提：刷新 ⇒ 插件 `apply()` 重跑 ⇒ `refresh()` 重发 fetch。**只要失败是瞬时的，刷新本该自愈**。所以「刷新无效」反过来约束了原因——它更像持久性失败：

1. **失败是持续的**（C3/C5/C6/C7）：刷新只是把同一条路径再走一遍，仍然失败。（【推断】最省事的解释）
2. **刷新的不是那张页面**：dsh-client-hmr 的 stat 轮询可能只重算 client-module 图并热替换，不等于整页导航；`HOST-INJECTIONS` 也要壳侧再发一次才影响 boot 载荷。若验机时点的是 UI 层的「刷新」而非 `Cmd+R`，等于没刷新。
3. **刷新发生在窗口内**：刷新后新页面的 client `apply()` 仍可能早于宿主路由就绪（窗口只有几百 ms 到 2.5s 量级），连续几次刷新都可能落在窗内；重启应用则必然等到 HOST-READY 之后才开页面。
4. **`connection/reset` 抢跑**：若刷新时网关在 inspector `apply()` **之前**就连上并 emit 过一次 reset，那这唯一一次补发机会也被用掉了；此后 WS 一直健康，就再没有第二次。网关的 `start()` 在 `loader.await()` 之后 `start()`（`dsh-api-gateway/lib/client.js:1615-1616`），与 inspector client `apply()` 的先后**无固定顺序**——这是一条【推断】但竞争关系真实的竞态。

> 收敛：#68 的现象最省力且证据最硬的解释是 **C1（宿主侧注册竞态，alpha.2 独有）**；「刷新无效」用 1 或 2 补。**C1 已被 rc.2 上游修掉**，所以本仓的真正待办是「别再跑在 alpha.2 上」+「给 F7 留一条可观测的失败口」。

---

## 3. Q3：修复方案对比

| 方案 | 做法 | 可行性 | 影响面 | 测试成本 | 评价 |
|---|---|---|---|---|---|
| **A. bun-preload 给浏览器侧 `client.js` 加有界退避重试** | 在 Patch 16 里改 `readBootstrap()` 的 **F1/F2 两处**失败分支，改调一个新的 `retryBootstrap()` | 高。`packageTargets('@deepseek-ai/dsh-experimental-inspector/lib/client.js')` 可直接复用；改动是纯字符串替换，和 Patch 12/13/14 同构 | 只碰**落盘副本**，不改仓内源码；Node 进程不受影响（本补丁只在宿主 `--preload` 阶段写文件，Node 跑 dsh 时不会执行 bun-preload）；共享运行时树会一起被打（`packageTargets` 扫全部 `node_modules` 根，见 `bun-preload.mjs` nodeModulesRoots） | 中高。要真跑浏览器侧逻辑才算（见 Q4），纯 `toContain` 不算数（#112 的教训） | **值得做，但定位是「兜底」不是「根治」** |
| **B. 改宿主侧注册时序** | 把路由注册提到 `await startInspector()` 之前 | **已经在 rc.2 里了**（上游 `bf1a2bf69`）。本仓要做的是让物化树真的到 rc.2 | 只改声明版本 + 物化；无补丁代码 | 低（`verifyBuiltinTree` 会 fail 构建） | **首选**。剩下的问题是「本地树陈旧」这一工程问题 |
| **C. 壳侧提前注入 `__DSH_INSPECTOR__` 或壳代理重试** | 壳在 boot 载荷里预置全局 / 壳给 bootstrap 路由加重试 | 提前注入做不到：值来自宿主 Worker 的 endpoint，壳无从得知。壳代理重试与 #54 拍板口径**直接冲突**——`shell-server.ts:376-378` 的注释明写「也正是因此绝不给任何**已发出**的请求加自动重试」 | 会污染壳的统一口径，破坏单飞语义 | — | **否**（口径冲突，#54 已拍板） |
| **D. 上游修（deepseek-harness PR）** | 给 `InspectorClientSession.readBootstrap` 加退避，或让 `apply()` 在失败后保留重试循环 | 仓库是公开上游，可提 PR；但 client.js 六版本零变更说明这块不在他们的活跃面上 | 无本地影响 | 低 | **并行提**，但不阻塞 |
| **E. 不做 / 等上游** | — | — | — | — | **宿主侧已经在 rc.2 修好了，等不到新东西；浏览器侧至今零改动，等到遥遥无期** |

### 3.1 方案 A 的具体落点（可识别的代码形状，不写死行号）

**幂等指纹**：沿用 Patch 12/13/14 的双指纹法——`PATCH_REV` 从 10 抬到 11（`bun-preload.mjs:320`），另设独立 mark 常量，例如
`const INSPECTOR_BOOTSTRAP_RETRY_MARK = 'bun-preload: bootstrap 有界退避重试'`，
同时用于「产物已是我们写的」的识别（`source.includes(mark)`）与注入注释。多补丁同文件时**不要**用 `hasCurrentRev` 判幂等（Patch 14 的注释已记过这个坑：`bun-preload.mjs:929-931`），照 Patch 14 的 `refreshBridgeFingerprint()` 走。

**补丁 1（F1，fetch 抛错分支）**：锚点是紧跟
`response = await fetch(INSPECTOR_BOOTSTRAP_ROUTE, { signal: this.lifetime.signal })`
之后那个 `catch` 块——即「`} catch (error) {` + 紧跟的 `this.connectionFailed(error);` + `return;`」这三行的连续形状。
唯一性说明：`this.connectionFailed(error);` 在文件里出现两次，另一处在 `replace()` 的 `startInspectorClient` 失败处（`client.js:3523`），其上文是 `try { source = await startInspectorClient(bootstrap);`——所以**必须带 catch 前的那一行 fetch 调用**一起做锚，否则会误伤。

**补丁 2（F2，`!response.ok` 分支）**：锚点是构造 `` new Error(`Inspector bootstrap failed: HTTP ${response.status}`) `` 的那一行及其所在的 `if (!response.ok) { … return; }` 三行形状。该行在文件里唯一。

**补丁 3（插入新方法）**：以 `connectionFailed(error) {` 这一行作为 `ins` 锚点（在它**上方**插入一个 `retryBootstrap(error) { … }` 方法）。`connectionFailed(error) {` 在 `client.js` 里唯一（3501），插在其上方即可保证在 `readBootstrap` 之后、方法体不被打断。

**重试语义建议**：

- 只包 F1/F2，**不要**碰 `connectionFailed()` 本身——它是 F5 的唯一出口，改它会把「transport 构造失败」也拖进重试，制造噪音。
- 上限：≤ 6 次；退避 `250ms → 500ms → 1s → 2s → 4s → 8s`（约 15.75s 收敛），或按 `bootstrap.reconnectBaseMs / reconnectMaxMs` 的量级取，但 bootstrap 在失败时还没解析出来，**只能用常量**。
- 每次重试都要 `await new Promise(r => setTimeout(r, d))`，且检查 `this.lifetime.signal.aborted`（`dispose()` 会 abort，`client.js:3557-3559`）；abort 立即退出，不再 warn。
- **与 `connection/reset` 的交互**：`refresh()` 走 `enqueue()`（`client.js:3506-3513`），是一个串行队列。放进重试后，一次失败的重试会占住队列，`connection/reset` 的那次 `refresh()` 排在后面——这正是想要的顺序（先自愈，reset 只是额外机会）。要防的是「reset 在重试进行中反复叠加」：因为 `refresh()` 是 `enqueue`，天然串行，不会并发放大，无需额外去重。
- **与 dispose/lifetime 的交互**：重试点必须尊重 `lifetime.signal`。`connectionFailed` 里的 `if (this.lifetime.signal.aborted) return;`（3503）已经挡掉 abort 后的日志；重试循环里还要在每次 sleep 前后各查一次，避免 fiber 已卸载还在 timer 里排队。
- **与重复 refresh 的交互**：`replace()` 开头有幂等闸 `if (this.bootstrap?.endpoint === bootstrap.endpoint && …) return`（`client.js:3517`），所以「重试成功后又收到一次 reset」不会重建 source，不会泄漏连接。
- 失败终局：重试耗尽后仍打一条**带次数的** warn（例如 `… after N attempts`），便于现场区分「一次抖动」和「彻底不通」。

**source map 影响**：**无**。`lib/` 下没有 `.map` 文件（alpha.2 与 rc.2 都没有），dsh-client-modules 的 `readSourceMap` 在 ENOENT 时返回 `undefined`，直接走 identity 段。行号平移不影响任何东西。

**落盘可达性**：`dsh-client-modules` 在 compose 时 `readFileSync(clientPath)` 取字节（`lib/index.js:830-838`），`rev` 取 `statSync` 的 mtime/ctime/size 三元组哈希（`artifactRevision`，`lib/index.js:195-202`）。bun-preload 在宿主 `--preload` 阶段写盘，**早于** compose，所以补丁字节就是浏览器拿到的字节；改盘后 rev 变化也不会被旧 URL 卡住。
**落盘可达性**：`dsh-client-modules` 在 compose 时 `readFileSync(clientPath)` 取字节（`lib/index.js:830-841`），`rev` 取 `statSync` 的 mtime/ctime/size 三元组哈希（`artifactRevision`，`lib/index.js:194-200`）。bun-preload 在宿主 `--preload` 阶段写盘，**早于** compose，所以补丁字节就是浏览器拿到的字节；改盘后 rev 变化也不会被旧 URL 卡住。
---

## 4. Q4：验证方案（「诊断阶段不改业务代码」）

### 4.1 单测层：真执行，不做 `toContain`

模板直接抄仓内已有的两个先例：

- `desktop-electrobun/test/inspector-cdp-bridge.test.ts:1-70` —— 真 bun 子进程 + 真 bun-preload + 真物化树 + 探针脚本自带断言 + 全绿打 `PROBE-OK`，测试只断言退出码与哨兵。
- `desktop-electrobun/test/bun-preload.test.ts` —— 假包树 + 真 bun-preload，`probe-ok:` 哨兵模式。

**探针设计（client.js 侧）**：起一个真实 `InspectorClientSession` 等价环境成本太高；更稳的做法是把补丁产出的 `client.js` **当模块加载**，并在 `globalThis` 上装三样东西：

1. 一个可控的 `fetch` 桩：前 N 次按脚本抛错 / 回 404，回第 N+1 次回一个**合法 bootstrap JSON**（`endpoint: "ws://127.0.0.1:65000/ingest"`，`protocol` 合法字符串，十一个数值字段齐全，`reconnectMaxMs >= reconnectBaseMs`——必须过 `parseInspectorClientBootstrap` 的全部校验，否则会走 F4 而不是成功路径）；
2. 一个最小 Cordis client ctx 桩：`effect`、`on`、`provide`、`inject`、`logger`（收集 warn），`inject` 会同步调用传入的 async 回调并把 `dispose` 记下来；
3. `window.__ModuleLoader__.load` 外壳——`client.js` 整个包在 `window.__ModuleLoader__.load({…})` 里，所以探针要自己实现这个 loader，取 `factory(require)` 的返回值再取 `exports.apply`。

断言（三条，缺一不可）：
- 前 N 次失败之后，**在不刷新、不重新 `apply()` 的前提下**最终注册成功：断言 `inject` 被调用过且 `require.async('./client.page.js')` 分支走到了（可以在 ctx 桩里数 `inject` 调用次数与注入回调是否执行）；
- warn 次数等于失败次数（重试期间**每跳都记一条**，或按最终设计断言），且终局不再有 warn；
- 总耗时落在退避预算内（< 20s），且 `fetch` 调用总次数 == N+1（证明没有无限重试）。

必须再补一组**上限用例**：fetch 永远 404，断言 fetch 次数恰好等于上限、最终只有一条带次数的 warn、`apply()` **resolve 而非 reject**（符合现状语义，别顺手改成 reject）。

### 4.2 壳实例上的验收判据

用「让路由前 N 次返回 502/404」做故障注入：

1. 起壳实例（`DSH_HOME` 用一份干净的临时 profile，profile 里显式写入 `@deepseek-ai/dsh-experimental-inspector-profile`，否则 inspector 默认不开——见 Q2 C1）。
2. 注入：在宿主 fetch 路由上包一层（或直接对壳的上游端口做端口级打洞），让 `GET /api/experimental-inspector/bootstrap` 前 3 次返回 502。
3. 量化探针（都可用 curl / WS，无需 GUI）：
   - `curl -s -o /dev/null -w '%{http_code} %{time_total}'` 打路由，记录「502 × 3 → 200」的时间戳序列；
   - 统计 bootstrap 200 时刻与「inspector client 首次注册」时刻的差值，判据 **≤ 20s**；
   - 用 CDP 探针断言 `shortcuts.catalog` 里出现 `id === "inspector.toggle"` 的条目——**这才是「快捷键真的注册了」的判据**，比「面板能打开」更直接；
   - 断言全程**没有发生页面导航**（CDP `Page.frameNavigated` 计数不增加），直接堵住「其实是刷新救回来的」这个假阳性。
4. 反向判据（回归护栏）：不注入时首载成功时间应与今天持平，不因重试引入额外延迟。

### 4.3 CI / 无 GUI 可测性

| 层 | 可测性 | 说明 |
|---|---|---|
| bun-preload 补丁单测 | **完全可测**，`bun run test:client` 之外壳侧 `bun test` 已能跑（假包树 + 真 bun + 真 preload，CI 默认路径） | `test/ptc-control-channel.test.ts:1-8` 已写明「1) 假 PTC 包树 + 真 bun-preload：可复现、无需物化运行时（CI 默认路径）」 |
| client.js 探针（§4.1） | **可测**，不需要 GUI、不需要真实浏览器：`client.js` 是个 UMD-ish bundle，用 Bun 的 `vm`/动态 import 就能跑，桩掉 `fetch` 与 Cordis ctx | 唯一真浏览器依赖是 `ClientRealmSource.claim`（内部用 `MessagePort`/BroadcastChannel），探针里要让 `replace()` 早退或替身化，否则会误报 |
| 真栈 E2E（CDP/快捷键目录） | **CI 不可测**（要 GUI + 物化运行时树），但可作为本地验收；仓内已有同款「树不存在则整组跳过」的先例（`test/inspector-cdp-bridge.test.ts:3-6`） | 保留这条路径，但不要把 CI 绿灯押在它上面 |

---

## 5. Q5：上游状态

### 5.1 已有修复

| 项 | 状态 |
|---|---|
| 宿主侧竞态 | **已修**。commit [`bf1a2bf69`](https://github.com/deepseek-ai/deepseek-harness/commit/bf1a2bf69)（2026-10-14T15:19:38Z）「fix(inspector): serve the Client bootstrap while the Inspector Worker starts」，随 **0.2.1-alpha.4**（2026-10-15）发布。master `packages/experimental/inspector/src/host/plugin.ts:52-66,198-215` 可见 |
| 浏览器侧重试 | **未修**。master `packages/experimental/inspector/src/client/plugin.ts` 与 alpha.2 逐行同构；`lib/client.js` 在 alpha.2→rc.2 六个版本里 md5 恒定 |
| 上游 issue/PR 报告 | **检索不到**。`search/issues?q=repo:deepseek-ai/deepseek-harness inspector bootstrap` 与 `… inspector in:title` 均返回空（该仓库未公开 issue 面或未收录） |

### 5.2 版本时间线与「等上游」的成本

- npm 最新：`0.2.1-rc.2`，发布于 **2026-10-17T08:28:44Z**（就在今天），上一版 rc.1 距今约 5 小时 ⇒ 上游发版非常频繁，但**发版频率不等于这块有人管**。
- 客户端那一侧，六个版本、8 天、零变更。等上游修「无重试」的成本无法量化到天，但从「六个版本零触碰」推断，至少是**没有排进近期计划**。
- 真正的判断依据是：**宿主侧竞态已经不需要等了**（rc.2 就带着修复）。剩下的「无重试」是加固项，不是阻断项。所以「等上游」这个姿态只在「纯客户端侧重试」这一件事上成立，而那件事的成本本来就低（一个 bun-preload 补丁 + 一个探针测试）。

---

## 6. 给 issue #68 的修正与仍然未证实的点

**修正**：

1. 「上游行为、无法修」不成立——宿主侧上游 2026-10-14 就修了，本仓 `builtin-runtime.json` 今天也已声明 rc.2；真正的问题是**仓内物化树还停在 alpha.2**，本地复现一直踩在未修的一侧。
2. 「bootstrap 获取失败无重试」是**放大器**而非**首因**。首因候选是 alpha.2 的注册时序（路由排在 `await startInspector()` 之后），窗口量级与 issue 自述的 ~2.5s 吻合。
3. 定位漏了一条更危险的路径：`ctx.inject` 未 await 导致的面板/快捷键**纯静默**失败（F7），它不产生任何 warn，比 F1/F2 更难查。
4. inspector 是**按需 bundle**，不在默认 profile —— 这解释了为什么这个窗口在默认安装上几乎踩不到，只在「验机/装插件后首载」时出现。

**仍未证实的关键点**：

- 【未证实】#68 那次现场到底是 F2（404）、C3（壳 502）还是 F7——没有当时的浏览器控制台/宿主日志，任何一条都还是候选。
- 【未证实】「刷新无效」是持久失败还是「刷的不是那张页面」；需要现场确认刷新方式与是否伴随页面导航。
- 【未证实】网关 `onConnected` 与 inspector client `apply()` 的先后是否存在真实竞态（会吃掉唯一那次 `connection/reset` 补发）——本笔记只给了竞争关系成立的依据，没有实测时序。
- 【未证实】Bun 宿主下 `startInspector` 的 ~2.5s 具体花在哪（worker 线程创建 / 端口分配 / DevTools 前端 prepare），这会影响是否还有别的等待窗口。

---

## 附：证据索引

**仓内（相对仓库根）**

- `desktop-electrobun/builtin-runtime.json` — 声明 `0.2.1-rc.2`
- `desktop-electrobun/builtin-runtime/node_modules/@deepseek-ai/dsh-experimental-inspector/lib/client.js` — L21 / L3412 / L3454-3465 / L3486-3505 / L3506-3513 / L3515-3559
- `desktop-electrobun/builtin-runtime/node_modules/@deepseek-ai/dsh-experimental-inspector/lib/client.page.js` — L170（`inspector.toggle`）/ L227 / L245
- `desktop-electrobun/builtin-runtime/node_modules/@deepseek-ai/dsh-experimental-inspector/lib/index.js` — L2336 / L2378-2403（alpha.2 的注册时序）
- `desktop-electrobun/runtime/dsh-host.mjs` — `await application` → `collectIndexInjections()` → `HOST-READY` → 1s 轮询 `HOST-INJECTIONS`
- `desktop-electrobun/src/bun/shell-server.ts` — L169 / L341 / L355-378 / L389-402 / `BOOT_LINE`
- `desktop-electrobun/src/bun/coalescing.ts` — L27 `FOLLOWER_WAIT_MS = 10_000`
- `desktop-electrobun/src/bun/runtime.ts:151` — `resolveBuiltinRuntimeDir`
- `desktop-electrobun/src/bun/service.ts` — profile 初始化只放 base + web-app
- `resources/dsh/bun-preload.mjs` — L320 `PATCH_REV = 10`；L736-802 Patch 12；L816-920 Patch 13；L922-1195 Patch 14；L1197-1290 Patch 15；`packageTargets()` / `hasCurrentRev()` / `bumpRev()` / `writePatch()`
- `desktop-electrobun/test/inspector-cdp-bridge.test.ts` — 真执行型测试模板（`PROBE-OK` 哨兵）
- `desktop-electrobun/test/ptc-control-channel.test.ts:1-8` — 假包树 + 真 preload 的 CI 口径

**已安装 app（只读观测）**

- `/Applications/DeepSeek Harness Desktop BUN.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai/dsh-experimental-inspector/lib/index.js` — L2334 / L2391-2402 / L2412 / L2517 / L2533 / L2542-2560（rc.2 的路由先注册 + `bootstrapResponse`）
- 同目录 `lib/client.js` — 与 alpha.2 逐字节相同（md5 `39f4fd68…`）
- `…/@deepseek-ai/dsh-client-modules/lib/index.js` — L170 分块白名单 / L194-200 `artifactRevision` / L813-822 `captureArtifactBaseline` / L830-841 `initialBundleSnapshot`

**上游**

- [`packages/experimental/inspector/src/client/plugin.ts`（master）](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/inspector/src/client/plugin.ts)
- [`packages/experimental/inspector/src/host/plugin.ts`（master）](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/inspector/src/host/plugin.ts)
- [`bf1a2bf69` fix(inspector): serve the Client bootstrap while the Inspector Worker starts](https://github.com/deepseek-ai/deepseek-harness/commit/bf1a2bf69)
- npm [`@deepseek-ai/dsh-experimental-inspector`](https://www.npmjs.com/package/@deepseek-ai/dsh-experimental-inspector) 版本与发布时间线（`npm view … versions time --json`）
