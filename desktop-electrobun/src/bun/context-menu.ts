// 页面右键菜单：CEF 默认不弹菜单（Electrobun 用自己的 CefContextMenuHandler 接管），
// 旧壳（WKWebView）自带的那份里「刷新页面」等项在换壳后就没了。
//
// 做法：页面在 `contextmenu` 时把上下文（有没有点到链接、是否可编辑、有没有选中）报给壳端点，
// 由**主进程**用 Electrobun 的 `ContextMenu.showContextMenu` 弹原生菜单——复制/剪切/粘贴/全选
// 走原生 role（macOS 上才有意义，Windows/Linux 由 CEF 自己处理 Ctrl 系快捷键）；「刷新」
// 「在系统浏览器打开链接」「复制链接地址」「打开 / 打开文件夹（工作区文件行）」
// 「打开 DevTools」（dev 构建 = CEF openDevTools；win = 合成 F12，#106 返工）是我们自己的 action。
//
// 这里是纯逻辑部分（菜单结构 + 注入脚本），执行部分在 index.ts。

export const CONTEXT_MENU_ENDPOINT = '/__shell__/context-menu'

import { VIEW_TOKEN_HEADER } from '../shared/view-grant.ts'

export interface ContextMenuRequest {
  /** 右键点到的链接（没有则 null）。 */
  linkUrl: string | null
  /** 当前是否有选区。 */
  hasSelection: boolean
  /** 是否点在可编辑元素上（输入框 / contenteditable）。 */
  editable: boolean
  /** 工作区文件 tab：右键点中的条目类型（不在文件行上为 null；other 不给打开项）。 */
  filesEntry?: 'file' | 'directory' | 'other' | null
  /** 工作区文件 tab：条目的绝对路径（不在文件行上为 null）。 */
  filesPath?: string | null
}

export interface ShellMenuItem {
  type?: 'normal' | 'separator' | 'divider'
  label?: string
  role?: string
  action?: string
  data?: unknown
  enabled?: boolean
}

export const SHELL_MENU_ACTIONS = {
  reload: 'shell:reload',
  openExternal: 'shell:open-external-link',
  copyLink: 'shell:copy-link',
  openPath: 'shell:open-path',
  openDevTools: 'shell:open-devtools',
} as const
/** 菜单附加开关（都可选；缺省＝不附加）。 */
export interface ContextMenuOptions {
  /** 追加「打开 DevTools」入口：dev 构建与 win 打包态（#106 返工）都出现；CEF 走 openDevTools，win 走合成 F12。 */
  devTools?: boolean
}

/** 工作区路径准入：只认 POSIX 绝对路径或 Windows 盘符绝对路径，相对路径/URL 一律不开洞。 */
export function isOpenablePath(path: string): boolean {
  return /^(\/|[a-zA-Z]:[\\/])/.test(path)
}

/**
 * 原生菜单结构。`externalLink` 判定由调用方给（壳知道自己的 origin），
 * 返回的项里 `data` 带上执行时需要的参数；`options.devTools` 控制 DevTools 入口（dev=CEF inspector；win=合成 F12）。
 */
export function contextMenuItems(
  request: ContextMenuRequest,
  linkIsExternal: boolean,
  options: ContextMenuOptions = {},
): ShellMenuItem[] {
  const items: ShellMenuItem[] = []
  // 工作区文件 tab（dsh ui-sidebar-files 的稳定标记）：文件给「打开」，文件夹给「打开文件夹」
  if (
    (request.filesEntry === 'file' || request.filesEntry === 'directory') &&
    typeof request.filesPath === 'string' &&
    isOpenablePath(request.filesPath)
  ) {
    items.push({
      label: request.filesEntry === 'file' ? '打开' : '打开文件夹',
      action: SHELL_MENU_ACTIONS.openPath,
      data: { path: request.filesPath },
    })
    items.push({ type: 'separator' })
  }
  if (request.linkUrl !== null && request.linkUrl !== '') {
    if (linkIsExternal) {
      items.push({ label: '在系统浏览器打开链接', action: SHELL_MENU_ACTIONS.openExternal, data: { url: request.linkUrl } })
    }
    items.push({ label: '复制链接地址', action: SHELL_MENU_ACTIONS.copyLink, data: { url: request.linkUrl } })
    items.push({ type: 'separator' })
  }
  items.push({ label: '刷新', action: SHELL_MENU_ACTIONS.reload })
  if (request.editable || request.hasSelection) {
    items.push({ type: 'separator' })
    if (request.editable) {
      items.push({ role: 'cut', enabled: request.hasSelection })
      items.push({ role: 'copy', enabled: request.hasSelection })
      items.push({ role: 'paste' })
    } else {
      items.push({ role: 'copy' })
    }
    items.push({ role: 'selectAll' })
  }
  // 「打开 DevTools」垫底：dev 构建（CEF openDevTools）与 win 打包态（#106 返工：合成 F12）都出现
  if (options.devTools === true) {
    items.push({ type: 'separator' })
    items.push({ label: '打开 DevTools', action: SHELL_MENU_ACTIONS.openDevTools })
  }
  return items
}

/** document-start 注入：右键时把上下文报给壳，交给原生菜单。 */
export function contextMenuScript(viewToken: string): string {
  return [
    ';(() => {',
    `  const ENDPOINT = ${JSON.stringify(CONTEXT_MENU_ENDPOINT)}`,
    `  const VIEW_TOKEN = ${JSON.stringify(viewToken)}`,
    '  const log = (msg) => console.info("[context-menu] " + msg)',
    '  document.addEventListener("contextmenu", (event) => {',
    '    const target = event.target',
    '    const anchor = target && target.closest ? target.closest("a[href]") : null',
    '    const href = anchor ? anchor.href : null',
    '    // dsh 右侧边栏工作区文件 tab：条目行带 data-files-entry（file/directory/other）+ data-files-path',
    '    const filesRow = target && target.closest ? target.closest("[data-files-entry]") : null',
    '    const filesEntry = filesRow ? filesRow.getAttribute("data-files-entry") : null',
    '    const filesPath = filesRow ? filesRow.getAttribute("data-files-path") : null',
    '    const selection = String(globalThis.getSelection ? globalThis.getSelection() : "")',
    '    const editable = !!(target && (target.isContentEditable || /^(input|textarea)$/i.test(target.tagName || "")))',
    '    // 页面自己接管了右键（例如 dsh 的富文本区域）就不插手',
    '    if (event.defaultPrevented) return',
    '    event.preventDefault()',
    '    try {',
    '      void fetch(ENDPOINT, {',
    '        method: "POST",',
    `        headers: { "content-type": "application/json", ${JSON.stringify(VIEW_TOKEN_HEADER)}: VIEW_TOKEN },`,
    '        body: JSON.stringify({ linkUrl: href, hasSelection: selection.length > 0, editable, filesEntry, filesPath, x: event.clientX, y: event.clientY }),',
    '        keepalive: true,',
    '      })',
    '    } catch (error) { log("右键菜单请求失败：" + String(error)) }',
    '  })',
    '})()',
  ].join('\n')
}
