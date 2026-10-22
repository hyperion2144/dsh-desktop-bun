// 托盘菜单模型（纯逻辑，不 import electrobun ⇒ 缝 ② 直接断言）。
import { sortRuntimeVersionsDesc } from '../../shared/runtime/runtime-catalog.ts'
import type { RuntimeBuiltinDescriptor, RuntimeCandidate } from '../../shared/runtime/runtime-update.ts'
import { remoteDisplay } from '../../shared/net/remote.ts'
//
// 为什么单独一层：菜单项文案、勾选状态、以及「点了哪一项要干什么」是产品语义，
// 而 `Tray` 类只是把它交给原生层。分开之后无显示器/无 CEF 也能测。
//
// 旧 Tauri 壳的托盘能力（`docs/research/shell-capability-inventory.md` 第 6 节）在这里逐项对齐：
// 显示/隐藏窗口、profile 切换、重启应用、运行时来源切换（内置 / 已装版本 /
// 目录里点一下就下载并切换）、退出。
// 还没做的项不摆假入口——宁可菜单短，也不要点了没反应的项。

/** 「profile 管理」子菜单的每条目行（旧壳 tray.rs:63-73；#241 起本地+远程统一条目） */
export interface ProfileRow {
  profile: string
  /** 条目种类：本地 profile（默认）/ 远程 dsh 地址（#246 接入远程通路） */
  kind?: 'local' | 'remote'
  /** 窗口开着 */
  open: boolean
  /** 窗口开着但被隐藏（据此给「显示窗口」而不是「隐藏窗口」） */
  hidden?: boolean
  /** dsh 宿主在跑 */
  running: boolean
  /** 页面 origin 端口（运行中才有） */
  port: number | null
  /** 是当前聚焦窗口 */
  focused: boolean
}

/** 托盘菜单里的动作 id；前缀 `tray:` 便于和右键菜单的 action 区分。 */
export const TRAY_MENU_ACTIONS = {
  toggleWindow: 'tray:toggle-window',
  quit: 'tray:quit',
  restartApp: 'tray:restart-app',
  remoteLocal: 'tray:remote:local',
  remoteAddrPrefix: 'tray:remote:addr:',
  windowPrefix: 'tray:window:',
  runtimeBuiltin: 'tray:runtime:builtin',
  runtimeVersionPrefix: 'tray:runtime:version:',
  runtimeFetchPrefix: 'tray:runtime:fetch:',
  registerCli: 'tray:register-cli',
  stopProfile: 'tray:profile:stop:',
  restartProfile: 'tray:profile:restart:',
  toggleProfileWindow: 'tray:profile:toggle:',
  newProfile: 'tray:profile:new',
  migrateProfile: 'tray:profile:migrate',
  checkUpdates: 'tray:check-updates',
} as const
export type TrayActionKind =
  | 'toggle-window'
  | 'quit'
  | 'restart-app'
  | 'open-window'
  | 'switch-runtime'
  | 'download-runtime'
  | 'register-cli'
  | 'stop-profile'
  | 'restart-profile'
  | 'toggle-profile-window'
  | 'new-profile'
  | 'migrate-profile'
  | 'check-updates'

export interface TrayAction {
  kind: TrayActionKind
  /** kind === 'open-window' 时是目标 profile */
  profile?: string
  /** kind === 'switch-runtime'：不带 version = 切回内置树；带 version = 切到该已下载版本 */
  /** kind === 'switch-runtime'（目标版本）或 'download-runtime'（要下的版本） */
  version?: string
  /** kind === 'remote-source'：选中的远程地址在 remoteList 里的下标；undefined = 切回本地 */
  /** kind === 'stop-profile' 时是目标 profile */
}

