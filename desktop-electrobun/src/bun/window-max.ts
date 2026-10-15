// 窗口最大化辅助（#50 验证反馈系列）。
//
// 无边框（WS_POPUP）窗口的默认 WM_GETMINMAXINFO 是全显示器尺寸——Windows 只对
// 带 WS_MAXIMIZEBOX 的窗口把系统最大化缩到工作区（work area = 屏幕减任务栏）。
// 本模块提供三件事：①样式位补丁（ensureNativeMaximizeStyles：给本进程无边框窗补
// maximize/minimize/sysmenu 位，之后 maximize()/unmaximize() 全走系统行为）；
// ②工作区只读取法（getWorkAreaForFrame，bun:ffi user32）；③最大化态纯判定
// （deriveMaximized：原生旗标优先、几何兜底）。
//
// 维护者拍板（#80）：拒绝一切自绘窗口尺寸——本模块不做、仓内也不再有任何
// setFrame 式摆位，摆位全部交给系统 API。
//
// 取显示器不走 MonitorFromPoint（POINT 按值传参，FFI 结构体对齐风险），
// 走 MonitorFromRect（LPCRECT 指针）：把窗口帧装进 4×i32 缓冲即可。

import { dlopen, FFIType, JSCallback, ptr, type Pointer } from 'bun:ffi'

/** 窗口/工作区帧（screen coordinates, CSS px 语义与 BrowserWindow.getFrame 一致）。 */
export interface WindowFrame {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 帧相等容差（px）：工作区比对允许的残差，吃掉 DPI 取整与贴靠残边。
 * 设 8px：任务栏 40+px、贴靠吸附误差都在 ±1~2px，误判不了。
 */
export const FRAME_TOLERANCE_PX = 8

/**
 * 纯判定：当前帧是否「已最大化」。原生旗标优先（系统最大化的权威信号，
 * 实机上 getFrame 的坐标空间与工作区物理像素不一致时必须仍能判出）；几何比对
 * 只补旗标盖不到的场景（系统贴靠 Win+方向键、启动期旗标未落）。
 */
export function deriveMaximized(
  frame: WindowFrame,
  workArea: WindowFrame | null,
  nativeMaximized: boolean,
  tolerance: number = FRAME_TOLERANCE_PX,
): boolean {
  if (workArea === null) return nativeMaximized
  if (nativeMaximized) return true
  return (
    Math.abs(frame.x - workArea.x) <= tolerance &&
    Math.abs(frame.y - workArea.y) <= tolerance &&
    Math.abs(frame.width - workArea.width) <= tolerance &&
    Math.abs(frame.height - workArea.height) <= tolerance
  )
}

interface User32Symbols {
  monitorFromRect: (rect: Pointer | null, flags: number) => Pointer | bigint | null
  getMonitorInfoW: (hMonitor: Pointer | bigint | null, info: Pointer | null) => number
}

let user32: User32Symbols | null | undefined

function loadUser32(): User32Symbols | null {
  // 懒加载：dlopen 只在真调用的平台上发生（非 Windows 上 user32.dll 必失败）。
  try {
    const lib = dlopen('user32.dll', {
      MonitorFromRect: { args: [FFIType.pointer, FFIType.u32], returns: FFIType.pointer },
      GetMonitorInfoW: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.i32 },
    })
    return {
      monitorFromRect: (rect, flags) => lib.symbols.MonitorFromRect(rect, flags),
      getMonitorInfoW: (hMonitor, info) => lib.symbols.GetMonitorInfoW(hMonitor, info),
    }
  } catch {
    return null
  }
}

/** MONITOR_DEFAULTTONEAREST：含窗口帧的显示器（帧已不可见时取最近）。 */
const MONITOR_DEFAULTTONEAREST = 2
/** MONITORINFO 布局：cbSize(4) + rcMonitor(16) + rcWork(16) + dwFlags(4)。 */
const MONITORINFO_SIZE = 40
const RC_WORK_OFFSET = 20

/**
 * Windows：窗口帧所在显示器的工作区（屏幕减任务栏）。ffi 不可用 / 调用失败
 * 返回 null，调用方退回原生 maximize（老行为兜底，不比现状差）。
 */
export function getWorkAreaForFrame(near: WindowFrame): WindowFrame | null {
  if (process.platform !== 'win32') return null
  if (user32 === undefined) user32 = loadUser32()
  const lib = user32
  if (lib === null) return null
  try {
    // RECT{left,top,right,bottom} = 窗口帧（i32 ×4），取中心所在显示器足够。
    const rect = new Int32Array([
      Math.round(near.x),
      Math.round(near.y),
      Math.round(near.x + near.width),
      Math.round(near.y + near.height),
    ])
    const hMonitor = lib.monitorFromRect(ptr(rect), MONITOR_DEFAULTTONEAREST)
    if (!hMonitor) return null
    const info = new ArrayBuffer(MONITORINFO_SIZE)
    new DataView(info).setUint32(0, MONITORINFO_SIZE, true)
    if (lib.getMonitorInfoW(hMonitor, ptr(info)) === 0) return null
    const view = new DataView(info)
    const left = view.getInt32(RC_WORK_OFFSET, true)
    const top = view.getInt32(RC_WORK_OFFSET + 4, true)
    const right = view.getInt32(RC_WORK_OFFSET + 8, true)
    const bottom = view.getInt32(RC_WORK_OFFSET + 12, true)
    if (right <= left || bottom <= top) return null
    return { x: left, y: top, width: right - left, height: bottom - top }
  } catch {
    return null
  }
}

