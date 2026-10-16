# ADR-0002: 通知音播放按平台挑后端，「能不能响」作为数据面交给设置面板

- 状态：Accepted（2026-10-16）
- 关联：issue #74（#64 审计衍生）；PR #100
- 决策人：维护者（#74 定的验收口径：真实出声，或明确「本机不支持」——不许静默、不许假报成功）

## 背景

设置面板三平台都允许给各条通知场景（`shared/settings.ts` 的 `NOTIFICATION_SCENARIOS`，现 15 条）配自定义音效（`custom:<名>`），但播放只有 macOS 一条硬编码路径：`createNotifier()` 的 `playCustom` 兜底是 `if (platform !== 'darwin') return`——Windows/Linux 配完只写一行壳日志就返回；试听（`play_sound` → `previewSound`）又只看 path 合法就 `return true`，于是「静默不播」与「试听假报成功」同时成立，用户既听不到也看不到任何异常。

同类问题在系统默认提示音上也有两处：Linux 拿 `aplay`（只吃 WAV）去播 freedesktop 主题音（`.oga`，Ogg Vorbis）——起了进程、什么都没响；Windows 只播系统事件音别名 `[System.Media.SystemSounds]::Asterisk.Play()`，而该别名走 `PlaySound(SND_ALIAS | SND_NODEFAULT)`：事件音在音效方案里被置为 `(None)` 时静默返回、命令照样退出 0。PR #100 的 Windows 实机复现正是后者——日志写着「试听系统提示音」，耳朵里没有声音。

「这台机器怎么才能出声」在三平台之间没有可移植答案：macOS 的 `afplay` 认 wav/mp3 但不认 Ogg Vorbis；Windows 自带 `System.Media.SoundPlayer`（wav）/ WPF `MediaPlayer`（mp3），两者都不认 ogg；Linux 是一堆可选后端（`aplay` 只吃 WAV，`paplay`/`pw-play` 走 PulseAudio/PipeWire，`mpg123`/`ogg123`/`ffplay` 各管一种容器），装没装全看发行版。

## 决策

1. **新增 `desktop-electrobun/src/bun/sound-playback.ts`，做「本平台哪种格式用哪条命令响」的唯一一层**：`SoundBackend{id, command(path)}` + 每平台每格式的后端表（darwin: afplay / ffplay(ogg)；win32: SoundPlayer(wav) / WPF MediaPlayer(mp3) / ffplay(ogg)；linux: aplay→paplay→pw-play→ffplay(wav)、paplay→pw-play→ffplay→mpg123(mp3)、paplay→pw-play→ffplay→ogg123(ogg)）。`systemDefaultSoundCommand()` 也迁进这一层（Linux 侧只认真能解码 `.oga` 的后端）。
2. **能力探测与播放解耦**：`resolveSoundBackend(platform, ext, probe)` 只回答「能不能、用谁」，`probe`（PATH 扫描 / Windows WPF 装配探测 / 文件存在性）全部可注入，判据不依赖宿主平台——`whichCommand` 自己扫 PATH（Windows 认 `PATHEXT`），拼路径按**注入的** platform（`joinFor`），这样在任一 CI runner 上都能断言三平台语义。
3. **「能不能响」进数据面**：`get_notifications_state` 新增 `capability`（每格式 `ok/backend/reason` + 一句总说明），面板据此禁用没有后端的格式、把原因写进选项文案，并对已配置但本机播不了的档位显示行内告警——不静默降级。
4. **试听必须诚实**：`preview_notification_sound` 的响应新增 `audible`，`previewSound` / `playSystemSound` 真把进程放出去才回 true；没后端一律 false + 一句可诊断日志（缺哪条后端、怎么补）。面板拿到 `audible:false` 时提示失败，不再把「起了进程」当成功。
5. **时长上限两层**：命令构造能带上限的都带（afplay `-t 10`、WPF `Start-Sleep -Seconds 10`）；其余后端由壳侧进程级 watchdog 在 `MAX_SOUND_SECONDS + 1` 秒兜底 kill。该 watchdog 只挂在自定义音的投递路径上；系统默认提示音那条不加（播的是固定短资源，由播放器自己收尾）。
6. **macOS 零回归**：afplay 命令逐字不变，且不改为「靠 PATH 找得到 afplay」才算可用（`/usr/bin/afplay` 系统自带）。ogg 在三平台都如实标注（afplay 不认、Windows 自带播放器不认、Linux 看后端），需要 ffmpeg 才可用。
7. **投递侧也要真的响**：`os-default` 档位在非 darwin 上由壳自己播系统提示音（`systemDefaultTone()` → `spawnSound`）；并且**只有壳真的放得出这一声**（`systemDefaultTone()` 非 `null`）才把传给系统通知的 `silent` 置真——让通道闭嘴，免得哪天它自带音色时与壳放的重成两声。壳放不出来时 `silent` 保持原样：否则「壳不播」会连通道那条本可能出声的路也一起掐掉，变成彻底无声（独立验证 R1）。macOS 仍交给系统通知自带默认音（`shellPlaysDefaultTone('darwin') === false`）。依据是实测：Windows 的投递通道（Electrobun 原生 / PowerShell 气泡）都不保证有声，「通知弹出来了却没声」与 #74 的验收（不许静默）直接冲突。投递侧同时补日志：自定义音放没放出去、系统音放的是哪个文件（`SystemTone.label`），真机日志一眼能对上。

