// 渲染后端描述符（#110）：把「本构建跑在哪个渲染后端」收成一份事实源。
//
// 历史：#106 起平台双载体（CEF / win WebView2），同一个事实却散成五处同义分叉——
// `cefAvailable` 布尔入参、调试口 env 名三元、env 值三元、C environ 写入器的
// `process.platform` 分支、以及 index.ts 的日志措辞与「打开 DevTools」形态三元。
// 每加一个后端都得把这些落点全找齐；现在各消费点只从描述符取字段。
//
// 域概念是「渲染后端」（cef / webview2），不是「cef 可不可用」：
//   - renderer：交给 BrowserWindow / BrowserView 的 renderer 名（#84 三处开关之一）
//   - devToolsEnv：远程调试口的 C environ 载体（env 名 + 值编码 + 合并语义）
//   - devToolsOpen：「打开 DevTools」的落地方式（应用内 inspector / 壳合成 F12）
//   - createCEnvWriter：该载体读的 C environ 写入器（libc setenv / kernel32）
//
// 本模块只有声明与惰性 FFI：导入时不 dlopen，第一次真写 env 才加载。
import { dlopen } from 'bun:ffi'

/** C environ 写入器：写入成功 true（mac libc setenv / win kernel32 SetEnvironmentVariableA 各自适配）。 */
export type CEnvWriter = (name: string, value: string) => boolean

/** Electrobun 原生层读的 CEF 远程调试口 env（libNativeWrapper.dylib 字符串证据）。 */
export const DEVTOOLS_PORT_ENV = 'ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT'
/** win WebView2 loader 读的附加浏览器参数 env（loader 级官方开关，无需上游改；#106）。 */
export const WEBVIEW2_DEVTOOLS_ARGS_ENV = 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'

export type RenderBackendKind = 'cef' | 'webview2'

/** 远程调试口的 C environ 载体：原生层读哪个 env、值长什么样、已有值怎么合。 */
export interface DevToolsEnvCarrier {
  /** 原生层实际读取的 env 名 */
  readonly name: string
  /** 调试口 → env 值（CEF 写裸端口；WebView2 写浏览器参数） */
  readonly encode: (port: number) => string
  /** 已有自定义值时追加在后（同名开关后者生效）而非覆盖；CEF 直接覆盖 */
  readonly appendToExisting: boolean
}

/** 渲染后端描述符：各消费点只从这里取字段，不再各自判平台/布尔。 */
export interface RenderBackend {
  readonly kind: RenderBackendKind
  /** BrowserWindow / BrowserView 建窗用的 renderer 名（#84） */
  readonly renderer: 'cef' | 'native'
  /** 日志与提示里的后端名 */
  readonly label: 'CEF' | 'WebView2'
  /** 远程调试口的 C environ 载体 */
  readonly devToolsEnv: DevToolsEnvCarrier
  /** 菜单「打开 DevTools」的落地方式：应用内 inspector / 壳合成 F12 */
  readonly devToolsOpen: 'inspector' | 'keystroke'
  /** 开启调试口日志里的附加说明（空串＝无） */
  readonly devToolsLogHint: string
  /** 该后端对应的 C environ 写入器（惰性 dlopen；加载失败 null，调用方 fail-closed） */
  readonly createCEnvWriter: () => CEnvWriter | null
}

let libcCEnvWriter: CEnvWriter | null | undefined

/** libc setenv（mac；Linux 上没有 libSystem，加载失败记 null → 调用方 fail-closed）。 */
function createLibcCEnvWriter(): CEnvWriter | null {
  if (libcCEnvWriter !== undefined) return libcCEnvWriter
  try {
    const set = dlopen('/usr/lib/libSystem.dylib', {
      setenv: { args: ['cstring', 'cstring', 'int'], returns: 'int' },
    }).symbols.setenv
    libcCEnvWriter = (name, value) => set(name, value, 1) === 0
  } catch {
    libcCEnvWriter = null
  }
  return libcCEnvWriter
}

let kernel32CEnvWriter: CEnvWriter | null | undefined

/** SetEnvironmentVariableA：值全 ASCII（--remote-debugging-port=N），A 变体无损；Win32 环境块内部是 Unicode。 */
function createKernel32CEnvWriter(): CEnvWriter | null {
  if (kernel32CEnvWriter !== undefined) return kernel32CEnvWriter
  try {
    const set = dlopen('kernel32.dll', {
      SetEnvironmentVariableA: { args: ['cstring', 'cstring'], returns: 'int' },
    }).symbols.SetEnvironmentVariableA
    kernel32CEnvWriter = (name, value) => set(name, value) !== 0
  } catch {
    kernel32CEnvWriter = null
  }
  return kernel32CEnvWriter
}

/** CEF（mac/linux）：Electrobun 原生 dylib 直接读端口号；DevTools 走应用内 inspector。 */
export const CEF_RENDER_BACKEND: RenderBackend = {
  kind: 'cef',
  renderer: 'cef',
  label: 'CEF',
  devToolsEnv: {
    name: DEVTOOLS_PORT_ENV,
    encode: (port) => String(port),
    appendToExisting: false,
  },
  devToolsOpen: 'inspector',
  devToolsLogHint: '',
  createCEnvWriter: createLibcCEnvWriter,
}

/** win WebView2：CDP 口经 loader 的附加浏览器参数；DevTools 走壳合成 F12（上游无 openDevTools 实现）。 */
export const WEBVIEW2_RENDER_BACKEND: RenderBackend = {
  kind: 'webview2',
  renderer: 'native',
  label: 'WebView2',
  devToolsEnv: {
    name: WEBVIEW2_DEVTOOLS_ARGS_ENV,
    encode: (port) => `--remote-debugging-port=${String(port)}`,
    appendToExisting: true,
  },
  devToolsOpen: 'keystroke',
  devToolsLogHint: '；DevTools 按需打开：F12 或右键菜单（合成 F12），不自动弹窗',
  createCEnvWriter: createKernel32CEnvWriter,
}

/** 构建期唯一选择点：availableRenderers 含 cef ＝ CEF（mac/linux），否则系统 WebView2（win）。 */
export function resolveRenderBackend(input: { availableRenderers: readonly string[] }): RenderBackend {
  return input.availableRenderers.includes('cef') ? CEF_RENDER_BACKEND : WEBVIEW2_RENDER_BACKEND
}
