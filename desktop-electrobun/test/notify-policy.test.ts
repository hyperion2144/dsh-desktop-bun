// 通知（缝 ② 纯逻辑 + 投递层注入）。
//
// 守的是旧壳 `network/notify_policy.rs` 的决策矩阵与 `network/notify.rs` 的投递契约：
//   · 总开关 / 场景开关关 → 整体不投；
//   · 免打扰命中、或全屏静默命中 → 投递但静默（仍进通知中心）；
//   · 声音三档（系统默认 / 静默 / `custom:<文件名>`），文件名与扩展名都过白名单。
// 决策是纯函数，所以这里不需要真时钟、真通知、真音频；投递层用注入的 show/playCustom 断言调用形状。

import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNotifier,
  shellNotificationCommand,
  type ShowNotificationOptions,
} from '../src/bun/notify/notifications.ts'
import {
  decide,
  defaultScenarioConfig,
  hasAllowedSoundExtension,
  inDndWindow,
  isValidSoundName,
  MAX_SOUND_BYTES,
  MAX_SOUND_SECONDS,
  NOTIFY_TYPE_SCENARIOS,
  parseHm,
  SCENARIO,
  scenarioMetaOf,
  SOUND_EXTENSIONS,
  soundChoice,
  soundsDir,
} from '../src/shared/notify/notify-policy.ts'
import { defaultNotifications, type NotificationsConfig } from '../src/shared/settings/settings.ts'

const NOON = { hour: 12, minute: 0 }
const config = (patch: Partial<NotificationsConfig> = {}): NotificationsConfig => ({
  ...defaultNotifications(),
  ...patch,
})

describe('notify-policy：场景表与映射', () => {
  test('场景 id 与设置表一一对应（15 条，无错别字）', () => {
    const ids = Object.values(SCENARIO)
    expect(ids).toHaveLength(15)
    for (const id of ids) {
      const meta = scenarioMetaOf(id)
      expect(meta?.id).toBe(id)
    }
  })

  test('宿主事件桥的三种类型各映射到一个场景', () => {
    expect(NOTIFY_TYPE_SCENARIOS['task-complete']).toBe(SCENARIO.TASK_COMPLETE)
    expect(NOTIFY_TYPE_SCENARIOS['dsh-approval']).toBe(SCENARIO.DSH_APPROVAL)
    expect(NOTIFY_TYPE_SCENARIOS['dsh-error']).toBe(SCENARIO.DSH_ERROR)
  })

  test('未知场景回退「开 + 系统默认音」（旧壳口径）', () => {
    expect(defaultScenarioConfig('nope.nope')).toEqual({ enabled: true, sound: 'default' })
    expect(defaultScenarioConfig(SCENARIO.STARTUP_ERROR).enabled).toBe(true)
  })
})

describe('notify-policy：免打扰窗', () => {
  test('parseHm：合法/非法', () => {
    expect(parseHm('22:00')).toEqual({ hour: 22, minute: 0 })
    expect(parseHm(' 08:05 ')).toEqual({ hour: 8, minute: 5 })
    expect(parseHm('24:00')).toBeNull()
    expect(parseHm('12:60')).toBeNull()
    expect(parseHm('1200')).toBeNull()
    expect(parseHm('aa:bb')).toBeNull()
    expect(parseHm('')).toBeNull()
  })

  test('同日窗 [09:00, 17:00)', () => {
    expect(inDndWindow({ hour: 8, minute: 59 }, '09:00', '17:00')).toBe(false)
    expect(inDndWindow({ hour: 9, minute: 0 }, '09:00', '17:00')).toBe(true)
    expect(inDndWindow({ hour: 16, minute: 59 }, '09:00', '17:00')).toBe(true)
    expect(inDndWindow({ hour: 17, minute: 0 }, '09:00', '17:00')).toBe(false)
  })

  test('跨午夜窗 [22:00, 08:00)', () => {
    expect(inDndWindow({ hour: 23, minute: 30 }, '22:00', '08:00')).toBe(true)
    expect(inDndWindow({ hour: 3, minute: 0 }, '22:00', '08:00')).toBe(true)
    expect(inDndWindow({ hour: 7, minute: 59 }, '22:00', '08:00')).toBe(true)
    expect(inDndWindow({ hour: 8, minute: 0 }, '22:00', '08:00')).toBe(false)
    expect(inDndWindow({ hour: 12, minute: 0 }, '22:00', '08:00')).toBe(false)
  })

  test('零长度窗（from === to）视为未配置', () => {
    expect(inDndWindow(NOON, '09:00', '09:00')).toBe(false)
  })

  test('时刻非法时不命中', () => {
    expect(inDndWindow(NOON, 'bad', '17:00')).toBe(false)
  })
})