## 后果

- 正面：Windows/Linux 的自定义音与试听从「静默 + 假成功」变为「真出声或明确说不行」；面板不再列出本机播不了的格式；`SoundCapability` 让「本机支持什么」成为可测试、可观测的契约，而不是散落在各平台分支里的隐式假设。
- 代价：多一层探测（PATH 扫描零子进程；Windows 的 WPF 探测会起一次 PowerShell，且只在真播 mp3 时惰性付）；Windows 不装 ffmpeg 就没有 ogg（如实禁用）。
- 风险下限：后端表命中不到时返回 `null` 并带原因，行为是「不响 + 说清楚」，不会退回静默。
- 已知残留：`default` 档位在「没有系统音文件、也没有能解码的播放器」的机器上（Server Core、精简发行版）仍然无声——壳会写一行「本机没有可用播放后端，壳不播也未出声」，但面板目前只为 `custom` 档位标注后端缺失，`default` 档位没有行内提示；此时通知通道的 `silent` 保持原样，通道能响就响（独立验证 R1 的修法）。
- 已知残留（叠声面，待实机确认）：`custom` 档在 Windows/Linux 仍是 `silent: false`——若某台机器的通知通道自带提示音，会与壳放的自定义音叠成两声；最末级兜底 `showWindowsBalloon({ title, body })` 也不吃 `silent`。本机是 macOS，无法确认 Electrobun 的 Windows toast 是否自带音色，故只在真 Windows 冒烟里核对一次。
- 已知边界（独立验证 R4/R5）：`silent` 的判据是「命令构造得出来」，不是「进程真的起来了」——若起播失败（`spawnSound` 返回 false），通知已按静音发出，只剩一行「没能起播」日志；另外系统提示音的解析现在发生在 `show` 之前，探测若抛异常会连通知一起中断（生产路径的探测只做 `existsSync` 与 PATH 扫描，不抛，此面仅在注入缝可达）。
- 回退：revert 单提交即回到「只有 macOS 会响」的旧行为（契约字段 `capability`/`audible` 随提交回滚）。

## 验证边界

本机是 macOS：三平台语义靠注入探针的单测钉住（`test/sound-playback.test.ts`、`test/notifications.test.ts`、`test/notify-policy.test.ts`，另有 `rpc.test.ts` 命令层）；真实 Windows/Linux 的出声验证留维护者实机冒烟。CI 的 Windows 兜底 job 真炸过一次——`whichCommand` 用宿主 `path.join` 拼候选路径，在 Windows 上跑「linux 平台」的探测会拼出反斜杠，故平台相关的路径拼接一律走 `joinFor(platform, …)`，并由「拼路径按注入的平台」用例钉死两种分隔符。

Windows 默认提示音的具体修法：先按候选表（`Windows Notify System Generic.wav` / `Windows Notify.wav` / `notify.wav` / `Windows Ding.wav` / `ding.wav` / `chimes.wav`，取 `%SystemRoot%\Media` 下第一个存在的）用 `SoundPlayer.PlaySync()` 显式播 wav——不依赖注册表事件音、阻塞到播完；连一个候选 wav 都没有（Server Core 之类）才退回事件音别名，PATH 上连 `powershell` 都没有则如实返回「不可用」。
投递侧的行为由 `test/sound-playback.test.ts` 的用例钉住：Windows 的「系统默认音」由壳自己放（并断言 `show` 收到 `silent: true`）、Linux 只认能解码主题音的后端、macOS 一个进程都不起（零回归）、没有后端时只记日志不起进程且**不**把通知静音（断言 `show` 收到 `silent: false`）。
