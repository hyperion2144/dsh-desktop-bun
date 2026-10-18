// 面板用到的数据形状，单独成模块：这些类型只描述「壳回吐什么」，不含任何逻辑，
// 过去混在 2300 行的入口文件里，导致每个卡片模块都得 import 入口。
import type { KeepAwakeCapabilityLike } from '../keep-awake-note.ts'

/** dsh settings 服务的命名空间读写通道（#50 时期保留的捕获口，面板按它决定要不要落盘）。 */
export interface NsRpc {
  rpc: { call: (channel: string, endpoint: string, payload?: unknown) => Promise<NsRpcResponse> }
}

export interface NsRpcResponse {
  ok?: boolean
  error?: { message?: string }
  value?: unknown
}

export interface ProxySettings {
  proxy_mode: string
  proxy_url: string
  no_proxy: string
  proxy_user: string
  proxy_pass: string
  effective?: { http?: string; https?: string; all?: string; no_proxy?: string }
}

export interface DesktopData {
  remote_addr: string | null
  remote_list: string[]
  port: number
  profiles: Array<{ name: string; active: boolean; selectable: boolean }>
  /** #144 网关心跳覆盖（null/缺省 = 壳默认 30s；0 = 不覆盖） */
  mux_heartbeat_ms?: number | null
  /** #175 移动端会话守卫退避基数（毫秒；null/缺省 = 壳默认 10000，范围 1s..600s） */
  mobile_guard_backoff_ms?: number | null
  /** #147 路线 A：手机端是否改用桌面布局 */
  desktop_layout_on_phones?: boolean | null
  /** #186 防休眠：有会话在跑时阻止系统休眠（缺省 true；屏幕仍会照常熄灭） */
  prevent_sleep?: boolean | null
  /** #69 开发者工具：打包态重启后开远程调试口并放出菜单（CEF 或 win WebView2 载体；缺省 false；安全面） */
  dev_tools?: boolean | null
  /** #75 防休眠能力（壳探测到的系统抑制通道）：缺位 = 老壳，available:false = 本环境拿不到，面板必须明说降级 */
  keep_awake?: KeepAwakeCapabilityLike | null
}

export interface DshSourceState {
  mode: string
  builtin: { dsh_version: string } | null
  running: { mode: string; origin: string; port: number; version?: string } | null
}

export interface ProfilePortRow {
  profile: string
  page_port: number
  upstream_port: number
  lane_port: number
  running: boolean
}

export interface RuntimeCatalog {
  source: string
  builtin: string | null
  selected: string | null
  installed: { version: string }[]
  catalog: { version: string; channel: string }[]
  /** #107：目录拉取失败时的降级标记（此时 catalog 为空、installed 为本地全部已装） */
  error?: string
  /** #79：运行时回退说明（偏好版本不在已装目录时的用户可见原因；无回退为 null） */
  note?: string | null
  /** 当前真正在跑的那棵树（override | installed | builtin）：标记「运行中」并禁掉它的下载/卸载 */
  running?: { kind: string; version: string | null; dir: string | null } | null
}

/** 应用更新（#220 决策 11）：壳把框架 Updater 的状态机翻成这个视图，客户端只负责渲染 */
export interface UpdateSnapshotLike {
  available: boolean
  reason: string
  view: {
    phase: string
    label: string
    message: string
    current: string
    latest: string
    channel: string
    progress: number | null
    bytesDownloaded: number | null
    totalBytes: number | null
    error: string
    updateReady: boolean
  }
  actions: { canCheck: boolean; canDownload: boolean; canApply: boolean; hint: string }
}

export interface MigrationStatus {
  running: boolean
  copied: number
  total: number
}

export interface BannerMsg {
  ok: boolean
  text: string
}

/** 面板顶部的横幅回执。原先是 DesktopSettingsPanel 的第二个 useState，逐字搬到这里。 */
export type Notify = (m: BannerMsg) => void
