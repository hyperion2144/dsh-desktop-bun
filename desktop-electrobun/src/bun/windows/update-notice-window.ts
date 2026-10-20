/**
 * 启动提醒窗的**开窗/关窗**（#140，map #135）：单例句柄 + 构造器注入。
 *
 * 为什么不直接 `new BrowserWindow`：本模块被 #142（启动时机与去重）从启动流程里调，
 * 而窗体本身要能单测。构造器从外面注进来，本文件就能在 `bun test` 里拿假窗跑
 * 「重复打开先关旧窗」「关窗后句柄清干净」这类时序，跟 `window-max.ts` 注入
 * `NativeWindowActions` 是同一个路子。
 *
 * 什么时候**不开窗**是这层的职责：判定层说没更新就没有更新（`updateNoticeModel()` 返回 null），
 * 静默是默认态。什么时候弹是 #142 的职责（后台时机 + 去重 + 开关 + 持久化）。
 */

import {
  UPDATE_NOTICE_HEIGHT,
  UPDATE_NOTICE_WIDTH,
  updateNoticeHtml,
  updateNoticeModel,
  type UpdateNoticePayload,
  type UpdateNoticeOp,
} from './update-notice-dialog.ts'
import { attachUpdateNoticeRpc } from './update-notice-rpc.ts'
import { dialogTitlebarFrameHeight } from './dialog-titlebar.ts'
import type { CarrierPlatform } from './carrier.ts'

/** BrowserWindow 的最小结构（测试用假窗即可，不必真开窗）。 */
export interface NoticeWindowLike {
  close(): void
  on(event: 'closed', handler: () => void): void
  /** 改窗高（#130）：页面量完内容高后叫。假窗可不实现，句柄会安静跳过。 */
  getFrame?(): { x: number; y: number; width: number; height: number }
  setFrame?(x: number, y: number, width: number, height: number): void
}

export interface NoticeWindowOptions {
  title: string
  html: string
  renderer?: 'native' | 'cef'
  /** 官方 Typed RPC 实例（#139：动作走原生桥，html 文档发不出同源 fetch）。 */
  rpc?: unknown
  titleBarStyle: string
  frame: { width: number; height: number }
}

export type NoticeWindowCtor = new (options: NoticeWindowOptions) => NoticeWindowLike

export const UPDATE_NOTICE_TITLE = '更新可用'

export interface UpdateNoticeWindowHandle {
  /** 开着就返回现有窗口。 */
  current(): NoticeWindowLike | null
  /** 没得提醒（判定层说没有更新）时返回 null，且**不开窗**。 */
  open(payload: UpdateNoticePayload): NoticeWindowLike | null
  /** 关掉并清句柄；本来就关着也不报错。 */
  close(): void
  /** 按页面量好的高度重设窗高，位置与宽度保持；窗没开/假窗不支持时什么都不做。 */
  resize(height: number): void
  isOpen(): boolean
}

