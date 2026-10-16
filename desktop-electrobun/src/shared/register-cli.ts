// dsh 系统命令注册的纯逻辑（旧壳 `desktop/src-tauri/src/register/` 的等价物）。
//
// 决策（旧壳 #170）：注册物 = 壳维护的稳定 shim 入口 `<appSupport>/runtime/bin-dsh/dsh`
// （unix）/ `dsh.cmd`（windows），随运行时切换自动跟随；「已注册」= 用户**真实 shell 环境**
// 解析 `dsh` 命中本壳 shim（看 PATH 顺序，而不是「注册物文件在不在」）；解析到别人的
// dsh 就是冲突（提示 + 可选强制覆盖）。
//
// 这里只放不碰 IO 的部分：三态判定、shim 内容、提权脚本、rc PATH 修正行的选择、
// 探测输出的清洗。真正的 spawn / 写盘在 `src/bun/register-cli.ts`。

/** 壳维护的 shim 目录（相对 appSupport）与文件名。 */
export const SHIM_DIR = 'runtime/bin-dsh'
export const REGISTER_TARGET = '/usr/local/bin/dsh'
export const CONFLICT_MARKER = 'dsh-register-conflict'
/** 探测登录 shell 的超时（旧壳取 VS Code shellEnv 同款 10s 先例的 8s）。 */
export const DETECT_TIMEOUT_MS = 8_000
/** 注册状态缓存有效期：菜单重建很频繁，**绝不在菜单构建里同步 spawn shell**。 */
export const CACHE_TTL_MS = 30_000

export type RegisterKind = 'registered' | 'missing' | 'conflict' | 'unknown'

export interface RegisterState {
  kind: RegisterKind
  /** 用户环境里解析到的 dsh（冲突时的「别人」；missing 时为 null） */
  resolved: string | null
  /** shim 是否已经物化在磁盘上 */
  shimReady: boolean
  at: number
}

export function shimFileName(platform: string): string {
  return platform === 'win32' ? 'dsh.cmd' : 'dsh'
}

export function shimPathOf(appSupport: string, platform: string): string {
  return `${appSupport.replace(/\/+$/, '')}/${SHIM_DIR}/${shimFileName(platform)}`
}

/**
/**
 * shim 内容：一条 exec 转发，指向**当前**运行时的 dsh 入口（可带解释器与参数，
 * 例如 `bun --no-install --preload <preload> <dshLibDir>/bin.js`）。
 * unix 用 `exec` 让信号直达；windows 用 `.cmd` 包一层。
 */
export function shimScript(platform: string, argv: readonly string[]): string {
  const [exe = '', ...rest] = argv
  if (platform === 'win32') {
    const args = rest.map((arg) => `"${arg}"`).join(' ')
    return `@echo off\r\nrem 由 dsh 桌面壳维护：指向当前运行时的 dsh 入口\r\n"${exe}"${args === '' ? '' : ` ${args}`} %*\r\n`
  }
  const args = rest.map(shellQuote).join(' ')
  const line = [shellQuote(exe), args].filter((part) => part !== '').join(' ')
  return `#!/bin/sh\n# 由 dsh 桌面壳维护：指向当前运行时的 dsh 入口\nexec ${line} "$@"\n`
}


/** shim 现值：ours（内容一致）/ stale（我们要重写）/ foreign（别人放的，别动） */
export type ShimVerdict = 'ours' | 'stale' | 'foreign' | 'absent'

export function classifyShim(text: string | null, expected: string): ShimVerdict {
  if (text === null) return 'absent'
  if (text === expected) return 'ours'
  // 我们写的 shim 一定带这行注释；没有它就别覆盖（用户自己放的 dsh 也是合法状态）
  if (text.includes('由 dsh 桌面壳维护')) return 'stale'
  return 'foreign'
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI 转义就是控制字符
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
}

/** 取最后一个非空行（rc 横幅在前，命令结果在末行；旧壳 #173 同款）。 */
export function extractLastNonEmptyLine(text: string): string | null {
  const lines = text.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = stripAnsi(lines[index] ?? '').trim()
    if (line !== '') return line
  }
  return null
}

/** 路径相等：先 literal，再统一斜杠与（Windows 的）大小写。realpath 由调用方先做过。 */
export function samePath(left: string, right: string, platform: string): boolean {
  const norm = (value: string): string => {
    const trimmed = value.replace(/\/+$/, '')
    return platform === 'win32' ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed
  }
  return norm(left) === norm(right)
}

/**
 * 三态判定（照抄旧壳 `classify`）：
 * - 解析不到 `dsh` → 未注册
 * - shim 还没物化 → 未注册（连本壳入口都没有，谈不上「已注册」）
 * - 命中本壳 shim → 已注册
 * - 其余 → 冲突，记录解析目标
 */
