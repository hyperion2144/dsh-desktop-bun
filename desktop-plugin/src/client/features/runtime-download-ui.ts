// 运行时下载的面板侧判定（#97）：纯函数，无 React、无 DOM。
//
// 为什么从 desktop-settings.tsx 里抽出来：下载的**终态判定**原先散在轮询 effect 的 then 分支里，
// 于是同时长出三个真 bug——超时弹窗后进度条永久卡住、取消与失败混为一谈（红字「安装失败 exit -15」）、
// 终态会被下一拍的 active 覆盖。判定一旦收进纯函数，这三条都能被 scripts/test-client.mjs 毫秒级钉住。

/** 壳侧 `runtime_download_status` 的回包（`cancelled` 是 #97 新增；老壳没有，按可选读）。 */
export interface RuntimeDownloadSnapshot {
  active: boolean
  version: string
  resolved: number
  downloaded: number
  added: number
  error: string
  cancelled?: boolean
}

/** 面板给每个版本记的一格状态。 */
export type RuntimeDownloadEntry = 'downloading' | 'downloaded' | { failed: string } | { cancelled: true }

/** 壳侧 `list_runtime_catalog` 里与「哪棵在跑」有关的字段。 */
export interface RuntimeUsageInput {
  /** 设置里钉的偏好版本（**期望**，重启后才生效；不等于正在跑的那棵） */
  selected?: string | null
  /** 随包内置的版本号 */
  builtin?: string | null
  /** 实际在跑的那棵树（壳侧 runtime 快照；老壳可能没有这个字段） */
  running?: { kind: string; version: string | null; dir?: string | null } | null
}

export interface RuntimeDownloadDecision {
  /** 这一拍要显示的进度；null = 撤掉进度条。 */
  progress: { version: string; resolved: number; downloaded: number; added: number } | null
  /** 这一拍怎么改 runtimeDownloading：写一格，或 remove 掉一格；null = 不动这张表。 */
  entry:
    | { version: string; value: RuntimeDownloadEntry }
    | { version: string; remove: true }
    | null
  /** 终态提示；null = 不弹。tone: ok 绿 / error 红 / info 中性（取消用中性，不吓人）。 */
  toast: { text: string; tone: 'ok' | 'error' | 'info' } | null
}

const IDLE: RuntimeDownloadDecision = { progress: null, entry: null, toast: null }

/** 去掉壳侧错误文案里的前缀，面板自己组织句子（避免「下载失败：下载失败：…」）。 */
export function stripDownloadErrorPrefix(text: string): string {
  return text.replace(/^下载失败[:：]\s*/, '').trim()
}

function present(version: string | null | undefined): version is string {
  return version !== null && version !== undefined && version !== ''
}

/**
 * 一拍轮询结果的判定。
 *
 * 关键约束（都是 #97 的症状）：
 * - `active` 期间这一格只能是「下载中」，但**进度数字照写**——之前一进 active 就把进度留着不撤，
 *   超时弹窗一关就再没人去动它，于是进度条永久定格。
 * - 取消是**独立终态**：中性提示 + 可重试，不与失败混同。
 * - `sawActive=false`（面板刚挂载、没赶上进行中那一拍）仍然要写终态，但**不弹 toast**。
 */
