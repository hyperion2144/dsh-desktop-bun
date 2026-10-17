// 运行时更新判定层（#138）纯逻辑。
//
// 这里钉的是 #138 验收点名的那七条边界：内置比在跑的新 / 在跑的比内置新 / 同号合并 /
// 已下载未切换 / 已下载且在用 / 目录拉取失败 / dev 无目录。附带钉住两件容易退化的东西：
// 基准是「实际在跑的版本」而不是设置里的偏好值，以及每条更新的按钮动作链（走哪条 RPC）。

import { describe, expect, test } from 'bun:test'
import {
  evaluateRuntimeUpdates,
  runtimeUpdateActionLabel,
  runtimeUpdateSourceLabel,
  topRuntimeUpdate,
  type RuntimeUpdateInput,
} from '../src/shared/runtime-update.ts'

const installed = (...versions: string[]): RuntimeUpdateInput['installed'] =>
  versions.map((version) => ({ version, source: '', installed_at: 0 }))

const versionsOf = (report: { entries: { version: string }[] }): string[] => report.entries.map((entry) => entry.version)

describe('基准是实际在跑的版本', () => {
  test('拿设置偏好（比实际高）当基准会漏报——这里必须以 running 为准', () => {
    // 用户把设置钉到 0.3.0，但实际在跑的是 0.2.0（重启失败回落），0.3.0 仍未在用 ⇒ 有更新。
    const report = evaluateRuntimeUpdates({
      running: '0.2.0',
      builtin: '0.2.0',
      catalog: [{ version: '0.3.0', channel: 'latest' }],
      installed: [],
    })
    expect(versionsOf(report)).toEqual(['0.3.0'])
    expect(report.baseline).toBe('0.2.0')
  })

  test('拿不到在跑版本就不判定（宁可静默，也不拿偏好凑数）', () => {
    const report = evaluateRuntimeUpdates({
      running: null,
      builtin: '0.2.0',
      catalog: [{ version: '0.3.0', channel: 'latest' }],
      installed: [],
    })
    expect(report.baseline).toBeNull()
    expect(report.entries).toEqual([])
    expect(report.available).toBe(false)
    expect(report.reason).toContain('暂不判定更新')
  })

  test('格式不合法的 running / builtin 当作没有（绝不抛）', () => {
    const report = evaluateRuntimeUpdates({
      running: '不是版本',
      builtin: 'latest',
      catalog: [{ version: '0.3.0', channel: 'latest' }],
      installed: installed('0.4.0'),
    })
    expect(report.baseline).toBeNull()
    expect(report.builtin).toBeNull()
  })
})

describe('内置运行时是一等候选', () => {
  test('内置比在跑的新 ⇒ 出条目，来源=内置，只切换不下载、不可卸载', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.1.9',
      builtin: '0.2.0',
      catalog: [],
      installed: [],
    })
    expect(versionsOf(report)).toEqual(['0.2.0'])
    const entry = report.entries[0]!
    expect(entry.source).toBe('builtin')
    expect(entry.local).toBe(true)
    expect(entry.uninstallable).toBe(false)
    expect(entry.action).toBe('switch')
    // 内置那棵随包就在，不需要也不该走 download_runtime。
    expect(entry.plan.map((step) => step.rpc)).toEqual(['save_desktop_settings', 'restart_dsh_service'])
    expect(runtimeUpdateSourceLabel(entry)).toBe('内置')
    expect(runtimeUpdateActionLabel(entry)).toBe('切换到此版本')
  })

  test('内置不进远端目录也照样是候选（离线不能把内置判没了）', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.1.9',
      builtin: '0.2.1-alpha.5',
      catalog: [],
      installed: [],
      catalogError: '拉取超时',
    })
    expect(versionsOf(report)).toEqual(['0.2.1-alpha.5'])
    expect(report.catalogError).toBe('拉取超时')
  })

  test('在跑的比内置新 ⇒ 内置不算更新', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.3.0',
      builtin: '0.2.0',
      catalog: [{ version: '0.3.0', channel: 'latest' }],
      installed: [],
    })
    expect(report.entries).toEqual([])
    expect(report.available).toBe(false)
    expect(report.reason).toBe('已是最新（0.3.0）')
  })

  test('与内置同号的已下载条目合并成一条（来源=内置，不重复下载）', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.1.9',
      builtin: '0.2.0',
      catalog: [{ version: '0.2.0', channel: 'latest' }],
      installed: installed('0.2.0'),
    })
    expect(versionsOf(report)).toEqual(['0.2.0'])
    expect(report.entries[0]!.source).toBe('builtin')
    expect(report.entries[0]!.plan.map((step) => step.rpc)).not.toContain('download_runtime')
  })
})

