/**
 * 启动更新提醒的持久化（#142）：`app-support/update-notice.json`。
 *
 * 为什么不写进 `desktop-settings.json`：设置文件的**键名是契约红线**（面板 / 托盘 / 旧壳都按它读），
 * 往里塞「提醒去重」这种壳内部状态，一旦改名就等于悄悄改了对外契约。独立文件想加字段就加。
 *
 * 三条落盘口径（照 `settings-store.ts` / `downloads.ts` 的既有写法）：
 *   · 原子写：先写 `*.json.tmp` 再 rename —— 直接覆写会留下半个 JSON；
 *   · 抗残文件：坏 JSON / 缺字段 / 类型不对都回落默认值，绝不把整份文件当废；
 *   · 读不到就用默认（enabled 默认开），不因为「状态文件坏了」就变成永远不提醒。
 *
 * 键的形状：
 *   · `ignored[]` 存 **`kind:version`**（`runtime:0.2.2-alpha.1`）。必须带前缀——壳与运行时的版本号
 *     都是 semver，完全可能同号；不带前缀的话「忽略这个运行时版本」会顺手把同号的壳更新也静音。
 *   · `lastNotified` 分两路记最高版本，因为壳与运行时不在同一个版本序列里，拿壳的号去比运行时毫无意义。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { compareVersions } from '../shared/update.ts'
import { compareRuntimeVersions } from '../shared/runtime-catalog.ts'

export const UPDATE_NOTICE_FILE = 'update-notice.json'

// 路与拉黑键的定义住在 shared（policy 也要用），这里只做 IO 与记账，不再定义一份。
export type { UpdateNoticeKind, UpdateNoticeTarget } from '../shared/update-notice-policy.ts'
export { updateNoticeKey } from '../shared/update-notice-policy.ts'

import { updateNoticeKey, type UpdateNoticeKind, type UpdateNoticeTarget } from '../shared/update-notice-policy.ts'

export interface UpdateNoticeState {
  /** 总开关，默认开（#136 的设置面板改它）。 */
  enabled: boolean
  /** 拉黑键，见文件头。 */
  ignored: string[]
  /** 已提醒过的最高版本，分两路。 */
  lastNotified: { shell: string | null; runtime: string | null }
}

export const DEFAULT_UPDATE_NOTICE_STATE: UpdateNoticeState = {
  enabled: true,
  ignored: [],
  lastNotified: { shell: null, runtime: null },
}

export function updateNoticePath(appSupport: string): string {
  return join(appSupport, UPDATE_NOTICE_FILE)
}


/** 只认非空串的版本号；`x.y.z` 之类的形状校验交给判定层，这里不重复实现。 */
function versionOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}


/** 残文件 / 半截 JSON / 老版本格式 ⇒ 默认值。任何异常都吞掉，理由记给 log。 */
export function parseUpdateNoticeState(raw: string | null): UpdateNoticeState {
  if (raw === null || raw.trim() === '') return { ...DEFAULT_UPDATE_NOTICE_STATE, lastNotified: { ...DEFAULT_UPDATE_NOTICE_STATE.lastNotified }, ignored: [] }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...DEFAULT_UPDATE_NOTICE_STATE, lastNotified: { ...DEFAULT_UPDATE_NOTICE_STATE.lastNotified }, ignored: [] }
    const row = parsed as Record<string, unknown>
    const ignored = Array.isArray(row['ignored'])
      ? [...new Set(row['ignored'].filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))]
      : []
    const last = typeof row['lastNotified'] === 'object' && row['lastNotified'] !== null ? (row['lastNotified'] as Record<string, unknown>) : {}
    return {
      enabled: row['enabled'] !== false,
      ignored,
      lastNotified: { shell: versionOrNull(last['shell']), runtime: versionOrNull(last['runtime']) },
    }
  } catch {
    return { ...DEFAULT_UPDATE_NOTICE_STATE, lastNotified: { ...DEFAULT_UPDATE_NOTICE_STATE.lastNotified }, ignored: [] }
  }
}

