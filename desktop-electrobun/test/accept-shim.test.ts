// accept 归一化 shim（#58）的纯函数与脚本构建测试。
//
// 守的是什么：
//   1. MIME token → 扩展名（background 插件 `image/jpeg,image/png,image/webp,image/gif`
//      的真实样本是主用例）——win 原生层只认扩展名 token；
//   2. 扩展名 / 类型通配 / 星号 token 的语义与幂等；
//   3. win32 追加 `*.*` 命中 win 层 All-files 分支；darwin/linux 不追加（对话框自带）；
//   4. preload 内联的归一化源码与测试求值的是同一份（NORMALIZE_ACCEPT_SOURCE 单一来源）。

import { describe, expect, test } from 'bun:test'
import {
  acceptShimScript,
  MIME_TO_EXTENSIONS,
  NORMALIZE_ACCEPT_SOURCE,
  normalizeAcceptValue,
} from '../src/bun/accept-shim.ts'

const norm = (accept: string, appendAllFiles = false) =>
  normalizeAcceptValue(accept, appendAllFiles, MIME_TO_EXTENSIONS)

describe('normalizeAcceptValue（MIME → 扩展名归一化）', () => {
  test('#58 主样本：background 插件的四个图片 MIME', () => {
    expect(norm('image/jpeg,image/png,image/webp,image/gif')).toBe('.jpg,.jpeg,.jpe,.png,.webp,.gif')
  })

  test('已是扩展名形式：语义不变，补点前缀归一', () => {
    expect(norm('.jpg,.png')).toBe('.jpg,.png')
    expect(norm('jpg')).toBe('.jpg')
  })

  test('未知 MIME 保留原样（对话框至少有得选）', () => {
    expect(norm('application/x-unicorn')).toBe('application/x-unicorn')
  })

  test('类型通配 image/*：并上该类型全部已知扩展名', () => {
    const out = norm('image/*')
    expect(out.startsWith('.jpg,')).toBe(true)
    expect(out).toContain('.png')
    expect(out).toContain('.webp')
    expect(out).toContain('.gif')
  })

  test('星号族归一为 *.*：*、*.*、*/* 同一去处', () => {
    expect(norm('*')).toBe('*.*')
    expect(norm('*.*')).toBe('*.*')
    expect(norm('*/*')).toBe('*.*')
  })

  test('去重、空白容忍、幂等', () => {
    expect(norm('image/jpeg, .jpg ,image/png')).toBe('.jpg,.jpeg,.jpe,.png')
    const once = norm('image/jpeg,image/png')
    expect(norm(once)).toBe(once)
  })

  test('空 accept 原样返回，且不追加 All files', () => {
    expect(norm('')).toBe('')
    expect(norm('  ')).toBe('  ')
    expect(norm('', true)).toBe('')
  })

  test('appendAllFiles：仅非空且尚无星号时追加（win32 用）', () => {
    expect(norm('image/png', true)).toBe('.png,*.*')
    expect(norm('image/png', false)).toBe('.png')
    expect(norm('*', true)).toBe('*.*')
  })
})

describe('acceptShimScript（preload 内联脚本）', () => {
  test('win32 追加 All files 旗标，darwin/linux 不追加', () => {
    expect(acceptShimScript('win32')).toContain('const APPEND_ALL_FILES = true')
    expect(acceptShimScript('darwin')).toContain('const APPEND_ALL_FILES = false')
    expect(acceptShimScript('linux')).toContain('const APPEND_ALL_FILES = false')
  })

  test('内嵌归一化函数与 MIME 表：单一来源原文内联', () => {
    const script = acceptShimScript('win32')
    expect(script).toContain(NORMALIZE_ACCEPT_SOURCE)
    expect(script).toContain(JSON.stringify(MIME_TO_EXTENSIONS))
  })

  test('幂等守卫：重复注入直接跳过', () => {
    expect(acceptShimScript('win32')).toContain('__dshAcceptShim')
  })

  test('脚本在 JS 语义下可解析（归一化源码禁 TS 注解的守卫）', () => {
    expect(() => new Function(acceptShimScript('win32'))).not.toThrow()
    expect(() => new Function(acceptShimScript('darwin'))).not.toThrow()
  })
})
