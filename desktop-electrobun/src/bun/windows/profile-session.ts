/**
 * ProfileSession（map #178 C1，#188 拍板 / #179 实施）：每 profile 一份「窗口 + 服务面 +
 * 窗口期状态」的一等 module。
 *
 * 本文件收口 index.ts 里曾经的 11 张 per-profile 散表（windows/services/stoppingProfiles/
 * trayHintShown/pendingStartMaximized/frameSaveTimers/heal 三表 + 焦点记账）与开窗/关窗
 * 时序。此后**新增一类 per-profile 状态只能加在这里**（record 字段 + dispose 顺序），
 * 壳侧（index.ts）只保留组合：托盘/菜单/设置/启动界面/单实例/退出。
 *
 * 边界（#188 决策）：
 *  - session 持有 window + service + 窗口期状态；runtime/download/update 能力仍在
 *    ShellService 上，session 只持服务引用。
 *  - 关窗策略留壳：`closePolicy(profile, win)` 由壳注入（主窗回托盘 / 无托盘退进程 /
 *    副窗只销毁），session 只在 will-close 里调用它。
 *  - 关窗拆除顺序（dispose 十步）编进本 module，与原 close 处理器逐字一致。
 *  - 开窗失败不自动回滚：服务面按 #117 保留（托盘可见、可换运行时再试），要停由壳显式 stop()。
 *  - 测试面：注入 createService/createWindow（假窗口），不开真窗口即可断言 open 顺序、
 *    close 十步、focus→lane 指向、失败 phase、单飞去重。
 */
import type { BrowserWindow } from 'electrobun/bun'
import {
  deriveMaximized,
  ensureNativeMaximizeStyles,
  healVerdict,
  isMaximizedPlacementDamaged,
  HEAL_MAX_REPLACES,
  type WindowFrame,
} from './window-max.ts'
import { shellLogLine } from '../platform/shell-log.ts'
import { createWindowFocusTracker } from './window-focus.ts'
import {
  frameForPersist,
  readWindowFrame,
  readWindowMaximized,
  writeWindowFrame,
} from './window-state.ts'
import { planWindowOpen, windowKey } from '../../shared/app/window-targets.ts'
import type { ShellService } from '../host/service.ts'
import type { LaneForwarder } from '../net/lane-forwarder.ts'

/** 关窗拆除的去抖与复查节奏（#80）：与原 index.ts 常量逐字一致。 */
const HEAL_DEBOUNCE_MS = 250
const HEAL_RECHECK_DELAY_MS = 350
/** 拖动/缩放的几何落盘合并窗口（D3）。 */
const FRAME_SAVE_DEBOUNCE_MS = 400

export type OpenFailurePhase = 'service' | 'dsh' | 'window' | 'stopped'

export type OpenResult =
  | { ok: true; session: ProfileSession }
  | { ok: false; phase: OpenFailurePhase; reason: string }

export interface ProfileSessionState {
  windowOpen: boolean
  ready: boolean
  /** #215：这个 profile 的 DSH 实例在不在跑（托盘行据此显示「运行中」）。 */
  running: boolean
  serviceStatus: string
  serviceError: string | null
  origin: string
  pageUrl: string
  lanePort: number | null
  hostPid: number
  inFront: boolean
}

export interface ProfileSession {
  readonly profile: string
  /** 服务面引用（可能已停；退过的那份是终态对象，下一次开窗会另起一份，#215）。没有起过就是 null。 */
  readonly service: ShellService | null
  readonly window: BrowserWindow | null
  state(): ProfileSessionState
  /** 宿主重启后刷回同一个页面 origin；没窗或没 ready 就安静跳过。 */
  reload(url: string): void
  /** 页面请求关窗：走 will-close 的关窗策略（与手关同一条路）。 */
  closeWindow(): void
  stop(): Promise<void>
}

