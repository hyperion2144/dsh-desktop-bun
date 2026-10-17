// Windows/Linux 标题栏带（#112）：官方 data-windows-titlebar 声明式适配 + 壳层三键。
//
// #112 的结构性根因：右栏 panel 间隔原本由桌面插件 JS 补丁提供（给
// [data-sidebar-right-panel] 写内联 top，观察器信号触发时刷新），链接触发的首次
// 挂载落入观察器盲区 → tab 列表区与三键重叠；手动开合只翻 panel 自身属性（未被
// 观察）→ 不自愈。官方桌面的路径是声明式的：壳给 <html> 打 data-windows-titlebar
// 并设 --dsh-windows-titlebar-height，host ui-layout 的 AppFrame CSS 据此整帧
// padding-top 压下标题栏——间隔成为结构性 CSS，与 panel 何时、经哪条路径挂载无关。
// 维护者拍板（#112 Q1/Q2）：高度对齐官方常量 40px；标题栏带（拖拽 + 三键）上收
// 壳 preload 层，插件退役 win32 顶部 chrome。
//
// 分工（官方 Electron preload-windows.ts 的 syncWindowsAppearance 同构）：
//   - 壳（本文件）：声明式标记 + 高度变量 + 三键。三键走官方 RPC 显式方法
//     （window_minimize / window_toggle_maximize / window_close / window_get_state，
//     见 rpc-bridge.ts），不依赖 dsh 页面与插件状态：页面加载中、插件未
//     激活、实例崩溃时三键仍可见可点。
//   - host CSS（属性驱动，零代码）：.frame padding-top 40px、::before 标题栏底色
//     （sidebar fill）、右栏 panel 与浮动面的顶部间隔全部结构性生效。
//   - 拖拽按平台走官方声明（#121）：win32 的 caption 行就是 host 的
//     `[data-windows-titlebar] .frame::before{-webkit-app-region:drag}`——Electrobun 建
//     WebView2 时开了 `ICoreWebView2Settings9::IsNonClientRegionSupportEnabled`，浏览器把该
//     区域当真标题栏处理（拖窗 + 右键系统菜单 + 双击最大化），壳不再注入任何拖拽面。
//     三键必须显式 `-webkit-app-region:no-drag`：base.css 的 no-drag 选择器带
//     `html[data-platform='darwin']` 前缀只护 macOS，而官方在 Electron 侧靠
//     windowControlsOverlay 的原生窗口控件，WebView2 没有这个能力。
//   - linux（CEF）：CEF 无 app-region，官方那条声明又在 ::before 上（Electrobun 的 JS
//     兼容层只读元素自身，读不到伪元素）→ 仍需壳注入拖拽热区（走类名发现）。
//   - darwin：系统红绿灯，不注入（返回空串，调用方跳过）。

import type { CarrierPlatform } from './carrier.ts'
import type { WindowControlAction } from './window-max.ts'

/** 标题栏高度：对齐官方 WINDOWS_TITLEBAR_HEIGHT 常量（#112 Q1 拍板）。 */
export const WINDOWS_TITLEBAR_HEIGHT = 40

/** 标题栏带的 HTTP 端点（壳侧路由保留，见 shell-server.ts）；#128 起注入脚本改走官方 RPC 显式方法。 */
export const TITLEBAR_WINDOW_ENDPOINT = '/__shell__/window'

/**
 * 三键动作 → 官方 RPC 方法名（rpc-bridge.ts 的显式方法表，与命令表共用同一漏斗授权）。
 * 导到 shell 侧改端点时，改这里一处就够。
 *
 * 键集合用 {@link WindowControlAction} 锁死（#128）：之前是 Record<string, string>，
 * 拼错的动作名能过编译，到页面里变成「点了没反应」。现在映射表与 service.ts 的签名、
 * shell-server.ts 的 /__shell__/window 校验共用同一份动作集合。
 */
export const TITLEBAR_WINDOW_METHODS: Readonly<Record<WindowControlAction, string>> = {
  minimize: 'window_minimize',
  'toggle-maximize': 'window_toggle_maximize',
  close: 'window_close',
}

/** 最大化态查询用的官方 RPC 方法名（同上，与三键同一张表）。 */
export const WINDOW_STATE_METHOD = 'window_get_state'

