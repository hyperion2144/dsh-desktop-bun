// 托盘「新建 Profile…」「迁移 Profile…」（F9，旧壳 tray.rs:76-79）的弹框：
// 一个小 CEF 窗口装一张表单，动作经官方 Electrobun Typed RPC 原生桥交给壳（#129），服务面负责落地。
// 本模块只出 HTML 与校验规则，不 import electrobun（可单测）。
import {
  DEFAULT_SHELL_THEME,
  shellThemeAttr,
  shellThemeStyle,
  type ShellThemePreference,
} from '../shared/shell-theme.ts'
import {
  DIALOG_CLOSE_ATTR,
  DIALOG_TITLEBAR_CLASS,
  dialogTitlebar,
  dialogTitlebarStyle,
} from './dialog-titlebar.ts'
import type { CarrierPlatform } from './carrier.ts'
/** Profile 操作的请求体（页面提交 / 壳侧通道共用这个形状） */
export interface ProfileOpRequest {
  op: 'create' | 'migrate'
  /** create = 新名称；migrate = 目标名称 */
  target?: string
  /** migrate = 源 profile */
  source?: string
  /** migrate：目标已存在时是否覆盖 */
  overwrite?: boolean
}

export interface ProfileOpResult {
  ok: boolean
  message: string
  /** 成功时回目标 profile，壳用来开窗/刷新托盘 */
  profile?: string
}

/** 页面 ↔ 壳的动作方法名（官方原生桥上的方法；壳侧 handlers 用同一个常量） */
export const PROFILE_OP_METHOD = 'profile_op'
/**
 * 请壳关掉本窗的方法名（#162，与 #160 同款）。
 *
 * 页面不能自己 `window.close()`：这扇窗是 `html:` 文档，不是脚本打开的窗口，Chromium 忽略
 * `window.close()`（静默无效），Electrobun 的注入胶水也没覆写它。成功后的「关窗」必须是壳的动作。
 */
export const PROFILE_CLOSE_METHOD = 'profile_close'

/** profile 名规则：小写字母/数字开头，允许连字符，1-64 字符（旧壳 migrate 用 1-32 的宽松版） */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name)
}

/** 迁移目标与源相同的快速拒绝（服务面还有更全的校验） */
export function isSelfMigrate(source: string, target: string): boolean {
  return source !== '' && source === target
}

/**
 * 官方原生桥收到的参数 → 请求体（#129）。认不出来的形状一律 null，不猜：
 * 页面是内嵌 HTML，但消息跨进程过来，同样按外部输入对待。
 *
 * 只管**形状**（字段在不在、类型对不对）：名字合法性、自迁移、目标已存在的覆盖分支
 * 全在服务面的 `profileOp` 里，这里不复制第二套语义。
 */
export function profileOpRequest(value: unknown): ProfileOpRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const op = raw['op']
  if (op !== 'create' && op !== 'migrate') return null
  const target = raw['target']
  if (typeof target !== 'string') return null
  if (op === 'create') return { op, target }
  // migrate 必须带非空源；overwrite 只认严格 true（与壳其余入参一个口径）。
  const source = raw['source']
  if (typeof source !== 'string' || source === '') return null
  return { op, target, source, overwrite: raw['overwrite'] === true }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export type ProfileOpDialogKind = 'create' | 'migrate'

function jsString(value: string): string {
  return JSON.stringify(value)
}

