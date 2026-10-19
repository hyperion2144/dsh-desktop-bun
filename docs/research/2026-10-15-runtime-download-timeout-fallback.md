# 运行时下载：超时、进度条状态机与回退 note 的源码调查

- 日期：2026-10-15
- 仓库：`dsh-desktop-bun`（Electrobun/Bun 桌面壳），只读调查，无代码改动
- 基线：`main` @ `74888b3`（= PR #81 的 squash 合入，原提交 `58f1deb`）
- 触发：#79 关闭后用户复测运行时下载（`0.2.1-alpha.3` 构建，macOS）报出 4 个新症状
- 调查范围：`desktop-electrobun/src/bun/{runtime-install,runtime,runtime-store,service,commands,rpc-bridge}.ts`、`desktop-electrobun/src/shared/runtime-catalog.ts`、`desktop-plugin/src/client/{shell-rpc.ts,desktop-settings.tsx}`

---

## 0. 结论速览

| # | 症状 | 机制落点 | 对 #81 的判定 |
|---|---|---|---|
| 1 | 报「超时」但下载继续进行并最终完成 | 客户端 RPC 单请求 15s 超时（`shell-rpc.ts:28,143-147`），面板 `download_runtime` 调用点不传 `timeoutMs`（`desktop-settings.tsx:1040`），超时只删本地 pending、不通知壳 | **完全未覆盖** |
| 2 | 超时弹窗后进度条卡住，不成功也不失败 | `{failed}` 会被 600ms 轮询的 `active` 分支覆写回 `'downloading'`（`desktop-settings.tsx:1082-1084`）；且终态处理全部挂在 `active → false` 上，而 `active` 只在 `installRuntime` settle 时翻转（`runtime-install.ts:341/347`） | **理论覆盖（终态归一）但实现有缺口** |
| 3 | 刷新后按钮可切换 + 进度条残留 | 按钮依据 `installed`（磁盘扫描，`isRuntimeTreeValid` 在 pnpm linking 阶段即为真，`runtime-store.ts:104-108`）；进度条依据 `active`（`runtime-install.ts:328/341/347`）。两者不是同一个终态，且 `active` 为真时刷新也会在 600ms 内被写回 | **完全未覆盖** |
| 4 | 「当前使用 .2」与「已回退 .1」同屏 | `note` 来自布局期解析（真实回退到 `.1`，`runtime.ts:189-193`）；「当前使用」来自设置里的偏好（`service.ts:707` → `commands.ts:298` → `desktop-settings.tsx:1583-1585`）。内置树从不参与候选比较（`runtime-catalog.ts:198-207` 的 `builtin` 是死参数，`runtime.ts:185` 不传） | **红字文案是 #81 新增（已覆盖）；同屏矛盾是 #81 未覆盖的缺口** |

---

## Q1 超时机制：哪里超时、阈值多少、超时后做了什么

下载链路上有 **三级超时**，只有前两级会产出用户可见的「超时」错误，且都不等价于「下载被取消」。

### 1.1 客户端 RPC 单请求超时：15s（用户实际撞到的那一级）

- 阈值定义：`desktop-plugin/src/client/shell-rpc.ts:28`
  ```ts
  const DEFAULT_TIMEOUT_MS = 15_000
  ```
  注释（`shell-rpc.ts:27`）写明「官方 createRPC 的默认值是 1000ms，对文件选择器太紧」——即 15s 是**为其他命令放宽后的全局默认**，从未针对「下载运行时」这类分钟级命令再放宽。
- 生效点：`desktop-plugin/src/client/shell-rpc.ts:143-147`
  ```ts
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeoutImpl(() => {
    pending.delete(id)
    reject(new Error('RPC request timed out.'))
  }, timeoutMs)
  ```
  超时后**只做两件事**：从本地 `pending` 表删掉请求、reject 面板侧的 Promise。**没有任何取消报文发给壳**（该分支没有 `post(...)`），所以壳侧安装照跑。
- 调用点没有传 `timeoutMs`：`desktop-plugin/src/client/desktop-settings.tsx:1038-1040`
  ```ts
  const handleDownloadRuntime = (version: string): void => {
    setRuntimeDownloading((prev) => ({ ...prev, [version]: 'downloading' }))
    void invoke('download_runtime', { source: runtimeSource, version })
  ```
  而 `invoke` 是壳 RPC 的薄封装，不带 options：`desktop-settings.tsx:29-30`
  ```ts
  function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    return shellRpc.invoke<T>(cmd, args)
  }
  ```
  对照：同仓其他长命令是显式放宽的（`desktop-plugin/src/client/local-chrome.ts:…` 传 `{ timeoutMs: 5000 }`、`shell-rpc.ts:…` 的 `sendWindowAction` 传 `30_000`），说明「下载不传超时」是**漏配**而非设计。
