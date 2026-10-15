import type { DesktopClientPlatform } from './environment.ts'
import { sendWindowAction, shellRpc } from './shell-rpc.ts'

/** 各平台自绘条高度（CSS px）。 */
const STRIP_HEIGHT: Record<DesktopClientPlatform, number> = {
  darwin: 28,
  win32: 32,
  linux: 32,
}

/** macOS 折叠态拖拽带宽度：只铺红绿灯区（官方 shell.leading 座位按钮在 x≈88 起，#23）。 */
const TRAFFIC_LIGHT_BAND = 76

/** Win/Linux 自绘窗口按钮预留宽度（CSS px）。 */
const CAPTION_CONTROLS_WIDTH = 138

/** ui-layout 原生 frame 的 overlay 层稳定标记（AppFrame 固定渲染 data-shell-overlay）。 */
const FRAME_LAYER_SELECTOR = '[data-shell-overlay]'


/** 自绘窗口三键：官方 RPC 优先，兜底 /__shell__/window（shell-rpc.ts）；失败可见，不再静默吞。 */
function runWindowAction(action: 'minimize' | 'toggle-maximize' | 'close'): void {
  sendWindowAction(action).catch((error) => console.error('[dsh-desktop] window action failed', error))
}

export const maximizeIconSvg = (maximized: boolean): string =>
  maximized
    ? '<rect x="1.5" y="4.5" width="7" height="6" stroke="currentColor" strokeWidth="1" fill="none" /><path d="M3.5 4.5V2.5H10.5V9H8.5" stroke="currentColor" strokeWidth="1" fill="none" />'
    : '<rect x="1.5" y="1.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />'

/** 官方 RPC 报告的最大化态 → 换最大化/还原图标（几何推导在壳侧 window-max.ts，按钮不存在则无操作）。 */
function syncMaximizeIcon(): void {
  const button = document.querySelector<HTMLButtonElement>('.dshDesktopCaptionButton-maximize')
  if (button === null) return
  shellRpc
    .invoke<{ maximized: boolean }>('window_get_state', undefined, { timeoutMs: 5000 })
    .then((state) => {
      button.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true">${maximizeIconSvg(state.maximized)}</svg>`
      button.setAttribute('aria-label', state.maximized ? '还原' : '最大化')
    })
    .catch(() => undefined)
}
function makeCaptionButton(aria: string, extraClass: string, svgPath: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `dshDesktopCaptionButton${extraClass ? ` ${extraClass}` : ''}`
  button.setAttribute('aria-label', aria)
  button.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true">${svgPath}</svg>`
  return button
}

/** Win/Linux 自绘窗口按钮：最小化 / 最大化 / 关闭。 */
function buildWindowControls(platform: DesktopClientPlatform): HTMLElement {
  const box = document.createElement('div')
  box.className = 'dshDesktopWindowControls'
  box.appendChild(makeCaptionButton('最小化', '', '<path d="M1 6h10" stroke="currentColor" strokeWidth="1" fill="none" />'))
  box.appendChild(makeCaptionButton('最大化', 'dshDesktopCaptionButton-maximize', maximizeIconSvg(false)))
  box.appendChild(makeCaptionButton('关闭', 'dshDesktopCaptionButton-close', '<path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1" />'))
  box.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button')
    const action = button?.getAttribute('aria-label')
    if (action === '最小化') runWindowAction('minimize')
    else if (action === '最大化' || action === '还原') {
      runWindowAction('toggle-maximize')
      syncMaximizeIcon()
    }
    else if (action === '关闭') runWindowAction('close')
  })
  // 初次尝试同步 + 窗口尺寸变化（含贴靠/手动最大化）后重同步（去抖 200ms，#50 验证反馈）
  if (platform !== 'darwin') {
    syncMaximizeIcon()
    // 壳侧主动推的窗口状态变化（#73：启动恢复最大化后 dom-ready 补 maximize，页面无从感知）：
    // 消息是触发器，收到就重查真值。先挂监听再首查——接管前抵达的推送由框架 preload
    // 攒在 __electrobunPendingHostMessages，首查（ensureReceive）时排空分发。
    shellRpc.onMessage((name) => {
      if (name === 'window_state_changed') syncMaximizeIcon()
    })
    let resizeTimer = 0
    window.addEventListener('resize', () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(syncMaximizeIcon, 200)
    })
    // 隐藏后找回（托盘 show）与首布局即最大化的启动场景都没有 resize 事件：焦点/可见性一变就重查
    window.addEventListener('focus', () => syncMaximizeIcon())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncMaximizeIcon()
    })
  }
  return box
}