describe('notify-policy：声音档位', () => {
  test('三档解析', () => {
    expect(soundChoice('default')).toEqual({ kind: 'os-default' })
    expect(soundChoice('none')).toEqual({ kind: 'silent' })
    expect(soundChoice('custom:叮.wav')).toEqual({ kind: 'custom', name: '叮.wav' })
    expect(soundChoice('custom:')).toEqual({ kind: 'silent' })
    expect(soundChoice('随便别的值')).toEqual({ kind: 'os-default' })
  })

  test('文件名白名单：允许中日韩/点/下划线/连字符/空格/括号，禁穿越与分隔符', () => {
    expect(isValidSoundName('叮咚.wav')).toBe(true)
    expect(isValidSoundName('my_sound-2 (1).mp3')).toBe(true)
    expect(isValidSoundName('')).toBe(false)
    expect(isValidSoundName('../secret.wav')).toBe(false)
    expect(isValidSoundName('a/b.wav')).toBe(false)
    expect(isValidSoundName('a\\b.wav')).toBe(false)
    expect(isValidSoundName('a'.repeat(256))).toBe(false)
  })

  test('扩展名白名单：wav/mp3/ogg（大小写不敏感），aac/m4a 不进', () => {
    expect([...SOUND_EXTENSIONS]).toEqual(['wav', 'mp3', 'ogg'])
    expect(hasAllowedSoundExtension('a.WAV')).toBe(true)
    expect(hasAllowedSoundExtension('a.ogg')).toBe(true)
    expect(hasAllowedSoundExtension('a.aac')).toBe(false)
    expect(hasAllowedSoundExtension('a.m4a')).toBe(false)
    expect(hasAllowedSoundExtension('noext')).toBe(false)
    expect(hasAllowedSoundExtension('.wav')).toBe(false)
  })

  test('音效目录与上限常量', () => {
    // 期望值走 join：Windows 上 soundsDir 返回反斜杠路径
    expect(soundsDir('/tmp/home')).toBe(join('/tmp/home', 'sounds'))
    expect(MAX_SOUND_BYTES).toBe(5 * 1024 * 1024)
    expect(MAX_SOUND_SECONDS).toBe(10)
  })
})

describe('notify-policy：投递决策矩阵', () => {
  test('总开关关 → 不投递（场景再开也不投）', () => {
    const decision = decide(config({ enabled: false }), SCENARIO.TASK_COMPLETE, NOON, false, false)
    expect(decision).toEqual({ deliver: false, silent: false, sound: { kind: 'silent' } })
  })

  test('场景关 → 不投递', () => {
    const cfg = config()
    cfg.scenarios[SCENARIO.TASK_COMPLETE] = { enabled: false, sound: 'default' }
    expect(decide(cfg, SCENARIO.TASK_COMPLETE, NOON, false, false).deliver).toBe(false)
    expect(decide(cfg, SCENARIO.DSH_APPROVAL, NOON, false, false).deliver).toBe(true)
  })

  test('默认全开、不静默、走系统默认音', () => {
    expect(decide(config(), SCENARIO.TASK_COMPLETE, NOON, false, false)).toEqual({
      deliver: true,
      silent: false,
      sound: { kind: 'os-default' },
    })
  })

  test('免打扰命中 → 投递但静默', () => {
    const cfg = config({ dnd: { on: true, from: '22:00', to: '08:00', suppressFullscreen: false } })
    expect(decide(cfg, SCENARIO.TASK_COMPLETE, { hour: 23, minute: 0 }, false, false).silent).toBe(true)
    expect(decide(cfg, SCENARIO.TASK_COMPLETE, NOON, false, false).silent).toBe(false)
  })

  test('免打扰关掉时窗内也照常响', () => {
    const cfg = config({ dnd: { on: false, from: '22:00', to: '08:00', suppressFullscreen: false } })
    expect(decide(cfg, SCENARIO.TASK_COMPLETE, { hour: 23, minute: 0 }, false, false).silent).toBe(false)
  })

  test('全屏静默（免打扰没开也生效）', () => {
    const cfg = config({ dnd: { on: false, from: '22:00', to: '08:00', suppressFullscreen: true } })
    expect(decide(cfg, SCENARIO.TASK_COMPLETE, NOON, true, false).silent).toBe(true)
    expect(decide(cfg, SCENARIO.TASK_COMPLETE, NOON, false, false).silent).toBe(false)
  })

  test('窗口在前台聚焦 → 不投递（UI 就在眼前，通知中心里也不该有）', () => {
    const decision = decide(config(), SCENARIO.TASK_COMPLETE, NOON, false, true)
    expect(decision).toEqual({ deliver: false, silent: false, sound: { kind: 'silent' } })
  })

  test('聚焦压过免打扰：不是「静默投递」而是整条不投', () => {
    const cfg = config({ dnd: { on: true, from: '22:00', to: '08:00', suppressFullscreen: false } })
    const decision = decide(cfg, SCENARIO.TASK_COMPLETE, NOON, false, true)
    expect(decision.deliver).toBe(false)
    expect(decision.silent).toBe(false)
  })

  test('故障类场景也一视同仁（聚焦时不投）', () => {
    expect(decide(config(), SCENARIO.STARTUP_ERROR, NOON, false, true).deliver).toBe(false)
    expect(decide(config(), SCENARIO.STARTUP_ERROR, NOON, false, false).deliver).toBe(true)
  })

  test('静默命中时把自定义音也压成 silent（不当场响）', () => {
    const cfg = config({ dnd: { on: true, from: '09:00', to: '17:00', suppressFullscreen: true } })
    cfg.scenarios[SCENARIO.TASK_COMPLETE] = { enabled: true, sound: 'custom:叮.wav' }
    const decision = decide(cfg, SCENARIO.TASK_COMPLETE, NOON, false, false)
    expect(decision.deliver).toBe(true)
    expect(decision.silent).toBe(true)
    expect(decision.sound).toEqual({ kind: 'silent' })
  })

  test('场景自定义音照常带出来', () => {
    const cfg = config()
    cfg.scenarios[SCENARIO.DOWNLOAD_COMPLETE] = { enabled: true, sound: 'custom:done.mp3' }
    expect(decide(cfg, SCENARIO.DOWNLOAD_COMPLETE, NOON, false, false).sound).toEqual({
      kind: 'custom',
      name: 'done.mp3',
    })
  })
})