- 用户可见文案：面板 catch 分支把 `String(err)` 当原因展示（`desktop-settings.tsx:1059-1062`），因此会看到
  `dsh <版本> 下载失败：Error: RPC request timed out.`（toast + 行内红字）。
- **为什么"下载仍在进行并最终完成"**：壳侧 `download_runtime` 处理器 await 的是同一个安装 Promise（`commands.ts:318` → `commands.ts:315`/`commands.ts` 的 `deps.downloadRuntime` → `service.ts:1016` 的 `download: (version, source) => downloader.start(...)`）。RPC 客户端放弃读取回包不会取消这个 Promise；安装继续跑到底并把树写进 `appSupport/runtimes/<version>`。

### 1.2 壳侧官方 RPC 单请求上限：120s

- `desktop-electrobun/src/bun/rpc-bridge.ts:22-23`
  ```ts
  /** 壳的官方 RPC 单请求超时（官方默认 1000ms 对文件选择器/重启宿主太紧）。 */
  export const SHELL_RPC_MAX_REQUEST_TIME = 120_000
  ```
- 挂载点：`rpc-bridge.ts:151` `maxRequestTime: SHELL_RPC_MAX_REQUEST_TIME`（`BrowserView.defineRPC`）。
- 这一级只是壳侧放弃回包；它**既不杀子进程也不改下载状态**。客户端 15s 先到，所以用户看不到 120s 这一级。

### 1.3 壳侧安装看门狗：900s（唯一会杀进程的一级）

- 阈值：`desktop-electrobun/src/bun/runtime-install.ts:18`
  ```ts
  export const INSTALL_TIMEOUT_MS = 15 * 60_000
  ```
- 计时与到期动作：`runtime-install.ts:262-269`
  ```ts
  const timeoutMs = input.timeoutMs ?? INSTALL_TIMEOUT_MS
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill?.()
    } catch {}
  }, timeoutMs)
  ```
  - 只 kill **直接子进程**（`bun <pnpm.cjs> add ...`，spawn 于 `runtime-install.ts:248`）；不杀树。仓内为此专门有进程树模块（`desktop-electrobun/src/bun/process-tree.ts`，#60），但那条通道只用于宿主停止，**没有用在 pnpm 安装上**。
  - `input.timeoutMs` 没有被 service 传入（`service.ts:271-280` 的 `installRuntime({...})` 只给 appSupport/version/bunPath/pnpmCjs/nodeShimDir/env/onProgress/onLog），所以实际阈值恒为 900s。
- 到期后的终态：`runtime-install.ts:284-288`
  ```ts
  const code = await proc.exited
  if (timedOut) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`dsh ${input.version} 安装超时（${Math.round(timeoutMs / 1000)}s）`)
  }
  ```
}
  - 即：**删掉半成品树 + 抛 `dsh X 安装超时（900s）`**。该错误经 `createRuntimeDownloader` 的 catch 写进 `status.error`（`runtime-install.ts:345-347`），面板显示 `下载失败：dsh X 安装超时（900s）`。

### 1.4 判定：用户遇到的是 1.1，不是 1.3

- 1.3 到期会 `rmSync` 掉运行时目录并让 `record` 永不执行（`runtime-install.ts:338` 在成功分支），与「下载最终完成、按钮变成可切换」**不可共存**（除非 rmSync 同时失败）。
- 1.1 的 15s 对任何真实运行时下载都必然触发（pnpm 装一棵 dsh 树远超 15s），与「报超时 → 下载继续 → 最终装成」逐条吻合。
- 另一处容易被误认成"超时"的是版本目录抓取：`runtime-store.ts:175` `setTimeout(() => { controller.abort() }, input.timeoutMs ?? 12_000)`（12s，调用点 `service.ts:1014`/`1190` 不传）。但它的失败文案是 `目录拉取失败：<message>`（`desktop-settings.tsx:765-766`），与下载进度条无关。
- 结论一句话：**壳里确实有 15 分钟安装看门狗，但用户看到的 15s "超时"来自客户端 RPC 层；该层超时不影响下载，因为它是纯客户端记账。**

