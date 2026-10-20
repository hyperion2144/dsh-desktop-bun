// #203 窗口图标：Windows 专属 FFI 面（WM_SETICON + SetClassLongPtr）在非 Windows 平台必须干净空转。
// win32 真实路径（ExtractIconEx/枚举/发消息）本地无法验证，由快验 CI 与用户装包实测覆盖。

import { describe, expect, test } from 'bun:test'
import { applyWindowsIcon, imageMatchesHints, WINDOW_HOST_IMAGE_HINTS } from '../src/bun/platform/window-icon.ts'
import { collectingLogger, silentLogger } from './helpers/test-logger.ts'

describe('窗口图标（#203）', () => {

describe('imageMatchesHints（#203 二轮：跨进程窗口宿主判定）', () => {
  test('launcher/bun 命中（大小写/反斜杠路径归一）', () => {
    expect(imageMatchesHints('C:\\App\\bin\\LAUNCHER.EXE')).toBe(true)
    expect(imageMatchesHints('C:/App/bin/bun.exe')).toBe(true)
    expect(WINDOW_HOST_IMAGE_HINTS).toContain('launcher.exe')
  })
  test('其他进程（WebView2/任意 exe）不命中', () => {
    expect(imageMatchesHints('C:/App/msedgewebview2.exe')).toBe(false)
    expect(imageMatchesHints('notepad.exe')).toBe(false)
  })
  test('自定义 hints 生效', () => {
    expect(imageMatchesHints('x://a.exe', ['a.exe'])).toBe(true)
  })
})
  test('非 Windows 平台空转：不炸、返回原因、零窗口', () => {
    if (process.platform === 'win32') return
    const lines: string[] = []
      const result = applyWindowsIcon(collectingLogger(lines), ['/nonexistent/app-icon.ico'])
    expect(result.ok).toBe(false)
    expect(result.windows).toBe(0)
    expect(result.reason).toBe('非 Windows 平台')
    expect(lines).toEqual([])
  })

  test('函数签名收口：log 回调只在真实路径调用', () => {
    // 平台守卫在最前：这条守卫保证 mac/linux 的壳启动不会碰任何 FFI
      const result = applyWindowsIcon(silentLogger, ['any'])
    if (process.platform !== 'win32') expect(result.reason).toBe('非 Windows 平台')
  })
})
