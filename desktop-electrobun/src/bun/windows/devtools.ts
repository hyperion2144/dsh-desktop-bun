// #69 开发者工具开关：打包态按设置决定是否开远程调试口并放出菜单。
// #106 起平台双载体：CEF（mac/linux）写 ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT（原生 dylib 读）；
// win 走系统 WebView2，写 loader 官方支持的 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 附加 CDP 口。
// 载体差异（env 名/值编码/C environ 写入器/DevTools 打开方式）统一收在 render-backend.ts 的描述符（#110）。
// DevTools 只按需出现（物理 F12 / 菜单合成 F12，文件尾），不自动弹窗——auto-open 参数实测（#106 返工二）逐窗都弹、太吵，废弃。
import { dlopen } from 'bun:ffi'
import type { CEnvWriter, RenderBackend } from './render-backend.ts'
//
// 背景（triage 结论）：Electrobun 的 dev 构建自动开 CEF remote debugging，打包构建默认关；
// 打包态翻右键菜单的门控没有用——CEF 路径的 openDevTools() 是远程 DevTools 客户端，
// 口没开就什么都不会出现。所以本模块同时管两件事，且让它们由同一次启动决策推出：
//   1) 调试口 env —— 在任何渲染进程起来前写入（splash 就是第一个窗）：
//      载体（env 名/值编码）见 render-backend.ts 的渲染后端描述符（#110）。
//   2) 右键菜单 DevTools 入口可见性 —— 打包态：可见 ⇔ 口已开，禁中间态。
//
// 纯决策（本模块导出的 plan/menu 函数）与 IO（探活、env 双写）分离，方便单测。
// 注意：原生层用 C environ 读开关，Bun 的 process.env 运行期写入不穿透 C environ（实测，
// 2026-10-14 打包态复现：决策块写了 env 但 CEF 仍 disabled）。所以写入必须走 C environ 双写
// （mac: libSystem setenv；win: kernel32 SetEnvironmentVariableA——值全 ASCII，A 变体无损）。

/** 壳自己的口覆盖 env：默认口被占时用户可换口，不必动代码。 */
export const DEVTOOLS_PORT_OVERRIDE_ENV = 'DSH_SHELL_DEVTOOLS_PORT'
/** 默认调试口：避开 9222（Chrome/VSCode 惯用）与 9229（Node inspector）。 */
export const DEVTOOLS_DEFAULT_PORT = 9333

export type DevToolsBootReason =
  | 'dev-build' // 未打包：Electrobun 自动开调试口，菜单恒可见，本模块不碰 env
  | 'enabled-by-setting' // 打包态 + 开关开 + 口可用：写 env、出菜单
  | 'disabled-by-setting' // 打包态 + 开关关（或缺省）：不碰 env、不出菜单
  | 'port-invalid' // 覆盖 env 不是 1-65535 整数：按未开启处理（fail-closed）
  | 'port-unavailable' // 口被占：本次不开（fail-closed），提示换口

export interface DevToolsBootPlan {
  /** 是否写远程调试口 env（CEF 或 win WebView2 载体；＝重启后口是否真的在听） */
  enableCdp: boolean
  /** 选定的口；不启用或口非法时为 null（port-unavailable 时回显被占的口供日志） */
  port: number | null
  reason: DevToolsBootReason
}

export interface DevToolsMenuInput {
  isPackaged: boolean
  /** 设置 dev_tools 是否为 true */
  settingOn: boolean
  /** 本次启动的远程调试口是否真的开了（CEF 与 win WebView2 同义） */
  cdpReady: boolean
}

/**
 * 菜单可见性的唯一事实源：dev 构建恒可见；打包态「开关开 且 口已开」才可见。
 * 不变式：打包态菜单可见 ⇔ CDP 口已开（口关着出菜单 = 点了没反应的骗局；口开着藏菜单 = 藏功能）。
 * 每次弹菜单按实时设置重算（#119），cdpReady 取启动快照——plan 不再带 menuEnabled（#110）。
 */
export function devToolsMenuEnabled(input: DevToolsMenuInput): boolean {
  if (!input.isPackaged) return true
  return input.settingOn && input.cdpReady
}

/** 口解析：无覆盖回默认；有覆盖必须是 1-65535 的整数，否则 null（调用方 fail-closed）。 */
export function resolveDevToolsPort(input: { envOverride?: string | undefined }): number | null {
  const raw = (input.envOverride ?? '').trim()
  if (raw === '') return DEVTOOLS_DEFAULT_PORT
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null
  return parsed
}

