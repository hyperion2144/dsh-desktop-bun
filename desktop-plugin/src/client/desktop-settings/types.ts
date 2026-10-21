// 面板用到的数据形状：**全部从根 contracts/ 派生**（#190）——形状只有契约一处事实源，
// 这里只保留面板侧的名字与注释；手抄副本已删，改形状先改契约，编译期同步两端。
import type { Commands } from '../../../../contracts/index.ts'
/** dsh settings 服务的命名空间读写通道（#50 时期保留的捕获口，面板按它决定要不要落盘）。 */
export interface NsRpc {
  rpc: { call: (channel: string, endpoint: string, payload?: unknown) => Promise<NsRpcResponse> }
}

export interface NsRpcResponse {
  ok?: boolean
  error?: { message?: string }
  value?: unknown
}

/** 代理设置（get_proxy_settings 回执；effective 仅壳探测到系统代理时给出）。 */
export type ProxySettings = Commands['get_proxy_settings']['result']

/** 设置面板首屏数据（get_desktop_settings_data 回执）。 */
export type DesktopData = Commands['get_desktop_settings_data']['result']

/** 「dsh 来源」卡状态（get_dsh_source 回执）。 */
export type DshSourceState = Commands['get_dsh_source']['result']

/** 端口表一行（list_profile_ports 回执元素）。 */
export type ProfilePortRow = Commands['list_profile_ports']['result'][number]
/** 运行时目录快照（list_runtime_catalog 回执）。 */
export type RuntimeCatalog = Commands['list_runtime_catalog']['result']

/** 应用更新（#220 决策 11）：壳把框架 Updater 的状态机翻成这个视图，客户端只负责渲染。 */
export type UpdateSnapshotLike = Commands['get_update_state']['result']
/** 壳段自管安装包更新状态（#235 get_shell_update_status 回执）：面板进度条与提醒窗共用。 */
export type ShellUpdateStatusLike = Commands['get_shell_update_status']['result']

/** 迁移进度（migration_status 回执）。 */
export type MigrationStatus = Commands['migration_status']['result']

export interface BannerMsg {
  ok: boolean
  text: string
}

/** 面板顶部的横幅回执。原先是 DesktopSettingsPanel 的第二个 useState，逐字搬到这里。 */
export type Notify = (m: BannerMsg) => void
