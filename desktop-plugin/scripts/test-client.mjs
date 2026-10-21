/**
 * client 纯函数测试入口（node scripts/test-client.mjs）。
 * 用 esbuild 把 TS 纯函数模块转译到临时目录后动态 import 断言，
 * 不给 client 引入测试框架依赖。目前覆盖 download-intercept 的拦截判定、
 * platform-keyboard（#187）的绑定匹配 / keybindings 解析与编辑。
 */
import { build } from 'esbuild'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import assert from 'node:assert/strict'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tmp = join(root, '.test-tmp')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

await build({
  entryPoints: [join(root, 'src/client/bridge/download-intercept.ts')],
  outfile: join(tmp, 'download-intercept.mjs'),
  format: 'esm',
  platform: 'node',
  bundle: true,
  target: 'node20',
  logLevel: 'silent',
})

const { shouldIntercept, interceptKind, filenameFromAnchor } = await import(pathToFileURL(join(tmp, 'download-intercept.mjs')).href)

// ── interceptKind：blob:/data: 一律接管；http(s)/同源相对链接仅带 download 属性才接管 ──
assert.equal(interceptKind('blob:http://127.0.0.1:3080/uuid', true), 'blob', 'blob 链接拦截（页面分块交壳）')
assert.equal(interceptKind('data:text/plain;base64,SGk=', true), 'blob', 'data 链接拦截')
assert.equal(interceptKind('BLOB:https://h/x', true), 'blob', '协议前缀大小写不敏感')
assert.equal(
  interceptKind('http://127.0.0.1:3080/api/session.export?sessionId=s1', true),
  'url',
  'http 直链转交壳的下载管理器（新壳没有 wry 的 on_download）'
)
assert.equal(interceptKind('https://example.com/f.zip', true), 'url', 'https 直链同样转交')
assert.equal(interceptKind('/api/session.export', true), 'url', '同源相对链接也转交（解析到页面 origin）')
assert.equal(interceptKind('mailto:a@b.c', true), null, '其它协议不碰')
assert.equal(interceptKind('blob:http://h/x', false), null, '无 download 属性不拦（普通导航）')
assert.equal(interceptKind(null, true), null, '无 href 不拦')
assert.equal(interceptKind(null, false), null, '都缺不拦')
assert.equal(shouldIntercept('blob:x', true), true, 'shouldIntercept 缩略判定仍好用')
assert.equal(shouldIntercept('https://example.com/f.zip', true), true, 'http 直链现在也算接管')
assert.equal(shouldIntercept('https://example.com/f.zip', false), false, '无 download 属性不接管')

// ── filenameFromAnchor：download 属性优先，回退 URL 尾段 ──
assert.equal(filenameFromAnchor('report.zip', 'blob:http://h/uuid'), 'report.zip', 'download 属性优先')
assert.equal(filenameFromAnchor('  ', 'blob:http://h/uuid'), 'uuid', '空白属性回退 blob 尾段')
assert.equal(filenameFromAnchor(null, 'data:text/plain;base64,xx'), 'download', 'data URL 无路径段回退默认名')
assert.equal(filenameFromAnchor(null, 'blob:http://h/path/file.tar.gz'), 'file.tar.gz', 'URL 尾段含扩展名')
assert.equal(filenameFromAnchor('报告 v1.2.pdf', 'blob:x'), '报告 v1.2.pdf', '中文文件名保留')

// ── platform-keyboard（#187）：桌面档快捷键桥的纯函数 ──
await build({
  entryPoints: [join(root, 'src/client/bridge/platform-keyboard.ts')],
  outfile: join(tmp, 'platform-keyboard.mjs'),
  format: 'esm',
  platform: 'node',
  bundle: true,
  target: 'node20',
  logLevel: 'silent',
})

const kb = await import(pathToFileURL(join(tmp, 'platform-keyboard.mjs')).href)
const gesture = (over = {}) => ({
  code: 'Period',
  control: false,
  alt: false,
  shift: false,
  meta: false,
  repeat: false,
  ...over,
})
const bound = (binding, over = {}) => ({ id: 'x', binding, issue: null, conflicts: [], ...over })

// ── 修饰键判定 ──
assert.equal(kb.isModifierCode('MetaLeft'), true, 'MetaLeft 是修饰键')
assert.equal(kb.isModifierCode('ShiftRight'), true, 'ShiftRight 是修饰键')
assert.equal(kb.isModifierCode('KeyK'), false, '字母键不是修饰键')
assert.equal(kb.isModifierCode('Period'), false, 'Period 不是修饰键')
assert.deepEqual(
  kb.gestureModifiers(gesture({ shift: true, meta: true })),
  ['shift', 'meta'],
  '修饰键按 control/alt/shift/meta 排序',
)
assert.deepEqual(kb.gestureModifiers(gesture()), [], '无修饰键回空数组')

// ── 命中判定（与 dsh 的 bindingKey 等价：修饰键集合 + 键位集合）──
assert.equal(
  kb.matchBinding(bound({ code: 'Period', modifiers: ['meta', 'shift'] }), gesture({ shift: true, meta: true })),
  true,
  '修饰键与主键都吻合则命中',
)
assert.equal(
  kb.matchBinding(bound({ code: 'Period', modifiers: ['meta', 'shift'] }), gesture({ meta: true })),
  false,
  '少一个修饰键不命中',
)
assert.equal(
  kb.matchBinding(bound({ code: 'Period', modifiers: ['meta', 'shift'] }), gesture({ shift: true, meta: true, alt: true })),
  false,
  '多一个修饰键不命中（不做子集匹配）',
)
assert.equal(
  kb.matchBinding(bound({ code: 'Period', modifiers: ['meta', 'shift'] }), gesture({ code: 'Comma', shift: true, meta: true })),
  false,
  '主键不同不命中',
)
assert.equal(
  kb.matchBinding(bound(null), gesture({ shift: true, meta: true })),
  false,
  '无绑定不命中',
)
assert.equal(
  kb.matchBinding(bound({ code: 'Period', modifiers: ['meta'] }, { issue: 'reserved' }), gesture({ meta: true })),
  false,
  '带 issue 的绑定不命中（dsh 也会把它标成不可用）',
)
assert.equal(
  kb.matchBinding(bound({ code: 'Period', modifiers: ['meta'] }, { conflicts: ['other'] }), gesture({ meta: true })),
  false,
  '有冲突的绑定不命中',
)
assert.equal(
  kb.matchBinding(
    bound({ code: 'KeyK', secondCode: 'KeyS', modifiers: ['meta'] }),
    gesture({ code: 'KeyS', secondCode: 'KeyK', meta: true }),
  ),
  true,
  '双键组合与录入顺序无关',
)

// ── 可吞判定：裸键绝不吞（否则吃掉正常输入）──
assert.equal(kb.isConsumable(bound({ code: 'Period', modifiers: ['meta'] })), true, '带修饰键可吞')
assert.equal(kb.isConsumable(bound({ code: 'Period', modifiers: [] })), false, '裸键不可吞')
assert.equal(kb.isConsumable(bound(null)), false, '无绑定不可吞')

// ── catalog 匹配：取第一行「命中且可吞」──
const catalog = [
  bound({ code: 'Period', modifiers: ['meta'] }),
  { id: 'bare', binding: { code: 'Period', modifiers: [] }, issue: null, conflicts: [] },
  { id: 'second', binding: { code: 'KeyK', modifiers: ['meta'] }, issue: null, conflicts: [] },
]
assert.equal(kb.matchCatalog(catalog, gesture({ meta: true }))?.id, 'x', '命中第一行可吞的绑定')
assert.equal(kb.matchCatalog(catalog, gesture({ code: 'KeyK', meta: true }))?.id, 'second', '跳过不可吞的裸键行')
assert.equal(kb.matchCatalog(catalog, gesture({ code: 'KeyJ', meta: true })), undefined, '无命中回 undefined')

// ── keybindings 解析（契约对齐 dsh 的 parseShortcutDocument）──
assert.equal(kb.SHORTCUT_SCHEMA_VERSION, 2, '当前支持到 schemaVersion 2')
const empty = kb.parseShortcutDocument(null)
assert.equal(empty.status, 'ready', '文件不存在视为 ready')
assert.equal(empty.usingDefaults, true, '文件不存在时用默认绑定')
assert.deepEqual(empty.document, { schemaVersion: 1, profiles: {} }, '空文档形状')
assert.equal(kb.parseShortcutDocument('   ').usingDefaults, true, '空白内容视为未配置')
assert.equal(kb.parseShortcutDocument('not json').error, 'invalid', '坏 JSON 标 invalid')
assert.equal(kb.parseShortcutDocument('not json').status, 'unreadable', '坏 JSON 只读不覆盖')
assert.equal(kb.parseShortcutDocument('[1]').error, 'invalid', '数组不是合法文档')
assert.equal(kb.parseShortcutDocument('{"schemaVersion":0}').error, 'invalid', '版本号必须为正整数')
assert.equal(kb.parseShortcutDocument('{"schemaVersion":3,"profiles":{}}').error, 'future', '未来版本只读（老壳不写坏新文件）')
const parsed = kb.parseShortcutDocument(
  '{"schemaVersion":1,"profiles":{"web:macos":{"a.b":{"code":"KeyK","modifiers":["meta"]}}},"unknown":7}',
)
assert.equal(parsed.status, 'ready', '合法文档 ready')
assert.equal(parsed.usingDefaults, false, '有文件就不算默认')
assert.equal(parsed.document.unknown, 7, '未知顶层字段原样保留')
assert.equal(parsed.document.profiles['web:macos']['a.b'].code, 'KeyK', 'profile 表原样保留')

// ── 编辑应用 ──
const edited = kb.applyShortcutEdit(empty.document, { type: 'set', id: 'inspector.toggle', binding: { code: 'Period', modifiers: ['primary', 'shift', 'meta'] } }, 'desktop:macos')
assert.equal(edited.ok, true, 'set 成功')
assert.equal(edited.document.schemaVersion, 2, '编辑即升到 v2')
assert.deepEqual(
  edited.document.profiles['desktop:macos']['inspector.toggle'],
  { code: 'Period', modifiers: ['shift', 'meta'] },
  '只保留 dsh 认的修饰键（primary 展开后由页面侧给出 meta）',
)
assert.deepEqual(empty.document.profiles, {}, '编辑不改原对象（不可变）')
const reset = kb.applyShortcutEdit(edited.document, { type: 'reset', id: 'inspector.toggle' }, 'desktop:macos')
assert.equal(reset.ok, true, 'reset 成功')
assert.deepEqual(reset.document.profiles['desktop:macos'], {}, 'reset 删掉该条覆盖')
const resetAll = kb.applyShortcutEdit(edited.document, { type: 'reset-all' }, 'desktop:macos')
assert.deepEqual(resetAll.document.profiles['desktop:macos'], {}, 'reset-all 清空该 profile')
assert.equal(kb.applyShortcutEdit(edited.document, { type: 'set', id: '', binding: { code: 'KeyK', modifiers: ['meta'] } }, 'desktop:macos').ok, false, '空 id 拒绝')
assert.equal(kb.applyShortcutEdit(edited.document, { type: 'set', id: 'a', binding: { code: '', modifiers: [] } }, 'desktop:macos').ok, false, '空 code 拒绝')
assert.equal(kb.applyShortcutEdit(edited.document, { type: 'set', id: 'a', binding: null }, 'desktop:macos').ok, false, '非对象绑定拒绝')
assert.equal(kb.applyShortcutEdit(edited.document, { type: 'nope' }, 'desktop:macos').ok, false, '未知编辑类型拒绝')

