// 壳自带的应用菜单（系统剪贴板快捷键）的单测。
// 不是「可选项」：没菜单就整个剪贴板失效。窗口 chrome 让位已由桌面插件接管（#23/#44），骨架期注入退役。
import { describe, expect, test } from 'bun:test'
import {
  REQUIRED_EDIT_ROLES,
  applicationMenuItems,
  installApplicationMenu,
  type MenuItem,
} from '../src/bun/windows/menu.ts'


describe('应用菜单：系统剪贴板快捷键', () => {
  test('编辑菜单带齐原生角色（少一个就少一组快捷键）', () => {
    const items = applicationMenuItems()
    const edit = items.find((item) => item.label === 'Edit')
    expect(edit).toBeDefined()
    const roles = (edit?.submenu ?? []).map((item) => item.role).filter(Boolean) as string[]
    for (const role of REQUIRED_EDIT_ROLES) expect(roles).toContain(role)
    expect(roles).toContain('undo')
    expect(roles).toContain('redo')
  })

  test('应用菜单与窗口菜单覆盖旧壳默认菜单那几项', () => {
    const items = applicationMenuItems('DeepSeek Harness Desktop')
    const app = items.find((item) => item.label === 'DeepSeek Harness Desktop')
    const appRoles = (app?.submenu ?? []).map((item) => item.role)
    expect(appRoles).toContain('quit')
    expect(appRoles).toContain('hide')
    expect(appRoles).toContain('about')
    const win = items.find((item) => item.label === 'Window')
    expect((win?.submenu ?? []).map((item) => item.role)).toContain('close')
  })

  test('安装时把同一份结构交给原生层，并留日志', () => {
    const seen: MenuItem[][] = []
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')) }
    try {
      installApplicationMenu({ setApplicationMenu: (items) => { seen.push(items) } })
    } finally {
      console.log = original
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(applicationMenuItems())
    expect(logs.join('\n')).toContain('已安装应用菜单')
  })
})