export interface ProfileSessions {
  open(profile: string): Promise<OpenResult>
  focus(profile: string): boolean
  get(profile: string): ProfileSession | undefined
  list(): ProfileSession[]
  /** 窗口开着的 profile（托盘 openWindows / restartDsh 的重开清单）。 */
  openProfiles(): string[]
  /** 起过服务面的 profile（restartDsh 的树级重启清单）；已退掉的实例不在其中——用户显式退的别复活（#215）。 */
  serviceProfiles(): string[]
  focused(): ProfileSession | undefined
  focusedWindow(): BrowserWindow | null
  byWindow(win: BrowserWindow): ProfileSession | undefined
  /** #115：最近记账的那个窗口是否真的挡在用户眼前。 */
  anyInFront(): boolean
  /** #115：这个 profile 的窗口是否在前台（焦点记账 + 可见/最小化兜底）。 */
  inFront(profile: string): boolean
  /** 隐藏回托盘路径的焦点释放（平台不一定补 blur）。 */
  releaseFocus(profile: string): void
  /** D5：首次关窗回托盘提示记账——返回 true 表示是第一次（该弹提示）。 */
  onceTrayHint(profile: string): boolean
  originOf(profile: string): string
  /** 起/复用一份服务面（boot、open、restartDsh 三处共用）。 */
  ensureService(profile: string): Promise<ShellService>
  /** 持有 lane 转发器的那份服务面（多实例下只有先起的那份非 null）。 */
  laneForwarder(): LaneForwarder | null
  /** restartDsh 专用：绕过关窗策略关窗（stopping 放行 will-close），等 close 落账。 */
  closeWindowsForRestart(profiles: readonly string[]): Promise<void>
  /** restartDsh 专用：停服务面并**丢弃**记录（下一次 ensureService 全新拉起）。 */
  resetService(profile: string): Promise<void>
  /** 开窗的第二段（服务已就绪时直接建窗）——restartDsh 重开窗口用。 */
  attachWindow(profile: string, svc: ShellService): Promise<ProfileSession>
  /** 退出前把挂起的几何落盘（去抖定时器等不到了）。 */
  flushAllFrames(): void
  /** 退出路径：停全部服务面（不关窗——quitting 已放行）。 */
  stopAllServices(): Promise<void>
  stop(profile: string): Promise<void>
  stopAll(): Promise<void>
}

export interface ProfileSessionDeps {
  /** 启动 profile：决定谁是主窗、谁沿用 window.json。 */
  instanceProfile: string
  /** 服务面工厂：壳侧组装 ServiceOptions 后 startService。 */
  createService: (profile: string) => Promise<ShellService>
  /** 窗口工厂：建 BrowserWindow + 挂 RPC（壳侧语义）；事件与状态归本 module。 */
  createWindow: (profile: string, svc: ShellService) => Promise<BrowserWindow>
  /** 关窗策略（壳注入）：'hidden'=隐藏回托盘 / 'quit'=退进程 / 'close'=只销毁。 */
  closePolicy: (profile: string, win: BrowserWindow) => 'hidden' | 'quit' | 'close'
  isQuitting: () => boolean
  /** closePolicy 判了 'quit' 时请壳退进程。 */
  onQuitRequested: () => void
  /** 每 profile 的几何落盘文件（主窗 window.json，其余 window-<profile>.json）。 */
  windowStateFile: (profile: string) => string
  /** 逻辑工作区（#73 判定空间）；取不到回 null，判定退回原生旗标。 */
  workArea: (frame: WindowFrame) => WindowFrame | null
  /** 窗口 dom-ready 后的壳侧动作（主窗收启动界面、windowVisible=true）。 */
  onDomReady: (profile: string) => void
  /** 窗口/焦点集合变化后的壳侧动作（refreshTray）。 */
  onWindowsChanged: () => void
  /** 视图授权台账（dispose 第 5 步 revokeLabel）。 */
  views: { revokeLabel(label: string): unknown }
  /** guest 管理器（dispose 第 6 步 releaseHost）。 */
  guests: { releaseHost(label: string): number }
}

/** 单个 profile 的窗口期状态（原 11 张散表的合体）。 */
interface SessionRecord {
  profile: string
  service: ShellService | null
  /**
   * #215：这份服务面已终态（托盘「退出实例」停过、宿主真没了）——不能复用，下次开窗要全新拉起。
   * 与 stopping 不是一回事：stopping 是「正在停」的过程，retired 是「停干净了」的结果。
   */
  retired: boolean
  window: BrowserWindow | null
  /** 该窗的 CEF 浏览器就绪（dom-ready 之前 loadURL/executeJavascript 会打到空 ref）。 */
  ready: boolean
  /** 正在停的途中（关窗 + 停服务面）；停干净了才落 retired。 */
  stopping: boolean
  frameSaveTimer: ReturnType<typeof setTimeout> | null
  healCheckTimer: ReturnType<typeof setTimeout> | null
  healRecheckTimer: ReturnType<typeof setTimeout> | null
  /** 同段最大化期已原生重摆次数（healVerdict 的计数存储；最大化期结束清零）。 */
  healReplaces: number
  /** #206：blur 时窗口处于最小化（Windows restore 落位修正的触发标记，focus 消费后复位） */
  wasMinimized: boolean
  /** #73：启动要恢复最大化的窗——首次 focus 断言补齐后清掉。 */
  pendingStartMaximized: boolean
  session: ProfileSession
}

