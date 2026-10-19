/**
 * 诊断、日志与窗口杂项命令（contract 中间层）。
 * 页面控制台镜像 / 诊断快照 / boot 包 / 右键菜单 / 外链与关窗。
 */

export interface DiagnosticsCommands {
  /** 页面控制台一条（客户端契约 {level,msg,pageUrl}；壳写 webview 日志，warn/error 另镜像壳日志）。 */
  log_console: {
    args: { level?: string; msg?: string; pageUrl?: string }
    result: { }
  }

  /** #54 批量版：client 攒批后一次调用；旧壳没有批量命令时客户端自动退回单条。 */
  log_console_batch: {
    args: { items?: Array<{ level?: string; msg?: string; pageUrl?: string }> }
    result: { count: number }
  }

  log_diag: {
    args: { msg?: string }
    result: { }
  }

  /** #220「日志与诊断」：一个 JSON 回答哪版、哪个 profile、端口/pid、日志在哪。 */
  get_diagnostics: {
    args: {}
    result: { diagnostics: Record<string, unknown> }
  }

  export_diagnostics: {
    args: {}
    result: { path: string; bytes: number }
  }

  /** #128 页面注入脚本的 boot 包（宿主未就绪时壳抛 'boot pending'）。 */
  get_boot_payload: {
    args: {}
    result: { injections: unknown[]; streamBaseUrl: string }
  }

  /** #130 页面右键菜单（字段归一化只有一份实现，壳不再叠第二层鉴权）。 */
  show_context_menu: {
    args: {
      linkUrl?: string
      hasSelection?: boolean
      editable?: boolean
      filesEntry?: 'file' | 'directory' | 'other'
      filesPath?: string
    }
    result: { }
  }

  /** 外链：壳过 isOpenableUrl 闸（javascript:/file: 不放行，壳内 origin 链接除外）。 */
  open_external: {
    args: { url: string }
    result: { }
  }

  close_current_window: { args: {}; result: { } }

  /** 副窗语义与 close_current_window 同槽（旧壳命令名对齐保留）。 */
  exit_window_instance: { args: {}; result: { } }
}
