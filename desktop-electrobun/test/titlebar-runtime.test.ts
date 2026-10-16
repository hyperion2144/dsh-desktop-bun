// #112 回归护栏：注入脚本是「生成的 JS 字符串」，文本断言（interaction.test）只能锁内容、
// 不能发现运行时错误（曾因未序列化常量 BAND_SEAT_LEFT 产生 ReferenceError 而三键整体缺失）。
// 本文件用最小 DOM 桩真实执行 titlebarScript 产物，锁定：mark 标记、band/三键结构、
// GET 状态查询与拖拽类名。
import { describe, expect, test } from 'bun:test'
import { TITLEBAR_WINDOW_ENDPOINT, titlebarScript, WINDOWS_TITLEBAR_HEIGHT } from '../src/bun/titlebar.ts'

class StubNode {
  tag: string
  children: StubNode[] = []
  attributes = new Map<string, string>()
  dataset: Record<string, string> = {}
  styleValues: Record<string, string> = {}
  readonly style = { setProperty: (k: string, v: string) => { this.styleValues[k] = v } }
  className = ''
  innerHTML = ''
  textContent = ''
  type = ''
  readonly listeners = new Map<string, Array<() => void>>()
  readonly #byId: Map<string, StubNode>

  constructor(tag: string, byId: Map<string, StubNode>) {
    this.tag = tag
    this.#byId = byId
  }

  #idValue = ''
  get id(): string {
    return this.#idValue
  }
  set id(value: string) {
    this.#idValue = value
    this.#byId.set(value, this)
  }

  appendChild(child: StubNode): StubNode {
    this.children.push(child)
    return child
  }

  append(...kids: StubNode[]): void {
    this.children.push(...kids)
  }

  setAttribute(key: string, value: string): void {
    this.attributes.set(key, value)
  }

  getAttribute(key: string): string | null {
    return this.attributes.get(key) ?? null
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
}

describe('标题栏带脚本真实执行（#112 回归护栏）', () => {
  test('win32 脚本在 DOM 桩上执行无异常，产出标记与完整三键结构', () => {
    const byId = new Map<string, StubNode>()
    const documentElement = new StubNode('html', byId)
    const head = new StubNode('head', byId)
    const body = new StubNode('body', byId)
    const documentListeners = new Map<string, Array<() => void>>()
    const documentStub = {
      documentElement,
      head,
      body,
      visibilityState: 'visible',
      createElement: (tag: string) => new StubNode(tag, byId),
      getElementById: (id: string) => byId.get(id) ?? null,
      addEventListener: (type: string, listener: () => void) => {
        const list = documentListeners.get(type) ?? []
        list.push(listener)
        documentListeners.set(type, list)
      },
    }
    const windowListeners: string[] = []
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = []

    const globals = globalThis as Record<string, unknown>
    const saved = { document: globals.document, window: globals.window, fetch: globals.fetch }
    globals.document = documentStub
    globals.window = {
      addEventListener: (type: string) => { windowListeners.push(type) },
      clearTimeout: () => {},
      setTimeout: () => 0,
    }
    globals.fetch = (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init })
      return Promise.resolve({ ok: false, json: async () => ({}) })
    }

    try {
      delete globals.__DSH_SHELL_TITLEBAR__
      ;(0, eval)(titlebarScript('win32', 'test-token'))
    } finally {
      globals.document = saved.document
      globals.window = saved.window
      globals.fetch = saved.fetch
      delete globals.__DSH_SHELL_TITLEBAR__
    }

    // mark：官方声明式标记与高度变量
    expect(documentElement.dataset.windowsTitlebar).toBe('')
    expect(documentElement.styleValues['--dsh-windows-titlebar-height']).toBe(`${WINDOWS_TITLEBAR_HEIGHT}px`)

    // build：样式注入 + band（两段 drag + controls）
    expect(head.children).toHaveLength(1)
    expect(head.children[0]!.textContent).toContain('#dsh-shell-titlebar{')
    const band = byId.get('dsh-shell-titlebar')
    expect(band).toBeDefined()
    expect(band!.children).toHaveLength(3)
    expect(band!.children[0]!.id).toBe('dsh-shell-titlebar-drag')
    expect(band!.children[0]!.className).toBe('electrobun-webkit-app-region-drag')
    expect(band!.children[1]!.id).toBe('dsh-shell-titlebar-drag-main')
    expect(band!.children[1]!.className).toBe('electrobun-webkit-app-region-drag')
    expect(band!.children[2]!.id).toBe('dsh-shell-titlebar-controls')

    // 三键：动作、aria 与图标
    const buttons = band!.children[2]!.children
    expect(buttons.map((b) => b.getAttribute('data-action'))).toEqual(['minimize', 'toggle-maximize', 'close'])
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['最小化', '最大化', '关闭'])
    expect(buttons.every((b) => b.innerHTML.startsWith('<svg'))).toBe(true)

    // GET 状态查询（build 末尾一次），事件兜底挂载
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.url).toBe(TITLEBAR_WINDOW_ENDPOINT)
    expect(fetchCalls[0]!.init?.method).toBeUndefined()
    expect(windowListeners).toEqual(expect.arrayContaining(['resize', 'focus']))
    expect(documentListeners.has('visibilitychange')).toBe(true)
  })
})
