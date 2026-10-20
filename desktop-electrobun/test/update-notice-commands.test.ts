// #136：设置面板改提醒开关与拉黑列表的四条命令。参数形状要严格——拉黑表是持久状态，
// 被垃圾参数写脏之后用户没法从面板上看出来自己被拉黑了哪些版本。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommandTable, type CommandDeps } from '../src/bun/commands/commands.ts'
import { createUpdateNoticeStore, type UpdateNoticeStore } from '../src/bun/commands/update-notice-store.ts'
import { defaultSettings, type DesktopSettings } from '../src/shared/settings/settings.ts'
import { loadSettings, saveSettings, updateSettings } from '../src/bun/platform/settings-store.ts'

function harness(overrides: Partial<CommandDeps> = {}): {
  deps: CommandDeps
  table: ReturnType<typeof createCommandTable>
  store: UpdateNoticeStore
  cleanup: () => void
} {
  const home = mkdtempSync(join(tmpdir(), 'dsh-notice-cmd-'))
  saveSettings(home, defaultSettings())
  let settings: DesktopSettings = loadSettings({ home }).settings
  const store = createUpdateNoticeStore(join(home, 'app-support'))
  const deps: CommandDeps = {
    home,
    profile: 'desktop',
    platform: 'darwin',
    log: () => {},
    settings: () => settings,
    save: (patch) => {
      settings = updateSettings(home, patch)
      return settings
    },
    updateNotice: store,
    ...overrides,
  }
  return {
    deps,
    table: createCommandTable(deps),
    store,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true })
    },
  }
}

describe('#136 提醒开关与拉黑列表的命令', () => {
  test('get_update_notice_state 回读落盘状态', async () => {
    const h = harness()
    try {
      const before = (await h.table.get_update_notice_state?.({})) as Record<string, unknown>
      // 默认开：缺字段的老文件 / 没存过状态都按「开着」处理
      expect(before.enabled).toBe(true)
      expect(before.ignored).toEqual([])
      expect(before.lastNotified).toEqual({ shell: null, runtime: null })

      h.store.ignore([{ kind: 'shell', version: '0.3.0' }])
      const after = (await h.table.get_update_notice_state?.({})) as Record<string, unknown>
      expect(after.ignored).toEqual(['shell:0.3.0'])
    } finally {
      h.cleanup()
    }
  })

  test('set_update_notice_enabled 关掉开关并落盘', async () => {
    const h = harness()
    try {
      const off = (await h.table.set_update_notice_enabled?.({ enabled: false })) as Record<string, unknown>
      expect(off.enabled).toBe(false)
      // 关键：真落盘了，不是只在内存里翻了一下
      expect(h.store.read().enabled).toBe(false)
      const back = (await h.table.set_update_notice_enabled?.({ enabled: true })) as Record<string, unknown>
      expect(back.enabled).toBe(true)
      expect(h.store.read().enabled).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  test('enabled 不是布尔值就报错，不把脏值写进状态文件', () => {
    const h = harness()
    try {
      expect(() => h.table.set_update_notice_enabled?.({ enabled: 'off' })).toThrow('必须是布尔值')
      expect(() => h.table.set_update_notice_enabled?.({})).toThrow('必须是布尔值')
      expect(h.store.read().enabled).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  test('restore 只摘掉点的那几路，其余留黑', async () => {
    const h = harness()
    try {
      h.store.ignore([
        { kind: 'shell', version: '0.3.0' },
        { kind: 'runtime', version: '0.3.0' },
        { kind: 'runtime', version: '0.2.2' },
      ])
      const after = (await h.table.restore_update_notice?.({
        targets: [{ kind: 'runtime', version: '0.3.0' }],
      })) as Record<string, unknown>
      expect(after.ignored).toEqual(['shell:0.3.0', 'runtime:0.2.2'])
      expect(h.store.read().ignored).toEqual(['shell:0.3.0', 'runtime:0.2.2'])
    } finally {
      h.cleanup()
    }
  })

  test('clear_update_notice_ignored 清空拉黑但保留开关与记账', async () => {
    const h = harness()
    try {
      h.store.ignore([{ kind: 'shell', version: '0.3.0' }])
      h.store.markNotified([{ kind: 'shell', version: '0.3.0' }])
      h.store.setEnabled(false)
      const after = (await h.table.clear_update_notice_ignored?.({})) as Record<string, unknown>
      expect(after.ignored).toEqual([])
      expect(after.enabled).toBe(false)
      // 清掉拉黑 ≠ 已经提醒过，清完该弹还得弹
      expect((after.lastNotified as Record<string, string | null>).shell).toBe('0.3.0')
      expect(h.store.read().ignored).toEqual([])
    } finally {
      h.cleanup()
    }
  })

  test('targets 形状不对一律报错（宁可报错也不能把拉黑表写脏）', () => {
    const h = harness()
    try {
      h.store.ignore([{ kind: 'shell', version: '0.3.0' }])
      const bad: unknown[] = [
        {},
        { targets: [] },
        { targets: 'shell:0.3.0' },
        { targets: ['shell:0.3.0'] },
        { targets: [{ kind: 'plugin', version: '1.0.0' }] },
        { targets: [{ kind: 'shell', version: '' }] },
        { targets: [{ kind: 'shell' }] },
      ]
      for (const args of bad) {
        expect(() => h.table.restore_update_notice?.(args as Record<string, unknown>)).toThrow(
          /restore_update_notice/,
        )
      }
      expect(h.store.read().ignored).toEqual(['shell:0.3.0'])
    } finally {
      h.cleanup()
    }
  })

  test('壳没接提醒状态时报错，不静默回默认值', () => {
    const h = harness({ updateNotice: undefined })
    try {
      expect(() => h.table.get_update_notice_state?.({})).toThrow('桌面壳未接启动更新提醒状态')
      expect(() => h.table.set_update_notice_enabled?.({ enabled: false })).toThrow(
        '桌面壳未接启动更新提醒状态',
      )
      expect(() => h.table.clear_update_notice_ignored?.({})).toThrow('桌面壳未接启动更新提醒状态')
      expect(() => h.table.restore_update_notice?.({ targets: [{ kind: 'shell', version: '1' }] })).toThrow(
        '桌面壳未接启动更新提醒状态',
      )
    } finally {
      h.cleanup()
    }
  })

  test('四条命令都不碰 desktop-settings.json', async () => {
    const h = harness()
    try {
      const before = JSON.stringify(h.deps.settings?.())
      await h.table.set_update_notice_enabled?.({ enabled: false })
      h.store.ignore([{ kind: 'shell', version: '0.3.0' }])
      await h.table.restore_update_notice?.({ targets: [{ kind: 'shell', version: '0.3.0' }] })
      await h.table.clear_update_notice_ignored?.({})
      // 设置文件键名是契约红线：提醒开关只落 app-support/update-notice.json
      expect(JSON.stringify(h.deps.settings?.())).toBe(before)
    } finally {
      h.cleanup()
    }
  })
})
