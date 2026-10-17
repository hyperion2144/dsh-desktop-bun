// #74：三平台「真的响」层（`src/bun/sound-playback.ts`）与通知投递侧的播放行为。
//
// 守的是什么：旧实现 `createNotifier()` 里一句 `if (platform !== 'darwin') return`——Win/Linux
// 配了自定义音**静默不播**，试听还 `return true` 假报成功。这里把三平台的后端选择、能力报告
// 与「没后端就如实说」钉死；macOS 的 `afplay -t 10` 口径零回归。
//
// 注入缝都在 `SoundProbeDeps` / `SoundProbe`：单测不依赖本机真装了 pw-play / ffplay / powershell。

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNotifier } from '../src/bun/notifications.ts'
import {
  createSoundProbe,
  resolveSoundBackend,
  shellPlaysDefaultTone,
  soundCapabilityOf,
  systemDefaultSoundCommand,
  systemDefaultTone,
  whichCommand,
  type SoundProbe,
  type SoundProbeDeps,
} from '../src/bun/sound-playback.ts'
import { MAX_SOUND_SECONDS, SCENARIO } from '../src/shared/notify-policy.ts'
import { defaultSettings, type NotificationsConfig } from '../src/shared/settings.ts'

const WAV = '/tmp/tone.wav'
const MP3 = '/tmp/tone.mp3'
const OGG = '/tmp/tone.ogg'

/** 假的 PATH：只认列出来的可执行文件。 */
function probeWith(commands: ReadonlyArray<string>, extra: SoundProbeDeps = {}): SoundProbe {
  return createSoundProbe(
    {
      hasCommand: (name) => commands.includes(name),
      hasWpf: false,
      runCommand: () => false,
      env: {},
      exists: () => false,
      ...extra,
    },
    'linux',
  )
}

describe('#74 后端选择：三平台（resolveSoundBackend）', () => {
  test('macOS：wav/mp3 走 afplay（-t 10 口径不变），ogg 只有 ffplay 才认', () => {
    const bare = probeWith([])
    expect(resolveSoundBackend('darwin', 'wav', bare)?.id).toBe('afplay')
    expect(resolveSoundBackend('darwin', 'wav', bare)?.command(WAV)).toEqual([
      'afplay',
      '-t',
      String(MAX_SOUND_SECONDS),
      WAV,
    ])
    expect(resolveSoundBackend('darwin', 'mp3', bare)?.command(MP3)).toEqual([
      'afplay',
      '-t',
      String(MAX_SOUND_SECONDS),
      MP3,
    ])
    // afplay 不认 Ogg Vorbis：没有 ffmpeg 就如实说没有后端
    expect(resolveSoundBackend('darwin', 'ogg', bare)).toBeNull()
    expect(resolveSoundBackend('darwin', 'ogg', probeWith(['ffplay']))?.id).toBe('ffplay')
  })

  test('Windows：wav 走 SoundPlayer、mp3 走 WPF、ogg 只有 ffmpeg 能救', () => {
    expect(resolveSoundBackend('win32', 'wav', probeWith([]))).toBeNull() // 没有 powershell

    const ps = probeWith(['powershell'])
    const wav = resolveSoundBackend('win32', 'wav', ps)
    expect(wav?.id).toBe('powershell-soundplayer')
    const command = wav?.command("C:\\Users\\me\\a'b.wav") ?? []
    expect(command[0]).toBe('powershell')
    expect(command).toContain('-NoProfile')
    expect(command.join(' ')).toContain('System.Media.SoundPlayer')
    expect(command.join(' ')).toContain('PlaySync')
    expect(command.join(' ')).toContain("a''b.wav") // 单引号双写转义（路径可能带引号）

    // mp3：System.Media 不认，要有 PresentationCore（WPF）
    expect(resolveSoundBackend('win32', 'mp3', ps)).toBeNull()
    const wpf = probeWith(['powershell'], { hasWpf: true })
    expect(resolveSoundBackend('win32', 'mp3', wpf)?.id).toBe('powershell-wpf')
    expect(resolveSoundBackend('win32', 'mp3', wpf)?.command(MP3).join(' ')).toContain(
      `Start-Sleep -Seconds ${String(MAX_SOUND_SECONDS)}`,
    )

    // ogg：两个系统播放器都不认
    expect(resolveSoundBackend('win32', 'ogg', wpf)).toBeNull()
    expect(resolveSoundBackend('win32', 'ogg', probeWith(['powershell', 'ffplay']))?.id).toBe('ffplay')
  })

  test('Linux：按格式挑真能解码的后端；全无则 null（不许起个进程当响过）', () => {
    expect(resolveSoundBackend('linux', 'wav', probeWith(['aplay']))?.id).toBe('aplay')
    // aplay 只吃 WAV：拿它播 mp3/ogg 就是「起了进程、什么都没响」
    expect(resolveSoundBackend('linux', 'mp3', probeWith(['aplay']))).toBeNull()
    expect(resolveSoundBackend('linux', 'ogg', probeWith(['aplay']))).toBeNull()

    expect(resolveSoundBackend('linux', 'mp3', probeWith(['aplay', 'paplay']))?.id).toBe('paplay')
    expect(resolveSoundBackend('linux', 'ogg', probeWith(['ffplay', 'pw-play']))?.id).toBe('pw-play')
    expect(resolveSoundBackend('linux', 'wav', probeWith(['aplay', 'pw-play']))?.id).toBe('aplay')
    expect(resolveSoundBackend('linux', 'mp3', probeWith([]))).toBeNull()
  })

  test('未知平台：没有后端（也不假报）', () => {
    expect(resolveSoundBackend('freebsd', 'wav', probeWith(['aplay', 'afplay']))).toBeNull()
  })
})

