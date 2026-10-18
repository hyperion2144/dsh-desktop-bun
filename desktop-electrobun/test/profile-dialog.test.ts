import { describe, expect, test } from 'bun:test'
import {
  PROFILE_OP_METHOD,
  PROFILE_CLOSE_METHOD,
  isSelfMigrate,
  isValidProfileName,
  profileDialogHtml,
  profileOpRequest,
} from '../src/bun/profile-dialog.ts'
import { DIALOG_CLOSE_ATTR, DIALOG_TITLEBAR_CLASS } from '../src/bun/dialog-titlebar.ts'

describe('isValidProfileName', () => {
  test('合法名', () => {
    expect(isValidProfileName('desktop')).toBe(true)
    expect(isValidProfileName('a')).toBe(true)
    expect(isValidProfileName('my-work-2')).toBe(true)
  })
  test('非法名', () => {
    expect(isValidProfileName('')).toBe(false)
    expect(isValidProfileName('-lead')).toBe(false)
    expect(isValidProfileName('Big')).toBe(false)
    expect(isValidProfileName('a/b')).toBe(false)
    expect(isValidProfileName('..')).toBe(false)
  })
})

describe('isSelfMigrate', () => {
  test('同名为真，空串不算', () => {
    expect(isSelfMigrate('desktop', 'desktop')).toBe(true)
    expect(isSelfMigrate('', '')).toBe(false)
    expect(isSelfMigrate('desktop', 'web')).toBe(false)
  })
})

describe('profileDialogHtml', () => {
  test('create：只有目标输入，动作走原生桥而不是 HTTP', () => {
    const html = profileDialogHtml('create', ['desktop'])
    expect(html).toContain("op: 'create'")
    expect(html).not.toContain('id="source"')
    expect(html).toContain(`"${PROFILE_OP_METHOD}"`)
    // #129：这扇窗是 html 文档，/__shell__/* 永远到不了壳——别再把它写回去
    expect(html).not.toContain('/__shell__/')
  })

  test('跟随产品主题：显式偏好写 data-theme，system 交给媒体查询', () => {
    expect(profileDialogHtml('create', [], 'dark')).toContain('data-theme="dark"')
    expect(profileDialogHtml('create', [], 'light')).toContain('data-theme="light"')
    // 缺省是浅色（产品在同样情况下也渲染浅色），所以缺省会钉 data-theme="light"；
    // 只有用户显式选了 system 才留空、交给 prefers-color-scheme。
    expect(profileDialogHtml('create', [])).toContain('<html lang="zh-CN" data-theme="light">')
    expect(profileDialogHtml('create', [], 'system')).toContain('<html lang="zh-CN">')
    // 旧版写死 `:root{color-scheme:dark}`（真机反馈：不跟主题）。注意不能拿
    // `color-scheme: dark` 带空格的写法当判据——色板块的媒体查询里就有它。
    expect(profileDialogHtml('create', [])).not.toContain('color-scheme:dark')
    // 断言“**定义**”而不只是名字：`var(--dsw-alias-bg-layer-1, #暗色)` 里也含这个名字，
    // 漏插 shellThemeStyle() 时旧断言照样绿——真机就是深色弹窗（变量全落到暗色兜底）。
    expect(profileDialogHtml('create', [])).toContain(':root{color-scheme:light dark;--dsw-alias-bg-layer-1:#ffffff')
    expect(profileDialogHtml('create', [])).toContain('@media (prefers-color-scheme: dark){:root:not([data-theme="light"])')
  })
  test('migrate：源下拉与覆盖确认，profile 名经转义', () => {
    const html = profileDialogHtml('migrate', ['desktop', '<x>"y"'])
    expect(html).toContain("op: 'migrate'")
    expect(html).toContain('id="source"')
    expect(html).toContain('id="overwrite"')
    expect(html).toContain('&lt;x&gt;&quot;y&quot;')
  })
  test('忙碌文案在服务端插值：create / migrate 各一句', () => {
    expect(scriptOf(profileDialogHtml('create', []))).toContain("'创建中…'")
    expect(scriptOf(profileDialogHtml('migrate', []))).toContain("'迁移中（复制依赖树，可能要一会儿）…'")
  })
})

/** 抽出内嵌 <script>：页面脚本对 tsc 与子串断言都是隐形的，必须真执行一次（#129）。 */
function scriptOf(html: string): string {
  const start = html.lastIndexOf('<script>')
  const end = html.lastIndexOf('</script>')
  if (start < 0 || end <= start) throw new Error('没找到 <script>')
  return html.slice(start + '<script>'.length, end)
}

