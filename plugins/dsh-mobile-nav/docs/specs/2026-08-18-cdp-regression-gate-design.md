# dsh-mobile-nav CDP 回归门禁设计

日期：2026-08-18 · 状态：已批准（运行边界与断言矩阵经用户确认）

## 问题

`scripts/cdp-probe.mjs` 当前是一次性分支胶囊取证脚本，不是回归门禁：

- Chromium 路径、session id、服务地址和鼠标坐标写死；
- 依赖长固定 sleep，无法区分启动慢、前置缺失和真实回归；
- 只打印观测值，没有可判定断言；
- 找不到目标 chip 时打印 `chip not found` 并以状态码 0 退出；
- 提前 `process.exit()`，WebSocket、Chromium 和临时 user-data-dir 没有统一清理。

2026-08-18 基线实测再次得到 `chip not found`，进程耗时约 60 秒后仍返回 0。该脚本不能保护已经发布的 v1.0.0。

## 目标

把现有脚本改成连接真实 DSH Web 组合的、零新增依赖的确定性 smoke gate：

1. 核心移动端行为、宽度切换和桌面 no-op 有明确断言；
2. 可选第三方集成缺失必须显示为 `SKIP`，需要时可提升为强校验；
3. 任一必测失败、页面异常或超时返回非零；
4. 每次使用全新 Chromium profile，并在所有结束路径清理资源；
5. 不改变任何生产 client 行为、DSH manifest、slot、service 或生成产物。

## 非目标

- 不创建或修改用户 profile，不自动安装插件，不启动 `dsh web`；
- 不引入 Playwright、Puppeteer、jsdom 或测试运行器；
- 不做截图像素 diff；
- 不在本轮自动驱动文件预览、设置表单、会话行三点菜单等需要额外第三方数据的深层路径；
- 不修改 `src/client/` 或手工编辑 `lib/`。

## 运行边界与输入

新增 package script：

```json
"smoke:cdp": "node scripts/cdp-probe.mjs"
```

脚本连接一个已经启动、装有当前 checkout/link 版本插件的 DSH Web 实例。输入均来自环境变量：

| 变量 | 默认值 | 语义 |
|---|---|---|
| `DSH_PROBE_URL` | `http://127.0.0.1:3080/` | 目标 Web URL |
| `DSH_PROBE_SESSION_ID` | 无 | 必填；首次导航前写入 `dsh.sessions.current` |
| `DSH_PROBE_CHROME` | `chromium` | Chromium 可执行文件；由 PATH 解析，不写本机绝对路径 |
| `DSH_PROBE_TIMEOUT_MS` | `30000` | 每个确定性等待的统一上限 |
| `DSH_PROBE_REQUIRE_CHIP` | `0` | 为 `1` 时，gitgraph 分支胶囊缺失即失败 |

缺少 session id、超时值非法、`DSH_PROBE_REQUIRE_CHIP` 不是 `0`/`1`，或 Chromium 无法启动时，脚本在浏览器交互前给出具体错误并失败。session id 不写回仓库，也不打印到结果日志。

## 单文件结构

继续保留 `scripts/cdp-probe.mjs` 单文件，不建立测试框架或通用 CDP 库。文件内部只提取本脚本复用的小函数：

- 配置读取与校验；
- CDP request/response 路由；
- `evaluate()`、有截止时间的 `waitFor()`；
- 按元素实时矩形发送真实 mouse/key input；
- `PASS` / `SKIP` / `FAIL` 结果收集；
- viewport 切换与可见性查询；
- 统一 teardown。

Chromium 使用 `~/.cache` 下由 `mkdtemp()` 创建的独立 user-data-dir。脚本通过 `Page.addScriptToEvaluateOnNewDocument` 在首次目标导航前注入 current-session localStorage；session id 必须先用 `JSON.stringify()` 安全序列化，不能直接拼进 JavaScript 源码。这避免“先加载空态再 reload”的竞态和特殊字符破坏表达式。

开启 `Runtime` 和 `Log` 域，收集未处理异常、`console.error` 与 error 级日志。WebSocket 关闭或报错时立即 reject 全部 pending CDP request，不能留下等待到 timeout 的悬空 promise。正常断言完成后再统一判定；不能在中途 `process.exit()` 逃过清理。

## 断言矩阵

### 窄屏核心：390×844

1. **插件启动**
   - `style[data-plugin="@dsh-external/dsh-mobile-nav"]` 恰好一个；
   - `[data-mobile-nav="frame"]` 出现；
   - 启动过程中没有未处理页面异常或 error 日志。
