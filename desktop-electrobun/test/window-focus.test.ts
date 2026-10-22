import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createWindowFocusTracker } from '../src/bun/windows/window-focus.ts'

describe('window-focus：焦点记账（#115）', () => {
  test('focus 记当前窗口，blur 清空', () => {
    const focus = createWindowFocusTracker()
    expect(focus.current()).toBeNull()
    focus.focus('work')
    expect(focus.current()).toBe('work')
    expect(focus.isFocused('work')).toBe(true)
    focus.blur('work')
    expect(focus.current()).toBeNull()
    expect(focus.isFocused('work')).toBe(false)
  })

  test('多 profile：A 聚焦时 B 不算在前台（B 的通知照投）', () => {
    const focus = createWindowFocusTracker()
    focus.focus('a')
    expect(focus.isFocused('a')).toBe(true)
    expect(focus.isFocused('b')).toBe(false)
    focus.focus('b')
    expect(focus.isFocused('a')).toBe(false)
    expect(focus.isFocused('b')).toBe(true)
  })

  test('切窗口的乱序事件：迟到的 A-blur 不抹掉 B', () => {
    const focus = createWindowFocusTracker()
    focus.focus('a')
    focus.focus('b') // B 的 focus 先到
    focus.blur('a') // A 的 blur 才到（真实平台上很常见）
    expect(focus.current()).toBe('b')
  })

  test('release：关窗 / 隐藏 / 最小化到托盘也清（平台不一定补 blur）', () => {
    const focus = createWindowFocusTracker()
    focus.focus('work')
    focus.release('work')
    expect(focus.current()).toBeNull()
    // 迟到的旧窗口 release 不会误伤当前焦点（同名窗口重建）
    focus.focus('work')
    focus.focus('other')
    focus.release('work')
    expect(focus.current()).toBe('other')
  })

  test('无窗口模式：从不 focus，恒为「没有窗口在前台」', () => {
    const focus = createWindowFocusTracker()
    expect(focus.current()).toBeNull()
    expect(focus.isFocused('any')).toBe(false)
    focus.blur('any')
    focus.release('any')
    expect(focus.current()).toBeNull()
  })
})

describe('window-focus：壳侧接线门禁（#115）', () => {
  // 单测发现不了「事件没接上」：focus 记账漏一行，功能整个是死的而所有单测依旧全绿
  // （第一版就漏过）。这里把四个接线点钉在源码上，漏接就变红。
  // #179 后事件接线与焦点记账在 profile-session.ts，壳侧只留查询转发。
  /** 先剥掉注释再断言：防「调用删了、注释里还留着同名串」式的假门禁。 */
  const codeOf = (file: string): string =>
    readFileSync(new URL(file, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const indexSource = codeOf('../src/bun/desktop-shell.ts')
  const sessionSource = codeOf('../src/bun/windows/profile-session.ts')
  const serviceSource = codeOf('../src/bun/host/service.ts')

  test('窗口 focus / blur 都记账，查询接到「此刻在前台」上', () => {
    expect(sessionSource).toContain("win.on('focus', () => {")
    expect(sessionSource).toContain('focus.focus(profile)')
    expect(sessionSource).toContain("win.on('blur', () => {")
    expect(sessionSource).toContain('focus.blur(profile)')
  })

  test('隐藏 / 关窗也清焦点；服务面与壳级通知各拿各的口径', () => {
    // 记账清账在 session 内部（dispose 十步 + releaseFocus 出口）；壳侧隐藏回托盘走 releaseFocus
    const releases = sessionSource.match(/focus\.release\(/g) ?? []
    expect(releases.length).toBeGreaterThanOrEqual(2)
    expect(indexSource).toContain('sessions.releaseFocus(')
    expect(indexSource).toContain('isWindowFocused: (target) =>')
    expect(indexSource).toContain('isFocused: () => anyWindowInFront()')
    expect(serviceSource).toContain('isFocused: () => options.isWindowFocused?.(paths.profile) ?? false')
  })

  test('壳级通知也走可见 / 最小化兜底（最小化时别被静默吞掉）', () => {
    // 壳级只有 tracker 的账，最小化不一定补 blur：查询必须自己再看一眼窗口状态
    expect(indexSource).toContain('function windowInFront(profile: string): boolean {')
    expect(sessionSource).toContain('.isVisible() && !')
    expect(sessionSource).toContain('.isMinimized()')
    expect(indexSource).toContain('isWindowFocused: (target) => windowInFront(target)')
  })
})
