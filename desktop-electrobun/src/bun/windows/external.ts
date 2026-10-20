// 「在系统浏览器打开」：页面里的外链不该把壳自己的窗口带走。
//
// 上游 dsh 的契约就一条：**外部打开 = `window.open(url, "_blank", "noopener,noreferrer")`**
// （`dsh-client-ui-chat` 的 `openExternalLink`：设成应用内侧边栏就走侧边栏浏览器，否则 window.open；
// `dsh-client-ui-sidebar-browser` 的「在系统浏览器打开」也是同一句）。旧壳（WKWebView + Tauri）
// 靠 `on_new_window` / nav_guard 把它转成系统浏览器；CEF 这边没人接，所以点了没反应。
//
// 这里在页面里补一层拦截，规则：
//   - 只拦外链（http/https/mailto/tel 且 origin ≠ 壳自己的 loopback origin）；
//   - `window.open` 一律改走官方 RPC（open_external）；`target="_blank"` 的锚点同理；
//   - 点击/中键在 **冒泡阶段** 且 `defaultPrevented === false` 时才处理——dsh 自己处理过的链接
//     （会话内的 open-in-app / 侧边栏浏览器）原样放行，不然会把上游行为顶掉；
//   - 同一 origin 的链接不动（应用内导航照旧）。
//
// #128：命令在 commands.ts（open_external），shell 侧最终仍落到 Electrobun 的
// `Utils.openExternal`（主进程 API）；HTTP 端点与常量保留，但注入脚本不再打它。

/** 外链的 HTTP 端点（壳侧路由保留，见 shell-server.ts）；#128 起注入脚本改走官方 RPC 显式方法。 */
export const OPEN_EXTERNAL_ENDPOINT = '/__shell__/open-external'
/** 外链转系统浏览器走的官方 RPC 方法名（commands.ts 的 open_external）。 */
export const OPEN_EXTERNAL_METHOD = 'open_external'


/**
 * 「链接」口径：网页里可点、会走拦截脚本的协议。
 * 注入脚本内联的就是这份清单（externalLinksScript 的 PROTOCOLS），两者必须一致。
 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/**
 * 「命令」口径里额外放行的系统 handler 协议（#128）。
 *
 * 这一层与上面的差别：`open_external` 不只有网页链接会调，壳内 UI 的按钮也会调
 * （例：通知设置卡的「打开系统通知设置」传 `x-apple.systempreferences:com.apple.Preference.Notifications`，
 * 见 desktop-plugin/src/client/notifications-tab.tsx）。拦截脚本管不到按钮，硬套链接口径会把它静默吞掉。
 *
 * 仍然显式枚举而不退化成 denylist：`javascript:` / `data:` / `file:` 这类能换壳执行上下文的
 * 协议必须挡住。新增协议要走 review，别顺手放宽。
 */
const OS_HANDLER_PROTOCOLS = new Set(['x-apple.systempreferences:'])

/** 这个 URL 该不该交给系统浏览器。 */
export function isExternalUrl(raw: string, selfOrigin?: string): boolean {
  let url: URL
  try {
    url = new URL(raw, selfOrigin)
  } catch {
    return false
  }
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return false
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin !== selfOrigin
  return true
}

/**
 * 这个 URL 能不能交给系统的打开器（命令面 `open_external` 的闸）。
 *
 * 比 {@link isExternalUrl} 宽一档：链接口径之外，再放行 {@link OS_HANDLER_PROTOCOLS}——
 * 壳内按钮要唤起系统设置面板，那些协议不会出现在网页链接里，但同属「安全地交给 OS」。
 *
 * 故意保持窄口：这不是「什么都给系统打开器」，而是「链接 + 已知系统 handler」，
 * 多一档就少一层审。
 */
export function isOpenableUrl(raw: string, selfOrigin?: string): boolean {
  if (isExternalUrl(raw, selfOrigin)) return true
  let url: URL
  try {
    url = new URL(raw, selfOrigin)
  } catch {
    return false
  }
  // 非链接协议没有 origin 概念，交给系统前只剩协议闸；同源检查对它也不适用。
  return OS_HANDLER_PROTOCOLS.has(url.protocol)
}

/**
 * document-start 注入的外链拦截脚本。
 * `selfOrigin` 是壳自己的 loopback origin（同源链接保持应用内行为）。
 * #128：外链改走官方 RPC 显式方法 open_external，不再打 /__shell__/open-external。
 */
export function externalLinksScript(selfOrigin: string): string {
  return [
    ';(() => {',
    `  const OPEN_EXTERNAL_METHOD = ${JSON.stringify(OPEN_EXTERNAL_METHOD)}`,
    // #128：官方 RPC 分发器（preload 最早期装）。永远返回 Promise，桥缺失时 reject 不抛同步异常。
    '  const call = (method, params) => (globalThis.__DSH_SHELL_RPC__ ?? {}).request?.(method, params) ?? Promise.reject(new Error("shell rpc unavailable"))',
    `  const SELF_ORIGIN = ${JSON.stringify(selfOrigin)}`,
    `  const PROTOCOLS = ${JSON.stringify([...EXTERNAL_PROTOCOLS])}`,
    '  const log = (msg) => console.debug("[external] " + msg)',
    '  const isExternal = (raw) => {',
    '    let url',
    '    try { url = new URL(raw, location.href) } catch { return false }',
    '    if (!PROTOCOLS.includes(url.protocol)) return false',
    '    if (url.protocol === "http:" || url.protocol === "https:") return url.origin !== SELF_ORIGIN',
    '    return true',
    '  }',
    '  const openExternal = (raw) => {',
    '    if (!isExternal(raw)) return false',
    '    const url = new URL(raw, location.href).href',
    '    void call(OPEN_EXTERNAL_METHOD, { url }).catch((error) => log("壳拒绝了外链：" + url + " (" + String(error) + ")"))',
    '    log("转系统浏览器：" + url)',
    '    return true',
    '  }',
    '  globalThis.__dshOpenExternal = openExternal',
    // window.open：上游「系统浏览器打开」就是这一句
    '  const nativeOpen = globalThis.open',
    '  globalThis.open = function (url, name, features) {',
    '    if (typeof url === "string" && openExternal(url)) return null',
    '    return nativeOpen.call(globalThis, url, name, features)',
    '  }',
    // 普通点击 / 中键：dsh 已处理过的（defaultPrevented）放行
    '  const CLICK_BUTTONS = [0, 1]',
    '  const onPointer = (event) => {',
    '    if (!CLICK_BUTTONS.includes(event.button)) return',
    '    if (event.defaultPrevented) return',
    '    const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null',
    '    if (!anchor) return',
    '    const href = anchor.getAttribute("href")',
    '    if (!href || href.startsWith("#")) return',
    '    if (!openExternal(href)) return',
    '    event.preventDefault()',
    '    event.stopPropagation()',
    '  }',
    '  document.addEventListener("click", onPointer, false)',
    '  document.addEventListener("auxclick", onPointer, false)',
    '})()',
  ].join('\n')
}
