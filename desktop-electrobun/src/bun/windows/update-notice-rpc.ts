/**
 * 提醒卡动作的**通道**：官方 Electrobun Typed RPC 的原生桥（#139 实机修）。
 *
 * 同一座桥上还挂一个只读的 `runtime_download_status`：提醒卡点了「下载并切换」之后不能只显示
 * 「处理中…」（实机反馈：面板那种进度条才有用），而进度数是壳算好的——页面只负责画。
 * 原先这扇窗把动作 POST 到 `/__shell__/update-notice-op`，实机点「全部更新」直接
 * `TypeError: Failed to fetch`：窗是 `html:` 文档，origin 是 `views://internal`，
 * 相对 URL 解析到 views:// 协议（不是 HTTP），换成绝对 loopback URL 也会被准入的
 * 同源判据挡掉（`Sec-Fetch-Site: cross-site` → 403，`shared/admission.ts`）。两条路
 * 都不通，于是改走官方原生桥——它不过这两道，也不必带视图 token。
 *
 * 官方通道的请求超时（`maxRequestTime`）比壳侧命令表的 120s 还宽：运行时下载 +
 * 切换 + 重启 DSH 可能要好几分钟，官方到点只**放弃回包**、不取消壳侧任务（#97 同理），
 * 超时窄了会让用户看着「失败」而下载还在后台跑。
 *
 * 挂点与 `attachShellRpc` 同一个路子：handlers 纯逻辑可单测，electrobun 运行时只在
 * 真开窗时才动态载入。
 */
import {
  UPDATE_NOTICE_OP_METHOD,
  UPDATE_NOTICE_RESIZE_METHOD,
  UPDATE_NOTICE_CLOSE_METHOD,
  UPDATE_NOTICE_SHELL_STATUS_METHOD,
  updateNoticeOp,
  updateNoticeResizeHeight,
  type UpdateNoticeOp,
} from './update-notice-dialog.ts'
import { downloadPercent } from '../../shared/runtime/runtime-download-progress.ts'
import type { ShellUpdateStatus } from '../platform/shell-update-status.ts'

/** 只读的下载状态查询方法名（与壳命令表同名，页面按名字叫）。 */
export const UPDATE_NOTICE_STATUS_METHOD = 'runtime_download_status'

/** 官方通道的请求超时：够跑完一次「下载运行时 + 切换 + 重启服务」。 */
export const UPDATE_NOTICE_RPC_MAX_REQUEST_TIME = 30 * 60_000

export interface UpdateNoticeRpcDeps {
  /** 执行业务动作（服务面那侧；本模块只管通道与形状校验）。 */
  run: (op: UpdateNoticeOp) => Promise<unknown>
  /** 运行时下载器的当前状态（只读；壳算好百分比再递给页面）。 */
  downloadStatus: () => { active: boolean; version: string; resolved: number; downloaded: number }
  /**
   * #235：壳段更新状态（自管安装包下载器 + 自管 check 视图的合成，见
   * `platform/shell-update-status.ts`）。未接上时返回 null，页面按无状态画（不报错）。
   */
  shellUpdateStatus?: () => ShellUpdateStatus | null
  resize: (height: number) => void
  /** 请壳关掉本窗（#160）：页面自己关不了自己，只能让壳代劳。 */
  close: () => void

}

/** 关窗前给回包留的时间（#160）：够官方通道把响应发出去，再让窗消失。 */
export const UPDATE_NOTICE_CLOSE_DELAY_MS = 120

/** handlers 表（纯逻辑，可单测）：形状不认就不猜，直接 throw 让页面显示失败。 */
export function updateNoticeRpcRequests(deps: UpdateNoticeRpcDeps): {
  requests: Record<string, (params: unknown) => Promise<unknown>>
} {
  return {
    requests: {
      [UPDATE_NOTICE_OP_METHOD]: async (params: unknown) => {
        const op = updateNoticeOp(params)
        if (op === null) throw new Error('提醒卡动作不认这个负载')
        return deps.run(op)
      },
      // 只读查询：不认参数，直接把壳算好的 {active, version, percent} 递回去。
      [UPDATE_NOTICE_STATUS_METHOD]: async () => {
        const status = deps.downloadStatus()
        return { active: status.active, version: status.version, percent: downloadPercent(status) }
      },
      // 页面量完自己的内容高就叫一次：壳只动高度，位置与宽度保持（#130）。
      [UPDATE_NOTICE_RESIZE_METHOD]: async (params: unknown) => {
        const height = updateNoticeResizeHeight(params)
        if (height === null) throw new Error('窗高不认这个负载')
        deps.resize(height)
        return {}
      },
      // 关窗（#160）：页面点「稍后」与动作成功后的自动关窗都走这里。页面侧的 window.close()
      // 在 html: 文档里是空操作，所以关窗必须是壳的动作——与主窗 window_close 同口径。
      // 不收参数：谁来叫都一样，关的都是本窗（窗由壳按 profile 单例持有）。
      [UPDATE_NOTICE_CLOSE_METHOD]: async () => {
        // 回包先发、窗后关：直接在 handler 里同步 close() 会让这次请求的响应随窗一起消失。
        setTimeout(() => deps.close(), UPDATE_NOTICE_CLOSE_DELAY_MS)
        return {}
      },
      // #235：壳段状态（进度/失败红字/就绪转「安装更新」）。页面拿 null 就当无状态画。
      [UPDATE_NOTICE_SHELL_STATUS_METHOD]: async () => deps.shellUpdateStatus?.() ?? null,
    },
  }
}

/** 官方 defineRPC 挂点：返回的 rpc 实例原样喂给 `new BrowserWindow({ rpc })`。 */
export async function attachUpdateNoticeRpc(deps: UpdateNoticeRpcDeps): Promise<unknown> {
  const { BrowserView } = await import('electrobun/bun')
  return BrowserView.defineRPC({
    maxRequestTime: UPDATE_NOTICE_RPC_MAX_REQUEST_TIME,
    handlers: updateNoticeRpcRequests(deps),
  })
}