describe('已下载的版本', () => {
  test('已下载但没切换 ⇒ 来源=已下载，只要切换', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.1.9',
      builtin: '0.1.5',
      catalog: [],
      installed: installed('0.2.0', '0.1.5'),
    })
    expect(versionsOf(report)).toEqual(['0.2.0'])
    const entry = report.entries[0]!
    expect(entry.source).toBe('downloaded')
    expect(entry.local).toBe(true)
    expect(entry.uninstallable).toBe(true)
    expect(entry.action).toBe('switch')
  })

  test('已下载且正在用 ⇒ 不出条目（等于基准，不算更高）', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.2.0',
      builtin: '0.1.5',
      catalog: [],
      installed: installed('0.2.0', '0.1.5'),
    })
    expect(report.entries).toEqual([])
  })

  test('已下载的旧版本低于基准 ⇒ 不出条目', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.2.0',
      builtin: '0.2.0',
      catalog: [],
      installed: installed('0.1.5'),
    })
    expect(report.entries).toEqual([])
  })

  test('目录里没列、但本地已下载的更高版本照样是候选（拉到过就是本地事实）', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.1.9',
      builtin: null,
      catalog: [],
      installed: installed('0.2.0'),
    })
    expect(versionsOf(report)).toEqual(['0.2.0'])
  })
})

describe('远端候选', () => {
  test('未下载 ⇒ 先下载再切换，下载走 catalog source', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.2.0',
      builtin: '0.2.0',
      catalog: [{ version: '0.3.0', channel: 'latest' }],
      installed: [],
      source: 'npm',
    })
    const entry = report.entries[0]!
    expect(entry.source).toBe('remote')
    expect(entry.local).toBe(false)
    expect(entry.action).toBe('download-and-switch')
    expect(entry.channel).toBe('latest')
    expect(entry.plan.map((step) => step.rpc)).toEqual(['download_runtime', 'save_desktop_settings', 'restart_dsh_service'])
    expect(entry.plan[0]?.args).toEqual({ version: '0.3.0', source: 'npm' })
    expect(entry.plan[1]?.args).toEqual({ patch: { dsh_runtime: '0.3.0', dsh_mode: 'builtin' } })
  })

  test('source 不给 ⇒ 落「github」（与壳命令面 list_runtime_catalog / download_runtime 同口径）', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.2.0',
      builtin: '0.2.0',
      catalog: [{ version: '0.3.0', channel: '' }],
      installed: [],
    })
    expect(report.source).toBe('github')
    expect(report.entries[0]!.plan[0]?.args).toEqual({ version: '0.3.0', source: 'github' })
  })

  test('多条更新按版本降序，topRuntimeUpdate 取最高那条', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.1.0',
      builtin: '0.2.0',
      catalog: [
        { version: '0.3.0', channel: 'latest' },
        { version: '0.2.5', channel: '' },
        { version: '0.10.0', channel: 'rc' },
      ],
      installed: [],
    })
    expect(versionsOf(report)).toEqual(['0.10.0', '0.3.0', '0.2.5', '0.2.0'])
    expect(topRuntimeUpdate(report)?.version).toBe('0.10.0')
    expect(report.reason).toBe('4 个比 0.1.0 更新的运行时（最高 0.10.0）')
  })

  test('预发布版排在正式版之后（沿用 runtime-catalog 的比较口径）', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.2.0',
      builtin: '0.2.0',
      catalog: [
        { version: '0.2.1', channel: 'latest' },
        { version: '0.2.1-alpha.2', channel: 'alpha' },
      ],
      installed: [],
    })
    expect(versionsOf(report)).toEqual(['0.2.1', '0.2.1-alpha.2'])
  })

  test('目录里的坏版本号被丢弃（不抛、不进候选）', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.1.0',
      builtin: '0.1.0',
      catalog: [
        { version: 'next', channel: 'latest' },
        { version: '0.2.0', channel: 'latest' },
      ],
      installed: installed('乱码'),
    })
    expect(versionsOf(report)).toEqual(['0.2.0'])
  })
})