export function classifyResolution(input: {
  shimPath: string
  shimReady: boolean
  resolved: string | null
  platform: string
}): RegisterKind {
  if (input.resolved === null || !input.shimReady) return 'missing'
  return samePath(input.resolved, input.shimPath, input.platform) ? 'registered' : 'conflict'
}

/** 托盘项文案：已注册/未定论时不显示（返回 null）。 */
export function registerTrayLabel(state: RegisterState): string | null {
  if (state.kind === 'registered' || state.kind === 'unknown') return null
  if (state.kind === 'missing') return '注册 dsh 为系统命令'
  return `注册 dsh 为系统命令（检测到冲突：${state.resolved ?? '未知'}）`
}

/** 给日志/通知用的一句话。 */
export function describeRegisterState(state: RegisterState): string {
  if (state.kind === 'registered') return 'dsh 命令已指向本壳'
  if (state.kind === 'missing') return '系统里没有 dsh 命令（或本壳 shim 未物化）'
  if (state.kind === 'conflict') return `dsh 命令被别的程序占着：${state.resolved ?? '未知'}`
  return '注册状态还没探出来'
}

/** POSIX 单引号包裹（提权脚本里路径安全）。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** AppleScript 字面量转义。 */
export function appleEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * 提权安装脚本（在 `/bin/sh` 下跑，一律绝对路径）：
 * mkdir -p → 已是我们 → exit 0 → 冲突（非 force：stderr 打标记 exit 3；force：带时间戳备份后放行）
 * → `ln -sfn`。
 */
export function registrationScript(input: { shim: string; target?: string; force: boolean }): string {
  const target = input.target ?? REGISTER_TARGET
  const dir = target.slice(0, target.lastIndexOf('/'))
  const shim = shellQuote(input.shim)
  return [
    `/bin/mkdir -p ${shellQuote(dir)}`,
    `t=${shellQuote(target)}`,
    'if [ -e "$t" ] || [ -L "$t" ]; then',
    '  cur=`/usr/bin/readlink "$t" 2>/dev/null`',
    `  if [ "$cur" = ${shim} ]; then`,
    '    exit 0',
    '  fi',
    `  if [ ${shellQuote(input.force ? '1' : '0')} = '1' ]; then`,
    '    /bin/mv "$t" "$t.bak.`/bin/date +%Y%m%d%H%M%S`" || exit 9',
    '  else',
    `    echo ${shellQuote(CONFLICT_MARKER)} >&2`,
    '    exit 3',
    '  fi',
    'fi',
    `/bin/ln -sfn ${shim} "$t"`,
    '',
  ].join('\n')
}

/** Linux 注册目标：`~/.local/bin/dsh`（XDG 惯例位，绝大多数发行版默认在 PATH）。 */
export const LINUX_BIN_SUBDIR = '.local/bin'

export function linuxRegistrationTarget(home: string): string {
  return `${home.replace(/\/+$/, '')}/${LINUX_BIN_SUBDIR}/dsh`
}

/**
 * Linux 安装脚本（用户身份 `/bin/sh -c` 直接跑，无需提权，工具走 PATH）：
 * 结构与 macOS 提权脚本一致：幂等 exit 0 → 冲突 stderr 打标记 exit 3 →
 * force 带时间戳备份后放行 → `ln -sfn`。
 */
export function linuxRegistrationScript(input: { shim: string; home: string; force: boolean }): string {
  const target = linuxRegistrationTarget(input.home)
  const shim = shellQuote(input.shim)
  return [
    `/bin/mkdir -p ${shellQuote(target.slice(0, target.lastIndexOf('/')))}`,
    `t=${shellQuote(target)}`,
    'if [ -e "$t" ] || [ -L "$t" ]; then',
    '  cur=`readlink "$t" 2>/dev/null`',
    `  if [ "$cur" = ${shim} ]; then`,
    '    exit 0',
    '  fi',
    `  if [ ${shellQuote(input.force ? '1' : '0')} = '1' ]; then`,
    '    mv "$t" "$t.bak.`date +%Y%m%d%H%M%S`" || exit 9',
    '  else',
    `    echo ${shellQuote(CONFLICT_MARKER)} >&2`,
    '    exit 3',
    '  fi',
    'fi',
    `/bin/ln -sfn ${shim} "$t"`,
    '',
  ].join('\n')
}

/**
 * Windows 注册 = 把 shim 目录写进**用户 PATH**（`HKCU\Environment\Path` 注册表值）。
 * 禁用 `setx`（历史 1024 字符截断 bug）；`reg query` 读原始值（保 %VAR% 不展开），
 * PowerShell `Set-ItemProperty` 按原类型写回，写后广播 `WM_SETTINGCHANGE`
 * 让资源管理器与新进程拿到新 PATH（已开着的终端不会热更新）。
 */
export type WindowsPathValueKind = 'REG_SZ' | 'REG_EXPAND_SZ'