---

## Q2 进度条状态机

### 2.1 数据来源（唯一事实源是壳侧单飞状态对象）

```
desktop-settings.tsx:1070  setInterval(..., 600)
  └─ invoke('runtime_download_status')            desktop-settings.tsx:1071-1078
       └─ commands.ts:314-315  runtime_download_status: () => deps.downloadStatus?.() ?? {...}
            └─ service.ts:1015 / 1188  downloadStatus: () => downloader.status()
                 └─ runtime-install.ts:330  status: () => ({ ...status })
                      （status 就地更新的三个点：328 初值、336 进度回调、341/347 两个终态）
```

- 壳侧状态结构：`runtime-install.ts:305-313`（`active/version/resolved/downloaded/added/error`）。
- 面板侧状态：`desktop-settings.tsx:491`（`runtimeDownloading`，值为 `'downloading' | 'downloaded' | {failed}`）与 `desktop-settings.tsx:576`（`dlProgress`，进度数字，仅内存）。
- 进度条元素只在 `downloadState === 'downloading'` 时渲染：`desktop-settings.tsx:1651`（取 `downloadState`）与 `desktop-settings.tsx:1714`（`{downloadState === 'downloading' && (`）。
- 百分比由 `dlProgress` 算：`desktop-settings.tsx:1653-1656`
  ```ts
  const pct =
    dlProgress && dlProgress.version === c.version && dlProgress.resolved > 0
      ? Math.min(100, Math.round((dlProgress.downloaded / dlProgress.resolved) * 100))
      : 0
  ```
  ⇒ `dlProgress` 为 null 时条元素仍在（宽 0%），文案走 `'准备中…'`。

### 2.2 轮询的三条分支（`desktop-settings.tsx:1067-1120`）

| 分支 | 行 | 行为 |
|---|---|---|
| `s.active === true` | `1080-1086` | `sawActive = true`；把该版本状态**写回 `'downloading'`**（`1082-1084` 的三元：只有当前已经是 `'downloading'` 才跳过）；写 `dlProgress` |
| `!active && !sawActive` | `1088-1102` | `setDlProgress(null)`；仅当 `s.version !== '' && s.error !== ''` 才写 `{failed}`（#79 新增） |
| `!active && sawActive` | `1103-1117` | `setDlProgress(null)`；`ok = !s.error`；成功则 `delete`，失败则写 `{failed}`；随后 `void refreshRuntimes()`（`1111`）+ toast（`1113`） |

### 2.3 超时错误路径把状态写成了什么

- 15s RPC 超时 → `handleDownloadRuntime` 的 `.catch`：`desktop-settings.tsx:1046-1062`，最终
  ```ts
  setRuntimeDownloading((prev) => ({ ...prev, [version]: { failed: reason || '未知错误' } }))   // :1060
  ```
  并弹失败 toast（`:1062`）。
- **但下一拍就被覆写**：只要壳侧 `active` 仍为 true（真实安装还在跑），`desktop-settings.tsx:1082-1084` 会把 `{failed}` 换回 `'downloading'`。⇒ 失败红字在 600ms 内消失，进度条继续（或停在原处）——**这正是症状 2「不反馈成功，也不变成失败信息」的代码解释**。
- 之后下载真正成功时，正常路径应走 `1103-1111`（`ok → delete` + `refreshRuntimes` + 「下载完成」toast）。它**只要求 `s.active` 变成 false**——也就是要求 `installRuntime` 的 Promise settle。

### 2.4 为什么"按钮可切换 + 进度条还在"

两个终态来自两个互不相关的判据：

- **按钮**：「切换到此版本」由 `installed` 决定（`desktop-settings.tsx:1636-1640` 的 `available = installed || isBuiltin || isRunning`），而 `installed` = `listInstalledRuntimes`（`service.ts:710` → `runtime-store.ts:104-108`）= manifest 校验后 ∪ **磁盘扫描**。磁盘扫描的判据是 `isRuntimeTreeValid`（`runtime-store.ts:53-55`，只查 `node_modules/@deepseek-ai/dsh/lib/bin.js` 是否存在）。
- **进度条**：只由 `active` 决定；`active` 只在 `runtime-install.ts:341`（成功）或 `:347`（失败）翻转，两者都在 `deps.install` settle **之后**。

