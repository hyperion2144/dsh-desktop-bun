// 页面桥：官方 apps/desktop/src/preload-app.ts 的 `dshDesktopBoot` 等价物。
//
// 契约（官方与我们的 dist 都已内置同一段胶水）：
//   - 壳在 index.html 的 <head> 后插一行 `globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()`
//   - 该 promise 的 resolve 由这里暴露的 `dshDesktopBoot.ready()` 的结果喂给页面
//   - 页面拿到 { injections, streamBaseUrl } 后调用上游自带的 applyIndexInjections 逐行应用，
//     并设 `__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }`
//
// 载荷来源：壳自己（进程内）持有宿主上报的 rows。骨架期用壳的同源端点
// `/__shell__/boot`（宿主就绪前 503，页面会等）取回。壳↔页面的命令通道已换成
// Electrobun 官方 Typed RPC（#50，rpc-bridge.ts），boot 仍走 HTTP。

import { carrierScript, type CarrierPlatform } from './carrier.ts'
import { acceptShimScript } from './accept-shim.ts'
import { contextMenuScript } from './context-menu.ts'
import { externalLinksScript } from './external.ts'
import { titlebarScript } from './titlebar.ts'
export const BOOT_ENDPOINT = '/__shell__/boot'

import { VIEW_TOKEN_HEADER } from '../shared/view-grant.ts'

export function bootPreloadScript(locale: string, platform: CarrierPlatform, selfOrigin: string, viewToken: string): string {
  const carrier: CarrierPlatform = platform
  return [
    `const viewToken = ${JSON.stringify(viewToken)}`,
    // 视图 token 必须在最外层：下面的 dshDesktopBoot 在 try 块之外，拿不到 try 里的作用域。
    // 系统语言：旧壳（WKWebView）天然跟随系统，CEF 下默认 en-US，页面语言就跟着错了。
    // 这里把壳探到的系统 locale 摆在 navigator 上，页面按它选语言。
    'try {',
    `  const primary = ${JSON.stringify(locale)}`,
    `  const candidates = ${JSON.stringify([...new Set([locale, locale.split('-')[0] ?? locale, 'en-US', 'en'])])}`,
    "  Object.defineProperty(navigator, 'language', { get: () => primary })",
    "  Object.defineProperty(navigator, 'languages', { get: () => candidates })",
    '} catch {}',
    'globalThis.dshDesktopBoot = {',
    `  ready: () => fetch(${JSON.stringify(BOOT_ENDPOINT)}, { cache: 'no-store', headers: { '${VIEW_TOKEN_HEADER}': viewToken } }).then((res) => {`,
    "    if (!res.ok) throw new Error('shell boot pending: ' + res.status)",
    '    return res.json()',
    '  }),',
    // #101：boot 失败必须 (a) 返回 Promise——前端失败链路是 failed(error).catch(...)，
    // 旧实现返回 undefined，.catch 直接抛 TypeError（事故日志里的 unhandled rejection：
    // Cannot read properties of undefined (reading 'catch')）；(b) 给出可见可操作的失败浮层
    // （标题 + 错误摘要 + 刷新重试 + 重启提示），不再让用户面对无声的永久 loading。
    // 刷新重试是安全的：boot 端点在壳侧修好后会返回新载荷（#101 同票），重载即落在新图上；
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
    ...(platform === 'darwin' ? [] : [titlebarScript(platform, viewToken)]),
    // 外链（会话里的链接、侧边栏浏览器「在系统浏览器打开」）不把壳自己的窗口带走：
    // 上游契约是 window.open，CEF 下没人接，这里改发壳端点 → Utils.openExternal。
    externalLinksScript(selfOrigin, viewToken),
    // 右键菜单：CEF 不弹菜单，页面把上下文报给主进程，由它弹原生菜单。
    contextMenuScript(viewToken),
    // 视图 token 暴露给页面脚本（#50）：桌面插件的 HTTP 兑底（/__shell__/rpc、
    // /__shell__/window）要从页面侧带上同一枚 token。token 本就随 preload 进入
    // 页面作用域，这里只是给它一个稳定名字；guest（无 preload）/remote（走
    // mobile-access 中继桥，token 由中继注入）不经这条路。
    `globalThis.__DSH_SHELL_VIEW_TOKEN__ = ${JSON.stringify(viewToken)}`,
    // 文件选择对话框 accept 归一化（#58）：win 原生层把 MIME token 当扩展名拼 pattern，
    // 这里在页面侧把 accept 改写成扩展名形式（win32 追加 *.* 补 All files），浏览器零影响。
    acceptShimScript(platform),
  ].join('\n')
}