// ── console-batch（#54）：页面 console 攒批上报 ──
await build({
  entryPoints: [join(root, 'src/client/shell/console-batch.ts')],
  outfile: join(tmp, 'console-batch.mjs'),
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { createConsoleBatch } = await import(pathToFileURL(join(tmp, 'console-batch.mjs')).href)

{
  // maxItems 触发：攒满即发、顺序保持；未满不发；手动 flush 立即发；空 flush 不发空批
  const sent = []
  const batch = createConsoleBatch({
    send: (items) => sent.push(items),
    maxItems: 3,
    flushMs: 3_600_000,
    schedule: () => () => {},
  })
  batch.push({ level: 'log', msg: '一', pageUrl: 'p' })
  batch.push({ level: 'error', msg: '二', pageUrl: 'p' })
  assert.equal(sent.length, 0, '未攒满不发')
  batch.push({ level: 'info', msg: '三', pageUrl: 'p' })
  assert.equal(sent.length, 1, '攒满 maxItems 即发')
  assert.deepEqual(
    sent[0].map((item) => item.msg),
    ['一', '二', '三'],
    '整批按 push 顺序',
  )
  batch.push({ level: 'warn', msg: '四', pageUrl: 'p' })
  batch.flush()
  assert.deepEqual(sent[1].map((item) => item.msg), ['四'], 'flush 立即发掉手头批次')
  batch.flush()
  assert.equal(sent.length, 2, '空批次不产生空上报')
}

{
  // 定时线触发：最老一条等满 flushMs 自动发
  const sent = []
  const batch = createConsoleBatch({ send: (items) => sent.push(items), flushMs: 20 })
  batch.push({ level: 'log', msg: '慢线', pageUrl: 'p' })
  assert.equal(sent.length, 0, '定时线未到不发')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(sent.length, 1, 'flushMs 到点自动发')
  assert.deepEqual(sent[0].map((item) => item.level), ['log'])
}

{
  // send 同步抛错：该批丢弃、后续批次不受影响（与旧「单条失败吞掉」同口径）
  const sent = []
  let boom = true
  const batch = createConsoleBatch({
    send: (items) => {
      if (boom) throw new Error('send 炸了')
      sent.push(items)
    },
    maxItems: 2,
    flushMs: 3_600_000,
    schedule: () => () => {},
  })
  batch.push({ level: 'log', msg: '会炸', pageUrl: 'p' })
  batch.push({ level: 'log', msg: '也炸', pageUrl: 'p' })
  boom = false
  batch.push({ level: 'log', msg: '好的', pageUrl: 'p' })
  batch.push({ level: 'log', msg: '也好', pageUrl: 'p' })
  assert.deepEqual(sent[0].map((item) => item.msg), ['好的', '也好'], 'send 抛错只丢该批')
}

// ── 壳 preload 注入的 dshDesktop 载体脚本（desktop-electrobun/src/bun/windows/carrier.ts，
// 旧壳 Rust 版 DESKTOP_CARRIER_INIT_SCRIPT 的等价物）：esbuild 转译后在最小 DOM 桩里
// 真跑一遍，锁住对外形状（幂等安装 / 惰性转发 / 轮询等待 / 平台标记）。
await build({
  entryPoints: [join(root, '../desktop-electrobun/src/bun/windows/carrier.ts')],
  outfile: join(tmp, 'carrier.mjs'),
  format: 'esm',
  platform: 'node',
  bundle: true,
  target: 'node20',
  logLevel: 'silent',
})

const { carrierScript } = await import(pathToFileURL(join(tmp, 'carrier.mjs')).href)
const carrierRaw = carrierScript('macos')
assert.ok(carrierRaw.includes('protocolVersion: 1'), '载体脚本带协议版本')

function runCarrier({ impl, timers = 'never' } = {}) {
  const sandbox = {
    document: { documentElement: { dataset: {} } },
    // 默认给一个「永不触发」的 setTimeout：桩里的轮询是一直等到实现出现为止的，
    // 测试不需要它真的推进（用真实定时器会让 node 空转 30s 才退出）。
    setTimeout: timers === 'live' ? setTimeout : () => 0,
    clearTimeout,
    console,
    __dshShellKeyboardImpl: impl?.keyboard,
    __dshShellBridgeImpl: impl?.browser,
  }
  createContext(sandbox)
  runInContext(carrierRaw, sandbox, { filename: 'desktop-carrier.js' })
  return sandbox
}

const carrier = runCarrier()
assert.equal(carrier.dshDesktop?.protocolVersion, 1, '壳内窗口安装 dshDesktop')
assert.equal(carrier.document.documentElement.dataset.platform, 'macos', '写入平台名标记（不是 darwin，不触碰 dsh 的 Electron 几何）')
for (const method of ['subscribe', 'closeWindow']) {
  assert.equal(typeof carrier.dshDesktop.keyboard[method], 'function', `暴露 DesktopKeyboardApi.${method}`)
}
for (const method of ['get', 'edit', 'subscribe', 'recording']) {
  assert.equal(typeof carrier.dshDesktop.shortcuts[method], 'function', `暴露 DesktopShortcutsApi.${method}`)
}
assert.equal(typeof carrier.dshDesktop.browser.acquire, 'function', 'browser.acquire 惰性转发')
assert.equal(typeof carrier.dshDesktop.browser.onOpenRequested('lease', () => {}), 'function', 'bridge 未就绪时 onOpenRequested 回 no-op')

// 幂等：已有载体的页面重复执行脚本不覆盖
const twice = runCarrier()
const firstCarrier = twice.dshDesktop
runInContext(carrierRaw, twice, { filename: 'desktop-carrier.js' })
assert.equal(twice.dshDesktop, firstCarrier, '重复执行不覆盖已有载体')

// 实现未就绪（client 插件还没装）：一切同步可调、不炸，get 仍返回 Promise
const earlyDisposer = carrier.dshDesktop.keyboard.subscribe(() => {})
assert.equal(typeof earlyDisposer, 'function', '实现未就绪时 subscribe 也同步返回 disposer')
assert.equal(typeof carrier.dshDesktop.shortcuts.get([]).then, 'function', '实现未就绪时 get 也返回 Promise（dsh 构造期直接取用）')
assert.equal(typeof carrier.dshDesktop.shortcuts.recording(true).then, 'function', 'recording 也返回 Promise')
earlyDisposer()

// 实现就绪（client 插件已装）：订阅挂到实现上、调用逐项转发
const seen = []
const ready = runCarrier({
  impl: {
    keyboard: {
      subscribeInput: (listener) => {
        seen.push(listener)
        return () => seen.push('off')
      },
      closeWindow: async (revision) => {
        seen.push(`close:${revision}`)
      },
      get: async (definitions) => `snapshot:${definitions.length}`,
      edit: async (edit, revision) => `edit:${edit.type}:${revision}`,
      subscribeConfig: () => () => {},
      recording: async () => {},
    },
    browser: { acquire: async (workspace) => `lease:${workspace}` },
  },
})
const forwardDisposer = ready.dshDesktop.keyboard.subscribe((input) => seen.push(`input:${input.code}`))
assert.equal(await ready.dshDesktop.browser.acquire('ws-1'), 'lease:ws-1', 'browser.acquire 仍惰性转发')
await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(typeof seen[0], 'function', 'subscribe 经微任务后挂到 subscribeInput 上')
seen[0]({ kind: 'keyboard', code: 'Period' })
assert.ok(seen.includes('input:Period'), '实现推来的原生输入原样送进监听器')
assert.equal(await ready.dshDesktop.shortcuts.get([1, 2, 3]), 'snapshot:3', 'shortcuts.get 转发到实现')
assert.equal(await ready.dshDesktop.shortcuts.edit({ type: 'reset-all' }, 'rev-1'), 'edit:reset-all:rev-1', 'shortcuts.edit 转发到实现')
await ready.dshDesktop.keyboard.closeWindow('rev-1')
assert.ok(seen.includes('close:rev-1'), 'closeWindow 转发到实现')
forwardDisposer()
assert.ok(seen.includes('off'), 'disposer 透传到实现的退订')

// 实现晚到（真实定时器）：轮询等到实现出现后把订阅补上
const late = runCarrier({ timers: 'live' })
const lateSeen = []
late.dshDesktop.keyboard.subscribe((input) => lateSeen.push(input.code))
await new Promise((resolve) => setTimeout(resolve, 250))
late.__dshShellKeyboardImpl = {
  subscribeInput: (listener) => {
    lateSeen.push('attached')
    late.__push = listener
    return () => {}
  },
}
await new Promise((resolve) => setTimeout(resolve, 250))
assert.ok(lateSeen.includes('attached'), '实现晚到时订阅自动补上（惰性轮询）')
late.__push({ code: 'KeyK' })
assert.ok(lateSeen.includes('KeyK'), '晚到的实现同样能把输入送进监听器')

// ── composer-input-guard（#188）：控制字符判定与取证串 ──
await build({
  entryPoints: [join(root, 'src/client/ui/composer-input-guard.ts')],
  outfile: join(tmp, 'composer-input-guard.mjs'),
  format: 'esm',
  platform: 'node',
  bundle: true,
  target: 'node20',
  logLevel: 'silent',
})

const guard = await import(pathToFileURL(join(tmp, 'composer-input-guard.mjs')).href)

assert.equal(guard.hasDisallowedControl(null), false, 'null 放行')
assert.equal(guard.hasDisallowedControl(''), false, '空串放行')
assert.equal(guard.hasDisallowedControl('普通文本 abc'), false, '常规文本放行')
assert.equal(guard.hasDisallowedControl('多行\n文本\t带制表\r'), false, '换行/制表/回车放行（多行 composer 正常输入）')
assert.equal(guard.hasDisallowedControl('🙂 emoji'), false, '增补平面字符（代理对）不误判')
assert.equal(guard.hasDisallowedControl('\u001d'), true, 'U+001D（本票的乱码字符）要拦')
assert.equal(guard.hasDisallowedControl('前面有字\u0000后面'), true, 'U+0000 要拦')
assert.equal(guard.hasDisallowedControl('a\u001bb'), true, 'U+001B（ESC）要拦')
assert.equal(guard.hasDisallowedControl('\u007f'), true, 'U+007F（DEL）要拦')
assert.equal(guard.describeControlChars('abc\u001d'), 'U+001D@3', '取证串带码点与下标')
assert.equal(guard.describeControlChars('a\u0000b\u007f'), 'U+0000@1,U+007F@3', '多个控制字符逐个列出')
assert.equal(guard.describeControlChars('普通文本'), '', '无控制字符时取证串为空')
assert.equal(guard.removeDisallowedControl('a\u001db\u0000'), 'ab', '删掉控制字符、保留其余')
assert.equal(guard.removeDisallowedControl('多行\n文本\t'), '多行\n文本\t', '换行/制表保留')
assert.equal(guard.removeDisallowedControl('🙂a'), '🙂a', '增补平面字符不被破坏')

// ── composer-input-guard 的三层网：最小 DOM 桩里真跑一遍（#188）──
// 桩里造事件与元素（跨 realm 的 instanceof 必须成立）；fire 按 DOM 语义在
// stopImmediatePropagation 处停下，用来证明拦截确实掉断了后续（Lexical）处理器。
const guardStub = `
const listeners = [];
const doc = {
  activeElement: null,
  documentElement: { marks: {}, hasAttribute(n) { return Boolean(this.marks[n]) } },
  addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: Boolean(capture) }) },
};
const document = doc;
class TestElement {
  constructor(tag) { this.tagName = tag; this.isContentEditable = false; this.childNodes = []; this.nodeType = 1; this.marks = {}; }
  closest(sel) { return this.marks[sel] ? this : null }
  appendChild(node) { this.childNodes.push(node); node.parentElement = this; node.parentNode = this; return node }
}
const HTMLElement = TestElement;
let observerCallback = null;
class MutationObserver { constructor(cb) { observerCallback = cb } observe() {} }
const makeText = (data, parent) => { const node = { nodeType: 3, data, parentElement: parent, parentNode: parent }; if (parent) parent.childNodes.push(node); return node };
const fire = (type, event) => { for (const l of listeners) { if (l.type !== type) continue; l.fn(event); if (event.__immediateStopped) break } };
globalThis.__guardTest = { install: installComposerInputGuard, doc, TestElement, makeText, fire, observed: () => observerCallback, listeners: () => listeners.length };
`
const guardSource = readFileSync(join(tmp, 'composer-input-guard.mjs'), 'utf8')
  .replace(/^export \{[^}]*\};?$/m, '')
assert.ok(!guardSource.includes('export '), '转译产物里的 export 已剥掉（vm 里当脚本跑）')
const guardLogs = []
const guardSandbox = {
  console: { info: (...args) => guardLogs.push(args.join(' ')), debug: (...args) => guardLogs.push(args.join(' ')) },
  setTimeout,
  clearTimeout,
}
createContext(guardSandbox)
runInContext(guardStub + guardSource, guardSandbox, { filename: 'composer-input-guard.js' })
const gt = guardSandbox.__guardTest
gt.install()
const guardListeners = gt.listeners()
gt.install()
assert.equal(gt.listeners(), guardListeners, '重复安装幂等')

const composer = new gt.TestElement('DIV')
composer.isContentEditable = true
composer.marks['[data-composer-composing]'] = true
const mkEvent = (extra = {}) => ({
  target: composer,
  type: 'beforeinput',
  data: null,
  inputType: 'insertText',
  isComposing: false,
  defaultPrevented: false,
  __immediateStopped: false,
  stopped: false,
  preventDefault() { this.defaultPrevented = true },
  stopPropagation() { this.stopped = true },
  stopImmediatePropagation() { this.stopped = true; this.__immediateStopped = true },
  ...extra,
})

// 第 1 层：控制字符被拦，且事件不再往后传（Lexical 的 beforeinput 收不到）
let lexicalRuns = 0
gt.doc.addEventListener('beforeinput', () => { lexicalRuns += 1 }, true)
const blocked = mkEvent({ data: '\u001d' })
gt.fire('beforeinput', blocked)
assert.equal(blocked.defaultPrevented, true, 'U+001D 的 beforeinput 被 preventDefault')
assert.equal(blocked.__immediateStopped, true, '掉断传播：后续处理器不会收到这个事件')
assert.equal(lexicalRuns, 0, '后续（Lexical 式）处理器确实没跑')
assert.ok(guardLogs.some((l) => l.includes('blocked') && l.includes('U+001D')), '拦下时留证据（码点 + 调用栈）')

// 正常输入不能受限
const passing = mkEvent({ data: '你好' })
gt.fire('beforeinput', passing)
assert.equal(passing.defaultPrevented, false, '正常文本不拦')
assert.equal(lexicalRuns, 1, '正常输入照常传给后续处理器')

// 第 2 层：已经进 DOM 的，从文本节点里擦掉
const stuck = gt.makeText('前\u001d后', composer)
gt.fire('input', mkEvent({ type: 'input' }))
assert.equal(stuck.data, '前后', '已进 DOM 的控制字符被擦掉')
assert.ok(guardLogs.some((l) => l.includes('sanitized') && l.includes('via":"input')), '擦除也留证据')

// 第 3 层：输入法直接写 DOM（不发 input）时的 MutationObserver 兜底
const viaMutation = gt.makeText('a\u0007b', composer)
gt.observed()([{ type: 'characterData', target: viaMutation }])
assert.equal(viaMutation.data, 'ab', 'MutationObserver 兜底同样擦掉')

// 普通 input/textarea 走 value 分支
const area = new gt.TestElement('TEXTAREA')
area.value = 'x\u001dy'
gt.fire('input', mkEvent({ target: area, type: 'input' }))
assert.equal(area.value, 'xy', '输入框 value 里的控制字符也被擦掉')




// ── shell-rpc（#50）：统一传输层，三通道选择 / wire 协议 / 超时 ──
await build({
  entryPoints: [join(root, 'src/client/shell/shell-rpc.ts')],
  outfile: join(tmp, 'shell-rpc.mjs'),
  format: 'esm',
  platform: 'node',
  bundle: true,
  target: 'node20',
  logLevel: 'silent',
})
const { createShellRpc } = await import(pathToFileURL(join(tmp, 'shell-rpc.mjs')).href)

// 官方桥：捕获 postMessage 包形，回包经 receiveMessageFromHost 注入
{
  const sent = []
  const globals = {
    __electrobunHostBridge: { postMessage: (raw) => { sent.push(JSON.parse(raw)) } },
    __electrobun: {},
  }
  const timers = []
  const rpc = createShellRpc({
    readGlobals: () => globals,
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeoutImpl: () => {},
  })
  const p = rpc.invoke('echo', { a: 1 })
  assert.equal(sent.length, 1, '官方通道：请求经 __electrobunHostBridge.postMessage 发出')
  assert.deepEqual(sent[0], { type: 'request', id: 1, method: 'echo', params: { a: 1 } }, '包形对齐官方 wire 协议')
  globals.__electrobun.receiveMessageFromHost({ type: 'response', id: 1, success: true, payload: 'ok-echo' })
  assert.equal(await p, 'ok-echo', '成功响应 resolve value')

  const p2 = rpc.invoke('boom')
  globals.__electrobun.receiveMessageFromHost({ type: 'response', id: 2, success: false, error: '炸了' })
  await assert.rejects(p2, /炸了/, '业务失败 reject Error(error)')

  const p3 = rpc.invoke('slow', {}, { timeoutMs: 50 })
  timers[timers.length - 1].fn()
  await assert.rejects(p3, /timed out/, '超时 reject，对齐官方默认语义')

  assert.equal(rpc.available(), true, '有官方桥时 available()')
}

// 先期积压回包：接管接收面时排空（对齐官方 Electroview.init）
{
  const globals = {
    __electrobunHostBridge: { postMessage: () => {} },
    __electrobun: {},
    __electrobunPendingHostMessages: [{ type: 'response', id: 9, success: true, payload: 'early' }],
  }
  const rpc = createShellRpc({ readGlobals: () => globals, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} })
  void rpc.invoke('x')
  assert.deepEqual(globals.__electrobunPendingHostMessages, [], '接管后积压已排空')
}

