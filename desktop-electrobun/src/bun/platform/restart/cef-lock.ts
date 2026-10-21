// #237（自 app-restart.ts 迁出）：CEF 单实例锁的目录推导与状态判定。
//
// 监督进程（runtime/shell-supervisor.mjs）在拉起新桌面之前要等 CEF 锁释放（#204 口径），
// 这件事只需要「CEF 目录在哪 + 锁现在什么状态」两个纯判定，与壳侧的 spawn / 日志彻底无关，
// 独立成零依赖模块，包内随 runtime/ 一并复制、由监督进程按相对路径引用。

/** CEF 锁现状：released = 可以拉；held-alive = 锁指向的进程还活着；unknown = 读不出持有者（Windows lockfile 无 pid 信息）。 */
export type CefLockState = 'released' | 'held-alive' | 'unknown'

/**
 * CEF 锁目录（#209 口径修正）：只在 macOS（CEF 后端）且打包态下启用；目录取**实际安装根**下的
 * CEF/（从 launcher 路径 <安装根>/<App>.app/Contents/MacOS/<exe> 上溯四层），不再是废弃的
 * ~/Library/Application Support/<id>/<root> 默认路径。Windows 用 WebView2，无 CEF 锁，返回 null。
 */
export function cefDirFromExecPath(execPath: string, platform: string = process.platform): string | null {
  if (platform !== 'darwin') return null
  // 手写 dirname×4（保持零依赖）：<安装根>/<App>.app/Contents/MacOS/<exe> → 安装根
  let dir = execPath
  for (let i = 0; i < 4; i++) {
    const cut = dir.lastIndexOf('/')
    if (cut <= 0) return null
    dir = dir.slice(0, cut)
  }
  return `${dir}/CEF`
}

/**
 * 判定 CEF 单实例锁是否已释放。输入全部由调用方探测，这里只做纯判定：
 * `rawLockTarget` 是 symlink 的 readlink 结果（mac/linux）；Windows lockfile 读不出持有者，传 null。
 * `targetPidAlive` 收到 rawLockTarget 解析出的 pid（无则不调）。
 */
export function cefLockState(input: {
  lockExists: boolean
  rawLockTarget?: string | null
  targetPidAlive?: (pid: number) => boolean
}): CefLockState {
  if (!input.lockExists) return 'released'
  const raw = input.rawLockTarget ?? null
  if (raw === null || raw.trim() === '') return 'unknown'
  // SingletonLock 的目标是 "<hostname>-<pid>"；取尾段数字
  const match = /-(\d+)$/.exec(raw.trim())
  if (match === null) return 'unknown'
  const pid = Number(match[1])
  if (!Number.isInteger(pid) || pid <= 1) return 'unknown'
  const alive = input.targetPidAlive?.(pid) ?? true
  return alive ? 'held-alive' : 'released'
}

/**
 * CEF 单实例锁的候选文件（mac/linux 是 SingletonLock/Cookie/Socket 三件套；Windows 是 lockfile）。
 * 任何一个都还活着（存在且指向活 pid）就当锁未释放。
 */
export function cefLockProbePaths(cefDir: string, platform: string = process.platform): string[] {
  const names = platform === 'win32' ? ['lockfile'] : ['SingletonLock', 'SingletonCookie', 'SingletonSocket']
  return names.map((name) => `${cefDir}/${name}`)
}
