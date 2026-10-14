/**
 * client 纯函数测试入口（node scripts/test-client.mjs）。
 * 用 esbuild 把 TS 纯函数模块转译到临时目录后动态 import 断言，
 * 不给 client 引入测试框架依赖。目前覆盖 download-intercept 的拦截判定、
 * platform-keyboard（#187）的绑定匹配 / keybindings 解析与编辑。
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import assert from 'node:assert/strict'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tmp = join(root, '.test-tmp')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

await build({
  entryPoints: [join(root, 'src/client/download-intercept.ts')],
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
  entryPoints: [join(root, 'src/client/platform-keyboard.ts')],
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

// ── 壳 preload 注入的 dshDesktop 载体脚本（desktop-electrobun/src/bun/carrier.ts，
// 旧壳 Rust 版 DESKTOP_CARRIER_INIT_SCRIPT 的等价物）：esbuild 转译后在最小 DOM 桩里
// 真跑一遍，锁住对外形状（幂等安装 / 惰性转发 / 轮询等待 / 平台标记）。
await build({
  entryPoints: [join(root, '../desktop-electrobun/src/bun/carrier.ts')],
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
  entryPoints: [join(root, 'src/client/composer-input-guard.ts')],
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
  console: { info: (...args) => guardLogs.push(args.join(' ')) },
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



// ── shell-rpc（#50）：统一传输层，三通道选择 / wire 协议 / 超时 / 窗口三键 ──
await build({
  entryPoints: [join(root, 'src/client/shell-rpc.ts')],
  outfile: join(tmp, 'shell-rpc.mjs'),
  format: 'esm',
  platform: 'node',
  bundle: true,
  target: 'node20',
  logLevel: 'silent',
})
const { createShellRpc, sendWindowAction } = await import(pathToFileURL(join(tmp, 'shell-rpc.mjs')).href)

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

// 中继通道（mobile-access 远程页）
{
  const globals = { __DSH_SHELL_RELAY__: { invoke: async (cmd, args) => ({ cmd, args }) } }
  const rpc = createShellRpc({ readGlobals: () => globals })
  assert.deepEqual(await rpc.invoke('get_notifications_state', { x: 1 }), { cmd: 'get_notifications_state', args: { x: 1 } }, '有中继无桥时走中继')
}

// 同源 fetch 兑底：带 token 头 + 请求体字形
{
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ ok: true, value: { status: 2 } }) } }
  const globals = { __DSH_SHELL_VIEW_TOKEN__: 'tok-1' }
  const rpc = createShellRpc({ readGlobals: () => globals, fetchImpl })
  assert.deepEqual(await rpc.invoke('get_dsh_status'), { status: 2 }, 'fetch 兑底解析 value')
  assert.equal(calls[0].url, '/__shell__/rpc', '端点正确')
  assert.equal(calls[0].init.headers['x-dsh-shell-view'], 'tok-1', '带每视图 token 头')
  assert.deepEqual(JSON.parse(calls[0].init.body), { cmd: 'get_dsh_status', args: {} }, 'body 对齐旧 shim 协议')

  const fetchErr = async () => ({ ok: true, json: async () => ({ ok: false, error: 'unsupported command: nope' }) })
  const rpcE = createShellRpc({ readGlobals: () => globals, fetchImpl: fetchErr })
  await assert.rejects(rpcE.invoke('nope'), /unsupported command/, 'fetch 业务失败可见')
}

// 无任何通道：available false + invoke reject
{
  const rpc = createShellRpc({ readGlobals: () => ({}) })
  assert.equal(rpc.available(), false)
  await assert.rejects(rpc.invoke('x'), /shell rpc unavailable/)
}

// 官方通道失败不回退 fetch（命令可能已生效，toggle 二次执行会翻转两次）
{
  let fetchCalls = 0
  const fetchImpl = async () => { fetchCalls += 1; return { ok: true, json: async () => ({ ok: true, value: 1 }) } }
  const globals = { __electrobunHostBridge: { postMessage: () => {} }, __electrobun: {}, __DSH_SHELL_VIEW_TOKEN__: 't3' }
  const rpc = createShellRpc({ readGlobals: () => globals, fetchImpl, setTimeoutImpl: (fn) => { fn(); return 1 }, clearTimeoutImpl: () => {} })
  await assert.rejects(rpc.invoke('x'), /timed out/)
  assert.equal(fetchCalls, 0, '官方通道超时后不打 fetch 兑底')
}

// 窗口三键：官方通道 window_* 方法；无桥时 /__shell__/window 兑底
{
  const sent = []
  const globals = { __electrobunHostBridge: { postMessage: (raw) => sent.push(JSON.parse(raw)) }, __electrobun: {} }
  const rpc = createShellRpc({ readGlobals: () => globals, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} })
  const p = sendWindowAction('toggle-maximize', { rpc, readGlobals: () => globals })
  assert.equal(sent[0].method, 'window_toggle_maximize', '三键走官方 RPC 方法')
  globals.__electrobun.receiveMessageFromHost({ type: 'response', id: 1, success: true, payload: null })
  await p

  const calls = []
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true } }
  await sendWindowAction('minimize', { fetchImpl, readGlobals: () => ({ __DSH_SHELL_VIEW_TOKEN__: 't2' }) })
  assert.equal(calls[0].url, '/__shell__/window', '无桥三键兑底到窗口端点')
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'minimize' })
}

rmSync(tmp, { recursive: true, force: true })
console.log('client 纯函数测试：全部通过 ✓')
