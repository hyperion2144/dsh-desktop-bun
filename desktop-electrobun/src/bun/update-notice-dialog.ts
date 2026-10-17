/**
 * 启动更新提醒窗（#140，map #135）：**内嵌 HTML + 动作契约**，纯逻辑、不 import electrobun。
 *
 * 形态沿用 `profile-dialog.ts` 的窗体（壳进程自己开一个独立 BrowserWindow，`hiddenInset`、560×300），
 * 但**动作不走 HTTP**（#139 实机修）：html 文档的 origin 是 `views://`，fetch 发不出同源请求，
 * 改走官方 Typed RPC 的原生桥（`update-notice-rpc.ts`）。服务面落地后关窗。服务面在 #139 落地。
 *
 * 版式是原型的 B 变体「汇总头 + 双栏 + 一次全更」（维护者 2026-10-17 选型）：
 * - 头部一句话交代「有几项可更新」，把两段的数量与合计体积一次说清；下面左右两栏各管一段，
 *   壳与运行时不叠成两段长列表——提醒窗是窄窗，左右并排比上下堆叠少一半高度。
 * - 运行时栏只让**最高那条**当主角（点一下就到位），其余候选收成一行灰字，不占视觉重量。
 * - 底部一个「全部更新」一次搞定两段，旁边「不再提示这两个版本」把版本号一并交给 #142 拉黑。
 *
 * 判定不在这层：运行时侧数据一律由 #138 的 `evaluateRuntimeUpdates()` 给，壳侧由
 * `updateView()` 给。谁都别在这里比较版本号。
 */

import {
  formatBytes,
  type UpdateView,
} from '../shared/update.ts'
import {
  DEFAULT_CATALOG_SOURCE,
  RUNTIME_UPDATE_ACTION_LABELS,
  runtimeUpdateSourceLabel,
  topRuntimeUpdate,
  type RuntimeUpdateAction,
  type RuntimeUpdateReport,
} from '../shared/runtime-update.ts'
import type { UpdateNoticeTarget } from '../shared/update-notice-policy.ts'
import {
  DEFAULT_SHELL_THEME,
  shellThemeAttr,
  shellThemeStyle,
  type ShellThemePreference,
} from '../shared/shell-theme.ts'

/** 提醒卡动作在官方 Typed RPC 上的方法名（#139；这里只把方法名定成一处常量）。 */
export const UPDATE_NOTICE_OP_METHOD = 'update_notice_op'

/** 只读的下载状态查询方法名（与壳命令表同名；页面靠它画进度）。 */
export const UPDATE_NOTICE_STATUS_METHOD = 'runtime_download_status'


/** 选型定的窗尺寸（B 变体：更宽更矮）。 */
export const UPDATE_NOTICE_WIDTH = 560
export const UPDATE_NOTICE_HEIGHT = 300

export interface UpdateNoticePayload {
  /** 产品主题偏好（缺省跟随系统）。服务端按 profile 的 ui-theme 配置填。 */
  theme?: ShellThemePreference
  /** 窗属于哪个 profile（多 profile 合并成一张卡时，取命中的第一个）。 */
  profile: string
  /** 同一张卡覆盖到的全部 profile（1 个时不提这回事）。 */
  profiles?: readonly string[]
  /** 实际在跑的版本；拿不到给 null（那时判定层压根不会说有更新）。 */
  baseline: string | null
  /** 设置里想要的运行时版本；可能与 baseline 不一致（#97 之后这俩能分叉），文案要自证。 */
  preference: string | null
  /** #138 判定层输出。 */
  runtime: RuntimeUpdateReport | null
  /** `shared/update.ts` 的壳更新视图。 */
  shell: UpdateView | null
}

/** 运行时侧的一个动作目标（判定层给的最高那条，页面原样带回来）。 */
export interface UpdateNoticeRuntimeTarget {
  version: string
  action: RuntimeUpdateAction
  /** 远端目录来源（github / npm），跟判定层用的是同一个串。 */
  source: string
}

export type UpdateNoticeOp =
  | { op: 'download-shell' }
  | ({ op: 'runtime' } & UpdateNoticeRuntimeTarget)
  | { op: 'update-all'; shell: boolean; runtime?: UpdateNoticeRuntimeTarget }
  | { op: 'ignore'; targets: UpdateNoticeTarget[] }
  | { op: 'later' }