// #128：壳 preload 装的官方 RPC 分发器（与 preload.ts 同形）。桩里造一个同构的：
// 自己发 id、自己占接收面、自己排 pending——插件在场时官方通道**整体**委托给它。
const withPreloadDispatcher = () => {
  const sent = []
  const pending = new Map()
  let nextId = 0
  const globals = { __electrobunHostBridge: { postMessage: (raw) => sent.push(JSON.parse(raw)) }, __electrobun: {} }
  const invoke = (method, params) =>
    new Promise((resolve, reject) => {
      nextId += 1
      pending.set(nextId, { resolve, reject })
      globals.__electrobunHostBridge.postMessage(JSON.stringify({ type: 'request', id: nextId, method, params }))
    })
  globals.__DSH_SHELL_RPC__ = { invoke, request: invoke }
  globals.__electrobun.receiveMessageFromHost = (packet) => {
    const waiter = pending.get(packet.id)
    if (waiter === undefined) return
    pending.delete(packet.id)
    if (packet.success === true) waiter.resolve(packet.payload)
    else waiter.reject(new Error(String(packet.error)))
  }
  return { globals, sent }
}

// 插件把整条官方通道委托给 preload 分发器，且不碰 receiveMessageFromHost
{
  const { globals, sent } = withPreloadDispatcher()
  const before = globals.__electrobun.receiveMessageFromHost
  const rpc = createShellRpc({ readGlobals: () => globals, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} })
  const p = rpc.invoke('get_desktop_client_environment', { a: 1 })
  assert.equal(sent.length, 1, '只发一个请求（插件没另起一套）')
  assert.equal(sent[0].method, 'get_desktop_client_environment', '方法名原样上送')
  assert.deepEqual(sent[0].params, { a: 1 }, '参数原样上送')
  assert.equal(rpc.available(), true, '有 preload 分发器时 available()')
  assert.equal(globals.__electrobun.receiveMessageFromHost, before, '插件不覆盖 receiveMessageFromHost（覆盖了 preload 的在途回包就没人接）')
  assert.equal(rpc.onMessage, undefined, 'onMessage 已随 #128 删除（页面侧无生产订阅者）')
  globals.__electrobun.receiveMessageFromHost({ type: 'response', id: sent[0].id, success: true, payload: 'env' })
  assert.equal(await p, 'env', '回包经 preload 分发器归位，resolve value')
}

// 注入脚本与插件同时在飞：共用一个 id 空间，回包乱序抵达也不串台
{
  const { globals, sent } = withPreloadDispatcher()
  const rpc = createShellRpc({ readGlobals: () => globals, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} })
  const fromPlugin = rpc.invoke('plugin_cmd')
  const fromInjected = globals.__DSH_SHELL_RPC__.invoke('shell_cmd')
  assert.deepEqual(
    sent.map((packet) => [packet.id, packet.method]),
    [
      [1, 'plugin_cmd'],
      [2, 'shell_cmd'],
    ],
    '两条共用一个 id 空间（各发一个 id=1 的话壳侧按 id 存表会丢一份回包）',
  )
  // 回包倒序抵达：谁等 id 谁拿自己的
  globals.__electrobun.receiveMessageFromHost({ type: 'response', id: 2, success: true, payload: 'shell' })
  globals.__electrobun.receiveMessageFromHost({ type: 'response', id: 1, success: true, payload: 'plugin' })
  assert.equal(await fromPlugin, 'plugin', '插件那条拿到自己的回包')
  assert.equal(await fromInjected, 'shell', '注入脚本那条拿到自己的回包')
}

// 中继通道（mobile-access 远程页）
{
  const globals = { __DSH_SHELL_RELAY__: { invoke: async (cmd, args) => ({ cmd, args }) } }
  const rpc = createShellRpc({ readGlobals: () => globals })
  assert.deepEqual(await rpc.invoke('get_notifications_state', { x: 1 }), { cmd: 'get_notifications_state', args: { x: 1 } }, '有中继无桥时走中继')
}

