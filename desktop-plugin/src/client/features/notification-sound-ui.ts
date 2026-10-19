/**
 * 通知音效面板的判定层（#74）：把壳给的「本机播放能力」翻译成下拉项 / 明示文案 / 试听结论，
 * `notifications-tab.tsx` 只负责把结论画出来。
 *
 * 为什么单列一层：能力报告（`get_notifications_state.capability`）在老壳、测试桩、以及没接
 * 播放层的壳上会**整个缺失**（`null` / `undefined` / 字段残缺）——历史上面板出过「整片空白」
 * 事故，所以判定一律走这里，缺失一律按「不判定、不禁用、不报警」处理，让面板在数据面残缺时
 * 照常渲染。纯函数、不碰 React/DOM，`bun run test:client` 直接断言。
 */

/** 白名单扩展名（对齐壳侧 notify-policy 的 SOUND_EXTENSIONS）。 */
export const SOUND_EXTENSIONS = ['wav', 'mp3', 'ogg'] as const

/** 白名单里的音效扩展名（小写）。 */
export type SoundExtension = (typeof SOUND_EXTENSIONS)[number]

/** 自定义音效档的值前缀（与壳侧 `custom:<名>` 同口径）。 */
const CUSTOM_PREFIX = 'custom:'

/** 壳侧没给原因时的兜底说明：不许出现「无法播放：」这种空尾巴。 */
const FALLBACK_REASON = '本机没有该格式的播放后端'

/** 单格式可用性（壳侧 `SoundFormatSupport` 的面板镜像）。 */
export interface SoundFormatSupport {
  ok: boolean
  /** 命中的后端 id；不可用时为 null。 */
  backend: string | null
  /** 不可用时给用户的一句话；可用时为 null。 */
  reason: string | null
}

/** 本机播放能力（壳侧 `SoundCapability` 的镜像；字段缺省＝不可知，不做判定）。 */
export interface SoundCapability {
  platform?: string
  /** 白名单三种格式各自能不能播。 */
  formats?: Partial<Record<SoundExtension, SoundFormatSupport>> | null
  /** 缺后端时的总说明；三种都能播＝null。 */
  hint?: string | null
}

/** 试听响应（壳侧 `preview_notification_sound`）；`audible` 在老壳上缺失。 */
export interface PreviewResult {
  /** 真放出去的目标；none/空档为 null。 */
  played?: string | null
  sound?: string
  /** 用户能不能听到；老壳没有这个字段。 */
  audible?: boolean
}

/** 一个已配置音效档的可用性。 */
export interface SoundOptionState {
  ok: boolean
  /** 不可用原因；可用或不可知时为 null。 */
  reason: string | null
  /** 自定义档的扩展名；内置档（default / none / __choose）为 null。 */
  extension: SoundExtension | null
}

/** 一个下拉选项的可渲染结论。 */
export interface SoundOption {
  value: string
  /** 选项文案；不可用时把原因写进文案（可见，不只藏在 title 里）。 */
  label: string
  /** 本机没有该格式的播放后端 ⇒ 下拉里禁用。 */
  disabled: boolean
  /** 悬停全文（禁用原因）；无话可说时 undefined。 */
  title: string | undefined
}

/** 音效名的白名单扩展名（小写）；不在白名单（含无后缀）返回 null，与壳侧 `soundExtension` 同口径。 */
export function soundExtension(name: string): SoundExtension | null {
  if (typeof name !== 'string') return null
  const dot = name.lastIndexOf('.')
  // dot <= 0：无后缀，或 `.bashrc` 这种隐藏文件（壳侧同样不认）
  if (dot <= 0) return null
  const extension = name.slice(dot + 1).toLowerCase()
  return (SOUND_EXTENSIONS as readonly string[]).includes(extension)
    ? (extension as SoundExtension)
    : null
}

/** 下拉值 `custom:<名>` 取出音效名；内置档 / 空名返回 null。 */
export function customSoundName(value: string): string | null {
  if (typeof value !== 'string' || !value.startsWith(CUSTOM_PREFIX)) return null
  const name = value.slice(CUSTOM_PREFIX.length)
  return name === '' ? null : name
}

/**
 * 一个已配置音效档的可用性：
 * 内置档（default / none / __choose）不做判定；扩展名不在白名单的也不误报（壳侧导入时就已拦）；
 * 只有能力报告明确说 `ok === false` 才判为不可用，报告缺失/字段残缺一律放行。
 */
export function soundOptionState(
  capability: SoundCapability | null | undefined,
  value: string,
): SoundOptionState {
  const name = customSoundName(value)
  if (name === null) return { ok: true, reason: null, extension: null }
  const extension = soundExtension(name)
  if (extension === null) return { ok: true, reason: null, extension: null }
  const support = capability?.formats?.[extension]
  if (support === undefined || support === null || typeof support.ok !== 'boolean') {
    return { ok: true, reason: null, extension }
  }
  if (support.ok) return { ok: true, reason: null, extension }
  const reason = typeof support.reason === 'string' && support.reason.trim() !== '' ? support.reason : null
  return { ok: false, reason: reason ?? FALLBACK_REASON, extension }
}