/** 定位标准布局的 AppFrame（overlay 层的父节点）与三列。children 顺序：sidebar / center / rightbar / overlay … */
function locateLayout(): { frame: HTMLElement; sidebar: HTMLElement; center: HTMLElement | null; rightColumn: HTMLElement | null } | null {
  const layer = document.querySelector(FRAME_LAYER_SELECTOR)
  const frame = layer?.parentElement
  if (frame === null || frame === undefined) return null
  const children = Array.from(frame.children).filter((el): el is HTMLElement => el instanceof HTMLElement)
  return { frame, sidebar: children[0] ?? frame, center: children[1] ?? null, rightColumn: children[2] ?? null }
}

/**
 * 高级模式局部窗口 chrome。
 *
 * 不动 ui-layout（不禁用、不接管 root、不提供 layout 服务），只在原生布局的
 * 局部放拖拽区与自绘窗口按钮：
 * - darwin：sidebar 顶部一条拖拽区（透明），并把 sidebar 内容下移对应高度；
 *   折叠时把侧栏网格轨道加宽到 90px（红绿灯始终在侧栏内），内部 56px 窄栏水平居中，
 *   并禁用 frame 的慢速网格过渡（避免我们的覆盖与过渡互相重启导致折叠卡慢）；
 * - win32/linux：中间区域顶部一条自绘条（左侧拖拽区 + 右侧窗口按钮），
 *   中间列内容用 padding 顶下去，防止重叠。
 *
 * 挂点范式照搬 better-sidebar：往 document.body 追加 fixed host，子元素绝对定位；
 * frame / 三列用 ui-layout 的稳定标记定位（不依赖 hash 类名）。
 */