⇒ pnpm 进入 linking 阶段（`bin.js` 已落盘）到进程真正退出之间，**"按钮可切换 + 进度条还在"是代码允许的合法状态**。若用户观察到的"残留"持续时间较长，则说明 `installRuntime` 的 Promise 没有 settle，此时 `active` 永远为 true：

- 该 Promise 的等待点是 `runtime-install.ts:271-283` 的两条管道读尽 (`pump`，定义 `:198-206`，`for await` 直到流结束) **然后** `:284` `await proc.exited`；顺序上先等管道 EOF。
- 管道 EOF 需要**所有**写端关闭。安装期间 pnpm 会跑依赖的构建/lifecycle 脚本（本文件头注释 `runtime-install.ts:12` 提到 allowBuilds 白名单，即确有构建脚本），这些子进程继承同一对 stdout/stderr 写端；壳在超时分支只 kill 直接子进程（`:264-269`），不杀树（`process-tree.ts` 未接入该路径）。任一并存的子进程即可让 `pump` 永不返回，而磁盘上的树已完整。
- 判别方法（无需改码）：看壳日志里有没有 `运行时安装完成：dsh X（来源 Y）`（`runtime-install.ts:342` 的 `deps.log`）。**没有这一行 ⇒ Promise 没 settle，属本节这一类。**

### 2.5 刷新（重开面板 / 刷新版本目录）后进度数据从哪来

- 面板自身不持久化进度：`runtimeDownloading`（`:491`）与 `dlProgress`（`:576`）都是组件内 `useState`，弹窗/组件卸载即丢。
- 挂载恢复：`desktop-settings.tsx:621-627`
  ```ts
  useEffect(() => {
    void invoke<{ active: boolean; version: string }>('runtime_download_status')
      .then((s) => { if (s.active && s.version) { setRuntimeDownloading(prev => ({ ...prev, [s.version]: 'downloading' })) } })
  ```
  ⇒ 只要壳侧 `active` 仍为 true，**重开面板就会立刻把进度条画回来**；此效果不参与 `sawActive`，所以随后主轮询即使一直没看到 `active`，`!sawActive` 分支也只在 `error !== ''` 时写失败（`1089-1102`），**成功终态什么都不写 ⇒ `'downloading'` 永远留着**。
- 手动刷新：`refreshRuntimes`（`:758-772`）会 `setRuntimeDownloading({})`（`:768`）并重取 `list_runtime_catalog`（`:761`）；但只要 `active` 为 true，下一拍（≤600ms）又被 `:1082-1084` 写回 `'downloading'`，同时 `installed` 已含该版本 ⇒ **按钮变可切换、进度条照旧**。

---

## Q3 回退 note 逻辑

### 3.1 精确生成路径

```
runtime.ts:175 resolveRuntimeSelection
  ├─ 186-187  已装列表 = input.installed ?? scanInstalledVersions(appSupport)
  ├─ 185      picked = selectRuntimeVersion({ installed, preferred })   ← 注意：不传 builtin
  ├─ 188      requested = input.preferred ?? null
  ├─ 189-190  fallbackNote(fallback) = requested 非空
  │             ? `偏好版本 dsh ${requested} 未在已装目录中找到（可能未装成或已卸载），已回退${fallback}`
  │             : null
  ├─ 191-194  picked 有效（有可用的已装树）→ kind='installed'，note = picked !== requested
  │             ? fallbackNote(`已装的最高版本 dsh ${picked}`) : null
  └─ 195-199  否则若有 builtinDir → kind='builtin'，note = fallbackNote('随包内置运行时')
```

- 候选顺序与"内置是否参与比较"：`shared/runtime-catalog.ts:198-207`
  ```ts
  export function selectRuntimeVersion(input: {
    installed: readonly string[]
    preferred?: string | null
    builtin?: string | null        // :201 —— 声明了但函数体从不读它
  }): string | null {
    const installed = input.installed.filter(isRuntimeVersion)
    const preferred = input.preferred ?? null
    if (preferred !== null && preferred !== '' && installed.includes(preferred)) return preferred   // :205
    const sorted = sortRuntimeVersionsDesc(installed)
    return sorted[0] ?? null       // :207
  }
  ```
  **内置版本完全不参与候选比较**：`builtin` 是死参数（全仓无调用方传它，唯一调用点是 `runtime.ts:185`，形参处 `runtime.ts:201` 供布局层传入，`:260` 只用于 `builtinDir`）。内置树只在 `picked === null`（一个有效已装树都没有）时作为最后兜底被选中（`runtime.ts:195-198`）。