/**
 * 启动决策：给定打包态 / 设置 / 覆盖 env / 探活注入，推出「本次开不开 CDP 口、写不写 env」。
 * 菜单可见性不在这里拍板（#110）：index.ts 每次弹菜单用 devToolsMenuEnabled 按实时设置重算，
 * cdpReady 取本 plan 的启动快照；plan 再带一份 menuEnabled 只会与实时值漂移。
 * isFree 注入（async）让本函数保持可测；index.ts 传 isPortBindable。
 * 任何失败路径都 fail-closed：宁可不端口不出菜单，不开出一个用户不知情的调试口。
 */
export async function planDevToolsBoot(input: {
  isPackaged: boolean
  settingOn: boolean
  envOverride?: string | undefined
  isFree: (port: number) => Promise<boolean>
}): Promise<DevToolsBootPlan> {
  if (!input.isPackaged) {
    return { enableCdp: false, port: null, reason: 'dev-build' }
  }
  if (!input.settingOn) {
    return { enableCdp: false, port: null, reason: 'disabled-by-setting' }
  }
  const port = resolveDevToolsPort({ envOverride: input.envOverride })
  if (port === null) {
    return { enableCdp: false, port: null, reason: 'port-invalid' }
  }
  if (!(await input.isFree(port))) {
    return { enableCdp: false, port, reason: 'port-unavailable' }
  }
  return { enableCdp: true, port, reason: 'enabled-by-setting' }
}

/**
 * 口探活：与 service.ts 的 portFree 同语义——127.0.0.1 与 0.0.0.0 都要能绑才算空闲
 * （macOS 上「别人占着 *:P」时只试 loopback 会误判成空闲，CEF 起来才炸）。
 */
export async function isPortBindable(port: number): Promise<boolean> {
  for (const hostname of ['127.0.0.1', '0.0.0.0']) {
    let server: Bun.TCPSocketListener | undefined
    try {
      server = Bun.listen({ hostname, port, socket: { data() {}, open() {}, close() {} } })
    } catch {
      return false
    } finally {
      server?.stop(true)
    }
  }
  return true
}

/**
 * 开调试口的 env 双写：Bun 进程内 map（子进程/日志可见）+ C environ（原生层读这个）。
 * 载体全部来自渲染后端描述符（#110）：CEF 写 ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT=N；
 * win WebView2 写 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=N
 * （已有自定义参数时合并追加：Bun map 与 C environ 同值；放最后，同名开关后者生效，不覆盖用户配置）。
 * 返回 false 表示 C environ 写入失败——调用方必须按 CDP 未开处理（fail-closed，菜单不出现）。
 * setEnvC 仅测试注入。
 */
export function applyCdpDebugPort(
  port: number,
  opts: { backend: RenderBackend; env?: Record<string, string | undefined>; setEnvC?: CEnvWriter | null },
): boolean {
  const carrier = opts.backend.devToolsEnv
  const value = carrier.encode(port)
  // 两路写同一份值——C environ 是 loader 实际读取的载体，绝不能只合并 Bun map。
  const env = opts.env ?? process.env
  const existing = carrier.appendToExisting ? (env[carrier.name]?.trim() ?? '') : ''
  const written = existing === '' ? value : `${existing} ${value}`
  env[carrier.name] = written
  const setEnvC = opts.setEnvC !== undefined ? opts.setEnvC : opts.backend.createCEnvWriter()
  if (!setEnvC) return false
  return setEnvC(carrier.name, written)
}

/** user32 keybd_event 的最小签名（win 专属；dwExtraInfo 是 ULONG_PTR，Bun FFI u64 收 BigInt）。 */
export type KeybdEvent = (vKey: number, scan: number, flags: number, extra: bigint) => void

/** VK_F12：WebView2 默认 AreDevToolsEnabled=true（上游壳未关），F12/Ctrl+Shift+I 即原生 DevTools 开/关。 */
export const VK_F12 = 0x7b
const KEYEVENTF_KEYUP = 0x0002

let keybdEvent: KeybdEvent | null | undefined

/** 惰性加载 user32 keybd_event；非 win 或加载失败记作不可用（调用方回退提示物理 F12）。 */
function getKeybdEvent(): KeybdEvent | null {
  if (keybdEvent !== undefined) return keybdEvent
  try {
    if (process.platform !== 'win32') {
      keybdEvent = null
    } else {
      const send = dlopen('user32.dll', {
        keybd_event: { args: ['u8', 'u8', 'u32', 'u64'], returns: 'void' },
      }).symbols.keybd_event
      keybdEvent = (vKey, scan, flags, extra) => send(vKey, scan, flags, extra)
    }
  } catch {
    keybdEvent = null
  }
  return keybdEvent
}

