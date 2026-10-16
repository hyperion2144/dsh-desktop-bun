// #69 开发者工具开关：打包态按设置决定是否开远程调试口并放出菜单。
// #106 起平台双载体：CEF（mac/linux）写 ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT（原生 dylib 读）；
// win 走系统 WebView2，无 CDP 桥，但 loader 官方支持 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
// win 走系统 WebView2：loader 官方支持 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 附加 CDP 口；
// DevTools 只按需出现（物理 F12 / 菜单合成 F12，文件尾），不自动弹窗——auto-open 参数实测（#106 返工二）逐窗都弹、太吵，废弃。
import { dlopen } from 'bun:ffi'
//
// 背景（triage 结论）：Electrobun 的 dev 构建自动开 CEF remote debugging，打包构建默认关；
// 打包态翻右键菜单的门控没有用——CEF 路径的 openDevTools() 是远程 DevTools 客户端，
// 口没开就什么都不会出现。所以本模块同时管两件事，且让它们由同一次启动决策推出：
//   1) 调试口 env —— 在任何渲染进程起来前写入（splash 就是第一个窗）：
//      CEF: ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT；win WebView2: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
//   2) 右键菜单 DevTools 入口可见性 —— 打包态：可见 ⇔ 口已开，禁中间态。
//
// 纯决策（本模块导出的 plan/menu 函数）与 IO（探活、env 双写）分离，方便单测。
// 注意：原生层用 C environ 读开关，Bun 的 process.env 运行期写入不穿透 C environ（实测，
// 2026-10-14 打包态复现：决策块写了 env 但 CEF 仍 disabled）。所以写入必须走 C environ 双写
// （mac: libSystem setenv；win: kernel32 SetEnvironmentVariableA——值全 ASCII，A 变体无损）。

/** Electrobun 原生层读的 CEF 远程调试口 env（libNativeWrapper.dylib 字符串证据）。 */
export const DEVTOOLS_PORT_ENV = 'ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT'
/** 壳自己的口覆盖 env：默认口被占时用户可换口，不必动代码。 */
export const DEVTOOLS_PORT_OVERRIDE_ENV = 'DSH_SHELL_DEVTOOLS_PORT'
/** 默认调试口：避开 9222（Chrome/VSCode 惯用）与 9229（Node inspector）。 */
export const DEVTOOLS_DEFAULT_PORT = 9333
/** win WebView2 loader 读的附加浏览器参数 env（loader 级官方开关，无需上游改；#106）。 */
export const WEBVIEW2_DEVTOOLS_ARGS_ENV = 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'

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
  /** 右键菜单「打开 DevTools」可见性 */
  menuEnabled: boolean
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
 * 启动决策：给定打包态 / 设置 / 覆盖 env / 探活注入，推出「写不写 env + 菜单显不显」。
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
    return { enableCdp: false, port: null, menuEnabled: devToolsMenuEnabled({ isPackaged: false, settingOn: input.settingOn, cdpReady: false }), reason: 'dev-build' }
  }
  if (!input.settingOn) {
    return { enableCdp: false, port: null, menuEnabled: devToolsMenuEnabled({ isPackaged: true, settingOn: false, cdpReady: false }), reason: 'disabled-by-setting' }
  }
  const port = resolveDevToolsPort({ envOverride: input.envOverride })
  if (port === null) {
    return { enableCdp: false, port: null, menuEnabled: devToolsMenuEnabled({ isPackaged: true, settingOn: true, cdpReady: false }), reason: 'port-invalid' }
  }
  if (!(await input.isFree(port))) {
    return { enableCdp: false, port, menuEnabled: devToolsMenuEnabled({ isPackaged: true, settingOn: true, cdpReady: false }), reason: 'port-unavailable' }
  }
  return { enableCdp: true, port, menuEnabled: devToolsMenuEnabled({ isPackaged: true, settingOn: true, cdpReady: true }), reason: 'enabled-by-setting' }
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

/** C environ 写入器的最小归一签名：写入成功 true（mac libc setenv / win kernel32 各自适配）。 */
export type CEnvWriter = (name: string, value: string) => boolean

let cEnvWriter: CEnvWriter | null | undefined

/** 惰性加载平台 C environ 写入器；加载失败记作不可用（调用方 fail-closed）。 */
function getCEnvWriter(): CEnvWriter | null {
  if (cEnvWriter !== undefined) return cEnvWriter
  try {
    if (process.platform === 'win32') {
      // SetEnvironmentVariableA：值全 ASCII（--remote-debugging-port=N），A 变体无损；Win32 环境块内部是 Unicode。
      const set = dlopen('kernel32.dll', {
        SetEnvironmentVariableA: { args: ['cstring', 'cstring'], returns: 'int' },
      }).symbols.SetEnvironmentVariableA
      cEnvWriter = (name, value) => set(name, value) !== 0
    } else {
      const set = dlopen('/usr/lib/libSystem.dylib', {
        setenv: { args: ['cstring', 'cstring', 'int'], returns: 'int' },
      }).symbols.setenv
      cEnvWriter = (name, value) => set(name, value, 1) === 0
    }
  } catch {
    cEnvWriter = null
  }
  return cEnvWriter
}

/**
 * 开调试口的 env 双写：Bun 进程内 map（子进程/日志可见）+ C environ（原生层读这个）。
 * 平台分叉（#106）：CEF（缺省）写 ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT=N；
 * win WebView2（cefAvailable:false）写 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=N，
 * 已有自定义参数时合并追加（Bun map 与 C environ 同值；放最后，同名开关后者生效），不覆盖用户配置。
 * 返回 false 表示 C environ 写入失败——调用方必须按 CDP 未开处理（fail-closed，菜单不出现）。
 * setEnvC 仅测试注入。
 */
export function applyCdpDebugPort(
  port: number,
  opts: { cefAvailable?: boolean; env?: Record<string, string | undefined>; setEnvC?: CEnvWriter | null } = {},
): boolean {
  const isCef = opts.cefAvailable !== false
  const envName = isCef ? DEVTOOLS_PORT_ENV : WEBVIEW2_DEVTOOLS_ARGS_ENV
  const value = isCef ? String(port) : `--remote-debugging-port=${String(port)}`
  const env = opts.env ?? process.env
  // win：已有自定义参数时合并追加（放最后，Chromium 同名开关后者生效）；CEF：直接覆盖写。
  // 两路写同一份值——C environ 是 WebView2 loader 实际读取的载体，绝不能只合并 Bun map。
  const existing = isCef ? '' : (env[envName]?.trim() ?? '')
  const written = isCef ? value : existing === '' ? value : `${existing} ${value}`
  env[envName] = written
  const setEnvC = opts.setEnvC !== undefined ? opts.setEnvC : getCEnvWriter()
  if (!setEnvC) return false
  return setEnvC(envName, written)
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
