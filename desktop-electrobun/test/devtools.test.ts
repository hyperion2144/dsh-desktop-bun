// #69 开发者工具开关：启动决策（plan）、菜单门控不变式、口探活、dev_tools 设置键往返。
// 安全面断言的重点：打包态「菜单可见 ⇔ CDP 口已开」禁中间态；任何失败路径 fail-closed。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import { CString, dlopen } from 'bun:ffi'

import {
  applyCdpDebugPort,
  DEVTOOLS_DEFAULT_PORT,
  DEVTOOLS_PORT_ENV,
  DEVTOOLS_PORT_OVERRIDE_ENV,
  devToolsMenuEnabled,
  isPortBindable,
  planDevToolsBoot,
  resolveDevToolsPort,
} from '../src/bun/devtools.ts'
import { loadSettings, saveSettings, settingsPath } from '../src/bun/settings-store.ts'
import { normalizeSettings, serializeSettings } from '../src/shared/settings.ts'

/** 恒空闲/恒占用的探活桩：plan 的可测性靠它，不碰真网络。 */
const alwaysFree = async (): Promise<boolean> => true
const neverFree = async (): Promise<boolean> => false

describe('applyCdpDebugPort（C environ 双写，#69 打包态根因修复）', () => {
  test('双写：Bun env 落值 + C setenv 同值写入；返回 true', () => {
    const env: Record<string, string | undefined> = {}
    const calls: Array<[string, string, number]> = []
    const ok = applyCdpDebugPort(9333, {
      env,
      setEnvC: (name, value, overwrite) => {
        calls.push([name, value, overwrite])
        return 0
      },
    })
    expect(ok).toBe(true)
    expect(env[DEVTOOLS_PORT_ENV]).toBe('9333')
    expect(calls).toEqual([[DEVTOOLS_PORT_ENV, '9333', 1]])
  })

  test('C setenv 失败/不可用 → 返回 false（fail-closed），Bun env 仍落值供日志', () => {
    const env: Record<string, string | undefined> = {}
    expect(applyCdpDebugPort(9333, { env, setEnvC: () => -1 })).toBe(false)
    expect(applyCdpDebugPort(9333, { env, setEnvC: null })).toBe(false)
    expect(env[DEVTOOLS_PORT_ENV]).toBe('9333')
  })

  // libSystem.dylib 是 macOS 专属路径：Linux/Windows 上 dlopen 直接抛错——这条冒烟只能在 darwin 跑
  test.skipIf(process.platform !== 'darwin')('真 FFI 冒烟：setenv 写入后 C getenv 能读回（dylib 读的就是这个）', () => {
    expect(applyCdpDebugPort(9344)).toBe(true)
    const libc = dlopen('/usr/lib/libSystem.dylib', {
      getenv: { args: ['cstring'], returns: 'ptr' },
    })
    const p = libc.symbols.getenv(DEVTOOLS_PORT_ENV)
    expect(p).not.toBeNull()
    expect(new CString(p!).toString()).toBe('9344')
  })
})
describe('resolveDevToolsPort', () => {
  test('无覆盖回默认口（避开 9222/9229）', () => {
    expect(resolveDevToolsPort({})).toBe(DEVTOOLS_DEFAULT_PORT)
    expect(resolveDevToolsPort({ envOverride: undefined })).toBe(DEVTOOLS_DEFAULT_PORT)
    expect(resolveDevToolsPort({ envOverride: '' })).toBe(DEVTOOLS_DEFAULT_PORT)
    expect(resolveDevToolsPort({ envOverride: '   ' })).toBe(DEVTOOLS_DEFAULT_PORT)
    expect(DEVTOOLS_DEFAULT_PORT).not.toBe(9222)
    expect(DEVTOOLS_DEFAULT_PORT).not.toBe(9229)
  })

  test('覆盖 env：合法整数照用（含首尾空白），非法一律 null', () => {
    expect(resolveDevToolsPort({ envOverride: '9344' })).toBe(9344)
    expect(resolveDevToolsPort({ envOverride: ' 9344 ' })).toBe(9344)
    expect(resolveDevToolsPort({ envOverride: '1' })).toBe(1)
    expect(resolveDevToolsPort({ envOverride: '65535' })).toBe(65535)
    expect(resolveDevToolsPort({ envOverride: '0' })).toBeNull()
    expect(resolveDevToolsPort({ envOverride: '-1' })).toBeNull()
    expect(resolveDevToolsPort({ envOverride: '65536' })).toBeNull()
    expect(resolveDevToolsPort({ envOverride: '9222.5' })).toBeNull()
    expect(resolveDevToolsPort({ envOverride: 'abc' })).toBeNull()
  })
})

describe('devToolsMenuEnabled（菜单可见性的唯一事实源）', () => {
  test('dev 构建恒可见，与设置/口无关', () => {
    expect(devToolsMenuEnabled({ isPackaged: false, settingOn: false, cdpReady: false })).toBe(true)
    expect(devToolsMenuEnabled({ isPackaged: false, settingOn: true, cdpReady: false })).toBe(true)
  })

  test('打包态不变式：菜单可见 ⇔ 开关开 且 口已开', () => {
    expect(devToolsMenuEnabled({ isPackaged: true, settingOn: false, cdpReady: false })).toBe(false)
    // 口开着但开关关：不出菜单（口该在下次重启后消失；菜单不提前）
    expect(devToolsMenuEnabled({ isPackaged: true, settingOn: false, cdpReady: true })).toBe(false)
    // 开关开着但口没开：不出菜单（点了没反应的骗局菜单不许出现）
    expect(devToolsMenuEnabled({ isPackaged: true, settingOn: true, cdpReady: false })).toBe(false)
    expect(devToolsMenuEnabled({ isPackaged: true, settingOn: true, cdpReady: true })).toBe(true)
  })
})

