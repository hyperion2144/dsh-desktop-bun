/**
 * 设置与环境命令（contract 中间层）。
 *
 * 本目录是壳（desktop-electrobun）与页侧（desktop-plugin）之间的**中性第三层**：
 * 只描述「命令叫什么、收什么、回什么」，不含任何实现，也不 import 两端的代码。
 * 壳与页各自 import 这里的类型，谁也不 import 谁——72 个命令名的知识只住这一处。
 *
 * 形状口径：字段名一律 wire 形状（snake_case 照 snake_case 写）；老壳可能不发的键
 * 一律可选（`?`），新增字段从「可选」开始，壳追上后再收紧。
 */

/** #75 防休眠能力快照（壳 keep-awake.ts 的 wire 形状；拿不到通道时面板必须能说出原因）。 */
export interface KeepAwakeCapability {
  platform: string
  backend: 'caffeinate' | 'execution-state' | 'systemd-inhibit' | 'gnome-session-inhibit' | null
  available: boolean
  reason: string | null
}

/** get_proxy_settings / save_proxy_settings 的回显（旧壳六字段 + effective 预览）。 */
export interface ProxySnapshot {
  proxy_mode: string
  proxy_url: string
  no_proxy: string
  proxy_user: string
  proxy_pass: string
  effective?: { http: string | null; https: string | null; all: string | null; no_proxy: string } | null
}

/** get_dsh_source 的回显（running.origin 是标签，不是 URL）。 */
export interface DshSourceSnapshot {
  mode: string
  builtin: { dsh_version: string } | null
  running: { mode: string; origin: string; port: number; version?: string } | null
}

export interface SettingsCommands {
  /** 渲染环境：客户端插件的第一步；壳回不出 platform/profile 时整片桌面 chrome 不激活。 */
  get_desktop_client_environment: {
    args: {}
    result: { platform: string; profile: string }
  }

  /** 设置面板读侧一次给全（旧壳 get_desktop_settings_data 的等价物 + settings 段）。 */
  get_desktop_settings_data: {
    args: {}
    result: {
      remote_addr: string | null
      remote_list: string[]
      port: number
      profiles: Array<{ name: string; active: boolean; selectable: boolean }>
      mux_heartbeat_ms?: number | null
      mobile_guard_backoff_ms?: number | null
      desktop_layout_on_phones?: boolean | null
      prevent_sleep?: boolean | null
      dev_tools?: boolean | null
      keep_awake?: KeepAwakeCapability | null
      origin?: string
      /** serializeSettings 的设置段（面板 nsGet 读它）；Record 是有意的：设置键随版本增加。 */
      settings?: Record<string, unknown>
    }
  }

  /** 保存设置：patch 必须是对象，壳走原子写。 */
  save_desktop_settings: {
    args: { patch: Record<string, unknown> }
    result: { settings: Record<string, unknown> }
  }

  get_proxy_settings: { args: {}; result: ProxySnapshot }

  /** F14 旧壳独立代理窗的保存口（新壳由设置面板承担，命令面对齐保留）。 */
  save_proxy_settings: {
    args: { proxy_mode?: string; proxy_url?: string; no_proxy?: string; proxy_user?: string; proxy_pass?: string }
    result: { ok: boolean; effective?: ProxySnapshot['effective'] }
  }

  /** F13 窗口⇄最大化切换。 */
  toggle_zoom: { args: {}; result: { ok: boolean } }

  /** F12 页面内确认弹窗回填（新壳同槽转发到 /__shell__/input-confirm）。 */
  ui_input_confirm: {
    args: { flow?: string; value?: string }
    result: { ok: boolean }
  }

  /** 底部状态条轮询口：旧壳的 0..7 枚举，缺省 2 =「运行中」。 */
  get_dsh_status: {
    args: {}
    result: { status: number; mode: string; origin: string; port: number }
  }

  get_dsh_source: { args: {}; result: DshSourceSnapshot }

  /** 桌面档快捷键偏好（#187）：壳只存原文，页面侧解析。 */
  read_desktop_keybindings: { args: {}; result: string | null }
  write_desktop_keybindings: {
    args: { raw: string }
    result: { }
  }
}
