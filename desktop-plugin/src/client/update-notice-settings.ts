/**
 * 启动更新提醒的设置面板视图模型（#136）。
 *
 * 为什么要单独一个模块：这一段要处理「从 RPC 回来的持久状态」——形状可能残、键可能没有前缀、
 * 版本可能重复。逻辑混进 `.tsx` 就只能靠人眼看面板，而人眼看不出「同号壳/运行时」这种坑。
 * 这里全是纯函数，跟着 `bun run test:client` 跑。
 *
 * 数据来源是 `app-support/update-notice.json`（壳持有，见 `src/bun/update-notice-store.ts`）。
 * **注意它不在 `desktop-settings.json` 里**——设置文件的键名是契约红线，壳内部状态不往里塞。
 */

export type UpdateNoticeKind = 'shell' | 'runtime'

export interface UpdateNoticeTarget {
  kind: UpdateNoticeKind
  version: string
}

export interface UpdateNoticeStateLike {
  enabled: boolean
  /** `kind:version` 形式的拉黑键；带前缀是必须的——壳与运行时的版本号完全可能同号。 */
  ignored: string[]
  lastNotified: { shell: string | null; runtime: string | null }
}

export interface IgnoredRow {
  /** 原始键；恢复 / 清空都按它回传给壳，客户端不自己拼键。 */
  key: string
  kind: UpdateNoticeKind | null
  version: string
  /** 给用户看的一行文案。 */
  label: string
}

const KIND_LABELS: Record<UpdateNoticeKind, string> = {
  shell: '桌面壳',
  runtime: 'DSH 运行时',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const versionOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

/**
 * RPC 回包校验。返回 null = 这不是一份可用的状态（面板据此显示「读不到」而不是假装开着）。
 * `enabled` 只认显式 `false` 为关：默认开，缺字段的老文件不该被当成用户关掉了提醒。
 */
export function parseUpdateNoticeState(raw: unknown): UpdateNoticeStateLike | null {
  if (!isRecord(raw)) return null
  const ignored = Array.isArray(raw.ignored)
    ? [...new Set(raw.ignored.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))]
    : []
  const last = isRecord(raw.lastNotified) ? raw.lastNotified : {}
  return {
    enabled: raw.enabled !== false,
    ignored,
    lastNotified: { shell: versionOrNull(last.shell), runtime: versionOrNull(last.runtime) },
  }
}

/** 拆一个拉黑键；没有 `shell:` / `runtime:` 前缀的当未知来源（照样能显示、照样能被清掉）。 */
export function parseIgnoredKey(key: string): { kind: UpdateNoticeKind | null; version: string } {
  const at = key.indexOf(':')
  if (at <= 0) return { kind: null, version: key }
  const prefix = key.slice(0, at)
  const version = key.slice(at + 1).trim()
  if (version === '') return { kind: null, version: key }
  return (prefix === 'shell' || prefix === 'runtime') ? { kind: prefix, version } : { kind: null, version: key }
}

/**
 * 拉黑列表的展示行。壳版本在前、运行时在后，各按版本号从高到低——用户想找的是「我刚忽略的那个」。
 * 排序用 `localeCompare` 的数字模式而不是字典序：`0.2.10` 必须排在 `0.2.9` 后面。
 */
export function ignoredRows(ignored: readonly string[]): IgnoredRow[] {
  const rows = [...new Set(ignored)].map((key) => {
    const { kind, version } = parseIgnoredKey(key)
    return { key, kind, version, label: kind === null ? key : `${KIND_LABELS[kind]} ${version}` }
  })
  const rank = (row: IgnoredRow): number => (row.kind === 'shell' ? 0 : row.kind === 'runtime' ? 1 : 2)
  return rows.sort((a, b) => rank(a) - rank(b) || b.version.localeCompare(a.version, undefined, { numeric: true }))
}

/** 开关那行下面的解释文案。手动检查不受开关约束——这条必须写在面板上，不能只写在票面。 */
export function updateNoticeEnabledHint(enabled: boolean): string {
  return enabled
    ? '应用启动后会检查桌面壳与 DSH 运行时版本，有新版本时在应用内弹窗提醒（同一版本只提醒一次，出现更高版本才再弹）。托盘里的「检查更新」随时可用。'
    : '关掉后启动不再弹提醒。托盘里的「检查更新」随时可用——手动检查不受这个开关约束。'
}

/** 空列表时那行灰字。 */
export function ignoredEmptyHint(): string {
  return '没有被忽略的版本。'
}
