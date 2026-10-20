// 页面桥：官方 apps/desktop/src/preload-app.ts 的 `dshDesktopBoot` 等价物。
//
// 契约（官方与我们的 dist 都已内置同一段胶水）：
//   - 壳在 index.html 的 <head> 后插一行 `globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()`
//   - 该 promise 的 resolve 由这里暴露的 `dshDesktopBoot.ready()` 的结果喂给页面
//   - 页面拿到 { injections, streamBaseUrl } 后调用上游自带的 applyIndexInjections 逐行应用，
//     并设 `__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }`
//
// 载荷来源：壳自己（进程内）持有宿主上报的 rows，经官方命令 `get_boot_payload` 取回
// （宿主未就绪时该命令 reject，与旧 `/__shell__/boot` 端点的 503「页面会等」同语义）。
// #128：boot / 标题栏带 / 外链 / 右键菜单 / 输入确认五段注入脚本全部收敛到官方 Typed RPC，
// 接收面是本文件最早期装上的全局唯一分发器。

import { carrierScript, type CarrierPlatform } from './windows/carrier.ts'
import { acceptShimScript } from './windows/accept-shim.ts'
import { contextMenuScript } from './windows/context-menu.ts'
import { externalLinksScript } from './windows/external.ts'
import { titlebarScript } from './windows/titlebar.ts'
import { SHELL_RPC_CORE_SOURCE } from '../../../shared/rpc/core.ts'
/** boot 的 HTTP 端点（壳侧路由保留，见 shell-server.ts）；#128 起注入脚本改走 `get_boot_payload` 命令。 */
export const BOOT_ENDPOINT = '/__shell__/boot'


/** 官方 RPC 分发器的全局名（全仓唯一：preload 最早期装，插件侧 shell-rpc.ts 复用同一个）。 */
export const SHELL_RPC_GLOBAL = '__DSH_SHELL_RPC__'

/**
 * 官方 Electrobun Typed RPC 的**单一接收面**（#128）。
 *
 * 为什么装在 preload 而不是页面侧：preload 与页面在同一个 JS realm（`__DSH_SHELL_VIEW_TOKEN__`
 * 与 `dshDesktopBoot` 都是 preload 写、页面读），而接收面 `window.__electrobun.receiveMessageFromHost`
 * 是**同 realm 单槽**——两个 caller 各装一次就会互相顶掉。所以解法是「一个安装者 + 一个 id 空间」：
 * preload 装它，本文件下面四段注入脚本与页面里的桌面插件（shell-rpc.ts）全部共用它。
 *
 * 三条硬约束：
 *   - 保留并继续调用框架自己那个 handler（它把早到的包 push 进 `__electrobunPendingHostMessages`，
 *     吞掉会丢包）；本仓页面没有 Electroview 来排空那个数组，所以取完立刻清空，避免无界增长。
 *   - 绝**不重试**：协议没有取消，超时后壳侧 handler 仍会跑到底，toggle 类命令重试会翻两次。
 *   - 默认 15s 超时，`noTimeout` 可关（长任务靠状态快照收尾，不靠客户端超时砍它）。
 */
