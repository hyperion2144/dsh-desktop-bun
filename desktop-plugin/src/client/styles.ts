/**
 * 高级模式局部 chrome 样式（最小自包含）：
 * - body 标记：识别桌面高级模式；
 * - fixed host：覆盖视口、pointer-events 全关，只有条带子元素局部开；
 * - 自绘 caption 条与窗口按钮。
 */
const ADVANCED_STYLES = `
.dshDesktopChromeHost { position: fixed; inset: 0; z-index: 45; pointer-events: none; }
.dshDesktopChromeStrip { position: absolute; display: flex; align-items: stretch; pointer-events: auto; }
.dshDesktopChromeDrag { user-select: none; }
.dshDesktopStatusBar { position: absolute; display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 11px; line-height: 1; color: var(--dsw-alias-label-secondary, currentColor); border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); pointer-events: auto; user-select: none; }
.dshDesktopStatusDot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
/* 设置弹窗左侧 tab 列可滚动（dsh 上游 navList 无 overflow，tab 多了被截断）：
   用弹窗稳定标记定位，不依赖 hash 类名。 */
[role="dialog"][aria-modal="true"] nav { min-height: 0; overflow: hidden; }
[role="dialog"][aria-modal="true"] nav > div:last-child { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.dshDesktopWindowControls { position: absolute; top: 0; right: 0; height: 100%; display: flex; align-items: stretch; }
.dshDesktopCaptionButton { width: 46px; border: none; margin: 0; padding: 0; background: transparent; color: var(--dsw-alias-label-primary, currentColor); display: grid; place-items: center; cursor: default; }
.dshDesktopCaptionButton:hover { background: rgba(128, 128, 128, 0.18); }
.dshDesktopCaptionButton-close:hover { background: #e81123; color: #fff; }
.dshDesktopCaptionButton svg { width: 12px; height: 12px; display: block; }
/* 侧边栏内容区滚动（local-chrome.ts ensureSidebarScroll 打稳定标记；内联 overflow
   已覆盖 stock 的 hidden，这里只做滚动条观感与滚动链收敛）。 */
[data-dsh-desktop-scroll] { overscroll-behavior: contain; scrollbar-width: thin; }
[data-dsh-desktop-scroll]::-webkit-scrollbar { width: 8px; height: 8px; }
[data-dsh-desktop-scroll]::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2, rgba(128,128,128,0.4)); border-radius: 4px; }
[data-dsh-desktop-scroll]::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2, rgba(128,128,128,0.6)); }
/* 状态条「退出」（#180）：仅运行中悬停/确认态生效，data-* 稳定标记；文案超宽折叠。 */
.dshDesktopStatusText { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshDesktopStatusBar[data-dsh-exit-mode="hover"] { background: rgba(220, 38, 38, 0.16); color: #ef4444; font-weight: 600; }
.dshDesktopExitBtn { padding: 3px 10px; border-radius: 6px; border: 1px solid rgba(239, 68, 68, 0.55); background: transparent; color: inherit; font-size: 11px; line-height: 1; cursor: default; flex: none; }
.dshDesktopExitBtn:hover { filter: brightness(1.1); }
/* 侧栏 header 单行化（#44）：官方 alpha 前端的 darwin 分支把折叠按钮独占一条 52px
   顶带（topStrip），logo 落在下一行；官方 Desktop.app 与旧壳的实际视觉是 logo 与折叠
   按钮同一行、红绿灯浮在其上方独立让位带。data-platform 本身保留（折叠全隐/座位
   按钮依赖它），这里只用 CSS 还原单行几何：topStrip 浮到 logoRow 行高，logoRow 顶回
   红绿灯让位带下方并左移让开红绿灯。选择器按 CSS-modules 词干匹配（hash 前缀随构建
   变化，词干稳定）。 */
html[data-platform='darwin'] [class*='_root']:has(> [class*='_topStrip']) { position: relative; }
html[data-platform='darwin'] [class*='_topStrip'] { position: absolute; top: 32px; left: 0; right: 0; height: 28px; margin: 0; padding: 0 12px 0 0; }
html[data-platform='darwin'] [class*='_topStrip'] + [class*='_logoRow'] { margin-top: 0; padding-top: 28px; padding-left: 64px; }
`

/** Install and remove the advanced shell's local-window-chrome styles. @returns the style disposer. */
export function installAdvancedStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-desktop-tauriapp'
  style.dataset.pluginCss = 'dsh-desktop-tauriapp/local-chrome'
  style.textContent = ADVANCED_STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}
