// #69 开发者工具开关的纯逻辑（UI 无关，node scripts/test-client.mjs 用 esbuild 转译后断言）：
// 开关状态机（要不要确认弹窗 / 要不要直接保存）+ 确认弹窗文案 + 保存后提示。
// 安全面口径：开启 = 桌面壳在本机回环地址监听一个远程调试口（CEF 或 Windows WebView2 载体），本机任意进程可借它
// 在页面里执行代码、读取会话内容（含登录凭据）——所以「开」必须先过确认弹窗，「关」不过。

export interface DevToolsUiPlan {
  /**
   * idle：状态没变，什么都不做。
   * confirm-on：关→开，弹安全确认（取消不写入）。
   * confirm-off：开→关，弹关闭确认——两个方向都要重启桌面壳（整应用短暂退出再起来），都不该静默发生。
   */
  action: 'idle' | 'confirm-on' | 'confirm-off'
}

/** 开关状态机：同值不动；两个方向的变更都先弹确认，确认才写入并重启。 */
export function planDevToolsUi(current: boolean, next: boolean): DevToolsUiPlan {
  if (current === next) return { action: 'idle' }
  return { action: next ? 'confirm-on' : 'confirm-off' }
}

export interface DevToolsConfirmCopy {
  title: string
  lines: string[]
  confirm: string
  cancel: string
}

/** 确认弹窗文案（安全面：说清口开在哪、谁能用它、能造成什么）。 */
export function devToolsConfirmCopy(): DevToolsConfirmCopy {
  return {
    title: '开启开发者工具？',
    lines: [
      '开启后，桌面壳会在本机回环地址监听一个远程调试口；Windows 下按 F12 或右键菜单「打开 DevTools」打开（与物理按键同路径），不会自动弹窗。',
      '本机上的任何程序都能借这个口在页面里执行任意代码、读取会话内容（含登录凭据）。',
      '只在自己需要排查问题时开启；用完在设置里关掉。',
    ],
    confirm: '确认开启并重启',
    cancel: '取消',
  }
}
/** 关闭确认文案：重启会让**整应用**短暂退出再起来（#119 B），让用户知情后再动手。 */
export function devToolsDisableCopy(): DevToolsConfirmCopy {
  return {
    title: '关闭开发者工具？',
    lines: [
      '确认后桌面壳将重启：远程调试口关闭、右键 DevTools 入口消失。',
      '重启期间应用会短暂退出再起来，页面短暂中断；托盘会跟着消失几秒。',
    ],
    confirm: '确认关闭并重启',
    cancel: '取消',
  }
}

/** 壳的 `restart_desktop_app` 回包：拉起失败时带原因（#119 B）。 */
export interface DevToolsRestartOutcome {
  ok: boolean
  reason?: string
  message?: string
}

/**
 * 保存后的提示：**按实际结果说**，不预支「正在重启」。
 *
 * #119：以前无论壳重启没重启都写「正在重启桌面壳」——dev 态（`bun run dev`）根本拉不起壳，
 * 用户看到的是一句永远兑现不了的承诺。现在拉不起来就把壳给的原因原样透出（#119 拍板：
 * dev 态必须显式降级，禁止静默失败、禁止假装重启成功）。
 */
export function devToolsSavedNote(on: boolean, outcome?: DevToolsRestartOutcome | null): string {
  if (outcome !== undefined && outcome !== null && !outcome.ok) {
    return `设置已保存，但桌面壳没能自动重启：${outcome.message ?? outcome.reason ?? '未知原因'}设置已保存，调试口要等手动重启桌面壳后才生效。`
  }
  return on
    ? '已开启：正在重启桌面壳，重启后调试口与右键 DevTools 入口生效。'
    : '已关闭：正在重启桌面壳，重启后调试口关闭、菜单消失。'
}
