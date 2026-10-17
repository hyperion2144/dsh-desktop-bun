// 逻辑屏幕工作区选择（#73）：Screen.getAllDisplays() → 窗口所在显示器的 workArea。
//
// 为什么不能沿用 user32 GetMonitorInfoW：Windows 上它返回物理 px，而 BrowserWindow.getFrame
// 返回 Electrobun 逻辑 px——2K@125% 实测最大化帧 2062.4×1118.4 = (2560+18)/1.25，rcWork 却是
// 2560×1380。两套坐标直接比，四边全差一个缩放比，几何兜底恒假；启动时 WS_MAXIMIZE 旗标
// 又可能还没落，window_get_state 于是回 false（#73 标题栏单方框图标的根因）。
// Screen.getAllDisplays() 的 bounds/workArea 与 getFrame 同属逻辑坐标系（上游 Windows 侧
// 构建的就是 logicalBounds/logicalWorkArea），选屏后再交 deriveMaximized 判定即可同空间比较。
//
// 本模块只做纯几何选择；Screen 的读取留在 index.ts（单测不必拉起 electrobun 运行时）。
import type { WindowFrame } from './window-max.ts'

/** 一次显示器快照（Screen.getAllDisplays() 的结构子集；bounds 与 workArea 同属逻辑坐标）。 */
export interface DisplayWorkArea {
  bounds: WindowFrame
  workArea: WindowFrame
}

/** 可用矩形：坐标有限、宽高为正。Screen 返回的数值偶尔带小数（逻辑像素），不能用整数假设。 */
function isUsableFrame(frame: WindowFrame | null | undefined): frame is WindowFrame {
  if (frame == null) return false
  const { x, y, width, height } = frame
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
}

/** 两矩形重叠面积（不重叠为 0）。 */
function overlapArea(a: WindowFrame, b: WindowFrame): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

/** 中心点距离平方（避免开方的单调性等价比较）。 */
function centerDistanceSq(a: WindowFrame, b: WindowFrame): number {
  const dx = a.x + a.width / 2 - (b.x + b.width / 2)
  const dy = a.y + a.height / 2 - (b.y + b.height / 2)
  return dx * dx + dy * dy
}

/**
 * 取窗口帧所在显示器的逻辑工作区。
 *
 * 选择顺序：与帧重叠面积最大的显示器；全部不重叠（窗口被拖到屏外/最小化后坐标为历史值）
 * 时取中心最近的——多屏负坐标下也不会错落到主屏。无可用显示器或工作区非法 → null，
 * 调用方退回原生旗标（不比旧行为差）。
 */
export function pickWorkArea(
  near: WindowFrame,
  displays: readonly DisplayWorkArea[],
): WindowFrame | null {
  const usable: DisplayWorkArea[] = []
  for (const display of displays) {
    // 原生 JSON 边界：坐标/宽高坏掉的屏跳过（宁缺勿错）。
    if (isUsableFrame(display.bounds) && isUsableFrame(display.workArea)) usable.push(display)
  }
  const first = usable[0]
  if (first === undefined) return null
  let best = first
  for (const candidate of usable.slice(1)) {
    const overlapGain = overlapArea(near, candidate.bounds) - overlapArea(near, best.bounds)
    const closer = centerDistanceSq(near, candidate.bounds) < centerDistanceSq(near, best.bounds)
    if (overlapGain > 0 || (overlapGain === 0 && closer)) best = candidate
  }
  // 拷贝：Screen 的对象可能被上层继续持有，判定侧只看快照值。
  return { ...best.workArea }
}