// #128：同源 fetch 兑底整条删除——只剩每视图 token 不再算「可用通道」，而且一个 fetch 都不打
{
  let fetchCalls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = () => {
    fetchCalls += 1
    return Promise.resolve(new Response('{}'))
  }
  try {
    const globals = { __DSH_SHELL_VIEW_TOKEN__: 'tok-1' }
    const rpc = createShellRpc({ readGlobals: () => globals })
    assert.equal(rpc.available(), false, '只有视图 token 时 available() 为 false（fetch 兑底已删）')
    await assert.rejects(rpc.invoke('get_dsh_status'), /shell rpc unavailable/, '不再有第三条通道可走')
    assert.equal(fetchCalls, 0, '同源 fetch 兑底分支已删（不再 POST /__shell__/rpc）')
  } finally {
    globalThis.fetch = realFetch
  }
}
// 无任何通道：available false + invoke reject
{
  const rpc = createShellRpc({ readGlobals: () => ({}) })
  assert.equal(rpc.available(), false)
  await assert.rejects(rpc.invoke('x'), /shell rpc unavailable/)
}

// 官方通道失败不重试、也不打 fetch（命令可能已生效，toggle 二次执行会翻转两次）
{
  let fetchCalls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (...args) => {
    fetchCalls += 1
    return realFetch(...args)
  }
  try {
    const globals = { __electrobunHostBridge: { postMessage: () => {} }, __electrobun: {} }
    const rpc = createShellRpc({
      readGlobals: () => globals,
      setTimeoutImpl: (fn) => {
        fn()
        return 1
      },
      clearTimeoutImpl: () => {},
    })
    await assert.rejects(rpc.invoke('x'), /timed out/)
    assert.equal(fetchCalls, 0, '官方通道超时后不打 fetch')
  } finally {
    globalThis.fetch = realFetch
  }
}


