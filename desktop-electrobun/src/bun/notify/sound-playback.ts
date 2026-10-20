// 本平台的「真的响」层（#74）：自定义音效与系统提示音的**后端探测**、**命令构造**与**能力报告**。
//
// 分层：决策在 `src/shared/notify-policy.ts`（纯函数），投递编排在 `src/bun/notifications.ts`，
// 这里只回答两件事——「这台机器上哪种格式真能响」「用哪条命令响」。
//
// 为什么必须有能力探测：三平台自带播放器覆盖的格式并不一样。macOS 的 `afplay` 走 AudioToolbox
// （wav/mp3 认，Ogg Vorbis 不认）；Windows 的 `System.Media.SoundPlayer` 只认 wav，mp3 要 WPF
// `MediaPlayer`（PresentationCore 装配不一定在，Windows N 版还缺 Media Foundation），ogg 两个都不认；
// Linux 则要看装了哪个播放器。不探测就会退回旧行为：**静默不播 + 面板假报成功**——正是 #74 的病根。
// 探测结果（`SoundCapability`）同时是设置面板的数据面：面板据此禁用没有后端的格式并说明原因。

import { existsSync } from 'node:fs'
import { MAX_SOUND_SECONDS, SOUND_EXTENSIONS, type SoundExtension } from '../../shared/notify/notify-policy.ts'

/** 一个平台播放后端：诊断名 + 播放命令构造。 */
export interface SoundBackend {
  /** 诊断名（日志 / 面板提示）：可执行文件名，或 `powershell-wpf` 这种复合通道。 */
  id: string
  /** 完整播放命令（含时长截断参数；进程级时长兜底由调用方 kill 兜住）。 */
  command: (path: string) => string[]
}

/** 单格式的可用性（面板靠 `ok`/`reason` 决定禁用与说明）。 */
export interface SoundFormatSupport {
  ok: boolean
  /** 命中的后端 id；不可用时为 null。 */
  backend: string | null
  /** 不可用时给用户的一句话（面板直接显示）；可用时为 null。 */
  reason: string | null
}

/** 本机播放能力报告（可序列化，经 `get_notifications_state` 交给设置面板）。 */
export interface SoundCapability {
  platform: NodeJS.Platform
  /** 白名单三种格式各自能不能播。 */
  formats: Record<SoundExtension, SoundFormatSupport>
  /** 缺后端时给面板顶部的总说明；三种都能播＝null。 */
  hint: string | null
}

/** 探测依赖（测试注入；缺省走真实 PATH / 真实子进程）。 */
export interface SoundProbeDeps {
  /** PATH 上有没有这个名字的可执行文件。 */
  hasCommand?: (name: string) => boolean
  /** Windows：PresentationCore（WPF MediaPlayer）能不能装配。 */
  hasWpf?: boolean
  /** 跑一条只取退出码的探测命令；缺省 `Bun.spawnSync`。 */
  runCommand?: (command: string[]) => boolean
  /** 环境变量（PATH / PATHEXT）；缺省 `process.env`。 */
  env?: Record<string, string | undefined>
  /** 路径存在性；缺省 `existsSync`。 */
  exists?: (path: string) => boolean
}

/** 探测结果：一次问答对象（WPF 那条要起 PowerShell，所以是惰性求值）。 */
export interface SoundProbe {
  hasCommand: (name: string) => boolean
  hasWpf: () => boolean
  fileExists: (path: string) => boolean
}

export interface WhichOptions {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
}

const WINDOWS_EXTENSIONS_FALLBACK = '.COM;.EXE;.BAT;.CMD'

/** `PresentationCore`（WPF）装配探测脚本：能装配退出 0，不能退出 1。 */
const WPF_PROBE_COMMAND = [
  'powershell',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  'try { Add-Type -AssemblyName PresentationCore -ErrorAction Stop } catch { exit 1 }',
]

/** freedesktop 主题提示音（Ogg Vorbis；按顺序取第一个存在的）。 */
const FREEDESKTOP_THEME_SOUNDS = [
  '/usr/share/sounds/freedesktop/stereo/complete.oga',
  '/usr/share/sounds/freedesktop/stereo/bell.oga',
]