/** 不可用原因（壳侧 reason 优先，缺了有兜底）；可用或不可知时 null。 */
export function soundUnavailableReason(
  capability: SoundCapability | null | undefined,
  value: string,
): string | null {
  const state = soundOptionState(capability, value)
  return state.ok ? null : state.reason
}

/** 自定义音效下拉项：没有后端的格式禁用，并把原因写进文案（用户看得见，不只在下拉里）。 */
export function customSoundOptions(
  names: readonly string[],
  capability: SoundCapability | null | undefined,
): SoundOption[] {
  if (!Array.isArray(names)) return []
  return names.map((name) => {
    const value = `${CUSTOM_PREFIX}${name}`
    const reason = soundUnavailableReason(capability, value)
    if (reason === null) return { value, label: name, disabled: false, title: undefined }
    return { value, label: `${name}（本机无法播放：${reason}）`, disabled: true, title: reason }
  })
}

/** 缺后端时的总说明（壳侧 `hint`）；缺失、非串、空串一律当没有，面板不画空行。 */
export function capabilityHint(capability: SoundCapability | null | undefined): string | null {
  const hint = capability?.hint
  return typeof hint === 'string' && hint.trim() !== '' ? hint : null
}

/** 已配置音效本机播不了时的可见告警（不只在被禁用的下拉项里）；可播或不可知时 null。 */
export function configuredSoundWarning(
  capability: SoundCapability | null | undefined,
  sound: string,
): string | null {
  const reason = soundUnavailableReason(capability, sound)
  if (reason === null) return null
  const name = customSoundName(sound)
  return name === null ? `本机无法播放：${reason}` : `本机无法播放「${name}」：${reason}`
}

/**
 * 试听失败文案（#74：不许静默、不许假成功）。只有「真放出去了但没出声」才算失败：
 * · `played === null`（none / 空档）不是失败——本来就没打算响；
 * · `audible` 缺失（老壳 / 测试桩）按「不显示失败」处理，不许把老壳判成坏。
 */
export function previewFailure(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const { played, audible } = result as PreviewResult
  if (typeof played !== 'string' || played === '') return null
  if (audible !== false) return null
  const target = played.startsWith(CUSTOM_PREFIX) ? played.slice(CUSTOM_PREFIX.length) : played
  return target === 'default'
    ? '试听没有出声：本机没有可用的播放后端'
    : `试听没有出声：本机无法播放「${target}」`
}

/** 「权限不可用」横幅的渲染结论（PR #100 实测反馈：平台感知）。 */
export interface PermissionUnavailableCopy {
  /** 左侧 chip 文案；null = 不画 chip（win32 / linux 没有「授权」这个概念）。 */
  chip: string | null
  /** 是否走中性观感（不做告警色）；darwin / 平台不可知时为 false——旧观感逐字保留。 */
  neutral: boolean
  /** 正文。 */
  text: string
}

/** 旧文案逐字保留：只在 macOS 上成立（授权状态真来自 UN 桥）。 */
const UNAVAILABLE_MACOS_TEXT =
  '当前环境无法查询系统通知权限（dev 裸二进制或平台不支持）；验收请使用打包后的 .app。'
const UNAVAILABLE_CHIP = '权限不可用'

/**
 * `permission === 'unavailable'` 横幅的文案（平台感知）：
 * · win32 / linux：通知由系统通知中心负责，壳根本不查询授权状态——旧文案里的「dev 裸二进制」
 *   「打包后的 .app」对这两个平台是假话，换中性说法且不画告警 chip；
 * · darwin 或平台缺失 / 非字符串 / 未知值（老壳、字段残缺、冷门平台）：逐字保留旧文案，
 *   绝不把「不知道」当成 Windows。
 */
export function permissionUnavailableCopy(platform: unknown): PermissionUnavailableCopy {
  if (platform === 'win32' || platform === 'linux') {
    const name = platform === 'win32' ? 'Windows' : 'Linux'
    return {
      chip: null,
      neutral: true,
      text: `${name} 的通知由系统通知中心负责，本应用不查询授权状态；能否弹出以系统设置为准。`,
    }
  }
  return { chip: UNAVAILABLE_CHIP, neutral: false, text: UNAVAILABLE_MACOS_TEXT }
}

/**
 * `permission === 'denied'` 横幅的文案（平台感知，#142）：
 * · darwin：给 `tccutil reset Notifications <id>` 的重置提示——id 必须用**当前**应用 id
 *   （app-identity 构建期口径，经 get_notifications_state 下发），不能写死旧壳 id；
 *   id 拿不到（老壳 / 字段残缺）就只给系统设置指引；
 * · 其余平台（win32 / linux / 未知）：没有 tccutil 这个工具，绝不出 mac 专属提示。
 */
export function deniedPermissionCopy(platform: unknown, bundleId: unknown): string {
  const base = '通知横幅不会显示。可在系统设置中手动开启。'
  if (platform !== 'darwin' || typeof bundleId !== 'string' || bundleId.trim() === '') return base
  return `${base}开发期可执行 tccutil reset Notifications ${bundleId} 后重试。`
}
