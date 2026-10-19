// 弹窗自绘标题带（#164）：win32/linux 上给 shell 自绘窗补关闭键与拖拽面。
//
// #164 的根因：所有 shell 自绘窗都用 `titleBarStyle: 'hiddenInset'`（index.ts 的主窗、
// splash、profile 弹窗，update-notice-window.ts 的更新提醒窗）。darwin 上 hiddenInset =
// 透明标题栏 + 系统红绿灯，关闭与拖拽都现成；win32/linux 上 hiddenInset = 纯无边框，
// **什么控件都没有**。壳那套三键标题栏带（titlebar.ts 的 titlebarScript，#112）只随
// preload 注入主页面，而这些弹窗是 html: 文档、根本不挂 preload ⇒ 既无关闭键，窗也拖不动。
//
// 修法口径（维护者拍板）：弹窗自己画一条轻标题带，只画在 win32/linux；mac 一行不改。
// 三点约定：
//   - 带是 `position: absolute` 锚在窗口顶，调用方负责给 body 加 `position: relative`
//     与一条 `.dlg-with-titlebar` 留位规则（三个窗的布局各不相同，留位规则不能共用）。
//   - 关闭键只挂标记不挂行为：行为由各窗自己的页面脚本接到 `closeSelf()`（#162 的
//     profile_close、#160 的 update_notice_close），本模块不引入新的关窗机制。
//   - 带的高度要加到建窗的 frame.height 上（`dialogTitlebarFrameHeight`），否则内容被压。

import type { CarrierPlatform } from './carrier.ts'

/**
 * 标题带高度（win32/linux）。
 *
 * 不对齐主窗那 40px（titlebar.ts 的 WINDOWS_TITLEBAR_HEIGHT，对齐的是官方常量）：弹窗只有
 * 210–300px 高，40 会吃掉五分之一到三分之一。这里 32 够放一行 12px 的标题与 28px 的 ✕ 命中区。
 */
export const DIALOG_TITLEBAR_HEIGHT = 32

/** 关闭键在页面里的标记；各窗脚本按它绑行为（测试也按它断言）。 */
export const DIALOG_CLOSE_ATTR = 'data-dialog-close'

/** 挂到 <body> 上的 class：有带时才有，页面拿它做留位与「标题重复就不画」的判断。 */
export const DIALOG_TITLEBAR_CLASS = 'dlg-with-titlebar'

/** darwin 有系统红绿灯 ⇒ 不画带、也不占高度。 */
export function dialogTitlebarHeight(platform: CarrierPlatform): number {
  return platform === 'darwin' ? 0 : DIALOG_TITLEBAR_HEIGHT
}

export interface DialogTitlebarOptions {
  platform: CarrierPlatform
  /** 带上的标题（居左，截断省略号）。 */
  title: string
  /**
   * 给不给关闭键。
   *
   * 默认给（两个真弹窗）；splash 传 false——它自动关，给个 ✕ 是给假承诺（点了还没等它关）。
   */
  close?: boolean
}

export interface DialogTitlebar {
  /** 带本身的标记（<body> 的第一个子节点）；darwin 返回空串。 */
  html: string
  /** 挂到 <body> 上的 class（darwin 返回空串）。 */
  bodyClass: string
  /** 带的高度：0 或 DIALOG_TITLEBAR_HEIGHT，建窗时加到 frame.height 上。 */
  height: number
}

/** 关闭键图标：与主窗标题栏带（titlebar.ts）同一个 ✕ 路径，三处看着一致。 */
const CLOSE_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1" fill="none"/></svg>'

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * 标题带标记（纯字符串，可单测）。
 *
 * 拖拽面两条一起给：`-webkit-app-region: drag` 走 WebView2 的 non-client region（win32），
 * `electrobun-webkit-app-region-drag` 类名走 Electrobun JS 兼容层的发现（linux/CEF 没有
 * app-region，只有类名那条能用）。按钮上显式 `no-drag`，否则整条带都成了拖拽面。
 */
export function dialogTitlebar(options: DialogTitlebarOptions): DialogTitlebar {
  if (options.platform === 'darwin') return { html: '', bodyClass: '', height: 0 }
  const close = options.close ?? true
  return {
    bodyClass: ` ${DIALOG_TITLEBAR_CLASS}`,
    height: DIALOG_TITLEBAR_HEIGHT,
    // 第二个类名是给 linux/CEF 的：CEF 没有 app-region，只有 Electrobun JS 兼容层按类名发现拖拽热区。
    html: `<div class="dlg-titlebar electrobun-webkit-app-region-drag">
  <span class="dlg-titlebar-title">${escapeHtml(options.title)}</span>
  ${
    close
      ? `<button type="button" class="dlg-titlebar-close" ${DIALOG_CLOSE_ATTR} aria-label="关闭">${CLOSE_ICON}</button>`
      : ''
  }
</div>`,
  }
}

/** 标题带的 CSS（三个窗共用一段；留位规则各窗自己写，见文件头）。 */
export function dialogTitlebarStyle(): string {
  return [
    '.dlg-titlebar { position: absolute; top: 0; left: 0; right: 0;',
    `  height: ${DIALOG_TITLEBAR_HEIGHT}px; z-index: 5; display: flex; align-items: center; gap: 8px;`,
    '  padding: 0 4px 0 12px; font-size: 12px; line-height: 1;',
    '  background: var(--dsw-alias-surface-raised, #212328);',
    '  color: var(--dsw-alias-label-primary, #e8e8e8);',
    '  border-bottom: 1px solid var(--dsw-alias-border-l2, #3a3d44);',
    '  -webkit-app-region: drag; -webkit-user-select: none; user-select: none; }',
    '.dlg-titlebar-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    `.dlg-titlebar-close { -webkit-app-region: no-drag; width: ${DIALOG_TITLEBAR_HEIGHT - 4}px; height: ${
      DIALOG_TITLEBAR_HEIGHT - 4
    }px;`,
    '  border: none; border-radius: 4px; padding: 0; background: transparent; color: inherit;',
    '  display: grid; place-items: center; cursor: default; }',
    '.dlg-titlebar-close:hover { background: #e81123; color: #fff; }',
    '.dlg-titlebar-close:focus-visible { outline: 2px solid var(--dsw-alias-state-accent-primary, #4c6ef5); outline-offset: -2px; }',
    '.dlg-titlebar-close svg { width: 12px; height: 12px; display: block; }',
  ].join('\n')
}

/** 建窗用：把带的高度加到基准高度上（darwin 原样返回）。 */
export function dialogTitlebarFrameHeight(baseHeight: number, platform: CarrierPlatform): number {
  return baseHeight + dialogTitlebarHeight(platform)
}
