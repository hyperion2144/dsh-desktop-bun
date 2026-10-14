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
    '  failed: (error) => { console.error("desktop boot failed", error) },',
    '}',
    // 载体标记：dsh 前端只在 globalThis.dshDesktop 存在时才装浏览器 guest 桥（旧壳同款）
    carrierScript(carrier),
    // 窗口 chrome 与平台标记：由桌面插件 advanced-shell/styles 接管（#23/#44），骨架期 chrome.ts 注入退役。
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
