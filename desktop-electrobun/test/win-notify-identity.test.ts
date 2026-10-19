// Windows 通知身份（#107）：纯逻辑 + 注入面测试。真实 ffi / reg 只在 Windows 上发生，
// 这里全部走注入（平台 gate、命令构造、图标解析、两步降级契约）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { shellProjectRoot } from '../src/bun/runtime/runtime.ts'
import { APP_ID, APP_NAME } from '../src/shared/app/app.ts'
import {
  APP_USER_MODEL_ID_KEY,
  NOTIFY_ICON_ENV,
  ensureWindowsNotifyIdentity,
  registryIdentityCommands,
  resolveNotifyIcon,
} from '../src/bun/notify/win-notify-identity.ts'

const installerScript = readFileSync(join(import.meta.dir, '..', 'scripts', 'build-windows-installer.mjs'), 'utf8')

describe('身份常量与 Windows 安装器同源（#107 决议）', () => {
  test('APP_ID / APP_NAME 与 NSIS 模板逐字一致（防漂移，app-identity.test 同款源码断言）', () => {
    expect(APP_ID).toBe('DeepSeekHarnessDesktopBUN')
    expect(APP_NAME).toBe('DeepSeek Harness Desktop BUN')
    expect(installerScript).toContain('!define APP_ID "DeepSeekHarnessDesktopBUN"')
    expect(installerScript).toContain('!define APP_NAME "DeepSeek Harness Desktop BUN"')
    expect(installerScript).toContain("replaceAll('@@APP_NAME@@', 'DeepSeek Harness Desktop BUN')")
    expect(installerScript).toContain("replaceAll('@@APP_ID@@', 'DeepSeekHarnessDesktopBUN')")
  })

  test('NSIS 卸载器清理壳运行时写的通知身份键（#107 验收标准第 6 条：卸载后注册表身份清干净）', () => {
    expect(installerScript).toMatch(/DeleteRegKey HKCU "Software\\+Classes\\+AppUserModelId\\+@@APP_ID@@"/)
  })
})

describe('registryIdentityCommands（身份注册命令组）', () => {
  test('无图标：只写 DisplayName，键路径含 AUMID，/f 幂等收尾', () => {
    const commands = registryIdentityCommands('My.App', 'My App', null)
    expect(commands).toEqual([
      ['reg', 'add', `${APP_USER_MODEL_ID_KEY}\\My.App`, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'My App', '/f'],
    ])
  })

  test('有图标：DisplayName + IconUri 两条，同一个键', () => {
    const commands = registryIdentityCommands('My.App', 'My App', 'C:\\apps\\icon.ico')
    expect(commands).toHaveLength(2)
    expect(commands[1]).toEqual([
      'reg', 'add', `${APP_USER_MODEL_ID_KEY}\\My.App`, '/v', 'IconUri', '/t', 'REG_SZ', '/d', 'C:\\apps\\icon.ico', '/f',
    ])
  })
})

describe('resolveNotifyIcon（图标解析优先级）', () => {
  const existsFor = (paths: string[]) => (path: string): boolean => paths.includes(path)

  test('env 覆盖最优先（不看盘）', () => {
    const picked = resolveNotifyIcon({
      env: { [NOTIFY_ICON_ENV]: 'C:\\custom\\icon.ico' },
      projectRoot: '/root',
      exists: (): boolean => true,
    })
    expect(picked).toBe('C:\\custom\\icon.ico')
  })

  test('resources 优先于 runtime（与 tray 同链路：dev 在 resources，打包态落 runtime）', () => {
    const resourcesIcon = join('/root', 'resources', 'app-icon.ico')
    const runtimeIcon = join('/root', 'runtime', 'app-icon.ico')
    expect(resolveNotifyIcon({ env: {}, projectRoot: '/root', exists: existsFor([resourcesIcon, runtimeIcon]) })).toBe(resourcesIcon)
    expect(resolveNotifyIcon({ env: {}, projectRoot: '/root', exists: existsFor([runtimeIcon]) })).toBe(runtimeIcon)
  })

  test('两处都没有 → null（身份只写显示名，不算失败）', () => {
    expect(resolveNotifyIcon({ env: {}, projectRoot: '/root', exists: (): boolean => false })).toBeNull()
  })
})

