// Windows 通知身份（#107）：让系统通知横幅显示应用名与应用图标，而不是进程名「BUN」。
//
// 机制：Win32 进程弹 WinRT toast 时，Windows 按 AUMID（AppUserModelID）在系统里找
// 通知身份（显示名 + 图标）；查不到就回退显示可执行文件名（bun.exe → 「BUN」）且无图标。
// 两步补齐（#107 维护者决议）：
//   ① 进程声明：shell32!SetCurrentProcessExplicitAppUserModelID（bun:ffi，进程生命周期一次）；
//   ② 身份注册：HKCU\Software\Classes\AppUserModelId\<AUMID> 写 DisplayName + IconUri
//     （Win10 1903+ 免 Start Menu 快捷方式，等价 WinRT ToastNotificationManagerCompat 的
//      注册表机制；不兼容 1903 之前——快捷方式 PropertyStore 方案归安装器地图 #87）。
// AUMID 与显示名跟 Windows 安装器同源（APP_ID / APP_NAME，shared/app.ts 单一来源；
// 防漂移断言见 test/win-notify-identity.test.ts）。
//
// 降级契约：任何一步失败都不阻断壳启动——通知照常投递（Electrobun 原生通道），
// 只是身份回退「BUN」现状；每步失败都落一条诊断日志（真机验收时看得见原因）。

import { dlopen, FFIType, ptr } from 'bun:ffi'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ID, APP_NAME } from '../../shared/app/app.ts'
import { shellProjectRoot } from '../runtime/runtime.ts'

/** AUMID 注册表身份键根（HKCU，每用户，无需管理员；reg.exe 的键路径形态）。 */
export const APP_USER_MODEL_ID_KEY = 'HKCU\\Software\\Classes\\AppUserModelId'

/** 通知身份图标的环境覆盖口（与其余 DSH_SHELL_* 同性质）。 */
export const NOTIFY_ICON_ENV = 'DSH_SHELL_NOTIFY_ICON'

/** 进程 AUMID 声明器（可注入；缺省走 bun:ffi shell32，仅 Windows 上可能成功）。返回 HRESULT（0=S_OK，失败码进日志便于真机排查）。 */
export type AumidDeclarer = (aumid: string) => number

/**
 * 身份注册的 reg 命令组：DisplayName 恒写；IconUri 只在图标解析到时写。
 *  `reg add /f` 幂等（重复启动覆盖同值，无副作用）。每值一条命令、各带 /f：reg add 的
 *  文档化语法是单值，多值合并语法在目标 Windows 版本上无法在仓内核验——两连发
 *  spawnSync 只多几十毫秒，稳字当头（#107 审查裁决）。
 */
