// 窗口最大化辅助（#50 验证反馈系列）。
//
// 无边框（WS_POPUP）窗口的默认 WM_GETMINMAXINFO 是全显示器尺寸——Windows 只对
// 带 WS_MAXIMIZEBOX 的窗口把系统最大化缩到工作区（work area = 屏幕减任务栏）。
// 本模块提供三件事：①样式位补丁（ensureNativeMaximizeStyles：给本进程无边框窗补
// maximize/minimize/sysmenu 位，之后 maximize()/unmaximize() 全走系统行为）；
// ②工作区取逻辑屏幕工作区（screen-work-area.ts 选屏，index.ts 读 Screen）；③最大化态
// 纯判定（deriveMaximized：原生旗标优先、几何兜底）；④heal 自检的损坏判定与重摆裁决
// （isMaximizedPlacementDamaged + healVerdict，#80 三轮）。
//
// 维护者拍板（#80）：拒绝一切自绘窗口尺寸——本模块不做、仓内也不再有任何
// setFrame 式摆位，摆位全部交给系统 API。
//
// 坐标口径（#73）：getFrame 是 Electrobun 逻辑 px，工作区必须取同一空间（Screen 的
// display.workArea）。user32 GetMonitorInfoW 的物理 px 已弃用：2K@125% 下四边全差 20%，
// 几何兜底恒假，启动旗标未落时窗口态读成非最大化（标题栏单方框图标）。

import { dlopen, FFIType, JSCallback, ptr, type Pointer } from 'bun:ffi'

