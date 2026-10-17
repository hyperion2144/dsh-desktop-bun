// 下载进度的百分比（实机反馈：提醒卡点了「下载并切换」之后要有进度条，面板那种）。
// 公式只有这一份（面板与提醒卡共用），所以这里把口径钉死：没解析出包数就不假装有进度。
import { describe, expect, test } from 'bun:test'
import { downloadPercent } from '../src/shared/runtime-download-progress.ts'

describe('下载进度百分比', () => {
  test('按 downloaded / resolved 算，四舍五入', () => {
    expect(downloadPercent({ resolved: 200, downloaded: 50 })).toBe(25)
    expect(downloadPercent({ resolved: 3, downloaded: 1 })).toBe(33)
    expect(downloadPercent({ resolved: 3, downloaded: 2 })).toBe(67)
  })

  test('resolved 还没出来（0）时给 0，不让进度条假动', () => {
    expect(downloadPercent({ resolved: 0, downloaded: 0 })).toBe(0)
    expect(downloadPercent({ resolved: 0, downloaded: 42 })).toBe(0)
  })

  test('成功终态会把 downloaded 对齐 resolved（#79），于是正好 100', () => {
    expect(downloadPercent({ resolved: 200, downloaded: 200 })).toBe(100)
  })

  test('异常数字夹到 0–100：不能出现 130% 或 -5%', () => {
    expect(downloadPercent({ resolved: 100, downloaded: 130 })).toBe(100)
    expect(downloadPercent({ resolved: 100, downloaded: -5 })).toBe(0)
  })

  test('数字缺失或非数时给 0，不抛', () => {
    expect(downloadPercent({ resolved: Number.NaN, downloaded: 10 })).toBe(0)
    expect(downloadPercent({ resolved: undefined as unknown as number, downloaded: 10 })).toBe(0)
  })
})
