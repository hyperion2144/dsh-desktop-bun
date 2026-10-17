// #130 回归护栏：窗高是**页面量、页面报**的，而这段逻辑除了 `new Function` 语法检查之外，
// 以前没有任何真实执行覆盖——脚本里的 TDZ/hoisting 错、量错元素、报错值，文本断言一条都查不出
// （#112 的三键 ReferenceError 就是同类问题，门禁全绿带病上真机）。
//
// 这里用最小 DOM 桩真实跑一遍 updateNoticeHtml 生成的脚本，锁三件事：
//   1. 脚本能执行完（不是只编译）；
//   2. 开窗就报一次窗高，报的是 body 盒高（含 padding）；
//   3. 内容变化（MutationObserver 触发）再报一次，但同一个高度不重复发。
import { describe, expect, test } from 'bun:test'
import {
  UPDATE_NOTICE_RESIZE_METHOD,
  UPDATE_NOTICE_STATUS_METHOD,
  updateNoticeHtml,
  type UpdateNoticePayload,
} from '../src/bun/update-notice-dialog.ts'
import { evaluateRuntimeUpdates } from '../src/shared/runtime-update.ts'

class StubNode {
  readonly attributes = new Map<string, string>()
  readonly listeners: (() => void)[] = []
  readonly style: Record<string, string> = {}
  textContent = ''
  className = ''
  /** 盒高（`getBoundingClientRect` 的返回值）——测试按需改它。 */
  height = 0

  constructor(readonly id: string) {}

  setAttribute(key: string, value: string): void {
    this.attributes.set(key, value)
  }
  getAttribute(key: string): string | null {
    return this.attributes.get(key) ?? null
  }
  hasAttribute(key: string): boolean {
    return this.attributes.has(key)
  }
  removeAttribute(key: string): void {
    this.attributes.delete(key)
  }
  addEventListener(_type: string, listener: () => void): void {
    this.listeners.push(listener)
  }
  getBoundingClientRect(): { top: number; left: number; width: number; height: number } {
    return { top: 0, left: 0, width: 560, height: this.height }
  }
}

interface Harness {
  /** 页面发给壳的 RPC 请求（method + params 已经解包）。 */
  readonly sent: { method: string; params: unknown }[]
  /** 模拟内容变化（进度条出现、红字变多行）触发 MutationObserver 回调。 */
  fireMutation(): void
  /** 改内容高度（模拟「另有 …」换行把页脚顶下去）。 */
  setHeight(height: number): void
  /** 卸掉全局桩、清掉定时器。 */
  stop(): void
}

function payload(): UpdateNoticePayload {
  const report = evaluateRuntimeUpdates({
    running: '0.2.1-alpha.2',
    builtin: '0.2.1-alpha.2',
    catalog: [
      { version: '0.2.1-rc.2', channel: 'rc' },
      { version: '0.2.1-rc.1', channel: 'rc' },
    ],
    installed: [],
  })
  return { profile: 'desktop', baseline: '0.2.1-alpha.2', preference: null, runtime: report, shell: null }
}

/** 抽 `<script>` 主体（与 dialog 测试的切片口径一致）。 */
function scriptOf(html: string): string {
  const start = html.lastIndexOf('<script>')
  const end = html.lastIndexOf('</script>')
  return html.slice(start + '<script>'.length, end)
}

function run(html: string): Harness {
  const byId = new Map<string, StubNode>()
  for (const id of ['msg', 'dl', 'dlfill', 'dltxt']) byId.set(id, new StubNode(id))
  const body = new StubNode('body')
  body.height = 300
  // 脚本会给每个 `[data-op]` 挂点击监听：给两个按钮就够证明这条路径没被改坏。
  const actions = [new StubNode('later'), new StubNode('all')]
  for (const node of actions) node.setAttribute('data-op', JSON.stringify({ op: 'later' }))

  const sent: { method: string; params: unknown }[] = []
  const observers: (() => void)[] = []
  const timers: ReturnType<typeof setInterval>[] = []

  const doc = {
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelectorAll: (selector: string) => (selector === '[data-op]' ? actions : []),
    body,
  }

  // 桥要活到 harness.stop()：MutationObserver 回调里还会再发一次请求。
  const g = globalThis as Record<string, unknown>
  const previousBridge = g['__electrobunHostBridge']
  g['__electrobunHostBridge'] = {
    postMessage: (raw: string) => {
      const packet = JSON.parse(raw) as { method: string; params: unknown }
      sent.push({ method: packet.method, params: packet.params })
    },
  }

  class StubObserver {
    constructor(callback: () => void) {
      observers.push(callback)
    }
    observe(): void {}
  }

  // 真 setInterval 会把测试进程吊着：换成登记一下就返回。
  const fakeSetInterval = ((_fn: () => void) => {
    const handle = setInterval(() => {}, 1000)
    timers.push(handle)
    return handle
  }) as unknown as typeof setInterval

  const factory = new Function('document', 'MutationObserver', 'setInterval', 'window', scriptOf(html))
  factory(doc, StubObserver, fakeSetInterval, { close: () => {} })

  return {
    sent,
    fireMutation: () => {
      for (const callback of observers) callback()
    },
    setHeight: (height: number) => {
      body.height = height
    },
    stop: () => {
      for (const handle of timers) clearInterval(handle)
      g['__electrobunHostBridge'] = previousBridge
    },
  }
}

describe('更新提醒窗：页面自己量窗高（#130）', () => {
  test('脚本能真跑起来（不是只过语法检查）', () => {
    const harness = run(updateNoticeHtml(payload()))
    harness.stop()
  })

  test('开窗就报一次窗高，报的是 body 盒高', () => {
    const harness = run(updateNoticeHtml(payload()))
    try {
      const resize = harness.sent.filter((item) => item.method === UPDATE_NOTICE_RESIZE_METHOD)
      expect(resize).toHaveLength(1)
      expect(resize[0]?.params).toEqual({ height: 300 })
      // 同一次开窗里还会问一次下载状态（两个方法各走各的，不互相顶掉）。
      expect(harness.sent.some((item) => item.method === UPDATE_NOTICE_STATUS_METHOD)).toBe(true)
    } finally {
      harness.stop()
    }
  })

  test('内容变高再报一次，同一个高度不重复发', () => {
    const harness = run(updateNoticeHtml(payload()))
    try {
      // 内容没变：观察器回调不该再发一条。
      harness.fireMutation()
      expect(harness.sent.filter((item) => item.method === UPDATE_NOTICE_RESIZE_METHOD)).toHaveLength(1)
      // 内容变高（「另有 …」换成两行）：追加一条，且报的是新高度。
      harness.setHeight(438)
      harness.fireMutation()
      const resize = harness.sent.filter((item) => item.method === UPDATE_NOTICE_RESIZE_METHOD)
      expect(resize).toHaveLength(2)
      expect(resize[1]?.params).toEqual({ height: 438 })
    } finally {
      harness.stop()
    }
  })
})
