// #1 根因 1 的回归缝：shell 的 home 计算统一走 runtime.ts 的 dshHome()——
// DSH_HOME 优先；缺省用 os.homedir()，绝不吃 env.HOME。Windows 上没有 HOME
//（用 USERPROFILE），旧实现 `env.HOME ?? '.'` 会 fallback 成相对路径 `.dsh`，
// shell 进程 cwd 在 bin\ 时 shell.log / shell-state.json 全落进 bin\.dsh。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { dshHome } from '../src/bun/runtime/runtime.ts'

describe('dshHome（#1：home 计算不吃 env.HOME）', () => {
  test('DSH_HOME 显式设置 → 原样使用', () => {
    expect(dshHome({ DSH_HOME: '/custom/dsh' })).toBe('/custom/dsh')
  })

  test('DSH_HOME 空串 → 视同未设置，回 homedir()/.dsh', () => {
    expect(dshHome({ DSH_HOME: '' })).toBe(join(homedir(), '.dsh'))
  })

  test('DSH_HOME 未设置：env.HOME 存在也不许吃它（回归：/evil 不得泄漏进 home）', () => {
    expect(dshHome({ HOME: '/evil' })).toBe(join(homedir(), '.dsh'))
    expect(dshHome({ HOME: '/evil', USERPROFILE: '/also-evil' })).toBe(join(homedir(), '.dsh'))
  })

  test('全空 env → homedir()/.dsh（Windows 下 HOME undefined 的等价场景）', () => {
    expect(dshHome({})).toBe(join(homedir(), '.dsh'))
  })

  test('service.ts 不再有 `env.HOME ?? \'.\'` 这种相对路径 fallback，且委托 dshHome', () => {
    // service.ts 的 home 计算难以单测（startService 会拉起整条服务面），这里对源码做
    // 契约断言：坏的 fallback 一旦回来就红。
    const source = readFileSync(new URL('../src/bun/host/service.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/env\.HOME\s*\?\?\s*['"]\.['"]/)
    expect(source).toContain('dshHome(env)')
  })
})
