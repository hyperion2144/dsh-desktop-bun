// 标题带（#164）的纯逻辑测试：darwin 不画、win32/linux 画、拖拽面两条都在、关窗键可关可不关。
import { describe, expect, test } from 'bun:test'
import {
  DIALOG_CLOSE_ATTR,
  DIALOG_TITLEBAR_CLASS,
  DIALOG_TITLEBAR_HEIGHT,
  dialogTitlebar,
  dialogTitlebarFrameHeight,
  dialogTitlebarHeight,
  dialogTitlebarStyle,
} from '../src/bun/dialog-titlebar.ts'

const WIN: Array<'win32' | 'linux' | 'darwin'> = ['win32', 'linux', 'darwin']

describe('dialogTitlebar：只补 win32/linux（#164）', () => {
  test('darwin 一律空：系统红绿灯现成，不画带也不占高度', () => {
    const band = dialogTitlebar({ platform: 'darwin', title: '新建 Profile' })
    expect(band).toEqual({ html: '', bodyClass: '', height: 0 })
    expect(dialogTitlebarHeight('darwin')).toBe(0)
  })

  test('win32 / linux 都画带，且高度一致', () => {
    for (const platform of WIN) {
      if (platform === 'darwin') continue
      const band = dialogTitlebar({ platform, title: '新建 Profile' })
      expect(band.height).toBe(DIALOG_TITLEBAR_HEIGHT)
      expect(band.bodyClass).toBe(` ${DIALOG_TITLEBAR_CLASS}`)
      expect(band.html).toContain('dlg-titlebar')
    }
    expect(dialogTitlebarHeight('win32')).toBe(dialogTitlebarHeight('linux'))
  })

  test('带上有标题、可拖拽；关闭键默认给', () => {
    const band = dialogTitlebar({ platform: 'win32', title: '迁移 Profile' })
    expect(band.html).toContain('迁移 Profile')
    // 拖拽两条一起给：CSS 的 app-region（win32 走 WebView2 non-client region）
    // 与类名（linux/CEF 只认 Electrobun 兼容层按类名发现）。
    expect(band.html).toContain('electrobun-webkit-app-region-drag')
    expect(dialogTitlebarStyle()).toContain('-webkit-app-region: drag')
    expect(band.html).toContain(DIALOG_CLOSE_ATTR)
    expect(band.html).toContain('aria-label="关闭"')
  })

  test('close: false（splash）只留拖拽带，不给关闭键', () => {
    const band = dialogTitlebar({ platform: 'linux', title: 'DeepSeek Harness', close: false })
    expect(band.html).toContain('dlg-titlebar')
    expect(band.html).not.toContain(DIALOG_CLOSE_ATTR)
    expect(band.height).toBe(DIALOG_TITLEBAR_HEIGHT)
  })

  test('标题里的尖括号与引号被转义（标题来自壳侧文案，不是可信输入）', () => {
    const band = dialogTitlebar({ platform: 'win32', title: '<img src=x onerror="boom()">' })
    expect(band.html).not.toContain('<img')
    expect(band.html).toContain('&lt;img')
  })

  test('样式里有 body 留位所需的 class 钩子与 no-drag 保护', () => {
    const css = dialogTitlebarStyle()
    expect(css).toContain(`.dlg-titlebar-close { -webkit-app-region: no-drag;`)
    expect(css).toContain(`height: ${DIALOG_TITLEBAR_HEIGHT}px`)
    expect(css).toContain('position: absolute')
  })
})

describe('dialogTitlebarFrameHeight：带的高度要加到窗体上（#164）', () => {
  test('win32/linux 补一段高度，darwin 原样', () => {
    expect(dialogTitlebarFrameHeight(210, 'win32')).toBe(210 + DIALOG_TITLEBAR_HEIGHT)
    expect(dialogTitlebarFrameHeight(300, 'linux')).toBe(300 + DIALOG_TITLEBAR_HEIGHT)
    expect(dialogTitlebarFrameHeight(210, 'darwin')).toBe(210)
  })
})