// ── 系统最大化样式补丁（上游 electrobun#558 的仓内落地，双屏跨屏修复）──────
//
// Windows 只在窗口带 WS_MAXIMIZEBOX 时，系统最大化（SW_MAXIMIZE）才按工作区
// 收缩；electrobun 原生建窗不带这组样式位 → 最大化盖任务栏（#50 反馈 ①），
// 自算宽度的手动 setFrame 在双屏下还会跨屏（#50 反馈 ④，维护者实测）。补丁：
// 给本进程的可见顶层窗补 WS_MAXIMIZEBOX|WS_MINIMIZEBOX|WS_SYSMENU
// （SetWindowLongW + SetWindowPos FRAMECHANGED），之后直接用原生 maximize()/
// unmaximize()——系统行为：按所在显示器工作区最大化、原生抽贴靠、原生还原。
// 只动自己进程的无边框窗，样式位不可见不改装。

const WS_MAXIMIZEBOX = 0x00010000
const WS_MINIMIZEBOX = 0x00020000
const WS_SYSMENU = 0x00080000
const GWL_STYLE = -16
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOZORDER = 0x0004
const SWP_FRAMECHANGED = 0x0020

interface StylePatchSymbols {
  getCurrentProcessId: () => number
  enumWindows: (cb: Pointer | null, lparam: Pointer | null) => number
  isWindowVisible: (hwnd: Pointer | bigint | null) => number
  getWindowThreadProcessId: (hwnd: Pointer | bigint | null, outPid: Pointer | null) => number
  getWindowLongW: (hwnd: Pointer | bigint | null, index: number) => number
  setWindowLongW: (hwnd: Pointer | bigint | null, index: number, value: number) => number
  setWindowPos: (
    hwnd: Pointer | bigint | null,
    after: Pointer | bigint | null,
    x: number,
    y: number,
    cx: number,
    cy: number,
    flags: number,
  ) => number
}

let styleLib: StylePatchSymbols | null | undefined

function loadStylePatchLib(): StylePatchSymbols | null {
  if (styleLib !== undefined) return styleLib
  try {
    const lib = dlopen('kernel32.dll', {
      GetCurrentProcessId: { args: [], returns: FFIType.u32 },
    })
    const user32 = dlopen('user32.dll', {
      EnumWindows: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.i32 },
      IsWindowVisible: { args: [FFIType.pointer], returns: FFIType.i32 },
      GetWindowThreadProcessId: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.u32 },
      GetWindowLongW: { args: [FFIType.pointer, FFIType.i32], returns: FFIType.i32 },
      SetWindowLongW: { args: [FFIType.pointer, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      SetWindowPos: { args: [FFIType.pointer, FFIType.pointer, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
    })
    styleLib = {
      getCurrentProcessId: () => lib.symbols.GetCurrentProcessId(),
      enumWindows: (cb, lp) => user32.symbols.EnumWindows(cb, lp),
      isWindowVisible: (hwnd) => user32.symbols.IsWindowVisible(hwnd),
      getWindowThreadProcessId: (hwnd, out) => user32.symbols.GetWindowThreadProcessId(hwnd, out),
      getWindowLongW: (hwnd, index) => user32.symbols.GetWindowLongW(hwnd, index),
      setWindowLongW: (hwnd, index, value) => user32.symbols.SetWindowLongW(hwnd, index, value),
      setWindowPos: (hwnd, after, x, y, cx, cy, flags) =>
        user32.symbols.SetWindowPos(hwnd, after, x, y, cx, cy, flags),
    }
  } catch {
    styleLib = null
  }
  return styleLib
}

/**
 * 给本进程的可见顶层无边框窗补系统最大化样式位（幂等：已带的跳过）。
 * EnumWindows 本就只枚举顶层窗，pid + 可见 + 缺 WS_MAXIMIZEBOX 三重过滤足够。
 * 返回 false = 平台非 Windows / ffi 不可用 / 枚举失败（调用方走手动 setFrame 兑底）。
 * 返回 false = 平台非 Windows / ffi 不可用 / 枚举失败（调用方直接原生 maximize）。
 */
export function ensureNativeMaximizeStyles(): boolean {
  if (process.platform !== 'win32') return false
  const lib = loadStylePatchLib()
  if (lib === null) return false
  try {
    const pid = lib.getCurrentProcessId()
    const callback = new JSCallback(
      (hwnd: Pointer) => {
        try {
          if (!lib.isWindowVisible(hwnd)) return 1
          const out = new Int32Array(1)
          lib.getWindowThreadProcessId(hwnd, ptr(out))
          if (out[0] !== pid) return 1
          const style = lib.getWindowLongW(hwnd, GWL_STYLE)
          if (style === 0 || (style & WS_MAXIMIZEBOX) !== 0) return 1
          lib.setWindowLongW(hwnd, GWL_STYLE, style | WS_MAXIMIZEBOX | WS_MINIMIZEBOX | WS_SYSMENU)
          lib.setWindowPos(hwnd, null, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED)
        } catch {
          // 单窗失败不拖累其它窗
        }
        return 1
      },
      { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.i32 },
    )
    return lib.enumWindows(callback.ptr, null) !== 0
  } catch {
    return false
  }
}
