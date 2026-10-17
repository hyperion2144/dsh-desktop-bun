// 通知投递（旧壳 `network/notify.rs` + `notify_un.rs` 的等价物）。
//
// 分层：决策在 `src/shared/notify-policy.ts`（纯函数），这里只负责「真的弹出去 / 真的响」。
// 平台投递：
//   · 有 Electrobun 时用它的 `Utils.showNotification`（index.ts 注入 `show`）——原生横幅 + 通知中心；
//   · 没注入时按平台退到命令行（macOS `osascript`、Linux `notify-send`、Windows 只记日志）：
//     黑盒测试与服务面（不起窗口）也能看到「本该弹什么」。
// 自定义音：`$DSH_HOME/sounds/<名>`，白名单（扩展名 + 名字）过了才放行；三平台各自的播放后端
// 与能力探测在 `./sound-playback.ts`（macOS afplay / Windows SoundPlayer·WPF / Linux 播放器表）。
//
// 不做的事（与规格一致）：通知**点击回调**（Electrobun 上游 #384 未支持）、通知中心去重。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  decide,
  defaultScenarioConfig,
  hasAllowedSoundExtension,
  isValidSoundName,
  localHm,
  MAX_SOUND_BYTES,
  MAX_SOUND_SECONDS,
  soundFormatMatches,
  soundExtension,
  soundsDir,
  type NotifyDecision,
} from '../shared/notify-policy.ts'
import {
  createSoundProbe,
  resolveSoundBackend,
  shellPlaysDefaultTone,
  soundCapabilityOf,
  systemDefaultTone,
  type SystemTone,
  type SoundCapability,
  type SoundProbe,
  type SoundProbeDeps,
} from './sound-playback.ts'
import type { NotificationsConfig } from '../shared/settings.ts'

export interface ShowNotificationOptions {
  title: string
  body: string
  silent: boolean
}

export interface NotifierOptions {
  notifications: NotificationsConfig
  /** `$DSH_HOME`（自定义音效目录的父目录）。 */
  home: string
  /** 应用名（通知标题）。 */
  appName?: string
  /** Electrobun 的原生通知；缺省走命令行兜底。 */
  show?: (options: ShowNotificationOptions) => void
  /** 播放自定义音（测试注入：注入即视为整个平台播放层被替换）；缺省按平台后端挑命令。 */
  playCustom?: (path: string) => boolean | void
  /** 播放命令的执行缝（测试注入：拿到命令即视为已起进程）；缺省 `Bun.spawn` 分离子进程。 */
  spawnSound?: (command: string[]) => boolean
  /** 平台播放能力探测依赖（测试注入 PATH / WPF / 子进程）。 */
  soundProbe?: SoundProbeDeps
  /** 直接给定能力报告（测试注入；给了就不再探测）。 */
  soundCapability?: SoundCapability
  /** 当前是否全屏（免打扰的「全屏静默」用）；缺省 false。 */
  isFullscreen?: () => boolean
  /** 窗口是否在前台聚焦（#115：聚焦就整条不投递）；缺省 false（无窗口/测试保持既有行为）。 */
  isFocused?: () => boolean
  /** 当前本地时刻；缺省 `new Date()`。 */
  now?: () => Date
  platform?: NodeJS.Platform
  onLog?: (line: string) => void
}

export interface Notifier {
  /** 按场景投递；返回决策（测试与日志都用得上）。 */
  notify: (scenarioId: string, body: string, title?: string) => NotifyDecision
  /** 只算不投（设置面板的试听/预览用）。 */
  decide: (scenarioId: string) => NotifyDecision
  /** 自定义音的绝对路径；名字非法或文件不合规时返回 null。 */
  soundPath: (name: string) => string | null
  /** 试听：真的放出去了才 true（本机没后端时 false，不假报成功）。 */
  previewSound: (name: string) => boolean
  /** 本机播放能力（设置面板据此禁用没有后端的格式）。 */
  soundCapability: () => SoundCapability
}

/** 命令行兜底：把通知文本转义后交给平台工具。 */
export function shellNotificationCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
): string[] | null {
  if (platform === 'darwin') {
    const escape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return ['osascript', '-e', `display notification "${escape(body)}" with title "${escape(title)}"`]
  }
  if (platform === 'linux') return ['notify-send', title, body]
  return null
}

/** `$DSH_HOME/sounds/` 下已入库的音效文件名（设置 tab 的下拉用；按名字排序）。 */
export function listSounds(home: string): string[] {
  try {
    return readdirSync(soundsDir(home))
      .filter((name) => hasAllowedSoundExtension(name))
      .filter((name) => {
        try {
          return statSync(join(soundsDir(home), name)).isFile()
        } catch {
          return false
        }
      })
      .sort()
  } catch {
    // 目录不存在＝还没有自定义音，不是错误
    return []
  }
}