- 两种 note 的触发条件：输出「已回退**已装的最高版本** dsh X」的条件是 `picked !== null`（即至少有一个有效已装树），与"内置是否存在/是否更新"无关；「已回退**随包内置运行时**」只在没有任何有效已装树时才可能出现。
- note 的消费链：`runtime.ts:280`（写进 `ShellLayout.runtimeNote`）→ `service.ts:238-241`（记日志 + `pendingRuntimeNote` 补发系统通知）→ `service.ts:709`（`RuntimeSnapshot.note = paths.runtimeNote`）→ `commands.ts:299`（`list_runtime_catalog` 回包 `note`）→ `desktop-settings.tsx:1593-1594`（红字 `⚠ …`）。
- 刷新时机：`paths` 在服务启动时算一次（`service.ts:228-232`），之后只在 `restartHost` 里就地重算（`service.ts:1068-1082`，含 `preferred: liveSettings.dshRuntime`）。面板「切换到此版本」会 `nsSave` 后调 `restart_dsh_service`（`desktop-settings.tsx:1122-1133`），所以 note 在那条路径上会更新；单纯"装完了"不会更新 note（`runtimeSnapshot()` 每次都重算 `builtinVersion`/`installed`，但 `note` 复用启动期值）。

### 3.2 「偏好 = 内置 = 0.2.1-alpha.2、已装仅 0.2.1-alpha.1」场景的逐行推演

| 量 | 值 | 出处 |
|---|---|---|
| `installed` | `['0.2.1-alpha.1']` | `runtime-store.ts:104-108`（磁盘扫描 + 树有效性） |
| `selectRuntimeVersion` | `'0.2.1-alpha.1'`（`.2` 不在 installed → 取最高已装） | `runtime-catalog.ts:205,207` |
| 选中结果 | `kind='installed'`、`version='0.2.1-alpha.1'` | `runtime.ts:191-193` |
| note | `偏好版本 dsh 0.2.1-alpha.2 未在已装目录中找到（可能未装成或已卸载），已回退已装的最高版本 dsh 0.2.1-alpha.1` | `runtime.ts:189-193` |
| 面板「当前使用」 | `当前使用：运行时 0.2.1-alpha.2（内置兜底 0.2.1-alpha.2）` | `desktop-settings.tsx:1583-1585`，其中 `selected = liveSettings.dshRuntime`（`service.ts:707` → `commands.ts:298`）、`builtin = snapshot.builtinVersion`（`service.ts:703` → `commands.ts:297`） |

- **同屏矛盾是代码真实行为**：面板那行「当前使用」用的是**设置里的偏好值**，完全不参考实际生效的 `activeKind/activeVersion`（`runtimeSnapshot()` 明明算好了，面板只在 `selected` 为 null 的降级分支才用它，`desktop-settings.tsx:1587-1590`）。
- **红字本身没说错**：壳此刻确实跑在 `.2` 吗？不是——`resolveRuntimeSelection` 返回的是已装的 `.1`（`runtime.ts:191-193`），内置 `.2` 被跳过。所以「已回退 .1」是事实，「当前使用 .2」是幻觉；报告人问的"为什么回退到 .1 而不是内置 .2"的答案是：**内置树从来不是候选，只有"没有任何已装树"时才会被兜底选中**。
- 副作用：当内置版本比最高已装版本新（本场景 `.2 > .1`）时，壳会**放着更新的内置树不用**，跑更旧的已装树，同时弹一条看起来自相矛盾的告警。

---

## Q4 覆盖判定（对照 `main` @ `74888b3`）

- 提交范围（`git show 74888b3 --stat`）：`CHANGELOG.md`、`desktop-electrobun/src/bun/{commands,index,runtime-install,runtime-store,runtime,service}.ts`、`desktop-electrobun/src/shared/proxy-env.ts`、4 个测试文件、`desktop-plugin/src/client/desktop-settings.tsx`（+23/-3）。
- **`desktop-plugin/src/client/shell-rpc.ts` 不在其中**，#81 对面板侧只改了「轮询终态恢复」与「note 展示」两处（diff 位置 `desktop-settings.tsx:1086-1110` 与 `:1590-1593`）。
- CHANGELOG 的 #79 条目：`CHANGELOG.md:38`（`## Unreleased` 段起于 `CHANGELOG.md:5`），六项修复的措辞与代码一致，**全文未提任何超时**。
- `main` 顶端即 `74888b3`，其后无跟进提交。