describe('#74 能力报告（面板据此禁用格式并说明）', () => {
  test('有缺项时逐条给结论 + 一句总说明', () => {
    const capability = soundCapabilityOf('linux', probeWith(['aplay']))
    expect(capability.platform).toBe('linux')
    expect(capability.formats.wav).toEqual({ ok: true, backend: 'aplay', reason: null })
    expect(capability.formats.mp3.ok).toBe(false)
    expect(capability.formats.mp3.backend).toBeNull()
    expect(capability.formats.mp3.reason).toContain('paplay')
    expect(capability.hint).toContain('.mp3')
    expect(capability.hint).toContain('.ogg')
  })

  test('三种都能播就没有总说明', () => {
    const capability = soundCapabilityOf('linux', probeWith(['aplay', 'paplay']))
    expect(capability.formats.ogg.ok).toBe(true)
    expect(capability.hint).toBeNull()
  })
})

describe('whichCommand：自己扫 PATH（不起 which 子进程）', () => {
  test('Windows 认 PATHEXT，PATH 项带引号也认', () => {
    const env = { PATH: '"C:\\Program Files\\Git\\bin";C:\\Windows\\System32', PATHEXT: '.EXE;.CMD' }
    const exists = (path: string): boolean =>
      path === 'C:\\Program Files\\Git\\bin\\ffplay.exe' ||
      path === 'C:\\Windows\\System32\\powershell.exe'
    expect(whichCommand('ffplay', { env, platform: 'win32', exists })).toBe(true)
    expect(whichCommand('powershell', { env, platform: 'win32', exists })).toBe(true)
    expect(whichCommand('aplay', { env, platform: 'win32', exists })).toBe(false)
  })

  test('Linux 冒号分隔；PATH 空就是没有', () => {
    const env = { PATH: '/usr/local/bin:/usr/bin' }
    expect(whichCommand('paplay', { env, platform: 'linux', exists: (path) => path === '/usr/bin/paplay' })).toBe(true)
    expect(whichCommand('paplay', { env, platform: 'linux', exists: () => false })).toBe(false)
    expect(whichCommand('paplay', { env: { PATH: '' }, platform: 'linux', exists: () => true })).toBe(false)
  })

  test('拼路径按注入的平台，不受宿主分隔符影响', () => {
    const seen: string[] = []
    const record = (path: string): boolean => {
      seen.push(path)
      return false
    }
    whichCommand('paplay', { env: { PATH: '/usr/bin/' }, platform: 'linux', exists: record })
    expect(seen).toEqual(['/usr/bin/paplay'])
    seen.length = 0
    whichCommand('ffplay', { env: { PATH: 'C:\\Tools', PATHEXT: '.EXE' }, platform: 'win32', exists: record })
    // PATHEXT 条目统一小写（Windows 查找大小写不敏感），这里把「按平台拼、按 PATHEXT 补后缀」钉死
    expect(seen).toEqual(['C:\\Tools\\ffplay', 'C:\\Tools\\ffplay.exe'])
  })
})

