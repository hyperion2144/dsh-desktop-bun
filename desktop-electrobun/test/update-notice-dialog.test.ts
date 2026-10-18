import { describe, expect, test } from 'bun:test'
import {
  UPDATE_NOTICE_HEIGHT,
  UPDATE_NOTICE_BAND_TITLE,
  UPDATE_NOTICE_OP_METHOD,
  UPDATE_NOTICE_CLOSE_METHOD,
  UPDATE_NOTICE_STATUS_METHOD,
  UPDATE_NOTICE_MAX_HEIGHT,
  UPDATE_NOTICE_MIN_HEIGHT,
  UPDATE_NOTICE_RESIZE_METHOD,
  UPDATE_NOTICE_WIDTH,
  updateNoticeHtml,
  updateNoticeModel,
  updateNoticeOp,
  updateNoticeResizeHeight,
  type UpdateNoticePayload,
} from '../src/bun/update-notice-dialog.ts'
import { DIALOG_CLOSE_ATTR, DIALOG_TITLEBAR_CLASS } from '../src/bun/dialog-titlebar.ts'
import { evaluateRuntimeUpdates } from '../src/shared/runtime-update.ts'
import type { UpdateView } from '../src/shared/update.ts'

function shellView(overrides: Partial<UpdateView> = {}): UpdateView {
  return {
    available: true,
    reason: '',
    phase: 'available',
    label: '有新版本',
    status: 'idle',
    message: '',
    current: '0.2.9',
    latest: '0.3.0',
    channel: 'stable',
    baseUrl: 'https://example.invalid',
    feedUrl: 'https://example.invalid/feed.json',
    updateAvailable: true,
    updateReady: false,
    progress: null,
    bytesDownloaded: null,
    totalBytes: 77_000_000,
    error: '',
    at: 0,
    ...overrides,
  }
}

function runtimeReport(catalog: { version: string; channel: string }[] = [{ version: '0.2.2-alpha.1', channel: 'alpha' }]) {
  return evaluateRuntimeUpdates({
    running: '0.2.1-alpha.5',
    builtin: '0.2.1-alpha.5',
    catalog,
    installed: [],
  })
}

function payload(overrides: Partial<UpdateNoticePayload> = {}): UpdateNoticePayload {
  return {
    profile: 'desktop',
    baseline: '0.2.1-alpha.5',
    preference: '0.2.1-alpha.3',
    runtime: runtimeReport(),
    shell: shellView(),
    ...overrides,
  }
}