describe('notifications：投递层', () => {
  test('命令行兜底：macOS 走 osascript 并转义引号', () => {
    expect(shellNotificationCommand('darwin', 'a"b', 'c\\d')).toEqual([
      'osascript',
      '-e',
      'display notification "c\\\\d" with title "a\\"b"',
    ])
    expect(shellNotificationCommand('linux', '标题', '正文')).toEqual(['notify-send', '标题', '正文'])
    expect(shellNotificationCommand('win32', '标题', '正文')).toBeNull()
  })

  test('总开关关：不投递、不响', () => {
    const shown: ShowNotificationOptions[] = []
    const notifier = createNotifier({
      notifications: config({ enabled: false }),
      home: '/tmp/none',
      show: (options) => shown.push(options),
    })
    const decision = notifier.notify(SCENARIO.TASK_COMPLETE, '做完了')
    expect(decision.deliver).toBe(false)
    expect(shown).toEqual([])
  })

  test('正常投递：标题用应用名、silent 跟随决策', () => {
    const shown: ShowNotificationOptions[] = []
    const notifier = createNotifier({
      notifications: config(),
      home: '/tmp/none',
      appName: 'DSH',
      // 平台必须显式给：投递「系统默认音」在非 darwin 上由壳自己放、silent 会额外置真
      // （见 sound-playback.test.ts），这里要钉的是「silent 跟随决策」，不能吃宿主默认值。
      platform: 'darwin',
      show: (options) => shown.push(options),
    })
    notifier.notify(SCENARIO.TASK_COMPLETE, '会话跑完了')
    expect(shown).toEqual([{ title: 'DSH', body: '会话跑完了', silent: false }])

    notifier.notify(SCENARIO.TASK_COMPLETE, '会话跑完了', '自定义标题')
    expect(shown[1]?.title).toBe('自定义标题')
  })

  test('窗口在前台聚焦 → 整条不投（连通知中心都不进）', () => {
    const shown: ShowNotificationOptions[] = []
    const lines: string[] = []
    let focused = true
    const notifier = createNotifier({
      notifications: config(),
      home: '/tmp/none',
      show: (options) => shown.push(options),
      isFocused: () => focused,
      // 只验聚焦逻辑：回包的 silent 随平台（Win/Linux 的「系统默认音」由壳自己放 → 原生通知要闭嘴，见 #74），
      // 这里钉死 darwin 让回包确定；平台差异由 notifications.test.ts 的音档用例覆盖。
      platform: 'darwin',
      onLog: (line) => lines.push(line),
    })
    const blocked = notifier.notify(SCENARIO.TASK_COMPLETE, '会话跑完了')
    expect(blocked).toEqual({ deliver: false, silent: false, sound: { kind: 'silent' } })
    expect(shown).toEqual([])
    expect(lines.some((line) => line.includes('未投递（窗口在前台聚焦）'))).toBe(true)
    // 失焦（切到别的应用）→ 立刻恢复投递；少打扰只限窗口在眼前时
    focused = false
    expect(notifier.notify(SCENARIO.TASK_COMPLETE, '会话跑完了').deliver).toBe(true)
    expect(shown).toEqual([{ title: 'DSH', body: '会话跑完了', silent: false }])
  })

  test('聚焦但总开关关着：日志说总开关，不把锅甩给焦点', () => {
    const lines: string[] = []
    const notifier = createNotifier({
      notifications: config({ enabled: false }),
      home: '/tmp/none',
      show: () => {},
      isFocused: () => true,
      onLog: (line) => lines.push(line),
    })
    notifier.notify(SCENARIO.TASK_COMPLETE, '会话跑完了')
    expect(lines.some((line) => line.includes('未投递（总开关或场景关闭）'))).toBe(true)
    expect(lines.some((line) => line.includes('窗口在前台聚焦'))).toBe(false)
  })

  test('聚焦但场景关着：日志同样说开关', () => {
    const lines: string[] = []
    const cfg = config()
    cfg.scenarios[SCENARIO.TASK_COMPLETE] = { enabled: false, sound: 'default' }
    const notifier = createNotifier({
      notifications: cfg,
      home: '/tmp/none',
      show: () => {},
      isFocused: () => true,
      onLog: (line) => lines.push(line),
    })
    notifier.notify(SCENARIO.TASK_COMPLETE, '会话跑完了')
    expect(lines.some((line) => line.includes('未投递（总开关或场景关闭）'))).toBe(true)
  })

  test('面板预览（decide）在聚焦时也如实回「不会投」', () => {
    const notifier = createNotifier({
      notifications: config(),
      home: '/tmp/none',
      isFocused: () => true,
      show: () => {},
    })
    expect(notifier.decide(SCENARIO.TASK_COMPLETE)).toEqual({
      deliver: false,
      silent: false,
      sound: { kind: 'silent' },
    })
  })

  test('静默决策传 silent=true 给原生层', () => {
    const shown: ShowNotificationOptions[] = []
    const notifier = createNotifier({
      notifications: config({ dnd: { on: true, from: '00:00', to: '23:59', suppressFullscreen: false } }),
      home: '/tmp/none',
      now: () => new Date(2026, 0, 1, 12, 0, 0),
      show: (options) => shown.push(options),
    })
    notifier.notify(SCENARIO.TASK_COMPLETE, '静默的')
    expect(shown[0]?.silent).toBe(true)
  })

  test('自定义音：白名单外不响（名字非法 / 扩展名不在表 / 文件不存在 / 超 5MB）', () => {
    const home = join(tmpdir(), `dsh-notify-${String(process.pid)}`)
    const dir = soundsDir(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ok.wav'), 'x')
    writeFileSync(join(dir, 'big.mp3'), Buffer.alloc(MAX_SOUND_BYTES + 1))
    writeFileSync(join(dir, 'bad.aac'), 'x')

    const played: string[] = []
    const logs: string[] = []
    const notifier = createNotifier({
      notifications: config(),
      home,
      playCustom: (path) => {
        played.push(path)
        return true
      },
      onLog: (line) => logs.push(line),
    })

    expect(notifier.soundPath('ok.wav')).toBe(join(dir, 'ok.wav'))
    expect(notifier.soundPath('../ok.wav')).toBeNull()
    expect(notifier.soundPath('bad.aac')).toBeNull()
    expect(notifier.soundPath('missing.wav')).toBeNull()
    expect(notifier.soundPath('big.mp3')).toBeNull()
    expect(logs.some((line) => line.includes('不存在'))).toBe(true)

    const cfg = config()
    cfg.scenarios[SCENARIO.TASK_COMPLETE] = { enabled: true, sound: 'custom:ok.wav' }
    const withSound = createNotifier({
      notifications: cfg,
      home,
      playCustom: (path) => {
        played.push(path)
        return true
      },
    })
    const decision = withSound.notify(SCENARIO.TASK_COMPLETE, '带响的')
    expect(decision.sound).toEqual({ kind: 'custom', name: 'ok.wav' })
    expect(played).toEqual([join(dir, 'ok.wav')])

    rmSync(home, { recursive: true, force: true })
  })

  test('decide() 只算不投（设置面板预览）', () => {
    const shown: ShowNotificationOptions[] = []
    const notifier = createNotifier({
      notifications: config(),
      home: '/tmp/none',
      isFullscreen: () => true,
      show: (options) => shown.push(options),
    })
    // 全屏静默默认开：预览拿到的是静默决策，但没有任何投递
    expect(notifier.decide(SCENARIO.TASK_COMPLETE).silent).toBe(true)
    expect(shown).toEqual([])
  })
})
