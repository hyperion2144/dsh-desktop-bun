/**
 * 运行时下载进度的百分比（纯逻辑）。
 *
 * 为什么要收在这里：面板（`desktop-plugin/…/runtime-download-ui.ts` 的轮询 effect）与提醒卡
 * （`update-notice-dialog.ts` 的内嵌脚本）都要这个数。面板那侧在 React 里就地算，提醒卡那侧
 * 只能渲染壳算好的值——两处各写一份公式，迟早一边改了另一边没改。所以公式只有这一份，
 * 壳算完经 `runtime_download_status` 递给页面，页面只负责画。
 *
 * 口径与面板一致（`desktop-settings.tsx` 的 `pct`）：`resolved > 0` 才算数，
 * `downloaded / resolved` 四舍五入并封顶 100——`resolved` 是「这棵要装多少个包」，
 * 没解析出来之前给百分比只会让进度条假动。
 */

/** `RuntimeDownloadStatus` 里算百分比要用的两个数（其余字段与判定无关）。 */
export interface RuntimeDownloadProgressLike {
  resolved: number
  downloaded: number
}

/** 下载进度百分比（0–100 的整数）。没解析出 resolved 时给 0。 */
export function downloadPercent(input: RuntimeDownloadProgressLike): number {
  if (!(input.resolved > 0)) return 0
  return Math.min(100, Math.max(0, Math.round((input.downloaded / input.resolved) * 100)))
}
