import type { ClientContext } from '../bridge/ctx-types.ts'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { DesktopClientEnvironment } from '../features/environment.ts'
import { installLocalChrome } from '../bridge/local-chrome.ts'
import { installAdvancedStyles } from '../ui/styles.ts'

/**
 * 高级模式：不禁用 stock ui-layout、不接管 root、不提供 layout 服务，只在
 * 原生布局的局部注入窗口拖拽 chrome（macOS 侧栏顶部拖拽 + 折叠加宽容纳红绿灯；
 * Win/Linux 中间 header 顶部拖拽条 + 自绘窗口按钮，内容用 padding 顶下）。
 */
export function applyAdvancedShell(ctx: ClientContext, environment: DesktopClientEnvironment): void {

  ctx.effect(() => {
    document.body.dataset.dshDesktopPlatform = environment.platform
    // 官方桌面契约：html[data-platform]（旧 Tauri 壳即设，Electrobun 迁移时丢失，#23）
    document.documentElement.dataset.platform = environment.platform
    const removeStyles = installAdvancedStyles()
    return () => {
      removeStyles()
      delete document.body.dataset.dshDesktopPlatform
      delete document.documentElement.dataset.platform
    }
  }, 'desktop: advanced shell styles')

  ctx.effect(() => installLocalChrome(environment.platform), 'desktop: local window chrome')
}