/** 子进程探测：只关心退出码，stdout/stderr 一律丢弃，任何异常都算「不可用」。 */
function runCommandQuietly(command: string[]): boolean {
  try {
    return Bun.spawnSync(command, { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
  } catch {
    return false
  }
}

/**
 * PATH 上有没有这个可执行文件（自己扫目录，不起 `which` 子进程）。
 * Windows 认 `PATHEXT`（`powershell` → `powershell.exe`），并容忍 PATH 项带引号的写法。
 */
export function whichCommand(name: string, options: WhichOptions = {}): boolean {
  if (name === '') return false
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const rawPath = env.PATH ?? env.Path ?? ''
  if (rawPath === '') return false
  const extensions = platform === 'win32' ? ['', ...windowsExtensions(env.PATHEXT)] : ['']
  for (const entry of rawPath.split(platform === 'win32' ? ';' : ':')) {
    const dir = entry.trim().replace(/^"+|"+$/g, '')
    if (dir === '') continue
    for (const extension of extensions) {
      if (exists(joinFor(platform, dir, `${name}${extension}`))) return true
    }
  }
  return false
}

/**
 * 按目标平台拼路径。`whichCommand` 允许注入 platform，拼法就不能用宿主的 `path.join`：
 * 否则在 Windows 上跑「Linux 平台」的探测会拼出反斜杠，反过来也一样（CI 的 Windows 兜底 job 真炸过一次）。
 */
function joinFor(platform: NodeJS.Platform, dir: string, file: string): string {
  const separator = platform === 'win32' ? '\\' : '/'
  const trimmed = dir.replace(/[\\/]+$/, '')
  return trimmed === '' ? `${separator}${file}` : `${trimmed}${separator}${file}`
}

function windowsExtensions(pathext: string | undefined): string[] {
  const list = (pathext ?? WINDOWS_EXTENSIONS_FALLBACK)
    .split(';')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
  return [...new Set(list)]
}

/** 造一个探测对象；`hasWpf` 惰性——只有真要播 mp3 时才付那次 PowerShell 探测的钱。 */
export function createSoundProbe(deps: SoundProbeDeps = {}, platform: NodeJS.Platform = process.platform): SoundProbe {
  const exists = deps.exists ?? existsSync
  const hasCommand =
    deps.hasCommand ?? ((name: string): boolean => whichCommand(name, { env: deps.env, platform, exists }))
  let wpf: boolean | null = deps.hasWpf ?? null
  return {
    hasCommand,
    fileExists: exists,
    hasWpf: (): boolean => {
      if (wpf === null) {
        // 非 Windows 不问（也绝不 spawn）：这条只在 win32 上花钱
        wpf = platform === 'win32' && hasCommand('powershell') && (deps.runCommand ?? runCommandQuietly)(WPF_PROBE_COMMAND)
      }
      return wpf
    },
  }
}

// ── 三平台播放后端 ────────────────────────────────────────────────────────────

/** PowerShell 单引号字符串：内部的 `'` 双写转义（路径由用户在系统对话框里选，可能带引号）。 */
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`

const powershell = (script: string): string[] => [
  'powershell',
  '-NoProfile',
  '-NonInteractive',
  '-STA',
  '-Command',
  script,
]

const AFPLAY: SoundBackend = {
  id: 'afplay',
  command: (path) => ['afplay', '-t', String(MAX_SOUND_SECONDS), path],
}

const FFPLAY: SoundBackend = {
  id: 'ffplay',
  command: (path) => ['ffplay', '-nodisp', '-autoexit', '-loglevel', 'quiet', path],
}

const APLAY: SoundBackend = { id: 'aplay', command: (path) => ['aplay', '-q', path] }
const PAPLAY: SoundBackend = { id: 'paplay', command: (path) => ['paplay', path] }
const PW_PLAY: SoundBackend = { id: 'pw-play', command: (path) => ['pw-play', path] }
const MPG123: SoundBackend = { id: 'mpg123', command: (path) => ['mpg123', '-q', path] }
const OGG123: SoundBackend = { id: 'ogg123', command: (path) => ['ogg123', '-q', path] }

/** Windows wav：系统自带 SoundPlayer，PlaySync 阻塞到放完（超时由调用方 kill 兜住）。 */
const SOUND_PLAYER: SoundBackend = {
  id: 'powershell-soundplayer',
  command: (path) =>
    powershell(`$p = New-Object System.Media.SoundPlayer -ArgumentList ${psQuote(path)}; $p.PlaySync()`),
}

/** Windows 系统提示音候选 wav（Win10/11 自带；Server Core 之类可能一个都没有）。 */
const WINDOWS_MEDIA_SOUNDS = [
  'Windows Notify System Generic.wav',
  'Windows Notify.wav',
  'notify.wav',
  'Windows Ding.wav',
  'ding.wav',
  'chimes.wav',
] as const

/**
 * 系统盘的 Media 目录（`SystemRoot`/`windir` 优先，都缺省按 `C:\\Windows`）。
 * 平台是参数，拼法就跟参数走——这里不用宿主 `path.join`，理由同 `joinFor`。
 */
function windowsMediaDir(env: Record<string, string | undefined>): string {
  const root = env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows'
  return joinFor('win32', root, 'Media')
}

/** 一个候选 wav 都没找到时的兜底：系统事件音别名（可能被音效方案置为 (None)，不保证有声）。 */
const WINDOWS_ALIAS_FALLBACK =
  '[System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 600'

/** Windows mp3：WPF MediaPlayer（Open 是异步的，Start-Sleep 让进程活到播完/到上限）。 */
const WPF_PLAYER: SoundBackend = {
  id: 'powershell-wpf',
  command: (path) =>
    powershell(
      'Add-Type -AssemblyName PresentationCore; ' +
        '$m = New-Object System.Windows.Media.MediaPlayer; ' +
        `$m.Open((New-Object System.Uri -ArgumentList ${psQuote(path)})); ` +
        `$m.Play(); Start-Sleep -Seconds ${String(MAX_SOUND_SECONDS)}`,
    ),
}

/** Linux 各格式的后端优先级：只有真能解码该容器的后端才在表里（aplay 只吃 WAV，故不进 ogg/mp3）。 */
const LINUX_BACKENDS: Record<SoundExtension, ReadonlyArray<SoundBackend>> = {
  wav: [APLAY, PAPLAY, PW_PLAY, FFPLAY],
  mp3: [PAPLAY, PW_PLAY, FFPLAY, MPG123],
  ogg: [PAPLAY, PW_PLAY, FFPLAY, OGG123],
}

/** 探测结果 → 该平台该格式的播放后端；本机没有可用后端返回 null。 */
export function resolveSoundBackend(
  platform: NodeJS.Platform,
  extension: SoundExtension,
  probe: SoundProbe,
): SoundBackend | null {
  if (platform === 'darwin') {
    // afplay 是系统自带（/usr/bin/afplay），不依赖用户 PATH 能否找到——保持既有零回归口径。
    // 它不认 Ogg Vorbis：ogg 只有机器上装了 ffmpeg（ffplay）才真能响。
    if (extension !== 'ogg') return AFPLAY
    return probe.hasCommand('ffplay') ? FFPLAY : null
  }
  if (platform === 'win32') {
    if (extension === 'wav' && probe.hasCommand('powershell')) return SOUND_PLAYER
    if (extension === 'mp3' && probe.hasWpf()) return WPF_PLAYER
    // ogg（以及上面两条没成的情况）：Windows 自带播放器都不认，只有 ffmpeg 能救
    return probe.hasCommand('ffplay') ? FFPLAY : null
  }
  if (platform === 'linux') {
    for (const backend of LINUX_BACKENDS[extension]) {
      if (probe.hasCommand(backend.id)) return backend
    }
    return null
  }
  return null
}

/** 不可用时给用户的一句话（说明缺什么、怎么补）。 */
function missingReason(platform: NodeJS.Platform, extension: SoundExtension): string {
  if (platform === 'win32') {
    if (extension === 'ogg') return '系统自带播放器不认 Ogg Vorbis：装上 ffmpeg（提供 ffplay）后才能播'
    if (extension === 'mp3') return '本机装配不了 WPF 播放器（PresentationCore）：装上 ffmpeg（提供 ffplay）后才能播'
    return 'PATH 上找不到 powershell，无法播放 .wav'
  }
  if (platform === 'darwin') {
    if (extension === 'ogg') return 'macOS 自带播放器不认 Ogg Vorbis：装上 ffmpeg（提供 ffplay）后才能播'
    return `PATH 上找不到可播放 .${extension} 的后端`
  }
  if (platform === 'linux') {
    const candidates = LINUX_BACKENDS[extension].map((backend) => backend.id).join(' / ')
    return `PATH 上找不到能播 .${extension} 的播放器（${candidates}）`
  }
  return '本平台没有实现音频播放后端'
}

/** 探测结果 → 面板数据面（三种格式逐一给结论，外加一句总说明）。 */
export function soundCapabilityOf(platform: NodeJS.Platform, probe: SoundProbe): SoundCapability {
  const entries = SOUND_EXTENSIONS.map((extension) => {
    const backend = resolveSoundBackend(platform, extension, probe)
    const support: SoundFormatSupport =
      backend === null
        ? { ok: false, backend: null, reason: missingReason(platform, extension) }
        : { ok: true, backend: backend.id, reason: null }
    return [extension, support] as const
  })
  const formats = Object.fromEntries(entries) as Record<SoundExtension, SoundFormatSupport>
  const missing = entries.filter(([, support]) => !support.ok).map(([extension]) => extension)
  const firstMissing = missing[0]
  return {
    platform,
    formats,
    hint:
      firstMissing === undefined
        ? null
        : `本机没有 ${missing.map((extension) => `.${extension}`).join(' / ')} 的播放后端：${formats[firstMissing].reason ?? ''}`,
  }
}

/**
 * 系统默认提示音：命令 + 人看得懂的「放的是哪个音」（投递日志与真机诊断用）。
 */
export interface SystemTone {
  command: string[]
  /** 真正要响的东西：媒体文件路径，或退回事件音别名时的说明。 */
  label: string
}

/**
 * 投递系统通知时，「系统默认提示音」该由谁放：
 * macOS 的 UN 原生通知自带默认音（壳再放一遍就是叠声）；
 * Windows / Linux 的投递通道都不带音频（原生通道不保证有声、PowerShell 气泡静默、notify-send 不放音），
 * 配置成「系统默认音」时只能壳自己放——否则就是「通知弹出来了、没声」（PR #100 Windows 真机复测）。
 */
export function shellPlaysDefaultTone(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin'
}

/**
 * 系统默认提示音（D7，旧壳 rodio 的跨平台等价物；试听 `default` 档与通知投递都用它）：
 * macOS afplay 播 Ping.aiff；Windows 用 PowerShell 的 SoundPlayer 显式播系统自带 wav
 * （事件音别名会被音效方案静默掉，只有连一个 wav 都没有时才退回别名）；
 * Linux 取 freedesktop 主题音，但主题音是 Ogg Vorbis（.oga）——只有 paplay / pw-play / ffplay
 * 这类能解码的后端才算数（aplay 只吃 WAV，拿它播 .oga 就是「起了进程、什么都没响」）。
 * 本机没有可用后端时返回 null（调用方如实回「不响」，不再假报成功）。
 */
export function systemDefaultTone(platform: NodeJS.Platform, deps: SoundProbeDeps = {}): SystemTone | null {
  if (platform === 'darwin') {
    const ping = '/System/Library/Sounds/Ping.aiff'
    return { command: ['afplay', '-t', String(MAX_SOUND_SECONDS), ping], label: ping }
  }
  if (platform === 'win32') {
    // 显式播一个存在的 wav：SoundPlayer.PlaySync 阻塞到播完，不吃注册表里的音效方案。
    // 原来只播事件音别名——该事件被置为 (None) 时 PlaySound 带 SND_NODEFAULT 会静默返回、
    // 命令照样退出 0，真机上就是「日志说试听成功、耳朵里没声」（PR #100 Windows 实测）。
    const probe = createSoundProbe(deps, platform)
    if (!probe.hasCommand('powershell')) return null
    const media = windowsMediaDir(deps.env ?? process.env)
    for (const name of WINDOWS_MEDIA_SOUNDS) {
      const candidate = joinFor('win32', media, name)
      if (probe.fileExists(candidate)) return { command: SOUND_PLAYER.command(candidate), label: candidate }
    }
    return { command: powershell(WINDOWS_ALIAS_FALLBACK), label: '系统事件音别名（Asterisk.Play）' }
  }
  if (platform === 'linux') {
    const probe = createSoundProbe(deps, platform)
    for (const candidate of FREEDESKTOP_THEME_SOUNDS) {
      if (!probe.fileExists(candidate)) continue
      for (const backend of [PAPLAY, PW_PLAY, FFPLAY]) {
        if (probe.hasCommand(backend.id)) return { command: backend.command(candidate), label: candidate }
      }
      return null
    }
    return null
  }
  return null
}

/** 只要命令的调用方（面板试听 `default` 档、旧测试）用这个；要 label 做日志的用 `systemDefaultTone`。 */
export function systemDefaultSoundCommand(platform: NodeJS.Platform, deps: SoundProbeDeps = {}): string[] | null {
  return systemDefaultTone(platform, deps)?.command ?? null
}