export function decideRuntimeDownload(s: RuntimeDownloadSnapshot, sawActive: boolean): RuntimeDownloadDecision {
  if (s.active) return {
    progress: { version: s.version, resolved: s.resolved, downloaded: s.downloaded, added: s.added },
    entry: { version: s.version, value: 'downloading' },
    toast: null,
  }
  if (!present(s.version)) return IDLE
  const cancelled = s.cancelled === true
  const failed = s.error !== ''
  if (!cancelled && !failed) {
    // 成功：撤进度 + 摘掉这一格（版本已进已装列表，行上会标「已下载」）
    return sawActive
      ? { progress: null, entry: { version: s.version, remove: true }, toast: { text: `dsh ${s.version} 下载完成`, tone: 'ok' } }
      : IDLE
  }
  const reason = stripDownloadErrorPrefix(s.error)
  const entry: RuntimeDownloadEntry = cancelled ? { cancelled: true } : { failed: reason === '' ? '未知错误' : reason }
  const text = cancelled
    ? `dsh ${s.version} 下载已取消`
    : `dsh ${s.version} 下载失败：${reason === '' ? '未知错误' : reason}`
  return {
    progress: null,
    entry: { version: s.version, value: entry },
    toast: sawActive ? { text, tone: cancelled ? 'info' : 'error' } : null,
  }
}

/** 这一格与现有的一格是否等价（用来避免每 600ms 重写同一个终态，把「重置失败态」的毛病堵死）。 */
export function sameDownloadEntry(a: RuntimeDownloadEntry | undefined, b: RuntimeDownloadEntry): boolean {
  if (a === undefined) return false
  if (typeof a === 'string' || typeof b === 'string') return a === b
  if ('failed' in a && 'failed' in b) return a.failed === b.failed
  if ('cancelled' in a && 'cancelled' in b) return true
  return false
}

/**
 * 顶部「当前使用：…」那一行。#97：判据是**实际在跑的那棵树**（`running`），不是设置里钉的 `selected`。
 * 原先以 `selected` 为准，于是用户钉了 .2、壳回退到 .1 时，「使用中」标在了根本没在跑的 .2 行上。
 */
export function currentRuntimeLine(input: RuntimeUsageInput): string {
  const builtin = input.builtin ?? null
  const selected = input.selected ?? null
  const runningVersion = input.running?.version ?? null
  const kind = input.running?.kind ?? ''
  if (present(runningVersion)) {
    const builtinRun = present(builtin) && runningVersion === builtin
    const head = builtinRun
      ? `当前使用：内置 dsh ${builtin}（兜底）`
      : `当前使用：运行时 ${runningVersion}${kind === '' ? '' : `（${kind}）`}`
    // 钉了号但还没生效时如实说出来，而不是把「使用中」提前标到没在跑的那一行
    if (present(selected) && selected !== runningVersion) return `${head}（已选择 ${selected}，重启后生效）`
    return head
  }
  if (present(selected)) return `当前使用：运行时 ${selected}${present(builtin) ? `（内置兜底 ${builtin}）` : ''}`
  if (present(builtin)) return `当前使用：内置 dsh ${builtin}（兜底）`
  return '当前无可用 dsh'
}

/**
 * 这一行是不是「正在用」。#97 症状⑤「两行同显使用中」：旧判据 `selected ? selected === v : isBuiltin || isRunning`
 * 在 selected 为空时把内置行和运行行同时标上。现在只看实际在跑的那棵树；它读不到时才回退内置。
 */
export function isRuntimeInUse(input: RuntimeUsageInput, version: string): boolean {
  const runningVersion = input.running?.version ?? null
  if (present(runningVersion)) return runningVersion === version
  const builtin = input.builtin ?? null
  return present(builtin) && builtin === version
}

/** 行的下载按钮文案：#97 多了「取消」与「已取消」两态。 */
export function runtimeDownloadButtonLabel(entry: RuntimeDownloadEntry | undefined): string {
  if (entry === 'downloading') return '下载中…'
  if (entry === 'downloaded') return '已下载'
  if (entry !== undefined && typeof entry === 'object') {
    return 'cancelled' in entry ? '已取消 · 重试下载' : '重试下载'
  }
  return '下载'
}

/** 行的提示文案：失败给原因，取消给中性说明。 */
export function runtimeDownloadHint(entry: RuntimeDownloadEntry | undefined): string {
  if (entry === undefined || typeof entry === 'string') return ''
  return 'cancelled' in entry ? '下载已取消' : entry.failed
}
