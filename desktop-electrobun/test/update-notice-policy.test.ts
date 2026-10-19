// #142 启动更新提醒的判定层：开关、分路静默、拉黑、已提醒过的版本。
// 这里只测纯函数——「什么时候弹」的每一条口径都在这儿钉死。

import { describe, expect, test } from 'bun:test'
import { decideUpdateNotice, updateNoticeKey, type UpdateNoticePolicyInput } from '../src/shared/notify/update-notice-policy.ts'

function input(overrides: Partial<UpdateNoticePolicyInput> = {}): UpdateNoticePolicyInput {
  return {
    enabled: true,
    ignored: [],
    lastNotified: { shell: null, runtime: null },
    segments: [],
    ...overrides,
  }
}

const shellSegment = (version: string | null, fresh = true) => ({ kind: 'shell' as const, version, fresh })
const runtimeSegment = (version: string | null, fresh = true) => ({ kind: 'runtime' as const, version, fresh })

describe('decideUpdateNotice：开关', () => {
  test('总开关关了 ⇒ 一律不弹，也不提别的理由', () => {
    const result = decideUpdateNotice(input({ enabled: false, segments: [shellSegment('0.3.0'), runtimeSegment('0.2.2-alpha.1')] }))
    expect(result.notify).toBe(false)
    expect(result.notified).toEqual([])
    expect(result.reason).toContain('已关闭')
  })

  test('开着但没更新 ⇒ 不弹', () => {
    expect(decideUpdateNotice(input({ segments: [shellSegment(null), runtimeSegment(null)] })).notify).toBe(false)
  })
})

describe('decideUpdateNotice：分路静默', () => {
  test('这一路没查成 ⇒ 静默，并把原因写成人话', () => {
    const result = decideUpdateNotice(input({ segments: [shellSegment(null, false)] }))
    expect(result.notify).toBe(false)
    expect(result.reason).toContain('桌面壳')
    expect(result.reason).toContain('静默')
  })

  test('运行时目录拉挂了，不该把壳更新一起吞掉（分路静默）', () => {
    const result = decideUpdateNotice(input({ segments: [shellSegment('0.3.0'), runtimeSegment(null, false)] }))
    expect(result.notify).toBe(true)
    expect(result.notified.map((segment) => segment.kind)).toEqual(['shell'])
    expect(result.reason).toContain('桌面壳')
    expect(result.reason).not.toContain('DSH 运行时')
  })

  test('反过来也一样：壳没查成，运行时照样弹', () => {
    const result = decideUpdateNotice(input({ segments: [shellSegment(null, false), runtimeSegment('0.2.2-alpha.1')] }))
    expect(result.notify).toBe(true)
    expect(result.notified.map((segment) => segment.kind)).toEqual(['runtime'])
  })
})

describe('decideUpdateNotice：「不再提示」拉黑', () => {
  test('拉黑键带路：忽略运行时版本不该静音同号的壳', () => {
    const ignored = [updateNoticeKey('runtime', '0.3.0')]
    const result = decideUpdateNotice(input({ ignored, segments: [shellSegment('0.3.0'), runtimeSegment('0.3.0')] }))
    expect(result.notify).toBe(true)
    expect(result.notified.map((segment) => segment.kind)).toEqual(['shell'])
  })

  test('两路都被拉黑 ⇒ 不弹', () => {
    const result = decideUpdateNotice(
      input({
        ignored: [updateNoticeKey('shell', '0.3.0'), updateNoticeKey('runtime', '0.2.2-alpha.1')],
        segments: [shellSegment('0.3.0'), runtimeSegment('0.2.2-alpha.1')],
      }),
    )
    expect(result.notify).toBe(false)
    expect(result.reason).toContain('没有新的可用更新')
  })
})

describe('decideUpdateNotice：同一版本只提醒一次', () => {
  test('已经提醒过的版本不再弹', () => {
    const result = decideUpdateNotice(
      input({ lastNotified: { shell: '0.3.0', runtime: null }, segments: [shellSegment('0.3.0')] }),
    )
    expect(result.notify).toBe(false)
  })

  test('更高的版本才再弹', () => {
    const result = decideUpdateNotice(
      input({ lastNotified: { shell: '0.3.0', runtime: null }, segments: [shellSegment('0.3.1')] }),
    )
    expect(result.notify).toBe(true)
  })

  test('更低的版本（回滚目标、目录漂移）也不弹', () => {
    const result = decideUpdateNotice(
      input({ lastNotified: { shell: '0.3.0', runtime: null }, segments: [shellSegment('0.2.9')] }),
    )
    expect(result.notify).toBe(false)
  })

  test('两路各自记账：壳记过不牵连运行时', () => {
    const result = decideUpdateNotice(
      input({ lastNotified: { shell: '0.3.0', runtime: null }, segments: [shellSegment('0.3.0'), runtimeSegment('0.2.2-alpha.1')] }),
    )
    expect(result.notify).toBe(true)
    expect(result.notified.map((segment) => segment.kind)).toEqual(['runtime'])
  })

  test('运行时用预发布感知的次序比：alpha.6 > alpha.5', () => {
    const notified = decideUpdateNotice(
      input({ lastNotified: { shell: null, runtime: '0.2.1-alpha.5' }, segments: [runtimeSegment('0.2.1-alpha.6')] }),
    )
    expect(notified.notify).toBe(true)
    const same = decideUpdateNotice(
      input({ lastNotified: { shell: null, runtime: '0.2.1-alpha.5' }, segments: [runtimeSegment('0.2.1-alpha.5')] }),
    )
    expect(same.notify).toBe(false)
  })
})