/** 弹框页：创建 = 名称输入；迁移 = 源/目标 + 覆盖确认。提交后按结果显示一句话。 */
export function profileDialogHtml(
  kind: ProfileOpDialogKind,
  profiles: readonly string[],
  theme: ShellThemePreference = DEFAULT_SHELL_THEME,
  // #164：win32/linux 上 hiddenInset 没有原生控件，自绘一条标题带（关窗键 + 拖拽面）；
  // darwin 有系统红绿灯，默认按 darwin 算（不画带）。
  platform: CarrierPlatform = 'darwin',
): string {
  const title = kind === 'create' ? '新建 Profile' : '迁移 Profile'
  const band = dialogTitlebar({ platform, title })
  // #164：CSS 也只随带一起上（darwin 不带一条死样式）。留位与「标题不重复画」靠 body 的 class。
  const bandCss =
    band.html === ''
      ? ''
      : [
          dialogTitlebarStyle(),
          '  /* 带是 absolute 锚在窗顶，body 得是定位父级。 */',
          '  body { position: relative; }',
          `  .${DIALOG_TITLEBAR_CLASS} { padding-top: 46px; }`,
          `  .${DIALOG_TITLEBAR_CLASS} .title { display: none; }`,
          `  .${DIALOG_TITLEBAR_CLASS} .head { padding-bottom: 10px; }`,
        ].join('\n')
  const subtitle =
    kind === 'create' ? '名称一经创建就会立刻开窗并装依赖' : '复制整棵依赖树并重装依赖，可能要几分钟'
  // 忙碌文案在服务端就定好：页面作用域里没有 kind，内嵌脚本里任何**裸引用** TS 侧变量
  // 都会变成运行时 ReferenceError，而它只表现为「点了没反应」（#129）。
  const busyText = kind === 'create' ? '创建中…' : '迁移中（复制依赖树，可能要一会儿）…'
  const fields =
    kind === 'create'
      ? `    <label>名称（小写字母、数字、连字符）<input id="target" autofocus></label>`
      : `    <label>源 profile<select id="source">${profiles
          .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
          .join('')}</select></label>
    <label>目标名称<input id="target" placeholder="新 profile 名"></label>
    <label class="check"><input id="overwrite" type="checkbox"> 目标已存在时覆盖</label>`
  return `<!doctype html>
<html lang="zh-CN"${shellThemeAttr(theme)}>
<head>
<meta charset="utf-8">
<style>
${shellThemeStyle()}
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px 16px 16px;
         background: var(--dsw-alias-bg-layer-1, #1b1d21); color: var(--dsw-alias-label-primary, #e8e8e8);
         font: 13px/1.5 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; }
  /* 标题居中：hiddenInset 的红绿灯压在左上角，左对齐标题会被盖住（真机截图）。 */
  .head { text-align: center; padding-bottom: 14px; }
  .title { font-size: 16px; font-weight: 600; }
  .subtitle { margin-top: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9aa2); }
  form { margin: 0; }
  label { display: block; margin-bottom: 9px;
          font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9aa2); }
  input, select { display: block; width: 100%; margin-top: 4px; padding: 6px 8px;
    font: inherit; font-size: 13px; border-radius: 7px;
    border: 1px solid var(--dsw-alias-border-l2, #3a3d44);
    background: var(--dsw-alias-surface-raised, #212328);
    color: var(--dsw-alias-label-primary, #e8e8e8); }
  input:focus, select:focus { outline: 2px solid var(--dsw-alias-state-accent-primary, #4c6ef5); outline-offset: -1px; }
  label.check { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  label.check input { width: auto; margin: 0; }
  .foot { margin-top: 12px; display: flex; justify-content: flex-end; }
  .btn { font: inherit; padding: 6px 14px; border-radius: 7px;
         border: 1px solid var(--dsw-alias-border-l2, #3a3d44);
         background: var(--dsw-alias-surface-raised, #212328);
         color: var(--dsw-alias-label-primary, #e8e8e8); cursor: pointer; }
  .btn.primary { border: 0; background: var(--dsw-alias-state-accent-primary, #4c6ef5);
                 color: var(--dsw-alias-state-accent-fg, #fff); }
  .btn:disabled { opacity: .5; cursor: default; }
  #msg { margin-top: 8px; min-height: 16px; font-size: 11px; white-space: pre-wrap;
         color: var(--dsw-alias-label-secondary, #9a9aa2); }
  #msg.err { color: var(--dsw-alias-state-danger, #ff8787); }
  #msg.ok { color: #40c057; }
${bandCss}
</style>
</head>
<body${band.bodyClass === '' ? '' : ` class="${band.bodyClass.trim()}"`}>
${band.html}
  <div class="head">
    <div class="title">${title}</div>
    <div class="subtitle">${subtitle}</div>
  </div>
  <form id="f">
${fields}
    <div class="foot"><button class="btn primary" type="submit">${kind === 'create' ? '创建' : '开始迁移'}</button></div>
    <div id="msg"></div>
  </form>
  <script>
    const f = document.getElementById('f')
    const msg = document.getElementById('msg')
    // 动作经 Electrobun 官方 Typed RPC 原生桥发给壳（#129）：这扇窗是 html 文档，origin 是
    // views://internal，跟壳的 loopback 不同源——相对 URL 会被解析到 views:// 协议（请求根本
    // 发不出去），换成绝对 loopback URL 又会被准入的同源判据挡掉（Sec-Fetch-Site: cross-site
    // → 403，shared/admission.ts）。原生桥这两道都不过，也不必带视图 token。
    var rpcSeq = 0
    var rpcPending = {}
    function rpcReceive(packet) {
      if (!packet || packet.type !== 'response') return
      var waiter = rpcPending[packet.id]
      if (!waiter) return
      delete rpcPending[packet.id]
      if (packet.success === true) waiter.resolve(packet.payload)
      else waiter.reject(new Error(typeof packet.error === 'string' ? packet.error : '壳侧执行失败'))
    }
    function rpcAttachReceive() {
      var eb = globalThis.__electrobun
      if (!eb) return
      eb.receiveMessageFromHost = rpcReceive
      var queued = globalThis.__electrobunPendingHostMessages
      if (Array.isArray(queued)) {
        globalThis.__electrobunPendingHostMessages = []
        for (var i = 0; i < queued.length; i++) rpcReceive(queued[i])
      }
    }
    function invokeShell(method, params) {
      var bridge = globalThis.__electrobunHostBridge
      var post = bridge && bridge.postMessage
      if (typeof post !== 'function') return Promise.reject(new Error('壳桥不可用，无法提交'))
      rpcAttachReceive()
      rpcSeq = rpcSeq + 1
      var id = rpcSeq
      return new Promise(function (resolve, reject) {
        rpcPending[id] = { resolve: resolve, reject: reject }
        try {
          post(JSON.stringify({ type: 'request', id: id, method: method, params: params }))
        } catch (error) {
          delete rpcPending[id]
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    }
    // 关窗一律请壳代劳（#162）：页面自己关不掉自己。
    function closeSelf() {
      return invokeShell(${jsString(PROFILE_CLOSE_METHOD)}).catch(function () {})
    }
    // #164：标题带的关闭键与 ESC 都接同一个 closeSelf——win32/linux 上 hiddenInset 没有
    // 原生控件，不接的话这扇窗除了「提交成功」没有任何出路。
    var closeBtn = document.querySelector('[${DIALOG_CLOSE_ATTR}]')
    if (closeBtn) closeBtn.addEventListener('click', closeSelf)
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeSelf()
    })
    // 提交期间不再接第二次：迁移要复制整棵依赖树再跑 pnpm install，双击会同时跑两遍。
    var busy = false
    f.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (busy) return
      busy = true
      // 整段处理体都在 try 里：这一行曾经漏了插值、裸引用服务端变量，而它位于 try 之外，
      // async handler 抛出去只变成未处理的 rejection——用户看到的就是「点了没反应」（#129）。
      try {
        const body = {
          op: '${kind}',
          target: (document.getElementById('target') || {}).value || '',
          source: (document.getElementById('source') || {}).value || '',
          overwrite: !!(document.getElementById('overwrite') || {}).checked,
        }
        msg.className = ''
        msg.textContent = '${busyText}'
        const data = await invokeShell(${jsString(PROFILE_OP_METHOD)}, body)
        msg.className = data && data.ok ? 'ok' : 'err'
        msg.textContent = (data && data.message) || (data && data.ok ? '完成' : '失败')
        window.__dshProfileOpResult = data
        if (data && data.ok) setTimeout(closeSelf, 1200)
      } catch (error) {
        msg.className = 'err'
        msg.textContent = String(error)
      } finally {
        busy = false
      }
    })
  </script>
</body>
</html>
`
}