describe('updateNoticeModel：汇总头 + 双栏（B 变体）', () => {
  test('两段都有更新：标题按段数算，副行交代两段版本与合计体积', () => {
    const model = updateNoticeModel(payload())
    expect(model).not.toBeNull()
    expect(model!.title).toBe('2 项可用更新')
    expect(model!.subtitle).toBe('桌面壳 0.3.0 · DSH 运行时 0.2.2-alpha.1 · 73.4 MB')
  })

  test('自证行同时露出实际在跑的版本与设置里想要的版本', () => {
    const model = updateNoticeModel(payload())!
    expect(model.selfNote).toBe('实际在跑 0.2.1-alpha.5 · 设置里想要 0.2.1-alpha.3')
  })

  test('偏好与在跑一致时不重复说一遍', () => {
    const model = updateNoticeModel(payload({ preference: '0.2.1-alpha.5' }))!
    expect(model.selfNote).toBe('实际在跑 0.2.1-alpha.5')
    expect(model.selfNote).not.toContain('设置里想要')
  })

  test('只有一个 profile 时不提 profile 这回事，多 profile 时列出来', () => {
    expect(updateNoticeModel(payload())!.profileNote).toBe('')
    const model = updateNoticeModel(payload({ profiles: ['desktop', 'work'] }))!
    expect(model.profileNote).toBe('覆盖 2 个 profile：desktop、work')
  })

  test('只有壳有更新：单栏、标题算一段', () => {
    const model = updateNoticeModel(payload({ runtime: null }))!
    expect(model.title).toBe('1 项可用更新')
    expect(model.runtime).toBeNull()
    expect(model.shell!.version).toBe('0.3.0')
  })

  test('只有运行时有更新：单栏', () => {
    const model = updateNoticeModel(payload({ shell: null }))!
    expect(model.title).toBe('1 项可用更新')
    expect(model.shell).toBeNull()
    expect(model.runtime!.version).toBe('0.2.2-alpha.1')
  })

  test('都没更新 / 数据压根没拿到：一律返回 null（静默，不弹空窗）', () => {
    expect(updateNoticeModel(payload({ shell: null, runtime: null }))).toBeNull()
    const report = evaluateRuntimeUpdates({ running: '0.2.1-alpha.5', builtin: '0.2.1-alpha.5', catalog: [], installed: [] })
    expect(updateNoticeModel(payload({ shell: null, runtime: report }))).toBeNull()
    const blind = evaluateRuntimeUpdates({ running: null, builtin: null, catalog: [], installed: [] })
    expect(updateNoticeModel(payload({ shell: null, runtime: blind }))).toBeNull()
  })

  test('任一段有更新就提醒：壳无更新但运行时有，只剩一栏', () => {
    const model = updateNoticeModel(payload({ shell: shellView({ updateAvailable: false }) }))!
    expect(model.title).toBe('1 项可用更新')
    expect(model.shell).toBeNull()
    expect(model.runtime!.version).toBe('0.2.2-alpha.1')
    expect(model.ignoreTargets).toEqual([{ kind: 'runtime', version: '0.2.2-alpha.1' }])
  })

  test('运行时栏只让最高那条当主角，其余收成一行灰字并带来源标签', () => {
    const report = runtimeReport([
      { version: '0.2.2-alpha.1', channel: 'alpha' },
      { version: '0.2.1-alpha.6', channel: 'alpha' },
    ])
    const model = updateNoticeModel(payload({ shell: null, runtime: report }))!
    expect(model.runtime!.version).toBe('0.2.2-alpha.1')
    expect(model.runtime!.rest).toEqual(['0.2.1-alpha.6（未下载）'])
  })

  test('远端候选的按钮写「下载并切换」，已下载的写「切换到此版本」', () => {
    const remote = updateNoticeModel(payload({ shell: null }))!
    expect(remote.runtime!.action).toBe('download-and-switch')
    expect(remote.runtime!.actionLabel).toBe('下载并切换')
    const installed = evaluateRuntimeUpdates({
      running: '0.2.1-alpha.5',
      builtin: '0.2.1-alpha.5',
      catalog: [],
      installed: [{ version: '0.2.1-alpha.6', source: 'github', installed_at: 0 }],
    })
    const local = updateNoticeModel(payload({ shell: null, runtime: installed }))!
    expect(local.runtime!.action).toBe('switch')
    expect(local.runtime!.actionLabel).toBe('切换到此版本')
  })

  test('拉黑清单 = 两段展示的版本号（带路：同号的壳与运行时是两件事）', () => {
    expect(updateNoticeModel(payload())!.ignoreTargets).toEqual([
      { kind: 'shell', version: '0.3.0' },
      { kind: 'runtime', version: '0.2.2-alpha.1' },
    ])
    expect(updateNoticeModel(payload({ shell: null }))!.ignoreTargets).toEqual([{ kind: 'runtime', version: '0.2.2-alpha.1' }])
  })

  test('壳正在下载/检查时按钮禁用，副行换成当前相位', () => {
    const model = updateNoticeModel(payload({ shell: shellView({ phase: 'downloading', label: '正在下载…' }) }))!
    expect(model.shell!.disabled).toBe(true)
    expect(model.shell!.hint).toBe('正在下载…')
  })
})