export function createUpdateNoticeWindow(
  ctor: NoticeWindowCtor,
  options: {
    renderer?: 'native' | 'cef'
    title?: string
    rpc?: unknown
    /** #164：建窗平台。win32/linux 才画标题带，窗高相应 +一段。 */
    platform?: CarrierPlatform
  } = {},
): UpdateNoticeWindowHandle {
  let win: NoticeWindowLike | null = null

  const forget = (): void => {
    if (win !== null) win = null
  }

  return {
    current: () => win,
    isOpen: () => win !== null,
    open(payload: UpdateNoticePayload): NoticeWindowLike | null {
      // 没什么可提醒就别开窗：这条静默口径属于这层（#138 判定 + 票面定的不弹空窗）。
      if (updateNoticeModel(payload) === null) return null
      // 重复命中（多 profile 各查一次、去重后仍弹）只留最新一张，旧的先收掉，避免叠窗。
      if (win !== null) {
        win.close()
        forget()
      }
      win = new ctor({
        title: options.title ?? UPDATE_NOTICE_TITLE,
        html: updateNoticeHtml({ ...payload, platform: options.platform }),
        ...(options.renderer === undefined ? {} : { renderer: options.renderer }),
        ...(options.rpc === undefined ? {} : { rpc: options.rpc }),
        titleBarStyle: 'hiddenInset',
        // #164：带占掉的那一段要还给窗高，否则内容被压缩；页面量高重设时那条已含带。
        frame: {
          width: UPDATE_NOTICE_WIDTH,
          height: dialogTitlebarFrameHeight(UPDATE_NOTICE_HEIGHT, options.platform ?? 'darwin'),
        },
      })
      win.on('closed', forget)
      return win
    },
    close(): void {
      if (win === null) return
      win.close()
      forget()
    },
    resize(height: number): void {
      if (win === null) return
      const setFrame = win.setFrame
      const getFrame = win.getFrame
      // 假窗（单测）不实现这两个可选项：安静跳过，不报错也不弄挂开窗流程。
      if (setFrame === undefined || getFrame === undefined) return
      // 原生调用一律包一层：量窗高是附带的舒适修（#130），它失败不该把提醒本身弄挂。
      try {
        const frame = getFrame.call(win)
        if (frame.height === height) return
        // 只动高度：页脚在底部，位置一变用户会以为窗在跳。
        setFrame.call(win, frame.x, frame.y, frame.width, height)
      } catch {
        // 窗已经被关掉/系统拒绝 setFrame：保持原尺寸，不做第二手补偿。
      }
    },
  }
}

export interface UpdateNoticePresenterDeps {
  createNoticeWindow: NoticeWindowCtor
  /** 执行业务动作（服务面那侧）；每个 profile 一条自己的 RPC 桥。 */
  run: (op: UpdateNoticeOp) => Promise<unknown>
  /** 运行时下载器的当前状态（只读；壳算好百分比再递给页面）。 */
  downloadStatus: () => { active: boolean; version: string; resolved: number; downloaded: number }
  /** 窗关掉后的壳侧刷新（refreshTray）。 */
  refresh: () => void
  renderer?: 'native' | 'cef'
  /** #164：建窗平台。win32/linux 才画标题带，窗高相应 +一段。 */
  platform?: CarrierPlatform
}

export interface UpdateNoticePresenter {
  /** 每 profile 一扇窗：开好了返回 true；判定层说没更新就不开窗返回 false。 */
  show(profile: string, payload: UpdateNoticePayload): Promise<boolean>
  close(profile: string): void
  closeAll(): void
}

/**
 * 每 profile 的提醒窗登记处（C1 拆出的 presenter）：index.ts 原先的
 * updateNoticeWindows/updateNoticeRpcs 两张表 + openUpdateNotice 的组装逻辑搬到这里，
 * 壳侧只剩 `presenter.show(profile, payload)` / `presenter.close(profile)` 两个动作。
 */
export function createUpdateNoticePresenter(deps: UpdateNoticePresenterDeps): UpdateNoticePresenter {
  const windows = new Map<string, UpdateNoticeWindowHandle>()
  const rpcs = new Map<string, Promise<unknown>>()

  const rpcFor = (profile: string): Promise<unknown> => {
    const existing = rpcs.get(profile)
    if (existing !== undefined) return existing
    const pending = attachUpdateNoticeRpc({
      run: deps.run,
      downloadStatus: deps.downloadStatus,
      resize: (height) => windows.get(profile)?.resize(height),
      close: () => windows.get(profile)?.close(),
    })
    rpcs.set(profile, pending)
    return pending
  }

  return {
    async show(profile: string, payload: UpdateNoticePayload): Promise<boolean> {
      const rpc = await rpcFor(profile)
      const existing = windows.get(profile)
      const handle =
        existing ??
        createUpdateNoticeWindow(deps.createNoticeWindow, {
          renderer: deps.renderer,
          rpc,
          platform: deps.platform,
        })
      if (existing === undefined) windows.set(profile, handle)
      const win = handle.open(payload)
      if (win === null) return false
      win.on('closed', () => void deps.refresh())
      return true
    },
    close(profile: string): void {
      windows.get(profile)?.close()
    },
    closeAll(): void {
      for (const handle of windows.values()) handle.close()
    },
  }
}
