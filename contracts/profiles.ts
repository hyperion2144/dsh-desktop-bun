/**
 * profile 运维与启动检查命令（contract 中间层）。
 * 端口表 / 依赖状态 / 迁移与重建 / 启动确认。
 */

/** list_profile_ports 的一行：三类口分列（页面口 / dsh 上游口 / 手机代理 lane 口）。 */
export interface ProfilePortRow {
  profile: string
  page_port: number
  upstream_port: number
  lane_port: number
  running: boolean
}

/** list_profile_dependency_status 的一行（依赖卡逐行渲染）。 */
export interface ProfileDependencyRow {
  profile: string
  recordedPnpm: string | null
  builtinPnpm: string | null
  needsRebuild: boolean
  running: boolean
}

/** task_status 的九字段（迁移/重建进度卡轮询它）。 */
export interface TaskSnapshot {
  running: boolean
  finished: boolean
  kind: string
  title: string
  stage: string
  done: number
  total: number
  error: string
  result: string
}

/** migration_status 只回这三个字段。 */
export interface MigrationStatus {
  running: boolean
  copied: number
  total: number
}

/** check_startup_needed 的三种裁决（客户端读 snake_case details）。 */
export type StartupNeeded =
  | { action: 'none' }
  | { action: 'profile-selection'; profiles: string[] }
  | {
      action: 'profile-incomplete'
      profile: string
      details: { dir_exists: boolean; missing_files: string[]; node_modules_exists: boolean }
    }

export interface ProfileCommands {
  /** 多窗口：每份窗口各问一次壳，但端口表覆盖所有 profile；本 profile 最靠前。 */
  list_profile_ports: {
    args: {}
    result: ProfilePortRow[]
  }

  list_profile_dependency_status: {
    args: {}
    result: { profiles: ProfileDependencyRow[] }
  }

  task_status: { args: {}; result: TaskSnapshot }

  check_startup_needed: {
    args: {}
    result: StartupNeeded
  }

  /** 确认启动 profile（repair 时壳先重建依赖）；名称只允许字母、数字、_ 与 -。 */
  confirm_startup_profile: {
    args: { name: string; repair?: boolean }
    result: { }
  }

  /** 前端激活时取回启动时选的 profile（取走即清）。 */
  get_pending_active_profile: {
    args: {}
    result: string | null
  }

  /** 用内置 pnpm 重建依赖（阻塞数分钟）；profile 正在跑时壳拒绝。 */
  rebuild_profile_dependencies: {
    args: { profile?: string }
    result: string
  }

  /** 迁移 profile；目标已存在且未确认覆盖时壳抛「需确认覆盖」。 */
  migrate_profile: {
    args: { source: string; dest: string; overwrite?: boolean }
    result: string
  }

  migration_status: {
    args: {}
    result: MigrationStatus
  }
}
