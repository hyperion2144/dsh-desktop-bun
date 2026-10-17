/**
 * 要不要弹这张更新提醒卡（#142）：纯判定，不碰 IO、不碰网络。
 *
 * 四道闸门，顺序固定：
 *   ① 总开关关了 ⇒ 不弹（这是用户自己按的，静默遵从，不解释）；
 *   ② 这一路**没拿到可信信息**（离线 / 超时 / dev 构建没有 `release.baseUrl` / 目录拉取失败）⇒ 这一路静默。
 *      关键是**分路**静默：运行时目录拉挂了不该把壳更新也一起吞掉，反之亦然；
 *   ③ 这个版本被拉黑过（「不再提示」）⇒ 不弹；
 *   ④ 这个版本已经提醒过 ⇒ 不弹，直到出现**更高的**版本才再弹（默认同一版本只提醒一次）。
 *
 * 比较用两套：壳走 `compareVersions`，运行时走 `compareRuntimeVersions`（预发布次序不一样），
 * 这里不自己实现任何比较——那两处才是唯一实现。
 */

import { compareVersions } from './update.ts'
import { compareRuntimeVersions } from './runtime-catalog.ts'

export type UpdateNoticeKind = 'shell' | 'runtime'

/** 拉黑 / 记账键的拼法（与 `update-notice-store.ts` 同一条，见那里的理由：同号必须分路）。 */
export function updateNoticeKey(kind: UpdateNoticeKind, version: string): string {
  return `${kind}:${version}`
}

/** 「不再提示」指向的一个具体版本（带路，不带路就分不清同号的壳与运行时）。 */
export interface UpdateNoticeTarget {
  kind: UpdateNoticeKind
  version: string
}

export interface UpdateNoticeSegmentInput {
  kind: UpdateNoticeKind
  /** 本次查到的更高版本；null = 这一路没有可提醒的东西。 */
  version: string | null
  /** 这次的信息可不可信。false = 离线 / 超时 / dev 构建 / 拉取失败 ⇒ 这一路静默。 */
  fresh: boolean
}

export interface UpdateNoticePolicyInput {
  enabled: boolean
  /** 拉黑键（`shell:0.3.0` / `runtime:0.2.2-alpha.1`）。 */
  ignored: readonly string[]
  /** 已提醒过的最高版本，分两路。 */
  lastNotified: { shell: string | null; runtime: string | null }
  /**
   * 是否拿「已提醒过」当闸门（默认 true）。托盘上用户亲手点的「检查更新」（#141）传 false：
   * 「同一版本只提醒一次」是**启动提醒**的去重口径，手动检查是显式问一句，不该被它吃掉。
   * 「拉黑」（ignored）两种场景都认——那是用户对这个版本说过的「别再提了」。
   */
  respectNotified?: boolean
  segments: readonly UpdateNoticeSegmentInput[]
}

export interface UpdateNoticePolicyResult {
  notify: boolean
  /** 一句人话，进日志与托盘灰字（#141 复用）。 */
  reason: string
  /** 真要提醒时提醒了哪几路（记账用）。 */
  notified: UpdateNoticeSegmentInput[]
}

function compareOf(kind: UpdateNoticeKind): (a: string, b: string) => number {
  return kind === 'shell' ? compareVersions : compareRuntimeVersions
}

export function decideUpdateNotice(input: UpdateNoticePolicyInput): UpdateNoticePolicyResult {
  if (!input.enabled) return { notify: false, reason: '启动更新提醒已关闭', notified: [] }
  const stale: string[] = []
  const notified: UpdateNoticeSegmentInput[] = []
  for (const segment of input.segments) {
    const { kind, version, fresh } = segment
    // 先看信息可不可信：dev 构建（压根没配更新源）会同时满足「没查成」与「没版本号」，
    // 这时该报的是「这次没查成」，而不是「没有新版本」——票面要的是失败原因可见。
    if (!fresh) {
      stale.push(kind)
      continue
    }
    if (version === null || version === '') continue
    if (input.ignored.includes(updateNoticeKey(kind, version))) continue
    if (input.respectNotified !== false) {
      const seen = input.lastNotified[kind]
      if (seen !== null && compareOf(kind)(version, seen) <= 0) continue
    }
    notified.push(segment)
  }
  if (notified.length > 0) {
    const kinds = notified.map((segment) => (segment.kind === 'shell' ? '桌面壳' : 'DSH 运行时'))
    return { notify: true, reason: `有可用更新：${kinds.join(' + ')}`, notified }
  }
  if (stale.length > 0) {
    const names = stale.map((kind) => (kind === 'shell' ? '桌面壳' : 'DSH 运行时'))
    return { notify: false, reason: `${names.join(' + ')}这次没查成（离线 / 超时 / 未配置更新源），静默`, notified: [] }
  }
  return { notify: false, reason: '没有新的可用更新', notified: [] }
}