/**
 * 把一个外部音频文件收进 `$DSH_HOME/sounds/`（旧壳 `sounds::import_file`）：
 * 文件名白名单 → 扩展名魔数 → 大小上限，逐关不过就抛，过了就拷贝，返回入库后的文件名。
 */
export function importSound(home: string, source: string): string {
  // basename：Windows 上用户选的是 `C:\Users\…\ding.wav`，split('/') 会把整条路径当文件名
  const name = basename(source)
  if (name === '' || !isValidSoundName(name)) throw new Error(`音效文件名不合法：${name}`)
  if (!hasAllowedSoundExtension(name)) {
    throw new Error(`不支持的音效格式（白名单：wav / mp3 / ogg）：${name}`)
  }
  let size = 0
  try {
    const info = statSync(source)
    if (!info.isFile()) throw new Error('不是普通文件')
    size = info.size
  } catch (error) {
    throw new Error(`无法读取文件：${error instanceof Error ? error.message : String(error)}`)
  }
  if (size > MAX_SOUND_BYTES) {
    throw new Error(`文件 ${String(MAX_SOUND_BYTES / 1024 / 1024)}MB 上限，当前 ${String(size)} 字节`)
  }
  const head = new Uint8Array(readFileSync(source).subarray(0, 4))
  if (!soundFormatMatches(name, head)) throw new Error('文件内容与扩展名不符（魔数校验失败）')
  const dir = soundsDir(home)
  mkdirSync(dir, { recursive: true })
  copyFileSync(source, join(dir, name))
  return name
}



