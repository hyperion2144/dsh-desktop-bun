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
  type WindowFrame,
} from '../src/bun/window-state.ts'

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

