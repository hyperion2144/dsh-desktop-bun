// 逻辑屏幕工作区选择（#73）：Screen.getAllDisplays() → 窗口所在屏的 workArea。
//
// 守的是什么：Windows 上 getFrame 是逻辑 px，user32 rcWork 是物理 px；两者直接比在
// 125% 缩放下四边全差 20%，启动旗标未落时最大化态恒假（#73 单方框图标）。本模块只做
// 纯几何选择，让 window-max 的判定与 getFrame 用同一坐标空间；Screen 读取留在 index.ts。
import { describe, expect, test } from 'bun:test'
import { pickWorkArea, type DisplayWorkArea } from '../src/bun/screen-work-area.ts'

// 主屏 2K@125% 的典型 WorkArea 逻辑值（物理 2560×1380 ÷1.25）。
const PRIMARY: DisplayWorkArea = {
  bounds: { x: 0, y: 0, width: 2048, height: 1120 },
  workArea: { x: 0, y: 0, width: 2048, height: 1104 },
}

// 左侧副屏：负坐标，任务栏在底部（工作区比 bounds 少 40 逻辑 px）。
const LEFT: DisplayWorkArea = {
  bounds: { x: -1536, y: 0, width: 1536, height: 864 },
  workArea: { x: -1536, y: 0, width: 1536, height: 824 },
}

describe('pickWorkArea（逻辑工作区选择，#73）', () => {
  test('单屏：返回 workArea，且是拷贝（不把 Screen 对象漏进判定）', () => {
    const picked = pickWorkArea({ x: 100, y: 80, width: 800, height: 600 }, [PRIMARY])
    expect(picked).toEqual(PRIMARY.workArea)
    expect(picked).not.toBe(PRIMARY.workArea)
  })

  test('多屏负坐标：窗口在左副屏 → 选左副屏工作区', () => {
    const near = { x: -1400, y: 100, width: 1200, height: 600 }
    expect(pickWorkArea(near, [PRIMARY, LEFT])).toEqual(LEFT.workArea)
  })

  test('跨屏窗口：按重叠面积选，主屏胜出', () => {
    // 主屏重叠 -100..0 之后的部分 700 宽，左屏只重叠 -100..0 的 100 宽。
    const near = { x: -100, y: 100, width: 800, height: 600 }
    expect(pickWorkArea(near, [PRIMARY, LEFT])).toEqual(PRIMARY.workArea)
  })

  test('跨屏窗口：左屏占比更大时左屏胜出', () => {
    // 左屏重叠 -800..0 共 800 宽，主屏只重叠 0..200 的 200 宽。
    const near = { x: -800, y: 100, width: 1000, height: 600 }
    expect(pickWorkArea(near, [PRIMARY, LEFT])).toEqual(LEFT.workArea)
  })

  test('窗口完全在屏外：取中心最近的屏（不抛错、不返回主屏兜底常量）', () => {
    const near = { x: -5000, y: 0, width: 200, height: 200 }
    expect(pickWorkArea(near, [PRIMARY, LEFT])).toEqual(LEFT.workArea)
  })

  test('无显示器数据 / 工作区非法 → null（调用方退回原生旗标）', () => {
    const near = { x: 0, y: 0, width: 800, height: 600 }
    expect(pickWorkArea(near, [])).toBeNull()
    expect(pickWorkArea(near, [{ ...PRIMARY, bounds: { x: 0, y: 0, width: 0, height: 0 } }])).toBeNull()
    expect(pickWorkArea(near, [{ ...PRIMARY, workArea: { x: 0, y: 0, width: 0, height: 0 } }])).toBeNull()
  })

})
