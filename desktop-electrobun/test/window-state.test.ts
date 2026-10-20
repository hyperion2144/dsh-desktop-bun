// window-state.ts 的最大化态持久化（#50 验证反馈③：重启后要记住上次是最大化收场）。
//
// 旧格式只存 {x,y,width,height}；新格式多一个 `maximized` 布尔。
// 关键约束：旧格式文件必须照常可读（读出 maximized=false），且 parseWindowFrame
// 不能被多余键绊倒（下次还原窗口几何时还是同一套解析）。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  parseWindowFrame,
  readWindowMaximized,
  writeWindowFrame,
  defaultWindowFrame,
  frameForPersist,
  type WindowFrame,
} from '../src/bun/windows/window-state.ts'

const FRAME: WindowFrame = { x: 12, y: 34, width: 1280, height: 860 }

describe('窗口态持久化：最大化标记', () => {
  let dir: string | null = null

  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  function makeFile(): string {
    dir = mkdtempSync(join(tmpdir(), 'dsh-window-state-'))
    return join(dir, 'window.json')
  }

  test('writeWindowFrame 默认写 maximized=false，round-trip 读回', () => {
    const file = makeFile()
    writeWindowFrame(file, FRAME)
    expect(readWindowMaximized(file)).toBe(false)
    writeWindowFrame(file, FRAME, true)
    expect(readWindowMaximized(file)).toBe(true)
    // 几何本身也要原样读回
    expect(parseWindowFrame(readFileSync(file, 'utf8'))).toEqual(FRAME)
  })

  test('旧格式（无 maximized 键）读出 false，向后兼容', () => {
    const file = makeFile()
    writeFileSync(file, `${JSON.stringify(FRAME)}\n`)
    expect(readWindowMaximized(file)).toBe(false)
    expect(parseWindowFrame(readFileSync(file, 'utf8'))).toEqual(FRAME)
  })

  test('坏 JSON / 缺文件读出 false 不抛', () => {
    const file = makeFile()
    expect(readWindowMaximized(file)).toBe(false)
    writeFileSync(file, '{oops')
    expect(readWindowMaximized(file)).toBe(false)
  })
})

describe('最大化收场的落盘帧（#73 回归）', () => {
  const normalFrame: WindowFrame = { x: 120, y: 90, width: 1280, height: 860 }

  test('最大化时沿用上一次的常规帧，不把最大化帧当还原帧', () => {
    const maximizedFrame: WindowFrame = { x: -7, y: -7, width: 2062, height: 1118 }
    expect(frameForPersist(maximizedFrame, true, normalFrame)).toEqual(normalFrame)
  })

  test('最大化且没有上一次帧时退回默认帧', () => {
    expect(frameForPersist(FRAME, true, null)).toEqual(defaultWindowFrame())
  })

  test('常规收场原样落盘当前帧', () => {
    expect(frameForPersist(FRAME, false, normalFrame)).toEqual(FRAME)
  })

  test('默认帧沿用首次启动的 1280×860 @ 0,0', () => {
    expect(defaultWindowFrame()).toEqual({ x: 0, y: 0, width: 1280, height: 860 })
  })
})