describe('系统默认提示音（试听 default 档）', () => {
  test('macOS / Windows：系统自带，不依赖外部播放器', () => {
    expect(systemDefaultSoundCommand('darwin')).toEqual([
      'afplay',
      '-t',
      String(MAX_SOUND_SECONDS),
      '/System/Library/Sounds/Ping.aiff',
    ])
    // Windows：显式播系统自带 wav（PlaySync 阻塞到播完），不再只播可能被音效方案静默的事件音别名
    const wav = 'C:\\Windows\\Media\\Windows Notify System Generic.wav'
    const win = systemDefaultSoundCommand('win32', {
      env: {
        SystemRoot: 'C:\\Windows',
        PATH: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
        PATHEXT: '.EXE',
      },
      exists: (path) => path === wav || path.endsWith('powershell.exe'),
    })
    expect(win?.[0]).toBe('powershell')
    expect(win?.join(' ')).toContain('System.Media.SoundPlayer')
    expect(win?.join(' ')).toContain(wav)
  })

  test('Windows：一个候选 wav 都没有才退回事件音别名（只是兜底，不保证有声）', () => {
    const win = systemDefaultSoundCommand('win32', {
      env: { PATH: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0', PATHEXT: '.EXE' },
      exists: (path) => path.endsWith('powershell.exe'),
    })
    expect(win?.join(' ')).toContain('SystemSounds')
  })

  test('Windows：PATH 上没有 powershell ⇒ 如实回 null（调用方回「不响」）', () => {
    expect(systemDefaultSoundCommand('win32', { env: { PATH: '' }, exists: () => true })).toBeNull()
  })

  test('Linux：主题音是 Ogg Vorbis——只有真能解码的后端才算（aplay 不算）', () => {
    const theme = '/usr/share/sounds/freedesktop/stereo/complete.oga'
    const withTheme: SoundProbeDeps = { exists: (path) => path === theme }
    expect(systemDefaultSoundCommand('linux', { ...withTheme, hasCommand: (name) => name === 'paplay' })).toEqual([
      'paplay',
      theme,
    ])
    // aplay 起了进程也不会响 ⇒ 如实回 null
    expect(systemDefaultSoundCommand('linux', { ...withTheme, hasCommand: (name) => name === 'aplay' })).toBeNull()
    // 没有主题音文件 ⇒ null
    expect(systemDefaultSoundCommand('linux', { exists: () => false, hasCommand: () => true })).toBeNull()
  })

  test('未知平台：null', () => {
    expect(systemDefaultSoundCommand('freebsd')).toBeNull()
  })

  test('label 指向真要响的文件（真机日志靠它核对）；谁负责放按平台分工', () => {
    expect(shellPlaysDefaultTone('darwin')).toBe(false) // 系统通知自带默认音，壳再放就是叠声
    expect(shellPlaysDefaultTone('win32')).toBe(true) // 通道不带音频，壳自己放
    expect(shellPlaysDefaultTone('linux')).toBe(true)
    expect(shellPlaysDefaultTone('freebsd')).toBe(true)

    const win = systemDefaultTone('win32', {
      hasCommand: (name) => name === 'powershell',
      exists: (path) => path.endsWith('Windows Notify System Generic.wav'),
    })
    expect(win?.label.endsWith('Windows Notify System Generic.wav')).toBe(true)
    expect(win?.label).toContain('Media')

    const theme = '/usr/share/sounds/freedesktop/stereo/complete.oga'
    expect(
      systemDefaultTone('linux', { exists: (path) => path === theme, hasCommand: (name) => name === 'paplay' })
        ?.label,
    ).toBe(theme)

    expect(systemDefaultTone('win32', { hasCommand: () => false })).toBeNull()
  })
})

// ── 投递侧：Win/Linux 真的出声 ─────────────────────────────────────────────────

/** 只写到「魔数够用」的长度：`soundPath` 只查文件头（旧壳 sounds::ALLOWED 口径）。 */
function toneBytes(kind: 'wav' | 'mp3' | 'ogg'): Buffer {
  if (kind === 'wav') return Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
  if (kind === 'mp3') return Buffer.from([0x49, 0x44, 0x33, 0, 0, 0, 0, 0, 0, 0])
  return Buffer.from([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0])
}

/** 造一个 `$DSH_HOME`，里面 `sounds/` 放好听的名字。 */
function homeWithTones(kinds: ReadonlyArray<'wav' | 'mp3' | 'ogg'>): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-sound-'))
  const dir = join(home, 'sounds')
  mkdirSync(dir, { recursive: true })
  for (const kind of kinds) writeFileSync(join(dir, `tone.${kind}`), toneBytes(kind))
  return home
}

