// window-max.ts 纯逻辑单测（#80 三轮）。
// 三轮重开的根因是 heal 错借了状态推导的 deriveMaximized（旗标为真恒真）导致
// 损坏判定恒真、自愈从不触发——这里用「回归钉」把两个判定在同一损坏帧上的
// 分歧锁死，防止将来再有人把 heal 接回旗标优先的判定上。
import { describe, expect, test } from 'bun:test'
import {
  deriveMaximized,
  frameOvershoot,
  healVerdict,
  HEAL_MAX_REPLACES,
  isMaximizedPlacementDamaged,
  PLACEMENT_DAMAGE_TOLERANCE_PX,
  type WindowFrame,
} from '../src/bun/windows/window-max.ts'

// 2K 屏（2560×1440）减任务栏的典型工作区。
const WORK: WindowFrame = { x: 0, y: 0, width: 2560, height: 1400 }

describe('isMaximizedPlacementDamaged（#80 heal 损坏判定）', () => {
  test('贴合工作区 = 正常', () => {
    expect(isMaximizedPlacementDamaged(WORK, WORK)).toBe(false)
  })

  test('容差内残差（贴靠吸附/取整 ±1~2px）不算损坏', () => {
    const residue: WindowFrame = {
      x: 2,
      y: -2,
      width: WORK.width - 2,
      height: WORK.height + 2,
    }
    expect(isMaximizedPlacementDamaged(residue, WORK)).toBe(false)
  })

  test('恰好压着损坏容差的残差不算损坏（<= 语义）', () => {
    const edge: WindowFrame = { ...WORK, height: WORK.height + PLACEMENT_DAMAGE_TOLERANCE_PX }
    expect(isMaximizedPlacementDamaged(edge, WORK)).toBe(false)
  })

  test('THICKFRAME 补偿形态（8px/边，四边外扩）是正常落位（第五轮实测标定）', () => {
    const compensated: WindowFrame = {
      x: -8,
      y: -8,
      width: WORK.width + 16,
      height: WORK.height + 16,
    }
    // 第五轮实机证实：补偿带内的外扩是系统常态落位，heal 重摆它就是「最大化闪几下」。
    expect(isMaximizedPlacementDamaged(compensated, WORK)).toBe(false)
  })

  test('纯顶部越出（「顶部一部分被截断」症状形态）判损坏', () => {
    const damaged: WindowFrame = { x: 0, y: -30, width: WORK.width, height: WORK.height + 30 }
    expect(isMaximizedPlacementDamaged(damaged, WORK)).toBe(true)
  })

  test('单边刚超容差 1px 也判损坏（不要求四边全超）', () => {
    const edge: WindowFrame = {
      ...WORK,
      height: WORK.height + PLACEMENT_DAMAGE_TOLERANCE_PX + 1,
    }
    expect(isMaximizedPlacementDamaged(edge, WORK)).toBe(true)
  })

  test('容差可注入', () => {
    const damaged: WindowFrame = { ...WORK, height: WORK.height + 16 }
    expect(isMaximizedPlacementDamaged(damaged, WORK, 16)).toBe(false)
    expect(isMaximizedPlacementDamaged(damaged, WORK, 8)).toBe(true)
  })

  test('#80 三轮根因回归钉：同一损坏帧，状态推导恒真（旗标短路）而损坏判定为真', () => {
    const damaged: WindowFrame = { x: 0, y: -30, width: WORK.width, height: WORK.height + 30 }
    // 旧 heal 用的判定：旗标为真恒「已最大化」（给状态推导用的语义，坐标差多少都信旗标）。
    expect(deriveMaximized(damaged, WORK, true)).toBe(true)
    // 新 heal 用的判定：专审旗标为真时的几何，外扩超带 = 损坏。
    expect(isMaximizedPlacementDamaged(damaged, WORK)).toBe(true)
    // 两者的布尔值同为 true 但语义相反：旧链把 deriveMaximized===true 当「落位正常」，
    // 新链把 isMaximizedPlacementDamaged===true 当「落位损坏」——heal 裁决走后者。
    expect(healVerdict(isMaximizedPlacementDamaged(damaged, WORK), 0)).toBe('replace')
  })

  test('损坏容差必须罩住补偿带（100% 缩放下 ≈9px）且远低于真损伤（第五轮标定）', () => {
    expect(PLACEMENT_DAMAGE_TOLERANCE_PX).toBeGreaterThanOrEqual(9)
    expect(PLACEMENT_DAMAGE_TOLERANCE_PX).toBeLessThan(20)
  })

  test('#80 第五轮实机回归钉：2K@125% 实测补偿帧 = 正常落位（heal 不得重摆）', () => {
    // 实机日志原值：物理帧 = 工作区四周 +9px（THICKFRAME 补偿），getFrame 按缩放 ÷1.25，
    // 即 2062.4=(2560+18)/1.25。#73 起 heal 与状态判定同取 Screen 逻辑工作区
    // （2048×1104），补偿读数 7.4 逻辑px；旧 4px 容差把它判损坏，每次最大化白闪 3 下。
    const measured: WindowFrame = { x: -7, y: -7, width: 2062.4, height: 1118.4 }
    const logicalWork: WindowFrame = { x: 0, y: 0, width: 2048, height: 1104 }
    expect(frameOvershoot(measured, logicalWork)).toBeCloseTo(7.4)
    expect(isMaximizedPlacementDamaged(measured, logicalWork)).toBe(false)
  })
})