export function registryIdentityCommands(
  aumid: string,
  displayName: string,
  iconPath: string | null,
): string[][] {
  const key = `${APP_USER_MODEL_ID_KEY}\\${aumid}`
  const commands = [['reg', 'add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', displayName, '/f']]
  if (iconPath !== null) {
    commands.push(['reg', 'add', key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', iconPath, '/f'])
  }
  return commands
}

/**
 * 通知身份图标：环境覆盖 > 包内/仓内 resources（与 tray.ico 同一条打包链路：
 * dev 在 desktop-electrobun/resources/，打包态 build.copy 落 runtime/）。
 * 找不到返回 null——身份只写显示名，不算失败。
 */
export function resolveNotifyIcon(input: {
  env?: Record<string, string | undefined>
  projectRoot?: string
  exists?: (path: string) => boolean
} = {}): string | null {
  const env = input.env ?? process.env
  const exists = input.exists ?? existsSync
  const explicit = env[NOTIFY_ICON_ENV]
  if (explicit !== undefined && explicit !== '') return explicit
  const projectRoot = input.projectRoot ?? shellProjectRoot({ env })
  for (const candidate of [
    join(projectRoot, 'resources', 'app-icon.ico'),
    join(projectRoot, 'runtime', 'app-icon.ico'),
  ]) {
    if (exists(candidate)) return candidate
  }
  return null
}

let declareSymbol: ((aumid: string) => number) | null | undefined

function defaultDeclareAumid(): AumidDeclarer {
  // 懒加载：dlopen 只在真调用的平台上发生（非 Windows 上 shell32 必失败）。
  if (declareSymbol === undefined) {
    try {
      const lib = dlopen('shell32.dll', {
        SetCurrentProcessExplicitAppUserModelID: { args: [FFIType.pointer], returns: FFIType.i32 },
      })
      declareSymbol = (aumid: string): number => {
        // PCWSTR：UTF-16LE + 终结零（Buffer 指针直传，args 数组不经 shell）。
        const wide = Buffer.from(`${aumid}\0`, 'utf16le')
        return lib.symbols.SetCurrentProcessExplicitAppUserModelID(ptr(wide))
      }
    } catch {
      declareSymbol = null
    }
  }
  const symbol = declareSymbol
  if (symbol === null) return (): number => 0x80004005 // E_FAIL：dlopen 失败，进程声明不可能成功
  return (aumid: string): number => symbol(aumid) // 原样透传 HRESULT（0=S_OK），调用方记日志用
}

function defaultRunCommand(command: string[]): boolean {
  try {
    const child = Bun.spawnSync(command, { stdout: 'ignore', stderr: 'ignore' })
    return child.exitCode === 0
  } catch {
    return false
  }
}

export interface WindowsNotifyIdentityResult {
  /** 进程 AUMID 是否声明成功（失败时 toast 的 AUMID 可能不是我们声明的这个）。 */
  declared: boolean
  /** 注册表身份是否写成功（尝试的命令全部成功；图标缺失跳过 IconUri 不算失败）。 */
  registered: boolean
  /** 实际写进身份的图标路径（没解析到 = null）。 */
  iconUri: string | null
}

export interface WindowsNotifyIdentityOptions {
  platform?: NodeJS.Platform
  log?: (line: string) => void
  env?: Record<string, string | undefined>
  /** 项目根（测试注入；缺省走 runtime.ts 的同一条解析链）。 */
  projectRoot?: string
  exists?: (path: string) => boolean
  /** 进程 AUMID 声明（测试注入；缺省 bun:ffi shell32）。 */
  declareAumid?: AumidDeclarer
  /** reg 命令执行（测试注入；缺省 Bun.spawnSync）。 */
  runCommand?: (command: string[]) => boolean
}

/**
 * Windows 通知身份：声明进程 AUMID + 注册系统通知身份。只在 win32 生效
 * （其它平台返回 null，零副作用）；两步互相独立，任一失败只降级不抛出。
 */
export function ensureWindowsNotifyIdentity(
  options: WindowsNotifyIdentityOptions = {},
): WindowsNotifyIdentityResult | null {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return null
  const log = options.log ?? ((): void => {})
  const env = options.env ?? process.env
  const declare = options.declareAumid ?? defaultDeclareAumid()
  const runCommand = options.runCommand ?? defaultRunCommand

  let declared = false
  let declareHresult: number | null = null
  try {
    declareHresult = declare(APP_ID)
    declared = declareHresult === 0 // S_OK
  } catch (error) {
    log(`[notify-identity] AUMID 声明抛错：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!declared) {
    const code = declareHresult === null ? '抛错' : `HRESULT=0x${(declareHresult >>> 0).toString(16).padStart(8, '0')}`
    log(`[notify-identity] 进程 AUMID 声明失败（${code}，SetCurrentProcessExplicitAppUserModelID）——通知仍走注册表身份`)
  }

  let iconUri: string | null = null
  try {
    iconUri = resolveNotifyIcon({ env, projectRoot: options.projectRoot, exists: options.exists })
  } catch (error) {
    log(`[notify-identity] 图标解析抛错：${error instanceof Error ? error.message : String(error)}`)
  }
  if (iconUri === null) {
    log(`[notify-identity] 未找到应用图标（${NOTIFY_ICON_ENV} / resources / runtime 均无），身份只写显示名`)
  }

  let registered = true
  for (const command of registryIdentityCommands(APP_ID, APP_NAME, iconUri)) {
    let ok = false
    try {
      ok = runCommand(command)
    } catch (error) {
      log(`[notify-identity] 身份注册抛错：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!ok) {
      registered = false
      log(`[notify-identity] 身份注册命令失败：${command.join(' ')}`)
    }
  }
  if (registered) {
    log(`[notify-identity] Windows 通知身份就绪：AUMID=${APP_ID}（「${APP_NAME}」${iconUri === null ? '，无图标' : ''}）`)
  }
  return { declared, registered, iconUri }
}