/** 三键单键宽（46px）：与注入脚本的 button CSS 同值。 */
const CAPTION_BUTTON_WIDTH = 46
/** 三键预留总宽（46 × 3）：拖拽热区让出右缘，不盖按钮。 */
const CAPTION_CONTROLS_WIDTH = CAPTION_BUTTON_WIDTH * 3
/** linux（CEF）拖拽段：座位左缘宽度，对齐官方 leadingSeat left:88px（两态同位）。 */
const LINUX_DRAG_SEAT_WIDTH = 88
/** linux（CEF）拖拽段：主管段左缘，让出座位框加余量。 */
const LINUX_DRAG_MAIN_LEFT = 168

/**
 * 生成标题栏带脚本（纯字符串，随 preload 进页面；darwin 返回空串）。
 * #128：三键与最大化态查询改走官方 RPC 显式方法，不再打 /__shell__/window。
 */
export function titlebarScript(platform: CarrierPlatform): string {
  if (platform === 'darwin') return ''
  return [
    ';(() => {',
    '  if (globalThis.__DSH_SHELL_TITLEBAR__) return',
    '  globalThis.__DSH_SHELL_TITLEBAR__ = true',
    `  const WINDOW_METHODS = ${JSON.stringify(TITLEBAR_WINDOW_METHODS)}`,
    `  const STATE_METHOD = ${JSON.stringify(WINDOW_STATE_METHOD)}`,
    // #128：官方 RPC 分发器（preload 最早期装）。永远返回 Promise，桥缺失时 reject 不抛同步异常。
    '  const call = (method, params) => (globalThis.__DSH_SHELL_RPC__ ?? {}).request?.(method, params) ?? Promise.reject(new Error("shell rpc unavailable"))',
    `  const HEIGHT = ${JSON.stringify(WINDOWS_TITLEBAR_HEIGHT)}`,
    `  const CONTROLS_WIDTH = ${JSON.stringify(CAPTION_CONTROLS_WIDTH)}`,
    `  const NATIVE_CAPTION = ${JSON.stringify(platform === 'win32')}`,
    `  const SEAT_WIDTH = ${JSON.stringify(LINUX_DRAG_SEAT_WIDTH)}`,
    `  const DRAG_MAIN_LEFT = ${JSON.stringify(LINUX_DRAG_MAIN_LEFT)}`,
    '  // 官方声明式标记：host AppFrame CSS 的总开关（document-start 时 documentElement 可能未建，重试一次）',
    '  const mark = () => {',
    '    if (!document.documentElement) { setTimeout(mark, 0); return }',
    '    document.documentElement.dataset.windowsTitlebar = ""',
    '    document.documentElement.style.setProperty("--dsh-windows-titlebar-height", HEIGHT + "px")',
    '  }',
    '  mark()',
    '  const ICONS = {',
    '    min: `<path d="M1 6h10" stroke="currentColor" stroke-width="1" fill="none"/>`,',
    '    max: `<rect x="1.5" y="1.5" width="9" height="9" stroke="currentColor" stroke-width="1" fill="none"/>`,',
    '    restore: `<rect x="1.5" y="4.5" width="7" height="6" stroke="currentColor" stroke-width="1" fill="none"/><path d="M3.5 4.5V2.5H10.5V9H8.5" stroke="currentColor" stroke-width="1" fill="none"/>`,',
    '    close: `<path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1"/>`,',
    '  }',
    '  let queryState = () => {}',
    '  const post = (action) => {',
    '    const method = WINDOW_METHODS[action]',
    '    if (method === undefined) return',
    '    void call(method, {}).catch((error) => console.warn("[titlebar] window action failed", action, error))',
    '    if (action === "toggle-maximize") setTimeout(queryState, 150)',
    '  }',
    '  const makeButton = (action, aria, icon) => {',
    '    const button = document.createElement("button")',
    '    button.type = "button"',
    '    button.setAttribute("data-action", action)',
    '    button.setAttribute("aria-label", aria)',
    '    button.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true">${icon}</svg>`',
    '    return button',
    '  }',
    '  const build = () => {',
    '    if (document.getElementById("dsh-shell-titlebar") !== null || document.body === null) return',
    '    const style = document.createElement("style")',
    '    style.textContent = [',
    '      "#dsh-shell-titlebar{position:fixed;top:0;left:0;right:0;height:" + HEIGHT + "px;z-index:45;pointer-events:none;font-size:0}",',
    '      ...(NATIVE_CAPTION ? [] : [',
    '        "#dsh-shell-titlebar-drag{position:absolute;top:0;bottom:0;left:0;width:" + SEAT_WIDTH + "px;pointer-events:auto}",',
    '        "#dsh-shell-titlebar-drag-main{position:absolute;top:0;bottom:0;left:" + DRAG_MAIN_LEFT + "px;right:" + CONTROLS_WIDTH + "px;pointer-events:auto}",',
    '      ]),',
    '      "#dsh-shell-titlebar-controls{position:absolute;top:0;right:0;bottom:0;display:flex;align-items:stretch;-webkit-app-region:no-drag}",',
    '      "#dsh-shell-titlebar-controls button{width:46px;border:none;margin:0;padding:0;background:transparent;color:var(--dsw-alias-label-primary,currentColor);display:grid;place-items:center;cursor:default;pointer-events:auto;-webkit-app-region:no-drag}",',
    '      "#dsh-shell-titlebar-controls button:hover{background:rgba(128,128,128,0.18)}",',
    '      \'#dsh-shell-titlebar-controls button[data-action="close"]:hover{background:#e81123;color:#fff}\',',
    '      "#dsh-shell-titlebar-controls button svg{width:12px;height:12px;display:block}",',
    '    ].join("\\n")',
    '    document.head.appendChild(style)',
    '    const band = document.createElement("div")',
    '    band.id = "dsh-shell-titlebar"',
    '    // linux（CEF）拖拽热区：CEF 无 app-region、官方 caption 行在 ::before 上读不到，',
    '    // 只能由壳提供（Electrobun JS 兼容层按 electrobun-webkit-app-region-drag 类名发现）。',
    '    // win32 交给官方 `.frame::before` 的原生 non-client region，壳不注入拖拽面。',
    '    const dragParts = []',
    '    if (!NATIVE_CAPTION) {',
    '      const onDbl = () => post("toggle-maximize")',
    '      const dragLead = document.createElement("div")',
    '      dragLead.id = "dsh-shell-titlebar-drag"',
    '      dragLead.className = "electrobun-webkit-app-region-drag"',
    '      dragLead.addEventListener("dblclick", onDbl)',
    '      const dragMain = document.createElement("div")',
    '      dragMain.id = "dsh-shell-titlebar-drag-main"',
    '      dragMain.className = "electrobun-webkit-app-region-drag"',
    '      dragMain.addEventListener("dblclick", onDbl)',
    '      dragParts.push(dragLead, dragMain)',
    '    }',
    '    const controls = document.createElement("div")',
    '    controls.id = "dsh-shell-titlebar-controls"',
    '    const maximize = makeButton("toggle-maximize", "最大化", ICONS.max)',
    '    const setIcon = (maximized) => {',
    '      maximize.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true">${maximized ? ICONS.restore : ICONS.max}</svg>`',
    '      maximize.setAttribute("aria-label", maximized ? "还原" : "最大化")',
    '    }',
    '    controls.append(',
    '      makeButton("minimize", "最小化", ICONS.min),',
    '      maximize,',
    '      makeButton("close", "关闭", ICONS.close),',
    '    )',
    '    controls.addEventListener("click", (event) => {',
    '      const button = event.target && event.target.closest ? event.target.closest("button") : null',
    '      if (button === null) return',
    '      const action = button.getAttribute("data-action")',
    '      if (action !== null) post(action)',
    '    })',
    '    band.append(...dragParts, controls)',
    '    document.body.appendChild(band)',
    // 最大化/还原图标：壳层不订阅状态推送（#144：推送端整条已删），只由页面主动查
    // window_get_state；resize/focus/可见性兜底与插件时代同一套（不再 GET 端点）
    '    queryState = () => {',
    '      void call(STATE_METHOD, {})',
    '        .then((state) => { if (state !== null && state !== undefined && typeof state.maximized === "boolean") setIcon(state.maximized) })',
    '        .catch(() => {})',
    '    }',
    '    queryState()',
    '    let resizeTimer = 0',
    '    window.addEventListener("resize", () => {',
    '      window.clearTimeout(resizeTimer)',
    '      resizeTimer = window.setTimeout(queryState, 200)',
    '    })',
    '    window.addEventListener("focus", () => queryState())',
    '    document.addEventListener("visibilitychange", () => {',
    '      if (document.visibilityState === "visible") queryState()',
    '    })',
    '  }',
    '  if (document.body !== null) build()',
    '  else document.addEventListener("DOMContentLoaded", build, { once: true })',
    '})()',
  ].join('\n')
}
