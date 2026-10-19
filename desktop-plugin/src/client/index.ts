import type { ClientContext } from './bridge/ctx-types.ts'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { applyAdvancedShell } from './shell/advanced-shell.ts'
import { registerDownloadsTab } from './features/downloads-tab.tsx'
import { installDownloadInterceptor } from './bridge/download-intercept.ts'
import { installDesktopBrowserBridge } from './bridge/desktop-browser-bridge.ts'
import { registerDesktopSettings } from './desktop-settings.tsx'
import { registerNotificationsTab } from './features/notifications-tab.tsx'
import { requestDesktopClientEnvironment } from './features/environment.ts'
import { installDesktopPlatformBridge } from './bridge/platform-keyboard.ts'
import { shellRpc } from './shell/shell-rpc.ts'
import type { CommandName } from '../../../contracts/index.ts'
import { installComposerInputGuard } from './ui/composer-input-guard.ts'
import { createConsoleBatch } from './shell/console-batch.ts'

export { applyAdvancedShell } from './shell/advanced-shell.ts'
export { parseDesktopClientEnvironment, requestDesktopClientEnvironment } from './features/environment.ts'
export type { DesktopClientEnvironment, DesktopClientPlatform } from './features/environment.ts'

/** Services required by advanced presentation. */
export const inject = [
  'slots',
  'sessions',
  'theme',
  'workspaces',
  'connection',
]

/**
 * 把 WebView 控制台（console.* / window.onerror / unhandledrejection）镜像到桌面壳的
 * `log_console` 命令，壳端追加到 `~/.dsh/dsh-desktop-webview.log`。
 * 失败（无壳通道、序列化抛错）一律吞掉，不阻塞页面。运行成本（#54 攒批后）：均摊
 * 多条 console 一次 RPC；warn/error 还会额外镜像到 dsh-desktop-tauriapp.log
 * 便于交叉对比。装在 apply 头部，确保 dsh-desktop-tauriapp client 装载后所有插件的
 * console.* 都走这条路径（仅错过 dsh-desktop-tauriapp 装载完成前那几条启动日志，
 * 那些日志对前端 bug 定位价值不高）。
 */
function installWebviewConsoleMirror(): void {
  // 壳 RPC 统一通道（#50）：官方桥/中继/同源 fetch 三选一，均不通则 no-op（保留原 console 行为）。
  const invoke = (cmd: CommandName, args: unknown): void => {
    void shellRpc.invoke(cmd, args as Record<string, unknown>).catch(() => {})
  }
  // 攒批上报（#54 数据面聚合）：多条 console 合并成一次 RPC（log_console_batch），壳侧
  // 逐条落盘路径不变；旧壳没有批量命令时（reject）自动退回逐条 log_console。
  let batchSupported = true
  const consoleBatch = createConsoleBatch({
    send: (items) => {
      const send = (cmd: CommandName, args: unknown): Promise<void> | null => {
        // #50 合并 #54：探测换壳 RPC 统一通道（Tauri shim 已删，旧探测永远拿不到）
        if (!shellRpc.available()) return null
        return shellRpc.invoke(cmd, args as Record<string, unknown>)
      }
      const batched = batchSupported ? send('log_console_batch', { items }) : null
      if (batched !== null) {
        batched.then(
          () => {},
          () => {
            // 旧壳没有 log_console_batch：本次与之后的批次都退回单条通道
            batchSupported = false
            for (const item of items) invoke('log_console', item)
          },
        )
        return
      }
      for (const item of items) invoke('log_console', item)
    },
  })
  const fwd = (level: string, args: unknown[]): void => {
    try {
      const msg = args
        .map((a) => {
          // JSC（WKWebView）的 err.stack 只有栈帧（func@url:line:col），不带 message——必须单独
          // 带上 message，否则页面侧抛出的错误在日志里只剩两行栈帧、丢掉唯一的原因文本（#188 实测）。
          if (a instanceof Error) return a.stack ? `${a.message}\n${a.stack}` : a.message
          if (typeof a === 'object') {
            try { return JSON.stringify(a) } catch { return String(a) }
          }
          return String(a)
        })
        .join(' ')
      const url = (typeof location !== 'undefined' && location.href) || '?'
      consoleBatch.push({ level, msg, pageUrl: url })
    } catch {
      // 镜像失败不影响原 console 行为
    }
  }
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const
  for (const lvl of levels) {
    const orig = console[lvl].bind(console)
    console[lvl] = (...a: unknown[]) => {
      fwd(lvl, a)
      orig.apply(console, a as never)
    }
  }
  window.addEventListener('error', (e) => {
    // 同上：onerror 事件的 error 也要 message + stack 一起报，否则只剩栈帧。
    const err = e.error as Error | undefined
    const text = err?.message
      ? `${err.message}${err.stack ? `\n${err.stack}` : ''}`
      : err?.stack || e.message || 'Uncaught error'
    fwd('error', [text])
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | undefined
    fwd('error', [`Unhandled rejection: ${r?.message || String(e.reason)}`, r?.stack || ''])
  })
}

