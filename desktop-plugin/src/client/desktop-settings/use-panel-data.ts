// 面板数据的 React 接口（#182）：useSyncExternalStore 把 panel-data.ts 的 store 接进组件树。
// store 的全部行为（拉取/合并/轮询/订阅）都在 panel-data.ts；这里只剩挂载编排：
//   · 每次挂载建一个新 store 实例（与原「挂载级 state」生命周期一致：切 tab 回来重新拉取）；
//   · 首拉一次 + 启动任务轮询，卸载时停表并弃单；
//   · #175：onLoadError 往往是内联箭头（每次渲染换身份），用 ref 固定最新回调，
//     挂载 effect 不依赖它——否则会变成「渲染 → 重拉 → 重渲染」的无限循环。
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { createPanelData, type PanelSnapshot } from './panel-data.ts'
import type { TaskSnapshot } from '../../../../contracts/index.ts'

export interface PanelView {
  data: PanelSnapshot
  /** 挂载首拉的结果，**引用此后不再变**。卡片要「只回填一次」的初值时用它，别拿 `data`。 */
  loaded: PanelSnapshot | null
  /** 长任务卡（新建/迁移/依赖重建共用）：600ms 轮询，谁在跑就显示谁。 */
  taskInfo: TaskSnapshot | null
  /** 重新读一次壳的设置数据（增删远程地址后用；不重读 ns 段，与旧行为一致）。 */
  refreshData: () => Promise<void>
}

export function usePanelData(onLoadError: (text: string) => void): PanelView {
  const panel = useMemo(() => createPanelData(), [])
  const state = useSyncExternalStore(panel.subscribe, panel.getState)

  const onErrorRef = useRef(onLoadError)
  onErrorRef.current = onLoadError

  useEffect(() => {
    void panel.loadAll((text) => onErrorRef.current(text))
    panel.startTaskPolling()
    return () => {
      panel.stopTaskPolling()
      panel.dispose()
    }
  }, [panel])

  return { data: state.snapshot, loaded: state.loaded, taskInfo: state.task, refreshData: panel.refreshDesktop }
}
