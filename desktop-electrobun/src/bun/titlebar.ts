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
//   - 壳（本文件）：声明式标记 + 高度变量；注入标题栏带的壳原生区。Electrobun
//     的原生拖拽按 DOM 类名动态发现（electrobun-webkit-app-region-drag），host
//     CSS ::before 的 -webkit-app-region 未必被映射——拖拽热区必须由我们自己的
//     元素提供。三键走 /__shell__/window 端点（POST 动作 / GET 最大化态），不依赖
//     dsh 页面与插件状态：页面加载中、插件未激活、实例崩溃时三键仍可见可点。
//   - host CSS（属性驱动，零代码）：.frame padding-top 40px、::before 标题栏底色
//     （sidebar fill）、右栏 panel 与浮动面的顶部间隔全部结构性生效。
//   - darwin：系统红绿灯，不注入（返回空串，调用方跳过）。

import type { CarrierPlatform } from './carrier.ts'
import { VIEW_TOKEN_HEADER } from '../shared/view-grant.ts'

/** 标题栏高度：对齐官方 WINDOWS_TITLEBAR_HEIGHT 常量（#112 Q1 拍板）。 */
export const WINDOWS_TITLEBAR_HEIGHT = 40

/** 标题栏带端点（shell-server.ts 同名路由：POST 动作 / GET 最大化态）。 */
export const TITLEBAR_WINDOW_ENDPOINT = '/__shell__/window'

/** 三键单键宽（46px）：与注入脚本的 button CSS 同值。 */
const CAPTION_BUTTON_WIDTH = 46
/** 三键预留总宽（46 × 3）：拖拽热区让出右缘，不盖按钮。 */
const CAPTION_CONTROLS_WIDTH = CAPTION_BUTTON_WIDTH * 3
/** 官方 leadingSeat（侧栏折叠键+新建会话键）左缘：AppFrame .leadingSeat left:88px（两态同位）。 */
const BAND_SEAT_LEFT = 88
/** 主管拖拽区左缘：让出座位框（约 72px 宽）加余量——座位可点，两侧仍可拖。 */
const BAND_DRAG_MAIN_LEFT = 168

/**
 * 生成标题栏带脚本（纯字符串，随 preload 进页面；darwin 返回空串）。
 * `viewToken` 用于 window 端点的每视图 token 头（external.ts 同款直传）。
 */
export function titlebarScript(platform: CarrierPlatform, viewToken: string): string {
  if (platform === 'darwin') return ''
  return [
    ';(() => {',
    '  if (globalThis.__DSH_SHELL_TITLEBAR__) return',
    '  globalThis.__DSH_SHELL_TITLEBAR__ = true',
    `  const ENDPOINT = ${JSON.stringify(TITLEBAR_WINDOW_ENDPOINT)}`,
    `  const HEIGHT = ${JSON.stringify(WINDOWS_TITLEBAR_HEIGHT)}`,
    `  const CONTROLS_WIDTH = ${JSON.stringify(CAPTION_CONTROLS_WIDTH)}`,
    `  const TOKEN_HEADER = ${JSON.stringify(VIEW_TOKEN_HEADER)}`,
    `  const SEAT_LEFT = ${JSON.stringify(BAND_SEAT_LEFT)}`,
    `  const DRAG_MAIN_LEFT = ${JSON.stringify(BAND_DRAG_MAIN_LEFT)}`,
    `  const VIEW_TOKEN = ${JSON.stringify(viewToken)}`,
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
    '    try {',
    '      void fetch(ENDPOINT, {',
    '        method: "POST",',
    '        headers: { "content-type": "application/json", [TOKEN_HEADER]: VIEW_TOKEN },',
    '        body: JSON.stringify({ action }),',
    '        keepalive: true,',
    '      }).then((res) => { if (!res.ok) console.warn("[titlebar] window action failed", action, res.status) })',
    '    } catch {}',
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
    '      "#dsh-shell-titlebar-drag{position:absolute;top:0;bottom:0;left:0;width:" + SEAT_LEFT + "px;pointer-events:auto}",',
    '      "#dsh-shell-titlebar-drag-main{position:absolute;top:0;bottom:0;left:" + DRAG_MAIN_LEFT + "px;right:" + CONTROLS_WIDTH + "px;pointer-events:auto}",',
    '      "#dsh-shell-titlebar-controls{position:absolute;top:0;right:0;bottom:0;display:flex;align-items:stretch}",',
    '      "#dsh-shell-titlebar-controls button{width:46px;border:none;margin:0;padding:0;background:transparent;color:var(--dsw-alias-label-primary,currentColor);display:grid;place-items:center;cursor:default;pointer-events:auto}",',
    '      "#dsh-shell-titlebar-controls button:hover{background:rgba(128,128,128,0.18)}",',
    '      \'#dsh-shell-titlebar-controls button[data-action="close"]:hover{background:#e81123;color:#fff}\',',
    '      "#dsh-shell-titlebar-controls button svg{width:12px;height:12px;display:block}",',
    '    ].join("\\n")',
    '    document.head.appendChild(style)',
    '    const band = document.createElement("div")',
    '    band.id = "dsh-shell-titlebar"',
    '    // Electrobun 原生拖拽按类名发现（host CSS 的 -webkit-app-region 未必被映射）；',
    '    // 官方 leadingSeat（折叠键+新建会话键）定位在同一带内（left:88px，官方靠 no-drag 让位，',
    '    // Electron app-regions 是几何而非层叠）——类名拖拽无 no-drag 洞，拆两段 drag 绕开座位框。',
    '    const dragLead = document.createElement("div")',
    '    dragLead.id = "dsh-shell-titlebar-drag"',
    '    dragLead.className = "electrobun-webkit-app-region-drag"',
    '    const dragMain = document.createElement("div")',
    '    dragMain.id = "dsh-shell-titlebar-drag-main"',
    '    dragMain.className = "electrobun-webkit-app-region-drag"',
    '    const onDbl = () => post("toggle-maximize")',
    '    dragLead.addEventListener("dblclick", onDbl)',
    '    dragMain.addEventListener("dblclick", onDbl)',
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
    '    band.append(dragLead, dragMain, controls)',
    '    document.body.appendChild(band)',
    '    // 最大化/还原图标：GET 状态查询（window_state_changed 推送属官方 RPC 通道，壳层带走 HTTP 不接，',
    '    // resize/focus/可见性兜底与插件时代同一套）',
    '    queryState = () => {',
    '      try {',
    '        void fetch(ENDPOINT, { headers: { [TOKEN_HEADER]: VIEW_TOKEN }, cache: "no-store" })',
    '          .then((res) => (res.ok ? res.json() : null))',
    '          .then((state) => { if (state !== null && typeof state.maximized === "boolean") setIcon(state.maximized) })',
    '          .catch(() => {})',
    '      } catch {}',
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
