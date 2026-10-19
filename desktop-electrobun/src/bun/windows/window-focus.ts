/**
 * 窗口焦点记账（#115）。
 *
 * Electrobun 只给窗口 `focus` / `blur` 事件，没有 `isFocused()` 查询，`activate()` 也只是把窗口
 * 提到前台；而通知的「聚焦不打扰」必须知道「此刻哪个 profile 的窗口在前台」。所以焦点状态由壳自己
 * 记账：
 *   · 每份服务面按自己的 profile 问 `isFocused(profile)`（A 窗口聚焦时，B profile 的通知照投）；
 *   · 壳级通知（启动失败、服务健康、托盘提示）没有 profile 归属，问「当前记账的 profile 是否真在前台」
 *     （index.ts 的 `anyWindowInFront`：这里的记账 + 可见 / 最小化兜底）。
 *
 * 规则刻意容忍乱序 / 迟到的事件：
 *   · `focus(p)` 直接把当前置为 p：切窗口时 B 的 focus 可能先于 A 的 blur，迟到的 A-blur 不该抹掉 B；
 *   · `blur(p)` / `release(p)` 只在「当前正是 p」时清空：同名窗口重建或迟到的旧事件不会误伤新焦点。
 * `release` 与 `blur` 语义相同，单独留名是给「关窗 / 隐藏 / 最小化到托盘」这类**平台不一定发 blur**
 * 的路径用（宁可不打扰，也不要对着眼前的窗口弹通知）。
 *
 * 无窗口模式（CI 黑盒、未来可能的 headless）从不调用这些入口，于是恒为「没有窗口在前台」——
 * 与加这个能力之前的行为一致。
 */
export interface WindowFocusTracker {
  /** 窗口拿到焦点（`win.on('focus')`）。 */
  focus(profile: string): void
  /** 窗口失去焦点（`win.on('blur')`）。 */
  blur(profile: string): void
  /** 窗口关闭 / 隐藏 / 最小化到托盘：与 blur 同义，兜住不发 blur 的平台。 */
  release(profile: string): void
  /** 当前在前台的 profile；没有则 null。 */
  current(): string | null
  /** 这个 profile 的窗口是否在前台。 */
  isFocused(profile: string): boolean
}

export function createWindowFocusTracker(): WindowFocusTracker {
  let current: string | null = null
  const clearIf = (profile: string): void => {
    if (current === profile) current = null
  }
  return {
    focus: (profile) => {
      current = profile
    },
    blur: clearIf,
    release: clearIf,
    current: () => current,
    isFocused: (profile) => current === profile,
  }
}