export interface TrayState {
  /** 主窗当前是否可见（隐藏 = 关到了托盘） */
  windowVisible: boolean
  /** 当前 profile */
  profile: string
  /** 可用 profile（当前的在最前，其余按字典序） */
  profiles: readonly string[]
  /** 已经开着窗口的 profile（菜单里标「已开窗」，点了是聚焦不是新开） */
  openWindows: readonly string[]
  /** 每 profile 运行行（F8，旧壳 tray.rs「● name · port（聚焦中）」数据源）；空 = 退回旧行为 */
  profileRows?: readonly ProfileRow[]
  /** dsh 宿主是否在跑（守护器重启期间会短暂为 false） */
  hostRunning: boolean
  /**
   * #117：服务面自己管 DSH 的判别位。服务面先于 DSH 存在（#117 的核心），所以托盘在
   * DSH 还没起来 / 起不来的时候照样拿得到，也能把原因摆给用户。缺省按 hostRunning 推。
   */
  serviceStatus?: 'stopped' | 'starting' | 'running' | 'failed' | 'blocked'
  /** serviceStatus 为 failed / blocked 时的原因（直接进状态行，告诉用户还能干什么） */
  serviceError?: string | null
  /** 运行时来源的人类可读标签，例如 `内置 0.2.1-alpha.2` */
  runtimeLabel: string
  /** 随包内置树的版本（拿不到时 null，菜单文案会退成「版本未知」） */
  builtinVersion: string | null
  /** 当前真正在跑的运行时版本（内置 / 本地 override / 已下载都算） */
  runningVersion: string | null
  /** 当前选中的已下载版本；null = 用内置树 */
  selected: string | null
  /** 已下载的版本（菜单里会跳过与内置同号的） */
  installed: readonly string[]
  /** 判定层产出的归一候选（#186/#189）：内置 ∪ 已下载 ∪ 目录，去重降序；菜单不再自己并集。 */
  candidates: readonly RuntimeCandidate[]
  /** 内置行的显示口径（bundled / external / none）；菜单不再写 `builtinVersion ?? runningVersion`。 */
  builtinDescriptor: RuntimeBuiltinDescriptor
  /** 正在下载的版本；非 null 时那条标「（下载中…）」 */
  downloading: string | null
  /** 「注册 dsh 命令」项的文案；null = 已注册或还没探出 ⇒ 不摆这一项（旧壳 #175 三态） */
  registerLabel: string | null
  /**
   * #141：「检查更新」的状态行。缺省（undefined）时菜单不摆这一行，旧调用方不受影响。
   */
  updateCheck?: TrayUpdateCheck
}



/** #141：托盘「检查更新」的进程态（壳主进程维护，事件驱动下发，不定时刷新）。 */
export interface TrayUpdateCheck {
  /** 正在检查（菜单项置灰，防连点） */
  checking: boolean
  /** 上一次检查的结果；null = 还没查过 */
  result: { notify: boolean; reason: string; updates: number } | null
}

/** 与 Electrobun 的 MenuItemConfig 对齐（只声明我们用到的字段）。 */
export type TrayMenuItem =
  | { type: 'divider' }
  | {
      type: 'normal'
      label: string
      action?: string
      enabled?: boolean
      checked?: boolean
      submenu?: TrayMenuItem[]
    }

export function windowAction(profile: string): string {
  return `${TRAY_MENU_ACTIONS.windowPrefix}${profile}`
}

/** 菜单点击 → 语义动作；未知 action 返回 null（原生 role 之类不该被我们处理）。 */
export function parseTrayAction(action: string | undefined | null): TrayAction | null {
  if (action === undefined || action === null) return null
  if (action === TRAY_MENU_ACTIONS.toggleWindow) return { kind: 'toggle-window' }
  if (action === TRAY_MENU_ACTIONS.quit) return { kind: 'quit' }
  if (action.startsWith(TRAY_MENU_ACTIONS.windowPrefix)) {
    const profile = action.slice(TRAY_MENU_ACTIONS.windowPrefix.length)
    if (profile === '') return null
    return { kind: 'open-window', profile }
  }
  if (action === TRAY_MENU_ACTIONS.registerCli) return { kind: 'register-cli' }
  if (action === TRAY_MENU_ACTIONS.restartApp) return { kind: 'restart-app' }
  if (action === TRAY_MENU_ACTIONS.checkUpdates) return { kind: 'check-updates' }
  if (action === TRAY_MENU_ACTIONS.runtimeBuiltin) return { kind: 'switch-runtime' }
  if (action.startsWith(TRAY_MENU_ACTIONS.runtimeVersionPrefix)) {
    const version = action.slice(TRAY_MENU_ACTIONS.runtimeVersionPrefix.length)
    if (version === '') return null
    return { kind: 'switch-runtime', version }
  }
  if (action.startsWith(TRAY_MENU_ACTIONS.runtimeFetchPrefix)) {
    const version = action.slice(TRAY_MENU_ACTIONS.runtimeFetchPrefix.length)
    if (version === '') return null
    return { kind: 'download-runtime', version }
  }
  if (action === TRAY_MENU_ACTIONS.newProfile) return { kind: 'new-profile' }
  if (action === TRAY_MENU_ACTIONS.migrateProfile) return { kind: 'migrate-profile' }
  if (action.startsWith(TRAY_MENU_ACTIONS.stopProfile)) {
    const profile = action.slice(TRAY_MENU_ACTIONS.stopProfile.length)
    if (profile === '') return null
    return { kind: 'stop-profile', profile }
  }
  if (action.startsWith(TRAY_MENU_ACTIONS.restartProfile)) {
    const profile = action.slice(TRAY_MENU_ACTIONS.restartProfile.length)
    if (profile === '') return null
    return { kind: 'restart-profile', profile }
  }
  if (action.startsWith(TRAY_MENU_ACTIONS.toggleProfileWindow)) {
    const profile = action.slice(TRAY_MENU_ACTIONS.toggleProfileWindow.length)
    if (profile === '') return null
    return { kind: 'toggle-profile-window', profile }
  }
  return null
}

