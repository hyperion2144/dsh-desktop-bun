/**
 * 启动后那次后台检查的编排（#142）：查 → 判 → 弹 → 记账。
 *
 * 三条硬约束（都是踩过的坑）：
 *   · **不阻塞**：整个函数是 fire-and-forget，壳的窗口与托盘不等人。内部只等两个探针，各自带超时；
 *   · **静默优先**：查不到（离线 / 超时 / dev 构建没有 `release.baseUrl` / 目录拉取失败）就一路都不响，
 *     失败原因只进日志与托盘灰字（#141 复用），不弹「检查失败」的噪音；
 *   · **只弹一次**：真弹了才记账（`lastNotified`），开窗失败（模型判定没东西可提醒）不记账，
 *     下次还能再弹。
 *
 * 判定本身在 `shared/update-notice-policy.ts`（纯逻辑，可单测）；版本号比较在 #138 的判定层与
 * `shared/update.ts`，这里**一个版本号都不比**。
 */

import type { UpdateNoticePayload } from '../windows/update-notice-dialog.ts'
import {
  decideUpdateNotice,
  type UpdateNoticeKind,
  type UpdateNoticeSegmentInput,
} from '../../shared/notify/update-notice-policy.ts'
import { topRuntimeUpdate, type RuntimeUpdateReport } from '../../shared/runtime/runtime-update.ts'
import type { UpdateView } from '../../shared/runtime/update.ts'
import type { Logger } from '../../shared/logging/levels.ts'
import type { UpdateNoticeStore } from './update-notice-store.ts'

/** 壳这一路的探测结果：`view` 为 null 表示压根没接上更新（dev 构建）。 */
export interface UpdateNoticeShellProbe {
  view: UpdateView | null
  /** 这次信息可不可信（离线 / 超时 / 没配更新源 ⇒ false ⇒ 这一路静默）。 */
  fresh: boolean
}

/** 运行时这一路的探测结果：`report` 由 #138 的判定层产出，这里不重算。 */
export interface UpdateNoticeRuntimeProbe {
  report: RuntimeUpdateReport | null
  fresh: boolean
}

export interface UpdateNoticeCheckDeps {
  store: Pick<UpdateNoticeStore, 'read' | 'markNotified'>
  probeShell: () => Promise<UpdateNoticeShellProbe>
  probeRuntime: () => Promise<UpdateNoticeRuntimeProbe>
  /** 当前窗口上下文（profile / 在跑版本 / 设置偏好）——组窗载荷用。 */
  context: () => Pick<UpdateNoticePayload, 'profile' | 'profiles' | 'baseline' | 'preference'>
  /** 开窗；返回 false 表示「没什么可提醒的」，没开窗 ⇒ 不记账。Promise 也认（#139：开窗前先等 rpc 挂好）。 */
  open: (payload: UpdateNoticePayload) => boolean | Promise<boolean>
  log: Logger
  /** 单路探测的超时；超时按「没查成」处理（静默），不让它挂住整次检查。 */
  timeoutMs?: number
  /** 运行时那一路的超时（带安装可行性闸门，得比壳那一路宽）。 */
  runtimeTimeoutMs?: number
  /**
   * 这次检查是启动后自动跑的还是用户在托盘上亲手点的（#141）。
   * `manual` 会绕过总开关与「已提醒过」两道闸门（显式问一句就该有答案），但**拉黑仍然认**。
   */
  trigger?: 'startup' | 'manual'
}

export interface UpdateNoticeCheckResult {
  notify: boolean
  reason: string
  notified: UpdateNoticeKind[]
}

const DEFAULT_TIMEOUT_MS = 8000

/**
 * 运行时那一路要额外来一道「装得上吗」的闸门（查 npm registry 上它 pin 的第一方依赖闭包，
 * 实测一次约 170 个请求、7 秒上下；8 秒的共用预算贴着它，超了就静默吞掉本该弹的窗。
 * 壳那一路仍是 8 秒。两路各给各的，别让慢的那路拖住快的那路。
 */
const RUNTIME_TIMEOUT_MS = 20000

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

function shellSegment(probe: UpdateNoticeShellProbe): UpdateNoticeSegmentInput {
  const view = probe.view
  const has = view !== null && view.updateAvailable === true && typeof view.latest === 'string' && view.latest !== ''
  return { kind: 'shell', version: has ? view.latest : null, fresh: probe.fresh }
}

function runtimeSegment(probe: UpdateNoticeRuntimeProbe): UpdateNoticeSegmentInput {
  const report = probe.report
  const top = report === null ? null : topRuntimeUpdate(report)
  return { kind: 'runtime', version: top === null ? null : top.version, fresh: probe.fresh }
}

/**
 * 跑一次检查。任何异常都吞成一条理由——它是启动后的后台活，炸了也不能带倒壳。
 */
export async function runUpdateNoticeCheck(deps: UpdateNoticeCheckDeps): Promise<UpdateNoticeCheckResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const runtimeTimeoutMs = deps.runtimeTimeoutMs ?? Math.max(timeoutMs, RUNTIME_TIMEOUT_MS)
  const shellTimeout: UpdateNoticeShellProbe = { view: null, fresh: false }
  const runtimeTimeout: UpdateNoticeRuntimeProbe = { report: null, fresh: false }
  try {
    const state = deps.store.read()
    // #141：托盘手动那次连总开关也绕过——用户亲手点的「检查更新」，回一句「已关闭」是答非所问。
    if (deps.trigger !== 'manual') {
      // 开关关了就在**探针之前**返回：用户已经说过不要提醒，不该为一次不要的提醒付两次网络。
      if (!state.enabled) {
        const reason = '启动更新提醒已关闭'
        deps.log.debug(`不提醒：${reason}`)
        return { notify: false, reason, notified: [] }
      }
    }
    const [shell, runtime] = await Promise.all([
      withTimeout(deps.probeShell(), timeoutMs, shellTimeout),
      withTimeout(deps.probeRuntime(), runtimeTimeoutMs, runtimeTimeout),
    ])
    const decision = decideUpdateNotice({
      // 同上：手动那次把开关当开着走（拉黑仍然认——那是「永远别再提它」，不是「这次别问我」）。
      enabled: deps.trigger === 'manual' || state.enabled,
      ignored: state.ignored,
      lastNotified: state.lastNotified,
      respectNotified: deps.trigger !== 'manual',
      segments: [shellSegment(shell), runtimeSegment(runtime)],
    })
    if (!decision.notify) {
      deps.log.debug(`不提醒：${decision.reason}`)
      return { notify: false, reason: decision.reason, notified: [] }
    }
    const kinds = new Set(decision.notified.map((segment) => segment.kind))
    const context = deps.context()
    // 只把「这次该提醒的那几路」交给窗：已经提醒过的版本不该跟着再占一栏。
    const opened = await deps.open({
      ...context,
      shell: kinds.has('shell') ? shell.view : null,
      runtime: kinds.has('runtime') ? runtime.report : null,
    })
    if (!opened) {
      const reason = '没什么可提醒的（窗没开）'
      deps.log.debug(`不提醒：${reason}`)
      return { notify: false, reason, notified: [] }
    }
    deps.store.markNotified(
      decision.notified.map((segment) => ({ kind: segment.kind, version: segment.version ?? '' })),
    )
    deps.log.info(`${decision.reason}，已弹窗并记账`)
    return { notify: true, reason: decision.reason, notified: [...kinds] }
  } catch (error) {
    const reason = `检查失败：${error instanceof Error ? error.message : String(error)}`
    deps.log.warn(reason)
    return { notify: false, reason, notified: [] }
  }
}