describe('ensureWindowsNotifyIdentity（两步降级契约）', () => {
  const spyRun = (ok: boolean) => {
    const seen: string[][] = []
    return { seen, run: (command: string[]): boolean => { seen.push(command); return ok } }
  }

  test('非 win32：no-op（null），不声明、不执行任何命令', () => {
    const declareCalls: string[] = []
    const run = spyRun(true)
    const result = ensureWindowsNotifyIdentity({
      platform: 'darwin',
      declareAumid: (aumid) => { declareCalls.push(aumid); return 0 },
      runCommand: run.run,
    })
    expect(result).toBeNull()
    expect(declareCalls).toEqual([])
    expect(run.seen).toEqual([])
  })

  test('win32 全成功：declared/registered 双真，声明与命令都用决议常量', () => {
    const declareCalls: string[] = []
    const run = spyRun(true)
    const result = ensureWindowsNotifyIdentity({
      platform: 'win32',
      env: {},
      projectRoot: '/root',
      exists: (): boolean => true,
      declareAumid: (aumid) => { declareCalls.push(aumid); return 0 },
      runCommand: run.run,
    })
    expect(result).toEqual({ declared: true, registered: true, iconUri: join('/root', 'resources', 'app-icon.ico') })
    expect(declareCalls).toEqual([APP_ID])
    expect(run.seen).toHaveLength(2)
  })

  test('声明失败不放弃注册：两步互相独立，仍返回注册结果', () => {
    const run = spyRun(true)
    const result = ensureWindowsNotifyIdentity({
      platform: 'win32',
      env: {},
      projectRoot: '/root',
      exists: (): boolean => false,
      declareAumid: (): number => 0x80004005,
      runCommand: run.run,
    })
    expect(result).toEqual({ declared: false, registered: true, iconUri: null })
    expect(run.seen).toHaveLength(1)
    expect(run.seen[0]).toContain('DisplayName')
  })

  test('命令失败：registered=false，不抛（降级不阻断启动）', () => {
    const result = ensureWindowsNotifyIdentity({
      platform: 'win32',
      env: {},
      projectRoot: '/root',
      exists: (): boolean => false,
      declareAumid: (): number => 0,
      runCommand: (): boolean => false,
    })
    expect(result).toEqual({ declared: true, registered: false, iconUri: null })
  })

  test('声明抛错同样降级（ffi 异常不出这个函数）', () => {
    const result = ensureWindowsNotifyIdentity({
      platform: 'win32',
      env: {},
      projectRoot: '/root',
      exists: (): boolean => false,
      declareAumid: (): number => { throw new Error('ffi boom') },
      runCommand: (): boolean => true,
    })
    expect(result).toEqual({ declared: false, registered: true, iconUri: null })
  })
})

describe('shellProjectRoot（项目根解析链，#107 抽取共用）', () => {

  test('env 覆盖口 DSH_SHELL_PROJECT 最优先', () => {
    // launcherExe 明示 null：绕开 launcher 解析链（Windows runner 上冷解析偶发 5s 超时，快验 CI 实证）
    expect(shellProjectRoot({ env: { DSH_SHELL_PROJECT: '/custom/root' }, launcherExe: null })).toBe('/custom/root')
  })

  test('?? 语义：空串是有效覆盖，原样透传（与抽取前 trayImagePath/layout 的内联链一致）', () => {
    expect(shellProjectRoot({ env: { DSH_SHELL_PROJECT: '' }, launcherExe: null })).toBe('')
  })

  test('env 未设 DSH_SHELL_PROJECT：落到 import.meta.dir 解析链（测试进程里即仓内 desktop-electrobun/）', () => {
    const root = shellProjectRoot({ env: {}, launcherExe: null })
  })

  test('launcher 锚（#62 链上集成）：Electrobun 约定 <app 树>/bin/launcher.exe → Resources/app', () => {
    // 夹具走平台 resolve（win32 的 resolve 会给无盘符绝对路径补进程盘符——生产上 launcherExe
    // 来自系统查询恒带盘符）；期望值与实现同用 resolve/join 构造，分隔符不参与契约。
    const expectedRoot = resolve('/custom/install/app', 'Resources', 'app')
    const root = shellProjectRoot({
      env: {},
      launcherExe: resolve('/custom/install/app/bin', 'launcher.exe'),
      exists: (p) => p === join(expectedRoot, 'runtime', 'dsh-host.mjs'),
    })
    expect(root).toBe(expectedRoot)
  })
})