describe('目录拉取失败与 dev', () => {
  test('目录拉挂 ⇒ 透传原因，仍按内置 + 已下载判定，不静默宣称「已是最新」而不提失败', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.1.9',
      builtin: '0.1.5',
      catalog: [],
      installed: [],
      catalogError: 'HTTP 503',
    })
    expect(report.available).toBe(false)
    expect(report.catalogError).toBe('HTTP 503')
    expect(report.reason).toBe('已是最新（0.1.9）；远端目录拉取失败：HTTP 503')
  })

  test('目录拉挂但本地有更高版本 ⇒ 照样提醒', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.1.9',
      builtin: '0.1.5',
      catalog: [],
      installed: installed('0.2.0'),
      catalogError: 'HTTP 503',
    })
    expect(versionsOf(report)).toEqual(['0.2.0'])
    expect(report.catalogError).toBe('HTTP 503')
  })

  test('dev 无内置、无已下载目录 ⇒ 仍按远端目录判定出「未下载」条目', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.1.9',
      builtin: null,
      catalog: [{ version: '0.2.0', channel: 'latest' }],
      installed: [],
    })
    expect(report.builtin).toBeNull()
    expect(report.entries[0]!.source).toBe('remote')
    expect(report.entries[0]!.local).toBe(false)
  })

  test('dev 什么都拿不到 ⇒ 空报告，不抛', () => {
    const report = evaluateRuntimeUpdates({ running: '0.1.9', builtin: null, catalog: [], installed: [] })
    expect(report).toMatchObject({ baseline: '0.1.9', builtin: null, entries: [], available: false, catalogError: '' })
    expect(topRuntimeUpdate(report)).toBeNull()
  })
})

describe('目录与安装源不在一侧（实机修）', () => {
  test('目录上有、安装源上没有的版本不提醒（点了也装不上＝许空诺）', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.2.1-alpha.2',
      builtin: '0.2.1-alpha.2',
      catalog: [
        { version: '0.2.1-rc.2', channel: 'rc' },
        { version: '0.2.1-rc.1', channel: 'rc' },
      ],
      installed: [],
      installable: ['0.2.1-rc.1'],
    })
    expect(versionsOf(report)).toEqual(['0.2.1-rc.1'])
  })

  test('全卡在安装源外面 ⇒ 静默，但说清是装不上而不冒充「已是最新」', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.2.1-alpha.2',
      builtin: '0.2.1-alpha.2',
      catalog: [{ version: '0.2.1-rc.2', channel: 'rc' }],
      installed: [],
      installable: [],
    })
    expect(report.available).toBe(false)
    expect(report.reason).toBe('已是最新（0.2.1-alpha.2）；更高的 0.2.1-rc.2 上游还没发全，装不上就不提醒')
  })

  test('闸门只卡远端：内置与已下载是本地事实，不因为安装源查不到而被藏起来', () => {
    const report = evaluateRuntimeUpdates({
      // 基准取 0.1.9：0.2.0-rc.2 比 0.2.0 低（预发布号规则），拿 0.2.0 当基准会把这条卡在“不够高”里。
      running: '0.1.9',
      builtin: '0.2.1-alpha.2',
      catalog: [],
      installed: installed('0.2.0-rc.2'),
      installable: [],
    })
    expect(versionsOf(report)).toEqual(['0.2.1-alpha.2', '0.2.0-rc.2'])
  })

  test('不给 installable ⇒ 不筛（目录源本身就是 npm 时走这条）', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.2.0',
      builtin: '0.2.0',
      catalog: [{ version: '0.2.1-rc.2', channel: 'rc' }],
      installed: [],
    })
    expect(versionsOf(report)).toEqual(['0.2.1-rc.2'])
  })

  test('闸门放行的条目仍带下载并切换的计划（没因筛选丢掉动作）', () => {
    const report = evaluateRuntimeUpdates({
      running: '0.2.1-alpha.2',
      builtin: '0.2.1-alpha.2',
      catalog: [{ version: '0.2.1-rc.1', channel: 'rc' }],
      installed: [],
      source: 'github',
      installable: ['0.2.1-rc.1'],
    })
    expect(report.entries[0]!.action).toBe('download-and-switch')
    expect(report.entries[0]!.plan[0]).toEqual({ rpc: 'download_runtime', args: { version: '0.2.1-rc.1', source: 'github' } })
  })
})