/** 让 `task.complete` 播指定档位。 */
function configWith(sound: string): NotificationsConfig {
  const notifications = defaultSettings().notifications
  notifications.scenarios[SCENARIO.TASK_COMPLETE] = { enabled: true, sound }
  return notifications
}

describe('#74 通知投递：Win/Linux 真的出声（不再静默、不再假成功）', () => {
  test('Windows：wav → PowerShell SoundPlayer 真的起了进程；试听同样出声', () => {
    const home = homeWithTones(['wav'])
    const spawned: string[][] = []
    try {
      const notifier = createNotifier({
        notifications: configWith('custom:tone.wav'),
        home,
        platform: 'win32',
        soundProbe: { hasCommand: (name) => name === 'powershell', hasWpf: false },
        spawnSound: (command) => {
          spawned.push(command)
          return true
        },
      })
      expect(notifier.notify(SCENARIO.TASK_COMPLETE, '完事').sound).toEqual({ kind: 'custom', name: 'tone.wav' })
      expect(spawned).toHaveLength(1)
      expect(spawned[0]?.[0]).toBe('powershell')
      expect(spawned[0]?.join(' ')).toContain('System.Media.SoundPlayer')
      expect(notifier.previewSound('tone.wav')).toBe(true)
      expect(spawned).toHaveLength(2)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('Linux：只有 aplay 时 wav 出声，mp3 如实回 false + 可诊断日志', () => {
    const home = homeWithTones(['wav', 'mp3'])
    const spawned: string[][] = []
    const logs: string[] = []
    try {
      const notifier = createNotifier({
        notifications: configWith('custom:tone.wav'),
        home,
        platform: 'linux',
        soundProbe: { hasCommand: (name) => name === 'aplay' },
        spawnSound: (command) => {
          spawned.push(command)
          return true
        },
        onLog: (line) => logs.push(line),
      })
      expect(notifier.previewSound('tone.wav')).toBe(true)
      expect(spawned[0]).toEqual(['aplay', '-q', join(home, 'sounds', 'tone.wav')])

      // 旧实现在这里静默 + 假报成功
      expect(notifier.previewSound('tone.mp3')).toBe(false)
      expect(spawned).toHaveLength(1)
      expect(logs.some((line) => line.includes('没有可用播放后端'))).toBe(true)

      const capability = notifier.soundCapability()
      expect(capability.formats.wav.ok).toBe(true)
      expect(capability.formats.mp3.ok).toBe(false)
      expect(capability.formats.mp3.reason).toContain('paplay')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('macOS 零回归：afplay 命令逐字不变，且不靠 PATH 找得到 afplay', () => {
    const home = homeWithTones(['wav'])
    const spawned: string[][] = []
    try {
      const notifier = createNotifier({
        notifications: configWith('custom:tone.wav'),
        home,
        platform: 'darwin',
        soundProbe: { hasCommand: () => false }, // PATH 里什么都没有
        spawnSound: (command) => {
          spawned.push(command)
          return true
        },
      })
      expect(notifier.previewSound('tone.wav')).toBe(true)
      expect(spawned[0]).toEqual(['afplay', '-t', String(MAX_SOUND_SECONDS), join(home, 'sounds', 'tone.wav')])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('整层注入（测试缝）时也不假成功：注入说没出声就回 false', () => {
    const home = homeWithTones(['wav'])
    try {
      const notifier = createNotifier({
        notifications: configWith('custom:tone.wav'),
        home,
        platform: 'win32',
        playCustom: () => false,
      })
      expect(notifier.previewSound('tone.wav')).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('投递「系统默认音」：Windows 壳自己放系统 wav，并让通知通道按 silent 闭嘴（不叠声）', () => {
    const home = homeWithTones([])
    const spawned: string[][] = []
    const shown: boolean[] = []
    try {
      const notifier = createNotifier({
        notifications: configWith('default'),
        home,
        platform: 'win32',
        soundProbe: {
          hasCommand: (name) => name === 'powershell',
          exists: (path) => path.endsWith('Windows Notify System Generic.wav'),
        },
        show: (options) => {
          shown.push(options.silent)
        },
        spawnSound: (command) => {
          spawned.push(command)
          return true
        },
      })
      expect(notifier.notify(SCENARIO.TASK_COMPLETE, '完事').sound).toEqual({ kind: 'os-default' })
      expect(spawned).toHaveLength(1)
      expect(spawned[0]?.[0]).toBe('powershell')
      expect(spawned[0]?.join(' ')).toContain('System.Media.SoundPlayer')
      expect(spawned[0]?.join(' ')).toContain('Windows Notify System Generic.wav')
      expect(shown).toEqual([true])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('投递「系统默认音」：Linux 只认能解码主题音的后端；macOS 交给系统通知（零回归）', () => {
    const theme = '/usr/share/sounds/freedesktop/stereo/complete.oga'
    const home = homeWithTones([])
    const spawned: string[][] = []
    const shown: boolean[] = []
    try {
      const linux = createNotifier({
        notifications: configWith('default'),
        home,
        platform: 'linux',
        soundProbe: { exists: (path) => path === theme, hasCommand: (name) => name === 'paplay' },
        show: (options) => {
          shown.push(options.silent)
        },
        spawnSound: (command) => {
          spawned.push(command)
          return true
        },
      })
      linux.notify(SCENARIO.TASK_COMPLETE, '完事')
      expect(spawned).toEqual([['paplay', theme]])

      const mac = createNotifier({
        notifications: configWith('default'),
        home,
        platform: 'darwin',
        soundProbe: { hasCommand: () => false }, // PATH 里什么都没有也不影响：macOS 不靠外部命令
        show: (options) => {
          shown.push(options.silent)
        },
        spawnSound: (command) => {
          spawned.push(command)
          return true
        },
      })
      mac.notify(SCENARIO.TASK_COMPLETE, '完事')
      expect(spawned).toHaveLength(1) // 只有 Linux 那次；macOS 一个进程都不起
      expect(shown).toEqual([true, false]) // macOS 让系统通知自己响，不叠声
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('投递没出声不再静默：自定义音与系统音都给出日志原因', () => {
    const home = homeWithTones(['wav'])
    const logs: string[] = []
    const spawned: string[][] = []
    const notifier = (playCustom: () => boolean): ReturnType<typeof createNotifier> =>
      createNotifier({
        notifications: configWith('custom:tone.wav'),
        home,
        platform: 'win32',
        playCustom,
        spawnSound: (command) => {
          spawned.push(command)
          return true
        },
        onLog: (line) => logs.push(line),
      })
    try {
      notifier(() => true).notify(SCENARIO.TASK_COMPLETE, '完事')
      expect(logs.some((line) => line.includes('播放自定义音：tone.wav'))).toBe(true)
      logs.length = 0
      notifier(() => false).notify(SCENARIO.TASK_COMPLETE, '完事')
      expect(logs.some((line) => line.includes('自定义音未出声'))).toBe(true)
      expect(spawned).toHaveLength(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('Windows 上连 powershell 都没有：如实记日志、不起进程（不假报成功）', () => {
    const home = homeWithTones([])
    const logs: string[] = []
    const shown: boolean[] = []
    const spawned: string[][] = []
    try {
      const notifier = createNotifier({
        notifications: configWith('default'),
        home,
        platform: 'win32',
        soundProbe: { hasCommand: () => false },
        spawnSound: (command) => {
          spawned.push(command)
          return true
        },
        onLog: (line) => logs.push(line),
        show: (options) => {
          shown.push(options.silent)
        },
      })
      notifier.notify(SCENARIO.TASK_COMPLETE, '完事')
      expect(spawned).toHaveLength(0)
      // 壳放不出这一声时不许替通道做决定：静音一条本就没声的通知 = 彻底无声（独立验证 R1）
      expect(shown).toEqual([false])
      expect(logs.some((line) => line.includes('系统默认提示音') && line.includes('未出声'))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
