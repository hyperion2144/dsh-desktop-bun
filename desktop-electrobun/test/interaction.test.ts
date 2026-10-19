// 页面交互的两条补丁：外链转系统浏览器 + 右键菜单。
//
// 这两条都是「换掉旧壳后丢掉的能力」——旧壳（WKWebView + Tauri）自带右键菜单、并由
// nav_guard/webRequest 把 window.open 转给系统浏览器；CEF 两样都不做，不自己补就表现为
// 「点链接把窗口带走」「右键没有任何菜单」。
import { describe, expect, test } from 'bun:test'
import {
  CONTEXT_MENU_METHOD,
  SHELL_MENU_ACTIONS,
  contextMenuItems,
  isOpenablePath,
  contextMenuScript,
  type ShellMenuItem,
} from '../src/bun/windows/context-menu.ts'
import { OPEN_EXTERNAL_METHOD, externalLinksScript, isExternalUrl, isOpenableUrl } from '../src/bun/windows/external.ts'
import {
  TITLEBAR_WINDOW_METHODS,
  titlebarScript,
  WINDOWS_TITLEBAR_HEIGHT,
  WINDOW_STATE_METHOD,
  TITLEBAR_WINDOW_ENDPOINT,
} from '../src/bun/windows/titlebar.ts'
import { VIEW_TOKEN_HEADER } from '../src/shared/net/view-grant.ts'

const SELF = 'http://127.0.0.1:6391'

describe('外链：判定与拦截脚本', () => {
  test('同源链接留给应用内，别的一律交系统浏览器', () => {
    expect(isExternalUrl('https://example.com/a', SELF)).toBe(true)
    expect(isExternalUrl(`${SELF}/tok-1/`, SELF)).toBe(false)
    // 相对路径按 selfOrigin 解析，等于自己
    expect(isExternalUrl('/tok-1/settings', SELF)).toBe(false)
    expect(isExternalUrl('mailto:a@b.c', SELF)).toBe(true)
    expect(isExternalUrl('tel:+8613800000000', SELF)).toBe(true)
    // 别的 scheme 不接（html 里可能出现的 javascript: / file: / blob:）
    expect(isExternalUrl('javascript:alert(1)', SELF)).toBe(false)
    expect(isExternalUrl('file:///etc/passwd', SELF)).toBe(false)
    // 解析不了的字符串按相对路径落到自己 origin 上，当同源处理
    expect(isExternalUrl('not a url', SELF)).toBe(false)
  })

  test('命令口径比链接口径宽一档：多放行系统 handler，但不放行危险协议（#128）', () => {
    // 回归锁：通知设置卡的「打开系统通知设置」传的就是这个（notifications-tab.tsx 的 SYS_PREFS）。
    // #128 首次实现把命令闸直接设成 isExternalUrl，这条按钮会被静默吞掉（.catch(() => {})）。
    const SYS_PREFS = 'x-apple.systempreferences:com.apple.Preference.Notifications'
    expect(isExternalUrl(SYS_PREFS, SELF)).toBe(false)
    expect(isOpenableUrl(SYS_PREFS, SELF)).toBe(true)
    // 链接口径全部保持，两档口径不能分叉
    expect(isOpenableUrl('https://example.com/a', SELF)).toBe(true)
    expect(isOpenableUrl('mailto:a@b.c', SELF)).toBe(true)
    expect(isOpenableUrl(`${SELF}/tok-1/`, SELF)).toBe(false)
    expect(isOpenableUrl('/tok-1/settings', SELF)).toBe(false)
    // 宽一档不等于放行一切：能换壳执行上下文的协议照旧挡死
    expect(isOpenableUrl('javascript:alert(1)', SELF)).toBe(false)
    expect(isOpenableUrl('file:///etc/passwd', SELF)).toBe(false)
    expect(isOpenableUrl('data:text/html,<h1>x</h1>', SELF)).toBe(false)
    expect(isOpenableUrl('blob:http://x/y', SELF)).toBe(false)
    // 未登记的其它自定义协议仍然不放行（新增协议要显式改 OS_HANDLER_PROTOCOLS）
    expect(isOpenableUrl('someapp://do/thing', SELF)).toBe(false)
    expect(isOpenableUrl('not a url', SELF)).toBe(false)
  })

  test('window.open 被改写：上游「在系统浏览器打开」就是这一句（#128 改走官方 RPC）', () => {
    const script = externalLinksScript(SELF)
    expect(script).toContain(JSON.stringify(OPEN_EXTERNAL_METHOD))
    expect(script).toContain(JSON.stringify(SELF))
    expect(script).toContain('globalThis.open = function')
    expect(script).toContain('call(OPEN_EXTERNAL_METHOD, { url })')
    // 请求交给 preload 装的官方 RPC 分发器；注入脚本不再自己拼端点、不再带每视图 token 头
    expect(script).toContain('(globalThis.__DSH_SHELL_RPC__ ?? {}).request?.(method, params)')
    expect(script).not.toContain(VIEW_TOKEN_HEADER)
    expect(script).toContain('nativeOpen.call')
  })

  test('点击与中键都要拦，且放行页面自己处理过的链接', () => {
    const script = externalLinksScript(SELF)
    expect(script).toContain('addEventListener("click"')
    // 中键：不拦就会在实例里打开新页面，把壳带走（用户报的那条）
    expect(script).toContain('addEventListener("auxclick"')
    expect(script).toContain('event.defaultPrevented')
    expect(script).toContain('a[href]')
    // 锚点内部跳转不碰
    expect(script).toContain('startsWith("#")')
  })
})