/** 标记部分（<script> 之前）：标题带只在标记里，脚本里那条 querySelector 是平台无关的。 */
function markupOf(html: string): string {
  const start = html.lastIndexOf('<script>')
  if (start < 0) throw new Error('没找到 <script>')
  return html.slice(0, start)
}

/** 页面脚本通过原生桥发出去的一条请求。 */
interface SentRequest {
  type: string
  id: number
  method: string
  params: Record<string, unknown>
}

interface Harness {
  sent: SentRequest[]
  msg: { className: string; textContent: string }
  /** 触发 submit；返回 handler 的 promise（invokeShell 会挂着等回包） */
  submit(): Promise<void>
  /** 模拟壳回包给页面 */
  respond(id: number, packet: Record<string, unknown>): void
  /** 跑掉页面登记的定时器（成功后请壳关窗那一步就在 setTimeout 里） */
  runTimers(): void
  /** #164：标题带上的关闭键；darwin 页面没画带（无此键） */
  closeButton(): { click(): unknown } | undefined
  /** 敲一个键（目前只有 Esc 绑了行为） */
  pressKey(key: string): void
  dispose(): void
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 真跑一遍生成的页面脚本（#129 的回归防线）。
 *
 * 为什么不只是 `new Function(source)` 过一遍语法：`kind is not defined` 是**运行时**
 * ReferenceError，函数体不被调用就永远不抛——本票的 bug 正是那样漏过去的。
 */
function runScript(
  source: string,
  inputs: {
    target?: string
    source?: string
    overwrite?: boolean
    bridge?: boolean
    ids?: string[]
    /** #164：页面画了标题带（win32/linux）；默认 false = darwin（只有系统红绿灯） */
    titlebar?: boolean
  } = {},
): Harness {
  const sent: SentRequest[] = []
  const elements = new Map<string, any>()
  // 只实现这张表单真有那几个元素：create 页没有 source/overwrite，getElementById 得回 undefined。
  const allowed = new Set(['f', 'msg', ...(inputs.ids ?? ['target', 'source', 'overwrite'])])
  const elementOf = (id: string): any => {
    if (!allowed.has(id)) return undefined
    const cached = elements.get(id)
    if (cached !== undefined) return cached
    const created = {
      id,
      value: id === 'target' ? (inputs.target ?? 'demo-profile') : id === 'source' ? (inputs.source ?? 'desktop') : '',
      checked: inputs.overwrite === true,
      className: '',
      textContent: '',
      listeners: new Map<string, (event: unknown) => unknown>(),
      addEventListener(event: string, fn: (event: unknown) => unknown) {
        this.listeners.set(event, fn)
      },
    }
    elements.set(id, created)
    return created
  }
  const globals = globalThis as any
  const savedBridge = globals.__electrobunHostBridge
  const savedElectrobun = globals.__electrobun
  const channel: { receiveMessageFromHost: ((packet: any) => void) | null } = { receiveMessageFromHost: null }
  globals.__electrobunHostBridge =
    inputs.bridge === false
      ? undefined
      : {
          postMessage(raw: string) {
            sent.push(JSON.parse(raw) as SentRequest)
          },
        }
  globals.__electrobun = channel
  // 定时器收起来而不是丢掉：页面里 `setTimeout(closeSelf, 1200)` 是成功后关窗的那一步（#162），
  // 丢掉了等于这条路径一次都没跑过。
  const timers: (() => unknown)[] = []
  // #164：标题带的关闭键与页面级键盘监听（ESC）。harness 只认这一种选择器，别的一律抛。
  const closeEl = {
    listeners: new Map<string, (event: unknown) => unknown>(),
    addEventListener(event: string, fn: (event: unknown) => unknown) {
      this.listeners.set(event, fn)
    },
    click(): unknown {
      const fn = this.listeners.get('click')
      if (fn === undefined) throw new Error('关闭键没绑 click')
      return fn({})
    },
  }
  const keydown: ((event: { key: string }) => unknown)[] = []
  const documentStub = {
    getElementById: elementOf,
    querySelector(selector: string): typeof closeEl | null {
      if (selector !== `[${DIALOG_CLOSE_ATTR}]`) throw new Error(`harness 不认的选择器：${selector}`)
      return inputs.titlebar === true ? closeEl : null
    },
    addEventListener(event: string, fn: (event: unknown) => unknown) {
      if (event === 'keydown') keydown.push(fn as (event: { key: string }) => unknown)
    },
  }
  const run = new Function('document', 'window', 'setTimeout', source)
  run(
    documentStub,
    // window.close 在这种 html: 文档里是空操作（#160/#162），桩成抛错：谁把它写回去谁当场炸。
    {
      close() {
        throw new Error('页面不该自己关窗：请壳代劳（#162）')
      },
    },
    (fn: () => unknown) => {
      timers.push(fn)
      return timers.length
    },
  )
  const form = elementOf('f')
  return {
    sent,
    msg: elementOf('msg'),
    submit(): Promise<void> {
      const handler = form.listeners.get('submit')
      if (handler === undefined) return Promise.reject(new Error('submit 处理器没绑上'))
      return Promise.resolve(handler({ preventDefault() {} })) as Promise<void>
    },
    respond(id: number, packet: Record<string, unknown>): void {
      if (channel.receiveMessageFromHost === null) throw new Error('页面还没挂上接收口')
      channel.receiveMessageFromHost(packet as any)
    },
    runTimers(): void {
      for (const fn of timers.splice(0)) fn()
    },
    closeButton(): { click(): unknown } | undefined {
      return inputs.titlebar === true ? closeEl : undefined
    },
    pressKey(key: string): void {
      for (const fn of keydown) fn({ key })
    },
    dispose(): void {
      globals.__electrobunHostBridge = savedBridge
      globals.__electrobun = savedElectrobun
    },
  }
}

describe('profileDialogHtml 的页面脚本（#129 回归）', () => {
  test('生成的脚本里不出现服务端模板变量（裸引用会变成运行时 ReferenceError）', () => {
    for (const kind of ['create', 'migrate'] as const) {
      expect(scriptOf(profileDialogHtml(kind, ['desktop']))).not.toContain('kind')
    }
  })

  test('create：submit 经原生桥发 profile_op，回包落到提示区', async () => {
    const harness = runScript(scriptOf(profileDialogHtml('create', ['desktop'])), {
      target: 'demo-profile',
      ids: ['target'],
    })
    try {
      const pending = harness.submit()
      await flush()
      expect(harness.sent).toHaveLength(1)
      const request = harness.sent[0]
      if (request === undefined) throw new Error('页面没发出请求')
      expect(request.type).toBe('request')
      expect(request.method).toBe(PROFILE_OP_METHOD)
      expect(request.params).toEqual({ op: 'create', target: 'demo-profile', source: '', overwrite: false })
      expect(harness.msg.textContent).toBe('创建中…')

      harness.respond(request.id, {
        type: 'response',
        id: request.id,
        success: true,
        payload: { ok: true, message: 'profile demo-profile 已创建', profile: 'demo-profile' },
      })
      await pending
      expect(harness.msg.className).toBe('ok')
      expect(harness.msg.textContent).toBe('profile demo-profile 已创建')
    } finally {
      harness.dispose()
    }
  })

  // #162：成功后那一句 `setTimeout(() => window.close(), 1200)` 从来不生效（html: 文档里
  // window.close 是空操作）——动作跑完、窗却留在屏幕上像卡住。现在改请壳关窗。
  test('成功后请壳关窗，而不是页面自己 window.close()（#162）', async () => {
    const harness = runScript(scriptOf(profileDialogHtml('create', ['desktop'])), {
      target: 'demo-profile',
      ids: ['target'],
    })
    try {
      const pending = harness.submit()
      await flush()
      const request = harness.sent[0]
      if (request === undefined) throw new Error('页面没发出请求')
      harness.respond(request.id, {
        type: 'response',
        id: request.id,
        success: true,
        payload: { ok: true, message: 'profile demo-profile 已创建', profile: 'demo-profile' },
      })
      await pending
      // 关窗在定时器里：harness 把 window.close 桩成抛错，所以页面一旦自己关就当场炸。
      harness.runTimers()
      await flush()
      expect(harness.sent.map((row) => row.method)).toEqual([PROFILE_OP_METHOD, PROFILE_CLOSE_METHOD])
    } finally {
      harness.dispose()
    }
  })

  test('失败路径不关窗：用户还要留在窗里改名字重试（#162）', async () => {
    const harness = runScript(scriptOf(profileDialogHtml('create', ['desktop'])), {
      target: 'demo-profile',
      ids: ['target'],
    })
    try {
      const pending = harness.submit()
      await flush()
      const request = harness.sent[0]
      if (request === undefined) throw new Error('页面没发出请求')
      harness.respond(request.id, {
        type: 'response',
        id: request.id,
        success: true,
        payload: { ok: false, message: '名称已存在' },
      })
      await pending
      harness.runTimers()
      await flush()
      expect(harness.sent.map((row) => row.method)).toEqual([PROFILE_OP_METHOD])
    } finally {
      harness.dispose()
    }
  })

  test('migrate：源与覆盖开关一并带上，失败回包显示红字', async () => {
    const harness = runScript(scriptOf(profileDialogHtml('migrate', ['desktop'])), {
      target: 'web',
      source: 'desktop',
      overwrite: true,
    })
    try {
      const pending = harness.submit()
      await flush()
      const request = harness.sent[0]
      if (request === undefined) throw new Error('页面没发出请求')
      expect(request.params).toEqual({ op: 'migrate', target: 'web', source: 'desktop', overwrite: true })
      expect(harness.msg.textContent).toBe('迁移中（复制依赖树，可能要一会儿）…')

      harness.respond(request.id, {
        type: 'response',
        id: request.id,
        success: true,
        payload: { ok: false, message: '目标已存在' },
      })
      await pending
      expect(harness.msg.className).toBe('err')
      expect(harness.msg.textContent).toBe('目标已存在')
    } finally {
      harness.dispose()
    }
  })

  test('提交进行中再点一次，不会发出第二个请求', async () => {
    const harness = runScript(scriptOf(profileDialogHtml('create', [])), { ids: ['target'] })
    try {
      const first = harness.submit()
      const second = harness.submit()
      await flush()
      expect(harness.sent).toHaveLength(1)
      const request = harness.sent[0]
      if (request === undefined) throw new Error('页面没发出请求')
      harness.respond(request.id, {
        type: 'response',
        id: request.id,
        success: true,
        payload: { ok: true, message: '已创建' },
      })
      await Promise.all([first, second])
      expect(harness.msg.className).toBe('ok')
    } finally {
      harness.dispose()
    }
  })

  test('壳回 success:false 时也落到红字（不能只看 ok）', async () => {
    const harness = runScript(scriptOf(profileDialogHtml('create', ['desktop'])), { ids: ['target'] })
    try {
      const pending = harness.submit()
      await flush()
      const request = harness.sent[0]
      if (request === undefined) throw new Error('页面没发出请求')
      harness.respond(request.id, { type: 'response', id: request.id, success: false, error: 'profile 操作超时' })
      await pending
      expect(harness.msg.className).toBe('err')
      expect(harness.msg.textContent).toContain('profile 操作超时')
      expect(harness.sent).toHaveLength(1)
    } finally {
      harness.dispose()
    }
  })

  test('壳桥不可用：红字而不是静默', async () => {
    const harness = runScript(scriptOf(profileDialogHtml('create', ['desktop'])), { bridge: false, ids: ['target'] })
    try {
      await harness.submit()
      expect(harness.sent).toHaveLength(0)
      expect(harness.msg.className).toBe('err')
      expect(harness.msg.textContent).toContain('壳桥不可用')
    } finally {
      harness.dispose()
    }
  })

  test('反向：裸引用服务端变量会被这个 harness 当成失败拓出来', async () => {
    // 故意把 ReferenceError 放到 try 之外：证明 harness 真能接住，而不是空转。
    const broken = scriptOf(profileDialogHtml('create', ['desktop'])).replace(
      'event.preventDefault()',
      'event.preventDefault(); void kind',
    )
    expect(broken).toContain('void kind')
    const harness = runScript(broken, { ids: ['target'] })
    try {
      await expect(harness.submit()).rejects.toThrow(/kind is not defined/)
    } finally {
      harness.dispose()
    }
  })
})

describe('profileOpRequest（原生桥入参的形状门）', () => {
  test('create：只要 target 是字符串，不看 source / overwrite', () => {
    expect(profileOpRequest({ op: 'create', target: 'demo' })).toEqual({ op: 'create', target: 'demo' })
    expect(profileOpRequest({ op: 'create', target: 'demo', source: 'x', overwrite: true })).toEqual({
      op: 'create',
      target: 'demo',
    })
    expect(profileOpRequest({ op: 'create' })).toBeNull()
    expect(profileOpRequest({ op: 'create', target: 7 })).toBeNull()
  })
  test('migrate：必须有非空 source，overwrite 只认严格 true', () => {
    expect(profileOpRequest({ op: 'migrate', target: 'b', source: 'a' })).toEqual({
      op: 'migrate',
      target: 'b',
      source: 'a',
      overwrite: false,
    })
    expect(profileOpRequest({ op: 'migrate', target: 'b', source: 'a', overwrite: 'yes' })).toEqual({
      op: 'migrate',
      target: 'b',
      source: 'a',
      overwrite: false,
    })
    expect(profileOpRequest({ op: 'migrate', target: 'b', source: '' })).toBeNull()
    expect(profileOpRequest({ op: 'migrate', target: 'b' })).toBeNull()
  })
  test('认不出来的形状一律 null，不猜', () => {
    expect(profileOpRequest(null)).toBeNull()
    expect(profileOpRequest('create')).toBeNull()
    expect(profileOpRequest({ op: 'delete', target: 'x' })).toBeNull()
    expect(profileOpRequest({})).toBeNull()
  })
})

// #164：win32/linux 上 hiddenInset 没有原生控件，弹窗自绘一条标题带（关窗键 + 拖拽面）；
// darwin 有系统红绿灯，一行都不该多。mac 上没画带就意味着 #162 的成功关窗是唯一出路。
describe('profileDialogHtml 的标题带（#164）', () => {
  test('darwin 不画带：没有带、没有留位 class、标题照旧居中', () => {
    // 只查标记部分：脚本里那条 querySelector 是平台无关的（darwin 上查到 null，什么也不做）
    const markup = markupOf(profileDialogHtml('create', ['desktop'], 'dark', 'darwin'))
    expect(markup).not.toContain('dlg-titlebar')
    expect(markup).not.toContain(DIALOG_TITLEBAR_CLASS)
    expect(markup).not.toContain(DIALOG_CLOSE_ATTR)
    expect(markup).toContain('<body>')
  })

  test('win32 / linux 画带：body 留位 class + 关窗键 + 拖拽面', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const html = profileDialogHtml('migrate', ['desktop'], 'dark', platform)
      expect(html).toContain('<body class="dlg-with-titlebar">')
      expect(html).toContain('dlg-titlebar')
      expect(html).toContain(DIALOG_CLOSE_ATTR)
      expect(html).toContain('electrobun-webkit-app-region-drag')
      // 带上有标题，正文里那个 16px 大标题就不重复画（CSS 隐藏）
      expect(html).toContain('迁移 Profile')
      expect(html).toContain(`.${DIALOG_TITLEBAR_CLASS} .title { display: none; }`)
      expect(html).toContain(`${DIALOG_TITLEBAR_CLASS} { padding-top: 46px; }`)
    }
  })