/** 当前 profile 排最前、其余去重后字典序——菜单顺序稳定，不随发现顺序抖。 */
export function orderedProfiles(state: Pick<TrayState, 'profile' | 'profiles'>): string[] {
  const rest = [...new Set(state.profiles)].filter((entry) => entry !== state.profile).sort()
  return [state.profile, ...rest]
}

/** 托盘最多列几条「目录里还没装」的版本（旧壳同口径）。 */
export const TRAY_RUNTIME_FETCH_LIMIT = 5

function channelSuffix(channel: string): string {
  return channel === '' ? '' : `（${channel}）`
}

/**
 * 运行时版本子菜单（旧壳 `runtime_menu_items` 的等价物）。
 * 内置 / 某个已下载版本二者互斥，勾选状态交给原生 checkmark 画；
 * 目录里还没装的版本列成「↓ 下载并切换」（至多 5 条）——点了先下再切，旧壳同一套。
 */
export function runtimeMenuItems(state: TrayState): TrayMenuItem[] {
  // 内置行的显示口径来自判定层的 builtinDescriptor（#186/#189）：bundled=随包内置，
  // external=dev 外部树（版本退成正在跑的那棵），none=版本未知。这里不再写 ?? 回退。
  const builtinLabel = state.builtinDescriptor.version
  const builtinOn = state.selected === null || state.selected === state.builtinVersion
  /** 版本号与正在跑的一致、但那一行没打勾时标一下（打勾本身已经说明「就是它」） */
  const runningTag = (version: string | null, checked: boolean): string =>
    !checked && version !== null && version === state.runningVersion ? '（当前运行）' : ''
  const builtinSuffix =
    runningTag(builtinLabel, builtinOn) === '' ? '' : ' · 当前运行'
  const items: TrayMenuItem[] = [
    {
      type: 'normal',
      label:
        builtinLabel === null
          ? '内置（随安装包，版本未知）'
          : `内置 ${builtinLabel}（随安装包${builtinSuffix}）`,
      action: TRAY_MENU_ACTIONS.runtimeBuiltin,
      checked: builtinOn,
    },
  ]
  const installing = state.downloading
  // 已下载行来自判定层候选的 downloaded 段（已去重、已跳过与内置同号）；下载中的版本
  // 还没进已装列表，也得有一行，否则点完菜单看不到任何反馈。
  const installed = sortRuntimeVersionsDesc(
    [
      ...new Set([
        ...state.candidates.filter((entry) => entry.source === 'downloaded').map((entry) => entry.version),
        ...(installing === null ? [] : [installing]),
      ]),
    ].filter((version) => version !== builtinLabel)
  )
  for (const version of installed) {
    items.push({
      type: 'normal',
      label:
        installing === version
          ? `${version}（下载中…）`
          : `${version}${runningTag(version, state.selected === version)}`,
      action: `${TRAY_MENU_ACTIONS.runtimeVersionPrefix}${version}`,
      checked: state.selected === version,
      enabled: installing !== version,
    })
  }
  // 目录里还没装的版本列成「↓ 下载并切换」（判定层候选的 remote 段已含全量目录），最多 5 条。
  const pending = state.candidates
    .filter(
      (entry) =>
        entry.source === 'remote' &&
        !installed.includes(entry.version) &&
        entry.version !== builtinLabel
    )
    .slice(0, TRAY_RUNTIME_FETCH_LIMIT)
  if (pending.length > 0) items.push({ type: 'divider' })
  for (const entry of pending) {
    items.push({
      type: 'normal',
      label: `↓ 下载并切换 ${entry.version}${channelSuffix(entry.channel)}`,
      action: `${TRAY_MENU_ACTIONS.runtimeFetchPrefix}${entry.version}`,
      enabled: installing === null,
    })
  }
  return items
}