describe('planDevToolsBoot（启动决策）', () => {
  test('dev 构建：不碰 CDP 口（Electrobun 自动开），菜单恒可见', async () => {
    const plan = await planDevToolsBoot({ isPackaged: false, settingOn: false, isFree: neverFree })
    expect(plan.reason).toBe('dev-build')
    expect(plan.enableCdp).toBe(false)
    expect(plan.menuEnabled).toBe(true)
  })

  test('打包态 + 开关关（或缺省）：不端口、不出菜单', async () => {
    const plan = await planDevToolsBoot({ isPackaged: true, settingOn: false, isFree: alwaysFree })
    expect(plan.reason).toBe('disabled-by-setting')
    expect(plan.enableCdp).toBe(false)
    expect(plan.menuEnabled).toBe(false)
  })

  test('打包态 + 开关开 + 默认口空闲：端口、出菜单', async () => {
    const plan = await planDevToolsBoot({ isPackaged: true, settingOn: true, isFree: alwaysFree })
    expect(plan.reason).toBe('enabled-by-setting')
    expect(plan.enableCdp).toBe(true)
    expect(plan.port).toBe(DEVTOOLS_DEFAULT_PORT)
    expect(plan.menuEnabled).toBe(true)
  })

  test('覆盖 env 合法：按覆盖口启用', async () => {
    const plan = await planDevToolsBoot({ isPackaged: true, settingOn: true, envOverride: '9344', isFree: alwaysFree })
    expect(plan.reason).toBe('enabled-by-setting')
    expect(plan.port).toBe(9344)
  })

  test('覆盖 env 非法：fail-closed（不开口、不出菜单）', async () => {
    const plan = await planDevToolsBoot({ isPackaged: true, settingOn: true, envOverride: 'abc', isFree: alwaysFree })
    expect(plan.reason).toBe('port-invalid')
    expect(plan.enableCdp).toBe(false)
    expect(plan.port).toBeNull()
    expect(plan.menuEnabled).toBe(false)
  })

  test('口被占：fail-closed，回显被占口供日志', async () => {
    const plan = await planDevToolsBoot({ isPackaged: true, settingOn: true, isFree: neverFree })
    expect(plan.reason).toBe('port-unavailable')
    expect(plan.enableCdp).toBe(false)
    expect(plan.port).toBe(DEVTOOLS_DEFAULT_PORT)
    expect(plan.menuEnabled).toBe(false)
  })

  test('不变式（打包态）：plan.menuEnabled === true 当且仅当 enableCdp === true', async () => {
    for (const settingOn of [false, true]) {
      for (const isFree of [alwaysFree, neverFree]) {
        const plan = await planDevToolsBoot({ isPackaged: true, settingOn, isFree })
        expect(plan.menuEnabled).toBe(plan.enableCdp)
      }
    }
  })
})

describe('isPortBindable（真实探活）', () => {
  test('空闲口 true；被占口 false（0.0.0.0 占用也判占，与 service portFree 同语义）', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {}, open() {}, close() {} } })
    const port = server.port
    server.stop(true)

    expect(await isPortBindable(port)).toBe(true)

    const holder = Bun.listen({ hostname: '0.0.0.0', port, socket: { data() {}, open() {}, close() {} } })
    try {
      expect(await isPortBindable(port)).toBe(false)
    } finally {
      holder.stop(true)
    }
  })
})

describe('dev_tools 设置键（#69）', () => {
  test('缺省 false；双名可读；非布尔当没设置', () => {
    expect(normalizeSettings({}).devTools).toBe(false)
    expect(normalizeSettings({ dev_tools: true }).devTools).toBe(true)
    expect(normalizeSettings({ devTools: true }).devTools).toBe(true)
    expect(normalizeSettings({ dev_tools: false }).devTools).toBe(false)
    expect(normalizeSettings({ dev_tools: 'yes' }).devTools).toBe(false)
    expect(normalizeSettings({ dev_tools: 1 }).devTools).toBe(false)
  })

  test('serializeSettings 写下划线键（旧壳 serde 只认它，回退不丢设置）', () => {
    expect(serializeSettings(normalizeSettings({ dev_tools: true })).dev_tools).toBe(true)
    expect(serializeSettings(normalizeSettings({})).dev_tools).toBe(false)
  })

  test('落盘往返：save → load 保真；盘上无新键的旧设置按默认', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-devtools-'))
    try {
      saveSettings(home, normalizeSettings({ dev_tools: true }))
      expect(loadSettings({ home }).settings.devTools).toBe(true)
      const raw: unknown = JSON.parse(readFileSync(settingsPath(home), 'utf8'))
      expect((raw as Record<string, unknown>).dev_tools).toBe(true)

      rmSync(settingsPath(home), { force: true })
      expect(loadSettings({ home }).settings.devTools).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('env 契约常量', () => {
  test('Electrobun 原生层读的口 env 与壳覆盖 env 名字不被手滑改掉', () => {
    expect(DEVTOOLS_PORT_ENV).toBe('ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT')
    expect(DEVTOOLS_PORT_OVERRIDE_ENV).toBe('DSH_SHELL_DEVTOOLS_PORT')
  })
})
