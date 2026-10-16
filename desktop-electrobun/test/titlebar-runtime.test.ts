// #112/#121 回归护栏：注入脚本是「生成的 JS 字符串」，文本断言（interaction.test）只能锁内容、
// 不能发现运行时错误（曾因未序列化常量产生 ReferenceError 而三键整体缺失）。本文件用最小
// DOM 桩真实执行 titlebarScript 产物，锁定：mark 标记、band/三键结构、GET 状态查询，
// 以及 #121 的分平台差异——win32 不注入拖拽面（官方 caption 行接管）、linux 仍注入两段热区。
// 分平台拖拽面差异与 GET 状态查询兜底。
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

interface TitlebarRun {
  documentElement: StubNode
  head: StubNode
  styleText: string
  band: StubNode | undefined
  fetchCalls: Array<{ url: string; init?: RequestInit }>
  windowListeners: string[]
  documentListeners: Map<string, Array<() => void>>
}

/** 在最小 DOM 桩上真实执行注入脚本，返回可断言的产物。 */
function runTitlebarScript(platform: 'win32' | 'linux'): TitlebarRun {
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
    ;(0, eval)(titlebarScript(platform, 'test-token'))
  } finally {
    globals.document = saved.document
    globals.window = saved.window
    globals.fetch = saved.fetch
    delete globals.__DSH_SHELL_TITLEBAR__
  }

  return {
    documentElement,
    head,
    styleText: head.children[0]?.textContent ?? '',
    band: byId.get('dsh-shell-titlebar'),
    fetchCalls,
    windowListeners,
    documentListeners,
  }
}

describe('标题栏带脚本真实执行（#112/#121 回归护栏）', () => {
  test('win32：标记 + 三键，拖拽面交给官方 caption 行（壳不注入 drag div）', () => {
    const run = runTitlebarScript('win32')

    // mark：官方声明式标记与高度变量
    expect(run.documentElement.dataset.windowsTitlebar).toBe('')
    expect(run.documentElement.styleValues['--dsh-windows-titlebar-height']).toBe(`${WINDOWS_TITLEBAR_HEIGHT}px`)

    expect(run.head.children).toHaveLength(1)
    expect(run.styleText).toContain('#dsh-shell-titlebar{')
    // #121：注入样式里不再有任何拖拽热区规则（拖窗交给 `.frame::before` 的官方 drag）
    expect(run.styleText).not.toContain('#dsh-shell-titlebar-drag{')
    expect(run.styleText).not.toContain('#dsh-shell-titlebar-drag-main{')
    // 三键必须显式 no-drag：Electrobun 无 windowControlsOverlay，Electron 那套保护不存在
    expect(run.styleText).toContain(
      '#dsh-shell-titlebar-controls{position:absolute;top:0;right:0;bottom:0;display:flex;align-items:stretch;-webkit-app-region:no-drag}',
    )
    expect(run.styleText).toContain('cursor:default;pointer-events:auto;-webkit-app-region:no-drag}')

    // band 只剩三键容器一个子节点
    expect(run.band).toBeDefined()
    expect(run.band!.children).toHaveLength(1)
    expect(run.band!.children[0]!.id).toBe('dsh-shell-titlebar-controls')

    // 三键：动作、aria 与图标
    const buttons = run.band!.children[0]!.children
    expect(buttons.map((b) => b.getAttribute('data-action'))).toEqual(['minimize', 'toggle-maximize', 'close'])
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['最小化', '最大化', '关闭'])
    expect(buttons.every((b) => b.innerHTML.startsWith('<svg'))).toBe(true)

    // GET 状态查询（build 末尾一次），事件兜底挂载
    expect(run.fetchCalls).toHaveLength(1)
    expect(run.fetchCalls[0]!.url).toBe(TITLEBAR_WINDOW_ENDPOINT)
    expect(run.fetchCalls[0]!.init?.method).toBeUndefined()
    expect(run.windowListeners).toEqual(expect.arrayContaining(['resize', 'focus']))
    expect(run.documentListeners.has('visibilitychange')).toBe(true)
  })

  test('linux（CEF）：CEF 无 app-region，仍注入两段拖拽热区 + 双击最大化', () => {
    const run = runTitlebarScript('linux')

    expect(run.styleText).toContain('#dsh-shell-titlebar-drag{')
    expect(run.styleText).toContain('#dsh-shell-titlebar-drag-main{')
    expect(run.band).toBeDefined()
    expect(run.band!.children).toHaveLength(3)
    expect(run.band!.children[0]!.id).toBe('dsh-shell-titlebar-drag')
    expect(run.band!.children[0]!.className).toBe('electrobun-webkit-app-region-drag')
    expect(run.band!.children[1]!.id).toBe('dsh-shell-titlebar-drag-main')
    expect(run.band!.children[1]!.className).toBe('electrobun-webkit-app-region-drag')
    expect(run.band!.children[2]!.id).toBe('dsh-shell-titlebar-controls')
    // 双击拖拽段 = 最大化切换（CEF 侧没有原生 caption 的双击行为）
    expect(run.band!.children[0]!.listeners.get('dblclick')).toHaveLength(1)
    expect(run.band!.children[1]!.listeners.get('dblclick')).toHaveLength(1)
  })
})