2. **抽屉开合**
   - 优先使用可见的 `[data-mobile-nav="toggle"]`，无 active session header 时允许回退到 `[data-mobile-nav="fab"]`；
   - 按元素当前矩形中心发送真实 mouse input；
   - 打开后 backdrop 可见，drawer 矩形宽高均大于 0；
   - 根据 drawer 右边界和 viewport 动态计算未遮挡 backdrop 点击点，点击后 drawer 关闭；
   - 再次打开，发送真实 Escape keydown/keyup，确认 drawer 关闭。
3. **宽度往返**
   - 同一页面切到 1280×800，等待 matchMedia effect 完成清理；
   - 再切回 390×844，确认 frame marker 与一个可见的移动端打开控件重新出现。

### 桌面 no-op：1280×800

- `[data-mobile-nav="frame"]` 不存在；
- `data-mobile-preview-full` 不残留；
- toggle / FAB 均不可见（节点可以不存在，或计算样式为 `display:none`）；
- 宽度切换过程中不产生页面异常。

### 可选 gitgraph 集成

检测到 `[data-gitgraph-chip-anchor] [data-gitgraph-chip]` 时，无论 strict flag 是否开启都执行：

- chip 的父级是 textarea 所在 composer card；
- 依据 chip 实际矩形发送 mouse press，按住期间 `:active` 成立且有非 identity transform；
- release 后 `[data-gitgraph-popover]` 出现，包含至少一个 option，且完整位于 viewport 内。

chip 不存在时：

- 默认记录 `SKIP`，不把未执行的集成伪装成 `PASS`；
- `DSH_PROBE_REQUIRE_CHIP=1` 时记录 `FAIL` 并最终返回 1。

## 结果与退出语义

每项结果打印稳定名称、状态和最小关键值，例如：

```text
PASS core.plugin-style count=1
PASS mobile.drawer.escape collapsed=true
SKIP integration.gitgraph reason=chip-not-present
SUMMARY pass=8 skip=1 fail=0
```

退出规则：

- 所有必测通过，只有允许的 `SKIP`：状态码 0；
- 任一 `FAIL`、等待超时、CDP protocol error、页面异常、要求的可选集成缺失：状态码 1。

`main()` 不直接调用 `process.exit()`；错误写入结果集或抛到统一边界，最后设置 `process.exitCode`。`SIGINT` / `SIGTERM` 通过同一 abort/teardown 路径收束。`finally` 依次关闭 WebSocket、reject 残留 request、终止并等待 Chromium、删除本任务创建的 user-data-dir。

## 文件范围

- Modify: `scripts/cdp-probe.mjs`
- Modify: `package.json`（增加 `smoke:cdp`）
- Modify: `README.md`（记录前置条件、环境变量和核心/可选覆盖面）
- Intentionally unchanged: `src/client/**`, `lib/**`, `pnpm-lock.yaml`, `cordis.patch.yml`

## 验证

1. `pnpm verify`：host/client 类型基线保持通过；
2. `pnpm build`：构建通过，`lib/` 内容不因探针改变；
3. 对已启动的现有 Web profile 运行：

   ```sh
   DSH_PROBE_SESSION_ID=<existing-session-id> pnpm smoke:cdp
   ```

   核心矩阵必须通过；无 chip 时明确 `SKIP`。
4. 同一无-chip 前置下运行 `DSH_PROBE_REQUIRE_CHIP=1`，必须给出 `FAIL` 并返回 1；
5. 在含 gitgraph chip 的兼容 profile/session 中启用 strict flag，chip reparent、pressed feedback 和 popover 几何必须通过；
6. 故意传入无效 URL、session 空值和不可执行 Chromium 路径，分别确认快速非零失败和可判定错误；
7. 每次运行后确认 Chromium 子进程与 `dsh-mobile-nav-probe-*` profile 目录均已清理；
8. `git diff --check` 通过，工作区既有 `AGENTS.md` 用户改动不被覆盖或提交。

## 成功标准

- `pnpm smoke:cdp` 能保护 core drawer、breakpoint re-arm、desktop no-op；
- 现有“chip 缺失但状态码 0”的 soft-success 不再可能；
- 所有点击来自运行时元素矩形，无固定屏幕坐标；
- 所有等待有同一明确 deadline，无长固定 sleep；
- 可选集成的 `SKIP` 与强校验 `FAIL` 语义明确；
- 失败路径同样清理浏览器、WebSocket 和临时 profile；
- 生产 client、bundle 和 DSH 配置保持逐项不变。
