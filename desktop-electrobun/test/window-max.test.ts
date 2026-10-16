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
} from '../src/bun/window-max.ts'

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
    // 即 2062.4=(2560+18)/1.25。旧 4px 容差把这份帧判损坏，每次最大化白闪 3 下。
    const measured: WindowFrame = { x: -7, y: -7, width: 2062.4, height: 1118.4 }
    const realWork: WindowFrame = { x: 0, y: 0, width: 2560, height: 1380 }
    expect(frameOvershoot(measured, realWork)).toBe(7)
    expect(isMaximizedPlacementDamaged(measured, realWork)).toBe(false)
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

  test('整体向内缩（坐标空间等比错位的形状）为负，不误报损坏', () => {
    // deriveMaximized 注释担心的场景：若 getFrame 与工作区坐标空间真有等比错位，
    // 窗读数只会整体偏小——overshoot ≤ 0，heal 不得误判（否则正常窗每轮 focus 闪三次）。
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