export function shellRpcDispatcherScript(): string {
  // 协议实现统一来自 shared/rpc/core.ts（#185）：这里只剩环境胶水——桥探测、
  // 接收面包装（保框架 handler）与全局安装。默认 15s 超时/noTimeout/不重试都在 core 里。
  return [
    ';(() => {',
    '  if (globalThis.__DSH_SHELL_RPC__) return',
    '  const createRpcCore = (' + SHELL_RPC_CORE_SOURCE + ')',
    '  const core = createRpcCore({',
    '    post: (message) => {',
    '      const bridge = globalThis.__electrobunHostBridge',
    '      const send = bridge && typeof bridge.postMessage === "function" ? bridge.postMessage.bind(bridge) : null',
    '      if (send === null) throw new Error("official bridge unavailable")',
    '      send(message)',
    '    },',
    '  })',
    '  var wrapper = null',
    '  // 框架把早到的包 push 进 __electrobunPendingHostMessages；本仓页面没有 Electroview 来排空',
    '  // 那个数组，所以取完立刻清空——继续调框架 handler 却不排空就是无界增长。',
    '  const flush = () => {',
    '    const queued = globalThis.__electrobunPendingHostMessages',
    '    if (!Array.isArray(queued) || queued.length === 0) return',
    '    globalThis.__electrobunPendingHostMessages = []',
    '    for (const packet of queued) core.receive(packet)',
    '  }',
    '  // 幂等：已经是本 wrapper 就直接返回（重入不会套娃）；框架 preload 若在我们之后又覆盖了',
    '  // 这个槽，下一次 attach 会把当下那个重新包进去。',
    '  const attach = () => {',
    '    const eb = globalThis.__electrobun',
    '    if (!eb) return false',
    '    if (eb.receiveMessageFromHost === wrapper) return true',
    '    const prev = typeof eb.receiveMessageFromHost === "function" ? eb.receiveMessageFromHost : null',
    '    wrapper = function (packet) {',
    '      if (prev !== null) { try { prev(packet) } catch (error) {} }',
    '      flush()',
    '      core.receive(packet)',
    '    }',
    '    eb.receiveMessageFromHost = wrapper',
    '    flush()',
    '    return true',
    '  }',
    '  const invoke = (method, params, options) => {',
    '    const bridge = globalThis.__electrobunHostBridge',
    '    if (!bridge || typeof bridge.postMessage !== "function") return Promise.reject(new Error("official bridge unavailable"))',
    '    if (!attach()) return Promise.reject(new Error("official receive unavailable"))',
    '    return core.invoke(method, params, options)',
    '  }',
    '  globalThis.__DSH_SHELL_RPC__ = {',
    '    invoke,',
    '    // request：永远返回 Promise（桥缺失时 reject，绝不抛同步异常）——注入脚本统一走它',
    '    request: (method, params, options) => invoke(method, params, options),',
    '  }',
    '  // 框架 preload 与壳 preload 的先后顺序在两个平台上都不保证：先装一次，装不上就在下一轮',
    '  // 宏任务再试一次；invoke 里还会再兜一次。',
    '  attach()',
    '  setTimeout(attach, 0)',
    '})()',
  ].join('\n')
}
export function bootPreloadScript(locale: string, platform: CarrierPlatform, selfOrigin: string, viewToken: string): string {
  const carrier: CarrierPlatform = platform
  return [
    // 分发器必须排在整段最前：下面四段注入脚本与页面里的桌面插件共用它，接收面是同 realm 单槽。
    shellRpcDispatcherScript(),
    // 系统语言：旧壳（WKWebView）天然跟随系统，CEF 下默认 en-US，页面语言就跟着错了。
    // 这里把壳探到的系统 locale 摆在 navigator 上，页面按它选语言。
    'try {',
    `  const primary = ${JSON.stringify(locale)}`,
    `  const candidates = ${JSON.stringify([...new Set([locale, locale.split('-')[0] ?? locale, 'en-US', 'en'])])}`,
    "  Object.defineProperty(navigator, 'language', { get: () => primary })",
    "  Object.defineProperty(navigator, 'languages', { get: () => candidates })",
    '} catch {}',
    'globalThis.dshDesktopBoot = {',
    // #128：boot 载荷走官方命令。壳未就绪时 `get_boot_payload` reject，与旧端点的 503 同语义，
    // 前端 failed(error).catch(...) 链路不变。
    '  ready: () => (globalThis.__DSH_SHELL_RPC__ ?? {}).request?.("get_boot_payload", {}) ?? Promise.reject(new Error("shell rpc unavailable")),',
    // #101：boot 失败必须 (a) 返回 Promise——前端失败链路是 failed(error).catch(...)，
    // 旧实现返回 undefined，.catch 直接抛 TypeError（事故日志里的 unhandled rejection：
    // Cannot read properties of undefined (reading 'catch')）；(b) 给出可见可操作的失败浮层
    // （标题 + 错误摘要 + 刷新重试 + 重启提示），不再让用户面对无声的永久 loading。
    // 刷新重试是安全的：`get_boot_payload` 命令在壳侧修好后就会返回新载荷（#101 同票），重载即落在新图上；
    // 不做自动重载，避免坏插件场景下无限循环。id 去重防重复弹层。
    '  failed: (error) => {',
    '    try { console.error("desktop boot failed", error) } catch {}',
    '    try {',
    '      const detail = String((error && (error.stack || error.message)) || error)',
    "      if (!document.getElementById('dsh-boot-failed-overlay')) {",
    "        const el = document.createElement('div')",
    "        el.id = 'dsh-boot-failed-overlay'",
    '        el.setAttribute("style", [',
    '          "position:fixed", "inset:0", "z-index:2147483647",',
    '          "display:flex", "align-items:center", "justify-content:center",',
    '          "background:rgba(12,12,14,0.92)", "color:#e8e8ea",',
    '          "font:14px/1.6 -apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Microsoft YaHei\',sans-serif",',
    '        ].join(";"))',
    '        const box = document.createElement("div")',
    '        box.setAttribute("style", "max-width:640px;max-height:70vh;overflow:auto;padding:28px 32px;border-radius:12px;background:#1c1c1f;border:1px solid #333;box-shadow:0 12px 40px rgba(0,0,0,0.5)")',
    '        const title = document.createElement("div")',
    '        title.textContent = "页面启动失败"',
    '        title.setAttribute("style", "font-size:17px;font-weight:600;margin-bottom:10px")',
    '        const desc = document.createElement("div")',
    '        desc.textContent = "桌面壳的页面没有启动起来（常见于插件更新后模块图变更，刷新或重启可恢复）。错误摘要："',
    '        desc.setAttribute("style", "opacity:0.85;margin-bottom:12px")',
    '        const pre = document.createElement("pre")',
    '        pre.textContent = detail.split("\\n").slice(0, 8).join("\\n")',
    '        pre.setAttribute("style", "white-space:pre-wrap;word-break:break-all;background:#111114;border:1px solid #2a2a2e;border-radius:8px;padding:10px 12px;font-size:12px;max-height:180px;overflow:auto;margin:0 0 16px")',
    '        const row = document.createElement("div")',
    '        row.setAttribute("style", "display:flex;gap:10px;align-items:center")',
    '        const retry = document.createElement("button")',
    '        retry.textContent = "刷新重试"',
    '        retry.setAttribute("style", "padding:7px 18px;border-radius:8px;border:0;background:#4c7dff;color:#fff;font-size:14px;cursor:pointer")',
    '        retry.onclick = () => location.reload()',
    '        const hint = document.createElement("span")',
    '        hint.textContent = "反复失败请重启 dsh 桌面壳"',
    '        hint.setAttribute("style", "opacity:0.6;font-size:12px")',
    '        row.append(retry, hint)',
    '        box.append(title, desc, pre, row)',
    '        el.append(box)',
    "        (document.body || document.documentElement).append(el)",
    '      }',
    '    } catch {}',
    '    return Promise.resolve()',
    '  },',
    '}',
    // 载体标记：dsh 前端只在 globalThis.dshDesktop 存在时才装浏览器 guest 桥（旧壳同款）
    carrierScript(carrier),
    // 标题栏带（win/linux，#112）：官方 data-windows-titlebar 声明式适配 + 壳层拖拽带与三键，
    // 不依赖 dsh 页面插件状态；darwin 系统红绿灯，不注入。
    ...(platform === 'darwin' ? [] : [titlebarScript(platform)]),
    // 外链（会话里的链接、侧边栏浏览器「在系统浏览器打开」）不把壳自己的窗口带走：
    // 上游契约是 window.open，CEF 下没人接，这里改发壳端点 → Utils.openExternal。
    externalLinksScript(selfOrigin),
    // 右键菜单：CEF 不弹菜单，页面把上下文报给主进程，由它弹原生菜单。
    contextMenuScript(),
    // 视图 token 暴露给页面脚本（#50）：remote lane（mobile-access 中继）还要用。
    // 页面侧的壳 RPC 兜底已于 #128 收敛到官方通道；Profile 操作弹窗也已改走原生桥（#129），
    // 两者都不再依赖它。
    `globalThis.__DSH_SHELL_VIEW_TOKEN__ = ${JSON.stringify(viewToken)}`,
    // 文件选择对话框 accept 归一化（#58）：win 原生层把 MIME token 当扩展名拼 pattern，
    // 这里在页面侧把 accept 改写成扩展名形式（win32 追加 *.* 补 All files），浏览器零影响。
    acceptShimScript(platform),
  ].join('\n')
}
