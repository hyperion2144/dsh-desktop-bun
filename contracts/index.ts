/**
 * dsh-desktop-bun 命令契约（contract 中间层）。
 *
 * 壳（desktop-electrobun/src/bun/commands.ts）与页侧（desktop-plugin/src/client）
 * 之间唯一共享的「命令叫什么、收什么、回什么」事实源：
 *   - 壳命令表 `satisfies CommandHandlers`：漏键、多键、回执走形都在壳 typecheck 时炸；
 *   - 页侧 `invokeCommand<K>`：命令名与参数、回执全部按契约检查；
 *   - `COMMAND_NAMES` 供运行时测试断言包含关系（不再读源码文本）。
 *
 * 规矩：本目录只写类型与常量，不 import 壳/插件的任何代码；按域分文件，index 只做拼装。
 */

import type { SettingsCommands } from './settings.ts'
import type { RuntimeCommands } from './runtime.ts'
import type { DownloadCommands } from './downloads.ts'
import type { NotificationCommands } from './notifications.ts'
import type { DiagnosticsCommands } from './diagnostics.ts'
import type { LoggingCommands } from './logging.ts'
import type { ProfileCommands } from './profiles.ts'
import type { BrowserGuestCommands } from './guests.ts'
import type { UpdateCommands } from './updates.ts'

export type {
  KeepAwakeCapability,
  ProxySnapshot,
  DshSourceSnapshot,
  SettingsCommands,
} from './settings.ts'
export type {
  InstalledRuntime,
  RuntimeCatalogSnapshot,
  RuntimeDownloadStatus,
  RuntimeCommands,
} from './runtime.ts'
export type {
  DownloadStatus,
  DownloadKind,
  DownloadTask,
  DownloadCommands,
} from './downloads.ts'
export type {
  NotifyPermission,
  SoundFormatSupport,
  SoundCapabilityReport,
  NotificationsConfig,
  NotificationScenarioRow,
  NotificationCommands,
} from './notifications.ts'
export type { DiagnosticsCommands } from './diagnostics.ts'
export type {
  LogArchiveRow,
  LogActiveFile,
  LogHealth,
  LoggingCommands,
} from './logging.ts'
export type {
  ProfilePortRow,
  ProfileDependencyRow,
  TaskSnapshot,
  MigrationStatus,
  StartupNeeded,
  ProfileCommands,
} from './profiles.ts'
export type {
  GuestPushKind,
  GuestState,
  GuestPush,
  GuestReservation,
  BrowserGuestCommands,
} from './guests.ts'
export type {
  UpdatePhase,
  UpdateView,
  UpdateActions,
  UpdateSnapshot,
  ShellUpdateStatus,
  UpdateNoticeTarget,
  UpdateNoticeState,
  UpdateCommands,
} from './updates.ts'

/** 壳服务的全部命令（76 条），按域拼装；域之间不允许重复键。 */
export interface Commands
  extends SettingsCommands,
  RuntimeCommands,
  DownloadCommands,
  NotificationCommands,
  DiagnosticsCommands,
  LoggingCommands,
  ProfileCommands,
  BrowserGuestCommands,
  UpdateCommands { }

/** 命令名（= Commands 的键；COMMAND_NAMES 是它的运行时清单，拼写錨在类型上）。 */
export type CommandName = keyof Commands

/**
 * 命令名清单（运行时包含关系断言用；顺序 = 壳命令表声明顺序）。
 * 元素类型锚在 CommandName 上：这里多写或写错一个名字，typecheck 直接炸；
 * 「Commands 里的键一个不少」由壳侧测试对 COMMAND_NAMES 与命令表键做集合比对保证。
 */
export const COMMAND_NAMES: readonly CommandName[] = [
  // settings
  'get_desktop_client_environment',
  'get_desktop_settings_data',
  'save_desktop_settings',
  'get_proxy_settings',
  'save_proxy_settings',
  'toggle_zoom',
  'ui_input_confirm',
  'get_dsh_status',
  'get_dsh_source',
  'read_desktop_keybindings',
  'write_desktop_keybindings',
  // runtime
  'list_runtime_catalog',
  'runtime_download_status',
  'download_runtime',
  'cancel_runtime_download',
  'remove_runtime',
  'restart_dsh_service',
  'restart_desktop_app',
  'test_proxy_connectivity',
  // downloads
  'list_downloads',
  'get_download_settings',
  'set_download_concurrency',
  'pause_download',
  'resume_download',
  'cancel_download',
  'clear_finished_downloads',
  'reveal_download',
  'start_blob_download',
  'save_blob_chunk',
  'finish_blob_download',
  'start_url_download',
  // notifications
  'get_notifications_state',
  'set_notifications_config',
  'request_notification_permission_cmd',
  'preview_notification_sound',
  'choose_notification_sound',
  'import_notification_sound',
  // diagnostics
  'log_console',
  'log_console_batch',
  'log_diag',
  'get_diagnostics',
  'export_diagnostics',
  // logging
  'list_log_files',
  'export_log_range',
  'clear_logs',
  'get_boot_payload',
  'show_context_menu',
  'open_external',
  'close_current_window',
  'exit_window_instance',
  // profiles
  'list_profile_ports',
  'list_profile_dependency_status',
  'task_status',
  'check_startup_needed',
  'confirm_startup_profile',
  'get_pending_active_profile',
  'rebuild_profile_dependencies',
  'migrate_profile',
  'migration_status',
  // guests
  'browser_guest_acquire',
  'browser_guest_release',
  'browser_guest_navigate',
  'browser_guest_control',
  'browser_guest_set_bounds',
  'browser_guest_set_visible',
  'browser_guest_state',
  'browser_guest_release_all',
  // updates
  'get_update_state',
  'check_update',
  'download_update',
  'apply_update',
  'get_shell_update_status',
  'get_update_notice_state',
  'set_update_notice_enabled',
  'restore_update_notice',
  'clear_update_notice_ignored',
]


/** 每条命令的参数形状。 */
export type CommandArgs<K extends CommandName> = Commands[K]['args']
/** 每条命令的回执形状。 */
export type CommandResult<K extends CommandName> = Commands[K]['result']

/**
 * 壳命令表的目标形状：createCommandTable 的返回值 `satisfies CommandHandlers`。
 * args 锚在契约形状上（页侧可见的那份）；ctx 是壳侧 RPC 传输上下文，不进页侧契约：
 * 类型上写 never 表示「调用者永不传」，实现侧可以窄化成壳自己的 RpcContext。
 */
export type CommandHandlers = {
  [K in keyof Commands]: (args: CommandArgs<K>, ctx: never) => CommandResult<K> | Promise<CommandResult<K>>
}

/**
 * 页侧调用清单形状：无参命令免传 args，有参命令必传——invokeCommand 用它约束第二参。
 */
export type CommandArgList<K extends CommandName> =
  keyof CommandArgs<K> extends never ? [args?: Record<string, never>] : [args: CommandArgs<K>]
