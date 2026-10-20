/**
 * 日志管理命令（contract 中间层）——统一日志内核的命令面（map #221）。
 *
 * 决策出处：#224 Decision v2（第 7 条命令契约 / 第 8 条诊断快照扩展 / 第 10 条 relay 纳入 /
 * 第 9 条 IO 健康度）；规格单 #232 命令契约节。
 *
 * 安全口径：三个命令**显式不进**远程/访客白名单（日志含敏感内容，仅本地面板可用）；
 * 契约测试对 GUEST/REMOTE 两张白名单各有一条「调用即拒绝」的负例钉住。
 */

/** 一份归档的台账行（wire 形状，字段名 snake_case）。 */
export interface LogArchiveRow {
  /** 文件名（如 `shell-20261020-01.log.gz`），不带目录。 */
  name: string
  /** 归档来源：壳主进程 / 页面 webview / relay 中继。 */
  source: 'shell' | 'webview' | 'relay'
  /** 内容起始日 YYYYMMDD（本地时区；不是轮转时刻）。 */
  day: string
  /** 当日序号（01 起）。 */
  seq: number
  bytes: number
}

/** 一个活跃日志文件的现状（wire 形状；沿用诊断快照 logs.shell/logs.webview 的字段口径）。 */
export interface LogActiveFile {
  source: 'shell' | 'webview' | 'relay'
  path: string
  bytes: number
  /** 该源在归档目录中的 .gz 份数（Decision 8 的 rotated 重定义）。 */
  rotated: number
}

/** 日志 IO 健康度（Decision 9：写/转/删失败不再静默）。 */
export interface LogHealth {
  io_error_count: number
  last_io_error: string | null
}

export interface LoggingCommands {
  /** 列日志现状：归档台账 + 三个活跃文件 + 当前级别 + 归档目录 + IO 健康度。 */
  list_log_files: {
    args: {
      /** true = 顺带在系统文件管理器里打开归档目录（沿用诊断导出的 reveal 先例）。 */
      reveal?: boolean
    }
    result: {
      archive_dir: string
      level: string
      archives: LogArchiveRow[]
      active: LogActiveFile[]
      health: LogHealth
    }
  }

  /**
   * 按时间范围导出日志为 tar.gz 单包，落用户选的目录，回执带产物路径与体积。
   * 时间口径：归档按内容日整体进出（from 端向前多捞 1 天）；壳/relay 活跃文件按行首戳逐行；
   * webview 活跃文件整文件近似（行无时间戳，manifest 注明）。
   */
  export_log_range: {
    args: {
      /** today | 7d | 30d | all | custom */
      range: 'today' | '7d' | '30d' | 'all' | 'custom'
      /** custom 起始日（YYYY-MM-DD 或 YYYYMMDD，本地时区；custom 必填）。 */
      from?: string
      /** custom 截止日（缺省 = from 同日，含端点）。 */
      to?: string
    }
    result: {
      /** 产物绝对路径（dsh-logs-YYYYMMDD-HHmmss.tar.gz）。 */
      path: string
      bytes: number
      /** 近似口径说明（当前只有 webview 整文件近似会出现）。 */
      approximations: string[]
      /** 选中的归档份数（含 from 端向前多捞的那天）。 */
      archives_included: number
    }
  }

  /** 一键清理：清空归档目录 + 截断三个活跃文件（截断后继续写；UI 侧二次确认）。 */
  clear_logs: {
    args: {}
    result: { removed_files: number; bytes_freed: number }
  }
}