export function installLocalChrome(platform: DesktopClientPlatform): () => void {
  const height = STRIP_HEIGHT[platform]

  const host = document.createElement('div')
  host.className = 'dshDesktopChromeHost'
  const strip = document.createElement('div')
  strip.className = 'dshDesktopChromeStrip'
  const drag = document.createElement('div')
  drag.className = 'dshDesktopChromeDrag'
  // Electrobun 的拖拽区是 CSS 驱动（preload/dragRegions）：类名挂上才能原生拖动（macOS/Windows 同）
  drag.classList.add('electrobun-webkit-app-region-drag')
  // 拖拽区双击 = 最大化切换（原生层不合成 WM_NCLBUTTONDBLCLK；macOS 走系统红绿灯，不需要）
  if (platform !== 'darwin') drag.addEventListener('dblclick', () => runWindowAction('toggle-maximize'))
  strip.appendChild(drag)
  if (platform !== 'darwin') strip.appendChild(buildWindowControls(platform))
  host.appendChild(strip)
  document.body.appendChild(host)

  /** 底部状态条高度（sidebar 内容用 padding-bottom 让出一整行）。 */
  const STATUS_BAR_HEIGHT = 24

  const STATUS_TEXT: Record<number, string> = {
    0: '初始化', 1: '启动中', 2: '运行中', 3: '复用外部实例', 4: '重启中',
    5: '服务异常', 6: '服务下线', 7: '远程',
  }
  const STATUS_COLOR: Record<number, string> = {
    0: '#9ca3af', 1: '#f59e0b', 2: '#22c55e', 3: '#22c55e',
    4: '#f59e0b', 5: '#ef4444', 6: '#ef4444', 7: '#3b82f6',
  }


  let raf = 0
  let attempts = 0
  let mountTimer = 0
  let statusTimer = 0
  let currentStatus = -1
  let exitMode: '' | 'hover' = ''
  let resizeObserver: ResizeObserver | null = null
  let mutationObserver: MutationObserver | null = null

  // 底部状态条：sidebar 独占一整行（仅展示状态，不做点击重启——重启走托盘）
  const bar = document.createElement('div')
  bar.className = 'dshDesktopStatusBar'
  bar.innerHTML = '<span class="dshDesktopStatusDot" aria-hidden="true"></span><span class="dshDesktopStatusText"></span>'
  host.appendChild(bar)


  const refreshStatus = () => {
    if (!shellRpc.available()) return
    void shellRpc.invoke('get_dsh_status', {})
      .then((value) => {
        const s = (value as { status?: number }).status
        if (typeof s !== 'number') return
        currentStatus = s
        if (exitMode !== '') return // 退出交互态：不覆盖按钮/文案
        const dot = bar.querySelector('.dshDesktopStatusDot') as HTMLElement | null
        const text = bar.querySelector('.dshDesktopStatusText') as HTMLElement | null
        const label = STATUS_TEXT[s] ?? `状态 ${s}`
        if (dot !== null) dot.style.background = STATUS_COLOR[s] ?? '#9ca3af'
        if (text !== null) text.textContent = label
        bar.title = `dsh：${label}`
      })
      .catch(() => {})
  }

  // #180 反馈定稿：点击后弹独立确认弹窗（不在状态条内继续选择）；失败信息可见。
  const setExitMode = (mode: '' | 'hover') => {
    exitMode = mode
    const text = bar.querySelector('.dshDesktopStatusText') as HTMLElement | null
    if (mode === '') {
      delete bar.dataset.dshExitMode
      if (text !== null) text.textContent = STATUS_TEXT[currentStatus] ?? `状态 ${currentStatus}`
      bar.title = `dsh：${STATUS_TEXT[currentStatus] ?? ''}`
      refreshStatus()
      return
    }
    bar.dataset.dshExitMode = 'hover'
    if (text !== null) text.textContent = '退出'
    bar.title = '完全退出本窗口（关闭窗口 + 停止实例）'
  }

  const openExitConfirm = () => {
    document.getElementById('dshDesktopExitConfirm')?.remove()
    const overlay = document.createElement('div')
    overlay.id = 'dshDesktopExitConfirm'
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;'
    const card = document.createElement('div')
    card.style.cssText =
      'background:var(--dsw-alias-bg-layer-1,#1e1e1e);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:12px;padding:18px 20px;min-width:320px;max-width:80vw;box-shadow:0 12px 40px rgba(0,0,0,0.4);color:var(--dsw-alias-label-primary,#eee);'
    const titleEl = document.createElement('div')
    titleEl.textContent = '完全退出本窗口'
    titleEl.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:10px;'
    const bodyEl = document.createElement('div')
    bodyEl.textContent = '将关闭本窗口并停止其 dsh 实例（运行中的会话进程一并停止）。确认继续？'
    bodyEl.style.cssText = 'font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#bbb);'
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;'
    const close = () => {
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      setExitMode('')
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const mkBtn = (label: string, primary: boolean) => {
      const btn = document.createElement('button')
      btn.textContent = label
      btn.style.cssText = primary
        ? 'padding:6px 14px;border-radius:8px;border:none;background:#dc2626;color:#fff;font-size:13px;cursor:default;'
        : 'padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#444);background:transparent;color:var(--dsw-alias-label-primary,#eee);font-size:13px;cursor:default;'
      btn.addEventListener('click', () => {
        if (!primary) {
          close()
          return
        }
        if (!shellRpc.available()) {
          close()
          return
        }
        btn.disabled = true
        void shellRpc.invoke('exit_window_instance', {})
          .then(() => close())
          .catch((err) => {
            // #180 反馈：失败必须可见（此前静默恢复导致「没退出」无从排查）
            bodyEl.textContent = `退出失败：${String(err)}`
            bodyEl.style.color = '#ef4444'
            btn.disabled = false
          })
      })
      return btn
    }
    row.appendChild(mkBtn('取消', false))
    row.appendChild(mkBtn('确认退出', true))
    card.appendChild(titleEl)
    card.appendChild(bodyEl)
    card.appendChild(row)
    overlay.appendChild(card)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close()
    })
    document.addEventListener('keydown', onKey)
    document.body.appendChild(overlay)
  }
  bar.addEventListener('mouseenter', () => {
    if (currentStatus === 2 && exitMode === '') setExitMode('hover')
  })
  bar.addEventListener('mouseleave', () => {
    if (exitMode === 'hover') setExitMode('')
  })
  bar.addEventListener('click', () => {
    if (exitMode !== 'hover' || currentStatus !== 2) return
    openExitConfirm()
  })
  refreshStatus()
  statusTimer = window.setInterval(refreshStatus, 5000)

  const schedule = () => {
    if (raf !== 0) return
    raf = requestAnimationFrame(() => {
      raf = 0
      sync()
    })
  }

  /**
   * 侧边栏宽度修复（浏览器元素定位实证）：`div[data-slot="sidebar"]` 下第一个 div
   * （.hHd-Xa_root）带内联 `flex-wrap: wrap; width: 420px`——flex-wrap 让超长标题
   * 折行并把整段撑宽到 420px，超过外层侧边栏宽度被裁断（勾掉 flex-wrap 即正常）。
   * 主修复：定位 [data-slot="sidebar"] 的 first-child → flex-wrap:nowrap（消除折行
   * 撑宽），叠加 width/max-width 锁（内容死盯外层宽度，外层可拖拽跟随）、
   * overflow-x:auto 兜底（个别元素不收缩时出横向滚动条）；子树铺 min-width:0
   * 让标题回到 ellipsis。打稳定标记 + 内联样式，dispose 时全部还原。
   */
  const SIDEBAR_SCROLL_MARK = 'data-dsh-desktop-scroll'
  let scrollRegion: HTMLElement | null = null
  let scrollRoot: HTMLElement | null = null
  const minWidthPatched: HTMLElement[] = []
  const overflowXPatched: HTMLElement[] = []
  const isScrollableY = (el: HTMLElement): boolean => {
    const oy = getComputedStyle(el).overflowY
    return oy === 'auto' || oy === 'scroll'
  }
  const ensureSidebarScroll = (sidebar: HTMLElement): void => {
    // 【定位】优先稳定 slot 标记 [data-slot="sidebar"] 的 first-child（.hHd-Xa_root）；
    // 兜底结构定位（sidebar 列的第一子元素）。
    let root: HTMLElement | null = null
    const slot = document.querySelector('[data-slot="sidebar"]')
    if (slot !== null) {
      root = Array.from(slot.children).find((el): el is HTMLElement => el instanceof HTMLElement) ?? null
    }
    if (root === null) {
      root = Array.from(sidebar.children).find((el): el is HTMLElement => el instanceof HTMLElement) ?? null
    }
    if (root === null) return
    // 【主修复】flex-wrap:wrap → nowrap（用户实证根因）；宽度锁到外层；overflow-x 兜底
    root.style.flexWrap = 'nowrap'
    root.style.width = '100%'
    root.style.maxWidth = '100%'
    root.style.minWidth = '0'
    root.style.overflowX = 'auto'
    scrollRoot = root
    // region = SidebarRoot 里 flex:1 的内容区（logoRow/newSession/footArea 均 flex:none）
    const region = Array.from(root.children).find((el): el is HTMLElement => {
      return el instanceof HTMLElement && getComputedStyle(el).flexGrow === '1'
    })
    if (region === undefined) return
    scrollRegion = region
    // 【辅修复】收缩链：子树所有 flex 容器铺 min-width:0；纵向滚动容器补 overflow-x:auto
    minWidthPatched.length = 0
    const visit = (el: HTMLElement): void => {
      const style = getComputedStyle(el)
      if (style.display.includes('flex')) {
        el.style.minWidth = '0'
        minWidthPatched.push(el)
      }
      if (isScrollableY(el)) {
        el.style.overflowX = 'auto'
        overflowXPatched.push(el)
      }
      for (const child of el.children) {
        if (child instanceof HTMLElement) visit(child)
      }
    }
    for (const child of Array.from(region.children)) {
      if (child instanceof HTMLElement) visit(child)
    }
    if (root.getAttribute(SIDEBAR_SCROLL_MARK) === null) {
      root.setAttribute(SIDEBAR_SCROLL_MARK, '')
    }
  }

  const sync = () => {
    const layout = locateLayout()
    if (layout === null) {
      // ui-layout 尚未挂载：重试有限次数，避免空转
      if (attempts++ < 1200) schedule()
      return
    }
    attempts = 0
    const { frame, sidebar, center, rightColumn } = layout
    ensureSidebarScroll(sidebar)
    const sidebarWidth = sidebar.offsetWidth
    // 底部状态条：内容行让出一整行（所有平台），状态条覆盖其上
    sidebar.style.paddingBottom = `${STATUS_BAR_HEIGHT}px`
    bar.style.cssText = `left:0;bottom:0;width:${sidebarWidth}px;height:${STATUS_BAR_HEIGHT}px;`

    if (platform === 'darwin') {
      const collapsed = frame.hasAttribute('data-sidebar-collapsed')
      // 高级模式禁掉 stock 的慢速网格过渡：我们的 important 覆盖若与过渡并行，
      // 每帧读「动画中间值」写回都会让 CSS 过渡重新开始，折叠会形同卡帧、非常慢。
      // 直接禁用让宽度即时到位（对应 stock 拖拽时本来就 transition:none 的行为）。
      frame.style.setProperty('transition', 'none', 'important')
      if (collapsed) {
        // 官方桌面语义（html[data-platform='darwin']，advanced-shell 设置）：折叠=0px
        // 全隐 + shell.leading 座位放官方「打开侧边栏/新会话」按钮（红绿灯旁 x≈88 起）。
        // 拖拽带只铺红绿灯区（TRAFFIC_LIGHT_BAND），不遮座位按钮；状态条按维护者
        // 拍板随侧栏隐藏（#23 Q1）。
        strip.style.cssText = `left:0;top:0;width:${TRAFFIC_LIGHT_BAND}px;height:${height}px;background:transparent;`
        drag.style.cssText = 'position:absolute;inset:0;'
        sidebar.style.paddingTop = ''
        bar.style.display = 'none'
      } else {
        // 官方桌面口径：拖拽带全透明、只铺红绿灯区（76px）——红绿灯浮在侧栏
        // header 左侧空白区（折叠按钮在右侧，不受遮挡）；透明条带与任何主题
        // 表面同色（同像素透出），色差从结构上不可能发生（#23）。
        strip.style.cssText = `left:0;top:0;width:${TRAFFIC_LIGHT_BAND}px;height:${height}px;`
        drag.style.cssText = 'position:absolute;inset:0;'
        bar.style.display = ''
      }
    } else {
      // 布局对齐旧壳（维护者口径）：Windows/Linux 中间列顶部保留一整条 chrome 条
      //（拖拽区 + 右侧窗口三键），中间列内容用 padding 顶下去，右侧 panel 覆写 top。
      strip.style.cssText = `left:${sidebarWidth}px;right:0;top:0;height:${height}px;`
      drag.style.cssText = `position:absolute;top:0;bottom:0;left:0;right:${CAPTION_CONTROLS_WIDTH}px;`
      if (center !== null) center.style.paddingTop = `${height}px`
      const rightPanel = rightColumn?.querySelector('[data-sidebar-right-panel]')
      if (rightPanel !== null) (rightPanel as HTMLElement).style.top = `${height}px`
    }
  }

  try {
    resizeObserver = new ResizeObserver(schedule)
    mutationObserver = new MutationObserver(schedule)
  } catch {
    resizeObserver = null
    mutationObserver = null
  }

  /** frame 出现后挂上观察器（幂等），返回是否已就位。 */
  const attachObservers = (): boolean => {
    const layout = locateLayout()
    if (layout === null) return false
    if (resizeObserver !== null) {
      resizeObserver.observe(layout.frame)
      resizeObserver.observe(layout.sidebar)
      if (layout.center !== null) resizeObserver.observe(layout.center)
      if (layout.rightColumn !== null) resizeObserver.observe(layout.rightColumn)
    }
    if (mutationObserver !== null) {
      mutationObserver.observe(layout.frame, {
        attributes: true,
        attributeFilter: ['data-sidebar-collapsed', 'data-details-collapsed', 'style'],
      })
      // 右侧 Sidebar 切换会话时 React 销毁重建 panel DOM，新节点丢失 inline top。
      // 监听 rightColumn 子树 childList 变化，panel 被替换后重跑 sync 补回 top（#62）。
      if (layout.rightColumn !== null) {
        mutationObserver.observe(layout.rightColumn, { childList: true, subtree: true })
      }
    }
    return true
  }

  if (!attachObservers()) {
    // frame 挂在 React 布局里，可能晚于本插件 client；轮询直到出现
    mountTimer = window.setInterval(() => {
      if (attachObservers()) {
        window.clearInterval(mountTimer)
        sync()
      }
    }, 250)
  }
  sync()

  return () => {
    if (raf !== 0) cancelAnimationFrame(raf)
    if (mountTimer !== 0) window.clearInterval(mountTimer)
    if (statusTimer !== 0) window.clearInterval(statusTimer)
    resizeObserver?.disconnect()
    mutationObserver?.disconnect()
    const found = locateLayout()
    if (found !== null) {
      found.sidebar.style.paddingTop = ''
      found.sidebar.style.paddingBottom = ''
      // 折叠加宽区残留一并清理（#37）：列内联背景、左右 padding 与 border-right，
      // 以及 frame 上的 transition / grid-template-columns important 覆盖，
      // HMR/停用后不留痕。
      found.sidebar.style.paddingLeft = ''
      found.sidebar.style.paddingRight = ''
      found.sidebar.style.removeProperty('border-right')
      found.frame.style.removeProperty('transition')
      found.frame.style.removeProperty('grid-template-columns')
      if (found.center !== null) found.center.style.paddingTop = ''
      const rightPanel = found.rightColumn?.querySelector('[data-sidebar-right-panel]')
      if (rightPanel !== null) (rightPanel as HTMLElement).style.top = ''
    }
    // 还原侧边栏宽度修复（HMR/停用后不留内联样式与标记）
    for (const el of minWidthPatched) el.style.minWidth = ''
    for (const el of overflowXPatched) el.style.overflowX = ''
    minWidthPatched.length = 0
    overflowXPatched.length = 0
    if (scrollRoot !== null) {
      scrollRoot.style.flexWrap = ''
      scrollRoot.style.width = ''
      scrollRoot.style.maxWidth = ''
      scrollRoot.style.minWidth = ''
      scrollRoot.style.overflowX = ''
      scrollRoot.removeAttribute(SIDEBAR_SCROLL_MARK)
      scrollRoot = null
    }
    if (scrollRegion !== null) {
      scrollRegion = null
    }
    host.remove()
  }
}