/**
 * 桌面壳 WebView 与浏览器行为对齐：macOS WKWebView 默认开启橡皮筋滚动
 * （rubber-band bounce）——页面内容未超出视口时仍能轻微拖动并自动回弹，
 * 露出 viewport 外的空白；浏览器没有该行为。用 `overscroll-behavior: none`
 * 禁用（Safari/WKWebView 16+ 支持；普通浏览器无副作用，只是禁掉"过度滚动"，
 * 正常滚动不受影响）。
 */
function installNoRubberBand(): void {
  try {
    const style = document.createElement('style')
    style.dataset.dshDesktopNoBounce = '1'
    style.textContent =
      'html{overscroll-behavior:none;-webkit-overflow-scrolling:touch;} body{overscroll-behavior:none;}'
    ;(document.head || document.documentElement).appendChild(style)
  } catch {
    /* noop */
  }
}

/**
 * 桌面壳 client 入口：仅在桌面 shell 的 webview URL 携带
 * `dsh-desktop-tauriapp-platform=<platform>` 时激活高级布局。
 * 普通浏览器访问（无 query 标记）时不做任何改动。
 * @param ctx - browser Cordis context.
 */
export function apply(ctx: ClientContext): void {
  // cordis 把 apply 抛出的异常记成 entry 的 failed 状态，而 dsh 的 boot 校验只打印
  // 「<名字>: failed」、不打印原因——所以这里逐步标注，抛出前先把原因写进控制台。
  let step = '未开始'
  try {
    step = 'console 镜像'
    // 最早装：把 console.* 镜像到 ~/.dsh/dsh-desktop-webview.log（开发期排查前端 bug 必备）。
    // 即使非 advanced 模式（普通浏览器直访 dsh）也装，便于离线调试。
    installWebviewConsoleMirror()
    step = '橡皮筋滚动'
    installNoRubberBand()
    step = '输入框控制字符守护'
    // 输入框控制字符守护（#188）：capture 阶段拦下带控制字符的 beforeinput。
    installComposerInputGuard()
    step = '下载管理器 tab'
    // 下载管理器（#72）：右侧边栏 tab + header 按钮（无 sidebarRightTabs 服务时静默不注册）
    registerDownloadsTab(ctx)
    step = '下载拦截'
    // blob:/data: 下载拦截转 IPC（纯浏览器不装）
    installDownloadInterceptor()
    step = '浏览器 guest 桥'
    // 侧边栏浏览器 guest 桥（#118/#134）：仅壳内本地窗口（dshDesktop 标记存在）安装，
    // 纯浏览器无副作用
    installDesktopBrowserBridge()
    step = '桌面档快捷键桥'
    // 桌面档（desktop:<os>）快捷键桥（#187）：把 dsh 的 desktop 档键盘输入与 keybindings
    // 偏好接到壳上；只在壳注入了 dshDesktop.keyboard 的本地窗口生效（远程/纯浏览器不装）
    installDesktopPlatformBridge(ctx)
    step = '桌面设置 tab'
    registerDesktopSettings(ctx)
    step = '通知设置 tab'
    // 桌面通知设置 tab（#142）：权限卡/总开关/免打扰/12 场景开关与音效
    registerNotificationsTab(ctx)
    step = '高级布局'
    // 桌面 chrome 激活条件 = 壳经 IPC 下发的环境为 advanced。
    // 不再用 URL 标记：token 交换的 303 会剥掉 query，标记无法与 token 同跳；
    // 平台本就是壳的运行状态，由壳下发。纯浏览器无 IPC → 不激活（原语义不变）。
    void requestDesktopClientEnvironment()
      .then((environment) => {
        if (environment !== undefined) applyAdvancedShell(ctx, environment)
      })
      .catch(() => {})
  } catch (error) {
    console.error(`[dsh-desktop-tauriapp] 插件激活失败于「${step}」`, error)
    throw error
  }
}
