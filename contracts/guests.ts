/**
 * 浏览器 guest 命令（contract 中间层）。
 * 侧边栏浏览器 / 远程窗口的子 webview；guest 挂在发起调用的那个窗口上（每视图授权台账）。
 */

/** 推送种类。 */
export type GuestPushKind = 'started' | 'finished' | 'failed' | 'title' | 'gone' | 'state'

/** 壳侧维护的 guest 镜像状态。 */
export interface GuestState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** 推给页面 `__dshShellBridgeImpl._receive(...)` 的快照。 */
export interface GuestPush extends GuestState {
  lease: string
  kind: GuestPushKind
}

/** acquire 的返回（partition 只回填到 `<webview>` 标签属性，页面不消费语义）。 */
export interface GuestReservation {
  lease: string
  partition: string
}

export interface BrowserGuestCommands {
  browser_guest_acquire: {
    args: { workspaceKey?: string }
    result: GuestReservation
  }

  browser_guest_release: {
    args: { lease: string }
    /** 打扫回执（页面不消费具体键）。 */
    result: Record<string, unknown>
  }

  browser_guest_navigate: {
    args: { lease: string; url: string }
    result: Record<string, unknown>
  }

  /** 控制（前进/后退/刷新等）；动作键由壳 guest-manager 白名单解析。 */
  browser_guest_control: {
    args: Record<string, unknown>
    result: GuestPush
  }

  browser_guest_set_bounds: {
    args: { lease: string; x?: number; y?: number; width?: number; height?: number }
    result: Record<string, unknown>
  }

  browser_guest_set_visible: {
    args: { lease: string; visible: boolean }
    result: Record<string, unknown>
  }

  browser_guest_state: {
    args: { lease: string }
    result: GuestPush
  }

  browser_guest_release_all: {
    args: {}
    result: Record<string, unknown>
  }
}