### 逐条判定

**症状 1「报超时但下载继续并最终完成」→ 完全未覆盖。**
依据：`shell-rpc.ts:28` 的 15s 默认超时今天仍在；`desktop-settings.tsx:1040` 仍不传 `timeoutMs`；`shell-rpc.ts:144-147` 的超时分支仍只删 pending、不发取消；#81 未触碰这三处。

**症状 2「超时弹窗后进度条卡住，不成功也不失败」→ #81 理论覆盖、实现有缺口。**
理论覆盖的部分：失败终态不再被 `delete` 洗成无状态（`desktop-settings.tsx:1106-1108`）、面板没开也能恢复失败（`1089-1102`）、成功终态把 `downloaded` 对齐 `resolved`（`runtime-install.ts:341`，对应测试 `desktop-electrobun/test/runtime-install.test.ts` 的「最后一条进度停在中间（如 538/625）也归一到 100%」，538/625≈86% 正是 #79 原报告的定格值）。
缺口有三处：
1. `1082-1084` 仍是「`active` 为真就写回 `'downloading'`」，与 `1060` 的 `{failed}` 直接对冲——**失败仍会被洗掉**（#81 的 CHANGELOG 只说"观察期失败不再被 delete 洗掉"，没说这条覆写）。
2. 全部终态处理都要求 `s.active` 变成 false；`active` 只在 `installRuntime` settle 后翻转（`runtime-install.ts:341/347`），而 settle 依赖 `pump` 的管道 EOF（`:271-283`）与进程退出（`:284`）。没有"树已有效即算完成"的旁路，也没有超时兜底状态机。
3. `#81` 的①（终态数字归一）只作用于 `active===false` 的那一拍，而进度条在那一拍就被 `delete` 移除，对"进度条停在 86% 不走"这一**可见现象**没有帮助——86% 是 pnpm 在 linking 阶段不再打 `Progress` 行导致的（`runtime-install.test.ts` 内注释已写明，`runtime-install.ts:236-237` 的 `--reporter=default` 注释同源）。

**症状 3「刷新后按钮可切换 + 进度条残留」→ #81 完全未覆盖（且 #81 的②让这个组合更容易出现）。**
依据：按钮依据 `installed`（含**磁盘扫描补漏**，`runtime-store.ts:108` + `mergeInstalled`；#81 的②只过滤 manifest 里的陈旧条目，磁盘扫描口径未变，`git show 74888b3 -- desktop-electrobun/src/bun/runtime-store.ts`），而 `isRuntimeTreeValid` 判据是"`bin.js` 存在"（`runtime-store.ts:53-55`），在 pnpm 退出前就为真；进度条依据 `active`（`runtime-install.ts:328/341/347`）。两者不是同一终态。#81 新加的「`!sawActive` 恢复失败终态」分支（`desktop-settings.tsx:1089-1102`）在**成功**场景下不做任何清理（`error === ''` ⇒ 不写状态、不 `delete`），恰好留下残留；`refreshRuntimes` 的 `setRuntimeDownloading({})`（`:768`）也会被下一拍 `1082-1084` 写回。

**症状 4「回退告警自相矛盾」→ 红字文案是 #81 新增（这部分已覆盖并如实工作）；同屏矛盾是 #81 未覆盖的缺口。**
依据：note 由 #81 引入（`git show 74888b3 -- desktop-electrobun/src/bun/runtime.ts`：旧代码两处终态都是 `note: null`），文案与 `runtime.ts:189-193` 逐字一致，描述的是真实回退（`.1`）。矛盾来自另外两件事，都不在 #81 范围：
1. 面板「当前使用」行用设置里的偏好冒充运行事实（`desktop-settings.tsx:1583-1585`），#81 未动这一行；
2. 内置树不参与候选比较（`runtime-catalog.ts:198-207` 的 `builtin` 死参数 + `runtime.ts:185` 不传），所以"偏好=内置"时回退到更旧的已装版本；这行代码自 `33bb830`（迁入 Electrobun 壳）起就是这样，#81 只给它加了文案。

### 建议的修复切入点（供后续开票，非本次改动）

