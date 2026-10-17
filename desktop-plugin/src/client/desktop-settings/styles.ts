// 面板的全部视觉 token 与那段一次性注入的 CSS。
//
// 过去 PANEL_CSS、ensureStyles 与二十来个 *_STYLE 常量全都摆在 2300 行的入口文件头部，
// 每个卡片模块要拿样式就得 import 入口——而入口 import 卡片，卡片又 import 入口。
// 拆到这里后依赖是单向的：卡片 → styles → （无）。
import type { CSSProperties } from 'react'
import { devToolsConfirmCopy, devToolsDisableCopy } from '../devtools-toggle.ts'

// ── 样式：PANEL_CSS 装一份挂在 [data-desktop-settings] 下的类名样式（按钮/输入框/标签/小字注等复用样式）；
//    其他局部样式直接用 JSX style 对象，视觉与原 cssText 等价。
export const PANEL_CSS = `
[data-desktop-settings] .pf-btn { background:var(--dsw-alias-brand-primary-new-color,#4176e6); border:none; color:#fff; border-radius:8px; padding:6px 13px; font-size:12px; cursor:pointer; transition:filter .12s, transform .06s; }
[data-desktop-settings] .pf-btn:hover { filter:brightness(1.12); }
[data-desktop-settings] .pf-btn:active { transform:translateY(1px); }
[data-desktop-settings] .pf-btn.ghost { background:transparent; border:1px solid var(--dsw-alias-border-l2,#ffffff1f); color:var(--dsw-alias-label-primary,#e7eaf0); }
[data-desktop-settings] .pf-btn.ghost:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); filter:none; }
[data-desktop-settings] .pf-btn.ghost:active { background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.12)); transform:translateY(1px); filter:none; }
[data-desktop-settings] .pf-btn.danger { background:transparent; border:1px solid var(--dsw-alias-state-danger-primary,#e5534b); color:var(--dsw-alias-state-danger-primary,#e5534b); }
[data-desktop-settings] .pf-btn.danger:hover { background:rgba(229,83,75,.12); filter:none; }
[data-desktop-settings] .pf-btn:disabled { opacity:.5; cursor:not-allowed; }
[data-desktop-settings] input, [data-desktop-settings] select { padding:6px 8px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2,#ffffff1f); background:var(--dsw-alias-bg-base,#151517); color:inherit; font-size:12px; }
[data-desktop-settings] .pf-label { font-size:11px; color:var(--dsw-alias-label-secondary,#9aa4b2); margin-bottom:4px; }
[data-desktop-settings] .pf-input { width:100%; box-sizing:border-box; }
[data-desktop-settings] .pf-title { font-weight:600; font-size:13px; margin-bottom:10px; }
[data-desktop-settings] .pf-row { display:flex; gap:8px; align-items:center; }
[data-desktop-settings] .pf-note { font-size:11px; color:var(--dsw-alias-label-secondary,#9aa4b2); margin-top:8px; word-break:break-all; }
`

let stylesInstalled = false

/** 幂等注入面板那段一次性 CSS（面板可能反复挂载，别重复插）。 */
export function ensureStyles(): void {
  if (stylesInstalled) return
  stylesInstalled = true
  const style = document.createElement('style')
  style.dataset.desktopSettings = 'styles'
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
}

// JSX 用样式对象（与 PANEL_CSS 视觉一致）。
export const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  maxWidth: 680,
  fontSize: 13,
}
export const SECTION_STYLE: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2,#ffffff1f)',
  borderRadius: 12,
  padding: '14px 16px',
}
export const TITLE_STYLE: CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  marginBottom: 10,
}
export const LABEL_STYLE: CSSProperties = {
  fontSize: 11,
  color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
  marginBottom: 4,
}
export const NOTE_STYLE: CSSProperties = {
  fontSize: 11,
  color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
  marginTop: 8,
  wordBreak: 'break-all',
}
export const INPUT_BASE_STYLE: CSSProperties = {
  padding: '6px 8px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2,#ffffff1f)',
  background: 'var(--dsw-alias-bg-base,#151517)',
  color: 'inherit',
  fontSize: 12,
}
export const INPUT_FULL_STYLE: CSSProperties = { ...INPUT_BASE_STYLE, width: '100%', boxSizing: 'border-box' }
export const ROW_STYLE: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center' }
// #128 loopback 数据面聚合：三档单选的一行（竖排：radio + 档位名 + 一句解释）。
// 排布沿用面板里 checkbox 标签的 flex 写法，只是竖着排、允许换行——不新造第二套卡片样式。
export const RADIO_ROW_STYLE: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0', cursor: 'pointer' }
export const RADIO_TEXT_STYLE: CSSProperties = { fontSize: 12.5, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary,#e7eaf0)' }
export const FLEX_1_STYLE: CSSProperties = { flex: 1 }
// #69 开发者工具确认弹窗：遮罩/卡片/文字 token 与 local-chrome.ts 退出确认弹窗同款（--dsw-alias-* 带回退）
export const DEV_TOOLS_OVERLAY_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 2147483000,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}
export const DEV_TOOLS_MODAL_STYLE: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-1,#1e1e1e)',
  border: '1px solid var(--dsw-alias-border-l2,#444)',
  borderRadius: 12,
  padding: '18px 20px',
  minWidth: 320,
  maxWidth: '80vw',
  boxShadow: '0 12px 40px rgba(0,0,0,.4)',
  color: 'var(--dsw-alias-label-primary,#eee)',
}
export const DEV_TOOLS_TITLE_STYLE: CSSProperties = { fontSize: 14, fontWeight: 600, marginBottom: 10 }
export const DEV_TOOLS_BODY_STYLE: CSSProperties = { fontSize: 12.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary,#bbb)' }
export const DEV_TOOLS_ACTIONS_STYLE: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }
// #69 确认弹窗文案纯静态：模块级算一次
export const DEV_TOOLS_CONFIRM = devToolsConfirmCopy()
export const DEV_TOOLS_DISABLE = devToolsDisableCopy()

export const BTN_PRIMARY_STYLE: CSSProperties = {
  background: 'var(--dsw-alias-brand-primary-new-color,#4176e6)',
  border: 'none',
  color: '#fff',
  borderRadius: 8,
  padding: '6px 13px',
  fontSize: 12,
  cursor: 'pointer',
}
export const BTN_GHOST_STYLE: CSSProperties = {
  ...BTN_PRIMARY_STYLE,
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2,#ffffff1f)',
  color: 'var(--dsw-alias-label-primary,#e7eaf0)',
}
export const BTN_DANGER_STYLE: CSSProperties = {
  ...BTN_PRIMARY_STYLE,
  background: 'transparent',
  border: '1px solid var(--dsw-alias-state-danger-primary,#e5534b)',
  color: 'var(--dsw-alias-state-danger-primary,#e5534b)',
}
export const DANGER_NOTE_STYLE: CSSProperties = {
  ...NOTE_STYLE,
  color: 'var(--dsw-alias-state-danger-primary,#e5534b)',
}
export const WARN_NOTE_STYLE: CSSProperties = {
  ...NOTE_STYLE,
  color: 'var(--dsw-alias-state-warn,#e8a33d)',
}
export const SUCCESS_NOTE_STYLE: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-state-success-primary,#2fbf71)',
}
export const DANGER_MSG_STYLE: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-state-danger-primary,#e5534b)',
}
