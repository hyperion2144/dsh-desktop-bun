# ADR-0002: Linux 防休眠走 logind/GNOME inhibit 的「持有进程 + 看门狗」

- 状态：Accepted（2026-10-16）
- 关联：issue #75（平台完整性审计 #64 缺口②）；旧壳 `desktop/src-tauri/src/power/mod.rs`（只覆盖 macOS/Windows）
- 决策人：维护者（#75 票面给出的方向：首选 D-Bus inhibit，或用 `systemd-inhibit` 包裹子进程、仿 darwin `caffeinate -w` 的自动释放语义）；实现形态由实施者细化并落此 ADR

## 背景

壳的防休眠断言在 `desktop-electrobun/src/bun/keep-awake.ts`：darwin 走 `caffeinate -i -w <壳 pid>`，win32 走 `SetThreadExecutionState`（bun:ffi）；**linux 只落一行日志**，于是开启「有会话在跑时阻止系统休眠」后，Linux 上跑会话期间系统照样空闲休眠，且用户没有任何可见反馈（#64 审计缺口②）。

Linux 上等价能力有三条路：

1. `org.freedesktop.ScreenSaver.Inhibit`（GNOME/KDE 会话级抑制，返回 cookie，`UnInhibit` 释放）；
2. `org.freedesktop.login1.Manager.Inhibit`（logind 的抑制锁，`systemd-inhibit` 就是它的命令行封装）；
3. `gnome-session-inhibit`（GNOME 会话抑制，非 systemd 发行版的兜底）。

两条硬约束决定了形态：

- **Bun 侧没有 D-Bus 客户端**（只有 `bun:ffi`），抑制的生命周期又绑定在**发起调用的那条 D-Bus 连接**上：一次性 `dbus-send` 连断即释放，等于没抑制；要长期持有，就得有一条常驻连接或一个常驻持有进程。
- 与 darwin 对齐的语义是「壳没了断言自动释放」：`caffeinate -w <pid>` 自带这个性质，Linux 的 inhibit 锁没有 `-w` 等价物——壳被 SIGKILL 时持有进程会被 init 收养，锁留在 logind 里（机器从此不再空闲休眠，问题反向重演）。
- **桌面自己决定挂起时，logind 的 `idle` 锁不管用**：GNOME 的 gsd-power 在自动挂起前读的是 **gnome-session 的 `InhibitedActions`**（suspend 用 `FLAG_SUSPEND` 掩码，见 `gnome-settings-daemon/plugins/power/gsd-power-manager.c` 的 `is_action_inhibited()` / `idle_is_session_inhibited()`），真正挂起时调 logind `Suspend(false)`；而 logind 的 `idle` 锁只挡「空闲检测」，挡用户态显式挂起请求的是 `sleep` 锁。结论：GNOME 上能挡住自动挂起的通道是 **gnome-session 的会话抑制**，不是 `systemd-inhibit --what=idle`。

## 决策

Linux 采用「官方命令行封装 + 常驻持有进程 + 看门狗」：

- 通道按会话判定（`XDG_CURRENT_DESKTOP` / `XDG_SESSION_DESKTOP` / `DESKTOP_SESSION` 任一含 `gnome` 即 GNOME 会话），取第一个能立住的，秒退则顺次降级到下一个候选：
  - GNOME 会话：`gnome-session-inhibit --inhibit=suspend --reason=<why> sh -c '<看门狗>'`（挡住 gsd-power 的自动挂起；用 `suspend` 而不是 `idle`，因为 `idle` 会连熄屏一起挡，与「屏幕该关还是照关」冲突）；
  - 其它桌面（KDE / 纯 systemd）：`systemd-inhibit --what=idle --mode=block --why=<why> sh -c '<看门狗>'`（logind 空闲抑制锁）。