export interface UpdateNoticeShellSegment {
  version: string
  current: string
  channel: string
  bytes: string
  /** 下载类动作忙（checking/downloading/preparing）时按钮不可点。 */
  disabled: boolean
  hint: string
}

export interface UpdateNoticeRuntimeSegment {
  version: string
  channel: string
  source: string
  /** 远端目录来源（判定层的 source），动作要用。 */
  catalogSource: string
  action: RuntimeUpdateAction
  actionLabel: string
  /** 其余候选（收成一行灰字，不给按钮）。 */
  rest: string[]
}

export interface UpdateNoticeModel {
  /** 头部：几项可更新。项 = 一段（壳 / 运行时），不是候选条数。 */
  title: string
  subtitle: string
  shell: UpdateNoticeShellSegment | null
  runtime: UpdateNoticeRuntimeSegment | null
  /** 自证行：实际在跑的版本 + 设置里想要的版本（不一致时两个都露）。 */
  selfNote: string
  /** 多 profile 命中时的交代；只有 1 个 profile 时是空串。 */
  profileNote: string
  /** 「不再提示」要拉黑的版本（带路：同号的壳与运行时是两件事）。 */
  ignoreTargets: UpdateNoticeTarget[]
}

function shellSegment(view: UpdateView | null): UpdateNoticeShellSegment | null {
  if (view === null || !view.updateAvailable) return null
  const busy = view.phase === 'checking' || view.phase === 'downloading' || view.phase === 'preparing'
  return {
    version: view.latest,
    current: view.current,
    channel: view.channel,
    bytes: formatBytes(view.totalBytes),
    disabled: busy,
    hint: busy ? view.label : '重启应用后生效',
  }
}

function runtimeSegment(report: RuntimeUpdateReport | null): UpdateNoticeRuntimeSegment | null {
  if (report === null || !report.available) return null
  const top = topRuntimeUpdate(report)
  if (top === null) return null
  return {
    version: top.version,
    channel: top.channel,
    source: runtimeUpdateSourceLabel(top),
    catalogSource: report.source,
    action: top.action,
    actionLabel: RUNTIME_UPDATE_ACTION_LABELS[top.action],
    rest: report.entries.slice(1).map((entry) => `${entry.version}（${runtimeUpdateSourceLabel(entry)}）`),
  }
}

/**
 * 把判定结果摆成 B 变体的结构。**返回 null = 没什么可提醒，压根不该弹窗**：
 * 静默是默认态（离线、目录拉失败、都在跑最新版），不是「弹一张空的」。
 */