describe('右键菜单：结构', () => {
  const none = { linkUrl: null, hasSelection: false, editable: false }
  /** 只取 role 项——我们自己的 action 项（刷新/外链/复制链接/打开/DevTools）没有 role。 */
  const roles = (items: ShellMenuItem[]): (string | undefined)[] =>
    items.filter((item) => item.role !== undefined).map((item) => item.role)

  test('空白处只有「刷新」——旧壳那份菜单里我们最需要的就这一项', () => {
    const items = contextMenuItems(none, false)
    expect(items).toEqual([{ label: '刷新', action: SHELL_MENU_ACTIONS.reload }])
  })

  test('外链上多出「在系统浏览器打开」与「复制链接地址」', () => {
    const items = contextMenuItems({ ...none, linkUrl: 'https://example.com/a' }, true)
    expect(items[0]).toMatchObject({ action: SHELL_MENU_ACTIONS.openExternal, data: { url: 'https://example.com/a' } })
    expect(items[1]).toMatchObject({ action: SHELL_MENU_ACTIONS.copyLink })
    expect(items.map((item) => item.label)).toContain('刷新')
  })

  test('应用内链接不给「在系统浏览器打开」（同源没必要绕出去）', () => {
    const labels = contextMenuItems({ ...none, linkUrl: `${SELF}/tok/a` }, false).map((item) => item.label)
    expect(labels).toContain('复制链接地址')
    expect(labels).not.toContain('在系统浏览器打开链接')
  })

  test('输入框给剪切/粘贴，普通选区只给复制', () => {
    const editable = contextMenuItems({ linkUrl: null, hasSelection: true, editable: true }, false)
    expect(roles(editable)).toEqual(['cut', 'copy', 'paste', 'selectAll'])
    const selected = contextMenuItems({ linkUrl: null, hasSelection: true, editable: false }, false)
    expect(roles(selected)).toEqual(['copy', 'selectAll'])
  })

  test('没有选区时剪切/复制置灰，但粘贴可用', () => {
    const items = contextMenuItems({ linkUrl: null, hasSelection: false, editable: true }, false)
    expect(items.find((item) => item.role === 'cut')?.enabled).toBe(false)
    expect(items.find((item) => item.role === 'copy')?.enabled).toBe(false)
    expect(items.find((item) => item.role === 'paste')?.enabled).toBeUndefined()
  })

  test('工作区文件行给「打开」，文件夹给「打开文件夹」，路径随 data 带回', () => {
    const file = contextMenuItems({ ...none, filesEntry: 'file', filesPath: '/tmp/a.txt' }, false)
    expect(file[0]).toMatchObject({ label: '打开', action: SHELL_MENU_ACTIONS.openPath, data: { path: '/tmp/a.txt' } })
    expect(file[1]).toEqual({ type: 'separator' })
    const dir = contextMenuItems({ ...none, filesEntry: 'directory', filesPath: '/tmp/proj' }, false)
    expect(dir[0]).toMatchObject({ label: '打开文件夹', action: SHELL_MENU_ACTIONS.openPath, data: { path: '/tmp/proj' } })
  })

  test('文件行 other 类型与相对路径不开洞，回到纯「刷新」', () => {
    const other = contextMenuItems({ ...none, filesEntry: 'other', filesPath: '/tmp/x' }, false)
    expect(other).toEqual([{ label: '刷新', action: SHELL_MENU_ACTIONS.reload }])
    const relative = contextMenuItems({ ...none, filesEntry: 'file', filesPath: 'etc/passwd' }, false)
    expect(relative).toEqual([{ label: '刷新', action: SHELL_MENU_ACTIONS.reload }])
    expect(isOpenablePath('/abs/path')).toBe(true)
    expect(isOpenablePath('C:\\Users\\me')).toBe(true)
    expect(isOpenablePath('C:/Users/me')).toBe(true)
    expect(isOpenablePath('etc/passwd')).toBe(false)
    expect(isOpenablePath('')).toBe(false)
  })

  test('「打开 DevTools」只随菜单开关出现（dev 恒开；打包态=开关开+口开），且垫底', () => {
    const release = contextMenuItems(none, false)
    expect(release.some((item) => item.action === SHELL_MENU_ACTIONS.openDevTools)).toBe(false)
    const dev = contextMenuItems(none, false, { devTools: true })
    expect(dev[dev.length - 1]).toMatchObject({ label: '打开 DevTools', action: SHELL_MENU_ACTIONS.openDevTools })
    expect(dev[dev.length - 2]).toEqual({ type: 'separator' })
  })

  test('win 打包态（#106 返工）：同一「打开 DevTools」入口，点击由壳分发为合成 F12；复制地址形态已废弃', () => {
    const win = contextMenuItems(none, false, { devTools: true })
    expect(win[win.length - 1]).toMatchObject({ label: '打开 DevTools', action: SHELL_MENU_ACTIONS.openDevTools })
    expect(win[win.length - 2]).toEqual({ type: 'separator' })
    // 「复制 DevTools 调试地址」不再存在（维护者拍板废弃：CDP 地址贴浏览器是空白页，不是用户要的形态）
    expect(win.map((item) => item.label)).not.toContain('复制 DevTools 调试地址')
  })
})

