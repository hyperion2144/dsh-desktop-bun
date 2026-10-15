// #69 开发者工具开关：打包态按设置决定是否给 CEF 开远程调试口并放出菜单。
import { dlopen } from 'bun:ffi'
//
// 背景（triage 结论）：Electrobun 的 dev 构建自动开 CEF remote debugging，打包构建默认关；
// 打包态翻右键菜单的门控没有用——CEF 路径的 openDevTools() 是远程 DevTools 客户端，
// 口没开就什么都不会出现。所以本模块同时管两件事，且让它们由同一次启动决策推出：
//   1) env ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT —— 在任何 CEF 进程起来前写入（splash 就是 CEF 窗）；
//   2) 右键菜单「打开 DevTools」可见性 —— 打包态：菜单可见 ⇔ 口已开，禁中间态。
//
// 纯决策（本模块导出的 plan/menu 函数）与 IO（探活、env 双写）分离，方便单测。
// 注意：dylib 用 C getenv 读开关，Bun 的 process.env 运行期写入不穿透 C environ（实测，
// 2026-10-14 打包态复现：决策块写了 env 但 CEF 仍 disabled）。所以写入必须走 libc setenv 双写。

/** Electrobun 原生层读的 CEF 远程调试口 env（libNativeWrapper.dylib 字符串证据）。 */
export const DEVTOOLS_PORT_ENV = 'ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT'
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
  /** 是否给 CEF 写远程调试口 env（＝重启后口是否真的在听） */
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
  /** 本次启动的 CEF 远程调试口是否真的开了 */
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

/** libc setenv 的最小签名（仅本模块用）。 */
export type LibcSetenv = (name: string, value: string, overwrite: number) => number

let libcSetenv: LibcSetenv | null | undefined

/** 惰性加载 libSystem 的 setenv；加载失败记作不可用（调用方 fail-closed）。 */
function getLibcSetenv(): LibcSetenv | null {
  if (libcSetenv !== undefined) return libcSetenv
  try {
    libcSetenv = dlopen('/usr/lib/libSystem.dylib', {
      setenv: { args: ['cstring', 'cstring', 'int'], returns: 'int' },
    }).symbols.setenv as LibcSetenv
  } catch {
    libcSetenv = null
  }
  return libcSetenv
}

/**
 * 给 CEF 开调试口的 env 双写：Bun 进程内 map（子进程/日志可见）+ C environ（dylib 的 getenv 读这个）。
 * 返回 false 表示 C environ 写入失败——调用方必须按 CDP 未开处理（fail-closed，菜单不出现）。
 * setEnvC 仅测试注入。
 */
export function applyCdpDebugPort(
  port: number,
  opts: { env?: Record<string, string | undefined>; setEnvC?: LibcSetenv | null } = {},
): boolean {
  const value = String(port)
  ;(opts.env ?? process.env)[DEVTOOLS_PORT_ENV] = value
  const setEnvC = opts.setEnvC !== undefined ? opts.setEnvC : getLibcSetenv()
  if (!setEnvC) return false
  return setEnvC(DEVTOOLS_PORT_ENV, value, 1) === 0
}
