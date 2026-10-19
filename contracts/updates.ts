/**
 * 应用更新与启动更新提醒命令（contract 中间层）。
 * #220 框架 Updater 的壳视图 + #136 提醒开关与拉黑列表（状态在 update-notice.json，
 * 不碰 desktop-settings.json——键名是契约红线）。
 */

/** 壳视图里的更新阶段（比 Electrobun 的 29 个状态粗，够 UI 用）。 */
export type UpdatePhase =
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'preparing'
  | 'ready'
  | 'error'

/** 更新状态机视图（客户端卡片直接渲染这个结构）。 */
export interface UpdateView {
  available: boolean
  reason: string
  phase: UpdatePhase
  label: string
  status: string
  message: string
  current: string
  latest: string
  channel: string
  baseUrl: string
  feedUrl: string
  updateAvailable: boolean
  updateReady: boolean
  progress: number | null
  bytesDownloaded: number | null
  totalBytes: number | null
  error: string
  /** 状态最后一次变化的时刻（毫秒；没变化过为 0）。 */
  at: number
}

/** 三个按钮能不能点，以及一句「为什么不能点」（客户端直接照这个渲染）。 */
export interface UpdateActions {
  canCheck: boolean
  canDownload: boolean
  canApply: boolean
  hint: string
}

/** check/download/apply/get 四条更新命令的统一回执。 */
export interface UpdateSnapshot {
  available: boolean
  reason: string
  view: UpdateView
  actions: UpdateActions
}

/** 「不再提示」指向的一个具体版本（带路：同号壳与运行时是两个键）。 */
export interface UpdateNoticeTarget {
  kind: 'shell' | 'runtime'
  version: string
}

/** update-notice.json 的状态形状（三条 update-notice 命令的统一回执）。 */
export interface UpdateNoticeState {
  /** 总开关，默认开。 */
  enabled: boolean
  /** 拉黑键（`shell:<版本>` / `runtime:<版本>`）。 */
  ignored: string[]
  /** 已提醒过的最高版本，分两路。 */
  lastNotified: { shell: string | null; runtime: string | null }
}

export interface UpdateCommands {
  /** 拿不到更新源（dev 构建、没配 release.baseUrl）不报错，回带 reason 的视图。 */
  get_update_state: {
    args: {}
    result: UpdateSnapshot
  }

  check_update: {
    args: {}
    result: UpdateSnapshot
  }

  download_update: {
    args: {}
    result: UpdateSnapshot
  }

  apply_update: {
    args: {}
    result: UpdateSnapshot
  }

  get_update_notice_state: {
    args: {}
    result: UpdateNoticeState
  }

  set_update_notice_enabled: {
    args: { enabled: boolean }
    result: UpdateNoticeState
  }

  /** 「恢复」：把一批版本从拉黑里拿掉（不在列表里 = 幂等 no-op）。 */
  restore_update_notice: {
    args: { targets: UpdateNoticeTarget[] }
    result: UpdateNoticeState
  }

  clear_update_notice_ignored: {
    args: {}
    result: UpdateNoticeState
  }
}