describe('右键菜单：注入脚本', () => {
  test('把上下文报给壳（官方 RPC show_context_menu），并带上坐标以外的三个判据', () => {
    const script = contextMenuScript()
    expect(script).toContain(JSON.stringify(CONTEXT_MENU_METHOD))
    expect(script).toContain('call(CONTEXT_MENU_METHOD, {')
    expect(script).toContain('addEventListener("contextmenu"')
    expect(script).toContain('linkUrl')
    expect(script).toContain('hasSelection')
    expect(script).toContain('isContentEditable')
  })

  test('页面自己接管过右键就不插手', () => {
    expect(contextMenuScript()).toContain('if (event.defaultPrevented) return')
  })

  test('工作区文件行的稳定标记与字段也进上下文（dsh ui-sidebar-files）', () => {
    const script = contextMenuScript()
    expect(script).toContain('data-files-entry')
    expect(script).toContain('data-files-path')
    expect(script).toContain('filesEntry')
    expect(script).toContain('filesPath')
  })
})

describe('标题栏带（#112/#121）：win32/linux 上收壳 preload 的声明式适配', () => {
  test('win32（#121）：拖拽交给官方 caption 行，壳只留三键 + no-drag 护栏', () => {
    const script = titlebarScript('win32')
    expect(script).toContain('dataset.windowsTitlebar')
    expect(script).toContain('--dsh-windows-titlebar-height')
    expect(script).toContain(JSON.stringify(WINDOWS_TITLEBAR_HEIGHT))
    // 原生 caption 开启：运行时不再建任何拖拽面（官方 `.frame::before` 即拖窗行）
    expect(script).toContain(`const NATIVE_CAPTION = ${JSON.stringify(true)}`)
    // 三键必须在官方 drag 区内显式 no-drag：Electrobun 没有 windowControlsOverlay
    expect(script).toContain(
      '#dsh-shell-titlebar-controls{position:absolute;top:0;right:0;bottom:0;display:flex;align-items:stretch;-webkit-app-region:no-drag}',
    )
    expect(script).toContain('cursor:default;pointer-events:auto;-webkit-app-region:no-drag}')
    expect(script).toContain(`const WINDOW_METHODS = ${JSON.stringify(TITLEBAR_WINDOW_METHODS)}`)
    expect(script).toContain(`const STATE_METHOD = ${JSON.stringify(WINDOW_STATE_METHOD)}`)
    expect(script).toContain('void call(method, {})')
    expect(script).toContain('void call(STATE_METHOD, {})')
    // #128：三键与最大化态查询走官方 RPC 显式方法，脚本不再带 token 头、不再打 HTTP 端点
    expect(script).not.toContain(VIEW_TOKEN_HEADER)
    expect(script).not.toContain(TITLEBAR_WINDOW_ENDPOINT)
    expect(script).toContain('最小化')
    expect(script).toContain('最大化')
    expect(script).toContain('关闭')
    // 三键不依赖 dsh 页面与插件状态（验收增补）：方法名查脚本内的静态表，通道只用壳 preload 装的全局
    expect(script).toContain('const method = WINDOW_METHODS[action]')
    expect(script).toContain('(globalThis.__DSH_SHELL_RPC__ ?? {}).request?.(method, params)')
  })

  test('linux（CEF）：CEF 无 app-region，仍注入两段拖拽热区 + 双击最大化', () => {
    const script = titlebarScript('linux')
    expect(script).toContain(`const NATIVE_CAPTION = ${JSON.stringify(false)}`)
    expect(script).toContain('electrobun-webkit-app-region-drag')
    // 拖拽几何绕开官方 leadingSeat（left:88px）：主 drag 段自 168px 起，座位可点
    expect(script).toContain('dsh-shell-titlebar-drag-main')
    expect(script).toContain('dblclick')
  })

  test('darwin：系统红绿灯，不注入（空串跳过）', () => {
    expect(titlebarScript('darwin')).toBe('')
  })
})