export function createProfileSessions(deps: ProfileSessionDeps): ProfileSessions {
  const records = new Map<string, SessionRecord>()
  const focus = createWindowFocusTracker()
  /** 最近聚焦的窗口 profile；托盘「显示/隐藏窗口」作用在它身上。 */
  let focusedProfile: string | null = null
  /** D5：首次关窗回托盘提示过一次的 profile（进程生命周期内一次）。 */
  const trayHints = new Set<string>()
  /** 每 profile 的开窗单飞（#188：opening 中 → await 同一 promise）。 */
  const openings = new Map<string, Promise<OpenResult>>()

  const log = (line: string): void => {
    console.log(line)
  }

  /** 持有 lane 转发器的那份服务面（多实例下只有先起的那份非 null）。 */
  function findLaneForwarder(): LaneForwarder | null {
    for (const record of records.values()) {
      if (record.service?.laneForwarder != null) return record.service.laneForwarder
    }
    return null
  }

  function openProfileList(): string[] {
    return [...records.values()].filter((record) => record.window !== null).map((record) => record.profile)
  }

  function recordFor(profile: string): SessionRecord | undefined {
    return records.get(profile)
  }

  function makeRecord(profile: string, service: ShellService): SessionRecord {
    const record: SessionRecord = {
      profile,
      service,
      retired: false,
      window: null,
      ready: false,
      stopping: false,
      frameSaveTimer: null,
      healCheckTimer: null,
      healRecheckTimer: null,
      healReplaces: 0,
      wasMinimized: false,
      pendingStartMaximized: false,
      session: null as unknown as ProfileSession,
    }
    record.session = {
      profile,
      get service() {
        return record.service
      },
      get window() {
        return record.window
      },
      state: () => stateOf(record),
      reload: (url) => {
        if (record.window === null || !record.ready) return
        record.window.webview?.loadURL(url)
      },
      closeWindow: () => {
        record.window?.close()
      },
      stop: () => stopRecord(record),
    }
    return record
  }

  function stateOf(record: SessionRecord): ProfileSessionState {
    const svc = record.service
    return {
      windowOpen: record.window !== null,
      ready: record.ready,
      // 「这个 profile 的 dsh 宿主在不在跑」——口径与托盘顶层的 hostRunning 一致（宿主 PID > 0）。
      // 服务面 stop() 之后宿主 PID 归 0（#215），托盘那行就不再谎报「运行中」。
      running: (svc?.state.hostPid ?? 0) > 0,
      serviceStatus: svc?.state.status ?? 'stopped',
      serviceError: svc?.state.error ?? svc?.state.blocked ?? null,
      origin: svc?.state.origin ?? '',
      pageUrl: svc?.state.pageUrl ?? '',
      lanePort: svc?.state.lanePort ?? null,
      hostPid: svc?.state.hostPid ?? 0,
      inFront: inFront(record.profile),
    }
  }

  /** #115：焦点是事件记的账；隐藏/最小化这类路径平台不一定补 blur，再兜一道可见性。 */
  function inFront(profile: string): boolean {
    if (!focus.isFocused(profile)) return false
    const record = recordFor(profile)
    if (record === undefined || record.window === null) return false
    try {
      return record.window.isVisible() && !record.window.isMinimized()
    } catch {
      // 窗口正在销毁时原生查询可能抛：当作不在前台（宁可多投一次）
      return false
    }
  }

  // ---- 几何落盘（D3）----

  function saveFrameNow(record: SessionRecord, win: BrowserWindow): void {
    const frame = win.getFrame()
    const native = win.isMaximized()
    const maximized = native || deriveMaximized(frame, deps.workArea(frame), native)
    const rounded: WindowFrame = {
      x: Math.round(frame.x),
      y: Math.round(frame.y),
      width: Math.round(frame.width),
      height: Math.round(frame.height),
    }
    // #73 回归：最大化帧不是还原帧——最大化收场时沿用上一次的常规帧（frameForPersist）。
    const file = deps.windowStateFile(record.profile)
    writeWindowFrame(file, frameForPersist(rounded, maximized, readWindowFrame(file)), maximized)
  }

  function scheduleFrameSave(record: SessionRecord, win: BrowserWindow): void {
    if (record.frameSaveTimer !== null) clearTimeout(record.frameSaveTimer)
    record.frameSaveTimer = setTimeout(() => {
      record.frameSaveTimer = null
      try {
        saveFrameNow(record, win)
      } catch (error) {
        console.warn(`[shell] 窗口几何落盘失败：${String(error)}`)
      }
    }, FRAME_SAVE_DEBOUNCE_MS)
  }

  // ---- #80 最大化落位自检（heal）----

  function healMaximizedPlacement(record: SessionRecord, win: BrowserWindow, reason: string): void {
    if (process.platform !== 'win32') return
    if (!win.isMaximized()) {
      record.healReplaces = 0 // 旗标落下 = 一段最大化期结束，重摆计数清零
      return
    }
    const frame = win.getFrame()
    const workArea = deps.workArea(frame)
    if (workArea === null) {
      shellLogLine(`[shell] #80 heal 检查（${reason}）：workArea 取不到（Screen 无显示器数据），跳过`)
      return
    }
    const verdict = healVerdict(isMaximizedPlacementDamaged(frame, workArea), record.healReplaces)
    if (verdict === 'clean') {
      shellLogLine(`[shell] #80 heal 检查（${reason}）：落位正常，不干预 frame=${JSON.stringify(frame)} workArea=${JSON.stringify(workArea)}`)
      return
    }
    if (verdict === 'exhausted') {
      shellLogLine(`[shell] #80 heal 检查（${reason}）：已重摆 ${HEAL_MAX_REPLACES} 次仍外扩，停止防循环 frame=${JSON.stringify(frame)} workArea=${JSON.stringify(workArea)}（重摆也落不好，日志留给上游 WM_NCCALCSIZE 根治）`)
      return
    }
    record.healReplaces += 1
    shellLogLine(
      `[shell] #80 heal 检查（${reason}）：落位外扩 frame=${JSON.stringify(frame)} workArea=${JSON.stringify(workArea)}，原生重摆（第 ${record.healReplaces} 次）`,
    )
    win.unmaximize()
    win.maximize()
    // 重摆会引发 resize 与动画：作废在途的去抖检查与延迟复查，重摆落定后重排一次。
    if (record.healCheckTimer !== null) {
      clearTimeout(record.healCheckTimer)
      record.healCheckTimer = null
    }
    scheduleHealRecheck(record, win, '重摆后复查')
  }

  function scheduleHealCheck(record: SessionRecord, win: BrowserWindow, reason: string): void {
    if (process.platform !== 'win32') return
    if (record.healCheckTimer !== null) clearTimeout(record.healCheckTimer)
    record.healCheckTimer = setTimeout(() => {
      record.healCheckTimer = null
      healMaximizedPlacement(record, win, reason)
    }, HEAL_DEBOUNCE_MS)
  }

  function scheduleHealRecheck(record: SessionRecord, win: BrowserWindow, reason: string): void {
    if (process.platform !== 'win32') return
    if (record.healRecheckTimer !== null) clearTimeout(record.healRecheckTimer)
    record.healRecheckTimer = setTimeout(() => {
      record.healRecheckTimer = null
      healMaximizedPlacement(record, win, reason)
    }, HEAL_RECHECK_DELAY_MS)
  }

  // ---- 窗口事件 ----

  function restoreStartMaximized(record: SessionRecord, win: BrowserWindow): void {
    // D3 反馈：上次是最大化收场的，这次直接最大化（几何记忆只当还原帧用）。
    // Windows 实测：从未显示过的窗上 maximize() 不落 WS_MAXIMIZE 旗标（#73）——
    // 建窗时尽力而为，唯一断言点=首次 focus。
    if (!readWindowMaximized(deps.windowStateFile(record.profile))) return
    ensureNativeMaximizeStyles()
    win.maximize()
    record.pendingStartMaximized = true
  }

  function wireEvents(record: SessionRecord, win: BrowserWindow): void {
    const profile = record.profile
    const isBoot = profile === deps.instanceProfile
    win.on('dom-ready', () => {
      record.ready = true
      if (isBoot) deps.onDomReady(profile)
      deps.onWindowsChanged()
    })
    win.on('focus', () => {
      focusedProfile = profile
      // #115：焦点记账——通知的「聚焦不打扰」靠它；这条日志也是实机自证（聚焦时不弹）
      focus.focus(profile)
      log(`[shell] 窗口聚焦：${profile}`)
      // #73：启动恢复最大化断言（唯一断言点）——首次获得焦点时窗口必然已可见。
      // delete 语义必须保留：flag 不清，用户还原窗口后每次 focus 都会被重新拉最大化。
      if (record.pendingStartMaximized) {
        if (!win.isMaximized()) {
          ensureNativeMaximizeStyles()
          win.maximize()
        }
        if (win.isMaximized()) record.pendingStartMaximized = false
      }
      // #80 自检排在启动补 maximize 之后：去抖/复查都落在补断言完成后。
      scheduleHealCheck(record, win, 'focus')
      scheduleHealRecheck(record, win, 'focus+350ms')
      // lane 稳定接入点跟随焦点（旧壳 forwarder.rs：新连接落焦点实例，存量不动）。
      findLaneForwarder()?.setTarget(record.service?.state.lanePort ?? 0)
      deps.onWindowsChanged()
      // #206：最小化恢复（最大化态）——Windows 原生处理 restore 落位，DPI 缩放屏上物理像素会被
      // 当逻辑像素再缩放一次，窗口高度超出屏幕（heal 的几何判定看不出：getFrame() 是缓存的正确值）。
      // 与 showMainWindow 同构：unmaximize → maximize 强制系统重算最大化几何，heal 随后验证。
      if (record.wasMinimized) {
        record.wasMinimized = false
        if (win.isMaximized()) {
          win.unmaximize()
          win.maximize()
          log(`[shell] 最小化恢复：重新落位最大化（${profile}）`)
        }
      }
    })
    win.on('blur', () => {
      focus.blur(profile)
      // #206：Windows 先 SW_MINIMIZE 再 WA_INACTIVE，blur 时已可查；查不到（竞态）由 200ms 复检兑底。
      if (win.isMinimized()) {
        record.wasMinimized = true
      } else {
        const timer = setTimeout(() => {
          if (win.isMinimized()) record.wasMinimized = true
        }, 200)
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) (timer as { unref(): void }).unref()
      }
      log(`[shell] 窗口失焦：${profile}`)
    })
    // 关窗策略三处共用 closePolicy；原生层先问 will-close，allow=false 就不关。
    win.on('will-close', (event: unknown) => {
      if (deps.isQuitting()) return
      // 「退出（停止实例）/重启」主动销毁窗口时不拦截（record.stopping 由 stop/重启置位）
      if (record.stopping) return
      const action = deps.closePolicy(profile, win)
      if (action === 'hidden') {
        ;(event as { response?: unknown }).response = { allow: false }
        log(`[shell] 关窗回托盘（${profile} 窗口隐藏，进程继续）`)
        return
      }
      if (action === 'quit') {
        log('[shell] 关窗（无托盘）：直接退出')
        deps.onQuitRequested()
        return
      }
      log(`[shell] 关窗（${profile}）：只销毁窗口，实例继续跑`)
    })
    win.on('close', () => dispose(record, win))
    // D3：每窗各自记几何；#80：resize 也纳入 heal 触发面（任务栏恢复的落位外扩在最终摆位后才定格）。
    win.on('resize', () => scheduleHealCheck(record, win, 'resize'))
    win.on('resize', () => scheduleFrameSave(record, win))
    win.on('move', () => scheduleFrameSave(record, win))
  }

  /**
   * 关窗拆除（原 close 处理器的十步，顺序逐字一致）：
   * flush 几何 → 摘窗 → 清 heal 三态 → 撤视图 token → 回收 guest → 释放焦点记账 →
   * 清最近聚焦与 lane 指向 → 刷新托盘。
   */
  function dispose(record: SessionRecord, win: BrowserWindow): void {
    const profile = record.profile
    // 真销毁前把挂起的几何写盘（去抖定时器等不到了），最大化态一并记住
    if (record.frameSaveTimer !== null) {
      clearTimeout(record.frameSaveTimer)
      record.frameSaveTimer = null
      try {
        saveFrameNow(record, win)
      } catch {}
    }
    record.window = null
    record.ready = false
    // #80：heal 的挂起定时器与重摆计数随窗口回收（迟到的定时器不再摸已销毁的窗）
    if (record.healCheckTimer !== null) clearTimeout(record.healCheckTimer)
    record.healCheckTimer = null
    if (record.healRecheckTimer !== null) clearTimeout(record.healRecheckTimer)
    record.healRecheckTimer = null
    record.healReplaces = 0
    // 窗口没了就撤销它的视图 token（旧壳的 capability 是静态文件，这里跟着窗口走）
    deps.views.revokeLabel(windowKey(profile))
    // 窗口里的 guest 子 webview 跟着窗口一起回收（否则会留在窗口之外无法关闭）
    const released = deps.guests.releaseHost(windowKey(profile))
    if (released > 0) log(`[shell] 随窗口回收 guest：${released} 个（${profile}）`)
    // #115：窗口没了就不再算「在前台」（关闭不一定补 blur）
    focus.release(profile)
    if (focusedProfile === profile) {
      focusedProfile = null
      findLaneForwarder()?.setTarget(0)
    }
    deps.onWindowsChanged()
  }

  // ---- 开窗 / 停止 ----

  async function attachWindow(profile: string, svc: ShellService): Promise<ProfileSession> {
    let record = recordFor(profile)
    if (record === undefined) {
      record = makeRecord(profile, svc)
      records.set(profile, record)
    }
    if (record.window !== null) return record.session
    record.service = svc
    // 挂上活的服务面就不是「已退休」的了（retired 只描述上一份已终态的服务面）
    record.retired = false
    const win = await deps.createWindow(profile, svc)
    record.window = win
    focusedProfile = profile
    restoreStartMaximized(record, win)
    wireEvents(record, win)
    return record.session
  }

  async function startOpen(profile: string): Promise<OpenResult> {
    let svc: ShellService
    try {
      svc = await ensureService(profile)
    } catch (error) {
      return { ok: false, phase: 'service', reason: messageOf(error) }
    }
    // #129：startService 只把壳的面立起来（#117），DSH 得显式拉。
    try {
      await svc.ensureRunning()
    } catch (error) {
      return { ok: false, phase: 'dsh', reason: messageOf(error) }
    }
    try {
      const session = await attachWindow(profile, svc)
      return { ok: true, session }
    } catch (error) {
      return { ok: false, phase: 'window', reason: messageOf(error) }
    }
  }

  async function ensureService(profile: string): Promise<ShellService> {
    const before = recordFor(profile)
    const existing = before?.service ?? null
    // 退过的服务面是终态对象（HTTP 面/看门狗/端口认领都拆了）：复用它拉不起 DSH
    // （supervisor 的 stopping 粘住）——退过的实例得重新起一份（#215）。
    if (existing !== null && before?.retired !== true) return existing
    log(`[shell] 起服务面：profile = ${profile}`)
    const started = await deps.createService(profile)
    let record = recordFor(profile)
    if (record === undefined) {
      record = makeRecord(profile, started)
      records.set(profile, record)
    } else {
      record.service = started
      record.retired = false
    }
    return started
  }

  async function stopRecord(record: SessionRecord): Promise<void> {
    if (record.service === null) {
      log(`[shell] 退出实例：${record.profile} 没有在跑的服务面，忽略`)
      return
    }
    if (record.retired) {
      log(`[shell] 退出实例：${record.profile} 的实例已经退过了，忽略`)
      return
    }
    log(`[shell] 退出实例：停止 ${record.profile} 的 dsh 与服务面`)
    const svc = record.service
    record.stopping = true
    try {
      record.window?.close()
      await svc.stop()
    } finally {
      record.stopping = false
      // #215：服务面是终态对象，复用它拉不起 DSH。宿主真没了才记「已退休」——
      // 宿主还活着（停失败）的话这份服务面还能用；判死会让下次开窗另起一份，
      // 跟还占着上游端口的旧宿主撞车。托盘那行也不再谎报「运行中」。
      record.retired = svc.state.status === 'stopped' && svc.state.hostPid === 0
      deps.onWindowsChanged()
    }
  }

  function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  return {
    open(profile: string): Promise<OpenResult> {
      const inFlight = openings.get(profile)
      if (inFlight !== undefined) return inFlight
      const record = recordFor(profile)
      if (record !== undefined && record.window !== null && planWindowOpen(profile, openProfileList()) === 'focus') {
        this.focus(profile)
        return Promise.resolve({ ok: true, session: record.session })
      }
      if (record !== undefined && record.stopping) {
        return Promise.resolve({ ok: false, phase: 'stopped', reason: `${profile} 正在退出` })
      }
      const pending = startOpen(profile).finally(() => {
        openings.delete(profile)
      })
      openings.set(profile, pending)
      return pending
    },

    focus(profile: string): boolean {
      const record = recordFor(profile)
      if (record === undefined || record.window === null) return false
      record.window.unminimize()
      record.window.show()
      record.window.activate()
      focusedProfile = profile
      deps.onWindowsChanged()
      return true
    },

    get: (profile) => recordFor(profile)?.session,

    list: () => [...records.values()].map((record) => record.session),

    openProfiles: openProfileList,

    serviceProfiles: () =>
      [...records.values()].filter((record) => record.service !== null && !record.retired).map((record) => record.profile),

    focused: () => {
      if (focusedProfile === null) return undefined
      return recordFor(focusedProfile)?.session
    },

    focusedWindow: () => {
      if (focusedProfile !== null) {
        const hit = recordFor(focusedProfile)
        if (hit !== undefined && hit.window !== null) return hit.window
      }
      const boot = recordFor(deps.instanceProfile)
      return boot?.window ?? null
    },

    byWindow: (win) => {
      for (const record of records.values()) {
        if (record.window === win) return record.session
      }
      return undefined
    },

    anyInFront: () => {
      const profile = focus.current()
      return profile !== null && inFront(profile)
    },

    inFront,

    releaseFocus: (profile) => {
      focus.release(profile)
    },

    onceTrayHint: (profile) => {
      if (trayHints.has(profile)) return false
      trayHints.add(profile)
      return true
    },

    originOf: (profile) => recordFor(profile)?.service?.state.origin ?? '',

    ensureService,

    laneForwarder: findLaneForwarder,

    async closeWindowsForRestart(profiles: readonly string[]): Promise<void> {
      for (const profile of profiles) {
        const record = recordFor(profile)
        if (record === undefined) continue
        // 关窗绕过关窗策略（回托盘/退进程的判断是给用户手关用的；重启关窗是壳自己的动作）
        record.stopping = true
        record.window?.close()
      }
      // close 事件异步落账（dispose 在 close 回调里），等一拍再动服务面
      await Bun.sleep(100)
      for (const profile of profiles) {
        const record = recordFor(profile)
        if (record !== undefined) record.stopping = false
      }
    },

    async resetService(profile: string): Promise<void> {
      const record = recordFor(profile)
      if (record === undefined || record.service === null) return
      try {
        await record.service.stop()
      } finally {
        records.delete(profile)
      }
    },

    attachWindow,

    flushAllFrames(): void {
      for (const record of records.values()) {
        if (record.frameSaveTimer === null) continue
        clearTimeout(record.frameSaveTimer)
        record.frameSaveTimer = null
        if (record.window === null) continue
        try {
          saveFrameNow(record, record.window)
        } catch {}
      }
    },

    async stopAllServices(): Promise<void> {
      await Promise.all(
        [...records.values()].map(async (record) => {
          if (record.service === null) return
          try {
            await record.service.stop()
          } catch (error) {
            console.error(`[shell] 停止服务面失败（${record.profile}）：${String(error)}`)
          }
        }),
      )
    },

    stop: async (profile: string) => {
      const record = recordFor(profile)
      if (record === undefined) {
        log(`[shell] 退出实例：${profile} 没有在跑的服务面，忽略`)
        return
      }
      // stop() 等 opening 落定后再停（不取消）
      const pending = openings.get(profile)
      if (pending !== undefined) await pending.catch(() => {})
      await stopRecord(record)
    },

    stopAll: async () => {
      for (const record of records.values()) {
        await stopRecord(record)
      }
    },
  }
}
