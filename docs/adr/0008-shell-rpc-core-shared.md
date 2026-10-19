# ADR-0008: 壳 RPC 客户端收进 shared/rpc/core.ts——一处实现，四类页面入口共用

- 状态：Accepted（2026-10-19）
- 关联：issue #185（本票）；前置 ADR-0005（壳↔页面通道，本篇 supersede 其 §3「两份 dispatcher 是故意的重复」）；#190（contracts/ 命令契约，同属根级中性层思路）
- 决策人：维护者（#178 map C5 设计票 #184 拍板「按推荐」）

## 背景

ADR-0005 时代，官方 Typed RPC 的客户端实现有三份：

1. `desktop-electrobun/src/bun/preload.ts` 的 `shellRpcDispatcherScript()`——手写字符串拼的完整实现（id 空间、pending 表、超时、接收面包装）；
2. `desktop-plugin/src/client/shell-rpc.ts` 的自装路径——模块化的第二份实现（同样的协议常量再抄一遍）；
3. 两扇 `html:` 弹窗（`profile-dialog.ts`、`update-notice-dialog.ts`）——各自内联的第三、四份简化实现（无超时、对象当 pending 表）。

§3 曾裁定「两份 dispatcher 是故意的重复」，理由是字符串脚本与模块之间没有可共享的模块边界。但重复的代价持续累积：协议常量要靠人肉清单同步（§3 自己列了权威清单），弹窗那两份更是在 #190 契约化时被发现已经和壳侧语义漂移（错误文案、超时口径各说各话）。

## 决策

新建根级 `shared/rpc/core.ts`（与 `contracts/` 同思路的中性第三层，不 import 壳/插件代码），一个自包含工厂承载全部协议实现：

```ts
createRpcCore({ post, timeoutMs?, maxId?, setTimeout?, clearTimeout? }) → { invoke, receive }
```

语义基线与 #128 归一时的行为一致：默认 15s 超时、`noTimeout` 可关（长任务靠状态快照收尾）、绝不重试、请求 id 从 1 起到 MAX_ID=1e10 溢出归 1、`receive` 对非 response 包与无主 id 静默忽略。

四个消费点全部改走它：

| 入口 | 用法 |
| --- | --- |
| 壳 preload（`preload.ts`） | import 工厂，脚本里只剩环境胶水：桥探测、接收面包装（保框架 handler + 排空积压）、全局安装 `__DSH_SHELL_RPC__` |
| 两扇 html 弹窗 | `SHELL_RPC_CORE_SOURCE = createRpcCore.toString()`（Bun 转译已剥类型，得纯 JS）内联进 `<script>`，各配 5 行 bootstrap；耗时动作显式 `noTimeout` |
| 插件 `shell-rpc.ts` | 壳 preload 分发器在场时整条官方通道委托给它（#128 语义不变）；dev/旧壳缺席时用同一个工厂自装接收面 |

「自包含」是硬约束：工厂函数体不引用任何模块级标识（默认值内联在函数体里），这是 `toString()` 产物可求值的前提。测试双轨锁行为：直接 import 调工厂 + `new Function('return (' + SHELL_RPC_CORE_SOURCE + ')')()` 求值后跑同一组断言，漂移当场红。

## 后果

- 正面：协议常量只剩一处；四入口的超时/不重试/id 口径结构性一致，不再依赖人肉清单；弹窗升级为完整语义（显式 noTimeout 代替「忘了挂超时」）；插件自装路径删掉约 50 行手写协议。
- 代价：`SHELL_RPC_CORE_SOURCE` 依赖 Bun 的「toString 产剥类型纯 JS」行为——换运行时跑壳时这条链路要重新验证（测试已钉）。
- 兼容说明：profile 弹窗回包兜底错误文案由「壳侧执行失败」统一为 core 的「shell rpc failed」（update-notice 弹窗原用文案）；仅影响壳回非字符串 error 的路径，生产上壳侧 handler 恒回字符串错误。
- 风险下限：不改 wire 协议、不改授权面（命令仍经 `isCommandAllowed`），委托/自装的通道优先级与 #128 一致。