export function updateNoticeModel(payload: UpdateNoticePayload): UpdateNoticeModel | null {
  const shell = shellSegment(payload.shell)
  const runtime = runtimeSegment(payload.runtime ?? null)
  if (shell === null && runtime === null) return null

  const profiles = payload.profiles ?? [payload.profile]
  const bits: string[] = []
  if (shell !== null) bits.push(`桌面壳 ${shell.version}`)
  if (runtime !== null) bits.push(`DSH 运行时 ${runtime.version}`)
  const bytes = payload.shell?.totalBytes ?? null
  if (shell !== null && bytes !== null) bits.push(formatBytes(bytes))

  const selfBits: string[] = []
  if (payload.baseline !== null && payload.baseline !== '') selfBits.push(`实际在跑 ${payload.baseline}`)
  if (payload.preference !== null && payload.preference !== '' && payload.preference !== payload.baseline) {
    selfBits.push(`设置里想要 ${payload.preference}`)
  }

  const ignoreTargets: UpdateNoticeTarget[] = [
    ...(shell === null ? [] : [{ kind: 'shell' as const, version: shell.version }]),
    ...(runtime === null ? [] : [{ kind: 'runtime' as const, version: runtime.version }]),
  ]
  const count = (shell === null ? 0 : 1) + (runtime === null ? 0 : 1)
  return {
    title: `${count} 项可用更新`,
    subtitle: bits.join(' · '),
    shell,
    runtime,
    selfNote: selfBits.join(' · '),
    profileNote: profiles.length > 1 ? `覆盖 ${profiles.length} 个 profile：${profiles.join('、')}` : '',
    ignoreTargets,
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function jsString(value: string): string {
  return JSON.stringify(value)
}

function button(label: string, op: unknown, primary: boolean, disabled = false): string {
  const cls = primary ? 'btn primary' : 'btn'
  return `<button class="${cls}" data-op="${escapeHtml(JSON.stringify(op))}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`
}

/** B 变体的内嵌 HTML。数据经 `updateNoticeModel` 归一，文案只讲「在跑什么、能更到什么」。 */
export function updateNoticeHtml(payload: UpdateNoticePayload): string {
  const model = updateNoticeModel(payload)
  if (model === null) {
    // 不该走到这里：调用方先看 updateNoticeModel()，为 null 就不开窗。留一页体面话兜底。
    return `<!doctype html>
 <html lang="zh-CN"${shellThemeAttr(payload.theme ?? DEFAULT_SHELL_THEME)}>
<head>
<meta charset="utf-8">
<style>
${shellThemeStyle()}
   body { margin: 0; display: grid; place-items: center; min-height: 100vh;
          background: var(--dsw-alias-bg-layer-1, #1b1d21); color: var(--dsw-alias-label-secondary, #9a9aa2);
          font: 13px/1.5 -apple-system, "PingFang SC", sans-serif; }
</style>
</head>
<body><div>没有需要提醒的更新</div></body>
</html>
`
  }
  const shellCol =
    model.shell === null
      ? ''
      : `<div class="col">
  <div class="cap">桌面壳</div>
  <div class="ver">${escapeHtml(model.shell.version)}</div>
  <div class="sub">当前 ${escapeHtml(model.shell.current)} · ${escapeHtml(model.shell.channel)} · ${escapeHtml(model.shell.bytes)}</div>
  ${button('下载更新', { op: 'download-shell' }, true, model.shell.disabled)}
  <div class="hint">${escapeHtml(model.shell.hint)}</div>
</div>`
  const runtimeCol =
    model.runtime === null
      ? ''
      : `<div class="col">
  <div class="cap">DSH 运行时</div>
  <div class="ver">${escapeHtml(model.runtime.version)}</div>
  <div class="sub">当前 ${escapeHtml(payload.baseline ?? '')} · ${escapeHtml(model.runtime.channel)} · ${escapeHtml(model.runtime.source)}</div>
  ${button(model.runtime.actionLabel, { op: 'runtime', version: model.runtime.version, action: model.runtime.action, source: model.runtime.catalogSource }, true)}
  <div class="hint">${model.runtime.rest.length > 0 ? `另有 ${escapeHtml(model.runtime.rest.join('、'))}` : '切换后需重启 DSH 服务'}</div>
  <div id="dl" hidden><div class="bar"><div class="fill" id="dlfill"></div></div><div id="dltxt"></div></div>
</div>`
  const columns = model.shell !== null && model.runtime !== null ? ' two' : ''
  const notes = [model.selfNote, model.profileNote].filter((x) => x !== '').join(' · ')
  return `<!doctype html>
 <html lang="zh-CN"${shellThemeAttr(payload.theme ?? DEFAULT_SHELL_THEME)}>
<head>
<meta charset="utf-8">
<style>
${shellThemeStyle()}
  * { box-sizing: border-box; }
   * { box-sizing: border-box; }
   body { margin: 0; padding: 14px 16px 16px;
          background: var(--dsw-alias-bg-layer-1, #1b1d21); color: var(--dsw-alias-label-primary, #e8e8e8);
          font: 13px/1.5 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; }
   .head { text-align: center; padding-bottom: 12px; }
   .title { font-size: 16px; font-weight: 600; }
   .subtitle { margin-top: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9aa2); }
   .cols { display: grid; grid-template-columns: 1fr; gap: 9px; }
   .cols.two { grid-template-columns: 1fr 1fr; }
   .col { background: var(--dsw-alias-surface-raised, #212328);
          border: 1px solid var(--dsw-alias-border-l2, #3a3d44); border-radius: 9px; padding: 11px;
          display: flex; flex-direction: column; gap: 4px; }
   .cap { font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9aa2); }
   .ver { font-size: 15px; font-weight: 600; }
   .sub, .hint { font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9aa2); }
   .hint { margin-top: 2px; min-height: 15px; }
   .btn { font: inherit; padding: 6px 12px; border-radius: 7px;
          border: 1px solid var(--dsw-alias-border-l2, #3a3d44);
          background: var(--dsw-alias-surface-raised, #212328);
          color: var(--dsw-alias-label-primary, #e8e8e8); cursor: pointer; }
   /* 下载进度（实机反馈：只写「处理中…」不够，面板那种进度条才有用） */
   #dl { margin-top: 6px; }
   .bar { height: 4px; border-radius: 3px; background: var(--dsw-alias-border-l2, #3a3d44); overflow: hidden; }
   .fill { height: 100%; width: 0; background: var(--dsw-alias-state-accent-primary, #4c6ef5); transition: width .25s linear; }
   #dltxt { margin-top: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9aa2); }
   /* 卡内按钮离上一行留点气；页脚那两个同在一条 flex 上，留白只会把主按钮顶歪 7px（真机截图见过）。 */
   .col .btn { margin-top: 7px; }
   .btn.primary { border: 0; background: var(--dsw-alias-state-accent-primary, #4c6ef5);
             color: var(--dsw-alias-state-accent-fg, #fff); }
   .btn:disabled { opacity: .5; cursor: default; }
   .notes { margin-top: 9px; font-size: 11px; color: var(--dsw-alias-label-secondary, #7c7c85);
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
   .foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 9px; }
   .acts { display: flex; align-items: center; gap: 8px; }
   .link { font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary, #8b93a8);
          background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
   .empty { text-align: center; padding: 24px 0; color: var(--dsw-alias-label-secondary, #9a9aa2); }
   #msg { margin-top: 8px; min-height: 16px; font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9aa2); }
   #msg.err { color: var(--dsw-alias-state-danger, #ff8787); }
</style>
</head>
<body>
<div class="head">
  <div class="title">${escapeHtml(model.title)}</div>
  <div class="subtitle">${escapeHtml(model.subtitle)}</div>
</div>
<div class="cols${columns}">
${shellCol}${runtimeCol}
</div>
<div class="notes" title="${escapeHtml(notes)}">${escapeHtml(notes)}</div>
<div class="foot">
  ${model.ignoreTargets.length > 0 ? `<button class="link" data-op="${escapeHtml(JSON.stringify({ op: 'ignore', targets: model.ignoreTargets }))}">不再提示</button>` : ''}
  <div class="acts">
    ${button('稍后', { op: 'later' }, false)}
    ${button('全部更新', { op: 'update-all', shell: model.shell !== null, ...(model.runtime === null ? {} : { runtime: { version: model.runtime.version, action: model.runtime.action, source: model.runtime.catalogSource } }) }, true)}
  </div>
</div>
<div id="msg"></div>
<script>
  var msg = document.getElementById('msg')
  // 动作忙时锁住所有按钮（实机反馈：第二个按钮还能点，于是变成「已有运行时下载任务」红字）。
  // 锁之前先记住哪些按钮本来就是置灰的（壳段在下载中），解锁时别把它们放出来。
  function setBusy(next) {
    var nodes = document.querySelectorAll('[data-op]')
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      if (next) {
        el.setAttribute('data-was-disabled', el.hasAttribute('disabled') ? '1' : '0')
        el.setAttribute('disabled', 'disabled')
      } else if (el.getAttribute('data-was-disabled') === '0') {
        el.removeAttribute('disabled')
      }
      if (!next) el.removeAttribute('data-was-disabled')
    }
  }
  function renderStatus(status) {
    var wrap = document.getElementById('dl')
    if (!wrap) return
    if (!status || status.active !== true) {
      wrap.setAttribute('hidden', 'hidden')
      return
    }
    wrap.removeAttribute('hidden')
    document.getElementById('dlfill').style.width = (status.percent || 0) + '%'
    document.getElementById('dltxt').textContent = '正在下载 ' + status.version + '　' + (status.percent || 0) + '%'
  }
  var statusTimer = null
  function pollStatus() {
    invokeShell(${jsString(UPDATE_NOTICE_STATUS_METHOD)}, null).then(renderStatus).catch(function () {})
  }
  function watchStatus() {
    if (statusTimer !== null) return
    pollStatus()
    statusTimer = setInterval(pollStatus, 700)
  }
  // 只有会拉包的两种动作才盯进度；「稍后」「不再提示」不碰网络。
  function wantsDownload(op) {
    if (op.op === 'runtime') return op.action === 'download-and-switch'
    if (op.op === 'update-all') return op.runtime !== undefined && op.runtime !== null
    return false
  }
  function send(op) {
    setBusy(true)
    msg.className = ''
    msg.textContent = '处理中…'
    if (wantsDownload(op)) watchStatus()
    invokeShell(${jsString(UPDATE_NOTICE_OP_METHOD)}, op).then(function (data) {
      window.__dshUpdateNoticeOp = op
      window.__dshUpdateNoticeOpResult = data
      if (data && data.ok === false) {
        msg.className = 'err'
        msg.textContent = (data && data.message) || '失败'
        setBusy(false)
        if (statusTimer !== null) { clearInterval(statusTimer); statusTimer = null }
        renderStatus(null)
        return
      }
      setTimeout(function () { window.close() }, 350)
    }).catch(function (error) {
      msg.className = 'err'
      msg.textContent = String(error)
      setBusy(false)
      if (statusTimer !== null) { clearInterval(statusTimer); statusTimer = null }
      renderStatus(null)
    })
  }
  // 动作走 Electrobun 官方 Typed RPC 的原生桥，不走 fetch（#139 实机修）：这扇窗是
  // html 文档，origin 是 views://internal，跟壳的 loopback 不同源——相对 URL 会解析到
  // views:// 协议（fetch 直接 TypeError: Failed to fetch），绝对 URL 也会被准入的同源判据
  // 挡掉（Sec-Fetch-Site: cross-site → 403）。原生桥不过这两道，也不必带 token。
  var rpcSeq = 0
  var rpcPending = {}
  function rpcReceive(packet) {
    if (!packet || packet.type !== 'response') return
    var waiter = rpcPending[packet.id]
    if (!waiter) return
    delete rpcPending[packet.id]
    if (packet.success === true) waiter.resolve(packet.payload)
    else waiter.reject(new Error(typeof packet.error === 'string' ? packet.error : 'shell rpc failed'))
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
    if (typeof post !== 'function') return Promise.reject(new Error('壳桥不可用，无法执行动作'))
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
  document.querySelectorAll('[data-op]').forEach(function (el) {
    el.addEventListener('click', function () {
      if (el.hasAttribute('disabled')) return
      var op = JSON.parse(el.getAttribute('data-op'))
      if (op.op === 'later') { window.__dshUpdateNoticeOp = op; window.close(); return }
      send(op)
    })
  })
  // 开窗时可能已经有下载在跑（面板点过、或上一张卡没关）：那就把进度摆出来、按钮锁上。
  invokeShell(${jsString(UPDATE_NOTICE_STATUS_METHOD)}, null).then(function (status) {
    renderStatus(status)
    if (status && status.active === true) setBusy(true)
  }).catch(function () {})
</script>
</body>
</html>
`
}

const RUNTIME_ACTIONS: readonly string[] = ['switch', 'download-and-switch']

/** 运行时动作目标：版本号 + 动作 + 目录来源（缺省 github，与壳命令面同口径）。 */
function runtimeTarget(raw: unknown): UpdateNoticeRuntimeTarget | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  const version = row['version']
  const action = row['action']
  if (typeof version !== 'string' || version === '') return null
  if (typeof action !== 'string' || !RUNTIME_ACTIONS.includes(action)) return null
  const source = row['source']
  return {
    version,
    action: action as RuntimeUpdateAction,
    source: typeof source === 'string' && source !== '' ? source : DEFAULT_CATALOG_SOURCE,
  }
}

/**
 * 服务面收到的请求体 → 动作（#139 消费）。认不出来的形状一律 null：
 * 页面是内嵌 HTML，但端点是回环 HTTP，按普通外部输入对待。
 */
export function updateNoticeOp(value: unknown): UpdateNoticeOp | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  switch (raw['op']) {
    case 'download-shell':
      return { op: 'download-shell' }
    case 'update-all': {
      const runtime = raw['runtime']
      const target = runtime === undefined || runtime === null ? null : runtimeTarget(runtime)
      // runtime 给了但形状不对 ⇒ 整个请求不认，不猜。
      if (runtime !== undefined && runtime !== null && target === null) return null
      return { op: 'update-all', shell: raw['shell'] === true, ...(target === null ? {} : { runtime: target }) }
    }
    case 'later':
      return { op: 'later' }
    case 'ignore': {
      const list = raw['targets']
      if (!Array.isArray(list)) return null
      const targets: UpdateNoticeTarget[] = []
      for (const item of list) {
        if (typeof item !== 'object' || item === null) return null
        const row = item as Record<string, unknown>
        const kind = row['kind']
        const version = row['version']
        if (kind !== 'shell' && kind !== 'runtime') return null
        if (typeof version !== 'string' || version === '') return null
        if (!targets.some((seen) => seen.kind === kind && seen.version === version)) targets.push({ kind, version })
      }
      if (targets.length === 0) return null
      return { op: 'ignore', targets }
    }
    case 'runtime': {
      const target = runtimeTarget(raw)
      return target === null ? null : { op: 'runtime', ...target }
    }
    default:
      return null
  }
}