describe('updateNoticeHtml：内嵌页面', () => {
  test('两段都在时用双栏栅格，按钮齐全', () => {
    const html = updateNoticeHtml(payload())
    expect(html).toContain('class="cols two"')
    expect(html).toContain('2 项可用更新')
    expect(html).toContain('下载更新')
    expect(html).toContain('全部更新')
    expect(html).toContain('稍后')
    expect(html).toContain('不再提示')
  })

  test('单段时不进双栏栅格', () => {
    expect(updateNoticeHtml(payload({ shell: null }))).toContain('class="cols"')
  })

  test('页脚自证行写明实际在跑的版本', () => {
    expect(updateNoticeHtml(payload())).toContain('实际在跑 0.2.1-alpha.5 · 设置里想要 0.2.1-alpha.3')
  })

  test('按钮带 data-op，动作走官方原生桥（不发 fetch：html 文档发不出同源请求）', () => {
    const html = updateNoticeHtml(payload())
    expect(html).toContain(`invokeShell(${JSON.stringify(UPDATE_NOTICE_OP_METHOD)}, op)`)
    expect(html).not.toContain('fetch(')
    expect(html).not.toContain('__shell__')
    expect(html).toContain('__electrobunHostBridge')
    expect(html).toContain('&quot;op&quot;:&quot;download-shell&quot;')
    expect(html).toContain('&quot;action&quot;:&quot;download-and-switch&quot;')
    expect(html).toContain(
      '&quot;targets&quot;:[{&quot;kind&quot;:&quot;shell&quot;,&quot;version&quot;:&quot;0.3.0&quot;},{&quot;kind&quot;:&quot;runtime&quot;,&quot;version&quot;:&quot;0.2.2-alpha.1&quot;}]',
    )
  })

  test('动作忙时锁住全部按钮，解锁时不误放壳段那个本来就置灰的', () => {
    const html = updateNoticeHtml(payload())
    expect(html).toContain('function setBusy(next)')
    // 锁之前先记住原状态，否则解锁会把壳段那个「下载中」的按钮放出来。
    expect(html).toContain("el.setAttribute('data-was-disabled'")
    expect(html).toContain("el.setAttribute('disabled', 'disabled')")
    expect(html).toContain('if (el.hasAttribute(\'disabled\')) return')
  })

  test('会拉包的动作盯进度条，开窗时已有下载在跑就先摆出来并锁按钮', () => {
    const html = updateNoticeHtml(payload())
    expect(html).toContain(`invokeShell(${JSON.stringify(UPDATE_NOTICE_STATUS_METHOD)}, null)`)
    expect(html).toContain('setInterval(pollStatus, 700)')
    expect(html).toContain('if (wantsDownload(op)) watchStatus()')
    expect(html).toContain("if (op.op === 'runtime') return op.action === 'download-and-switch'")
    expect(html).toContain('if (op.op === \'update-all\') return op.runtime !== undefined && op.runtime !== null')
    // 进度条容器只在运行时栏里，壳段那边不摆（壳更新的进度是另一个来源，见票面登记的缺口）。
    expect(html).toContain('id="dl"')
    expect(html).toContain('id="dlfill"')
    expect(html).toContain("document.getElementById('dlfill').style.width")
  })

  // #130 实机反馈：窗是固定 560×300 开的，而「另有 …」会随候选版本个数换行、页脚又多一行，
  // 条目一多就把页脚裁掉、还多一条滚动条。壳先开窗才知道渲染高，所以这项真的得页面量。
  test('窗高由页面量完报给壳：量 body 盒高、内容再变再报', () => {
    const html = updateNoticeHtml(payload())
    // 报的是 body 盒高（含 padding），不是 scrollHeight——后者被视口托底，永远看不出溢出。
    expect(html).toContain('document.body.getBoundingClientRect().height')
    expect(html).not.toContain('scrollHeight')
    expect(html).toContain(`invokeShell(${JSON.stringify(UPDATE_NOTICE_RESIZE_METHOD)}, { height: h })`)
    // 内容变了（进度条出现、红字变多行）要重新报一次，但同一个高度不重复发。
    expect(html).toContain('new MutationObserver(function () { fit() })')
    expect(html).toContain('if (h <= 0 || Math.abs(h - lastFit) < 2) return')
  })

  test('窗高夹在上下限里，不认的负载不猜', () => {
    expect(updateNoticeResizeHeight({ height: 412.4 })).toBe(412)
    expect(updateNoticeResizeHeight({ height: 20 })).toBe(UPDATE_NOTICE_MIN_HEIGHT)
    expect(updateNoticeResizeHeight({ height: 5000 })).toBe(UPDATE_NOTICE_MAX_HEIGHT)
    expect(updateNoticeResizeHeight({ height: Number.NaN })).toBeNull()
    expect(updateNoticeResizeHeight({ height: '412' })).toBeNull()
    expect(updateNoticeResizeHeight(null)).toBeNull()
    expect(updateNoticeResizeHeight(412)).toBeNull()
  })

  /** 抽页面脚本：断言函数体里的东西时用，免得每条都重写一遍切片。 */
  function scriptOf(html: string): string {
    const start = html.lastIndexOf('<script>')
    const end = html.lastIndexOf('</script>')
    return html.slice(start + '<script>'.length, end)
  }

  // 实机踩过的坑：页面脚本一旦被改坏（重复的函数定义），整段 script 直接语法报错，
  // 按钮监听器一个都没挂上——点「下载并切换」毫无反应。子串断言查不出来，得真的编译一遍。
  test('页面脚本能过语法检查', () => {
    const html = updateNoticeHtml(payload())
    const start = html.lastIndexOf('<script>')
    const end = html.lastIndexOf('</script>')
    expect(start).toBeGreaterThan(-1)

    expect(end).toBeGreaterThan(start)
    const source = html.slice(start + '<script>'.length, end)
    expect(() => new Function(source)).not.toThrow()
  })

  test('正文里的尖括号被转义，脚本注入不成立', () => {
    const html = updateNoticeHtml(payload({ profiles: ['<img src=x onerror=alert(1)>', 'work'] }))
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  test('没得提醒时给一页体面话兜底，不抛也不递归', () => {
    const html = updateNoticeHtml(payload({ shell: null, runtime: null }))
    expect(html).toContain('没有需要提醒的更新')
  })

  test('尺寸按 B 变体定死 560×300', () => {
    expect(UPDATE_NOTICE_WIDTH).toBe(560)
    expect(UPDATE_NOTICE_HEIGHT).toBe(300)
  })

  test('页脚两个按钮同高：上边距只许落在卡内按钮上', () => {
    const html = updateNoticeHtml(payload())
    // `.btn.primary` 上的 margin-top 会把页脚的「全部更新」顶下去 7px，真机截图抓过这个。
    expect(html).toContain('.col .btn { margin-top: 7px; }')
    expect(html).not.toMatch(/\.btn\.primary \{[^}]*margin-top/)
  })

  test('主题跟着 DSH：显式浅/暗写 data-theme，跟随系统交给媒体查询；两处页面都别把属性甩成正文', () => {
    expect(updateNoticeHtml(payload({ theme: 'light' }))).toContain('<html lang="zh-CN" data-theme="light">')
    expect(updateNoticeHtml(payload({ theme: 'dark' }))).toContain('<html lang="zh-CN" data-theme="dark">')
    expect(updateNoticeHtml(payload({ theme: 'system' }))).toContain('<html lang="zh-CN">')
    // 缺省（载荷没带 theme）跟产品的缺省一致：浅色。
    expect(updateNoticeHtml(payload())).toContain('<html lang="zh-CN" data-theme="light">')
  })

  test('样式表与主题块都在，标签配平（丢一个 </style> 整页就白屏，只靠眼睛看不出来）', () => {
    for (const html of [updateNoticeHtml(payload()), updateNoticeHtml(payload({ theme: 'dark' }))]) {
      expect((html.match(/<style[ >]/g) ?? []).length).toBe(1)
      expect((html.match(/<\/style>/g) ?? []).length).toBe(1)
      expect(html).toContain('@media (prefers-color-scheme: dark){:root:not([data-theme="light"])')
      expect(html).not.toContain(':root { color-scheme: dark; }')
    }
  })

  test('动作失败时进度条收回去，不留一条卡在 0% 的空进度', () => {
    const script = scriptOf(updateNoticeHtml(payload()))
    expect((script.match(/renderStatus\(null\)/g) ?? []).length).toBe(2)
  })

  // #160 实机：点「稍后」毫无反应。页面里的 window.close() 在 html: 文档里是空操作
  // （Chromium 忽略非脚本打开文档的 window.close），所以关窗必须请壳代劳。
  test('关窗一律请壳代劳：脚本里不许再出现 window.close()', () => {
    const script = scriptOf(updateNoticeHtml(payload()))
    expect(script).not.toContain('window.close(')
    expect(script).toContain(`invokeShell(${JSON.stringify(UPDATE_NOTICE_CLOSE_METHOD)}`)
    // 「稍后」与动作成功后的自动关窗都走 closeSelf，两条路都不自己关。
    expect(script).toContain("if (op.op === 'later') { window.__dshUpdateNoticeOp = op; closeSelf(); return }")
    expect(script).toContain('setTimeout(closeSelf, 350)')
  })
})

describe('updateNoticeOp：服务面入参校验', () => {
  test('五种动作照单认', () => {
    expect(updateNoticeOp({ op: 'download-shell' })).toEqual({ op: 'download-shell' })
    expect(updateNoticeOp({ op: 'update-all', shell: true })).toEqual({ op: 'update-all', shell: true })
    expect(updateNoticeOp({ op: 'later' })).toEqual({ op: 'later' })
    expect(updateNoticeOp({ op: 'ignore', targets: [{ kind: 'shell', version: '0.3.0' }] })).toEqual({
      op: 'ignore',
      targets: [{ kind: 'shell', version: '0.3.0' }],
    })
    expect(updateNoticeOp({ op: 'runtime', version: '0.2.2-alpha.1', action: 'download-and-switch' })).toEqual({
      op: 'runtime',
      version: '0.2.2-alpha.1',
      action: 'download-and-switch',
      source: 'github',
    })
  })

  test('update-all 带运行时目标：两段各带各的', () => {
    expect(
      updateNoticeOp({ op: 'update-all', shell: true, runtime: { version: '0.2.1-alpha.6', action: 'switch', source: 'npm' } }),
    ).toEqual({ op: 'update-all', shell: true, runtime: { version: '0.2.1-alpha.6', action: 'switch', source: 'npm' } })
    // 只有运行时时 shell 显式给 false；不给也认（默认不碰壳）
    expect(updateNoticeOp({ op: 'update-all' })).toEqual({ op: 'update-all', shell: false })
    expect(updateNoticeOp({ op: 'update-all', shell: 'yes' })).toEqual({ op: 'update-all', shell: false })
    // runtime 给了但形状不对 ⇒ 整个请求不认
    expect(updateNoticeOp({ op: 'update-all', shell: true, runtime: { version: '0.2.1-alpha.6' } })).toBeNull()
    expect(updateNoticeOp({ op: 'update-all', shell: true, runtime: 'yes' })).toBeNull()
  })

  test('ignore 去重去坏形状：坏项整个不认', () => {
    expect(
      updateNoticeOp({
        op: 'ignore',
        targets: [
          { kind: 'shell', version: '0.3.0' },
          { kind: 'shell', version: '0.3.0' },
          { kind: 'runtime', version: '0.2.2-alpha.1' },
        ],
      })
    ).toEqual({
      op: 'ignore',
      targets: [
        { kind: 'shell', version: '0.3.0' },
        { kind: 'runtime', version: '0.2.2-alpha.1' },
      ],
    })
    // 路不认识 / 版本号不是非空串 / 干脆不是对象 ⇒ 端点当外部输入，整个请求不认
    expect(updateNoticeOp({ op: 'ignore', targets: [{ kind: 'settings', version: '0.3.0' }] })).toBeNull()
    expect(updateNoticeOp({ op: 'ignore', targets: [{ kind: 'shell', version: '' }] })).toBeNull()
    expect(updateNoticeOp({ op: 'ignore', targets: ['0.3.0'] })).toBeNull()
    expect(updateNoticeOp({ op: 'ignore', targets: [] })).toBeNull()
    expect(updateNoticeOp({ op: 'ignore', targets: '0.3.0' })).toBeNull()
  })

  test('认不出来的形状一律 null（端点按普通外部输入对待）', () => {
    expect(updateNoticeOp({ op: 'runtime', action: 'switch' })).toBeNull()
    expect(updateNoticeOp(null)).toBeNull()
    expect(updateNoticeOp('download-shell')).toBeNull()
    expect(updateNoticeOp([{ op: 'later' }])).toBeNull()
    expect(updateNoticeOp({})).toBeNull()
    expect(updateNoticeOp({ op: 'rm-rf' })).toBeNull()
    expect(updateNoticeOp({ op: 'runtime', version: '', action: 'switch' })).toBeNull()
    expect(updateNoticeOp({ op: 'runtime', version: '0.2.2-alpha.1', action: 'nuke' })).toBeNull()
    expect(updateNoticeOp({ op: 'ignore' })).toBeNull()
    expect(updateNoticeOp({ op: 'ignore', versions: [] })).toBeNull()
    expect(updateNoticeOp({ op: 'ignore', versions: [1, 2] })).toBeNull()
  })
})

// #164：win32/linux 上 hiddenInset 没有原生控件，提醒窗自绘标题带（关窗键 + 拖拽面）；
// darwin 有系统红绿灯，一行不多。这条带上没有关闭键的话，win 上这张卡除了点按钮没别的出路。
describe('updateNoticeHtml 的标题带（#164）', () => {
  function scriptOf(html: string): string {
    const start = html.lastIndexOf('<script>')
    const end = html.lastIndexOf('</script>')
    return html.slice(start + '<script>'.length, end)
  }

  function markupOf(html: string): string {
    const start = html.lastIndexOf('<script>')
    if (start < 0) throw new Error('没找到 <script>')
    return html.slice(0, start)
  }

  test('darwin 不画带：没有带、没有留位 class、没有关闭键', () => {
    const markup = markupOf(updateNoticeHtml(payload({ platform: 'darwin' })))
    expect(markup).not.toContain('dlg-titlebar')
    expect(markup).not.toContain(DIALOG_TITLEBAR_CLASS)
    expect(markup).not.toContain(DIALOG_CLOSE_ATTR)
    expect(markup).toContain('<body>')
  })

  test('缺省（载荷没带 platform）按 darwin 算，不画带', () => {
    expect(markupOf(updateNoticeHtml(payload()))).not.toContain('dlg-titlebar')
  })

  test('win32 / linux 画带：留位 class + 关闭键 + 拖拽面 + 窗名', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const markup = markupOf(updateNoticeHtml(payload({ platform })))
      expect(markup).toContain(`<body class="${DIALOG_TITLEBAR_CLASS}">`)
      expect(markup).toContain('electrobun-webkit-app-region-drag')
      expect(markup).toContain(DIALOG_CLOSE_ATTR)
      expect(markup).toContain(UPDATE_NOTICE_BAND_TITLE)
      expect(markup).toContain('body { position: relative; }')
    }
  })

  test('关窗键与 ESC 都接 closeSelf（#160 的关窗通道，不新增机制）', () => {
    const script = scriptOf(updateNoticeHtml(payload({ platform: 'win32' })))
    expect(script).toContain(`document.querySelector('[${DIALOG_CLOSE_ATTR}]')`)
    expect(script).toContain('if (closeBtn) closeBtn.addEventListener(\'click\', closeSelf)')
    expect(script).toContain("if (event.key === 'Escape') closeSelf()")
  })
})
