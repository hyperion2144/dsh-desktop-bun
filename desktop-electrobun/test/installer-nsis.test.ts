// #78 卸载清理：NSIS 模板断言。makensis 不在测试里跑（macOS/CI 测试机都没有），这里只守模板内容——
// 卸载段必须调用 un.CleanShellPluginLinks；函数体对三个壳插件包名只 RMDir 链接本身，
// 禁 RMDir /r（真实目录占位时递归删会误伤用户文件）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const script = readFileSync(join(import.meta.dir, '..', 'scripts', 'build-windows-installer.mjs'), 'utf8')

const fnStart = script.indexOf('Function un.CleanShellPluginLinks')
const uninstallerFn = script.slice(fnStart, script.indexOf('FunctionEnd', fnStart))
const uninstallSection = script.slice(
  script.indexOf('Section "un.install"'),
  script.indexOf('SectionEnd', script.indexOf('Section "un.install"')),
)

describe('NSIS 卸载段：清壳插件链接（#78）', () => {
  test('un.install 段调用清理函数', () => {
    expect(uninstallSection).toContain('Call un.CleanShellPluginLinks')
  })

  test('home 解析与壳 dshHome() 同源：DSH_HOME 优先，缺省回 %USERPROFILE%\\.dsh；两者皆空直接放弃', () => {
    expect(uninstallerFn).toContain('ReadEnvStr $R0 "DSH_HOME"')
    expect(uninstallerFn).toContain('ReadEnvStr $R0 "USERPROFILE"')
    expect(uninstallerFn).toContain(String.raw`StrCpy $R0 "$R0\\.dsh"`)
    expect(uninstallerFn).toContain(String.raw`FindFirst $R1 $R2 "$R0\\profiles\\*.*"`)
  })

  test('三件壳插件包名逐一 RMDir（profile 池 + 旧布局 home 直下池），且不递归', () => {
    for (const name of ['dsh-desktop-bun', 'dsh-mobile-access', 'dsh-web-mobile']) {
      expect(uninstallerFn).toContain(String.raw`RMDir "$R0\\profiles\\$R2\\node_modules\\${name}"`)
      expect(uninstallerFn).toContain(String.raw`RMDir "$R0\\node_modules\\${name}"`)
      expect(uninstallerFn).toContain(String.raw`IfFileExists "$R0\\profiles\\$R2\\node_modules\\*.*" 0 un78_next`)
      expect(uninstallerFn).toContain(String.raw`FindNext $R1 $R2`)
      expect(uninstallerFn).toContain('FindClose $R1')
    }
    expect(uninstallerFn).not.toContain('RMDir /r')
  })
})