/**
 * 托盘菜单限宽（目标 A6）：Electrobun 的菜单项没有 width 概念，超长 label 会把菜单
 * 拉到很宽（运行时路径/远程地址/冲突路径都可能很长）。按码点截断加省略号，
 * 保留动作语义（action 不变）；子菜单 label 同样处理。
 */
export const TRAY_LABEL_MAX = 48
export function truncateTrayLabel(label: string, max = TRAY_LABEL_MAX): string {
  const chars = Array.from(label)
  if (chars.length <= max) return label
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

/** 菜单树遍历：对每个普通项的 label 限宽；子菜单递归。 */
function truncateMenu(items: TrayMenuItem[]): TrayMenuItem[] {
  return items.map((item) => {
    if (item.type !== 'normal') return item
    const next: TrayMenuItem = { ...item, label: truncateTrayLabel(item.label) }
    if ('submenu' in item && item.submenu !== undefined) {
      ;(next as { submenu?: TrayMenuItem[] }).submenu = truncateMenu(item.submenu)
    }
    return next
  })
}
/**
 * #117：托盘状态行。把「服务面在 / DSH 在不在 / 为什么不在」讲清楚，
 * 而不是一个「宿主未运行」就让人猜。没有 serviceStatus 的旧调用方按 hostRunning 兼容。
 */
export function statusLabel(state: TrayState): string {
  const status = state.serviceStatus
  if (status === undefined) return state.hostRunning ? '状态：运行中' : '状态：宿主未运行'
  if (status === 'running') return '状态：运行中'
  if (status === 'starting') return '状态：dsh 启动中…'
  if (status === 'stopped') return '状态：dsh 未运行（托盘已就绪）'
  const why = state.serviceError === undefined || state.serviceError === null || state.serviceError === '' ? '' : `（${truncateTrayLabel(state.serviceError)}）`
  if (status === 'blocked') return `状态：已阻塞${why}`
  return `状态：dsh 未起来${why}`
}

/**
 * #141：「检查更新」状态行的文案。产品语义，跟着菜单模型一起单测。
 *
 * 口径：查不了就直说查不成（原因跟在后面），而不是抿一句「已是最新」——用户会把它当成真结论。
 */
export function updateCheckLabel(check: TrayUpdateCheck | undefined): string | null {
  if (check === undefined) return null
  if (check.checking) return '更新：正在检查…'
  if (check.result === null) return '更新：未检查'
  if (check.result.notify) return `更新：有 ${String(check.result.updates)} 项可用更新`
  return `更新：${truncateTrayLabel(check.result.reason)}`
}

/**
 * #141：「检查更新」那两格——只在用户问过一次之后才出现（状态行），但「检查更新」始终在。
 * 状态行 enabled:false（只读），菜单项在检查中置灰防连点。
 */
function updateCheckItems(state: Pick<TrayState, 'updateCheck'>): TrayMenuItem[] {
  const status = updateCheckLabel(state.updateCheck)
  const items: TrayMenuItem[] = []
  if (status !== null) items.push({ type: 'normal', label: status, enabled: false })
  items.push({
    type: 'normal',
    label: '检查更新',
    action: TRAY_MENU_ACTIONS.checkUpdates,
    enabled: state.updateCheck?.checking !== true,
  })
  return items
}

export function trayMenu(state: TrayState): TrayMenuItem[] {
  const profiles = orderedProfiles(state)
  const items: TrayMenuItem[] = [
    {
      type: 'normal',
      label: state.windowVisible ? '隐藏窗口' : '显示窗口',
      action: TRAY_MENU_ACTIONS.toggleWindow,
    },
    { type: 'divider' },
  ]
  // 「PROFILE 窗口」（旧壳 tray.rs:63-73 的等价物）：每 profile 一层子菜单，头部
  // 「profile 管理」（#241，旧壳 tray.rs:63-73 的等价物）：本地 profile 与远程 dsh 地址
  // 统一成条目，每条目四个动作：打开/聚焦 → 隐藏·显示窗口 → 重启 → 退出。
  // 新建/迁移入口挂在子菜单尾部（F9 的 UI 门面，表单窗由壳进程弹出）。
  const rows =
    state.profileRows ??
    profiles.map((profile) => ({
      profile,
      kind: 'local' as const,
      open: state.openWindows.includes(profile),
      hidden: false,
      running: profile === state.profile && state.hostRunning,
      port: null as number | null,
      focused: profile === state.profile,
    }))
  const windowItems: TrayMenuItem[] = rows.map((row) => {
    const isRemote = (row.kind ?? 'local') === 'remote'
    // 远程条目显示 host[:port]（不含 token）；本地照旧裸名。
    const name = isRemote && row.profile.startsWith('remote:') ? remoteDisplay(row.profile.slice('remote:'.length)) : row.profile
    const portPart = row.port !== null ? ` · ${row.port}` : ''
    const remotePart = isRemote ? ' · 远程' : ''
    const head = row.running
      ? `${row.focused ? '● ' : ''}${name}${portPart}${remotePart}（${row.focused ? '聚焦中' : '运行中'}）`
      : `${name}${remotePart}`
    // #241 每条目四动作；#246 远程条目解锁 打开/显隐/重启（窗口重建），退出仅本地
    // （远程 dsh 不归本桌面停）——不摆假入口是本文件的既定口径。
    const sub: TrayMenuItem[] = [
      {
        type: 'normal',
        label: row.open ? '聚焦窗口' : `在新窗口打开 ${name}`,
        action: windowAction(row.profile),
        checked: row.focused,
      },
    ]
    if (row.open) {
      sub.push({
        type: 'normal',
        label: row.hidden ? '显示窗口' : '隐藏窗口',
        action: `${TRAY_MENU_ACTIONS.toggleProfileWindow}${row.profile}`,
      })
    }
    if (row.open || row.running) {
      // #246：远程条目重启 = 窗口销毁重建（数据面重连）；本地照旧。
      sub.push({
        type: 'normal',
        label: '重启',
        action: `${TRAY_MENU_ACTIONS.restartProfile}${row.profile}`,
      })
    }
    if (!isRemote && (row.open || row.running)) {
      // #215：退过的实例（没开窗也没在跑）不摆「退出」——服务面已是终态对象，点了走不通。
      sub.push({ type: 'divider' })
      sub.push({
        type: 'normal',
        label: '退出（停止实例）',
        action: `${TRAY_MENU_ACTIONS.stopProfile}${row.profile}`,
      })
    }
    return { type: 'normal' as const, label: head, submenu: sub }
  })
  windowItems.push(
    { type: 'divider' },
    { type: 'normal', label: '新建 Profile…', action: TRAY_MENU_ACTIONS.newProfile },
    { type: 'normal', label: '迁移 Profile…', action: TRAY_MENU_ACTIONS.migrateProfile },
  )
  items.push({
    type: 'normal',
    label: 'profile 管理',
    submenu: windowItems,
  })
  items.push(
    // 运行时来源：只读一行看当前，真正的切换在子菜单里（旧壳的 `运行时版本` 子菜单同形）
    { type: 'normal', label: `运行时：${state.runtimeLabel}`, enabled: false },
    {
      type: 'normal',
      label: '运行时版本',
      submenu: runtimeMenuItems(state),
    },
    // #141：「检查更新」与运行时子菜单同区（都是“把自己这套弄到最新”）。
    ...updateCheckItems(state),
    {
      type: 'normal',
      label: statusLabel(state),
      enabled: false,
    },
    { type: 'normal', label: '重启应用', action: TRAY_MENU_ACTIONS.restartApp },
    // 「注册 dsh 命令」（旧壳 #175 条件项）：只在未注册/冲突时出现，已注册或还没探出就不摆
    ...(state.registerLabel === null
      ? []
      : [
          {
            type: 'normal' as const,
            label: state.registerLabel,
            action: TRAY_MENU_ACTIONS.registerCli,
          },
        ]),
    { type: 'divider' },
    { type: 'normal', label: '退出', action: TRAY_MENU_ACTIONS.quit },
  )
  return truncateMenu(items)
}

/** 托盘图标的悬停/无障碍标题：一眼能看出「哪个 profile」 */
export function trayTitle(state: Pick<TrayState, 'profile'>): string {
  return `DSH · ${state.profile}`
}