export function createNotifier(options: NotifierOptions): Notifier {
  const log = options.onLog ?? ((): void => {})
  const platform = options.platform ?? process.platform
  if (options.show === undefined) {
    log('[notify] 未接原生通知（服务面 / 无窗口模式，或平台没有原生通道）')
  }
  const appName = options.appName ?? 'DSH'
  const now = options.now ?? ((): Date => new Date())

  const show =
    options.show ??
    ((payload: ShowNotificationOptions): void => {
      // macOS：旧壳早已弃用 `osascript display notification`（会以「脚本编辑器」身份投递，
      // 点横幅开错应用，见旧壳 notify_un.rs 头注释）。新壳同理：没接原生投递就只落日志，
      // 由调用方去接 Electrobun 原生投递 / notify_un 桥。
      if (platform === 'darwin') {
        log(`[notify] macOS 未接原生投递，本条只落日志：${payload.title}：${payload.body}`)
        return
      }
      const command = shellNotificationCommand(platform, payload.title, payload.body)
      if (command === null) {
        log(`[notify] ${payload.title}：${payload.body}（本平台暂无投递实现）`)
        return
      }
      try {
        const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
        child.unref?.()
      } catch (error) {
        log(`[notify] 投递失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })

  // 播放能力是一座机器一份：探测（Windows 的 WPF 那条要起一次 PowerShell）只做一次
  let probeCache: SoundProbe | null = null
  const probe = (): SoundProbe => (probeCache ??= createSoundProbe(options.soundProbe, platform))
  let capabilityCache: SoundCapability | null = options.soundCapability ?? null
  const capability = (): SoundCapability => (capabilityCache ??= soundCapabilityOf(platform, probe()))

  const spawnSound =
    options.spawnSound ??
    ((command: string[]): boolean => {
      try {
        const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
        child.unref?.()
        // 时长上限的第二道闸：到点还没退就杀（afplay -t / Start-Sleep 之外的地理兜底）
        const watchdog = setTimeout(() => {
          try {
            child.kill()
          } catch {
            // 已经自己退了：kill 报错无所谓
          }
        }, (MAX_SOUND_SECONDS + 1) * 1000)
        watchdog.unref?.()
        return true
      } catch (error) {
        log(`[notify] 播放自定义音失败：${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    })

  /** 默认播放：按平台后端挑命令；本机没后端就不播，也不假报成功（#74）。 */
  const playDefault = (path: string): boolean => {
    const extension = soundExtension(path)
    if (extension === null) {
      log(`[notify] 音效扩展名不在白名单，未播放：${basename(path)}`)
      return false
    }
    const backend = resolveSoundBackend(platform, extension, probe())
    if (backend === null) {
      log(`[notify] 本机无法播放（${capability().formats[extension]?.reason ?? '没有可用播放后端'}）：${basename(path)}`)
      return false
    }
    return spawnSound(backend.command(path))
  }

  /**
   * 系统默认提示音的投递侧播放（试听 `default` 档走 service.ts 的同名能力）。
   * `tone === null`（本机没有可用后端）时如实记日志、返回 false——不假报成功（#74）；
   * 命令由调用方先算好，因为「通道要不要安静」取决于壳真的放不放得出这一声。
   */
  const playSystemTone = (tone: SystemTone | null): boolean => {
    if (tone === null) {
      log('[notify] 系统默认提示音：本机没有可用播放后端，壳不播也未出声（是否响由通知通道决定）')
      return false
    }
    const played = spawnSound(tone.command)
    log(played ? `[notify] 系统默认提示音：${tone.label}` : '[notify] 系统默认提示音没能起播')
    return played
  }

  const playCustom: (path: string) => boolean =
    options.playCustom === undefined ? playDefault : (path) => options.playCustom?.(path) !== false

  const soundPath = (name: string): string | null => {
    if (!isValidSoundName(name)) {
      log(`[notify] 音效文件名不合法，已忽略：${name}`)
      return null
    }
    if (!hasAllowedSoundExtension(name)) {
      log(`[notify] 音效格式不在白名单（wav/mp3/ogg）：${name}`)
      return null
    }
    const path = join(soundsDir(options.home), name)
    if (!existsSync(path)) {
      log(`[notify] 音效文件不存在：${path}`)
      return null
    }
    const size = statSync(path).size
    if (size > MAX_SOUND_BYTES) {
      log(`[notify] 音效文件超过 ${String(MAX_SOUND_BYTES / 1024 / 1024)}MB，已忽略：${name}`)
      return null
    }
    return path
  }

  /** 窗口是否在前台聚焦（#115）。没有焦点信息（无窗口模式 / 测试）时视为不聚焦。 */
  const focusNow = (): boolean => options.isFocused?.() ?? false

  const decideFor = (scenarioId: string, focused: boolean = focusNow()): NotifyDecision =>
    decide(options.notifications, scenarioId, localHm(now()), options.isFullscreen?.() ?? false, focused)

  /**
   * 不投递的原因（只给日志用）：总开关 / 场景开关在先、聚焦在后，与 decide 的早退顺序一致——
   * 关着总开关的人不该在日志里看到「窗口在前台聚焦」而去查错方向。
   */
  const suppressLabel = (scenarioId: string, focused: boolean): string => {
    const scenario = options.notifications.scenarios[scenarioId] ?? defaultScenarioConfig(scenarioId)
    if (focused && options.notifications.enabled && scenario.enabled) return '窗口在前台聚焦'
    return '总开关或场景关闭'
  }

  return {
    decide: decideFor,
    notify: (scenarioId: string, body: string, title?: string): NotifyDecision => {
      const focused = focusNow()
      const decision = decideFor(scenarioId, focused)
      if (!decision.deliver) {
        log(`[notify] ${scenarioId} 未投递（${suppressLabel(scenarioId, focused)}）`)
        return decision
      }
      const heading = title ?? appName
      // 非 darwin 的投递通道都不带音频：配置成「系统默认音」时壳自己放（见 shellPlaysDefaultTone）。
      // 但只有壳真的放得出这一声，才让系统通知安静（免得跟壳放的重成两声）；壳放不出来就别替
      // 通道做决定——静音一条本就没声的通知等于彻底无声，只剩日志（独立验证 R1）。
      const selfTone = decision.sound.kind === 'os-default' && shellPlaysDefaultTone(platform)
      const tone = selfTone ? systemDefaultTone(platform, options.soundProbe) : null
      show({
        title: heading,
        body,
        silent: decision.silent || decision.sound.kind === 'silent' || tone !== null,
      })
      if (decision.sound.kind === 'custom') {
        const path = soundPath(decision.sound.name)
        if (path !== null) {
          const played = playCustom(path)
          log(
            played
              ? `[notify] 播放自定义音：${decision.sound.name}`
              : `[notify] 自定义音未出声（本机没有可用播放后端）：${decision.sound.name}`,
          )
        }
      } else if (selfTone) {
        playSystemTone(tone)
      }
      log(`[notify] ${scenarioId}：${body}${decision.silent ? '（静默）' : ''}`)
      return decision
    },
    soundPath,
    soundCapability: capability,
    // 设置面板的「试听」：只放自定义音（OS 默认音由系统自己弹，试听没意义）
    previewSound: (name: string): boolean => {
      const path = soundPath(name)
      if (path === null) return false
      const played = playCustom(path)
      log(played ? `[notify] 试听音效：${name}` : `[notify] 试听未出声（本机没有可用播放后端）：${name}`)
      return played
    },
  }
}