- **断言在 = 持有进程活着；释放 = 杀持有进程**（与「杀掉 `caffeinate`」同语义）。
- 看门狗脚本 `while kill -0 <壳 pid> 2>/dev/null; do [ "$PPID" -le 1 ] && exit 0; kill -0 "$PPID" 2>/dev/null || exit 0; sleep 2; done`：壳崩溃/被强杀时 2s 内自杀 → D-Bus 连接断开 → logind/GNOME 释放锁；持有进程自己被 SIGTERM 后同样退出，不留孤儿 `sh`/`sleep`。两条腿都要：`dash` / `busybox ash` **不刷新 `$PPID`**（被收养不会写成 1），只靠第一条腿会漏掉「持有进程已被杀、看门狗还在空转」——本机容器矩阵实测（debian:stable-slim=dash、alpine=ash 均为 `ORPHAN ALIVE`，补第二条腿后 `self-exited`）；第二条腿用启动时记下的原父进程 pid 做 `kill -0` 探测，绕开 `$PPID` 不刷新的差异。
- **秒退认账**：有二进制但拿不到锁（无 session bus / 无 logind）时持有进程会立刻退出，壳侧当场把该通道判死（`capability.available=false` + 原因落日志），并顺次试下一个通道；候选列表只减不增，不会每秒重生进程。
- **降级用户可见**：拿不到任何通道时，经 `get_desktop_settings_data` 新增的 `keep_awake` 能力字段把**原因**送到设置面板「电源」区明示（「本环境拿不到防休眠通道」这句框架语由面板负责，壳侧的 `reason` 只说原因，避免两端拼接重复），不再只有一行壳日志。
- **开关运行期生效**（#186 遗留，本票验收路径必需）：`prevent_sleep` 此前只在壳启动时读一次，运行期开/关不生效（面板却写「改动立即生效」）；`saveSettings` 现在同步裁决器与 tick 循环（`syncPreventSleep`，同值不动，避免无关设置保存 churn），否则维护者真机复验「开启后跑会话」会看不到任何变化。

档位与既有语义对齐：只挡**系统空闲休眠**（屏幕该熄照熄、合盖照睡），与 `caffeinate -i`（PreventUserIdleSystemSleep）、`ES_SYSTEM_REQUIRED` 同一档——因此 GNOME 侧取 `--inhibit=suspend` 而非 `idle`，非 GNOME 侧取 `--what=idle` 而非 systemd-inhibit 的默认 `idle:sleep:shutdown`（后者会把用户显式挂起/关机也一起挡掉）。

## 后果

- 正面：GNOME 侧（挡 gsd-power 的自动挂起）与 logind 空闲路径（挡 `IdleAction` 类空闲动作）都拿到了与 macOS/Windows 同档的防休眠；锁不因壳崩溃泄漏；不可用环境对用户可见（不静默）。
- 代价/边界：不直连 `org.freedesktop.ScreenSaver.Inhibit`（要常驻 D-Bus 连接，超出「无 D-Bus 客户端」的现状）；「有 D-Bus 但没有 `systemd-inhibit`/`gnome-session-inhibit` 二进制」的少数环境仍判不可用（面板明示）；GNOME 会话只持会话抑制，若该机另行配置了 logind `IdleAction=`（非默认），logind 自己的空闲动作不在覆盖内。
- **能力探测的假阳性（盲区，不是静默降级）**：自管空闲挂起的桌面不一定读 logind 抑制锁——XFCE 的 `xfce4-power-manager` 有不认 `systemd-inhibit` 的上游缺陷（连 `--what idle:sleep:handle-suspend-key --mode block` 也照挂，Launchpad #2035004 Confirmed），KDE PowerDevil 是否读 logind 锁存疑（上游 #457859 标题即「不尊重 systemd-inhibit 的 sleep 抑制锁」）；这类桌面上面板会显示「通道可用」，而开关实际可能不生效。要彻底堵，得让实现去查各自桌面的会话回退链（XFCE 的 `xfce4-screensaver`、KDE 的 PolicyAgent），不在本票范围；复验以 GNOME / 纯 logind 环境为准。
- 假阳性只在「锁拿到但桌面不认」时出现：拿不到锁的环境一律 `available:false` + 面板明示（#75 验收第 3 条）。
- 未实测：本机为 macOS，Linux 真机冒烟（跑会话期间不休眠、`systemd-inhibit --list` 有/无该 pid）留维护者；门禁以注入 spawn 的单测锁命令形状与释放语义，另留一条 linux-only 真进程用例（取不到通道时优雅跳过，不假红）。
- 回退：revert 单提交即回到「Linux 只落日志」的旧行为；`keep_awake` 字段随提交回滚，面板自动落到「字段缺位」分支。

## 验证

- `desktop-electrobun/test/power.test.ts`：GNOME 会话首选 gnome-session-inhibit（逐字断言 `--inhibit=suspend`）/ 非 GNOME 不选它 / systemd 主通道 / 秒退降级 / 双缺降级 / 看门狗脚本串 / `syncPreventSleep` 运行期开关（同值不动、关→开、开→关）/ linux-only 真进程（skip-safe，语义证据是容器矩阵而非单测）。
- `desktop-plugin/src/client/keep-awake-note.ts`（纯函数）+ `desktop-plugin/scripts/test-client.mjs`：缺位、不可用（含 reason 缺失）、四个 backend 的文案分支。
- 门禁：壳 `bun run typecheck` + `bun test`，插件 `bun run typecheck` + `bun run test:client`。