/**
 * 合成一次 F12 键击（按下+抬起）：与物理 F12 走完全相同的 WebView2 输入路径，开/关原生 DevTools 窗。
 * 仅 win 有意义（CEF 平台走 BrowserView.openDevTools）；返回 false = 平台不支持或 user32 不可用。
 * 限制与物理按键相同：焦点需落在页面上。keybdEvent 仅测试注入。
 */
export function sendDevToolsKeystroke(opts: { keybdEvent?: KeybdEvent | null } = {}): boolean {
  const send = opts.keybdEvent !== undefined ? opts.keybdEvent : getKeybdEvent()
  if (!send) return false
  send(VK_F12, 0, 0, 0n)
  send(VK_F12, 0, KEYEVENTF_KEYUP, 0n)
  return true
}

// ---- DevTools 前端（壳托管，跨平台）----
// 原生 openDevTools 的 undocked inspector 是 CEF 自己的窗口：用户点关闭只关窗口，DevTools 的
// renderer/target 仍活着（实测：关窗后 /json/list 里 inspector target 还在，继续吃 GPU）。
// 改成壳自己建一扇 BrowserWindow 加载 CDP 前端：窗口归壳所有，关闭即销毁页面；三平台同一条
// 路径，不靠窗口枚举/尺寸/标题猜测。

export interface CdpTarget {
  id: string
  type?: string
  url?: string
  webSocketDebuggerUrl?: string
}

export interface CdpVersion {
  webSocketDebuggerUrl?: string
}

/**
 * 选出 DevTools 前端要连的页面目标：排除 inspector 自身与空目标；优先 type=page。
 * /json/list 里同时有页面、旧 inspector、以及无 url 的空目标，不能拿「第一条」。
 */
export function pickDevToolsPageTarget(targets: CdpTarget[]): CdpTarget | null {
  const candidates = targets.filter((target) => {
    if (typeof target.url !== 'string' || target.url === '') return false
    return !target.url.includes('/devtools/inspector.html')
  })
  return candidates.find((target) => target.type === 'page') ?? candidates[0] ?? null
}

/** 用页面目标的 webSocketDebuggerUrl 组装 CDP 前端 URL（与 CEF 原生 devtools URL 同形）。 */
export function buildDevToolsInspectorUrl(port: number, page: CdpTarget): string | null {
  const ws = typeof page.webSocketDebuggerUrl === 'string' ? page.webSocketDebuggerUrl : ''
  if (ws === '') return null
  // WebView2 的 /json/list 可能回 localhost；前端页在 127.0.0.1 上，localhost 解析到 ::1（IPv6）会连到没人听的栈（#205）
  const wsParam = ws.replace(/^wss?:\/\//, '').replace(/^localhost(?=:)/, '127.0.0.1')
  return `http://127.0.0.1:${port}/devtools/inspector.html?ws=${wsParam}&dockSide=undocked`
}

/** 读 /json/list 拿页面目标并组装前端 URL；拿不到返回 null（调用方只记日志，不重试）。 */
export async function resolveDevToolsInspectorUrl(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!response.ok) return null
    const targets = (await response.json()) as CdpTarget[]
    const page = pickDevToolsPageTarget(targets)
    if (page === null) return null
    return buildDevToolsInspectorUrl(port, page)
  } catch {
    return null
  }
}

/**
 * 关闭旧入口留下的 inspector target（原生 openDevTools/上一版壳）。
 * 必须在壳自己的 DevTools 窗口创建之前调用——新窗口的前端是普通页面目标，不在这个列表里。
 * 走 /json/version 的 browser webSocketDebuggerUrl；失败返回 false（不影响新窗口打开）。
 */
export async function closeDevToolsTarget(port: number): Promise<boolean> {
  try {
    const listResponse = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!listResponse.ok) return false
    const targets = (await listResponse.json()) as CdpTarget[]
    const inspector = targets.find((target) => typeof target.url === 'string' && target.url.includes('/devtools/inspector.html'))
    if (inspector === undefined) return false
    const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`)
    if (!versionResponse.ok) return false
    const version = (await versionResponse.json()) as CdpVersion
    const browserUrl = version.webSocketDebuggerUrl
    if (browserUrl === undefined || browserUrl === '') return false
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { socket.close() } catch { /* 已断开 */ }
        resolve(value)
      }
      const timer = setTimeout(() => finish(false), 3000)
      const socket = new WebSocket(browserUrl)
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId: inspector.id } }))
      })
      socket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { id?: number; error?: unknown }
          if (message.id === 1) finish(message.error === undefined)
        } catch { /* 非 JSON 帧忽略 */ }
      })
      socket.addEventListener('error', () => finish(false))
      socket.addEventListener('close', () => finish(false))
    })
  } catch {
    return false
  }
}