/** 解析 `reg query HKCU\Environment /v Path` 输出里的值行（类型 + 原始值）。 */
export function parseWindowsPathRegQuery(stdout: string): { type: WindowsPathValueKind; raw: string } | null {
  const match = /\s(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(stripAnsi(stdout).trim())
  if (match === null) return null
  return { type: match[1] as WindowsPathValueKind, raw: (match[2] ?? '').trim() }
}

/** 用户 PATH 拆项（空项丢弃，保序不去重——顺序即优先级）。 */
export function windowsUserPathEntries(raw: string): string[] {
  return raw
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/** shim 目录是否已在用户 PATH 里（大小写/斜杠不敏感）。 */
export function windowsPathHasEntry(entries: readonly string[], dir: string): boolean {
  return entries.some((entry) => samePath(entry, dir, 'win32'))
}

/** 本壳历史安装的 shim 目录残留（同 app id 的 bin-dsh 目录但不是当前那份）：新终端按 PATH
 *  顺序解析会命中旧幽灵项，注册时顺手清掉——只动我们自己的入口，不碰别人的。 */
const OUR_SHIM_ENTRY = /com\.hyperion\.dsh-desktop-bun.*bin-dsh/i

/** 新的用户 PATH 原始值：普通注册追加到末尾，force 前置（抢在用户级其他 dsh 之前）；
 *  本壳旧安装的 shim 目录残留一并清掉（#62 PR 实测：幽灵项把 `dsh` 解析到旧坏入口）。 */
export function windowsUserPathWrite(entries: readonly string[], dir: string, force: boolean): string {
  const kept = entries.filter((entry) => !(OUR_SHIM_ENTRY.test(entry) && !samePath(entry, dir, 'win32')))
  return force ? [dir, ...kept].join(';') : [...kept, dir].join(';')
}

/** 写回 + 广播 WM_SETTINGCHANGE 的 PowerShell 脚本（宿主以 `-EncodedCommand` 执行，免引号地狱）。 */
export function windowsPathWriteScript(raw: string, type: WindowsPathValueKind): string {
  const kind = type === 'REG_EXPAND_SZ' ? 'ExpandString' : 'String'
  return [
    `Set-ItemProperty -Path 'HKCU:\\Environment' -Name 'Path' -Value '${raw.replace(/'/g, "''")}' -Type ${kind}`,
    "$sig = '[DllImport(\"user32.dll\", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'",
    '$type = Add-Type -MemberDefinition $sig -Name NativeMethods -Namespace DshPathBroadcast -PassThru',
    '[UIntPtr]$result = [UIntPtr]::Zero',
    // HWND_BROADCAST=0xffff，WM_SETTINGCHANGE=0x001A，SMTO_ABORTIFHUNG=0x0002
    "$type::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null",
  ].join('\n')
}

/**
 * 顺序遮蔽修正：`/usr/local/bin` 常在 path_helper 之后被挤到后面，于是往**用户真实 shell**
 * 的 rc 里补一行前置。bash 的坑（旧壳 #173）：bash login 按序取第一个**存在**的文件，
 * 新建 `.bash_profile` 会遮蔽已有的 `.profile` ⇒ 已存在才用，否则退回 `.profile`。
 */
export function shellRcPathFix(input: {
  shell: string
  home: string
  exists: (path: string) => boolean
  targetDir?: string
}): { file: string; line: string } {
  const dir = input.targetDir ?? '/usr/local/bin'
  const home = input.home.replace(/\/+$/, '')
  const name = input.shell.split('/').pop() ?? input.shell
  if (name === 'fish') return { file: `${home}/.config/fish/config.fish`, line: `fish_add_path ${dir}` }
  if (name === 'bash') {
    const bashProfile = `${home}/.bash_profile`
    if (input.exists(bashProfile)) return { file: bashProfile, line: `export PATH="${dir}:$PATH"` }
    const profile = `${home}/.profile`
    if (input.exists(profile)) return { file: profile, line: `export PATH="${dir}:$PATH"` }
    return { file: bashProfile, line: `export PATH="${dir}:$PATH"` }
  }
  return { file: `${home}/.zshrc`, line: `export PATH="${dir}:$PATH"` }
}

/** 登录 shell 探测命令（macOS/Linux）：`command -v dsh`，禁掉 Oh My Zsh 自动更新防卡。 */
export const DETECT_COMMAND = 'command -v dsh'
export const DETECT_ENV = { DISABLE_AUTO_UPDATE: 'true' }

/** `dscl . -read /Users/<u> UserShell` 的输出解析（失败回 null → 调用方回落 $SHELL）。 */
export function parseUserShell(dsclOutput: string): string | null {
  const match = /UserShell:\s*(\S+)/.exec(dsclOutput)
  return match?.[1] ?? null
}
