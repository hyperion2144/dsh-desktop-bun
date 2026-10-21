// #190 命令契约：contracts/ 的 COMMAND_NAMES 与壳命令表键必须完全一致。
//
// 过去「面板调了哪些命令」靠 test-client.mjs 读源码文本断言——文本匹配既脆弱，
// 又会随卡片模块拆分漏检新模块。现在名字集合由类型层锚定：命令名拼写错误在
// typecheck 处炸（COMMAND_NAMES 元素与 invokeCommand 的 K 都锚在 keyof Commands 上），
// 本测试只保证「契约清单 = 壳命令表」两个集合互不缺角——新增命令漏登契约、
// 或契约里留了已删除的命令名，都在这里现形。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMMAND_NAMES, type CommandName } from '../../contracts/index.ts'
import { createCommandTable } from '../src/bun/commands/commands.ts'
import { silentLogger } from './helpers/test-logger.ts'
import { defaultSettings } from '../src/shared/settings/settings.ts'
import { loadSettings, saveSettings, updateSettings } from '../src/bun/platform/settings-store.ts'

describe('#190 命令契约：COMMAND_NAMES 与壳命令表一致', () => {
  test('契约清单无重复', () => {
    expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length)
  })

  test('命令表键与 COMMAND_NAMES 完全一致（两集合互不缺角）', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-contracts-'))
    try {
      saveSettings(home, defaultSettings())
      let settings = loadSettings({ home }).settings
      const table = createCommandTable({
        home,
        profile: 'desktop',
        platform: 'darwin',
          log: silentLogger,
        settings: () => settings,
        save: (patch) => (settings = updateSettings(home, patch)),
      })
      const tableKeys = new Set(Object.keys(table))
      const contractNames = new Set<string>(COMMAND_NAMES)

      const missingInContract = [...tableKeys].filter((k) => !contractNames.has(k as CommandName))
      const missingInTable = COMMAND_NAMES.filter((n) => !tableKeys.has(n))

      expect(missingInContract).toEqual([])
      expect(missingInTable).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