describe('frameOvershoot（外扩单向度量）', () => {
  test('贴合 = 0', () => {
    expect(frameOvershoot(WORK, WORK)).toBe(0)
  })

  test('四边外扩 8px = 8', () => {
    const expanded: WindowFrame = { x: -8, y: -8, width: WORK.width + 16, height: WORK.height + 16 }
    expect(frameOvershoot(expanded, WORK)).toBe(8)
  })

  test('整体向内缩为负，不误报损坏', () => {
    // 外扩判定只认向外越界：窗比工作区小（任何原因）时 overshoot ≤ 0，
    // heal 不得误判（否则正常窗每轮 focus 闪三次）。
    const inset: WindowFrame = { x: 40, y: 40, width: WORK.width - 80, height: WORK.height - 80 }
    expect(frameOvershoot(inset, WORK)).toBeLessThanOrEqual(0)
    expect(isMaximizedPlacementDamaged(inset, WORK)).toBe(false)
  })
})

describe('healVerdict（重摆计数状态机）', () => {
  test('不损坏 = clean', () => {
    expect(healVerdict(false, 0)).toBe('clean')
    expect(healVerdict(false, HEAL_MAX_REPLACES)).toBe('clean')
  })

  test('损坏且未达上限 = replace', () => {
    expect(healVerdict(true, 0)).toBe('replace')
    expect(healVerdict(true, HEAL_MAX_REPLACES - 1)).toBe('replace')
  })

  test('损坏且已达上限 = exhausted（防重摆循环闪窗）', () => {
    expect(healVerdict(true, HEAL_MAX_REPLACES)).toBe('exhausted')
    expect(healVerdict(true, HEAL_MAX_REPLACES + 5)).toBe('exhausted')
  })
})

describe('deriveMaximized（#73 启动最大化图标回归）', () => {
  // 实机日志原值（#73 第五轮，2K@125%）：
  //   getFrame = 逻辑 px：最大化帧 2062.4×1118.4 = (2560+18)/1.25
  //   Screen 工作区 = 逻辑 px：2048×1104（getFrame 同一坐标空间）
  //   user32 rcWork = 物理 px：2560×1380（旧实现直接拿它比，四边全差 20%）
  const LOGICAL_WORK: WindowFrame = { x: 0, y: 0, width: 2048, height: 1104 }
  const MEASURED: WindowFrame = { x: -7, y: -7, width: 2062.4, height: 1118.4 }

  test('同一逻辑坐标空间：2K@125% 实测最大化帧判真（坐标空间错配是 #73 根因）', () => {
    expect(deriveMaximized(MEASURED, LOGICAL_WORK, false)).toBe(true)
  })

  test('物理工作区不再参与判定：逻辑帧 vs 物理 rcWork 判假（防止回退到物理口径）', () => {
    expect(deriveMaximized(MEASURED, { x: 0, y: 0, width: 2560, height: 1380 }, false)).toBe(false)
  })

  test('100% 缩放：THICKFRAME 补偿 9px/边仍判真（旧 8px 容差漏判）', () => {
    const work: WindowFrame = { x: 0, y: 0, width: 1920, height: 1040 }
    const compensated: WindowFrame = { x: -9, y: -9, width: 1938, height: 1058 }
    expect(deriveMaximized(compensated, work, false)).toBe(true)
  })

  test('用户拖小的窗口不误判为最大化', () => {
    expect(deriveMaximized({ x: 120, y: 90, width: 800, height: 600 }, LOGICAL_WORK, false)).toBe(false)
  })

  test('单边缩进超过容差即判假（不要求四边都缩）', () => {
    expect(deriveMaximized({ x: -7, y: -7, width: 2062.4, height: 1000 }, LOGICAL_WORK, false)).toBe(false)
  })

  test('比工作区小一圈（40px/边）不误判为最大化（12px 容差上界）', () => {
    const inset = { x: 40, y: 40, width: LOGICAL_WORK.width - 80, height: LOGICAL_WORK.height - 80 }
    expect(deriveMaximized(inset, LOGICAL_WORK, false)).toBe(false)
  })

  test('工作区缺失退回原生旗标（Screen 不可用时行为不变）', () => {
    expect(deriveMaximized(MEASURED, null, false)).toBe(false)
    expect(deriveMaximized(MEASURED, null, true)).toBe(true)
  })
})
