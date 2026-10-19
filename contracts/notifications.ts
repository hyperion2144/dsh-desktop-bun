/**
 * 通知 tab 命令（contract 中间层）。
 * 授权状态 / 场景配置 / 试听与音效导入 / 本机播放能力（#74 探测）。
 */

export type NotifyPermission = 'granted' | 'denied' | 'not_determined' | 'unavailable'

/** 单格式的可用性（面板靠 ok/reason 决定禁用与说明）。 */
export interface SoundFormatSupport {
  ok: boolean
  /** 命中的后端 id；不可用时为 null。 */
  backend: string | null
  /** 不可用时给用户的一句话；可用时为 null。 */
  reason: string | null
}

/** 本机播放能力报告（三平台后端探测的结论；可序列化）。 */
export interface SoundCapabilityReport {
  platform: string
  formats: { wav: SoundFormatSupport; mp3: SoundFormatSupport; ogg: SoundFormatSupport }
  /** 缺后端时给面板顶部的总说明；三种都能播 = null。 */
  hint: string | null
}

/** 通知配置（壳内部形状，camelCase 照实写：config 进出的两端同形）。 */
export interface NotificationsConfig {
  enabled: boolean
  dnd: { on: boolean; from: string; to: string; suppressFullscreen: boolean }
  /** 场景 id → 场景配置（id 白名单在壳 shared/settings.ts 的 NOTIFICATION_SCENARIOS）。 */
  scenarios: Record<string, { enabled: boolean; sound: string }>
}

/** get_notifications_state.scenarios 的一行（14 条场景的元数据 + 当前配置）。 */
export interface NotificationScenarioRow {
  id: string
  group: string
  name: string
  desc: string
  defaultOn: boolean
  config: { enabled: boolean; sound: string } | null
}

export interface NotificationCommands {
  get_notifications_state: {
    args: {}
    result: {
      permission: NotifyPermission
      config: NotificationsConfig
      scenarios: NotificationScenarioRow[]
      /** 展示分组（顺序即设置页里出现的顺序）。 */
      groups: ReadonlyArray<readonly [string, string]>
      sounds: string[]
      capability: SoundCapabilityReport | null
      /** 当前应用 bundle id（被拒绝提示的 tccutil 命令要拼真实 id，#142）。 */
      bundleId: string | null
    }
  }

  set_notifications_config: {
    args: { config: NotificationsConfig }
    result: { config: NotificationsConfig }
  }

  /** 主动申请授权；没有桥（非 macOS / 没打包）时如实回 prompted:false，不假装申请过。 */
  request_notification_permission_cmd: {
    args: {}
    result: { granted: boolean; permission: NotifyPermission; prompted: boolean }
  }

  /** 试听：`custom:<名>` 或裸名播 sounds 目录，`default` 播系统提示音。audible=false = 本机没响。 */
  preview_notification_sound: {
    args: { sound?: string; name?: string }
    result: { played: string | null; sound: string; audible: boolean }
  }

  /** 弹原生文件选择器选音频；取消为 null。 */
  choose_notification_sound: {
    args: {}
    result: string | null
  }

  /** 把音频文件收进 $DSH_HOME/sounds/，返回入库文件名。 */
  import_notification_sound: {
    args: { path: string }
    result: string
  }
}
