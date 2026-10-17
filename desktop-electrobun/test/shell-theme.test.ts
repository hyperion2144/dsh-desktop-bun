import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SHELL_THEME,
  shellThemeAttr,
  shellThemeFromPatchYaml,
  shellThemeStyle,
} from '../src/shared/shell-theme.ts'
import { PROFILE_PATCH_FILE, readShellTheme } from '../src/bun/theme-source.ts'

/** 隔离实例里那份文件的真实形状（用户直接在 profile 目录里手改的）。 */
const PATCH_LIGHT = `# Your patch layer for this dsh profile, applied after every bundle layer:
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: light
`

const PATCH_DARK = `- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
`

const PATCH_OTHER_LAYER = `- id: something-else
  name: "@deepseek-ai/dsh-base"
  config:
    preference: dark
`

function profileWith(patch: string | null): { home: string; profile: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-theme-'))
  const profile = 'desktop'
  const dir = join(home, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  if (patch !== null) writeFileSync(join(dir, PROFILE_PATCH_FILE), patch)
  return { home, profile }
}

describe('shellThemeFromPatchYaml：主题偏好是 DSH 的，不另发明一套', () => {
  test('读到 ui-theme 层的 preference', () => {
    expect(shellThemeFromPatchYaml(PATCH_LIGHT)).toBe('light')
    expect(shellThemeFromPatchYaml(PATCH_DARK)).toBe('dark')
    expect(shellThemeFromPatchYaml(PATCH_LIGHT.replace('preference: light', 'preference: system'))).toBe('system')
  })

  test('内联写法也认（config: { preference: dark }）', () => {
    expect(shellThemeFromPatchYaml('- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n  config: { preference: dark }\n')).toBe('dark')
  })

  test('没文件、没那层、值不认识 ⇒ 缺省浅色（产品在同样情况下的渲染结果）', () => {
    expect(shellThemeFromPatchYaml(null)).toBe(DEFAULT_SHELL_THEME)
    expect(shellThemeFromPatchYaml('   \n')).toBe(DEFAULT_SHELL_THEME)
    expect(shellThemeFromPatchYaml(PATCH_OTHER_LAYER)).toBe(DEFAULT_SHELL_THEME)
    expect(shellThemeFromPatchYaml('- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n  config:\n    preference: neon\n')).toBe(DEFAULT_SHELL_THEME)
    expect(shellThemeFromPatchYaml('- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n')).toBe(DEFAULT_SHELL_THEME)
    // 缺省不是「跟随系统」：本壳里 CEF 的 prefers-color-scheme 报 dark 而产品渲染浅色，
    // 跟系统走会把弹窗变成深色贴在浅色应用上（真机反馈）。
    expect(DEFAULT_SHELL_THEME).toBe('light')
  })

  test('别把别的层的 preference 捡过来', () => {
    const text = `- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    fontSize: 14
- id: other
  name: "@deepseek-ai/dsh-other"
  config:
    preference: dark
`
    expect(shellThemeFromPatchYaml(text)).toBe(DEFAULT_SHELL_THEME)
  })
})

describe('shellThemeAttr / shellThemeStyle', () => {
  test('显式浅色/暗色才写 data-theme；跟随系统就留空交给媒体查询', () => {
    expect(shellThemeAttr('light')).toBe(' data-theme="light"')
    expect(shellThemeAttr('dark')).toBe(' data-theme="dark"')
    expect(shellThemeAttr('system')).toBe('')
  })

  test('主题块三条规则：缺省浅色、系统暗色时切暗（除非显式钉浅色）、显式钉暗色永远暗', () => {
    const css = shellThemeStyle()
    expect(css).toContain(':root{color-scheme:light dark;')
    expect(css).toContain('@media (prefers-color-scheme: dark){:root:not([data-theme="light"])')
    expect(css).toContain(':root[data-theme="dark"]{')
    expect(css).toContain('--dsw-alias-bg-layer-1:#1b1d21')
    expect(css).toContain('--dsw-alias-bg-layer-1:#ffffff')
  })
})

describe('readShellTheme：壳读 profile 目录里那份补丁层', () => {
  test('读到偏好', () => {
    const { home, profile } = profileWith(PATCH_DARK)
    expect(readShellTheme(home, profile)).toBe('dark')
  })

  test('profile 还没初始化（目录都没有）⇒ 缺省浅色，不抛', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-theme-'))
    expect(readShellTheme(home, 'desktop')).toBe(DEFAULT_SHELL_THEME)
  })
})
