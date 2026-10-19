// #110 渲染后端描述符：一份事实源（renderer / env 载体 / DevTools 打开方式 / C environ 写入器）。
// 这些字段以前散在 devtools.ts 的 5 处三元与 index.ts 的日志/菜单分支里；这里锁住描述符契约。
import { describe, expect, test } from 'bun:test'

import { DEVTOOLS_PORT_OVERRIDE_ENV } from '../src/bun/windows/devtools.ts'
import {
  CEF_RENDER_BACKEND,
  DEVTOOLS_PORT_ENV,
  resolveRenderBackend,
  WEBVIEW2_DEVTOOLS_ARGS_ENV,
  WEBVIEW2_RENDER_BACKEND,
} from '../src/bun/windows/render-backend.ts'

describe('resolveRenderBackend（构建期唯一选择点）', () => {
  test('availableRenderers 含 cef → CEF 描述符（mac/linux）', () => {
    expect(resolveRenderBackend({ availableRenderers: ['cef'] })).toBe(CEF_RENDER_BACKEND)
    expect(resolveRenderBackend({ availableRenderers: ['cef', 'native'] })).toBe(CEF_RENDER_BACKEND)
  })

  test('不含 cef → WebView2 描述符（win，构建不打 CEF）', () => {
    expect(resolveRenderBackend({ availableRenderers: [] })).toBe(WEBVIEW2_RENDER_BACKEND)
    expect(resolveRenderBackend({ availableRenderers: ['native'] })).toBe(WEBVIEW2_RENDER_BACKEND)
  })
})

describe('CEF 描述符（mac/linux）', () => {
  test('renderer=cef、label=CEF、调试口写裸端口、DevTools 走应用内 inspector', () => {
    expect(CEF_RENDER_BACKEND.kind).toBe('cef')
    expect(CEF_RENDER_BACKEND.renderer).toBe('cef')
    expect(CEF_RENDER_BACKEND.label).toBe('CEF')
    expect(CEF_RENDER_BACKEND.devToolsEnv.name).toBe(DEVTOOLS_PORT_ENV)
    expect(CEF_RENDER_BACKEND.devToolsEnv.encode(9333)).toBe('9333')
    expect(CEF_RENDER_BACKEND.devToolsEnv.appendToExisting).toBe(false)
    expect(CEF_RENDER_BACKEND.devToolsOpen).toBe('inspector')
    expect(CEF_RENDER_BACKEND.devToolsLogHint).toBe('')
  })
})

describe('WebView2 描述符（win）', () => {
  test('renderer=native、label=WebView2、CDP 走 loader 附加参数、DevTools 走合成 F12', () => {
    expect(WEBVIEW2_RENDER_BACKEND.kind).toBe('webview2')
    expect(WEBVIEW2_RENDER_BACKEND.renderer).toBe('native')
    expect(WEBVIEW2_RENDER_BACKEND.label).toBe('WebView2')
    expect(WEBVIEW2_RENDER_BACKEND.devToolsEnv.name).toBe(WEBVIEW2_DEVTOOLS_ARGS_ENV)
    expect(WEBVIEW2_RENDER_BACKEND.devToolsEnv.encode(9333)).toBe('--remote-debugging-port=9333 --remote-allow-origins=*')
    expect(WEBVIEW2_RENDER_BACKEND.devToolsEnv.appendToExisting).toBe(true)
    expect(WEBVIEW2_RENDER_BACKEND.devToolsOpen).toBe('keystroke')
    expect(WEBVIEW2_RENDER_BACKEND.devToolsLogHint).not.toBe('')
  })
})

describe('env 契约常量', () => {
  test('Electrobun 原生层读的口 env 与壳覆盖 env 名字不被手滑改掉', () => {
    expect(DEVTOOLS_PORT_ENV).toBe('ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT')
    expect(DEVTOOLS_PORT_OVERRIDE_ENV).toBe('DSH_SHELL_DEVTOOLS_PORT')
    expect(WEBVIEW2_DEVTOOLS_ARGS_ENV).toBe('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')
    expect(CEF_RENDER_BACKEND.devToolsEnv.name).toBe(DEVTOOLS_PORT_ENV)
    expect(WEBVIEW2_RENDER_BACKEND.devToolsEnv.name).toBe(WEBVIEW2_DEVTOOLS_ARGS_ENV)
  })
})

describe('createCEnvWriter（后端 → 平台 C 运行时）', () => {
  test.skipIf(process.platform !== 'darwin')('mac：CEF 拿到 libc setenv 写入器；WebView2 的 kernel32 写入器不可用', () => {
    expect(CEF_RENDER_BACKEND.createCEnvWriter()).not.toBeNull()
    expect(WEBVIEW2_RENDER_BACKEND.createCEnvWriter()).toBeNull()
  })

  test.skipIf(process.platform !== 'win32')('win：WebView2 拿到 kernel32 写入器；CEF 的 libSystem 写入器不可用', () => {
    expect(WEBVIEW2_RENDER_BACKEND.createCEnvWriter()).not.toBeNull()
    expect(CEF_RENDER_BACKEND.createCEnvWriter()).toBeNull()
  })
})