  test('点关窗键 → 走 profile_close（页面自己关不掉自己）', () => {
    const html = profileDialogHtml('create', ['desktop'], 'dark', 'win32')
    const harness = runScript(scriptOf(html), { titlebar: true, ids: ['target'] })
    try {
      const button = harness.closeButton()
      if (button === undefined) throw new Error('标题带上没有关闭键')
      button.click()
      expect(harness.sent.map((row) => row.method)).toEqual([PROFILE_CLOSE_METHOD])
    } finally {
      harness.dispose()
    }
  })

  test('ESC 也关窗（win/linux 弹窗的惯例路径）', () => {
    const html = profileDialogHtml('create', ['desktop'], 'dark', 'win32')
    const harness = runScript(scriptOf(html), { titlebar: true, ids: ['target'] })
    try {
      harness.pressKey('Escape')
      expect(harness.sent.map((row) => row.method)).toEqual([PROFILE_CLOSE_METHOD])
      // 别的键不关窗：否则输入框里打字会直接把窗关了
      harness.sent.length = 0
      harness.pressKey('a')
      expect(harness.sent).toEqual([])
    } finally {
      harness.dispose()
    }
  })

  test('darwin 页面没有关闭键（关窗只由系统红绿灯与成功路径负责）', () => {
    const html = profileDialogHtml('create', ['desktop'], 'dark', 'darwin')
    const harness = runScript(scriptOf(html), { titlebar: false, ids: ['target'] })
    try {
      expect(harness.closeButton()).toBeUndefined()
    } finally {
      harness.dispose()
    }
  })
})
