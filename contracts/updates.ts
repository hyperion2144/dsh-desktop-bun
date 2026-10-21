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
  | 'no-release'
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

/**
 * 壳段自管安装包更新的状态快照（#235 `get_shell_update_status` 回执）。
 * 与 `desktop-electrobun/src/bun/platform/shell-update-status.ts` 的同名类型结构对齐——
 * 单一真源在本契约，平台模块 re-export 它。
 */
export interface ShellUpdateStatus {
  /** 下载进行中：页面摆进度条并锁按钮。 */
  active: boolean
  version: string
  /** 0–100 整数；拿不到总长时 null（页面显示不确定动画）。 */
  percent: number | null
  /** 非空 = 失败，页面红字显示。 */
  error: string
  /** 安装包已就绪：页面把壳段按钮换成「安装更新」。 */
  updateReady: boolean
  /** 安装包就绪/下载落点路径；空串 = 没有现成安装包。 */
  installerPath: string
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

  /** #235：壳段更新状态（自管安装包下载进度/就绪/失败）；面板进度条与提醒窗共用同一数据源。 */
  get_shell_update_status: {
    args: {}
    result: ShellUpdateStatus
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
