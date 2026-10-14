// #69 开发者工具开关的纯逻辑（UI 无关，node scripts/test-client.mjs 用 esbuild 转译后断言）：
// 开关状态机（要不要确认弹窗 / 要不要直接保存）+ 确认弹窗文案 + 保存后提示。
// 安全面口径：开启 = 桌面壳在本机回环地址监听一个 CEF 远程调试口，本机任意进程可借它
// 在页面里执行代码、读取会话内容（含登录凭据）——所以「开」必须先过确认弹窗，「关」不过。

export interface DevToolsUiPlan {
  /**
   * idle：状态没变，什么都不做。
   * confirm-on：关→开，弹安全确认（取消不写入）。
   * confirm-off：开→关，弹关闭确认——两个方向都要重启桌面壳（页面短暂中断），都不该静默发生。
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
      '开启后，桌面壳会在本机回环地址监听一个远程调试口，右键菜单出现「打开 DevTools」。',
      '本机上的任何程序都能借这个口在页面里执行任意代码、读取会话内容（含登录凭据）。',
      '只在自己需要排查问题时开启；用完在设置里关掉并重启桌面壳。',
    ],
    confirm: '确认开启并重启',
    cancel: '取消',
  }
}
/** 关闭确认文案：重启会短暂中断页面，让用户知情后再动手。 */
export function devToolsDisableCopy(): DevToolsConfirmCopy {
  return {
    title: '关闭开发者工具？',
    lines: [
      '确认后桌面壳将重启：远程调试口关闭、右键菜单「打开 DevTools」消失。',
      '重启期间页面会短暂中断。',
    ],
    confirm: '确认关闭并重启',
    cancel: '取消',
  }
}

/** 保存成功后的提示：两个方向都要重启桌面壳才生效。 */
export function devToolsSavedNote(on: boolean): string {
  return on
    ? '已开启：正在重启桌面壳，重启后调试口与右键菜单「打开 DevTools」生效。'
    : '已关闭：正在重启桌面壳，重启后调试口关闭、菜单消失。'
}