// ── devtools-toggle（#69）：开发者工具开关的状态机与安全面文案 ──
await build({
  entryPoints: [join(root, 'src/client/shell/devtools-toggle.ts')],
  outfile: join(tmp, 'devtools-toggle.mjs'),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const dt = await import(pathToFileURL(join(tmp, 'devtools-toggle.mjs')).href)

// 状态机：同值不动；两个方向的变更都先弹确认，确认才写入并重启
assert.equal(dt.planDevToolsUi(false, false).action, 'idle', '关→关不动')
assert.equal(dt.planDevToolsUi(true, true).action, 'idle', '开→开不动')
assert.equal(dt.planDevToolsUi(false, true).action, 'confirm-on', '关→开先弹安全确认（取消不写入）')
assert.equal(dt.planDevToolsUi(true, false).action, 'confirm-off', '开→关也弹确认（重启不静默）')

// 关闭确认文案：点明重启与中断
const dtOffCopy = dt.devToolsDisableCopy()
assert.ok(dtOffCopy.title.includes('关闭'), '关闭弹窗标题点名关闭')
assert.ok(dtOffCopy.confirm.includes('重启'), '关闭确认动作带重启语义')
assert.ok(dtOffCopy.lines.some((l) => l.includes('中断')), '关闭文案提示页面会短暂中断')
assert.equal(dtOffCopy.cancel, '取消', '取消不写入')

// 确认弹窗文案：说清口开在哪、谁能用、能造成什么
const dtCopy = dt.devToolsConfirmCopy()
assert.ok(dtCopy.title.includes('开发者工具'), '标题点名功能')
assert.ok(dtCopy.lines.some((l) => l.includes('回环')), '文案说明口在回环地址')
assert.ok(dtCopy.lines.some((l) => l.includes('任意') && l.includes('代码')), '文案点破本机任意程序可执行代码')
assert.ok(dtCopy.lines.some((l) => l.includes('凭据')), '文案点破会话内容含凭据')
assert.ok(dtCopy.confirm.includes('重启'), '确认动作带重启语义')
assert.equal(dtCopy.cancel, '取消', '取消不写入')

// 保存后提示：#119 区分「真的重启了」与「没重启成」——后者不得预支「正在重启」
assert.ok(dt.devToolsSavedNote(true).includes('重启'), '开启提示含重启')
assert.ok(dt.devToolsSavedNote(false).includes('重启'), '关闭提示含重启')
assert.ok(dt.devToolsSavedNote(true).includes('正在重启'), '未收到回包时沿用「正在重启」文案')
assert.ok(dt.devToolsSavedNote(true, { ok: true }).includes('正在重启'), '重启成功同文案')
const dtFailNote = dt.devToolsSavedNote(true, { ok: false, reason: 'dev-build', message: '开发构建不支持自动重启' })
assert.ok(!dtFailNote.includes('正在重启'), '没重启成就不许说「正在重启」（#119：禁止假装重启成功）')
assert.ok(dtFailNote.includes('设置已保存'), '失败文案先说设置存下来了')
assert.ok(dtFailNote.includes('手动重启'), '失败文案给出补救路径')
assert.ok(dtFailNote.includes('开发构建不支持自动重启'), '壳给的原因原样透出，不被吃掉')
assert.ok(
  dt.devToolsSavedNote(false, { ok: false, reason: 'spawn-failed' }).includes('spawn-failed'),
  '只有 reason 没有 message 时也把 reason 说出来',
)
assert.ok(
  dt.devToolsSavedNote(true, { ok: false }).includes('未知原因'),
  '回包既没 message 也没 reason 时有兜底说法，不出「undefined」',
)

// ── runtime-download-ui（#97）：下载终态判定 / 取消 / 「当前使用」归一 ──
await build({
  entryPoints: [join(root, 'src/client/features/runtime-download-ui.ts')],
  outfile: join(tmp, 'runtime-download-ui.mjs'),
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const rdu = await import(pathToFileURL(join(tmp, 'runtime-download-ui.mjs')).href)

{
  const idle = { active: false, version: '', resolved: 0, downloaded: 0, added: 0, error: '', cancelled: false }

  // 进行中：进度必须有数字、这一格只能是「下载中」，且不弹 toast
  const running = rdu.decideRuntimeDownload(
    { ...idle, active: true, version: '0.2.1-alpha.3', resolved: 624, downloaded: 335, added: 320 },
    true,
  )
  assert.deepEqual(running.progress, { version: '0.2.1-alpha.3', resolved: 624, downloaded: 335, added: 320 })
  assert.deepEqual(running.entry, { version: '0.2.1-alpha.3', value: 'downloading' })
  assert.equal(running.toast, null)

  // #97 症状②：超时弹窗一关就再没人动进度。不再 active 的一拍必须把进度条撤掉
  const done = rdu.decideRuntimeDownload({ ...idle, version: '0.2.1-alpha.3' }, true)
  assert.equal(done.progress, null, '非进行中一律撤进度条（进度条不再永久定格）')
  assert.deepEqual(done.entry, { version: '0.2.1-alpha.3', remove: true })
  assert.equal(done.toast.tone, 'ok')

  // 取消是独立终态：中性提示、无 error 文案，且不被当成失败
  const cancelled = rdu.decideRuntimeDownload({ ...idle, version: '0.2.1-alpha.3', cancelled: true }, true)
  assert.deepEqual(cancelled.entry, { version: '0.2.1-alpha.3', value: { cancelled: true } })
  assert.equal(cancelled.toast.tone, 'info', '取消走中性提示，不报错色')
  assert.ok(cancelled.toast.text.includes('已取消'))
  assert.equal(cancelled.progress, null)

  // 失败仍带原因（#95 的老口径不许退化）
  const failed = rdu.decideRuntimeDownload(
    { ...idle, version: '0.2.1-alpha.3', error: '下载失败：ERR_PNPM_NO_MATCHING_VERSION' },
    true,
  )
  assert.deepEqual(failed.entry, {
    version: '0.2.1-alpha.3',
    value: { failed: 'ERR_PNPM_NO_MATCHING_VERSION' },
  })
  assert.equal(failed.toast.tone, 'error')
  assert.ok(!failed.toast.text.includes('下载失败：下载失败'), '错误前缀只剥一层')

  // 面板重开（sawActive=false）：终态照样写回去，但不弹 toast
  const reopened = rdu.decideRuntimeDownload({ ...idle, version: '0.2.1-alpha.3', cancelled: true }, false)
  assert.deepEqual(reopened.entry, { version: '0.2.1-alpha.3', value: { cancelled: true } })
  assert.equal(reopened.toast, null, '重开面板不重复弹终态提示')

  // 彻底空闲（连版本号都没有）不动任何状态
  assert.deepEqual(rdu.decideRuntimeDownload(idle, true), { progress: null, entry: null, toast: null })

  // 终态同值不重写（否则每 600ms 一拍把失败原因刷掉）
  assert.equal(rdu.sameDownloadEntry({ failed: 'x' }, { failed: 'x' }), true)
  assert.equal(rdu.sameDownloadEntry({ failed: 'x' }, { failed: 'y' }), false)
  assert.equal(rdu.sameDownloadEntry({ cancelled: true }, { cancelled: true }), true)
  assert.equal(rdu.sameDownloadEntry('downloading', 'downloading'), true)
  assert.equal(rdu.sameDownloadEntry(undefined, 'downloading'), false)

  // #97 症状④：钉了 .2、实际回退到 .1 时，「当前使用」必须说 .1（真在跑的那棵）
  const line = rdu.currentRuntimeLine({
    selected: '0.2.1-alpha.2',
    builtin: '0.2.1-alpha.2',
    running: { kind: 'installed', version: '0.2.1-alpha.1' },
  })
  assert.ok(line.includes('0.2.1-alpha.1'), '顶行报实际在跑的版本')
  assert.ok(line.includes('已选择 0.2.1-alpha.2'), '钉的号与实际不一致时如实说明')

  // 内置正在跑：不带「运行时」字样，带兜底语义
  assert.equal(
    rdu.currentRuntimeLine({ builtin: '0.2.1-alpha.2', running: { kind: 'builtin', version: '0.2.1-alpha.2' } }),
    '当前使用：内置 dsh 0.2.1-alpha.2（兜底）',
  )

  // #97 症状⑤：内置行与运行行不得同时标「使用中」
  const usage = {
    selected: null,
    builtin: '0.2.1-alpha.2',
    running: { kind: 'installed', version: '0.2.1-alpha.1' },
  }
  assert.equal(rdu.isRuntimeInUse(usage, '0.2.1-alpha.1'), true)
  assert.equal(rdu.isRuntimeInUse(usage, '0.2.1-alpha.2'), false)

  // 读不到 running（老壳）时才回退内置
  assert.equal(rdu.isRuntimeInUse({ builtin: '0.2.1-alpha.2' }, '0.2.1-alpha.2'), true)
  assert.equal(rdu.isRuntimeInUse({ builtin: '0.2.1-alpha.2' }, '0.2.1-alpha.9'), false)

  // 按钮/提示文案：取消是中性且可重试
  assert.equal(rdu.runtimeDownloadButtonLabel(undefined), '下载')
  assert.equal(rdu.runtimeDownloadButtonLabel('downloading'), '下载中…')
  assert.equal(rdu.runtimeDownloadButtonLabel({ cancelled: true }), '已取消 · 重试下载')
  assert.equal(rdu.runtimeDownloadButtonLabel({ failed: 'boom' }), '重试下载')
  assert.equal(rdu.runtimeDownloadHint({ cancelled: true }), '下载已取消')
  assert.equal(rdu.runtimeDownloadHint({ failed: 'boom' }), 'boom')
  assert.equal(rdu.runtimeDownloadHint('downloading'), '')
}

// ── notification-sound-ui（#74）：自定义音效可用性判定 / 试听失败不静默 ──
await build({
  entryPoints: [join(root, 'src/client/features/notification-sound-ui.ts')],
  outfile: join(tmp, 'notification-sound-ui.mjs'),
  format: 'esm',
  platform: 'node',
  bundle: true,
  target: 'node20',
  logLevel: 'silent',
})
const nsui = await import(pathToFileURL(join(tmp, 'notification-sound-ui.mjs')).href)

// #142：被拒绝横幅的 tccutil 提示——id 用当前应用 id，非 darwin 不出 mac 专属提示
{
  const denied = nsui.deniedPermissionCopy
  assert.ok(
    denied('darwin', 'com.hyperion.dsh-desktop-bun').includes('tccutil reset Notifications com.hyperion.dsh-desktop-bun'),
    'macOS 被拒绝提示拼当前应用 id'
  )
  assert.equal(denied('win32', 'com.x.y'), '通知横幅不会显示。可在系统设置中手动开启。', 'Windows 没有 tccutil')
  assert.equal(denied('darwin', null).includes('tccutil'), false, 'id 缺失只给系统设置指引')
  assert.equal(denied(undefined, 'com.x.y').includes('tccutil'), false, '平台未知不出 mac 专属提示')
}

// 一份「mp3/ogg 没后端」的能力报告（Linux 上没装 paplay/ffmpeg 的真实形状）
const MP3_REASON = 'PATH 上找不到能播 .mp3 的播放器（paplay / pw-play / ffplay / mpg123）'
const OGG_REASON = '系统自带播放器不认 Ogg Vorbis：装上 ffmpeg（提供 ffplay）后才能播'
const cap = {
  platform: 'linux',
  formats: {
    wav: { ok: true, backend: 'aplay', reason: null },
    mp3: { ok: false, backend: null, reason: MP3_REASON },
    ogg: { ok: false, backend: null, reason: OGG_REASON },
  },
  hint: '本机没有 .mp3 / .ogg 的播放后端：PATH 上找不到能播 .mp3 的播放器',
}

// ① capability 整个缺失（老壳 / 测试桩 / 没接播放层）：不炸、不禁用、不报警
for (const missing of [null, undefined, {}, { formats: null }, { formats: { mp3: null } }]) {
  const opts = nsui.customSoundOptions(['a.wav', 'b.mp3'], missing)
  assert.equal(opts.length, 2, '缺能力报告时下拉项照旧列全')
  assert.deepEqual(opts[0], { value: 'custom:a.wav', label: 'a.wav', disabled: false, title: undefined }, '缺报告时不禁用')
  assert.equal(opts[1].label, 'b.mp3', '缺报告时不往文案里塞原因')
  assert.equal(nsui.soundOptionState(missing, 'custom:b.mp3').ok, true, '缺报告时自定义档当可用')
  assert.equal(nsui.configuredSoundWarning(missing, 'custom:b.mp3'), null, '缺报告时不出告警')
}
assert.deepEqual(nsui.customSoundOptions(null, null), [], 'sounds 缺失回空数组，不炸')
assert.equal(nsui.customSoundOptions(['a.wav'], null).length, 1, 'sounds 正常时照常出项')
assert.equal(nsui.capabilityHint(null), null, '无能力报告不出总说明')
assert.equal(nsui.capabilityHint({ hint: '   ' }), null, '空白 hint 当没有（不画空行）')
assert.equal(nsui.capabilityHint({ hint: 7 }), null, '非字符串 hint 当没有')
assert.equal(nsui.capabilityHint(cap), cap.hint, '有 hint 时原样透传')

// ② 扩展名没后端的选项：禁用 + 原因写进文案（用户看得见，不只藏 title）
const choices = nsui.customSoundOptions(['叮.wav', '提示音.mp3', '警报.ogg'], cap)
assert.equal(choices[0].disabled, false, '有后端的扩展名不禁用')
assert.equal(choices[0].label, '叮.wav', '可用的项文案不加料')
assert.equal(choices[1].disabled, true, '没后端的 .mp3 下拉里禁用')
assert.ok(choices[1].label.startsWith('提示音.mp3'), '禁用项仍带音效名')
assert.ok(choices[1].label.includes(MP3_REASON), '禁用原因写进选项文案（可见）')
assert.equal(choices[1].title, MP3_REASON, 'title 给原因全文')
assert.equal(choices[2].disabled, true, '没后端的 .ogg 同样禁用')
assert.ok(choices[2].label.includes(OGG_REASON), 'ogg 原因同样可见')

// 内置档不做格式判定（default / none / __choose 永远可选）
for (const builtin of ['default', 'none', '__choose', '']) {
  assert.equal(nsui.soundOptionState(cap, builtin).ok, true, `内置档 ${builtin || '(空)'} 不判定`)
}
assert.equal(nsui.soundOptionState(cap, 'custom:a.aac').ok, true, '白名单外的扩展名不误报（导入时就已拦）')
assert.equal(nsui.soundOptionState(cap, 'custom:无后缀').ok, true, '无后缀不误报')
assert.ok(nsui.soundOptionState({ formats: { ogg: { ok: false, backend: null, reason: null } } }, 'custom:x.ogg').reason, '壳侧没给原因时有兜底文案（不出空尾巴）')
assert.equal(nsui.soundExtension('a.WAV'), 'wav', '扩展名大小写不敏感')
assert.equal(nsui.soundExtension('a.aac'), null, '白名单外回 null')
assert.equal(nsui.soundExtension('.bashrc'), null, '隐藏文件不算后缀')
assert.equal(nsui.customSoundName('custom:x.ogg'), 'x.ogg', 'custom: 前缀剥掉')
assert.equal(nsui.customSoundName('none'), null, '内置档不是自定义音')
assert.equal(nsui.customSoundName('custom:'), null, '空名不算自定义音')

// ③ 已配置但本机播不了：行里（不只下拉里）也要看得见
const warn = nsui.configuredSoundWarning(cap, 'custom:提示音.mp3')
assert.ok(warn.includes('提示音.mp3'), '告警点名哪个音效')
assert.ok(warn.includes(MP3_REASON), '告警带原因')
assert.equal(nsui.configuredSoundWarning(cap, 'custom:叮.wav'), null, '能播的不告警')
assert.equal(nsui.configuredSoundWarning(cap, 'default'), null, '系统默认不告警')

// ④ 试听：真放了但没出声 ⇒ 可见失败；none/空档与老壳缺 audible 都不报错
const failed = nsui.previewFailure({ played: 'custom:提示音.mp3', sound: '提示音.mp3', audible: false })
assert.ok(typeof failed === 'string' && failed.length > 0, 'audible=false 且有 played 时给失败文案')
assert.ok(failed.includes('提示音.mp3'), '失败文案点名播不响的音效')
assert.ok(nsui.previewFailure({ played: 'default', sound: 'default', audible: false }).includes('本机没有可用的播放后端'), '系统默认档没后端也给话说')
assert.equal(nsui.previewFailure({ played: 'custom:叮.wav', sound: '叮.wav', audible: true }), null, '真响了不报错')
assert.equal(nsui.previewFailure({ played: 'custom:叮.wav', sound: '叮.wav' }), null, '缺 audible（老壳）不显示失败')
assert.equal(nsui.previewFailure({ played: 'custom:叮.wav', sound: '叮.wav', audible: undefined }), null, 'audible=undefined 不显示失败')
assert.equal(nsui.previewFailure({ played: null, sound: 'none', audible: false }), null, 'played=null（none/空档）不算失败')
assert.equal(nsui.previewFailure({ played: '', sound: '', audible: false }), null, 'played 空串不算失败')
assert.equal(nsui.previewFailure(null), null, '响应为空不炸')
assert.equal(nsui.previewFailure(undefined), null, '响应缺省不炸')
assert.equal(nsui.previewFailure('ok'), null, '响应非对象不炸')

// ⑤ 「权限不可用」横幅平台化（PR #100 实测反馈）：win/linux 上「dev 裸二进制 / 打包后的 .app」是假话
const OLD_UNAVAILABLE_TEXT = '当前环境无法查询系统通知权限（dev 裸二进制或平台不支持）；验收请使用打包后的 .app。'
for (const plat of ['win32', 'linux']) {
  const copy = nsui.permissionUnavailableCopy(plat)
  assert.equal(copy.neutral, true, `${plat}：中性横幅（不带告警语气）`)
  assert.equal(copy.chip, null, `${plat}：不画「权限不可用」chip`)
  assert.ok(!copy.text.includes('打包后的 .app'), `${plat}：文案不含「打包后的 .app」`)
  assert.ok(!copy.text.includes('dev 裸二进制'), `${plat}：文案不含「dev 裸二进制」`)
  assert.ok(copy.text.includes('系统通知中心'), `${plat}：说清通知归系统通知中心`)
  assert.ok(copy.text.includes('不查询授权状态'), `${plat}：说清壳不查询授权状态`)
}
assert.ok(nsui.permissionUnavailableCopy('win32').text.includes('Windows'), 'win32 点名 Windows')
assert.ok(nsui.permissionUnavailableCopy('linux').text.includes('Linux'), 'linux 点名 Linux')
// darwin 与不可知平台（缺失 / 非字符串 / 未知值）：逐字保留旧文案，不许把「不知道」当 Windows
for (const plat of ['darwin', undefined, null, '', 0, {}, [], 'freebsd', 'win32 ', 'Win32']) {
  const copy = nsui.permissionUnavailableCopy(plat)
  assert.equal(copy.text, OLD_UNAVAILABLE_TEXT, `平台 ${String(plat)} 逐字保留旧文案`)
  assert.equal(copy.chip, '权限不可用', `平台 ${String(plat)} 保留旧 chip`)
  assert.equal(copy.neutral, false, `平台 ${String(plat)} 保留原观感`)
}

// 面板接线（源码级门禁）：判定绿了但没画到 DOM 上 = #74 复发——史上面板还出过「整片空白」事故。
const tabSource = readFileSync(join(root, 'src/client/features/notifications-tab.tsx'), 'utf8')
assert.ok(tabSource.includes('data.capability ?? null'), 'capability 缺失时走容错读法')
assert.ok(tabSource.includes('customSoundOptions(data.sounds, capability)'), '下拉项经可用性判定')
assert.ok(tabSource.includes('disabled={opt.disabled}'), '没后端的格式真的落到 option[disabled] 上')
assert.ok(tabSource.includes('configuredSoundWarning(capability, conf.sound)'), '已配置且本机不可播的音效行里判定')
assert.ok(tabSource.includes('previewFailure(res)'), '试听响应经失败判定')
assert.ok(tabSource.includes('setPreviewNote(failure === null ? null : { id, text: failure })'), '失败文案进可见状态')
assert.ok(tabSource.includes('capabilityHint(capability)'), '缺后端总说明接进面板')
assert.ok(tabSource.includes('permissionUnavailableCopy(capability?.platform)'), '权限不可用横幅取平台判定')
assert.ok(tabSource.includes('{permissionUnavailable.text}'), '平台化文案画进横幅')



// ── keep-awake-note（#75）：防休眠能力提示——缺位 / 拿不到通道 / 按 backend 分平台口径 ──
await build({
  entryPoints: [join(root, 'src/client/features/keep-awake-note.ts')],
  outfile: join(tmp, 'keep-awake-note.mjs'),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})
const ka = await import(pathToFileURL(join(tmp, 'keep-awake-note.mjs')).href)

// 与面板其余说明共用的尾句（逐字；改口径必须先改这里）
const KA_TAIL =
  '直到会话跑完、dsh 实例停止或退出壳。屏幕该关还是照关，只是不让整机睡过去；合盖仍然会睡。改动立即生效。'

// 缺位（老壳没有 keep_awake 字段）/ available 缺失：info + 三平台口径，不把「不知道」说成「不支持」
for (const [label, cap] of [
  ['字段缺省', undefined],
  ['字段为 null', null],
  ['字段在但 available 缺失', { platform: 'linux', backend: 'systemd-inhibit' }],
]) {
  const note = ka.keepAwakeNote(cap)
  assert.equal(note.tone, 'info', `${label}：未知按 info 说明，不误报降级`)
  for (const token of ['macOS', 'Windows', 'Linux']) {
    assert.ok(note.text.includes(token), `${label}：通用说明含 ${token}`)
  }
  assert.ok(note.text.includes(KA_TAIL), `${label}：含共同尾句`)
}

// available:false（拿不到 inhibit 通道）：warn + 明说降级 + 壳给的 reason 原文，绝不静默
const kaOff = ka.keepAwakeNote({
  platform: 'linux',
  backend: null,
  available: false,
  reason: 'systemd-inhibit 不在 PATH，且没有可用的 logind 会话抑制',
})
assert.equal(kaOff.tone, 'warn', '拿不到通道必须 warn（面板走醒目色）')
assert.ok(kaOff.text.includes('本环境拿不到防休眠通道'), 'warn 明说本环境拿不到防休眠通道')
assert.ok(kaOff.text.includes('systemd-inhibit 不在 PATH'), 'warn 原文带上壳给的原因')
assert.ok(kaOff.text.includes('空闲休眠'), 'warn 说清开关开着也可能空闲休眠')

// reason 缺失 / 非字符串：固定兜底句，且任何分支都不许把 undefined 漏进文案
for (const [label, cap] of [
  ['reason 缺省', { available: false }],
  ['reason 为 null', { available: false, reason: null }],
  ['reason 为空白串', { available: false, reason: '  ' }],
  ['reason 非字符串', { available: false, reason: 42 }],
]) {
  const note = ka.keepAwakeNote(cap)
  assert.equal(note.tone, 'warn', `${label}：仍然 warn`)
  assert.ok(note.text.includes('本环境拿不到防休眠通道'), `${label}：仍然明说降级`)
  assert.ok(note.text.includes('原因未知'), `${label}：缺原因时给固定兜底句`)
  assert.ok(!note.text.includes('undefined'), `${label}：文案里不许出现 undefined`)
}

// available:true：按 backend 给平台口径（四个通道各一条）
for (const [backend, token] of [
  ['caffeinate', 'IOKit'],
  ['execution-state', '线程执行状态'],
  ['systemd-inhibit', 'systemd-inhibit'],
  ['gnome-session-inhibit', 'gnome-session-inhibit'],
]) {
  const note = ka.keepAwakeNote({ platform: 'linux', backend, available: true })
  assert.equal(note.tone, 'info', `${backend}：通道可用按 info 说明`)
  assert.ok(note.text.includes(token), `${backend}：文案含 ${token}`)
  assert.ok(note.text.includes(KA_TAIL), `${backend}：含共同尾句`)
}

// 未知 backend（壳将来加通道）：回退三平台通用说明，不空口断言某个平台
const kaUnknown = ka.keepAwakeNote({ platform: 'linux', backend: 'portable-signal', available: true })
assert.equal(kaUnknown.tone, 'info', '未知 backend 按 info')
for (const token of ['macOS', 'Windows', 'Linux']) {
  assert.ok(kaUnknown.text.includes(token), `未知 backend 回退通用说明（含 ${token}）`)
}


// ── notification-focus-hint（#115）：窗口在前台聚焦时不投递通知的说明文案 ──
await build({
  entryPoints: [join(root, 'src/client/features/notification-focus-hint.ts')],
  outfile: join(tmp, 'notification-focus-hint.mjs'),
  format: 'esm',
  platform: 'node',
  bundle: true,
  target: 'node20',
  logLevel: 'silent',
})
const focusHint = await import(pathToFileURL(join(tmp, 'notification-focus-hint.mjs')).href)

const focusText = focusHint.focusSuppressHint()
assert.ok(focusText.length > 0, '说明文案非空')
assert.ok(focusText.includes('前台聚焦') && focusText.includes('不弹通知'), '说清「前台聚焦时不弹通知」')
assert.ok(focusText.includes('失焦') && focusText.includes('最小化'), '说清失焦/最小化后照常')
assert.ok(focusText.includes('不可配置'), '点明是固定策略（别让用户去找开关）')
for (const word of ['可以关闭', '可关闭', '可以关掉', '开关']) {
  assert.ok(!focusText.includes(word), `不写成可配置项（不含「${word}」）`)
}
for (const word of ['平台', 'win32', 'Windows', 'linux', 'Linux', 'macOS', 'darwin']) {
  assert.ok(!focusText.includes(word), `平台无关（不含「${word}」）`)
}
assert.ok(!focusText.includes('\n'), '一句话粒度（不含换行）')
assert.ok(focusText.length <= 60, '一句话粒度（≤60 字）')
assert.equal(focusHint.focusSuppressHint(), focusText, '纯函数：同输入同输出')

// 源码级接线门禁：文案必须真的画进通知页（#115）
const focusTabSource = readFileSync(join(root, 'src/client/features/notifications-tab.tsx'), 'utf8')
assert.ok(focusTabSource.includes('{focusSuppressHint()}'), '说明文案画进通知页（#115 接线）')

// ── 桌面设置面板（#128）：结构性断言，不是快照 ──
// 面板是 .tsx，跑不了纯函数断言；但两处改动都是「有没有卡框 / 档位键名对不对」，
// 用源码文本锁死最省事，也最贴近真实回归形态（谁都可能顺手把它挪出 SectionBox）。
// #144：面板从单个 2341 行的 .tsx 拆成了「入口 + desktop-settings/ 目录」。下面所有面板断言都跑在**模块集合**上，
// 所以「断言只在某个文件里切片」这件事从此不会因为新增卡片而失效——新卡自动进集合。
function collectPanelModules(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) collectPanelModules(full, acc)
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) acc.push(full)
  }
  return acc
}
const panelModules = [
  join(root, 'src/client/desktop-settings.tsx'),
  ...collectPanelModules(join(root, 'src/client/desktop-settings')),
]
const panelSource = panelModules.map((f) => readFileSync(f, 'utf8')).join('\n')

// 剥掉 JSX 注释再切片：注释里出现 `</SectionBox>` 字样会让「找第一个闭合标签」误判到注释上。
const panelNoJsxComments = panelSource.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

// 卡片切片：取某张 SectionBox 到它自己闭合标签之间的正文。
function sliceCard(source, title) {
  const start = source.indexOf(`<SectionBox title="${title}">`)
  const end = source.indexOf('</SectionBox>', start)
  assert.ok(start !== -1 && end !== -1, `${title} 卡还在`)
  return source.slice(start, end)
}

// ① 聚合档位：面板写出去的键必须与壳 serializeSettings 写的下划线键逐字一致，
// 值域三档也与壳 LOOPBACK_AGGREGATION_MODES 一致——任一边改名，这里当场红。
assert.ok(panelSource.includes('loopback_aggregation'), '面板写 loopback_aggregation（与壳落盘键同名）')
for (const mode of ['full', 'stream', 'none']) {
  assert.ok(
    new RegExp(`value: '${mode}'`).test(panelSource),
    `聚合档位表含 ${mode}（与壳白名单同值）`,
  )
}
// 默认档：面板不跨包 import 壳代码（lib/client.js 是随插件单独发布的产物），所以「壳的默认值」
// 在面板这边有三份手写字面量要跟着改：档位表的标签、loopbackAggregationMode 的回退值、
// panel-data.ts 的占位值。漏改任何一份，用户看到的 radio 会与壳实际跑的路子不一致。
{
  const shellDefault = readFileSync(
    join(dirname(root), 'desktop-electrobun/src/shared/settings/settings.ts'),
    'utf8',
  ).match(/DEFAULT_LOOPBACK_AGGREGATION: LoopbackAggregation = '([a-z]+)'/)[1]
  assert.strictEqual(shellDefault, 'stream', `壳的默认档是 stream（当前 ${shellDefault}）`)
  assert.ok(
    panelSource.includes(`value: '${shellDefault}', label: '只关缓冲（默认）'`),
    '档位表把「只关缓冲」标成默认',
  )
  assert.ok(
    panelSource.includes(`hit === undefined ? '${shellDefault}'`),
    '面板的坏值回退与壳的默认档一致',
  )
  assert.ok(
    panelSource.includes(`loopbackAggregation: '${shellDefault}'`),
    '面板首回话前的占位档与壳的默认档一致',
  )
}
// 聚合卡自己的文案不许出现「重启」：切档即时生效，写了重启就是骗用户。
{
  const aggCard = sliceCard(panelNoJsxComments, 'loopback 数据面聚合')
  assert.ok(aggCard.includes('立即生效'), '聚合卡写明「立即生效」')
  assert.ok(!aggCard.includes('重启 dsh 生效'), '聚合卡不写「重启 dsh 生效」（切档即时生效）')
}

// ② 手机端桌面布局开关：必须在「手机访问（远程连接）」这张卡的 </SectionBox> 之前。
// #128 的原症状就是它掉在 </SectionBox> 之后裸奔（没有卡片框），所以直接卡位置。
{
  const card = sliceCard(panelNoJsxComments, '手机访问（远程连接）')
  assert.ok(card.includes('移动端布局'), '手机端桌面布局开关在「手机访问」卡内（有卡片框）')
  assert.ok(card.includes('desktopLayoutOnPhones'), '卡内绑着布局开关自己的状态')
}

// ③ 手机布局开关：与同面板其它 checkbox（#69 开发者工具 / #186 防休眠 / #128 聚合档位）口径一致——勾选即存。
// 原症状是它只 setState、旁边挂一个「保存」按钮，而同形态的防休眠是勾选即存，形态相同行为不同。
{
  const at = panelNoJsxComments.indexOf('data-desktop-settings="desktop-layout-on-phones"')
  assert.ok(at !== -1, '布局开关还在')
  const row = panelNoJsxComments.slice(at, panelNoJsxComments.indexOf('</div>', at))
  assert.ok(
    row.includes('onChange={(e) => handleToggleMobileLayout(e.target.checked)}'),
    '布局开关勾选直接落盘（不再只改本地 state 等点保存）',
  )
  assert.ok(!row.includes('保存</PfBtn>'), '布局开关那一行不再挂「保存」按钮')
  assert.ok(
    panelSource.includes('const handleToggleMobileLayout = (next: boolean)'),
    'handler 收 next 参数而不是读 state（否则连点两下会存反）',
  )
}

// ④ 边框 token：dsh 宿主只定义 --dsw-alias-border-l1..l4 四档（每档各有浅色/深色两套值），
// 写成不带数字的 -l 永远取不到变量、只能落回白色 #ffffff1f ⇒ 浅色主题白底白线看不见（#128）。
// 清单覆盖整个面板模块集合（#144）：新增卡片自动被扫到，不需要谁记得补一行。
for (const f of panelModules) {
  const src = readFileSync(f, 'utf8')
  assert.ok(
    !src.includes('--dsw-alias-border-l,'),
    `${f.slice(root.length + 1)}：不再用宿主未定义的 --dsw-alias-border-l（会永远回退白色，浅色主题看不见边框）`,
  )
}
for (const f of ['notifications-tab.tsx', 'downloads-tab.tsx']) {
  const src = readFileSync(join(root, 'src/client/features', f), 'utf8')
  assert.ok(
    !src.includes('--dsw-alias-border-l,'),
    `${f}：不再用宿主未定义的 --dsw-alias-border-l（会永远回退白色，浅色主题看不见边框）`,
  )
}

// ⑤ 代理设置卡：保存按钮必须落在 </SectionBox> 之内。
// 回归形态是「保存按钮和说明跑到框外」——SectionBox 提前闭合，按钮漂在卡外；面板里其余卡都是「按钮在卡内」。
{
  const card = sliceCard(panelNoJsxComments, '代理设置')
  assert.ok(card.includes('onClick={handleSaveProxy}'), '保存按钮在「代理设置」卡内（没漂到框外）')
  assert.ok(card.includes('保存代理设置'), '卡内就是那个保存按钮（不是别的同名文案）')
}

// ⑥ 卡片顺序：#144 把面板拆成 15 个 cards/*.tsx 后，顺序从「单文件里的物理位置」变成了「入口 JSX 的排列」，
// 这是一处**肉眼扫不出来**的退化：拆分时把相邻的两张卡写反，页面照样渲染，只是顺序变了。
// 本断言已经抓到过一次（日志与诊断/应用更新 与 dsh 运行时 互相错位）。
//
// 断言链：入口 JSX 里卡片组件的先后 → 各自文件里唯一的 SectionBox title → 冻结列表。
// 两头都比：组件顺序错、或某张卡的 title 漂了，都会红。
{
  const entry = readFileSync(join(root, 'src/client/desktop-settings.tsx'), 'utf8')
  const cardDir = join(root, 'src/client/desktop-settings/cards')
  const kebab = (name) =>
    name.replace(/Card$/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  const used = [...entry.matchAll(/<([A-Z][A-Za-z]*Card)\b/g)].map((m) => m[1])
  assert.deepStrictEqual(
    // 比的是「同一张卡」，不是文件名长相：`DevToolsCard` 驼峰转 kebab 得 `dev-tools`，而文件叫 `devtools-card.tsx`
    // （仓库里数据属性也一律写 `dev-tools`，卡片组件名是 `DevToolsCard`）。两边去连字符再比。
    used.map((n) => kebab(n).replace(/-/g, '')).sort(),
    readdirSync(cardDir)
      .filter((f) => f.endsWith('-card.tsx'))
      .map((f) => f.replace('-card.tsx', '').replace(/-/g, ''))
      .sort(),
    'cards/ 下每张卡都在入口被编排（不多不少）',
  )
  // 按「去掉连字符的名字」找文件，而不是拿 kebab 直接拼路径（devtools ↔ dev-tools 那条对不上）。
  const fileByCard = new Map(
    readdirSync(cardDir)
      .filter((f) => f.endsWith('-card.tsx'))
      .map((f) => [f.replace('-card.tsx', '').replace(/-/g, ''), f]),
  )
  const titles = used.map((name) => {
    const key = kebab(name).replace(/-/g, '')
    const file = fileByCard.get(key)
    assert.ok(file !== undefined, `${name} 对应的卡片文件存在（找 ${key}-card.tsx）`)
    const src = readFileSync(join(cardDir, file), 'utf8')
    const found = [...src.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/<SectionBox title="([^"]+)"/g)]
    assert.strictEqual(found.length, 1, `${name} 恰好一张 SectionBox（实际 ${found.length} 张）`)
    return found[0][1]
  })
  assert.deepStrictEqual(
    titles,
    [
      'dsh 来源',
      'dsh 服务地址',
      'Profile',
      'Profile 端口',
      '迁移 Profile',
      '日志与诊断',
      '应用更新',
      'dsh 运行时（版本下载 / 切换）',
      '依赖状态（pnpm store 一致性）',
      '下载',
      '手机访问（远程连接）',
      'loopback 数据面聚合',
      '电源',
      '开发者工具',
      '代理设置',
    ],
    '卡片顺序＝拆分前单文件的真实 DOM 顺序（相邻卡写反时肉眼扫不出来，靠这条拦）',
  )
}


// ── update-notice-settings（#136）：启动更新提醒的开关与已忽略版本列表 ──
await build({
  entryPoints: [join(root, 'src/client/features/update-notice-settings.ts')],
  outfile: join(tmp, 'update-notice-settings.mjs'),
  format: 'esm',
  platform: 'node',
  bundle: true,
  target: 'node20',
  logLevel: 'silent',
})
const notice = await import(pathToFileURL(join(tmp, 'update-notice-settings.mjs')).href)

// ── parseUpdateNoticeState：回包形状校验。读不到就该读不到，不能默认「开着」──
assert.equal(notice.parseUpdateNoticeState(null), null, 'null 回包 = 读不到')
assert.equal(notice.parseUpdateNoticeState('[1,2]'), null, '数组不是合法状态')
assert.equal(notice.parseUpdateNoticeState('nope'), null, '字符串不是合法状态')
assert.equal(notice.parseUpdateNoticeState({}).enabled, true, '缺 enabled 字段 = 默认开（缺字段的老文件不该被当成用户关掉了）')
assert.equal(notice.parseUpdateNoticeState({ enabled: false }).enabled, false, '显式 false = 关')
assert.equal(notice.parseUpdateNoticeState({ enabled: 'no' }).enabled, true, '非布尔值不当成关')
assert.deepEqual(
  notice.parseUpdateNoticeState({ ignored: ['runtime:0.2.2', ' runtime:0.2.2 ', 'shell:0.3.0', 7, ''] }).ignored,
  ['runtime:0.2.2', 'shell:0.3.0'],
  '拉黑键去重、去空白、丢掉非字符串',
)
assert.deepEqual(notice.parseUpdateNoticeState({ ignored: 'nope' }).ignored, [], 'ignored 不是数组就当空')
assert.deepEqual(
  notice.parseUpdateNoticeState({ lastNotified: { shell: '0.3.0', runtime: '   ' } }).lastNotified,
  { shell: '0.3.0', runtime: null },
  '空白版本号回落 null（不参与比较）',
)
assert.deepEqual(notice.parseUpdateNoticeState({}).lastNotified, { shell: null, runtime: null }, '缺 lastNotified 回落空')

// ── parseIgnoredKey：带前缀拆路。同号的壳与运行时是两件事，绝不能合并 ──
assert.deepEqual(notice.parseIgnoredKey('shell:0.3.0'), { kind: 'shell', version: '0.3.0' }, '壳键')
assert.deepEqual(notice.parseIgnoredKey('runtime:0.2.2-alpha.1'), { kind: 'runtime', version: '0.2.2-alpha.1' }, '运行时键')
assert.deepEqual(notice.parseIgnoredKey('0.3.0'), { kind: null, version: '0.3.0' }, '无前缀 = 未知来源（照样能显示、能被清空）')
assert.deepEqual(notice.parseIgnoredKey('plugin:0.3.0'), { kind: null, version: 'plugin:0.3.0' }, '不认识的前缀也当未知来源，原样保留')
assert.deepEqual(notice.parseIgnoredKey('shell:'), { kind: null, version: 'shell:' }, '前缀后版本号为空 = 未知来源')
assert.deepEqual(notice.parseIgnoredKey(':0.3.0'), { kind: null, version: ':0.3.0' }, '空前缀 = 未知来源')

// ── ignoredRows：壳在前、运行时在后，各按版本从高到低 ──
const rows = notice.ignoredRows(['runtime:0.2.9', 'shell:0.3.0', 'runtime:0.2.10', 'shell:0.3.0', 'weird-key'])
assert.deepEqual(
  rows.map((r) => r.label),
  ['桌面壳 0.3.0', 'DSH 运行时 0.2.10', 'DSH 运行时 0.2.9', 'weird-key'],
  '壳在前；同路按版本从高到低（0.2.10 > 0.2.9，不是字典序）；未知来源殿后',
)
assert.equal(rows.length, 4, '重复键去重')
assert.equal(notice.ignoredRows([]).length, 0, '空列表没有行')
assert.equal(notice.ignoredRows(['shell:0.3.0'])[0].kind, 'shell', '行上带着路（恢复按钮靠它回传）')
assert.equal(notice.ignoredRows(['weird-key'])[0].kind, null, '未知来源那行的 kind 是 null（面板据此禁用「恢复」）')

// ── 文案：开关语义必须写在面板上，不能只写在票面 ──
const hintOn = notice.updateNoticeEnabledHint(true)
const hintOff = notice.updateNoticeEnabledHint(false)
assert.ok(hintOn.includes('弹窗'), '开着时说清会弹窗提醒')
assert.ok(hintOn.includes('托盘'), '开着时也点明托盘随时可查')
assert.ok(hintOff.includes('启动不再弹'), '关掉时说清启动不再弹')
assert.ok(hintOff.includes('不受这个开关约束'), '关掉后仍说清手动检查不受约束（票面第 4 条硬要求）')
assert.ok(!hintOff.includes('不会再检查'), '不说成「连检查都不做了」——托盘那次照做')
assert.equal(notice.ignoredEmptyHint(), '没有被忽略的版本。', '空列表灰字')

// 命令名接线改由编译期保证（#190）：invokeCommand 的 cmd 锚在 contracts/ 的 Commands 上，
// 拼错名字 typecheck 直接炸；「契约包含关系」由壳侧 test/contracts.test.ts 对
// COMMAND_NAMES 与命令表键做集合比对，不再读源码文本。
const settingsSource = panelSource
assert.ok(settingsSource.includes('{updateNoticeEnabledHint(updateNotice.enabled)}'), '说明文案画进面板')
assert.ok(settingsSource.includes('清空全部'), '「清空全部」画进面板')
assert.ok(settingsSource.includes('恢复'), '「恢复」画进面板')
assert.ok(
  !/desktop\.[a-z_]*update_notice[a-z_]*/.test(settingsSource),
  '不把提醒开关当普通设置键写进 desktop-settings.json（键名是契约红线）',
)

// ── 面板数据 adapter + 启动检查流程（#182）：跨 interface 行为测试 ──
// 合并规则/轮询过滤/弹窗裁决不再靠 includes 文本：esbuild 转译后直接跑行为，
// 消费面就是契约类型（buildSnapshot 吃 ProxySettings/DesktopData，startupDialogModel 吃 StartupNeeded）。
await build({
  entryPoints: [join(root, 'src/client/desktop-settings/panel-data.ts')],
  outfile: join(tmp, 'panel-data.mjs'),
  format: 'esm', platform: 'node', bundle: true, target: 'node20', logLevel: 'silent',
})
const pd = await import(pathToFileURL(join(tmp, 'panel-data.mjs')).href)

// buildSnapshot：合并规则的唯一实现（ns 优先、壳兜底、完整对象基底）
{
  const ns = {
    proxy_mode: '',                      // 空值 → 回壳回吐的 proxy_mode
    proxy_url: 'http://ns:7890',
    remote_addr: 'http://10.0.0.9:3000',
    remote_list: ['http://a:1'],
    port: 4000,
    lane_forwarder_port: 7900,
    profile_ports: { main: 9001, ghost: 0 },   // 非正数不回填
    profile_lane_ports: { main: 9101 },
    profile_page_ports: {},
    loopback_aggregation: 'weird',       // 坏档位回默认
  }
  const p = { proxy_mode: 'manual', proxy_url: 'http://shell:1', no_proxy: 'localhost', proxy_user: 'u', proxy_pass: 'pw', effective: { picked: 'sys' } }
  const d = {
    remote_addr: 'http://shell-d', remote_list: ['x'], port: 3000,
    profiles: [{ name: 'main', active: true, selectable: true }, { name: 'second', active: false, selectable: true }],
    mux_heartbeat_ms: 15000,
    origin: 'http://extra',              // 壳完整对象基底：契约外字段也不许丢（#147）
  }
  const snap = pd.buildSnapshot(ns, p, d)
  assert.equal(snap.proxy.proxy_mode, 'manual', 'ns 空值回壳的 proxy_mode')
  assert.equal(snap.proxy.proxy_url, 'http://ns:7890', 'ns 段优先于壳回吐')
  assert.equal(snap.proxy.no_proxy, 'localhost', '壳回吐兑底 no_proxy')
  assert.equal(snap.proxyEffective, p.effective, 'effective 原样透传')
  assert.equal(snap.desktop.remote_addr, 'http://10.0.0.9:3000', 'ns 覆盖 remote_addr')
  assert.deepEqual(snap.desktop.remote_list, ['http://a:1'], 'ns 覆盖 remote_list')
  assert.equal(snap.desktop.port, 4000, 'ns 覆盖 port')
  assert.equal(snap.desktop.mux_heartbeat_ms, 15000, '非 ns 展示字段原样保留')
  assert.equal(snap.desktop.origin, 'http://extra', '额外字段不丢（#147 回归）')
  assert.equal(snap.loopbackAggregation, 'stream', '坏档位回默认 stream（与壳 DEFAULT 同值）')
  assert.equal(snap.forwarderInput, '7900', '转发口正数才回填')
  assert.deepEqual(snap.profilePortInputs, { main: '9001' }, '端口回填剔除非正数')
  assert.deepEqual(snap.profileLaneInputs, { main: '9101' })
  assert.equal(snap.migrationSource, 'main', '迁移源取第一个')
  assert.equal(snap.migrationDest, 'second', '迁移目标取另一个')
  // 空列表：迁移 select 双空
  const empty = pd.buildSnapshot({}, p, { ...d, profiles: [] })
  assert.equal(empty.migrationSource, '')
  assert.equal(empty.migrationDest, '')
}

// createPanelData：首拉/刷新/落盘/轮询的行为（传输与计时器全部注入）
{
  const flush = () => new Promise((r) => setImmediate(r))
  const calls = []
  let desktopReads = 0
  let taskReply = { running: false, finished: false, kind: '', title: '', stage: '', done: 0, total: 0, error: '', result: '' }
  const timers = []
  const panel = pd.createPanelData({
    nsGet: async () => { calls.push('ns'); return { remote_addr: 'http://ns:1', port: 4000, lane_forwarder_port: 7900 } },
    getProxySettings: async () => ({ proxy_mode: 'off', proxy_url: '', no_proxy: '', proxy_user: '', proxy_pass: '' }),
    getDesktopData: async () => { desktopReads += 1; return { remote_addr: 'http://d:2', remote_list: [], port: 3080, profiles: [] } },
    taskStatus: async () => taskReply,
    save: async (patch) => { calls.push(['save', patch]) },
    pollMs: 5,
    setIntervalImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearIntervalImpl: (h) => { timers[h - 1] = null },
  })
  const seen = []
  const unsub = panel.subscribe(() => seen.push(panel.getState()))
  assert.equal(panel.getState().loaded, null, '首拉前 loaded 为 null')
  assert.equal(panel.getState().snapshot, pd.PLACEHOLDER, '首拉前渲染占位快照')
  await panel.loadAll((t) => { throw new Error('不该报错: ' + t) })
  assert.equal(desktopReads, 1, '首拉三路并发各读一次')
  const st1 = panel.getState()
  assert.equal(st1.loaded, st1.snapshot, 'loaded 与 snapshot 同引用（回填稳定初值的依据）')
  assert.equal(st1.snapshot.desktop.port, 4000, '首拉走合并规则')
  assert.equal(seen.length, 1, '首拉通知一次')
  await panel.refreshDesktop()
  const st2 = panel.getState()
  assert.equal(desktopReads, 2, 'refreshDesktop 重读 desktop 段')
  assert.equal(st2.loaded, st1.loaded, 'loaded 引用不动')
  assert.equal(st2.snapshot.desktop.remote_addr, 'http://d:2', 'desktop 换成壳回吐的新值')
  assert.equal(st2.snapshot.proxy, st1.snapshot.proxy, 'ns/代理合并不重跑（旧 refreshData 语义）')
  await panel.save({ active_profile: 'main' })
  assert.deepEqual(calls.find((c) => Array.isArray(c)), ['save', { active_profile: 'main' }], 'save 透传落盘通道')
  // 任务轮询：静默轮次不更新；running 才更新；结束后保留末态
  panel.startTaskPolling()
  panel.startTaskPolling()
  assert.equal(timers.length, 1, '轮询只挂一个表（重复 start 幂等）')
  timers[0].fn()
  await flush()
  assert.equal(panel.getState().task, null, '静默轮次不更新任务卡')
  taskReply = { running: true, finished: false, kind: 'migrate', title: '迁移', stage: '复制', done: 1, total: 2, error: '', result: '' }
  timers[0].fn()
  await flush()
  assert.equal(panel.getState().task.title, '迁移', 'running 轮次更新任务卡')
  taskReply = { ...taskReply, running: false, finished: true }
  timers[0].fn()
  await flush()
  assert.equal(panel.getState().task.finished, true, '结束后保留末态')
  taskReply = { running: false, finished: false, kind: '', title: '', stage: '', done: 0, total: 0, error: '', result: '' }
  timers[0].fn()
  await flush()
  assert.equal(panel.getState().task.finished, true, '静默轮次不覆盖末态')
  panel.stopTaskPolling()
  assert.equal(timers[0], null, '停表真的清掉表')
  unsub()
  panel.dispose()
  // dispose 后在途结果丢弃，也不走横幅
  let resolveDesktop
  const gate = new Promise((r) => { resolveDesktop = r })
  const p2 = pd.createPanelData({
    nsGet: async () => ({})
    , getProxySettings: async () => ({ proxy_mode: 'off', proxy_url: '', no_proxy: '', proxy_user: '', proxy_pass: '' }),
    getDesktopData: () => gate,
  })
  const errTexts = []
  const done = p2.loadAll((t) => errTexts.push(t))
  p2.dispose()
  resolveDesktop({ remote_addr: null, remote_list: [], port: 3080, profiles: [] })
  await done
  assert.equal(p2.getState().loaded, null, 'dispose 后到货的结果丢弃')
  assert.equal(errTexts.length, 0, 'dispose 后不报错')
  // 首拉失败走 onLoadError（面板顶部横幅），状态不动
  const errs = []
  const p3 = pd.createPanelData({
    nsGet: async () => { throw new Error('boom') },
    getProxySettings: async () => ({ proxy_mode: 'off', proxy_url: '', no_proxy: '', proxy_user: '', proxy_pass: '' }),
    getDesktopData: async () => ({ remote_addr: null, remote_list: [], port: 3080, profiles: [] }),
  })
  await p3.loadAll((t) => errs.push(t))
  assert.equal(errs.length, 1, '失败恰好报一次')
  assert.ok(errs[0].includes('读取设置失败') && errs[0].includes('boom'), '横幅文案带原因')
  assert.equal(p3.getState().loaded, null, '失败后 loaded 仍为 null')
}

// startup-flow：契约裁决 → 弹窗模型 → 薄 DOM（桩 document 下点按钮只触发注入的 hook）
await build({
  entryPoints: [join(root, 'src/client/desktop-settings/startup-flow.ts')],
  outfile: join(tmp, 'startup-flow.mjs'),
  format: 'esm', platform: 'node', bundle: true, target: 'node20', logLevel: 'silent',
})
const sf = await import(pathToFileURL(join(tmp, 'startup-flow.mjs')).href)
{
  assert.deepEqual(sf.startupDialogModel(null), { kind: 'none' })
  assert.deepEqual(sf.startupDialogModel({ action: 'none' }), { kind: 'none' })
  assert.deepEqual(sf.startupDialogModel({ action: 'profile-selection', profiles: ['a', 'b'] }), { kind: 'select', profiles: ['a', 'b'] })
  const inc = sf.startupDialogModel({ action: 'profile-incomplete', profile: 'main', details: { dir_exists: true, missing_files: ['config.json'], node_modules_exists: false } })
  assert.equal(inc.kind, 'incomplete')
  assert.equal(inc.profile, 'main')
  assert.equal(inc.missingDesc, 'config.json, node_modules', '缺失明细拼接口径与拆分前逐字一致')
  assert.deepEqual(sf.startupDialogModel({ action: 'profile-incomplete', profile: '' }), { kind: 'none' }, '没名的不完整裁决不弹')

  class FakeEl {
    constructor() { this.style = {}; this.children = []; this.textContent = ''; this.removed = false }
    appendChild(c) { this.children.push(c); return c }
    remove() { this.removed = true }
  }
  globalThis.document = {
    createElement: () => new FakeEl(),
    body: new FakeEl(),
  }
  try {
    const hooks = { calls: [] }
    const h = {
      onSelectProfile: (p) => hooks.calls.push(['select', p]),
      onCreateProfile: (n) => hooks.calls.push(['create', n]),
      onStartProfile: (p) => hooks.calls.push(['start', p]),
      onRepairProfile: (p) => hooks.calls.push(['repair', p]),
    }
    sf.mountStartupDialog({ kind: 'select', profiles: ['alpha', 'beta'] }, h)
    const overlay = globalThis.document.body.children[0]
    const card = overlay.children[0]
    const list = card.children[1]   // [0]=标题 [1]=列表 [2]=输入 [3]=新建锉
    assert.equal(list.children.length, 2, '每个 profile 一个按钮')
    list.children[1].onclick()
    assert.ok(overlay.removed, '点击后弹窗自拆')
    assert.deepEqual(hooks.calls, [['select', 'beta']], '点击哪个 profile 就选哪个')
    const input = card.children[2]
    input.value = '  gamma  '
    card.children[3].onclick()
    assert.deepEqual(hooks.calls[1], ['create', 'gamma'], '名字 trim 后交给 onCreateProfile')
    input.value = '   '
    card.children[3].onclick()
    assert.equal(hooks.calls.length, 2, '空名不发（防手滑建空 profile）')
    hooks.calls.length = 0
    sf.mountStartupDialog({ kind: 'incomplete', profile: 'main', missingDesc: 'x' }, h)
    const card2 = globalThis.document.body.children[1].children[0]
    card2.children[2].children[0].onclick()
    card2.children[2].children[1].onclick()
    assert.deepEqual(hooks.calls, [['start', 'main'], ['repair', 'main']], '直接启动/修复启动各走各的 hook')
    const before = globalThis.document.body.children.length
    sf.mountStartupDialog({ kind: 'none' }, h)
    assert.equal(globalThis.document.body.children.length, before, 'none 不挂窗')
  } finally {
    delete globalThis.document
  }
}
rmSync(tmp, { recursive: true, force: true })
console.log('client 纯函数测试：全部通过 ✓')