export function readUpdateNoticeState(appSupport: string): UpdateNoticeState {
  try {
    return parseUpdateNoticeState(readFileSync(updateNoticePath(appSupport), 'utf8'))
  } catch {
    // 文件不存在是正常首启；读坏了也不能让提醒永久失声。
    return { ...DEFAULT_UPDATE_NOTICE_STATE, lastNotified: { ...DEFAULT_UPDATE_NOTICE_STATE.lastNotified }, ignored: [] }
  }
}

export function writeUpdateNoticeState(appSupport: string, state: UpdateNoticeState): void {
  const path = updateNoticePath(appSupport)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}

export interface UpdateNoticeStore {
  read: () => UpdateNoticeState
  write: (state: UpdateNoticeState) => UpdateNoticeState
  /** 拉黑一批版本（去重、不覆盖既有项）。 */
  ignore: (targets: readonly UpdateNoticeTarget[]) => UpdateNoticeState
  /** 记账：这几路已经提醒过了（只往高处记；比较器在模块内选，不让调用方传错口径）。 */
  /** 恢复：把一批版本从拉黑里拿掉（设置面板的「恢复」，#136）。不在列表里就是幂等 no-op。 */
  restore: (targets: readonly UpdateNoticeTarget[]) => UpdateNoticeState
  /** 清空全部拉黑（设置面板的「清空全部」，#136）。 */
  clearIgnored: () => UpdateNoticeState
  markNotified: (targets: readonly UpdateNoticeTarget[]) => UpdateNoticeState
  setEnabled: (enabled: boolean) => UpdateNoticeState
}

/** 一个 appSupport 一个实例；多 profile 的服务面共用同一份状态（去重不能各算各的）。 */
export function createUpdateNoticeStore(appSupport: string, log?: (line: string) => void): UpdateNoticeStore {
  const read = (): UpdateNoticeState => readUpdateNoticeState(appSupport)
  const write = (state: UpdateNoticeState): UpdateNoticeState => {
    try {
      writeUpdateNoticeState(appSupport, state)
      return state
    } catch (error) {
      // 写不动就只丢这次记账：宁可多提醒一次，也不要让提醒功能整体炸掉。
      log?.(`[update-notice] 写 ${UPDATE_NOTICE_FILE} 失败：${String(error)}`)
      return state
    }
  }
  return {
    read,
    write,
    ignore: (targets) => {
      const current = read()
      const keys = new Set(current.ignored)
      for (const target of targets) {
        if (target.version !== '') keys.add(updateNoticeKey(target.kind, target.version))
      }
      return write({ ...current, ignored: [...keys] })
    },
    markNotified: (targets) => {
      const current = read()
      const lastNotified = { ...current.lastNotified }
      for (const target of targets) {
        if (target.version === '') continue
        const seen = lastNotified[target.kind]
        if (seen === null || compareOf(target.kind)(target.version, seen) > 0) lastNotified[target.kind] = target.version
      }
      return write({ ...current, lastNotified })
    },
    restore: (targets) => {
      const current = read()
      const drop = new Set(targets.map((target) => updateNoticeKey(target.kind, target.version)))
      if (drop.size === 0) return current
      return write({ ...current, ignored: current.ignored.filter((key) => !drop.has(key)) })
    },
    clearIgnored: () => {
      const current = read()
      // 已经空了就不写盘：少一次无谓的文件改动，也少一次并发写覆盖的机会。
      if (current.ignored.length === 0) return current
      return write({ ...current, ignored: [] })
    },
    setEnabled: (enabled) => write({ ...read(), enabled }),
  }
}

/** 一路一个比较器：壳走 semver 比较，运行时走预发布感知的那个（唯一实现都在 shared）。 */
function compareOf(kind: UpdateNoticeKind): (a: string, b: string) => number {
  return kind === 'shell' ? compareVersions : compareRuntimeVersions
}