1. `desktop-settings.tsx:1040` 给 `download_runtime` 显式放宽 `timeoutMs`（或让 `invoke` 支持 options），并把「请求超时 ≠ 任务失败」在 UI 上区分开——这是症状 1 的最小修复点。
2. 进度条终态不应只依赖 `active`：面板在 `active===true` 但 `installed` 已含该版本时，应显示「已装好，等待收尾」而不是停在旧百分比；壳侧 `installRuntime` 应加"树已有效 + 进程已退"的兜底收尾，或在超时分支改用进程树停止（`process-tree.ts`）而不是 `proc.kill()`。
3. `selectRuntimeVersion` 应真正使用 `builtin` 参与比较（或 `resolveRuntimeSelection` 把内置版本并入候选集），并让面板「当前使用」以 `activeKind/activeVersion` 为准，避免 note 与实际选中项各说各话。

---

## 附录：引用清单（均已逐行核对）

| 文件 | 行 | 内容 |
|---|---|---|
| `desktop-plugin/src/client/shell-rpc.ts` | 27-28 | 15s 默认单请求超时的注释与常量 |
| 同上 | 143-147 | 超时分支：删 pending + reject，不发取消 |
| `desktop-plugin/src/client/desktop-settings.tsx` | 29-30 | `invoke` 不传 options |
| 同上 | 491 / 576 | `runtimeDownloading` / `dlProgress` 两个内存态 |
| 同上 | 621-627 | 挂载即按 `active` 恢复 `'downloading'` |
| 同上 | 758-772 | `refreshRuntimes`（761 取目录、768 清运行时下载态、772 依赖 `[runtimeSource]`） |
| 同上 | 1038-1063 | 下载点击 → 15s 超时落 `{failed}` |
| 同上 | 1067-1120 | 600ms 轮询三条分支（1082-1084 写回、1089-1102 恢复失败、1103-1117 终态） |
| 同上 | 1583-1594 | 「当前使用」= `selected`（设置偏好）+ `builtin`；1593-1594 note 红字 |
| 同上 | 1651-1656 / 1714 / 1744 | 进度条取值、渲染门、失败行 |
| `desktop-electrobun/src/bun/runtime-install.ts` | 18 | `INSTALL_TIMEOUT_MS = 15 * 60_000` |
| 同上 | 198-206 | `pump`：`for await` 到流结束 |
| 同上 | 248 / 262-269 | spawn pnpm；看门狗只 `proc.kill?.()` |
| 同上 | 271-284 | 先等两条管道 EOF，再等 `proc.exited` |
| 同上 | 285-288 | 超时 → `rmSync` + `安装超时（900s）` |
| 同上 | 297-300 | `isRuntimeTreeValid` 才是成功判据 |
| 同上 | 327-330 / 336 / 341 / 347 | 下载器单飞状态：初值、进度、成功/失败终态 |
| `desktop-electrobun/src/bun/runtime.ts` | 175-199 | 回退 note 全部分支 |
| 同上 | 255-260 / 280 | layout 传入 `builtinDir`；`runtimeNote` 落进 ShellLayout |
| `desktop-electrobun/src/shared/runtime-catalog.ts` | 198-207 | `selectRuntimeVersion`：`builtin` 死参数、候选只看 installed |
| `desktop-electrobun/src/bun/runtime-store.ts` | 53-55 | `isRuntimeTreeValid` = `bin.js` 存在 |
| 同上 | 104-108 | `listInstalledRuntimes` = manifest（验树）+ 磁盘扫描 |
| 同上 | 175 | 目录抓取 12s abort |
| `desktop-electrobun/src/bun/service.ts` | 228-241 | 启动期 layout 与 note 落日志/通知 |
| 同上 | 259-280 | 下载器装配、`installRuntime` 调用（不传 timeoutMs） |
| 同上 | 700-711 | `runtimeSnapshot()`：`selected` 取 live 设置、`note` 取启动期 `paths` |
| 同上 | 1068-1082 | `restartHost` 重算 layout（note 的唯一刷新点） |
| `desktop-electrobun/src/bun/commands.ts` | 290-305 | `list_runtime_catalog` 回包（builtin/selected/note/installed/running） |
| 同上 | 314-318 | `runtime_download_status` / `download_runtime` |
| `desktop-electrobun/src/bun/rpc-bridge.ts` | 22-23 / 151 | 壳侧 120s RPC 上限 |
| `CHANGELOG.md` | 5 / 38 | Unreleased 段与 #79 条目 |