/** 窗口/工作区帧（screen coordinates, CSS px 语义与 BrowserWindow.getFrame 一致）。 */
export interface WindowFrame {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 最大化判定容差（px，每条边）：必须罩住 THICKFRAME 补偿带——100% 缩放下 ≈9px/边、
 * 125% 缩放下 7.2 逻辑px/边（#73 第五轮 2K 实测）；任务栏 40+px、贴靠吸附误差都在
 * ±1~2px。12px 既漏不掉真最大化、也误判不了普通窗口。
 */
export const MAXIMIZE_EDGE_TOLERANCE_PX = 12

/**
 * 纯判定：当前帧是否「已最大化」。原生旗标优先（系统最大化的权威信号）；几何比对
 * 只补旗标盖不到的场景（启动期旗标未落、系统贴靠 Win+方向键）。
 *
 * 按边比对（#73）：Windows 无边框窗（WS_POPUP）最大化时按隐形缩放边框把窗口四周
 * 外扩 THICKFRAME 补偿带（100% ≈9px/边、125% ≈7.2 逻辑px），x 与 width 同时偏、
 * 同号同量。逐项比 x/y/width/height 必须把容差放到 ≥9 才不漏判；按边比只需一条
 * 容差且语义直白。
 *
 * 坐标前提：frame（getFrame）与 workArea 必须同一坐标空间。生产路径注入 Screen 的
 * 逻辑工作区（screen-work-area.ts）；user32 rcWork 是物理 px，125% 下四边全差 20%、
 * 几何兜底恒假——那正是 #73「启动即最大化仍显示单方框」的根因，勿再回退。
 */
export function deriveMaximized(
  frame: WindowFrame,
  workArea: WindowFrame | null,
  nativeMaximized: boolean,
  tolerance: number = MAXIMIZE_EDGE_TOLERANCE_PX,
): boolean {
  if (workArea === null) return nativeMaximized
  if (nativeMaximized) return true
  return (
    Math.abs(frame.x - workArea.x) <= tolerance &&
    Math.abs(frame.y - workArea.y) <= tolerance &&
    Math.abs(frame.x + frame.width - (workArea.x + workArea.width)) <= tolerance &&
    Math.abs(frame.y + frame.height - (workArea.y + workArea.height)) <= tolerance
  )
}

/**
 * heal 自检容差：判「落位损坏」的外扩上限。实测标定（#80 第五轮实机日志，2K@125%）：
 * 系统对本类 THICKFRAME 无边框窗的**正常最大化落位**就是工作区四周外扩 9 物理px
 * （隐形边框补偿），getFrame 返回逻辑px（÷1.25）→ 补偿读数 7.2px，每次最大化恒在；
 * 100% 缩放下补偿即 ~9px 逻辑值。容差须站上补偿带（≥9px）、远低于真损伤（票面的
 * 恢复截断是整块顶边，远超 12），取 12。旧值 4px 把补偿读数当损坏，每次最大化
 * 白重摆 3 次（实机「最大化闪几下」的直接来源）。
 */
export const PLACEMENT_DAMAGE_TOLERANCE_PX = 12

/**
 * frame 相对 workArea 的外扩量：四条边各自「越出工作区多少像素」取最大（左/上
 * 越出取 workArea 减 frame，右/下超出取 frame 减 workArea；整体向内为负）。
 */
export function frameOvershoot(frame: WindowFrame, workArea: WindowFrame): number {
  return Math.max(
    workArea.x - frame.x,
    workArea.y - frame.y,
    frame.x + frame.width - (workArea.x + workArea.width),
    frame.y + frame.height - (workArea.y + workArea.height),
  )
}

/**
 * heal 自检的损坏判定（#80 三轮根因修复）：最大化旗标为真时审查几何——外扩量
 * 超出损坏容差才判损坏、才原生重摆。只认外扩、不认对称差值：THICKFRAME 补偿
 * 只会把窗向外撑；等比错位只会让读数整体偏小，overshoot ≤ 0 不会误报。
 *
 * 补偿带内的外扩是**正常落位**（第五轮实机标定：每次最大化四周恒外扩 9 物理px，
 * 见容差注释），heal 不得干预——第五轮「每次最大化闪 3 下」就是旧 4px 容差把
 * 7.2px 补偿读数当损坏、每次最大化连重摆 3 次所致；重摆后系统照旧补偿，frame
 * 纹丝不动（heal 修不好常态），白闪。容差只在真损伤（恢复复利式越位，远超补偿带）
 * 时才让 heal 出手。
 *
 * 不复用 deriveMaximized：那是状态推导，旗标为真恒真（坐标空间不一致也信旗标）；
 * 这里恰恰相反，专审「旗标为真时是否外扩超带」。两个相反的语义塞不进同一个函数——
 * 第三轮重开（双屏 2K 越屏依旧）的根因就是 heal 错借了它，判定恒真、自愈从未触发。
 *
 * 坐标口径（#73 修正）：heal 与状态判定现在都取 Screen 逻辑工作区，frame 与 workArea
 * 同属逻辑坐标系（2K@125% 实测 frame=物理帧÷1.25、workArea=物理工作区÷1.25），
 * 补偿带 7.2 逻辑px 由容差吸收。若将来工作区退回物理 px，读数会整体偏小（方向性
 * 不误报），更高缩放会把真损伤压进容差，届时以 heal 日志数值再标定。
 */
export function isMaximizedPlacementDamaged(
  frame: WindowFrame,
  workArea: WindowFrame,
  tolerance: number = PLACEMENT_DAMAGE_TOLERANCE_PX,
): boolean {
  return frameOvershoot(frame, workArea) > tolerance
}

/** 同段最大化期内允许的原生重摆上限：超过说明重摆也落不好（部分机器上游
 * THICKFRAME 补偿恒外扩），停下防「检查→重摆→resize→再检查」循环闪窗，日志留给
 * 上游 WM_NCCALCSIZE 根治（electrobun#417 关闭未合、#558 仍开）。 */
export const HEAL_MAX_REPLACES = 3

export type HealVerdict = 'clean' | 'replace' | 'exhausted'

/**
 * heal 裁决（纯函数，重摆计数的状态机；index.ts 只做副作用）：
 * 不损坏 → clean（不计数、也不重置已计数）；损坏且未达上限 → replace；已达上限 → exhausted。
 */
export function healVerdict(damaged: boolean, priorReplaces: number): HealVerdict {
  if (!damaged) return 'clean'
  return priorReplaces >= HEAL_MAX_REPLACES ? 'exhausted' : 'replace'
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

// ── 聚合判定与切换（RPC 漏斗与 /__shell__/window 端点共用，#112 抽取）────
//
// 抽取前这两段逻辑在 rpc-bridge.ts（漏斗，可注入）与 index.ts（HTTP 端点）各写一份；
// 现在收口在本模块——本模块的既定职责就是最大化态判定（见文件头③）。

/** 原生窗口动作面（BrowserWindow 的结构子集；测试可注入假窗）。 */
export interface NativeWindowActions {
  getFrame(): WindowFrame
  isMaximized(): boolean
  maximize(): void
  unmaximize(): void
}

/** 逻辑工作区取法：给定窗口帧返回所在显示器工作区；null = 取不到（判定退回原生旗标）。 */
export type WorkAreaLookup = (near: WindowFrame) => WindowFrame | null

/** 平台/工作区/样式补丁的注入点（测试用；缺省见各字段）。 */
export interface WindowMaxOptions {
  /** 平台（缺省 process.platform）。 */
  platform?: NodeJS.Platform
  /** 逻辑工作区取法（缺省 null＝只看原生旗标；#73 生产由 index.ts 注入 Screen 工作区）。 */
  workArea?: WorkAreaLookup
  /** 样式补丁生效动作（缺省 win32 走枚举补丁，其余平台恒 false；幂等可重入）。 */
  maximizeStylesPatched?: () => boolean
}

/** 未注入工作区取法时的缺省：返回 null → win32 判定退回原生旗标（与旧非 win32 语义一致）。 */
export const NO_WORK_AREA: WorkAreaLookup = () => null

/** 最大化态聚合结果（GET /__shell__/window 的载荷形状）。 */
export interface WindowMaxState {
  maximized: boolean
}

/**
 * 自绘窗口控制的三个动作（页面三键 → 主进程操作 BrowserWindow）。
 *
 * 本模块既有职责就是「窗口动作的收口」，动作集合也归这里：service.ts 的 onWindowControl 签名、
 * shell-server.ts 的 /__shell__/window 校验、titlebar.ts 的动作→RPC 方法映射三处各写一份联合类型，
 * 迟早漂移（#128）。改成从这儿取，titlebar 的映射表就能被键集合锁住——
 * 拼错的动作名在编译期报错，而不是在页面里静默不响应。
 */
export type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close'

/** 同上，运行期形态：HTTP 端点校验与「已知动作」判定用它，避免再写一遍三连比较。 */
export const WINDOW_CONTROL_ACTIONS: readonly WindowControlAction[] = ['minimize', 'toggle-maximize', 'close']

/**
 * 字符串→动作的类型守卫。HTTP 路由拿到的永远是 string，没有守卫就没法收窄，
 * 收窄不了就只能把 action 直接当 WindowControlAction 用——那等于没校验。
 */
export function isWindowControlAction(value: string): value is WindowControlAction {
  return (WINDOW_CONTROL_ACTIONS as readonly string[]).includes(value)
}

/**
 * 最大化态聚合判定：win32 用工作区几何兑底原生旗标，其余平台只看旗标。
 * rpc-bridge（window_get_state）与 index.ts（onWindowState / toggle 判定）共用。
 */
export function windowMaxState(
  win: Pick<NativeWindowActions, 'getFrame' | 'isMaximized'>,
  opts: WindowMaxOptions = {},
): WindowMaxState {
  const platform = opts.platform ?? process.platform
  const workAreaOf = opts.workArea ?? NO_WORK_AREA
  const frame = win.getFrame()
  const workArea = platform === 'win32' ? workAreaOf(frame) : null
  return { maximized: deriveMaximized(frame, workArea, win.isMaximized()) }
}

/**
 * 原生最大化切换（#80 拍板：任何情况下不用 setFrame 自摆）。maximize 方向先补
 * win32 样式位（否则 SW_MAXIMIZE 不按工作区收缩，上游 #558），补丁失败也直接
 * 原生 maximize。
 */
export function toggleWindowMaximize(win: NativeWindowActions, opts: WindowMaxOptions = {}): void {
  const platform = opts.platform ?? process.platform
  const { maximized } = windowMaxState(win, opts)
  if (maximized) {
    win.unmaximize()
    return
  }
  const stylesPatched =
    opts.maximizeStylesPatched ?? (() => (platform === 'win32' ? ensureNativeMaximizeStyles() : false))
  if (platform === 'win32') stylesPatched()
  win.maximize()
}
